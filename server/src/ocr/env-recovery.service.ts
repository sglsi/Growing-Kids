import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@nestjs/common'
import { toGuiPython } from './python-gui'

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

/**
 * OCR venv 位置（平台自适应）：
 *  - Linux 沙箱：/workspace/projects/.venv-py（扣子项目卷，重置不丢）
 *  - Windows 本机：项目根 .venv-py（install-ocr-env.ps1 默认落点）
 *  环境变量 OCR_VENV_DIR 可显式覆盖。
 */
function defaultVenvDir(): string {
  if (process.env.OCR_VENV_DIR) return process.env.OCR_VENV_DIR
  if (process.platform === 'win32') {
    // dist/ocr -> ../../.. = 仓库根
    return path.resolve(__dirname, '../../..', '.venv-py')
  }
  return '/workspace/projects/.venv-py'
}
const VENV_DIR = defaultVenvDir()
const VENV_PY =
  process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python')
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
/** 全量自检：一次性 import 全部关键模块（paddleocr 导入较慢，约 5~15s；Windows 冷盘+启动高峰可到 60s+，超时放宽到 180s） */
const REQUIRED_MODULES = REQUIRED_PKG_DIRS.join(',')
const FULL_CHECK_TIMEOUT_MS = 180 * 1000
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
  /** 恢复脚本最近一次完整输出（含 pip 报错），供 /api/image/ocr-diagnose 透出排障 */
  private lastRecoverLog: string | null = null
  /** 最近一次 import 自检是否超时（超时≠缺包，不触发重装） */
  private lastProbeTimedOut = false
  /** 最近一次 import 自检的失败详情（failedModule/timedOut/code/modulesOk） */
  private lastProbeDetail:
    | { ok: boolean; timedOut: boolean; failedModule?: string; code?: number | null; modulesOk?: boolean }
    | null = null

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
      // Windows venv 布局：.venv-py/Lib/site-packages（无 lib/pythonX 层级）
      if (process.platform === 'win32') {
        const p = path.join(VENV_DIR, 'Lib', 'site-packages')
        return fs.existsSync(p) ? p : null
      }
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
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await this.probeAll()
    if (r.ok) {
      this.lastProbeTimedOut = false
      this.lastProbeDetail = null
      return true
    }
    this.lastProbeDetail = r
    if (r.timedOut && attempt === 1) {
      // 超时≠缺包（启动高峰/冷盘/CPU 竞争都会让 8 个大件的 import 拖过阈值）：
      // 等 10s 重试一次；仍超时则标记 timedOut 交给上层决定**不触发重装**
      // （2026-10-24 实测：60s 超时误判 → 白跑 3-6 分钟 install-ocr-env.ps1，
      //  而同一 venv 的 persistent-ocr 预热明明成功了——重装治不了超时）
      console.warn(`[ocr-env] import 自检第 ${attempt} 次超时（${FULL_CHECK_TIMEOUT_MS / 1000}s），10s 后重试`)
      await new Promise((r2) => setTimeout(r2, 10_000))
      continue
    }
    break
  }
  this.lastProbeTimedOut = this.lastProbeDetail?.timedOut ?? false
  if (!this.lastProbeTimedOut && this.lastProbeDetail?.failedModule) {
    console.warn(`[ocr-env] import 自检未过：模块 ${this.lastProbeDetail.failedModule} 导入失败（exit=${this.lastProbeDetail.code}）`)
  }
  if (this.lastProbeDetail?.modulesOk) {
    console.warn(
      `[ocr-env] 一次性 import 未通过（exit=${this.lastProbeDetail.code}），但逐个 import 全部成功 ` +
        `⇒ 包是齐的，判定为启动高峰资源竞争（与 persistent-ocr 预热并发），**不触发重装**`,
    )
  }
  return false
}

/**
 * 一次性 import 全部关键模块。
 * 返回 { ok, timedOut, failedModule?, code? }：
 *  - timedOut：超时（不等于缺包，见 fullCheck 注释）
 *  - failedModule：拆分逐个 import 后第一个失败的模块（真缺包/半损坏）
 */
/**
 * @param modulesOk 「一次性 import 失败、但逐个 import 全部通过」——
 *   2026-10-24 实测：启动瞬间与 persistent-ocr 预热并发时，8 个大件一起导入会
 *   把内存峰值打满被系统杀（exit≠0），而单独 import 每个都正常 ⇒ 环境其实是好的，
 *   这种情况**绝不能触发重装**（重装 3~6 分钟治不了资源竞争，还会弹窗口）。
 */
private async probeAll(): Promise<{
  ok: boolean
  timedOut: boolean
  failedModule?: string
  code?: number | null
  modulesOk?: boolean
}> {
  const code = await new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(toGuiPython(VENV_PY), ['-c', `import ${REQUIRED_MODULES}`], {
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
      })
    } catch {
      resolve(127)
      return
    }
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
  if (code === 0) return { ok: true, timedOut: false }
  if (code === 124) return { ok: false, timedOut: true }
  // 真失败（缺包/半损坏）：逐个 import 定位是哪个模块，日志与诊断才有信息量
  for (const mod of REQUIRED_PKG_DIRS) {
    const c = await new Promise<number>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(toGuiPython(VENV_PY), ['-c', `import ${mod}`], {
          stdio: 'ignore',
          env: process.env,
          windowsHide: true,
        })
      } catch {
        resolve(127)
        return
      }
      const killer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve(124)
      }, 120_000)
      child.on('exit', (c2) => {
        clearTimeout(killer)
        resolve(c2 ?? 1)
      })
      child.on('error', () => {
        clearTimeout(killer)
        resolve(127)
      })
    })
    if (c !== 0) return { ok: false, timedOut: c === 124, failedModule: mod, code: c }
  }
  // 逐个都能 import ⇒ 包是齐的；一次性导入的失败属于资源竞争（见函数注释）
  return { ok: false, timedOut: false, code, modulesOk: true }
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
      // 下面两种情况都**不是缺包**，重装（3~6 分钟，还要拉起安装脚本）治不了，只会雪上加霜：
      //   ① 超时（启动高峰/冷盘竞争，8 个大件 import 超 180s）；
      //   ② 一次性 import 被系统杀（内存峰值）但逐个 import 全过。
      // 统一处理：标记 unknown、返回 false 让调用方本次显式报错，绝不启动重装。
      if (this.lastProbeTimedOut || this.lastProbeDetail?.modulesOk) {
        this.status = 'unknown'
        this.lastError = this.lastProbeTimedOut
          ? `OCR 环境 import 自检超时（${FULL_CHECK_TIMEOUT_MS / 1000}s 内未完成，通常是启动高峰/冷盘竞争），稍后重试即可，无需重装`
          : `OCR 环境一次性 import 未通过（exit=${this.lastProbeDetail?.code}），但逐包自检全部通过 —— 判定为启动高峰资源竞争，稍后重试即可，无需重装`
        console.warn(`[ocr-env] ${this.lastError}`)
        return false
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

  /** 执行 install-ocr-env.sh（Linux）或 install-ocr-env.ps1（Windows）（幂等），完成后再做 import 实测确认。 */
  private async doRecover(): Promise<boolean> {
    const script = this.resolveInstallScript()
    this.lastRecoverAt = Date.now()
    this.lastRecoverLog = ''
    if (!script) {
      this.status = 'failed'
      this.lastError = '恢复脚本 install-ocr-env.sh/.ps1 未找到'
      console.warn(`[ocr-env] ${this.lastError}`)
      return false
    }
    const isWin = process.platform === 'win32'
    const cmd = isWin ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"` : `bash ${script}`
    console.warn(
      `[ocr-env] 检测到 OCR venv 缺失/损坏（${VENV_PY}），开始自动恢复：${cmd}（约 3~6 分钟，含 paddlepaddle 下载）`,
    )
    const exitCode = await new Promise<number>((resolve) => {
      const childEnv = { ...process.env, OCR_VENV_DIR: VENV_DIR }
      // ⚠️ 2026-10-24 修（弹窗真凶之一）：原来写成
      //     spawn(ComSpec, ['-ExecutionPolicy','Bypass','-File', script])
      //     ComSpec 在 Windows 是 **cmd.exe**，把 powershell 的参数喂给 cmd.exe ⇒
      //     cmd 不认这些参数、直接进交互模式（日志里那几行 "Microsoft Windows [版本…]" banner
      //     就是它的输出）⇒ 脚本根本没执行，白等 3~6 分钟，还弹出一个 cmd 窗口一闪。
      //     必须直接 spawn powershell 本身（windowsHide 才管得住它这一层）。
      const child = isWin
        ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(script),
            windowsHide: true,
          })
        : spawn('bash', [script], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(script),
          })
      const onLine = (buf: Buffer) => {
        for (const line of buf.toString().split('\n')) {
          const t = line.trim()
          if (!t) continue
          console.log(`[ocr-env][install] ${t}`)
          this.lastRecoverLog = (this.lastRecoverLog ? this.lastRecoverLog + '\n' : '') + t
          if (this.lastRecoverLog.length > 4000) this.lastRecoverLog = this.lastRecoverLog.slice(-4000)
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
    const isWin = process.platform === 'win32'
    const name = isWin ? 'install-ocr-env.ps1' : 'install-ocr-env.sh'
    const candidates = [
      path.resolve(__dirname, '../../../docs', name),
      path.resolve(process.cwd(), 'docs', name),
      path.resolve(process.cwd(), '../docs', name),
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
      lastRecoverLog: this.lastRecoverLog,
      recovering: !!this.recovering,
    }
  }
}
