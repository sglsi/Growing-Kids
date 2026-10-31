import { spawn, execFileSync } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import zlib from 'zlib'
import { toGuiPython, pythonEnv, decodeEngineChunk } from './python-gui'

/**
 * OCR 工具式调用器（进程隔离，治「侧车崩溃/卡死」）
 *
 * 背景：成熟 OCR 引擎（RapidOCR/PaddleOCR）本身稳定，崩溃/卡死几乎都源于「长驻服务 + 共享模型
 * 实例 + 无法被安全中断的推理」——并发访问 ONNX 会段错误；一段卡死的推理会把全局锁/线程池堵死，
 * 拖垮所有后续请求。工具式调用把每次 OCR 变成独立子进程：
 *   · 崩溃/卡死只影响当次，下一条全新进程自动恢复，绝不级联；
 *   · 调用方可用硬超时 + SIGKILL 强制中断（共享服务里一段卡死的推理无法安全中断）；
 *   · 无跨请求共享状态，天然规避 ONNX 并发段错误。
 *
 * 契约：图片字节走 stdin（避免 base64 超命令行长度）；结果以 `<<<OCR_RESULT>>>` 哨兵单行 JSON
 * 打到 stdout；任何失败（spawn 失败/非零退出/超时/JSON 损坏）都返回 null，交由上层降级，绝不抛错。
 *
 * 常驻预热进程（2026-10 新增）：「快速识别」每次都冷加载 RapidOCR 模型（实测 ~12s）。对
 * `engine==='legacy' && op==='recognize' && mode==='rapid'` 这一高频路径，改用单例常驻进程
 * （main.py --loop）：模型仅预热一次，后续请求走 stdin/stdout 帧式协议串行处理，首次识别即从
 * ~12s 降到纯推理耗时（数秒）。详见文件末尾的 PersistentOcr。
 */

const MARKER = '<<<OCR_RESULT>>>'

/** 工具式调用的目标引擎：legacy=2.x 融合侧车（main.py，系统 python3）；ppsv3=3.x 生产引擎（main3.py，venv python）。 */
export type ToolEngine = 'legacy' | 'ppsv3'

function resolveEngine(engine: ToolEngine = 'legacy'): { dir: string; script: string } {
  const scriptName = engine === 'ppsv3' ? 'main3.py' : 'main.py'
  const candidates = [
    process.env.OCR_ENGINE_DIR,
    process.env.PPSV3_ENGINE_DIR,
    path.resolve(__dirname, '../../../ocr-engine'),
    // ⭐ 部署包内嵌：deploy-pack.mjs 会把仓库根 ocr-engine/ 复制进 server/ocr-engine/ 一起上传，
    //    避免「只传 server/ 导致 /ocr-engine 脚本缺失、OCR 全挂」（问题③）。
    path.resolve(__dirname, '../../ocr-engine'),
    path.resolve(process.cwd(), 'ocr-engine'),
    path.resolve(process.cwd(), '../ocr-engine'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    const p = path.join(dir, scriptName)
    if (fs.existsSync(p)) return { dir, script: p }
  }
  return { dir: candidates[0] ?? '', script: '' }
}

/** 探测某 python 是否能 import 指定模块（结果缓存，避免每次 OCR 都 fork 子进程）。
 *  timeoutMs：paddle 首次 import 在 Windows/冷盘上可达 15~30s，paddle 系探测必须放宽，
 *  否则探测超时被误判为「venv 不可用」而回退到无包的裸 python（工具式调用随即 ModuleNotFound）。 */
const importProbeCache = new Map<string, boolean>()
function pythonCanImport(py: string, mod: string, timeoutMs = 8000): boolean {
  const key = `${py}::${mod}`
  const hit = importProbeCache.get(key)
  if (hit !== undefined) return hit
  let ok = false
  try {
    execFileSync(toGuiPython(py), ['-c', `import ${mod}`], { timeout: timeoutMs, stdio: 'ignore', windowsHide: true })
    ok = true
  } catch {
    ok = false
  }
  importProbeCache.set(key, ok)
  return ok
}

/** 从候选里挑第一个能 import 全部 requiredModules 的 python；都不行返回 null。 */
function pickUsablePython(
  candidates: string[],
  requiredModules: string[],
  timeoutMs?: number,
): string | null {
  for (const py of candidates) {
    if (!py) continue
    if (requiredModules.every((m) => pythonCanImport(py, m, timeoutMs))) return py
  }
  return null
}

/** 清空 python 导入探测缓存（自愈重启时重探，避开启动期并发/超时造成的误判缓存）。 */
export function resetPythonProbeCache(): void {
  importProbeCache.clear()
}

/**
 * 3.x 引擎的 python：优先项目内持久化 venv（.venv-py，沙箱重置不丢）→ 旧 /opt venv → 系统 python3。
 * Windows 本机：项目根 .venv-py\Scripts\python.exe（与 install-ocr-env.ps1 / ppsv3.client 对齐）。
 * 可用 PPSV3_PYTHON / OCR_VENV_DIR 环境变量覆盖（venv 搬出仓库根后必须设 OCR_VENV_DIR，
 * 否则微信开发者工具监听 3.3 万个文件的 .venv-py 会耗尽文件句柄 EMFILE）。
 * 探测 paddle + paddlex 是否可用，缺包则回退，避免用「存在但损坏」的 venv。
 */
export function resolvePython(engine: ToolEngine): string {
  if (engine === 'ppsv3') {
    const fromEnv = process.env.PPSV3_PYTHON
    if (fromEnv && pythonCanImport(fromEnv, 'paddle')) return fromEnv
    const repoRoot = path.resolve(__dirname, '../../..')
    const ppsv3Candidates =
      process.platform === 'win32'
        ? [
            ...(process.env.OCR_VENV_DIR ? [path.join(process.env.OCR_VENV_DIR, 'Scripts', 'python.exe')] : []),
            path.join(repoRoot, '.venv-py', 'Scripts', 'python.exe'),
            path.join(repoRoot, 'ocr-engine', '.venv', 'Scripts', 'python.exe'),
          ]
        : ['/workspace/projects/.venv-py/bin/python', '/opt/pocr3-venv/bin/python']
    // paddle 系 import 慢（首次 15~30s）：探测超时放宽到 60s，结果有缓存只慢一次
    return (
      pickUsablePython(ppsv3Candidates, ['paddle', 'paddlex'], 60_000) ??
      (process.platform === 'win32' ? 'python' : 'python3')
    )
  }
  // legacy 引擎：RapidOCR 依赖 rapidocr_onnxruntime。部分 /opt venv **未安装该包**，
  // 直接返回会让 main.py 启动即捕获 ImportError → 静默输出空结果（raw_text:""），
  // recognizePageFast 收到空 data 不抛错 → 快速模式「伪成功实为空白」。
  // 故按「持久化 venv → 旧 venv → 系统 python3(三者齐全)」探测，取第一个真能 import 的。
  const repoRoot = path.resolve(__dirname, '../../..')
  const winVenv = [
    ...(process.env.OCR_VENV_DIR ? [path.join(process.env.OCR_VENV_DIR, 'Scripts', 'python.exe')] : []),
    path.join(repoRoot, '.venv-py', 'Scripts', 'python.exe'),
    path.join(repoRoot, 'ocr-engine', '.venv', 'Scripts', 'python.exe'),
  ]
  const legacyCandidates = [
    process.env.OCR_PYTHON,
    ...(process.platform === 'win32' ? winVenv : ['/workspace/projects/.venv-py/bin/python', '/opt/pocr3-venv/bin/python']),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter(Boolean) as string[]
  // rapidocr import 暖 ~0.9s，但后端启动期与 ppsv3 的 paddle 重探测并发/磁盘竞争时可慢数倍——
  // 8s 默认值曾把「能用的 venv」误判成不可用（结果进缓存），随后快速识别全走无包系统
  // python，常驻进程起不来（真机表现「快速识别失效」）。放宽到 30s（有缓存只慢一次）。
  return (
    pickUsablePython(legacyCandidates, ['rapidocr_onnxruntime'], 30_000) ??
    (process.platform === 'win32' ? 'python' : 'python3')
  )
}

export type ToolOcrOp = 'recognize' | 'orient' | 'ppsv3' | 'rectify'

export interface ToolOcrOpts {
  op: ToolOcrOp
  /** both | rapid | paddle；默认 orient→rapid（快），recognize→both（融合提质）。3.x 引擎忽略。 */
  mode?: string
  /** 分栏处理：auto=多栏时自动切分逐栏识别；off=关闭。默认 auto。 */
  layout?: string
  /** 硬超时（毫秒）。超时即 SIGKILL 当中断并返回 null。默认 OCR_TOOL_TIMEOUT_MS 或 120s。 */
  timeoutMs?: number
  python?: string
  /** 目标引擎：legacy=2.x（默认，探针/回滚用）| ppsv3=3.x 生产引擎（main3.py + venv python） */
  engine?: ToolEngine
}

export interface ToolOcrResult {
  ok: boolean
  data: Record<string, unknown> | null
  /** 耗时（毫秒） */
  ms: number
  /** 失败/超时原因（ok=false 时） */
  reason?: 'no-script' | 'timeout' | 'spawn-error' | 'nonzero-exit' | 'bad-json' | 'empty'
  /** 子进程 stderr 摘录（最后几行，≤300 字符）——引擎崩溃/缺依赖时上层要能拿到真实原因 */
  stderr?: string
}

/**
 * ppsv3 并发闸门（串行排队，不拒绝）。
 *
 * 每次 `--once` 都是全新 python 进程，峰值 RSS 实测：3.3.1 关 oneDNN ≈1333MB、
 * **3.2.2 开 oneDNN ≈1790MB**。生产机总内存 3723MB，两路并发 ≈3.6GB ⇒ OOM Killer
 * 出手（会挑最大的进程杀，可能连带打死同 cgroup 的 node）。故 ppsv3 强制串行，
 * 与 rapid 常驻进程的串行队列同思路：单模型实例、排队而非并发。
 *
 * ⚠️ 链尾必须吞掉异常——否则一次失败会让整条 Promise 链变成 rejected，
 *    后续所有请求全部秒失败（典型「一个坏请求冻死整条链路」）。
 */
let ppsv3Chain: Promise<unknown> = Promise.resolve()
function withPpsv3Gate<T>(fn: () => Promise<T>): Promise<T> {
  const run = ppsv3Chain.then(fn, fn)
  ppsv3Chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 一次性工具式调用（每次独立子进程，崩/卡只影响当次，可被硬超时 SIGKILL 中断）。 */
export function toolOcrOnce(imageBuf: Buffer, opts: ToolOcrOpts): Promise<ToolOcrResult> {
  // 仅 ppsv3 受闸门约束；legacy(rapid) 走常驻预热进程，不 spawn 一次性重型进程
  if ((opts.engine ?? 'legacy') !== 'ppsv3') return toolOcrOnceInner(imageBuf, opts)
  return withPpsv3Gate(() => toolOcrOnceInner(imageBuf, opts))
}

function toolOcrOnceInner(imageBuf: Buffer, opts: ToolOcrOpts): Promise<ToolOcrResult> {
  const t0 = Date.now()
  const engine: ToolEngine = opts.engine ?? 'legacy'
  const { dir, script } = resolveEngine(engine)
  // 3.x 引擎的 op 名与 2.x 不同：recognize → ppsv3（PP-StructureV3 全链路）
  const op = engine === 'ppsv3' && opts.op === 'recognize' ? 'ppsv3' : opts.op
  const mode = opts.mode ?? (opts.op === 'orient' ? 'rapid' : 'both')
  // 3.x 单次调用含模型加载（~9s）+ 推理，默认超时放宽到 180s（与 Ppsv3Client 一致）
  const defaultTimeout = engine === 'ppsv3' ? 180_000 : 120_000
  const timeoutMs = opts.timeoutMs ?? Number(process.env.OCR_TOOL_TIMEOUT_MS ?? defaultTimeout)
  const python = opts.python ?? resolvePython(engine)
  const fail = (reason: ToolOcrResult['reason']): ToolOcrResult => ({ ok: false, data: null, ms: Date.now() - t0, reason })

  if (!script) return Promise.resolve(fail('no-script'))
  if (!imageBuf || imageBuf.length === 0) return Promise.resolve(fail('empty'))

  return new Promise<ToolOcrResult>((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    /** stderr 摘录：取最后 3 行拼到 300 字符内（Traceback 的根因行通常在尾部） */
    const errTail = (): string | undefined => {
      const lines = err.trim().split('\n').filter(Boolean)
      if (!lines.length) return undefined
      return lines.slice(-3).join(' | ').slice(-300)
    }
    const done = (r: ToolOcrResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      console.warn(`[ocr-tool] ${opts.op} 超时 ${timeoutMs}ms → SIGKILL 中断（下次全新进程自动恢复）`)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      done({ ok: false, data: null, ms: Date.now() - t0, reason: 'timeout', stderr: errTail() })
    }, timeoutMs)

    // ⚠️ 两个引擎的 CLI 契约**不同**，必须分开拼参：
    //   2.x legacy（main.py）：--once --op recognize|orient --mode --layout auto|off
    //   3.x ppsv3（main3.py）：--once --op ppsv3|rectify|orient|vl --mode（**没有 --layout**）
    // 之前统一按 2.x 拼：① 传了 --layout → 3.x argparse 报
    //   `unrecognized arguments: --layout auto` → exit 2 → 朝向检测（orient）全程失败；
    // ② 上面算好的 op 映射（recognize→ppsv3）没用上，仍传 `recognize`
    //   → 3.x 的 choices 不含它 → 一样 exit 2。
    const args = [script, '--once', '--op', op, '--mode', mode]
    if (engine === 'legacy') args.push('--layout', opts.layout ?? 'auto')
    const child = spawn(toGuiPython(python), args, {
      cwd: dir || undefined,
      env: pythonEnv({ OCR_ENGINE_MODE: mode }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // Windows：禁掉 python 子进程的控制台窗口（用户实测被闪扰）
    })

    child.stdout.on('data', (d) => { out += decodeEngineChunk(d) })
    child.stderr.on('data', (d) => { err += decodeEngineChunk(d) })
    // stdin 写入失败（子进程已退出）不应崩溃：吞掉 EPIPE
    child.stdin.on('error', () => { /* ignore */ })

    child.on('error', (e) => {
      console.warn(`[ocr-tool] spawn 失败: ${(e as Error)?.message ?? e}`)
      done(fail('spawn-error'))
    })

    child.on('close', (code) => {
      const idx = out.lastIndexOf(MARKER)
      if (idx >= 0) {
        const payload = out.slice(idx + MARKER.length).trim()
        try {
          const j = JSON.parse(payload) as Record<string, unknown>
          if (j && typeof j.error === 'string') {
            console.warn(`[ocr-tool] ${opts.op} 子进程报错: ${j.error}`)
            done({ ok: false, data: null, ms: Date.now() - t0, reason: 'nonzero-exit', stderr: String(j.error).slice(0, 300) })
            return
          }
          done({ ok: true, data: j, ms: Date.now() - t0 })
          return
        } catch {
          console.warn(`[ocr-tool] ${opts.op} JSON 解析失败: ${payload.slice(0, 120)}`)
          done({ ok: false, data: null, ms: Date.now() - t0, reason: 'bad-json', stderr: payload.slice(0, 300) })
          return
        }
      }
      const lastErr = err.trim().split('\n').pop()?.slice(0, 160) ?? ''
      console.warn(`[ocr-tool] ${opts.op} 退出 code=${code} 且无结果标记${lastErr ? `: ${lastErr}` : ''}`)
      done({ ok: false, data: null, ms: Date.now() - t0, reason: 'nonzero-exit', stderr: errTail() ?? `exit code ${code}` })
    })

    // 图片字节走 stdin
    try {
      child.stdin.write(imageBuf)
      child.stdin.end()
    } catch (e) {
      console.warn(`[ocr-tool] stdin 写入失败: ${(e as Error)?.message ?? e}`)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      done(fail('spawn-error'))
    }
  })
}

/** 是否启用工具式调用（默认启用；OCR_INVOKE=server 可切回长驻服务模式）。 */
export function toolInvokeEnabled(): boolean {
  return (process.env.OCR_INVOKE ?? 'tool') !== 'server'
}

// ============================ 常驻预热进程（快速识别优化） ============================
// 单例常驻进程：模型仅预热一次，后续请求走 stdin/stdout 帧式协议串行处理，
// 首次识别即从 ~12s 降到纯推理耗时（数秒）。具备：
//  - 串行队列：单进程单模型实例，天然规避 ONNX 并发段错误（见文件头）；
//  - 看门狗：单请求超时即强杀并重 Spawn，失败不级联；
//  - 自动回落：Spawn 失败/环境缺包时，把在途请求转一次性调用（toolOcrOnce），保证可用；
//  - 启动预热：warmupFastOcr() 在后端 bootstrap 调用，不阻塞服务启动。
//
// 协议（与 main.py --loop 对应）：
//   Node → Python：4 字节大端图片长度 N + N 字节图片；
//   Python → Node：单行 `<<<OCR_RESULT>>>` + 紧凑 JSON + '\n'（紧凑 JSON 无内嵌换行，按行切分）。

const LOOP_READY = '<<<OCR_READY>>>'

/** 生成一张极小的纯色 PNG（无文字）：仅供常驻进程启动预热时触发 ONNX 计算图首次编译，结果忽略。 */
function makeWarmupImage(): Buffer {
  const S = 160
  // 每行：1 字节 filter(0) + S*3 字节 RGB
  const raw = Buffer.alloc(S * (S * 3 + 1))
  for (let y = 0; y < S; y++) {
    raw[y * (S * 3 + 1)] = 0
    for (let x = 0; x < S; x++) {
      const o = y * (S * 3 + 1) + 1 + x * 3
      raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255
    }
  }
  const idat = zlib.deflateSync(raw)
  const crc32 = (buf: Buffer): number => {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const tb = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0, 0)
    return Buffer.concat([len, tb, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface PendingReq {
  buf: Buffer
  timeoutMs: number
  t0: number
  resolve: (r: ToolOcrResult) => void
}

interface InFlight {
  resolve: (r: ToolOcrResult) => void
  t0: number
  timer: NodeJS.Timeout | null
}

class PersistentOcr {
  private child: ChildProcessWithoutNullStreams | null = null
  private alive = false
  private starting = false
  private startPromise: Promise<boolean> | null = null
  private readyResolve: ((ok: boolean) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private buf = ''
  private queue: PendingReq[] = []
  private inFlight: InFlight | null = null
  private lastSpawnFail = 0
  private readonly warmupTimeoutMs = 60_000
  private warmed = false
  private warmupImg: Buffer | null = null

  constructor(private readonly python: string, private readonly script: string, private readonly cwd: string) {}

  /** 启动预热（不阻塞）。失败静默，后续请求会回落一次性调用。 */
  warmup(): void {
    if (this.alive || this.child || this.starting) return
    void this.startChild()
  }

  /** 启动（如未起）并等待就绪；失败/超时返回 false（自愈重试路径用）。 */
  ensureReady(): Promise<boolean> {
    if (this.alive) return Promise.resolve(true)
    if (this.starting || this.child) return this.startPromise ?? Promise.resolve(false)
    return this.startChild()
  }

  /** 用常驻进程识别一张图（fast 路径）。串行处理，单请求超时则强杀重 Spawn。 */
  recognize(buf: Buffer, timeoutMs: number): Promise<ToolOcrResult> {
    return new Promise<ToolOcrResult>((resolve) => {
      this.queue.push({ buf, timeoutMs, t0: Date.now(), resolve })
      this.pump()
    })
  }

  /** 服务关闭时清理常驻进程。 */
  shutdown(): void {
    this.killChild()
  }

  private pump(): void {
    if (this.inFlight) return
    if (this.queue.length === 0) return
    if (!this.alive || !this.child) {
      if (!this.starting && !this.child) void this.startChild()
      return
    }
    const next = this.queue.shift()!
    this.inFlight = { resolve: next.resolve, t0: next.t0, timer: null }
    try {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(next.buf.length, 0)
      this.child.stdin.write(header)
      this.child.stdin.write(next.buf)
    } catch (e) {
      this.inFlight = null
      next.resolve({
        ok: false,
        data: null,
        ms: Date.now() - next.t0,
        reason: 'spawn-error',
        stderr: String((e as Error)?.message ?? e),
      })
      this.onDeath('stdin 写入失败')
      this.pump()
      return
    }
    this.inFlight.timer = setTimeout(() => {
      console.warn(`[persistent-ocr] 识别超时 ${next.timeoutMs}ms → 强杀并重 Spawn`)
      this.killChild()
      if (this.inFlight) {
        this.inFlight.resolve({ ok: false, data: null, ms: Date.now() - this.inFlight.t0, reason: 'timeout' })
        this.inFlight = null
      }
      this.pump()
    }, next.timeoutMs)
  }

  private startChild(): Promise<boolean> {
    if (this.starting) return this.startPromise ?? Promise.resolve(false)
    // 近期 spawn 失败（环境缺包/venv 损坏）：直接回落一次性调用，避免反复尝试
    if (Date.now() - this.lastSpawnFail < 60_000) {
      this.dumpQueueToFallback()
      return Promise.resolve(false)
    }
    this.starting = true
    const p = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(toGuiPython(this.python), [this.script, '--loop', '--op', 'recognize', '--mode', 'rapid', '--layout', 'auto'], {
          cwd: this.cwd || undefined,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: pythonEnv({ OCR_ENGINE_MODE: 'rapid' }),
          windowsHide: true, // Windows：禁掉常驻 sidecar 的控制台窗口（用户实测被闪扰）
        })
      } catch (e) {
        console.warn(`[persistent-ocr] Spawn 失败: ${(e as Error)?.message ?? e}`)
        this.lastSpawnFail = Date.now()
        this.starting = false
        resolve(false)
        return
      }
      this.child = child
      this.buf = ''
      this.alive = false
      child.stdout.on('data', (d: Buffer) => this.onStdout(decodeEngineChunk(d)))
      child.stderr.on('data', () => { /* 引擎日志忽略 */ })
      child.on('error', (e) => console.warn(`[persistent-ocr] 子进程错误: ${(e as Error)?.message ?? e}`))
      child.on('exit', (code) => {
        if (!this.alive) {
          this.lastSpawnFail = Date.now()
          this.dumpQueueToFallback()
        }
        this.onDeath(`exit code ${code}`)
      })
      this.readyTimer = setTimeout(() => {
        console.warn('[persistent-ocr] 预热超时（60s 未就绪）→ 回落一次性调用')
        this.lastSpawnFail = Date.now()
        this.killChild()
        this.dumpQueueToFallback()
        this.resolveReady(false)
      }, this.warmupTimeoutMs)
    })
    this.startPromise = p
    void p.then(() => { this.startPromise = null })
    return p
  }

  private resolveReady(ok: boolean): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.starting = false
    const r = this.readyResolve
    this.readyResolve = null
    if (r) r(ok)
  }

  private onStdout(s: string): void {
    this.buf += s
    // 先找就绪信号（模型预热完成）
    if (!this.alive) {
      const ri = this.buf.indexOf(LOOP_READY)
      if (ri >= 0) {
        this.alive = true
        this.buf = this.buf.slice(ri + LOOP_READY.length)
        console.log('[persistent-ocr] 快速识别常驻进程就绪（模型已预热，后续识别免冷加载）')
        this.resolveReady(true)
        // 再补一次空图推理，把 ONNX 计算图首次编译也挪到启动期付掉，
        // 避免首个真实请求额外承担 ~4s 编译开销（结果忽略）。
        if (!this.warmed) {
          this.warmed = true
          try {
            if (!this.warmupImg) this.warmupImg = makeWarmupImage()
            void this.recognize(this.warmupImg, 30_000)
          } catch (e) {
            console.warn(`[persistent-ocr] 空图预热失败（非致命，首个请求将承担编译开销）: ${(e as Error)?.message ?? e}`)
          }
        }
        this.pump()
      }
    }
    // 再处理已收完整的结果行（每行一个）
    let ni: number
    while ((ni = this.buf.indexOf(MARKER)) >= 0) {
      const after = ni + MARKER.length
      const nl = this.buf.indexOf('\n', after)
      if (nl < 0) break // 结果行未收完，等下次
      const payload = this.buf.slice(after, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      this.onResult(payload)
    }
  }

  private onResult(payload: string): void {
    const req = this.inFlight
    if (!req) return // 没有在途请求却收到结果，丢弃
    if (req.timer) clearTimeout(req.timer)
    let result: ToolOcrResult
    try {
      const j = JSON.parse(payload) as Record<string, unknown>
      if (j && typeof j.error === 'string') {
        result = { ok: false, data: null, ms: Date.now() - req.t0, reason: 'nonzero-exit', stderr: String(j.error).slice(0, 300) }
      } else {
        result = { ok: true, data: j, ms: Date.now() - req.t0 }
      }
    } catch {
      result = { ok: false, data: null, ms: Date.now() - req.t0, reason: 'bad-json', stderr: payload.slice(0, 300) }
    }
    this.inFlight = null
    req.resolve(result)
    this.pump()
  }

  /** 环境不可用：把在途请求全转一次性调用，保证可用性（性能回落而非功能失效）。 */
  private dumpQueueToFallback(): void {
    while (this.queue.length) {
      const n = this.queue.shift()!
      void toolOcrOnce(n.buf, {
        op: 'recognize',
        engine: 'legacy',
        mode: 'rapid',
        timeoutMs: n.timeoutMs,
        python: this.python,
      }).then((r) => n.resolve(r))
    }
  }

  private onDeath(reason: string): void {
    console.warn(`[persistent-ocr] 常驻进程退出：${reason}`)
    if (this.child) {
      try {
        this.child.stdout.removeAllListeners()
        this.child.stderr.removeAllListeners()
      } catch { /* ignore */ }
    }
    this.child = null
    this.alive = false
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.inFlight) {
      const inf = this.inFlight
      this.inFlight = null
      if (inf.timer) clearTimeout(inf.timer)
      inf.resolve({ ok: false, data: null, ms: Date.now() - inf.t0, reason: 'spawn-error', stderr: reason })
    }
    this.resolveReady(false)
    this.pump()
  }

  private killChild(): void {
    if (!this.child) return
    try { this.child.stdin.end() } catch { /* ignore */ }
    try { this.child.kill('SIGKILL') } catch { /* ignore */ }
    this.child = null
    this.alive = false
  }
}

let persistent: PersistentOcr | null = null

function getPersistent(): PersistentOcr | null {
  if (persistent) return persistent
  const engine = resolveEngine('legacy')
  if (!engine.script) return null
  const python = resolvePython('legacy')
  persistent = new PersistentOcr(python, engine.script, engine.dir)
  return persistent
}

/** 启动预热快速识别常驻进程（后端 bootstrap 调用，不阻塞）。 */
export function warmupFastOcr(): void {
  getPersistent()?.warmup()
}

/** 服务关闭时释放常驻进程。 */
export function shutdownFastOcr(): void {
  persistent?.shutdown()
  persistent = null
}

/**
 * 快速引擎自愈（思傅 2026-10-25 要求：「引擎没在运行状态，就应当启动该引擎并进行识别，
 * 而不是返回错误信息」）：杀常驻进程 → 清 python 导入探测缓存 → 按当前环境重解析
 * python → 重启并等待就绪。
 *
 * 治本场景：后端启动期探测被并发/磁盘竞争拖垮，把「无包的宿主 python」误判为可用并
 * 缓存——之后常驻进程每次 Spawn 即 ModuleNotFound 退出，快速识别持续失效。
 * 重启时清缓存重探（热路径）会命中含 rapidocr/fastapi 的 OCR venv。
 */
export async function restartFastOcr(): Promise<boolean> {
  shutdownFastOcr()
  resetPythonProbeCache()
  const p = getPersistent()
  if (!p) return false
  return p.ensureReady()
}

/** 快速识别（legacy + recognize + rapid）：走常驻预热进程，冷加载成本仅付一次。 */
function fastOcrRecognize(buf: Buffer, timeoutMs: number): Promise<ToolOcrResult> {
  const p = getPersistent()
  if (!p) return toolOcrOnce(buf, { op: 'recognize', engine: 'legacy', mode: 'rapid', timeoutMs, python: resolvePython('legacy') })
  return p.recognize(buf, timeoutMs)
}

/** 统一入口：快速识别高频路径走常驻进程，其余（orient/ppsv3/非 rapid）走一次性调用。 */
export function toolOcr(imageBuf: Buffer, opts: ToolOcrOpts): Promise<ToolOcrResult> {
  if (opts.engine === 'legacy' && opts.op === 'recognize' && (opts.mode ?? 'both') === 'rapid') {
    return fastOcrRecognize(imageBuf, opts.timeoutMs ?? Number(process.env.OCR_TOOL_TIMEOUT_MS ?? 120_000))
  }
  return toolOcrOnce(imageBuf, opts)
}
