/**
 * 微信「本地临时文件」与「远程图片 URL」的判别。
 *
 * ⚠️ 关键坑（思傅 2026-10-19 实测，全页 OCR 报 `getaddrinfo ENOTFOUND tmp`）：
 * 微信**开发者工具**（Windows / macOS）的 chooseImage / compressImage 返回的
 * tempFilePath 形如 `http://tmp/wx1a2b3c.png` —— 它长得像 http URL，
 * 但其实是**本机临时文件**，必须走 Taro.uploadFile 真正上传。
 * 真机上是 `wxfile://tmp_xxx.png`（不以 http 开头，本来就不受影响）。
 *
 * 后果：若按 `/^https?:\/\//` 一律判成「远程 URL 可直接复用」，
 * uploadImage 会**完全不上传**就把 `http://tmp/...` 当图片地址用，
 * 后端再拿它去下载 → 把 `tmp` 当主机名解析 → `getaddrinfo ENOTFOUND tmp`，
 * 前端表现为「全页 OCR 失败 / 智能高清失败」等一连串莫名其妙的报错。
 *
 * 所以：凡是需要「这是不是已经能直接用的远程图」的判断，一律用本函数，
 * 不要再裸写 `/^https?:\/\//`。
 */

/** 微信开发者工具的本地临时文件路径：`http://tmp/wx1a2b3c.png` */
const WECHAT_DEVTOOLS_TMP = /^http:\/\/tmp\//i

/**
 * 是否为「可直接交给后端的远程图片 URL」。
 * 开发者工具的 `http://tmp/…` 临时文件**不算**——它是待上传的本地文件。
 */
export function isRemoteImageUrl(p: string): boolean {
  if (!p) return false
  if (WECHAT_DEVTOOLS_TMP.test(p)) return false
  return /^https?:\/\//i.test(p)
}
