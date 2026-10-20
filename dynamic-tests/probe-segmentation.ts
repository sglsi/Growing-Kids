/**
 * 分段算法验证（两栏试卷 + 三道题）：
 *  - 左栏：第 1 题（3 行）、第 2 题（2 行）
 *  - 右栏：第 3 题（2 行）
 * 期望：XY-Cut 输出顺序为 左栏题1 → 题2 → 右栏题3（**不是** 题1行1 → 题3行1 → … 交错），
 *      且每道题的几行合并成一个段落。
 *
 * 运行（需先编译）：
 *   tsc server/src/ocr/ocr-segment.ts --outDir .tmp/seg --module commonjs --target es2020 --skipLibCheck
 *   node -e "...require('.tmp/seg/ocr-segment.js')..."
 */
// 注意：路径相对**编译产物**（.tmp/probe/）而非源码位置，见文件头运行说明
import { buildSegments, segmentsFromLayoutBlocks, segmentsFromTextRegions } from '../seg/ocr-segment.js'

type Box = [number, number, number, number]

const H = 40 // 行高
const X0 = 50
const X1 = 700 // 右栏起点（栏间沟 600-50-... 足够宽）
const Y = (i: number) => 100 + i * (H + 20)

function line(text: string, x0: number, y: number, w = 400): { text: string; box: Box } {
  return { text, box: [x0, y, x0 + w, y + H] }
}

// 左栏：题1（3 行） + 题2（2 行）；右栏：题3（2 行）
const regions = [
  line('1. 计算下列各题，能简算的要简算。', X0, Y(0)),
  line('（1）25 × 4 ÷ 5', X0, Y(1)),
  line('（2）128 + 72 - 50', X0, Y(2)),
  line('2. 求下图中阴影部分的面积。', X0, Y(3)),
  line('（单位：厘米）', X0, Y(4)),
  line('3. 解方程：3x + 5 = 20', X1, Y(0)),
  line('并检验你的答案。', X1, Y(1)),
]

const blocks = [
  {
    label: 'text',
    bbox: [X0, Y(0), X0 + 400, Y(2) + H],
    order: 1,
    content: '1. 计算下列各题。\n（1）25 × 4 ÷ 5\n2. 求下图中阴影部分的面积。',
  },
  { label: 'image', bbox: [X1, Y(0), X1 + 300, Y(1) + H], order: 2, content: '' },
  { label: 'text', bbox: [X1, Y(3), X1 + 300, Y(4) + H], order: 3, content: '3. 解方程：3x + 5 = 20\n并检验你的答案。' },
]

function report(name: string, segs: ReturnType<typeof buildSegments>, expectedOrder: string[]) {
  console.log(`\n===== ${name} =====`)
  segs.forEach((s, i) => {
    console.log(
      `[${i}] col=${s.col} kind=${s.kind} lines=${s.lines} src=${s.source} box=(${s.box.x0},${s.box.y0})`,
    )
    console.log(`     ${JSON.stringify(s.text)}`)
  })
  // 只比段首前 10 字的前缀（报告里是截断显示的，逐个全等比较没有意义）
  const heads = segs.map((s) => s.text.split('\n')[0].slice(0, 10))
  const ok =
    heads.length === expectedOrder.length &&
    expectedOrder.every((want, i) => heads[i] === want.slice(0, 10))
  console.log(ok ? '✅ 阅读序/分段符合预期' : `❌ 不符合预期\n  实际: ${JSON.stringify(heads)}\n  期望: ${JSON.stringify(expectedOrder)}`)
  return ok
}

// ① 快速通道（XY-Cut）：期望 3 段，顺序 1. → 2. → 3.，且题 1 的 3 行合成一段
const okFast = report('快速通道 XY-Cut', segmentsFromTextRegions(regions as any), [
  '1. 计算下列各题，能简算的要简算。',
  '2. 求下图中阴影部分的面积。',
  '3. 解方程：3x + 5 = 20',
])

// ② 精准通道（版面块）：含题号细分的块被切成 2 段；image 块被剔除
const okLayout = report('精准通道 版面块', segmentsFromLayoutBlocks(blocks as any), [
  '1. 计算下列各题。',
  '2. 求下图中阴影部分的面积。',
  '3. 解方程：3x + 5 = 20',
])

// ③ 统一入口：有块走块，无块走行
const viaBlocks = buildSegments({ regions: regions as any, blocks: blocks as any })
const viaLines = buildSegments({ regions: regions as any, blocks: [] })
const okGate = viaBlocks[0]?.source === 'layout' && viaLines[0]?.source === 'xycut'
console.log(
  `\n===== 统一入口 =====\n` +
    `有 blocks → source=${viaBlocks[0]?.source}（${viaBlocks.length} 段）\n` +
    `无 blocks → source=${viaLines[0]?.source}（${viaLines.length} 段）\n` +
    (okGate ? '✅ 分流正确' : '❌ 分流错误'),
)

const allOk = okFast && okLayout && okGate
console.log(`\n${allOk ? '✅ 全部通过' : '❌ 存在失败项'}`)
process.exit(allOk ? 0 : 1)
