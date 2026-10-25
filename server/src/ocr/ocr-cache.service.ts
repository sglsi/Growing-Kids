import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { getSupabaseClient } from '../storage/database/supabase-client'

/**
 * OCR 识别结果持久缓存（#121：同一份文件只识别一次）
 * ------------------------------------------------------------------
 * 物理文件早已去重（blob_objects 内容寻址 + 引用计数），但**识别本身没有记忆**：
 * 同一份文件被同一用户或不同用户再次识别时，整条管线重跑——图片要多算子 OCR、
 * 文档要逐页 OCR + 版面/可能的 VLM，慢且重复消耗算力与额度。
 *
 * 设计决策（思傅 2026-10-25 确认）：
 *   ① 作用域取「全局」而非单用户——识别结果只由文件内容决定，与谁上传无关，
 *      多用户传同一份卷子只算一次（本次需求核心场景）。
 *   ② 只有**文件字节完全相同**（sha256 一致）才命中。命中方本就持有该文件，
 *      拿到的也是自己这份内容的识别结果 ⇒ 无信息增量泄漏。
 *   ③ mode 与 engine_version 都进缓存键：不同链路产物不可串味；引擎升级后
 *      旧条目自然不再被命中（等效失效），无需手工清理。
 *
 * ⚠️ 全程 best-effort：缓存表不可用/写失败都**不阻断识别**，只打日志。
 */
const TABLE = 'ocr_results'

/**
 * 引擎/模型版本 —— 进缓存键。
 * ⚠️ 升级 OCR 引擎（main.py / main3.py）、换模型、大改 prompt/切分逻辑后，
 *    **必须改这个版本号**，否则会继续回放旧引擎的产物。
 *    也支持环境变量 OCR_ENGINE_VERSION 覆盖（临时回滚/实验时用，无需改代码）。
 */
export const OCR_ENGINE_VERSION = process.env.OCR_ENGINE_VERSION || 'gk-ocr-2026.10.25'

/** 单条结果体积上限：超过不缓存（防个别超大 PDF 把表撑爆） */
const MAX_RESULT_BYTES = 512 * 1024

export type OcrCacheKind = 'exam' | 'pair' | 'doc' | 'page'

export interface OcrCacheRef {
  /** 输入内容指纹：一张文件时单个 hash；多张时按序拼接后由本模块统一再 hash */
  contentHashes: string[]
  kind: OcrCacheKind
  /** 识别模式（fast/precise/''）；不同模式产物不同，必须进键 */
  mode?: string
  /**
   * 额外区分因子（如 ocr-page 的 rectify 开关、task 类型）。
   * 只有会影响产物形状的参数才放这里，无关参数放进来只会降低命中率。
   */
  extra?: string
}

/**
 * 从对象存储 key 或公网 URL 里解析内容 sha256。
 *
 * key/URL 形态统一为：`.../blobs/<hash前2位>/<64位sha256>/<variant>.webp`
 * —— key 本身即携带内容指纹（见 IngestService），因此**不需要前端额外传 hash**，
 *    也没有"改 URL 就要改前端"的耦合。
 *
 * @returns 64 位小写 hex；解析不到返回 null（调用方应据此**降级不缓存**，不阻断）
 */
export function contentHashFromRef(ref: string): string | null {
  if (!ref) return null
  const m = /(?:^|\/)blobs\/[0-9a-f]{2}\/([0-9a-f]{64})\//i.exec(ref)
  return m ? m[1].toLowerCase() : null
}

/** 把「多张输入的 content hash + 所有区分因子」压成一个稳定 key */
export function buildOcrCacheKey(ref: OcrCacheRef): string {
  const joined = ref.contentHashes.join('|')
  return createHash('sha256')
    .update([ref.kind, ref.mode || '', ref.extra || '', OCR_ENGINE_VERSION, joined].join('#'))
    .digest('hex')
}

@Injectable()
export class OcrCacheService {
  private readonly logger = new Logger(OcrCacheService.name)

  /**
   * 读取缓存。命中则返回原产物，并异步累加命中计数（失败不影响返回）。
   * @param force true = 强制重新识别：跳过读取（写入侧仍会覆盖刷新）
   */
  async get<T>(ref: OcrCacheRef, opts: { force?: boolean } = {}): Promise<T | null> {
    try {
      if (opts.force) return null
      if (!ref.contentHashes.length || ref.contentHashes.some((h) => !h)) return null

      const client = getSupabaseClient()
      const key = buildOcrCacheKey(ref)
      const { data, error } = await client
        .from(TABLE)
        .select('result, hit_count')
        .eq('cache_key', key)
        .maybeSingle()
      if (error) {
        this.logger.warn(`[ocr-cache] 读取失败 kind=${ref.kind}: ${error.message}`)
        return null
      }
      if (!data) return null

      // 命中计数仅作冷热/收益观测，失败无所谓——但必须 catch 并打全错，不能静默。
      // ⚠️ 必须 +1：select 不带 hit_count 时用 0 覆盖会把计数清零。
      const hits = Number((data as { hit_count?: number }).hit_count || 0) + 1
      void Promise.resolve(
        client
          .from(TABLE)
          .update({ hit_count: hits, last_hit_at: new Date().toISOString() })
          .eq('cache_key', key),
      ).catch((e) => this.logger.warn(`[ocr-cache] 命中计数更新失败 kind=${ref.kind}: ${e}`))

      this.logger.log(`[ocr-cache] 命中 kind=${ref.kind} mode=${ref.mode || '-'} hashes=${ref.contentHashes.length}`)
      return (data as { result: T }).result
    } catch (e) {
      this.logger.warn(`[ocr-cache] 读取异常（降级为不缓存）: ${e}`)
      return null
    }
  }

  /** 写入（覆盖式 upsert，支持 force 重识别后刷新） */
  async set<T>(ref: OcrCacheRef, result: T): Promise<void> {
    try {
      if (!ref.contentHashes.length || ref.contentHashes.some((h) => !h)) return
      if (result === null || result === undefined) return

      let bytes = 0
      try {
        bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
      } catch {
        return // 无法序列化（循环引用等）直接放弃缓存，不影响主流程
      }
      if (bytes > MAX_RESULT_BYTES) {
        this.logger.warn(`[ocr-cache] 结果过大跳过缓存 kind=${ref.kind} ${bytes}B > ${MAX_RESULT_BYTES}B`)
        return
      }

      const client = getSupabaseClient()
      const row = {
        cache_key: buildOcrCacheKey(ref),
        content_hash: ref.contentHashes.length === 1 ? ref.contentHashes[0] : buildOcrCacheKey(ref),
        kind: ref.kind,
        mode: ref.mode || '',
        engine_version: OCR_ENGINE_VERSION,
        result: result as unknown as Record<string, unknown>,
        result_bytes: bytes,
        last_hit_at: new Date().toISOString(),
      }
      const { error } = await client
        .from(TABLE)
        .upsert(row, { onConflict: 'cache_key', ignoreDuplicates: false })
      if (error) this.logger.warn(`[ocr-cache] 写入失败 kind=${ref.kind}: ${error.message}`)
      else this.logger.log(`[ocr-cache] 已缓存 kind=${ref.kind} mode=${ref.mode || '-'} ${bytes}B`)
    } catch (e) {
      this.logger.warn(`[ocr-cache] 写入异常（忽略）: ${e}`)
    }
  }
}
