// 模块 39：参考例题「原题快照」（P-017 / D-020）
//
// 为什么单独一个模块：M37 守「参考例题是并列第二层」，但没有任何模块守
// 「**图形和公式必须跟着题目一起给出来**」。2026-11-08 思傅报障：
// 「特别是数学，有很多图形的题目，现在查到的相同类型题目只有文字，没有图形」。
// 取证发现两级缺失：
//   ① `question_objects` 没有任何图片字段，`pdf_tool.py` 的 text_only 明确不保留图；
//   ② docx 里公式是 OLE 对象（WMF 位图），纯文本抽取把公式也一起吞了
//      ⇒ 库内数学解析实际是「抛物线中，当时，；当时，或3」这种残缺串。
//
// 🔴 本模块守的核心契约：**图是转换后的近似呈现、缺失就如实缺失（绝不拿相邻题顶替）、
//    只读挂载不影响判定与召回、图不得插到事先声明之前**。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M39', '参考例题原题快照验收集（P-017 / D-020）')
const ROOT = path.resolve(process.cwd(), '..')

const MATCH = 'server/src/shared/question-match.ts'
const REF = 'server/src/shared/question-reference.ts'
const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const API_TS = 'src/services/api.ts'
const MIGRATION = 'migrations/0028_question_figures.sql'
const BUILDER = 'server/scripts/netdisk-figure-build.mjs'
const CROPPER = 'server/scripts/netdisk-figure-crop.py'
const PUBLIC_ROUTES = 'server/src/shared/user-context.ts'
const PROPOSAL = 'docs/design/method/proposals/P-017-参考例题原题快照.md'
const DECISION = 'docs/design/method/decision-log.md'

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
]

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 去掉注释后的代码正文。
 *
 * 为什么必须先剥注释：本模块多条断言是「不得出现 X」的负向检查，而**说明性注释里
 * 恰恰要写「绝不构造占位图」「绝不改题目对象表」**。2026-11-08 首次跑 M39 就被
 * 自己的注释打成 FAIL（A2/A5）——负向断言必须只看真正会执行的代码，
 * 否则越老实的注释越容易被判违规（同 M38「注释被当实现」的坑）。
 */
function codeOnly(src, hashComment) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim()
      if (hashComment && t.startsWith('--')) return false
      return !t.startsWith('//')
    })
    .join('\n')
}

m.test('🔴 A1 判定层真相源一行未动（与 M35–M38 同基线）', (c) => {
  const src = read(MATCH).replace(/\r\n/g, '\n')
  c.eq(
    crypto.createHash('sha256').update(src, 'utf8').digest('hex'),
    '84f998ff9d2bb2f5e2d3cec70b7ea309deef8ee69bfb558a4b8180939258ed10',
    'question-match.ts 被改动 —— 走提案单，不要顺手改判定层',
  )
  c.ok(!/question_figures|figureUrl/.test(src), '快照逻辑被塞进判定层真相源')
})

m.test('🔴 A2 迁移 0028：表 / 唯一键 / 版本列齐全', (c) => {
  const sql = read(MIGRATION)
  c.ok(/create table if not exists question_figures/i.test(sql), '缺 question_figures 建表')
  for (const col of [
    'user_id', 'source_type', 'source_id', 'object_index', 'page_index',
    'storage_key', 'width', 'height', 'size_bytes', 'source_revision', 'engine_version',
  ]) {
    c.ok(new RegExp(`\\b${col}\\b`).test(sql), `缺列 ${col}`)
  }
  c.ok(
    /unique index[\s\S]{0,120}question_figures \(user_id, source_type, source_id, object_index\)/i.test(sql),
    '缺「一道题最多一张快照」的唯一键（重跑必须幂等）',
  )
  c.ok(/source_revision/.test(sql) && !/alter table|drop table|truncate/i.test(codeOnly(sql, true)),
    '迁移不得改动其它表（只写本表）')
  c.ok(!/(?<!create table if not exists )\bquestion_objects\b[\s\S]{0,40}\b(set|update)\b/i.test(codeOnly(sql, true)),
    '迁移不得写题目对象表')
})

m.test('🔴 A3 构建脚本只写本表，绝不改题目对象与正文', (c) => {
  const b = read(BUILDER)
  c.ok(/insert into question_figures/.test(b), '缺入库语句')
  c.ok(/on conflict \(user_id, source_type, source_id, object_index\) do update/.test(b), '不是幂等 upsert')
  c.ok(!/update question_objects/i.test(b), '构建脚本不得改 question_objects')
  c.ok(!/update netdisk_files/i.test(b), '构建脚本不得改 netdisk_files')
  c.ok(/figures\/%s\/%s\.webp/.test(read(CROPPER)), '图片未走内容寻址 key（figures/<2>/<sha>.webp）')
})

m.test('🔴 A4 文本过短的对象直接跳过，绝不拿相邻题顶替', (c) => {
  const py = read(CROPPER)
  c.ok(/ANCHOR_MIN = 10/.test(py), '缺最短锚点阈值')
  c.ok(/if len\(stem\) < ANCHOR_MIN:[\s\S]{0,40}return None/.test(py), '短题干没有返回 None（有顶替风险）')
  c.ok(/skippedShort/.test(py), '短题干跳过没有计数留痕')
  c.ok(!/return .*neighbor|fallback_stem/.test(py), '出现「用相邻题兜底」的写法')
})

m.test('🔴 A5 后端只读挂载：缺失即没有图，不构造占位', (c) => {
  const nd = read(SERVICE_ND)
  c.ok(/private async attachFigures/.test(nd), '缺 attachFigures 挂载点')
  c.ok(/from\('question_figures'\)/.test(nd), '没有查 question_figures')
  c.ok(/\.eq\('user_id', publicLibraryOwner\(\)\)/.test(nd), '公共库取图必须用 publicLibraryOwner()')
  c.ok(/if \(!key\) continue/.test(nd), '缺少图时必须跳过（不得填默认图）')
  c.ok(!/placeholder|defaultFigure|fallbackFigure|占位图/.test(codeOnly(nd)), '出现占位图兜底')
  const ref = read(REF)
  c.ok(/export function figureUrlFor/.test(ref), '缺 figureUrlFor')
  c.ok(/\/api\/storage\/files\//.test(ref), '图片 URL 没走公开读路由')
  c.ok(/figureUrl\?: string/.test(ref), 'ReferenceExample 缺 figureUrl 字段')
})

m.test('🔴 A6 缓存 v14 且旧断言同步（结构变更必 bump）', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v14'/.test(as), 'CACHE_VERSION 未 bump 到 v14')
  for (const rel of VERSION_MODULES) {
    const t = read(rel)
    c.ok(/CACHE_VERSION = 'v14'/.test(t), `${path.basename(rel)} 未同步 v14 断言`)
    c.ok(!/CACHE_VERSION = 'v1[23]'/.test(t.replace(/CACHE_VERSION = 'v14'/g, '')), `${path.basename(rel)} 还留着旧版本断言`)
  }
})

m.test('🔴 A7 前端只在有图时渲染，且可放大', (c) => {
  const ed = read(EDITOR)
  c.ok(/\{r\.figureUrl \? \(/.test(ed), '前端没有按 figureUrl 条件渲染')
  c.ok(/Taro\.previewImage/.test(ed), '缺点击放大（previewImage）')
  c.ok(/原样截取（含图形与公式）/.test(ed), '缺「原样截取」的如实说明')
  c.ok(!/figureUrl \|\| /.test(ed), '出现无图时的替代图兜底')
  c.ok(/figureUrl\?: string/.test(read(API_TS)), '前端类型缺 figureUrl（契约会断）')
})

m.test('🔴 A8 事先声明仍排在参考内容之前', (c) => {
  const ed = read(EDITOR)
  const iDecl = ed.indexOf('candidate?.reference_disclaimer || REFERENCE_DISCLAIMER')
  const iFig = ed.indexOf('{r.figureUrl ? (')
  c.ok(iDecl > 0, '事先声明缺失')
  c.ok(iFig > 0, '参考例题图缺失')
  c.ok(iDecl < iFig, '图被插到了事先声明之前（违反 D-018）')
})

m.test('🔴 A9 图片走既有公开读路由，不新开需登录端点', (c) => {
  const t = read(PUBLIC_ROUTES)
  c.ok(/\/api\/storage\/files\//.test(t), '公开读路由被改动（小程序 <Image> 不发头部）')
  c.ok(!/question-figures/.test(read('server/src/storage/storage.controller.ts')), '不要新开专用读端点')
})

m.test('🔴 A10 文档：六栏 + 台账 + 不宣称词', (c) => {
  const p = read(PROPOSAL)
  c.ok(/提案号：P-017/.test(p), 'P-017 缺提案号')
  c.ok(/状态：(已批准|已实施)/.test(p), 'P-017 状态必须是 已批准/已实施')
  c.ok(/关联决策：D-020/.test(p), 'P-017 缺关联决策 D-020')
  for (const mark of ['①', '②', '③', '④', '⑤', '⑥']) {
    c.ok(new RegExp(`^###\\s*${mark}`, 'm').test(p), `P-017 缺六栏 ${mark}`)
  }
  c.ok(/D-020/.test(read(DECISION)), '台账缺 D-020')
  // 不宣称：不得把「有图」说成「看懂了题」，也不得承诺全覆盖
  for (const bad of ['所有题都有图', '全部覆盖图形', '看懂图形', '精准定位到题']) {
    c.ok(!p.includes(bad), `P-017 出现越线宣称「${bad}」`)
  }
})

export default m
