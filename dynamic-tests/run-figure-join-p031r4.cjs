const fs = require('fs')
const path = require('path')
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'))

function loadTs(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, (n) => {
    throw new Error('不该有运行时依赖：' + n)
  })
  return mod.exports
}

const Q = loadTs('src/lib/question-locate.ts')
const SEG = loadTs('server/src/ocr/ocr-segment.ts')

const W = 1200, H = 1600
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'page-text-exam-real.json'), 'utf8'))
const ppsv3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'page-figures-exam-real.json'), 'utf8'))

const figures = SEG.extractFigures(ppsv3.blocks)
console.log('=== extractFigures（精准通道版面块 → 图形块） ===')
for (const f of figures) {
  console.log(`  box=[${f.box.x0},${f.box.y0},${f.box.x1},${f.box.y1}]  图注归属=${f.label ?? '无'}`)
}

const seq = [7, 14, 20]
const before = Q.locateQuestions(fx.segs, W, H, seq)
const after = Q.locateQuestions(fx.segs, W, H, seq, figures)
const px = (r) => `x=${Math.round(r.x * W)}-${Math.round((r.x + r.w) * W)} y=${Math.round(r.y * H)}-${Math.round((r.y + r.h) * H)}`

console.log('\n=== 补图前 / 补图后 ===')
for (let i = 0; i < seq.length; i++) {
  console.log(`第 ${seq[i]} 题`)
  console.log(`  补图前 ${px(before[i].stemRect)}`)
  console.log(`  补图后 ${px(after[i].stemRect)}   figure=${after[i].figureBox ? 'yes' : 'null'}`)
}

// ── 判据 ────────────────────────────────────────────────
const abs = (r) => ({
  x0: r.x * W, y0: r.y * H, x1: (r.x + r.w) * W, y1: (r.y + r.h) * H,
})
let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n=== 判据 ===')
// 1 覆盖（逐块）：本题的**每一张**图都必须 100% 在本题框内。
//   ⚠️ 不能用 figureBox（并集）反查——只要一张图把并集撑大，另一张即使没并进去
//   也会「落在并集里」，断言就成了自欺。必须按 figureBoxes 逐块校验。
for (const q of after) {
  const r = abs(q.stemRect)
  ok(`第 ${q.label} 题 ${q.figureBoxes.length} 张图全部在框内`,
    q.figureBoxes.every((b) => b.x0 >= r.x0 - 1 && b.x1 <= r.x1 + 1 && b.y0 >= r.y0 - 1 && b.y1 <= r.y1 + 1),
    q.figureBoxes.map((b) => `[${b.x0},${b.y0},${b.x1},${b.y1}]`).join(' ') +
      ` ⊄ box=${r.x0.toFixed(0)}-${r.x1.toFixed(0)}/${r.y0.toFixed(0)}-${r.y1.toFixed(0)}`)
}

// 1b 不丢图：本次请求内、图注明确归给某题的图块，必须出现在该题的 figureBoxes 里
for (const f of figures) {
  if (f.label == null || !seq.includes(f.label)) continue
  const q = after.find((x) => x.label === f.label)
  const got = q.figureBoxes.some((b) => b.x0 === f.box.x0 && b.y0 === f.box.y0 && b.x1 === f.box.x1 && b.y1 === f.box.y1)
  ok(`第 ${f.label} 题的图块 [${f.box.y0}-${f.box.y1}] 已并入（未丢图）`, got)
}

// 2 归属互斥：同一个图块只能归**一道**题（不得两题都拿它去扩框）。
//   ⚠️ 这条约束的是**图块**，不是题——一道题可以有多张图（见下面第 5 组多小题），
//   原先把这条写成「归属唯一」容易被读成「一题只能一图」，那是错的。
const seen = new Map()
let dup = false
for (const q of after) for (const b of q.figureBoxes) {
  const k = `${b.x0},${b.y0},${b.x1},${b.y1}`
  if (seen.has(k) && seen.get(k) !== q.label) dup = true
  seen.set(k, q.label)
}
ok('一个图块只归一道题（图块互斥，题可多图）', !dup)

// 3 不污染邻题：第 16 题的图**不得被归给第 14 题**
//   ⚠️ 不能要求「14 的矩形不含 16 的图」：真实卷面上 16 的图就排在 14 的正文水平带里
//   （14 图文到 x=1120，16 图在 x 747-990、y 563-724），一个矩形不可能同时「含 14 的字」
//   又「不含 16 的图」。能保证的是**归属**不串题，几何上的并排交错属于单矩形表达的固有限制。
const f16 = figures.find((f) => f.label === 16)
const q14 = after.find((q) => q.label === 14)
if (f16) {
  const fb = q14.figureBox
  const stolen = fb && f16.box.x0 >= fb.x0 - 1 && f16.box.x1 <= fb.x1 + 1 && f16.box.y0 >= fb.y0 - 1 && f16.box.y1 <= fb.y1 + 1
  ok('第 16 题的图未被归给第 14 题', !stolen,
    stolen ? `14 的 figureBox 吞掉了 16 的图 ${JSON.stringify(fb)}` : '')
}

// 4 只外扩：补图后每个框必须完整包含补图前的框
for (let i = 0; i < seq.length; i++) {
  const b = abs(before[i].stemRect), a = abs(after[i].stemRect)
  ok(`第 ${seq[i]} 题只外扩不内缩`,
    a.x0 <= b.x0 + 0.5 && a.y0 <= b.y0 + 0.5 && a.x1 >= b.x1 - 0.5 && a.y1 >= b.y1 - 0.5,
    `前 ${b.x0.toFixed(0)}-${b.x1.toFixed(0)}/${b.y0.toFixed(0)}-${b.y1.toFixed(0)} → 后 ${a.x0.toFixed(0)}-${a.x1.toFixed(0)}/${a.y0.toFixed(0)}-${a.y1.toFixed(0)}`)
}

// 5 失败降级：不传 figures 时结果必须与旧行为逐字节一致
const none = Q.locateQuestions(fx.segs, W, H, seq, [])
ok('无 figures 时与旧行为逐字节一致', JSON.stringify(none.map((q) => q.stemRect)) === JSON.stringify(before.map((q) => q.stemRect)))

// 6 20 题具体数字（用户肉眼观察的那一处）
const q20 = abs(after.find((q) => q.label === 20).stemRect)
ok('第 20 题框底边覆盖到 1256（平行四边形下半截）', q20.y1 >= 1250, `实际 ${q20.y1.toFixed(0)}`)

// ── 7 一题多小题、每小题各有图（合成样本）─────────────────────────────
// 真实卷面很常见：一道大题下 (1)(2)(3)，每小问各配一张图（或题干一张 + 结论一张）。
// 若按「一题只能一图」实现，后两张必丢。这条用例就是防止那种实现混进来。
const MW = 1200, MH = 1600
const mkSeg = (text, x0, y0, x1, y1) => ({
  text, box: { x0, y0, x1, y1 }, col: 0, kind: 'text', lines: 1, source: 'xycut',
})
const multiSegs = [
  mkSeg('5．观察下列三个图形，分别回答问题。', 60, 100, 1100, 140),
  mkSeg('（1）求第一个图形的面积；', 60, 150, 1100, 180),
  mkSeg('第5题(1)图', 90, 335, 260, 355),
  mkSeg('（2）求第二个图形的周长；', 60, 380, 1100, 410),
  mkSeg('第5(2)题图', 90, 625, 300, 645),
  mkSeg('（3）求第三个图形的体积。', 60, 680, 1100, 710),
  mkSeg('第5题(3)图', 90, 865, 260, 885),
  mkSeg('6．如图，求阴影部分的面积。', 60, 950, 1100, 990),
]
const multiBlocks = [
  { label: 'text', bbox: [60, 100, 1100, 140], content: '5．观察下列三个图形，分别回答问题。' },
  { label: 'image', bbox: [80, 190, 320, 330] },
  { label: 'figure_title', bbox: [90, 335, 260, 355], content: '第5题(1)图' },
  { label: 'image', bbox: [80, 420, 340, 620] },
  { label: 'figure_title', bbox: [90, 625, 300, 645], content: '第5(2)题图' },
  { label: 'image', bbox: [80, 720, 300, 860] },
  { label: 'figure_title', bbox: [90, 865, 260, 885], content: '第5题(3)图' },
  { label: 'text', bbox: [60, 950, 1100, 990], content: '6．如图，求阴影部分的面积。' },
  { label: 'image', bbox: [700, 1000, 950, 1100] },
]
const mf = SEG.extractFigures(multiBlocks)
console.log('\n=== 多小题样本：图注 → 归属 ===')
for (const f of mf) console.log(`  [${f.box.x0},${f.box.y0},${f.box.x1},${f.box.y1}] label=${f.label ?? '无'}`)

const mq = Q.locateQuestions(multiSegs, MW, MH, [5, 6], mf)
const q5 = mq.find((q) => q.label === 5)
const q6 = mq.find((q) => q.label === 6)
const a5 = abs(q5.stemRect)
const a6 = abs(q6.stemRect)
console.log(`  第 5 题框 y=${a5.y0.toFixed(0)}-${a5.y1.toFixed(0)}，图 ${q5.figureBoxes.length} 张：` +
  q5.figureBoxes.map((b) => `${b.y0}-${b.y1}`).join(','))
console.log(`  第 6 题框 y=${a6.y0.toFixed(0)}-${a6.y1.toFixed(0)}，图 ${q6.figureBoxes.length} 张`)

ok('多小题：第 5 题 3 张图全部归入（小题图注 `第5题(1)图` / `第5(2)题图` 都能认）',
  q5.figureBoxes.length === 3, `实际 ${q5.figureBoxes.length}`)
ok('多小题：3 张图都在第 5 题框内',
  q5.figureBoxes.every((b) => b.x0 >= a5.x0 - 1 && b.x1 <= a5.x1 + 1 && b.y0 >= a5.y0 - 1 && b.y1 <= a5.y1 + 1),
  `box y=${a5.y0.toFixed(0)}-${a5.y1.toFixed(0)}`)
ok('多小题：第 5 题的框没把第 6 题的图吃进来',
  !q5.figureBoxes.some((b) => b.y0 >= 990))
ok('多小题：第 6 题无图注的图按 y 重叠归入', q6.figureBoxes.length === 1,
  `实际 ${q6.figureBoxes.length}`)
ok('多小题：第 6 题框覆盖该图', q6.figureBoxes.every((b) => b.y1 <= a6.y1 + 1 && b.y0 >= a6.y0 - 1))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
