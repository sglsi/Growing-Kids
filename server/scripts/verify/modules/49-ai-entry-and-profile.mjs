// 模块 49：AI 入口收口 / 头像昵称填写能力 / 反馈按钮对比度（D-057 / D-058）
//
// 守 2026-11-14 思傅四项指令的落地，都是「改完容易被后续迭代悄悄带回来」的点：
//
// ① 收起 AI 相关开关入口及描述。个人主体下 AI 助手对用户不可用（前端编译期
//    常量折叠 + 服务端 requireAiEnabled() fail-closed 双保险）。留着一个打不开的
//    开关，或留着指向该开关的文案，既是虚假指引，也会让审核按「提供 AI 服务」
//    要求补「深度合成-AI 问答」类目。
//    ⚠️ 这里只守「入口/文案收起」；AI_PUBLIC_ENTRY 常量与服务端闸门本身必须保留，
//       它们是合规控制点，删了才是真的把后门打开。
// ② 「我的」页昵称改为常驻微信官方头像昵称填写能力。平台自 2022-10 收回
//    getUserProfile 的真实头像昵称，**不允许静默自动获取**；能做到的是
//    `input type="nickname"` 聚焦后由微信一键带入 + `chooseAvatar` 选头像。
// ③ 「意见与建议」按钮原为深墨底配深墨绿字，对比度极低看不清。
// ④ 托管状态订正（11-05 已解除），以及验收报告里过时的昵称描述。
//
// 🔴 本模块只守静态契约，不碰判定层、不宣称任何功能效果。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M49', 'AI 入口收口 / 头像昵称填写能力 / 反馈按钮对比度（D-057）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const PROFILE = 'src/pages/profile/index.tsx'
const ANSWER_EDITOR = 'src/components/answer-editor.tsx'
const APP_INFO = 'src/constants/app-info.ts'
const AI_SETTINGS = 'src/services/ai-settings.ts'
const USER_CTX = 'server/src/shared/user-context.ts'
const APP_CSS = 'src/app.css'
const ACCEPT = 'docs/reports/小程序上线验收-差距评估与整改记录.md'

/**
 * 只扫真正会渲染/编译的代码与文案。
 * ⚠️ 必须剥离注释：本轮在源码注释里如实记录了「原 AI 开关卡片已移除」，
 *    那是给后来人看的历史说明，不是用户可见描述；不过滤就会像首版 A1 那样假阳性。
 *    与 M44 / M46 的 stripComments() 同口径。
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ---------- A AI 入口与描述收起，但合规闸门必须保留 ----------
m.test('A1 「我的」页不再有 AI 开关、智能客服卡片与相关描述', (c) => {
  const p = stripComments(read(PROFILE))
  for (const banned of [
    'AI 与在线检索',
    '智能客服',
    'handleToggleAi',
    'aiEnabled',
    'AI_PUBLIC_ENTRY',
    'Switch',
    'Bot',
  ]) {
    c.ok(!p.includes(banned), `「我的」页仍出现 ${banned}`)
  }
  c.ok(p.includes('数据在哪处理'), '中性数据处理说明须保留（隐私告知，不含 AI 字样）')
})

m.test('A2 答题页不再有「联网搜题 / AI 解题」入口', (c) => {
  const a = read(ANSWER_EDITOR)
  c.ok(!a.includes('AI_PUBLIC_ENTRY'), '不得再引用 AI 入口开关')
  c.ok(!a.includes("'AI 解题'") && !a.includes("'联网搜题'"), '两个按钮文案须移除')
  c.ok(!a.includes('Globe') && !a.includes('<Bot'), '两个入口的图标 import 须一并清掉')
  c.ok(a.includes('KB_SEARCH_ENABLED'), '「资料库搜题」是纯检索，按 B 保留，不得被连坐收起')
})

m.test('A3 合规控制点保留：编译期常量 + 服务端 fail-closed 闸门', (c) => {
  const info = read(APP_INFO)
  c.ok(info.includes("OPERATOR_TYPE: 'personal' | 'enterprise' = 'personal'"), '主体类型仍须为个人')
  c.ok(info.includes('export const AI_PUBLIC_ENTRY = OPERATOR_TYPE !== \'personal\''), 'AI_PUBLIC_ENTRY 常量不得删')
  const ctx = read(USER_CTX)
  c.ok(ctx.includes('export function requireAiEnabled'), '服务端闸门不得删')
  c.ok(ctx.includes("reason: 'AI_DISABLED'"), '403 reason 仍为 AI_DISABLED（M11 判据）')
  c.ok(ctx.includes('req.userAiEnabled === true'), 'fail-closed 方向不得反')
})

m.test('A4 不再有指向「已收起开关」的虚假指引', (c) => {
  const hint = read(AI_SETTINGS)
  const ctx = read(USER_CTX)
  c.ok(!hint.includes('可在「我的 · 隐私与账号」中开启'), '前端提示语不得指向不存在的开关')
  c.ok(!ctx.includes('可在「我的 · 隐私与账号」中开启'), '服务端 403 文案不得指向不存在的开关')
  c.ok(hint.includes('未提供在线解题'), '提示语须如实说明本版未提供')
})

m.test('A5 智能客服死页面已删除，路由 / 页面 / 前端封装不得回归（D-058）', (c) => {
  const cfg = read('src/app.config.ts')
  c.ok(!cfg.includes("'pages/chat/index'") && !cfg.includes("'pages/chat/admin'"),
    'app.config.ts 仍注册智能客服 / 知识库管理路由')
  c.ok(!fs.existsSync(path.join(ROOT, 'src/pages/chat')), 'src/pages/chat 死页面目录仍在')
  c.ok(!fs.existsSync(path.join(ROOT, 'src/services/chat.ts')), '通用对话 service 仍在')
  const api = read('src/services/api.ts')
  c.ok(!api.includes('sendChatMessage') && !api.includes('export interface KnowledgeArticle'),
    'api.ts 仍导出智能客服封装')
  c.ok(api.includes('前端 API 封装整段删除'), '删除原因须留注释，避免后人当漏删补回')
})

// ---------- B 微信官方头像昵称填写能力 ----------
m.test('B1 昵称输入框常驻，且用微信官方 nickname 类型', (c) => {
  const p = read(PROFILE)
  c.ok(p.includes('type="nickname"'), '须使用微信官方昵称填写能力')
  c.ok(!p.includes('setEditing') && !p.includes('handleEditNickname'), '不得退回「编辑」按钮后才展开输入框')
  c.ok(!p.includes('{editing && ('), '昵称输入框不得被编辑态条件包裹')
  c.ok(p.includes('点这里使用微信昵称'), '须给出「点一下用微信昵称」的可见引导')
})

m.test('B2 选完自动保存，且清空不等于删除昵称', (c) => {
  const p = read(PROFILE)
  c.ok(p.includes('saveNicknameIfChanged'), '须有自动保存函数')
  c.ok(p.includes('onBlur={() => void saveNicknameIfChanged()}'), '失焦须自动保存')
  c.ok(p.includes('onConfirm={() => void saveNicknameIfChanged()}'), '键盘完成键须自动保存')
  c.ok(p.includes('if (busy || name === saved) return'), '未变化不重复请求')
  c.ok(p.includes('setNickname(saved)'), '清空时须回填原值，不能把昵称抹掉')
  c.ok(p.includes('setNickname(user.nickname'), 'load() 后须把服务端昵称同步进输入框')
})

m.test('B3 头像仍走 chooseAvatar，且给出可见角标', (c) => {
  const p = read(PROFILE)
  c.ok(p.includes('openType="chooseAvatar"'), '头像须走微信官方 chooseAvatar')
  c.ok(p.includes('<Camera'), '须有可见相机角标（原来只有透明按钮，家长看不出能点）')
  c.ok(p.includes('absolute bottom-0 right-0'), '角标须定位在头像右下角')
})

m.test('B4 平台边界写进代码注释，避免后人「修成自动获取」', (c) => {
  const p = read(PROFILE)
  c.ok(p.includes('不能静默自动获取'), '须写明微信平台不允许静默获取真实昵称头像')
  c.ok(p.includes('键盘上方出现'), '须写明官方一键填入的触发方式')
})

// ---------- C 反馈按钮对比度 ----------
m.test('C1 「意见与建议」按钮改为浅底深字', (c) => {
  const p = read(PROFILE)
  c.ok(p.includes('openType="contact"'), '反馈仍走微信原生客服（零后端、不落库）')
  c.ok(!p.includes('background: INK'), '不得再用深墨底')
  c.ok(p.includes("background: 'rgba(16, 185, 129, 0.08)'"), '须用 --brand-soft 浅底')
  c.ok(p.includes('color: INK'), '文字须用主文字深墨色，与浅底拉开对比')
  c.ok(p.includes("border: '1px solid rgba(16, 185, 129, 0.25)'"), '浅底须配描边，避免在白卡片上边界消失')
})

m.test('C2 同款深底深字缺陷在「升年级」按钮也须修掉', (c) => {
  const p = read(PROFILE)
  c.ok(!p.includes('{ backgroundColor: INK }'), '不得再有深墨底配深墨绿字')
  c.ok(!p.includes('style={{ color: BRAND_FOREGROUND }}'), 'BRAND_FOREGROUND 只用于绿色填充面')
})

m.test('C3 原生 button 去掉微信默认伪元素边框', (c) => {
  c.ok(read(APP_CSS).includes('.gk-plain-btn::after'), 'app.css 须保留 ::after 去边框规则')
})

// ---------- D 文档事实订正 ----------
m.test('D1 托管状态订正为 11-05 已解除', (c) => {
  const a = read(ACCEPT)
  c.ok(a.includes('托管 11-05 已解除'), '验收报告须写明托管已解除')
  c.ok(a.includes('不要再按那些路径操作'), '旧托管面板路径须标注为历史留档，避免照着走错路')
})

m.test('D2 验收报告不得残留误粘贴的内容与过时昵称描述', (c) => {
  const a = read(ACCEPT)
  c.ok(!a.includes('托管已于11-05解除；收起AI'), '用户消息不得被粘贴进验收表格')
  c.ok(!a.includes('未调用头像昵称组件'), '旧描述「未调用头像昵称组件」是错的，须订正')
  c.ok(a.includes('已接入微信官方'), '须写明已接入官方头像昵称填写能力')
  c.ok(a.includes('平台不允许静默自动获取'), '须写明平台边界')
})

export default m
