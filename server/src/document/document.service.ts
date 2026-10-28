import { Injectable } from '@nestjs/common'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, Footer, PageNumber, BorderStyle,
} from 'docx'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { cleanStr, cleanDate } from '../shared/query-param'

interface ExportParams {
  subject_id?: string
  start_date?: string
  end_date?: string
  title: string
  /** 是否包含已掌握题目；默认 false（已掌握题目不进入汇总） */
  include_mastered?: boolean
  /**
   * 指定题目 id 白名单（详情页「导出打印」用）：只导出这几条，忽略时间/掌握筛选。
   * 思傅 2026-10-26 修「详情页导出打印带出其他题目」——旧端点只有 subject 维度筛选，
   * 详情页传 subject_id 会把整科题目全导出来。
   */
  ids?: string[]
  /**
   * 是否包含答案/解析/错误作答区块。
   *
   * ⚠️ 语义已于 2026-10-28 统一（GK-OPS-18 `R-技术-13` 关闭）：
   * **不传 / undefined = 不含答案**（与 `pdf/combine` 一致）。
   *
   * 旧实现是 `!== false` ⇒ 不传就含答案，而汇总页恰好不传，于是同一个产品里
   * 「汇总导出」和「复习本合成」对"默认给什么"给出相反答案。产品口径裁定为：
   * **本产品的主用途是打给孩子做练习**（打印练习），答案属于"对答案/讲解"的
   * 第二用途，必须明示索取 —— 默认给答案等于把练习卷变成答案纸。
   */
  include_answers?: boolean
}

interface RawRow {
  id: string
  content: {
    question?: string
    answer?: string
    solution?: string
    wrong_answer?: string
    error_analysis?: { type?: string; label?: string; reason?: string; suggestion?: string } | null
    review_count?: number
  }
  /**
   * C4（0019 迁移）后复习档位是**列**，不再在 content 里。
   * 旧导出只读 content.review_count ⇒ 迁移后「复习进度」一行静默消失。
   * 这里同时保留 content 兜底，兼容迁移前遗留数据。
   */
  review_count?: number | null
  source: string | null
  created_at: string
  subjects: { id: string; name: string } | null
}

@Injectable()
export class DocumentService {
  /** 数据源：timeline_items 中 kind=question 的条目（content jsonb） */
  private async queryRows(userId: string, params: ExportParams): Promise<RawRow[]> {
    const client = getSupabaseClient()
    let q = client
      .from('timeline_items')
      .select('id, content, review_count, source, created_at, subjects:subject_id(id, name)')
      .eq('user_id', userId)
      .eq('kind', 'question')
      .is('deleted_at', null)

    // 脏参数防御：'undefined'/'null' 这类字符串当真值过滤会静默查不到数据，
    // 喂给日期列更会让 Postgres 解析失败直接 500
    const ids = (params.ids || []).filter((x) => typeof x === 'string' && x)
    const subjectId = cleanStr(params.subject_id)
    const startDate = cleanDate(params.start_date)
    const endDate = cleanDate(params.end_date)
    if (ids.length) {
      // 指定 id 白名单：精确导出这几条（详情页「导出打印」），不再叠加学科/时间/掌握筛选
      q = q.in('id', ids)
    } else {
      if (subjectId) q = q.eq('subject_id', subjectId)
      if (startDate) q = q.gte('created_at', startDate)
      if (endDate) q = q.lte('created_at', endDate)
      if (!params.include_mastered) q = q.eq('mastered', false)
    }
    q = q.order('created_at', { ascending: true })

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data || []) as unknown as RawRow[]
  }

  private textParagraphs(text: string, opts: { bold?: boolean; color?: string; size?: number; spacing?: number } = {}) {
    const lines = (text || '').split('\n')
    return lines.map(
      (line) =>
        new Paragraph({
          spacing: { after: opts.spacing ?? 60 },
          children: [
            new TextRun({
              text: line || ' ',
              bold: opts.bold,
              color: opts.color,
              size: opts.size ?? 22,
              font: '宋体',
            }),
          ],
        }),
    )
  }

  async exportDocx(userId: string, params: ExportParams): Promise<Buffer> {
    const rows = await this.queryRows(userId, params)

    const groupMap = new Map<string, { name: string; rows: RawRow[] }>()
    rows.forEach((row) => {
      const sid = row.subjects?.id || 'none'
      const name = row.subjects?.name || '未分类'
      if (!groupMap.has(sid)) groupMap.set(sid, { name, rows: [] })
      groupMap.get(sid)!.rows.push(row)
    })

    const children: Paragraph[] = []

    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: params.title, bold: true, size: 40, font: '黑体' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2E6F4E' } },
        children: [
          new TextRun({
            // 「练习卷 / 答疑解惑」写进副标题：两份 Word 打出来长得几乎一样，
            // 不标版本就只能靠翻到答案那一页才知道手里拿的是哪一份。
            text: `共 ${rows.length} 题 · ${params.include_answers === true ? '答疑解惑（含答案与解析）' : '练习卷（不含答案）'} · 生成于 ${new Date().toLocaleDateString('zh-CN')}`,
            size: 20, color: '6B655D', font: '宋体',
          }),
        ],
      }),
    )

    let questionNo = 0
    for (const group of groupMap.values()) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 160 },
          children: [new TextRun({ text: group.name, bold: true, size: 30, color: '2E6F4E', font: '黑体' })],
        }),
      )

      group.rows.forEach((row) => {
        questionNo += 1
        const c = row.content || {}
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 80 },
            children: [new TextRun({ text: `${questionNo}. `, bold: true, size: 24, font: '宋体' })],
          }),
        )
        children.push(...this.textParagraphs(c.question || '', { size: 22 }))

        // 答案区块（2026-10-28 语义统一）：只有显式 include_answers === true 才输出，
        // 不传 = 打印练习卷。与 pdf/combine 保持一致，避免同一产品两种默认。
        const withAnswers = params.include_answers === true
        if (withAnswers && c.wrong_answer) {
          children.push(
            new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '我的错误作答：', size: 20, color: '9A948A', font: '宋体' })] }),
          )
          children.push(...this.textParagraphs(c.wrong_answer, { size: 20, color: '9A948A' }))
        }

        if (withAnswers) {
          children.push(
            new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '正确答案：', bold: true, size: 22, color: '2E6F4E', font: '宋体' })] }),
          )
          children.push(...this.textParagraphs(c.answer || '（暂无答案，待补充）', { size: 22 }))

          if (c.solution) {
            children.push(
              new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '解析：', bold: true, size: 22, font: '宋体' })] }),
            )
            children.push(...this.textParagraphs(c.solution, { size: 22 }))
          }
        }

        // P2-16 错因分析（本地规则引擎结论；无则跳过；纯题目卷不输出）
        if (withAnswers && c.error_analysis?.label) {
          children.push(
            new Paragraph({
              spacing: { before: 40, after: 20 },
              children: [new TextRun({ text: `错因分析：${c.error_analysis.label}`, bold: true, size: 20, color: '2E6F4E', font: '宋体' })],
            }),
          )
          if (c.error_analysis.reason) {
            children.push(...this.textParagraphs(`原因：${c.error_analysis.reason}`, { size: 20, color: '9A948A' }))
          }
          if (c.error_analysis.suggestion) {
            children.push(...this.textParagraphs(`建议：${c.error_analysis.suggestion}`, { size: 20 }))
          }
        }

        // P2-18 复习进度（C4 后档位在列上；只有打印练习卷才写）
        const reviewCount =
          typeof row.review_count === 'number' ? row.review_count : (typeof c.review_count === 'number' ? c.review_count : 0)
        if (reviewCount > 0) {
          children.push(
            new Paragraph({
              spacing: { before: 20, after: 20 },
              children: [new TextRun({ text: `复习进度：已复习 ${reviewCount} 次`, size: 18, color: '6B655D', italics: true, font: '宋体' })],
            }),
          )
        }

        if (row.source) {
          children.push(
            new Paragraph({
              spacing: { before: 40, after: 120 },
              children: [new TextRun({ text: `来源：${row.source}`, size: 18, color: '9A948A', italics: true, font: '宋体' })],
            }),
          )
        }
      })
    }

    if (!rows.length) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 1200 },
          children: [new TextRun({ text: '所选条件下暂无题目', size: 24, color: '9A948A', font: '宋体' })],
        }),
      )
    }

    const doc = new Document({
      styles: { default: { document: { run: { font: '宋体', size: 22 } } } },
      sections: [
        {
          properties: {},
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], size: 18, color: '9A948A', font: '宋体' }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    })

    return Packer.toBuffer(doc)
  }
}
