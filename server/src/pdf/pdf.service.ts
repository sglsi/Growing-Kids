import { Injectable, BadRequestException } from '@nestjs/common'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, HeadingLevel,
} from 'docx'
import * as http from 'http'
import * as https from 'https'
import { StorageService } from '../storage/storage.service'
import { TimelineService } from '../timeline/timeline.service'
import { DocumentsService } from '../documents/documents.service'
import { layoutQuestionBlocks, type BlockInput, type RowInput } from './question-block-layout'
import { practiceSpacePoints } from './question-space'
// D-063：A4 / 页边距提到共用模块（一图一页与智能拼页同一套版面常量）
import { A4_PT, PAGE_MARGIN } from './one-image-per-page'
import { normalizeImageSource } from './image-normalize'
import { splitQuestionRuns, hasInlineFigure } from '../shared/inline-figure-runs'

// 图与图之间保留 12pt 空隙，便于剪裁/批注（智能拼页专用）。
const IMAGE_GAP = 12

// Word 版面：docx 的 page.size / margin 单位是 twips（1pt = 20twips），
// ImageRun 的 transformation 单位是像素（docx 内部按 96dpi 换算）。
const A4_TWIP = { width: 11906, height: 16838 }
const DOCX_MARGIN_TWIP = PAGE_MARGIN * 20
/** 正文可用区（px @96dpi）：A4 扣掉四周页边距 */
const DOCX_MAX_W = Math.round(((A4_TWIP.width - DOCX_MARGIN_TWIP * 2) / 20) * (96 / 72))
const DOCX_MAX_H = Math.round(((A4_TWIP.height - DOCX_MARGIN_TWIP * 2) / 20) * (96 / 72))

/** 合成目标格式：pdf（图片拼页）与 docx（图片顺排入 Word） */
export type CombineFormat = 'pdf' | 'docx'

/** 纯文本块（带答案模式）：docx 走原生段落；PDF 渲染成白底位图后与图片一起拼页 */
export interface TextBlock {
  heading?: string
  lines: string[]
}

/** D-087：每个合成单元都带题目归属，版式才能「一题一区块」而不是把图打散重排 */
interface SourceMeta {
  groupKey: string
  role: 'question' | 'answer'
  label: string
  /** D-088：本题要留的做题空白高度（pt），应用题多、填空选择少 */
  spacePt: number
}

interface ImageSource extends SourceMeta {
  id: string
  buffer: Buffer
  isPng: boolean
  width: number
  height: number
}

interface TextSource extends SourceMeta {
  id: string
  text: TextBlock
}

type SourceUnit = ImageSource | TextSource

const isTextUnit = (u: SourceUnit): u is TextSource => 'text' in u

export interface CombineResult {
  url: string
  key: string
  doc_id: string
  /** PDF：实际页数；DOCX：按图高估算的页数 */
  pages: number
  /** PDF：版面填充率；DOCX 恒为 0（不适用） */
  fillRatio: number
  /** 参与合成的图片张数 */
  images: number
}

@Injectable()
export class PdfService {
  constructor(
    private readonly storageService: StorageService,
    private readonly timelineService: TimelineService,
    private readonly documentsService: DocumentsService,
  ) {}

  private download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          this.download(res.headers.location).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`下载素材失败(status ${res.statusCode})`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
      req.setTimeout(60000, () => req.destroy(new Error('下载素材超时')))
      req.on('error', reject)
    })
  }

  /** 素材 id → 已下载的图片（含二进制、格式与像素尺寸）；带答案模式追加文本块单元 */
  private async fetchImages(userId: string, ids: string[], includeAnswers = false): Promise<SourceUnit[]> {
    if (!ids || !ids.length) throw new BadRequestException('请选择要合成的素材')
    const fetched = await this.timelineService.listByIdsWithUrls(userId, ids)
    if (!fetched.length) throw new BadRequestException('未找到所选素材')

    // 保序：Supabase `.in()` 不保证返回顺序，而 docx 承诺「按选择顺序顺排」——
    // 不修就会出现「Word 里图片顺序和列表选择顺序不一致」的偶发错乱。
    const order = new Map(ids.map((id, i) => [id, i]))
    const items = [...fetched].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

    // 展开「合成单元」（思傅 2026-10-26 修 #119）：
    //   · kind=image  → 条目自身主图（1 张）
    //   · kind=question → 题面图逐张入列（content.question_images → question_image_urls）
    //     带答案模式（思傅 2026-10-26）：题面图后紧跟本题的 答案/解析/错误作答 文本块，
    //     缺哪块跳哪块——合成里默认只有题面图（不带答案），带答案由用户显式选择。
    // 复习本里「批量选题 → 合成」是主用法：旧逻辑 kind!=='image' 全跳过，
    // 前端误报「请选择图片资料」、后端就算收到也只会抛「没有可合成的图片」。
    const units: ({ id: string; url?: string; text?: TextBlock } & SourceMeta)[] = []
    for (const it of items) {
      // D-087：题号标签来自用户录入时的 question_label；没有就用选中序号兜底，
      // 但绝不把「第 N 题」写进存量数据——只用于本次合成的可读标题。
      const groupKey = it.id
      const label = ((it.content as { question_label?: string } | undefined)?.question_label || '').trim()
      // D-088：题型从题号标签/题干判定；纯图片题（无题干文字）默认按应用题留白。
      // 家长若知道题型，在题号里写「选择 3」「填空 7」即可自动少留。
      const stemForType = (() => {
        const c = (it.content || {}) as { question?: string; stem?: string }
        return [c.question, c.stem].filter(Boolean).join(' ') || it.title || ''
      })()
      const spacePt = practiceSpacePoints(label, stemForType)
      if (it.kind === 'image' && it.url) {
        units.push({ id: it.id, url: it.url, groupKey, role: 'question', label, spacePt })
      } else if (it.kind === 'question') {
        const qImages = (it.question_image_urls || []).filter(Boolean)
        if (qImages.length) {
          // 题面图里含题干中的几何图/图表/示意图，是「孩子能作答」的关键素材
          qImages.forEach((u, i) => units.push({ id: `${it.id}#q${i}`, url: u, groupKey, role: 'question', label, spacePt }))
        } else {
          // 纯 OCR 文字题（用户只存了识别文字、没有题块照片）：
          // 旧逻辑会一路走到「所选素材中没有可合成的图片」直接 400，练习卷出不来。
          // 改为把题干渲染成文本块，至少保证题目可打印、可作答。
          const content = (it.content || {}) as {
            question?: string
            question_inline_figures?: Array<{ slot: number; file_key: string }>
          }
          const stem = (content.question || '').trim()
          if (stem) {
            const inlineFigs = Array.isArray(content.question_inline_figures) ? content.question_inline_figures : []
            const urls = it.question_inline_figure_urls || []
            const keyBySlot = new Map<number, string>()
            // 槽位 → 签名 URL：按 content 里的顺序对齐（与 withUrls 派生顺序一致）
            inlineFigs.forEach((f, i) => {
              if (f && typeof f.slot === 'number' && urls[i] && !keyBySlot.has(f.slot)) keyBySlot.set(f.slot, urls[i]!)
            })
            if (hasInlineFigure(stem)) {
              // D-075：题干里的 [图N] 原位切成文字块 + 图片单元，避免图统一堆到末尾。
              // 无对应 URL 的标记由 splitQuestionRuns 原样留成文字（fail-closed，不拿邻图顶）。
              splitQuestionRuns(stem, (slot) => keyBySlot.get(slot)).forEach((run, i) => {
                if (run.kind === 'text') {
                  if (run.text.trim()) units.push({ id: `${it.id}#t-stem-${i}`, text: { lines: run.text.split('\n') }, groupKey, role: 'question', label, spacePt })
                } else {
                  units.push({ id: `${it.id}#inline-${run.slot}`, url: run.ref, groupKey, role: 'question', label, spacePt })
                }
              })
            } else {
              units.push({ id: `${it.id}#t-stem`, text: { lines: stem.split('\n') }, groupKey, role: 'question', label, spacePt })
            }
          }
        }
        if (includeAnswers) {
          const c = (it.content || {}) as { wrong_answer?: string; answer?: string; solution?: string }
          // 答案图同样只在「答疑解惑」卷出现，练习卷不带
          const aImages = (it.answer_image_urls || []).filter(Boolean)
          aImages.forEach((u, i) => units.push({ id: `${it.id}#a${i}`, url: u, groupKey, role: 'answer', label, spacePt }))
          if ((c.wrong_answer || '').trim()) {
            units.push({ id: `${it.id}#t-wrong`, text: { heading: '我的错误作答：', lines: (c.wrong_answer || '').split('\n') }, groupKey, role: 'answer', label, spacePt })
          }
          if ((c.answer || '').trim()) {
            units.push({ id: `${it.id}#t-answer`, text: { heading: '正确答案：', lines: (c.answer || '').split('\n') }, groupKey, role: 'answer', label, spacePt })
          }
          if ((c.solution || '').trim()) {
            units.push({ id: `${it.id}#t-solution`, text: { heading: '解析：', lines: (c.solution || '').split('\n') }, groupKey, role: 'answer', label, spacePt })
          }
        }
      }
    }
    if (!units.length) throw new BadRequestException('所选素材中没有可合成的图片')

    const out: SourceUnit[] = []
    for (const u of units) {
      // 文本块单元：不下载，直接作为 SourceUnit 交给下游（docx 原生段落 / PDF 位图渲染）
      if (u.text) {
        out.push({ id: u.id, text: u.text, groupKey: u.groupKey, role: u.role, label: u.label, spacePt: u.spacePt })
        continue
      }
      if (!u.url) continue
      const url = u.url
      let buffer: Buffer
      try {
        buffer = await this.download(url)
      } catch (e) {
        console.error('[combine] 素材下载失败，跳过', u.id, e)
        continue
      }

      // 格式归一：pdf-lib 与 docx 都只吃 PNG/JPEG，而素材里存在 WebP/HEIC 等格式
      // （微信侧产出、以及图片管线中间产物）。不归一会出现「PDF 报没有可合成的
      // 图片」「Word 里图片损坏打不开」——两处症状不同，根因同一个。
      // D-063：逻辑抽到共用单元 image-normalize.ts（复习本合成与资料库多图合成
      // 共用一份），此处不再复制第二份，避免两处格式兼容行为漂移。
      const norm = await normalizeImageSource(buffer, u.id)
      if (!norm) {
        console.error('[combine] 无法解析图片，跳过', u.id)
        continue
      }
      out.push({ id: u.id, groupKey: u.groupKey, role: u.role, label: u.label, spacePt: u.spacePt, ...norm })
    }
    return out
  }

  /**
   * 合成入口：按目标格式分发。
   *
   * - `pdf`：Guillotine-BSSF 智能拼页，多图共用一页，省纸少留白；
   * - `docx`：图片按选择顺序顺排进 Word，家长可继续编辑、加批注后再打印。
   *
   * `includeAnswers`（思傅 2026-10-26）：默认 false——合成的是纯题目卷（只有题面图）；
   * 为 true 时本题的 答案/解析/错误作答 以文本块形式跟在题面图后一并合成。
   */
  async combine(userId: string, ids: string[], format: CombineFormat = 'pdf', includeAnswers = false): Promise<CombineResult> {
    return format === 'docx' ? this.combineIntoDocx(userId, ids, includeAnswers) : this.combineIntoPdf(userId, ids, includeAnswers)
  }

  /**
   * 把文本块渲染成白底 PNG——PDF 没法直接嵌 CJK 字体（pdf-lib 标准字体不含中文），
   * 文本块走位图：sharp 的 SVG 渲染（librsvg/Pango，本机有微软雅黑）出图后与普通图片
   * 一样进拼页流程。渲染失败返回 null：调用方跳过该块并留痕，绝不因单个文本块让合成整体失败。
   */
  private async renderTextPng(block: TextBlock): Promise<{ buffer: Buffer; width: number; height: number } | null> {
    const FS = 36 // 正文字号 px
    const LH = Math.round(FS * 1.75)
    const PAD = 30
    const W = 1400 // 画布宽 px：A4 可用宽下约 40 个汉字/行
    const charW = (ch: string) => (ch.charCodeAt(0) > 0x2e80 ? FS : Math.round(FS * 0.55))
    const wrap = (s: string): string[] => {
      const rows: string[] = []
      let line = ''
      let w = 0
      for (const ch of s) {
        const cw = charW(ch)
        if (w + cw > W - PAD * 2 && line) {
          rows.push(line)
          line = ''
          w = 0
        }
        line += ch
        w += cw
      }
      if (line) rows.push(line)
      return rows.length ? rows : [' ']
    }
    const visual: { text: string; bold: boolean; color: string }[] = []
    if (block.heading) visual.push({ text: block.heading, bold: true, color: '#2E6F4E' })
    for (const l of block.lines) wrap(l).forEach((t) => visual.push({ text: t, bold: false, color: '#1a1a1a' }))
    const H = PAD * 2 + visual.length * LH
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const body = visual
      .map(
        (v, i) =>
          `<text x="${PAD}" y="${PAD + LH * i + Math.round(FS * 0.9)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${FS}" font-weight="${v.bold ? 'bold' : 'normal'}" fill="${v.color}" xml:space="preserve">${esc(v.text)}</text>`,
      )
      .join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`
    try {
      const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
      return { buffer, width: W, height: H }
    } catch (e) {
      console.warn('[combine] 文本块渲染为图片失败，PDF 版跳过该答案区块:', (e as Error)?.message)
      return null
    }
  }

  /**
   * D-087：题号 /「解答」/ 页眉页脚的小型文字标签。
   * 中文仍走 sharp 的 SVG 位图（pdf-lib 标准字体没有 CJK 字形）；
   * 左侧一条 4px 同色细线是唯一的强调元素，其余靠留白与字阶建立层级。
   */
  private async renderLabelPng(
    text: string,
    color: string,
    fontSize = 28,
  ): Promise<{ buffer: Buffer; width: number; height: number } | null> {
    const W = Math.min(500, Math.max(120, [...text].length * fontSize + 44))
    const H = Math.round(fontSize * 1.6)
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/><rect x="0" y="2" width="4" height="${H - 4}" fill="${color}" opacity="0.7"/><text x="16" y="${Math.round(H * 0.72)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${color}" xml:space="preserve">${esc(text)}</text></svg>`
    try {
      const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
      return { buffer, width: W, height: H }
    } catch (e) {
      console.warn('[combine] 标签渲染失败，跳过:', (e as Error)?.message)
      return null
    }
  }

  /**
   * 把选中的素材合成标准 A4 PDF。
   * 素材 = 图片条目自身主图 + 题目条目的题面图（#119 起，见 fetchImages 展开逻辑）。
   *
   * 排版策略（D-087 逐题清晰版式，替代原 Guillotine-BSSF 按图高重排）：
   *  1. 按题目分组，题面图 → 答案图 → 解析保持选中顺序；
   *  2. 每题一区块，带题号标题 /「解答」标签，区块不跨页；
   *  3. 页内纵向流、统一左对齐，行距 10pt / 题距 22pt，页脚标页码；
   *  4. D-088：不画顶部页头，题号缩到 15px，并在题面与答案之间留做题空间
   *     （应用题 96pt / 填空选择 24pt，判据见 question-space.ts）。
   *
   * BSSF 虽省纸，但会打乱题图顺序，导致「题和图不知道哪个是哪个」——已弃用。
   * 结果转存 TOS 并归档进 documents（文档页）。
   */
  async combineIntoPdf(userId: string, ids: string[], includeAnswers = false): Promise<CombineResult> {
    const fetched = await this.fetchImages(userId, ids, includeAnswers)
    if (!fetched.length) throw new BadRequestException('所选素材中没有可合成的图片')

    const pdf = await PDFDocument.create()
    const day = new Date().toLocaleDateString('zh-CN')

    // D-087：按题目分组（Map 保插入顺序 = 用户选题顺序），不再按图高重排。
    // 题面图 → 答案图 → 解析严格相邻；一道题就是一个不可拆的区块。
    const groups = new Map<string, SourceUnit[]>()
    for (const u of fetched) {
      if (!groups.has(u.groupKey)) groups.set(u.groupKey, [])
      groups.get(u.groupKey)!.push(u)
    }

    // 题号 /「解答」标签。中文走 sharp 位图（pdf-lib 标准字体无 CJK 字形）。
    // D-088：题号由 30 缩到 15（用户要求小一半），不再做「顶 header」；
    // 字号：题号 15 / 解答 26 / 页码 20，靠留白与位置而非大标题建立层级。
    type Embedded = { image: any; width: number; height: number }
    const labels = new Map<string, Embedded>()
    let ordinal = 0
    for (const [g, arr] of groups) {
      ordinal += 1
      const title = arr.find((u) => u.label)?.label || `第 ${ordinal} 题`
      const specs: Array<[string, string, string, number]> = [[`${g}:title`, title, '#1F2937', 15]]
      if (arr.some((u) => u.role === 'answer')) {
        specs.push([`${g}:answer`, '解答（思路与过程）', '#2E6F4E', 26])
      }
      for (const [key, text, color, size] of specs) {
        const png = await this.renderLabelPng(text, color, size)
        if (!png) continue
        labels.set(key, { image: await pdf.embedPng(png.buffer), width: png.width, height: png.height })
      }
    }
    // D-088：用户不要顶部「复习资料」页头——整页从第一道题开始，省下的空间留给做题。
    // 页脚页码保留；文档标题仍在 documents.title 里，不靠页眉也能辨认。

    // 内容解码：文本块渲染成白底 PNG；图片格式双向兜底（与旧版一致）
    const decoded: Array<{ key: string; image: any; width: number; height: number; groupKey: string; role: 'question' | 'answer' }> = []
    for (const unit of fetched) {
      let s: ImageSource
      if (isTextUnit(unit)) {
        const png = await this.renderTextPng(unit.text)
        if (!png) continue
        s = { id: unit.id, buffer: png.buffer, isPng: true, width: png.width, height: png.height, groupKey: unit.groupKey, role: unit.role, label: unit.label, spacePt: unit.spacePt }
      } else s = unit
      let image: any
      try {
        try { image = s.isPng ? await pdf.embedPng(s.buffer) : await pdf.embedJpg(s.buffer) }
        catch { image = s.isPng ? await pdf.embedJpg(s.buffer) : await pdf.embedPng(s.buffer) }
      } catch (e) {
        console.error('[pdf] 图片解码失败，跳过', s.id, e)
        continue
      }
      decoded.push({ key: s.id, image, width: image.width || s.width, height: image.height || s.height, groupKey: s.groupKey, role: s.role })
    }
    const byUnit = new Map(decoded.map((d) => [d.key, d]))
    if (!byUnit.size) throw new BadRequestException('所选素材中没有可合成的图片')

    // 一题一区块：题号 → 题面 → 解答标签 → 答案/解析，组间留白 22pt、组内 10pt
    const blocks: BlockInput[] = []
    for (const [g, arr] of groups) {
      const rows: RowInput[] = []
      const title = labels.get(`${g}:title`)
      if (title) rows.push({ key: `__label:${g}:title`, width: title.width, height: title.height, kind: 'label' })
      let answerMarked = false
      for (const u of arr) {
        if (u.role === 'answer' && !answerMarked) {
          answerMarked = true
          const am = labels.get(`${g}:answer`)
          if (am) rows.push({ key: `__label:${g}:answer`, width: am.width, height: am.height, kind: 'label' })
        }
        const d = byUnit.get(u.id)
        if (d) rows.push({ key: d.key, width: d.width, height: d.height, kind: u.role })
      }
      // D-088：在「题面 → 答案」之间插入做题空白；选择/填空 24pt，应用题 96pt。
      // 空白行没有图片，绘制阶段跳过，只占纵向空间；纯图片题按应用题留白。
      const spacePt = arr.find((u) => u.role === 'question')?.spacePt ?? 0
      if (spacePt > 0) {
        const at = rows.findIndex((r) => r.key.startsWith('__label:') && r.key.endsWith(':answer'))
        const spaceRow: RowInput = { key: `__space:${g}`, width: 1, height: spacePt, kind: 'space' }
        if (at >= 0) rows.splice(at, 0, spaceRow)
        else rows.push(spaceRow)
      }
      if (rows.length) blocks.push({ key: g, label: arr.find((u) => u.label)?.label || '', rows })
    }

    const HEADER_H = 0 // D-088：去掉顶部页头
    const FOOTER_H = 26
    const bin = {
      width: A4_PT.width - PAGE_MARGIN * 2,
      height: A4_PT.height - PAGE_MARGIN * 2 - HEADER_H - FOOTER_H,
    }
    const contentTop = A4_PT.height - PAGE_MARGIN - HEADER_H
    const packed = layoutQuestionBlocks(blocks, bin)
    if (!packed.length) throw new BadRequestException('所选素材中没有可合成的图片')

    // y 向下 → pdf-lib y 向上翻转；同一题的题与答永远相邻、不跨页
    let areaSum = 0
    for (let pi = 0; pi < packed.length; pi += 1) {
      const page = pdf.addPage([A4_PT.width, A4_PT.height])
      for (const b of packed[pi].blocks) {
        for (const r of b.rows) {
          const img = r.key.startsWith('__label:')
            ? labels.get(r.key.slice(8))?.image
            : byUnit.get(r.key)?.image
          if (!img) continue
          page.drawImage(img, {
            x: PAGE_MARGIN + r.x,
            y: contentTop - (r.y + r.height),
            width: r.width,
            height: r.height,
          })
          areaSum += r.width * r.height
        }
      }
      const foot = await this.renderLabelPng(`${pi + 1} / ${packed.length}`, '#8A7F72', 20)
      if (foot) {
        page.drawImage(await pdf.embedPng(foot.buffer), {
          x: A4_PT.width - PAGE_MARGIN - foot.width,
          y: PAGE_MARGIN / 2,
          width: foot.width,
          height: foot.height,
        })
      }
    }

    const pages = pdf.getPageCount()
    if (!pages) throw new BadRequestException('所选素材中没有可合成的图片')

    const pdfBuffer = Buffer.from(await pdf.save())
    const title = includeAnswers ? `复习资料（含答案）-${day}.pdf` : `复习资料-${day}.pdf`
    // ⚠️ 对象存储的 key 只接受 ASCII（Supabase 会拒「Invalid key」），中文只能出现在
    //    documents.title（展示名）里——此前用中文 key 上传，切到 supabase 驱动后必然失败。
    const key = await this.storageService.uploadBuffer(pdfBuffer, `review-pack-${Date.now()}.pdf`, 'application/pdf')
    const url = await this.storageService.getPublicUrl(key)
    const docId = await this.archive(userId, {
      title,
      type: 'pdf',
      file_key: key,
      mime_type: 'application/pdf',
      size_bytes: pdfBuffer.length,
      meta: { source_ids: ids, include_answers: includeAnswers, layout: 'question-blocks-v2' },
    })

    const fillRatio = areaSum > 0 ? Math.min(1, areaSum / (pages * bin.width * bin.height)) : 0
    console.log(`[pdf] 逐题版式合成完成：${groups.size} 题 / ${byUnit.size} 张图 → ${pages} 页，填充率 ${(fillRatio * 100).toFixed(1)}%`)
    return { url, key, doc_id: docId, pages, fillRatio, images: byUnit.size }
  }


  /**
   * 把选中的图片合成 Word（.docx），供家长二次编辑、加批注后再打印。
   *
   * 与 PDF 的差异：PDF 走「多图拼页省纸」，Word 走「一图一段顺排」——
   * docx 的排版引擎无法像 pdf-lib 那样精确控制多图同页布局，
   * 强行拼版会导致图片错位/被切断页，因此这里以「可编辑性」为第一目标：
   *   · 单图宽度不超过正文可用宽，高度不超过可用高（保证一图不跨页）；
   *   · 原图小于可用宽时不放大（避免插值糊图）；
   *   · 标题 + 生成信息置顶，图片居中顺排。
   */
  async combineIntoDocx(userId: string, ids: string[], includeAnswers = false): Promise<CombineResult> {
    const fetched = await this.fetchImages(userId, ids, includeAnswers)
    if (!fetched.length) throw new BadRequestException('所选素材中没有可合成的图片')

    const day = new Date().toLocaleDateString('zh-CN')
    const imageCount = fetched.filter((u) => !isTextUnit(u)).length
    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: includeAnswers ? `复习资料（含答案） ${day}` : `复习资料 ${day}`, bold: true, size: 36, font: '黑体' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: `共 ${imageCount} 张图片${includeAnswers ? ' · 含答案与解析' : ''} · 生成于 ${day}`,
            size: 20, color: '6B655D', font: '宋体',
          }),
        ],
      }),
    ]

    let heightSum = 0
    for (const unit of fetched) {
      // 文本块（带答案模式）：Word 原生段落——可编辑、可批注，不走位图
      if (isTextUnit(unit)) {
        const b = unit.text
        if (b.heading) {
          children.push(
            new Paragraph({
              spacing: { before: 160, after: 40 },
              children: [new TextRun({ text: b.heading, bold: true, size: 24, color: '2E6F4E', font: '黑体' })],
            }),
          )
        }
        for (const line of b.lines) {
          children.push(
            new Paragraph({
              spacing: { after: 60 },
              children: [new TextRun({ text: line || ' ', size: 24, font: '宋体' })],
            }),
          )
        }
        continue
      }
      const s = unit
      // 等比缩放到正文可用区内；原图更小则保持原始尺寸（不放大）
      const scale = Math.min(1, DOCX_MAX_W / s.width, DOCX_MAX_H / s.height)
      const width = Math.max(1, Math.round(s.width * scale))
      const height = Math.max(1, Math.round(s.height * scale))
      heightSum += height
      try {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
            children: [
              new ImageRun({
                type: s.isPng ? 'png' : 'jpg',
                data: s.buffer,
                transformation: { width, height },
              }),
            ],
          }),
        )
      } catch (e) {
        console.error('[docx] 图片写入失败，跳过', s.id, e)
      }
    }

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { width: A4_TWIP.width, height: A4_TWIP.height },
              margin: {
                top: DOCX_MARGIN_TWIP,
                right: DOCX_MARGIN_TWIP,
                bottom: DOCX_MARGIN_TWIP,
                left: DOCX_MARGIN_TWIP,
              },
            },
          },
          children,
        },
      ],
    })

    const docxBuffer = Buffer.from(await Packer.toBuffer(doc))
    const title = includeAnswers ? `复习资料（含答案）-${day}.docx` : `复习资料-${day}.docx`
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const key = await this.storageService.uploadBuffer(docxBuffer, `review-pack-${Date.now()}.docx`, mime)
    const url = await this.storageService.getPublicUrl(key)
    const docId = await this.archive(userId, {
      title,
      type: 'docx',
      file_key: key,
      mime_type: mime,
      size_bytes: docxBuffer.length,
      meta: { source_ids: ids, include_answers: includeAnswers },
    })

    // docx 由 Word 排版引擎分页，这里只能按累计图高估算，仅用于前端提示文案
    const pages = Math.max(1, Math.ceil(heightSum / DOCX_MAX_H))
    console.log(`[docx] 合成完成：${imageCount} 张图${includeAnswers ? ' + 答案文本块' : ''}，估算 ${pages} 页`)
    return { url, key, doc_id: docId, pages, fillRatio: 0, images: imageCount }
  }

  /** 归档进文档页。入库失败不影响合成结果返回，但必须打全错（best-effort catch 铁律） */
  private async archive(
    userId: string,
    input: { title: string; type: string; file_key: string; mime_type: string; size_bytes: number; meta?: Record<string, unknown> },
  ): Promise<string> {
    try {
      const doc = await this.documentsService.create(userId, input)
      return doc.id
    } catch (e) {
      console.error('[combine] 文档记录入库失败（不影响返回）', input.title, e)
      return ''
    }
  }
}
