import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { applyLoginUser } from '@/services/auth'
import { buildHeaders, captureUserId, getUserId } from '@/services/net'
import type { AuthUser } from '@/types/auth'
import { BRAND_TEXT } from '@/lib/theme'

/**
 * H5 扫码登录·手机端落地页（思傅 2026-10-20 拍板）。
 *
 * 电脑浏览器没有 wx.login，登录入口改为「H5 出二维码 → 手机微信扫码」。
 * 二维码内容指向本页（带票据 token），手机微信扫开后：
 *   1. 动态注入微信 JSSDK（jweixin，普通网页在微信内置浏览器里的前提）
 *   2. Taro.login() 拿 code → POST /api/auth/qr-login/authorize
 *   3. 后端 code2session 换 openid → 找/建同一账号 → H5 轮询到 authorized 落身份
 *
 * 与小程序登录共用后端 openid 账号体系：同一微信号从哪端登录都是同一个账号。
 *
 * 路由：/#/pages/scan-login/index?token=<ticket>
 */

type Phase = 'checking' | 'authorizing' | 'done' | 'fail' | 'invalid'

/** 动态注入微信 JSSDK（Taro H5 的 Taro.login 依赖 window.wx） */
function loadJweixin(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).wx) return resolve()
    const s = document.createElement('script')
    s.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
    s.onload = () => ((window as any).wx ? resolve() : reject(new Error('微信 SDK 加载异常')))
    s.onerror = () => reject(new Error('微信 SDK 加载失败，请检查网络后重试'))
    document.head.appendChild(s)
  })
}

/** 手机微信内置浏览器 UA 检测（电脑上直接点开链接时给出提示） */
function isWechatBrowser(): boolean {
  return /MicroMessenger/i.test(navigator.userAgent)
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('未获取到登录凭证（code）'))),
      fail: (err) => reject(new Error(err.errMsg || '微信登录失败')),
    })
  })
}

export default function ScanLoginPage() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [msg, setMsg] = useState('')
  const token = (Taro.getCurrentInstance() as any)?.router?.params?.token || ''

  const run = useCallback(async () => {
    if (!token) {
      setPhase('invalid')
      return
    }
    if (!isWechatBrowser()) {
      setPhase('fail')
      setMsg('请使用手机微信「扫一扫」打开本页面')
      return
    }
    setPhase('authorizing')
    try {
      await loadJweixin()
      const code = await wxLoginCode()
      const res = await Network.request({
        url: '/api/auth/qr-login/authorize',
        method: 'POST',
        header: buildHeaders({ 'Content-Type': 'application/json' }),
        data: { code, token, anonymous_id: getUserId() || undefined },
      })
      captureUserId(res)
      const body = res.data as { code: number; msg?: string; data?: { user?: AuthUser } }
      if (res.statusCode < 200 || res.statusCode >= 300 || body?.code !== 200) {
        throw new Error(body?.msg || `授权失败(${res.statusCode})`)
      }
      if (body.data?.user) applyLoginUser(body.data.user)
      setPhase('done')
    } catch (e) {
      setPhase('fail')
      setMsg(e instanceof Error ? e.message : '授权失败，请重试')
    }
  }, [token])

  useEffect(() => {
    void run()
  }, [run])

  return (
    <View style={{ minHeight: '100vh', backgroundColor: '#F7F4EE', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 320, backgroundColor: '#fff', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Text style={{ fontSize: 18, fontWeight: 600, color: '#2A2724', marginBottom: 12 }}>扫码登录</Text>

        {phase === 'checking' || phase === 'authorizing' ? (
          <Text style={{ fontSize: 13, color: '#9A948A', lineHeight: '22px', textAlign: 'center' }}>正在确认登录，请稍候…</Text>
        ) : null}

        {phase === 'done' ? (
          <>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>✅</Text>
            <Text style={{ fontSize: 14, color: '#2A2724', lineHeight: '22px', textAlign: 'center' }}>
              电脑端已登录成功{'\n'}可以回到电脑继续操作了
            </Text>
          </>
        ) : null}

        {phase === 'fail' || phase === 'invalid' ? (
          <>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>⚠️</Text>
            <Text style={{ fontSize: 13, color: BRAND_TEXT, lineHeight: '22px', textAlign: 'center', marginBottom: 16 }}>
              {phase === 'invalid' ? '链接无效或参数缺失' : msg}
            </Text>
            {phase === 'fail' ? (
              <Button style={{ width: '100%' }} onClick={() => void run()}>重试</Button>
            ) : null}
          </>
        ) : null}

        <Text style={{ fontSize: 11, color: '#B5AFA6', marginTop: 20, textAlign: 'center', lineHeight: '18px' }}>
          成长学童 · 微信扫码登录{'\n'}同一微信号在各端登录均为同一账号
        </Text>
      </View>
    </View>
  )
}
