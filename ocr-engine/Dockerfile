# OCR 侧车镜像（独立部署，由平台单独起进程）
FROM python:3.11-slim

WORKDIR /app

# 系统依赖（opencv/numpy 编译需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# 配置通过环境变量注入：
#   OCR_ENGINE_MODE=both | rapid | paddle
#   OCR_DEVICE=cpu | gpu
#   OCR_LOW_CONF_THRESHOLD=0.6
#   OCR_DRY_RUN=0
EXPOSE 9000
CMD ["python", "main.py", "--host", "0.0.0.0", "--port", "9000"]
