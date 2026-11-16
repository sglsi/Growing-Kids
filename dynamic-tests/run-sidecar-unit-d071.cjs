/**
 * D-071 侧车「空闲回收 + 被调用可靠拉起」离线实证（不连数据库、不连微信、不碰生产）
 *
 * 做法：直接用**编译产物** `server/dist/ocr/sidecar.supervisor.js` 跑真实状态机，
 * 但把 systemd 换成一个可观测的假单元（`unitCmd` 注入）：假单元 = 本地一个只回
 * `/healthz` 的 HTTP 服务，start 时起、stop 时停。于是可以真实验证：
 *   ① 睡着时调用会触发 start 并等到 /healthz 通过才放行；
 *   ② 空闲超时真的会回收（发 stop）；
 *   ③ **回收之后还能再被叫醒**（旧实现 stop() 会永久清掉巡检定时器，只能回收一次）；
 *   ④ gk-api 进程退出不会顺手停掉共享单元；
 *   ⑤ 单元模式起不来时 withSidecar 返回 null（降级），不抛错拖垮主链路；
 *   ⑥ 健康探针不会把「空闲故意睡着」当故障告警。
 *
 * ⚠️ 只能证明状态机与降级语义；生产上 `systemctl`/sudoers/真实冷启耗时必须另外实跑。
 */
const http = require('http')
const net = require('net')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SUP = path.join(ROOT, 'server', 'dist', 'ocr', 'sidecar.supervisor.js')
const HEALTH = path.join(ROOT, 'server', 'dist', 'ocr', 'ocr-health.js')

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) {
    pass++
    console.log(`  PASS ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 拿一个当前空闲的端口（先听再关，避免与其他进程撞车） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

async function main() {
  console.log('D-071 侧车空闲回收 / 按需拉起 实证')

  const { SidecarSupervisor } = require(SUP)
  const { OcrHealthProbe } = require(HEALTH)
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  // ---- 假单元：就是本机一个 /healthz 200 + /ppsv3 200 的小服务 ----
  let server = null
  const actions = []
  const alertEvents = []
  let warmups = 0
  let ppsv3Status = 200

  const startStub = () =>
    new Promise((resolve, reject) => {
      if (server) return resolve()
      server = http.createServer((req, res) => {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } else if (req.url === '/ppsv3' && req.method === 'POST') {
          warmups++
          res.writeHead(ppsv3Status, { 'Content-Type': 'application/json' })
          res.end(ppsv3Status === 200 ? '{"block_count":1}' : '{"detail":"boom"}')
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  const stopStub = () =>
    new Promise((resolve) => {
      if (!server) return resolve()
      const s = server
      server = null
      s.close(() => resolve())
    })

  const makeSup = (over = {}) =>
    new SidecarSupervisor({
      unit: 'gk-ppsv3-fake',
      supervise: '1',
      host: '127.0.0.1',
      port,
      baseUrl,
      idleTimeoutMs: 400,
      monitorMs: 80,
      tightRssBytes: 0,
      startTimeoutMs: 4000,
      alertSink: { alert: (e) => alertEvents.push(e) },
      unitCmd: async (action, unit) => {
        actions.push(`${action}:${unit}`)
        if (action === 'start' || action === 'restart') {
          await startStub()
        } else if (action === 'stop') {
          await stopStub()
        }
        return { ok: true, out: '' }
      },
      ...over,
    })

  // ---- ① 初始状态：单元模式，睡着 ----
  console.log('\n① 初始状态')
  let sup = makeSup()
  let st = sup.getState()
  ok(st.mode === 'unit', `mode=unit（实际 ${st.mode}）`)
  ok(st.unit === 'gk-ppsv3-fake', 'unit 名透传到状态快照')
  ok(st.running === false && st.sleeping === true, '未启动时 isSleeping=true')
  ok(actions.length === 0, '构造侧车守护不会主动拉起单元（惰性）')

  // ---- ② 被调用 → 自动 start 并等 healthz ----
  console.log('\n② 睡着时被调用')
  const t0 = Date.now()
  const r1 = await sup.withSidecar(async () => 'ok-1')
  ok(r1 === 'ok-1', `withSidecar 返回业务结果（实际 ${r1}）`)
  ok(actions[0] === 'start:gk-ppsv3-fake', `首次调用触发 start（实际 ${actions[0]}）`)
  ok(sup.getState().running === true && sup.getState().sleeping === false, '启动后 running=true')
  ok(warmups === 1, `/healthz 通过后先跑一次预热（实际 ${warmups} 次）——否则首个真实请求要白等模型加载`)
  ok(Date.now() - t0 < 4000, '未耗满 startTimeout')

  // ---- ③ 再调用不重复 start ----
  console.log('\n③ 连续调用不重复拉起')
  const before = actions.length
  await sup.withSidecar(async () => 'ok-2')
  ok(actions.length === before, `第二次调用未再 start（actions=${actions.join(',')}）`)

  // ---- ④ 空闲超时 → 回收 ----
  console.log('\n④ 空闲回收')
  await sleep(900)
  ok(actions.includes('stop:gk-ppsv3-fake'), `空闲后发出 stop（actions=${actions.join(',')}）`)
  ok(await new Promise((r) => setTimeout(() => r(!server), 50)), '假单元进程确实停了')
  st = sup.getState()
  ok(st.running === false && st.sleeping === true, '回收后状态回到 sleeping')

  // ---- ⑤ 回收后还能再叫醒（旧实现只能回收一次）----
  console.log('\n⑤ 回收后再次被叫醒')
  const r2 = await sup.withSidecar(async () => 'ok-3')
  ok(r2 === 'ok-3', '第二轮回调仍成功')
  const starts = actions.filter((a) => a.startsWith('start:')).length
  ok(starts === 2, `start 累计 2 次（实际 ${starts}）`)
  ok(warmups === 2, `每次唤醒各预热一次（实际 ${warmups} 次）`)
  await sleep(900)
  ok(actions.filter((a) => a.startsWith('stop:')).length === 2, '第二轮同样被回收（可反复循环）')

  // ---- ⑥ 进程退出不停共享单元 ----
  console.log('\n⑥ gk-api 退出语义')
  await sup.withSidecar(async () => 'ok-4') // 先把它叫醒
  const stopsBefore = actions.filter((a) => a.startsWith('stop:')).length
  sup.shutdown()
  await sleep(200)
  ok(
    actions.filter((a) => a.startsWith('stop:')).length === stopsBefore,
    'shutdown() 不得停掉共享单元（gk-api 重启不该带走侧车）',
  )
  ok(!!server, 'shutdown 后假单元仍在监听')

  // ---- ⑦ 起不来 → 返回 null 降级 + 告警 ----
  console.log('\n⑦ 启动失败降级')
  await stopStub()
  alertEvents.length = 0
  const broken = makeSup({
    startTimeoutMs: 600,
    unitCmd: async (action) => {
      actions.push(`${action}:broken`)
      return { ok: false, out: 'Job for gk-ppsv3-fake.service failed' }
    },
  })
  const r3 = await broken.withSidecar(async () => 'should-not-run')
  ok(r3 === null, `启动失败返回 null 而非抛错（实际 ${r3}）`)
  ok(alertEvents.includes('sidecar-startup-failed'), `触发 startup-failed 告警（${alertEvents.join(',')}）`)
  broken.shutdown()

  // ---- ⑦b 预热失败不阻断（只降级为「首个请求慢」）----
  console.log('\n⑦b 预热失败不阻断')
  await stopStub()
  ppsv3Status = 500
  const softSup = makeSup({ idleTimeoutMs: 60_000 })
  const r4 = await softSup.withSidecar(async () => 'ok-warmup-fail')
  ok(r4 === 'ok-warmup-fail', `预热报 500 时业务照常放行（实际 ${r4}）`)
  softSup.shutdown()
  await stopStub()
  ppsv3Status = 200

  // ---- ⑧ 健康探针：故意睡着不算故障 ----
  console.log('\n⑧ 健康探针预期离线')
  const probeAlerts = []
  let down = true
  const probe = new OcrHealthProbe({
    probe: async () => !down,
    intervalMs: 30,
    failThreshold: 2,
    alertSink: { alert: (e) => probeAlerts.push(e) },
    expectedDown: () => true,
  })
  probe.start()
  await sleep(300)
  probe.stop()
  ok(probeAlerts.length === 0, `睡着期间零告警（实际 ${probeAlerts.join(',')}）`)

  const probeAlerts2 = []
  const probe2 = new OcrHealthProbe({
    probe: async () => !down,
    intervalMs: 30,
    failThreshold: 2,
    alertSink: { alert: (e) => probeAlerts2.push(e) },
  })
  probe2.start()
  await sleep(300)
  probe2.stop()
  ok(probeAlerts2.includes('sidecar-unreachable'), '没有 expectedDown 时照常告警（对照组，防止探针被改哑）')

  // ---- ⑨ 静态契约 ----
  console.log('\n⑨ 静态契约')
  const fs = require('fs')
  const srcSup = fs.readFileSync(path.join(ROOT, 'server', 'src', 'ocr', 'sidecar.supervisor.ts'), 'utf8')
  const srcCli = fs.readFileSync(path.join(ROOT, 'server', 'src', 'ocr', 'ppsv3.client.ts'), 'utf8')
  ok(srcSup.includes('systemctl ${action}') || srcSup.includes('systemctl'), '启停走 systemctl')
  ok(srcSup.includes('sudo -n'), '默认加 sudo -n（gk-api 以 gk 用户运行）')
  ok(srcSup.includes('PPSV3_UNIT'), '支持 PPSV3_UNIT 环境变量')
  ok(srcCli.includes('expectedDown'), '3.x 客户端把「睡着」告知健康探针')
  ok(!/stop\(reason\)[\s\S]{0,200}clearInterval/.test(srcSup), 'stop() 不再清巡检定时器')

  await stopStub()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('实证脚本自身异常：', e)
  process.exit(2)
})
