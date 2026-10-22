/**
 * Supabase 连接韧性——GFW 间歇性黑洞 supabase.co 的 Cloudflare IP（2026-10-22 实测）。
 *
 * 现象：本机对 supabase.co 的 DNS 官方 IP（104.18.38.10 / 172.64.149.246）及大量
 * 同网段 Cloudflare anycast IP 被网络层随机封锁——**TCP 可连但 TLS/HTTP 挂死**
 * （Node fetch `Connect Timeout`），封锁面以数分钟为周期漂移：18:47 时 6 个备用
 * IP 全通，20:26 时只剩 1 个能通。公共 DNS 返回的始终是同样两个被封 IP，
 * 故不是 DNS 污染而是 IP 级封锁，靠固定 IP 池打地蛇必输。
 *
 * 方案（Cloudflare 优选 IP 思路，零新增依赖）：
 *   1. 维护一份 ~24 个跨网段的 Cloudflare 候选 IP（含官方 DNS 结果）；
 *   2. 后台用 **TLS 探针**（tls.connect + servername，被封 IP 的 TCP 能连但
 *      TLS 握手挂死，故必须探测到 TLS 层）并行探测，按握手延迟排序；
 *   3. 补丁后的 dns.lookup 返回「当前实测可通的 IP（按延迟升序）+ 官方 DNS 兜底」，
 *      undici 依次尝试直到连通——可通的排在前面，第一个就连上，不会踩 10s 总预算；
 *   4. 每 5 分钟自动重探（封锁面漂移时自愈），首次安装后立即探一轮。
 *   `SUPABASE_IP_POOL=ip1,ip2` 可覆盖内置候选集。
 *
 * 只拦配置里的这一个 host，其余域名走原逻辑；幂等。
 */
import dns from 'dns'
import tls from 'tls'

/**
 * 内置 Cloudflare 候选 IP（跨 104.16.0.0/12、172.64.0.0/13 多网段，
 * 取自公开优选 IP 段 + 2026-10-22 实测可达记录）。CF 按 SNI 路由，
 * 任一 anycast IP 都能到 supabase.co 的源站，只是延迟与是否被封锁不同。
 */
const CANDIDATE_IPS = [
  '104.16.0.1',
  '104.17.0.1',
  '104.18.32.7',
  '104.18.36.7',
  '104.18.38.7',
  '104.19.0.1',
  '104.20.0.1',
  '104.21.0.1',
  '104.22.0.1',
  '104.23.0.1',
  '104.24.0.1',
  '104.25.0.1',
  '104.26.0.1',
  '104.27.0.1',
  '104.28.0.1',
  '172.64.32.7',
  '172.64.33.7',
  '172.64.36.7',
  '172.64.41.7',
  '172.64.72.7',
  '172.64.80.7',
  '172.64.96.7',
  '172.64.112.7',
  '172.64.128.7',
  '172.64.144.7',
  '172.64.160.7',
  '172.64.176.7',
  '172.64.192.7',
  '172.64.208.7',
  '172.64.224.7',
  '172.64.240.7',
]

/** 探测参数 */
const PROBE_TIMEOUT_MS = 5000
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
/** 官方 DNS 结果的本地缓存 TTL（避免每次 lookup 都打一次 DNS） */
const DNS_CACHE_TTL_MS = 60_000

let installed = false
let targetHost = ''
/** 当前实测可通的 IP，按握手延迟升序；空数组 = 还没探到或全挂 */
let rankedIps: string[] = []
/** 官方 DNS 结果缓存 */
let officialCache: { at: number; ips: string[] } = { at: 0, ips: [] }
let refreshing = false

/** 模块加载时捕获的原始 dns.lookup（补丁前后都不能丢，否则 officialIps 会递归进补丁） */
const originalLookup = dns.lookup

/** 从 SUPABASE_URL 提取 hostname（未配置 / 已是 IP 字面量时返回 null） */
function resolveSupabaseHost(): string | null {
  const raw = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL
  if (!raw || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    const host = u.hostname
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null
    return host
  } catch {
    return null
  }
}

/** 对单个 IP 做 TLS 握手探测，返回延迟毫秒；不可达返回 Infinity */
function probeIp(ip: string): Promise<number> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const done = (ms: number) => {
      if (settled) return
      settled = true
      resolve(ms)
    }
    const socket = tls.connect(
      { host: ip, port: 443, servername: targetHost },
      () => {
        const ms = Date.now() - t0
        socket.destroy()
        done(ms)
      },
    )
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy()
      done(Infinity)
    })
    socket.on('error', () => {
      socket.destroy()
      done(Infinity)
    })
  })
}

/** 官方 DNS 结果（带 60s 缓存） */
function officialIps(): Promise<string[]> {
  const now = Date.now()
  if (now - officialCache.at < DNS_CACHE_TTL_MS && officialCache.ips.length) {
    return Promise.resolve(officialCache.ips)
  }
  return new Promise((resolve) => {
    originalLookup.call(dns, targetHost, { all: true }, (err, addresses) => {
      const ips =
        !err && Array.isArray(addresses)
          ? addresses.map((a) => a.address).filter((a): a is string => typeof a === 'string')
          : []
      if (ips.length) officialCache = { at: now, ips }
      resolve(ips)
    })
  })
}

/** 并行探测候选集，重排 rankedIps（可通的按延迟升序在前） */
async function refreshRankedIps(): Promise<void> {
  if (refreshing || !targetHost) return
  refreshing = true
  try {
    const envPool = (process.env.SUPABASE_IP_POOL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const official = await officialIps()
    const candidates = Array.from(new Set([...(envPool.length ? envPool : CANDIDATE_IPS), ...official]))
    const results = await Promise.all(
      candidates.map(async (ip) => ({ ip, ms: await probeIp(ip) })),
    )
    const ok = results
      .filter((r) => Number.isFinite(r.ms))
      .sort((a, b) => a.ms - b.ms)
      .map((r) => r.ip)
    rankedIps = ok
    const stamp = new Date().toISOString().slice(11, 19)
    console.info(
      `[supabase-dns-pin] ${stamp} 探测 ${candidates.length} 个候选 IP：可通 ${ok.length} 个` +
        (ok.length ? `，最优 ${ok.slice(0, 3).join(' / ')}` : '（全军覆没，回退官方 DNS）'),
    )
  } catch {
    // 探测异常不影响主流程，下轮再试
  } finally {
    refreshing = false
  }
}

/**
 * 安装 DNS 兜底（幂等）。必须在 .env 加载后、首个 Supabase 客户端创建前调用。
 * 上游由 supabase-client.ts 的 getSupabaseCredentials() 负责触发。
 */
export function installSupabaseDnsPin(): void {
  if (installed) return
  const host = resolveSupabaseHost()
  if (!host) return
  installed = true
  targetHost = host

  dns.lookup = function patchedLookup(
    hostname: string,
    options: any,
    callback?: any,
  ): any {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const opts = options || {}
    if (typeof hostname !== 'string' || hostname !== targetHost) {
      return originalLookup.call(dns, hostname, opts, callback)
    }
    // 返回顺序 = 实测可通（按延迟升序）→ 官方 DNS 兜底；undici 首个就连上，
    // 不会被一串挂死的 IP 吃光 10s 连接总预算。
    officialIps().then((official) => {
      const merged: string[] = []
      const seen = new Set<string>()
      for (const ip of [...rankedIps, ...official]) {
        if (!ip || seen.has(ip)) continue
        seen.add(ip)
        merged.push(ip)
      }
      if (opts.all) {
        callback(null, merged.map((address) => ({ address, family: 4 })))
      } else if (merged.length) {
        callback(null, merged[0], 4)
      } else {
        callback(new Error('dns lookup failed'), undefined)
      }
    })
    return undefined
  } as typeof dns.lookup

  // 立即探一轮 + 每 5 分钟重探（封锁面漂移自愈）；unref 不阻塞进程退出
  void refreshRankedIps()
  const timer = setInterval(() => void refreshRankedIps(), REFRESH_INTERVAL_MS)
  timer.unref()
}
