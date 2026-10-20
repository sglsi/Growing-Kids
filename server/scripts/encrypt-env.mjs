#!/usr/bin/env node
/**
 * 敏感环境变量加密器（encrypt-env.mjs）
 * ------------------------------------------------------------------
 * 目的：后端部署包会随 tar 上传到平台云端（.env 不在平台排除名单里），
 * 为避免 Supabase service_role key / WX_SECRET 等以明文落包，
 * 敏感项集中放 server/.env.secrets，用本脚本加密为 server/.env.secrets.enc
 * （只上传密文）；容器启动时由 decrypt-env.mjs 还原。
 *
 * 算法：AES-256-GCM（认证加密，改一个字节即解密失败）
 * 密钥派生：scrypt(小程序 AppID + 用途串, 随机盐) → 256-bit
 *   - AppID 是公开标识（小程序客户端包体内本就含它），不是秘密；
 *     派生方案防的是「包被随手翻看/被自动扫描器捞key」，防不住定向攻击。
 *     彻底防护靠轮换密钥本身（WX_SECRET 正式版发布时轮换，见 MEMORY.md）。
 *   - 盐/IV 每次加密随机生成，同一明文两次加密产物不同。
 *
 * 用法（在项目根 D:/AI/Growing-Kids 执行）：
 *   node server/scripts/encrypt-env.mjs          加密 .env.secrets → .env.secrets.enc
 *   node server/scripts/encrypt-env.mjs --verify 加密后立即解密自检（不写回明文）
 *
 * 注意：每次修改 .env.secrets 都必须重跑本脚本，否则线上还是旧密钥。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PLAIN_PATH = path.join(SERVER_ROOT, '.env.secrets')
const ENC_PATH = path.join(SERVER_ROOT, '.env.secrets.enc')

/** 密钥派生输入：小程序 AppID（公开标识）。可用 ENV_APPID 覆盖（轮换时用）。 */
const APPID = process.env.ENV_APPID || 'wx48bf5ba9bae0bf39'
/** 用途串：把密钥绑定到「Growing-Kids 的 .env.secrets v1」这一场景 */
const KDF_INFO = 'growing-kids/.env.secrets/v1'
/** scrypt 参数：N=2^15 约 100ms，对「防扫描」足够、对容器冷启动无感 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_LEN = 32 // AES-256

function deriveKey(salt) {
  return crypto.scryptSync(Buffer.from(`${APPID}|${KDF_INFO}`, 'utf8'), salt, KEY_LEN, SCRYPT)
}

function countKeys(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length
}

function main() {
  if (!fs.existsSync(PLAIN_PATH)) {
    console.error(`[encrypt-env] ✗ 找不到明文文件：${PLAIN_PATH}`)
    console.error('[encrypt-env]   请先创建 .env.secrets 并填入敏感密钥。')
    process.exit(1)
  }
  const plain = fs.readFileSync(PLAIN_PATH)
  if (plain.length === 0) {
    console.error(`[encrypt-env] ✗ 明文文件为空：${PLAIN_PATH}`)
    process.exit(1)
  }

  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12) // GCM 推荐 96bit
  const key = deriveKey(salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()

  const payload = {
    v: 1,
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  }
  fs.writeFileSync(ENC_PATH, `${JSON.stringify(payload, null, 2)}\n`)

  console.log(`[encrypt-env] ✓ 已加密 ${path.relative(SERVER_ROOT, PLAIN_PATH)}（${plain.length} 字节，${countKeys(plain.toString('utf8'))} 项）`)
  console.log(`[encrypt-env] ✓ 已写出 ${path.relative(SERVER_ROOT, ENC_PATH)}（${fs.statSync(ENC_PATH).size} 字节，可随部署包上传）`)

  if (process.argv.includes('--verify')) {
    try {
      const back = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv)
      back.setAuthTag(tag)
      const out = Buffer.concat([back.update(ct), back.final()])
      if (!out.equals(plain)) throw new Error('解密结果与原文不一致')
      console.log('[encrypt-env] ✓ 自检通过：解密往返一致')
    } catch (e) {
      console.error(`[encrypt-env] ✗ 自检失败：${e.message}`)
      process.exit(1)
    }
  }
}

main()
