import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@nestjs/common'

/**
 * OCR 运行环境自动恢复（沙箱重置自愈，全流程无人值守）
 *
 * 背景：扣子沙箱回收频繁（资源紧张/超时/运行中强收），重置后项目卷虽保留
 * /workspace/projects/.venv-py 目录骨架，但 site-packages 内容全部丢失，
 * 快速（RapidOCR）/精准（PP-StructureV3）两条 OCR 链路同时不可用。
 * 此前依赖人工执行 bash docs/install-ocr-env.sh，现改为服务端自动完成：
 *
 *  1. Nest 启动后 3s 后台全量自检（import 全部关键模块）——缺失即自动重装；
 *  2. OCR 调用点（快速/精准入口）毫秒级轻量自检（目录存在性 + 15min 免检 TTL）；
 *  3. 恢复过程模块级互斥（并发触发只装一次），恢复完成后强制 import 实测验证；
 *  4. 全部过程输出进 console（dev.log 可检索 `[ocr-env]`）。
 *     2026-10-17：venv 骨架残留（目录在、site-packages 空）时 pip 会随之丢失，
 *     install 脚本已补"venv 存在但 pip 缺失 → 补装 pip"分支。
 *
 * 恢复执行体：docs/install-ocr-env.sh（幂等：venv 已存在则复用，pip 自动跳过已装包；
 * pip 下载缓存持久化在 /workspace/projects/.cache-pip，重装零下载）。
 * 模型权重缓存持久化在 /workspace/projects/.cache-paddlex（沙箱重置不丢，无需重复下载）。
 */

export type OcrEnvStatus = 'unknown' | 'ok' | 'missing' | 'recovering' | 'failed'

const VENV_DIR = '/workspace/projects/.venv-py'
const VENV_PY = `${VENV_DIR}/bin/python`
/** 轻量自检要求存在的包目录（与 install 脚本安装清单一一对应） */
const REQUIRED_PKG_DIRS = [
  'cv2',
  'rapidocr_onnxruntime',
  'paddle',
  'paddleocr',
  'paddlex',
  'fastapi',
  'uvicorn',
  'psutil',
]
/** 全量自检：一次性 import 全部关键模块（paddleocr 导入较慢，约 5~15s） */
const REQUIRED_MODULES = REQUIRED_PKG_DIRS.join(',')
const FULL_CHECK_TIMEOUT_MS = 60 * 1000
/** 恢复脚本硬超时（脚本内 pip 各组自带 600/900s 超时，此处兜底强杀） */
const RECOVER_KILL_MS = 15 * 60 * 1000

@Injectable()
export class EnvRecoveryService {
  private status: OcrEnvStatus = 'unknown'
  private recovering: Promise<boolean> | null = null
  private lastCheckAt: number | null = null
  private lastOkAt: number | null = null
  private lastRecoverAt: number | null = null
  private lastRecoverExit: number | string | null = null
  private lastError: string | null = null

  /** 毫秒级轻量自检：venv 解释器 + site-packages 关键包目录存在（骨架丢失场景即判缺失） */
  private lightCheck(): boolean {
    try {
      if (!fs.existsSync(VENV_PY)) return false
      const sp = this.sitePackagesDir()
      if (!sp) return false
      for (const d of REQUIRED_PKG_DIRS) {
        if (!fs.existsSync(path.join(sp, d))) return false
      }
      return true
    } catch {
      return false
    }
  }

  private sitePackagesDir(): string | null {
    try {
      const lib = path.join(VENV_DIR, 'lib')
      for (const e of fs.readdirSync(lib)) {
        if (!e.startsWith('python3')) continue
        const p = path.join(lib, e, 'site-packages')
        if (fs.existsSync(p)) return p
      }
    } catch {
      /* ignore */
    }
    return null
  }

  /** 全量自检：venv python 实际 import 全部关键模块（覆盖"目录在但半损坏"的边角） */
  async fullCheck(): Promise<boolean> {
    this.lastCheckAt = Date.now()
    try {
      const code = await new Promise<number>((resolve) => {
        const child = spawn(VENV_PY, ['-c', `import ${REQUIRED_MODULES}`], {
          stdio: 'ignore',
          env: process.env,
        })
        const killer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          resolve(124)
        }, FULL_CHECK_TIMEOUT_MS)
        child.on('exit', (c) => {
          clearTimeout(killer)
          resolve(c ?? 1)
        })
        child.on('error', () => {
          clearTimeout(killer)
          resolve(127)
        })
      })
      return code === 0
    } catch {
      return false
    }
  }

  /**
   * 确保 OCR 运行环境可用；缺失时自动恢复并等待完成。
   *  - light（默认）：毫秒级目录自检，挂在每次 OCR 调用前（无 TTL 缓存——沙箱
   *    可能在运行中被强制回收，venv 随时可能消失，每次实检才可靠）；
   *  - full：强制 import 实测（启动自检/恢复完成后用）。
   * 返回 false 时调用方应显式报错（不要静默降级成空结果）。
   */
  async ensureReady(opts?: { full?: boolean; waitMs?: number }): Promise<boolean> {
    const waitMs = opts?.waitMs ?? 45_000
    if (this.lightCheck()) {
      if (!opts?.full) {
        this.markOk()
        return true
      }
      if (await this.fullCheck()) {
        this.markOk()
        return true
      }
    }
    return await this.triggerRecovery(waitMs)
  }

  private markOk(): void {
    this.status = 'ok'
    this.lastOkAt = Date.now()
    this.lastError = null
  }

  /** 恢复互斥入口：并发触发只装一次，调用方共享同一份安装结果。 */
  private async triggerRecovery(waitMs: number): Promise<boolean> {
    if (!this.recovering) {
      this.status = 'recovering'
      this.recovering = this.doRecover().finally(() => {
        this.recovering = null
      })
    }
    const result = await Promise.race([
      this.recovering,
      new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
    ])
    // race 超时（而非恢复失败）时补一条提示：恢复仍在后台继续
    if (result === false && this.recovering !== null) {
      this.lastError = '环境仍在自动恢复中（本次调用等待超时，稍后重试即可）'
    }
    return result
  }

  /** 执行 docs/install-ocr-env.sh（幂等），完成后再做 import 实测确认。 */
  private async doRecover(): Promise<boolean> {
    const script = this.resolveInstallScript()
    this.lastRecoverAt = Date.now()
    if (!script) {
      this.status = 'failed'
      this.lastError = '恢复脚本 docs/install-ocr-env.sh 未找到'
      console.warn(`[ocr-env] ${this.lastError}`)
      return false
    }
    console.warn(
      `[ocr-env] 检测到 OCR venv 缺失/损坏（${VENV_PY}），开始自动恢复：bash ${script}（约 3~6 分钟，含 paddlepaddle 下载）`,
    )
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('bash', [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        cwd: path.dirname(script),
      })
      const onLine = (buf: Buffer) => {
        for (const line of buf.toString().split('\n')) {
          const t = line.trim()
          if (t) console.log(`[ocr-env][install] ${t}`)
        }
      }
      child.stdout?.on('data', onLine)
      child.stderr?.on('data', onLine)
      const killer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, RECOVER_KILL_MS)
      child.on('exit', (c) => {
        clearTimeout(killer)
        resolve(c ?? 1)
      })
      child.on('error', (e) => {
        console.warn(`[ocr-env] 恢复脚本启动失败：${e.message}`)
        clearTimeout(killer)
        resolve(127)
      })
    })
    this.lastRecoverExit = exitCode
    if (exitCode !== 0) {
      this.status = 'failed'
      this.lastError = `自动恢复脚本退出码 ${exitCode}（网络或依赖问题，下次调用/重启会自动重试）`
      console.warn(`[ocr-env] ${this.lastError}`)
      return false
    }
    if (!(await this.fullCheck())) {
      this.status = 'failed'
      this.lastError = '恢复脚本执行完成但 import 自检未通过（见上方 [ocr-env][install] 日志）'
      console.warn(`[ocr-env] ${this.lastError}`)
      return false
    }
    this.status = 'ok'
    this.lastOkAt = Date.now()
    this.lastError = null
    console.log('[ocr-env] OCR 运行环境自动恢复完成，快速/精准引擎就绪')
    return true
  }

  private resolveInstallScript(): string | null {
    const candidates = [
      path.resolve(__dirname, '../../../docs/install-ocr-env.sh'),
      path.resolve(process.cwd(), 'docs/install-ocr-env.sh'),
      path.resolve(process.cwd(), '../docs/install-ocr-env.sh'),
    ]
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p
      } catch {
        /* ignore */
      }
    }
    return null
  }

  /** 启动自检（OcrService.onApplicationBootstrap 后台触发，不阻塞启动）：延迟 3s 避开启动高峰。 */
  async bootstrap(): Promise<void> {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      await this.ensureReady({ full: true, waitMs: RECOVER_KILL_MS })
    } catch (e) {
      console.warn(`[ocr-env] 启动自检异常：${String((e as Error)?.message ?? e)}`)
    }
  }

  /** 诊断端点快照（/api/image/ocr-diagnose 的 envRecovery 段）。 */
  snapshot(): Record<string, unknown> {
    return {
      status: this.status,
      currentLightCheck: this.lightCheck() ? 'venv-ok' : 'venv-missing',
      venvPython: VENV_PY,
      lastCheckAt: this.lastCheckAt,
      lastOkAt: this.lastOkAt,
      lastRecoverAt: this.lastRecoverAt,
      lastRecoverExit: this.lastRecoverExit,
      lastError: this.lastError,
      recovering: !!this.recovering,
    }
  }
}
