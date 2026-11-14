// 模块 48：核心功能回归守卫（D-054）
//
// 守 2026-11-14「先给用户一个能用的小程序」这轮的五类改动，都是改完容易
// 被后续迭代悄悄盖掉的点：
//
// ① 导出带图：OCR 只把题干转成文字，几何图/图表/示意图留在题块照片里。
//    document.service.ts 原先 100% 纯文本（连 ImageRun 都没 import），
//    ocr.service.ts 只认公网 URL，识别页草稿传的是 storage key ⇒ 三条导出
//    路线全部「只有文字」，打印出来孩子没法作答。
// ② 智能高清：默认档是「黑白」且点开即前端整图硬二值化，彩色插图/照片
//    灰阶全丢；结果一键覆盖原图、无对比无撤销。本轮只加护栏不动算法。
// ③ 去手写（功能不完善）与资料库搜题（成熟度不足）入口收起，实现保留。
// ④ 学习手册页注册与入口（原拟名「功能一览」，按内容实质改名）。
//
// 🔴 本模块只守静态契约，不碰判定层、不宣称任何效果。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M48', '核心功能回归守卫：导出带图 / 高清护栏 / 入口收起 / 学习手册（D-054）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const DOC_SVC = 'server/src/document/document.service.ts'
const PDF_SVC = 'server/src/pdf/pdf.service.ts'
const OCR_SVC = 'server/src/ocr/ocr.service.ts'
const IMG_SVC = 'server/src/image/image.service.ts'
const IMG_CTRL = 'server/src/image/image.controller.ts'
const EDITOR = 'src/components/image-editor.tsx'
const ANSWER_EDITOR = 'src/components/answer-editor.tsx'
const INDEX = 'src/pages/index/index.tsx'
const SUBJECT = 'src/pages/subject/index.tsx'
const RECOGNIZE = 'src/pages/recognize/index.tsx'
const PROFILE = 'src/pages/profile/index.tsx'
const CONFIG = 'src/app.config.ts'
const GUIDE = 'src/pages/guide/index.tsx'

// ---------- A 导出必须带图 ----------
m.test('A1 汇总 Word 导出嵌入题面图（不再 100% 纯文本）', (c) => {
  const d = read(DOC_SVC)
  c.ok(d.includes('ImageRun'), 'document.service.ts 必须 import ImageRun')
  c.ok(d.includes('imageParagraphs'), '必须调用图片段落生成')
  c.ok(d.includes('question_images') && d.includes('answer_images'), 'RawRow 必须声明两类图片字段')
  c.ok(d.includes('StorageService') && d.includes('readObject'), '必须走服务端直读，避免回环地址 404')
  c.ok(d.includes('type: img.type'), 'ImageRun 必须显式传 type，否则 Word 里图裂')
})

m.test('A2 答案图只在 include_answers 卷里出现', (c) => {
  const d = read(DOC_SVC)
  const withAnswers = d.indexOf('const withAnswers = params.include_answers === true')
  const answerImages = d.indexOf('const answerImageKeys')
  c.ok(withAnswers > 0 && answerImages > withAnswers, '答案图读取必须在 withAnswers 判定之后')
  c.ok(d.indexOf('questionImageKeys') < withAnswers, '题面图须在 withAnswers 之前，不受 include_answers 影响')
})

m.test('A3 复习本合成：纯文字题不再 400，题干作为文本块入列', (c) => {
  const p = read(PDF_SVC)
  c.ok(p.includes('#t-stem'), '无题面图时必须有题干文本块')
  c.ok(p.includes('qImages.length'), '有题面图时优先嵌图')
  c.ok(p.includes('aImages'), '含答案卷须带答案图')
  c.ok(p.includes('练习卷不带') || p.includes('答疑解惑'), '答案图不得进纯练习卷')
})

m.test('A4 识别页「另存 Word」把题面图 key 传给后端', (c) => {
  const r = read(RECOGNIZE)
  const o = read(OCR_SVC)
  c.ok(r.includes('images: [...(d.question_image_keys'), '识别页必须把 question_image_keys 填进 images')
  c.ok(o.includes('readObject(u)') || o.includes('readObject('), '后端 fetchDocxImage 必须支持 storage key')
  c.ok(o.includes('isUrl'), '公网 URL 分支仍须保留（#150 手动裁剪图）')
})

// ---------- B 智能高清护栏 ----------
m.test('B1 默认档是「原图（不处理）」，不再点开即黑白', (c) => {
  const e = read(EDITOR)
  c.ok(/useState<'original' \| 'enhance'[^>]*>\('original'\)/.test(e), 'activeMode 默认值必须是 original')
  c.ok(!e.includes("void pickEnhanceModeLocal('bw')"), '不得再自动出黑白预览')
  c.ok(e.includes("setActiveMode('original')"), 'dispatchAi 打开面板时必须置为 original')
})

m.test('B2 预览/成品输出为 PNG，避免二值图 JPEG 振铃', (c) => {
  const e = read(EDITOR)
  c.ok(e.includes("fileType: 'png'"), '本地预览须无损输出')
  c.ok(e.includes('PNG 无损'), '改动理由须写在代码里')
  // 裁剪/旋转的 exportEdited() 仍用 jpg q0.95（有意修改、与本轮无关），
  // 故只允许存在 1 处；若预览输出再加回 jpg 就会变成 2 处而被拦下。
  c.eq((e.match(/quality: 0\.95/g) || []).length, 1, '仅裁剪导出保留 jpg q0.95')
})

m.test('B3 破坏性参数已收敛（低风险加护栏，不改算法）', (c) => {
  const e = read(EDITOR)
  c.ok(e.includes('const GAIN_MAX = 2.0'), '光照增益上限 3.5 → 2.0')
  c.ok(e.includes('normalizeIllumination(d, w, h, 0.5)'), '归一化强度 0.9 → 0.5')
  c.ok(e.includes('Math.min(0.6, 0.15 + slider * 0.45)'), '锐化上限 1.65 → 0.6')
  c.ok(e.includes('stretchPercentileGray(g, n, 0.02, 0.98)'), '分位拉伸回到保守区间')
})

m.test('B4 黑白模式需二次确认，且 OCR 校验失败回退原图', (c) => {
  const e = read(EDITOR)
  const s = read(IMG_SVC)
  c.ok(e.includes('黑白模式会丢失颜色'), '显式选黑白也要说清代价')
  c.ok(s.includes('一致性校验失败，回退原图'), '校验失败不得放行未经验证的处理图')
  c.ok(s.includes('return { accept: false, verified: false'), 'catch 必须 fail-closed')
})

m.test('B5 高清结果不覆盖原图', (c) => {
  for (const [name, f] of [['首页', INDEX], ['复习本', SUBJECT]]) {
    const s = read(f)
    c.ok(s.includes("purpose: 'save'") && s.includes('saveQuestionAsImage'), `${name}：增强结果须另存新条目`)
    c.ok(s.includes("confirmText=\"另存为新图片\""), `${name}：按钮文案不得再承诺替换原图`)
    c.ok(s.includes("editorAction === 'enhance' || editorAction === 'auto'"), `${name}：仅增强类动作另存`)
  }
})

// ---------- C 入口收起 ----------
m.test('C1 去手写入口三处收起（实现保留）', (c) => {
  for (const [name, f] of [['首页', INDEX], ['复习本', SUBJECT], ['图片编辑器', EDITOR]]) {
    const s = read(f)
    c.ok(!s.includes("{ action: 'erase', label: '去手写'") && !s.includes("{ action: 'erase_v2', label: '去手写'"),
      `${name}：不得渲染去手写按钮`)
  }
  c.ok(read(IMG_CTRL).includes('erase_v2: false'), 'capabilities 不得再声明去手写可用')
})

m.test('C2 资料库搜题保留开关且当前关闭', (c) => {
  const a = read(ANSWER_EDITOR)
  c.ok(a.includes('const KB_SEARCH_ENABLED = false'), '成熟度不足 ⇒ 开关必须为 false')
  c.ok(a.includes('{KB_SEARCH_ENABLED && ('), '按钮必须受开关包裹，实现不得删')
  c.ok(a.includes('T0 硬门未过') && a.includes('review_events 仍 0 行'), '关闭理由须写在代码里，避免后人误开')
})

// ---------- D 学习手册 ----------
m.test('D1 学习手册页已注册且有入口', (c) => {
  c.ok(read(CONFIG).includes("'pages/guide/index'"), 'app.config.ts 须注册路由')
  c.ok(read(PROFILE).includes("url: '/pages/guide/index'"), '我的页须有入口')
  c.ok(fs.existsSync(path.join(ROOT, GUIDE)), '页面文件须存在')
})

m.test('D2 学习手册内容覆盖四段方法说明与功能一览', (c) => {
  const g = read(GUIDE)
  c.ok(g.includes('学习手册'), '页面标题须为「学习手册」')
  for (const key of ['收拢起来', '过几天再做一次', '错题为什么要改', '记录与回顾', '功能一览']) {
    c.ok(g.includes(key), `缺少章节：${key}`)
  }
  c.ok(g.includes('不对学习效果或成绩作任何承诺'), '必须写明不承诺效果（合规定位）')
  c.ok(!g.includes('navigateTo') && !g.includes('request('), '纯静态页：无跳转、无网络请求')
})

export default m
