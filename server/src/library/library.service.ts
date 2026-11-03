import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import { BaiduNetdiskService } from '../storage/baidu-netdisk.service'
import { extractDocContent } from '../ocr/pdf-tool'
import type { LibraryDoc, CreateLibraryDocDto, LibraryQuery } from './library.types'

const TABLE = 'library_docs'

/** 能抽文字层的类型（老 .doc 二进制 pdf_tool 解不了，只按文件名检索） */
const TEXT_EXTS = new Set(['pdf', 'docx', 'txt', 'md'])
/** 单文件抽取上限：再大就不值得为一次检索解包 */
const MAX_TEXT_BYTES = Number(process.env.LIBRARY_TEXT_MAX_BYTES ?? 40 * 1024 * 1024)
/** 正文截断长度（够做关键词匹配即可，不当正文库用） */
const MAX_TEXT_CHARS = Number(process.env.LIBRARY_TEXT_MAX_CHARS ?? 200_000)

/** 网盘文件名非法字符（百度网盘不接受，且 Windows 端同步时也会炸） */
function sanitizeFileName(name: string): string {
  const base = (name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim()
  return (base || '未命名资料').slice(0, 100)
}

/** 资料库：外部文档（上传的 PDF/Word/TXT 等） */
@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name)

  constructor(
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
    private readonly netdisk: BaiduNetdiskService,
  ) {}

  async list(userId: string, query: LibraryQuery): Promise<{ list: LibraryDoc[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 20)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let q = client
      .from(TABLE)
      .select('*, subjects:subject_id(id, name, color)', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)

    if (query.subject_id) q = q.eq('subject_id', query.subject_id)    // 关键词同时搜文件名与正文（思傅 2026-11-03：资料库也要能搜内容）。
    // 正文是入库时抽好的 text_content，命中后前端照常打开原文件。
    if (query.keyword) {
      // PostgREST 的 or 表达式里逗号/括号/百分号是语法字符，必须剔干净
      const kw = query.keyword.replace(/[%,()]/g, '').trim()
      if (kw) q = q.or(`name.ilike.%${kw}%,text_content.ilike.%${kw}%`)
    }
    q = q.order('created_at', { ascending: false }).range(from, to)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { list: (data || []) as unknown as LibraryDoc[], total: count || 0, page, page_size: pageSize }
  }

  /**
   * #121：按内容指纹查该用户**已存在**的文档条目（同文件去重）。
   * 语义与 timeline.findByHash 一致，见其注释；查重失败同样 best-effort 退化为「没存过」。
   */
  async findByHash(
    userId: string,
    fileHash: string,
  ): Promise<{ item: LibraryDoc; inTrash: boolean } | null> {
    if (!fileHash) return null
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .select('*, subjects:subject_id(id, name, color)')
      .eq('user_id', userId)
      .eq('file_hash', fileHash)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error('[library] 按指纹查重失败（按未存过处理）:', fileHash.slice(0, 12), error.message)
      return null
    }
    if (!data) return null
    const raw = data as unknown as { deleted_at?: string | null }
    return { item: data as unknown as LibraryDoc, inTrash: !!raw.deleted_at }
  }

  /** #121：恢复回收站里的文档条目（deleted_at → null），语义同 timeline.restore */
  async restore(userId: string, id: string): Promise<LibraryDoc | null> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId) // ⚠️ RLS 全注释 ⇒ 必须显式带 user_id，防越权恢复他人条目
      .select('*, subjects:subject_id(id, name, color)')
      .maybeSingle()
    if (error) {
      console.error('[library] 恢复失败:', id, error.message)
      return null
    }
    return (data as unknown as LibraryDoc) || null
  }

  async create(userId: string, dto: CreateLibraryDocDto): Promise<LibraryDoc> {
    if (!dto.file_key) throw new BadRequestException('文档缺少 file_key')
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .insert({
        user_id: userId,
        name: dto.name || '未命名文档',
        file_key: dto.file_key,
        thumb_key: dto.thumb_key ?? null,
        subject_id: dto.subject_id ?? null,
        mime_type: dto.mime_type ?? '',
        width: dto.width ?? null,
        height: dto.height ?? null,
        size_bytes: dto.size_bytes ?? 0,
        file_hash: dto.file_hash ?? null,
        source: dto.source ?? 'upload',
        tags: dto.tags ?? [],
      })
      .select('*, subjects:subject_id(id, name, color)')
      .single()
    if (error) throw new Error(error.message)
    const doc = data as unknown as LibraryDoc

    // 网盘归档（思傅 2026-10-24：资料库归到百度网盘 /学生/GrowingKids资料库）
    // best-effort + 不 await：网盘慢/不可用绝不拖慢「保存资料」的响应，更不许让保存失败。
    void this.syncToNetdisk(userId, doc.id, dto.file_key, doc.name)

    // 正文抽取（思傅 2026-11-03：资料库要能搜内容，不能只按文件名搜）
    // 同样 best-effort + 不 await：抽正文可能要几秒，不该让「保存」等它。
    // 抽不到就保持 pending/none，列表仍可按文件名搜到这条。
    void this.indexText(userId, doc.id, dto.file_key, doc.name, doc.mime_type ?? undefined)

    return doc
  }

  /**
   * 抽正文并落 `text_content`（best-effort，失败绝不影响入库）。
   *
   * 口径与网盘侧一致（`netdisk-search` 的 ensureText）：
   *   · 只抽文字层（`textOnly`），扫描页不渲染——那是 OCR 的活，26s/页 不适合放在入库路径；
   *   · 全篇几乎没字 ⇒ 标 `none`（扫描版），列表不把它当成「空文档」；
   *   · 类型不支持 ⇒ `skipped`，超大 ⇒ `too_big`，都不再重试。
   */
  private async indexText(
    userId: string,
    id: string,
    fileKey: string,
    name: string,
    mimeType?: string,
  ): Promise<void> {
    const client = getSupabaseClient()
    const ext = ((name.match(/\.([A-Za-z0-9]{1,8})$/) || [, ''])[1] || '').toLowerCase()
    const update = (patch: Record<string, unknown>) =>
      client
        .from(TABLE)
        .update({ ...patch, text_updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('id', id)

    try {
      if (!TEXT_EXTS.has(ext)) {
        await update({ text_status: 'skipped', text_content: null })
        return
      }
      const buf = await this.storageService.readObject(fileKey)
      if (!buf || buf.length === 0) {
        await update({ text_status: 'none', text_content: null })
        return
      }
      if (buf.length > MAX_TEXT_BYTES) {
        await update({ text_status: 'too_big', text_content: null })
        return
      }

      let text = ''
      if (ext === 'txt' || ext === 'md') {
        text = buf.toString('utf8')
      } else {
        const out = await extractDocContent({
          kind: ext === 'pdf' ? 'pdf' : 'docx',
          content: buf,
          textOnly: true,
          maxPages: 200,
          timeoutMs: 60_000,
        })
        if (!out.ok || !out.data) {
          this.logger.warn(`[library] 抽正文失败（${out.reason}）：${name} ${out.detail || ''}`)
          await update({ text_status: 'none', text_content: null })
          return
        }
        text = out.data.pages.map((p) => p.text).filter(Boolean).join('\n')
      }

      const meaningful = text.replace(/\s+/g, '').length
      if (meaningful < 20) {
        // 扫描版 PDF / 空文档：记 none，避免以后反复抽
        await update({ text_status: 'none', text_content: null })
        return
      }
      await update({ text_status: 'ok', text_content: text.slice(0, MAX_TEXT_CHARS) })
    } catch (e) {
      // best-effort 但不许静默：抽不到正文要留痕，否则「搜不到」永远查不出原因
      this.logger.warn(`[library] 抽正文异常：${name} — ${e instanceof Error ? e.message : e}`)
      try {
        await update({ text_status: 'none', text_content: null })
      } catch { /* 状态回写失败不影响入库结果 */ }
    }
  }

  /**
   * 补抽历史资料的正文（`POST /api/library/index-text`）。
   *
   * 存在的理由：`indexText` 只在入库时跑一次，迁移 0023 之前的存量文档
   * `text_status` 全是默认值 `pending`，不补就永远搜不到内容。
   * 也用于「抽失败想重来」——`force=true` 连 ok/none 一起重抽。
   *
   * 一次只处理 `limit` 条（默认 50），避免一个请求跑十几分钟；
   * 返回剩余条数，前端/运维按需再调。
   */
  async reindexText(
    userId: string,
    opts: { force?: boolean; limit?: number } = {},
  ): Promise<{ processed: number; ok: number; none: number; skipped: number; remaining: number }> {
    const client = getSupabaseClient()
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
    let q = client
      .from(TABLE)
      .select('id, name, file_key, mime_type')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit)
    // force 时不看状态；否则只补「还没抽过」的
    if (!opts.force) q = q.eq('text_status', 'pending')
    const { data, error } = await q
    if (error) throw new Error(error.message)

    const rows = (data || []) as { id: string; name: string; file_key: string; mime_type: string | null }[]
    let ok = 0
    let none = 0
    let skipped = 0
    for (const r of rows) {
      const before = await this.textStatusOf(userId, r.id)
      await this.indexText(userId, r.id, r.file_key, r.name, r.mime_type ?? undefined)
      const after = await this.textStatusOf(userId, r.id)
      if (after === 'ok') ok++
      else if (after === 'skipped') skipped++
      else if (after === before && before === 'pending') none++
      else none++
    }

    const { count } = await client
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .eq('text_status', 'pending')

    return { processed: rows.length, ok, none, skipped, remaining: count ?? 0 }
  }

  private async textStatusOf(userId: string, id: string): Promise<string> {
    const { data } = await getSupabaseClient()
      .from(TABLE)
      .select('text_status')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle()
    return String((data as { text_status?: string } | null)?.text_status || '')
  }

  /**
   * 把资料库文件同步一份到百度网盘（异步、best-effort）。
   *
   * ⚠️ 只写副本：主存储仍是本地/Supabase（file_key 不变），网盘只做归档，
   *    原因见 migrations/0015_library_netdisk_path.sql 的表注释（网盘读取要换 dlink、限速、8h 有效期）。
   * ⚠️ 任何一步失败都必须 console.error 打全错（best-effort 的 catch 静默吞错是本项目反复踩过的坑）。
   */
  private async syncToNetdisk(
    userId: string,
    id: string,
    fileKey: string,
    name: string,
  ): Promise<void> {
    try {
      if ((process.env.LIBRARY_NETDISK_SYNC || 'false') !== 'true') return
      if (!this.netdisk.enabled()) {
        this.logger.debug(`[library] 网盘同步未启用（缺 ${this.netdisk.missingKeys().join(' / ')}）`)
        return
      }
      if (!fileKey) return
      const buf = await this.storageService.readObject(fileKey)
      if (!buf || buf.length === 0) {
        console.error('[library] 网盘同步跳过：读取源对象为空', { id, fileKey })
        return
      }
      const path = await this.netdisk.upload(sanitizeFileName(name), buf)
      const { error } = await getSupabaseClient()
        .from(TABLE)
        .update({ netdisk_path: path })
        .eq('user_id', userId)
        .eq('id', id)
      if (error) throw new Error(error.message)
      this.logger.log(`[library] 已归档到网盘：${path}`)
    } catch (e) {
      console.error('[library] 网盘归档失败（不影响资料库本身）', { id, fileKey }, e)
    }
  }

  /**
   * 更新资料库条目（重命名 + 归属学科，思傅 2026-10-24）。
   * 同样 user_id 隔离 + 行数校验；subject_id 传 null/'' = 未分类，
   * 传 id 时校验该学科存在且属于本人（防越权绑定到别人学科）。
   */
  async update(
    userId: string,
    id: string,
    patch: { name?: string; subject_id?: string | null },
  ): Promise<{ id: string; name: string; subject_id: string | null }> {
    const client = getSupabaseClient()
    const upd: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const trimmed = (patch.name || '').trim()
      if (!trimmed) throw new BadRequestException('名称不能为空')
      if (trimmed.length > 100) throw new BadRequestException('名称过长（最多 100 个字符）')
      upd.name = trimmed
    }
    if (patch.subject_id !== undefined) {
      const sid = patch.subject_id === '' ? null : patch.subject_id
      if (sid !== null) {
        const { data: subj, error: se } = await client
          .from('subjects')
          .select('id')
          .eq('user_id', userId)
          .eq('id', sid)
          .maybeSingle()
        if (se) throw new Error(se.message)
        if (!subj) throw new BadRequestException('学科不存在或不属于本人')
      }
      upd.subject_id = sid
    }
    if (Object.keys(upd).length === 0) throw new BadRequestException('没有需要更新的字段')

    const { data, error } = await client
      .from(TABLE)
      .update(upd)
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id, name, subject_id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文档不存在')
    return data as { id: string; name: string; subject_id: string | null }
  }

  /** 重命名（兼容旧调用；等价于 update({ name })） */
  async rename(userId: string, id: string, name: string): Promise<{ id: string; name: string }> {
    const r = await this.update(userId, id, { name })
    return { id: r.id, name: r.name }
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文档不存在')
    return { id }
  }

  /** 批量软删 + 释放 blob 引用（策略 4/5；先查 hash 再软删，最后释放） */
  async removeMany(userId: string, ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 }
    const client = getSupabaseClient()

    const { data: pending } = await client
      .from(TABLE)
      .select('id, file_hash, netdisk_path')
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
    const hashes = Array.from(
      new Set(((pending || []) as { file_hash: string | null }[]).map((r) => r.file_hash).filter(Boolean) as string[]),
    )

    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', ids)
      .is('deleted_at', null)
      .select('id')
    if (error) throw new Error(error.message)

    for (const h of hashes) {
      await this.blobService.release(h).catch((e) =>
        console.warn('[library] 释放 blob 引用失败', h, e),
      )
    }

    // 网盘副本联动删除（默认关：误删代价比残留大，需显式开 LIBRARY_NETDISK_DELETE_ON_REMOVE=true）
    if ((process.env.LIBRARY_NETDISK_DELETE_ON_REMOVE || 'false') === 'true') {
      const paths = ((pending || []) as { netdisk_path?: string | null }[])
        .map((r) => r.netdisk_path)
        .filter(Boolean) as string[]
      for (const p of paths) {
        await this.netdisk.remove(p).catch((e) => console.error('[library] 删除网盘副本失败', p, e))
      }
    }
    return { removed: (data || []).length }
  }

  /** 给资料库条目补签名 URL（列表用）；缩略图优先，无则回落原图 */
  async withUrls(docs: LibraryDoc[]): Promise<LibraryDoc[]> {
    return Promise.all(
      docs.map(async (d) => {
        const enriched: LibraryDoc = { ...d }
        if (d.file_key) enriched.url = await this.storageService.getPublicUrl(d.file_key)
        if (d.thumb_key) enriched.thumb_url = await this.storageService.getPublicUrl(d.thumb_key)
        return enriched
      }),
    )
  }
}
