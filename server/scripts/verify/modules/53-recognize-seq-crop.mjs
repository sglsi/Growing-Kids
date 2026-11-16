// 模块 53：错题提取「按题号裁剪题目区/解答区」（P-031 / D-069）
//
// 🔴 本模块只守静态契约，不连数据库、不连微信、不碰判定层。
//    「候选框准不准」「真机能不能裁出图」「解答区归属对不对」必须由实测证明，
//    静态守卫不得被当作已验证的证据（P-031 ⑥ 明确写了不宣称准确率）。
//
// 思傅 11-16 五问拍板：
//  Q1 改造现有「错题提取」入口（与「拍照识别」并列）｜Q2 A 只存图片｜
//  Q3 B 候选框 + 逐题确认｜Q4 C 定位不到给整页框让用户手工框｜Q5 A 单图/单份文档。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M53', '错题提取按题号裁剪题目区/解答区（P-031）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const LOC = 'src/lib/question-locate.ts'
const FE = 'src/pages/recognize/index.tsx'
const EDITOR = 'src/components/image-editor.tsx'
const API = 'src/services/api.ts'
const OCR_SVC = 'server/src/ocr/ocr.service.ts'
const OCR_CTRL = 'server/src/ocr/ocr.controller.ts'
const TL_SVC = 'server/src/timeline/timeline.service.ts'
const MATCH = 'server/src/shared/question-match.ts'

m.test('A1 定位算法是零依赖纯函数（可离线执行）', (c) => {
  c.ok(exists(LOC), 'question-locate.ts 缺失')
  const s = read(LOC)
  c.ok(!/^\s*import\s/m.test(s), '不得 import 任何模块（要保持纯函数可离线执行）')
  c.ok(!s.includes('@tarojs'), '不得依赖 Taro（注释里提到名字不算，import 才算）')
  c.ok(!s.includes("'@/"), '不得使用 @/ 别名（离线执行解析不了）')
  c.ok(s.includes('export function locateQuestions'), '须导出 locateQuestions')
  c.ok(s.includes('export function parseSeqSpec'), '须导出 parseSeqSpec')
})

m.test('A2 题号表达式：区间 / 全角 / 去重 / 上限', (c) => {
  const s = read(LOC)
  c.ok(/\[-~～\]/.test(s), '须支持 8-12 / 8~12 区间')
  c.ok(s.includes('[,，、;；'), '须支持全角逗号/顿号/分号分隔')
  c.ok(s.includes('new Set<number>()'), '须去重')
  c.ok(s.includes('> 60'), '须有单次题数上限（防 1-300 生成 300 张图）')
  c.ok(s.includes('b - a + 1 > 60'), '区间跨度也须设上限')
})

m.test('A3 半角小数不得被当成题号（D-049 的坑不能重犯）', (c) => {
  const s = read(LOC)
  c.ok(s.includes('(?!\\d)'), '须用 (?!\\d) 排除 `1.5` 这类小数')
  c.ok(s.includes('RE_带分隔符'), '须有带分隔符的题号正则')
  c.ok(s.includes('半角'), '须留注释说明为什么排除小数')
})

m.test('A4 定位不到不猜坐标（Q4=C：给整页框让用户手工框）', (c) => {
  const s = read(LOC)
  c.ok(s.includes('located: !!hit') || s.includes('located: false'), '须显式标记未定位')
  c.ok(s.includes('stemRect: { x: 0, y: 0, w: 1, h: 1 }'), '未定位须退回整页候选，不得借用相邻题区间')
  c.ok(s.includes('answerRect: null'), '未定位时解答区必须为空')
  c.ok(s.includes('D-020') || s.includes('不借用'), '须在注释里点明「不拿相邻题顶替」')
})

m.test('A5 解答区只做候选：有标记才有框', (c) => {
  const s = read(LOC)
  c.ok(s.includes('isSolutionStart'), '须有解答标记识别')
  c.ok(s.includes('答案|解析|解答'), '解答标记须覆盖【答案】【解析】等写法')
  c.ok(s.includes('solPx === null ? null :'), '没有解答标记时必须返回 null（只存题目区）')
})

m.test('A6 裁剪器支持预置候选框（Q3=B 的落地前提）', (c) => {
  const s = read(EDITOR)
  c.ok(s.includes('initialCrop?: Rect'), '须新增 initialCrop prop')
  c.ok(s.includes('cropKey?: string'), '须新增 cropKey（同图连裁多题时复位）')
  c.ok(s.includes('clampCrop(initialCrop)'), '预置框必须过 clampCrop 收敛，不信任外部传值')
  c.ok(s.includes('}, [visible, src, cropKey])'), 'useEffect 依赖须含 cropKey，否则沿用上一题的框')
})

m.test('A7 页面接入：改造现有错题提取入口，只存图片', (c) => {
  const s = read(FE)
  c.ok(s.includes('按题号提取'), '须新增「按题号提取」区块')
  c.ok(s.includes('parseSeqSpec') && s.includes('locateQuestions'), '须接入定位纯函数')
  c.ok(s.includes('initialCrop={'), '须把候选框传给裁剪器')
  c.ok(s.includes('cropKey={`p031-'), '须传稳定 cropKey')
  c.ok(s.includes('只存图片'), '须明示「只存图片」口径')
  c.ok(/text: '',\s*\n\s*images:/.test(s) || s.includes("// Q2=A：只存图片，题干文本留空"), 'Q2=A：题干文本必须留空')
  c.ok(s.includes('answerImages'), 'BoardEntry 须支持解答图')
  c.ok(s.includes("purpose: 'attach'"), '裁出的图须以 attach 上传（不建条目）')
})

m.test('A8 落库：题目图与解答图分开写', (c) => {
  const s = read(FE)
  c.ok(s.includes('question_images: e.images.map'), '题目图须写 question_images')
  c.ok(s.includes('answer_images: e.answerImages'), '解答图须写 answer_images')
  c.ok(s.includes('(e.answerImages?.length ?? 0) > 0'), '空解答不得写入空数组')
  c.ok(s.includes('seqRows.filter((r) => r.stem)'), '题目区为必需（只有解答图的条目不提交）')
})

m.test('A9 文档：PDF 出页图，Word/TXT 明确拒绝', (c) => {
  const svc = read(OCR_SVC)
  c.ok(svc.includes('async docPages('), '须有 docPages 方法')
  c.ok(svc.includes('minText: 999999999'), '须强制每页渲染（含纯文字层页面）')
  c.ok(svc.includes('没有页图'), 'Word/TXT 须明确拒绝并提示')
  const ctrl = read(OCR_CTRL)
  c.ok(/@Post\('doc-pages'\)/.test(ctrl), '须暴露 POST /api/ocr/doc-pages')
  c.ok(!ctrl.includes('PUBLIC_ROUTES'), '不得做成免登录端点')
  const api = read(API)
  c.ok(api.includes("'/api/ocr/doc-pages'"), '前端 API 须封装 doc-pages')
})

m.test('A10 题干校验放宽，但双空仍然拒绝', (c) => {
  const s = read(TL_SVC)
  c.ok(s.includes('hasQuestionText') && s.includes('hasQuestionImage'), '须区分「有文本」与「有题面图」')
  c.ok(s.includes('!hasQuestionText && !hasQuestionImage'), '两者都空时必须仍然拒绝（防复习本空白卡片）')
  c.ok(s.includes('question_images'), '题面图判据须取 question_images')
})

m.test('A11 判定层不得被牵连', (c) => {
  const s = read(MATCH)
  c.ok(!s.includes('locateQuestions'), '判定层不得引入题号定位（P0 六条硬闸一行未动）')
  c.ok(!s.includes('parseSeqSpec'), '判定层不得引入题号表达式解析')
  c.ok(s.includes('MATCH_MIN_SOLUTION_CHARS = 8'), '相邻解析段 ≥8 字判据必须原样保留')
  const fe = read(FE)
  c.ok(!fe.includes('question-match'), '前端不得直接引用判定层文件')
})

m.test('A12 按题号定位自动 OCR，不得把识别变成用户前置步骤', (c) => {
  const fe = read(FE)
  // 思傅 11-16 反馈：输入题号后不该让用户自己去点 OCR
  c.ok(!fe.includes('请先对本页做一次识别'), '不得再要求用户先去点识别')
  c.ok(!fe.includes('先在上方来源页做一次识别'), '提示文案不得把 OCR 写进用户流程')
  c.ok(fe.includes('const handleLocateBySeq = async'), '定位须为异步：内部先补齐段落再定位')
  c.ok(fe.includes('正在识别页面文字'), '自动识别须有等待反馈')
  // runPageOcr 必须把结果回给调用方：setState 异步，定位不能读上一帧 boardPages
  c.ok(/Promise<\{\s*segments: PageTextSegment\[\]/.test(fe), 'runPageOcr 须返回刚识别出的段落')
  c.ok(/const r = await runPageOcr\(page, 'fast'\)/.test(fe), '定位缺段落时须自动跑快速识别')
  c.ok(fe.includes('segments: r.page_text'), 'runPageOcr 须把段落一并返回')
})

m.test('A13 题号输入框须显式约束宽度（否则文字压到按钮上）', (c) => {
  const fe = read(FE)
  c.ok(!fe.includes('className="flex-1 text-sm"'), '原生 input 不得只靠 flex-1（默认宽度按整行解析）')
  c.ok(fe.includes("width: '100%', height: 34, minHeight: 34, fontSize: 14, lineHeight: '34px'"), '输入框须显式宽高与行高')
  c.ok(/minWidth: 0/.test(fe), '外层容器须 minWidth: 0 才能被 flex 收窄')
  c.ok(fe.includes('overflow: \'hidden\'') || fe.includes("overflow: 'hidden'"), '容器须裁剪溢出')
})

m.test('A14 候选框精度：末题不得框到页底、x 不得恒为整宽（P-031 r2）', (c) => {
  const s = read(LOC)
  // 思傅 11-16 真机测试：3 个题号里 1 个位置不准 ⇒ 真实样本实测出两个必然缺陷：
  //   末题无下一锚点 ⇒ 一路框到页底（占页 70%）；框恒为 x=0/w=1 ⇒ 裁进整条空白栏。
  c.ok(!/function band\(/.test(s), '整宽横带写法必须去掉（band 会把 x 写死为 0/1）')
  c.ok(s.includes('function rect('), '须有按像素四边生成矩形、x 也收紧的 rect()')
  c.ok(s.includes('lastY1'), '终点须取自「本题最后一段底边」，不能直接用下一锚点/页底')
  c.ok(/Math\.min\(boundPx, lastY1 \+ padY\)/.test(s), '终点 = min(下一题顶边, 末段底边+半行高)')
  // r3：x 的并集基准从 own 换成 bodyRows（own 含手写区，会把整行宽度撑开）
  // r4：x0/x1 由 const 改为 let —— 归入本题的图形块要能外扩（图形没文字，纯文本框必然切图）
  c.ok(/let x0 = Math\.min\(\.\.\.bodyRows\.map/.test(s) && /let x1 = Math\.max\(\.\.\.bodyRows\.map/.test(s),
    'x 须取本题正文行的并集（左右都收紧）')
  c.ok(s.includes('const body = handPx === null ? own'), '正文行须排除手写/批注区（body）')
  c.ok(s.includes('own = arr.filter'), '本题段落集合须按 [本题顶边, 下一题顶边) 显式圈定')
  // 定位失败要能解释原因，而不是只甩一句「未定位」
  c.ok(s.includes('export function detectedLabels'), '须导出 detectedLabels（本页实际认出的题号）')
  const fe = read(FE)
  c.ok(/detectedLabels\(segs(?:, seqs)?\)/.test(fe), '前端须把本页认出的题号带上')
  c.ok(fe.includes('本页 OCR 只认出题号'), '未定位时须显示「本页认出了哪几题」')
  c.ok(fe.includes('没认出任何题号'), '整页零题号时须给兜底提示')
  c.ok(exists('dynamic-tests/fixtures/page-text-exam.json'), '真实分段样本须固化（防回归靠合成样本自证）')
})

m.test('A15 真机失败样本的三处根因（P-031 r3 / D-069 r3）', (c) => {
  const s = read(LOC)
  // 思傅 11-16 真机：输入 7/14/20 → 7 位置不准、14 与 20 未定位。逐条守住四处根因：
  // ① 13/14 被 XY-Cut 并成一段（段首题号 13）⇒ 必须段内拆行
  c.ok(/function explodeLines/.test(s), '须有段内拆行 explodeLines（合段里的第二题才可能被认出）')
  c.ok(/\.split\('\\n'\)/.test(s), '拆行必须按换行符分（后端 buildSegments 保留了行边界）')
  // ② OCR 吞掉 `14.` 的点（`14如图`）⇒ 定向放宽，但只认用户请求的号
  c.ok(/export function startsWithLabel/.test(s), '须有定向题号匹配 startsWithLabel')
  c.ok(!/RE_带分隔符 = \/\^\\s\*\(\\d\{1,3\}\)\\s\*\?\(\?:\[/.test(s) || !/裸/.test(s),
    '不得把裸题号并进全局 segQuestionNumber（会把手写 35.304 当题号）')
  // ③ 图注 `第14题图` 曾被 RE_第N题 误认成题号锚点（锚点跑到 y=730）
  c.ok(/RE_第N题 = \/\^\\s\*第\\s\*\(\\d\{1,3\}\)\\s\*题\(\?!\\s\*图\)\//.test(s),
    'RE_第N题 必须排除「第N题图」图注（否则图注抢锚点，14 题框从图注开始）')
  // ④ 末题后面跟着手写解答 ⇒ 连续窄行块视为手写区，不许框到页底
  c.ok(/function handwritingStart/.test(s), '须有手写/批注区识别 handwritingStart')
  c.ok(s.includes('run >= 3'), '手写区判据须要求「连续 ≥3 行」（单行窄段是选项/图注/图内标号）')
  c.ok(/RE_选项行/.test(s) && /RE_图注行/.test(s), '选项行与图注行必须排除在手写判据外（否则会把选项、配图裁掉）')
  // 样本固化：没有这张真机图，上面四条都只是纸上断言
  c.ok(exists('dynamic-tests/fixtures/page-text-exam-real.json'), '真机失败样本须固化（7/14/20 三题同页）')
  const fe = read(FE)
  c.ok(fe.includes('detectedLabels(segs, seqs)'), '前端须把本次请求的题号传给 detectedLabels（否则定向补回的 14 不会出现在提示里）')
})

m.test('A16 图形块参与定位（P-031 r4 / D-069 r4）', (c) => {
  const s = read(LOC)
  const seg = read('server/src/ocr/ocr-segment.ts')
  const svc = read('server/src/image/image.service.ts')
  const types = read('server/src/image/image.types.ts')
  const api = read(API)
  const fe = read(FE)

  // 根因：图上没有文字 ⇒ 只吃文字行的定位必然把图切在外面（真机第 20 题平行四边形下半截）
  c.ok(/export function extractFigures/.test(seg), '后端须从版面块提取图形块 extractFigures')
  c.ok(/RE_图注题号/.test(seg), '图注（第N题图）须用于图形归属：真实卷面 16 的图排在 14 正文区间内，只按 y 会归错')
  c.ok(/c\.ok|isFigureTitleLabel/.test(seg) || /isFigureTitleLabel/.test(seg), '须识别 figure_title 版面标签')
  // 图形块不得混进文字分段（会污染段落文本、影响既有消费方）
  c.ok(/isSkippableLabel\(b\.label\)/.test(seg), '图形块不得并入 page_text（文本链路保持原样）')
  // 下发契约 + 缓存键
  c.ok(/page_figures/.test(types), 'OcrPageResult 须声明 page_figures')
  c.ok(/page_figures: pageFigures/.test(svc), 'ocr-page 须下发 page_figures')
  c.ok(/fig-v1/.test(svc), '缓存键须带 fig-v1：否则旧缓存继续命中「没有图形块」的结果，补图永远拿不到东西')
  c.ok(/page_figures: data\?\.page_figures \|\| \[\]/.test(api), '前端 ocrPage 须透传 page_figures（缺省空数组）')

  // 定位：图形归题 + 只外扩
  c.ok(/figures: FigureSeg\[\] = \[\]/.test(s), 'locateQuestions 须接受图形块参数（缺省空 ⇒ 行为与旧版一致）')
  c.ok(/figureTitleLabel/.test(s), '前端须能解析图注题号（纠正「邻题图排在本区间」的误归）')
  c.ok(/figuresByLabel/.test(s), '须按题号归并图形块')
  c.ok(/bestOv/.test(s), '无图注的图须按 y 重叠最大归题，且重叠为 0 时不归（宁漏不误）')
  c.ok(/topOut = Math\.max\(floorY/.test(s), '图排在题干上方时 y0 须能上探，但不得侵入上一题题号行')

  // 前端：两段式（先文字框、再按需补图），补图必须用同一份段落重算
  c.ok(fe.includes('handleFillFigures'), '前端须有「补全图形」入口')
  c.ok(fe.includes('lastLocateRef'), '补图须复用同一次定位的段落（换成精准分段等于偷偷换结果）')
  c.ok(/locateQuestions\(task\.segs, task\.pw, task\.ph, task\.seqs, figs\)/.test(fe), '补图须用同一份段落 + 新图形块重算')
  c.ok(fe.includes('题里有几何图'), '补图入口须有可供家长理解的说明文案')
  // 失败降级：catch 分支不得改框
  const fill = fe.slice(fe.indexOf('const handleFillFigures'), fe.indexOf('const handleFillFigures') + 3000)
  const catchPart = fill.slice(fill.indexOf('} catch (e) {'))
  c.ok(!/setSeqRows/.test(catchPart.slice(0, 400)), '补图失败不得改任何框（fail-closed）')
  // 样本固化
  c.ok(exists('dynamic-tests/fixtures/page-text-exam-real.json'), '真机样本须固化')
  c.ok(exists('dynamic-tests/run-figure-join-p031r4.cjs'), '图形并框须有可复跑的实证脚本')
})

export default m
