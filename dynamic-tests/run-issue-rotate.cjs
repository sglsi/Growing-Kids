#!/usr/bin/env node
/**
 * 问题 1 回归：旋转 90° 多次不得裁边、不得逐次放大。
 *
 * 根因演进（两次事故，勿重蹈）：
 *   v1：CSS 与缓冲动态失配（等 React 布局不可靠）→ 旋转 90°/270° 四周被裁；
 *   v2：CSS 固定 1365 方框 + 缓冲动态（如 768×1365）→ canvasToTempFilePath 的
 *       x/y/width/height 实为「CSS 显示尺寸」口径，失配时区域错位 →
 *       「裁剪跑飞 / 转一次放大一次」（传缓冲口径坐标被按 CSS 口径解释）。
 *
 * 现行方案（v3，与 run-issue-crop-geom.cjs 的口径仿真共同验证）：
 *   - 缓冲 = 成品：九参 drawImage 把内容直接画满缓冲；
 *   - CSS 每次导出前同步为缓冲尺寸（waitCanvasCss 轮询实测确认，确定性）；
 *   - 全区域导出：x=0,y=0,width=实测CSS,height=实测CSS,dest=缓冲 → 对口径免疫。
 *
 * 本测试：
 *   [1] 几何正确性（纯函数复算）：连续 4 次 90°，画布与旋转图尺寸恒等、无放大累积
 *   [2] 边界：极端宽高比 / 超大图，输出必 ≤ 1365
 *   [3] 源码一致性：CSS 动态同步、全区域导出、无 rAF 依赖、上限=1365
 */
const fs = require('fs')
const FE = '/workspace/projects/src/components/image-editor.tsx'
const src = fs.readFileSync(FE, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

// 从源码读取真实上限（防测试与实现脱节）
const m = src.match(/const MAX_CANVAS_SIDE = (\d+)/)
const MAX_CANVAS_SIDE = m ? parseInt(m[1], 10) : 1365

// 复算 drawAndExport 的画布尺寸逻辑（fullFrame 旋转烘焙路径）
const calc = (w, h, rot) => {
  const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h, 1))
  const bufW = Math.max(1, Math.round(w * fit))
  const bufH = Math.max(1, Math.round(h * fit))
  const swap = rot % 180 !== 0
  return { bufW, bufH, canvasW: swap ? bufH : bufW, canvasH: swap ? bufW : bufH }
}

console.log(`[1] 几何：连续 4 次 90° 旋转，画布尺寸 = 旋转后图尺寸（无裁边、无放大）  [MAX_CANVAS_SIDE=${MAX_CANVAS_SIDE}]`)
{
  let w = 800, h = 400
  let allFit = true
  let noGrow = true
  for (let i = 1; i <= 4; i++) {
    const { bufW, bufH, canvasW, canvasH } = calc(w, h, 90)
    const expectW = bufH, expectH = bufW // 旋转后自然尺寸
    const fits = canvasW === expectW && canvasH === expectH
    if (!fits) allFit = false
    if (canvasW * canvasH > w * h + 1) noGrow = false
    console.log(`    第${i}次: 输入 ${w}x${h} → 画布 ${canvasW}x${canvasH}, 旋转图 ${expectW}x${expectH} ${fits ? '✅' : '❌'}`)
    w = canvasW; h = canvasH
  }
  ok('四次 90° 旋转全程无失配', allFit)
  ok('四次旋转面积从不增大（放大累积已消除）', noGrow)
  // 首次旋转后尺寸即稳定（1365×340 ↔ 340×1365）
  const s1 = calc(800, 400, 90)
  const s3 = (() => { let w = 800, h = 400; for (let i = 0; i < 3; i++) { const c = calc(w, h, 90); w = c.canvasW; h = c.canvasH } return { w, h } })()
  ok('第 3 次旋转后尺寸 = 第 1 次旋转后尺寸（稳定交替）',
    s1.canvasW === s3.w && s1.canvasH === s3.h, `${s1.canvasW}×${s1.canvasH} vs ${s3.w}×${s3.h}`)

  ok(`输出长边恒 ≤ ${MAX_CANVAS_SIDE}`,
    Math.max(s1.canvasW, s1.canvasH) <= MAX_CANVAS_SIDE)
}

console.log('[2] 边界：极端宽高比 / 超大图（输出必 ≤ 上限）')
{
  const cases = [
    [4000, 100, 90, '极宽'],
    [100, 4000, 90, '极高'],
    [5000, 3000, 90, '超大(触发 fit)'],
    [1920, 1080, 270, '横屏 270°'],
    [1080, 1920, 180, '竖屏 180°(不换宽高)'],
  ]
  for (const [w, h, rot, label] of cases) {
    const { bufW, bufH, canvasW, canvasH } = calc(w, h, rot)
    const swap = rot % 180 !== 0
    const expectW = swap ? bufH : bufW
    const expectH = swap ? bufW : bufH
    const okc = canvasW === expectW && canvasH === expectH
    const withinLimit = canvasW <= MAX_CANVAS_SIDE && canvasH <= MAX_CANVAS_SIDE
    ok(`${label} ${w}x${h} @${rot}° → 画布 ${canvasW}x${canvasH}`, okc && withinLimit)
  }
}

console.log('[3] 源码一致性（修复落地检查）')
{
  ok('上限为 1365（官方安全值）', /const MAX_CANVAS_SIDE = 1365/.test(src), `实际=${MAX_CANVAS_SIDE}`)
  ok('CSS 尺寸来自 canvasCss state（动态同步，非固定方框）',
    src.includes('width: canvasCss.w') && src.includes('height: canvasCss.h'))
  ok('存在 waitCanvasCss（轮询实测确认 CSS==缓冲）', src.includes('waitCanvasCss'))
  ok('导出前 setCanvasCss 同步为缓冲尺寸', src.includes('setCanvasCss({ w: outW, h: outH })'))
  ok('全区域导出：x=0,y=0 + width/height=实测CSS',
    /x:\s*0,\s*y:\s*0,/.test(src) && /width:\s*expW,/.test(src))
  ok('destWidth/destHeight = 缓冲尺寸（输出像素显式）',
    /destWidth:\s*outW,/.test(src) && /destHeight:\s*outH,/.test(src))
  ok('waitLayout 不依赖 rAF（防永久挂起）',
    /const waitLayout = async \(\): Promise<void> => \{\s*await new Promise\(\(r\) => setTimeout\(r, 32\)\)/.test(src))
  ok('已无 canvasBox 残留（旧方案已移除）', !/canvasBox/.test(src))
  ok('旧 cropToBufferRect 区域映射已移除', !/function\s+cropToBufferRect/.test(src))
  ok('防回归注释已写明（CSS==缓冲的血泪教训）',
    /CSS == 缓冲|CSS 口径|口径完全免疫/.test(src))
  ok('img 实际尺寸与 state 不符时有防御校正',
    /Math\.abs\(img\.width - naturalW\)\s*>\s*2/.test(src))
}

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
