#!/usr/bin/env node
/**
 * 安全脚本运行器 —— 专门规避 L11（内联 shell 命令里写 JS 表达式导致的 bad substitution）。
 *
 * 背景：工具的 shell 是 zsh。若把含 `${...}` / `$(...)` 的 JS 直接塞进内联命令，
 * zsh 会在「解析命令」阶段就做变量/命令替换，把 `p.x.toFixed(2)` 当成变量名去展开，
 * 报 `bad substitution` / `syntax error near unexpected token`，命令根本不会执行。
 *
 * 用法（把 JS 写进标准输入，而不是写进命令行）：
 *   node tools/run-js.cjs < 某个脚本.js
 *   cat 某个脚本.js | node tools/run-js.cjs --ts    # 需要先剥 TypeScript 类型时
 *
 * 为什么用 stdin 能根治：JS 代码**不经过 shell 解析**，无论里面有多少 `${}` / `$()` 都安全。
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const needTs = args.includes('--ts')
const fileArg = args.find((a) => !a.startsWith('--'))

let src
let origin
if (fileArg) {
  origin = fileArg
  src = fs.readFileSync(fileArg, 'utf8')
} else {
  origin = '<stdin>'
  src = fs.readFileSync(0, 'utf8') // 从 stdin 读，完全绕开 shell 解析
}

if (needTs || /\.ts$/.test(fileArg || '')) {
  // 只有显式 --ts 或 .ts 文件才走类型剥离，避免无谓依赖
  const candidates = [
    '/workspace/server-v4/node_modules/typescript',
    '/workspace/demo/node_modules/typescript',
    'typescript',
  ]
  let ts = null
  for (const c of candidates) {
    try {
      ts = require(c)
      break
    } catch {
      /* 继续找 */
    }
  }
  if (!ts) {
    console.error('[run-js] 需要 typescript 但未找到，可去掉 --ts 或指定纯 JS')
    process.exit(2)
  }
  src = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
}

// 用 vm 在独立上下文里执行，支持 require
const Module = require('module')
const tmpFile = path.join('/tmp', `.run-js-${process.pid}.cjs`)
fs.writeFileSync(tmpFile, src)
try {
  require(tmpFile)
} finally {
  try {
    fs.unlinkSync(tmpFile)
  } catch {
    /* 清理失败不影响结果 */
  }
}
