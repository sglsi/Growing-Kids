// ============================================================
// 缓存后端抽象（OPS-18 `R-技术-10` 第 1 项：解除「缓存只能单机」的假设）
//
// 背景：原来 `mem-cache.ts` 直接用一个进程内 `Map`。单机部署够用，但一旦起第二个
// 实例，就会出现「A 实例刚写过、B 实例还读旧值」且**失效广播不到对方**——
// 表现为「改完刷新一下还是旧数据」，而且两端日志都正常，极难查。
//
// 本模块把「存哪里」抽出来：
//   - `REDIS_URL` 未配置（默认）→ 内存 Map（行为与改造前完全一致，零依赖）；
//   - `REDIS_URL` 已配置且装了 `ioredis` → Redis（多实例共享 + 跨实例失效）。
//
// 设计取舍：
//  - **接口是 async 的**：Redis 天然异步；内存实现同步返回 Promise 化即可。
//    这样上层只写一份代码，不必为「有没有 Redis」分叉。
//  - **Redis 不可用时降级内存并告警，不抛错**：缓存不是真相源，降级只损失性能；
//    反过来让缓存故障把整个业务打挂，是把「优化」变成了「风险」。
//  - **不硬依赖 ioredis**：未安装时用 require 动态加载，装不装都能编译/启动。
// ============================================================

export interface CacheStore {
  readonly kind: 'memory' | 'redis'
  get<T>(key: string): Promise<T | null>
  set(key: string, data: unknown, ttlMs?: number): Promise<void>
  del(key: string): Promise<void>
  /** 按前缀批量删（失效收口的关键：一次清掉某用户的全部相关 key） */
  delPrefix(prefix: string): Promise<number>
  /** 条目数（诊断用；Redis 用 DBSIZE，含本项目以外的 key，仅作量级参考） */
  size(): Promise<number>
}

const DEFAULT_TTL_MS = 30_000

// ------------------------------------------------------------
// 内存实现（默认）
// ------------------------------------------------------------
class MemoryCacheStore implements CacheStore {
  readonly kind = 'memory' as const
  private readonly store = new Map<string, { data: unknown; exp: number }>()
  private timer: NodeJS.Timeout | null = null

  constructor() {
    this.timer = setInterval(() => this.sweep(), 60_000)
    // 不阻止进程退出（否则 Ctrl+C / 容器停止要等它）
    this.timer.unref?.()
  }

  private sweep() {
    const now = Date.now()
    for (const [k, v] of this.store) {
      if (v.exp < now) this.store.delete(k)
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key)
    if (!hit) return null
    if (hit.exp < Date.now()) {
      this.store.delete(key)
      return null
    }
    return hit.data as T
  }

  async set(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): Promise<void> {
    this.store.set(key, { data, exp: Date.now() + ttlMs })
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }

  async delPrefix(prefix: string): Promise<number> {
    let n = 0
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k)
        n++
      }
    }
    return n
  }

  async size(): Promise<number> {
    return this.store.size
  }
}

// ------------------------------------------------------------
// Redis 实现（配置 REDIS_URL 且装了 ioredis 才启用）
// ------------------------------------------------------------
/** 本项目所有 key 统一前缀，避免与同 Redis 实例上的其它应用互相 SCAN 到 */
const KEY_PREFIX = 'gk:'

class RedisCacheStore implements CacheStore {
  readonly kind = 'redis' as const
  // 用 any：ioredis 是可选依赖，不在 devDependencies 里，无法静态引用类型
  private readonly client: any

  constructor(client: any) {
    this.client = client
  }

  private k(key: string): string {
    return `${KEY_PREFIX}${key}`
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.k(key))
    if (raw === null || raw === undefined) return null
    try {
      return JSON.parse(String(raw)) as T
    } catch {
      return null
    }
  }

  async set(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): Promise<void> {
    await this.client.set(this.k(key), JSON.stringify(data), 'PX', Math.max(1, ttlMs))
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key))
  }

  /**
   * 前缀删除：Redis 没有「按前缀删」，只能 SCAN 游标扫。
   * 不要用 KEYS —— 它是 O(N) 阻塞命令，数据量一大就把整个实例卡住。
   */
  async delPrefix(prefix: string): Promise<number> {
    const pattern = `${this.k(prefix)}*`
    let cursor = '0'
    let removed = 0
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = String(next)
      if (keys && keys.length) {
        await this.client.del(...keys)
        removed += keys.length
      }
    } while (cursor !== '0')
    return removed
  }

  async size(): Promise<number> {
    return Number(await this.client.dbsize())
  }
}

// ------------------------------------------------------------
// 单例
// ------------------------------------------------------------
let store: CacheStore | null = null
let redisFallbackReason = ''

function createStore(): CacheStore {
  const url = process.env.REDIS_URL
  if (!url) return new MemoryCacheStore()

  try {
    // 动态加载：未安装 ioredis 也能正常构建/启动（降级为内存）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('ioredis')
    const Redis = mod?.default || mod?.Redis || mod
    const client = new Redis(url, {
      // 连接失败不要无限重试刷屏；缓存降级即可
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      enableOfflineQueue: false,
    })
    client.on?.('error', (e: Error) => {
      console.warn('[cache] Redis 连接异常（已降级风险）：', e?.message || e)
    })
    console.log('[cache] 使用 Redis 后端（多实例共享缓存）')
    return new RedisCacheStore(client)
  } catch (e) {
    redisFallbackReason = (e as Error)?.message || String(e)
    console.warn(
      `[cache] REDIS_URL 已配置但 ioredis 不可用，降级为进程内缓存（多副本部署会读到旧数据）：${redisFallbackReason}`,
    )
    return new MemoryCacheStore()
  }
}

/** 取缓存后端单例（首次调用时按环境创建） */
export function cacheStore(): CacheStore {
  if (!store) store = createStore()
  return store
}

/** 诊断：当前后端与降级原因 */
export function cacheBackendInfo(): { kind: string; fallbackReason: string } {
  return { kind: cacheStore().kind, fallbackReason: redisFallbackReason }
}
