// 模块 62：一次裁剪=一道题 / 换页不覆盖 / 错题提取与已存题目可裁剪答案（D-082）
//
// 🔴 静态契约，真机手感（多页连裁是否还丢题、答案图是否随题入库）由思傅验收。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M62', '裁剪不覆盖 / 裁剪答案 / 已存题目答案裁剪（D-082）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const REC = 'src/pages/recognize/index.tsx'
const ANS = 'src/components/answer-editor.tsx'

m.test('A1 手动裁剪：一次任务=一道新题，取消不留空题', (c) => {
  const s = read(REC)
  c.ok(/const startCrop = \(entryIdx: number \| 'new'/.test(s), '裁剪入口须区分「新题」与「补到本题」')
  c.ok(/onClick=\{\(\) => startCrop\('new', 'stem'\)\}/.test(s), '默认入口必须是新题，不能往当前题里塞')
  c.ok(/setCropEditor\(\{ src: page\.url, entryIdx: -1, kind: 'stem' \}\)/.test(s), '-1 = 确认后才建的新题')
  c.ok(
    /if \(task\.entryIdx < 0\) \{[\s\S]{0,260}\.\.\.prev,[\s\S]{0,160}images: \[img\]/.test(s),
    '新题只在裁剪确认后创建，图随题一起建',
  )
  c.ok(!/setBoard\(prev => \[\.\.\.prev, \{ id: \+\+boardIdRef\.current, text: '', images: \[\]\}\]\)/.test(s),
    '打开编辑器时不许先建空题（退出会留垃圾题）')
  c.ok(/cropKey=\{`manual-\$\{cropEditor\.entryIdx\}-\$\{cropEditor\.kind\}/.test(s), '换题/换类型须重置裁剪框')
})

m.test('A2 按题号提取：换页重新定位前先收编上一批已裁题', (c) => {
  const s = read(REC)
  const start = s.indexOf('const handleLocateBySeq =')
  const end = s.indexOf('const handleFillFigures =', start)
  const fn = s.slice(start, end)
  c.ok(/appendSeqRowsToBoard\(seqRows\)/.test(fn), '重新定位前须把上一批已裁题加入清单')
  c.ok(/const carried = appendSeqRowsToBoard\(seqRows\)/.test(fn), '须记录收编条数用于提示')
  c.ok(/prefix = carried \?/.test(fn), '提示须说明上一批题已收编，不能静默')
  c.ok(/setSeqRows\(\s*got\.map/.test(fn), '收编后仍用本页新定位结果替换候选行')
  c.ok(/const handleSeqApply = \(\) => \{/.test(s), '保留手动「加入题目」入口')
  c.ok(/const n = appendSeqRowsToBoard\(seqRows\)/.test(s), '手动加入与自动收编共用同一路径（不重复实现）')
  c.ok(/answerImages: r\.answer \? \[r\.answer\] : \[\]/.test(s), '解答图仍随题入库 answer_images')
})

m.test('A3 错题提取过程可裁答案', (c) => {
  const s = read(REC)
  c.ok(/kind: 'stem' \| 'answer' \| 'extra'/.test(s), '裁剪任务须区分题目图/解答图/补块')
  c.ok(/onClick=\{\(\) => startCrop\(idx, 'answer'\)\}/.test(s), '题目卡须有「裁答案」入口')
  c.ok(/task\.kind === 'answer'[\s\S]{0,140}answerImages/.test(s), '解答图须写进本题 answerImages')
  c.ok(/confirmText=\{cropEditor\.kind === 'answer' \? '裁剪答案'/ .test(s), '答案裁剪按钮文案须与目标一致')
  c.ok(/解答图将存入：第 \$\{cropEditor\.entryIdx \+ 1\} 题/.test(s), '编辑器须明示存入哪道题')
  c.ok(/question_images: e\.images\.map/.test(s), '题干图仍写 question_images')
  c.ok(/answer_images: e\.answerImages!\.map/.test(s), '入库时解答图仍单独落 answer_images')
})

m.test('A4 已存题目：答案可从本地图片/文件/PDF/资料库裁剪', (c) => {
  const s = read(ANS)
  c.ok(/openCroppableSource = async/.test(s), '须有统一的「选源→裁剪」入口')
  c.ok(/fetchDocPages\(url, 10\)/.test(s), 'PDF 须出页图后才可裁剪')
  // D-085 起页码选择改为页缩略图面板：这里只锁「多页必须让用户选」这个能力，
  // 具体交互细节由 M64 断言。
  c.ok(/const session = \{ docName: name \|\| 'PDF 资料', pages \}/.test(s), '多页 PDF 须开页缩略图面板')
  c.ok(/setPdfPages\(session\)/.test(s), '页图须交给缩略图面板（不再用文字页码）')
  c.ok(!/const askPage = \(offset: number\)/.test(s), '文字页码分批已废弃，别回来')
  c.ok(
    /Taro\.showLoading\(\{ title: '正在生成页图…'[\s\S]*finally \{[\s\S]*Taro\.hideLoading\(\)/.test(s),
    '必须先关 mask loading 再开面板（loading 与浮层叠加会吞点击）',
  )
  c.ok(/if \(pages\.length === 1\) \{[\s\S]{0,240}openCrop\(pages\[0\]\.url\)/.test(s), '单页 PDF 直接进裁剪')
  c.ok(/setCropSrc\(f\.path\)/.test(s), '本地图片须直接进裁剪器')
  c.ok(/uploadFile\(f\.path, \{ purpose: 'temp' \}\)/.test(s), '本地 PDF 须先临时上传拿 URL 再出页图')
  c.ok(/handlePickLibraryForCrop/.test(s), '资料库选择须分「整份加入 / 裁剪」两种意图')
  c.ok(/裁剪资料库/.test(s), '资料库裁剪须有独立入口，不改变原「资料库」行为')
  c.ok(/Word\/TXT 没有页图/.test(s), '无页图格式须明确告知，不静默跳过')
  c.ok(/cropTargetLabel=\{`答案将存入：\$\{label\}`\}/.test(s), '答案裁剪须常驻目标锚')
})

export default m
