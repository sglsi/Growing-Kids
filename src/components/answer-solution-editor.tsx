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
   * 光标位置回调（聚焦时给一次）。
   *
   * 为什么需要（思傅 2026-10-29「符号插到上一次编辑的位置」）：
   * 用户**用手指点**到句子中间换位置时没有任何输入事件 ⇒ useCaret 记的还是
   * 上一次打字的位置，点符号就插错地方。focus 事件的 detail 里带 cursor，补上即可。
   */
  onCaret?: (cursor?: number) => void
  /**
   * 真实失焦（参数是离开时的光标位置）：页面的 useCaret.blur(cursor) 会记录它、
   * 并把它写进 cursor 属性（重新聚焦才落在用户离开处），同时让受控 focus 落下，
   * 否则用户收不起键盘。
   */
  onBlurCaret?: (cursor?: number) => void
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
          className="border-0 ring-0 focus-within:ring-0 rounded-xl"
          // autoHeight：答案/解题过程动辄几十行，固定 128px 高度意味着长按选一段文字时
          // 要靠在原生组件内部滚动，选择手柄和文字对不上（思傅 2026-10-31「选择很不方便」）。
          // 改成随内容长高、滚动交给外层页面，手感与微信聊天输入框一致。
          autoHeight
          style={{ minHeight: 128 }}
          value={value}
          placeholder="先写答案，另起一行写「解析：」再写解题过程（长度不限，1/2、√3、x² 等写法都认）"
          maxlength={-1}
          cursor={cursor}
          focus={focus}
          onInput={(e) => onInput(e.detail.value, e.detail.cursor)}
          // 失焦：把离开时的真实光标交给页面（useCaret.blur 会记下它并写进 cursor 属性，
          // 重新聚焦才落在用户离开处）；聚焦只补记位置（手指点选换位没有输入事件）
          onBlur={(e) => {
            onBlurCaret?.((e.detail as { cursor?: number } | undefined)?.cursor)
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
