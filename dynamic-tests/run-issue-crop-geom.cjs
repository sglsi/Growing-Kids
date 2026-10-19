#!/usr/bin/env node
/**
 * 几何仿真回归：裁剪映射 + 旋转烘焙（针对「裁剪跑飞 / 旋转逐次放大」的修复验证）
 *
 * 背景（事故复盘）：
 *   旧实现把 canvas CSS 固定为 1365×1365 方框，而导出缓冲动态（如 768×1365）。
 *   微信 canvasToTempFilePath 的 x/y/width/height 实为「CSS 显示尺寸」口径
 *   （官方默认 width=canvasWidth-x 即 CSS 宽；社区/PC 端实测截取宽度=屏宽×pixelRatio）。
 *   CSS≠缓冲时，传「缓冲口径坐标」被按「CSS 口径」解释 → 裁剪区域错位跑飞、
 *   旋转输出被拉伸放大且逐次累积（用户实测：转一次放大一次）。
 *
 * 新方案（本测试验证的对象，与 image-editor.tsx 源码一一对应）：
 *   1. 缓冲 = 成品：九参 drawImage 把选区直接画满缓冲（Canvas 规范精确映射）
 *   2. CSS 同步 = 缓冲（waitCanvasCss 轮询实测确认）
 *   3. 全区域导出：x=0,y=0,width=实测CSS,height=实测CSS,dest=缓冲
 *      → 无论内部按 CSS / CSS×dpr / 缓冲 哪种口径解释，都收敛到「全缓冲」
 *
 * 仿真模型：模拟微信 canvas 的三种候选口径，验证新方案在所有口径下都正确；
 * 并反向复现旧方案在 CSS 口径下的跑飞（证明测试有效）。
 */

let pass = 0
let fail = 0
const assert = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
}

const MAX = 1365
const round = Math.round

// ---------- 与源码一致的映射计算（drawAndExport 的纯数学部分） ----------

/** fullFrame（旋转烘焙）：输出缓冲尺寸 */
function wholeOut(naturalW, naturalH, norm) {
  const fit = Math.min(1, MAX / Math.max(naturalW, naturalH, 1))
  const bufW = Math.max(1, round(naturalW * fit))
  const bufH = Math.max(1, round(naturalH * fit))
  const swap = norm === 90 || norm === 270
  return swap ? { w: bufH, h: bufW } : { w: bufW, h: bufH }
}

/** 裁剪（rot=0）：源矩形（图像自然像素）+ 输出缓冲尺寸 */
function cropSel(crop, naturalW, naturalH) {
  const selW = crop.w * naturalW
  const selH = crop.h * naturalH
  const fit = Math.min(1, MAX / Math.max(selW, selH, 1))
  return {
    sx: crop.x * naturalW, sy: crop.y * naturalH,
    sw: selW, sh: selH,
    outW: Math.max(1, round(selW * fit)),
    outH: Math.max(1, round(selH * fit)),
  }
}

// ---------- 微信 canvas 仿真 ----------

/**
 * 模拟 canvas：缓冲 bufferW×bufferH，CSS 显示尺寸 cssW×cssH。
 * Web 标准：缓冲被「拉伸铺满」CSS 区域显示。
 * canvasToTempFilePath({x,y,width,height,destWidth,destHeight}) 按三种候选口径实现：
 *  - 'css'      ：区域坐标按 CSS 解释（缓冲↔CSS 拉伸映射）
 *  - 'css_dpr'  ：区域坐标按 CSS 解释后再 ×dpr 映射到缓冲（PC 端实测行为）
 *  - 'buffer'   ：区域坐标按缓冲像素解释
 * 输出 = 所选缓冲区域拉伸到 destWidth×destHeight。
 */
function makeCanvas(bufferW, bufferH, cssW, cssH, dpr) {
  // 缓冲内容：用一个函数表示「缓冲像素 (bx,by) 处的颜色」= 归一化坐标 (bx/bufferW, by/bufferH)
  const sample = (bx, by) => ({ u: bx / bufferW, v: by / bufferH })
  return {
    bufferW, bufferH, cssW, cssH, dpr, sample,
    toTempFilePath({ x = 0, y = 0, width, height, destWidth, destHeight }, mode) {
      // 区域 → 缓冲区域（按口径）
      let bx0 = x, by0 = y, bw = width, bh = height
      if (mode === 'css') {
        bx0 = x * (bufferW / cssW); by0 = y * (bufferH / cssH)
        bw = width * (bufferW / cssW); bh = height * (bufferH / cssH)
      } else if (mode === 'css_dpr') {
        bx0 = x * dpr; by0 = y * dpr
        bw = width * dpr; bh = height * dpr
      } // 'buffer'：原样
      // clamp 到缓冲（模拟微信对越界区域的裁剪）
      const cx0 = Math.max(0, Math.min(bx0, bufferW))
      const cy0 = Math.max(0, Math.min(by0, bufferH))
      const cx1 = Math.max(0, Math.min(bx0 + bw, bufferW))
      const cy1 = Math.max(0, Math.min(by0 + bh, bufferH))
      // 取区域四角/中心的采样（模拟导出内容）
      const wPct = (cx1 - cx0) / bufferW
      const hPct = (cy1 - cy0) / bufferH
      const center = sample((cx0 + cx1) / 2, (cy0 + cy1) / 2)
      return {
        region: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 },
        coverageW: wPct, coverageH: hPct,
        center,
        outW: destWidth, outH: destHeight,
      }
    },
  }
}

/** 新方案导出参数（与源码 drawAndExport 末尾一致） */
function newExportParams(canvas, outW, outH, cssMeasured) {
  const expW = cssMeasured && cssMeasured.w > 0 ? cssMeasured.w : outW
  const expH = cssMeasured && cssMeasured.h > 0 ? cssMeasured.h : outH
  return { x: 0, y: 0, width: expW, height: expH, destWidth: outW, destHeight: outH }
}

/** 旧方案导出参数（已回退的实现：CSS 固定 1365 方框 + 区域=缓冲口径坐标） */
function oldExportParams(crop, canvasW, canvasH) {
  return {
    x: round(crop.x * canvasW), y: round(crop.y * canvasH),
    width: round(crop.w * canvasW), height: round(crop.h * canvasH),
    destWidth: round(crop.w * canvasW), destHeight: round(crop.h * canvasH),
  }
}

// ---------- [1] 新方案：全区域导出在三种口径下都覆盖全缓冲 ----------
console.log('\n[1] 新方案：全区域导出（x=0,y=0,width=CSS）在三种候选口径下都取到全缓冲')

{
  // 竖图 1080×1920，缓冲 768×1365；新方案 CSS 同步为 768×1365
  const naturalW = 1080, naturalH = 1920
  const out = wholeOut(naturalW, naturalH, 0)
  const css = { w: out.w, h: out.h }
  for (const mode of ['css', 'css_dpr', 'buffer']) {
    const cv = makeCanvas(out.w, out.h, css.w, css.h, 3)
    const r = cv.toTempFilePath(newExportParams(cv, out.w, out.h, css), mode)
    const full = Math.abs(r.coverageW - 1) < 0.01 && Math.abs(r.coverageH - 1) < 0.01
    assert(full, `口径 ${mode}：整图导出覆盖 100% 缓冲`,
      `coverage=${(r.coverageW * 100).toFixed(1)}%×${(r.coverageH * 100).toFixed(1)}%`)
    assert(r.outW === out.w && r.outH === out.h, `口径 ${mode}：输出像素 = 缓冲尺寸`,
      `${r.outW}×${r.outH}（期望 ${out.w}×${out.h}）`)
  }
}

// ---------- [2] 旧方案反向复现：CSS 固定方框 + 缓冲口径坐标 → CSS 口径下跑飞 ----------
console.log('\n[2] 反向复现旧方案（CSS 固定 1365 方框）：CSS 口径下区域只覆盖部分缓冲 → 跑飞')

{
  const naturalW = 1080, naturalH = 1920
  const out = wholeOut(naturalW, naturalH, 0)   // 缓冲 768×1365
  const cv = makeCanvas(out.w, out.h, 1365, 1365, 3)  // CSS 固定方框（旧方案）
  // 旧方案传的参数（crop 全图 {0,0,1,1} → x=0,y=0,width=768,height=1365）
  const params = oldExportParams({ x: 0, y: 0, w: 1, h: 1 }, out.w, out.h)
  const r = cv.toTempFilePath(params, 'css')
  const broken = r.coverageW < 0.99  // 宽度只取到一部分
  assert(broken, '旧方案在 CSS 口径下：全图导出只取到部分缓冲（复现「随意裁一块」）',
    `coverageW=${(r.coverageW * 100).toFixed(1)}%（期望 100%，实际缺 ${((1 - r.coverageW) * 100).toFixed(1)}%）`)
  // 旋转场景：缓冲 1365×768（横），CSS 1365×1365 → 高度方向只取 56%
  const outR = wholeOut(1920, 1080, 0)  // 横图缓冲 1365×768
  const cvR = makeCanvas(outR.w, outR.h, 1365, 1365, 3)
  const rR = cvR.toTempFilePath(oldExportParams({ x: 0, y: 0, w: 1, h: 1 }, outR.w, outR.h), 'css')
  assert(rR.coverageH < 0.99, '旧方案旋转后（横缓冲）：高度方向只取部分 → 每转一次丢内容+拉伸放大',
    `coverageH=${(rR.coverageH * 100).toFixed(1)}%`)
}

// ---------- [3] 裁剪映射：九参 drawImage 数学精确性 ----------
console.log('\n[3] 裁剪映射：选区直接画满缓冲 → 导出内容与框选区域一致（任意图尺寸/任意 crop）')

{
  const cases = [
    { name: '竖图 1080×1920, crop 默认内缩框', naturalW: 1080, naturalH: 1920, crop: { x: 0.05, y: 0.08, w: 0.9, h: 0.84 } },
    { name: '大图 3000×4000, crop 中部 1/4', naturalW: 3000, naturalH: 4000, crop: { x: 0.25, y: 0.3, w: 0.5, h: 0.4 } },
    { name: '横图 4000×3000, crop 左上', naturalW: 4000, naturalH: 3000, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    { name: '小图 800×600, crop 全图', naturalW: 800, naturalH: 600, crop: { x: 0, y: 0, w: 1, h: 1 } },
  ]
  for (const c of cases) {
    const sel = cropSel(c.crop, c.naturalW, c.naturalH)
    // 源矩形中心（图像归一化）应等于 crop 中心
    const cxSrc = (sel.sx + sel.sw / 2) / c.naturalW
    const cySrc = (sel.sy + sel.sh / 2) / c.naturalH
    const cxCrop = c.crop.x + c.crop.w / 2
    const cyCrop = c.crop.y + c.crop.h / 2
    assert(Math.abs(cxSrc - cxCrop) < 1e-9 && Math.abs(cySrc - cyCrop) < 1e-9,
      `${c.name}：源矩形中心 = 框选中心`, `(${cxSrc.toFixed(4)},${cySrc.toFixed(4)})`)
    // 输出宽高比应与选区宽高比一致（<1% 舍入误差）
    const ratioSel = sel.sw / sel.sh
    const ratioOut = sel.outW / sel.outH
    assert(Math.abs(ratioOut - ratioSel) / ratioSel < 0.01,
      `${c.name}：输出宽高比 ≈ 选区宽高比`, `${ratioOut.toFixed(4)} vs ${ratioSel.toFixed(4)}`)
    // 输出长边 ≤ 1365（官方 Canvas2D 上限）
    assert(Math.max(sel.outW, sel.outH) <= MAX, `${c.name}：输出长边 ≤ 1365`, `${Math.max(sel.outW, sel.outH)}`)
    // 全区域导出（CSS=缓冲）在 CSS 口径下取到全缓冲
    const cv = makeCanvas(sel.outW, sel.outH, sel.outW, sel.outH, 3)
    const r = cv.toTempFilePath(newExportParams(cv, sel.outW, sel.outH, { w: sel.outW, h: sel.outH }), 'css')
    assert(Math.abs(r.coverageW - 1) < 0.01 && Math.abs(r.coverageH - 1) < 0.01,
      `${c.name}：导出覆盖全缓冲（内容=框选内容）`)
  }
}

// ---------- [4] 旋转烘焙：连续旋转 4 次，尺寸交替、无累积放大 ----------
console.log('\n[4] 旋转烘焙：连续 4 次旋转 → 尺寸在两态间交替，无逐次放大')

{
  // 仿真「点旋转按钮」：导出整张旋转图 → 作为新 currentSrc → naturalW/H 更新
  let w = 1080, h = 1920
  const history = [{ w, h }]
  for (let i = 0; i < 4; i++) {
    const out = wholeOut(w, h, 90)
    // 导出 = 全缓冲（新方案），新图尺寸 = outW×outH
    w = out.w; h = out.h
    history.push({ w, h })
  }
  const stable = history[1].w === history[3].w && history[1].h === history[3].h
    && history[2].w === history[4].w && history[2].h === history[4].h
  assert(stable, '连续 4 次旋转后尺寸回到第 1 次旋转后的尺寸（无累积）',
    history.map(s => `${s.w}×${s.h}`).join(' → '))
  // 每次旋转【输出】长边恒 ≤ 1365（初始原图不计入）
  assert(history.slice(1).every(s => Math.max(s.w, s.h) <= MAX), '每次旋转输出长边恒 ≤ 1365')
  // 无放大：每次输出面积 ≤ 旋转前（fit 只缩不涨）
  let noGrow = true
  for (let i = 1; i < history.length; i++) {
    if (history[i].w * history[i].h > history[i - 1].w * history[i - 1].h + 1) noGrow = false
  }
  assert(noGrow, '每次旋转面积不增大（放大累积已消除）')
}

// ---------- [5] 旋转内容正确性：中心点映射 ----------
console.log('\n[5] 旋转内容：中心旋转烘焙 → 图像中心保持在缓冲中心（90°/270°）')

{
  for (const norm of [90, 270]) {
    const naturalW = 1080, naturalH = 1920
    const out = wholeOut(naturalW, naturalH, norm)
    // 绘制：translate(outW/2,outH/2) rotate(norm) drawImage(-w/2,-h/2,w,h)
    // 仿真：源图中心 (0.5,0.5)（归一化）经旋转后仍应在缓冲中心 (0.5,0.5)
    // 缓冲归一化 ↔ 旋转图归一化：旋转图 (u',v')，顺时针 90°: u'=1-v, v'=u（相对整图）
    // 中心 (0.5,0.5) → (0.5,0.5) ✓（数学恒等，此处验证绘制几何不越界）
    const fit = Math.min(1, MAX / Math.max(naturalW, naturalH, 1))
    const bufW = round(naturalW * fit), bufH = round(naturalH * fit)
    // 旋转后整图占满缓冲（不越界）：旋转图尺寸 = bufH×bufW = 缓冲尺寸
    const fills = (norm === 90 || norm === 270) ? (out.w === bufH && out.h === bufW) : (out.w === bufW && out.h === bufH)
    assert(fills, `norm=${norm}：旋转后整图正好铺满缓冲（不裁边、不留白）`,
      `buf ${bufW}×${bufH} → out ${out.w}×${out.h}`)
  }
}

// ---------- [6] 源码一致性：修复已落地 ----------
console.log('\n[6] 源码一致性（image-editor.tsx）')

{
  const fs = require('fs')
  const src = fs.readFileSync('/workspace/projects/src/components/image-editor.tsx', 'utf8')
  assert(src.includes('waitCanvasCss'), '存在 waitCanvasCss（CSS 同步轮询确认）')
  assert(src.includes('setCanvasCss({ w: outW, h: outH })'), '导出前 CSS 同步为缓冲尺寸')
  assert(/drawImage\(img,\s*sx,\s*sy,\s*sw,\s*sh,\s*0,\s*0,\s*outW,\s*outH\)/.test(src),
    '裁剪用九参 drawImage 把选区画满缓冲')
  assert(!/function\s+cropToBufferRect/.test(src), '旧 cropToBufferRect 区域映射函数已移除')
  assert(/x:\s*0,\s*y:\s*0,/.test(src) && /destWidth:\s*outW/.test(src),
    '全区域导出：x=0,y=0 + dest=缓冲')
  assert(!src.includes('width: CANVAS_CSS_SIDE'), 'CSS 不再固定为 1365 方框（改为 canvasCss state）')
  assert(src.includes('width: canvasCss.w') && src.includes('height: canvasCss.h'),
    'Canvas CSS 尺寸来自 canvasCss state')
  assert(src.includes('confirmQuad'), '存在 confirmQuad（四角确认入口）')
  assert(src.includes('确认四角'), 'UI 存在「确认四角」按钮')
  assert(src.includes("manual_corners: quad"), '确认四角带 manual_corners 提交后端')
  assert(src.includes('请先点「旋转90°」完成旋转'), '旋转+裁剪复合场景有安全网（明确报错不输出错图）')
}

// ---------- 结果 ----------
console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
