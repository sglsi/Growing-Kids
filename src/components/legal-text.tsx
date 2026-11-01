import { Text } from '@tarojs/components'

/**
 * 法律文案渲染（用户协议 / 隐私政策）。
 *
 * 为什么需要：`constants/user-agreement.ts` 与 `constants/privacy-policy.ts` 里的正文
 * 用 `**文字**` 标强调，但页面原先直接把整串塞进 <Text>，小程序不解析 Markdown
 * ⇒ 用户看到的是「本小程序是一个**辅助整理与复习工具**」这种带星号的原文。
 * 两份文件共 100+ 处强调，2026-11-01 页面冒烟时才被发现（工具从未跑过这两页）。
 *
 * 取舍：不引 Markdown 库（这套文案只需要粗体一种标记），就地按 `**` 切分，
 * 奇数段包一层 `font-semibold`。前提是每段文本的 `**` 必须成对——
 * 已用脚本核过全部 114 条字面量，若将来新增奇数个星号会退化成把后半段全加粗，
 * 不会崩，但属于文案笔误，改文案时留意。
 */
export function LegalText({ text, className }: { text: string; className?: string }) {
  // 没有强调标记就走快路径，避免无谓的嵌套
  if (!text.includes('**')) {
    return <Text className={className}>{text}</Text>
  }
  const parts = text.split('**')
  return (
    <Text className={className}>
      {parts.map((seg, i) =>
        i % 2 === 1 ? (
          // 微信里嵌套 <Text> 会继承外层样式，只覆盖字重即可
          <Text key={i} className="font-semibold">
            {seg}
          </Text>
        ) : (
          // 纯文本段必须带 key，否则 React 会警告数组子元素缺 key
          <Text key={i}>{seg}</Text>
        )
      )}
    </Text>
  )
}

export default LegalText
