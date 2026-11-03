import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { BaiduNetdiskService } from '../storage/baidu-netdisk.service'
import { extractDocContent } from '../ocr/pdf-tool'

/**
 * 百度网盘资料检索（「资料库搜题」的第一顺位来源）。
 *
 * ## 为什么是「两级检索」而不是「全量建索引」
 * 思傅 2026-11-03 实测 /学生 目录：采样 120 次列举就见 1318 个文件 / 252GB，
 * 其中 PDF 623 个且大量是扫描版。按 OCR 26s/页算，全量正文索引既跑不完也存不下。
 * 所以：
 *   L1 网盘原生 `method=search`（**只匹配文件名与路径**）→ 秒级圈出候选；
 *   L2 只对排名靠前的少数候选下载 + 抽文字层 → 做正文匹配。
 * 抽过的正文落 `netdisk_files.text_content` 缓存，同一本不重复下载。
 *
 * ## 已知边界（别对用户承诺过头）
 * - 扫描版 PDF（无文字层）抽不到正文 ⇒ 只能靠文件名命中；
 * - 正文匹配只在 L1 候选里做，题干关键词完全不出现在任何文件名里时会漏；
 * - 网盘 search 是「包含」匹配，key 太长必然 0 命中 ⇒ 先提学科词，再退回滑窗。
 */

const TABLE = 'netdisk_files'

/** 检索范围：优先用环境变量覆盖（不同家庭资料目录不一样） */
export function searchRoot(): string {
  return (process.env.NETDISK_SEARCH_ROOT || '/学生').trim().replace(/\/+$/, '') || '/学生'
}

/** 单次检索允许深挖正文的候选数（每本都要下载 + 抽文本，别贪多） */
const MAX_DEEP_FILES = Number(process.env.NETDISK_DEEP_FILES ?? 3)
/** 整次检索的正文深挖预算（毫秒）：超时就用已有的文件名结果返回 */
const DEEP_BUDGET_MS = Number(process.env.NETDISK_DEEP_BUDGET_MS ?? 18_000)
/** 可抽正文的扩展名（老 .doc 二进制 pdf_tool 解不了，只能按文件名命中） */
const TEXT_EXTS = new Set(['pdf', 'docx', 'txt', 'md'])
/** 单文件抽取上限：超大文件不值得为一次检索拉下来 */
const MAX_TEXT_BYTES = Number(process.env.NETDISK_TEXT_MAX_BYTES ?? 40 * 1024 * 1024)
/** 落库正文截断长度（够做关键词匹配即可，不当正文库用） */
const MAX_TEXT_CHARS = Number(process.env.NETDISK_TEXT_MAX_CHARS ?? 200_000)
/** 单次检索最多并发几个 search key */
const MAX_KEYS = 6
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
 * 初中常见知识点词表——只用来「从题干里挑搜网盘的 key」。
 * ⚠️ 不是学科本体，不需要全，覆盖高频即可；命中不了会退回滑窗，不影响正确性。
 */
const TOPIC_WORDS = [
  // 物理
  '浮力', '压强', '密度', '重力', '摩擦力', '杠杆', '滑轮', '机械效率', '机械能', '动能', '势能',
  '电流', '电压', '电阻', '欧姆定律', '电功率', '电功', '焦耳定律', '串联', '并联', '磁场', '电磁感应',
  '光的反射', '光的折射', '凸透镜', '成像', '物态变化', '熔化', '凝固', '汽化', '液化', '升华',
  '比热容', '内能', '热量', '声音', '音调', '响度', '速度', '路程', '参照物', '惯性', '二力平衡',
  // 数学
  '函数', '一次函数', '二次函数', '反比例函数', '方程', '方程组', '不等式', '因式分解', '分式',
  '三角形', '全等', '相似', '四边形', '平行四边形', '矩形', '菱形', '梯形', '圆', '扇形', '切线',
  '勾股定理', '锐角三角函数', '正弦', '余弦', '正切', '概率', '统计', '平均数', '中位数', '方差',
  '数列', '集合', '导数', '圆锥', '圆柱', '体积', '表面积',
  // 化学
  '化学式', '化学方程式', '配平', '相对分子质量', '溶液', '溶质', '溶剂', '溶解度', '酸碱盐',
  '氧化还原', '化合反应', '分解反应', '置换反应', '复分解反应', '金属活动性', 'pH',
  // 生物 / 语文 / 英语（搜题也会遇到）
  '细胞', '光合作用', '呼吸作用', '遗传', '生态系统', '文言文', '古诗', '阅读理解', '完形填空',
]

/** 题干里这些开头的片段做 search key 基本是噪声 */
const NOISE_PREFIX = [
  '如图', '下列', '关于', '我们', '一个', '如果', '已知', '根据', '下列说', '请', '求', '计算',
  '　', '的是', '的是', '正确', '错误', '说法', '选项',
]

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
 * 从题干里挑出用于网盘搜索的 key。
 * 顺序：学科词优先（命中率最高）→ 4 字滑窗兜底。最多 MAX_KEYS 个且去重。
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
    for (let i = 0; i + 4 <= block.length; i += 2) {
      const seg = block.slice(i, i + 4)
      if (isNoise(seg)) continue
      push(seg)
      if (out.length >= MAX_KEYS) break
    }
  }
  return out.slice(0, MAX_KEYS)
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
  /** 正文命中时的上下文片段 */
  snippet?: string
}

export interface NetdiskSearchResult {
  hits: NetdiskHit[]
  /** 本次用到的搜索词（排障用，也便于前端说明「按什么搜的」） */
  keys: string[]
  /** 人类可读的说明（未配置/无命中/扫描版抽不到正文等） */
  note: string
  tookMs: number
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
   * 搜网盘。
   *
   * @param question 题干（原样传，内部自己提 key）
   * @param opts.deep 是否允许深挖正文（默认 true；纯文件名检索更快）
   */
  async search(
    userId: string,
    question: string,
    opts: { deep?: boolean; limit?: number } = {},
  ): Promise<NetdiskSearchResult> {
    const started = Date.now()
    const limit = Math.min(20, opts.limit ?? 8)
    const deep = opts.deep !== false

    if (!this.available()) {
      return {
        hits: [], keys: [], tookMs: 0,
        note: `网盘未配置（缺 ${this.missingKeys().join(' / ')}）：请在服务器 .env.secrets 填入 BAIDU_APP_KEY / BAIDU_SECRET_KEY / BAIDU_REFRESH_TOKEN 后重启后端`,
      }
    }

    const keys = extractKeys(question)
    if (keys.length === 0) {
      return { hits: [], keys, note: '题干太短，提不出可用的检索词', tookMs: Date.now() - started }
    }

    // ---------- L1：网盘原生搜索（只匹配文件名/路径） ----------
    const root = searchRoot()
    const qSet = bigrams(question)
    const pool = new Map<number, NetdiskHit>()
    /** 每个候选被几个不同搜索词命中——这是比 bigram 覆盖度更强的信号 */
    const keyCount = new Map<number, number>()

    // ---------- L0：本地已沉淀的候选（先于实时搜索）----------
    // 网盘 search 每次返回的子集不稳定，同一题两次排序会变。把命中过的候选落库，
    // 下次先读本地，既稳住排序，也让「网盘临时抽风」时仍有结果可用。
    for (const h of await this.searchLocal(userId, keys, qSet)) {
      if (pool.has(h.fsId)) continue
      pool.set(h.fsId, h)
      keyCount.set(h.fsId, 1)
    }

    for (const key of keys) {
      let items: Record<string, unknown>[] = []
      try {
        items = await this.netdisk.search(key, root, KEY_LIMIT)
      } catch (e) {
        this.logger.warn(`[netdisk] search "${key}" 失败: ${e instanceof Error ? e.message : e}`)
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

    // 排序优先级：命中关键词数（多 ⇒ 更像「就是这一章」）→ 覆盖度 → 名字长度
    const ranked = [...pool.values()].sort(
      (a, b) =>
        (keyCount.get(b.fsId) || 0) - (keyCount.get(a.fsId) || 0) ||
        b.score - a.score ||
        b.name.length - a.name.length,
    )
    const l1 = ranked.slice(0, Math.max(limit, L1_POOL))

    // 沉淀本次候选：下次同一题先用本地，排序不再随网盘抖动（失败不影响本次结果）
    void this.upsertMeta(userId, l1)

    // ---------- L2：对头部候选抽正文，补「文件名没写但正文里有」的情况 ----------
    const deepDone: NetdiskHit[] = []
    if (deep && l1.length > 0) {
      const deadline = started + DEEP_BUDGET_MS
      for (const cand of l1.slice(0, MAX_DEEP_FILES)) {
        if (Date.now() > deadline) {
          this.logger.log('[netdisk] 正文深挖超出预算，按已有结果返回')
          break
        }
        const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()
        if (!TEXT_EXTS.has(ext)) continue
        if (cand.sizeBytes > MAX_TEXT_BYTES) continue
        try {
          const text = await this.ensureText(userId, cand)
          if (!text) continue
          const score = coverage(qSet, text)
          if (score < 0.2) continue
          const snippet = this.snippetFor(question, text)
          deepDone.push({ ...cand, hit: 'content', score: Number(score.toFixed(3)), snippet })
        } catch (e) {
          this.logger.warn(`[netdisk] 抽正文失败 ${cand.path}: ${e instanceof Error ? e.message : e}`)
        }
      }
    }

    // 正文命中优先展示（它比文件名命中更贴近「这道题」），同分按覆盖度
    const hits = [...deepDone, ...l1.filter((h) => !deepDone.some((d) => d.fsId === h.fsId))]
      .sort((a, b) => (a.hit === b.hit ? b.score - a.score : a.hit === 'content' ? -1 : 1))
      .slice(0, limit)

    let note = ''
    if (hits.length === 0) {
      note = `网盘里没有搜到与这道题相关的资料（按 ${keys.join(' / ')} 检索）`
    } else if (!deep) {
      note = '按文件名匹配（未深入正文）'
    } else if (deepDone.length === 0) {
      note = '文件名命中，正文未进一步匹配（可能是扫描版 PDF，无文字层）'
    } else {
      note = `文件名 + 正文匹配（正文命中 ${deepDone.length} 份）`
    }

    return { hits, keys, note, tookMs: Date.now() - started }
  }

  /**
   * 本地已沉淀的候选（按关键词模糊匹配文件名）。
   * 目的只有一个：稳住排序。网盘 search 每次给的子集不同，靠「用过就记住」收敛。
   */
  private async searchLocal(
    userId: string,
    keys: string[],
    qSet: Set<string>,
  ): Promise<NetdiskHit[]> {
    // PostgREST 的 or 表达式里逗号/括号/百分号是语法字符，必须剔干净
    const clean = keys.map((k) => k.replace(/[%,()]/g, '')).filter((k) => k.length >= 2)
    if (clean.length === 0) return []
    const client = getSupabaseClient()
    const ors = clean.map((k) => `name.ilike.%${k}%`).join(',')
    const { data, error } = await client
      .from(TABLE)
      .select('fs_id, name, path, size_bytes')
      .eq('user_id', userId)
      .eq('is_dir', false)
      .or(ors)
      .limit(200)
    if (error) {
      this.logger.warn(`[netdisk] 本地候选读取失败: ${error.message}`)
      return []
    }
    return ((data || []) as { fs_id: number; name: string; path: string; size_bytes: number }[]).map(
      (r) => ({
        fsId: Number(r.fs_id),
        name: r.name,
        path: r.path,
        sizeBytes: Number(r.size_bytes) || 0,
        hit: 'name' as const,
        score: Number(Math.max(coverage(qSet, r.name), coverage(qSet, r.path) * 0.6).toFixed(3)),
      }),
    )
  }

  /**
   * 把候选元数据沉淀进本地索引。
   * ⚠️ 只写元数据字段：**不带 text_content / text_status**，
   *    否则会把已抽好的正文覆盖成空（PostgREST upsert 只更新 payload 里出现的列）。
   */
  private async upsertMeta(userId: string, hits: NetdiskHit[]): Promise<void> {
    if (hits.length === 0) return
    try {
      const client = getSupabaseClient()
      const rows = hits.slice(0, 50).map((h) => ({
        user_id: userId,
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
  private async ensureText(userId: string, cand: NetdiskHit): Promise<string> {
    const client = getSupabaseClient()
    const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()

    // ① 缓存：已抽过就直接用
    const { data: cached } = await client
      .from(TABLE)
      .select('id, text_content, text_status')
      .eq('user_id', userId)
      .eq('fs_id', cand.fsId)
      .maybeSingle()
    const row = cached as CacheRow | null
    if (row?.text_status === 'ok' && row.text_content) return row.text_content
    if (row?.text_status === 'none' || row?.text_status === 'skipped') return ''

    // ② 纯文本直接下（不必进 python）
    const buf = await this.netdisk.downloadByFsId(cand.fsId)
    if (!buf || buf.length === 0) {
      await this.saveCache(userId, cand, '', 'none')
      return ''
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
        // 抽取失败按「无正文」缓存，但状态记 none 以便将来人工重试
        await this.saveCache(userId, cand, '', 'none')
        return ''
      }
      text = out.data.pages.map((p) => p.text).filter(Boolean).join('\n')
      // 全篇几乎没字 = 扫描版：标 none，下次不再下载
      if (text.replace(/\s+/g, '').length < 50) status = 'none'
    } else {
      status = 'skipped'
    }

    await this.saveCache(userId, cand, text.slice(0, MAX_TEXT_CHARS), status)
    return status === 'ok' ? text.slice(0, MAX_TEXT_CHARS) : ''
  }

  private async saveCache(
    userId: string,
    cand: NetdiskHit,
    text: string,
    status: string,
  ): Promise<void> {
    const client = getSupabaseClient()
    const ext = (cand.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase()
    const { error } = await client.from(TABLE).upsert(
      {
        user_id: userId,
        fs_id: cand.fsId,
        path: cand.path,
        dir_path: cand.path.slice(0, cand.path.lastIndexOf('/')) || '/',
        name: cand.name,
        ext,
        is_dir: false,
        size_bytes: cand.sizeBytes,
        text_content: text || null,
        text_status: status,
        text_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,fs_id' },
    )
    // 缓存写失败不影响本次检索结果，但不能静默
    if (error) this.logger.warn(`[netdisk] 正文缓存写入失败: ${error.message}`)
  }

  /** 已缓存正文的文件数（前端「资料库检索」旁展示索引状态用） */
  async stats(userId: string): Promise<{ cached: number; scanned: number }> {
    const client = getSupabaseClient()
    const [ok, none] = await Promise.all([
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('text_status', 'ok'),
      client.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('text_status', 'none'),
    ])
    return { cached: ok.count ?? 0, scanned: none.count ?? 0 }
  }
}
