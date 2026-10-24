// ============================================================
// 用户上下文：解析"当前用户"，支持匿名（免注册）可读写
// 位置：server/src/shared/user-context.ts
// 依据：数据库重新设计-v4.md §B1/B6 + 用户确认（匿名可读写、1 天清理）
//
// 机制：
//  - 优先读请求头 X-User-Id（已注册/已登录用户；匿名 id 过期则视为失效）
//  - 其次读 X-Open-Id，映射到 users.open_id
//  - 其次读 X-Device-Id，按设备找/建匿名 user 并续期（「同一设备同一身份」）
//  - 都没有 → 创建一个匿名 user（is_anonymous=true, expire_at=now()+30天）
//  - 匿名 user 的 id 通过响应头 X-User-Id 回传，前端后续请求带上即可续用同一身份
//  - 例外：/auth/login 等免上下文路由不自动建匿名用户（避免每次登录都产生垃圾账号）
//
// ⚠️ service_role 绕过 RLS：所有业务查询必须显式 .eq('user_id', userId)
// ============================================================

import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'
import { memGet, memSet } from './mem-cache'

const HEADER_USER_ID = 'x-user-id'
const HEADER_OPEN_ID = 'x-open-id'
const HEADER_DEVICE_ID = 'x-device-id'

/**
 * 用户对象内存缓存 TTL（思傅 2026-10-21 性能优化）。
 *
 * 根因：本中间件对**每个请求**都做一次 users 表查询（Supabase 新加坡 RTT ~1.5s），
 * 这是「每次点开题目都要等」的后端侧主因——timeline 缓存省掉的是第二次查询，
 * 这第一次（用户校验）一直在付。
 * 下游只消费 id / is_anonymous / expire_at，一分钟内稳定，缓存无一致性风险；
 * 登录是新 user id（新 key），改资料不动这三个字段。只缓存非 null（避免把
 * 「刚登录建号前后的瞬间查空」缓存成 60s 幽灵）。
 */
const USER_CACHE_TTL = 60_000

/** 无需用户上下文的路由前缀（不自动创建匿名用户） */
const SKIP_ANONYMOUS_PREFIXES = ['/api/auth/', '/api/health']

export interface RequestWithUser extends Request {
  userId?: string
  isAnonymous?: boolean
  /** 请求头 X-Device-Id 原样透传（登录时用于绑定正式账号 + 迁移设备名下匿名号） */
  deviceId?: string
}

@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  constructor(private readonly usersService: UsersService) {}

  async use(req: RequestWithUser, res: Response, next: NextFunction) {
    try {
      const headerUserId = this.asString(req.headers[HEADER_USER_ID])
      const headerOpenId = this.asString(req.headers[HEADER_OPEN_ID])
      const headerDeviceId = this.asString(req.headers[HEADER_DEVICE_ID])

      let user: User | null = null
      if (headerUserId) {
        const cacheKey = `user:${headerUserId}`
        let found = memGet<User>(cacheKey)
        if (!found) {
          found = await this.usersService.findById(headerUserId)
          if (found) memSet(cacheKey, found, USER_CACHE_TTL)
        }
        // 匿名 id 过期（ maintenance 还没清）视为失效：继续按设备/匿名重建，
        // 否则前端带失效 id 会被静默当合法身份，数据全进新号、旧号成孤儿。
        if (found && !this.isExpiredAnonymous(found)) user = found
      }
      if (!user && headerOpenId) {
        user = await this.usersService.findOrCreateByOpenId(headerOpenId)
      }
      if (!user && headerDeviceId) {
        user = await this.usersService.findOrCreateByDeviceId(headerDeviceId)
      }
      if (!user && !this.shouldSkipAnonymous(req.originalUrl || req.url)) {
        user = await this.usersService.createAnonymous()
      }

      if (user) {
        req.userId = user.id
        req.isAnonymous = user.is_anonymous
        req.deviceId = headerDeviceId
        // 回传身份，匿名用户下次请求带上即可续用
        res.setHeader(HEADER_USER_ID, user.id)
      } else {
        req.deviceId = headerDeviceId
      }
    } catch (e) {
      // 用户上下文失败不应直接 500，交给下游（下游会用 userId 校验并报错）
      req.userId = undefined
      console.error('[user-context] 解析用户失败', e)
    }
    next()
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
 * 全局能力（客服知识库等**全局表**的写操作）的管理员校验。
 *
 * 背景：knowledge_articles 没有 user_id 列、对所有用户生效，其内容直接拼进
 * system prompt。此前四个 CRUD 端点无任何身份校验 ⇒ 任意请求可操纵所有
 * 用户的助手人设（prompt 注入面）。
 *
 * 现状与边界（2026-10-24，思傅的开发/体验版阶段）：
 *  - 配置 `CHAT_ADMIN_IDS`（逗号分隔 user id，放 `.env.secrets`）后，仅白名单可写；
 *  - **未配置时保持放行**（不影响思傅当前的知识库管理页），但每次请求都打 warn；
 *  - 彻底方案是给 users 加 role 列并做管理员体系，已登记 GK-OPS-18。
 */
export function requireAdmin(req: RequestWithUser): string {
  const userId = requireUserId(req)
  const allow = (process.env.CHAT_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!allow.length) {
    console.warn('[requireAdmin] CHAT_ADMIN_IDS 未配置，全局写操作暂时放行；请在 .env.secrets 配置白名单收紧')
    return userId
  }
  if (!allow.includes(userId)) {
    throw new ForbiddenException('无权限：仅管理员可维护全局知识库')
  }
  return userId
}
