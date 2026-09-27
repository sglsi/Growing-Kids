#!/bin/bash
# 自测 lint-shell.cjs —— 判据以 zsh 实测为准（v2：zsh 引号状态机）
# 注意：本脚本自身要避免引号陷阱 —— 用「独立变量 + 变量传参」而非内联双引号
# 运行方式：bash tools/test-lint.sh   （这是 bash 脚本，不能用 node 跑）

LINT="node /workspace/tools/lint-shell.cjs"
pass=0; fail=0

chk() { # $1=期望exit $2=描述 $3=命令文本（原样传给检测器）
  printf '%s' "$3" | $LINT >/dev/null 2>&1
  got=$?
  if [ "$got" = "$1" ]; then pass=$((pass+1)); echo "  ✓ $2"
  else fail=$((fail+1)); echo "  ✗ $2 (期望 exit=$1, 实得 $got)"; fi
}

BS='$'
SQ="'"
# 用 ${BS} 拼出 $ 字符、${SQ} 拼出单引号，避免本脚本自身被替换

echo "=== 致命写法（zsh 实测会炸，应拦下 exit=1）==="
chk 1 '内联模板字符串 toFixed'   "node -e \"console.log(\`${BS}{o.x.toFixed(2)}\`)\""
chk 1 '内联 JSON.stringify'      "node -e \"console.log(\`${BS}{JSON.stringify(o)}\`)\""
chk 1 '内联 Date.now'            "node -e \"console.log(\`${BS}{Date.now}\`)\""
chk 1 '内联 Math.max'            "node -e \"console.log(\`${BS}{Math.max(1,2)}\`)\""
chk 1 '内联 typeof'              "node -e \"console.log(\`${BS}{typeof x}\`)\""
chk 1 '内联 ratios.map'          "node -e \"console.log(\`${BS}{ratios.map(f)}\`)\""
chk 1 '内联空 ${BS}{}'           "echo \"${BS}{}\""
chk 1 '命令替换 toFixed'         "node -e \"console.log(${BS}(o.x.toFixed(2)))\""
chk 1 '命令替换紧凑调用'          "echo \"${BS}(countBlue(out5))\""
chk 1 '双引号内单引号不保护变量'   "node -e \"console.log(${SQ}${BS}{p.x}${SQ})\""
chk 1 'heredoc 未加引号'          "cat <<EOF > /tmp/x
${BS}{o.x.toFixed(2)}
EOF"
chk 1 'node -e 双引号内含反引号'    "node -e \"console.log(\`hello\`)\""

echo
echo "=== 安全写法（zsh 实测正常，应放行 exit=0）==="
chk 0 '合法 shell 变量'           "echo \"prefix-${BS}{X}-suffix\""
chk 0 '合法变量含下划线'          "echo \"${BS}{MY_VAR}\""
chk 0 '合法数组下标'              "echo \"${BS}{arr[0]}\""
chk 0 'zsh 参数展开 pipestatus'   "echo \"tsc exit=${BS}{pipestatus[1]:-${BS}?}\""
chk 0 'zsh 参数展开去前缀'        "echo \"${BS}{f#src/}\""
chk 0 'zsh 参数展开默认值'        "echo \"${BS}{X:-default}\""
chk 0 '真实命令替换 date'          "echo \"today: ${BS}(date)\""
chk 0 '真实命令替换 pwd'           "echo \"${BS}(pwd)\""
chk 0 '命令替换 find 管道'         "for f in ${BS}(find /x -name '*.ts' | head -1); do echo \"${BS}f\"; done"
chk 0 '命令替换 npm root'          "ls ${BS}(npm root -g)/playwright"
chk 0 '命令替换 ls 计数'           "echo \"count: ${BS}(ls /tmp | wc -l)\""
chk 0 '转义反引号不炸'             "node -e \"console.log(\\\`hello\\\`)\""
chk 0 '单引号保护的演示载荷'        "node tools/lint-shell.cjs ${SQ}node -e \"console.log(\`${BS}{p.x}\`)\"${SQ}"
chk 0 '双引号内联含 .toFixed( 但无变量' "node -e \"const o={x:1.2};console.log(o.x.toFixed(2))\""
chk 0 '单引号外壳含方法调用'       "node -e 'const o={x:1.2};console.log(o.x.toFixed(2))'"
chk 0 'heredoc 已加引号'           "cat <<'EOF' > /tmp/x
${BS}{o.x.toFixed(2)}
EOF"
chk 0 'heredoc 内含 node -e 与反引号字样' "cat <<'EOF' > /tmp/x
node -e \"console.log(\`hi\`)\"
${BS}{p.x.toFixed(2)}
EOF"
chk 0 '普通构建命令'               'cd /workspace/server-v4 && npx tsc --noEmit'
chk 0 '运行脚本文件（首选做法）'    'node /tmp/probe.cjs'
chk 0 'node -e 但不含反引号'        'node -e "console.log(1+1)"'
chk 0 'stdin 方式（首选做法）'      'node tools/run-js.cjs < /tmp/probe.cjs'

echo
echo "L11 检测器自测：$pass 通过 / $fail 失败"
[ "$fail" = "0" ] || exit 1
