import { View, Text, Canvas, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Network } from '@/network'
import { RotateCw, Crop, Undo2, X, Wand, Sparkles, Eraser, Download } from 'lucide-react-taro'
import { processImage, uploadImage, type ImageAction } from '@/services/api'

interface ImageEditorProps {
  visible: boolean
  src: string
  onCancel: () => void
  onConfirm: (tempFilePath: string) => void
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

// AI 处理按钮配置
const AI_ACTIONS: { action: ImageAction; label: string; icon: any }[] = [
  { action: 'auto', label: '自动调正', icon: Wand },
  { action: 'enhance', label: '智能高清', icon: Sparkles },
  { action: 'erase', label: '去手写', icon: Eraser },
]

export default function ImageEditor({ visible, src, onCancel, onConfirm }: ImageEditorProps) {
  // 当前展示图（可能是本地路径或 AI 处理后的远程 URL）
  const [currentSrc, setCurrentSrc] = useState(src)
  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<Rect>({ x: 0.05, y: 0.08, w: 0.9, h: 0.84})
  const [boxW, setBoxW] = useState(0)
  const [boxH, setBoxH] = useState(0)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
  } | null>(null)

  // 初始化：读取图片尺寸，按 contain 计算展示盒大小
  const resetBox = (imgW: number, imgH: number) => {
    setNaturalW(imgW)
    setNaturalH(imgH)
    const sys = Taro.getSystemInfoSync()
    const availW = sys.windowWidth - 32
    const availH = sys.windowHeight - 240
    const scale = Math.min(availW / imgW, availH / imgH, 1)
    setBoxW(imgW * scale)
    setBoxH(imgH * scale)
  }

  useEffect(() => {
    if (!visible || !src) return
    setCurrentSrc(src)
    setRotation(0)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
    setBusy(false)
    setAiBusy(false)
    canvasNodeRef.current = null

    Taro.getImageInfo({ src })
      .then((info) => resetBox(info.width, info.height))
      .catch(() => {
        Taro.showToast({ title: '图片读取失败', icon: 'none' })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, src])

  // 旋转后按新的朝向重算展示盒
  useEffect(() => {
    if (!naturalW || !naturalH || rotation === 0) return
    const sys = Taro.getSystemInfoSync()
    const availW = sys.windowWidth - 32
    const availH = sys.windowHeight - 240
    // 旋转 90/270 后宽高互换
    const rw = naturalH
    const rh = naturalW
    const scale = Math.min(availW / rw, availH / rh, 1)
    setBoxW(rw * scale)
    setBoxH(rh * scale)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, naturalW, naturalH])

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

  // 将旋转后的整图以 contain 方式绘制到画布（导出前务必 await 本函数以完成绘制）
  const renderCanvas = async () => {
    const node = await getCanvasNode()
    if (!node) return
    const dpr = Taro.getSystemInfoSync().pixelRatio || 1
    node.width = boxW * dpr
    node.height = boxH * dpr
    const ctx = node.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, boxW, boxH)
    // 用 canvas.createImage 加载本地/网络图片，避免传字符串在小程序真机绘制失败
    let img: any = null
    if (node.createImage) {
      img = node.createImage()
    } else {
      img = new Image()
    }
    img.src = currentSrc
    await new Promise<void>((resolve) => {
      img.onload = () => resolve()
      img.onerror = () => resolve()
    })
    ctx.save()
    ctx.translate(boxW / 2, boxH / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    const scale = Math.min(boxW / naturalW, boxH / naturalH)
    const drawW = naturalW * scale
    const drawH = naturalH * scale
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH)
    ctx.restore()
  }

  // 跟随状态变化重绘
  useEffect(() => {
    if (!visible || !boxW || !boxH || !naturalW || aiBusy) return
    renderCanvas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, boxW, boxH, rotation, naturalW, naturalH, currentSrc, aiBusy])

  // ---------- 裁剪框手势 ----------
  const hitTarget = (touchX: number, touchY: number): DragTarget | null => {
    const left = crop.x * boxW
    const top = crop.y * boxH
    const right = (crop.x + crop.w) * boxW
    const bottom = (crop.y + crop.h) * boxH
    const near = (v: number, edge: number) => Math.abs(v - edge) <= HANDLE_HIT

    // 角点优先
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
    const target = hitTarget(t.clientX, t.clientY)
    if (!target) return
    dragRef.current = {
      target,
      startX: t.clientX,
      startY: t.clientY,
      start: { ...crop },
    }
  }

  const onTouchMove = (e: any) => {
    const drag = dragRef.current
    if (!drag) return
    const t = e.touches[0]
    const dx = (t.clientX - drag.startX) / boxW
    const dy = (t.clientY - drag.startY) / boxH
    setCrop(clampCrop(applyDrag(drag.start, drag.target, dx, dy)))
  }

  const onTouchEnd = () => {
    dragRef.current = null
  }

  const handleRotate = () => {
    setRotation((r) => (r + 90) % 360)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
  }

  const handleReset = () => {
    setRotation(0)
    setCurrentSrc(src)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
  }

  // AI 处理：调后端图生图，得到结果 URL 后下载为本地临时图，继续编辑
  const handleAi = async (action: ImageAction, label: string) => {
    if (aiBusy || busy) return
    setAiBusy(true)
    Taro.showLoading({ title: `${label}处理中…`, mask: true })
    try {
      // AI 处理需要网络可访问的 URL；本地临时图先上传
      let sourceUrl = currentSrc
      if (!/^https?:\/\//.test(currentSrc)) {
        const up = await uploadImage(currentSrc)
        sourceUrl = up.url
      }
      const data = await processImage(action, sourceUrl)
      // 将远程 URL 下载为本地临时文件（跨端）
      const dl = await Network.downloadFile({ url: data.url })
      if (dl.statusCode !== 200 || !dl.tempFilePath) {
        throw new Error('处理结果下载失败')
      }
      const info = await Taro.getImageInfo({ src: dl.tempFilePath })
      setCurrentSrc(dl.tempFilePath)
      setRotation(0)
      setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
      setNaturalW(info.width)
      setNaturalH(info.height)
      Taro.showToast({ title: `${label}完成`, icon: 'success' })
    } catch (e) {
      console.error('AI 图片处理失败', e)
      Taro.showToast({ title: e instanceof Error ? e.message : `${label}失败，请重试`, icon: 'none' })
    } finally {
      setAiBusy(false)
      Taro.hideLoading()
    }
  }

  // 保存到相册
  const handleSave = async () => {
    setBusy(true)
    try {
      await renderCanvas()
      const node = await getCanvasNode()
      if (!node) throw new Error('canvas 未就绪')
      const nw = node.width
      const nh = node.height
      const path = await new Promise<string>((resolve, reject) => {
        Taro.canvasToTempFilePath({
          canvas: node,
          x: crop.x * nw,
          y: crop.y * nh,
          width: crop.w * nw,
          height: crop.h * nh,
          destWidth: Math.round(crop.w * nw),
          destHeight: Math.round(crop.h * nh),
          fileType: 'jpg',
          quality: 0.92,
          success: (r) => resolve(r.tempFilePath),
          fail: (err) => reject(err),
        } as any)
      })
      await Taro.saveImageToPhotosAlbum({ filePath: path })
      Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (err: any) {
      console.error('保存图片失败', err)
      if (err?.errMsg?.includes && err.errMsg.includes('auth')) {
        Taro.showToast({ title: '请授权相册权限后重试', icon: 'none' })
      } else {
        Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
      }
    } finally {
      setBusy(false)
    }
  }

  // 确认：从旋转后画布按裁剪框导出
  const handleConfirm = async () => {
    setBusy(true)
    try {
      await renderCanvas() // 确保绘制完成
      const node = await getCanvasNode()
      if (!node) throw new Error('canvas 未就绪')
      const nw = node.width
      const nh = node.height
      const out = await new Promise<string>((resolve, reject) => {
        Taro.canvasToTempFilePath({
          canvas: node,
          x: crop.x * nw,
          y: crop.y * nh,
          width: crop.w * nw,
          height: crop.h * nh,
          destWidth: Math.round(crop.w * nw),
          destHeight: Math.round(crop.h * nh),
          fileType: 'jpg',
          quality: 0.92,
          success: (r) => resolve(r.tempFilePath),
          fail: (err) => reject(err),
        } as any)
      })
      onConfirm(out)
    } catch (err) {
      console.error('导出裁剪图失败', err)
      Taro.showToast({ title: '图片处理失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  if (!visible) return null

  return (
    <View className="fixed inset-0 bg-black z-[200] flex flex-col">
      {/* 顶部栏 */}
      <View className="flex flex-row items-center justify-between px-4 h-14">
        <View className="w-8" onClick={onCancel}>
          <X size={22} color="#ffffff" />
        </View>
        <Text className="block text-white text-sm font-medium">裁剪与调整</Text>
        <View className="w-8 flex items-center" onClick={handleReset}>
          <Undo2 size={19} color="#ffffff" />
        </View>
      </View>

      {/* 画布与裁剪框 */}
      <View className="flex-1 flex items-center justify-center px-4">
        {aiBusy ? (
          <TaroImage src={currentSrc} mode="aspectFit" className="w-full h-full" />
        ) : (
          <View
            style={{ width: boxW || '100%', height: boxH || 240, position: 'relative' }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <Canvas
              type="2d"
              id={CANVAS_ID}
              style={{ width: boxW, height: boxH }}
            />

            {/* 半透明遮罩：用 4 个块围出裁剪区域 */}
            <Overlay crop={crop} />

            {/* 裁剪边框 */}
            <View
              className="absolute border border-white"
              style={{
                left: crop.x * boxW,
                top: crop.y * boxH,
                width: crop.w * boxW,
                height: crop.h * boxH,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
              }}
            >
              {/* 九宫格辅助线 */}
              <View className="absolute inset-0 pointer-events-none">
                <View className="absolute left-1/3 top-0 bottom-0 border-l border-white border-opacity-40" />
                <View className="absolute left-2/3 top-0 bottom-0 border-l border-white border-opacity-40" />
                <View className="absolute top-1/3 left-0 right-0 border-t border-white border-opacity-40" />
                <View className="absolute top-2/3 left-0 right-0 border-t border-white border-opacity-40" />
              </View>

              {/* 四角手柄 */}
              {HANDLES.map((h) => (
                <View
                  key={h.key}
                  className="absolute bg-white"
                  style={{
                    width: 14,
                    height: 14,
                    left: h.dx * crop.w * boxW - 7,
                    top: h.dy * crop.h * boxH - 7,
                    borderRadius: 2,
                  }}
                />
              ))}
            </View>
          </View>
        )}
      </View>

      {/* 底部操作 */}
      <View className="px-4 pb-8 pt-3">
        {/* AI 处理行 */}
        <View className="flex flex-row items-center justify-around mb-4">
          {AI_ACTIONS.map(({ action, label, icon: Icon }) => (
            <View
              key={action}
              className="flex flex-col items-center"
              onClick={() => handleAi(action, label)}
            >
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
          <View className="flex flex-col items-center">
            <Crop size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">拖动边角裁剪</Text>
          </View>
          <View className="flex flex-col items-center" onClick={handleSave}>
            <Download size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">保存图片</Text>
          </View>
        </View>
        <Button
          className="w-full h-11 rounded-xl bg-primary"
          disabled={busy || aiBusy}
          onClick={handleConfirm}
        >
          <Text className="block text-sm text-white">{busy ? '处理中…' : '使用此图'}</Text>
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
      next.x = r.x + dx
      next.y = r.y + dy
      next.w = r.w - dx
      next.h = r.h - dy
      break
    case 'tr':
      next.y = r.y + dy
      next.w = r.w + dx
      next.h = r.h - dy
      break
    case 'bl':
      next.x = r.x + dx
      next.w = r.w - dx
      next.h = r.h + dy
      break
    case 'br':
      next.w = r.w + dx
      next.h = r.h + dy
      break
    case 'l':
      next.x = r.x + dx
      next.w = r.w - dx
      break
    case 'r':
      next.w = r.w + dx
      break
    case 't':
      next.y = r.y + dy
      next.h = r.h - dy
      break
    case 'b':
      next.h = r.h + dy
      break
    case 'move':
      next.x = r.x + dx
      next.y = r.y + dy
      break
  }
  return next
}

// 归一化约束，保证裁剪框合法且不越界
function clampCrop(r: Rect): Rect {
  let { x, y, w, h } = r

  // 尺寸下限
  if (w < MIN_SIZE) w = MIN_SIZE
  if (h < MIN_SIZE) h = MIN_SIZE
  if (w > 1) w = 1
  if (h > 1) h = 1

  x = clamp(x, 0, 1 - w)
  y = clamp(y, 0, 1 - h)
  return { x, y, w, h }
}