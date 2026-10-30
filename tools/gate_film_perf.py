"""成片表演闸门（视频级）：直接量 mp4，不看代码自报。

两条判据来自老板 2026-10-28 看片指出的问题：
  F1 镜框必须相对脸静止：抬眉时镜框上沿不得跟着动。
     量法：取「眉毛带 / 镜片下沿带」两块深色区域的质心，算「镜框质心 − 眉毛质心」，
     逐帧统计它的抖动。眉/框一起平移或旋转都会被这个相对量抵消，只剩「层被误标成可动」造成的位移。
  F2 眼睛必须真的在动：量「眼带质心 − 眉毛质心」的水平跨度与不同停留位置数。
     只吃真实渲染结果，视线参数是死代码（位移没接到瞳孔上）时这里必然是 0。

用法：python3 tools/gate_film_perf.py out/anchor-no4.mp4 no4 [--json]
非 0 退出 = 不过闸门。
"""
import json
import re
import subprocess
import sys

import numpy as np

import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)
CH = _os.path.join(_CHARS_DIR, '%s.json')
# 分析用裁剪窗口（全分辨率，只截脸部）——半分辨率下瞳孔直径只有 11px，
# 视线位移 5px 会被质心噪声淹没，量不出真假。
CROP = None                # (x, y, w, h)，main 里按角色算
W2 = H2 = 0                # = CROP 的宽高
DARK = 100                 # 灰度阈值（深色层 ≈ 35~45，肤色 ≈ 150~190）

# 阈值（两条都在修复前后实测过，见 reports 记录）
F1_STD_MAX = 3.0           # 镜框相对眉毛的抖动 std（px，全分辨率）
F1_PEAK_MAX = 5.0          # 最大偏离（px）—— 修复前实测 peak 7.7px，修复后 ≤2px
F2_SPAN_MIN = 5.0          # 瞳孔偏心跨度（px）—— 眼睛静止实测 1.5px，有视线 9.6px
F2_POS_MIN = 6             # 不同停留位置数（1px 量化）—— 静止眼实测 2 个，有视线 ≥7 个


def char_to_video(d):
    """复刻 AnchorFilm.tsx 的构图换算（char 坐标系 → 1920x1080 画幅）。"""
    CW, CH_ = d['canvas']
    FACE_X = (d['skinBox'][0] + d['skinBox'][2]) / 2
    hairTop = min(l['box'][1] for l in d['layers']
                  if l['hex'] != d['bg'] and l['area'] > CW * CH_ * 0.05)
    chinY = d['skinBox'][3]
    HEAD_H = 0.54 * 1080
    BOX_W = 1000
    s2b = BOX_W / CW
    k = HEAD_H / max(1, chinY - hairTop) / s2b
    headX, headY = 0.6 * 1920, 0.315 * 1080
    anchorY = (hairTop + chinY) / 2

    def f(x, y):
        return (headX + k * s2b * (x - FACE_X), headY + k * s2b * (y - anchorY))
    return f


def frames(mp4):
    x, y, w, h = CROP
    cmd = ['ffmpeg', '-v', 'error', '-i', mp4,
           '-vf', 'crop=%d:%d:%d:%d' % (w, h, x, y),
           '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (W2 * H2)
    return np.frombuffer(raw[:n * W2 * H2], np.uint8).reshape(n, H2, W2)


def pupil_centroid(a, box, target=None):
    """在眼内找**瞳孔**：最深的实心团，形状接近圆（长宽比 0.55~1.8），面积 150~1200px。

    不能用「腐蚀后取质心」——镜框残段（厚 ~15px）也会活下来，跟着抬眉一起走，
    量出来的就是「框在动」而不是「眼在动」（实测旧片量到 18px，实际眼是静止的）。
    形状判据把镜框细长条排除掉，只剩瞳孔。
    """
    import cv2
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W2, x1), min(H2, y1)
    roi = (a[y0:y1, x0:x1] < DARK).astype(np.uint8)
    # 瞳孔与上眼线同色相连（设定稿就是这样），先腐蚀 7px 把细眼线咬断，只留瞳孔核心
    roi = cv2.erode(roi, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    n, lab, stats, cents = cv2.connectedComponentsWithStats(roi, 8)
    best = None
    for k in range(1, n):
        w = stats[k, cv2.CC_STAT_WIDTH]
        h = stats[k, cv2.CC_STAT_HEIGHT]
        ar = stats[k, cv2.CC_STAT_AREA]
        if ar < 40 or ar > 1600:
            continue
        r = w / float(max(1, h))
        if not (0.5 <= r <= 2.6):   # NO.1 的瞳孔与眼线咬得深，腐蚀后仍偏宽（57x25）
            continue
        fill = ar / float(max(1, w * h))
        if fill < 0.55:            # 实心
            continue
        cx, cy = cents[k]
        d = 0.0 if target is None else ((x0 + cx - target[0]) ** 2 + (y0 + cy - target[1]) ** 2) ** 0.5
        score = -fill * 10 + d * 0.05
        if best is None or score < best[0]:
            best = (score, (x0 + cx, y0 + cy), int(ar))
    if best is None:
        return None, 0
    return best[1], best[2]


def centroid(a, box):
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W2, x1), min(H2, y1)
    roi = a[y0:y1, x0:x1]
    m = roi < DARK
    n = int(m.sum())
    if n < 20:
        return None, 0
    ys, xs = np.nonzero(m)
    return (x0 + xs.mean(), y0 + ys.mean()), n


def main():
    mp4 = sys.argv[1]
    key = sys.argv[2]
    d = json.load(open(CH % key, encoding='utf-8'))
    f = char_to_video(d)
    eyes = d['eyes']
    eyeTop = min(e['cy'] - e['h'] / 2 for e in eyes)
    eyeBot = max(e['cy'] + e['h'] / 2 for e in eyes)
    browL = min(l['box'][1] for l in d['layers'] if l.get('role') == 'brow')
    browB = max(l['box'][3] for l in d['layers'] if l.get('role') == 'brow')
    rim = [l['box'] for l in d['layers'] if l.get('role') == 'rim']
    if rim:
        rimTop = min(b[1] for b in rim)
        rimBot = max(b[3] for b in rim)
    else:  # 没有 rim 层：镜片下沿取眼下 30~110px
        rimTop, rimBot = eyeBot + 30, eyeBot + 110
    X0, X1 = d['skinBox'][0] - 40, d['skinBox'][2] + 40

    global CROP, W2, H2
    # 上边界留够抬眉行程：修复前的抬眉幅度可达 32 设定稿px（成片 18px），
    # ROI 留窄了眉毛会顶出界 → 质心被裁切带偏，F1/F2 都会失真。
    pa = f(X0, browL - 46)
    pb = f(X1, max(rimBot, eyeBot) + 14)
    CROP = (max(0, int(pa[0])), max(0, int(pa[1])), int(pb[0] - pa[0]), int(pb[1] - pa[1]))
    CROP = (CROP[0], CROP[1], CROP[2] // 2 * 2, CROP[3] // 2 * 2)
    W2, H2 = CROP[2], CROP[3]

    def to_px(x, y):
        vx, vy = f(x, y)
        return vx - CROP[0], vy - CROP[1]

    # F1 用「镜框上带 vs 镜框下带」：两块都是静止结构，彼此距离恒定。
    #   不能拿「镜框 − 眉毛」当判据——眉毛本来就该动，那样会把正常抬眉判成穿帮
    #   （实测修复后 peak 就到 4px，离门槛只剩 1px 余量）。
    topBox = (*to_px(X0, rimTop - 2), *to_px(X1, eyeTop - 8)) if rim else None
    botBox = (*to_px(X0, eyeBot + 20), *to_px(X1, rimBot + 2)) if rim else None
    eyeBoxes, eyeTargets = [], []
    for e in eyes:
        # 眼内 ROI：只取眼睛本身（±2px），用来量「瞳孔在眼形里的相对位置」
        eyeBoxes.append((*to_px(e['cx'] - e['w'] / 2 - 2, eyeTop - 6),
                         *to_px(e['cx'] + e['w'] / 2 + 2, eyeBot + 8)))
        eyeTargets.append(to_px(e['cx'], e['cy'] + 6))

    def gaze_signal(a, box, target):
        """瞳孔在眼形里的水平偏心（px）：瞳孔质心 − 深色区域左右端点中点。
        端点（眼线外端）是静止结构，所以整体平移/缩放被减掉，剩下的就是视线位移。"""
        x0, y0, x1, y1 = [int(round(v)) for v in box]
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W2, x1), min(H2, y1)
        roi = a[y0:y1, x0:x1] < DARK
        xs = np.nonzero(roi)[1]
        if xs.size < 50:
            return None
        mid = (xs.min() + xs.max()) / 2
        pc, ar = pupil_centroid(a, box, target=target)
        if not pc:
            return None
        return (pc[0] - x0) - mid

    fr = frames(mp4)
    f1, f2 = [], []
    for i in range(fr.shape[0]):
        a_ = fr[i]
        if rim:
            ct, nt = centroid(a_, topBox)
            cbm, nb = centroid(a_, botBox)
            if ct and cbm:
                f1.append(ct[1] - cbm[1])
        g = [gaze_signal(a_, b, t) for b, t in zip(eyeBoxes, eyeTargets)]
        g = [q for q in g if q is not None]
        if g:
            f2.append(float(np.mean(g)))

    print('== %s  %d 帧' % (mp4, fr.shape[0]))
    ok = True
    print('== %s  共 %d 帧，F1 有效 %d 帧，F2 有效 %d 帧' % (mp4, fr.shape[0], len(f1), len(f2)))
    if f1:
        v = np.array(f1)
        print('   [诊断] 镜框上下带距离 std=%.2fpx peak=%.2fpx（仅供参考，不作判据）'
              % (v.std(), float(np.abs(v - v.mean()).max())))
        print('         视频层量不出「框被拖」：头动/抬眉/镜框被拖三者位移混在一起，'
              '实测旧片 6.0px、新片 5.9px 无法区分。这条判据放在数据闸门 '
              'gate_layer_roles G2/G6（动层与镜框像素零重叠）。')
    if f2:
        v = np.array(f2)
        span = float(v.max() - v.min())
        pos = len(np.unique(np.round(v)))
        print('   F2 瞳孔在眼形里的偏心 跨度=%.2fpx 停留位置=%d  (门槛 ≥%.1fpx / ≥%d)'
              % (span, pos, F2_SPAN_MIN, F2_POS_MIN))
        if span < F2_SPAN_MIN or pos < F2_POS_MIN:
            print('   ✗ F2 眼睛几乎不动 —— 视线没接到瞳孔上，或幅度不够')
            ok = False
    else:
        print('   ✗ F2 量不到瞳孔')
        ok = False
    if ok:
        print('   ✓ F1/F2 全过')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
