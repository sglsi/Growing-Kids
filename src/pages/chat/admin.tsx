import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { EmptyCard } from '@/components/filter-header'
import {
  fetchKnowledgeList,
  createKnowledgeArticle,
  updateKnowledgeArticle,
  deleteKnowledgeArticle,
  type KnowledgeArticle,
} from '@/services/api'

interface FormState {
  id?: string
  title: string
  content: string
  category: string
  tagsText: string
  is_active: boolean
  sort_order: number
}

const EMPTY_FORM: FormState = {
  title: '',
  content: '',
  category: '',
  tagsText: '',
  is_active: true,
  sort_order: 99,
}

/**
 * 知识库管理（无管理员权限校验，仅按 UI 区分入口）
 *  - 列表：每条 Card 显示标题、分类、内容摘要、标签、启用状态
 *  - 新增 / 编辑：Dialog 表单（标题、内容、分类、排序、标签、启用）
 *  - 启用/停用：Switch 即时切换（乐观更新 + 失败回滚）
 *  - 删除：弹确认
 */
export default function ChatAdminPage() {
  const [list, setList] = useState<KnowledgeArticle[]>([])
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await fetchKnowledgeList()
      setList(data || [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    load()
  })

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (a: KnowledgeArticle) => {
    setForm({
      id: a.id,
      title: a.title,
      content: a.content,
      category: a.category || '',
      tagsText: (a.tags || []).join(','),
      is_active: a.is_active,
      sort_order: a.sort_order,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    const title = form.title.trim()
    const content = form.content.trim()
    if (!title || !content) {
      Taro.showToast({ title: '标题和内容不能为空', icon: 'none' })
      return
    }
    const tags = form.tagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const payload = {
      title,
      content,
      category: form.category.trim() || undefined,
      tags,
      is_active: form.is_active,
      sort_order: Number(form.sort_order) || 99,
    }
    setBusy(true)
    try {
      if (form.id) {
        await updateKnowledgeArticle(form.id, payload)
        Taro.showToast({ title: '已更新', icon: 'success' })
      } else {
        await createKnowledgeArticle(payload)
        Taro.showToast({ title: '已新增', icon: 'success' })
      }
      setDialogOpen(false)
      load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败'
      Taro.showToast({ title: msg, icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = (a: KnowledgeArticle) => {
    Taro.showModal({
      title: '删除确认',
      content: `确定删除「${a.title}」？删除后客服将无法基于该条知识回答。`,
      success: async (r) => {
        if (!r.confirm) return
        try {
          await deleteKnowledgeArticle(a.id)
          Taro.showToast({ title: '已删除', icon: 'success' })
          load()
        } catch (e) {
          const msg = e instanceof Error ? e.message : '删除失败'
          Taro.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  }

  const handleToggleActive = async (a: KnowledgeArticle, val: boolean) => {
    setList((prev) =>
      prev.map((x) => (x.id === a.id ? { ...x, is_active: val } : x)),
    )
    try {
      await updateKnowledgeArticle(a.id, { is_active: val })
    } catch (e) {
      setList((prev) =>
        prev.map((x) => (x.id === a.id ? { ...x, is_active: !val } : x)),
      )
      const msg = e instanceof Error ? e.message : '更新失败'
      Taro.showToast({ title: msg, icon: 'none' })
    }
  }

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 顶部：标题 + 新增按钮 */}
      <View
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          backgroundColor: '#fff',
          borderBottom: '1px solid #ecefe3',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Text className="block text-base font-semibold text-foreground flex-1">
          知识库管理
        </Text>
        <View
          onClick={openCreate}
          className="rounded-xl"
          style={{
            backgroundColor: '#BE3E2D',
            padding: '6px 12px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <Plus size={14} color="#fff" />
          <Text className="block text-xs" style={{ color: '#fff' }}>
            新增
          </Text>
        </View>
      </View>

      <ScrollView scrollY style={{ height: '100vh', paddingTop: 56 }}>
        <View className="px-4 pt-3 pb-6">
          <Text className="block text-xs text-muted-foreground mb-3">
            共 {list.length} 条知识；停用后客服将不再基于该条回答
          </Text>
          {loading ? (
            <Text className="block text-xs text-muted-foreground text-center py-8">
              加载中…
            </Text>
          ) : list.length === 0 ? (
            <EmptyCard title="还没有任何知识" hint="点击右上角「新增」开始创建" />
          ) : (
            <View className="space-y-2">
              {list.map((a) => (
                <Card key={a.id} className="rounded-2xl border-border p-3">
                  <View className="flex flex-row items-start gap-2 mb-2">
                    <Text className="block text-sm font-semibold text-foreground flex-1">
                      {a.title}
                    </Text>
                    <Text
                      className="block text-xs"
                      style={{ color: a.is_active ? '#6B8E6B' : '#9A948A' }}
                    >
                      {a.is_active ? '已启用' : '已停用'}
                    </Text>
                  </View>
                  {a.category ? (
                    <Text className="block text-xs text-muted-foreground mb-1">
                      分类：{a.category}
                    </Text>
                  ) : null}
                  <Text
                    className="block text-xs text-foreground mb-2"
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {a.content}
                  </Text>
                  {a.tags && a.tags.length ? (
                    <View className="flex flex-row flex-wrap gap-1 mb-2">
                      {a.tags.map((t) => (
                        <View
                          key={t}
                          className="rounded-full bg-muted px-2 py-1"
                        >
                          <Text className="block text-xs text-muted-foreground">
                            #{t}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <View
                    className="flex flex-row items-center gap-3 mt-2 pt-2 border-t border-border"
                  >
                    <View
                      onClick={() => openEdit(a)}
                      className="flex flex-row items-center gap-1"
                      style={{ padding: '4px 0' }}
                    >
                      <Pencil size={14} color="#5C5750" />
                      <Text className="block text-xs text-muted-foreground">
                        编辑
                      </Text>
                    </View>
                    <View
                      onClick={() => handleDelete(a)}
                      className="flex flex-row items-center gap-1"
                      style={{ padding: '4px 0' }}
                    >
                      <Trash2 size={14} color="#BE3E2D" />
                      <Text className="block text-xs" style={{ color: '#BE3E2D' }}>
                        删除
                      </Text>
                    </View>
                    <View className="flex-1" />
                    <Text className="block text-xs text-muted-foreground mr-2">
                      {a.is_active ? '启用' : '停用'}
                    </Text>
                    <Switch
                      checked={a.is_active}
                      onCheckedChange={(v) => handleToggleActive(a, v)}
                    />
                  </View>
                </Card>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* 编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? '编辑知识' : '新增知识'}</DialogTitle>
          </DialogHeader>
          <View className="space-y-3 py-2">
            <View>
              <Text className="block text-xs text-muted-foreground mb-1">标题</Text>
              <View className="border border-border rounded-xl px-3 py-2">
                <Input
                  className="w-full bg-transparent"
                  value={form.title}
                  placeholder="如：核心功能-智能识别"
                  onInput={(e) => setForm({ ...form, title: e.detail.value })}
                />
              </View>
            </View>
            <View>
              <Text className="block text-xs text-muted-foreground mb-1">内容</Text>
              <View className="border border-border rounded-xl px-3 py-2">
                <Textarea
                  value={form.content}
                  placeholder="客服将基于此内容回答用户"
                  maxlength={500}
                  onInput={(e) =>
                    setForm({
                      ...form,
                      content: (e.detail as { value: string }).value || '',
                    })
                  }
                />
              </View>
            </View>
            <View className="flex flex-row gap-2">
              <View className="flex-1">
                <Text className="block text-xs text-muted-foreground mb-1">分类</Text>
                <View className="border border-border rounded-xl px-3 py-2">
                  <Input
                    className="w-full bg-transparent"
                    value={form.category}
                    placeholder="如：功能说明"
                    onInput={(e) => setForm({ ...form, category: e.detail.value })}
                  />
                </View>
              </View>
              <View style={{ width: '100px' }}>
                <Text className="block text-xs text-muted-foreground mb-1">排序</Text>
                <View className="border border-border rounded-xl px-3 py-2">
                  <Input
                    className="w-full bg-transparent"
                    type="number"
                    value={String(form.sort_order)}
                    onInput={(e) =>
                      setForm({
                        ...form,
                        sort_order: Number(e.detail.value) || 99,
                      })
                    }
                  />
                </View>
              </View>
            </View>
            <View>
              <Text className="block text-xs text-muted-foreground mb-1">
                标签（逗号分隔）
              </Text>
              <View className="border border-border rounded-xl px-3 py-2">
                <Input
                  className="w-full bg-transparent"
                  value={form.tagsText}
                  placeholder="如：识别,智能"
                  onInput={(e) => setForm({ ...form, tagsText: e.detail.value })}
                />
              </View>
            </View>
            <View className="flex flex-row items-center gap-2">
              <Text className="block text-xs text-muted-foreground">启用</Text>
              <Switch
                checked={form.is_active}
                onCheckedChange={(v) => setForm({ ...form, is_active: v })}
              />
            </View>
          </View>
          <DialogFooter>
            <View className="flex flex-row gap-2 w-full">
              <View className="flex-1">
                <Button
                  variant="outline"
                  className="w-full h-10 rounded-xl"
                  onClick={() => setDialogOpen(false)}
                >
                  <Text className="block text-sm">取消</Text>
                </Button>
              </View>
              <View className="flex-1">
                <Button
                  className="w-full h-10 rounded-xl"
                  disabled={busy}
                  onClick={handleSave}
                >
                  <Text className="block text-sm text-primary-foreground">
                    {busy ? '保存中…' : '保存'}
                  </Text>
                </Button>
              </View>
            </View>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  )
}
