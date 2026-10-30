"""自动定位五官区域（替代「人肉量 + 手抄进 trace_design.PRESETS」）。

为什么不用肤色框：实测两张已有设定稿都不成立 ——
  · NO.4 的额头被头发盖住，肤色框顶边落在眉毛**下面**（y685），拿它当参照系会切掉眉区；
  · NO.1 的额头肤色与脸颊肤色不是同一个色块，最大肤色连通块只到 y657（真实脸顶 y261）。
所以参照系改成**结构性地标**，两者都不依赖肤色：

  1. 唇线 = 下半张里最宽最扁的那条深色横线（宽高比 > 6）→ 嘴区按它的宽高外扩
  2. 眉   = 剪影内第一对「左右镜像、同高、宽扁」的深色块
  3. 眼   = 第二对同形状的块
  4. 眼镜框/头发 = 被「高 > 0.05H」排除掉的大连通块，从不参与配对

配对规则为什么可靠：眉/眼在两张设定稿上都是两个独立小连通块（宽 125~180、高 36~52），
而镜框是与头发连成一片的巨块（NO.4 实测 706x666 / 179k px），一条面积/高度上限就分开了。

用法：
  python3 tools/zone_auto.py <设定稿.png>              # 打印自动分区（JSON）
  python3 tools/zone_auto.py <设定稿.png> --compare no4 # 与 trace_design.PRESETS 手量值对比
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# 与手量值的对照（trace_design.PRESETS 里的同一套，2026-10-30 抄录）
PRESETS = {
    "no1": {"mouth": (560, 900, 790, 1030),
            "browL": (430, 570, 630, 650), "browR": (715, 570, 915, 650),
            "eyeL": (455, 650, 680, 820), "eyeR": (700, 650, 905, 820)},
    "no4": {"mouth": (555, 975, 805, 1065),
            "browL": (430, 575, 630, 646), "browR": (725, 575, 910, 646),
            "eyeL": (455, 682, 625, 742), "eyeR": (742, 682, 905, 742)},
}


class ZoneError(RuntimeError):
    """分区失败（稿子不可描摹）。消息就是给用户看的原因。"""


def blobs(mask, min_area):
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    out = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(xs) < min_area:
            continue
        out.append({
            "area": int(len(xs)),
            "cx": float(xs.mean()), "cy": float(ys.mean()),
            "box": (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())),
        })
    return out


def _expand(box, mx, mt, mb):
    """按「自身宽高的比例」外扩：mx 横向、mt 向上、mb 向下。"""
    x0, y0, x1, y1 = box
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    return (int(round(x0 - mx * w)), int(round(y0 - mt * h)),
            int(round(x1 + mx * w)), int(round(y1 + mb * h)))


def detect_zones(path, verbose=False):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    H, W = a.shape[:2]
    corners = np.concatenate([a[:10, :10].reshape(-1, 3), a[:10, -10:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    subj = np.abs(a - bg).sum(axis=2) > 45

    # ── 深色小块：排除「高 > 0.05H 或 面积 > 2% 画布」的巨块（头发/镜框/衣服） ──
    dark = (a.mean(axis=2) < 130) & subj
    cand = [d for d in blobs(dark, 250)
            if (d["box"][2] - d["box"][0]) > 35
            and (d["box"][3] - d["box"][1]) <= 0.05 * H
            and d["area"] <= 0.02 * W * H]
    cand.sort(key=lambda d: d["cy"])
    if verbose:
        print(f"  候选深色小块 {len(cand)} 个:")
        for d in cand:
            b = d["box"]
            print(f"    cy{d['cy']:6.0f} box{b} {b[2]-b[0]}x{b[3]-b[1]} ar{d['area']}")

    # ── 配对：同高（|Δcy| ≤ 0.02H）+ 同宽（±25%）+ 关于剪影中线镜像 ──
    ys_, xs_ = np.where(subj)
    midx = (xs_.min() + xs_.max()) / 2
    pairs, used = [], set()
    for i, d in enumerate(cand):
        if i in used:
            continue
        for j in range(i + 1, len(cand)):
            if j in used:
                continue
            e = cand[j]
            wi = d["box"][2] - d["box"][0]
            wj = e["box"][2] - e["box"][0]
            if abs(d["cy"] - e["cy"]) > 0.02 * H:
                continue
            if abs(wi - wj) > 0.25 * max(wi, wj):
                continue
            if not ((d["cx"] - midx) * (e["cx"] - midx) < 0):
                continue
            pairs.append(tuple(sorted((d, e), key=lambda t: t["cx"])))
            used.update((i, j))
            break
    if len(pairs) < 2:
        detail = "；".join(f"({d['box']} {d['box'][2]-d['box'][0]}x{d['box'][3]-d['box'][1]})" for d in cand)
        raise ZoneError(
            f"眉/眼只配出 {len(pairs)} 对（需要 2 对）。候选深色块 {len(cand)} 个：{detail}。"
            "最常见原因：一侧眉/眼被头发压住与发团连成一块，或镜框与眉眼同色粘连"
        )

    browL, browR = pairs[0]
    eyeL, eyeR = pairs[1]

    # ── 唇：优先「下半张最宽最扁的深色横线（宽高比 > 6）」 ──
    #    找不到就走颜色回退：唇比皮肤「更红」——按 r-g 相对全局中位数的超出量取连通块。
    #    （实测两张图各命中一种：NO.4/NO.1 有深色唇线；候选 4 是粉唇、没有唇线色）
    lines = [d for d in cand
             if (d["box"][2] - d["box"][0]) > 100
             and (d["box"][2] - d["box"][0]) / max(1, d["box"][3] - d["box"][1]) > 6
             and d["cy"] > 0.4 * H]
    if lines:
        mouth_box = max(lines, key=lambda d: d["box"][2] - d["box"][0])["box"]
        mouth_src = "dark_line"
    else:
        r_, g_ = a[:, :, 0], a[:, :, 1]
        rg = r_ - g_
        base = float(np.median(rg[subj & (rg > 0)]))
        eye_bot = max(eyeL["box"][3], eyeR["box"][3])
        band = np.zeros_like(subj)
        band[min(H - 1, eye_bot + int(0.05 * H)):min(H, eye_bot + int(0.30 * H)), :] = True
        lipm = ((rg - base) > 16) & subj & band
        lb = [d for d in blobs(lipm, 400)
              if (d["box"][2] - d["box"][0]) < 0.5 * W
              and (d["box"][2] - d["box"][0]) > (d["box"][3] - d["box"][1])]
        if not lb:
            raise ZoneError("唇不可定位：既没有深色唇线（宽高比>6），也没有比皮肤更红的块"
                            "（淡唇被肤色吞掉 → 需要人工补唇层）")
        mouth_box = max(lb, key=lambda d: d["area"])["box"]
        mouth_src = "redness"

    Z = {
        "mouth": _expand(mouth_box, 0.12, 2.5, 3.5),
        # 眉区纵向给得宽（眉常有浅色的 brow_fill 碎片），但底边不会碰到镜框：
        # 判 role 用的是「整个层框都在区内」，镜框那种大框天然进不来。
        "browL": _expand(browL["box"], 0.08, 0.45, 0.30),
        "browR": _expand(browR["box"], 0.08, 0.45, 0.30),
        # 眼区纵向必须紧（坑10：镜片下沿碎片 y775~840 一旦落进眼区就会被当成眼层压扁），
        # 横向可以宽——眼镜碎片是宽框，进不来。
        "eyeL": _expand(eyeL["box"], 0.25, 0.22, 0.25),
        "eyeR": _expand(eyeR["box"], 0.25, 0.22, 0.25),
    }
    meta = {
        "canvas": [W, H],
        "bg": "#%02X%02X%02X" % tuple(int(v) for v in bg),
        "brow_pair_cy": round(browL["cy"], 1),
        "eye_pair_cy": round(eyeL["cy"], 1),
        "mouth_box": mouth_box,
        "mouth_src": mouth_src,
    }
    return Z, meta


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    Z, meta = detect_zones(path, verbose="--verbose" in sys.argv)
    print(json.dumps({"zones": Z, **meta}, ensure_ascii=False, indent=1))

    if "--compare" in sys.argv:
        key = sys.argv[sys.argv.index("--compare") + 1]
        ref = PRESETS[key]
        print(f"\n=== 与手量 PRESETS[{key}] 对比（边差 px）===")
        worst = 0
        for k in ("mouth", "browL", "browR", "eyeL", "eyeR"):
            d = [Z[k][i] - ref[k][i] for i in range(4)]
            worst = max(worst, max(abs(v) for v in d))
            print(f"  {k:6s} auto{Z[k]}  ref{ref[k]}  Δ{d}")
        print(f"  最大边差 {worst}px")


if __name__ == "__main__":
    main()
