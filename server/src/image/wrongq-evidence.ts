/**
 * 错题区域提取 · P0 判定内核（#128）：单元优先 + 订正/标记语义分层
 * ------------------------------------------------------------------
 * 架构反转（相对于 v6「红笔簇优先」）：
 *
 *   旧：marks → groupWritingClusters（盒邻近单链接）→ buildBlocks（有簇即建块）
 *        → decideLocal（有书写簇即判 wrong 0.9）
 *    根因：单链接不区分横扫笔画与紧凑部件——对勾链能聚成"书写簇"判错，
 *        而真正的订正词反被并进巨型簇、只归属到一个题（其余题漏报）。
 *        实测基线：正面 4/5（漏 Q5、误报 Q12/Q13），背面 0/3（连分数"92"都成块）。
 *
 *   新：marks → groupRedComponents（双轴约束分组）
 *        → classifyGroup（订正词 vs 标记，词级墨量+填充率判据）
 *        → attributeEvidence（题号锚点评分归属，免疫单元盒错位）
 *        → verdict：仅"有订正词证据的单元"产 wrong 块（块框=单元盒∪订正证据）
 *
 * 语义模型（两页 GT 全量标定，front medH=28.3 / back medH=25.6）：
 *   - 教师标记惯例：答对=黑笔答案+红笔对勾/单笔斜线（fill ≤0.21）；
 *     答错=黑笔原答案（常被红斜线划掉）+红笔订正词（fill ≥0.24，墨量达词级）。
 *   - **fill=0.22 是单组件订正词的干净分界**（正面订正全中 ≥0.24，背面标记全 ≤0.21）。
 *   - 词级墨量门 n≥0.35×medH²：过滤斜线/勾挑碎片（正面斜线碎片 n=297、fill 0.064；
 *     背面单笔勾挑拆 3 片最大 n=193）——真实订正词核心笔画 n≥339（Q9"mixing"）。
 *
 * ⚠️ P0 保守策略：只对"订正词证据"判错。纯标记（对勾/叉/圈）不产块——
 *    叉/圈判错留待 P1（需 VLM 或更强的符号证据），避免把形状猜测当结论。
 *
 * #144 修订（整页批改册形态）：词级门在作业册上过严——教师对错题的标记是
 *   「红圈/红叉/斜线划改」而非写出订正词（p1 实测 244 个标记中 correction 仅 5、
 *    过词级门 2 处，而真值 41 条）。新增**条目级证据** isStrikeMark：
 *   达词级一半以上尺寸的非勾标记（叉/圈/划改横杠），与订正词并联进 verdict。
 *   对勾（tick）明确排除——GT 口径「答对=红勾」，且实测大对勾大量存在
 *   （p1 tick XL/i2 21 个），误入会成片误报。
 */
import type { LayoutContext } from './wrongq-layout'
import type { QuestionUnit } from './wrongq-segment'
import type { DocStructure } from './wrongq-structure'
import type { RedMark, WrongqBlock } from './wrongq.types'

/** 两框 y 中心差 ≤ 0.7×medH 且 x 间隔 ≤ 1.2×medH 时视为同一"书写行带" */
const DY_RATIO = 0.7
const DX_RATIO = 1.2

/** 单组件订正词判据阈值（#128 两页 GT 标定） */
const WORD_INK_RATIO = 0.35 // 词级墨量：n ≥ 0.35×medH²
const WORD_FILL_MIN = 0.22 // 填充率下界（干净分界，见文件头）
const WORD_ASPECT_MIN = 0.3
const WORD_ASPECT_MAX = 3.2
const WORD_SIDE_MAX = 3.5 // 单笔画宽/高 ≤ 3.5×medH（排除横贯线）

/** 组级几何门（防跨行/跨题链式合并；订正词+碎片链实测 h=68px，故高门放到 3×medH） */
const GROUP_W_MAX = 6 // 组宽 ≤ 6×medH
const GROUP_H_MAX = 3 // 组高 ≤ 3×medH
const GROUP_WH_MIN = 0.4 // 组宽 ≥ 0.4×组高（排除竖长链）
/**
 * 条目级证据（#144）：非勾红标记的尺寸/墨量门。
 *
 * 实测标定（p1 medH=30.9）：错题答案上的红圈/红叉/划改横杠 maxSide 26~44px
 * （0.8~1.4×medH）、n 125~225（0.13~0.24×medH²）；对勾与圈痕碎片 maxSide
 * ≤12px、n≤36。门取 maxSide ≥ 0.5×medH 且 n ≥ 0.035×medH²，两者留一倍余量。
 *
 * F5 收紧（#R4 六页全量诊断）：0.5/0.035 门下作业页 FP 泛滥——p1 的 8 个 FP 块
 * 中 4 组（g2/g23/g47/g58）、gt-front 1 组（g4）、gt-back 1 组（g0）由
 * 「maxSide 15~20px + n 30~55」的亚阈值碎屑圈/小叉驱动（sub-0.7×medH 形态在
 * 双栏作业页大量存在：教师批改的圈词痕迹与对勾碎片）。收紧至 0.7/0.06 后：
 * 上述 6 组全部杀死，GT 全部真证据幸存（最小者 gt-back g1：20px=0.74×medH、
 * n=50=0.069×medH²，以 ~6% 余量过线）。残余 FP 来自「词级红订正」（答案 Key
 * 形态，n=350-370/fill 0.22-0.43）——与 GT 真订正词（n=413-1641）无干净几何
 * 分界，属词级门语义极限（见文件头与验证报告），此处不再盲调。
 */
const STRIKE_SIDE_MIN = 0.7 // ×medH
const STRIKE_INK_MIN = 0.06 // ×medH²
/**
 * 核心邻域修剪半径（×medH）：以词级核心笔画盒中心为圆心裁掉远抛成员。
 *
 * 为什么必须修（#128 实测）：Q5 订正词（n=1211/fill 0.346，合法词级笔画）的组
 * 被右侧碎片链（对勾尾、碎点）一路拖到宽 227px，超过组宽门 6×medH=170——
 * 真订正词被伪几何门连坐杀掉。单链接的传递性会把"隔了 60~120px 的其它标记"
 * 桥接进组，而订正词自身部件从不超过 ~2×medH 的间距。
 * 修剪后 Q5 组 = 词 + 左邻碎片（宽 108px）→ 合规；
 * 对多词订正（"rescue workers"两标记相距 76px）会被拆开，但核心词单独即过
 * 词级门，且裁图框由单元盒兜底，无损判定与裁图。
 */
const CORE_TRIM = 2.5

/** 归属评分：候选 = |订正词 yc − 题号锚点 y| ≤ 1.5×medH */
const ATTACH_DY_MAX = 1.5
/**
 * 答案域硬过滤（#144）：标记中心不得落在题号锚点左侧超过 1×medH。
 *
 * 为什么需要（p1 实测）：三栏作业页中列是左栏练习的答案区——左栏题目的手写
 * 答案与红标记都在中列（x 327-553），而右栏题目的锚点在其中列右缘（x≈552）。
 * 纯锚点距离+水平距离破平会把中列标记判给右栏题目（ farmland 标记距右栏
 * 词形变换3 锚点的水平距离 162px < 距左栏题目锚点的 320px）。答案永远写在
 * 题号右侧，据此先把锚点左侧的候选剔除。
 */
const ATTACH_DX_BACK = 1.0
/** 非对称权重：订正词在锚点下方 ×0.7（更像本题续行/答案行），上方 ×1.0（更像上一题） */
const W_BELOW = 0.7
const W_ABOVE = 1.0
/** 加权距离差 ≤ 0.3×medH 视为同分，按到锚点的水平距离破平 */
const TIE_TOL = 0.3

/**
 * 单元的答案域右界（#144）：锚点所在栏的右邻栏右缘（末栏则页宽）。
 * 中列答案区的标记因此只落在左栏单元的答案域内，右栏单元答案域从其中列
 * 右缘起——同分圈内优先答案域包含标记的单元。
 */
function answerZoneRight(ctx: LayoutContext, ax: number): number {
  const cols = ctx.cols?.length ? ctx.cols : [[0, ctx.w]]
  for (let i = 0; i < cols.length; i++) {
    if (ax >= cols[i][0] && ax < cols[i][1]) return i + 1 < cols.length ? cols[i + 1][1] : ctx.w
  }
  return ctx.w
}

/**
 * 订正词是否落在某单元所属小类的纵向区间内（P1 §4.4 同小节 tie-break）。
 *
 * 为什么需要（#129 实测驱动）：小类边界处两道题的题号锚点可能同时进入
 * 同分圈（如正面 汉译英18 与 探究案1 分居节界上下）——纯锚点距离+水平距离
 * 破平在双栏版面会挑错节。先按"订正词墨量加权中心是否落在该单元所属小类
 * 区间"偏好，再按水平距离决胜：订正词写在该小类的答案行/续行里，
 * 它的 cy 必然在本小类 [y0, y1) 内。
 */
function inSameSubsection(st: DocStructure | undefined, u: QuestionUnit, cy: number): boolean {
  if (!st || u.sec2 == null || u.sub2 == null) return false
  const sec = st.sections[u.sec2]
  const sub = sec?.subsections[u.sub2]
  if (!sub) return false
  return cy >= sub.y0 && cy < sub.y1
}

/**
 * 单个红墨连通域是否为「订正词笔画」——教师手写答案的最小可靠单元。
 *
 * 判据（两页 GT 全量核对）：
 *   - 墨量达词级（n ≥ 0.35×medH²）：单笔画碎屑、斜线片段不过；
 *   - 填充率 ≥ 0.22：手写字的笔画密度；对勾/斜线/圈痕 fill ≤0.21；
 *   - 宽高比 0.3~3.2、单边 ≤ 3.5×medH：排除横贯数题的长划线与竖线。
 *
 * ⚠️ 已知重叠（勿当干净判据用）：粗头红笔的**大对勾**形态上可同时过词级门
 *   （实测 n=161/fill 0.27/aspect 1.67）。单组件层面无法与订正词分开——
 *   真正的拦截在组级：correction 要求 parts≥2（见 groupRedComponents ④），
 *   对勾是孤立单符号，天然被挡；GT 口径「答对=红勾」由此在组级兑现。
 */
export function isCorrectionWord(m: RedMark, medH: number): boolean {
  if (!(medH > 0)) return false
  const w = m.box.x1 - m.box.x0 + 1
  const h = m.box.y1 - m.box.y0 + 1
  return (
    m.n >= WORD_INK_RATIO * medH * medH &&
    m.fill >= WORD_FILL_MIN &&
    m.aspect >= WORD_ASPECT_MIN &&
    m.aspect <= WORD_ASPECT_MAX &&
    w <= WORD_SIDE_MAX * medH &&
    h <= WORD_SIDE_MAX * medH
  )
}

/**
 * 勾/斜类笔迹判据（#R5，isStrikeMark 与订正词组级门共用）。
 *
 * 为什么需要几何判据（不能只凭 kind）：classifyMark 的 `n>300 → correction`
 * 规则先于符号几何命中，粗头大红勾（实测 63×43 / n=303 / fill 0.11 / aspect 1.47）
 * 被贴成 correction 类，仅凭 kind 的 tick 排除被绕过 → 伪 wrong 块。
 *
 * 判据（GT fill 模型 + 形状先验）：对勾与单笔斜线 fill ≤0.21 且宽于高；
 * 圈/叉近方形（aspect≈1）；划改横杠墨实（fill 达标，不受本判据影响）。
 * 故取 **aspect ≥ 1.4 且 fill < 0.22 → 勾/斜类**（不设上界：aspect>6 的薄长条
 * 已被 classifyMark 的 underline 分支接住，5~6 区间的薄斜线同属答对类笔迹）。
 * 真实订正词（fill ≥0.22）不受影响。
 */
function isTickLike(m: RedMark): boolean {
  if (m.kind === 'tick' || m.kind === 'underline') return true
  return m.aspect >= 1.4 && m.fill < WORD_FILL_MIN
}

/**
 * 条目级错题证据（#144）：红叉/红圈/划改——非勾、非下划线的较大红标记。
 *
 * 为什么排除 tick：GT 口径「答对=红勾」，且实测大对勾极多（p1 达词级尺寸的
 * tick 21 个），形状上与叉/圈高度重叠（classifyMark 的 aspect+fill 区间本就
 * 重叠），唯有 kind 已先行区分。underline 是排版横线，不产判定。
 * 订正词走 isCorrectionWord 路径，此处不重复计入（组级 correction 已覆盖）。
 *
 * #R5 几何救回（probe-verdict 实测修复）：仅凭 kind 的 tick 排除会被 n>300
 * 贴成 correction 类的粗头大红勾绕过，改判据见 isTickLike。
 */
export function isStrikeMark(m: RedMark, medH: number): boolean {
  if (!(medH > 0)) return false
  if (isTickLike(m)) return false
  if (isCorrectionWord(m, medH)) return false
  const w = m.box.x1 - m.box.x0 + 1
  const h = m.box.y1 - m.box.y0 + 1
  return Math.max(w, h) >= STRIKE_SIDE_MIN * medH && m.n >= STRIKE_INK_MIN * medH * medH
}

/** 红墨分组（双轴约束单链接的产出） */
export interface RedGroup {
  id: number
  box: { x0: number; y0: number; x1: number; y1: number }
  markIds: number[]
  /** 连通域（笔画）个数 */
  parts: number
  /** 总红墨像素数 */
  ink: number
  /** 墨量加权中心（归属评分用：抗碎片拖尾把盒中心拉偏） */
  cx: number
  cy: number
  /** 是否订正词组（含词级笔画且组几何合规）——只有它产 wrong 判定 */
  correction: boolean
  /** 是否含条目级标记证据（红叉/圈/划改，组几何合规，#144） */
  strike: boolean
  /** 触发订正判定的核心笔画 id（correction 为 true 时有效） */
  coreMarkId: number
}

function boxesXGap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): number {
  return Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
}

/**
 * 红墨连通域分组：**双轴约束单链接**。
 *
 * 为什么不是旧的"盒邻近单链接"（v6 groupWritingClusters 同款）：
 *   旧规则只要求"外扩后相交"——横扫的长对勾与紧凑的订正词部件只要首尾相接
 *   就并簇，正面 40 部件巨型组、背面 0/3 全崩都源于此。
 *   双轴约束要求**同一行带**（|Δyc| ≤ 0.7×medH）**且横向紧邻**（x 间隔 ≤ 1.2×medH）：
 *   - 横贯多题的长划/斜线：跨度远超 1.2×medH 的任何单链接 → 自然断链；
 *   - 音标/汉译英列的小对勾链：横向间距 ≈ 词距（数倍 medH）→ 大部分不断链，
 *     但整链墨量被词级门滤掉（最大单笔 n=297、fill 0.064）；
 *   - 订正词的多个部件：行带内紧邻 → 正确合组（Q12 九部件、Q9 四部件）。
 *
 * 单链接传递性仍可能把碎片链桥接起来（Q12 组高被拖到 68px）——由组级几何门
 * （高 ≤ 3×medH）与词级门共同兜底。
 */
export function groupRedComponents(marks: RedMark[], medH: number): RedGroup[] {
  // 下划线是排版横线（非书写内容），不参与分组（与 groupWritingClusters 一致）
  const idx: number[] = []
  for (let i = 0; i < marks.length; i++) if (marks[i].kind !== 'underline') idx.push(i)
  const m = idx.length
  if (!m) return []

  const dyMax = DY_RATIO * medH
  const dxMax = DX_RATIO * medH
  const parent = new Int32Array(m)
  for (let i = 0; i < m; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx }
    return r
  }
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const a = marks[idx[i]]
      const b = marks[idx[j]]
      const dyc = Math.abs((a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2)
      if (dyc > dyMax) continue
      if (boxesXGap(a.box, b.box) > dxMax) continue
      const ra = find(i)
      const rb = find(j)
      if (ra !== rb) parent[ra] = rb
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(idx[i])
    else groups.set(r, [idx[i]])
  }

  const out: RedGroup[] = []
  for (const [, g] of groups) {
    // ① 核心笔画 = 组内最大且过词级门的笔画（无则本组不可能是订正词）
    let coreId = -1
    for (const i of g) {
      if (!isCorrectionWord(marks[i], medH)) continue
      if (coreId < 0 || marks[i].n > marks[coreId].n) coreId = i
    }
    // ② 核心邻域修剪：剔除距核心笔画盒中心 > CORE_TRIM×medH 的远抛成员
    //    （碎片链桥接来的其它标记），防组几何被连坐破坏
    let members = g
    if (coreId >= 0) {
      const cb = marks[coreId].box
      const ccx = (cb.x0 + cb.x1) / 2
      const ccy = (cb.y0 + cb.y1) / 2
      const trimR = CORE_TRIM * medH
      members = g.filter((i) => {
        const mb = marks[i].box
        const mx = (mb.x0 + mb.x1) / 2
        const my = (mb.y0 + mb.y1) / 2
        return Math.hypot(mx - ccx, my - ccy) <= trimR
      })
      if (!members.includes(coreId)) members = [coreId]
    }
    // ③ 在修剪后的成员上计算组几何/墨量/加权中心
    let ink = 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let cxSum = 0, cySum = 0, wSum = 0
    for (const i of members) {
      const mk = marks[i]
      ink += mk.n
      x0 = Math.min(x0, mk.box.x0); y0 = Math.min(y0, mk.box.y0)
      x1 = Math.max(x1, mk.box.x1); y1 = Math.max(y1, mk.box.y1)
      const wgt = Math.max(1, mk.n)
      cxSum += ((mk.box.x0 + mk.box.x1) / 2) * wgt
      cySum += ((mk.box.y0 + mk.box.y1) / 2) * wgt
      wSum += wgt
    }
    const gw = x1 - x0 + 1
    const gh = y1 - y0 + 1
    const geoOk = gw <= GROUP_W_MAX * medH && gh <= GROUP_H_MAX * medH && gw >= GROUP_WH_MIN * gh
    // ④ 订正词判别：有词级核心笔画，且修剪后组几何合规（防跨行/跨题链）。
    // ⚠️ 词级门看"单笔画墨量+填充率"，不看组总墨量——单笔勾挑拆成 3 片后
    //    总墨量 420 也能过 0.5×medH²，但最大单片 n=193、fill 0.14，
    //    词级门干净排除（Q16 实测误报）。
    // #R5 多笔画门（probe-verdict 实测修复）：订正词组必须**多笔画**（parts≥2），
    //    或孤立一笔但**非勾/斜类**（isTickLike）。为什么：词级门对"单组件大字"
    //    无判别力——粗头红笔打的勾形态上恰能过线（实测 30×18 对勾 n=161/fill 0.27，
    //    medH≈21 时词级门 0.35×medH²≈160 恰好收下），而 GT 口径「答对=红勾」。
    //    教师"写出答案"必然成词多域（GT 订正组 Q9 四部件、Q12 九部件）；孤立的
    //    词级红墨若是非勾形态（粗红叉/红圈/订正词，圈选标记实测 81×31/n=640），
    //    仍按订正词计（保持 #128 标定行为，标注未经 VLM 语义确认）。
    //    单字订正（如只写个 "5"）经 isStrikeMark 条目级路径仍可捕获，不漏判。
    const correction = coreId >= 0 && geoOk && (members.length >= 2 || !isTickLike(marks[coreId]))
    // ④' 条目级标记证据（#144）：组内含达门的非勾标记（叉/圈/划改）。
    //     同样受组几何门约束——纯标记组无核心笔画不做修剪，几何门是防
    //     碎片链把相隔多题的标记并成一组的唯一手段。
    const strike = geoOk && members.some((i) => isStrikeMark(marks[i], medH))
    out.push({
      id: out.length,
      box: { x0, y0, x1, y1 },
      markIds: members.slice(),
      parts: members.length,
      ink,
      cx: wSum > 0 ? cxSum / wSum : (x0 + x1) / 2,
      cy: wSum > 0 ? cySum / wSum : (y0 + y1) / 2,
      correction,
      strike,
      coreMarkId: coreId,
    })
  }
  out.sort((a, b) => (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0))
  out.forEach((g, i) => { g.id = i })
  return out
}

/** 一条归属结果：订正词组 → 题目单元 */
export interface CorrectionAttribution {
  groupId: number
  unitId: number
  /** 加权距离（px，已含上/下非对称权重） */
  dist: number
  /** 到题号锚点的水平距离（px，破平用） */
  hDist: number
}

/**
 * 订正词组/标记组 → 题目单元归属（题号锚点评分）。
 *
 * 为什么不用"盒包含/IoU"（v6 applyUnits 同款，P0 实测证伪）：
 *   多题号 region 按字符占比切 Y 轴，使 Q10/Q11/Q12 的单元盒整体错位——
 *   Q12 订正词落进 Q10 盒内，按盒归属全数错判。
 *   锚点是题号字身估计位置，对盒错位免疫。
 *
 * 评分规则（10 个 GT 订正案例全部验证通过 + #144 作业册修订）：
 *   - 候选 = |证据 yc − 锚点 y| ≤ 1.5×medH 且 证据 cx ≥ 锚点 x − 1×medH
 *     （答案域硬过滤，见 ATTACH_DX_BACK：中列答案不会归属右栏题目）；
 *   - 距离 = |Δy| ×（下方 0.7 / 上方 1.0）：答案与续行在题号行**下方**，
 *     同分时更可能是本题；题号行**上方**的墨更可能是上一题的订正；
 *   - 加权距离差 ≤ 0.3×medH 视为同分 → 答案域包含证据者优先（#144），
 *     再按"同小节"偏好（证据 cy 落在该单元所属小类区间），
 *     最后按到锚点的水平距离破平（双栏版面同 y 轴并列两道题时，正面 Q18 案例）；
 *   - 无候选 → 不归属（右下角分数"92"离所有题号行 >1.5×medH，自然落选）。
 *
 * #144：groups 含订正词组（correction）与条目级标记组（strike，红叉/圈/划改），
 *   两者并联作为 wrong 证据；ctx 传入时启用答案域过滤/偏好（旧调用方不传则退化为
 *   纯锚点距离行为，两页 GT 不受影响）。
 */
export function attributeCorrections(
  groups: RedGroup[],
  units: QuestionUnit[],
  medH: number,
  structure?: DocStructure,
  ctx?: LayoutContext,
): CorrectionAttribution[] {
  if (!(medH > 0) || !units.length) return []
  const dyMax = ATTACH_DY_MAX * medH
  const dxBack = ATTACH_DX_BACK * medH
  const tieTol = TIE_TOL * medH
  const out: CorrectionAttribution[] = []
  for (const g of groups) {
    if (!g.correction && !g.strike) continue
    // 收集全部候选，先按加权距离取最小，再在同分圈内破平
    let bestDist = Infinity
    const cands: Array<{ u: QuestionUnit; dist: number; hd: number; sameSub: boolean; inZone: boolean }> = []
    for (const u of units) {
      if (!u.anchor) continue
      const dy = g.cy - u.anchor.y
      if (Math.abs(dy) > dyMax) continue
      if (g.cx < u.anchor.x - dxBack) continue // 答案域硬过滤（#144）
      const dist = Math.abs(dy) * (dy > 0 ? W_BELOW : W_ABOVE)
      const hd = Math.abs(g.cx - u.anchor.x)
      const inZone = ctx ? g.cx <= answerZoneRight(ctx, u.anchor.x) + 0.5 * medH : true
      if (dist < bestDist) bestDist = dist
      cands.push({ u, dist, hd, sameSub: inSameSubsection(structure, u, g.cy), inZone })
    }
    if (!cands.length) continue
    let pick: { u: QuestionUnit; dist: number; hd: number; sameSub: boolean; inZone: boolean } | null = null
    for (const c of cands) {
      if (c.dist > bestDist + tieTol) continue
      if (!pick) { pick = c; continue }
      // 同分圈内：先答案域偏好，再同小节偏好，最后水平距离破平
      if (c.inZone !== pick.inZone) {
        if (c.inZone) pick = c
        continue
      }
      if (c.sameSub !== pick.sameSub) {
        if (c.sameSub) pick = c
        continue
      }
      if (c.hd < pick.hd) pick = c
    }
    if (pick) out.push({ groupId: g.id, unitId: pick.u.id, dist: pick.dist, hDist: pick.hd })
  }
  return out
}

/** 像素框 → 归一化 [x, y, w, h]（0~1，保留 4 位） */
function normBoxOf(box: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number): [number, number, number, number] {
  return [
    +(box.x0 / w).toFixed(4),
    +(box.y0 / h).toFixed(4),
    +((box.x1 - box.x0 + 1) / w).toFixed(4),
    +((box.y1 - box.y0 + 1) / h).toFixed(4),
  ]
}

/**
 * 单元优先建块（P0 主路径 / P1 结构标签 / #144 条目级证据）：**只有带错题证据的单元才产 wrong 块**。
 *
 * 块框 = 单元盒 ∪ 该单元全部证据词组盒（并集）：
 *   - 单元盒定"这是哪道题"（题号到下一题号，免疫红笔位置漂移）；
 *   - 并集保证裁图**必然包含红笔证据**——用户明确指出红笔订正是最明确的
 *     错题判定线索，裁图必须看得见它（Q9 订正写在答案行上方 27px，
 *     纯单元盒会把它切在框外）；对作业册形态，中列答案区的红圈/划改也因此
 *     进入块框（左栏单元盒只覆盖印刷列，并集右扩至答案区）；
 *   - 并集高度受归属距离门（1.5×medH）约束，不会失控吞段。
 *
 * 一个单元多组证据（如 Q4 的"experienced"与"since"两处）→ 聚合为一块。
 * 无证据的单元（全对的题）→ 不产块。
 *
 * P1（#129）：块带 questionLabel（"预习案·Ⅱ.汉译英 18"式规范标签）与结构
 * 化 evidence——两节各自重起题号时数字有歧义，标签才能唯一指认题目；
 * 同时归属破平引入同小节偏好（structure 传入时生效）。
 */
export function buildEvidenceBlocks(
  marks: RedMark[],
  units: QuestionUnit[],
  ctx: LayoutContext,
  medH: number,
  structure?: DocStructure,
): WrongqBlock[] {
  const { w, h } = ctx
  if (!marks.length || !units.length || !(medH > 0)) return []
  const groups = groupRedComponents(marks, medH)
  const attrs = attributeCorrections(groups, units, medH, structure, ctx)
  if (!attrs.length) return []

  // 按单元聚合证据词组
  const byUnit = new Map<number, RedGroup[]>()
  for (const a of attrs) {
    const g = groups[a.groupId]
    if (!g) continue
    const arr = byUnit.get(a.unitId)
    if (arr) arr.push(g)
    else byUnit.set(a.unitId, [g])
  }

  const pad = Math.max(2, Math.round(medH * 0.3))
  const blocks: WrongqBlock[] = []
  for (const [uid, gs] of byUnit) {
    const u = units[uid]
    if (!u) continue
    let x0 = u.box.x0, y0 = u.box.y0, x1 = u.box.x1, y1 = u.box.y1
    const markIds: number[] = []
    for (const g of gs) {
      x0 = Math.min(x0, g.box.x0)
      y0 = Math.min(y0, g.box.y0)
      x1 = Math.max(x1, g.box.x1)
      y1 = Math.max(y1, g.box.y1)
      for (const id of g.markIds) if (!markIds.includes(id)) markIds.push(id)
    }
    let bx0 = Math.max(0, x0 - pad)
    let by0 = Math.max(0, y0 - pad)
    let bx1 = Math.min(w - 1, x1 + pad)
    let by1 = Math.min(h - 1, y1 + pad)
    if (bx1 < bx0) bx1 = bx0
    if (by1 < by0) by1 = by0
    const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 }
    // col 用页面级栏（与旧块语义一致：前端/merge 只认页面级 cols）
    const cx = (bx0 + bx1) / 2
    let col = -1
    for (let i = 0; i < ctx.cols.length; i++) if (cx >= ctx.cols[i][0] && cx < ctx.cols[i][1]) { col = i; break }
    if (col < 0) col = 0
    const ink = gs.reduce((s, g) => s + g.ink, 0)
    const parts = gs.reduce((s, g) => s + g.parts, 0)
    // 证据分层（#144）：订正词（教师写出正确答案，最硬）> 红叉/圈/划改（条目级标记）
    const hasWord = gs.some((g) => g.correction)
    const hasStrike = gs.some((g) => g.strike)
    const kindText = hasWord && hasStrike ? '教师红笔订正+叉圈划改' : hasWord ? '教师红笔订正' : '教师红笔叉/圈/划改'
    const confidence = hasWord ? 0.9 : 0.8
    blocks.push({
      id: blocks.length,
      box,
      normBox: normBoxOf(box, w, h),
      col,
      markIds,
      questionUnitId: u.id,
      questionLabel: u.label,
      verdict: 'wrong',
      confidence,
      evidence: [
        `${kindText}：${gs.length} 处 / ${parts} 个笔画域 / 红墨 ${ink}px`,
        u.label
          ? `归属题目 ${u.label}（题号锚点评分，墨量加权中心 (${Math.round(gs[0].cx)},${Math.round(gs[0].cy)})）`
          : `归属题目 #${u.number.num ?? '?'}（题号锚点评分，墨量加权中心 (${Math.round(gs[0].cx)},${Math.round(gs[0].cy)})）`,
        u.repaired ? '题号经结构序列自纠（缺号补认/误读修正，见 wrongq-structure）' : hasWord
          ? '订正词为最硬的本地错题证据（教师写出正确答案），未经 VLM 语义确认'
          : '条目级红笔标记（叉/圈/划改）为错题证据；对勾不计入（GT 口径答对=红勾），未经 VLM 语义确认',
      ],
      source: 'local',
    })
  }
  blocks.sort((a, b) => (a.col - b.col) || (a.box.y0 - b.box.y0))
  blocks.forEach((b, i) => { b.id = i })
  return blocks
}
