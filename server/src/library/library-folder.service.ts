import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { UgcTextGuard } from '../security/ugc-text-guard.service'
import type { LibraryFolder } from './library.types'

const TABLE = 'library_folders'
const DOCS = 'library_docs'
/** 层级上限：防脏数据把「向上找祖先」变成死循环；正常家长目录远达不到 */
const MAX_DEPTH = 32

/** 文件夹名规范化：trim + 去 NUL + 长度上限（PG text 不收 U+0000，见红线） */
function normalizeName(raw: unknown): string {
  // PG text 不收 U+0000（红线）；与 public-library.ts / question-object-store.ts 同口径
  const name = String(Array.isArray(raw) ? raw[0] : raw ?? '').replace(/\u0000/g, '').trim()
  if (!name) throw new BadRequestException('文件夹名称不能为空')
  if (name.length > 60) throw new BadRequestException('文件夹名称最多 60 个字符')
  return name
}

function normalizeId(raw: unknown): string | null {
  const v = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return v && v !== 'root' ? v : null
}

/**
 * 资料库文件夹（D-068 / P-030，无限层级）。
 *
 * 🔴 本库无 RLS：每条查询链都必须带 `.eq('user_id', userId)`，
 *    由 `server/scripts/check-isolation.mjs` 静态扫描把关。
 * 🔴 删除是软删 + 内容提升到父级，**绝不删除任何资料文件**。
 * 🔴 文件夹名是用户主动输入的短文本 ⇒ 过 UgcTextGuard（D-059 第六条入库口）。
 */
@Injectable()
export class LibraryFolderService {
  private readonly logger = new Logger(LibraryFolderService.name)

  constructor(private readonly ugc: UgcTextGuard) {}

  /** 列出该用户全部未删文件夹（扁平，前端按 parent_id 组树） */
  async list(userId: string): Promise<LibraryFolder[]> {
    const { data, error } = await getSupabaseClient()
      .from(TABLE)
      .select('id, user_id, parent_id, name, created_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    return (data || []) as unknown as LibraryFolder[]
  }

  private async owned(userId: string, id: string): Promise<LibraryFolder> {
    const { data, error } = await getSupabaseClient()
      .from(TABLE)
      .select('id, user_id, parent_id, name, created_at')
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文件夹不存在')
    return data as unknown as LibraryFolder
  }

  /** 新建：parent_id 存在时必须属于本人且未删；同名同级拒绝（防误建重复目录） */
  async create(userId: string, nameRaw: unknown, parentRaw: unknown): Promise<LibraryFolder> {
    const name = normalizeName(nameRaw)
    await this.ugc.assertAllowed(userId, [name], { scene: 1, tag: 'library_folder.create' })
    const parentId = normalizeId(parentRaw)
    if (parentId) await this.owned(userId, parentId)

    const siblings = await this.list(userId)
    if (siblings.some((f) => (f.parent_id ?? null) === parentId && f.name === name)) {
      throw new BadRequestException('同级已有同名文件夹')
    }

    const { data, error } = await getSupabaseClient()
      .from(TABLE)
      .insert({ user_id: userId, parent_id: parentId, name })
      .select('id, user_id, parent_id, name, created_at')
      .single()
    if (error) throw new Error(error.message)
    return data as unknown as LibraryFolder
  }

  /** 改名：同级重名拒绝 */
  async rename(userId: string, id: string, nameRaw: unknown): Promise<LibraryFolder> {
    const folder = await this.owned(userId, id)
    const name = normalizeName(nameRaw)
    if (name === folder.name) return folder
    await this.ugc.assertAllowed(userId, [name], { scene: 1, tag: 'library_folder.rename' })

    const siblings = await this.list(userId)
    if (siblings.some((f) => f.id !== id && (f.parent_id ?? null) === (folder.parent_id ?? null) && f.name === name)) {
      throw new BadRequestException('同级已有同名文件夹')
    }
    const { data, error } = await getSupabaseClient()
      .from(TABLE)
      .update({ name })
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id, user_id, parent_id, name, created_at')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文件夹不存在')
    return data as unknown as LibraryFolder
  }

  /**
   * 移动文件夹（换父级）。
   * 🔴 循环引用：沿新父级的 parent 链向上走，若遇到自己 ⇒ 拒绝；
   *    链长超过 MAX_DEPTH 也拒绝（脏数据保护，不当成正常层级限制）。
   */
  async move(userId: string, id: string, parentRaw: unknown): Promise<LibraryFolder> {
    const folder = await this.owned(userId, id)
    const parentId = normalizeId(parentRaw)
    if (parentId === id) throw new BadRequestException('不能把文件夹放到自己下面')
    if (parentId) {
      const all = await this.list(userId)
      const byId = new Map(all.map((f) => [f.id, f]))
      let cursor: string | null = parentId
      for (let depth = 0; cursor && depth <= MAX_DEPTH; depth++) {
        if (cursor === id) throw new BadRequestException('不能把文件夹放到它自己的子目录下')
        const p: LibraryFolder | undefined = byId.get(cursor)
        if (!p) throw new BadRequestException('目标文件夹不存在')
        cursor = p.parent_id ?? null
      }
      if (cursor) throw new BadRequestException('目录层级异常，请检查后重试')
    }
    const { data, error } = await getSupabaseClient()
      .from(TABLE)
      .update({ parent_id: parentId })
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id, user_id, parent_id, name, created_at')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文件夹不存在')
    return data as unknown as LibraryFolder
  }

  /**
   * 软删文件夹：其下资料与子文件夹一律**提升到被删文件夹的父级**，
   * 不删除任何文件、不递归删除子树（家长整理目录时最容易误删的就是这里）。
   */
  async remove(userId: string, id: string): Promise<{ id: string; promoted_docs: number; promoted_folders: number }> {
    const folder = await this.owned(userId, id)
    const parentId = folder.parent_id ?? null
    const client = getSupabaseClient()

    // 子文件夹提升（只改直接子级，孙级仍挂在子文件夹下，树不塌）
    const { data: children, error: ce } = await client
      .from(TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('parent_id', id)
      .is('deleted_at', null)
    if (ce) throw new Error(ce.message)
    if (children?.length) {
      const { error } = await client
        .from(TABLE)
        .update({ parent_id: parentId })
        .eq('user_id', userId)
        .eq('parent_id', id)
        .is('deleted_at', null)
      if (error) throw new Error(error.message)
    }

    // 资料提升到父级（folder_id=NULL 即根目录/未归类）
    const { data: docs, error: de } = await client
      .from(DOCS)
      .select('id')
      .eq('user_id', userId)
      .eq('folder_id', id)
      .is('deleted_at', null)
    if (de) throw new Error(de.message)
    if (docs?.length) {
      const { error } = await client
        .from(DOCS)
        .update({ folder_id: parentId })
        .eq('user_id', userId)
        .eq('folder_id', id)
        .is('deleted_at', null)
      if (error) throw new Error(error.message)
    }

    const { data, error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('文件夹不存在')
    this.logger.log(`[folders] 删除 ${id}：提升 ${docs?.length || 0} 份资料 / ${children?.length || 0} 个子文件夹`)
    return { id, promoted_docs: docs?.length || 0, promoted_folders: children?.length || 0 }
  }

  /** 把资料移入/移出文件夹：校验目标文件夹属于本人 */
  async moveDoc(userId: string, docId: string, folderRaw: unknown): Promise<{ id: string; folder_id: string | null }> {
    const folderId = normalizeId(folderRaw)
    if (folderId) await this.owned(userId, folderId)
    const { data, error } = await getSupabaseClient()
      .from(DOCS)
      .update({ folder_id: folderId })
      .eq('user_id', userId)
      .eq('id', docId)
      .is('deleted_at', null)
      .select('id, folder_id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('资料不存在')
    return data as { id: string; folder_id: string | null }
  }

  /** 给上传/合成链路用：folder_id 合法才回传，非法直接 400（不静默丢到根目录） */
  async assertFolder(userId: string, folderRaw: unknown): Promise<string | null> {
    const id = normalizeId(folderRaw)
    if (!id) return null
    await this.owned(userId, id)
    return id
  }
}
