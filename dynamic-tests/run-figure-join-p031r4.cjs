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
// 1 覆盖：归属题在本次请求内的图形块必须 100% 被该题框包含
for (const f of figures) {
  const target = after.find((q) => q.figureBox && f.box.x0 >= q.figureBox.x0 - 1 && f.box.x1 <= q.figureBox.x1 + 1 && f.box.y0 >= q.figureBox.y0 - 1 && f.box.y1 <= q.figureBox.y1 + 1)
  if (!target) {
    const inReq = f.label != null && seq.includes(f.label)
    console.log(`  ${inReq ? '❌' : '⏭ '} 图块 [${f.box.x0},${f.box.y0}] ${f.label ? `归属第 ${f.label} 题（不在本次请求 ${seq.join('/')} 内）` : '无图注且无 y 重叠，未归任何题'}`)
    if (inReq) fail++
    continue
  }
  const r = abs(target.stemRect)
  ok(`图块 [${f.box.y0}-${f.box.y1}] ⊆ 第 ${target.label} 题框`,
    f.box.x0 >= r.x0 && f.box.x1 <= r.x1 && f.box.y0 >= r.y0 && f.box.y1 <= r.y1,
    `box=${r.x0.toFixed(0)}-${r.x1.toFixed(0)}/${r.y0.toFixed(0)}-${r.y1.toFixed(0)}`)
}

// 2 归属唯一：同一个图形块不得同时归两道题
const owners = new Map()
for (const q of after) if (q.figureBox) owners.set(q.label, q.figureBox)
ok('每个图形块只归一道题（无重复归属）', new Set([...owners.values()].map((b) => `${b.x0},${b.y0}`)).size === owners.size)

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
