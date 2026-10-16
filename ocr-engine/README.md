# OCR 侧车服务（本地识别主引擎）

试卷/作业图片的**本地文字识别**服务，作为项目"主识别功能"，远程 VLM（豆包）降为
语义切分与兜底。详见仓库根 `OCR-架构说明.md`。

## 引擎与双服务并存（3.x 已上生产，2.x 为回滚备份）

| 服务 | 脚本 | 端口 | 引擎 | 定位 |
|---|---|---|---|---|
| **3.x 主链路** | `main3.py` | 9001 | PaddleOCR 3.7.0 + PP-StructureV3（UVDoc 矫正/版面/OCR/阅读序） | **生产主引擎**（错题提取/去手写/文本面板/朝向） |
| 2.x 回滚备份 | `main.py` | 9000 | RapidOCR + PaddleOCR 2.7.3 融合 | 回滚备份（默认不驻留，见根目录 DEPLOY.md 第 6 章回滚步骤） |

> A/B 结论与摆正估计器 -16° 假峰溯源见根目录《侧车3.x-A_B试点与摆正估计器假峰溯源.md》（4 页编号召回持平、UVDoc 矫正后 OCR 行角中位数 0.00°、估计器边界饱和假峰机制）。生产切换 e2e 验证见 `/workspace/homework-eval/prod-switch-result.json`。

- **3.x 侧车（生产）**：PP-StructureV3 官方全链路（`use_doc_unwarping` UVDoc 矫正 → PP-DocLayout_plus-L 版面 → PP-OCRv5_server OCR → 阅读序恢复）。CPU 单页 ~18s（2.x 逐块 OCR 一页可达 26min）。
- **坐标保真（生产默认）**：Node 侧 supervisor 启动 3.x 时注入 `PPSV3_UNWARP=0` / `PPSV3_ORIENT_CLS=0`——UVDoc/朝向分类会改变输出几何，而输出 box 必须留在**输入图坐标系**才能与彩色笔迹掩膜匹配；摆正诉求另起专用实例（探针脚本自行置 1，勿在生产链路改）。
- **2.x 侧车（回滚）**：RapidOCR(ONNX) 与 PaddleOCR PP-OCRv5 同时运行、按置信度择优融合，任一失败不影响另一条。仅当 3.x 侧车不可用时按 DEPLOY.md 步骤切回。
- **版本红线**：3.x 侧车必须跑在隔离 venv（`/opt/pocr3-venv`，paddlepaddle **≤3.2.2**——3.3.x 在 AMD EPYC 上 oneDNN PIR 崩溃，详见根目录《PaddleOCR3.x升级评估与PP-StructureV3实测报告.md》）。

## 接口

**3.x（main3.py, :9001，生产主引擎）**
- `GET /healthz` → `{status, service:"ppsv3", dry_run, paddle}`
- `POST /ppsv3` body `{image_url | image_base64 | image_path, return_image}` → `{blocks:[{label,bbox,order,num_lines,content}], block_count, text_regions:[{text,box,quad,score}], angle, width, height, rectified_image_base64?, elapsed_ms, engine, paddle_version}`
  （`quad` = PP-OCRv5 检测四边形四点 [[x,y]×4]，文本行倾斜度的可靠度量；轴对齐 `box` 测不了行角）
- `POST /ppsv3/rectify` → 仅 UVDoc 矫正（`return_image` 强制 true）
- `POST /orient` → PP-LCNet 整页朝向单模型分类 `{angle, scores, method}`；契约：`class N` = 内容当前顺时针旋转 N×90°，**校正角 = ((4-class)%4)×90**（替代 2.x 的四向投票，Node 侧 `ocrAngleFromSidecar()` 走此端点或工具式）
- 工具式单次（Node `toolOcr` spawn，stdin 进图、`<<<OCR_RESULT>>>` 哨兵出 JSON）：
  - `python main3.py --once --op ppsv3 --image <path>` 或 stdin 进图
  - `python main3.py --once --op orient --image <path>`（容忍 `--mode` 参数占位）
  - `python main3.py --once --op rectify --image <path>`

**2.x（main.py, :9000，回滚备份）**
- `GET /healthz` → `{status, dry_run, mode}`
- `POST /recognize` body `{image_url | image_base64, mode}` → `{raw_text, text_regions, layout, tables, formulas, confidence, engine_used, low_confidence}`
- `POST /orient` → 4 向朝向投票 `{angle, scores, method}`
- 工具式：`python main.py --once --op recognize|orient --mode both --image <path>`

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCR_ENGINE_MODE` | `both` | 2.x：`both` / `rapid` / `paddle` |
| `OCR_DEVICE` | `cpu` | 2.x：`cpu` / `gpu` |
| `OCR_LOW_CONF_THRESHOLD` | `0.6` | 2.x：低于则触发 Node 端 VLM 兜底 |
| `OCR_DRY_RUN` | `0` | `1` 时不加载模型，返回样例结构（契约验证用） |
| `OCR_HOST` / `OCR_PORT` | `127.0.0.1` / `9000` | 2.x（回滚备份）监听地址 |
| `PPSV3_PORT` | `9001` | 3.x（生产主引擎）监听端口 |
| `PPSV3_DEVICE` | `cpu` | 3.x 推理设备 |
| `PPSV3_UNWARP` | `1` | 3.x UVDoc 矫正开关；**生产默认由 Node 侧 supervisor 注入 `0`（坐标保真，勿改）** |
| `PPSV3_ORIENT_CLS` | `1` | 3.x 整页方向分类开关；**生产默认由 Node 侧 supervisor 注入 `0`（坐标保真，勿改）** |
| `PPSV3_LAYOUT_MODEL` | `PP-DocLayout_plus-L` | 3.x 版面模型 |

Node 侧托管环境变量：`PPSV3_URL`（默认 `http://127.0.0.1:9001`）、`PPSV3_PYTHON`
（默认 `/opt/pocr3-venv/bin/python`）、`PPSV3_SUPERVISE`（`auto`/`1`/`0`）、
`PPSV3_IDLE_TIMEOUT_MS`（默认 15min，3.x 管线驻留 ~2-3GB 需及时回收）。

## 本地运行

```bash
# 3.x（隔离 venv，一次性搭建）——生产主引擎
python3.11 -m venv /opt/pocr3-venv
/opt/pocr3-venv/bin/pip install "paddlepaddle==3.2.2" "paddleocr==3.7.0" "paddlex[ocr]==3.7.2" fastapi uvicorn
/opt/pocr3-venv/bin/python main3.py  # 默认 127.0.0.1:9001

# 2.x（系统 python）——回滚备份
pip install -r requirements.txt
python main.py                       # 默认 127.0.0.1:9000
OCR_DRY_RUN=1 python main.py        # 不下载模型，先验证 HTTP 契约
```

## 部署提示（平台侧）
- 由平台作为**独立进程**部署（不在 Node 单进程内），Node 通过 `PPSV3_URL` HTTP 调用 3.x（生产主引擎）。
- 3.x 管线驻留 ~2-3GB，Node supervisor 按 `PPSV3_IDLE_TIMEOUT_MS`（默认 15min）空闲回收；2.x 回滚备份默认不驻留，仅在切回时启动。
- 首次启动会下载模型权重（需出网或预置 `~/.paddlex/official_models`）。
- CPU 部署用 mobile/server 轻量档；高并发建议 GPU + 多 worker。
- 部署与回滚完整步骤见根目录 `DEPLOY.md` 第 6 章。
