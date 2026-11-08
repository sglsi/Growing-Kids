// 模块 40：题干原位重建（P-018 / D-021）
//
// 为什么单独一个模块：M39 守住了「参考例题要带整块快照」，但 `D-020` 的快照是
// **整页一条横带贴在题干下方**——题干文字本身还是残的（`<w:object>` 被当标签剥掉），
// 数学题读起来是「关于x的一元二次方程␠␠有两个相等的实数根」。思傅 2026-11-08 拍板
// 「走 C，直接从 doc 抠图」，M40 守的就是这条路：
//
// 🔴 核心契约：**图必须插回它原本所在的字符位置；定位不到就不入库不下发；
//    偏移必须换算成前端能用的 UTF-16 索引；只读挂载不影响判定与召回。**
//
// 为什么负向断言要先剥注释：与 M38/M39 同坑——说明性注释里恰恰要写
// 「绝不拿相邻题顶替」「不走 wmf2svg」，不剥注释就会被自己的说明打成 FAIL。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M40', '题干原位重建验收集（P-018 / D-021）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const REF = 'server/src/shared/question-reference.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const API_TS = 'src/services/api.ts'
const MIG = 'migrations/0029_question_inline_figures.sql'
const MIG_DONE = 'migrations/0030_question_inline_done.sql'
const BUILDER = 'server/scripts/netdisk-inline-build.mjs'
const CROPPER = 'server/scripts/netdisk-inline-crop.py'
const PROPOSAL = 'docs/design/method/proposals/P-018-题干原位重建.md'
const DECISION = 'docs/design/method/decision-log.md'

/** P-018 之前（含 P-017）所有钉住 CACHE_VERSION 的模块，bump 必须同步 */
const VERSION_MODULES = [
  'server/scripts/verify/modules/27-question-match.mjs',
  'server/scripts/verify/modules/31-question-objects.mjs',
  'server/scripts/verify/modules/32-question-objects-store.mjs',
  'server/scripts/verify/modules/33-public-library-text-recall.mjs',
  'server/scripts/verify/modules/34-p2-topn-p3-deep-source.mjs',
  'server/scripts/verify/modules/35-recall-anchors.mjs',
  'server/scripts/verify/modules/36-upstream-input-guard.mjs',
  'server/scripts/verify/modules/37-reference-examples.mjs',
  'server/scripts/verify/modules/38-input-guard-reference-scope.mjs',
  'server/scripts/verify/modules/39-question-figures.mjs',
]

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** JS/TS：去掉块注释与整行 // 注释 */
function codeJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

/** SQL：去掉整行 -- 注释 */
function codeSql(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
}

/** Python：去掉整行 # 注释与三引号文档串 */
function codePy(src) {
  const noDoc = src.replace(/"""[\s\S]*?"""/g, '')
  return noDoc
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

m.test('🔴 B1 判定层真相源一行未动（与 M35–M39 同基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(
    crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层',
  )
  c.ok(!/inlineFigures|charOffset|question_inline/.test(src), '原位重建逻辑被塞进判定层真相源')
})

m.test('🔴 B2 迁移 0029/0030：表 / 唯一键 / 版本列齐全，且不动其它表', (c) => {
  const sql = read(MIG)
  c.ok(/create table if not exists question_inline_figures/i.test(sql), '缺 question_inline_figures 建表')
  for (const col of [
    'user_id', 'source_type', 'source_id', 'object_index', 'seq', 'char_offset',
    'kind', 'storage_key', 'width', 'height', 'source_revision', 'engine_version',
  ]) {
    c.ok(new RegExp(`\\b${col}\\b`).test(sql), `0029 缺列 ${col}`)
  }
  c.ok(
    /unique index[\s\S]{0,160}question_inline_figures\s*\(user_id, source_type, source_id, object_index, seq\)/i.test(sql),
    '缺 (user, source_type, source_id, object_index, seq) 唯一键（重跑必须幂等）',
  )
  c.ok(/check \(kind in \('formula', 'figure'\)\)/i.test(sql), 'kind 没有取值约束（会出现未知类型）')
  const body = codeSql(sql)
  c.ok(!/(alter|drop|truncate)\s+table/i.test(body), '0029 不得改动其它表')
  c.ok(!/update\s+question_objects|update\s+netdisk_files/i.test(body), '0029 不得写题目对象或文件表')

  const done = read(MIG_DONE)
  c.ok(/create table if not exists question_inline_done/i.test(done), '缺 0030 扫描记账表（0 图文档会被反复重试）')
  c.ok(/primary key \(user_id, source_id\)/i.test(done), '0030 缺主键（记账必须幂等）')
  c.ok(!/(alter|drop|truncate)\s+table/i.test(codeSql(done)), '0030 不得改动其它表')
})

m.test('🔴 B3 构建脚本：默认 dry-run、只写两张表、公式不走 wmf2svg', (c) => {
  const b = read(BUILDER)
  c.ok(/const APPLY = has\('--apply'\)/.test(b), '缺少 --apply 开关（默认必须是 dry-run）')
  c.ok(/question_inline_figures/.test(b), '缺入库目标 question_inline_figures')
  c.ok(/question_inline_done/.test(b), '缺扫描记账写入')
  c.ok(/on conflict \(user_id, source_type, source_id, object_index, seq\)/i.test(b), '不是幂等 upsert')
  const body = codeJs(b)
  c.ok(!/insert into question_objects|update question_objects/i.test(body), '构建脚本不得写 question_objects')
  c.ok(!/insert into question_figures|update question_figures/i.test(body), '构建脚本不得碰 P-017 的 question_figures')
  c.ok(!/wmf2svg|wmf2gd/.test(body), '改用 wmf2svg 作入库来源（实测字符级错乱，见 D-021）')
  c.ok(/MIN_FREE_MB/.test(b), '缺内存闸门（P-017 事故换来的护栏）')
  c.ok(/DOC_TIMEOUT_MS/.test(b), '缺单份超时护栏')

  const py = codePy(read(CROPPER))
  c.ok(/pypdfium2/.test(py), '公式没有走 PDF 渲染（pypdfium2）')
  c.ok(/figures\/%s\/%s\.webp/.test(py), '图片未走内容寻址 key（figures/<2>/<sha>.webp）')
})

m.test('🔴 B4 定位失败/跨行 ⇒ 不入库不顶替（绝不拿相邻行或相邻题）', (c) => {
  const py = codePy(read(CROPPER))
  c.ok(/def crop_formula/.test(py), '缺 crop_formula')
  c.ok(/return None/.test(py), '裁切失败没有返回 None（有顶替风险）')
  c.ok(!/neighbor|fallback_stem|prev_object|next_object/.test(py), '出现「拿相邻题/相邻行兜底」的写法')
  c.ok(/if img is None:\s*\n\s*continue/.test(py), 'img 为空时没有 continue（会入库空图）')
  const b = codeJs(read(BUILDER))
  c.ok(!/placeholder|defaultFigure|占位图/.test(b), '构建侧出现占位图兜底')
})

m.test('🔴 B5 后端只读挂载 + 码点→UTF-16 换算 + 越界丢弃', (c) => {
  const nd = read(SERVICE_ND)
  c.ok(/private async attachInlineFigures/.test(nd), '缺 attachInlineFigures 挂载点')
  c.ok(/from\('question_inline_figures'\)/.test(nd), '没有查 question_inline_figures')
  c.ok(/\.eq\('user_id', publicLibraryOwner\(\)\)/.test(nd), '公共库取图必须用 publicLibraryOwner()')
  c.ok(/function cpToUtf16/.test(nd), '缺 cpToUtf16（码点偏移直接给前端会插进汉字中间）')
  c.ok(/charOffset: cpToUtf16\(ref\.stem, f\.charOffset\)/.test(nd), '没有在挂载时把码点偏移换算成 UTF-16')
  c.ok(/f\.charOffset <= ref\.stem\.length/.test(nd), '偏移越界没有过滤（会插到 stem 之外）')
  const body = codeJs(nd)
  c.ok(!/(insert|update|delete)\s+.*question_inline/i.test(body), '挂载必须是只读，不得写 question_inline_figures')
  c.ok(!/placeholder|defaultFigure|fallbackFigure/.test(body), '出现占位图兜底')

  const ref = read(REF)
  c.ok(/export interface InlineFigure/.test(ref), 'ReferenceExample 缺 InlineFigure 类型')
  c.ok(/inlineFigures\?: InlineFigure\[\]/.test(ref), 'ReferenceExample 缺 inlineFigures 字段')
  c.ok(/kind: 'formula' \| 'figure'/.test(ref), 'InlineFigure.kind 取值不对')
})

m.test('🔴 B6 缓存 v14 且旧断言同步（结果结构变更必 bump）', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 未 bump 到 v14')
  for (const rel of VERSION_MODULES) {
    const t = read(rel)
    c.ok(/CACHE_VERSION = 'v14'/.test(t), `${path.basename(rel)} 未同步 v14 断言`)
    c.ok(!/CACHE_VERSION = 'v1[0-3]'/.test(t.split("CACHE_VERSION = 'v14'").join('')), `${path.basename(rel)} 还留着旧版本断言`)
  }
})

m.test('🔴 B7 前端：切段行内渲染 + 无图退化纯文本 + 可放大', (c) => {
  const ed = read(EDITOR)
  c.ok(/function stemHtml/.test(ed), '缺 stemHtml 切段函数')
  c.ok(/stemHtml\(r\.stem, r\.inlineFigures, stemLimit\)/.test(ed), '题干没有按 inlineFigures 切段')
  c.ok(/<RichText[^>]*nodes=\{stemNodes\}/.test(ed), '题干没有用 RichText 行内混排（`<text>` 内的 image 会被丢弃）')
  c.ok(/if \(list\.length === 0\) return escapeHtml/.test(ed), '没有图时未退化为纯文本')
  c.ok(/f\.charOffset <= cut/.test(ed), '收起态没有按可见长度裁剪图（会渲染到摘要之外）')
  c.ok(/Taro\.previewImage/.test(ed), '缺点击放大（previewImage）')
  c.ok(/inlineUrls/.test(ed), '缺放大入口的图列表')
  const api = read(API_TS)
  c.ok(/inlineFigures\?: InlineFigure\[\]/.test(api), 'api.ts 契约缺 inlineFigures')
})

m.test('🔴 B8 提案六栏 + 台账 D-021 + 保留形式（不宣称）', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-018/.test(p), '提案缺提案号')
  c.ok(/关联决策：D-021/.test(p), '提案缺关联决策 D-021')
  c.ok(/关联缺口：/.test(p), '提案缺关联缺口')
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥']) {
    c.ok(new RegExp(`^###\\s*${mark}`, 'm').test(p), `提案缺六栏 ${mark}`)
  }
  const d = read(DECISION)
  c.ok(/## D-021 /.test(d), '台账缺 D-021 条目')
  c.ok(/执行记录/.test(d.slice(d.indexOf('## D-021'))), 'D-021 缺执行记录回填位')
  for (const bad of ['每道题都带图', '图形全覆盖', '所有用户已可用']) {
    c.ok(!d.slice(d.indexOf('## D-021')).includes(`「${bad}」`), `台账出现宣称词「${bad}」`)
  }
})

m.test('🔴 B9 字体闸门：--apply 前必查 Symbol 别名（防公式静默缺符号）', (c) => {
  const t = codeJs(read(BUILDER))
  c.ok(/async function assertSymbolFont\(\)/.test(t), '缺字体闸门函数')
  c.ok(/exec\('fc-match', \['Symbol'\]/.test(t), '闸门没有查 fc-match Symbol')
  c.ok(/!\/symbol\/i\.test\(out\)/.test(t), '闸门没有判定「回退到普通字体」的结果')
  const fn = (t.split('async function assertSymbolFont()')[1] || '').split('async function main()')[0]
  c.ok(/throw new Error\(/.test(fn), '字体缺失时未拒绝执行（静默降质会混进题库）')
  const main = t.slice(t.indexOf('async function main()'))
  const gateAt = main.indexOf('await assertSymbolFont()')
  const runAt = main.indexOf('await applyRun(client)')
  c.ok(gateAt >= 0 && runAt > gateAt, '--apply 分支没有在 applyRun 之前过闸门')
  c.ok(/if \(!APPLY\)[\s\S]{0,200}return/.test(main), 'dry-run 不应被字体闸门阻断')
})

export default m
