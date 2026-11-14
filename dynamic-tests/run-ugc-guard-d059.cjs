/* UGC 文本入库闸门离线实证（D-059 / 方案 A）
 *
 * 背景：D-058 删除智能客服后，用户可达链路的 msgSecCheck 调用数为 0。
 * 本轮把 ContentCheckService 复用到 5 条文本入库链路，统一走 UgcTextGuard。
 *
 * 本脚本直接加载 nest build 的 CommonJS 产物，注入假的 ContentCheckService，
 * 验证「命中违规拒绝入库 / 正常放行 / 空文本不送检 / 去重 / 白名单不扩大外发」，
 * 并用源码静态断言检查 5 个 service 都接了闸门、5 个 module 都引入了 SecurityModule。
 *
 * 不连数据库、不连微信、不写生产。跑法（项目根目录）：
 *   pnpm build:server && node dynamic-tests/run-ugc-guard-d059.cjs
 */
const { createRequire } = require('node:module')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const serverReq = createRequire(path.join(ROOT, 'server/package.json'))
const dist = (rel) => path.join(ROOT, 'server', 'dist', rel)
const src = (rel) => path.join(ROOT, 'server', 'src', rel)
const read = (p) => fs.readFileSync(p, 'utf8')

const {
  UgcTextGuard, UGC_REJECT_MESSAGE, questionTexts,
} = serverReq(dist('security/ugc-text-guard.service.js'))
const { BadRequestException } = serverReq('@nestjs/common')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

/** 假检测器：记录每次调用，按预设结果返回 */
function fakeCheck(result) {
  const calls = []
  return {
    calls,
    async checkText(text, opts) {
      calls.push({ text, opts })
      return result
    },
  }
}

async function main() {
  console.log('D-059 UGC 文本入库闸门离线实证')

  // 1. 空文本 / 仅图片字段 ⇒ 一次检测都不发
  {
    const fake = fakeCheck({ allowed: false, suggest: 'reject' })
    const guard = new UgcTextGuard(fake)
    await guard.assertAllowed('u1', [undefined, null, '', '   '], { tag: 'image-only' })
    ok(fake.calls.length === 0, '只改图片 / 空文本时不调用检测（避免无意义外发）')
  }

  // 2. 正常文本放行，且 scene 默认值与 userId 透传正确
  {
    const fake = fakeCheck({ allowed: true, suggest: 'pass' })
    const guard = new UgcTextGuard(fake)
    await guard.assertAllowed('u1', ['三角形的面积', '等于底乘高除以二'], { tag: 'timeline.create' })
    ok(fake.calls.length === 1, '正常文本调用一次检测并放行')
    ok(fake.calls[0].opts.userId === 'u1' && fake.calls[0].opts.scene === 2,
      'userId 与默认 scene=2 正确透传给 msgSecCheck')
    ok(fake.calls[0].text === '三角形的面积\n等于底乘高除以二', '多字段合并为一次送检')
  }

  // 3. 重复文本去重（批量保存时题干/解析常重复）
  {
    const fake = fakeCheck({ allowed: true, suggest: 'pass' })
    const guard = new UgcTextGuard(fake)
    await guard.assertAllowed('u1', ['同一句', ' 同一句 ', '同一句'])
    ok(fake.calls[0].text === '同一句', '重复文本去重，不把同一段内容重复外发')
  }

  // 4. reject / risky 都拒绝入库，且错误文案不泄漏命中细节
  for (const suggest of ['reject', 'risky']) {
    const fake = fakeCheck({ allowed: false, suggest, label: 10001 })
    const guard = new UgcTextGuard(fake)
    let err = null
    try {
      await guard.assertAllowed('u1', ['违规内容'], { tag: 'memory.create' })
    } catch (e) { err = e }
    ok(err instanceof BadRequestException, `${suggest} ⇒ 抛 400 拒绝入库`)
    ok(err && err.message === UGC_REJECT_MESSAGE, `${suggest} ⇒ 统一文案且不泄漏 label / 命中词`)
  }

  // 5. 昵称走 scene=1（资料），成长记忆走 scene=4（社交日志）
  {
    const fake = fakeCheck({ allowed: true, suggest: 'pass' })
    const guard = new UgcTextGuard(fake)
    await guard.assertAllowed('u1', ['昵称'], { scene: 1, tag: 'nickname' })
    await guard.assertAllowed('u1', ['日记'], { scene: 4, tag: 'memory.create' })
    ok(fake.calls[0].opts.scene === 1 && fake.calls[1].opts.scene === 4,
      'scene 按场景区分（资料=1 / 社交日志=4）')
  }

  // 6. 检测不可用（skipped）时放行 —— 与底层 best-effort 一致，不伪装成全覆盖
  {
    const fake = fakeCheck({ allowed: true, suggest: 'skipped' })
    const guard = new UgcTextGuard(fake)
    let threw = false
    try { await guard.assertAllowed('u1', ['任意']) } catch { threw = true }
    ok(!threw, '检测不可用时放行（诚实边界：best-effort，不是强制阻断）')
  }

  // 7. questionTexts 白名单：只收用户可编辑文本，不收 file_key / url / 机器 JSON
  {
    const texts = questionTexts({
      question: '题干', answer: '答案', solution: '解析', wrong_answer: '错答',
      stem: '父题干', question_label: 'Ⅱ.18',
      question_images: ['blobs/ab/hash/display.webp'], answer_refs: [{ title: '外链', url: 'https://x' }],
    })
    ok(texts.filter(Boolean).length === 6, 'questionTexts 恰好收 6 个文本字段')
    ok(!texts.join('|').includes('blobs/') && !texts.join('|').includes('https://'),
      '白名单不把图片 key / URL 送检（控制外发范围）')
  }

  // 8. 五条入库链路都接了闸门
  const services = [
    'auth/auth.service.ts', 'timeline/timeline.service.ts', 'memory/memory.service.ts',
    'questions/questions.service.ts', 'subjects/subjects.service.ts',
  ]
  for (const f of services) {
    const s = read(src(f))
    ok(s.includes('UgcTextGuard') && s.includes('assertAllowed'), `${f} 已接入闸门`)
  }
  const timeline = read(src('timeline/timeline.service.ts'))
  ok(['timeline.create', 'timeline.batch', 'timeline.update'].every((t) => timeline.includes(t)),
    'timeline 创建 / 批量 / 更新三条写入口全覆盖')

  // 9. 五个 module 都引入了 SecurityModule（否则 Nest 运行时 DI 会炸）
  const modules = [
    'auth/auth.module.ts', 'timeline/timeline.module.ts', 'memory/memory.module.ts',
    'questions/questions.module.ts', 'subjects/subjects.module.ts',
  ]
  for (const f of modules) {
    ok(read(src(f)).includes('SecurityModule'), `${f} 已 imports SecurityModule`)
  }
  const secMod = read(src('security/security.module.ts'))
  ok(secMod.includes('UgcTextGuard') && (secMod.match(/exports:/) || [''])[0].length > 0,
    'SecurityModule 导出 UgcTextGuard')

  // 10. 外网请求加超时，避免检测接口挂住把保存链路拖过前端 60s
  const cc = read(src('security/content-check.service.ts'))
  ok((cc.match(/AbortSignal\.timeout/g) || []).length === 2,
    'token 与 msgSecCheck 两次外网 fetch 都带 3s 超时')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
