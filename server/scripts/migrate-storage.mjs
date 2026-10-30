#!/usr/bin/env node
/**
 * Supabase Storage → 本地磁盘 迁移器（S2-4）
 * ------------------------------------------------------------------
 * 背景：本方案 STORAGE_DRIVER 从 supabase 切到 local（详见《后端托管-L3实施方案》S2-4）。
 * code 层不用改：storage.service.ts 的 local 分支是完整生产实现，只要文件按 **原始 key**
 * 落盘到 STORAGE_LOCAL_DIR 即可，读取走 GET /api/storage/files/* 。
 *
 * 为什么必须「全桶遍历」而不是「按业务表反查 key」：
 *   桶里存在不属于 blobs/ 内容寻址体系的遗留对象（如 1792560305813.docx），
 *   这些对象在 blob_objects 表里查不到，但对应用而言是真实文件（导出/打开会 404）。
 *
 * 用法：
 *   node server/scripts/migrate-storage.mjs --env /home/ubuntu/.src-storage.env --dest /var/lib/gk/storage
 * 可选参数：
 *   --bucket <name>   默认 media
 *   --conc <n>        并发数，默认 8
 *   --dry             只列出对象清单并统计体积，不下载
 *
 * 约定：--env 指向的文件需提供
 *   SRC_SUPABASE_URL=https://<ref>.supabase.co
 *   SRC_SUPABASE_SERVICE_KEY=<service role key>
 * 迁移完成后该文件即可删除（源站凭据不应留在生产机上）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const has = (n) => process.argv.includes(`--${n}`)

const ENV_FILE = arg('env', null)
const BUCKET = arg('bucket', 'media')
const DEST = arg('dest', '/var/lib/gk/storage')
const CONC = Number(arg('conc', '8'))
const DRY = has('dry')

if (ENV_FILE) dotenv.config({ path: ENV_FILE })

const SUPA_URL = (process.env.SRC_SUPABASE_URL || '').replace(/\/+$/, '')
const SUPA_KEY = process.env.SRC_SUPABASE_SERVICE_KEY
if (!SUPA_URL || !SUPA_KEY) {
  console.error('[storage] ✗ 缺少 SRC_SUPABASE_URL / SRC_SUPABASE_SERVICE_KEY。用 --env 指向凭据文件。')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 列表：返回该 prefix 下的直接子项（含文件夹，文件夹 metadata===null） */
async function listDir(prefix) {
  const url = `${SUPA_URL}/storage/v1/object/list/${BUCKET}`
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPA_KEY}`,
        apikey: SUPA_KEY,
      },
      body: JSON.stringify({
        prefix,
        limit: 1000,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      }),
    })
    if (res.ok) return res.json()
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * attempt)
      continue
    }
    throw new Error(`list(${prefix}) -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  throw new Error(`list(${prefix}) 重试 5 次仍失败`)
}

/** 深度优先遍历全桶 */
async function walk(prefix) {
  const files = []
  const items = await listDir(prefix)
  for (const it of items) {
    const child = prefix ? `${prefix}/${it.name}` : it.name
    // 文件夹判据： Supabase 返回 id/metadata 均为 null
    if (it.metadata === null || it.metadata === undefined) {
      files.push(...(await walk(child)))
    } else {
      files.push({ key: child, size: it.metadata?.size ?? null })
    }
  }
  return files
}

/** 下载单个对象；已存在且大小相符则跳过（支持断点续跑） */
async function download({ key, size }) {
  const out = path.join(DEST, key)
  if (fs.existsSync(out)) {
    const st = fs.statSync(out)
    if (st.size > 0 && (size == null || st.size === size)) return { key, status: 'skip', size: st.size }
  }
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const urlPath = key.split('/').map(encodeURIComponent).join('/')
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${SUPA_URL}/storage/v1/object/${BUCKET}/${urlPath}`, {
      headers: { Authorization: `Bearer ${SUPA_KEY}`, apikey: SUPA_KEY },
    })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      await fsp.writeFile(out, buf)
      return { key, status: 'ok', size: buf.length }
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * attempt)
      continue
    }
    return { key, status: 'fail', code: res.status, msg: (await res.text()).slice(0, 120) }
  }
  return { key, status: 'fail', code: -1, msg: '重试 5 次仍失败' }
}

async function main() {
  console.log(`[storage] 源站：${SUPA_URL}  桶：${BUCKET}`)
  console.log(`[storage] 目标：${DEST}`)
  const t0 = Date.now()

  const all = await walk('')
  const totalBytes = all.reduce((s, f) => s + (f.size || 0), 0)
  console.log(`[storage] 对象总数：${all.length}  总大小：${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  if (DRY) {
    console.log('[storage] --dry 模式，未下载。前 10 个对象：')
    all.slice(0, 10).forEach((f) => console.log('   ·', f.key, f.size))
    return
  }

  await fsp.mkdir(DEST, { recursive: true })

  let ok = 0
  let skip = 0
  let fail = 0
  let bytes = 0
  const failures = []
  for (let i = 0; i < all.length; i += CONC) {
    const batch = all.slice(i, i + CONC)
    const results = await Promise.all(batch.map(download))
    for (const r of results) {
      if (r.status === 'ok') {
        ok++
        bytes += r.size
      } else if (r.status === 'skip') {
        skip++
        bytes += r.size
      } else {
        fail++
        failures.push(r)
      }
    }
    const done = Math.min(i + CONC, all.length)
    process.stdout.write(`\r[storage] 进度 ${done}/${all.length}  ok=${ok} skip=${skip} fail=${fail}  已写入 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  }
  console.log('')
  if (failures.length) {
    console.log('[storage] ✗ 失败明细（前 20）：')
    failures.slice(0, 20).forEach((f) => console.log(`   · ${f.key} → ${f.code} ${f.msg || ''}`))
  }
  console.log(`[storage] 完成：ok=${ok} skip=${skip} fail=${fail}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('[storage] ✗ 异常：', e.message)
  process.exit(1)
})
