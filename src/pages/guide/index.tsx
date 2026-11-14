import { View, Text, ScrollView } from '@tarojs/components'

/**
 * 学习手册（原拟名「功能一览」，按内容实质改名）。
 *
 * 这一页回答两件事：**为什么这样设计**、**每个功能怎么用**。
 * 内容是 GK-SRS-20a（规范层）/ 20b（证据层）的通俗摘要，不是原文照搬。
 *
 * 合规边界（个人主体 + 教育信息服务类目）：
 *  - 文案保持中性，不写课程化、培训化或结果承诺类的表述（禁用词以 M16 为准）；
 *  - 不宣称任何效果，不作权威背书；
 *  - 不引入拍照搜题形态；全页纯静态、零网络请求、零写操作、零个人信息。
 *
 * 用词约定：讲的是「记录与回顾的习惯」，不是教学方法，也不是学习建议的权威来源。
 */

type Section = {
  heading: string
  lead: string
  paragraphs: string[]
  /** 该节对应的功能名，点到为止，不跳转（避免小程序里多余的路由依赖） */
  related?: string
}

const SECTIONS: Section[] = [
  {
    heading: '一、先把散在纸上的东西收拢起来',
    lead: '卷子、练习册、草稿纸上的题目，当时会做，过两周就找不到了。',
    paragraphs: [
      '拍照是最省事的入口：把纸面上的题目和答案拍下来，识别成可编辑的文字，题目里的图也一起留在这一条记录上。文字可以自己改，数学符号可以补，图形不会被丢掉。',
      '存下来之后按学科、年级、时间归档，需要时按关键词找回来。选几道题就能合成 PDF 或 Word：可以只出题、不带答案，打印出来重新做一遍；也可以连答案和解析一起，用于对答案。',
      '这些动作只做一件事：把原本会散掉、会丢掉的纸面内容，变成以后还能翻出来、还能再用一次的东西。',
    ],
    related: '拍照整理题目 · 图片编辑 · 归档 · 汇总导出',
  },
  {
    heading: '二、为什么要过几天再做一次',
    lead: '「这次做对了」和「过一阵还能做对」，是两件不同的事。',
    paragraphs: [
      '刚看完就重做，靠的往往是短时熟悉；隔一段时间、没有提示、换个情境还能做对，才说明真的留下来了。所以复习不是当天多刷几遍，而是把同一道题分散到不同的日子里。',
      '本小程序把回顾安排在 1、3、7、14、28 天这五个间隔上：做对了就往后推一档，做错了回到第二天重来，五档走完这道题就算告一段落。间隔是固定的，不做智能预测，也不按做题时长或连续天数排名。',
      '重点只在一件事：让该重现的题目，在快忘的时候再出现一次。',
    ],
    related: '题目标记与回顾 · 复习本',
  },
  {
    heading: '三、错题为什么要改，不只是抄下来',
    lead: '把错题抄一遍，通常只记住了「我错过」，没记住「错在哪」。',
    paragraphs: [
      '一条有用的错题记录，除了题目本身，还该留下当时的错误作答、错在哪里、正确做法是什么，以及下一次重做的结果。缺了这些，回头翻到时仍然只能重新想一遍。',
      '所以标记错题之后，真正有用的是按排程回来重做，并记下这次是做对还是又错了。做错的题会回到较近的间隔，做对的才慢慢往后放。错误本身是要被用掉的信息，不是要被收藏的纪念。',
      '这里不提供标准答案，也不代替老师的讲解；答案和解析都由你自己录入、自己核对。',
    ],
    related: '错题标记 · 错因 · 重做记录',
  },
  {
    heading: '四、记录与回顾',
    lead: '学习之外发生过什么，有时恰好是后来想不起来时最需要的线索。',
    paragraphs: [
      '「记忆」里可以记当天的事、心得和感受，按分类、时间、科目、关键词翻看。它不做每日计数、不统计时长、不排名，也不参与任何判定，只是留给以后翻看。',
      '把零散的纸面内容收拢起来、把值得重做的题留下来、把当时的情形记上几句，这三件事合在一起，才让「过一阵再回头看」变成一件真的做得到的事，而不是一句打算。',
    ],
    related: '生活记录 · 资料存储',
  },
  {
    heading: '五、功能一览',
    lead: '按做的事分类，不按页面分类。',
    paragraphs: [
      '拍下来：拍照整理题目，识别成可编辑文字，题图同存，支持数学等特殊符号。',
      '理一理：图片可裁剪、旋转、高清处理、文字识别；默认不改动原图，处理结果另存，原图保留。',
      '收起来：按学科、年级、存储时间归档保存，支持关键词与标签查找。',
      '标一标：重点题、错题加入复习本，按 1/3/7/14/28 天安排回顾，做对做错各记一次。',
      '带出去：选中条目合成 PDF 或 Word，可只生成题目、也可题目与解答合并，便于打印或在别的设备上查看。',
      '存资料：上传并整理各类学习资料，按学科归类，日后查阅。',
      '记生活：日常、心得、感悟分类记录，按时间与关键词翻看。',
    ],
  },
]

export default function GuidePage() {
  return (
    <View className="min-h-screen bg-background">
      <ScrollView scrollY className="h-screen">
        <View className="px-4 py-4 pb-10">
          <Text className="block text-[17px] font-semibold text-foreground">学习手册</Text>
          <Text className="mt-1 block text-[12px] text-muted-foreground">
            为什么这样设计 · 每个功能怎么用
          </Text>

          <View className="mt-4 rounded-2xl border border-border p-4">
            <Text className="block text-[13px] leading-6 text-foreground">
              这本小册子讲的是记录与回顾的习惯：把散在纸上的题目收拢起来，隔些日子再做一次，把做错的地方改明白。
              小程序只提供记录和回顾的工具，不是课程，也不提供讲解答案；所有内容都由你自己录入、自己核对。
            </Text>
          </View>

          {SECTIONS.map((s) => (
            <View key={s.heading} className="mt-5">
              <Text className="block text-[15px] font-semibold text-foreground">{s.heading}</Text>
              <Text className="mt-1 block text-[13px] font-semibold text-foreground">{s.lead}</Text>
              {s.paragraphs.map((p, i) => (
                <Text key={i} className="mt-2 block text-[13px] leading-6 text-foreground">
                  {p}
                </Text>
              ))}
              {s.related && (
                <Text className="mt-2 block text-[12px] text-muted-foreground">对应功能：{s.related}</Text>
              )}
            </View>
          ))}

          <View className="mt-6 rounded-2xl border border-border p-4">
            <Text className="block text-[12px] leading-5 text-muted-foreground">
              这些安排参考了公开的间隔练习与错题重做研究，也做了本项目的取舍；效果因人而异。
              本页只说明工具的用法与设计来由，不代替课堂讲解，不对学习效果或成绩作任何承诺。
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
