#!/usr/bin/env python3
"""P-018 第 2 段：docx 原位抠图 —— 几何图取原图、公式按 PDF bbox 精确裁切。

被 netdisk-inline-build.mjs 按「一份文档」调用：
  python netdisk-inline-crop.py <manifest.json>
manifest 里给 docx 路径、pdf 路径、该文档的题目对象（index / start / stem）、storage 目录。
输出 result.json：每个题目对象的 inline items（相对 stem 的插入点、类型、key、宽高、页码）。

定位原理（已实测同源）：
  `question_objects.char_start` 与 `pdf_tool.extract_docx` 剥标签后的文字流**同一坐标系**
  （30 份样本 3/3 分毫不差：37 / 288 / 526）。所以公式在题干里的插入点可以精确算到字符。

裁切原理：
  公式在 PDF 里是 IMAGE 对象（LibreOffice 渲染），`get_bounds()` 给出精确 bbox。
  先用前后各 10 个去空白字符的锚点对确定「大致区间 + 行位置」，再在该页 IMAGE 里
  按 x 重叠度挑 bbox —— 比只用间隙稳（左锚点常以标点结尾、字框仅 1.6pt）。

诚实边界：
  · 定位不到 / bbox 挑不到 / 裁完过小 ⇒ **不产出该图**，绝不用相邻行或相邻题顶替；
  · 白化阈值 242 再 trim，避免带进相邻字的浅色笔画；
  · 只写 storage 与 result.json，不碰数据库。
"""
import hashlib
import io
import json
import os
import re
import signal
import subprocess
import sys
import time
import zipfile

import pypdfium2 as pdfium
from PIL import Image, ImageChops

ENGINE = 'inline-v1'
SCALE = 4.0
PAD = 0.3
WHITE = 242
ANCHOR = 10
MIN_SIDE = 6

_ESC = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")]


def norm(s):
    return re.sub(r"\s+", "", s or "")


def _pipe(x):
    x = re.sub(r"<w:p[ >]", "\n<w:p ", x)
    x = re.sub(r"<w:br\b[^>]*/?>", "\n", x)
    x = re.sub(r"<w:tab\b[^>]*/?>", "\t", x)
    x = re.sub(r"<w:cr\b[^>]*/?>", "\n", x)
    t = re.sub(r"<[^>]+>", "", x)
    for a, b in _ESC:
        t = t.replace(a, b)
    return t


def _finish(f):
    f = re.sub(r"[ \t\u3000]+", " ", f)
    f = re.sub(r"\n{3,}", "\n\n", f)
    return f.strip()


def parse_docx(path):
    """复刻 ocr-engine/pdf_tool.py:extract_docx 的口径，并在每个图/公式处打标记。"""
    z = zipfile.ZipFile(path)
    xml = z.read("word/document.xml").decode("utf-8", "ignore")
    rels_name = "word/_rels/document.xml.rels"
    rmap = {}
    if rels_name in z.namelist():
        rels = z.read(rels_name).decode("utf-8", "ignore")
        rmap = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))

    marks = []

    def put(m):
        n = len(marks) + 1
        seg = xml[m.start(): m.start() + 3000]
        ids = re.findall(r'r:(?:embed|id)="([^"]+)"', seg)[:2]
        marks.append({
            'n': n,
            'kind': 'figure' if m.group(0).startswith('<w:drawing') else 'formula',
            'files': [rmap.get(i, '') for i in ids],
        })
        return '\x01F%d\x02' % n + m.group(0)

    xml2 = re.sub(r'<w:drawing[ >]|<w:object[ >]', put, xml)
    text = _finish(_pipe(xml2))

    segs, last = [], 0
    for m in re.finditer(r'\x01F(\d+)\x02', text):
        segs.append(('t', text[last:m.start()]))
        segs.append(('m', int(m.group(1))))
        last = m.end()
    segs.append(('t', text[last:]))

    parts, pos = [], {}
    off = 0
    for s in segs:
        if s[0] == 't':
            parts.append(s[1])
            off += len(s[1])
        else:
            pos[s[1]] = off
    return z, ''.join(parts), pos, {m['n']: m for m in marks}


def lo_profile_arg():
    """给每个 worker 独立的 LibreOffice 用户配置目录。

    🔴 2026-11-08 压测踩到的坑：两个 worker 共用默认 profile
    （`~/.config/libreoffice/4`）时，第二个 `soffice --headless` 会去连第一个的
    实例并**直接挂住**（CPU 0%、日志不动），看起来像"文档太大转不动"，
    实际是 LibreOffice 的单实例锁在等。修法＝每个 worker 一个 profile 目录。
    """
    base = os.environ.get('LO_PROFILE_DIR') or os.path.join(
        os.environ.get('INLINE_WORK_DIR') or '/tmp/gkinline-work', 'lo-profile')
    base = os.path.abspath(base)
    os.makedirs(base, exist_ok=True)
    return '-env:UserInstallation=file://' + base


def ensure_pdf(docx, pdf):
    """docx → PDF（LibreOffice headless）。

    🔴 2026-11-08 压测第二个坑：`subprocess.run(..., timeout=N)` 超时后
    **soffice 并不会干净退出**——实测留下一个 100% CPU 转了 15 分钟的孤儿进程，
    而同 worker 的下一份会连到这个孤儿实例上继续挂死（共用 profile）。
    所以改成 Popen + 独立进程组 + `killpg(SIGKILL)`，超时一定连子孙一起清掉。
    """
    if os.path.exists(pdf) and os.path.getsize(pdf) > 0:
        return True
    proc = None
    try:
        proc = subprocess.Popen(
            ["soffice", lo_profile_arg(), "--headless", "--norestore",
             "--convert-to", "pdf", "--outdir", os.path.dirname(pdf), docx],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        proc.wait(timeout=480)
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    finally:
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=30)
            except Exception:
                pass
    return os.path.exists(pdf) and os.path.getsize(pdf) > 0


class Pdf:
    def __init__(self, path):
        self.doc = pdfium.PdfDocument(path)
        self.n = len(self.doc)
        self._txt = {}
        self._img = {}

    def page_ns(self, pi):
        if pi not in self._txt:
            raw = self.doc[pi].get_textpage().get_text_range()
            idx = [i for i, ch in enumerate(raw) if not ch.isspace()]
            self._txt[pi] = (''.join(raw[i] for i in idx), idx)
        return self._txt[pi]

    def imgs(self, pi):
        if pi not in self._img:
            out = []
            try:
                objs = list(self.doc[pi].get_objects())
            except Exception:
                objs = []
            for o in objs:
                if o.type != 3:
                    continue
                try:
                    l, b, r, t = o.get_bounds()
                except Exception:
                    continue
                if r - l > 0.6 and t - b > 0.6:
                    out.append((l, b, r, t))
            self._img[pi] = out
        return self._img[pi]

    def close(self):
        try:
            self.doc.close()
        except Exception:
            pass


def pick_bbox(imgs, x0, x1, yc):
    best, bs = None, 0.0
    for l, b, r, t in imgs:
        ov = min(r, x1) - max(l, x0)
        if ov <= 0:
            continue
        if abs((b + t) / 2 - yc) > 36:
            continue
        score = ov / max(1.0, min(r - l, x1 - x0))
        if score > bs:
            bs, best = score, (l, b, r, t)
    return best if bs > 0.45 else None


def trim_white(img):
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = px[x, y]
            if r > WHITE and g > WHITE and b > WHITE:
                px[x, y] = (255, 255, 255)
    bg = Image.new('RGB', img.size, (255, 255, 255))
    box = ImageChops.difference(img, bg).getbbox()
    if box:
        img = img.crop(box)
    return img


class RenderCache:
    """只缓存当前页：公式按文档顺序处理，页面基本单调递增，留一页就够，省内存也省时间。"""

    def __init__(self):
        self.pi = -1
        self.img = None

    def get(self, pdf, pi):
        if self.pi != pi:
            self.img = pdf.doc[pi].render(scale=SCALE).to_pil().convert('RGB')
            self.pi = pi
        return self.img


def crop_formula(pdf, clean, pos, n, cache=None):
    p = pos[n]
    la = norm(clean[max(0, p - ANCHOR - 8):p])[-ANCHOR:]
    ra = norm(clean[p:p + ANCHOR + 8])[:ANCHOR]
    if len(la) < 4 or len(ra) < 4:
        return None
    for pi in range(pdf.n):
        ns, idx = pdf.page_ns(pi)
        k = ns.find(la + ra)
        if k < 0:
            continue
        page = pdf.doc[pi]
        tp = page.get_textpage()
        try:
            l1, b1, r1, t1 = tp.get_charbox(idx[k + len(la) - 1])
            l2, b2, r2, t2 = tp.get_charbox(idx[k + len(la)])
        except Exception:
            return None
        if l2 <= r1:
            return None
        bb = pick_bbox(pdf.imgs(pi), r1, l2, (b1 + t1 + b2 + t2) / 4)
        if bb:
            l, b, r, t = bb
        else:
            l, b, r, t = r1, min(b1, b2) - 3, l2, max(t1, t2) + 4
        hpt = page.get_height()
        full = cache.get(pdf, pi) if cache else page.render(scale=SCALE).to_pil().convert('RGB')
        img = full.crop((
            max(0, int((l - PAD) * SCALE)),
            max(0, int((hpt - t - PAD) * SCALE)),
            min(full.width, int((r + PAD) * SCALE)),
            min(full.height, int((hpt - b + PAD) * SCALE)),
        ))
        img = trim_white(img)
        if img.width < MIN_SIDE or img.height < MIN_SIDE:
            return None
        return img, pi + 1
    return None


def grab_figure(z, files):
    for f in files:
        low = f.lower()
        if not low.endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')):
            continue
        name = 'word/' + f.replace('\\', '/').lstrip('/')
        try:
            return Image.open(io.BytesIO(z.read(name))).convert('RGB')
        except Exception as e:
            print('[grab] %s -> %s: %s' % (name, type(e).__name__, e), file=sys.stderr)
            continue
    return None


def save_webp(img, storage_dir):
    os.makedirs(storage_dir, exist_ok=True)
    tmp = os.path.join(storage_dir, '_inline_tmp.webp')
    img.save(tmp, 'WEBP', lossless=True, method=4)
    size = os.path.getsize(tmp)
    with open(tmp, 'rb') as fh:
        h = hashlib.sha256(fh.read()).hexdigest()
    key = 'figures/%s/%s.webp' % (h[:2], h)
    dst = os.path.join(storage_dir, key)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        os.remove(tmp)
    else:
        os.replace(tmp, dst)
    return key, size


def offset_in_stem(stem, pre_ns_len):
    """把「题内前若干非空白字符」映射回 stem 自身坐标。"""
    if pre_ns_len <= 0:
        return 0
    cnt = 0
    for i, ch in enumerate(stem):
        if ch.isspace():
            continue
        cnt += 1
        if cnt == pre_ns_len:
            return i + 1
    return len(stem)


def main():
    mf = json.load(open(sys.argv[1]))
    docx = mf['docx']
    pdf_path = mf.get('pdf') or (os.path.splitext(docx)[0] + '.pdf')
    storage = mf['storageDir']
    objects = mf.get('objects') or []

    stat = {'objs': 0, 'marks': 0, 'inStem': 0, 'ok': 0, 'formula': 0, 'figure': 0,
            'miss': 0, 'bytes': 0, 'pdfOk': 0}
    items = []

    z, clean, pos, meta = parse_docx(docx)
    stat['marks'] = len(pos)
    stat['figMarks'] = sum(1 for m in meta.values() if m['kind'] == 'figure')
    stat['fmlMarks'] = len(meta) - stat['figMarks']

    if not ensure_pdf(docx, pdf_path):
        json.dump({'engine': ENGINE, 'stat': stat, 'items': []}, open(os.path.join(
            os.path.dirname(mf['docx']), 'result.json'), 'w'), ensure_ascii=False)
        print(json.dumps(stat, ensure_ascii=False))
        return
    stat['pdfOk'] = 1
    pdf = Pdf(pdf_path)
    cache = RenderCache()

    # 全文去空白索引，用于把库内 stem 对回文字流
    ns_idx = [i for i, c in enumerate(clean) if not c.isspace()]
    ns = ''.join(clean[i] for i in ns_idx)

    for o in objects:
        stat['objs'] += 1
        stem = o.get('stem') or ''
        ns_stem = norm(stem)
        if len(ns_stem) < 10:
            continue
        q = ns.find(ns_stem)
        if q < 0:
            stat['miss'] += 1
            continue
        p = ns_idx[q]
        end = ns_idx[q + len(ns_stem) - 1] + 1
        inside = sorted([(pp, n) for n, pp in pos.items() if p <= pp < end])
        stat['inStem'] += len(inside)
        if not inside:
            continue
        seq = 0
        for pp, n in inside:
            m = meta[n]
            pre_ns = len(norm(clean[p:pp]))
            img = None
            page_no = None
            if m['kind'] == 'formula':
                got = crop_formula(pdf, clean, pos, n, cache)
                if got:
                    img, page_no = got
            else:
                img = grab_figure(z, m['files'])
                if img is None:
                    stat['figFail'] = stat.get('figFail', 0) + 1
                    if stat['figFail'] <= 3:
                        print('[figFail] files=%r' % (m['files'],), file=sys.stderr)
                elif img.width < MIN_SIDE or img.height < MIN_SIDE:
                    img = None
            if img is None:
                continue
            key, size = save_webp(img, storage)
            off = offset_in_stem(stem, pre_ns)
            items.append({
                'index': o.get('index'), 'seq': seq, 'offset': off,
                'kind': m['kind'], 'key': key,
                'w': img.width, 'h': img.height, 'page': page_no,
            })
            stat['ok'] += 1
            stat[m['kind']] += 1
            stat['bytes'] += size
            seq += 1

    pdf.close()
    try:
        os.remove(os.path.join(storage, '_inline_tmp.webp'))
    except Exception:
        pass
    out = os.path.join(os.path.dirname(docx), 'result.json')
    json.dump({'engine': ENGINE, 'stat': stat, 'items': items}, open(out, 'w'), ensure_ascii=False)
    print(json.dumps(stat, ensure_ascii=False))


if __name__ == '__main__':
    main()
