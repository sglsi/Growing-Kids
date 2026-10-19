/**
 * Phase 3 动态测试：直接 import 真实源码，验证三项交付：
 *   ① 自动角点检测（image-corners.ts，OpenCV WASM）
 *   ② 曲面 dewarp（image-curvedewarp.ts，实测不达标→断言"不劣化/恒回落"）
 *   ③ OCR 一致性度量（image-quality.ts，纯函数）
 * 并断言 service/module/types/package.json 已落地改动。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/run-image-v4.ts
 */
import * as fs from 'fs'
import sharp from 'sharp'
import { detectCornersCV, detectCornersNeural } from '../server/src/image/image-corners'
import { dewarpCurved, dewarpCurvedNeural } from '../server/src/image/image-curvedewarp'
import { compareRecognized, OCR_CONSISTENCY_THRESHOLD } from '../server/src/image/image-quality'
import { straightenImage, detectDocumentCorners } from '../server/src/image/image-dewarp'
import type { RecognizedItem } from '../server/src/ocr/ocr.types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

function makeImg(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const b = Buffer.alloc(w * h * 4, 255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, bl] = paint(x, y); const o = (y * w + x) * 4
    b[o] = r; b[o + 1] = g; b[o + 2] = bl; b[o + 3] = 255
  }
  return b
}

/** 合成：白底 + 深灰纸张四边形（带 4 角轻微内缩，贴合"拍摄的卷子"） */
function quadDoc(w: number, h: number, corners: [number, number][]): Buffer {
  // 用点在多边形内的判定绘制填充四边形
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
  return makeImg(w, h, (x, y) => (inside(x, y) ? [40, 40, 40] : [255, 255, 255]))
}

function item(q: string): RecognizedItem {
  return { question_content: q, wrong_answer: '', answer_content: '', solution: '', source: '', status: 'pending', question_image_keys: [] }
}

async function main() {
  const cvMod = await import('../server/src/image/image-cv')
  const cv = await cvMod.getCV()
  const cvOn = !!cv
  console.log(`[env] OpenCV WASM 可用: ${cvOn}`)

  // ============ 交付 1：自动角点 ============
  console.log('\n[1] 自动角点检测')
  {
    const W = 400, H = 300
    // 透视四边形（非矩形，四角内缩且上下边倾斜）
    const corners: [number, number][] = [[60, 40], [350, 60], [330, 260], [80, 240]]
    const img = await sharp(quadDoc(W, H, corners), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const det = await detectCornersCV(img)
    ok('合成透视四边形 → 返回 4 角点', !!det && det.length === 4, det ? JSON.stringify(det.map(p => p.map(Math.round))) : 'null')
    if (det && det.length === 4) {
      // 顺序应为 [tl,tr,br,bl]
      const [tl, tr, br, bl] = det
      const ordered = tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1]
      ok('角点顺序 [tl,tr,br,bl]', ordered)
      // 误差：与真值最近匹配距离
      const dists = corners.map((c) => Math.min(...det.map((d) => Math.hypot(d[0] - c[0], d[1] - c[1]))))
      const maxErr = Math.max(...dists)
      ok('角点误差 < 15px', maxErr < 15, `maxErr=${maxErr.toFixed(1)}px`)
    }
  }

  console.log('\n[2] 角点护栏：噪声/小文档/退化')
  {
    // 纯噪声 → 应返回 null（不误检）
    const W = 400, H = 300
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const noise = await sharp(makeImg(W, H, () => {
      const v = Math.floor(rnd() * 256); return [v, v, v]
    }), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const dNoise = await detectCornersCV(noise)
    ok('纯噪声 → null（不误检）', dNoise === null, dNoise ? JSON.stringify(dNoise) : 'null')

    // 极小文档（面积占比 < 0.25）→ null
    const tiny: [number, number][] = [[180, 130], [220, 130], [220, 170], [180, 170]]
    const tImg = await sharp(quadDoc(W, H, tiny), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const dTiny = await detectCornersCV(tImg)
    ok('面积过小 → null', dTiny === null, dTiny ? JSON.stringify(dTiny) : 'null')

    // 满幅矩形（贴边伪文档）→ null
    const full: [number, number][] = [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]
    const fImg = await sharp(quadDoc(W, H, full), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const dFull = await detectCornersCV(fImg)
    ok('满幅贴边 → null（剔除伪文档）', dFull === null, dFull ? JSON.stringify(dFull) : 'null')

    // 神经插槽：无权重 → null 不抛
    const neural = await detectCornersNeural(noise)
    ok('神经插槽无权重 → null 不抛', neural === null)
  }

  console.log('\n[3] 角点降级：detectDocumentCorners 不抛、与 straightenImage 串联')
  {
    const W = 200, H = 150
    const noise = await sharp(makeImg(W, H, (x, y) => { const v = (x * 7 + y * 13) % 256; return [v, v, v] }), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    let threw = false
    let corners: unknown = 'unset'
    try { corners = await detectDocumentCorners(noise) } catch { threw = true }
    ok('detectDocumentCorners 不抛', !threw, `corners=${JSON.stringify(corners)}`)

    // 无四角时的行为：
    //   第七轮起新增「文本行投影倾斜估计」兜底（此前四角检测在"纸面占满画面"时恒不命中，
    //   导致功能等价于不存在）。因此这里**不再**要求 needManual —— 只要不抛、且
    //   要么给出纠偏结果、要么诚实地交还手动，就算通过。
    //   噪声图无文本结构 → 两条路都不命中 → 应回到 needManual。
    const out = await straightenImage(noise, { auto: true })
    ok('straightenImage 无四角：要么纠偏成功，要么诚实交还手动',
      (out.needManual === true && out.buffer === null) || (out.buffer !== null && out.needManual === false),
      `method=${out.method} needManual=${out.needManual}`)
  }

  // ============ 交付 2：曲面 dewarp（实测不达标 → 断言"恒回落不劣化"）============
  console.log('\n[4] 曲面 dewarp：已知不达标，断言"恒返回 null / 不劣化"')
  {
    const W = 300, H = 200
    const flat = await sharp(makeImg(W, H, (x, y) => ((y % 20 < 2) ? [0, 0, 0] : [255, 255, 255])), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const r = await dewarpCurved(flat)
    ok('平面图 dewarpCurved → null（Classical 已撤）', r === null)
    const n = await dewarpCurvedNeural(flat)
    ok('神经插槽 dewarpCurvedNeural → null', n === null)

    // 开启 curved 也不应劣化：curve 返回 null → 回落平面 homography
    const corners: [number, number][] = [[30, 20], [270, 30], [260, 180], [40, 170]]
    const img = await sharp(quadDoc(W, H, corners), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const out = await straightenImage(img, { auto: true, curved: true, manualCorners: corners })
    ok('curved=true 仍正常输出（回落平面）', out.buffer !== null && out.method === 'manual', `method=${out.method}`)
  }

  // ============ 交付 3：OCR 一致性度量 ============
  console.log('\n[5] compareRecognized：核心度量')
  {
    const a = [item('1. 计算 2+3=?'), item('2. 求 x 的值')]
    const same = compareRecognized(a, a)
    ok('完全相同 → score=1', Math.abs(same.score - 1) < 1e-9 && same.similar, `score=${same.score}`)
    ok('完全相同 → detail 计数正确', same.detail.aCount === 2 && same.detail.aChars > 0)

    // 少一题 → 分数下降
    const fewer = compareRecognized(a, [a[0]])
    ok('少一题 → countRatio=0.5', Math.abs(fewer.countRatio - 0.5) < 1e-9, `countRatio=${fewer.countRatio}`)
    ok('少一题 → 判为不一致', fewer.similar === false, `score=${fewer.score.toFixed(3)}`)

    // 内容被破坏（乱码替换）→ charOverlap 低
    const broken = compareRecognized(a, [item('1. ??????????'), item('2. ????????')])
    ok('内容劣化 → charOverlap 低', broken.charOverlap < 0.5, `overlap=${broken.charOverlap.toFixed(3)}`)
    ok('内容劣化 → 判为不一致', broken.similar === false, `score=${broken.score.toFixed(3)}`)

    // 空白差异（仅空格）→ 归一化后一致
    const spaced = compareRecognized([item('abc def')], [item('abc   def')])
    ok('仅空白差异 → 一致', spaced.similar === true && Math.abs(spaced.score - 1) < 1e-9)

    // 边界：两侧皆空 → 一致（无劣化）
    const empty = compareRecognized([], [])
    ok('双空 → 一致(score=1)', empty.similar === true && empty.score === 1)
    // 一侧空一侧非空 → 不一致
    const oneEmpty = compareRecognized(a, [])
    ok('单侧空 → 不一致(score=0)', oneEmpty.similar === false && oneEmpty.score === 0)
    // 非数组输入不炸
    const badIn = compareRecognized(undefined as unknown as RecognizedItem[], [item('x')])
    ok('非数组输入不炸', typeof badIn.score === 'number' && badIn.similar === false)

    // 阈值参数可覆盖
    const custom = compareRecognized(a, [a[0], item('2. 求 y 的值')], 0.99)
    ok('阈值可覆盖(0.99→不一致)', custom.similar === false && custom.score < 0.99, `score=${custom.score.toFixed(3)}`)
    ok('默认阈值常量 = 0.75', OCR_CONSISTENCY_THRESHOLD === 0.75)
  }

  // ============ 源码一致性 ============
  console.log('\n[6] 源码一致性：Phase 3 改动已落地')
  {
    const svc = fs.readFileSync('/workspace/projects/server/src/image/image.service.ts', 'utf8')
    const types = fs.readFileSync('/workspace/projects/server/src/image/image.types.ts', 'utf8')
    const imgMod = fs.readFileSync('/workspace/projects/server/src/image/image.module.ts', 'utf8')
    const ocrMod = fs.readFileSync('/workspace/projects/server/src/ocr/ocr.module.ts', 'utf8')
    const ctrl = fs.readFileSync('/workspace/projects/server/src/image/image.controller.ts', 'utf8')
    const pkg = fs.readFileSync('/workspace/projects/server/package.json', 'utf8')
    const cv = fs.readFileSync('/workspace/projects/server/src/image/image-cv.ts', 'utf8')

    ok('service 含 verifyOcrConsistency', /verifyOcrConsistency/.test(svc))
    ok('service 注入 ocrService', /private readonly ocrService: OcrService/.test(svc))
    ok('service 含 ocrFallback 回退', /ocrFallback/.test(svc))
    ok('service 含 IMG_OCR_VERIFY 开关', /IMG_OCR_VERIFY/.test(svc))
    ok('service 含 IMG_OCR_MIN_SCORE', /IMG_OCR_MIN_SCORE/.test(svc))
    ok('types 含 verify_ocr', /verify_ocr/.test(types))
    ok('types 含 dewarp_curved', /dewarp_curved/.test(types))
    ok('image.module imports OcrModule', /OcrModule/.test(imgMod) && /imports:\s*\[[^\]]*OcrModule/.test(imgMod))
    ok('ocr.module exports OcrService', /exports:\s*\[OcrService\]/.test(ocrMod))
    ok('controller 路由未破坏', /dto\.action === 'enhance'/.test(ctrl) && /dto\.action === 'auto'/.test(ctrl))
    ok('package.json 含 opencv-js', /@techstark\/opencv-js/.test(pkg))
    ok('image-cv 含懒加载单例', /getCV/.test(cv) && /instanceof Promise|onRuntimeInitialized/.test(cv))
    ok('service 含 IMG_OCR_TIMEOUT_MS 超时保护', /IMG_OCR_TIMEOUT_MS/.test(svc))
  }

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
