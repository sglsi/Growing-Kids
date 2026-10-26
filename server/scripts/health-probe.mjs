#!/usr/bin/env node
/**
 * 后端健康拨测（替代当前「没有告警」的状态）
 *
 * 作用：定时探活后端关键端点并把结果落盘，异常时可被计划任务/告警脚本识别。
 * 目前没有外部告警通道，因此定位是**可巡检 + 可挂计划任务**：
 *   · 单次探测     node scripts/health-probe.mjs
 *   · 常驻轮询     node scripts/health-probe.mjs --watch 5     （分钟，默认 5）
 *   · 关注指标     health 状态码 / 响应时间 / OCR 侧车可用性
 *
 * ⚠️ 设计要点（别改坏）：
 *   1) OCR 侧车**空闲 900s 会被回收**，属于设计行为而非故障 ⇒ 侧车不可用时只降级
 *      记为 warn，不影响整体退出码（否则计划任务会天天误报）。
 *   2) 只有当 health 不可用时才 warn + exit 1。
 *   3) Node 的 fetch 不走系统代理（与 curl --noproxy 等价），局域网地址直连。
 *   4) 日志追加写 server/logs/health-probe.log，不会自动轮转——定期人工清理。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const BASE = process.env.PROBE_BASE || process.env.PROJECT_DOMAIN || 'http://127.0.0.1:3001'
const OCR_BASE = process.env.PPSV3_URL || 'http://127.0.0.1:9301'
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000)

const LOG_DIR = path.resolve(process.cwd(), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'health-probe.log')

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  console.log(line)
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch (e) {
    console.error('写健康检查日志失败', e)
  }
}

async function probe(name, url) {
  const started = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    return { name, ok: res.ok, status: res.status, ms: Date.now() - started }
  } catch (e) {
    return { name, ok: false, status: 0, ms: Date.now() - started, err: String(e?.message || e) }
  }
}

async function runOnce() {
  const results = []
  // 后端主健康检查：唯一影响退出码的指标
  results.push(await probe('api/health', `${BASE.replace(/\/$/, '')}/api/health`))
  // OCR 侧车：可缺失（空闲回收是设计行为），只做 warn
  results.push(await probe('ocr/sidecar', `${OCR_BASE.replace(/\/$/, '')}/healthz`))

  const api = results[0]
  const ocr = results[1]

  if (api.ok) log('INFO', `health ok status=${api.status} ${api.ms}ms`)
  else log('WARN', `health FAIL status=${api.status} ${api.ms}ms ${api.err || ''}`)

  if (ocr.ok) log('INFO', `ocr sidecar ok ${ocr.ms}ms`)
  else log('INFO', `ocr sidecar unavailable（空闲 900s 回收属正常） ${ocr.err || ocr.status}`)

  return api.ok
}

const argWatch = process.argv.indexOf('--watch')
let intervalMin = 0
if (argWatch >= 0) {
  const raw = Number(process.argv[argWatch + 1])
  intervalMin = Number.isFinite(raw) && raw > 0 ? raw : 5
}

const ok = await runOnce()

if (intervalMin > 0) {
  log('INFO', `进入常驻巡检模式，每 ${intervalMin} 分钟一次`)
  setInterval(() => {
    void runOnce()
  }, intervalMin * 60 * 1000)
  // 常驻模式下退出码始终为 0：由日志承载告警，避免宿主把它当失败重启
  process.exitCode = 0
} else {
  process.exitCode = ok ? 0 : 1
}
