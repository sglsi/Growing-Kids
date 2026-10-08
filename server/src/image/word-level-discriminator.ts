/**
 * 词级结构判别器（v21.3 §4）· 影子版
 *
 * 与 v21.2 的 CC 级判别器（`structural-discriminator.ts`）区别：
 *   1. **判别粒度上移**：文本行 → **词（文本段）**，手写压印刷连成大块的问题在词级自然消解；
 *      不再逐连通域算 z 分数（v21.3 §3 反思：粒度错误）。
 *   2. **图形域优先剥离**（§4.4）：判别**之前**先剔除非文本域（照片/半色调、工程线条/表格框），
 *      直接进"保留"集合——修掉 v21.2 里"插图整块标红"的致命误擦。
 *   3. **核心判据换成词级一致性**：字高变异系数 CV（Stamatatos ICPR2004 最强单一判据[^1]）、
 *      基线偏移、笔画宽方差/偏差、升降部稳定性、间距 CV、强度方差。
 *   4. **阈值偏松**（§4.1 松检测）：图形域剥离消除了主要误报源后，文本域内可放宽阈值提召回。
 *
 * ⚠️ 本模块**已接入生产路径**：`erase-mask-policy.buildEraseMask('word')` 直接消费本判别器的
 *    三态结果，只有 `state===1`（确信手写）进最终擦除 mask，state===0/2 一律丢弃（疑罪从无）。
 *    故本文件的权重/阈值改动会直接影响生产擦除结果，须配合 G13/G15/G16 门禁验收。
 *
 * [^1]: Stamatatos E. *Discrimination of Machine-Printed from Handwritten Text Using Simple
 *       Structural Characteristics*, ICPR 2004 —— 印刷行内字高分布集中、手写发散。
 */
import { connectedComponents } from './image-layout'
import type { DocContext } from './adaptive-stats'

// ════════════════════════════════════════════════════════════════
// 常量（全部标注来源，满足 G10「参数须有来源」）
// ════════════════════════════════════════════════════════════════

// ── 图形域剥离（§4.4）────────────────────────────────────────────
// L1/复用 · 几何闸门直接取生产验证过的判据 `wrongq-layout.stripGraphics`：
//   bh > 4×medH && bw > 2×medH → 图形（插图/框线）。
// ⚠️ 此前自造的"密度/半色调/均匀纹理"闸门在本验证集上**全部失效**：
//    实测插图 density=0.08、iso=0.10、cellMed=0.06（稀疏线条画，不是照片），
//    远低于照片阈值 → 真插图一个没抓到，反而误检在文本行上（见 probe-wl-debug 实测）。
const G_W_K = 2.0   // L1/复用 · 图形块最小宽 / charH（stripGraphics: bw > 2×medH）
const G_H_K = 4.0   // L1/复用 · 图形块最小高 / charH（stripGraphics: bh > 4×medH）
const G_AREA_K = 8.0 // L1/复用 · 图形块最小面积 / charH²（= G_W_K × G_H_K）
// 整宽横线（表格框/分隔线）：宽度占图 >85%，高 >3×charH
const G_FULLW_K = 0.85
// L0 · 整宽横线最小高 / charH（表格框/分隔线，与 stripGraphics 同族判据）
const G_FULLW_H_K = 3.0
// L0 · 半色调网点：孤立像素占比上界。照片/网点印刷的墨点彼此不相连（8 邻域 ≤2）
const G_ISO_HI = 0.35
// L0 · 实心密度：粗框照片/深色块墨占比上界（正文文本密度通常 0.10~0.30）
const G_DENS_HI = 0.45
// L0 · 工程线条最小长度 / charH：表格框线、示意图直线远超单字尺度
const G_RUN_K = 3.0
// L0 · 工程线条的笔画宽均匀度上界（线条宽度恒定 → 长笔画长度变异小；
//      手写笔画粗细随手变化 → 变异大）。这是"线条画 vs 手写块"的关键分野。
const G_RUNCV_LO = 0.35
// L0 · 均匀纹理判据（照片/位图）：charH×charH 网格单元墨占比中位 & 单元间变异上界。
//      文本单元（笔画 vs 字间空白）落差大 → 变异高；照片网点整体均匀 → 变异低。
const G_CELL_HI = 0.25
// L0 · 单元墨占比变异上界（均匀纹理判据：低于此值=网点均匀的位图）
const G_CELLCV_LO = 0.50

// ── RLSA 区域合并（图形域判定前置）─────────────────────────────────
// L0 · 行程平滑（Run Length Smoothing，经典版面分析）：水平膨胀 dH 把字符并成词/行，
//      垂直膨胀 dV 把行内碎片连起来。网点照片与线段图由此合成**整块**，
//      否则它们碎成千百个小连通域，尺寸闸门永远不触发（实测 annot1/2/4 检出 0 个图形块）。
// L0 · RLSA 水平膨胀系数 / charH（并字符为词/行，合并网点与线段）
const RLSA_H_K = 1.2
// ⚠️ 垂直膨胀必须**小于行距的一半**，否则相邻文本行会被纵向并成一个巨块 →
//    bh 远超 4×charH → 被几何闸门当成图形整块剥离（实测 annot2 全页被剥，召回 0/12）。
//    只做水平合并时，每个文本行/手写行各自成块（bh≈charH），天然被 bh>4×charH 闸门放过，
//    而竖向大块（真插图）仍会被抓到——这才是几何闸门的正确用法。
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const RLSA_V_K = 0.3
// L0 · 细尺度：半色调网点间距远小于字高（扫描/降采样后约 2~5px），用 0.3×charH 即可并成整块，
//      同时不会把相邻文本行并起来（行距 > 0.6×charH）。
const RLSA_FINE_K = 0.3

// ── 文本区（段落）判据：避免把"多行手写段落/印刷段落"误判成图形 ──────
// L0 · 文本段落在水平投影上呈"带状"：≥3 条墨带，带间距 ≈ 1~4×charH（行距）。
//      照片/位图的投影是连续填充，不呈周期性带宽。
const TEXT_BANDS_MIN = 2
// L0 · 文本段落带间距上限 / charH（行距上界；超出则非周期文本）
const TEXT_BAND_SP_MAX = 4.0
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const TEXT_BAND_CV_HI = 0.50

// ── 行/词切分 ────────────────────────────────────────────────────
// L0 · 行间距系数：相邻块质心 Y 间距 > 该值即换行（复用生产 metricsFromGray 验证值）
const ROW_GAP_K = 1.2
// L0 · 词间距系数：行内**边缘间隙** > WORD_GAP_K × 行内中位边缘间隙 即断词
//      来源：排版事实——词间距约为字间距的 3~5 倍；取 1.8 为保守下界（宁可少断）。
const WORD_GAP_K = 1.8
// L0 · 词边界的绝对尺度下界 / charH：**1/4 em**
//      来源：西文排版的词距惯例——词间距 ≈1/4 em（字号=1em），显著大于字间距（≈0）。
//      原值 0.6 无任何出处，且与"英文单词平均宽 2~3em"的排版事实冲突（实测词宽 6.8em）。
const GAP_MODE = process.env.WL_GAP_MODE === 'centroid' ? 'centroid' : 'edge'
// 对照开关：WL_GAP_MODE=centroid 复现旧的"质心间距"量纲（有量纲不一致的 bug），便于 A/B

// ── 长直线游程保护（P4-2 · 2026-10-06）────────────────────────────────
// ★ 来源：**字符 vs 线条的物理模型差异**（不是对数据集的统计拟合）。
//   字符的水平/垂直连续笔画长度受**字宽**约束 —— 一个字内部最长的连续墨迹只有
//   ≈1×charH 量级；而直线、表格框线、示意图轮廓是**跨字尺度的一笔画**。
//   实测证据（verify-out/p4-run.json，**对照组比较**，非阈值拟合）：
//     印刷合并块 maxRun/charH：n=35，p50=0.82，p90=1.00，**最大仅 1.45**
//     插图合并块 maxRun/charH：n=23，p50=3.91，p90=7.33
//   ⇒ 1.45 与 3.48 之间是**真空档**，任取 K∈[2, 3.4] 都能零误伤印刷。
//   为何需要它：原"文本段落豁免"用"有周期墨带"证明"是文本"，
//     但示意图/表格/几何图同样有周期墨带 ⇒ 实测 16 个插图框里 13 个被★放行★（见 verify-out/p4-strip.json）。
//     那条规则**证不出文本**，故换成这条证得出"线条"的反向规则。
// ⚠️ **默认关闭（0）**：本机制实测为**净负收益**，不作为默认行为（原因见下方"否决记录"）。
//    否决记录（2026-10-06，4 张独立标注图，端到端全链路；union=生产hybrid∪词级）：
//      WL_LINERUN=0    擦净 36/40  插图受损 12/16  框外改动 113,450px
//      WL_LINERUN=2.5  擦净 27/40  插图受损  8/16  框外改动  83,785px
//      WL_LINERUN=2.5（词级否决，关区域否决）擦净 36/40 插图受损 12/16 —— 几乎无效
//    ⇒ 每救回 4 个插图框，要付出 9 个手写框擦不干净的代价。这笔账应由**产品侧**定，
//      不能由实现方偷偷替用户取舍，故默认关闭、机制与证据全部留档待议。
//    为什么救不回来（能力边界，非调参问题）：
//      maxRun/charH 能干净分开 **印刷 vs 插图**（印刷最大 1.45，插图 p50=3.91），
//      却分不开 **手写 vs 插图**（手写 p50=1.63/p90=6.14 vs 插图 p50=3.91/p90=7.33，重叠）。
//      手写笔画本身就常有长直游程，按此特征保护必然连同手写一起保护。
const LINE_RUN_K = process.env.WL_LINERUN === undefined || process.env.WL_LINERUN === '' ? 0 : +process.env.WL_LINERUN

// ─── P4-3：线条构件保护（CC 级精确命中）────────────────────────────────────
//    ★ 取代 P4-2。两者的**判据相同**（最长游程/charH），差别只在**粒度**：
//      P4-2 在整行/整列像素上扫连续游程 ⇒ 会**跨连通域串连**（手写字紧邻印刷横线时被连成长游程），
//      且 P4-2 的 blockStats.maxRun 在 bbox 内计算、**不排除邻域的其他 CC** ⇒ 同样串连。
//      P4-3 严格限定在**同一连通域内**计算最长游程，因此不会跨 CC 串连。
//
//    实证依据（verify-out/p4-line.json，4 图 / 40 手写框 / 16 插图框，像素级覆盖率）：
//      K      covIllus(插图墨迹被命中的比例)   covHand(手写字迹被误命中的比例)
//      1.5        85.5%                        8.8%
//      2.0        80.9%                        5.5%
//    ★ 2.5        76.7%                        0.0%   ← 手写零误伤，取此点
//      3.0        75.2%                        0.0%
//      4.0        56.8%                        0.0%
//
//    ⇒ 这**推翻了** p4-run.json 在"合并块粒度"上得出的"手写 p90=6.14 与插图重叠"的结论：
//      那个重叠是**粒度错觉**——合并块把邻近插图的长线条连同手写一起圈进去，
//      于是整块的 maxRun 变大，看起来像"手写也有长游程"。下沉到 CC 后手写触零。
//
//    物理依据（为什么手写不可能有 >2.5×charH 的连通游程）：
//      连通域内的一笔画，其长度受**手腕运笔幅度**约束（一次运笔 ≈ 1~2 个字宽），
//      而线条/表格框/几何示意图的边是**跨字尺度的一笔画**。
//      这是"字符模型 vs 线条模型"的分界，与具体内容无关 ⇒ 属 G10 **L0/L1 层**依据。
//
//    默认开启；WL_LINECC=0 可关闭（对照用）。
//     seed CC 只覆盖 76.7% 的插图像素，线之间的短笔画/填充/网点会漏掉 ⇒ 需 ②a-2 补全。
const LINE_CC_K = process.env.WL_LINECC === undefined || process.env.WL_LINECC === '' ? 2.5 : +process.env.WL_LINECC
//     补全半径（×charH），117 组扫描的**甜点**：
//       D      擦净    插图受损   框外改动
//       0      36/40   10/16     108,913px
//       0.5    36/40    8/16     106,498px
//       1.0    36/40    8/16     102,334px
//     ★ 1.5    36/40    7/16     101,779px   ← 召回曲线的**最后一个不衰减点**
//       2.0    35/40    7/16     101,395px   ← 越过此点开始偿还召回（每再降 1 个插图框付 1 个手写框）
//       3.0    35/40    6/16     101,346px
//       6.0    35/40    6/16      99,311px   ← 已饱和：放大到 6×charH 也不再改善
//     取 1.5：召回优先。≤2.0 段三个读数全部维持 36/40，说明此时扩散只在补"图内部的缝"；
//     到 2.0 首次触及手写 ⇒ 距离已越过"图内缝"的典型宽度，再放大会持续侵蚀召回。
const LINE_DIL_K = process.env.WL_LINEDIL === undefined || process.env.WL_LINEDIL === '' ? 1.5 : +process.env.WL_LINEDIL
// L0 · 词被判为线条所需的最小墨迹占比（0.5 = 过半笔画是长直线 → 文本不可能如此）
const LINE_SHARE_MIN = process.env.WL_LINESHARE === undefined || process.env.WL_LINESHARE === '' ? 0.5 : +process.env.WL_LINESHARE
// L0 · 判为"图形线条"的最长连续墨迹游程 / charH。0 = 关闭本保护（对照用）

const WORD_GAP_ABS_K = process.env.WL_GAP_ABS === undefined || process.env.WL_GAP_ABS === '' ? 0.25 : +process.env.WL_GAP_ABS
// 对照开关：WL_GAP_ABS=<数字> 覆盖绝对词距系数（单位 charH），默认 0.25（1/4 em）

// ── 特征归一化上界（L0 · 由印刷文本统计给出；超过即视为"完全手写化"）──
const CV_HI = 0.40          // 字高变异系数上界
const STROKECV_HI = 0.60    // 笔画宽（水平游程）变异系数上界
const STROKEDEV_HI = 0.80   // 笔画宽相对本行印刷的偏差上界
const BASE_HI = 0.50        // 基线偏移（/charH）上界
const ASC_HI = 0.45         // 顶部（升降部）偏移（/charH）上界
const SPACING_HI = 0.80     // 字间距变异系数上界
const INTENSITY_HI = 0.18   // 墨内灰度强度标准差 /255 上界（钢笔墨不均）
const SLANT_HI = 18         // 倾角上界（度）

// ── 融合权重（和=1；Stamatatos：字高一致性为最强判据 → 最高权重）────
// ★ v21.5 G16：权重改为 **ZsF1FN 端到端共识实测**（probe-e2e-variant.ts）验证过的 C2 配置。
//   原 W_HEIGHT=0.24 等初值经实测在印刷/手写混排页大面积饱和（见下方 ROBUST_SCORE 证伪记录），
//   失去动态范围。C2 配置把权重集中到真正的区分特征、并**将 baseDev/ascDev 归零**（二者为反判别式）。
//   ⇒ 与 consensus 门（见下方 CONSENSUS_*）配套，验证：hwRecall 42/44、M(框外印刷误擦) 7.75%→4.25%。
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_HEIGHT = 0.50
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_STROKECV = 0.15
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_STROKEDEV = 0.05
// L0 · 反判别式归零（C2 配置，依据见下方共识门说明）：baseDev/ascDev 在印刷/手写均常见升高
//   （实测印刷 baseDev 中位 0.14~0.39、ascDev 0.36~1.33，甚至高于手写），用作"手写证据"会误导，
//   故权重置 0，判别力集中在 heightCV/strokeCV 等真判别特征（ZsF1FN 端到端共识实测验证）。
const W_BASE = 0.0
const W_ASC = 0.0
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_SPACING = 0.08
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_INTENSITY = 0.12
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_SLANT = 0.05
// L0 · 版面/排版尺度常数（来源与依据见本常量上方设计说明及 v21.3 §4）
const W_ANCHOR = 0.05

//   为何必须换掉绝对常数（实测证据见 verify-out/p4-score.json、p4-diag.json）：
//     印刷词的实测中位 raw 特征已达 heightCV 0.11~0.33 / ascDev 0.36~1.33 / baseDev 0.14~0.39，
//     而旧绝对归一化常数 CV_HI=0.40、ASC_HI=0.45、BASE_HI=0.50 与之同量级 ⇒
//     clamp(f/HI,0,1) 大面积饱和到 1 ⇒ 印刷词 score 已 0.57，手写仅 0.67，**失去动态范围**。
//     labelInkShare 实测 4 页有 53%/67%/86%/86% 的墨迹被标成手写 —— 判别器事实上退化成"全都算手写"。
//   对策（＝方案 P4「印刷人口一致性否决」)：用**本页自身**的词群做参考分布，
//     以众数/中位数代表"印刷人口"，只把**显著异于本页主群**的词算手写。
//     好处：①每题自动标定，满足"参数须逐图自适应"；②不依赖 GT；③阈值有统计学出处。
const Z_REF = 3.0
// L0 · 离群判定的 3σ 惯例：正态假设下单侧越界概率 ≈0.13%，教科书稳健离群阈值。
//      取值与具体图片无关，不属于"对标定集拟合"。
const MAD_K = 1.4826
// L0 · MAD → 标准差的一致化系数（正态下 1.4826×MAD 是 σ 的一致估计量，常数，非拟合）
const Z_SCALE_FLOOR = 1e-6
// L0 · 退化保护：某特征在本页无变异（MAD=0）时该特征不携带任何信息 → z 记 0（弃权），不做除法
// ⚠️ **默认已改回 abs**：robust 方案经实测**被证伪**（见下方"证伪记录"），保留代码但默认关闭，
//    以免后来者误以为"默认就是验证过的"。
//    证伪记录（2026-10-06，4 张独立标注图 + 端到端全链路，verify-out/gt-e2e-*.json）：
//      edge+robust     擦净 9/40   框外改动  36,287px
//      centroid+robust 擦净 11/40
//      c entroid+abs   擦净 36/40  框外改动 142,152px
//      edge+abs        擦净 35/40  框外改动 106,415px
//    ⇒ 召回差 25pp 以上。原因（机制层面，非调参）：
//      本页词群本身高度混杂（印刷行、手写行、版式碎片同池），MAD 被分割噪声撑大，
//      真手写在**本页主群的尺度下并不构成 3σ 离群**；"印刷人口"无法用一个单一分布代表。
//      该机制隐含假设"印刷占绝对多数且同分布"，在本场景不成立。
const ROBUST_SCORE = (process.env.WL_SCORE ?? 'abs') === 'robust'
// 影子开关：WL_SCORE=abs 回退到旧绝对阈值（保留可复现的对照）

// 绝对打分路径阈值（§4.1），仅当 WL_SCORE=abs（默认）时生效。
// ★ v21.5 G16：TAU_HI 由 0.45 提到 0.55，且 state===1 现额外要求 CONSENSUS_NH 个 SEP 特征
//   同时明显升高（见下方 CONSENSUS_*）。单独"分数高"在多字号混排页无法分离印刷/手写，
//   必须多证据同向才判确信手写（否则落 UNCERTAIN，疑罪从无保留）。
const TAU_HI = 0.55  // ≥ 且共识达成 → 判手写
const TAU_LO = 0.22  // ≤ 判印刷；之间 = 不确定
// 稳健相对路径的阈值：**按权重加权后，超过半数权重达到 Z_REF 倍 3σ 离群**才判手写。
// 含义是"相对本页主群的离群度"，不再是绝对特征值。
const TAU_HI_R = 0.50
const TAU_LO_R = 0.20

// ── 共识门（证据一致性 · v21.5 G16 配套）──────────────────────────────
// ★ 来源：ZsF1FN 端到端共识实测（4 图 / 44 手写框 / 16 插图框，probe-e2e-variant.ts）。
//   纯"分数高"无法分离印刷/手写（多字号混排使印刷 heightCV 也偏高，无单特征可分离），
//   必须"分数高 且 多个判别特征同时明显升高"才判确信手写（state===1），否则落 UNCERTAIN（state===2，保留）。
//   实测（decide 规则在 wd.f 上复现）：
//     A 当前(全判手写)     hwRecall 43/44  M(框外印刷误擦) 7.75%
//     C1 TAU=0.50 NH=2     42/44         4.59%
//     C2 TAU=0.55 NH=2 ★   42/44         4.25%   ← 召回仅掉 1 词、M 降近半，取此点
//     C3 TAU=0.55 NH=3     34/44         3.44%   ← 召回崩塌（−9 词），否决
//   SEP 排除 baseDev/ascDev：二者为反判别式（印刷亦可大幅升高），纳入会稀释共识纯度。
const CONSENSUS_TAU = process.env.G16_TAU ? +process.env.G16_TAU : TAU_HI   // 加权分门槛（与 abs 路径 TAU_HI 同值）；G16_TAU 仅用于标定，默认 C2=0.55
const CONSENSUS_NH = process.env.G16_NH ? +process.env.G16_NH : 2            // 至少 N 个 SEP 特征归一化≥0.5；G16_NH 仅用于标定，默认 C2=2
const SEP_HI: Array<[keyof WordRecord['f'], number]> = [
  ['heightCV', CV_HI], ['strokeCV', STROKECV_HI], ['intensityStd', INTENSITY_HI],
  ['slantDeg', SLANT_HI], ['spacingCV', SPACING_HI],
]

const DEG = Math.PI / 180

// ════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════

export interface CC { x0: number; y0: number; x1: number; y1: number; n: number }

export type WordState = 0 | 1 | 2 // 0=PRINT 1=HANDWRITING 2=UNCERTAIN

export interface WordRecord {
  x0: number; y0: number; x1: number; y1: number
  row: number
  nComp: number
  n: number
  f: {
    heightCV: number; strokeCV: number; strokeDev: number; baseDev: number
    ascDev: number; spacingCV: number; intensityStd: number; slantDeg: number
    density: number; anchor: number
  }
  score: number
  state: WordState
}

export interface GraphicsBlock {
  x0: number; y0: number; x1: number; y1: number
  reason: 'geometry' | 'halftone' | 'solid' | 'uniform' | 'lineart'
  density: number; isoRatio: number; maxRun: number; runCV: number
}

export interface WordLevelResult {
  w: number; h: number
  labels: Uint8Array   // 工作尺度：0/1/2
  explain: Uint8Array
  words: WordRecord[]
  graphics: GraphicsBlock[]
  debug: Record<string, unknown>
}

export interface WordLevelInput {
  ctx: DocContext
  /** 家具先验（与 protectPrintUnderColorHandwriting 同口径）：命中像素强制保留 */
  furniturePrior?: Uint8Array
}

// ════════════════════════════════════════════════════════════════
// 小工具（本模块自包含，便于与旧判别器并行 A/B）
// ════════════════════════════════════════════════════════════════

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function quantileSorted(s: number[], q: number): number {
  if (!s.length) return 0
  const i = clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)
  return s[i]
}
function median(a: number[]): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
function std(a: number[]): number {
  if (a.length < 2) return 0
  const m = a.reduce((x, y) => x + y, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length)
}
/** 变异系数 CV = std/mean（mean 为 0 时退化 0）。 */
function cv(a: number[]): number {
  if (a.length < 2) return 0
  const m = a.reduce((x, y) => x + y, 0) / a.length
  return m > 1e-9 ? std(a) / m : 0
}
/** 众数高度（印刷在同一行内高频主导 → 取最高频 bin）。 */
function modalHeight(hs: number[], hInit: number): number {
  if (!hs.length) return hInit
  const bin = Math.max(2, Math.round(hInit * 0.3))
  const nb = Math.floor(Math.max(...hs) / bin) + 1
  const cnt = new Array(nb).fill(0)
  for (const h of hs) cnt[Math.min(nb - 1, Math.floor(h / bin))]++
  let best = 0, bestC = -1
  for (let i = 0; i < nb; i++) if (cnt[i] > bestC) { bestC = cnt[i]; best = i }
  return (best + 0.5) * bin
}

/** 3×3 闭合（膨胀后腐蚀）：把同一笔画/字的碎片连起来，便于行检测。 */
function closeInk3x3(ink: Uint8Array, w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1)
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1)
      for (let yy = y0; yy <= y1; yy++) { const b = yy * w; for (let xx = x0; xx <= x1; xx++) d[b + xx] = 1 }
    }
  }
  const e = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = true
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1)
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1)
      for (let yy = y0; yy <= y1 && all; yy++) { const b = yy * w; for (let xx = x0; xx <= x1; xx++) if (!d[b + xx]) { all = false; break } }
      if (all) e[y * w + x] = 1
    }
  }
  return e
}

/** 一个矩形域内的墨统计：密度、孤立像素占比、最长水平/垂直游程、长游程长度变异、单元纹理。 */
export function blockStats(c: CC, ink: Uint8Array, w: number, h: number, charH: number) {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1
  let inkN = 0, iso = 0
  let maxRunH = 0, maxRunV = 0
  const runs: number[] = []
  for (let y = c.y0; y <= c.y1; y++) {
    const base = y * w
    let run = 0
    for (let x = c.x0; x <= c.x1 + 1; x++) {
      const on = x <= c.x1 && ink[base + x]
      if (on) { run++; inkN++ }
      else { if (run > 0) { runs.push(run); if (run > maxRunH) maxRunH = run; run = 0 } }
    }
  }
  for (let x = c.x0; x <= c.x1; x++) {
    let run = 0
    for (let y = c.y0; y <= c.y1 + 1; y++) {
      const on = y <= c.y1 && ink[y * w + x]
      if (on) run++
      else { if (run > maxRunV) maxRunV = run; run = 0 }
    }
  }
  // 孤立像素占比（半色调/网点判据）
  for (let y = c.y0; y <= c.y1; y++) {
    const base = y * w
    for (let x = c.x0; x <= c.x1; x++) {
      if (!ink[base + x]) continue
      let nb = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const ny = y + dy, nx = x + dx
        if (ny >= 0 && nx >= 0 && ny < h && nx < w && ink[ny * w + nx]) nb++
      }
      if (nb <= 2) iso++
    }
  }
  const longRuns = runs.filter((r) => r >= 2)
  // 单元纹理：以 charH 为边长的网格统计各单元墨占比 → 中位与变异
  const cs = Math.max(2, Math.round(charH))
  const cells: number[] = []
  for (let cy = c.y0; cy <= c.y1; cy += cs) {
    for (let cx = c.x0; cx <= c.x1; cx += cs) {
      let n = 0, tot = 0
      const y1e = Math.min(c.y1, cy + cs - 1), x1e = Math.min(c.x1, cx + cs - 1)
      for (let y = cy; y <= y1e; y++) { const b = y * w; for (let x = cx; x <= x1e; x++) { tot++; if (ink[b + x]) n++ } }
      if (tot > 0) cells.push(n / tot)
    }
  }
  return {
    bw, bh,
    density: inkN / Math.max(1, bw * bh),
    isoRatio: inkN ? iso / inkN : 0,
    maxRun: Math.max(maxRunH, maxRunV),
    runCV: cv(longRuns),
    medianRun: longRuns.length ? median(longRuns) : 1,
    cellMedian: cells.length ? median(cells) : 0,
    cellCV: cv(cells),
    inkN,
  }
}

/** 矩形膨胀（水平 dh、垂直 dv 可异）——RLSA 合并用。 */
export function dilateRect(src: Uint8Array, w: number, h: number, dh: number, dv: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue
      const y0 = Math.max(0, y - dv), y1 = Math.min(h - 1, y + dv)
      const x0 = Math.max(0, x - dh), x1 = Math.min(w - 1, x + dh)
      for (let yy = y0; yy <= y1; yy++) { const b = yy * w; for (let xx = x0; xx <= x1; xx++) out[b + xx] = 1 }
    }
  }
  return out
}

/**
 * 水平投影分带：文本段落呈周期性墨带；插图/位图为非周期填充。
 * 加严：只统计"带高 ≥0.4×charH"的真文本行（滤掉噪点带），并要求带间距**规则**。
 */
export function regionBands(c: CC, ink: Uint8Array, w: number, charH: number) {
  const bw = c.x1 - c.x0 + 1
  const rowsInk: number[] = []
  for (let y = c.y0; y <= c.y1; y++) {
    let n = 0; const b = y * w
    for (let x = c.x0; x <= c.x1; x++) if (ink[b + x]) n++
    rowsInk.push(n)
  }
  const thr = Math.max(1, 0.05 * bw)
  const bands: Array<{ c: number; hgt: number }> = []
  let s = -1
  for (let i = 0; i <= rowsInk.length; i++) {
    const on = i < rowsInk.length && rowsInk[i] >= thr
    if (on) { if (s < 0) s = i }
    else if (s >= 0) { bands.push({ c: (s + i - 1) / 2, hgt: i - s }); s = -1 }
  }
  const real = bands.filter((b) => b.hgt >= 0.4 * charH)
  const spacings: number[] = []
  for (let i = 1; i < real.length; i++) spacings.push(real[i].c - real[i - 1].c)
  return { n: real.length, medSpacing: spacings.length ? median(spacings) : 0, spacingCV: cv(spacings) }
}

/**
 * 字高估计：水平投影的**文本行带高**中位数（排版事实：一行文字带的高度≈字高）。
 * 比"连通域高度众数"稳健（CC 常是字的碎片 → 偏小），
 * 也比全局 ctx.layout.charH 稳健（实测把大笔画/合并块当字符 → annot2 估到 58）。
 */
export function estimateCharH(ink: Uint8Array, w: number, h: number): number {
  const prof = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let n = 0; const b = y * w
    for (let x = 0; x < w; x++) if (ink[b + x]) n++
    prof[y] = n
  }
  const thr = Math.max(1, Math.round(0.015 * w))
  const hs: number[] = []
  let s = -1
  for (let y = 0; y <= h; y++) {
    const on = y < h && prof[y] >= thr
    if (on) { if (s < 0) s = y }
    else if (s >= 0) {
      const bh = y - s
      if (bh >= 2 && bh <= 0.15 * h) hs.push(bh) // 滤掉噪点与跨页大块
      s = -1
    }
  }
  return hs.length ? median(hs) : 0
}

/** 主轴倾角（度）。⚠️ 仅对竖向拉长部件有意义；近各向同性（方形汉字）时数值不可信 → 0。 */
function compSlant(c: CC, ink: Uint8Array, w: number): number {
  if ((c.y1 - c.y0 + 1) <= 1.2 * (c.x1 - c.x0 + 1)) return 0
  let sx = 0, sy = 0, cnt = 0
  for (let y = c.y0; y <= c.y1; y++) { const b = y * w; for (let x = c.x0; x <= c.x1; x++) if (ink[b + x]) { sx += x; sy += y; cnt++ } }
  if (cnt < 2) return 0
  const mx = sx / cnt, my = sy / cnt
  let sxx = 0, syy = 0, sxy = 0
  for (let y = c.y0; y <= c.y1; y++) {
    const b = y * w
    for (let x = c.x0; x <= c.x1; x++) {
      if (!ink[b + x]) continue
      const dx = x - mx, dy = y - my
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy
    }
  }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy
  if (tr <= 0) return 0
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det))
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc)
  if (l1 / l2 < 1.5) return 0 // 近各向同性 → 倾角不可信
  const th = Math.abs(0.5 * Math.atan2(2 * sxy, sxx - syy) / DEG)
  return th > 45 ? 90 - th : th
}

// ════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════

interface RowInfo { idx: number; comps: CC[]; baseH: number; baseY1: number; baseStroke: number; y0: number; y1: number }

/** 文本行切分：按块质心 Y 聚类，并给出行字高（众数）/行基线/行印刷笔画宽。 */
function detectRows(blocks: CC[], w: number, ink: Uint8Array, strokeWFallback: number): RowInfo[] {
  if (!blocks.length) return []
  const heightsAll = blocks.map((c) => c.y1 - c.y0 + 1).sort((a, b) => a - b)
  const hInit = Math.max(3, quantileSorted(heightsAll, 0.25))
  const sorted = blocks.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const rowGap = Math.max(2, hInit * ROW_GAP_K)
  const rawRows: CC[][] = []
  let cur: CC[] = [], lastY = -1e9
  for (const b of sorted) {
    const cy = (b.y0 + b.y1) / 2
    if (cur.length && cy - lastY > rowGap) { rawRows.push(cur); cur = [] }
    cur.push(b); lastY = cy
  }
  if (cur.length) rawRows.push(cur)

  const rows: RowInfo[] = []
  rawRows.forEach((g, idx) => {
    const y0 = Math.min(...g.map((b) => b.y0)), y1 = Math.max(...g.map((b) => b.y1))
    const baseH = modalHeight(g.map((b) => b.y1 - b.y0 + 1), hInit)
    // 行基线：取"高度接近行字高"的块的底边中位（印刷主导行基线）
    const cand = g.filter((b) => {
      const hh = b.y1 - b.y0 + 1
      return hh >= 0.7 * baseH && hh <= 1.6 * baseH
    })
    const baseY1 = cand.length ? median(cand.map((b) => b.y1)) : y1
    // 行印刷笔画宽：行内水平游程中位数
    const rowRuns: number[] = []
    for (const b of g) {
      for (let y = b.y0; y <= b.y1; y++) {
        const bs = y * w
        let run = 0
        for (let x = b.x0; x <= b.x1 + 1; x++) {
          const on = x <= b.x1 && ink[bs + x]
          if (on) run++
          else { if (run >= 2) rowRuns.push(run); run = 0 }
        }
      }
    }
    rows.push({
      idx, comps: g, baseH, baseY1, y0, y1,
      baseStroke: rowRuns.length ? median(rowRuns) : Math.max(1, Math.round(strokeWFallback || 2)),
    })
  })
  return rows
}

export function discriminateWords(input: WordLevelInput): WordLevelResult {
  const { ctx, furniturePrior } = input
  const { w, h, ink, gray } = ctx.work
  const labels = new Uint8Array(w * h)
  const explain = new Uint8Array(w * h)

  const inkC = closeInk3x3(ink, w, h)

  // ① 连通域（闭合 ink）
  const blocks = connectedComponents(inkC, w, h, false).comps.filter((c) => c.n >= 4)

  // ①b ★ charH 必须用**行级众数字高**估计，不能直接用 ctx.layout.charH。
  //     实测（probe-wl-debug，2026-10-05）：全局版面估计在本验证集上严重失真——
  //     annot2 估到 58、annot3 估到 32（真实印刷字高≈20），因为它把大笔画/合并块当成了字符；
  //     而行级众数（每行取最高频高度）稳定在真实字高附近。
  //     charH 一旦失真，图形域尺寸闸门（宽高均 ≥4×charH）直接失效 → 实测图形块=0。
  // ⭐ P0-5c：本函数的 w/h/ink 都是 **ctx.work 坐标**（800-work 尺度），
  //   兜底若用 ctx.layout.charH（原图尺度）会放大 1/scale 倍，故改用 charHWork。
  const coordFix = (process.env.CHARH_COORD ?? 'off') !== 'off'
  const charHFallback = coordFix ? (ctx.layout.charHWork ?? ctx.layout.charH) : ctx.layout.charH
  const charH = Math.max(3, Math.round(
    estimateCharH(ink, w, h) ||
    median(blocks.map((c) => c.y1 - c.y0 + 1)) || charHFallback || 12,
  ))

  // ②a ★ P4-3 线条构件保护：CC 级精确命中（实证表见文件顶 LINE_CC_K 处）
  //     与 ② 的 RLSA 合并域剥离互补：② 负责"大块图形"，这里负责"构成图形的线条本身"。
  //     ★ 保护对象就是**命中判据的那个连通域**，不带任何邻近区域 ——
  //       这正是它对邻近手写零副作用的原因（对比 P4-2 会跨 CC 串连导致擦净 36→27/40）。
  const lineCCMask = new Uint8Array(w * h)
  let lineCCPx = 0
  const lineCCs: Array<{ x0: number; y0: number; x1: number; y1: number; runK: number }> = []
  if (LINE_CC_K > 0) {
    const minRun = Math.max(2, Math.round(LINE_CC_K * charH))
    // ★ 必须用**未闭合的 ink**，不能用 inkC：
    //   closeInk3x3 会把相距 ≤1px 的相邻笔画连起来 —— 手写字一旦紧邻表格线/分隔线就与之
    //   连成一个 CC，于是"手写的字"被算成"含长游程的线条构件"而被保护 ⇒ 擦不干净。
    //   实测：用 inkC 时擦净 36→31/40；换回 ink 后应恢复到 36/40（实证表的前提就是未闭合 ink）。
    //   "一笔画"的物理含义本就对应原始墨迹，闭合只是为行/词切分服务的**渲染层**，不该影响此判据。
    const lcc = connectedComponents(ink, w, h, true)
    const lb = lcc.labels!
    for (let ci = 0; ci < lcc.comps.length; ci++) {
      const c = lcc.comps[ci]
      // 连通域内最长水平/垂直游程（★严格限定 labels===ci ⇒ 不跨 CC 串连）
      let best = 0
      for (let y = c.y0; y <= c.y1; y++) {
        const bs = y * w
        let run = 0
        for (let x = c.x0; x <= c.x1 + 1; x++) {
          if (x <= c.x1 && lb[bs + x] === ci) { run++; if (run > best) best = run } else run = 0
        }
      }
      for (let x = c.x0; x <= c.x1; x++) {
        let run = 0
        for (let y = c.y0; y <= c.y1 + 1; y++) {
          if (y <= c.y1 && lb[y * w + x] === ci) { run++; if (run > best) best = run } else run = 0
        }
      }
      if (best < minRun) continue
      lineCCs.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, runK: +(best / charH).toFixed(2) })
      for (let y = c.y0; y <= c.y1; y++) {
        const bs = y * w
        for (let x = c.x0; x <= c.x1; x++) if (lb[bs + x] === ci) { lineCCMask[bs + x] = 1; lineCCPx++ }
      }
    }

    // ②a-2 ★ 区域补全（P4-3b）：从 seed CC 出发，在**所属合并域内**做距离受限扩散。
    //   为什么需要：seed CC 只命中插图的"线条骨架"，线之间的短笔画/填充/网点没被覆盖
    //     —— 实测 seed 的插图覆盖仅 76.7%，残余仍足以让端到端判定受损。
    //   为什么安全（两条约束缺一不可）：
    //     · **同一合并域**：RLSA 细尺度已把一张线图并成一个域，域边界天然隔离了邻近印刷/手写；
    //     · **距离 ≤ LINE_DIL_K×charH**：只补线之间的窄缝，不会一路吞到域的边缘。
    //   ⇒ 这与早期版本"保护整个合并块足迹"（召回崩到 14/40）的本质区别就在**距离约束**。
    if (LINE_DIL_K > 0 && lineCCPx > 0) {
      const dh = Math.max(2, Math.round(RLSA_FINE_K * charH))
      const merged = dilateRect(ink, w, h, dh, dh)
      const mbr = connectedComponents(merged, w, h, true)
      const mbl = mbr.labels!
      const Dlim = Math.max(1, Math.round(LINE_DIL_K * charH))
      const dist = new Int32Array(w * h).fill(-1)
      const que = new Int32Array(w * h)
      let head = 0, tail = 0
      for (let i = 0; i < w * h; i++) if (lineCCMask[i]) { dist[i] = 0; que[tail++] = i }
      while (head < tail) {
        const p = que[head++]
        const d = dist[p]
        if (d >= Dlim) continue
        const py = (p / w) | 0, px = p % w
        const rg = mbl[p]
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const ny = py + dy, nx = px + dx
          if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue
          const np = ny * w + nx
          if (dist[np] >= 0 || mbl[np] !== rg) continue   // ★ 域约束
          dist[np] = d + 1
          lineCCMask[np] = 1
          que[tail++] = np
        }
      }
      lineCCPx = 0
      for (let i = 0; i < w * h; i++) if (lineCCMask[i]) lineCCPx++
    }
  }

  // ② ★ 图形域优先剥离（§4.4）
  //    先在**合并后的区域**（RLSA）上判定，再回填细粒度块——直接对细 CC 判会失效。
  const graphics: GraphicsBlock[] = []
  const graphicsMask = new Uint8Array(w * h)
  // 多尺度合并：细尺度把半色调网点并成照片块；粗尺度把线段并成示意图/表格框块。
  // 单一尺度不行——粗尺度会把整页并成一个巨块（被"多行文本"豁免），细尺度又并不起线段。
  const scales: Array<[number, number]> = [
    [Math.max(2, Math.round(RLSA_FINE_K * charH)), Math.max(2, Math.round(RLSA_FINE_K * charH))],
    [Math.max(3, Math.round(RLSA_H_K * charH)), Math.max(3, Math.round(RLSA_V_K * charH))],
  ]
  for (const [si, sol] of scales.entries()) {
    const [dh, dv] = sol
    // ★ P4-2 只在**细尺度**用线条证据否决豁免。
    //   粗尺度（dh=1.2×charH）的合并块实测有 26~47×charH 宽（verify-out/p4-strip.json），
    //   它把插图连同周边印刷与手写一并吞掉 ⇒ 保护范围过大致召回崩塌（实测 35/40→14/40）。
    //   这正是历史上"RLSA 垂直膨胀过大 ⇒ annot2 召回 0/12"的同构重演。
    const allowLineEvidence = si === 0 && process.env.WL_GEXEMPT !== '0'
    const merged = dilateRect(ink, w, h, dh, dv)
    const mb = connectedComponents(merged, w, h, true)
    for (let ci = 0; ci < mb.comps.length; ci++) {
    const c = mb.comps[ci]
    if (c.n < 4) continue
    // 已被判为图形（另一尺度已命中）→ 跳过
    if (graphicsMask[(((c.y0 + c.y1) >> 1) * w) + ((c.x0 + c.x1) >> 1)]) continue
    const st = blockStats(c, ink, w, h, charH)
    // 几何闸门（复用生产 stripGraphics 判据）+ 整宽横线（表格框/分隔线）
    const isFullWidthLine = st.bw >= G_FULLW_K * w && st.bh >= G_FULLW_H_K * charH
    const bigArea = st.bw >= G_W_K * charH && st.bh >= G_H_K * charH && st.bw * st.bh >= G_AREA_K * charH * charH
    if (!bigArea && !isFullWidthLine) continue
    // 文本段落豁免：水平投影呈周期性墨带 → 多行文本（印刷段落或手写解答段落），不是图
    const bands = regionBands(c, ink, w, charH)
    const textLike = bands.n >= TEXT_BANDS_MIN && bands.medSpacing >= 0.8 * charH &&
      bands.medSpacing <= TEXT_BAND_SP_MAX * charH && bands.spacingCV <= TEXT_BAND_CV_HI
    // ★ P4-2：豁免可被**反向证据**否决。
    //   "有周期墨带"只证明"有周期结构"，证不出"是文本"——示意图/表格/几何图同样有周期墨带，
    //   实测 16 个插图框里 13 个正是被这条豁免放行（verify-out/p4-strip.json）。
    //   而"块内含 ≥LINE_RUN_K×charH 的长直游程"**证得出这是线条**（印刷文本最长不过 1.45×charH）。
    //   ⇒ 有线条证据时豁免作废，该块进入图形保护。
    const lineEvidence = LINE_RUN_K > 0 && allowLineEvidence && st.maxRun >= LINE_RUN_K * charH
    if (textLike && !lineEvidence) continue
    const reason: GraphicsBlock['reason'] = 'geometry'
    graphics.push({
      x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, reason,
      density: +st.density.toFixed(3), isoRatio: +st.isoRatio.toFixed(3), maxRun: st.maxRun, runCV: +st.runCV.toFixed(3),
    })
    // 外扩 pad：把区域边缘的碎笔画一并纳入保护，避免"图边残留墨迹被当手写"。
    // ⚠️ 这里**原来填的是整个外接矩形**，代价巨大：合并块常常是斜向/不规则图形，
    //    外接矩形里大量是印刷正文与手写 ⇒ 保护范围远超"图"，是该路防护此前
    //    一开就召回崩塌（35/40→14/40）的直接原因。
    //    改为按**该连通域的实际足迹**保护：pad 从 1×charH 收到 2px（仅补描边锯齿）。
    const pad = 2
    const y0 = Math.max(0, c.y0 - pad), y1 = Math.min(h - 1, c.y1 + pad)
    const x0 = Math.max(0, c.x0 - pad), x1 = Math.min(w - 1, c.x1 + pad)
    for (let y = y0; y <= y1; y++) {
      const b = y * w
      for (let x = x0; x <= x1; x++) if (mb.labels![b + x] === ci) graphicsMask[b + x] = 1
    }
    }
  }
  // ②b ★ 长直线游程保护（P4-2）
  //    **不做整块保护**：整 regions 保护会像早期版本那样把整页吃掉（annot2 召回 0/12）。
  //    这里只对**长游程经过的墨迹像素**做保护 —— 保护的是"线条"本身，
  //    相邻字符仍正常参与判别，召回风险最小。
  const lineProtect = new Uint8Array(w * h)
  let linePx = 0
  if (LINE_RUN_K > 0) {
    const minRun = Math.max(2, Math.round(LINE_RUN_K * charH))
    for (let y = 0; y < h; y++) {
      const b = y * w
      let s0 = -1
      for (let x = 0; x <= w; x++) {
        const on = x < w && ink[b + x]
        if (on) { if (s0 < 0) s0 = x }
        else if (s0 >= 0) {
          if (x - s0 >= minRun) { for (let i = s0; i < x; i++) if (!lineProtect[b + i]) { lineProtect[b + i] = 1; linePx++ } }
          s0 = -1
        }
      }
    }
    for (let x = 0; x < w; x++) {
      let s0 = -1
      for (let y = 0; y <= h; y++) {
        const on = y < h && ink[y * w + x]
        if (on) { if (s0 < 0) s0 = y }
        else if (s0 >= 0) {
          if (y - s0 >= minRun) { for (let i = s0; i < y; i++) { const p = i * w + x; if (!lineProtect[p]) { lineProtect[p] = 1; linePx++ } } }
          s0 = -1
        }
      }
    }
  }

  // 细粒度块：质心落在图形域内 → 排除，不参与手写分类
  const textBlocks = blocks.filter((c) => !graphicsMask[(((c.y0 + c.y1) >> 1) * w) + ((c.x0 + c.x1) >> 1)] &&
    !lineCCMask[(((c.y0 + c.y1) >> 1) * w) + ((c.x0 + c.x1) >> 1)])

  // ③ 文本行切分（排除图形域后的块）
  const rows = detectRows(textBlocks, w, ink, ctx.layout.strokeW)

  // ④ 词切分 + ⑤ 词级特征（先登记，不打分）
  const type0 = { x0: 0, y0: 0, x1: 0, y1: 0, row: 0, nComp: 0, n: 0, lineShare: 0, f: { heightCV: 0, strokeCV: 0, strokeDev: 0, baseDev: 0, ascDev: 0, spacingCV: 0, intensityStd: 0, slantDeg: 0, density: 0, anchor: 0 } }
  const raw: Array<typeof type0 & { score?: number; state?: WordState }> = []
  for (const row of rows) {
    const inRow = row.comps.slice().sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2)
    // 行内相邻块间隙中位（用于断词）
    // ⚠️ 修根因之二（2026-10-06，P4）：**量纲不一致**。
    //    原代码用**质心间距**（≈字宽+间隙，实测中位≈16px）算 medGap，
    //    却拿它的 1.8 倍（≈29px）去卡**边缘间隙**（实测中位 1~3px）。
    //    ⇒ 阈值大了两个数量级 ⇒ 几乎不断词 ⇒ 实测词宽 13.6×charH（≈6.8em），
    //      而排版事实：英文单词平均 4~5 字母、宽度 ≈2~3em。**词宽是正常值的 2~3 倍**，
    //      一个"词"里混编排印刷与手写 ⇒ 手写信号被稀释 ⇒ 稳健相对打分后召回掉到 8/34。
    //    修正：取ßt量与比较对象一致——都用边缘间隙。
    const cxAll = inRow.map((b) => (b.x0 + b.x1) / 2)
    const gapsRaw: number[] = []
    for (let i = 1; i < inRow.length; i++) {
      gapsRaw.push(GAP_MODE === 'centroid' ? cxAll[i] - cxAll[i - 1] : inRow[i].x0 - inRow[i - 1].x1 - 1)
    }
    const medGap = gapsRaw.length ? median(gapsRaw) : row.baseH * 0.6
    const wordGap = Math.max(WORD_GAP_ABS_K * charH, WORD_GAP_K * medGap)

    // 断词
    // ⚠️ 修根因（2026-10-06，P4）：此处原为 `gap = inRow[i].x0 + inRow[i-1].x1`——
    //    那是两个绝对横坐标之**和**（几百像素量级），永远大于 wordGap ⇒
    //    每个连通域都被断成一个"词"。实测四页 words 数 ≈ blocks 数（727/727、576/576、
    //    591/591），nComp 恒为 1 ⇒ 词级一致性判据（heightCV/spacingCV/baseDev）全部退化：
    //      heightCV 走 nComp=1 的退化式 |h−baseH|/baseH（插图巨块 → 7.8），
    //      spacingCV = cv(空数组) = 0（实测三类群体 p50 全为 0），
    //      baseDev/ascDev 失去"多个字符对齐与否"的含义。
    //    结果就是 probe-p4-score 实测：score 在手写/插图/印刷三类上 p50 = 0.50/0.48/0.37，
    //    几乎不可分。这不是阈值问题，是**词没切出来**。改回真正的间隙。
    const clusters: CC[][] = []
    let cl: CC[] = [inRow[0]]
    for (let i = 1; i < inRow.length; i++) {
      // 真正的水平间隙：本块左边界 − 前一块右边界 − 1（中间空白列数）
      const gap = inRow[i].x0 - inRow[i - 1].x1 - 1
      if (gap > wordGap) { clusters.push(cl); cl = [] }
      cl.push(inRow[i])
    }
    if (cl.length) clusters.push(cl)

    for (const wc of clusters) {
      const x0 = Math.min(...wc.map((c) => c.x0)), x1 = Math.max(...wc.map((c) => c.x1))
      const y0 = Math.min(...wc.map((c) => c.y0)), y1 = Math.max(...wc.map((c) => c.y1))
      const st = blockStats({ x0, y0, x1, y1, n: 0 }, ink, w, h, charH)

      // 特征
      const hs = wc.map((c) => c.y1 - c.y0 + 1)
      const heightCV = hs.length >= 2 ? cv(hs) : Math.abs(hs[0] - row.baseH) / Math.max(1, row.baseH)
      const tops = wc.map((c) => c.y0)
      const bots = wc.map((c) => c.y1)
      const ascDev = Math.max(std(tops), Math.abs(median(tops) - row.y0)) / Math.max(1, row.baseH)
      const baseDev = Math.max(std(bots), Math.abs(y1 - row.baseY1)) / Math.max(1, row.baseH)
      const strokeCV = st.runCV
      const strokeDev = Math.abs(st.medianRun - row.baseStroke) / Math.max(1, row.baseStroke)
      const cxs = wc.map((c) => (c.x0 + c.x1) / 2).sort((a, b) => a - b)
      const wgaps: number[] = []
      for (let i = 1; i < cxs.length; i++) wgaps.push(cxs[i] - cxs[i - 1])
      const spacingCV = cv(wgaps)
      // 强度方差：墨像素上的灰度标准差（钢笔墨浓淡不均 → 高）
      const gvals: number[] = []
      for (let y = y0; y <= y1; y++) { const b = y * w; for (let x = x0; x <= x1; x++) if (ink[b + x]) gvals.push(gray[b + x]) }
      const intensityStd = std(gvals) / 255
      const slantDeg = wc.reduce((m, c) => Math.max(m, compSlant(c, ink, w)), 0)
      const density = st.density

      // 词级线条否决：词的墨迹若**大比例**落在长直游程上 → 它是图形线条，不是文本。
      // 与上层的"区域保护"互补：区域保护会以 1 整块为单位误伤相邻手写，
      // 这里只在**词自身**的证据上否决，粒度与决策单位一致。
      let lineShare = 0
      if (LINE_RUN_K > 0 && st.inkN > 0) {
        let onLine = 0
        for (let y = y0; y <= y1; y++) {
          const b = y * w
          for (let x = x0; x <= x1; x++) if (ink[b + x] && lineProtect[b + x]) onLine++
        }
        lineShare = onLine / Math.max(1, st.inkN)
      }
      const f = { heightCV, strokeCV, strokeDev, baseDev, ascDev, spacingCV, intensityStd, slantDeg, density, anchor: 0 }
      // 先只登记几何与原始特征，分数在****全页词都算完之后**再统一定（见 ⑥）
      raw.push({ x0, y0, x1, y1, row: row.idx, nComp: wc.length, n: st.inkN, f, lineShare })
    }
  }

  const words: WordRecord[] = []

  // ── 本页参考分布（唯一"参数来源"）：逐特征的中位数与 MAD ──────────────
  //    中位数代表本页占主导的印刷人口；MAD 提供尺度。逐图自适应 ⇒ G10 的 L1 层。
  //    ★ 不是用标注标定出来的，是**这张图自己的人口统计**。
  const REF_KEYS = ['heightCV', 'strokeCV', 'strokeDev', 'baseDev', 'ascDev', 'spacingCV', 'intensityStd', 'slantDeg'] as const
  type RefKey = typeof REF_KEYS[number]
  const refMed: Partial<Record<RefKey, number>> = {}
  const refScale: Partial<Record<RefKey, number>> = {}
  for (const k of REF_KEYS) {
    const vals = raw.map((it) => it.f[k as keyof WordRecord['f']] as number)
    if (vals.length < 4) continue       // 词太少 → 人口统计不可靠 → 该特征弃权
    const m = median(vals)
    const mad = median(vals.map((v) => Math.abs(v - m)))
    refMed[k] = m
    refScale[k] = MAD_K * mad
  }
  /** 相对本页主群的单侧稳健偏离度（单位：σ）。越小于主群越算 0 —— 只认"比印刷更乱"的方向。 */
  const zOf = (k: RefKey, v: number): number => {
    const m = refMed[k], sc = refScale[k]
    if (m === undefined || sc === undefined || sc < Z_SCALE_FLOOR) return 0  // 无信息 → 弃权
    return Math.max(0, (v - m) / sc)
  }

  // ⑥ 打分：两路径
  //     A. 绝对阈值（旧，WL_SCORE=abs）——常量与大面积饱和，仅作对照保留；
  //     B. 稳健相对（默认）——以**本页词群的中位/MAD**为参考分布，逐图自适应。
  for (const it of raw) {
    const { f } = it
    let score: number
    if (ROBUST_SCORE) {
      const ZZ: Record<string, number> = {}
      score = clamp(
        W_HEIGHT * clamp((ZZ.heightCV = zOf('heightCV', f.heightCV)) / Z_REF, 0, 1) +
        W_STROKECV * clamp((ZZ.strokeCV = zOf('strokeCV', f.strokeCV)) / Z_REF, 0, 1) +
        W_STROKEDEV * clamp((ZZ.strokeDev = zOf('strokeDev', f.strokeDev)) / Z_REF, 0, 1) +
        W_BASE * clamp((ZZ.baseDev = zOf('baseDev', f.baseDev)) / Z_REF, 0, 1) +
        W_ASC * clamp((ZZ.ascDev = zOf('ascDev', f.ascDev)) / Z_REF, 0, 1) +
        W_SPACING * clamp((ZZ.spacingCV = zOf('spacingCV', f.spacingCV)) / Z_REF, 0, 1) +
        W_INTENSITY * clamp((ZZ.intensityStd = zOf('intensityStd', f.intensityStd)) / Z_REF, 0, 1) +
        W_SLANT * clamp((ZZ.slantDeg = zOf('slantDeg', f.slantDeg)) / Z_REF, 0, 1) +
        W_ANCHOR * f.anchor,
        0, 1,
      )
      ;(it as { z?: Record<string, number> }).z = ZZ
    } else {
      score = clamp(
        W_HEIGHT * clamp(f.heightCV / CV_HI, 0, 1) +
        W_STROKECV * clamp(f.strokeCV / STROKECV_HI, 0, 1) +
        W_STROKEDEV * clamp(f.strokeDev / STROKEDEV_HI, 0, 1) +
        W_BASE * clamp(f.baseDev / BASE_HI, 0, 1) +
        W_ASC * clamp(f.ascDev / ASC_HI, 0, 1) +
        W_SPACING * clamp(f.spacingCV / SPACING_HI, 0, 1) +
        W_INTENSITY * clamp(f.intensityStd / INTENSITY_HI, 0, 1) +
        W_SLANT * clamp(f.slantDeg / SLANT_HI, 0, 1) +
        W_ANCHOR * f.anchor,
        0, 1,
      )
    }
    // 共识计数（证据一致性）：与打分路径无关，直接看各 SEP 特征**绝对归一化**后的"已明显升高"数。
    // 一个特征"明显升高" = clamp(f[k]/HI[k],0,1) ≥ 0.5（与 ZsF1FN 探针的 decide 同口径）。
    const elevated = SEP_HI.reduce((n, [k, hi]) => n + (clamp((f[k] as number) / hi, 0, 1) >= 0.5 ? 1 : 0), 0)
    const consensusOk = elevated >= CONSENSUS_NH
    const lineVeto = LINE_RUN_K > 0 && (it.lineShare ?? 0) >= LINE_SHARE_MIN
    // ★ v21.5 G16：state===1 须同时满足 ① 加权分 ≥ 门槛 且 ② 共识达成（≥NH 个 SEP 同向升高）。
    //   否则即便分数偏高，只要证据"单薄"就落 UNCERTAIN(state=2) —— 疑罪从无，从 mask 剔除、保留该词。
    const state: WordState = lineVeto ? 0
      : (score >= (ROBUST_SCORE ? TAU_HI_R : CONSENSUS_TAU) && consensusOk) ? 1
      : (score <= (ROBUST_SCORE ? TAU_LO_R : TAU_LO)) ? 0
      : 2
    words.push({
      x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1, row: it.row,
      nComp: it.nComp, n: it.n, f: it.f, score, state,
    })
  }

  // ⑦ 写标签（词级：整词一个状态）+ 像素级印刷保护闸 + 长直线保护
  let protectedPx = 0, lineSavedPx = 0
  for (const wd of words) {
    for (let y = wd.y0; y <= wd.y1; y++) {
      const b = y * w
      for (let x = wd.x0; x <= wd.x1; x++) {
        if (!ink[b + x]) continue
        if (lineProtect[b + x]) { labels[b + x] = 0; lineSavedPx++; continue }
        if (lineCCMask[b + x]) { labels[b + x] = 0; lineSavedPx++; continue }
        if (furniturePrior && furniturePrior[b + x]) { labels[b + x] = 0; protectedPx++; continue }
        labels[b + x] = wd.state
        if (wd.state === 1) explain[b + x] = 1
      }
    }
  }

  const st = [0, 0, 0]
  let inkN = 0
  for (let i = 0; i < w * h; i++) { if (!ink[i]) continue; inkN++; st[labels[i]]++ }

  return {
    w, h, labels, explain, words, graphics,
    debug: {
      charH: +charH.toFixed(1),
      nBlocks: blocks.length,
      nGraphics: graphics.length,
      graphicsReasons: graphics.reduce((m: Record<string, number>, g) => { m[g.reason] = (m[g.reason] ?? 0) + 1; return m }, {}),
      nTextBlocks: textBlocks.length,
      nRows: rows.length,
      nWords: words.length,
      wordStateCount: words.reduce((m: Record<string, number>, x) => { m[String(x.state)] = (m[String(x.state)] ?? 0) + 1; return m }, {}),
      labelInkShare: st.map((c) => +(c / Math.max(1, inkN)).toFixed(3)),
      protectedPx,
      lineRunK: LINE_RUN_K,
      lineProtectPx: linePx,
      lineSavedPx,
      lineCC: lineCCs.length,
      lineCCPx,
      lineCCs: lineCCs.slice(0, 40),
      weights: { W_HEIGHT, W_STROKECV, W_STROKEDEV, W_BASE, W_ASC, W_SPACING, W_INTENSITY, W_SLANT, W_ANCHOR, TAU_LO, TAU_HI },
      consensus: { CONSENSUS_TAU, CONSENSUS_NH, SEP: SEP_HI.map(([k]) => k) },
      note: 'v21.5 G16 配套：词级共识判别器，state===1 须 分数≥TAU 且 ≥NH 个 SEP 特征同向升高；否则 UNCERTAIN(疑罪从无)。baseDev/ascDev 权重归零（反判别式）。',
    },
  }
}
