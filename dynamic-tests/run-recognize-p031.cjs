/**
 * P-031 离线实证（不连数据库、不连微信、不依赖 IDE）
 *
 * 做三件事：
 *  ① 用 TypeScript 编译器转译并**真实执行** `src/lib/question-locate.ts` 的纯函数：
 *     题号表达式解析、小数不误判、题号定位、解答区候选、未定位退回整页；
 *  ② 断言「解答区只做候选」的边界（无解答标记 ⇒ answerRect=null，即只存题目区）；
 *  ③ 检查小程序编译产物里 P-031 的交互特征串都在。
 *
 * ⚠️ 只能证明「纯函数 + 编译产物」正确；候选框准不准、真机能否裁剪出图、
 *    解答区归属对不对——**都证明不了**，P-031 ⑥ 已显式「不宣称」。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LOC = path.join(ROOT, 'src', 'lib', 'question-locate.ts')
const DIST = path.join(ROOT, 'dist', 'pages', 'recognize', 'index.js')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('P-031 错题提取 · 按题号裁剪题目区/解答区 实证')

// ---- ① 转译并执行源码纯函数 ----
let Q = null
try {
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
  const src = fs.readFileSync(LOC, 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  // 纯函数文件零 import ⇒ 不需要 require，传一个会抛错的桩，防止将来偷偷加依赖
  const noRequire = (n) => { throw new Error(`question-locate 不应依赖模块：${n}`) }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, noRequire)
  Q = mod.exports
  ok(true, '源码可转译执行（零 import，未引入任何依赖）')
} catch (e) {
  ok(false, `源码转译执行失败：${e.message}`)
}

if (Q) {
  // ---- 题号表达式 ----
  ok(eq(Q.parseSeqSpec('3,5,8-12'), [3, 5, 8, 9, 10, 11, 12]), '区间展开 3,5,8-12')
  ok(eq(Q.parseSeqSpec('1，2、3'), [1, 2, 3]), '全角逗号/顿号分隔')
  ok(eq(Q.parseSeqSpec(' 2 2 2 '), [2]), '重复题号去重')
  ok(eq(Q.parseSeqSpec('5-3'), null), '倒序区间必须拒绝')
  ok(eq(Q.parseSeqSpec('1-300'), null), '超大区间必须拒绝（防一次生成 300 张图）')
  ok(eq(Q.parseSeqSpec(''), null), '空串必须拒绝')
  ok(eq(Q.parseSeqSpec('a,b'), null), '非法输入必须拒绝')
  ok(eq(Q.parseSeqSpec('0'), null), '题号 0 必须拒绝')

  // ---- 题号识别：小数不能当题号（D-049 已证伪的坑）----
  ok(Q.segQuestionNumber('1.5 米长的绳子') === null, '`1.5 米` 不得被当成第 1 题')
  ok(Q.segQuestionNumber('9. 计算下列各题') === 9, '`9.` 应识别为第 9 题')
  ok(Q.segQuestionNumber('3．求面积') === 3, '全角 `３．` 应识别')
  ok(Q.segQuestionNumber('第 4 题 解方程') === 4, '`第 4 题` 应识别')
  ok(Q.segQuestionNumber('【例 5】求周长') === 5, '`【例 5】` 应识别')

  // ---- 解答标记 ----
  ok(Q.isSolutionStart('答案：4') === true, '`答案：` 是解答起点')
  ok(Q.isSolutionStart('解析：因为 1+1=2') === true, '`解析：` 是解答起点')
  ok(Q.isSolutionStart('【解析】由题意') === true, '`【解析】` 是解答起点')
  ok(Q.isSolutionStart('解决这个问题的关键在于') === false, '`解决…` 不得被当成解答起点')

  // ---- 定位主逻辑 ----
  const PAGE_W = 600
  const PAGE_H = 1000
  const seg = (text, y0, y1) => ({ text, box: { x0: 0, y0, x1: PAGE_W, y1 }, col: 0 })
  const segs = [
    seg('1．求 1+1 的值', 100, 140),
    seg('2．求 2+2 的值', 200, 240),
    seg('答案：4', 250, 270),
    seg('3．求 3+3 的值', 400, 440),
  ]
  const got = Q.locateQuestions(segs, PAGE_W, PAGE_H, [2, 3, 99])

  ok(got.length === 3, '请求 3 个题号就返回 3 行')
  ok(got[0].label === 2 && got[0].located === true, '第 2 题应定位成功')
  ok(eq(got[0].stemRect, { x: 0, y: 0.2, w: 1, h: 0.05000000000000002 }) ||
     Math.abs(got[0].stemRect.y - 0.2) < 1e-9 && Math.abs((got[0].stemRect.y + got[0].stemRect.h) - 0.25) < 1e-9,
     '第 2 题题目区截止到解答标记（0.20~0.25）')
  ok(got[0].answerRect !== null, '第 2 题应给出解答区候选')
  ok(Math.abs(got[0].answerRect.y - 0.25) < 1e-9 && Math.abs((got[0].answerRect.y + got[0].answerRect.h) - 0.4) < 1e-9,
     '第 2 题解答区候选 = 解答标记 → 下一题（0.25~0.40）')
  ok(got[0].answerRect.y >= got[0].stemRect.y + got[0].stemRect.h - 1e-9, '题目区与解答区不得重叠')

  ok(got[1].label === 3 && got[1].located === true, '第 3 题应定位成功')
  ok(got[1].answerRect === null, '第 3 题无解答标记 ⇒ 只存题目区（answerRect=null）')

  ok(got[2].label === 99 && got[2].located === false, '第 99 题应标记未定位')
  ok(eq(got[2].stemRect, { x: 0, y: 0, w: 1, h: 1 }), '未定位必须退回整页候选，不得借用相邻题区间')
  ok(got[2].answerRect === null, '未定位时不得给解答区')

  const zero = Q.locateQuestions(segs, 0, 0, [2])
  ok(zero[0].located === true && eq(zero[0].stemRect, { x: 0, y: 0, w: 1, h: 1 }),
     '页面尺寸未知时只给整页候选（不猜比例）')
  ok(zero[0].answerRect === null, '页面尺寸未知时不给解答区')

  const empty = Q.locateQuestions([], PAGE_W, PAGE_H, [1])
  ok(empty[0].located === false, '没有段落时必须标记未定位（不编框）')
}

// ---- ② 编译产物特征串 ----
let dist = ''
try {
  dist = fs.readFileSync(DIST, 'utf8')
  ok(true, '编译产物存在：dist/pages/recognize/index.js')
} catch (e) {
  ok(false, `编译产物缺失：${e.message}`)
}
for (const kw of ['按题号提取', '只存图片', '定位不到的题会给整页框', '裁题目图', '裁解答图', '从 PDF 取页图']) {
  ok(dist.includes(kw), `产物含 P-031 特征串：${kw}`)
}
// 既有能力不得被这次改动冲掉
for (const kw of ['拍照识别', '错题提取', '如 3,5,8-12', '裁剪入题']) {
  ok(dist.includes(kw), `既有能力仍在：${kw}`)
}
ok(dist.includes('解答'), '产物含「解答」标识（解答图与题目图区分展示）')

console.log(`\nP-031 实证：${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
