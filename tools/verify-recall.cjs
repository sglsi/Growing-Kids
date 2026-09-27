// 用「真实踩雷形态」回扫检测器（模板字符串里含 JS 表达式）
const { execFileSync } = require('child_process')
const LINT = '/workspace/tools/lint-shell.cjs'
const D = '$' // 用变量拼 $，避免本文件被 shell 处理

// 依据日志证据：踩雷形态 = 模板字符串 ${<JS表达式>}
const cases = [
  ['p.x.toFixed',          `node -e "console.log(\`\nAI 后 drawW=${D}{(N*s).toFixed(1)} 画布 ${D}{boxW.toFixed(1)}\`)"`],
  ['JSON.stringify',       `node -e "console.log(\`${D}{JSON.stringify(packed)}\`)"`],
  ['spec.ratio.toFixed',   `node -e "console.log(\`ratio=${D}{spec.ratio.toFixed(2)}\`)"`],
  ['Date.now',             `node -e "console.log(\`t=${D}{Date.now}\`)"`],
  ['typeof',               `node -e "console.log(\`type=${D}{typeof o}\`)"`],
  ['r.printRatio.toFixed', `node -e "rs.forEach(r=>console.log(\`${D}{r.printRatio.toFixed(0)}%\`))"`],
  ['ratios.map',           `node -e "console.log(\`${D}{ratios.map(x=>x.toFixed(2))}\`)"`],
  ['Math.max',             `node -e "console.log(\`max=${D}{Math.max(...hs)}\`)"`],
  ['px.toFixed',           `node -e "console.log(\`${D}{px.toFixed(1)}\`)"`],
  ['h0.toFixed',           `node -e "console.log(\`h0=${D}{h0.toFixed(0)}\`)"`],
  ['空 ${}',               `echo "${D}{}"`],
]

let caught = 0
console.log('=== 用真实踩雷形态回扫（模板字符串含 JS 表达式）===\n')
for (const [label, cmd] of cases) {
  let code = 0
  try { execFileSync('node', [LINT, cmd], { stdio: 'pipe' }) } catch (e) { code = e.status }
  const ok = code === 1
  if (ok) caught++
  console.log(`  ${ok ? '✓ 拦下' : '✗ 漏报'}  ${label}`)
}
console.log(`\n拦截率：${caught}/${cases.length} = ${((caught / cases.length) * 100).toFixed(0)}%`)
process.exitCode = caught === cases.length ? 0 : 1
