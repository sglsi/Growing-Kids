/**
 * 异步任务的类型定义
 *
 * 存在理由：微信 `wx.request` / `wx.uploadFile` 的超时**默认与最大都是 60s**
 * （官方服务市场文档），前端写大数值完全不生效。本项目三条链路实测必超：
 * 精准 OCR ≈ 67s、联网搜答案 ≈ 110~135s、AI 解题 ≈ 60~90s。
 * 在小程序端表现为「点了没反应」，且与网络好坏无关。
 *
 * 解法不是调超时（天花板在那），而是**提交即回 ticket、用短请求轮询**。
 * 轮询请求是毫秒级，永远不会撞 60s。
 *
 * 边界（必须知道，否则会误用）：
 *   - 任务**只在提交它的进程内存里执行**，没有队列中间件；
 *   - ⇒ 进程重启 = 未完成任务全部失效（启动时统一标记 failed 并写明原因）；
 *   - ⇒ 只适合单机部署。若将来多实例，须把执行器换成真正的队列。
 */

export type JobType = 'ocr-page' | 'answer-search' | 'search-solve'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/** 每种任务的超时上限（毫秒）。超过即判失败——否则客户端会永远轮询下去。 */
export const JOB_TTL_MS: Record<JobType, number> = {
  // 摆正 ~17s + PP-StructureV3 ~50s，实测 67s；留一倍余量给慢机
  'ocr-page': 180_000,
  // 扣子 bot 跑检索插件 ~100~115s + 提炼 ~10~60s，实测最长 135s
  'answer-search': 260_000,
  // 联网检索 + 大模型，实测 60~90s
  'search-solve': 150_000,
}

/** 提交时的阶段文案（面向用户；只给文字，不做假进度百分比） */
export const JOB_STAGE: Record<JobType, { queue: string; run: string }> = {
  'ocr-page': { queue: '排队中', run: '识别中，精准模式较慢（约 1 分钟）' },
  'answer-search': { queue: '排队中', run: '正在联网检索答案（约 1~2 分钟）' },
  'search-solve': { queue: '排队中', run: '正在检索并解题（约 1 分钟）' },
}

export interface JobRow {
  id: string
  user_id: string
  type: JobType
  status: JobStatus
  dedupe_key: string | null
  params: Record<string, unknown> | null
  result: Record<string, unknown> | null
  error: string | null
  stage: string | null
  attempts: number
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  expires_at: string
}

/** 对外可见的任务视图（不暴露 params——里面可能有图片 URL 等原始参数） */
export interface JobView {
  id: string
  type: JobType
  status: JobStatus
  stage: string | null
  error: string | null
  result: Record<string, unknown> | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** 已等待毫秒数（前端据此显示「已等待 N 秒」，比假进度诚实） */
  waited_ms: number
}

export interface OcrPageJobParams {
  image_url: string
  mode?: 'fast' | 'precise'
  rectify?: boolean
  force?: boolean
}

export interface AnswerSearchJobParams {
  item_id: string
  force?: boolean
  mode?: 'search' | 'ai' | 'kb'
}

export interface SearchSolveJobParams {
  question_content: string
}
