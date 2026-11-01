// 开发者工具的账户切换（本地小工具，不参与业务）
//
// 背景：模拟器里默认是一个**匿名账号**（dev_xxx 设备号换来的），而思傅本人的
// 正式账号（微信 openid）有十几道真实题目。要拿真实数据做实测，就得把模拟器
// 的 `gk_auth_token` / `gk_user_id` 换过去。
//
// ⚠️ 但**不能顺手做一次真登录**：`/auth/login` 会把该设备名下所有匿名号的数据
// **整体迁移**进正式账号（auth.service.migrateAnonymousData）。测试期间匿名号里
// 攒的都是造出来的假题，一登录就全灌进真实账户。所以这里只换令牌，不走登录。
//
// 账户凭据落在 `.tmp/devtools-accounts.json`（.gitignore 已忽略，不进仓库）。
//
// 用法：
//   node scripts/ide-account.mjs show           # 看当前是谁
//   node scripts/ide-account.mjs save real      # 把当前身份存成 real
//   node scripts/ide-account.mjs use real       # 切到 real
//   node scripts/ide-account.mjs use anon       # 切回匿名测试号
import fs from 'node:fs'
import path from 'node:path'
import { connectApp } from './ide-cdp.mjs'

const STORE = path.resolve(process.cwd(), '../.tmp/devtools-accounts.json')

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}
function writeStore(o) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(o, null, 2), 'utf8')
}

async function current() {
  const { cdp } = await connectApp()
  const uid = await cdp.eval(`String(wx.getStorageSync('gk_user_id') || '')`)
  const token = await cdp.eval(`String(wx.getStorageSync('gk_auth_token') || '')`)
  const me = await cdp.eval(`new Promise((resolve) => {
    wx.request({
      url: 'http://42.192.36.120/api/auth/me',
      header: { 'X-Auth-Token': wx.getStorageSync('gk_auth_token') },
      success: (r) => resolve(JSON.stringify((r.data && r.data.data) || {})),
      fail: () => resolve('{}'),
    })
  })`)
  cdp.close()
  return { uid, token, me: JSON.parse(me || '{}') }
}

async function apply(rec) {
  const { cdp } = await connectApp()
  await cdp.eval(`(() => { try { wx.removeStorageSync('gk_auth_state') } catch (e) {} return 1 })()`)
  await cdp.eval(`wx.setStorageSync('gk_auth_token', ${JSON.stringify(rec.token)})`)
  await cdp.eval(`wx.setStorageSync('gk_user_id', ${JSON.stringify(rec.uid)})`)
  await cdp.eval(`wx.reLaunch({ url: '/pages/index/index' })`)
  cdp.close()
}

const [cmd, name] = process.argv.slice(2)

if (cmd === 'show' || !cmd) {
  const c = await current()
  console.log(`user_id : ${c.uid}`)
  console.log(`nickname: ${c.me.nickname || '(无)'}`)
  console.log(`匿名    : ${c.me.is_anonymous === true}`)
  console.log(`open_id : ${c.me.open_id || '(无)'}`)
} else if (cmd === 'save') {
  if (!name) throw new Error('缺少名字')
  const c = await current()
  const store = readStore()
  store[name] = { uid: c.uid, token: c.token, note: c.me.is_anonymous ? 'anonymous' : c.me.nickname || 'real' }
  writeStore(store)
  console.log(`已保存 ${name} → ${c.uid}（${store[name].note}）`)
} else if (cmd === 'use') {
  const store = readStore()
  const rec = store[name]
  if (!rec) {
    console.log(`没有名为 ${name} 的账户记录。现有：${Object.keys(store).join(', ') || '(空)'}`)
    process.exit(1)
  }
  await apply(rec)
  console.log(`已切换到 ${name} → ${rec.uid}（${rec.note}），首页已重载`)
} else {
  console.log('用法：show | save <name> | use <name>')
}
