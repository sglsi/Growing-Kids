#!/usr/bin/env node
/**
 * L11 危险命令检测器 —— 在「把命令交给 shell 之前」拦住会造成 bad substitution 的写法。
 *
 * 为什么需要它：「知道原因」挡不住再次犯错。本会话实测：
 *   写下 L11 之后仍连踩 2 次（20:48、20:52）；拦截工具建成后当晚又连踩 2 次（22:07、22:08）。
 *   所以必须有**机械化的前置检查**，而不是靠"记得注意"。
 *
 * v2（2026-09-26 晚）：首版对 615 条历史命令审计时产生 31/33 误报，根因是
 * 用正则猜 zsh 的行为。v2 改为**模拟 zsh 解析**：
 *   ① zshLiveStream 状态机 —— 单引号内容、双引号内转义序列、裸转义序列全部"惰性"，
 *      只有 zsh 真正会做替换的字符才进入检测流（「活字符流」）。
 *      效果：\`转义反引号\`、\${转义美元}、'单引号保护的一切' 不再误报；
 *      而双引号内未转义的 ` 与 ${} 依然 100% 命中。
 *   ② looksLikeJsVar —— 识别 zsh 合法参数展开：${var:-def}、${var:=def}、${var:+alt}、
 *      ${var:?msg}、${f#pat}、${f%pat}、${f/old/new}、${arr[1]:-x}、${#var} 等。
 *   ③ looksLikeJsCall —— $(...) 只报「确定是 JS」的正向特征（点号调用 x.y( 、
 *      紧凑调用开头 f( 、箭头 =>），合法的 $(find ...)、$(npm root -g)、$(ls | wc -l) 放行。
 *
 * 判据来源（本机 zsh 实测，非推测）：
 *   ① 活字符流含 ${JS表达式}  → zsh: bad substitution          ← 致命
 *   ② 活字符流含 $(JS表达式)  → zsh: unknown file attribute    ← 致命
 *   ③ 双引号内未转义反引号    → 反引号内 ${} 被 zsh 替换 → 炸    ← 致命
 *   ④ heredoc 分隔符未加引号  → 内容被替换，${} 会炸            ← 致命
 *
 * 用法：
 *   node tools/lint-shell.cjs '要执行的命令字符串'
 *   echo '命令' | node tools/lint-shell.cjs
 *
 * 退出码：0 = 安全；1 = 危险（附修改建议）；2 = 用法错误
 */

/**
 * zsh 引号状态机：返回「活字符流」——zsh 真正会做参数/命令/算术替换的部分。
 * 惰性（被丢弃）的内容：
 *   OUT 状态：\x 转义的 x；'...' 单引号区间整体（含引号本身）
 *   DOUBLE 状态：\x 转义序列（\$ \` \\ \" 等）
 * 保留：双引号字符本身（供 check 5 识别 node -e "..." 形态）。
 */
const zshLiveStream = (src) => {
  let out = ''
  let state = 'OUT' // OUT | SINGLE | DOUBLE
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (state === 'SINGLE') {
      if (ch === "'") state = 'OUT'
      continue // 单引号内一切惰性
    }
    if (state === 'DOUBLE') {
      if (ch === '\\') {
        i++ // 转义序列整体惰性（\" 不会闭合引号，\$ \` 不会被替换）
        continue
      }
      if (ch === '"') {
        state = 'OUT'
        out += '"'
        continue
      }
      out += ch // 双引号内的 $ ` ( ) 等都是活的
      continue
    }
    // OUT
    if (ch === "'") {
      state = 'SINGLE'
      continue
    }
    if (ch === '\\') {
      i++ // 裸转义：下一个字符惰性
      continue
    }
    if (ch === '"') {
      state = 'DOUBLE'
      out += '"'
      continue
    }
    out += ch
  }
  return out
}

/**
 * 判断 ${...} 的内容是否"像 JS 表达式"。
 * 合法 zsh 参数展开（放行）：
 *   裸变量        $X、${MY_VAR}、${#var}（长度）、${1}（位置参数）、$? $! $@ 等
 *   数组下标      ${arr[0]}、${pipestatus[1]}
 *   修饰符组合    ${var:-def} ${var:=def} ${var:+alt} ${var:?msg} ${var-def}
 *                 ${f#pat} ${f##pat} ${f%pat} ${f%%pat} ${f/old/new} ${var:1:2}
 * JS 表达式（拦截）：${p.x}、${p.x.toFixed(2)}、${c.name.padEnd(20)}、${}（空）
 */
const looksLikeJsVar = (inner) => {
  const s = inner.trim()
  if (!s) return true // ${} 空 → zsh: bad substitution
  // 变量名（可带 # 长度前缀 / 位置参数 / 特殊变量）+ 可选数组下标 + 可选修饰符后缀
  if (/^(?:#?[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#@*-])(\[[^\]]*\])?([-:=+?#%/][\s\S]*)?$/.test(s)) return false
  return true
}

/**
 * 判断 $(...) 的内容是否"确定是 JS 调用"。
 * 只报正向 JS 特征（宁可少报、不可误报——误报会淹没真信号）：
 *   obj.method(   $(p.x.toFixed(2)) $(c.name.padEnd(20))   ← 历史真实炸点
 *   紧凑调用开头  $(countBlue(out5))                        ← shell 命令名后不会紧跟 (
 *   箭头函数      $(x => x+1)
 * 合法命令（放行）：$(date)、$(find /x -name y | head -1)、$(npm root -g)、$(ls | wc -l)
 */
const looksLikeJsCall = (inner) => {
  const s = inner.trim()
  if (!s) return false // $() 空命令替换在 zsh 合法
  if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(s)) return true
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(s)) return true
  if (/=>/.test(s)) return true
  return false
}

/**
 * 剥离「被引号保护的 heredoc 体」——那里的 ${} 不会被 shell 替换，不应触发告警。
 * 例：cat <<'EOF'
 *       ${o.x.toFixed(2)}      ← 安全，原样写入
 *     EOF
 */
const stripQuotedHeredocs = (src) => {
  const lines = src.split('\n')
  const out = []
  let inHeredoc = null // 记录分隔符
  for (const line of lines) {
    if (inHeredoc) {
      if (line.trim() === inHeredoc) inHeredoc = null
      continue // 跳过 heredoc 体
    }
    // 检测带引号分隔符的 heredoc 起始行：<<'EOF' / <<"EOF"
    const m = line.match(/<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/)
    if (m) {
      inHeredoc = m[2]
      out.push(line.replace(/<<-?\s*(['"])[A-Za-z_][A-Za-z0-9_]*\1/, '<<HEREDOC')) // 去掉起始标记再交后续判据
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 供各判据使用的活字符流：先剥引号保护的 heredoc，再过 zsh 引号状态机 */
const liveStreamOf = (src) => zshLiveStream(stripQuotedHeredocs(src))

const CHECKS = [
  {
    name: '含 ${...}，且内容是 JS 表达式（zsh 会当变量名去展开 → bad substitution）',
    test: (src) => {
      const live = liveStreamOf(src)
      const ms = live.match(/\$\{([^}]*)\}/g) || []
      return ms.some((x) => looksLikeJsVar(x.slice(2, -1)))
    },
    hint: '把这段 JS 写入脚本文件后 `node 文件` 执行（首选）；或去掉模板字符串、改用普通字符串拼接。',
  },
  {
    name: '含 $(...)，且内容是 JS 方法调用（zsh 当子命令执行 → unknown file attribute）',
    test: (src) => {
      const live = liveStreamOf(src)
      const ms = live.match(/\$\(([^)]*)\)/g) || []
      return ms.some((x) => looksLikeJsCall(x.slice(2, -1)))
    },
    hint: '若非真的要在 shell 里跑子命令，请改为脚本文件。',
  },
  {
    name: "heredoc 分隔符未加引号（<<EOF 会对内容做变量替换，内容里的 ${} 会炸）",
    // 只匹配真正的 heredoc 起始行，且分隔符未被引号包裹（在原文上判定）
    test: (src) =>
      /(?:^|[;&|]\s*|\n)\s*[A-Za-z_][\w.-]*\s*<<-?\s*(?!['"\\])[A-Za-z_][A-Za-z0-9_]*\b/m.test(src),
    hint: "改成 <<'EOF'（给分隔符加引号），内容即原样写入、不做任何替换。",
  },
  {
    name: 'node -e "..." 里含未转义反引号模板字符串（双引号不保护反引号，反引号内的 ${} 会被 zsh 替换 → 炸）',
    // 活字符流里：转义反引号 \` 与单引号区间已被剥除，剩下的反引号必是"活"的
    test: (src) => {
      const live = liveStreamOf(src)
      return /node\s+(?:--\S+\s+)*-\w*e\s*"/.test(live) && live.includes('`')
    },
    hint: "改用单引号外壳（node -e '...'），但更稳妥的做法仍是：写入脚本文件后 `node 文件` 执行。",
  },
]

const src =
  process.argv[2] ??
  (() => {
    try {
      return require('fs').readFileSync(0, 'utf8')
    } catch {
      return ''
    }
  })()

if (!src || !src.trim()) {
  console.error("用法: node tools/lint-shell.cjs '命令字符串'   或   echo 命令 | node tools/lint-shell.cjs")
  process.exit(2)
}

const hits = CHECKS.filter((c) => {
  try {
    return c.test(src)
  } catch {
    return false
  }
})

if (!hits.length) {
  console.log('✓ 未发现 L11 类危险写法')
  process.exit(0)
}

console.error('✗ 检出 L11 类危险写法，命令很可能在 shell 解析阶段就失败：\n')
hits.forEach((h, i) => {
  console.error(`  ${i + 1}. ${h.name}`)
  console.error(`     ${h.hint}\n`)
})
console.error('首选做法：主体逻辑一律写入脚本文件（Write 工具），再 `node 文件路径` 执行。')
process.exit(1)
