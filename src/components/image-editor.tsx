import { View, Text, Canvas, Slider, ScrollView, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { RotateCw, Crop, Undo2, X, Wand, Sparkles, Eraser, Database, Maximize2 } from 'lucide-react-taro'
import { isRemoteImageUrl } from '@/utils/url'
import { processImage, uploadImage, fetchImageCapabilities, ApiError, type ImageAction } from '@/services/api'

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
  /**
   * #150 人工辅助错题整理：「页内裁剪入图」专用模式。
   * 只保留裁剪相关交互（拖框 / 旋转 / 四角拉框 / 确定裁剪），
   * 隐藏 AI 处理行与去手写相关开关——用户目标只有一个：裁出错题图。
   */
  cropOnly?: boolean
  /** cropOnly 模式下底部主按钮文案，默认「使用此图（返回）」 */
  confirmText?: string
  /**
   * #150 裁剪入题：在底部主按钮上方常驻显示「图片将存入：第 N 题」。
   * 解决 OCR 文字粘到题 A、裁剪图却进题 B——同题图文"分家"存成两道题的问题。
   */
  cropTargetLabel?: string
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 去手写「框选补擦」区域。
 * 结构与 Rect 相同、但语义独立：**归一化 0~1（相对整张预览图）**，
 * 与服务端 `ProcessImageDto.manual_regions` 严格同构，直接透传。
 */
type EraseRegion = Rect

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

// 默认裁剪框 = 整张图（思傅 2026-10-19 要求）。
// 历史值为内缩 5%/8% 的 {0.05,0.08,0.9,0.84}，导致「没碰裁剪框直接保存」
// 也会被裁掉四周；现默认全图，即便误触裁剪确认也无损失。
const DEFAULT_CROP: Rect = { x: 0, y: 0, w: 1, h: 1 }

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
// 离屏 Canvas 的尺寸硬上限（px）。
// 依据微信官方文档（canvas 组件 Bug & Tip 07）：
//   「Canvas 2D（新接口）需要显式设置画布宽高，默认 300*150，最大 1365*1365；
//     避免设置过大的宽高，在安卓下会有 crash 的问题」。
// 故取 1365 为安全上限：超过此值在部分机型会 crash / 报 set width out of range。
// ⚠️ 离屏 canvas 的 CSS 显示尺寸恒为 MAX_CANVAS_SIDE × MAX_CANVAS_SIDE（见 OffscreenCanvas 渲染），
//    缓冲尺寸 ≤ 此值，导出时显式传 width/height（≤ CSS），语义确定、不依赖布局时序。
const MAX_CANVAS_SIDE = 1365
// CSS 尺寸上限（css 永远 == 本次导出缓冲，不会超过此值）
const CANVAS_CSS_SIDE = MAX_CANVAS_SIDE

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

/**
 * 智能高清的「基础画面模式」（用户直接点选，对应后端 enhance_preset）。
 * 清单：原图 / 增强并锐化 / 增亮 / 灰度 / 黑白。x2/x3/x4 超分另立为
 * 「高清扩展」分组（见 SR_SCALES / HD_EXTENSION），默认选中「黑白」。
 */
const ENHANCE_PRESETS: { value: string; label: string; hint: string }[] = [
  { value: 'original', label: '原图', hint: '不增强' },
  { value: 'enhance', label: '增强并锐化', hint: '彩色·锐化' },
  { value: 'brighten', label: '增亮', hint: '偏暗/阴影' },
  { value: 'gray', label: '灰度', hint: '去色·留层次' },
  { value: 'bw', label: '黑白', hint: '文档·最清晰' },
]

/** 高清扩展：把原「x2/x3/x4 超分」立为独立可选分组（任务 #91 标记「超分=高清扩展」） */
const HD_EXTENSION = { value: 'hd', label: '高清扩展', hint: 'x2/x3/x4 超分放大' }

/**
 * 各模式滑杆语义（思傅 2026-10-22）：同一根「效果强度」杆在不同模式下含义不同，
 * 端点文案随之变化，避免「轻/重」词不达意。
 *  - bw：控制墨迹粗细（阈值偏置 + 形态学，幅度克制，两端不崩）
 *  - 其余：控制该模式的处理强度
 */
const SLIDER_HINT: Record<string, { title: string; left: string; right: string }> = {
  bw: { title: '墨迹粗细', left: '字细', right: '字粗' },
  gray: { title: '对比强度', left: '柔和', right: '鲜明' },
  brighten: { title: '提亮强度', left: '轻', right: '亮' },
  enhance: { title: '增强强度', left: '轻', right: '强' },
}

/** P1 强度档位：把"是否过头"的把控权交给用户 */
const ENHANCE_STRENGTHS: { value: 'weak' | 'medium' | 'strong'; label: string }[] = [
  { value: 'weak', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'strong', label: '强' },
]

/**
 * 思傅 2026-10-21：「黑白/灰度在有些图上好、有些图上不好」→ 强度从三档按钮改为**滑杆**，
 * 给默认值，不满意就自己拖到满意为止。滑杆归一化到 [0,1]，各模式映射到自己的合理区间：
 *  - brighten（增亮）：s=0 → 几乎不亮；s=1 → 提亮明显
 *  - enhance（增强并锐化）：s=0 → 轻提对比；s=1 → 强对比 + 强锐化
 *  - bw（黑白二值化）：s=0.5 = 稳健基准（背景白、字清晰）；s<0.5 字略细（防糊），
 *    s>0.5 字略粗（防断笔）。幅度克制，两端都不崩成黑团/全白
 *  - gray（灰度）：s 叠加轻微对比，让不同明暗的原图层次都合适
 *  - original：无效果，不展示滑杆
 */
const PRESET_SLIDER_DEFAULT = 0.5

const SR_MODES: { value: SRMode; label: string; hint: string }[] = [
  { value: 'classical', label: '标准', hint: '轻量锐化 · CPU 友好' },
  { value: 'espcn', label: '神经网络', hint: 'ESPCN · 细节更好 · 慢' },
]

export default function ImageEditor({
  visible, src, onCancel, onConfirm, autoAction = null, enableSaveToInbox = true,
  cropOnly = false, confirmText, cropTargetLabel,
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
  // framing=true：主动裁剪模式，显示裁剪框/遮罩/手柄。
  // ⭐ 思傅 2026-10-19 定：裁剪功能**默认关闭**（打开编辑器不显示裁剪框），
  //    用户点底部「裁剪」按钮才启用（按钮随之变为「确定裁剪」），调好框后点
  //    「确定裁剪」完成裁剪。cropOnly 模式（#150 页内裁剪入图）整页即为裁剪
  //    服务，保持初始启用，行为无回归。
  const [framing, setFraming] = useState(!cropOnly)
  const [previewError, setPreviewError] = useState(false)
  // 智能高清：点开即出「黑白」预览（默认），面板内可切换其他模式实时预览；
  // 倍率/处理模式仅「高清扩展」分组下使用。
  const [srScale, setSrScale] = useState<SRScale>(2)
  const [srMode, setSrMode] = useState<SRMode>('classical')
  // ── P1 后续：多模式预览自选 ────────────────────────────────────────────
  /** 五模式预览图（后端 multi_modes 一次产出），键为模式名 */
  const [modeThumbs, setModeThumbs] = useState<Record<string, { url: string }>>({})
  /** 当前选中的模式（后端未指定时由智能默认档给出） */
  const [activePreset, setActivePreset] = useState<string>('enhance')
  /** 强度档位 */
  const [enhanceStrength, setEnhanceStrength] = useState<'weak' | 'medium' | 'strong'>('medium')
  /** ⭐ 思傅 2026-10-21：画面模式强度滑杆（0~1，默认 0.5），实时重算预览 */
  const [presetSlider, setPresetSlider] = useState(PRESET_SLIDER_DEFAULT)
  /** 多模式预览的「原图底稿」：换模式时以它为输入重新生成，避免在处理结果上二次叠加增强 */
  const [enhanceBase, setEnhanceBase] = useState<string>('')
  const [srPanelOpen, setSrPanelOpen] = useState(false)
  /**
   * 智能高清面板中选中的模式：基础画面模式（'original'|'enhance'|'brighten'|'gray'|'bw'）
   * 或「高清扩展」('hd')。默认 'bw'（黑白）——点开即给出黑白预览；点「确定」时
   * 据此决定走 enhance_preset 还是 sr_scale 路径。
   */
  const [activeMode, setActiveMode] = useState<'original' | 'enhance' | 'brighten' | 'gray' | 'bw' | 'hd'>('bw')

  // ── 去手写：框选补擦 + 对比 + 撤销（方案 §5.10 R1/R2）────────────────────
  // eraseMode=true：用户在 result 图上划框，圈出「自动漏擦的手写」
  const [eraseMode, setEraseMode] = useState(false)
  /**
   * ⭐ 红/蓝笔卷模式（v18.2）：开启后 erase_v2 走 `erase_mode='color'`
   * （仅彩色笔迹通道 + 印刷保护闸）。背景：红笔批改/作答卷上，深色墨迹与
   * 布局槽位通道对红笔清除零贡献，却会把印刷正文连同红笔一起吞掉
   * （实测 mask 内被删像素 42.5% 是印刷）。黑笔/铅笔卷保持默认 union。
   */
  const [colorPenMode, setColorPenMode] = useState(false)
  /** 已圈选区域（归一化）。点「应用去手写」时作为 manual_regions 透传给后端 */
  const [eraseRects, setEraseRects] = useState<EraseRegion[]>([])
  /** 跟随手指的虚框（显示坐标 px），仅用于实时反馈，松手后转为 eraseRects */
  const [eraseDrag, setEraseDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const eraseDragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  /**
   * 去手写步骤栈：每成功擦除一次就压入「擦除前」的图。
   * 栈顶即对比用的「擦除前」图，撤销=弹栈并回显。
   */
  const [eraseStack, setEraseStack] = useState<string[]>([])
  /** 对比模式开关：左侧显示擦除前、右侧显示擦除后 */
  const [compareMode, setCompareMode] = useState(false)
  /** 对比滑杆位置 0~1：左侧露出「擦除前」的比例 */
  const [compareRatio, setCompareRatio] = useState(0.5)
  // 编辑模式：矩形裁剪 / 四角透视（互斥）。默认矩形，行为与历史一致。
  const [cornerMode, setCornerMode] = useState<CornerMode>('rect')
  // 四角归一化坐标，顺序 [tl,tr,br,bl]
  const [quad, setQuad] = useState<Corner[]>(DEFAULT_QUAD)
  // 当前拖拽中的角点索引（用于高亮）
  const [activeCorner, setActiveCorner] = useState<number | null>(null)
  // 离屏 canvas 的 CSS 显示尺寸：**每次导出前同步为本次缓冲尺寸**（见 waitCanvasCss 说明）。
  // 初始为上限方框，导出时会被覆盖为 bufW×bufH。
  const [canvasCss, setCanvasCss] = useState<{ w: number; h: number }>({ w: CANVAS_CSS_SIDE, h: CANVAS_CSS_SIDE })

  const canvasNodeRef = useRef<any>(null)
  /** 强度滑杆拖动节流定时器（顶部声明，遵守 hooks 调用顺序） */
  const sliderTimerRef = useRef<any>(null)
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
    if (!isRemoteImageUrl(u)) return u
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

  // 打开/换图：复位所有状态并加载。
  // ⭐ 关键：组件从不卸载（if (!visible) return null），故跨会话的全部「会话态」都必须在此清空，
  //    否则下一张图会残留上一张图的滤镜预览/增强底稿/去手写步骤等（问题①：选择效果栏残留旧图、智能高清主图被旧底稿替换）。
  useEffect(() => {
    if (!visible || !src) return
    setCurrentSrc(src)
    // 基础编辑态
    setRotation(0)
    setCrop(DEFAULT_CROP)
    setQuad(DEFAULT_QUAD)
    setCornerMode('rect')
    setActiveCorner(null)
    setBusy(false)
    setAiBusy(false)
    setFraming(!!cropOnly)
    setPreviewError(false)
    setNaturalW(0)
    setNaturalH(0)
    canvasNodeRef.current = null
    // 智能高清 / 滤镜预览缓存（问题①核心残留项）
    setModeThumbs({})
    setActivePreset('enhance')
    setEnhanceStrength('medium')
    setPresetSlider(PRESET_SLIDER_DEFAULT)
    setEnhanceBase('')
    setActiveMode('bw')
    setSrPanelOpen(false)
    setSrScale(2)
    setSrMode('classical')
    // 去手写步骤栈 / 框选
    setEraseMode(false)
    setEraseRects([])
    setEraseDrag(null)
    setEraseStack([])
    // 对比态
    setCompareMode(false)
    setCompareRatio(0.5)
    // 红/蓝笔卷模式随图重置
    setColorPenMode(false)
    void openImage(src)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, src])

  // 打开后自动执行指定 AI 处理（等图片尺寸就绪后再跑，避免基于空图）
  useEffect(() => {
    if (!visible || !autoAction || aiBusy || busy) return
    if (!naturalW) {
      // 图未就绪不静默吞掉：若是「无法读取尺寸」,给用户明确提示,避免「点了没反应」的错觉
      if (previewError) {
        Taro.showToast({ title: '图片未就绪，请重新选择图片', icon: 'none' })
      }
      return
    }
    // ⭐ 智能高清（enhance）不直接跑后端超分。
    //    外部入口（首页「最近题目 · …」、拍照识别页的「智能高清」按钮）此前传
    //    autoAction='enhance' → 这里直接 handleAi('enhance') → 后端默认 x2 高清放大，
    //    用户拿到的永远是「放大版原图」，而编辑器内点同一个按钮却是「先选模式
    //    （原图/增强并锐化/增亮/灰度/黑白/高清扩展）」。同一功能两条路径行为不一致
    //    （思傅 2026-10-20 反馈：「智能高清」调的是「高清放大」）。
    //    现在统一走 dispatchAi('enhance')：与编辑器内点按完全一致，先弹模式面板，
    //    由用户决定模式；「高清放大（超分）」仅作为面板里的「高清扩展」一项存在。
    if (autoAction === 'enhance') {
      void dispatchAi('enhance', '智能高清')
      return
    }
    const cfg = AI_ACTIONS.find((a) => a.action === autoAction)
    if (cfg) void handleAi(cfg.action, cfg.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoAction, naturalW, previewError])

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
    // 智能高清面板打开期间，点图片不进入裁剪模式（避免裁剪框遮罩盖住模式预览）
    if (srPanelOpen) return
    setFraming(true)
  }

  // ══════════════════════════════════════════════════════════════════════
  // 去手写补正：框选补擦 / 对比 / 撤销（方案 §5.10 R1 / R2）
  //
  // 设计动机：自动检测不可能覆盖 100%（GT 回归里「7题细笔画+括号碎裂」这类
  // 硬边界实测就漏检）。与其继续加判据（边际收益递减且互相干扰，见 §5.7），
  // 不如给用户一条 **5 秒就能修好** 的通道：圈住漏擦的手写 → 后端无条件并入
  // mask → 实测圈选区擦净率 100%。
  // ══════════════════════════════════════════════════════════════════════

  /** 栈顶 = 最近一次擦除「之前」的图（对比左半 & 撤销目标） */
  const beforeSrc = eraseStack.length > 0 ? eraseStack[eraseStack.length - 1] : null

  /** 进入/退出框选补擦模式 */
  const toggleEraseMode = () => {
    if (busy || aiBusy) return
    if (eraseMode) {
      setEraseMode(false)
      setEraseRects([])
      eraseDragRef.current = null
      setEraseDrag(null)
      return
    }
    if (!beforeSrc) {
      Taro.showToast({ title: '请先做一次「去手写」，再圈选漏擦部分', icon: 'none' })
      return
    }
    setEraseMode(true)
    setFraming(false)
    setCompareMode(false)
    Taro.showToast({ title: '在图上划框圈住漏擦的手写，完成后点「应用去手写」', icon: 'none', duration: 2600 })
  }

  const onEraseTouchStart = (e: any) => {
    // 每次触摸前重新测量图片盒位置（父级 inset/缩放会漂移），用它自身的坐标系算点
    measureBox(() => {
      const t = e.touches[0]
      const rx = clamp(t.clientX - boxRectRef.current.left, 0, imgW)
      const ry = clamp(t.clientY - boxRectRef.current.top, 0, imgH)
      const d = { x0: rx, y0: ry, x1: rx, y1: ry }
      eraseDragRef.current = d
      setEraseDrag(d)
    })
  }

  const onEraseTouchMove = (e: any) => {
    const d = eraseDragRef.current
    if (!d) return
    const t = e.touches[0]
    const rx = clamp(t.clientX - boxRectRef.current.left, 0, imgW)
    const ry = clamp(t.clientY - boxRectRef.current.top, 0, imgH)
    const next = { ...d, x1: rx, y1: ry }
    eraseDragRef.current = next
    setEraseDrag(next)
  }

  const onEraseTouchEnd = () => {
    const d = eraseDragRef.current
    eraseDragRef.current = null
    setEraseDrag(null)
    if (!d || imgW <= 0 || imgH <= 0) return
    const x0 = Math.min(d.x0, d.x1)
    const x1 = Math.max(d.x0, d.x1)
    const y0 = Math.min(d.y0, d.y1)
    const y1 = Math.max(d.y0, d.y1)
    const w = (x1 - x0) / imgW
    const h = (y1 - y0) / imgH
    // 轻点误触会产生极小框 → 忽略（否则一次轻点就提交一个无意义区域）
    if (w < 0.015 || h < 0.015) {
      Taro.showToast({ title: '框太小，已忽略', icon: 'none', duration: 1200 })
      return
    }
    setEraseRects((rs) => [...rs, { x: x0 / imgW, y: y0 / imgH, w, h }])
  }

  const clearEraseRects = () => {
    setEraseRects([])
    eraseDragRef.current = null
    setEraseDrag(null)
  }

  /** 提交框选区域做局部重擦（manual_regions 透传给后端无条件并入 mask） */
  const applyEraseRegions = async () => {
    if (busy || aiBusy) return
    if (eraseRects.length === 0) {
      Taro.showToast({ title: '请先在图上划框圈住漏擦的手写', icon: 'none' })
      return
    }
    const regions = eraseRects
    setEraseMode(false)
    setEraseRects([])
    await handleAi('erase_v2', '去手写', { manual_regions: regions })
  }

  /** 撤销最近一次成功的去手写步骤（回显该步骤之前的图） */
  const undoErase = async () => {
    if (busy || aiBusy) return
    if (eraseStack.length === 0) {
      Taro.showToast({ title: '没有可撤销的去手写步骤', icon: 'none' })
      return
    }
    const last = eraseStack[eraseStack.length - 1]
    setEraseStack((s) => s.slice(0, -1))
    setEraseMode(false)
    setEraseRects([])
    setCompareMode(false)
    setCurrentSrc(last)
    try {
      const info = await Taro.getImageInfo({ src: last })
      setRotation(0)
      setCrop(DEFAULT_CROP)
      setQuad(DEFAULT_QUAD)
      setCornerMode('rect')
      resetBox(info.width, info.height)
    } catch {
      /* 拿不到尺寸也先换图，不影响撤销本身 */
    }
    setFraming(false)
    Taro.showToast({ title: '已撤销上一步去手写', icon: 'success' })
  }

  /** 原图/结果对比（P3 对标夸克：滑杆拖动看差异） */
  const toggleCompare = () => {
    if (!beforeSrc) {
      Taro.showToast({ title: '还没有对比对象，请先做一次去手写', icon: 'none' })
      return
    }
    setCompareMode((v) => !v)
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
      // 旋转结果即是「成品」：framing=false 干净预览态（不再显示裁剪框）。
      // 保存/返回链路只认 currentSrc，绝不会按 crop 再裁一刀（2026-10-19 修复，见 handleSave）。
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
    setFraming(!!cropOnly)
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
   * 等待一次布局/绘制落地。
   *
   * ⚠️ 不再依赖 requestAnimationFrame：
   *   离屏 canvas 位于 `left:-9999px`，部分渲染器会对其**节流甚至不触发** rAF，
   *   一旦 `await new Promise(r => raf(r))` 的 rAF 永不回调，整个导出流程会**永久挂起**
   *   （表现为点旋转/保存后卡死无响应）。因此这里只用「宏任务让出一帧 + 短延时」，
   *   保证**一定会 resolve**（确定性优先于极致紧凑）。
   */
  const waitLayout = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 32))
  }

  /**
   * 轮询等待 canvas 的 CSS 尺寸变为目标值，**确定性 resolve**（永不挂起）。
   * 返回实测 CSS 尺寸（超时也返回实测值，调用方按实测值导出，仍可保证正确）。
   *
   * ★ 为什么必须 CSS == 缓冲（血泪教训，勿删）：
   *   canvasToTempFilePath 的 x/y/width/height 是「CSS 显示尺寸」口径
   *   （官方默认值 width=canvasWidth-x 即 CSS 宽；社区/PC 端实测截取宽度=屏宽×pixelRatio）。
   *   旧实现 CSS 固定 1365×1365 方框而缓冲动态（如 768×1365）→ 两者失配：
   *   传「缓冲口径的坐标」被按「CSS 口径」解释 → 裁剪区域错位跑飞（飞到框选范围外）、
   *   旋转烘焙输出被拉伸放大且逐次累积（转一次放大一次）。
   *   修复 = 每次导出前把 CSS 同步为缓冲尺寸（1:1，无歧义）+ 轮询实测确认。
   */
  const waitCanvasCss = async (targetW: number, targetH: number, retry = 20): Promise<{ w: number; h: number }> => {
    let measured = { w: 0, h: 0 }
    for (let i = 0; i < retry; i++) {
      const rect: any = await new Promise((resolve) => {
        Taro.createSelectorQuery()
          .select(`#${CANVAS_ID}`)
          .boundingClientRect((r: any) => resolve(Array.isArray(r) ? r[0] : r))
          .exec()
      })
      if (rect && rect.width > 0 && rect.height > 0) {
        measured = { w: Math.round(rect.width), h: Math.round(rect.height) }
        if (Math.abs(measured.w - targetW) <= 2 && Math.abs(measured.h - targetH) <= 2) return measured
      }
      await new Promise((r) => setTimeout(r, 48))
    }
    return measured
  }

  /**
   * 加载图片（node.createImage），返回 Image 对象。
   */
  const loadImageOnCanvas = async (node: any, imgUrl: string): Promise<any> => {
    let img: any = null
    if (node.createImage) img = node.createImage()
    else img = new Image()
    img.src = imgUrl
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      img.onload = finish
      img.onerror = finish
      setTimeout(finish, 8000)
    })
    if (!img.width || !img.height) throw new Error('图片加载失败，无法导出')
    return img
  }

  /**
   * 真正执行「绘制 + 导出」。
   *
   * ★ 核心设计（对 canvasToTempFilePath 的坐标口径**完全免疫**）：
   *  1. 缓冲 = 成品：把「最终要输出的内容」直接画满整个缓冲——
   *     - 裁剪：ctx.drawImage 九参形式 (sx,sy,sw,sh → 0,0,outW,outH)，源矩形→目标矩形，
   *       是 Canvas 规范保证的精确映射，数学上零偏移；
   *     - 旋转烘焙：整图以缓冲中心为轴旋转铺满（宽高已交换）。
   *     这样导出只需「取整个缓冲」，不再依赖 canvasToTempFilePath 做任何区域换算。
   *  2. CSS == 缓冲：导出前把 canvas CSS 尺寸同步为缓冲尺寸并轮询实测确认（waitCanvasCss），
   *     使「显示区域 = 缓冲区域」严格 1:1。
   *  3. 全区域导出：x=0, y=0, width/height=实测 CSS，destWidth/destHeight=缓冲尺寸。
   *     无论微信内部按 CSS / 缓冲 / CSS×dpr 哪种口径解释 x/y/width/height，
   *     「原点 + 全尺寸区域」都覆盖整个缓冲（超出部分被 clamp 到边界），
   *     输出像素由 destWidth/destHeight 显式决定 —— 三种口径殊途同归，全部正确。
   *
   * @param rot      旋转角度（度，顺时针 90 的倍数）
   * @param fullFrame true=导出整张（用于旋转烘焙）；false=按 crop 选区导出（用于确定裁剪/保存）
   */
  const drawAndExport = async (node: any, rot: number, fullFrame: boolean): Promise<string> => {
    const norm = ((rot % 360) + 360) % 360
    if (!fullFrame && norm !== 0) {
      // 运行时裁剪恒 rot=0（旋转按钮会先把旋转烘焙进图片再归零 rotation）。
      // 此分支是安全网：避免「旋转+裁剪」复合坐标系换算出错（宁可明确报错也不输出错图）。
      throw new Error('请先点「旋转90°」完成旋转，再进行裁剪')
    }
    const swap = norm === 90 || norm === 270

    await waitLayout()

    const srcLocal = await toLocalIfRemote(currentSrc)

    // 输出缓冲尺寸计算（先按 state 估算，加载实际图片后再校正，见下方防御分支）
    const fitWhole = Math.min(1, MAX_CANVAS_SIDE / Math.max(naturalW, naturalH, 1))
    const wholeW = Math.max(1, Math.round(naturalW * fitWhole))
    const wholeH = Math.max(1, Math.round(naturalH * fitWhole))

    let outW: number
    let outH: number
    let sx = 0
    let sy = 0
    let sw = 0
    let sh = 0

    if (fullFrame) {
      outW = swap ? wholeH : wholeW
      outH = swap ? wholeW : wholeH
      sw = naturalW
      sh = naturalH
    } else {
      const selW = crop.w * naturalW
      const selH = crop.h * naturalH
      const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(selW, selH, 1))
      outW = Math.max(1, Math.round(selW * fit))
      outH = Math.max(1, Math.round(selH * fit))
      sx = crop.x * naturalW
      sy = crop.y * naturalH
      sw = selW
      sh = selH
    }

    // CSS 同步为缓冲尺寸（1:1）—— 消除「CSS 口径 vs 缓冲口径」歧义的根基
    setCanvasCss({ w: outW, h: outH })
    const css = await waitCanvasCss(outW, outH)

    node.width = outW
    node.height = outH
    const ctx = node.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, outW, outH)

    const img = await loadImageOnCanvas(node, srcLocal)

    // ★ 防御：state 尺寸与实际文件不符时，以实际文件为准重算（源坐标/输出尺寸全部按实际）。
    //   不一致常见于：远程图 EXIF 旋转、getImageInfo 与 Image 解码差异、异步替换竞态。
    if (Math.abs(img.width - naturalW) > 2 || Math.abs(img.height - naturalH) > 2) {
      const f2 = Math.min(1, MAX_CANVAS_SIDE / Math.max(img.width, img.height, 1))
      const w2 = Math.max(1, Math.round(img.width * f2))
      const h2 = Math.max(1, Math.round(img.height * f2))
      if (fullFrame) {
        outW = swap ? h2 : w2
        outH = swap ? w2 : h2
        sw = img.width
        sh = img.height
      } else {
        const selW2 = crop.w * img.width
        const selH2 = crop.h * img.height
        const f3 = Math.min(1, MAX_CANVAS_SIDE / Math.max(selW2, selH2, 1))
        outW = Math.max(1, Math.round(selW2 * f3))
        outH = Math.max(1, Math.round(selH2 * f3))
        sx = crop.x * img.width
        sy = crop.y * img.height
        sw = selW2
        sh = selH2
      }
      setCanvasCss({ w: outW, h: outH })
      const css2 = await waitCanvasCss(outW, outH)
      node.width = outW
      node.height = outH
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, outW, outH)
      // css2 覆盖 css（后续导出用最新实测）
      css.w = css2.w || outW
      css.h = css2.h || outH
    }

    // 绘制「成品内容」铺满缓冲
    if (fullFrame && norm !== 0) {
      // 整图旋转烘焙：以缓冲中心为轴旋转，整张铺满（不缩放、不裁边）
      // ★ 修复（2026-10-20，思傅实测「旋转后图片被裁剪」）：
      //   5 参 drawImage(img, x, y, w, h) 的 w/h 是**目标像素尺寸**（源恒为整图），
      //   原图 > MAX_CANVAS_SIDE 时 outW/outH 已按 fit 缩小，若仍按原图尺寸 sw/sh
      //   绘制，大图四边会被缓冲裁掉。修法：旋转坐标系内先 scale(fit) 再以原图
      //   像素 1:1 绘制——scale 后外接恰为 sh*fit × sw*fit，与 swap 后的
      //   outW × outH 严格一致（90/270° 互换，180° 不变），零裁剪。
      //   fit 现场按 sw/sh 实算，与主路径 fitWhole / 防御路径 f2 同公式，三者一致。
      const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(sw, sh, 1))
      ctx.save()
      ctx.translate(outW / 2, outH / 2)
      ctx.rotate((norm * Math.PI) / 180)
      ctx.scale(fit, fit)
      ctx.drawImage(img, -sw / 2, -sh / 2)
      ctx.restore()
    } else if (norm === 0 && !fullFrame) {
      // 纯裁剪：九参 drawImage 把选区精确画满缓冲（Canvas 规范保证的源矩形→目标矩形映射）
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
    } else {
      // fullFrame 且无旋转：整图原样铺满
      ctx.drawImage(img, 0, 0, sw, sh, 0, 0, outW, outH)
    }

    // 全区域导出：无论内部口径（CSS / 缓冲 / CSS×dpr）如何解释，
    // 「原点 + 全尺寸区域」都覆盖整个缓冲；输出像素由 destWidth/destHeight 显式决定。
    const expW = css.w > 0 ? css.w : outW
    const expH = css.h > 0 ? css.h : outH
    return new Promise<string>((resolve, reject) => {
      Taro.canvasToTempFilePath({
        canvas: node,
        x: 0,
        y: 0,
        width: expW,
        height: expH,
        destWidth: outW,
        destHeight: outH,
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
      setFraming(false)  // 不再显示裁剪框（干净预览）
      Taro.showToast({ title: '已裁剪，点「使用此图」返回', icon: 'none' })
    } catch (err) {
      console.error('裁剪失败', err)
      Taro.showToast({ title: (err as any)?.message || '裁剪失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  const compressImage = async (filePath: string): Promise<string> => {
    if (isRemoteImageUrl(filePath)) return filePath
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
   * 成功/失败都把 framing 置为 false，让图片回到「干净预览」，不再停在「裁剪中」视觉态。
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
    opts?: {
      sr_scale?: SRScale
      sr_mode?: SRMode
      manual_corners?: Corner[]
      /** 去手写框选补擦区域（归一化），透传给后端 manual_regions */
      manual_regions?: EraseRegion[]
      /** 去手写擦除模式（v18.2）：'color'=红/蓝笔卷保印刷；缺省 union=黑笔卷 */
      erase_mode?: 'union' | 'color'
      /** 智能高清输出模式（P1 预览自选） */
      enhance_preset?: 'original' | 'enhance' | 'bw' | 'brighten' | 'gray'
      /** 一次产出五种模式预览图（P1 预览自选） */
      multi_modes?: boolean
      /** 智能高清强度档位（P1 档位选择） */
      enhance_strength?: 'weak' | 'medium' | 'strong'
    },
    /** true = 本次为「限流降级重试」，不再二次降级（防循环） */
    degradedRetry = false,
    /**
     * ⭐ 源图覆盖（P1 换模式专用）：默认用 currentSrc，但「切换输出模式」时必须传
     * **增强前的底稿**——否则是在已增强的图上再增强一次，效果叠加失真。
     */
    sourceOverride?: string,
  ) => {
    if (aiBusy || busy) return
    setAiBusy(true)
    Taro.showLoading({ title: `${label}处理中…`, mask: true })
    let lastGoodSrc = currentSrc
    // ⭐ 记录「处理前」的原图：去手写成功后压入步骤栈，供对比/撤销使用（§5.10 R2）
    const srcBefore = currentSrc
    // 进入处理即退出对比态，避免滑杆停留在旧结果上造成困惑
    setCompareMode(false)
    try {
      const sourceForProcess = await compressImage(sourceOverride || currentSrc)
      lastGoodSrc = sourceForProcess

      let sourceUrl = sourceForProcess
      if (!isRemoteImageUrl(sourceForProcess)) {
        const up = await uploadImage(sourceForProcess, { purpose: 'temp' })
        sourceUrl = up.url
      }

      const data = await processImage(
        action,
        sourceUrl,
        action === 'erase_v2'
          ? { ...opts, erase_mode: colorPenMode ? 'color' : 'union' }
          : opts,
      )
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
          Taro.showToast({ title: '拖动四个圆点框住试卷四角，拉完点「确认四角」', icon: 'none', duration: 2500 })
        } else {
          // 用户放弃：把后端返回的原图（内容保真）落到当前预览
          const dl: any = await downloadWithTimeout(data.url, 30000)
          if (dl?.tempFilePath) {
            const info = await Taro.getImageInfo({ src: dl.tempFilePath })
            setCurrentSrc(dl.tempFilePath)
            setRotation(0)
            setCrop(DEFAULT_CROP)
            resetBox(info.width, info.height)
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
      // AI 结果是「成品」：framing=false 干净预览态（不再显示裁剪框）。
      // 保存/返回链路只认 currentSrc，不会按 crop 再裁一刀（2026-10-19 修复，见 handleSave）。
      setFraming(false)

      // ⭐ 去手写步骤入栈：栈顶 = 该次擦除「之前」的图 → 对比左侧 / 撤销目标。
      //   只在成功后入栈，失败的一步步档不入历史（与服务器异常恢复语义一致）。
      if (action === 'erase' || action === 'erase_v2') {
        setEraseStack((s) => [...s, srcBefore])
      }

      // ⭐ P1 多模式预览自选：后端一次产出五模式后，落地缩略图与默认档。
      //   同时记住「底稿」，后续换模式以底稿为输入重新生成（不在成品上二次增强）。
      if (action === 'enhance') {
        const modes = (data as any)?.modes as Record<string, { url: string }> | undefined
        if (modes && Object.keys(modes).length > 0) {
          setModeThumbs(modes)
          setEnhanceBase(srcBefore)
          const auto = (data as any)?.debug?.autoPreset as string | undefined
          const reqPreset = (opts as any)?.enhance_preset as string | undefined
          // 优先用用户刚选中的画面模式高亮，其次后端智能默认档，最后回退增强
          setActivePreset(reqPreset || auto || 'enhance')
        } else {
          setModeThumbs({})
        }
      }

      // ⭐「没改动」必须说出来。后端凡是**安全地原样返回原图**的分支都会带 debug.notice
      //   （未检出手写 / 未识别到歪斜 / 高清未通过内容校验已回退）。
      //   此前这里只弹一句「完成」的 toast，图片看起来毫无变化 → 用户只能反馈
      //   「点了还是不能用」，且连续五轮拿不到任何原因。现在改为弹窗说清原因与下一步。
      const notice = (data as any)?.debug?.notice as
        | { level: 'info' | 'warn'; title: string; message: string }
        | undefined
      if (notice?.title) {
        Taro.showModal({
          title: notice.title,
          content: notice.message,
          confirmText: '知道了',
          showCancel: false,
        })
      } else {
        Taro.showToast({ title: `${label}完成`, icon: 'success' })
      }
    } catch (e) {
      console.error('AI 图片处理失败', e)
      // 限流类错误（429/503）走专用降级分支；degradedRetry 时不再二次降级（防循环）
      if (!degradedRetry && (await handleSrRateLimit(e, label))) {
        setCurrentSrc(lastGoodSrc)
        setAiBusy(false)
        Taro.hideLoading()
        return
      }
      setCurrentSrc(lastGoodSrc)
      try {
        const info = await Taro.getImageInfo({ src: lastGoodSrc })
        resetBox(info.width, info.height)
      } catch { /* ignore */ }
      // ★ 失败详情必须弹窗展示（而非一闪而过的 toast）：
      //   之前五轮反馈「点了不能用」却拿不到任何错误细节，就是因为 toast 1.5s 即消失。
      //   弹窗需要用户手动关闭 → 用户能看清/截图真实原因，反馈才能闭环。
      await showAiErrorDetail(label, e)
    }
    // 说明：降级重试通过 void handleAi(...) 异步派发，本函数随即返回；
    // 收尾（清 busy / 收 loading）统一放在 return 之前，避免与重试的 loading 交叉。
    setAiBusy(false)
    Taro.hideLoading()
  }

  /**
   * AI 处理失败的详情弹窗（用户手动关闭，信息不丢失）。
   * 先查线上后端能力自检（GET /api/image/capabilities）：
   *  - 不支持 = 线上是旧版后端 → 明确告知「服务未更新」，给出可操作指引；
   *  - 支持 = 新版后端处理失败 → 展示完整错误（HTTP 状态码 + 后端消息/网络错误），便于反馈闭环。
   */
  const showAiErrorDetail = async (label: string, e: unknown) => {
    let detail = ''
    if (e instanceof ApiError) {
      detail = `服务返回错误 ${e.status}${(e as any)?.code ? `（${(e as any).code}）` : ''}：${e.message || '无'}`
    } else if (e instanceof Error) {
      detail = e.message || '未知错误'
    } else {
      detail = String(e || '未知错误')
    }
    // 能力自检：把「通道不通」「线上服务未更新」「处理失败」三者区分开
    let capHint = ''
    try {
      const cap = await fetchImageCapabilities()
      if (cap.networkError) {
        const backendAddr = (typeof PROJECT_DOMAIN !== 'undefined' && PROJECT_DOMAIN) || 'http://127.0.0.1:3001'
        capHint = `\n\n⚠️ 连不上后端服务器（请求未发出或超时）——这不是「服务版本」问题。\n当前后端地址：${backendAddr}\n请检查：① 真机调试二维码是否已重新生成并扫码（旧码连的是旧会话）；② 手机与电脑是否在同一局域网；③ 电脑本地后端是否在运行。`
      } else if (!cap.supported) {
        capHint = `\n\n检测到服务未包含「${label}」所需的处理模块（服务版本过旧）。请联系开发者更新后端。`
      }
    } catch { /* 自检失败不影响错误展示 */ }
    Taro.showModal({
      title: `${label}失败`,
      content: `${detail}${capHint}`,
      confirmText: '知道了',
      showCancel: false,
    })
  }

  const handleSave = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    Taro.showLoading({ title: '保存中…', mask: true })
    try {
      // ★ 保存链路永不按裁剪框二次裁剪（思傅 2026-10-19 修复）：
      //   用户没有点过「确定裁剪」时，保存的必须是 currentSrc（原图/旋转/AI 成品），
      //   绝不再用 crop 裁一刀——此前 framing 初始为 true 且 DEFAULT_CROP 内缩，
      //   导致「没碰裁剪框直接保存」存的就是被裁掉四周的图（用户实测 bug）。
      //   裁剪结果生效的唯一路径：点「确定裁剪」(handleConfirmCrop) → currentSrc 替换为成品。
      const imgSrc = await toLocalIfRemote(currentSrc)
      if (!imgSrc) throw new Error('图片处理失败，请重试')
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
      // 统一规则（思傅 2026-10-19 定）：「未点确定裁剪 = 不裁剪」。
      // 除 cropOnly（#150 页内裁剪入图：整页即为裁剪服务，矩形模式下底部主按钮
      // 就是「确认裁剪并返回」的出口，保留按框导出）外，其余模式一律直接回传
      // currentSrc——裁剪/四角的成品都在用户点过「确定裁剪」/「确认四角」后
      // 已替换进 currentSrc，保存/返回链路不再按框二次裁剪（双保险：
      // DEFAULT_CROP 已改为全图 + 此链路不再裁）。
      const out = cropOnly && cornerMode === 'rect'
        ? await exportEdited()
        : await toLocalIfRemote(currentSrc)
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
   *  - 智能高清(enhance)：先弹出模式选择面板（基础画面模式 + 高清扩展），选定后再处理。
   *  - 自动调正(auto)：若当前处于四角模式，带上手动四角（归一化）提交 → 精准透视压平。
   *  - 其余动作：保持原行为，点击即处理。
   */
  const dispatchAi = (action: ImageAction, label: string) => {
    if (aiBusy || busy) return
    if (action === 'enhance') {
      // 以「当前图」作为本次智能高清会话的原图底稿，并清空上次会话的预览缓存，
      // 避免基于不同底稿的缓存错配（也避免拿过滤镜的图二次叠加增强）。
      setEnhanceBase(currentSrc)
      setModeThumbs({})
      setActiveMode('bw') // 默认选中「黑白」，点开即给出黑白预览
      setActivePreset('bw')
      setSrPanelOpen(true)
      // ⭐ 隐藏裁剪框/遮罩：模式预览需要一张干净的图（思傅 2026-10-19 反馈：
      //    裁剪框的四块遮罩盖在预览图上，效果同样看不清）。取消/确定后面板关闭，
      //    用户点底部「裁剪」按钮可随时重新进入裁剪。
      setFraming(false)
      // ⭐ 前端实时预览：基础模式（含默认黑白）本地即时出图，点击即显，
      //    不再走后端（对标扫描王/夸克的即时滤镜，规避秒级网络往返）。
      void pickEnhanceModeLocal('bw')
      return
    }
    if (action === 'auto') {
      const corners = cornerMode === 'quad' ? quad : undefined
      void handleAi(action, label, corners ? { manual_corners: corners } : undefined)
      return
    }
    void handleAi(action, label)
  }

  /**
   * ⭐ P1 预览自选：点选某个模式。
   * 第一步：立即把主图切到该模式的**预览图**（秒切，用户先看到差别）；
   * 第二步：以「增强前底稿」为输入，按该模式重新生成**最终高清画质**并替换主图
   *        （若不换底稿，就是在已增强的成品上再增强一次 → 效果叠加失真）。
   */
  /**
   * ⭐ 基础画面模式（原图/增强并锐化/增亮/灰度/黑白）：前端本地实时处理。
   * 点击即出预览（百毫秒级），不走后端；结果缓存到 modeThumbs 复用（二次点击秒切）。
   * 仅「高清扩展」超分才走后端（见 runEnhance）。
   */
  const pickEnhanceModeLocal = async (preset: string, sliderVal?: number) => {
    if (aiBusy || busy) return
    setActivePreset(preset)
    // 原图模式直接回退底稿（无需计算）
    if (preset === 'original') {
      const base = enhanceBase || currentSrc
      setCurrentSrc(base)
      return
    }
    // 缓存命中：直接切换主图（秒切，无等待）。⚠️ 键必须带滑杆值，否则拖杆后会拿到旧档结果
    const s = sliderVal !== undefined ? sliderVal : presetSlider
    const cached = modeThumbs[`${preset}@${s.toFixed(2)}`]?.url
    if (cached) {
      setCurrentSrc(cached)
      return
    }
    // 本地即时渲染（白底黑字二值化 / 灰度 / 增亮 / 增强锐化）
    setAiBusy(true)
    // mask:false——加载圈不再遮挡图片区域，用户能看到主图切换的整个过程
    Taro.showLoading({ title: '预览中…', mask: false })
    try {
      const base = enhanceBase || currentSrc
      const out = await renderLocalPreset(base, preset, s)
      setModeThumbs((m) => ({ ...m, [`${preset}@${s.toFixed(2)}`]: { url: out } }))
      setCurrentSrc(out)
    } catch (e) {
      console.warn('[image-editor] 本地预览失败', e)
      Taro.showToast({ title: '预览生成失败，请重试', icon: 'none' })
    } finally {
      setAiBusy(false)
      Taro.hideLoading()
    }
  }

  /**
   * ⭐ 思傅 2026-10-21：强度滑杆拖动 → 实时按新强度重算当前模式预览。
   * 节流 160ms（拖动中不逐帧重算，松手立即出最终图），复用 pickEnhanceModeLocal 的缓存。
   */
  const onPresetSliderChange = (val: number) => {
    setPresetSlider(val)
    if (activeMode === 'hd' || activeMode === 'original') return
    if (sliderTimerRef.current) clearTimeout(sliderTimerRef.current)
    sliderTimerRef.current = setTimeout(() => {
      // 重算时不复用「旧滑杆值」的缓存，也不受 modeThumbs 旧键影响（键已带 s）
      void pickEnhanceModeLocal(activePreset === 'enhance' && activeMode ? activeMode : activePreset, val)
    }, 160)
  }

  /**
   * 把指定「基础画面模式」应用到原图底稿，前端 Canvas 实时渲染并返回临时文件。
   * 不依赖后端，规避网络往返；像素操作（灰度/增亮/二值化/锐化）在客户端完成，点击即显。
   */
  const renderLocalPreset = async (baseSrc: string, preset: string, sliderVal: number): Promise<string> => {
    const node = await waitCanvasNode()
    if (!node) throw new Error('画布未就绪，请稍后重试')
    const presetSrc = await toLocalIfRemote(baseSrc)
    const img = await loadImageOnCanvas(node, presetSrc)
    let w = img.width
    let h = img.height
    // 限幅到安全上限（预览无需原分辨率，小尺寸更快更即时；超分请走「高清扩展」）
    const fit = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h, 1))
    w = Math.max(1, Math.round(w * fit))
    h = Math.max(1, Math.round(h * fit))
    setCanvasCss({ w, h })
    await waitCanvasCss(w, h)
    node.width = w
    node.height = h
    const ctx = node.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    applyPresetPixels(imageData.data, imageData.data.length / 4, w, h, preset, enhanceStrength, sliderVal)
    ctx.putImageData(imageData, 0, 0)
    await waitCanvasCss(w, h)
    return new Promise<string>((resolve, reject) => {
      Taro.canvasToTempFilePath({
        canvas: node,
        x: 0, y: 0, width: w, height: h,
        destWidth: w, destHeight: h,
        fileType: 'jpg', quality: 0.95,
        success: (res: any) => resolve(res.tempFilePath),
        fail: (err: any) => reject(err),
      } as any)
    })
  }

  /** 切换「矩形裁剪 / 四角拉框」两种模式（互斥）。 */
  const toggleCornerMode = () => {
    if (aiBusy || busy) return
    const next: CornerMode = cornerMode === 'quad' ? 'rect' : 'quad'
    setCornerMode(next)
    setFraming(true)
    if (next === 'quad') setQuad(DEFAULT_QUAD)
    else setCrop(DEFAULT_CROP)
    Taro.showToast({
      title: next === 'quad'
        ? '拖动四个圆点框住试卷四角，拉完点「确认四角」'
        : '已切回矩形裁剪',
      icon: 'none',
      duration: 2500,
    })
  }

  /**
   * 四角模式下的「确认四角」：把手拉的四角（归一化，相对原图）直接提交「自动调正」，
   * 后端按四角做透视压平（100% 保真，不重画）。
   * ★ 此前 quad 模式拉完四角没有任何确认入口（用户不知道下一步做什么）——
   *   现在把「确定裁剪」按钮在四角模式下替换为「确认四角」，交互闭环。
   */
  const confirmQuad = () => {
    if (aiBusy || busy) return
    void handleAi('auto', '自动调正', { manual_corners: quad })
  }

  // 智能高清处理：按当前选中的模式分支调用后端。
  // closePanel=true（默认）：处理完关闭面板（用于「确定」直接应用）。
  // closePanel=false：处理完保留面板（用于点开即出默认预览 / 切换模式实时预览）。
  const runEnhance = (closePanel = true) => {
    if (closePanel) setSrPanelOpen(false)
    if (activeMode === 'hd') {
      // 高清扩展：走超分倍率（x2/x3/x4）+ 推理模式（后端）。
      // ⚠️ multi_modes 必须缺省/false：true 会让服务端返回五模式「预览」
      //   （内部固定 scale=1），真正的超分永远不跑——思傅 2026-10-19 实测
      //   「高清扩展不可用」的根因之一（另一根因是服务端对 bw 强制 scale=1）。
      // enhance_preset 带上当前选中的基础模式：高清扩展 = 该模式的放大版；
      //   选中「原图」则不传，由服务端按单色源自动判定（黑白件→bw，否则→enhance）。
      const hdPreset = (['enhance', 'bw', 'brighten', 'gray'] as const).includes(activePreset as any)
        ? (activePreset as 'enhance' | 'bw' | 'brighten' | 'gray')
        : undefined
      void handleAi('enhance', '智能高清', {
        sr_scale: srScale,
        sr_mode: srMode,
        enhance_preset: hdPreset,
        enhance_strength: enhanceStrength,
      })
    } else {
      // 基础画面模式已改为前端本地实时处理（见 pickEnhanceModeLocal），
      // 此处仅作兜底：若尚未生成预览则补一次本地渲染（正常不应走到）。
      void pickEnhanceModeLocal(activeMode)
    }
  }

  // 面板「取消」：回退主图到打开面板时的底稿（enhanceBase），再关闭。
  // （此前取消只关面板、不回图——用户看到的是最后一个预览效果，"取消"名不副实。）
  const cancelEnhancePanel = () => {
    if (busy || aiBusy) return
    if (enhanceBase) setCurrentSrc(enhanceBase)
    setSrPanelOpen(false)
  }

  // 面板「确定」：确认当前选中模式。
  //  - 基础模式：主预览已实时落到所选模式（前端本地处理），直接确认即可；
  //  - 高清扩展：以所选 x2/x3/x4 运行超分并应用（后端）。
  const onConfirmEnhance = () => {
    if (activeMode === 'hd') {
      void runEnhance(true)
      return
    }
    // 基础画面模式：主图已是本地处理结果，直接确认。
    setSrPanelOpen(false)
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
          onClick={() => {
            // ⭐ 思傅 2026-10-21：手机屏小、看不清处理细节 → 点图片全屏放大查看，
            // 原生预览自带双指缩放/拖动，方便看黑白/灰度/去手写等细节。
            // 裁剪改由底部「裁剪」按钮进入（enterFraming），不再由点图触发；
            // 裁剪模式下点图不放大（避免与裁剪框拖拽手势冲突）。
            if (!framing && !previewError && currentSrc) {
              Taro.previewImage({ urls: [currentSrc], current: currentSrc, showmenu: true } as any)
            }
          }}
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

          {/* ── 去手写对比：左侧露出「擦除前」，右侧为「擦除后」（P3 对标夸克）──
              ⚠️ 内层图片必须保持**完整尺寸**(imgW×imgH)再由外层按百分比裁剪，
                 否则 aspectFit 会按裁剪后的容器重新缩放 → 左右两侧比例对不上。 */}
          {compareMode && beforeSrc && !previewError && (
            <>
              <View
                className="absolute pointer-events-none"
                style={{ left: 0, top: 0, width: `${compareRatio * 100}%`, height: '100%', overflow: 'hidden' }}
              >
                <TaroImage src={beforeSrc} mode="aspectFit" style={{ width: imgW, height: imgH }} />
              </View>
              <View
                className="absolute pointer-events-none"
                style={{ left: compareRatio * imgW - 1, top: 0, width: 2, height: '100%', backgroundColor: '#ffffff' }}
              />
            </>
          )}

          {/* ── 去手写框选补擦层：触摸层 + 已圈区域 + 跟随手指的虚框 ── */}
          {eraseMode && (
            <>
              <View
                id="eraseTouchLayer"
                className="absolute"
                style={{ left: 0, top: 0, right: 0, bottom: 0 }}
                onClick={(e: any) => e?.stopPropagation?.()}
                onTouchStart={onEraseTouchStart}
                onTouchMove={onEraseTouchMove}
                onTouchEnd={onEraseTouchEnd}
              />
              {eraseRects.map((r, i) => (
                <View
                  key={`erase-region-${i}`}
                  className="absolute pointer-events-none"
                  style={{
                    left: r.x * imgW,
                    top: r.y * imgH,
                    width: r.w * imgW,
                    height: r.h * imgH,
                    borderWidth: 2,
                    borderStyle: 'solid',
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.18)',
                    borderRadius: 4,
                  }}
                />
              ))}
              {eraseDrag && (() => {
                const dx0 = Math.min(eraseDrag.x0, eraseDrag.x1)
                const dy0 = Math.min(eraseDrag.y0, eraseDrag.y1)
                const dw = Math.abs(eraseDrag.x1 - eraseDrag.x0)
                const dh = Math.abs(eraseDrag.y1 - eraseDrag.y0)
                return (
                  <View
                    className="absolute pointer-events-none"
                    style={{
                      left: dx0, top: dy0, width: dw, height: dh,
                      borderWidth: 2, borderStyle: 'dashed', borderColor: '#fbbf24',
                      backgroundColor: 'rgba(251,191,36,0.15)', borderRadius: 4,
                    }}
                  />
                )
              })()}
            </>
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
              ★ CSS 尺寸 = 本次导出缓冲尺寸（canvasCss state，drawAndExport 每次同步+轮询确认）。
                CSS 与缓冲 1:1 → canvasToTempFilePath 的「CSS 口径」坐标无歧义；
                配合「选区直接画满缓冲 + 全区域导出」，裁剪/旋转输出数学上零偏移。
                （旧方案 CSS 固定方框与动态缓冲失配 → 裁剪跑飞、旋转逐次放大，勿回退。） */}
          <Canvas
            type="2d"
            id={CANVAS_ID}
            style={{
              position: 'absolute',
              left: '-9999px',
              top: 0,
              width: canvasCss.w,
              height: canvasCss.h,
            }}
          />
        </View>
      </View>

      {/* 对比滑杆：拖动即可在「擦除前 / 擦除后」之间扫（P3 对标夸克） */}
      {compareMode && beforeSrc && (
        <View className="px-6 pb-1 flex flex-row items-center gap-3">
          <Text className="block text-white text-opacity-70 text-[11px]">前</Text>
          <Slider
            className="flex-1"
            min={0}
            max={100}
            value={Math.round(compareRatio * 100)}
            activeColor="#3b82f6"
            backgroundColor="rgba(255,255,255,0.25)"
            blockColor="#ffffff"
            blockSize={18}
            onChange={(e: any) => setCompareRatio(clamp((e?.detail?.value ?? 50) / 100, 0, 1))}
          />
          <Text className="block text-white text-opacity-70 text-[11px]">后</Text>
        </View>
      )}

      {/* 底部操作 ⭐ 思傅 2026-10-21 修：智能高清「确定」后 modeThumbs「选择效果」栏出现，
          底部操作块内容变高，在 fixed inset-0 不滚动的 flex 布局里把主按钮挤出视口、不可点。
          现改为：操作区可滚动（内容多时不挤压），主按钮独立钉在最底部始终可见可点。 */}
      <ScrollView scrollY className="px-4 pt-3" style={{ maxHeight: '42vh', paddingBottom: 88 }}>
        {/* AI 处理行（cropOnly 模式隐藏：只做裁剪） */}
        {!cropOnly && (
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
        )}

        <View className="flex flex-row items-center justify-center gap-8 mb-5">
          <View className="flex flex-col items-center" onClick={handleRotate}>
            <RotateCw size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">旋转90°</Text>
          </View>
          {/* 矩形裁剪：仅矩形模式出现（四角模式专做透视压平，隐藏矩形裁剪）。
              未启用时显示「裁剪」（点击进入裁剪框），启用后变为「确定裁剪」（点击应用）。 */}
          {cornerMode !== 'quad' && (
            <View className="flex flex-col items-center" onClick={framing ? handleConfirmCrop : enterFraming}>
              <View
                className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                  framing ? 'bg-primary' : 'bg-white bg-opacity-15'
                }`}
              >
                <Crop size={20} color="#ffffff" />
              </View>
              <Text className="block text-white text-opacity-80 text-xs">{framing ? '确定裁剪' : '裁剪'}</Text>
            </View>
          )}
          {/* 合并键：同一按键的两种状态——
              矩形模式=「四角拉框」(点击进入四角透视，可拉试卷四角)；
              四角模式=「确认四角」(拉完四角后提交透视压平，确认后自动回到矩形态)。 */}
          <View
            className="flex flex-col items-center"
            onClick={cornerMode === 'quad' ? confirmQuad : toggleCornerMode}
          >
            <View
              className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                cornerMode === 'quad' ? 'bg-primary' : 'bg-white bg-opacity-15'
              }`}
            >
              <Maximize2 size={20} color="#ffffff" />
            </View>
            <Text className="block text-white text-opacity-80 text-xs">
              {cornerMode === 'quad' ? '确认四角' : '四角拉框'}
            </Text>
          </View>
          {enableSaveToInbox && (
            <View className="flex flex-col items-center" onClick={handleSave}>
              <Database size={24} color="#ffffff" />
              <Text className="block text-white text-opacity-80 text-xs mt-1">保存图片</Text>
            </View>
          )}
        </View>

        {/* 去手写模式开关：红/蓝笔批改卷开启「仅彩笔+保印刷」（v18.2 实测误删降 52%~99%）；cropOnly 模式隐藏 */}
        {!cropOnly && (
          <View className="flex flex-row items-center justify-center mb-4" onClick={() => setColorPenMode((v) => !v)}>
            <View
              className={`w-10 h-5 rounded-full mr-2 relative ${colorPenMode ? 'bg-primary' : 'bg-white bg-opacity-15'}`}
            >
              <View
                className={`w-4 h-4 rounded-full bg-white absolute top-0 ${colorPenMode ? 'right-0' : 'left-0'}`}
              />
            </View>
            <Text className="block text-white text-opacity-80 text-xs">
              {colorPenMode ? '红/蓝笔卷模式（保印刷）已开' : '红/蓝笔卷模式（保印刷）'}
            </Text>
          </View>
        )}

        {/* 基础画面模式实时预览：缩略图来自前端本地渲染缓存（点击即出主图），高亮当前选中模式 */}
        {Object.keys(modeThumbs).length > 0 && (
          <View className="mb-4">
            <Text className="block text-white text-opacity-70 text-xs mb-2">
              选择效果（点击切换{activePreset ? ` · 当前：${ENHANCE_PRESETS.find((p) => p.value === activePreset)?.label ?? activePreset}` : ''}）
            </Text>
            <View className="flex flex-row justify-between">
              {ENHANCE_PRESETS.map((p) => {
                const active = activePreset === p.value
                // 缓存键带滑杆值（preset@0.50），取当前滑杆档下的图；没有就用该模式任意一张缩略
                const thumb = modeThumbs[`${p.value}@${presetSlider.toFixed(2)}`]
                  || Object.entries(modeThumbs).find(([k]) => k.startsWith(`${p.value}@`))?.[1]
                if (!thumb?.url) return null
                return (
                  <View key={p.value} className="flex flex-col items-center" onClick={() => pickEnhanceModeLocal(p.value)}>
                    <View
                      className="w-14 h-16 rounded-lg overflow-hidden items-center justify-center"
                      style={{
                        borderWidth: active ? 2 : 1,
                        borderStyle: 'solid',
                        borderColor: active ? '#3b82f6' : 'rgba(255,255,255,0.25)',
                        backgroundColor: '#000',
                      }}
                    >
                      <TaroImage src={thumb.url} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                    </View>
                    <Text
                      className="block text-[10px] mt-1"
                      style={{ color: active ? '#3b82f6' : 'rgba(255,255,255,0.6)' }}
                    >
                      {p.label}
                    </Text>
                  </View>
                )
              })}
            </View>
            {/* ⭐ 思傅 2026-10-21：强度滑杆也在「选择效果」栏露出（与智能高清抽屉同一状态），
                用户不进抽屉也能调黑白/灰度/增亮/增强的强度 */}
            {activePreset && activePreset !== 'original' && activePreset !== 'hd' ? (
              <View className="mt-3">
                <View className="flex flex-row items-center justify-between mb-1">
                  <Text className="block text-white text-opacity-70 text-xs">
                    {(SLIDER_HINT[activePreset] || SLIDER_HINT.enhance).title}
                  </Text>
                  <Text className="block text-white text-xs">{Math.round(presetSlider * 100)}</Text>
                </View>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(presetSlider * 100)}
                  activeColor="#3b82f6"
                  backgroundColor="rgba(255,255,255,0.18)"
                  block-size={18}
                  block-color="#3b82f6"
                  style={{ margin: 0 }}
                  onChanging={(e: any) => onPresetSliderChange(Number(e.detail.value) / 100)}
                  onChange={(e: any) => onPresetSliderChange(Number(e.detail.value) / 100)}
                />
                <View className="flex flex-row items-center justify-between mt-1">
                  <Text className="block text-white text-opacity-50 text-[10px]">
                    {(SLIDER_HINT[activePreset] || SLIDER_HINT.enhance).left}
                  </Text>
                  <Text
                    className="block text-white text-opacity-70 text-[10px]"
                    onClick={() => onPresetSliderChange(PRESET_SLIDER_DEFAULT)}
                  >
                    恢复默认
                  </Text>
                  <Text className="block text-white text-opacity-50 text-[10px]">
                    {(SLIDER_HINT[activePreset] || SLIDER_HINT.enhance).right}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        )}

        {/* 去手写补正行：做过至少一次去手写后出现（§5.10 R1 框选补擦 / R2 撤销·对比） */}
        {(eraseMode || eraseStack.length > 0) && (
          <View className="flex flex-row items-center justify-center gap-6 mb-5">
            <View className="flex flex-col items-center" onClick={toggleEraseMode}>
              <View
                className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                  eraseMode ? 'bg-primary' : 'bg-white bg-opacity-15'
                }`}
              >
                <Crop size={20} color="#ffffff" />
              </View>
              <Text className="block text-white text-opacity-80 text-xs">框选补擦</Text>
            </View>
            <View className="flex flex-col items-center" onClick={undoErase}>
              <Undo2 size={24} color="#ffffff" />
              <Text className="block text-white text-opacity-80 text-xs mt-1">撤销</Text>
            </View>
            <View className="flex flex-col items-center" onClick={toggleCompare}>
              <View
                className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${
                  compareMode ? 'bg-primary' : 'bg-white bg-opacity-15'
                }`}
              >
                <Wand size={20} color="#ffffff" />
              </View>
              <Text className="block text-white text-opacity-80 text-xs">对比</Text>
            </View>
          </View>
        )}

        {/* 框选补擦模式下的操作条 */}
        {eraseMode && (
          <View className="flex flex-row gap-3 mb-3">
            <Button
              className="flex-1 h-10 rounded-xl"
              style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
              disabled={busy || aiBusy}
              onClick={clearEraseRects}
            >
              <Text className="block text-sm text-white">清空重选</Text>
            </Button>
            <Button
              className="flex-1 h-10 rounded-xl"
              style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
              disabled={busy || aiBusy}
              onClick={toggleEraseMode}
            >
              <Text className="block text-sm text-white">取消</Text>
            </Button>
            <Button
              className="flex-1 h-10 rounded-xl"
              style={{ backgroundColor: '#ef4444' }}
              disabled={busy || aiBusy}
              onClick={applyEraseRegions}
            >
              <Text className="block text-sm text-white">
                {aiBusy ? '处理中…' : `应用去手写${eraseRects.length ? `(${eraseRects.length})` : ''}`}
              </Text>
            </Button>
          </View>
        )}

        {cropTargetLabel ? (
          <View
            className="flex flex-row items-center justify-center mb-2"
            style={{
              backgroundColor: 'rgba(190,62,45,0.18)',
              borderRadius: 999,
              paddingTop: 6,
              paddingBottom: 6,
              borderWidth: 1,
              borderColor: 'rgba(190,62,45,0.45)',
            }}
          >
            <Text className="block text-xs" style={{ color: '#FFD9CF' }}>
              🎯 {cropTargetLabel}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* ⭐ 主按钮独立钉在最底部（始终可见可点，不受上面操作区内容高度影响） */}
      <View
        className="absolute left-0 right-0 z-[205] px-4 pt-2"
        style={{ bottom: 0, backgroundColor: '#000', paddingBottom: 12 }}
      >
        <Button className="w-full h-11 rounded-xl bg-primary" disabled={busy || aiBusy} onClick={handleConfirm}>
          <Text className="block text-sm text-white">{busy ? '处理中…' : (confirmText || '保存并替换原图')}</Text>
        </Button>
      </View>

      {/* 智能高清选择面板：底部抽屉（不遮挡图片、无蒙板）——基础画面模式（直接点选） + 高清扩展（x2/x3/x4 超分）
          ⭐ 思傅 2026-10-19 反馈修复：此前是「全屏半透明蒙板 + 底部弹窗」结构——
             ① 蒙板 rgba(0,0,0,0.55) 盖住图片，模式预览效果看不清；
             ② 点图片区域会点到蒙板上的 onClick → 直接关闭面板，模式选择被误退出。
          现改为纯底部抽屉：图片全程完整可见（点模式即换预览），
          退出只认「取消 / 确定」两个按钮，点图片不再有任何副作用。 */}
      {srPanelOpen && (
        <View className="absolute left-0 right-0 z-[210]" style={{ bottom: 0 }}>
          <View
            className="rounded-t-2xl p-4"
            style={{ backgroundColor: '#1c1c1e', boxShadow: '0 -4px 24px rgba(0,0,0,0.5)' }}
          >
            <Text className="block text-white text-base font-medium mb-3">智能高清</Text>

            {/* 画面模式 / 高清扩展：用户直接点选 */}
            <Text className="block text-white text-opacity-70 text-xs mb-2">画面模式（点击选择）</Text>
            <View className="flex flex-row flex-wrap gap-2 mb-1">
              {[...ENHANCE_PRESETS, HD_EXTENSION].map((m) => {
                const active = activeMode === m.value
                return (
                  <View
                    key={m.value}
                    className="flex-1 min-w-[30%] rounded-xl py-2 items-center"
                    style={{
                      backgroundColor: active ? '#3b82f6' : 'rgba(255,255,255,0.08)',
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: active ? '#3b82f6' : 'rgba(255,255,255,0.15)',
                    }}
                    onClick={() => {
                      setActiveMode(m.value as 'original' | 'enhance' | 'brighten' | 'gray' | 'bw' | 'hd')
                      // 高清扩展：仅展开 x2/x3/x4 子选项，不触发预览
                      if (m.value === 'hd') return
                      // 基础模式：前端本地即时预览（秒切主图），不走后端
                      void pickEnhanceModeLocal(m.value)
                    }}
                  >
                    <Text className="block text-white text-sm font-medium">{m.label}</Text>
                    <Text className="block text-white text-opacity-60 text-[10px] mt-1">{m.hint}</Text>
                  </View>
                )
              })}
            </View>

            {/* 高清扩展专属：放大倍率 + 处理模式（仅选中「高清扩展」时出现） */}
            {activeMode === 'hd' && (
              <View className="mb-1">
                <Text className="block text-white text-opacity-70 text-xs mb-2 mt-3">放大倍率</Text>
                <View className="flex flex-row gap-2 mb-3">
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

                <Text className="block text-white text-opacity-70 text-xs mb-2">处理模式</Text>
                <View className="flex flex-row gap-2 mb-1">
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
              </View>
            )}

            {/* ⭐ 思傅 2026-10-21：强度滑杆（默认 0.5），拖动实时重算当前模式预览——
                不同来源图片明暗/清晰度不同，三档不够用，交给用户自己调到满意 */}
            {activeMode !== 'hd' && activeMode !== 'original' ? (
              <View className="mb-4 mt-3">
                <View className="flex flex-row items-center justify-between mb-2">
                  <Text className="block text-white text-opacity-70 text-xs">
                    效果强度（{activeMode === 'bw' ? '黑白' : activeMode === 'gray' ? '灰度' : activeMode === 'brighten' ? '增亮' : '增强并锐化'}）
                  </Text>
                  <Text className="block text-white text-xs">{Math.round(presetSlider * 100)}</Text>
                </View>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(presetSlider * 100)}
                  activeColor="#3b82f6"
                  backgroundColor="rgba(255,255,255,0.18)"
                  block-size={18}
                  block-color="#3b82f6"
                  style={{ margin: 0 }}
                  onChanging={(e: any) => onPresetSliderChange(Number(e.detail.value) / 100)}
                  onChange={(e: any) => onPresetSliderChange(Number(e.detail.value) / 100)}
                />
                <View className="flex flex-row items-center justify-between mt-1">
                  <Text className="block text-white text-opacity-50 text-[10px]">
                    {(SLIDER_HINT[activeMode] || SLIDER_HINT.enhance).left}
                  </Text>
                  <Text
                    className="block text-white text-opacity-70 text-[10px]"
                    onClick={() => onPresetSliderChange(PRESET_SLIDER_DEFAULT)}
                  >
                    恢复默认
                  </Text>
                  <Text className="block text-white text-opacity-50 text-[10px]">
                    {(SLIDER_HINT[activeMode] || SLIDER_HINT.enhance).right}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* 增强强度（P1）：把"是否过头"的把控权交给用户 */}
            {activeMode === 'hd' && (
              <>
            <Text className="block text-white text-opacity-70 text-xs mb-2 mt-3">增强强度</Text>
            <View className="flex flex-row gap-2 mb-4">
              {ENHANCE_STRENGTHS.map((s) => {
                const active = enhanceStrength === s.value
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
                    onClick={() => setEnhanceStrength(s.value)}
                  >
                    <Text className="block text-white text-sm font-medium">{s.label}</Text>
                  </View>
                )
              })}
            </View>
              </>
            )}

            <View className="flex flex-row gap-3">
              <Button
                className="flex-1 h-10 rounded-xl"
                style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
                onClick={cancelEnhancePanel}
              >
                <Text className="block text-sm text-white">取消</Text>
              </Button>
              <Button className="flex-1 h-10 rounded-xl bg-primary" disabled={busy || aiBusy} onClick={onConfirmEnhance}>
                <Text className="block text-sm text-white">确定</Text>
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
 * 【已废弃 cropToBufferRect】旧方案把归一化裁剪框映射到缓冲像素再让 canvasToTempFilePath
 * 按区域截取 —— 该 API 的 x/y/width/height 实为「CSS 显示尺寸」口径，CSS 与缓冲一旦失配
 * 就会整体错位（裁剪跑飞/旋转累积放大）。新方案改为：九参 drawImage 把选区直接画满缓冲
 * （Canvas 规范保证的精确映射）+ CSS 同步为缓冲 + 全区域导出，对口径完全免疫。
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// 智能高清·基础画面模式：前端像素级滤镜（对标扫描王/夸克的即时预览）
// 这些运算在客户端 Canvas 完成，点击即出预览，不依赖后端推理与网络往返。
// 仅「高清扩展」(x2/x3/x4 超分) 才走后端模型。
// ─────────────────────────────────────────────────────────────────────────────

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

// ─────────────────────────────────────────────────────────────────────────────
// 光照归一化（思傅 2026-10-22 引入，对标主流扫描App的「Magic Color」管线）
//
// 主流应用（扫描全能王 Magic Color / Adobe Scan 增强 / Microsoft Lens）与本地实现
// 的最大差距**不在二值化算法本身**，而在前置的光照归一化：
//
//   手机照片 I(x,y) = 纸面反射率 R(x,y) × 空间非均匀光照 L(x,y)（手影/灯影/渐变）
//   直接对 I 做阈值或对比处理，阴影区背景被一起压暗 ⇒ 文字与背景同时变灰
//   ⇒ 花斑、黑团、淡字丢失（此前 Sauvola 只能部分补救）。
//
// 业界标准做法（Retinex 分解）：
//   ① 估计背景面 I_bg：灰度**形态学膨胀**（核 > 笔画宽，把深色笔画「填掉」，只留纸面）
//      + **大半径平滑**（去掉残留笔画边缘与纸纹）⇒「如果没有墨迹，纸在这里该有多亮」
//   ② 归一化 I_norm = I × 255 / max(I_bg, ε)
//      阴影是**乘性**衰减（L_shadow = 0.25·L_ambient），该标量在分子分母中完全抵消
//      ⇒ 阴影区被拉回与亮区一致；三通道共用同一标量 ⇒ 彩色不偏色（色度不变性）
//   ③ 之后再做对比拉伸 / 自适应二值化，输入已是一片「光照均匀的白纸」。
//
// 实测参考参数（10万+文档图像口径）：膨胀核 11×11（7–21，必须 > 笔画宽）；
// 平滑核 31×31（21–51，取膨胀核 3~5 倍）。
//
// 性能：背景面是低频场，在 1/4 降采样网格上算再双线性插回，内存与耗时降 ~16×。
// ─────────────────────────────────────────────────────────────────────────────

/** 可分离最大值滤波（灰度膨胀）：行→列两遍，O(n)。src/tmp/out 互不重叠 */
function maxFilter(src: Float32Array, w: number, h: number, k: number, tmp: Float32Array, out: Float32Array) {
  const r = (k - 1) >> 1
  const dq = new Int32Array(Math.max(w, h))
  for (let y = 0; y < h; y++) {
    const row = y * w
    let head = 0, tail = 0, next = 0
    for (let x = 0; x < w; x++) {
      const hi = x + r < w ? x + r : w - 1
      while (next <= hi) {
        const v = src[row + next]
        while (tail > head && src[row + dq[tail - 1]] <= v) tail--
        dq[tail++] = next++
      }
      const lo = x - r
      while (head < tail && dq[head] < lo) head++
      tmp[row + x] = src[row + dq[head]]
    }
  }
  for (let x = 0; x < w; x++) {
    let head = 0, tail = 0, next = 0
    for (let y = 0; y < h; y++) {
      const hi = y + r < h ? y + r : h - 1
      while (next <= hi) {
        const v = tmp[next * w + x]
        while (tail > head && tmp[dq[tail - 1] * w + x] <= v) tail--
        dq[tail++] = next++
      }
      const lo = y - r
      while (head < tail && dq[head] < lo) head++
      out[y * w + x] = tmp[dq[head] * w + x]
    }
  }
}

/** 可分离盒式模糊（滑动求和），O(n)。用大盒式近似中值——背景面本就该平滑 */
function boxBlur(src: Float32Array, w: number, h: number, k: number, tmp: Float32Array, out: Float32Array) {
  const r = (k - 1) >> 1
  const inv = 1 / k
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let i = -r; i <= r; i++) { const xi = i < 0 ? 0 : i >= w ? w - 1 : i; sum += src[row + xi] }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv
      const ai = x + r + 1
      sum += src[row + (ai >= w ? w - 1 : ai)] - src[row + (x - r < 0 ? 0 : x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let i = -r; i <= r; i++) { const yi = i < 0 ? 0 : i >= h ? h - 1 : i; sum += tmp[yi * w + x] }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv
      const ai = y + r + 1
      sum += tmp[(ai >= h ? h - 1 : ai) * w + x] - tmp[(y - r < 0 ? 0 : y - r) * w + x]
    }
  }
}

/**
 * 光照归一化主入口：估计纸面背景并按除法拉平光照（去阴影 / 光照不均）。
 * @param strength 0=不处理，1=完全归一化；中间值按比例混合，避免过度抹掉纸纹与淡印
 */
function normalizeIllumination(d: Uint8ClampedArray, w: number, h: number, strength = 1) {
  if (strength <= 0 || w < 32 || h < 32) return
  const DS = 4
  const gw = Math.max(6, Math.ceil(w / DS))
  const gh = Math.max(6, Math.ceil(h / DS))
  const odd = (v: number) => (v % 2 === 0 ? v + 1 : v)
  // 核随降采样后的短边自适应：膨胀核必须 > 笔画宽（1/4 尺度上笔画约 1~2px）
  const shortS = Math.min(gw, gh)
  const kDil = odd(Math.max(5, Math.min(15, Math.round(shortS / 30))))
  const kBlur = odd(Math.max(15, Math.min(41, Math.round(shortS / 8))))

  // ① 降采样灰度（盒式平均，天然抗噪）
  const small = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    const y0 = y * DS
    const y1 = Math.min(h, y0 + DS)
    for (let x = 0; x < gw; x++) {
      const x0 = x * DS
      const x1 = Math.min(w, x0 + DS)
      let s = 0, c = 0
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx
          s += 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
          c++
        }
      }
      small[y * gw + x] = c ? s / c : 0
    }
  }
  // ② 背景面：膨胀抹笔画 → 大半径平滑
  const t1 = new Float32Array(gw * gh)
  const dil = new Float32Array(gw * gh)
  const bg = new Float32Array(gw * gh)
  maxFilter(small, gw, gh, kDil, t1, dil)
  boxBlur(dil, gw, gh, kBlur, t1, bg)

  // ③ 双线性插回全图，逐像素乘增益（三通道同一标量 ⇒ 不偏色）
  const GAIN_MAX = 3.5
  const GAIN_MIN = 0.5
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / DS - 0.5
    let y0 = Math.floor(sy)
    let ty = sy - y0
    if (y0 < 0) { y0 = 0; ty = 0 }
    if (y0 > gh - 2) { y0 = gh - 2; ty = 1 }
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / DS - 0.5
      let x0 = Math.floor(sx)
      let tx = sx - x0
      if (x0 < 0) { x0 = 0; tx = 0 }
      if (x0 > gw - 2) { x0 = gw - 2; tx = 1 }
      const b00 = bg[y0 * gw + x0]
      const b01 = bg[y0 * gw + x0 + 1]
      const b10 = bg[(y0 + 1) * gw + x0]
      const b11 = bg[(y0 + 1) * gw + x0 + 1]
      const bgv = b00 * (1 - tx) * (1 - ty) + b01 * tx * (1 - ty) + b10 * (1 - tx) * ty + b11 * tx * ty
      let a = 255 / (bgv > 1 ? bgv : 1)
      if (a > GAIN_MAX) a = GAIN_MAX
      else if (a < GAIN_MIN) a = GAIN_MIN
      const gain = 1 + (a - 1) * strength
      const i = y * w + x
      d[4 * i] = clamp255(d[4 * i] * gain)
      d[4 * i + 1] = clamp255(d[4 * i + 1] * gain)
      d[4 * i + 2] = clamp255(d[4 * i + 2] * gain)
      d[4 * i + 3] = 255
    }
  }
}

/**
 * 百分位对比拉伸：用 low%~high% 分位（而非 min/max，抗极值）把有效灰度区间拉到 0..255。
 * 动态范围本来就不宽（hi-lo<16）时不动，避免放大噪点。
 */
function stretchPercentileGray(gray: Float32Array | Float64Array, n: number, lowPct = 0.02, highPct = 0.98) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const v = gray[i] | 0
    hist[v < 0 ? 0 : v > 255 ? 255 : v]++
  }
  let lo = 0, hi = 255, acc = 0
  const loTarget = n * lowPct
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loTarget) { lo = v; break } }
  acc = 0
  const hiTarget = n * (1 - highPct)
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= hiTarget) { hi = v; break } }
  if (hi - lo < 16) return
  const scale = 255 / (hi - lo)
  for (let i = 0; i < n; i++) gray[i] = (gray[i] - lo) * scale
}

/**
 * 文档曲线（对标保色分段 S 曲线）：
 *   v ≥ thetaHigh → 255（背景白化：纸纹 / 背面透印字压白）
 *   v <  thetaLow  → v·gammaDark（墨迹加深，压暗铅笔/圆珠笔）
 *   中间调线性拉伸到 [betaFloor, 255]，斜率 >1 扩展对比
 */
function applyDocumentCurve(gray: Float32Array, n: number, thetaHigh = 214, thetaLow = 40, gammaDark = 0.78, betaFloor = 30) {
  const slope = (255 - betaFloor) / (thetaHigh - thetaLow)
  for (let i = 0; i < n; i++) {
    const v = gray[i]
    gray[i] = v >= thetaHigh ? 255 : v < thetaLow ? v * gammaDark : betaFloor + (v - thetaLow) * slope
  }
}

/** 把灰度数组写回 RGBA（三通道同值） */
function writeGrayToRgba(d: Uint8ClampedArray, gray: Float32Array, n: number) {
  for (let i = 0; i < n; i++) {
    const v = clamp255(gray[i])
    d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v
    d[4 * i + 3] = 255
  }
}

/** 从 RGBA 取灰度 */
function readGray(d: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n)
  for (let i = 0; i < n; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
  return g
}

/**
 * 基础模式像素处理：
 *  - original：原样直出
 *  - gray：灰度（保留层次）
 *  - brighten：增亮 + 轻度提对比（偏暗/阴影图）
 *  - enhance：增强并锐化（提对比 + 3x3 非锐化，让印刷体更清晰）
 *  - bw：白底黑字二值化（Sauvola 局部自适应阈值 + 中值去斑 + 自动反相纠正，
 *    确保背景白、文字黑、干净清晰；对阴影/噪点照片鲁棒，实测见 binarizeWhiteBgBlackInk 注释）
 *
 * ⚠️ 所有模式共用前置 `normalizeIllumination`（去阴影/光照不均）——
 *    2026-10-22 对标主流扫描App补上的关键一环。此前各模式直接吃原始照片，
 *    一遇手影/灯影就被带崩；现在输入已是一片「光照均匀的白纸」。
 */
function applyPresetPixels(
  d: Uint8ClampedArray,
  n: number,
  w: number,
  h: number,
  preset: string,
  strength: 'weak' | 'medium' | 'strong',
  slider: number = PRESET_SLIDER_DEFAULT,
) {
  if (preset === 'original') return

  // ── 共用前置：光照归一化（去阴影/光照不均）──────────────────────────────
  // 固定较强力度 0.9：Retinex 分解的纯增益步，不做反而把手影留给后续处理。
  normalizeIllumination(d, w, h, 0.9)

  if (preset === 'gray') {
    // 灰度 + 文档曲线（背景白化 + 中间调对比扩展），滑杆再叠一层用户对比
    const g = readGray(d, n)
    stretchPercentileGray(g, n)
    applyDocumentCurve(g, n)
    const contrast = 1.0 + slider * 0.55
    for (let i = 0; i < n; i++) g[i] = (g[i] - 128) * contrast + 128
    writeGrayToRgba(d, g, n)
    return
  }

  if (preset === 'brighten') {
    // 思傅 2026-10-22 反馈「增亮把文字处理得比较淡、看不清」。
    //
    // 根因：Gamma 提亮是**全画面**抬升，文字（暗）也被一起抬亮（实测 40 → 61）；
    // 而旧文档曲线 thetaLow=46 又把 61 判进「中间调」继续抬到 66
    // ⇒ 文字比原图还淡（背景 240→255，对比反而从 200 掉到 188）。
    //
    // 修法：增亮只管**背景**，文字必须更深。
    //  ① 提亮幅度收敛（阴影已由前置光照归一化处理，不必再猛提）：gamma 1→0.70
    //  ② 文档曲线把「墨」的判定阈值抬到 90 并加强压暗（gammaDark 0.55）
    //     ⇒ 文字落在墨区被压暗（实测 40 → ~22），比原图更深更清晰；
    //        背景 ≥214 一律拉到纯白 255。
    // 净效果：画面更亮更干净，且文字对比从 200 提升到 ~233。
    const g = readGray(d, n)
    const gamma = 1 - slider * 0.30 // s=0 → 1（不动）；s=1 → 0.70（明显提亮）
    for (let i = 0; i < n; i++) g[i] = 255 * Math.pow(g[i] / 255, gamma)
    applyDocumentCurve(g, n, 214, 90, 0.55, 30)
    const contrast = 1.0 + slider * 0.15
    for (let i = 0; i < n; i++) g[i] = (g[i] - 128) * contrast + 128
    writeGrayToRgba(d, g, n)
    return
  }

  if (preset === 'enhance') {
    // 对比拉伸 + 非锐化；保色（不动色度），只拉亮度与边缘
    const g = readGray(d, n)
    stretchPercentileGray(g, n, 0.01, 0.995)
    const a = 1.0 + slider * 0.6 + (strength === 'strong' ? 0.2 : strength === 'weak' ? -0.15 : 0)
    const b = slider * 20
    for (let i = 0; i < n; i++) g[i] = (g[i] - 128) * a + 128 + b
    writeGrayToRgba(d, g, n)
    sharpen3x3(d, w, h, 0.15 + slider * 1.5)
    return
  }

  if (preset === 'bw') {
    // 思傅 2026-10-21：纯扫 Sauvola k 会让两端崩（s 小→字糊成黑团，s 大→全白）。
    // 改为「稳健基线 + 滑块控制墨迹粗细」，两端都保持可读。
    binarizeWhiteBgBlackInk(d, n, w, h, slider)
    return
  }
}

/**
 * 白底黑字二值化（Sauvola 局部自适应阈值 + 3x3 中值去斑 + 自动反相兜底）。
 *
 * ── 为什么必须用局部自适应（思傅 2026-10-19 实测换来的） ─────────────────
 * 旧实现是「3x3 模糊 + 全局 Otsu」：在**光照不均**（阴影渐变）或**高噪点**
 * （屏拍/翻拍/压缩 artifacts）照片上，全局阈值无法适应画面各区域亮度差异，
 * 整张图会变成花斑噪点——用户截图实证：数学试卷拍屏后点「黑白」直接成花屏。
 *
 * Sauvola 是文档二值化的业界标准：逐像素按「局部均值 μ 与局部标准差 σ」
 * 计算阈值 T = μ·(1 + k·(σ/R − 1))，阴影区/噪点区都能正确分离墨迹与背景。
 * 积分图（summed-area table）把窗口统计从 O(n·win²) 降到 O(n)，手机端可跑。
 * 参数经真实故障图 A/B 实测定型：k=0.2、窗口 = max(15, 短边/15) 取奇、
 * R=128、3x3 中值去孤立斑（保标点：中值阈 5/9 邻域）。
 */
/**
 * 白底黑字二值化（思傅 2026-10-21 重做：稳健基线 + 滑块微调墨迹粗细）。
 *
 * 完整管线（2026-10-22 对标主流扫描App补强）：
 *   ① 光照归一化（由调用方 applyPresetPixels 前置完成）——去手影/灯影/光照渐变
 *   ② 百分位对比拉伸——把淡印的低动态范围拉开，Sauvola 才判得出细笔画
 *   ③ Sauvola 局部自适应阈值（固定 k=0.2，窗口随短边自适应）
 *   ④ 3x3 中值去斑（孤立噪点抹掉，成片笔画保留，标点不误伤）
 *   ⑤ 滑块控制墨迹粗细（±2px 形态学）
 *   ⑥ 自动反相兜底（暗背景照片）
 *
 * ── 为什么不用「扫 Sauvola k」调滑块（2026-10-21 教训）────────────────
 * 旧实现滑块线性映射到 Sauvola 的 k（自适应程度）：s→0 时阈值抬高、判墨暴增，
 * 字糊成黑团；s→1 时阈值压低、判墨几乎为零，图近乎全白——两端都不可用。
 * k 是「局部自适应程度」，不是「黑白对比」，拿它当滑块等于把整图推向极端。
 *
 * 新做法：
 *  1. 先用**固定 k=0.2**（历史真实故障图 A/B 定型值）跑 Sauvola 局部自适应，
 *     得到一张稳健可读的基准二值图（背景白、文字黑）。
 *  2. 滑块 s∈[0,1] 只做**小幅墨迹粗细微调**（膨胀/侵蚀墨迹 + 阈值偏置）：
 *     s=0.5 恰好 = 基准原样；s<0.5 墨迹略收（字变细、防糊）；s>0.5 墨迹略放
 *     （字变粗、防断笔）。幅度克制（±），保证两端依旧可读、不会崩成黑团/全白。
 *  3. 3x3 中值去斑保标点；自动反相兜底（暗背景照片）。
 */
function binarizeWhiteBgBlackInk(d: Uint8ClampedArray, n: number, w: number, h: number, slider: number = PRESET_SLIDER_DEFAULT) {
  const gray = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
  }
  // ② 百分位对比拉伸：淡印/低动态范围原图先拉开，Sauvola 才判得出细笔画
  stretchPercentileGray(gray, n)
  // 窗口随图尺寸自适应（思傅 2026-10-22 调：旧公式 短边/15 对手机大图给出 80+，
  // 窗口过大 → 局部统计被大片背景主导 → 细笔画判不出 → **文字发糊**）。
  // 研究口径：300DPI 扫描 15~25；>31 会糊。这里 短边/45 并夹在 [15,31]，
  // 对 1600×1200 得 27（约 0.7 个汉字高，足够稳定又不糊），强制奇数。
  let win = Math.round(Math.min(w, h) / 45)
  if (win < 15) win = 15
  if (win > 31) win = 31
  if (win % 2 === 0) win += 1
  const r = (win - 1) / 2
  const area = win * win
  // 积分图（边缘复制 padding）
  const pw = w + 2 * r
  const ph = h + 2 * r
  const SW = pw + 1
  const intSum = new Float64Array(SW * (ph + 1))
  const intSq = new Float64Array(SW * (ph + 1))
  for (let i = 0; i < ph; i++) {
    const rowBase = (i + 1) * SW
    const prevBase = i * SW
    const gy = i < r ? 0 : i >= ph - r ? h - 1 : i - r
    for (let j = 0; j < pw; j++) {
      const gx = j < r ? 0 : j >= pw - r ? w - 1 : j - r
      const v = gray[gy * w + gx]
      const idx = rowBase + j + 1
      intSum[idx] = v + intSum[prevBase + j + 1] + intSum[rowBase + j] - intSum[prevBase + j]
      const v2 = v * v
      intSq[idx] = v2 + intSq[prevBase + j + 1] + intSq[rowBase + j] - intSq[prevBase + j]
    }
  }
  // ⭐ 固定稳健基线 k（不再随滑块扫），只做局部自适应。
  // 思傅 2026-10-22 调：0.2 → 0.30。Sauvola T = μ(1 + k(σ/R − 1))，σ/R−1 为负，
  // k 越大阈值越低 ⇒ 判墨越少 ⇒ 笔画更细更利落。研究口径：0.2=干净现代文档（保守）、
  // 0.3=典型文档、0.32 为文档扫描实测最优。已做光照归一化 + 保细线去斑，可放心用 0.30。
  const K = 0.3
  const R = 128
  // 滑块 → 阈值偏置（小幅，两端不崩）：s=0.5 → 0；s<0.5 → 阈值略降(墨少=字细)
  // s>0.5 → 阈值略升(墨多=字粗)。偏置幅度控制在 ±14 亮度，保证可读。
  const bias = (slider - 0.5) * 28
  const bin = new Uint8Array(n)
  let ink = 0
  for (let y = 0; y < h; y++) {
    const y1 = y
    const y2 = y + 2 * r + 1
    for (let x = 0; x < w; x++) {
      const x1 = x
      const x2 = x + 2 * r + 1
      const s = intSum[y2 * SW + x2] - intSum[y1 * SW + x2] - intSum[y2 * SW + x1] + intSum[y1 * SW + x1]
      const sq = intSq[y2 * SW + x2] - intSq[y1 * SW + x2] - intSq[y2 * SW + x1] + intSq[y1 * SW + x1]
      const mean = s / area
      const variance = sq / area - mean * mean
      const std = variance > 0 ? Math.sqrt(variance) : 0
      const T = mean * (1 + K * (std / R - 1)) + bias
      const isInk = gray[y * w + x] < T
      if (isInk) ink++
      bin[y * w + x] = isInk ? 0 : 255
    }
  }
  // 保细线的条件形态学（对标「3x3 开运算去噪点 + 闭运算补断裂」）。
  //
  // ⚠️ 旧版写的是「3x3 邻域黑数 >= 5 才判黑」——那是**中值滤波**，而中值滤波会
  //    把 1px 细笔画整条抹掉（一条竖线在 3x3 里只有上/中/下 3 个黑，< 5 ⇒ 判白）。
  //    这正是思傅 2026-10-22 反馈「黑白后文字发糊」的主因。
  //
  // 新规则（只对明显不该存在的像素动手，其余原样保留）：
  //   中心黑 & 邻域黑数 ≤ 2 ⇒ 孤立噪点，抹白（开运算）
  //   中心白 & 邻域黑数 ≥ 7 ⇒ 笔画内的空洞/断口，补黑（闭运算）
  //   其余保持原样 ⇒ 1px 细笔画（邻域 3 个黑 > 2）完整保留
  const med = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let black = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          if (bin[ny * w + nx] === 0) black++
        }
      }
      const i = y * w + x
      if (bin[i] === 0) {
        // 本身是墨：邻域墨太少 ⇒ 孤立噪点
        med[i] = black <= 2 ? 255 : 0
      } else {
        // 本身是白：邻域墨极多 ⇒ 笔画中间被判白的空洞/断口，补回来
        med[i] = black >= 7 ? 0 : 255
      }
    }
  }
  // ⭐ 滑块控制墨迹粗细：s>0.5 轻微膨胀（保断笔、字稍粗），s<0.5 轻微侵蚀（防糊、字稍细）
  //    幅度克制（1~2 像素内），两端仍可读。s=0.5 不做形态学，保持基准。
  const morph = Math.round((slider - 0.5) * 4) // -2..2，0=不动
  const out = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (morph === 0) { out[i] = med[i]; continue }
      // 取邻域墨迹数（3x3），按 morph 方向判定
      let black = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          if (med[ny * w + nx] === 0) black++
        }
      }
      // morph>0 膨胀：black>=阈值即变黑（阈值随 morph 降低→更易黑=变粗）
      // morph<0 侵蚀：black>阈值才保黑（阈值随 morph 升高→更易白=变细）
      const need = morph > 0 ? Math.max(1, 5 - morph) : 5 - morph
      out[i] = black >= need ? 0 : 255
    }
  }
  // 自动反相兜底：暗背景/曝光异常照片（墨迹过半 → 实际是黑底白字）
  const invert = ink / n > 0.55
  for (let i = 0; i < n; i++) {
    let v = out[i]
    if (invert) v = 255 - v
    d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v
    d[4 * i + 3] = 255
  }
}

/** 3x3 非锐化（拉普拉斯边缘增强），amount 控制强度，不过冲 */
function sharpen3x3(d: Uint8ClampedArray, w: number, h: number, amount: number) {
  const lum = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = lum[i] * 4 - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]
      const add = lap * amount
      d[4 * i] = clamp255(d[4 * i] + add)
      d[4 * i + 1] = clamp255(d[4 * i + 1] + add)
      d[4 * i + 2] = clamp255(d[4 * i + 2] + add)
    }
  }
}
