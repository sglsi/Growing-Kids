import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { POLICY_CONSENT_TEXT, PRIVACY_POLICY_VERSION } from '@/constants/privacy-policy'

const STORAGE_KEY = 'gk_policy_agreed_v1'

/**
 * 《隐私政策》首屏同意闸门（OPS-18 `R-合规-03` 第 2 点：监护人同意流程）。
 *
 * 与 `components/privacy-gate.tsx` 的分工，别混：
 *  - `privacy-gate` = 微信**平台级**隐私授权（相册/摄像头），由基础库在调用隐私接口时
 *    回调唤起，管的是「能不能调这个 API」；
 *  - `policy-consent`（本组件）= **业务级**隐私政策同意，管的是「我们有没有得到监护人
 *    对数据处理方式的同意」。两者都必要，互不替代。
 *
 * 交互取舍：不采用「不点同意就锁死」的强制拦截（会被平台判为强制授权），
 * 而是**每次启动提示 + 可继续浏览**；但涉及上传/写入的操作仍需先同意。
 * 数据主体是未成年人，因此文案写成监护人第一人称，并要求勾选而非默认勾选。
 */
export default function PolicyConsent() {
  const [visible, setVisible] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let agreed = ''
    try {
      agreed = Taro.getStorageSync(STORAGE_KEY) || ''
    } catch {
      agreed = ''
    }
    // 版本号变化后重新征求同意（政策更新是实质变更，不能沿用旧同意）
    if (agreed !== PRIVACY_POLICY_VERSION) setVisible(true)
  }, [])

  if (!visible) return null

  const openPolicy = () => {
    Taro.navigateTo({ url: '/pages/privacy/index' })
  }

  const accept = () => {
    if (!checked) {
      Taro.showToast({ title: '请先勾选同意', icon: 'none' })
      return
    }
    try {
      Taro.setStorageSync(STORAGE_KEY, PRIVACY_POLICY_VERSION)
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  const later = () => {
    setVisible(false)
    Taro.showToast({ title: '可随时在「我的 → 隐私与账号」中同意', icon: 'none', duration: 2500 })
  }

  return (
    <View className="fixed inset-0 z-[300] flex items-end bg-black bg-opacity-40">
      <View className="w-full rounded-t-2xl bg-background px-4 pb-6 pt-4">
        <Text className="block text-[16px] font-semibold text-foreground">开始前请确认</Text>

        <ScrollView scrollY className="mt-3 max-h-[36vh]">
          <Text className="block text-[13px] leading-[21px] text-foreground">{POLICY_CONSENT_TEXT}</Text>
          {/* ⚠️ Taro 4.1.9：Text 上绑 onClick 不生效（见 app.tsx 顶部遗留 bug 说明），
              可点击元素一律用 View —— 否则「查看完整《隐私政策》」点了没反应。 */}
          <View className="mt-2" onClick={openPolicy}>
            <Text className="block text-[13px] leading-[21px] text-brand-text">查看完整《隐私政策》›</Text>
          </View>
          <Text className="mt-3 block text-[12px] leading-[19px] text-muted-foreground">
            要点：数据保存在云端（含境外区域）；检索与讲解会把题干发给第三方服务方；我们不会收集孩子的姓名、学校、位置；
            可随时在「我的」中删除数据或注销账号。
          </Text>
        </ScrollView>

        <View className="mt-3 flex flex-row items-start gap-2" onClick={() => setChecked((v) => !v)}>
          <View
            className={`mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${
              checked ? 'border-brand bg-brand' : 'border-border bg-background'
            }`}
          >
            {checked ? <Text className="text-[12px] text-[color:var(--brand-foreground)]">✓</Text> : null}
          </View>
          <Text className="text-[12px] leading-[19px] text-foreground">
            我已阅读并同意《隐私政策》，且我是该学习账号的监护人
          </Text>
        </View>

        <View className="mt-4 flex flex-row gap-3">
          <View
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-border"
            onClick={later}
          >
            <Text className="text-[14px] text-muted-foreground">稍后再说</Text>
          </View>
          <View
            className={`flex h-11 flex-[1.4] items-center justify-center rounded-xl ${checked ? 'bg-brand' : 'bg-muted'}`}
            onClick={accept}
          >
            <Text className={`text-[15px] font-medium ${checked ? 'text-[color:var(--brand-foreground)]' : 'text-muted-foreground'}`}>
              同意并继续
            </Text>
          </View>
        </View>
      </View>
    </View>
  )
}
