import { View, Text, ScrollView } from '@tarojs/components'
import { useState } from 'react'

/**
 * 数学符号快捷输入栏（思傅 2026-10-22：答案/解题过程对数学支持不友好，
 * 要能方便输入特殊符号）。
 *
 * 设计：
 *  - 三组：常用符号 / 希腊字母 / 公式模板（LaTeX 片段）；
 *  - 点击即插入到输入框光标处（Taro Textarea 的 cursor 属性控制光标）；
 *  - 公式模板里的 `|` 是「插入后光标停留位」标记，如 `\frac{|}{}` 插入成
 *    `\frac{}{}` 且光标落在第一个花括号里，直接接着填分子。
 *  - 默认收起只占一行按钮，点开后面板展开，避免常驻占地方。
 */

const GROUPS: { label: string; items: string[] }[] = [
  {
    label: '常用符号',
    items: [
      '√', '∛', '²', '³', 'ⁿ', '½', '⅓', '¼', '±', '×', '÷', '·',
      '≤', '≥', '≠', '≈', '≡', '∞', '°', '∠', '⊥', '∥', '△', '○',
      '∴', '∵', '∈', '∉', '∪', '∩', '∅', '←', '→', '↑', '↓', '⇒', '⇔',
      '①', '②', '③', '④', '★', '″', '′',
    ],
  },
  {
    label: '希腊字母',
    items: [
      'α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'ρ', 'σ', 'φ', 'ω',
      'Δ', 'Ω', 'Σ', 'Γ', 'Θ', 'Λ', 'Π', 'Φ', 'Ψ',
    ],
  },
  {
    label: '公式模板',
    items: [
      '\\frac{|}{}', '\\sqrt{|}', '^{|}', '_{|}',
      '\\angle ', '\\triangle ', '\\circ ', '\\overline{|}',
      '\\pm ', '\\leq ', '\\geq ', '\\approx ', '\\neq ',
      '\\times ', '\\div ', '\\cdot ',
      '\\sum ', '\\int ', '\\parallel ', '\\perp ',
      '\\therefore ', '\\because ',
    ],
  },
]

interface Props {
  /** 插入一段文本（调用方负责写回 value 与光标） */
  onInsert: (snippet: string) => void
  /** 传入则显示「公式预览 / 返回源码」开关（编辑态看源码、预览态看渲染结果） */
  preview?: boolean
  onTogglePreview?: () => void
}

export default function MathSymbolBar({ onInsert, preview, onTogglePreview }: Props) {
  const [open, setOpen] = useState(false)

  const chip = 'flex-shrink-0 px-2.5 h-8 rounded-lg border border-border bg-white flex items-center justify-center'

  return (
    <View className="mb-2">
      <View className="flex flex-row items-center justify-between">
        <Text className="flex-1 block text-[10px] text-muted-foreground">
          支持 LaTeX（如 $\frac{1}{2}$），不会打可用下面的符号面板
        </Text>

        {/* 公式预览：编辑时是源码，切到预览看渲染后的数学式（思傅 2026-10-22） */}
        {onTogglePreview ? (
          <View
            className="flex flex-row items-center px-2 h-7 rounded-lg mr-1.5"
            style={{ backgroundColor: preview ? '#BE3E2D' : 'rgba(190,62,45,0.08)' }}
            onClick={onTogglePreview}
          >
            <Text className="block text-[11px]" style={{ color: preview ? '#fff' : '#BE3E2D' }}>
              {preview ? '返回源码' : '公式预览'}
            </Text>
          </View>
        ) : null}

        <View
          className="flex flex-row items-center gap-1 px-2 h-7 rounded-lg"
          style={{ backgroundColor: open ? '#BE3E2D' : 'rgba(190,62,45,0.08)' }}
          onClick={() => setOpen((v) => !v)}
        >
          <Text className="block text-[11px]" style={{ color: open ? '#fff' : '#BE3E2D' }}>
            {open ? '收起符号面板' : 'Ω 数学符号'}
          </Text>
        </View>
      </View>

      {open && (
        <View className="mt-2 rounded-xl border border-border bg-muted/40 p-2">
          {GROUPS.map((g) => (
            <View key={g.label} className="mb-2">
              <Text className="block text-[10px] text-muted-foreground mb-1">{g.label}</Text>
              <ScrollView scrollX className="w-full whitespace-nowrap">
                <View className="flex flex-row gap-1.5">
                  {g.items.map((s) => (
                    <View key={s} className={chip} onClick={() => onInsert(s)}>
                      <Text className="block text-xs text-foreground">{s.replace('|', '')}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
