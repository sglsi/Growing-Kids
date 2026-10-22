import { View as TView, Text as TText } from '@tarojs/components'
import { X } from 'lucide-react-taro'
import AnswerEditor from '@/components/answer-editor'
import type { TimelineItem } from '@/types'

/**
 * 列表条目的「＋填答案」底部面板（思傅 2026-10-21）
 *
 * 为什么做成页内面板而不是跳详情页：列表是最高频场景，跳页会丢失滚动位置与
 * 筛选上下文（第九轮刚修过滚动锚定）。面板所有写入都按传入的 item.id 定位，
 * 答案内嵌在该题目记录里 —— **不可能存到别的题上**。
 */

interface Props {
  visible: boolean
  /** 目标题目；为 null 时不渲染 */
  item: TimelineItem | null
  onClose: () => void
  /** 保存成功后回调（用于就地刷新列表） */
  onSaved?: (item: TimelineItem) => void
}

export default function AnswerSheet({ visible, item, onClose, onSaved }: Props) {
  if (!visible || !item) return null

  return (
    <TView style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 400 }}>
      {/* 遮罩：点击关闭 */}
      <TView
        style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
      />
      <TView
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          maxHeight: '78%',
          backgroundColor: '#FBF8F2',
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: 16,
          overflow: 'scroll',
        }}
      >
        <TView className="flex flex-row items-center justify-between mb-3">
          <TText className="block text-sm font-semibold">填写答案</TText>
          <TView onClick={onClose}>
            <X size={18} color="#9A948A" />
          </TView>
        </TView>
        <AnswerEditor
          item={item}
          onSaved={(updated) => {
            onSaved?.(updated)
            onClose()
          }}
        />
      </TView>
    </TView>
  )
}
