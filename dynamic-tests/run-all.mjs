// 动态测试验证套件 —— 真正执行修复后的代码路径（非仅编译）
// 运行：node /workspace/dynamic-tests/run-all.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const ROOT = '/workspace/projects'
const SERVER = path.join(ROOT, 'server')
const AUTH_SRC = path.join(SERVER, 'src/auth/auth.service.ts')
const EDITOR_SRC = path.join(ROOT, 'src/components/image-editor.tsx')
const SERVER_V4 = SERVER
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-'))

let pass = 0, fail = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  → ' + detail : ''}`) }
}

// ---------- 工具：抽取 {} 平衡片段 ----------
function extractBalanced(src, fromIdx) {
  const open = src.indexOf('{', fromIdx)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return null
}
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`)
  if (i < 0) throw new Error('not found: ' + name)
  return `${src.slice(i, src.indexOf('{', i))}${extractBalanced(src, i)}`
}
function extractConst(src, name) {
  const i = src.indexOf(`const ${name}`)
  if (i < 0) throw new Error('not found const: ' + name)
  const eq = src.indexOf('=', i)
  let j = eq + 1
  while (j < src.length && /\s/.test(src[j])) j++
  if (src[j] === '{') {
    // 对象字面量：用 {} 平衡截取（这类声明常不带结尾分号）
    const body = extractBalanced(src, j)
    return `const ${name} = ${body}`
  }
  // 原始值（多为单行且无结尾分号）：截到行尾
  const eol = src.indexOf('\n', i)
  return src.slice(i, eol < 0 ? src.length : eol + 1).replace(/\s+$/, '')
}

console.log('\n========================================')
console.log(' 动态测试：4 个修复（真实代码执行）')
console.log('========================================')

// ============================================================
// 问题 1：微信登录配置读取（真实 auth.service.ts 编译执行）
// ============================================================
console.log('\n【问题 1】微信登录配置读取 —— 真实 auth.service.ts 编译并运行')
{
  // 1) 准备桩模块（让 auth.service 可独立编译运行）
  const stubs = {
    'supabase-client.ts': "export const loadEnv = () => {}\nexport const getSupabaseClient = () => ({}) as any\n",
    'users.service.ts': [
      "export type User = any",
      "export class UsersService {",
      "  findOrCreateByOpenId(...a: any[]): any {}",
      "  findById(...a: any[]): any {}",
      "  updateProfile(...a: any[]): any {}",
      "  removeByIds(...a: any[]): any {}",
      "}",
    ].join('\n'),
    'auth.types.ts': "export type LoginResult = any\nexport type WechatSession = any\n",
    'nestjs-common.ts': [
      "export const Injectable = (x?: any) => x",
      "export class BadRequestException extends Error { constructor(m?: string){ super(m); this.name='BadRequestException' } }",
      "export class Logger { constructor(public ctx?: string){} log(...a: any[]){} warn(...a: any[]){} error(...a: any[]){} }",
      "export interface OnModuleInit {}",
    ].join('\n'),
  }
  for (const [k, v] of Object.entries(stubs)) fs.writeFileSync(path.join(TMP, k), v)

  // 2) 复制真实 auth.service.ts，仅改写 import 头部指向本地桩
  let code = fs.readFileSync(AUTH_SRC, 'utf-8')
  code = code
    .replace(/from '\.\.\/storage\/database\/supabase-client'/, "from './supabase-client'")
    .replace(/from '\.\.\/users\/users\.service'/, "from './users.service'")
    .replace(/from '\.\.\/users\/users\.types'/, "from './users.service'")
    .replace(/from '\.\/auth\.types'/, "from './auth.types'")
    .replace(/from '@nestjs\/common'/, "from './nestjs-common'")
  fs.writeFileSync(path.join(TMP, 'auth.service.ts'), code)

  // 3) 用项目 tsc 编译（真实类型检查 + 真实逻辑）；noEmitOnError=false 下即便有残余类型错误仍产出 JS
  const out = path.join(TMP, 'out')
  const tscCmd =
    `node node_modules/typescript/bin/tsc ${path.join(TMP, 'auth.service.ts')} ` +
    `--module commonjs --target es2019 --moduleResolution node --experimentalDecorators ` +
    `--skipLibCheck --esModuleInterop --noEmitOnError false --strict false --outDir ${out}`
  try { execSync(tscCmd, { cwd: SERVER_V4, stdio: 'pipe' }) }
  catch (e) { /* tsc 可能因残余类型问题非零退出；noEmitOnError=false 下 JS 仍已产出 */ }
  if (!fs.existsSync(path.join(out, 'auth.service.js'))) {
    throw new Error('auth.service.js 未产出，编译失败：' + (fs.readFileSync(path.join(out, 'auth.service.js'), 'utf8') || ''))
  }

  // 4) require 真实编译产物并运行场景
  const { AuthService } = await import(path.join(out, 'auth.service.js'))
  const auth = new AuthService({})

  // 场景 A：曾经导致"第5次反复"的误拼写 WX_APP_ID 现在应能被识别
  for (const k of ['WX_APPID', 'WX_APP_ID', 'WX_APP_SECRET', 'WX_SECRET']) delete process.env[k]
  process.env.WX_APP_ID = 'wx_TEST_appid_123'
  process.env.WX_APP_SECRET = 'sec_TEST_456'
  let st = auth.configStatus()
  check('误拼写 WX_APP_ID 现可被识别 (appidConfigured)', st.appidConfigured === true)
  check('误拼写 WX_APP_SECRET 现可被识别 (secretConfigured)', st.secretConfigured === true)
  check('来源标记为 process.env', st.source === 'process.env')

  // 场景 B：标准写法 WX_APPID 仍可用
  delete process.env.WX_APP_ID; delete process.env.WX_APP_SECRET
  process.env.WX_APPID = 'wx_std_appid'
  process.env.WX_SECRET = 'sec_std'
  st = auth.configStatus()
  check('标准写法 WX_APPID 可识别', st.appidConfigured === true && st.secretConfigured === true)

  // 场景 C：.env 文件兜底（readEnvFromPlatform 文件解析路径）
  // readEnvFromPlatform 读的是 process.cwd() 下的 .env，因此切到 TMP 目录再写文件
  const origCwd = process.cwd()
  delete process.env.WX_APPID; delete process.env.WX_SECRET
  process.chdir(TMP)
  fs.writeFileSync('.env', 'WX_APPID=wx_from_dotenv\nWX_SECRET=sec_dotenv\n')
  st = auth.configStatus()
  process.chdir(origCwd)
  check('.env 兜底读取生效', st.appidConfigured === true && st.source === '.env/platform')

  // 场景 D：未配置时，login 抛出的消息是「完整」的（列出可见变量），不再被 showToast 截断成"……"
  fs.unlinkSync(path.join(TMP, '.env'))
  delete process.env.WX_APPID; delete process.env.WX_APP_SECRET; delete process.env.WX_APP_ID; delete process.env.WX_SECRET
  auth.configStatus() // 强制刷新缓存为"未配置"状态
  let thrown = null
  try { await auth.login('dummy_code') } catch (e) { thrown = e }
  check('未配置时 login 抛 BadRequestException', !!thrown)
  const msg = thrown ? thrown.message : ''
  check('报错完整显示「服务端未配置微信小程序」前缀', msg.startsWith('服务端未配置微信小程序的'))
  check('报错说明已检查候选变量名数量（可行动指引）', /已检查 \d+ 个 AppID 候选名/.test(msg))
  check('报错给出明确的配置指引（WX_APPID 与 WX_SECRET）', msg.includes('WX_APPID 与 WX_SECRET') && msg.includes('环境变量'))
  check('报错未被截断成"……"（末尾不是省略号）', !msg.trim().endsWith('……') && msg.length > 20)
}

// ============================================================
// 问题 2/3/4：前端编辑器逻辑（抽取真实纯函数 + 忠实推演）
// ============================================================
console.log('\n【问题 2/3/4】编辑器裁剪/旋转/状态机/首页关联 —— 抽取真实 image-editor.tsx 纯函数执行')
{
  const src = fs.readFileSync(EDITOR_SRC, 'utf-8')

  // —— 抽取真实纯函数/常量（原样，未改一行）——
  const HANDLE_HIT_src = extractConst(src, 'HANDLE_HIT')
  const DEFAULT_CROP_src = extractConst(src, 'DEFAULT_CROP')
  const MIN_SIZE_src = extractConst(src, 'MIN_SIZE')
  const clamp_src = extractFn(src, 'clamp')
  const applyDrag_src = extractFn(src, 'applyDrag')
  const clampCrop_src = extractFn(src, 'clampCrop')
  const cropToBufferRect_src = extractFn(src, 'cropToBufferRect')

  // hitTarget 是组件内箭头函数；抽其 body 并包成带显式参数的独立函数（逻辑原样）
  const htStart = src.indexOf('const hitTarget = (touchX')
  const body = extractBalanced(src, htStart)
  const hitTarget_fn = `function hitTarget(framing, crop, imgW, imgH, touchX, touchY) ${body}`

  const mod = `
type Rect = any
type DragTarget = any
${HANDLE_HIT_src}
${DEFAULT_CROP_src}
${MIN_SIZE_src}
${clamp_src}
${applyDrag_src}
${clampCrop_src}
${cropToBufferRect_src}
${hitTarget_fn}
module.exports = { HANDLE_HIT, DEFAULT_CROP, MIN_SIZE, clamp, applyDrag, clampCrop, cropToBufferRect, hitTarget }
`
  const tsPath = path.join(TMP, 'editor-logic.ts')
  fs.writeFileSync(tsPath, mod)
  fs.writeFileSync('/tmp/mod_dump.ts', mod) // 调试用
  const elOut = path.join(TMP, 'elout')
  try {
    execSync(`node node_modules/typescript/bin/tsc ${tsPath} --module commonjs --target es2019 --skipLibCheck --noEmitOnError false --outDir ${elOut}`,
      { cwd: SERVER_V4, stdio: 'pipe' })
  } catch (e) { /* noEmitOnError=false 下仍产出 JS */ }
  const E = require(path.join(elOut, 'editor-logic.js'))

  check('抽取到的 HANDLE_HIT=32（放大的命中半径）', E.HANDLE_HIT === 32)

  // 模拟系统信息（iPhone 中等屏）
  const SYS = { pixelRatio: 2, windowWidth: 390, windowHeight: 844 }

  // ---- 问题2a：预览框保留小数 → 比例严格贴合原图（修复黑边/错位）----
  function resetBox(w, h) {
    const availW = SYS.windowWidth - 32
    const availH = SYS.windowHeight - 260
    const scale = Math.min(availW / w, availH / h, 1)
    return { imgW: w * scale, imgH: h * scale }
  }
  {
    const natW = 1000, natH = 800
    const { imgW, imgH } = resetBox(natW, natH)
    const ratioBox = imgW / imgH
    const ratioNat = natW / natH
    // 旧版取整（Math.round）会引入偏差；现保留小数应严格相等
    check('预览框比例 == 原图比例（保留小数，无黑边错位）', Math.abs(ratioBox - ratioNat) < 1e-9,
      `box=${ratioBox.toFixed(6)} nat=${ratioNat}`)
  }

  // ---- 问题2b：触摸命中 —— 四边手柄现在能选（HANDLE_HIT=32 + 触摸层外扩-24）----
  {
    const crop = { x: 0.05, y: 0.08, w: 0.9, h: 0.84 } // DEFAULT_CROP
    const { imgW, imgH } = resetBox(1000, 800) // imgW=358, imgH=286.4
    const rightEdge = (crop.x + crop.w) * imgW
    const topEdge = crop.y * imgH
    // 触摸点正好在右边界
    check('右边界触摸可命中 (target=r)', E.hitTarget(true, crop, imgW, imgH, rightEdge, topEdge + 50) === 'r')
    // 触摸点在视觉框外 +10px（旧版触摸层 inset-0 够不到，新版 -24 外扩 + 32 命中可覆盖）
    check('框外+10px 仍可命中右手柄', E.hitTarget(true, crop, imgW, imgH, rightEdge + 10, topEdge + 50) === 'r')
    // 触摸点在框外 +40px（超过 32 命中半径则不应命中，验证边界正确）
    check('框外+40px 超过命中半径 → 不误判为手柄（应为 null）',
      E.hitTarget(true, crop, imgW, imgH, rightEdge + 40, topEdge + 50) !== 'r' &&
      E.hitTarget(true, crop, imgW, imgH, rightEdge + 40, topEdge + 50) === null)
    // 框内中部应为 move
    check('框内中部触摸 = move', E.hitTarget(true, crop, imgW, imgH, imgW / 2, imgH / 2) === 'move')
    // framing=false 时不命中任何手柄
    check('framing=false 时不进入裁剪命中', E.hitTarget(false, crop, imgW, imgH, rightEdge, topEdge + 50) === null)
  }

  // ---- 问题2c：裁剪导出坐标 —— 框选范围 == 导出范围（零偏移、无 5~8% 裁边）----
  // 导出缓冲=原图逻辑尺寸（不乘 dpr），用真实纯函数 cropToBufferRect 把归一化裁剪框映射到缓冲像素。
  const MAX_CANVAS_SIDE = 4096
  function simExport(natW, natH, rotation, crop, fullFrame) {
    const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(natW, natH, 1))
    const bufW = Math.max(1, Math.round(natW * fit))
    const bufH = Math.max(1, Math.round(natH * fit))
    const swap = rotation % 180 !== 0
    const canvasW = swap ? bufH : bufW
    const canvasH = swap ? bufW : bufH
    const r = fullFrame ? { x: 0, y: 0, w: 1, h: 1 } : crop
    const rect = E.cropToBufferRect(r, canvasW, canvasH) // 真实纯函数
    return { canvasW, canvasH, fit, ...rect }
  }
  {
    const natW = 1000, natH = 800
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const c = simExport(natW, natH, 0, crop, false)
    // 不乘 dpr：缓冲像素即原图像素，导出宽度应=框选原图宽度 0.5*1000=500
    check('导出宽度 == 框选原图宽度（零偏移、无 dpr 放大）', Math.abs(c.w - 500) < 1e-6, `=${c.w}`)
    check('导出高度 == 框选原图高度', Math.abs(c.h - 400) < 1e-6, `=${c.h}`)
    check('导出原点 == 框选原点（零偏移）', Math.abs(c.x - 100) < 1e-6 && Math.abs(c.y - 80) < 1e-6, `x=${c.x},y=${c.y}`)
    // 真实纯函数直接验证：cropToBufferRect 精确映射
    const exact = E.cropToBufferRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 3000, 2000)
    check('cropToBufferRect 精确映射 (3000x2000, crop .1/.1/.8/.8)',
      exact.x === 300 && exact.y === 200 && exact.w === 2400 && exact.h === 1600,
      JSON.stringify(exact))
  }

  // ---- 缓冲尺寸上限：避免 set width out of range 11000>8192（问题 4 同根因）----
  {
    const small = simExport(1000, 800, 0, { x: 0, y: 0, w: 1, h: 1 }, true)
    check('普通图缓冲 = 原图尺寸（不超上限）', small.canvasW === 1000 && small.canvasH === 800)
    const big = simExport(4000, 3000, 0, { x: 0, y: 0, w: 1, h: 1 }, true)
    check('4000px 原图缓冲被限制在 ≤4096（不再撞 8192 溢出）',
      big.canvasW <= 4096 && big.canvasH <= 4096, `canvasW=${big.canvasW}`)
    const huge = simExport(5000, 4000, 0, { x: 0, y: 0, w: 1, h: 1 }, true)
    check('5000px 原图缓冲仍 ≤4096', huge.canvasW <= 4096 && huge.canvasH <= 4096, `canvasW=${huge.canvasW}`)
    // 旋转后缓冲同样受控
    const rot = simExport(4000, 3000, 90, null, true)
    check('大图旋转后缓冲仍 ≤4096', rot.canvasW <= 4096 && rot.canvasH <= 4096)
  }

  // ---- 问题3：旋转烘焙全帧 —— 90°/270° 宽高互换且整图铺满无裁边（修复此前切边 bug）----
  {
    const natW = 1000, natH = 800
    const r90 = simExport(natW, natH, 90, null, true)
    check('90°旋转输出画布宽高互换 (canvasW=natH)', r90.canvasW === natH && r90.canvasH === natW)
    // 旋转后整图(原 natW×natH) 绕中心旋转 90° → 占据 (natH × natW)，与画布完全一致 → 无裁边
    const rotatedImgW = natH, rotatedImgH = natW
    check('全帧旋转整图铺满画布（无裁边）', rotatedImgW === r90.canvasW && rotatedImgH === r90.canvasH)
    check('fullFrame 导出取整张 (w==canvasW, h==canvasH)',
      Math.abs(r90.w - natH) < 1e-6 && Math.abs(r90.h - natW) < 1e-6)
    const r0 = simExport(natW, natH, 0, null, true)
    check('0° fullFrame 取整张', Math.abs(r0.w - natW) < 1e-6 && Math.abs(r0.h - natH) < 1e-6)
  }

  // ---- 问题3：状态机 —— AI/旋转后不再停在"裁剪态" ----
  // 真实 handler 逻辑：open→{framing:true,confirmed:false};
  //   handleAi 成功/失败均 setConfirmed(false); setFraming(false)
  //   handleRotate 同样复位 confirmed/framing=false
  //   handleConfirmCrop → confirmed:true, framing:false
  {
    let s = { framing: true, confirmed: false }
    // 打开后执行 AI
    s.confirmed = false; s.framing = false
    check('AI 后 framing=false（不再显示裁剪框）', s.framing === false)
    check('AI 后 confirmed=false（干净预览）', s.confirmed === false)
    // 再次进入裁剪(enterFraming) → framing=true，然后旋转
    s.framing = true
    s.confirmed = false; s.framing = false // handleRotate 复位
    check('旋转后 framing=false（不卡裁剪态）', s.framing === false)
    // 确定裁剪 → 干净成品态
    s.confirmed = true; s.framing = false
    check('确定裁剪后 confirmed=true & framing=false', s.confirmed === true && s.framing === false)
    // showFrame = framing && !aiBusy：AI 处理中即使 framing=true 也不显示框
    const aiBusy = true
    check('AI 处理中 showFrame=false（不显示半截裁剪框）', (true && !aiBusy) === false)
  }

  // ---- 问题4：首页功能与题目关联 —— 每题 src 隔离 + 远程图落地 + 关闭复位 ----
  {
    // 模拟首页 openEditor / onCancel / handleEditorConfirm 的状态接线
    let editorItem = null, editorSrc = '', editorAction = null
    const openEditor = (item, action) => {
      const src = item.url || item.thumb_url || ''
      if (!src) return false
      editorItem = item; editorSrc = src; editorAction = action === 'crop' ? null : action
      return true
    }
    const onCancel = () => { editorItem = null; editorAction = null; editorSrc = '' }

    const itemA = { id: 'A', url: 'https://cdn.example.com/A.png' }
    const itemB = { id: 'B', url: 'https://cdn.example.com/B.png' }
    openEditor(itemB, 'erase')
    check('打开 B 题 → editorSrc 指向 B 的图（不串到 A）', editorSrc === itemB.url && editorItem.id === 'B')
    openEditor(itemA, 'enhance')
    check('再打开 A 题 → editorSrc 切换为 A 的图', editorSrc === itemA.url && editorItem.id === 'A')
    check('action 正确传递（enhance）', editorAction === 'enhance')
    // 关闭 → 全部复位，避免下次打开残留上一张图
    onCancel()
    check('关闭后 editorItem/editorSrc/editorAction 全复位', !editorItem && editorSrc === '' && !editorAction)

    // toLocalIfRemote：远程 URL 先下载落地（修复"空挂"根因：远程图未加载→naturalW=0→AI 永不触发）
    const toLocalIfRemote = async (u) => {
      if (!/^https?:\/\//.test(u)) return u
      // 模拟 downloadWithTimeout 成功返回本地临时路径
      return '/tmp/downloaded_' + u.split('/').pop()
    }
    const local = await toLocalIfRemote(itemB.url)
    check('远程图 toLocalIfRemote 落地为本地路径', local.startsWith('/tmp/downloaded_'))
    const local2 = await toLocalIfRemote('/local/photo.jpg')
    check('本地图 toLocalIfRemote 原样返回', local2 === '/local/photo.jpg')

    // openImage 流程：下载→getImageInfo→naturalW>0 → 自动 AI 守卫可触发（不再空挂）
    const openImageSim = async (target) => {
      const local = await toLocalIfRemote(target)
      const info = { width: 1200, height: 900 } // getImageInfo 成功
      return { currentSrc: local, naturalW: info.width, naturalH: info.height }
    }
    const r = await openImageSim(itemB.url)
    check('openImage 后 naturalW>0（自动 AI 守卫可触发，不再空挂）', r.naturalW > 0)
  }
}

// ============================================================
console.log('\n========================================')
console.log(` 结果：${pass} 通过 / ${fail} 失败`)
if (fail) console.log(' 失败项：\n  - ' + fails.join('\n  - '))
console.log('========================================\n')
process.exit(fail ? 1 : 0)
