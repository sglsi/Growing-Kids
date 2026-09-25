// ============================================================
// 用户上下文：解析"当前用户"，支持匿名（免注册）可读写
// 位置：server/src/shared/user-context.ts
// 依据：数据库重新设计-v4.md §B1/B6 + 用户确认（匿名可读写、1 天清理）
//
// 机制：
//  - 优先读请求头 X-User-Id（已注册/已登录用户）
//  - 其次读 X-Open-Id，映射到 users.open_id
//  - 都没有 → 创建一个匿名 user（is_anonymous=true, expire_at=now()+1天）
//  - 匿名 user 的 id 通过响应头 X-User-Id 回传，前端后续请求带上即可续用同一身份
//  - 例外：/auth/login 等免上下文路由不自动建匿名用户（避免每次登录都产生垃圾账号）
//
// ⚠️ service_role 绕过 RLS：所有业务查询必须显式 .eq('user_id', userId)
// ============================================================

import { Injectable, NestMiddleware } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'
import { UsersService } from '../users/users.service'
import type { User } from '../users/users.types'

const HEADER_USER_ID = 'x-user-id'
const HEADER_OPEN_ID = 'x-open-id'

/** 无需用户上下文的路由前缀（不自动创建匿名用户） */
const SKIP_ANONYMOUS_PREFIXES = ['/api/auth/', '/api/health']

export interface RequestWithUser extends Request {
  userId?: string
  isAnonymous?: boolean
}

@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  constructor(private readonly usersService: UsersService) {}

  async use(req: RequestWithUser, res: Response, next: NextFunction) {
    try {
      const headerUserId = this.asString(req.headers[HEADER_USER_ID])
      const headerOpenId = this.asString(req.headers[HEADER_OPEN_ID])

      let user: User | null = null
      if (headerUserId) {
        user = await this.usersService.findById(headerUserId)
      }
      if (!user && headerOpenId) {
        user = await this.usersService.findOrCreateByOpenId(headerOpenId)
      }
      if (!user && !this.shouldSkipAnonymous(req.originalUrl || req.url)) {
        user = await this.usersService.createAnonymous()
      }

      if (user) {
        req.userId = user.id
        req.isAnonymous = user.is_anonymous
        // 回传身份，匿名用户下次请求带上即可续用
        res.setHeader(HEADER_USER_ID, user.id)
      }
    } catch (e) {
      // 用户上下文失败不应直接 500，交给下游（下游会用 userId 校验并报错）
      req.userId = undefined
      console.error('[user-context] 解析用户失败', e)
    }
    next()
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
