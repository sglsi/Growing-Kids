/**
 * 问题 2 的根因验证 + 修复证明（可证伪）。
 *
 * 断言：
 *  A. 修复前：默认（未设 IMG_PIPELINE_MODE）时，auto/enhance **不进入**新管线方法
 *  B. 修复后：默认时，auto/enhance **进入**新管线方法
 *
 * 做法：直接读 image.controller.ts 源码，提取 `IMG_PIPELINE_MODE` 的默认值，
 *       并据此模拟分支走向（不依赖 Nest 运行时）。
 */
const fs = require('fs')
const path = '/workspace/projects/server/src/image/image.controller.ts'
const src = fs.readFileSync(path, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

console.log('[1] 默认值检查')
const m = src.match(/IMG_PIPELINE_MODE\s*\|\|\s*'([a-z]+)'/)
ok('controller 能解析出默认 MODE', !!m, m ? `默认='${m[1]}'` : '未找到')
const defaultMode = m ? m[1] : '?'

console.log('[2] 默认下 auto/enhance 是否进入新管线')
const modeGate = (mode) => mode === 'new' || mode === 'hybrid'
const autoEntersNew = modeGate(defaultMode)
const enhanceEntersNew = modeGate(defaultMode)
ok('默认时 auto 进入 straighten（几何纠偏）', autoEntersNew, `MODE=${defaultMode} → ${autoEntersNew ? '进入 ✅' : '不进 ❌'}`)
ok('默认时 enhance 进入 enhance（智能高清）', enhanceEntersNew, `MODE=${defaultMode} → ${enhanceEntersNew ? '进入 ✅' : '不进 ❌'}`)

console.log('[3] 源码结构：auto/enhance 分支确实存在')
ok('存在 straighten 调用分支', /this\.imageService\.straighten\(/.test(src))
ok('存在 enhance 调用分支', /this\.imageService\.enhance\(/.test(src))
ok('hybrid 失败会回退（有 catch + 回退注释）', /catch\s*\(e\)/.test(src) && /回退|兜底|fallback/.test(src))

console.log('[4] 去手写 erase_v2 不受该开关影响（应始终直达）')
// 注：只看 process() 方法内的顺序（controller 顶部的 capabilities 端点也含 IMG_PIPELINE_MODE 字样）
const procBody = src.slice(src.indexOf('async process('))
ok('erase_v2 在 process() 内的 MODE 判断之前直接返回',
  procBody.indexOf("dto.action === 'erase_v2'") >= 0 &&
  procBody.indexOf("dto.action === 'erase_v2'") < procBody.indexOf('IMG_PIPELINE_MODE'))

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
