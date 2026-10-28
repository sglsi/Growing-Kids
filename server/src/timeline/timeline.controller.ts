import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { TimelineService } from './timeline.service'
import { buildReviewPlan, type ReviewResult } from './review'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type {
  CreateTimelineDto, UpdateTimelineDto, TimelineScope,
} from './timeline.types'

interface IdsBody { ids?: string[] }

@Controller('timeline')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('scope') scope?: TimelineScope,
    @Query('subject_id') subjectId?: string,
    @Query('tag') tag?: string,
    @Query('keyword') keyword?: string,
    /** ISO 时间下界：过滤 created_at >= since（review 模式下按 added_to_review_at） */
    @Query('since') since?: string,
    /** due=1：只看今天该复习（含逾期） */
    @Query('due') due?: string,
    /** 复习本排序：due（默认，按到期）/ added（按加入时间） */
    @Query('sort') sort?: 'due' | 'added',
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.timelineService.list(userId, {
      scope, subject_id: subjectId, tag, keyword, since,
      due: due === '1' || due === 'true',
      sort,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    })
    data.list = await this.timelineService.withUrls(data.list)
    return { code: 200, msg: 'success', data }
  }

  /**
   * 复习排程汇总（今日该复习 / 未排程 / 已毕业）。
   * ⚠️ 必须声明在 `@Get(':id')` **之前**：Nest 按声明顺序匹配，
   *    放在后面会被 `:id` 先吃掉（把 'review' 当成题目 id）。
   */
  @Get('review/summary')
  @HttpCode(200)
  async reviewSummary(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.timelineService.reviewSummary(userId)
    return { code: 200, msg: 'success', data }
  }

  @Get('overview')
  @HttpCode(200)
  async overview(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.timelineService.overview(userId)
    data.recent = await this.timelineService.withUrls(data.recent)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateTimelineDto) {
    const userId = requireUserId(req)
    const item = await this.timelineService.create(userId, dto)
    const [withUrl] = await this.timelineService.withUrls([item])
    return { code: 200, msg: 'success', data: withUrl }
  }

  /** 批量创建（一次提取多道题时替代前端循环单条，一次落库） */
  @Post('batch')
  @HttpCode(200)
  async createBatch(@Req() req: RequestWithUser, @Body() body: { items?: CreateTimelineDto[] }) {
    const userId = requireUserId(req)
    if (!Array.isArray(body?.items) || !body.items.length) throw new BadRequestException('items 不能为空')
    const items = await this.timelineService.createBatch(userId, body.items)
    const withUrls = await this.timelineService.withUrls(items)
    return { code: 200, msg: 'success', data: { list: withUrls } }
  }

  @Post('review-book')
  @HttpCode(200)
  async addToReview(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.addToReviewBook(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  @Delete('review-book')
  @HttpCode(200)
  async removeFromReview(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.removeFromReviewBook(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  /** P2-17 相似题/变式题推荐：基于用户自建错题历史（文本+标签相似） */
  @Post(':id/similar')
  @HttpCode(200)
  async similar(@Req() req: RequestWithUser, @Param('id') id: string, @Body() body: { limit?: number }) {
    const userId = requireUserId(req)
    const limit = Math.min(20, Math.max(1, Number(body?.limit) || 5))
    const data = await this.timelineService.findSimilar(userId, id, limit)
    return { code: 200, msg: 'success', data }
  }

  /**
   * C4 复习排程：记录一次复习。
   * body.result: 'correct'（默认，做对→推进一档）/ 'wrong'（做错→归零，明天再来）
   *
   * ⚠️ 不传 result 时按 correct 处理，是为了兼容已发布的旧前端包（它只发空 body）。
   *    新前端必须显式传对错——这是分散练习拿到效应量的前提。
   */
  @Post(':id/review')
  @HttpCode(200)
  async review(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { result?: ReviewResult },
  ) {
    const userId = requireUserId(req)
    const raw = body?.result
    if (raw !== undefined && raw !== 'correct' && raw !== 'wrong') {
      throw new BadRequestException("result 只能是 'correct' 或 'wrong'")
    }
    const data = await this.timelineService.review(userId, id, raw || 'correct')
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    const ids = this.parseIds(body)
    const data = await this.timelineService.removeMany(userId, ids)
    return { code: 200, msg: 'success', data }
  }

  @Get(':id')
  @HttpCode(200)
  async findOne(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.timelineService.findOne(userId, id)
    // ⚠️ 必须补签名 URL（思傅 2026-10-21：详情页只看到文字看不到图）——
    //    findOne 此前直接返回裸行，question_image_urls/answer_image_urls/url/thumb_url
    //    全缺失，前端按 url 渲染的图片统统不显示（列表走 list/overview 有补，所以首页能看）。
    const [withUrl] = await this.timelineService.withUrls([data])
    // 复习计划由排程状态现算后附带（前端不再自己算一遍，避免两端规则漂移）
    return { code: 200, msg: 'success', data: { ...withUrl, review_plan: buildReviewPlan(withUrl) } }
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Req() req: RequestWithUser, @Param('id') id: string, @Body() dto: UpdateTimelineDto) {
    const userId = requireUserId(req)
    const data = await this.timelineService.update(userId, id, dto)
    // 同 findOne：更新后若返回裸行，详情页 setItem(updated) 会把签名 URL 冲掉
    // ⇒ 保存一次后图片从页面消失。必须补 withUrls。
    const [withUrl] = await this.timelineService.withUrls([data])
    return { code: 200, msg: 'success', data: withUrl }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.timelineService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }

  private parseIds(body: IdsBody): string[] {
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    return body.ids
  }
}
