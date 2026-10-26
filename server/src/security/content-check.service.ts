import { Injectable, Logger } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'

/**
 * 微信文本内容安全检测（`security.msgSecCheck` v2 同步接口）。
 *
 * ## 为什么必须做
 * 小程序**凡用户可产出内容的场景**（UGC），提审时被要求接入内容安全检测，
 * 否则大概率驳回。本项目的 UGC 入口：
 *   · `chat/send` 用户提问（还会被拼进 system prompt 的上下文）
 *   · `chat/knowledge` 知识库文章（全局可见，直接决定所有用户助手的回答口径）
 *
 * ## 设计取舍
 * - **best-effort**：检测不可用时**放行**而非阻断，避免微信接口抖动把整条对话链路打死；
 *   但失败必须 `console.error` 打全错（项目铁律：best-effort catch 必须打全错）。
 * - **未配置 appid/secret 直接放行**：本地开发/无凭据环境不应被拒绝服务。
 * - **同步短文本足够**：聊天单条消息量小；超长文本按 2000 字切片逐段检查。
 * - **AI 回复默认不检**（`CONTENT_CHECK_AI_REPLY=true` 才开）：
 *   回复经 LLM 再走一轮检测会显著拉长响应链路；如需满足更严格的内容合规，打开开关即可。
 */

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const MSG_SEC_CHECK = 'https://api.weixin.qq.com/wxa/msg_sec_check'

/** 单次检测上限（微信限制 2500 字），留余量按 2000 切片 */
const CHUNK_SIZE = 2000

export interface TextCheckResult {
  /** true = 通过（含「检测不可用」时的放行） */
  allowed: boolean
  /** 处置建议：pass 通过 / risky 疑似 / reject 违规 */
  suggest: 'pass' | 'risky' | 'reject' | 'skipped'
  /** 违规类型码（10001 广告等），仅 reject/risky 时有意义 */
  label?: number
}

@Injectable()
export class ContentCheckService {
  private readonly logger = new Logger('ContentCheck')
  private cachedToken: string | null = null
  private tokenExpireAt = 0
  /** 凭据缺失时只 warn 一次，避免每条消息刷屏 */
  private warnedNoCred = false
  /** 匿名跳过同理只 warn 一次 */
  private warnedNoOpenId = false
  /** userId → openid 短期缓存（5 分钟），避免每条消息都查一次 users 表 */
  private openIdCache = new Map<string, { openId: string | null; expireAt: number }>()

  /** 缓存 access_token（官方规定 2h 有效期，这里提前 5 分钟过期，避开临界失效） */
  private async getAccessToken(): Promise<string | null> {
    const appid = process.env.WX_APPID
    const secret = process.env.WX_SECRET
    if (!appid || !secret) {
      if (!this.warnedNoCred) {
        this.warnedNoCred = true
        this.logger.warn('未配置 WX_APPID / WX_SECRET，内容安全检测跳过（不影响本地开发）')
      }
      return null
    }
    if (this.cachedToken && Date.now() < this.tokenExpireAt) return this.cachedToken

    try {
      const res = await fetch(
        `${TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`,
      )
      const json = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
      if (!json.access_token) {
        // 常见：40164 ip 不在白名单、40001 secret 错误、45009 频率限制
        this.logger.error(`[content-check] 获取 access_token 失败 ${json.errcode}: ${json.errmsg}`)
        return null
      }
      this.cachedToken = json.access_token
      this.tokenExpireAt = Date.now() + ((json.expires_in || 7200) - 300) * 1000
      return this.cachedToken
    } catch (e) {
      console.error('[content-check] 获取 access_token 异常', e)
      return null
    }
  }

  /**
   * 取用户的微信 openid。
   *
   * ⚠️ `msg_sec_check` v2 接口**强制要求** openid（否则返回 `40003 invalid openid`，
   *    检测等于没跑）。本项目 userId 是内部 UUID，必须先换成真实 openid。
   *    匿名/设备建号的用户 `open_id` 为 NULL ⇒ 上层按「跳过」处理，不要拿假值去撞接口。
   */
  private async resolveOpenId(userId: string): Promise<string | null> {
    const hit = this.openIdCache.get(userId)
    if (hit && hit.expireAt > Date.now()) return hit.openId
    let openId: string | null = null
    try {
      const { data, error } = await getSupabaseClient()
        .from('users')
        .select('open_id')
        .eq('id', userId)
        .maybeSingle()
      if (error) console.error('[content-check] 查询 open_id 失败', error.message)
      else openId = ((data as { open_id?: string | null } | null)?.open_id || null) as string | null
    } catch (e) {
      console.error('[content-check] 查询 open_id 异常', e)
    }
    this.openIdCache.set(userId, { openId, expireAt: Date.now() + 5 * 60 * 1000 })
    return openId
  }

  /**
   * 文本过检。返回 allowed=false 时应拒绝入库。
   * 异常一律兜底放行——宁可漏审，也不能因为检测服务抖动让用户发不出消息。
   *
   * @param userId 用户内部 id；用于换取真实 openid。
   *               匿名（无 openid）用户会跳过检测并只告警一次。
   */
  async checkText(
    text: string,
    opts: { userId?: string; scene?: 1 | 2 | 3 | 4 } = {},
  ): Promise<TextCheckResult> {
    const content = (text || '').trim()
    if (!content) return { allowed: true, suggest: 'pass' }

    const token = await this.getAccessToken()
    if (!token) return { allowed: true, suggest: 'skipped' }

    const scene = opts.scene ?? 2
    const openid = opts.userId ? await this.resolveOpenId(opts.userId) : null
    if (!openid) {
      if (!this.warnedNoOpenId) {
        this.warnedNoOpenId = true
        this.logger.warn(
          '未提供 openid（匿名用户或未走微信登录）⇒ 跳过内容安全检测（v2 接口强制要求 openid）',
        )
      }
      return { allowed: true, suggest: 'skipped' }
    }

    const chunks = splitByChars(content, CHUNK_SIZE)
    for (const chunk of chunks) {
      try {
        const res = await fetch(`${MSG_SEC_CHECK}?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunk, scene, version: 2, openid }),
        })
        const json = (await res.json()) as {
          errcode?: number
          errmsg?: string
          result?: { suggest?: string; label?: number }
        }
        // 87014 = 内容含违规信息
        if (json.errcode === 87014 || json.errcode === 40001) {
          if (json.errcode === 40001) {
            // token 失效：清缓存让下次重新获取，本次放行
            this.cachedToken = null
            this.logger.error('[content-check] access_token 失效，本次放行并重置缓存')
            continue
          }
          this.logger.warn(`[content-check] 命中违规 label=${json.result?.label}`)
          return { allowed: false, suggest: 'reject', label: json.result?.label }
        }
        if (json.errcode) {
          // 其他错误（如频率限制 45009）：放行并打全错，便于运维判因
          console.error(`[content-check] 检测接口异常 ${json.errcode}: ${json.errmsg}`)
          continue
        }
        const suggest = json.result?.suggest || 'pass'
        if (suggest === 'risky' || suggest === 'reject') {
          return { allowed: false, suggest: suggest as 'risky' | 'reject', label: json.result?.label }
        }
      } catch (e) {
        console.error('[content-check] 检测请求失败（放行）', e)
      }
    }
    return { allowed: true, suggest: 'pass' }
  }
}

/** 按字符数切片（避免按字节截断把多字节字符切坏） */
function splitByChars(s: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
