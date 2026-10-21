// ============================================================
// 进程内内存缓存（TTL + 前缀失效）
// 思傅 2026-10-21 决策：后端一起做读缓存（前端已有 SWR 本地缓存，双管齐下）
//
// 用途：给高频读接口（timeline list/findOne/overview）加 30s 缓存，
//      多页面/多端重复请求同一数据时不再打 Supabase（新加坡 RTT）。
//
// 约束：
//  - 单进程部署（本地 3001 / 云托管单容器）⇒ Map 足够，不引 Redis；
//  - 所有 key 必须带 userId（本项目 RLS 全靠代码层隔离，缓存同理）；
//  - 写操作后必须调 invalidateUserTimeline(userId) 等前缀失效，
//    否则 30s 内读到旧数据；
//  - 定时清理过期项防内存膨胀（unref 不阻进程退出）。
// ============================================================

interface Entry {
  data: unknown
  exp: number
}

const store = new Map<string, Entry>()

/** 读缓存：不存在或已过期返回 null（过期项顺手删） */
export function memGet<T>(key: string): T | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.exp < Date.now()) {
    store.delete(key)
    return null
  }
  return hit.data as T
}

/** 写缓存（默认 30s） */
export function memSet(key: string, data: unknown, ttlMs = 30_000): void {
  store.set(key, { data, exp: Date.now() + ttlMs })
}

/** 删单个 key */
export function memDel(key: string): void {
  store.delete(key)
}

/** 按前缀批量删（如 memDelPrefix('tl:list:uid123:')） */
export function memDelPrefix(prefix: string): void {
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k)
  }
}

/** 当前缓存条数（诊断/测试用） */
export function memSize(): number {
  return store.size
}

/** 定时清理过期项（每分钟；unref 不阻止进程退出） */
const timer = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of store) {
    if (v.exp < now) store.delete(k)
  }
}, 60_000)
if (typeof timer === 'object' && timer && 'unref' in timer) {
  ;(timer as { unref: () => void }).unref()
}

// ------------------------------------------------------------
// timeline 域缓存 key 与失效（本模块只服务 timeline，key 统一 tl: 前缀）
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
 * 成功后都必须调用——这是缓存正确性的唯一保障。
 */
export function invalidateUserTimeline(userId: string): void {
  memDelPrefix(`${TL_LIST_PREFIX}${userId}:`)
  memDelPrefix(`${TL_ITEM_PREFIX}${userId}:`)
  memDel(`${TL_OV_KEY}${userId}`)
}
