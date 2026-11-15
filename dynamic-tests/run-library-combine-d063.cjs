/**
 * D-063 离线实证：资料库多图合成「一图一页 + 入参顺序即页序」。
 *
 * 直接 require `pnpm build:server` 的编译产物（零 Nest DI、零数据库、零网络），
 * 用 sharp 造三张**尺寸与颜色都不同**的纯色图，验证：
 *   ① 页数 == 图片数（一图一页，不是智能拼页）
 *   ② 每页都是 A4
 *   ③ 图像 XObject 在 PDF 里出现的先后顺序 == 入参数组顺序（排序成果没被丢）
 *   ④ WebP 输入能被归一成 pdf-lib 可嵌格式
 *   ⑤ 打乱入参顺序后 PDF 内图像顺序跟着变（反证「顺序真的生效」）
 *
 * 运行：node dynamic-tests/run-library-combine-d063.cjs
 * 前置：pnpm build:server
 */
const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'server', 'dist')
const sharp = require(path.join(ROOT, 'server', 'node_modules', 'sharp'))
const { PDFDocument } = require(path.join(ROOT, 'server', 'node_modules', 'pdf-lib'))
const { buildOneImagePerPagePdf } = require(path.join(DIST, 'pdf', 'one-image-per-page.js'))
const { normalizeImageSource } = require(path.join(DIST, 'pdf', 'image-normalize.js'))

// 服务层实证：手动注入 mock，绕开 Nest DI / 数据库 / 网络，
// 直接验证「只建 1 条 library_docs + keys 顺序即页序 + 上限/白名单 fail-closed」。
let LibraryImageCombineService = null
try {
  LibraryImageCombineService = require(path.join(DIST, 'library', 'library-image-combine.service.js')).LibraryImageCombineService
} catch (e) {
  console.log('WARN 服务层实证不可用：' + (e && e.message))
}

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log('PASS ' + name)
  } catch (e) {
    fail++
    console.log('FAIL ' + name + ' :: ' + (e && e.message))
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log('PASS ' + name)
  } catch (e) {
    fail++
    console.log('FAIL ' + name + ' :: ' + (e && e.message))
  }
}

const SPECS = [
  { w: 120, h: 240, color: { r: 220, g: 40, b: 40 }, label: '红 120x240' },
  { w: 300, h: 100, color: { r: 40, g: 200, b: 80 }, label: '绿 300x100' },
  { w: 60, h: 60, color: { r: 40, g: 80, b: 220 }, label: '蓝 60x60' },
]

async function makePng(spec) {
  return sharp({ create: { width: spec.w, height: spec.h, channels: 3, background: spec.color } })
    .png()
    .toBuffer()
}

/** 从 PDF 字节流里读出嵌入图像 XObject 的宽高，顺序即对象出现顺序 */
function imageDims(buf) {
  const raw = buf.toString('latin1')
  const out = []
  const re = /\/Subtype\s*\/Image[\s\S]{0,400}?\/Width\s+(\d+)[\s\S]{0,200}?\/Height\s+(\d+)/g
  let m
  while ((m = re.exec(raw))) out.push([Number(m[1]), Number(m[2])])
  return out
}

async function main() {
  const images = []
  for (const s of SPECS) {
    const buf = await makePng(s)
    const norm = await normalizeImageSource(buf, s.label)
    assert.ok(norm, s.label + ' 归一失败')
    assert.strictEqual(norm.width, s.w)
    assert.strictEqual(norm.height, s.h)
    assert.strictEqual(norm.isPng, true)
    images.push(norm)
  }

  const pdf = await buildOneImagePerPagePdf(images)
  const doc = await PDFDocument.load(pdf)
  const pages = doc.getPages()
  const dims = imageDims(pdf)

  await checkAsync('归一：三张 PNG 尺寸与 isPng 均正确', async () => {
    assert.strictEqual(images.length, 3)
  })
  await checkAsync('一图一页：页数 == 图片数（3）', async () => {
    assert.strictEqual(pages.length, 3)
    assert.strictEqual(doc.getPageCount(), 3)
  })
  await checkAsync('每页都是 A4（595.28 x 841.89 pt）', async () => {
    for (const p of pages) {
      assert.strictEqual(Math.round(p.getWidth()), 595)
      assert.strictEqual(Math.round(p.getHeight()), 842)
    }
  })
  await checkAsync('PDF 内嵌了 3 张图，不是拼版合并', async () => {
    assert.strictEqual(dims.length, 3, `实际解析到 ${dims.length} 张：${JSON.stringify(dims)}`)
  })
  await checkAsync('页序 == 入参顺序（红 → 绿 → 蓝）', async () => {
    assert.deepStrictEqual(dims, SPECS.map((s) => [s.w, s.h]))
  })

  // 反证：把入参倒过来，PDF 里的图像顺序必须跟着倒过来
  const reversed = await buildOneImagePerPagePdf([...images].reverse())
  const dimsReversed = imageDims(reversed)
  await checkAsync('打乱入参顺序后页序随之改变（顺序真的生效）', async () => {
    assert.deepStrictEqual(dimsReversed, SPECS.map((s) => [s.w, s.h]).reverse())
  })

  // WebP（微信常见产出）必须被归一，否则 pdf-lib 会报「没有可合成的图片」
  const webp = await sharp({ create: { width: 90, height: 150, channels: 3, background: { r: 250, g: 200, b: 30 } } })
    .webp()
    .toBuffer()
  const normWebp = await normalizeImageSource(webp, 'webp')
  await checkAsync('WebP 归一为 JPEG 且尺寸正确', async () => {
    assert.ok(normWebp, 'WebP 归一返回 null')
    assert.strictEqual(normWebp.isPng, false)
    assert.strictEqual(normWebp.width, 90)
    assert.strictEqual(normWebp.height, 150)
  })
  const pdfWebp = await buildOneImagePerPagePdf([normWebp])
  const docWebp = await PDFDocument.load(pdfWebp)
  await checkAsync('WebP 归一后能真的嵌进 PDF', async () => {
    assert.strictEqual(docWebp.getPageCount(), 1)
    assert.deepStrictEqual(imageDims(pdfWebp), [[90, 150]])
  })

  await checkAsync('空输入 fail-closed（抛错，不产出 0 页 PDF）', async () => {
    let threw = false
    try {
      await buildOneImagePerPagePdf([])
    } catch {
      threw = true
    }
    assert.ok(threw)
  })

  // ---------- 服务层：只归档一份 + 保序 + 输入闸门 ----------
  if (LibraryImageCombineService) {
    const pngs = []
    for (const s of SPECS) pngs.push(await makePng(s))
    const map = {
      'tmp/aa/111.png': pngs[0],
      'tmp/bb/222.png': pngs[1],
      'tmp/cc/333.png': pngs[2],
    }
    const mk = () => {
      const calls = { create: [], upload: [] }
      const storage = {
        readObject: async (k) => map[k] || null,
        uploadBuffer: async (buf, name, mime) => {
          calls.upload.push({ buf, name, mime })
          return name
        },
      }
      const library = {
        create: async (uid, dto) => {
          calls.create.push({ uid, dto })
          return { id: 'doc-1', name: dto.name, ...dto }
        },
        withUrls: async (docs) => docs.map((d) => ({ ...d, url: 'https://unit.test/' + d.file_key })),
      }
      return { calls, svc: new LibraryImageCombineService(storage, library) }
    }

    const a = mk()
    // 故意用 ③→①→② 的顺序：PDF 页序必须跟着 keys 走，而不是某种内部排序
    const keys = ['tmp/cc/333.png', 'tmp/aa/111.png', 'tmp/bb/222.png']
    const result = await a.svc.combine('u1', keys, '单元测试卷.pdf')
    const pdfUpload = a.calls.upload.find((u) => u.mime === 'application/pdf')
    const docPdf = await PDFDocument.load(pdfUpload.buf)

    await checkAsync('服务层：只建 1 条 library_docs，原图零条目', async () => {
      assert.strictEqual(a.calls.create.length, 1)
      assert.strictEqual(a.calls.create[0].uid, 'u1')
      assert.strictEqual(a.calls.create[0].dto.source, 'image-combine')
      assert.ok(a.calls.create[0].dto.name.endsWith('.pdf'))
    })
    await checkAsync('服务层：keys 顺序即 PDF 页序（③→①→②）', async () => {
      assert.strictEqual(docPdf.getPageCount(), 3)
      assert.deepStrictEqual(imageDims(pdfUpload.buf), [
        [SPECS[2].w, SPECS[2].h],
        [SPECS[0].w, SPECS[0].h],
        [SPECS[1].w, SPECS[1].h],
      ])
      assert.strictEqual(result.pages, 3)
      assert.strictEqual(result.images, 3)
      assert.ok(result.url.startsWith('https://unit.test/'))
    })
    await checkAsync('服务层：封面缩略图 best-effort 不影响成品', async () => {
      assert.ok(a.calls.upload.some((u) => u.mime === 'image/jpeg'))
    })
    await checkAsync('服务层：读不到的图跳过并按实际张数出页（不谎报）', async () => {
      const c = mk()
      const r = await c.svc.combine('u1', ['tmp/cc/333.png', 'tmp/missing/000.png', 'tmp/aa/111.png'], '')
      assert.strictEqual(r.pages, 2)
      assert.strictEqual(r.images, 2)
    })
    await checkAsync('服务层：空 keys / 超上限 / 路径逃逸一律拒绝且不入库', async () => {
      const b = mk()
      const bads = [[], Array(21).fill('tmp/aa/111.png'), ['../../etc/passwd'], ['blobs/aa/x/../../y.png']]
      for (const bad of bads) {
        let threw = false
        try {
          await b.svc.combine('u1', bad, '')
        } catch {
          threw = true
        }
        assert.ok(threw, '应拒绝：' + JSON.stringify(bad).slice(0, 60))
      }
      assert.strictEqual(b.calls.create.length, 0, '被拒的请求绝不允许入库')
    })
  }

  console.log(`\nD-063 合成实证：${pass} PASS / ${fail} FAIL`)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error('实证脚本异常', e)
  process.exitCode = 1
})
