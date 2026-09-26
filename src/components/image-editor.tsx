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

export default function ImageEditor({ visible, src, onCancel, onConfirm, autoAction = null }: ImageEditorProps) {
  // 当前展示图（可能是本地路径或 AI 处理后的远程 URL）
  const [currentSrc, setCurrentSrc] = useState(src)
  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<Rect>({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
  const [boxW, setBoxW] = useState(0)
  const [boxH, setBoxH] = useState(0)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const canvasNodeRef = useRef<any>(null)
  const dragRef = useRef<{
    target: DragTarget
    startX: number
    startY: number
    start: Rect
  } | null>(null)
  const canvasRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })

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
    setConfirmed(false)
    canvasNodeRef.current = null

    Taro.getImageInfo({ src })
      .then((info) => resetBox(info.width, info.height))
      .catch(() => {
        Taro.showToast({ title: '图片读取失败', icon: 'none' })
      })
    // 测量画布相对可见区域偏移，用于把触摸坐标换算为容器内坐标
    setTimeout(() => {
      Taro.createSelectorQuery()
        .select(`#${CANVAS_ID}`)
        .boundingClientRect((rect) => {
          const r = Array.isArray(rect) ? rect[0] : rect
          if (r) canvasRectRef.current = { left: r.left, top: r.top }
        })
        .exec()
    }, 60)
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
    if (!img.width || !img.height) return // 载入失败则保持空白，避免画出黑块
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

  // 打开后自动执行指定 AI 处理
  useEffect(() => {
    if (!visible || !autoAction || aiBusy || busy) return
    const cfg = AI_ACTIONS.find((a) => a.action === autoAction)
    if (cfg) {
      void handleAi(cfg.action, cfg.label)
    }
    // 仅触发一次即可（aiBusy 重置后若 autoAction 变化再触发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoAction])

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
    const rx = t.clientX - canvasRectRef.current.left
    const ry = t.clientY - canvasRectRef.current.top
    const target = hitTarget(rx, ry)
    if (!target) return
    dragRef.current = {
      target,
      startX: rx,
      startY: ry,
      start: { ...crop },
    }
  }

  const onTouchMove = (e: any) => {
    const drag = dragRef.current
    if (!drag) return
    const t = e.touches[0]
    const rx = t.clientX - canvasRectRef.current.left
    const ry = t.clientY - canvasRectRef.current.top
    const dx = (rx - drag.startX) / boxW
    const dy = (ry - drag.startY) / boxH
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
  }

  // 导出当前裁剪区域为新图（本地 tempFilePath）
  // 注意：小程序 Canvas 2D 的 canvasToTempFilePath 中 x/y/width/height 采用
  // 逻辑像素（相对 boxW/boxH），destWidth/destHeight 才用物理像素，二者混用会导致导出区域偏移。
  const exportCrop = async (): Promise<string> => {
    await renderCanvas() // 确保绘制完成
    const node = await getCanvasNode()
    if (!node) throw new Error('canvas 未就绪')
    const dpr = Taro.getSystemInfoSync().pixelRatio || 1
    return new Promise<string>((resolve, reject) => {
      Taro.canvasToTempFilePath({
        canvas: node,
        x: crop.x * boxW,
        y: crop.y * boxH,
        width: crop.w * boxW,
        height: crop.h * boxH,
        destWidth: Math.round(crop.w * boxW * dpr),
        destHeight: Math.round(crop.h * boxH * dpr),
        fileType: 'jpg',
        quality: 0.95,
        success: (r) => resolve(r.tempFilePath),
        fail: (err) => reject(err),
      } as any)
    })
  }

  // 确定裁剪：真正把选区内内容导出为新图，预览只显示该区域
  const handleConfirmCrop = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      const out = await exportCrop()
      const info = await Taro.getImageInfo({ src: out })
      setCurrentSrc(out)
      setRotation(0)
      setNaturalW(info.width)
      setNaturalH(info.height)
      setCrop({ x: 0, y: 0, w: 1, h: 1 })
      setConfirmed(true)
      resetBox(info.width, info.height)
      Taro.showToast({ title: '已裁剪，点「使用此图」返回', icon: 'none' })
    } catch (err) {
      console.error('裁剪失败', err)
      Taro.showToast({ title: '裁剪失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把原图压缩到 MAX_SIDE 以内，缩短上传 + AI 处理耗时（解决「处理太久」）。
   * 压缩失败则退回原图，不影响后续流程。
   */
  const compressImage = async (filePath: string): Promise<string> => {
    if (/^https?:\/\//.test(filePath)) return filePath // 远程图由后端下载，不在此压缩
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

  // 给下载任务加超时，避免卡死在「一直转圈」
  const downloadWithTimeout = (url: string, ms: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      const task = Network.downloadFile({ url })
      const timer = setTimeout(() => {
        try { (task as any).abort?.() } catch { /* ignore */ }
        reject(new Error('处理结果下载超时'))
      }, ms)
      Promise.resolve(task as any).then(
        (r: any) => {
          clearTimeout(timer)
          resolve(r)
        },
        (e: any) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  // AI 处理：调后端图生图；全程带超时与「结果校验」，失败绝不把坏图塞给画布（解决黑屏）
  const handleAi = async (action: ImageAction, label: string) => {
    if (aiBusy || busy) return
    setAiBusy(true)
    Taro.showLoading({ title: `${label}处理中…`, mask: true })
    let lastGoodSrc = currentSrc // 失败兜底：保留上一张有效图
    try {
      // 1) 预处理：压缩原图，显著缩短上传与 AI 处理耗时
      const sourceForProcess = await compressImage(currentSrc)
      lastGoodSrc = sourceForProcess

      // 2) 上传（purpose=temp，不落库）拿到可访问 URL
      let sourceUrl = sourceForProcess
      if (!/^https?:\/\//.test(sourceForProcess)) {
        const up = await uploadImage(sourceForProcess, { purpose: 'temp' })
        sourceUrl = up.url
      }

      // 3) 调后端（processImage 自带 90s 超时，不会无限转圈）
      const data = await processImage(action, sourceUrl)

      // 4) 下载结果并严格校验：只有确认是有效图片才替换，否则保留原图，杜绝黑屏
      if (!data?.url) throw new Error('处理服务未返回图片')
      const dl = await downloadWithTimeout(data.url, 30000)
      if (dl.statusCode !== 200 || !dl.tempFilePath) {
        throw new Error('处理结果下载失败，请重试')
      }
      const info = await Taro.getImageInfo({ src: dl.tempFilePath })
      if (!info || !info.width || !info.height) {
        throw new Error('处理结果不是有效图片')
      }

      // 校验通过 → 应用结果
      setCurrentSrc(dl.tempFilePath)
      setRotation(0)
      setCrop({ x: 0.05, y: 0.08, w: 0.9, h: 0.84 })
      setNaturalW(info.width)
      setNaturalH(info.height)
      Taro.showToast({ title: `${label}完成`, icon: 'success' })
    } catch (e) {
      console.error('AI 图片处理失败', e)
      const msg = e instanceof Error ? e.message : `${label}失败，请重试`
      Taro.showToast({ title: msg, icon: 'none' })
      // 关键：失败不清空 currentSrc，回到上一张有效图（避免整屏变黑）
      setCurrentSrc(lastGoodSrc)
    } finally {
      setAiBusy(false)
      Taro.hideLoading()
    }
  }

  // 保存到小程序数据库（仅显式点击时归档进「最近题目」）
  const handleSave = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      // 若已确定裁剪则导出裁剪结果，否则用当前编辑态整图
      const imgSrc = confirmed ? await exportCrop() : currentSrc
      // purpose=save → 后端归档进「最近题目」（不会自动发生，只有点了这里才会）
      await uploadImage(imgSrc, { purpose: 'save' })
      Taro.showToast({ title: '已保存到最近题目', icon: 'success' })
    } catch (err: any) {
      console.error('保存图片失败', err)
      Taro.showToast({ title: err?.message ? err.message : '保存失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  // 确认使用：导出最终图片并回传给识别页（这一步也是「退出裁剪」）
  const handleConfirm = async () => {
    if (busy || aiBusy) return
    setBusy(true)
    try {
      const out = await exportCrop()
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
        <View className="flex items-center gap-1" onClick={onCancel}>
          <X size={22} color="#ffffff" />
          <Text className="block text-white text-sm">退出</Text>
        </View>
        <Text className="block text-white text-sm font-medium">裁剪与调整</Text>
        <View className="w-8 flex items-center justify-end" onClick={handleReset}>
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
          >
            <Canvas
              type="2d"
              id={CANVAS_ID}
              style={{ width: boxW, height: boxH }}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            />

            {/* 半透明遮罩：用 4 个块围出裁剪区域（纯视觉，不拦截触摸） */}
            <Overlay crop={crop} />

            {/* 裁剪边框（纯视觉，不拦截触摸） */}
            <View
              className="absolute border border-white pointer-events-none"
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
                  className="absolute pointer-events-none"
                  style={{
                    width: 16,
                    height: 16,
                    left: h.dx * crop.w * boxW - 8,
                    top: h.dy * crop.h * boxH - 8,
                    borderWidth: 3,
                    borderStyle: 'solid',
                    borderColor: '#ffffff',
                  }}
                />
              ))}
              {/* 四边中点手柄 */}
              <View key="edge-t" className="absolute pointer-events-none" style={{ left: (crop.w * boxW) / 2 - 14, top: -7, width: 28, height: 2, backgroundColor: '#ffffff' }} />
              <View key="edge-b" className="absolute pointer-events-none" style={{ left: (crop.w * boxW) / 2 - 14, bottom: -7, width: 28, height: 2, backgroundColor: '#ffffff' }} />
              <View key="edge-l" className="absolute pointer-events-none" style={{ top: (crop.h * boxH) / 2 - 14, left: -7, width: 2, height: 28, backgroundColor: '#ffffff' }} />
              <View key="edge-r" className="absolute pointer-events-none" style={{ top: (crop.h * boxH) / 2 - 14, right: -7, width: 2, height: 28, backgroundColor: '#ffffff' }} />
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
          <View className="flex flex-col items-center" onClick={handleSave}>
            <Database size={24} color="#ffffff" />
            <Text className="block text-white text-opacity-80 text-xs mt-1">保存图片</Text>
          </View>
        </View>
        <Button
          className="w-full h-11 rounded-xl bg-primary"
          disabled={busy || aiBusy}
          onClick={handleConfirm}
        >
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
