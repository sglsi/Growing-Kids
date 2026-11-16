/**
 * P-031：按题号在 OCR 段落里定位「题目区 / 解答区」候选框。
 *
 * 设计口径（对应 P-031 §2 与 Q3=B / Q4=C）：
 *  - **只给候选**，不做判定。解答区归属在纯文本上不可靠（D-012/D-013 已用 40/40 ROC
 *    证伪「相邻解析段」这类阈值硬凑），因此这里返回的是「建议框」，由用户逐题确认。
 *  - **找不到就不编框**：`located=false` 时 `stemRect` 退回整页候选并标 `unlocated`，
 *    由用户手工框（Q4=C），绝不拿相邻题的区间顶替（D-020）。
 *  - 零依赖纯函数：不引 Taro、不引任何别名，可被 Node 侧直接执行做离线实证。
 */

export interface SegBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Seg {
  text: string
  box: SegBox
  /** 所属栏（0 起）；缺省按单栏处理 */
  col?: number
}

/** 归一化裁剪框（0~1，相对页面图） */
export interface Rect01 {
  x: number
  y: number
  w: number
  h: number
}

export interface LocatedQuestion {
  /** 用户输入的题号 */
  label: number
  /** 题号在段落序列里的下标（-1 = 未定位） */
  index: number
  /** 题目区候选框 */
  stemRect: Rect01
  /** 解答区候选框（null = 该题没找到解答标记，只存题目区） */
  answerRect: Rect01 | null
  /** 是否按题号在文本里真正定位到 */
  located: boolean
}

/**
 * 题号前缀识别。
 * ⚠️ 半角 `.` 必须用 `(?!\d)` 排除小数：D-049 已登记「1.5 被当题号」曾让 15 份资料
 *    整体切题失效（全库 6.3%），这里不能再犯。
 */
const RE_第N题 = /^\s*第\s*(\d{1,3})\s*题/
const RE_带分隔符 = /^\s*(\d{1,3})\s*(?:[．。、，,：:）)】\]]|[.])\s*(?!\d)/
const RE_方括号 = /^\s*【\s*(?:例|例题|练习|习题)?\s*(\d{1,3})\s*】/

/** 解答区起点标记：「【解析】」「【答案】」「答案：」「解析：」「解：」 */
const RE_解答标记 = /^\s*(?:【\s*(?:答案|解析|解答|解)\s*】|(?:答案|解析|解答)\s*[：:]|解\s*[：:])/

/** 从段落文本里取题号；取不到返回 null */
export function segQuestionNumber(text: string): number | null {
  const s = String(text ?? '')
  for (const re of [RE_方括号, RE_第N题, RE_带分隔符]) {
    const m = s.match(re)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 1 && n <= 300) return n
    }
  }
  return null
}

/** 该段是否是解答区起点 */
export function isSolutionStart(text: string): boolean {
  return RE_解答标记.test(String(text ?? ''))
}

/**
 * 解析题号表达式：`3,5,8-12` → `[3,5,8,9,10,11,12]`。
 * 支持全角逗号/顿号/空格分隔，去重升序；空串或含非法段返回 null。
 */
export function parseSeqSpec(raw: string): number[] | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const parts = s.split(/[,，、;；\s]+/).filter(Boolean)
  if (!parts.length) return null
  const out = new Set<number>()
  for (const p of parts) {
    const m = p.match(/^(\d{1,3})(?:\s*[-~～]\s*(\d{1,3}))?$/)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a > 300 || b > 300) return null
    if (a > b) return null
    // 单次最多 60 题：与前端 MAX_BOARD_ENTRIES=30 同量级，防误输入 1-300 生成 300 张图
    if (b - a + 1 > 60) return null
    for (let i = a; i <= b; i++) out.add(i)
  }
  if (!out.size || out.size > 60) return null
  return [...out].sort((x, y) => x - y)
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 由像素四个边界合成归一化框（x 也按题面收紧，不再整宽） */
function rect(x0: number, y0: number, x1: number, y1: number, pageW: number, pageH: number): Rect01 {
  const xa = clamp01(x0 / pageW)
  const xb = clamp01(x1 / pageW)
  const ya = clamp01(y0 / pageH)
  const yb = clamp01(y1 / pageH)
  return { x: xa, y: ya, w: Math.max(xb - xa, 0.02), h: Math.max(yb - ya, 0.01) }
}

/**
 * 主函数：给定一页的 OCR 段落与用户要的题号，产出每题候选框。
 * 段落须按**阅读序**（后端已排好）；本函数按 `col` 分组后各自按 y 升序处理。
 */
export function locateQuestions(
  segments: Seg[],
  pageW: number,
  pageH: number,
  seqs: number[],
): LocatedQuestion[] {
  const list = Array.isArray(segments) ? segments.filter((s) => s && s.box) : []
  // 页面尺寸未知时无法把像素换算成比例 ⇒ 一律只给整页候选（不猜）
  const valid = pageW > 0 && pageH > 0

  // 段落按栏分组，栏内按 y 升序（同 y 用 x 稳定排序）
  const byCol = new Map<number, Seg[]>()
  for (const s of list) {
    const c = Number.isFinite(s.col as number) ? (s.col as number) : 0
    const arr = byCol.get(c)
    if (arr) arr.push(s)
    else byCol.set(c, [s])
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b)
  for (const c of cols) {
    byCol.get(c)!.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
  }

  // 题号锚点：记录「每个题号第一次出现」的 (栏, 栏内下标, y0) —— 全部用像素
  interface Anchor { label: number; col: number; order: number; y0: number }
  const anchors: Anchor[] = []
  for (const c of cols) {
    const arr = byCol.get(c)!
    arr.forEach((s, i) => {
      const n = segQuestionNumber(s.text)
      if (n === null) return
      // 同题号重复出现（页眉残留等）只认第一次
      if (anchors.some((a) => a.label === n)) return
      anchors.push({ label: n, col: c, order: i, y0: s.box.y0 })
    })
  }

  return seqs.map((label) => {
    const hit = anchors.find((a) => a.label === label)
    if (!hit || !valid) {
      // Q4=C：定位不到 ⇒ 给整页候选，由用户手工框；不借用任何相邻题的区间（D-020）
      return {
        label,
        index: hit ? hit.order : -1,
        stemRect: { x: 0, y: 0, w: 1, h: 1 },
        answerRect: null,
        located: !!hit,
      }
    }
    const arr = byCol.get(hit.col)!
    // 本题终点「上界」= 同栏下一个题号锚点的 y0（无则页底），全程像素
    const nextAnchor = anchors
      .filter((a) => a.col === hit.col && a.y0 > hit.y0)
      .sort((a, b) => a.y0 - b.y0)[0]
    const topPx = arr[hit.order].box.y0
    const boundPx = nextAnchor ? nextAnchor.y0 : pageH

    // ⚠️ r2（2026-11-16）：终点不能直接取 boundPx。
    //    末题没有下一锚点 ⇒ 会一路框到页底：干净试卷实测末题框高占页 70%（全是空白），
    //    用户看到的就是「位置不准」。改为「本题最后一段底边 + 半个行高」，且不超过下一题顶边。
    const own = arr.filter((s) => s.box.y0 >= topPx && s.box.y0 < boundPx)
    const lastY1 = Math.max(...own.map((s) => s.box.y1))
    const padY = Math.max(4, 0.5 * (arr[hit.order].box.y1 - arr[hit.order].box.y0))
    const endPx = Math.min(boundPx, lastY1 + padY)

    // ⚠️ r2：x 也按本题题面范围收紧。原先恒为整宽（x=0,w=1）⇒ 裁出来带整条空白栏，
    //    双栏卷更糟（会把另一栏的字一起裁进图里）。留 2% 页宽余量兜住贴边图形。
    const padX = Math.max(4, 0.02 * pageW)
    const x0 = Math.min(...own.map((s) => s.box.x0)) - padX
    const x1 = Math.max(...own.map((s) => s.box.x1)) + padX

    // 解答区起点：本题区间内第一个「解答标记」段（没有 ⇒ 该题只有题目区）
    let solPx: number | null = null
    for (let i = hit.order + 1; i < arr.length; i++) {
      const s = arr[i]
      if (s.box.y0 >= endPx) break
      if (isSolutionStart(s.text)) { solPx = s.box.y0; break }
    }

    return {
      label,
      index: hit.order,
      stemRect: rect(x0, topPx, x1, solPx ?? endPx, pageW, pageH),
      answerRect: solPx === null ? null : rect(x0, solPx, x1, endPx, pageW, pageH),
      located: true,
    }
  })
}

/**
 * 本页**实际识别到的题号**（按出现顺序去重）。
 *
 * 用途：定位不到时把「本页只认出了哪几题」直接告诉用户——区分「系统瞎了」与
 * 「OCR 确实没认出这个题号」，避免用户反复重试同一个必然失败的数字。
 */
export function detectedLabels(segments: Seg[]): number[] {
  const out: number[] = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!s) continue
    const n = segQuestionNumber(s.text)
    if (n !== null && !out.includes(n)) out.push(n)
  }
  return out
}

/** 段落的像素外接框（用于把「多段解答」合并时取整体） */
export function unionBox(segs: Seg[]): SegBox | null {
  const list = (segs || []).filter((s) => s && s.box)
  if (!list.length) return null
  return list.reduce<SegBox>(
    (acc, s) => ({
      x0: Math.min(acc.x0, s.box.x0),
      y0: Math.min(acc.y0, s.box.y0),
      x1: Math.max(acc.x1, s.box.x1),
      y1: Math.max(acc.y1, s.box.y1),
    }),
    { ...list[0].box },
  )
}
