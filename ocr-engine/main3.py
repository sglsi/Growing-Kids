#!/usr/bin/env python3
"""
OCR 侧车 3.x 服务（PaddleOCR 3.7.0 + PP-StructureV3 全链路）

定位：**生产主 OCR 引擎**（2026-10-15 起，替换 2.x 融合侧车 main.py :9300）。
  2.x 侧车（main.py, :9300）：rapid + paddle 双引擎融合 + 自建 orient 四向投票——降级为回滚备份，
    生产代码不再引用（LocalOcrClient / getSidecarSupervisor 仅探针与回滚用）。
  3.x 侧车（本服务）：PP-StructureV3 官方管线（UVDoc 矫正 → 版面检测 → OCR → 阅读序）
    + DocImgOrientationClassification 朝向分类（替代 2.x 的 orient 四向投票）。

设计要点（与 main.py 同构）：
- 重依赖（paddleocr）延迟导入：--dry-run 与 import 检查不依赖它
- 管线单例延迟初始化（首次请求加载，~9s）；_INFER_LOCK 串行化推理（ONNX/Paddle 实例非线程安全）
- 端口默认 9301（PPSV3_PORT 可改）；健康检查 /healthz 供 Node 侧 SidecarSupervisor 托管
- 版本红线：paddlepaddle 必须 ≤3.2.2（3.3.x 在 AMD EPYC 上 oneDNN PIR 崩溃，见升级评估报告）

坐标保真（生产默认，由 Node 侧 getPpsv3Supervisor 注入 env）：
  PPSV3_UNWARP=0 / PPSV3_ORIENT_CLS=0 —— 错题提取的 box 要与彩色笔迹掩膜在原图坐标系上匹配，
  UVDoc/朝向分类会改变输出几何，坐标即错位。摆正（UVDoc）诉求走 /ppsv3/rectify 端点：
  该端点用**独立 UVDoc 轻量单例**（TextImageUnwarping，与 PPSV3_UNWARP 无关，同进程共存），
  不走完整 PP-StructureV3 管线——OCR 实例保持坐标保真，矫正端点始终真正矫正。

端点：
  POST /ppsv3          全链路：矫正 + 版面块 + OCR 文本 + 阅读序
  POST /ppsv3/rectify  仅 UVDoc 矫正（独立轻量单例，治「投影式转正转歪」，~4.4s/页 CPU）
  POST /orient         整页朝向分类（0/90/180/270 校正角，PP-LCNet 单模型，替代四向投票）
  GET  /healthz

运行：
  python main3.py                          # 默认 127.0.0.1:9301（venv python）
  PPSV3_PORT=9301 python main3.py --port 9301
  python main3.py --once --op ppsv3 --image /path/to.webp   # 工具式单次（探针/生产 base64 路径用）
  cat img.png | python main3.py --once --op orient          # stdin 进图（Node 工具式调用契约）
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

# 模型缓存持久化：HOME(/root) 在沙箱重置后不丢内容但有清理风险，指到项目卷保证命中
# 平台自适应：Linux 沙箱走 /workspace/projects（扣子卷）；Windows 本机走项目根目录，
# 避免 C:\Users\<name>\.paddlex 随用户目录被清理，也保证模型权重跨重启命中。
if sys.platform == "win32":
    _REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.path.join(_REPO_ROOT, ".cache-paddlex"))
    os.environ.setdefault("XDG_CACHE_HOME", os.path.join(_REPO_ROOT, ".cache-paddle-xdg"))
else:
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", "/workspace/projects/.cache-paddlex")
    os.environ.setdefault("XDG_CACHE_HOME", "/workspace/projects/.cache-paddle-xdg")

# ---------------------------------------------------------------------------
# paddlepaddle 3.3.x 在 CPU 上的 oneDNN/PIR 回归（2026-10-31 定位并修复）
#
# 症状：走 paddle/PP-StructureV3 推理必抛
#   NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute
#   not support [pir::ArrayAttribute<pir::DoubleAttribute>]
#   (at new_executor/instruction/onednn/onednn_instruction.cc:116)
#
# 根因（PaddlePaddle/Paddle#77340）：3.3.0 起 PIR 执行器默认启用 oneDNN(MKLDNN)，
# 属性转换在 CPU 路径有回归；官方修复 #77430 只合到 develop，**从未回植 3.3.x**。
# ⚠️ 已证伪、别再试：FLAGS_use_mkldnn=0 / FLAGS_enable_pir_in_executor=0 /
#    FLAGS_enable_pir_api=0（paddle 层 FLAGS，管不到 PaddleX 自己默认打开的 oneDNN）。
# ✅ 有效的是 PaddleX 层这一个，必须在 import paddleocr 之前设置（本文件下方才是重依赖导入）。
# 代价：关掉 oneDNN 后推理慢 3~6 倍，换来「能用」，且保住 3.3.1 才有的模型与能力。
# 同步说明：main.py 顶部有同一段，两处必须一致（精准链路走本文件，快速链路走 main.py）。
# ---------------------------------------------------------------------------
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Paddle/PaddleX 推理实例非线程安全：FastAPI 同步路由用线程池并发，必须串行化。
_INFER_LOCK = threading.Lock()

PPSV3_PORT = int(os.getenv("PPSV3_PORT", "9301"))
PPSV3_DEVICE = os.getenv("PPSV3_DEVICE", "cpu")
PPSV3_UNWARP = os.getenv("PPSV3_UNWARP", "1") == "1"          # UVDoc 矫正开关
PPSV3_ORIENT_CLS = os.getenv("PPSV3_ORIENT_CLS", "1") == "1"  # 整页方向分类开关
PPSV3_LAYOUT_MODEL = os.getenv("PPSV3_LAYOUT_MODEL", "PP-DocLayout_plus-L")
# 识别引擎版本（#142 实测决策，2026-10-15）：
#   默认空 = PP-OCRv5_server（现生产）；PP-OCRv6_medium 实测编号召回持平（93/96 vs 93/96），
#   平均置信度 +0.03~0.07、单页快 17%——收益真实但非召回级，故默认不变、env 灰度开启。
# ⚠️ 问题③复测（2026-10-20）实锤：CPU 上 server 档单页纯推理 118s（blocks=29），
#   叠加 _INFER_LOCK 串行排队，后续请求 elapsed 冲到 600-800s，前端 180s 预算必爆
#   （侧车日志 [ppsv3] 完成 ...ms 实证）。
#   故：device=cpu 且未显式指定模型时，det/rec 默认降档 mobile（CPU 单页约 15-30s，
#   印刷体精度对错题裁剪识别够用）；GPU 或显式 env 指定时保持原档位不变。
_CPU_MOBILE_DEFAULT = PPSV3_DEVICE == "cpu"
PPSV3_DET_MODEL = os.getenv("PPSV3_DET_MODEL", "") or ("PP-OCRv5_mobile_det" if _CPU_MOBILE_DEFAULT else None)
PPSV3_REC_MODEL = os.getenv("PPSV3_REC_MODEL", "") or ("PP-OCRv5_mobile_rec" if _CPU_MOBILE_DEFAULT else None)
DRY_RUN = os.getenv("OCR_DRY_RUN", "0") == "1"

app = FastAPI(title="OCR Engine Sidecar 3.x (PP-StructureV3)", version="3.0.0")

# 管线单例（延迟初始化）
_PIPELINE: Any = None
_PIPELINE_LOCK = threading.Lock()

# 朝向分类单例（PP-LCNet_x1_0_doc_ori，独立于 PP-StructureV3，轻量）
_ORIENT_PIPELINE: Any = None
_ORIENT_LOCK = threading.Lock()

# UVDoc 矫正单例（TextImageUnwarping，独立于 PP-StructureV3 与 PPSV3_UNWARP 开关）：
# 摆正链路（straightenImage）专用——OCR 实例 PPSV3_UNWARP=0 保持坐标保真，
# 矫正端点必须真正 unwarp，故单独加载轻量 UVDoc（~0.9s 加载 / ~4.4s 每页 CPU）。
_UVDOC_PIPELINE: Any = None
_UVDOC_LOCK = threading.Lock()

# Node 工具式调用契约：结果以哨兵单行 JSON 打到 stdout（与 2.x main.py 一致）
_RESULT_MARKER = "<<<OCR_RESULT>>>"


def _get_orient_pipeline():
    """延迟加载整页朝向分类（PP-LCNet，~1s）。失败抛 503 让调用方降级。"""
    global _ORIENT_PIPELINE
    with _ORIENT_LOCK:
        if _ORIENT_PIPELINE is not None:
            return _ORIENT_PIPELINE
        if DRY_RUN:
            return None
        try:
            from paddleocr import DocImgOrientationClassification

            t0 = time.time()
            _ORIENT_PIPELINE = DocImgOrientationClassification(device=PPSV3_DEVICE)
            print(f"[ppsv3] 朝向分类初始化完成 {time.time()-t0:.1f}s", flush=True)
            return _ORIENT_PIPELINE
        except Exception as e:
            print(f"[ppsv3] 朝向分类初始化失败: {type(e).__name__}: {e}", flush=True)
            raise HTTPException(status_code=503, detail=f"朝向分类初始化失败: {e}")


def _classify_orientation(path: str) -> Dict[str, Any]:
    """PP-LCNet doc_ori：class N 表示内容当前顺时针旋转了 N×90°。

    实测标定（p1 四向旋转）：CCW0→class0 / CCW90→class3 / CCW180→class2 / CCW270→class1。
    故需施加的校正角（sharp.rotate 语义，正=顺时针）= ((4 - class) % 4) × 90。
    """
    pipeline = _get_orient_pipeline()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    with _INFER_LOCK:
        res = next(iter(pipeline.predict(path)))
    d = res.to_dict() if hasattr(res, "to_dict") else res
    class_id = int(d["class_ids"][0][0]) if d.get("class_ids") else 0
    score = float(d["scores"][0]) if d.get("scores") else 0.0
    angle = ((4 - class_id) % 4) * 90
    return {"angle": angle, "class_id": class_id, "confidence": round(score, 3)}


def _get_uvdoc_pipeline():
    """延迟加载独立 UVDoc（TextImageUnwarping，~0.9s）。失败抛 503 让调用方降级到投影估计器。"""
    global _UVDOC_PIPELINE
    with _UVDOC_LOCK:
        if _UVDOC_PIPELINE is not None:
            return _UVDOC_PIPELINE
        if DRY_RUN:
            return None
        try:
            from paddleocr import TextImageUnwarping

            t0 = time.time()
            _UVDOC_PIPELINE = TextImageUnwarping(model_name="UVDoc", device=PPSV3_DEVICE)
            print(f"[ppsv3] UVDoc 矫正初始化完成 {time.time()-t0:.1f}s", flush=True)
            return _UVDOC_PIPELINE
        except Exception as e:
            print(f"[ppsv3] UVDoc 初始化失败: {type(e).__name__}: {e}", flush=True)
            raise HTTPException(status_code=503, detail=f"UVDoc 初始化失败: {e}")


def _run_rectify(path: str) -> Dict[str, Any]:
    """仅 UVDoc 矫正：返回矫正后图的 base64（PNG）+ 尺寸。

    与 /ppsv3 的区别：不走完整 PP-StructureV3 管线（版面/OCR 全跳过），
    也不受 PPSV3_UNWARP 影响——矫正端点恒定真正 unwarp，供摆正链路消费。
    """
    pipeline = _get_uvdoc_pipeline()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    t0 = time.time()
    with _INFER_LOCK:
        res = next(iter(pipeline.predict(path)))
    d = res.to_dict() if hasattr(res, "to_dict") else res
    import numpy as np

    img = d.get("doctr_img")
    if img is None:
        raise HTTPException(status_code=500, detail="UVDoc 未返回矫正图（doctr_img 缺失）")
    arr = np.asarray(img)
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    from PIL import Image

    pil = Image.fromarray(arr)
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    h, w = arr.shape[:2]
    elapsed = round((time.time() - t0) * 1000)
    print(f"[ppsv3] UVDoc 矫正完成 {w}x{h} {elapsed}ms", flush=True)
    return {
        "rectified_image_base64": base64.b64encode(buf.getvalue()).decode(),
        "width": int(w),
        "height": int(h),
        "elapsed_ms": elapsed,
        "engine": "uvdoc",
    }


# ---------- ④ PaddleOCR-VL：手写答案识别（#143） ----------
# 定位：错题块裁图的「学生手写答案」识别增强。PP-OCRv5 是印刷文本优化模型，
# 手写答案（如 used to do sth.）识别质量差；PaddleOCR-VL-0.9B 是文档解析 VLM，
# 对上下文中的手写/印刷混合内容更强。
# ⚠️ 内存门槛：模型 ~1.8GB + CPU 推理激活，实测峰值 >8GB（沙箱 cgroup 8GB 直接 OOM）。
#    故由 Node 侧 OCR_VL_HANDWRITE 门控（默认关），生产内存充足才启用；
#    加载失败抛 503，调用方静默回落 v5 链路。
_VL_PIPELINE: Any = None
_VL_LOCK = threading.Lock()


def _get_vl_pipeline():
    """延迟加载 PaddleOCR-VL（0.9B，文档解析 VLM）。失败抛 503 让调用方降级。"""
    global _VL_PIPELINE
    with _VL_LOCK:
        if _VL_PIPELINE is not None:
            return _VL_PIPELINE
        if DRY_RUN:
            return None
        # 内存护栏：VL 模型 ~1.8GB + CPU 推理激活，实测峰值 >8GB（沙箱 cgroup 8GB 直接
        # OOM，且会连坐杀死同进程的 PP-StructureV3 主实例）。可用内存 <10GB 拒绝加载，
        # 抛 503 让 Node 侧静默回落 v5——宁可功能不可用，不拖垮整个侧车。
        # ⚠️ 必须读 cgroup 限额而非 /proc/meminfo：容器里 meminfo 显示的是宿主值
        #   （沙箱宿主 123GB，cgroup 实际只有 8GB，曾因此护栏失效被 OOM 连坐）。
        avail_gb: Optional[float] = None
        try:
            with open("/sys/fs/cgroup/memory.max") as f:
                limit = f.read().strip()
            if limit != "max":
                limit_b = int(limit)
                with open("/sys/fs/cgroup/memory.current") as f:
                    cur_b = int(f.read().strip())
                avail_gb = (limit_b - cur_b) / 1024 ** 3
        except Exception:
            try:
                with open("/proc/meminfo") as f:
                    for line in f:
                        if line.startswith("MemAvailable:"):
                            avail_gb = int(line.split()[1]) / 1024 / 1024
                            break
            except Exception:
                pass
        if avail_gb is not None and avail_gb < 10:
            raise HTTPException(
                status_code=503,
                detail=f"PaddleOCR-VL 需要约 10GB 可用内存，当前仅 {avail_gb:.1f}GB",
            )
        try:
            from paddleocr import PaddleOCRVL

            t0 = time.time()
            # 输入已是切好的题块：跳过朝向/unwarp/版面检测，只留 VL 识别本体
            _VL_PIPELINE = PaddleOCRVL(
                device=PPSV3_DEVICE,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_layout_detection=False,
            )
            print(f"[ppsv3] PaddleOCR-VL 初始化完成 {time.time()-t0:.1f}s", flush=True)
            return _VL_PIPELINE
        except Exception as e:
            print(f"[ppsv3] PaddleOCR-VL 初始化失败: {type(e).__name__}: {e}", flush=True)
            raise HTTPException(status_code=503, detail=f"PaddleOCR-VL 初始化失败: {e}")


def _run_vl(path: str) -> Dict[str, Any]:
    """PaddleOCR-VL 整块识别：返回文本（markdown/纯文本拼接）。"""
    pipeline = _get_vl_pipeline()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    t0 = time.time()
    with _INFER_LOCK:
        res = next(iter(pipeline.predict(path)))
    d = res.to_dict() if hasattr(res, "to_dict") else res
    texts: List[str] = []
    for b in d.get("parsing_res_list") or []:
        bd = b.to_dict() if hasattr(b, "to_dict") else b
        c = bd.get("content")
        if c:
            texts.append(str(c))
    if not texts:
        for t in (d.get("overall_ocr_res") or {}).get("rec_texts") or []:
            texts.append(str(t))
    elapsed = round((time.time() - t0) * 1000)
    print(f"[ppsv3] VL 识别完成 {elapsed}ms 文本 {sum(len(t) for t in texts)} 字符", flush=True)
    return {"text": "\n".join(texts).strip(), "elapsed_ms": elapsed, "engine": "paddleocr-vl"}


def _get_pipeline():
    """延迟加载 PP-StructureV3（首次 ~9s，之后复用）。失败抛 503 让调用方降级。"""
    global _PIPELINE
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE
        if DRY_RUN:
            return None
        try:
            from paddleocr import PPStructureV3

            t0 = time.time()
            kw = dict(
                layout_detection_model_name=PPSV3_LAYOUT_MODEL,
                use_doc_orientation_classify=PPSV3_ORIENT_CLS,
                use_doc_unwarping=PPSV3_UNWARP,
                # 作业/错题场景不需要的模块全部关闭（CPU 上省时）
                use_formula_recognition=False,
                use_chart_recognition=False,
                use_seal_recognition=False,
                use_table_recognition=False,
                device=PPSV3_DEVICE,
            )
            # #142：识别引擎版本切换（默认 v5_server 现生产；env 显式指定才升级）
            if PPSV3_DET_MODEL:
                kw["text_detection_model_name"] = PPSV3_DET_MODEL
            if PPSV3_REC_MODEL:
                kw["text_recognition_model_name"] = PPSV3_REC_MODEL
            _PIPELINE = PPStructureV3(**kw)
            print(f"[ppsv3] 管线初始化完成 {time.time()-t0:.1f}s（layout={PPSV3_LAYOUT_MODEL} det={PPSV3_DET_MODEL or 'PP-OCRv5_server'} rec={PPSV3_REC_MODEL or 'PP-OCRv5_server'} unwarp={PPSV3_UNWARP} orient={PPSV3_ORIENT_CLS} device={PPSV3_DEVICE}）", flush=True)
            return _PIPELINE
        except Exception as e:
            print(f"[ppsv3] 管线初始化失败: {type(e).__name__}: {e}", flush=True)
            raise HTTPException(status_code=503, detail=f"PP-StructureV3 初始化失败: {e}")


# ---------- 请求模型 ----------
class Ppsv3Request(BaseModel):
    image_base64: Optional[str] = None   # 可带 data: 前缀
    image_url: Optional[str] = None      # 公网可达 URL
    image_path: Optional[str] = None     # 本地路径（探针用）
    return_image: bool = True            # 是否返回矫正后图像（base64 PNG）


def _load_image_path(req: Ppsv3Request) -> str:
    """三种输入 → 本地临时文件路径（paddlex predict 接受路径）。"""
    import tempfile

    if req.image_path:
        if not os.path.exists(req.image_path):
            raise HTTPException(status_code=400, detail=f"image_path 不存在: {req.image_path}")
        return req.image_path
    raw: Optional[bytes] = None
    if req.image_base64:
        b64 = req.image_base64
        if "," in b64 and b64.strip().startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"base64 解码失败: {e}")
    elif req.image_url:
        try:
            with urllib.request.urlopen(req.image_url, timeout=30) as resp:
                raw = resp.read()
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"URL 下载失败: {e}")
    if not raw:
        raise HTTPException(status_code=400, detail="必须提供 image_base64 / image_url / image_path 之一")
    from PIL import Image

    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    pil.save(tmp.name)
    tmp.close()
    return tmp.name


def _extract_result(res: Any, want_image: bool) -> Dict[str, Any]:
    """LayoutParsingResultV2 → Node 侧消费的契约结构。"""
    import cv2
    import numpy as np

    # 版面块
    blocks: List[Dict[str, Any]] = []
    for b in res["parsing_res_list"] or []:
        d = b.to_dict()
        bbox = [round(float(x), 1) for x in d["bbox"]]
        blocks.append({
            "label": d.get("label"),
            "bbox": bbox,
            "order": d.get("order_label"),
            "num_lines": d.get("num_of_lines"),
            "content": (str(d.get("content")) if d.get("content") is not None else ""),
        })
    # 矫正信息
    dp = res.get("doc_preprocessor_res") or {}
    angle = dp.get("angle") if isinstance(dp, dict) else None
    # 文本区域（overall_ocr_res：与 2.x 契约的 text_regions 对齐）
    text_regions: List[Dict[str, Any]] = []
    ocr = res.get("overall_ocr_res") or {}
    if isinstance(ocr, dict):
        rec_boxes = ocr.get("rec_boxes")
        rec_texts = ocr.get("rec_texts")
        rec_scores = ocr.get("rec_scores")
        dt_polys = ocr.get("dt_polys")
        rec_boxes = [] if rec_boxes is None else list(rec_boxes)
        rec_texts = [] if rec_texts is None else list(rec_texts)
        rec_scores = [] if rec_scores is None else list(rec_scores)
        dt_polys = [] if dt_polys is None else list(dt_polys)
        for i, t in enumerate(rec_texts):
            box = None
            if i < len(rec_boxes) and rec_boxes[i] is not None:
                box = [round(float(v), 1) for v in rec_boxes[i]]
            # dt_polys：检测四边形四点（文本行倾斜度的可靠度量，轴对齐框测不了行角）
            quad = None
            if i < len(dt_polys) and dt_polys[i] is not None:
                try:
                    quad = [[round(float(x), 1), round(float(y), 1)] for x, y in dt_polys[i]]
                except (TypeError, ValueError):
                    quad = None
            text_regions.append({
                "text": str(t),
                "box": box,
                "quad": quad,
                "score": round(float(rec_scores[i]), 3) if i < len(rec_scores) else None,
            })
    out: Dict[str, Any] = {
        "blocks": blocks,
        "block_count": len(blocks),
        "text_regions": text_regions,
        "angle": angle,
        "width": res.get("width"),
        "height": res.get("height"),
        "engine": "ppsv3",
        "paddle_version": _paddle_version(),
    }
    if want_image:
        img = dp.get("output_img") if isinstance(dp, dict) else None
        if img is not None:
            arr = np.asarray(img)
            if arr.ndim == 3:
                arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            ok, png = cv2.imencode(".png", arr)
            if ok:
                out["rectified_image_base64"] = base64.b64encode(png.tobytes()).decode()
    return out


def _paddle_version() -> Optional[str]:
    try:
        import paddle

        return paddle.__version__
    except Exception:
        return None


def _run_ppsv3(req: Ppsv3Request) -> Dict[str, Any]:
    pipeline = _get_pipeline()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    path = _load_image_path(req)
    queued_at = time.time()
    with _INFER_LOCK:
        t0 = time.time()  # elapsed 只计纯推理，不含 _INFER_LOCK 排队等待
        res = next(iter(pipeline.predict(path)))
    out = _extract_result(res, req.return_image)
    out["elapsed_ms"] = round((time.time() - t0) * 1000)
    out["queue_ms"] = round((t0 - queued_at) * 1000)
    print(f"[ppsv3] 完成 blocks={out['block_count']} angle={out['angle']} {out['elapsed_ms']}ms（排队 {out['queue_ms']}ms）", flush=True)
    return out


# ---------- 路由 ----------
@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "ppsv3", "dry_run": DRY_RUN, "paddle": _paddle_version()}


@app.post("/ppsv3")
def ppsv3(req: Ppsv3Request):
    if DRY_RUN:
        return {
            "blocks": [], "block_count": 0, "text_regions": [], "angle": None,
            "engine": "ppsv3-dryrun", "dry_run": True,
        }
    try:
        return _run_ppsv3(req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PP-StructureV3 推理失败: {e}")


@app.post("/ppsv3/rectify")
def rectify(req: Ppsv3Request):
    """仅 UVDoc 矫正（独立轻量单例，return_image 恒 True）。

    摆正链路（straightenImage）专用：OCR 实例 PPSV3_UNWARP=0 坐标保真，
    本端点恒定真正 unwarp。返回 {rectified_image_base64, width, height, elapsed_ms, engine}。
    """
    if DRY_RUN:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    try:
        path = _load_image_path(req)
        out = _run_rectify(path)
        return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"UVDoc 矫正失败: {e}")


class OrientRequest(BaseModel):
    image_base64: Optional[str] = None   # 可带 data: 前缀
    image_url: Optional[str] = None
    image_path: Optional[str] = None


@app.post("/vl/parse")
def vl_parse(req: Ppsv3Request):
    """④（#143）PaddleOCR-VL 手写答案识别：错题块裁图 → 文本。

    与 /ppsv3 的区别：不用 PP-OCRv5（印刷优化，手写差），改用 0.9B 文档解析 VLM，
    对「题干印刷 + 学生手写答案 + 红笔订正」混合内容的整块理解更强。
    由 Node 侧 OCR_VL_HANDWRITE 门控（默认关，VL 内存峰值 >8GB）；
    加载失败/超时抛错，调用方静默回落 v5 链路。返回 {text, elapsed_ms, engine}。
    """
    if DRY_RUN:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    try:
        path = _load_image_path(req)
        return _run_vl(path)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VL 识别失败: {e}")


@app.post("/orient")
def orient(req: OrientRequest):
    """整页朝向分类：返回需对输入图施加的旋转角（0/90/180/270，sharp 语义正=顺时针）。

    替代 2.x 的「四向 OCR 投票」——PP-LCNet 单模型直接四分类，~0.1s vs 4 次全量 OCR。
    Node 侧 image-orient.ts 消费；契约与 2.x /orient 一致（{angle, scores?}）。
    """
    if DRY_RUN:
        raise HTTPException(status_code=503, detail="DRY_RUN 模式无模型")
    try:
        path = _load_image_path(Ppsv3Request(
            image_base64=req.image_base64, image_url=req.image_url, image_path=req.image_path,
        ))
        out = _classify_orientation(path)
        return {"angle": out["angle"], "scores": {str(out["angle"]): out["confidence"]}, "class_id": out["class_id"], "confidence": out["confidence"]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"朝向分类失败: {e}")


# ---------- 工具式单次（探针/CI/Node 工具式调用，与 main.py --once 同构） ----------
def _read_stdin_image() -> Optional[str]:
    """stdin 进图（Node toolOcr 契约：图片字节走 stdin）→ 临时文件路径；无输入返回 None。"""
    import tempfile

    raw = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
    if not raw:
        return None
    from PIL import Image

    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    pil.save(tmp.name)
    tmp.close()
    return tmp.name


def _once(op: str, image: Optional[str]) -> None:
    if op not in ("ppsv3", "rectify", "orient", "vl"):
        print(f"未知 op: {op}", file=sys.stderr)
        sys.exit(2)
    path = image or _read_stdin_image()
    if not path:
        print(_RESULT_MARKER + json.dumps({"error": "empty stdin / no --image"}, ensure_ascii=False), flush=True)
        sys.exit(3)
    if op == "orient":
        out: Dict[str, Any] = _classify_orientation(path)
    elif op == "rectify":
        out = _run_rectify(path)
    elif op == "vl":
        out = _run_vl(path)
    else:
        req = Ppsv3Request(image_path=path, return_image=(op == "rectify"))
        out = _run_ppsv3(req)
        if op == "ppsv3":
            out.pop("rectified_image_base64", None)  # CLI 模式不打大图
    # Node 工具式调用契约：哨兵单行 JSON（与 2.x main.py 一致）
    print(_RESULT_MARKER + json.dumps(out, ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser(description="OCR 侧车 3.x（PP-StructureV3）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=PPSV3_PORT)
    ap.add_argument("--once", action="store_true", help="单次调用后退出（不启动服务）")
    ap.add_argument("--op", default="ppsv3", choices=["ppsv3", "rectify", "orient", "vl"])
    ap.add_argument("--image", help="--once 模式的图片路径（缺省从 stdin 读）")
    # 兼容 Node 工具式调用器（ocr-tool.ts）统一传参；3.x 无引擎模式概念，忽略
    ap.add_argument("--mode", default="both", help="兼容参数（忽略）：2.x 引擎模式")
    args = ap.parse_args()
    if args.once:
        # --image 缺省时从 stdin 读（Node 工具式调用契约）；两者都无时 _once 报错退出
        _once(args.op, args.image)
        return
    import uvicorn

    # timeout_graceful_shutdown：优雅关闭 5s 内不退就强退（Paddle 推理线程可能挂住关闭流程，
    # 留下 orphan 占端口——Node 侧 supervisor 也有 SIGKILL 兜底，双保险）
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", timeout_graceful_shutdown=5)


if __name__ == "__main__":
    main()
