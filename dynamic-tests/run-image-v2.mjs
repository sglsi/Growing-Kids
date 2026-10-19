#!/usr/bin/env node
/**
 * Phase 1 几何纠偏 · 动态测试
 *
 * 1) 算法验证：纯 JS 复现 image-dewarp.ts 的核心（orderCorners / solveHomography /
 *    warpRaw / targetSize / dewarpRaw），用合成参考图验证「几何变换数学正确 +
 *    内容 100% 保真」。不依赖 sharp，可在沙箱直接运行。
 * 2) 源码一致性：断言真实 TS 文件已落地 straighten / manual_corners / 路由 / 导出。
 *
 * 运行：node run-image-v2.mjs
 */
import fs from 'fs'

// ============ 复现 image-dewarp.ts 核心（纯 JS） ============
function orderCorners(pts) {
  const p = pts.map((x) => [...x])
  const s = p.map((q) => q[0] + q[1])
  const tl = p[s.indexOf(Math.min(...s))]
  const br = p[s.indexOf(Math.max(...s))]
  const diff = p.map((q) => q[1] - q[0])
  const tr = p[diff.indexOf(Math.min(...diff))]
  const bl = p[diff.indexOf(Math.max(...diff))]
  return [tl, tr, br, bl]
}
function gaussianSolve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col]
    if (Math.abs(d) < 1e-12) throw new Error('singular')
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}
function solveHomography(src, dst) {
  const A = [], b = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [X, Y] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y)
  }
  return gaussianSolve(A, b)
}
function warpRaw(src, w, h, ch, H, outW, outH, background = 255) {
  const out = Buffer.alloc(outW * outH * ch, background)
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H
  for (let Y = 0; Y < outH; Y++) {
    for (let X = 0; X < outW; X++) {
      const denom = h6 * X + h7 * Y + 1
      if (Math.abs(denom) < 1e-9) continue
      const x = (h0 * X + h1 * Y + h2) / denom
      const y = (h3 * X + h4 * Y + h5) / denom
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1)
      const fx = x - x0, fy = y - y0
      const i00 = (y0 * w + x0) * ch, i10 = (y0 * w + x1) * ch
      const i01 = (y1 * w + x0) * ch, i11 = (y1 * w + x1) * ch
      const o = (Y * outW + X) * ch
      for (let c = 0; c < ch; c++) {
        const v00 = src[i00 + c], v10 = src[i10 + c], v01 = src[i01 + c], v11 = src[i11 + c]
        const top = v00 * (1 - fx) + v10 * fx
        const bot = v01 * (1 - fx) + v11 * fx
        out[o + c] = Math.round(top * (1 - fy) + bot * fy)
      }
    }
  }
  return out
}
function targetSize(corners) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const W = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])))
  const H = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])))
  return [Math.max(W, 1), Math.max(H, 1)]
}
function dewarpRaw(raw, w, h, ch, cornersRaw) {
  if (!cornersRaw || cornersRaw.length !== 4) throw new Error('need 4 corners')
  const ordered = orderCorners(cornersRaw)
  const [W, Hh] = targetSize(ordered)
  const dst = [[0, 0], [W, 0], [W, Hh], [0, Hh]]
  const homo = solveHomography(ordered, dst)
  return { out: warpRaw(raw, w, h, ch, homo, W, Hh), W, H: Hh }
}
// ============ 合成参考图（白底 + 中央黑方块 + 四角黑点 + 横纹） ============
const W = 200, H = 160, ch = 4
function makeRef() {
  const buf = Buffer.alloc(W * H * ch, 255)
  const setPx = (x, y, v = 0) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const o = (y * W + x) * ch
    for (let c = 0; c < 3; c++) buf[o + c] = v
    buf[o + 3] = 255
  }
  for (let y = 50; y < 110; y++) for (let x = 70; x < 130; x++) setPx(x, y, 0) // 中央黑方块
  for (const [cx, cy] of [[5, 5], [W - 5, 5], [5, H - 5], [W - 5, H - 5]])
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) setPx(cx + dx, cy + dy, 0)
  for (let y = 20; y < 45; y += 8) for (let x = 10; x < W - 10; x++) setPx(x, y, 80) // 模拟文字行
  return buf
}
const ref = makeRef()
const gray = (buf, w, x, y) => { const o = (y * w + x) * ch; return (buf[o] + buf[o + 1] + buf[o + 2]) / 3 }
function darkBBox(buf, w, h, th = 30) {
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (gray(buf, w, x, y) < th) {
      if (x < minx) minx = x; if (x > maxx) maxx = x
      if (y < miny) miny = y; if (y > maxy) maxy = y
    }
  }
  return minx > maxx ? null : { minx, miny, maxx, maxy, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 }
}

// ============ 断言 ============
let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { pass++; console.log('  PASS ', msg) }
  else { fail++; console.log('  FAIL ', msg) }
}

console.log('\n[1] 身份映射：corners=图像四角 → dewarp 应 100% 保真')
{
  const { out } = dewarpRaw(ref, W, H, ch, [[0, 0], [W, 0], [W, H], [0, H]])
  let identical = true
  for (let i = 0; i < ref.length; i++) if (ref[i] !== out[i]) { identical = false; break }
  assert(identical, '身份透视变换逐像素一致（无损）')
}

console.log('\n[2] 四角排序：乱序输入 → 应为 [tl, tr, br, bl]')
{
  const ord = orderCorners([[W, H], [0, 0], [W, 0], [0, H]])
  const exp = JSON.stringify([[0, 0], [W, 0], [W, H], [0, H]])
  assert(JSON.stringify(ord) === exp, `排序正确：实际 ${JSON.stringify(ord)}`)
}

console.log('\n[3] 单应求解：src→dst 映射误差应≈0')
{
  const src = [[0, 0], [W, 0], [W, H], [0, H]]
  const dst = [[5, 8], [W - 3, 10], [W - 9, H - 6], [8, H - 4]]
  const Hh = solveHomography(src, dst)
  const mapPt = (p) => {
    const [X, Y] = p
    const d = Hh[6] * X + Hh[7] * Y + 1
    return [(Hh[0] * X + Hh[1] * Y + Hh[2]) / d, (Hh[3] * X + Hh[4] * Y + Hh[5]) / d]
  }
  let maxErr = 0
  for (let i = 0; i < 4; i++) maxErr = Math.max(maxErr, Math.hypot(mapPt(src[i])[0] - dst[i][0], mapPt(src[i])[1] - dst[i][1]))
  assert(maxErr < 1e-6, `单应映射最大误差 ${maxErr.toExponential(2)} < 1e-6`)
}

console.log('\n[4] 单变换压平：梯形四角 → 压平为正面矩形，近角内容映射到输出对应角')
{
  // 模拟一张「斜拍试卷」：D 是 Wd×Hd 图，文档在 D 内呈梯形四角
  const Wd = 210, Hd = 170, ch = 4
  const Dcorners = [[20, 30], [190, 18], [180, 150], [15, 160]] // 已为 [tl,tr,br,bl]
  const D = Buffer.alloc(Wd * Hd * ch, 255)
  const setD = (x, y, v = 0) => {
    if (x < 0 || y < 0 || x >= Wd || y >= Hd) return
    const o = (y * Wd + x) * ch; for (let c = 0; c < 3; c++) D[o + c] = v; D[o + 3] = 255
  }
  // 在「文档左上角」(Dcorners[0]=[20,30]) 内侧画黑方块 → 透视下应映射到输出左上区域
  for (let y = 35; y < 62; y++) for (let x = 28; x < 55; x++) setD(x, y, 0)
  const { out: Rp, W: Wo, H: Ho } = dewarpRaw(D, Wd, Hd, ch, Dcorners)
  const [tW, tH] = targetSize(Dcorners)
  assert(Wo === tW && Ho === tH, `输出尺寸 ${Wo}x${Ho} == 目标矩形 ${tW}x${tH}`)
  const bb = darkBBox(Rp, Wo, Ho)
  assert(bb !== null, 'Rp 含内容(黑块)')
  assert(bb.minx >= 0 && bb.maxx < Wo && bb.miny >= 0 && bb.maxy < Ho, '内容 bbox 完全在输出图内（未裁剪/丢失）')
  assert(bb.cx < Wo * 0.6 && bb.cy < Ho * 0.6, `内容位于输出图左上区域（对应文档左上角，透视压平正确；centroid=(${bb.cx.toFixed(0)},${bb.cy.toFixed(0)})）`)
}

console.log('\n[5] 乱序四角不变性：scrambled 四角 → orderCorners 归一化后仍正确压平')
{
  const Wd = 210, Hd = 170, ch = 4
  const Dc = [[20, 30], [190, 18], [180, 150], [15, 160]]
  const D = Buffer.alloc(Wd * Hd * ch, 255)
  const setD = (x, y, v = 0) => {
    if (x < 0 || y < 0 || x >= Wd || y >= Hd) return
    const o = (y * Wd + x) * ch; for (let c = 0; c < 3; c++) D[o + c] = v; D[o + 3] = 255
  }
  for (let y = 35; y < 62; y++) for (let x = 28; x < 55; x++) setD(x, y, 0)
  const scrambled = [Dc[2], Dc[0], Dc[3], Dc[1]]
  const { out: Rp, W: Wo, H: Ho } = dewarpRaw(D, Wd, Hd, ch, scrambled)
  const bb = darkBBox(Rp, Wo, Ho)
  assert(bb !== null && bb.cx < Wo * 0.6 && bb.cy < Ho * 0.6, `乱序四角压平后内容仍落在输出左上区（orderCorners 生效；centroid=(${bb ? bb.cx.toFixed(0) : '?'},${bb ? bb.cy.toFixed(0) : '?'}）`)
}

// ============ 源码一致性 ============
console.log('\n[6] 源码一致性：真实 TS 文件已落地 Phase 1 改动')
const base = '/workspace/projects/server/src/image/'
const svc = fs.readFileSync(base + 'image.service.ts', 'utf8')
const typ = fs.readFileSync(base + 'image.types.ts', 'utf8')
const ctl = fs.readFileSync(base + 'image.controller.ts', 'utf8')
const dew = fs.readFileSync(base + 'image-dewarp.ts', 'utf8')
assert(svc.includes('async straighten('), 'image.service.ts 含 straighten()')
assert(svc.includes('straightenImage'), 'image.service.ts 调用 straightenImage')
assert(typ.includes('manual_corners'), 'image.types.ts 含 manual_corners')
assert(ctl.includes('IMG_PIPELINE_MODE'), 'image.controller.ts 含 IMG_PIPELINE_MODE 灰度开关')
assert(ctl.includes('straighten('), 'image.controller.ts 把 auto 路由到 straighten()')
assert(dew.includes('export async function dewarpBuffer'), 'image-dewarp.ts 导出 dewarpBuffer')
assert(dew.includes('export async function straightenImage'), 'image-dewarp.ts 导出 straightenImage')
assert(dew.includes('export function orderCorners'), 'image-dewarp.ts 导出 orderCorners')
assert(dew.includes('detectDocumentCorners'), 'image-dewarp.ts 含 detectDocumentCorners(自动检测占位)')
const pkg = fs.readFileSync('/workspace/projects/server/package.json', 'utf8')
assert(pkg.includes('"sharp"'), 'package.json 补列 sharp 依赖')

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail === 0 ? 0 : 1)
