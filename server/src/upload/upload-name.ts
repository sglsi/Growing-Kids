/**
 * 上传名是否为「机器临时名」——是的话不该直接当标题展示。
 *
 * 微信 `wx.uploadFile` 在调用方没传 original_name 时，multipart 的 filename 头
 * 就是临时路径名。它被原样写进 `timeline_items.title` 后，首页卡片显示的就是
 * 一串 `tmp_xxx` / `GkljMPoGQP2a…`，家长根本认不出是哪道题。
 *
 * 演进：
 *   - 2026-10-29 初版挡 `tmp_/wx_/file_/blob_/image_` 前缀 + 纯 hex（思傅反馈
 *     「新加进去的题目名字是乱码」）；
 *   - 2026-11-01 补第 3 条：真实账户里发现标题是
 *     `GkljMPoGQP2a8e0a7d51647c149a1c87f1a132b49ef1.jpg`，前两条都不认它。
 *
 * 第 3 条用「相邻字符类别（小写/大写/数字）切换密度」判定，而不是长度：
 *   随机串 0.61~0.94，正常文件名 0.24~0.37
 *   （`Unit3ReadingPractice`=0.30、`TestPaper2023Grade9`=0.37），取 0.5 干净分开。
 */
export function isOpaqueUploadName(name: string): boolean {
  const s = (name || '').trim()
  if (!s) return true
  const base = s.replace(/\.[a-z0-9]{1,5}$/i, '')
  if (/^(tmp_|wx_|file_|blob_|image_)/i.test(base)) return true
  if (/^[a-f0-9]{16,}$/i.test(base)) return true
  if (base.length >= 12 && /^[A-Za-z0-9_-]+$/.test(base)) {
    const kind = (c: string) => (/[0-9]/.test(c) ? 'd' : /[A-Z]/.test(c) ? 'U' : /[a-z]/.test(c) ? 'l' : 'x')
    let switches = 0
    for (let i = 1; i < base.length; i++) if (kind(base[i - 1]) !== kind(base[i])) switches++
    if (switches / base.length >= 0.5) return true
  }
  return false
}
