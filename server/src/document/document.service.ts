import { Injectable } from '@nestjs/common'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, Footer, PageNumber, BorderStyle,
} from 'docx'
import { getSupabaseClient } from '../storage/database/supabase-client'

interface ExportParams {
  subject_id?: string
  start_date?: string
  end_date?: string
  title: string
  /** 是否包含已掌握题目；默认 false（已掌握题目不进入汇总） */
  include_mastered?: boolean
}

interface RawRow {
  id: string
  question_content: string
  answer_content: string
  solution: string
  wrong_answer: string
  source: string
  recognized_at: string
  subjects: { id: string; name: string } | null
}

@Injectable()
export class DocumentService {
  private async queryRows(params: ExportParams): Promise<RawRow[]> {
    const client = getSupabaseClient()
    let q = client
      .from('questions')
      .select('id, question_content, answer_content, solution, wrong_answer, source, recognized_at, subjects:subject_id(id, name)')

    if (params.subject_id) q = q.eq('subject_id', params.subject_id)
    if (params.start_date) q = q.gte('recognized_at', params.start_date)
    if (params.end_date) q = q.lte('recognized_at', params.end_date)
    if (!params.include_mastered) q = q.eq('mastered', false)
    q = q.order('recognized_at', { ascending: true })

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

  async exportDocx(params: ExportParams): Promise<Buffer> {
    const rows = await this.queryRows(params)

    // 按学科分组（subject_id 指定时也走分组逻辑，保持结构统一）
    const groupMap = new Map<string, { name: string; rows: RawRow[] }>()
    rows.forEach((row) => {
      const sid = row.subjects?.id || 'none'
      const name = row.subjects?.name || '未分类'
      if (!groupMap.has(sid)) groupMap.set(sid, { name, rows: [] })
      groupMap.get(sid)!.rows.push(row)
    })

    const children: Paragraph[] = []

    // 封面标题
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
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BE3E2D' } },
        children: [
          new TextRun({
            text: `共 ${rows.length} 题 · 生成于 ${new Date().toLocaleDateString('zh-CN')}`,
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
          children: [new TextRun({ text: group.name, bold: true, size: 30, color: 'BE3E2D', font: '黑体' })],
        }),
      )

      group.rows.forEach((row) => {
        questionNo += 1
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 80 },
            children: [new TextRun({ text: `${questionNo}. `, bold: true, size: 24, font: '宋体' })],
          }),
        )
        children.push(...this.textParagraphs(row.question_content, { size: 22 }))

        if (row.wrong_answer) {
          children.push(
            new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '我的错误作答：', size: 20, color: '9A948A', font: '宋体' })] }),
          )
          children.push(...this.textParagraphs(row.wrong_answer, { size: 20, color: '9A948A' }))
        }

        children.push(
          new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '正确答案：', bold: true, size: 22, color: 'BE3E2D', font: '宋体' })] }),
        )
        children.push(...this.textParagraphs(row.answer_content || '（暂无答案，待补充）', { size: 22 }))

        if (row.solution) {
          children.push(
            new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: '解析：', bold: true, size: 22, font: '宋体' })] }),
          )
          children.push(...this.textParagraphs(row.solution, { size: 22 }))
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
