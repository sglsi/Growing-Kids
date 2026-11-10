#!/usr/bin/env python3
"""P-020 / D-033：独立 `.doc` 产图链路的 Python 侧（只读判定 + 本地暂存产图）。

🔴 本文件是 A 授权「另建独立 `.doc` 产图链路」的实现，**不是**改
   `netdisk-inline-build.mjs`（docx 侧零回归），也**不是**改生产真相源
   `netdisk-inline-crop.py`（只读 import，sha 不变）。

链路位置：
  下载 `.doc` → 独立 LO profile 重转 docx → F0 同源 → F1 严格前缀 →
  F2 char_start 消歧 → F3 OLE 全跳过 → F5/F5b「看得懂」语义闸 →
  只对 pass 的 `w:drawing` 图标记取 docx 内嵌图 → WebP 落到**本地暂存目录** →
  输出「待写清单」result.json（Node 侧读）。

零写入边界（本轮 C② 让 Q5 --apply 顺延）：
  · 不写数据库、不写生产 storage、不写 `question_objects` / `netdisk_files`；
  · WebP 只落 `workDir/figures/...`，用完由 Node 侧删除；
  · 不下发、不改 `char_offset`、不清洗文字流、不重映射坐标系；
  · **不产公式**：F3 未定性 `w:object` / OLE 一律跳过，且本链路不转 PDF
    （PDF 渲染 / 裁切 / 产图 / 写库资源压测仍是 Q5 前置，另案）。

判据全部复用影子链路 `doc-inline-shadow.py::run_shadow` 与真相源
`netdisk-inline-crop.py::parse_docx / grab_figure / save_webp`，不另起口径：
`run_shadow` 已给出逐条 `semantic` / `drop_reason` / `mark_offset` / `char_offset`，
本文件只做「按 mark_offset 反查图标记 → 取内嵌图」这一步。

用法（由 doc-inline-figure-build.mjs 调用，不手工跑）：
  python doc-inline-figure-crop.py <manifest.json>
manifest 字段：
  id, docx, workDir, cropPath, pdfToolPath, shadowPy, textSha256,
  marksExpected, objects[{index, start, stem}]
输出：`workDir/result.json`（待写清单），stdout 打一行统计 JSON。
"""
import importlib.util
import json
import os
import sys


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    mf = json.load(open(sys.argv[1], encoding='utf-8'))
    work = mf['workDir']
    os.makedirs(work, exist_ok=True)
    result_path = os.path.join(work, 'result.json')

    shadow = load('gk_p020_shadow_for_figure', mf['shadowPy'])
    crop = load('gk_p020_crop_for_figure', mf['cropPath'])
    # 版本守卫：D-033 的 F5b（换行+短数字串）必须在影子语义闸里生效才准产图，
    # 否则会拿 D-032 的旧判定放行 4 条边界候选里的 3 条 VML 残串。
    if not hasattr(shadow, 'F5B_NOISE') or not hasattr(shadow, 'semantic_gate'):
        raise RuntimeError('影子链路缺 F5b 语义闸，拒绝产图（请同步 doc-inline-shadow.py）')

    out = {
        'id': mf.get('id'), 'engine': 'p020-doc-figure-v1',
        'status': None, 'reason': None,
        'f0': None, 'f1': None, 'f2_f3': None, 'f5': None,
        'candidates': 0, 'semantic_pass': 0, 'semantic_dropped': 0,
        'figure_ok': 0, 'figure_fail': 0, 'ole_or_nonfigure_skipped': 0,
        'bytes': 0, 'items': [], 'zero_write': True,
        'apply': 'locked',
    }

    def emit():
        with open(result_path, 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False)
        print(json.dumps({k: v for k, v in out.items() if k != 'items'}, ensure_ascii=False))

    r = shadow.run_shadow(mf)
    out['status'] = r.get('status')
    out['reason'] = r.get('reason')
    out['f0'] = r.get('f0')
    out['f1'] = r.get('f1')
    out['f2_f3'] = r.get('f2_f3')
    out['f5'] = r.get('f5')
    if r.get('status') != 'ok':
        emit()
        return

    cands = r.get('candidates') or []
    passed = [c for c in cands if c.get('semantic') == 'pass']
    out['candidates'] = len(cands)
    out['semantic_pass'] = len(passed)
    out['semantic_dropped'] = len(cands) - len(passed)
    if not passed:
        emit()
        return

    z, clean, pos, meta = crop.parse_docx(mf['docx'])
    by_pos = {p: n for n, p in pos.items()}
    seq_by_obj = {}
    try:
        for c in passed:
            # F3：w:object 未定性，任何非 figure 一律跳过，绝不当公式下发。
            if c.get('kind') != 'figure':
                out['ole_or_nonfigure_skipped'] += 1
                continue
            n = by_pos.get(c.get('mark_offset'))
            mark = meta.get(n) if n else None
            if not mark or mark['kind'] != 'figure':
                out['ole_or_nonfigure_skipped'] += 1
                continue
            img = crop.grab_figure(z, mark['files'])
            if img is None or img.width < crop.MIN_SIDE or img.height < crop.MIN_SIDE:
                out['figure_fail'] += 1
                continue
            key, size = crop.save_webp(img, work)
            idx = c.get('index')
            seq = seq_by_obj.get(idx, 0)
            seq_by_obj[idx] = seq + 1
            out['items'].append({
                'index': idx, 'seq': seq,
                'char_offset': c.get('char_offset'),
                'kind': 'figure', 'key': key, 'size': size,
                'w': img.width, 'h': img.height, 'page': None,
                'mark': n, 'mark_offset': c.get('mark_offset'),
                'q': c.get('q'), 'q_exp': c.get('q_exp'),
                'semantic': 'pass',
            })
            out['figure_ok'] += 1
            out['bytes'] += size
    finally:
        z.close()
        tmp = os.path.join(work, '_inline_tmp.webp')
        if os.path.exists(tmp):
            os.remove(tmp)
    emit()


if __name__ == '__main__':
    sys.exit(main())
