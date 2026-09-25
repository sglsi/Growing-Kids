// 类型检查用的本地桩（真实运行时由 coze-coding-dev-sdk 提供）
declare module 'coze-coding-dev-sdk' {
  export class S3Storage {
    constructor(opts: { endpointUrl?: string; accessKey?: string; secretKey?: string; bucketName?: string; region?: string })
    uploadFile(input: { fileContent: Buffer; fileName: string; contentType?: string }): Promise<string>
    generatePresignedUrl(input: { key: string; expireTime?: number }): Promise<string>
    deleteFile?(key: string): Promise<void>
  }
  export class LLMClient {
    invoke(messages: any[], opts?: any): Promise<{ content: string }>
  }
  export class FetchClient {
    constructor(config?: any)
    fetch(url: string): Promise<{ content: Array<{ type: string; text?: string }> }>
  }
  export class SearchClient {
    advancedSearch(q: string, opts?: any): Promise<SearchResponse>
  }
  export interface SearchResponse {
    web_items?: Array<{ title: string; url?: string; summary?: string; content?: string; site_name?: string }>
  }
  export class Config {}
  export class HeaderUtils {
    static extractForwardHeaders(h: Record<string, string>): any
  }
  export class ImageGenerationClient {
    constructor(config?: any, headers?: any)
    generate(opts: any): Promise<any>
    getResponseHelper(resp: any): { success: boolean; errorMessages: string[]; imageUrls: string[] }
  }
  export interface ContentPart { type: 'text' | 'image_url'; text?: string; image_url?: { url: string; detail?: string } }
  export function getReportBuffer(): any
  export function createWrappedFetch(buffer: any, tag: string): any
}
