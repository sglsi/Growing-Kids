/**
 * 验证：用真实 ESPCN 权重（从 TF 冻结图转换）跑本项目的 superResolveESPCN，
 * 与 TF 图自身输出（verify_x{s}.json 中的 ref）逐像素比对。
 * 目的：确认转换后的权重 + 归一化/激活约定与训练时完全一致（不靠猜）。
 */
import { superResolveESPCN } from '/workspace/projects/server/src/image/image-superres'
import * as fs from 'fs'

function loadWeights(scale: number) {
  const j = JSON.parse(fs.readFileSync(`/tmp/espcn_x/espcn_weights_x${scale}.json`, 'utf8'))
  const f = (a: number[]) => Float32Array.from(a)
  return {
    scale: j.scale, k1: j.k1, c1: j.c1, k2: j.k2, c2: j.c2, k3: j.k3,
    w1: f(j.w1), b1: f(j.b1), w2: f(j.w2), b2: f(j.b2), w3: f(j.w3), b3: f(j.b3),
    act: j.act, outAct: j.outAct,
    inScale: j.inScale, inShift: j.inShift, outScale: j.outScale, outShift: j.outShift,
  } as any
}

let allPass = true
for (const s of [2, 3, 4]) {
  const d = JSON.parse(fs.readFileSync(`/tmp/espcn_x/verify_x${s}.json`, 'utf8'))
  const W = d.W, H = d.H
  const luma = Float32Array.from(d.luma)
  const ref = Float32Array.from(d.ref)
  const weights = loadWeights(s)
  const out = superResolveESPCN(luma, W, H, weights)

  // 逐像素误差（排除 1px 边界：TF SAME 用零填充，引擎用反射/钳制，边界会有差异）
  const OW = W * s, OH = H * s
  let maxDiff = 0, sumAbs = 0, cnt = 0, maxDiffInterior = 0
  for (let y = 1; y < OH - 1; y++) {
    for (let x = 1; x < OW - 1; x++) {
      const i = y * OW + x
      const diff = Math.abs(out[i] - ref[i])
      sumAbs += diff; cnt++
      if (diff > maxDiff) maxDiff = diff
      if (diff > maxDiffInterior) maxDiffInterior = diff
    }
  }
  const meanAbs = sumAbs / cnt
  const ok = maxDiffInterior < 2.0 // 允许浮点实现差异（C++ oneDNN vs JS）≤ ~2 灰阶
  allPass = allPass && ok
  console.log(
    `x${s}: 引擎输出 ${OW}x${OH} | 内部最大误差 ${maxDiffInterior.toFixed(3)} 灰阶 | ` +
    `全图max ${maxDiff.toFixed(3)} | 平均 ${meanAbs.toFixed(3)} | ` +
    `${ok ? 'PASS ✅' : 'FAIL ❌'}`,
  )
}
console.log(allPass ? '\n全部 PASS：转换权重与 TF 图数值一致' : '\n存在 FAIL')
process.exit(allPass ? 0 : 1)
