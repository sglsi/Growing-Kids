import { spawn, exec, type ChildProcess } from 'child_process'
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
import { getDiagnoseProbeBuffer } from './diagnose-probe'

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
 *
 * ⭐ 单元模式（D-071，2026-11-16）：配置 `unit`（如 `PPSV3_UNIT=gk-ppsv3`）后，
 *    启停改为 `systemctl start/stop <unit>`，**不再自己 spawn 子进程**。
 *    原因：spawn 出来的子进程与 gk-api 同 cgroup，吃 gk-api.service 的 `MemoryMax=1200M`；
 *    PPSV3 常驻 1.4-1.6G ⇒ 托管必然起不来（D-070 实测）。单元模式下侧车跑在自己
 *    `MemoryMax=2400M` 的 cgroup 里，空闲回收由本守护发 `systemctl stop`，被调用时发
 *    `systemctl start` 并等 `/healthz` 通过——「能回收」与「能起来」同时成立。
 *    代价：需要给运行 gk-api 的用户一条**限定单元名**的 sudoers 免密规则（见 docs/gk-ppsv3.service）。
 */

export type SidecarUnitAction = 'start' | 'stop' | 'restart'
export interface SidecarUnitResult {
  ok: boolean
  out: string
}

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
  /**
   * systemd 单元名。非空 ⇒ **单元模式**：启停走 systemctl，不 spawn 子进程（D-071）。
   * 空字符串 ⇒ 传统 spawn 模式（Windows 本地开发 / 无 systemd 环境）。
   */
  unit: string
  /** 单元控制是否加 `sudo -n`（生产 gk-api 以普通用户 gk 运行，默认 true） */
  unitSudo: boolean
  /** 单元控制命令（测试注入用；生产走 systemctl） */
  unitCmd?: (action: SidecarUnitAction, unit: string) => Promise<SidecarUnitResult>
  /** 启动后是否跑一次探针图把模型烘热（默认 true；PPSV3_WARMUP=0 关闭） */
  warmup: boolean
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
/** 单元模式冷启：Paddle 模型装载 + 绑定端口（生产实测 20-40s，留足余量） */
const DEFAULT_UNIT_START_TIMEOUT_MS = 120 * 1000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 生产实现：`[sudo -n ]systemctl <action> <unit>`。失败不抛错，交由调用方决定降级。 */
function makeSystemctl(unitSudo: boolean) {
  return (action: SidecarUnitAction, unit: string): Promise<SidecarUnitResult> =>
    new Promise((resolve) => {
      const cmd = `${unitSudo ? 'sudo -n ' : ''}systemctl ${action} ${unit}`
      exec(cmd, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve({ ok: !err, out: err ? `${out}${out ? ' | ' : ''}${err.message}` : out })
      })
    })
}


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
  // 单元模式：PPSV3_UNIT（3.x 侧车）/ OCR_UNIT（2.x 侧车）。空=传统 spawn 模式。
  const unit = String(opts?.unit ?? process.env.PPSV3_UNIT ?? process.env.OCR_UNIT ?? '').trim()
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
    // 单元模式冷启要等 Paddle 模型装进内存（生产实测 20-40s），默认 30s 不够 ⇒ 单独给 120s
    startTimeoutMs:
      opts?.startTimeoutMs ??
      (Number(process.env.PPSV3_START_TIMEOUT_MS ?? process.env.OCR_START_TIMEOUT_MS) ||
        (unit ? DEFAULT_UNIT_START_TIMEOUT_MS : DEFAULT_START_TIMEOUT_MS)),
    engineEnv: { ...engineEnv, ...(opts?.engineEnv ?? {}) },
    unit,
    unitSudo: opts?.unitSudo ?? (process.env.PPSV3_UNIT_SUDO ?? '1') !== '0',
    unitCmd: opts?.unitCmd,
    warmup: opts?.warmup ?? ((process.env.PPSV3_WARMUP ?? (unit ? '1' : '0')) !== '0'),
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
  /** 单元模式下的「我让它活着」状态；空闲回收后置 false（下次调用再 start） */
  private unitActive = false
  /** 单元关闭中：期间不重复发 stop、也不计入健康失败 */
  private unitStopping = false
  readonly disabled: boolean
  private readonly telemetry: OcrTelemetry
  private readonly alertSink: OcrAlertSink
  private readonly runUnit: (action: SidecarUnitAction, unit: string) => Promise<SidecarUnitResult>

  constructor(opts?: Partial<SidecarConfig>) {
    this.cfg = buildConfig(opts)
    this.disabled = this.computeDisabled()
    this.telemetry = this.cfg.telemetry
    this.alertSink = this.cfg.alertSink
    this.runUnit = this.cfg.unitCmd ?? makeSystemctl(this.cfg.unitSudo)
    if (!this.disabled) {
      this.monitorTimer = setInterval(() => void this.tick(), this.cfg.monitorMs)
      this.monitorTimer.unref?.()
      // ⚠️ 退出只停「自己 spawn 的子进程」；单元模式下侧车是共享资源，gk-api 重启不该把它带走
      process.once('SIGTERM', () => this.shutdown())
      process.once('SIGINT', () => this.shutdown())
      console.log(
        `[sidecar] 守护已启用：${this.cfg.unit ? `单元模式 unit=${this.cfg.unit}` : 'spawn 模式'}，` +
          `监听 ${this.cfg.baseUrl}，空闲回收 ${Math.round(this.cfg.idleTimeoutMs / 1000)}s` +
          (this.cfg.tightRssBytes > 0
            ? `，资源紧张阈值 ${(this.cfg.tightRssBytes / 1024 / 1024) | 0}MB`
            : '') +
          `，启动等待上限 ${Math.round(this.cfg.startTimeoutMs / 1000)}s`,
      )
      // 单元模式：启动时同步一次真实状态（gk-api 重启时侧车可能正跑着），避免误判为已停
      if (this.cfg.unit) {
        void this.isHealthy().then((ok) => {
          if (ok) {
            this.unitActive = true
            this.lastUsed = Date.now()
            console.log(`[sidecar] 采纳已在运行的单元 ${this.cfg.unit}（/healthz 通过）`)
          }
        })
      }
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
    // 单元模式由 systemd 负责解释器/脚本，本进程不需要脚本或 python 可见
    if (this.cfg.unit) return false
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
    if (this.cfg.unit) return ''
    if (raw === '1') return ''
    if (!this.cfg.script || !fs.existsSync(this.cfg.script)) {
      return `脚本缺失（${this.cfg.script || '未解析到 main.py/main3.py'}）`
    }
    if (!pythonUsable(this.cfg.python)) return `python 不可用（${this.cfg.python}）`
    return ''
  }

  /** 侧车当前是否（我们认为）在跑：单元模式看单元状态，spawn 模式看子进程 */
  private isRunning(): boolean {
    return this.cfg.unit ? this.unitActive : !!(this.child && !this.child.killed)
  }

  /** 空闲休眠中（单元模式 + 已被回收）——健康探针据此不把「睡着」当故障 */
  isSleeping(): boolean {
    return !!this.cfg.unit && !this.unitActive && !this.starting
  }

  /** 当前是否应回收侧车（纯函数，便于测试）。不在使用中、超过容忍窗口即停。 */
  private shouldStop(now: number): { stop: boolean; reason: string } {
    if (!this.isRunning() || this.starting || this.active > 0 || this.unitStopping) {
      return { stop: false, reason: '' }
    }
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
    if (!this.isRunning() || this.starting) return
    // 健康自检：侧车在跑，但 /healthz 连续失败 → 进程可能僵死，自愈 + 告警。
    // 仅在「非启动中、在运行」时判定，避免启动期误报。
    void this.selfCheck()
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
        this.unhealthyCount = 0
        if (this.cfg.unit) {
          // 单元模式自愈：单元不会「僵死」（systemd 管进程），但可能半死（端口在、/healthz 挂）
          // ⇒ 重启单元；失败则置为已停，让下次调用走完整 start 流程
          void this.runUnit('restart', this.cfg.unit).then((r) => {
            if (!r.ok) {
              this.unitActive = false
              console.warn(`[sidecar] 单元重启失败，标记为已停：${r.out.slice(0, 300)}`)
            }
          })
          return
        }
        // spawn 模式自愈：杀掉僵死进程（不标 intentional，允许下次 ensureReady 自动重启）
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

  /**
   * 唤醒后的「真就绪」预热（D-071）：
   * `/healthz` 只证明 FastAPI 起来了，PP-StructureV3 是**首次 /ppsv3 才加载模型**（约 10-20s）。
   * 不预热就报 ready，用户第一次识别的请求会把这段加载时间白等进去。
   * ⇒ 启动后主动喂一张已知文字的探针图，把模型烘进内存再放行。
   * 预热失败只记日志、**不阻断**（侧车仍可用，只是首个真实请求慢）。
   */
  private async warmup(timeoutMs: number): Promise<void> {
    const t0 = Date.now()
    try {
      const res = await fetch(`${this.cfg.baseUrl}/ppsv3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: getDiagnoseProbeBuffer().toString('base64'),
          return_image: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ms = Date.now() - t0
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { block_count?: number } | null
        console.log(
          `[sidecar] 预热完成 ${ms}ms（blocks=${data?.block_count ?? '?'}）——模型已驻留，首个真实请求不再等加载`,
        )
      } else {
        console.warn(`[sidecar] 预热返回 ${res.status}（${ms}ms），模型可能未完全就绪，首次识别会慢一些`)
      }
    } catch (e) {
      console.warn(`[sidecar] 预热未完成（${Date.now() - t0}ms）：${(e as Error)?.message ?? e}`)
    }
  }

  private async start(timeoutMs = this.cfg.startTimeoutMs): Promise<void> {
    if (this.starting) return this.starting
    if (this.isRunning()) return
    // ---- 单元模式：systemctl start + 等 /healthz（子进程归 systemd，不吃 gk-api 的内存上限）----
    if (this.cfg.unit) {
      this.lastUsed = Date.now()
      this.unitStopping = false
      this.starting = (async () => {
        const r = await this.runUnit('start', this.cfg.unit)
        // start 失败仍可能是「已在运行 / 被别的单元占端口」，继续探活判定，交由超时兜底
        if (!r.ok) console.warn(`[sidecar] systemctl start ${this.cfg.unit} 返回失败：${r.out.slice(0, 300)}`)
        const t0 = Date.now()
        const deadline = t0 + timeoutMs
        while (Date.now() < deadline) {
          if (await this.isHealthy()) {
            this.unitActive = true
            console.log(`[sidecar] 单元 ${this.cfg.unit} 端口就绪（${Math.round((Date.now() - t0) / 1000)}s）`)
            // /healthz 只代表 FastAPI 起来了：PP-StructureV3 是**首次调用才加载模型**。
            // 不预热就报 ready，用户第一次识别的请求会把这十几秒白等进去 —— 必须烘热再放行。
            if (this.cfg.warmup) await this.warmup(Math.min(timeoutMs, 120_000))
            return
          }
          await sleep(500)
        }
        throw new Error(
          `侧车启动超时（${this.cfg.unit} 未在 ${Math.round(timeoutMs / 1000)}s 内通过 /healthz` +
            `${r.ok ? '' : '；systemctl 报错：' + r.out.slice(0, 200)}）`,
        )
      })().finally(() => {
        this.starting = null
      })
      return this.starting
    }
    // ---- 传统 spawn 模式（Windows 本地开发 / 无 systemd 环境）----
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
        if (await this.isHealthy()) {
          if (this.cfg.warmup) await this.warmup(Math.min(timeoutMs, 120_000))
          return
        }
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
      // 单元模式：端口活着就是活着（可能被别人/上次的我们启动），采纳并刷新使用时间
      if (this.cfg.unit) this.unitActive = true
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

  /**
   * 立即停侧车（资源回收用）。
   * ⚠️ 不再清 monitorTimer：旧实现只在第一次回收后停掉巡检，之后彻底失去回收能力——
   *    「睡下去 → 被叫醒 → 再睡」必须能反复发生，所以巡检常驻，只有 shutdown() 才停。
   */
  stop(reason = 'manual'): void {
    // ---- 单元模式：systemctl stop（异步发、立刻置状态，避免阻塞事件循环）----
    if (this.cfg.unit) {
      if (!this.unitActive || this.unitStopping) {
        this.unitActive = false
        return
      }
      this.unitActive = false
      this.unitStopping = true
      void this.runUnit('stop', this.cfg.unit)
        .then((r) => {
          if (r.ok) console.log(`[sidecar] 已停止单元 ${this.cfg.unit}（${reason}）`)
          else console.warn(`[sidecar] 停止单元 ${this.cfg.unit} 失败（${reason}）：${r.out.slice(0, 300)}`)
        })
        .finally(() => {
          this.unitStopping = false
        })
      return
    }
    // ---- spawn 模式 ----
    this.intentionalStop = true
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

  /**
   * 进程退出：只收自己的东西。
   * ⚠️ 单元模式下侧车是**共享**资源（运维/其他进程也可能用），gk-api 重启不能把它带走；
   *    停不停由空闲回收与下一次调用决定。spawn 模式仍要杀掉自己的子进程（否则 orphan 占端口）。
   */
  shutdown(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    if (this.cfg.unit) {
      console.log(`[sidecar] 进程退出：保留单元 ${this.cfg.unit} 运行（空闲由回收策略处理）`)
      return
    }
    this.stop('shutdown')
  }

  /** 测试/诊断用：返回当前状态快照。 */
  getState() {
    return {
      disabled: this.disabled,
      mode: this.cfg.unit ? 'unit' : 'spawn',
      unit: this.cfg.unit || null,
      running: this.isRunning(),
      sleeping: this.isSleeping(),
      active: this.active,
      pid: this.child?.pid ?? null,
      lastUsed: this.lastUsed,
      idleTimeoutMs: this.cfg.idleTimeoutMs,
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
