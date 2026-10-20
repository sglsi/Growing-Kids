import { Logger } from '@nestjs/common'
import type { WechatSession } from './auth.types'

const WX_CODE2SESSION = 'https://api.weixin.qq.com/sns/jscode2session'

/**
 * 调微信 code2session（服务端调用，AppSecret 不上前端）。
 * 登录（小程序）与 H5 扫码登录共用——两处都必须走同一把 openid 口径，
 * 保证「同一微信号 = 同一账号」跨端汇聚。
 */
export async function code2Session(code: string): Promise<WechatSession> {
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) {
    throw new Error('服务端未配置 WX_APPID / WX_SECRET，无法完成微信登录')
  }

  const url =
    `${WX_CODE2SESSION}?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`

  const logger = new Logger('WechatSession')
  let json: WechatSession
  try {
    const res = await fetch(url)
    json = (await res.json()) as WechatSession
  } catch (e) {
    logger.error('[auth] code2session 请求失败', e as Error)
    throw new Error('微信服务暂时不可用，请稍后重试')
  }

  if (json.errcode) {
    logger.warn(`[auth] code2session 返回错误 ${json.errcode}: ${json.errmsg}`)
  }
  return json
}
