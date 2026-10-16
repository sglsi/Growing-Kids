import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

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
    path.resolve(process.cwd(), 'ocr-engine'),
    path.resolve(process.cwd(), '../ocr-engine'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    const p = path.join(dir, scriptName)
    if (fs.existsSync(p)) return { dir, script: p }
  }
  return { dir: candidates[0] ?? '', script: '' }
}

/** 3.x 引擎的 python：隔离 venv（paddlepaddle ≤3.2.2），可用 PPSV3_PYTHON 覆盖。 */
function resolvePython(engine: ToolEngine): string {
  if (engine === 'ppsv3') return process.env.PPSV3_PYTHON ?? '/opt/pocr3-venv/bin/python'
  return process.env.OCR_PYTHON ?? 'python3'
}

export type ToolOcrOp = 'recognize' | 'orient' | 'ppsv3' | 'rectify'

export interface ToolOcrOpts {
  op: ToolOcrOp
  /** both | rapid | paddle；默认 orient→rapid（快），recognize→both（融合提质）。3.x 引擎忽略。 */
  mode?: string
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
}

export function toolOcr(imageBuf: Buffer, opts: ToolOcrOpts): Promise<ToolOcrResult> {
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
    let settled = false
    const done = (r: ToolOcrResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      console.warn(`[ocr-tool] ${opts.op} 超时 ${timeoutMs}ms → SIGKILL 中断（下次全新进程自动恢复）`)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      done(fail('timeout'))
    }, timeoutMs)

    const child = spawn(python, [script, '--once', '--op', opts.op, '--mode', mode], {
      cwd: dir || undefined,
      env: { ...process.env, OCR_ENGINE_MODE: mode },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
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
            done(fail('nonzero-exit'))
            return
          }
          done({ ok: true, data: j, ms: Date.now() - t0 })
          return
        } catch {
          console.warn(`[ocr-tool] ${opts.op} JSON 解析失败: ${payload.slice(0, 120)}`)
          done(fail('bad-json'))
          return
        }
      }
      const lastErr = err.trim().split('\n').pop()?.slice(0, 160) ?? ''
      console.warn(`[ocr-tool] ${opts.op} 退出 code=${code} 且无结果标记${lastErr ? `: ${lastErr}` : ''}`)
      done(fail('nonzero-exit'))
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
