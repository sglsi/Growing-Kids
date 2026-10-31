/**
 * 光标决策（零 import 纯函数，由 `utils/use-caret.ts` 调用）
 *
 * ## 为什么要把这几行从 hook 里搬出来
 * 「光标自己跑掉」在本项目已经连报三次（2026-10-26 逐字绑定拽走、2026-10-31 撤销落回 -1、
 * 2026-10-31 连续删除跳末尾）。三次都是**同一个属性的取值规则**出错，而写在 React hook
 * 里只能靠真机试。搬到零 import 的纯函数后，`verify` 的 M12 模块可以直接单编跑断言，
 * 规则被改动或退化会立刻红灯。
 *
 * ## 规则（每一条都对应一次真实事故）
 * 1. **永不返回 -1**：微信原生 textarea 的 `cursor` 默认值是 -1，语义是「置于文本末尾」。
 *    把属性写成 -1 不是"取消指定"，而是**命令光标去末尾**（2026-10-31 逗号跳末尾事故）。
 *    拿不到任何位置信息时返回 `null`（= 这次不动属性），让值停在上一次的位置。
 * 2. **一次性定位必须被下一次输入撤销**（`pending`）：插入数学符号后 `cursor` 从原值跳到
 *    插入点，如果不撤销，之后每次聚焦都会被拽回插入点。
 * 3. **删除时必须钉住真实光标**：受控 `value` 的回写链路（setState → 渲染 → setData）要跨
 *    若干帧，用户连续退格时原生文本一直在变，这次回写的 value 往往已经落后 ⇒ 微信收到
 *    「value 被赋值」就把光标置到末尾。同帧把 cursor 一起下发即可抵消（2026-10-31 事故）。
 *    只在**变短**时做：增字时回写常常恰好等于原生值，而组词过程中写 cursor 会拽走拼音光标。
 * 4. **推不出来就别猜**：删除时事件没带 cursor 且没有已知位置，宁可不写，也**不能写 0**
 *    （把光标钉到开头比跳末尾更难受）。
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
}

export interface CaretInput {
  /** 原生事件 detail 里的光标位置（可能没有） */
  cursor?: number
  /** 本次输入之后的文本长度 */
  valueLen?: number
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
  const valid = typeof i.cursor === 'number' && i.cursor >= 0
  const len = typeof i.valueLen === 'number' && i.valueLen >= 0 ? i.valueLen : -1

  // ---- 规则 2：撤销一次性定位 ----
  if (s.pending) {
    let target = valid ? (i.cursor as number) : -1
    if (target < 0 && len >= 0 && s.prevLen >= 0) {
      // 事件没带光标（部分输入法/标点）：按「文本长度差」从插入点推算
      target = s.shot + (len - s.prevLen)
    }
    // 规则 1：推不出来就返回 null，绝不 -1
    return target < 0 ? null : clamp(target, len)
  }

  // ---- 规则 3：删除时钉住光标 ----
  if (len >= 0 && s.prevLen >= 0 && len < s.prevLen) {
    const gone = s.prevLen - len
    const target = valid ? (i.cursor as number) : s.live >= 0 ? s.live - gone : -1
    // 规则 4：推不出来就别猜（不能写 0）
    return target < 0 ? null : clamp(target, len)
  }

  // 其余情况（增字、组词、长度不变）：交给原生，不干预
  return null
}
