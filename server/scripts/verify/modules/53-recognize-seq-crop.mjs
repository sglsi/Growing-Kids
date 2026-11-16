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

export default m
