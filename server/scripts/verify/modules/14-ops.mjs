// 模块 14：运维与数据保障
//
// 只做"存在性 + 可运行性 + 不变量"检查，绝不触发真实备份/删除/上传。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M14', '运维与数据保障')

const SERVER = process.cwd()
const ROOT = path.resolve(SERVER, '..')

m.test('备份脚本齐备（备份 / 恢复 / 计划任务注册）', async (c) => {
  const need = [
    'scripts/db-backup.mjs',
    'scripts/db-restore.mjs',
    'scripts/register-backup-task.ps1',
    'scripts/lib/gk-env.mjs',
    'scripts/lib/backup-format.mjs',
    'scripts/lib/netdisk.mjs',
  ]
  const miss = need.filter((f) => !fs.existsSync(path.join(SERVER, f)))
  c.eq(miss.length, 0, `缺失：${miss.join(', ')}`)
})

m.test('🔴 备份口令托管文件存在（丢了所有历史备份永久打不开）', async (c) => {
  const p = path.join(SERVER, 'backups', 'KEY-ESCROW.txt')
  c.ok(fs.existsSync(p), `KEY-ESCROW.txt 不存在：${p}`)
  const s = fs.readFileSync(p, 'utf8')
  c.ok(s.trim().length > 0, 'KEY-ESCROW.txt 为空')
})

m.test('健康检查探针可运行且退出码 0', async (c) => {
  try {
    execFileSync(process.execPath, ['scripts/health-probe.mjs'], {
      cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 180000,
    })
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`健康探针失败：${out.slice(-600)}`)
  }
})

m.test('运行时自检 /api/health/runtime 暴露关键配置', async (c) => {
  // 偶发 `fetch failed`（跟在大量子进程 execFileSync 之后，undici 连接池抖动），
  // 重试两次再判定，避免把环境抖动误记成产品缺陷。
  let res = null
  for (let i = 0; i < 3; i++) {
    res = await c.api('GET', '/health/runtime')
    if (res.status === 200) break
    await new Promise((r) => setTimeout(r, 800))
  }
  c.status(res, 200)
  const d = res.json?.data || {}
  c.ok(!!d.auth, '缺少 auth 段')
  c.ok(!!d.ticketStore, '缺少 ticketStore')
  c.ok(!!d.cache, '缺少 cache 段')
})

m.test('密钥管理：轮换脚本存在且 --check 可用', async (c) => {
  const p = path.join(SERVER, 'scripts', 'rotate-wx-secret.mjs')
  c.ok(fs.existsSync(p), '缺少 rotate-wx-secret.mjs')
  // --check 只读比较，不改动文件
  const out = execFileSync(process.execPath, [p, '--check'], {
    cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
  })
  c.ok(/一致|不一致|未配置|OK|MISMATCH|MISSING/i.test(out), `输出无法识别：${out.slice(0, 300)}`)
})

m.test('加密环境变量：可被解密（.env.secrets 可还原）', async (c) => {
  const p = path.join(SERVER, 'scripts', 'decrypt-env.mjs')
  c.ok(fs.existsSync(p), '缺少 decrypt-env.mjs')
  const out = execFileSync(process.execPath, [p], {
    cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
  })
  c.ok(out.length > 0, '解密无输出')
  c.ok(!out.includes('\uFFFD'), '解密输出含 U+FFFD（编码问题）')
})

m.test('管理员提权脚本存在（唯一入口，无 HTTP 面）', async (c) => {
  const p = path.join(SERVER, 'scripts', 'promote-admin.mjs')
  c.ok(fs.existsSync(p), '缺少 promote-admin.mjs')
  const src = fs.readFileSync(p, 'utf8')
  c.ok(src.includes('--list') || src.includes('list'), '提权脚本缺少 --list 查询能力')
})

m.test('日志目录可写（统一日志 tee 生效）', async (c) => {
  const dir = path.join(SERVER, 'logs')
  c.ok(fs.existsSync(dir), 'logs 目录不存在')
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('app-') && f.endsWith('.log'))
  c.ok(files.length > 0, '无任何 app-*.log，日志 tee 可能未生效')
})

m.test('🔴 日志不含请求体（题图 base64 会写炸盘）', async (c) => {
  const dir = path.join(SERVER, 'logs')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).slice(-3)
  let maxLine = 0
  for (const f of files) {
    const p = path.join(dir, f)
    const size = fs.statSync(p).size
    if (size > 200 * 1024 * 1024) throw new Error(`日志文件 ${f} 已达 ${(size / 1024 / 1024).toFixed(0)}MB，疑似写入了大 body`)
    // 抽样检查行长度
    const head = fs.readFileSync(p, 'utf8').slice(0, 512 * 1024)
    for (const line of head.split(/\r?\n/)) maxLine = Math.max(maxLine, line.length)
  }
  c.ok(maxLine < 20000, `日志单行最长 ${maxLine} 字符，疑似把 base64 图片写进了日志`)
})

m.test('迁移脚本可运行（--dry 不落库）', async (c) => {
  const p = path.join(SERVER, 'scripts', 'migrate.mjs')
  c.ok(fs.existsSync(p), '缺少 migrate.mjs')
  const out = execFileSync(process.execPath, [p, '--dry'], {
    cwd: SERVER, encoding: 'utf8', stdio: 'pipe', timeout: 180000,
  })
  c.ok(out.length > 0, '迁移 dry-run 无输出')
  c.ok(!/error|失败/i.test(out), `dry-run 输出含错误：${out.slice(-400)}`)
})

m.test('🔴 迁移编号唯一（重复会导致不可预期的执行顺序）', async (c) => {
  const dir = path.join(ROOT, 'migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
  const ids = files.map((f) => f.slice(0, 4))
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
  c.eq(dup.length, 0, `重复的迁移编号：${[...new Set(dup)].join(', ')}`)
})

m.test('备份输出目录存在（或可创建）', async (c) => {
  const dir = path.join(SERVER, 'backups')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  c.ok(fs.existsSync(dir), 'backups 目录无法创建')
})

export default m
