// 模块 66：图片答案状态 / PDF 后续页 / 批量全选 / 复习资料逐题版式（D-087）
//
// 🔴 静态契约 + 纯函数版式契约。真机/生产还需验：
//    加答案图后角标消失、第 11 页能加载、批量态两个按钮、复习资料一眼能认出题与答。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M66', '答案状态 / 后续页 / 批量全选 / 逐题版式（D-087）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const TYPES = 'src/types/index.ts'
const API = 'src/services/api.ts'
const AE = 'src/components/answer-editor.tsx'
const PICKER = 'src/components/pdf-page-picker.tsx'
const HOOK = 'src/lib/use-selection.ts'
const BAR = 'src/components/selection-bar.tsx'
const PY = 'ocr-engine/pdf_tool.py'
const PTOOL = 'server/src/ocr/pdf-tool.ts'
const OCR = 'server/src/ocr/ocr.service.ts'
const CTRL = 'server/src/ocr/ocr.controller.ts'
const PDF = 'server/src/pdf/pdf.service.ts'
const LAYOUT = 'server/src/pdf/question-block-layout.ts'

m.test('A1 图片答案入库后不再挂「待找答案」', (c) => {
  const types = read(TYPES)
  const itemStatus = types.slice(types.indexOf('export function itemStatus'), types.indexOf('export function formatTime'))
  c.ok(/answer_images[\s\S]{0,200}answer_image_urls/.test(itemStatus), 'status 判定须认得答案图')
  c.ok(/answer_attachments[\s\S]{0,160}hasFileAnswer/.test(itemStatus), 'status 判定须认得附件答案')
  c.ok(/if \(hasImageAnswer \|\| hasFileAnswer\) return 'answered'/.test(itemStatus), '有答案载体时优先判为已答')
  const api = read(API)
  const save = api.slice(api.indexOf('export function saveAnswer('), api.indexOf('// ============================================================', api.indexOf('export function saveAnswer(')))
  c.ok(/attachments \|\| \[\]\)\.some\(\(a\) => !!\((a\?\.file_key|a\?\.url)/.test(save) &&
    /'answered' : undefined/.test(save), '只加图片附件也要把 status 翻成 answered')
})

m.test('A2 页图按 start_page 增量加载，缩略图看得到后续页', (c) => {
  const py = read(PY)
  c.ok(/def extract_pdf\([^)]*start_page=0/.test(py), 'py 工具须接受 0 基起始页')
  c.ok(/for i in range\(start, start \+ limit\)/.test(py), '只渲染本批页，不重渲前 N 页')
  c.ok(/--start-page/.test(py), 'py CLI 须暴露 --start-page')
  const tool = read(PTOOL)
  c.ok(/startPage\?: number/.test(tool) && /'--start-page'/.test(tool), 'TS 调用链须传 startPage')
  const ocr = read(OCR)
  c.ok(/startPageRaw\?: number/.test(ocr) && /startPage,\r?\n\s+timeoutMs/.test(ocr),
    '后端服务须把 startPage 交给提取器')
  c.ok(/Math\.min\(Math\.max\(Number\(maxPagesRaw[\s\S]{0,120}10\)/.test(ocr), '每批仍限 10 页，防止一次渲太多')
  c.ok(/start_page\?: number/.test(read(CTRL)), 'controller DTO 须接受 start_page')
  const api = read(API)
  c.ok(/fetchDocPages\(fileUrl: string, maxPages = 10, startPage = 0\)/.test(api) &&
    /start_page: startPage/.test(api), '前端 API 须传 start_page')
  const ae = read(AE)
  c.ok(/loadMorePdfPages/.test(ae) && /fetchDocPages\(s\.url, 10, start\)/.test(ae), '面板须有增量加载入口')
  c.ok(/pages: \[\.\.\.s\.pages, \.\.\.added\]/.test(ae), '新页追加，已有页与命中框不丢')
  const pk = read(PICKER)
  c.ok(/onLoadMore\?: \(\) => void/.test(pk) && /加载后续页/.test(pk), '缩略图面板须显示「加载后续页」')
  c.ok(/已加载 \{pages\.length\} 页/.test(pk), '已加载 / 总页数要可见')
})

m.test('A3 批量选择态常驻「全选」「全部取消」', (c) => {
  const hook = read(HOOK)
  c.ok(/selectAll: \(ids: string\[\]\) => void/.test(hook) &&
    /setSelected\(new Set\(ids\)\)/.test(hook), '全选必须是赋值，不能逐项 toggle 反转')
  const bar = read(BAR)
  c.ok(/clearLabel = '全部取消'/.test(bar), '默认文案改为「全部取消」')
  c.ok(/onClick=\{onClearAll \|\| selection\.clear\}/.test(bar), '取消按钮常驻（0 选也可点）')
  c.ok(/onSelectAll \? \(/.test(bar), '提供 handler 才显示「全选」')
  const pages = ['src/pages/index/index.tsx', 'src/pages/library/index.tsx', 'src/pages/subject/index.tsx', 'src/pages/memory/index.tsx']
  const missing = pages.filter((f) => !/onSelectAll=/.test(read(f)))
  c.ok(missing.length === 0, `还有列表没接全选：${missing.join(', ') || '无'}`)
  c.ok(!/forEach\(\(m\) => sel\.toggle\(m\.id\)\)/.test(read(pages[3])), '记忆页不许再 toggle 式伪全选')
})

m.test('A4 复习资料按题分块、保序、带题号与页脚（D-088 去页头）', (c) => {
  c.ok(fs.existsSync(path.join(ROOT, LAYOUT)), '须有独立的逐题版式纯函数模块')
  const layout = read(LAYOUT)
  c.ok(/export function layoutQuestionBlocks/.test(layout) &&
    /for \(const b of blocks\)/.test(layout), '版式须按入参顺序逐块放置，不按尺寸重排')
  c.ok(/if \(y > 0 && y \+ need > bin\.height/.test(layout), '放不下的整题移到下一页（区块不跨页）')
  c.ok(/0\.6/.test(layout) && /blockGap \?\? 22/.test(layout), '单图高上限 60%，题间留白 22pt')
  const pdf = read(PDF)
  c.ok(/import \{ layoutQuestionBlocks/.test(pdf), '主 PDF 须走逐题版式')
  c.ok(!/const packed = packPages\(inputs, bin/.test(pdf), '复习资料不许再用 BSSF 重排（会打乱题图顺序）')
  c.ok(/const groups = new Map<string, SourceUnit\[\]>\(\)/.test(pdf), '合成单元须按题目分组')
  c.ok(/role: 'answer'/.test(pdf) && /`\$\{g\}:answer`/.test(pdf), '含答案时须有「解答」分隔标签')
  c.ok(/renderLabelPng\(/.test(pdf) && /question_label/.test(pdf), '题号来自 question_label，中文标签走位图')
  c.ok(/第 \$\{pi \+ 1\} \/ \$\{packed\.length\} 页?|`\$\{pi \+ 1\} \/ \$\{packed\.length\}`/.test(pdf), '每页须标页码')
  c.ok(/layout: 'question-blocks-v2'/.test(pdf), '产物须记版式版本（D-088 bump v2），便于回溯旧文件')
})

export default m
