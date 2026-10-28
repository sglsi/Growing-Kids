import { View, Text, ScrollView, Picker, Image } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState, useEffect, useRef } from 'react'
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
import AnswerSolutionEditor from '@/components/answer-solution-editor'
import MathSymbolBar from '@/components/math-symbol-bar'
import { latexToReadable, readableToLatex } from '@/utils/latex'
import { splitAnswerSolution, joinAnswerSolution } from '@/utils/answer-merge'
import { useCaret } from '@/utils/use-caret'
import { getSubjectColor, formatTime, truncate, type SimilarItem, type ReviewPlan } from '@/types'
import { openStorageFile } from '@/services/net'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND, DANGER } from '@/lib/theme'

/**
 * 复习排程计划**由后端现算**（GET /api/timeline/:id 返回 review_plan）。
 *
 * 为什么删掉这里原本的 computePlan：
 *   它按 `created_at + 累计间隔` 在本地算了一份"艾宾浩斯计划"，与后端各算一遍，
 *   基准（创建时间而非上次复习）和档位都不同 ⇒ 两端显示必然打架，改规则要改两处。
 *   C4 改造后档位真相在后端（timeline/review.ts），前端只负责展示。
 */

/**
 * 「下次什么时候复习」文案。
 * 不直接显示日期：孩子/家长关心的是「还有几天」，日期只在括号里做参照。
 */
function planTextOf(plan: ReviewPlan | null): string {
  if (!plan) return ''
  if (plan.completed) return '五档已走完'
  if (plan.status === 'graduated') return '五档已走完'
  if (!plan.next_review_at) return '未排程'
  const d = new Date(plan.next_review_at)
  const days = plan.days_until_due ?? 0
  if (days <= 0) return `今天该复习（${d.getMonth() + 1}/${d.getDate()}）`
  return `${days} 天后（${d.getMonth() + 1}/${d.getDate()}）`
}

export default function DetailPage() {
  const router = useRouter()
  const id = router.params.id || ''
  const [item, setItem] = useState<TimelineItem | null>(null)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectId, setSubjectId] = useState('')
  const [qContent, setQContent] = useState('')
  /**
   * 答案 + 解题过程合并后的编辑文本（可读形式，非 LaTeX）（思傅 2026-10-26）
   *
   * 为什么合并成一个框：
   *   ① 家长写题解本来就是「答案写完接着写过程」，两个框各有一套预览态/保存按钮，
   *      很容易在有未提交编辑时点底部「保存修改」，结果写进库的是旧值（存不上）；
   *   ② 答案框原先没设 maxlength，微信 textarea 默认 140 字截断，长答案被静默吞掉。
   * 库里仍是 content.answer / content.solution 两个字段：保存时按「解析：」小标题切回去，
   * 导出 Word/PDF 的「正确答案」「解析」两段标题不受影响。
   */
  const [answerDraft, setAnswerDraft] = useState('')
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

  // 输入框光标庇护所（思傅 2026-10-26 修「光标跳到末尾」）：位置记在 ref 里，
  // 只有程序化插入符号时才一次性定位，绝不逐字干预原生光标（详见 utils/use-caret.ts）
  const qCaret = useCaret()
  const aCaret = useCaret()
  /** 用户是否已经动过输入框：SWR 的网络回包不得覆盖正在编辑的内容 */
  const dirtyRef = useRef(false)

  /** 把一条题目数据铺进页面 state（缓存首帧与网络刷新共用） */
  const applyItem = (it: TimelineItem) => {
    setItem(it)
    setSubjectId(it.subject_id || '')
    setQContent(it.content?.question || '')
    setAnswerDraft(joinAnswerSolution(
      latexToReadable(it.content?.answer || ''),
      latexToReadable(it.content?.solution || ''),
    ))
    setMastered(it.mastered)
    setPlan(it.review_plan || null)
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
      // ⚠️ 用户已经开始编辑时只更新条目元数据（图片/学科/复习态），不碰正在输入的文本：
      //    否则后台回包（或缓存→网络的第二次铺数据）会把刚敲的字和光标位置一起冲掉。
      if (dirtyRef.current) setItem(it)
      else applyItem(it)
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

  /**
   * 保存修改：题干 + 答案与解题过程 + 学科 + 掌握状态**一次提交**。
   *
   * 思傅 2026-10-26 修「答案/解题过程点了保存没存上」：旧实现读的是 aContent / solution
   * 两个独立 state，而真正的编辑内容躺在子组件（AnswerEditor 的 editing）和
   * solutionEditing 里，只有点它们各自的「保存/完成」才回写——直接点底部的
   * 「保存修改」写进库的是编辑前的旧值。现在页面只有一份草案（answerDraft），
   * 保存时按「解析：」切分回 answer / solution 两个字段，所见即所存。
   */
  const handleSave = async () => {
    setSaving(true)
    try {
      const parts = splitAnswerSolution(answerDraft)
      // 没动过的那一段直接沿用库里的 LaTeX，不做「可读形式 → LaTeX」回转：
      // 回转对分数/根号/幂是等价的，但 cases/aligned 这类结构只能近似成纯文本，
      // 用户没改它就不该被降级（保存两次也能保持幂等）。
      const baseAnswer = latexToReadable(item?.content?.answer || '').trim()
      const baseSolution = latexToReadable(item?.content?.solution || '').trim()
      const answerLatex = parts.answer === baseAnswer
        ? (item?.content?.answer || '')
        : readableToLatex(parts.answer)
      const solutionLatex = parts.solution === baseSolution
        ? (item?.content?.solution || '')
        : readableToLatex(parts.solution)
      const updated = await updateQuestion(id, {
        subject_id: subjectId,
        question_content: qContent,
        answer_content: answerLatex,
        solution: solutionLatex,
        status: answerLatex || solutionLatex ? 'answered' : 'pending',
        mastered,
      })
      setItem(updated)
      dirtyRef.current = false
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
   * 数学符号/模板插入「答案与解题过程」框：`|` 为插入后光标停留位（模板用）。
   * 光标位置取最近一次真实输入事件（caret.position），插入后一次性定位——
   * 不再每次输入都改 cursor 属性（那是光标跳末尾的元凶）。
   */
  const insertAnswerSymbol = (snippet: string) => {
    const cur = answerDraft
    const pos = aCaret.position(cur.length)
    const marker = snippet.indexOf('|')
    const plain = snippet.replace('|', '')
    const next = cur.slice(0, pos) + plain + cur.slice(pos)
    setAnswerDraft(next)
    dirtyRef.current = true
    aCaret.request(marker >= 0 ? pos + marker : pos + plain.length)
  }

  /**
   * 数学符号/模板插入题目栏（思傅 2026-10-23：题目栏也支持数学符号输入）。
   * 题干是纯文本编辑（不转 LaTeX），符号与模板的可读片段直接插入。
   */
  const insertQuestionSymbol = (snippet: string) => {
    const pos = qCaret.position(qContent.length)
    const marker = snippet.indexOf('|')
    const plain = snippet.replace('|', '')
    const next = qContent.slice(0, pos) + plain + qContent.slice(pos)
    setQContent(next)
    dirtyRef.current = true
    qCaret.request(marker >= 0 ? pos + marker : pos + plain.length)
  }

  /**
   * 「导出打印」（思傅 2026-10-26 修两点）：
   *  ① 范围：只导出**本题**（ids 白名单）——旧实现传 subject_id 会把整科题目全导出来，
   *     打印一道题却附赠全科内容；
   *  ② 答案：默认不含答案/解析（打给孩子练），需要时选「含答案」。
   */
  const handlePrint = async () => {
    if (!item) return
    Taro.showActionSheet({
      itemList: ['导出本题（不含答案）', '导出本题（含答案与解析）'],
      success: async (r) => {
        const withAnswers = r.tapIndex === 1
        try {
          const res = await exportDocument({
            ids: [id],
            include_answers: withAnswers,
            title: `题目导出 · ${new Date().toLocaleDateString('zh-CN')}`,
          })
          openStorageFile(res.url, false, res.file_key)
        } catch (e) {
          console.error('导出失败', e)
          Taro.showToast({ title: '导出失败', icon: 'none' })
        }
      },
      fail: () => { /* 取消 */ },
    })
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
    const next = mode === 'replace' ? t : qContent.trim() ? `${qContent.trim()}\n${t}` : t
    setQContent(next)
    // 整段写入后光标自然落在末尾（一次性定位；之后打字不再干预）
    qCaret.request(next.length)
    dirtyRef.current = true
    setOcrResult('')
    Taro.showToast({ title: mode === 'replace' ? '已替换题干' : '已追加到题干', icon: 'success' })
  }

  /**
   * 删除详情页里的某张图（思傅 2026-10-23）：
   * 题面图 / 答题卡图 / 旧版 images 兜底图均可删。
   * 前端拿到的是一签名 URL，按 URL 反查下标后**全量替换**对应 key 数组
   * （后端 content 局部合并，未传字段不受影响）。删除只解引用、不物理删文件，
   * 与「编辑替换」同一语义，存储由孤儿 GC 兜底回收。
   */
  const handleDeleteImage = async (which: 'question' | 'answer' | 'legacy', url: string) => {
    if (!item) return
    const ok = await new Promise<boolean>((resolve) =>
      Taro.showModal({
        title: '确认删除',
        content: '删除后不可恢复，是否继续？',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!ok) return
    const urls = which === 'question' ? item.question_image_urls || []
      : which === 'answer' ? item.answer_image_urls || []
        : item.image_urls || []
    const keys = which === 'question' ? item.content?.question_images || []
      : which === 'answer' ? item.content?.answer_images || []
        : item.content?.images || []
    const idx = urls.indexOf(url)
    if (idx < 0 || idx >= keys.length) {
      Taro.showToast({ title: '未找到该图片，请刷新后重试', icon: 'none' })
      return
    }
    const nextKeys = keys.filter((_, i) => i !== idx)
    try {
      if (which === 'question') await updateQuestion(item.id, { question_images: nextKeys })
      else if (which === 'answer') await updateQuestion(item.id, { answer_images: nextKeys })
      else await updateQuestion(item.id, { images: nextKeys })
      Taro.showToast({ title: '图片已删除', icon: 'success' })
      await load()
    } catch (e) {
      console.error('删除图片失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '删除失败，请重试', icon: 'none' })
    }
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

  /**
   * C4 记录一次复习结果。
   *
   * 必须分「做对 / 做错」两个按钮：分散练习的收益前提是**成功提取**，
   * 做错说明这次提取失败、间隔必须回到最短档位（次日再来），
   * 做对才推进一档。合成一个「今天复习了 ✓」等于让数据无法区分两者。
   */
  const handleReview = async (result: 'correct' | 'wrong') => {
    if (!item) return
    setReviewing(true)
    try {
      const res = await markReviewed(item.id, result)
      setPlan(res.plan)
      setItem({
        ...item,
        in_review_book: true,
        review_count: res.review_count,
        review_lapses: res.review_lapses,
        last_reviewed_at: res.last_reviewed_at,
        next_review_at: res.next_review_at,
        review_plan: res.plan,
      })
      Taro.showToast({
        title: result === 'correct' ? `做对了，下次 ${planTextOf(res.plan)}` : '做错了，明天再来',
        icon: 'none',
      })
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

  // 思傅 2026-10-26 修「切换学科后左上角科目不变」：徽标改为跟随 subjectId 实时解析——
  // Picker 只 setSubjectId（切换即显示），点底部「保存修改」才真正落库（updateQuestion）。
  // subjects 未就绪时回退 item.subjects（服务端真相）。
  const curSubject = subjects.find((s) => s.id === subjectId) || item?.subjects || null
  const color = getSubjectColor(curSubject?.color)

  // 图片资料（kind=image）：只展示图片 + 归属学科，不做题目编辑
  if (item && item.kind === 'image') {
    return (
      <ScrollView scrollY className="h-full bg-background">
        <View className="px-4 pt-4 pb-32">
          <View className="flex flex-row items-center gap-2 mb-4">
              <View className={`flex flex-row items-center gap-2 rounded-full border px-3 py-1 ${color.badge}`}>
                <View className={`w-2 h-2 rounded-full ${color.dot}`} />
                <Text className="block text-xs">{curSubject?.name || '未分类'}</Text>
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
              编辑结果 attach 上传 → 原位替换该条目的 file_key（与首页一致，不新建条目）。
              思傅 2026-10-23：图片条目删除 = 删整条（图即条目），确认后走 handleDelete；
              再加「识别」——图片条目（只有图片的题目）也能 OCR 提取文字存进题干。 */}
          <View className="flex flex-row items-center justify-between mb-4">
            <Text className="block text-xs text-muted-foreground">点图看大图 ·「编辑」裁剪/旋转/黑白/高清 ·「识别」提取文字</Text>
            <View className="flex flex-row items-center gap-2">
              <View
                className="px-3 rounded-lg"
                style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 6, paddingBottom: 6 }}
                onClick={() => handleEditImage(item.url || item.thumb_url || '')}
              >
                <Text className="block text-xs" style={{ color: BRAND_TEXT }}>编辑</Text>
              </View>
              <View
                className="px-3 rounded-lg"
                style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 6, paddingBottom: 6 }}
                onClick={() => { if (!ocrBusy) void handleOcrImage(item.url || item.thumb_url || '') }}
              >
                <Text className="block text-xs" style={{ color: BRAND_TEXT }}>{ocrBusy ? '识别中' : '识别'}</Text>
              </View>
              <View
                className="px-3 rounded-lg"
                style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 6, paddingBottom: 6 }}
                onClick={handleDelete}
              >
                <Text className="block text-xs" style={{ color: BRAND_TEXT }}>删除</Text>
              </View>
            </View>
          </View>

          {/* 题干（思傅 2026-10-23）：图片条目此前没有题干区——识别出的文字无处可存。
              这里补上题目编辑卡片（与题目条目同款：符号栏 + Textarea），
              识别结果面板「追加/替换」写入 qContent，底部「保存修改」统一入库
              （handleSave 早已带 question_content）。 */}
          <View className="flex flex-row items-center justify-between mb-2">
            <Text className="block text-sm font-semibold text-foreground">题目</Text>
            <Text className="block text-xs text-muted-foreground">识别或手动输入题干</Text>
          </View>
          <MathSymbolBar onInsert={insertQuestionSymbol} />
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Textarea
              className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-xl"
              value={qContent}
              placeholder="题目内容（可点「识别」从图片提取）"
              maxlength={-1}
              cursor={qCaret.cursor}
              onInput={(e) => { setQContent(e.detail.value); qCaret.track(e.detail.cursor); dirtyRef.current = true }}
            />
          </Card>

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
              <View className="px-3 py-1 rounded-lg" style={{ backgroundColor: 'rgba(16, 185, 129,0.08)' }}>
                <Text className="block text-sm text-brand-text">
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
              <Text className="block text-sm" style={{ color: BRAND_TEXT }}>删除</Text>
            </Button>
          </View>

          {/* 思傅 2026-10-22 / 2026-10-26：图片类题目也要支持答案输入与联网搜题。
              答案与解题过程合并成一个框（页面统管，底部「保存修改」一次写 answer+solution），
              AnswerEditor 只留附件/搜题能力；后端 update() 对 content 做局部合并、不校验 kind。 */}
          <AnswerSolutionEditor
            value={answerDraft}
            cursor={aCaret.cursor}
            onInput={(v, c) => { setAnswerDraft(v); aCaret.track(c); dirtyRef.current = true }}
            onInsert={insertAnswerSymbol}
          />

          <AnswerEditor
            item={item}
            hideTextBox
            onSaved={(updated) => setItem(updated)}
            onAdopt={(a, s) => {
              // 采纳搜题/AI 结果：刷进合并编辑框（用户再点「保存修改」才真正入库）
              setAnswerDraft(joinAnswerSolution(latexToReadable(a), latexToReadable(s)))
              dirtyRef.current = true
            }}
          />
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

        {/* 识别结果面板（思傅 2026-10-23：图片条目分支补挂——
            此前只挂在题目分支里，图片条目「识别」后没有面板展示结果。
            「追加/替换」写入题干 state，由底部「保存修改」统一入库。 */}
        {ocrResult ? (
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
                <Text className="block text-xs">{curSubject?.name || '未分类'}</Text>
              </View>
              <Picker
                mode="selector"
                range={subjects}
                rangeKey="name"
                value={Math.max(0, subjects.findIndex((s) => s.id === subjectId))}
                onChange={(e) => setSubjectId(subjects[Number(e.detail.value)]?.id || subjectId)}
              >
                <View className="px-3 py-1 rounded-full" style={{ backgroundColor: 'rgba(16, 185, 129,0.08)' }}>
                  <Text className="block text-xs text-brand-text">切换学科</Text>
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
            <View style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', borderRadius: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>
              <Text className="block text-xs" style={{ color: BRAND_TEXT }}>{item.content.question_label}</Text>
            </View>
          ) : null}
        </View>
        <MathSymbolBar onInsert={insertQuestionSymbol} />
        <Card className="rounded-2xl border-border p-4 mb-4">
          <Textarea
            className="min-h-32 border-0 ring-0 focus-within:ring-0 rounded-xl"
            value={qContent}
            placeholder="题目内容"
            maxlength={-1}
            cursor={qCaret.cursor}
            onInput={(e) => { setQContent(e.detail.value); qCaret.track(e.detail.cursor); dirtyRef.current = true }}
          />
        </Card>

        {item?.question_image_urls?.length ? (
          <View className="mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-xs text-muted-foreground">题面图</Text>
              <Text className="block text-xs text-muted-foreground">点图看大图 ·「编辑」裁剪/旋转/黑白/高清 ·「识别」提取文字 ·「删除」移除</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-3">
              {item.question_image_urls.map((u) => (
                <View key={u} className="flex flex-col items-center" style={{ width: 124 }}>
                  <View className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                    <Image
                      src={u}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ current: u, urls: item.question_image_urls || [u] })}
                    />
                  </View>
                  <View className="flex flex-row items-center flex-wrap justify-center gap-1 mt-1">
                    <View
                      className="px-[6px] rounded"
                      style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 2, paddingBottom: 2 }}
                      onClick={() => handleEditImage(u)}
                    >
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>编辑</Text>
                    </View>
                    <View
                      className="px-[6px] rounded"
                      style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 2, paddingBottom: 2 }}
                      onClick={() => { if (!ocrBusy) void handleOcrImage(u) }}
                    >
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>{ocrBusy ? '识别中' : '识别'}</Text>
                    </View>
                    <View
                      className="px-[6px] rounded"
                      style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 2, paddingBottom: 2 }}
                      onClick={() => void handleDeleteImage('question', u)}
                    >
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>删除</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {item?.answer_image_urls?.length ? (
          <View className="mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-xs text-muted-foreground">答题卡图</Text>
              <Text className="block text-xs text-muted-foreground">点图看大图 ·「删除」移除该图</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-3">
              {item.answer_image_urls.map((u) => (
                <View key={u} className="flex flex-col items-center" style={{ width: 96 }}>
                  <View className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                    <Image
                      src={u}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ current: u, urls: item.answer_image_urls || [u] })}
                    />
                  </View>
                  <View
                    className="px-[6px] rounded mt-1"
                    style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 2, paddingBottom: 2 }}
                    onClick={() => void handleDeleteImage('answer', u)}
                  >
                    <Text className="block text-xs" style={{ color: BRAND_TEXT }}>删除</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {!item?.question_image_urls?.length && !item?.answer_image_urls?.length && item?.image_urls?.length ? (
          <View className="mb-4">
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="block text-xs text-muted-foreground">图片</Text>
              <Text className="block text-xs text-muted-foreground">点图看大图 ·「删除」移除该图</Text>
            </View>
            <View className="flex flex-row flex-wrap gap-3">
              {item.image_urls.map((u) => (
                <View key={u} className="flex flex-col items-center" style={{ width: 96 }}>
                  <View className="w-24 h-24 rounded-lg overflow-hidden border border-border">
                    <Image
                      src={u}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ current: u, urls: item.image_urls || [u] })}
                    />
                  </View>
                  <View
                    className="px-[6px] rounded mt-1"
                    style={{ backgroundColor: 'rgba(16, 185, 129,0.08)', paddingTop: 2, paddingBottom: 2 }}
                    onClick={() => void handleDeleteImage('legacy', u)}
                  >
                    <Text className="block text-xs" style={{ color: BRAND_TEXT }}>删除</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* P2-16 错因分析 */}
        {item?.content?.error_analysis?.label && (
          <Card className="rounded-2xl border p-4 mb-4" style={{ borderColor: 'rgba(16, 185, 129,0.25)', backgroundColor: 'rgba(16, 185, 129, 0.08)' }}>
            <Text className="block text-sm font-semibold mb-1" style={{ color: BRAND_TEXT }}>错因分析</Text>
            <Text className="block text-sm font-medium text-foreground mb-1">{item.content.error_analysis.label}</Text>
            {item.content.error_analysis.reason && (
              <Text className="block text-xs text-muted-foreground mb-1">{item.content.error_analysis.reason}</Text>
            )}
            {item.content.error_analysis.suggestion && (
              <Text className="block text-xs text-muted-foreground">{item.content.error_analysis.suggestion}</Text>
            )}
          </Card>
        )}

        {/* C4 复习排程（分散练习 d = 0.85；plan 由后端现算下发）
            ⚠️ 只在「已在复习本」时显示：不在本里的题还没有排程，
            显示「第 1/5 档 + 做对了」会让人以为排程已经开始工作。 */}
        {item && plan && plan.in_review_book && (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <View className="flex flex-row items-center justify-between mb-1">
              <Text className="block text-sm font-semibold text-foreground">复习排程</Text>
              <Text className="block text-xs text-muted-foreground">
                {plan.status === 'graduated'
                  ? `已走完 ${plan.total_stages} 档`
                  : `第 ${Math.min(plan.review_count + 1, plan.total_stages)}/${plan.total_stages} 档`}
              </Text>
            </View>
            <Text className="block text-xs text-muted-foreground mb-2">
              {plan.status === 'graduated'
                ? `五档都做对了，这题已经稳了（仍留在复习本）${plan.review_lapses > 0 ? ` · 曾做错 ${plan.review_lapses} 次` : ''}`
                : plan.status === 'due'
                  ? (plan.overdue_days > 0 ? `已逾期 ${plan.overdue_days} 天，今天补上` : '今天就该复习')
                  : plan.status === 'unscheduled'
                    ? '未排程（移出复习本会取消排程）'
                    : `下次：${planTextOf(plan)}${plan.review_lapses > 0 ? ` · 曾做错 ${plan.review_lapses} 次` : ''}`}
            </Text>
            <View className="flex flex-row items-center gap-1 flex-wrap mb-3">
              {plan.schedule.map((s) => (
                <View key={s.stage} className="flex flex-col items-center px-1">
                  <View
                    className={`w-6 h-6 rounded-full flex items-center justify-center ${s.done ? 'border-0' : s.current ? 'border-2' : 'bg-muted border border-border'}`}
                    style={s.done ? { backgroundColor: BRAND } : s.current ? { borderColor: BRAND } : undefined}
                  >
                    <Text
                      className="text-xs"
                      style={s.done ? { color: BRAND_FOREGROUND } : s.current ? { color: BRAND_TEXT } : undefined}
                    >
                      {s.done ? '✓' : s.stage}
                    </Text>
                  </View>
                  <Text className="block text-xs text-muted-foreground mt-1">{s.interval_days}天</Text>
                </View>
              ))}
            </View>
            {plan.status !== 'graduated' && (
              <View className="flex flex-row items-center gap-2">
                <Button
                  variant="outline"
                  className="h-9 rounded-lg px-3 flex-1"
                  onClick={() => handleReview('wrong')}
                  disabled={reviewing}
                >
                  <Text className="block text-xs" style={{ color: DANGER }}>
                    {reviewing ? '记录中…' : '做错了'}
                  </Text>
                </Button>
                <Button className="h-9 rounded-lg px-3 flex-1" onClick={() => handleReview('correct')} disabled={reviewing}>
                  <Text className="block text-xs" style={{ color: BRAND_FOREGROUND }}>
                    {reviewing ? '记录中…' : '做对了'}
                  </Text>
                </Button>
              </View>
            )}
            <Text className="block text-xs text-muted-foreground mt-2">
              做对推进一档（1→3→7→14→28 天），做错回到第 1 档、明天再来。分几次复习，比一次做三遍记得更久。
            </Text>
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
                          <Text key={t} className="block text-xs" style={{ color: BRAND_TEXT, backgroundColor: 'rgba(16, 185, 129, 0.08)' }}>
                            {t}
                          </Text>
                        ))}
                      </View>
                      <Text className="block text-xs text-muted-foreground">相似度 {Math.round(s.score * 100)}%</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="block text-xs text-muted-foreground">暂无相似错题（多在「最近题目」里多攒几道同知识点题后会显现）</Text>
            )
          )}
        </View>

        {/* 答案区（思傅 2026-10-21 / 2026-10-26）：答案与解题过程合并成一个框，
            内容由页面 state（answerDraft）统管，底部「保存修改」一次写入 answer+solution；
            AnswerEditor 只负责附件（图片/文档/资料库）与联网搜题/AI 解题。
            ⚠️ 必须等 item 到位再挂载：AnswerEditor 的 useState 初值取 item.content，
            首帧 item=null 时渲染会 TypeError 崩整页（2026-10-22 详情页打不开根因，
            回归引入于 d3e4e98）。 */}
        <AnswerSolutionEditor
          value={answerDraft}
          cursor={aCaret.cursor}
          onInput={(v, c) => { setAnswerDraft(v); aCaret.track(c); dirtyRef.current = true }}
          onInsert={insertAnswerSymbol}
        />

        {item && (
          <AnswerEditor
            item={item}
            hideTextBox
            onSaved={(updated) => setItem(updated)}
            onAdopt={(a, s) => {
              // 采纳搜题/AI 结果：刷进合并编辑框（用户再点「保存修改」才真正入库）
              setAnswerDraft(joinAnswerSolution(latexToReadable(a), latexToReadable(s)))
              dirtyRef.current = true
            }}
          />
        )}

        <View className="mt-6">
          <Text className="block text-xs text-muted-foreground" onClick={handleDelete} style={{ color: BRAND_TEXT }}>
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
