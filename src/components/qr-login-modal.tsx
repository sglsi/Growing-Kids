import { View, Text } from '@tarojs/components'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { applyLoginUser } from '@/services/auth'
import { buildHeaders } from '@/services/net'
import type { AuthUser } from '@/types/auth'
import { BRAND_TEXT } from '@/lib/theme'

/**
 * H5 扫码登录弹层（思傅 2026-10-20 拍板）：电脑浏览器没有 wx.login，
 * 本组件在 H5 端展示二维码（内容指向 scan-login 落地页），手机微信扫码
 * 授权后轮询得到身份并落本地。
 *
 * - 二维码库经 CDN 动态加载（UMD 全局 QRCode），不装 npm 包：
 *   小程序端不涉及本组件；装包会牵动 pnpm workspace/lockfile。
 * - 票据 5 分钟有效，过期自动重取（无需用户操作，静默续期）。
 * - 与小程序登录共用后端 openid 账号：同一微信号 = 同一账号。
 */

const QR_CDNS = [
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js',
  'https://unpkg.com/qrcode@1.5.4/build/qrcode.min.js',
]

type QRCodeLib = { toCanvas: (canvas: HTMLCanvasElement, text: string, opts: { width: number }, cb: (err?: Error) => void) => void }

function loadQrCodeLib(): Promise<QRCodeLib> {
  if ((window as any).QRCode) return Promise.resolve((window as any).QRCode)
  return new Promise((resolve, reject) => {
    let i = 0
    const tryNext = () => {
      if (i >= QR_CDNS.length) {
        reject(new Error('二维码组件加载失败，请检查网络后重试'))
        return
      }
      const s = document.createElement('script')
      s.src = QR_CDNS[i++]
      s.onload = () => ((window as any).QRCode ? resolve((window as any).QRCode) : tryNext())
      s.onerror = tryNext
      document.head.appendChild(s)
    }
    tryNext()
  })
}

interface Props {
  visible: boolean
  onClose: () => void
  /** 登录成功（含匿名数据迁移数）回调，供调用方刷新数据 */
  onSuccess: (user: AuthUser) => void
}

const POLL_INTERVAL = 1500

export default function QrLoginModal({ visible, onClose, onSuccess }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'done' | 'error'>('loading')
  const [msg, setMsg] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** 取票据 → 拼落地 URL → 画二维码 */
  const startLogin = async () => {
    setPhase('loading')
    setMsg('')
    try {
      const res = await Network.request({
        url: '/api/auth/qr-login/ticket',
        method: 'POST',
        header: buildHeaders(),
      })
      const body = res.data as { code: number; msg?: string; data?: { token?: string } }
      if (res.statusCode < 200 || res.statusCode >= 300 || body?.code !== 200 || !body.data?.token) {
        throw new Error(body?.msg || '创建登录二维码失败')
      }
      const token = body.data.token
      const lib = await loadQrCodeLib()
      // Taro H5 hash 路由：origin + pathname + #/pages/scan-login/index?token=
      // 该弹层只在 H5 用（小程序无 wx.login 场景不存在），但仍做存在性判断，
      // 避免在小程序端误渲染时 ReferenceError（lint 也禁止裸用 location）。
      const loc = typeof window !== 'undefined' ? window.location : undefined
      if (!loc) throw new Error('当前环境不支持扫码登录（仅浏览器可用）')
      const url = `${loc.origin}${loc.pathname}#/pages/scan-login/index?token=${encodeURIComponent(token)}`
      await new Promise<void>((resolve, reject) => {
        if (!canvasRef.current) {
          reject(new Error('二维码画布未就绪'))
          return
        }
        lib.toCanvas(canvasRef.current, url, { width: 200 }, (err) => (err ? reject(err) : resolve()))
      })
      setPhase('ready')
      pollStatus(token)
    } catch (e) {
      setPhase('error')
      setMsg(e instanceof Error ? e.message : '二维码加载失败')
    }
  }

  /** 轮询票据状态：authorized → 落身份 → 回调；expired → 静默重取 */
  const pollStatus = (token: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await Network.request({
          url: `/api/auth/qr-login/status?token=${encodeURIComponent(token)}`,
          method: 'GET',
          header: buildHeaders(),
        })
        const body = res.data as {
          code: number
          data?: { status?: 'pending' | 'authorized' | 'expired'; user?: AuthUser }
        }
        const st = body?.data?.status
        if (st === 'authorized' && body.data?.user) {
          if (pollRef.current) clearInterval(pollRef.current)
          applyLoginUser(body.data.user)
          setPhase('done')
          setTimeout(() => onSuccess(body.data!.user!), 800)
        } else if (st === 'expired') {
          if (pollRef.current) clearInterval(pollRef.current)
          void startLogin() // 静默换新二维码
        }
      } catch {
        /* 网络抖动：下个周期继续轮询 */
      }
    }, POLL_INTERVAL)
  }

  useEffect(() => {
    if (visible) void startLogin()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  if (!visible) return null

  return (
    <View
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onClick={onClose}
    >
      <View
        style={{
          width: '100%', maxWidth: 320, backgroundColor: '#fff', borderRadius: 16,
          padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}
        onClick={(e) => e?.stopPropagation?.()}
      >
        <Text style={{ fontSize: 16, fontWeight: 600, color: '#2A2724', marginBottom: 4 }}>微信扫码登录</Text>
        <Text style={{ fontSize: 11, color: '#9A948A', marginBottom: 16, textAlign: 'center', lineHeight: '18px' }}>
          用手机微信扫一扫，授权后电脑端即登录同一账号
        </Text>

        {phase === 'loading' ? <Text style={{ fontSize: 13, color: '#9A948A', height: 200, lineHeight: '200px' }}>二维码生成中…</Text> : null}
        {phase === 'ready' ? (
          <canvas ref={canvasRef} style={{ width: 200, height: 200 }} />
        ) : null}
        {phase === 'done' ? (
          <Text style={{ fontSize: 32, height: 200, lineHeight: '200px' }}>✅</Text>
        ) : null}
        {phase === 'error' ? (
          <View style={{ height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 13, color: BRAND_TEXT, textAlign: 'center', marginBottom: 12, lineHeight: '20px' }}>{msg}</Text>
            <Button onClick={() => void startLogin()}>重试</Button>
          </View>
        ) : null}

        <Text style={{ fontSize: 10, color: '#B5AFA6', marginTop: 16, textAlign: 'center', lineHeight: '16px' }}>
          {phase === 'ready' ? '二维码 5 分钟内有效，过期会自动刷新' : '成长学童 · 微信登录'}
        </Text>
        <View style={{ marginTop: 12, width: '100%' }}>
          <Button variant="outline" style={{ width: '100%' }} onClick={onClose}>取消</Button>
        </View>
      </View>
    </View>
  )
}
