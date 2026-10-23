import { View, Text, ScrollView } from '@tarojs/components'
import { useState } from 'react'

/**
 * 数学符号快捷输入栏（思傅 2026-10-22：答案/解题过程/题目栏对数学支持不友好，
 * 要能方便输入特殊符号）。
 *
 * 设计（2026-10-23 思傅要求重构）：
 *  - 四个可切换页签：常用符号 / 希腊字母 / 公式模板 / 常用序号，一次只看一组；
 *  - 点击即插入到输入框光标处（Taro Textarea 的 cursor 属性控制光标）；
 *  - 公式模板插入的是**可读形式**（编辑界面不能出现 \frac 这类源码，用户只
 *    编辑认识的符号）：分数 (|)/(|)、平均数 |(上划线)、绝对值 |(|)、幂 ^(|)、
 *     大括号 {|}，保存时由 readableToLatex 转成标准 LaTeX 入库；
 *  - 片段里的 `|` 是「插入后光标停留位」标记，如 `√|` 插入成 `√` 且光标
 *    落在根号后面，直接接着填被开方式；
 *  - 模板 chips 显示中文类型名（分数/平均数/绝对值…），插入的是可读片段，
 *    两者分离（label ≠ insert）；
 *  - 默认收起只占一行按钮，点开后面板展开，避免常驻占地方。
 */

interface Chip {
  /** chips 上显示的文字 */
  label: string
  /** 实际插入的文本（含 `|` 光标停留位标记） */
  insert: string
}

interface Group {
  label: string
  chips: Chip[]
  /** 序号页用多行网格（20 个横滑太长），符号页横滑省地方 */
  wrap?: boolean
}

const PAGES: Group[] = [
  {
    label: '常用符号',
    chips: [
      { label: '√', insert: '√' }, { label: '∛', insert: '∛' },
      { label: '²', insert: '²' }, { label: '³', insert: '³' }, { label: 'ⁿ', insert: 'ⁿ' },
      { label: '½', insert: '½' }, { label: '⅓', insert: '⅓' }, { label: '¼', insert: '¼' },
      { label: '±', insert: '±' }, { label: '×', insert: '×' }, { label: '÷', insert: '÷' }, { label: '·', insert: '·' },
      { label: '≤', insert: '≤' }, { label: '≥', insert: '≥' }, { label: '≠', insert: '≠' },
      { label: '≈', insert: '≈' }, { label: '≡', insert: '≡' }, { label: '∞', insert: '∞' },
      { label: '°', insert: '°' }, { label: '%', insert: '%' }, { label: '‰', insert: '‰' },
      // 几何（思傅 2026-10-23 补：全等/相似等）
      { label: '≌', insert: '≌' }, { label: '∽', insert: '∽' }, { label: '∼', insert: '∼' },
      { label: '∠', insert: '∠' }, { label: '∟', insert: '∟' }, { label: '⊥', insert: '⊥' },
      { label: '∥', insert: '∥' }, { label: '△', insert: '△' }, { label: '⊿', insert: '⊿' },
      { label: '○', insert: '○' }, { label: '⊙', insert: '⊙' }, { label: '⌒', insert: '⌒' },
      { label: '∿', insert: '∿' }, { label: '∝', insert: '∝' },
      { label: '∴', insert: '∴' }, { label: '∵', insert: '∵' },
      { label: '∈', insert: '∈' }, { label: '∉', insert: '∉' },
      { label: '∪', insert: '∪' }, { label: '∩', insert: '∩' }, { label: '∅', insert: '∅' },
      { label: '←', insert: '←' }, { label: '→', insert: '→' },
      { label: '↑', insert: '↑' }, { label: '↓', insert: '↓' },
      { label: '⇒', insert: '⇒' }, { label: '⇔', insert: '⇔' },
      { label: '★', insert: '★' }, { label: '″', insert: '″' }, { label: '′', insert: '′' },
    ],
  },
  {
    label: '希腊字母',
    chips: [
      // 小写 24 个全量
      ...['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ',
        'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω'].map((c) => ({ label: c, insert: c })),
      // 大写常用 9 个（与拉丁同形的 Α Β Ε Ζ Η Ι Ο Μ Ν Τ Υ 省略，避免混淆）
      ...['Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω'].map((c) => ({ label: c, insert: c })),
    ],
  },
  {
    label: '公式模板',
    chips: [
      { label: '分数', insert: '(|)/(|)' },
      { label: '平均数', insert: '|(上划线)' },
      { label: '绝对值', insert: '|(|)' },
      { label: '幂', insert: '^(|)' },
      { label: '根号', insert: '√|' },
      { label: '小括号', insert: '(|)' },
      { label: '中括号', insert: '[|]' },
      { label: '大括号', insert: '{|}' },
      { label: '组合数', insert: 'C(|, )' },
      { label: '求和', insert: '∑|' },
      { label: '积分', insert: '∫|' },
      { label: '下标', insert: '_(|)' },
      { label: '向量', insert: '→|' },
    ],
  },
  {
    label: '常用序号',
    wrap: true,
    chips: [
      ...['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'].map((c) => ({ label: c, insert: c })),
      ...['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ'].map((c) => ({ label: c, insert: c })),
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
  const [page, setPage] = useState(0)

  const chip = 'flex-shrink-0 px-2.5 h-8 rounded-lg border border-border bg-white flex items-center justify-center'
  const tab = 'flex-shrink-0 px-2.5 h-7 rounded-lg flex items-center justify-center'

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
          {/* 页签行：四个组一次只显示一组（思傅 2026-10-23） */}
          <ScrollView scrollX className="w-full whitespace-nowrap">
            <View className="flex flex-row gap-1.5 mb-2">
              {PAGES.map((g, i) => (
                <View
                  key={g.label}
                  className={tab}
                  style={{
                    backgroundColor: i === page ? '#BE3E2D' : '#fff',
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: i === page ? '#BE3E2D' : '#e5e0d8',
                  }}
                  onClick={() => setPage(i)}
                >
                  <Text className="block text-xs" style={{ color: i === page ? '#fff' : '#8a7f72' }}>
                    {g.label}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>

          {/* 当前页内容 */}
          {PAGES[page].wrap ? (
            <View className="flex flex-row flex-wrap gap-1.5">
              {PAGES[page].chips.map((c) => (
                <View
                  key={c.label}
                  className="px-2.5 h-8 rounded-lg border border-border bg-white flex items-center justify-center"
                  onClick={() => onInsert(c.insert)}
                >
                  <Text className="block text-xs text-foreground">{c.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <ScrollView scrollX className="w-full whitespace-nowrap">
              <View className="flex flex-row gap-1.5">
                {PAGES[page].chips.map((c) => (
                  <View key={c.label} className={chip} onClick={() => onInsert(c.insert)}>
                    <Text className="block text-xs text-foreground">{c.label}</Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  )
}
