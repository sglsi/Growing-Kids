/**
 * D-068 离线实证（不连数据库、不连微信、不依赖 IDE）
 *
 * 做三件事：
 *  ① 用 TypeScript 编译器抽出 index.tsx 里**真实的纯函数**（目录树 / 落点命中）
 *     转成 JS 后执行，验证无限层级面包屑、防成环、移动时排除自身子树、
 *     以及「拖到格子间隙也能命中落点」；
 *  ② 验证左转 90° 与通用编辑器使用同一角度体系（顺时针 270°）；
 *  ③ 检查小程序编译产物里 D-068 的交互特征串都在。
 *
 * ⚠️ 这里只能证明「纯函数 + 编译产物」正确，证明不了真机手势与 Canvas 出图。
 *    真机长按拖动、Swiper 左右滑动、旋转/裁剪实拍仍需实机回归（勿冒称已验证）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FE = path.join(ROOT, 'src', 'pages', 'library', 'index.tsx')
const ROT = path.join(ROOT, 'src', 'lib', 'rotate-image.ts')
const EDITOR = path.join(ROOT, 'src', 'components', 'image-editor.tsx')
const DIST = path.join(ROOT, 'dist', 'pages', 'library', 'index.js')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('D-068 资料库直接拖动 / 预览编辑 / 无限层级文件夹 实证')

// ---- ① 执行源码里的纯函数 ----
const src = fs.readFileSync(FE, 'utf8')
const start = src.indexOf('function folderPathOf')
const end = src.indexOf('function PreviewTool')
if (start < 0 || end < 0 || end <= start) {
  ok(false, '能从源码抽出纯函数区块（folderPathOf → hitCellIndex）')
} else {
  const block = src.slice(start, end)
  ok(true, '能从源码抽出纯函数区块（folderPathOf → hitCellIndex）')
  let js = ''
  try {
    const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
    js = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
    ok(true, 'TypeScript 编译函数区块成功')
  } catch (e) {
    ok(false, `TypeScript 编译函数区块成功 (${e.message})`)
  }
  let fns = null
  if (js) {
    try {
      // eslint-disable-next-line no-new-func
      fns = new Function(`${js}; return { folderPathOf, subtreeIds, folderTreeRows, hitCellIndex };`)()
      ok(typeof fns.folderPathOf === 'function' && typeof fns.hitCellIndex === 'function', '纯函数可调用')
    } catch (e) {
      ok(false, `纯函数可调用 (${e.message})`)
    }
  }

  if (fns) {
    const { folderPathOf, subtreeIds, folderTreeRows, hitCellIndex } = fns
    // 无限层级：根 A → B → C，另有根目录 D、A 下直属 E
    const folders = [
      { id: 'A', parent_id: null, name: '数学' },
      { id: 'B', parent_id: 'A', name: '三年级' },
      { id: 'C', parent_id: 'B', name: '单元测试' },
      { id: 'D', parent_id: null, name: '语文' },
      { id: 'E', parent_id: 'A', name: '错题' },
    ]
    ok(eq(folderPathOf(folders, null), []), '根目录面包屑为空')
    ok(eq(folderPathOf(folders, 'C').map((f) => f.id), ['A', 'B', 'C']), '三级目录面包屑 根→当前 顺序正确')
    ok(eq(folderPathOf(folders, 'NONE'), []), '找不到目录时 fail-closed 返回空')
    // 脏数据成环不能把 UI 卡死
    const cyc = [
      { id: 'X', parent_id: 'Y' },
      { id: 'Y', parent_id: 'X' },
    ]
    let cyclicOk = true
    try { cyclicOk = folderPathOf(cyc, 'X').length <= 32 } catch (e) { cyclicOk = false }
    ok(cyclicOk, '循环引用：面包屑在 32 层内收敛，不死循环')

    const sub = subtreeIds(folders, 'A')
    ok(sub.has('A') && sub.has('B') && sub.has('C') && sub.has('E') && !sub.has('D'), 'subtreeIds 含自身与全部后代，不含旁支')
    ok(eq(folderTreeRows(folders, 'A').map((r) => r.folder.id), ['D']), '移动文件夹 A 时须排除 A 的整个子树（防成环）')
    const rows = folderTreeRows(folders, null)
    const depth = Object.fromEntries(rows.map((r) => [r.folder.id, r.depth]))
    ok(depth.A === 0 && depth.B === 1 && depth.C === 2 && depth.E === 1 && depth.D === 0, '树展开深度正确（无限层级按深度缩进）')
    ok(eq(folderTreeRows([], null), []), '空目录列表返回空行，不抛错')

    // 拖拽落点：三列网格，每格 100×100，间隔 20
    const rects = [
      { left: 0, top: 0, right: 100, bottom: 100 },
      { left: 120, top: 0, right: 220, bottom: 100 },
      { left: 240, top: 0, right: 340, bottom: 100 },
      { left: 0, top: 120, right: 100, bottom: 220 },
    ]
    ok(hitCellIndex(rects, 50, 50) === 0, '手指落在第 1 格内：命中 0')
    ok(hitCellIndex(rects, 270, 40) === 2, '手指落在第 3 格内：命中 2')
    ok(hitCellIndex(rects, 110, 50) === 0 || hitCellIndex(rects, 110, 50) === 1, '落在格子间隙：按最近中心兜底命中相邻格')
    ok(hitCellIndex(rects, 9999, 9999) === -1, '手指拖到远处空白：返回 -1，不乱落位')
    ok(hitCellIndex([], 10, 10) === -1, '矩形未量到时返回 -1（调用方会补量），不抛错')
    // 配合 moveItem：拖 0→2 的页序结果（moveItem 已在 D-064 实证过，这里只串起来）
    ok(eq(fns.folderPathOf(folders, 'C').length, 3), '目录深度 ≥3（无限层级不是写死两级）')
  }
}

// ---- ② 左转 90° 与通用编辑器同一角度体系 ----
const rot = fs.readFileSync(ROT, 'utf8')
const ed = fs.readFileSync(EDITOR, 'utf8')
ok(/const deg = dir === 1 \? 90 : 270/.test(rot), '合成页左转 = 顺时针 270°，右转 = 90°')
ok(/\(rotation \+ dir \* 90 \+ 360\) % 360/.test(ed), '通用编辑器用 (rotation + dir*90 + 360)%360')
ok(((0 - 90 + 360) % 360) === 270 && ((0 + 90 + 360) % 360) === 90, '两处角度数学等价（左转确实是 270°）')
ok(/destWidth: outW/.test(rot) && /waitCanvasCss/.test(rot), '旋转烘焙沿用 CSS/缓冲 1:1 + 全区域导出')
ok(src.includes('放大仅查看；旋转 / 裁剪会写入合成结果'), '放大不写回、旋转/裁剪写回的口径明示')
ok(/setComposeImage\(idx, out\)/.test(src) && /setComposeImage\(idx, path\)/.test(src), '旋转与裁剪结果都写回 composeItems[i].path（参与合成）')

// ---- ③ 编译产物特征串 ----
if (!fs.existsSync(DIST)) {
  ok(false, `小程序编译产物存在 (${DIST})`)
} else {
  const d = fs.readFileSync(DIST, 'utf8')
  ok(true, '小程序编译产物存在')
  for (const [kw, label] of [
    ['左转90°', '合成页预览左转按钮'],
    ['右转90°', '合成页预览右转按钮'],
    ['放大', '放大查看入口'],
    ['裁剪', '裁剪入口'],
    ['放大仅查看', '放大不写回口径'],
    ['新建文件夹', '文件夹新建'],
    ['全部资料', '面包屑根目录'],
    ['管理当前目录', '目录管理'],
    ['compose-rotate-canvas', '离屏旋转画布'],
    ['确定（', 'D-064 两段确认未被破坏'],
    ['开始合成（', 'D-064 复核态合成按钮未被破坏'],
    ['Swiper', 'D-064 左右滑动预览未被破坏'],
    ['已移除', 'D-064 暂存框未被破坏'],
  ]) {
    ok(d.includes(kw), `产物含 ${label} [${kw}]`)
  }
}

console.log(`\nD-068 实证：${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
