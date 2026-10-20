import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import type { PageTextSegment } from '@/services/api'

/**
 * #150 人工辅助错题整理：图片右侧的「OCR 文本栏」。
 *
 * 用户点「错题提取」后，系统先对整页跑 OCR（阅读序平铺）展示在本栏；
 * 用户点选/复制想要的内容，再到图片下方粘贴栏的题目文本框里「长按粘贴」。
 * 微信小程序读不到系统剪贴板，所以本栏只负责**写**剪贴板（Taro.setClipboardData），
 * 粘贴动作由用户在输入框长按完成——这是平台约束下的标准回路。
 *
 * 与 wrongq-text-panel（自动识别流程的「粘贴到题干/答案」）的区别：
 * 那个面向"机器已切好题、人工补文本"；本栏面向"机器只给全文、人工自己挑"。
 */

interface Props {
  segments: PageTextSegment[]
  /** 页码提示（多图切换时标识当前页），如「第 1/3 页」 */
  pageLabel?: string
  /** 上传/OCR/导出进行中：禁操作 */
  busy?: boolean
  /** 识别失败原因（服务不可用等）；有值时空态显示错误而非引导文案 */
  error?: string
  /**
   * 「存入题目」直通：勾选片段后一键写入指定题（父组件弹出题目选择器）。
   * 与「复制」并存——复制仍保留给想手动调整的用户。
   */
  onPasteToEntry?: (text: string) => void
}

export default function WrongqOcrPanel({ segments, pageLabel, busy, error, onPasteToEntry }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState(true)
  const n = selected.size

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  /** 单段复制：写系统剪贴板（小程序会自动 toast「内容已复制」） */
  const copyOne = (text: string) => {
    const t = (text || '').trim()
    if (!t) return
    Taro.setClipboardData({ data: t })
  }

  /** 多选复制：按阅读序拼接，空行分隔 */
  const copySelected = () => {
    const text = segments
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => selected.has(i))
      .map(({ s }) => s.text.trim())
      .filter(Boolean)
      .join('\n')
    if (!text) return
    Taro.setClipboardData({ data: text })
  }

  return (
    <View className="flex flex-col h-full" style={{ backgroundColor: '#fff' }}>
      {/* 头部：标题 + 页码 + 段数 + 展开/收起 */}
      <View className="flex flex-row items-center justify-between px-2 py-2" style={{ borderBottomWidth: 0.5, borderBottomColor: '#f0ece4', borderBottomStyle: 'solid' }}>
        <View className="flex flex-row items-center gap-1" style={{ flex: 1, minWidth: 0 }}>
          <Text className="block text-xs font-semibold text-foreground">OCR 文本</Text>
          {pageLabel ? <Text className="block text-[10px] text-muted-foreground">{pageLabel}</Text> : null}
          <Text className="block text-[10px] text-muted-foreground">{segments.length} 段</Text>
        </View>
        {/* ⚠️ 交互元素一律用 View 不用 Text：Taro 4.1.9 的 removeEventListener
            在 Text 解绑最后一个事件时会读 componentsAlias['pure-text']._num
            （映射表缺该键）直接崩（#16641，app.tsx 已挂兜底补丁）。
            View 的 pure-view/static-view 别名编译期就存在，安全。 */}
        <View className="block text-[10px] text-muted-foreground shrink-0" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </View>
      </View>

      {expanded ? (
        <>
          <Text className="block text-[10px] text-muted-foreground px-2 py-1">
            点「复制」后，到下方题目文本框长按粘贴
          </Text>

          {/* 片段列表（阅读序，内部滚动） */}
          <ScrollView scrollY style={{ flex: 1, minHeight: 0 }} scrollWithAnimation>
            {segments.length === 0 ? (
              <View className="px-2 py-6 items-center">
                <Text className="block text-[10px] text-muted-foreground text-center">
                  {busy
                    ? 'OCR 识别中…'
                    : error
                      ? error
                      : '尚未识别 · 点下方「快速/精准」开始，也可直接手动输入'}
                </Text>
                {error && !busy ? (
                  <Text className="block text-[10px] mt-2 text-center" style={{ color: '#BE3E2D' }}>
                    修复后重试，或改用另一种识别模式
                  </Text>
                ) : null}
              </View>
            ) : (
              segments.map((seg, i) => {
                const on = selected.has(i)
                return (
                  <View
                    key={i}
                    className="flex flex-row items-start gap-1 px-2 py-2"
                    style={{ borderBottomWidth: i < segments.length - 1 ? 0.5 : 0, borderBottomColor: '#f6f2ea', borderBottomStyle: 'solid' }}
                  >
                    {/* 勾选框 */}
                    <View
                      style={{
                        width: 14, height: 14, borderRadius: 3, marginTop: 2, flexShrink: 0,
                        borderWidth: 1.5, borderStyle: 'solid',
                        borderColor: on ? '#BE3E2D' : '#C9C2B8',
                        backgroundColor: on ? '#BE3E2D' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      onClick={() => toggle(i)}
                    >
                      {on ? <Text style={{ fontSize: 9, lineHeight: '12px', color: '#fff' }}>✓</Text> : null}
                    </View>
                    {/* 文本（View 承载点击：见文件顶部说明） */}
                    <View
                      className="block text-[11px] text-foreground"
                      style={{ flex: 1, lineHeight: '16px' }}
                      onClick={() => toggle(i)}
                    >
                      {seg.text}
                    </View>
                    {/* 单段复制 */}
                    <View
                      className="block text-[10px] shrink-0"
                      style={{ color: '#BE3E2D', marginTop: 2 }}
                      onClick={() => copyOne(seg.text)}
                    >
                      复制
                    </View>
                  </View>
                )
              })
            )}
          </ScrollView>

          {/* 操作条：全选 / 清空 / 存入题目 / 复制所选（交互元素均为 View，见顶部说明） */}
          <View className="flex flex-row items-center gap-2 px-2 py-2" style={{ borderTopWidth: 0.5, borderTopColor: '#f0ece4', borderTopStyle: 'solid' }}>
            <View className="block text-[10px] text-muted-foreground" onClick={() => setSelected(new Set(segments.map((_, i) => i)))}>
              全选
            </View>
            <View className="block text-[10px] text-muted-foreground" onClick={() => setSelected(new Set())}>
              清空
            </View>
            <View style={{ flex: 1 }} />
            {n > 0 && onPasteToEntry ? (
              <View
                className="block text-[10px] mr-2"
                style={{ color: '#BE3E2D', fontWeight: '500' }}
                onClick={() => {
                  const text = segments
                    .map((s, i) => ({ s, i }))
                    .filter(({ i }) => selected.has(i))
                    .map(({ s }) => s.text.trim())
                    .filter(Boolean)
                    .join('\n')
                  if (text) onPasteToEntry(text)
                }}
              >
                存入题目（{n}）
              </View>
            ) : null}
            {n > 0 ? (
              <View className="block text-[10px]" style={{ color: '#BE3E2D' }} onClick={copySelected}>
                复制所选（{n}）
              </View>
            ) : (
              <View className="block text-[10px] text-muted-foreground">已选 0 段</View>
            )}
          </View>
        </>
      ) : null}
    </View>
  )
}
