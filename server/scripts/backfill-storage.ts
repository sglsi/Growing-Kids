/**
 * 存量图片回填脚本（手动触发，不进定时任务）
 *
 * 作用：给「本功能上线前」的历史图片补上压缩图 / 缩略图 / 内容 hash / blob 登记。
 * 依据：复习本与项目设计.md §11.3 —— 新数据走新链路，存量需一次性回填。
 *
 * 用法：
 *   cd server-v4
 *   # 1) 先干跑看看有多少要处理（不改任何数据）
 *   npx ts-node scripts/backfill-storage.ts --dry-run --limit 20
 *   # 2) 确认无误后真跑（可分批，游标自动续跑）
 *   npx ts-node scripts/backfill-storage.ts --limit 200
 *   # 3) 继续扫下一批（脚本会打印下批游标）
 *   npx ts-node scripts/backfill-storage.ts --after <cursor> --limit 200
 *
 * 安全设计：
 *   - 默认 dry-run？**否** —— 必须显式 --dry-run 才是干跑；但每次只处理 --limit 条，
 *     且逐条打印，便于中断。
 *   - 单条失败不影响整批（try/catch 记日志继续），可反复执行（幂等：thumb_key 已存在则跳过）。
 *   - --limit 默认 50，防止一次性打出大量请求。
 */

import { getSupabaseClient } from '../src/storage/database/supabase-client'
import { StorageService } from '../src/storage/storage.service'
import { BlobService } from '../src/storage/blob.service'
import { IngestService } from '../src/storage/ingest.service'
import { loadEnv } from '../src/storage/database/supabase-client'

interface Args {
  dryRun: boolean
  limit: number
  after: string | null
  table: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    dryRun: argv.includes('--dry-run'),
    limit: Number(get('limit') || 50),
    after: get('after'),
    table: get('table') || 'timeline_items',
  }
}

/** 从对象存储 key 反查可下载 URL（走签名 URL） */
async function downloadByKey(storage: StorageService, key: string): Promise<Buffer | null> {
  try {
    const url = await storage.getPublicUrl(key)
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

async function main() {
  loadEnv()
  const args = parseArgs()

  const storage = new StorageService()
  const blobs = new BlobService()
  const ingest = new IngestService(storage, blobs)
  const client = getSupabaseClient()

  console.log(
    `[backfill] 开始：table=${args.table} limit=${args.limit} after=${args.after || '(从头)'} ` +
      `${args.dryRun ? '【DRY-RUN 不改数据】' : '【真实执行】'}`,
  )

  let q = client
    .from(args.table)
    .select('id, file_key, thumb_key, mime_type, file_hash, created_at')
    .is('deleted_at', null)
    .not('file_key', 'is', null)
    .order('id', { ascending: true })
    .limit(args.limit)

  if (args.after) q = q.gt('id', args.after)

  const { data, error } = await q
  if (error) {
    console.error('[backfill] 查询失败', error.message)
    process.exit(1)
  }

  const rows = (data || []) as {
    id: string; file_key: string; thumb_key: string | null;
    mime_type: string | null; file_hash: string | null; created_at: string
  }[]

  if (!rows.length) {
    console.log('[backfill] 没有需要处理的记录')
    return
  }

  let done = 0, skipped = 0, failed = 0, savedBytes = 0

  for (const row of rows) {
    // 幂等：已有缩略图 ⇒ 视为已处理过，跳过
    if (row.thumb_key) {
      skipped += 1
      continue
    }
    // 只处理图片；文档类不压缩
    const isImg = /^image\//.test(row.mime_type || '') || /\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(row.file_key)
    if (!isImg) {
      skipped += 1
      continue
    }

    try {
      const buf = await downloadByKey(storage, row.file_key)
      if (!buf) {
        console.warn(`[backfill] 跳过（下载失败）${row.id} key=${row.file_key}`)
        failed += 1
        continue
      }

      if (args.dryRun) {
        console.log(`[backfill][dry-run] 将处理 ${row.id} 原 ${(buf.length / 1024).toFixed(0)}KB key=${row.file_key}`)
        done += 1
        continue
      }

      // 走统一管线：压缩 + 去重（命中已有 blob 则不重复占空间）
      const ing = await ingest.ingest(buf, row.mime_type || 'image/jpeg')
      savedBytes += Math.max(0, buf.length - ing.sizeBytes)

      const { error: upErr } = await client
        .from(args.table)
        .update({
          thumb_key: ing.thumbKey,
          file_key: ing.key,
          mime_type: ing.mimeType,
          width: ing.width || null,
          height: ing.height || null,
          size_bytes: ing.sizeBytes,
          file_hash: ing.hash,
        })
        .eq('id', row.id)
      if (upErr) throw new Error(upErr.message)

      done += 1
      console.log(
        `[backfill] ✓ ${row.id} ${(buf.length / 1024).toFixed(0)}KB → ${(ing.sizeBytes / 1024).toFixed(0)}KB` +
          `${ing.deduped ? ' (去重命中)' : ''}`,
      )
    } catch (e) {
      failed += 1
      console.error(`[backfill] ✗ ${row.id} 失败: ${e instanceof Error ? e.message : e}`)
    }
  }

  const lastId = rows[rows.length - 1]?.id
  console.log(
    `\n[backfill] 本批完成：处理 ${done}，跳过 ${skipped}，失败 ${failed}` +
      (savedBytes > 0 ? `，节省 ${(savedBytes / 1048576).toFixed(2)} MB` : ''),
  )
  console.log(`[backfill] 下一批游标：--after ${lastId}`)
}

main().catch((e) => {
  console.error('[backfill] 未捕获异常', e)
  process.exit(1)
})
