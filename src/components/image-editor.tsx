import { View, Text, Canvas, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { RotateCw, Crop, Undo2, X, Wand, Sparkles, Eraser, Database, Maximize2 } from 'lucide-react-taro'
import { processImage, uploadImage, ApiError, type ImageAction } from '@/services/api'

interface ImageEditorProps {
  visible: boolean
  src: string
  onCancel: () => void
  onConfirm: (tempFilePath: string) => void
  /** 打开编辑器后自动执行的 AI 处理 */
  autoAction?: ImageAction | null
  /**
   * true = 「保存图片」按钮保存到「最近题目」（识别页/首页复用）；
   * false/省略 = 只做编辑并把结果回传（onConfirm），不直接落库。
   */
  enableSaveToInbox?: boolean
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 归一化角点 [x, y]，取值 [0,1]（相对原图） */
type Corner = [number, number]

/**
 * 编辑模式：
 *  - 'rect'：矩形裁剪（默认，行为与历史一致）
 *  - 'quad'：四角透视拉框（手动纠偏，把斜拍试卷拉平）
 */
type CornerMode = 'rect' | 'quad'

type DragTarget =
  | 'tl' | 'tr' | 'bl' | 'br'
  | 'l' | 'r' | 't' | 'b'
  | 'move'
  | 'corner'

const HANDLES: { key: DragTarget; dx: number; dy: number }[] = [
  { key: 'tl', dx: 0, dy: 0 },
  { key: 'tr', dx: 1, dy: 0 },
  { key: 'bl', dx: 0, dy: 1 },
  { key: 'br', dx: 1, dy: 1 },
]

const CANVAS_ID = 'imgEditorCanvas'
// 边角命中半径（px）。放大到 32 以覆盖手柄（手柄画在边框外 -7px），
// 解决「四边有时选不中」的问题。
const HANDLE_HIT = 32

// 四角手柄命中半径（px）。角点手柄直径 22，命中半径放大到 36，便于手指抓取。
const CORNER_HIT = 36

const DEFAULT_CROP: Rect = { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }

// 四角默认位置：内缩 8% 的四边形（贴合「试卷略小于取景框」的常见拍摄）。
// 顺序固定 [左上, 右上, 右下, 左下]，与后端 orderCorners 语义一致（后端仍会自行排序）。
const DEFAULT_QUAD: Corner[] = [
  [0.08, 0.08],
  [0.92, 0.08],
  [0.92, 0.92],
  [0.08, 0.92],
]

// 四角四边形最小面积占比：低于此值视为退化（近乎共线/同点），拒绝该次拖拽。
const MIN_QUAD_AREA = 0.05

// AI 处理前的最大边长（px）与压缩质量。手机原图常 3000~4000px，
// 压到 1280 左右即可满足识别/高清需求，又能把上传与 AI 处理耗时降低一个数量级。
const MAX_SIDE = 1280
const COMPRESS_QUALITY = 80
// 离屏 Canvas 缓冲/显示的硬上限（微信 Canvas2D iOS 约 4096，安卓设备相关）。
// 超出即报 set width out of range 11000>8192；导出缓冲与离屏 canvas 的 CSS 尺寸都以此封顶。
const MAX_CANVAS_SIDE = 4096

const AI_ACTIONS: { action: ImageAction; label: string; icon: any }[] = [
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  { action: 'erase_v2', label: '去手写', icon: Eraser },
]

// 智能高清的「倍率 / 模式」选项（方案 §3：CPU 轻量 SR，x2 默认；x3/x4 更清晰但更慢）
type SRScale = 2 | 3 | 4
type SRMode = 'classical' | 'espcn'

const SR_SCALES: { value: SRScale; label: string; hint: string }[] = [
  { value: 2, label: 'x2', hint: '推荐 · 速度快' },
  { value: 3, label: 'x3', hint: '更清晰 · 较慢' },
  { value: 4, label: 'x4', hint: '最清晰 · 慢' },
]

const SR_MODES: { value: SRMode; label: string; hint: string }[] = [
  { value: 'classical', label: '标准', hint: '轻量锐化 · CPU 友好' },
  { value: 'espcn', label: '神经网络', hint: 'ESPCN · 细节更好 · 慢' },
]

export default function ImageEditor({
  visible, src, onCancel, onConfirm, autoAction = null, enableSaveToInbox = true,
}: ImageEditorProps) {
  const [currentSrc, setCurrentSrc] = useState(src)
  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<Rect>(DEFAULT_CROP)
  const [imgW, setImgW] = useState(0)
  const [imgH, setImgH] = useState(0)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  // confirmed=true：已点「确定裁剪」，展示干净成品，不再显示裁剪框
  const [confirmed, setConfirmed] = useState(false)
  // framing=true：主动裁剪模式，显示裁剪框/遮罩/手柄。仅在此模式下出现「裁剪中」视觉态，
  // 满足「该状态只能是点击裁剪后才会出现」。AI/旋转后回到 false（干净预览）。
  const [framing, setFraming] = useState(true)
  const [previewError, setPreviewError] = useState(false)
  // 智能高清设置：倍率 + 模式（点「智能高清」时弹出小面板选择，选定后再处理）
  const [srScale, setSrScale] = useState<SRScale>(2)
  const [srMode, setSrMode] = useState<SRMode>('classical')
  const [srPanelOpen, setSrPanelOpen] = useState(false)
  // 编辑模式：矩形裁剪 / 四角透视（互斥）。默认矩形，行为与历史一致。
  const [cornerMode, setCornerMode] = useState<CornerMode>('rect')
  // 四角归一化坐标，顺序 [tl,tr,br,bl]
  const [quad, setQuad] = useState<Corner[]>(DEFAULT_QUAD)
  // 当前拖拽中的角点索引（用于高亮）
  const [activeCorner, setActiveCorner] = useState<number | null>(null)

  /**
   * 离屏 Canvas 的「布局尺寸」= 本次导出的缓冲尺寸（含旋转互换）。
   *
   * ⚠️ 必须与 node.width/height（缓冲）严格一致，否则 canvasToTempFilePath 会按
   * CSS 布局尺寸理解导出区域 → 旋转 90°/270° 时四周被裁（详见 工程教训录 L7-补充）。
   * 因此它由 drawAndExport 里的同一个 fit/swap 计算派生，而不是由 naturalW/H 派生。
   */
  const [canvasBox, setCanvasBox] = useState({ w: 1, h: 1 })

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
    /** target==='corner' 时的角点索引 */
    cornerIndex?: number
  } | null>(null)
  // 容器相对视口的位置；每次触摸前都会重新测量，避免布局变化后坐标漂移
  const boxRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })
  // 触摸层相对视口的位置（含 -24 外扩）；用它本身的坐标系算触摸点，避免父级 inset 带来的偏移
  const layerRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })
  const measureLayer = (cb?: () => void) => {
    Taro.createSelectorQuery()
      .select('#cropTouchLayer')
      .boundingClientRect((rect) => {
        const r = Array.isArray(rect) ? rect[0] : rect
        if (r) layerRectRef.current = { left: r.left, top: r.top }
        cb?.()
      })
      .exec()
  }

  const measureBox = (cb?: () => void) => {
    Taro.createSelectorQuery()
      .select('#imgEditorBox')
      .boundingClientRect((rect) => {
        const r = Array.isArray(rect) ? rect[0] : rect
        if (r) boxRectRef.current = { left: r.left, top: r.top }
        cb?.()
      })
      .exec()
  }

  /**
   * 依据原图尺寸，按 contain 计算「显示尺寸」imgW/imgH。
   * 注意：不取整（保留小数），保证盒子宽高比与原图严格一致，
   * 这样 <TaroImage mode="aspectFit"> 会**精确铺满**盒子、无黑边/留白，
   * 从而「屏幕上框选的范围」与「导出区域」一一对应（修复裁剪范围不一致）。
   */
  const resetBox = (w: number, h: number) => {
    setNaturalW(w)
    setNaturalH(h)
    const sys = Taro.getSystemInfoSync()
    const availW = sys.windowWidth - 32
    const availH = sys.windowHeight - 260
    const scale = Math.min(availW / w, availH / h, 1)
    setImgW(w * scale)
    setImgH(h * scale)
    measureBox()
  }

  /** 远程图先下载到本地，确保后续裁剪/AI 全程基于本地文件（与识别页一致、稳定） */
  const toLocalIfRemote = async (u: string): Promise<string> => {
    if (!/^https?:\/\//.test(u)) return u
    try {
      const dl: any = await downloadWithTimeout(u, 30000)
      return dl?.tempFilePath || u
    } catch {
      return u
    }
  }

  /** 打开一张图：远程先落本地，再读尺寸并算展示盒 */
  const openImage = async (target: string) => {
    setPreviewError(false)
    const local = await toLocalIfRemote(target)
    try {
      const info = await Taro.getImageInfo({ src: local })
      setCurrentSrc(local)
      resetBox(info.width, info.height)
    } catch {
      setPreviewError(true)
      Taro.showToast({ title: '图片读取失败', icon: 'none' })
      const sys = Taro.getSystemInfoSync()
      setImgW(sys.windowWidth - 32)
      setImgH(Math.round((sys.windowWidth - 32) * 0.75))
    }
  }

  // 打开/换图：复位所有状态并加载
  useEffect(() => {
    if (!visible || !src) return
    setCurrentSrc(src)
    setRotation(0)
    setCrop(DEFAULT_CROP)
    setQuad(DEFAULT_QUAD)
    setCornerMode('rect')
    setActiveCorner(null)
    setBusy(false)
    setAiBusy(false)
    setConfirmed(false)
    setFraming(true)
    setPreviewError(false)
    canvasNodeRef.current = null
    void openImage(src)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, src])

  // 打开后自动执行指定 AI 处理（等图片尺寸就绪后再跑，避免基于空图）
  useEffect(() => {
    if (!visible || !autoAction || aiBusy || busy || !naturalW) return
    const cfg = AI_ACTIONS.find((a) => a.action === autoAction)
    if (cfg) void handleAi(cfg.action, cfg.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoAction, naturalW])

  // ---------- 裁剪框手势 ----------
  const hitTarget = (touchX: number, touchY: number): DragTarget | null => {
    if (!framing) return null
    const left = crop.x * imgW
    const top = crop.y * imgH
    const right = (crop.x + crop.w) * imgW
    const bottom = (crop.y + crop.h) * imgH
    const near = (v: number, edge: number) => Math.abs(v - edge) <= HANDLE_HIT

    // 角点优先（两轴都靠近）
    if (near(touchX, left) && near(touchY, top)) return 'tl'
    if (near(touchX, right) && near(touchY, top)) return 'tr'
    if (near(touchX, left) && near(touchY, bottom)) return 'bl'
    if (near(touchX, right) && near(touchY, bottom)) return 'br'
    // 边中点
    if (near(touchX, left)) return 'l'
    if (near(touchX, right)) return 'r'
    if (near(touchY, top)) return 't'
    if (near(touchY, bottom)) return 'b'
    // 框内平移
    if (touchX > left + HANDLE_HIT && touchX < right - HANDLE_HIT &&
        touchY > top + HANDLE_HIT && touchY < bottom - HANDLE_HIT) return 'move'
    return null
  }

  /**
   * 命中四角手柄：返回最近且在 CORNER_HIT 半径内的角点索引（0..3），否则 null。
   * 坐标用「触摸层坐标系」（与 rect 裁剪一致，含 -24 外扩）。
   */
  const hitCorner = (touchX: number, touchY: number): number | null => {
    if (!framing || cornerMode !== 'quad') return null
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < 4; i++) {
      const px = quad[i][0] * imgW
      const py = quad[i][1] * imgH
      const d = Math.hypot(touchX - px, touchY - py)
      if (d <= CORNER_HIT && d < bestDist) { best = i; bestDist = d }
    }
    return best >= 0 ? best : null
  }

  const onTouchStart = (e: any) => {
    // 每次触摸前重新测量「触摸层」自身位置（含 -24 外扩），用其坐标系算点，规避布局/inset 漂移
    measureLayer(() => {
      const t = e.touches[0]
      const rx = t.clientX - layerRectRef.current.left - 24
      const ry = t.clientY - layerRectRef.current.top - 24
      // 四角模式优先命中角点
      const ci = hitCorner(rx, ry)
      if (ci !== null) {
        dragRef.current = { target: 'corner', cornerIndex: ci, startX: rx, startY: ry, start: { ...crop } }
        setActiveCorner(ci)
        return
      }
      if (cornerMode === 'quad') return // 四角模式下不响应矩形框手势
      const target = hitTarget(rx, ry)
      if (!target) return
      dragRef.current = { target, startX: rx, startY: ry, start: { ...crop } }
    })
  }

  const onTouchMove = (e: any) => {
    const drag = dragRef.current
    if (!drag) return
    const t = e.touches[0]
    const rx = t.clientX - layerRectRef.current.left - 24
    const ry = t.clientY - layerRectRef.current.top - 24

    // 拖动四角：直接按触摸位置更新该角归一化坐标
    if (drag.target === 'corner' && drag.cornerIndex != null) {
      const i = drag.cornerIndex
      const nx = clamp(rx / imgW, 0, 1)
      const ny = clamp(ry / imgH, 0, 1)
      const next = quad.map((p, idx): Corner => (idx === i ? [nx, ny] : [p[0], p[1]]))
      // 退化保护：面积过小或自交（非凸）拒绝该次移动，避免提交非法四边形
      if (isValidQuad(next)) setQuad(next)
      return
    }

    const dx = (rx - drag.startX) / imgW
    const dy = (ry - drag.startY) / imgH
    setCrop(clampCrop(applyDrag(drag.start, drag.target, dx, dy)))
  }

  const onTouchEnd = () => {
    dragRef.current = null
    setActiveCorner(null)
  }

  // 点击预览区：重新进入裁剪模式（从「已裁剪/AI 后」的干净态切回可框选）
  const enterFraming = () => {
    if (aiBusy) return
    setConfirmed(false)
    setFraming(true)
  }

  const handleRotate = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      // 把旋转「烘焙」进图片本身（导出整张旋转后的新图，fullFrame=true 不裁边），
      // 而不是仅做 CSS 旋转，这样预览/裁剪框/导出始终在同一坐标系，彻底消除旋转导致的错位。
      const out = await exportEdited((rotation + 90) % 360, true)
      const info = await Taro.getImageInfo({ src: out })
      setCurrentSrc(out)
      setRotation(0)
      setNaturalW(info.width)
      setNaturalH(info.height)
      resetBox(info.width, info.height)
      setCrop(DEFAULT_CROP)
      setQuad(DEFAULT_QUAD)
      setConfirmed(false)
      setFraming(false)
    } catch (err) {
      console.error('旋转失败', err)
      Taro.showToast({ title: '旋转失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleReset = () => {
    setRotation(0)
    setConfirmed(false)
    setFraming(true)
    setCrop(DEFAULT_CROP)
    setQuad(DEFAULT_QUAD)
    setCornerMode('rect')
    void openImage(src)
  }

  const getCanvasNode = async (): Promise<any> => {
    if (canvasNodeRef.current) return canvasNodeRef.current
    return new Promise((resolve) => {
      Taro.createSelectorQuery()
        .select(`#${CANVAS_ID}`)
        .fields({ node: true } as any)
        .exec((res) => {
          const node = res?.[0]?.node
          canvasNodeRef.current = node || null
          resolve(node)
        })
    })
  }

  const waitCanvasNode = async (retry = 12): Promise<any> => {
    for (let i = 0; i < retry; i++) {
      const node = await getCanvasNode()
      if (node) return node
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  /**
   * 等待一次布局落地（让 React 把新的 canvas CSS 尺寸写进 DOM）。
   * 用「双 requestAnimationFrame + 短延时兜底」：无 rAF 环境降级为 30ms 延时。
   */
  const waitLayout = async (): Promise<void> => {
    const g: any = globalThis as any
    const raf: any = g.requestAnimationFrame
    if (typeof raf === 'function') {
      await new Promise<void>((r) => raf(() => r()))
      await new Promise<void>((r) => raf(() => r()))
      return
    }
    await new Promise((r) => setTimeout(r, 30))
  }

  /**
   * 用离屏 Canvas 把「当前编辑态（旋转 + 裁剪）」导出为本地图片。
   *
   * 规范做法（微信 Canvas 2D + canvasToTempFilePath）：
   *  - 画布缓冲设为 输出尺寸 × dpr，并用 ctx.scale(dpr, dpr) 后以「逻辑像素」绘制；
   *  - 90°/270° 旋转后宽高互换，故输出画布尺寸要相应交换，否则旋转图放不下会被裁掉；
   *  - canvasToTempFilePath 的 x/y/width/height 用「缓冲像素」= 逻辑 × dpr；
   *  - destWidth/destHeight 同样用「逻辑 × dpr」，输出即高清且区域零偏移。
   *
   * 旋转「烘焙」：把整张图以画布中心为轴旋转（只旋转、不缩放），整张铺满输出画布，
   * 再按需裁出选区。rotate 烘焙时必须 fullFrame=true 取整张，否则会把旋转图四边切掉。
   *
   * @param rot      旋转角度（度）
   * @param fullFrame true=导出整张（用于旋转烘焙）；false=按 crop 选区导出（用于确定裁剪/保存）
   */
  // 真正执行「绘制 + 导出」；exportEdited 负责节点获取与失败重试
  const drawAndExport = async (node: any, rot: number, fullFrame: boolean): Promise<string> => {
    // 导出缓冲直接使用「原图逻辑尺寸 × fit」，不乘 dpr：
    //  - 微信 Canvas2D 缓冲有硬上限（iOS 4096 / 安卓设备相关，超限即报
    //    set width out of range 11000>8192）；乘 dpr 会把 4000px 原图撑到 12000px 触发该错；
    //  - canvasToTempFilePath 的 x/y/width/destWidth 单位即缓冲像素，缓冲=逻辑尺寸时单位无歧义，
    //    跨微信版本行为一致，彻底消除「框选范围≠导出范围」的漂移。
    const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(naturalW, naturalH, 1))
    const bufW = Math.max(1, Math.round(naturalW * fit))
    const bufH = Math.max(1, Math.round(naturalH * fit))
    // 90°/270° 旋转后宽高互换，输出画布尺寸需相应交换
    const swap = rot % 180 !== 0
    const canvasW = swap ? bufH : bufW
    const canvasH = swap ? bufW : bufH

    // ★ 关键：先把「布局尺寸」同步为本次缓冲尺寸，等微信完成一次布局后再绘制/导出。
    //   否则 canvasToTempFilePath 按旧 CSS 尺寸理解导出区域 → 旋转 90° 时四周被裁。
    //   （useState 是异步的，须 await 到布局落地，故用双 rAF/短延时兜底。）
    setCanvasBox((prev) => (prev.w === canvasW && prev.h === canvasH ? prev : { w: canvasW, h: canvasH }))
    await waitLayout()

    node.width = canvasW
    node.height = canvasH
    const ctx = node.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvasW, canvasH)

    const srcData = await toLocalIfRemote(currentSrc)
    let img: any = null
    if (node.createImage) img = node.createImage()
    else img = new Image()
    img.src = srcData
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      img.onload = finish
      img.onerror = finish
      setTimeout(finish, 8000)
    })
    if (!img.width || !img.height) throw new Error('图片加载失败，无法导出')

    // 整张图烘焙进缓冲（不缩放），90°/270° 以中心旋转，旋转后整张铺满输出画布
    ctx.save()
    ctx.translate(canvasW / 2, canvasH / 2)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.drawImage(img, -bufW / 2, -bufH / 2, bufW, bufH)
    ctx.restore()

    // 裁剪区域：fullFrame（旋转烘焙）取整张；否则用框选 crop。
    // cropToBufferRect 把归一化裁剪框直接映射到缓冲像素，与预览框共用同一套分数 → 零偏移。
    const r: Rect = fullFrame ? { x: 0, y: 0, w: 1, h: 1 } : crop
    const { x, y, w, h } = cropToBufferRect(r, canvasW, canvasH)
    return new Promise<string>((resolve, reject) => {
      Taro.canvasToTempFilePath({
        canvas: node,
        x, y, width: w, height: h,
        destWidth: Math.round(w),
        destHeight: Math.round(h),
        fileType: 'jpg',
        quality: 0.95,
        success: (res: any) => resolve(res.tempFilePath),
        fail: (err: any) => reject(err),
      } as any)
    })
  }

  /**
   * 用离屏 Canvas 把「当前编辑态（旋转 + 裁剪）」导出为本地图片。
   *
   * 节点获取策略（修复「多次操作后裁剪失效」）：
   *  - 每次导出前清空 canvasNodeRef 缓存，重新向微信查询「当前活跃」的 canvas 节点。
   *    旧实现把节点永久缓存，多次操作（裁剪→AI→再裁剪）后该引用可能被回收/失效，
   *    导致 canvasToTempFilePath 永久失败、表现为「裁剪功能不能用、报失败请重试」。
   *  - 首轮失败再清缓存重试一次，覆盖「节点偶发失效」的瞬时场景。
   */
  const exportEdited = async (rot: number = rotation, fullFrame = false): Promise<string> => {
    let lastErr: any
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        canvasNodeRef.current = null // 每次都拿最新节点
        const node = await waitCanvasNode()
        if (!node) throw new Error('画布未就绪，请稍后重试')
        return await drawAndExport(node, rot, fullFrame)
      } catch (e) {
        lastErr = e
        // 记录首次失败原因（勿吞）：节点失效 vs 算法/超限，据此可快速定位
        console.warn(`[image-editor] 导出第 ${attempt + 1} 次失败，将清缓存重试：`, e)
        canvasNodeRef.current = null // 下一轮用全新节点重试
      }
    }
    throw lastErr
  }

  // 确定裁剪：导出选区内内容为新图，预览切到裁剪结果并转为「已裁剪」干净态
  const handleConfirmCrop = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      const out = await exportEdited()
      const info = await Taro.getImageInfo({ src: out })
      setCurrentSrc(out)
      setRotation(0)
      setNaturalW(info.width)
      setNaturalH(info.height)
      resetBox(info.width, info.height)
      setCrop({ x: 0, y: 0, w: 1, h: 1 })
      setQuad(DEFAULT_QUAD)
      setCornerMode('rect')
      setConfirmed(true) // 进入「已裁剪」干净态
      setFraming(false)  // 不再显示裁剪框
      Taro.showToast({ title: '已裁剪，点「使用此图」返回', icon: 'none' })
    } catch (err) {
      console.error('裁剪失败', err)
      Taro.showToast({ title: (err as any)?.message || '裁剪失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const compressImage = async (filePath: string): Promise<string> => {
    if (/^https?:\/\//.test(filePath)) return filePath
    try {
      const info = await Taro.getImageInfo({ src: filePath })
      const longSide = Math.max(info.width, info.height)
      if (longSide <= MAX_SIDE) return filePath
      const ratio = MAX_SIDE / longSide
      const w = Math.max(1, Math.round(info.width * ratio))
      const h = Math.max(1, Math.round(info.height * ratio))
      const res = await Taro.compressImage({
        src: filePath,
        quality: COMPRESS_QUALITY,
        compressedWidth: w,
        compressedHeight: h,
      })
      return res.tempFilePath || filePath
    } catch {
      return filePath
    }
  }

  const downloadWithTimeout = (url: string, ms: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('下载超时')), ms)
      Network.downloadFile({
        url,
        success: (r: any) => { clearTimeout(timer); resolve(r) },
        fail: (e: any) => { clearTimeout(timer); reject(e) },
      })
    })
  }

  /**
   * AI 处理：调后端图生图。
   * 关键修复（Issue 3）：成功/失败都把 confirmed 复位为 false，并把 framing 置为 false，
   * 让图片回到「干净预览」，不再停在「已裁剪/裁剪中」视觉态。
   */
  /**
   * 【服务端限流配合】智能高清被限流时的降级处理（依据 Phase 2 压测结论）。
   *
   * 后端对重任务（x3/x4/espcn）做了用户级配额（429）+ 全局并发闸排队（503）：
   *  - 429（SR_RATE_LIMIT / SR_USER_BUSY）：提示频率过快，引导稍后重试；
   *  - 503（SR_QUEUE_TIMEOUT）：排队超时 → **自动降级为 x2 快速模式重试一次**（仅一次）。
   *
   * @returns true 表示已处理（调用方不再走通用报错）；false 表示不是限流错误。
   */
  const handleSrRateLimit = async (e: unknown, label: string): Promise<boolean> => {
    if (!(e instanceof ApiError)) return false
    const isRate = e.status === 429
    const isQueue = e.status === 503
    if (!isRate && !isQueue) return false

    const suggest = (e.data as any)?.suggest as { scale?: SRScale; mode?: SRMode } | undefined

    if (isRate) {
      Taro.hideLoading()
      Taro.showToast({ title: e.message || '高清处理太频繁，请稍后再试', icon: 'none', duration: 2500 })
      return true
    }

    // 503：排队超时/队列满 → 询问并自动降级到 x2 快速模式（用户已确认「排队超时后降级」）
    Taro.hideLoading()
    const res = await Taro.showModal({
      title: '高清处理排队较多',
      content: '是否改用「x2 快速模式」立即处理？',
      confirmText: '用 x2',
      cancelText: '稍后再试',
    })
    if (!res.confirm) {
      Taro.showToast({ title: '已取消，请稍后再试', icon: 'none' })
      return true
    }
    const fallbackScale = suggest?.scale ?? 2
    const fallbackMode = suggest?.mode ?? 'classical'
    setSrScale(fallbackScale)
    setSrMode(fallbackMode)
    Taro.showToast({ title: '已切换 x2 快速模式', icon: 'none', duration: 1500 })
    // 先释放 aiBusy 再重试，否则 handleAi 开头的 aiBusy 守卫会直接 return（降级不生效）
    setAiBusy(false)
    void handleAi('enhance', label, { sr_scale: fallbackScale, sr_mode: fallbackMode }, true)
    return true
  }

  const handleAi = async (
    action: ImageAction,
    label: string,
    opts?: { sr_scale?: SRScale; sr_mode?: SRMode; manual_corners?: Corner[] },
    /** true = 本次为「限流降级重试」，不再二次降级（防循环） */
    degradedRetry = false,
  ) => {
    if (aiBusy || busy) return
    setAiBusy(true)
    Taro.showLoading({ title: `${label}处理中…`, mask: true })
    let lastGoodSrc = currentSrc
    try {
      const sourceForProcess = await compressImage(currentSrc)
      lastGoodSrc = sourceForProcess

      let sourceUrl = sourceForProcess
      if (!/^https?:\/\//.test(sourceForProcess)) {
        const up = await uploadImage(sourceForProcess, { purpose: 'temp' })
        sourceUrl = up.url
      }

      const data = await processImage(action, sourceUrl, opts)
      if (!data?.url) throw new Error('处理服务未返回图片')

      // 后端自动检测未命中且未提供四角 → 不静默返回原图，提示用户手动拉四角（方案 §2.3）
      const needManual = (data as any)?.debug?.needManual === true
      if (needManual) {
        Taro.hideLoading()
        const res = await Taro.showModal({
          title: '未能自动识别试卷边缘',
          content: '是否手动拉出试卷的四个角，再试一次纠偏？',
          confirmText: '去拉框',
          cancelText: '取消',
        })
        setAiBusy(false)
        if (res.confirm) {
          setCornerMode('quad')
          setFraming(true)
          setConfirmed(false)
          Taro.showToast({ title: '请拖动四个圆点框住试卷四角', icon: 'none', duration: 2500 })
        } else {
          // 用户放弃：把后端返回的原图（内容保真）落到当前预览
          const dl: any = await downloadWithTimeout(data.url, 30000)
          if (dl?.tempFilePath) {
            const info = await Taro.getImageInfo({ src: dl.tempFilePath })
            setCurrentSrc(dl.tempFilePath)
            setRotation(0)
            setCrop(DEFAULT_CROP)
            resetBox(info.width, info.height)
            setConfirmed(false)
            setFraming(false)
          }
        }
        setAiBusy(false)
        Taro.hideLoading()
        return
      }

      const dl: any = await downloadWithTimeout(data.url, 30000)
      if (!dl || dl.statusCode !== 200 || !dl.tempFilePath) {
        throw new Error('处理结果下载失败，请重试')
      }
      const info = await Taro.getImageInfo({ src: dl.tempFilePath })
      if (!info || !info.width || !info.height) {
        throw new Error('处理结果不是有效图片')
      }

      setCurrentSrc(dl.tempFilePath)
      setRotation(0)
      setCrop(DEFAULT_CROP)
      setQuad(DEFAULT_QUAD)
      setCornerMode('rect')
      resetBox(info.width, info.height)
      setConfirmed(false) // ← 修复：AI 后清除「已裁剪」态
      setFraming(false)   // ← 修复：AI 后回到干净预览（不再显示裁剪框）
      Taro.showToast({ title: `${label}完成`, icon: 'success' })
    } catch (e) {
      console.error('AI 图片处理失败', e)
      // 限流类错误（429/503）走专用降级分支；degradedRetry 时不再二次降级（防循环）
      if (!degradedRetry && (await handleSrRateLimit(e, label))) {
        setCurrentSrc(lastGoodSrc)
        setAiBusy(false)
        Taro.hideLoading()
        return
      }
      const msg = e instanceof Error ? e.message : `${label}失败，请重试`
      Taro.showToast({ title: msg, icon: 'none' })
      setCurrentSrc(lastGoodSrc)
      try {
        const info = await Taro.getImageInfo({ src: lastGoodSrc })
        resetBox(info.width, info.height)
      } catch { /* ignore */ }
    }
    // 说明：降级重试通过 void handleAi(...) 异步派发，本函数随即返回；
    // 收尾（清 busy / 收 loading）统一放在 return 之前，避免与重试的 loading 交叉。
    setAiBusy(false)
    Taro.hideLoading()
  }

  const handleSave = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    Taro.showLoading({ title: '保存中…', mask: true })
    try {
      const imgSrc = confirmed ? currentSrc : await exportEdited()
      const up = await uploadImage(imgSrc, { purpose: 'save' })
      const saved = !!(up && (up.timeline_id || up.key))
      if (!saved) throw new Error('保存未生效，请重试')
      Taro.hideLoading()
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
    } catch (err: any) {
      Taro.hideLoading()
      console.error('保存图片失败', err)
      Taro.showToast({ title: err?.message ? err.message : '保存失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const handleConfirm = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      // 仅在「主动裁剪且尚未提交」时按当前框选裁剪；
      // 其余情况（已提交裁剪 / AI 处理 / 旋转 / 原图直接确认）currentSrc 已是最终结果，
      // 直接以「本地化后的 currentSrc」提交——既避免 AI/旋转后被默认裁剪框再裁一刀，
      // 也避免 currentSrc 因下载失败残留远程 URL 时走错上传分支（导致静默不入库）。
      const pendingCrop = showFrame && !confirmed
      const out = pendingCrop ? await exportEdited() : await toLocalIfRemote(currentSrc)
      if (!out) throw new Error('图片处理失败，请重试')
      onConfirm(out)
    } catch (err: any) {
      console.error('导出失败', err)
      Taro.showToast({ title: err?.message || '图片处理失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  if (!visible) return null

  // 裁剪框/遮罩/手柄/触摸层只在「主动裁剪模式」且非 AI 处理时显示
  const showFrame = framing && !aiBusy

  /**
   * AI 动作派发：
   *  - 智能高清(enhance)：先弹出「倍率 / 模式」选择面板，选定后再处理（让用户可控）。
   *  - 自动调正(auto)：若当前处于四角模式，带上手动四角（归一化）提交 → 精准透视压平。
   *  - 其余动作：保持原行为，点击即处理。
   */
  const dispatchAi = (action: ImageAction, label: string) => {
    if (aiBusy || busy) return
    if (action === 'enhance') {
      setSrPanelOpen(true)
      return
    }
    if (action === 'auto') {
      const corners = cornerMode === 'quad' ? quad : undefined
      void handleAi(action, label, corners ? { manual_corners: corners } : undefined)
      return
    }
    void handleAi(action, label)
  }

  /** 切换「矩形裁剪 / 四角拉框」两种模式（互斥）。 */
  const toggleCornerMode = () => {
    if (aiBusy || busy) return
    const next: CornerMode = cornerMode === 'quad' ? 'rect' : 'quad'
    setCornerMode(next)
    setFraming(true)
    setConfirmed(false)
    if (next === 'quad') setQuad(DEFAULT_QUAD)
    else setCrop(DEFAULT_CROP)
    Taro.showToast({
      title: next === 'quad' ? '拖动四个圆点框住试卷四角' : '已切回矩形裁剪',
      icon: 'none',
      duration: 2000,
    })
  }

  // 面板里点「开始处理」：带上所选倍率/模式调用后端
  const runEnhance = () => {
    setSrPanelOpen(false)
    void handleAi('enhance', '智能高清', { sr_scale: srScale, sr_mode: srMode })
  }

  return (
    <View className="fixed inset-0 bg-black z-[200] flex flex-col">
      {/* 顶部栏 */}
      <View className="flex flex-row items-center justify-between px-4 h-14">
        <View className="flex items-center gap-1" onClick={onCancel}>
          <X size={22} color="#ffffff" />
          <Text className="block text-white text-sm">退出</Text>
        </View>
        <Text className="block text-white text-sm font-medium">裁剪与调整</Text>
        <View className="w-8 flex items-center justify-end" onClick={handleReset}>
          <Undo2 size={19} color="#ffffff" />
        </View>
      </View>

      {/* 预览区：直接用 <TaroImage> 显示，稳定不黑屏；Canvas 仅离屏用于导出 */}
      <View className="flex-1 flex items-center justify-center px-4">
        <View
          id="imgEditorBox"
          onClick={enterFraming}
          style={{ width: imgW || '100%', height: imgH || 240, position: 'relative' }}
        >
          {previewError ? (
            <View className="w-full h-full flex items-center justify-center">
              <Text className="block text-white text-sm text-opacity-80">图片加载失败，请退出重试</Text>
            </View>
          ) : (
            <TaroImage
              src={currentSrc}
              mode="aspectFit"
              style={{ width: '100%', height: '100%' }}
              onError={() => setPreviewError(true)}
            />
          )}

          {/* 矩形裁剪：半透明遮罩 + 裁剪框（纯视觉，不拦截触摸） */}
          {showFrame && cornerMode === 'rect' && (
            <>
              <Overlay crop={crop} />
              <View
                className="absolute border border-white pointer-events-none"
                style={{
                  left: crop.x * imgW,
                  top: crop.y * imgH,
                  width: crop.w * imgW,
                  height: crop.h * imgH,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
                }}
              >
                <View className="absolute inset-0 pointer-events-none">
                  <View className="absolute left-1/3 top-0 bottom-0 border-l border-white border-opacity-40" />
                  <View className="absolute left-2/3 top-0 bottom-0 border-l border-white border-opacity-40" />
                  <View className="absolute top-1/3 left-0 right-0 border-t border-white border-opacity-40" />
                  <View className="absolute top-2/3 left-0 right-0 border-t border-white border-opacity-40" />
                </View>
                {HANDLES.map((h) => (
                  <View
                    key={h.key}
                    className="absolute pointer-events-none"
                    style={{
                      width: 18, height: 18,
                      left: h.dx * crop.w * imgW - 9,
                      top: h.dy * crop.h * imgH - 9,
                      borderRadius: 4,
                      borderWidth: 3, borderStyle: 'solid', borderColor: '#ffffff',
                      backgroundColor: 'rgba(190,62,45,0.9)',
                    }}
                  />
                ))}
                <View key="edge-t" className="absolute pointer-events-none" style={{ left: (crop.w * imgW) / 2 - 16, top: -9, width: 32, height: 3, backgroundColor: '#ffffff' }} />
                <View key="edge-b" className="absolute pointer-events-none" style={{ left: (crop.w * imgW) / 2 - 16, bottom: -9, width: 32, height: 3, backgroundColor: '#ffffff' }} />
                <View key="edge-l" className="absolute pointer-events-none" style={{ top: (crop.h * imgH) / 2 - 16, left: -9, width: 3, height: 32, backgroundColor: '#ffffff' }} />
                <View key="edge-r" className="absolute pointer-events-none" style={{ top: (crop.h * imgH) / 2 - 16, right: -9, width: 3, height: 32, backgroundColor: '#ffffff' }} />
              </View>
            </>
          )}

          {/* 四角透视：四边形连线 + 四角手柄 + 外部遮罩（纯视觉，不拦截触摸） */}
          {showFrame && cornerMode === 'quad' && (
            <QuadOverlay quad={quad} imgW={imgW} imgH={imgH} activeCorner={activeCorner} />
          )}

          {/* 触摸层：仅捕获裁剪框拖动；向四周外扩 24px，确保画在边框外的手柄也能被抓住 */}
          {showFrame && (
            <View
              id="cropTouchLayer"
              className="absolute"
              style={{ left: -24, top: -24, right: -24, bottom: -24 }}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            />
          )}

          {/* 离屏 Canvas：仅用于导出编辑结果。
              ★ CSS 尺寸必须 == 导出缓冲尺寸（由 drawAndExport 同步到 canvasBox），
                否则 canvasToTempFilePath 会按 CSS 尺寸理解导出区域 → 旋转 90°/270° 时四周被裁。
                缓冲与 CSS 都用同一套 fit/swap 计算，两者恒等，彻底消除旋转裁边。 */}
          <Canvas
            type="2d"
            id={CANVAS_ID}
            style={{
              position: 'absolute',
              left: '-9999px',
              top: 0,
              width: canvasBox.w,
              height: canvasBox.h,
            }}
          />
        </View>
      </View>

      {/* 底部操作 */}
      <View className="px-4 pb-8 pt-3">
        {/* AI 处理行 */}
        <View className="flex flex-row items-center justify-around mb-4">
          {AI_ACTIONS.map(({ action, label, icon: Icon }) => (
            <View key={action} className="flex flex-col items-center" onClick={() => dispatchAi(action, label)}>
              <View className="w-11 h-11 rounded-full bg-white bg-opacity-15 flex items-center justify-center mb-1">
                <Icon size={20} color="#ffffff" />
              </View>
              <Text className="block text-white text-opacity-80 text-xs">{label}</Text>
            </View>
          ))}
        </View>

        <View className="flex flex-row items-center justify-center gap-8 mb-5">
          <View className="flex flex-col items-center" onClick={handleRotate}>
            <RotateCw size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">旋转90°</Text>
          </View>
          <View className="flex flex-col items-center" onClick={handleConfirmCrop}>
            <View
              className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                confirmed ? 'bg-primary' : 'bg-white bg-opacity-15'
              }`}
            >
              <Crop size={20} color="#ffffff" />
            </View>
            <Text className="block text-white text-opacity-80 text-xs">确定裁剪</Text>
          </View>
          {/* 四角透视拉框：与「确定裁剪」互斥切换，专用于把斜拍试卷拉平 */}
          <View className="flex flex-col items-center" onClick={toggleCornerMode}>
            <View
              className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                cornerMode === 'quad' ? 'bg-primary' : 'bg-white bg-opacity-15'
              }`}
            >
              <Maximize2 size={20} color="#ffffff" />
            </View>
            <Text className="block text-white text-opacity-80 text-xs">四角拉框</Text>
          </View>
          {enableSaveToInbox && (
            <View className="flex flex-col items-center" onClick={handleSave}>
              <Database size={24} color="#ffffff" />
              <Text className="block text-white text-opacity-80 text-xs mt-1">保存图片</Text>
            </View>
          )}
        </View>
        <Button className="w-full h-11 rounded-xl bg-primary" disabled={busy || aiBusy} onClick={handleConfirm}>
          <Text className="block text-sm text-white">{busy ? '处理中…' : '使用此图（返回）'}</Text>
        </Button>
      </View>

      {/* 智能高清「倍率 / 模式」选择面板 */}
      {srPanelOpen && (
        <View className="absolute inset-0 z-[210]" onClick={() => setSrPanelOpen(false)}>
          <View className="absolute inset-0" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} />
          <View
            className="absolute left-4 right-4 rounded-2xl p-4"
            style={{ bottom: 24, backgroundColor: '#1c1c1e' }}
            onClick={(e: any) => e?.stopPropagation?.()}
          >
            <Text className="block text-white text-base font-medium mb-3">智能高清设置</Text>

            {/* 倍率 */}
            <Text className="block text-white text-opacity-70 text-xs mb-2">放大倍率</Text>
            <View className="flex flex-row gap-2 mb-4">
              {SR_SCALES.map((s) => {
                const active = srScale === s.value
                return (
                  <View
                    key={s.value}
                    className="flex-1 rounded-xl py-2 items-center"
                    style={{
                      backgroundColor: active ? '#3b82f6' : 'rgba(255,255,255,0.08)',
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: active ? '#3b82f6' : 'rgba(255,255,255,0.15)',
                    }}
                    onClick={() => setSrScale(s.value)}
                  >
                    <Text className="block text-white text-sm font-medium">{s.label}</Text>
                    <Text className="block text-white text-opacity-60 text-[10px] mt-1">{s.hint}</Text>
                  </View>
                )
              })}
            </View>

            {/* 模式 */}
            <Text className="block text-white text-opacity-70 text-xs mb-2">处理模式</Text>
            <View className="flex flex-row gap-2 mb-4">
              {SR_MODES.map((m) => {
                const active = srMode === m.value
                return (
                  <View
                    key={m.value}
                    className="flex-1 rounded-xl py-2 items-center"
                    style={{
                      backgroundColor: active ? '#3b82f6' : 'rgba(255,255,255,0.08)',
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: active ? '#3b82f6' : 'rgba(255,255,255,0.15)',
                    }}
                    onClick={() => setSrMode(m.value)}
                  >
                    <Text className="block text-white text-sm font-medium">{m.label}</Text>
                    <Text className="block text-white text-opacity-60 text-[10px] mt-1">{m.hint}</Text>
                  </View>
                )
              })}
            </View>

            <View className="flex flex-row gap-3">
              <Button
                className="flex-1 h-10 rounded-xl"
                style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
                onClick={() => setSrPanelOpen(false)}
              >
                <Text className="block text-sm text-white">取消</Text>
              </Button>
              <Button className="flex-1 h-10 rounded-xl bg-primary" disabled={busy || aiBusy} onClick={runEnhance}>
                <Text className="block text-sm text-white">开始处理</Text>
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

// 裁剪区外的半透明遮罩（上/下/左/右四块）
function Overlay({ crop }: { crop: Rect }) {
  const shade = 'rgba(0,0,0,0.45)'
  return (
    <View className="absolute inset-0 pointer-events-none">
      <View className="absolute left-0 right-0 top-0" style={{ height: `${crop.y * 100}%`, backgroundColor: shade }} />
      <View className="absolute left-0 right-0 bottom-0" style={{ height: `${(1 - crop.y - crop.h) * 100}%`, backgroundColor: shade }} />
      <View className="absolute top-0 bottom-0 left-0" style={{ top: `${crop.y * 100}%`, bottom: `${(1 - crop.y - crop.h) * 100}%`, width: `${crop.x * 100}%`, backgroundColor: shade }} />
      <View className="absolute top-0 bottom-0 right-0" style={{ top: `${crop.y * 100}%`, bottom: `${(1 - crop.y - crop.h) * 100}%`, width: `${(1 - crop.x - crop.w) * 100}%`, backgroundColor: shade }} />
    </View>
  )
}

/**
 * 四角透视的视觉层：四边形四条边 + 四个可拖拽圆点手柄 + 四边形外部遮罩。
 *
 * 纯视觉、不拦截触摸（pointer-events-none），手势由外层 cropTouchLayer 统一处理。
 * 遮罩实现：整个预览区铺一层半透明黑，再用「四边形内部的多边形填充」盖回亮色，
 * 等效于「只遮四边形外部」。多边形填充用 CSS `clip-path: polygon(...)`（小程序 WebView
 * 与主流渲染器均支持）；若目标端不支持，退化为纯半透明层（仍可正常拖拽，仅观感略弱）。
 */
function QuadOverlay({
  quad, imgW, imgH, activeCorner,
}: { quad: Corner[]; imgW: number; imgH: number; activeCorner: number | null }) {
  const pts = quad.map(([x, y]) => ({ x: x * imgW, y: y * imgH }))
  const edges = [
    [pts[0], pts[1]],
    [pts[1], pts[2]],
    [pts[2], pts[3]],
    [pts[3], pts[0]],
  ]
  // 用视口四角补一圈，构造「整块 - 四边形」的偶奇填充多边形
  const poly = [
    `0px 0px`, `${imgW}px 0px`, `${imgW}px ${imgH}px`, `0px ${imgH}px`,
    ...pts.map((p) => `${p.x}px ${p.y}px`),
  ].join(', ')
  return (
    <View className="absolute inset-0 pointer-events-none">
      {/* 四边形外部遮罩：整层半透明黑 + 内部挖空（clip-path evenodd） */}
      <View
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundColor: 'rgba(0,0,0,0.5)',
          clipPath: `polygon(evenodd, ${poly})`,
          WebkitClipPath: `polygon(evenodd, ${poly})`,
        }}
      />

      {/* 四条边 */}
      {edges.map(([a, b], i) => {
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
        return (
          <View
            key={`edge-${i}`}
            className="absolute pointer-events-none"
            style={{
              left: a.x, top: a.y - 1.5,
              width: Math.max(len, 1), height: 3,
              backgroundColor: '#ffffff',
              boxShadow: '0 0 3px rgba(0,0,0,0.6)',
              transform: `rotate(${angle}deg)`,
              transformOrigin: '0 50%',
              borderRadius: 2,
            }}
          />
        )
      })}

      {/* 四个角点手柄 */}
      {pts.map((p, i) => {
        const active = activeCorner === i
        return (
          <View
            key={`corner-${i}`}
            className="absolute pointer-events-none"
            style={{
              width: active ? 28 : 22,
              height: active ? 28 : 22,
              left: p.x - (active ? 14 : 11),
              top: p.y - (active ? 14 : 11),
              borderRadius: 999,
              borderWidth: 3, borderStyle: 'solid', borderColor: '#ffffff',
              backgroundColor: active ? '#3b82f6' : 'rgba(190,62,45,0.92)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
            }}
          />
        )
      })}
    </View>
  )
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

// ---------- 四角几何工具 ----------

/** 多边形面积（鞋带公式），返回绝对值归一化到 [0,1]² 坐标系。 */
function polygonArea(pts: Corner[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

/** 四边形是否有效：面积足够大，且四个顶点顺序不自交（凸且有序）。 */
function isValidQuad(pts: Corner[]): boolean {
  if (polygonArea(pts) < MIN_QUAD_AREA) return false
  // 按给出的顺序 [tl,tr,br,bl] 检查叉积同号（凸）
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % 4]
    const [x3, y3] = pts[(i + 2) % 4]
    const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2)
    if (Math.abs(cross) < 1e-6) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * 纯函数：归一化裁剪框 → 缓冲像素矩形。
 * 预览框与导出共用同一组归一化坐标（crop.x/y/w/h ∈ [0,1]），
 * 因此屏上框选区域与导出区域一一对应。导出缓冲=原图逻辑尺寸（见 exportEdited），
 * 故这里用到的 canvasW/canvasH 即缓冲像素，与 canvasToTempFilePath 的坐标单位一致。
 */
function cropToBufferRect(r: Rect, canvasW: number, canvasH: number) {
  return {
    x: r.x * canvasW,
    y: r.y * canvasH,
    w: r.w * canvasW,
    h: r.h * canvasH,
  }
}

const MIN_SIZE = 0.12

function applyDrag(r: Rect, target: DragTarget, dx: number, dy: number): Rect {
  const next = { ...r }
  switch (target) {
    case 'tl':
      next.x = r.x + dx; next.y = r.y + dy; next.w = r.w - dx; next.h = r.h - dy
      break
    case 'tr':
      next.y = r.y + dy; next.w = r.w + dx; next.h = r.h - dy
      break
    case 'bl':
      next.x = r.x + dx; next.w = r.w - dx; next.h = r.h + dy
      break
    case 'br':
      next.w = r.w + dx; next.h = r.h + dy
      break
    case 'l':
      next.x = r.x + dx; next.w = r.w - dx
      break
    case 'r':
      next.w = r.w + dx
      break
    case 't':
      next.y = r.y + dy; next.h = r.h - dy
      break
    case 'b':
      next.h = r.h + dy
      break
    case 'move':
      next.x = r.x + dx; next.y = r.y + dy
      break
  }
  return next
}

function clampCrop(r: Rect): Rect {
  let { x, y, w, h } = r
  if (w < MIN_SIZE) w = MIN_SIZE
  if (h < MIN_SIZE) h = MIN_SIZE
  if (w > 1) w = 1
  if (h > 1) h = 1
  x = clamp(x, 0, 1 - w)
  y = clamp(y, 0, 1 - h)
  return { x, y, w, h }
}
