import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { PRIVACY_POLICY_SECTIONS, PRIVACY_POLICY_TITLE, PRIVACY_POLICY_VERSION } from '@/constants/privacy-policy'

/**
 * 隐私政策页（OPS-18 R-合规-03）。
 *
 * 三个入口都指向这里：
 *  - 首屏「查看隐私政策」链接（components/policy-consent）
 *  - 「我的 → 隐私与账号」
 *  - 注销账号前的二次确认
 */
export default function PrivacyPage() {
  const [agreed, setAgreed] = useState(() => {
    try {
      return Taro.getStorageSync('gk_policy_agreed_v1') === PRIVACY_POLICY_VERSION
    } catch {
      return false
    }
  })

  const agree = () => {
    try {
      Taro.setStorageSync('gk_policy_agreed_v1', PRIVACY_POLICY_VERSION)
    } catch {
      /* ignore */
    }
    setAgreed(true)
    Taro.showToast({ title: '已记录同意', icon: 'success' })
  }

  const withdraw = async () => {
    const r = await Taro.showModal({
      title: '撤回同意',
      content:
        '撤回后我们会停止为你处理新数据。已保存的题目不会自动删除；如要彻底删除，请使用「注销账号」。',
      confirmText: '撤回',
      confirmColor: '#B3261E',
    })
    if (!r.confirm) return
    try {
      Taro.removeStorageSync('gk_policy_agreed_v1')
    } catch {
      /* ignore */
    }
    setAgreed(false)
    Taro.showToast({ title: '已撤回', icon: 'none' })
  }

  return (
    <View className="min-h-screen bg-background">
      <ScrollView scrollY className="h-screen">
        <View className="px-4 py-4">
          <Text className="block text-[17px] font-semibold text-foreground">{PRIVACY_POLICY_TITLE}</Text>
          <Text className="mt-1 block text-[12px] text-muted-foreground">版本 {PRIVACY_POLICY_VERSION}</Text>

          {PRIVACY_POLICY_SECTIONS.map((s) => (
            <View key={s.heading} className="mt-4">
              <Text className="block text-[14px] font-semibold text-foreground">{s.heading}</Text>
              {s.paragraphs.map((p, i) => (
                <Text key={i} className="mt-2 block text-[13px] leading-[21px] text-foreground">
                  {p}
                </Text>
              ))}
            </View>
          ))}

          <View className="mt-6 flex flex-col gap-3 pb-10">
            {!agreed ? (
              <View
                className="flex h-11 items-center justify-center rounded-xl bg-brand"
                onClick={agree}
              >
                <Text className="text-[15px] font-medium text-[color:var(--brand-foreground)]">
                  我已阅读并同意
                </Text>
              </View>
            ) : (
              <View className="flex h-11 items-center justify-center rounded-xl bg-muted" onClick={withdraw}>
                <Text className="text-[15px] text-muted-foreground">撤回同意</Text>
              </View>
            )}
            <View
              className="flex h-11 items-center justify-center rounded-xl border border-border"
              onClick={() => Taro.navigateBack()}
            >
              <Text className="text-[15px] text-muted-foreground">返回</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
