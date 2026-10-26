import { Button, View, Text } from '@tarojs/components'
import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import {
  AGREE_BUTTON_ID,
  consumePending,
  installPrivacyListener,
  notifyExposure,
  onNeedPrivacy,
  openPrivacyContract,
} from '@/utils/privacy'
import { BRAND, BRAND_FOREGROUND, DANGER } from '@/lib/theme'

/**
 * 隐私保护指引授权弹窗（微信端限定）。
 *
 * 挂在 App 根组件上，平时不渲染任何东西；只有当某个隐私接口（拍照/相册）
 * 被调用、基础库挂起该次调用并回调 `onNeedPrivacyAuthorization` 时才弹出。
 *
 * 「同意」按钮必须是**原生 button + open-type=agreePrivacyAuthorization**：
 * 基础库会核验该 button 是否真的被用户点过，用 View 伪造点击或用 JS 直接
 * resolve({event:'agree'}) 都会被拒绝。这也是这里不用 UI 库 Button 封装的原因
 * （封装层不透传 openType 与 onAgreePrivacyAuthorization）。
 */
export default function PrivacyGate() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // 不用判断平台：installPrivacyListener 内部已做 API 存在性检测，
    // H5 / 抖音端无 wx.onNeedPrivacyAuthorization 时自动跳过，本组件也不会被唤起。
    installPrivacyListener()
    // 弹窗一出现就上报曝光，再等用户表态
    return onNeedPrivacy((need) => {
      if (need) {
        setOpen(true)
        notifyExposure()
      }
    })
  }, [])

  const handleAgree = () => {
    setOpen(false)
    const resolve = consumePending()
    try {
      resolve?.({ event: 'agree', buttonId: AGREE_BUTTON_ID })
    } catch (e) {
      console.error('[privacy] 同意回调失败', e)
    }
  }

  const handleDisagree = () => {
    setOpen(false)
    const resolve = consumePending()
    Taro.showToast({ title: '未同意则无法使用相册/拍照', icon: 'none' })
    try {
      resolve?.({ event: 'disagree' })
    } catch (e) {
      console.error('[privacy] 拒绝回调失败', e)
    }
  }

  if (!open) return null

  return (
    <View
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
    >
      <View
        className="rounded-2xl bg-background p-5 mx-6"
        style={{ width: '80%', maxWidth: 560, backgroundColor: '#ffffff' }}
      >
        <Text
          className="block text-base mb-3"
          style={{ color: '#1A1F2B', fontWeight: 500 }}
        >
          用户隐私保护提示
        </Text>
        <Text className="block text-sm mb-4" style={{ color: '#57534E', lineHeight: 1.7 }}>
          感谢你使用成长学童。拍照录题、相册上传资料等功能会访问你的相册与摄像头。
          继续使用这些功能前，请先阅读并同意本小程序的《用户隐私保护指引》。
        </Text>

        {/* 查看官方指引：走 wx.openPrivacyContract（Taro Button 的 openType
            联合里没有 openPrivacyContract，只有 agreePrivacyAuthorization） */}
        <Button
          className="w-full mb-3 text-sm"
          plain
          onClick={() => openPrivacyContract()}
          style={{ border: 'none', color: BRAND, fontSize: 28 }}
        >
          查看《用户隐私保护指引》
        </Button>

        <Button
          id={AGREE_BUTTON_ID}
          className="w-full mb-3"
          openType="agreePrivacyAuthorization"
          onAgreePrivacyAuthorization={handleAgree}
          style={{
            backgroundColor: BRAND,
            color: BRAND_FOREGROUND,
            fontSize: 32,
            lineHeight: 1.6,
          }}
        >
          同意并继续
        </Button>

        <Button
          className="w-full"
          plain
          onClick={handleDisagree}
          style={{ border: 'none', color: DANGER, fontSize: 28 }}
        >
          暂不同意
        </Button>
      </View>
    </View>
  )
}
