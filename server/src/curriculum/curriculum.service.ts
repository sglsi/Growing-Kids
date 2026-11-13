import { Injectable } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import type { CurriculumTopicRow } from '../shared/curriculum-topics'
import { CURRICULUM_TAG_DISCLAIMER } from './curriculum.constants'

/**
 * P-028 / D-045：国家课标维度表的**只读**服务端出口。
 *
 * 🔴 四条不许越的线：
 *   ① 只允许 SELECT。本服务没有 insert/update/delete，controller 也没有写端点。
 *      `curriculum_topics` 是全局只读字典（无 user_id），不按用户过滤，
 *      但**端点要求身份**（不进 PUBLIC_ROUTES，见 D-045 实施期工程决策）。
 *   ② **fail-closed 降级**：生产库当前没有 `0032_curriculum_topics`（D-044 实测
 *      `curriculum_topics_present=false`）。表不存在 / 查询失败 / 超行数时一律返回
 *      `available:false` + 空数组，前端不渲染标签，绝不把 500 抛给面客。
 *   ③ 不参与检索链路：不 import `question-reference.ts`、不碰 `sharedSignals()`、
 *      不进 `note` 判定、不进缓存键、不改 `CACHE_VERSION`（保持 v14）。
 *   ④ 不宣称：`term` 是项目自建术语不是课标条文；`framework_verified` 逐行透传，
 *      前端只作展示，不得表述为「已核实知识点」。
 */

const TABLE = 'curriculum_topics'
/** 与 0032 migration 的列逐字对应；刻意不取 id / created_at */
const SELECT_COLS = [
  'subject_code', 'subject_name', 'standard_name', 'stage',
  'grade_min', 'grade_max', 'domain', 'topic', 'term',
  'standard_version', 'standard_doc', 'source_url',
  'framework_verified', 'term_origin', 'version_note',
].join(', ')
/** 720 行是 D-039 的实测值；上限只为防止误把大表全量拉进内存 */
const MAX_ROWS = 2000
/** 字典静态，5 分钟内存缓存；表不存在也缓存，避免每次请求刷一条错误日志 */
const CACHE_TTL_MS = 5 * 60_000

export interface CurriculumTopicsPayload {
  /** false ⇒ 前端不渲染标签（表未上生产 / 查询失败 / 数据异常） */
  available: boolean
  topics: CurriculumTopicRow[]
  disclaimer: string
  /** 仅供排障的降级原因，不含任何用户数据 / 凭据 / 题干 */
  reason?: 'table_unavailable' | 'unexpected_row_count' | 'invalid_rows'
}

@Injectable()
export class CurriculumService {
  private cache: { at: number; payload: CurriculumTopicsPayload } | null = null

  async listTopics(): Promise<CurriculumTopicsPayload> {
    const now = Date.now()
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.payload

    const payload = await this.load()
    this.cache = { at: now, payload }
    return payload
  }

  private async load(): Promise<CurriculumTopicsPayload> {
    let rows: CurriculumTopicRow[] | null = null
    try {
      const client = getSupabaseClient()
      const { data, error } = await client
        .from(TABLE)
        .select(SELECT_COLS)
        .order('subject_code', { ascending: true })
        .order('stage', { ascending: true })
        .limit(MAX_ROWS + 1)
      if (error) {
        // PostgREST 对不存在的表返回 PGRST205 / 42P01 之类；不区分，一律降级
        console.warn('[curriculum] 维度表不可读，按 fail-closed 降级', String(error.message || '').slice(0, 160))
        return this.unavailable('table_unavailable')
      }
      rows = (data || []) as unknown as CurriculumTopicRow[]
    } catch (e) {
      console.warn('[curriculum] 维度表查询异常，按 fail-closed 降级', String((e as Error)?.message || e).slice(0, 160))
      return this.unavailable('table_unavailable')
    }

    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
      return this.unavailable(rows.length > MAX_ROWS ? 'unexpected_row_count' : 'table_unavailable')
    }
    // 只放行结构完整的行；任何一行缺关键字段就整批降级，宁可不显示也不错标
    const valid = rows.every((r) =>
      typeof r?.subject_code === 'string' &&
      typeof r?.domain === 'string' &&
      typeof r?.topic === 'string' &&
      typeof r?.term === 'string' &&
      r.term_origin === 'project',
    )
    if (!valid) return this.unavailable('invalid_rows')

    return { available: true, topics: rows, disclaimer: CURRICULUM_TAG_DISCLAIMER }
  }

  private unavailable(reason: CurriculumTopicsPayload['reason']): CurriculumTopicsPayload {
    return { available: false, topics: [], disclaimer: CURRICULUM_TAG_DISCLAIMER, reason }
  }
}
