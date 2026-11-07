// 开发者工具模拟器验证入口（2026-11-07）
//
// 背景：过去每轮都写「开发者工具重编译 + 真机重扫码待人工」，把「验证」和「发货」
// 混为一谈。回归验证完全可以在模拟器里跑 —— `ide-cdp.mjs` 走 CDP 读 DOM / 真实打字 /
// 逻辑层求值，`ide-smoke-modules.mjs` 跑 8 个页面冒烟。本脚本是统一入口。
//
// ⚠️ 故意**不自动重启 IDE**：那会关掉思傅当前窗口，是一次性动作，需本人点头。
//    CDP 没就绪时只打印精确启动命令。
//
// 用法：
//   node server/scripts/ide-verify.mjs                     # 自检 CDP + 跑 8 页冒烟
//   node server/scripts/ide-verify.mjs --self             # 只自检，不跑冒烟
//   node server/scripts/ide-verify.mjs --marker "某文案"  # 额外校验 dist/common.js 是否含特征串
//
// 前提：IDE 以 --remote-debugging-port=9222 启动，并且项目已打开、模拟器已加载页面。

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const BASE = process.env.IDE_CDP || 'http://127.0.0.1:9222'
const IDE = 'D:\\AI\\wechat_devtools\\微信web开发者工具\\微信开发者工具.exe'
const PROJECT = ROOT
const args = process.argv.slice(2)

const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : false
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
  console.log('一次性打通方式（会重启开发者工具，先关当前窗口）：')
  console.log(`  1) 退出 IDE，或在 IDE 里重新登录一次（CLI open/auto 曾报 code 10 需要重新登录）`)
  console.log(`  2) 用下面命令启动（保持该进程常驻）：`)
  console.log(`     "${IDE}" --project "${PROJECT}" --remote-debugging-port=9222`)
  console.log(`  3) 等模拟器加载出页面后重跑本脚本`)
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
// 项目列表为空、模拟器没开；必须 reload 一次启动页，IDE 才会从 localStorage
// 的 projectList / lastSelect 恢复上次项目并打开窗口。
// 有这一步，「重启 + 验证」才是一条命令闭环，不用人工点项目卡片。
if (!appservice.length) {
  const entrance = targets.find((t) => /entrance\.html/.test(t.url || ''))
  if (!entrance) {
    console.log('❌ 既没有 appservice 也没有启动页，IDE 可能还在启动中')
    process.exit(2)
  }
  console.log('⟳ 只看到启动页，刷新一次让 IDE 从本地缓存恢复项目…')
  const { CDP } = await import('./ide-cdp.mjs')
  const c = new CDP(entrance.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  await c.send('Page.reload', { ignoreCache: false })
  c.close()
  await new Promise((r) => setTimeout(r, 6000))
  const r2 = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) })
  targets = await r2.json()
  appservice = hasApp()
  pages = hasPage()
  console.log(`  恢复后：targets ${targets.length} / appservice ${appservice.length} / 页面 ${pages.length}`)
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
