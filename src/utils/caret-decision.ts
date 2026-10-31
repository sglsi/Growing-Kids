/**
 * 光标决策（零 import 纯函数，由 `utils/use-caret.ts` 调用）
 *
 * ## 为什么要把这几行从 hook 里搬出来
 * 「光标自己跑掉」在本项目已经连报四次（2026-10-26 逐字绑定拽走、10-31 撤销落回 -1、
 * 10-31 连续删除跳末尾、10-31 输入字母后打标点跳末尾）。每次都是**同一个属性的取值规则**
 * 出错，而写在 React hook 里只能靠真机试。搬到零 import 的纯函数后，`verify` 的 M12 模块
 * 可以直接单编跑断言，规则被改动或退化会立刻红灯。
 *
 * ## 结论先行（社区与官方文档一致的口径）
 * 小程序 textarea 是「半受控」组件：**value 一旦变化，渲染层就把光标重置到末尾**；
 * `cursor` 是唯一能把光标钉回去的属性。所以受控输入框的正解是
 * **每次输入都让 cursor 跟着 value 同一批下发**，只把「输入法组词中」排除在外。
 * 不要指望"少写 cursor 就不会被拽走"—— 不写 cursor 时平台照样会把光标甩到末尾，
 * 只是甩的时机取决于 setData 什么时候落地，表现成"偶尔跳、只在某种输入后跳"。
 *
 * ## 规则（每一条都对应一次真实事故）
 * 1. **组词中一律不干预**（`composing`）：拼音/手写中间态里事件给的 cursor 是"拼音串"
 *    的位置，与原生真实光标不一致，写进去会把组词光标拽走。用官方的
 *    `onKeyboardCompositionStart/End`（微信 2.25.0+）+ `keyCode === 229` 判定。
 * 2. **永不返回 -1**：`cursor` 默认值 -1 的语义是「置于文本末尾」，不是「不指定」。
 *    把属性写成 -1 等于**命令光标去末尾**（2026-10-31 逗号跳末尾事故）。
 *    拿不到任何位置信息时返回 `null`（这次不动），让值停在上一次的位置。
 * 3. **常规输入把真实光标钉住**：字母、数字、标点、删除都算。事件带了 `cursor`
 *    就直接用（越界钳到文本长度）。这就是"输入字母后打标点，光标跳到结尾"的正解 ——
 *    那一跳不是标点特殊，而是**该次 setData 的 value 与光标没有同批下发**。
 * 4. **一次性定位必须被下一次输入撤销**（`pending`）：插入数学符号后 cursor 被程序
 *    设到插入点，不撤销的话之后每次聚焦都会被拽回插入点。
 * 5. **删除且事件没带 cursor 时按长度差回推**：推不出来就不写 —— **绝不能猜 0**，
 *    把光标钉到开头比跳末尾更难受。
 */

export interface CaretSnapshot {
  /** 上一次已知的文本长度（-1 = 未知） */
  prevLen: number
  /** 当前下发给 `cursor` 属性的值（-1 = 不指定） */
  shot: number
  /** 上一次真实光标位置（-1 = 未知） */
  live: number
  /** 是否还有一次「程序化定位」等着被这次输入消费掉 */
  pending: boolean
  /** 输入法是否正在组词（拼音/手写中间态） */
  composing?: boolean
}

export interface CaretInput {
  /** 原生事件 detail 里的光标位置（可能没有） */
  cursor?: number
  /** 本次输入之后的文本长度 */
  valueLen?: number
  /** 本次输入是否发生在输入法组词期间（覆盖 snapshot 里的 composing） */
  composing?: boolean
}

function clamp(pos: number, len: number): number {
  if (pos < 0) return 0
  return len >= 0 ? Math.min(pos, len) : pos
}

/**
 * 决定这次输入之后 `cursor` 属性该取什么值。
 * @returns 要写入的 cursor；`null` = 本次不要改（尤其不要写 -1）
 */
export function decideCursor(s: CaretSnapshot, i: CaretInput): number | null {
  // 规则 1：组词中不干预（规则优先于一切，包括 pending 撤销）
  if (i.composing ?? s.composing) return null

  const valid = typeof i.cursor === 'number' && i.cursor >= 0
  const len = typeof i.valueLen === 'number' && i.valueLen >= 0 ? i.valueLen : -1

  // 规则 4：撤销一次性定位（回落到真实光标，绝不回落到 -1）
  if (s.pending) {
    let target = valid ? (i.cursor as number) : -1
    if (target < 0 && len >= 0 && s.prevLen >= 0) {
      target = s.shot + (len - s.prevLen)
    }
    return target < 0 ? null : clamp(target, len)
  }

  // 规则 3：常规输入 —— 有真实光标就钉住
  if (valid) return clamp(i.cursor as number, len)

  // 规则 5：删除但事件没带光标 → 按少掉的字数回推
  if (len >= 0 && s.prevLen >= 0 && len < s.prevLen) {
    const target = s.live >= 0 ? s.live - (s.prevLen - len) : -1
    return target < 0 ? null : clamp(target, len)
  }

  // 其余（增字但没带光标、长度不变）：交给原生，不猜
  return null
}
