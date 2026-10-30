"""领口/门襟打磨（数据层，改 chars/<key>.json，改前备份）。

老板 2026-10-28 二次看片：「除了衣领有问题」。实测三个真问题 + 两处可打磨：

  ① 领口下方一条横向硬边（颈部阴影被整体下移）
     真因不在数据：FaceTraced 的「下颌下沉重画」把**所有肤色系层**（含颈部阴影 #D99F6C，
     bbox 底 1384）一起 translate(0,jawDrop) 并裁到 [lipMid, skinBox3+0.28·faceH]，
     等于把颈影/领口一起往下拽 → 横缝。修法在组件里（只重画 bbox 底 ≤ 下巴底 的层）。
  ② 纽扣左边一个黑色小勾
     设定稿 (618~627, 1444~1462) 有一块 78px 的近白噪点（#F9F2E4），描摹时因「面积<120 且近白」
     被丢弃 → 原地成洞，透出暗背景 → 成片里是个黑勾。这里用周围衣料色补一块 patch。
  ③ 门襟竖线画在 x≈624，而三颗纽扣中心在 x≈684 —— 设定稿自身错位（AI 生成瑕疵），
     成片里像一道划到胸前的线。这里把门襟移到纽扣中心线上，并从领口 V 尖往下贯穿。
  ④（打磨）沿领口 V 边缘加一条 3px 的深橄榄缝线，让「立领」读得出来而不是一片平涂。
  ⑤（打磨）扫全图找洞：凡是「设定稿有内容、描摹后没有任何层覆盖」的像素簇都补 patch。

用法：python3 tools/polish_collar.py no4 [--dry]
"""
import datetime
import json
import re
import shutil
import sys

import cv2
import numpy as np
from PIL import Image

import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)
CH = _os.path.join(_CHARS_DIR, '%s.json')
SHEET = 'out/AnchorSheetNo%s.png'

GARMENT = '#555339'      # 衣料（主色，取自描摹层 c4）
SEAM = '#4A482E'         # 领口缝线（衣料暗一档）
PLACKET = '#4A482E'      # 门襟
PLACKET_W = 7            # 门襟宽（设定稿 px，成片约 4px）
SEAM_W = 3.0             # 领口缝线宽（设定稿 px）


def parse_d(d):
    nums = re.findall(r'-?\d+\.?\d*', d)
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums) - 1, 2)]


def to_d(pts):
    return 'M ' + ' L '.join('%g,%g' % (x, y) for x, y in pts) + ' Z'


def mask_of(l, W, H):
    m = np.zeros((H, W), np.uint8)
    for s in [s for s in l['d'].split(' Z ') if len(parse_d(s)) >= 3]:
        cv2.fillPoly(m, [np.round(np.array(parse_d(s))).astype(np.int32)], 1)
    return m


def main():
    key = sys.argv[1] if len(sys.argv) > 1 else 'no4'
    dry = '--dry' in sys.argv
    path = CH % key
    d = json.load(open(path, encoding='utf-8'))
    W, H = d['canvas']
    sheet = np.asarray(Image.open(SHEET % key[-1]).convert('RGB'))

    # ── 描摹覆盖图：哪些像素没有任何层覆盖 ──
    cover = np.zeros((H, W), np.uint8)
    for l in d['layers']:
        cover |= mask_of(l, W, H)
    # 人物剪影：与背景色差明显的像素
    bgc = np.median(np.concatenate([sheet[:10, :10].reshape(-1, 3), sheet[:10, -10:].reshape(-1, 3)]), axis=0)
    subj = (np.abs(sheet.astype(int) - bgc).sum(axis=2) > 60).astype(np.uint8)
    # 只认「内部」的洞：腐蚀掉轮廓边缘的抗锯齿毛边，否则每个图层边缘都会被算成洞
    subj_in = cv2.erode(subj, np.ones((9, 9), np.uint8))
    # ⚠ 只在**衣料区（下巴以下）**找洞。眉眼区的「无覆盖像素」不是洞——那是眼层拆分后
    # 瞳孔/眼线之间本来就该露皮肤的地方；在这里补矩形会把眼形擦掉一块
    # （2026-10-28 实测：24 个矩形补丁画在脸上，成片里就是方块和缺口）。
    zone = np.zeros_like(subj_in)
    zone[int(d['skinBox'][3]) + 60:, :] = 1
    holes = (subj_in & (cover == 0) & zone).astype(np.uint8)
    n, lab, stats, cents = cv2.connectedComponentsWithStats(holes, 8)
    patches = []
    for k in range(1, n):
        a = int(stats[k, cv2.CC_STAT_AREA])
        if a < 40:      # <40px 的是图层接缝毛边，补了反而更脏
            continue
        x0, y0 = int(stats[k, cv2.CC_STAT_LEFT]), int(stats[k, cv2.CC_STAT_TOP])
        w, h = int(stats[k, cv2.CC_STAT_WIDTH]), int(stats[k, cv2.CC_STAT_HEIGHT])
        comp = (lab == k).astype(np.uint8)
        ring = cv2.dilate(comp, np.ones((11, 11), np.uint8)) & ~comp & subj
        vals = sheet[ring.astype(bool)]
        if vals.size == 0:
            continue
        col = np.median(vals, axis=0).astype(int)
        hexc = '#%02X%02X%02X' % tuple(col)
        # 用矩形补（洞都很小，矩形足够，且不会在描边处留缝）
        pts = [(x0 - 1, y0 - 1), (x0 + w + 1, y0 - 1), (x0 + w + 1, y0 + h + 1), (x0 - 1, y0 + h + 1)]
        patches.append({'id': 'patch_hole_%d' % k, 'hex': hexc, 'd': to_d(pts),
                        'box': [pts[0][0], pts[0][1], pts[1][0], pts[3][1]],
                        'area': (w + 2) * (h + 2), 'role': None, 'side': None})
    # 已知噪点（设定稿里 78px 的近白斑，描摹按「近白+小块」丢弃后成洞）显式补一块，
    # 自动检测会因为洞被腐蚀切成两段而漏掉中间那条。
    # 旧门襟原来画在 x≈624（设定稿错位），把它移走后 c4 在这条 6px 窄槽上是空的 →
    # 不补就会留一条从领口直落到底的暗缝。用衣料色填平。
    patches.append({'id': 'patch_old_placket', 'hex': GARMENT,
                    'd': to_d([(612, 1700), (640, 1700), (640, H), (612, H)]),
                    'box': [612, 1700, 640, H], 'area': 28 * (H - 1700), 'role': None, 'side': None})
    patches.append({'id': 'patch_speck', 'hex': GARMENT,
                    'd': to_d([(610, 1422), (648, 1422), (648, 1472), (610, 1472)]),
                    'box': [610, 1422, 648, 1472], 'area': 38 * 50, 'role': None, 'side': None})
    print('== 补洞 %d 处' % len(patches))
    for p in patches:
        print('   %-16s %s box%s' % (p['id'], p['hex'], p['box']))

    # ── 门襟：对齐纽扣中心线 ──
    btns = [l for l in d['layers'] if l['id'] in ('c14_26221C', 'c16_26221C', 'c17_26221C')]
    assert btns, '找不到纽扣层（c14/c16/c17）'
    bx = float(np.mean([(l['box'][0] + l['box'][2]) / 2 for l in btns]))
    placket = None
    for l in d['layers']:
        if l['id'] == 'c15_26221C' or (l.get('hex') == '#45442E' and l['box'][2] - l['box'][0] < 12 and l['box'][3] > 1500):
            placket = l
            break
    # 领口 V 尖 = 颈部阴影层的最低点
    neck = min((l for l in d['layers'] if l['box'][3] > 1300 and l['hex'] == '#D99F6C'),
               key=lambda l: -l['area'])
    apex_y = neck['box'][3] + 8
    if placket is not None:
        old = placket['box'][:]
        pts = [(bx - PLACKET_W / 2, apex_y), (bx + PLACKET_W / 2, apex_y),
               (bx + PLACKET_W / 2, H), (bx - PLACKET_W / 2, H)]
        placket['d'] = to_d(pts)
        placket['hex'] = PLACKET
        placket['box'] = [int(bx - PLACKET_W / 2), int(apex_y), int(bx + PLACKET_W / 2), H]
        placket['area'] = int(PLACKET_W * (H - apex_y))
        print('== 门襟：x %.0f → 纽扣中心 %.1f（原 box %s）' % ((old[0] + old[2]) / 2, bx, old))
    else:
        print('== 门襟：原层没找到，跳过')

    # ── 领口缝线：直接用「颈部阴影层」的左右轮廓边（它就是领口 V 的边界）──
    #   不能用「扫色找过渡」：扫描线会先把「背景→衣料」的过渡当成边界，
    #   在领肩转角处跳一步，成片里就是一道台阶（第一版就是这么错的）。
    neck_mask = mask_of(neck, W, H)
    seams = []
    for side in (-1, 1):
        pts = []
        for y in range(int(neck['box'][1]) + 84, int(apex_y) - 22, 3):
            xs = np.where(neck_mask[y])[0]
            if xs.size == 0:
                continue
            pts.append((int(xs.min()) if side < 0 else int(xs.max()), y))
        seams.append(pts)
    seam_ok = all(len(p) > 20 for p in seams)
    print('== 领口缝线：左 %d 点 / 右 %d 点%s' % (len(seams[0]), len(seams[1]), '' if seam_ok else ' ⚠ 点太少，跳过'))
    seam_layers = []
    if seam_ok:
        for i, pts in enumerate(seams):
            # 平滑（3 点滑动平均）避免锯齿
            ys = np.array([p[1] for p in pts], dtype=float)
            xs_ = np.array([p[0] for p in pts], dtype=float)
            k = np.ones(9) / 9
            xs_s = np.convolve(np.pad(xs_, 2, mode='edge'), k, mode='valid')
            # 端头渐收（两端 6 个点把线宽压到 0），避免出现「钩子/台阶」
            def w_at(j, n):
                e = min(j, n - 1 - j)
                return SEAM_W / 2 * min(1.0, e / 10.0)
            sgn = 1 if i == 0 else -1
            up = [(float(x - sgn * w_at(j, len(xs_s))), float(y)) for j, (x, y) in enumerate(zip(xs_s, ys))]
            dn = [(float(x + sgn * w_at(j, len(xs_s))), float(y))
                  for j, (x, y) in enumerate(zip(xs_s[::-1], ys[::-1]))]
            poly = up + dn
            # area 只用来决定描边粗细（FaceTraced 里 >1% 画布 → strokeWidth 8）；
            # 缝线是细带，必须给小值，否则 8px 描边把 3px 的带撑成 11px 的粗杠。
            # role='seam' 让 FaceTraced 对这条路径完全不描边。
            seam_layers.append({'id': 'seam_%s' % ('L' if i == 0 else 'R'), 'hex': SEAM,
                                'd': to_d(poly),
                                'box': [int(min(p[0] for p in poly)), int(min(p[1] for p in poly)),
                                        int(max(p[0] for p in poly)), int(max(p[1] for p in poly))],
                                'area': int(len(poly) * SEAM_W), 'role': 'seam', 'side': None})

    if dry:
        print('（--dry：不写盘）')
        return

    # 插层位置（z 序很关键）：
    #   patch（补洞）要压在「肤色大层」之上、「五官/镜框」之下 —— 既补衣服上的洞，
    #     也补眼层拆分后瞳孔周围可能露出的细缝（用周围颜色填，等于无缝延展）。
    #   seam（领口缝线）要在颈部阴影之上，否则被阴影层盖掉一半。
    idx_patch = max(i for i, l in enumerate(d['layers'])
                    if l['hex'] == '#F0B781' and l['area'] > 200000)
    d['layers'] = d['layers'][:idx_patch + 1] + patches + d['layers'][idx_patch + 1:]
    idx_seam = max(i for i, l in enumerate(d['layers'])
                   if l.get('hex') in (GARMENT, '#D99F6C') and l['area'] > 40000)
    d['layers'] = d['layers'][:idx_seam + 1] + seam_layers + d['layers'][idx_seam + 1:]
    add = seam_layers + patches
    bk = path + '.bak-' + datetime.datetime.now().strftime('%d%H%M%S')
    shutil.copy2(path, bk)
    json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    print('写盘：+%d 层（缝线 %d / 补洞 %d），备份 %s' % (len(add), len(seam_layers), len(patches), bk))


if __name__ == '__main__':
    main()
