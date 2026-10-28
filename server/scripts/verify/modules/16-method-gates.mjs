// 模块 16：方法论治理硬门（GK-OPS-22 §4）
//
// 这一模块本身不产生新逻辑——它把 `server/scripts/method-gates.mjs` 的三条硬门
// 纳入套件，使「本地跑一次 pnpm verify」与「CI 跑一次 gate」检查的是同一套判据。
//
// 为什么要有这一层包装：
//   ① 套件是项目里唯一的「一命令全查」入口，门禁藏在别处就不会被跑；
//   ② 每个门拆成一条用例，失败时能直接看出是哪一条门破了，而不是一个总退出码；
//   ③ 三条门都只验**机器能判定**的部分（结构/词表/镜像），语义判断留给人——
//      这是 OPS-22 §4 的明确取舍，别在这里加"归因是否成立"这类伪断言。

import { Module } from '../lib/harness.mjs'
import { runGates } from '../../method-gates.mjs'

const m = new Module('M16', '方法论治理硬门')

const detail = (r) => (r && r.errors.length ? r.errors.slice(0, 6).join('；') : '')

m.test('H1 归因门：提案单六栏齐备、引用可解析', async (c) => {
  const r = runGates('h1').h1
  c.ok(r, 'H1 未执行（找不到 20a/20b 或提案目录）')
  c.eq(r.errors.length, 0, `不合格：${detail(r)}`)
})

m.test('H2 口径门：用户可见面不含禁用宣称词', async (c) => {
  const r = runGates('h2').h2
  c.ok(r, 'H2 未执行')
  c.eq(r.errors.length, 0, `不合格：${detail(r)}`)
})

m.test('H3 同步门：镜像参数逐字一致（间隔表 / 导出口径）', async (c) => {
  const r = runGates('h3').h3
  c.ok(r, 'H3 未执行')
  c.eq(r.errors.length, 0, `不合格：${detail(r)}`)
})

m.test('观测通道自身有效：H1 解析到 20a 的准则集与 20b 的文献上界', async (c) => {
  // 防止 "空集也通过" 这种假绿：如果解析失败，H1 会静默放行所有引用。
  const fs = await import('fs')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const DESIGN = path.resolve(HERE, '..', '..', '..', '..', 'docs', 'design')
  const a = fs.readFileSync(path.join(DESIGN, 'GK-SRS-20a-科学学习方法论指引.md'), 'utf8')
  const b = fs.readFileSync(path.join(DESIGN, 'GK-SRS-20b-学习科学方法论指引.md'), 'utf8')
  const mIds = [...a.matchAll(/^####\s*M(\d+)/gm)].map((x) => Number(x[1]))
  c.eq(mIds.length >= 10, true, `20a 只解析到 ${mIds.length} 条准则（应 ≥10），H1 的引用校验形同虚设`)
  c.ok(/^##\s*7\.\s*参考文献/m.test(b), '20b 找不到第 7 章参考文献，文献号上界将无法解析')
})

export default m
