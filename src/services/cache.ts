// ============================================================
// 本地读缓存（SWR：Stale-While-Revalidate）
// 思傅 2026-10-21 决策：全量读接口 + SWR 后台刷新 + 后端内存缓存
//
// 机制（对应「没有触发数据库操作时只读缓存」）：
//  1. 读页面进入时先用 cacheGet **同步**拿缓存渲染首帧（0 网络等待）；
//  2. 同时后台发真实请求，返回后 setState + cacheSet 回写（静默更新，不打断操作）；
//  3. 写操作成功后由 api.ts 收口按域失效（invalidateDomain）⇒ 下次打开即新数据；
//  4. TTL 兜底 + 登出/切号 clearAllCache。
//
// 两个已验证前提（2026-10-21 调研）：
//  - 图片 URL 走后端 withUrls → getPublicUrl（公开桶、**永久有效**，非签名 URL），
//    不存在「缓存存久了图片裂」；
//  - 后端 list/findOne 本身只是单次 Supabase 查询，前端缓存即可消除主要等待。
//
// 容量：小程序 Storage 上限 10MB。列表域只缓存各页面当前查询；
// 详情域（tl:item:/mem:item:）LRU 上限 30 条，超出自动清最旧。
// ============================================================
import Taro from '@tarojs/taro'
import { getUserId } from '@/services/net'

const NS = 'gkc'

const TTL_LIST = 5 * 60 * 1000      // 列表 / 概览：5 分钟
const TTL_ITEM = 10 * 60 * 1000     // 详情：10 分钟
const TTL_SUBJECT = 30 * 60 * 1000  // 学科：30 分钟（极少变）
const ITEM_LRU_MAX = 30             // 详情缓存条数上限（LRU）

interface Envelope {
  ts: number
  data: unknown
}

/** 缓存 key 带 userId：切换账号不串数据；未登录（匿名 id 未回传）时归到 anon 桶 */
function nsKey(key: string): string {
  return `${NS}:${getUserId() || 'anon'}:${key}`
}

/** 按 key 前缀定 TTL */
function ttlOf(key: string): number {
  if (key.startsWith('tl:item:') || key.startsWith('mem:item:')) return TTL_ITEM
  if (key.startsWith('subj:')) return TTL_SUBJECT
  return TTL_LIST
}

/** 构造稳定的列表缓存 key（过滤空值、参数排序，保证同查询同 key） */
export function cacheListKey(domain: string, q: Record<string, unknown>): string {
  const parts = Object.keys(q)
    .sort()
    .filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== '')
    .map((k) => `${k}=${String(q[k])}`)
  return parts.length ? `${domain}:list:${parts.join('&')}` : `${domain}:list:all`
}

/** 读缓存：过期自动删并返回 null；任何异常静默降级为无缓存 */
export function cacheGet<T>(key: string): T | null {
  try {
    const raw = Taro.getStorageSync(nsKey(key))
    if (!raw) return null
    const env = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Envelope
    if (!env || typeof env.ts !== 'number') return null
    if (Date.now() - env.ts > ttlOf(key)) {
      Taro.removeStorageSync(nsKey(key))
      return null
    }
    return env.data as T
  } catch {
    return null
  }
}

/** 写缓存：详情域维护 LRU（超出上限清最旧）；失败静默（缓存是优化不是依赖） */
export function cacheSet<T>(key: string, data: T): void {
  try {
    Taro.setStorageSync(nsKey(key), JSON.stringify({ ts: Date.now(), data }))
    if (key.startsWith('tl:item:') || key.startsWith('mem:item:')) touchLru(key)
  } catch {
    /* 容量满/写失败：不影响主流程 */
  }
}

/** 删单个 key */
export function cacheDel(key: string): void {
  try {
    Taro.removeStorageSync(nsKey(key))
  } catch {
    /* ignore */
  }
}

/** 详情域 LRU：刚写入的 key 置顶，超出 ITEM_LRU_MAX 弹出最旧并删其 storage */
function touchLru(key: string): void {
  try {
    const domain = key.startsWith('tl:item:') ? 'tlitem' : 'memitem'
    const idxKey = `${NS}:${getUserId() || 'anon'}:__lru__:${domain}`
    const raw = Taro.getStorageSync(idxKey)
    let arr: string[] = Array.isArray(raw) ? (raw as string[]) : []
    arr = [key, ...arr.filter((k) => k !== key)]
    while (arr.length > ITEM_LRU_MAX) {
      const dropped = arr.pop()
      if (dropped) Taro.removeStorageSync(nsKey(dropped))
    }
    Taro.setStorageSync(idxKey, arr)
  } catch {
    /* ignore */
  }
}

/**
 * 按域失效：清该域所有缓存（当前用户）。
 * 例：invalidateDomain('tl') 清列表/详情/概览；'subj' 清学科。
 * 由 api.ts 的写操作收口调用——请求**成功**才清，失败不清（缓存仍反映服务端现状）。
 */
export function invalidateDomain(domain: string): void {
  try {
    const full = `${NS}:${getUserId() || 'anon'}:${domain}`
    const info = Taro.getStorageInfoSync()
    for (const k of info.keys) {
      if (k.startsWith(full)) Taro.removeStorageSync(k)
    }
  } catch {
    /* ignore */
  }
}

/**
 * 登出/切换账号：清空全部 gkc:* 缓存（含 LRU 索引）。
 * 保守清所有用户桶——下次登录各自重建，无串数据风险。
 */
export function clearAllCache(): void {
  try {
    const info = Taro.getStorageInfoSync()
    for (const k of info.keys) {
      if (k.startsWith(`${NS}:`)) Taro.removeStorageSync(k)
    }
  } catch {
    /* ignore */
  }
}
