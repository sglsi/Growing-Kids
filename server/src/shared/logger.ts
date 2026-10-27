// ============================================================
// 统一日志（OPS-18 R-工程-07）
//
// 背景：此前日志全靠各 service 的 `console.log/warn/error`，服务通常是「在另一个终端
// 手动起的」，输出只进那个终端的 stdout —— 跨会话/隔天就查不到，出问题只能靠人贴屏。
// 已有一个 `AllExceptionsFilter` 把 5xx 落盘，但**正常请求、慢请求、权限拒绝**全无痕迹。
//
// 本模块解决三件事，且**不要求改动任何已有代码**：
//  1) `installLogTee()` —— 接管 console.*，所有已有日志自动追加到
//     `server/logs/app-YYYY-MM-DD.log`（JSON 行，便于 grep/jq）；
//  2) 访问日志中间件 —— 每请求一行：方法、路径、状态、耗时、用户、traceId；
//  3) 保留 7 天 —— 启动时 + 每 6 小时清扫一次，防止磁盘被日志吃掉。
//
// 设计取舍：
//  - **同步 append**：日志量小（单机、日活几十），同步写换来「进程崩了日志还在」；
//  - **不在请求热路径拼大字符串**：访问日志只记必要字段；
//  - **不引入日志库**：pino/winston 都要改调用点，而本项目已有几百处 console.*，
//    逐个改的收益远小于风险（改漏 = 静默丢日志）。
// ============================================================

import * as fs from 'fs'
import * as path from 'path'
import type { Request, Response, NextFunction } from 'express'

/** 日志目录：与 AllExceptionsFilter 同口径（cwd 下 logs/，已在 .gitignore） */
export const LOG_DIR = path.resolve(process.cwd(), 'logs')

/** 保留天数 */
const RETENTION_DAYS = 7
/** 单文件上限，超过则换号（app-YYYY-MM-DD.2.log） */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单条日志里单个参数的最大字符数（防止把 50mb base64 body 写进磁盘） */
const MAX_ARG_CHARS = 1500

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug'

let installed = false
let currentDay = ''
let currentFile = ''
let currentBytes = 0

function dayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    /* 目录建不出来就只走 stdout，不能因此让服务起不来 */
  }
}

/** 危险字符/循环引用安全的序列化 */
function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>()
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]'
        seen.add(val)
      }
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack }
      return val
    })
    return s === undefined ? String(v) : s
  } catch {
    return String(v)
  }
}

function toText(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`
    if (typeof a === 'object' && a !== null) return safeStringify(a)
    return String(a)
  })
  const s = parts.join(' ')
  return s.length > MAX_ARG_CHARS ? `${s.slice(0, MAX_ARG_CHARS)}…(${s.length} chars)` : s
}

function pickFile(): string {
  const day = dayStr()
  if (day !== currentDay || !currentFile) {
    ensureDir()
    currentDay = day
    currentFile = path.join(LOG_DIR, `app-${day}.log`)
    try {
      currentBytes = fs.existsSync(currentFile) ? fs.statSync(currentFile).size : 0
    } catch {
      currentBytes = 0
    }
  } else if (currentBytes > MAX_FILE_BYTES) {
    // 换号：app-YYYY-MM-DD.2.log → .3.log …
    for (let i = 2; i < 100; i++) {
      const f = path.join(LOG_DIR, `app-${day}.${i}.log`)
      const size = fs.existsSync(f) ? fs.statSync(f).size : 255
      if (size < MAX_FILE_BYTES) {
        currentFile = f
        currentBytes = size === 255 ? 0 : size
        break
      }
    }
  }
  return currentFile
}

/** 写一行 JSON。任何失败都静默（日志不能反过来打断业务） */
export function writeLog(level: Level, msg: string, extra?: Record<string, unknown>) {
  try {
    const file = pickFile()
    const line =
      safeStringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) }) + '\n'
    fs.appendFileSync(file, line, 'utf8')
    currentBytes += Buffer.byteLength(line, 'utf8')
  } catch {
    /* ignore */
  }
}

/** 清扫超过保留期的日志（app-*.log 与 error-*.log 一起） */
export function sweepOldLogs(days = RETENTION_DAYS): number {
  ensureDir()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let removed = 0
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^(app|error)-.*\.log$/.test(f)) continue
      const full = path.join(LOG_DIR, f)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  } catch {
    /* ignore */
  }
  return removed
}

/**
 * 接管 console.*：原输出照旧（终端仍能看），额外落一行 JSON 到文件。
 * 幂等，可重复调用。
 */
export function installLogTee(): void {
  if (installed) return
  installed = true
  ensureDir()

  const original: Record<Level, (...a: unknown[]) => void> = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console),
  }

  const levels: Level[] = ['log', 'info', 'warn', 'error', 'debug']
  for (const lv of levels) {
    ;(console as unknown as Record<string, unknown>)[lv] = (...args: unknown[]) => {
      original[lv](...args)
      // 文件里区分 info/debug，其余保持原级别名
      writeLog(lv === 'log' ? 'info' : lv, toText(args))
    }
  }

  const removed = sweepOldLogs()
  if (removed) original.log(`[logger] 已清理 ${removed} 个超过 ${RETENTION_DAYS} 天的日志文件`)

  const timer = setInterval(() => {
    try {
      sweepOldLogs()
    } catch {
      /* ignore */
    }
  }, 6 * 60 * 60 * 1000)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
}

/** 生成 traceId（同一请求的日志可串起来；前端/网关注入 X-Trace-Id 则沿用） */
export function makeTraceId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  ).toUpperCase()
}

type ReqWithCtx = Request & { userId?: string; userRole?: string; traceId?: string }

/**
 * 访问日志中间件。
 *
 * 只记必要字段（方法/路径/状态/耗时/用户），**不记 body**——题图 base64 会把磁盘写炸。
 * 5xx 由 AllExceptionsFilter 另记完整堆栈，这里仍然记一行，便于看「慢在哪一步」。
 */
export function accessLog(req: ReqWithCtx, res: Response, next: NextFunction) {
  const start = Date.now()
  const traceId = String(req.headers['x-trace-id'] || '') || makeTraceId()
  req.traceId = traceId

  res.on('finish', () => {
    const ms = Date.now() - start
    // 去掉 query 里的长参数（如 base64/签名），只留 path
    const rawPath = (req.originalUrl || req.url || '').split('?')[0]
    writeLog(ms >= 2000 ? 'warn' : 'info', 'access', {
      trace: traceId,
      method: req.method,
      path: rawPath,
      status: res.statusCode,
      ms,
      user: req.userId || '',
      role: req.userRole || '',
      slow: ms >= 2000 ? true : undefined,
    })
  })

  next()
}
