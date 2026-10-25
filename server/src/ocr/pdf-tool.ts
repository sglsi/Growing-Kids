/**
 * PDF/DOCX 内容提取（#118）——ocr-engine/pdf_tool.py 的 Node 封装。
 *
 * 背景：recognizeDoc 此前把 PDF 二进制当文本喂 FetchClient → 10 万字符乱码 →
 * 「未识别到题目」（2026-10-25 思傅报障，日志实证）。本工具用 OCR venv 里的
 * pypdfium2 做正确提取：PDF 逐页取文字层，无文字层的扫描页渲染成 PNG（base64）
 * 交后端走既有 OCR 链；DOCX 解 zip 剥 XML。
 *
 * 与 ocr-tool.ts 同一套纪律：toGuiPython（pythonw 防孙进程弹窗）+ windowsHide +
 * 硬超时 SIGKILL + stdout `<<<OCR_RESULT>>>` 标记约定。
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { toGuiPython, pythonEnv, decodeEngineChunk } from './python-gui'

const MARKER = '<<<OCR_RESULT>>>'

/** pdf_tool.py 的位置（与 ocr-tool resolveEngine 同候选序；部署包内嵌 server/ocr-engine/） */
function resolvePdfToolScript(): string {
  const candidates = [
    process.env.OCR_ENGINE_DIR && path.join(process.env.OCR_ENGINE_DIR, 'pdf_tool.py'),
    process.env.PPSV3_ENGINE_DIR && path.join(process.env.PPSV3_ENGINE_DIR, 'pdf_tool.py'),
    path.resolve(__dirname, '../../../ocr-engine/pdf_tool.py'),
    path.resolve(__dirname, '../../ocr-engine/pdf_tool.py'),
    path.resolve(process.cwd(), 'ocr-engine/pdf_tool.py'),
    path.resolve(process.cwd(), '../ocr-engine/pdf_tool.py'),
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return ''
}

/** OCR venv python 候选（pypdfium2 装在 OCR venv，无需 paddle） */
function pythonCandidates(): string[] {
  const repoRoot = path.resolve(__dirname, '../../..')
  const winVenv = [
    ...(process.env.OCR_VENV_DIR ? [path.join(process.env.OCR_VENV_DIR, 'Scripts', 'python.exe')] : []),
    path.join(repoRoot, '.venv-py', 'Scripts', 'python.exe'),
    path.join(repoRoot, 'ocr-engine', '.venv', 'Scripts', 'python.exe'),
  ]
  return [
    process.env.OCR_PYTHON,
    ...(process.platform === 'win32' ? winVenv : ['/workspace/projects/.venv-py/bin/python', '/opt/pocr3-venv/bin/python']),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter(Boolean) as string[]
}

/** 探测某 python 能否 import pypdfium2（结果缓存；pypdfium2 import <1s，超时 8s 足够） */
const probeCache = new Map<string, boolean>()
function canImportPdfium(py: string): boolean {
  const hit = probeCache.get(py)
  if (hit !== undefined) return hit
  let ok = false
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process')
    execFileSync(toGuiPython(py), ['-c', 'import pypdfium2'], { timeout: 8000, stdio: 'ignore', windowsHide: true })
    ok = true
  } catch { /* ignore */ }
  probeCache.set(py, ok)
  return ok
}

function resolvePython(): string {
  for (const py of pythonCandidates()) {
    if (canImportPdfium(py)) return py
  }
  // 都探不到：返回空，由调用方走降级（不要让裸 python 撞 ModuleNotFound）
  return ''
}

/** 下载 URL 为本地临时文件（二进制），返回路径；调用方负责 finally 删除 */
function downloadToTemp(url: string, ext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume()
        reject(new Error(`文档下载失败（HTTP ${res.statusCode}）`))
        return
      }
      const tmp = path.join(os.tmpdir(), `gk-doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
      const out = fs.createWriteStream(tmp)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(tmp)))
      out.on('error', reject)
    })
    req.setTimeout(60_000, () => req.destroy(new Error('文档下载超时（60s）')))
    req.on('error', reject)
  })
}

export interface PdfToolPage {
  index: number
  text: string
  image_base64: string | null
  width: number
  height: number
}

export interface PdfToolResult {
  page_count: number
  pages: PdfToolPage[]
}

export interface PdfToolOpts {
  kind: 'pdf' | 'docx'
  /** 云端 URL（http/https）——下载到临时文件后提取 */
  url: string
  /** 单页文字少于此值视为扫描页（渲染交 OCR），默认 20 */
  minText?: number
  /** 扫描页渲染倍率，默认 2.0 */
  scale?: number
  /** 硬超时（毫秒），默认 120s：pypdfium2 纯 CPU，百页 PDF 一般 <10s */
  timeoutMs?: number
}

export interface PdfToolOutcome {
  ok: boolean
  data: PdfToolResult | null
  reason?: 'no-script' | 'no-python' | 'download-failed' | 'timeout' | 'spawn-error' | 'nonzero-exit' | 'bad-json'
  detail?: string
}

/**
 * 提取 PDF/DOCX 内容。任何失败返回 ok=false（不抛错），由调用方决定降级路径——
 * 与 OCR 链「失败返回 null 交由上层」的纪律一致。
 */
export function extractDocContent(opts: PdfToolOpts): Promise<PdfToolOutcome> {
  const script = resolvePdfToolScript()
  if (!script) return Promise.resolve({ ok: false, data: null, reason: 'no-script', detail: 'pdf_tool.py 不存在' })
  const python = resolvePython()
  if (!python) return Promise.resolve({ ok: false, data: null, reason: 'no-python', detail: '未找到可 import pypdfium2 的 python' })

  const timeoutMs = opts.timeoutMs ?? Number(process.env.PDF_TOOL_TIMEOUT_MS ?? 120_000)
  const ext = opts.kind === 'pdf' ? 'pdf' : 'docx'

  return new Promise<PdfToolOutcome>((resolve) => {
    let tmpFile = ''
    let settled = false
    let out = ''
    let err = ''
    const done = (r: PdfToolOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (tmpFile) fs.unlink(tmpFile, () => { /* 尽力而为 */ })
      resolve(r)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      done({ ok: false, data: null, reason: 'timeout', detail: `pdf_tool 超时 ${timeoutMs}ms` })
    }, timeoutMs)

    let child: ReturnType<typeof spawn>
    downloadToTemp(opts.url, ext)
      .then((file) => {
        tmpFile = file
        const args = [
          script,
          '--kind', opts.kind,
          '--file', file,
          '--min-text', String(opts.minText ?? 20),
          '--scale', String(opts.scale ?? 2.0),
        ]
        child = spawn(toGuiPython(python), args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: pythonEnv(),
        })
        child.stdout?.on('data', (d) => { out += decodeEngineChunk(d) })
        child.stderr?.on('data', (d) => { err += decodeEngineChunk(d) })
        child.on('error', (e) => {
          console.warn('[pdf-tool] spawn 失败:', (e as Error)?.message ?? e)
          done({ ok: false, data: null, reason: 'spawn-error', detail: String((e as Error)?.message ?? e) })
        })
        child.on('close', (code) => {
          const idx = out.lastIndexOf(MARKER)
          if (idx >= 0) {
            const payload = out.slice(idx + MARKER.length).trim()
            try {
              const j = JSON.parse(payload) as PdfToolResult
              if (j && Array.isArray(j.pages)) {
                done({ ok: true, data: j })
                return
              }
              done({ ok: false, data: null, reason: 'bad-json', detail: '响应缺少 pages 字段' })
              return
            } catch {
              done({ ok: false, data: null, reason: 'bad-json', detail: payload.slice(0, 200) })
              return
            }
          }
          // 子进程的 {"error": ...}（无标记）或裸崩溃
          const errJson = (() => { try { return JSON.parse(out.trim()) } catch { return null } })()
          const detail = (errJson && typeof errJson.error === 'string' && errJson.error)
            || err.trim().split('\n').slice(-3).join(' | ').slice(-300)
            || `exit code ${code}`
          console.warn(`[pdf-tool] ${opts.kind} 提取失败: ${detail}`)
          done({ ok: false, data: null, reason: 'nonzero-exit', detail })
        })
      })
      .catch((e) => {
        console.warn('[pdf-tool] 文档下载失败:', (e as Error)?.message ?? e)
        done({ ok: false, data: null, reason: 'download-failed', detail: String((e as Error)?.message ?? e) })
      })
  })
}
