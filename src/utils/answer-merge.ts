/**
 * 「正确答案 + 解题过程」合并编辑（思傅 2026-10-26）
 *
 * 背景：详情页原来是两个编辑框（正确答案 / 详细解题过程），各有自己的预览态与保存按钮，
 * 家长实际写的时候是「答案写完接着写过程」，两个框反而是负担；而且答案框之前没设
 * maxlength，微信 textarea 默认截断 140 字，长答案会被静默吞掉。
 *
 * 现在合并成**一个编辑框**：
 *   - 展示时把 content.answer 与 content.solution 拼成一段可读文本；
 *   - 保存时按「解析：」「【解析】」这类小标题切回两个字段 ——
 *     库里仍保留 answer / solution 两个字段（导出 Word/PDF 的「正确答案」「解析」
 *     两段标题还在，AI 解题采纳也仍分两段），只是用户面对一个框。
 *   - 用户不写小标题 → 整段都算答案，solution 写空（不会重复导出同一段）。
 *
 * ⚠️ 切分只认「行首 + 加粗括号或冒号」的明确标记，绝不对正文里的「解析」二字动手。
 */

/** 解题过程小标题：行首，允许【】/[] 包裹或带中英文冒号 */
const LABELS = ['解析', '解题过程', '解题思路', '解答', '解']

/**
 * 判断一行是不是解题过程的小标题。
 * 命中时返回该行冒号之后的内容（可能为空，正文在后续行）。
 */
function matchSolutionMarker(line: string): { rest: string } | null {
  const t = line.trim()
  if (!t) return null
  for (const label of LABELS) {
    // 【解析】/ [解析]（可再跟冒号）
    const bracket = t.match(new RegExp(`^[【\\[]\\s*${label}\\s*[】\\]]\\s*[:：]?\\s*([\\s\\S]*)$`))
    if (bracket) return { rest: bracket[1] || '' }
    // 解析：/ 解析:（必须有冒号；裸「解析」不算，避免把正文首行当标题）
    const colon = t.match(new RegExp(`^${label}\\s*[:：]\\s*([\\s\\S]*)$`))
    if (colon) return { rest: colon[1] || '' }
  }
  return null
}

/**
 * 合并文本 → { answer, solution }（保存前调用，输入是**可读形式**，不是 LaTeX）
 *
 * 规则：
 *  - 找到第一个小标题行 → 之前是答案，之后（含该行冒号后的内容）是解题过程；
 *  - 只有小标题没有正文（用户写了「解析：」还没填） → 不切分，整段当答案；
 *  - 没有小标题 → 整段当答案，solution 返回空串。
 */
export function splitAnswerSolution(text: string): { answer: string; solution: string } {
  const src = text || ''
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = matchSolutionMarker(lines[i])
    if (!m) continue
    const answer = lines.slice(0, i).join('\n').trim()
    const solution = [m.rest, ...lines.slice(i + 1)].join('\n').trim()
    // 标题下没有正文：可能是误触/占位，不做切分（否则答案会被整段搬进解析）
    if (!solution) break
    return { answer, solution }
  }
  return { answer: src.trim(), solution: '' }
}

/**
 * { answer, solution } → 合并文本（进编辑框前调用，参数是**可读形式**）
 *
 * 有解题过程时自动补一行「解析：」，这样用户一眼能看出下面那段的归属，
 * 也能删掉这行把两段并回答案（splitAnswerSolution 会识别为「没有小标题」）。
 */
export function joinAnswerSolution(answer: string, solution: string): string {
  const a = (answer || '').trim()
  const s = (solution || '').trim()
  if (!s) return a
  if (!a) return `解析：\n${s}`
  return `${a}\n\n解析：\n${s}`
}
