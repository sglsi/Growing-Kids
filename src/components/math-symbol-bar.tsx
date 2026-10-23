import { View, Text, ScrollView } from '@tarojs/components'
import { useState } from 'react'

/**
 * 数学符号快捷输入栏（思傅 2026-10-22：答案/解题过程对数学支持不友好，
 * 要能方便输入特殊符号）。
 *
 * 设计：
 *  - 三组：常用符号 / 希腊字母 / 公式模板；
 *  - 点击即插入到输入框光标处（Taro Textarea 的 cursor 属性控制光标）；
 *  - 公式模板插入的是**可读形式**（思傅 2026-10-23：编辑界面不能出现
 *    \frac 这类源码，用户只编辑认识的符号）：`√|`、`^(|)`、`_(|)`、`/`、
 *    `C(|, )`，保存时会由 readableToLatex 转成标准 LaTeX 入库；
 *  - 模板里的 `|` 是「插入后光标停留位」标记，如 `√|` 插入成 `√` 且光标
 *    落在根号后面，直接接着填被开方式；
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
      '√|', '^(|)', '_(|)', '/', 'C(|, )', '∑|', '∫|',
    ],
  },
]

interface Props {
  /** 插入一段文本（调用方负责写回 value 与光标） */
  onInsert: (snippet: string) => void
  /** 传入则显示「编辑 / 完成」开关（预览态点它进入编辑，编辑态点它保存回预览） */
  preview?: boolean
  onTogglePreview?: () => void
}

export default function MathSymbolBar({ onInsert, preview, onTogglePreview }: Props) {
  const [open, setOpen] = useState(false)

  const chip = 'flex-shrink-0 px-2.5 h-8 rounded-lg border border-border bg-white flex items-center justify-center'

  return (
    <View className="mb-2">
      <View className="flex flex-row items-center justify-between">
        <Text className="flex-1 block text-xs text-muted-foreground">
          数学符号不会打？点开下面面板插入
        </Text>

        {/* 编辑 / 完成：预览态点「编辑」改内容，编辑态点「完成」保存回渲染态（思傅 2026-10-23） */}
        {onTogglePreview ? (
          <View
            className="flex flex-row items-center px-2.5 h-8 rounded-lg mr-1.5"
            style={{ backgroundColor: preview ? '#BE3E2D' : 'rgba(190,62,45,0.08)' }}
            onClick={onTogglePreview}
          >
            <Text className="block text-xs" style={{ color: preview ? '#fff' : '#BE3E2D' }}>
              {preview ? '编辑' : '完成'}
            </Text>
          </View>
        ) : null}

        <View
          className="flex flex-row items-center gap-1 px-2.5 h-8 rounded-lg"
          style={{ backgroundColor: open ? '#BE3E2D' : 'rgba(190,62,45,0.08)' }}
          onClick={() => setOpen((v) => !v)}
        >
          <Text className="block text-xs" style={{ color: open ? '#fff' : '#BE3E2D' }}>
            {open ? '收起符号面板' : 'Ω 数学符号'}
          </Text>
        </View>
      </View>

      {open && (
        <View className="mt-2 rounded-xl border border-border bg-muted/40 p-2">
          {GROUPS.map((g) => (
            <View key={g.label} className="mb-2">
              <Text className="block text-[11px] text-muted-foreground mb-1">{g.label}</Text>
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
