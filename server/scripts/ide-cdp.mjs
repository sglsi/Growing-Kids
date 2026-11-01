// 微信开发者工具「真机复现」探针（2026-10-31 第十一轮）
//
// 为什么存在：输入框问题连报十次，全部靠"改代码 + 让思傅真机试"来验证。
// 我无法观察真机，只能猜；而 IDE 就在本机、且它的模拟器是 WebView ——
// 可以用 Chromium DevTools Protocol 直接读 DOM、**真实地打字**（Input.insertText）、
// 再读回 selectionStart。这就是一条能自我闭环的验证链。
//
// 前提：IDE 必须以 `--remote-debugging-port=9222` 启动。
//   "D:\AI\wechat_devtools\微信web开发者工具\微信开发者工具.exe" --project <abs> --remote-debugging-port=9222
//
// 用法：
//   node scripts/ide-cdp.mjs probe           列出小程序页面里的所有 textarea 与光标
//   node scripts/ide-cdp.mjs pages           列出可用的 CDP target

const BASE = process.env.IDE_CDP || 'http://127.0.0.1:9222'

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`)
  if (!r.ok) throw new Error(`CDP /json/list 返回 ${r.status}`)
  return r.json()
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.seq = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = (e) => rej(new Error('WebSocket 连接失败: ' + (e?.message || '')))
    })
    this.ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  }

  async send(method, params = {}) {
    await this.ready
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 20000)
    })
  }

  /** 求值并取回值（对象按 JSON 返回） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result?.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/** 连到**逻辑层**（appservice/mainframe）—— 小程序真正的 JS 运行环境 */
async function connectApp() {
  const list = await listTargets()
  const hit = list.find((t) => /\/appservice\/mainframe/.test(t.url || ''))
  if (!hit) throw new Error('没找到 appservice target')
  const cdp = new CDP(hit.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  return { cdp, target: hit }
}

/** 连到某个小程序页面 target（url 含 /pages/<name>/ 那种） */
async function connectPage(name) {
  const list = await listTargets()
  const pages = list.filter((t) => /\/__pageframe__\/pages\//.test(t.url || ''))
  if (!pages.length) {
    throw new Error('没找到小程序页面 target，IDE 可能还没打开项目')
  }
  // 注意尾部：像 pages/chat/admin 这种两级页面 url 末尾**没有**斜杠，
  // 早先写死 `/pages/${name}/` 会漏掉它们（报"没有页面"却明明在列表里）。
  const hit = name
    ? pages.find((t) => new RegExp(`/pages/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`).test(t.url))
    : pages[0]
  if (!hit) {
    throw new Error(`没有页面 ${name}；现有：${pages.map((p) => p.url).join(' , ')}`)
  }
  const cdp = new CDP(hit.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  return { cdp, target: hit, pages }
}

export { BASE, CDP, connectApp, connectPage, listTargets }

// ---------------------------------------------------------------- CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ide-cdp.mjs')) {
  const cmd = process.argv[2] || 'pages'
  const arg = process.argv[3]

  if (cmd === 'pages') {
    const list = await listTargets()
    console.log(`CDP targets（共 ${list.length}）`)
    for (const t of list) {
      const mark = /\/__pageframe__\/pages\//.test(t.url) ? '★' : ' '
      console.log(` ${mark} [${t.type}] ${t.url}`)
    }
  } else if (cmd === 'probe') {
    const { cdp, target, pages } = await connectPage(arg)
    console.log(`已连接：${target.url}`)
    console.log(`可用页面数：${pages.length}`)
    const info = await cdp.eval(`(() => {
      const out = []
      document.querySelectorAll('textarea').forEach((el, i) => {
        const r = el.getBoundingClientRect()
        out.push({
          i,
          cls: el.className,
          value: el.value,
          len: el.value.length,
          selStart: el.selectionStart,
          selEnd: el.selectionEnd,
          focused: document.activeElement === el,
          w: Math.round(r.width), h: Math.round(r.height),
          placeholder: el.getAttribute('placeholder') || '',
        })
      })
      return { count: out.length, list: out, url: location.href, title: document.title }
    })()`)
    console.log(JSON.stringify(info, null, 2))
    cdp.close()
  } else if (cmd === 'app') {
    // 在逻辑层执行任意表达式：node scripts/ide-cdp.mjs app "getCurrentPages().length"
    const { cdp } = await connectApp()
    const expr = arg || '1'
    const val = await cdp.eval(expr)
    console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2))
    cdp.close()
  } else if (cmd === 'nav') {
    // 跳到某个页面：node scripts/ide-cdp.mjs nav /pages/detail/index?id=xxx
    const { cdp } = await connectApp()
    const url = arg
    const val = await cdp.eval(`(async () => {
      if (typeof wx === 'undefined') return 'no wx'
      return await new Promise((resolve) => {
        wx.navigateTo({ url: ${JSON.stringify(url)}, success: () => resolve('ok'), fail: (e) => resolve('fail: ' + JSON.stringify(e)) })
      })
    })()`)
    console.log(val)
    cdp.close()
  } else {
    console.log('用法: node scripts/ide-cdp.mjs [pages|probe|app|nav] [参数]')
  }
}
