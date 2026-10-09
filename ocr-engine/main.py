#!/usr/bin/env python3
"""
OCR 侧车服务（PaddleOCR 3.0 全家桶 + RapidOCR 互为备份）

设计要点：
- 双引擎互为备份：RapidOCR(ONNX, CPU 友好) 与 PaddleOCR PP-OCRv5 + PP-StructureV3
  (版面/表格/公式) 同时运行，按置信度择优融合文本区域。
- 重依赖（paddleocr / rapidocr_onnxruntime）延迟导入：--dry-run 与 import 检查
  不依赖它们，便于 CI/契约验证。
- 输出契约（供 Node 端 LocalOcrClient 消费）：
    {
      raw_text: str,                       # 按阅读顺序拼接的全文
      text_regions: [{text, box, score}], # box = [x0,y0,x1,y1]（ axis-aligned 包围盒）
      layout: [{type, box, text}],        # 仅 PaddleOCR/PP-StructureV3 提供
      tables: [...], formulas: [...],
      confidence: float,                  # 融合后平均置信度
      engine_used: [str],                 # 实际成功运行的引擎名
      low_confidence: bool                # 是否低于阈值（触发 VLM 兜底）
    }

运行：
  python main.py                         # 默认 127.0.0.1:9000
  python main.py --port 9000 --host 0.0.0.0
  OCR_DRY_RUN=1 python main.py          # 不加载模型，/recognize 返回样例结构（契约验证用）
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ---------- 配置 ----------
OCR_ENGINE_MODE = os.getenv("OCR_ENGINE_MODE", "both")   # both | rapid | paddle
OCR_DEVICE = os.getenv("OCR_DEVICE", "cpu")              # cpu | gpu
OCR_LOW_CONF_THRESHOLD = float(os.getenv("OCR_LOW_CONF_THRESHOLD", "0.6"))
DRY_RUN = os.getenv("OCR_DRY_RUN", "0") == "1"

app = FastAPI(title="OCR Engine Sidecar", version="1.0.0")

# 引擎实例缓存（延迟初始化）
_ENGINES: Dict[str, Any] = {}


# ---------- 请求/响应模型 ----------
class RecognizeRequest(BaseModel):
    image_url: Optional[str] = None        # 公网可达的图片 URL（优先）
    image_base64: Optional[str] = None     # 或 base64（可带 data: 前缀）
    mode: str = "both"                      # both | rapid | paddle


# ---------- 图像加载 ----------
def _load_image(req: RecognizeRequest):
    """返回 (cv2_bgr_ndarray, pil_image)。"""
    import cv2
    import numpy as np
    from PIL import Image

    raw: Optional[bytes] = None
    if req.image_base64:
        b64 = req.image_base64
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        raw = base64.b64decode(b64)
    elif req.image_url:
        with urllib.request.urlopen(req.image_url, timeout=20) as resp:  # nosec B310（部署时限定来源）
            raw = resp.read()
    if not raw:
        raise HTTPException(status_code=400, detail="image_url 或 image_base64 必须提供一个")

    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    bgr = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    return bgr, pil


# ---------- 引擎：RapidOCR ----------
def _get_rapid() -> Any:
    if "rapid" not in _ENGINES:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINES["rapid"] = RapidOCR()
    return _ENGINES["rapid"]


def _run_rapid(bgr) -> List[Dict[str, Any]]:
    out = _get_rapid()(bgr)
    # 兼容 rapidocr_onnxruntime 的返回结构演进：
    #   - 新版（>=1.4）：2-tuple ( [ [box, text, score], ... ], <meta> )
    #   - 旧版：3-tuple ( boxes, txts, scores )
    #   - 对象式：含 .boxes/.txts/.scores 属性
    items: List[Tuple] = []
    if isinstance(out, tuple) and len(out) >= 1 and isinstance(out[0], (list, tuple)):
        first = out[0][0] if out[0] and isinstance(out[0], (list, tuple)) else None
        if isinstance(first, (list, tuple)) and len(first) >= 3:
            # 新版：每层是 [box, text, score]
            items = [tuple(x) for x in out[0]]
        elif len(out) == 3:
            boxes, txts, scores = out
            items = list(zip(boxes or [], txts or [], scores or []))
    elif hasattr(out, "txts"):
        items = list(zip(out.boxes or [], out.txts or [], out.scores or []))
    regions: List[Dict[str, Any]] = []
    for box, txt, score in items:
        t = txt[0] if isinstance(txt, (list, tuple)) else txt
        s = float(score[0] if isinstance(score, (list, tuple)) else score)
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        regions.append({"text": str(t), "box": [min(xs), min(ys), max(xs), max(ys)], "score": s})
    return regions


# ---------- 引擎：PaddleOCR + PP-StructureV3 ----------
def _get_paddle() -> Any:
    if "paddle" not in _ENGINES:
        from paddleocr import PaddleOCR
        _ENGINES["paddle"] = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    return _ENGINES["paddle"]


def _run_paddle(bgr) -> List[Dict[str, Any]]:
    res = _get_paddle().ocr(bgr, cls=True)
    regions: List[Dict[str, Any]] = []
    if not res or not res[0]:
        return regions
    for line in res[0]:
        box, (txt, score) = line[0], line[1]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        regions.append({"text": str(txt), "box": [min(xs), min(ys), max(xs), max(ys)], "score": float(score)})
    return regions


def _run_structure(pil) -> Dict[str, Any]:
    """PP-StructureV3 版面/表格/公式（可选，失败不影响文字提取）。"""
    try:
        from ppstructurev3 import PPSStructureV3
        if "structure" not in _ENGINES:
            _ENGINES["structure"] = PPSStructureV3()
        out = _ENGINES["structure"](pil)
        layout = []
        for block in (out.get("text_regions") or []) if isinstance(out, dict) else []:
            if isinstance(block, dict) and block.get("bbox"):
                b = block["bbox"]
                layout.append({"type": block.get("type", "text"), "box": list(b)[:4], "text": block.get("text", "")})
        return {
            "layout": layout,
            "tables": out.get("tables") if isinstance(out, dict) else [],
            "formulas": out.get("formulas") if isinstance(out, dict) else [],
        }
    except Exception:
        return {"layout": [], "tables": [], "formulas": []}


# ---------- 融合 ----------
def _iou(a: List[float], b: List[float]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0.0
    a_area = max(0, ax1 - ax0) * max(0, ay1 - ay0)
    b_area = max(0, bx1 - bx0) * max(0, by1 - by0)
    return inter / (a_area + b_area - inter + 1e-6)


def _fuse(regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按置信度降序贪心去重（IoU>0.5 视为同一区域，保留高分）。"""
    ordered = sorted(regions, key=lambda r: r["score"], reverse=True)
    kept: List[Dict[str, Any]] = []
    for r in ordered:
        if any(_iou(r["box"], k["box"]) > 0.5 for k in kept):
            continue
        kept.append(r)
    # 阅读顺序：先按 y 中心，再按 x 中心
    kept.sort(key=lambda r: (round((r["box"][1] + r["box"][3]) / 2 / 30), r["box"][0]))
    return kept


def recognize_with_fusion(req: RecognizeRequest) -> Dict[str, Any]:
    bgr, pil = _load_image(req)
    mode = req.mode if req.mode in ("both", "rapid", "paddle") else OCR_ENGINE_MODE
    regions: List[Dict[str, Any]] = []
    engine_used: List[str] = []

    if mode in ("both", "rapid"):
        try:
            regions += _run_rapid(bgr)
            engine_used.append("rapidocr")
        except Exception as e:  # 互为备份：单引擎失败不影响另一条
            print(f"[ocr] RapidOCR 失败: {e}", flush=True)
    if mode in ("both", "paddle"):
        try:
            regions += _run_paddle(bgr)
            engine_used.append("paddleocr")
        except Exception as e:
            print(f"[ocr] PaddleOCR 失败: {e}", flush=True)

    fused = _fuse(regions)
    structure = _run_structure(pil) if "paddleocr" in engine_used else {"layout": [], "tables": [], "formulas": []}

    raw_text = "\n".join(r["text"] for r in fused)
    conf = sum(r["score"] for r in fused) / len(fused) if fused else 0.0
    return {
        "raw_text": raw_text,
        "text_regions": fused,
        "layout": structure["layout"],
        "tables": structure["tables"],
        "formulas": structure["formulas"],
        "confidence": round(conf, 3),
        "engine_used": engine_used,
        "low_confidence": (len(fused) == 0) or (conf < OCR_LOW_CONF_THRESHOLD),
    }


# ---------- 路由 ----------
@app.get("/healthz")
def healthz():
    return {"status": "ok", "dry_run": DRY_RUN, "mode": OCR_ENGINE_MODE}


@app.post("/recognize")
def recognize(req: RecognizeRequest):
    if DRY_RUN:
        # 不加载模型的样例返回，仅用于 HTTP 契约验证
        return {
            "raw_text": "一、填空题\n1. 春眠不觉晓，处处闻啼鸟。\n2. 床前明月光，疑是地上霜。",
            "text_regions": [
                {"text": "一、填空题", "box": [60, 120, 300, 160], "score": 0.97},
                {"text": "1. 春眠不觉晓，处处闻啼鸟。", "box": [60, 200, 900, 240], "score": 0.95},
                {"text": "2. 床前明月光，疑是地上霜。", "box": [60, 260, 900, 300], "score": 0.94},
            ],
            "layout": [{"type": "text", "box": [60, 120, 900, 300], "text": ""}],
            "tables": [],
            "formulas": [],
            "confidence": 0.953,
            "engine_used": ["dry-run"],
            "low_confidence": False,
        }
    try:
        return recognize_with_fusion(req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR 识别失败: {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("OCR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("OCR_PORT", "9000")))
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
