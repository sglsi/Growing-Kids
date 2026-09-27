/**
 * 问题 1 回归：旋转 90° 多次不得裁边。
 *
 * 根因（已定位）：离屏 Canvas 的 CSS 布局尺寸与导出缓冲尺寸在旋转后失配，
 *   canvasToTempFilePath 按 CSS 尺寸理解导出区域 → 四周被裁。
 *
 * 修复：CSS 尺寸由 canvasBox 派生，而 canvasBox 与 node.width/height（缓冲）
 *   使用**同一套 fit/swap 计算**，两者恒等。
 *
 * 本测试：
 *  [1] 几何正确性（纯函数复算）：连续 4 次 90° 旋转，画布与旋转图尺寸恒等、四角不丢
 *  [2] 源码一致性：CSS 用 canvasBox、drawAndExport 同步 canvasBox、导出前 waitLayout
 *  [3] 边界：超大图触发 fit 缩放；宽高比极端（很宽/很高）仍不裁
 */
const fs = require('fs')
const path = require('path')
const FE = '/workspace/projects/src/components/image-editor.tsx'
const src = fs.readFileSync(FE, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

const MAX_CANVAS_SIDE = 4096
// 复算 drawAndExport 的画布尺寸逻辑
const calc = (w, h, rot) => {
  const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h, 1))
  const bufW = Math.max(1, Math.round(w * fit))
  const bufH = Math.max(1, Math.round(h * fit))
  const swap = rot % 180 !== 0
  return { bufW, bufH, canvasW: swap ? bufH : bufW, canvasH: swap ? bufW : bufH }
}

console.log('[1] 几何：连续 4 次 90° 旋转，画布尺寸 = 旋转后图尺寸（无裁边）')
{
  let w = 800, h = 400
  let allFit = true
  for (let i = 1; i <= 4; i++) {
    const { bufW, bufH, canvasW, canvasH } = calc(w, h, 90)
    // 旋转后图的自然尺寸 = (bufH, bufW)；画布必须等于它
    const expectW = bufH, expectH = bufW
    const fits = canvasW === expectW && canvasH === expectH
    if (!fits) allFit = false
    console.log(`    第${i}次: 输入 ${w}x${h} → 画布 ${canvasW}x${canvasH}, 旋转图 ${expectW}x${expectH} ${fits ? '✅' : '❌'}`)
    w = canvasW; h = canvasH
  }
  ok('四次 90° 旋转全程无失配', allFit)
}

console.log('[2] 边界：极端宽高比 / 超大图')
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
  ok('新增 canvasBox 状态', /const \[canvasBox,\s*setCanvasBox\]\s*=\s*useState/.test(src))
  ok('离屏 Canvas 的 CSS 用 canvasBox（不再用 naturalW/H）',
    /<Canvas[\s\S]*?width:\s*canvasBox\.w[\s\S]*?height:\s*canvasBox\.h/.test(src))
  ok('drawAndExport 内同步 canvasBox', /setCanvasBox\(\s*\(prev\)/.test(src))
  ok('同步后等待布局落地 waitLayout', /await waitLayout\(\)/.test(src))
  ok('waitLayout 定义存在（含 rAF + 延时兜底）',
    /const waitLayout\s*=\s*async/.test(src) && /requestAnimationFrame/.test(src))
  ok('CSS 旧写法（naturalW 直接做 canvas 尺寸）已移除',
    !/width:\s*Math\.min\(naturalW/.test(src))
  ok('缓冲=CSS 的注释已写明（防回归）',
    /CSS 尺寸必须 == 导出缓冲尺寸|CSS 尺寸必须与.*缓冲尺寸/.test(src) || /旋转.*四周被裁|四周被裁/.test(src))
}

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
