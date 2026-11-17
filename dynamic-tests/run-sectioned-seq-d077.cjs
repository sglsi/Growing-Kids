/**
 * D-077 / 方案 A 动态实证：分节题号「一6,二5,二6」的解析 + 逐节定位。
 *
 * 红线自检：判定层 question-match.ts 一行未动；原 parseSeqSpec / locateQuestions
 * 的老路径逐字不变（不传 scope）。本脚本真实转译执行 question-locate.ts 验证。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
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
const W = 1200, H = 2000

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')) }
}
const pxY = (r) => ({ y0: Math.round(r.y * H), y1: Math.round((r.y + r.h) * H) })

console.log('=== ① parseSectionedSpec 解析 ===')
const refs = Q.parseSectionedSpec('一6,二5,二6,二16,二22')
ok('分节写法解析为 5 条', Array.isArray(refs) && refs.length === 5, JSON.stringify(refs))
ok('（一）6 节号=一', refs[0].section === '一' && refs[0].label === 6)
ok('（二）5 节号=二', refs[1].section === '二' && refs[1].label === 5)
ok('括号写法 (二)5 等价于 二5', JSON.stringify(Q.parseSectionedSpec('(二)5')) === JSON.stringify([{ section: '二', label: 5 }]))
ok('顿号写法 一、6 等价', JSON.stringify(Q.parseSectionedSpec('一、6')) === JSON.stringify([{ section: '一', label: 6 }]))
ok('节内区间 二5-6 展开', JSON.stringify(Q.parseSectionedSpec('二5-6')) === JSON.stringify([{ section: '二', label: 5 }, { section: '二', label: 6 }]))
ok('混合纯数字项 section=null', JSON.stringify(Q.parseSectionedSpec('3,二6')) === JSON.stringify([{ section: null, label: 3 }, { section: '二', label: 6 }]))
ok('纯数字无分节 → null（回落老路径）', Q.parseSectionedSpec('3,5,8-12') === null)
ok('非法节号 → null', Q.parseSectionedSpec('甲6') === null)
ok('越界题号 → null', Q.parseSectionedSpec('二999') === null)
ok('空串 → null', Q.parseSectionedSpec('   ') === null)

console.log('\n=== ② 分节样本：同号不同节各自定位 ===')
// （一）节 y=100~700：6 题在 y=200；（二）节 y=800~1800：5 在 900、6 在 1200
const segs = [
  { text: '（一）选择题', box: { x0: 60, y0: 100, x1: 900, y1: 140 }, col: 0 },
  { text: '6．已知等腰三角形，求顶角。', box: { x0: 60, y0: 200, x1: 1000, y1: 250 }, col: 0 },
  { text: '（一）6 图', box: { x0: 60, y0: 260, x1: 400, y1: 300 }, col: 0 },
  { text: '（二）填空题', box: { x0: 60, y0: 800, x1: 900, y1: 840 }, col: 0 },
  { text: '（二）5 如图，求面积。', box: { x0: 60, y0: 900, x1: 1000, y1: 950 }, col: 0 },
  { text: '（二）6 证明全等。', box: { x0: 60, y0: 1200, x1: 1000, y1: 1250 }, col: 0 },
  { text: '16．计算下列各式。', box: { x0: 60, y0: 1400, x1: 1000, y1: 1450 }, col: 0 },
  { text: '22．综合题。', box: { x0: 60, y0: 1650, x1: 1000, y1: 1700 }, col: 0 },
]
const got = Q.locateSectionedQuestions(segs, W, H, refs)
ok('产出 5 条定位结果', got.length === 5, JSON.stringify(got.map((g) => g.label)))

const y6a = pxY(got[0].stemRect)   // 一6
const y5b = pxY(got[1].stemRect)   // 二5
const y6b = pxY(got[2].stemRect)   // 二6
console.log('  一6 y=' + JSON.stringify(y6a) + '  二5 y=' + JSON.stringify(y5b) + '  二6 y=' + JSON.stringify(y6b))
ok('（一）6 定位成功', got[0].located === true)
ok('（二）5 定位成功（节号贴号行被认）', got[1].located === true)
ok('（二）6 定位成功', got[2].located === true)
ok('（一）6 与（二）6 是不同区间（不串节）', got[0].located && got[2].located && y6a.y0 < 700 && y6b.y0 >= 800, JSON.stringify([y6a, y6b]))
ok('（二）5 框落在（二）节内（y0≥800）', y5b.y0 >= 800, JSON.stringify(y5b))
ok('（二）5 框尾不吃掉（二）6 的题号行（y1<1200）', y5b.y1 < 1200, JSON.stringify(y5b))
ok('（二）6 框尾不跨到 16 题（y1≤1450）', y6b.y1 <= 1450, JSON.stringify(y6b))
ok('22 题为末题，框尾收在节内（≤1800 而非页底 2000）', pxY(got[4].stemRect).y1 <= 1800, JSON.stringify(pxY(got[4].stemRect)))

console.log('\n=== ③ 卷面无该节：fail-closed 整页候选 ===')
const noSec = Q.locateSectionedQuestions(segs, W, H, [{ section: '三', label: 9 }])
ok('未识别到的节 → located=false', noSec[0].located === false)
ok('未识别到的节 → 整页候选（不借邻节）', noSec[0].stemRect.x === 0 && noSec[0].stemRect.y === 0 && noSec[0].stemRect.w === 1 && noSec[0].stemRect.h === 1)

console.log('\n=== ④ 老路径零回归（不传 scope 逐字一致）===')
const realFx = path.join(__dirname, 'fixtures', 'page-text-exam-real.json')
if (fs.existsSync(realFx)) {
  const fx = JSON.parse(fs.readFileSync(realFx, 'utf8'))
  const old = Q.locateQuestions(fx.segs, W, H, [7, 14, 20])
  const oldAgain = Q.locateQuestions(fx.segs, W, H, [7, 14, 20])
  ok('locateQuestions 不传 scope 结果稳定（逐字节）', JSON.stringify(old) === JSON.stringify(oldAgain))
  const plain = Q.locateSectionedQuestions(fx.segs, W, H, [{ section: null, label: 7 }])
  ok('section=null 项等价于老路径', JSON.stringify(plain[0]) === JSON.stringify(old[0]))
} else {
  console.log('  （跳过：无真实样本 fixture）')
}

console.log('\n=== ⑤ 红线：判定层未动 + 原函数保留 ===')
const qm = path.join(__dirname, '..', 'server', 'src', 'shared', 'question-match.ts')
const qmSrc = fs.readFileSync(qm, 'utf8')
ok('question-match.ts 存在且仍为零依赖（无 import）', !/^\s*import\s/m.test(qmSrc))
const locSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'question-locate.ts'), 'utf8')
ok('parseSeqSpec 原函数仍在', /export function parseSeqSpec\(/.test(locSrc))
ok('locateQuestions 原签名保留 scope 为可选参数', /scope\?: \{ y0: number; y1: number; section: string \}/.test(locSrc))
ok('新增函数均为并列导出（未改判定层）', /export function parseSectionedSpec/.test(locSrc) && /export function locateSectionedQuestions/.test(locSrc))
// 判定层产物哈希快照（供台账记录）
const qmHash = crypto.createHash('sha256').update(qmSrc).digest('hex').slice(0, 16)
console.log('  question-match.ts sha256[:16] = ' + qmHash)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
