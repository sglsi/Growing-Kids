import { View, Text, Input } from '@tarojs/components'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * 重命名弹层（思傅 2026-10-24：资料库 / 导出文档改名）
 *
 * ⚠️ Taro 4.1.9 红线：
 *  - Text 不绑 onClick —— 交互元素一律 View；
 *  - 字号下限 12px；
 *  - 本组件由父组件**条件渲染**（{target && <RenameDialog …/>}），
 *    useState 在挂载时取 initialValue，避免 visible 切换时不同步。
 */
export interface RenameDialogProps {
  title: string
  initialValue: string
  maxLength?: number
  onCancel: () => void
  onConfirm: (value: string) => void | Promise<void>
}

export default function RenameDialog({
  title, initialValue, maxLength = 100, onCancel, onConfirm,
}: RenameDialogProps) {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialValue && !busy

  const handleConfirm = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      await onConfirm(trimmed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)', padding: '0 32px',
      }}
      onClick={onCancel}
    >
      <View
        className="bg-card rounded-2xl p-5 w-full"
        onClick={(e) => { e.stopPropagation?.() }}
      >
        <Text className="block text-base font-semibold text-foreground mb-3">{title}</Text>
        <View className="rounded-xl border border-border bg-background px-3 h-11 justify-center mb-1">
          <Input
            className="w-full text-sm text-foreground"
            value={value}
            focus
            maxlength={maxLength}
            placeholder="输入新名称"
            placeholderClass="text-muted-foreground"
            onInput={(e) => setValue(e.detail.value)}
            onConfirm={() => { if (canSave) handleConfirm() }}
          />
        </View>
        <Text className="block text-xs text-muted-foreground mb-4">最多 {maxLength} 个字符</Text>
        <View className="flex flex-row gap-3">
          <View className="flex-1">
            <Button variant="outline" className="w-full h-10 rounded-xl" disabled={busy} onClick={onCancel}>
              <Text className="block text-sm">取消</Text>
            </Button>
          </View>
          <View className="flex-1">
            <Button className="w-full h-10 rounded-xl" disabled={!canSave} onClick={handleConfirm}>
              <Text className="block text-sm text-brand-foreground">保存</Text>
            </Button>
          </View>
        </View>
      </View>
    </View>
  )
}
