// 模块 61：删除题目后的滚动定位 / 资料库选择器显示文件夹（D-081）
//
// 🔴 静态契约，真机手感（删除后停在哪一题、文件夹路径是否好认）由思傅验收。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M61', '删除题目滚动补偿 / 资料库文件夹信息（D-081）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const REC = 'src/pages/recognize/index.tsx'
const HOOK = 'src/lib/use-keyboard-avoid.ts'
const PICKER = 'src/components/material-picker.tsx'

m.test('A1 删除题目后停在原位，不跳列表顶部', (c) => {
  const s = read(REC)
  c.ok(/id=\{`board-entry-\$\{idx\}`\}/.test(s), '题目卡须有可测量的 id')
  const start = s.indexOf('const removeEntry =')
  const end = s.indexOf('const moveEntry =', start)
  const fn = s.slice(start, end)
  c.ok(/createSelectorQuery\(\)\.select\(`#board-entry-\$\{idx\}`\)/.test(fn), '删前须量被删卡片高度')
  c.ok(/kb\.scrollTop - shift/.test(fn), '滚动位置须按被删卡片高度回退，而不是置 0')
  c.ok(/setTimeout\(\(\) => kb\.scrollTo\(keepAt\), 30\)/.test(fn), '须等新列表渲染完再写回 scrollTop')
  c.ok(/prev\.filter\(\(_, i\) => i !== idx\)/.test(fn), '仍只删指定那一条，不连带改数据')
})

m.test('A2 Hook 提供受控滚动写入口', (c) => {
  const h = read(HOOK)
  c.ok(/scrollTo: \(top: number\) => void/.test(h), '接口须暴露 scrollTo')
  c.ok(/const scrollTo = useCallback\(\(top: number\) => \{/.test(h), '须实现 scrollTo')
  c.ok(/scrollTopRef\.current = next[\s\S]{0,80}setScrollTop\(next\)/.test(h), '写 scrollTop 时同步 ref，避免下次 onScroll 覆盖')
  c.ok(/return \{[\s\S]{0,300}scrollTo,/.test(h), 'scrollTo 须真的返回给调用方')
})

m.test('A3 资料库选择器带文件夹路径', (c) => {
  const p = read(PICKER)
  c.ok(/fetchLibraryFolders\(\)/.test(p), '须拉取文件夹列表')
  c.ok(/function folderPathOf\(folders: LibraryFolder\[\]/.test(p), '须有根→当前的路径解析')
  c.ok(/depth < 32/.test(p), '路径解析须有防环上限')
  c.ok(/文件夹：\{folderPath\}/.test(p), '每条资料须显示所属文件夹')
  c.ok(
    /fetchLibraryFolders\(\)\.catch\(/.test(p),
    '文件夹拉取失败须降级为空（不能挡住选文件）',
  )
  c.ok(/truncate/.test(p), '路径过长须截断，不撑破列表项')
})

export default m
