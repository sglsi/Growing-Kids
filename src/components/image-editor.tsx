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

// 8 个可拖拽手柄（归一化坐标 + 尺寸）
const HANDLES: { key: DragTarget; dx: number; dy: number }[] = [
  { key: 'tl', dx: 0, dy: 0 },
  { key: 'tr', dx: 1, dy: 0 },
  { key: 'bl', dx: 0, dy: 1 },
  { key: 'br', dx: 1, dy: 1 },
]

const CANVAS_ID = 'imgEditorCanvas'
const HANDLE_HIT = 28 // px

// AI 处理前的最大边长（px）与压缩质量。手机原图常 3000~4000px，
// 压到 1280 左右即可满足识别/高清需求，又能把上传与 AI 处理耗时降低一个数量级。
const MAX_SIDE = 1280
const COMPRESS_QUALITY = 80

// AI 处理按钮配置
const AI_ACTIONS: { action: ImageAction; label: string; icon: any }[] = [
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  { action: 'erase', label: '去手写', icon: Eraser },
]

export default function ImageEditor({
  visible, src, onCancel, onConfirm, autoAction = null, enableSaveToInbox = true,
}: ImageEditorProps) {
  // 当前展示图（可能是本地路径或 AI 处理后的远程 URL）
  const [currentSrc, setCurrentSrc] = useState(src)
  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<Rect>({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
  const [imgW, setImgW] = useState(0)
  const [imgH, setImgH] = useState(0)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // 预览是否可显示（用于在加载失败时给出提示，而不是整屏黑）
  const [previewError, setPreviewError] = useState(false)

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
  } | null>(null)
  const boxRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })

  // 容器的屏幕位置（用于把触摸坐标换算为容器内坐标）
  const measureBox = () => {
    setTimeout(() => {
      Taro.createSelectorQuery()
        .select('#imgEditorBox')
        .boundingClientRect((rect) => {
          const r = Array.isArray(rect) ? rect[0] : rect
          if (r) boxRectRef.current = { left: r.left, top: r.top }
        })
        .exec()
    }, 60)
  }

  /**
   * 依据原图尺寸，按 contain 计算「显示尺寸」imgW/imgH。
   * ⚠️ 这里只算展示尺寸，不碰 Canvas —— 预览直接用 <TaroImage>，
   * 从根本上避开 Canvas 2D 加载网络图失败导致的「黑屏」。
   */
  const resetBox = (w: number, h: number) => {
    setNaturalW(w)
    setNaturalH(h)
    const sys = Taro.getSystemInfoSync()
    const availW = sys.windowWidth - 32
    const availH = sys.windowHeight - 260
    const scale = Math.min(availW / w, availH / h, 1)
    setImgW(Math.round(w * scale))
    setImgH(Math.round(h * scale))
    measureBox()
  }

  // 打开/换图：读取尺寸并复位
  const loadImage = async (target: string) => {
    setPreviewError(false)
    try {
      const info = await Taro.getImageInfo({ src: target })
      resetBox(info.width, info.height)
    } catch {
      Taro.showToast({ title: '图片读取失败', icon: 'none' })
      setPreviewError(true)
      // 兜底：给一个不至于为 0 的展示盒，避免完全空白
      const sys = Taro.getSystemInfoSync()
      setImgW(sys.windowWidth - 32)
      setImgH(Math.round((sys.windowWidth - 32) * 0.75))
    }
  }

  useEffect(() => {
    if (!visible || !src) return
    setCurrentSrc(src)
    setRotation(0)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
    setBusy(false)
    setAiBusy(false)
    setConfirmed(false)
    canvasNodeRef.current = null
    void loadImage(src)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, src])

  // 容器尺寸变化时重算（如从 AI 处理返回后图片尺寸变化）
  useEffect(() => {
    if (!visible || !naturalW || !naturalH) return
    resetBox(naturalW, naturalH)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation])

  // 打开后自动执行指定 AI 处理
  useEffect(() => {
    if (!visible || !autoAction || aiBusy || busy) return
    const cfg = AI_ACTIONS.find((a) => a.action === autoAction)
    if (cfg) {
      void handleAi(cfg.action, cfg.label)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoAction])

  // ---------- 裁剪框手势 ----------
  const hitTarget = (touchX: number, touchY: number): DragTarget | null => {
    const left = crop.x * imgW
    const top = crop.y * imgH
    const right = (crop.x + crop.w) * imgW
    const bottom = (crop.y + crop.h) * imgH
    const near = (v: number, edge: number) => Math.abs(v - edge) <= HANDLE_HIT

    if (near(touchX, left) && near(touchY, top)) return 'tl'
    if (near(touchX, right) && near(touchY, top)) return 'tr'
    if (near(touchX, left) && near(touchY, bottom)) return 'bl'
    if (near(touchX, right) && near(touchY, bottom)) return 'br'
    if (near(touchX, left)) return 'l'
    if (near(touchX, right)) return 'r'
    if (near(touchY, top)) return 't'
    if (near(touchY, bottom)) return 'b'
    if (touchX > left && touchX < right && touchY > top && touchY < bottom) return 'move'
    return null
  }

  const onTouchStart = (e: any) => {
    const t = e.touches[0]
    const rx = t.clientX - boxRectRef.current.left
    const ry = t.clientY - boxRectRef.current.top
    const target = hitTarget(rx, ry)
    if (!target) return
    dragRef.current = { target, startX: rx, startY: ry, start: { ...crop } }
  }

  const onTouchMove = (e: any) => {
    const drag = dragRef.current
    if (!drag) return
    const t = e.touches[0]
    const rx = t.clientX - boxRectRef.current.left
    const ry = t.clientY - boxRectRef.current.top
    const dx = (rx - drag.startX) / imgW
    const dy = (ry - drag.startY) / imgH
    setConfirmed(false)
    setCrop(clampCrop(applyDrag(drag.start, drag.target, dx, dy)))
  }

  const onTouchEnd = () => {
    dragRef.current = null
  }

  const handleRotate = () => {
    setRotation((r) => (r + 90) % 360)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
    setConfirmed(false)
  }

  const handleReset = () => {
    setRotation(0)
    setCurrentSrc(src)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
    setConfirmed(false)
    void loadImage(src)
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

  /** 等待 Canvas node 就绪（最多重试若干次），避免首次取不到就永久空白 */
  const waitCanvasNode = async (retry = 10): Promise<any> => {
    for (let i = 0; i < retry; i++) {
      const node = await getCanvasNode()
      if (node) return node
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  /** 远程图先下载到本地（Canvas 无法可靠加载网络图） */
  const toLocalIfRemote = async (u: string): Promise<string> => {
    if (!/^https?:\/\//.test(u)) return u
    try {
      const dl: any = await downloadWithTimeout(u, 30000)
      return dl?.tempFilePath || u
    } catch {
      return u
    }
  }

  /**
   * 用「离屏 Canvas」把当前编辑态（旋转 + 裁剪）导出为本地图片。
   * 关键点：
   *  - Canvas 只用于导出，不用于预览 —— 预览用 <TaroImage>，杜绝黑屏；
   *  - 导出前把远程图落到本地，避免 Canvas 加载网络图失败；
   *  - Canvas node 未就绪时轮询重试，不再「一次取不到就放弃」。
   */
  const exportEdited = async (): Promise<string> => {
    const node = await waitCanvasNode()
    if (!node) throw new Error('画布未就绪，请稍后重试')
    const dpr = Taro.getSystemInfoSync().pixelRatio || 1
    // 导出区域按原图像素计算（naturalW/H），保证清晰度
    const localSrc = await toLocalIfRemote(currentSrc)
    const outW = naturalW
    const outH = naturalH
    node.width = outW
    node.height = outH
    const ctx = node.getContext('2d')
    ctx.clearRect(0, 0, outW, outH)

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

    // 旋转绘制（围绕中心）
    ctx.save()
    ctx.translate((crop.x + crop.w / 2) * outW, (crop.y + crop.h / 2) * outH)
    ctx.rotate((rotation * Math.PI) / 180)
    const drawW = (rotation % 180 === 0 ? outW : outH)
    const drawH = (rotation % 180 === 0 ? outH : outW)
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH)
    ctx.restore()

    // 再按裁剪区域截取
    return new Promise<string>((resolve, reject) => {
      Taro.canvasToTempFilePath({
        canvas: node,
        x: crop.x * outW,
        y: crop.y * outH,
        width: crop.w * outW,
        height: crop.h * outH,
        destWidth: Math.round(crop.w * outW * dpr),
        destHeight: Math.round(crop.h * outH * dpr),
        fileType: 'jpg',
        quality: 0.95,
        success: (r) => resolve(r.tempFilePath),
        fail: (err) => reject(err),
      } as any)
    })
  }

  // 确定裁剪：把选区内内容导出为新图，预览切到裁剪结果
  const handleConfirmCrop = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      const out = await exportEdited()
      const info = await Taro.getImageInfo({ src: out })
      setCurrentSrc(out)
      setRotation(0)
      resetBox(info.width, info.height)
      setCrop({ x: 0, y: 0, w: 1, h: 1 })
      setConfirmed(true)
      Taro.showToast({ title: '已裁剪，点「使用此图」返回', icon: 'none' })
    } catch (err) {
      console.error('裁剪失败', err)
      Taro.showToast({ title: (err as any)?.message || '裁剪失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /** 压缩到 MAX_SIDE 以内，缩短上传 + AI 处理耗时 */
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
   * 修复「处理后不能正常显示」：成功后把结果【下载成本地文件】再作为 currentSrc
   * （本地图由 <TaroImage> 直接显示，稳定不黑屏）；同时重算展示盒。
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

      // 关键：立刻下载成本地文件，后续预览/裁剪/保存都用它
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
      setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
      resetBox(info.width, info.height) // ← 修复：AI 结果尺寸变化后必须重算展示盒
      Taro.showToast({ title: `${label}完成`, icon: 'success' })
    } catch (e) {
      console.error('AI 图片处理失败', e)
      const msg = e instanceof Error ? e.message : `${label}失败，请重试`
      Taro.showToast({ title: msg, icon: 'none' })
      // 失败回退到上一张有效图（本地图，保证可显示）
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

  // 保存到「最近题目」（仅显式点击时归档）
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

  // 确认使用：导出最终图片并回传（这一步也是「退出裁剪」）
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
              style={{ width: '100%', height: '100%', transform: `rotate(${rotation}deg)` }}
              onError={() => setPreviewError(true)}
            />
          )}

          {/* 半透明遮罩 + 裁剪框（纯视觉，不拦截触摸） */}
          {!aiBusy && (
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
                      width: 16, height: 16,
                      left: h.dx * crop.w * imgW - 8,
                      top: h.dy * crop.h * imgH - 8,
                      borderWidth: 3, borderStyle: 'solid', borderColor: '#ffffff',
                    }}
                  />
                ))}
                <View key="edge-t" className="absolute pointer-events-none" style={{ left: (crop.w * imgW) / 2 - 14, top: -7, width: 28, height: 2, backgroundColor: '#ffffff' }} />
                <View key="edge-b" className="absolute pointer-events-none" style={{ left: (crop.w * imgW) / 2 - 14, bottom: -7, width: 28, height: 2, backgroundColor: '#ffffff' }} />
                <View key="edge-l" className="absolute pointer-events-none" style={{ top: (crop.h * imgH) / 2 - 14, left: -7, width: 2, height: 28, backgroundColor: '#ffffff' }} />
                <View key="edge-r" className="absolute pointer-events-none" style={{ top: (crop.h * imgH) / 2 - 14, right: -7, width: 2, height: 28, backgroundColor: '#ffffff' }} />
              </View>
            </>
          )}

          {/* 触摸层：只捕获裁剪框拖动 */}
          {!aiBusy && (
            <View
              className="absolute inset-0"
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            />
          )}

          {/* 离屏 Canvas：仅用于导出编辑结果，尺寸固定但仍需挂载以获得 node */}
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
            <View className={`w-11 h-11 rounded-full flex items-center justify-center mb-1 ${confirmed ? 'bg-primary' : 'bg-white bg-opacity-15'}`}>
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
