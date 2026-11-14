/* 汇总 Word 导出「带图」离线实证（D-054）
 *
 * 背景：OCR 只把题干转成文字，几何图/图表/示意图留在题块照片（question_images）里。
 * 旧 document.service.ts 是 100% 纯文本导出，打印出来孩子看不到图、没法作答。
 * 本脚本直接加载 nest build 的 CommonJS 产物，mock 掉 Supabase 查询与 StorageService，
 * 生成两份 docx，解包检查 word/media/* 与 <w:drawing>，并验证：
 *   · 练习卷（include_answers 不传）只带题面图，不带答案图
 *   · 答疑解惑卷同时带题面图与答案图
 *   · 图片读取失败时文档照常生成且写「本题图片未能嵌入」诚实提示
 *
 * 不连数据库、不写生产、不依赖网络。跑法（项目根目录）：
 *   node dynamic-tests/run-export-figures.cjs
 */
const { createRequire } = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const serverReq = createRequire(path.join(ROOT, 'server/package.json'))
const sharp = serverReq('sharp')
const serverDist = (rel) => path.join(ROOT, 'server', 'dist', rel)

// queryRows 走的是 supabase_client_1.getSupabaseClient() 属性访问 ⇒ 补丁可生效
const supabaseMod = serverReq(serverDist('storage/database/supabase-client.js'))
const rows = [{
  id: 'q1',
  content: {
    question: '如图，求三角形 ABC 的面积。',
    question_images: ['q-figure.png'],
    images: [],
    answer: '6 平方厘米',
    answer_images: ['a-figure.png'],
  },
  review_count: 2,
  source: '离线实证',
  created_at: '2026-11-14T00:00:00Z',
  subjects: { id: 's1', name: '数学' },
}]
const chain = {
  from() { return this }, select() { return this }, eq() { return this }, is() { return this },
  in() { return this }, gte() { return this }, lte() { return this }, order() { return this },
  then(resolve) { resolve({ data: rows, error: null }) },
}
supabaseMod.getSupabaseClient = () => chain

const { DocumentService } = serverReq(serverDist('document/document.service.js'))

/** 读 zip 中央目录里的文件名（明文），不引第三方解包库 */
function listZipNames(buf) {
  const names = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue
    const nameLen = buf.readUInt16LE(i + 28)
    const extraLen = buf.readUInt16LE(i + 30)
    const commentLen = buf.readUInt16LE(i + 32)
    const start = i + 46
    if (start + nameLen > buf.length) continue
    names.push(buf.slice(start, start + nameLen).toString('utf8'))
    i = start + nameLen + extraLen + commentLen - 1
  }
  return names
}

/** 解出指定条目（docx 正文是 deflate 压缩的，不能明文搜） */
function readZipEntry(buf, want) {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue
    const nameLen = buf.readUInt16LE(i + 28)
    const extraLen = buf.readUInt16LE(i + 30)
    const commentLen = buf.readUInt16LE(i + 32)
    const start = i + 46
    const name = buf.slice(start, start + nameLen).toString('utf8')
    if (name !== want) { i = start + nameLen + extraLen + commentLen - 1; continue }
    const compSize = buf.readUInt32LE(i + 20)
    const localOff = buf.readUInt32LE(i + 42)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = buf.slice(dataStart, dataStart + compSize)
    return buf.readUInt16LE(localOff + 8) === 0 ? comp : zlib.inflateRawSync(comp)
  }
  return null
}

async function main() {
  const png = await sharp({
    create: { width: 120, height: 60, channels: 3, background: { r: 220, g: 30, b: 30 } },
  }).png().toBuffer()
  const png2 = await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 30, g: 90, b: 220 } },
  }).png().toBuffer()
  const storage = { readObject: async (key) => (key === 'q-figure.png' ? png : png2) }
  const svc = new DocumentService(storage)

  const cases = [
    { name: '练习卷（不含答案）', include: false, expectMedia: 1 },
    { name: '答疑解惑（含答案）', include: true, expectMedia: 2 },
  ]
  let bad = 0
  const outDir = path.join(ROOT, '.tmp')
  fs.mkdirSync(outDir, { recursive: true })
  for (const c of cases) {
    const buf = await svc.exportDocx('u1', { title: '导出带图实证', ids: ['q1'], include_answers: c.include })
    const names = listZipNames(buf)
    // 'word/media/' 本身是目录项，不能计入图片数
    const media = names.filter((n) => n.startsWith('word/media/') && n.length > 'word/media/'.length)
    const docXml = (readZipEntry(buf, 'word/document.xml') || Buffer.alloc(0)).toString('utf8')
    const hasDrawing = docXml.includes('<w:drawing') || docXml.includes('<pic:pic')
    const ok = media.length === c.expectMedia && hasDrawing
    if (!ok) bad++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: bytes=${buf.length} word/media=${media.length} (期望 ${c.expectMedia}) drawing=${hasDrawing}`)
    fs.writeFileSync(path.join(outDir, `export-${c.include ? 'with' : 'without'}-answers.docx`), buf)
  }

  const broken = await new DocumentService({ readObject: async () => null })
    .exportDocx('u1', { title: '图片缺失', ids: ['q1'] })
  const brokenXml = (readZipEntry(broken, 'word/document.xml') || Buffer.alloc(0)).toString('utf8')
  const hasNotice = brokenXml.includes('本题图片未能嵌入')
  if (!hasNotice) bad++
  console.log(`${hasNotice ? 'PASS' : 'FAIL'} 图片缺失时文档仍生成且有诚实提示（bytes=${broken.length}）`)

  console.log(bad === 0 ? '\n结论：汇总 Word 导出已实证带图，练习卷不泄答案图。' : '\n结论：存在失败项。')
  process.exitCode = bad === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
