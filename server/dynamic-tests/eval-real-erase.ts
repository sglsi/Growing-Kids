/**
 * 真实样本评测台 · v0（去手写）
 * ==========================================================================
 * 目的：把「合成 fixture 上绿、真机拍照上废」这个断裂补上。
 *
 * 与 `probe-erase-chain.ts` 的分工：
 *   · probe-erase-chain  用 SVG 合成图 + 完美 GT 跑**回归**（判断"有没有变差"）
 *   · 本脚本            用**真实照片**跑**基线**（判断"到底有多差"）
 *
 * 无 GT 时也能算的核心代理指标：
 *   `墨量保留率 = 擦后墨量 / 擦前墨量`
 *   - 纯印刷无手写页（反例）：**理想 ≈ 100%**。掉 10% 以上即说明在擦印刷体。
 *   - 有手写页：墨量下降量应 ≈ GT 手写墨量；下降过多 = 误擦印刷，下降过少 = 没擦掉。
 *   这个指标不需要人工标注，因此**可以立刻在真实照片上跑**，先把量级摸出来。
 *
 * 用法（仓库根）：
 *   node node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs \
 *     server/dynamic-tests/eval-real-erase.ts --img "D:/path/a.jpg" --out "D:/out"
 *   ... --dir "D:/samples" --out "D:/out"
 *
 * 输出：
 *   <out>/<name>-mask.png     检测到的擦除 mask（红覆盖在灰度原图上）
 *   <out>/<name>-erased.png   擦除结果
 *   <out>/report.json         每张图的指标 + 分段构成
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { buildHandwritingMask } from '../src/image/handwriting-segmenter'
import { buildEraseMask } from '../src/image/erase-mask-policy'
import { inpaint, blendWithMask } from '../src/image/handwriting-mask'

/** 纸面亮度取 98 分位；墨 = 显著暗于纸面的像素 */
async function inkStats(buf: Buffer): Promise<{ ink: number; total: number; paperL: number }> {
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < n; i++) hist[data[i]]++
  let acc = 0
  let paperL = 235
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc >= n * 0.02) { paperL = v; break }
  }
  const thr = paperL - 60
  let ink = 0
  for (let i = 0; i < n; i++) if (data[i] < thr) ink++
  return { ink, total: n, paperL }
}

/** mask 可视化：灰度原图 + 红色半透明覆盖 */
async function renderMaskOverlay(src: Buffer, mask: { data: Uint8Array | Buffer; width: number; height: number }): Promise<Buffer> {
  const { data, info } = await sharp(src).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height
  const out = Buffer.from(data)
  const ch = info.channels
  for (let i = 0; i < W * H; i++) {
    if (mask.data[i] > 127) {
      const p = i * ch
      out[p] = Math.round(out[p] * 0.35 + 255 * 0.65)
      out[p + 1] = Math.round(out[p + 1] * 0.35)
      out[p + 2] = Math.round(out[p + 2] * 0.35)
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: ch } }).png().toBuffer()
}

export interface EvalRow {
  name: string
  width: number
  height: number
  mode: string
  coverage: number
  inkBefore: number
  inkAfter: number
  /** 墨量保留率：纯印刷反例页理想 ≈ 1.0 */
  inkKeep: number
  paperL: number
  elapsedMs: number
  debug: Record<string, unknown>
}

async function evalOne(file: string, outDir: string): Promise<EvalRow> {
  const name = path.basename(file).replace(/\.(png|jpe?g|webp)$/i, '')
  const src = await sharp(fs.readFileSync(file)).rotate().toBuffer()
  const meta = await sharp(src).metadata()
  const W = meta.width!, H = meta.height!

  const t0 = Date.now()
  const seg = await buildHandwritingMask(src, '', {}, { allowVlm: false, eraseMode: 'hybrid' })
  let mask = seg.mask
  let policyNote = 'hybrid'
  try {
    mask = await buildEraseMask(src, mask, 'word')
    policyNote = 'hybrid+word'
  } catch (e) {
    policyNote = `hybrid(word失败降级: ${e instanceof Error ? e.message : e})`
  }
  const inpainted = await inpaint(src, 'adaptive', mask)
  const merged = await blendWithMask(src, inpainted, mask)
  const elapsedMs = Date.now() - t0

  const before = await inkStats(src)
  const after = await inkStats(merged)

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true })
    await sharp(await renderMaskOverlay(src, mask)).toFile(path.join(outDir, `${name}-mask.png`))
    await sharp(merged).toFile(path.join(outDir, `${name}-erased.png`))
  }

  return {
    name,
    width: W,
    height: H,
    mode: policyNote,
    coverage: +(mask.coverage ?? 0).toFixed(5),
    inkBefore: before.ink,
    inkAfter: after.ink,
    inkKeep: +(before.ink ? after.ink / before.ink : 0).toFixed(4),
    paperL: before.paperL,
    elapsedMs,
    debug: (mask.debug ?? {}) as Record<string, unknown>,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const pick = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const img = pick('--img')
  const dir = pick('--dir')
  const out = pick('--out') ?? ''

  const files: string[] = []
  if (img) files.push(img)
  if (dir) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g|webp)$/i.test(f)) files.push(path.join(dir, f))
    }
  }
  if (!files.length) {
    console.error('用法：--img <单图> | --dir <目录> [--out <输出目录>]')
    process.exit(1)
  }

  const rows: EvalRow[] = []
  for (const f of files) {
    console.log(`\n── ${path.basename(f)} ──`)
    try {
      const r = await evalOne(f, out)
      rows.push(r)
      console.log(
        `   ${r.width}x${r.height} | 模式 ${r.mode} | coverage ${(r.coverage * 100).toFixed(3)}%` +
        ` | 墨量 ${r.inkBefore}→${r.inkAfter} (保留 ${(r.inkKeep * 100).toFixed(2)}%)` +
        ` | ${r.elapsedMs}ms`,
      )
      const d = r.debug
      const keys = ['mode', 'chromaCoverage', 'darkCoverage', 'hybridFallbackReason', 'printProtected', 'wordStates', 'erasePolicy', 'medH', 'illuminationNormalized']
      const brief = keys.filter((k) => d[k] !== undefined).map((k) => `${k}=${JSON.stringify(d[k])}`).join(' ')
      if (brief) console.log(`   debug: ${brief}`)
    } catch (e) {
      console.error(`   ❌ 失败：${e instanceof Error ? e.message : e}`)
      rows.push({ name: path.basename(f), width: 0, height: 0, mode: 'ERROR', coverage: 0, inkBefore: 0, inkAfter: 0, inkKeep: 0, paperL: 0, elapsedMs: 0, debug: { error: String(e) } })
    }
  }

  console.log('\n=== 汇总（墨量保留率 = 擦后/擦前，纯印刷页理想 ≈ 100%）===')
  for (const r of rows) {
    console.log(`${r.name.padEnd(24)} cov=${(r.coverage * 100).toFixed(3)}%  墨保留=${(r.inkKeep * 100).toFixed(2)}%  ${r.mode}`)
  }
  if (out) {
    const p = path.join(out, 'report.json')
    fs.writeFileSync(p, JSON.stringify(rows, null, 2), 'utf8')
    console.log(`\n报告：${p}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
