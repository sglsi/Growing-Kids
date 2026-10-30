/**
 * 备份文件格式：gzip 压缩 + AES-256-GCM 加密（纯 Node，无外部依赖）
 * ------------------------------------------------------------------
 * 为什么要加密：数据库导出包含**全部用户**的数据（本项目是未成年人错题与学习轨迹）。
 * 落到「百度网盘个人账号」这种消费级存储上，如果明文存放，一次账号泄露 = 全体用户数据泄露。
 * 加密后即使备份文件被拿走，没有口令也读不出内容——这是把「存储位置不可信」的影响面压到最小。
 *
 * 文件布局（二进制，固定头 + 密文尾）：
 *   offset 0   4B   魔数 "GKBK"
 *   offset 4   1B   格式版本（当前 0x01）
 *   offset 5   16B  scrypt 盐
 *   offset 21  12B  GCM IV
 *   offset 33  16B  GCM 认证标签
 *   offset 49  ...  密文（= gzip(明文 NDJSON) 再加密）
 *
 * 为什么用 GCM 而不是 CBC：GCM 自带完整性认证——文件被改一个字节，解密直接失败。
 * 备份最怕的不是"打不开"，而是"能打开但内容是错的"。
 *
 * 口令来源：server/.env.secrets 的 BACKUP_PASSPHRASE。
 * ⚠️ 口令丢了 = 备份全部作废，没有后门。首次生成时会写一份本地托管文件并醒目标注。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { env, SERVER_ROOT } from './gk-env.mjs'

const MAGIC = Buffer.from('GKBK', 'ascii')
const VERSION = 1
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN
// scrypt 参数与 encrypt-env.mjs 一致：N=2^15 约 100ms，脚本场景足够且不拖慢计划任务
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_LEN = 32

export const BACKUP_DIR = path.join(SERVER_ROOT, 'backups')
export const KEY_ESCROW_FILE = path.join(BACKUP_DIR, 'KEY-ESCROW.txt')
const SECRETS_FILE = path.join(SERVER_ROOT, '.env.secrets')

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT)
}

const FILE_RE = /^gk-db-\d{8}-\d{6}\.gkbk$/

/** 一批目录里已存在的备份文件名（新→旧），用于阻止"换锁"事故 */
export function listPriorBackups(dirs = [BACKUP_DIR]) {
  const dirList = Array.isArray(dirs) ? dirs : [dirs]
  const out = []
  for (const dir of dirList) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (FILE_RE.test(f) && fs.statSync(path.join(dir, f)).isFile()) out.push(f)
      }
    } catch {
      /* 目录不存在就当没有历史备份 */
    }
  }
  return [...new Set(out)].sort((a, b) => b.localeCompare(a))
}

/**
 * 取口令；不存在且 allowCreate 时生成并写入 .env.secrets。
 *
 * ⚠️ 2026-10-31 真实事故：口令被**静默重新生成**，导致此前 5 份备份全部变成打不开的死文件
 *    （现象：文件头 GKBK/版本都正常，唯独 GCM 校验过不去，容易误判成"文件损坏"）。
 *    根因不是磁盘或格式，而是「没有口令 → 自动生成一把新的」，老备份当场被换锁。
 *  ⇒ 现在的策略：如果 backups 目录里**已经存在备份**，缺口令时不再自动新建，
 *     而是报错让人明确选择——要不要真的启动一条新链。
 *
 * @returns {{ passphrase: string, created: boolean }}
 */
export function ensurePassphrase(allowCreate = true, options = {}) {
  const { allowReplace = false, extraDirs = [] } = options
  const existing = env('BACKUP_PASSPHRASE')
  if (existing && existing.length >= 16) return { passphrase: existing, created: false }

  if (!allowCreate) {
    throw new Error(
      'server/.env.secrets 缺少 BACKUP_PASSPHRASE（至少 16 字符）。\n' +
        '  首次使用请先跑一次 `node scripts/db-backup.mjs`（会自动生成并提示托管），\n' +
        '  或手工写入一个你妥善保存的口令。',
    )
  }

  // 已有的备份文件 —— 继续自动生成新口令 = 让它们永久失效，必须拦下来
  const prior = listPriorBackups([BACKUP_DIR, ...extraDirs])
  if (prior.length && !allowReplace) {
    throw new Error(
      `server/.env.secrets 里没有 BACKUP_PASSPHRASE，但 backups 目录已有 ${prior.length} 份备份：\n` +
        `    ${prior.slice(0, 3).join('\n    ')}${prior.length > 3 ? '\n    …' : ''}\n` +
        `  这些备份是用**别的口令**加密的。若此刻自动生成新口令，它们将永远打不开。\n` +
        `  请二选一：\n` +
        `    A. 找回旧口令（查 KEY-ESCROW.txt / 密码管理器），写回 BACKUP_PASSPHRASE；\n` +
        `    B. 确认旧备份可以放弃，显式执行：node scripts/db-backup.mjs --new-passphrase\n` +
        `      （建议先把旧文件挪到 server/backups/orphaned/ 留档，别直接删）`,
    )
  }

  const passphrase = crypto.randomBytes(32).toString('base64url')
  fs.appendFileSync(
    SECRETS_FILE,
    `\n# 备份加密口令（AES-256-GCM）。⚠️ 丢失=所有备份永久不可恢复，务必另存到密码管理器\nBACKUP_PASSPHRASE=${passphrase}\n`,
    'utf8',
  )

  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const escrow =
    `Growing-Kids 数据库备份口令（托管副本）\n` +
    `生成时间：${new Date().toISOString()}\n` +
    `路径：${SECRETS_FILE} 的 BACKUP_PASSPHRASE\n\n` +
    `${passphrase}\n\n` +
    `⚠️ 这份文件只在本机。磁盘损坏时**本文件与备份一起丢失**。\n` +
    `   请立刻把它抄进密码管理器（或打印留存），否则异地备份等于没有。\n`
  fs.writeFileSync(KEY_ESCROW_FILE, escrow, { encoding: 'utf8', mode: 0o600 })

  return { passphrase, created: true }
}

/** 加密：返回完整文件 Buffer */
export function seal(plainBuffer, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag, ciphertext])
}

/** 解密：失败抛错（改过字节 / 口令错 / 不是本格式） */
export function open(fileBuffer, passphrase) {
  if (fileBuffer.length < HEADER_LEN + 1) throw new Error('文件过短，不是有效的备份文件')
  if (!fileBuffer.subarray(0, 4).equals(MAGIC)) throw new Error('魔数不匹配：不是 GKBK 备份文件')
  const version = fileBuffer[4]
  if (version !== VERSION) throw new Error(`备份格式版本不支持：${version}（本脚本支持 ${VERSION}）`)
  let off = 5
  const salt = fileBuffer.subarray(off, (off += SALT_LEN))
  const iv = fileBuffer.subarray(off, (off += IV_LEN))
  const tag = fileBuffer.subarray(off, (off += TAG_LEN))
  const ciphertext = fileBuffer.subarray(off)

  const key = deriveKey(passphrase, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('解密失败：口令不对，或备份文件已损坏（GCM 校验不通过）')
  }
}

export const FORMAT_INFO = { MAGIC: 'GKBK', VERSION, HEADER_LEN }
