// 模块 75：B2 / P-034 §3.5 导出辅助强度三档（D-097）
//
// 锁住「两条导出管线共用一份档位映射」以及三条边界：
//   B1 单一映射源：0 纯题 / 1–2 提示 / ≥3 错因详解，固定映射不是自适应
//   B2 K1：提示只来自已存 suggestion，无 suggestion 就留白，全程零 AI 路径
//   B3 Word 汇总与复习本合成（PDF/Word）都接了同一函数，真相源是 review_count 列
//   B4 练习卷零答案：hint 文本块不得携带 answer/solution/答案图；答疑卷恒详解、不做四档
//   B5 文案纪律：不得叫「自适应/精准难度」；打印卷页眉只陈述做法、不承诺效果

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M75', 'B2 导出辅助强度三档（D-097）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const HINT = 'server/src/shared/review-hint.ts'
const DOC = 'server/src/document/document.service.ts'
const PDF = 'server/src/pdf/pdf.service.ts'
const SUMMARY = 'src/pages/summary/index.tsx'

m.test('B1 单一映射源：0 纯题 / 1–2 提示 / ≥3 错因详解', async (c) => {
  c.ok(exists(HINT), '须有零依赖的共用映射文件')
  const f = read(HINT)
  c.ok(/export function reviewHintFor\(/.test(f), '须导出唯一映射函数 reviewHintFor')
  c.ok(/if \(count === 0\) return null/.test(f), '0 档（新录入/做错归零）必须是纯题、零提示')
  c.ok(/if \(count <= 2\)/.test(f), '1–2 档走提示分支')
  c.ok(/level: 'hint'/.test(f) && /level: 'detail'/.test(f), '须有 hint / detail 两级')
  c.ok(/lines\.push\(`建议：\$\{suggestion\}`\)/.test(f), '≥3 档须输出已存建议')
  c.ok(/错因：\$\{label\}/.test(f) && /原因：\$\{reason\}/.test(f), '≥3 档须带错因与原因（仍不含答案）')
  // 固定映射，不是自适应：不得出现「按难度/按正确率」动态调档。
  // 文件头注释写了「禁止对外叫自适应/精准难度」是纪律、不是功能，须先去注释避免误伤。
  const codeOnly = f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  c.ok(!/自适应|精准难度|difficulty|accuracy/i.test(codeOnly), '映射须自称固定档位，禁「自适应/精准难度」')
})

m.test('B2 K1：提示只来自已存 suggestion，零 AI 路径', async (c) => {
  const f = read(HINT)
  c.ok(/const suggestion = trim\(errorAnalysis\?\.suggestion\)/.test(f), '提示必须取 error_analysis.suggestion')
  c.ok(/if \(!suggestion\) return null/.test(f), '无已存建议时留白，不得拿 label 顶替')
  c.ok(!/llm|openai|hunyuan|chat|aiGenerate|generate/i.test(f), '映射函数不得调 AI 或生成文本（K1）')
  const doc = read(DOC)
  const pdf = read(PDF)
  for (const [name, src] of [['Word 汇总', doc], ['复习本合成', pdf]]) {
    c.ok(/reviewHintFor\(/.test(src), `${name}须调用同一映射`)
    c.ok(!/generateHint|aiHint|llmHint/.test(src), `${name}不得另造 AI 提示路径`)
  }
})

m.test('B3 两条管线都接了映射，真相源是 review_count 列', async (c) => {
  const doc = read(DOC)
  c.ok(/import \{ reviewHintFor \} from '\.\.\/shared\/review-hint'/.test(doc), 'Word 汇总须从共用文件导入')
  c.ok(/const hint = withAnswers \? null : reviewHintFor\(reviewCount, c\.error_analysis\)/.test(doc), 'Word 汇总仅在练习卷分支附提示')
  c.ok(/typeof row\.review_count === 'number' \? row\.review_count/.test(doc), 'Word 汇总须优先读列 review_count（真相源）')

  const pdf = read(PDF)
  c.ok(/import \{ reviewHintFor \} from '\.\.\/shared\/review-hint'/.test(pdf), '复习本合成须从共用文件导入')
  c.ok(/if \(!includeAnswers\)/.test(pdf), '合成导出仅在练习卷分支附提示')
  c.ok(/text: \{ heading: hint\.heading, lines: hint\.lines \}/.test(pdf), '提示须作为文本块入列（PDF 位图 / Word 原生段落）')
  c.ok(/role: 'question', label, spacePt/.test(pdf), '提示块 role=question 且排在题面之后、做题留白之前')
  c.ok(/typeof it\.review_count === 'number' \? it\.review_count/.test(pdf), '合成导出须优先读列 review_count')
})

m.test('B4 练习卷零答案；答疑卷恒详解、不做成四档', async (c) => {
  const hint = read(HINT).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  c.ok(!/\banswer\b|solution|answer_images|正确答案|解析：/.test(hint), '映射函数不得输出答案或解析')
  const doc = read(DOC)
  const docHintAt = doc.indexOf('const hint = withAnswers ? null : reviewHintFor(')
  c.ok(docHintAt > 0, 'Word 汇总须有练习卷专属 hint 分支')
  c.ok(/if \(withAnswers && c\.wrong_answer\)/.test(doc), '答疑卷仍输出错误作答（恒详解）')
  c.ok(/if \(withAnswers\) \{[\s\S]{0,600}正确答案：/.test(doc), '答疑卷仍输出正确答案')
  const pdf = read(PDF)
  const pdfHintAt = pdf.indexOf('if (!includeAnswers) {')
  c.ok(pdfHintAt > 0, '合成导出须有练习卷专属 hint 分支')
  // 窗口精确切到答案分支起点，不能拍脑袋取 N 个字符——会跨进答案分支造成误伤。
  const pdfAnswersAt = pdf.indexOf('if (includeAnswers) {', pdfHintAt)
  const pdfHintBody = pdf.slice(pdfHintAt, pdfAnswersAt)
  c.ok(!/answer_image_urls|#t-answer|#t-solution|c\.answer|c\.solution/.test(pdfHintBody), '练习卷 hint 分支不得夹带答案图/答案文本')
  c.ok(/if \(includeAnswers\) \{/.test(pdf), '答疑卷合成分支仍在（两档不变）')
  // 按钮仍是两颗，不做成「纯题/提示/详解/答疑」四档
  const s = read(SUMMARY)
  c.ok((s.match(/handleExport\((?:false|true)\)/g) || []).length === 2, '导出按钮仍只对练/答两档')
})

m.test('B5 文案纪律：打印机密只陈述做法，不承诺效果', async (c) => {
  const doc = read(DOC)
  c.ok(/先独立做，做完再对答案/.test(doc), '打印练习卷页眉须印「先独立做，做完再对答案」')
  c.ok(!/提高成绩|一定记住|科学最优|疗效|保证/.test(doc), '导出文案不得承诺效果')
  const s = read(SUMMARY)
  c.ok(!/自适应|精准难度/.test(s), '面客文案不得叫「自适应/精准难度」')
  c.ok(/不含答案/.test(s), '练习卷说明须写明不含答案')
  const p = read('docs/design/method/proposals/P-034-暂停语义与采纳层细部修正.md')
  c.ok(/§3\.5 导出三档[^\n]*✅ 已实施/.test(p), 'P-034 实施表须把 §3.5 标为已实施')
})

export default m
