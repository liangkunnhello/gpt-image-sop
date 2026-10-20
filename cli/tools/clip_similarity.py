#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""批次内图片两两相似度（CLIP ViT-B/32 图像向量余弦）。

用法：
  python tools/clip_similarity.py out/ --glob "jdb20-*.png"
  python tools/clip_similarity.py out/a.png out/b.png --json
  python tools/clip_similarity.py out/ --glob "sweet10-*.png" --lo 0.8 --hi 0.92

输出：每对相似度、每张图的平均相似度、越界对清单。
"""
import argparse
import glob as globmod
import json
import os
import sys

import numpy as np
from PIL import Image

MODEL_DIR = os.path.join(os.path.expanduser("~"), ".gpt-image-cli", "models", "clip-vit-base-patch32")
MODEL_FILE = os.path.join(MODEL_DIR, "vision_model_quantized.onnx")
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
SIZE = 224


def preprocess(img):
    img = img.convert("RGB")
    w, h = img.size
    s = SIZE / min(w, h)
    nw, nh = max(SIZE, int(round(w * s))), max(SIZE, int(round(h * s)))
    img = img.resize((nw, nh), Image.BICUBIC)
    left, top = (nw - SIZE) // 2, (nh - SIZE) // 2
    img = img.crop((left, top, left + SIZE, top + SIZE))
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    return arr.transpose(2, 0, 1)[None, ...].astype(np.float32)


def load_session():
    if not os.path.exists(MODEL_FILE):
        raise SystemExit(
            f"缺少 CLIP 模型：{MODEL_FILE}\n"
            "下载：curl -sL -o \"%s\" https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx" % MODEL_FILE
        )
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    return ort.InferenceSession(MODEL_FILE, so, providers=["CPUExecutionProvider"])


def embed(sess, files):
    inp = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    vecs = []
    for f in files:
        with Image.open(f) as im:
            x = preprocess(im)
        v = np.asarray(sess.run([out_name], {inp: x})[0]).reshape(-1).astype(np.float32)
        n = np.linalg.norm(v)
        vecs.append(v / n if n else v)
    return np.stack(vecs), out_name


def collect(paths, glob_pat):
    import fnmatch

    files = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                for nm in sorted(names):
                    if fnmatch.fnmatch(nm, glob_pat):
                        files.append(os.path.join(root, nm))
        elif os.path.isfile(p):
            files.append(p)
    exts = {".png", ".jpg", ".jpeg", ".webp"}
    return [f for f in files if os.path.splitext(f)[1].lower() in exts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--glob", default="*.png")
    ap.add_argument("--lo", type=float, default=0.0, help="下限；默认 0 表示不判下限，只要低于 --hi 就合格")
    ap.add_argument("--hi", type=float, default=0.92)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--top", type=int, default=8, help="报告里展示最像的若干对")
    args = ap.parse_args()

    files = collect(args.paths, args.glob)
    if len(files) < 2:
        raise SystemExit(f"需要至少两张图，实际找到 {len(files)} 张")

    sess = load_session()
    vecs, out_name = embed(sess, files)
    n = len(files)
    sim = vecs @ vecs.T

    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs.append((os.path.basename(files[i]), os.path.basename(files[j]), float(sim[i, j])))
    pairs.sort(key=lambda x: -x[2])

    # 判定只看上限：低于 hi 即合格，不看下限
    over_pairs = [p for p in pairs if p[2] > args.hi]
    if args.lo > 0:
        offs = [p[2] for p in pairs if p[2] > args.hi or p[2] < args.lo]
    else:
        offs = [p[2] for p in over_pairs]

    per = []
    for i, f in enumerate(files):
        row = np.delete(sim[i], i)
        j = int(np.argmax(row))
        nearest = j if j < i else j + 1
        per.append(
            {
                "file": os.path.basename(f),
                "mean": round(float(row.mean()), 4),
                "max": round(float(row.max()), 4),
                "min": round(float(row.min()), 4),
                "nearest": os.path.basename(files[nearest]),
            }
        )
    per.sort(key=lambda x: -x["mean"])

    # 贪心挑最少的重出对象：一对超线只重出其中"更大众脸"的那张
    mean_map = {p["file"]: p["mean"] for p in per}
    touched = set()
    regen = []
    for a, b, s in over_pairs:
        if a in touched or b in touched:
            continue
        drop = a if mean_map.get(a, 0) >= mean_map.get(b, 0) else b
        keep = b if drop == a else a
        regen.append({"regen": drop, "keep": keep, "sim": round(s, 4)})
        touched.add(drop)

    result = {
        "model": "clip-vit-b32-quantized",
        "limit": args.hi,
        "count": n,
        "pairs_total": len(pairs),
        "stats": {
            "min": round(min(p[2] for p in pairs), 4),
            "max": round(max(p[2] for p in pairs), 4),
            "mean": round(float(np.mean([p[2] for p in pairs])), 4),
            "p10": round(float(np.percentile([p[2] for p in pairs], 10)), 4),
            "p90": round(float(np.percentile([p[2] for p in pairs], 90)), 4),
        },
        "pass_pairs": len(pairs) - len(over_pairs),
        "over_pairs": len(over_pairs),
        "over_list": [{"a": a, "b": b, "sim": round(s, 4)} for a, b, s in over_pairs],
        "regen": regen,
        "most_similar": [{"a": a, "b": b, "sim": round(s, 4)} for a, b, s in pairs[: args.top]],
        "most_different": [
            {"a": a, "b": b, "sim": round(s, 4)} for a, b, s in sorted(pairs, key=lambda x: x[2])[:3]
        ],
        "per_image": per,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    st = result["stats"]
    print(f"对比 {n} 张图，{len(pairs)} 对（模型 {result['model']}，输出层 {out_name}）")
    print(f"相似度分布：最低 {st['min']}  10% 分位 {st['p10']}  中位附近 {st['mean']}  90% 分位 {st['p90']}  最高 {st['max']}")
    print(f"判定线 {args.hi}（只看上限）：{result['pass_pairs']} 对合格，{result['over_pairs']} 对超线")
    print("")
    if over_pairs:
        print("超线的对：")
        for p in result["most_similar"]:
            if p["sim"] > args.hi:
                print(f"  {p['sim']:.4f}  {p['a']}  ×  {p['b']}")
        print("")
        print(f"建议重出 {len(regen)} 张：")
        for r in regen:
            print(f"  重出 {r['regen']}（与 {r['keep']} 撞车 {r['sim']}）")
    else:
        print(f"全部 {n} 张低于 {args.hi}，无需重出。")
    print("")
    print("最不像的几对（仅作风格跨度参考，不判不合格）：")
    for p in result["most_different"]:
        print(f"  {p['sim']:.4f}  {p['a']}  ×  {p['b']}")


if __name__ == "__main__":
    sys.exit(main())
