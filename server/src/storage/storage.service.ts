import { Injectable } from '@nestjs/common'
import { S3Storage } from 'coze-coding-dev-sdk'

@Injectable()
export class StorageService {
  private readonly storage: S3Storage

  constructor() {
    this.storage = new S3Storage({
      endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
      accessKey: '',
      secretKey: '',
      bucketName: process.env.COZE_BUCKET_NAME,
      region: 'cn-beijing',
    })
  }

  async uploadBuffer(buffer: Buffer, fileName: string, contentType?: string): Promise<string> {
    if (!buffer || buffer.length === 0) {
      throw new Error(`[storage] 拒绝上传空文件：${fileName}`)
    }
    const key = await this.storage.uploadFile({
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

  async getPublicUrl(key: string): Promise<string> {
    return this.storage.generatePresignedUrl({ key, expireTime: 86400 })
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
   * SDK 支持 `listFiles({ prefix })`，分页靠 continuationToken。
   */
  async listKeys(prefix: string, maxKeys = 1000): Promise<string[]> {
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
