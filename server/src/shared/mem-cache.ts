// ============================================================
// 读缓存（门面层）—— 后端读缓存 + 前缀失效
//
// ⚠️ 2026-10-27 起本模块**全部异步**，实现见 `cache-store.ts`
//    （`REDIS_URL` 未配置 = 进程内 Map；配置且装了 ioredis = Redis，多实例共享）。
//    函数名从 `memGet/memSet` 改为 `cacheGet/cacheSet` 是**故意的**：
//    async 化后若沿用旧名，漏写 await 会拿到一个 Promise（永远真值）而不报错，
//    是最难查的一种 bug；改名让所有调用点在编译期就暴露出来。
//
// 约束（不随后端变化）：
//  - 所有 key 必须带 userId（本项目隔离全靠代码层 `.eq('user_id')`，缓存同理）；
//  - 写操作后必须 `await invalidateUserTimeline(userId)`，否则最坏 30s 读到旧值；
//  - TTL 是**上限**，不是保证：缓存只是省 RTT，任何时候都必须能回源。
// ============================================================

import { cacheStore } from './cache-store'

/** 读缓存：不存在或已过期返回 null */
export function cacheGet<T>(key: string): Promise<T | null> {
  return cacheStore().get<T>(key)
}

/** 写缓存（默认 30s） */
export function cacheSet(key: string, data: unknown, ttlMs = 30_000): Promise<void> {
  return cacheStore().set(key, data, ttlMs)
}

/** 删单个 key */
export function cacheDel(key: string): Promise<void> {
  return cacheStore().del(key)
}

/** 按前缀批量删（如 cacheDelPrefix('tl:list:uid123:')） */
export function cacheDelPrefix(prefix: string): Promise<number> {
  return cacheStore().delPrefix(prefix)
}

/** 当前缓存条数（诊断用） */
export function cacheSize(): Promise<number> {
  return cacheStore().size()
}

// ------------------------------------------------------------
// timeline 域缓存 key 与失效（key 统一 tl: 前缀）
// ------------------------------------------------------------

/** list 查询参数稳定序列化（排序 + 过滤空值，保证同查询同 key） */
export function stableQuery(q: Record<string, unknown>): string {
  return Object.keys(q)
    .sort()
    .filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== '')
    .map((k) => `${k}=${JSON.stringify(q[k])}`)
    .join('&')
}

export const TL_LIST_PREFIX = 'tl:list:'
export const TL_ITEM_PREFIX = 'tl:item:'
export const TL_OV_KEY = 'tl:ov:'

/**
 * 失效某用户的 timeline 全部读缓存（列表 / 详情 / 概览）。
 * 所有写操作（create/createBatch/update/remove/removeMany/review/markReviewed）
 * 成功后都必须 await 它——这是缓存正确性的唯一保障。
 */
export async function invalidateUserTimeline(userId: string): Promise<void> {
  await cacheDelPrefix(`${TL_LIST_PREFIX}${userId}:`)
  await cacheDelPrefix(`${TL_ITEM_PREFIX}${userId}:`)
  await cacheDel(`${TL_OV_KEY}${userId}`)
}
