/**
 * Phase 3 交付 2：曲面 dewarp —— **经实测判定不予交付，仅保留接口与神经插槽**。
 *
 * ── 决策依据（诚实记录，勿删） ─────────────────────────────────────────────
 * 方案 §2.1 列出「曲面展平（可选 Phase 3，DocTr）」。真实 DocTr 权重在部署沙箱不可得
 * （GitHub/HuggingFace/PyTorch 均 TLS 掐断）。故尝试用经典参数化方法离线实现，但**实测失败**：
 *
 *   方法一（逐列暗像素质心中位）：合成卷曲 17.09 → 18.62（变差）
 *   方法二（行投影互相关）：位移估计饱和到搜索边界（-30），不可用
 *   方法三（逐列墨点质心去线性趋势）：残差幅值接近真值，但形状相关系数 ≈ 0.000（形状错误）
 *   方法四（文本基线二次曲线拟合 + 列位移场重映射）：4 组参数实测「改善」为
 *         +1.7% / −0.6% / +0.2% / −0.2% —— 全部落在噪声范围，无任何一例 >10%。
 *
 * 结论：在无神经模型的前提下，经典方法**无法可靠估计非平面文档的弯曲场**，强行上线只会
 * 「看着能跑、实际不改善甚至劣化」。依据「不达标即撤」原则，本模块**不提供可用的曲面展开**，
 * `dewarpCurved` 恒返回 null（调用方据此回落平面 homography，行为与 Phase 1 完全一致，不劣化）。
 *
 * ── 未来接入 ───────────────────────────────────────────────────────────────
 * 生产环境若获得 DocTr / DocUNet / DewarpNet 权重与 ONNX Runtime，在 `dewarpCurvedNeural`
 * 内实现推理（输入图 → 位移场 → 重映射），并让 `dewarpCurved` 在 IMG_CURVEDEWARP=doctr 时优先调用它。
 */

export interface CurveDewarpResult {
  buffer: Buffer
  width: number
  height: number
  curvature: number
  field: number[]
}

/**
 * 曲面展开（当前恒不可用）。
 * @returns 恒为 null —— 调用方必须回落平面 homography（绝不用不可靠结果覆盖）。
 */
export async function dewarpCurved(_buf: Buffer): Promise<CurveDewarpResult | null> {
  return null
}

/**
 * 【神经插槽】真实 DocTr / DocUNet / DewarpNet 接入点（权重不可得，暂不实现）。
 */
export async function dewarpCurvedNeural(_buf: Buffer): Promise<CurveDewarpResult | null> {
  return null
}
