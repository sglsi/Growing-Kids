// ============================================================
// 全局速率限制（内存滑动窗口，零新增依赖）。
//
// 背景（代码审查 P1）：此前全站无任何节流，登录 / 匿名建号 / 图片处理 / 上传等
// 端点可被无限制调用 —— 既可被用来批量建匿名号、放大 SSRF，也能造成资源耗尽。
//
// 设计：
//  - 按「用户 id（已登录/匿名）或客户端 IP」维度，限制 WINDOW_MS 内最多 LIMIT 次请求。
//  - 放行 `/api/health`（健康拨测不能 429，否则巡检误判后端挂掉）。
//  - 内存实现：单实例部署足够；水平扩展时需换 Redis（与现有 mem-cache 同一前提）。
//  - 可调：env `THROTTLE_LIMIT`（默认 300）/ `THROTTLE_WINDOW_MS`（默认 60000）。
//  - 主动淘汰过期桶，避免 Map 无限增长。
// ============================================================

import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common'

const LIMIT = Number(process.env.THROTTLE_LIMIT ?? 300)
const WINDOW_MS = Number(process.env.THROTTLE_WINDOW_MS ?? 60_000)
const MAX_BUCKETS = 10_000

interface Bucket {
  count: number
  resetAt: number
}

const store = new Map<string, Bucket>()

function prune(now: number): void {
  if (store.size > MAX_BUCKETS) {
    store.clear()
    return
  }
  for (const [k, b] of store) {
    if (b.resetAt <= now) store.delete(k)
  }
}

@Injectable()
export class ThrottleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ originalUrl?: string; url?: string; userId?: string; ip?: string }>()
    const url = (req.originalUrl || req.url || '').split('?')[0]
    // 健康拨测放行
    if (/^\/api\/health(\/|$)/.test(url)) return true

    const now = Date.now()
    prune(now)

    const id = req.userId || req.ip || 'anon'
    const key = `thr:${id}`
    let b = store.get(key)
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + WINDOW_MS }
      store.set(key, b)
    }
    b.count += 1
    if (b.count > LIMIT) {
      throw new HttpException(
        { code: 429, msg: '请求过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    return true
  }
}
