import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ContentCheckService } from './content-check.service'

// ============================================================
// UGC 文本入库前闸门（D-059 / 方案 A）
//
// 背景：D-057 收起 AI 入口、D-058 删除智能客服页面后，全仓 `checkText()`
// 只剩 chat.service.ts 一处调用，而 chat 前端已不可达 ⇒ 用户可产出文本的
// 链路上内容安全 API 调用数为 0，UGC 声明里 method=1 无法如实勾选。
//
// 做法：把现成的 ContentCheckService 复用到用户真正写入文本的落点，
// 命中违规（reject / risky）直接抛 400 拒绝入库。
//
// ⚠️ 边界（必须在文档里如实说明，别把「接入」说成「全覆盖」）：
//  · 检测不可用时（无凭据 / 接口异常 / 匿名用户无 openid）底层是 best-effort
//    **放行**，与原有设计一致；本闸门不改变这一取舍。
//  · 只送「用户主动输入/编辑的短文本」，不送 OCR 全文、文件正文、图片 key、
//    base64、URL —— 既避免误把机器生成内容算作 UGC，也控制外发范围。
//  · 批量保存合并为一次检测调用，避免逐题往返把 60s 前端超时打穿。
// ============================================================

/** 命中违规时给用户的统一文案（不要透露 label / 命中词，避免变成绕过提示） */
export const UGC_REJECT_MESSAGE = '内容包含不适宜的文字，请修改后再保存'

export interface UgcCheckOptions {
  /** 微信 msgSecCheck v2 scene：1 资料 / 2 评论 / 3 论坛 / 4 社交日志 */
  scene?: 1 | 2 | 3 | 4
  /** 只进结构化日志，便于定位是哪条链路拦下的，不写用户文本 */
  tag?: string
}

@Injectable()
export class UgcTextGuard {
  private readonly logger = new Logger('UgcTextGuard')

  constructor(private readonly contentCheck: ContentCheckService) {}

  /**
   * 汇总本次写入的用户文本并过检；命中违规拒绝入库。
   *
   * @param parts 本次**实际要写入**的文本字段值（未改动的旧值不要传，
   *              否则每次改图片都会把整篇旧内容重发一遍）
   */
  async assertAllowed(
    userId: string,
    parts: Array<string | null | undefined>,
    opts: UgcCheckOptions = {},
  ): Promise<void> {
    const seen = new Set<string>()
    const lines: string[] = []
    for (const p of parts) {
      if (typeof p !== 'string') continue
      const t = p.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      lines.push(t)
    }
    if (!lines.length) return

    const result = await this.contentCheck.checkText(lines.join('\n'), {
      userId,
      scene: opts.scene ?? 2,
    })
    if (result.allowed) return

    // 只记元数据：绝不把用户文本写进日志
    this.logger.warn(
      `[ugc] 拒绝入库 tag=${opts.tag ?? '-'} suggest=${result.suggest} label=${result.label ?? '-'}`,
    )
    throw new BadRequestException(UGC_REJECT_MESSAGE)
  }
}

/**
 * 从题目内容对象里挑出用户可编辑文本（白名单）。
 *
 * ⚠️ 刻意**不**用递归全量收集：content 里还有 file_key / url / 附件名 /
 *    机器生成的错因 JSON，把它们送去检测既无意义又扩大外发范围。
 */
export function questionTexts(c: {
  question?: string
  answer?: string
  solution?: string
  wrong_answer?: string
  stem?: string
  question_label?: string
} | null | undefined): Array<string | undefined> {
  if (!c) return []
  return [c.question, c.answer, c.solution, c.wrong_answer, c.stem, c.question_label]
}
