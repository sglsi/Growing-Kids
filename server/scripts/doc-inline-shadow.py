#!/usr/bin/env python3
"""P-020 影子链路：F0 / F1 / F2 / F3 四道闸门 + F5「看得懂」语义闸（只读）。

🔴 思傅 2026-11-10 逐题拍板：Q1 ① 重转产物 + F0；Q2 ① char_start 唯一最近；
   Q3 ① OLE 未定性全跳过；Q4 ① 授权阶段 1 影子脚本实现 F0/F1/F2；
   Q5 未授权 --apply（本文件不含任何写库 / 产图 / 写 storage 路径）。
🔴 2026-11-10 晚追加：思傅「首先完成『看得懂』目标的实现」⇒ 新增 F5 语义闸。
   F5 是**只读判定层**：只决定「这张图发不发」，不清洗文字流、不改 char_offset、
   不碰 text_content / text_sha256，因此不破坏 F0 同源铁律与既有坐标系。
🔴 2026-11-10 追加：思傅 D-032 拍板 B②「加『换行+短数字串』专项规则并重跑」⇒ 新增 F5b。
   D-032 §4① 实证 4 条宽窗口漏网：前 3 条是 VML 尺寸残串「\n043815」「\n0240030」
   「\n1714500」，因距插点恰好 9 字（> F5 neighbor=8）漏网；第 4 条是「导学号 58504170」
   被插点切断的正常内容。F5b 不简单放宽 F5 阈值（会误伤 `_` / 年份 / 题号），
   而是**只认「换行 + ≥6 位纯数字串 + 后接行尾/空白/标点」这一 VML 特征**，
   并对「导学号/准考证/编号/学号/ISBN」等允许词整条放行。仍是只读判定，零清洗。

设计铁律（P-020 §2 不变量）：
  · **不覆盖生产真相源**：直接 importlib 加载 `netdisk-inline-crop.py`（parse_docx /
    norm / offset_in_stem）与 `ocr-engine/pdf_tool.py`（extract_docx），不复刻口径。
  · **零写库、零写 storage、零产图**：只输出 JSON；本文件里没有 INSERT/UPDATE、
    没有 PDF 渲染、没有 save_webp。图候选只给「插入点坐标 + 类型」。
  · **定位不到不入库不下发**：F0 哈希不符 / F1 判据不过 / F2 无唯一最近或最近
    不在期望位置 / F3 未定性 OLE / F5 插入点语义不正 ⇒ 一律丢图，
    绝不拿相邻题、相邻行顶替。
  · **F4 未实现**：候选 SQL 仍只认 ext='docx'，见 netdisk-inline-build.mjs。

F5 方法依据（2026-11-10 检索主流做法，见 docs/reports/P-020-主流设计方法调研与F5语义闸.md）：
  · offset-preserving normalization：清洗文本必须维护 original↔normalized 映射；
    本实现走更保守的分支——**根本不改原文**，只做「发不发」的判定，无需重映射。
  · span grounding / fail-closed：每个落点必须能在原文取到真实、可回放的上下文，
    取不到或落在噪声里就丢，不猜、不补位。
  · surface its own failures：全量候选逐条输出判定理由与上下文，而非只报聚合数。
  · keep original surface form：绝不为「看起来干净」而重写入库正文。

用法：
  python doc-inline-shadow.py <manifest.json>     # 单文档影子核验，JSON 打 stdout
  python doc-inline-shadow.py --selftest          # 合成 docx 自测（需生产 Python 依赖）
  python doc-inline-shadow.py --gate-selftest     # F5 纯函数自测（零依赖，本地可跑）

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


F5_WINDOW = int(os.environ.get('P020_F5_WINDOW') or '24')
F5_NEIGHBOR = int(os.environ.get('P020_F5_NEIGHBOR') or '8')
F5_MAX_STEM = int(os.environ.get('P020_F5_MAX_STEM') or '3000')
F5_NOISE_NUM = re.compile(r'-?\d{7,}\.?')

# ---- F5b（D-032 B②）：换行 + 短数字串专项规则 --------------------------------
# VML/OLE 尺寸残串的真实形态：换行后紧跟 6~8 位纯数字，数字后面是行尾、空白或
# 标点（不是「年/月/日/届/版/页/题/分」等正常量词）。D-032 §4① 的 3 条漏网
# 全部是这个形态，且都因距离插点 9 字（比 F5 neighbor=8 多 1 字）溜过。
# 🔴 故意不放宽 F5_NOISE_NUM 的位数或 neighbor：那会误伤年份「2017年」、
# 下划线填空「______」、题号「1.」等正常内容。F5b 只补这一条形态。
F5B_WINDOW = int(os.environ.get('P020_F5B_WINDOW') or '32')
# 后随只排除「还是数字」：`\n2017年`（4 位）、`\n(1)2016` 天然不命中；
# 6 位以上独立数字行在真实题干里几乎只有 VML 尺寸残串，按 fail-closed 拦下更稳。
F5B_NOISE = re.compile(r'[\r\n]+[ \t]*(-?\d{6,})(?!\d)')
# 带这些标识词的数字串是题目的正常编号（导学号/准考证/ISBN 等），整条放行。
F5B_ALLOW_WORDS = ('导学号', '准考证', '编号', '学号', '考号', 'ISBN', '书号',
                   '条码', '书编号', '试卷编号')
F5B_CONTEXT = int(os.environ.get('P020_F5B_CONTEXT') or '48')


def semantic_gate(stem, off, window=F5_WINDOW, neighbor=F5_NEIGHBOR,
                  max_stem=F5_MAX_STEM):
    """F5 + F5b「看得懂」语义闸：判断图的插入点是否落在可理解的题干文字里。

    只读判定，返回 (ok, reason, evidence)。**绝不修改 stem，也不重映射 char_offset**：
    F0 钉的是入库文字流，任何清洗都会让 10,147 份正文与 656,898 个题目对象坐标失效。

    判定顺序刻意固定：F5 既有判据优先，F5b 只补漏，保证 D-032 的 drop_reasons
    基线与 9 个已知残串的命中口径不变、可前后对照。
    """
    stem = stem or ''
    n = len(stem)
    if n > max_stem:
        return False, 'stem_too_long', {'stem_len': n, 'max_stem': max_stem}
    if off is None or off <= 0:
        return False, 'offset_zero', {'off': off, 'stem_len': n}
    if off > n:
        return False, 'offset_oob', {'off': off, 'stem_len': n}
    lo = max(0, off - window)
    before = stem[lo:off]
    after = stem[off:off + window]
    ev = {'off': off, 'stem_len': n, 'insert_before': before[-16:],
          'insert_after': after[:16]}
    if '\ufffd' in before or '\ufffd' in after:
        return False, 'replacement_char_nearby', ev
    for m in F5_NOISE_NUM.finditer(before):
        tail = len(before) - m.end()
        head = len(before) - m.start()
        if tail <= neighbor or (head >= neighbor >= tail):
            ev['noise'] = m.group(0)
            return False, 'vml_number_noise_before', ev
    for m in F5_NOISE_NUM.finditer(after):
        if m.start() <= neighbor:
            ev['noise'] = m.group(0)
            return False, 'vml_number_noise_after', ev

    # ---- F5b：换行 + ≥6 位纯数字残串（宽窗口，仍只读） ----
    # 允许词在更宽的上下文里找：如「(导学号 58|504170)」被插点切断时，
    # 「导学号」在 before、数字在 after，必须拼起来看才不会误杀正常内容。
    ctx = stem[max(0, off - F5B_CONTEXT):off + F5B_CONTEXT]
    if not any(w in ctx for w in F5B_ALLOW_WORDS):
        b_win = stem[max(0, off - F5B_WINDOW):off]
        a_win = stem[off:off + F5B_WINDOW]
        for side, text in (('after', a_win), ('before', b_win)):
            m = F5B_NOISE.search(text)
            if m:
                ev['f5b_noise'] = m.group(1)
                ev['f5b_side'] = side
                return False, f'newline_short_number_{side}', ev
    else:
        ev['f5b_allow_word'] = next(w for w in F5B_ALLOW_WORDS if w in ctx)
    return True, 'ok', ev


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
        'semantic_pass': 0, 'semantic_dropped': 0,
    }
    drop_reasons = {}
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
            sem_ok, sem_reason, sem_ev = semantic_gate(stem, off)
            if sem_ok:
                st['semantic_pass'] += 1
            else:
                st['semantic_dropped'] += 1
                drop_reasons[sem_reason] = drop_reasons.get(sem_reason, 0) + 1
            candidates.append({
                'index': o.get('index'), 'q': q, 'q_exp': q_exp,
                'char_offset': off, 'stem_len': len(stem), 'kind': 'figure',
                'mark_offset': pp,
                'insert_before': stem[max(0, off - 16):off],
                'insert_after': stem[off:off + 16],
                'semantic': 'pass' if sem_ok else 'drop',
                'drop_reason': None if sem_ok else sem_reason,
                'semantic_evidence': sem_ev,
            })
            st['figure_candidates'] += 1

    base['status'] = 'ok'
    base['f2_f3'] = st
    base['f5'] = {
        'window': F5_WINDOW, 'neighbor': F5_NEIGHBOR, 'max_stem': F5_MAX_STEM,
        'drop_reasons': drop_reasons,
        'rule': 'offset_zero / offset_oob / 邻域长数字残串 / U+FFFD / 超长 stem 一律丢图；不清洗原文',
        'f5b': {
            'window': F5B_WINDOW, 'context': F5B_CONTEXT,
            'noise': F5B_NOISE.pattern, 'allow_words': list(F5B_ALLOW_WORDS),
            'rule': '换行 + ≥6 位纯数字残串（VML 尺寸）一律丢图；'
                    '导学号/准考证/编号/学号/ISBN 等标识词整条放行；仍不清洗原文',
        },
    }
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


def gate_selftest():
    """F5 + F5b 纯函数自测：二次评审实证残串 + D-032 §4① 4 条边界候选，零依赖本地可跑。

    前 15 条是 D-032 的 F5 基线（一条不改、必须继续全绿）；后 10 条是 B② 新增的
    F5b 专项：3 条真实漏网形态必须 drop，第 4 条「导学号」必须 pass，
    另加年份 / 题号 / 无换行短数字 / 允许词 / 插点前残串等防误伤反例。
    """
    pad = '在三角形中' * 20          # 造出 off>100 的深插点，不影响窗口判据
    cases = [
        ('zero_offset', '已知平行四边形面积为24，求阴影部分面积。', 0, False, 'offset_zero'),
        ('negative_offset', '已知平行四边形面积为24，求阴影部分面积。', -3, False, 'offset_zero'),
        ('offset_oob', '已知平行四边形面积为24，求阴影部分面积。', 999, False, 'offset_oob'),
        ('stem_too_long', '题目' * 2000, 12, False, 'stem_too_long'),
        ('residual_1', '1088390010947400已知平行四边形面积，求阴影面积。', 16, False, 'vml_number_noise_before'),
        ('residual_2', '98107568580已知平行四边形面积，求阴影面积。', 11, False, 'vml_number_noise_before'),
        ('residual_3', '1205230012509500已知平行四边形面积，求阴影面积。', 16, False, 'vml_number_noise_before'),
        ('residual_4', '1146810011391900已知平行四边形面积，求阴影面积。', 16, False, 'vml_number_noise_before'),
        ('residual_neg', '-37147512763528已知平行四边形面积，求阴影面积。', 15, False, 'vml_number_noise_before'),
        ('residual_after', '已知平行四边形面积30861007861303.求阴影面积。', 10, False, 'vml_number_noise_after'),
        ('replacement_char', '已知\ufffd平行四边形面积为24，求阴影部分面积。', 10, False, 'replacement_char_nearby'),
        ('normal_mid', '已知平行四边形ABCD的面积为24，求阴影部分的面积最大值。', 12, True, 'ok'),
        ('normal_year', '2026年中考数学模拟题，已知抛物线y=x²+2x，求顶点坐标。', 16, True, 'ok'),
        ('normal_question_no', '1. 已知三角形ABC中AB=AC，求角B的度数。', 4, True, 'ok'),
        ('far_long_number', '准考证号1234567890，已知平行四边形面积为24，求阴影部分面积。', 30, True, 'ok'),
        # ---- F5b（D-032 §4① 4 条宽窗口边界候选） ----
        ('f5b_leak_1', '6.读“长江三角洲”图完成。' + '\n043815\n\n1983740' + '读图回答下列问题。',
         14, False, 'newline_short_number_after'),
        ('f5b_leak_2', pad + '不含点）上任取一点（，，），记，' + '的内心分别为，，\n0240030' + '求证三点共线。',
         len(pad) + 16, False, 'newline_short_number_after'),
        ('f5b_leak_3', pad + '点,连结交圆于点,连结并延长与边' + '交于点,证明:\n\n1714500' + '求证结论成立。',
         len(pad) + 16, False, 'newline_short_number_after'),
        ('f5b_allow_导学号', pad + '化合反应的是(B)(导学号 58' + '504170)\nA．2Na＋2H' + '属于化合反应。',
         len(pad) + 16, True, 'ok'),
        # ---- F5b 防误伤 / 方向反例 ----
        ('f5b_normal_year', '已知如图，' + '\n2017年中考数学模拟题，求抛物线顶点坐标。',
         5, True, 'ok'),
        ('f5b_normal_question_no', '已知三角形ABC，' + '\n(1)求角B的度数；(2)求边长。',
         8, True, 'ok'),
        ('f5b_allow_word_explicit', '已知(导学号 58' + '\n504170)下列说法中正确的是',
         9, True, 'ok'),
        ('f5b_no_newline', '已知面积043815平方厘米，求阴影部分的面积。', 8, True, 'ok'),
        ('f5b_noise_before', '已知如图\n043815求阴影部分面积。', 11, False, 'newline_short_number_before'),
        ('f5b_underscore_fill', '填空：______' + '\n已知平行四边形ABCD面积为24，求阴影面积。',
         9, True, 'ok'),
    ]
    out = []
    for name, stem, off, want_ok, want_reason in cases:
        ok, reason, _ = semantic_gate(stem, off)
        out.append({'case': name, 'want': want_ok, 'got': ok,
                    'reason': reason, 'pass': ok == want_ok and reason == want_reason})
    summary = {'gate_selftest': out, 'total': len(out),
               'passed': sum(1 for x in out if x['pass']),
               'all_pass': all(x['pass'] for x in out)}
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary['all_pass'] else 2


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--selftest':
        return selftest()
    if len(sys.argv) > 1 and sys.argv[1] == '--gate-selftest':
        return gate_selftest()
    mf = json.load(open(sys.argv[1], encoding='utf-8'))
    print(json.dumps(run_shadow(mf), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
