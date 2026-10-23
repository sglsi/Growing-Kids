/**
 * 给保留原位的历史素材文档统一插入「已并入 GK-XX」指引块。
 * 用法：node docs/.annotate-docs.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry')
const MARK = '📌'

/** [路径, 目标 GK 文档, 状态类型] —— merged=已并入不再维护；active=活跃台账兼作素材 */
const TARGETS = [
  ['PRD-成长学习伙伴.md', 'GK-SRS-01-软件需求规格说明书.md', 'merged'],
  ['复习本与项目设计.md', 'GK-SRS-01-软件需求规格说明书.md', 'merged'],
  ['design_guidelines.md', 'GK-SRS-02-交互与视觉设计规范.md', 'merged'],
  ['DESIGN.md', 'GK-SRS-02-交互与视觉设计规范.md', 'merged'],
  ['题目答案功能-设计方案.md', 'GK-DD-11-AI与答案服务详细设计.md', 'merged'],
  ['安全与隐私设计方案.md', 'GK-ADD-07-安全与隐私设计说明书.md', 'merged'],
  ['docs/密钥管理与安全约定.md', 'GK-ADD-07-安全与隐私设计说明书.md', 'merged'],
  ['docs/数据库重新设计-v4.md', 'GK-ADD-05-数据库设计说明书.md', 'merged'],
  ['docs/后端托管与小程序发布-调研纪要.md', 'GK-QA-16-运维、发布与故障处置手册.md', 'merged'],
  ['docs/迁移到腾讯云-方案与步骤.md', 'GK-QA-16-运维、发布与故障处置手册.md', 'merged'],
  ['docs/获取DATABASE_URL-操作指引.md', 'GK-QA-16-运维、发布与故障处置手册.md', 'merged'],
  ['docs/存储空间优化-实现说明.md', 'GK-DD-12-存储与文件生命周期详细设计.md', 'merged'],
  ['docs/策略3-生命周期分层-配置清单.md', 'GK-DD-12-存储与文件生命周期详细设计.md', 'merged'],
  ['docs/策略6-配额方案.md', 'GK-DD-12-存储与文件生命周期详细设计.md', 'merged'],
  ['工程教训录.md', 'GK-OPS-18-风险与技术债登记册.md', 'active'],
  ['AGENTS.md', 'GK-QA-17-工程与编码规范.md', 'active'],
]

function buildBlock(gk, kind) {
  const gkName = gk.replace(/^GK-[A-Z]+-\d+-/, '').replace(/\.md$/, '')
  const id = gk.match(/^GK-[A-Z]+-\d+/)[0]
  if (kind === 'active') {
    return [
      `> ${MARK} **文档定位**：本文为**活跃维护**的台账/约定，同时是 \`docs/design/${gk}\`（${id} ${gkName}）的输入素材。`,
      `> 规范类条款以 GK 文档为准；本文保留过程记录、复盘与操作细节，两者冲突时以 GK 文档为准并回写本文。`,
    ].join('\n')
  }
  return [
    `> ${MARK} **归档状态**：本文为历史设计稿，**已并入 \`docs/design/${gk}\`（${id} ${gkName}）**。`,
    `> 现行规范与现状以 GK 文档为准；本文仅作决策凭据与演进过程留档，**不再单独维护**。`,
  ].join('\n')
}

let done = 0
let skipped = 0
for (const [rel, gk, kind] of TARGETS) {
  let raw
  try {
    raw = readFileSync(rel, 'utf8')
  } catch (e) {
    console.log(`MISS  ${rel}`)
    continue
  }
  if (raw.includes(`${MARK} **归档状态**`) || raw.includes(`${MARK} **文档定位**`)) {
    console.log(`SKIP  ${rel}（已有标注）`)
    skipped++
    continue
  }
  const lines = raw.split('\n')
  const titleIdx = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (titleIdx < 0) {
    console.log(`SKIP  ${rel}（无一级标题）`)
    skipped++
    continue
  }
  // 标题后若紧跟引用块（> 开头），插到该引用块之后；否则紧贴标题之后
  let insertAt = titleIdx + 1
  while (insertAt < lines.length && /^>\s?/.test(lines[insertAt])) insertAt++
  const block = buildBlock(gk, kind)
  lines.splice(insertAt, 0, '', block)
  const out = lines.join('\n')
  if (!DRY) writeFileSync(rel, out, 'utf8')
  console.log(`${DRY ? 'DRY ' : 'OK  '} ${rel} → ${gk}`)
  done++
}
console.log(`\n完成：写入 ${done} 份，跳过 ${skipped} 份${DRY ? '（dry-run，未落盘）' : ''}`)
