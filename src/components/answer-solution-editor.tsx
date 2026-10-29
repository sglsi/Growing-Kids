import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import MathSymbolBar from '@/components/math-symbol-bar'
import MathText from '@/components/math-text'
import { readableToLatex } from '@/utils/latex'
import { BRAND_TEXT } from '@/lib/theme'

/**
 * 「答案 + 解题过程」合并编辑框（思傅 2026-10-26）
 *
 * 原来详情页是两个框：正确答案（AnswerEditor 内置）+ 详细解题过程，各有一套预览态与
 * 保存按钮。问题有两个：
 *   ① 内容真正躺在各自的组件 state 里，没点各自的「保存/完成」时点底部「保存修改」，
 *      写进库的是编辑前的旧值 —— 表现为「输入了但存不上」；
 *   ② 答案框没设 maxlength，微信 textarea 默认截断 140 字。
 * 现在合并成一个框，内容由页面统管（页面底部「保存修改」一次写 answer + solution），
 * 框本身不再持有副本，所见即所存；长度不限。
 *
 * 拆回两个字段的规则见 utils/answer-merge.ts（按「解析：」小标题切分）。
 *
 * ⚠️ 不要把它写成页面内部的函数组件：那样每次父组件渲染都会新建组件类型，
 *    React 会把 Textarea 整个卸载重建，光标/输入法状态全丢（本页正在治的就是光标问题）。
 */
interface Props {
  /** 合并后的可读文本（非 LaTeX） */
  value: string
  /** 一次性光标定位请求（-1 = 不指定），由页面的 useCaret 提供 */
  cursor: number
  /**
   * 受控聚焦（思傅 2026-10-29「插完符号就退出输入状态，不能连续输入」）。
   * 点符号 chip 会让原生 textarea 失焦、键盘收起；只给 cursor 不会把输入态还回来。
   * 页面插入后调 `useCaret.refocus()` 制造一次 false→true 边沿，这里只负责透传。
   */
  focus?: boolean
  /** 输入回调（第二个参数是原生事件给的光标位置，交给 useCaret.track） */
  onInput: (value: string, cursor?: number) => void
  /**
   * 光标位置回调（失焦 / 聚焦时都会给一次）。
   *
   * 为什么需要（思傅 2026-10-29「符号插到上一次编辑的位置」）：
   * 微信 textarea 只有 onInput 会带 `cursor`；用户**用手指点**到句子中间换位置
   * 没有任何输入事件 ⇒ useCaret 记的还是上一次打字的位置，点符号就插错地方。
   * 点符号 chip 会先让 textarea 失焦，而 blur 事件的 detail 里带真实 cursor，
   * 于是补上这一条链路即可让「插入位置 = 当前光标」。
   */
  onCaret?: (cursor?: number) => void
  /** 真实失焦：让页面的受控 focus 一起落下，否则用户收不起键盘 */
  onBlurCaret?: () => void
  /** 点数学符号/模板：页面负责按光标位置插入并回请求光标 */
  onInsert: (snippet: string) => void
}

export default function AnswerSolutionEditor({ value, cursor, focus, onInput, onCaret, onBlurCaret, onInsert }: Props) {
  // 预览是纯展示开关，放组件内部即可（不涉及入库）
  const [preview, setPreview] = useState(false)

  return (
    <View className="mt-4">
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="block text-sm font-semibold text-foreground">答案与解题过程</Text>
        <View className="block text-xs" style={{ color: BRAND_TEXT }} onClick={() => setPreview((v) => !v)}>
          {preview ? '收起预览' : '数学式预览'}
        </View>
      </View>

      <MathSymbolBar onInsert={onInsert} />

      <Card className="rounded-2xl border-border p-4 mb-2">
        <Textarea
          className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
          value={value}
          placeholder="先写答案，另起一行写「解析：」再写解题过程（长度不限，1/2、√3、x² 等写法都认）"
          maxlength={-1}
          cursor={cursor}
          focus={focus}
          onInput={(e) => onInput(e.detail.value, e.detail.cursor)}
          // 失焦/聚焦补记光标位置：手指点选位置不产生 input 事件，只靠 blur/focus 拿得到
          onBlur={(e) => {
            onCaret?.((e.detail as { cursor?: number } | undefined)?.cursor)
            onBlurCaret?.()
          }}
          onFocus={(e) => onCaret?.((e.detail as { cursor?: number } | undefined)?.cursor)}
        />
        <Text className="block text-xs text-muted-foreground mt-2">
          「解析：」之后的内容会单独存为解题过程，导出 Word/PDF 时分「正确答案」「解析」两段；不写这一行就整段当答案。
        </Text>
      </Card>

      {preview ? (
        <Card className="rounded-2xl border-border p-4 mb-2">
          {value.trim() ? (
            <MathText text={readableToLatex(value)} />
          ) : (
            <Text className="block text-sm text-muted-foreground">（暂无内容，写点什么再预览）</Text>
          )}
        </Card>
      ) : null}
    </View>
  )
}
