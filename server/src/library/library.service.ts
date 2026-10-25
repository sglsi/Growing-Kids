import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'
import { BaiduNetdiskService } from '../storage/baidu-netdisk.service'
import type { LibraryDoc, CreateLibraryDocDto, LibraryQuery } from './library.types'

const TABLE = 'library_docs'

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

    if (query.subject_id) q = q.eq('subject_id', query.subject_id)
    if (query.keyword) q = q.ilike('name', `%${query.keyword}%`)
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

    return doc
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
