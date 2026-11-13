import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { fetchCurriculumTopics } from '@/services/api'
import { matchCurriculumTags, type CurriculumTopicRow } from '@/lib/curriculum-tags'
import { CURRICULUM_TAG_DISCLAIMER } from '@/constants/curriculum-disclaimer'
import { BRAND_TEXT, INK } from '@/lib/theme'

/**
 * P-028 / D-045 · 参考例题卡片上的「知识点讲解标签」展示层。
 *
 * 🔴 五条硬约束（M44 静态守）：
 *   ① **事先声明常驻且不可关闭** —— 本声明在组件顶部无条件渲染，
 *      用户开关只控制「是否显示标签内容」，不控制声明。
 *   ② **默认关**：`enabled` 初始 false；开关是**组件本地内存态**，
 *      不写 localStorage、不落服务端 ⇒ 不触发 `guardPolicy` / `guardPrivacy`
 *      持久化链路（两道门本身一行未动；将来若要持久化须重过，见 D-045 撤销条件）。
 *   ③ **只展示、不排序**：词典通过独立只读端点获取，本地字面匹配；
 *      不进主检索 result、不进 `note` 判定、不进缓存键、不改变候选集合与顺序，
 *      `CACHE_VERSION` 保持 v14。
 *   ④ **fail-closed**：`available:false` / 请求失败 / 字典为空 ⇒ 不渲染任何标签，
 *      不抛错、不 toast 打扰、不显示「已核实」字样。
 *   ⑤ **不宣称**：一律读作「可能涉及」，不出现「本题知识点 / 课标认定 / 标准答案」。
 *
 * 🔴 只在有参考例题的卡片里挂载（调用方 `hasRefs` 时渲染），不扩大面客范围。
 */
interface Props {
  /** 用户当前题干原文；只用于本地字面匹配，不上传、不入库 */
  stem: string
}

export default function CurriculumTags({ stem }: Props) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [rows, setRows] = useState<CurriculumTopicRow[]>([])
  const [disclaimer, setDisclaimer] = useState(CURRICULUM_TAG_DISCLAIMER)

  useEffect(() => {
    if (!enabled || rows.length > 0 || available === false) return
    let alive = true
    setLoading(true)
    fetchCurriculumTopics()
      .then((d) => {
        if (!alive) return
        setAvailable(!!d?.available)
        setRows(Array.isArray(d?.topics) ? d.topics : [])
        if (d?.disclaimer) setDisclaimer(d.disclaimer)
        setLoading(false)
      })
      .catch(() => {
        // 端点不可用 / 表未上生产：静默降级为「不显示标签」，不吞成成功、不打扰用户
        if (!alive) return
        setAvailable(false)
        setRows([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [enabled, rows.length, available])

  const tags = enabled ? matchCurriculumTags(stem, rows) : []

  return (
    <View className="mb-2 rounded-lg p-2" style={{ borderColor: 'rgba(11,122,85,0.18)', borderWidth: 1, backgroundColor: 'rgba(11,122,85,0.05)' }}>
      {/* 事先声明：常驻，不受开关影响 */}
      <Text className="block text-xs" style={{ color: INK, lineHeight: '1.6' }}>
        {disclaimer || CURRICULUM_TAG_DISCLAIMER}
      </Text>

      {/* 默认关 + 用户开关（本地态） */}
      <View
        className="mt-2"
        onClick={() => setEnabled((v) => !v)}
        style={{ alignSelf: 'flex-start' }}
      >
        <Text className="text-xs" style={{ color: BRAND_TEXT }}>
          {enabled ? '知识点提示：开（点此关闭）' : '知识点提示：关（点此开启）'}
        </Text>
      </View>

      {enabled ? (
        <View className="mt-2">
          {loading ? (
            <Text className="text-xs" style={{ color: INK }}>正在读取知识点字典…</Text>
          ) : available === false ? (
            <Text className="text-xs" style={{ color: INK }}>知识点字典暂不可用，已不显示标签。</Text>
          ) : tags.length === 0 ? (
            <Text className="text-xs" style={{ color: INK }}>题干里没有匹配到字典中的术语，暂不显示标签。</Text>
          ) : (
            tags.map((t) => (
              <View
                key={`${t.subjectName}-${t.term}`}
                className="mb-1 rounded p-2"
                style={{ backgroundColor: '#FFFFFF', borderColor: 'rgba(11,122,85,0.12)', borderWidth: 1 }}
              >
                <Text className="block text-xs font-semibold" style={{ color: BRAND_TEXT }}>
                  可能涉及：{t.term}
                </Text>
                <Text className="block text-xs" style={{ color: INK }}>
                  {t.subjectName} · {t.stage} · {t.domain} / {t.topic}
                </Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  )
}
