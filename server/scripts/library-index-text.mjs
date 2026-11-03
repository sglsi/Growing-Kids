#!/usr/bin/env node
/**
 * 存量资料正文回填：把 `library_docs.text_status='pending'` 的条目抽一遍正文。
 *
 * 背景（思傅 2026-11-03）：
 *   「我们自己的资料库也可搜内容」—— 新入库的资料会自动抽正文（`library.indexText`），
 *   但迁移 0023 之前入库的存量文档 `text_status` 全是默认值 `pending`，
 *   不补就永远只能按文件名搜到。
 *
 * 为什么不用 HTTP 端点（`POST /api/library/index-text`）：
 *   那个端点要当前用户令牌。运维在服务器上补数据时手头不一定有令牌，
 *   而这里本来就能直连库与存储，直接用服务实例更直接。
 *
 * 用法（在 server/ 下，先 `npx nest build` 保证 dist 是最新的）：
 *   node scripts/library-index-text.mjs --user <uuid>            # 干跑：只统计待办
 *   node scripts/library-index-text.mjs --user <uuid> --apply    # 真抽
 *   node scripts/library-index-text.mjs --user <uuid> --apply --force   # 连已抽过的重抽
 *
 * 口径与 `library.service.ts` 的 indexText 完全一致（同一份实现，不重复代码）：
 *   PDF/DOCX/TXT/MD 抽文字层；扫描版记 none；类型不支持记 skipped；超 40MB 记 too_big。
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import dotenv from 'dotenv'

const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const USER_ID = arg('--user')
if (!USER_ID) {
  console.error('缺少 --user <uuid>')
  process.exit(2)
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const p = path.resolve(process.cwd(), '.env.migrate')
  if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`)
  const line = fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })

  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()

  const where = FORCE ? 'deleted_at is null' : "deleted_at is null and text_status = 'pending'"
  const { rows } = await client.query(
    `select text_status, count(*)::int n from library_docs where user_id = $1 and ${where} group by 1 order by 2 desc`,
    [USER_ID],
  )
  const total = rows.reduce((a, r) => a + r.n, 0)
  console.log('待处理：', rows.map((r) => `${r.text_status}=${r.n}`).join(' / ') || '无')
  if (total === 0) {
    await client.end()
    console.log('没有需要处理的资料。')
    return
  }
  if (!APPLY) {
    await client.end()
    console.log(`\n干跑结束（共 ${total} 条）。加 --apply 才会真抽。`)
    return
  }

  // ⚠️ 自检：没配 python 时抽取会整批失败。**只提醒、不中断**——
  //    服务侧已改成「环境类失败保持 pending」，不会把好文档洗成 none；
  //    但提醒一句能省一次白跑（2026-11-03 就吃过这个亏：没带 OCR_PYTHON，
  //    7 条全部失败且被记成 none，得靠 --force 才抽回来）。
  if (!process.env.OCR_PYTHON && !process.env.OCR_VENV_DIR) {
    console.warn(
      '⚠️ 未设置 OCR_PYTHON：抽取依赖 pdf_tool.py 找得到 python（pypdfium2）。\n' +
        '   若下面全是 no-python 失败，请用 OCR_PYTHON=/path/to/python 重跑。',
    )
  }

  const { LibraryService } = await import('../dist/library/library.service.js')
  const { StorageService } = await import('../dist/storage/storage.service.js')
  const { BlobService } = await import('../dist/storage/blob.service.js')
  const { BaiduNetdiskService } = await import('../dist/storage/baidu-netdisk.service.js')
  // 依赖手动构造：这些服务本身没有构造参数（都从 process.env 取配置）
  const svc = new LibraryService(new StorageService(), new BlobService(), new BaiduNetdiskService())

  let round = 0
  let processed = 0
  let ok = 0
  let none = 0
  let skipped = 0
  // 每轮最多 50 条（与端点默认一致），循环到没有 pending 为止
  for (;;) {
    round++
    const r = await svc.reindexText(USER_ID, { force: FORCE && round === 1, limit: 50 })
    processed += r.processed
    ok += r.ok
    none += r.none
    skipped += r.skipped
    console.log(`  第 ${round} 轮：处理 ${r.processed}（ok=${r.ok} none=${r.none} skipped=${r.skipped}），剩余 ${r.remaining}`)
    if (r.processed === 0) break
    if (!FORCE && r.remaining === 0) break
    // force 模式下 reindexText 不看状态，靠 processed 收敛；这里兜住无限循环
    if (round > 40) {
      console.log('  ⚠️ 轮次过多，提前结束')
      break
    }
  }

  const { rows: after } = await client.query(
    `select text_status, count(*)::int n from library_docs where user_id = $1 and deleted_at is null group by 1`,
    [USER_ID],
  )
  await client.end()

  console.log('\n================ 回填结果 ================')
  console.log(`处理 ${processed} 条：ok=${ok} none=${none} skipped=${skipped}`)
  console.log('库内现状：', after.map((r) => `${r.text_status}=${r.n}`).join(' / '))
  console.log('==========================================')
}

main().catch((e) => {
  console.error('回填失败：', e)
  process.exit(1)
})
