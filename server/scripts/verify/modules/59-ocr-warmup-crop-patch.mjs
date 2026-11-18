// 模块 59：OCR 侧车统一唤起 / 跨栏跨页补裁图 / 裁剪卡死（D-079）
//
// 🔴 守静态契约：这三类修复的关键结构不被后续误改回去。
//    真机效果（冷启动后第一次识别是否成功、补块是否真的合成同一题、裁剪拖动是否顺畅）
//    必须由思傅真机验收，静态断言不构成「真机已过」证据。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M59', 'OCR 侧车唤起 / 跨栏跨页补裁图 / 裁剪卡死（D-079）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const SUP = 'server/src/ocr/sidecar.supervisor.ts'
const OCR_SVC = 'server/src/ocr/ocr.service.ts'
const IMG_SVC = 'server/src/image/image.service.ts'
const IMG_CTRL = 'server/src/image/image.controller.ts'
const API = 'src/services/api.ts'
const REC = 'src/pages/recognize/index.tsx'
const DETAIL = 'src/pages/detail/index.tsx'
const EDITOR = 'src/components/image-editor.tsx'

m.test('A1 后端：侧车启动不再「只信状态」，状态脱节会强制重建', (c) => {
  const s = read(SUP)
  c.ok(
    /if \(this\.isRunning\(\)\) \{\s*if \(await this\.isHealthy\(\)\) return/.test(s),
    'start() 认为在跑时也必须先探活（旧实现只 return，单元被后台停掉后永不重启）',
  )
  c.ok(/强制重建/.test(s), '状态与实际不符时须显式重建并留日志')
  c.ok(
    /this\.unitActive = false\s*\n\s*\} else \{/.test(s),
    '单元模式须置 unitActive=false 走完整 systemctl start 流程',
  )
  c.ok(/c\.kill\('SIGKILL'\)/.test(s), 'spawn 模式须先杀掉旧子进程（否则端口被占绑不上）')
})

m.test('A2 后端：预热端点链路贯通且永不抛错', (c) => {
  const ctrl = read(IMG_CTRL)
  c.ok(/@Post\('ocr-warmup'\)/.test(ctrl), '须提供 POST /api/image/ocr-warmup')
  c.ok(/warmupOcrSidecar\(\)/.test(ctrl), 'controller 须调用 imageService.warmupOcrSidecar()')
  c.ok(/@HttpCode\(200\)[\s\S]{0,120}ocrWarmup/.test(ctrl), '预热端点固定 200（失败也不该让前端看到错误码）')

  const svc = read(IMG_SVC)
  c.ok(
    /async warmupOcrSidecar\(\)[\s\S]{0,300}this\.ocrService\.warmupSidecar\(\)/.test(svc),
    'image.service 须透传 ocrService.warmupSidecar()',
  )

  const ocr = read(OCR_SVC)
  c.ok(
    /async warmupSidecar\([\s\S]{0,800}await sup\.ensureReady\(timeoutMs\)/.test(ocr),
    '预热须走 supervisor.ensureReady（/healthz 200 ≠ 模型就绪，必须烘到探针通过）',
  )
  c.ok(
    /async warmupSidecar\([\s\S]{0,1200}return \{ ready, disabled: false/.test(ocr),
    '预热须返回结构化状态且失败不抛（catch 后仍回报 ready=false）',
  )
})

m.test('A3 前端：所有 OCR 入口统一先烘热，冷启动不算进 60s 预算', (c) => {
  const api = read(API)
  c.ok(/export function warmupOcr\(/.test(api), 'api.ts 须有 warmupOcr()')
  c.ok(/export async function warmupQuiet\(/.test(api), 'api.ts 须有 warmupQuiet()（永不抛错）')
  c.ok(/OCR_WARM_TTL_MS/.test(api), '预热结果须有 TTL（否则侧车被回收后再不重新烘热）')
  c.ok(/ocrWarmPromise = null/.test(api), '预热失败须清缓存，允许下次重试')

  const rec = read(REC)
  c.ok(/void warmupOcr\(\)\.catch/.test(rec), '识别页进页面须后台预热（fire-and-forget，不挡用户）')
  const calls = (rec.match(/await warmupQuiet\(\)/g) || []).length
  c.ok(calls >= 4, `识别页各 OCR 入口都须先烘热（实际 ${calls} 处，至少 4 处）`)
  c.ok(
    /await warmupQuiet\(\)[\s\S]{0,120}await recognizePaper\(/.test(rec),
    '「识别文字」入口须先烘热（这条就是用户报「直接识别失败」的路径）',
  )
  c.ok(
    /await warmupQuiet\(\)[\s\S]{0,160}await recropWrongBlock\(/.test(rec),
    '改框重切也跑 OCR，须先烘热',
  )

  const dt = read(DETAIL)
  c.ok(
    /await warmupQuiet\(\)[\s\S]{0,120}await ocrPage\(/.test(dt),
    '详情页「识别文字」须先烘热',
  )
})

m.test('A4 跨栏 / 跨页：补裁图真的进 question_images', (c) => {
  const s = read(REC)
  c.ok(/extra\?: \{ key: string; url: string \}\[\]/.test(s), 'SeqRow 须有 extra（补充裁剪块）')
  c.ok(
    /task\.kind === 'extra'[\s\S]{0,400}extra: \[\.\.\.cur, \{ key: up\.key, url: up\.url \}\]/.test(s),
    '补块须真的追加进 extra（不能只弹 toast）',
  )
  c.ok(
    /images: r\.stem \? \[r\.stem, \.\.\.\(r\.extra \|\| \[\]\)\]/.test(s),
    '入库时主裁图与补块须一起进 content.question_images',
  )
  c.ok(/＋补一块/.test(s), '题目行须有「＋补一块」入口')
  c.ok(/kind === 'extra' \? '补充块（跨栏\/跨页）'/.test(s), '补块裁剪器须有明确目标提示')
  c.ok(
    /cur\.length >= MAX_ENTRY_IMAGES - 1/.test(s),
    '补块须与主图合计受上限约束（防无限追加）',
  )
})

m.test('A5 裁剪卡死：手势同步起手 + 帧节流 + 强制退出通道', (c) => {
  const s = read(EDITOR)
  c.ok(/const begin = \(\) => \{[\s\S]{0,900}\}\s*begin\(\)/.test(s), '手势须同步起手，不能只在测量回调里设 dragRef')
  c.ok(/layerMeasuredRef/.test(s), '触摸层矩形须缓存，避免每次 touchstart 都发 SelectorQuery')
  c.ok(/lastMoveTsRef/.test(s), '拖动帧须节流，防高频 setState 压死渲染层')
  c.ok(
    /const handleForceExit = \(\) => \{[\s\S]{0,500}hideLoadingSafe\(\)[\s\S]{0,500}onCancel\(\)/.test(s),
    '须有强制退出通道：先收 loading 与忙态再关闭（busy 卡住时也能出来）',
  )
  c.ok(/onClick=\{handleForceExit\}/.test(s), '顶部「退出」须绑定强制退出')
  c.ok(
    /title: '裁剪中…', mask: false/.test(s),
    '裁剪导出须有可见反馈且 mask:false（不能挡住退出按钮）',
  )
})

export default m
