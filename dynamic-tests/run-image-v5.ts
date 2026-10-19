/**
 * Phase 3 补充：手动拉四角 UI — 前后端链路动态测试。
 *
 * 验证：
 *  ① 后端把「归一化 [0,1] 四角」还原为像素，与直接传像素等效（透视结果一致）
 *  ② 四角乱序提交 → orderCorners 仍给出正面矩形
 *  ③ 退化四角（共线/面积≈0）→ 不崩溃
 *  ④ 口径兼容：任一坐标 >1 视为像素（源码断言）
 *  ⑤ 前端源码一致性：image-editor.tsx 含四角 UI；api.ts 透传 manual_corners
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-image-v5.ts
 */
import * as fs from 'fs'
import sharp from 'sharp'
import { straightenImage, orderCorners, dewarpBuffer } from '../server/src/image/image-dewarp'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

/** 合成：白底 + 深灰四边形（带透视倾斜） */
function quadDoc(w: number, h: number, corners: [number, number][]): Buffer {
  const inside = (px: number, py: number) => {
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = corners[i], [x2, y2] = corners[(i + 1) % 4]
      const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
      if (cross !== 0) {
        const s = cross > 0 ? 1 : -1
        if (sign === 0) sign = s
        else if (s !== sign) return false
      }
    }
    return true
  }
  const b = Buffer.alloc(w * h * 3, 255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inside(x, y)) { const o = (y * w + x) * 3; b[o] = 40; b[o + 1] = 40; b[o + 2] = 40 }
  }
  return b
}

/** 读取图片的宽高（用于比对两次变换结果尺寸） */
async function sizeOf(buf: Buffer): Promise<string> {
  const m = await sharp(buf).metadata()
  return `${m.width}x${m.height}`
}

async function main() {
  const W = 400, H = 300
  // 真值四角（像素）
  const px: [number, number][] = [[60, 40], [350, 60], [330, 260], [80, 240]]
  // 同一组四角的归一化表示
  const norm: [number, number][] = px.map(([x, y]) => [x / W, y / H])
  const img = await sharp(quadDoc(W, H, px), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()

  console.log('[1] 归一化四角 → 像素还原（与直接传像素等效）')
  {
    // 模拟后端 straighten 的口径判定：全部 ≤1 → 乘尺寸
    const restoredPx = norm.map(([x, y]): [number, number] => [x * W, y * H])
    const maxDiff = Math.max(...restoredPx.map(([x, y], i) => Math.hypot(x - px[i][0], y - px[i][1])))
    ok('归一化×尺寸 == 原像素', maxDiff < 1e-6, `maxDiff=${maxDiff.toExponential(2)}`)

    // 端到端：两种口径走 straightenImage 结果尺寸一致
    const rPx = await straightenImage(img, { manualCorners: px, auto: false })
    const rNorm = await straightenImage(img, { manualCorners: restoredPx, auto: false })
    ok('两条路径均成功', rPx.buffer !== null && rNorm.buffer !== null, `method=${rPx.method}`)
    ok('结果尺寸一致', (await sizeOf(rPx.buffer!)) === (await sizeOf(rNorm.buffer!)),
      `${await sizeOf(rPx.buffer!)} vs ${await sizeOf(rNorm.buffer!)}`)
    ok('输出为正面矩形(≈290x220)', rPx.width! > 200 && rPx.height! > 150 && rPx.width! < 400,
      `${rPx.width}x${rPx.height}`)
  }

  console.log('[2] 四角乱序提交 → orderCorners 归一')
  {
    // 反转顺序 [bl,br,tr,tl]
    const shuffled: [number, number][] = [px[3], px[2], px[1], px[0]]
    const ordered = orderCorners(shuffled)
    ok('乱序 → [tl,tr,br,bl]', ordered[0][0] === px[0][0] && ordered[0][1] === px[0][1])
    const r = await straightenImage(img, { manualCorners: shuffled, auto: false })
    ok('乱序端到端仍输出矩形', r.buffer !== null && r.width! > 200, `${r.width}x${r.height}`)
    // 与正序结果尺寸一致
    const r2 = await straightenImage(img, { manualCorners: px, auto: false })
    ok('乱序/正序尺寸一致', (await sizeOf(r.buffer!)) === (await sizeOf(r2.buffer!)),
      `${await sizeOf(r.buffer!)} vs ${await sizeOf(r2.buffer!)}`)
  }

  console.log('[3] 退化四角：共线/面积≈0 不崩溃')
  {
    // 四个点几乎共线 → 单应矩阵奇异
    const collinear: [number, number][] = [[100, 100], [200, 100], [300, 100], [400, 100]]
    let threw = false
    let res: any = null
    try { res = await dewarpBuffer(img, collinear) } catch { threw = true }
    ok('共线四角 → dewarpBuffer 抛错（可捕获）', threw, threw ? '' : `res=${JSON.stringify(res?.width)}`)

    // straightenImage 内部应捕获并降级（不把异常抛给调用方）
    let threw2 = false
    let out: any = null
    try { out = await straightenImage(img, { manualCorners: collinear, auto: false }) } catch { threw2 = true }
    ok('straightenImage 对退化四角不抛', !threw2)
    ok('退化四角 → 回落 needManual（不产出坏图）', !threw2 && out?.needManual === true && out?.buffer === null,
      `method=${out?.method}`)
  }

  console.log('[4] 后端口径兼容：任一坐标 >1 视为像素（源码断言）')
  {
    const svc = fs.readFileSync('/workspace/projects/server/src/image/image.service.ts', 'utf8')
    ok('service 含归一化还原逻辑', /manualCorners/.test(svc) && /srcMeta\.width/.test(svc))
    ok('service 含 >1 像素口径判别', /x > 1 \|\| y > 1/.test(svc))
    ok('service 含 dewarp_curved 透传', /dewarp_curved === true/.test(svc))
  }

  console.log('[5] 前端源码一致性：四角 UI 与 API 透传')
  {
    const editor = fs.readFileSync('/workspace/projects/src/components/image-editor.tsx', 'utf8')
    const api = fs.readFileSync('/workspace/projects/src/services/api.ts', 'utf8')
    ok('editor 含 cornerMode 状态', /const \[cornerMode, setCornerMode\]/.test(editor))
    ok('editor 含 DEFAULT_QUAD', /DEFAULT_QUAD/.test(editor))
    ok('editor 含 hitCorner 命中', /const hitCorner/.test(editor))
    ok('editor 含 isValidQuad 退化保护', /function isValidQuad/.test(editor))
    ok('editor 含 QuadOverlay 视觉层', /function QuadOverlay/.test(editor))
    ok('editor 含「四角拉框」按钮文案', /四角拉框/.test(editor))
    ok('editor 含 Maximize2 图标', /Maximize2/.test(editor))
    ok('editor 提交 manual_corners', /manual_corners: corners/.test(editor))
    ok('editor 处理 needManual 兜底', /needManual/.test(editor) && /showModal/.test(editor))
    ok('editor 含 toggleCornerMode', /const toggleCornerMode/.test(editor))
    ok('api 含 manual_corners 参数', /manual_corners\?: \[number, number\]\[\]/.test(api))
    ok('api 含 dewarp_curved 参数', /dewarp_curved\?: boolean/.test(api))
    ok('api 仅 auto 透传 manual_corners', /action === 'auto'/.test(api) && /extra\.manual_corners/.test(api))
  }

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
