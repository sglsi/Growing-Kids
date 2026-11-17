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
  /**
   * 归入本题的图形块**并集**外接框（像素；null = 本题没有可识别的图）。
   * 仅供调试与断言使用，前端不必消费——图已经并进 `stemRect`。
   */
  figureBox: SegBox | null
  /**
   * 归入本题的**每一张**图的框（⚠️ 一题多图是常态：一道大题下的 (1)(2)(3) 小题
   * 各有图，或题干配图 + 结论配图）。
   *
   * 为什么必须逐块留：`figureBox` 是并集，只要有一张图把并集撑大，另一张即使
   * **没被并进去**也会「落在并集里」——用并集做覆盖断言等于自己骗自己。断言必须
   * 逐块校验 `figureBoxes[i] ⊆ stemRect`。
   */
  figureBoxes: SegBox[]
}

/**
 * 图形块输入：来自版面分析（PP-StructureV3）的 image/chart 块。
 *
 * ⚠️ 快速通道（RapidOCR）拿不到这个——它只返回文字行，**图上没有文字**，
 *    所以在纯文本链路里「图」等于空白，按题号定位必然把图切在外面。
 */
export interface FigureSeg {
  box: SegBox
  /** 图注（`第N题图`）给出的归属题号；null/缺省 = 无图注，只能按 y 区间归 */
  label?: number | null
}

/**
 * 题号前缀识别。
 * ⚠️ 半角 `.` 必须用 `(?!\d)` 排除小数：D-049 已登记「1.5 被当题号」曾让 15 份资料
 *    整体切题失效（全库 6.3%），这里不能再犯。
 */
const RE_第N题 = /^\s*第\s*(\d{1,3})\s*题(?!\s*图)/
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
 * 「指定题号」的行首匹配（定向放宽，**只认用户请求的那一个号**）。
 *
 * 真实样本（2026-11-16，思傅真机 7/14/20 三题）：OCR 把 `14.` 的点吃掉，输出
 * `14如图，△ABC和△EPQ均是等边三角形…`，`RE_带分隔符` 要求分隔符 ⇒ 整题定位不到。
 *
 * ⛔ 不做「全表枚举裸题号」：同一张卷子的手写批注里有 `35.304`、`23=9`、`09=15`
 *    这类行，枚举会把它们当成题号（误锚比漏锚更糟，D-020 口径）。只认用户显式
 *    指定的号 ⇒ 误判面收窄到「用户自己点了这道题」。
 */
export function startsWithLabel(text: string, label: number): boolean {
  const s = String(text ?? '')
  if (!s.trim()) return false
  const re = new RegExp(
    `^\\s*${label}\\s*(?:[.．。、，,：:）)】\\]]\\s*(?!\\d)|(?=[\\u4e00-\\u9fa5A-Za-z△▲□○（(《【])|$)`,
  )
  return re.test(s)
}

/**
 * 段内拆行：段文本用 `\n` 分行（后端 `buildSegments` 保留了行边界），y 按行数均分。
 *
 * 为什么要拆：XY-Cut 会把相邻两题并成一段（真实样本里第 13、14 题的 y 区间重叠
 * 4px，被并成 `13.已知…\n14如图…`），段首题号永远是 13 ⇒ 14 整题消失。拆行后
 * 14 在行首，才可能被认出来。行数均分的 y 误差实测 4px（页高 0.25%），够用。
 */
function explodeLines(list: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of list) {
    const rows = String(s.text ?? '').split('\n')
    if (rows.length <= 1) {
      out.push(s)
      continue
    }
    const h = (s.box.y1 - s.box.y0) / rows.length
    rows.forEach((t, i) => {
      out.push({
        text: t,
        box: { x0: s.box.x0, y0: s.box.y0 + h * i, x1: s.box.x1, y1: s.box.y0 + h * (i + 1) },
        col: s.col,
      })
    })
  }
  return out
}

/** 选项行（`A.平行四边形` / `Ｂ．菱形`）—— 短但属于题目，不能被当手写截掉 */
const RE_选项行 = /^\s*[A-DＡ-Ｄ]\s*[.．、,，)）]/
/** 小题标记：`(1)` / `（1）` / `①`（一题多小题时图注写成「第7题(1)图」） */
const RE_小题标记 = '(?:[（(]\\s*\\d{1,2}\\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩])'
/** 图注行（`第7题图` / `第7题(1)图` / `图3`）—— 图形是题目的一部分，必须留在题目区 */
const RE_图注行 = new RegExp(
  `第\\s*\\d{1,3}\\s*(?:${RE_小题标记}\\s*)?题\\s*(?:${RE_小题标记}\\s*)?图|^\\s*图\\s*\\d{1,3}\\s*$`,
)

/**
 * 图注里的题号（`第14题图` → 14）；不是图注返回 null。
 *
 * 用途：图注是「这张图属于哪一题」的**显式声明**。真实卷面上，第 16 题的图
 * 会排在第 14 题的正文区间内（两图并排夹在 14/16 题干之间），只按 y 区间归题
 * 会把它判给 14 —— 这正是「14 的框把 16 的图一起圈走」的成因。
 */
function figureTitleLabel(text: string): number | null {
  const m = new RegExp(
    `第\\s*(\\d{1,3})\\s*(?:${RE_小题标记}\\s*)?题\\s*(?:${RE_小题标记}\\s*)?图`,
  ).exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}


/** 该行是否「有排版结构」（整栏宽 / 选项 / 图注）；否则视为手写批注或乱码 */
function isStructuredRow(s: Seg, fullMin: number): boolean {
  const t = String(s.text ?? '')
  const w = s.box.x1 - s.box.x0
  return w >= fullMin || RE_选项行.test(t) || RE_图注行.test(t)
}

/**
 * 找「手写 / 批注区」的起点（连续 ≥3 行没有排版结构）。
 *
 * 真实样本（2026-11-16 初三数学卷末题 20）：孩子的手写解答被 OCR 认成一串窄行
 * （`35.304`、`AB=A`、`09=15`、`OABO等膜`…），题干后紧贴。旧逻辑「末段底边」直接
 * 框到页底 1600，其中 26% 是手写 ⇒ 用户看到的就是「这题没识别出来」。
 *
 * 为什么不看置信度：前端只拿到 text+box，拿不到 score（手写行 0.52~0.83、印刷体
 * 0.93+，本来是最干净的判据）。等后端把 score 透传下来可以换掉这条启发式。
 * 为什么不看「中文占比」：`内有口ABOD`（37%）和 `又是b，下是D中`（62%）都会漏判。
 */
function handwritingStart(rows: Seg[], fullMin: number): number | null {
  let run = 0
  for (let i = 0; i < rows.length; i++) {
    if (isStructuredRow(rows[i], fullMin)) {
      run = 0
      continue
    }
    run++
    if (run >= 3) return rows[i - run + 1].box.y0
  }
  return null
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

/**
 * ── 方案 A：分节题号（思傅 2026-11-17 拍板）─────────────────────────────
 *
 * 真实卷面：`（一）6`、`（二）5,6,16,22` —— 中文数字分节 + 阿拉伯小题号。
 * 旧 `parseSeqSpec` 只认纯数字题号，分节号被吞、且不同节下的同名小题号（如
 * （一）6 与（二）6）无法区分。这里在**输入解析与定位编排层**扩展，判定层
 * `question-match.ts` 与既有正则一行不动（红线）。
 */
export interface SectionedRef {
  /** 中文节号（'一'~'十'）；null = 无分节的普通题号 */
  section: string | null
  /** 节内/整页的小题号 */
  label: number
}

const CN_SECTIONS = '一二三四五六七八九十'
const RE_SEC_MARK = /^\s*(?:[（(]\s*([一二三四五六七八九十])\s*[)）]|[（(]?\s*([一二三四五六七八九十])\s*[、.．:：])\s*/

/**
 * 解析分节题号输入：`一6,二5,二6,二16,二22` / `（一）6,(二)5` / `一、6-8`。
 * 纯数字项（如 `3`）保留为 `section:null`，走整页定位，与原路径等价。
 * 无分节标记时返回 null（调用方回落到 parseSeqSpec 老路径）。
 */
export function parseSectionedSpec(raw: string): SectionedRef[] | null {
  // `一、6` / `二：5` 的顿号/冒号是节号后缀，不是项分隔符——先归一化到节号上，
  // 避免被下面的 split 拆成两截。
  const s = String(raw ?? '')
    .trim()
    .replace(/([（(]?[一二三四五六七八九十][)）]?)\s*[、.．:：]\s*(?=\d)/g, '$1')
  if (!s) return null
  const parts = s.split(/[,，、;；\s]+/).filter(Boolean)
  if (!parts.length) return null
  const out: SectionedRef[] = []
  let hasSection = false
  for (const p of parts) {
    const m = p.match(/^(?:[（(]\s*([一二三四五六七八九十])\s*[)）]|[（(]?\s*([一二三四五六七八九十])\s*[、.．:：]?)\s*(\d{1,3})(?:\s*[-~～]\s*(\d{1,3}))?$/)
    if (m) {
      const sec = m[1] || m[2]
      if (!CN_SECTIONS.includes(sec)) return null
      const a = Number(m[3])
      const b = m[4] === undefined ? a : Number(m[4])
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a > 300 || b > 300 || a > b) return null
      if (b - a + 1 > 60) return null
      hasSection = true
      for (let i = a; i <= b; i++) out.push({ section: sec, label: i })
      continue
    }
    // 纯数字项：与 parseSeqSpec 同样的区间语义，section=null
    const q = p.match(/^(\d{1,3})(?:\s*[-~～]\s*(\d{1,3}))?$/)
    if (!q) return null
    const a = Number(q[1])
    const b = q[2] === undefined ? a : Number(q[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1 || a > 300 || b > 300 || a > b) return null
    if (b - a + 1 > 60) return null
    for (let i = a; i <= b; i++) out.push({ section: null, label: i })
  }
  if (!out.length || out.length > 60 || !hasSection) return null
  return out
}

/** 行首分节标记 → 规范中文节号；认 `（一）` / `(二)5` / `一、` / `二．` */
function segSectionMark(text: string): string | null {
  const m = RE_SEC_MARK.exec(String(text ?? ''))
  if (!m) return null
  const sec = m[1] || m[2]
  return CN_SECTIONS.includes(sec) ? sec : null
}

/** 分节区间：每个节的 y 起点，终点为下一节起点（最后一节到 +∞，由 pageH 收口） */
function sectionRanges(rows: Seg[]): Array<{ section: string; y0: number; y1: number }> {
  const marks: Array<{ section: string; y0: number }> = []
  for (const s of rows) {
    const sec = segSectionMark(s.text)
    if (!sec || marks.some((m) => m.section === sec)) continue
    marks.push({ section: sec, y0: s.box.y0 })
  }
  marks.sort((a, b) => a.y0 - b.y0)
  return marks.map((m, i) => ({ ...m, y1: i + 1 < marks.length ? marks[i + 1].y0 : Number.POSITIVE_INFINITY }))
}

/**
 * 节内题号：`（二）5` / `二5` / `二、5` 这类"节号贴着小题号"的行 → 5。
 *
 * ⚠️ 与裸号枚举的区别：这里要求**节号显式贴在数字前**，是卷面的分节声明，
 *    不是从任意行里捞数字（D-020 禁的就是后者）。仅在 scope 模式启用。
 */
function sectionedQuestionNumber(text: string, section: string): number | null {
  const s = String(text ?? '')
  const re = new RegExp(
    `^\\s*(?:[（(]\\s*${section}\\s*[)）]|${section}\\s*[、.．:：]?)\\s*(\\d{1,3})\\s*` +
      `(?:[.．。、，,：:）)】\\]]\\s*(?!\\d)|(?=[\\u4e00-\\u9fa5A-Za-z△▲□○（《【])|$)`,
  )
  const m = re.exec(s)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 1 && n <= 300 ? n : null
}

/** 节内定向题号锚点（复用 sectionedQuestionNumber，口径一致） */
function sectionedStartsWithLabel(text: string, label: number, section: string): boolean {
  return sectionedQuestionNumber(text, section) === label
}

/** 分节定位：逐节锁定 y 区间后复用已验证的 locateQuestions 切框逻辑 */
export function locateSectionedQuestions(
  segments: Seg[],
  pageW: number,
  pageH: number,
  refs: SectionedRef[],
  figures: FigureSeg[] = [],
): LocatedQuestion[] {
  const out: LocatedQuestion[] = []
  const ranges = sectionRanges(explodeLines((Array.isArray(segments) ? segments : []).filter((s) => s && s.box)))
  for (const ref of refs) {
    if (ref.section === null) {
      out.push(...locateQuestions(segments, pageW, pageH, [ref.label], figures))
      continue
    }
    const range = ranges.find((r) => r.section === ref.section)
    if (!range) {
      // 卷面没识别到该节 ⇒ fail-closed 整页候选，绝不借邻节的区间（D-020）
      out.push({
        label: ref.label,
        index: -1,
        stemRect: { x: 0, y: 0, w: 1, h: 1 },
        answerRect: null,
        located: false,
        figureBox: null,
        figureBoxes: [],
      })
      continue
    }
    out.push(
      ...locateQuestions(segments, pageW, pageH, [ref.label], figures, {
        y0: range.y0,
        y1: range.y1,
        section: ref.section,
      }),
    )
  }
  return out
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
  figures: FigureSeg[] = [],
  /** 方案 A 分节区间；不传 ⇒ 老行为逐字不变 */
  scope?: { y0: number; y1: number; section: string },
): LocatedQuestion[] {
  const list = Array.isArray(segments) ? segments.filter((s) => s && s.box) : []
  // 页面尺寸未知时无法把像素换算成比例 ⇒ 一律只给整页候选（不猜）
  const valid = pageW > 0 && pageH > 0
  // 区间底：有 scope 时用节尾收口（不跨节），否则页底
  const bottomPx = scope ? Math.min(pageH, scope.y1) : pageH
  const inScope = (y0: number): boolean =>
    !scope || (y0 >= scope.y0 && y0 < scope.y1)

  // 段落按栏分组，栏内按 y 升序（同 y 用 x 稳定排序）；同时做段内拆行（见 explodeLines）
  const byCol = new Map<number, Seg[]>()
  for (const s of list) {
    const c = Number.isFinite(s.col as number) ? (s.col as number) : 0
    const arr = byCol.get(c)
    if (arr) arr.push(s)
    else byCol.set(c, [s])
  }
  const cols = [...byCol.keys()].sort((a, b) => a - b)
  for (const c of cols) {
    const rows = explodeLines(byCol.get(c)!)
    rows.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
    byCol.set(c, rows)
  }

  // 题号锚点：记录「每个题号第一次出现」的 (栏, 栏内下标, y0) —— 全部用像素
  interface Anchor { label: number; col: number; order: number; y0: number }
  const anchors: Anchor[] = []
  for (const c of cols) {
    byCol.get(c)!.forEach((s, i) => {
      if (!inScope(s.box.y0)) return
      // scope 模式：节号贴号行（`（二）6`）也登记为锚点，保证前题框不越界吃掉本题题号
      const n = segQuestionNumber(s.text) ?? (scope ? sectionedQuestionNumber(s.text, scope.section) : null)
      if (n === null) return
      // 同题号重复出现（页眉残留等）只认第一次
      if (anchors.some((a) => a.label === n)) return
      anchors.push({ label: n, col: c, order: i, y0: s.box.y0 })
    })
  }
  // 定向兜底：用户明确要、但正规正则没认出的题号（OCR 吞了分隔符，如 `14如图`）
  for (const label of seqs) {
    if (anchors.some((a) => a.label === label)) continue
    for (const c of cols) {
      const arr = byCol.get(c)!
      const i = arr.findIndex(
        (s) =>
          inScope(s.box.y0) &&
          (startsWithLabel(s.text, label) ||
            (!!scope && sectionedStartsWithLabel(s.text, label, scope.section))),
      )
      if (i >= 0) {
        anchors.push({ label, col: c, order: i, y0: arr[i].box.y0 })
        break
      }
    }
  }

  // ── P-031 r4：图形块归题（让「图」参与定位，不再被当作空白） ──────────
  // 归属优先级：① 图注声明的题号（强信号，能纠正「16 的图排在 14 正文区间里」）
  //             ② 与该题 y 区间重叠高度最大（20 题这种无图注的图只能靠这条）
  // 两条都不成立 ⇒ 不归任何题：宁可漏图也不乱塞（与 D-020「错框比没框更糟」同口径）
  //
  // ⚠️ 图块互斥、题可多图：一个图块不得同时归两道题，但**一道题可以有多张图，
  //    必须全部并入同一题的框**。一道大题下 (1)(2)(3) 各有图、或题干配图 +
  //    结论配图都很常见，若按「一题一图」处理必然丢图。
  const anchorRange = (a: Anchor): [number, number] => {
    const next = anchors
      .filter((x) => x.col === a.col && x.y0 > a.y0)
      .sort((p, q) => p.y0 - q.y0)[0]
    return [a.y0, next ? next.y0 : bottomPx]
  }
  const figuresByLabel = new Map<number, SegBox[]>()
  const figList = (Array.isArray(figures) ? figures : []).filter(
    (f) => f && f.box && f.box.x1 > f.box.x0 && f.box.y1 > f.box.y0,
  )
  for (const f of figList) {
    let owner: number | null = null
    const declared = typeof f.label === 'number' && Number.isFinite(f.label) ? f.label : null
    if (declared !== null && anchors.some((a) => a.label === declared)) {
      owner = declared
    } else {
      let bestOv = 0
      for (const a of anchors) {
        const [lo, hi] = anchorRange(a)
        const ov = Math.min(f.box.y1, hi) - Math.max(f.box.y0, lo)
        if (ov > bestOv) {
          bestOv = ov
          owner = a.label
        }
      }
    }
    if (owner === null) continue
    const bucket = figuresByLabel.get(owner)
    if (bucket) bucket.push(f.box)
    else figuresByLabel.set(owner, [f.box])
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
        figureBox: null,
        figureBoxes: [],
      }
    }
    const arr = byCol.get(hit.col)!
    // 本题终点「上界」= 同栏下一个题号锚点的 y0（无则页底），全程像素
    const nextAnchor = anchors
      .filter((a) => a.col === hit.col && a.y0 > hit.y0)
      .sort((a, b) => a.y0 - b.y0)[0]
    const topPx = arr[hit.order].box.y0
    const boundPx = nextAnchor ? nextAnchor.y0 : bottomPx

    // ⚠️ r2（2026-11-16）：终点不能直接取 boundPx。
    //    末题没有下一锚点 ⇒ 会一路框到页底：干净试卷实测末题框高占页 70%（全是空白），
    //    用户看到的就是「位置不准」。改为「本题最后一段底边 + 半个行高」，且不超过下一题顶边。
    // ⚠️ r4：本题区间内可能夹着**别题**的图注（真实样本：16 题的图与图注都排在
    //    14 题正文区间里）。图注是别题的 ⇒ 不参与本题的 y/x 计算，否则 14 的框会
    //    一路右伸到 x=1144 把 16 的图圈进来（连带邻题）。
    const own = arr.filter((s) => {
      if (s.box.y0 < topPx || s.box.y0 >= boundPx) return false
      const tl = figureTitleLabel(s.text)
      return tl === null || tl === label
    })
    // ⚠️ r3：本题区间内若尾部跟着「手写/批注区」（连续 ≥3 行没有排版结构），
    //    末段底边就变成手写区底边 ⇒ 末题一路框到页底。真实样本第 20 题就是这么错的。
    //    栏宽基准取本栏**最宽行**（整栏行），双栏卷自动按单栏宽自适应。
    const fullMin = Math.max(...arr.map((s) => s.box.x1 - s.box.x0), 1) * 0.6
    const handPx = handwritingStart(own, fullMin)
    const body = handPx === null ? own : own.filter((s) => s.box.y0 < handPx)
    // own 可能被「排除别题图注」清空（该题区间内只剩邻题的图与图注）⇒ 退回题号行本身
    const bodyRows = body.length ? body : own.length ? own : [arr[hit.order]]

    const lastY1 = Math.max(...bodyRows.map((s) => s.box.y1))
    const padY = Math.max(4, 0.5 * (arr[hit.order].box.y1 - arr[hit.order].box.y0))
    const endPx = Math.min(boundPx, lastY1 + padY)

    // ⚠️ r2：x 也按本题题面范围收紧。原先恒为整宽（x=0,w=1）⇒ 裁出来带整条空白栏，
    //    双栏卷更糟（会把另一栏的字一起裁进图里）。留 2% 页宽余量兜住贴边图形。
    const padX = Math.max(4, 0.02 * pageW)
    let x0 = Math.min(...bodyRows.map((s) => s.box.x0)) - padX
    let x1 = Math.max(...bodyRows.map((s) => s.box.x1)) + padX

    // 解答区起点：本题区间内第一个「解答标记」段（没有 ⇒ 该题只有题目区）
    let solPx: number | null = null
    for (let i = hit.order + 1; i < arr.length; i++) {
      const s = arr[i]
      if (s.box.y0 >= endPx) break
      if (isSolutionStart(s.text)) { solPx = s.box.y0; break }
    }

    let topOut = topPx
    // 底边初值取本题正文终点（endPx）；解答区终点也是 endPx，题目区与解答区在 solPx 处切开
    let botOut = endPx

    // ── r4：把归入本题的图形块并进候选框（只外扩，绝不内缩） ──
    // 为什么要单独并：图形块**没有文字**，纯文本链路里它不存在（20 题平行四边形
    // 下半截被切掉就是这个原因）。图可以排在题干上方（16 题），因此 y0 也要能上探；
    // 但不得侵入上一题题号行 —— 那是别人题目的起点。
    // ⚠️ figs 是**数组**：(1)(2)(3) 各有图时会有多块，全部参与并集；`figureBoxes`
    //    原样留下每一块，供断言逐块验证「没有哪张图被并集掩盖而漏进框外」。
    const figs = figuresByLabel.get(label) || []
    let figBox: SegBox | null = null
    if (figs.length) {
      figBox = figs.reduce<SegBox>(
        (acc, b) => ({
          x0: Math.min(acc.x0, b.x0),
          y0: Math.min(acc.y0, b.y0),
          x1: Math.max(acc.x1, b.x1),
          y1: Math.max(acc.y1, b.y1),
        }),
        { ...figs[0] },
      )
      const prevAnchor = anchors
        .filter((a) => a.col === hit.col && a.y0 < topPx)
        .sort((p, q) => q.y0 - p.y0)[0]
      const floorY = prevAnchor ? prevAnchor.y0 : 0
      topOut = Math.max(floorY, Math.min(topPx, figBox.y0))
      botOut = Math.min(boundPx, Math.max(botOut, figBox.y1))
      x0 = Math.min(x0, figBox.x0)
      x1 = Math.max(x1, figBox.x1)
    }

    return {
      label,
      index: hit.order,
      stemRect: rect(x0, topOut, x1, solPx ?? botOut, pageW, pageH),
      answerRect: solPx === null ? null : rect(x0, solPx, x1, botOut, pageW, pageH),
      located: true,
      figureBox: figBox,
      figureBoxes: figs.slice(),
    }
  })
}

/**
 * 本页**实际识别到的题号**（按出现顺序去重）。
 *
 * 用途：定位不到时把「本页只认出了哪几题」直接告诉用户——区分「系统瞎了」与
 * 「OCR 确实没认出这个题号」，避免用户反复重试同一个必然失败的数字。
 */
export function detectedLabels(segments: Seg[], seqs: number[] = []): number[] {
  const out: number[] = []
  const rows: Seg[] = []
  for (const s of Array.isArray(segments) ? segments : []) {
    if (s) rows.push(...explodeLines([s]))
  }
  for (const s of rows) {
    const n = segQuestionNumber(s.text)
    if (n !== null) {
      if (!out.includes(n)) out.push(n)
      continue
    }
    // 定向：OCR 吞了分隔符的号（`14如图`）只对「用户本次要的题号」认，
    // 否则手写里的 `35.304` 会被当成第 35 题列出来。
    for (const label of seqs) {
      if (!out.includes(label) && startsWithLabel(s.text, label)) out.push(label)
    }
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
