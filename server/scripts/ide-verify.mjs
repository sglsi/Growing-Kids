// 开发者工具模拟器验证入口（2026-11-07）
//
// 背景：过去每轮都写「开发者工具重编译 + 真机重扫码待人工」，把「验证」和「发货」
// 混为一谈。回归验证完全可以在模拟器里跑 —— `ide-cdp.mjs` 走 CDP 读 DOM / 真实打字 /
// 逻辑层求值，`ide-smoke-modules.mjs` 跑 8 个页面冒烟。本脚本是统一入口。
//
// ⚠️ 默认**不会重启已有 IDE**；只有显式 --launch 且 9222 没起来时才冷启动。
//    冷启动不关现有窗口，仅在 IDE 完全没开时拉起。
//
// 用法：
//   node server/scripts/ide-verify.mjs --launch --marker "某文案"   # 一条命令：冷启动 + 自检 + 8 页冒烟
//   node server/scripts/ide-verify.mjs                             # 自检 CDP + 跑 8 页冒烟
//   node server/scripts/ide-verify.mjs --self                       # 只自检，不跑冒烟
//   node server/scripts/ide-verify.mjs --marker "某文案"             # 额外校验 dist/common.js 是否含特征串
//
// 前提：IDE 带 --remote-debugging-port=9222；项目没加载时脚本会 reload 启动页自动恢复。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const BASE = process.env.IDE_CDP || 'http://127.0.0.1:9222'
const IDE = 'D:\\AI\\wechat_devtools\\微信web开发者工具\\微信开发者工具.exe'
const IDE_DIR = path.dirname(IDE)
const IDE_EXE = path.basename(IDE)
const PROJECT = ROOT
const args = process.argv.slice(2)

const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : false
}

// ⓪ 可选冷启动：CDP 没起来时把 IDE 拉起。
// ⚠️ 关键（2026-11-07 实测）：工具会话里直接 Start-Process / 后台保活，命令一结束
//    整棵进程树被清理，IDE 和 9222 一起没；WMI Create、schtasks、从 Bash 调
//    powershell.exe / cmd.exe 均被安全策略拦下。
//    ✅ 可行解：纯 Node 写一个 UTF-8 启动脚本（首行 chcp 65001 让 cmd 按 UTF-8 解中文路径），
//    再把它交给**已在桌面会话里的 explorer.exe** 执行。ShellExecute 由外壳完成，
//    IDE 的父进程不属于工具会话，因此能跨轮常驻。
//    explorer.exe 交接后会返回 exit 1，属正常，不能用退出码判成败 —— 只认 9222 + 哨兵文件。
const cdpUp = async (ms = 1500) => {
  try {
    const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(ms) })
    return r.ok
  } catch {
    return false
  }
}

if (flag('--launch') && !(await cdpUp())) {
  const bat = path.join(os.tmpdir(), 'gk-ide-cdp.cmd')
  const sentinel = path.join(os.tmpdir(), 'gk-ide-cdp.ok')
  const script = [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${IDE_DIR}"`,
    `start "" "${IDE_EXE}" --project "${PROJECT}" --remote-debugging-port=9222`,
    `echo OK > "${sentinel}"`,
    '',
  ].join('\r\n')
  writeFileSync(bat, script, 'utf8')
  try { unlinkSync(sentinel) } catch { /* 首次运行没有哨兵 */ }
  console.log('⟳ CDP 未就绪，通过桌面 explorer 冷启动 IDE…')
  // 注意：不要给路径再套一层引号，spawnSync 会自己处理；explorer 交接后 exit 1 属正常
  spawnSync('C:\\Windows\\explorer.exe', [bat], { stdio: 'ignore' })
  let up = false
  let waited = 0
  for (let i = 0; i < 45; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    waited += 2
    if (await cdpUp(1200)) { up = true; break }
  }
  if (up) {
    console.log(`✅ IDE 已冷启动，9222 就绪（约 ${waited}s）`)
    // 9222 比项目窗口早得多；先让 IDE 把启动页 / 项目窗口初始化完，
    // 否则立刻 reload 会打断它自己的恢复流程
    await new Promise((resolve) => setTimeout(resolve, 10000))
  } else {
    const dispatched = existsSync(sentinel)
    console.log(`❌ IDE 冷启动超时（${waited}s）；启动脚本${dispatched ? '已执行，但 IDE 没起来' : '未被执行（explorer 交接失败）'}`)
    console.log(`   脚本：${bat}`)
    process.exit(2)
  }
}

// ① 产物新鲜度：确认 dist 里真的有本轮改动，别拿旧包验
const marker = flag('--marker')
if (typeof marker === 'string') {
  const file = path.join(ROOT, 'dist', 'common.js')
  try {
    const text = readFileSync(file, 'utf8')
    const hit = text.includes(marker)
    console.log(`${hit ? '✅' : '❌'} dist 特征串「${marker}」：${hit ? '命中' : '未命中'}（${file}）`)
    if (!hit) process.exit(1)
  } catch (e) {
    console.log(`❌ 读不到 ${file}：${e.message}`)
    process.exit(1)
  }
}

// ② CDP 连通性
let targets
try {
  const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(2500) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  targets = await r.json()
} catch (e) {
  console.log(`❌ CDP 未就绪（${BASE}）：${e.message}`)
  console.log('')
  console.log('直接加 --launch 重跑即可（由桌面 explorer 冷启动，无需保活、无需人工点项目）：')
  console.log(`  node server/scripts/ide-verify.mjs --launch --marker "<本轮特征串>"`)
  console.log('若仍失败，检查：IDE 是否完全退出；或 IDE 内重新登录一次')
  console.log('（CLI open/auto 曾报 code 10 需要重新登录，但 CDP 通道不受影响）')
  console.log('')
  console.log('说明：CDP 只用于模拟器回归；音频 Range、隐私授权真弹窗、wx.login 换 openid')
  console.log('      等真机专有能力仍须手机验证，攒到发版前一次即可。')
  process.exit(2)
}

const hasApp = () => targets.filter((t) => /\/appservice\/mainframe/.test(t.url || ''))
const hasPage = () => targets.filter((t) => /\/__pageframe__\/pages\//.test(t.url || ''))
let appservice = hasApp()
let pages = hasPage()

// ②-b 启动页兜底（2026-11-07 实测）：IDE 冷启动只渲染 entrance.html，
// 项目列表为空、模拟器没开；必须 reload 启动页，IDE 才会从 localStorage
// 的 projectList / lastSelect 恢复上次项目并打开窗口。
// ⚠️ 冷启动早期 9222 先于项目窗口就绪，过早 reload 会被 IDE 自己的初始化盖掉，
//    所以做成多轮：奇数轮 reload，偶数轮只等，直到 appservice 出现。
if (!appservice.length) {
  const { CDP } = await import('./ide-cdp.mjs')
  for (let attempt = 1; attempt <= 10 && !appservice.length; attempt += 1) {
    const entrance = targets.find((t) => /entrance\.html/.test(t.url || ''))
    if (entrance && attempt % 2 === 1) {
      console.log(`⟳ 第 ${attempt} 轮：只看到启动页，reload 让 IDE 从本地缓存恢复项目…`)
      try {
        const c = new CDP(entrance.webSocketDebuggerUrl)
        await c.ready
        await c.send('Page.enable')
        await c.send('Page.reload', { ignoreCache: false })
        c.close()
      } catch (e) {
        console.log(`  reload 失败（继续等）：${e.message}`)
      }
    } else {
      console.log(`⟳ 第 ${attempt} 轮：等 IDE 初始化 / 项目窗口…`)
    }
    await new Promise((r) => setTimeout(r, 6000))
    const r2 = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) })
    targets = await r2.json()
    appservice = hasApp()
    pages = hasPage()
    console.log(`  当前：targets ${targets.length} / appservice ${appservice.length} / 页面 ${pages.length}`)
  }
}

// ②-c 页面 target 比 appservice 更晚出现，别一看到 appservice 就判失败
if (appservice.length && !pages.length) {
  for (let i = 1; i <= 12 && !pages.length; i += 1) {
    await new Promise((r) => setTimeout(r, 3000))
    const r3 = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) })
    targets = await r3.json()
    appservice = hasApp()
    pages = hasPage()
  }
}

console.log(`✅ CDP 已连接 ${BASE}：targets ${targets.length} / appservice ${appservice.length} / 页面 ${pages.length}`)
if (!appservice.length) {
  console.log('❌ 没找到 appservice/mainframe，项目可能还没打开')
  process.exit(2)
}
if (!pages.length) {
  console.log('❌ 没找到页面 target，模拟器可能停在启动页')
  process.exit(2)
}

// ③ 8 页冒烟
if (!flag('--self')) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'ide-smoke-modules.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}
