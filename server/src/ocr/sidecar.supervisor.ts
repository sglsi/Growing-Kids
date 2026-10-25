import { spawn, execSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  type OcrTelemetry,
  type OcrAlertSink,
  getOcrTelemetry,
  getOcrAlertSink,
} from './ocr-health'
import { toGuiPython, pythonEnv, decodeEngineChunk } from './python-gui'

/**
 * OCR 侧车守护进程（lazy-start + 空闲回收 + 资源紧张回收）
 *
 * 设计目标（用户需求）：
 *  - **按需启动**：OCR 调用到来且侧车未运行时，自动拉起 Python 侧车（spawn 独立进程）。
 *  - **空闲回收**：一段时间（默认 15min）无 OCR 调用后自动停止侧车，释放资源。
 *  - **资源紧张回收**：当内存压力超阈值（OCR_SHUTDOWN_RSS_MB）且当前无人使用时，
 *    以更短的容忍窗口（OCR_TIGHT_IDLE_MS）尽快回收。
 *  - **不在使用时绝不杀进程**：active>0（请求进行中）时任何回收都被跳过，保证请求不中断。
 *
 * 与主链路解耦：
 *  - 外部已独立部署侧车时，设 `OCR_SUPERVISE=0`，`withSidecar` 直接透传 fn()，行为与改造前一致。
 *  - auto 模式（默认）：仅当 ocr-engine/main.py 存在且 python3 可用时才启用托管，否则降级为透传。
 *  - 任何启动/探活失败都返回 null 交由 OcrService 降级到 VLM，绝不抛错阻断主链路。
 */

export interface SidecarConfig {
  /** '1' 强制启用托管 | '0' 禁用（外部侧车） | 'auto' 仅当脚本存在且 python 可用时启用 */
  supervise: '1' | '0' | 'auto'
  engineDir: string
  script: string
  python: string
  host: string
  port: number
  baseUrl: string
  /** 空闲超时（毫秒），默认 15min */
  idleTimeoutMs: number
  /** 资源紧张时的空闲容忍窗口（毫秒），默认 2min */
  tightIdleMs: number
  /** 内存 RSS 阈值（字节），>0 时启用资源紧张回收；0=禁用 */
  tightRssBytes: number
  /** 回收巡检间隔（毫秒），默认 15s */
  monitorMs: number
  /** 启动等待 /healthz 超时（毫秒），默认 30s */
  startTimeoutMs: number
  /** 透传给侧车子进程的环境变量（OCR_ENGINE_MODE 等） */
  engineEnv: Record<string, string>
  /** 埋点（与 LocalOcrClient 共享，统一成功率/降级率视图）。默认单例。 */
  telemetry: OcrTelemetry
  /** 告警上报。默认单例（console / webhook）。 */
  alertSink: OcrAlertSink
  /** 健康自检：running 但 /healthz 连续失败达此次数 → 自愈 + 告警。默认 3。 */
  unhealthyFailThreshold: number
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000
const DEFAULT_TIGHT_IDLE_MS = 2 * 60 * 1000
const DEFAULT_MONITOR_MS = 15 * 1000
const DEFAULT_START_TIMEOUT_MS = 30 * 1000

function resolveScript(): { dir: string; script: string } {
  const candidates = [
    process.env.OCR_ENGINE_DIR,
    path.resolve(__dirname, '../../../ocr-engine'),
    // ⭐ 部署包内嵌：deploy-pack.mjs 会把仓库根 ocr-engine/ 复制进 server/ocr-engine/ 一起上传，
    //    避免「只传 server/ 导致 /ocr-engine 脚本缺失、OCR 全挂」（问题③）。
    path.resolve(__dirname, '../../ocr-engine'),
    path.resolve(process.cwd(), 'ocr-engine'),
    path.resolve(process.cwd(), '../ocr-engine'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    const p = path.join(dir, 'main.py')
    if (fs.existsSync(p)) return { dir, script: p }
  }
  return { dir: candidates[0] ?? path.resolve(__dirname, '../../../ocr-engine'), script: '' }
}

function parseBaseUrl(raw: string): { host: string; port: number } {
  const m = raw.match(/^https?:\/\/([^:/]+)(?::(\d+))?/)
  return { host: m?.[1] ?? '127.0.0.1', port: m?.[2] ? Number(m[2]) : 9300 }
}

/**
 * python 可执行判定：
 *  - 绝对/相对路径（如 PPSV3_PYTHON 默认的 /opt/pocr3-venv/bin/python 或
 *    Windows 的 D:\...\Scripts\python.exe）：直接查文件存在 + 可执行位。
 *    venv 未随部署落地时这里必须判失败——否则 auto 模式会显示"守护已启用"，
 *    随后 spawn ENOENT 把每次 OCR 拖进 30s 启动超时再静默失败。
 *    （注意：不能用 includes('/') 判路径——Windows 绝对路径 D:\... 不含 /，
 *     会被误判成裸命令走 command -v，在 cmd.exe 下必然失败。）
 *  - 裸命令（python3/python）：走 PATH 查找。
 */
/** 在 PATH 里找命令（纯文件扫描，不派生任何子进程）
 *  ⚠️ 2026-10-24 修：原来 windows 上也跑 `execSync('command -v python')`——
 *     command 是 Unix 命令，Windows 下必然失败，还白白派生一个 cmd.exe（弹窗嫌疑）。
 */
function findOnPath(cmd: string): boolean {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, cmd + ext)).isFile()) return true
      } catch {
        /* ignore */
      }
    }
  }
  return false
}

function pythonUsable(python: string): boolean {
  try {
    if (path.isAbsolute(python)) {
      const st = fs.statSync(python)
      if (!st.isFile()) return false
      fs.accessSync(python, fs.constants.X_OK)
      return true
    }
    return findOnPath(python)
  } catch {
    return false
  }
}

/** legacy（2.x 融合）侧车 python：优先项目内持久化 venv（.venv-py，沙箱重置不丢）→ 系统 python3。
 *  平台自适应：Windows 本机开发走项目根 .venv-py\Scripts\python.exe（与 install-ocr-env.ps1 对齐）。
 *  OCR_VENV_DIR 可覆盖 venv 位置（venv 搬出仓库根防 DevTools EMFILE）。 */
function defaultLegacyPython(): string {
  try {
    if (process.platform === 'win32') {
      const repoRoot = path.resolve(__dirname, '../../..')
      for (const p of [
        ...(process.env.OCR_VENV_DIR ? [path.join(process.env.OCR_VENV_DIR, 'Scripts', 'python.exe')] : []),
        path.join(repoRoot, '.venv-py', 'Scripts', 'python.exe'),
        path.join(repoRoot, 'ocr-engine', '.venv', 'Scripts', 'python.exe'),
      ]) {
        if (fs.existsSync(p)) return p
      }
      return 'python'
    }
    const venvPython = '/workspace/projects/.venv-py/bin/python'
    if (fs.existsSync(venvPython)) return venvPython
  } catch { /* ignore */ }
  return 'python3'
}

function buildConfig(opts?: Partial<SidecarConfig>): SidecarConfig {
  // 默认端口 9300（沙箱 9000 被 Coze 平台内部 uvicorn 代理占用）
  const { host, port } = parseBaseUrl(process.env.OCR_ENGINE_URL || 'http://127.0.0.1:9300')
  const { dir, script } = resolveScript()
  const engineEnv: Record<string, string> = {}
  // 透传 OCR 引擎调优项（main3.py 侧车读取）。PPSV3_* 必须在此列出——
  // 否则 .env 里配了模型档位/开关也传不进侧车进程（问题③排查时才发现这个断点）。
  for (const k of [
    'OCR_ENGINE_MODE',
    'OCR_DEVICE',
    'OCR_LOW_CONF_THRESHOLD',
    'OCR_DRY_RUN',
    'PPSV3_DEVICE',
    'PPSV3_DET_MODEL',
    'PPSV3_REC_MODEL',
    'PPSV3_LAYOUT_MODEL',
    'PPSV3_UNWARP',
    'PPSV3_ORIENT_CLS',
  ]) {
    if (process.env[k] !== undefined) engineEnv[k] = process.env[k] as string
  }
  const supervise = ((process.env.OCR_SUPERVISE || 'auto') as '1' | '0' | 'auto')
  const cfg: SidecarConfig = {
    supervise,
    engineDir: dir,
    script,
    python: process.env.OCR_PYTHON || defaultLegacyPython(),
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    idleTimeoutMs: opts?.idleTimeoutMs ?? (Number(process.env.OCR_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_MS),
    tightIdleMs: opts?.tightIdleMs ?? (Number(process.env.OCR_TIGHT_IDLE_MS) || DEFAULT_TIGHT_IDLE_MS),
    tightRssBytes:
      opts?.tightRssBytes ??
      (process.env.OCR_SHUTDOWN_RSS_MB ? Number(process.env.OCR_SHUTDOWN_RSS_MB) * 1024 * 1024 : 0),
    monitorMs: opts?.monitorMs ?? (Number(process.env.OCR_MONITOR_MS) || DEFAULT_MONITOR_MS),
    startTimeoutMs: opts?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    engineEnv: { ...engineEnv, ...(opts?.engineEnv ?? {}) },
    telemetry: opts?.telemetry ?? getOcrTelemetry(),
    alertSink: opts?.alertSink ?? getOcrAlertSink(),
    unhealthyFailThreshold: opts?.unhealthyFailThreshold ?? Number(process.env.OCR_UNHEALTHY_FAILS ?? 3),
  }
  // 覆盖透传字段
  if (opts?.engineDir) cfg.engineDir = opts.engineDir
  if (opts?.script) cfg.script = opts.script
  if (opts?.python) cfg.python = opts.python
    if (opts?.host) cfg.host = opts.host
  if (opts?.port) {
    cfg.port = opts.port
    cfg.baseUrl = `http://${cfg.host}:${opts.port}`
  }
  // 允许直接以完整 URL 覆盖（测试/多侧车场景），优先级高于 host/port
  if (opts?.baseUrl) {
    const parsed = parseBaseUrl(opts.baseUrl)
    cfg.host = parsed.host
    cfg.port = parsed.port
    cfg.baseUrl = opts.baseUrl
  }
  if (opts?.supervise) cfg.supervise = opts.supervise
  return cfg
}

export class SidecarSupervisor {
  private readonly cfg: SidecarConfig
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private monitorTimer: NodeJS.Timeout | null = null
  private active = 0
  private lastUsed = Date.now()
  private intentionalStop = false
  private unhealthyCount = 0
  private unhealthyAlerted = false
  readonly disabled: boolean
  private readonly telemetry: OcrTelemetry
  private readonly alertSink: OcrAlertSink

  constructor(opts?: Partial<SidecarConfig>) {
    this.cfg = buildConfig(opts)
    this.disabled = this.computeDisabled()
    this.telemetry = this.cfg.telemetry
    this.alertSink = this.cfg.alertSink
    if (!this.disabled) {
      this.monitorTimer = setInterval(() => void this.tick(), this.cfg.monitorMs)
      this.monitorTimer.unref?.()
      process.once('SIGTERM', () => this.stop('sigterm'))
      process.once('SIGINT', () => this.stop('sigint'))
      console.log(
        `[sidecar] 守护已启用：监听 ${this.cfg.baseUrl}，` +
          `空闲回收 ${Math.round(this.cfg.idleTimeoutMs / 1000)}s` +
          (this.cfg.tightRssBytes > 0
            ? `，资源紧张阈值 ${(this.cfg.tightRssBytes / 1024 / 1024) | 0}MB`
            : ''),
      )
    } else {
      const reason = this.disabledReason()
      console.log(
        `[sidecar] 守护未启用（${reason || '未知原因'}），按外部侧车模式运行；` +
          `若 OCR 结果持续为空，请检查 ${this.cfg.baseUrl} 是否有侧车在监听`,
      )
    }
  }

  private computeDisabled(): boolean {
    const raw = this.cfg.supervise
    if (raw === '0') return true
    if (raw === '1') return false
    // auto：脚本存在且 python 可用才启用
    if (!this.cfg.script || !fs.existsSync(this.cfg.script)) return true
    return !pythonUsable(this.cfg.python)
  }

  /** 托管未启用的具体原因（auto 模式排查侧车"静默不通"的第一现场） */
  /** 守护未启用的具体原因（supervise=0 / 脚本缺失 / python 不可用）——诊断端点要暴露它。 */
  disabledReason(): string {
    const raw = this.cfg.supervise
    if (raw === '0') return 'supervise=0（外部侧车模式）'
    if (raw === '1') return ''
    if (!this.cfg.script || !fs.existsSync(this.cfg.script)) {
      return `脚本缺失（${this.cfg.script || '未解析到 main.py/main3.py'}）`
    }
    if (!pythonUsable(this.cfg.python)) return `python 不可用（${this.cfg.python}）`
    return ''
  }

  /** 当前是否应回收侧车（纯函数，便于测试）。不在使用中、超过容忍窗口即停。 */
  private shouldStop(now: number): { stop: boolean; reason: string } {
    if (!this.child || this.starting || this.active > 0) return { stop: false, reason: '' }
    const elapsed = now - this.lastUsed
    const rss = process.memoryUsage().rss
    const tight = this.cfg.tightRssBytes > 0 && rss > this.cfg.tightRssBytes
    const limit = tight ? this.cfg.tightIdleMs : this.cfg.idleTimeoutMs
    if (elapsed >= limit) return { stop: true, reason: tight ? 'resource-pressure' : 'idle' }
    return { stop: false, reason: '' }
  }

  private tick(): void {
    const { stop, reason } = this.shouldStop(Date.now())
    if (stop) {
      this.stop(reason)
      return
    }
    // 健康自检：侧车在跑，但 /healthz 连续失败 → 进程可能僵死，自愈（kill 让下次 ensureReady 重启）+ 告警。
    // 仅在「非启动中、子进程存在且未死」时判定，避免启动期误报。
    if (this.child && !this.child.killed && !this.starting) {
      void this.selfCheck()
    }
  }

  private async selfCheck(): Promise<void> {
    const ok = await this.isHealthy()
    this.telemetry.markHealthCheck(ok)
    if (!ok) {
      this.unhealthyCount++
      if (!this.unhealthyAlerted && this.unhealthyCount >= this.cfg.unhealthyFailThreshold) {
        this.alertSink.alert('sidecar-unhealthy', {
          consecutive: this.unhealthyCount,
          baseUrl: this.cfg.baseUrl,
        })
        this.unhealthyAlerted = true
        // 自愈：杀掉僵死进程（不标 intentional，允许下次 ensureReady 自动重启）
        this.intentionalStop = false
        const c = this.child
        if (c && !c.killed) {
          try {
            c.kill('SIGTERM')
          } catch {
            /* ignore */
          }
        }
        this.child = null
        this.unhealthyCount = 0
      }
    } else {
      if (this.unhealthyAlerted) {
        this.alertSink.alert('sidecar-recovered', { baseUrl: this.cfg.baseUrl })
        this.unhealthyAlerted = false
      }
      this.unhealthyCount = 0
    }
  }

  private async isHealthy(): Promise<boolean> {
    // 始终以 HTTP 探活为准（不再要求 this.child 存在）：
    //  - 自己 spawn 的子进程启动中/僵死 → /healthz 不通 → false（轮询继续/自愈），语义不变；
    //  - 端口已被**外部健康守护进程**持有（运维预启/上一次探针的 orphan）→ true → 采纳，
    //    不再 spawn 一个绑不上端口的 doomed child 打架（A/B 部署实测踩过：
    //    3.x 侧车被 orphan 占端口，supervisor 反复 spawn 失败 → 整条链路假死）。
    try {
      const res = await fetch(`${this.cfg.baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }

  private async start(timeoutMs = this.cfg.startTimeoutMs): Promise<void> {
    if (this.starting) return this.starting
    if (this.child && !this.child.killed) return
    if (!this.cfg.script) throw new Error('侧车脚本 main.py 未找到')
    this.lastUsed = Date.now()
    this.intentionalStop = false
    this.starting = (async () => {
      // ⭐ stdio 重定向到**文件**而非管道：父进程（探针/短驻 Node）退出会关闭管道读端，
      // 侧车推理中写 stdout 即报 Errno 32 Broken pipe——/healthz 不写日志所以仍"健康"，
      // 但 /ppsv3 全 500；后续进程按 HTTP 探活"收养"该半死侧车后静默降级（#144 排查确认）。
      // 文件 fd 不随父进程退出失效，孤儿侧车保持完全健康。
      const logPath = path.join(os.tmpdir(), `ocr-sidecar-${this.cfg.port}.log`)
      let logFd: number
      try {
        logFd = fs.openSync(logPath, 'a')
      } catch {
        logFd = -1 // 打不开日志文件时退回管道（至少不丢启动能力）
      }
      const stdio: ('ignore' | 'pipe' | number)[] = logFd >= 0 ? ['ignore', logFd, logFd] : ['ignore', 'pipe', 'pipe']
      const child = spawn(
        toGuiPython(this.cfg.python),
        [this.cfg.script, '--host', this.cfg.host, '--port', String(this.cfg.port)],
        // pythonEnv：强制 PYTHONUTF8，避免无 LANG 环境（服务经 PowerShell/计划任务启动）下
        // 侧车 HTTP 响应体/日志回落 GBK（#117）。engineEnv 仍可覆盖其余变量。
        { cwd: this.cfg.engineDir, env: pythonEnv(this.cfg.engineEnv), stdio, windowsHide: true },
      )
      if (logFd < 0) {
        child.stdout?.on('data', (d) => console.log(`[sidecar] ${decodeEngineChunk(d).trim()}`))
        child.stderr?.on('data', (d) => console.warn(`[sidecar] ${decodeEngineChunk(d).trim()}`))
      } else {
        console.log(`[sidecar] 子进程日志：${logPath}`)
      }
      const closeLog = () => { if (logFd >= 0) { try { fs.closeSync(logFd) } catch { /* ignore */ } } }
      // spawn 失败（python 不存在/无权限/脚本语法错误退出）→ 立即记下，轮询里优先抛错，
      // 不耗满 startTimeout（此前 ENOENT 要卡 30s 才"启动超时"，每次 OCR 都白等）。
      // 用对象承载：闭包内赋值后 while 里的 truthy 窄化才不会被 TS 收窄成 never。
      const spawnState: { err: Error | null } = { err: null }
      child.on('exit', (code, signal) => {
        closeLog()
        this.child = null
        if (!this.intentionalStop && (code || signal)) {
          console.warn(`[sidecar] 进程退出 code=${code} signal=${signal}`)
        }
      })
      child.on('error', (e) => {
        closeLog()
        spawnState.err = e instanceof Error ? e : new Error(String(e))
        console.warn(`[sidecar] 子进程错误: ${spawnState.err.message}`)
      })
      this.child = child
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (spawnState.err) {
          throw new Error(`侧车启动失败（spawn ${this.cfg.python}）: ${spawnState.err.message}`)
        }
        if (await this.isHealthy()) return
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('侧车启动超时（未在超时内通过 /healthz）')
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** OCR 调用前确保侧车就绪：未运行则自动启动。失败返回 false（交由上层降级）。 */
  async ensureReady(timeoutMs = this.cfg.startTimeoutMs): Promise<boolean> {
    if (this.disabled) return false
    if (await this.isHealthy()) {
      this.lastUsed = Date.now()
      return true
    }
    try {
      await this.start(timeoutMs)
      this.lastUsed = Date.now()
      return true
    } catch (e) {
      console.warn(`[sidecar] 自动启动失败，将降级 VLM：${(e as Error)?.message ?? e}`)
      this.alertSink.alert('sidecar-startup-failed', {
        baseUrl: this.cfg.baseUrl,
        error: String((e as Error)?.message ?? e),
      })
      return false
    }
  }

  /**
   * 包裹一次本地 OCR 调用：
   *  - 外部侧车模式（disabled）：直接执行 fn()，行为同改造前。
   *  - 托管模式：确保侧车就绪 → 执行 fn()（期间标记 active，回收被跳过）→ 刷新 lastUsed。
   *  - 启动失败返回 null，由调用方降级处理。
   */
  async withSidecar<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.disabled) return fn()
    if (!(await this.ensureReady())) return null
    this.active++
    try {
      const r = await fn()
      this.lastUsed = Date.now()
      return r
    } finally {
      this.active--
    }
  }

  /** 立即停止侧车（手动 / 信号 / 资源回收共用）。 */
  stop(reason = 'manual'): void {
    this.intentionalStop = true
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    const c = this.child
    if (c && !c.killed) {
      const pid = c.pid
      if (pid === undefined) {
        this.child = null
        console.log(`[sidecar] 已停止（${reason}）`)
        return
      }
      try {
        c.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      // 兜底升级：uvicorn 优雅关闭可能挂住（Paddle 推理线程/非守护线程不退），
      // 3s 后仍存活则强杀——否则会留下 orphan 占住端口，后续 spawn 全部绑不上
      // （实测踩过：探针 stop 后 python 存活占 9301，下一轮 A/B 全量假死）。
      setTimeout(() => {
        try {
          process.kill(pid, 0) // 仍存活？
          process.kill(pid, 'SIGKILL')
          console.warn(`[sidecar] 优雅关闭超时，已强杀 pid=${pid}`)
        } catch {
          /* 已正常退出 */
        }
      }, 3000).unref?.()
    }
    this.child = null
    console.log(`[sidecar] 已停止（${reason}）`)
  }

  /** 测试/诊断用：返回当前状态快照。 */
  getState() {
    return {
      disabled: this.disabled,
      running: !!(this.child && !this.child.killed),
      active: this.active,
      pid: this.child?.pid ?? null,
      lastUsed: this.lastUsed,
      baseUrl: this.cfg.baseUrl,
      telemetry: this.telemetry.snapshot(),
    }
  }

  /** 调试/监控用：返回埋点快照。 */
  getTelemetry() {
    return this.telemetry
  }
}

let singleton: SidecarSupervisor | null = null
export function getSidecarSupervisor(): SidecarSupervisor {
  if (!singleton) singleton = new SidecarSupervisor()
  return singleton
}
