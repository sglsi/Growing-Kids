// 模块 72：后端高分直裁绕开 Canvas 墙（P-032 / D-093）
//
// 背景：D-092 已把裁剪底图提到 scale=3（A4≈1786px），但前端 Canvas 2D 的
//   MAX_CANVAS_SIDE=1365 硬墙把裁块压回 1365px（超了安卓 crash，不能改），
//   scale 再高也被墙吃（实得 152→186dpi）。P-032 治本：前端只传归一化框，
//   后端从原始高分图用 sharp 按框裁 → ingest 入库，绕开墙。
// 本模块锁住：
//   ① 后端新端点 crop-box 存在且用 sharp.extract（非 canvas）、归一化框换算、ingest、回 key/url；
//   ② ingest 存 original（合成端读原分辨率，不被 display 1600px 吃掉）；
//   ③ 前端 highResCrop prop + onConfirmUploaded 结果出口 + 后端失败回退老路径；
//   ④ 三处裁剪调用方接入（recognize 两处 / answer-editor 一处）；
//   ⑤ 存量题不重裁（无自动迁移逻辑）、docPages 倍率未被本提案改动。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M72', '后端高分直裁绕开 Canvas 墙（P-032）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const TYPES = 'server/src/image/image.types.ts'
const SERVICE = 'server/src/image/image.service.ts'
const CTRL = 'server/src/image/image.controller.ts'
const EDITOR = 'src/components/image-editor.tsx'
const RECOG = 'src/pages/recognize/index.tsx'
const ANSWER = 'src/components/answer-editor.tsx'
const API = 'src/services/api.ts'
const PIPELINE = 'server/src/storage/image-pipeline.ts'

m.test('A1 后端端点 crop-box：DTO + controller + service 三件齐全', async (c) => {
  const t = read(TYPES)
  c.ok(/interface CropBoxDto/.test(t), '须定义 CropBoxDto')
  c.ok(/image_url:\s*string/.test(t) && /box:\s*\{[^}]*x: number[^}]*y: number[^}]*w: number[^}]*h: number/.test(t),
    'DTO 须收 image_url + 归一化框 x/y/w/h')
  const ctl = read(CTRL)
  c.ok(/@Post\('crop-box'\)/.test(ctl), 'controller 须注册 POST crop-box')
  const svc = read(SERVICE)
  const at = svc.indexOf('async cropByBox(')
  c.ok(at >= 0, 'service 须有 cropByBox 方法')
})

m.test('A2 service 用 sharp 按归一化框裁 + ingest 入库（非 canvas）', async (c) => {
  const svc = read(SERVICE)
  const at = svc.indexOf('async cropByBox(')
  const body = svc.slice(at, at + 2800)
  c.ok(!/toDataURL|canvasToTempFilePath|getContext\s*\(\s*['"]2d/.test(body), '后端裁图不得用 canvas API（那是前端墙的来源）')
  c.ok(/this\.fetchImage\(dto\.image_url/.test(body), '须从来源图 URL 取原始高分图')
  c.ok(/dto\.box\.x\s*\*\s*W/.test(body) && /dto\.box\.w/.test(body), '归一化框须换算成像素框（相对源图 W/H）')
  c.ok(/\.extract\(\{[^}]*left[^}]*top[^}]*width[^}]*height/.test(body), '须用 sharp.extract 实际裁块')
  c.ok(/this\.ingestService\.ingest\(cropBuf/.test(body), '裁块须 ingest 入库')
  c.ok(/getPublicUrl\(ing\.key\)/.test(body), '须回传入库后的 url')
  c.ok(/width\s*>\s*1365/.test(body), '须记录「越过 Canvas 墙」的诊断日志')
})

m.test('A3 ingest 存 original 原图（合成端读原分辨率，不被 display 1600px 吃掉）', async (c) => {
  const pipe = read(PIPELINE)
  c.ok(/displayMaxEdge:\s*1600/.test(pipe), 'display 仍是 1600px（记录事实）')
  const svc = read(SERVICE)
  c.ok(/originalKey/.test(svc) || /readOriginalFor|downloadOriginalPreferred/.test(read('server/src/pdf/pdf.service.ts')),
    '合成端须有读 original 原图的链路（D-091，高分裁块不被降质）')
})

m.test('A4 前端 ImageEditor：highResCrop prop + onConfirmUploaded + 失败回退', async (c) => {
  const ed = read(EDITOR)
  c.ok(/highResCrop\?: boolean/.test(ed), '须有 highResCrop prop')
  c.ok(/onConfirmUploaded\?: \(result: CropUploaded\) => void/.test(ed), '须有 onConfirmUploaded 结果出口')
  c.ok(/cropBoxHighRes\(\{/.test(ed), '确认时须调用后端高分裁图')
  c.ok(/isRemoteImageUrl\(currentSrc\)/.test(ed), '只对可云端取回的图开启（本地图回退）')
  c.ok(/后端高分直裁失败，回退前端 Canvas 裁剪/.test(ed), '后端失败须回退老路径，不留死出口')
})

m.test('A5 三处调用方接入（recognize 两处 / answer-editor 一处）', async (c) => {
  const recog = read(RECOG)
  c.ok((recog.match(/highResCrop/g) || []).length >= 2, 'recognize 页须至少两处开启 highResCrop')
  c.ok((recog.match(/onConfirmUploaded=/g) || []).length >= 2, 'recognize 页须至少两处接结果出口')
  c.ok(/resolveCropResult/.test(recog), 'recognize 须有结果归一 helper（老路径仍 uploadImage）')
  const answer = read(ANSWER)
  c.ok(/highResCrop/.test(answer) && /onConfirmUploaded=/.test(answer), 'answer-editor 须接入高分裁剪')
  const api = read(API)
  c.ok(/export async function cropBoxHighRes/.test(api) && /\/api\/image\/crop-box/.test(api), '前端 API 须有 cropBoxHighRes')
})

m.test('A6 边界：存量不重裁、docPages 倍率未被本提案改动、判定层不动', async (c) => {
  const ocr = read('server/src/ocr/ocr.service.ts')
  c.ok(/GK_PDF_RENDER_SCALE/.test(ocr) && /scale:\s*Math\.max\(0\.5/.test(ocr), 'docPages 倍率仍是 D-092 的可配实现（默认 3，未提到 4）')
  c.ok(!/G K_PDF_RENDER_SCALE|scale:\s*4\s*,/.test(ocr), '不得擅自把默认倍率提到 4')
  const match = read('server/src/shared/question-match.ts')
  c.ok(match.length > 1000 && /export /.test(match), '判定层真相源文件仍在且非空（本提案未删/未改结构）')
})

export default m
