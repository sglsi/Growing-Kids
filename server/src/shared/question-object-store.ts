/**
 * P-010 / D-013 · P1：结构化题目对象的取数与统一判定入口。
 *
 * 为什么单独一层：网盘深挖与自有资料库正文是**两条完全不同的检索链路**，
 * 但「有没有结构化对象 → 校验指纹/版本 → 决定放行还是回退」必须逐字一致，
 * 否则又会出现「一条链路有豁免」的老问题（D-009 踩过）。
 *
 * 🔴 无 RLS：所有查询必须 `.eq('user_id', userId)`，本文件是唯一取数口。
 * 🔴 判定口径与 P0 共用：`judgeStoredObjects()` 内部仍调 `judgeQuestionObject()`
 *    与 `selectUnique()`，只额外叠加「入库对象可复算校验」。它只会减少放行。
 *
 * ⚠️ 铺量期开关：`QUESTION_OBJECTS_STRICT=1` 时，某来源没有结构化对象就**不给 exact**；
 *    默认 0，回退 P0 的全文判定，保证功能不倒退。结构化数据铺满并验收全绿后才开。
 *    开关为 0 期间，P1 不改善「解析段归属」的残余风险，文档不得写成已消除。
 */
import { createHash } from 'crypto'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { judgeStoredObjects, sourceRevisionInput } from './question-match'
import type { ObjectJudgement, StoredQuestionObject } from './question-match'

type Client = ReturnType<typeof getSupabaseClient>

/** 列名与 0026 迁移逐字对应；漏一列会让指纹/版本校验静默失效 */
export const QUESTION_OBJECT_COLUMNS = [
  'source_id', 'source_name', 'object_index', 'label',
  'char_start', 'char_end', 'stem_start', 'stem_end',
  'stem_text', 'solution_text', 'has_solution',
  'object_fingerprint', 'source_revision', 'link_status', 'engine_version',
].join(', ')

export function questionObjectsStrict(): boolean {
  return process.env.QUESTION_OBJECTS_STRICT === '1'
}

/**
 * 读某份来源的全部结构化对象。
 * 表不存在 / 未铺量 / 查询失败 ⇒ 返回空数组并留痕，由调用方决定回退；
 * **绝不静默吞错**（M18 精神：fail 要有日志）。
 */
export async function loadQuestionObjects(
  client: Client,
  userId: string,
  sourceType: 'netdisk' | 'library',
  sourceId: string,
): Promise<StoredQuestionObject[]> {
  const { data, error } = await client
    .from('question_objects')
    .select(QUESTION_OBJECT_COLUMNS)
    .eq('user_id', userId)
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .order('object_index', { ascending: true })
  if (error) {
    console.warn(`[question-objects] 读取失败 ${sourceType}/${sourceId}: ${error.message}`)
    return []
  }
  return (data || []) as unknown as StoredQuestionObject[]
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * P-015 / D-018：结构化对象的校验口径唯一真相源。
 * 参考例题收集（`collectReferences()`）与原题判定（`judgeWithStore()`）必须共用，
 * 否则两边「对象是否可信」会漂移，出现「判定拒绝但参考层放行」的裂缝。
 * 🔴 与构建脚本 `question-objects-build.mjs` 逐字一致：先剥 NUL 再算版本，
 *    否则 PostgreSQL text 里的 U+0000 会让两边 hash 不同 ⇒ 对象全部被判过期。
 */
export function storeValidationOpts(text: string): {
  hash: (s: string) => string
  expectedRevision: string
} {
  return {
    hash: sha256,
    expectedRevision: sha256(sourceRevisionInput(text).replace(/\u0000/g, '')),
  }
}

/**
 * 统一判定入口。
 * @param fallback P0 全文判定（由调用方以 `() => judgeObjects(question, text, source)` 传入），
 *                 只在「没有可用结构化对象且非 strict」时调用，保证同一时刻只跑一条链路。
 */
export function judgeWithStore(
  question: string,
  text: string,
  rows: StoredQuestionObject[],
  fallback: () => ObjectJudgement,
): ObjectJudgement & { storeMeta?: { total: number; usable: number; rejected: string[] } } {
  const j = judgeStoredObjects(question, rows, {
    ...storeValidationOpts(text),
    strict: questionObjectsStrict(),
  })
  if (!j.structured) return fallback()
  return { ...j, storeMeta: j.store }
}
