// 模块 44：P-028 知识点讲解标签展示层守卫（D-043 拍板 / D-045 显式豁免 Q5①）
//
// 为什么单独一个模块：M43 守「维度表本身有没有越界」，但**没有模块守
// 「把字典接成端点 + 前端标签时有没有破契约」**。D-045 豁免 Q5① 后最容易出的
// 四类事故：
//   ① 顺手把标签塞进检索 result 或改 note ⇒ 破 P-025 T4 契约 sha / 触发缓存 bump；
//   ② 把端点加进 PUBLIC_ROUTES 或加写方法 ⇒ 扩大匿名暴露面 / 破坏只读字典；
//   ③ 事先声明可被开关一起关掉、或标签被写成「课标认定 / 已核实」；
//   ④ 生产库没有 0032 表时端点直接 500（D-044 实测 present=false）。
//
// 🔴 本模块守的核心契约：**主 result 零改动 / 只读 + fail-closed / 声明常驻 / 默认关**。
//    纯静态断言，不连后端、不查库；运行时行为由台账与 build 验证另行记录。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Module } from '../lib/harness.mjs'

const m = new Module('M44', 'P-028 知识点讲解标签展示层守卫（D-043 / D-045）')
const ROOT = path.resolve(process.cwd(), '..')          // server/ → 仓库根（与 M43 同口径）

const REL = {
  controller: 'server/src/curriculum/curriculum.controller.ts',
  service: 'server/src/curriculum/curriculum.service.ts',
  module: 'server/src/curriculum/curriculum.module.ts',
  constants: 'server/src/curriculum/curriculum.constants.ts',
  appModule: 'server/src/app.module.ts',
  userContext: 'server/src/shared/user-context.ts',
  match: 'server/src/shared/question-match.ts',
  ref: 'server/src/shared/question-reference.ts',
  cache: 'server/src/answer-search/answer-search.service.ts',
  feDisclaimer: 'src/constants/curriculum-disclaimer.ts',
  feTags: 'src/lib/curriculum-tags.ts',
  feComponent: 'src/components/curriculum-tags.tsx',
  feApi: 'src/services/api.ts',
  feEditor: 'src/components/answer-editor.tsx',
  isolation: 'server/scripts/check-isolation.mjs',
  migration0032: 'migrations/0032_curriculum_topics.sql',
  proposal: 'docs/design/method/proposals/P-028-知识点讲解标签展示层.md',
  decision: 'docs/design/method/decision-log.md',
}

// M42 B1 / M43 复用的判定层真相源基线 sha
// 变更史：84f998ff… → 36b3cde9…（D-049 收紧题号正则，半角小数不再当题目起点）
const MATCH_BASELINE_SHA = '36b3cde980d8d08144a738b528d230ee5a5031dad00df40d50c4beb37cb4d550'

function read(key) {
  const p = path.join(ROOT, REL[key])
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${REL[key]}`)
  return fs.readFileSync(p, 'utf8')
}
function sha(key) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, REL[key]))).digest('hex')
}
/**
 * 剥掉 TS/TSX 注释后再做「代码里不得出现 X」的判断。
 *
 * 为什么需要：本模块的组件与算子文件在文件头用注释逐条写明「不写 localStorage」
 * 「不并入 TOPIC_TERMS」「不出现『标准答案』」——这些**否定式说明**会被朴素子串断言
 * 当成违规命中，造成守卫自身误报（2026-11-13 实测三处）。断言要查的是代码，
 * 不是解释代码的文字。需要「注释里必须写着某口径」的断言仍走原文。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
/** 取 TS 里 export const X = '...' 的单引号字符串（跨行拼接按相邻字面量处理） */
function constString(src, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*([\\s\\S]*?)\\n`, 'm')
  const hit = src.match(re)
  if (!hit) return null
  const parts = hit[1].match(/'([^']*)'/g) || []
  return parts.map((s) => s.slice(1, -1)).join('')
}

m.test('A1 只读端点：只有 GET，无写方法、无写端点', (c) => {
  const ctl = read('controller')
  c.ok(ctl.includes("@Controller('curriculum')"), 'controller 路径不是 curriculum')
  c.ok(ctl.includes("@Get('topics')"), "缺少 @Get('topics')")
  for (const verb of ['@Post', '@Put', '@Delete', '@Patch']) {
    c.ok(!ctl.includes(verb), `只读端点不应出现 ${verb}`)
  }
  const svc = read('service')
  for (const verb of ['.insert(', '.update(', '.delete(', '.upsert(']) {
    c.ok(!svc.includes(verb), `service 不应出现写操作 ${verb}`)
  }
  c.ok(svc.includes('.select(SELECT_COLS)'), 'service 缺少唯一 SELECT')
  c.ok(read('module').includes('CurriculumController'), '模块未注册 controller')
  c.ok(read('appModule').includes('CurriculumModule'), 'AppModule 未注册 CurriculumModule')
})

m.test('A2 身份与暴露面：要求 X-Auth-Token，刻意不进 PUBLIC_ROUTES', (c) => {
  const ctl = read('controller')
  c.ok(ctl.includes('requireUserId(req)'), '端点未要求身份（requireUserId）')
  c.ok(ctl.includes('不加入 `PUBLIC_ROUTES`') || ctl.includes('刻意不加入'), '缺少不进白名单的设计说明')
  const uc = read('userContext')
  const publicBlock = uc.slice(uc.indexOf('const PUBLIC_ROUTES = ['), uc.indexOf(']', uc.indexOf('const PUBLIC_ROUTES = [')))
  c.ok(!publicBlock.includes('curriculum'), 'curriculum 不应出现在 PUBLIC_ROUTES 白名单内')
  c.ok(read('feApi').includes("header: authHeaders()"), '前端请求未带 buildHeaders 身份头')
})

m.test('A3 fail-closed：生产无 0032 表时降级 available:false，绝不 500', (c) => {
  const svc = read('service')
  c.ok(svc.includes('available: false'), '缺少 available:false 降级')
  c.ok(svc.includes('table_unavailable'), '缺少表不可用降级原因')
  c.ok(svc.includes('catch (e)'), '查询异常未捕获')
  c.ok(svc.includes('MAX_ROWS'), '缺少行数上限保护')
  c.ok(svc.includes("term_origin === 'project'"), '缺少 term_origin 结构校验')
  const fe = read('feComponent')
  c.ok(fe.includes('available === false'), '前端未消费 available:false')
  c.ok(fe.includes('.catch('), '前端请求失败未降级')
})

m.test('A4 判定层零改动：question-match.ts sha 与 M42 B1 基线一致', (c) => {
  c.ok(sha('match') === MATCH_BASELINE_SHA, 'question-match.ts 与 M42 B1 基线 sha 不一致')
})

m.test('A5 参考例题契约零改动：55 词、无 curriculum 引用、CACHE_VERSION 已登记', (c) => {
  const ref = read('ref')
  c.ok(!ref.includes('curriculum'), 'question-reference.ts 不应引用 curriculum')
  c.ok(!ref.includes('topicLabels'), 'question-reference.ts 不应出现 topicLabels')
  const cache = read('cache')
  // Q1② 要求主 result 结构零改动；缓存版本登记值 D-049 v15 → D-055 note 口径 v16，
  // 属另一件事，须保持登记值一致。再 bump 须同步 M42 B6 / M46 A4 / M48 C3。
  c.ok(/CACHE_VERSION\s*=\s*'v16'/.test(cache), 'CACHE_VERSION 不是 v16（D-055 已登记，若再改须登记 D 号）')
  c.ok(!cache.includes('curriculum/topics'), 'answer-search 不应直接消费字典端点')
  c.ok(!cache.includes('topicLabels'), 'answer-search 不应把标签塞进 result')
})

m.test('A6 事先声明：两端逐字一致，且常驻不可关闭', (c) => {
  const be = constString(read('constants'), 'CURRICULUM_TAG_DISCLAIMER')
  const fe = constString(read('feDisclaimer'), 'CURRICULUM_TAG_DISCLAIMER')
  c.ok(!!be && !!fe, '声明常量解析失败')
  c.ok(be === fe, '前后端声明文案不一致（M44 防漂移）')
  c.ok(be.includes('可能涉及') && be.includes('仅供参考'), '声明缺少「可能涉及 / 仅供参考」')
  c.ok(be.includes('不是本题答案') && be.includes('不是课标认定'), '声明缺少明确的非判定措辞')
  const comp = read('feComponent')
  const declPos = comp.indexOf('{disclaimer || CURRICULUM_TAG_DISCLAIMER}')
  const condPos = comp.indexOf('{enabled ? (')
  c.ok(declPos > 0 && condPos > declPos, '声明必须在开关条件之前无条件渲染')
  c.ok(comp.includes('事先声明：常驻'), '缺少常驻设计说明')
})

m.test('A7 默认关 + 本地内存态：不持久化、不触碰隐私两道门', (c) => {
  const raw = read('feComponent')
  const comp = stripComments(raw) // 只查代码：注释里正写着「不写 localStorage」这类否定说明
  c.ok(/useState\(false\)/.test(comp), '开关默认值必须是 false')
  c.ok(!/Taro\.setStorage|setStorageSync|localStorage/.test(comp), '开关不应持久化（须重过隐私两道门）')
  c.ok(!/guardPolicy|guardPrivacy/.test(comp), '本地内存态不应绕过两道门的调用链')
  c.ok(raw.includes('知识点提示：关'), '缺少默认关的可见文案')
  // 该文件是 CRLF：断言前归一化换行，否则 Windows 工作区必然误报
  c.ok(
    read('feEditor').replace(/\r\n/g, '\n').includes('{hasRefs ? (\n            <CurriculumTags'),
    '标签未只在 hasRefs 时挂载',
  )
})

m.test('A8 只展示不排序：纯字面匹配，不进判定/共现/缓存键', (c) => {
  const raw = read('feTags')
  const lib = stripComments(raw)
  c.ok(lib.includes('text.indexOf(term)'), '匹配必须是字面 indexOf（Q2①）')
  c.ok(!/sharedSignals|MIN_SHARED_SIGNALS|TOPIC_TERMS/.test(lib), '标签算子不得引用判定层信号')
  c.ok(!/embedding|vector|rerank|semantic/i.test(lib), '不得引入语义/向量/Reranker')
  // 口径声明写在注释里，必须查原文
  c.ok(raw.includes('不是检索排序'), '缺少「排序只影响展示」的口径声明')
  c.ok(lib.includes('MAX_CURRICULUM_TAGS = 3'), '展示上限应为 3')
})

m.test('A9 不宣称：标签措辞与不宣称纪律', (c) => {
  const comp = stripComments(read('feComponent')) // 注释里正写着「不出现『标准答案』」，不剥会自伤
  c.ok(comp.includes('可能涉及：'), '标签缺少「可能涉及」前缀')
  for (const bad of ['课标认定：', '已核实知识点', '标准答案', '本题知识点']) {
    c.ok(!comp.includes(bad), `标签组件不得出现宣称词：${bad}`)
  }
  c.ok(read('proposal').includes('不宣称'), 'P-028 提案缺少不宣称纪律')
})

m.test('A10 流程门：D-045 显式豁免已登记，P-028 已批准', (c) => {
  const d = read('decision')
  c.ok(d.includes('D-045'), 'D-045 台账未登记')
  c.ok(d.includes('显式豁免'), 'D-045 未登记显式豁免')
  c.ok(d.includes('豁免不解除'), 'D-045 未登记豁免边界')
  c.ok(d.includes('撤销条件'), 'D-045 未登记撤销条件')
  const p = read('proposal')
  c.ok(/状态：已批准/.test(p), 'P-028 必须为已批准')
  c.ok(p.includes('Q1②') || p.includes('独立只读端点'), 'P-028 未定稿 Q1② 路线')
})

m.test('A11 全局字典免隔离：白名单逐条有据，且 0032 确无 user_id 列', (c) => {
  const iso = read('isolation')
  c.ok(iso.includes("'curriculum_topics'"), 'check-isolation 未登记全局字典白名单（M13 会失败）')
  c.ok(/'curriculum_topics'[^\n]*0032/.test(iso), '白名单条目缺少 0032 依据注释')
  const ddl = read('migration0032').toLowerCase()
  c.ok(ddl.includes('全局只读字典') && ddl.includes('无 user_id'), '0032 缺全局字典／无 user_id 的设计说明')
  c.ok(!/^\s*user_id\s+\w+/m.test(ddl), '0032 不应定义 user_id 列')
})

export default m
