/**
 * 错题区域提取 · ⑤ 证据融合与判定
 *
 * 诚实边界（务必保留）：
 *  本地形态分类只用包围盒的宽高比/填充率，**勾与叉在这些特征上重叠**，
 *  因此本地判定只作为**一阶证据**：能给出"这里有红笔、大概是什么形态"，
 *  但"这道题到底错没错"需要读懂题意——那正是 VLM 的职责。
 *  VLM 不可用时（本环境 COZE_API_TOKEN 未配置），本地判定照常输出但置信度**刻意压低**，
 *  并由前端提示"未经语义确认"，绝不伪装成高置信结论。
 */
import type { MarkKind, RedMark, WrongqBlock, WrongqVerdict, WritingCluster } from './wrongq.types'

export interface VlmItem {
  no?: string
  /** 归一化 [x, y, w, h] */
  box?: [number, number, number, number]
  verdict?: string
  reason?: string
  confidence?: number
}

const NEGATIVE: MarkKind[] = ['cross', 'half_tick', 'question_mark', 'deduct']

function normVerdict(v: string | undefined): WrongqVerdict {
  if (v === 'wrong' || v === 'correct' || v === 'blank') return v
  return 'unknown'
}

/**
 * 教师批阅符号的尺寸合理性闸门。
 *
 * 实测痛点：作业纸上红笔**连笔手写订正**会被连通域拆成许多小笔画，
 * 这些碎片的几何（aspect≈2、fill≈0.4）恰好落在旧规则的对勾/叉区间内，
 * 导致一页被误判出 97 个"对勾"、13 个"叉"（而实际全页仅 1 个半勾、0 个叉）。
 * 真正的批阅符号（勾/叉/圈）尺寸应与字高相当，且有一定墨量；
 * 远小于字高、墨量极少的碎片一律视为"无判别力"，不作为判定证据。
 */
function isPlausibleSymbol(m: RedMark, medH: number): boolean {
  const bw = m.box.x1 - m.box.x0 + 1
  const bh = m.box.y1 - m.box.y0 + 1
  const side = Math.max(bw, bh)
  return m.n >= 20 && side >= medH * 0.45 && side <= medH * 2.5
}

/**
 * 纯本地判定（VLM 不可用时的主输出）。
 *
 * 语义化改造（v22）：判定从"数标记形态"改为"看证据强弱"——
 *   - **强证据 = 教师红笔订正（correction，成片红墨）**：教师把正确答案写出来，
 *     这是"这道题错了"最硬的本地证据（它不是形状猜测，而是"教师改写"这一事实）。
 *   - 否定类符号（叉/半勾/问号/扣分）仍判错，但须过尺寸闸门，排除碎片误判。
 *   - 对勾判对，同样须过闸门，且**不能与订正共存**（既有订正又有勾 → 以订正为准）。
 *   - 碎片（极小/墨量极少）不参与判定 → unknown，交人工/VLM，绝不硬猜。
 */
export function decideLocal(
  blocks: WrongqBlock[],
  marks: RedMark[],
  medH = 0,
  /** 语义书写簇：块若源自书写簇，直接按"教师在此处写了字"判错（最强本地证据） */
  clusters: WritingCluster[] = [],
): WrongqBlock[] {
  const byId = new Map<number, RedMark>()
  for (const mk of marks) byId.set(mk.id, mk)
  const gate = medH > 0 ? (m: RedMark) => isPlausibleSymbol(m, medH) : () => true
  const clusterById = new Map<number, WritingCluster>()
  for (const c of clusters) clusterById.set(c.id, c)

  for (const b of blocks) {
    // 语义优先：书写簇 = 教师成片手写（订正/批注），与字形、与手写 OCR 能否读准无关
    const cl = b.clusterId != null && b.clusterId >= 0 ? clusterById.get(b.clusterId) : undefined
    if (cl) {
      const cw = cl.box.x1 - cl.box.x0 + 1
      const ch = cl.box.y1 - cl.box.y0 + 1
      // 墨迹密度 = 红墨 / 包围盒面积，用来分辨"写字"和"划一道"。
      //   写字（教师订正）：笔画断续但有一定密度 → 0.01 ~ 0.35
      //   长划线（学生自查划掉答案 / 页眉红线）：跨度大、墨极少 → < 0.01
      //   大块涂抹：墨糊成一片 → > 0.35
      // 后两者都不是"教师写出了答案"，降级为存疑，交人工确认，不硬判。
      const density = cl.ink / Math.max(1, cw * ch)
      const strongInk = 2 * medH * medH
      const strong = cl.parts >= 8 || cl.ink >= strongInk
      const thinLine = density < 0.01
      const smear = density > 0.35
      const weak = !strong && (cl.parts < 5 || thinLine || smear)

      // 角色分解（语义化第三刀）：簇内的红墨可能是「写出答案」也可能是「划线标错」。
      //   两者都说明"此题被批改"，但证据语义与强度不同：
      //     书写主导 → 教师写出了正确答案（最硬的本地证据）→ 0.9
      //     划线主导 → 教师只划出错误位置（提示性，未给答案）→ 0.78
      //     纯划线且墨不重 → 也可能是学生自查划线 → 0.78 + 存疑
      //
      // ⚠️ 划线判据必须用**长边 / 字高**，不能用长宽比：
      //   实测 front 一处划线域是 71×26（长宽比仅 2.7，判不出来），
      //   而书写单字域是 29×22（长宽比 1.3）——长宽比在两者上重叠，无判别力。
      //   改看长边：划线横贯数倍字宽（71/28.3=2.5、111/24.2=4.6），
      //   书写单字长边≈1×medH（29/24.2=1.2）。判据取 长边 ≥ 2.2×medH。
      let lineInk = 0
      if (medH > 0) {
        for (const id of cl.markIds) {
          const m = byId.get(id)
          if (!m) continue
          const mw = m.box.x1 - m.box.x0 + 1
          const mh = m.box.y1 - m.box.y0 + 1
          if (Math.max(mw, mh) >= medH * 2.2) lineInk += m.n
        }
      }
      const lineRatio = lineInk / Math.max(1, cl.ink)
      const lineLed = lineRatio > 0.7
      const lineOnly = lineRatio > 0.85

      b.verdict = 'wrong'
      b.confidence = strong ? (lineLed ? 0.78 : 0.9) : weak ? 0.6 : 0.78
      if (weak) b.suspect = true
      // 纯划线（几乎无书写笔画）且证据不强：可能是学生自查划线，标存疑交人工
      if (lineOnly && !strong) b.suspect = true
      b.evidence = [
        `教师红笔批改：${cl.parts} 个笔画域 / 红墨 ${cl.ink}px / 跨度 ${cw}×${ch}px / 密度 ${density.toFixed(3)}`,
        strong
          ? lineLed
            ? `证据中强：划线为主（划线墨占比 ${(lineRatio * 100) | 0}%）→ 教师标出错误位置，计为错题`
            : '证据强：成片书写、笔画域多 → 教师在此写出内容，计为错题'
          : weak
            ? `证据偏弱${thinLine ? '（墨迹稀疏如长划线）' : smear ? '（墨迹糊成一片，可能是涂抹）' : '（笔画较少）'}，建议人工确认`
            : '证据中等：成片红笔书写 → 该处被批改，计为错题',
      ]
      continue
    }

    const ms = b.markIds.map((id) => byId.get(id)).filter((m): m is RedMark => !!m)
    const kinds = new Map<MarkKind, number>()
    for (const m of ms) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1)
    const desc = [...kinds].map(([k, v]) => `${k}×${v}`).join(', ')
    b.evidence = [`红笔标记 ${ms.length} 个：${desc || '无'}`]

    const corr = kinds.get('correction') ?? 0
    // 圈错（gated circle）：中文批改里"红圈圈出错误"是否定信号。
    // 过了尺寸闸门的圆团（如 17×16/n78）基本是真圈；未过闸门的小碎片（4×4）被排除。
    const circled = ms.filter((m) => m.kind === 'circle' && gate(m)).length
    const negStrong = ms.filter((m) => NEGATIVE.includes(m.kind) && gate(m)).length
    const tickStrong = ms.filter((m) => m.kind === 'tick' && gate(m)).length
    const ink = ms.reduce((s, m) => s + m.n, 0)

    if (corr > 0) {
      b.verdict = 'wrong'
      b.confidence = 0.7
      b.evidence.push(`教师红笔订正（成片红墨 ${ink}px）→ 原作答有误`)
    } else if (negStrong > 0) {
      b.verdict = 'wrong'
      b.confidence = 0.6
      b.evidence.push('存在否定类标记（叉/半勾/问号/扣分，已过尺寸闸门）')
    } else if (circled > 0) {
      b.verdict = 'wrong'
      b.confidence = 0.55
      b.evidence.push('存在红圈圈错（已过尺寸闸门）')
    } else if (tickStrong > 0) {
      b.verdict = 'correct'
      b.confidence = 0.5
      b.evidence.push('仅见对勾（已过尺寸闸门）')
    } else {
      b.verdict = 'unknown'
      b.confidence = 0.3
      b.evidence.push('无有效批阅符号（多为书写碎片），需人工/VLM 确认')
    }
    // 非簇路径本质仍是「数标记形态」（勾/叉/圈的形状猜测），与语义化目标相悖 ——
    // 它只在页面完全没有书写簇（如全对的作业）时兜底。此时必须标存疑并压低置信，
    // 绝不把形态猜测包装成确定结论。
    b.suspect = true
    b.evidence.push('⚠️ 无书写簇，本条按标记形态推测（未经语义确认），须人工/VLM 复核')
  }
  return blocks
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b
  const x0 = Math.max(ax, bx), y0 = Math.max(ay, by)
  const x1 = Math.min(ax + aw, bx + bw), y1 = Math.min(ay + ah, by + bh)
  const iw = Math.max(0, x1 - x0), ih = Math.max(0, y1 - y0)
  const inter = iw * ih
  const uni = aw * ah + bw * bh - inter
  return uni > 0 ? inter / uni : 0
}

/** VLM 融合：与本地框按 IoU 匹配，一致则提置信，不一致标 suspect */
export function fuseVlm(blocks: WrongqBlock[], vlmItems: VlmItem[], w = 0, h = 0): WrongqBlock[] {
  if (!vlmItems?.length) return blocks

  for (const item of vlmItems) {
    if (!item.box) continue
    let bestIdx = -1, bestIou = 0
    for (let i = 0; i < blocks.length; i++) {
      const v = iou(blocks[i].normBox, item.box)
      if (v > bestIou) { bestIou = v; bestIdx = i }
    }
    const vv = normVerdict(item.verdict)
    if (bestIdx >= 0 && bestIou >= 0.1) {
      const b = blocks[bestIdx]
      if (b.verdict === vv) {
        b.confidence = Math.max(b.confidence, 0.85)
        b.source = 'fused'
        b.evidence.push(`VLM 一致（${vv}），置信提升至 0.85`)
      } else {
        b.verdict = vv
        b.confidence = 0.5
        b.suspect = true
        b.source = 'fused'
        b.evidence.push(`⚠️ VLM(${vv}) 与本地(${b.verdict}) 不一致，须人工确认`)
      }
    } else {
      // VLM 报出题但本地无红笔证据 → 仍然输出（宁可多报，漏检静默致命）
      const nb = item.box
      blocks.push({
        id: blocks.length,
        box: {
          x0: Math.max(0, Math.round(nb[0] * w)),
          y0: Math.max(0, Math.round(nb[1] * h)),
          x1: Math.max(0, Math.round((nb[0] + nb[2]) * w) - 1),
          y1: Math.max(0, Math.round((nb[1] + nb[3]) * h) - 1),
        },
        normBox: item.box,
        col: -1,
        markIds: [],
        verdict: vv,
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
        evidence: [`VLM 报出，本地无红笔证据：${item.reason ?? ''}`],
        source: 'vlm',
        suspect: true,
      })
    }
  }
  blocks.sort((a, b) => (a.col - b.col) || (a.box.y0 - b.box.y0))
  blocks.forEach((b, i) => { b.id = i })
  return blocks
}
