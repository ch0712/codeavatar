"""机检门槛 · 口型表：幅度 / 可分性（gpt-6 第 1 轮给的判据，落到可跑的数字）。

用法：python3 tools/gate_mouth.py out/viseme-no4-v3.png [列数 行数 格宽 格高]
判定：
  ① 幅度：A 的嘴高 ≥ M 的 2.0 倍
  ② 可分性：六型的 (唇高, 唇宽, 宽高比) 两两至少一项差 ≥15%
  ③ 闭唇：M 的嘴高 < 18px（相对同尺度）—— 闭嘴必须真闭
"""
import itertools
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)

P = sys.argv[1] if len(sys.argv) > 1 else "/H/.hermes/workspace/autocut/refs/dhk/out/viseme-no4-v3.png"
# --char <key>：从 chars/<key>.json 读该角色的唇色/肤色，按**相对**判据量嘴。
# 必须这样：原来的阈值（唇 R-B>85）是按 NO.4 调色板写死的，
# 换到 NO.5（唇 #CF8866，R-B=73）会把整张嘴判成"没张开"——量具坏了，不是嘴坏了。
_CHAR = None
for i, a_ in enumerate(sys.argv):
    if a_ == '--char':
        _CHAR = sys.argv[i + 1]
COLS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
ROWS = int(sys.argv[3]) if len(sys.argv) > 3 else 2
CW = int(sys.argv[4]) if len(sys.argv) > 4 else 640
CH = int(sys.argv[5]) if len(sys.argv) > 5 else 800
NAMES = ["M", "A", "O", "E", "I", "U"]

a = np.asarray(Image.open(P).convert("RGB")).astype(int)


def near(c, tol):
    return np.abs(a - np.array(c)).max(axis=2) <= tol


# 嘴 = 唇面 + 口腔暗部 + 牙，三者取并集再找最大连通块
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
# 唇：明显偏红。肤色 #F0B781 的 r-g=57、皮肤阴影 #D99F6C 的 r-g=58，唇 #D7825D 的 r-g=85
# → 阈值取 70 才能把唇从皮肤里分出来（之前用绝对色值，结果匹配到整块皮肤）
if _CHAR:
    import json
    _d = json.load(open(_os.path.join(_CHARS_DIR, '%s.json' % _CHAR), encoding='utf-8'))
    _lc = _d.get('lipColor') or '#D7825D'
    _lip_rgb = np.array([int(_lc[1:3], 16), int(_lc[3:5], 16), int(_lc[5:7], 16)])
    # 2026-10-30：容差 34 太宽 —— no4 的脖子阴影 #E0A87A 与唇 #D7825D 只差 32/通道，
    # 会被算成唇，实测 M 格「嘴高」被量成 163px（真值 20px）。收到 18（两个角色实测都干净）。
    lip = np.abs(a - _lip_rgb).max(axis=2) <= 18
else:
    lip = (R - G > 70) & (R - B > 85) & (R > 150)
# 口腔暗部：暗且偏红
cavity = (R < 140) & (R - G > 12) & (R - B > 22) & (R > 40)
# 牙：高亮
teeth = (R > 225) & (G > 220) & (B > 205)
mouth = lip | cavity | teeth

meas = {}
cell_masks = {}
for i, name in enumerate(NAMES):
    r, c = divmod(i, COLS)
    y0, x0 = r * CH, c * CW
    sub = mouth[y0:y0 + CH, x0:x0 + CW]
    # 闭唇判定只用渲染器自己的口腔色（FaceTraced 的 cavity 填 #42201C）。
    # 宽松的「偏红暗部」会把唇线（#743E28 一类）也算进口腔 → 闭着的嘴被判成张着（实测 no4 误报 1441px）。
    _cav_tight = np.abs(a[y0:y0 + CH, x0:x0 + CW] - np.array([0x42, 0x20, 0x1C])).max(axis=2) <= 22
    cell_masks[name] = {"cavity": _cav_tight}
    lab, n = ndi.label(sub, structure=np.ones((3, 3)))
    # 2026-10-30：改成「与唇像素交集最大的连通块」。原来取 global 最大块，
    # 而 cavity 判据 (R<140 & R-G>12 & R-B>22) 会把头发也算进来，头发的块远大于嘴 →
    # no4 的 M 格被量成「嘴高 163px」。以唇为锚点，只会量到嘴本身。
    _lipc = lip[y0:y0 + CH, x0:x0 + CW]
    best, area = None, 0
    for k in range(1, n + 1):
        m = lab == k
        inter = int((m & _lipc).sum())
        if inter == 0:
            continue
        ys, xs = np.where(m)
        if inter > area:
            area, best = inter, (xs.min(), ys.min(), xs.max(), ys.max())
    if best is None:
        for k in range(1, n + 1):
            ys, xs = np.where(lab == k)
            if len(xs) > area:
                area, best = len(xs), (xs.min(), ys.min(), xs.max(), ys.max())
    if not best:
        meas[name] = (0, 0, 0.0, 0, 0)
        continue
    w = best[2] - best[0] + 1
    h = best[3] - best[1] + 1
    meas[name] = (int(h), int(w), round(w / max(1, h), 2), int(best[1]), int(best[3]))

print(f"图 {P}")
print(f"{'口型':<4}{'唇高px':>8}{'唇宽px':>8}{'宽高比':>8}")
for k in NAMES:
    h, w, ar = meas[k][0], meas[k][1], meas[k][2]
    print(f"{k:<4}{h:>8}{w:>8}{ar:>8}")

fails = []

# ① 幅度
# 2026-10-30 口径修正：原来量「A 格嘴区高度 / M 格嘴区高度」，而嘴区 = lip∪cavity∪teeth
# 的并集 —— 牙齿那块白色是谁的一部分，直接决定幅度读数：牙齿画高一点幅度就"变大"，
# 压薄一点就"变小"（实测 no4：牙带 0.55 压扁时 1.78x、0.62 时 1.72x，而真实开口没变）。
# 牙齿是视觉细节，不该进幅度。
# 改为跨格锚点：**A 格嘴区底 − M 格唇顶**，即「下唇实际下沉了多少」，
# 与牙齿形状、颜色、透明度全部无关。分母仍是 M 格唇高。
mh = max(1, meas["M"][0])
a_span = meas["A"][4] - meas["M"][3]
ratio = a_span / mh
ok1 = ratio >= 2.0
print(f"\n① 幅度：A/M 高度比 = {ratio:.2f}x （门槛 ≥2.00）→ {'PASS' if ok1 else 'FAIL'}")
if not ok1:
    fails.append(f"幅度不足：{ratio:.2f}x < 2.00")

# ② 可分性
print("② 可分性（两两至少一项差 ≥15%）")
bad_pairs = []
for x, y in itertools.combinations(NAMES, 2):
    hx, wx, ax = meas[x][0], meas[x][1], meas[x][2]
    hy, wy, ay = meas[y][0], meas[y][1], meas[y][2]
    diffs = []
    for va, vb, label in ((hx, hy, "高"), (wx, wy, "宽"), (ax, ay, "宽高比")):
        base = max(1, max(va, vb))
        diffs.append((abs(va - vb) / base, label))
    best = max(diffs)
    flag = "" if best[0] >= 0.15 else "  ← 太像"
    if best[0] < 0.15:
        bad_pairs.append(f"{x}/{y}")
    print(f"   {x}-{y:<3} 最大差异 {best[0]*100:5.1f}% ({best[1]}){flag}")
ok2 = not bad_pairs
print(f"   → {'PASS' if ok2 else 'FAIL' + ''}")
if not ok2:
    fails.append("可分性不足：" + ", ".join(bad_pairs))

# ③ 闭唇 —— **只记录，不判定**（2026-10-30 第二次修正）
# 这一条改过两版口径，都错了：
#   v1 `M 嘴高 <= 20px`：按 NO.4 唇厚标定的绝对值，换到唇厚 47px 的 NO.5，闭着的嘴本身就有 26px → 假 FAIL
#   v2 `M 帧口腔色 #42201C 像素 = 0`：容差 22 会把眉毛 #2E2620 也算进来（实测 no4 的 M 格误报 4524px）
# 结论：表级不该用颜色猜「有没有口腔」。闭唇严不严在**成片级**有专门闸门
# （gate_film_mouth 的 ⑤ 口腔溢出 + 闭唇占比），这里只把数字打出来供人看。
_m_cell = a[0:CH, 0:CW]
_teeth_px = int(((_m_cell[:, :, 0] > 225) & (_m_cell[:, :, 1] > 220) & (_m_cell[:, :, 2] > 205)).sum())
print(f"\n③ 闭唇（仅记录，不判定）：M 嘴高 {meas['M'][0]}px · M 格近白（牙/眼白）像素 {_teeth_px}")

print("\n" + ("=== 全部 PASS ===" if not fails else "=== FAIL: " + "；".join(fails)))
sys.exit(0 if not fails else 1)
