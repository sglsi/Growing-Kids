#!/usr/bin/env node
/**
 * 部署打包前置/后置处理（deploy-pack.mjs）
 * ------------------------------------------------------------------
 * 背景：后端部署包 = server/ 整个目录打 tar 上传（平台排除名单里没有 .env*），
 * 因此「只传密文」要求 .env.secrets 明文在打包前离开 server/。
 * 同时 .local-storage/（本地存储残留，已迁 Supabase）与 logs/（历史日志）
 * 属于本机开发产物，没必要每次部署都上传——按思傅 2026-10-20 决定，
 * 采用「打包时临时挪走、部署后挪回」，不删除。
 *
 * 用法（在项目根 D:/AI/Growing-Kids 执行）：
 *   node server/scripts/deploy-pack.mjs pack      部署前：挪走本地专属文件
 *   node server/scripts/deploy-pack.mjs restore   部署后：挪回原位
 *   node server/scripts/deploy-pack.mjs status    查看当前在架/挪出状态
 *
 * 挪移目标：<项目根>/.deploy-staging/（不在部署根 server/ 内，不会进包；
 * 已加入 .gitignore）。跨盘 rename 失败时自动退回复制+删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
const STAGING = path.join(PROJECT_ROOT, '.deploy-staging')

/** 部署时不应出现在 server/ 里的本机专属项 */
const ITEMS = ['.env.secrets', '.env.migrate', '.local-storage', 'logs']

function move(src, dst) {
  try {
    fs.renameSync(src, dst)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.cpSync(src, dst, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

function pack() {
  fs.mkdirSync(STAGING, { recursive: true })
  const moved = []
  for (const item of ITEMS) {
    const src = path.join(SERVER_ROOT, item)
    if (!fs.existsSync(src)) continue
    const dst = path.join(STAGING, item)
    if (fs.existsSync(dst)) {
      console.error(`[deploy-pack] ✗ 暂存区已存在 ${item}，上次 pack 后未 restore。`)
      console.error('[deploy-pack]   请先执行：node server/scripts/deploy-pack.mjs restore')
      process.exit(1)
    }
    move(src, dst)
    moved.push(item)
    console.log(`[deploy-pack] 挪出 ${item}/ → .deploy-staging/${item}`)
  }
  if (moved.length === 0) {
    console.log('[deploy-pack] 无需挪移（server/ 内没有本地专属文件）')
  } else {
    // 兜底校验：确认真的挪干净了
    const left = ITEMS.filter((i) => fs.existsSync(path.join(SERVER_ROOT, i)))
    if (left.length > 0) {
      console.error(`[deploy-pack] ✗ 仍有残留：${left.join(', ')}，终止打包流程`)
      process.exit(1)
    }
    console.log(`[deploy-pack] ✓ pack 完成（挪出 ${moved.length} 项），可以执行部署；部署完成后务必 restore`)
  }
}

function restore() {
  const restored = []
  for (const item of ITEMS) {
    const src = path.join(STAGING, item)
    const dst = path.join(SERVER_ROOT, item)
    if (fs.existsSync(dst)) {
      console.log(`[deploy-pack] ${item} 已在原位，跳过`)
      continue
    }
    if (!fs.existsSync(src)) {
      console.log(`[deploy-pack] 暂存区无 ${item}，跳过`)
      continue
    }
    move(src, dst)
    restored.push(item)
    console.log(`[deploy-pack] 挪回 ${item}/ ← .deploy-staging/${item}`)
  }
  // 暂存区空了就清理掉，避免下次误判
  try {
    if (fs.existsSync(STAGING) && fs.readdirSync(STAGING).length === 0) fs.rmdirSync(STAGING)
  } catch {
    /* 忽略 */
  }
  console.log(restored.length ? `[deploy-pack] ✓ restore 完成（${restored.length} 项）` : '[deploy-pack] 无可恢复项')
}

function status() {
  for (const item of ITEMS) {
    const inServer = fs.existsSync(path.join(SERVER_ROOT, item))
    const inStaging = fs.existsSync(path.join(STAGING, item))
    const where = inServer ? 'server/（在架）' : inStaging ? '.deploy-staging/（已挪出）' : '不存在'
    console.log(`  ${item.padEnd(16)} ${where}`)
  }
  const encExists = fs.existsSync(path.join(SERVER_ROOT, '.env.secrets.enc'))
  console.log(`  .env.secrets.enc  ${encExists ? 'server/（在架，随包上传）' : '缺失！请运行 node server/scripts/encrypt-env.mjs'}`)
}

const cmd = process.argv[2]
if (cmd === 'pack') pack()
else if (cmd === 'restore') restore()
else if (cmd === 'status') status()
else {
  console.error('用法：node server/scripts/deploy-pack.mjs <pack|restore|status>')
  process.exit(1)
}
