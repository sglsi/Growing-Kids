// 模块 63：资料库裁剪——上下可调 / 裁剪图能看 / 连裁不残留（D-084）
//
// 🔴 静态契约。真机手感（上下边抓不抓得到、附件点开能否预览）由思傅验收。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M63', '资料库裁剪框上下可调 / 答案附件可见 / 连裁重置（D-084）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const EDITOR = 'src/components/image-editor.tsx'
const ANS = 'src/components/answer-editor.tsx'
const TYPES = 'src/types/index.ts'

m.test('A1 竖长页图按真实预览区高度缩放，尺寸变化后重测触摸层', (c) => {
  const s = read(EDITOR)
  c.ok(/id="imgEditorPreview"/.test(s), '预览区须有 id 供测量')
  c.ok(/\.select\('#imgEditorPreview'\)/.test(s), '必须按真实预览容器高度算 imgH')
  c.ok(
    /layerMeasuredRef\.current = false[\s\S]{0,220}setTimeout\(\(\) => \{ measureLayer\(\); measureBox\(\) \}, 60\)/.test(s),
    '图片尺寸变化后触摸层缓存须作废并重测（旧缓存会让 ry 整体偏移）',
  )
  c.ok(!/const availH = sys\.windowHeight - 260/.test(s), '不许再用拍脑袋的 windowHeight-260 估高度')
})

m.test('A2 裁剪手柄按最近距离命中，命中半径随短边收缩', (c) => {
  const s = read(EDITOR)
  c.ok(
    /const hit = Math\.max\(10, Math\.min\(HANDLE_HIT, imgW \/ 6, imgH \/ 6\)\)/.test(s),
    '半径须随短边收缩，防矮图上/下边互相抢占手势',
  )
  c.ok(/cand\.sort\(\(a, b\) => a\.d - b\.d\)/.test(s), '须按距离选最近手柄，不能靠 if-else 顺序')
  c.ok(/if \(best && best\.d <= hit\) return best\.key/.test(s), '选中手柄后须直接返回')
  c.ok(!/const near = \(v: number, edge: number\) => Math\.abs\(v - edge\) <= HANDLE_HIT/.test(s),
    '不许恢复固定 32px 的旧命中判定')
})

m.test('A3 新裁剪的答案附件当前会话即可见可点开', (c) => {
  const a = read(ANS)
  c.ok(/url: up\.url,[\s\S]{0,80}thumb_url: up\.thumb_url,/.test(a), '裁剪上传结果须带上签名 URL')
  c.ok(/url: \(doc\.mime_type \|\| ''\)\.startsWith\('image\/'\) \? doc\.url : undefined/.test(a),
    '资料库里整份加入的图片也要带 URL（文档仍显示文件名）')
  const t = read(TYPES)
  const start = t.indexOf('export interface AnswerAttachment')
  const block = t.slice(start, start + 700)
  c.ok(/url\?: string/.test(block) && /thumb_url\?: string/.test(block), '附件类型须声明两个可选 URL')
  c.ok(/const src = shown\.thumb_url \|\| shown\.url/.test(a), '渲染入口仍须取 thumb_url || url')
  c.ok(/Taro\.previewImage\(\{ urls: \[src\], current: src \}\)/.test(a), '图片附件仍须可点开预览')
})

m.test('A4 连续裁剪同一张图也重置编辑器状态', (c) => {
  const a = read(ANS)
  c.ok(/const cropSeqRef = useRef\(0\)/.test(a), '须有裁剪会话计数器')
  c.ok(/cropSeqRef\.current \+= 1/.test(a), '每次打开裁剪器都换 key')
  c.ok(/cropKey=\{String\(cropSeqRef\.current\)\}/.test(a), 'key 须传给 ImageEditor 触发重置 effect')
  c.ok(!/setCropSrc\(url\)/.test(a) && !/setCropSrc\(p\.url\)/.test(a), '打开入口不许绕过 openCrop')
})

export default m
