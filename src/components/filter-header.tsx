import { useState } from 'react'
import { View, Text, ScrollView, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Card } from '@/components/ui/card'
import { getSubjectColor } from '@/types'
import type { Subject } from '@/types'

interface Props {
  subjects: Subject[]
  activeSubject: string
  onSubjectChange: (id: string) => void
  keyword: string
  onKeywordChange: (kw: string) => void
  /** 回车/点搜索图标时触发（用于真正发起查询） */
  onSearch?: () => void
  /** 顶部左侧计数文案，如「共 32 条」 */
  countText?: string
  /** 右上角操作区（批量选择 / 已选 n / 取消） */
  right?: React.ReactNode
  placeholder?: string
  /** 附加筛选行（如标签），渲染在搜索框下方 */
  children?: React.ReactNode
}

/**
 * 复习本 / 最近题目的共用筛选头部：
 * 学科 pill 横向滚动 + 关键词搜索 + 自定义操作区
 */
export default function FilterHeader({
  subjects, activeSubject, onSubjectChange, keyword, onKeywordChange, onSearch,
  countText, right, placeholder = '搜索题目 / 答案关键词', children,
}: Props) {
  return (
    <>
      <ScrollView scrollX className="whitespace-nowrap pt-3" enhanced showScrollbar={false}>
        <View className="flex flex-row px-4 gap-2">
          <SubjectPill active={activeSubject === ''} label="全部" onClick={() => onSubjectChange('')} />
          {subjects.map((s) => (
            <SubjectPill
              key={s.id}
              active={activeSubject === s.id}
              label={s.name}
              color={getSubjectColor(s.color).dot}
              onClick={() => onSubjectChange(s.id)}
            />
          ))}
        </View>
      </ScrollView>

      <View className="px-4 pt-2">
        <View className="flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9">
          <Text className="block text-xs text-muted-foreground" onClick={() => onSearch?.()}>🔍</Text>
          <Input
            className="flex-1 text-sm bg-transparent"
            value={keyword}
            placeholder={placeholder}
            placeholderClass="text-muted-foreground"
            confirmType="search"
            onInput={(e) => onKeywordChange(e.detail.value)}
            onConfirm={() => onSearch?.()}
          />
          {keyword ? (
            <Text
              className="block text-xs text-muted-foreground"
              onClick={() => { onKeywordChange(''); onSearch?.() }}
            >
              清空
            </Text>
          ) : null}
        </View>
      </View>

      {children ? <View className="px-4 pt-2">{children}</View> : null}

      <View className="flex flex-row items-center justify-between px-4 pt-2 pb-3">
        <Text className="block text-sm text-muted-foreground">{countText || ''}</Text>
        {right}
      </View>
    </>
  )
}

export function SubjectPill({ active, label, color, onClick }: { active: boolean; label: string; color?: string; onClick: () => void }) {
  return (
    <View
      className={`flex flex-row items-center gap-2 rounded-full px-4 py-2 border ${
        active ? 'bg-primary border-primary' : 'bg-background border-border'
      }`}
      onClick={onClick}
    >
      {color && !active && <View className={`w-2 h-2 rounded-full ${color}`} />}
      <Text className={`block text-sm whitespace-nowrap ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{label}</Text>
    </View>
  )
}

/** 标签筛选行 */
export function TagFilterBar({ tags, active, onChange }: { tags: string[]; active: string; onChange: (t: string) => void }) {
  if (!tags.length) return null
  return (
    <ScrollView scrollX className="whitespace-nowrap" enhanced showScrollbar={false}>
      <View className="flex flex-row gap-2">
        <View
          className={`rounded-full border px-3 py-1 ${active === '' ? 'bg-primary border-primary' : 'bg-background border-border'}`}
          onClick={() => onChange('')}
        >
          <Text className={`block text-xs ${active === '' ? 'text-primary-foreground' : 'text-muted-foreground'}`}>全部标签</Text>
        </View>
        {tags.map((t) => (
          <View
            key={t}
            className={`rounded-full border px-3 py-1 ${active === t ? 'bg-primary border-primary' : 'bg-background border-border'}`}
            onClick={() => onChange(t)}
          >
            <Text className={`block text-xs ${active === t ? 'text-primary-foreground' : 'text-muted-foreground'}`}>#{t}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

/** 空状态卡 */
export function EmptyCard({ title, hint, actionLabel, onAction }: { title: string; hint?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <Card className="rounded-2xl border-border p-8 flex flex-col items-center mt-6">
      <Text className="block text-sm text-muted-foreground text-center">{title}</Text>
      {hint ? <Text className="block text-xs text-muted-foreground text-center mt-2">{hint}</Text> : null}
      {actionLabel && onAction ? (
        <View className="rounded-lg bg-primary px-4 py-2 mt-4" onClick={onAction}>
          <Text className="block text-xs text-primary-foreground">{actionLabel}</Text>
        </View>
      ) : null}
    </Card>
  )
}

/** 底部操作条 */
export function BottomActionBar({ children }: { children?: React.ReactNode }) {
  return (
    <View style={{
      position: 'fixed', bottom: 50, left: 0, right: 0,
      display: 'flex', flexDirection: 'row', gap: '12px',
      padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
    }}
    >
      {children}
    </View>
  )
}

/** 圆形操作按钮（合成PDF / 删除 / 加入复习本） */
export function ActionBtn({ icon, label, danger, primary, disabled, onClick }: {
  icon: React.ReactNode; label: string; danger?: boolean; primary?: boolean; disabled?: boolean; onClick: () => void
}) {
  const bg = danger ? 'bg-red-600' : primary ? 'bg-primary' : 'bg-primary'
  return (
    <View
      className={`flex flex-row items-center justify-center gap-2 h-11 rounded-xl ${disabled ? 'opacity-50' : ''} ${bg}`}
      onClick={() => { if (!disabled) onClick() }}
    >
      {icon}
      <Text className="block text-sm text-primary-foreground">{label}</Text>
    </View>
  )
}

/** 图片预览（缩放 + 调起原生预览） */
export function ImagePreviewOverlay({ url, title, onClose }: { url: string; title?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  const change = (d: number) => setZoom((z) => Math.min(4, Math.max(0.5, Math.round((z + d) * 100) / 100)))
  return (
    <View className="fixed inset-0 z-50 flex flex-col bg-background" onClick={onClose}>
      <View className="flex flex-col h-full" onClick={(e) => e.stopPropagation()}>
        <View className="flex flex-row items-center justify-between px-4 py-3 border-b border-border">
          <Text className="block text-sm font-semibold text-foreground flex-1 pr-2 truncate">{title || '图片'}</Text>
          <Text className="block text-sm text-muted-foreground" onClick={onClose}>关闭</Text>
        </View>
        <View className="flex flex-row items-center justify-center gap-5 px-4 py-2 border-b border-border">
          <View className="w-8 h-8 rounded-full border border-border flex items-center justify-center" onClick={() => change(-0.25)}>
            <Text className="block text-lg leading-none">−</Text>
          </View>
          <Text className="block text-sm w-16 text-center" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Text>
          <View className="w-8 h-8 rounded-full border border-border flex items-center justify-center" onClick={() => change(0.25)}>
            <Text className="block text-lg leading-none">+</Text>
          </View>
        </View>
        <ScrollView scrollY scrollX className="flex-1" enhanced>
          <View className="flex items-center justify-center" style={{ minHeight: '70vh' }}>
            <img
              src={url}
              style={{ width: `${zoom * 100}%`, transition: 'width .15s' }}
              onClick={() => Taro.previewImage({ current: url, urls: [url] })}
            />
          </View>
        </ScrollView>
      </View>
    </View>
  )
}
