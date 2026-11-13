// 模块 47：题库整理守卫（D-053）
//
// 守两件事，都是「整理完就漂移」的高发点：
//
// ① 空题判据白名单漏了全角句点 `．`(U+FF0E)
//    QUESTION_START 把 `N．` 当题号标点，切出的对象 stem 就是 `1．`/`54．0` 这类
//    纯题号；D-047 的「允许字符」白名单只收 `。`、`、` 却漏了 `．` ⇒ 这 3,316 条
//    空壳以 link_status='ok' 入库。生产实测：补 `．` 后命中 3,316 条、其中
//    U+FFFD 编码损坏 **0 条**，说明补这一个字符不会误伤「原文是真题目」的乱码题干。
//    判据散在 3 个文件（build / mark / measure sql），必须逐字同口径。
//
// ② 去重判据散在 2 处（存量整理脚本 / 重建收尾），必须一致
//    2026-11-13 生产实测：603,739 个 ok 对象按 (user_id, stem_text) 有 112,048 组
//    重复 / 134,852 冗余，但 **51,671 组同题干而解析不同**（同一题的不同解答），
//    删了会丢内容 ⇒ 只处理 stem+solution 都相同的 61,524 组 / 79,449 冗余。
//    且 question_objects 是派生表，光在库里标记、重建就会复活 ⇒ 构建脚本收尾
//    必须跑同口径去重，否则「整理」是假进展。
//
// 🔴 本模块只守静态契约，不碰判定层、不宣称任何检索效果。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M47', '题库整理守卫：空题白名单与去重判据同口径（D-053）')
const ROOT = path.resolve(process.cwd(), '..')

const BUILD = 'server/scripts/question-objects-build.mjs'
const MARK = 'server/scripts/question-objects-mark-meaningless.mjs'
const MEASURE = 'server/scripts/measure-object-meaningless.sql'
const DEDUPE = 'server/scripts/question-objects-dedupe.mjs'

function read(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return fs.readFileSync(p, 'utf8')
}

/** 白名单里「、。，．；：」这一段是 D-053 补 `．` 的锚点 */
const ALLOW_ANCHOR = '、。，．；：'
/** 去重判据三要素，两处必须同时出现 */
const PARTITION = "PARTITION BY user_id, stem_text, coalesce(solution_text, '')"
const REASON = '题干与解答完全相同（保留同组首条），D-053 去重'

m.test('A1 去重脚本存在且导出判据 CTE', (c) => {
  const src = read(DEDUPE)
  c.ok(src.includes('DUP_RANKED_CTE'), '缺少 DUP_RANKED_CTE')
  c.ok(src.includes('SELECT_DUP_IDS'), '缺少 SELECT_DUP_IDS')
  c.ok(src.includes('COUNT_DUP_LEFT'), '缺少 COUNT_DUP_LEFT（复核归零依赖它）')
})

m.test('A2 两处去重判据逐字同口径（PARTITION BY）', (c) => {
  const d = read(DEDUPE); const b = read(BUILD)
  c.ok(d.includes(PARTITION), '去重脚本缺少 PARTITION BY 判据')
  c.ok(b.includes(PARTITION), '构建脚本收尾缺少同一 PARTITION BY 判据')
  c.ok(d.includes('ORDER BY id') && b.includes('ORDER BY id'), '两处都必须按 id 确定性地保留首条')
})

m.test('A3 两处都只处理 ok，且 reason 一致', (c) => {
  const d = read(DEDUPE); const b = read(BUILD)
  c.ok(d.includes("WHERE link_status = 'ok'") && b.includes("WHERE link_status = 'ok'"), '两处必须都限定 link_status=ok（不得覆盖既有 rejected）')
  c.ok(d.includes(REASON), '去重脚本 reason 与登记不符')
  c.ok(b.includes(REASON), '构建脚本 reason 与去重脚本不一致')
})

m.test('A4 构建脚本收尾确实调用去重，且只在全量 apply 时', (c) => {
  const b = read(BUILD)
  c.ok(b.includes('async function dedupeAfterBuild('), '缺少 dedupeAfterBuild 定义')
  c.ok(b.includes('stats.deduped = await dedupeAfterBuild(client)'), 'runDb 收尾未调用去重')
  c.ok(/if \(APPLY && LIMIT === 0\)/.test(b), '必须限定 --apply 且非 --limit，否则局部重建会误伤')
})

m.test('A5 去重只标记不删行（保护配图关联与 object_index）', (c) => {
  const d = read(DEDUPE); const b = read(BUILD)
  c.ok(!/DELETE\s+FROM\s+question_objects/i.test(d), '去重脚本不得物理删行')
  c.ok(!/TRUNCATE/i.test(d), '去重脚本不得 TRUNCATE')
  // build.mjs 全文有 pruneExtra() 的合法 DELETE（D-050 护栏），不能全文扫；
  // 只检查 dedupeAfterBuild 函数体内不许删行。
  const s = b.indexOf('async function dedupeAfterBuild(')
  const e = b.indexOf('\n// ---------- main', s)
  c.ok(s > 0, '找不到 dedupeAfterBuild 定义')
  const fnBody = b.slice(s, e > 0 ? e : b.length)
  c.ok(!/DELETE\s+FROM|TRUNCATE/i.test(fnBody), '构建收尾去重不得物理删行')
  c.ok(d.includes("link_status = 'rejected'"), '去重脚本必须用 rejected 标记')
})

m.test('B1 去重脚本护栏：默认 dry-run + 备份硬锁', (c) => {
  const d = read(DEDUPE)
  c.ok(d.includes("APPLY = has('--apply')"), '缺少 --apply 开关')
  c.ok(d.includes('if (!APPLY)'), '缺少 dry-run 短路')
  c.ok(d.includes("BACKUP_ACK = has('--i-have-backup')"), '缺少备份确认开关')
  c.ok(d.includes('if (!BACKUP_ACK)'), '写库前未强制校验备份确认')
})

m.test('B2 去重脚本护栏：10% 阈值、分批校验、复核归零、可回滚', (c) => {
  const d = read(DEDUPE)
  c.ok(/pct\s*>\s*10/.test(d), '缺少「命中超 10% 拒绝」护栏')
  c.ok(d.includes('r.rowCount !== chunk.length'), '缺少每批行数校验')
  c.ok(d.includes('afterRows[0].n !== 0'), '缺少复核归零断言')
  c.ok(d.includes('ROLLBACK_FILE'), '缺少按清单回滚路径')
})

m.test('B3 去重脚本不碰判定层、不 bump 版本', (c) => {
  // 注释里引用了 question-match.ts:692 说明读侧排除依据，只看代码行（M46 A1 同款）。
  const code = read(DEDUPE).split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  }).join('\n')
  c.ok(!code.includes('question-match'), '去重脚本不得 import 判定层')
  c.ok(!/OBJECT_ENGINE_VERSION|CACHE_VERSION/.test(code), '去重脚本不得改引擎/缓存版本')
})

m.test('C1 三处空题白名单都补了全角句点 ．', (c) => {
  for (const f of [BUILD, MARK, MEASURE]) {
    c.ok(read(f).includes(ALLOW_ANCHOR), `${f} 缺少 D-053 白名单锚点（漏 ．）`)
  }
})

m.test('C2 measure sql 四处正则全部同步（防只改一处）', (c) => {
  const sql = read(MEASURE)
  const n = sql.split(ALLOW_ANCHOR).length - 1
  c.ok(n >= 4, `measure sql 中白名单锚点只出现 ${n} 次，应至少 4 次（4 段查询）`)
})

m.test('C3 补 ． 不得顺带放宽编码损坏白名单', (c) => {
  const b = read(BUILD); const mk = read(MARK)
  c.ok(!b.includes('\\uFFFD') && !mk.includes('\\uFFFD'), '不得把 U+FFFD 放进允许字符类（原文可能是真题目）')
  c.ok(b.includes('①-⑩-') && mk.includes('①-⑩-'), '白名单尾部字符集须保持不变')
})

m.test('C4 三处白名单仍要求「无汉字且无字母」', (c) => {
  const b = read(BUILD); const mk = read(MARK); const sql = read(MEASURE)
  c.ok(b.includes('a-zA-Z') && mk.includes('a-zA-Z') && sql.includes('a-zA-Z'), '三处都必须保留拉丁字母判据')
  c.ok(sql.includes('[一-龥]'), 'measure sql 必须保留汉字判据')
  c.ok(b.includes('\\u4e00-\\u9fa5'), 'build 必须保留汉字区间判据')
})

export default m
