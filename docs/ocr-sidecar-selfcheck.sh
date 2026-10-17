#!/bin/bash
# OCR 侧车部署自检（#150 错题提取双模式）——在部署 server 的机器上执行
# 用法：bash ocr-sidecar-selfcheck.sh
# 背景：精准模式依赖 3.x 侧车（/opt/pocr3-venv + main3.py :9001）；
#       快速模式依赖 2.x 引擎（python3 + main.py，rapidocr 包）。
# 任何一项 ❌ 都会让错题提取显示「未能识别出文字」或「快速识别服务暂不可用」。

PPSV3_PYTHON="${PPSV3_PYTHON:-/opt/pocr3-venv/bin/python}"
PPSV3_URL="${PPSV3_URL:-http://127.0.0.1:9001}"

echo "════════ 1. 3.x 侧车 venv（精准模式必需） ════════"
if [ -x "$PPSV3_PYTHON" ]; then
  echo "✅ python 可执行：$PPSV3_PYTHON"
  "$PPSV3_PYTHON" -c "import paddle; print('✅ paddle', paddle.__version__)" 2>&1 | tail -1
  "$PPSV3_PYTHON" -c "import paddleocr; print('✅ paddleocr', paddleocr.__version__)" 2>&1 | tail -1
else
  echo "❌ venv python 缺失或不可执行：$PPSV3_PYTHON"
  echo "   → 按 ocr-engine/README.md 创建 venv，或设 PPSV3_PYTHON 指向实际解释器"
fi

echo ""
echo "════════ 1b. 2.x 引擎（快速模式 RapidOCR，走系统 python3） ════════"
SYS_PY="${OCR_PYTHON:-python3}"
if command -v "$SYS_PY" >/dev/null 2>&1; then
  echo "✅ 系统 python：$SYS_PY"
  if "$SYS_PY" -c "import rapidocr_onnxruntime" 2>/dev/null; then
    echo "✅ rapidocr_onnxruntime 可 import（快速模式可用）"
  else
    echo "❌ rapidocr_onnxruntime 未安装 → 快速模式会降级为空结果（前端提示重试/换精准）"
    echo "   → pip install rapidocr_onnxruntime（装到 $SYS_PY 所在环境），或设 OCR_PYTHON 指向已装的解释器"
  fi
else
  echo "❌ 系统 python 不可用：$SYS_PY"
fi

echo ""
echo "════════ 2. 侧车脚本位置（含当前目录，适配脚本与后端同目录部署） ════════"
for name in main3.py main.py; do
  hit=$(find . /opt /app /home /root /srv /usr/local -maxdepth 4 -name "$name" -not -path '*/node_modules/*' 2>/dev/null | head -2)
  if [ -n "$hit" ]; then echo "✅ $name：$(echo "$hit" | tr '\n' ' ')"; else echo "⚠️  未找到 $name（工具式子进程将 no-script 失败）"; fi
done

echo ""
echo "════════ 3. 端口监听（9001=3.x 生产 / 9000=2.x 备份） ════════"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(9000|9001)\b' || echo "⚠️  9000/9001 均无监听（托管模式会自动按需拉起；外部模式需手动常驻）"

echo ""
echo "════════ 4. /healthz 探测 ════════"
code=$(curl -s -o /tmp/_hz.json -m 3 -w '%{http_code}' "$PPSV3_URL/healthz" 2>/dev/null)
if [ "$code" = "200" ]; then echo "✅ $PPSV3_URL/healthz → 200 $(cat /tmp/_hz.json 2>/dev/null | head -c 200)"; else echo "❌ $PPSV3_URL/healthz → ${code:-无响应}（侧车未起或地址不对）"; fi

echo ""
echo "════════ 5. 后端进程环境变量（systemd/docker 里查） ════════"
PID=$(pgrep -f 'nest start|node.*dist/server|node.*main.js' 2>/dev/null | head -1)
if [ -n "$PID" ]; then
  echo "后端 PID=$PID，OCR 相关环境变量："
  tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | grep -E '^(PPSV3|OCR)_' | sed 's/^/  /' || echo "  （无 OCR/PPSV3 变量，全默认）"
else
  echo "⚠️  未找到后端进程；若在容器里，请用：docker exec <容器> env | grep -E 'PPSV3|OCR'"
fi

echo ""
echo "════════ 6. 工具式子进程冒烟（orient，~10s 含模型加载） ════════"
M3=$(find . /opt /app /home /root /srv -maxdepth 4 -name main3.py -not -path '*/node_modules/*' 2>/dev/null | head -1)
if [ -n "$M3" ] && [ -x "$PPSV3_PYTHON" ]; then
  # 1x1 白色 PNG（base64）足够触发 orient 四分类
  B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  OUT=$(echo "$B64" | base64 -d | timeout 120 "$PPSV3_PYTHON" "$M3" --once --op orient 2>/dev/null | tail -1)
  echo "$OUT" | grep -q '"angle"' && echo "✅ orient OK：$(echo "$OUT" | tail -c 200)" || echo "❌ orient 失败：$(echo "$OUT" | tail -c 300)"
else
  echo "⏭ 跳过（main3.py 或 venv 不可用）"
fi

echo ""
echo "════════ 汇总 ════════"
echo "精准模式（PaddleOCR）：需要 1（venv+paddle+paddleocr）+ 2（main3.py）+ 4（healthz）全 ✅"
echo "快速模式（RapidOCR）：需要 1b（系统 python3 + rapidocr_onnxruntime）+ 2（main.py）全 ✅"
echo "排查手册：docs/issue-ocr-dual-mode.md"
