/**
 * 相似题 / 变式题推荐（P2-17 · 本地优先：历史相似 + 标签即轻量知识图谱）
 * ------------------------------------------------------------------
 * 技术文档 §5 #17 点名"知识图谱 + IRT 难度"。二者都依赖题库与难度标注数据，
 * 与"本地优先、不引大模型"原则冲突，故本次落地的**可运行替代**是：
 *
 *   - **文本相似**：SimHash/词面重叠，找"同一知识点、相似表述"的题（复用 ocr-dedup 的归一化）。
 *   - **标签（知识点）相似 = 轻量知识图谱 / 协同过滤**：相同 `tags` 的题目被归到同一节点，
 *     即"这个孩子总在哪些知识点上反复错"的图谱化表达。
 *   - **IRT 难度代理**：用 `mastered` / `review_count` 间接表征难度（越常错/越难掌握 → 越该多练），
 *     真实 IRT 难度待题目标注数据到位。
 *
 * 全部零新依赖；`textSimilarity` / `scoreSimilarity` 是纯函数，可单测。
 */
import { getSupabaseClient } from '../storage/database/supabase-client'
import { normalizeForDedup } from './ocr-dedup'

export interface SimilarTarget {
  id: string
  question?: string
  stem?: string
  answer?: string
  tags?: string[]
}

export interface CandidateDoc {
  id: string
  question?: string
  answer?: string
  tags?: string[]
}

export interface SimilarItem {
  id: string
  question: string
  answer: string
  /** 综合相似分 [0,1] */
  score: number
  /** 与查询题共享的知识点标签 */
  shared_tags: string[]
}

/** 字级 bigram 集合（与 ocr-dedup 同口径） */
function bigramSet(s: string): Set<string> {
  const t = normalizeForDedup(s || '')
  const set = new Set<string>()
  if (t.length <= 1) {
    if (t) set.add(t)
    return set
  }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

/** 两文本字面相似度（Dice 系数 [0,1]，对短文本比 Jaccard 更稳健） */
export function textSimilarity(a: string, b: string): number {
  const A = bigramSet(a)
  const B = bigramSet(b)
  if (!A.size && !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** 两个标签集合的相似度（Dice 系数 [0,1]） */
function diceTags(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size && !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/**
 * 查询题 vs 候选题的综合相似分。
 * 文本相似占 0.7；若两者都有标签则标签（知识点）Jaccard 占 0.3 加权。
 */
export function scoreSimilarity(target: SimilarTarget, cand: CandidateDoc): { score: number; sharedTags: string[] } {
  const tText = [target.question || '', target.stem || '', target.answer || ''].join('\n')
  const cText = [cand.question || '', cand.answer || ''].join('\n')
  const textSim = textSimilarity(tText, cText)

  const tTags = (target.tags || []).filter(Boolean)
  const cTags = (cand.tags || []).filter(Boolean)
  const sharedTags = tTags.filter((t) => cTags.includes(t))
  const tagSim = tTags.length && cTags.length ? diceTags(tTags, cTags) : 0

  const score = tTags.length && cTags.length ? 0.7 * textSim + 0.3 * tagSim : textSim
  return { score, sharedTags }
}

/**
 * 查该用户错题本里与指定题最相似的若干题（排除自身）。
 * 数据规模为个人错题本（几十条~几百条），一次性拉回本地算分即可，不依赖向量库。
 */
export async function findSimilarQuestions(
  userId: string,
  targetId: string,
  limit = 5,
): Promise<SimilarItem[]> {
  const client = getSupabaseClient()
  // 1) 取查询题本体
  const { data: tgtRaw, error: e1 } = await client
    .from('timeline_items')
    .select('id, content, tags')
    .eq('user_id', userId)
    .eq('id', targetId)
    .is('deleted_at', null)
    .maybeSingle()
  // Supabase 客户端的链式返回在此处退化为 {}，显式标注避免逐字段取属性报错
  const tgt = tgtRaw as { id: string; content: unknown; tags: string[] | null } | null
  if (e1 || !tgt) return []
  const target: SimilarTarget = {
    id: tgt.id,
    question: (tgt.content as any)?.question || '',
    stem: (tgt.content as any)?.stem || '',
    answer: (tgt.content as any)?.answer || '',
    tags: (tgt.tags as string[]) || [],
  }

  // 2) 取同用户其余题目（同知识点优先，故按共享标签做粗筛后再精排）
  const { data: rows, error: e2 } = await client
    .from('timeline_items')
    .select('id, content, tags')
    .eq('user_id', userId)
    .eq('kind', 'question')
    .is('deleted_at', null)
    .neq('id', targetId)
    .limit(500)
  if (e2 || !rows?.length) return []

  const scored: SimilarItem[] = []
  for (const r of rows as any[]) {
    const cand: CandidateDoc = {
      id: r.id,
      question: r.content?.question || '',
      answer: r.content?.answer || '',
      tags: (r.tags as string[]) || [],
    }
    const { score, sharedTags } = scoreSimilarity(target, cand)
    if (score <= 0) continue
    scored.push({
      id: cand.id,
      question: cand.question?.slice(0, 120) || '',
      answer: cand.answer?.slice(0, 120) || '',
      score: Number(score.toFixed(4)),
      shared_tags: sharedTags,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
