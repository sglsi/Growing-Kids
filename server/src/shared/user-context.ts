// ============================================================
// 用户上下文：解析"当前用户"，支持匿名（免注册）可读写
// 位置：server/src/shared/user-context.ts
//
// 身份来源（2026-10-27 严格令牌化后）：
//  1) `X-Auth-Token` —— 服务端 HMAC 签发的身份令牌，**唯一被采信的业务身份来源**
//  2) 引导路由（`/api/auth/*`、`/api/health`）额外允许 `X-Open-Id`（登录）
//     与 `X-Device-Id`（设备找回匿名身份）——只在没令牌时用于「换一张令牌」
//  3) 裸 `X-User-Id` —— **严格模式下完全不采信**（可伪造，见 OPS-18 R-技术-09）
//
// 严格模式开关：配置了 `AUTH_TOKEN_SECRET` 即启用；`AUTH_STRICT_TOKEN=false` 可临时回退。
// 回退只用于「前端还没发版」的窗口期，长期必须保持严格模式。
//
// ⚠️ service_role 绕过 RLS：所有业务查询必须显式 .eq('user_id', userId)
// ============================================================

import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import { memGet, memSet } from './mem-cache'
import { authTokenEnabled, readAuthHeader, signAuthToken, verifyAuthToken } from './auth-token'

const HEADER_USER_ID = 'x-user-id'
const HEADER_OPEN_ID = 'x-open-id'
const HEADER_DEVICE_ID = 'x-device-id'
/** 身份令牌回传头（服务端签发，前端后续请求带上） */
const HEADER_TOKEN = 'x-auth-token'

/**
 * 用户对象内存缓存 TTL（思傅 2026-10-21 性能优化）。
 *
 * 根因：本中间件对**每个请求**都做一次 users 表查询（Supabase 新加坡 RTT ~1.5s），
 * 这是「每次点开题目都要等」的后端侧主因。下游只消费 id / is_anonymous /
 * expire_at / role，一分钟内稳定，缓存无一致性风险。
 * 代价：改 role 后最多 60s 生效（提权脚本会提示）。
 */
const USER_CACHE_TTL = 60_000

/** 无需用户上下文的路由前缀（不自动创建匿名用户） */
const SKIP_ANONYMOUS_PREFIXES = ['/api/auth/', '/api/health']

/**
 * 引导路由：这些路由允许无令牌访问，用于「换取第一张令牌」。
 * 严格模式下它们是唯一的身份入口，业务路由一律要求令牌。
 */
const BOOTSTRAP_PREFIXES = ['/api/auth/', '/api/health']

export interface RequestWithUser extends Request {
  userId?: string
  isAnonymous?: boolean
  /** 角色：仅 `admin` 可写全局表（0017 起从 users.role 读取） */
  userRole?: 'user' | 'admin'
  /** 请求头 X-Device-Id 原样透传（登录时用于绑定正式账号 + 迁移设备名下匿名号） */
  deviceId?: string
}

/**
 * 严格令牌模式：配了密钥就默认严格；`AUTH_STRICT_TOKEN=false` 可临时回退到
 * 「裸 X-User-Id 也认」的旧行为（仅供前端未发版时的过渡窗口使用）。
 */
export function strictTokenEnabled(): boolean {
  if (String(process.env.AUTH_STRICT_TOKEN || '').toLowerCase() === 'false') return false
  return authTokenEnabled()
}

@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  constructor(private readonly usersService: UsersService) {}

  async use(req: RequestWithUser, res: Response, next: NextFunction) {
    try {
      const url = req.originalUrl || req.url || ''
      const headerUserId = this.asString(req.headers[HEADER_USER_ID])
      const headerOpenId = this.asString(req.headers[HEADER_OPEN_ID])
      const headerDeviceId = this.asString(req.headers[HEADER_DEVICE_ID])
      const headerToken = readAuthHeader(req.headers as Record<string, unknown>)

      const strict = strictTokenEnabled()
      const bootstrap = BOOTSTRAP_PREFIXES.some((p) => url.startsWith(p))
      let user: User | null = null

      // ---------- 1) 令牌：唯一被采信的业务身份 ----------
      if (headerToken && authTokenEnabled()) {
        const tokenUserId = verifyAuthToken(headerToken)
        if (tokenUserId) {
          user = await this.loadUser(tokenUserId)
          if (!user) console.warn('[user-context] 令牌有效但用户不存在/已被清理', tokenUserId)
        } else if (strict) {
          // ⚠️ 严格模式绝不回退：验签失败就是失效，否则「带个烂令牌」等于绕过验签
          return this.reject(res, 'TOKEN_INVALID', '登录状态已失效，请重新进入小程序')
        } else {
          console.warn('[user-context] X-Auth-Token 验签失败（过期或篡改），已忽略')
        }
      }

      // ---------- 2) 引导路由：允许用 device / openid 换令牌 ----------
      if (!user && bootstrap) {
        if (headerOpenId) {
          user = await this.usersService.findOrCreateByOpenId(headerOpenId)
        } else if (headerDeviceId) {
          user = await this.usersService.findOrCreateByDeviceId(headerDeviceId)
        }
      }

      // ---------- 3) 裸 X-User-Id：严格模式直接不认 ----------
      if (!user && headerUserId) {
        if (strict) {
          console.warn(
            '[user-context] 拒绝未签名的 X-User-Id（严格令牌模式已开启）；前端必须改带 X-Auth-Token',
            headerUserId,
          )
        } else {
          user = await this.loadUser(headerUserId)
        }
      }

      // ---------- 4) 过渡模式（AUTH_STRICT_TOKEN=false / 未配密钥）----------
      if (!user && !strict) {
        if (headerOpenId) user = await this.usersService.findOrCreateByOpenId(headerOpenId)
        if (!user && headerDeviceId) user = await this.usersService.findOrCreateByDeviceId(headerDeviceId)
        if (!user && !this.shouldSkipAnonymous(url)) user = await this.usersService.createAnonymous()
      }

      if (!user) {
        // 严格模式且引导路由也没换成身份：业务请求一律 401，前端拿 401 去走引导换令牌
        if (strict) return this.reject(res, 'NEED_AUTH_TOKEN', '缺少身份令牌，请重新进入小程序')
        req.deviceId = headerDeviceId
        return next()
      }

      req.userId = user.id
      req.isAnonymous = user.is_anonymous
      req.deviceId = headerDeviceId
      req.userRole = await this.resolveRole(user)

      // 回传身份（旧版前端仍读 X-User-Id，保留不伤安全：真正的信任来自令牌）
      res.setHeader(HEADER_USER_ID, user.id)
      // 滑动续签：每次响应都带回新令牌，前端覆盖本地（30 天不过期）
      if (authTokenEnabled()) {
        const token = signAuthToken(user.id)
        if (token) res.setHeader(HEADER_TOKEN, token)
      }
    } catch (e) {
      // 用户上下文失败不应直接 500，交给下游（下游会用 userId 校验并报错）
      req.userId = undefined
      console.error('[user-context] 解析用户失败', e)
    }
    next()
  }

  /** 读用户（内存缓存 60s） */
  private async loadUser(id: string): Promise<User | null> {
    const key = `user:${id}`
    let found = memGet<User>(key)
    if (!found) {
      found = await this.usersService.findById(id)
      if (found) memSet(key, found, USER_CACHE_TTL)
    }
    if (found && this.isExpiredAnonymous(found)) {
      console.warn('[user-context] 匿名身份已过期（等待维护任务清理）', id)
      return null
    }
    return found
  }

  /**
   * 解析角色。
   * `users` 的常规 select 不含 role（避免未跑 0017 的环境整条查询失败），
   * 故这里单独取一次并缓存 60s；提权后最多 60s 生效。
   */
  private async resolveRole(u: User): Promise<'user' | 'admin'> {
    if (u.role === 'admin') return 'admin'
    if (u.role === 'user') return 'user'
    const key = `role:${u.id}`
    const cached = memGet<'user' | 'admin'>(key)
    if (cached) return cached
    const role = await this.usersService.findRole(u.id)
    memSet(key, role, USER_CACHE_TTL)
    return role
  }

  /** 直接回写 401（中间件抛异常会绕开过滤器，这里自己收口，响应体与全局信封一致） */
  private reject(res: Response, reason: string, msg: string) {
    res.status(401).json({ code: 401, msg, data: { reason } })
  }

  /** 匿名且已过期 → 视为失效身份 */
  private isExpiredAnonymous(u: User): boolean {
    return !!u.is_anonymous && !!u.expire_at && new Date(u.expire_at).getTime() < Date.now()
  }

  private shouldSkipAnonymous(url: string): boolean {
    return SKIP_ANONYMOUS_PREFIXES.some((p) => url.startsWith(p))
  }

  private asString(v: unknown): string | undefined {
    if (Array.isArray(v)) return v[0]
    if (typeof v === 'string' && v.trim()) return v.trim()
    return undefined
  }
}

/** 从请求中取当前用户 id；缺失则抛错（说明中间件未生效） */
export function requireUserId(req: RequestWithUser): string {
  const id = req?.userId
  if (!id) {
    throw new Error('当前用户上下文缺失（UserContextMiddleware 未生效）')
  }
  return id
}

/**
 * 全局能力（`knowledge_articles` 等**全局表**的写操作）的管理员校验。
 *
 * 背景：`knowledge_articles` 没有 user_id 列、对所有用户生效，其内容直接拼进
 * system prompt。此前四个 CRUD 端点无任何身份校验 ⇒ 任意请求可操纵所有
 * 用户的助手人设（prompt 注入面）。
 *
 * 演进（OPS-18 `R-技术-08`）：
 *  - v1：env 白名单 `CHAT_ADMIN_IDS`。硬伤是**未配置时直接放行**（只 warn），
 *    部署漏配 = 门禁失效。
 *  - v2（2026-10-27，当前）：管理员身份落库 `users.role = 'admin'`，
 *    门禁改为 **fail-closed**——不是 admin 就拒绝，白名单降级为迁移期兼容。
 *
 * ⚠️ 不要为了「让某个账号能用」把这里改回放行：提权走
 * `node server/scripts/promote-admin.mjs`。角色变更 ≤60s 生效（用户缓存）。
 */
export async function requireAdmin(req: RequestWithUser): Promise<string> {
  const userId = requireUserId(req)
  if (req.userRole === 'admin') return userId

  // 迁移期兼容：仍配着 CHAT_ADMIN_IDS 就不突然锁死人，但每次都催迁移
  const allow = (process.env.CHAT_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allow.includes(userId)) {
    console.warn(
      '[requireAdmin] 该账号仍靠 CHAT_ADMIN_IDS 白名单放行，请迁移到 users.role=admin',
      userId,
    )
    return userId
  }

  throw new ForbiddenException('无权限：仅管理员可维护全局知识库')
}
