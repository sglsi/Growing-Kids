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
  // 上方装饰（向量箭头/帽/点）：rich-text 不支持 svg，用「上方小字符」近似
  | { t: 'accent'; kind: 'arrow' | 'hat' | 'widehat' | 'dot' | 'ddot'; body: MathNode[]; dir?: 'l' | 'r' | 'lr' }
  | { t: 'binom'; top: MathNode[]; bottom: MathNode[] } // 组合数：圆括号版分数
  | { t: 'env'; name: string; rows: MathNode[][][] } // \begin{cases}/aligned/matrix 等环境

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
  // 度量符号：百分号/千分号（\% 走单字符命令通道，\permil 在此映射）
  permil: '‰', percent: '%',
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
  // 集合的否定与补（高中集合运算）
  complement: '∁', subsetneq: '⊊', supsetneq: '⊋', varsubsetneq: '⊊',
  nleq: '≰', ngeq: '≱', nsim: '≁', ncong: '≆', napprox: '≉',
  nsubset: '⊄', nsupset: '⊅', nsubseteq: '⊈', nsupseteq: '⊉',
  nequiv: '≢', nparallel: '∦', notni: '∌',
  // 其它常用
  box: '□', blacksquare: '■', lozenge: '◇', diamond: '◇',
  checkmark: '✓', circledS: 'Ⓢ', wr: '≀',
}

/**  upright 函数名（\sin \log \lim …）—— 数学排版惯例：函数体正体不斜体 */
const FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'arccot', 'arcsec', 'arccsc',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp',
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf',
  'det', 'dim', 'deg', 'arg', 'gcd', 'lcm', 'hom', 'ker', 'Pr',
])

/** \not 前缀：与后面的运算符组合成否定形式（\not= → ≠、\not\in → ∉） */
const NOT_MAP: Record<string, string> = {
  '=': '≠', '<': '≮', '>': '≯', leq: '≰', le: '≰', geq: '≱', ge: '≱',
  in: '∉', ni: '∌', exists: '∄', equiv: '≢', sim: '≁', cong: '≆',
  approx: '≉', subset: '⊄', supset: '⊅', subseteq: '⊈', supseteq: '⊉',
  mid: '∤', nmid: '∤', parallel: '∦', nparallel: '∦',
}

/** 解析时直接忽略的命令（只影响显示样式/间距，视觉上可忽略） */
const IGNORED_CMDS = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'limits', 'nolimits', 'ensuremath', 'relax', 'allowbreak',
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
        // ⚠️ 度数特例：90^\circ 的 \circ 应渲染成 ° 而不是 ○（圆圈运算符）。
        // 2026-10-23 修：此前 OPS 表把 \circ 一律映射成 ○，导致 90^\circ 显示成 90○。
        // ⚠️ 修这个 bug 时曾把 base 吞掉（90^\circ → °），必须先把 base 放回去。
        if (sup && sup.length === 1 && sup[0].t === 'op' && sup[0].v === '○') {
          if (base) out.push(base)
          out.push({ t: 'op', v: '°', pad: false })
          continue
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

    // ---------- 高中高频结构型命令 ----------
    // 向量：\vec{a} / \overrightarrow{AB} / \overleftarrow{AB} / \overleftrightarrow{AB}
    if (name === 'vec' || name === 'overrightarrow' || name === 'overleftarrow' || name === 'overleftrightarrow') {
      const dir = name === 'overleftarrow' ? 'l' : name === 'overleftrightarrow' ? 'lr' : 'r'
      return [{ t: 'accent', kind: 'arrow', dir, body: this.parseArg() }]
    }
    // 帽/弧：\hat{x}（统计估计量）/ \widehat{AB}（弧）
    if (name === 'hat' || name === 'widehat') {
      return [{ t: 'accent', kind: name, body: this.parseArg() }]
    }
    // 点的导数记号：\dot{x} \ddot{x}
    if (name === 'dot' || name === 'ddot') {
      return [{ t: 'accent', kind: name, body: this.parseArg() }]
    }
    // \bar{z} 是共轭复数的常用写法（\overline 的别名）
    if (name === 'bar' || name === 'overline') {
      return [{ t: 'deco', kind: 'overline', body: this.parseArg() }]
    }
    // 组合数：\binom{n}{k}（二项式定理、概率分布）
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      return [{ t: 'binom', top: this.parseArg(), bottom: this.parseArg() }]
    }
    // 同余：a \equiv b \pmod{m}
    if (name === 'pmod' || name === 'pod') {
      return [{ t: 'style', kind: 'normal', body: [{ t: 'text', v: '(mod ' }, ...this.parseArg(), { t: 'text', v: ')' }] }]
    }
    if (name === 'bmod' || name === 'mod') {
      return [{ t: 'style', kind: 'normal', body: [{ t: 'text', v: ' mod ' }] }]
    }
    // 否定前缀：\not= → ≠、\not\in → ∉
    if (name === 'not') {
      let next = ''
      if (this.s[this.i] === '\\') {
        this.i++
        if (/[a-zA-Z]/.test(this.s[this.i] || '')) {
          while (this.i < this.s.length && /[a-zA-Z]/.test(this.s[this.i])) next += this.s[this.i++]
        } else if (this.i < this.s.length) next = this.s[this.i++]
      } else if (this.i < this.s.length) next = this.s[this.i++]
      const neg = NOT_MAP[next]
      if (!neg) throw new UnsupportedLatexError(`\\not ${next}`)
      return [{ t: 'op', v: neg, pad: true }]
    }
    // 绝对值专用定界符
    if (name === 'lvert' || name === 'rvert') return [{ t: 'op', v: '|' }]
    if (name === 'lbrace' || name === 'rbrace') return [{ t: 'text', v: name === 'lbrace' ? '{' : '}' }]
    if (name === 'lbrack' || name === 'rbrack') return [{ t: 'text', v: name === 'lbrack' ? '[' : ']' }]
    if (name === 'lfloor' || name === 'rfloor') return [{ t: 'text', v: name === 'lfloor' ? '⌊' : '⌋' }]
    if (name === 'lceil' || name === 'rceil') return [{ t: 'text', v: name === 'lceil' ? '⌈' : '⌉' }]
    // 环境：\begin{cases}…\end{cases}（分段函数）、aligned（多行推导）、pmatrix/bmatrix（矩阵）
    if (name === 'begin') {
      const env = this.readRawGroup()
      const end = `\\end{${env}}`
      const idx = this.s.indexOf(end, this.i)
      if (idx < 0) throw new UnsupportedLatexError(`缺少 ${end}`)
      const bodyStr = this.s.slice(this.i, idx)
      this.i = idx + end.length
      const rows: MathNode[][][] = []
      // 按 \\ 分行、按 & 分列；空行/空列保留结构
      for (const rowStr of bodyStr.split(/\\\\/)) {
        rows.push(rowStr.split('&').map((c) => new Parser(c).parse(false)))
      }
      if (!rows.length) throw new UnsupportedLatexError('空环境')
      return [{ t: 'env', name: env, rows }]
    }
    if (IGNORED_CMDS.has(name)) return []

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

  /** 原样读一个 {…} 分组的内容（不做解析），用于 \begin{env} 的环境名 */
  private readRawGroup(): string {
    this.expect('{')
    let depth = 1
    const start = this.i
    while (this.i < this.s.length && depth > 0) {
      const ch = this.s[this.i]
      if (ch === '\\') {
        this.i += 2 // 跳过转义，避免 \{ \} 干扰配对
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
      this.i++
    }
    if (depth !== 0) throw new UnsupportedLatexError('缺少 }')
    return this.s.slice(start, this.i - 1)
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

/** 单元格内容：空单元格填一个窄空格，防止 inline-block 塌陷 */
function cellNodes(nodes: MathNode[], color: string): RichTextNode[] {
  const r = toRich(nodes, color)
  return r.length ? r : [txt('\u2009')]
}

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
      // 上方装饰：向量箭头 / 帽 / 弧 / 点（rich-text 无 svg，用「上方小字符」近似）
      case 'accent': {
        const glyph =
          n.kind === 'arrow'
            ? n.dir === 'l' ? '←' : n.dir === 'lr' ? '↔' : '→'
            : n.kind === 'hat' ? '^'
            : n.kind === 'widehat' ? '⌢'
            : n.kind === 'dot' ? '·'
            : '¨'
        out.push(
          span('display:inline-block;vertical-align:middle;text-align:center', [
            span('display:block;font-size:0.78em;line-height:1.15;height:0.78em', [txt(glyph)]),
            span('display:block;line-height:1.1', cellNodes(n.body, color)),
          ]),
        )
        break
      }
      // 组合数：圆括号包住的上下两层（分数线不出头，圆括号比 frac 高）
      case 'binom': {
        out.push(
          span('display:inline-block;vertical-align:middle;margin:0 0.1em', [
            span('display:inline-block;font-size:1.2em;vertical-align:middle;font-weight:300', [txt('(')]),
            span('display:inline-block;vertical-align:middle;text-align:center', [
              span(`display:block;padding:0.02em 0.28em;border-bottom:1px solid ${color}`, toRich(n.top, color)),
              span('display:block;padding:0.02em 0.28em', toRich(n.bottom, color)),
            ]),
            span('display:inline-block;font-size:1.2em;vertical-align:middle;font-weight:300', [txt(')')]),
          ]),
        )
        break
      }
      // 环境：cases（分段函数）/ aligned（多行推导）/ pmatrix bmatrix vmatrix（矩阵）
      case 'env': {
        const stack = span('display:flex;flex-direction:column;justify-content:center;margin:0 0.25em', n.rows.map((row) =>
          span('display:flex;flex-direction:row;align-items:center;min-height:1.45em', row.map((cell) =>
            span('display:inline-block;vertical-align:middle', cellNodes(cell, color)),
          )),
        ))
        const e = n.name
        const delim = (ch: string) => span('display:inline-block;font-size:1.9em;line-height:1;font-weight:300', [txt(ch)])
        if (e === 'cases' || e === 'dcases' || e === 'rcases') {
          // 左花括号（用大字号拉伸近似）
          out.push(span('display:inline-flex;align-items:center;vertical-align:middle', [delim('{'), stack]))
        } else if (e === 'pmatrix' || e === 'bmatrix' || e === 'vmatrix' || e === 'Bmatrix' || e === 'Vmatrix') {
          const ch = e.startsWith('p') ? '(' : e.startsWith('b') ? '[' : e.startsWith('B') ? '{' : '|'
          out.push(span('display:inline-flex;align-items:center;vertical-align:middle', [delim(ch), stack, delim(ch)]))
        } else if (e === 'array') {
          out.push(stack)
        } else if (e === 'aligned' || e === 'align' || e === 'alignedat' || e === 'gathered' || e === 'gather' || e === 'equation' || e === 'split') {
          out.push(stack)
        } else {
          throw new UnsupportedLatexError(`begin{${e}}`)
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

// ---------------- LaTeX ↔ 人类可读形式 ----------------
//
// 思傅 2026-10-23：源码用户看不懂也编辑不了，编辑界面不能出现 \frac{...} 这类命令。
// 因此编辑态把 LaTeX 转成"认识的符号"（1/2、√3、x²、∠ABC、→a），
// 保存时再尽量转回标准 LaTeX，保住展示层的真分数/真根号效果。
//
// 设计原则：
//   - latexToReadable 复用上面的 Parser（AST → 字符串），不重新发明解析
//   - readableToLatex 只处理明确的模式，认不出的原样保留（绝不猜测）
//   - 往返目标：readableToLatex(latexToReadable(x)) 与 x 渲染结果一致

/** 上标 unicode（x^2 → x²） */
const SUP_UNICODE: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ', '(': '⁽', ')': '⁾',
}
/** 下标 unicode（a_1 → a₁） */
const SUB_UNICODE: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', a: 'ₐ', e: 'ₑ', i: 'ᵢ', o: 'ₒ', x: 'ₓ', n: 'ₙ',
  '(': '₍', ')': '₎',
}

/** AST → 人类可读字符串 */
function toReadable(nodes: MathNode[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
      case 'ord':
      case 'op':
        out += n.v
        break
      case 'group':
        out += toReadable(n.kids)
        break
      case 'style':
        out += toReadable(n.body)
        break
      case 'space':
        out += ' '
        break
      case 'frac':
        out += `${wrapReadable(toReadable(n.num))}/${wrapReadable(toReadable(n.den))}`
        break
      case 'sqrt': {
        // 根指数：3 → ∛ 字形（回转时按字面文本保留，渲染正确）；
        // 其它指数（n√x）退化为「指数+根号」字面形式，渲染视觉正确但不规范。
        const idx = n.index && n.index.length ? toReadable(n.index) : ''
        const prefix = idx === '3' ? '∛' : idx ? `${idx}√` : '√'
        out += `${prefix}${wrapReadable(toReadable(n.body))}`
        break
      }
      case 'script': {
        if (n.base) out += toReadable([n.base])
        // 先下标后上标（阅读顺序 x₁²、∑_(i=1)ⁿ；两种顺序都能被
        // readableToLatex 正确回转，这里选更符合书写习惯的一种）
        if (n.sub) out += subToReadable(toReadable(n.sub))
        if (n.sup) out += supToReadable(toReadable(n.sup))
        break
      }
      case 'accent': {
        const body = toReadable(n.body)
        if (n.kind === 'arrow') out += `${n.dir === 'l' ? '←' : n.dir === 'lr' ? '↔' : '→'}${body}`
        else if (n.kind === 'hat') out += `${body}(帽)`
        else if (n.kind === 'widehat') out += `${body}(弧)`
        else if (n.kind === 'dot') out += `${body}(点)`
        else out += `${body}(两点)`
        break
      }
      case 'deco':
        out += `${toReadable(n.body)}(${n.kind === 'overline' ? '上划线' : '下划线'})`
        break
      case 'binom':
        out += `C(${toReadable(n.top)},${toReadable(n.bottom)})`
        break
      case 'env': {
        if (n.name === 'cases' || n.name === 'dcases' || n.name === 'rcases') {
          // 分段函数：两列时按「条件 时 值」读，一列时直接分号连接
          out += n.rows
            .map((r) => (r.length >= 2 ? `${toReadable(r[1])}时${toReadable(r[0])}` : toReadable(r[0] || [])))
            .join('；')
        } else {
          out += n.rows.map((r) => r.map((c) => toReadable(c)).join(' ')).join('；')
        }
        break
      }
    }
  }
  return out
}

/** 分子/分母含加减时加括号，避免 a/b+c 被读成 a/(b+c) 之外的歧义 */
function wrapReadable(s: string): string {
  const t = s.trim()
  if (t.length > 1 && /[+\-]/.test(t) && !/^\(.*\)$/.test(t)) return `(${t})`
  return t
}

/** 上标内容 → unicode（单位字符直接转，其它用 ^(...)） */
function supToReadable(s: string): string {
  const t = s.trim()
  if (t.length === 1 && SUP_UNICODE[t]) return SUP_UNICODE[t]
  return t ? `^(${t})` : ''
}
function subToReadable(s: string): string {
  const t = s.trim()
  if (t.length === 1 && SUB_UNICODE[t]) return SUB_UNICODE[t]
  return t ? `_(${t})` : ''
}

/**
 * LaTeX → 人类可读形式（编辑态展示用）。
 *
 * ⚠️ 三种输入都要覆盖（2026-10-23 修：此前只处理 $...$ 包裹的公式，
 *    而符号面板插入的是裸 \frac{|}{}、AI 答案也常混用，导致编辑态仍显示源码）：
 *    ① $...$ / $$...$$ / \[...\] / \(...\) 包裹的公式段
 *    ② 没有 $ 包裹的裸 LaTeX 段（含反斜杠命令的文本）
 *    ③ 纯文字段原样保留（用户认识的字不该被动）
 * 解析失败时原样返回（保留用户已有内容，绝不丢字）。
 */
export function latexToReadable(src: string): string {
  const s = (src || '').trim()
  if (!s) return ''

  const convert = (tex: string): string => {
    const t = (tex || '').trim()
    if (!t) return ''
    try {
      return toReadable(new Parser(t).parse(false))
    } catch {
      return t // 不支持的语法原样保留，至少不丢内容
    }
  }

  // ① 行间公式（可能跨行）→ 独占一行
  let out = s.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, a, b) => `\n${convert(a ?? b ?? '')}\n`)
  // ① 行内公式
  out = out.replace(/\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g, (_m, a, b) => convert(a ?? b ?? ''))
  // ② 裸 LaTeX 段：同一行里凡含 \命令 的都按公式转换（幂等：已转换的可读形式不含反斜杠）
  out = out.replace(/[^$\n]*\\[a-zA-Z]+[^$\n]*/g, (seg) => convert(seg))
  return out
}

/** 人类可读形式 → LaTeX（保存时用；认不出的模式原样保留，绝不猜测） */
export function readableToLatex(src: string): string {
  const s = src || ''
  if (!s) return ''

  // ① 切成原子：数字字母串 / 括号组 / 单个符号
  const atoms: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/[0-9a-zA-Z]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9a-zA-Z]/.test(s[j])) j++
      atoms.push(s.slice(i, j))
      i = j
      continue
    }
    if (c === '(') {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      atoms.push(s.slice(i, j))
      i = j
      continue
    }
    // 大括号组同理（模板「大括号」插入 {|}，填完是 {x}）：
    // 必须整体成原子，否则被拆成单字符，atomToLatex 的 {X}→\lbrace 分支无从生效
    if (c === '{') {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++
        else if (s[j] === '}') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      atoms.push(s.slice(i, j))
      i = j
      continue
    }
    atoms.push(c)
    i++
  }

  // ② 合并「前缀运算」：√X、→X、←X、C(a,b) 各成一个原子（否则 15/√3 会被拆散）
  const DECO_MARK: Record<string, string> = {
    '(帽)': 'hat', '(弧)': 'widehat', '(上划线)': 'overline', '(下划线)': 'underline',
    '(点)': 'dot', '(两点)': 'ddot',
  }
  const merged: string[] = []
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k]
    const next = atoms[k + 1]
    if ((a === '√' || a === '→' || a === '←') && next && /^[0-9a-zA-Z(]/.test(next)) {
      merged.push(a + next)
      k++
      continue
    }
    if (a === 'C' && next && next.startsWith('(') && next.endsWith(')') && next.length > 2) {
      const inner = next.slice(1, -1)
      const ci = inner.indexOf(',')
      if (ci > 0) {
        merged.push(`C(${inner.slice(0, ci)},${inner.slice(ci + 1)})`)
        k++
        continue
      }
    }
    merged.push(a)
  }

  // ③ 反向查表：unicode 上/下标 → 数字
  const SUP_REV: Record<string, string> = {}
  for (const [k, v] of Object.entries(SUP_UNICODE)) SUP_REV[v] = k
  const SUB_REV: Record<string, string> = {}
  for (const [k, v] of Object.entries(SUB_UNICODE)) SUB_REV[v] = k

  /** 单个原子 → LaTeX。括号组要**递归转换内部**，否则 (1/2) 里的 / 不会变成 \frac */
  const atomToLatex = (a: string): string => {
    if (a.startsWith('(') && a.endsWith(')') && a.length > 2) {
      return `(${readableToLatex(a.slice(1, -1))})`
    }
    if (a.startsWith('√')) {
      const arg = a.slice(1)
      return `\\sqrt{${arg.startsWith('(') && arg.endsWith(')') && arg.length > 2 ? readableToLatex(arg.slice(1, -1)) : arg}}`
    }
    if (a.startsWith('→')) {
      const arg = a.slice(1)
      // ⚠️ 光秃秃的 →（如「n → ∞」里 → 后跟的不是字母/括号）：原样保留，
      //    绝不生成空参 \vec{}（2026-10-23：n \to \infty 回转成 n \vec{} ∞）
      if (!arg) return a
      return `\\vec{${arg.startsWith('(') && arg.endsWith(')') && arg.length > 2 ? readableToLatex(arg.slice(1, -1)) : arg}}`
    }
    if (a.startsWith('←')) {
      const arg = a.slice(1)
      if (!arg) return a
      return `\\overleftarrow{${arg.startsWith('(') && arg.endsWith(')') && arg.length > 2 ? readableToLatex(arg.slice(1, -1)) : arg}}`
    }
    const cm = a.match(/^C\((.+),(.+)\)$/)
    if (cm) return `\\binom{${cm[1]}}{${cm[2]}}`
    // 大括号模板 {X} → \lbrace X \rbrace（模板「大括号」插入的就是 {|} 形态；
    // LaTeX 语义里裸 {X} 是分组、不显示括号，必须显式转定界符才能看见花括号）
    if (a.startsWith('{') && a.endsWith('}') && a.length > 2) {
      return `\\lbrace ${readableToLatex(a.slice(1, -1))} \\rbrace`
    }
    return a
  }

  /** 去掉最外层括号（frac/根号的参数本身已分组，括号只会多个可见括号） */
  const stripParen = (s: string): string =>
    s.startsWith('(') && s.endsWith(')') && s.length > 2 ? s.slice(1, -1) : s

  /**
   * 从已生成文本末尾取回一个原子（分数/上下标/装饰要挂到它上面）。
   * 顺序即优先级：先匹配「命令+花括号组」「基元+花括号组」，再匹配普通原子，
   * 否则 \frac{a}{b} 只会被取回 \frac{a}、剩下 {b} 变游离文本。
   *
   * ⚠️ 2026-10-23 修：第二、三分支必须认「base + ^/_ + {组}」——
   * x^{2}、x_1、x_{1}^{2}、∑_{i=1}^{n} 这类带上下标的原子要能**整体**取回。
   * 旧正则写的是 base{...}（漏了 ^/_ 标记），只能取回末字符 '}'，
   * 导致 \frac{x^2}{y_1} 回转成 x^{2\frac{}}{y}_{1}（原子被拦腰拆断）。
   * 第一分支额外允许「命令+花括号」后再跟上下标（\sqrt{x}^{2}）。
   */
  const takeLastAtom = (built: string): { atom: string; rest: string } | null => {
    const m = built.match(
      /(?:\\[a-zA-Z]+(?:\{(?:[^{}]|\{[^{}]*\})*\})+(?:[\^_](?:\{[^{}]*\}|[0-9a-zA-Z]))*|(?:[0-9a-zA-Z√→←∑∫π∆Ω∛]|[\u03b1-\u03c9\u0391-\u03a9])+(?:[\^_](?:\{[^{}]*\}|[0-9a-zA-Z]))*|√\([^]*\)|∛\([^]*\)|[→←][0-9a-zA-Z]+|C\([^]*\)|[0-9a-zA-Z]+|\([^]*\)|\{[^{}]*\}|\\[a-zA-Z]+|.)$/,
    )
    if (!m || !m[0]) return null
    return { atom: m[0], rest: built.slice(0, built.length - m[0].length) }
  }

  let out = ''
  for (let k = 0; k < merged.length; k++) {
    const a = merged[k]
    const next = merged[k + 1]

    // 上标 unicode：挂到前一个原子 → ^{x}
    if (SUP_REV[a] && out) {
      const t = takeLastAtom(out)
      if (t) {
        out = `${t.rest}${t.atom}^{${SUP_REV[a]}}`
        continue
      }
    }
    // 下标 unicode：挂到前一个原子 → _{x}
    if (SUB_REV[a] && out) {
      const t = takeLastAtom(out)
      if (t) {
        out = `${t.rest}${t.atom}_{${SUB_REV[a]}}`
        continue
      }
    }
    // 显式括号上下标：_(i=1) / ^(n)（求和/求极限的上下限常用）
    if ((a === '_' || a === '^') && next && next.startsWith('(') && next.endsWith(')') && next.length > 2 && out) {
      const t = takeLastAtom(out)
      if (t && t.atom) {
        out = `${t.rest}${t.atom}${a}{${next.slice(1, -1)}}`
        k++
        continue
      }
    }
    // 装饰后缀：z(帽) → \hat{z}
    if (DECO_MARK[a] && out) {
      const t = takeLastAtom(out)
      if (t) {
        out = `${t.rest}\\${DECO_MARK[a]}{${t.atom}}`
        continue
      }
    }
    // 分数：A/B → \frac{A}{B}（A、B 各取一个原子；参数去外层括号）
    if (a === '/' && out && next) {
      const t = takeLastAtom(out)
      if (t && t.atom) {
        // 分母后紧跟的上下标属于分母（运算优先级：下标绑定紧邻的基元）：
        // a/b₁ → \frac{a}{b_{1}}，而不是把 ₁ 挂到整个分数上变成 (\frac{a}{b})_{1}
        let den = stripParen(atomToLatex(next))
        let m = k + 2
        while (m < merged.length) {
          const u = merged[m]
          if (SUP_REV[u]) { den += `^{${SUP_REV[u]}}`; m++; continue }
          if (SUB_REV[u]) { den += `_{${SUB_REV[u]}}`; m++; continue }
          if ((u === '_' || u === '^') && merged[m + 1]?.startsWith('(')) {
            den += `${u}{${merged[m + 1].slice(1, -1)}}`
            m += 2
            continue
          }
          break
        }
        out = `${t.rest}\\frac{${stripParen(t.atom)}}{${den}}`
        k = m - 1
        continue
      }
    }
    out += atomToLatex(a)
  }
  return out
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
