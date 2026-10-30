"""结构闸门 · 2026-10-30 新增

背景：gate_mouth 只量「幅度 / 六型可分性 / 闭唇」，它把 lip∪cavity∪teeth 并成一个
mask 再取最大连通块 —— **「唇和口腔是不是一块」这件事被并集抹掉了**，鼻子一条判据
都没有。于是老板一眼看出的「上下两个鼻孔、嘴巴和嘴唇脱离两层」在机检里全是绿的。

本闸门补的是「结构」，不是「运动」：
  G4 唇口一体：A 格口腔色块的边界上，肤色占比 ≤ 35%
                （口腔若是一个独立椭圆，两侧/下缘都压在皮肤上 → 占比高）
  G5 口腔咬合：口腔宽 / 唇宽 ≥ 0.85，且 口腔底与唇顶相接（|gap| ≤ 4px）
  G6 鼻子净空：鼻子中轴区内 Δlum>40 的暗块，最大连通块 ≤ 12px
  G7 数据净空：chars/<char>.json 里 脸区内 area<500 且 B≥R 的无角色层数 == 0

判据口径（2026-10-30 第二稿，第一稿在 no4 上把眉毛当成口腔、把镜框当成鼻孔）：
  · 唇 = lipColor 最大连通块，先限定在脸（skin 最大连通块）bbox 内
  · 口腔 = 唇 bbox 上方的暗部（lum < 0.62×唇亮度）最大连通块，限定 x 在唇左右 ±0.15 唇宽
    —— 不用 #42201C 绝对色：no4 的嘴部暗部和 #42201C 差得远，而眉毛恰好接近它
  · 鼻子中轴区 = |x-lipcx| ≤ 0.24 唇宽、y ∈ [唇顶-0.80 唇宽, 唇顶-0.34 唇宽]
    —— 窄到不含镜腿，低到不含镜片；戴眼镜的角色实测 0 块

用法：python3 tools/gate_structure.py <sheet.png> --char no5 [cols rows cw ch]
退出码 0 = 全 PASS。
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)

args = sys.argv[1:]
P = args[0] if args else "/H/.hermes/workspace/autocut/refs/dhk/out/_s2/no5-viseme-v6.png"
CHAR = None
for i, a in enumerate(args):
    if a == "--char":
        CHAR = args[i + 1]
COLS, ROWS, CW, CH = 3, 2, 640, 800
nums = [a for a in args[1:] if a.isdigit()]
if len(nums) >= 4:
    COLS, ROWS, CW, CH = (int(x) for x in nums[:4])
if CHAR is None:
    CHAR = P.split("/")[-1].split("-")[0]

jsonp = _os.path.join(_CHARS_DIR, '%s.json' % CHAR)
d = json.load(open(jsonp, encoding="utf-8"))
skin = np.array([int(d["skin"][i : i + 2], 16) for i in (1, 3, 5)])
lipc = d.get("lipColor") or "#CF8866"
lip_rgb = np.array([int(lipc[i : i + 2], 16) for i in (1, 3, 5)])
lumv = lambda x: 0.299 * x[..., 0] + 0.587 * x[..., 1] + 0.114 * x[..., 2]
SKIN_LUM = float(lumv(np.array(skin, dtype=float)))
LIP_LUM = float(lumv(np.array(lip_rgb, dtype=float)))

a = np.asarray(Image.open(P).convert("RGB")).astype(int)
NAMES = ["M", "A", "O", "E", "I", "U"]
fails = []


def cell(name):
    i = NAMES.index(name)
    r, c = divmod(i, COLS)
    return a[r * CH : (r + 1) * CH, c * CW : (c + 1) * CW]


def biggest(mask):
    lab, n = ndi.label(mask)
    if n == 0:
        return None, 0, None
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    k = int(np.argmax(sizes)) + 1
    m = lab == k
    ys, xs = np.nonzero(m)
    return m, int(sizes[k - 1]), (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


A = cell("A")
sk_m, sk_px, sk_bb = biggest(np.abs(A - skin).max(axis=2) <= 14)
if sk_bb is None:
    print("量不到脸（skin）→ 全部 FAIL")
    sys.exit(1)
fx0, fy0, fx1, fy1 = sk_bb

lip_mask = np.zeros(A.shape[:2], bool)
lip_mask[fy0 : fy1 + 1, fx0 : fx1 + 1] = True
lip_mask &= np.abs(A - lip_rgb).max(axis=2) <= 18
lip_m, lip_px, lip_bb = biggest(lip_mask)
print("图 %s（char=%s）" % (P, CHAR))
if lip_bb is None:
    print("  量不到唇 → FAIL")
    sys.exit(1)
lx0, ly0, lx1, ly1 = lip_bb
lipW = lx1 - lx0 + 1
lipH = ly1 - ly0 + 1
lipcx = (lx0 + lx1) // 2
print("  脸 %dx%d · 唇 %dpx bbox=(%d,%d,%d,%d)" % (fx1 - fx0 + 1, fy1 - fy0 + 1, lip_px, lx0, ly0, lx1, ly1))

# ── 口腔：唇上方、同一个 x 带内的暗部 ──
cx0 = max(0, lx0 - int(0.15 * lipW))
cx1 = min(CW, lx1 + int(0.15 * lipW))
cy0 = max(0, ly0 - int(1.6 * lipH))
cy1 = min(CH, ly1)
roi = np.zeros(A.shape[:2], bool)
roi[cy0:cy1, cx0:cx1] = True
dark = (lumv(A.astype(float)) < LIP_LUM * 0.62) & roi
cav_m, cav_px, cav_bb = biggest(dark)

# ── G4 唇口一体 ──
if cav_m is None:
    print("  G4 唇口一体：A 格没有口腔暗部 → FAIL（张着嘴却没有口腔）")
    fails.append("G4 无口腔")
    edge_ratio = 1.0
else:
    er = cav_m & ~ndi.binary_erosion(cav_m)
    sk_in = np.abs(A - skin).max(axis=2) <= 16
    edge_ratio = float((er & sk_in).sum()) / max(1, int(er.sum()))
    ok4 = edge_ratio <= 0.35
    print(
        "  G4 唇口一体：口腔 %dpx，边界落在皮肤上 %.1f%%（门槛 ≤35%%）→ %s"
        % (cav_px, edge_ratio * 100, "PASS" if ok4 else "FAIL")
    )
    if not ok4:
        fails.append("G4 唇口脱离 %.0f%%" % (edge_ratio * 100))

# ── G5 口腔咬合 ──
if cav_m is not None:
    cb = cav_bb
    wr = (cb[2] - cb[0] + 1) / max(1, lipW)
    gap = cb[3] - ly0  # 口腔底 - 唇顶（负数=重叠）
    ok5 = wr >= 0.85 and abs(gap) <= 4
    print("  G5 口腔咬合：宽比 %.2f（≥0.85）· 口腔底与唇顶 %+dpx（|·|≤4）→ %s" % (wr, gap, "PASS" if ok5 else "FAIL"))
    if not ok5:
        fails.append("G5 咬合 宽比%.2f 间隙%+d" % (wr, gap))
else:
    fails.append("G5 无口腔")

# ── G6 鼻子净空 ──
ny0 = max(0, ly0 - int(0.80 * lipW))
ny1 = max(1, ly0 - int(0.34 * lipW))
nx0 = max(0, lipcx - int(0.24 * lipW))
nx1 = min(CW, lipcx + int(0.24 * lipW))
reg = A[ny0:ny1, nx0:nx1]
dl = SKIN_LUM - lumv(reg.astype(float))
darkn = dl > 40
lab, n = ndi.label(darkn)
sizes = [int(s) for s in ndi.sum(darkn, lab, range(1, n + 1))] if n else []
mx = max(sizes) if sizes else 0
ok6 = mx <= 12
print("  G6 鼻子净空：中轴区 %dx%d · 暗块 %d 块 · 最大 %dpx（≤12）→ %s" % (nx1 - nx0, ny1 - ny0, n, mx, "PASS" if ok6 else "FAIL"))
if not ok6:
    fails.append("G6 鼻子区 %dpx 暗块" % mx)

# ── G7 数据净空 ──
sb = d["skinBox"]
bads = []
for l in d["layers"]:
    h = l["hex"]
    r_, b_ = int(h[1:3], 16), int(h[5:7], 16)
    bx = l["box"]
    inFace = bx[0] >= sb[0] and bx[2] <= sb[2] and bx[1] >= sb[1] and bx[3] <= sb[3]
    if not l.get("role") and l["area"] < 500 and b_ >= r_ and inFace:
        bads.append((l["id"], l["area"]))
ok7 = len(bads) == 0
print("  G7 数据净空：脸区内冷色碎块 %d 块（门槛 0）→ %s%s" % (len(bads), "PASS" if ok7 else "FAIL", "" if ok7 else " " + str(bads[:3])))
if not ok7:
    fails.append("G7 数据层 %d 块冷色碎块" % len(bads))

print("\n" + ("=== 结构闸门 全 PASS ===" if not fails else "=== FAIL: " + "；".join(fails)))
sys.exit(0 if not fails else 1)
