#!/usr/bin/env bash
# OCR 运行环境一键恢复脚本（幂等）
# 背景：沙箱重置会清空系统 python3 的 site-packages，且 /workspace/projects/.venv-py
#       仅保留目录骨架（site-packages 内容全丢），导致快速/精准 OCR 同时不可用。
# 自动化：Nest 启动自检（EnvRecoveryService，日志前缀 [ocr-env]）检测到缺失后
#       会自动后台执行本脚本——正常情况无需人工运行；本脚本保留用于人工兜底。
# 方案：全部依赖安装到项目内持久化 venv（/workspace/projects/.venv-py）——
#       该目录随项目卷存续；Node 端（ppsv3.client / ocr-tool / sidecar.supervisor）
#       已实现优先探测 .venv-py/bin/python。
# 用法：bash docs/install-ocr-env.sh   （首次约 3~6 分钟，含 600MB paddlepaddle 下载）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-py"
PY="$VENV/bin/python"
PIP="$VENV/bin/python -m pip"

# pip 下载缓存持久化到项目卷：沙箱重置冲掉 venv 包内容后，重装直接从本地 wheel
# 安装（零下载，约 1 分钟），无需重新拉取 600MB 的 paddlepaddle 等
export PIP_CACHE_DIR="$ROOT/.cache-pip"
mkdir -p "$PIP_CACHE_DIR"

if [ ! -x "$PY" ]; then
  echo "[1/5] 创建持久化 venv（--copies 独立解释器副本，防系统 python 升级断链）..."
  python3 -m venv --copies --without-pip "$VENV"
  python3 -m pip --python "$PY" install --quiet pip
else
  echo "[1/5] venv 已存在：$VENV"
fi

echo "[2/5] 安装 Web/进程依赖（fastapi/uvicorn/psutil）..."
$PIP install --quiet --timeout 600 fastapi uvicorn python-multipart psutil

echo "[3/5] 安装快速模式引擎（RapidOCR + OpenCV headless）..."
$PIP install --quiet --timeout 600 rapidocr-onnxruntime opencv-python-headless

echo "[4/5] 安装精准模式引擎（PaddleOCR 3.7 + paddlepaddle 3.2.2，锁定版本：3.3.x 有 PIR 推理 bug）..."
$PIP install --quiet --timeout 900 paddleocr==3.7.0 "paddlepaddle==3.2.2"

echo "[5/5] 安装 PP-StructureV3 全链路依赖（paddlex[ocr]，版面/表格/公式）..."
$PIP install --quiet --timeout 900 "paddlex[ocr]>=3.0"

echo ""
echo "===== 自检 ====="
ok=0; fail=0
for mod in fastapi uvicorn psutil cv2 rapidocr_onnxruntime paddle paddleocr paddlex; do
  if "$PY" -c "import $mod" 2>/dev/null; then
    echo "  [OK] $mod"; ok=$((ok+1))
  else
    echo "  [FAIL] $mod"; fail=$((fail+1))
  fi
done
echo "通过 $ok / $((ok+fail)) 项"

if [ "$fail" -eq 0 ]; then
  cat <<'EOF'

全部依赖就绪。验证方式：
  1) 快速模式（工具式子进程，无需侧车）：
     .venv-py/bin/python ocr-engine/main.py --once --op recognize --mode rapid < test.png
  2) 精准模式（PP-StructureV3）：
     .venv-py/bin/python ocr-engine/main3.py --once --op ppsv3 < test.png
  3) Nest 诊断端点（需先启动 dev 服务）：
     curl http://localhost:3000/api/image/ocr-diagnose
  4) 前端识别页「识别诊断」按钮。

提示：精准模式由 SidecarSupervisor 在首次调用时自动拉起（模型加载约 27s 属正常）。
模型缓存（PP-OCRv5/PP-StructureV3 权重）持久化在 /workspace/projects/.cache-paddlex，
沙箱重置后无需重复下载（侧车脚本已注入 PADDLE_PDX_CACHE_HOME）。
EOF
else
  echo "存在失败项，请检查网络后重跑本脚本。" >&2
  exit 1
fi
