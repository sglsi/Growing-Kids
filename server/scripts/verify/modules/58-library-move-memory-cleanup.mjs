// 模块 58：资料库批量移动 + 识别页按钮并排 + 记忆页科目/分类移除（D-078）
//
// 🔴 本模块守静态契约：三项 UI 改动的关键结构不被后续误改回去。
//    真机交互效果（移动是否成功、按钮是否等宽、记忆页是否清爽）由思傅真机验收，
//    静态断言不构成「真机已过」证据。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M58', '资料库批量移动 + 识别页按钮 + 记忆页清理（D-078）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const LIB = 'src/pages/library/index.tsx'
const REC = 'src/pages/recognize/index.tsx'
const MEM_IDX = 'src/pages/memory/index.tsx'
const MEM_CARD = 'src/components/memory-card.tsx'
const MEM_EDIT = 'src/pages/memory/edit.tsx'
const MEM_DETAIL = 'src/pages/memory/detail.tsx'
const API = 'src/services/api.ts'

m.test('A1 资料库批量移动：批量栏有移动到按钮 + 后端不新增批量端点', (c) => {
  c.ok(exists(LIB), '资料库页须存在')
  const s = read(LIB)
  c.ok(/kind: 'batch'/.test(s), 'folderPicker 须支持 batch 模式')
  c.ok(/label="移动到…"/.test(s), '批量栏须有「移动到…」按钮')
  c.ok(/kind: 'batch', id: '', name: `选中的/.test(s), '移动到按钮须带选中 id 列表')
  c.ok(/p\.kind === 'batch'/.test(s), 'handleFolderPickerPick 须处理 batch 分支')
  c.ok(/await moveLibraryDocToFolder\(id, target\)/.test(s), '批量移动逐条走既有单条 PATCH')
  c.ok(/failCount \? `已移动 \$\{okCount\} 份/.test(s), '部分失败须逐条统计不掩盖')
  const api = read(API)
  c.ok(!/batchMoveLibrary|batch.*[Ff]older/.test(api), '后端 API 不新增批量移动端点（前端循环即可）')
})

m.test('A2 识别页按钮：两个并列主操作等宽同款 + 文案更新', (c) => {
  c.ok(exists(REC), '识别页须存在')
  const s = read(REC)
  c.ok(!/开始识别/.test(s), '「开始识别」旧文案须全部替换')
  c.ok(!/以图片形式直接保存到最近题目/.test(s), '旧长文案须全部替换（含注释处除外由下方细判）')
  c.ok(/识别文字/.test(s), '须有「识别文字」新文案')
  c.ok(/以图片形式保存/.test(s), '须有「以图片形式保存」新文案')
  // 两个按钮须在同一个 flex row 容器内、都用 flex-1 等宽、都用 Button。
  // 用跨越真实按钮块的多行正则（注释里也提到文案，indexOf 会误命中）。
  const bm = s.match(/<View className="flex flex-row gap-3">\s*<Button className="flex-1 h-11 rounded-xl"[\s\S]{0,400}?<\/View>/)
  c.ok(!!bm, '两按钮须在同一 flex flex-row gap-3 容器')
  const block = bm ? bm[0] : ''
  const flexBtnCount = (block.match(/<Button className="flex-1 h-11 rounded-xl"/g) || []).length
  c.ok(flexBtnCount === 2, `两按钮须都 flex-1 h-11 rounded-xl 等宽同款（实际 ${flexBtnCount}）`)
  c.ok(/识别文字/.test(block) && /以图片形式保存/.test(block), '容器内含两块新文案')
})

m.test('A3 记忆列表页：分类/科目筛选整体移除', (c) => {
  const s = read(MEM_IDX)
  c.ok(!/SegmentedTabs/.test(s), '分类筛选 Tab 须移除')
  c.ok(!/CAT_OPTIONS/.test(s), '分类选项须移除')
  c.ok(!/fetchSubjects|subjectId|setSubjectId|subjects\b/.test(s), '科目筛选 state/加载须移除')
  c.ok(!/category === 'all'|setCategory|CatValue/.test(s), '分类 state 须移除')
  c.ok(/hasFilter = timeRange !== 'all' \|\| !!activeKeyword/.test(s), '筛选判定只留时间+关键词')
  c.ok(/换个时间范围或关键词看看/.test(s), '空态文案不再提科目')
})

m.test('A4 记忆卡片：分类标签/学科徽章/学科色条移除，心情保留', (c) => {
  const s = read(MEM_CARD)
  c.ok(!/getSubjectColor|subjectColor|subjectName/.test(s), '学科符号须全清')
  c.ok(!/getMemoryCategoryLabel|categoryLabel/.test(s), '分类标签符号须全清')
  c.ok(!/<Badge/.test(s), 'Badge 标签须移除（分类/学科徽章载体）')
  c.ok(!/memory\.category === 'study'/.test(s), '学科色条条件分支须移除')
  c.ok(/getMemoryMoodEmoji|moodEmoji/.test(s), '心情展示须保留')
})

m.test('A5 记忆编辑/详情：分类学科界面移除 + 历史分类不覆盖', (c) => {
  const ed = read(MEM_EDIT)
  c.ok(!/MEMORY_CATEGORIES/.test(ed), '编辑页分类选项须移除')
  c.ok(!/fetchSubjects|setSubjectId|\bsubjects\b/.test(ed), '编辑页学科选择须移除')
  c.ok(/category: 'life'/.test(ed), '新建固定 category=life')
  c.ok(/\.\.\.\(editId \? \{\} : \{ category: 'life' \}\)/.test(ed), '编辑时不传 category（保留服务端原值）')
  c.ok(!/subject_id:/.test(ed), '提交 payload 不再写 subject_id')
  const dt = read(MEM_DETAIL)
  c.ok(!/catLabel|getMemoryCategoryLabel|subjectName|getSubjectColor/.test(dt), '详情页分类/学科展示须移除')
  c.ok(/moodEmoji/.test(dt), '详情页心情展示须保留')
})

export default m
