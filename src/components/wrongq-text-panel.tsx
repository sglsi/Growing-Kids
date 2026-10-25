import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import type { PageTextSegment } from '@/services/api'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND } from '@/lib/theme'

/**
 * P3（#131 / 设计文档 §4.8）：全页 OCR 文本面板（选择粘贴）。
 *
 * 侧车全页 regions 按阅读序（分栏 → 行序）平铺，点选片段后：
 *  - 粘贴到某题的题干 / 答案文本域（补全 OCR 漏识别或改判的题）；
 *  - 或进入「导出 Word」队列（仅导出所选片段）。
 * 与叠加改框编辑器（wrongq-box-editor）互为补充：改框修"圈错了"，
 * 本面板修"认错了"——两者都不动底层识别链路，只做人工补全。
 */

export interface TextPanelDraft {
  /** 草稿在 drafts 数组中的下标 */
  idx: number
  /** 展示名（题号标签 + 序号，如 "Ⅱ.选词填空。 9 · 第1题"） */
  label: string
}

interface Props {
  visible: boolean
  segments: PageTextSegment[]
  drafts: TextPanelDraft[]
  /** 粘贴/导出进行中：禁操作 */
  busy?: boolean
  /** 所选片段插入某题题干/答案（追加在末尾，空行分隔） */
  onPaste: (draftIdx: number, field: 'question' | 'answer', text: string) => void
  /** 仅导出所选片段（生成 Word 并打开） */
  onExportSelected: (text: string) => void
}

export default function WrongqTextPanel(props: Props) {
  const { visible, segments, drafts, busy } = props
  const [expanded, setExpanded] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  if (!visible || !segments.length) return null

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // 按阅读序拼接所选片段（index 即阅读序）
  const selectedText = () =>
    segments
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => selected.has(i))
      .map(({ s }) => s.text)
      .join('\n')

  const pickDraft = (field: 'question' | 'answer') => {
    if (busy || !selected.size) return
    if (!drafts.length) {
      Taro.showToast({ title: '暂无可插入的题目', icon: 'none' })
      return
    }
    const text = selectedText()
    Taro.showActionSheet({
      itemList: drafts.map((d) => d.label),
      success: (r) => {
        const d = drafts[r.tapIndex]
        if (d) props.onPaste(d.idx, field, text)
      },
    })
  }

  const exportSelected = () => {
    if (busy || !selected.size) return
    props.onExportSelected(selectedText())
  }

  const n = selected.size

  return (
    <View className="rounded-2xl border-border p-3 mb-3" style={{ backgroundColor: '#fff', border: '1px solid #ece8e0' }}>
      {/* 头部：标题 + 展开/收起 */}
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="block text-sm font-semibold text-foreground">
          全页 OCR 文本（{segments.length} 段）
        </Text>
        <Text className="block text-xs text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </Text>
      </View>
      <Text className="block text-xs text-muted-foreground mb-2">
        按阅读序平铺；点选片段可粘贴到某题题干/答案，或仅导出所选
      </Text>

      {expanded ? (
        <>
          {/* 片段列表（阅读序） */}
          <View style={{ maxHeight: 260 }}>
            {segments.map((seg, i) => {
              const on = selected.has(i)
              return (
                <View
                  key={i}
                  className="flex flex-row items-start gap-2 py-2"
                  style={{ borderBottomWidth: i < segments.length - 1 ? 0.5 : 0, borderBottomColor: '#f0ece4', borderBottomStyle: 'solid' }}
                  onClick={() => toggle(i)}
                >
                  {/* 勾选框 */}
                  <View
                    style={{
                      width: 16, height: 16, borderRadius: 3, marginTop: 2, flexShrink: 0,
                      borderWidth: 1.5, borderStyle: 'solid',
                      borderColor: on ? BRAND : '#C9C2B8',
                      backgroundColor: on ? BRAND : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {on ? <Text style={{ fontSize: 10, lineHeight: '14px', color: BRAND_FOREGROUND }}>✓</Text> : null}
                  </View>
                  <Text className="block text-xs text-foreground" style={{ flex: 1, lineHeight: '18px' }}>
                    {seg.text}
                  </Text>
                </View>
              )
            })}
          </View>

          {/* 操作条 */}
          <View className="flex flex-row items-center gap-2 mt-2">
            <Text
              className="block text-xs text-muted-foreground"
              onClick={() => setSelected(new Set(segments.map((_, i) => i)))}
            >
              全选
            </Text>
            <Text className="block text-xs text-muted-foreground" onClick={() => setSelected(new Set())}>
              清空
            </Text>
            <View style={{ flex: 1 }} />
            {n > 0 ? (
              <>
                <Text className="block text-xs" style={{ color: BRAND_TEXT }} onClick={() => pickDraft('question')}>
                  粘贴到题干
                </Text>
                <Text className="block text-xs" style={{ color: BRAND_TEXT }} onClick={() => pickDraft('answer')}>
                  粘贴到答案
                </Text>
                <Text className="block text-xs" style={{ color: BRAND_TEXT }} onClick={exportSelected}>
                  导出所选（{n}）
                </Text>
              </>
            ) : (
              <Text className="block text-xs text-muted-foreground">已选 0 段</Text>
            )}
          </View>
        </>
      ) : null}
    </View>
  )
}
