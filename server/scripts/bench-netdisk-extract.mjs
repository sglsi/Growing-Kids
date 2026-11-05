#!/usr/bin/env node
/**
 * 【只读基准测试】网盘 PDF/DOCX 正文抽取的耗时与可抽率实测。
 *
 * 目的：为「B 方案（离线预抽正文建全文索引）可行性与成本测算」提供真实数字，
 *      不写任何业务数据、不改 text_content / text_status。
 *
 * 用法（在 /opt/gk/server 下）：
 *   sudo -n -u gk node /tmp/bench-netdisk-extract.mjs [样本数] [体积上限字节]
 *
 * 输出：逐份 下载耗时 / 抽取耗时 / 页数 / 正文字数，末尾给汇总分位数。
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import dotenv from 'dotenv'

const N = Number(process.argv[2] || 12)
const MAX_BYTES = Number(process.argv[3] || 1048576)
const MIN_BYTES = Number(process.argv[4] || 1)
const ONLY_EXT = (process.argv[5] || '').trim()

function databaseUrl() {
  const line = fs
    .readFileSync(path.resolve(process.cwd(), '.env.migrate'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) throw new Error('.env.migrate 里没有 DATABASE_URL')
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))])
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
  dotenv.config({ path: path.resolve(process.cwd(), '.env.secrets') })

  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()

  const { rows: users } = await client.query(
    `select user_id, count(*)::int n from netdisk_files
     where is_dir = false and ext in ('pdf','docx')
     group by 1 order by 2 desc limit 1`,
  )
  if (!users.length) throw new Error('索引里没有 pdf/docx')
  const userId = users[0].user_id
  console.log(`采样用户 ${userId}（该用户 pdf/docx ${users[0].n} 份），体积区间 ${MIN_BYTES}~${MAX_BYTES} 字节\n`)

  const { rows: samples } = await client.query(
    `select fs_id, name, ext, size_bytes from netdisk_files
     where user_id = $1 and is_dir = false and ext = any($5::text[])
       and size_bytes >= $2 and size_bytes <= $3
     order by random() limit $4`,
    [userId, MIN_BYTES, MAX_BYTES, N, ONLY_EXT ? [ONLY_EXT] : ['pdf','docx']],
  )
  await client.end()
  if (!samples.length) throw new Error('没抽到样本（体积上限可能太小）')

  // ⚠️ 用 cwd 拼绝对路径：本脚本放在 /tmp 下跑，相对 '../dist' 会解析到 /dist（错）
  const { pathToFileURL } = await import('node:url')
  const dist = (p) => pathToFileURL(path.resolve(process.cwd(), 'dist', p)).href
  const { BaiduNetdiskService } = await import(dist('storage/baidu-netdisk.service.js'))
  const { extractDocContent } = await import(dist('ocr/pdf-tool.js'))
  const nd = new BaiduNetdiskService()
  if (!nd.enabled()) throw new Error('网盘未启用（缺 BAIDU_APP_KEY / BAIDU_SECRET_KEY）')

  const dl = []
  const ex = []
  const pages = []
  const chars = []
  let okCount = 0
  let emptyCount = 0
  let failCount = 0

  for (const s of samples) {
    const t0 = Date.now()
    let buf = null
    try {
      buf = await nd.downloadByFsId(s.fs_id)
    } catch (e) {
      console.log(`  ✗ 下载异常 ${s.name}: ${e.message}`)
    }
    const dlMs = Date.now() - t0
    if (!buf || !buf.length) {
      failCount++
      console.log(`  ✗ 下载失败 ${s.name}`)
      continue
    }
    dl.push(dlMs)

    const t1 = Date.now()
    const out = await extractDocContent({
      kind: s.ext === 'pdf' ? 'pdf' : 'docx',
      content: buf,
      textOnly: true,
      maxPages: 200,
      timeoutMs: 60_000,
    })
    const exMs = Date.now() - t1
    ex.push(exMs)

    if (!out.ok || !out.data) {
      failCount++
      console.log(`  ✗ 抽取失败(${out.reason}) ${s.name}`)
      continue
    }
    const nPages = out.data.pages?.length || 0
    const text = (out.data.pages || []).map((p) => p.text).filter(Boolean).join('\n')
    const nChars = text.replace(/\s+/g, '').length
    pages.push(nPages)
    chars.push(nChars)
    if (nChars >= 50) okCount++
    else emptyCount++
    console.log(
      `  ${nChars >= 50 ? '✓' : '·'} ${s.ext} ${(s.size_bytes / 1024).toFixed(0)}KB ` +
        `${nPages}页 ${nChars}字 | 下载 ${dlMs}ms 抽取 ${exMs}ms | ${s.name.slice(0, 44)}`,
    )
  }

  console.log('\n================ 汇总 ================')
  console.log(`样本 ${samples.length} 份：有文字层 ${okCount} / 无文字层(扫描版) ${emptyCount} / 失败 ${failCount}`)
  if (okCount + emptyCount > 0) {
    console.log(`可抽率（有文字层占比）：${((okCount / (okCount + emptyCount)) * 100).toFixed(1)}%`)
  }
  if (dl.length) {
    console.log(`下载耗时 ms：p50=${pct(dl, 50)} p90=${pct(dl, 90)} max=${Math.max(...dl)} 合计=${dl.reduce((a, b) => a + b, 0)}`)
  }
  if (ex.length) {
    console.log(`抽取耗时 ms：p50=${pct(ex, 50)} p90=${pct(ex, 90)} max=${Math.max(...ex)} 合计=${ex.reduce((a, b) => a + b, 0)}`)
    console.log(`单份总耗时 ms：p50=${pct(dl.map((d, i) => d + (ex[i] || 0)), 50)} p90=${pct(dl.map((d, i) => d + (ex[i] || 0)), 90)}`)
  }
  if (pages.length) {
    console.log(`页数：p50=${pct(pages, 50)} p90=${pct(pages, 90)} max=${Math.max(...pages)} 总页数=${pages.reduce((a, b) => a + b, 0)}`)
    console.log(`正文字数：p50=${pct(chars, 50)} p90=${pct(chars, 90)} 总字数=${chars.reduce((a, b) => a + b, 0)}`)
    if (pages.reduce((a, b) => a + b, 0) > 0) {
      const perPage = ex.reduce((a, b) => a + b, 0) / pages.reduce((a, b) => a + b, 0)
      console.log(`单页抽取耗时：${perPage.toFixed(1)} ms/页`)
    }
  }
  console.log('======================================')
  console.log('（只读测试：未写 text_content / text_status）')
}

main().catch((e) => {
  console.error('基准失败：', e)
  process.exit(1)
})
