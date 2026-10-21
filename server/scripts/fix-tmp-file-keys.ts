/**
 * 一次性修复脚本：清理 timeline_items 里两类「坏图引用」（手动触发，不进定时任务）
 *
 * 背景（思傅 2026-10-22 真机反馈「列表是老图、详情是新图」的实测数据）：
 *   1) `file_key` 落在 `tmp/...` —— 这是**中间态**对象，ref_count=0，24h 后会被
 *      maintenance 的孤儿 GC **真删**，用户会发现图片凭空消失。老前端换图时用
 *      purpose='temp' 上传，正是这样把 tmp key 写进了 file_key。
 *      ⇒ 修复：读回字节重新 ingest，落成 `blobs/<hash前2>/<hash>/display.webp` 常驻资产。
 *   2) `thumb_key` 与主图内容哈希不一致 —— 换主图时没同步换缩略图，
 *      列表渲染 `thumb_url || url` ⇒ 一直显示旧图。
 *      ⇒ 修复：置空（读路径会自动回退用主图）。
 *
 * 用法：
 *   cd server
 *   npx ts-node scripts/fix-tmp-file-keys.ts              # 干跑，只打印不改数据
 *   npx ts-node scripts/fix-tmp-file-keys.ts --apply      # 真实写入
 *   npx ts-node scripts/fix-tmp-file-keys.ts --limit 100  # 调整扫描条数（默认 200）
 *
 * 安全设计：
 *   - **默认干跑**，必须显式 --apply 才写库；
 *   - 幂等：修完的记录 file_key 已是 blobs/ 开头，再次扫描自然命中不到；
 *   - 单条失败不影响整批（try/catch 记日志继续）。
 */

import { getSupabaseClient, loadEnv } from '../src/storage/database/supabase-client'
import { StorageService } from '../src/storage/storage.service'
import { BlobService } from '../src/storage/blob.service'
import { IngestService } from '../src/storage/ingest.service'

/** 取对象 key 里的内容哈希段：blobs/ab/<hash>/display.webp → <hash> */
function hashOfKey(key?: string | null): string {
  if (!key) return ''
  const m = /^blobs\/[0-9a-f]{2}\/([^/]+)\//i.exec(key)
  return m ? m[1] : ''
}

/** 缩略图与主图是否同源（内嵌同一内容哈希） */
function isThumbConsistent(fileKey?: string | null, thumbKey?: string | null): boolean {
  const fh = hashOfKey(fileKey)
  if (!fh) return false
  return hashOfKey(thumbKey) === fh
}

function mimeFromKey(key: string): string {
  const ext = (key.split('.').pop() || '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return 'image/webp'
}

async function main() {
  loadEnv()
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const limitIdx = argv.indexOf('--limit')
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1] || 200) : 200

  const storage = new StorageService()
  const blobs = new BlobService()
  const ingest = new IngestService(storage, blobs)
  const client = getSupabaseClient()

  console.log(`[fix-tmp] 开始：limit=${limit} ${apply ? '【真实写入】' : '【DRY-RUN 干跑，加 --apply 才写库】'}`)

  const { data, error } = await client
    .from('timeline_items')
    .select('id, kind, file_key, thumb_key, created_at')
    .is('deleted_at', null)
    .not('file_key', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[fix-tmp] 查询失败', error.message)
    process.exit(1)
  }

  const rows = (data || []) as {
    id: string; kind: string; file_key: string | null; thumb_key: string | null; created_at: string
  }[]

  let tmpFixed = 0
  let thumbFixed = 0
  let skipped = 0
  let failed = 0

  for (const row of rows) {
    const patch: Record<string, unknown> = {}
    const fileKey = row.file_key || ''

    // ① 临时对象固化
    if (fileKey.startsWith('tmp/')) {
      try {
        const buf = await storage.readObject(fileKey)
        if (buf && buf.length) {
          const res = await ingest.ingest(buf, mimeFromKey(fileKey))
          if (res?.key) {
            patch.file_key = res.key
            patch.thumb_key = res.thumbKey || res.key
            console.log(`[fix-tmp] 固化 ${row.id}\n  ${fileKey}\n  → ${res.key} / thumb=${patch.thumb_key}`)
            tmpFixed += 1
          } else {
            console.warn(`[fix-tmp] ingest 无返回 key，跳过 ${row.id}`)
            failed += 1
          }
        } else {
          console.warn(`[fix-tmp] 读不到对象字节（可能已被回收），跳过 ${row.id} ${fileKey}`)
          failed += 1
        }
      } catch (e) {
        console.warn(`[fix-tmp] 固化失败，跳过 ${row.id}: ${e}`)
        failed += 1
      }
    }

    // ② 过期缩略图清理：与主图不同源一律置空（读路径会回退用主图）
    const finalFileKey = (patch.file_key as string) || fileKey
    if (row.thumb_key && !isThumbConsistent(finalFileKey, row.thumb_key)) {
      if (!patch.thumb_key) {
        patch.thumb_key = null
        console.log(`[fix-tmp] 过期缩略图置空 ${row.id}\n  file=${finalFileKey}\n  thumb=${row.thumb_key}`)
        thumbFixed += 1
      }
    }

    if (!Object.keys(patch).length) {
      skipped += 1
      continue
    }
    if (!apply) continue

    patch.updated_at = new Date().toISOString()
    const { error: upErr } = await client
      .from('timeline_items')
      .update(patch)
      .eq('id', row.id)
    if (upErr) {
      console.error(`[fix-tmp] 写库失败 ${row.id}: ${upErr.message}`)
      failed += 1
    }
  }

  console.log(
    `[fix-tmp] 完成：临时对象固化 ${tmpFixed} 条，过期缩略图清理 ${thumbFixed} 条，` +
      `无需处理 ${skipped} 条，失败 ${failed} 条${apply ? '' : '（干跑未写库）'}`,
  )
}

main().catch((e) => {
  console.error('[fix-tmp] 异常终止', e)
  process.exit(1)
})
