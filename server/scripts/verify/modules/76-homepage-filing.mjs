// 模块 76：首页备案悬挂合规（D-099）
//
// 首页是给管局 / 公安 / 腾讯云核查看的那一个页面，改版最容易悄悄丢东西。
// 本模块把 D-099 闭环的四条事实锁成断言：
//   F1 ICP 备案号（-2）在，且带工信部超链接（只写文字等于没挂）
//   F2 公安备案号在，且带 mps 官方查询超链接；code 只取数字，不带中文
//   F3 警徽图标 /gongan.png 被引用、文件在位；不得写死 16×16（原图 36×40，写死会压扁）
//   F4 首页保持非交互式：禁词 0 / <form> 0 / <script> 0（注释也扫）+ 注释配对 + 站名逐字一致
//
// ⚠️ 断言前统一剥注释的地方：F4 的「不含敏感内容」判定必须扫全文（核查也扫源码）；
//    但 F3 的「不得写死 16×16」要看真实标签，先剥注释避免被历史模板注释误伤。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M76', '首页备案悬挂合规（D-099）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const HOME = 'server/www/index.html'
const ICON = 'server/www/gongan.png'

const GA_NO = '陕公网安备61019702000794号'
const GA_CODE = '61019702000794'
const ICP_NO = '陕ICP备2026030931号-2'

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')

m.test('F1 ICP 备案号在，且带工信部超链接', async (c) => {
  c.ok(exists(HOME), '首页源文件须在仓库内（改动可追溯）')
  const f = read(HOME)
  c.ok(f.includes(ICP_NO), '须含网站 ICP 备案号 ' + ICP_NO)
  const live = stripComments(f)
  c.ok(
    /<a[^>]+href="https:\/\/beian\.miit\.gov\.cn\/"[^>]*>[^<]*陕ICP备/.test(live),
    'ICP 号必须以超链接指向 beian.miit.gov.cn（只写文字视为未悬挂）',
  )
})

m.test('F2 公安备案号在，且带 mps 官方查询超链接', async (c) => {
  const f = read(HOME)
  const live = stripComments(f)
  c.ok(live.includes(GA_NO), '须含公安备案号 ' + GA_NO + '（与平台原文逐字一致，不加空格）')
  c.ok(
    /beian\.mps\.gov\.cn\/#\/query\/webSearch\?code=/.test(live),
    '须带公安部平台查询链接 https://beian.mps.gov.cn/#/query/webSearch?code=…',
  )
  c.ok(
    new RegExp('webSearch\\?code=' + GA_CODE + '"').test(live),
    'code 只取号码数字部分 ' + GA_CODE + '（带「陕公网安备」「号」会查不到）',
  )
  c.ok(!/陕公网安备\s+61/.test(live), '号码文本不得插入空格（须与平台原文逐字一致）')

  // 与平台「复制备案编号 HTML 代码」给的原文逐字对齐（2026-11-19 思傅回传）：
  // <a href="https://beian.mps.gov.cn/#/query/webSearch?code=61019702000794" rel="noreferrer" target="_blank">陕公网安备61019702000794号</a>
  // 本项目 rel 用 noopener noreferrer（noreferrer 已隐含 noopener，是官方的超集），故只锁 href + target + rel 含 noreferrer。
  const gaTag =
    (live.match(/<a href="https:\/\/beian\.mps\.gov\.cn\/#\/query\/webSearch\?code=61019702000794"[^>]*>/) || [])[0] || ''
  c.ok(!!gaTag, 'a 标签的 href 须与官方原文逐字一致（含 code=' + GA_CODE + '）')
  c.ok(/target="_blank"/.test(gaTag), '官方原文要求 target="_blank"')
  c.ok(/rel="[^"]*noreferrer/.test(gaTag), '官方原文要求 rel 含 noreferrer')
})

m.test('F3 警徽图标在位且未被压扁', async (c) => {
  c.ok(exists(ICON), '图标须纳入仓库 server/www/gongan.png')
  const size = fs.statSync(path.join(ROOT, ICON)).size
  c.ok(size > 500, '图标文件须非空且像真图（实际 ' + size + ' 字节）')

  const live = stripComments(read(HOME))
  const tag = (live.match(/<img[^>]*gongan\.png[^>]*>/i) || [])[0] || ''
  c.ok(!!tag, '首页须引用 /gongan.png（号码左侧配警徽）')
  c.ok(!/height="16"/.test(tag) && !/height:\s*16px/.test(tag), '不得给图标写死 16×16（原图 36×40 非正方形，会压扁）')
  c.ok(/height:\s*auto/.test(tag) || !/height/.test(tag), '高度应交给等比缩放（height:auto）')
})

m.test('F4 非交互式 + 注释配对 + 站名一致', async (c) => {
  const f = read(HOME) // 全文，注释也扫：核查会扫源码
  c.ok((f.match(/教育|培训|课程|辅导|教学|课件/g) || []).length === 0, '禁词 0（含注释）')
  c.ok(!/<form/i.test(f), '<form> 0（有表单即变交互式）')
  c.ok(!/<script/i.test(f), '<script> 0（统计/JS 一律不加）')
  const open = (f.match(/<!--/g) || []).length
  const close = (f.match(/-->/g) || []).length
  c.ok(open === close, 'HTML 注释须配对（开 ' + open + ' / 闭 ' + close + '）')
  c.ok(/<title>深度扎根<\/title>/.test(f), '<title> 须与备案「服务名称(网站)」逐字一致：深度扎根')
  c.ok(!/display:\s*none[^>]*gongan|gongan[\s\S]{0,80}display:\s*none/i.test(f), '备案号不得隐藏或白字白底')
})

export default m
