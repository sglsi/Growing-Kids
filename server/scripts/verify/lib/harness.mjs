// ============================================================
// 分模块验证套件 —— 测试骨架（harness）
//
// 设计原则（与 GK-QA-15「轻量、可回归、能防住历史坑」一致）：
//   1. **零依赖**：只用 Node 内置 fetch / FormData / fs，不引 jest/vitest，
//      避免为跑一次验证装半个 npm 宇宙。
//   2. **打真实后端**：验证的是"部署形态下的行为"，不是 mock 里的想象。
//   3. **自带清理**：每个用例造的数据都要能收回，测试号用独立 device id，
//      跑完调 DELETE /api/account 注销，不污染真实用户数据。
//   4. **失败即留证**：FAIL 时把 status / 响应体前 300 字符一并记下，
//      便于直接定位，不用再手工复现一次。
//
// 用法：
//   node scripts/verify/run.mjs                # 跑全部模块
//   node scripts/verify/run.mjs auth subjects  # 只跑指定模块
//   GK_API_BASE=http://192.168.3.242:3001/api node scripts/verify/run.mjs
// ============================================================

export const BASE = (process.env.GK_API_BASE || 'http://127.0.0.1:3001/api').replace(/\/+$/, '')

const RUN_TAG = process.env.GK_RUN_TAG || `verify-${Date.now().toString(36)}`

/** 断言失败专用错误：msg 里带"期望 vs 实际" */
export class AssertError extends Error {}

function trunc(s, n = 300) {
  const v = typeof s === 'string' ? s : (() => { try { return JSON.stringify(s) } catch { return String(s) } })()
  return v && v.length > n ? `${v.slice(0, n)}…(截断 ${v.length - n} 字符)` : (v ?? '')
}

export class Module {
  constructor(id, title) {
    this.id = id
    this.title = title
    this.cases = []
    this.ctx = null
  }

  /** 注册一个用例；fn 抛 AssertError 记 FAIL，抛其它错误记 ERROR */
  test(name, fn) {
    this.cases.push({ name, fn })
  }
}

export class Runner {
  constructor() {
    /** @type {{module:string,id:string,name:string,ok:boolean,kind:string,detail:string,ms:number}[]} */
    this.rows = []
    this.modules = []
    this.identCache = new Map()
    this.startedAt = Date.now()
    this.tmpFiles = []
  }

  register(mod) {
    mod.ctx = this.makeCtx(mod)
    this.modules.push(mod)
    return mod
  }

  // ---------------- 身份 ----------------

  /**
   * 用 X-Device-Id 走引导路由换身份令牌。
   * ⚠️ 严格令牌模式下裸 X-User-Id 一律 401，必须先换令牌（历史坑 R-技术-09）。
   */
  async ident(tag = 'main') {
    if (this.identCache.has(tag)) return this.identCache.get(tag)
    const deviceId = `${RUN_TAG}-${tag}`
    const res = await api('POST', '/auth/anonymous', { device: deviceId })
    if (res.status !== 200) {
      throw new Error(`建立测试身份失败：HTTP ${res.status} ${trunc(res.text, 200)}`)
    }
    const data = res.json?.data || {}
    if (!data.auth_token) throw new Error('引导路由未回传 auth_token，严格令牌模式无法继续')
    const ident = { deviceId, userId: data.user_id, token: data.auth_token }
    this.identCache.set(tag, ident)
    return ident
  }

  /** 造一张假令牌（用于验证"验签失败必须拒绝"） */
  forgedToken() {
    return 'v1.00000000-0000-0000-0000-000000000000.99999999999.deadbeef'.replace('v1.', 'v1.')
  }

  // ---------------- 用例执行 ----------------

  makeCtx(mod) {
    const self = this
    const state = {}
    let current = null

    const record = (ok, kind, detail) => {
      self.rows.push({
        module: mod.title, id: mod.id, name: current?.name || '(未命名)',
        ok, kind, detail: trunc(detail), ms: current ? Date.now() - current.t0 : 0,
      })
      const mark = ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'
      console.log(`${mark} ${mod.id} ${current?.name}${ok ? '' : `\n        ↳ ${trunc(detail, 200)}`}`)
    }

    return {
      /** 用例间共享数据的命名空间 */
      state,
      runner: self,

      /** 断言：条件为真 */
      ok(cond, msg) {
        if (!cond) throw new AssertError(msg || '断言失败')
      },
      /** 断言：相等（Object.is 语义，但对 undefined/null 宽容） */
      eq(actual, expected, msg) {
        if (actual !== expected) {
          throw new AssertError(`${msg || '值不相等'}｜期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
        }
      },
      /** 断言：HTTP 状态码 */
      status(res, expected, msg) {
        const exp = Array.isArray(expected) ? expected : [expected]
        if (!exp.includes(res.status)) {
          throw new AssertError(`${msg || '状态码不符'}｜期望=${exp.join('/')} 实际=${res.status} body=${trunc(res.text, 200)}`)
        }
      },
      /** 断言：响应体字段存在且非空 */
      has(obj, path, msg) {
        const v = path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj)
        if (v === undefined || v === null || v === '') {
          throw new AssertError(`${msg || '缺少字段'}｜${path} 为空｜实际=${trunc(obj, 200)}`)
        }
        return v
      },
      /** 取身份（懒加载） */
      async ident(tag) { return self.ident(tag) },
      /** 取"对手"身份（越权测试用） */
      async foe() { return self.ident('foe') },
      forgedToken: () => self.forgedToken(),
      api,
      /** 记录一个临时文件，结束时清理 */
      tmpFile(p) { self.tmpFiles.push(p) },

      // 由 run() 注入
      _begin(c) { current = c },
      _pass() { record(true, 'pass', '') },
      _fail(kind, err) { record(false, kind, err?.message || String(err)) },
    }
  }

  async run(filter = []) {
    console.log(`\n\x1b[1m分模块验证套件\x1b[0m  目标：${BASE}\n${'─'.repeat(64)}`)
    for (const mod of this.modules) {
      if (filter.length && !filter.includes(mod.id)) continue
      console.log(`\n\xb1[36m▸ ${mod.id} ${mod.title}\x1b[0m`)
      for (const c of mod.cases) {
        c.t0 = Date.now()
        mod.ctx._begin(c)
        try {
          await c.fn(mod.ctx)
          mod.ctx._pass()
        } catch (err) {
          mod.ctx._fail(err instanceof AssertError ? 'fail' : 'error', err)
        }
      }
    }
    return this.report()
  }

  report() {
    const total = this.rows.length
    const failed = this.rows.filter((r) => !r.ok)
    const byModule = new Map()
    for (const r of this.rows) {
      const k = `${r.id} ${r.module}`
      if (!byModule.has(k)) byModule.set(k, { total: 0, failed: 0, rows: [] })
      const m = byModule.get(k)
      m.total++
      if (!r.ok) m.failed++
      m.rows.push(r)
    }
    return { total, passed: total - failed.length, failed: failed.length, rows: this.rows, byModule, sec: (Date.now() - this.startedAt) / 1000 }
  }
}

// ---------------- HTTP 客户端 ----------------

/**
 * 打后端接口。
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} path  形如 '/timeline'（不含 /api 前缀）
 */
export async function api(method, path, opts = {}) {
  const {
    token, device, userId, openId, body, form, query,
    timeout = Number(process.env.GK_TIMEOUT || 60000),
    headers = {}, raw = false,
  } = opts

  const url = new URL(`${BASE}${path.startsWith('/') ? path : `/${path}`}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      // ⚠️ 历史坑：query 里传 undefined 会变成字符串 "undefined"，这里显式跳过
      if (String(v) === 'undefined') continue
      url.searchParams.set(k, String(v))
    }
  }

  const h = { ...headers }
  if (token) h['X-Auth-Token'] = token
  if (device) h['X-Device-Id'] = device
  if (userId) h['X-User-Id'] = userId
  if (openId) h['X-Open-Id'] = openId

  let payload
  if (form) {
    payload = form
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const t0 = Date.now()
  let res
  try {
    res = await fetch(url.toString(), {
      method, headers: h, body: payload, signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    return { status: 0, ok: false, json: null, text: `请求异常：${err.message}`, headers: {}, ms: Date.now() - t0 }
  }

  const text = await res.text().catch(() => '')
  let json = null
  if (!raw) { try { json = JSON.parse(text) } catch { /* 非 JSON 响应（如文件流）保持 null */ } }

  return {
    status: res.status,
    ok: res.ok,
    json,
    text,
    headers: Object.fromEntries(res.headers.entries()),
    ms: Date.now() - t0,
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { trunc }
export const runTag = RUN_TAG
