# OCR 侧车服务（本地识别主引擎）

试卷/作业图片的**本地文字识别**服务，作为项目"主识别功能"，远程 VLM（豆包）降为
语义切分与兜底。详见仓库根 `OCR-架构说明.md`。

## 引擎
- **RapidOCR**（ONNX，CPU 友好，快）—— 互为备份之一
- **PaddleOCR 3.0**：PP-OCRv5（中文印刷+手写）+ PP-StructureV3（版面/表格/公式）—— 互为备份之二

两者同时运行、按置信度择优融合，任一引擎失败不影响另一条。

## 接口
- `GET /healthz` → `{status, dry_run, mode}`
- `POST /recognize` body:
  ```json
  { "image_url": "https://...", "mode": "both" }
  // 或 { "image_base64": "<base64>", "mode": "both" }
  ```
  返回：`{ raw_text, text_regions:[{text,box,score}], layout:[{type,box,text}],
  tables, formulas, confidence, engine_used, low_confidence }`

## 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `OCR_ENGINE_MODE` | `both` | `both` / `rapid` / `paddle` |
| `OCR_DEVICE` | `cpu` | `cpu` / `gpu`（GPU 需换 `onnxruntime-gpu`） |
| `OCR_LOW_CONF_THRESHOLD` | `0.6` | 低于则 `low_confidence=true`，触发 Node 端 VLM 兜底 |
| `OCR_DRY_RUN` | `0` | `1` 时不加载模型，返回样例结构（契约验证用） |
| `OCR_HOST` / `OCR_PORT` | `127.0.0.1` / `9000` | 监听地址 |

## 本地运行
```bash
pip install -r requirements.txt
python main.py                       # 默认 127.0.0.1:9000
OCR_DRY_RUN=1 python main.py        # 不下载模型，先验证 HTTP 契约
```

## 部署提示（平台侧）
- 由平台作为**独立进程**部署（不在 Node 单进程内），Node 通过 `OCR_ENGINE_URL`
  （默认 `http://127.0.0.1:9000`）HTTP 调用。
- 首次启动会下载 PaddleOCR / RapidOCR 模型权重（需出网或预置 `MODEL_DIR`）。
- CPU 部署用 mobile 档模型即可；高并发建议 GPU + 多 worker。
