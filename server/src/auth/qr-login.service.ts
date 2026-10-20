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

/**
 * H5 扫码登录（思傅 2026-10-20 拍板方案）：
 * 电脑浏览器没有 wx.login，改为「H5 出二维码 → 手机微信扫码授权」。
 *
 * 流程：
 *  1. H5 未登录 → POST /auth/qr-login/ticket 创建票据 → 用票据拼落地 URL 画二维码
 *  2. 手机微信扫码 → 微信内置浏览器打开落地页 → wx.login → POST /auth/qr-login/authorize
 *  3. H5 每 1.5s 轮询 GET /auth/qr-login/status → authorized 时取 user 落本地身份
 *
 * 与小程序登录共用 code2Session + findOrCreateByOpenId：
 * 同一微信号无论从手机小程序还是电脑 H5 登录，都汇聚到同一 openid 账号。
 */
@Injectable()
export class QrLoginService implements OnModuleDestroy {
  private readonly logger = new Logger(QrLoginService.name)
  /**
   * 单实例内存票据仓。云端为单机部署（含 OCR 侧车），够用；
   * 重启即失效（用户重扫即可），无持久化依赖、零 DDL。
   * ⚠️ 若未来上多副本部署，改用 login_tickets 表——
   *    migrations/0012_login_tickets.sql 已按此场景备好（含索引与过期清理列）。
   */
  private readonly tickets = new Map<string, QrTicket>()
  private sweepTimer?: NodeJS.Timeout

  constructor(private readonly usersService: UsersService) {
    // 每分钟清扫过期票据，防内存泄漏
    this.sweepTimer = setInterval(() => this.sweep(), 60_000)
    this.sweepTimer.unref?.()
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  /** 创建票据（H5 端调用，无需身份） */
  createTicket(): { token: string; expires_in: number } {
    this.sweep()
    const token = randomBytes(24).toString('base64url')
    const now = Date.now()
    this.tickets.set(token, { token, status: 'pending', createdAt: now, expiresAt: now + TICKET_TTL_MS })
    return { token, expires_in: TICKET_TTL_MS / 1000 }
  }

  /** 查询票据状态（H5 轮询）；authorized 时附带 user 供落身份 */
  async getStatus(token: string): Promise<{ status: QrTicketStatus; user?: User }> {
    const t = this.tickets.get(token)
    if (!t) return { status: 'expired' }
    if (t.status === 'pending' && Date.now() > t.expiresAt) {
      t.status = 'expired'
    }
    if (t.status === 'authorized' && t.userId) {
      const user = await this.usersService.findById(t.userId)
      if (user) return { status: 'authorized', user }
    }
    return { status: t.status }
  }

  /**
   * 手机端授权（扫码落地页调用）。
   * @param token       票据
   * @param code        wx.login() 临时凭证
   * @param anonymousId H5 端当前匿名身份（可选）——授权成功即把它的数据迁到正式账号
   */
  async authorize(
    token: string,
    code: string,
    anonymousId?: string,
  ): Promise<{ user: User; migrated: { subjects: number; timeline_items: number; library_docs: number; documents: number } }> {
    const t = this.tickets.get(token)
    if (!t || t.status === 'expired') {
      throw new BadRequestException('二维码已过期，请在电脑上刷新后重新扫码')
    }
    if (t.status === 'authorized') {
      throw new BadRequestException('该二维码已登录，请刷新二维码重试')
    }
    if (!code) throw new BadRequestException('code 不能为空')

    const session = await code2Session(code)
    if (!session.openid) {
      throw new BadRequestException(`微信登录失败：${session.errmsg || '未返回 openid'}`)
    }

    const user = await this.usersService.findOrCreateByOpenId(session.openid)

    // 匿名数据迁移：把 H5 端（电脑浏览器）匿名身份的数据改挂到正式账号
    const migrated = await this.migrateAnonymous(user.id, anonymousId)

    t.status = 'authorized'
    t.userId = user.id
    this.logger.log(`[qr-login] 授权成功 userId=${user.id} 迁移=${JSON.stringify(migrated)}`)
    return { user, migrated }
  }

  /** 与 AuthService.migrateAnonymousData 同策略：update user_id 后删匿名壳 */
  private async migrateAnonymous(
    targetUserId: string,
    anonymousId?: string,
  ): Promise<{ subjects: number; timeline_items: number; library_docs: number; documents: number }> {
    const empty = { subjects: 0, timeline_items: 0, library_docs: 0, documents: 0 }
    if (!anonymousId || anonymousId === targetUserId) return empty

    const anon = await this.usersService.findById(anonymousId)
    if (!anon || !anon.is_anonymous) return empty

    const client = getSupabaseClient()
    const migrated = { ...empty }
    for (const table of ['subjects', 'timeline_items', 'library_docs', 'documents'] as const) {
      const { data, error } = await client
        .from(table)
        .update({ user_id: targetUserId })
        .eq('user_id', anonymousId)
        .select('id')
      if (error) {
        this.logger.error(`[qr-login] 迁移 ${table} 失败`, error.message)
        continue
      }
      migrated[table] = (data || []).length
    }
    await this.usersService.removeByIds([anonymousId])
    return migrated
  }

  /** 懒清理 + 定时清扫：过期的票直接删（status 查询对不存在票据一律返回 expired） */
  private sweep() {
    const now = Date.now()
    for (const [k, t] of this.tickets) {
      if (now > t.expiresAt) this.tickets.delete(k)
    }
  }
}
