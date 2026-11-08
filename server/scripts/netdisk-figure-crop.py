#!/usr/bin/env python3
"""P-017 第 2 段：docx → PDF → 定位题干 → 裁切「原题快照」→ WebP。

被 netdisk-figure-build.mjs 按批次调用：读 <batch>/manifest.json，产出 <batch>/result.json。

定位策略（三重兜底，逐级放宽）：
  ① 用 `char_start / 正文总长` 折算「预期页码」，只在该页 ±WINDOW 页里找
     —— 最稳，且天然防止跨题误配；
  ② 锚点从 28 字逐级缩到 10 字（docx 里的公式是 OLE 对象、文本抽取时是空的，
     所以同一个题干在库内文本与 PDF 里**不是逐字一致**，长锚点会大面积失配）；
  ③ 仍找不到：全篇单调向后找，最后退化到全篇任意位置。
  页文本按需抽取（lazy）—— 一本 141 页的书只为了十几道题去抽全部页文本会慢一倍。

诚实边界：
  · 归一化后不足 `ANCHOR_MIN` 字的对象（如英语完形的「1.C」答案片段）**直接跳过**：
    这种串无法唯一定位，宁可没有图，也绝不拿相邻题目顶替；
  · 只输出裁切图，不改任何文本、不参与判定。
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

import pypdfium2 as pdfium
from PIL import Image

SCALE = 2.0
MARGIN = 40
MAX_H = 2200
ANCHOR_LENS = (28, 20, 14, 10)
ANCHOR_MIN = 10
WINDOW = 3
WEBP_Q = 78
HEADER_CUT = 0.03
FOOTER_CUT = 0.97
ENGINE = 'fig-v1'


def norm(s):
    return re.sub(r"\s+", "", s or "")


def convert_batch(docx_paths, outdir):
    """一次 soffice 调用批量转（省掉每份的进程启动开销）。"""
    os.makedirs(outdir, exist_ok=True)
    todo = []
    for p in docx_paths:
        name = os.path.basename(p).rsplit(".", 1)[0]
        out = os.path.join(outdir, name + ".pdf")
        if not (os.path.exists(out) and os.path.getsize(out) > 0):
            todo.append(p)
    ms = 0
    if todo:
        t0 = time.time()
        try:
            subprocess.run(
                ["soffice", "--headless", "--norestore", "--convert-to", "pdf",
                 "--outdir", outdir] + todo,
                check=False, timeout=max(300, 60 * len(todo)),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            pass
        ms = int((time.time() - t0) * 1000)
    pairs = []
    for p in docx_paths:
        name = os.path.basename(p).rsplit(".", 1)[0]
        out = os.path.join(outdir, name + ".pdf")
        pairs.append((p, out if os.path.exists(out) and os.path.getsize(out) > 0 else None))
    return pairs, ms


class Doc:
    """按需抽页文本 + 缓存字符框。"""

    def __init__(self, path):
        self.pdf = pdfium.PdfDocument(path)
        self.n = len(self.pdf)
        self._txt = {}
        self._all = None

    def text(self, pi):
        if pi not in self._txt:
            try:
                self._txt[pi] = norm(self.pdf[pi].get_textpage().get_text_range() or "")
            except Exception:
                self._txt[pi] = ""
        return self._txt[pi]

    def all_text(self):
        if self._all is None:
            self._all = "".join(self.text(i) for i in range(self.n))
        return self._all

    def close(self):
        try:
            self.pdf.close()
        except Exception:
            pass


def find_in_pages(doc, anchor, lo, hi):
    for pi in range(max(0, lo), min(doc.n - 1, hi) + 1):
        off = doc.text(pi).find(anchor)
        if off >= 0:
            return pi, off
    return None


def locate(doc, obj, total_len):
    stem = norm(obj.get("stem") or "")
    if len(stem) < ANCHOR_MIN:
        return None

    expect = 0
    if total_len > 0:
        expect = int((float(obj.get("start") or 0) / total_len) * doc.n)

    for n in ANCHOR_LENS:
        a = stem[:n]
        if len(a) < ANCHOR_MIN:
            continue
        got = find_in_pages(doc, a, expect - WINDOW, expect + WINDOW)
        if got:
            return got[0], got[1], len(a)

    # ③ 全篇兜底（少见：只在预期页对不上时才走）
    blob = doc.all_text()
    for n in ANCHOR_LENS:
        a = stem[:n]
        if len(a) < ANCHOR_MIN:
            continue
        pos = blob.find(a)
        if pos >= 0:
            acc = 0
            for pi in range(doc.n):
                ln = len(doc.text(pi))
                if pos < acc + ln:
                    return pi, pos - acc, len(a)
                acc += ln
    return None


def band_of(page, start_idx, length):
    tp = page.get_textpage()
    cnt = tp.count_chars()
    tops, bottoms = [], []
    for idx in range(max(0, start_idx), min(cnt, start_idx + length)):
        try:
            l, b, r, t = tp.get_charbox(idx)
        except Exception:
            continue
        if (r - l) <= 0 and (t - b) <= 0:
            continue
        tops.append(t)
        bottoms.append(b)
    if not tops:
        return None
    return min(bottoms), max(tops)


def main():
    batch = sys.argv[1]
    storage_dir = sys.argv[2]
    with open(os.path.join(batch, "manifest.json")) as f:
        manifest = json.load(f)
    pdfdir = os.path.join(batch, "pdf")

    stat = {"files": 0, "pdfOk": 0, "objs": 0, "skippedShort": 0, "located": 0,
            "cropped": 0, "bytes": 0, "convertMs": 0, "renderMs": 0}
    results = []
    for m in manifest:
        stat["files"] += 1
        stat["objs"] += len(m["objects"])

    pairs, cms = convert_batch([m["docx"] for m in manifest], pdfdir)
    stat["convertMs"] += cms
    pdfOf = {m["fsId"]: pdf for m, (_, pdf) in zip(manifest, pairs)}

    for m in manifest:
        pdf_path = pdfOf.get(m["fsId"])
        if not pdf_path:
            continue
        stat["pdfOk"] += 1
        try:
            doc = Doc(pdf_path)
        except Exception:
            continue

        total_len = int(m.get("totalLen") or 0)
        placed = {}
        for o in m["objects"]:
            if len(norm(o.get("stem") or "")) < ANCHOR_MIN:
                stat["skippedShort"] += 1
                continue
            got = locate(doc, o, total_len)
            if got:
                placed[o["index"]] = got
        stat["located"] += len(placed)

        by_page = {}
        for oi, (pi, off, ln) in placed.items():
            by_page.setdefault(pi, []).append((off, ln, oi))

        for pi, items in by_page.items():
            page = doc.pdf[pi]
            try:
                page_img = page.render(scale=SCALE).to_pil()
            except Exception:
                continue
            if page_img.mode not in ("RGB", "L"):
                page_img = page_img.convert("RGB")
            W_px, H_px = page_img.size
            lo_lim, hi_lim = int(H_px * HEADER_CUT), int(H_px * FOOTER_CUT)
            items.sort()
            bands = {}
            for off, ln, oi in items:
                bands[oi] = band_of(page, off, ln)
            for k, (off, ln, oi) in enumerate(items):
                bd = bands.get(oi)
                if not bd:
                    continue
                y_min, y_max = bd
                top = (page.get_height() - y_max) * SCALE - MARGIN
                if k + 1 < len(items):
                    nbd = bands.get(items[k + 1][2])
                    bottom = ((page.get_height() - nbd[1]) * SCALE - MARGIN) if nbd else top + MAX_H
                    bottom = min(bottom, top + MAX_H)
                else:
                    bottom = top + MAX_H
                top = max(lo_lim, int(top))
                bottom = min(hi_lim, H_px, int(bottom))
                if bottom - top < 80:
                    continue
                img = page_img.crop((0, top, W_px, bottom))
                results.append({"index": oi, "page": pi + 1, "w": img.width,
                                "h": img.height, "buf": img, "src": m["fsId"]})
                stat["renderMs"] += 1
        doc.close()

    out = []
    tmp = os.path.join(batch, "_tmp.webp")
    for r in results:
        img = r.pop("buf")
        img.save(tmp, "WEBP", quality=WEBP_Q, method=4)
        size = os.path.getsize(tmp)
        with open(tmp, "rb") as fh:
            h = hashlib.sha256(fh.read()).hexdigest()
        key = "figures/%s/%s.webp" % (h[:2], h)
        dst = os.path.join(storage_dir, key)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            os.replace(tmp, dst)
        else:
            os.remove(tmp)
        r.update({"key": key, "bytes": size})
        stat["cropped"] += 1
        stat["bytes"] += size
        out.append(r)

    with open(os.path.join(batch, "result.json"), "w") as f:
        json.dump({"engine": ENGINE, "stat": stat, "items": out}, f, ensure_ascii=False)
    print(json.dumps(stat, ensure_ascii=False))


if __name__ == "__main__":
    main()
