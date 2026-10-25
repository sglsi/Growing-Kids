/**
 * 视觉令牌（JS 侧出口）
 *
 * 背景：CSS 变量（--brand / --muted-foreground …）只能用在 className 与 style 里，
 * 但 lucide 图标的 `color` 属性、Canvas 绘制、以及需要按色值做判断的逻辑都必须
 * 拿到真实色值。此前这些地方直接硬编码 '#BE3E2D'（实测 111 处），想改品牌色
 * 就得改 111 个地方。
 *
 * 约定：
 * - 能用 className 的（文字、背景、边框）**一律用 Tailwind 工具类**
 *   （text-brand / bg-brand-soft / border-brand-line），不要引这里的常量；
 * - 只有 className 覆盖不到的地方（图标 color、Canvas、逻辑判断）才用本文件。
 *
 * 色值与 `src/app.css` 的 CSS 变量保持一致，改动时两处同步。
 * 规范见 `docs/design/视觉美学设计方案.md` 3.1。
 */

/**
 * 【翡】唯一强调色（填充面）—— 对应 CSS 变量 --brand
 * 思傅 2026-10-25：松绿 #2E6F4E → 翡翠玻璃绿 #10B981（原松绿偏深偏灰）。
 * ⚠️ 白字仅 2.5:1 不达标 ⇒ 品牌填充面上的文字/图标必须用 BRAND_FOREGROUND；
 *    纸面/白底上的品牌文字/图标用 BRAND_TEXT。三令牌规则见 src/app.css。
 */
export const BRAND = '#10B981'

/** 【翡】品牌填充面上的文字/图标（主操作按钮）—— 对应 --brand-foreground，深墨绿 4.8:1 */
export const BRAND_FOREGROUND = '#0B3D2E'

/** 【翡】纸面/白底上的品牌文字/图标 —— 对应 --brand-text，深翡翠 5.0:1 */
export const BRAND_TEXT = '#0B7A55'

/** 【墨】主文字 —— 对应 --foreground */
export const INK = '#2A2825'

/** 【墨】次要文字（图标未激活态、时间戳）—— 对应 --muted-foreground */
export const INK_MUTED = '#6F685C'

/** 【墨】占位/禁用态图标 —— 比 INK_MUTED 更弱，仅用于空插图与禁用图标 */
export const INK_FAINT = '#9A948A'

/** 【危】删除/错误 —— 对应 --destructive。
 *  ⚠️ 与 BRAND 同为红色系但明度更暗（相对亮度 0.107 vs 0.147）。
 *  删除类动作必须「图标 + 文案」共现，绝不靠颜色单独表达（色觉障碍可达性）。 */
export const DANGER = '#A8321F'
