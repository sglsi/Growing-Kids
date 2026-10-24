import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'

/**
 * 百度网盘 OpenAPI 直连服务（思傅 2026-10-24 定：资料库归档到网盘 /学生/GrowingKids资料库）
 * ------------------------------------------------------------------
 * 为什么不用 WorkBuddy 的「百度网盘」连接器：
 *   连接器是**客户端侧**能力，只能列目录 / 搜索 / 上传文本或 URL 转存，
 *   传不了 PDF、图片这类二进制；且它的凭据本地加密存储，后端拿不到。
 *   要后端自己把资料库文件写进网盘，只能走百度开放平台 OAuth（本服务 + baidu-oauth.mjs）。
 *
 * 所需凭证（写 server/.env.secrets，改后跑 encrypt-env.mjs）：
 *   BAIDU_APP_KEY / BAIDU_SECRET_KEY —— pan.baidu.com/union 创建应用
 *   BAIDU_REFRESH_TOKEN              —— 由 `node server/scripts/baidu-oauth.mjs auth|code` 取得
 *   BAIDU_ACCESS_TOKEN               —— 30 天有效；缺失时本服务会自动用 refresh_token 换
 *   BAIDU_NETDISK_ROOT               —— 可选，默认 /学生/GrowingKids资料库
 *
 * ⚠️ 已知约束（踩过才知道，改前必读）：
 *   1. 路径含中文必须 urlencode（URLSearchParams / encodeURIComponent 自动处理）；
 *   2. 上传三步走：precreate（拿 uploadid，block_list 回空=已秒传）→ superfile2（分片）
 *      → create（合片）；缺任何一步网盘里都不会出现文件；
 *   3. 下载必须两步：filemetas 换 dlink（有效期 8h）→ 带 `User-Agent: pan.baidu.com` 头下载，
 *      直接拿文件路径下载会被拒；
 *   4. access_token 只有 30 天 ⇒ 每次调用都包在 withTokenRetry 里，撞 errno=111 自动刷新重试一次；
 *   5. 网盘接口有 errno 口径（不是 HTTP 状态码），**errno≠0 必须当失败处理**。
 */

const OAUTH_TOKEN = 'https://openapi.baidu.com/oauth/2.0/token'
const PAN_FILE = 'https://pan.baidu.com/rest/2.0/xpan/file'
const PAN_MULTIMEDIA = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
const PCS_SUPERFILE = 'https://d.pcs.baidu.com/rest/2.0/pcs/superfile2'

/**
 * ⚠️⚠️ 2026-06-03 起百度网盘开放平台的新规（官方文档明示，防第三方应用误操作）：
 *   在该日期**之后创建的应用**，以下接口**仅允许访问 `/apps/{appname}/` 目录下的文件**：
 *     download / multimedia?method=listall / filemanager / **precreate（上传第一步）** / meta / move
 *   appname = 你在控制台填的「应用名称」。所以根目录**必须**写成 `/apps/{你的应用名}/...`，
 *   写 `/学生/...` 会被接口直接拒绝（errno≠0，日志里表现为"precreate 失败 errno=xxx"）。
 *   旧应用（2026-06-03 前创建）不受此限，可自由指定目录。
 *   想落到 `/学生/...` 又不走 API ⇒ 改用「本机客户端同步空间」方案（见操作指引文档方案 B）。
 */
const DEFAULT_ROOT = '/apps/GrowingKids/GrowingKids资料库'
const REQ_TIMEOUT_MS = Number(process.env.BAIDU_TIMEOUT_MS || 30000)
const UPLOAD_TIMEOUT_MS = Number(process.env.BAIDU_UPLOAD_TIMEOUT_MS || 120000)

/** token 无效 / 过期（撞到就刷新 access_token 重试一次） */
const TOKEN_ERRNOS = new Set([111, -6, 2, 10])

type Json = Record<string, any>

@Injectable()
export class BaiduNetdiskService {
  private readonly logger = new Logger(BaiduNetdiskService.name)
  private cachedToken = ''

  /** 凭证齐了才启用；缺项返回 false（调用方据此静默跳过，绝不硬失败） */
  enabled(): boolean {
    return !!(
      (process.env.BAIDU_APP_KEY || '').trim() &&
      (process.env.BAIDU_SECRET_KEY || '').trim() &&
      (process.env.BAIDU_REFRESH_TOKEN || '').trim()
    )
  }

  missingKeys(): string[] {
    const miss: string[] = []
    if (!(process.env.BAIDU_APP_KEY || '').trim()) miss.push('BAIDU_APP_KEY')
    if (!(process.env.BAIDU_SECRET_KEY || '').trim()) miss.push('BAIDU_SECRET_KEY')
    if (!(process.env.BAIDU_REFRESH_TOKEN || '').trim()) miss.push('BAIDU_REFRESH_TOKEN')
    return miss
  }

  root(): string {
    return (process.env.BAIDU_NETDISK_ROOT || DEFAULT_ROOT).trim().replace(/\/+$/, '')
  }

  /** 取 access_token：优先内存缓存 → env → refresh_token 换取 */
  private async token(force = false): Promise<string> {
    if (!force && this.cachedToken) return this.cachedToken
    const fromEnv = (process.env.BAIDU_ACCESS_TOKEN || '').trim()
    if (!force && fromEnv) {
      this.cachedToken = fromEnv
      return fromEnv
    }
    const appKey = (process.env.BAIDU_APP_KEY || '').trim()
    const secretKey = (process.env.BAIDU_SECRET_KEY || '').trim()
    const refreshToken = (process.env.BAIDU_REFRESH_TOKEN || '').trim()
    if (!appKey || !secretKey || !refreshToken) {
      throw new Error(`百度网盘凭证不完整（缺 ${this.missingKeys().join(' / ')}）`)
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: secretKey,
    })
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => ({}))) as Json
    if (json.error || !json.access_token) {
      throw new Error(`百度网盘 token 刷新失败：${String(json.error_description || json.error || 'unknown')}`)
    }
    // 只更新进程内 env（不落盘：磁盘上的 .env.secrets 由 baidu-oauth.mjs 负责写）
    process.env.BAIDU_ACCESS_TOKEN = String(json.access_token)
    if (json.refresh_token) process.env.BAIDU_REFRESH_TOKEN = String(json.refresh_token)
    this.cachedToken = String(json.access_token)
    this.logger.log('[baidu-netdisk] access_token 已刷新（30 天有效）')
    return this.cachedToken
  }

  /** 统一包一层：撞 token 类 errno 就刷新后重试一次 */
  private async call<T>(fn: (token: string) => Promise<{ value: T; errno: number }>): Promise<T> {
    let token = await this.token()
    let r = await fn(token)
    if (TOKEN_ERRNOS.has(Number(r.errno))) {
      token = await this.token(true)
      r = await fn(token)
    }
    return r.value
  }

  private async postForm(url: string, form: Record<string, string>): Promise<Json> {
    const res = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    })
    return (await res.json().catch(() => ({ errno: -1, errmsg: '响应非 JSON' }))) as Json
  }

  /** 列目录（返回原始条目：server_filename / fs_id / isdir / size） */
  async list(dir: string): Promise<Json[]> {
    if (!this.enabled()) return []
    return this.call(async (token) => {
      const res = await fetch(
        `${PAN_FILE}?method=list&access_token=${token}&dir=${encodeURIComponent(dir)}`,
        { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) },
      )
      const json = (await res.json().catch(() => ({ errno: -1 }))) as Json
      return { value: Number(json.errno) === 0 ? ((json.list || []) as Json[]) : [], errno: Number(json.errno || 0) }
    })
  }

  /** 建目录（已存在则跳过；不存在时逐级创建） */
  async ensureDir(dir: string): Promise<void> {
    if (!this.enabled()) return
    const target = dir.replace(/\/+$/, '')
    if (!target || target === '/') return
    const parts = target.split('/').filter(Boolean)
    let cur = ''
    for (const p of parts) {
      const next = `${cur}/${p}`
      const parent = cur || '/'
      const exists = (await this.list(parent)).some(
        (f) => f.server_filename === p && Number(f.isdir) === 1,
      )
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
        this.logger.log(`[baidu-netdisk] 建目录 ${next}`)
      }
      cur = next
    }
  }

  /**
   * 上传文件到网盘（三步：precreate → superfile2 → create）。
   *
   * @param fileName 网盘里的文件名（可含中文；重名按 rtype=3 覆盖）
   * @param buffer   文件内容
   * @returns 网盘绝对路径
   */
  async upload(fileName: string, buffer: Buffer): Promise<string> {
    if (!this.enabled()) throw new Error(`百度网盘未启用（缺 ${this.missingKeys().join(' / ')}）`)
    const dir = this.root()
    await this.ensureDir(dir)
    const path = `${dir}/${fileName}`
    const md5 = createHash('md5').update(buffer).digest('hex')
    const size = String(buffer.length)

    return this.call(async (token) => {
      // ① precreate：拿 uploadid；block_list 回空数组 = 网盘已有同 md5 文件（秒传）
      const pre = await this.postForm(`${PAN_FILE}?method=precreate&access_token=${token}`, {
        path,
        size,
        isdir: '0',
        autoinit: '1',
        block_list: JSON.stringify([md5]),
        rtype: '3',
      })
      if (Number(pre.errno) !== 0) {
        throw new Error(`precreate 失败 errno=${pre.errno}: ${String(pre.errmsg || '')}`)
      }
      const blocks: unknown[] = Array.isArray(pre.block_list) ? pre.block_list : []
      if (blocks.length === 0) {
        this.logger.log(`[baidu-netdisk] 秒传命中 ${path}`)
        return { value: path, errno: 0 }
      }
      const uploadid = String(pre.uploadid || '')

      // ② superfile2：单分片上传（资料库文件都在几十 MB 内，一块足够）
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buffer)]), fileName)
      const upRes = await fetch(
        `${PCS_SUPERFILE}?method=upload&access_token=${token}&type=tmpfile` +
          `&path=${encodeURIComponent(path)}&uploadid=${encodeURIComponent(uploadid)}&partseq=0`,
        { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) },
      )
      const upJson = (await upJsonSafe(upRes)) as Json
      if (upJson.error_code !== undefined && Number(upJson.error_code) !== 0) {
        throw new Error(`分片上传失败 ${upJson.error_code}: ${String(upJson.error_msg || '')}`)
      }

      // ③ create：合片，文件此时才真正出现在网盘
      const cr = await this.postForm(`${PAN_FILE}?method=create&access_token=${token}`, {
        path,
        size,
        isdir: '0',
        block_list: JSON.stringify([md5]),
        uploadid,
        rtype: '3',
      })
      if (Number(cr.errno) !== 0) {
        throw new Error(`合片失败 errno=${cr.errno}: ${String(cr.errmsg || '')}`)
      }
      this.logger.log(`[baidu-netdisk] 已上传 ${path}（${size}B）`)
      return { value: path, errno: 0 }
    })
  }

  /** 按绝对路径下载（filemetas 换 dlink → 带 UA 下载）；失败返回 null */
  async download(absPath: string): Promise<Buffer | null> {
    if (!this.enabled()) return null
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
        const mj = (await meta.json().catch(() => ({ errno: -1 }))) as Json
        const dlink = mj?.list?.[0]?.dlink
        if (!dlink) return { value: null, errno: Number(mj.errno || 0) }

        // ⚠️ 必须带 UA：pan.baidu.com，否则下载被拒
        const res = await fetch(`${dlink}&access_token=${token}`, {
          headers: { 'User-Agent': 'pan.baidu.com' },
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
        if (!res.ok) return { value: null, errno: -1 }
        return { value: Buffer.from(await res.arrayBuffer()), errno: 0 }
      })
    } catch (e) {
      console.error('[baidu-netdisk] 下载失败', absPath, e)
      return null
    }
  }

  /** 删除网盘文件；失败返回 false（不抛，调用方按 best-effort 处理） */
  async remove(absPath: string): Promise<boolean> {
    if (!this.enabled()) return false
    try {
      return await this.call(async (token) => {
        const json = await this.postForm(
          `${PAN_FILE}?method=filemanager&access_token=${token}&opera=delete`,
          { async: '0', filelist: JSON.stringify([absPath]) },
        )
        return { value: Number(json.errno) === 0, errno: Number(json.errno || 0) }
      })
    } catch (e) {
      console.error('[baidu-netdisk] 删除失败', absPath, e)
      return false
    }
  }
}

/** superfile2 的返回可能是 JSON 也可能不是，统一安全解析 */
async function upJsonSafe(res: Response): Promise<Json> {
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text) as Json
  } catch {
    // 成功时也可能返回 {"md5":"..."} 之外的纯文本；按「无 error_code」视为成功
    return { error_code: res.ok ? 0 : -1, error_msg: text.slice(0, 200) }
  }
}
