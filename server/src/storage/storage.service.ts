import { Injectable } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * 存储驱动抽象（已彻底去除扣子 / Coze S3 依赖）
 * ------------------------------------------------------------------
 *  - `local`（默认，本机开发）：文件落 `<项目根>/.local-storage/`，
 *    经 `GET /api/storage/files/*` 读回。零外部依赖，断网也能跑。
 *  - `supabase`（生产）：Supabase Storage（S3 兼容对象存储），
 *    用 service_role key 服务端直传，公共桶返回公网 URL、私有桶返回签名 URL。
 *
 * 切换：env `STORAGE_DRIVER=local|supabase`
 *      未显式设置时默认 `local`（本机开发最安全：断网可跑、不会因 bucket 未建而
 *      突然把上传打挂）；上生产时显式设 `STORAGE_DRIVER=supabase`。
 *
 * 接口（uploadBuffer/uploadDerived/uploadTemp/getPublicUrl/deleteObject/listKeys）
 * 与历史版本完全一致，10+ 处调用方零改动。
 */
type StorageDriver = 'local' | 'supabase'

@Injectable()
export class StorageService {
  private readonly driver: StorageDriver
  private readonly supabase?: SupabaseClient
  private readonly bucket: string
  /** local 驱动：对象根目录（默认 <cwd>/.local-storage） */
  private localDir: string
  /** supabase 驱动：true=公共桶（公网直链），false=私有桶（签名 URL） */
  private readonly publicBucket: boolean

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY

    this.driver = ((process.env.STORAGE_DRIVER as StorageDriver) || 'local') as StorageDriver

    this.bucket = process.env.SUPABASE_STORAGE_BUCKET || 'media'
    this.publicBucket = (process.env.SUPABASE_STORAGE_PUBLIC || 'true') !== 'false'
    this.localDir = ''

    if (this.driver === 'supabase') {
      if (!supabaseUrl || !serviceKey) {
        throw new Error(
          '[storage] STORAGE_DRIVER=supabase 但缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
        )
      }
      this.supabase = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      console.log(
        `[storage] 驱动：supabase（bucket=${this.bucket}，${this.publicBucket ? '公共桶' : '私有桶签名'}）`,
      )
      return
    }

    this.localDir = process.env.STORAGE_LOCAL_DIR || path.resolve(process.cwd(), '.local-storage')
    fs.mkdirSync(this.localDir, { recursive: true })
    console.log(`[storage] 驱动：local（根目录 ${this.localDir}，读取路由 /api/storage/files/*）`)
  }

  /** local 驱动：把对象 key 安全解析为磁盘绝对路径（防 ../ 逃逸） */
  private resolveLocal(key: string): string {
    const norm = path.normalize(key).replace(/^(\.\.[/\\])+/, '')
    const abs = path.resolve(this.localDir, norm)
    const root = path.resolve(this.localDir)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`[storage] 非法对象 key（路径逃逸）：${key}`)
    }
    return abs
  }

  async uploadBuffer(buffer: Buffer, fileName: string, contentType?: string): Promise<string> {
    if (!buffer || buffer.length === 0) {
      throw new Error(`[storage] 拒绝上传空文件：${fileName}`)
    }

    if (this.driver === 'local') {
      const abs = this.resolveLocal(fileName)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, buffer)
      return fileName
    }

    const { error } = await this.supabase!.storage.from(this.bucket).upload(fileName, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: true,
      cacheControl: '31536000',
    })
    if (error) {
      throw new Error(`[storage] 上传失败 ${fileName}：${error.message}`)
    }
    return fileName
  }

  /**
   * 内容寻址上传：key 由内容 hash 决定，同一份内容天然落在同一个 key 上（幂等）。
   * 目录按 hash 前两位分层，避免单目录对象过多（对象存储的通用实践）。
   *
   * @param hash   内容 sha256（hex）
   * @param variant 'original' | 'display' | 'thumb'
   */
  async uploadDerived(
    buffer: Buffer,
    hash: string,
    variant: 'original' | 'display' | 'thumb',
    ext: string,
    contentType: string,
  ): Promise<string> {
    const h = (hash || '').padEnd(4, '0')
    const key = `blobs/${h.slice(0, 2)}/${hash}/${variant}.${ext}`
    return this.uploadBuffer(buffer, key, contentType)
  }

  /**
   * 临时对象上传（中间态，如 AI 识别前的图片）。
   *
   * 与正式资产的差别：
   *   - 独立 `tmp/` 前缀（正式资产在 `blobs/`）：一眼可辨，便于运维单独配生命周期规则；
   *   - **内容寻址**：同一份内容重复中间上传会落在同一个 key 上，天然不重复占空间。
   */
  async uploadTemp(
    buffer: Buffer,
    hash: string,
    ext: string,
    contentType: string,
  ): Promise<string> {
    const h = (hash || '').padEnd(4, '0')
    const key = `tmp/${h.slice(0, 2)}/${hash}.${ext}`
    return this.uploadBuffer(buffer, key, contentType)
  }

  /** local 驱动公网读取基址（每次动态读：main.ts 在 listen 前把实际端口注入 SERVER_PORT，
   *  而模块构造早于 listen，构造时固化会漏掉 `-p` 指定的端口） */
  private publicBaseUrl(): string {
    if (process.env.STORAGE_PUBLIC_BASE_URL) return process.env.STORAGE_PUBLIC_BASE_URL
    const port = process.env.PORT || process.env.SERVER_PORT || '3000'
    return `http://127.0.0.1:${port}`
  }

  /** 对象可访问 URL。local：后端静态路由；supabase：公共桶公网直链 / 私有桶签名 URL。 */
  async getPublicUrl(key: string): Promise<string> {
    if (this.driver === 'local') {
      return `${this.publicBaseUrl()}/api/storage/files/${key}`
    }
    if (this.publicBucket) {
      return this.supabase!.storage.from(this.bucket).getPublicUrl(key).data.publicUrl
    }
    const { data, error } = await this.supabase!.storage
      .from(this.bucket)
      .createSignedUrl(key, 86400)
    if (error || !data?.signedUrl) {
      throw new Error(`[storage] 生成签名 URL 失败 ${key}：${error?.message || 'unknown'}`)
    }
    return data.signedUrl
  }

  /**
   * 按对象 key **直接读磁盘**（仅 local 驱动有意义），supabase 驱动或文件不存在时返回 null。
   *
   * 存在意义：local 驱动下 `getPublicUrl()` 只能给出 `http://127.0.0.1:<port>/api/storage/files/…`
   * 这种回环地址。在托管环境里，容器拿这个 URL 去 HTTP 下载**自己的**文件常常打不通
   * （端口/网关不一致 → 404），于是整条图像处理链路报「下载处理图失败(status 404)」。
   * 处理链路拿到自家 key 时直接读盘，绕开这一圈 HTTP，既修故障也省一次网络往返。
   */
  async readLocalObject(key: string): Promise<Buffer | null> {
    if (this.driver !== 'local') return null
    try {
      const abs = this.resolveLocal(key)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
      return await fs.promises.readFile(abs)
    } catch {
      return null
    }
  }

  /**
   * 删除对象（用于匿名清理 / 软删回收 / GC）；失败不抛，返回是否成功。
   */
  async deleteObject(key: string): Promise<boolean> {
    if (!key) return false
    if (this.driver === 'local') {
      try {
        const abs = this.resolveLocal(key)
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true })
          return true
        }
        return false
      } catch (e) {
        console.error('[storage] 删除对象失败', key, e)
        return false
      }
    }
    try {
      const { error } = await this.supabase!.storage.from(this.bucket).remove([key])
      if (error) {
        console.error('[storage] 删除对象失败', key, error.message)
        return false
      }
      return true
    } catch (e) {
      console.error('[storage] 删除对象失败', key, e)
      return false
    }
  }

  /**
   * 按前缀列举对象 key（供分层统计、临时对象清理使用）。
   * local：递归遍历磁盘；supabase：按目录分页 list（Storage API 不支持跨级前缀，需逐层下钻）。
   */
  async listKeys(prefix: string, maxKeys = 1000): Promise<string[]> {
    if (this.driver === 'local') {
      const out: string[] = []
      const root = path.resolve(this.localDir)
      const walk = (dir: string) => {
        if (out.length >= maxKeys) return
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (out.length >= maxKeys) return
          const abs = path.join(dir, e.name)
          if (e.isDirectory()) {
            walk(abs)
            continue
          }
          const rel = path.relative(root, abs).split(path.sep).join('/')
          if (!prefix || rel.startsWith(prefix)) out.push(rel)
        }
      }
      walk(root)
      return out
    }

    const out: string[] = []
    // prefix 形如 "blobs/" 或 "tmp/"；逐层下钻目录，收集文件 key
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= maxKeys) return
      const { data, error } = await this.supabase!.storage
        .from(this.bucket)
        .list(dir, { limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
      if (error || !data) return
      for (const item of data) {
        if (out.length >= maxKeys) return
        // Supabase Storage 用 id=null 表示目录（无 metadata 时为文件）
        const isDir = !item.metadata || item.metadata === null
        const child = dir ? `${dir}/${item.name}` : item.name
        if (isDir) {
          await walk(child)
        } else {
          if (!prefix || child.startsWith(prefix)) out.push(child)
        }
      }
    }
    try {
      await walk('')
    } catch (e) {
      console.error('[storage] 列举对象失败', prefix, e)
    }
    return out
  }
}
