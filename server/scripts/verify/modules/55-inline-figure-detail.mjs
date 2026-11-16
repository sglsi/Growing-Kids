// 模块 55：题目详情页「题干图文混排」静态契约（D-074 / P-034）
//
// 🔴 只守静态契约 + 源头零依赖。真实渲染（rich-text 是否真把 [图N] 换成图）、
//    真机裁剪/上传、签名 URL 是否可匿名 GET——由动态实证与真机回归另行证明；
//    本模块不得被当成「已验证面客效果」的证据。
//
// ⚠️ 后台推开历史：题干是纯 textarea（原生组件，框内插不了 img），所以采用
//    「编辑态可见 [图N] + 展示态 RichText 按槽位插图」。断言要守住这条边界，
//    防止有人把 textarea 换成富文本、踩坏已修好的一堆光标补丁。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M55', '题干图文混排：占位符 + 内嵌图随题干存储（D-074）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const LIB = 'src/lib/question-inline-figure.ts'
const DETAIL = 'src/pages/detail/index.tsx'
const API = 'src/services/api.ts'
const TYPES = 'src/types/index.ts'
const BE_TYPES = 'server/src/timeline/timeline.types.ts'
const BE_SVC = 'server/src/timeline/timeline.service.ts'
const DYN = 'dynamic-tests/run-inline-figure-p034.cjs'

m.test('A1 纯函数零依赖 + fail-closed 降级', (c) => {
  c.ok(exists(LIB), '须有 src/lib/question-inline-figure.ts')
  const s = read(LIB)
  c.ok(!/^import /m.test(s), '混排 helper 必须零依赖（与 question-locate.ts 同口径，便于动态实证）')
  c.ok(/export function questionRichHtml/.test(s), '须导出 questionRichHtml')
  c.ok(s.includes('\\[图(\\d+)\\]'), '占位符正则须认 [图N]')
  // 无 URL / 无槽位 ⇒ 原样显示标记，绝不拿别图顶替（D-020「错图比没图更糟」）
  c.ok(/: escapeRichHtml\(m\[0\]\)/.test(s), '没 URL 时须把 [图N] 原样输出成文字（fail-closed）')
  c.ok(/urlBySlot\.get\(Number\(m\[1\]\)\)/.test(s), '须按槽位数字严格取图，禁止模糊匹配')
  c.ok(/escapeRichHtml\(s: string\)/.test(s) && /\.replace\(\/&\/g/.test(s), '须转义题干 HTML 特殊字符')
  c.ok(/\.replace\(\/"\/g, '%22'\)/.test(s) && /\.replace\(\/\\s\/g, ''\)/.test(s), 'URL 须剥引号/空白，防属性注入')
  c.ok(/export function removeFigureMarker/.test(s), '须能按槽位删标记（图文一起删）')
  c.ok(/export function hasFigureMarker/.test(s), '须能识别题干是否含图标记')
})

m.test('A2 前后端契约：字段对齐 + jsonb 免迁移 + 签名 URL', (c) => {
  const bt = read(BE_TYPES)
  c.ok(/interface QuestionInlineFigure/.test(bt) && /slot: number/.test(bt) && /file_key: string/.test(bt), '后端须声明 QuestionInlineFigure（slot + file_key）')
  c.ok(/question_inline_figures\?: QuestionInlineFigure\[\]/.test(bt), '后端 QuestionContent 须声明 question_inline_figures')
  c.ok(/question_inline_figure_urls\?: \(string \| undefined\)\[\]/.test(bt), '后端 TimelineItemWithUrl 须声明派生 URL 字段')
  const svc = read(BE_SVC)
  const seg = svc.slice(svc.indexOf('const inlineFigs'), svc.indexOf('const aImgs'))
  c.ok(/getPublicUrl\(f\.file_key\)/.test(seg), 'withUrls 须为每张内嵌图补签名 URL（否则前端渲染裂图）')
  c.ok(/catch/.test(seg) && /return undefined/.test(seg), '单张签名失败须降级为 undefined，不让整条题目挂掉')
  // content 是 jsonb 浅合并 ⇒ 免迁移；这条守住「不许偷偷加迁移」
  c.ok(!exists('migrations/0034_question_inline_figures.sql'), '内嵌图走 content jsonb，禁止为它加迁移（浅合并已足够）')

  const fe = read(TYPES)
  c.ok(/question_inline_figures\?: QuestionInlineFigure\[\]/.test(fe), '前端 QuestionContent 字段须与后端同名')
  c.ok(/question_inline_figure_urls\?: \(string \| undefined\)\[\]/.test(fe), '前端 TimelineItem 派生字段须与后端同名')
  const api = read(API)
  c.ok(/question_inline_figures/.test(api) && /question_inline_figures: payload\.question_inline_figures/.test(api), 'updateQuestion 须把内嵌图透传进 patch.content')
})

m.test('A3 详情页：图文一次事务 + 两种来源 + 编辑态不碰光标补丁', (c) => {
  const s = read(DETAIL)
  c.ok(/import \{ questionRichHtml, removeFigureMarker \} from '@\/lib\/question-inline-figure'/.test(s), '详情页须复用零依赖 helper（不许在页面内复制一份）')
  c.ok(/questionRichHtml\(qContent/.test(s), '展示态须用 RichText 渲染题干（把 [图N] 换成真图）')
  // 红线：textarea 保持纯文本；不许换成富文本编辑器（会踩坏 qCaret 一堆补丁）
  c.ok(!/contentEditable/.test(s) && !/editor\/rich/.test(s), '题干仍是原生 textarea，禁止改成富文本编辑器（光标补丁红线）')
  c.ok(/qCaret\.request/.test(s) && /qCaret\.refocus\(\)/.test(s), '插标记仍走 qCaret 程序化写入（与插符号同款）')

  // 两种来源
  c.ok(/handleAddFigureFromCamera/.test(s) && /sourceType: \['camera', 'album'\]/.test(s), '来源①相册/拍照')
  c.ok(/guardPolicy\('选择图片'\)/.test(s) && /guardPrivacy\('选择图片'\)/.test(s), '相册来源须过双闸门（政策同意 + 平台授权）')
  c.ok(/handleAddFigureFromQuestionImage/.test(s) && /showActionSheet/.test(s), '来源②题面图裁图（多张时点选）')
  c.ok(/purpose: 'attach'/.test(s), '内嵌图 attach 上传（不建独立 timeline 条目）')
  c.ok((s.match(/cropOnly/g) || []).length >= 2, '两个分支都须挂 cropOnly 裁剪器（图片条目/题目条目）')

  // 图文一次提交；剥掉临时 URL；删除图文同步
  c.ok(/question_inline_figures: inlineFigures\.map/.test(s), 'handleSave 须把内嵌图与文字一起提交（不能存文丢图）')
  c.ok(/\{ slot, file_key, width, height \}/.test(s), '落库前须剥掉 _url 临时签名（不写进 content）')
  c.ok(/removeFigureMarker\(qDraftRef\.current, slot\)/.test(s), '删图须同时删题干标记（不留孤儿 [图N]）')
  c.ok(/nextFigSlot = \(\) => inlineFigures\.reduce/.test(s), 'slot 取最大+1，删除留空洞不复用（防旧标记指向新图）')

  // 两个分支都要有入口（历史教训：功能只挂一个分支 = 另一半用户看不到）
  c.ok((s.match(/\{figureSection\}/g) || []).length >= 2, '图片条目/题目条目两个分支都须挂图文区')
})

m.test('A4 实证脚本覆盖', (c) => {
  c.ok(exists(DYN), '须有可复跑的动态实证脚本')
  const d = read(DYN)
  for (const kw of ['两个有 URL', '降级成文字', '不拿邻图顶', '不能注入 onerror', '删 [图1] 不误删 [图10]', '两个分支都挂了裁剪编辑器']) {
    c.ok(d.includes(kw), `实证须覆盖「${kw}」`)
  }
})

export default m
