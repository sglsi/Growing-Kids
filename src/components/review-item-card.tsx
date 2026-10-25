import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Image as ImageIcon, Ellipsis } from 'lucide-react-taro'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CheckDot } from '@/components/selection-bar'
import { getSubjectColor, itemStatus, truncate, formatDate } from '@/types'
import type { TimelineItem, ErrorAnalysis } from '@/types'
import { BRAND_TEXT } from '@/lib/theme'

/**
 * 错因类型 → 角标配色（与详情页红橙色系呼应，但按错因语义分色，便于列表一眼分拣）
 * 粗心类用琥珀、概念混用紫、审题偏用橙、步骤错用蓝、未作答/未判分用灰、未知用玫红
 */
const ERROR_ANALYSIS_BADGE: Record<ErrorAnalysis['type'], string> = {
  'no-answer': 'bg-gray-50 text-gray-600 border-gray-200',
  unscored: 'bg-gray-50 text-gray-600 border-gray-200',
  'careless-sign': 'bg-amber-50 text-amber-700 border-amber-200',
  'careless-calc': 'bg-amber-50 text-amber-700 border-amber-200',
  'concept-mix': 'bg-purple-50 text-purple-700 border-purple-200',
  misread: 'bg-orange-50 text-orange-700 border-orange-200',
  'method-step': 'bg-blue-50 text-blue-700 border-blue-200',
  unknown: 'bg-rose-50 text-rose-700 border-rose-200',
}

interface Props {
  item: TimelineItem
  showSubject?: boolean
  /** 选择态：显示勾选圈，点击为切换选择 */
  selecting?: boolean
  checked?: boolean
  onOpen?: (item: TimelineItem) => void
  onLongPress?: (item: TimelineItem) => void
  /** 点击学科徽章时触发（用于「最近题目」里手动改分类）；不传则徽章不响应点击 */
  onChangeSubject?: (item: TimelineItem) => void
  /** 点击「更多」时触发（用于对已加入的资料再做裁剪 / 智能高清 / 去手写等）；不传则不显示「更多」 */
  onMore?: (item: TimelineItem) => void
  /**
   * 点击列表里的**图片**时触发（思傅 2026-10-21 规则）：
   * 点图片 = 直接打开该图片并可编辑；点其他区域才进详情。
   * @param kind 'item' = 图片条目自身的图；'questionImage' = 题目条目的题面图
   */
  onTapImage?: (item: TimelineItem, url: string, index: number, kind: 'item' | 'questionImage') => void
  /**
   * 点击「＋ 填答案 / 改答案」时触发（思傅 2026-10-21）。
   * 不传则不显示按钮。点击后由**调用方**拉起答案面板，且必须把 item 传进去 ——
   * 面板所有写入都按 item.id 定位，答案内嵌在该题目记录里，不会挂到别的题。
   */
  onAnswer?: (item: TimelineItem) => void
  /** 复习本里展示「加入时间」而非创建时间 */
  timeField?: 'created_at' | 'added_to_review_at'
}

/**
 * 统一条目卡片：同时适配 kind=question 与 kind=image
 * 替换旧的 QuestionCard（旧组件仅支持题目）
 */
export default function ReviewItemCard({
  item, showSubject = true, selecting = false, checked = false,
  onOpen, onTapImage, onLongPress, timeField = 'created_at', onChangeSubject, onMore, onAnswer,
}: Props) {
  const color = getSubjectColor(item.subjects?.color)
  const subjectName = item.subjects?.name || '未分类'
  const status = itemStatus(item)

  const handleClick = () => {
    if (selecting) {
      onOpen?.(item)
      return
    }
    onOpen?.(item)
  }

  const goDetail = () => Taro.navigateTo({ url: `/pages/detail/index?id=${item.id}` })
  const open = onOpen || (() => goDetail())

  const time = formatDate((timeField === 'added_to_review_at' ? item.added_to_review_at : item.created_at) || '')

  // 「更多」按钮（非选择态且有回调时显示）
  const moreBtn = onMore && !selecting ? (
    <View
      className="w-8 h-8 flex items-center justify-center"
      onClick={(e) => { e.stopPropagation?.(); onMore(item) }}
    >
      <Ellipsis size={18} color="#9A948A" />
    </View>
  ) : null

  // ---------- 图片条目：缩略图卡片 ----------
  if (item.kind === 'image') {
    const thumb = item.thumb_url || item.url || ''
    return (
      <Card
        className={`rounded-2xl border-border overflow-hidden ${checked ? 'border-primary' : ''}`}
        onClick={handleClick}
        onLongPress={() => onLongPress?.(item)}
      >
        <View className="flex flex-row">
          {selecting && (
            <View className="pl-3 flex items-center">
              <CheckDot checked={!!checked} size={20} />
            </View>
          )}
          <View className={`w-2 self-stretch ${color.bar}`} />
          <View className="flex-1 p-4 flex flex-row gap-3">
          {/* 点缩略图 = 打开该图片（可编辑）；点卡片其余区域 = 进详情 */}
          <View
            className="w-20 h-24 flex-shrink-0 overflow-hidden rounded-lg bg-muted"
            onClick={(e) => {
              e.stopPropagation?.()
              if (onTapImage) onTapImage(item, thumb, 0, 'item')
              else if (thumb) Taro.previewImage({ current: thumb, urls: [thumb] })
            }}
          >
            {thumb ? (
              <Image src={thumb} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
            ) : (
              <View className="w-full h-full flex items-center justify-center">
                <ImageIcon size={22} color="#aaa" />
              </View>
            )}
          </View>
            <View className="flex-1 min-w-0">
              <View className="flex flex-row items-center justify-between">
                <View className="flex flex-row items-center gap-2 mb-1">
                  {showSubject && (
                    onChangeSubject ? (
                      <View onClick={(e) => { e.stopPropagation?.(); onChangeSubject(item) }}>
                        <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                          {subjectName} ›
                        </Badge>
                      </View>
                    ) : (
                      <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                        {subjectName}
                      </Badge>
                    )
                  )}
                  {item.in_review_book && (
                    <Badge className="bg-brand-soft text-brand-text border border-brand-line rounded-full px-2 py-0 text-xs">
                      复习本
                    </Badge>
                  )}
                </View>
                {moreBtn}
              </View>
              <Text className="block text-sm text-foreground leading-relaxed">
                {truncate(item.title || '图片资料', 24)}
              </Text>
              <Text className="block text-xs text-muted-foreground mt-1">{time}</Text>
            </View>
          </View>
        </View>
      </Card>
    )
  }

  // ---------- 题目条目：学科色条 + 题干 + 答案摘要 ----------
  const c = item.content || {}
  // 错因角标：草稿/题目卡一眼看出错因分类（详情页也有完整分析）
  const ea = c.error_analysis
  const eaBadgeCls = ea?.type ? ERROR_ANALYSIS_BADGE[ea.type] ?? ERROR_ANALYSIS_BADGE.unknown : null
  return (
    <Card
      className={`rounded-2xl border-border overflow-hidden ${checked ? 'border-primary' : ''}`}
      onClick={handleClick}
      onLongPress={() => onLongPress?.(item)}
    >
      <View className="flex flex-row">
        {selecting && (
          <View className="pl-3 flex items-center">
            <CheckDot checked={!!checked} size={20} />
          </View>
        )}
        <View className={`w-2 self-stretch ${color.bar}`} />
        <View className="flex-1 p-4">
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center gap-2">
              {showSubject && (
                onChangeSubject ? (
                  <View onClick={(e) => { e.stopPropagation?.(); onChangeSubject(item) }}>
                    <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                      {subjectName} ›
                    </Badge>
                  </View>
                ) : (
                  <Badge variant="outline" className={`${color.badge} border rounded-full px-2 py-0 text-xs`}>
                    {subjectName}
                  </Badge>
                )
              )}
              {status === 'pending' && (
                <Badge className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0 text-xs">
                  待找答案
                </Badge>
              )}
              {item.mastered && (
                <Badge className="bg-emerald-600 text-emerald-50 border border-emerald-600 rounded-full px-2 py-0 text-xs">
                  已掌握
                </Badge>
              )}
              {item.in_review_book && timeField === 'created_at' && (
                <Badge className="bg-brand-soft text-brand-text border border-brand-line rounded-full px-2 py-0 text-xs">
                  复习本
                </Badge>
              )}
              {eaBadgeCls && ea?.label && (
                <Badge className={`${eaBadgeCls} border rounded-full px-2 py-0 text-xs`}>
                  {ea.label}
                </Badge>
              )}
              {/* P3：规范题号标签（节·小类 题号）——复习本/错题库列表唯一指认题目 */}
              {c.question_label ? (
                <Badge className="border border-brand-line bg-brand-soft text-brand-text rounded-full px-2 py-0 text-xs">
                  {c.question_label}
                </Badge>
              ) : null}
            </View>
            <View className="flex flex-row items-center gap-1 shrink-0">
              <Text className="block text-xs text-muted-foreground">{time}</Text>
              {moreBtn}
            </View>
          </View>

          <Text className="block text-sm text-foreground leading-relaxed mb-2">
            {truncate(c.question || '', 80) || '（图片题目）'}
          </Text>

          {c.answer ? (
            <View className="flex flex-row items-start gap-2 bg-muted bg-opacity-60 rounded-lg p-2">
              <Text className="block text-xs font-medium shrink-0 pt-1 text-brand-text">正确答案</Text>
              <Text className="block flex-1 text-xs leading-relaxed text-brand-text">
                {truncate(c.answer, 60)}
              </Text>
              {onAnswer && !selecting ? (
                <View
                  className="shrink-0 px-2 py-1 rounded-lg bg-brand-soft"
                  onClick={(e) => { e.stopPropagation?.(); onAnswer(item) }}
                >
                  <Text className="block text-xs" style={{ color: BRAND_TEXT }}>改答案</Text>
                </View>
              ) : null}
            </View>
          ) : onAnswer && !selecting ? (
            <View className="mt-1 flex flex-row">
              <View
                className="px-2 py-1 rounded-lg border"
                style={{ borderColor: 'rgba(16, 185, 129, 0.25)', backgroundColor: 'rgba(16, 185, 129, 0.08)' }}
                onClick={(e) => { e.stopPropagation?.(); onAnswer(item) }}
              >
                <Text className="block text-xs" style={{ color: BRAND_TEXT }}>＋ 填答案</Text>
              </View>
            </View>
          ) : null}

          {/* ⭐ 题目附图必须在这里渲染（思傅 2026-10-21）：
              此前只认 content.images(image_urls)，而错题提取的裁剪图存在
              **question_images** ⇒ 图确实存进题里了，首页列表却只显示文字。
              点缩略图看大图（stopPropagation 避免误触发进详情）。 */}
          {(item.question_image_urls?.length || item.answer_image_urls?.length) ? (
            <View className="flex flex-row flex-wrap gap-2 mt-2">
              {(item.question_image_urls || []).map((u, i) => (
                <View
                  key={`q${i}`}
                  className="w-16 h-16 rounded-lg overflow-hidden"
                  onClick={(e) => {
                    e.stopPropagation?.()
                    if (onTapImage) onTapImage(item, u, i, 'questionImage')
                    else Taro.previewImage({ urls: item.question_image_urls || [], current: u })
                  }}
                >
                  <Image src={u} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                </View>
              ))}
              {(item.answer_image_urls || []).map((u, i) => (
                <View
                  key={`a${i}`}
                  className="w-16 h-16 rounded-lg overflow-hidden"
                  style={{ position: 'relative' }}
                  onClick={(e) => {
                    e.stopPropagation?.()
                    Taro.previewImage({ urls: item.answer_image_urls || [], current: u })
                  }}
                >
                  <Image src={u} mode="aspectFill" style={{ width: '100%', height: '100%' }} />
                  <View style={{ position: 'absolute', left: 0, bottom: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.45)' }}>
                    <Text style={{ fontSize: 8, color: '#fff', textAlign: 'center' }}>答案</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {open !== goDetail && item.image_urls?.length ? (
            <Text className="block text-xs text-muted-foreground mt-2">含 {item.image_urls.length} 张图片</Text>
          ) : null}
        </View>
      </View>
    </Card>
  )
}
