import * as fs from 'fs'
import * as path from 'path'
import { SidecarSupervisor } from './sidecar.supervisor'
import { toolOcr } from './ocr-tool'
import {
  type OcrTelemetry,
  type OcrAlertSink,
  OcrHealthProbe,
  getOcrTelemetry,
  getOcrAlertSink,
} from './ocr-health'

/**
 * PaddleOCR 3.x 侧车客户端（PP-StructureV3 全链路：UVDoc 矫正 + 版面 + OCR + 阅读序）
 *
 * 定位：**生产主 OCR 引擎**（2026-10-15 起，替换 2.x LocalOcrClient）。
 *   - OcrService 的生产识别路径（recognizeLocalByUrls / recognizePageRegions）走本客户端
 *   - 2.x 侧车（LocalOcrClient, :9300）与 main.py 降级为回滚备份，生产代码不再引用
 *
 * 设计原则（与 LocalOcrClient 一致）：
 *   - 任何失败返回 null，绝不抛错，交由调用方决定降级
 *   - 懒启动守护进程（SidecarSupervisor 复用：空闲回收 + 健康自愈 + SIGKILL 兜底）
 *   - 3.x 管线 CPU 单页 ~19s（2.x 逐块 OCR 一页可达 26min），超时默认 180s
 *   - 工具式隔离调用（parseByBase64）：每次独立子进程，崩/卡只影响当次（沿用 2.x 架构）
 *
 * 坐标保真：生产侧车默认 PPSV3_UNWARP=0 / PPSV3_ORIENT_CLS=0（见 getPpsv3Supervisor）——
 * 错题提取的 box 要与彩色笔迹掩膜在原图坐标系上匹配，矫正/朝向分类会改变输出几何。
 * 摆正（UVDoc）诉求另起专用实例（PPSV3_UNWARP=1，独立端口），不与 OCR 实例混用。
 */

export interface Ppsv3Block {
  label: string | null
  bbox: [number, number, number, number]
  order: string | null
  num_lines: number | null
  content: string
}

export interface Ppsv3TextRegion {
  text: string
  box: number[] | null
  /** 检测四边形四点 [[x,y]×4]（PP-OCRv5 dt_polys）：文本行倾斜度的可靠度量 */
  quad: [number, number][] | null
  score: number | null
}

export interface Ppsv3Result {
  blocks: Ppsv3Block[]
  block_count: number
  text_regions: Ppsv3TextRegion[]
  angle: number | null
  width: number | null
  height: number | null
  rectified_image_base64?: string
  elapsed_ms: number
  engine: string
  paddle_version: string | null
}

export interface Ppsv3ClientOptions {
  baseUrl?: string
  timeoutMs?: number
  telemetry?: OcrTelemetry
  alertSink?: OcrAlertSink
  autoProbe?: boolean
  probeIntervalMs?: number
  probeFailThreshold?: number
}

/** 3.x 引擎 python：优先项目内持久化 venv（.venv-py，沙箱重置不丢）→ 旧 /opt venv → 系统 python3。
 *  常量保留函数形式：Supervisor 构造在模块加载期执行，需即时探测文件系统。 */
function defaultPpsv3Python(): string {
  const candidates = [
    '/workspace/projects/.venv-py/bin/python',
    '/opt/pocr3-venv/bin/python'
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return 'python3'
}
const DEFAULT_PPSV3_PYTHON = defaultPpsv3Python()

/** 告警节流：同事件 60s 内只报一次（parse 失败可能每次请求都触发，防 webhook 风暴） */
const alertCooldown = new Map<string, number>()
function throttledAlert(sink: OcrAlertSink, event: string, detail: Record<string, unknown>): void {
  const now = Date.now()
  const last = alertCooldown.get(event) ?? 0
  if (now - last < 60_000) return
  alertCooldown.set(event, now)
  sink.alert(event, detail)
}

function resolveMain3Script(): string {
  const candidates = [
    process.env.PPSV3_ENGINE_DIR && path.join(process.env.PPSV3_ENGINE_DIR, 'main3.py'),
    path.resolve(__dirname, '../../../ocr-engine/main3.py'),
    path.resolve(process.cwd(), 'ocr-engine/main3.py'),
    path.resolve(process.cwd(), '../ocr-engine/main3.py'),
  ].filter(Boolean) as string[]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return candidates[0] ?? ''
}

export class Ppsv3Client {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly telemetry: OcrTelemetry
  private readonly alertSink: OcrAlertSink
  private readonly probe: OcrHealthProbe | null
  /** 最近一次 parse 失败原因（成功时清空）——上层区分「侧车故障」与「图中无文字」用 */
  private lastParseError: string | null = null

  constructor(opts: Ppsv3ClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.PPSV3_URL ?? 'http://127.0.0.1:9301'
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.PPSV3_TIMEOUT_MS ?? 180_000)
    this.telemetry = opts.telemetry ?? getOcrTelemetry()
    this.alertSink = opts.alertSink ?? getOcrAlertSink()
    const autoProbe = opts.autoProbe ?? (process.env.PPSV3_AUTO_PROBE ?? 'false') !== 'false'
    if (autoProbe) {
      this.probe = new OcrHealthProbe({
        probe: () => this.health(),
        intervalMs: opts.probeIntervalMs ?? Number(process.env.PPSV3_HEALTH_PROBE_MS ?? 60_000),
        failThreshold: opts.probeFailThreshold ?? Number(process.env.PPSV3_HEALTH_FAILS ?? 3),
        alertSink: this.alertSink,
        telemetry: this.telemetry,
        label: `ppsv3:${this.baseUrl}`,
      })
    } else {
      this.probe = null
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * 全链路解析。输入三选一：base64 / url / 本地路径。
   * 失败（未启动/超时/非 200/解析异常）一律返回 null。
   */
  async parse(input: { image_base64?: string; image_url?: string; image_path?: string }, returnImage = false): Promise<Ppsv3Result | null> {
    try {
      const res = await fetch(`${this.baseUrl}/ppsv3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, return_image: returnImage }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200)
        this.lastParseError = `侧车 /ppsv3 返回 HTTP ${res.status}${body ? `：${body}` : ''}`
        return null
      }
      const data = (await res.json()) as Ppsv3Result
      if (!data || !Array.isArray(data.blocks)) {
        this.lastParseError = '侧车 /ppsv3 响应缺少 blocks 字段（版本不匹配或进程异常）'
        return null
      }
      this.lastParseError = null
      return data
    } catch (e) {
      // 侧车不可达/超时：静默返回 null 是降级链的设计，但必须留痕——
      // 否则"侧车挂了、OCR 全空"在日志里与"正常识别无文字"完全同形（#150 用户报障根因即此）。
      this.lastParseError = `侧车请求失败：${String((e as Error)?.message ?? e)}`
      this.telemetry.markDegrade('unreachable')
      throttledAlert(this.alertSink, 'sidecar-unreachable', {
        baseUrl: this.baseUrl,
        error: String((e as Error)?.message ?? e),
      })
      return null
    }
  }

  /** 最近一次 parse 失败原因（无失败为 null）。注意：200 + blocks:[] 是「图中无文字」，不算失败。 */
  getLastParseError(): string | null {
    return this.lastParseError
  }

  /**
   * 仅 UVDoc 矫正（摆正链路专用，返回矫正后图 base64 + 尺寸）。
   * 端点用独立 UVDoc 轻量单例，与生产 PPSV3_UNWARP=0 坐标保真解耦——恒定真正矫正。
   */
  async rectify(input: { image_base64?: string; image_url?: string; image_path?: string }): Promise<{ rectified_image_base64: string; width: number; height: number; elapsed_ms: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/ppsv3/rectify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { rectified_image_base64?: string; width?: number; height?: number; elapsed_ms?: number }
      if (!data?.rectified_image_base64) return null
      return {
        rectified_image_base64: data.rectified_image_base64,
        width: data.width ?? 0,
        height: data.height ?? 0,
        elapsed_ms: data.elapsed_ms ?? 0,
      }
    } catch {
      return null
    }
  }

  /**
   * ④（#143）PaddleOCR-VL 手写答案识别：错题块裁图 → 文本。
   *
   * 与 parse（PP-OCRv5）的区别：VL 是 0.9B 文档解析 VLM，对「题干印刷 + 学生手写
   * 答案 + 红笔订正」混合内容更强；但内存峰值 >8GB（CPU 推理），由 Node 侧
   * OCR_VL_HANDWRITE 门控（默认关）。端点加载失败/超时返回 null，调用方回落 v5。
   *
   * 走长驻服务 HTTP（同 rectify）：VL 模型加载 ~1.8GB，工具式子进程每次重载不可接受。
   */
  async vlParse(input: { image_base64?: string; image_url?: string; image_path?: string }): Promise<{ text: string; elapsed_ms: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/vl/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { text?: string; elapsed_ms?: number }
      if (typeof data?.text !== 'string') return null
      return { text: data.text.trim(), elapsed_ms: data.elapsed_ms ?? 0 }
    } catch {
      return null
    }
  }

  /**
   * 工具式隔离调用（进程隔离 + 硬超时）：每次 OCR 独立子进程跑 main3.py --once，
   * 崩/卡只影响当次、下条全新进程自动恢复（沿用 2.x recognizeByBase64 的架构）。
   *
   * 用于 recognizePageRegions（全页 OCR，任意用户图，崩溃风险面最大）；
   * URL 批量路径（recognizeLocalByUrls）走长驻服务 HTTP（见 parse）。
   */
  async parseByBase64(b64: string): Promise<Ppsv3Result | null> {
    const raw = b64.includes(',') ? b64.split(',', 1)[1] : b64
    const r = await toolOcr(Buffer.from(raw, 'base64'), { op: 'ppsv3', engine: 'ppsv3', timeoutMs: this.timeoutMs })
    if (r.ok && r.data) {
      this.telemetry.markSuccess()
      return r.data as unknown as Ppsv3Result
    }
    this.telemetry.markDegrade(`tool_${r.reason ?? 'failed'}`)
    return null
  }

  /** 启动主动健康探针（定时探活 + 连续失败告警）。幂等。 */
  startProbe(): void {
    this.probe?.start()
  }

  stopProbe(): void {
    this.probe?.stop()
  }
}

// ---------- 3.x 侧车守护进程（复用 SidecarSupervisor，第二实例） ----------

let ppsv3Supervisor: SidecarSupervisor | null = null

/**
 * 3.x 侧车守护单例。配置来源：
 *   PPSV3_URL          默认 http://127.0.0.1:9301
 *   PPSV3_PYTHON       默认 /opt/pocr3-venv/bin/python（隔离 venv，paddlepaddle ≤3.2.2）
 *   PPSV3_SUPERVISE    auto（默认，脚本+python 可用才托管）| 1 | 0
 *   PPSV3_IDLE_TIMEOUT_MS  默认 15min（3.x 管线驻留 ~2-3GB，空闲及时回收）
 *
 * 坐标保真默认值（生产安全）：PPSV3_UNWARP / PPSV3_ORIENT_CLS 未显式设置时注入 '0'——
 * OCR 产物的 box 必须留在输入图坐标系（与彩色笔迹掩膜匹配）；UVDoc/朝向分类改变几何即错位。
 * 摆正流程的 UVDoc 矫正诉求走 /ppsv3/rectify 端点（独立 UVDoc 轻量单例，同进程共存，
 * 与该开关无关），见 image-rectify.ts。
 */
export function getPpsv3Supervisor(): SidecarSupervisor {
  if (!ppsv3Supervisor) {
    const raw = process.env.PPSV3_URL ?? 'http://127.0.0.1:9301'
    const m = raw.match(/^https?:\/\/([^:/]+)(?::(\d+))?/)
    const host = m?.[1] ?? '127.0.0.1'
    const port = m?.[2] ? Number(m[2]) : 9301
    const engineEnv: Record<string, string> = {}
    for (const k of ['PPSV3_UNWARP', 'PPSV3_ORIENT_CLS']) {
      engineEnv[k] = process.env[k] ?? '0'
    }
    ppsv3Supervisor = new SidecarSupervisor({
      script: resolveMain3Script(),
      python: process.env.PPSV3_PYTHON ?? DEFAULT_PPSV3_PYTHON,
      host,
      port,
      supervise: (process.env.PPSV3_SUPERVISE as '1' | '0' | 'auto' | undefined) ?? 'auto',
      idleTimeoutMs: Number(process.env.PPSV3_IDLE_TIMEOUT_MS ?? 15 * 60 * 1000),
      engineEnv,
    })
  }
  return ppsv3Supervisor
}

let ppsv3Client: Ppsv3Client | null = null
export function getPpsv3Client(): Ppsv3Client {
  if (!ppsv3Client) ppsv3Client = new Ppsv3Client()
  return ppsv3Client
}

/**
 * 带守护的 3.x 调用：确保侧车就绪 → 执行 fn。
 *  - 外部侧车模式（PPSV3_SUPERVISE=0）：直接透传 fn()
 *  - 启动失败返回 null（调用方自行降级，不阻断主链路）
 */
export async function withPpsv3<T>(fn: () => Promise<T>): Promise<T | null> {
  return getPpsv3Supervisor().withSidecar(fn)
}
