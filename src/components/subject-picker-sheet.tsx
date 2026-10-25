import { View, Text, ScrollView } from '@tarojs/components'
import { Check } from 'lucide-react-taro'
import type { Subject } from '@/types'
import { getSubjectColor } from '@/types'
import { BRAND_TEXT } from '@/lib/theme'

interface Props {
  visible: boolean
  subjects: Subject[]
  /** 当前归属学科 id；null = 未分类 */
  currentId: string | null
  onCancel: () => void
  onSelect: (subjectId: string | null) => void | Promise<void>
}

/**
 * 归属学科选择弹层（思傅 2026-10-25 修「点击无反应」）
 *
 * 背景：旧实现先在 ⋮ 菜单的一级 Taro.showActionSheet 回调里**紧接着调第二个
 * showActionSheet**——开发工具里两级都正常，真机上二级 sheet 会被微信吞掉
 * （一级还没退场就发下一轮），表现为「点归属学科毫无反应」。
 * 改为页内自定义底部弹层（与 MaterialPicker 同模式：遮罩 + rounded-t-2xl +
 * zIndex 200 + stopPropagation），不依赖原生 sheet 链，且能高亮当前项。
 *
 * ⚠️ Taro 红线：交互元素用 View（Text 不绑 onClick）；图标 color 用 theme.ts
 * 的 BRAND 常量（SVG 属性不吃 CSS var()）。
 */
export default function SubjectPickerSheet({
  visible, subjects, currentId, onCancel, onSelect,
}: Props) {
  if (!visible) return null

  const rowClass = (active: boolean) =>
    `flex flex-row items-center gap-3 rounded-xl border px-3 py-3 mb-2 ${active ? 'border-brand-line bg-brand-soft' : 'border-border'}`

  return (
    <View
      className="fixed inset-0 flex items-end justify-center"
      style={{ zIndex: 200, backgroundColor: 'rgba(40,36,30,0.45)' }}
      onClick={onCancel}
    >
      <View
        className="w-full rounded-t-2xl bg-background"
        style={{ maxHeight: '70%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="flex flex-row items-center justify-between px-4 py-3 border-b border-border">
          <Text className="block text-sm font-semibold text-foreground">归属学科</Text>
          <Text className="block text-sm text-muted-foreground" onClick={onCancel}>取消</Text>
        </View>

        <ScrollView scrollY style={{ maxHeight: '55vh' }}>
          <View className="p-3">
            {/* 未分类置顶：当前无学科时高亮 */}
            <View className={rowClass(!currentId)} onClick={() => onSelect(null)}>
              <View className="w-2 h-2 rounded-full bg-muted-foreground" />
              <Text className={`block flex-1 text-sm ${currentId ? 'text-foreground' : 'text-brand-text font-medium'}`}>未分类</Text>
              {!currentId ? <Check size={16} color={BRAND_TEXT} /> : null}
            </View>

            {subjects.map((s) => {
              const c = getSubjectColor(s.color)
              const active = s.id === currentId
              return (
                <View key={s.id} className={rowClass(active)} onClick={() => onSelect(s.id)}>
                  <View className={`w-2 h-2 rounded-full ${c.dot}`} />
                  <Text className={`block flex-1 text-sm ${active ? 'text-brand-text font-medium' : 'text-foreground'}`}>{s.name}</Text>
                  {active ? <Check size={16} color={BRAND_TEXT} /> : null}
                </View>
              )
            })}

            {!subjects.length ? (
              <Text className="block text-xs text-muted-foreground text-center py-4">
                还没有学科，可先设为「未分类」；到「学科」页可创建
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </View>
  )
}
