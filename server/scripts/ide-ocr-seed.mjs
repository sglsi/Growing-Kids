// 识别页 OCR 播种器：把一张本地图片「喂」进模拟器，一路走到出草稿（A 任务）
//
// 为什么不能直接测：识别页的「题干 + 答案」双框只在 drafts.length > 0 时渲染，
// 而 drafts 只能由真实 OCR 结果产生。模拟器里点「选择图片」会弹系统文件选择框，
// CDP 点不动 —— 所以把 wx.chooseMedia 顶掉，返回一个我们写进小程序文件系统的
// 路径，后续裁剪编辑器 / 上传 / OCR / 切题全走真实链路。
//
// 一路上踩到的四个坑（都写进注释了，别再踩）：
//   1. CDP 鼠标事件必须带 buttons:1，否则页面收不到 tap（同样的坐标带上就能点）；
//   2. 业务同意（gk_policy_agreed_v1）未写时 guardPolicy 会拦在选图前，
//      而它用的是 wx.showModal —— 原生弹窗，页面 DOM 里看不到，容易误判「点了没反应」；
//   3. Taro 4 调 chooseMedia **不带 success 回调**，走 Promise 形态，
//      只写回调版 mock 会抛 opts.success is not a function；
//   4. 选图后先进裁剪编辑器，必须再点「保存图片」才回填到页面。
//
// 用法：node scripts/ide-ocr-seed.mjs            # 自动生成一张带随机编号的作业图
//       node scripts/ide-ocr-seed.mjs <b64文件>  # 用现成的图
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { connectApp, connectPage } from './ide-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 没给图就地生成一张（内容每次不同，避免命中后端 (user_id, file_hash) 去重） */
let b64File = process.argv[2]
if (!b64File) {
  const out = '../.tmp'
  const gen = spawnSync('python', ['scripts/ocr-seed-image.py', out], { encoding: 'utf8' })
  if (gen.status !== 0) {
    console.error('生成测试图失败：', gen.stderr || gen.error)
    process.exit(1)
  }
  console.log('已生成测试图：', (gen.stdout || '').trim())
  b64File = `${out}/ocr-seed.b64`
}
const b64 = fs.readFileSync(b64File, 'utf8').trim()
console.log(`图片 base64 长度 ${b64.length}`)

async function appEval(expr) {
  const { cdp } = await connectApp()
  const v = await cdp.eval(expr)
  cdp.close()
  return v
}

/** 装日志捕获：页面里的 console.error / wx.onError 收进 __ocrCalls.log */
await appEval(`(() => {
  globalThis.__ocrCalls = { choose: 0, log: [] }
  if (!globalThis.__ocrLogHooked) {
    globalThis.__ocrLogHooked = true
    const push = (tag, a) => {
      try { globalThis.__ocrCalls.log.push(tag + ': ' + a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 200)) } catch (e) {}
    }
    const oe = console.error
    console.error = function (...a) { push('E', a); return oe.apply(console, a) }
    try { wx.onError((e) => push('ERR', [(e && e.message) || e])) } catch (e) {}
  }
  return 1
})()`)

/** 写图片 + 顶掉选图接口 */
const seedPath = await appEval(`(async () => {
  const fsm = wx.getFileSystemManager()
  const path = wx.env.USER_DATA_PATH + '/ocr-seed-' + Date.now() + '.png'
  await new Promise((res, rej) => fsm.writeFile({
    filePath: path, data: ${JSON.stringify(b64)}, encoding: 'base64',
    success: res, fail: (e) => rej(new Error(JSON.stringify(e))),
  }))
  globalThis.__ocrSeedPath = path
  const result = { type: 'image', tempFiles: [{ tempFilePath: path, path, size: 1024, fileType: 'image' }],
                   tempFilePaths: [path] }
  const mock = (opts = {}) => {
    globalThis.__ocrCalls.choose++
    setTimeout(() => {
      try {
        if (typeof opts.success === 'function') opts.success(result)
        if (typeof opts.complete === 'function') opts.complete(result)
      } catch (e) { globalThis.__ocrCalls.log.push('mock throw: ' + e) }
    }, 50)
    return new Promise((res) => setTimeout(() => res(result), 60))
  }
  wx.chooseMedia = mock
  wx.chooseImage = mock
  return path
})()`)
console.log(`已写入图片：${seedPath}`)

// 监护人同意：guardPolicy 拦在选图之前，且它用原生 showModal（DOM 里看不见）
await appEval(`(() => { wx.setStorageSync('gk_policy_agreed_v1', '2026-10-29-r3'); return 1 })()`)

async function clickText(pageName, sub) {
  const { cdp } = await connectPage(pageName)
  const hit = JSON.parse(
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('span,div,view,text')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim().includes(${JSON.stringify(sub)}))
      if (!el) return JSON.stringify({ ok: false })
      const b = el.getBoundingClientRect()
      return JSON.stringify({ ok: true, text: el.textContent.trim(), x: b.x + b.width / 2, y: b.y + b.height / 2 })
    })()`)
  )
  if (!hit.ok) {
    cdp.close()
    return null
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y, buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1 })
  cdp.close()
  return hit.text
}

async function probe(pageName) {
  const { cdp } = await connectPage(pageName)
  const info = JSON.parse(
    await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('span,div,view,text')]
        .filter((e) => e.children.length === 0 && (e.textContent || '').trim())
      return JSON.stringify({
        texts: [...new Set(els.map((e) => e.textContent.trim()))].slice(0, 40),
        tas: document.querySelectorAll('textarea').length,
        vals: [...document.querySelectorAll('textarea')].map((t) => (t.value || '').slice(0, 40)),
      })
    })()`)
  )
  cdp.close()
  return info
}

const logs = async () => appEval(`JSON.stringify(globalThis.__ocrCalls.log.slice(-5))`)

await appEval(`(async () => new Promise((r) => wx.reLaunch({ url: '/pages/recognize/index', success: r, fail: r })))()`)
await sleep(3500)
console.log('① 进入识别页，可见：', (await probe('recognize')).texts.slice(0, 6).join(' / '))

console.log('② 点选图入口：', (await clickText('recognize', '点击拍照')) || '未找到')
await sleep(3000)
let s = await probe('recognize')
console.log('   裁剪编辑器是否出现：', s.texts.some((t) => t.includes('裁剪与调整')) ? '是' : '否')

// ⚠️ 编辑器里有两个"保存"：「保存图片」是把图直接存进最近题目（不回传），
// 底部主按钮「保存并替换原图」才是 onConfirm 的出口 —— 点错了页面不会拿到图。
console.log('③ 点确认（保存并替换原图）：', (await clickText('recognize', '保存并替换原图')) || '未找到')
await sleep(3000)
s = await probe('recognize')
console.log('   页面图片数/文字：', s.tas, s.texts.slice(0, 8).join(' / '))

console.log('④ 点开始识别：', (await clickText('recognize', '开始识别')) || '未找到')

for (let i = 1; i <= 40; i++) {
  await sleep(3000)
  s = await probe('recognize')
  const lg = await logs()
  console.log(`[t+${i * 3}s] textarea=${s.tas} 日志=${lg}`)
  if (s.tas > 0) {
    console.log('\n✅ 草稿出现，双框已渲染')
    console.log('   输入框内容预览：', JSON.stringify(s.vals))
    console.log('   页面文字：', s.texts.slice(0, 12).join(' / '))
    break
  }
  if (i % 3 === 0) console.log(`   页面文字：${s.texts.slice(0, 10).join(' / ').slice(0, 120)}`)
}
