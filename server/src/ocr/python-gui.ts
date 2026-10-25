/**
 * Windows：把 venv 的 python.exe 换成同目录 pythonw.exe（GUI subsystem，永不建控制台）。
 *
 * 背景（2026-10-24 用户实测截图实锤）：Node spawn 的 `windowsHide: true` 只对
 * **直接子进程**生效；PaddleOCR 的 persistent `--loop` 模式内部用 multiprocessing
 * 派生子进程，孙进程自建控制台窗口 ⇒ 后端每次启动/预热都闪一个
 * `gk-ocr-env\.venv-py\Scripts\python.exe` 窗口，严重干扰用户。
 * pythonw 是 GUI subsystem 可执行文件，自身及所有后代都不建控制台；
 * OCR 通信走管道/文件 fd（stdio: pipe / logFd），stdout/stderr 不受影响。
 *
 * 注意：pythonw 下 `sys.stdout` 仅在 attach 到控制台时为 None——本项目 OCR
 * 的 stdio 全部是管道或重定向到文件，不依赖继承控制台，安全。
 */
export function toGuiPython(python: string): string {
  if (process.platform !== 'win32') return python
  const lower = python.toLowerCase()
  if (lower.endsWith('python.exe')) return python.slice(0, -'python.exe'.length) + 'pythonw.exe'
  // 裸命令（PATH 查找场景，如 ocr-tool 的 fallback 'python'）：换 pythonw
  if (lower === 'python') return 'pythonw'
  return python
}

/** 路径是否指向 GUI Python（用于日志/诊断） */
export function isGuiPython(python: string): boolean {
  return process.platform === 'win32' && python.toLowerCase().endsWith('pythonw.exe')
}

/**
 * Python 子进程的强制 UTF-8 环境（#117 乱码根因修复）。
 *
 * 实锤（2026-10-25）：同一 venv、同一张中文图、同一个 main.py --loop——
 *   · Git Bash 里 spawn（LANG=en_US.UTF-8）→ 管道输出标准 UTF-8，识别正常；
 *   · 后端服务里 spawn（PowerShell/计划任务启动，无 LANG）→ Python 管道 stdout
 *     编码回落 cp936(GBK)，Node 按 utf-8 读入 → 全文 U+FFFD，汉字零残留
 *     （用户实拍："识别出来的中文都是乱码"）。
 * Windows 无 locale 环境下 Python 的管道编码由 ANSI code page 决定，与调用方
 * 环境强耦合；PYTHONUTF8=1/PYTHONIOENCODING=utf-8 让管道输出恒定 UTF-8，
 * 不再随启动方式漂移。所有 spawn python 的位置都必须过这个函数。
 */
export function pythonEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    // 放在 extra 之后：编码不变量不允许被调用方环境意外覆盖
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
}

/** GBK 解码器（Node 内置 TextDecoder 支持 WHATWG 编码表；full-icu 下可用）。 */
let gbkDecoder: TextDecoder | null | undefined
function getGbkDecoder(): TextDecoder | null {
  if (gbkDecoder === undefined) {
    try {
      gbkDecoder = new TextDecoder('gbk')
    } catch {
      gbkDecoder = null // 极端裁剪的 Node 无 GBK 支持 → 放弃兜底（PYTHONUTF8 才是主修复）
    }
  }
  return gbkDecoder
}

/**
 * Python 子进程 stdout/stderr 数据块的兜底解码（#117 纵深防御）。
 *
 * 主修复是 pythonEnv() 强制 UTF-8；本函数防御任何漏网路径（引擎内部 re-exec、
 * 第三方脚本自建管道、历史部署漏改）。策略：UTF-8 解码后替换符占比过高时，用
 * 同一段**原始字节**改判 GBK，取替换符更少者。注意必须持有原始 Buffer——
 * 一旦按 utf-8 解成字符串，GBK 字节信息已永久丢失，无法事后恢复。
 *
 * 小块（<64B）不兜底：UTF-8 多字节字符可能被管道分片切开，小块里零星 U+FFFD
 * 是正常分片噪声，误判会把好数据拧成GBK。
 */
export function decodeEngineChunk(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad === 0 || buf.length < 64) return utf8
  if (bad / Math.max(1, utf8.length) < 0.1) return utf8
  const dec = getGbkDecoder()
  if (!dec) return utf8
  let gbk: string
  try {
    gbk = dec.decode(buf)
  } catch {
    return utf8
  }
  const badGbk = (gbk.match(/\uFFFD/g) || []).length
  return badGbk < bad ? gbk : utf8
}
