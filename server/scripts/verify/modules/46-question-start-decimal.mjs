// 模块 46：题号正则「半角小数不得当题目起点」守卫（D-049）
//
// 为什么要有这个模块：D-048 把 35,109 条「题干无实义」对象标记掉之后，顺着那 15 份
// 「全部对象不可用」的来源往下查，发现根因不止一个。其中**可代码修**的一条是：
//
//   `QUESTION_START` 的题号分支写成 `\d{1,3}\s*[．.、]`，半角 `.` 没有任何后缀约束，
//   于是**小数被当成题号**：`1.18`（密度值）、`2.5`、`97.7%`、`3.3~3.36`（密度区间）
//   独占一行时会被吃成题号 `1.` / `2.` / `97.`。
//
// 2026-11-13 生产库只读实测（656,707 个可关联对象）：
//   · label 形如 `N.` 的            231,429 个（35.3%）
//   · 其中原文其实是小数的          **41,422 个（占全库 6.3%）**
//   · 顿号形态 `N、`                  97,057 个，其中小数 **0** 个
//     ⇒ 歧义只存在于半角 `.`，只收紧 `.` 即可，`．` 与 `、` 保持原样
//   · 受影响来源 4,507 份（占 20,578 份的 22%）
//
// 修复后全库 dry-run（`--compiled` 指向新产物、bump 到 qobj-2 强制全量重算）：
//   对象总数 656,898 → **615,370（-41,528，-6.32%）**，与独立算出的假题号规模吻合。
//   3 份正常文档对照（12 / 18 / 20 个对象）切分数**完全不变**，零误伤。
//
// 🔴 与 M45 的分工：M45 守「入库第四道闸」（题干无实义 → rejected）；
//    本模块守「**边界怎么划**」（哪些行才是题目起点）。两者都不改判定层六闸。
//
// ⚠️ 本模块**不**声称修好了 D-048 那 15 份：它们是「文档本身无题号 / 纯答案页 /
//    题号标点丢失」，属文档格式与提取缺陷，不是小数误判（详见 D-049 台账遗留段）。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M46', '题号正则「半角小数不当题目起点」守卫（D-049）')
const ROOT = path.resolve(process.cwd(), '..')
const SERVER = path.join(ROOT, 'server')

const MATCH = 'server/src/shared/question-match.ts'
const INPUT_GUARD = 'server/src/shared/input-guard.ts'
const ANSWER_SVC = 'server/src/answer-search/answer-search.service.ts'
const FIXTURE = 'server/scripts/verify/fixtures/question-start-cases.json'
const TMP_OUT = path.join(ROOT, '.tmp', 'verify-question-start.json')

function read(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return fs.readFileSync(p, 'utf8')
}

let cachedRows = null
function runFixture() {
  if (cachedRows) return cachedRows
  fs.mkdirSync(path.dirname(TMP_OUT), { recursive: true })
  execFileSync(
    process.execPath,
    ['scripts/question-objects-build.mjs', '--from-fixture', 'scripts/verify/fixtures/question-start-cases.json', '--output', TMP_OUT],
    { cwd: SERVER, stdio: 'pipe', encoding: 'utf8' },
  )
  cachedRows = JSON.parse(fs.readFileSync(TMP_OUT, 'utf8')).rows
  return cachedRows
}

/** 按 source_id 分组，返回 { kind: [row...] } */
function grouped() {
  const out = {}
  for (const row of runFixture()) {
    ;(out[row.source_id] = out[row.source_id] || []).push(row)
  }
  return out
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// ---------- A. 静态守卫 ----------

m.test('A1 QUESTION_START 的半角点必须排除小数（\\.(?!\\d)）', (c) => {
  const src = read(MATCH)
  c.ok(/\\d\{1,3\}\\s\*\(\?:\[．、\]\|\\\.\(\?!\\d\)\)/.test(src), '未找到收紧后的题号分支（\\d{1,3}\\s*(?:[．、]|\\.(?!\\d))）')
  // 只查代码行：注释里会引用旧写法作对照，不算数
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  const stillOld = codeLines.filter((l) => /\\d\{1,3\}\\s\*\[．\.、\]/.test(l))
  c.ok(stillOld.length === 0, `旧写法 \\d{1,3}\\s*[．.、] 仍在代码里（半角点未排除小数）：${stillOld[0] || ''}`)
})

m.test('A2 SOLUTION_BOUNDARY_RE 与 QUESTION_START 同口径（防两套正则漂移）', (c) => {
  const src = read(MATCH)
  const hits = src.match(/\\d\{1,3\}\\s\*\(\?:\[．、\]\|\\\.\(\?!\\d\)\)/g) || []
  c.ok(hits.length >= 2, `收紧后的题号分支只出现 ${hits.length} 处，应为 2 处（QUESTION_START + SOLUTION_BOUNDARY_RE）`)
})

m.test('A3 切分规则版本已 bump 到 qobj-2（否则旧对象不会重建）', (c) => {
  const src = read(MATCH)
  c.ok(/OBJECT_ENGINE_VERSION\s*=\s*'qobj-2'/.test(src), 'OBJECT_ENGINE_VERSION 不是 qobj-2')
  c.ok(!/OBJECT_ENGINE_VERSION\s*=\s*'qobj-1'/.test(src), '仍存在 qobj-1 赋值')
})

m.test('A4 结果内容变了 ⇒ CACHE_VERSION 必须失效（当前 v17）', (c) => {
  const src = read(ANSWER_SVC)
  // D-049 切分口径 v14→v15；D-055 note 口径 v15→v16；D-060 删召回源 v16→v17。均已登记台账，
  // 断言守「当前登记值」而非某一个历史值；再 bump 须同步 M42 B6 / M44 A5 / M48 C3。
  c.ok(/const CACHE_VERSION = 'v17'/.test(src), 'CACHE_VERSION 不是 v16（旧缓存会吐旧 note 或指向旧边界）')
})

m.test('A5 本次只改切题层：input-guard 的 ITEM_START 未被波及', (c) => {
  const src = read(INPUT_GUARD)
  // 输入闸门判断的是「用户输入里有没有题目结构」，与库内切分不同源，刻意不动
  c.ok(/\\d\{1,3\}\\s\*\[．\.、\]/.test(src), 'input-guard 的 ITEM_START 被意外改动（本次不应波及输入侧）')
})

m.test('A6 fixture 必须包含会被误判的真实小数形态（不是只造好看样本）', (c) => {
  const text = read(FIXTURE)
  for (const real of ['1.18', '2.5', '97.7%', '3.3~3.36', '0.15']) {
    c.ok(text.includes(real), `fixture 缺真实小数形态：${real}`)
  }
})

// ---------- B. 行为守卫（真跑构建脚本） ----------

m.test('B1 纯小数表格不得切出任何题目边界（应合成 1 个整篇对象）', (c) => {
  const rows = grouped()['start-decimal-table'] || []
  c.ok(rows.length === 1, `期望 1 个对象，实际 ${rows.length} 个（小数仍在充当题目起点）`)
  c.ok(norm(rows[0].stem_text).includes('1.18'), '整篇对象未包含原本的小数内容')
})

m.test('B2 标准题号照常识别：3 道题切 3 个对象且 label 依次为 1./2./3.', (c) => {
  const rows = (grouped()['start-normal-items'] || []).sort((a, b) => a.object_index - b.object_index)
  c.ok(rows.length === 3, `期望 3 个对象，实际 ${rows.length} 个`)
  const labels = rows.map((r) => norm(r.label))
  c.ok(JSON.stringify(labels) === JSON.stringify(['1.', '2.', '3.']), `label 序列不符：${JSON.stringify(labels)}`)
  c.ok(rows.every((r) => String(r.stem_text).length >= 25), '存在题干过短的对象（切分把内容丢了）')
})

m.test('B3 小数与真题号混排：小数不得打断题目边界（恰 3 个对象）', (c) => {
  const rows = (grouped()['start-mixed'] || []).sort((a, b) => a.object_index - b.object_index)
  c.ok(rows.length === 3, `期望 3 个对象，实际 ${rows.length} 个（小数被当成了新题目）`)
  // 第 1 题必须完整包含它后面那些小数，而不是被 1.18 截断
  const first = norm(rows[0].stem_text)
  c.ok(first.includes('1.18') && first.includes('97.7%'), '第 1 题被小数截断（1.18/97.7% 未落在同一对象内）')
  for (const dec of ['1.18', '2.5', '97.7%', '3.3~3.36', '0.15', '0.8']) {
    c.ok(!rows.some((r) => norm(r.label) === dec.slice(0, dec.indexOf('.') + 1) && norm(r.stem_text) === dec),
      `小数 ${dec} 仍被切成独立对象`)
  }
})

m.test('B4 全角点与顿号不受影响（1．/ 2、仍识别）', (c) => {
  const rows = (grouped()['start-fullwidth-dunhao'] || []).sort((a, b) => a.object_index - b.object_index)
  c.ok(rows.length === 2, `期望 2 个对象，实际 ${rows.length} 个（收紧只应针对半角点）`)
  const labels = rows.map((r) => norm(r.label))
  c.ok(labels.some((l) => l.includes('1')), `未识别全角点题号，labels=${JSON.stringify(labels)}`)
  c.ok(labels.some((l) => l.includes('2')), `未识别顿号题号，labels=${JSON.stringify(labels)}`)
})

m.test('B5 判定层仍与登记基线一致（改切分不许顺手改六闸）', (c) => {
  const MOD45 = 'server/scripts/verify/modules/45-question-object-gate.mjs'
  const src = read(MOD45)
  const mm = src.match(/MATCH_BASELINE_SHA = '([0-9a-f]{64})'/)
  c.ok(mm, 'M45 里找不到 MATCH_BASELINE_SHA')
  const sha = crypto.createHash('sha256').update(read(MATCH), 'utf8').digest('hex')
  c.ok(sha === mm[1], `question-match.ts sha ${sha.slice(0, 12)}… 与 M45 登记基线 ${mm[1].slice(0, 12)}… 不一致（两处必须同步更新）`)
})

export default m
