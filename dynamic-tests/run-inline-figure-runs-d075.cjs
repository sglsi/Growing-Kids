/**
 * D-075 导出内嵌图切段离线实证（不连数据库、不连微信）
 *
 * 真实转译并执行 `server/src/shared/inline-figure-runs.ts` 的纯函数，断言：
 *  ① [图N] 有引用 → 切成 figure 段（原位），文字段按序保留；
 *  ② 无引用 / 缺槽位 → 该标记原样留在 text 段（fail-closed，不拿邻图顶替）；
 *  ③ 一题多图、多段文字交错顺序正确（不该统一堆到末尾）；
 *  ④ [图10] 不被 [图1] 的前缀误匹配；
 *  ⑤ 两条导出链（document A / pdf B）都接入了切段函数，且各自解析 storage key / 签名 URL；
 *  ⑥ 列表卡片用 helper 按 slot 带图、无 URL 降级为文字。
 *
 * ⚠️ 只能证明「纯函数 + 源码契约」正确；docx/PDF 里图是否真原位渲染、
 *    真机效果——都证明不了，D-075 不宣称面客效果。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RUNS = path.join(ROOT, 'server', 'src', 'shared', 'inline-figure-runs.ts')
const DOC_SVC = path.join(ROOT, 'server', 'src', 'document', 'document.service.ts')
const PDF_SVC = path.join(ROOT, 'server', 'src', 'pdf', 'pdf.service.ts')
const CARD = path.join(ROOT, 'src', 'components', 'review-item-card.tsx')

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

console.log('D-075 导出内嵌图切段 · 原位交错 实证')

let R = null
try {
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
  const js = ts.transpileModule(fs.readFileSync(RUNS, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  const noRequire = (n) => { throw new Error(`inline-figure-runs 不应依赖模块：${n}`) }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, noRequire)
  R = mod.exports
  ok(true, '切段 helper 可转译执行（零 import）')
} catch (e) {
  ok(false, `切段 helper 转译失败：${e.message}`)
}

if (R) {
  const resolve = new Map([[1, 'key-1'], [2, 'key-2']])
  const get = (slot) => resolve.get(slot)

  // ① 有引用 → figure 段
  const runs = R.splitQuestionRuns('如图 [图1] 求面积，另见 [图2]。', get)
  const kinds = runs.map((r) => r.kind)
  ok(kinds.join(',') === 'text,figure,text,figure,text', '两段文字 + 两图的交错序列正确')
  ok(runs.filter((r) => r.kind === 'figure').map((r) => r.ref).join(',') === 'key-1,key-2', 'figure 段按槽位取到各自引用')
  ok(runs[0].text.includes('如图') && runs[4].text.includes('。'), '首尾文字段保留')

  // ② 混合：槽位 2 有引用、槽位 1/9 缺引用 → 只有 2 出图，其余原样文字（fail-closed）
  const degraded = R.splitQuestionRuns('题 [图1] 与 [图9] 与 [图2]', (s) => (s === 2 ? 'key-2' : undefined))
  const figSlots = degraded.filter((r) => r.kind === 'figure').map((r) => r.slot)
  ok(figSlots.join(',') === '2', '只有有引用的槽位 2 出图，缺引用的不产生 figure 段')
  const textPart = degraded.filter((r) => r.kind === 'text').map((r) => r.text).join('')
  ok(textPart.includes('[图1]') && textPart.includes('[图9]'), '缺引用的 [图1]/[图9] 原样留在文字里，不拿邻图顶替')
  const allDegraded = R.splitQuestionRuns('题 [图1] 与 [图2]', () => undefined)
  ok(allDegraded.map((r) => r.text).join('') === '题 [图1] 与 [图2]', '全部缺引用时题干文字逐字还原（含所有标记）')
  ok(!R.hasInlineFigure('纯文字题，无标记'), 'hasInlineFigure 对纯文字返回 false')

  // ③ 原位而非末尾：图段位于两段文字之间
  const mid = R.splitQuestionRuns('上 [图1] 下', get)
  ok(mid[1].kind === 'figure' && mid[2].text === ' 下', '图段夹在文字之间，不堆到末尾')

  // ④ [图10] 不被 [图1] 前缀误匹配
  const ten = R.splitQuestionRuns('见 [图10] 与 [图1]', (s) => (s === 10 ? 'key-10' : 'key-1'))
  ok(ten.filter((r) => r.kind === 'figure').map((r) => r.slot).join(',') === '10,1', '[图10] 与 [图1] 各自独立解析，不串槽位')

  // ⑤ 两条导出链接入
  const doc = fs.readFileSync(DOC_SVC, 'utf8')
  ok(/splitQuestionRuns/.test(doc) && /questionParagraphs/.test(doc), 'A 链 document.service 走切段路径')
  ok(/inlineFigureParagraph/.test(doc) && /readObject/.test(doc), 'A 链内嵌图走 storage key 直读')
  const pdf = fs.readFileSync(PDF_SVC, 'utf8')
  ok(/splitQuestionRuns/.test(pdf) && /question_inline_figure_urls/.test(pdf), 'B 链 pdf.service 走切段 + 签名 URL')
  ok(!/question_inline_figures/.test(fs.readFileSync(path.join(ROOT, 'server', 'src', 'ocr', 'ocr.service.ts'), 'utf8')), 'C 链识别页即时导出不接入（未入库无内嵌图）')

  // ⑥ 列表带图 + 降级
  const card = fs.readFileSync(CARD, 'utf8')
  ok(/questionRichHtml/.test(card) && /RichText/.test(card), '列表卡片用 helper + RichText 按 slot 带图')
  ok(/question_inline_figure_urls/.test(card), '列表卡片取签名 URL 组装插图')
  ok(/<Text/.test(card) && /truncate\(c\.question/.test(card), '无内嵌图时仍走原纯文本摘要（零回归）')
}

console.log(`\n汇总  PASS ${pass} / FAIL ${fail}`)
process.exit(fail ? 1 : 0)
