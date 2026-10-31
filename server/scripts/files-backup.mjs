#!/usr/bin/env node
/**
 * 文件备份（files-backup.mjs）—— 把 STORAGE_LOCAL_DIR 打成加密归档
 * ------------------------------------------------------------------
 * 为什么必须有这一半：库里存的是文件的 **key**（内容寻址哈希），文件本体在另一处。
 *   本体丢了 ⇒ 数据库完好无损，但所有图片/文档全部打不开，而且没有任何途径重新导出。
 *   db-backup.mjs 只导表，不含二进制对象，所以这是备份的另一半，缺一不可。
 *
 * 链路：tar czf → 复用 backup-format 的 AES-256-GCM 加密 → 本地 gk-files-*.gkbk
 *      （先写 .tmp 再原子改名）→ 立刻读回自检 → 上传网盘 → 比对远端 size → 按份数清理
 *
 * ⚠️ 为什么这里破例用了外部二进制 `tar`：Node 没有内置 tar 打包器，手写一个要处理
 *    512 字节头/校验和/长文件名，出错概率远大于用系统的 GNU tar。
 *    守护手段是**先预检再运行**（缺 tar 直接报错退出，而不是默默产出空包）——
 *    本项目最怕的是"备份显示成功、打开却是空的"，务必保持这个原则。
 *
 * ⚠️ 归档内容是 **tar.gz 流**，与 db-backup 的 NDJSON 不同。两者靠文件名前缀区分：
 *      gk-db-*.gkbk    = 数据库（NDJSON 行）
 *      gk-files-*.gkbk = 文件（tar.gz）
 *    恢复时用 `openssl`/脚本解密后 `tar -xzf - -C <目录>`。
 *
 * 用法：
 *   node scripts/files-backup.mjs                   正常备份（本地 + 网盘）
 *   node scripts/files-backup.mjs --no-upload       只备份到本地
 *   node scripts/files-backup.mjs --keep 6          保留 6 份（默认 6）
 *   node scripts/files-backup.mjs --out /var/lib/gk/backups
 *   node scripts/files-backup.mjs --quiet           只输出一行 JSON（计划任务用）
 *   node scripts/files-backup.mjs --new-passphrase  已有备份但口令确实丢了、确认弃旧时才用
 *                                                   （自动生成新口令 = 让旧备份永久作废，故须显式确认）
 *
 * 退出码：0 成功 ｜ 1 致命失败 ｜ 2 本地成功但网盘上传失败（需人工关注）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { env, SERVER_ROOT } from './lib/gk-env.mjs'
import { ensurePassphrase, open, recordFingerprint, seal } from './lib/backup-format.mjs'
import { Netdisk } from './lib/netdisk.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

const NO_UPLOAD = flag('no-upload')
const QUIET = flag('quiet')
// 与 db-backup 对齐：已有备份但口令确实丢了、且确认弃旧时，才允许换锁
const NEW_PASSPHRASE = flag('new-passphrase')
const KEEP = Math.max(1, Number(opt('keep', '6')) || 6)
const OUT_DIR = path.resolve(opt('out', path.join(SERVER_ROOT, 'backups')))
const SRC_DIR = path.resolve(opt('src', env('STORAGE_LOCAL_DIR', '/var/lib/gk/storage')))
export const FILE_RE = /^gk-files-(\d{8})-(\d{6})\.gkbk$/

const startedAt = Date.now()
const log = (m) => !QUIET && console.log(m)

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function pruneList(files, keep) {
  return [...files].sort((a, b) => b.localeCompare(a)).slice(keep)
}

function writeRunLog(result) {
  try {
    const dir = path.join(SERVER_ROOT, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(
      path.join(dir, `backup-${day}.log`),
      JSON.stringify({ ts: new Date().toISOString(), script: 'files-backup', ...result }) + '\n',
      'utf8',
    )
  } catch (e) {
    console.error('[files-backup] 写运行日志失败（不阻断）', e?.message || e)
  }
}

/** 递归数普通文件数（自检时与 tar 清单比对） */
function countFiles(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name))
      else if (e.isFile()) n += 1
      else if (e.isSymbolicLink()) {
        // 符号链接不跟进：避免环路，也让归档结果可预测
        try {
          if (fs.statSync(path.join(cur, e.name)).isFile()) n += 1
        } catch {
          /* 断链跳过 */
        }
      }
    }
  }
  return n
}

function main() {
  // ① 预检：外部二进制 + 源目录，缺一样就大声失败（不要产出空包）
  const hasTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0
  if (!hasTar) {
    throw new Error(
      '找不到可用的 tar（Node 无内置打包器）。\n' +
        '  Linux/macOS/Windows 10+ 都自带；请先安装或加入 PATH。故意不做静默降级——\n' +
        '  否则会出现"备份成功但归档是空的"这种最坏的失败模式。',
    )
  }
  if (!fs.existsSync(SRC_DIR)) throw new Error(`源目录不存在：${SRC_DIR}`)
  const expectFiles = countFiles(SRC_DIR)
  if (expectFiles === 0) throw new Error(`源目录没有任何文件，疑似路径配错：${SRC_DIR}`)
  log(`[files-backup] 开始 · 源 ${SRC_DIR}（${expectFiles} 个文件）`)

  // ② 打包（内存内进行：先 tar czf 到 stdout，避免临时文件与两遍 IO）
  const tar = spawnSync('tar', ['czf', '-', '-C', SRC_DIR, '.'], {
    encoding: 'buffer',
    maxBuffer: Math.max(512 * 1024 * 1024, expectFiles * 1024 * 1024),
  })
  if (tar.status !== 0 || !tar.stdout?.length) {
    throw new Error(`tar 打包失败（exit=${tar.status}）：${String(tar.stderr || '').slice(0, 300)}`)
  }
  const payload = tar.stdout
  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')
  log(`[files-backup] tar.gz 完成 ${(payload.length / 1024 / 1024).toFixed(1)} MB`)

  // ③ 加密（归档含全部用户上传的原始图片/文档，落消费级网盘前必须先加密）
  // ⚠️ 缺口令且已有历史备份时 ensurePassphrase 会**抛错**（防止静默换锁让旧备份全废），
  //    确认弃旧才加 --new-passphrase。
  const { passphrase } = ensurePassphrase(true, { extraDirs: [OUT_DIR], allowReplace: NEW_PASSPHRASE })
  const sealed = seal(payload, passphrase)

  // ④ 落盘：先 .tmp 再原子改名
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const fileName = `gk-files-${stamp()}.gkbk`
  const filePath = path.join(OUT_DIR, fileName)
  let tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, sealed)
  fs.renameSync(tmpPath, filePath)
  tmpPath = ''
  log(`[files-backup] 已写入 ${filePath}（${(sealed.length / 1024 / 1024).toFixed(1)} MB）`)
  // 口令代次指纹：解密失败时用来区分"旧口令"与"文件损坏"
  recordFingerprint(fileName, passphrase, OUT_DIR)

  // ⑤ 读回自检：解密 → 让 tar 列出清单 → 文件数必须和源目录一致
  const unsealed = open(fs.readFileSync(filePath), passphrase)
  const roundSha = crypto.createHash('sha256').update(unsealed).digest('hex')
  if (roundSha !== payloadSha256) throw new Error('读回自检失败：解密后 sha256 与写入前不一致')
  const listed = spawnSync('tar', ['-tzf', '-'], { input: unsealed, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listed.status !== 0) {
    throw new Error(`读回自检失败：解密后的归档无法用 tar 列出（${String(listed.stderr || '').slice(0, 200)}）`)
  }
  const listedFiles = String(listed.stdout)
    .split('\n')
    .filter((l) => l && !l.endsWith('/')).length
  if (listedFiles !== expectFiles) {
    throw new Error(`读回自检失败：归档内文件数 ${listedFiles} ≠ 源目录 ${expectFiles}`)
  }
  log(`[files-backup] 读回自检通过（解密 + tar 清单 ${listedFiles} 项 + sha256 一致）`)

  // ⑥ 本地保留策略
  const pruned = pruneList(
    fs.readdirSync(OUT_DIR).filter((f) => FILE_RE.test(f)),
    KEEP,
  )
  for (const f of pruned) fs.rmSync(path.join(OUT_DIR, f), { force: true })
  if (pruned.length) log(`[files-backup] 本地清理 ${pruned.length} 份旧备份（保留 ${KEEP} 份）`)

  const result = {
    ok: true,
    file: fileName,
    bytes: sealed.length,
    fileCount: listedFiles,
    payloadSha256,
    localPruned: pruned.length,
    uploaded: false,
    uploadPath: '',
    uploadError: '',
    ms: 0,
  }

  return { result, sealed, fileName }
}

async function upload(sealed, fileName, result) {
  if (NO_UPLOAD) return result
  const nd = new Netdisk()
  if (!nd.enabled()) {
    result.uploadError = `网盘未配置（缺 ${nd.missingKeys().join(' / ')}），仅保留本地副本`
    log(`[files-backup] ⚠️ ${result.uploadError}`)
    return result
  }
  try {
    result.uploadPath = await nd.upload(fileName, sealed)
    result.uploaded = true
    log(`[files-backup] 已上传 ${result.uploadPath}`)

    const listed = (await nd.list(nd.root)).find((f) => f.server_filename === fileName)
    if (!listed) throw new Error('上传后目录里找不到该文件')
    if (Number(listed.size) !== sealed.length) {
      throw new Error(`上传大小不一致：本地 ${sealed.length}B，网盘 ${listed.size}B`)
    }
    log(`[files-backup] 网盘校验通过（size ${listed.size}B 一致）`)

    const remote = (await nd.list(nd.root))
      .filter((f) => FILE_RE.test(String(f.server_filename)) && Number(f.isdir) !== 1)
      .map((f) => String(f.server_filename))
    const remotePruned = pruneList(remote, KEEP)
    for (const f of remotePruned) await nd.remove(`${nd.root}/${f}`)
    result.remotePruned = remotePruned.length
    if (remotePruned.length) log(`[files-backup] 网盘清理 ${remotePruned.length} 份旧备份（保留 ${KEEP} 份）`)
  } catch (e) {
    result.uploadError = e?.message || String(e)
    log(`[files-backup] ⚠️ 网盘上传失败：${result.uploadError}（本地副本已成功，可人工补传）`)
  }
  return result
}

async function run() {
  const { result, sealed, fileName } = main()
  await upload(sealed, fileName, result)
  result.ms = Date.now() - startedAt
  writeRunLog(result)
  if (QUIET) {
    console.log(
      JSON.stringify({
        ok: true,
        file: result.file,
        bytes: result.bytes,
        files: result.fileCount,
        uploaded: result.uploaded,
        uploadError: result.uploadError || undefined,
      }),
    )
  } else {
    log(`[files-backup] 完成，用时 ${(result.ms / 1000).toFixed(1)}s`)
  }
  process.exitCode = result.uploaded || NO_UPLOAD ? 0 : 2
}

run().catch((e) => {
  const msg = e?.message || String(e)
  console.error(`[files-backup] ❌ 失败：${msg}`)
  if (e?.stack && env('BACKUP_DEBUG') === '1') console.error(e.stack)
  writeRunLog({ ok: false, error: msg, ms: Date.now() - startedAt })
  process.exitCode = 1
})
