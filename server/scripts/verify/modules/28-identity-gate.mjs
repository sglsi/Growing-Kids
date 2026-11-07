// 模块 28：身份契约收敛与匿名空壳治理（P-007 / D-010）
//
// 为什么单独一个模块：这轮动的是「谁能凭空获得一个 users 行」——
// 身份建号链路。改错了最坏是「用户数据分家」（P-007 ⑤ falsifier #2），
// 比普通功能 bug 严重一个量级，且**静默**：空壳会继续涨、老用户换机
// 会突然找不到题，都不会报错。所以四层各钉一遍：
//   ① 纯函数层：格式白名单 + 滑动窗口阈值（含现存 device_id 回归样本）
//   ② 静态源码层：闸门只挂 insert 分支、拒绝有专门错误与 429 回报、
//      清理脚本 dry-run / 逐表零数据 / 分批校行数、身份契约三处注释
//   ③ 文档口径层：隐私清单全篇 7 项、第 7 项用途短句逐字一致、C1 文案
//   ④ 接口层：陌生 device 仍能建号、同一 device 重复引导幂等
//
// ⚠️ 本模块守的是**行为契约**，不是「文档里写了」。断言失败要么是实现偏了，
//    要么是提案单改了 —— 两种都必须先改 P-007 / D-010 再改这里。

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { Module } from '../lib/harness.mjs'

const m = new Module('M28', '身份契约收敛与匿名空壳治理（P-007 / D-010）')

const ROOT = path.resolve(process.cwd(), '..')
const TMP = path.join(ROOT, '.tmp', 'verify-identity-gate')
const GUARD = 'server/src/shared/anon-bootstrap-guard.ts'
const USERS = 'server/src/users/users.service.ts'
const CTX = 'server/src/shared/user-context.ts'
const BOOTSTRAP = 'src/services/auth-bootstrap.ts'
const CONTROLLER = 'server/src/auth/auth.controller.ts'
const PROFILE = 'src/pages/profile/index.tsx'
const CLEANUP = 'server/scripts/cleanup-empty-anonymous.mjs'
const TOKEN = 'server/src/shared/auth-token.ts'
const QA16 = 'docs/design/GK-QA-16-运维、发布与故障处置手册.md'
const ACCEPT = 'docs/reports/小程序上线验收-差距评估与整改记录.md'
const L3 = 'docs/后端托管-L3实施方案.md'
const PP = 'src/constants/privacy-policy.ts'
const PPDOC = 'docs/legal/隐私政策.md'

const SAVE_PHRASE = '允许你在图片预览中保存题目图片到手机相册'
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function compileGuard() {
  fs.mkdirSync(TMP, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/shared/anon-bootstrap-guard.ts',
      '--outDir', TMP,
      '--module', 'commonjs',
      '--target', 'es2019',
      '--skipLibCheck',
      '--lib', 'es2019',
    ],
    { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
  )
}

let G = null

// ============================================================
// 一、纯函数层
// ============================================================

m.test('单编：shared/anon-bootstrap-guard.ts 可独立编译（零依赖纯函数契约）', async (c) => {
  try {
    compileGuard()
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`
    throw new Error(`anon-bootstrap-guard.ts 单编失败（破坏了"零依赖"契约）：${out.slice(0, 300)}`)
  }
  const p = path.join(TMP, 'anon-bootstrap-guard.js')
  c.ok(fs.existsSync(p), '编译产物不存在')
  G = await import(`file://${p.replace(/\\/g, '/')}`)
  for (const fn of ['isValidDeviceId', 'AnonymousCreationGate', 'AnonymousCreationRejectedError']) {
    c.ok(typeof G[fn] === 'function', `缺少导出 ${fn}`)
  }
  c.ok(typeof G.anonymousCreationGate?.allow === 'function', '缺少进程内单例 anonymousCreationGate')
})

m.test('isValidDeviceId：空串 / 超长 / 空白 / 非法字符一律拒绝', (c) => {
  for (const bad of ['', '   ', 'dev_ x', 'dev_/../../etc', '设备号', 'dev_\n', null, undefined, 123, 'a'.repeat(129)]) {
    c.eq(G.isValidDeviceId(bad), false, `非法串被放行：${JSON.stringify(bad)}`)
  }
  c.eq(G.isValidDeviceId('a'.repeat(128)), true, '刚好 128 字符应放行')
  c.eq(G.isValidDeviceId('abc'), false, '短于 4 字符应拒绝')
})

m.test('🔴 现存 device_id 格式回归样本一律放行（防把老用户判成非法）', (c) => {
  // 收紧 DEVICE_ID_PATTERN 会把这些人判成非法 ⇒ 换手机后题目不见了
  const legacy = [
    'dev_lx9z2k1a8f3d',                       // 前端正式生成式
    'verify-mj2k3x9z-main',                   // 验证套件 ident('main')
    'verify-mj2k3x9z-foe',                    // c.foe()
    'verify-mj2k3x9z-m27',                    // M27
    'ocr-gt-lx9z2k1a',                        // OCR 评测
    'gk_device_0001',                         // 历史 gk_ 前缀
    '00000000-0000-0000-0000-000000000000',   // UUID
    '1234567890',                             // 纯数字
    'wb-e2e-20261105',                        // 端到端脚本
  ]
  for (const id of legacy) c.eq(G.isValidDeviceId(id), true, `存量格式被误判非法：${id}`)
})

m.test('🔴 闸门阈值：窗口内累计新建超阈值 ⇒ 拒绝；窗口滑出后恢复', (c) => {
  let now = 1_000_000
  const gate = new G.AnonymousCreationGate({ windowMs: 1000, maxCreates: 3, now: () => now })
  for (let i = 0; i < 3; i++) {
    c.eq(gate.allow(`dev_legit_${i}`).allowed, true, `第 ${i + 1} 次合法新建被拒`)
  }
  const blocked = gate.allow('dev_legit_4')
  c.eq(blocked.allowed, false, '第 4 次新建没被拦住')
  c.eq(blocked.reason, 'RATE_LIMITED')
  c.eq(gate.stats().blocked, 1)
  // 窗口滑出后恢复
  now += 1001
  c.eq(gate.allow('dev_legit_5').allowed, true, '窗口滑出后没有恢复')
  // 格式非法不占用窗口名额
  const g2 = new G.AnonymousCreationGate({ windowMs: 1000, maxCreates: 2, now: () => now })
  c.eq(g2.allow('bad id').reason, 'INVALID_FORMAT')
  c.eq(g2.allow('dev_a1').allowed, true)
  c.eq(g2.allow('dev_a2').allowed, true, '非法串不该计入窗口名额')
})

m.test('专用错误类型带 reason，且不污染全局 Error', (c) => {
  const e = new G.AnonymousCreationRejectedError('INVALID_FORMAT')
  c.ok(e instanceof Error)
  c.eq(e.reason, 'INVALID_FORMAT')
  c.ok(e.message.includes('匿名建号被闸门拒绝'))
})

// ============================================================
// 二、静态源码层：四处必须同时改，缺一即静默失败
// ============================================================

m.test('🔴 闸门只挂在 findOrCreateByDeviceId 的 insert 分支前，find 分支不得过', (c) => {
  const s = read(USERS)
  const at = s.indexOf('async findOrCreateByDeviceId(')
  c.ok(at > -1, '找不到 findOrCreateByDeviceId')
  const end = s.indexOf('/** 创建一个匿名用户', at)
  c.ok(end > at, '找不到方法边界')
  const body = s.slice(at, end)
  const iFind = body.indexOf('if (existing)')
  const iGate = body.indexOf('anonymousCreationGate.allow')
  const iInsert = body.indexOf('.insert({ is_anonymous: true, expire_at: expireAt, device_id: deviceId })')
  c.ok(iFind > -1 && iGate > -1 && iInsert > -1, 'find / 闸门 / insert 三者有一处缺失')
  c.ok(iFind < iGate && iGate < iInsert, '闸门位置不对：必须在 find 分支之后、insert 之前')
  const findBranch = body.slice(iFind, iGate)
  c.ok(!findBranch.includes('anonymousCreationGate'), 'find 分支被闸门拦了 —— 会伤到现有用户')
  c.ok(!findBranch.includes('AnonymousCreationRejectedError'), 'find 分支抛了拒绝错误 —— 老用户换令牌会失败')
})

m.test('🔴 闸门拒绝有专用错误 + controller 如实回报 429（不伪装成缺参数）', (c) => {
  c.ok(read(USERS).includes('throw new AnonymousCreationRejectedError'), 'users.service 没有抛专用错误')
  const ctl = read(CONTROLLER)
  c.ok(ctl.includes('req.identityRejected'), 'controller 没读 identityRejected')
  c.ok(/429/.test(ctl), 'controller 没回报 429')
  const ctx = read(CTX)
  c.ok(ctx.includes('instanceof AnonymousCreationRejectedError'), '中间件 catch 没识别专用错误')
  c.ok(ctx.includes('req.identityRejected = e.reason'), '中间件没把 reason 透传给 controller')
})

m.test('🔴 清理脚本：默认 dry-run、--apply 才删、逐表零数据、分批校行数', (c) => {
  const s = read(CLEANUP)
  c.ok(s.includes("process.argv.includes('--apply')"), '没有 --apply 开关')
  c.ok(/const dryRun = !APPLY/.test(s), 'dryRun 默认值不对（必须默认只读）')
  c.ok(s.includes('USER_DATA_TABLES'), '缺少逐表零数据核对')
  for (const t of ['timeline_items', 'review_events', 'chat_messages', 'user_quota', 'memories']) {
    c.ok(s.includes(`'${t}'`), `USER_DATA_TABLES 漏了 ${t}（会把有数据的用户误删）`)
  }
  c.ok(/is_anonymous = true/.test(s), '删除条件没限定匿名行，会误删正式账号')
  c.ok(/BATCH_SIZE = 10/.test(s), '没有分批或批次过大')
  c.ok(/returning id/i.test(s), '删除后没有 RETURNING id 校行数（等价 supabase .select(\'id\')）')
  c.ok(/rows\.length !== toDelete\.length/.test(s), '没有「行数不符立即中止」')
  c.ok(s.includes('await busyIds(client, ids)'), 'apply 前没有重新核对零数据')
})

m.test('🔴 身份契约三处头注释一致（令牌 / openid / device_id 各就位）', (c) => {
  for (const f of [CTX, USERS, BOOTSTRAP]) {
    const s = read(f)
    c.ok(s.includes('`X-Auth-Token` 唯一信任根'), `${f} 缺「X-Auth-Token 唯一信任根」`)
    c.ok(s.includes('`openid` 唯一身份'), `${f} 缺「openid 唯一身份」`)
    c.ok(s.includes('`device_id` 临时锚点'), `${f} 缺「device_id 临时锚点」`)
  }
})

m.test('🔴 完全 lazy 建号本轮不做：令牌仍绑定真实 users 行', (c) => {
  const token = read(TOKEN)
  c.ok(/payload = `v1\.\$\{userId\}\.\$\{exp\}`/.test(token), '令牌格式被改了 —— 会动信任根，属 L2')
  c.ok(read(USERS).includes('.insert({ is_anonymous: true, expire_at: expireAt, device_id: deviceId })'),
    'bootstrap 阶段仍应物化 users 行（本轮只收敛，不取消）')
})

// ============================================================
// 三、文档口径层：D（第 7 项）与 C1
// ============================================================

m.test('🔴 隐私清单全篇 7 项、第 7 项用途短句逐字一致', (c) => {
  const qa = read(QA16)
  c.ok(qa.includes('#### 4.5.4 为什么恰好是这 7 项'), 'GK-QA-16 主表标题不是 7 项')
  c.ok(qa.includes('4.5.4.2 已拍板'), 'GK-QA-16 第 7 项仍是「待决」')
  c.ok(qa.includes('当前状态：7 项'), 'GK-QA-16 当前状态没写成 7 项')
  c.ok(qa.includes('7 项全勾'), '7.1 清单不是 7 项')
  c.ok(qa.includes(SAVE_PHRASE), 'GK-QA-16 缺第 7 项用途短句')
  const accept = read(ACCEPT)
  c.ok(accept.includes('用户隐私保护指引（7 项）'), '验收记录 ③ 标题不是 7 项')
  c.ok(accept.includes(SAVE_PHRASE), '验收记录缺第 7 项用途短句')
  // L3 方案里写作「隐私指引 **7 项**」（带加粗），用正则兼容 Markdown 强调
  c.ok(/隐私指引\s*\*{0,2}\s*7 项/.test(read(L3)), 'L3 方案没同步 7 项')
  c.ok(read(PP).includes("PRIVACY_POLICY_VERSION = '2026-11-07-r8'"), '应用内隐私政策没升 r8（P-011 公共资料库口径订正）')
  c.ok(read(PPDOC).includes('2026-11-07-r8'), 'docs/legal 镜像没升 r8')
  // 用途短句逐字一致：4.5.4.2 拍板段 / 4.5.5 用途表第 7 行 / 验收记录第 7 行
  // ⚠️ 不能用「!includes('保存所有图片')」这种宽检查——GK-QA-16 4.5.5 末尾
  //    有「不要临场改写成…或『保存所有图片』」的**否定示例**，那是合规说明不是改写。
  c.ok(qa.includes(`**用途短句（逐字填，不要改写）**：\`${SAVE_PHRASE}\``),
    'GK-QA-16 4.5.4.2 用途短句未逐字写死')
  c.ok(qa.includes(`| 相册（仅写入） | \`${SAVE_PHRASE}\` |`), 'GK-QA-16 4.5.5 第 7 行用途短句不一致')
  c.ok(accept.includes(`| \`${SAVE_PHRASE}\` | 相册（仅写入） |`), '验收记录第 7 行用途短句不一致')
})

m.test('🔴 C1 文案在「我的」页：含「换手机前」「无法找回」，不含门槛话术', (c) => {
  const s = read(PROFILE)
  c.ok(s.includes('换手机前'), '缺「换手机前」引导')
  c.ok(s.includes('无法找回'), '没有如实告知「未登录换机找不回」')
  c.ok(s.includes('换手机后用同一微信账号登录即可找回'), '已登录分支没给找回口径')
  for (const w of ['必须登录才能用', '解锁', '数据永不丢失', '自动同步所有内容', '智能识别设备', '精准找回']) {
    c.ok(!s.includes(w), `出现门槛话术 / 禁用宣称「${w}」（GK-SRS-20a M10 / M11）`)
  }
})

m.test('H2 口径：本轮新增文案不含禁用宣称词', (c) => {
  const s = read(PROFILE) + read(BOOTSTRAP) + read(CLEANUP) + read(GUARD)
  for (const w of ['ZPD', '最近发展区', '智能水平', '智商', '天赋', '学习风格', '左右脑', '提分', '过目不忘']) {
    c.ok(!s.includes(w), `出现禁用宣称「${w}」（GK-SRS-20a M10 / 20b §5.3）`)
  }
})

// ============================================================
// 四、接口层：闸门不误伤正常路径
// ============================================================

m.test('🔴 接口：陌生 device 仍能建号、同一 device 重复引导幂等', async (c) => {
  const id = await c.ident('m28')
  c.ok(!!id.token, '正常陌生设备被闸门误伤，拿不到 auth_token')
  c.ok(!!id.userId, '没回传 user_id')
  const res = await c.api('POST', '/auth/anonymous', { device: id.deviceId })
  c.status(res, 200, '同一 device 重复引导失败（find 分支被闸门影响）')
  c.eq(res.json?.data?.user_id, id.userId, '同一 device 换出了不同的 user_id')
})

export default m
