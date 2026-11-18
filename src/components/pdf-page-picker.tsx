import { View, Text, ScrollView, Image as TaroImage } from '@tarojs/components'
import { Crop, X } from 'lucide-react-taro'
import { INK, BRAND, BRAND_FOREGROUND } from '@/lib/theme'

/**
 * 资料库 PDF 页缩略图选择器（D-085）。
 *
 * 为什么不再用 showActionSheet 列页码：
 *  - 答案常常跨 2~3 页，用户「不知道要裁的解答在第几页」，纯文字页码只能靠猜，
 *    选错就要退出重来一遍（重新选文件 → 重新选页）；
 *  - 一屏缩略图能直接看出内容在哪一页，点图即进裁剪；
 *  - 裁完一张后自动回到本面板，用户可以接着选下一页，不必重新走「添加文件」流程。
 *
 * 面板只做选择，不写库；裁剪与入库仍由 answer-editor 负责。
 */

export interface PdfPageItem {
  /** 1 起页码 */
  index: number
  url: string
}

/** 按题号定位的命中信息（来自 locateQuestions 的归一化框） */
export interface PdfPageHit {
  label: string
  rect: { x: number; y: number; w: number; h: number } | null
}

interface Props {
  visible: boolean
  /** 资料名，仅用于标题 */
  docName?: string
  pages: PdfPageItem[]
  /** 本次会话已经加入答案的页数（提示用户还能继续选） */
  addedCount?: number
  /** 题号（有值才显示「按题号定位」） */
  questionLabel?: string
  locating?: boolean
  /** 定位进度文案，如「正在识别第 2/6 页…」 */
  locateHint?: string
  /** pageIndex → 命中信息 */
  hits?: Record<number, PdfPageHit>
  onClose: () => void
  /** 看大图（不裁剪） */
  onPreview: (url: string) => void
  /** 点缩略图 → 进裁剪；rect 为按题号定位得到的预置框 */
  onPick: (page: PdfPageItem, rect: PdfPageHit['rect']) => void
  /** 按题号定位（缺省则不显示该按钮） */
  onLocate?: () => void
}

export default function PdfPagePicker({
  visible, docName, pages, addedCount = 0, questionLabel,
  locating = false, locateHint = '', hits = {},
  onClose, onPreview, onPick, onLocate,
}: Props) {
  if (!visible) return null

  // 3 列网格；高度按行数算，最多显示 2 行再滚动（第 3 行起可滑）
  const rows = Math.ceil(pages.length / 3)
  const bodyH = Math.min(2, Math.max(1, rows)) * 176

  return (
    <View className="fixed inset-0" style={{ zIndex: 250 }}>
      <View
        className="absolute inset-0"
        style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
        onClick={onClose}
      />

      <View
        className="absolute left-0 right-0 bottom-0 rounded-t-2xl"
        style={{ backgroundColor: '#FFFFFF' }}
      >
        {/* 标题行 */}
        <View className="flex flex-row items-center justify-between px-4 pt-4 pb-2">
          <View className="flex-1 min-w-0">
            <Text className="block text-sm font-semibold" style={{ color: INK }}>
              选择要裁剪的页面
            </Text>
            <Text className="block text-xs mt-1" style={{ color: '#8A7F72' }}>
              {docName ? `${docName.slice(0, 18)} · ` : ''}共 {pages.length} 页
              {addedCount > 0 ? ` · 已加入 ${addedCount} 张，可继续选页` : ''}
            </Text>
          </View>
          <View className="px-2 py-1" onClick={onClose}>
            <X size={18} color="#8A7F72" />
          </View>
        </View>

        {/* 按题号定位：只在题目带题号且调用方提供回调时出现 */}
        {questionLabel && onLocate ? (
          <View className="px-4 pb-2">
            <View
              className="w-full h-10 rounded-xl flex flex-row items-center justify-center"
              style={{ backgroundColor: locating ? '#F4F1EA' : BRAND, opacity: locating ? 0.75 : 1 }}
              onClick={() => { if (!locating) onLocate() }}
            >
              <Crop size={13} color={locating ? INK : BRAND_FOREGROUND} />
              <Text
                className="block text-xs ml-1"
                style={{ color: locating ? INK : BRAND_FOREGROUND }}
              >
                {locating
                  ? (locateHint || '正在按题号定位…')
                  : `按题号定位（第 ${questionLabel} 题）`}
              </Text>
            </View>
            <Text className="block text-xs mt-1" style={{ color: '#8A7F72' }}>
              逐页找题号，命中后点该页会直接框好位置；找不到也可直接点缩略图手工框。
            </Text>
          </View>
        ) : null}

        {/* 缩略图网格 */}
        <ScrollView scrollY style={{ height: bodyH }}>
          <View className="flex flex-row flex-wrap px-2 pb-1">
            {pages.map((p) => {
              const hit = hits[p.index]
              return (
                <View
                  key={p.index}
                  style={{ width: '33.333%', padding: 6 }}
                  onClick={() => onPick(p, hit?.rect || null)}
                >
                  <View
                    className="relative rounded-lg overflow-hidden"
                    style={{
                      border: `1px solid ${hit ? BRAND : '#ECE8E0'}`,
                      backgroundColor: '#FAF8F4',
                    }}
                  >
                    <TaroImage
                      src={p.url}
                      mode="aspectFit"
                      style={{ width: '100%', height: 136 }}
                    />
                    {/* 页码 */}
                    <View
                      className="absolute"
                      style={{
                        left: 0, bottom: 0, paddingLeft: 6, paddingRight: 6,
                        paddingTop: 1, paddingBottom: 1,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                        borderTopRightRadius: 6,
                      }}
                    >
                      <Text className="block" style={{ color: '#FFFFFF', fontSize: 10 }}>
                        第 {p.index} 页
                      </Text>
                    </View>
                    {/* 命中徽标 */}
                    {hit ? (
                      <View
                        className="absolute"
                        style={{
                          left: 4, top: 4, paddingLeft: 5, paddingRight: 5,
                          paddingTop: 1, paddingBottom: 1, borderRadius: 6,
                          backgroundColor: BRAND,
                        }}
                      >
                        <Text className="block" style={{ color: BRAND_FOREGROUND, fontSize: 10 }}>
                          {hit.label}
                        </Text>
                      </View>
                    ) : null}
                    {/* 看大图（不裁剪） */}
                    <View
                      className="absolute"
                      style={{
                        right: 4, top: 4, paddingLeft: 5, paddingRight: 5,
                        paddingTop: 2, paddingBottom: 2, borderRadius: 6,
                        backgroundColor: 'rgba(255,255,255,0.9)',
                      }}
                      onClick={(e) => {
                        // 不能冒泡到外层：否则会同时进裁剪器
                        e.stopPropagation()
                        onPreview(p.url)
                      }}
                    >
                      <Text className="block" style={{ color: INK, fontSize: 10 }}>看大图</Text>
                    </View>
                  </View>
                </View>
              )
            })}
          </View>
        </ScrollView>

        <View
          className="w-full flex items-center justify-center"
          style={{ paddingTop: 10, paddingBottom: 22 }}
          onClick={onClose}
        >
          <Text className="block text-xs" style={{ color: '#8A7F72' }}>关闭</Text>
        </View>
      </View>
    </View>
  )
}
