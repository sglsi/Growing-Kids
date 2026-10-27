import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import { code2Session } from './wechat-session'
import type { User } from '../users/users.types'

export type QrTicketStatus = 'pending' | 'authorized' | 'expired'

interface QrTicket {
  token: string
  status: QrTicketStatus
  /** 授权成功后的正式 user id（H5 轮询到 authorized 时取用） */
  userId?: string
  createdAt: number
  expiresAt: number
}

/** 票据有效期：5 分钟（与微信 code 有效期对齐，超时重扫即可） */
const TICKET_TTL_MS = 5 * 60 * 1000
const TABLE = 'login_tickets'

/**
 * 票据存储后端（OPS-18 `R-技术-10` 第 2 项：解除单机假设）。
 *
 * `QR_TICKET_STORE`：
 *   - `auto`（默认）：优先落 `login_tickets` 表，表不可用（未跑 0012 / 网络异常）
 *     自动降级为进程内存并 **只告警一次**；
 *   - `db`：强制落库，失败即报错（多副本部署必须用这个，避免「一半实例查不到票」）；
 *   - `memory`：强制内存（本地开发想省一次 DB 往返时用）。
 *
 * 为什么必须落库：票据存在进程内存时，**只要有两个实例，/authorize 打到 A、
 * /status 轮询打到 B 就查不到票** —— 表现为「扫了没反应」，且日志里两端都正常，
 * 极难排查。这属于「能跑但一扩容就坏」的隐性单机依赖。
 */
type StoreMode = 'db' | 'memory'

@Injectable()
export class QrLoginService implements OnModuleDestroy {
  private readonly logger = new Logger(QrLoginService.name)
  /** 内存兜底仓（仅 `memory` 模式或 db 不可用时使用） */
  private readonly tickets = new Map<string, QrTicket>()
  private sweepTimer?: NodeJS.Timeout
  /** 解析后的存储后端（首次访问时确定） */
  private resolvedStore: StoreMode | null = null
  /** db 不可用的原因（诊断端点/日志用） */
  private dbUnavailableReason = ''

  constructor(private readonly usersService: UsersService) {
    // 每分钟清扫过期票据（内存 + DB 两侧）
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000)
    this.sweepTimer.unref?.()
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  /** 当前存储后端（诊断用） */
  storeMode(): { store: StoreMode; reason: string } {
    return { store: this.resolvedStore || this.preferredStore(), reason: this.dbUnavailableReason }
  }

  private preferredStore(): StoreMode {
    const raw = String(process.env.QR_TICKET_STORE || '').toLowerCase()
    if (raw === 'memory') return 'memory'
    return 'db'
  }

  /**
   * 首次访问时确定后端。`auto`（默认）在 db 报「表不存在」时降级一次，
   * 之后一直记着，不再每次打 DB。
   */
  private async store(): Promise<StoreMode> {
    if (this.resolvedStore) return this.resolvedStore
    const preferred = this.preferredStore()
    if (preferred === 'memory') {
      this.resolvedStore = 'memory'
      return 'memory'
    }
    // db 模式：探一次（createTicket 里会真正写，失败再降级）
    this.resolvedStore = 'db'
    return 'db'
  }

  /** DB 写失败 → 降级内存（只告警一次），让扫码登录不至于整体不可用 */
  private degradeToMemory(e: unknown, op: string) {
    const forced = String(process.env.QR_TICKET_STORE || '').toLowerCase() === 'db'
    const msg = (e as Error)?.message || String(e)
    this.dbUnavailableReason = msg
    if (forced) {
      // 多副本部署强制 db：不能偷偷降级，否则会出现「两个实例票据不互通」的幽灵 bug
      throw new Error(`扫码票据落库失败（QR_TICKET_STORE=db 强制落库）：${msg}`)
    }
    if (this.resolvedStore !== 'memory') {
      this.logger.warn(
        `[qr-login] ${TABLE} 不可用（${op}），已降级为进程内票据；单机无影响，多副本部署必须修好它：${msg}`,
      )
      this.resolvedStore = 'memory'
    }
  }

  /** 创建票据（H5 端调用，无需身份） */
  async createTicket(): Promise<{ token: string; expires_in: number }> {
    await this.sweep()
    // ⚠️ 必须是 base64url：票据要拼进二维码落地 URL 的 query。
    // 历史 bug：这里曾写成无效编码名，Node 的 Buffer.toString 对未知编码**不报错**
    // 而是回落 utf8 ⇒ token 里可能出现 & # + 空格甚至 U+FFFD，落地页 query 被截断，
    // 表现为「扫了打不开/授权后 H5 一直 pending」。
    const token = randomBytes(24).toString('base64url')
    const now = Date.now()
    const expiresAt = new Date(now + TICKET_TTL_MS)

    if ((await this.store()) === 'db') {
      try {
        const client = getSupabaseClient()
        const { error } = await client.from(TABLE).insert({
          token,
          status: 'pending',
          created_at: new Date(now).toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        if (error) throw new Error(error.message)
        return { token, expires_in: TICKET_TTL_MS / 1000 }
      } catch (e) {
        this.degradeToMemory(e, 'insert')
      }
    }

    this.tickets.set(token, { token, status: 'pending', createdAt: now, expiresAt: now + TICKET_TTL_MS })
    return { token, expires_in: TICKET_TTL_MS / 1000 }
  }

  /** 查询票据状态（H5 轮询）；authorized 时附带 user 供落身份 */
  async getStatus(token: string): Promise<{ status: QrTicketStatus; user?: User }> {
    if (!token) return { status: 'expired' }

    if ((await this.store()) === 'db') {
      try {
        const client = getSupabaseClient()
        const { data, error } = await client
          .from(TABLE)
          .select('status, user_id, expires_at')
          .eq('token', token)
          .maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { status: 'expired' }
        const row = data as { status: string; user_id: string | null; expires_at: string }
        let status = row.status as QrTicketStatus
        if (status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) status = 'expired'
        if (status === 'authorized' && row.user_id) {
          const user = await this.usersService.findById(row.user_id)
          if (user) return { status: 'authorized', user }
          // 账号被清理：按过期处理，避免 H5 永远等一个不存在的身份
          return { status: 'expired' }
        }
        return { status }
      } catch (e) {
        this.degradeToMemory(e, 'select')
      }
    }

    const t = this.tickets.get(token)
    if (!t) return { status: 'expired' }
    if (t.status === 'pending' && Date.now() > t.expiresAt) t.status = 'expired'
    if (t.status === 'authorized' && t.userId) {
      const user = await this.usersService.findById(t.userId)
      if (user) return { status: 'authorized', user }
      return { status: 'expired' }
    }
    return { status: t.status }
  }

  /**
   * 手机端授权（扫码落地页调用）。
   * @param token       票据
   * @param code        wx.login() 临时凭证
   * @param anonymousId H5 端当前匿名身份（可选）——授权成功即把它的数据迁到正式账号
   * @param deviceId    手机端设备标识（X-Device-Id，可选）——① 授权手机的
   *                    微信账号绑定该设备（丢 gk_user_id 也能找回）；② 该设备
   *                    名下历史遗留匿名号一并迁移
   */
  async authorize(
    token: string,
    code: string,
    anonymousId?: string,
    deviceId?: string,
  ): Promise<{ user: User; migrated: { subjects: number; timeline_items: number; library_docs: number; documents: number } }> {
    if (!code) throw new BadRequestException('code 不能为空')

    // 先占用票据（pending → authorized 的互斥在下面按后端分别保证）
    const current = await this.getStatus(token)
    if (current.status === 'expired') {
      throw new BadRequestException('二维码已过期，请在电脑上刷新后重新扫码')
    }
    if (current.status === 'authorized') {
      throw new BadRequestException('该二维码已登录，请刷新二维码重试')
    }

    const session = await code2Session(code)
    if (!session.openid) {
      throw new BadRequestException(`微信登录失败：${session.errmsg || '未返回 openid'}`)
    }

    const user = await this.usersService.findOrCreateByOpenId(session.openid, deviceId)

    // 匿名数据迁移：把 H5 端（电脑浏览器）匿名身份 + 授权手机设备名下
    // 历史遗留匿名号的数据，一并改挂到正式账号
    const migrated = await this.migrateAnonymous(user.id, anonymousId, deviceId)

    if ((await this.store()) === 'db') {
      try {
        const client = getSupabaseClient()
        // 只允许 pending → authorized（条件更新做互斥：并发扫码时后者影响 0 行）
        const { data, error } = await client
          .from(TABLE)
          .update({ status: 'authorized', user_id: user.id })
          .eq('token', token)
          .eq('status', 'pending')
          .select('token')
        if (error) throw new Error(error.message)
        if (!data?.length) throw new BadRequestException('该二维码已登录，请刷新二维码重试')
        this.logger.log(`[qr-login] 授权成功(store=db) userId=${user.id} 迁移=${JSON.stringify(migrated)}`)
        return { user, migrated }
      } catch (e) {
        if (e instanceof BadRequestException) throw e
        this.degradeToMemory(e, 'update')
      }
    }

    const t = this.tickets.get(token)
    if (!t || t.status !== 'pending') {
      throw new BadRequestException('该二维码已登录，请刷新二维码重试')
    }
    t.status = 'authorized'
    t.userId = user.id
    this.logger.log(`[qr-login] 授权成功(store=memory) userId=${user.id} 迁移=${JSON.stringify(migrated)}`)
    return { user, migrated }
  }

  /** 与 AuthService.migrateAnonymousData 同策略：update user_id 后删匿名壳 */
  private async migrateAnonymous(
    targetUserId: string,
    anonymousId?: string,
    deviceId?: string,
  ): Promise<{ subjects: number; timeline_items: number; library_docs: number; documents: number }> {
    const empty = { subjects: 0, timeline_items: 0, library_docs: 0, documents: 0 }

    const anonIds = new Set<string>()
    if (anonymousId) anonIds.add(anonymousId)
    if (deviceId) {
      try {
        const devAnons = await this.usersService.listAnonymousByDeviceId(deviceId)
        for (const u of devAnons) anonIds.add(u.id)
      } catch (e) {
        this.logger.warn(`[qr-login] 查设备匿名号失败（不影响主迁移）: ${(e as Error).message}`)
      }
    }
    anonIds.delete(targetUserId)
    if (!anonIds.size) return empty

    const client = getSupabaseClient()
    const migrated = { ...empty }
    for (const anonId of anonIds) {
      const anon = await this.usersService.findById(anonId)
      if (!anon || !anon.is_anonymous) continue
      for (const table of ['subjects', 'timeline_items', 'library_docs', 'documents'] as const) {
        const { data, error } = await client
          .from(table)
          .update({ user_id: targetUserId })
          .eq('user_id', anonId)
          .select('id')
        if (error) {
          this.logger.error(`[qr-login] 迁移 ${table}（${anonId}）失败`, error.message)
          continue
        }
        migrated[table] += (data || []).length
      }
    }
    await this.usersService.removeByIds([...anonIds])
    return migrated
  }

  /**
   * 清扫过期票据：内存侧直接删，DB 侧删过期的行。
   * 定时任务 + 每次 createTicket 前各跑一次（懒清理），避免依赖定期任务是否活着。
   */
  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const [k, t] of this.tickets) {
      if (now > t.expiresAt) this.tickets.delete(k)
    }
    if ((await this.store()) !== 'db') return
    try {
      const client = getSupabaseClient()
      const { error } = await client
        .from(TABLE)
        .delete()
        .lt('expires_at', new Date(now).toISOString())
        .select('token')
      if (error) this.logger.warn(`[qr-login] 清理过期票据失败: ${error.message}`)
    } catch (e) {
      this.logger.warn(`[qr-login] 清理过期票据异常: ${(e as Error).message}`)
    }
  }
}
