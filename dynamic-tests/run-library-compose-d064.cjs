/**
 * D-064 排序页交互离线实证（不连数据库、不连微信、不依赖 IDE）
 *
 * 做两件事：
 *  ① 用 TypeScript 编译器把 index.tsx 里**真实的 moveItem 函数体**转成 JS 后执行，
 *     验证「拖到哪个格子就占哪个格子」以及边界（越界/同位置/空数组）不改坏顺序；
 *  ② 检查小程序编译产物里 D-064 的交互特征串都在（网格 / 暂存框 / 预览 / 长按 / 两段确认）。
 *
 * ⚠️ 这里只能证明「顺序算法 + 编译产物」正确，证明不了真机手势。
 *    真机长按拖拽、Swiper 左右滑动、X 命中区域仍需实机回归。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FE = path.join(ROOT, 'src', 'pages', 'library', 'index.tsx')
const DIST = path.join(ROOT, 'dist', 'pages', 'library', 'index.js')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

console.log('D-064 排序页交互实证')

// ---- ① 执行源码里的 moveItem ----
const src = fs.readFileSync(FE, 'utf8')
const m = src.match(/function moveItem<T>[\s\S]*?\n}/)
if (!m) {
  ok(false, '能从源码抽出 moveItem 函数体')
} else {
  ok(true, '能从源码抽出 moveItem 函数体')
  let js = ''
  try {
    const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
    js = ts.transpileModule(m[0], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    ok(true, 'TypeScript 编译函数体成功')
  } catch (e) {
    ok(false, `TypeScript 编译函数体成功 (${e.message})`)
  }
  if (js) {
    let moveItem
    try {
      // eslint-disable-next-line no-new-func
      moveItem = new Function(`${js}; return moveItem;`)()
      ok(typeof moveItem === 'function', 'moveItem 可调用')
    } catch (e) {
      ok(false, `moveItem 可调用 (${e.message})`)
    }
    if (typeof moveItem === 'function') {
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      ok(eq(moveItem(['A', 'B', 'C', 'D'], 0, 2), ['B', 'C', 'A', 'D']), '拖 1→3：目标格子被占据')
      ok(eq(moveItem(['A', 'B', 'C', 'D'], 3, 0), ['D', 'A', 'B', 'C']), '拖 4→1：反向移动同样正确')
      const base = ['A', 'B', 'C']
      ok(moveItem(base, 1, 1) === base, '同位置：原数组原样返回')
      ok(moveItem(base, 0, 99) === base, '目标越界：fail-closed 原数组原样返回')
      ok(moveItem(base, -1, 2) === base, '起点越界：fail-closed 原数组原样返回')
      ok(moveItem([], 0, 0).length === 0, '空数组：不抛错')
      ok(eq(moveItem(['A', 'B', 'C'], 0, 1), ['B', 'A', 'C']), '±1 兜底等价于相邻交换')
    }
  }
}

// ---- ② 删除暂存 / 恢复原位 的静态契约 ----
ok(/fromIndex: idx/.test(src), '删除时记录被删原位')
ok(/Math\.min\(it\.fromIndex, next\.length\)/.test(src), '恢复时插回原位且索引不越界')
ok(/setRemovedItems\(\(prev\) => \[\.\.\.prev,/.test(src), '删除是追加进暂存框而非真删')
ok(/if \(confirmed \|\| composeBusy\) return/.test(src), '复核态禁止删除与恢复')
ok(/if \(composeBusy \|\| !confirmed \|\| !composeItems\.length\) return/.test(src), '未点确定不允许触发合成')
ok(/confirmed \? \(\) => void doCombine\(\) : confirmCompose/.test(src), '确定与合成为两段')

// ---- ③ 编译产物特征串 ----
if (!fs.existsSync(DIST)) {
  ok(false, `小程序编译产物存在 (${DIST})`)
} else {
  const d = fs.readFileSync(DIST, 'utf8')
  ok(true, '小程序编译产物存在')
  for (const [kw, label] of [
    ['compose-cell', '网格格子 class（长按落点查询依赖）'],
    ['已移除', '下部临时框文案'],
    ['加回原位', '暂存框可恢复提示'],
    ['确定（', '确定按钮'],
    ['开始合成（', '复核态合成按钮'],
    ['预览', '全屏预览相关文案'],
    ['onLongPress', '长按手势'],
    ['Swiper', '左右滑动预览组件 Swiper'],
    ['SwiperItem', '预览页项 SwiperItem'],
  ]) {
    ok(d.includes(kw), `产物含 ${label} [${kw}]`)
  }
  // Taro 把原生 swiper 标签模板注册在 base.wxml，页面 JS 里只有大写组件变量
  const base = path.join(ROOT, 'dist', 'base.wxml')
  ok(fs.existsSync(base) && /<swiper/.test(fs.readFileSync(base, 'utf8')), 'base.wxml 已注册 swiper 原生组件模板')
}

console.log(`\nD-064 排序页实证：${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
