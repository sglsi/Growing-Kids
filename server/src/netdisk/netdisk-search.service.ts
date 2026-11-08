import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { BaiduNetdiskService } from '../storage/baidu-netdisk.service'
import { extractDocContent } from '../ocr/pdf-tool'
// P-006 / D-009：检索词（找资料）与判定锚点（认原题）分开，真相源在 shared/
import {
  TOPIC_WORDS,
  NOISE_PREFIX,
  extractDistinctive,
  judgeObjects,
} from '../shared/question-match'
import type { Distinctive, SourceLocation } from '../shared/question-match'
// P-010 / D-013：优先消费入库时预切分的结构化题目对象（P1），无对象时回退 P0
import { loadQuestionObjects, judgeWithStore, storeValidationOpts } from '../shared/question-object-store'
// P-011 / D-014：公共资料库固定 owner + 正文归一化 + 召回开关
import { publicLibraryOwner, flatText, textRecallEnabled } from '../shared/public-library'
// P-014 / D-017：检索前输入合格性闸门（只读判定，不碰判定层）
import { guardQuestionInput } from '../shared/input-guard'
// P-015 / D-018：参考例题（相似题思路借鉴）——与原题判定并列，判定层零改动
import { collectReferences, mergeReferences, REFERENCE_DISCLAIMER } from '../shared/question-reference'
import type { ReferenceExample } from '../shared/question-reference'

/**
 * 百度网盘资料检索（「资料库搜题」的第一顺位来源）。
 *
 * ## 架构：索引在前，网盘在后（思傅 2026-11-03 定）
 * 一句话：**搜索只在本库做，要看内容才去网盘读。**
 *   ① 先由 `scripts/netdisk-index.mjs` 递归列一遍 /学生，把文件名/路径/大小落进
 *      `netdisk_files`（只列目录、不下载任何文件，万级文件约十几分钟，可增量重跑）；
 *   ② 检索时只查这张表：纯 SQL + 内存排序，**毫秒级**，结果稳定；
 *   ③ 命中候选要正文时，才按 `fs_id` 去网盘下载并抽文字层，抽过的落 `text_content`。
 *
 * 为什么不再每次实时搜网盘（上一版的做法）：
 * 网盘 `method=search` 每次返回的候选子集不稳定，同一道题连搜两次排在前面的
 * 文件会变（R-工程-10），而且一次 3~7s。索引化之后这两个问题一起消失。
 *
 * ## P-011 / D-014：公共资料库（2026-11-07 定稿）
 * 这批教辅是**运营者提供、所有登录用户共享**的公共资料库，不带用户属性。
 * 因此本服务对 `netdisk_files` / `question_objects` 的读写一律走
 * `publicLibraryOwner()`（固定常量），**绝不按登录用户过滤**——否则 326,680 个
 * 结构化对象对新账号零命中（11-07 L3 体检结论）。私有资料（`library_docs`、
 * 错题、答案缓存）仍由各自 service 按 `userId` 隔离，不在本文件范围内。
 * `check-isolation` 门禁仍然看得见 `.eq('user_id', …)`，无需任何豁免。
 *
 * ## P2 正文召回（报告 §4 P2）
 * `searchLocal()` 从「只查 name/path」改为**双通道**：文件名/路径通道 +
 * `text_flat` 正文通道（只用 ≥4 字长锚点），合并去重后按锚点共现数排序。
 * `NETDISK_TEXT_RECALL=0` 可一键退回纯文件名召回。
 *
 * ## P2 补齐 / P3（报告 §4 P2/P3，P-012 / D-015）
 * - SQL 两条通道都按 `fs_id` 定序，`limit` 只作**扫描上限**（达上限留痕告警）；
 *   共现数排序与取 top 一律在 JS 侧、**合并之后**完成，杜绝无排序的任意截断。
 * - 统一打分：主排序键只有 `keyHits = nameHits + tHits×2`（归一化长锚点共现），
 *   `score` 是同源共现率、只作展示；bigram `coverage` 退出主排序。
 * - P3 深挖 3 → **8**，主预算 **8s** + 18s 绝对兜底；默认只消费离线铺量的正文，
 *   `NETDISK_ONLINE_EXTRACT=1` 才允许实时下载抽取（应急回退）。
 * - 🔴 **判定层一行未放宽**：`exact` 仍过 P0 六条硬闸 + P1 指纹/版本校验，
 *   `QUESTION_OBJECTS_STRICT=1` 与第二层上线准入继续锁。
 *
 * ## P-013 / D-016：粗筛词选择（2026-11-07 真实题实测）
 * `11-07 晚` 6 条真实录入题 `mode=kb` 全 `topic`、答案为空；一度归因于上游 OCR/切题质量，
 * 经只读实测**证伪**：手工切单题 + 修错字后仍 exact=0；L3 库内 `question_objects`
 * 含 `BMDN` 4 行（有解析、`link_status=ok`）、`text_flat` 含 `BMDN` 47 份；判定层
 * `store.usable=49` 且拒绝理由是「对象内锚点共现不足 1/17」——它拒绝的是别的题，判对了。
 * 真断点是**召回选词**：`textAnchors` 取 `dist.keys` 前 4 个，而 `keys` 被 12 个
 * 6 字滑窗占满截断 ⇒ 几何题用 `DABC60/C60AB3/AB3BC5/BC5MN分`，英文题用
 * `tsun/unam/swep/thro/roug/vill`，原题文件根本进不了深挖 8 份。
 * 本轮只改 `extractKeys()`（拉丁整词）与新增 `pickTextAnchors()`（判别性分层），
 * **`shared/question-match.ts` 一行未动**，深挖 8/8s 与六条硬闸全部不变。
 * 🔴 仍然只是「让候选有资格被审」，不是「审得松一点」；残余风险与第二层准入仍锁。
 *
 * ## 已知边界（别对用户承诺过头）
 * - 扫描版 PDF（无文字层）抽不到正文 ⇒ 只能靠文件名/路径命中；
 * - 默认关闭在线抽取时，**未铺量正文的文件直接跳过深挖**（等离线抽取或开回退开关）；
 * - 深挖 8 份仍是**上限**而不是承诺：排序靠共现数，不等于「都能搜到」；
 * - 索引是**快照**：网盘新增的文件要重跑脚本才进得来；删除的文件在
 *   `--full-clean` 完整遍历后才清理；
 * - P2/P3 改的是**谁有资格被审**，不是「审得松一点」：残余的
 *   「题干 A + 别人解析」风险**未消除**（报告 §8.4）。
 */

const TABLE = 'netdisk_files'

/** 检索范围：优先用环境变量覆盖（不同家庭资料目录不一样） */
export function searchRoot(): string {
  return (process.env.NETDISK_SEARCH_ROOT || '/学生').trim().replace(/\/+$/, '') || '/学生'
}

/**
 * P3 / D-015：单次检索允许深挖正文的候选数。
 * 8 份是拍板的保守档（报告 §4 原建议 20~30），配合 8s 主预算守住 §4 P0-3 的 P95<3s；
 * 可用 `NETDISK_DEEP_FILES` 覆盖，但**不得靠放宽它补偿召回不足**。
 */
const MAX_DEEP_FILES = Number(process.env.NETDISK_DEEP_FILES ?? 8)
/** P3：正文深挖主预算（毫秒），用完即按已有结果返回 */
const DEEP_BUDGET_MS = Number(process.env.NETDISK_DEEP_BUDGET_MS ?? 8_000)
/** P3：绝对兜底预算——任何配置下单次检索的深挖阶段都不得超过 18s */
const DEEP_HARD_BUDGET_MS = 18_000
/**
 * P3：默认**禁止在线下载/抽取**，只消费离线铺量的 `text_status='ok'` 正文。
 * 设 `NETDISK_ONLINE_EXTRACT=1` 才恢复原来的实时 downloadByFsId + OCR（应急/灾备回退）。
 * 理由：C-资源（4 核 4G 不该在检索请求里扛 OCR），且在线路径会顺手写缓存。
 */
const ONLINE_EXTRACT_ENABLED = process.env.NETDISK_ONLINE_EXTRACT === '1'
/** 可抽正文的扩展名（老 .doc 二进制 pdf_tool 解不了，只能按文件名命中） */
const TEXT_EXTS = new Set(['pdf', 'docx', 'txt', 'md'])
/** 单文件抽取上限：超大文件不值得为一次检索拉下来 */
const MAX_TEXT_BYTES = Number(process.env.NETDISK_TEXT_MAX_BYTES ?? 40 * 1024 * 1024)
/** 落库正文截断长度（够做关键词匹配即可，不当正文库用） */
const MAX_TEXT_CHARS = Number(process.env.NETDISK_TEXT_MAX_CHARS ?? 200_000)
/** 单次检索最多并发几个 search key */
const MAX_KEYS = 6
/**
 * P2 补齐：本地索引**扫描上限**（不是候选截断）。
 * SQL 按 `fs_id` 定序后最多取这么多行，达到上限要留痕告警；
 * 真正的「按共现数排序取 top」在两条通道合并后的 JS 侧完成。
 * §3.5 实测 15,123 行曾被 `.limit(500)` 任意截断，正是这里要修的。
 */
const LOCAL_CANDIDATE_LIMIT = Number(process.env.NETDISK_LOCAL_LIMIT ?? 2_000)
/**
 * 单个 search key 返回条数。
 * ⚠️ 别调小：网盘 search **没有稳定排序**，同一 key 两次调用返回的子集可能不同
 * （实测 30 条时，同一题干两次检索排在前面的候选会变，正文深挖跟着落空）。
 * 取大一点让候选池稳定，再在本地按「命中关键词数 → bigram 覆盖度」排序。
 */
const KEY_LIMIT = 100
/** L1 合并后进入 L2 的候选池大小 */
const L1_POOL = 20
/**
 * P2 正文通道：只用 ≥4 字的**区分性长锚点**，最多 4 个。
 * 🔴 别把 `extractKeys()` 的 2~4 字主题词 / 滑窗词塞进来：正文 ilike 会命中一大片，
 *    10,454 份 / 9,450 万字上单次检索直接超时（报告 §4 P1-4）。
 * P-013 / D-016：数量保持 4（拍板），只换 `pickTextAnchors()` 的**选词策略**，
 *    不增加 `ilike` OR 数 ⇒ P95<3s 的预算不被改动。
 */
const TEXT_RECALL_KEYS = Number(process.env.NETDISK_TEXT_RECALL_KEYS ?? 4)
/** P2 补齐：正文通道**扫描上限**（语义同上，达到上限留痕告警） */
const TEXT_CANDIDATE_LIMIT = Number(process.env.NETDISK_TEXT_LIMIT ?? 2_000)
/**
 * P2 补齐：两通道合并去重后，按统一分数排序取 top 的候选数。
 * 🔴 这一道才是「top-N」——发生在排序**之后**，不是 SQL 的任意截断。
 */
const CANDIDATE_TOP_N = Number(process.env.NETDISK_CANDIDATE_TOP_N ?? 300)

// ⚠️ 主题词表 / 噪声前缀已搬到 `shared/question-match.ts`（P-006 单一真相源）：
//    检索与判定共用一份词表，避免「召回时算主题词、判定时又算一遍」出现口径漂移。
function isNoise(s: string): boolean {
  if (s.length < 2) return true
  return NOISE_PREFIX.some((p) => s.startsWith(p))
}

/** 去掉标点/空白后的连续中文数字块 */
function plainBlocks(text: string): string[] {
  return (text || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((s) => s.length >= 2)
}

/**
 * 从题干里挑出用于网盘**召回**的 key（主题词优先 → 4 字滑窗兜底）。
 *
 * ⚠️ P-006：这里只负责「把同专题资料找出来」，**不负责判定是不是这道题**。
 *    判定用 `shared/question-match.ts` 的区分性片段（数值 / 变量 / 条件短语），
 *    两组词在 `search()` 里合并做粗筛，主题词兜底保证不丢原有召回能力。
 */
export function extractKeys(question: string): string[] {
  const q = question || ''
  const out: string[] = []
  const push = (s: string) => {
    const k = s.trim()
    if (k.length >= 2 && !out.includes(k)) out.push(k)
  }

  // ① 学科词：命中即用（题干里出现什么知识点，多半就有对应教辅）
  for (const w of TOPIC_WORDS) {
    if (q.includes(w)) push(w)
    if (out.length >= MAX_KEYS) return out
  }

  // ② 滑窗兜底：连续中文块按 4 字、步长 2 切
  for (const block of plainBlocks(q)) {
    if (out.length >= MAX_KEYS) break
    if (/^[0-9]+$/.test(block)) continue
    // P-013 / D-016：拉丁字母块**按整词取**，不再用 4 字滑窗。
    // 实测英文题干 "The tsunami swept through…" 被切成 tsun/unam/swep/thro/roug/vill，
    // 正文召回全是英文绘本噪声。短词与功能词直接丢弃（ilike 会命中一大片）。
    if (/^[A-Za-z]+$/.test(block)) {
      const w = block.toLowerCase()
      if (w.length >= 5 && !LATIN_STOP.has(w)) push(w)
      continue
    }
    for (let i = 0; i + 4 <= block.length; i += 2) {
      const seg = block.slice(i, i + 4)
      if (isNoise(seg)) continue
      push(seg)
      if (out.length >= MAX_KEYS) break
    }
  }
  return out.slice(0, MAX_KEYS)
}

/**
 * P-013 / D-016：英文高频功能词——不进召回词表。
 * 这些词在英文绘本 / 文件名里到处都是，做 ilike 只会把扫描上限吃满。
 */
const LATIN_STOP = new Set([
  'with', 'the', 'and', 'for', 'that', 'this', 'from', 'have', 'been', 'were',
  'what', 'when', 'which', 'there', 'their', 'would', 'could', 'should', 'about',
  'photo', 'please', 'choose', 'following', 'according',
])

/**
 * P-013 / D-016：通用点名判定。
 * `ABCD`（字母表连续序）在生产 `text_flat` 里命中 **5,027 份**（总共 10,431 份），
 * `ADDC` 这类相邻重复也是「AD / DC 两个点名粘连」的高频噪声。
 * 放进 4 个 `ilike` OR 里会把 2,000 行扫描上限吃满，把真正的原题文件挤出去。
 */
export function isGenericPointLabel(s: string): boolean {
  for (let i = 1; i < s.length; i += 1) {
    if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== 1) {
      // 非连续序：再看有没有相邻重复（ADDC / MNNN）
      return /(.)\1/.test(s)
    }
  }
  return true // 整串都是连续字母表序 ⇒ ABCD / BCDE
}

/**
 * P-013 / D-016：正文粗筛词选择（**只影响召回，不碰判定**）。
 *
 * 修复前：`textAnchors` 直接取 `extractDistinctive().keys` 的前 4 个，而 `keys`
 * 被 12 个 6 字滑窗占满并截断 ⇒ 几何题实际用的是
 * `DABC60 / C60AB3 / AB3BC5 / BC5MN分`（归一化删符号后拼出的题干开头碎片），
 * 英文题是 `tsun / unam / swep`。L3 实测 `text_flat` 含 `BMDN` 的 47 份原题文件
 * **一份都进不了深挖 8 份**，6 条真实录入题 + 5 个手工单题 exact 全 0。
 *
 * 修复后按判别性分层挑，仍只取 `limit` 个、不增加 `ilike` OR 数：
 *   ① 独立符号锚点（`extractDistinctive` ③ 产出的纯大写点名），排除通用点名；
 *      实测 `BMDN` DF=47、`DMDN` DF=74，`ABCD` DF=5027 被挡掉。
 *   ② 拉丁整词（英文题干）；
 *   ③ 中文长锚点按**全题干均匀采样**，保证覆盖后段的设问与图形标记。
 *
 * 🔴 判定层 `shared/question-match.ts` 一行未动：`anchors` / `longAnchors` /
 *    `judgeObjects` / 六条硬闸全部原样，本函数只重排「拿哪些词去 SQL 粗筛」。
 *    `GK-SRS-20a M10/M11`：只修候选可得性，不放宽任何放行条件、不新增宣称。
 */
export function pickTextAnchors(question: string, dist: Distinctive, limit = TEXT_RECALL_KEYS): string[] {
  const out: string[] = []
  const push = (s: string) => {
    const k = s.replace(/[%,()]/g, '')
    if (k.length >= 4 && !out.includes(k)) out.push(k)
  }

  // ① 独立点名最多占 2 个名额，避免挤掉设问片段
  for (const a of dist.anchors) {
    if (out.length >= 2) break
    if (/^[A-Z]{4,6}$/.test(a) && !isGenericPointLabel(a)) push(a)
  }

  // ② 拉丁整词（英文题干）；中文题干的 `plainBlocks` 产不出纯拉丁 ≥5 字块，天然跳过
  for (const b of plainBlocks(question)) {
    if (out.length >= limit) break
    if (!/^[A-Za-z]{5,}$/.test(b)) continue
    const w = b.toLowerCase()
    if (!LATIN_STOP.has(w)) push(w)
  }

  // ③ 中文长锚点：从头到尾均匀采（原来只取开头 4 个）
  const cjk = dist.longAnchors.filter((a) => /[\u4e00-\u9fa5]/.test(a))
  const step = Math.max(1, Math.ceil(cjk.length / Math.max(1, limit)))
  for (let i = 0; i < cjk.length && out.length < limit; i += step) push(cjk[i])

  return out.slice(0, limit)
}

/** 中文 bigram 集合（打分用；比分词稳定，不依赖词表） */
function bigrams(s: string): Set<string> {
  const clean = (s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
  const set = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** 题干 bigram 被命中文本覆盖的比例（0~1） */
function coverage(questionSet: Set<string>, text: string): number {
  if (questionSet.size === 0) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of questionSet) if (t.has(g)) hit++
  return hit / questionSet.size
}

export interface NetdiskHit {
  fsId: number
  name: string
  path: string
  sizeBytes: number
  /** 命中方式：name = 文件名/路径命中；content = 抽正文后才命中 */
  hit: 'name' | 'content'
  /** 0~1，越大越相关 */
  score: number
  /** 正文命中时的上下文片段（⚠️ 仅排障用，P-006 起**禁止**当作答案展示） */
  snippet?: string
  /** P-006：原题判定档位。只有 exact 才允许把 solutionExcerpt 当答案 */
  matchLevel?: 'exact' | 'topic'
  /** exact 时定位到的【答案】/【解析】段（不是任意上下文） */
  solutionExcerpt?: string
  /** 题干长锚点在这份正文里的命中数（排障用） */
  anchorsHit?: number
  /** P2：`text_flat` 正文通道命中的长锚点数（召回阶段，排障 + 排序用） */
  textHits?: number
  /** P-009：exact 时定位到的「哪份资料、第几题、原文哪一段」 */
  sourceLocation?: SourceLocation
  /** P-009：多因子明细（排障 / 验收集统计） */
  matchFactors?: Record<string, unknown>
  /** P-009：未放行原因（topic 时可解释） */
  rejectReason?: string
}

export interface NetdiskSearchResult {
  hits: NetdiskHit[]
  /** 本次用到的搜索词（排障用，也便于前端说明「按什么搜的」） */
  keys: string[]
  /** 人类可读的说明（未配置/无命中/扫描版抽不到正文等） */
  note: string
  tookMs: number
  /** P-006：判定为「找到了这道题 + 解析段」的份数 */
  exactCount: number
  /**
   * P-015 / D-018：题目不完全一致、但解题思路与解题方法具有借鉴意义的库内例题。
   * ⚠️ 与 exact **完全并列**：只有 exact 才进 answer；这里永远不进 answer、
   *    不置 verified=true、不提供「采纳」。每条 stem 与 solution 来自同一个
   *    `question_objects` 行（同源配对），并带来源位置供家长回原文核对。
   */
  references?: ReferenceExample[]
  /** 事先声明文案：前端必须在渲染任何参考内容**之前**先行渲染 */
  referenceDisclaimer?: string
}

interface CacheRow {
  id: string
  fs_id: number
  name: string
  path: string
  ext: string | null
  size_bytes: number | null
  text_content: string | null
  text_status: string
}

@Injectable()
export class NetdiskSearchService {
  private readonly logger = new Logger(NetdiskSearchService.name)

  constructor(private readonly netdisk: BaiduNetdiskService) {}

  available(): boolean {
    return this.netdisk.enabled()
  }

  missingKeys(): string[] {
    return this.netdisk.missingKeys()
  }

  /**
   * 搜公共资料库。
   *
   * 🔴 P-011：签名里**没有 userId**——公共资料不按登录用户隔离
   *    （`publicLibraryOwner()` 是常量，M33 有静态断言）。
   *    鉴权仍由 controller 的 `requireUserId()` 负责：必须登录才能查，
   *    但登录后看到的都是同一批运营者提供的资料。
   *
   * @param question 题干（原样传，内部自己提 key）
   * @param opts.deep 是否允许深挖正文（默认 true；纯文件名检索更快）
   */
  async search(
    question: string,
    opts: { deep?: boolean; limit?: number; referenceMode?: 'judge' | 'examples' } = {},
  ): Promise<NetdiskSearchResult> {
    const started = Date.now()
    const limit = Math.min(20, opts.limit ?? 8)
    const deep = opts.deep !== false
    // P-016 / D-019：闸门的作用域只到「判定层」。'examples' 是给 answer-search 在
    // 不合格输入时用的**只读参考例题模式**：照常召回、照常收集同源配对的例题，
    // 但全程不送判定、不输出任何 hits / exact。/api/netdisk/search 直连不传该参数
    // ⇒ P-014 双入口短路行为原样不变（M38 有静态断言）。
    const examplesOnly = opts.referenceMode === 'examples'

    // P-014 / D-017：检索前输入合格性闸门（20a M10 宣称不超能力 / M11 如实告知）。
    // 整页、多小问连排、非题目文本一律**不送判定**，直接如实提示：
    // 11-07 晚实测切题后唯一上升的 exact 是「作文要求」片段（20 字、无设问）
    // 走 askQuestion=unknown 宽松路径命中英语教辅第 80 对象、带 972 字解析 ⇒ 假 exact。
    // 🔴 只读判定、不改原文任何字符、不放宽任何硬闸、不自动切题、不逐题多次检索。
    // 🔴 目标不是提升命中（库覆盖 / 字面差异 / 英文锚点仍是主因），是让假 exact 归零。
    const guard = guardQuestionInput(question)
    // 🔴 不合格输入：**默认模式不送判定并如实告知**（D-017 原样）；
    //    examples 模式继续往下走，但下面所有判定调用都会被跳过（D-019 不变量 C）。
    if (!guard.ok && !examplesOnly) {
      return {
        hits: [], keys: [], exactCount: 0,
        note: guard.message, tookMs: Date.now() - started,
      }
    }

    // ⚠️ 这里**不**先判 available()：搜索只查本库索引，网盘凭证失效/过期
    //    不该让「搜自己索引过的资料」跟着失灵。只有走实时兜底时才要求凭证可用。

    // P-006：主题词仍排第一顺位（文件名/路径召回全靠它），只补少量区分性片段。
    // ⚠️ 别把 11 个 6 字长锚点全塞进来：它们不会出现在文件名里，却会把主题词
    //    挤出 keys ⇒ 文件名召回直接归零。原题判定在正文深挖阶段用 judge() 做，不靠粗筛。
    const dist = extractDistinctive(question)
    const distKeys = dist.keys
    const keys = [...new Set([...extractKeys(question), ...distKeys.slice(0, 3)])].slice(0, MAX_KEYS + 3)
    if (keys.length === 0) {
      return {
        hits: [], keys, exactCount: 0,
        note: '题干太短，提不出可用的检索词', tookMs: Date.now() - started,
      }
    }
    // P2 正文通道：只用 `extractDistinctive()` 产出的 ≥4 字长锚点，
    // 与判定层同源（report §4 P2「统一打分口径」）。短主题词绝不进正文 ilike。
    // P-013 / D-016：由「按生成顺序取前 4 个」改为 `pickTextAnchors()` 按判别性分层挑选。
    // 修复前前 4 个恒为题干开头的 6 字滑窗碎片，原题文件一份都进不了深挖池。
    const textAnchors = textRecallEnabled()
      ? pickTextAnchors(question, dist, TEXT_RECALL_KEYS)
      : []

    const qSet = bigrams(question)
    /** P-015 / D-018：深挖时按来源收集参考例题，最后跨来源去重取 top-N */
    const referencePools: ReferenceExample[][] = []
    const pool = new Map<number, NetdiskHit>()
    /** 每个候选被几个不同检索词命中——这是比 bigram 覆盖度更强的信号 */
    const keyCount = new Map<number, number>()

    // ---------- L0：搜索只在**本库索引**里做（思傅 2026-11-03 定） ----------
    // 以前每次都实时搜网盘：3~7s，且网盘 search 返回的候选子集不稳定
    // ⇒ 同一道题连搜两次排序会变（R-工程-10）。现在文件清单已经预先落库
    // （scripts/netdisk-index.mjs），检索是纯 SQL：毫秒级、结果稳定、网盘抽风也能用。
    // P2 补齐：粗筛不再需要 bigram qSet（统一打分只有长锚点共现数一个口径）
    const { hits: localHits, total: indexSize, textMatched } = await this.searchLocal(
      keys, textAnchors,
    )
    for (const h of localHits) {
      pool.set(h.fsId, h)
      keyCount.set(h.fsId, h.keyHits)
    }

    // 索引还没建（首次使用 / 换机 / 清过表）时，实时兜底补一次，
    // 免得功能在「索引未建」状态下直接空转。索引一旦有了就永不回落到实时检索。
    let liveFallback = false
    if (localHits.length === 0 && indexSize === 0) {
      if (!this.available()) {
        this.logger.warn(`[netdisk] 资料库存储未配置，缺少 ${this.missingKeys().join(' / ')}；索引也可能还没建`)
        return {
          hits: [], keys, exactCount: 0, tookMs: Date.now() - started,
          // 排障细节（缺哪个 key）只写日志：用户看到的应该是「资料库暂时不可用」，
          // 而不是第三方的配置项名（思傅 2026-11-03：资料存在哪与本项目无关）。
          note: '本库还没有资料索引，资料存储也还没配好，请联系维护者',
        }
      }
      liveFallback = true
      const root = searchRoot()
      for (const key of keys) {
        let items: Record<string, unknown>[] = []
        try {
          items = await this.netdisk.search(key, root, KEY_LIMIT)
        } catch (e) {
          this.logger.warn(`[netdisk] 实时兜底 search "${key}" 失败: ${e instanceof Error ? e.message : e}`)
          continue
        }
        for (const it of items) {
          if (Number(it.isdir) === 1) continue
          const fsId = Number(it.fs_id)
          if (!fsId) continue
          if (pool.has(fsId)) {
            keyCount.set(fsId, (keyCount.get(fsId) || 1) + 1)
            continue
          }
          const name = String(it.server_filename || '')
          const path = String(it.path || '')
          const score = Math.max(coverage(qSet, name), coverage(qSet, path) * 0.6)
          keyCount.set(fsId, 1)
          pool.set(fsId, {
            fsId,
            name,
            path,
            sizeBytes: Number(it.size) || 0,
            hit: 'name',
            score: Number(score.toFixed(3)),
          })
        }
      }
    }

    // P2 排序：正文通道命中的**长锚点数**最优先（与判定层同源），
    // 其次才是统一共现数（keyCount 来自 searchLocal 的 keyHits）与同源 score。
    // 🔴 P3 / D-015：深挖上限放宽到 8 后前置排序更重要 —— 8 个名额必须给
    //    正文共现数最高的候选，否则 P2 多召回的文档依旧轮不到被判定。
    //    两套分数已合并，bigram 覆盖度不再参与主排序。
    const ranked = [...pool.values()].sort(
      (a, b) =>
        (b.textHits || 0) - (a.textHits || 0) ||
        (keyCount.get(b.fsId) || 0) - (keyCount.get(a.fsId) || 0) ||
        b.score - a.score ||
        b.name.length - a.name.length,
    )
    const l1 = ranked.slice(0, Math.max(limit, L1_POOL))

    // 实时兜底才需要沉淀（正常路径本来就来自索引，写回去纯属浪费）
    if (liveFallback) void this.upsertMeta(l1)

    // ---------- L2：对头部候选抽正文，补「文件名没写但正文里有」的情况 ----------
    const deepDone: NetdiskHit[] = []
    if (deep && l1.length > 0) {
      // P3 / D-015：8s 主预算 + 18s 绝对兜底，两者任一到点即停。
      // 放宽到 8 份不等于放弃 §4 P0-3 的 P95<3s：排序前置让最相关的先判，
      // 预算保证「判不完就按已有结果返回」，绝不拖成慢请求。
      // P-016：不合格输入只收参考例题，给更保守的份数与主预算（绝不超过合格输入），
      // 硬兜底仍 18s。判定层常量与合格输入的 8 份 / 8s 口径**一个都没改**。
      const deepFileLimit = examplesOnly ? Math.min(MAX_DEEP_FILES, 4) : MAX_DEEP_FILES
      const deepBudgetMs = examplesOnly ? Math.min(DEEP_BUDGET_MS, 4_000) : DEEP_BUDGET_MS
      const deadline = started + deepBudgetMs
      const hardDeadline = started + DEEP_HARD_BUDGET_MS
      for (const cand of l1.slice(0, deepFileLimit)) {
        if (Date.now() > deadline || Date.now() > hardDeadline) {
          this.logger.log('[netdisk] 正文深挖超出预算，按已有结果返回')
          break
        }
        const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()
        if (!TEXT_EXTS.has(ext)) continue
        if (cand.sizeBytes > MAX_TEXT_BYTES) continue
        try {
          const { text, sourceId } = await this.ensureText(cand)
          if (!text) continue
          // P2 / 报告 §4 P2：删掉 bigram `coverage < 0.2` 闸门。
          // 「是不是这道题」由 judge() 的六条硬闸决定；在粗筛阶段用 bigram 拦截，
          // 只会把「文件名没写、正文里确有原题」的文档在最后一步误杀。
          // score 仅作展示，不再参与主排序（主排序＝正文长锚点共现数）。
          const score = examplesOnly ? 0 : coverage(qSet, text)
          // P-009 / D-012：一题一对象 + 多因子闸门。整本教辅不再当成一个判定单元，
          // exact 必须同时带来源位置；未达标一律 topic（answer 为空，见报告 §8）。
          // snippet 只留给排障端点看，answer-search 不再拿它当答案（D-009 硬性约束）。
          // P-010 / D-013：先查入库时绑定的题目对象（带内容指纹 / 正文版本 / 定点排除）。
          // 🔴 source_id 口径：构建脚本按 netdisk_files.id（varchar36）入库，
          //    绝不能用 cand.fsId（百度网盘数字 fs_id）——两者对不上会让 rows 恒为空、
          //    整条网盘链路静默回退 P0，结构化数据等于白铺。M32 有静态断言。
          //    仅当本次正文刚抽、还没铺量（sourceId=''）时才回退 P0。
          // 🔴 P-011 公共 owner：结构化对象是运营者铺的公共数据，取数必须用
          //    publicLibraryOwner()；用登录 userId 会让 rows 恒空、静默回退 P0。
          const source = { sourceId: sourceId || String(cand.fsId), sourceName: cand.name }
          const rows = sourceId
            ? await loadQuestionObjects(getSupabaseClient(), publicLibraryOwner(), 'netdisk', sourceId)
            : []
          // 🔴 P-016 / D-019：examples 模式**绝不调用判定层**（不合格输入不送判定）。
          //    空判定对象只为复用下面的「同源例题收集 + deepDone 组装」代码，
          //    exact 恒 false ⇒ 不产出 solutionExcerpt / sourceLocation / matchLevel=exact。
          const j = examplesOnly
            ? ({
                exact: false, solution: '', anchorsHit: 0, factors: {},
                rejectReason: 'P-016 仅参考例题模式：未送原题判定',
              } as unknown as ReturnType<typeof judgeWithStore>)
            : judgeWithStore(question, text, rows,
              () => judgeObjects(question, text, source))
          // P-015 / D-018：顺带挑出「题目不完全一致、但思路可借鉴」的库内例题。
          // 🔴 只在本次已加载该来源结构化对象时做：不额外发查询、不扩大召回面、
          //    不改判定层；校验口径与 judgeWithStore 同源（storeValidationOpts）。
          // 🔴 exact 已放行的对象排除，避免同一道题既当答案又当参考。
          if (rows.length > 0) {
            referencePools.push(collectReferences(question, rows, {
              ...storeValidationOpts(text),
              ...(j.exact && j.sourceLocation
                ? { excludeObjectIndexes: [j.sourceLocation.objectIndex] }
                : {}),
            }))
          }
          const snippet = examplesOnly ? '' : this.snippetFor(question, text)
          deepDone.push({
            ...cand,
            hit: 'content',
            score: Number(score.toFixed(3)),
            snippet,
            matchLevel: j.exact ? 'exact' : 'topic',
            ...(j.exact ? { solutionExcerpt: j.solution } : {}),
            anchorsHit: j.anchorsHit,
            ...(j.exact && j.sourceLocation ? { sourceLocation: j.sourceLocation } : {}),
            matchFactors: {
              ...j.factors,
              ...('storeMeta' in j && j.storeMeta ? { store: j.storeMeta } : {}),
            } as unknown as Record<string, unknown>,
            ...(j.rejectReason ? { rejectReason: j.rejectReason } : {}),
          })
        } catch (e) {
          this.logger.warn(`[netdisk] 抽正文失败 ${cand.path}: ${e instanceof Error ? e.message : e}`)
        }
      }
    }

    // P-006：原题 exact 排最前；其次正文命中；同档按覆盖度。
    // 只有 exact 会进入 answer-search 的「答案」字段，其余一律按同主题资料呈现。
    const hits = [...deepDone, ...l1.filter((h) => !deepDone.some((d) => d.fsId === h.fsId))]
      .sort((a, b) => {
        const ea = a.matchLevel === 'exact' ? 1 : 0
        const eb = b.matchLevel === 'exact' ? 1 : 0
        if (ea !== eb) return eb - ea
        return a.hit === b.hit ? b.score - a.score : a.hit === 'content' ? -1 : 1
      })
      .slice(0, limit)
    const exactCount = hits.filter((h) => h.matchLevel === 'exact').length

    let note = ''
    if (hits.length === 0) {
      note = liveFallback
        ? `资料库里没有搜到与这道题相关的资料（按 ${keys.join(' / ')} 检索）`
        : `本库索引里没有匹配的资料（按 ${keys.join(' / ')} 检索）。若资料库里确实有，需先更新资料索引`
    } else if (!deep) {
      note = '按资料库索引检索（文件名 / 路径 + 资料正文，未读取正文深挖）'
    } else if (deepDone.length === 0) {
      note = '文件名或资料正文命中，未进一步匹配到原题（可能是扫描版 PDF，无文字层）'
    } else {
      note = `文件名 / 路径 + 资料正文双通道检索（深挖 ${deepDone.length} 份）`
    }
    if (textAnchors.length > 0 && textMatched > 0) note += `；资料正文召回命中 ${textMatched} 份`
    if (exactCount > 0) note += `；原题判定命中 ${exactCount} 份`
    else if (hits.length > 0) note += '；未定位到这道题的答案，仅找到同主题资料'
    if (liveFallback) note += '；⚠️ 索引尚未建立，本次直接读取资料库'

    // P-015 / D-018：跨来源去重取 top-N。声明文案随结果一起下发，
    // 保证 `/api/netdisk/search` 直连也不会出现「有内容、无声明」。
    const references = mergeReferences(referencePools)
    if (references.length > 0) {
      note += `；另有 ${references.length} 道解题思路相近的例题可供借鉴（不是本题答案，展示前须先声明）`
    }

    // P-016 / D-019：仅参考例题模式 —— 不输出任何命中、不暴露检索词、不给 exact，
    // note 明说「这段输入未做原题判定」。answer-search 只取 references 与事先声明，
    // 用户可见的「请单独录入小题」由 answer-search 的如实告知层补上。
    if (examplesOnly) {
      return {
        hits: [], keys: [], exactCount: 0, tookMs: Date.now() - started,
        note: references.length > 0
          ? '这段输入未做原题判定（整页 / 多小问 / 非题目文本）；以下是解题思路相近的例题，不是本题答案'
          : '这段输入未做原题判定（整页 / 多小问 / 非题目文本），也没有找到思路相近的例题',
        ...(references.length > 0 ? { references, referenceDisclaimer: REFERENCE_DISCLAIMER } : {}),
      }
    }

    return {
      hits, keys, note, exactCount, tookMs: Date.now() - started,
      ...(references.length > 0 ? { references, referenceDisclaimer: REFERENCE_DISCLAIMER } : {}),
    }
  }

  /**
   * 在**本库索引**里检索（唯一检索面）：**双通道** SQL 粗筛 + 内存精排。
   *
   * - 通道 A：`name.ilike` / `path.ilike`（0024 trgm 索引）。目录名也算——
   *   「/浮力专题/第3讲.docx」光看文件名看不出是浮力，靠路径才认得出来。
   * - 通道 B（P2）：`text_flat.ilike`，**只用 ≥4 字长锚点**（`extractDistinctive()`
   *   产出，与判定层同源）。题干词不在任何文件名里的原题靠这条通道进候选池。
   *
   * 🔴 两条通道都 `.eq('user_id', publicLibraryOwner())`：公共资料不按登录用户隔离，
   *    同时 `check-isolation` 门禁仍看得见过滤条件，**无需任何豁免**。
   * 🔴 PostgREST 的 or 表达式里 `%,()` 是语法字符，两条通道都要剔干净。
   * 🔴 排序口径：正文长锚点共现数 → 文件名命中词数 → bigram 覆盖度 → 名字长度。
   *    `MAX_DEEP_FILES` 仍为 3（P3 锁），正文命中不前置的话多召回的文档轮不到判定。
   *
   * @returns hits 候选；total 公共索引里的文件总数（0 = 索引还没建）；
   *          textMatched 正文通道召回的份数（写进 note，排障可见）
   */
  private async searchLocal(
    keys: string[],
    textAnchors: string[],
  ): Promise<{
    hits: (NetdiskHit & { keyHits: number })[]
    total: number
    textMatched: number
  }> {
    // PostgREST 的 or 表达式里逗号/括号/百分号是语法字符，必须剔干净
    const clean = keys.map((k) => k.replace(/[%,()]/g, '')).filter((k) => k.length >= 2)
    if (clean.length === 0) return { hits: [], total: 0, textMatched: 0 }
    const client = getSupabaseClient()
    const ownerId = publicLibraryOwner()

    // ---------- 通道 A：文件名 / 路径 ----------
    const ors = clean.flatMap((k) => [`name.ilike.%${k}%`, `path.ilike.%${k}%`]).join(',')
    const pageRes = await client
      .from(TABLE)
      .select('fs_id, name, path, size_bytes')
      .eq('user_id', ownerId)
      .eq('is_dir', false)
      .or(ors)
      // P2 补齐：定序消除 PostgREST 无 order 时的随机返回顺序（任意截断的根因）
      .order('fs_id', { ascending: true })
      .limit(LOCAL_CANDIDATE_LIMIT)
    if (pageRes.error) {
      this.logger.warn(`[netdisk] 本地索引读取失败: ${pageRes.error.message}`)
      return { hits: [], total: 0, textMatched: 0 }
    }
    const rows = (pageRes.data || []) as { fs_id: number; name: string; path: string; size_bytes: number }[]
    // 🔴 扫描上限只是保护，不是排序依据；到达上限必须留痕，不能静默吞掉可能的高共现候选
    if (rows.length >= LOCAL_CANDIDATE_LIMIT) {
      this.logger.warn(`[netdisk] 文件名通道命中达到扫描上限 ${LOCAL_CANDIDATE_LIMIT}，可能漏候选`)
    }

    // ---------- 通道 B：资料正文（P2，只用 ≥4 字长锚点） ----------
    const textClean = [...new Set(
      textAnchors.map((k) => k.replace(/[%,()]/g, '')).filter((k) => k.length >= 4),
    )].slice(0, TEXT_RECALL_KEYS)
    const textHitsByFs = new Map<number, number>()
    const textRows: typeof rows = []
    if (textClean.length > 0) {
      const textOrs = textClean.map((k) => `text_flat.ilike.%${k}%`).join(',')
      const textRes = await client
        .from(TABLE)
        .select('fs_id, name, path, size_bytes, text_flat')
        .eq('user_id', ownerId)
        .eq('is_dir', false)
        .eq('text_status', 'ok')
        .or(textOrs)
        .order('fs_id', { ascending: true })
        .limit(TEXT_CANDIDATE_LIMIT)
      if (textRes.error) {
        // 🔴 正文通道失败（含 0027 未迁移 / 列不存在）不能拖垮整次检索：
        //    留痕后退回纯文件名通道，绝不静默吞错（M18 精神）。
        this.logger.warn(`[netdisk] 资料正文召回读取失败，退回文件名通道: ${textRes.error.message}`)
      } else {
        const textData = (textRes.data || []) as (typeof rows[number] & { text_flat: string | null })[]
        if (textData.length >= TEXT_CANDIDATE_LIMIT) {
          this.logger.warn(`[netdisk] 正文通道命中达到扫描上限 ${TEXT_CANDIDATE_LIMIT}，可能漏候选`)
        }
        for (const r of textData) {
          // SQL 侧 ilike 已过滤一遍；这里用同一套归一化复算共现数，
          // 避免 PostgREST 的 ilike 与 JS 的 String.includes 口径漂移。
          const flat = flatText(r.text_flat || '')
          const n = textClean.filter((k) => flat.includes(k)).length
          if (n === 0) continue
          textHitsByFs.set(Number(r.fs_id), n)
          textRows.push({ fs_id: r.fs_id, name: r.name, path: r.path, size_bytes: r.size_bytes })
        }
      }
    }

    // ⚠️ 只在「两条通道一条都没命中」时才数总数：这一次 count 只为区分
    //    「索引是空的（得走实时兜底）」与「索引有货但没匹配上（直接返回空）」。
    let total = -1
    if (rows.length === 0 && textRows.length === 0) {
      const countRes = await client
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ownerId)
        .eq('is_dir', false)
      total = countRes.count ?? 0
    }

    // 合并去重：正文命中的行即使文件名一个词都没命中，也必须进候选池
    // ——这正是 P2 存在的全部意义（报告 §3.1 `AB=6` 文件名 0 / 正文 196）。
    const merged = new Map<number, typeof rows[number]>()
    for (const r of rows) merged.set(Number(r.fs_id), r)
    for (const r of textRows) if (!merged.has(Number(r.fs_id))) merged.set(Number(r.fs_id), r)

    // P2 补齐（D-015）：**统一打分口径**。
    // 主排序键只有一个 —— 归一化长锚点共现数（正文 ×2，因为它与判定层同源）；
    // `score` 是同一个分数的归一化比率，只作展示。bigram `coverage` 彻底退出
    // 主排序（仅在实时兜底与深挖排障里保留），消除「召回按一套、判定按另一套」。
    // 🔴 top-N 发生在**两通道合并之后、排序之后**，SQL 的 limit 只是扫描上限。
    const hits = [...merged.entries()]
      .map(([fsId, r]) => {
        const name = r.name || ''
        const path = r.path || ''
        const nameHits = clean.filter((k) => name.includes(k) || path.includes(k)).length
        const tHits = textHitsByFs.get(fsId) || 0
        const keyHits = nameHits + tHits * 2
        const denominator = Math.max(1, clean.length + textClean.length * 2)
        return {
          fsId,
          name,
          path,
          sizeBytes: Number(r.size_bytes) || 0,
          hit: 'name' as const,
          score: Number((keyHits / denominator).toFixed(3)),
          keyHits,
          textHits: tHits,
        }
      })
      .sort((a, b) =>
        b.keyHits - a.keyHits ||
        (b.textHits || 0) - (a.textHits || 0) ||
        a.fsId - b.fsId,
      )
      .slice(0, CANDIDATE_TOP_N)
    return { hits, total, textMatched: textHitsByFs.size }
  }

  /**
   * 把候选元数据沉淀进本地索引。
   * ⚠️ 只写元数据字段：**不带 text_content / text_status**，
   *    否则会把已抽好的正文覆盖成空（PostgREST upsert 只更新 payload 里出现的列）。
   */
  private async upsertMeta(hits: NetdiskHit[]): Promise<void> {
    if (hits.length === 0) return
    try {
      const client = getSupabaseClient()
      const ownerId = publicLibraryOwner()
      const rows = hits.slice(0, 50).map((h) => ({
        user_id: ownerId,
        fs_id: h.fsId,
        path: h.path,
        dir_path: h.path.slice(0, h.path.lastIndexOf('/')) || '/',
        name: h.name,
        ext: (h.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase(),
        is_dir: false,
        size_bytes: h.sizeBytes,
        synced_at: new Date().toISOString(),
      }))
      const { error } = await client.from(TABLE).upsert(rows, { onConflict: 'user_id,fs_id' })
      if (error) this.logger.warn(`[netdisk] 候选沉淀失败: ${error.message}`)
    } catch (e) {
      this.logger.warn(`[netdisk] 候选沉淀异常: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** 截取题干首次出现位置的上下文，供结果展示 */
  private snippetFor(question: string, text: string): string {
    const q = (question || '').replace(/\s+/g, '')
    // 用最长的 6 字片段定位（整句大概率对不上）
    let anchor = ''
    for (let i = 0; i + 6 <= q.length; i += 2) {
      const seg = q.slice(i, i + 6)
      if (text.includes(seg)) { anchor = seg; break }
    }
    const flat = text.replace(/\s+/g, ' ')
    const at = anchor ? flat.indexOf(anchor) : -1
    if (at < 0) return flat.slice(0, 120)
    return `…${flat.slice(Math.max(0, at - 60), at + 120)}…`
  }

  /**
   * 取（必要时抽）某份文件的正文。
   * 命中缓存直接返回；扫描版记 text_status=none，避免每次检索都白下载。
   */
  private async ensureText(
    cand: NetdiskHit,
  ): Promise<{ text: string; sourceId: string }> {
    const client = getSupabaseClient()
    const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()

    // ① 缓存：已抽过就直接用。🔴 必须把 netdisk_files.id 一起带出去：
    //    question_objects.source_id 用的是这一列，不是 cand.fsId（见上方深挖块注释）。
    const { data: cached } = await client
      .from(TABLE)
      .select('id, text_content, text_status')
      .eq('user_id', publicLibraryOwner())
      .eq('fs_id', cand.fsId)
      .maybeSingle()
    const row = cached as CacheRow | null
    if (row?.text_status === 'ok' && row.text_content) {
      return { text: row.text_content, sourceId: String(row.id || '') }
    }
    if (row?.text_status === 'none' || row?.text_status === 'skipped') {
      return { text: '', sourceId: '' }
    }

    // P3 / D-015：默认**禁止在线下载/抽取**，只消费离线铺量的正文。
    // 命中本分支说明这份资料还没被 question-objects-build / 抽取脚本铺量：
    // 以前会实时 downloadByFsId + OCR（首次检索数秒且顺手写缓存），现在直接跳过，
    // 由离线补齐；`NETDISK_ONLINE_EXTRACT=1` 才恢复原行为（应急/灾备回退）。
    // 🔴 这一段必须放在下载之前，放在后面等于没关。
    if (!ONLINE_EXTRACT_ENABLED) {
      return { text: '', sourceId: '' }
    }

    // ② 纯文本直接下（不必进 python）。刚抽的正文还没铺量 ⇒ sourceId 留空，
    //    判定层回退 P0，等下次 question-objects-build.mjs --apply 后自然接上。
    const buf = await this.netdisk.downloadByFsId(cand.fsId)
    if (!buf || buf.length === 0) {
      await this.saveCache(cand, '', 'none')
      return { text: '', sourceId: '' }
    }

    let text = ''
    let status = 'ok'
    if (ext === 'txt' || ext === 'md') {
      text = buf.toString('utf8')
    } else if (ext === 'pdf' || ext === 'docx') {
      const out = await extractDocContent({
        kind: ext === 'pdf' ? 'pdf' : 'docx',
        content: buf,
        textOnly: true,
        // 整本书也不必全抽：前 200 页足够覆盖题目所在章节，且能兜住极端大文件
        maxPages: 200,
        timeoutMs: 60_000,
      })
      if (!out.ok || !out.data) {
        // ⚠️ 环境类失败（没装 python / 脚本缺失 / 超时）**不写缓存**：
        //    写成 none 等于永久判死，环境修好后也再不会重试。保持未抽状态即可。
        if (out.reason === 'no-python' || out.reason === 'no-script' || out.reason === 'timeout') {
          this.logger.warn(`[netdisk] 抽正文环境不可用（${out.reason}）：${cand.name}，本次跳过且不缓存`)
          return { text: '', sourceId: '' }
        }
        // 内容类失败（解析不了）才按「无正文」缓存，避免每次检索都白下载一遍
        await this.saveCache(cand, '', 'none')
        return { text: '', sourceId: '' }
      }
      text = out.data.pages.map((p) => p.text).filter(Boolean).join('\n')
      // 全篇几乎没字 = 扫描版：标 none，下次不再下载
      if (text.replace(/\s+/g, '').length < 50) status = 'none'
    } else {
      status = 'skipped'
    }

    await this.saveCache(cand, text.slice(0, MAX_TEXT_CHARS), status)
    return {
      text: status === 'ok' ? text.slice(0, MAX_TEXT_CHARS) : '',
      sourceId: '',
    }
  }

  private async saveCache(
    cand: NetdiskHit,
    text: string,
    status: string,
  ): Promise<void> {
    const client = getSupabaseClient()
    const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()
    const { error } = await client.from(TABLE).upsert(
      {
        // P-011：公共索引统一挂固定 owner，绝不写登录用户 ID
        user_id: publicLibraryOwner(),
        fs_id: cand.fsId,
        path: cand.path,
        dir_path: cand.path.slice(0, cand.path.lastIndexOf('/')) || '/',
        name: cand.name,
        ext,
        is_dir: false,
        size_bytes: cand.sizeBytes,
        text_content: text || null,
        // P2：运行时现抽的正文也要能进正文召回通道，
        // 归一化口径与 question-match.ts 的 normalizeForMatch() 逐字一致。
        text_flat: text ? flatText(text) : null,
        text_status: status,
        text_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,fs_id' },
    )
    // 缓存写失败不影响本次检索结果，但不能静默
    if (error) this.logger.warn(`[netdisk] 正文缓存写入失败: ${error.message}`)
  }

  /** 公共索引里已缓存正文的文件数（前端「资料检索」旁展示索引状态用） */
  async stats(): Promise<{ cached: number; scanned: number }> {
    const client = getSupabaseClient()
    const ownerId = publicLibraryOwner()
    const [ok, none] = await Promise.all([
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', ownerId).eq('text_status', 'ok'),
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', ownerId).eq('text_status', 'none'),
    ])
    return { cached: ok.count ?? 0, scanned: none.count ?? 0 }
  }
}
