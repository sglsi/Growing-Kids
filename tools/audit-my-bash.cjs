#!/usr/bin/env node
/**
 * audit-my-bash.cjs —— 事后审计：从会话日志里把「我实际执行过的 Bash 命令」全部提取出来，
 * 逐条过 L11 检测器（v2 zsh 状态机版），验证「Bash 无码原则」是否真的被遵守。
 *
 * 为什么需要它（2026-09-26 实证）：
 *   21 次「出错停止」100% 是 zsh Bad substitution，且其中 4 次发生在
 *   「已写下教训 / 已建成拦截工具」之后 —— 说明光建工具没用，
 *   必须能**事后客观地验证**自己是否遵守，否则永远无法发现"以为遵守了其实没遵守"。
 *
 * 用法：
 *   node tools/audit-my-bash.cjs /root/.codebuddy/logs/2026-09-26/workspace_*.log
 *   node tools/audit-my-bash.cjs /root/.codebuddy/logs/2026-09-26/        # 传目录也行
 *   node tools/audit-my-bash.cjs <目录> --after=22:08                      # 只统计该时刻之后的违规
 *
 * 退出码：0 = 全部合规；1 = 发现违规；2 = 用法错误
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const LINT = path.join(__dirname, 'lint-shell.cjs')

/** 日志行首时间戳形态：[9/26/2026, 10:07:11 PM] [Info] [pid=...] ... */
const TS_RE = /\[(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)(?:\.\d+)?\]/g

/** 把日志时间戳转为当日分钟数（用于 --after 比较）；无法解析返回 null */
function tsToMinutes(h, m, ap) {
  let hh = Number(h)
  if (ap === 'PM' && hh !== 12) hh += 12
  if (ap === 'AM' && hh === 12) hh = 0
  return hh * 60 + Number(m)
}

/** 从日志文本提取所有 BashTool 执行的 command 原文及其时间戳 */
function extractCommands(text) {
  // 先扫描全文时间戳位置（行首），供二分/回溯查找
  const stamps = []
  let t
  TS_RE.lastIndex = 0
  while ((t = TS_RE.exec(text)) !== null) {
    stamps.push({ at: t.index, min: tsToMinutes(t[4], t[5], t[7]), raw: t[0] })
  }

  const cmds = []
  // 日志形态：[BashTool] execute start | command="..." | timeout=...
  // command 用双引号包裹，内部引号被原样记录（日志不转义），所以用非贪婪匹配到 " | timeout=
  const re = /\[BashTool\] execute start \| command="([\s\S]*?)" \| timeout=/g
  let m
  while ((m = re.exec(text)) !== null) {
    // 回溯找 m.index 之前最近的时间戳
    let min = null
    let raw = null
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (stamps[i].at <= m.index) {
        min = stamps[i].min
        raw = stamps[i].raw
        break
      }
    }
    cmds.push({ cmd: m[1], min, ts: raw })
  }
  return cmds
}

function collectFiles(target) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    return fs.readdirSync(target).filter((f) => f.endsWith('.log')).map((f) => path.join(target, f))
  }
  return [target]
}

function lintOne(cmd) {
  try {
    execFileSync('node', [LINT, cmd], { stdio: 'pipe' })
    return { ok: true }
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || '') }
  }
}

function parseAfter(argv) {
  const a = argv.find((x) => x.startsWith('--after='))
  if (!a) return null
  const m = a.slice(8).match(/^(\d{1,2}):(\d{2})$/)
  if (!m) {
    console.error('--after 格式应为 HH:MM（24 小时制），如 --after=22:08')
    process.exit(2)
  }
  return Number(m[1]) * 60 + Number(m[2])
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('用法: node tools/audit-my-bash.cjs <日志文件或目录> [--after=HH:MM]')
    process.exit(2)
  }
  const afterMin = parseAfter(process.argv.slice(3))

  const files = collectFiles(target)
  let total = 0
  let totalAfter = 0
  const violations = []
  const violationsAfter = []

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const cmds = extractCommands(text)
    for (const { cmd, min, ts } of cmds) {
      total += 1
      const inScope = afterMin == null || (min != null && min >= afterMin)
      if (inScope) totalAfter += 1
      const r = lintOne(cmd)
      if (!r.ok) {
        violations.push({ file: path.basename(f), cmd, ts, min })
        if (inScope) violationsAfter.push({ file: path.basename(f), cmd, ts, min })
      }
    }
  }

  console.log(`扫描日志文件 ${files.length} 个，提取 Bash 命令 ${total} 条`)
  if (afterMin != null) {
    console.log(`过滤条件：--after，落在该时刻之后的命令共 ${totalAfter} 条`)
  }

  const shown = afterMin != null ? violationsAfter : violations
  if (!shown.length) {
    console.log(afterMin != null ? '✓ 该时刻之后全部合规：0 违规' : '✓ 全部合规：未发现 L11 类危险写法')
    process.exit(0)
  }

  console.log(`✗ 发现 ${shown.length} 条违规命令${afterMin != null ? `（全量口径 ${violations.length} 条）` : ''}：\n`)
  shown.forEach((v, i) => {
    const preview = v.cmd.length > 140 ? v.cmd.slice(0, 140) + ' …' : v.cmd
    console.log(`  ${i + 1}. ${v.ts || '[无时间戳]'} [${v.file}]`)
    console.log(`     ${preview.replace(/\n/g, ' ⏎ ')}\n`)
  })
  process.exit(1)
}

main()
