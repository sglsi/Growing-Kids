// 模块 64：答案添加——页缩略图选页 + 按题号定位 + 跨页连续裁剪（D-085）
//
// 🔴 静态契约。真机验的是：缩略图看得清不清、定位命中页是否准确、跨页能否连续裁。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M64', '答案页缩略图选择 / 按题号定位 / 跨页连续裁剪（D-085）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const PICKER = 'src/components/pdf-page-picker.tsx'
const ANS = 'src/components/answer-editor.tsx'

m.test('A1 页选择改为缩略图网格，不再用文字页码 ActionSheet', (c) => {
  const p = read(PICKER)
  c.ok(/export default function PdfPagePicker/.test(p), '须有独立的页缩略图面板')
  c.ok(/pages\.map\(\(p\)[\s\S]{0,900}TaroImage/.test(p), '每页须渲染缩略图而不是纯文字页码')
  c.ok(/第 \{p\.index\} 页/.test(p), '缩略图须带页码徽标')
  c.ok(/onClick=\{\(\) => onPick\(p, hit\?\.rect \|\| null\)\}/.test(p), '点缩略图须直接进裁剪')
  c.ok(/e\.stopPropagation\(\)[\s\S]{0,80}onPreview\(p\.url\)/.test(p), '「看大图」须独立热区且不触发裁剪')
  const a = read(ANS)
  c.ok(!/Taro\.showActionSheet\(/.test(a), '不许再用 ActionSheet 列页码（6 项上限且看不到内容）')
  c.ok(/pages = r\.pages\.map\(\(p, i\) => \(\{ index: p\.index \|\| i \+ 1, url: p\.url \}\)\)/.test(a),
    '页图须转成带页码的项再交给面板')
  c.ok(/setPdfPages\(session\)/.test(a), '多页 PDF 须打开缩略图面板')
})

m.test('A2 裁完一张自动回到页列表，跨页可连续裁', (c) => {
  const a = read(ANS)
  c.ok(/const cropFromPdfRef = useRef</.test(a), '须记住本次 PDF 会话')
  c.ok(/cropFromPdfRef\.current = pdfPages[\s\S]{0,120}openCrop\(page\.url, rect\)/.test(a),
    '选页时记住会话再进裁剪')
  c.ok(/const back = cropFromPdfRef\.current[\s\S]{0,160}setPdfPages\(back\)/.test(a),
    '裁剪确认后须自动回页列表（否则又要重新添加文件选页）')
  c.ok(/setAddedFromPdf\(\(n\) => n \+ 1\)/.test(a), '回列表须能看到「已加入 N 张」')
  c.ok(/onCancel=\{\(\) => \{[\s\S]{0,220}setPdfPages\(back\)/.test(a), '取消裁剪也应回列表，不逼用户重选文件')
})

m.test('A3 按题号定位：题号来源 + 纯函数定位 + 命中页预置框', (c) => {
  const a = read(ANS)
  c.ok(/function pickQuestionNo\(/.test(a), '须有题号提取（question_label 优先，题干兜底）')
  c.ok(/const label = \(item\?\.content\?\.question_label \|\| ''\)\.trim\(\)/.test(a), '题号标签优先')
  c.ok(/const byLine = text\.match\(/.test(a), '没有标签时从题干行首题号兜底')
  c.ok(/locateQuestions\(r\.page_text, r\.page\.w, r\.page\.h, \[no\]\)/.test(a), '须复用 P-031 定位纯函数')
  c.ok(/const rect = hit\.answerRect \|\| hit\.stemRect/.test(a), '优先解答区，其次题目区')
  c.ok(/setPageHits\(\(prev\) => \(\{ \.\.\.prev, \[p\.index\]: \{ label: `第 \$\{no\} 题`, rect \} \}\)\)/.test(a),
    '命中页须打徽标（让用户知道在哪页）')
  c.ok(/initialCrop=\{cropRect \|\| undefined\}/.test(a), '命中后进裁剪须预置框住该题')
  c.ok(/if \(!hit \|\| !hit\.located\) continue/.test(a), '未定位的页不得给假框（fail-closed）')
})

m.test('A4 定位要预热、可中止、单页失败不终止', (c) => {
  const a = read(ANS)
  c.ok(/await warmupQuiet\(\)[\s\S]{0,200}for \(let i = 0; i < session\.pages\.length/.test(a),
    '逐页 OCR 前须预热侧车（冷启动 15s 不该叠在第一页上）')
  c.ok(/if \(locateCancelRef\.current\) return/.test(a), '关面板/选页后须中止循环')
  c.ok(/rectify: false/.test(a), 'PDF 页图已摆正，OCR 不得再摆正（二次透视会拉塌小图）')
  c.ok(/catch \(e\) \{[\s\S]{0,160}continue/.test(a), '单页识别失败须继续下一页，不能整批放弃')
  c.ok(/前 \$\{session\.pages\.length\} 页没找到第 \$\{no\} 题/.test(a), '全部未命中须明确告知并可手工框')
})

export default m
