#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert_espcn_pb.py — 把 ESPCN 的 .pb（TensorFlow 冻结图 / SavedModel）权重
转换为本项目智能高清引擎（push-ready/server/src/image/image-superres.ts）的
JSON 权重格式，供 loadESPCNWeights 直接消费。

架构前提：与本项目 ESPCN 引擎同构（3 层卷积 + PixelShuffle）。
  conv1: kh×kw × in=1 × out=c1   （论文 5×5 × 1 × 64）
  conv2: 3×3 × in=c1 × out=c2     （论文 3×3 × 64 × 32）
  conv3: 3×3 × in=c2 × out=scale² （论文 3×3 × 32 × r²）

TF 卷积核布局 [kh, kw, inC, outC] → 本项目布局 ((o*inC+i)*kh+ky)*kh+kx。

用法：
  python convert_espcn_pb.py <path> [scale] [--out out.json]
                              [--c1 NAME] [--c2 NAME] [--c3 NAME]
                              [--out_act sigmoid|relu|none]
  <path> 可为单个 .pb 冻结图，或一个 SavedModel 目录。
  scale  省略时由 conv3 输出通道开平方自动推断（scale=√outC3）。

输出：espcn_weights_x{scale}.json

⚠️ 关于 I/O 约定（重要，影响正确性）：
  本项目引擎固定：输入 Y ÷255 进入 [0,1]；conv1/conv2 用 act(默认 tanh)；
  pixel_shuffle 后用 outAct(默认 sigmoid) 再 ×255。
  若你的 .pb 内部已自行做 ÷255 / sigmoid，则此处 act/outAct 应改为 'none'，
  否则会双重缩放。脚本会先打印所有 4D 核与 1D 偏置便于你核对。
"""
import sys, os, json, argparse, re
import numpy as np


def load_kernels(path):
    """返回 {name: np.ndarray} 与载入方式。支持冻结图与 SavedModel。"""
    import tensorflow as tf
    weights = {}
    kind = 'frozen'
    if os.path.isdir(path):
        try:
            m = tf.saved_model.load(path)
            for v in m.variables:
                weights[v.name] = np.asarray(v.numpy())
            kind = 'saved_model'
            return weights, kind
        except Exception as e:
            print('  SavedModel 载入失败，回退冻结图:', e)
    # 冻结图 .pb
    import tensorflow.compat.v1 as tf1
    g = tf1.Graph()
    with g.as_default():
        gd = tf1.GraphDef()
        with open(path, 'rb') as f:
            gd.ParseFromString(f.read())
        tf1.import_graph_def(gd, name='')
        with tf1.Session(graph=g) as sess:
            for op in g.get_operations():
                t = op.outputs[0] if op.outputs else None
                if t is None:
                    continue
                try:
                    sh = t.shape.as_list()
                except ValueError:
                    continue  # 形状未知（动态维度），跳过
                if len(sh) == 4 and sh[0] in range(1, 8) and sh[1] in range(1, 8) \
                        and all(s is not None for s in sh):
                    weights[op.name] = sess.run(t)
                elif len(sh) == 1 and sh[0] is not None and sh[0] < 1_000_000:
                    weights[op.name] = sess.run(t)
    return weights, kind


def permute_tf_to_project(w: np.ndarray) -> list:
    """TF [kh,kw,inC,outC] → 本项目 ((o*inC+i)*kh+ky)*kh+kx 扁平。"""
    kh, kw, inC, outC = w.shape
    out = np.zeros((outC, inC, kh, kw), dtype=np.float32)
    for o in range(outC):
        for i in range(inC):
            for ky in range(kh):
                for kx in range(kw):
                    out[o, i, ky, kx] = w[ky, kx, i, o]
    return out.reshape(-1).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('scale', nargs='?', type=int, default=None)
    ap.add_argument('--out')
    ap.add_argument('--c1')
    ap.add_argument('--c2')
    ap.add_argument('--c3')
    ap.add_argument('--out_act', default='tanh',
                    choices=['sigmoid', 'relu', 'none', 'tanh'])
    args = ap.parse_args()

    weights, kind = load_kernels(args.path)
    print(f'载入方式: {kind}; 候选张量 {len(weights)} 个')

    kernels = {n: a for n, a in weights.items() if a.ndim == 4}
    print('4D 卷积核候选:')
    for n, a in kernels.items():
        print(f'  {n}: {list(a.shape)}   # [kh,kw,in,out]')

    by_out = sorted(kernels.items(), key=lambda kv: kv[1].shape[3], reverse=True)
    c1n = args.c1 or (by_out[0][0] if by_out else None)
    c2n = args.c2 or (by_out[1][0] if len(by_out) > 1 else None)
    c3n = args.c3 or (by_out[2][0] if len(by_out) > 2 else None)
    print(f'自动映射: conv1={c1n} conv2={c2n} conv3={c3n}')

    w1, w2, w3 = kernels[c1n], kernels[c2n], kernels[c3n]
    kh1, kw1, in1, out1 = w1.shape
    kh2, kw2, in2, out2 = w2.shape
    kh3, kw3, in3, out3 = w3.shape

    if args.scale is None:
        args.scale = int(round(out3 ** 0.5))
        print(f'由 conv3 输出通道 {out3} 推断 scale={args.scale}')
    assert out3 == args.scale * args.scale, \
        f'conv3 输出通道 {out3} != scale² ({args.scale**2})；请确认 scale 或 --c3 映射'

    biases = {n: a for n, a in weights.items() if a.ndim == 1}

    def find_bias(name, length):
        """按核名精确匹配对应偏置，避免误抓与偏置同形的无关 1D 张量。

        关键坑：ESPCN 冻结图里除了 b1/b2/b3 偏置，还有一个 1D 张量
        `NCHW_output/perm`（NHWC→NCHW 转置的 perm=[0,3,1,2]，长度恰好=4），
        与 x2 的 conv3 偏置 b3（长度 4）同形。若用「第一个同长度 1D 张量」兜底，
        x2 会错把转置 perm 当 b3（[0,3,1,2]），导致输出 4 通道被整体 +[0,3,1,2] 偏移。
        故：优先按核名索引匹配（f1→b1 / convN→bN），兜底也显式排除
        perm/transpose/shape/output/BN 等辅助张量。
        """
        # 1) 直接名称变体
        for cand in (name, name + ':0', name + '/bias', name + '/biases',
                     name + '/BiasAdd', name.replace('kernel', 'bias'),
                     name.replace('weights', 'biases'), name.replace('conv', 'bias')):
            if cand in biases and biases[cand].shape[0] == length:
                return biases[cand]
        # 2) 索引匹配：核名里的末位序号 N → bN（覆盖 f1→b1、conv3/kernel→b3 等）
        m = re.search(r'(\d+)', name)
        if m:
            idx = m.group(1)
            for cand in (f'b{idx}', f'bias_{idx}', f'biases_{idx}',
                         f'conv{idx}/bias', f'conv{idx}/biases'):
                if cand in biases and biases[cand].shape[0] == length:
                    return biases[cand]
        # 3) 兜底：仅当 1D 张量名副其实像偏置（含 bias 或以 b 开头）且不带
        #    perm/transpose/shape/output/BN 等关键字时，才按长度匹配
        for bn, a in biases.items():
            low = bn.lower()
            if a.shape[0] == length and ('bias' in low or bn.startswith('b')) \
               and not any(k in low for k in ('perm', 'transpose', 'shape',
                                              'output', 'mean', 'var',
                                              'gamma', 'beta', 'running')):
                return a
        print(f'  ⚠️ 未找到 {name} 的偏置，回退为 0')
        return np.zeros(length)

    b1 = find_bias(c1n, out1)
    b2 = find_bias(c2n, out2)
    b3 = find_bias(c3n, out3)

    obj = {
        'scale': args.scale,
        'k1': int(kh1), 'c1': int(out1),
        'k2': int(kh2), 'c2': int(out2),
        'k3': int(kh3),
        'w1': permute_tf_to_project(w1), 'b1': b1.astype(float).tolist(),
        'w2': permute_tf_to_project(w2), 'b2': b2.astype(float).tolist(),
        'w3': permute_tf_to_project(w3), 'b3': b3.astype(float).tolist(),
        # 实测 TF 冻结图约定（枚举归一化组合验证，combo C 胜出）：
        #   in = Y/255 ([0,1])；conv1/conv2=relu；输出 Tanh∈[-1,1]；还原 = tanh*255。
        'act': 'relu',
        'outAct': args.out_act,
        'inScale': 1.0 / 255.0, 'inShift': 0.0,
        'outScale': 255.0, 'outShift': 0.0,
        '_src': os.path.basename(args.path),
        '_kind': kind,
    }
    out = args.out or f'espcn_weights_x{args.scale}.json'
    with open(out, 'w') as f:
        json.dump(obj, f)
    print(f'已写出 {out}  '
          f'(w1={len(obj["w1"])} w2={len(obj["w2"])} w3={len(obj["w3"])} 参数; '
          f'conv1:{out1} conv2:{out2} conv3:{out3})')


if __name__ == '__main__':
    main()
