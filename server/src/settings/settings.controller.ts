import { BadRequestException, Body, Controller, Get, HttpCode, Put, Req } from '@nestjs/common'
import { invalidateUserFlags, requireUserId, type RequestWithUser } from '../shared/user-context'
import { gradeLabel, normalizeGrade, schoolYearStart, suggestGrade } from '../shared/grade'
import { UsersService } from '../users/users.service'

/**
 * 用户设置：AI 外发开关 + 年级（`P-005` / `D-008`）
 * ------------------------------------------------------------------
 * OPS-18 `R-合规-02` 的落地口。
 *
 * 产品口径（思傅 2026-10-27 明确）：
 *   **由用户自己决定是否开放 ima 与 LLM 访问**——开了才走大模型/在线检索，
 *   没开就只走本地（本机 OCR 侧车 + 本地题库），任何内容不出机器。
 *
 * 为什么默认关：
 *   数据主体是未成年人。缺省"默认外发"需要在监管与家长两头都自证合规，
 *   而缺省"默认不外发"只需要一句话说明白。后者的合规成本低得多。
 *
 * ⚠️ 真正的拦截点在 `shared/user-context.ts` 的 `requireAiEnabled()`，
 *    本接口只负责读写开关。只藏前端按钮不叫控制。
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * 读取当前设置（前端启动时预热）。
   *
   * `grade_rollover` = 学年到期的**升年级建议**，只在需要时非 null。
   * ⚠️ 服务端只给建议，绝不自动写入 —— 见 `shared/grade.ts` 的 `suggestGrade` 注释
   *   （留级/跳级/休学都不适用，静默改用户数据不可逆）。
   */
  @Get()
  @HttpCode(200)
  async getSettings(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    // 两次查询并行：flags 与 grade 互不依赖，串行会白等一个 RTT（跨境库尤其明显）
    const [flags, g] = await Promise.all([
      this.usersService.findFlags(userId),
      this.usersService.findGrade(userId),
    ])
    const suggested = suggestGrade(g.grade, g.confirmedYear)
    return {
      code: 200,
      msg: 'success',
      data: {
        ai_enabled: flags.aiEnabled,
        role: flags.role,
        grade: g.grade,
        grade_label: gradeLabel(g.grade),
        grade_rollover:
          suggested !== null && g.grade !== null
            ? { from: g.grade, suggested, school_year: schoolYearStart() }
            : null,
      },
    }
  }

  /** 设置 AI 外发开关 */
  @Put('ai')
  @HttpCode(200)
  async setAiEnabled(@Req() req: RequestWithUser, @Body() body: { enabled?: unknown }) {
    const userId = requireUserId(req)
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须是布尔值')
    }
    const enabled = await this.usersService.setAiEnabled(userId, body.enabled)
    // 立刻失效缓存：否则用户打开开关后还要等最多 60s 才能用，会被当成"没生效"
    await invalidateUserFlags(userId)
    return { code: 200, msg: 'success', data: { ai_enabled: enabled } }
  }

  /**
   * 设置 / 清空年级（`P-005` 决策 7、8）。
   *
   * 接口契约刻意区分两种「没有值」：
   *   · `{ "grade": null }`  → **清空**年级（合法的用户意图：孩子还小 / 不想填）
   *   · 不传 grade / 传非法值 → **400**（客户端 bug，不能当清空悄悄放过）
   *
   * ⚠️ 写入时同时记录 `grade_confirmed_year = 当前学年`，
   *    这样今年的升年级提示就不再出现；明年 9/1 之后才会再次提示。
   */
  @Put('grade')
  @HttpCode(200)
  async setGrade(@Req() req: RequestWithUser, @Body() body: { grade?: unknown }) {
    const userId = requireUserId(req)
    if (!body || !('grade' in body)) {
      throw new BadRequestException('缺少 grade（取消年级请显式传 null）')
    }
    const raw = body.grade
    const grade = raw === null ? null : normalizeGrade(raw)
    if (raw !== null && grade === null) {
      throw new BadRequestException('grade 必须是 1-12 的整数，或 null')
    }
    const saved = await this.usersService.setGrade(userId, grade, schoolYearStart())
    return {
      code: 200,
      msg: 'success',
      data: {
        grade: saved.grade,
        grade_label: gradeLabel(saved.grade),
        confirmed_year: saved.confirmedYear,
      },
    }
  }
}
