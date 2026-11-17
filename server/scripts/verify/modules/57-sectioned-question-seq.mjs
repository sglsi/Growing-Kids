// 模块 57：分节题号「一6,二5,二6」静态契约（D-077，方案 A）
//
// 🔴 红线：判定层 question-match.ts 一行未动、原 parseSeqSpec/locateQuestions
//    老路径逐字不变。本模块只守静态契约 + 零依赖；分节区间是否真不串节由动态
//    实证（run-sectioned-seq-d077.cjs）证明，真机效果由思傅验收。不得被当成
//    「判定层准入已过」的证据。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M57', '分节题号解析与逐节定位（D-077 方案 A）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const LOC = 'src/lib/question-locate.ts'
const REC = 'src/pages/recognize/index.tsx'
const QM = 'server/src/shared/question-match.ts'
const DYN = 'dynamic-tests/run-sectioned-seq-d077.cjs'

m.test('A1 定位层零依赖 + 分节函数并列新增', (c) => {
  c.ok(exists(LOC), '须有零依赖定位真相源')
  const s = read(LOC)
  c.ok(!/^\s*import\s/m.test(s), 'question-locate.ts 必须零依赖（dynamic-tests 真实转译执行）')
  c.ok(/export interface SectionedRef/.test(s), '须导出 SectionedRef 类型')
  c.ok(/export function parseSectionedSpec/.test(s), '须导出 parseSectionedSpec')
  c.ok(/export function locateSectionedQuestions/.test(s), '须导出 locateSectionedQuestions')
  c.ok(/function sectionRanges/.test(s), '须识别分节 y 区间')
  c.ok(/function sectionedQuestionNumber/.test(s), '须认「节号贴号」行（（二）6）')
})

m.test('A2 老路径零回归（原函数保留 + scope 可选）', (c) => {
  const s = read(LOC)
  c.ok(/export function parseSeqSpec\(raw: string\): number\[\] \| null/.test(s), '原 parseSeqSpec 签名逐字保留')
  c.ok(/export function locateQuestions\(/.test(s), '原 locateQuestions 保留')
  c.ok(/scope\?: \{ y0: number; y1: number; section: string \}/.test(s), 'scope 必须是可选参数（不传走老路径）')
  c.ok(/const bottomPx = scope \? Math\.min\(pageH, scope\.y1\) : pageH/.test(s), '区间底仅在有 scope 时收口')
  c.ok(/const inScope = \(y0: number\): boolean =>/.test(s), 'scope 过滤须是不可见开关（无 scope 恒真）')
})

m.test('A3 判定层一行未动 + fail-closed', (c) => {
  c.ok(exists(QM), '判定层真相源须存在')
  const qm = read(QM)
  c.ok(!/^\s*import\s/m.test(qm), '判定层仍零依赖')
  c.ok(!/SectionedRef|parseSectionedSpec|sectionRanges/.test(qm), '判定层不得出现分节相关符号（红线：一行未动）')
  const s = read(LOC)
  c.ok(/index: -1,[\s\S]{0,200}stemRect: \{ x: 0, y: 0, w: 1, h: 1 \}/.test(s), '卷面无该节时 fail-closed 整页候选，不借邻节区间（D-020）')
})

m.test('A4 识别页接入：分节优先 + 回落老路径 + 补图同 refs', (c) => {
  const s = read(REC)
  c.ok(/parseSectionedSpec,[\s\S]{0,120}locateSectionedQuestions/.test(s), '识别页须导入分节解析与定位')
  c.ok(/const sectioned = parseSectionedSpec\(seqInput\)/.test(s), '须先尝试分节解析')
  c.ok(/sectioned \? locateSectionedQuestions\(segs, pw, ph, sectioned, figs\) : locateQuestions\(/.test(s), '分节走新路径，纯数字回落老路径')
  c.ok(/refs: SectionedRef\[\] \| null/.test(s), 'lastLocateRef 须存分节输入')
  c.ok(/task\.refs\s*\n?\s*\? locateSectionedQuestions/.test(s), '补全图形须用同一份 refs 重算，节区间不丢')
  c.ok(/按 index 而非 label 合并/.test(s), '同号不同节（一6/二6）须按 index 合并，不得用 label Map 互相覆盖')
})

m.test('A5 动态实证覆盖 + 展示与输入提示', (c) => {
  c.ok(exists(DYN), '须有可复跑的动态实证脚本')
  const d = read(DYN)
  for (const kw of [
    '分节写法解析为 5 条',
    '（一）6 与（二）6 是不同区间（不串节）',
    '（二）5 框尾不吃掉（二）6 的题号行',
    '22 题为末题，框尾收在节内',
    '未识别到的节 → 整页候选（不借邻节）',
    'locateQuestions 不传 scope 结果稳定（逐字节）',
    'question-match.ts sha256',
  ]) {
    c.ok(d.includes(kw), `实证须覆盖「${kw}」`)
  }
  const s = read(REC)
  c.ok(/r\.section \? `（\$\{r\.section\}）第/.test(s), '题目行须展示节号（（二）第6题）')
  c.ok(/或分节 一6,二5/.test(s), '输入框 placeholder 须提示分节写法')
})

export default m
