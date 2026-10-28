import { Network } from '@/network'
import { buildHeaders } from '@/services/net'
import { ApiError } from '@/services/api'

/**
 * 异步任务：提交 + 轮询
 * ------------------------------------------------------------------
 * 存在理由（OPS-18 `R-上线-01`）：
 *   微信 `wx.request` / `wx.uploadFile` 的超时**默认与最大都是 60s**，
 *   前端写 `timeout: 180000` 完全不生效。而本项目三条链路实测必然超过：
 *     精准 OCR ≈ 67s｜联网搜答案 ≈ 110~135s｜AI 解题 ≈ 60~90s
 *   ⇒ 小程序端与网络好坏无关地被掐断，表现为「点了没反应」。
 *
 * 解法不是调超时（天花板就在那），而是**提交立即回 ticket，再用短请求轮询**。
 * 轮询单次是毫秒级，永远撞不到 60s。
 *
 * 因此本文件里**没有任何一个 timeout 大于 15s**——这是设计约束，不是懒。
 */

export type JobType = 'ocr-page' | 'answer-search' | 'search-solve'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

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
  /** 服务端算出的已等待毫秒数 */
  waited_ms: number
}

/** 轮询总时长上限：比后端 TTL 略宽，别让前端先放弃 */
const POLL_MAX_MS: Record<JobType, number> = {
  'ocr-page': 190_000,
  'answer-search': 270_000,
  'search-solve': 160_000,
}

/** 单次轮询请求的超时（毫秒级任务，15s 绰绰有余） */
const POLL_TIMEOUT = 15_000

/** 轮询间隔：起步 1.2s，每次 ×1.35，上限 3s */
const POLL_MIN_GAP = 1200
const POLL_MAX_GAP = 3000
const POLL_GAP_FACTOR = 1.35

function authHeaders(): Record<string, string> {
  return buildHeaders()
}

async function request<T>(opts: {
  url: string
  method: 'GET' | 'POST' | 'DELETE'
  data?: Record<string, unknown>
  timeout?: number
}): Promise<T> {
  const res = await Network.request({
    url: opts.url,
    method: opts.method,
    data: opts.data as never,
    header: authHeaders(),
    timeout: opts.timeout ?? POLL_TIMEOUT,
  })
  const body = res.data as { code?: number; msg?: string; data?: T }
  const status = res.statusCode
  if (status < 200 || status >= 300) {
    throw new ApiError(body?.msg || `请求失败(${status})`, status)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '请求失败')
  }
  return body.data as T
}

/** 提交任务，拿 ticket（不等待结果） */
export function submitJob(
  type: JobType,
  params: Record<string, unknown>,
): Promise<{ id: string; status: JobStatus; stage: string; deduped: boolean }> {
  return request({ url: '/api/jobs', method: 'POST', data: { type, params } })
}

/** 查一次任务状态 */
export function getJob(id: string): Promise<JobView> {
  return request({ url: `/api/jobs/${encodeURIComponent(id)}`, method: 'GET' })
}

/** 我未完成的任务（页面重载后「接上」） */
export function listActiveJobs(): Promise<JobView[]> {
  return request({ url: '/api/jobs', method: 'GET' })
}

/** 删除任务记录 */
export function removeJob(id: string): Promise<{ deleted: boolean }> {
  return request({ url: `/api/jobs/${encodeURIComponent(id)}`, method: 'DELETE' })
}

export interface RunJobOptions {
  /**
   * 进度回调。只给**阶段文案 + 已等待毫秒**，不给百分比——
   * 后端无法精确知道 OCR 走到第几步，编一个百分比是假进度，比不显示更糟。
   */
  onProgress?: (info: { stage: string; waitedMs: number }) => void
  /** 轮询总时长上限（默认按 type 取） */
  maxWaitMs?: number
}

/**
 * 提交并等到终态。
 *
 * 语义上等价于原来的「一次慢请求」，但拆成了 N 个短请求——
 * 这是绕开微信 60s 超时天花板的唯一办法。
 */
export async function runJob<T = Record<string, unknown>>(
  type: JobType,
  params: Record<string, unknown>,
  opts: RunJobOptions = {},
): Promise<T> {
  const { id, status, stage, deduped } = await submitJob(type, params)
  const maxWait = opts.maxWaitMs ?? POLL_MAX_MS[type] ?? 190_000
  const deadline = Date.now() + maxWait

  // 命中幂等（同一件事已在跑）时也照常轮询——复用别人的结果正是幂等的目的
  if (status === 'done') {
    return (await getJob(id)).result as T
  }

  let gap = POLL_MIN_GAP
  let last: JobView = { id, type, status, stage, error: null, result: null, created_at: '', started_at: null, finished_at: null, waited_ms: 0 }
  if (deduped) opts.onProgress?.({ stage: stage || '已在队列中', waitedMs: 0 })

  while (Date.now() < deadline) {
    await sleep(gap)
    last = await getJob(id)
    if (last.status === 'done') return last.result as T
    if (last.status === 'failed') {
      throw new Error(last.error || '任务失败，请重试')
    }
    opts.onProgress?.({
      stage: last.stage || '处理中',
      waitedMs: last.waited_ms,
    })
    gap = Math.min(POLL_MAX_GAP, Math.round(gap * POLL_GAP_FACTOR))
  }

  // 前端先放弃：把 ticket 删掉，避免表里留一条没人管的 running
  void removeJob(id).catch(() => {})
  throw new Error('处理时间过长，已停止等待，请稍后重试')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
