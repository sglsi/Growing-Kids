/**
 * P-033（D）复习队列 —— 一次一题，作答后自动下一题。
 * ------------------------------------------------------------------
 * 起因（实测）：复习作答按钮只在单题详情页（`detail:1138/1143`），
 * 复习本列表卡（`review-item-card`）只有徽标无作答入口。于是「复习 6 题」的
 * 实际操作是：进列表 → 点开一题 → 滚动到复习区 → 点按钮 → 返回 → 下一题，
 * 5 步 × 6 次。这不是意志力问题，是流程结构把执行成本抬高到会放弃的量级
 * （GK-SRS-24 §2.5：坚持不下去＝三个结构漏洞，其中「流程太重」即此项）。
 *
 * 三条设计纪律（都可被断言检查）：
 *   ① **卡上不出现答案与解析**。只显示能辨认「是哪一题」的信息（题号/题干）。
 *      答案不在同一屏，就没有「看着答案点做对了」的路径 —— 这是 M10 / L2
 *      「无提示」的物理保证，不是靠自觉。
 *   ② **作答走既有 `markReviewed`**，不另开写入路径。否则 `review_events`
 *      埋点分叉，「到期首次作答正确率」这个唯一够格指标就断了。
 *   ③ **列表模式始终保留为兜底**。队列只是快路径，中途退出不丢数据：
 *      每答一题就已落库，退出后列表与「今天该复习」数字重新拉取即可。
 *
 * 不做的事：不做智能排序/难度加权（M8 明确不实现自适应）、
 * 不做连续天数与得分（M11 边界）、完成页只陈述「今天完成 N 题」。
 */
import { useState } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '@/components/ui/button'
import { markReviewed, recordMistakeReason, type TimelineItem } from '@/services/api'
import ReviewMistakePicker, { type MistakeChoice } from '@/components/review-mistake-picker'
import { DANGER, BRAND_FOREGROUND, BRAND_TEXT } from '@/lib/theme'
import { hideLoadingSafe } from '@/lib/loading'

interface Props {
  /** 本次要复习的题（调用方按到期升序传入，逾期在前） */
  items: TimelineItem[]
  /** 退出队列（含正常做完与中途退出），回传本次实际作答数，供调用方刷新列表 */
  onExit: (answered: number) => void
  /**
   * P-034 §3.6：按题目 id 预取的「上次错因」label（当场反馈用）。
   * 只传展示文本、不传整段错因对象——作答卡始终不持有提示数据（M73 A6）。
   * 调用方从题目的错因字段投影出 label 后传进来。
   */
  previousReasonLabels?: Record<string, string>
}

/** 从条目里取一句能辨认「是哪一题」的话——只用于辨认，不是答案 */
function titleOf(it: TimelineItem): string {
  const label = (it.content as any)?.question_label
  const q = String((it.content as any)?.question || '').trim()
  if (q) return q.length > 80 ? `${q.slice(0, 80)}…` : q
  if (label) return label
  return it.kind === 'image' ? '图片题（点开详情查看题面）' : '（这道题没有文字题干）'
}

/** 题号徽标（有就显示，纯图题靠它辨认） */
function labelOf(it: TimelineItem): string {
  return String((it.content as any)?.question_label || '')
}

export default function ReviewQueue({ items, onExit, previousReasonLabels }: Props) {
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  /** 本次作答记录：对/错各几道（完成页只陈述事实，不做评价） */
  const [tally, setTally] = useState({ correct: 0, wrong: 0 })
  /**
   * P-034 §3.4：点「做错了」后先进入选错因步骤，null = 正常作答卡。
   * 做对不弹、可跳过——跳过也照常记对错，不阻塞。
   */
  const [pickingFor, setPickingFor] = useState<string | null>(null)

  const total = items.length
  const cur = items[idx]
  const answered = tally.correct + tally.wrong

  /** 真正落库：先记对错（唯一指标来源），再记错因（可选，失败不影响对错） */
  const commitAnswer = async (result: 'correct' | 'wrong', choice: MistakeChoice | null) => {
    if (!cur) return
    setBusy(true)
    try {
      await markReviewed(cur.id, result)
      if (result === 'wrong' && choice) {
        try {
          await recordMistakeReason(cur.id, choice)
        } catch (me) {
          // 错因没存上不影响这次作答已记——但不静默，家长能补
          console.error('错因记录失败（对错已记）', me)
        }
      }
      const nextTally = {
        correct: tally.correct + (result === 'correct' ? 1 : 0),
        wrong: tally.wrong + (result === 'wrong' ? 1 : 0),
      }
      setTally(nextTally)
      setPickingFor(null)
      const next = idx + 1
      if (next >= total) {
        setIdx(total)   // 走到完成页
      } else {
        setIdx(next)
      }
    } catch (e) {
      // 不静默：作答没记上就往下走，会让「今天做了 5 题」与实际不符，
      // 而这个数字是家长判断有没有用的唯一依据（M3：不得只显示已复习次数，
      // 但也不能显示一个错数）。
      console.error('复习记录失败', e)
      Taro.showToast({ title: '没记上，再点一次', icon: 'none' })
    } finally {
      setBusy(false)
      hideLoadingSafe()
    }
  }

  const answer = (result: 'correct' | 'wrong') => {
    if (busy || !cur) return
    if (result === 'wrong') {
      // 只对做错的题问一次；已有错因作为「上次记的」当场反馈，不是本次提示
      setPickingFor(cur.id)
      return
    }
    void commitAnswer('correct', null)
  }

  // ---------- 完成页 ----------
  if (!cur) {
    return (
      <View className="px-4 pt-6">
        <View className="rounded-2xl border border-border p-5">
          <Text className="block text-lg font-semibold text-foreground mb-1">今天完成 {answered} 题</Text>
          <Text className="block text-xs text-muted-foreground mb-4">
            做对 {tally.correct} 题
            {tally.wrong > 0 ? ` · 做错 ${tally.wrong} 题（明天再来）` : ''}
          </Text>
          <Text className="block text-xs text-muted-foreground mb-5">
            {/* 只陈述机制，不做鼓励话术（M7：夸出来的信心不提高表现） */}
            做对的题已经推到下一档，做错的回到明天。下次到期时再来就好，不用今天连着做三遍。
          </Text>
          <Button className="h-10 rounded-xl" onClick={() => onExit(answered)}>
            <Text className="block text-sm" style={{ color: BRAND_FOREGROUND }}>回到复习本</Text>
          </Button>
        </View>
      </View>
    )
  }

  // ---------- 作答页 ----------
  const label = labelOf(cur)
  return (
    <View className="px-4 pt-2">
      {/* 进度：只给位置，不给分数/评级 */}
      <View className="flex flex-row items-center justify-between mb-3">
        <Text className="block text-xs text-muted-foreground">第 {idx + 1} / {total} 题</Text>
        <View onClick={() => onExit(answered)}>
          <Text className="block text-xs" style={{ color: BRAND_TEXT }}>先退出</Text>
        </View>
      </View>

      <View className="rounded-2xl border border-border p-4 mb-4">
        {label ? (
          <Text className="block text-xs mb-2" style={{ color: BRAND_TEXT }}>{label}</Text>
        ) : null}
        <ScrollView scrollY style={{ maxHeight: '46vh' }}>
          <Text className="block text-base text-foreground">{titleOf(cur)}</Text>
        </ScrollView>
        {/*
          ⚠️ 这里刻意不渲染答案、解析、题面图：
          ① 答案在同一屏 ⇒ 可以「看着答案点做对了」，提取就失效了；
          ② 题面图会暴露答案区（错题提取常把题目区与解答区裁在同一图里）。
          要看题面/答案就点退出、进详情——那一步的代价换来的是「这次真的没提示」。
        */}
        <Text className="block text-xs text-muted-foreground mt-3">
          {/* P-034 §3.6 双模式：纸质优先（减孩子屏幕时间），手机口答兜底 */}
          建议在纸上做这题、再回来点结果（少看手机）；来不及就看着题干口答，由家长点结果。答案不在这里。
        </Text>
      </View>

      {/* P-034 §3.4：点「做错了」后才出现的错因选择——作答同屏始终看不到这些 */}
      {pickingFor === cur.id ? (
        <ReviewMistakePicker
          existingLabel={previousReasonLabels?.[cur.id]}
          busy={busy}
          onPick={(choice) => void commitAnswer('wrong', choice)}
        />
      ) : (
        <View className="flex flex-row items-center gap-2">
          <Button
            variant="outline"
            className="h-11 rounded-xl flex-1"
            onClick={() => answer('wrong')}
            disabled={busy}
          >
            <Text className="block text-sm" style={{ color: DANGER }}>{busy ? '记录中…' : '做错了'}</Text>
          </Button>
          <Button
            className="h-11 rounded-xl flex-1"
            onClick={() => answer('correct')}
            disabled={busy}
          >
            <Text className="block text-sm" style={{ color: BRAND_FOREGROUND }}>{busy ? '记录中…' : '做对了'}</Text>
          </Button>
        </View>
      )}

      <Text className="block text-xs text-muted-foreground mt-3">
        做对推进一档（1→3→7→14→28 天），做错回到第 1 档、明天再来。
      </Text>
    </View>
  )
}
