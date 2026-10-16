import { View, Text, ScrollView, Image as TaroImage, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState, useEffect, useRef } from 'react'
import { Crop, Wand, Sparkles, Eraser } from 'lucide-react-taro'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import SegmentedTabs from '@/components/segmented-tabs'
import ImageEditor from '@/components/image-editor'
import MaterialPicker from '@/components/material-picker'
import WrongqBoxEditor, { type BoxEditorItem, type PageBox } from '@/components/wrongq-box-editor'
import WrongqTextPanel, { type TextPanelDraft } from '@/components/wrongq-text-panel'
import WrongqOcrPanel from '@/components/wrongq-ocr-panel'
import {
  fetchSubjects, recognizePaper, recognizeSeparate, recognizeDocument,
  recognizeDocumentByUrl, uploadImage, saveQuestionAsImage, exportRecognizedDocx, createTimelineBatch,
  recropWrongBlock, ocrPage, exportBoardDocx,
  type Subject, type RecognizeResult, type LibraryDoc, type ImageAction, type WrongBlockSummary, type PageTextSegment, type BoardExportItem,
} from '@/services/api'
import { openStorageFile } from '@/services/net'

type Mode = 'paper' | 'split' | 'doc'

interface Draft extends RecognizeResult {
  subject_id: string
  /** 题面图 file_key（保存时挂 question_images） */
  question_image_keys?: string[]
  /** 答题卡/答案图 file_key（保存时挂 answer_images） */
  answer_image_keys?: string[]
  /** P2：系统块 id（叠加视图指认；负值=无对应系统块；paper/doc 模式无此字段） */
  block_id?: number
  /** P2：系统原框（用户改框基线，回传 IoU 用） */
  system_box?: PageBox
}

// ---------- #150 人工辅助错题整理（替代 split 自动识别的主流程） ----------

/** 粘贴栏的一道题：文本（长按粘贴 OCR 拷贝 / 手动输入）+ 手动裁剪的图片组 */
interface BoardEntry {
  id: number
  text: string
  images: { url: string; key: string }[]
}

/** 一个来源页：上传的页面图 + 全页 OCR 结果（url 为摆正后图片，展示/裁剪基准） */
interface BoardPage {
  id: number
  url: string
  w: number
  h: number
  segments: PageTextSegment[]
  ocr: 'busy' | 'done' | 'error'
}

/** 人工整理流程的上限（防滥用 + 控导出体积） */
const MAX_BOARD_PAGES = 9
const MAX_BOARD_ENTRIES = 30
const MAX_ENTRY_IMAGES = 9

export default function RecognizePage() {
  const [mode, setMode] = useState<Mode>(() => (Taro.getStorageSync('recog_mode') || 'paper') as Mode)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [defaultSubject, setDefaultSubject] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(false)
  const [paperImage, setPaperImage] = useState('')
  const [questionImage, setQuestionImage] = useState('')
  const [answerImage, setAnswerImage] = useState('')
  const [docFile, setDocFile] = useState('')
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 图片编辑器：{ slot, src, autoAction }
  const [editor, setEditor] = useState<{ slot: 'paper' | 'question' | 'answer'; src: string; autoAction?: ImageAction | null } | null>(null)

  const [picker, setPicker] = useState(false)

  // P2 叠加视图：页面尺寸 / 题面图 URL / 全部系统块 / 编辑器开关 / 重切中
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 })
  const [questionUrl, setQuestionUrl] = useState('')
  const [sysBlocks, setSysBlocks] = useState<WrongBlockSummary[]>([])
  const [showEditor, setShowEditor] = useState(false)
  const [recropBusy, setRecropBusy] = useState(false)
  // P3 全页 OCR 文本（阅读序）：选择粘贴面板数据源
  const [pageText, setPageText] = useState<PageTextSegment[]>([])
  const [textBusy, setTextBusy] = useState(false)
  /** 新画框草稿的合成 id（单调递减，避开系统块正 id 与删除后的序号复用） */
  const synthIdRef = useRef(0)

  // ---------- #150 人工辅助错题整理状态 ----------
  const [boardPages, setBoardPages] = useState<BoardPage[]>([])
  const [activePage, setActivePage] = useState(0)
  const [board, setBoard] = useState<BoardEntry[]>([])
  const [boardBusy, setBoardBusy] = useState(false)
  /** 页内裁剪编辑器：{ src, entryIdx }——裁出的图进入指定题目 */
  const [cropEditor, setCropEditor] = useState<{ src: string; entryIdx: number } | null>(null)
  const boardIdRef = useRef(0)

  // 进入错题提取模式时给一条空题目，降低「从哪开始」的迷茫（用户删光后不补）
  useEffect(() => {
    if (mode === 'split' && board.length === 0) {
      setBoard([{ id: ++boardIdRef.current, text: '', images: [] }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    Taro.removeStorageSync('recog_mode')
  }, [])

  const ensureSubjects = async () => {
    if (subjects.length === 0) {
      const list = await fetchSubjects()
      setSubjects(list)
      setDefaultSubject(list[1]?.id || list[0]?.id || '')
      return list
    }
    return subjects
  }

  const chooseImage = async (slot: 'paper' | 'question' | 'answer') => {
    try {
      const res = await Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
      })
      setEditor({ slot, src: res.tempFiles[0].tempFilePath })
    } catch {
      // 用户取消
    }
  }

  const openEditorWithAction = (slot: 'paper' | 'question' | 'answer', action: ImageAction) => {
    if (slot === 'paper' && paperImage) setEditor({ slot, src: paperImage, autoAction: action })
    else if (slot === 'question' && questionImage) setEditor({ slot, src: questionImage, autoAction: action })
    else if (slot === 'answer' && answerImage) setEditor({ slot, src: answerImage, autoAction: action })
    else Taro.showToast({ title: '请先选择图片', icon: 'none' })
  }

  const handleEditorConfirm = (path: string) => {
    const slot = editor?.slot
    setEditor(null)
    if (!slot) return
    // 回填到对应 slot，供后续「开始识别 / 直接保存」复用编辑结果（不在此落库）
    if (slot === 'paper') setPaperImage(path)
    else if (slot === 'question') setQuestionImage(path)
    else setAnswerImage(path)
  }

  const handleRecognizePaper = async () => {
    if (!paperImage) {
      Taro.showToast({ title: '请先拍照或选择图片', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizePaper(paperImage, sid)
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // #150 暂停区：「双图自动识别」链路（handleLink 及下方改框/选择粘贴相关 handler）。
  // 用户决策（2026-10）：自动错题检测的查准率不达标（四页作业实测大量误报/漏报/
  // 位置错），自动提取推迟到项目后期实现；人工辅助流程（OCR 文本栏 + 粘贴栏）
  // 已替代为主入口。以下代码保留、无 UI 调用，待检测效果达标后在 split 模式恢复。
  // ════════════════════════════════════════════════════════════════════════

  const handleLink = async () => {
    if (!questionImage || !answerImage) {
      Taro.showToast({ title: '题目图和答案图都需上传', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const res = await recognizeSeparate(questionImage, answerImage)
      // P2：item ↔ 系统块按框配对（同一次响应的两块列表，框一致即同一块）
      const blockIdOf = (r: RecognizeResult): number => {
        if (!r.box) return -1
        const hit = (res.blocks || []).find(
          (b) => b.box.x0 === r.box!.x0 && b.box.y0 === r.box!.y0 && b.box.x1 === r.box!.x1 && b.box.y1 === r.box!.y1,
        )
        return hit?.id ?? -1
      }
      setDrafts(
        res.matched.map((r) => ({
          ...r,
          subject_id: sid,
          question_image_keys: r.question_image_keys,
          // 切块流程：每题自带 answer_image_keys（按题号关联后的答案图）；缺省回退整份答案图
          answer_image_keys: r.answer_image_keys && r.answer_image_keys.length ? r.answer_image_keys : res.answer_image_keys,
          block_id: blockIdOf(r),
          system_box: r.box,
        })),
      )
      setUnmatched(res.unmatched_questions)
      setPageSize(res.page)
      setQuestionUrl(res.question_url)
      setSysBlocks(res.blocks)
      setPageText(res.page_text || [])
      setShowEditor(true)
      Taro.showToast({ title: `已关联 ${res.matched.length} 题`, icon: 'none' })
    } catch (e) {
      console.error('关联失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '关联失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }
  // 保留 handler 供后续恢复（当前无 UI 调用，占位以通过 noUnusedLocals 检查）
  void handleLink

  // 从资料库选择后按 URL 识别
  const handleSelectDoc = async (d: LibraryDoc) => {
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setDocFile(d.name)
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizeDocumentByUrl(d.url || '', sid)
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('资料识别失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '识别失败，请重试', icon: 'none' })
    } finally {
      setLoading(false)
    }
  }

  // 最近题目里的图片 → 按 URL 整卷识别（供未来从收件箱直接识别复用）
  // 目前入口：资料库选文档；图片识别走拍照/相册

  const pickDoc = async (cb: (path: string, name: string) => void) => {
    try {
      const res = await Taro.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['pdf', 'doc', 'docx', 'txt'],
      })
      const f = res.tempFiles[0]
      cb(f.path, f.name || '')
    } catch {
      Taro.showToast({ title: '请在微信小程序中从聊天/文件中选择文档', icon: 'none' })
    }
  }

  const handleRecognizeDoc = async () => {
    if (!docFile) {
      Taro.showToast({ title: '请先选择文档文件', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setLoading(true)
    setDrafts([])
    setUnmatched([])
    try {
      const result = await recognizeDocument(docFile, sid)
      setDrafts(result.map((r) => ({ ...r, subject_id: sid })))
      Taro.showToast({ title: `识别到 ${result.length} 道题`, icon: 'none' })
    } catch (e) {
      console.error('文档识别失败', e)
      Taro.showToast({
        title: e instanceof Error ? e.message : '文档识别失败，请确认内容为文字',
        icon: 'none',
      })
    } finally {
      setLoading(false)
    }
  }

  const updateDraft = (idx: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx))
  }

  // ---- P2：叠加视图改框 ----

  /** 拖动/缩放过程：只同步框（视觉），不触发请求 */
  const handleBoxPreview = (id: number, box: PageBox) => {
    setDrafts((prev) => prev.map((d) => (d.block_id === id ? { ...d, box } : d)))
  }

  /**
   * 手势结束：按用户框重切重识（后端与 extract-wrong 同一链路）。
   *  - id 命中已有草稿 → 更新该题（system_box 回传 IoU）；
   *  - id 命中系统未收录块 / id=null 新框 → 识别后追加为新草稿。
   * 保存以用户框为准：草稿的 question_content/question_image_keys 均换成新框结果。
   */
  const handleBoxCommit = async (id: number | null, box: PageBox) => {
    if (!questionUrl || recropBusy) return
    const existing = id != null ? drafts.find((d) => d.block_id === id) : undefined
    const sysBox = existing?.system_box ?? (id != null ? sysBlocks.find((b) => b.id === id)?.box : undefined)
    const label = existing?.question_label ?? sysBlocks.find((b) => b.id === id)?.question_label
    setRecropBusy(true)
    try {
      const rc = await recropWrongBlock({
        image_url: questionUrl,
        box,
        system_box: sysBox,
        question_label: label,
        answer_content: existing?.answer_content || '',
        answer_image_keys: existing?.answer_image_keys || [],
      })
      if (existing) {
        setDrafts((prev) =>
          prev.map((d) =>
            d.block_id === id
              ? {
                  ...d,
                  question_content: rc.item.question_content,
                  question_image_keys: rc.item.question_image_keys,
                  wrong_answer: rc.item.wrong_answer || d.wrong_answer,
                  solution: rc.item.solution || d.solution,
                  stem: rc.item.stem || d.stem,
                  answer_content: rc.item.answer_content || d.answer_content,
                  has_answer: !!rc.item.answer_content,
                  answer_image_keys: rc.item.answer_image_keys?.length ? rc.item.answer_image_keys : d.answer_image_keys,
                  box,
                }
              : d,
          ),
        )
        Taro.showToast({ title: '已按新框重新识别', icon: 'success' })
      } else {
        const subs = await ensureSubjects()
        const sid = defaultSubject || subs[1]?.id || subs[0]?.id
        setDrafts((prev) => [
          ...prev,
          {
            ...rc.item,
            subject_id: sid,
            question_image_keys: rc.item.question_image_keys,
            answer_image_keys: rc.item.answer_image_keys || [],
            block_id: id ?? --synthIdRef.current,
            system_box: sysBox,
          },
        ])
        Taro.showToast({ title: '已添加这道题', icon: 'success' })
      }
    } catch (e) {
      console.error('改框重识失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '重新识别失败，请重试', icon: 'none' })
    } finally {
      setRecropBusy(false)
    }
  }

  /** 长按删除：移除草稿（系统块仍在叠加视图显示为「未收录」，可再次长按添加） */
  const handleBoxDelete = (id: number) => {
    setDrafts((prev) => prev.filter((d) => d.block_id !== id))
    Taro.showToast({ title: '已删除，可长按原框重新添加', icon: 'none' })
  }

  // ---- P3：全页 OCR 文本面板（选择粘贴 / 导出所选） ----

  /** 所选片段粘贴到某题题干/答案（追加在末尾，空行分隔） */
  const handleTextPaste = (draftIdx: number, field: 'question' | 'answer', text: string) => {
    const d = drafts[draftIdx]
    if (!d || !text.trim()) return
    const prev = field === 'question' ? d.question_content : d.answer_content
    const next = prev.trim() ? `${prev.trim()}\n${text.trim()}` : text.trim()
    if (field === 'question') {
      updateDraft(draftIdx, { question_content: next })
    } else {
      updateDraft(draftIdx, { answer_content: next, has_answer: true })
    }
    Taro.showToast({ title: `已粘贴到${field === 'question' ? '题干' : '答案'}`, icon: 'success' })
  }

  /** 仅导出所选片段：合成一条草稿走既有导出链路（不入库，只出 Word） */
  const handleExportSelected = async (text: string) => {
    if (!text.trim()) return
    setTextBusy(true)
    try {
      const synth: RecognizeResult = {
        question_content: text.trim(),
        wrong_answer: '',
        answer_content: '',
        solution: '',
        source: '',
        has_answer: false,
      }
      const res = await exportRecognizedDocx([synth], `OCR 片段导出 · ${new Date().toLocaleDateString('zh-CN')}`)
      Taro.showToast({ title: 'Word 已生成', icon: 'success' })
      if (res?.url) openStorageFile(res.url, false)
    } catch (e) {
      console.error('导出所选失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导出失败，请重试', icon: 'none' })
    } finally {
      setTextBusy(false)
    }
  }

  // ---------- #150 人工辅助错题整理：页面 / OCR / 粘贴栏 ----------

  /** 选择（可多选）作业页图片：上传 → 追加页 → 串行跑全页 OCR（侧车推理串行，避免打满） */
  const addBoardPages = async () => {
    if (boardBusy) return
    const room = MAX_BOARD_PAGES - boardPages.length
    if (room <= 0) {
      Taro.showToast({ title: `最多添加 ${MAX_BOARD_PAGES} 页`, icon: 'none' })
      return
    }
    let files: { tempFilePath: string }[] = []
    try {
      const res = await Taro.chooseMedia({ count: room, mediaType: ['image'], sourceType: ['camera', 'album'] })
      files = res.tempFiles || []
    } catch {
      return // 用户取消
    }
    if (!files.length) return
    setBoardBusy(true)
    const added: BoardPage[] = []
    try {
      for (const f of files) {
        const up = await uploadImage(f.tempFilePath)
        added.push({ id: ++boardIdRef.current, url: up.url, w: 0, h: 0, segments: [], ocr: 'busy' })
      }
    } catch (e) {
      console.error('页面图上传失败', e)
      Taro.showToast({ title: '图片上传失败，请重试', icon: 'none' })
      setBoardBusy(false)
      return
    }
    const firstNew = boardPages.length
    setBoardPages((prev) => [...prev, ...added])
    setActivePage(firstNew)
    // 逐页 OCR：后一页等前一页完成（侧车 _INFER_LOCK 本就串行，客户端再排队只会超时）
    for (const p of added) {
      await runPageOcr(p)
    }
    setBoardBusy(false)
  }

  /** 单页全页 OCR（新增与「重新识别」共用）；失败置 error 态，不抛 */
  const runPageOcr = async (p: BoardPage) => {
    try {
      const r = await ocrPage(p.url)
      setBoardPages((prev) =>
        prev.map((x) =>
          x.id === p.id
            ? { ...x, url: r.image_url || x.url, w: r.page.w, h: r.page.h, segments: r.page_text, ocr: 'done' as const }
            : x,
        ),
      )
    } catch (e) {
      console.error('全页 OCR 失败', e)
      setBoardPages((prev) => prev.map((x) => (x.id === p.id ? { ...x, ocr: 'error' as const } : x)))
    }
  }

  /** 重新识别某一页（OCR 失败重试） */
  const retryPageOcr = async (idx: number) => {
    const p = boardPages[idx]
    if (!p || boardBusy) return
    setBoardBusy(true)
    setBoardPages((prev) => prev.map((x, i) => (i === idx ? { ...x, ocr: 'busy' as const } : x)))
    await runPageOcr(p)
    setBoardBusy(false)
  }

  const switchPage = (i: number) => {
    if (boardBusy || i === activePage) return
    setActivePage(i)
  }

  const addEntry = () => {
    if (board.length >= MAX_BOARD_ENTRIES) {
      Taro.showToast({ title: `最多 ${MAX_BOARD_ENTRIES} 题`, icon: 'none' })
      return
    }
    setBoard((prev) => [...prev, { id: ++boardIdRef.current, text: '', images: [] }])
  }

  const removeEntry = (idx: number) => {
    setBoard((prev) => prev.filter((_, i) => i !== idx))
  }

  const moveEntry = (idx: number, dir: -1 | 1) => {
    setBoard((prev) => {
      const j = idx + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const tmp = next[idx]
      next[idx] = next[j]
      next[j] = tmp
      return next
    })
  }

  const setEntryText = (idx: number, text: string) => {
    setBoard((prev) => prev.map((e, i) => (i === idx ? { ...e, text } : e)))
  }

  const removeEntryImage = (idx: number, imgIdx: number) => {
    setBoard((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, images: e.images.filter((_, j) => j !== imgIdx) } : e)),
    )
  }

  /** 打开页内裁剪编辑器：从当前页图片裁出错题区域，结果进入指定题目 */
  const startCrop = (entryIdx: number) => {
    const page = boardPages[activePage]
    if (!page) {
      Taro.showToast({ title: '请先选择页面图片', icon: 'none' })
      return
    }
    const e = board[entryIdx]
    if (e && e.images.length >= MAX_ENTRY_IMAGES) {
      Taro.showToast({ title: `每题最多 ${MAX_ENTRY_IMAGES} 张图`, icon: 'none' })
      return
    }
    setCropEditor({ src: page.url, entryIdx })
  }

  /** 裁剪确认：上传裁剪图 → 追加到题目图片组 */
  const handleCropConfirm = async (path: string) => {
    const entryIdx = cropEditor?.entryIdx
    setCropEditor(null)
    if (entryIdx == null || !path) return
    setBoardBusy(true)
    try {
      const up = await uploadImage(path)
      setBoard((prev) =>
        prev.map((e, i) => (i === entryIdx ? { ...e, images: [...e.images, { url: up.url, key: up.key }] } : e)),
      )
      Taro.showToast({ title: '已裁剪入题', icon: 'success' })
    } catch (e) {
      console.error('裁剪图上传失败', e)
      Taro.showToast({ title: '裁剪图上传失败，请重试', icon: 'none' })
    } finally {
      setBoardBusy(false)
    }
  }

  /** 粘贴栏导出 Word：空条目（无文字且无图）跳过 */
  const handleBoardExport = async () => {
    const items: BoardExportItem[] = board
      .map((e) => ({ question_content: e.text.trim(), images: e.images.map((i) => i.url) }))
      .filter((it) => it.question_content || (it.images && it.images.length))
    if (!items.length) {
      Taro.showToast({ title: '请先输入文字或裁剪入图', icon: 'none' })
      return
    }
    setExporting(true)
    try {
      const res = await exportBoardDocx(items, `错题整理 · ${new Date().toLocaleDateString('zh-CN')}`)
      Taro.showToast({ title: 'Word 已生成', icon: 'success' })
      if (res?.url) openStorageFile(res.url, false)
    } catch (e) {
      console.error('导出 Word 失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导出失败，请重试', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  /** 面板草稿选择器数据：题号标签 + 序号 */
  const textPanelDrafts: TextPanelDraft[] = drafts.map((d, idx) => ({
    idx,
    label: `${d.question_label ? `${d.question_label} · ` : ''}第 ${idx + 1} 题`,
  }))
  /** 叠加视图数据：已收录草稿（active）+ 系统未收录块 */
  const editorItems: BoxEditorItem[] = [
    ...drafts.map((d) => ({
      // split 模式草稿必带 block_id（blockIdOf 兜底 -1）；paper/doc 草稿不进编辑器，
      // 此处 ?? -9999 仅满足类型，避免与系统块正 id / 合成负 id 相撞
      id: d.block_id ?? -9999,
      box: d.box ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
      verdict: d.verdict ?? ('wrong' as const),
      question_label: d.question_label,
      active: true,
    })),
    ...sysBlocks
      .filter((b) => !drafts.some((d) => d.block_id === b.id))
      .map((b) => ({ id: b.id, box: b.box, verdict: b.verdict, question_label: b.question_label, active: false })),
  ]

  const handleSave = async () => {
    if (!drafts.length) return
    setSaving(true)
    try {
      // 一次提取多道题 → 批量落库（POST /api/timeline/batch），不再循环单条请求
      const payloads = drafts.map((d) => ({
        kind: 'question' as const,
        subject_id: d.subject_id,
        source: d.source,
        content: {
          question: d.question_content,
          answer: d.answer_content || '',
          solution: d.solution || '',
          wrong_answer: d.wrong_answer || '',
          status: (d.has_answer || d.answer_content ? 'answered' : 'pending') as 'answered' | 'pending',
          // 题面图 / 答题卡图区分存储，并落地层级（子题携带大题题干）。
          // 不再双写 images[]（P1-15：前端只读 question_images/answer_images，images[] 已无消费者）。
          question_images: d.question_image_keys || [],
          answer_images: d.answer_image_keys || [],
          level: typeof d.level === 'number' ? d.level : undefined,
          parent_index: d.parent_index ?? null,
          stem: d.stem || '',
          // P3：规范题号标签随保存落库（错题库唯一指认「节·小类 题号」）
          question_label: d.question_label,
        },
      }))
      await createTimelineBatch(payloads)
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('保存失败', e)
      Taro.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  // 把识别结果直接存成一个 Word 文档，并立刻打开（后端同时写入「文档」页，可再次打开）
  const handleExportDocx = async () => {
    if (!drafts.length) return
    setExporting(true)
    try {
      const res = await exportRecognizedDocx(drafts, `识别结果 · ${new Date().toLocaleDateString('zh-CN')}`)
      Taro.showToast({ title: 'Word 已生成', icon: 'success' })
      if (res?.url) openStorageFile(res.url, false)
    } catch (e) {
      console.error('导出 Word 失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导出失败，请重试', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  const handleSaveImageDirect = async () => {
    if (!paperImage) {
      Taro.showToast({ title: '请先拍照或选择图片', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    setSaving(true)
    try {
      // purpose 必须是 save：这张图要被正式存档（进入「最近题目」并计入引用计数）。
      // 若用默认的 temp 上传，它会被登记为「用完即弃的中间态」并在 24h 后被 GC 回收
      // ⇒ 已保存的题目图片会裂掉。
      const up = await uploadImage(paperImage, { purpose: 'save' })
      // 后端 /api/upload 已为图片自动建立 timeline(kind=image) 条目，直接用其 id 补学科
      await saveQuestionAsImage(sid, up.key, up.url, up.timeline_id)
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 800)
    } catch (e) {
      console.error('图片直存失败', e)
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  const subjectIndex = (id: string) => Math.max(0, subjects.findIndex((s) => s.id === id))
  const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name || '选择学科'
  /** #150 人工整理：当前展示/裁剪的来源页 */
  const curPage = boardPages[activePage]

  return (
    <ScrollView scrollY className="h-full bg-background">
      <View className="px-4 pt-4 pb-40">
        {/* 模式切换 */}
        <SegmentedTabs<Mode>
          className="mb-4"
          value={mode}
          onValueChange={(v) => setMode(v)}
          options={[
            { value: 'paper', label: '拍照识别' },
            { value: 'split', label: '错题提取' },
            { value: 'doc', label: '导入文档' },
          ]}
        />

        {/* 学科选择（人工整理流程不落库，无需学科） */}
        {mode !== 'split' ? (
          <View className="flex flex-row items-center justify-between mb-4">
            <Text className="block text-sm text-muted-foreground">默认归类学科</Text>
            <Picker
              mode="selector"
              range={subjects}
              rangeKey="name"
              onChange={(e) => setDefaultSubject(subjects[Number(e.detail.value)]?.id || '')}
            >
              <View className="bg-muted rounded-lg px-4 py-2">
                <Text className="block text-sm text-primary">{subjects.find((s) => s.id === defaultSubject)?.name || '点击选择'}</Text>
              </View>
            </Picker>
          </View>
        ) : null}

        {mode === 'paper' ? (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">拍摄作业、试卷（含老师批改痕迹效果最佳）</Text>
            {paperImage ? (
              <TaroImage src={paperImage} mode="widthFix" className="w-full rounded-xl mb-3" onClick={() => chooseImage('paper')} />
            ) : (
              <View className="w-full h-40 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-3" onClick={() => chooseImage('paper')}>
                <Text className="block text-sm text-muted-foreground">点击拍照 / 从相册选择</Text>
              </View>
            )}
            <View className="flex flex-row items-center justify-between gap-1 mb-3">
              <ImgActionBtn icon={Crop} label="编辑裁剪" onClick={() => { if (paperImage) setEditor({ slot: 'paper', src: paperImage }); else chooseImage('paper') }} />
              <ImgActionBtn icon={Wand} label="自动调正" onClick={() => openEditorWithAction('paper', 'auto')} />
              <ImgActionBtn icon={Sparkles} label="智能高清" onClick={() => openEditorWithAction('paper', 'enhance')} />
              <ImgActionBtn icon={Eraser} label="去手写" onClick={() => openEditorWithAction('paper', 'erase_v2')} />
            </View>
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleRecognizePaper}>
              <Text className="block text-sm">{loading ? '识别中…' : '开始识别'}</Text>
            </Button>
            <View className="flex flex-row items-center justify-center mt-3">
              <View onClick={() => handleSaveImageDirect()}>
                <Text className="block text-xs text-primary">以图片形式直接保存到最近题目</Text>
              </View>
            </View>
          </Card>
        ) : mode === 'split' ? (
          <>
            {/* #150 人工辅助流程：选图 → 右侧 OCR 文本栏 → 底部粘贴栏（文字 + 裁剪图）→ 导出 Word */}
            <Card className="rounded-2xl border-border p-4 mb-4">
              <Text className="block text-xs text-muted-foreground mb-3">
                选择作业图片，系统自动识别整页文字：在右侧文本栏复制需要的内容，粘到下方题目的文本框；也可直接在图片上框选裁剪错题区域入题
              </Text>
              {!curPage ? (
                <View className="w-full h-40 border-2 border-dashed border-border rounded-xl flex items-center justify-center" onClick={() => void addBoardPages()}>
                  <View className="flex flex-col items-center">
                    <Text className="block text-sm text-muted-foreground">点击拍照 / 选择作业图片</Text>
                    <Text className="block text-[10px] text-muted-foreground mt-1">支持一次多选，稍后逐页识别</Text>
                  </View>
                </View>
              ) : (
                <>
                  {/* 图片（左） + OCR 文本栏（右） */}
                  <View className="flex flex-row gap-2 mb-3" style={{ height: 360 }}>
                    <View className="rounded-xl overflow-hidden bg-muted" style={{ flex: '1 1 0' }}>
                      <TaroImage
                        src={curPage.url}
                        mode="aspectFit"
                        style={{ width: '100%', height: '100%' }}
                        onClick={() => Taro.previewImage({ urls: boardPages.map((p) => p.url), current: curPage.url })}
                      />
                    </View>
                    <View className="rounded-xl overflow-hidden" style={{ flex: '1 1 0', border: '1px solid #ece8e0' }}>
                      <WrongqOcrPanel
                        segments={curPage.segments}
                        pageLabel={`第 ${activePage + 1}/${boardPages.length} 页`}
                        busy={curPage.ocr === 'busy'}
                      />
                    </View>
                  </View>

                  {/* 多图切换条 */}
                  <ScrollView scrollX className="w-full" style={{ whiteSpace: 'nowrap' }}>
                    <View className="flex flex-row items-center gap-2 py-1">
                      {boardPages.map((p, i) => (
                        <View
                          key={p.id}
                          onClick={() => switchPage(i)}
                          style={{
                            width: 46, height: 46, borderRadius: 8, overflow: 'hidden', flexShrink: 0, position: 'relative',
                            border: `2px solid ${i === activePage ? '#BE3E2D' : '#ece8e0'}`,
                          }}
                        >
                          <TaroImage src={p.url} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                          {p.ocr === 'busy' ? (
                            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' }}>
                              <Text style={{ fontSize: 8, color: '#fff' }}>识别中</Text>
                            </View>
                          ) : null}
                          {p.ocr === 'error' ? (
                            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(190,62,45,0.75)', alignItems: 'center' }}>
                              <Text style={{ fontSize: 8, color: '#fff' }}>识别失败</Text>
                            </View>
                          ) : null}
                        </View>
                      ))}
                      <View
                        onClick={() => void addBoardPages()}
                        style={{
                          width: 46, height: 46, borderRadius: 8, flexShrink: 0,
                          border: '1px dashed #C9C2B8', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 16, color: '#9A948A' }}>＋</Text>
                      </View>
                    </View>
                  </ScrollView>
                  <View className="flex flex-row items-center justify-between mt-2">
                    <Text className="block text-[10px] text-muted-foreground">点图片看大图 · 共 {boardPages.length} 页</Text>
                    <View className="flex flex-row items-center gap-3">
                      {curPage.ocr === 'error' ? (
                        <Text className="block text-[10px]" style={{ color: '#BE3E2D' }} onClick={() => void retryPageOcr(activePage)}>
                          重新识别本页
                        </Text>
                      ) : null}
                      <Text className="block text-[10px] text-primary" onClick={() => void addBoardPages()}>添加图片</Text>
                    </View>
                  </View>
                </>
              )}
            </Card>

            {/* 底部粘贴栏：结构化题目列表（文字长按粘贴 + 手动裁剪图） */}
            <Card className="rounded-2xl border-border p-4 mb-4">
              <View className="flex flex-row items-center justify-between mb-2">
                <Text className="block text-sm font-semibold text-foreground">粘贴栏（{board.length} 题）</Text>
                <Text className="block text-[10px] text-muted-foreground">文字长按粘贴 · 图片裁剪入题</Text>
              </View>
              {board.map((e, idx) => (
                <View key={e.id} className="rounded-xl p-3 mb-3" style={{ backgroundColor: '#fff', border: '1px solid #ece8e0' }}>
                  <View className="flex flex-row items-center justify-between mb-2">
                    <Text className="block text-xs font-medium text-foreground">第 {idx + 1} 题</Text>
                    <View className="flex flex-row items-center gap-3">
                      <Text className="block text-[10px] text-muted-foreground" onClick={() => moveEntry(idx, -1)}>上移</Text>
                      <Text className="block text-[10px] text-muted-foreground" onClick={() => moveEntry(idx, 1)}>下移</Text>
                      <Text className="block text-[10px]" style={{ color: '#BE3E2D' }} onClick={() => removeEntry(idx)}>删除</Text>
                    </View>
                  </View>
                  <View className="bg-muted rounded-xl p-2 mb-2">
                    <Textarea
                      className="min-h-20 border-0 ring-0 focus-within:ring-0 rounded-lg"
                      value={e.text}
                      placeholder="长按粘贴从右侧 OCR 文本栏复制的文字，也可手动输入"
                      maxlength={2000}
                      onInput={(ev) => setEntryText(idx, ev.detail.value)}
                    />
                  </View>
                  {/* 裁剪图组 + 裁剪入图按钮 */}
                  <View className="flex flex-row items-center flex-wrap gap-2">
                    {e.images.map((img, j) => (
                      <View key={j} style={{ width: 64, height: 64, borderRadius: 8, overflow: 'hidden', position: 'relative', border: '1px solid #ece8e0' }}>
                        <TaroImage
                          src={img.url}
                          mode="aspectFill"
                          style={{ width: '100%', height: '100%' }}
                          onClick={() => Taro.previewImage({ urls: e.images.map((x) => x.url), current: img.url })}
                        />
                        <View
                          onClick={() => removeEntryImage(idx, j)}
                          style={{
                            position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 999,
                            backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          <Text style={{ color: '#fff', fontSize: 11, lineHeight: '13px' }}>×</Text>
                        </View>
                      </View>
                    ))}
                    <View
                      onClick={() => startCrop(idx)}
                      className="flex flex-col items-center justify-center"
                      style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed #C9C2B8' }}
                    >
                      <Text style={{ fontSize: 14, color: '#BE3E2D', lineHeight: '16px' }}>＋</Text>
                      <Text className="block text-[9px]" style={{ color: '#BE3E2D' }}>裁剪入图</Text>
                    </View>
                  </View>
                </View>
              ))}
              <View onClick={addEntry} className="w-full h-10 rounded-xl flex items-center justify-center" style={{ border: '1px dashed #C9C2B8' }}>
                <Text className="block text-xs text-primary">＋ 添加题目</Text>
              </View>
            </Card>
          </>
        ) : (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">支持 PDF / Word(.docx) / TXT，从手机或电脑选择文档导入并自动识别题目</Text>
            {docFile ? (
              <View className="w-full bg-muted rounded-xl px-4 py-4 mb-3" onClick={() => pickDoc(setDocFile)}>
                <Text className="block text-sm text-primary break-all">{docFile}</Text>
              </View>
            ) : (
              <View className="w-full h-28 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-3" onClick={() => pickDoc(setDocFile)}>
                <Text className="block text-sm text-muted-foreground">点击选择文档文件（PDF/Word/TXT）</Text>
              </View>
            )}
            <Button className="w-full h-11 rounded-xl" disabled={loading} onClick={handleRecognizeDoc}>
              <Text className="block text-sm">{loading ? '识别中…' : '导入并识别'}</Text>
            </Button>
            <View className="flex items-center justify-center mt-3" onClick={() => setPicker(true)}>
              <Text className="block text-xs text-primary">从资料库选择文档</Text>
            </View>
          </Card>
        )}

        {/* #150 暂停：以下两块（改框编辑器 / 选择粘贴面板）属「双图自动识别」链路，
            人工辅助流程已替代为主入口；代码保留，待后期检测效果达标后恢复渲染。
            因 split 模式不再设置 showEditor/pageText，这两块当前不会出现。 */}
        {mode === 'split' && drafts.length > 0 && showEditor && (questionUrl || questionImage) ? (
          <WrongqBoxEditor
            visible
            imageSrc={questionUrl || questionImage}
            page={pageSize}
            items={editorItems}
            busy={recropBusy}
            onPreview={handleBoxPreview}
            onCommit={(id, box) => void handleBoxCommit(id, box)}
            onDelete={handleBoxDelete}
            onClose={() => setShowEditor(false)}
          />
        ) : null}

        {/* P3：全页 OCR 文本面板（选择粘贴 / 导出所选；与改框编辑器互补） */}
        {mode === 'split' && pageText.length > 0 ? (
          <WrongqTextPanel
            visible
            segments={pageText}
            drafts={textPanelDrafts}
            busy={textBusy || saving || exporting}
            onPaste={handleTextPaste}
            onExportSelected={(t) => void handleExportSelected(t)}
          />
        ) : null}

        {loading && (
          <View className="space-y-3">
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-32 w-full rounded-2xl" />
          </View>
        )}

        {unmatched.length > 0 && (
          <Card className="rounded-2xl border-border p-3 mb-3 bg-amber-50 border-amber-200">
            <Text className="block text-xs text-amber-700">有 {unmatched.length} 道题目未匹配到答案，保存后可联网搜题</Text>
          </Card>
        )}

        {drafts.length > 0 && (
          <>
            <View className="mb-3 flex flex-row items-center justify-between">
              <Text className="block text-sm font-semibold text-foreground">识别结果（{drafts.length} 题，可修改）</Text>
              {mode === 'split' && !showEditor && (questionUrl || questionImage) ? (
                <Text className="block text-xs text-primary" onClick={() => setShowEditor(true)}>校对圈定范围</Text>
              ) : null}
            </View>
            {drafts.map((d, idx) => (
              <Card key={idx} className="rounded-2xl border-border p-4 mb-3">
                <View className="flex flex-row items-center justify-between mb-3">
                  <View className="flex flex-row items-center gap-2">
                    <Text className="block text-xs text-muted-foreground">第 {idx + 1} 题</Text>
                    {d.question_label ? (
                      <Text className="block text-xs" style={{ color: '#BE3E2D' }}>{d.question_label}</Text>
                    ) : null}
                    {d.level === 2 ? (
                      <Text className="block text-xs" style={{ color: '#BE3E2D' }}>小题（已含大题题干）</Text>
                    ) : null}
                  </View>
                  <View className="flex flex-row gap-3">
                    <Picker
                      mode="selector"
                      range={subjects}
                      rangeKey="name"
                      value={subjectIndex(d.subject_id)}
                      onChange={(e) => updateDraft(idx, { subject_id: subjects[Number(e.detail.value)]?.id || d.subject_id })}
                    >
                      <Text className="block text-xs text-primary">{subjectName(d.subject_id)}</Text>
                    </Picker>
                    <Text className="block text-xs text-muted-foreground" onClick={() => removeDraft(idx)}>删除</Text>
                  </View>
                </View>

                <View className="bg-muted rounded-xl p-3 mb-2">
                  <Textarea
                    className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.question_content}
                    placeholder="题目内容（可手动修改）"
                    maxlength={2000}
                    onInput={(e) => updateDraft(idx, { question_content: e.detail.value })}
                  />
                </View>

                {d.wrong_answer ? (
                  <Text className="block text-xs text-muted-foreground mb-2 line-through">原错答：{d.wrong_answer}</Text>
                ) : null}

                <View className="rounded-xl p-3 mb-1 border" style={{ borderColor: 'rgba(190,62,45,0.25)', backgroundColor: 'rgba(190,62,45,0.04)' }}>
                  <Textarea
                    className="min-h-20 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.answer_content}
                    placeholder="正确答案（可手动修改，无则留空后联网搜题）"
                    maxlength={2000}
                    onInput={(e) => updateDraft(idx, { answer_content: e.detail.value, has_answer: !!e.detail.value })}
                  />
                </View>
              </Card>
            ))}
          </>
        )}
      </View>

      {drafts.length > 0 && mode !== 'split' && (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Text className="block text-xs text-muted-foreground shrink-0">共 {drafts.length} 题</Text>
          <Button
            className="flex-1 h-11 rounded-xl"
            variant="outline"
            disabled={exporting || saving}
            onClick={handleExportDocx}
          >
            <Text className="block text-sm">{exporting ? '生成中…' : '导出 Word'}</Text>
          </Button>
          <Button className="flex-1 h-11 rounded-xl" disabled={saving} onClick={handleSave}>
            <Text className="block text-sm">{saving ? '保存中…' : '保存到最近题目'}</Text>
          </Button>
        </View>
      )}

      {/* #150 人工整理：粘贴栏底部操作条（有内容才出现） */}
      {mode === 'split' && board.some((e) => e.text.trim() || e.images.length) ? (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px',
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <Text className="block text-xs text-muted-foreground shrink-0">共 {board.length} 题</Text>
          <Button className="flex-1 h-11 rounded-xl" disabled={exporting || boardBusy} onClick={handleBoardExport}>
            <Text className="block text-sm">{exporting ? '生成中…' : '导出 Word'}</Text>
          </Button>
        </View>
      ) : null}

      <ImageEditor
        visible={!!editor}
        src={editor?.src || ''}
        autoAction={editor?.autoAction || null}
        onCancel={() => setEditor(null)}
        onConfirm={handleEditorConfirm}
      />

      {/* #150 人工整理：页内裁剪编辑器（只裁不处理，结果入粘贴栏题目） */}
      {cropEditor ? (
        <ImageEditor
          visible
          cropOnly
          src={cropEditor.src}
          confirmText="裁剪入题"
          enableSaveToInbox={false}
          onCancel={() => setCropEditor(null)}
          onConfirm={(p) => void handleCropConfirm(p)}
        />
      ) : null}

      <MaterialPicker
        visible={picker}
        title="从资料库选择文档"
        onClose={() => setPicker(false)}
        onSelect={(d) => void handleSelectDoc(d)}
      />
    </ScrollView>
  )
}

function ImgActionBtn({ icon: Icon, label, onClick }: { icon?: any; label: string; onClick: () => void }) {
  return (
    <View className="flex-1 flex flex-row items-center justify-center gap-1 bg-muted rounded-lg py-2" onClick={onClick}>
      {Icon ? <Icon size={14} color="#BE3E2D" /> : null}
      <Text className="block text-xs text-primary">{label}</Text>
    </View>
  )
}
