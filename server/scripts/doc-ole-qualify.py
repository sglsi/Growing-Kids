#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P-023 T1–T4 只读定性探针（D-042 实施，2026-11-13）

挂接方式：复用 doc-inline-shadow.mjs 的 --stage3 抽样 / 下载 / 重转驱动，
         由该驱动的 --shadow-py 指向本文件。**既有真相源一行不改**，
         本文件不 import netdisk-inline-crop.py / pdf_tool.py，
         不参与 F0–F5 判定、不产出候选、不改任何判定结论。

🔴 只读纪律：
  · 只 zipfile 读重转 docx 的 word/document.xml，零 LibreOffice 调用；
  · 零写入（唯一例外＝把结构化统计追加到 GK_QUALIFY_OUT 指定的本地结果文件）；
  · 不写库、不产图、不下发、不改 text_content / text_sha256；
  · **不输出任何题干原文 / user_id / 完整归一文本**，只输出计数、哈希与字符类别。
  · 形态分类用正则做普查，不是严格 XML 解析；结果只作定性线索，
    不作判定结论、不作 Q5 放行依据、不计算准确率 / 召回率。

输出：stdout 一行最小 JSON（供驱动消费）＋ 逐份结构化记录追加到
      GK_QUALIFY_OUT（JSONL，由报告脚本汇总）。
"""
import html
import json
import os
import re
import sys
import zipfile

TAGS = [
    'w:drawing', 'w:object', 'w:pict', 'm:oMath', 'm:oMathPara',
    'v:shape', 'v:imagedata', 'w:txbxContent', 'w:t', 'w:instrText',
    'w:fldChar', 'o:OLEObject', 'w:binData', 'w:sym',
]

KEEP = re.compile(r'[^A-Za-z0-9\u4e00-\u9fff]')


def count_tag(xml, tag):
    return len(re.findall(r'<' + re.escape(tag) + r'(?=[\s/>])', xml))


def object_segments(xml):
    return [m.group(0) for m in
            re.finditer(r'<w:object\b[^>]*>.*?</w:object>', xml, re.S)]


def classify(seg):
    nodes = re.findall(r'<w:t(?:\s[^>]*)?>(.*?)</w:t>', seg, re.S)
    inner = html.unescape(''.join(nodes))
    style = re.search(r'style="([^"]*)"', seg)
    dims = re.findall(r'(width|height)\s*:\s*([\d.]+)(pt|cm|in|px)',
                      style.group(1) if style else '')
    tiny = False
    for _, v, unit in dims:
        try:
            cm = float(v) * {'pt': 0.0353, 'cm': 1.0, 'in': 2.54, 'px': 0.0265}[unit]
            if cm < 0.5:
                tiny = True
        except (ValueError, KeyError):
            pass
    has_ole = '<o:OLEObject' in seg
    has_vml = ('<v:shape' in seg) or ('<v:imagedata' in seg)
    has_math = bool(re.search(r'<m:oMath(?=[\s/>])', seg))
    has_textbox = '<w:txbxContent' in seg
    has_rid = bool(re.search(r'r:(?:id|embed)="', seg))
    if has_math:
        label = 'contains_omath'
    elif has_textbox:
        label = 'textbox'
    elif has_ole and has_vml:
        label = 'ole_with_vml_image'
    elif has_ole:
        label = 'ole_only'
    elif has_vml:
        label = 'vml_only'
    elif inner.strip():
        label = 'text_only'
    else:
        label = 'other'
    return {
        'label': label,
        'has_ole': has_ole,
        'has_vml': has_vml,
        'has_omath': has_math,
        'has_textbox': has_textbox,
        'has_rid': has_rid,
        'has_inner_text': bool(inner.strip()),
        'inner_text_chars': len(inner.strip()),
        'inner_text_han': sum(1 for c in inner if '\u4e00' <= c <= '\u9fff'),
        'tiny_lt_0_5cm': tiny,
        'seg_bytes': len(seg),
    }


def doc_text(xml):
    x = re.sub(r'<w:tab\b[^>]*/>', '\t', xml)
    x = re.sub(r'<w:br\b[^>]*/>', '\n', x)
    return html.unescape(''.join(
        re.findall(r'<w:t(?:\s[^>]*)?>(.*?)</w:t>', x, re.S)))


def norm(s):
    return KEEP.sub('', s or '')


def char_kind(ch):
    if '\u4e00' <= ch <= '\u9fff':
        return 'han'
    if ch.isdigit():
        return 'digit'
    if ch.isalpha():
        return 'latin'
    return 'other'


def first_diff(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n if len(a) != len(b) else -1


def main():
    with open(sys.argv[1], encoding='utf-8') as f:
        mf = json.load(f)
    rec = {'id': str(mf.get('id', '')), 'ok': False}
    try:
        with zipfile.ZipFile(mf['docx']) as z:
            xml = z.read('word/document.xml').decode('utf-8', 'ignore')
            names = z.namelist()
        # ---- T1 标签普查 ----
        tags = {t: count_tag(xml, t) for t in TAGS}
        rec['t1_tags'] = tags
        rec['xml_bytes'] = len(xml)
        rec['media_files'] = sum(1 for n in names if n.startswith('word/media/'))
        rec['parts'] = len(names)

        # ---- T2 对象解剖（只留形态，不留原文）----
        segs = object_segments(xml)
        classes = [classify(s) for s in segs]
        labels = {}
        for c in classes:
            labels[c['label']] = labels.get(c['label'], 0) + 1
        rec['t2'] = {
            'w_object_segments': len(segs),
            'labels': labels,
            'with_inner_text': sum(1 for c in classes if c['has_inner_text']),
            'inner_text_chars_total': sum(c['inner_text_chars'] for c in classes),
            'inner_text_han_total': sum(c['inner_text_han'] for c in classes),
            'with_omath': sum(1 for c in classes if c['has_omath']),
            'with_rid': sum(1 for c in classes if c['has_rid']),
            'tiny_lt_0_5cm': sum(1 for c in classes if c['tiny_lt_0_5cm']),
            'seg_bytes_max': max((c['seg_bytes'] for c in classes), default=0),
        }

        # ---- T3 逐字符对比（诊断性，非真相源口径）----
        a = norm(doc_text(xml))
        b = norm(mf.get('textContent') or '')
        p = first_diff(a, b)
        rec['t3'] = {
            'docx_norm_len': len(a),
            'db_norm_len': len(b),
            'len_delta': len(a) - len(b),
            'first_diff_pos': p,
            'first_diff_docx_kind': char_kind(a[p]) if 0 <= p < len(a) else None,
            'first_diff_db_kind': char_kind(b[p]) if 0 <= p < len(b) else None,
            'identical_prefix': p == -1,
            'db_stem_objects': len(mf.get('objects') or []),
            'marks_expected': mf.get('marksExpected'),
        }

        # ---- T4 交叉线索（供报告层汇总）----
        rec['t4'] = {
            'has_omath_tags': tags.get('m:oMath', 0) > 0 or tags.get('m:oMathPara', 0) > 0,
            'has_object_tags': tags.get('w:object', 0) > 0,
            'has_pict_tags': tags.get('w:pict', 0) > 0,
            'has_drawing_tags': tags.get('w:drawing', 0) > 0,
            'lost_chars': len(b) > len(a),
            'extra_chars': len(a) > len(b),
        }
        rec['ok'] = True
    except Exception as e:
        rec['error'] = '%s: %s' % (type(e).__name__, str(e)[:180])

    out = os.environ.get('GK_QUALIFY_OUT', '')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')

    print(json.dumps({
        'status': 'ok' if rec['ok'] else 'error',
        'reason': 'p023_qualify_only',
        'candidates': [],
        'qualify': {'id': rec['id'], 'ok': rec['ok'], 'error': rec.get('error')},
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
