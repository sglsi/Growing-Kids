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
    const key = await this.storage.uploadFile({
      fileContent: buffer,
      fileName,
      contentType,
    })
    return key
  }

  async getPublicUrl(key: string): Promise<string> {
    return this.storage.generatePresignedUrl({ key, expireTime: 86400 })
  }
}
