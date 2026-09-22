import { View, Text, Canvas } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { RotateCw, Crop, Undo2, X } from 'lucide-react-taro'

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

export default function ImageEditor({ visible, src, onCancel, onConfirm }: ImageEditorProps) {
  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<Rect>({ x: 0.05, y: 0.08, w: 0.9, h: 0.84})
  const [boxW, setBoxW] = useState(0)
  const [boxH, setBoxH] = useState(0)
  const [busy, setBusy] = useState(false)

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
  } | null>(null)

  // 初始化：读取图片尺寸，按 contain 计算展示盒大小
  useEffect(() => {
    if (!visible || !src) return
    setRotation(0)
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
    setBusy(false)
    canvasNodeRef.current = null

    Taro.getImageInfo({ src })
      .then((info) => {
        setNaturalW(info.width)
        setNaturalH(info.height)
        const sys = Taro.getSystemInfoSync()
        const availW = sys.windowWidth - 32
        const availH = sys.windowHeight - 220
        const scale = Math.min(availW / info.width, availH / info.height, 1)
        setBoxW(info.width * scale)
        setBoxH(info.height * scale)
      })
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
    const availH = sys.windowHeight - 220
    // 旋转 90/270 后宽高互换
    const rw = naturalH
    const rh = naturalW
    const scale = Math.min(availW / rw, availH / rh, 1)
    setBoxW(rw * scale)
    setBoxH(rh * scale)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, naturalW, naturalH])

  // 绘制当前旋转后的图像到 canvas
  useEffect(() => {
    if (!visible || !boxW || !boxH || !naturalW) return
    const draw = async () => {
      const node = await getCanvasNode()
      if (!node) return
      const dpr = Taro.getSystemInfoSync().pixelRatio || 1
      node.width = boxW * dpr
      node.height = boxH * dpr
      const ctx = node.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, boxW, boxH)
      ctx.save()
      ctx.translate(boxW / 2, boxH / 2)
      ctx.rotate((rotation * Math.PI) / 180)
      // 旋转后图像以 contain 方式完整显示在 boxW × boxH 内
      const scale = Math.min(boxW / naturalW, boxH / naturalH)
      const drawW = naturalW * scale
      const drawH = naturalH * scale
      ctx.drawImage(
        src,
        -drawW / 2,
        -drawH / 2,
        drawW,
        drawH,
      )
      ctx.restore()
    }
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, boxW, boxH, rotation, naturalW, naturalH])

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
    setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
  }

  // 确认：从旋转后画布按裁剪框导出
  const handleConfirm = async () => {
    setBusy(true)
    try {
      const node = await getCanvasNode()
      const dpr = Taro.getSystemInfoSync().pixelRatio || 1
      const out = await new Promise<string>((resolve, reject) => {
        Taro.canvasToTempFilePath({
          canvas: node,
          x: crop.x * boxW,
          y: crop.y * boxH,
          width: crop.w * boxW,
          height: crop.h * boxH,
          destWidth: Math.round(crop.w * boxW * dpr),
          destHeight: Math.round(crop.h * boxH * dpr),
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
      </View>

      {/* 底部操作 */}
      <View className="px-4 pb-8 pt-4">
        <View className="flex flex-row items-center justify-center gap-10 mb-6">
          <View className="flex flex-col items-center" onClick={handleRotate}>
            <RotateCw size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">旋转90°</Text>
          </View>
          <View className="flex flex-col items-center">
            <Crop size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">拖动边角裁剪</Text>
          </View>
        </View>
        <Button
          className="w-full h-11 rounded-xl bg-primary"
          disabled={busy}
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
