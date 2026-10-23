import { View, Text, ScrollView, Picker, Image } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  fetchTimelineDetail, fetchSubjects, updateQuestion, updateTimeline, exportDocument,
  addToReviewBook, removeFromReviewBook, deleteTimeline,
  fetchSimilar, markReviewed, uploadImage, ocrPage,
  type Subject, type TimelineItem,
} from '@/services/api'
import { cacheGet, cacheSet } from '@/services/cache'
import ImageEditor from '@/components/image-editor'
import AnswerEditor from '@/components/answer-editor'
import MathSymbolBar from '@/components/math-symbol-bar'
import MathText from '@/components/math-text'
import { latexToReadable, readableToLatex } from '@/utils/latex'
import { getSubjectColor, formatTime, formatDate, truncate, type SimilarItem, type ReviewPlan } from '@/types'
import { openStorageFile } from '@/services/net'

/** P2-18 艾宾浩斯间隔（与后端 timeline/review.ts 保持一致） */
const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30]
/** 前端现算复习计划（纯本地，避免跨端引后端模块） */
function computePlan(createdAt?: string, reviewCount = 0): ReviewPlan {
  const base = createdAt ? new Date(createdAt) : new Date()
  const total = EBBINGHAUS_INTERVALS.length
  const count = Math.max(0, Math.min(total, Math.floor(reviewCount) || 0))
  const schedule = EBBINGHAUS_INTERVALS.map((day, i) => {
    const d = new Date(base)
    d.setDate(d.getDate() + day)
    return { stage: i + 1, day, date: d.toISOString(), done: i < count }
  })
  const next = schedule.find((s) => !s.done)
  return {
    review_count: count,
    total_stages: total,
    completed: count >= total,
    next_review_at: next ? next.date : null,
    schedule,
  }
}

export default function DetailPage() {
  const router = useRouter()
  const id = router.params.id || ''
  const [item, setItem] = useState<TimelineItem | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectId, setSubjectId] = useState('')
  const [qContent, setQContent] = useState('')
  const [aContent, setAContent] = useState('')
  const [solution, setSolution] = useState('')
  const [saving, setSaving] = useState(false)
  const [mastered, setMastered] = useState(false)
  // P2-18 复习计划
  const [plan, setPlan] = useState<ReviewPlan | null>(null)
  const [reviewing, setReviewing] = useState(false)
  // P2-17 相似题
  const [similar, setSimilar] = useState<SimilarItem[]>([])
  const [similarOpen, setSimilarOpen] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)
  // 题面图操作（思傅 2026-10-21：详情页支持对图片做模式转换/裁剪/旋转/黑白/高清 + 文字识别）
  const [editorImg, setEditorImg] = useState('')           // 正在编辑的图片签名 URL
  const [editorBusy, setEditorBusy] = useState(false)      // 编辑结果上传/替换中
  const [ocrBusy, setOcrBusy] = useState(false)            // 图片文字识别中
  const [ocrResult, setOcrResult] = useState('')           // 识别出的文字（非空=展示结果面板）
  // 解题过程框光标（-1 = 未知，插入时退化为追加到末尾）；数学符号按光标位插入
  const [solutionCursor, setSolutionCursor] = useState(-1)
  // 解题过程两种模式（思傅 2026-10-23：源码用户看不懂也编辑不了，编辑界面不能出现 \frac 这类命令）：
  //   view = 渲染态，显示数学式（有内容时默认）
  //   edit = 编辑态，Textarea 里放的是**可读形式**（1/2、√3、x²、∠ABC、→a），
  //          「完成」时再转回 LaTeX。solution 始终是库里的 LaTeX（唯一真相）。
  const [solutionMode, setSolutionMode] = useState<'view' | 'edit'>('edit')
  const [solutionEditing, setSolutionEditing] = useState('')

  /** 把一条题目数据铺进页面 state（缓存首帧与网络刷新共用） */
  const applyItem = (it: TimelineItem) => {
    setItem(it)
    setSubjectId(it.subject_id || '')
    setQContent(it.content?.question || '')
    setAContent(it.content?.answer || '')
    setSolution(it.content?.solution || '')
    // 有解题过程就默认展示渲染后的数学式，空则留在编辑态方便直接输入
    const hasSol = !!(it.content?.solution || '').trim()
    setSolutionMode(hasSol ? 'view' : 'edit')
    setSolutionEditing(hasSol ? '' : '')
    setMastered(it.mastered)
    setPlan(computePlan(it.created_at, it.content?.review_count))
  }

  const load = async () => {
    // SWR（思傅 2026-10-21）：先同步读缓存铺首帧，再后台刷新。
    // 本页写操作（保存/改图/识别入库/复习本）都走 api.ts，成功后已失效 tl 域，
    // 因此这里的 load() 缓存必然已空，拿到的是最新数据。
    const itemKey = `tl:item:${id}`
    const cached = cacheGet<TimelineItem>(itemKey)
    if (cached) applyItem(cached)
    const cachedSubs = cacheGet<Subject[]>('subj:list')
    if (cachedSubs) setSubjects(cachedSubs)
    try {
      const [it, subs] = await Promise.all([fetchTimelineDetail(id), fetchSubjects()])
      applyItem(it)
      setSubjects(subs)
      cacheSet(itemKey, it)
      if (subs.length) cacheSet('subj:list', subs)
    } catch (e) {
      console.error('加载题目失败', e)
      if (!cached) Taro.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateQuestion(id, {
        subject_id: subjectId,
        question_content: qContent,
        answer_content: aContent,
        solution,
        status: aContent ? 'answered' : 'pending',
        mastered,
      })
      setItem(updated)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      console.error('保存失败', e)
      Taro.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  // 「联网搜答案」已由 AnswerEditor 接管（带来源标注 + 采纳才入库），
  // 旧的 handleSearch（直接填文本框、无来源标注）已移除，避免两套搜题入口。

  /**
   * 数学符号/模板插入解题过程框：`|` 为插入后光标停留位（模板用）。
   * 预览态点符号面板会自动进入编辑态（先把已有内容转成可读形式再插入）。
   */
  const insertSolutionSymbol = (snippet: string) => {
    const cur = solutionMode === 'edit' ? solutionEditing : latexToReadable(solution)
    const pos = solutionCursor >= 0 ? Math.min(solutionCursor, cur.length) : cur.length
    const marker = snippet.indexOf('|')
    const plain = snippet.replace('|', '')
    const next = cur.slice(0, pos) + plain + cur.slice(pos)
    setSolutionEditing(next)
    if (solutionMode !== 'edit') setSolutionMode('edit')
    setSolutionCursor(marker >= 0 ? pos + marker : pos + plain.length)
  }

  /** 进入编辑：把库存 LaTeX 转成用户认识的可读形式——绝不是给用户看源码 */
  const startSolutionEdit = () => {
    setSolutionEditing(latexToReadable(solution))
    setSolutionCursor(-1)
    setSolutionMode('edit')
  }

  /** 完成编辑：可读形式 → LaTeX（只改 state；入库由页面底部「保存修改」统一负责） */
  const finishSolutionEdit = () => {
    setSolution(readableToLatex(solutionEditing))
    setSolutionMode('view')
  }

  const handlePrint = async () => {
    try {
      const res = await exportDocument({ subject_id: subjectId || undefined })
      openStorageFile(res.url, false, res.file_key)
    } catch (e) {
      console.error('导出失败', e)
      Taro.showToast({ title: '导出失败', icon: 'none' })
    }
  }

  // ---------- 题面图操作（思傅 2026-10-21） ----------

  /** 「编辑」：打开 ImageEditor——裁剪 / 旋转 / 黑白灰度 / 智能高清 / 去手写全在里面 */
  const handleEditImage = (url: string) => setEditorImg(url)

  /**
   * 编辑完成：结果以 attach 上传（持久化、不建条目）→ 原位替换。
   *  - kind=image 条目：替换条目自身的 file_key（PUT /timeline/:id）
   *  - 题目条目：替换 content.question_images[index]（题面图）
   */
  const handleEditorConfirm = async (tempPath: string) => {
    if (!item || !editorImg) { setEditorImg(''); return }
    setEditorBusy(true)
    try {
      const up = await uploadImage(tempPath, { purpose: 'attach' })
      if (item.kind === 'image') {
        // ⚠️ thumb_key 必须同步换：列表卡片渲染 thumb_url || url，而 thumb_url 来自
        //    另一列 thumb_key。只换 file_key 会让列表/点开仍显示旧图（思傅 2026-10-21 反馈）。
        await updateTimeline(item.id, { file_key: up.key, thumb_key: up.thumb_key || null })
      } else {
        const urls = item.question_image_urls || []
        const keys = item.content?.question_images || []
        const idx = urls.indexOf(editorImg)
        if (idx < 0 || idx >= keys.length) throw new Error('未找到要替换的题面图')
        const nextKeys = keys.map((k, i) => (i === idx ? up.key : k))
        await updateQuestion(item.id, { question_images: nextKeys })
      }
      setEditorImg('')
      Taro.showToast({ title: '图片已更新', icon: 'success' })
      await load()
    } catch (e) {
      console.error('图片替换失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '替换失败，请重试', icon: 'none' })
    } finally {
      setEditorBusy(false)
    }
  }

  /** 「识别文字」：对该题面图跑快速 OCR（小图局部识别，快 1~3s），结果进面板供追加/替换题干 */
  const handleOcrImage = async (url: string) => {
    setOcrBusy(true)
    try {
      const r = await ocrPage(url, 'fast', { rectify: false })
      const text = (r.page_text || []).map((s) => s.text.trim()).filter(Boolean).join('\n')
      if (!text) {
        Taro.showToast({ title: '未识别到文字，可手动输入', icon: 'none' })
        return
      }
      setOcrResult(text)
    } catch (e) {
      console.error('图片识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setOcrBusy(false)
    }
  }

  /** 把识别结果写进题干：mode=append 追加 / replace 替换 */
  const applyOcrResult = (mode: 'append' | 'replace') => {
    const t = ocrResult.trim()
    if (!t) return
    setQContent((prev) => (mode === 'replace' ? t : prev.trim() ? `${prev.trim()}\n${t}` : t))
    setOcrResult('')
    Taro.showToast({ title: mode === 'replace' ? '已替换题干' : '已追加到题干', icon: 'success' })
  }

  // 加入 / 移出复习本
  const toggleReviewBook = async () => {
    if (!item) return
    try {
      if (item.in_review_book) {
        await removeFromReviewBook([item.id])
      } else {
        await addToReviewBook([item.id])
      }
      await load()
      Taro.showToast({ title: item.in_review_book ? '已移出复习本' : '已加入复习本', icon: 'success' })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    }
  }

  const handleDelete = async () => {
    const ok = await new Promise<boolean>((resolve) =>
      Taro.showModal({
        title: '确认删除',
        content: '删除后不可恢复，是否继续？',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!ok) return
    try {
      await deleteTimeline(id)
      Taro.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 700)
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  // P2-18 标记本次复习完成：更新计数并刷新复习计划
  const handleReview = async () => {
    if (!item) return
    setReviewing(true)
    try {
      const { review_count, plan: newPlan } = await markReviewed(item.id)
      setPlan(newPlan)
      setItem({ ...item, content: { ...item.content, review_count } })
      Taro.showToast({ title: '已记录本次复习', icon: 'success' })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setReviewing(false)
    }
  }

  // P2-17 展开相似题：按需拉取（基于用户自建错题历史）
  const toggleSimilar = async () => {
    const next = !similarOpen
    setSimilarOpen(next)
    if (next && !similar.length && item) {
      setSimilarLoading(true)
      try {
        const list = await fetchSimilar(item.id, 5)
        setSimilar(list)
      } catch (e) {
        console.error(e)
        Taro.showToast({ title: '相似题加载失败', icon: 'none' })
      } finally {
        setSimilarLoading(false)
      }
    }
  }

  const color = getSubjectColor(item?.subjects?.color)

  // 图片资料（kind=image）：只展示图片 + 归属学科，不做题目编辑
  if (item && item.kind === 'image') {
    return (
      <ScrollView scrollY className="h-full bg-background">
        <View className="px-4 pt-4 pb-32">
          <View className="flex flex-row items-center gap-2 mb-4">
            <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
              <View className={`w-2 h-2 rounded-full ${color.dot}`} />
              <Text className="block text-xs">{item.subjects?.name || '未分类'}</Text>
            </View>
            <Text className="block text-xs text-muted-foreground">{formatTime(item.created_at)}</Text>
          </View>

          <Card className="rounded-2xl border-border overflow-hidden mb-4">
            <Image
              src={item.url || ''}
              mode="widthFix"
              style={{ width: '100%' }}
              onClick={() => Taro.previewImage({ current: item.url || '', urls: [item.url || ''] })}
            />
          </Card>

          {/* 图片条目详情也要能编辑（思傅 2026-10-21 规则：点开图片可编辑）：
              编辑结果 attach 上传 → 原位替换该条目的 file_key（与首页一致，不新建条目）。 */}
          <View className="flex flex-row items-center justify-between mb-4">
            <Text className="block text-xs text-muted-foreground">点图看大图 ·「编辑」裁剪/旋转/黑白/高清</Text>
            <View
              className="px-3 rounded-lg"
              style={{ backgroundColor: 'rgba(190,62,45,0.08)', paddingTop: 6, paddingBottom: 6 }}
              onClick={() => handleEditImage(item.url || item.thumb_url || '')}
            >
              <Text className="block text-xs" style={{ color: '#BE3E2D' }}>编辑</Text>
            </View>
          </View>

          <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-4">
            <View className="flex-1">
              <Text className="block text-sm font-medium text-foreground">归属学科</Text>
              <Text className="block text-xs text-muted-foreground">用于归档与筛选</Text>
            </View>
            <Picker
              mode="selector"
              range={subjects}
              rangeKey="name"
              value={Math.max(0, subjects.findIndex((s) => s.id === subjectId))}
              onChange={async (e) => {
                const sid = subjects[Number(e.detail.value)]?.id || subjectId
                setSubjectId(sid)
                try {
                  await updateQuestion(id, { subject_id: sid })
                } catch (err) {
                  console.error(err)
                }
              }}
            >
              <View className="px-3 py-1 rounded-lg" style={{ backgroundColor: 'rgba(190,62,45,0.08)' }}>
                <Text className="block text-sm text-primary">
                  {subjects.find((s) => s.id === subjectId)?.name || '选择学科'}
                </Text>
              </View>
            </Picker>
          </View>

          <View className="flex flex-row gap-3">
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={toggleReviewBook}>
              <Text className="block text-sm">{item.in_review_book ? '移出复习本' : '加入复习本'}</Text>
            </Button>
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={handleDelete}>
              <Text className="block text-sm" style={{ color: '#BE3E2D' }}>删除</Text>
            </Button>
          </View>

          {/* 思傅 2026-10-22：图片类题目也要支持答案输入与联网搜题。
              图片条目此前的分支只展示图片+学科，答案区完全缺失——接入 AnswerEditor
              （文本/附件/裁剪/联网搜答案，写入按 item.id 落到本条目的 content）+
              详细解题过程。后端 update() 对 content 做局部合并、不校验 kind，
              答案/搜题直接可用。 */}
          <AnswerEditor
            item={item}
            onSaved={(updated) => {
              setItem(updated)
              setAContent(updated.content?.answer || '')
              setSolution(updated.content?.solution || '')
            }}
          />

          <View className="mt-4">
            <Text className="block text-xs text-muted-foreground mb-2">详细解题过程</Text>
            <MathSymbolBar
              onInsert={insertSolutionSymbol}
              preview={solutionMode === 'view'}
              onTogglePreview={() => { if (solutionMode === 'view') startSolutionEdit(); else finishSolutionEdit() }}
            />
          </View>
          <Card className="rounded-2xl border-border p-4 mb-2">
            {solutionMode === 'view' ? (
              solution.trim() ? (
                <MathText text={solution} />
              ) : (
                <Text className="block text-sm text-muted-foreground">（暂无解题过程，点「编辑」输入）</Text>
              )
            ) : (
              <Textarea
                className="min-h-28 border-0 ring-0 focus-within:ring-0 rounded-xl"
                value={solutionEditing}
                placeholder="可粘贴或输入详细解析（1/2、√3、x² 等写法即可）"
                maxlength={3000}
                cursor={solutionCursor}
                onInput={(e) => { setSolutionEditing(e.detail.value); setSolutionCursor(e.detail.cursor ?? -1) }}
              />
            )}
          </Card>
        </View>

        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
            <Text className="block text-sm">{saving ? '保存中…' : '保存修改'}</Text>
          </Button>
        </View>

        {/* ⭐ 思傅 2026-10-21 修：kind=image 分支此前早 return，没挂载 ImageEditor，
            「编辑」点了没反应。此处补挂载，点编辑/保存即替换该条目的 file_key。 */}
        <ImageEditor
          visible={!!editorImg}
          src={editorImg}
          enableSaveToInbox={false}
          confirmText="保存并替换原图"
          onCancel={() => setEditorImg('')}
          onConfirm={(p) => void handleEditorConfirm(p)}
        />
        {editorBusy ? (
          <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
        ) : null}
      </ScrollView>
    )
  }

  return (
    <>
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-32">
        {item && (
          <View className="flex flex-row items-center justify-between mb-4">
            <View className="flex flex-row items-center gap-2">
              <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
                <View className={`w-2 h-2 rounded-full ${color.dot}`} />
                <Text className="block text-xs">{item.subjects?.name || '未分类'}</Text>
              </View>
              <Picker
                mode="selector"
                range={subjects}
                rangeKey="name"
                value={Math.max(0, subjects.findIndex((s) => s.id === subjectId))}
                onChange={(e) => setSubjectId(subjects[Number(e.detail.value)]?.id || subjectId)}
              >
                <View className="px-3 py-1 rounded-full" style={{ backgroundColor: 'rgba(190,62,45,0.08)' }}>
                  <Text className="block text-xs text-primary">切换学科</Text>
                </View>
              </Picker>
            </View>
            <Text
              className="block text-xs text-primary"
              onClick={toggleReviewBook}
            >
              {item.in_review_book ? '★ 已加入复习本' : '☆ 加入复习本'}
            </Text>
          </View>
        )}

        <View className="flex flex-row items-center justify-between bg-muted rounded-xl px-4 py-3 mb-4">
          <View className="flex-1">
            <Text className="block text-sm font-medium text-foreground">已掌握</Text>
            <Text className="block text-xs text-muted-foreground">标记后默认不进入汇总，可在文档页开启开关重新纳入</Text>
          </View>
          <Switch checked={mastered} onCheckedChange={(v) => setMastered(v)} />
        </View>

        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="block text-sm font-semibold text-foreground">题目</Text>
          {item?.content?.question_label ? (
            <View style={{ backgroundColor: 'rgba(190,62,45,0.08)', borderRadius: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>
              <Text className="block text-xs" style={{ color: '#BE3E2D' }}>{item.content.question_label}</Text>
            </View>
          ) : null}
        </View>
        <Card className="rounded-2xl border-border p-4 mb-4">
          <Textarea
            className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={qContent}
            placeholder="题目内容"
            maxlength={3000}
            onInput={(e) => setQContent(e.detail.value)}
          />
        </Card>

        {item?.question_image_urls?.length ? (
          <View className="mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-xs text-muted-foreground">题面图</Text>
              <Text className="block text-[10px] text-muted-foreground">点图看大图 ·「编辑」裁剪/旋转/黑白/高清 ·「识别」提取文字</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-3">
              {item.question_image_urls.map((u) => (
                <View key={u} className="flex flex-col items-center" style={{ width: 92 }}>
                  <View className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                    <Image
                      src={u}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ current: u, urls: item.question_image_urls || [u] })}
                    />
                  </View>
                  <View className="flex flex-row items-center gap-2 mt-1">
                    <View
                      className="px-2 rounded"
                      style={{ backgroundColor: 'rgba(190,62,45,0.08)', paddingTop: 2, paddingBottom: 2 }}
                      onClick={() => handleEditImage(u)}
                    >
                      <Text className="block text-[10px]" style={{ color: '#BE3E2D' }}>编辑</Text>
                    </View>
                    <View
                      className="px-2 rounded"
                      style={{ backgroundColor: 'rgba(190,62,45,0.08)', paddingTop: 2, paddingBottom: 2 }}
                      onClick={() => { if (!ocrBusy) void handleOcrImage(u) }}
                    >
                      <Text className="block text-[10px]" style={{ color: '#BE3E2D' }}>{ocrBusy ? '识别中' : '识别'}</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {item?.answer_image_urls?.length ? (
          <View className="mb-4">
            <Text className="block text-xs text-muted-foreground mb-2">答题卡图</Text>
            <View className="flex flex-row flex-wrap gap-2">
              {item.answer_image_urls.map((u) => (
                <View key={u} className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                  <Image
                    src={u}
                    mode="aspectFill"
                    style={{ width: '100%', height: '100%' }}
                    onClick={() => Taro.previewImage({ current: u, urls: item.answer_image_urls || [u] })}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {!item?.question_image_urls?.length && !item?.answer_image_urls?.length && item?.image_urls?.length ? (
          <View className="flex flex-row flex-wrap gap-2 mb-4">
            {item.image_urls.map((u) => (
              <View key={u} className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                <Image
                  src={u}
                  mode="aspectFill"
                  style={{ width: '100%', height: '100%' }}
                  onClick={() => Taro.previewImage({ current: u, urls: item.image_urls || [u] })}
                />
              </View>
            ))}
          </View>
        ) : null}

        {/* P2-16 错因分析 */}
        {item?.content?.error_analysis?.label && (
          <Card className="rounded-2xl border p-4 mb-4" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
            <Text className="block text-sm font-semibold mb-1" style={{ color: '#BE3E2D' }}>错因分析</Text>
            <Text className="block text-sm font-medium text-foreground mb-1">{item.content.error_analysis.label}</Text>
            {item.content.error_analysis.reason && (
              <Text className="block text-xs text-muted-foreground mb-1">{item.content.error_analysis.reason}</Text>
            )}
            {item.content.error_analysis.suggestion && (
              <Text className="block text-xs text-muted-foreground">{item.content.error_analysis.suggestion}</Text>
            )}
          </Card>
        )}

        {/* P2-18 艾宾浩斯复习计划 */}
        {item && plan && (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-sm font-semibold text-foreground">复习计划（艾宾浩斯）</Text>
              <Text className="block text-xs text-muted-foreground">已复习 {plan.review_count}/{plan.total_stages}</Text>
            </View>
            <View className="flex flex-row items-center gap-1 flex-wrap mb-3">
              {plan.schedule.map((s) => (
                <View key={s.stage} className="flex flex-col items-center px-1">
                  <View
                    className={`w-6 h-6 rounded-full flex items-center justify-center ${s.done ? 'border-0' : 'bg-muted border border-border'}`}
                    style={s.done ? { backgroundColor: '#BE3E2D' } : undefined}
                  >
                    <Text className={`text-[10px] ${s.done ? '' : 'text-muted-foreground'}`} style={s.done ? { color: '#fff' } : undefined}>
                      {s.done ? '✓' : s.stage}
                    </Text>
                  </View>
                  <Text className="block text-[10px] text-muted-foreground mt-1">第{s.day}天</Text>
                </View>
              ))}
            </View>
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-xs text-muted-foreground">
                {plan.completed ? '已全部完成复习阶段 🎉' : `下次复习：${plan.next_review_at ? formatDate(plan.next_review_at) : '—'}`}
              </Text>
              {!plan.completed && (
                <Button variant="outline" className="h-8 rounded-lg px-3" onClick={handleReview} disabled={reviewing}>
                  <Text className="block text-xs">{reviewing ? '记录中…' : '今天复习了 ✓'}</Text>
                </Button>
              )}
            </View>
          </Card>
        )}

        {/* P2-17 相似 / 变式题（基于用户自建错题历史） */}
        <View className="mb-4">
          <Text className="block text-sm font-semibold text-foreground mb-2" onClick={toggleSimilar}>
            相似 / 变式题 {similarOpen ? '▾' : '▸'}
          </Text>
          {similarOpen && (
            similarLoading ? (
              <Text className="block text-xs text-muted-foreground">加载中…</Text>
            ) : similar.length ? (
              <View className="flex flex-col gap-2">
                {similar.map((s) => (
                  <View key={s.id} className="rounded-xl border border-border p-3">
                    <Text className="block text-xs text-foreground mb-1">{truncate(s.question || '（无题面文本）', 80)}</Text>
                    <View className="flex flex-row items-center justify-between">
                      <View className="flex flex-row gap-1 flex-wrap">
                        {s.shared_tags.map((t) => (
                          <Text key={t} className="block text-[10px]" style={{ color: '#BE3E2D', backgroundColor: 'rgba(190,62,45,0.1)' }}>
                            {t}
                          </Text>
                        ))}
                      </View>
                      <Text className="block text-[10px] text-muted-foreground">相似度 {Math.round(s.score * 100)}%</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="block text-xs text-muted-foreground">暂无相似错题（多在「最近题目」里多攒几道同知识点题后会显现）</Text>
            )
          )}
        </View>

        {/* 答案区（思傅 2026-10-21）：文本 + 图片/文档附件 + 裁剪 + 联网搜答案，
            全部按 item.id 写入该题目记录，答案与题目一一对应。
            onSaved 同步回 aContent/solution，避免页面底部「保存」用旧 state 覆盖。
            ⚠️ 必须等 item 到位再挂载：AnswerEditor 的 useState 初值取 item.content，
            首帧 item=null 时渲染会 TypeError 崩整页（2026-10-22 详情页打不开根因，
            回归引入于 d3e4e98）。 */}
        {item && (
          <AnswerEditor
            item={item}
            onSaved={(updated) => {
              setItem(updated)
              setAContent(updated.content?.answer || '')
              setSolution(updated.content?.solution || '')
            }}
          />
        )}

        <View className="mt-4">
          <Text className="block text-xs text-muted-foreground mb-2">详细解题过程</Text>
          <MathSymbolBar
            onInsert={insertSolutionSymbol}
            preview={solutionMode === 'view'}
            onTogglePreview={() => { if (solutionMode === 'view') startSolutionEdit(); else finishSolutionEdit() }}
          />
        </View>
        <Card className="rounded-2xl border-border p-4 mb-2">
          {solutionMode === 'view' ? (
            solution.trim() ? (
              <MathText text={solution} />
            ) : (
              <Text className="block text-sm text-muted-foreground">（暂无解题过程，点「编辑」输入）</Text>
            )
          ) : (
            <Textarea
              className="min-h-28 border-0 ring-0 focus-within:ring-0 rounded-xl"
              value={solutionEditing}
              placeholder="可粘贴或输入详细解析（1/2、√3、x² 等写法即可）"
              maxlength={3000}
              cursor={solutionCursor}
              onInput={(e) => { setSolutionEditing(e.detail.value); setSolutionCursor(e.detail.cursor ?? -1) }}
            />
          )}
        </Card>

        <View className="mt-6">
          <Text className="block text-xs text-muted-foreground" onClick={handleDelete} style={{ color: '#BE3E2D' }}>
            删除这条记录
          </Text>
        </View>
      </View>

      <View style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        display: 'flex', flexDirection: 'row', gap: '12px',
        padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
      }}
      >
        <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={handlePrint}>
          <Text className="block text-sm">导出打印</Text>
        </Button>
        <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
          <Text className="block text-sm">{saving ? '保存中…' : '保存修改'}</Text>
        </Button>
      </View>
    </ScrollView>

      {/* 识别结果面板（思傅 2026-10-21）：题面图 OCR → 追加/替换进题干 */}
      {ocrResult ? (
        // ⚠️ z-index 200 压过底部「保存修改」悬浮条（zIndex:100），否则面板被盖住只能点关闭（2026-10-23 同 material-picker 一起修）
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 200, background: 'rgba(0,0,0,0.4)' }} onClick={() => setOcrResult('')}>
          <View className="bg-background rounded-t-2xl p-4" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72vh' }} onClick={(e) => e.stopPropagation?.()}>
            <Text className="block text-sm font-semibold text-foreground mb-3">识别结果（可追加或替换题干）</Text>
            <ScrollView scrollY style={{ maxHeight: '42vh' }}>
              <Text className="block text-sm text-foreground leading-relaxed">{ocrResult}</Text>
            </ScrollView>
            <View className="flex flex-row items-center gap-2 mt-4">
              <Button className="flex-1 h-11 rounded-xl" onClick={() => applyOcrResult('append')}>
                <Text className="block text-sm">追加到题干</Text>
              </Button>
              <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={() => applyOcrResult('replace')}>
                <Text className="block text-sm">替换题干</Text>
              </Button>
            </View>
            <View className="mt-2">
              <Button variant="outline" className="w-full h-11 rounded-xl" onClick={() => setOcrResult('')}>
                <Text className="block text-sm">关闭</Text>
              </Button>
            </View>
          </View>
        </View>
      ) : null}

      {/* 题面图编辑器：裁剪/旋转/黑白灰度/智能高清/去手写；点「保存并替换原图」才原位替换该图，不新建条目 */}
      <ImageEditor
        visible={!!editorImg}
        src={editorImg}
        enableSaveToInbox={false}
        confirmText="保存并替换原图"
        onCancel={() => setEditorImg('')}
        onConfirm={(p) => void handleEditorConfirm(p)}
      />
      {editorBusy ? (
        <View style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 300 }} />
      ) : null}
    </>
  )
}
