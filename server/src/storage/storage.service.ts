import { Injectable } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import { S3Storage } from 'coze-coding-dev-sdk'

/**
 * 存储驱动抽象：
 *  - `local`（默认，本机开发）：文件落项目根 .local-storage/，经 /api/storage/files/* 读回。
 *    扣子 S3 通道在环境外已死刑（COZE_WORKLOAD_IDENTITY_API_KEY 用户侧拿不到），
 *    本机开发/测试阶段用本地盘顶替，接口与扣子版完全一致，调用方零改动。
 *  - `coze`（扣子平台内）：原 S3Storage 实现，仅在显式提供扣子凭证时启用。
 *
 * 切换：env `STORAGE_DRIVER=local|coze`（未设时：有扣子 workload key → coze，否则 local）。
 */
type StorageDriver = 'local' | 'coze'

@Injectable()
export class StorageService {
  private readonly driver: StorageDriver
  private readonly storage?: S3Storage
  /** local 驱动：对象根目录（默认 <cwd>/.local-storage） */
  private readonly localDir: string

  constructor() {
    this.driver = ((process.env.STORAGE_DRIVER as StorageDriver) ||
      (process.env.COZE_WORKLOAD_IDENTITY_API_KEY ? 'coze' : 'local')) as StorageDriver

    if (this.driver === 'coze') {
      this.storage = new S3Storage({
        endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
        accessKey: '',
        secretKey: '',
        bucketName: process.env.COZE_BUCKET_NAME,
        region: 'cn-beijing',
      })
      console.log('[storage] 驱动：coze S3（扣子平台内运行）')
      this.localDir = ''
      return
    }

    this.localDir = process.env.STORAGE_LOCAL_DIR || path.resolve(process.cwd(), '.local-storage')
    fs.mkdirSync(this.localDir, { recursive: true })
    console.log(`[storage] 驱动：local（根目录 ${this.localDir}，读取路由 /api/storage/files/*）`)
  }

  /** 本地驱动：把对象 key 安全解析为磁盘绝对路径（防 ../ 逃逸） */
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
    const key = await this.storage!.uploadFile({
      fileContent: buffer,
      fileName,
      contentType,
    })
    return key
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

  /** 对象可访问 URL。local 驱动：后端静态路由；coze 驱动：SDK 预签名 URL。 */
  async getPublicUrl(key: string): Promise<string> {
    if (this.driver === 'local') {
      return `${this.publicBaseUrl()}/api/storage/files/${key}`
    }
    return this.storage!.generatePresignedUrl({ key, expireTime: 86400 })
  }

  /**
   * 删除对象（用于匿名清理 / 软删回收 / GC）；失败不抛，返回是否成功。
   *
   * ⚠️ 修过一个真实 bug：SDK 的签名是 `deleteFile(options: { fileKey })`**（对象参数）**，
   * 而此前传的是裸字符串 key ⇒ 内部 `options.fileKey` 为 undefined ⇒ 删除**静默失败**
   * （异常被这里 catch 吞掉，只返回 false）。这意味着 GC / 清理任务「看起来在跑」，
   * 实际上文件一个都没删掉。现按类型定义传对象，并保留字符串形式兜底以兼容旧版 SDK。
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
    const anyStorage = this.storage as unknown as {
      deleteFile?: (a: unknown) => Promise<unknown>
      deleteObject?: (a: unknown) => Promise<unknown>
    }
    try {
      if (typeof anyStorage.deleteFile === 'function') {
        await anyStorage.deleteFile({ fileKey: key })
        return true
      }
      if (typeof anyStorage.deleteObject === 'function') {
        await anyStorage.deleteObject({ fileKey: key })
        return true
      }
      console.warn('[storage] SDK 未暴露删除方法，跳过 key:', key)
      return false
    } catch (e) {
      // 兜底：个别 SDK 版本可能是 (key: string) 的老签名
      try {
        if (typeof anyStorage.deleteFile === 'function') {
          await anyStorage.deleteFile(key)
          return true
        }
      } catch {
        /* 两种签名都不行，才判定失败 */
      }
      console.error('[storage] 删除对象失败', key, e)
      return false
    }
  }

  /**
   * 按前缀列举对象 key（供分层统计、临时对象清理使用）。
   * local 驱动：递归遍历磁盘；SDK：分页 listFiles。
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
    const anyStorage = this.storage as unknown as {
      listFiles?: (o: { prefix?: string; maxKeys?: number; continuationToken?: string })
        => Promise<{ keys?: string[]; isTruncated?: boolean; nextContinuationToken?: string }>
    }
    if (typeof anyStorage.listFiles !== 'function') return []
    const out: string[] = []
    let token: string | undefined
    try {
      // 最多翻 20 页，避免异常情况下无限循环
      for (let page = 0; page < 20; page++) {
        const res = await anyStorage.listFiles({ prefix, maxKeys, ...(token ? { continuationToken: token } : {}) })
        out.push(...(res?.keys || []))
        if (!res?.isTruncated || !res.nextContinuationToken) break
        token = res.nextContinuationToken
      }
    } catch (e) {
      console.error('[storage] 列举对象失败', prefix, e)
    }
    return out
  }
}
