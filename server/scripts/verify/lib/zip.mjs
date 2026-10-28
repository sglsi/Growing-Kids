// ============================================================
// 极简 ZIP 读取器（只读、只解压、零依赖）
//
// 为什么需要它：`/api/document/export` 返回的是 .docx（本质是 zip 里的
// word/document.xml）。要验证「打印练习卷到底带没带答案」，必须把 XML
// 解出来看 —— 只看 HTTP 200 是测不出语义的（R-技术-13 就是这样躲过首轮验证）。
//
// 刻意不引 adm-zip / jszip：套件的设计前提是「零依赖，拷到任何环境就能跑」。
// ============================================================

import zlib from 'zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

/**
 * 列出 zip 内的条目。
 * @param {Buffer} buf
 * @returns {{name: string, method: number, compSize: number, size: number, localOffset: number}[]}
 */
export function listEntries(buf) {
  // EOCD 在文件尾部，注释最长 65535，故从尾部回扫
  let eocd = -1
  const start = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP（找不到 EOCD）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  const out = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`中央目录第 ${i} 项签名异常 @${p}`)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    out.push({ name, method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 取出某个条目的原始字节（支持 store / deflate）。
 * @param {Buffer} buf
 * @param {string} name 完整条目名（如 word/document.xml）
 * @returns {Buffer}
 */
export function readEntry(buf, name) {
  const e = listEntries(buf).find((x) => x.name === name)
  if (!e) {
    const names = listEntries(buf).map((x) => x.name).join(', ')
    throw new Error(`ZIP 内没有 ${name}（现有：${names}）`)
  }
  const p = e.localOffset
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  // ⚠️ 用中央目录里的 compSize，不读本地头的 —— 本地头在流式写入时可能是 0，
  //    真实尺寸放在 data descriptor 里（紧跟在数据之后）。
  const raw = buf.subarray(dataStart, dataStart + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`不支持的压缩方式 ${e.method}（${name}）`)
}

/**
 * 把 .docx 的正文 XML 拼成纯文本（用于断言"含/不含某段文案"）。
 *
 * 只做最小提取：<w:t>…</w:t> 内容按出现顺序拼接，段落之间用 \n。
 * 足够判断「有没有出现正确答案/解析」，不试图还原完整排版。
 */
export function docxText(buf) {
  const xml = readEntry(buf, 'word/document.xml').toString('utf8')
  const parts = []
  // 段落级分隔：先按 </w:p> 切开，保证换行语义不丢
  for (const para of xml.split('</w:p>')) {
    const texts = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]))
    if (texts.length) parts.push(texts.join(''))
  }
  return parts.join('\n')
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
