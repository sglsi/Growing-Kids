#!/usr/bin/env node
/**
 * Growing-Kids 后端唤醒服务（wake-server）
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景（2026-10-24 晚，思傅定）：
 *   看门狗（每分钟自查 + 挂了重拉）已取消——它每分钟的 node 窗口、以及后端重启时
 *   spawn 的 OCR python sidecar 窗口（实锤：gk-ocr-env venv 的 python.exe 闪窗）
 *   严重干扰用户操作。改为「前端驱动」：
 *     小程序请求连接超时 → 自动 POST 本服务 /wake → 后端没在跑就拉起并等待就绪
 *     → 自动重放原请求。用户无感知，且平时零窗口、零定时任务。
 *
 * 双角色：
 *   无参      = 启动器（启动文件夹 .cmd 登录时调用）：服务活着就静默退出；
 *               没活着就把它拉起来（自身无窗口：detached + windowsHide）
 *   --daemon  = 常驻服务本体
 *
 * 端点（默认 0.0.0.0:3002，手机与开发者工具均可达）：
 *   GET  /status        → { running, pid, startedAt }          （3001 是否在监听）
 *   POST /wake          → 需要时拉起后端，立即返回 { status, pid? }
 *                          status: 'already-running' | 'starting' | 'spawn-failed'
 *   GET  /wait-ready?timeout=25 → { ready, pid?, waitedMs }
 *                          长轮询等待 3001 就绪（供前端轮询；单次 ≤30s，
 *                          微信单请求 60s 上限内可多轮调用）
 *
 * 防误伤（与已取消的看门狗同规格）：
 *   - 拉起前查重：已有 dist/main 进程但端口未起（启动中）→ 等待，不重复拉
 *   - 单实例锁：.wake-server.pid + 进程存活校验，多实例只告警不动手
 *   - 拉起冷却：连续拉起间隔 ≥10s，防止 python 崩溃循环刷进程
 *   - 日志：wake-server.log 只记动作；后端输出照旧 backend-YYYY-MM-DD.log
 *
 * 停用：删除启动文件夹 GrowingKids-Wake.cmd（见 memory 记录），或
 *       touch server/logs/.wake-server-disabled 后杀进程。
 */
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(HERE, '..')
const LOGS_DIR = path.join(SERVER_DIR, 'logs')
const LOG_FILE = path.join(LOGS_DIR, 'wake-server.log')
const PID_FILE = path.join(LOGS_DIR, '.wake-server.pid')
const DISABLED_FLAG = path.join(LOGS_DIR, '.wake-server-disabled')
const BACKEND_LOG = () => path.join(LOGS_DIR, `backend-${new Date().toISOString().slice(0, 10)}.log`)

const PORT = Number(process.env.WAKE_PORT || 3002)
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 3001)
const NODE = 'D:\\Program Files\\nodejs\\node.exe' // 系统 node 24：sharp 已验证兼容，且不受 WorkBuddy 托管二进制升级影响
const DIST_MAIN = path.join(SERVER_DIR, 'dist', 'main.js')
// OCR 三件套：venv 与模型缓存必须在仓库外（否则开发者工具文件监听耗尽句柄 → EMFILE）
const OCR_ENV = {
  OCR_VENV_DIR: 'D:/AI/gk-ocr-env/.venv-py',
  PADDLE_PDX_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-paddlex',
  XDG_CACHE_HOME: 'D:/AI/gk-ocr-env/.cache-xdg',
}
// session 0 / 无头环境下 TEMP 必须显式（守护型进程继承的 TEMP 可能不可写）
const TEMP_ENV = { TEMP: 'D:/AI/gk-ocr-env/.tmp', TMP: 'D:/AI/gk-ocr-env/.tmp' }

const WAKE_COOLDOWN_MS = 10_000 // 连续拉起冷却，防崩溃循环刷进程
const WAIT_READY_MAX_MS = 120_000 // 单次等待就绪上限（OCR 冷启动+模型加载慢）

let lastSpawnAt = 0
let inFlight = null // 进行中的拉起 Promise（并发 /wake 共用）
let backendPid = null

fs.mkdirSync(LOGS_DIR, { recursive: true })
fs.mkdirSync(TEMP_ENV.TEMP, { recursive: true })

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* ignore */
  }
  console.log(line)
}

/** PowerShell 查询（无窗口；唤醒服务自身无控制台时必须加 windowsHide） */
function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...TEMP_ENV },
  })
}

/** 3001 监听进程 pid（没监听返回 null） */
function getBackendPid() {
  try {
    const out = ps(
      `(Get-NetTCPConnection -LocalPort ${BACKEND_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    )
    const pid = Number(String(out).trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 所有 dist/main 进程 pid 列表（拉起前查重用） */
function findBackendProcs() {
  try {
    const out = ps(
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\\main*' } | ForEach-Object { $_.ProcessId }) -join ','`,
    )
    return String(out)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function procStart(pid) {
  try {
    const out = ps(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToString('yyyy-MM-ddTHH:mm:ss') }`,
    )
    const s = String(out).trim()
    return s ? new Date(s) : null
  } catch {
    return null
  }
}

function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => {
      sock.destroy()
      resolve(false)
    })
    sock.setTimeout(1500, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

async function waitReady(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await portListening(BACKEND_PORT)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/** 拉起后端（带 OCR 三件套；detached + windowsHide 全链路无窗口） */
function spawnBackend() {
  if (!fs.existsSync(DIST_MAIN)) {
    log(`ERROR: ${DIST_MAIN} 不存在，无法拉起（先 npx nest build）`)
    return null
  }
  const outFd = fs.openSync(BACKEND_LOG(), 'a')
  const child = spawn(NODE, [DIST_MAIN, '-p', String(BACKEND_PORT)], {
    cwd: SERVER_DIR, // 必须 = server/：.env 加载依赖 cwd
    env: { ...process.env, ...OCR_ENV, ...TEMP_ENV },
    stdio: ['ignore', outFd, outFd],
    detached: true,
    windowsHide: true,
  })
  child.unref()
  try {
    fs.closeSync(outFd)
  } catch {
    /* ignore */
  }
  backendPid = child.pid
  log(`SPAWN: 已拉起后端 pid=${child.pid}（端口 ${BACKEND_PORT}，OCR 三件套就位，无窗口）`)
  return child.pid
}

/**
 * 唤醒：需要时才拉起。
 * 并发保护：inFlight 期间后来的 /wake 直接复用同一个结果。
 */
async function wake() {
  const pid = getBackendPid()
  if (pid) {
    backendPid = pid
    return { status: 'already-running', pid }
  }
  const procs = findBackendProcs()
  if (procs.length > 0) {
    // 启动中（进程在、端口未起）：等它就绪，不重复拉
    log(`WAIT: 发现启动中的后端进程 [${procs.join(', ')}]，等待就绪而非重复拉起`)
    const ready = await waitReady(60_000)
    return ready ? { status: 'already-running', pid: procs[0] } : { status: 'starting-timeout', pid: procs[0] }
  }
  if (!inFlight) {
    if (Date.now() - lastSpawnAt < WAKE_COOLDOWN_MS) {
      return { status: 'cooldown', retryAfterMs: WAKE_COOLDOWN_MS - (Date.now() - lastSpawnAt) }
    }
    lastSpawnAt = Date.now()
    inFlight = (async () => {
      const newPid = spawnBackend()
      if (!newPid) return { status: 'spawn-failed' }
      const ready = await waitReady(WAIT_READY_MAX_MS)
      return ready ? { status: 'started', pid: newPid } : { status: 'starting', pid: newPid }
    })().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

function status() {
  const pid = getBackendPid()
  if (pid) backendPid = pid
  return {
    running: !!pid,
    pid: pid ?? null,
    startedAt: pid ? procStart(pid)?.toISOString() ?? null : null,
  }
}

// ── HTTP 服务 ──────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*', // 开发者工具 H5 调试面板也可能调用
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end(body)
  }
  if (req.method === 'OPTIONS') return json(204, {})

  if (req.method === 'GET' && url.pathname === '/status') {
    return json(200, status())
  }
  if (req.method === 'GET' && url.pathname === '/wait-ready') {
    const timeoutMs = Math.min(Number(url.searchParams.get('timeout') || 25), 30) * 1000
    const t0 = Date.now()
    const poll = async () => {
      if (await portListening(BACKEND_PORT)) return json(200, { ready: true, waitedMs: Date.now() - t0 })
      if (Date.now() - t0 >= timeoutMs) return json(200, { ready: false, waitedMs: Date.now() - t0 })
      setTimeout(poll, 1000)
    }
    return poll()
  }
  if (req.method === 'POST' && url.pathname === '/wake') {
    if (fs.existsSync(DISABLED_FLAG)) return json(503, { status: 'disabled' })
    return wake().then((r) => json(200, r))
  }
  json(404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  const st = status()
  log(`wake-server 启动于 0.0.0.0:${PORT}（后端 ${st.running ? `运行中 pid=${st.pid}` : '未运行'}）`)
})

// ── 角色分发 ──────────────────────────────────────────────────────────────
const isDaemon = process.argv.includes('--daemon')

/** 启动器模式：服务活着就退出；没活着就把它（无窗口）拉起来 */
async function runLauncher() {
  // 先用纯 TCP 探测（零子进程、零窗口）：通 = 已在跑，静默退出
  if (await portListening(PORT)) process.exit(0)
  // 连不通：pidfile 里的进程活着？理论上端口不通就该重拉，但防御性校验一次
  try {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    if (old > 0 && old !== process.pid) {
      const alive = ps(`if (Get-Process -Id ${old} -ErrorAction SilentlyContinue) { '1' } else { '0' }`).trim()
      if (alive === '1') {
        // 进程在但端口不通：等 2s 让它 listen 完，再退
        await new Promise((r) => setTimeout(r, 2000))
        if (await portListening(PORT)) process.exit(0)
      }
    }
  } catch {
    /* pidfile 不存在或读失败：继续拉起 */
  }
  const child = spawn(process.execPath, [path.resolve(HERE, 'wake-server.mjs'), '--daemon'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...TEMP_ENV },
    stdio: 'ignore', // 日志只走 log() 写文件，避免双写
    detached: true,
    windowsHide: true,
  })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  log(`LAUNCHER: 唤醒服务未运行，已拉起守护实例 pid=${child.pid}（无窗口）`)
  process.exit(0)
}

if (!isDaemon) runLauncher()
// daemon 模式：写 pidfile 供启动器校验；定时刷新 backendPid（不拉，拉只由 /wake 触发）
else {
  fs.writeFileSync(PID_FILE, String(process.pid))
  setInterval(() => {
    const pid = getBackendPid()
    if (pid) backendPid = pid
  }, 60_000).unref()
  // 异常兜底：唤醒服务是前端唯一的自救入口，不能因未捕获异常静默死掉
  process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e?.stack || e}（服务继续运行）`))
  process.on('unhandledRejection', (e) => log(`UNHANDLED: ${e?.stack || e}（服务继续运行）`))
}
