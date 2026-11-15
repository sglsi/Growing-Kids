import { View, Text, ScrollView, Image, Swiper, SwiperItem } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { FileText, Trash2, Upload, Ellipsis } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyCard, BottomActionBar, ActionBtn } from '@/components/filter-header'
import { Input } from '@/components/ui/input'
import SelectionBar, { CheckDot } from '@/components/selection-bar'
import { confirmDelete, useSelection } from '@/lib/use-selection'
import RenameDialog from '@/components/rename-dialog'
import SubjectPickerSheet from '@/components/subject-picker-sheet'
import { openStorageFile, isPdfFile } from '@/services/net'
import {
  fetchLibrary, deleteLibraryDoc, batchDeleteLibrary, fetchSubjects, uploadFile, renameLibraryDoc, updateLibraryDoc,
  combineLibraryImages, getSettings,
  type LibraryDoc, type Subject, type Paged, type GradeScope,
} from '@/services/api'
import { gradeLabel } from '@/constants/grades'
import { cacheGet, cacheSet, cacheListKey } from '@/services/cache'
import { getSubjectColor, formatTime } from '@/types'
import { INK, BRAND_FOREGROUND } from '@/lib/theme'
import { guardPrivacy, reportChooseFail } from '@/utils/privacy'
import { guardPolicy } from '@/services/policy-gate'

/** 按 mime 推断资料类型标签（思傅 2026-10-24：图片入库后需要区分） */
function getTypeLabel(mime: string | null, name: string): string {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return '图片'
  if (isPdfFile(m || name)) return 'PDF'
  if (m.includes('word') || /\.docx?$/i.test(name)) return 'Word'
  if (m.includes('text') || /\.txt$/i.test(name)) return 'TXT'
  // 2026-11-02：「文档」这个词在产品文案里统一改称「资料」
  return '资料'
}

function isImageDoc(mime: string | null): boolean {
  return (mime || '').toLowerCase().startsWith('image/')
}

/** 生成图片默认名（chooseImage 不返回原始文件名，微信只给临时路径） */
function genImageName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `图片_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** D-063：一次最多合成多少张，与后端 MAX_COMBINE_IMAGES 保持一致 */
const MAX_COMBINE_IMAGES = 20

interface PickedImage {
  id: number
  path: string
  /** 微信 chooseMedia 通常不返回原始文件名；只有拿到才用于自然数字序兜底 */
  name: string
}

/** D-064：删除不真删，记下原位放进页面下部临时框，随时可加回（防误删） */
interface RemovedImage extends PickedImage {
  fromIndex: number
}

interface CellRect { left: number; top: number; right: number; bottom: number }

/** 预览层 Swiper 在小程序里必须有确定高度；取一次视口高度即可（数字值 = 真实 px） */
const SCREEN_H = (() => {
  try { return Taro.getSystemInfoSync().windowHeight } catch { return 667 }
})()

/** 拖到哪个格子就占哪个格子；纯函数，便于守卫与实证断言 */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return list
  const next = [...list]
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}

function genCombineName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `图片合成_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`
}

/** 自然数字序：1、2、10 而不是 1、10、2 */
function naturalCompare(a: string, b: string): number {
  const ax = a.split(/(\d+)/)
  const bx = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const an = ax[i] || ''
    const bn = bx[i] || ''
    if (/^\d+$/.test(an) && /^\d+$/.test(bn)) {
      const d = Number(an) - Number(bn)
      if (d) return d
    } else {
      const c = an.localeCompare(bn, 'zh-CN', { numeric: true })
      if (c) return c
    }
  }
  return 0
}

/**
 * 自动排序（Q2「选择顺序＋数字序兜底」）：
 * 以用户勾选/拍摄的先后为主；只有**每张图都带可区分的真实文件名**时，
 * 才按自然数字序兜底（微信 chooseMedia 不给文件名、EXIF 常被剥离，
 * 所以多数机型走选择顺序——结果可预测、不会把顺序排乱）。
 */
function autoSortPicked(items: PickedImage[]): PickedImage[] {
  const names = items.map((x) => x.name.trim())
  const usable = names.every(Boolean) && new Set(names).size === names.length
  if (!usable) return items
  return items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => naturalCompare(names[a.idx], names[b.idx]) || a.idx - b.idx)
    .map((x) => x.it)
}

/**
 * 资料库：外部 PDF / Word / TXT / 图片
 * v4 新增页面，对应后端 GET /api/library
 */
export default function LibraryPage() {
  const [docs, setDocs] = useState<LibraryDoc[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [loading, setLoading] = useState(true)
  /**
   * 总条数与分页游标（GK-23-22）：原实现固定 `pageSize: 100` 单次拉完，
   * 超过 100 份**静默截断**——界面写「共 100 份资料」却和实际不符，用户以为丢了。
   * 现在按页取、滚到底追加，条数用后端 total（真实总数）。
   */
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [renameTarget, setRenameTarget] = useState<LibraryDoc | null>(null)
  const [assignTarget, setAssignTarget] = useState<LibraryDoc | null>(null)
  /**
   * 年级口径（P-005，与首页题目检索完全一致）：
   *   userGrade   = 用户当前年级（设置页可改），决定默认筛到哪个年级
   *   gradeFilter = 本次实际生效的年级；null = 不加年级条件（"显示全部年级"）
   *   gradeScope  = 后端告诉你实际用了哪几档（本年级 0 命中时才扩散）
   * ⚠️ 绝不因为年级筛掉资料不给出路：标题行右侧永远有"显示全部年级"的开关。
   */
  const [userGrade, setUserGrade] = useState<number | null>(null)
  const [gradeFilter, setGradeFilter] = useState<number | null>(null)
  const [gradeScope, setGradeScope] = useState<GradeScope | null>(null)
  const sel = useSelection()

  /** D-063/D-064 多图合成：待排序图片、成品名、进行中与序号发号器 */
  const [composeVisible, setComposeVisible] = useState(false)
  const [composeItems, setComposeItems] = useState<PickedImage[]>([])
  const [composeName, setComposeName] = useState('')
  const [composeBusy, setComposeBusy] = useState(false)
  const composeSeq = useRef(0)
  /** D-064：删除暂存区、预览游标、两段确认（确定 → 复核 → 开始合成） */
  const [removedItems, setRemovedItems] = useState<RemovedImage[]>([])
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  /** 长按拖拽：dragFrom 为起点（也表示「待落点」态），dragTo 为当前命中格子 */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragTo, setDragTo] = useState<number | null>(null)
  /** 手指按住期间锁住 ScrollView 滚动，避免拖拽与页面滚动打架 */
  const [dragging, setDragging] = useState(false)
  const cellRects = useRef<CellRect[]>([])
  const longPressedRef = useRef(false)

  /** 每页条数：滚到底追加，避免一次拉太多在慢网上白等 */
  const PAGE_SIZE = 30

  /**
   * 加载资料库。
   * ⚠️ silent（思傅 2026-10-23：与首页/复习本同一规则）：
   * 删除/上传后缓存已失效，非 silent 的 load 会 setLoading(true) → 骨架屏替换列表 →
   * ScrollView 内容塌缩 → 滚动位置被钳到顶部。silent = 旧列表留屏，后台静默替换。
   */
  const load = async (
    opts: { keyword?: string; subjectId?: string; silent?: boolean; append?: boolean; grade?: number | null } = {},
  ) => {
    // SWR（思傅 2026-10-21）：先同步读缓存渲染，再后台刷新回写
    const kw = (opts.keyword !== undefined ? opts.keyword : keyword) || undefined
    const sid = opts.subjectId || undefined
    const grade = opts.grade === undefined ? gradeFilter : opts.grade
    const append = opts.append === true
    const nextPage = append ? page + 1 : 1
    // 追加页不进缓存（key 会膨胀，且意义小），只缓存第一页
    // ⚠️ 缓存 key 必须带 grade：否则切年级会命中上一个年级的缓存，看着像"筛了没用"
    const listKey = append ? '' : cacheListKey('lib', { keyword: kw || '', subjectId: sid || '', grade: grade ?? '', pageSize: PAGE_SIZE })
    if (!append) {
      const cached = listKey ? cacheGet<Paged<LibraryDoc>>(listKey) : null
      if (cached) {
        setDocs(cached.list)
        setTotal(cached.total)
        setPage(cached.page || 1)
        setGradeScope(cached.grade_scope ?? null)
        setLoading(false)
      } else if (!opts.silent) {
        setLoading(true)
      }
    }
    if (append) setLoadingMore(true)
    try {
      const res = await fetchLibrary({
        keyword: kw,
        subjectId: sid,
        // 未选年级 / 已"显示全部年级"时传 undefined —— 后端不加任何年级条件，绝不拦截
        grade: grade ?? undefined,
        page: nextPage,
        pageSize: PAGE_SIZE,
      })
      setDocs((prev) => (append ? [...prev, ...res.list] : res.list))
      setTotal(res.total)
      setPage(res.page || nextPage)
      if (!append) setGradeScope(res.grade_scope ?? null)
      if (listKey) cacheSet(listKey, res)
    } catch (e) {
      console.error('加载资料库失败', e)
      // 追加失败只说「加载更多失败」，不要把已有列表清成空态
      if (append) Taro.showToast({ title: '加载更多失败，请重试', icon: 'none' })
      else if (!opts.silent) Taro.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  /** 滚到底追加下一页；没有更多时直接返回（不发空请求） */
  const loadMore = () => {
    if (loading || loadingMore) return
    if (docs.length >= total) return
    void load({ append: true })
  }

  useDidShow(() => {
    sel.exit()
    // 学科列表也走缓存（少一次请求；变化时 api.ts 已失效 subj 域）
    const cachedSubs = cacheGet<Subject[]>('subj:list')
    if (cachedSubs) setSubjects(cachedSubs)
    fetchSubjects()
      .then((s) => {
        setSubjects(s)
        if (s.length) cacheSet('subj:list', s)
      })
      // ⚠️ best-effort 的 catch 必须打全错（工程规范第 7 章第 2 条）：
      // 空 catch 会把「服务不可用」伪装成「资料未分类」，排查时无从下手。
      .catch((e) => console.error('[library] 学科列表加载失败', e))
    /**
     * 年级对齐后再拉列表。
     * ⚠️ 多这一次请求是为了首屏就是"筛过的"——若先 load() 再改 grade，
     * 用户会看到全量列表闪一下再被筛掉，像数据错乱。设置接口挂在 /api/settings，
     * 与列表并行发出、体积很小，代价可接受。
     */
    getSettings()
      .then((s) => {
        const g = s.grade ?? null
        setUserGrade(g)
        setGradeFilter(g)
        void load({ grade: g })
      })
      .catch((e) => {
        // 取不到年级不能让资料库打不开：退回"不加年级条件"的全量列表
        console.error('[library] 年级设置加载失败，按全部年级展示', e)
        setUserGrade(null)
        setGradeFilter(null)
        void load({ grade: null })
      })
  })

  const handleOpen = (d: LibraryDoc) => {
    if (sel.selecting) { sel.toggle(d.id); return }
    // 图片不经过 openStorageFile 的 PDF/文档逻辑，直接预览
    if (isImageDoc(d.mime_type)) {
      Taro.previewMedia({ sources: [{ url: d.url || '', type: 'image' }] })
      return
    }
    openStorageFile(d.url || '', isPdfFile(d.mime_type || d.name), d.file_key)
  }

  const handleDelete = async () => {
    if (sel.isEmpty) return
    const ok = await confirmDelete(sel.count, '份资料')
    if (!ok) return
    setBusy(true)
    try {
      await batchDeleteLibrary(Array.from(sel.selected))
      Taro.showToast({ title: '已删除', icon: 'success' })
      sel.exit()
      load({ silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleSingleDelete = async (d: LibraryDoc) => {
    const ok = await confirmDelete(1, '份资料')
    if (!ok) return
    try {
      await deleteLibraryDoc(d.id)
      Taro.showToast({ title: '已删除', icon: 'success' })
      load({ silent: true })
    } catch (e) {
      console.error(e)
      Taro.showToast({ title: '删除失败', icon: 'none' })
    }
  }

  const doUpload = async (filePath: string, fileName: string) => {
    Taro.showLoading({ title: '上传中…' })
    try {
      // 后端 /api/upload purpose=save + archive_to=library：图片也归档到资料库
      // ⚠️ 必须带 purpose=save：不带 purpose 后端只返回 URL、不落库、也不计入引用计数，
      //    表现为「提示已归档，但资料库里没有」。
      // #121：后端若发现同指纹内容已在本用户资料库里，会复用旧条目而非新建
      // （物理层早已去重，这里是业务条目层）⇒ 提示文案必须区分「新增」与「已存在」，
      // 否则用户会以为没存进去、反复上传。
      const up = await uploadFile(filePath, { purpose: 'save', archiveTo: 'library', fileName })
      Taro.hideLoading()
      if (up?.duplicated) {
        Taro.showToast({ title: up.restored ? '已存过，已为你恢复' : '这份已存过，无需重复归档', icon: 'none' })
      } else {
        Taro.showToast({ title: '已归档到资料库', icon: 'success' })
      }
      load({ silent: true })
    } catch (e) {
      Taro.hideLoading()
      console.error('上传失败', e)
      Taro.showToast({ title: '上传失败，请重试', icon: 'none' })
    }
  }

  const handleChooseDoc = async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择文档'))) return
    if (!(await guardPrivacy('选择文档'))) return
    try {
      const res = await Taro.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['pdf', 'doc', 'docx', 'txt'],
      })
      const f = res.tempFiles[0]
      await doUpload(f.path, f.name)
    } catch (e) {
      reportChooseFail(e, '选择文档', '请在小程序中从聊天/文件选择文档')
    }
  }

  const handleChooseImage = async () => {
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择图片'))) return
    if (!(await guardPrivacy('选择图片'))) return
    try {
      const res = await Taro.chooseImage({ count: 1, sourceType: ['album', 'camera'] })
      const f = res.tempFiles[0]
      // chooseImage 不返回原始文件名（只给临时路径）⇒ 生成时间戳名
      await doUpload(f.path, genImageName())
    } catch (e) {
      reportChooseFail(e, '选择图片', '选择图片失败')
    }
  }

  /**
   * D-063：多选图片 → 自动排序 → 手动调序 → 合成一份一图一页 PDF。
   * `append=true` 时把新拍的照片接在已调好的顺序之后，不重排用户已确认的部分。
   */
  const handleChooseImages = async (append = false) => {
    if (composeBusy || (append && confirmed)) return
    // GK-23-24：监护人同意（业务）→ 平台授权（基础库），两道闸门都要过
    if (!(await guardPolicy('选择图片'))) return
    if (!(await guardPrivacy('选择图片'))) return
    const room = MAX_COMBINE_IMAGES - (append ? composeItems.length : 0)
    if (room <= 0) {
      Taro.showToast({ title: `最多 ${MAX_COMBINE_IMAGES} 张`, icon: 'none' })
      return
    }
    try {
      const res = await Taro.chooseMedia({ count: room, mediaType: ['image'], sourceType: ['album', 'camera'] })
      const files = res.tempFiles || []
      if (!files.length) return
      const picked: PickedImage[] = files.map((f) => ({
        id: ++composeSeq.current,
        path: f.tempFilePath,
        // chooseMedia 标准返回里没有文件名；个别机型/基础库会带，用于数字序兜底
        name: String((f as unknown as Record<string, unknown>).name || '').trim(),
      }))
      if (append) {
        setComposeItems((prev) => [...prev, ...autoSortPicked(picked)])
      } else {
        setComposeItems(autoSortPicked(picked))
        setComposeName(genCombineName())
        setRemovedItems([])
        setConfirmed(false)
        setPreviewIndex(null)
        clearDrag()
        setComposeVisible(true)
      }
    } catch (e) {
      reportChooseFail(e, '选择图片', '选择图片失败')
    }
  }

  /** 顺序调整：拖到哪个格子就占哪个格子；nudgeCompose 是精确 ±1 的兜底 */
  const moveCompose = (from: number, to: number) => setComposeItems((prev) => moveItem(prev, from, to))
  const nudgeCompose = (index: number, delta: number) => moveCompose(index, index + delta)
  const clearDrag = () => { setDragFrom(null); setDragTo(null); setDragging(false) }

  /**
   * D-064：删除 = 移入页面下部临时框（不真删），记下原位，点 ＋ 就能加回。
   * ⚠️ 不在 setComposeItems 的 updater 里改另一个 state：updater 必须保持纯函数，
   *    否则 React 严格模式下重复执行会把同一张图塞进暂存区两次。
   */
  const removeCompose = (id: number) => {
    if (confirmed || composeBusy) return
    const idx = composeItems.findIndex((x) => x.id === id)
    if (idx < 0) return
    setRemovedItems((prev) => [...prev, { ...composeItems[idx], fromIndex: idx }])
    setComposeItems((prev) => prev.filter((x) => x.id !== id))
    clearDrag()
  }

  const restoreCompose = (id: number) => {
    if (confirmed || composeBusy) return
    const it = removedItems.find((x) => x.id === id)
    if (!it) return
    if (composeItems.length >= MAX_COMBINE_IMAGES) {
      Taro.showToast({ title: `最多 ${MAX_COMBINE_IMAGES} 张`, icon: 'none' })
      return
    }
    setRemovedItems((prev) => prev.filter((x) => x.id !== id))
    setComposeItems((prev) => {
      const next = [...prev]
      next.splice(Math.min(it.fromIndex, next.length), 0, { id: it.id, path: it.path, name: it.name })
      return next
    })
  }

  /** 长按拖拽：激活时抓一次各格子视口矩形，touchmove 用坐标命中落点 */
  const beginDrag = (index: number) => {
    longPressedRef.current = true
    // 触觉反馈不可用时不影响排序本身
    void Taro.vibrateShort().catch((e) => console.warn('[compose] 震动不可用', e))
    // 状态必须同步生效：查询矩形是异步的，若等回调再设，用户在回调前松手就会漏掉整次拖拽
    setDragFrom(index)
    setDragTo(index)
    setDragging(true)
    const q = Taro.createSelectorQuery()
    q.selectAll('.compose-cell').boundingClientRect()
    q.exec((res: unknown) => {
      const first = Array.isArray(res) ? res[0] : null
      cellRects.current = Array.isArray(first) ? (first as CellRect[]) : []
    })
  }

  /** Taro 的 ScrollView.onTouchMove 事件类型是 BaseEventOrig，touches 需自行窄化 */
  const updateDragTarget = (e: unknown) => {
    if (dragFrom === null) return
    const t = (e as { touches?: Array<{ clientX: number; clientY: number }> }).touches?.[0]
    if (!t) return
    const rects = cellRects.current
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      if (t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom) {
        if (i !== dragTo) setDragTo(i)
        return
      }
    }
  }

  const endDrag = () => {
    // 无条件解锁滚动：即使闭包里 dragFrom 还是旧值（快按快放），也不能把页面卡在不可滚动态
    setDragging(false)
    if (dragFrom === null) return
    // 手指真的拖到别的格子 → 松手即落位；只是长按没动 → 保持「待落点」，点目标格子也能完成
    if (dragTo !== null && dragTo !== dragFrom) {
      moveCompose(dragFrom, dragTo)
      clearDrag()
    }
  }

  const handleCellClick = (index: number) => {
    // 长按那一次触摸框架一般不派发 tap；万一派发了，这里吞掉，避免误开预览
    if (longPressedRef.current) { longPressedRef.current = false; return }
    if (dragFrom !== null) {
      if (index !== dragFrom) moveCompose(dragFrom, index)
      clearDrag()
      return
    }
    setPreviewIndex(index)
  }

  /** D-064：确定 = 锁住当前页序进入复核态；再点「开始合成」才真正上传 */
  const confirmCompose = () => {
    if (!composeItems.length) {
      Taro.showToast({ title: '请先添加至少 1 张图片', icon: 'none' })
      return
    }
    clearDrag()
    setPreviewIndex(null)
    setConfirmed(true)
    if (removedItems.length) {
      Taro.showToast({ title: `${removedItems.length} 张在待恢复区，不会合成`, icon: 'none' })
    }
  }

  const closeCompose = () => {
    if (composeBusy) return
    setComposeVisible(false)
    setComposeItems([])
    setRemovedItems([])
    setComposeName('')
    setConfirmed(false)
    setPreviewIndex(null)
    clearDrag()
  }

  /**
   * 串行上传 + 合成。
   * ⚠️ 微信 uploadFile 单次超时硬顶 60s，多图并行只会一起撞限流；每张上传都更新
   * showLoading 标题，避免「点了没反应」（#150 同款教训）。
   * 原图用 purpose=temp：不建条目、ref_count=0，24h 后由既有孤儿 GC 回收，
   * 资料库里最终只会出现**一份**成品（Q4）。
   * D-064：只有 confirmed 复核态才允许触发（防止调序途中误点合成）。
   */
  const doCombine = async () => {
    if (composeBusy || !confirmed || !composeItems.length) return
    setComposeBusy(true)
    const keys: string[] = []
    try {
      for (let i = 0; i < composeItems.length; i++) {
        Taro.showLoading({ title: `上传 ${i + 1}/${composeItems.length}`, mask: true })
        const up = await uploadFile(composeItems[i].path, { purpose: 'temp' })
        if (!up?.key) throw new Error('上传返回缺少 key')
        // 严格按当前列表顺序 push：后端把这个数组顺序当作 PDF 页序
        keys.push(up.key)
      }
      Taro.showLoading({ title: '正在合成…', mask: true })
      const doc = await combineLibraryImages(keys, composeName.trim() || genCombineName())
      Taro.hideLoading()
      setComposeVisible(false)
      setComposeItems([])
      setRemovedItems([])
      setConfirmed(false)
      setPreviewIndex(null)
      Taro.showToast({ title: `已合成 ${doc.images} 张图片`, icon: 'success' })
      load({ silent: true })
    } catch (e) {
      Taro.hideLoading()
      console.error('[library] 多图合成失败', e)
      Taro.showToast({ title: `合成失败：${e instanceof Error ? e.message.slice(0, 20) : '请重试'}`, icon: 'none' })
    } finally {
      setComposeBusy(false)
    }
  }

  const handleUpload = () => {
    Taro.showActionSheet({
      itemList: ['选择文档（PDF / Word / TXT）', '选择图片', '多张图片合成一份 PDF'],
    })
      .then((res) => {
        if (res.tapIndex === 0) handleChooseDoc()
        else if (res.tapIndex === 1) handleChooseImage()
        else if (res.tapIndex === 2) void handleChooseImages()
      })
      .catch(() => { /* 取消 */ })
  }

  /** 卡片「⋯」→ 重命名 / 归属学科 / 删除 */
  const handleMore = (d: LibraryDoc) => {
    if (sel.selecting) return
    Taro.showActionSheet({ itemList: ['重命名', '归属学科', '删除'] })
      .then((res) => {
        if (res.tapIndex === 0) setRenameTarget(d)
        else if (res.tapIndex === 1) setAssignTarget(d)
        else if (res.tapIndex === 2) handleSingleDelete(d)
      })
      .catch(() => { /* 取消 */ })
  }

  /**
   * 归属学科（思傅 2026-10-24 增加，2026-10-25 修「点击无反应」）。
   * ⚠️ 旧实现在一级 action sheet 的回调里紧接着弹第二个原生 sheet，
   * 真机上二级会被微信吞掉（一级未退场）⇒ 改为页内自定义弹层
   * SubjectPickerSheet（见该组件注释）。学科未分类哨兵 subject_id=null。
   */
  const handleSubjectPicked = async (subjectId: string | null) => {
    const d = assignTarget
    setAssignTarget(null)
    if (!d) return
    try {
      await updateLibraryDoc(d.id, { subject_id: subjectId })
      Taro.showToast({
        title: subjectId ? `已归入「${subjects.find((s) => s.id === subjectId)?.name || ''}」` : '已移出学科',
        icon: 'success',
      })
      load({ silent: true })
    } catch (e) {
      console.error('设置归属学科失败', e)
      Taro.showToast({ title: '设置失败，请重试', icon: 'none' })
    }
  }

  const handleRenameConfirm = async (value: string) => {
    if (!renameTarget) return
    // ⚠️ 必须捕获：原实现无 try/catch ⇒ 失败时弹层不关、无提示，像「点了没反应」，
    // 且 rejection 逃逸成 unhandled（2026-10-29 分模块测试修复）
    try {
      await renameLibraryDoc(renameTarget.id, value)
      setRenameTarget(null)
      Taro.showToast({ title: '已重命名', icon: 'success' })
      load({ silent: true })
    } catch (e) {
      console.error('[library] 重命名失败', e)
      Taro.showToast({ title: `重命名失败：${e instanceof Error ? e.message.slice(0, 30) : '请重试'}`, icon: 'none' })
    }
  }

  const getSubjectDot = (id: string | null) => {
    if (!id) return ''
    const s = subjects.find((x) => x.id === id)
    return s ? getSubjectColor(s.color).dot : ''
  }
  const getSubjectName = (id: string | null) => (id ? subjects.find((s) => s.id === id)?.name || '' : '')

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部 */}
      <View style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: '#fff', borderBottom: '1px solid #ecefe3', padding: '12px 16px 0' }}>
        {/* 本页已是 tabBar 页（导航栏标题「资料」），页内不再重复写标题 */}
        <View className="flex flex-row items-center justify-end mb-2">
          <View className="flex flex-row items-center gap-3">
            <SelectionBar selection={sel} enterLabel="批量选择" />
            {!sel.selecting && (
              <View
                className="flex flex-row items-center gap-1 rounded-xl bg-brand px-3 h-8"
                onClick={handleUpload}
              >
                <Upload size={14} color={BRAND_FOREGROUND} />
                <Text className="block text-sm text-brand-foreground">导入</Text>
              </View>
            )}
          </View>
        </View>
        <View className="flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9 mb-3">
          <View className="block text-xs text-muted-foreground" onClick={() => load({ keyword })}>🔍</View>
          <Input
            className="flex-1 text-sm bg-transparent"
            value={keyword}
            placeholder="搜索资料名称或内容"
            placeholderClass="text-muted-foreground"
            confirmType="search"
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={() => load({ keyword })}
          />
          {keyword ? (
            <View className="block text-xs text-muted-foreground" onClick={() => { setKeyword(''); load({ keyword: '' }) }}>清空</View>
          ) : null}
        </View>
      </View>

      <ScrollView scrollY style={{ height: '100vh', paddingTop: 92 }} onScrollToLower={loadMore} lowerThreshold={120}>
        <View className="px-4 pb-28 pt-3">
          {/* 年级口径说明 + 一键回到全量：筛掉的资料必须有一条随时能走回来的路 */}
          <View className="flex flex-row items-center justify-between mb-3">
            <Text className="block text-xs text-muted-foreground">
              共 {total} 份资料{docs.length < total ? `（已显示 ${docs.length}）` : ''}
            </Text>
            {userGrade ? (
              <View
                className="block text-xs text-brand-text"
                onClick={() => {
                  const next = gradeFilter === null ? userGrade : null
                  setGradeFilter(next)
                  void load({ grade: next })
                }}
              >
                {gradeFilter === null
                  ? '按年级筛选'
                  : gradeScope?.spread
                    ? '已扩展 · 显示全部'
                    : `${gradeLabel(gradeFilter)} · 显示全部`}
              </View>
            ) : null}
          </View>
          {loading ? (
            <View className="space-y-3">
              <Skeleton className="h-16 w-full rounded-2xl" />
              <Skeleton className="h-16 w-full rounded-2xl" />
            </View>
          ) : docs.length ? (
            <View className="space-y-2">
              {docs.map((d) => {
                const checked = sel.selected.has(d.id)
                const isImg = isImageDoc(d.mime_type)
                return (
                  <Card
                    key={d.id}
                    className={`flex flex-row items-center gap-3 rounded-2xl border p-4 ${checked ? 'border-brand-line bg-brand-soft' : 'border-border'}`}
                    onClick={() => handleOpen(d)}
                    onLongPress={() => sel.longPress(d.id)}
                  >
                    {sel.selecting && (
                      <CheckDot checked={checked} size={20} />
                    )}
                    <View className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-lg bg-muted overflow-hidden">
                      {isImg && (d.thumb_url || d.url) ? (
                        <Image
                          src={d.thumb_url || d.url || ''}
                          mode="aspectFill"
                          className="w-11 h-11"
                        />
                      ) : (
                        <FileText size={20} color={INK} />
                      )}
                    </View>
                    <View className="flex-1 min-w-0">
                      <View className="flex flex-row items-center gap-2">
                        {getSubjectDot(d.subject_id) ? (
                          <View className={`w-2 h-2 rounded-full flex-shrink-0 ${getSubjectDot(d.subject_id)}`} />
                        ) : null}
                        <Text className="block text-sm font-medium text-foreground truncate">{d.name}</Text>
                      </View>
                      <Text className="block text-xs text-muted-foreground mt-1">
                        {getTypeLabel(d.mime_type, d.name)}
                        {getSubjectName(d.subject_id) ? ` · ${getSubjectName(d.subject_id)}` : ''} · {formatTime(d.created_at)}
                        {/* 扩散时标出「不是本年级」的那份来自哪一档，避免用户以为是标错了 */}
                        {gradeScope?.spread && d.grade && d.grade !== gradeScope.requested ? ` · ${gradeLabel(d.grade)}` : ''}
                      </Text>
                    </View>
                    {!sel.selecting && (
                      <View className="p-2" onClick={(e) => { e.stopPropagation?.(); handleMore(d) }}>
                        <Ellipsis size={16} color="#bbb" />
                      </View>
                    )}
                  </Card>
                )
              })}
            </View>
          ) : (
            <EmptyCard
              title="资料库还是空的"
              hint="导入 PDF / Word / TXT / 图片，或在识别页导入文档，会自动归档到这里"
              actionLabel="导入文件"
              onAction={handleUpload}
            />
          )}
          {/* 分页哨兵：滚到底自动追加；没有更多时给一句明确收尾，别让用户以为是没加载出来 */}
          {docs.length > 0 && (
            <View className="py-4 flex items-center justify-center">
              {loadingMore ? (
                <Text className="block text-xs text-muted-foreground">加载更多…</Text>
              ) : docs.length < total ? (
                <View className="px-4 py-2 rounded-full bg-muted" onClick={loadMore}>
                  <Text className="block text-xs text-muted-foreground">加载更多（还有 {total - docs.length} 份）</Text>
                </View>
              ) : (
                <Text className="block text-xs text-muted-foreground">已经到底了</Text>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {sel.selecting && (
        <BottomActionBar>
          <View style={{ flex: 1 }}>
            <ActionBtn
              icon={<Trash2 size={16} color="#fff" />}
              label="删除选中"
              danger
              disabled={sel.isEmpty || busy}
              onClick={handleDelete}
            />
          </View>
        </BottomActionBar>
      )}

      {renameTarget && (
        <RenameDialog
          title="重命名资料"
          initialValue={renameTarget.name}
          onCancel={() => setRenameTarget(null)}
          onConfirm={handleRenameConfirm}
        />
      )}

      <SubjectPickerSheet
        visible={!!assignTarget}
        subjects={subjects}
        currentId={assignTarget?.subject_id ?? null}
        onCancel={() => setAssignTarget(null)}
        onSelect={handleSubjectPicked}
      />

      {/* D-063/D-064 多图合成：全屏排序页。序号就是 PDF 页序，一图一页。 */}
      {composeVisible && (
        <View
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100,
            backgroundColor: '#fff', display: 'flex', flexDirection: 'column',
          }}
        >
          <View style={{ padding: '16px 16px 12px', borderBottom: '1px solid #ecefe3' }}>
            <View className="flex flex-row items-center justify-between">
              <Text className="block text-base font-medium text-foreground">
                {confirmed ? '确认页序' : '多张图片合成一份 PDF'}
              </Text>
              <View className="px-2 py-1" onClick={closeCompose}>
                <Text className="block text-base text-muted-foreground">✕</Text>
              </View>
            </View>
            <Text className="block text-xs text-muted-foreground mt-1">
              {confirmed
                ? '点图片可左右滑动预览；需要改动请点「返回调整」'
                : dragFrom !== null
                  ? '已选中：拖到目标位置松手，或直接点目标图片'
                  : '长按调整顺序 · 点图预览 · 右上角 ✕ 移入下方待恢复区'}
            </Text>
          </View>

          {!confirmed && (
            <View className="flex flex-row items-center gap-2 rounded-xl bg-muted px-3 h-9 mx-4 mt-3 flex-shrink-0">
              <Text className="block text-xs text-muted-foreground">名称</Text>
              <Input
                className="flex-1 text-sm bg-transparent"
                value={composeName}
                placeholder="合成后的文件名"
                placeholderClass="text-muted-foreground"
                onInput={(e) => setComposeName(e.detail.value)}
              />
            </View>
          )}

          {dragFrom !== null && !confirmed && (
            <View className="flex flex-row items-center gap-3 mx-4 mt-2 px-3 py-2 rounded-xl bg-brand-soft flex-shrink-0">
              <Text className="block text-xs text-brand-text">已选第 {dragFrom + 1} 张</Text>
              <View className="px-2 py-1 rounded-md bg-muted" onClick={() => { nudgeCompose(dragFrom, -1); clearDrag() }}>
                <Text className="block text-xs text-foreground">↑ 上移</Text>
              </View>
              <View className="px-2 py-1 rounded-md bg-muted" onClick={() => { nudgeCompose(dragFrom, 1); clearDrag() }}>
                <Text className="block text-xs text-foreground">↓ 下移</Text>
              </View>
              <View className="px-2 py-1" onClick={clearDrag}>
                <Text className="block text-xs text-muted-foreground">取消</Text>
              </View>
            </View>
          )}

          {/* 拖拽期间锁滚动，落点用视口矩形命中，不赌 Taro 的 movable-view 手势 */}
          <ScrollView
            scrollY={!dragging}
            style={{ flex: 1, padding: '12px 16px' }}
            onTouchMove={updateDragTarget}
            onTouchEnd={endDrag}
            onTouchCancel={endDrag}
          >
            <View style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
              {composeItems.map((it, idx) => {
                const isFrom = dragFrom === idx
                const isTarget = dragFrom !== null && dragTo === idx && dragTo !== dragFrom
                return (
                  <View
                    key={it.id}
                    className="compose-cell"
                    style={{
                      width: '30.66%', marginRight: idx % 3 === 2 ? 0 : '4%', marginBottom: 12,
                      opacity: isFrom ? 0.45 : 1,
                    }}
                    onTouchStart={() => { longPressedRef.current = false }}
                    onLongPress={() => { if (!confirmed) beginDrag(idx) }}
                    onClick={() => handleCellClick(idx)}
                  >
                    <View
                      style={{
                        position: 'relative', width: '100%', paddingBottom: '100%',
                        borderRadius: 10, overflow: 'hidden', backgroundColor: '#f3f4f0',
                        border: isTarget ? '2px solid #7ba05b' : '2px solid transparent',
                      }}
                    >
                      <Image
                        src={it.path}
                        mode="aspectFill"
                        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
                      />
                      {!confirmed && (
                        <View
                          style={{
                            position: 'absolute', right: 0, top: 0, width: 24, height: 24,
                            borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                          onClick={(e) => { e.stopPropagation?.(); removeCompose(it.id) }}
                        >
                          <Text style={{ color: '#fff', fontSize: 14, lineHeight: '14px' }}>✕</Text>
                        </View>
                      )}
                    </View>
                    {/* D-064：页码用「-数字序号-」形式展示在缩略图下部 */}
                    <View style={{ marginTop: 4, alignItems: 'center' }}>
                      <Text className="block text-xs text-muted-foreground">-{idx + 1}-</Text>
                    </View>
                  </View>
                )
              })}
              {!confirmed && composeItems.length < MAX_COMBINE_IMAGES && (
                <View
                  style={{ width: '30.66%', marginRight: composeItems.length % 3 === 2 ? 0 : '4%', marginBottom: 12 }}
                  onClick={() => void handleChooseImages(true)}
                >
                  <View
                    style={{
                      width: '100%', paddingBottom: '100%', position: 'relative',
                      border: '2px dashed #d8ddd0', borderRadius: 10,
                    }}
                  >
                    <View style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Text className="block text-xs text-muted-foreground">＋ 添加</Text>
                    </View>
                  </View>
                </View>
              )}
            </View>
            {!composeItems.length && (
              <View className="py-10 flex items-center justify-center">
                <Text className="block text-xs text-muted-foreground">还没有图片，点「＋ 添加」开始</Text>
              </View>
            )}
          </ScrollView>

          {/* D-064：页面下部临时框——删除只是暂存，点 ＋ 加回原位，防误删 */}
          <View style={{ margin: '0 16px 8px', padding: '8px 10px', border: '1px dashed #d8ddd0', borderRadius: 12, flexShrink: 0 }}>
            <Text className="block text-xs text-muted-foreground">
              已移除 {removedItems.length} 张{removedItems.length ? ' · 点 ＋ 加回原位' : ' · 删除的图片暂存这里，可随时加回'}
            </Text>
            {removedItems.length > 0 && (
              <ScrollView scrollX style={{ marginTop: 8, whiteSpace: 'nowrap' }}>
                <View style={{ display: 'inline-flex', flexDirection: 'row' }}>
                  {removedItems.map((it) => (
                    <View key={it.id} style={{ position: 'relative', width: 44, height: 44, borderRadius: 8, overflow: 'hidden', marginRight: 8, flexShrink: 0 }}>
                      <Image src={it.path} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                      <View
                        style={{
                          position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
                          borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.6)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                        onClick={() => restoreCompose(it.id)}
                      >
                        <Text style={{ color: '#fff', fontSize: 12, lineHeight: '12px' }}>＋</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>

          {/* D-064：两段式——「确定」只锁顺序，复核后「开始合成」才上传 */}
          <View className="flex flex-row gap-3 px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid #ecefe3' }}>
            <View
              className="px-5 h-11 rounded-xl bg-muted flex items-center justify-center"
              onClick={confirmed ? () => setConfirmed(false) : closeCompose}
            >
              <Text className="block text-sm text-foreground">{confirmed ? '返回调整' : '取消'}</Text>
            </View>
            <View
              className="flex-1 h-11 rounded-xl bg-brand flex items-center justify-center"
              style={{ opacity: composeBusy ? 0.6 : 1 }}
              onClick={confirmed ? () => void doCombine() : confirmCompose}
            >
              <Text className="block text-sm text-brand-foreground">
                {confirmed ? `开始合成（${composeItems.length} 张）` : `确定（${composeItems.length} 张）`}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* D-064：全屏预览，Swiper 左右滑动查看不同图片；自写以便显示 -N- 页码 */}
      {composeVisible && previewIndex !== null && (
        <View
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200,
            backgroundColor: '#000', display: 'flex', flexDirection: 'column',
          }}
        >
          <View style={{ padding: '14px 16px', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: '#fff', fontSize: 14 }}>- {previewIndex + 1} / {composeItems.length} -</Text>
            <View className="px-2 py-1" onClick={() => setPreviewIndex(null)}>
              <Text style={{ color: '#fff', fontSize: 16 }}>✕</Text>
            </View>
          </View>
          <Swiper
            current={previewIndex}
            circular={false}
            indicatorDots={false}
            duration={200}
            onChange={(e) => setPreviewIndex(e.detail.current)}
            style={{ width: '100%', height: SCREEN_H - 60 }}
          >
            {composeItems.map((it) => (
              <SwiperItem key={it.id}>
                <Image src={it.path} mode="aspectFit" style={{ width: '100%', height: '100%' }} />
              </SwiperItem>
            ))}
          </Swiper>
        </View>
      )}
    </View>
  )
}
