import { Controller, Post, Get, Delete, Body, Param, Req, HttpCode, BadRequestException } from '@nestjs/common'
import { JobsService } from './jobs.service'
import { requireUserId, requireAiEnabled, type RequestWithUser } from '../shared/user-context'
import type { JobType } from './jobs.types'

interface SubmitBody {
  type?: string
  params?: Record<string, unknown>
}

const TABLE_OF_TYPE = new Set<JobType>(['ocr-page', 'answer-search', 'search-solve'])

/**
 * 异步任务接口
 *
 * 存在理由见 jobs.types.ts 头部：微信 request 超时上限 60s，精准 OCR / 搜答案
 * 实测必然超过 ⇒ 改成「提交回 ticket + 短请求轮询」。
 *
 * ⚠️ 这些端点**必须登录**（`requireUserId`），不要加进 `PUBLIC_ROUTES`——
 *    任务里带着用户的图片 URL 与题目内容。
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  /**
   * 提交任务。
   *
   * ⚠️ HTTP 用 **202 Accepted**（语义：已受理、未完成），但 body 的 `code` 仍写 200
   *    —— 全项目所有端点都用 `code: 200` 表达成功，前端 `unwrapResponse` 也据此判断；
   *    若这里写 `code: 202`，所有走 unwrap 的调用方都会抛「识别失败」。
   */
  @Post()
  @HttpCode(202)
  async submit(@Req() req: RequestWithUser, @Body() body: SubmitBody) {
    let userId = requireUserId(req)
    const type = String(body?.type || '') as JobType
    if (!TABLE_OF_TYPE.has(type)) {
      throw new BadRequestException(`不支持的任务类型：${String(body?.type)}（可选：ocr-page / answer-search / search-solve）`)
    }
    // ⚠️ **闸门必须在提交阶段拦，不能留到执行阶段**。
    //    `/api/search/solve` 与 `/api/answer-search` 都过 `requireAiEnabled`
    //    （R-合规-02：AI 外发开关）。而任务是在后台执行的，**那时没有 req** ——
    //    若把校验放进执行器，异步化就等于给 AI 闸门开了一道后门：
    //    用户关了开关，只要他能提交任务，内容照样外发。
    if (type === 'answer-search' || type === 'search-solve') {
      userId = requireAiEnabled(req)
    }
    const params = (body?.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>
    const headers = (req.headers || {}) as Record<string, string>
    const data = await this.jobsService.submit(userId, type, params, headers)
    return { code: 200, msg: 'success', data }
  }

  /** 我未完成的任务（页面重载后接上，避免「重进页面就白跑一遍」） */
  @Get()
  @HttpCode(200)
  async listActive(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.jobsService.listActive(userId)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 轮询单个任务。
   *
   * 前端拿到 `status` 为 done / failed 即停止。建议间隔 1.2s 起、逐步退避到 3s，
   * 总时长以 `JOB_TTL_MS` 为准——本接口自身是毫秒级，不会撞 60s 天花板。
   */
  @Get(':id')
  @HttpCode(200)
  async get(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.jobsService.get(userId, id)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 删除任务记录（清理）。
   * 刻意**不提供「取消」**：Node 无法安全中断已在跑的 promise，
   * 做了就是自欺——按钮点了没反应，比不给按钮更糟。
   */
  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.jobsService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }
}
