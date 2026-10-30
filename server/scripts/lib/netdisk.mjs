/**
 * 百度网盘 OpenAPI 最小客户端（纯 Node，供备份/恢复脚本复用）
 * ------------------------------------------------------------------
 * 为什么不直接 import `server/src/storage/baidu-netdisk.service.ts`：
 *   它是 Nest 的 @Injectable（带装饰器与 TS 语法），裸 node 跑 .mjs 脚本 import 不了。
 *   而计划任务必须能直接跑，不能依赖 tsc 产物——所以这份是**刻意的重复实现**，
 *   参数与 `baidu-netdisk.service.ts` 逐字对齐。
 *   ⚠️ 改网盘上传逻辑时**两边都要改**，否则网盘归档与备份会出现行为分叉。
 *
 * 踩过的坑（原样保留，别踩第二遍）：
 *   1. 路径含中文必须 encodeURIComponent（URLSearchParams 自动处理，手工拼串要小心）；
 *   2. 上传三步缺一不可：precreate（拿 uploadid）→ superfile2（分片）→ create（合片）；
 *      只做前两步，网盘里**不会出现文件**且接口不报错；
 *   3. block_list 回空数组 = 网盘已有同 md5 文件 ⇒ 秒传，此时不必再传分片；
 *   4. 下载两步：filemetas 换 dlink → 必须带 `User-Agent: pan.baidu.com`，否则被拒；
 *   5. 接口用 errno 口径（不是 HTTP 状态码），**errno≠0 必须当失败**；
 *   6. 2026-06-03 后创建的应用只能访问 `/apps/{应用名}/` 下（本项目已按此约束设根目录）。
 */
import { createHash } from 'node:crypto'
import { env } from './gk-env.mjs'

const OAUTH_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
const PAN_FILE = 'https://pan.baidu.com/rest/2.0/xpan/file'
const PAN_MULTIMEDIA = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
const PCS_SUPERFILE = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'

const TOKEN_ERRNOS = new Set([111, -6, 2, 10])
const REQ_TIMEOUT_MS = Number(env('BAIDU_TIMEOUT_MS', '30000'))
const UPLOAD_TIMEOUT_MS = Number(env('BAIDU_UPLOAD_TIMEOUT_MS', '180000'))
// 百度 superfile2 的约定：每片必须正好 4 MB（最后一片可不足）
// 分片大小固定 4MB —— 这是百度网盘对**普通用户**的硬性规定，不是我们拍的：
// 官方《创建文件》接口文档（错误码 31365「文件总大小超限」）原文：
//   · 普通用户：单个分片大小**固定为 4MB**，单文件上限 4GB
//   · 普通会员：分片上限 16MB，单文件 10GB
//   · 超级会员：分片上限 32MB，单文件 20GB
//   · 分片数量上限 1024
// 踩过的坑：曾经把整个文件当一个分片上传（单片最大 = 文件本身），
// 176KB 的数据库备份能过，66MB 的文件备份必返 `error_code: -1` 且**响应体为空**（排障抓瞎）。
// 改成 4MB 分片后 66MB 文件 133 秒传完。若将来账号升级为会员，可放宽到 16/32MB 提速，
// 但必须同步确认分片数不超 1024。
const PART_SIZE = 4 * 1024 * 1024

export class Netdisk {
  /** @param {string} root 绝对目录，默认 /apps/GrowingKids/GrowingKids备份 */
  constructor(root) {
    this.root = (root || env('BAIDU_BACKUP_ROOT', '/apps/GrowingKids/GrowingKids备份')).replace(/\/+$/, '')
    this.cachedToken = ''
    this.refreshToken = env('BAIDU_REFRESH_TOKEN')
  }

  /** 凭证齐了才可用；缺项返回缺失名单（调用方据此降级，不硬失败） */
  missingKeys() {
    const miss = []
    for (const k of ['BAIDU_APP_KEY', 'BAIDU_SECRET_KEY']) if (!env(k)) miss.push(k)
    if (!this.refreshToken && !env('BAIDU_ACCESS_TOKEN')) miss.push('BAIDU_REFRESH_TOKEN')
    return miss
  }

  enabled() {
    return this.missingKeys().length === 0
  }

  async token(force = false) {
    if (!force && this.cachedToken) return this.cachedToken
    const fromEnv = env('BAIDU_ACCESS_TOKEN')
    if (!force && fromEnv) {
      this.cachedToken = fromEnv
      return this.cachedToken
    }
    if (!this.refreshToken) throw new Error(`缺少 BAIDU_REFRESH_TOKEN（${this.missingKeys().join(' / ')}）`)
    const res = await fetch(
      `${OAUTH_TOKEN}?grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken)}` +
        `&client_id=${encodeURIComponent(env('BAIDU_APP_KEY'))}&client_secret=${encodeURIComponent(env('BAIDU_SECRET_KEY'))}`,
      { method: 'GET', signal: AbortSignal.timeout(REQ_TIMEOUT_MS) },
    )
    const json = await res.json().catch(() => ({}))
    if (!json.access_token) {
      throw new Error(`刷新 access_token 失败：${json.error || ''} ${json.error_description || ''}`.trim())
    }
    // refresh_token 会轮换：只在内存里更新，不写盘（写盘交给 baidu-oauth.mjs，避免脚本偷偷改密钥文件）
    if (json.refresh_token) this.refreshToken = String(json.refresh_token)
    this.cachedToken = String(json.access_token)
    return this.cachedToken
  }

  /** 撞 token 类 errno 就刷新后重试一次 */
  async call(fn) {
    let token = await this.token()
    let r = await fn(token)
    if (TOKEN_ERRNOS.has(Number(r.errno))) {
      token = await this.token(true)
      r = await fn(token)
    }
    return r.value
  }

  async postForm(url, form) {
    const res = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    })
    return await res.json().catch(() => ({ errno: -1, errmsg: '响应非 JSON' }))
  }

  async list(dir) {
    return this.call(async (token) => {
      const res = await fetch(`${PAN_FILE}?method=list&access_token=${token}&dir=${encodeURIComponent(dir)}`, {
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      })
      const json = await res.json().catch(() => ({ errno: -1 }))
      const errno = Number(json.errno || 0)
      return { value: errno === 0 ? json.list || [] : [], errno }
    })
  }

  async ensureDir(dir) {
    const target = String(dir).replace(/\/+$/, '')
    if (!target || target === '/') return
    let cur = ''
    for (const part of target.split('/').filter(Boolean)) {
      const next = `${cur}/${part}`
      const parent = cur || '/'
      const exists = (await this.list(parent)).some((f) => f.server_filename === part && Number(f.isdir) === 1)
      if (!exists) {
        await this.call(async (token) => {
          const json = await this.postForm(`${PAN_FILE}?method=create&access_token=${token}`, {
            path: next,
            isdir: '1',
            size: '0',
            rtype: '1',
          })
          return { value: json, errno: Number(json.errno || 0) }
        })
      }
      cur = next
    }
  }

  /**
   * 上传（precreate → 逐片 upload → create 合片）；返回网盘绝对路径
   *
   * ⚠️ 为什么改成分片（2026-10-31）：文件备份 66.7 MB 单片直传，百度返回 `error_code: -1`
   *     且响应体为空，而同一流程传 176 KB 的数据库备份却正常 ⇒ 单片对大文件不可靠。
   *     百度官方 superfile2 的预期用法就是分片：每片必须是 4 MB，最后一片可以不足。
   *
   * ⚠️ 顺带修掉一个排障盲点：老实现把非 JSON 响应当成 `e.error_msg || ''`，
   *     遇到 HTML/空响应时错误信息是空的，只能看到"分片上传失败 -1："这种无从下手的提示。
   *     现在把 HTTP 状态码和响应体前 200 字符都带出来。
   */
  async upload(fileName, buffer) {
    if (!this.enabled()) throw new Error(`百度网盘未启用（缺 ${this.missingKeys().join(' / ')}）`)
    await this.ensureDir(this.root)
    const absPath = `${this.root}/${fileName}`
    const size = buffer.length

    const parts = []
    for (let off = 0; off < size; off += PART_SIZE) {
      const chunk = buffer.subarray(off, Math.min(off + PART_SIZE, size))
      parts.push({ seq: parts.length, md5: createHash('md5').update(chunk).digest('hex'), chunk })
    }
    const blockList = parts.map((p) => p.md5)

    /** 单片上传；失败重试 2 次（拉 CDN 抖动很常见），并把原始响应带出来 */
    const putPart = async (token, uploadid, part) => {
      let lastErr = ''
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(part.chunk)]), fileName)
        const url =
          `${PCS_SUPERFILE}?method=upload&access_token=${token}&type=tmpfile` +
          `&path=${encodeURIComponent(absPath)}&uploadid=${encodeURIComponent(uploadid)}&partseq=${part.seq}`
        try {
          const upRes = await fetch(url, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          })
          const upText = await upRes.text().catch(() => '')
          let upJson = null
          try {
            upJson = JSON.parse(upText)
          } catch {
            upJson = null
          }
          const code = upJson && upJson.error_code !== undefined ? Number(upJson.error_code) : upRes.ok ? 0 : -1
          if (code === 0) return
          lastErr =
            `partseq=${part.seq} HTTP=${upRes.status} code=${code} ` +
            `${upJson?.error_msg || upText.slice(0, 200)}`
        } catch (e) {
          lastErr = `partseq=${part.seq} 网络异常：${e?.message || e}`
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
      throw new Error(`分片上传失败（重试 3 次）：${lastErr}`)
    }

    return this.call(async (token) => {
      const pre = await this.postForm(`${PAN_FILE}?method=precreate&access_token=${token}`, {
        path: absPath,
        size: String(size),
        isdir: '0',
        autoinit: '1',
        block_list: JSON.stringify(blockList),
        rtype: '3',
      })
      if (Number(pre.errno) !== 0) throw new Error(`precreate 失败 errno=${pre.errno}: ${pre.errmsg || ''}`)

      const missing = Array.isArray(pre.block_list) ? pre.block_list.map(Number) : []
      if (missing.length === 0) return { value: absPath, errno: 0 } // 服务端已有所有分片 ⇒ 秒传

      const uploadid = String(pre.uploadid || '')
      for (const part of parts) {
        if (missing.length && !missing.includes(part.seq)) continue // 服务端已有该片，跳过
        await putPart(token, uploadid, part)
      }

      const cr = await this.postForm(`${PAN_FILE}?method=create&access_token=${token}`, {
        path: absPath,
        size: String(size),
        isdir: '0',
        block_list: JSON.stringify(blockList),
        uploadid,
        rtype: '3',
      })
      if (Number(cr.errno) !== 0) throw new Error(`合片失败 errno=${cr.errno}: ${cr.errmsg || ''}`)
      return { value: absPath, errno: 0 }
    })
  }

  /** 下载（两步）；失败返回 null，不抛 */
  async download(absPath) {
    try {
      return await this.call(async (token) => {
        const idx = absPath.lastIndexOf('/')
        const dir = absPath.slice(0, idx) || '/'
        const name = absPath.slice(idx + 1)
        const hit = (await this.list(dir)).find((f) => f.server_filename === name)
        if (!hit) return { value: null, errno: 0 }

        const meta = await fetch(
          `${PAN_MULTIMEDIA}?method=filemetas&access_token=${token}&dlink=1&fsids=${JSON.stringify([Number(hit.fs_id)])}`,
          { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) },
        )
        const mj = await meta.json().catch(() => ({ errno: -1 }))
        const dlink = mj?.list?.[0]?.dlink
        if (!dlink) return { value: null, errno: Number(mj.errno || 0) }

        const res = await fetch(`${dlink}&access_token=${token}`, {
          headers: { 'User-Agent': 'pan.baidu.com' },
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        if (!res.ok) return { value: null, errno: -1 }
        return { value: Buffer.from(await res.arrayBuffer()), errno: 0 }
      })
    } catch (e) {
      console.error('[netdisk] 下载失败', absPath, e?.message || e)
      return null
    }
  }

  /** 删除；返回是否成功（不抛） */
  async remove(absPath) {
    try {
      return await this.call(async (token) => {
        const json = await this.postForm(`${PAN_FILE}?method=filemanager&access_token=${token}&opera=delete`, {
          async: '0',
          filelist: JSON.stringify([absPath]),
        })
        return { value: Number(json.errno) === 0, errno: Number(json.errno || 0) }
      })
    } catch (e) {
      console.error('[netdisk] 删除失败', absPath, e?.message || e)
      return false
    }
  }
}
