# OCR 运行环境一键恢复脚本（Windows / PowerShell，幂等）
# 背景：install-ocr-env.sh 面向扣子 Linux 沙箱（/workspace/projects/.venv-py、python3）。
#       本脚本面向 Windows 本机开发：venv 落在项目根 .venv-py（Scripts\python.exe），
#       Node 端（ppsv3.client / sidecar.supervisor / env-recovery.service）已做平台自适应探测。
# 用法：在项目根执行
#   powershell -ExecutionPolicy Bypass -File docs\install-ocr-env.ps1
# 首次约 5~15 分钟（paddlepaddle 约 600MB + paddlex[ocr] 全套 + 模型权重首次启动下载）。
# Node 端 EnvRecoveryService 启动自检检测到缺失后，也会自动以本脚本恢复（无需人工）。

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Venv = Join-Path $Root '.venv-py'
$Py = Join-Path $Venv 'Scripts\python.exe'
$Pip = "$Py -m pip"
# pip 下载缓存持久化到项目卷：venv 包内容丢失后重装零下载
$env:PIP_CACHE_DIR = Join-Path $Root '.cache-pip'
New-Item -ItemType Directory -Force -Path $env:PIP_CACHE_DIR | Out-Null

# [1/5] venv（含 pip 缺失补齐——venv 目录残留但 site-packages 被清空的场景）
if (-not (Test-Path $Py)) {
    Write-Host '[1/5] 创建 venv...'
    & python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw "python -m venv 失败：请确认系统已安装 Python 3.11+（python --version）" }
}
& $Py -m pip install --quiet --upgrade pip
Write-Host "[1/5] venv 就绪：$Venv"

Write-Host '[2/5] 安装 Web/进程依赖（fastapi/uvicorn/psutil）...'
& $Py -m pip install --quiet --timeout 600 fastapi "uvicorn[standard]" python-multipart psutil

Write-Host '[3/5] 安装快速模式引擎（RapidOCR + OpenCV headless）...'
& $Py -m pip install --quiet --timeout 600 rapidocr-onnxruntime opencv-python-headless

Write-Host '[4/5] 安装精准模式引擎（PaddleOCR 3.7 + paddlepaddle 3.2.2，锁定版本：3.3.x 有 PIR 推理 bug）...'
& $Py -m pip install --quiet --timeout 900 "paddleocr==3.7.0" "paddlepaddle==3.2.2"

Write-Host '[5/5] 安装 PP-StructureV3 全链路依赖（paddlex[ocr]，版面/表格/公式）...'
& $Py -m pip install --quiet --timeout 900 "paddlex[ocr]==3.7.2"

Write-Host ''
Write-Host '===== 自检 ====='
$ok = 0; $fail = 0
foreach ($mod in @('fastapi','uvicorn','psutil','cv2','rapidocr_onnxruntime','paddle','paddleocr','paddlex')) {
    & $Py -c "import $mod" 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "  [OK] $mod"; $ok++ } else { Write-Host "  [FAIL] $mod"; $fail++ }
}
Write-Host "通过 $ok / $($ok + $fail) 项"
if ($fail -gt 0) { exit 1 }
Write-Host 'OCR 运行环境就绪。启动侧车：'
Write-Host "  & `"$Py`" ocr-engine\main3.py   # 默认 127.0.0.1:9301"
