// 模块 13：工程静态门禁
//
// 这些是"防住历史坑"的闸门：隔离扫描、类型检查、lint、构建产物新鲜度。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M13', '工程静态门禁')

const SERVER = process.cwd()          // 约定：从 server/ 目录运行
const ROOT = path.resolve(SERVER, '..')

m.test('🔴 数据隔离门禁：check-isolation 无缺口', async (c) => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['scripts/check-isolation.mjs'], {
      cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 180000,
    })
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`隔离门禁未通过：${out.slice(-800)}`)
  }
  c.ok(!/缺口|FAIL|❌/.test(out), `门禁输出含失败标记：${out.slice(-500)}`)
})

m.test('服务端类型检查：tsc --noEmit 通过', async (c) => {
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--skipLibCheck', '-p', 'tsconfig.json'],
      { cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 300000 },
    )
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`服务端类型检查失败：${out.slice(0, 1500)}`)
  }
})

m.test('前端类型检查：tsc --noEmit 通过', async (c) => {
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--skipLibCheck'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300000 },
    )
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`前端类型检查失败：${out.slice(0, 1500)}`)
  }
})

m.test('前端 lint：无 error（--max-warnings=0 --quiet）', async (c) => {
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
        'src/**/*.{js,jsx,ts,tsx,css}', '--max-warnings=0', '--quiet'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300000 },
    )
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`lint 未通过：${out.slice(0, 1500)}`)
  }
})

m.test('🔴 源码内禁止 U+FFFD（中文乱码的确定性判据）', async (c) => {
  const bad = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'dist-web', '.tmp', 'logs', 'backups', '.swc', '.cache-paddlex', '.cache-pip'].includes(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|js|jsx|mjs|md|json|css|less)$/.test(e.name)) continue
      try {
        const s = fs.readFileSync(p, 'utf8')
        if (s.includes('\uFFFD')) bad.push(p)
      } catch { /* 读不动就跳过 */ }
    }
  }
  walk(ROOT)
  c.eq(bad.length, 0, `以下文件含 U+FFFD：${bad.slice(0, 10).join(', ')}`)
})

m.test('🔴 文档表结构：表格行的列数必须与表头一致（防 Markdown 表格错位）', async (c) => {
  const dir = path.join(ROOT, 'docs', 'design')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  const problems = []
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)
    let headerCols = 0
    let inTable = false
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/^\s*```/.test(ln)) { inFence = !inFence; continue }
      if (inFence) continue
      const isRow = /^\s*\|.*\|\s*$/.test(ln)
      if (!isRow) { inTable = false; headerCols = 0; continue }
      // ⚠️ 必须忽略转义竖线 `\|`：Markdown 表格里它表示"字面量竖线"（如 `image \| question`），
      //    按它切分会把 4 列表格误判成 5 列 —— 首轮验证就因此误报了 30+ 处。
      const cols = ln.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length
      if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) { headerCols = cols; inTable = true; continue }
      if (!inTable) { headerCols = cols; inTable = true; continue }
      if (headerCols && cols !== headerCols) {
        problems.push(`${f}:${i + 1} 列数 ${cols} ≠ 表头 ${headerCols}`)
      }
    }
  }
  c.eq(problems.length, 0, `表格列数异常：${problems.slice(0, 8).join('；')}`)
})

m.test('构建产物存在且非空（dist 目录）', async (c) => {
  const dist = path.join(ROOT, 'dist')
  c.ok(fs.existsSync(dist), 'dist 目录不存在（未执行过 build:weapp）')
  const files = fs.readdirSync(dist)
  c.ok(files.length > 0, 'dist 为空')
})

m.test('server 构建产物存在且非空', async (c) => {
  const d = path.join(SERVER, 'dist')
  c.ok(fs.existsSync(d), 'server/dist 不存在')
  c.ok(fs.existsSync(path.join(d, 'main.js')), 'server/dist/main.js 缺失')
})

m.test('🔴 服务端禁止 `@/` 路径别名（否则构建产物起不来）', async (c) => {
  // 2026-11-13 实测踩坑（D-051）：`tsconfig.json` 里有 `paths: { "@/*": ["./src/*"] }`，
  // 但 `nest build` 走的是 tsc，**tsc 不会把 paths 别名改写成相对路径**，
  // 于是 dist 里留下 `require("@/app.service")` —— `node dist/main` 直接
  // `MODULE_NOT_FOUND` 起不来。而生产 dist 是别名重构**之前**构建的（全是相对路径），
  // 所以线上一直正常，坑被掩盖到第一次「本地构建→上传 dist」才暴露。
  // 结论：服务端源码一律用相对路径；本闸门钉住，防止再有人图方便写 `@/`。
  const problems = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
      lines.forEach((ln, i) => {
        const t = ln.trim()
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
        if (/from\s+'@\//.test(ln) || /require\(\s*'@\//.test(ln)) {
          problems.push(`${path.relative(SERVER, p)}:${i + 1}`)
        }
      })
    }
  }
  walk(path.join(SERVER, 'src'))
  c.eq(problems.length, 0, `以下源码用了 @/ 别名：${problems.slice(0, 8).join(', ')}`)

  // 产物侧再兜一道：即便源码干净，也要确认 build 后没有别名残留。
  const dist = path.join(SERVER, 'dist')
  if (fs.existsSync(dist)) {
    const leftover = []
    const walkDist = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walkDist(p); continue }
        if (!e.name.endsWith('.js')) continue
        if (fs.readFileSync(p, 'utf8').includes('require("@/')) leftover.push(path.relative(SERVER, p))
      }
    }
    walkDist(dist)
    c.eq(leftover.length, 0, `构建产物仍含 @/ 引用：${leftover.slice(0, 8).join(', ')}`)
  }
})

m.test('上传名判机器名：随机串不落成标题', async (c) => {
  // 2026-11-01 在思傅真实账户里发现一条标题是
  // `GkljMPoGQP2a8e0a7d51647c149a1c87f1a132b49ef1.jpg` —— 初版守卫只认
  // `tmp_` 前缀与纯 hex，漏了这种 base62 串。这条断言把它钉住。
  const { pathToFileURL } = await import('node:url')
  const entry = path.join(SERVER, 'dist', 'upload', 'upload-name.js')
  if (!fs.existsSync(entry)) throw new Error(`缺少构建产物 ${entry}（先跑 nest build）`)
  const { isOpaqueUploadName } = await import(pathToFileURL(entry).href)

  const machine = [
    'GkljMPoGQP2a8e0a7d51647c149a1c87f1a132b49ef1.jpg',
    'tmp_a09aaa7ec36e4ff0b6.jpg',
    'wx_camera_1698000000000.jpg',
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0.png',
    '',
  ]
  const human = [
    'Unit3ReadingPractice.jpg',
    'TestPaper2023Grade9.pdf',
    '九年级上册英语阶段测试卷.jpg',
    'Unit 3 Reading 练习.png',
  ]
  for (const n of machine) c.ok(isOpaqueUploadName(n), `应判为机器名却放行：${n || '(空)'}`)
  for (const n of human) c.ok(!isOpaqueUploadName(n), `正常文件名被误判：${n}`)
})

export default m
