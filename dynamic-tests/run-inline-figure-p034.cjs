/**
 * P-034 / D-074 图文混排离线实证（不连数据库、不连微信）
 *
 * 真实转译并执行 `src/lib/question-inline-figure.ts` 的纯函数，断言：
 *  ① [图N] 占位符在有 URL 时被替换成 <img>，无 URL 时原样显示文字（fail-closed）；
 *  ② 转义正确（题干里的 < & " 不能破坏 rich-text 节点树）；
 *  ③ 一个图找不到不拿别的图顶替（归属唯一，槽位严格按 N）；
 *  ④ removeFigureMarker 只删目标标记、不误删 [图10]；
 *  ⑤ 编译产物里详情页确实挂了混排预览 + 加图入口 + 内嵌图保存字段。
 *
 * ⚠️ 只能证明「纯函数 + 编译产物」正确；真机里 rich-text 是否真把图渲染出来、
 *    家长能不能顺利裁剪插入——**都证明不了**，D-074 显式「不宣称真机效果」。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIB = path.join(ROOT, 'src', 'lib', 'question-inline-figure.ts')
const DETAIL_SRC = path.join(ROOT, 'src', 'pages', 'detail', 'index.tsx')
const API_SRC = path.join(ROOT, 'src', 'services', 'api.ts')
const TYPES_SRC = path.join(ROOT, 'src', 'types', 'index.ts')
const BE_TYPES = path.join(ROOT, 'server', 'src', 'timeline', 'timeline.types.ts')
const BE_SVC = path.join(ROOT, 'server', 'src', 'timeline', 'timeline.service.ts')

let pass = 0, fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

console.log('P-034 题干图文混排 · 占位符 ⇄ 真图 实证')

let L = null
try {
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
  const js = ts.transpileModule(fs.readFileSync(LIB, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  const noRequire = (n) => { throw new Error(`question-inline-figure 不应依赖模块：${n}`) }
  new Function('exports', 'module', 'require', js)(mod.exports, mod, noRequire)
  L = mod.exports
  ok(true, '源码可转译执行（零 import）')
} catch (e) {
  ok(false, `源码转译失败：${e.message}`)
}

if (L) {
  const figs = [
    { slot: 1, url: 'https://cdn.example.com/fig1.webp' },
    { slot: 2, url: 'https://cdn.example.com/fig2.webp' },
  ]

  // ① 有 URL → <img>
  const html = L.questionRichHtml('如图 [图1] 求面积，另见 [图2]。', figs)
  ok((html.match(/<img /g) || []).length === 2, '两个有 URL 的标记各换成一个 <img>')
  ok(html.includes('fig1.webp') && html.includes('fig2.webp'), '<img src 指向各自的 URL')
  ok(html.includes('如图 ') && html.includes(' 求面积，另见 ') && html.includes('。'), '标记前后的文字都保留')

  // ② 无 URL / 缺槽位 → 原样文字（fail-closed，不拿邻图顶）
  const noUrl = L.questionRichHtml('题 [图1] 与 [图9] 与 [图2]', [{ slot: 1, url: '' }])
  ok(noUrl.includes('[图9]'), '没有对应槽位的 [图9] 原样显示文字')
  ok(noUrl.includes('[图1]') && !noUrl.includes('fig'), '有槽位但没 URL 的 [图1] 也降级成文字，不拿邻图顶')
  ok((noUrl.match(/<img /g) || []).length === 0, '降级路径不产生任何 <img>')

  // ③ 转义：题干里的 < & " 不能破坏节点树
  const esc = L.questionRichHtml('a<b & c" [图1]', [{ slot: 1, url: 'https://x/y?a=1&b=2' }])
  ok(esc.includes('a&lt;b'), '< 转义')
  ok(esc.includes('&amp;'), '& 转义')
  ok(esc.includes('&quot;'), '" 转义')
  ok(!esc.includes('&amp;amp;'), '不重复转义')
  ok((esc.match(/<img /g) || []).length === 1, '转义题里仍能正确插图')

  // ④ URL 里的引号/空白被剥掉（属性注入防护）
  const dirty = L.questionRichHtml('[图1]', [{ slot: 1, url: 'https://x/a" onerror="alert(1)' }])
  ok(!dirty.includes('onerror="') && !dirty.includes(' onerror') && dirty.includes('src="https://x/a%22onerror=%22alert(1)"'), 'URL 双引号转义 + 空白剥离，不能注入 onerror 属性')

  // ⑤ removeFigureMarker 只删目标
  ok(L.removeFigureMarker('A[图1]B[图10]C', 1) === 'AB[图10]C', '删 [图1] 不误删 [图10]')
  ok(L.removeFigureMarker('A[图1]B[图1]', 1) === 'AB', '同槽位多个标记全删')
  ok(L.removeFigureMarker('无标记', 3) === '无标记', '无目标标记时原样返回')
  ok(L.hasFigureMarker('见 [图2]') === true && L.hasFigureMarker('纯文字') === false, 'hasFigureMarker 正确识别')
}

// ⑥ 静态契约：前后端字段 + 详情页交互都在
const detail = fs.readFileSync(DETAIL_SRC, 'utf8')
const api = fs.readFileSync(API_SRC, 'utf8')
const types = fs.readFileSync(TYPES_SRC, 'utf8')
const beTypes = fs.readFileSync(BE_TYPES, 'utf8')
const beSvc = fs.readFileSync(BE_SVC, 'utf8')

ok(/question_inline_figures/.test(beTypes) && /interface QuestionInlineFigure/.test(beTypes), '后端 QuestionContent 声明 question_inline_figures + 结构')
ok(/question_inline_figure_urls/.test(beTypes), '后端 TimelineItemWithUrl 声明派生 URL 字段')
ok(/getPublicUrl\(f\.file_key\)/.test(beSvc), '后端 withUrls 为每张内嵌图补签名 URL')
ok(/return undefined/.test(beSvc.slice(beSvc.indexOf('question_inline_figure_urls'))), '签名失败降级成 undefined（不让整条题目挂掉）')
ok(/question_inline_figures\?: QuestionInlineFigure\[\]/.test(types), '前端 QuestionContent 声明同名字段')
ok(/question_inline_figure_urls\?: \(string \| undefined\)\[\]/.test(types), '前端 TimelineItem 声明派生 URL 字段')
ok(/question_inline_figures/.test(api) && /patch\.content/.test(api), 'updateQuestion 把内嵌图写进 patch.content（图文同一次提交）')

ok(/questionRichHtml\(qContent/.test(detail), '详情页展示态用 RichText 渲染混排题干')
ok(/handleAddFigureFromCamera/.test(detail) && /sourceType: \['camera', 'album'\]/.test(detail), '来源①：相册/拍照加图')
ok(/handleAddFigureFromQuestionImage/.test(detail) && /showActionSheet/.test(detail), '来源②：从题面图裁图（多张让用户选）')
ok(/purpose: 'attach'/.test(detail), '内嵌图以 attach 上传（不建独立条目）')
ok(/question_inline_figures: inlineFigures\.map/.test(detail), 'handleSave 把内嵌图与文字一起提交')
ok(/\{ slot, file_key, width, height \}/.test(detail), '落库前剥掉临时 _url（不把签名写进 content）')
ok(/handleRemoveInlineFigure/.test(detail) && /removeFigureMarker/.test(detail), '删图同时删题干里的 [图N] 标记（不留孤儿标记）')
ok(/guardPolicy\('选择图片'\)/.test(detail) && /guardPrivacy\('选择图片'\)/.test(detail), '相册来源过双闸门（政策同意+平台授权）')
ok(/nextFigSlot = \(\) => inlineFigures\.reduce/.test(detail), 'slot 取最大+1，删除留空洞不复用（防旧标记指向新图）')
ok((detail.match(/<ImageEditor[\s\S]*?cropOnly/g) || []).length >= 2, '两个分支都挂了裁剪编辑器（cropOnly）')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
