import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { POLICY_CONSENT_TEXT } from '@/constants/privacy-policy'
import {
  hasAgreedPolicy,
  markPolicyAgreed,
  onPolicyConsentRequest,
} from '@/services/policy-gate'

/**
 * 《隐私政策》首屏同意弹窗（OPS-18 `R-合规-03` 第 2 点：监护人同意流程）。
 *
 * 与 `components/privacy-gate.tsx` 的分工，别混：
 *  - `privacy-gate` = 微信**平台级**隐私授权（相册/摄像头），由基础库在调用隐私接口时
 *    回调唤起，管的是「能不能调这个 API」；
 *  - `policy-consent`（本组件）= **业务级**隐私政策同意，管的是「我们有没有得到监护人
 *    对数据处理方式的同意」。两者都必要，互不替代。
 *
 * 交互（思傅 2026-11-03 定，改成和主流应用一致）：
 *  - 居中弹窗，**正文只放一段摘要**，不在这里铺政策全文；
 *  - 下方给《用户协议》《隐私政策》两个链接，点开是独立整页，用户想读就读；
 *  - 勾选框在文字前面，勾上点「同意并继续」即完成授权，**不要求先滚完/读完**；
 *  - 仍不采用「不点同意就锁死」的强制拦截（会被平台判为强制授权）：
 *    可以先「暂不同意」，浏览已有内容不受影响，但上传/写入前仍会再问一次。
 *
 * 数据主体是未成年人 ⇒ 勾选文案里保留了「我是该学习账号的监护人」这层意思。
 */
export default function PolicyConsent() {
  // ⚠️ 初始值直接读存储，**不要**在 useEffect 里 setVisible(true)（思傅 2026-11-03 实测踩到）：
  //    最初本组件挂在 app.tsx，而 Taro 4.1.9 的 App 渲染出的是 `AppWrapper = h(App, ...)`，
  //    它产出的**兄弟节点不会挂到任何页面**（挂个 fixed 红点就能验证：DOM 里根本没有）；
  //    连带 effect 也跑在页面根还没就绪的时刻，那一次 setState 会被丢掉
  //    ⇒ 弹窗永远不出现（日志有、DOM 没有）。现在改挂 `pages/index`（首页，冷启动必经），
  //    并把判断放进 useState 初始值，等于「首帧就画出来」，不依赖任何后续更新。
  //    二级页面不挂本组件：写操作由 `guardPolicy` 跳独立隐私页兜底，不靠弹层。
  const [visible, setVisible] = useState(() => !hasAgreedPolicy())
  const [checked, setChecked] = useState(false)

  /** 这次弹出是不是被写操作拦下来的（决定关掉后要不要提示「请重试刚才的操作」） */
  const forcedRef = useRef(false)

  useEffect(() => {
    // GK-23-24：写操作被 guardPolicy 拦下时会唤起本层，用户点「去同意」才走到这里
    return onPolicyConsentRequest(() => {
      forcedRef.current = true
      setChecked(false)
      setVisible(true)
    })
  }, [])

  if (!visible) return null

  const openAgreement = () => {
    Taro.navigateTo({ url: '/pages/agreement/index' })
  }

  const openPolicy = () => {
    Taro.navigateTo({ url: '/pages/privacy/index' })
  }

  const accept = () => {
    if (!checked) {
      Taro.showToast({ title: '请先勾选同意', icon: 'none' })
      return
    }
    if (!markPolicyAgreed()) {
      // 写不进去等于没同意：必须说清楚，否则用户点十次上传都会被同一道闸门拦回
      Taro.showToast({ title: '同意状态保存失败，请检查存储空间后重试', icon: 'none', duration: 3000 })
      return
    }
    setVisible(false)
    if (forcedRef.current) {
      forcedRef.current = false
      Taro.showToast({ title: '已同意，请重新点击刚才的按钮', icon: 'none', duration: 2500 })
    }
  }

  const later = () => {
    setVisible(false)
    if (forcedRef.current) {
      forcedRef.current = false
      Taro.showToast({ title: '未同意，本次操作已取消', icon: 'none', duration: 2500 })
      return
    }
    Taro.showToast({ title: '可先浏览，上传前会再问你一次', icon: 'none', duration: 2500 })
  }

  return (
    <View
      className="fixed inset-0 z-[300] flex items-center justify-center px-6"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
    >
      <View className="w-full rounded-2xl bg-background px-5 pb-5 pt-5" style={{ maxWidth: 620 }}>
        <Text className="block text-[16px] font-semibold text-foreground">隐私保护提示</Text>

        <Text className="mt-3 block text-[13px] leading-[21px] text-foreground">{POLICY_CONSENT_TEXT}</Text>

        {/* 声明入口放在下部：点开是独立整页，读多细由用户自己决定 */}
        <View className="mt-3 flex flex-row flex-wrap items-center">
          <View onClick={openAgreement}>
            <Text className="block text-[13px] leading-[22px] text-brand-text">《用户协议》</Text>
          </View>
          <Text className="block text-[13px] leading-[22px] text-muted-foreground"> 和 </Text>
          <View onClick={openPolicy}>
            <Text className="block text-[13px] leading-[22px] text-brand-text">《隐私政策》</Text>
          </View>
        </View>

        {/* 勾选框在文字前面（主流样式）；整行可点，别让人去瞄准那个小方块 */}
        <View
          className="mt-4 flex flex-row items-start gap-2"
          onClick={() => setChecked((v) => !v)}
        >
          <View
            className={`mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${
              checked ? 'border-brand bg-brand' : 'border-border bg-background'
            }`}
          >
            {checked ? <Text className="text-[12px] text-[color:var(--brand-foreground)]">✓</Text> : null}
          </View>
          <Text className="text-[12px] leading-[19px] text-foreground">
            我已阅读并同意《用户协议》与《隐私政策》（我是该学习账号的监护人）
          </Text>
        </View>

        <Text className="mt-2 block text-[11px] leading-[18px] text-muted-foreground">
          可随时在「我的 → 隐私与账号」中查看全文或撤回同意。
        </Text>

        <View className="mt-4 flex flex-row gap-3">
          <View
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-border"
            onClick={later}
          >
            <Text className="text-[14px] text-muted-foreground">暂不同意</Text>
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
