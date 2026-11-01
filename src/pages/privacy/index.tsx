import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState } from 'react'
import {
  POLICY_CONSENT_STORAGE_KEY,
  PRIVACY_POLICY_SECTIONS,
  PRIVACY_POLICY_TITLE,
  PRIVACY_POLICY_VERSION,
} from '@/constants/privacy-policy'
import { hasAgreedPolicy, markPolicyAgreed } from '@/services/policy-gate'
import { LegalText } from '@/components/legal-text'

/**
 * 隐私政策页（OPS-18 R-合规-03）。
 *
 * 四个入口都指向这里：
 *  - 首屏「查看隐私政策」链接（components/policy-consent）
 *  - 「我的 → 隐私与账号」
 *  - 注销账号前的二次确认
 *  - **写操作被 `guardPolicy` 拦下时的「去同意」**（`?from=guard`，见 services/policy-gate）：
 *    这一路要求「同意后自动返回」，否则用户得自己找到返回键，很容易以为流程断了。
 */
export default function PrivacyPage() {
  const router = useRouter()
  /** 是不是被写操作闸门送上来的（决定同意后自动返回） */
  const fromGuard = router.params?.from === 'guard'
  const [agreed, setAgreed] = useState(() => hasAgreedPolicy())

  const agree = () => {
    // 与 policy-consent / guardPolicy 共用同一份状态（services/policy-gate），
    // 否则会出现「这里显示已同意、上传时仍被拦」的裂脑
    if (!markPolicyAgreed()) {
      Taro.showToast({ title: '同意状态保存失败，请检查存储空间', icon: 'none' })
      return
    }
    setAgreed(true)
    if (fromGuard) {
      // 停在原页会让人以为「点了同意就该继续」，而闸门按设计不会自动重放操作，
      // 所以先明确告知要再点一次，再退回原页（思傅 2026-10-31）
      Taro.showToast({ title: '已同意，请重新点击刚才的按钮', icon: 'none', duration: 2500 })
      setTimeout(() => {
        Taro.navigateBack().catch(() => {
          /* 直接从分享卡片进来时会退不动，留在本页即可 */
        })
      }, 900)
      return
    }
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
      Taro.removeStorageSync(POLICY_CONSENT_STORAGE_KEY)
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
                <LegalText
                  key={i}
                  text={p}
                  className="mt-2 block text-[13px] leading-[21px] text-foreground"
                />
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
