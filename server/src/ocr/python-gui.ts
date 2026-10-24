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
