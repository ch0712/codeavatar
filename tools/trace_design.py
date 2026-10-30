"""把扁平设定稿描成 SVG 路径：每个连通轮廓一条，按「区域」判角色，输出 traced.json。

B 路线的核心：**几何直接继承美术的线条**。手敲坐标的代价已经验证过
（眼距超 52%、五官挤在上半张），所以这里只做"抄"，不做"猜"。

判角色不用亮度/面积启发式（试过，会把鬓角头发当虹膜），改用**区域包含判定**：
设定稿里眉/眼/嘴的位置已由精确色块量得（见 colors_probe.py），直接写成框。

用法：python3 tools/trace_design.py <设计稿.png> <输出目录>
"""
import itertools
import json
import math
import os
import re
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

K = 14
EPS = 1.0
MIN_AREA = 700        # 噪点靠「人物掩膜过滤」解决，不靠放大面积阈值
MIN_AREA_FEATURE = 120  # 五官区域内放行小块（眼白、虹膜、高光）


def lum_of(h):
    return 0.299 * int(h[1:3], 16) + 0.587 * int(h[3:5], 16) + 0.114 * int(h[5:7], 16)
BLUR = 0   # 不模糊：中值滤波会把唇面并进肤色（实测唇色整块丢失）

# 区域（px，按 1360x2048 的设定稿；换稿需重量）
# 每个角色的五官区域（由 tools/zones_probe.py 量得）。新增角色只加一条：
#   python3 tools/zones_probe.py <设定稿> → 抄 Z 进来 → python3 tools/trace_design.py <key> <图> <输出>
PRESETS = {
    # NO.1 女士 · 细圆金丝眼镜 · 藏青高领
    #   脸框 (342,261)-(1017,1120) · 眉 y591..632 · 眼线 y≈690 · 唇 y933..994
    "no1": {
        "mouth": (560, 900, 790, 1030),
        "browL": (430, 570, 630, 650),
        "browR": (715, 570, 915, 650),
        "eyeL":  (455, 650, 680, 820),
        "eyeR":  (700, 650, 905, 820),
    },
    # NO.4 男士 · 玳瑁粗框眼镜 · 橄榄立领
    #   ⚠ 2026-10-28 重量过（旧值全部下移 ~45px，是错的一套）：旧 eyeL/eyeR 的 y733..862 框住的
    #     其实是**镜片下沿**，真眼在 y689..731；旧 brow 框探到 y692，把镜框上框（y643..735）吞进眉毛，
    #     成片里一抬眉整条镜框上沿跟着飘。测量方式：tools/zones_probe.py + 放大 5~9 倍逐层核对。
    #   眉 y585..640 · 镜框上框 y643..682 · 真眼 y689..732 · 镜片下沿 y775..840 · 唇线 y1008..1019
    "no4": {
        "mouth": (555, 975, 805, 1065),
        "browL": (430, 575, 630, 646),
        "browR": (725, 575, 910, 646),
        "eyeL":  (455, 682, 625, 742),
        "eyeR":  (742, 682, 905, 742),
    },
}
Z = PRESETS["no4"]


def kill_top_antenna(mask, min_h=45, max_w=26, aspect=3.0, top_tol=10):
    """去掉「天线」：发缝/分缝会被量化成一根细竖条，挂在额头轮廓顶上，
    渲出来就是头顶伸出去的一根棍子。

    做法（只清那根棍子，不动主体）：用 1x21 横核做开运算，横向细于 21px 的部分
    会被削掉 —— 「被削掉的那部分」就是候选；再按三条形状判据认领天线：
      高 >= min_h（细且高）、宽 <= max_w、高/宽 >= aspect，且它挂在剪影顶部 top_tol 以内。
    这样清掉的是整根棍子，额头本身的圆顶保持原样（按行宽阈值切会把圆顶削成平顶，试过）。
    """
    if not mask.any():
        return mask, 0
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, 21), np.uint8))
    thin = mask.astype(bool) & ~opened.astype(bool)
    lab, n = ndi.label(thin)
    if n == 0:
        return mask, 0
    top = int(np.where(mask.any(axis=1))[0][0])
    out = mask.copy()
    removed = 0
    for i in range(1, n + 1):
        comp = lab == i
        rows = np.where(comp.any(axis=1))[0]
        cols = np.where(comp.any(axis=0))[0]
        if len(rows) == 0:
            continue
        h = int(rows[-1]) - int(rows[0]) + 1
        w = int(cols[-1]) - int(cols[0]) + 1
        if h >= min_h and w <= max_w and h / max(1, w) >= aspect and int(rows[0]) <= top + top_tol:
            out &= ~comp
            removed += h
    return out, removed


def fill_bg_leaks(arr, bg_color, protect=None, max_w=60, max_h=160):
    """把「漏进剪影里的背景色」补成周围的颜色。

    设定稿里写在色块之间的 1px 描边（比如发缝两侧的深线）量化后会被并到背景色上，
    于是背景像是从缝里漏了出来 —— 头顶那根「天线」就是这么来的（不是有根棍子，是漏光）。
    真背景是连到画布四边的那块，其余被包在里面的小块都算漏光，按周围众数色补回。
    """
    m = np.all(arr == np.array(bg_color, np.uint8), axis=2)
    lab, n = ndi.label(m)
    if n <= 1:
        return arr, 0
    border = set(np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])))
    out = arr.copy()
    fixed = 0
    for i in range(1, n + 1):
        if i in border:
            continue
        comp = lab == i
        ys, xs = np.where(comp)
        # 五官区里的浅色块是眼白/牙齿，颜色恰好和米色背景同色 —— 那不是漏光，别补
        if protect is not None and protect[ys, xs].mean() > 0.25:
            continue
        h = int(ys.max() - ys.min() + 1)
        w = int(xs.max() - xs.min() + 1)
        if h > max_h or w > max_w:
            continue
        ring = ndi.binary_dilation(comp, iterations=2) & ~comp
        vals = out[ring]
        if vals.size == 0:
            continue
        uniq, cnt = np.unique(vals.reshape(-1, 3), axis=0, return_counts=True)
        out[comp] = uniq[int(np.argmax(cnt))]
        fixed += int(comp.sum())
    return out, fixed


def merge_close_colors(arr, tol=14):
    """把调色板里"彼此只差一点点"的颜色并成一个。

    为什么需要（2026-10-30 实测 S5）：生图模型输出的"扁平"图其实带低幅度色噪，
    K=14 的 MEDIANCUT 会把调色板全花在噪声变体上 —— S5 实测 14 色里
    海军蓝占 5 个（#1E2949/#1F2A4A/#1F2949/#1E2A4A/#1D2949）、米色占 6 个，
    真正的 7 个平面反而没全分出来，分区框与量化层框对不上，角色判不出来（眼/眉 = 0 条）。

    合并只动**调色板**、不动几何（所以不会像中值滤波那样把唇面糊进肤色）：
    两色任一通道差 ≤ tol 就并到像素更多的那一色上。
    """
    cols, counts = np.unique(arr.reshape(-1, 3), axis=0, return_counts=True)
    order = np.argsort(-counts)
    reps = []          # [(代表色, 成员下标列表)]
    for i in order:
        c = cols[i].astype(np.int16)
        for rep in reps:
            if int(np.abs(c - rep[0]).max()) <= tol:
                rep[1].append(i)
                break
        else:
            reps.append((c, [i]))
    if len(reps) == len(cols):
        return arr, 0
    out = arr.copy()
    merged = 0
    for rep_c, members in reps:
        if len(members) == 1:
            continue
        for i in members[1:]:
            out[np.all(arr == cols[i], axis=2)] = cols[members[0]]
            merged += 1
    print(f"  调色板近色合并 {merged} 个 → 有效色 {len(reps)}")
    return out, merged


def flatten_palette(arr, K=14, tol=8, noise_tol=5):
    """按需去色噪：只有调色板里真的出现「几乎同色的重复」时才走两步量化。

    背景（2026-10-30 实测两轮）：
      · S5 生图稿带低幅度色噪（同色变体彼此差 ≤2），直接 K=14 时 11 个槽位被噪声吃掉，
        真实平面只剩 5 个，眉/眼/虹膜并成一坨 → 角色判不出来。
      · 但 NO.4 的 14 色是**真实平面**，无条件合并会把眼层并进邻近色（实测眼框 116→79 宽）。
    所以判据是「有没有噪声重复对」，不是「误差大不大」：
      两色各通道最大差 ≤ noise_tol(5) 且都是大面积色 → 视为噪声变体 → 才做两步量化。
    """
    def q(a, n):
        return np.asarray(Image.fromarray(a).quantize(colors=n, method=Image.MEDIANCUT).convert("RGB"))

    a1 = q(arr, K)
    cols, counts = np.unique(a1.reshape(-1, 3), axis=0, return_counts=True)
    big = [c for c, n in zip(cols, counts) if n > 0.005 * counts.sum()]
    dup = 0
    for c1, c2 in itertools.combinations(big, 2):
        if int(np.abs(c1.astype(np.int16) - c2.astype(np.int16)).max()) <= noise_tol:
            dup += 1
    if dup == 0:
        print(f"  实际平面数 {len(cols)}（K={K}，无噪声重复对，跳过净化）")
        return a1

    print(f"  检测到 {dup} 对噪声重复色 → 走两步量化")
    a2, _ = merge_close_colors(q(arr, min(256, K * 2)), tol=tol)
    n = len(np.unique(a2.reshape(-1, 3), axis=0))
    if n > K:
        a2 = q(a2, K)
        a2, _ = merge_close_colors(a2, tol=tol)
        n = len(np.unique(a2.reshape(-1, 3), axis=0))
    print(f"  实际平面数 {n}（K={K}）")
    return a2


def absorb_small_dark(arr, colors, min_area=MIN_AREA, max_lum=70):
    """小面积深色细节（发缝线、唇线、鼻孔线）吸收进周围母色。

    这些细节在设定稿里只有 1~2px 宽，量化后是独立的小色块：面积不够独立成层会被丢掉，
    丢掉后原地就留一条透底的缝 —— 头顶那根「天线」就是发缝线被丢掉后漏出的背景。
    与其在渲染色上打补丁，不如在源头上让它们并回母色（细节本来也不该单独成层）。
    """
    out = arr.copy()
    total = 0
    for c in colors:
        m = np.all(out == np.array(c, np.uint8), axis=2)
        n = int(m.sum())
        if n == 0 or n >= min_area:
            continue
        if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > max_lum:
            continue
        ring = ndi.binary_dilation(m, iterations=3) & ~m
        vals = out[ring]
        if vals.size == 0:
            continue
        uniq, cnt = np.unique(vals.reshape(-1, 3), axis=0, return_counts=True)
        parent = uniq[int(np.argmax(cnt))]
        out[m] = parent
        total += n
    if total:
        print(f"  深色细节吸收 {total}px → 母色")
    return out


def fill_thin_slots(mask, w=9):
    """补「被 1~3px 细缝劈开」的槽。

    设定稿的发缝是一条 1px 深线，量化后成了同一色块中间的一道透底窄槽；
    渲出来的效果就是头顶中央那根「天线」（其实是背景从槽里漏出来）。
    kill_top_antenna 只管「伸出剪影的竖条」，管不了剪影内部的缝，所以单加这一道。

    只补「左右两侧在 w/2 内都有本色」的像素 —— 那是缝，不是真实边界。
    """
    if not mask.any():
        return mask, 0
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((1, w), np.uint8))
    add = (closed > 0) & (mask == 0)
    if not add.any():
        return mask, 0
    ys, xs = np.where(add)
    r = max(1, w // 2)
    keep = np.zeros(len(ys), dtype=bool)
    for i in range(len(ys)):
        y, x = int(ys[i]), int(xs[i])
        if mask[y, max(0, x - r):x].any() and mask[y, x + 1:x + 1 + r].any():
            keep[i] = True
    out = mask.copy()
    out[ys[keep], xs[keep]] = 1
    return out, int(keep.sum())


def in_zone(box, z):
    return box[0] >= z[0] and box[2] <= z[2] and box[1] >= z[1] and box[3] <= z[3]


def judge_role(box):
    if in_zone(box, Z["mouth"]):
        return "mouth", None
    for k, side in (("browL", "L"), ("browR", "R")):
        if in_zone(box, Z[k]):
            return "brow", side
    for i, k in enumerate(("eyeL", "eyeR")):
        if in_zone(box, Z[k]):
            return "eye", i
    return None, None


def main():
    global Z
    key = sys.argv[1]
    src = sys.argv[2]
    outfile = sys.argv[3]
    if key == 'auto':
        # 自动分区（2026-10-30 S2）：不依赖手量 PRESETS，换角色时 key 直接传 auto
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from zone_auto import detect_zones
        Z, _zmeta = detect_zones(src)
        print('自动分区 Z =', Z)
    elif key not in PRESETS:
        raise SystemExit(f"未知角色预设 {key}，可选 {list(PRESETS) + ['auto']}")
    else:
        Z = PRESETS[key]
    os.makedirs(os.path.dirname(outfile), exist_ok=True)
    im = Image.open(src).convert("RGB")
    W, H = im.size
    raw = np.asarray(im)
    den = cv2.medianBlur(raw, BLUR) if BLUR else raw
    # 色噪净化是**显式开关**：默认关闭，保证已验收的 NO.1/NO.4 输出逐字段不变。
    # 新生成的稿子若带低幅度色噪（S5 实测 14 槽位里 11 个被噪声吃掉），
    # 用 FOLK_NOISE_FLATTEN=1 打开；闸门会在检出噪声重复对时提示。
    if os.environ.get("FOLK_NOISE_FLATTEN") == "1":
        a = flatten_palette(den, K=K, tol=int(os.environ.get("MERGE_TOL", "8")))
    else:
        a = np.asarray(Image.fromarray(den).quantize(colors=K, method=Image.MEDIANCUT).convert("RGB"))

    # 人物掩膜：量化后背景会产生成百上千个小色斑，只按"面积"过滤会漏；
    # 直接要求轮廓中心落在人物剪影内，背景噪点一次性全清。
    corners = np.concatenate([raw[:10, :10].reshape(-1, 3), raw[:10, -10:].reshape(-1, 3)])
    bgc = np.median(corners, axis=0)
    subj = (np.abs(raw.astype(np.int16) - bgc).sum(axis=2) > 45)
    subj = ndi.binary_fill_holes(ndi.binary_closing(subj, iterations=3))

    counts = {}
    for c in map(tuple, a.reshape(-1, 3)[::5]):
        counts[c] = counts.get(c, 0) + 1
    raw_colors = [c for c, _ in sorted(counts.items(), key=lambda kv: -kv[1])]

    # 合并相近色（距离 < 26）：量化会把同一块颜色劈成两三个几乎一样的值，
    # 不合并的话每个掩膜都是麻点，后面的形态学开运算也救不回来。
    merged = []
    for c in raw_colors:
        for m in merged:
            if np.linalg.norm(np.array(c, dtype=float) - np.array(m, dtype=float)) < 26:
                break
        else:
            merged.append(c)
    remap = np.zeros((256, 256, 256), dtype=np.uint8)
    lut = {}
    for c in raw_colors:
        best = min(merged, key=lambda m: np.linalg.norm(np.array(c, dtype=float) - np.array(m, dtype=float)))
        lut[c] = best
    arr = np.zeros_like(a)
    for c in raw_colors:
        arr[np.all(a == np.array(c, dtype=np.uint8), axis=2)] = np.array(lut[c], dtype=np.uint8)
    a = arr
    colors = merged
    bg_q = min(colors, key=lambda c: np.linalg.norm(np.array(c, dtype=float) - bgc))
    protect = np.zeros((H, W), dtype=bool)
    for z in Z.values():
        protect[z[1]:z[3], z[0]:z[2]] = True
    a, leaks = fill_bg_leaks(a, bg_q, protect=protect)
    if leaks:
        print(f"  补漏光 {leaks}px（被包在剪影里的背景色）")
    a = absorb_small_dark(a, colors)

    layers = []
    for c in colors:
        mask = np.all(a == np.array(c, dtype=np.uint8), axis=2).astype(np.uint8)
        if mask.sum() < MIN_AREA_FEATURE:
            continue
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        # 补缝只对「大色块」（头发/皮肤/衣身）做：五官的小色块本身就是要保留的缝隙，
        # 拿 9px 核去补会把眼白、唇缝粘成一块黑。
        big = mask.sum() > 0.01 * W * H
        if big:
            mask, slots = fill_thin_slots(mask)
            if slots:
                print(f"  补缝: {'#%02X%02X%02X' % tuple(int(v) for v in c)} 填了 {slots}px 窄槽")
        # 发缝是一条向下张开的 V 形缝（底部十几 px 宽），9px 的核补不上；
        # 只有头发够格放宽核（深色 + 大片 + 贴画幅上缘），扩到 37px 也只合上这条缝。
        if lum_of('#%02X%02X%02X' % tuple(int(v) for v in c)) < 90 and mask.sum() > 0.05 * W * H \
                and int(np.where(mask.any(axis=1))[0][0]) < H * 0.3:
            mask, slots2 = fill_thin_slots(mask, w=37)
            if slots2:
                print(f"  补发缝: 再填 {slots2}px（宽缝/分缝）")
        mask, ant = kill_top_antenna(mask)
        if ant:
            print(f"  去天线: {'#%02X%02X%02X' % tuple(int(v) for v in c)} 切掉顶部 {ant}px 竖条")
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            area = cv2.contourArea(cnt)
            ap = cv2.approxPolyDP(cnt, EPS, True).reshape(-1, 2)
            if len(ap) < 3:
                continue
            box = [int(ap[:, 0].min()), int(ap[:, 1].min()), int(ap[:, 0].max()), int(ap[:, 1].max())]
            feat = any(in_zone(box, z) for z in Z.values())
            if area < (MIN_AREA_FEATURE if feat else MIN_AREA):
                continue
            if not subj[int((box[1] + box[3]) / 2), int((box[0] + box[2]) / 2)]:
                continue
            # 只有「就是背景色」才跳过。原来是三通道差之和 < 80，太松：
            # S5 实测肤色 #F4D1B4 与米色背景 #F0E9DA 的差之和只有 66 < 80，
            # 整个脸被当成背景跳过 → 图层里没有皮肤层，角色整条判不出来。
            if np.abs(np.array(c, dtype=np.int16) - bgc).max() <= 10:
                continue
            rgb = tuple(int(v) for v in c)
            role, side = judge_role(box)
            layers.append({
                "id": f"c{len(layers)}_{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}",
                "hex": "#%02X%02X%02X" % rgb,
                "d": "M " + " L ".join(f"{int(x)},{int(y)}" for x, y in ap) + " Z",
                "box": box,
                "area": int(area),
                "role": role,
                "side": side,
            })

    layers.sort(key=lambda l: -l["area"])
    bg = layers[0]["hex"]

    # 抗锯齿光晕/门襟亮缝这类"近白层"：直接删会在原地留下一条缝（缝里透出背景 → 白线），
    # 正确做法是继承"包住它的那个父层"的颜色，让缝被同色填实。眼白除外。
    for l in layers:
        if l["role"] == "eye" or lum_of(l["hex"]) < 225:
            continue
        cx = (l["box"][0] + l["box"][2]) / 2
        cy = (l["box"][1] + l["box"][3]) / 2
        parents = [p2 for p2 in layers
                   if p2 is not l and p2["area"] > l["area"] and lum_of(p2["hex"]) < 225
                   and p2["box"][0] <= cx <= p2["box"][2] and p2["box"][1] <= cy <= p2["box"][3]]
        if parents:
            l["hex"] = max(parents, key=lambda p2: p2["area"])["hex"]

    eyes = []
    for i in range(2):
        # 只认深色（眼线/虹膜）来定眼框：鼻侧/眼下的肤色阴影（#BD9A7E）也在眼区里，
        # 混进来会把眼框撑高一倍，眼睑缩放就会绕错中心（第一版就这么把眼睛拉变形）。
        boxes = [l["box"] for l in layers
                 if l["role"] == "eye" and l.get("side") == i and lum_of(l["hex"]) < 120]
        if boxes:
            x0 = min(b[0] for b in boxes); x1 = max(b[2] for b in boxes)
            y0 = min(b[1] for b in boxes); y1 = max(b[3] for b in boxes)
            eyes.append({"cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "w": x1 - x0, "h": y1 - y0})

    # 嘴区里可能同时有唇线（暗色）和唇面（红棕），要取"最红的那块"当唇面
    def redness(l):
        r, g, b = int(l["hex"][1:3], 16), int(l["hex"][3:5], 16), int(l["hex"][5:7], 16)
        return r - (g + b) / 2

    mouth_layers = [l for l in layers if l["role"] == "mouth"]
    # 眉区里常混进"衬衫灰绿/肤影"等杂层压在眉上（NO.4 就直接把眉毛画成了橄榄绿）。
    # 规则：完全落在眉区内的非皮肤层，一律并入眉层同一深棕。
    BROW = "#2E2620"
    skin_hex = None
    for l in layers:
        if l["role"] == "brow":
            l["hex"] = BROW
            skin_hex = l["hex"]
    for l in layers:
        if l.get("role"):
            continue
        b = l["box"]
        cx_, cy_ = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        for k in ("browL", "browR"):
            z = Z[k]
            # 判据必须是「整个框都在眉区里」：只判中心会把镜框上框（上沿在眉区内、
            # 下沿探到镜片里）也吞成眉毛 —— 2026-10-28 抬眉拖镜框就是这么来的。
            if z[0] <= b[0] and b[2] <= z[2] and z[1] <= b[1] and b[3] <= z[3]:
                if lum_of(l["hex"]) < 200:      # 皮肤/高光不算
                    l["hex"] = BROW
                    l["role"] = "brow_fill"
                break

    lip = max(mouth_layers, key=redness) if mouth_layers else None
    for l in mouth_layers:
        if l is not lip:
            l["role"] = "mouthline"
    # 皮肤层：取「两个眼心都落在框里」的那块（皮肤一定包着眼睛），再按面积最大。
    # 原来只按 r-b 最大取，候选 4 实测会取到一块一直连到画布底 2047 的肤色块。
    _eyepts = [(e['cx'], e['cy']) for e in eyes]
    def _contains_eyes(l):
        b = l["box"]
        return all(b[0] <= x <= b[2] and b[1] <= y <= b[3] for x, y in _eyepts)
    _skin_cands = [l for l in layers if l["role"] is None and _contains_eyes(l)]
    if not _skin_cands:
        _skin_cands = [l for l in layers if l["role"] is None]
    skin = max(_skin_cands,
               key=lambda l: int(l["hex"][1:3], 16) - int(l["hex"][5:7], 16))

    # ── 唇缺件补件 ──
    # 量化会把"淡唇压在暖肤色上"的唇整块并进肤色（与"鼻子整层丢失"同源）。
    # 判据：没有唇层，或唇宽 < 嘴区的 45% → 用"比周围皮肤更红"的区域重建一条 mouth 层。
    # 颜色仍从设定稿采样；几何用轮廓多边形（与其它层同一套表示）。
    _mw = Z["mouth"][2] - Z["mouth"][0]
    if lip is None or (lip["box"][2] - lip["box"][0]) < 0.45 * _mw:
        _nums = re.findall(r'-?\d+\.?\d*', skin["d"])
        _sp = np.array([(float(_nums[i]), float(_nums[i + 1]))
                        for i in range(0, len(_nums) - 1, 2)])
        _sm = np.zeros((H, W), np.uint8)
        cv2.fillPoly(_sm, [np.round(_sp).astype(np.int32)], 1)
        _zone = np.zeros((H, W), np.uint8)
        _zone[max(0, Z["mouth"][1]):Z["mouth"][3], max(0, Z["mouth"][0]):Z["mouth"][2]] = 1
        _rg = raw[:, :, 0].astype(np.int16) - raw[:, :, 1].astype(np.int16)
        _base = float(np.median(_rg[(_sm > 0)]))
        _lm = ((_rg - _base) > 18) & (_sm > 0) & (_zone > 0)
        _cnts, _ = cv2.findContours(_lm.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        _best = None
        for _c in _cnts:
            _a = cv2.contourArea(_c)
            if _a < 300:
                continue
            _x, _y, _w2, _h2 = cv2.boundingRect(_c)
            if _w2 < 0.3 * _mw or _w2 <= _h2:
                continue
            if _best is None or _a > _best[0]:
                _best = (_a, _c)
        if _best is not None:
            _ap = cv2.approxPolyDP(_best[1], EPS, True).reshape(-1, 2)
            _x0, _y0 = int(_ap[:, 0].min()), int(_ap[:, 1].min())
            _x1, _y1 = int(_ap[:, 0].max()), int(_ap[:, 1].max())
            _patch = raw[_y0:_y1 + 1, _x0:_x1 + 1].reshape(-1, 3)
            _hex = "#%02X%02X%02X" % tuple(int(v) for v in np.median(_patch, axis=0))
            _new = {
                "id": "lipsupp_%02X%02X%02X" % tuple(int(v) for v in np.median(_patch, axis=0)),
                "hex": _hex,
                "d": "M " + " L ".join(f"{int(x)},{int(y)}" for x, y in _ap) + " Z",
                "box": [_x0, _y0, _x1, _y1],
                "area": int(_best[0]),
                "role": "mouth",
                "side": None,
            }
            # 旧的那些"嘴区小块"要分两种：真的唇线（贴着新唇）降级成 mouthline；
            # 离散很远的（实测是鼻孔/人中阴影，候选 4 那块在唇上方 78px）
            # 必须退回静态层 —— 否则会被当成唇线画在嘴上面，成片里多一条深线。
            _lh = max(1.0, _y1 - _y0)
            for l in mouth_layers:
                _d = abs((l["box"][1] + l["box"][3]) / 2 - (_y0 + _y1) / 2)
                l["role"] = "mouthline" if _d <= 1.2 * _lh else None
            _new["role"] = "mouth"
            layers.append(_new)
            mouth_layers.append(_new)
            lip = _new
            print(f"  唇补件：量化把唇并进肤色，按「比皮肤更红」重建 {_hex} area{int(_best[0])} box{[_x0, _y0, _x1, _y1]}")

    # ── skinBox 底边（下巴线）兜底修正 ──
    # 皮肤层有时把脖子/前胸连成一块，bbox 底边落到画布下部（候选 4 实测 2047），
    # 而 skinBox[3] 是构图用的下巴线 —— 不修就会把"头高"算成整个人。
    # 只在**明显不对**时介入（底边距唇底 > 一半剩余画高），已验收的两张图一分不动。
    # 公式用比例（实测锚点）：下巴 ≈ 唇底 + 0.56×(唇心 − 眼心)
    #   NO.4 真实 1209，公式 1240/0.526 → 差 ≤12px；NO.1 真实 1157 → 差 ≤11px
    if lip is not None and eyes:
        _lip_bot = float(lip["box"][3])
        _lip_cy = (lip["box"][1] + lip["box"][3]) / 2
        _eye_cy = sum(e["cy"] for e in eyes) / len(eyes)
        if (skin["box"][3] - _lip_bot) > 0.5 * (H - _lip_bot):
            _chin = int(round(_lip_bot + 0.56 * (_lip_cy - _eye_cy)))
            if _chin < skin["box"][3]:
                print(f"  下巴线兜底 {skin['box'][3]} → {_chin}（皮肤层连到画布下部）")
                skin["box"] = [skin["box"][0], skin["box"][1], skin["box"][2], _chin]

    # 唇色直接从设定稿唇心采样（量化会把唇面并进"脸颊阴影"色，导致嘴唇发灰）
    lip_rgb = None
    if lip:
        lx = int((lip["box"][0] + lip["box"][2]) / 2)
        ly = int(lip["box"][1] + (lip["box"][3] - lip["box"][1]) * 0.55)
        patch_px = raw[max(0, ly - 3):ly + 4, max(0, lx - 12):lx + 13].reshape(-1, 3)
        lip_rgb = "#%02X%02X%02X" % tuple(int(v) for v in np.median(patch_px, axis=0))
        lip["hex"] = lip_rgb

    data = {
        "canvas": [W, H], "bg": "#%02X%02X%02X" % tuple(int(v) for v in bgc),
        "skin": skin["hex"], "skinBox": skin["box"],
        "lipBox": lip["box"] if lip else None, "lipColor": lip["hex"] if lip else None,
        "eyes": eyes,
        "brows": [{"side": l.get("side"), "box": l["box"], "hex": l["hex"]} for l in layers if l["role"] == "brow"],
        "layers": layers,
    }
    data["key"] = key
    json.dump(data, open(outfile, "w"), ensure_ascii=False)

    print(f"画布 {W}x{H}  轮廓 {len(layers)}  bg {bg}")
    for l in layers[:8]:
        print(f"  {l['hex']} area{l['area']:7d} box{l['box']} {l['role'] or ''}{l.get('side') if l['side'] is not None else ''}")
    print("皮肤", skin["hex"], skin["box"])
    print("嘴", data["lipBox"], data["lipColor"], "| 眼", [(round(e['cx']), round(e['cy']), e['w'], e['h']) for e in eyes])
    print("眉", [(b['side'], b['box']) for b in data["brows"]])
    rf = [l for l in layers if l["role"]]
    print(f"可动部件 {len(rf)} 条:", [(l['role'], l.get('side')) for l in rf][:12])


if __name__ == "__main__":
    main()
