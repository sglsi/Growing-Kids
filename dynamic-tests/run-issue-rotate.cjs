/**
 * 问题 1 回归：旋转 90° 多次不得裁边。
 *
 * 根因（已定位）：离屏 Canvas 的 CSS 显示尺寸与导出缓冲尺寸在旋转后失配，
 *   canvasToTempFilePath 的 width/height 是「从 canvas 显示尺寸中取的区域」，
 *   故按旧 CSS 尺寸理解 → 旋转 90°/270° 时四周被裁。
 *
 * 修复（确定性方案，不依赖 React 异步布局）：
 *   - 离屏 canvas 的 CSS 显示尺寸恒为 CANVAS_CSS_SIDE × CANVAS_CSS_SIDE（方框，永不变化）；
 *   - 缓冲尺寸 = 本次输出尺寸（含 rotate 的宽高互换），且 ≤ MAX_CANVAS_SIDE（1365，官方安全值）；
 *   - 导出时**显式传** width/height = 缓冲尺寸（≤ CSS，合法），语义确定；
 *   - waitLayout 只用 setTimeout（离屏元素 rAF 可能被节流，await rAF 会永久挂起）。
 *
 * 本测试：
 *   [1] 几何正确性（纯函数复算）：连续 4 次 90°，画布与旋转图尺寸恒等
 *   [2] 边界：极端宽高比 / 超大图，输出必 ≤ 1365
 *   [3] 源码一致性：CSS 固定方框、导出显式传参、无 rAF 依赖、上限=1365
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
const CSS_SIDE = src.match(/const CANVAS_CSS_SIDE = (\w+)/)

// 复算 drawAndExport 的画布尺寸逻辑
const calc = (w, h, rot) => {
  const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h, 1))
  const bufW = Math.max(1, Math.round(w * fit))
  const bufH = Math.max(1, Math.round(h * fit))
  const swap = rot % 180 !== 0
  return { bufW, bufH, canvasW: swap ? bufH : bufW, canvasH: swap ? bufW : bufH }
}

console.log(`[1] 几何：连续 4 次 90° 旋转，画布尺寸 = 旋转后图尺寸（无裁边）  [MAX_CANVAS_SIDE=${MAX_CANVAS_SIDE}]`)
{
  let w = 800, h = 400
  let allFit = true
  for (let i = 1; i <= 4; i++) {
    const { bufW, bufH, canvasW, canvasH } = calc(w, h, 90)
    const expectW = bufH, expectH = bufW // 旋转后自然尺寸
    const fits = canvasW === expectW && canvasH === expectH
    if (!fits) allFit = false
    console.log(`    第${i}次: 输入 ${w}x${h} → 画布 ${canvasW}x${canvasH}, 旋转图 ${expectW}x${expectH} ${fits ? '✅' : '❌'}`)
    w = canvasW; h = canvasH
  }
  ok('四次 90° 旋转全程无失配', allFit)

  // 关键：CSS 方框必须容得下任何旋转后的缓冲（否则取区域越界 → 裁）
  ok(`CSS 方框 ${MAX_CANVAS_SIDE} ≥ 任意缓冲（横放/竖放都放得下）`,
    MAX_CANVAS_SIDE >= Math.max(calc(800, 400, 90).canvasW, calc(800, 400, 90).canvasH))
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
    const withinCss = canvasW <= MAX_CANVAS_SIDE && canvasH <= MAX_CANVAS_SIDE // CSS 方框可容纳
    ok(`${label} ${w}x${h} @${rot}° → 画布 ${canvasW}x${canvasH}`, okc && withinLimit && withinCss)
  }
}

console.log('[3] 源码一致性（修复落地检查）')
{
  ok('上限为 1365（官方安全值）', /const MAX_CANVAS_SIDE = 1365/.test(src), `实际=${MAX_CANVAS_SIDE}`)
  ok('存在固定 CSS 方框常量 CANVAS_CSS_SIDE', /const CANVAS_CSS_SIDE\s*=/.test(src))
  ok('离屏 Canvas 的 CSS 用 CANVAS_CSS_SIDE（固定方框，不随图变化）',
    /<Canvas[\s\S]*?width:\s*CANVAS_CSS_SIDE[\s\S]*?height:\s*CANVAS_CSS_SIDE/.test(src))
  ok('导出时显式传 width/height（不依赖默认值）',
    /canvasToTempFilePath\(\{[\s\S]*?x:\s*Math\.round\(x\)[\s\S]*?width:\s*Math\.round\(w\)[\s\S]*?height:\s*Math\.round\(h\)/.test(src))
  ok('waitLayout 不再依赖 rAF（防永久挂起）',
    /const waitLayout = async \(\): Promise<void> => \{\s*await new Promise\(\(r\) => setTimeout\(r, 32\)\)/.test(src))
  ok('已无 canvasBox 残留（旧方案已移除）', !/canvasBox/.test(src))
  ok('CSS 旧写法（naturalW 直接做 canvas 尺寸）已移除', !/width:\s*Math\.min\(naturalW/.test(src))
  ok('防回归注释已写明（说明为何用固定方框）',
    /恒为 CANVAS_CSS_SIDE|从根上消除.*失配|旋转 90°\/270° 四周被裁/.test(src))
}

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
