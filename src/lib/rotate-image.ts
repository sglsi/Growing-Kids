import Taro from '@tarojs/taro'

/**
 * D-068：把本地图片按 90° **烘焙**成一张新图（返回新的临时文件路径）。
 *
 * 为什么不用 CSS rotate：合成 PDF 时上传的是 `composeItems[i].path` 这个本地文件，
 * 只做显示层旋转不会进入成品。必须真的产出一张方向已改的图。
 *
 * 🔴 坐标口径复用 `components/image-editor.tsx` 已验证过的方案（勿另起一套）：
 *  · Canvas type="2d" 节点；CSS 尺寸 = 本次导出缓冲尺寸（1:1），轮询实测确认；
 *  · 旋转在缓冲中心做，宽高互换，scale(fit) 后按原图像素 1:1 绘制，不裁边；
 *  · 导出用「原点 + 全区域 + 显式 destWidth/destHeight」，对微信
 *    canvasToTempFilePath 的 CSS/缓冲口径歧义免疫（见 image-editor 注释）。
 *
 * 调用方需在页面上挂一个隐藏的 `<Canvas type="2d" id={canvasId}>`，
 * 并把它的 CSS 宽高绑定到 `onSize` 回调返回的尺寸（缓冲与 CSS 必须同步）。
 */
const MAX_SIDE = 1365

/** 每次都重新查当前活跃节点：缓存的引用在多次旋转后可能被回收，表现为「第二次转不动」 */
async function waitCanvasNode(canvasId: string): Promise<any> {
  for (let i = 0; i < 12; i++) {
    const node = await new Promise<any>((resolve) => {
      Taro.createSelectorQuery()
        .select(`#${canvasId}`)
        .fields({ node: true } as any)
        .exec((res) => resolve(res?.[0]?.node || null))
    })
    if (node) return node
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('画布未就绪，请稍后重试')
}

/** 轮询等 CSS 尺寸落地；超时返回实测值，绝不挂起（离屏 canvas 的 rAF 可能被节流） */
async function waitCanvasCss(canvasId: string, targetW: number, targetH: number): Promise<{ w: number; h: number }> {
  let measured = { w: 0, h: 0 }
  for (let i = 0; i < 20; i++) {
    const rect: any = await new Promise((resolve) => {
      Taro.createSelectorQuery()
        .select(`#${canvasId}`)
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

export async function rotateImageFile(
  src: string,
  dir: 1 | -1,
  canvasId: string,
  onSize: (w: number, h: number) => Promise<void>,
): Promise<string> {
  const node: any = await waitCanvasNode(canvasId)

  // 先以解码后的真实尺寸为准（EXIF / getImageInfo 与 Canvas 解码可能不一致），
  // 避免「旋转一次放大一次」的历史坑。
  const img: any = node.createImage ? node.createImage() : null
  if (!img) throw new Error('画布不支持图片解码')
  await new Promise<void>((resolve, reject) => {
    let done = false
    const finish = (err?: boolean) => {
      if (done) return
      done = true
      if (err) reject(new Error('图片加载失败'))
      else resolve()
    }
    img.onload = () => finish(false)
    img.onerror = () => finish(true)
    img.src = src
    setTimeout(() => finish(false), 8000)
  })
  const sw = img.width
  const sh = img.height
  if (!sw || !sh) throw new Error('无法读取图片尺寸')

  const fit = Math.min(1, MAX_SIDE / Math.max(sw, sh, 1))
  const w = Math.max(1, Math.round(sw * fit))
  const h = Math.max(1, Math.round(sh * fit))
  // 90° / 270° 后宽高互换
  const outW = h
  const outH = w

  // 先把 CSS 尺寸同步为缓冲尺寸，再等布局落地（离屏 canvas 的已知坑）
  await onSize(outW, outH)
  const css = await waitCanvasCss(canvasId, outW, outH)

  node.width = outW
  node.height = outH
  const ctx = node.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, outW, outH)

  // 左转 -1 = 顺时针 270°，与通用编辑器 handleRotate(-1) 的 (rotation - 90 + 360) % 360 同义
  const deg = dir === 1 ? 90 : 270
  ctx.save()
  ctx.translate(outW / 2, outH / 2)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.scale(fit, fit)
  ctx.drawImage(img, -sw / 2, -sh / 2)
  ctx.restore()

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
      fail: (err: any) => reject(new Error(err?.errMsg || '旋转导出失败')),
    } as any)
  })
}
