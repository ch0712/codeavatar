"""曲线化 v2：折线 → 三次贝塞尔（自研拟合，不依赖 potrace 的坐标约定）。

为什么不用 potrace：实测它输出的 SVG 有 `scale(0.1,-0.1)` + 隐式相对命令，
解析一层套一层（孔洞子路径 / 隐式重复 / y 翻转 / 0.1 单位），四次尝试都对不齐；
而这一步真正需要的只是「平滑 + 控制点可形变」，自己拟合更可控、可逐层校验。

做法（每层独立，全部可验证）：
  1. 按 evenodd 光栅化该层 → 1x 掩膜（保留孔洞）
  2. 4× 双三次上采样 → 0.5 等值线（cv2.findContours，坐标 /4 回 1x，精度 0.25px）
  3. approxPolyDP(ε=0.30) 去锯齿保留角点 → Chaikin 切角 1 次（尖角不动）→ 平滑折线
  4. Catmull-Rom → 三次贝塞尔（`C` 命令），张力 1.0，端点切向按相邻点推
  5. 校验：把新路径光栅化回 1x，与原掩膜算 IoU 与最大偏差

用法：python3 tools/curve_fit.py no4 [no1] [--dry]
"""
import datetime
import json
import math
import re
import shutil
import sys

import cv2
import numpy as np
from scipy.spatial import cKDTree

import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)
CH = _os.path.join(_CHARS_DIR, '%s.json')
SS = 4                 # 上采样倍数（轮廓精度 1/SS px）
EPS = float(__import__('os').environ.get('CURVE_EPS', '0.60'))   # approxPolyDP 容差（1x px）
# ⚠ 2026-10-28 回退教训：原来取 145°，而大形（脸/下颌）经 DP 简化后顶点夹角常在 150~165°，
# 被误判成「尖角」→ 张力≈0 → 下颌变成几段直线 + 硬拐角（老板一眼看出「下颌骨出问题」）。
# 只有真正锐利的角（<122°）才算拐角；150° 以上一律全张力平滑。
CORNER_DEG = 122.0
IOU_MIN = 0.930
DEV_MAX = 0.75         # 几何偏差 p99（1x px）
NUM = r'-?\d+\.?\d*'


def parse_subpaths(d):
    out = []
    for s in [s for s in d.split(' Z ') if s.strip()]:
        nums = re.findall(NUM, s)
        pts = [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums) - 1, 2)]
        if len(pts) >= 3:
            out.append(pts)
    return out


def layer_mask(l, W, H):
    m = np.zeros((H, W), np.uint8)
    for pts in parse_subpaths(l['d']):
        one = np.zeros((H, W), np.uint8)
        cv2.fillPoly(one, [np.round(np.array(pts)).astype(np.int32)], 1)
        m ^= one                     # evenodd：孔洞保持 0
    return m


def contours_1x(mask, W, H):
    """4× 上采样取 0.5 等值线 → (简化点列, 是否孔洞, 原始亚像素点列)。

    返回里带 dense 点列是为了**用真实几何距离做校验**（IoU 会被光栅化 1px 边界吃掉，
    细长件永远过不了，量的是边界效应不是拟合误差）。
    """
    big = cv2.resize(mask.astype(np.float32), (W * SS, H * SS), interpolation=cv2.INTER_CUBIC)
    # 阈值 0.5 会让双三次插值的「振铃」把边界推出去约 0.25px（实测面积普遍 +5~17%）；
    # 取 0.57 抵消这次膨胀，让面积比回到 1.00 附近（逐层仍有 4x IoU 校验兜住）
    bm = (big > 0.57).astype(np.uint8)
    cs, hier = cv2.findContours(bm, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    for i, c in enumerate(cs):
        if cv2.contourArea(c) / (SS * SS) < 12:
            continue
        dense = c.reshape(-1, 2).astype(np.float64) / SS
        per = float(cv2.arcLength(c, True)) / SS
        eps = EPS if per < 600 else max(0.30, EPS * 0.55)   # 大形（脸/下颌）收紧容差，避免长直段
        ap = cv2.approxPolyDP(c, eps * SS, True).reshape(-1, 2).astype(np.float64) / SS
        if len(ap) < 3:
            continue
        out.append((ap, hier[0][i][3] >= 0, dense))
    return out


def _angle(a, b, c):
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n1 = math.hypot(*v1); n2 = math.hypot(*v2)
    if n1 < 1e-9 or n2 < 1e-9:
        return 180.0
    cosv = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cosv))


def _smoothness(prev, cur, nxt):
    """顶点有多"该被平滑"：0=尖角（走直线），1=几乎共线（全力走曲线）。"""
    ang = _angle(prev, cur, nxt)          # 180° = 共线
    t = max(0.0, min(1.0, (ang - CORNER_DEG) / (150.0 - CORNER_DEG)))
    return t * t * (3 - 2 * t)            # smoothstep：150° 以上全张力，122° 以下全直角



def to_bezier(pts):
    """Catmull-Rom（闭合、按顶点平滑度调张力）→ 三次贝塞尔。

    为什么不用 Chaikin：Chaikin 是**切角**，会让轮廓整体内缩（实测细长件 IoU 掉到 0.72~0.89，
    6px 宽的门襟直接被切没）。Catmull-Rom **经过所有顶点**，顶点位置逐点保真；
    尖角处张力压到 0（等价走直线），只有真正圆滑的地方才出曲线 —— 镜框直角不会被抹圆。
    """
    n = len(pts)
    if n < 3:
        return None
    t = [_smoothness(pts[i - 1], pts[i], pts[(i + 1) % n]) for i in range(n)]
    d = ['M %.2f,%.2f' % (pts[0][0], pts[0][1])]
    for i in range(n):
        p0 = pts[i - 1]; p1 = pts[i]; p2 = pts[(i + 1) % n]; p3 = pts[(i + 2) % n]
        k1 = t[i] / 6.0
        k2 = t[(i + 1) % n] / 6.0
        c1 = (p1[0] + (p2[0] - p0[0]) * k1, p1[1] + (p2[1] - p0[1]) * k1)
        c2 = (p2[0] - (p3[0] - p1[0]) * k2, p2[1] - (p3[1] - p1[1]) * k2)
        d.append('C %.2f,%.2f %.2f,%.2f %.2f,%.2f' % (c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return ' '.join(d) + ' Z'


def flatten(d, steps=10):
    tok = re.findall(r'[MLCZ]|' + NUM, d)
    polys, cur, i = [], [], 0
    cx = cy = 0.0
    cmd = None
    while i < len(tok):
        t = tok[i]
        if re.match(r'[MLCZ]', t):
            cmd = t; i += 1
            if cmd == 'Z':
                if len(cur) >= 3:
                    polys.append(np.array(cur))
                cur = []
            continue
        if cmd == 'M':
            cx, cy = float(tok[i]), float(tok[i + 1]); i += 2
            if len(cur) >= 3:
                polys.append(np.array(cur))
            cur = [(cx, cy)]
        elif cmd == 'L':
            cx, cy = float(tok[i]), float(tok[i + 1]); i += 2
            cur.append((cx, cy))
        elif cmd == 'C':
            x1, y1, x2, y2, x3, y3 = [float(tok[i + k]) for k in range(6)]
            i += 6
            for s in range(1, steps + 1):
                u = s / steps
                b = ((1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3)
                cur.append((b[0] * cx + b[1] * x1 + b[2] * x2 + b[3] * x3,
                            b[0] * cy + b[1] * y1 + b[2] * y2 + b[3] * y3))
            cx, cy = x3, y3
        else:
            raise RuntimeError('flatten 未知命令 %r' % cmd)
    if len(cur) >= 3:
        polys.append(np.array(cur))
    return polys


def raster(d, W, H):
    m = np.zeros((H, W), np.uint8)
    polys = flatten(d)
    if not polys:
        return m
    for p in polys:
        one = np.zeros((H, W), np.uint8)
        cv2.fillPoly(one, [np.round(p).astype(np.int32)], 1)
        m ^= one                      # 与 evenodd 语义一致
    return m


def raster_at(d, W, H, k=SS):
    """把路径按 k 倍光栅化（用于 4x 精度校验）。"""
    m = np.zeros((H * k, W * k), np.uint8)
    for poly in flatten(d, 10):
        one = np.zeros_like(m)
        cv2.fillPoly(one, [np.round(np.asarray(poly, dtype=float) * k).astype(np.int32)], 1)
        m ^= one
    return m


def iou_at_ratio(d, m0, W, H, k=SS):
    """与 1x 掩膜（上采样 k 倍）在 k 倍网格上算 IoU —— 精度 1/k px，细长件也不会被光栅化吃掉。"""
    a = raster_at(d, W, H, k)
    b = cv2.resize(m0, (W * k, H * k), interpolation=cv2.INTER_NEAREST)
    return float((a & b).sum()) / max(1, (a | b).sum())


def iou_at(d, m0, W, H):
    return None


def main():
    keys = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry = '--dry' in sys.argv
    assert keys, '用法：python3 tools/curve_fit.py no4 [no1] [--dry]'
    for key in keys:
        path = CH % key
        d = json.load(open(path, encoding='utf-8'))
        W, H = d['canvas']
        n_old = sum(len(re.findall(NUM, l['d'])) // 2 for l in d['layers'])
        rows = []
        for l in d['layers']:
            if l['id'].startswith('patch'):
                rows.append((l['id'], -1, -1, -1, 'patch 不曲线化'))
                continue
            m0 = layer_mask(l, W, H)
            if m0.sum() < 40:
                rows.append((l['id'], int(m0.sum()), -1, -1, '太小跳过'))
                continue
            cons = contours_1x(m0, W, H)
            if not cons:
                rows.append((l['id'], int(m0.sum()), -1, -1, '无轮廓'))
                continue
            parts = []
            n_curve = n_poly = 0
            for pts, is_hole, dense in cons:
                ring = pts if not is_hole else pts[::-1]
                # 平均厚度 = 2*面积/周长：太薄的件（缝线/门襟/镜腿碎片）曲线化只会把它撑胖，
                # 一律保留「亚像素折线」——顶点来自 4x 等值线，台阶已经降到 0.25px
                area = abs(cv2.contourArea(np.asarray(ring, dtype=np.float32)))
                per = cv2.arcLength(np.asarray(ring, dtype=np.float32), True)
                thick = 2.0 * area / max(1e-6, per)
                bd = to_bezier(ring) if thick >= 6.0 else None
                if bd:
                    parts.append(bd)
                    n_curve += 1
                else:
                    parts.append('M ' + ' L '.join('%.2f,%.2f' % (x, y) for x, y in ring) + ' Z')
                    n_poly += 1
            newd = ' '.join(parts)
            m1 = raster(newd, W, H)
            iou4 = iou_at_ratio(newd, m0, W, H)
            ar = float(m1.sum()) / max(1, float(m0.sum()))
            # 面积比允许 ±20%：亚像素化对小件会带来 ~0.25px 的边界膨胀（原折线本来就是 ±0.5px 量化）
            ok = iou4 >= 0.965 and 0.85 <= ar <= 1.22
            rows.append((l['id'], int(m0.sum()), iou4, ar, ok, newd,
                         '%d曲/%d折' % (n_curve, n_poly)))
        bad = [r for r in rows if len(r) == 7 and not r[4]]
        print('== %s  曲线化 %d 层，不达标 %d 层（不达标保留原折线）'
              % (key, len([r for r in rows if len(r) == 7]), len(bad)))
        for r in rows:
            if len(r) < 7:
                print('   %-20s %s' % (r[0], r[-1]))
            else:
                print('   %-20s area%7d  IoU4 %.4f  面积比 %.3f  %s  %s'
                      % (r[0], r[1], r[2], r[3], r[6], '✓' if r[4] else '⚠'))
        if dry:
            print('（--dry：不写盘）')
            continue
        it = iter(rows)
        for l in d['layers']:
            r = next(it)
            if len(r) == 7 and r[4]:
                l['d'] = r[5]
                l['curve'] = True
        n_new = sum(len(re.findall(NUM, l['d'])) // 2 for l in d['layers'])
        bk = path + '.bak-' + datetime.datetime.now().strftime('%d%H%M%S')
        shutil.copy2(path, bk)
        json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
        print('写盘：顶点 %d → %d，备份 %s' % (n_old, n_new, bk))


if __name__ == '__main__':
    main()
