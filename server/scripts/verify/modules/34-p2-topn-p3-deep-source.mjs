// 模块 34：P2 补齐与 P3 深挖 / 呈现 / 回归验收集（P-012 / D-015）
//
// 为什么单独一个模块：M27/M31 守判定硬闸、M32 守结构化对象、M33 守公共归属与
// 双通道召回，本模块守的是**最后一公里**——
//   ① P2 剩下的两项：SQL 无排序截断 + 两套打分口径并存；
//   ② P3 放行后的边界：深挖 8 份 / 8s + 18s 兜底、默认禁在线抽取、
//      来源卡片只在 exact 渲染。
// 🔴 最关键的一条：P3 放宽的是「谁被审」，不是「审得松一点」。
//    判定层六条硬闸、strict 默认值、第二层上线准入一个字都不能顺手改。
// 🔴 改判是追加式：D-012 §8.5「P1/P2/P3 一律不启动」历史文本原样保留。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M34', 'P2 补齐与 P3 深挖、呈现、回归验收集（P-012 / D-015）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const SERVICE_ND = 'server/src/netdisk/netdisk-search.service.ts'
const SERVICE_AS = 'server/src/answer-search/answer-search.service.ts'
const STORE = 'server/src/shared/question-object-store.ts'
const MATCH = 'server/src/shared/question-match.ts'
const EDITOR = 'src/components/answer-editor.tsx'
const PROPOSAL = 'docs/design/method/proposals/P-012-P2补齐与P3深挖呈现.md'
const DECISION = 'docs/design/method/decision-log.md'
const REPORT = 'docs/reports/资料库正文召回-检索侧四步方案评审.md'
const P009 = 'docs/design/method/proposals/P-009-长文档原题判定口径与题目级切分.md'

m.test('🔴 B1 P2 补齐：统一打分口径，bigram coverage 退出主排序', (c) => {
  const svc = read(SERVICE_ND)
  const local = svc.slice(svc.indexOf('private async searchLocal'))
  c.ok(local.length > 1000, '没切到 searchLocal 函数体')
  c.ok(/keyHits\s*[:=]\s*nameHits \+ tHits \* 2/.test(local), '主排序键不是「正文长锚点共现 ×2 + 文件名命中」')
  c.ok(/score: Number\(\(keyHits \/ denominator\)/.test(local), 'score 不是同源共现率（两套分数又分家了）')
  c.ok(!/coverage\(qSet/.test(local), 'searchLocal 里 bigram coverage 还在参与打分')
  c.ok(/CANDIDATE_TOP_N/.test(local), '缺合并后 top-N 常量')
  const sortAt = local.indexOf('.sort(')
  const sliceAt = local.indexOf('.slice(0, CANDIDATE_TOP_N)')
  c.ok(sortAt > 0 && sliceAt > sortAt, 'top-N 截断没有发生在排序之后（又变回任意截断）')
})

m.test('🔴 B2 P2 补齐：SQL 两条通道定序 + 扫描上限告警', (c) => {
  const svc = read(SERVICE_ND)
  const orders = svc.match(/\.order\('fs_id', \{ ascending: true \}\)/g) || []
  c.eq(orders.length, 2, '两条通道没有都按 fs_id 定序（PostgREST 无 order 会随机返回）')
  const warns = svc.match(/达到扫描上限/g) || []
  c.eq(warns.length, 2, '扫描上限告警不是两处 —— 命中被截断却静默是 M18 红线')
  c.ok(/LOCAL_CANDIDATE_LIMIT = Number\(process\.env\.NETDISK_LOCAL_LIMIT \?\? 2_000\)/.test(svc),
    '文件名通道扫描上限不是 2000（原 500 曾截断 15,123 行）')
  c.ok(/TEXT_CANDIDATE_LIMIT = Number\(process\.env\.NETDISK_TEXT_LIMIT \?\? 2_000\)/.test(svc),
    '正文通道扫描上限不是 2000')
  c.ok(/扫描上限（不是候选截断）|扫描上限\*\*/.test(svc), '没写明 limit 的语义已改为扫描上限')
})

m.test('🔴 B3 P3 深挖：8 份 / 8s 主预算 / 18s 硬兜底', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/NETDISK_DEEP_FILES \?\? 8/.test(svc), 'MAX_DEEP_FILES 不是拍板的 8（报告原建议 20~30 未采纳）')
  c.ok(/NETDISK_DEEP_BUDGET_MS \?\? 8_000/.test(svc), '主预算不是 8s')
  c.ok(/DEEP_HARD_BUDGET_MS = 18_000/.test(svc), '缺 18s 绝对兜底')
  c.ok(/Date\.now\(\) > deadline \|\| Date\.now\(\) > hardDeadline/.test(svc),
    '循环里没有同时检查主预算与硬兜底')
  c.ok(/l1\.slice\(0, MAX_DEEP_FILES\)/.test(svc), '深挖没走上限')
  c.ok(/P95<3s|P95 < 3s/.test(svc), '源码没写 §4 P0-3 的性能约束理由')
})

m.test('🔴 B4 P3 默认禁在线下载/抽取，回退开关在且在下载之前生效', (c) => {
  const svc = read(SERVICE_ND)
  c.ok(/ONLINE_EXTRACT_ENABLED = process\.env\.NETDISK_ONLINE_EXTRACT === '1'/.test(svc),
    '在线抽取默认不是关（===1 才开）')
  c.ok(/NETDISK_ONLINE_EXTRACT=1/.test(svc), '源码没写应急回退开关')
  const guard = svc.indexOf('if (!ONLINE_EXTRACT_ENABLED)')
  const call = svc.indexOf('await this.netdisk.downloadByFsId(')
  c.ok(guard > 0 && call > guard, '禁在线抽取的闸门没放在真正下载之前（等于没关）')
  c.ok(/text_status='ok'/.test(svc), '没写明只消费离线铺量的正文')
})

m.test('🔴 B5 来源卡片只在 exact 渲染，不给无出处答案背书', (c) => {
  const e = read(EDITOR)
  c.ok(/candidate\.match_level === 'exact' && candidate\.source_location/.test(e),
    '来源卡片没有限定 exact + 有位置（topic/none 展示＝给无出处答案背书）')
  c.ok(/请打开文件核对原题与解析后采纳/.test(e), '缺「请核对」——残余风险期间唯一诚实的兜底')
  c.ok(/source_location\.source_name/.test(e) && /source_location\.label/.test(e)
    && /source_location\.object_index/.test(e), '来源卡片没把文件名 / 题号 / 序号展示全')
  c.ok(!/onClick=\{\(\) => \{[\s\S]{0,200}source_location/.test(e),
    '来源卡片做了点击跳题（会变成拍照搜题形态）')
})

m.test('🔴 B6 CACHE_VERSION v9、strict 仍锁、六条硬闸未放宽', (c) => {
  const as = read(SERVICE_AS)
  c.ok(/const CACHE_VERSION = 'v9'/.test(as),
    '候选池与结果内容变了却没 bump（answer_cache 会原样吐 v7 旧命中）')
  c.ok(as.includes('${CACHE_VERSION}:${question}'), '版本没参与 qHash，bump 无效')
  const store = read(STORE)
  c.ok(/process\.env\.QUESTION_OBJECTS_STRICT === '1'/.test(store),
    'strict 默认值被改（第二层上线准入仍未全绿）')
  const q = read(MATCH)
  c.ok(/export const MATCH_MIN_LONG_ANCHORS = 3/.test(q), '长锚点下限被放宽')
  c.ok(/export const MATCH_MAX_OBJECT_CHARS = 6000/.test(q), '对象题干长度硬闸被改')
  c.ok(/设问|askKind|compareAsk/.test(q), '设问一致性硬闸疑似被删')
})

m.test('🔴 B7 追加式改判：历史拍板原样保留，新台账 / 提案 / 报告齐备', (c) => {
  const r = read(REPORT), d = read(DECISION), p = read(PROPOSAL), p9 = read(P009)
  c.ok(/P1 \/ P2 \/ P3 一律不启动/.test(r), '报告 §8.5 历史拍板被涂改（应追加不回溯）')
  c.ok(/P1 \/ P2 \/ P3 全部未批准/.test(p9), 'P-009 历史文本被涂改')
  c.ok(/^## D-015/m.test(d) && /^## D-014/m.test(d), '台账缺 D-015 或 D-014')
  c.ok(/追加式改判/.test(d), 'D-015 没写明是追加式改判')
  c.ok(/^### [①-⑥]/m.test(p), 'P-012 缺六栏结构')
  c.ok(/提案号：P-012/.test(p) && /状态：已批准/.test(p), 'P-012 缺编号或批准状态')
  c.ok(/## 11\./.test(r), '报告缺 §11 落地结论')
  c.ok(/第二层上线准入仍未全绿|第二层上线准入.*未全绿/.test(d), '台账没写「准入仍未全绿」')
  c.ok(/题干 A \+ 别人解析|题干 A＋别人解析/.test(r), '报告没保留张冠李戴残余风险')
})

m.test('🔴 B8 两个一键回退仍在，且用户贡献 / 整包部署未混入', (c) => {
  const svc = read(SERVICE_ND), p = read(PROPOSAL)
  c.ok(/NETDISK_TEXT_RECALL/.test(svc), 'P2 正文召回回退开关丢了')
  c.ok(/textAnchors = textRecallEnabled\(\)/.test(svc), '回退开关没真正控制正文通道')
  c.ok(/前端.*发版|上传发版/.test(p), 'P-012 没写明前端仍需人工发版')
  c.ok(/QUESTION_OBJECTS_STRICT=1/.test(p) && /仍锁/.test(p), 'P-012 没写 strict 仍锁')
  c.ok(!/共享自己的题|贡献通道已实现/.test(svc), '用户贡献通道混进了本期代码')
})

export default m
