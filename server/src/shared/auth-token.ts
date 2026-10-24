// ============================================================
// 身份令牌（Auth Token）—— 防伪造身份头（2026-10-24，思傅选方案 A）
//
// 背景：此前身份只靠 `X-User-Id` 请求头传递，**无任何校验** ⇒ 任何人带任意
// user id 即可读写他人数据（.eq('user_id') 只是把「猜 id」当成了边界）。
// 小程序前端不能持有签名密钥（JS 可被提取），所以采用**服务端签发票据**：
//   登录/建号时后端签发 token，前端存 storage，后续请求带 `X-Auth-Token`。
//
// 格式：v1.<userId>.<expSec>.<sig>
//   payload = `v1.${userId}.${expSec}`
//   sig     = HMAC-SHA256(payload, AUTH_TOKEN_SECRET) 取 hex 前 40 位
//
// 过渡策略（不破坏现有版本）：
//   - 未配置 AUTH_TOKEN_SECRET ⇒ 不签、不验，行为与改造前完全一致（打 warn）；
//   - 配置后：后端优先验 X-Auth-Token，通过则用令牌里的 userId；
//     X-User-Id 仍兼容（老版本小程序/真机缓存），但每次都会打 warn，
//     待前端全量带上 token 后再禁用它（登记 GK-OPS-18 R-技术-09）。
// ============================================================

import crypto from 'crypto'

const HEADER = 'x-auth-token'
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 天，与匿名身份 TTL 对齐；后端滑动续期

function secret(): string | undefined {
  const s = process.env.AUTH_TOKEN_SECRET
  return s && s.length >= 16 ? s : undefined
}

/** 是否启用了令牌签发（密钥已配置） */
export function authTokenEnabled(): boolean {
  return !!secret()
}

/** 为某用户签发身份令牌 */
export function signAuthToken(userId: string): string {
  const s = secret()
  if (!s) return ''
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS
  const payload = `v1.${userId}.${exp}`
  const sig = crypto.createHmac('sha256', s).update(payload).digest('hex').slice(0, 40)
  return `${payload}.${sig}`
}

/** 验签；成功返回 userId，失败（过期/篡改/格式错/未启用）返回 null */
export function verifyAuthToken(token: string | undefined | null): string | null {
  const s = secret()
  if (!s || !token) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [ver, userId, expStr, sig] = parts
  if (ver !== 'v1' || !userId || !expStr || !sig) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null
  const expect = crypto.createHmac('sha256', s).update(`v1.${userId}.${expStr}`).digest('hex').slice(0, 40)
  // 定长比较，防时序侧信道
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return userId
}

/** 请求头里取令牌（大小写不敏感） */
export function readAuthHeader(headers: Record<string, unknown>): string | undefined {
  const v = headers?.[HEADER]
  const raw = Array.isArray(v) ? v[0] : v
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}
