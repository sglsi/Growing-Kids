#!/usr/bin/env node
/**
 * 敏感环境变量解密器（decrypt-env.mjs）
 * ------------------------------------------------------------------
 * 部署场景由容器 startCmd 在启动服务前调用：
 *   node scripts/decrypt-env.mjs && npm run start
 * 把 .env.secrets.enc（密文，随包上传）还原为 .env.secrets（明文，仅容器内），
 * 随后 main.ts 会把它和 .env 一起加载。
 *
 * 只依赖 Node 内置模块（crypto/fs/path/url），不装任何依赖，保证容器里零缺失。
 *
 * 退出码：
 *   0 = 成功（或无需处理：本地已有明文、且无密文文件）
 *   1 = 密文存在但解密失败（AppID 不匹配/文件损坏）——必须让启动失败，
 *       避免服务带着缺失密钥静默跑起来（登录/存储全坏还难排查）。
 *
 * 用法：
 *   node scripts/decrypt-env.mjs           解密并写回 .env.secrets
 *   node scripts/decrypt-env.mjs --check   只在内存里解密自检，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PLAIN_PATH = path.join(SERVER_ROOT, '.env.secrets')
const ENC_PATH = path.join(SERVER_ROOT, '.env.secrets.enc')

/** 与 encrypt-env.mjs 保持一致：小程序 AppID（公开标识），ENV_APPID 可覆盖 */
const APPID = process.env.ENV_APPID || 'wx48bf5ba9bae0bf39'
const KDF_INFO = 'growing-kids/.env.secrets/v1'
const KEY_LEN = 32

function fail(msg, hint) {
  console.error(`[decrypt-env] ✗ ${msg}`)
  if (hint) console.error(`[decrypt-env]   ${hint}`)
  process.exit(1)
}

function main() {
  const checkOnly = process.argv.includes('--check')

  if (!fs.existsSync(ENC_PATH)) {
    // 没有密文文件：本地开发场景（.env.secrets 明文已在位）→ 静默跳过
    if (fs.existsSync(PLAIN_PATH)) {
      console.log('[decrypt-env] 无 .env.secrets.enc，检测到本地明文 .env.secrets，跳过解密（本地开发模式）')
      return
    }
    fail(`找不到 ${path.relative(SERVER_ROOT, ENC_PATH)}，也没有本地明文 .env.secrets`,
      '如果是部署环境：说明加密文件没被打进包——检查 deploy-pack.mjs 是否误把 .env.secrets.enc 挪走；如果是本地：直接编辑 .env.secrets 即可')
  }

  let payload
  try {
    payload = JSON.parse(fs.readFileSync(ENC_PATH, 'utf8'))
  } catch (e) {
    fail(`.env.secrets.enc 不是合法 JSON：${e.message}`, '请重新运行 node server/scripts/encrypt-env.mjs')
  }
  if (payload.alg !== 'aes-256-gcm' || payload.kdf !== 'scrypt') {
    fail(`不支持的算法组合：alg=${payload.alg} kdf=${payload.kdf}`)
  }

  const salt = Buffer.from(payload.salt, 'base64')
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ct = Buffer.from(payload.ct, 'base64')

  const key = crypto.scryptSync(
    Buffer.from(`${APPID}|${KDF_INFO}`, 'utf8'),
    salt,
    KEY_LEN,
    { N: payload.kdfParams?.N ?? 32768, r: payload.kdfParams?.r ?? 8, p: payload.kdfParams?.p ?? 1, maxmem: 128 * 1024 * 1024 },
  )

  let plain
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch (e) {
    fail('解密失败（GCM 认证未通过）', `通常是 AppID 不匹配或密文被改坏。当前使用 AppID=${APPID}；如近期重置过小程序 AppID，请用 ENV_APPID=<新AppID> 重跑，或重新加密。原始错误：${e.message}`)
  }

  if (checkOnly) {
    const n = plain.toString('utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length
    console.log(`[decrypt-env] ✓ 自检通过：可在内存中解密 ${n} 项密钥（未写文件）`)
    return
  }

  // 原子写：先写临时文件再 rename，避免容器重启时写到一半
  const tmp = `${PLAIN_PATH}.tmp`
  fs.writeFileSync(tmp, plain)
  try {
    fs.chmodSync(tmp, 0o600) // 仅属主可读
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
  fs.renameSync(tmp, PLAIN_PATH)
  console.log(`[decrypt-env] ✓ 已还原 ${path.relative(SERVER_ROOT, PLAIN_PATH)}（${plain.length} 字节，权限 600）`)
}

main()
