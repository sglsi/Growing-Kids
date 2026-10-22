/**
 * 端上 LaTeX 子集 → 微信小程序 rich-text 节点（思傅 2026-10-22 选「端上自研转换器」）
 *
 * 背景：katex 直接输出无法用于小程序 rich-text，实测三个硬伤——
 *   ① 根号是 <svg><path/></svg>，rich-text 受信任标签里没有 svg，根号整个消失；
 *   ② 分数线/间距靠 katex.css 的 class 与伪元素（.frac-line / .vlist-s::after），
 *      rich-text 只认内联 style、不支持伪元素，样式全丢；
 *   ③ 依赖 KaTeX woff2 字体包，小程序里加载不了，字形错乱。
 * 因此这里自己实现「解析 + 排版」，借鉴 katex 的 vlist 思路（inline-block 上下堆叠 +
 * 负 margin 对齐），但只输出 rich-text 认的内联 style span 树，零依赖、离线可用。
 *
 * 边界：只覆盖中小学常见子集（分数/根号/上下标/希腊字母/运算符/上下划线/函数体）。
 * 遇到不支持的语法**整段回退显示源码**（由调用方 MathText 处理），绝不显示错误的数学式。
 *
 * ⚠️ 本文件保持零 import（纯函数），便于用 tsc 单独编译后在 node 里单测。
 */

// ---------------- 对外类型 ----------------

/** rich-text 文本节点 */
export type RichTextNode =
  | { type: 'text'; text: string }
  /** rich-text 元素节点（attrs 只放内联 style，class 在 rich-text 内不生效） */
  | { type: 'node'; name: string; attrs?: { style?: string }; children?: RichTextNode[] }

/** 中间 AST */
export type MathNode =
  | { t: 'text'; v: string } // 字面文本（数字、标点、\text{} 内容）
  | { t: 'ord'; v: string; italic?: boolean } // 单字母变量（数学惯例用斜体）
  | { t: 'op'; v: string; pad?: boolean } // 运算符/关系符（两侧留白）
  | { t: 'group'; kids: MathNode[] } // { } 分组
  | { t: 'frac'; num: MathNode[]; den: MathNode[] }
  | { t: 'sqrt'; body: MathNode[]; index?: MathNode[] }
  | { t: 'script'; base: MathNode | null; sup?: MathNode[]; sub?: MathNode[] }
  | { t: 'deco'; kind: 'overline' | 'underline'; body: MathNode[] }
  | { t: 'style'; kind: 'bold' | 'italic' | 'normal'; body: MathNode[] }
  | { t: 'space'; w: string } // \, \; \quad 等间距

export class UnsupportedLatexError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'UnsupportedLatexError'
  }
}

// ---------------- 符号表 ----------------

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const OPS: Record<string, string> = {
  times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', bullet: '∙', circ: '○',
  pm: '±', mp: '∓', oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', doteq: '≐',
  ll: '≪', gg: '≫',
  infty: '∞', partial: '∂', nabla: '∇', aleph: 'ℵ',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧',
  lor: '∨', wedge: '∧', vee: '∨',
  cap: '∩', cup: '∪', uplus: '⊎', setminus: '∖',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆',
  supseteq: '⊇', emptyset: '∅', varnothing: '∅',
  angle: '∠', measuredangle: '∡', triangle: '△', square: '□', bigcirc: '○',
  perp: '⊥', parallel: '∥', mid: '∣', nmid: '∤',
  therefore: '∴', because: '∵', degree: '°', prime: '′', dagger: '†',
  ddagger: '‡', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
  to: '→', rightarrow: '→', longrightarrow: '⟶', leftarrow: '←',
  longleftarrow: '⟵', uparrow: '↑', downarrow: '↓', leftrightarrow: '↔',
  updownarrow: '↕', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  implies: '⇒', impliedby: '⇐', iff: '⇔', mapsto: '↦', rightsquigarrow: '⇝',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  bigoplus: '⨁', bigotimes: '⨂',
  langle: '⟨', rangle: '⟩', lVert: '‖', rVert: '‖', vert: '|', Vert: '‖',
}

/**  upright 函数名（\sin \log \lim …）—— 数学排版惯例：函数体正体不斜体 */
const FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp',
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf',
  'det', 'dim', 'deg', 'arg', 'gcd', 'hom', 'ker', 'Pr', 'sec',
])

const FRACS = new Set(['frac', 'dfrac', 'tfrac', 'cfrac'])

/** 间距命令 → em */
const SPACES: Record<string, string> = {
  ',': '0.1667em', thinspace: '0.1667em',
  ':': '0.2222em', medspace: '0.2222em',
  ';': '0.2778em', thickspace: '0.2778em',
  '!': '-0.1667em', negthinspace: '-0.1667em',
  quad: '1em', qquad: '2em', enspace: '0.5em',
  ' ': '0.25em',
}

/** \left \right \big 系列：只吃掉命令本身，后面的定界符由主循环当普通字符解析 */
const DELIM_WRAPPERS = new Set([
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
])

/** 黑板粗体常用集合（\mathbb{R} → ℝ），未知的降级为正体字母 */
const BLACKBOARD: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ',
}

// ---------------- 解析器 ----------------

class Parser {
  private s: string
  private i = 0

  constructor(src: string) {
    this.s = src
  }

  parse(endAtBrace = false): MathNode[] {
    const out: MathNode[] = []
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === '}') {
        if (endAtBrace) return out
        throw new UnsupportedLatexError('多余的 }')
      }
      if (c === '{') {
        this.i++
        out.push({ t: 'group', kids: this.parse(true) })
        this.expect('}')
        continue
      }
      if (c === '^' || c === '_') {
        const base = out.length ? (out.pop() as MathNode) : null
        let sup: MathNode[] | undefined
        let sub: MathNode[] | undefined
        // 支持 x^2、x_1、x_1^2、x^2_1（两种顺序）
        while (this.i < this.s.length && (this.s[this.i] === '^' || this.s[this.i] === '_')) {
          const kind = this.s[this.i++]
          const arg = this.parseArg()
          if (kind === '^') sup = arg
          else sub = arg
        }
        out.push({ t: 'script', base, sup, sub })
        continue
      }
      if (c === '\\') {
        for (const n of this.parseCommand()) out.push(n)
        continue
      }
      if (c === '&' || c === '#') throw new UnsupportedLatexError(`不支持的字符 ${c}`)
      for (const n of this.parsePlain()) out.push(n)
    }
    if (endAtBrace) throw new UnsupportedLatexError('缺少 }')
    return out
  }

  /** 单个实参：{组} 或 单个符号 */
  private parseArg(): MathNode[] {
    if (this.i >= this.s.length) throw new UnsupportedLatexError('缺少参数')
    const c = this.s[this.i]
    if (c === '{') {
      this.i++
      const kids = this.parse(true)
      this.expect('}')
      return kids
    }
    if (c === '\\') return this.parseCommand()
    return this.parsePlain()
  }

  /** 普通字符：数字成串、字母斜体、运算符留白 */
  private parsePlain(): MathNode[] {
    const ch = this.s[this.i]
    if (/\d/.test(ch)) {
      let d = ''
      while (this.i < this.s.length && /\d/.test(this.s[this.i])) d += this.s[this.i++]
      // 小数：3.14 当成一个整体，避免 3 . 14 被拆开
      if (this.s[this.i] === '.' && /\d/.test(this.s[this.i + 1] || '')) {
        d += '.'
        this.i++
        while (this.i < this.s.length && /\d/.test(this.s[this.i])) d += this.s[this.i++]
      }
      return [{ t: 'text', v: d }]
    }
    this.i++
    if (/[a-zA-Z]/.test(ch)) return [{ t: 'ord', v: ch, italic: true }]
    if ('+-*/=<>|±×÷'.includes(ch)) return [{ t: 'op', v: ch, pad: true }]
    if ('()[]⌈⌉⌊⌋'.includes(ch)) return [{ t: 'op', v: ch }]
    return [{ t: 'text', v: ch }]
  }

  private parseCommand(): MathNode[] {
    this.i++ // 吃掉反斜杠
    let name = ''
    const c = this.s[this.i]
    if (c && /[a-zA-Z]/.test(c)) {
      while (this.i < this.s.length && /[a-zA-Z]/.test(this.s[this.i])) name += this.s[this.i++]
    } else if (c !== undefined) {
      name = this.s[this.i++] // 单字符命令：\, \{ \% \\ 等
    }
    if (!name) throw new UnsupportedLatexError('空命令')

    if (SPACES[name] !== undefined) return [{ t: 'space', w: SPACES[name] }]

    if (name === 'sqrt') {
      let index: MathNode[] | undefined
      if (this.s[this.i] === '[') {
        this.i++
        let buf = ''
        while (this.i < this.s.length && this.s[this.i] !== ']') buf += this.s[this.i++]
        this.expect(']')
        index = new Parser(buf).parse(false)
      }
      return [{ t: 'sqrt', body: this.parseArg(), index }]
    }

    if (FRACS.has(name)) {
      const num = this.parseArg()
      const den = this.parseArg()
      return [{ t: 'frac', num, den }]
    }

    if (name === 'overline' || name === 'underline') {
      return [{ t: 'deco', kind: name, body: this.parseArg() }]
    }

    if (name === 'text' || name === 'textrm' || name === 'mathrm') {
      return [{ t: 'style', kind: 'normal', body: this.parseArg() }]
    }
    if (name === 'mathbf' || name === 'textbf' || name === 'boldsymbol' || name === 'bm') {
      return [{ t: 'style', kind: 'bold', body: this.parseArg() }]
    }
    if (name === 'mathit' || name === 'textit' || name === 'emph') {
      return [{ t: 'style', kind: 'italic', body: this.parseArg() }]
    }
    if (name === 'mathbb') {
      return [{ t: 'style', kind: 'normal', body: mapBlackboard(this.parseArg()) }]
    }

    if (DELIM_WRAPPERS.has(name)) {
      // \left( / \right) 的定界符交给主循环解析；\left. / \right. 是空定界符，直接吃掉
      if (this.s[this.i] === '.') this.i++
      return []
    }

    if (GREEK[name]) return [{ t: 'text', v: GREEK[name] }]
    if (OPS[name]) return [{ t: 'op', v: OPS[name], pad: true }]
    if (FUNCS.has(name)) return [{ t: 'style', kind: 'normal', body: [{ t: 'text', v: name }] }]
    if (['%', '$', '#', '&', '_', '^', '{', '}', ' '].includes(name)) return [{ t: 'text', v: name }]

    throw new UnsupportedLatexError(`\\${name}`)
  }

  private expect(ch: string) {
    if (this.s[this.i] !== ch) throw new UnsupportedLatexError(`期望 ${ch}`)
    this.i++
  }
}

function mapBlackbodyChar(v: string): string {
  return BLACKBOARD[v] || v
}

/** \mathbb{...}：把单字母映射成 ℝ/ℕ/ℤ…，其它保持原样 */
function mapBlackboard(nodes: MathNode[]): MathNode[] {
  return nodes.map((n) => {
    if (n.t === 'ord') return { t: 'ord', v: mapBlackbodyChar(n.v), italic: false } as MathNode
    if (n.t === 'group' || n.t === 'style') {
      const kids = n.t === 'group' ? n.kids : n.body
      const mapped = mapBlackboard(kids)
      return n.t === 'group' ? ({ t: 'group', kids: mapped } as MathNode) : ({ t: 'style', kind: n.kind, body: mapped } as MathNode)
    }
    return n
  })
}

// ---------------- AST → rich-text 节点 ----------------

const txt = (v: string): RichTextNode => ({ type: 'text', text: v })
const span = (style: string, children: RichTextNode[] = []): RichTextNode => ({
  type: 'node',
  name: 'span',
  attrs: { style },
  children,
})

function toRich(nodes: MathNode[], color: string): RichTextNode[] {
  const out: RichTextNode[] = []
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out.push(txt(n.v))
        break
      case 'ord':
        out.push(span(n.italic ? 'font-style:italic' : 'font-style:normal', [txt(n.v)]))
        break
      case 'op':
        out.push(span(n.pad ? 'margin:0 0.15em;font-style:normal' : 'font-style:normal', [txt(n.v)]))
        break
      case 'group':
        out.push(...toRich(n.kids, color))
        break
      case 'style': {
        const st = n.kind === 'bold' ? 'font-weight:bold' : n.kind === 'italic' ? 'font-style:italic' : 'font-style:normal'
        out.push(span(st, toRich(n.body, color)))
        break
      }
      case 'space':
        out.push(span(`display:inline-block;margin-left:${n.w}`))
        break
      case 'deco': {
        const border = n.kind === 'overline' ? 'border-top' : 'border-bottom'
        out.push(span(`display:inline-block;${border}:1px solid ${color};padding-${n.kind === 'overline' ? 'top' : 'bottom'}:0.08em`, toRich(n.body, color)))
        break
      }
      // 分数：真正的上下两层 + 中间分数线（借鉴 katex 的 frac-line）
      case 'frac':
        out.push(
          span('display:inline-block;vertical-align:middle;text-align:center;margin:0 0.12em', [
            span(`display:block;padding:0.02em 0.28em;border-bottom:1px solid ${color}`, toRich(n.num, color)),
            span('display:block;padding:0.02em 0.28em', toRich(n.den, color)),
          ]),
        )
        break
      // 根号：rich-text 不支持 svg，改用 √ 字形 + 被开方式顶部横线（最接近的近似）
      case 'sqrt': {
        const kids: RichTextNode[] = []
        if (n.index && n.index.length) {
          kids.push(span('font-size:0.6em;vertical-align:super;margin-right:0.08em', toRich(n.index, color)))
        }
        kids.push(span('font-size:1.15em;line-height:1', [txt('√')]))
        kids.push(
          span(`display:inline-block;border-top:1px solid ${color};padding:0.1em 0.16em 0 0.12em;margin-left:-0.06em`, toRich(n.body, color)),
        )
        out.push(span('display:inline-block;vertical-align:middle', kids))
        break
      }
      case 'script': {
        if (n.base) out.push(...toRich([n.base], color))
        if (n.sup && n.sub) {
          // 上下标同时存在：两个小字块上下堆叠（katex 的 vlist 思路）
          out.push(
            span('display:inline-block;font-size:0.72em;line-height:1.15;vertical-align:middle;text-align:left', [
              span('display:block', toRich(n.sup, color)),
              span('display:block', toRich(n.sub, color)),
            ]),
          )
        } else if (n.sup) {
          out.push(span('font-size:0.72em;vertical-align:super;line-height:1', toRich(n.sup, color)))
        } else if (n.sub) {
          out.push(span('font-size:0.72em;vertical-align:sub;line-height:1', toRich(n.sub, color)))
        }
        break
      }
    }
  }
  return out
}

/**
 * 一段 LaTeX → rich-text 节点；不支持则返回 null（调用方回退显示源码）。
 */
export function mathToNodes(src: string, color: string): RichTextNode[] | null {
  const s = (src || '').trim()
  if (!s) return null
  try {
    const ast = new Parser(s).parse(false)
    if (!ast.length) return null
    return toRich(ast, color)
  } catch (e) {
    if (e instanceof UnsupportedLatexError) return null
    return null
  }
}

// ---------------- 文本切分：普通文字 / 行内公式 / 行间公式 ----------------

export interface MathPiece {
  kind: 'text' | 'math'
  v: string
  /** 行间公式（$$…$$ 或 \[…\]），独占一行并居中 */
  display?: boolean
}

/** 把一整段文本切成若干「行」，每行再切成文字/公式片段 */
export function splitMathText(text: string): MathPiece[][] {
  const lines: MathPiece[][] = []
  const src = text || ''

  const pushTextChunk = (chunk: string) => {
    if (!chunk) return
    for (const line of chunk.split('\n')) {
      lines.push(splitInlineMath(line))
    }
  }

  // 先切行间公式（$$…$$ / \[…\]），它独占一行
  const displayRe = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = displayRe.exec(src))) {
    pushTextChunk(src.slice(last, m.index))
    lines.push([{ kind: 'math', v: (m[1] ?? m[2] ?? '').trim(), display: true }])
    last = m.index + m[0].length
  }
  pushTextChunk(src.slice(last))

  return lines.length ? lines : [[]]
}

/** 行内：$…$ 与 \(…\) */
function splitInlineMath(line: string): MathPiece[] {
  const out: MathPiece[] = []
  const re = /\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ kind: 'text', v: line.slice(last, m.index) })
    out.push({ kind: 'math', v: (m[1] ?? m[2] ?? '').trim() })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ kind: 'text', v: line.slice(last) })
  return out
}

/** 整行是否含公式 */
export function lineHasMath(line: MathPiece[]): boolean {
  return line.some((p) => p.kind === 'math')
}

/**
 * 一行 → rich-text 的 div 节点（含字号/颜色/行高）。
 * 任一段公式解析失败 → 返回 null（整行回退源码，避免显示错误的数学式）。
 */
export function lineToNodes(
  line: MathPiece[],
  opts: { size: number; color: string; lineHeight: number },
): RichTextNode[] | null {
  const kids: RichTextNode[] = []
  let display = false
  for (const p of line) {
    if (p.kind === 'text') {
      if (p.v) kids.push(txt(p.v))
      continue
    }
    const nodes = mathToNodes(p.v, opts.color)
    if (!nodes) return null
    if (p.display) display = true
    for (const n of nodes) kids.push(n)
  }
  if (!kids.length) return null
  const div: RichTextNode = {
    type: 'node',
    name: 'div',
    attrs: {
      style: `font-size:${opts.size}px;color:${opts.color};line-height:${opts.lineHeight};word-break:break-word;${display ? 'text-align:center;margin:4px 0;' : ''}`,
    },
    children: kids,
  }
  return [div]
}
