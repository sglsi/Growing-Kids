import { View, Text, Canvas, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { RotateCw, Crop, Undo2, X, Wand, Sparkles, Eraser, Database } from 'lucide-react-taro'
import { processImage, uploadImage, type ImageAction } from '@/services/api'

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

type DragTarget =
  | 'tl' | 'tr' | 'bl' | 'br'
  | 'l' | 'r' | 't' | 'b'
  | 'move'

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

const DEFAULT_CROP: Rect = { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }

// AI 处理前的最大边长（px）与压缩质量。手机原图常 3000~4000px，
// 压到 1280 左右即可满足识别/高清需求，又能把上传与 AI 处理耗时降低一个数量级。
const MAX_SIDE = 1280
const COMPRESS_QUALITY = 80

const AI_ACTIONS: { action: ImageAction; label: string; icon: any }[] = [
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  { action: 'erase', label: '去手写', icon: Eraser },
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

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
  } | null>(null)
  // 容器相对视口的位置；每次触摸前都会重新测量，避免布局变化后坐标漂移
  const boxRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })

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

  const onTouchStart = (e: any) => {
    // 每次触摸前重新测量盒子位置，规避布局变化导致的坐标漂移（选不中的常见原因）
    measureBox(() => {
      const t = e.touches[0]
      const rx = t.clientX - boxRectRef.current.left
      const ry = t.clientY - boxRectRef.current.top
      const target = hitTarget(rx, ry)
      if (!target) return
      dragRef.current = { target, startX: rx, startY: ry, start: { ...crop } }
    })
  }

  const onTouchMove = (e: any) => {
    const drag = dragRef.current
    if (!drag) return
    const t = e.touches[0]
    const rx = t.clientX - boxRectRef.current.left
    const ry = t.clientY - boxRectRef.current.top
    const dx = (rx - drag.startX) / imgW
    const dy = (ry - drag.startY) / imgH
    setCrop(clampCrop(applyDrag(drag.start, drag.target, dx, dy)))
  }

  const onTouchEnd = () => {
    dragRef.current = null
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
   * 用离屏 Canvas 把「当前编辑态（旋转 + 裁剪）」导出为本地图片。
   *
   * 规范做法（微信 Canvas 2D + canvasToTempFilePath）：
   *  - 画布缓冲设为 原图尺寸 × dpr，并用 ctx.scale(dpr, dpr) 后以「逻辑像素」绘制；
   *  - canvasToTempFilePath 的 x/y/width/height 用「缓冲像素」= 逻辑 × dpr；
   *  - destWidth/destHeight 同样用「逻辑 × dpr」，输出即高清且区域零偏移。
   * 预览框严格按原图比例算，故屏幕框选区域与导出区域一一对应。
   */
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
  const exportEdited = async (rot: number = rotation, fullFrame = false): Promise<string> => {
    const node = await waitCanvasNode()
    if (!node) throw new Error('画布未就绪，请稍后重试')
    const dpr = Taro.getSystemInfoSync().pixelRatio || 1
    const outW = naturalW
    const outH = naturalH
    // 90°/270° 旋转后宽高互换，输出画布尺寸需相应交换，否则旋转图放不下会被裁掉
    const swap = rot % 180 !== 0
    const canvasW = swap ? outH : outW
    const canvasH = swap ? outW : outH
    node.width = Math.max(1, Math.round(canvasW * dpr))
    node.height = Math.max(1, Math.round(canvasH * dpr))
    const ctx = node.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, node.width, node.height)
    ctx.scale(dpr, dpr)

    const localSrc = await toLocalIfRemote(currentSrc)
    let img: any = null
    if (node.createImage) img = node.createImage()
    else img = new Image()
    img.src = localSrc
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      img.onload = finish
      img.onerror = finish
      setTimeout(finish, 8000)
    })
    if (!img.width || !img.height) throw new Error('图片加载失败，无法导出')

    // 以画布中心为轴旋转整图（只旋转、不缩放），旋转后整张铺满输出画布
    ctx.save()
    ctx.translate(canvasW / 2, canvasH / 2)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.drawImage(img, -outW / 2, -outH / 2, outW, outH)
    ctx.restore()

    // 裁剪区域：fullFrame（旋转烘焙）取整张；否则用框选 crop。
    // canvasToTempFilePath 的 x/y/width/height 用「缓冲像素」= 逻辑 × dpr。
    const r: Rect = fullFrame ? { x: 0, y: 0, w: 1, h: 1 } : crop
    const x = r.x * canvasW * dpr
    const y = r.y * canvasH * dpr
    const w = r.w * canvasW * dpr
    const h = r.h * canvasH * dpr
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
  const handleAi = async (action: ImageAction, label: string) => {
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

      const data = await processImage(action, sourceUrl)
      if (!data?.url) throw new Error('处理服务未返回图片')

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
      resetBox(info.width, info.height)
      setConfirmed(false) // ← 修复：AI 后清除「已裁剪」态
      setFraming(false)   // ← 修复：AI 后回到干净预览（不再显示裁剪框）
      Taro.showToast({ title: `${label}完成`, icon: 'success' })
    } catch (e) {
      console.error('AI 图片处理失败', e)
      const msg = e instanceof Error ? e.message : `${label}失败，请重试`
      Taro.showToast({ title: msg, icon: 'none' })
      setCurrentSrc(lastGoodSrc)
      try {
        const info = await Taro.getImageInfo({ src: lastGoodSrc })
        resetBox(info.width, info.height)
      } catch { /* ignore */ }
    } finally {
      setAiBusy(false)
      Taro.hideLoading()
    }
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
      const out = confirmed ? currentSrc : await exportEdited()
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

          {/* 半透明遮罩 + 裁剪框（纯视觉，不拦截触摸） */}
          {showFrame && (
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

          {/* 触摸层：仅捕获裁剪框拖动；向四周外扩 24px，确保画在边框外的手柄也能被抓住 */}
          {showFrame && (
            <View
              className="absolute"
              style={{ left: -24, top: -24, right: -24, bottom: -24 }}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            />
          )}

          {/* 离屏 Canvas：仅用于导出编辑结果 */}
          <Canvas
            type="2d"
            id={CANVAS_ID}
            style={{ position: 'absolute', left: '-9999px', top: 0, width: naturalW || 1, height: naturalH || 1 }}
          />
        </View>
      </View>

      {/* 底部操作 */}
      <View className="px-4 pb-8 pt-3">
        {/* AI 处理行 */}
        <View className="flex flex-row items-center justify-around mb-4">
          {AI_ACTIONS.map(({ action, label, icon: Icon }) => (
            <View key={action} className="flex flex-col items-center" onClick={() => handleAi(action, label)}>
              <View className="w-11 h-11 rounded-full bg-white bg-opacity-15 flex items-center justify-center mb-1">
                <Icon size={20} color="#ffffff" />
              </View>
              <Text className="block text-white text-opacity-80 text-xs">{label}</Text>
            </View>
          ))}
        </View>

        <View className="flex flex-row items-center justify-center gap-10 mb-5">
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

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
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
