/**
 * 查询参数清洗（跨模块复用）
 * ------------------------------------------------------------------
 * 背景（2026-10-19 真实线上 bug）：
 *   前端把未过滤的 `undefined` 拼进 query string ⇒ 后端收到**字符串 'undefined'**。
 *   这类值：
 *     - 用于等值过滤（subject_id='undefined'）→ 不报错，但永远查不到数据（比 404 更隐蔽）；
 *     - 用于日期比较（gte('occurred_at', 'undefined')）→ **Postgres 解析 timestamptz
 *       失败 ⇒ 直接 500**，整个接口打挂（成长记忆列表就是这么挂的）。
 *
 * 防御策略放在服务端：无论前端传什么脏参数，都不会污染查询或打挂接口。
 */

/** 空值归一化：'' / 'undefined' / 'null' / 'NaN' / 纯空白 → undefined */
export function cleanStr(v?: string | null): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  if (!s || s === 'undefined' || s === 'null' || s === 'NaN') return undefined
  return s
}

/** 日期参数归一化：非法日期字符串 → undefined（避免 Postgres 日期解析 500） */
export function cleanDate(v?: string | null): string | undefined {
  const s = cleanStr(v)
  if (!s) return undefined
  return Number.isNaN(Date.parse(s)) ? undefined : s
}

/** 正整数参数归一化：非法/越界 → undefined（调用方自行给默认值） */
export function cleanInt(v?: string | number | null): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}
