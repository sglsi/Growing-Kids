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
import type { MarkKind, RedMark, WrongqBlock, WrongqVerdict } from './wrongq.types'

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

/** 纯本地判定（VLM 不可用时的主输出） */
export function decideLocal(blocks: WrongqBlock[], marks: RedMark[]): WrongqBlock[] {
  const byId = new Map<number, RedMark>()
  for (const mk of marks) byId.set(mk.id, mk)

  for (const b of blocks) {
    const kinds = new Map<MarkKind, number>()
    for (const id of b.markIds) {
      const mk = byId.get(id)
      if (!mk) continue
      kinds.set(mk.kind, (kinds.get(mk.kind) ?? 0) + 1)
    }
    const desc = [...kinds].map(([k, v]) => `${k}×${v}`).join(', ')
    b.evidence = [`红笔标记 ${b.markIds.length} 个：${desc || '无'}`]

    const neg = NEGATIVE.reduce((s, k) => s + (kinds.get(k) ?? 0), 0)
    const tick = kinds.get('tick') ?? 0
    const corr = kinds.get('correction') ?? 0

    if (neg > 0) {
      b.verdict = 'wrong'
      b.confidence = 0.6
      b.evidence.push('存在否定类标记（叉/半勾/问号/扣分）')
    } else if (corr > 0) {
      b.verdict = 'wrong'
      b.confidence = 0.55
      b.evidence.push('存在红笔订正/批注（教师改写说明原作答有误）')
    } else if (tick > 0) {
      b.verdict = 'correct'
      b.confidence = 0.5
      b.evidence.push('仅见对勾')
    } else {
      b.verdict = 'unknown'
      b.confidence = 0.3
      b.evidence.push('形态不明，需人工/VLM 确认')
    }
    b.evidence.push('⚠️ 未经语义确认（VLM 不可用），置信度为本地一阶证据')
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
