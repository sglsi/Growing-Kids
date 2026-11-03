#!/usr/bin/env node
/**
 * 百度网盘学习资料索引：把 /学生 下的文件清单落进本库 netdisk_files。
 *
 * 背景（思傅 2026-11-03）：
 *   「能不能将网盘中的内容在本程序中建一个索引，搜索只在本库中进行，
 *     具体要读取内容了可进网盘读取。」
 *   上一版是每次点「资料库搜题」都实时搜网盘：3~7s，且网盘返回的候选子集不稳定
 *   ⇒ 同一道题连搜两次排序会变。改成「先建索引、搜索只查本库」之后：
 *   · 搜索是纯 SQL，毫秒级、结果稳定、网盘临时抽风/断网都还能搜
 *   · 只有命中候选需要看正文时，才按 fs_id 去网盘下载
 *
 * 注意这里**只索引文件名/路径/大小**，不下载任何文件：
 *   /学生 有上千份教辅、合计 250GB+，全量下载抽正文不现实（见 0022 迁移注释）。
 *   正文在搜索命中后按需抽取，抽过的落 text_content 缓存。
 *
 * 用法（在 server/ 下）：
 *   node scripts/netdisk-index.mjs --user <uuid>              # 干跑：只遍历+统计，不写库
 *   node scripts/netdisk-index.mjs --user <uuid> --apply      # 真写
 *
 * 可选参数：
 *   --root /学生          覆盖索引根目录（默认取 NETDISK_SEARCH_ROOT 或 /学生）
 *   --max-requests 20000  请求数上限（防止跑飞）
 *   --budget-ms 900000    时间预算（默认 15 分钟）
 *   --concurrency 4       一次并发列几个目录（默认 4，上限 6；串行会慢到走不完）
 *   --gap-ms 60           每批之间的间隔（限流，默认 60ms）
 *   --full-clean          遍历完整时，把本轮没见到的旧记录删掉（对应网盘已删除的文件）
 *
 * 安全：
 *   · 默认干跑，必须 --apply 才写库；
 *   · 只写 netdisk_files，不碰其它表；
 *   · 遍历被预算打断（complete=false）时**不做**删除，避免把「没走到」当成「已删除」。
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import dotenv from 'dotenv'

const APPLY = process.argv.includes('--apply')
const FULL_CLEAN = process.argv.includes('--full-clean')
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const USER_ID = arg('--user')
const ROOT = arg('--root') || (process.env.NETDISK_SEARCH_ROOT || '/学生')
const MAX_REQUESTS = Number(arg('--max-requests', '5000'))
const BUDGET_MS = Number(arg('--budget-ms', '900000'))
const GAP_MS = Number(arg('--gap-ms', '60'))
const PAGE = 1000

if (!USER_ID) {
  console.error('缺少 --user <uuid>：netdisk_files 按 user_id 隔离，必须指明索引归属')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 .env.migrate 读 DATABASE_URL（低权 migrator 即可，只写索引表） */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.resolve(process.cwd(), '.env.migrate')
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}，请把 DATABASE_URL 放进 server/.env.migrate`)
  const line = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

const extOf = (name) => (name.match(/\.([A-Za-z0-9]{1,8})$/) || [, ''])[1].toLowerCase()

async function main() {
  // 凭证在 .env.secrets；.env 里是非敏感项（与 main.ts 的加载顺序一致：非敏感优先）
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })

  const { BaiduNetdiskService } = await import('../dist/storage/baidu-netdisk.service.js')
  const netdisk = new BaiduNetdiskService()
  if (!netdisk.enabled()) {
    console.error(`网盘未启用（缺 ${netdisk.missingKeys().join(' / ')}），请检查 server/.env.secrets`)
    process.exit(2)
  }

  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()

  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  let requests = 0
  let dirs = 0
  let files = 0
  let upserted = 0
  let complete = true
  let stopReason = ''

  const queue = [ROOT.replace(/\/+$/, '') || '/']
  const seenDirs = new Set()
  let pending = []

  /** 落库（批量 upsert）。dry-run 时只累计 */
  const flush = async () => {
    if (pending.length === 0) return
    const rows = pending
    pending = []
    if (!APPLY) return
    // 分批 200，单批失败只告警不中断（网盘清单比一次写入更重要）
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      const { error } = await client.query(
        `insert into netdisk_files
           (user_id, fs_id, path, dir_path, name, ext, is_dir, size_bytes, mtime, last_seen_at, synced_at)
         values ${chunk.map((_, k) => `($${k * 8 + 1},$${k * 8 + 2},$${k * 8 + 3},$${k * 8 + 4},$${k * 8 + 5},$${k * 8 + 6},false,$${k * 8 + 7},$${k * 8 + 8}::timestamptz,now(),now())`).join(',')}
         on conflict (user_id, fs_id) do update set
           path = excluded.path,
           dir_path = excluded.dir_path,
           name = excluded.name,
           ext = excluded.ext,
           size_bytes = excluded.size_bytes,
           mtime = excluded.mtime,
           last_seen_at = now(),
           synced_at = now()`,
        chunk.flatMap((r) => [r.user_id, r.fs_id, r.path, r.dir_path, r.name, r.ext, r.size_bytes, r.mtime]),
      )
      if (error) throw new Error(`写入失败：${error.message}`)
      upserted += chunk.length
    }
  }

  // 一次并发列几个目录。
  // ⚠️ 串行实测 0.43s/目录，/学生 有 6000+ 个目录 ⇒ 30 分钟都走不完。
  //    4 并发把有效速率提到 ~9 QPS（百度网盘个人号的常见上限附近），别再往上加。
  const CONCURRENCY = Math.max(1, Math.min(6, Number(arg('--concurrency', '4'))))

  /** 列完一个目录（自动翻页），返回该目录下的原始条目 */
  const listDir = async (dir) => {
    const items = []
    for (let start = 0; ; start += PAGE) {
      if (requests >= MAX_REQUESTS) break
      requests++
      let page = []
      try {
        page = await netdisk.list(dir, PAGE, start)
      } catch (e) {
        console.warn(`  ⚠️ 列目录失败，跳过：${dir} — ${e instanceof Error ? e.message : e}`)
        return items
      }
      items.push(...page)
      if (page.length < PAGE) break
    }
    return items
  }

  try {
    for (;;) {
      if (Date.now() - startedAt > BUDGET_MS) {
        complete = false
        stopReason = `超出时间预算 ${BUDGET_MS}ms（队列还剩 ${queue.length} 个目录）`
        break
      }
      if (requests >= MAX_REQUESTS) {
        complete = false
        stopReason = `超出请求上限 ${MAX_REQUESTS}（队列还剩 ${queue.length} 个目录）`
        break
      }
      if (queue.length === 0) break

      // 取一批目录并发列
      const batch = []
      while (batch.length < CONCURRENCY && queue.length > 0) {
        const d = queue.shift()
        if (!d || seenDirs.has(d)) continue
        seenDirs.add(d)
        batch.push(d)
      }
      if (batch.length === 0) break

      const results = await Promise.all(batch.map((d) => listDir(d)))
      dirs += batch.length

      for (let i = 0; i < batch.length; i++) {
        const dir = batch[i]
        for (const it of results[i]) {
          const name = String(it.server_filename || '')
          const abs = String(it.path || `${dir}/${name}`)
          if (Number(it.isdir) === 1) {
            queue.push(abs)
            continue
          }
          files++
          pending.push({
            user_id: USER_ID,
            fs_id: Number(it.fs_id),
            path: abs,
            dir_path: dir,
            name,
            ext: extOf(name),
            size_bytes: Number(it.size) || 0,
            mtime: it.server_mtime ? new Date(Number(it.server_mtime) * 1000).toISOString() : null,
          })
        }
      }
      if (pending.length >= 200) await flush()

      if (GAP_MS > 0) await sleep(GAP_MS)
      if (dirs % 40 < CONCURRENCY) {
        console.log(`  … 已列 ${dirs} 个目录 / 见 ${files} 个文件 / ${requests} 次请求 / 队列 ${queue.length}`)
      }
    }
    await flush()

    // 完整遍历才清理：把本轮没见到的旧记录删掉（对应网盘侧已删除的文件）
    let removed = 0
    if (APPLY && complete && FULL_CLEAN) {
      const { rowCount } = await client.query(
        `delete from netdisk_files
          where user_id = $1 and is_dir = false and last_seen_at < $2`,
        [USER_ID, startedIso],
      )
      removed = rowCount || 0
    }
  } finally {
    const tookMs = Date.now() - startedAt
    const { rows } = await client.query(
      `select count(*)::int as total,
              count(*) filter (where text_status = 'ok')::int as with_text,
              count(*) filter (where last_seen_at >= $2)::int as seen_now
         from netdisk_files where user_id = $1 and is_dir = false`,
      [USER_ID, startedIso],
    )
    const s = rows[0] || {}
    await client.end()

    console.log('\n================ 索引结果 ================')
    console.log(`模式        ${APPLY ? '真写' : '干跑（未写库）'}`)
    console.log(`根目录      ${ROOT}`)
    console.log(`遍历        ${dirs} 个目录 / 见到 ${files} 个文件 / ${requests} 次请求`)
    console.log(`写入        ${upserted} 行`)
    console.log(`耗时        ${(tookMs / 1000).toFixed(1)}s`)
    console.log(`完整性      ${complete ? '完整' : `未完成：${stopReason}`}`)
    console.log(`库内现状    共 ${s.total ?? 0} 个文件，其中本轮见到 ${s.seen_now ?? 0} 个，已抽正文 ${s.with_text ?? 0} 个`)
    console.log('==========================================')
    if (!complete) {
      console.log('\n⚠️ 未完整遍历 ⇒ 不删除任何旧记录（避免把「没走到」当成「已删除」）。')
      console.log('   可加大 --budget-ms / --max-requests 重跑，或调大 --gap-ms 之外的参数。')
    }
  }
}

main().catch((e) => {
  console.error('索引失败：', e)
  process.exit(1)
})
