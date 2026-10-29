import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { AGREEMENT_SECTIONS, AGREEMENT_TITLE, AGREEMENT_VERSION } from '@/constants/user-agreement'

/**
 * 用户协议页（上线验收第 11 项）。
 *
 * 提审材料一般要求《用户协议》与《隐私政策》齐备，两个入口并排放。
 * 与隐私政策页的区别：本页**无「同意/撤回」按钮**——同意发生在首次进入
 * （components/policy-consent），这里只负责「随时能查到」。
 */
export default function AgreementPage() {
  return (
    <View className="min-h-screen bg-background">
      <ScrollView scrollY className="h-screen">
        <View className="px-4 py-4">
          <Text className="block text-[17px] font-semibold text-foreground">{AGREEMENT_TITLE}</Text>
          <Text className="mt-1 block text-[12px] text-muted-foreground">版本 {AGREEMENT_VERSION}</Text>

          {AGREEMENT_SECTIONS.map((s) => (
            <View key={s.heading} className="mt-4">
              <Text className="block text-[14px] font-semibold text-foreground">{s.heading}</Text>
              {s.paragraphs.map((p, i) => (
                <Text key={i} className="mt-2 block text-[13px] leading-[21px] text-foreground">
                  {p}
                </Text>
              ))}
            </View>
          ))}

          <View className="mt-6 pb-10">
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
