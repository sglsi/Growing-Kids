#!/usr/bin/env python3
"""P-020 阶段 1「影子链路」：F0 / F1 / F2 / F3 四道闸门（只读）。

🔴 思傅 2026-11-10 逐题拍板：Q1 ① 重转产物 + F0；Q2 ① char_start 唯一最近；
   Q3 ① OLE 未定性全跳过；Q4 ① 授权阶段 1 影子脚本实现 F0/F1/F2；
   Q5 未授权 --apply（本文件不含任何写库 / 产图 / 写 storage 路径）。

设计铁律（P-020 §2 不变量）：
  · **不覆盖生产真相源**：直接 importlib 加载 `netdisk-inline-crop.py`（parse_docx /
    norm / offset_in_stem）与 `ocr-engine/pdf_tool.py`（extract_docx），不复刻口径。
  · **零写库、零写 storage、零产图**：只输出 JSON；本文件里没有 INSERT/UPDATE、
    没有 PDF 渲染、没有 save_webp。图候选只给「插入点坐标 + 类型」。
  · **定位不到不入库不下发**：F0 哈希不符 / F1 判据不过 / F2 无唯一最近或最近
    不在期望位置 / F3 未定性 OLE ⇒ 一律丢图，绝不拿相邻题、相邻行顶替。
  · **F4 未实现**：候选 SQL 仍只认 ext='docx'，见 netdisk-inline-build.mjs。

用法：
  python doc-inline-shadow.py <manifest.json>     # 单文档影子核验，JSON 打 stdout
  python doc-inline-shadow.py --selftest          # 合成 docx 自测四道闸门（需生产 Python 依赖）

manifest 字段：
  id, name, docx, cropPath, pdfToolPath, textContent, textSha256,
  marksExpected, objects[{index, start, stem}]
"""
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import zipfile

MAX_TEXT = int(os.environ.get('NETDISK_TEXT_MAX_CHARS') or '200000')
MATCH_CAP = 40


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def norm(s):
    return re.sub(r'\s+', '', s or '')


def sha(s):
    return hashlib.sha256(s.encode('utf-8', 'ignore')).hexdigest()


def first_diff(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def all_matches(ns, needle):
    out, k = [], 0
    while len(out) < MATCH_CAP:
        k = ns.find(needle, k)
        if k < 0:
            break
        out.append(k)
        k += 1
    return out


def run_shadow(mf):
    crop = load('gk_shadow_crop', mf['cropPath'])
    pt = load('gk_shadow_pdf', mf['pdfToolPath'])
    docx = mf['docx']

    # ---------------- F0 同源硬闸 ----------------
    # 与阶段 1 写库口径逐字一致：extract_docx 流 -> stripNul -> slice(0, MAX_TEXT)。
    # docx 二进制哈希不可用作判据（D-024 已证 12/12 全不同），只钉文字流。
    a = pt.extract_docx(docx)['pages'][0]['text'].replace('\x00', '')[:MAX_TEXT]
    f0_hash = sha(a)
    expected = mf.get('textSha256')
    f0_ok = bool(expected) and f0_hash == expected
    base = {
        'id': mf.get('id'), 'name': str(mf.get('name') or '')[:48],
        'f0': {'ok': f0_ok, 'recomputed': f0_hash[:16],
               'recorded': (expected or '')[:16], 'text_len': len(a)},
        'candidates': [],
    }
    if not f0_ok:
        base['status'] = 'f0_reject'
        base['reason'] = '重转文字流与 doc_convert_done.text_sha256 不符，整份跳过'
        return base

    # ---------------- F1 判据修正 ----------------
    # D-025 用「逐字同源」证伪了 P-018 从不使用的不变量。真实口径：
    #   norm(正文 clean) 必须是 norm(text_content) 的严格前缀，首差异 == len(norm(clean))；
    #   b_len>0 && max_offset>0 排除平凡假阳性；stem 不得越过正文边界落进页眉页脚区。
    z, clean, pos, meta = crop.parse_docx(docx)
    na, nb = norm(a), norm(clean)
    b_len = len(nb)
    max_offset = max(pos.values()) if pos else 0
    fd = first_diff(na, nb) if na != nb else None
    strict_prefix = fd is None or (fd == b_len and len(na) > b_len)
    f1_ok = b_len > 0 and max_offset > 0 and na.startswith(nb) and strict_prefix
    marks_expected = mf.get('marksExpected')
    marks_match = marks_expected is None or len(pos) == int(marks_expected)
    base['f1'] = {
        'ok': f1_ok, 'b_len': b_len, 'na_len': len(na), 'max_offset': max_offset,
        'first_diff': fd, 'strict_prefix': strict_prefix,
        'marks': len(pos), 'marks_expected': marks_expected, 'marks_match': marks_match,
    }
    if max_offset == 0 and len(pos) == 0:
        base['status'] = 'no_marks'
        base['reason'] = '重转产物无可抠图标记（纯文本文档），影子链路无候选属正常结果'
        return base
    if not f1_ok or not marks_match:
        base['status'] = 'f1_reject'
        base['reason'] = '正文非空白流非严格前缀 / 图对象数与记账不符'
        return base

    # ---------------- F2 char_start 消歧 + F3 OLE 全跳过 ----------------
    ns_idx = [i for i, c in enumerate(clean) if not c.isspace()]
    ns = ''.join(clean[i] for i in ns_idx)
    dbn = norm(a)
    st = {
        'objects': 0, 'short': 0, 'miss': 0, 'multi': 0, 'ambiguous': 0,
        'no_exact': 0, 'exp_mismatch': 0, 'beyond_body': 0, 'corrected': 0,
        'chosen_not_expected': 0, 'in_stem_marks': 0, 'ole_skipped': 0,
        'offset_zero': 0, 'offset_oob': 0, 'figure_candidates': 0,
    }
    candidates = []
    for o in mf.get('objects') or []:
        st['objects'] += 1
        stem = o.get('stem') or ''
        ns_stem = norm(stem)
        if len(ns_stem) < 10:
            st['short'] += 1
            continue
        start = int(o.get('start') or 0)
        q_exp = len(norm(a[:start]))
        if q_exp > len(ns):
            st['beyond_body'] += 1
            continue
        exp_ok = dbn[q_exp:q_exp + len(ns_stem)] == ns_stem
        qs = all_matches(ns, ns_stem)
        if not qs:
            st['miss'] += 1
            continue
        if len(qs) >= MATCH_CAP:
            st['ambiguous'] += 1
            continue
        if len(qs) > 1:
            st['multi'] += 1
        best = min(qs, key=lambda q: abs(q - q_exp))
        nearest = [q for q in qs if abs(q - q_exp) == abs(best - q_exp)]
        if len(nearest) != 1:
            st['ambiguous'] += 1
            continue
        q = nearest[0]
        # 保守子闸：唯一最近但不在 char_start 换算的期望位置 ⇒ 视为定位失败。
        # 实证 243/244 本就 dist=0，此闸不损失命中，只把「明知不对」的图拦下。
        if q != q_exp:
            st['no_exact'] += 1
            st['chosen_not_expected'] += 1
            continue
        if not exp_ok:
            st['exp_mismatch'] += 1
            continue
        if qs[0] != q:
            st['corrected'] += 1
        p = ns_idx[q]
        end = ns_idx[q + len(ns_stem) - 1] + 1
        inside = sorted((pp, n) for n, pp in pos.items() if p <= pp < end)
        st['in_stem_marks'] += len(inside)
        for pp, n in inside:
            if meta[n]['kind'] == 'formula':
                # F3：w:object 性质未定，不得当公式、不得入库不下发
                st['ole_skipped'] += 1
                continue
            pre_ns = len(norm(clean[p:pp]))
            off = crop.offset_in_stem(stem, pre_ns)
            if off <= 0:
                st['offset_zero'] += 1
            if off > len(stem):
                st['offset_oob'] += 1
            candidates.append({
                'index': o.get('index'), 'q': q, 'q_exp': q_exp,
                'char_offset': off, 'stem_len': len(stem), 'kind': 'figure',
                'mark_offset': pp,
                'insert_before': stem[max(0, off - 16):off],
                'insert_after': stem[off:off + 16],
            })
            st['figure_candidates'] += 1

    base['status'] = 'ok'
    base['f2_f3'] = st
    base['candidates'] = candidates
    return base


# ==========================================================================
# 合成 docx 自测：证明四道闸门「真的会拦」，而不是只在 28 份好样本上全绿。
# 只在生产 Python（有 pypdfium2 / PIL）里跑，本地 py_compile 即可验语法。
# ==========================================================================
def _make_docx(path, body, header='页眉页脚追加测试文字'):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(
            'word/document.xml',
            '<?xml version="1.0"?><w:document '
            'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + body + '</w:document>')
        z.writestr('word/_rels/document.xml.rels', '<Relationships/>')
        z.writestr('word/header1.xml', '<w:hdr><w:p><w:r><w:t>' + header + '</w:t></w:r></w:p></w:hdr>')


def selftest():
    root = os.path.dirname(os.path.abspath(__file__))
    crop_path = os.environ.get('GK_CROP_PY') or os.path.join(root, 'netdisk-inline-crop.py')
    pdf_path = os.environ.get('GK_PDF_PY') or os.path.join(root, '..', '..', 'ocr-engine', 'pdf_tool.py')
    head = '已知二次函数图像如图所示'
    tail = '求其解析式并说明理由第一题'
    stem = head + tail
    # 图标记必须夹在 stem 文字**中间**，才落在 P-018 的 [p, end) 题干区间内；
    # 第二处额外放一个 w:object（未定性 OLE），用来证明 F3 会把它整批跳过。
    para = lambda ole: (
        '<w:p><w:r><w:t>' + head + '</w:t></w:r>'
        '<w:r><w:drawing></w:drawing></w:r>'
        + ('<w:r><w:object></w:object></w:r>' if ole else '')
        + '<w:r><w:t>' + tail + '</w:t></w:r></w:p>')
    body = para(False) + para(True)
    with tempfile.TemporaryDirectory(prefix='gk-p020-selftest-') as td:
        docx = os.path.join(td, 'synthetic.docx')
        _make_docx(docx, body)
        pt = load('gk_shadow_pdf_st', pdf_path)
        a = pt.extract_docx(docx)['pages'][0]['text'].replace('\x00', '')[:MAX_TEXT]
        s1 = a.find(stem)
        s2 = a.find(stem, s1 + 1)
        assert s1 >= 0 and s2 > s1, '合成文档未造出两处相同 stem'
        mf = {
            'id': 'selftest', 'name': 'synth', 'docx': docx,
            'cropPath': crop_path, 'pdfToolPath': pdf_path,
            'textContent': a, 'textSha256': sha(a),
            'objects': [
                {'index': 0, 'start': s1, 'stem': stem},
                {'index': 1, 'start': s2, 'stem': stem},
            ],
        }
        ok = run_shadow(mf)
        f = ok['f2_f3']
        checks = {
            'F0_pass': ok['status'] == 'ok' and ok['f0']['ok'],
            'F1_strict_prefix': ok['f1']['ok'] and ok['f1']['strict_prefix'],
            'F2_multi_detected': f['multi'] >= 2,
            'F2_corrected_first_hit': f['corrected'] >= 1,
            'F2_all_chosen_expected': f['chosen_not_expected'] == 0 and f['no_exact'] == 0,
            'F2_no_oob': f['offset_oob'] == 0,
            'F3_ole_all_skipped': f['ole_skipped'] >= 1
            and all(c['kind'] == 'figure' for c in ok['candidates']),
            'figure_candidates': f['figure_candidates'] >= 1,
        }
        # F0 反例：哈希被篡改 ⇒ 整份拒绝，零候选
        bad = dict(mf, textSha256='0' * 64)
        rej = run_shadow(bad)
        checks['F0_reject_on_mismatch'] = rej['status'] == 'f0_reject' and not rej['candidates']
        # F2 反例：char_start 落在两处匹配中点 ⇒ 无唯一最近，丢图
        mid = dict(mf, objects=[{'index': 9, 'start': (s1 + s2) // 2, 'stem': stem}])
        tie = run_shadow(mid)
        tf = tie.get('f2_f3') or {}
        checks['F2_drop_on_misaligned_char_start'] = (
            tie['status'] == 'ok'
            and (tf.get('ambiguous', 0) + tf.get('no_exact', 0)
                 + tf.get('exp_mismatch', 0)) >= 1
            and tf.get('figure_candidates', 0) == 0)
        print(json.dumps({'selftest': checks, 'pass': all(checks.values()),
                          'ok_stat': f, 'f0_reject': rej['status'],
                          'tie_stat': tie.get('f2_f3')}, ensure_ascii=False))
        return 0 if all(checks.values()) else 2


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        return selftest()
    mf = json.load(open(sys.argv[1], encoding='utf-8'))
    print(json.dumps(run_shadow(mf), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
