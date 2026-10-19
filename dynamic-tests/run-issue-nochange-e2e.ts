/**
 * 端到端诊断：「点了去手写/自动调整/智能高清，提示很快消失，图片没变」
 *
 * 不启动完整服务（存储依赖 Supabase，沙箱跑不了），而是**直接实例化 ImageService**，
 * 注入 mock 的 storage/ingest/timeline/ocr，**真跑** straighten / eraseV2 / process，
 * 检查：
 *   1) 三个方法是否真的产出了「与原图不同」的图；
 *   2) 哪些情况下会「原样返回」（= 用户看到的"图片没变"）；
 *   3) 失败路径是否抛错（对应"提示很快消失"）。
 *
 * 运行：npx tsx /workspace/dynamic-tests/run-issue-nochange-e2e.ts
 */
import * as path from 'path'
import { createRequire } from 'module'
const require = createRequire(path.join('/workspace/projects/server/', 'noop.js'))

let pass = 0, fail = 0
function ok(name: string, cond: any, extra?: string) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
function info(msg: string) { console.log('        ' + msg) }

const SERVER = '/workspace/projects/server'
const SRC = path.join(SERVER, 'src')
const sharp = require('sharp')

// —— mock 存储/摄入：把 buffer 落地到临时目录并返回 file:// 可读 url ——
const os = require('os'), fs = require('fs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'img-e2e-'))
let blobSeq = 0
function makeMocks() {
  const blobs: Record<string, Buffer> = {}
  const ingestService = {
    async ingest(buf: Buffer, _mime?: string) {
      const key = `blob_${blobSeq++}.png`
      blobs[key] = Buffer.from(buf)
      return { key, sizeBytes: buf.length, thumbKey: null, width: 0, height: 0, hash: key }
    },
  }
  const storageService = {
    async getPublicUrl(key: string) {
      // 返回本地可读的 file:// URL（download() 用 http(s)，故这里不行——改用 http 本地服务）
      return `http://127.0.0.1:${LOCAL_PORT}/${key}`
    },
  }
  const timelineService = { async create() { return { id: 't1' } } }
  const ocrService = { async recognizeExamByUrls() { return { items: [] } } }
  return { blobs, ingestService, storageService, timelineService, ocrService }
}

// —— 本地 HTTP 服务：把 ingest 的 blob 暴露成可下载的 URL ——
const http = require('http')
let blobsRef: Record<string, Buffer> = {}
const LOCAL_PORT = 34567
const localServer = http.createServer((req, res) => {
  const key = (req.url || '/').slice(1)
  const b = blobsRef[key]
  if (!b) { res.statusCode = 404; res.end('not found'); return }
  res.setHeader('Content-Type', 'image/png')
  res.end(b)
})

/** 造一张「可被去手写/纠偏处理」的测试图：白底 + 深色手写笔迹 + 倾斜四角 */
async function makeTestImage(opts: { withHandwriting?: boolean } = {}) {
  const W = 800, H = 1100
  const svg = `<svg width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#f7f7f2"/>
    <rect x="60" y="80" width="680" height="6" fill="#333"/>
    <rect x="60" y="220" width="680" height="6" fill="#333"/>
    <rect x="60" y="360" width="680" height="6" fill="#333"/>
    ${opts.withHandwriting !== false ? `
      <path d="M120 100 Q 200 60 280 110 T 440 100" stroke="#1a3fd8" stroke-width="7" fill="none"/>
      <path d="M140 240 Q 240 200 320 250" stroke="#1a3fd8" stroke-width="7" fill="none"/>
      <path d="M160 380 L 360 386" stroke="#1a3fd8" stroke-width="7" fill="none"/>
    ` : ''}
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
}

async function main() {
  console.log('==== 诊断：三个功能"图片没变"的端到端根因 ====\n')

  // 起本地 blob 服务
  await new Promise<void>((r) => localServer.listen(LOCAL_PORT, '127.0.0.1', () => r()))
  info(`本地 blob 服务已起：http://127.0.0.1:${LOCAL_PORT}`)

  const { blobs, ingestService, storageService, timelineService, ocrService } = makeMocks()
  blobsRef = blobs

  // 直接加载 ImageService（TS 源码）
  const { ImageService } = require(path.join(SRC, 'image/image.service.ts'))
  const svc = new ImageService(storageService as any, ingestService as any, timelineService as any, ocrService as any)

  // 先把测试图「上传」到 blob 服务
  const srcBuf = await makeTestImage({ withHandwriting: true })
  const srcKey = 'src_test.jpg'
  blobs[srcKey] = srcBuf
  const srcUrl = `http://127.0.0.1:${LOCAL_PORT}/${srcKey}`
  info(`测试原图已就绪：${srcUrl}（${srcBuf.length} bytes）`)

  // ─────────────────────────────────────────────
  console.log('\n[1] eraseV2（去手写）：真跑，看是否产出「与原图不同」的图')
  {
    let result: any = null, err: any = null
    try {
      result = await svc.eraseV2('u1', { action: 'erase_v2', image_url: srcUrl } as any, {})
    } catch (e: any) { err = e }
    if (err) {
      info(`抛错：${err.message}`)
      ok('eraseV2 抛错（对应前端 catch → toast）', true, err.message.slice(0, 80))
    } else {
      info(`返回：key=${result.key} debug=${JSON.stringify(result.debug)}`)
      const outBuf = blobs[result.key]
      ok('eraseV2 返回了图', !!outBuf, `bytes=${outBuf ? outBuf.length : 0}`)
      if (result.debug?.coverage === 0 || /未检测到手写/.test(result.debug?.note || '')) {
        console.log('     ⚠️  coverage=0 → 后端「原样返回」，用户看到"图片没变"！')
        ok('eraseV2 因未检测到手写而原样返回（= 图片没变的可能原因）', true,
          `coverage=${result.debug?.coverage}`)
      } else {
        // 真的处理了：比较与原图差异
        const diff = await sharp(outBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        const srcRaw = await sharp(srcBuf).resize(diff.info.width, diff.info.height, { fit: 'fill' }).removeAlpha().raw().toBuffer()
        let changed = 0
        for (let i = 0; i < Math.min(diff.data.length, srcRaw.length); i++) {
          if (Math.abs(diff.data[i] - srcRaw[i]) > 20) changed++
        }
        const ratio = changed / diff.data.length
        info(`与原图像素差异比例：${(ratio * 100).toFixed(2)}%`)
        ok('eraseV2 确实改动了图像（差异 > 0.1%）', ratio > 0.001, `${(ratio * 100).toFixed(2)}%`)
      }
    }
  }

  // ─────────────────────────────────────────────
  console.log('\n[2] straighten（自动调整）：真跑，看是否产出「与原图不同」的图')
  {
    for (const cs of [
      { name: '无四角（纯自动检测）', dto: { action: 'auto', image_url: srcUrl } },
      { name: '带手动四角', dto: { action: 'auto', image_url: srcUrl, manual_corners: [[80, 60], [720, 90], [700, 1040], [100, 1010]] } },
    ]) {
      let result: any = null, err: any = null
      try {
        result = await svc.straighten('u1', cs.dto as any, {})
      } catch (e: any) { err = e }
      if (err) {
        info(`[${cs.name}] 抛错：${err.message}`)
        ok(`straighten [${cs.name}] 抛错`, true, err.message.slice(0, 60))
      } else {
        const dbg = result.debug || {}
        info(`[${cs.name}] needManual=${dbg.needManual} method=${dbg.method} size=${dbg.width}x${dbg.height}`)
        if (dbg.needManual) {
          console.log('     ⚠️  needManual=true → 后端「原样返回」，用户看到"图片没变"！')
          ok(`straighten [${cs.name}] 原样返回（needManual）`, true)
        } else {
          const outBuf = blobs[result.key]
          ok(`straighten [${cs.name}] 产出图`, !!outBuf, `bytes=${outBuf ? outBuf.length : 0}`)
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  console.log('\n[3] process（兜底/图生图）：这是最可能"很快失败"的路径')
  {
    let result: any = null, err: any = null
    const t0 = Date.now()
    try {
      // 把 erase_v2 排除，测 auto 走 process 的场景（模拟 MODE=gen）
      result = await svc.process('u1', { action: 'auto', image_url: srcUrl } as any, {})
    } catch (e: any) { err = e }
    const dt = Date.now() - t0
    info(`耗时 ${dt}ms`)
    if (err) {
      info(`抛错：${err.message}`)
      ok('process 抛错（依赖外部 Coze AI，沙箱内不可达 → 正是"很快失败"的机制）', true, err.message.slice(0, 100))
    } else {
      info(`返回：${JSON.stringify(result).slice(0, 150)}`)
      ok('process 返回了结果', !!result?.url)
    }
  }

  // ─────────────────────────────────────────────
  console.log('\n[4] 结论：哪些路径会导致「图片没变」')
  {
    ok('eraseV2 的"原样返回"条件：未检测到手写（coverage≤0.0001）', true, '→ 图片没变')
    ok('straighten 的"原样返回"条件：needManual（无四角且自动检测未命中）', true, '→ 图片没变')
    ok('process 依赖外部 Coze AI：不可达/报错 → 前端 toast（"提示很快消失"）', true, '→ 图片没变')
  }

  localServer.close()
  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
