import { View, Text, RichText } from '@tarojs/components'
import { useMemo } from 'react'
import { splitMathText, lineToNodes, lineHasMath } from '@/utils/latex'

/**
 * 数学文本渲染（思傅 2026-10-22：答案/解题过程里 LaTeX 原题显示，看不懂）
 *
 * 思路：整段文本按行切分 —— 行内没有公式就走普通 Text（保持原有排版，零开销）；
 * 含公式的行整行交给 rich-text 渲染（普通文字与公式在同一行内自然混排）。
 * 公式由 utils/latex.ts 转成内联 style 的 span 树：分数是真上下两层+分数线、
 * 上下标是真上下标、根号用 √ 字形+顶部横线。
 *
 * ⚠️ 解析失败的行**回退显示源码**：宁可看到 LaTeX，也不显示错误的数学式。
 */

interface Props {
  text: string
  /** 字号（px，rich-text 内是真实 CSS px，与 Taro 的 rpx 换算后视觉一致） */
  size?: number
  color?: string
  lineHeight?: number
  className?: string
}

export default function MathText({
  text,
  size = 14,
  color = '#3D3833',
  lineHeight = 1.75,
  className,
}: Props) {
  const lines = useMemo(() => splitMathText(text || ''), [text])

  return (
    <View className={className}>
      {lines.map((line, li) => {
        const raw = line.map((p) => p.v).join('')

        // 空行：留一个半行高的间距，保留段落分隔
        if (!line.length || !raw.trim()) {
          return <View key={li} style={{ height: size * 0.5 }} />
        }

        // 整行无公式 → 普通文本（不进 rich-text，样式/换行行为与原来一致）
        if (!lineHasMath(line)) {
          return (
            <Text key={li} className="block" style={{ fontSize: size, color, lineHeight }}>
              {raw}
            </Text>
          )
        }

        const nodes = lineToNodes(line, { size, color, lineHeight })
        // 解析失败（含不支持的语法）→ 回退源码
        if (!nodes) {
          return (
            <Text key={li} className="block" style={{ fontSize: size, color, lineHeight }}>
              {raw}
            </Text>
          )
        }
        return <RichText key={li} nodes={nodes} />
      })}
    </View>
  )
}
