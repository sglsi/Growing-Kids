import { useEffect, useRef, useState } from 'react'
import { View, Text, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Plus, Trash2, Crop, Globe, FileText, Check, X, Bot, BookOpen } from 'lucide-react-taro'
import ImageEditor from '@/components/image-editor'
import MaterialPicker from '@/components/material-picker'
import MathSymbolBar from '@/components/math-symbol-bar'
import MathText from '@/components/math-text'
import { Textarea } from '@/components/ui/textarea'
import { latexToReadable, readableToLatex } from '@/utils/latex'
import { useCaret } from '@/utils/use-caret'
import { guardPrivacy, reportChooseFail } from '@/utils/privacy'
import { guardPolicy } from '@/services/policy-gate'
import { uploadImage, uploadFile, searchAnswer, saveAnswer } from '@/services/api'
import { isJobAborted } from '@/services/jobs'
import { AI_DISABLED_HINT, ensureAiSetting } from '@/services/ai-settings'
import { AI_PUBLIC_ENTRY } from '@/constants/app-info'
import type { AnswerAttachment, TimelineItem } from '@/types'
import type { AnswerSearchResult } from '@/services/api'
// P-015 / D-018：事先声明文案的前端镜像（服务端缺字段时兜底，绝不出现「有内容、无声明」）
import { REFERENCE_DISCLAIMER, REFERENCE_ITEM_HINT } from '@/constants/reference-disclaimer'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND, DANGER, INK } from '@/lib/theme'

/**
 * 题目答案编辑区（思傅 2026-10-21）
 *
 * 设计依据见「题目答案功能-设计方案.md」：
 *  - 答案支持 **图片 / 文档 / 文本** 三类；
 *  - 图片可裁剪（复用 ImageEditor 的 cropOnly）；
 *  - **答案与题目一一对应**：答案内嵌在题目 content 里，且所有写入都按 `item.id`
 *    定位，编辑器顶部常驻「答案将存入：…」目标锚，杜绝裁给错的题。
 *  - 「联网搜答案」的结果**不自动入库**，必须用户点「采纳」（安全阀）。
 */

interface Props {
  item: TimelineItem
  /** 保存成功后回调（用于刷新页面 state / 列表） */
  onSaved?: (item: TimelineItem) => void
  /**
   * 不渲染内置的答案输入框与符号栏（思傅 2026-10-26）：
   * 详情页把「正确答案 + 详细解题过程」合并成一个编辑框，由页面统管（底部「保存修改」
   * 一次写入 answer 与 solution）；本组件只留附件 / 搜题能力，避免两个框各有一套
   * 未提交的编辑态导致「点了保存却没存上」。
   */
  hideTextBox?: boolean
  /** 采纳搜题/AI 结果后回传文本，供调用方刷新自己的合并编辑框 */
  onAdopt?: (answer: string, solution: string) => void
}

/** 答案将存入的目标锚：优先题号标签，否则题干前 16 字（item 为空时返回「本题」，绝不抛） */
function targetLabel(item: TimelineItem | null | undefined): string {
  const c = item?.content || {}
  const label = c.question_label || ''
  if (label) return label
  const q = (c.question || item?.title || '').trim()
  return q ? `${q.slice(0, 16)}${q.length > 16 ? '…' : ''}` : '本题'
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export default function AnswerEditor({ item, onSaved, hideTextBox, onAdopt }: Props) {
  // ⚠️ item 可能为 null（调用方未等数据到位就挂载时会走到）——全部可选链，
  //    保证永不因空 item 崩渲染（2026-10-22 详情页打不开的直接崩溃点）。
  const [text, setText] = useState(item?.content?.answer || '')
  const [atts, setAtts] = useState<AnswerAttachment[]>(item?.content?.answer_attachments || [])
  // 答案框光标（思傅 2026-10-26）：位置只在 ref 里跟踪，程序化插入符号时才一次性定位，
  // 否则每次输入都改 cursor 属性会把光标拽到末尾（详见 utils/use-caret.ts）
  const caret = useCaret()
  // 答案区两种模式（思傅 2026-10-23：源码用户看不懂也编辑不了，编辑界面不能出现 \frac 这类命令）：
  //   view = 渲染态，显示数学式（默认，有答案时）
  //   edit = 编辑态，Textarea 里放的是**可读形式**（1/2、√3、x²、∠ABC、→a），
  //          进入编辑时才把库存 LaTeX 转成可读形式，保存时再转回 LaTeX 入库。
  //          text 始终保存库里的 LaTeX（唯一真相），editing 才是编辑中的可读文本。
  const [mode, setMode] = useState<'view' | 'edit'>(() =>
    (item?.content?.answer || '').trim() ? 'view' : 'edit',
  )
  const [editing, setEditing] = useState('')
  /**
   * 输入中的实时文本（思傅 2026-10-31 第十轮，见 工程教训录 L29）
   *
   * 打字时**不能 setState**：Taro 对表单元素无条件把 value 塞进 setData
   * （`react.esm.js:372` `isFormElement && i === 'value'`），而微信 textarea 是原生组件，
   * 页面 setData 时按 value 重新应用文本、光标落末尾。⇒ 边打边 setState = 边打边把
   * 光标甩到结尾。所以实时文本只放 ref，失焦/程序化写入（插符号、采纳搜题）时才同步进 state。
   */
  const editingRef = useRef('')
  const [saving, setSaving] = useState(false)
  // 当前正在进行的解题模式（null=空闲）：'search' 联网搜题 / 'kb' 知识库 / 'ai' AI 解题
  const [searching, setSearching] = useState<'search' | 'kb' | 'ai' | null>(null)
  /**
   * 卸载探针（GK-23-19）：联网搜题/AI 解题最长 270s，用户收起面板或返回上一页后
   * 轮询若不停，既白烧后端配额，又会在已卸载组件上 setState。
   */
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])
  const [candidate, setCandidate] = useState<AnswerSearchResult | null>(null)
  // P-015 / D-018：参考例题默认折叠，点「展开」才显示完整题目与解题过程
  const [expandedRefs, setExpandedRefs] = useState<Record<number, boolean>>({})
  // 裁剪：进入编辑器前先记住目标，确认后写回**同一条** item
  const [cropSrc, setCropSrc] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const label = targetLabel(item)

  /**
   * 写库：附件 / 来源**一次调用**提交（后端按 content 字段合并，不会清掉题干）。
   *
   * ⚠️ 只提交附件，**绝不带 answer**（思傅 2026-10-26 修「答案存不上」）：
   * 旧实现在加/删附件时把组件里的 `text` 一起写回，而此时 `text` 还是进编辑态前的旧值
   * ——用户刚在框里改的答案会被自己加的一张图片覆盖掉，随后「保存修改」写进去的也是旧内容。
   */
  const persistAtts = async (nextAtts: AnswerAttachment[]) => {
    setSaving(true)
    try {
      const updated = await saveAnswer(item.id, {
        attachments: nextAtts,
        source: nextAtts.length ? 'manual' : (item.content?.answer_source || 'manual'),
        refs: item.content?.answer_refs,
      })
      onSaved?.(updated)
    } catch (e) {
      console.error('保存答案失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  /** 写库：文本（编辑态走可读形式→LaTeX；预览态直接存库存 LaTeX）。不传 solution，见上 */
  const persistText = async (nextText: string) => {
    setSaving(true)
    try {
      const updated = await saveAnswer(item.id, {
        answer: nextText,
        attachments: atts,
        source: atts.length ? 'manual' : (item.content?.answer_source || 'manual'),
        refs: item.content?.answer_refs,
      })
      onSaved?.(updated)
    } catch (e) {
      console.error('保存答案失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  /** 保存答案文本：编辑态走可读形式→LaTeX 转换，预览态直接存 */
  const saveText = () => {
    if (mode === 'edit') {
      void saveEditing()
    } else {
      void persistText(text)
    }
  }

  /** 进入编辑：把库存 LaTeX 转成用户认识的可读形式——绝不是给用户看源码 */
  const startEdit = () => {
    const readable = latexToReadable(text)
    editingRef.current = readable
    setEditing(readable)
    setMode('edit')
  }

  /** 保存并回到预览：可读形式 → LaTeX 入库 */
  const saveEditing = async () => {
    const latex = readableToLatex(editingRef.current)
    setText(latex)
    setMode('view')
    await persistText(latex)
  }

  /**
   * 数学符号/模板插入答案框：`|` 为插入后光标停留位（模板用）。
   * 在预览态点符号面板会自动进入编辑态（先把已有内容转成可读形式再插入）。
   */
  const insertAnswerSymbol = (snippet: string) => {
    // 延迟一拍：点 chip 会先让 textarea 失焦，带真实 cursor 的 blur 往往晚于
    // chip 的 tap 回调 ⇒ 抢在 blur 前插入会用到上一次打字的光标（思傅 2026-10-29）
    setTimeout(() => {
      const cur = mode === 'edit' ? editingRef.current : latexToReadable(text)
      const pos = caret.position(cur.length)
      const marker = snippet.indexOf('|')
      const plain = snippet.replace('|', '')
      const next = cur.slice(0, pos) + plain + cur.slice(pos)
      editingRef.current = next
      setEditing(next)
      if (mode !== 'edit') setMode('edit')
      caret.request(marker >= 0 ? pos + marker : pos + plain.length, next)
      // 插入后把输入态还回去，否则每插一个符号都要再点一次输入框（思傅 2026-10-29）
      caret.refocus()
    }, 60)
  }

  const addAttachment = async (a: AnswerAttachment) => {
    const next = [...atts, a]
    setAtts(next)
    await persistAtts(next)
  }

  const removeAttachment = async (id: string) => {
    const next = atts.filter((x) => x.id !== id)
    setAtts(next)
    await persistAtts(next)
  }

  // ---------- 图片：拍照/相册 → 裁剪 → 上传 ----------
  const pickImage = async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择图片'))) return
    if (!(await guardPrivacy('选择图片'))) return
    try {
      const res = await Taro.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['camera', 'album'] })
      const p = res.tempFiles?.[0]?.tempFilePath
      if (p) setCropSrc(p)
    } catch (e) {
      reportChooseFail(e, '选择图片')
    }
  }

  const handleCropConfirm = async (tempPath: string) => {
    setCropSrc('')
    Taro.showLoading({ title: '上传中' })
    try {
      const up = await uploadImage(tempPath, { purpose: 'attach' })
      await addAttachment({
        id: newId(),
        type: 'image',
        file_key: up.key,
        thumb_key: up.thumb_key,
        source: 'manual',
        created_at: new Date().toISOString(),
      })
      Taro.showToast({ title: '已加入答案', icon: 'success' })
    } catch (e) {
      console.error('答案图片上传失败', e)
      Taro.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      Taro.hideLoading()
    }
  }

  // ---------- 文档：会话选文件 → 上传 ----------
  const pickDoc = async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择文件'))) return
    if (!(await guardPrivacy('选择文件'))) return
    try {
      const res = await Taro.chooseMessageFile({ count: 1 })
      const f = res.tempFiles?.[0]
      if (!f?.path) return
      Taro.showLoading({ title: '上传中' })
      const up = await uploadFile(f.path, { purpose: 'attach' })
      await addAttachment({
        id: newId(),
        type: 'doc',
        file_key: up.key,
        name: f.name || '附件',
        size: f.size,
        source: 'manual',
        created_at: new Date().toISOString(),
      })
      Taro.showToast({ title: '已加入答案', icon: 'success' })
    } catch (e) {
      // 选择阶段就失败（含隐私未声明）与上传失败共用这个 catch：
      // 取消 → 静默；隐私未声明 → 明确提示；其余 → 按上传失败提示
      reportChooseFail(e, '选择文件', '上传失败，请重试')
    } finally {
      Taro.hideLoading()
    }
  }

  // ---------- 资料库 ----------
  const handlePickLibrary = async (doc: { id: string; name: string; file_key: string; mime_type?: string | null; size_bytes?: number | null }) => {
    setPickerOpen(false)
    await addAttachment({
      id: newId(),
      type: (doc.mime_type || '').startsWith('image/') ? 'image' : 'doc',
      file_key: doc.file_key,
      name: doc.name,
      size: doc.size_bytes ?? undefined,
      source: 'library',
      ref_id: doc.id,
      created_at: new Date().toISOString(),
    })
    Taro.showToast({ title: '已加入答案', icon: 'success' })
  }

  // ---------- 联网搜题 / 知识库 / AI 解题（思傅 2026-10-23：三者彻底拆开，不再混为「联网搜答案」） ----------
  // 联网搜题 = 只做真实网络检索，直接给来源摘要+链接，不喂给 AI
  // 知识库   = 只检索 ima 知识库（秒级），直接给命中条目+高亮内容，不喂给 AI
  // AI 解题   = 只做模型推理，不检索，结果明确标注「未联网核实」
  const handleSearch = async (searchMode: 'search' | 'kb' | 'ai') => {
    const searchLabel = searchMode === 'search' ? '联网搜题' : searchMode === 'kb' ? '资料库检索' : 'AI 解题'
    // R-合规-02：联网搜题 / AI 解题都往外部发内容，未开启时后端会 403 AI_DISABLED，
    // 这里先拦一次是为了给出「去哪开」的提示，而不是让用户撞一个看不懂的报错。
    //
    // ⚠️ kb（资料库检索）**不受 AI 开关约束**（思傅 2026-11-03）：它只去用户自己的
    //    ima 知识库找，不做 AI 生成，被「AI 与在线检索」连坐是误伤。但题干确实会
    //    发到腾讯 ima ⇒ 仍需监护人已同意隐私政策（guardPolicy 兜这道）。
    if (searchMode === 'kb') {
      if (!(await guardPolicy('检索公共资料库'))) return
    } else if (!(await ensureAiSetting())) {
      Taro.showToast({ title: AI_DISABLED_HINT, icon: 'none' })
      return
    }
    setSearching(searchMode)
    setCandidate(null)
    // ⚠️ 这三条通道实测 60~135s（联网搜题最久），必须给等待反馈——
    //    否则用户看到的是一个没有任何变化的页面，只会认为「坏了」然后反复点。
    //    反复点又会撞上后端的并发闸门（429），观感更差。
    Taro.showLoading({ title: `${searchLabel}中…`, mask: true })
    let shownAt = 0
    // P-016 / D-019：微信下 showToast 与 showLoading 共用同一个实例，
    // try/catch 里先弹 toast、finally 立刻 hideLoading ⇒ 提示会被抢关，
    // 用户连「失败原因」都看不到。统一收进变量，等 hideLoading 之后再弹。
    let pendingToast = ''
    try {
      const res = await searchAnswer(item.id, false, searchMode, {
        onProgress: ({ waitedMs }) => {
          // 节流：每 10s 才换一次文案，避免频繁改 title 造成闪烁
          const sec = Math.round(waitedMs / 1000)
          if (sec >= shownAt + 10) {
            shownAt = sec
            Taro.showLoading({ title: `${searchLabel}中…已等待 ${sec}s`, mask: true })
          }
        },
        shouldAbort: () => unmountedRef.current,
      })
      setCandidate(res)
      // source='none' 的如实告知已由常驻结果卡片承载，不再依赖转瞬即逝的 toast
    } catch (e) {
      // 面板已卸载 ⇒ 不是失败，静默收尾（弹 toast 会出现在别的页面上）
      if (isJobAborted(e) || unmountedRef.current) return
      console.error(`${searchLabel}失败`, e)
      const msg = e instanceof Error ? e.message : ''
      pendingToast = msg.slice(0, 30) || `${searchLabel}失败，请稍后重试`
    } finally {
      Taro.hideLoading()
      setSearching(null)
      if (pendingToast) Taro.showToast({ title: pendingToast, icon: 'none', duration: 2500 })
    }
  }

  // P-015 / D-018：参考例题与原题答案并列，只作展示，不冒充本题答案
  const hasRefs = !!candidate && (candidate.references?.length ?? 0) > 0

  // P-006 / D-009：同主题资料不是这道题的答案，禁止写进题库。
  // 前端隐藏「采纳」按钮 + 保存前再拦一道（双保险），异常返回也拦得住。
  // 🔴 P-015：即使结构将来变化，只要带 references 就一律不给「采纳」。
  const canAdopt = !!candidate && candidate.match_level !== 'topic' && candidate.match_level !== 'none' && !hasRefs

  const handleAdopt = async () => {
    if (!candidate) return
    if (!canAdopt) {
      Taro.showToast({ title: '非本题答案，不能采纳', icon: 'none' })
      return
    }
    setSaving(true)
    try {
      const updated = await saveAnswer(item.id, {
        answer: candidate.answer,
        solution: candidate.solution,
        attachments: atts,
        refs: candidate.refs,
        // netdisk 命中运营者提供的公共资料库 ⇒ 记 library（与「从资料库插入」同源），
        // 不要落到 mixed：mixed 是「检索+手工混合」的意思，会造成来源统计失真
        source:
          candidate.source === 'netdisk'
            ? 'library'
            : candidate.source === 'search' || candidate.source === 'kb'
              ? 'search'
              : 'mixed',
      })
      setText(candidate.answer)
      setCandidate(null)
      // 采纳后回到预览态：立刻看到渲染后的数学式
      setMode('view')
      // 通知调用方刷新自己的编辑框（详情页把答案与解题过程合并成一个框了）
      onAdopt?.(candidate.answer, candidate.solution || '')
      onSaved?.(updated)
      Taro.showToast({ title: '已采纳', icon: 'success' })
    } catch (e) {
      console.error('采纳失败', e)
      Taro.showToast({ title: '采纳失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const btn = 'flex flex-row items-center gap-1 px-[10px] py-[6px] rounded-lg border border-border'

  return (
    <View className="mb-4">
      {/* 目标锚：常驻提示，防止把答案加错题 */}
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="block text-xs text-muted-foreground">{hideTextBox ? '答案附件 · 搜题' : '正确答案'}</Text>
        <Text className="block text-xs" style={{ color: BRAND_TEXT }}>
          答案将存入：{label}
        </Text>
      </View>

      {/* 详情页由页面统管「答案 + 解题过程」合并编辑框，这里不再重复渲染输入框 */}
      {hideTextBox ? null : (
        <>
          <MathSymbolBar
            onInsert={insertAnswerSymbol}
            preview={mode === 'view'}
            onTogglePreview={() => { if (mode === 'view') startEdit(); else void saveEditing() }}
          />
          {mode === 'view' ? (
            /* 预览态：把 LaTeX 渲染成数学式（不支持的语法自动回退源码）；点一下进入编辑 */
            <View
              className="w-full rounded-xl border border-border p-3"
              style={{ minHeight: 72, backgroundColor: '#fff' }}
              onClick={() => startEdit()}
            >
              {text.trim() ? (
                <MathText text={text} />
              ) : (
                <Text className="block text-sm text-muted-foreground">（暂无答案内容，点此输入）</Text>
              )}
            </View>
          ) : (
            <Textarea
              className="w-full rounded-xl border border-border p-3 text-sm"
              style={{ minHeight: 72, backgroundColor: '#fff' }}
              // 与 ui/textarea 保持同一套手机输入手感（思傅 2026-10-31）：
              // 光标离键盘 24px、键盘上方留「完成」栏、键盘弹起时页面上推。
              // 这里不启用 autoHeight —— 它挂在底部弹层里，长高会和弹层高度打架。
              cursorSpacing={24}
              showConfirmBar
              adjustPosition
              placeholder="输入正确答案（1/2、√3、x² 等写法即可，或点上方符号面板）"
              value={editing}
              maxlength={-1}
              cursor={caret.cursor}
              focus={caret.focus}
              // ⚠️ 打字只写 ref，不 setState（否则每打一个字页面就 setData 一次，
              //    原生 textarea 按 value 重建文本、光标落末尾 —— 第十轮的根因）
              // ⚠️ 必须当场 setState：下发的 value 只有等于原生文本，微信才不动光标
              onInput={(e) => { setEditing(e.detail.value); editingRef.current = e.detail.value; caret.track(e.detail.cursor, e.detail.value) }}
              // 手指点选位置不产生 input 事件，靠 blur/focus 的 detail.cursor 补记
              // （否则符号会插到上一次打字处，思傅 2026-10-29）
              onBlur={(e) => {
                setEditing(editingRef.current)
                caret.blur((e.detail as { cursor?: number } | undefined)?.cursor)
              }}
              onFocus={(e) => caret.track((e.detail as { cursor?: number } | undefined)?.cursor)}
            />
          )}
        </>
      )}

      {/* 附件列表 */}
      {atts.length ? (
        <View className="flex flex-row flex-wrap gap-2 mt-2">
          {atts.map((a) => {
            const shown = (a as AnswerAttachment & { url?: string; thumb_url?: string })
            const src = shown.thumb_url || shown.url
            return (
              <View key={a.id} className="relative" style={{ width: 76 }}>
                <View className="w-full rounded-lg overflow-hidden border border-border" style={{ height: 76 }}>
                  {a.type === 'image' && src ? (
                    <TaroImage
                      src={src}
                      mode="aspectFill"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => Taro.previewImage({ urls: [src], current: src })}
                    />
                  ) : a.type === 'text' ? (
                    <View className="w-full h-full p-1 flex items-center justify-center bg-muted">
                      <Text className="block text-xs text-center">
                        {(a.text || '').slice(0, 20)}
                      </Text>
                    </View>
                  ) : (
                    <View className="w-full h-full flex flex-col items-center justify-center bg-muted">
                      <FileText size={18} color={INK} />
                      <Text className="block text-xs mt-1 px-1 text-center" numberOfLines={1}>
                        {a.name || '资料'}
                      </Text>
                    </View>
                  )}
                </View>
                <View
                  className="absolute"
                  style={{ right: -4, top: -4 }}
                  onClick={() => void removeAttachment(a.id)}
                >
                  <Trash2 size={14} color={DANGER} />
                </View>
              </View>
            )
          })}
        </View>
      ) : null}

      {/* 操作按钮 */}
      <View className="flex flex-row flex-wrap gap-2 mt-2">
        <View className={btn} onClick={() => void pickImage()}>
          <Plus size={12} color={INK} />
          <Text className="block text-xs">图片</Text>
          <Crop size={10} color="#9A948A" />
        </View>
        <View className={btn} onClick={() => void pickDoc()}>
          <Plus size={12} color={INK} />
          <Text className="block text-xs">资料</Text>
        </View>
        <View className={btn} onClick={() => setPickerOpen(true)}>
          <FileText size={12} color={INK} />
          <Text className="block text-xs">资料库</Text>
        </View>
        {/* 资料库搜题：先查运营者提供的公共资料库（文件名/路径 + 资料正文双通道），未命中再查 ima 知识库；
            全程只检索、不生成内容、不喂给 AI。
            ⚠️ 不受 AI_PUBLIC_ENTRY 约束（思傅 2026-11-03 反馈「从我的资料库搜答案没了」）：
            它跟「AI 解题」不是一回事，被一起收起属于误伤。 */}
        <View className={btn} onClick={() => { if (!searching) void handleSearch('kb') }}>
          <BookOpen size={12} color={INK} />
          <Text className="block text-xs">{searching === 'kb' ? '检索中…' : '资料库搜题'}</Text>
        </View>
        {/* 联网搜题 / AI 解题：这两条确实往外部发内容且含 AI 生成，
            个人主体不开放（见 constants/app-info.ts），此处直接不渲染入口。 */}
        {AI_PUBLIC_ENTRY && (
          <>
            {/* 联网搜题：只做真实网络检索，不喂给 AI */}
            <View className={btn} onClick={() => { if (!searching) void handleSearch('search') }}>
              <Globe size={12} color={INK} />
              <Text className="block text-xs">{searching === 'search' ? '检索中…' : '联网搜题'}</Text>
            </View>
            {/* AI 解题：只做模型推理，不检索 */}
            <View className={btn} onClick={() => { if (!searching) void handleSearch('ai') }}>
              <Bot size={12} color={INK} />
              <Text className="block text-xs">{searching === 'ai' ? '解题中…' : 'AI 解题'}</Text>
            </View>
          </>
        )}
        {/* 保存：仅编辑态需要（预览态内容即已入库内容；附件操作都是即时保存） */}
        {mode === 'edit' ? (
          <View
            className="flex flex-row items-center gap-1 px-3 py-1 rounded-lg"
            style={{ backgroundColor: saving ? '#E8E2D9' : BRAND }}
            onClick={() => { if (!saving) saveText() }}
          >
            <Text className="block text-xs" style={{ color: BRAND_FOREGROUND }}>{saving ? '保存中' : '保存'}</Text>
          </View>
        ) : null}
      </View>

      {/* 搜到的候选答案：必须「采纳」才入库。
          🔴 P-016 / D-019：source='none' 也要渲染 —— 旧实现把「没找到 / 请单独录入小题」
          只塞进一个转瞬即逝的 toast，用户观感就是「点了资料库搜题什么都没有」。
          如实告知必须常驻（GK-SRS-20a M11：告知不是拦截）。 */}
      {candidate ? (
        <View className="mt-3 rounded-xl border p-3" style={{ borderColor: candidate.verified ? 'rgba(16, 185, 129, 0.25)' : '#E8A33D', backgroundColor: candidate.verified ? 'rgba(16, 185, 129, 0.08)' : 'rgba(232,163,61,0.08)' }}>
          <View className="flex flex-row items-center justify-between mb-1">
            <Text className="block text-xs font-semibold" style={{ color: candidate.source === 'llm' ? '#B4761F' : BRAND_TEXT }}>
              {candidate.source === 'none'
                ? '这次没有可用结果'
                : candidate.source === 'search'
                  ? `网络检索结果（${candidate.refs.length} 条来源）`
                  : candidate.source === 'netdisk' || candidate.source === 'kb'
                  // P-006 / D-009：按原题判定分档，netdisk 与 kb 一视同仁——
                  // ima 语义检索命中也可能只是同专题不同题，不得无条件叫「资料库检索结果」。
                  // 未带 match_level 的旧契约仍走原文案，避免老结果显示成「没找到」。
                  ? hasRefs
                    ? '没找到原题答案 · 以下是解题思路相近的例题'
                    : candidate.match_level === 'exact'
                      ? '找到这道题的参考答案'
                      : candidate.match_level === 'topic'
                        ? '没找到这道题的答案，以下是同主题资料'
                        : `资料库检索结果（${candidate.refs.length} 条）`
                  : candidate.source === 'llm'
                    // 显式标识「AI 生成」：《人工智能生成合成内容标识办法》要求
                    // 面向公众提供的 AI 生成内容须在界面上可识别。原文案只写
                    // 「AI 推理结果」，未落到「生成内容」这一法定表述。
                    ? 'AI 生成内容（未联网核实，请核对后再用）'
                    : '结果'}
            </Text>
            <X size={14} color="#9A948A" onClick={() => setCandidate(null)} />
          </View>
          {/* P-016 / D-019：如实告知常驻且排在最前。source='none' 时这是卡片里唯一的内容，
              不能只靠 toast；有参考例题时也让「请单独录入小题」先于任何学习内容。 */}
          {candidate.note ? (
            <View className="mb-2 rounded-lg p-2" style={{ backgroundColor: 'rgba(232,163,61,0.10)' }}>
              <Text className="block text-xs" style={{ color: '#8A5A12' }}>{candidate.note}</Text>
            </View>
          ) : null}
          {/* P-015 / D-018：事先声明 —— 必须排在任何参考内容（以及本题 answer）之前渲染。
              服务端字段缺失时用前端逐字镜像兜底，绝不出现「先给内容、后给声明」。 */}
          {hasRefs ? (
            <View className="mb-2 rounded-lg p-2" style={{ borderColor: '#E8A33D', borderWidth: 1, backgroundColor: 'rgba(232,163,61,0.14)' }}>
              <Text className="block text-xs font-semibold mb-1" style={{ color: '#8A5A12' }}>事先声明</Text>
              <Text className="block text-xs" style={{ color: '#8A5A12' }}>
                {candidate?.reference_disclaimer || REFERENCE_DISCLAIMER}
              </Text>
            </View>
          ) : null}
          {/* P-015 / D-018：参考例题。题目与解题过程均来自资料库里**同一道**原题，
              服务端同源配对、带来源位置；这里只展示，不写进本题答案、不提供采纳。 */}
          {hasRefs ? (
            <View className="mb-2">
              {candidate?.references?.map((r, i) => {
                const open = !!expandedRefs[i]
                const stem = open ? r.stem : r.stem.slice(0, 220) + (r.stem.length > 220 ? '…' : '')
                const sol = open ? r.solution : r.solution.slice(0, 400) + (r.solution.length > 400 ? '…' : '')
                return (
                  <View
                    key={`${r.sourceId}-${r.objectIndex}-${i}`}
                    className="mb-2 rounded-lg border p-2"
                    style={{ borderColor: 'rgba(11,122,85,0.18)', backgroundColor: '#FFFFFF' }}
                  >
                    <Text className="block text-xs font-medium mb-1" style={{ color: '#8A5A12' }}>
                      注意：{REFERENCE_ITEM_HINT}
                    </Text>
                    <Text className="block text-xs font-semibold" style={{ color: BRAND_TEXT }}>例题 {i + 1} · 题目</Text>
                    <Text className="block text-xs mb-1" style={{ color: INK }}>{stem}</Text>
                    <Text className="block text-xs font-semibold" style={{ color: BRAND_TEXT }}>解题过程</Text>
                    <Text className="block text-xs mb-1" style={{ color: INK }}>{sol}</Text>
                    <View onClick={() => setExpandedRefs((v) => ({ ...v, [i]: !v[i] }))}>
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>
                        {open ? '收起' : '展开完整题目与解析'}
                      </Text>
                    </View>
                    <Text className="block text-xs text-muted-foreground mt-1">
                      来源：{r.sourceName || '运营者提供的公共资料库'} · {r.label ? `题号 ${r.label}` : `第 ${r.objectIndex + 1} 题`}
                    </Text>
                    <Text className="block text-xs text-muted-foreground">
                      思路相近的依据：{r.sharedSignals.join('、')}
                    </Text>
                  </View>
                )
              })}
            </View>
          ) : null}
          {/* 搜到的答案/解析常含 LaTeX，用 MathText 渲染成数学式（思傅 2026-10-22） */}
          {candidate.answer ? (
            <View className="mb-1">
              <MathText text={candidate.answer.slice(0, 300)} size={14} />
            </View>
          ) : null}
          {/* P-006：topic 的 solution 是文件名清单，不是解题过程，不在这里当正文渲染；
              下方「参考来源」区会把它列成可点开的列表 */}
          {candidate.solution && candidate.match_level !== 'topic' ? (
            <View className="mb-2">
              <MathText text={candidate.solution.slice(0, 200)} size={12} color="#7A736A" />
            </View>
          ) : null}
          {/* P3 / P-012 / D-015：来源卡片。只在 exact 展示 —— topic/none 一律不展示，
              否则等于给「没找到原题」的结果背书。只渲染已有的 source_location，
              不新增答案内容、不做自动跳题；「题干 A + 别人解析」的残余风险仍在，
              家长必须能按题号回原文核对（报告 §8.4 / §8.5 第 3 条）。 */}
          {candidate.match_level === 'exact' && candidate.source_location ? (
            <View className="mb-2 rounded-lg border p-2" style={{ borderColor: 'rgba(11,122,85,0.18)', backgroundColor: 'rgba(11,122,85,0.04)' }}>
              <Text className="block text-xs font-medium mb-1" style={{ color: BRAND_TEXT }} numberOfLines={2}>
                来源：{candidate.source_location.source_name || '运营者提供的公共资料库'}
              </Text>
              <Text className="block text-xs text-muted-foreground">
                {candidate.source_location.label
                  ? `题号 ${candidate.source_location.label}`
                  : `第 ${candidate.source_location.object_index + 1} 题`}
                {candidate.source_location.char_start >= 0
                  ? ` · 原文第 ${candidate.source_location.char_start}–${candidate.source_location.char_end} 字`
                  : ''}
              </Text>
              <Text className="block text-xs text-muted-foreground mt-1">
                请打开文件核对原题与解析后采纳
              </Text>
            </View>
          ) : null}
          {/* 参考来源：联网搜题的价值就在这——点一下复制链接去浏览器看原文；
              知识库条目没有外链，只列表展示 */}
          {candidate.refs.length ? (
            <View className="mb-2">
              <Text className="block text-xs text-muted-foreground mb-1">
                {candidate.match_level === 'topic'
                  ? '同主题资料'
                  : candidate.source === 'kb'
                    ? '相关知识库条目'
                    : candidate.source === 'netdisk'
                      ? '相关资料文件'
                      : '参考来源（点击复制链接）'}
              </Text>
              {candidate.refs.map((r, i) => (
                <View
                  key={`${r.url || r.title}-${i}`}
                  className="flex flex-row items-center mb-1"
                  onClick={() => {
                    if (!r.url) return // 知识库条目无外链
                    Taro.setClipboardData({ data: r.url })
                    Taro.showToast({ title: '链接已复制', icon: 'none' })
                  }}
                >
                  <Text className="block text-xs mr-1" style={{ color: BRAND_TEXT }}>{i + 1}.</Text>
                  <Text className="flex-1 block text-xs" style={{ color: BRAND_TEXT }} numberOfLines={1}>
                    {r.title || r.url}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <View className="flex flex-row gap-2">
            {/* 🔴 P-006：topic 只找到同主题资料 ⇒ 不提供「采纳」，
                避免把别的题的解析写进本题答案（handleAdopt 里还有第二道拦截） */}
            {canAdopt ? (
              <View
                className="flex flex-row items-center gap-1 px-3 py-1 rounded-lg"
                style={{ backgroundColor: BRAND }}
                onClick={() => void handleAdopt()}
              >
                <Check size={12} color={BRAND_FOREGROUND} />
                <Text className="block text-xs" style={{ color: BRAND_FOREGROUND }}>采纳</Text>
              </View>
            ) : null}
            <View
              className="px-3 py-1 rounded-lg border border-border"
              onClick={() => setCandidate(null)}
            >
              <Text className="block text-xs text-muted-foreground">放弃</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* 裁剪编辑器：cropTargetLabel 明示目标，防止裁给错的题 */}
      <ImageEditor
        visible={!!cropSrc}
        src={cropSrc}
        cropOnly
        enableSaveToInbox={false}
        confirmText="用作答案图"
        cropTargetLabel={`答案将存入：${label}`}
        onCancel={() => setCropSrc('')}
        onConfirm={(p) => void handleCropConfirm(p)}
      />

      <MaterialPicker
        visible={pickerOpen}
        title="从资料库选为答案"
        onClose={() => setPickerOpen(false)}
        onSelect={(d) => void handlePickLibrary(d)}
      />
    </View>
  )
}
