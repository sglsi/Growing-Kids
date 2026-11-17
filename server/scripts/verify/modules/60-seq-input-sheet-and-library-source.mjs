// 模块 60：题号输入层 / 加入题目位置 / 错题提取从资料库选文件（D-080）
//
// 🔴 只守静态契约：真机打字光标是否还会跑、资料库选 PDF 后页图是否正确，
//    必须由思傅真机验收。静态断言不构成「真机已过」证据。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M60', '题号输入层 / 加入题目位置 / 资料库选来源文件（D-080）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const REC = 'src/pages/recognize/index.tsx'
const PICKER = 'src/components/material-picker.tsx'

m.test('A1 题号输入：原生 input 只在独立顶部输入层里出现', (c) => {
  const s = read(REC)
  c.ok(/function SeqSpecInputSheet\(/.test(s), '须有独立的题号输入层组件')
  c.ok(/<SeqSpecInputSheet[\s\S]{0,400}\/>/.test(s), '输入层须真正挂载')
  c.ok(
    /<\/ScrollView>[\s\S]{0,500}<SeqSpecInputSheet/.test(s),
    '输入层须在 ScrollView 之外（不能嵌在滚动容器里，否则光标仍会被顶走）',
  )
  c.ok(/adjustPosition=\{false\}/.test(s), '输入层不许微信再上推页面')
  c.ok(/cursorSpacing=\{24\}/.test(s), '光标与键盘之间须留空隙')
  c.ok(/focus\b/.test(s), '打开输入层时须直接聚焦，用户点一下就能打字')
  c.ok(/固定.{0,40}屏幕最上方|固定在屏幕最上方/.test(s), '注释须写明设计意图（固定在最上方）')

  // 行内那一行现在是「点按展示」，不能再留一个原生 Input
  const cardStart = s.indexOf('P-031：按题号提取 ——')
  const cardEnd = s.indexOf('题目清单：每题', cardStart)
  const card = s.slice(cardStart, cardEnd)
  c.ok(!/<Input[\s\S]{0,300}value=\{seqInput\}/.test(card), '卡片里不许再有原生 Input（原故障源）')
  c.ok(/onClick=\{\(\) => setSeqSheetOpen\(true\)\}/.test(card), '卡片那行改为点按打开输入层')
  c.ok(!/defaultValue\s*=/.test(s), '不许下发 defaultValue 属性（会覆盖原生当前文本、光标甩末尾）')
})

m.test('A2 输入光标纪律：同步上抛 + flushSync + 丢非字符串回抛', (c) => {
  const s = read(REC)
  c.ok(/import \{ flushSync \} from '@tarojs\/react'/.test(s), '必须用 Taro 的 flushSync（不是 react-dom 的）')
  c.ok(
    /const next = e\?\.detail\?\.value\s*\n\s*if \(typeof next !== 'string'\) return/.test(s),
    'detail.value 不是字符串的回抛事件须丢掉（否则会把刚打的字清空）',
  )
  c.ok(
    /flushSync\(\(\) => onChange\(next\)\)/.test(s),
    'input 事件里当场同步刷新，让 Taro 恢复受控值时看到的值等于本拍文本',
  )
  c.ok(/value=\{value\}/.test(s), '受控 value 必须传（不传时微信打不进字）')
  c.ok(!/setTimeout[\s\S]{0,80}onChange/.test(s), '不许延迟上抛（实测会把文本改回上一拍）')
})

m.test('A3 加入题目：只在按题号提取区最下方出现一次', (c) => {
  const s = read(REC)
  const applyCount = (s.match(/handleSeqApply\(\)/g) || []).length
  c.ok(applyCount === 1, `加入题目按钮须只有一处（实际 ${applyCount} 处）`)
  const cardStart = s.indexOf('P-031：按题号提取 ——')
  const cardEnd = s.indexOf('题目清单：每题', cardStart)
  const card = s.slice(cardStart, cardEnd)
  const applyAt = card.indexOf('handleSeqApply()')
  const rowsAt = card.lastIndexOf('seqRows.map(')
  c.ok(applyAt > rowsAt, '加入题目须放在逐题列表之后（区域最下方）')
  c.ok(/加入题目（\{seqRows/.test(card), '按钮须显示已裁题数')
  c.ok(/w-full h-11/.test(card.slice(applyAt - 400, applyAt)), '按钮须占整行，位置与原来的行内小按钮不同')
})

m.test('A4 错题提取从资料库选文件：PDF 出页图 / 图片直用 / 其它格式不静默跳过', (c) => {
  const s = read(REC)
  c.ok(/const addBoardPagesFromLibraryDoc = async \(d: LibraryDoc\)/.test(s), '须有资料库文件 → 来源页的处理函数')
  c.ok(/await appendDocPageImages\(d\.url, room\)/.test(s), '资料库 PDF 须走与本地 PDF 相同的页图渲染链')
  c.ok(/const isPdf = [\s\S]{0,160}appendDocPageImages/.test(s), 'PDF 判定须在渲染前完成')
  c.ok(/const isImage = \/\^image\\\/\//.test(s), '图片按 mime 判定')
  c.ok(/url: d\.url,[\s\S]{0,80}w: d\.width \|\| 0/.test(s), '资料库图片直接用云端 URL 作来源页，不再二次上传')
  c.ok(/Word\/TXT 没有页图/.test(s), 'Word/TXT 须明确告知不支持，不能静默跳过')
  c.ok(/最多添加 \$\{MAX_BOARD_PAGES\} 页/.test(s), '资料库导入同样受页数上限约束')

  const picker = read(PICKER)
  c.ok(/export default function MaterialPicker\(/.test(picker), '复用现有资料库选择器，不另造一套')
  c.ok(/fetchLibrary\(\{ pageSize: 100 \}\)/.test(picker), '选择器须从 /api/library 拉真实资料')
  c.ok(/pickerForBoard \? '从资料库选择来源文件' : '从资料库选择文档'/.test(s), '同一弹窗按场景切换标题')
  c.ok(/if \(pickerForBoard\) void addBoardPagesFromLibraryDoc\(d\)/.test(s), '选中后须按场景分派到错题提取')
  const entries = (s.match(/setPickerForBoard\(true\); setPicker\(true\)/g) || []).length
  c.ok(entries >= 3, `错题提取入口须能从多处打开资料库（实际 ${entries} 处，至少 3 处）`)
})

export default m
