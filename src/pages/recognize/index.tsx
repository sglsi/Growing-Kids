// 例外说明：「序号快选」那个输入框外面已经套了自绘胶囊容器（h-9 rounded-xl border border-border），
// 而 ui/input 内建 h-10 + border + px-3，套进去会变成双层边框、高度也对不上。
// 该处只需要一个无装饰的原生输入体，故保留 Taro 原生 Input。
// eslint-disable-next-line no-restricted-syntax
import { View, Text, ScrollView, Input, Image as TaroImage, Picker } from '@tarojs/components'
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
import { CheckDot } from '@/components/selection-bar'
import WrongqBoxEditor, { type BoxEditorItem, type PageBox } from '@/components/wrongq-box-editor'
import WrongqTextPanel, { type TextPanelDraft } from '@/components/wrongq-text-panel'
import WrongqOcrPanel from '@/components/wrongq-ocr-panel'
import {
  fetchSubjects, recognizePaper, recognizeSeparate,
  recognizeDocumentByUrl, uploadFile, uploadImage, saveQuestionAsImage, exportRecognizedDocx, createTimelineBatch,
  recropWrongBlock, ocrPage, exportBoardDocx, diagnoseOcr,
  type Subject, type RecognizeResult, type LibraryDoc, type ImageAction, type WrongBlockSummary, type PageTextSegment, type BoardExportItem, type CreateTimelinePayload,
} from '@/services/api'
import { openStorageFile } from '@/services/net'
import { nudgeLoginIfAnonymous } from '@/services/auth'
import { BRAND, BRAND_TEXT, BRAND_FOREGROUND, INK } from '@/lib/theme'
import { reportChooseFail } from '@/utils/privacy'

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
  /** #109：是否勾选「存入错题库」（undefined 视为选中——识别结果默认全选） */
  selected?: boolean
}

// ---------- #150 人工辅助错题整理（替代 split 自动识别的主流程） ----------

/**
 * 题目卡片的一道题：文本 + 裁剪图 + **该题自己的 OCR 段落**。
 *
 * ⭐ 思傅 2026-10-20 定的流程：**先裁剪题目，再对裁剪出的内容做 OCR**。
 *   文本与图片同挂在「这一道题」上——文字不再是整页流水账里摘出来的孤儿，
 *   选文字即选本题，从根上消灭「图文分家」。
 */
interface BoardEntry {
  id: number
  text: string
  images: { url: string; key: string }[]
  /** 本题（首图）OCR 出的段落 */
  segments: PageTextSegment[]
  /** idle=未识别 | busy=识别中 | done=已识别 | error=识别失败 */
  ocr: 'idle' | 'busy' | 'done' | 'error'
  /** 识别失败原因 */
  err?: string
  /** 上次使用的识别模式（失败重试沿用） */
  lastMode?: 'fast' | 'precise'
}

/** 一个来源页：上传的页面图（整页识别后 url 换成摆正图，作为展示/裁剪基准） */
interface BoardPage {
  id: number
  url: string
  w: number
  h: number
  /** 整页识别（次要入口）产出的段落 */
  segments: PageTextSegment[]
  /** idle=未识别 | busy=识别中 | done=已识别 | error=识别失败 */
  ocr: 'idle' | 'busy' | 'done' | 'error'
  /** 识别失败原因 */
  err?: string
  /** 上次使用的识别模式（失败重试沿用） */
  lastMode?: 'fast' | 'precise'
  /** 朝向未经 OCR 消歧（侧车缺席时几何保守不转，本页可能侧躺） */
  suspect?: boolean
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
  // 导入文档（思傅 2026-10-21：「导入并识别」拆两步）——先「导入」上传文档拿 URL，
  // 再「识别题目」提取内容；识别结果不自动入库，由用户点底部「存入错题库」自选。
  const [docName, setDocName] = useState('')     // 展示名（文件名）
  const [docUrl, setDocUrl] = useState('')       // 已导入的云端 URL（识别用）
  const [docImporting, setDocImporting] = useState(false)
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  // #109 部分序号识别：序号输入框（如 "3,5,8-12"）+ 勾选态存 Draft.selected
  const [seqInput, setSeqInput] = useState('')

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
  // 题目卡里点开已裁剪的图 → 编辑器（思傅 2026-10-21：支持裁剪/旋转/灰度/高清等）
  const [editImg, setEditImg] = useState<{ entryIdx: number; imgIdx: number; url: string } | null>(null)
  // 来源页点开大图 → 编辑器（思傅 2026-10-21：来源页同样「点图片 = 打开并编辑」，与「＋裁剪题目」分开）
  const [pageEditImg, setPageEditImg] = useState<{ pageIdx: number; url: string } | null>(null)
  const boardIdRef = useRef(0)

  // #150 诊断：OCR 自检弹层（定位「未检测到文本」根因）
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagText, setDiagText] = useState<string | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)

  // 进入错题提取模式时给一条空题目，降低「从哪开始」的迷茫（用户删光后不补）
  useEffect(() => {
    if (mode === 'split' && board.length === 0) {
      setBoard([{ id: ++boardIdRef.current, text: '', images: [], segments: [], ocr: 'idle' }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // #111 doc 模式的「默认归类学科」Picker 也依赖 subjects：改为挂载即拉（原来只在
  // split 模式拉，doc 用户先点 Picker 时 subjects 恒为空数组 → 弹出空白页）
  useEffect(() => {
    if (subjects.length > 0) return
    void ensureSubjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    Taro.removeStorageSync('recog_mode')
  }, [])

  /** 确保学科列表已加载（#111：失败不抛、返回空数组，由调用方做 sid 守卫） */
  const ensureSubjects = async (): Promise<Subject[]> => {
    if (subjects.length > 0) return subjects
    try {
      const list = await fetchSubjects()
      setSubjects(list)
      setDefaultSubject((prev) => prev || list[1]?.id || list[0]?.id || '')
      return list
    } catch (e) {
      console.error('拉取学科列表失败', e)
      return []
    }
  }

  const chooseImage = async (slot: 'paper' | 'question' | 'answer') => {
    try {
      const res = await Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
      })
      setEditor({ slot, src: res.tempFiles[0].tempFilePath })
    } catch (e) {
      reportChooseFail(e, '选择图片')
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
    if (!sid) {
      Taro.showToast({ title: '学科列表未就绪，请确认后端已启动后重试', icon: 'none' })
      return
    }
    setLoading(true)
    setDrafts([])
    setSeqInput('')
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

  // 从资料库选择后：仅「导入」（文档已在云端，直接拿 URL）；
  // 识别由用户点「识别题目」触发（思傅 2026-10-21：导入/识别拆两步）
  const handleSelectDoc = (d: LibraryDoc) => {
    setDocFile('')
    setDocName(d.name)
    setDocUrl(d.url || '')
    setDrafts([])
    setSeqInput('')
    setUnmatched([])
    if (!d.url) {
      Taro.showToast({ title: '该文档暂无可用文件链接', icon: 'none' })
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
    } catch (e) {
      reportChooseFail(e, '选择文档', '请在微信小程序中从聊天/文件中选择文档')
    }
  }

  /** 选择本地文档：记路径与展示名；换文件即作废上次导入与识别结果 */
  const chooseDocFile = () => {
    pickDoc((path, name) => {
      setDocFile(path)
      setDocName(name || path)
      setDocUrl('')
      setDrafts([])
      setSeqInput('')
      setUnmatched([])
    })
  }

  /**
   * 「导入」（思傅 2026-10-21：与「识别」拆为两步）：
   * 仅上传文档拿云端 URL，不识别、不入库——文档先落定，用户准备好了再点「识别题目」。
   */
  const handleImportDoc = async () => {
    if (!docFile) {
      Taro.showToast({ title: '请先选择文档文件', icon: 'none' })
      return
    }
    if (docImporting) return
    setDocImporting(true)
    try {
      const up = await uploadFile(docFile)
      setDocUrl(up.url)
      Taro.showToast({ title: '已导入，可点「识别题目」', icon: 'success' })
    } catch (e) {
      console.error('文档导入失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导入失败，请重试', icon: 'none' })
    } finally {
      setDocImporting(false)
    }
  }

  /**
   * 「识别题目」：对已导入文档跑 OCR/题目提取（原「导入并识别」的后半段）。
   * 结果只进 drafts 供修改，**不自动入库**——底部操作条由用户自选是否存入错题库。
   */
  const handleRecognizeDoc = async () => {
    if (!docUrl) {
      Taro.showToast({ title: '请先点「导入」上传文档', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    if (!sid) {
      Taro.showToast({ title: '学科列表未就绪，请确认后端已启动后重试', icon: 'none' })
      return
    }
    setLoading(true)
    setDrafts([])
    setSeqInput('')
    setUnmatched([])
    try {
      const result = await recognizeDocumentByUrl(docUrl, sid)
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
    setDrafts((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      // #109：parent_index 是「同批次数组下标」——删除后下标错位，必须重映射：
      //   指向被删父题的子题升为顶层（题干已随 stem 携带，数据自洽）；下标大于被删项的递减
      return next.map((d) => {
        if (d.parent_index == null) return d
        if (d.parent_index === idx) return { ...d, parent_index: null, level: 1 }
        return d.parent_index > idx ? { ...d, parent_index: d.parent_index - 1 } : d
      })
    })
  }

  // ---- #109：按序号部分识别（只勾选要入库的题；导出 Word 仍全量） ----

  /** 勾选态读取：undefined 视为选中（识别结果默认全选） */
  const isDraftSelected = (d: Draft) => d.selected !== false

  /** 序号串 → 1-based 序号集合。支持 "3,5,8-12"（容忍全角逗号/空格/重复）；非法或越界返回 null */
  function parseSeqInput(raw: string, total: number): Set<number> | null {
    const s = raw.replace(/，/g, ',').replace(/\s+/g, '')
    if (!s) return null
    const out = new Set<number>()
    for (const part of s.split(',')) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part)
      if (!m) return null
      const a = Number(m[1])
      const b = m[2] ? Number(m[2]) : a
      if (a < 1 || b > total || a > b) return null
      for (let i = a; i <= b; i++) out.add(i)
    }
    return out
  }

  /** 勾选/取消某题；父题（level=1）联动全部子题（parent_index 指向它），避免子题成「无本之木」 */
  const toggleDraftSelected = (idx: number) => {
    setDrafts((prev) => {
      const next = prev.map((d, i) => (i === idx ? { ...d, selected: !isDraftSelected(d) } : d))
      const want = next[idx].selected === true
      if (next[idx].level === 1) {
        for (let i = 0; i < next.length; i++) {
          if (i !== idx && next[i].parent_index === idx) next[i] = { ...next[i], selected: want }
        }
      }
      return next
    })
  }

  /** 应用序号输入：只改勾选态，不碰题目内容 */
  const applySeqSelection = () => {
    const picked = parseSeqInput(seqInput, drafts.length)
    if (!picked) {
      Taro.showToast({ title: '序号格式有误或超出范围（如 3,5,8-12）', icon: 'none' })
      return
    }
    // 思傅 2026-10-26 修「存入的内容不是输入的错题序号」：
    // 输入的题号优先按**文档印刷题号**（question_label 里的数字，如 "预习案·Ⅱ 18" → 18）
    // 匹配——列表显示序号 ≠ 印刷题号（识别可能漏题/并题导致错位）。
    // 仅当输入的每个数字都能在题号里找到时才按题号选；否则回落到列表显示序号（旧行为）。
    const byLabel = new Map<number, number[]>()
    drafts.forEach((d, i) => {
      const nums = (d.question_label || '').match(/\d+/g)
      if (nums) nums.forEach((n) => {
        const k = Number(n)
        const list = byLabel.get(k) || []
        list.push(i)
        byLabel.set(k, list)
      })
    })
    let idxSet: Set<number> | null = null
    if (byLabel.size > 0) {
      const allHit = [...picked].every((n) => byLabel.has(n))
      if (allHit) {
        idxSet = new Set([...picked].flatMap((n) => byLabel.get(n) || []))
      }
    }
    if (!idxSet) idxSet = picked // 位置匹配（picked 是 1-based 显示序号）
    setDrafts((prev) => prev.map((d, i) => ({ ...d, selected: idxSet!.has(i + 1) })))
    Taro.showToast({ title: `已选 ${idxSet.size} 题`, icon: 'success' })
  }

  const selectAllDrafts = () => setDrafts((prev) => prev.map((d) => ({ ...d, selected: true })))
  const clearDraftSelection = () => setDrafts((prev) => prev.map((d) => ({ ...d, selected: false })))
  const invertDraftSelection = () =>
    setDrafts((prev) => prev.map((d) => ({ ...d, selected: !isDraftSelected(d) }))
    )

  /**
   * 思傅 2026-10-26：把勾选的多题合并为 1 题（仅相同学科）——
   * 题干/答案/解析按顺序拼接，题面图与答案图并入并集；合并后作为一道题存入错题库。
   * 场景：文档把一道大题切成了多题，或用户想把一组小题归到一道题里复习。
   */
  const mergeSelectedDrafts = () => {
    const idxs = drafts.map((d, i) => (isDraftSelected(d) ? i : -1)).filter((i) => i >= 0)
    if (idxs.length < 2) {
      Taro.showToast({ title: '请先勾选至少两道题', icon: 'none' })
      return
    }
    if (new Set(idxs.map((i) => drafts[i].subject_id)).size > 1) {
      Taro.showToast({ title: '仅支持合并相同学科的题目', icon: 'none' })
      return
    }
    Taro.showModal({
      title: `合并 ${idxs.length} 题为 1 题？`,
      content: '题干/答案按顺序拼接，题面图与答案图全部并入，合并后不可撤销。',
      confirmText: '合并',
      success: (m) => {
        if (!m.confirm) return
        const parts = idxs.map((i) => drafts[i])
        const first = idxs[0]
        const join = (arr: string[]) => arr.map((p) => (p || '').trim()).filter(Boolean).join('\n\n')
        const merged: Draft = {
          ...parts[0],
          question_content: join(parts.map((d) => d.question_content)),
          answer_content: join(parts.map((d) => d.answer_content)),
          solution: join(parts.map((d) => d.solution)),
          wrong_answer: join(parts.map((d) => d.wrong_answer)),
          has_answer: parts.some((d) => d.has_answer || (d.answer_content || '').trim()),
          question_image_keys: parts.flatMap((d) => d.question_image_keys || []),
          answer_image_keys: parts.flatMap((d) => d.answer_image_keys || []),
          // 合并题以首题的印刷题号作锚（内容已含多题，不再唯一指认某题号）
          question_label: parts[0].question_label,
          level: 1,
          parent_index: null,
          stem: '',
          selected: true,
        }
        setDrafts((prev) => {
          const next = prev.filter((_, i) => !idxs.includes(i))
          next.splice(Math.min(first, next.length), 0, merged)
          return next
        })
        setSeqInput('')
        Taro.showToast({ title: `已合并 ${parts.length} 题为 1 题`, icon: 'success' })
      },
    })
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
    setDrafts((prev) => {
      const idx = prev.findIndex((d) => d.block_id === id)
      const next = prev.filter((d) => d.block_id !== id)
      if (idx < 0) return next
      // #109：与 removeDraft 同款 parent_index 重映射（删除使数组下标错位）
      return next.map((d) => {
        if (d.parent_index == null) return d
        if (d.parent_index === idx) return { ...d, parent_index: null, level: 1 }
        return d.parent_index > idx ? { ...d, parent_index: d.parent_index - 1 } : d
      })
    })
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
      if (res?.url) openStorageFile(res.url, false, res.file_key)
    } catch (e) {
      console.error('导出所选失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导出失败，请重试', icon: 'none' })
    } finally {
      setTextBusy(false)
    }
  }

  // ---------- #150 人工辅助错题整理：页面 / OCR / 粘贴栏 ----------

  /** 选择（可多选）作业页图片：上传 → 追加页（不自动 OCR，等用户点「快速/精准」手动触发） */
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
    } catch (e) {
      reportChooseFail(e, '选择图片')
      return
    }
    if (!files.length) return
    setBoardBusy(true)
    const added: BoardPage[] = []
    try {
      for (const f of files) {
        const up = await uploadImage(f.tempFilePath)
        added.push({ id: ++boardIdRef.current, url: up.url, w: 0, h: 0, segments: [], ocr: 'idle' })
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
    // #150 双模式：默认不自动识别——由用户按需点「快速」（RapidOCR 1~3s/页）
    // 或「精准」（PaddleOCR 全链路 15~20s/页），避免选图后长时间无反馈的自动等待。
    setBoardBusy(false)
  }

  /** 单页全页 OCR（用户手动触发：快速/精准）；失败置 error 态并记录原因，不抛 */
  const runPageOcr = async (p: BoardPage, ocrMode: 'fast' | 'precise') => {
    setBoardPages((prev) => prev.map((x) => (x.id === p.id ? { ...x, ocr: 'busy', err: undefined, lastMode: ocrMode } : x)))
    // ⚠️ 精准模式实测 ~67s（R-上线-01），必须给等待反馈：
    //    页面上的转圈太小，用户不知道是「在跑」还是「卡死了」，只会反复点。
    const precise = ocrMode === 'precise'
    if (precise) Taro.showLoading({ title: '精准识别中，约需 1 分钟', mask: true })
    let shownAt = 0
    try {
      const r = await ocrPage(p.url, ocrMode, {
        onProgress: ({ waitedMs }) => {
          const sec = Math.round(waitedMs / 1000)
          if (sec >= shownAt + 10) {
            shownAt = sec
            Taro.showLoading({ title: `精准识别中…已等待 ${sec}s`, mask: true })
          }
        },
      })
      setBoardPages((prev) =>
        prev.map((x) =>
          x.id === p.id
            ? {
                ...x,
                url: r.image_url || x.url,
                w: r.page.w,
                h: r.page.h,
                segments: r.page_text,
                ocr: 'done' as const,
                err: undefined,
                lastMode: ocrMode,
                suspect: r.orient_suspect,
              }
            : x,
        ),
      )
      if (r.orient_suspect) {
        Taro.showToast({ title: '本页可能侧躺，识别结果仅供参考', icon: 'none' })
      } else if (!r.page_text.length) {
        Taro.showToast({ title: '本页未识别到文字，可手动输入', icon: 'none' })
      } else {
        Taro.showToast({ title: `识别到 ${r.page_text.length} 段文字`, icon: 'success' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '识别失败，请重试'
      console.error('全页 OCR 失败', e)
      setBoardPages((prev) => prev.map((x) => (x.id === p.id ? { ...x, ocr: 'error' as const, err: msg, lastMode: ocrMode } : x)))
    } finally {
      if (precise) Taro.hideLoading()
    }
  }

  /** 重新识别某一页（OCR 失败重试，沿用上次模式） */
  const retryPageOcr = async (idx: number) => {
    const p = boardPages[idx]
    if (!p || boardBusy) return
    setBoardBusy(true)
    await runPageOcr(p, p.lastMode ?? 'precise')
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
    setBoard((prev) => [...prev, { id: ++boardIdRef.current, text: '', images: [], segments: [], ocr: 'idle' }])
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

  /** 把文本追加进指定题题干（「存入题目」与「加入题干」共用） */
  const appendTextToEntry = (idx: number, t: string) => {
    setBoard((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, text: e.text.trim() ? `${e.text.trim()}\n${t}` : t } : e)),
    )
    Taro.showToast({ title: `已存入第 ${idx + 1} 题`, icon: 'success' })
  }

  /**
   * OCR 面板「存入题目」直通：弹题目选择器，把所选文本追加进指定题的题干。
   * 思傅 2026-10-20 决策：文字与裁剪图必须绑定同一题——复制粘贴靠用户心记
   * 「哪段文字属于哪题」极易错配，保存后同题图文"分家"成两道题；此按钮把
   * 「选文字 → 定题目」变成一步显式操作。
   * ⚠️ 防分家三重加固（思傅 2026-10-21 复测仍分家后）：
   *    ① 选项带「·有图」标记——文字要存回已有裁剪图的那道题；
   *    ② 选「＋存入新题目」时若存在「有图无文字」的题，弹确认引导并入
   *       （这正是 10-21 复测的分家路径：整页选文字 → 新建文字题 →
   *        裁剪图在另一题 → 存成两道）；
   *    ③ 主流程（本题 OCR →「加入题干」）不经过此选择器，结构上不会分家。
   */
  const handlePasteToEntry = (text: string) => {
    const t = text.trim()
    if (!t) return
    const items = board.map((e, i) => {
      const prev = e.text.trim()
      const img = e.images.length ? '·有图' : ''
      return prev
        ? `第 ${i + 1} 题${img}：${prev.slice(0, 12)}${prev.length > 12 ? '…' : ''}`
        : `第 ${i + 1} 题${img}（空）`
    })
    const canAdd = board.length < MAX_BOARD_ENTRIES
    if (canAdd) items.push('＋ 存入新题目')
    const createNewEntry = () => {
      setBoard((prev) => [...prev, { id: ++boardIdRef.current, text: t, images: [], segments: [], ocr: 'idle' }])
      Taro.showToast({ title: `已存入新题（第 ${board.length + 1} 题）`, icon: 'success' })
    }
    Taro.showActionSheet({
      itemList: items,
      success: (res) => {
        const idx = res.tapIndex
        if (idx < board.length) {
          appendTextToEntry(idx, t)
          return
        }
        if (!canAdd) return
        // ② 分家守护：新建纯文字题前，若已有「有图无文字」的题，极可能是同题文字存丢了
        const imgOnly = board.findIndex((e) => e.images.length && !e.text.trim())
        if (imgOnly >= 0) {
          Taro.showModal({
            title: '可能存错题了',
            content: `第 ${imgOnly + 1} 题有裁剪图但还没有文字。要把这段文字并入第 ${imgOnly + 1} 题吗？选「仍然新建」会多出一道只有文字的题。`,
            confirmText: `并入第 ${imgOnly + 1} 题`,
            cancelText: '仍然新建',
            success: (m) => {
              if (m.confirm) appendTextToEntry(imgOnly, t)
              else createNewEntry()
            },
          })
        } else {
          createNewEntry()
        }
      },
    })
  }

  /**
   * ⭐ 新流程核心：对「已裁剪好的题目图」单独 OCR（快速 1~3s / 精准 15~20s）。
   *
   * 为什么先裁剪再识别（思傅 2026-10-20 定）：
   *  - 整页 OCR 得到的是流水账，用户要在几十段里凭记忆找「哪几段是这一题」；
   *  - 先裁出题目区域再识别，返回的段落天然属于本题，勾选即可，不必再认亲；
   *  - 小图识别本身也更准（版面简单、字更大）。
   *
   * rectify=false：裁剪图已在摆正页图上切出，再摆正只会二次透视（37×39 裂图教训）。
   */
  const runEntryOcr = async (entryIdx: number, ocrMode: 'fast' | 'precise', imageUrl?: string) => {
    const e = board[entryIdx]
    // imageUrl：裁剪刚完成时用它（此时 board 状态还没更新出这张图）
    const src = imageUrl || e?.images[0]?.url
    if (!e || !src) return
    // ⭐ 思傅 2026-10-21：切到**精准识别时先清空上次的段落**。
    //    换精准本就是因为快速识别效果不理想，若不清空：识别中旧内容还摊在那里、
    //    完成后新旧段落混在一起，用户分不清哪份是新的（快速重识别则保留，便于对比）。
    //    注意只清「识别框」的段落，不动用户已编辑的题干。
    setBoard((prev) =>
      prev.map((x, i) =>
        i === entryIdx
          ? { ...x, segments: ocrMode === 'precise' ? [] : x.segments, ocr: 'busy', err: undefined, lastMode: ocrMode }
          : x,
      ),
    )
    const precise = ocrMode === 'precise'
    if (precise) Taro.showLoading({ title: '精准识别中，约需 1 分钟', mask: true })
    let shownAt = 0
    try {
      const r = await ocrPage(src, ocrMode, {
        rectify: false,
        onProgress: ({ waitedMs }) => {
          const sec = Math.round(waitedMs / 1000)
          if (sec >= shownAt + 10) {
            shownAt = sec
            Taro.showLoading({ title: `精准识别中…已等待 ${sec}s`, mask: true })
          }
        },
      })
      setBoard((prev) =>
        prev.map((x, i) =>
          i === entryIdx
            ? { ...x, segments: r.page_text, ocr: 'done', err: undefined, lastMode: ocrMode }
            : x,
        ),
      )
      if (!r.page_text.length) {
        Taro.showToast({ title: '本图未识别到文字，可手动输入', icon: 'none' })
      } else {
        Taro.showToast({ title: `识别到 ${r.page_text.length} 段`, icon: 'success' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '识别失败，请重试'
      console.error('题目图 OCR 失败', err)
      setBoard((prev) => prev.map((x, i) => (i === entryIdx ? { ...x, ocr: 'error', err: msg, lastMode: ocrMode } : x)))
      Taro.showToast({ title: msg.slice(0, 30), icon: 'none', duration: 2500 })
    } finally {
      if (precise) Taro.hideLoading()
    }
  }

  /** 把本题勾选的段落追加进本题题干（一步到位，不再靠剪贴板中转） */
  const appendSegmentsToEntry = (entryIdx: number, text: string) => {
    const t = text.trim()
    if (!t) return
    setBoard((prev) =>
      prev.map((e, i) => (i === entryIdx ? { ...e, text: e.text.trim() ? `${e.text.trim()}\n${t}` : t } : e)),
    )
    Taro.showToast({ title: `已加入第 ${entryIdx + 1} 题`, icon: 'success' })
  }

  const removeEntryImage = (idx: number, imgIdx: number) => {
    setBoard((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, images: e.images.filter((_, j) => j !== imgIdx) } : e)),
    )
  }

  /**
   * 题目图「编辑」完成（思傅 2026-10-21：点开已裁剪的图支持裁剪/旋转/灰度/高清）：
   * 编辑器结果以 attach 上传（持久化、不建条目）→ 原位替换该题这张图。
   * ⚠️ 换图后旧 OCR 段落作废（图都换了，文字不再是这张图的）→ 清空等用户重新识别。
   */
  const handleEntryImgEdited = async (tempPath: string) => {
    const t = editImg
    setEditImg(null)
    if (!t || !tempPath) return
    setBoardBusy(true)
    try {
      const up = await uploadImage(tempPath, { purpose: 'attach' })
      setBoard((prev) =>
        prev.map((e, i) =>
          i === t.entryIdx
            ? {
                ...e,
                images: e.images.map((im, j) => (j === t.imgIdx ? { url: up.url, key: up.key } : im)),
                segments: [],
                ocr: 'idle',
                err: undefined,
              }
            : e,
        ),
      )
      Taro.showToast({ title: '图片已替换，可重新「识别本题」', icon: 'success' })
    } catch (e) {
      console.error('题目图替换失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '替换失败，请重试', icon: 'none' })
    } finally {
      setBoardBusy(false)
    }
  }

  /**
   * 来源页「点开图片 → 编辑」完成（思傅 2026-10-21）：编辑器结果以 attach 上传（持久化、不建条目）
   * → 原位替换该来源页的图，后续「＋裁剪题目」以新图为基准。
   * ⚠️ 换图后本页旧 OCR 段落作废（文字不再是这张图的）→ 清空等用户重新识别。
   */
  const handlePageImgEdited = async (tempPath: string) => {
    const t = pageEditImg
    setPageEditImg(null)
    if (!t || !tempPath) return
    setBoardBusy(true)
    try {
      const up = await uploadImage(tempPath, { purpose: 'attach' })
      let w = 0
      let h = 0
      try {
        const info = await Taro.getImageInfo({ src: tempPath })
        w = info.width
        h = info.height
      } catch {
        /* 拿不到尺寸就沿用旧值，不影响主流程 */
      }
      setBoardPages((prev) =>
        prev.map((p, i) =>
          i === t.pageIdx
            ? { ...p, url: up.url, w: w || p.w, h: h || p.h, segments: [], ocr: 'idle', err: undefined }
            : p,
        ),
      )
      Taro.showToast({ title: '来源页已更新', icon: 'success' })
    } catch (e) {
      console.error('来源页替换失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '替换失败，请重试', icon: 'none' })
    } finally {
      setBoardBusy(false)
    }
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
      // ⭐⚠️ purpose='attach'（思傅 2026-10-21 复测修复，勿改回 'save'）：
      //    裁剪图是「挂到题目上」的附件，**不能**再单独建一条记录——
      //    purpose='save' 会让后端 upload.controller 在上传时就建一条 kind='image'
      //    的 timeline 记录（archive=true 分支），之后「存入错题库」又建一条
      //    kind='question' ⇒ **首页出现两道题**（图一条、题一条），即分家的真正根因。
      //    'attach' 在后端属于「非 archive、非 temp」：走 ingest() 正式存储
      //    （引用计数 +1，永久保留，不会被 24h 孤儿 GC 回收），且不建任何条目，
      //    只返回 key/url，由本题保存时写进 content.question_images。
      //    对照：handleSaveImageDirect（整卷图直存）确需 'save'，那是要单独成条目的。
      const up = await uploadImage(path, { purpose: 'attach' })
      setBoard((prev) =>
        prev.map((e, i) => (i === entryIdx ? { ...e, images: [...e.images, { url: up.url, key: up.key }] } : e)),
      )
      // ⚠️ 思傅 2026-10-21：裁剪后**不再自动识别**——识别与否交给用户点「识别本题」决定。
      //    （旧行为裁完自动跑快速 OCR：不想要文字的题白等 1~3s，想精准识别的还要先清一遍）
      //    不识别也能直接存入错题库（只存图），后端已放宽「无题干但有题面图」的校验。
      Taro.showToast({ title: '已裁剪入题，需要文字请点「识别本题」', icon: 'success' })
    } catch (e) {
      console.error('裁剪图上传失败', e)
      Taro.showToast({ title: '裁剪图上传失败，请重试', icon: 'none' })
    } finally {
      setBoardBusy(false)
    }
  }

  /** 粘贴栏导出 Word：空条目（无文字且无图）跳过 */  const handleBoardExport = async () => {
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
      if (res?.url) openStorageFile(res.url, false, res.file_key)
    } catch (e) {
      console.error('导出 Word 失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '导出失败，请重试', icon: 'none' })
    } finally {
      setExporting(false)
    }
  }

  /** 粘贴栏有效条目（有文字或有图） */
  const boardValidItems = () => board.filter((e) => e.text.trim() || e.images.length)

  /**
   * 粘贴栏存入错题库（#150）：条目 → kind=question timeline 批量落库。
   * 文字进 content.question，手动裁剪图进 content.question_images（file_key）。
   * ⚠️ 分家守护（思傅 2026-10-21 复测：同题图文仍被存成两道）：
   *    「恰好 1 个只有图 + 1 个只有文字」是经典分家签名（文字存进了另一题/新题）。
   *    落库前弹一次确认给合并机会；合法场景（本来就是两道题）点「仍然存两道」不拦截。
   */
  const handleBoardSave = async () => {
    const items = boardValidItems()
    if (!items.length) {
      Taro.showToast({ title: '请先输入文字或裁剪入图', icon: 'none' })
      return
    }
    const subs = await ensureSubjects()
    const sid = defaultSubject || subs[1]?.id || subs[0]?.id
    if (!sid) {
      Taro.showToast({ title: '请先选择学科', icon: 'none' })
      return
    }
    // ── 分家守护：1 图 + 1 文字 → 确认是否合并 ──
    // ⚠️ 「只有图」必须限定为**跑过识别却没有文字**（e.segments.length>0）：
    //    思傅 2026-10-21 起允许「只裁剪、不识别」（图片题），那是有意为之，
    //    此时若还弹合并提示就是误报，白打扰。
    let list = items
    const imgOnlyIdx = board.findIndex((e) => e.images.length && !e.text.trim() && e.segments.length > 0)
    const textOnlyIdx = board.findIndex((e) => !e.images.length && e.text.trim())
    if (imgOnlyIdx >= 0 && textOnlyIdx >= 0) {
      const merge = await new Promise<boolean>((resolve) => {
        Taro.showModal({
          title: '确认题目数量',
          content: `第 ${imgOnlyIdx + 1} 题只有裁剪图、第 ${textOnlyIdx + 1} 题只有文字——这样会存成两道题。如果是同一题，建议合并为一道。`,
          confirmText: '合并为一道',
          cancelText: '仍然存两道',
          success: (m) => resolve(m.confirm),
          fail: () => resolve(false),
        })
      })
      if (merge) {
        const t = board[textOnlyIdx].text.trim()
        list = board
          .map((e, i) => {
            if (i === textOnlyIdx) return null
            if (i === imgOnlyIdx) return { ...e, text: e.text.trim() ? `${e.text.trim()}\n${t}` : t }
            return e
          })
          .filter((e): e is BoardEntry => e !== null && (!!e.text.trim() || e.images.length > 0))
      }
    }
    setSaving(true)
    try {
      const payloads: CreateTimelinePayload[] = list.map((e) => ({
        kind: 'question' as const,
        subject_id: sid,
        source: '人工整理',
        content: {
          question: e.text.trim(),
          answer: '',
          solution: '',
          wrong_answer: '',
          status: 'pending' as const,
          question_images: e.images.map((i) => i.key),
        },
      }))
      await createTimelineBatch(payloads)
      Taro.showToast({ title: `已存入错题库 ${payloads.length} 题`, icon: 'success' })
      nudgeLoginIfAnonymous()
    } catch (e) {
      console.error('存入错题库失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  /**
   * 打印（#150）：
   *  - H5：新开窗口写打印视图（题目文字 + 裁剪图）→ window.print()，走浏览器打印；
   *  - 小程序/tt：无打印 API，引导「导出 Word」后在微信内打印/转发。
   */
  const handleBoardPrint = () => {
    const items = boardValidItems()
    if (!items.length) {
      Taro.showToast({ title: '请先输入文字或裁剪入图', icon: 'none' })
      return
    }
    if (Taro.getEnv() !== Taro.ENV_TYPE.WEB) {
      Taro.showToast({ title: '小程序端请「导出 Word」后打印/转发', icon: 'none' })
      return
    }
    const w = (globalThis as { window?: Window }).window
    if (!w) return
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>错题打印</title>` +
      `<style>body{font-family:-apple-system,"PingFang SC",sans-serif;padding:24px;color:#1a1a1a}` +
      `h1{font-size:18px;margin:0 0 16px}.q{margin-bottom:22px;page-break-inside:avoid}` +
      `.q .no{font-weight:600;font-size:14px;margin-bottom:6px}` +
      `.q .tx{font-size:14px;line-height:1.7;white-space:pre-wrap}` +
      `.q img{max-width:100%;margin-top:8px;border:1px solid #eee;border-radius:4px}</style></head>` +
      `<body><h1>错题整理 · ${new Date().toLocaleDateString('zh-CN')}</h1>` +
      items
        .map(
          (e, i) =>
            `<div class="q"><div class="no">第 ${i + 1} 题</div>` +
            `<div class="tx">${esc(e.text.trim())}</div>` +
            e.images.map((im) => `<img src="${im.url}"/>`).join('') +
            `</div>`,
        )
        .join('') +
      `</body></html>`
    const pw = w.open('', '_blank')
    if (!pw) {
      Taro.showToast({ title: '请允许弹出窗口后重试', icon: 'none' })
      return
    }
    pw.document.write(html)
    pw.document.close()
    pw.focus()
    setTimeout(() => pw.print(), 400)
  }

  /**
   * OCR 诊断（#150）：拉取后端 /api/image/ocr-diagnose 的结构化报告并格式化展示，
   * 帮助定位「本页未检测到文本」这类静默空结果的根因——端口/侧车/引擎缺哪环一目了然。
   */
  const handleDiagnose = async () => {
    setDiagLoading(true)
    setDiagError(null)
    setDiagText(null)
    try {
      const r = await diagnoseOcr()
      const lines: string[] = []
      const env = (r.env ?? {}) as Record<string, unknown>
      const py = (r.pythonVersions ?? {}) as Record<string, unknown>
      const side = (r.sidecar ?? {}) as Record<string, unknown>
      const fast = (r.fastEngine ?? {}) as Record<string, unknown>
      const precise = (r.preciseEngine ?? {}) as Record<string, unknown>
      lines.push('— 环境与端口 —')
      lines.push(`快速引擎 python: ${env.fastPython ?? '?'} → ${py.fast ?? '未知'}`)
      lines.push(`精准侧车 python: ${env.precisePython ?? '?'} → ${py.precise ?? '未知'}`)
      lines.push(`PPSV3 侧车地址: ${env.ppsv3Url ?? '?'}`)
      lines.push(`2.x 引擎地址: ${env.ocrEngineUrl ?? '?'}`)
      lines.push(`侧车托管(supervise): ${env.supervise ?? '?'}`)
      lines.push('')
      lines.push('— 侧车状态 —')
      lines.push(`disabled: ${side.disabled === false ? '否（已启用）' : '是'}`)
      if (side.disabledReason && side.disabledReason !== '(已启用)') lines.push(`未启用原因: ${side.disabledReason}`)
      lines.push('')
      lines.push('— 快速引擎（RapidOCR 探针实测） —')
      lines.push(`状态: ${fast.status ?? '?'}` + (fast.regionCount != null ? `（识别到 ${fast.regionCount} 段文本）` : ''))
      if (fast.sample && (fast.sample as string[]).length) lines.push(`样例: ${(fast.sample as string[]).join(' / ')}`)
      if (fast.stderr) lines.push(`stderr: ${String(fast.stderr).slice(0, 160)}`)
      if (fast.reason) lines.push(`原因: ${String(fast.reason)}`)
      lines.push('')
      lines.push('— 精准引擎（PaddleOCR 侧车探针实测） —')
      lines.push(`状态: ${precise.status ?? '?'}`)
      if (precise.healthz != null) lines.push(`healthz: ${precise.healthz ? '通过' : '不通'}`)
      if (precise.blockCount != null) lines.push(`blocks: ${precise.blockCount}`)
      if (precise.sample && (precise.sample as string[]).length) lines.push(`样例: ${(precise.sample as string[]).join(' / ')}`)
      if (precise.lastParseError) lines.push(`最近解析错误: ${String(precise.lastParseError).slice(0, 200)}`)
      lines.push('')
      const verdict = verdictOf(fast.status as string, precise.status as string)
      lines.push(`结论: ${verdict}`)
      setDiagText(lines.join('\n'))
    } catch (e) {
      setDiagError(`诊断失败（后端可能未更新或无此接口）: ${String((e as Error)?.message ?? e)}`)
    } finally {
      setDiagLoading(false)
    }
  }

  /** 根据两引擎状态给出一句话结论 */
  const verdictOf = (fastStatus?: string, preciseStatus?: string): string => {
    const bothOk = fastStatus === 'OK' && preciseStatus === 'OK'
    if (bothOk) return '两条识别路径均正常——若你仍看到空结果，多半是上传图本身无文字/太模糊，或识别模式未点。'
    if (fastStatus === 'FAIL' || fastStatus === 'ERROR')
      return '快速引擎已失败——检查系统 python3 是否已装 rapidocr_onnxruntime 与 main.py 是否随部署落地。'
    if (preciseStatus === 'UNREACHABLE' || preciseStatus === 'FAIL' || preciseStatus === 'ERROR')
      return '精准侧车不可达/失败——检查 PPSV3 侧车是否启动、端口 9301 是否被占用、venv 是否就绪。'
    if (fastStatus === 'OK')
      return '快速引擎正常、精准侧车异常——可先用「快速识别」应急，并修复精准侧车。'
    return '两条路径均异常——优先按上方端口/侧车/引擎逐项排查部署环境。'
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
    // #109：只存勾选题（默认全选）。一张卷子只录有错题的题——序号/勾选两种入口都汇到这里
    const picked = drafts.filter((d) => isDraftSelected(d))
    if (!picked.length) {
      Taro.showToast({ title: '请先勾选要存入错题库的题目', icon: 'none' })
      return
    }
    setSaving(true)
    try {
      // parent_index 是「同批次内的数组下标」——部分保存时按选中子集重映射，
      // 父题未勾选的子题升为顶层（题干已随 stem 携带，落库数据自洽）
      const remap = new Map<number, number>()
      drafts.forEach((d, i) => {
        if (isDraftSelected(d)) remap.set(i, picked.indexOf(d))
      })
      // 一次提取多道题 → 批量落库（POST /api/timeline/batch），不再循环单条请求
      const payloads = picked.map((d) => ({
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
          parent_index: d.parent_index != null && remap.has(d.parent_index) ? remap.get(d.parent_index)! : null,
          stem: d.stem || '',
          // P3：规范题号标签随保存落库（错题库唯一指认「节·小类 题号」）
          question_label: d.question_label,
        },
      }))
      await createTimelineBatch(payloads)
      nudgeLoginIfAnonymous()
      setSaving(false)
      // 思傅 2026-10-26：保存后不再直接返回——继续支持把**整篇识别内容**另存为 Word
      // （含未勾选的全部题目）；不导出则回上一页。
      Taro.showModal({
        title: `已存入错题库 ${picked.length} 题`,
        content: `可将整篇识别内容（共 ${drafts.length} 题）另存为 Word 文档`,
        confirmText: '另存 Word',
        cancelText: '完成',
        success: (m) => {
          if (m.confirm) void handleExportDocx()
          else setTimeout(() => Taro.navigateBack(), 200)
        },
      })
    } catch (e) {
      console.error('保存失败', e)
      Taro.showToast({ title: '保存失败', icon: 'none' })
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
      if (res?.url) openStorageFile(res.url, false, res.file_key)
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
      nudgeLoginIfAnonymous()
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

        {/* 学科选择（人工整理的粘贴栏内容也要入错题库，故 split 模式同样需要学科） */}
        <View className="flex flex-row items-center justify-between mb-4">
          <Text className="block text-sm text-muted-foreground">默认归类学科</Text>
          <Picker
            mode="selector"
            range={subjects}
            rangeKey="name"
            value={subjectIndex(defaultSubject)}
            onChange={(e) => setDefaultSubject(subjects[Number(e.detail.value)]?.id || '')}
          >
            <View className="bg-muted rounded-lg px-4 py-2">
              <Text className="block text-sm text-primary">{subjects.find((s) => s.id === defaultSubject)?.name || '点击选择'}</Text>
            </View>
          </Picker>
        </View>

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
              <View onClick={() => handleSaveImageDirect()} className="self-center rounded-lg border border-border px-3 py-1">
                <Text className="block text-xs text-primary">以图片形式直接保存到最近题目</Text>
              </View>
            </View>
          </Card>
        ) : mode === 'split' ? (
          <>
            {/* ⭐ 新流程（思傅 2026-10-20 定）：选图 → 在题目卡片「＋裁剪题目」框出本题 → 对该裁剪图 OCR → 勾选段落入题干。
                整页识别降级为次要入口（不裁剪、直接看全页文字时用）。 */}
            <Card className="rounded-2xl border-border p-4 mb-4">
              <View className="flex flex-row items-center justify-between mb-3">
                <Text className="block text-sm font-semibold text-foreground">来源页</Text>
                <Text className="block text-xs text-muted-foreground">先选图，再到下方题目里「＋裁剪题目」</Text>
              </View>
              {!curPage ? (
                <View className="w-full h-40 border-2 border-dashed border-border rounded-xl flex items-center justify-center" onClick={() => void addBoardPages()}>
                  <View className="flex flex-col items-center">
                    <Text className="block text-sm text-muted-foreground">点击拍照 / 选择作业图片</Text>
                    <Text className="block text-xs text-muted-foreground mt-1">支持一次多选，再从图里逐题裁剪</Text>
                  </View>
                </View>
              ) : (
                <>
                  {/* 来源图：点击 = 打开这张图并可编辑（思傅 2026-10-21 定）。
                      看大图（多页连续预览）保留为下方独立入口；「＋裁剪题目」仍在下方题目卡片。 */}
                  <View className="rounded-xl overflow-hidden bg-muted mb-2" style={{ height: 260, position: 'relative' }}>
                    <TaroImage
                      src={curPage.url}
                      mode="aspectFit"
                      style={{ width: '100%', height: '100%' }}
                      onClick={() => setPageEditImg({ pageIdx: activePage, url: curPage.url })}
                    />
                    <View
                      onClick={() => setPageEditImg({ pageIdx: activePage, url: curPage.url })}
                      style={{
                        position: 'absolute', right: 8, bottom: 8,
                        paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 999,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 12 }}>编辑</Text>
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
                            border: `2px solid ${i === activePage ? BRAND : '#ece8e0'}`,
                          }}
                        >
                          <TaroImage src={p.url} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                          {p.ocr === 'busy' ? (
                            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center' }}>
                              <Text style={{ fontSize: 8, color: '#fff' }}>识别中</Text>
                            </View>
                          ) : null}
                          {p.ocr === 'error' ? (
                            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16, 185, 129,0.75)', alignItems: 'center' }}>
                              <Text style={{ fontSize: 8, color: BRAND_FOREGROUND }}>识别失败</Text>
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
                    <Text className="block text-xs text-muted-foreground">点图片可编辑 · 共 {boardPages.length} 页</Text>
                    <View className="flex flex-row items-center gap-3">
                      <View
                        className="rounded-lg border border-border px-2 py-1"
                        onClick={() => Taro.previewImage({ urls: boardPages.map((p) => p.url), current: curPage.url })}
                      >
                        <Text className="block text-xs text-primary">看大图</Text>
                      </View>
                      {curPage.ocr === 'error' ? (
                        <Text className="block text-xs" style={{ color: BRAND_TEXT }} onClick={() => void retryPageOcr(activePage)}>
                          重新识别本页
                        </Text>
                      ) : null}
                      <View className="rounded-lg border border-border px-2 py-1" onClick={() => void addBoardPages()}>
                        <Text className="block text-xs text-primary">添加图片</Text>
                      </View>
                    </View>
                  </View>

                  {/* OCR 诊断入口：识别异常时一键自查端口·侧车·引擎是否就绪（显眼样式，避免找不到） */}
                  <View
                    className="flex-row items-center justify-center mt-2 py-2 px-3 rounded-lg"
                    style={{
                      backgroundColor: 'rgba(16, 185, 129,0.08)',
                      borderWidth: 1,
                      borderColor: 'rgba(16, 185, 129, 0.25)',
                    }}
                    onClick={() => { if (!diagLoading) void handleDiagnose() }}
                  >
                    <Text
                      className="block text-xs"
                      style={{ color: diagLoading ? '#B08D84' : BRAND_TEXT, fontWeight: '500' }}
                    >
                      {diagLoading ? '诊断中…（约 30 秒）' : 'OCR 识别异常？点此「一键诊断」'}
                    </Text>
                  </View>

                </>
              )}
            </Card>

            {/* 题目清单：每题 = 裁剪图 + 本题 OCR 段落 + 题干（① 裁剪 ② 识别 ③ 勾选入题干） */}
            <Card className="rounded-2xl border-border p-4 mb-4">
              <View className="flex flex-row items-center justify-between mb-2">
                <Text className="block text-sm font-semibold text-foreground">题目（{board.length} 题）</Text>
                <Text className="block text-xs text-muted-foreground">① 裁剪题目 ② 识别本题（可选）③ 勾选入题干 · 点图=打开编辑</Text>
              </View>
              {board.map((e, idx) => (
                <View key={e.id} className="rounded-xl p-3 mb-3" style={{ backgroundColor: '#fff', border: `1px solid ${cropEditor?.entryIdx === idx ? BRAND : '#ece8e0'}` }}>
                  <View className="flex flex-row items-center justify-between mb-2">
                    <View className="flex flex-row items-center gap-2">
                      <Text className="block text-xs font-medium text-foreground">第 {idx + 1} 题</Text>
                      {cropEditor?.entryIdx === idx ? (
                        <Text className="block text-xs" style={{ color: BRAND_TEXT }}>裁剪中…</Text>
                      ) : e.ocr === 'busy' ? (
                        <Text className="block text-xs" style={{ color: BRAND_TEXT }}>识别中…</Text>
                      ) : null}
                    </View>
                    <View className="flex flex-row items-center gap-3">
                      <Text className="block text-xs text-muted-foreground" onClick={() => moveEntry(idx, -1)}>上移</Text>
                      <Text className="block text-xs text-muted-foreground" onClick={() => moveEntry(idx, 1)}>下移</Text>
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }} onClick={() => removeEntry(idx)}>删除</Text>
                    </View>
                  </View>

                  {/* ① 裁剪图组 + 裁剪入口 */}
                  <View className="flex flex-row items-center flex-wrap gap-2 mb-2">
                    {e.images.map((img, j) => (
                      <View key={j} style={{ width: 64, height: 64, borderRadius: 8, overflow: 'hidden', position: 'relative', border: `1px solid ${j === 0 ? BRAND : '#ece8e0'}` }}>
                        <TaroImage
                          src={img.url}
                          mode="aspectFill"
                          style={{ width: '100%', height: '100%' }}
                          onClick={() => setEditImg({ entryIdx: idx, imgIdx: j, url: img.url })}
                        />
                        <View
                          onClick={() => removeEntryImage(idx, j)}
                          style={{
                            position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 999,
                            backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          <Text style={{ color: '#fff', fontSize: 12, lineHeight: '14px' }}>×</Text>
                        </View>
                      </View>
                    ))}
                    <View
                      onClick={() => startCrop(idx)}
                      className="flex flex-col items-center justify-center"
                      style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed #C9C2B8' }}
                    >
                      <Text style={{ fontSize: 14, color: BRAND_TEXT, lineHeight: '16px' }}>＋</Text>
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>裁剪题目</Text>
                    </View>
                  </View>

                  {/* ② 对裁剪出的题目图做 OCR（有图才出现；裁完会自动跑一次快速识别） */}
                  {e.images.length ? (
                    <View className="flex flex-row items-center gap-2 mb-2">
                      <View
                        className="flex-1 rounded-xl flex flex-col items-center justify-center py-2"
                        style={{
                          backgroundColor: '#FFF7F0',
                          border: '1px solid rgba(16, 185, 129, 0.25)',
                          opacity: e.ocr === 'busy' ? 0.5 : 1,
                        }}
                        onClick={() => {
                          if (e.ocr === 'busy') return
                          void runEntryOcr(idx, 'fast')
                        }}
                      >
                        <Text className="block text-xs font-medium" style={{ color: BRAND_TEXT }}>
                          {e.ocr === 'busy' && e.lastMode === 'fast' ? '识别中…' : '识别本题（快速）'}
                        </Text>
                      </View>
                      <View
                        className="flex-1 rounded-xl flex flex-col items-center justify-center py-2"
                        style={{ backgroundColor: BRAND, opacity: e.ocr === 'busy' ? 0.5 : 1 }}
                        onClick={() => {
                          if (e.ocr === 'busy') return
                          void runEntryOcr(idx, 'precise')
                        }}
                      >
                        <Text className="block text-xs font-medium text-brand-foreground">
                          {e.ocr === 'busy' && e.lastMode !== 'fast' ? '识别中…' : '识别本题（精准）'}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <Text className="block text-xs text-muted-foreground mb-2">
                      点上方「＋裁剪题目」，从来源页框出这道题的区域；不需要文字可直接存入错题库
                    </Text>
                  )}

                  {/* ③ 本题 OCR 段落：勾选 → 直接进本题题干（不再经剪贴板中转） */}
                  {e.segments.length ? (
                    <View
                      className="rounded-xl overflow-hidden mb-2"
                      style={{ height: 200, border: '1px solid #ece8e0' }}
                    >
                      <WrongqOcrPanel
                        segments={e.segments}
                        title="本题文字"
                        busy={e.ocr === 'busy'}
                        error={e.ocr === 'error' ? e.err : undefined}
                        saveLabel="加入题干"
                        onPasteToEntry={(t) => appendSegmentsToEntry(idx, t)}
                      />
                    </View>
                  ) : null}

                  <View className="bg-muted rounded-xl p-2">
                    <Textarea
                      className="min-h-20 border-0 ring-0 focus-within:ring-0 rounded-lg"
                      value={e.text}
                      placeholder="点上方段落的「加入题干」自动填入，也可手动输入 / 长按粘贴"
                      maxlength={-1}
                      onInput={(ev) => setEntryText(idx, ev.detail.value)}
                    />
                  </View>
                </View>
              ))}
              <View onClick={addEntry} className="w-full h-10 rounded-xl flex items-center justify-center" style={{ border: '1px dashed #C9C2B8' }}>
                <Text className="block text-xs text-primary">＋ 添加题目</Text>
              </View>

              {/* ⭐ 整页识别 = 次要入口（思傅 2026-10-21 要求移到「＋添加题目」下方）：
                  主流程是上方的「裁剪题目 → 识别本题 → 加入题干」——文字天然属于本题，不会图文分家；
                  只有不想裁剪、直接看全页文字时才用这里，存文字时务必选「·有图」的同一道题。 */}
              {curPage ? (
                <View className="w-full mt-3 pt-3" style={{ borderTopWidth: 0.5, borderTopColor: '#f0ece4', borderTopStyle: 'solid' }}>
                  <View className="flex flex-row items-center gap-2">
                    <View
                      className="flex-1 rounded-xl flex flex-col items-center justify-center py-2"
                      style={{
                        backgroundColor: '#FFF7F0',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                        opacity: boardBusy || curPage.ocr === 'busy' ? 0.5 : 1,
                      }}
                      onClick={() => {
                        if (boardBusy || curPage.ocr === 'busy') return
                        void runPageOcr(curPage, 'fast')
                      }}
                    >
                      <Text className="block text-xs font-medium" style={{ color: BRAND_TEXT }}>
                        {curPage.ocr === 'busy' && curPage.lastMode === 'fast' ? '整页快速识别中…' : '整页快速识别'}
                      </Text>
                    </View>
                    <View
                      className="flex-1 rounded-xl flex flex-col items-center justify-center py-2"
                      style={{
                        backgroundColor: BRAND,
                        opacity: boardBusy || curPage.ocr === 'busy' ? 0.5 : 1,
                      }}
                      onClick={() => {
                        if (boardBusy || curPage.ocr === 'busy') return
                        void runPageOcr(curPage, 'precise')
                      }}
                    >
                      <Text className="block text-xs font-medium text-brand-foreground">
                        {curPage.ocr === 'busy' && curPage.lastMode !== 'fast' ? '整页精准识别中…' : '整页精准识别'}
                      </Text>
                    </View>
                  </View>
                  <Text className="block text-xs text-muted-foreground mt-1">
                    次要入口：整页识别会把本页换成摆正后的图；文字请存入「·有图」的同一道题，避免图文分家
                  </Text>
                  {curPage.segments.length ? (
                    <View className="rounded-xl overflow-hidden mt-2" style={{ height: 220, border: '1px solid #ece8e0' }}>
                      <WrongqOcrPanel
                        segments={curPage.segments}
                        title="整页文字"
                        pageLabel={`第 ${activePage + 1}/${boardPages.length} 页`}
                        busy={curPage.ocr === 'busy'}
                        error={curPage.err}
                        onPasteToEntry={handlePasteToEntry}
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Card>
          </>
        ) : (
          <Card className="rounded-2xl border-border p-4 mb-4">
            <Text className="block text-xs text-muted-foreground mb-3">
              支持 PDF / Word(.docx) / TXT：先「导入」文档，再「识别题目」；识别结果自行确认后，自选是否存入错题库
            </Text>
            {docName ? (
              <View className="w-full bg-muted rounded-xl px-4 py-4 mb-3" onClick={chooseDocFile}>
                <Text className="block text-sm text-primary break-all">{docName}</Text>
                <Text className="block text-xs text-muted-foreground mt-1">
                  {docUrl ? '已导入 ✓ 可点「识别题目」' : docFile ? '已选择，点「导入」上传' : ''}
                </Text>
              </View>
            ) : (
              <View className="w-full h-28 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-3" onClick={chooseDocFile}>
                <Text className="block text-sm text-muted-foreground">点击选择文档文件（PDF/Word/TXT）</Text>
              </View>
            )}
            <View className="flex flex-row items-center gap-2">
              <Button
                className="flex-1 h-11 rounded-xl"
                variant="outline"
                disabled={docImporting || !docFile}
                onClick={handleImportDoc}
              >
                <Text className="block text-sm">{docImporting ? '导入中…' : docUrl ? '重新导入' : '导入'}</Text>
              </Button>
              <Button className="flex-1 h-11 rounded-xl" disabled={loading || !docUrl} onClick={handleRecognizeDoc}>
                <Text className="block text-sm">{loading ? '识别中…' : '识别题目'}</Text>
              </Button>
            </View>
            {/* #112 置灰原因动态提示：原来「识别题目」灰着没有任何说明，用户找不到入口 */}
            {!docUrl ? (
              <Text className="block text-xs text-muted-foreground mt-2 text-center">
                {docFile ? '已选择文件：请先点「导入」上传，再点「识别题目」' : '请先选择文档文件（或从资料库选择），点「导入」后再识别题目'}
              </Text>
            ) : null}
            <View className="flex items-center justify-center mt-3" onClick={() => setPicker(true)}>
              <Text className="block text-xs text-primary rounded-lg border border-border px-3 py-1">从资料库选择文档</Text>
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
              <Text className="block text-sm font-semibold text-foreground">
                识别结果（{drafts.length} 题，已选 {drafts.filter(isDraftSelected).length} 题）
              </Text>
              {mode === 'split' && !showEditor && (questionUrl || questionImage) ? (
                <View className="rounded-lg border border-border px-2 py-1" onClick={() => setShowEditor(true)}>
                  <Text className="block text-xs text-primary">校对圈定范围</Text>
                </View>
              ) : null}
            </View>
            <Text className="block text-xs text-muted-foreground mb-2">
              序号按文档印刷题号匹配（无题号时按列表顺序）；导出 Word 不受勾选影响，仍为全部 {drafts.length} 题
            </Text>

            {/* #109 序号快选：题号 = 列表显示顺序「第 N 题」，支持 3,5,8-12 */}
            <View className="flex flex-row items-center gap-2 mb-3">
              <View className="flex-1 h-9 rounded-xl border border-border bg-white flex flex-row items-center px-3">
                <Input
                  className="flex-1 text-sm"
                  value={seqInput}
                  placeholder="如 3,5,8-12"
                  placeholderClass="text-muted-foreground"
                  onInput={(e) => setSeqInput(e.detail.value)}
                  onConfirm={() => applySeqSelection()}
                />
              </View>
              <View className="h-9 px-3 rounded-xl bg-muted flex items-center justify-center" onClick={() => applySeqSelection()}>
                <Text className="block text-xs font-medium" style={{ color: BRAND_TEXT }}>应用</Text>
              </View>
              <View className="h-9 px-3 rounded-xl bg-muted flex items-center justify-center" onClick={selectAllDrafts}>
                <Text className="block text-xs text-primary">全选</Text>
              </View>
              <View className="h-9 px-3 rounded-xl bg-muted flex items-center justify-center" onClick={clearDraftSelection}>
                <Text className="block text-xs text-primary">清空</Text>
              </View>
              <View className="h-9 px-3 rounded-xl bg-muted flex items-center justify-center" onClick={invertDraftSelection}>
                <Text className="block text-xs text-primary">反选</Text>
              </View>
              {/* 思傅 2026-10-26：勾选 ≥2 题（相同学科）可合并为一题 */}
              {drafts.filter(isDraftSelected).length >= 2 && (
                <View className="h-9 px-3 rounded-xl bg-muted flex items-center justify-center" onClick={mergeSelectedDrafts}>
                  <Text className="block text-xs text-primary">合并</Text>
                </View>
              )}
            </View>
            {drafts.map((d, idx) => (
              <Card key={idx} className="rounded-2xl border-border p-4 mb-3">
                <View className="flex flex-row items-center justify-between mb-3">
                  <View className="flex flex-row items-center gap-2">
                    {/* #109：勾选存入错题库（父题勾选联动子题）；负 margin 保持与原文字对齐 */}
                    <View
                      onClick={() => toggleDraftSelected(idx)}
                      style={{ padding: 6, marginLeft: -6, marginTop: -6, marginBottom: -6 }}
                      className="flex items-center justify-center"
                    >
                      <CheckDot checked={isDraftSelected(d)} />
                    </View>
                    <Text className="block text-xs text-muted-foreground">第 {idx + 1} 题</Text>
                    {d.question_label ? (
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>{d.question_label}</Text>
                    ) : null}
                    {d.level === 2 ? (
                      <Text className="block text-xs" style={{ color: BRAND_TEXT }}>小题（已含大题题干）</Text>
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
                      <View className="rounded-lg border border-border px-2 py-1">
                        <Text className="block text-xs text-primary">{subjectName(d.subject_id)}</Text>
                      </View>
                    </Picker>
                    <Text className="block text-xs text-muted-foreground" onClick={() => removeDraft(idx)}>删除</Text>
                  </View>
                </View>

                <View className="bg-muted rounded-xl p-3 mb-2">
                  <Textarea
                    className="min-h-24 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.question_content}
                    placeholder="题目内容（可手动修改）"
                    maxlength={-1}
                    onInput={(e) => updateDraft(idx, { question_content: e.detail.value })}
                  />
                </View>

                {d.wrong_answer ? (
                  <Text className="block text-xs text-muted-foreground mb-2 line-through">原错答：{d.wrong_answer}</Text>
                ) : null}

                <View className="rounded-xl p-3 mb-1 border" style={{ borderColor: 'rgba(16, 185, 129,0.25)', backgroundColor: 'rgba(16, 185, 129, 0.08)' }}>
                  <Textarea
                    className="min-h-20 border-0 ring-0 focus-within:ring-0 rounded-lg"
                    value={d.answer_content}
                    placeholder="正确答案（可手动修改，无则留空后联网搜题）"
                    maxlength={-1}
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
          <Text className="block text-xs text-muted-foreground shrink-0">
            已选 {drafts.filter(isDraftSelected).length}/{drafts.length} 题
          </Text>
          <Button
            className="flex-1 h-11 rounded-xl"
            variant="outline"
            disabled={exporting || saving}
            onClick={handleExportDocx}
          >
            <Text className="block text-sm">{exporting ? '生成中…' : '导出 Word'}</Text>
          </Button>
          <Button
            className="flex-1 h-11 rounded-xl"
            disabled={saving || !drafts.some(isDraftSelected)}
            onClick={handleSave}
          >
            <Text className="block text-sm">
              {saving ? '保存中…' : `存入错题库（${drafts.filter(isDraftSelected).length}）`}
            </Text>
          </Button>
        </View>
      )}

      {/* #150 人工整理：粘贴栏底部操作条（有内容才出现）：入库 / Word / 打印 */}
      {mode === 'split' && board.some((e) => e.text.trim() || e.images.length) ? (
        <View style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: '12px 16px', backgroundColor: '#fff', borderTop: '1px solid #ece8e0', zIndex: 100,
        }}
        >
          <View className="flex flex-row items-center gap-3">
            <Text className="block text-xs text-muted-foreground shrink-0">共 {board.length} 题</Text>
            <Button
              className="flex-1 h-11 rounded-xl"
              disabled={saving || exporting}
              onClick={handleBoardSave}
            >
              <Text className="block text-sm">{saving ? '保存中…' : '存入错题库'}</Text>
            </Button>
          </View>
          <View className="flex flex-row items-center gap-3">
            <Button
              className="flex-1 h-9 rounded-xl"
              variant="outline"
              disabled={exporting || saving}
              onClick={handleBoardExport}
            >
              <Text className="block text-xs">{exporting ? '生成中…' : '导出 Word'}</Text>
            </Button>
            <Button
              className="flex-1 h-9 rounded-xl"
              variant="outline"
              disabled={exporting || saving}
              onClick={handleBoardPrint}
            >
              <Text className="block text-xs">打印</Text>
            </Button>
          </View>
        </View>
      ) : null}

      {/* #150 OCR 诊断结果弹层 */}
      {(diagText !== null || diagError !== null) ? (
        <View style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 200,
          display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 16,
        }}
          onClick={() => { setDiagText(null); setDiagError(null) }}
        >
          <View
            style={{
              backgroundColor: '#fff', borderRadius: 12, maxHeight: '80vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={(e) => { e?.stopPropagation?.() }}
          >
            <View style={{ padding: '12px 16px', borderBottom: '1px solid #ece8e0' }}>
              <Text className="block text-sm font-medium">OCR 诊断结果</Text>
            </View>
            <ScrollView scrollY style={{ padding: 16, fontSize: 12, lineHeight: '1.7' }}>
              {diagError ? (
                <Text style={{ color: BRAND_TEXT }}>{diagError}</Text>
              ) : (
                <Text style={{ whiteSpace: 'pre-wrap', color: '#333', fontSize: 12 }}>{diagText}</Text>
              )}
            </ScrollView>
            <View style={{ padding: 12, borderTop: '1px solid #ece8e0' }}>
              <Button className="h-9 rounded-xl" variant="outline" onClick={() => { setDiagText(null); setDiagError(null) }}>
                <Text className="block text-xs">关闭</Text>
              </Button>
            </View>
          </View>
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
          cropTargetLabel={`图片将存入：第 ${cropEditor.entryIdx + 1} 题`}
          enableSaveToInbox={false}
          onCancel={() => setCropEditor(null)}
          onConfirm={(p) => void handleCropConfirm(p)}
        />
      ) : null}

      {/* 题目卡点开已裁剪的图 → 全功能编辑器（思傅 2026-10-21：裁剪/旋转/灰度/高清）。
          点「保存并替换原图」原位替换该题这张图（handleEntryImgEdited），不新建条目。 */}
      {editImg ? (
        <ImageEditor
          visible
          src={editImg.url}
          enableSaveToInbox={false}
          confirmText="保存并替换原图"
          onCancel={() => setEditImg(null)}
          onConfirm={(p) => void handleEntryImgEdited(p)}
        />
      ) : null}

      {/* 来源页点开图片 → 全功能编辑器（思傅 2026-10-21）：裁剪/旋转/灰度/高清，
          点「保存并替换原图」原位替换该来源页（handlePageImgEdited），不新建条目。 */}
      {pageEditImg ? (
        <ImageEditor
          visible
          src={pageEditImg.url}
          enableSaveToInbox={false}
          confirmText="保存并替换原图"
          onCancel={() => setPageEditImg(null)}
          onConfirm={(p) => void handlePageImgEdited(p)}
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
      {Icon ? <Icon size={14} color={INK} /> : null}
      <Text className="block text-xs text-primary">{label}</Text>
    </View>
  )
}
