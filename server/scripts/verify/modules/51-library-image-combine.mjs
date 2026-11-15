// 模块 51：资料库「多图导入 → 一份 PDF」（D-063）
//
// 背景：资料库原本只能一次导一份文件。思傅 2026-11-15 要求「多份图片导入 →
// 自动排序 → 手动改序 → 合成一份文件存储」，并改判成品版式为**一图一页**
// （首选智能拼页会让排序结果看不出来）。
//
// 本模块只守静态契约，最容易被后续迭代悄悄盖掉的五件事：
//  ① 一图一页，不能退回 Guillotine-BSSF 智能拼页；
//  ② keys 数组顺序 == PDF 页序，不能 sort / 并行丢序；
//  ③ 只归档一份成品，原图不单独建条目（临时图走 purpose=temp）；
//  ④ 自动排序（选择顺序 + 数字序兜底）与手动上移/下移/删除都在；
//  ⑤ 上限与 key 白名单在（同步合成受微信 60s 硬顶约束）。
//
// 🔴 不连数据库、不连微信、不碰判定层；「顺序真的生效」由
//    dynamic-tests/run-library-combine-d063.cjs 用编译产物离线实证。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M51', '资料库多图合成：一图一页 / 保序 / 只存成品（D-063）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const ONE = 'server/src/pdf/one-image-per-page.ts'
const NORM = 'server/src/pdf/image-normalize.ts'
const SVC = 'server/src/library/library-image-combine.service.ts'
const CTRL = 'server/src/library/library.controller.ts'
const MOD = 'server/src/library/library.module.ts'
const PDF = 'server/src/pdf/pdf.service.ts'
const FE = 'src/pages/library/index.tsx'
const API = 'src/services/api.ts'
const E2E = 'dynamic-tests/run-library-combine-d063.cjs'

m.test('A1 一图一页：循环内逐图 addPage，不引入智能拼页', (c) => {
  c.ok(exists(ONE), 'one-image-per-page.ts 缺失')
  const s = read(ONE)
  c.ok(s.includes('for (const s of images)'), '必须逐图遍历')
  c.ok(s.includes('pdf.addPage('), '循环内必须 addPage')
  c.ok(!s.includes('packPages'), '⛔ 不得引入 Guillotine-BSSF 智能拼页')
  c.ok(s.includes('A4_PT') && s.includes('PAGE_MARGIN'), '必须共用 A4 版面常量')
  c.ok(s.includes('一图一页'), '必须写明版式口径，防后续被改回省纸拼版')
})

m.test('A2 顺序由 keys 数组唯一决定', (c) => {
  const s = read(SVC)
  c.ok(/for \(let i = 0; i < keys\.length; i\+\+\)/.test(s), '必须按下标顺序逐张读取')
  c.ok(!/\.sort\(/.test(s), '⛔ 服务端不得对图片重排序（会覆盖用户调序成果）')
  c.ok(!s.includes('Promise.all'), '⛔ 不得并行拉取后丢序')
  c.ok(s.includes('images.push(norm)'), '读到的图必须按序 push')
  c.ok(s.includes('buildOneImagePerPagePdf(images)'), '必须调用一图一页构造器')
})

m.test('A3 只归档一份成品，原图不单独建条目', (c) => {
  const s = read(SVC)
  c.ok(s.includes('this.library.create(userId,'), '必须归档到 library_docs')
  c.ok(!s.includes('timelineService.create'), '⛔ 不得往收件箱建原图条目')
  c.ok(!s.includes('documentsService.create'), '⛔ 不得归档到 documents 文档页')
  c.ok(s.includes("source: 'image-combine'"), '成品须带可追溯来源')
  c.ok(s.includes('purpose=temp'), '须写明临时图由孤儿 GC 回收（不留垃圾）')
})

m.test('A4 前端临时上传 + 合成端点接线', (c) => {
  const fe = read(FE)
  const api = read(API)
  c.ok(fe.includes("{ purpose: 'temp' }"), '原图上传必须 purpose=temp（不建条目、不占引用计数）')
  c.ok(fe.includes('combineLibraryImages(keys,'), '必须按当前列表顺序提交 keys')
  c.ok(api.includes("'/api/library/combine-images'"), '合成端点封装缺失')
  c.ok(api.includes('invalidateAfter('), '合成后必须失效 lib 缓存域，否则列表不刷新')
  c.ok(fe.includes('load({ silent: true })'), '成功后须静默刷新列表')
})

m.test('A5 自动排序 + 手动调序 + 序号可见', (c) => {
  const s = read(FE)
  c.ok(s.includes('Taro.chooseMedia'), '必须支持一次选多张')
  c.ok(s.includes('naturalCompare'), '须有自然数字序（1、2、10）')
  c.ok(s.includes('autoSortPicked'), '须有自动排序入口')
  c.ok(s.includes('选择顺序'), '须写明「以选择顺序为主」的口径')
  c.ok(s.includes('moveCompose') && s.includes('removeCompose'), '须有上移/下移/删除')
  c.ok(s.includes('第 {idx + 1} 页'), '列表必须显示页序，用户能核对排序结果')
  c.ok(s.includes('多张图片合成一份 PDF'), '导入菜单必须保留新入口')
  c.ok(s.includes('handleChooseImages(true)'), '须支持分批追加照片')
})

m.test('A6 上限、key 白名单与端点注册', (c) => {
  const s = read(SVC)
  const ctrl = read(CTRL)
  const mod = read(MOD)
  c.ok(/MAX_COMBINE_IMAGES = 20/.test(s), '同步合成的张数上限不能去掉（微信 60s 硬顶）')
  c.ok(s.includes('OBJECT_KEY_RE') && s.includes("k.includes('..')"), '必须校验对象 key 防路径逃逸')
  c.ok(ctrl.includes("'combine-images'"), 'controller 未注册合成端点')
  c.ok(mod.includes('LibraryImageCombineService'), 'module 未注册合成服务')
  c.ok(!mod.includes('PdfModule'), '⛔ 不得引 PdfModule（会与 PdfModule 形成循环依赖风险）')
})

m.test('A7 复用归一能力，没有复制第二份', (c) => {
  const p = read(PDF)
  const n = read(NORM)
  c.ok(p.includes('normalizeImageSource'), '复习本合成须改用共用归一单元')
  c.ok(!p.includes('function readImageSize'), '⛔ pdf.service.ts 不得再留一份头部解析')
  c.ok(n.includes('export async function normalizeImageSource'), '共用归一单元须导出')
  c.ok(p.includes("from './one-image-per-page'"), 'A4 版面常量须共用')
})

m.test('A8 离线实证脚本存在且覆盖页序与格式归一', (c) => {
  c.ok(exists(E2E), 'run-library-combine-d063.cjs 缺失')
  const s = read(E2E)
  for (const kw of ['页序', '一图一页', 'WebP', 'reverse', 'fail-closed', '服务层', 'library_docs']) {
    c.ok(s.includes(kw), `实证脚本缺少 ${kw} 用例`)
  }
})

export default m
