/**
 * ⭐ v20：**红笔空间先验通道**（作业批改场景专用）
 * ============================================================
 *
 * ── 为什么需要这个通道（v19 之后的最大缺口）────────────────────────
 * 上一轮普查（`probe-feature-auc.ts`）实测：在 1024px 宽的报纸作业上，
 * 区分「黑笔手写」与「黑色印刷」的**所有像素级特征 AUC 都 ≈ 0.5**：
 *
 *   粗细腐蚀存活率  0.497~0.560      域高度（字号）  0.478~0.566
 *   域宽度          0.472~0.528      域密度        0.501~0.552
 *   灰度对比深度    0.551~0.619      3×3 灰度方差   0.480~0.570
 *
 * 原因不是实现不到位，而是**信息不足**：报纸正文字高仅 6~7px，
 * 手写与印刷在这个尺度上笔宽、字高、灰度、连通域形状全部退化到同一量级。
 * 任何"调阈值"都不可能凭空造出信息——**必须换判据维度**。
 *
 * ── 本通道的判据：空间关系，不是局部纹理 ──────────────────────────
 * 作业批改有一个不可违反的物理约束：
 *
 *     **教师只在学生写过的地方批改。**
 *
 * 所以「红笔够得着的地方」=「学生写过的地方」。这与墨迹长什么样无关，
 * 因此不受 6~7px 尺度退化影响。
 *
 * ── ⚠️ v20.2 两条血泪教训（先读懂再改这里）────────────────────────
 * 【教训一：红笔口径必须统一】v20 初版在本模块内部用裸彩度 `max-min≥14`
 *   自行判红。报纸灰底/半调照片的彩色噪声大量越过裸阈值——实测 page30
 *   判出 466,463px"红笔"（全页 33%），而 v19 验证过的 `maskFromColorThreshold`
 *   只检出 5,379px（**87 倍差距**）。菱形膨胀 R=24 后盖满整栏印刷，
 *   印刷误删率冲到 79%。修复：红笔 mask 由调用方注入（`redMask` 参数），
 *   与 v19 色域链完全同源；内部兜底判据也升级为相对纸张口径。
 *
 * 【教训二：连通闸与包含度是两回事】v20.1 删掉的 `requireConnected`
 *   是"在 (红∪墨) 上连通扩展"——报纸上印刷与红笔大量连通，扩展即放行
 *   整片印刷，该闸在该场景是风险源，删除正确。
 *   但**连通域包含度**（本版新增）不同：它不扩展任何东西，只检查每个
 *   墨迹连通域"自身有多大部分落在菱形内"。教师勾在题号上时，印刷域
 *   主体必然延伸到菱形外（占比低 → 剔除）；黑笔域整体在批改点附近
 *   （占比高 → 保留）。判定单元是"域自己"，不存在把别人拉进来的通道。
 *
 * ── R 半径标定（v20.2 `probe-rscan2.ts` 重扫，黑笔覆盖 / 印刷覆盖）─────
 *（旧 probe-red-prior 的表因裸彩度判红作废，本表为修正口径后的干净数据）
 *
 *   R    p28          p29          p30          p31
 *   8    0.16 / 0     0.14 / 0     0.17 / 0     0.14 / 0
 *   16   0.37 / 0     0.35 / 0     0.35 / 0     0.35 / 0
 *   20   0.51 / 0     0.49 / 0     0.48 / 0     0.47 / 0
 *   24   0.64 / 0     0.63 / .001  0.62 / .001  0.63 / 0    ★选中
 *   28   0.73 / .005  0.73 / .010  0.70 / .004  0.75 / .007
 *   32   0.81 / .011  0.81 / .025  0.76 / .010  0.82 / .020
 *
 * R=24 黑笔覆盖 62~64%、印刷覆盖 ≤0.1%；R≥28 印刷覆盖开始爬升。
 * 按"宁可漏擦不可错擦"取 **R=24**。
 * 端到端（`probe-hybrid-verify.ts`，含 inpaint/blend）：黑笔去除 0.60~0.64，
 * 印刷误删 0.0002~0.0010，红笔去除与 color 模式持平，家具误删 ≤0.007。
 *
 * ── v20.6：**半径不是答案，两端被同一根 trade-off 夹住**（4 页实测）
 *
 * 用户反馈②"擦红笔时把红笔周边印刷体一起擦掉了"。取证三联图
 * （`probe-dmg-crop.ts`）看清了机理：
 *   page28 `learn more about Beijing`（**黑印刷**）整行被擦空，
 *          而**同一句的红印刷版本完整保留** → 菱形把黑字版整行圈入
 *   page29 `We signed the contract` 整行被擦空，只剩行首 `We`/行尾 `nt`
 *          （都在菱形外）→ 红笔只是**横穿**该行，并未压住它
 *   page31 `have (has)` 是**学生手写**（潦草连笔），擦掉是对的
 *          → 「纯印刷行」口径有**假阴性**：把手写误算为印刷损失
 *   几何根因：正文行高仅 6~7px、行距约 1px，菱形垂直半径 24px
 *          ≈ **上下各 4 个整行**。受损域实测 bh=6~11（=正文字高），
 *          即被整域带走的正是**一个个印刷字**。
 *
 * 【已否决路径 A：缩小半径】用修正后的行墨量守恒口径重扫
 *   （`probe-rscan-fair.ts`；旧 printDamage 对红笔周边是盲区，R=24 是在
 *    该盲区下选的）：
 *     R    8      12     16     20     24     28
 *     p28  .9969  .9924  .9899  .9872  .9831  .9740
 *     p31  .9987  .9967  .9938  .9873  .9695  .9542
 *   R=8 印刷几乎无损但黑笔覆盖骤降——只是把"擦错印刷"换成"漏擦黑笔"，
 *   而用户的两个抱怨是同一 trade-off 的两端。**R=24 保持不变。**
 *
 * 【已否决路径 B：各向异性走廊】菱形改矩形（水平 rx / 垂直 ry 分离），
 *   直觉上"垂直方向才是受害方向"。实测（`probe-corridor.ts`，8 组合 × 4 页，
 *   diamond 24/24 基线已与生产对齐验证）：
 *     组合        黑笔去除   印刷行保持   受损行(p28/29/30/31)
 *     24/24 ★基线  0.6053    0.9719       6/10/11/6
 *     24/12        0.5979    0.9772       6/8/11/3      Δ黑-0.7pp Δ印+0.5pp
 *     32/8         0.5040    0.9876       4/6/4/5
 *     24/8         0.4433    0.9880       3/5/2/2
 *     40/6         0.4443    0.9925       1/2/2/2
 *     24/6         0.3443    0.9945       1/2/1/1      Δ黑-26pp
 *   **加宽 rx 救不回来**（56/6 仍只有 0.4613）——黑笔与红笔的间距分布
 *   在各方向都重叠，说明二者空间上本就难分，非形状问题。
 *   性价比（每损失 1pp 黑笔换来的 pp 印刷）：24/8=0.099、24/6=0.087、
 *   32/8=0.155、40/6=0.128 —— **全部为负**。
 *   唯一例外 24/12 接近白赚（Δ黑-0.7pp / Δ印+0.5pp），但收益过小，
 *   不足以抵消"垂直半径不再是 24"对**斜向红笔**的漏擦风险（未测）。
 *   结论：**保持菱形 R=24 不变**，路径 B 否决。
 *
 * ── v20.7：**段级（笔级）判定也否决**——"域内有梯度"不等于"梯度有用"
 *
 * v20.6 排除半径与形状后，剩下唯一未违反上述否决的方向是段级：
 * 同一个墨迹连通域内，贴着红笔笔画的那几笔是黑笔（该擦），
 * 远离笔画的几笔是印刷（不该擦）。它改的是"域内哪些像素"，
 * 而半径改的是"域是否入选"——**原理上不被同一根 trade-off 夹住**。
 *
 * 【可行性：原理成立】`probe-seg-feasible.ts`：菱形内 1953 个墨迹域中，
 *   域内"到最近红笔距离"的离散度 ≤4px（无法再切分）仅占 **26%**，
 *   即 **74% 的域在域内是有梯度的**。→ 段级切分在数据上有可分空间。
 *
 * 【实现：实测更差】`probe-seg-impl.ts`，域级闸不变，只把"整域擦"
 *   改成"只擦域内距红笔 ≤ segR 的像素"（4 页均值）：
 *
 *     段阈值        黑笔去除   印刷行保持   受损行
 *     域级(旧) ★    0.6053    0.9719       8.2
 *     20            0.4753    0.9808       5.2
 *     16            0.3452    0.9879       3.5
 *     12            0.2390    0.9927       2.8
 *      8            0.1290    0.9970       0.8
 *
 *   **比缩小半径更差**：segR=20 掉 13pp 黑笔只换 0.9pp 印刷（性价比 0.07），
 *   而半径 R=12 掉 1.1pp 黑笔就换 0.8pp 印刷（性价比 0.72）。
 *   根因：**"域内有距离梯度"≠"该梯度与'该擦/不该擦'相关"**——
 *   黑笔与误擦印刷到红笔的距离分布高度重叠。可分的是"域"，
 *   不可分的是"域内哪个像素属于哪一类"。判别信息到此为止。
 *
 * 【三条路全部否决的共同结论】缩小半径 / 各向异性走廊 / 段级判定，
 *   都试图绕过"黑笔与红笔旁印刷在 6~7px 字高下空间重叠"这一客观事实，
 *   全部失败。这与 §头部 AUC≈0.5 的普查结论一致：
 *   **该场景不存在纯像素级/空间级的可靠判据**。
 *   保持 `radius=24` + 域级整域擦（现状），如需进一步提升黑笔去除，
 *   只能引入**版面语义**（题号/答题区/槽位）或**人机交互**（用户框选补擦），
 *   而非继续调几何参数。
 *
 * ── 适用范围与边界（诚实说明）─────────────────────────────────────
 * ✅ 适用：教师用红/蓝笔批改 + 学生黑笔/铅笔做题（作业本、试卷、练习册）
 * ❌ 不适用：**无批改的空白作业**（没有红笔就没有先验，本通道产出 0）
 *    → 该场景仍需深色通道，但受 §上文 AUC≈0.5 的信息瓶颈限制，
 *      只能靠框选补擦兜底。这是版面的客观约束，不是本实现的缺陷。
 */

import sharp from 'sharp'
import { connectedComponents } from './image-layout'


export interface RedInkPriorOptions {
  /** 菱形膨胀半径（px）。默认 24 */
  radius?: number
  /** 墨迹彩度上限（低于此值视为黑/灰墨）。默认 14，与全局 chroma 口径一致 */
  inkChromaMax?: number
  /** 墨迹暗度阈值系数（× 纸面 luma 的 p90）。默认 0.62
   *  ⚠️ 放宽此值无效（probe-darkscan.ts 实测 0.62→0.74：黑笔去除 0.664→0.643
   *     反而下降）——更多印刷像素进墨迹，黑笔域与印刷粘连成大连通域，
   *     被 minDomainRatio 整域丢弃，净收益为负。别再扫这个参数。 */
  inkDarkRatio?: number
  /** 纸面亮度分位。默认 0.9 */
  paperQuantile?: number
  /** 红笔彩度阈值（仅内部兜底检测用）。默认 14 */
  redChromaMin?: number
  /**
   * ⭐ v20.2：**外部注入的红笔 mask**（与 origBuf 同尺寸，非 0 即红笔）。
   * 必须来自 v19 色域精修链（`refineColorEraseMask` 产物最佳——家具已排除，
   * 菱形不会再在家具（页眉横幅/订正栏）周围圈住印刷）。
   * 见头部【教训一】。
   */
  redMask?: Buffer | Uint8Array
  /**
   * ⭐ v20.2：墨迹连通域包含度阈值（0~1）。
   * 域内落在菱形区域的像素占比 ≥ 该值才保留整个域。默认 0.7（v21.7 由 0.6 上调）。
   * 目的：教师勾在印刷题号上时，把"被红笔碰到但主体是印刷"的域整域剔除。
   * v21.7 上调到 0.7：红对勾随手打在印刷题目/横线上时，印刷字的身子大多在菱形外，
   *   占比更低 → 更激进地把这类"红笔压印刷"的域整域剔除（详见 v21.7 红笔压印刷修复说明）。
   * 设 1 可关闭（最保守——只留完全在菱形内的域）。
   */
  minDomainRatio?: number
}

/** 计算检测用墨迹（低彩度暗像素）：黑笔 + 黑色印刷 */
function inkMaskFromRaw(
  rgb: Buffer, w: number, h: number, ch: number,
  chromaMax: number, darkTh: number,
): Uint8Array {
  const n = w * h
  const ink = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ch
    const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2]
    const c = Math.max(r, g, b) - Math.min(r, g, b)
    if (c >= chromaMax) continue
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    if (l >= darkTh) continue
    ink[i] = 1
  }
  return ink
}

/** 菱形（曼哈顿距离 ≤ R）膨胀：O(R·n)，R=24 时 134M 次内存访问，<1s */
function dilateDiamond(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // 逐行扫描的 Manhattan 距离变换（两趟：下上 + 上下），O(n) 且精确
  const INF = r + 1
  const dist = new Int32Array(w * h).fill(INF)
  for (let y = 0; y < h; y++) {
    const b = y * w
    for (let x = 0; x < w; x++) {
      if (src[b + x]) { dist[b + x] = 0; continue }
      const left = x > 0 ? dist[b + x - 1] : INF
      const up = y > 0 ? dist[(y - 1) * w + x] : INF
      dist[b + x] = Math.min(INF, left + 1, up + 1)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const b = y * w
    for (let x = w - 1; x >= 0; x--) {
      if (src[b + x]) continue
      const right = x < w - 1 ? dist[b + x + 1] : INF
      const down = y < h - 1 ? dist[(y + 1) * w + x] : INF
      const v = Math.min(dist[b + x], right + 1, down + 1)
      dist[b + x] = v
    }
  }
  const d = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) if (dist[i] <= r) d[i] = 1
  return d
}

/**
 * 提取「红笔空间先验」黑笔 mask。
 *
 * @param origBuf 原图或光照归一化图（尺寸须与 redMask 一致）
 * @returns mask 及统计；无红笔时返回 coverage=0 且 debug.reason 说明原因
 */
export async function maskFromRedSpatialPrior(
  origBuf: Buffer,
  opts: RedInkPriorOptions = {},
): Promise<{
  data: Buffer
  coverage: number
  penPx: number
  inkInRegionPx: number
  redPx: number
  reason: string
}> {
  const meta = await sharp(origBuf).metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  const n = w * h
  const empty = (reason: string) => ({ data: Buffer.alloc(n, 0), coverage: 0, penPx: 0, inkInRegionPx: 0, redPx: 0, reason })

  if (!w || !h) return empty('bad_size')

  const { data: rgb, info } = await sharp(origBuf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  if (info.width !== w || info.height !== h) return empty('size_mismatch')

  const radius = opts.radius ?? 24
  const inkChromaMax = opts.inkChromaMax ?? 14
  const inkDarkRatio = opts.inkDarkRatio ?? 0.62
  const redChromaMin = opts.redChromaMin ?? 14
  const paperQ = opts.paperQuantile ?? 0.9
  // v21.7：由 0.6 上调到 0.7（红笔压印刷修复）：更激进地剔除"身子在菱形外"的域（多为印刷字）
  const minDomainRatio = opts.minDomainRatio ?? 0.7

  // 纸面亮度（p90）与暗阈值
  const lumas: number[] = []
  for (let i = 0; i < n; i += 37) {
    const p = i * ch
    lumas.push(0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2])
  }
  lumas.sort((a, b) => a - b)
  const paper = lumas[Math.floor(lumas.length * paperQ)] || 240
  const darkTh = paper * inkDarkRatio

  // ── 红笔 mask：优先用外部注入（v20.2 教训一）─────────────────
  const red = new Uint8Array(n)
  let redPx = 0
  if (opts.redMask && opts.redMask.length >= n) {
    for (let i = 0; i < n; i++) if (opts.redMask[i]) { red[i] = 1; redPx++ }
  } else {
    // 兜底：相对纸张口径（与 maskFromColorThreshold 对齐），仍非首选
    for (let i = 0; i < n; i++) {
      const p = i * ch
      const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2]
      const chromaExcess = Math.max(r, g, b) - Math.min(r, g, b)
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      if (chromaExcess - 0 >= redChromaMin && l <= paper * 0.8) { red[i] = 1; redPx++ }
    }
  }
  if (redPx < 50) return empty('no_red_pen')

  // 墨迹（黑笔 + 印刷）：松阈值用于擦除内容，紧阈值用于连通域判定（v20.5 解耦）
  const ink = inkMaskFromRaw(rgb, w, h, ch, inkChromaMax, darkTh)

  // 菱形区域
  const region = dilateDiamond(red, w, h, radius)
  let inkInRegion = 0
  for (let i = 0; i < n; i++) if (region[i] && ink[i]) inkInRegion++
  if (inkInRegion === 0) return empty('no_ink_near_red')

  // ── v20.2 连通域包含度过滤（教训二）──────────────────────────
  // 每个墨迹连通域：统计它有多少比例落在菱形区域内。
  //   黑笔域 → 整体在批改点附近，比例高 → 保留
  //   被红笔碰到的印刷域 → 主体延伸到菱形外，比例低 → 整域剔除
  //
  // ⚠️⚠️ **不要"修正" inR 的分子口径**（v20.5 血泪）：
  //   这里数的是「域 bbox 内落在菱形的像素数」，不是「域自身的像素数」。
  //   后者语义上更严谨，实测却全面劣化：
  //     严格口径（域内像素）：黑笔去除 0.582/0.518/0.736/0.547，印刷误删 0.0007~0.0049
  //     bbox 口径（本版）  ：黑笔去除 0.661/0.650/0.736/0.671，印刷误删 0.0002~0.0014
  //   原因：小域的 bbox 相对自身更大，bbox 口径给了小域（多为黑笔散笔画）更高的
  //   通过率，而印刷域主体在菱形外，两种口径都拦得住，故更宽松的那个白赚召回。
  //   **看似 bug 的实现若数据更优，就把数据写在旁边**——否则下一个人一定会"修好"它。
  const { comps } = connectedComponents(ink, w, h, false)
  const out = Buffer.alloc(n)
  let penPx = 0
  let keptDomains = 0
  let droppedDomains = 0
  for (const c of comps) {
    let inR = 0
    for (let y = c.y0; y <= c.y1; y++) {
      const b = y * w
      for (let x = c.x0; x <= c.x1; x++) if (region[b + x]) inR++
    }
    const ratio = inR / c.n
    if (ratio < minDomainRatio) { droppedDomains++; continue }
    keptDomains++
    for (let y = c.y0; y <= c.y1; y++) {
      const b = y * w
      for (let x = c.x0; x <= c.x1; x++) if (ink[b + x] && region[b + x]) { out[b + x] = 255; penPx++ }
    }
  }

  if (penPx === 0) return empty('no_ink_domain_in_region')

  return {
    data: out,
    coverage: penPx / n,
    penPx,
    inkInRegionPx: inkInRegion,
    redPx,
    reason: `ok(kept:${keptDomains},dropped:${droppedDomains})`,
  }
}
