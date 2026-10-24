import { View, Text, Image as TaroImage } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState, useRef, useEffect } from 'react'
import { BRAND } from '@/lib/theme'

/**
 * P2（#130 / 设计文档 §4.7）：错题圈定结果页的「原图 + 系统圈框叠加」编辑器。
 *
 * 手势词汇（与 image-editor 的裁剪体验一致）：
 *  - 框内拖动 → 移动；角点拖动 → 缩放；松手 → onCommit 触发重切重识；
 *  - 长按已收录框（600ms）→ 删除；长按未收录框 → 添加为错题；
 *  - 空白处画新框 → onCommit(null, box) 补捞漏题。
 * 坐标口径：box 一律**页图像素**（与后端 blocks[].box 同口径），
 * 显示层按 contain 缩放换算（s = page.w / imgW）。
 */

export interface PageBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface BoxEditorItem {
  /** 系统块 id（drafts 与 blocks 共用同一 id 指认） */
  id: number
  box: PageBox
  verdict: 'wrong' | 'correct' | 'blank' | 'unknown'
  question_label?: string
  /** true=已收录为草稿（可改/可删）；false=系统非错题块（长按可添加） */
  active: boolean
}

interface Props {
  visible: boolean
  /** 题面图（本地路径优先） */
  imageSrc: string
  /** 页图像素尺寸（后端 page；为 0 时回退图片自然尺寸） */
  page: { w: number; h: number }
  items: BoxEditorItem[]
  /** 重切进行中：禁手势 + 顶部提示 */
  busy?: boolean
  /** 拖动/缩放过程中（视觉同步，不触发请求） */
  onPreview: (id: number, box: PageBox) => void
  /** 手势结束（改框/新框/添加）→ 触发重切重识；id=null 表示新画框 */
  onCommit: (id: number | null, box: PageBox) => void
  /** 长按删除已收录框 */
  onDelete: (id: number) => void
  onClose: () => void
}

const MIN_PAGE_PX = 24 // 页像素最小边（防退化框）
const CORNER_HIT = 26 // 角点命中半径（显示 px）
const LONG_PRESS_MS = 600

type Corner = 'tl' | 'tr' | 'bl' | 'br'
type DragTarget = 'move' | Corner

export default function WrongqBoxEditor(props: Props) {
  const { visible, imageSrc, page, items, busy } = props
  const [imgW, setImgW] = useState(0)
  const [imgH, setImgH] = useState(0)
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [drawing, setDrawing] = useState<PageBox | null>(null)

  const layerRectRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 })
  const dragRef = useRef<{ target: DragTarget; id: number; startBox: PageBox; startX: number; startY: number } | null>(null)
  const drawRef = useRef<{ startX: number; startY: number } | null>(null)
  const latestRef = useRef<PageBox | null>(null)
  const lpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lpMovedRef = useRef(false)

  // 有效页尺寸：后端 page 优先，回退图片自然尺寸
  const pw = page.w > 0 ? page.w : nat.w
  const ph = page.h > 0 ? page.h : nat.h
  const s = imgW > 0 && pw > 0 ? pw / imgW : 1

  // 打开/换图：读自然尺寸 + 按 contain 算展示盒（与 image-editor 同法，
  // 盒子宽高比与原图严格一致 → 屏上框选与后端像素一一对应）
  useEffect(() => {
    if (!visible || !imageSrc) return
    let alive = true
    Taro.getImageInfo({ src: imageSrc })
      .then((info) => {
        if (!alive) return
        const w = info.width || 0
        const h = info.height || 0
        setNat({ w, h })
        const sys = Taro.getSystemInfoSync()
        const availW = sys.windowWidth - 32
        const availH = 300
        const scale = Math.min(availW / w, availH / h, 1)
        setImgW(Math.round(w * scale))
        setImgH(Math.round(h * scale))
        measureLayer()
      })
      .catch(() => {
        if (!alive) return
        const sys = Taro.getSystemInfoSync()
        setImgW(sys.windowWidth - 32)
        setImgH(280)
      })
    return () => { alive = false }
  }, [visible, imageSrc])

  const measureLayer = (cb?: () => void) => {
    Taro.createSelectorQuery()
      .select('#wrongqBoxLayer')
      .boundingClientRect((rect) => {
        const r = Array.isArray(rect) ? rect[0] : rect
        if (r) layerRectRef.current = { left: r.left, top: r.top }
        cb?.()
      })
      .exec()
  }

  const clampV = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

  /** 夹紧到页面 + 最小边（页像素） */
  const fit = (b: PageBox): PageBox => {
    let x0 = clampV(Math.round(b.x0), 0, Math.max(0, pw - 1))
    let y0 = clampV(Math.round(b.y0), 0, Math.max(0, ph - 1))
    let x1 = clampV(Math.round(b.x1), 0, Math.max(0, pw - 1))
    let y1 = clampV(Math.round(b.y1), 0, Math.max(0, ph - 1))
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    if (x1 - x0 < MIN_PAGE_PX) x1 = Math.min(pw - 1, x0 + MIN_PAGE_PX)
    if (y1 - y0 < MIN_PAGE_PX) y1 = Math.min(ph - 1, y0 + MIN_PAGE_PX)
    return { x0, y0, x1, y1 }
  }

  const inBox = (b: PageBox, px: number, py: number, pad = 0) =>
    px >= b.x0 - pad && px <= b.x1 + pad && py >= b.y0 - pad && py <= b.y1 + pad

  /** 命中选中框的角点（命中半径换算成页像素） */
  const hitCorner = (b: PageBox, dx: number, dy: number): Corner | null => {
    const r = CORNER_HIT * s
    const near = (v: number, edge: number) => Math.abs(v - edge) <= r
    if (near(dx, b.x0) && near(dy, b.y0)) return 'tl'
    if (near(dx, b.x1) && near(dy, b.y0)) return 'tr'
    if (near(dx, b.x0) && near(dy, b.y1)) return 'bl'
    if (near(dx, b.x1) && near(dy, b.y1)) return 'br'
    return null
  }

  const clearLongPress = () => {
    if (lpTimerRef.current) { clearTimeout(lpTimerRef.current); lpTimerRef.current = null }
  }

  const startLongPress = (id: number) => {
    clearLongPress()
    lpMovedRef.current = false
    lpTimerRef.current = setTimeout(() => {
      lpTimerRef.current = null
      const it = items.find((x) => x.id === id)
      if (!it) return
      if (it.active) {
        Taro.showModal({
          title: '删除这道题？',
          content: '框选与识别结果都会被移除，之后可在空白处重新画框补捞',
          confirmText: '删除',
          confirmColor: BRAND,
          success: (r) => { if (r.confirm) props.onDelete(id) },
        })
      } else {
        Taro.showModal({
          title: '添加为错题？',
          content: '该区域系统未判为错题，将按当前框重新识别并收录',
          success: (r) => { if (r.confirm) props.onCommit(id, it.box) },
        })
      }
    }, LONG_PRESS_MS)
  }

  const onTouchStart = (e: any) => {
    if (busy) return
    measureLayer(() => {
      const t = e.touches[0]
      const dx = t.clientX - layerRectRef.current.left
      const dy = t.clientY - layerRectRef.current.top
      if (dx < 0 || dy < 0 || dx > imgW || dy > imgH) return
      const px = dx * s
      const py = dy * s
      // ① 选中框的角点 → 缩放
      if (selectedId != null) {
        const sel = items.find((x) => x.id === selectedId)
        if (sel?.active) {
          const c = hitCorner(sel.box, px, py)
          if (c) {
            dragRef.current = { target: c, id: sel.id, startBox: sel.box, startX: dx, startY: dy }
            return
          }
        }
      }
      // ② 已收录框内 → 选中 + 移动（长按可删）
      const act = items.find((x) => x.active && inBox(x.box, px, py, CORNER_HIT * s))
      if (act) {
        setSelectedId(act.id)
        dragRef.current = { target: 'move', id: act.id, startBox: act.box, startX: dx, startY: dy }
        latestRef.current = act.box
        startLongPress(act.id)
        return
      }
      // ③ 未收录框内 → 选中（长按可添加）
      const inact = items.find((x) => !x.active && inBox(x.box, px, py, CORNER_HIT * s))
      if (inact) {
        setSelectedId(inact.id)
        startLongPress(inact.id)
        return
      }
      // ④ 空白 → 画新框
      drawRef.current = { startX: dx, startY: dy }
      setDrawing({ x0: dx, y0: dy, x1: dx, y1: dy })
    })
  }

  const onTouchMove = (e: any) => {
    const t = e.touches[0]
    const dx = t.clientX - layerRectRef.current.left
    const dy = t.clientY - layerRectRef.current.top
    if (lpTimerRef.current && Math.hypot(dx - (dragRef.current?.startX ?? dx), dy - (dragRef.current?.startY ?? dy)) > 10) {
      lpMovedRef.current = true
      clearLongPress()
    }
    const drag = dragRef.current
    if (drag) {
      const ddx = (dx - drag.startX) * s
      const ddy = (dy - drag.startY) * s
      const b = drag.startBox
      let next: PageBox
      if (drag.target === 'move') {
        next = fit({ x0: b.x0 + ddx, y0: b.y0 + ddy, x1: b.x1 + ddx, y1: b.y1 + ddy })
      } else {
        next = { ...b }
        if (drag.target === 'tl') { next.x0 = b.x0 + ddx; next.y0 = b.y0 + ddy }
        if (drag.target === 'tr') { next.x1 = b.x1 + ddx; next.y0 = b.y0 + ddy }
        if (drag.target === 'bl') { next.x0 = b.x0 + ddx; next.y1 = b.y1 + ddy }
        if (drag.target === 'br') { next.x1 = b.x1 + ddx; next.y1 = b.y1 + ddy }
        next = fit(next)
      }
      latestRef.current = next
      props.onPreview(drag.id, next)
      return
    }
    if (drawRef.current) {
      setDrawing({
        x0: clampV(drawRef.current.startX, 0, imgW),
        y0: clampV(drawRef.current.startY, 0, imgH),
        x1: clampV(dx, 0, imgW),
        y1: clampV(dy, 0, imgH),
      })
    }
  }

  const onTouchEnd = () => {
    clearLongPress()
    const drag = dragRef.current
    dragRef.current = null
    if (drag) {
      const final = latestRef.current ?? drag.startBox
      props.onCommit(drag.id, final)
      return
    }
    if (drawRef.current) {
      const d = drawing
      drawRef.current = null
      setDrawing(null)
      if (!d) return
      const px0 = Math.min(d.x0, d.x1) * s
      const py0 = Math.min(d.y0, d.y1) * s
      const px1 = Math.max(d.x0, d.x1) * s
      const py1 = Math.max(d.y0, d.y1) * s
      if (px1 - px0 >= MIN_PAGE_PX && py1 - py0 >= MIN_PAGE_PX) {
        props.onCommit(null, fit({ x0: px0, y0: py0, x1: px1, y1: py1 }))
      } else {
        Taro.showToast({ title: '框选范围过小', icon: 'none' })
      }
    }
  }

  if (!visible || !imageSrc) return null

  const colorOf = (it: BoxEditorItem) =>
    it.active ? (it.verdict === 'wrong' ? BRAND : '#B45309') : '#9CA3AF'
  const chipBgOf = (it: BoxEditorItem) =>
    it.active ? (it.verdict === 'wrong' ? BRAND : '#B45309') : '#6B7280'

  return (
    <View className="rounded-2xl border-border p-3 mb-3" style={{ backgroundColor: '#fff', border: '1px solid #ece8e0' }}>
      {/* 头部：标题 + 手势说明 + 收起 */}
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="block text-sm font-semibold text-foreground">圈定范围校对</Text>
        <Text className="block text-xs text-muted-foreground" onClick={props.onClose}>收起</Text>
      </View>
      <Text className="block text-xs text-muted-foreground mb-2">
        拖动移动 · 角点缩放 · 长按删除/添加 · 空白处画新框（松手自动重新识别）
      </Text>
      {busy ? (
        <View className="rounded-xl px-3 py-1 mb-2" style={{ backgroundColor: 'rgba(46, 111, 78,0.08)' }}>
          <Text className="block text-xs" style={{ color: BRAND }}>正在按新框重新识别…</Text>
        </View>
      ) : null}

      {/* 图 + 叠加框 */}
      <View className="flex flex-row justify-center">
        <View style={{ width: imgW, height: imgH, position: 'relative' }}>
          <TaroImage src={imageSrc} mode="aspectFit" style={{ width: imgW, height: imgH, borderRadius: 8 }} />

          {/* 系统/用户框（纯视觉） */}
          {items.map((it) => {
            const sel = it.id === selectedId
            return (
              <View
                key={it.id}
                style={{
                  position: 'absolute',
                  left: it.box.x0 / s,
                  top: it.box.y0 / s,
                  width: (it.box.x1 - it.box.x0 + 1) / s,
                  height: (it.box.y1 - it.box.y0 + 1) / s,
                  borderWidth: sel ? 2 : 1.5,
                  borderStyle: 'solid',
                  borderColor: colorOf(it),
                  borderRadius: 3,
                  backgroundColor: sel ? 'rgba(46, 111, 78, 0.08)' : 'transparent',
                  opacity: it.active ? 1 : 0.55,
                }}
              >
                {/* 题号标签 */}
                <View style={{
                  position: 'absolute', top: -16, left: -1,
                  backgroundColor: chipBgOf(it), borderRadius: 3,
                  paddingLeft: 4, paddingRight: 4, maxWidth: 160,
                }}
                >
                  <Text className="block text-white" style={{ fontSize: 9, lineHeight: '14px' }}>
                    {(it.question_label || `题块 #${it.id}`).slice(0, 14)}{it.active ? '' : ' ·未收录'}
                  </Text>
                </View>
                {/* 角点手柄（仅选中） */}
                {sel ? (['tl', 'tr', 'bl', 'br'] as Corner[]).map((c) => (
                  <View
                    key={c}
                    style={{
                      position: 'absolute',
                      width: 12, height: 12,
                      backgroundColor: '#fff',
                      borderWidth: 2, borderStyle: 'solid', borderColor: colorOf(it),
                      borderRadius: 6,
                      left: c === 'tl' || c === 'bl' ? -6 : undefined,
                      right: c === 'tr' || c === 'br' ? -6 : undefined,
                      top: c === 'tl' || c === 'tr' ? -6 : undefined,
                      bottom: c === 'bl' || c === 'br' ? -6 : undefined,
                    }}
                  />
                )) : null}
              </View>
            )
          })}

          {/* 新框橡皮筋（纯视觉） */}
          {drawing ? (
            <View style={{
              position: 'absolute',
              left: Math.min(drawing.x0, drawing.x1), top: Math.min(drawing.y0, drawing.y1),
              width: Math.abs(drawing.x1 - drawing.x0), height: Math.abs(drawing.y1 - drawing.y0),
              borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#2563EB',
              backgroundColor: 'rgba(37,99,235,0.08)', borderRadius: 3,
            }}
            />
          ) : null}

          {/* 触摸层：与图同边界，catchTouchMove 阻止 ScrollView 吞手势（Taro 类型未声明，走展开 Cast） */}
          <View
            id="wrongqBoxLayer"
            className="absolute"
            style={{ left: 0, top: 0, right: 0, bottom: 0 }}
            {...({ catchTouchMove: true } as any)}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
        </View>
      </View>

      {/* 图例 */}
      <View className="flex flex-row items-center gap-3 mt-2">
        <View className="flex flex-row items-center gap-1">
          <View style={{ width: 10, height: 10, borderRadius: 2, borderWidth: 1.5, borderStyle: 'solid', borderColor: BRAND }} />
          <Text className="block text-xs text-muted-foreground">错题</Text>
        </View>
        <View className="flex flex-row items-center gap-1">
          <View style={{ width: 10, height: 10, borderRadius: 2, borderWidth: 1.5, borderStyle: 'solid', borderColor: '#9CA3AF', opacity: 0.6 }} />
          <Text className="block text-xs text-muted-foreground">未收录（长按添加）</Text>
        </View>
      </View>
    </View>
  )
}
