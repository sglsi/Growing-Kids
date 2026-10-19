/**
 * 诊断 2：自动四角检测（detectDocumentCorners）在「真实场景图」上到底能不能工作？
 *
 * 背景：上一轮诊断用的是纯色背景图（无可检测边缘）→ 必然 needManual。
 *       本轮造「深色背景 + 倾斜浅色纸张」的真实场景图，真跑 OpenCV 检测。
 *
 * 运行：npx tsx /workspace/dynamic-tests/run-issue-autodetect.ts
 */
import * as path from 'path'
import { createRequire } from 'module'
const require = createRequire(path.join('/workspace/projects/server/', 'noop.js'))

let pass = 0, fail = 0
function ok(name: string, cond: any, extra?: string) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
function info(m: string) { console.log('        ' + m) }

const SRC = '/workspace/projects/server/src'
const sharp = require('sharp')

/** 造「深色桌面 + 倾斜浅色纸张（带内容）」的真实场景 */
async function makeScene(opts: { skew?: boolean } = {}) {
  const W = 1000, H = 1300
  // 纸张四角（略有透视倾斜）
  const pts = opts.skew === false
    ? [[120, 120], [880, 120], [880, 1180], [120, 1180]]
    : [[150, 110], [860, 170], [820, 1200], [180, 1150]]
  const poly = pts.map((p) => p.join(',')).join(' ')
  const svg = `<svg width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#2a2a2e"/>
    <polygon points="${poly}" fill="#fafaf5"/>
    <line x1="${pts[0][0] + 60}" y1="${pts[0][1] + 120}" x2="${pts[1][0] - 60}" y2="${pts[1][1] + 140}" stroke="#333" stroke-width="5"/>
    <line x1="${pts[0][0] + 60}" y1="${pts[0][1] + 260}" x2="${pts[1][0] - 60}" y2="${pts[1][1] + 280}" stroke="#333" stroke-width="5"/>
    <line x1="${pts[0][0] + 60}" y1="${pts[0][1] + 400}" x2="${pts[1][0] - 60}" y2="${pts[1][1] + 420}" stroke="#333" stroke-width="5"/>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
}

async function main() {
  console.log('==== 诊断 2：自动四角检测在真实场景图上的表现 ====\n')

  const { detectDocumentCorners } = require(path.join(SRC, 'image/image-dewarp.ts'))
  const { straightenImage } = require(path.join(SRC, 'image/image-dewarp.ts'))

  for (const cs of [
    { name: '倾斜纸张（真实场景）', skew: true },
    { name: '正对纸张（矩形）', skew: false },
  ]) {
    console.log(`\n[${cs.name}]`)
    const buf = await makeScene({ skew: cs.skew })
    const meta = await sharp(buf).metadata()
    info(`图 ${meta.width}x${meta.height}, ${buf.length} bytes`)

    let corners: any = null, err: any = null
    try { corners = await detectDocumentCorners(buf) } catch (e: any) { err = e }

    if (err) {
      info(`检测抛错：${err.message.slice(0, 120)}`)
      ok(`[${cs.name}] 检测抛错（需修）`, false, err.message.slice(0, 80))
      continue
    }

    if (corners) {
      info(`检测到四角：${JSON.stringify(corners.map((c: any) => c.map((v: number) => Math.round(v))))}`)
      ok(`[${cs.name}] 自动检测成功（返回 4 角）`, Array.isArray(corners) && corners.length === 4)
      // 真跑纠偏
      const r: any = await straightenImage(buf, { auto: true, curved: false })
      info(`纠偏结果：needManual=${r.needManual} size=${r.width}x${r.height} path=${r.method}`)
      ok(`[${cs.name}] 纠偏产出图`, !!r.buffer && r.buffer.length > 0,
        `bytes=${r.buffer ? r.buffer.length : 0}`)
    } else {
      info('检测返回 null → 降级为「原样返回 + needManual」→ 用户看到图片没变')
      ok(`[${cs.name}] 自动检测返回 null（= 图片没变的原因）`, true)
    }
  }

  console.log('\n[结论] 若真实场景图也检测不到 → 自动四角检测在实际使用中不可靠，')
  console.log('       这就是"自动调整点了没用"的功能级根因（而非开关问题）。')

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('异常:', e); process.exit(1) })
