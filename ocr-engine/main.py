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
  python main.py                         # 默认 127.0.0.1:9300
  python main.py --port 9300 --host 0.0.0.0
  OCR_DRY_RUN=1 python main.py          # 不加载模型，/recognize 返回样例结构（契约验证用）
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# 模型缓存持久化：指到项目卷，避免沙箱重置后重复下载（paddlex/paddleocr 均识别这两个变量）
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", "/workspace/projects/.cache-paddlex")
os.environ.setdefault("XDG_CACHE_HOME", "/workspace/projects/.cache-paddle-xdg")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ⚠️【事故根因】RapidOCR / PaddleOCR 的 ONNX 推理实例**不是线程安全的**。
# FastAPI 对同步 `def` 路由（如 /recognize）用线程池并发执行，多个请求会同时调用
# 同一个共享的 `_ENGINES[...]` 模型实例 → ONNXRuntime 并发访问 → 进程段错误直接死掉。
# 表现：连续 ~50 次调用后侧车进程消失、端口 000、日志停在最后一批 200。
# 修复：用一把全局锁把"推理"串行化（图片解码可并行，模型推理必须独占）。
_INFER_LOCK = threading.Lock()

# PP-StructureV3 不可用告警只打一次（避免每页刷屏）
_STRUCTURE_WARNED = False

# ---------- 配置 ----------
OCR_ENGINE_MODE = os.getenv("OCR_ENGINE_MODE", "both")   # both | rapid | paddle
OCR_DEVICE = os.getenv("OCR_DEVICE", "cpu")              # cpu | gpu
OCR_LOW_CONF_THRESHOLD = float(os.getenv("OCR_LOW_CONF_THRESHOLD", "0.6"))
DRY_RUN = os.getenv("OCR_DRY_RUN", "0") == "1"
# det 检测边长上限。#124 实测：拍照试卷摆正后 ~1440x1920，用引擎默认值
# （rapid 736 / paddle 960）会把图缩到 960 以下，嵌入长句的小题号行
# （如 "got 11. their hands ... Even 12."）整行漏检；提到 1920（1440 宽不缩放）
# 后 11/12/13 全部召回。CPU 耗时 16s→20s，可接受。
OCR_DET_LIMIT = int(os.getenv("OCR_DET_LIMIT", "1920"))
# 分栏识别：文本区域 x 投影间隙 ≥ 图宽此比例（或 20px 兜底）即判为栏间空白。
OCR_COLUMN_GAP = float(os.getenv("OCR_COLUMN_GAP", "0.04"))
# 分栏处理总开关：auto=检测到多栏时自动切分逐栏识别；off=关闭（单栏平铺，旧行为）。
OCR_LAYOUT = os.getenv("OCR_LAYOUT", "auto")

app = FastAPI(title="OCR Engine Sidecar", version="1.0.0")

# 引擎实例缓存（延迟初始化）
_ENGINES: Dict[str, Any] = {}


# ---------- 请求/响应模型 ----------
class RecognizeRequest(BaseModel):
    image_url: Optional[str] = None        # 公网可达的图片 URL（优先）
    image_base64: Optional[str] = None     # 或 base64（可带 data: 前缀）
    mode: str = "both"                      # both | rapid | paddle
    layout: str = "auto"                    # auto=多栏时自动切分逐栏识别；off=仅单栏平铺


class OrientRequest(BaseModel):
    image_url: Optional[str] = None        # 公网可达的图片 URL（优先）
    image_base64: Optional[str] = None     # 或 base64（可带 data: 前缀）
    mode: str = "rapid"                     # both | rapid | paddle（朝向判定用轻量 rapid 即可）


# ---------- 图像加载 ----------
def _decode_image_bytes(raw: bytes):
    """原始图片字节 → (cv2_bgr_ndarray, pil_image)。_load_image 与 --once 共用。"""
    import cv2
    import numpy as np
    from PIL import Image

    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    bgr = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    return bgr, pil


def _downscale(bgr, max_edge: int):
    """把图缩到长边 ≤ max_edge（INTER_AREA）。朝向判定/投票与分辨率无关，thumbnail 足够，
    可将 4 向投票从 ~42s 降到 ~8s（原图 1920px → 900px，像素少 ~4.5×）。"""
    import cv2

    h, w = bgr.shape[:2]
    m = max(h, w)
    if m <= max_edge:
        return bgr
    s = max_edge / m
    return cv2.resize(bgr, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)


def _load_image(req: RecognizeRequest):
    """返回 (cv2_bgr_ndarray, pil_image)。"""
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
    return _decode_image_bytes(raw)


# ---------- 引擎：RapidOCR ----------
def _get_rapid() -> Any:
    if "rapid" not in _ENGINES:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINES["rapid"] = RapidOCR(det_limit_side_len=OCR_DET_LIMIT)
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
        regions.append({"text": str(t), "box": [min(xs), min(ys), max(xs), max(ys)], "score": s, "engine": "rapid"})
    return regions


# ---------- 引擎：PaddleOCR + PP-StructureV3 ----------
def _paddle_major() -> int:
    """paddleocr 主版本号（3.x 用新 API，2.x 用旧 API）。"""
    try:
        import paddleocr as _p
        return int(str(getattr(_p, "__version__", "3")).split(".")[0])
    except Exception:
        return 3


def _get_paddle() -> Any:
    if "paddle" not in _ENGINES:
        from paddleocr import PaddleOCR
        if _paddle_major() >= 3:
            # PaddleOCR 3.x：use_angle_cls/show_log 已删除；det_limit_side_len 移入 paddleX 配置（保持默认）
            _ENGINES["paddle"] = PaddleOCR(use_textline_orientation=True, lang="ch")
        else:
            _ENGINES["paddle"] = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False, det_limit_side_len=OCR_DET_LIMIT)
    return _ENGINES["paddle"]


def _norm_box(box) -> List[float]:
    """PaddleOCR 3.x 盒子归一化：兼容 [x1,y1,x2,y2] 扁平与 4×2 poly 两种格式。"""
    try:
        if box is None:
            return [0.0, 0.0, 0.0, 0.0]
        flat = [float(v) for v in list(box)]
        if len(flat) == 4 and all(abs(flat[j]) < 1e9 for j in range(4)):
            # 无法仅凭数值区分扁平/poly——用 x2>=x1 且 y2>=y1 判扁平；poly 场景下 max 语义等价
            xs, ys = flat[0::2], flat[1::2]
            if xs[1] >= xs[0] and ys[1] >= ys[0] and flat[2] >= flat[0]:
                return [flat[0], flat[1], flat[2], flat[3]]
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        return [min(xs), min(ys), max(xs), max(ys)]
    except Exception:
        return [0.0, 0.0, 0.0, 0.0]


def _run_paddle(bgr) -> List[Dict[str, Any]]:
    eng = _get_paddle()
    regions: List[Dict[str, Any]] = []
    if _paddle_major() >= 3:
        # 3.x：predict() 返回结果对象列表（rec_texts/rec_scores/rec_polys 或 rec_boxes）
        res = eng.predict(bgr)
        for r in res:
            d = r.to_dict() if hasattr(r, "to_dict") else r
            texts = list(d.get("rec_texts") or [])
            scores = list(d.get("rec_scores") or [])
            # ⚠️ rec_boxes 可能是 numpy 数组，禁止 `arr or other`（触发 truth-value 歧义）：
            #   显式 None/长度判断，优先 rec_boxes（[x1,y1,x2,y2] 扁平），回退 rec_polys（4×2）
            raw_boxes = d.get("rec_boxes")
            if raw_boxes is None or len(raw_boxes) == 0:
                raw_boxes = d.get("rec_polys")
            boxes = raw_boxes if raw_boxes is not None else []
            for i, txt in enumerate(texts):
                score = float(scores[i]) if i < len(scores) else 0.0
                box = boxes[i] if i < len(boxes) else None
                bb = _norm_box(box)
                regions.append({"text": str(txt), "box": bb, "score": score, "engine": "paddle"})
        return regions
    res = eng.ocr(bgr, cls=True)
    if not res or not res[0]:
        return regions
    for line in res[0]:
        box, (txt, score) = line[0], line[1]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        regions.append({"text": str(txt), "box": [min(xs), min(ys), max(xs), max(ys)], "score": float(score), "engine": "paddle"})
    return regions


def _run_structure(pil) -> Dict[str, Any]:
    """PP-StructureV3 版面/表格/公式（可选，失败不影响文字提取）。"""
    global _STRUCTURE_WARNED
    try:
        # paddleocr 3.x 把 PP-StructureV3 收进主包；2.x 时代是独立包 ppstructurev3
        try:
            from paddleocr import PPStructureV3 as PPSStructureV3
        except ImportError:
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
    except Exception as e:
        # 不静默：官方版面能力缺失/不可用时至少响一声（layout 恒空曾无人察觉，
        # 主链路的分栏/阅读序实际全靠自研几何算法，见 probe-layout-compare 对比结论）
        if not _STRUCTURE_WARNED:
            _STRUCTURE_WARNED = True
            print(f"[ocr] PP-StructureV3 不可用，layout 将恒为空（不影响文字提取）: {type(e).__name__}: {e}", flush=True)
        return {"layout": [], "tables": [], "formulas": []}


# ---------- 融合 ----------
# 题号锚点模式（错题提取场景的核心信号）：1~2 位数字 + 句点/顿号。
# (?<!\d) 负向断言：前不能是数字——避免 "in 1961." 内部的 "61." 被当题号加分。
# 例："got11." / "It was ... 10.m" / "make it 14."
_QNUM_RE = re.compile(r"(?<!\d)(\d{1,2})[.、]")


def _qnum_hits(t: str) -> List[int]:
    """文本里的题号命中列表（已排除年份尾巴碎片）。

    年份尾巴防护（#124 实测根因）：探究案 "the worst ___ in 1961." 被 OCR 截成
    "61.d"——两位尾数 + 句点 + 一个孤立字母即到文本尾。这是数字串被 det/rec
    截断后的残留形态，不是题号。若照常计分，该形态会以 104 分击败完整年份读法
    "n961.d"（无题号匹配，仅 6 分），产出假题号 61 并抢走题 4 的红笔标注。
    仅 num>20 启用：保护小题号带单字母糊尾的真实题号（如下划线糊化 "12.h"）。
    真实题号后要么直接是题干内容（多字符），要么无尾巴；"10.hm"（两个字符）
    不受影响。
    """
    hits: List[int] = []
    for m in _QNUM_RE.finditer(t):
        n = int(m.group(1))
        if n > 20 and re.fullmatch(r"[A-Za-z]", t[m.end():]):
            continue
        hits.append(n)
    return hits


def _text_quality(t: str) -> float:
    """同位置文本冲突时的择优分（#124）。

    为什么不能只比 rec 置信度：识别错误时模型同样"自信"——
    实测 RapidOCR 把题号 11 认成 "ll" 得 0.873，PaddleOCR 正确识别
    "got11." 只有 0.868，纯分数贪心会保留错版，导致背面 11-14 题号丢失。
    内容质量在错题提取场景比置信度更可靠：
      1. 含题号模式（\d{1,2}[.、]，排除年份尾巴碎片）强优先——题号是题目单元的锚点；
      2. 数字个数不在此计分——不同粒度的 region 之间数字个数不可比
         （实测 paddle 把 11/12 两题并成一行，"Even 12." 多出的一个数字让错版
         "got 1l.t..." 以 106:104 压过正确版 "got 11."）；同题号读法间的数字
         比较移入 _pick_better 的同题号集合分支；
      3. 仍持平才比 score。
    """
    q = 0.0
    if _qnum_hits(t):
        q += 100.0
    return q


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


def _same_spot(a: List[float], b: List[float]) -> bool:
    """两个框是否指称同一文本区域。

    IoU>0.5（高度重合）或「小框 70%+ 被大框包含且同一行带」。
    后者覆盖 det 对同一行切长/切短的同源框（IoU 常仅 0.3~0.5）：
    实测 "can preventbig15.m"[135,696,491,734] 与 "can prevent big 15."[139,704,360,731]
    IoU 只有 0.44，纯 IoU 阈值下两版都保留，导致题号 15 重复成两个题目单元。
    """
    if _iou(a, b) > 0.5:
        return True
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return False
    inter = (ix1 - ix0) * (iy1 - iy0)
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    if small <= 0 or inter / (small + 1e-6) <= 0.7:
        return False
    y_ov = iy1 - iy0
    y_min = min(a[3] - a[1], b[3] - b[1])
    return y_ov / (y_min + 1e-6) > 0.6


def _pick_better(r: Dict[str, Any], k: Dict[str, Any]) -> bool:
    """同区域冲突裁决：r 是否应替换已保留的 k。

    排序（#124 实测校准，每一步都有对应真实失败案例）：
      1. 题号模式分（含题号 +100，年份尾巴碎片不计）——题号是题目单元的锚点；
      2. 题号集合相同（含两者都无题号）时比数字个数：数字多的一版更完整
         （中文行 "1961年" vs "961年"；l/1、O/0 混淆时数字侧通常是对的）；
         题号集合不同 → 两个 region 粒度不同（一行含两题被拆开 vs 合并），
         数字个数不可比——合并版会因多含一题的题号而虚高（实测 paddle 合并版
         "got 1l.t...Even 12." 以 3 个数字压过正确拆开版 "got 11." 的 2 个）；
      3. 一侧包含另一侧 → 取更长（保住题干，如 17/22 题）；
      4. 其余打平 → 取更短：噪声常表现为多字（"...thony Sltheit best"），
         且两版题号信息相同时短版是更保守的读法；
      5. 仍相同 → 比 rec 置信度。
    """
    rq, kq = _text_quality(r["text"]), _text_quality(k["text"])
    if rq != kq:
        return rq > kq
    if _qnum_hits(r["text"]) == _qnum_hits(k["text"]):
        rd = sum(c.isdigit() for c in r["text"])
        kd = sum(c.isdigit() for c in k["text"])
        if rd != kd:
            return rd > kd
    rt = re.sub(r"\s+", "", r["text"])
    kt = re.sub(r"\s+", "", k["text"])
    if rt != kt and (rt in kt or kt in rt):
        return len(rt) > len(kt)
    if rt != kt:
        return len(rt) < len(kt)
    return r["score"] > k["score"]


def _fuse(regions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """同位置多引擎候选择优去重。

    _same_spot 判同区域：文本相同直接去重；文本冲突时：
      - 互补片段（#124 背面 11/12 行）：同一行含两道题时，引擎切分粒度不同——
        rapid 拆成 "got 11." + "...Even 12.h" 两段，paddle 合并成一行
        "got 1l.t...Even 12."。若候选与【所有】同位置已保留文本都无共同题号、
        且双方都带题号，说明它们是互补的题目片段而非重复读法——都保留，
        让每道题都产出单元（旧实现二选一，11 和 12 必丢一个）；
      - 否则按 _pick_better 择优（题号模式 > 同题号数字个数 > 包含取长 > 取短 > score）
        ——避免高分错版覆盖低分对版、同源长短框重复、年份尾巴碎片假题号压过完整读法。
    单引擎独有的区域全部保留（召回互补）。
    """
    ordered = sorted(regions, key=lambda r: r["score"], reverse=True)
    kept: List[Dict[str, Any]] = []
    for r in ordered:
        same = [k for k in kept if _same_spot(r["box"], k["box"])]
        if not same:
            kept.append(r)
            continue
        if any(k["text"] == r["text"] for k in same):
            continue
        rh = _qnum_hits(r["text"])
        khs = [_qnum_hits(k["text"]) for k in same]
        # 互补片段：r 与所有同位置文本题号互不相交、且双方都带题号 → 保留双方
        if rh and all(kh and not (set(rh) & set(kh)) for kh in khs):
            kept.append(r)
            continue
        # 择优对象：优先选与 r 有共同题号的同位置文本（真正的重复读法），否则取第一个
        target = same[0]
        for k, kh in zip(same, khs):
            if set(rh) & set(kh):
                target = k
                break
        if _pick_better(r, target):
            kept[kept.index(target)] = r
    # 阅读顺序：先按 y 中心，再按 x 中心
    kept.sort(key=lambda r: (round((r["box"][1] + r["box"][3]) / 2 / 30), r["box"][0]))
    return kept


def _recognize_regions(bgr, mode: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """跑 rapid(+paddle) 检测+识别，融合去重，返回 (regions, engine_used)。

    不跑版面分析、不做最终排序（_fuse 内部已按 y 带+x 排序）。供全页识别与分栏逐栏重识别复用。
    """
    regions: List[Dict[str, Any]] = []
    engine_used: List[str] = []
    with _INFER_LOCK:
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
    return fused, engine_used


def _column_spans(regions: List[Dict[str, Any]], img_w: int) -> List[Tuple[float, float]]:
    """按 x 投影间隙把文本区域聚成阅读栏（左→右）。返回 [(x0,x1), ...]；不足两栏返回 []。

    以文本区域的 x 区间并集做合并：相邻区间间隙 ≥ gap 才断开新栏。gap 取图宽比例与 20px 的较大值，
    避免把同一栏内行间距误判为栏间空白（#分栏：英文多栏试卷旧逻辑按 round(y/30) 分带 + x 排序，
    两栏行数不等时会交错成"左1右1左2右2…"，与人工先读左栏再读右栏的顺序冲突）。
    """
    if len(regions) < 2:
        return []
    ivs = sorted((r["box"][0], r["box"][2]) for r in regions)
    gap = max(20.0, img_w * OCR_COLUMN_GAP)
    spans: List[Tuple[float, float]] = []
    cs, ce = ivs[0]
    for x0, x1 in ivs[1:]:
        if x0 <= ce + gap:
            ce = max(ce, x1)
        else:
            spans.append((cs, ce))
            cs, ce = x0, x1
    spans.append((cs, ce))
    return spans


def _assemble(bgr, pil, regions: List[Dict[str, Any]], engine_used: List[str], mode: str) -> Dict[str, Any]:
    """单栏装配：raw_text + 版面 + 置信度（分栏路径的逐栏结果也走此结构，layout 在分栏路径置空）。"""
    structure = _run_structure(pil) if "paddleocr" in engine_used else {"layout": [], "tables": [], "formulas": []}
    raw_text = "\n".join(r["text"] for r in regions)
    conf = sum(r["score"] for r in regions) / len(regions) if regions else 0.0
    return {
        "raw_text": raw_text,
        "text_regions": regions,
        "layout": structure["layout"],
        "tables": structure["tables"],
        "formulas": structure["formulas"],
        "confidence": round(conf, 3),
        "engine_used": engine_used,
        "low_confidence": (len(regions) == 0) or (conf < OCR_LOW_CONF_THRESHOLD),
    }


def recognize_with_fusion(req: RecognizeRequest) -> Dict[str, Any]:
    bgr, pil = _load_image(req)
    mode = req.mode if req.mode in ("both", "rapid", "paddle") else OCR_ENGINE_MODE
    layout = req.layout or OCR_LAYOUT

    regions, engine_used = _recognize_regions(bgr, mode)

    # 分栏自动切分再逐栏识别（auto 且检测到多栏）：
    # 全页先识别一遍拿到文本区域与栏边界，再把每栏裁图单独重识别（单栏输入更干净，
    # 杜绝跨栏行被误检成一行），结果按栏序（左→右）+ 栏内 y 序拼接。单栏页或裁剪识别全失败时
    # 落回全页单栏路径（性能零回归：单栏页只跑一遍）。
    if layout != "off" and bgr.shape[1] > 0:
        spans = _column_spans(regions, bgr.shape[1])
        if len(spans) > 1:
            out: List[Dict[str, Any]] = []
            used: List[List[float]] = []
            for (x0, x1) in spans:
                pad = max(10, int((x1 - x0) * 0.02))
                cx0 = max(0, int(x0 - pad))
                cx1 = min(bgr.shape[1], int(x1 + pad))
                if cx1 - cx0 < 8:
                    continue
                crop = bgr[:, cx0:cx1].copy()
                col_regions, _ = _recognize_regions(crop, mode)
                for r in col_regions:
                    r["box"][0] += cx0
                    r["box"][2] += cx0
                out += col_regions
                used.append([cx0, cx1])
            if out:
                raw_text = "\n".join(r["text"] for r in out)
                conf = sum(r["score"] for r in out) / len(out) if out else 0.0
                return {
                    "raw_text": raw_text,
                    "text_regions": out,
                    "layout": [],
                    "tables": [],
                    "formulas": [],
                    "confidence": round(conf, 3),
                    "engine_used": engine_used,
                    "low_confidence": (len(out) == 0) or (conf < OCR_LOW_CONF_THRESHOLD),
                    "columns": used,
                }

    return _assemble(bgr, pil, regions, engine_used, mode)


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


@app.post("/orient")
def orient(req: OrientRequest):
    """文档朝向判定（0/90/180/270）。

    借鉴微信 OCR 的做法：用 OCR 引擎对四个候选朝向各做一次识别，取「可读文本体量」最大者。
    文本体量是正立与否的强信号——正立文本连贯、识别字符多、置信度高；倒立/侧翻文本被切碎、
    置信度低，自然被淘汰。这能确定性消歧 0/180 与 90/270（纯几何投影对这两对镜像对称、无法区分）。

    与旧实现（Node 侧对 /recognize 发 4 次网络请求各跑全量 OCR）相比：
      - 单次 HTTP 调用，4 向投票在侧车进程内就地完成（引擎实例已预热，推理串行化受 _INFER_LOCK 保护）；
      - 消除 4 次网络往返与各自的超时抖动；
      - 决策逻辑贴近引擎，可随引擎升级（未来可换成专用 4 分类方向分类器，更轻量）。

    ⚠️ 性能：投票前先把图降采样到长边 900px（朝向与分辨率无关），4 向全图 OCR 从 ~42s 降到 ~8s，
       避免贴近客户端 60s 超时、也避免长时间霸占 _INFER_LOCK 阻塞其他请求。
    """
    if DRY_RUN:
        # 朝向必须依赖真实模型；DRY_RUN 无模型，主动 503 让调用方回落纯几何并报 suspect。
        raise HTTPException(status_code=503, detail="sidecar is DRY_RUN; orientation requires a real model")
    try:
        bgr, _ = _load_image(req)
        mode = req.mode if req.mode in ("both", "rapid", "paddle") else OCR_ENGINE_MODE
        return _orient_impl(bgr, mode)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR 朝向判定失败: {e}")


def _orient_impl(bgr, mode: str) -> Dict[str, Any]:
    """4 向朝向投票核心（路由 /orient 与 --once 共用）。投票在降采样 thumbnail 上进行。"""
    import cv2

    vote = _downscale(bgr, 900)  # 朝向判定与分辨率无关：缩到 thumbnail，推理快 ~4.5×
    rot_map = {
        90: cv2.ROTATE_90_CLOCKWISE,
        180: cv2.ROTATE_180,
        270: cv2.ROTATE_90_COUNTERCLOCKWISE,
    }
    candidates = [0, 90, 180, 270]
    scores: Dict[int, float] = {}
    best = 0
    best_vol = -1.0
    with _INFER_LOCK:
        for a in candidates:
            rb = vote if a == 0 else cv2.rotate(vote, rot_map[a])
            regions = _orient_regions(rb, mode)
            # 质量分 = Σ(去空白字符数 × 识别置信度)，与旧 Node 侧投票口径一致。
            vol = float(
                sum(
                    len((rg.get("text") or "").replace(r"\s", "")) * (rg.get("score") or 0.5)
                    for rg in regions
                )
            )
            scores[a] = vol
            if vol > best_vol:
                best_vol = vol
                best = a
    return {"angle": best, "scores": scores, "method": "ocr"}


def _orient_regions(bgr, mode: str) -> List[Dict[str, Any]]:
    """仅用于朝向投票：跑 det(+cls) 与 rec，返回 regions 列表（与 /recognize 复用同一批底层函数）。"""
    regions: List[Dict[str, Any]] = []
    if mode in ("both", "rapid"):
        try:
            regions += _run_rapid(bgr)
        except Exception as e:  # 互为备份：单引擎失败不影响另一引擎
            print(f"[ocr] Orient RapidOCR 失败: {e}", flush=True)
    if mode in ("both", "paddle"):
        try:
            regions += _run_paddle(bgr)
        except Exception as e:
            print(f"[ocr] Orient PaddleOCR 失败: {e}", flush=True)
    return regions


def run_loop(op: str, mode: str) -> int:
    """常驻循环模式（2026-10 新增，供快速识别预热进程复用）。
    与 run_once 复用同一批底层函数，但模型**只加载一次**，随后循环从 stdin 收帧处理：

      stdin 协议：4 字节大端图片长度 N + N 字节图片字节；EOF 退出循环。
      stdout 协议：每行一条 `<<<OCR_RESULT>>>` + 紧凑 JSON（无内嵌换行），Node 侧按行截取。

    串行单进程单模型实例，天然规避 ONNX 并发段错误（见文件头 _INFER_LOCK 说明）；
    单请求超时由 Node 侧 SIGKILL 中断并重 Spawn，本进程不维护跨请求状态。
    """
    import struct

    m = mode if mode in ("both", "rapid", "paddle") else "rapid"
    # 预热：显式实例化引擎（rapid 必加载；paddle 视模式而定），让首次请求免冷加载
    try:
        _get_rapid()
        if m in ("both", "paddle"):
            _get_paddle()
    except Exception as e:
        print(f"[ocr-loop] 模型加载失败: {e}", file=sys.stderr, flush=True)
        return 1
    # 就绪信号（仅这一行上 stdout，保持干净供 Node 解析）
    print("<<<OCR_READY>>>", flush=True)

    def _read_exactly(stream, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = stream.read(n - len(buf))
            if not chunk:
                return buf  # EOF
            buf += chunk
        return buf

    while True:
        header = _read_exactly(sys.stdin.buffer, 4)
        if len(header) < 4:
            break  # EOF：客户端关闭 stdin
        n = struct.unpack(">I", header)[0]
        raw = _read_exactly(sys.stdin.buffer, n)
        if len(raw) < n:
            break  # 截断，退出
        try:
            bgr, pil = _decode_image_bytes(raw)
            if op == "orient":
                out = _orient_impl(bgr, m)
            elif op == "recognize":
                req = RecognizeRequest(image_base64=base64.b64encode(raw).decode(), mode=m, layout=OCR_LAYOUT)
                out = recognize_with_fusion(req)
            else:
                out = {"error": f"unknown op {op}"}
            payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
            sys.stdout.write("<<<OCR_RESULT>>>" + payload + "\n")
            sys.stdout.flush()
        except Exception as e:
            err = json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
            sys.stdout.write("<<<OCR_RESULT>>>" + err + "\n")
            sys.stdout.flush()
    return 0


def run_once(op: str, mode: str) -> int:
    """工具式单次调用：从 stdin 读图片字节 → 跑一次 OCR → JSON 打到 stdout → 进程退出。

    设计动机（用户需求）：成熟 OCR 引擎本身稳定，崩溃/卡死多源于「长驻服务 + 共享状态 + 无法中断的推理」。
    工具式调用让每次 OCR 都是独立子进程：
      - 崩溃/卡死只影响当次，下一条全新进程自动恢复（崩不 Cascades）；
      - 调用方（Node）可用硬超时 + SIGKILL 强制中断——共享服务里一段卡死的推理无法被安全中断；
      - 无跨请求共享状态，天然规避 ONNX 并发访问段错误（无需依赖 _INFER_LOCK 也能正确）。
    代价是每次都要加载模型，故默认 rapid（加载快、CPU 友好）；paddle 仅在 mode 指定时加载。
    """
    raw = sys.stdin.buffer.read()
    if not raw:
        print(json.dumps({"error": "empty stdin"}), flush=True)
        return 2
    try:
        bgr, pil = _decode_image_bytes(raw)
    except Exception as e:
        print(json.dumps({"error": f"decode failed: {e}"}), flush=True)
        return 2
    try:
        if op == "orient":
            m = mode if mode in ("both", "rapid", "paddle") else "rapid"
            out = _orient_impl(bgr, m)
        elif op == "recognize":
            req = RecognizeRequest(image_base64=base64.b64encode(raw).decode(), mode=mode, layout=OCR_LAYOUT)
            out = recognize_with_fusion(req)
        else:
            print(json.dumps({"error": f"unknown op {op}"}), flush=True)
            return 2
        # 单行 JSON 到 stdout，带哨兵标记，便于调用方从可能的库噪声中稳定截取
        print("<<<OCR_RESULT>>>" + json.dumps(out, ensure_ascii=False), flush=True)
        return 0
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
        return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("OCR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("OCR_PORT", "9300")))
    # 工具式单次调用：python main.py --once --op recognize|orient [--mode rapid|both|paddle]
    parser.add_argument("--once", action="store_true", help="单次工具模式：stdin 进图、stdout 出 JSON 即退")
    # 常驻循环模式：模型仅加载一次，stdin 收帧、stdout 回结果（供快速识别预热进程复用）
    parser.add_argument("--loop", action="store_true", help="常驻循环模式：stdin 收帧、stdout 回结果，模型只加载一次")
    parser.add_argument("--op", default="recognize", choices=["recognize", "orient"])
    parser.add_argument("--mode", default=os.getenv("OCR_ENGINE_MODE", "both"))
    parser.add_argument("--layout", default=os.getenv("OCR_LAYOUT", "auto"), choices=["auto", "off"],
                        help="auto=检测到多栏时自动切分逐栏识别；off=仅单栏平铺（旧行为）")
    args = parser.parse_args()
    # 把 --layout 透传到模块级 OCR_LAYOUT，供 run_loop/run_once 内的 RecognizeRequest 使用
    OCR_LAYOUT = args.layout
    if args.loop:
        sys.exit(run_loop(args.op, args.mode))
    if args.once:
        sys.exit(run_once(args.op, args.mode))
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
