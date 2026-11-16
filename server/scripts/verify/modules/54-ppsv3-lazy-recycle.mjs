// 模块 54：OCR 侧车「空闲回收 + 按需拉起」（D-071）
//
// 🔴 只守静态契约。真实行为（状态机、重复回收、失败降级）由
//    `dynamic-tests/run-sidecar-unit-d071.cjs` 用编译产物实跑证明；
//    生产上 systemctl/sudoers/冷启耗时必须另外实跑——本模块不得被当成已验证的证据。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M54', 'OCR 侧车空闲回收与按需拉起（D-071）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const SUP = 'server/src/ocr/sidecar.supervisor.ts'
const CLI = 'server/src/ocr/ppsv3.client.ts'
const HEALTH = 'server/src/ocr/ocr-health.ts'
const UNIT = 'docs/gk-ppsv3.service'
const DYN = 'dynamic-tests/run-sidecar-unit-d071.cjs'

m.test('A1 单元模式：启停走 systemctl，不再由 gk-api spawn', (c) => {
  const s = read(SUP)
  c.ok(s.includes('PPSV3_UNIT'), '须支持 PPSV3_UNIT（单元名）')
  c.ok(s.includes('systemctl ${action}'), '须拼出 systemctl 命令')
  c.ok(s.includes('sudo -n'), '默认加 sudo -n（gk-api 以非 root 用户运行）')
  c.ok(s.includes(`mode: this.cfg.unit ? 'unit' : 'spawn'`), 'getState 须暴露 mode，便于诊断端点看模式')
  // 单元模式下不得再走 spawn 分支（否则又落回 gk-api 的 MemoryMax=1200M，必然起不来）
  c.ok(/if \(this\.cfg\.unit\) \{[\s\S]{0,400}runUnit\('start'/.test(s), '单元模式须优先于 spawn 分支')
})

m.test('A2 空闲回收必须能反复发生（旧实现只能回收一次）', (c) => {
  const s = read(SUP)
  const stopBody = s.slice(s.indexOf('  stop(reason = '), s.indexOf('  shutdown(): void {'))
  c.ok(stopBody.length > 0, '须有 stop() 与 shutdown() 两个动作')
  c.ok(!stopBody.includes('clearInterval'), 'stop() 里不得清巡检定时器——清了就只能回收一次')
  c.ok(s.includes('不再清 monitorTimer'), '须留注释说明为什么不清定时器')
  c.ok(/shutdown\(\)[\s\S]{0,400}clearInterval/.test(s), 'shutdown() 才负责清定时器')
})

m.test('A3 gk-api 退出不得带走共享侧车', (c) => {
  const s = read(SUP)
  c.ok(s.includes("process.once('SIGTERM', () => this.shutdown())"), 'SIGTERM 须走 shutdown() 而非 stop()')
  c.ok(s.includes('保留单元'), '单元模式下 shutdown 须保留单元运行')
  c.ok(/if \(this\.cfg\.unit\) \{[\s\S]{0,200}return/.test(s.slice(s.indexOf('  shutdown(): void {'))), 'shutdown 单元模式须提前返回')
})

m.test('A4 /healthz 通过 ≠ 能用：启动后必须预热模型', (c) => {
  const s = read(SUP)
  c.ok(s.includes('getDiagnoseProbeBuffer'), '须复用已知文字探针图（不新增二进制资源）')
  c.ok(s.includes("`${this.cfg.baseUrl}/ppsv3`"), '预热须打真实识别端点')
  c.ok(s.includes('首次调用才加载模型') || s.includes('首次 /ppsv3 才加载模型'), '须注明为什么要预热')
  c.ok(s.includes('不阻断') || s.includes('仍可用'), '预热失败不得阻断（只降级为首个请求慢）')
  c.ok(s.includes('PPSV3_START_TIMEOUT_MS') || s.includes('startTimeoutMs'), '单元模式冷启须有独立超时')
})

m.test('A5 睡着不算故障：健康探针须认得「预期离线」', (c) => {
  const h = read(HEALTH)
  c.ok(h.includes('expectedDown'), 'OcrHealthProbe 须支持 expectedDown')
  c.ok(/expectedDown\?\.\(\)[\s\S]{0,400}return/.test(h), '预期离线时须直接返回，不计数不告警')
  const cli = read(CLI)
  c.ok(cli.includes('expectedDown'), '3.x 客户端须把「睡着」告知探针')
  c.ok(cli.includes('isSleeping'), '须用 supervisor.isSleeping() 判定睡态')
})

m.test('A6 起不来就降级，不拖垮主链路', (c) => {
  const s = read(SUP)
  c.ok(s.includes('sidecar-startup-failed'), '启动失败须发告警埋点')
  c.ok(/catch \(e\) \{[\s\S]{0,300}return false/.test(s.slice(s.indexOf('async ensureReady'))), 'ensureReady 失败须返回 false')
  c.ok(s.includes('return null'), 'withSidecar 启动失败须返回 null')
})

m.test('A7 生产留档：单元文件 + polkit 授权规则都在仓库里', (c) => {
  c.ok(exists(UNIT), `${UNIT} 缺失（换机无法一键还原）`)
  const u = read(UNIT)
  // 🔴 实测坑：gk-api 带 NoNewPrivileges=yes ⇒ sudo 被内核拒，必须走 polkit
  c.ok(u.includes('org.freedesktop.systemd1.manage-units'), '须写明 polkit 授权规则')
  c.ok(u.includes('NoNewPrivileges') && u.includes('sudo'), '须保留「为什么 sudoers 不生效」的原因')
  c.ok(u.includes('PPSV3_UNIT_SUDO=0'), '须说明配 polkit 后关掉 sudo 前缀')
  c.ok(u.includes('MemoryMax'), '须保留内存上限（防拖垮宿主）')
})

m.test('A8 实证脚本存在且覆盖关键场景', (c) => {
  c.ok(exists(DYN), `${DYN} 缺失`)
  const d = read(DYN)
  for (const kw of ['空闲回收', '再次被叫醒', 'shutdown', 'sidecar-startup-failed', 'expectedDown']) {
    c.ok(d.includes(kw), `实证脚本须覆盖「${kw}」`)
  }
})

export default m
