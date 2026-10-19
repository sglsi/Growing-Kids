/**
 * 验证 image-deskew 的角度符号约定：构造已知倾斜角的图，看估计值是否反号正确。
 * 运行：cd push-ready/server && npx tsx /workspace/dynamic-tests/probe-deskew-sign.ts
 */
import sharp from 'sharp'
import { estimateSkew, deskewImage } from '../push-ready/server/src/image/image-deskew'

const W = 900, H = 1200
const lines = Array.from({ length: 14 }, (_, i) =>
  `<text x="80" y="${120 + i * 70}" font-family="serif" font-size="30" fill="#111">这是一行印刷体测试文字 ${i + 1} 用于倾斜检测</text>`,
).join('')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#fff"/>${lines}</svg>`

async function main() {
  const flat = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer()
  console.log('flat 估计:', await estimateSkew(flat))

  for (const deg of [5, -7, 2.5, -12]) {
    const rotated = await sharp(flat).rotate(deg, { background: '#ffffff' }).jpeg({ quality: 95 }).toBuffer()
    const est = await estimateSkew(rotated)
    const applied = est.rotateDeg
    const residualRaw = deg + applied
    console.log(`真实倾斜 ${deg}° → 估计 rotateDeg=${applied}°  若直接施加 residual=${residualRaw.toFixed(2)}°  conf=${est.confidence.toFixed(3)} ink=${est.inkPixels}`)

    // 真施加一次，看残余角
    const out = await deskewImage(rotated)
    if (!out) { console.log('   deskewImage 返回 null（未达阈值）'); continue }
    const after = await estimateSkew(out.buffer)
    console.log(`   施加 ${out.rotateDeg}° 后 → ${out.width}x${out.height}，残余估计 ${after.rotateDeg}°`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
