// 模块 56：题干内嵌图扩展到「列表 + 导出」静态契约（D-075，P-034 扩展）
//
// 🔴 只守静态契约 + 源头零依赖。docx/PDF 里图是否真原位渲染、真机列表卡片
//    rich-text 是否真换成图——由动态实证与真机回归另行证明；本模块不得被当成
//    「已验证面客效果」的证据。
//
// 边界：C 链（识别页即时导出）针对未入库内容，天然无内嵌图，明确不接入。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M56', '题干内嵌图：列表带图 + 导出原位插图（D-075）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const RUNS = 'server/src/shared/inline-figure-runs.ts'
const DOC = 'server/src/document/document.service.ts'
const PDF = 'server/src/pdf/pdf.service.ts'
const OCR = 'server/src/ocr/ocr.service.ts'
const CARD = 'src/components/review-item-card.tsx'
const DYN = 'dynamic-tests/run-inline-figure-runs-d075.cjs'

m.test('B1 切段 helper 零依赖 + fail-closed', (c) => {
  c.ok(exists(RUNS), '须有服务端共用切段 helper')
  const s = read(RUNS)
  c.ok(!/^import /m.test(s), '切段 helper 必须零依赖（dynamic-tests 要真实转译执行）')
  c.ok(/export function splitQuestionRuns/.test(s), '须导出 splitQuestionRuns')
  c.ok(/export function hasInlineFigure/.test(s), '须导出 hasInlineFigure')
  c.ok(/\\\[图\(\\d\+\)\\\]/.test(s), '占位符正则须认 [图N]')
  c.ok(/else pushText\(m\[0\]\)/.test(s), '缺引用时原样输出 [图N] 文字（fail-closed，不拿邻图顶）')
  c.ok(/if \(ref\) runs\.push/.test(s), '有引用才生成 figure 段')
})

m.test('B2 导出 A 链：题干原位交错插图 + 护栏', (c) => {
  const s = read(DOC)
  c.ok(/import \{ splitQuestionRuns, hasInlineFigure \}/.test(s), 'A 链须接入共用切段 helper')
  c.ok(/question_inline_figures\?: Array<\{ slot: number; file_key: string \}>/.test(s), 'RawRow 须声明内嵌图字段')
  c.ok(/private async questionParagraphs/.test(s), '须有题干切段段落方法')
  c.ok(/splitQuestionRuns\(question/.test(s), '题干按 [图N] 切段')
  c.ok(/private async inlineFigureParagraph/.test(s), '须有单图段落方法（复用 storage key 直读）')
  c.ok(/readObject\(key\)/.test(s), 'A 链内嵌图走 storage key 直读，不走签名 URL 回环')
  c.ok(/embedded >= MAX_IMAGES_PER_QUESTION/.test(s), '内嵌图须受单题图片数上限护栏')
  c.ok(/imageParagraphs/.test(s) && /questionImageKeys/.test(s), '原 question_images 后置路径保持不回归')
})

m.test('B3 导出 B 链：纯文字题的 [图N] 原位交错 + 签名 URL', (c) => {
  const s = read(PDF)
  c.ok(/import \{ splitQuestionRuns, hasInlineFigure \}/.test(s), 'B 链须接入共用切段 helper')
  c.ok(/question_inline_figure_urls/.test(s), 'B 链须取签名 URL（listByIdsWithUrls 已派生）')
  c.ok(/splitQuestionRuns\(stem/.test(s), '纯文字题题干按 [图N] 切段')
  c.ok(/#inline-\$\{run\.slot\}/.test(s), '内嵌图单元须按 slot 编号（保序、可追溯）')
  c.ok(/hasInlineFigure\(stem\)/.test(s), '无标记时保持原纯文本路径（零回归）')
  // C 链明确不接入
  const ocr = read(OCR)
  c.ok(!/inline-figure-runs/.test(ocr) && !/question_inline_figures/.test(ocr), 'C 链识别页即时导出不接入（未入库无内嵌图，范围边界）')
})

m.test('B4 列表卡片：按 slot 带图 + 无图零回归', (c) => {
  const s = read(CARD)
  c.ok(/import \{ questionRichHtml \} from '@\/lib\/question-inline-figure'/.test(s), '列表须复用前端零依赖 helper（不复制正则）')
  c.ok(/question_inline_figure_urls/.test(s), '列表须取签名 URL 组装插图')
  c.ok(/inlineFigs\.map\(\(f, i\) => \(\{ slot: f\.slot, url: inlineUrls\[i\] \}\)\)/.test(s), '须按 content 同序把 URL 映射到 slot')
  c.ok(/<RichText nodes=\{stemNodes\} \/>/.test(s), '有图时用 RichText 渲染题干')
  c.ok(/maxHeight: 160/.test(s), '列表图片摘要须限高，避免撑爆卡片')
  c.ok(/truncate\(c\.question \|\| '', 80\)/.test(s), '无内嵌图时仍走原纯文本摘要（零回归）')
})

m.test('B5 动态实证脚本覆盖', (c) => {
  c.ok(exists(DYN), '须有可复跑的动态实证脚本')
  const d = read(DYN)
  for (const kw of ['两段文字 + 两图的交错序列正确', '只有有引用的槽位 2 出图', '缺引用的 [图1]/[图9] 原样留在文字里', '图段夹在文字之间', '[图10] 与 [图1] 各自独立解析', 'C 链识别页即时导出不接入']) {
    c.ok(d.includes(kw), `实证须覆盖「${kw}」`)
  }
})

export default m
