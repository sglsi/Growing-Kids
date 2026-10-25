#!/usr/bin/env python
"""PDF / DOCX 内容提取工具（#118 一次性脚本，产物随 deploy-pack 上传）

背景（思傅 2026-10-25 报障）：导入 PDF 后点「识别题目」→「未识别到题目」。
根因：recognizeDoc 把 PDF 二进制当文本喂 FetchClient，解出 10 万字符的
二进制乱码（中文占比 0%），本地结构化必然不达标；VLM 兜底又遇 coze 5001
返回空 items → 前端零结果报错。

本工具用 pypdfium2（OCR venv 已装，PDFium 绑定）做**正确的**内容提取：
  - PDF：逐页先取文字层（textpage，CID/ToUnicode 由 PDFium 正确处理）；
         文字层不足阈值的页（扫描页）渲染成 PNG（base64）交后端 OCR。
  - DOCX：zipfile 解 word/document.xml（+页眉页脚），剥 XML 取段落文本。

用法（与 main.py 的 <<<OCR_RESULT>>> 约定一致）：
    python pdf_tool.py --kind pdf  --file /path/to.pdf  [--min-text 20] [--scale 2.0]
    python pdf_tool.py --kind docx --file /path/to.docx
输出：stdout 打 `<<<OCR_RESULT>>>` + JSON；错误打 {"error": "..."}（无标记）。
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import zipfile

RESULT_MARKER = "<<<OCR_RESULT>>>"

# 扫描页渲染的默认倍率：2.0 ≈ 144dpi，PP-StructureV3 对 150dpi 左右的页面最稳
DEFAULT_SCALE = 2.0
# 单页文字少于该字符数视为「无文字层」（扫描页），转渲染 + OCR
DEFAULT_MIN_TEXT = 20
# 单页渲染像素上限（宽或高超过则降倍率）：防超大页（如 A0 图纸）OOM
MAX_RENDER_EDGE = 4200


def _emit(obj):
    print(RESULT_MARKER + json.dumps(obj, ensure_ascii=False), flush=True)


def _emit_error(msg):
    print(json.dumps({"error": msg}), flush=True)


def _render_scale(page, want_scale):
    """按页面尺寸钳制渲染倍率，避免超大页撑爆内存。"""
    w, h = page.get_width(), page.get_height()
    edge = max(w, h) * want_scale
    if edge > MAX_RENDER_EDGE:
        return MAX_RENDER_EDGE / max(w, h)
    return want_scale


def extract_pdf(path, min_text, scale):
    import pypdfium2 as pdfium

    # 空密码打开；加密 PDF 会抛异常，由调用方转成友好错误
    pdf = pdfium.PdfDocument(path)
    try:
        pages = []
        for i in range(len(pdf)):
            page = pdf[i]
            try:
                text = ""
                try:
                    tp = page.get_textpage()
                    text = tp.get_text_range() or ""
                    tp.close()
                except Exception as e:  # 文字层损坏不应阻断整本：降级为扫描页
                    print(f"[pdf_tool] 第 {i + 1} 页文字层读取失败，按扫描页处理: {e}", file=sys.stderr)
                    text = ""
                text = text.replace("\r\n", "\n").strip()
                entry = {
                    "index": i,
                    "text": text,
                    "image_base64": None,
                    "width": int(page.get_width()),
                    "height": int(page.get_height()),
                }
                if len(text) < min_text:
                    # 无文字层 → 渲染整页交后端 OCR
                    bitmap = page.render(scale=_render_scale(page, scale))
                    image = bitmap.to_pil()
                    buf = io.BytesIO()
                    image.save(buf, format="PNG")
                    entry["image_base64"] = base64.b64encode(buf.getvalue()).decode()
                    entry["width"] = image.width
                    entry["height"] = image.height
                pages.append(entry)
            finally:
                page.close()
        return {"page_count": len(pdf), "pages": pages}
    finally:
        pdf.close()


_XML_ESCAPES = [
    ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&"),
]


def extract_docx(path):
    """docx = zip；取 word/document.xml（+ 页眉页脚）剥标签成段落文本。"""
    if not zipfile.is_zipfile(path):
        raise ValueError("不是有效的 docx（zip）文件")
    with zipfile.ZipFile(path) as z:
        names = [
            n for n in z.namelist()
            if re.fullmatch(r"word/(document|header\d*|footer\d*)\.xml", n)
        ]
        if "word/document.xml" not in names:
            raise ValueError("docx 内缺少 word/document.xml")
        # document.xml 优先，页眉页脚附后
        names.sort(key=lambda n: (0 if n == "word/document.xml" else 1, n))
        chunks = []
        for name in names:
            xml = z.read(name).decode("utf-8", "ignore")
            # 段落/换行/制表符边界先行保留，再剥标签
            xml = re.sub(r"<w:p[ >]", "\n<w:p ", xml)
            xml = re.sub(r"<w:br\b[^>]*/?>", "\n", xml)
            xml = re.sub(r"<w:tab\b[^>]*/?>", "\t", xml)
            xml = re.sub(r"<w:cr\b[^>]*/?>", "\n", xml)
            text = re.sub(r"<[^>]+>", "", xml)
            for a, b in _XML_ESCAPES:
                text = text.replace(a, b)
            chunks.append(text)
    full = "\n".join(chunks)
    full = re.sub(r"[ \t\u3000]+", " ", full)
    full = re.sub(r"\n{3,}", "\n\n", full).strip()
    return {
        "page_count": 1,
        "pages": [{"index": 0, "text": full, "image_base64": None, "width": 0, "height": 0}],
    }


def main():
    ap = argparse.ArgumentParser(description="PDF/DOCX 内容提取（#118）")
    ap.add_argument("--kind", choices=["pdf", "docx"], required=True)
    ap.add_argument("--file", required=True, help="本地文件路径（由 Node 侧下载落盘）")
    ap.add_argument("--min-text", type=int, default=DEFAULT_MIN_TEXT,
                    help="单页文字少于此值视为扫描页（渲染交 OCR）")
    ap.add_argument("--scale", type=float, default=DEFAULT_SCALE, help="扫描页渲染倍率")
    args = ap.parse_args()

    if not os.path.isfile(args.file):
        _emit_error(f"文件不存在: {args.file}")
        sys.exit(2)
    try:
        if args.kind == "pdf":
            out = extract_pdf(args.file, args.min_text, args.scale)
        else:
            out = extract_docx(args.file)
        _emit(out)
    except Exception as e:
        _emit_error(f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
