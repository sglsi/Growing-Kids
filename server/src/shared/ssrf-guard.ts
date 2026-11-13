// ============================================================
// SSRF 防护：拦截服务端向外发起的请求打向内网 / 链路本地 / 回环地址。
//
// 背景（代码审查 P1）：`ImageService.download(url)` 会按请求体里的 `image_url`
// 直接抓取任意 http(s) 地址。旧校验只挡「无 host 或不含点」的串（防 `tmp/…`
// 误当主机名），但放行了 `169.254.169.254`（云元数据）、`10/8`、`172.16/12`、
// `192.168/16` 等内网与链路本地地址 —— 构成服务端请求伪造。
//
// 设计：
//  - `assertSafeHttpUrl` 解析 URL → 必须 http/https → 解析主机到 IP（含 DNS 多记录）→
//    任一地址落在保留/私网/回环/链路本地段即拒绝（fail-closed）。
//  - 回环地址（127.0.0.1 / ::1）一并拦截：本地存储读取已改走 `readObject` 直读磁盘，
//    不再经 HTTP 到本机，故 download 只需放行真正的公网主机。
//  - 重定向递归（`download(location)`）会在函数顶部重新校验每一跳。
//  - TOCTOU：DNS 解析与建连之间存在窗口，公网高危场景应改用「建连后比对本地套接字地址」，
//    此处按通用后端实践采用解析 + 网段拦截，足以挡住绝大多数内网/云元数据探测。
// ============================================================

import * as dns from 'dns'
import { BadRequestException } from '@nestjs/common'

/**
 * IPv4/IPv6 是否落在不可对外暴露的保留段。
 * 覆盖：回环、私网、链路本地（含 169.254.169.254 云元数据）、CGNAT、唯一本地、未指定。
 */
export function isReservedIp(ip: string): boolean {
  // IPv4 映射地址（::ffff:a.b.c.d）→ 取内嵌 IPv4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isReservedIpV4(mapped[1])

  if (ip.includes(':')) return isReservedIpV6(ip)

  return isReservedIpV4(ip)
}

function isReservedIpV4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 本网络
  if (a === 10) return true // 10.0.0.0/8 私网
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 127) return true // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true // 169.254.0.0/16 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 私网
  if (a === 192 && b === 0 && parts[2] === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 168) return true // 192.168.0.0/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 基准测试
  if (a >= 224) return true // 224.0.0.0/4 多播 + 240.0.0.0/4 保留
  return false
}

function isReservedIpV6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true // 未指定 / 回环
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 唯一本地
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true // fe80::/10 链路本地
  }
  // ::ffff:0:0/96 之外的保留段简判
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) {
    return true
  }
  return false
}

/**
 * 断言给定 URL 可被服务端安全抓取：必须是 http/https 绝对地址，且解析到的所有
 * IP 均不在保留/私网段。失败时抛 BadRequest（不回显内部细节）。
 */
export async function assertSafeHttpUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BadRequestException('非法的图片地址：必须是完整的 http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('不支持的协议：仅允许 http/https')
  }

  const host = parsed.hostname.toLowerCase()
  // 直接是 IP 字面量：立即判段
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isReservedIp(host)) {
      throw new BadRequestException('图片地址指向保留/内网地址，已被拒绝')
    }
    return
  }

  // 主机名：解析所有 A/AAAA 记录，任一落在保留段即拒绝
  let addresses: string[]
  try {
    addresses = await dns.promises.lookup(host, { all: true }).then((r) => r.map((x) => x.address))
  } catch {
    // 解析失败也拒绝（fail-closed）：宁可不抓，不可打向内网
    throw new BadRequestException('图片地址解析失败，已被拒绝')
  }
  if (!addresses.length || addresses.some((a) => isReservedIp(a))) {
    throw new BadRequestException('图片地址指向保留/内网地址，已被拒绝')
  }
}
