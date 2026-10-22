/**
 * Supabase 连接韧性——GFW 间歇性黑洞官方 Cloudflare IP（2026-10-22 实测）。
 *
 * 现象：本机对 supabase.co 的 DNS 官方 IP（104.18.38.10 / 172.64.149.246）
 * 会被网络层随机封锁数分钟——TCP 看似可连、TLS/HTTP 层挂死，
 * Node fetch 报 `Connect Timeout Error`，Supabase 中间件全部
 * `fetch failed`；而同网段其他 Cloudflare anycast IP（104.18.38.7 等）
 * 照常可达。Cloudflare 按 SNI 路由，换 IP 不影响目标站点，只是延迟略高。
 * 封锁以数分钟为周期抖动，故不能靠「等它恢复」，需要连接层兜底。
 *
 * 方案：对 SUPABASE_URL 的 host 的 dns.lookup 结果注入一个 Cloudflare IP 池，
 * undici 建连时会依次尝试池内地址直到连通（实测 node fetch 对
 * dns.lookup 的补丁生效）；池尾追加真实 DNS 结果兜底，保证无封锁的
 * 网络下行为不变（仅多试几个地址）。
 * 可用环境变量 SUPABASE_IP_POOL="ip1,ip2" 覆盖内置池。
 *
 * 只拦配置里的这一个 host，其余域名走原逻辑；幂等，重复安装无副作用。
 */
import dns from 'dns'

/** 内置 Cloudflare 备用 IP 池（2026-10-22 实测可达；官方 IP 被封锁时仍返回 401=连通） */
const DEFAULT_POOL = [
  '104.18.38.7',
  '104.18.32.7',
  '104.18.36.7',
  '172.64.32.7',
  '172.64.33.7',
  '104.16.0.1',
]

let installed = false

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

/**
 * 安装 DNS 兜底（幂等）。必须在 .env 加载后、首个 Supabase 客户端创建前调用。
 * 上游由 supabase-client.ts 的 getSupabaseCredentials() 负责触发。
 */
export function installSupabaseDnsPin(): void {
  if (installed) return
  const host = resolveSupabaseHost()
  if (!host) return
  installed = true

  const envPool = (process.env.SUPABASE_IP_POOL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const pool = envPool.length ? envPool : DEFAULT_POOL
  const originalLookup = dns.lookup

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
    if (typeof hostname !== 'string' || hostname !== host) {
      return originalLookup.call(dns, hostname, opts, callback)
    }
    // 真实 DNS 结果放池尾兜底；池内地址在前，官方 IP 被封锁时先试备用
    originalLookup.call(dns, hostname, { ...opts, all: true }, (err: any, addresses: any) => {
      const real: { address: string; family?: number }[] =
        !err && Array.isArray(addresses) ? addresses : []
      const seen = new Set<string>()
      const merged: { address: string; family: number }[] = []
      for (const item of [
        ...pool.map((a) => ({ address: a, family: 4 })),
        ...real,
      ] as { address?: string; family?: number }[]) {
        if (!item || !item.address || seen.has(item.address)) continue
        seen.add(item.address)
        merged.push({ address: item.address, family: item.family || 4 })
      }
      if (opts.all) {
        callback(null, merged)
      } else if (merged.length) {
        callback(null, merged[0].address, merged[0].family)
      } else {
        callback(err || new Error('dns lookup failed'), undefined)
      }
    })
    return undefined
  } as typeof dns.lookup
}
