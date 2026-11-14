// 模块 50：UGC 文本入库前内容安全检测（D-059 / 方案 A）
//
// 背景：D-057 收起 AI 入口、D-058 删除智能客服页面后，`checkText()` 只剩
// chat.service.ts 一处调用，而 chat 前端已不可达 ⇒ 用户可产出文本链路上
// 内容安全 API 调用数为 0，UGC 声明 method=1 无法如实勾选。
//
// 本模块守「接入不被后续迭代悄悄摘掉」：
//  ① 统一闸门存在且命中违规必须拒绝入库（不是只打个日志）
//  ② 五条用户可达的文本写入口都接了闸门，五个 module 都引入了 SecurityModule
//  ③ 只送用户可编辑文本，不送 OCR 全文 / 图片 key / URL
//  ④ 底层 msgSecCheck 封装与 best-effort 取舍保留，不被误删
//  ⑤ 隐私政策已升 r11（D-060 订正第三方清单），仍如实披露「内容安全检测」
//  ⑥ mp 后台指引已切到 method=1 + A 版文案
//
// 🔴 只守静态契约，不连微信、不碰判定层、不宣称「覆盖全部 UGC」。
//    诚实边界：匿名无 openid / 凭据缺失 / 接口异常时底层放行；图片、音视频
//    未接 mediaCheckAsync。这些必须在文档里写清，守卫不负责把它们说成已覆盖。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M50', 'UGC 文本入库前内容安全检测（D-059）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const GUARD = 'server/src/security/ugc-text-guard.service.ts'
const CHECK = 'server/src/security/content-check.service.ts'
const SEC_MODULE = 'server/src/security/security.module.ts'
const PP = 'src/constants/privacy-policy.ts'
const PPDOC = 'docs/legal/隐私政策.md'
const GUIDE = 'docs/reports/mp后台-隐私指引7项与UGC声明-操作指引.md'
const E2E = 'dynamic-tests/run-ugc-guard-d059.cjs'

const SERVICES = [
  'auth/auth.service.ts',
  'timeline/timeline.service.ts',
  'memory/memory.service.ts',
  'questions/questions.service.ts',
  'subjects/subjects.service.ts',
]
const MODULES = [
  'auth/auth.module.ts',
  'timeline/timeline.module.ts',
  'memory/memory.module.ts',
  'questions/questions.module.ts',
  'subjects/subjects.module.ts',
]

// ---------- A 统一闸门 ----------
m.test('A1 统一闸门存在，命中违规抛 400 拒绝入库', (c) => {
  c.ok(exists(GUARD), 'UgcTextGuard 文件缺失')
  const g = read(GUARD)
  c.ok(g.includes('export class UgcTextGuard'), '未导出 UgcTextGuard')
  c.ok(g.includes('result.allowed') && g.includes('BadRequestException'),
    '必须按 allowed 判定并抛 400，不能只打日志')
  c.ok(g.includes('UGC_REJECT_MESSAGE'), '须有统一拒绝文案')
  c.ok(!/logger\.(warn|error)\([^\n]*text/.test(g), '日志不得写入用户文本')
})

m.test('A2 只送用户可编辑文本，空文本不送检、重复文本去重', (c) => {
  const g = read(GUARD)
  c.ok(g.includes('if (!lines.length) return'), '空文本必须短路，避免无意义外发')
  c.ok(g.includes('seen.has(t)'), '重复文本必须去重')
  c.ok(/function questionTexts/.test(g) && g.includes('白名单'), '题目文本须走白名单收集')
  const q = g.slice(g.indexOf('export function questionTexts'))
  c.ok(!q.includes('images') && !q.includes('answer_refs') && !q.includes('file_key'),
    '白名单不得把图片 key / 参考链接等机器字段送检')
})

// ---------- B 五条链路全部接入 ----------
m.test('B1 五条文本写入口都调用了闸门', (c) => {
  for (const f of SERVICES) {
    const s = read(`server/src/${f}`)
    c.ok(s.includes('UgcTextGuard') && s.includes('assertAllowed'), `${f} 未接入 UgcTextGuard`)
  }
  const t = read('server/src/timeline/timeline.service.ts')
  for (const tag of ['timeline.create', 'timeline.batch', 'timeline.update']) {
    c.ok(t.includes(tag), `timeline 缺少 ${tag} 检测点`)
  }
  c.ok(t.includes('dtos.flatMap'), '批量保存必须合并为一次检测，不能逐题往返')
})

m.test('B2 五个业务模块都引入了 SecurityModule（防 Nest DI 启动失败）', (c) => {
  for (const f of MODULES) {
    c.ok(read(`server/src/${f}`).includes('SecurityModule'), `${f} 未 imports SecurityModule`)
  }
  const sm = read(SEC_MODULE)
  c.ok(sm.includes('providers: [ContentCheckService, UgcTextGuard]'), 'SecurityModule 未注册两个 provider')
  c.ok(sm.includes('exports: [ContentCheckService, UgcTextGuard]'), 'SecurityModule 未导出 UgcTextGuard')
})

// ---------- C 底层能力保留 ----------
m.test('C1 msgSecCheck 封装保留、两次外网请求带超时、best-effort 取舍不被改坏', (c) => {
  const cc = read(CHECK)
  c.ok(cc.includes('wxa/msg_sec_check') && cc.includes('version: 2'), 'v2 接口与参数被改坏')
  c.ok(cc.includes('openid'), 'v2 强制要求 openid，不得移除')
  c.ok((cc.match(/AbortSignal\.timeout/g) || []).length === 2,
    'token 与 msgSecCheck 两次外网 fetch 都必须带超时，防保存链路被挂住')
  c.ok(cc.includes('skipped'), '检测不可用时放行（best-effort）的口径须保留')
})

// ---------- D 法律文本与后台声明 ----------
m.test('D1 隐私政策已升 r11 且仍如实披露内容安全检测', (c) => {
  const pp = read(PP)
  const doc = read(PPDOC)
  c.ok(/PRIVACY_POLICY_VERSION = '2026-11-14-r11'/.test(pp), '应用内政策没升 r11')
  c.ok(doc.includes('2026-11-14-r11'), 'docs/legal 镜像没升 r11')
  for (const kw of ['内容安全检测', 'msgSecCheck', '拒绝保存']) {
    c.ok(pp.includes(kw), `应用内政策缺少「${kw}」披露`)
    c.ok(doc.includes(kw), `docs/legal 镜像缺少「${kw}」披露`)
  }
})

m.test('D2 mp 后台指引已切到 method=1 + A 版文案，不再把 A 写成待拍板', (c) => {
  const g = read(GUIDE)
  c.ok(g.includes('`method=1`'), '指引未给出 method=1 的确定口径')
  c.ok(/方案 A 已实施|A 已实施|已按方案 A 实施/.test(g), '指引仍把方案 A 写成待实施')
  c.ok(!g.includes('本轮未擅自实施方案 A'), '「未实施 A」的过时表述须删除')
  c.ok(g.includes('msgSecCheck'), '审核机制说明须点名内容安全 API')
  c.ok(g.includes('best-effort') || g.includes('放行'), '须如实写明检测不可用时放行这一边界')
})

m.test('D3 离线实证脚本存在且覆盖拒绝/放行/去重/白名单', (c) => {
  c.ok(exists(E2E), 'run-ugc-guard-d059.cjs 缺失')
  const s = read(E2E)
  for (const kw of ['reject', 'risky', '去重', '白名单', 'skipped']) {
    c.ok(s.includes(kw), `实证脚本缺少 ${kw} 用例`)
  }
})

export default m
