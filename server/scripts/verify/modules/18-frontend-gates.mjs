// 模块 18：前端源码红线（小程序端）
//
// 定位：M01–M11 验的是"接口行为"，M12 验纯函数，M13 验工程门禁。
// 但本项目绝大多数"用户能感知到的问题"发生在**前端源码层面**——
// 点不动、静默失败、解错包——这些只有**打不到接口也测不出来**，只能靠源码红线拦。
//
// 每一条都对应一次真实事故或一条成文规范（GK-QA-17 第 6 章），不是风格偏好。
// 与 M13 的区别：M13 跑 tsc/lint（慢、全量），M18 只做特征扫描（秒级、可随时跑）。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M18', '前端源码红线')

const SERVER = process.cwd() // 约定：从 server/ 目录运行
const ROOT = path.resolve(SERVER, '..')
const SRC = path.join(ROOT, 'src')

/** 收集源码文件（跳过产物目录） */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p, out); continue }
    if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

// ---------------------------------------------------------------
// 1. 🔴 <Text> 不绑 onClick（Taro 4.1.9：事件会被丢掉 ⇒「点了没反应」）
// ---------------------------------------------------------------
m.test('🔴 前端：<Text> 不得绑 onClick（交互元素一律 View）', async (c) => {
  const bad = []
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8')
    // 逐个匹配 <Text ...> 开标签（支持跨行）
    const re = /<Text\b[\s\S]*?>/g
    let hit
    while ((hit = re.exec(src))) {
      if (!/onClick/.test(hit[0])) continue
      const line = src.slice(0, hit.index).split(/\r?\n/).length
      bad.push(`${rel(f)}:${line}`)
    }
  }
  c.eq(bad.length, 0, `以下位置的 <Text> 绑了 onClick（Taro 4.1.9 会丢事件）：${bad.slice(0, 15).join('、')}`)
})

// ---------------------------------------------------------------
// 2. 🔴 Network.downloadFile 必须显式带 header
//    只有 Network.request 会自动注入/重放令牌，downloadFile 不会 ⇒
//    打到需要令牌的 /api/storage/files/* 必然 401 ⇒ 「文档永远打不开」
// ---------------------------------------------------------------
m.test('🔴 前端：Network.downloadFile 必须显式带 header（否则文档打不开）', async (c) => {
  const bad = []
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8')
    const re = /Network\.downloadFile\s*\(/g
    let hit
    while ((hit = re.exec(src))) {
      // 取调用后 600 字符（够覆盖一个 options 字面量）
      const chunk = src.slice(hit.index, hit.index + 600)
      // 两种合规写法：① 直接带 header；② 按目标判定后条件带（needAuth 之类）——
      // 公网签名直链带自定义头反而可能被拒，不能一刀切要求。
      if (!/header\s*:/.test(chunk) && !/needAuth|isApiUrl|isOwnBackend/.test(chunk)) {
        const line = src.slice(0, hit.index).split(/\r?\n/).length
        bad.push(`${rel(f)}:${line}`)
      }
    }
  }
  c.eq(bad.length, 0, `以下 downloadFile 调用未带 header（需令牌的接口会 401）：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 3. 🔴 禁止双重解包 `.data?.data`
//    service 层应统一 unwrap 后返回业务数据；调用方再剥一层说明契约断了
//    （成长记忆列表空白事故：剥出来的还是后端 snake_case，前端按驼峰读全空）
// ---------------------------------------------------------------
m.test('🔴 前端：禁止 (res as any).data?.data 双重解包（service 必须自己解包）', async (c) => {
  const bad = []
  for (const f of walk(SRC)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((ln, i) => {
      if (/\.data\?\.data\b/.test(ln) && !/^\s*(\*|\/\/)/.test(ln)) bad.push(`${rel(f)}:${i + 1}`)
    })
  }
  c.eq(bad.length, 0, `以下位置仍在双重解包：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 4. 🔴 隐私接口调用点必须前置 guardPrivacy（否则失败静默 ⇒「点了没反应」）
// ---------------------------------------------------------------
m.test('🔴 前端：选图/录音等隐私接口的调用文件必须引入 guardPrivacy', async (c) => {
  // ⚠️ 必须是**调用形式**（后面跟 `(`），否则会把注释/文档里的词也当成调用点
  const PRIVACY_API = /\b(?:Taro\.)?(chooseMedia|chooseImage|chooseMessageFile|chooseVideo|getRecorderManager)\s*\(/
  const bad = []
  for (const f of walk(SRC)) {
    if (f.includes(`${path.sep}utils${path.sep}privacy.ts`)) continue // 工具自身
    const src = fs.readFileSync(f, 'utf8')
    // 去掉注释行再匹配（`app.config.ts` 的说明里会提到这些 API 名）
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    if (!PRIVACY_API.test(code)) continue
    if (!/guardPrivacy/.test(src)) {
      bad.push(rel(f))
    }
  }
  c.eq(bad.length, 0, `以下文件调用了隐私接口却没有引入 guardPrivacy：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 5. 🔴 ui/textarea 必须默认 maxlength={-1}（微信默认 140 字静默截断长答案）
// ---------------------------------------------------------------
m.test('🔴 前端：ui/textarea 默认 maxlength=-1（微信默认 140 会静默截断）', async (c) => {
  const p = path.join(SRC, 'components', 'ui', 'textarea.tsx')
  c.ok(fs.existsSync(p), 'src/components/ui/textarea.tsx 不存在')
  const src = fs.readFileSync(p, 'utf8')
  c.ok(/maxlength=\{-1\}/.test(src), 'ui/textarea.tsx 未设置 maxlength={-1}')
  // 且必须在 TaroTextarea 的 {...props} 之前（否则默认值会盖掉调用方显式传的 maxlength）
  const iTextarea = src.indexOf('<TaroTextarea')
  c.ok(iTextarea > -1, '未找到 <TaroTextarea> 开标签')
  const body = src.slice(iTextarea)
  const iDefault = body.indexOf('maxlength={-1}')
  // ⚠️ 用 lastIndexOf：注释里就写着「放在 {...props} 之前」，用 indexOf 会匹配到注释
  const iProps = body.lastIndexOf('{...props}')
  c.ok(iDefault > -1 && (iProps === -1 || iDefault < iProps), 'maxlength 默认值必须写在 TaroTextarea 的 {...props} 之前')
})

// ---------------------------------------------------------------
// 6. src/ 下禁止直接使用 process.env（lint 有规则，这里做一次快检防漏网）
// ---------------------------------------------------------------
m.test('前端：src/ 下禁止直接使用 process.env', async (c) => {
  const bad = []
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, 'utf8')
    if (/process\.env\./.test(src)) bad.push(rel(f))
  }
  c.eq(bad.length, 0, `以下文件直接使用了 process.env：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 7. 🔴 禁止完全空的 catch（best-effort 也必须打日志，否则静默失败无人知）
// ---------------------------------------------------------------
m.test('🔴 前端：禁止完全空的 catch（best-effort 也要留痕）', async (c) => {
  const bad = []
  for (const f of walk(SRC)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((ln, i) => {
      if (/^\s*(\*|\/\/)/.test(ln)) return // 注释里的反例不算
      if (/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(ln)) bad.push(`${rel(f)}:${i + 1} .catch(() => {})`)
      else if (/}\s*catch\s*\{\s*\}/.test(ln)) bad.push(`${rel(f)}:${i + 1} catch {}`)
    })
  }
  c.eq(bad.length, 0, `以下位置是完全空的 catch：${bad.slice(0, 12).join('、')}`)
})

// ---------------------------------------------------------------
// 8. 🔴 列表页解除 loading 必须用计数而非布尔（首页骨架卡死事故）
//    这里只做弱检：出现 `pendingLoads`/`pending` 计数式命名的页面必须 finally 解锁
// ---------------------------------------------------------------
m.test('🔴 前端：列表页 loading 必须在 finally 无条件解除', async (c) => {
  const pages = ['pages/index/index.tsx', 'pages/subject/index.tsx', 'pages/library/index.tsx', 'pages/document/index.tsx', 'pages/memory/index.tsx']
  const bad = []
  for (const p of pages) {
    const f = path.join(SRC, p)
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf8')
    const hasLoading = /setLoading\(true\)/.test(src)
    if (!hasLoading) continue
    // 窗口放宽到 800 字符：首页在 finally 里夹了大段注释（说明为何用计数而非布尔）
    const closeRe = /finally\s*\{[\s\S]{0,800}?setLoading\(false\)/
    if (!closeRe.test(src)) bad.push(rel(f))
  }
  c.eq(bad.length, 0, `以下列表页在 finally 之外解除（或根本不解除）loading：${bad.join('、')}`)
})

// ---------------------------------------------------------------
// 9. 🔴 内容落库/上传之前必须过业务隐私政策闸门（GK-23-24）
//    事故：policy-consent 注释一直写着「上传/写入前需先同意」，但**没有任何一处**
//    真正检查过 ⇒ 点「稍后」之后照样拍照入库，首屏那次征求同意只是装饰。
//    断言口径：出现「建条目/批量入库」这类写操作的文件，必须引入 guardPolicy。
// ---------------------------------------------------------------
m.test('🔴 前端：内容入库/上传文件必须引入 guardPolicy（业务隐私同意）', async (c) => {
  // 只挑「把内容写进库里」的**服务函数**调用；列表刷新、改分类之类不算
  const WRITE_API = /\b(createTimelineBatch|createMemory|addMemoryMedia|createLibraryDoc|saveAnswer)\s*\(/
  const bad = []
  for (const f of walk(SRC)) {
    // services/ 下是这些函数的**定义处**（函数名与调用长得一样），闸门归调用方
    if (f.includes(`${path.sep}services${path.sep}`)) continue
    const src = fs.readFileSync(f, 'utf8')
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    if (!WRITE_API.test(code)) continue
    if (!/guardPolicy/.test(src)) bad.push(rel(f))
  }
  c.eq(bad.length, 0, `以下文件有内容入库调用却没有 guardPolicy 闸门：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 10. 🔴 业务隐私同意的存储键只允许在一个地方定义（GK-23-24 附带）
//     三处（闸门/弹层/政策页）各写一份字符串 ⇒ 迟早有一处写错，
//     表现是「明明同意了，上传还是被拦」或「永远要求同意」。
// ---------------------------------------------------------------
m.test('🔴 前端：隐私同意存储键不得在 constants 之外硬编码', async (c) => {
  const bad = []
  const allow = path.join(SRC, 'constants', 'privacy-policy.ts')
  for (const f of walk(SRC)) {
    if (f === allow) continue
    const src = fs.readFileSync(f, 'utf8')
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    if (/'gk_policy_agreed_v1'/.test(code)) bad.push(rel(f))
  }
  c.eq(bad.length, 0, `以下文件硬编码了隐私同意键（应引 POLICY_CONSENT_STORAGE_KEY）：${bad.slice(0, 10).join('、')}`)
})

// ---------------------------------------------------------------
// 11. 🔴 多行输入框的 onInput 里不得 setState（2026-10-31 第十轮，连报九次的根因）
//
// 机制（两条平台规则叠加，缺一不可）：
//   ① Taro 对表单元素有一条无条件规则（@tarojs/react/dist/react.esm.js:372）：
//      `if (oldProps[i] !== newProps[i] || (isFormElement && i === 'value'))`
//      —— 只要发生一次 commit，`value` 就必然进 setData，值变没变都一样。
//   ② 微信 `textarea` 是**原生组件**：页面 setData 时它按虚拟 DOM 的 `value`
//      重新应用文本，**光标落到末尾**。
//   ⇒ 在 onInput 里 setState = 每打一个字 setData 一次 = 光标每打一个字重置一次。
//      这是**页面层**的行为，改输入框组件永远治不到（前九轮全部栽在这里）。
//   ⇒ 若此时下发的还是旧值（曾为"不下发"而让属性停在旧值/空串），就是"打不进字"。
//
// 正确写法：打字只写 ref，onBlur（或程序化写入时）才同步进 state。
// 这条门禁就是不让第 11 个人再把它改回去。
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// 11. 🔴 多行输入框的 onInput 里**必须**当场 setState（第十一轮实测反转）
//
// 第十轮这条门禁写的是反的（要求"打字只写 ref、不 setState"），代价是用户打不进字。
// 第十一轮在微信开发者工具里做真实输入实验后定性：
//   · 实验（scripts/ide-samevalue.mjs）：textarea.value 重新赋**同样的字符串** →
//     光标纹丝不动；赋**不同的字符串** → 光标立刻跳到末尾。
//   · 抓栈（scripts/ide-stack.mjs）：改写来自 Taro commit → 微信 defaultValueChange。
// ⇒ 跳不跳光标只取决于「下发的值与原生当前文本是否一致」。
//   页面 onInput 当场 setState，组件原样下发 props.value，每次 commit 下发的都是刚刚那个
//   文本 ⇒ 与原生相同 ⇒ 不重建、不跳光标、不丢字。
// ⇒ 反过来，把实时文本藏进 ref（第十轮的做法）会让 state 滞后：只要发生任何一次 commit，
//   下发的就是旧值，把用户刚打的字**覆盖回去** —— 真机表现就是「打不进字」。
//
// 豁免：只做事件转发的包装组件（如 AnswerSolutionEditor 里的 `onInput(detail.value)`）。
// ---------------------------------------------------------------
m.test('🔴 前端：多行输入框 onInput 必须当场 setState（藏进 ref 会让下发值滞后）', async (c) => {
  /** 从 `onInput=` 起按花括号配平截出处理函数 */
  const handlerOf = (src, at) => {
    const brace = src.indexOf('{', at)
    if (brace < 0) return ''
    let depth = 0
    for (let i = brace; i < src.length && i < brace + 800; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(brace, i + 1)
      }
    }
    return src.slice(brace, brace + 300)
  }

  const bad = []
  for (const f of walk(SRC)) {
    // 组件自身不走页面语义（它只管把 props 原样发给原生）
    if (f.endsWith(path.join('ui', 'textarea.tsx'))) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const tag of ['<Textarea', '<AnswerSolutionEditor']) {
      let at = -1
      while ((at = src.indexOf(tag, at + 1)) >= 0) {
        const close = src.indexOf('/>', at)
        const block = src.slice(at, close < 0 ? Math.min(at + 1600, src.length) : close + 2)
        let i = -1
        while ((i = block.indexOf('onInput=', i + 1)) >= 0) {
          const body = handlerOf(block, i)
          // 纯转发（把 detail.value 交给上层）不适用本规则
          const isForward = /onInput\s*\(\s*e\.detail\.value/.test(body)
          const hasSetState = /\b(set[A-Z]\w*|updateDraft|updateEntry|updateForm)\s*\(/.test(body)
          if (!isForward && !hasSetState) {
            const line = src.slice(0, at).split('\n').length
            bad.push(rel(f) + ':' + line)
          }
        }
      }
    }
  }
  c.eq(
    bad.length,
    0,
    `以下多行输入框的 onInput 没有当场 setState（下发值会滞后 ⇒ 覆盖用户刚打的字）：${bad.slice(0, 8).join('、')}`
  )
})

export default m
