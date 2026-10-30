"""眼层重建：把角色 JSON 里的「眼」修对，并把「眼线+瞳孔」黏连团拆成 iris（可动）+ lid（静态）。

老板看片指出两个问题（2026-10-28）：
  ① 抬眉时镜框上沿跟着抬 → 成片里镜框上方多出一条游离横线、镜片上方裂开。
  ② 眼睛全程不动 → 没生气。

真因（都在「层角色判定」，不在渲染参数）：
  · NO.4 的 PRESETS 眼区框（y733~862）量错位了：真正的眼睛在 y689~731，
    而 y733~862 里是「镜片下沿」。于是——
      - 真眼 c24/c25 两个层 role=None（谁都不动它），
      - 镜片下沿碎片被标成 role=eye（**眨眼时被压扁的是镜框**），
      - 镜框上框 c28/c30/c10 被「眉区框包含」+「中心落眉区就转 brow_fill」两条规则吞成眉毛，
        抬眉 21.5px/单位 → 镜框整条横带上飘 = 老板看到的那条多余线。
  · 两角色的瞳孔都和上眼线连成一个连通团（设定稿本来就是贴着的），描摹按连通块出路径 →
    整团都是 role=eye，没有 iris；而 FaceTraced 只把 gazeX/gazeY 给 role=iris 的层 → 视线是死参数。

做法：
  · RECLASS：按**实测解剖**逐层重定角色（表里每个 id 都经过放大图核对），并重算 eyes[]。
  · SPLIT：对每只眼用**距离变换**取「胖的那块」= 瞳孔（眼线厚度 ~15px、瞳孔直径 ~40px，
    阈值取 0.4·maxDist 落在两者之间），反膨胀回瞳孔边界 → iris；该眼掩膜减掉 iris → lid
    （每个原色一层，轮廓允许凹口/孔洞，evenodd 填充）。
  · 全程断言；改前自动备份。

用法：python3 tools/split_eye_layers.py no4 [no1 ...]
      python3 tools/split_eye_layers.py no4 --dry （只打印，不写盘）
"""
import datetime
import json
import math
import re
import shutil
import sys

import cv2
import numpy as np

import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)
CH = _os.path.join(_CHARS_DIR, '%s.json')

# ── 实测解剖表（设定稿坐标，放大 5~7 倍逐层核对过）──────────────────────
# NO.4：眉 y585~640 / 镜框上框 y643~682 / 眼 y689~732 / 镜片下沿 y775~840
RECLASS = {
    'no4': {
        'eye': {'c24_26221C': 0, 'c25_26221C': 1},
        'brow': {'c12_555339': 'L', 'c13_555339': 'R', 'c31_26221C': 'R', 'c11_555339': 'R'},
        'rim': ['c28_26221C', 'c30_26221C', 'c10_555339',   # 上框 + 桥位（原被吞成眉毛）
                'c29_26221C', 'c27_26221C', 'c26_26221C', 'c23_26221C',
                'c22_26221C', 'c21_26221C',                 # 镜腿/鼻托/镜片内缘
                'c9_555339', 'c20_26221C', 'c8_555339', 'c7_555339',
                'c6_555339', 'c19_26221C', 'c18_26221C'],   # 镜片下沿（原被误标成 eye）
    },
}


# ── 瞳孔实测表（设定稿坐标，放大 5~9 倍逐像素量的椭圆）──────────────────
# 自动测量不可靠：眼线与瞳孔同色相连，最宽弦会量到眼线外张的粗段（实测 NO.1 会量成 113px）。
# 所以瞳孔几何**按放大图量死**，脚本只负责校验（椭圆 ≥85% 落在描摹掩膜里）。
PUPIL = {
    'no4': {0: (537.0, 711.0, 22.0, 20.0), 1: (815.5, 709.5, 22.5, 20.5)},
    'no1': {0: (540.0, 693.5, 30.0, 21.5), 1: (813.0, 692.5, 30.0, 21.5)},
}


def parse_d(d):
    nums = re.findall(r'-?\d+\.?\d*', d)
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums) - 1, 2)]


def to_d(pts):
    return 'M ' + ' L '.join('%g,%g' % (x, y) for x, y in pts) + ' Z'


def poly_mask(pts, W, H):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(np.array(pts)).astype(np.int32)], 1)
    return m


def contours_of(mask, min_area=8):
    cs, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cs:
        if cv2.contourArea(c) < min_area:
            continue
        ap = cv2.approxPolyDP(c, 1.0, True).reshape(-1, 2)
        if len(ap) >= 3:
            out.append(ap)
    return out


def sample_sheet_hex(key, layer):
    """在设定稿上取该层掩膜内的中位色（颜色的事实来源是设定稿，不是描摹量化色）。"""
    if key not in _SHEET_CACHE:
        from PIL import Image as _Im
        _SHEET_CACHE[key] = np.asarray(
            _Im.open('out/AnchorSheetNo%s.png' % key[-1]).convert('RGB')).astype(int)
    sh = _SHEET_CACHE[key]
    H, W = sh.shape[:2]
    m = poly_mask(parse_d(layer['d']), W, H).astype(bool)
    if m.sum() < 20:
        return layer['hex']
    vals = sh[m]
    med = np.median(vals, axis=0).astype(int)
    return '#%02X%02X%02X' % tuple(med)


_SHEET_CACHE = {}


def lum(h):
    return 0.299 * int(h[1:3], 16) + 0.587 * int(h[3:5], 16) + 0.114 * int(h[5:7], 16)


def reclass(key, d):
    tab = RECLASS.get(key)
    if not tab:
        print('   （%s 无重定表，跳过角色重定）' % key)
        return [], 0
    L = {l['id']: l for l in d['layers']}
    for i in list(tab['eye']) + list(tab['brow']) + tab['rim']:
        assert i in L, '角色重定表里的层不存在：%s' % i
    log = []
    for i, side in tab['eye'].items():
        assert L[i]['role'] in (None, 'eye', 'lid', 'iris'), (i, L[i]['role'])
        L[i]['role'] = 'eye'
        L[i]['side'] = side
        L[i]['eye'] = side
        log.append(('%s→eye' % i, L[i]['box']))
    for i, side in tab['brow'].items():
        assert L[i]['role'] in ('brow', 'brow_fill', None), (i, L[i]['role'])
        L[i]['role'] = 'brow'
        L[i]['side'] = side
        log.append(('%s→brow' % i, L[i]['box']))
    for i in tab['rim']:
        L[i]['role'] = 'rim'
        # ⚠ 还色：这些层原被误判成眉毛，trace 阶段把 hex 改成了眉毛色 #2E2620。
        # 改回 role 时必须把颜色一起还原成 id 后缀里的原始色，否则镜框变成
        # 「#26221C + #2E2620 + #555339 三种暗色拼接」——成片里就是脏色块（2026-10-28 老板看到的那层）。
        # 颜色以**设定稿实测**为准，不用 id 后缀：后缀是描摹时的量化色，
        # 镜框有几段被量化成衬衫橄榄 #555339（成片里镜框上出现浅橄榄条）。
        orig = sample_sheet_hex(key, L[i])
        if L[i]['hex'] != orig:
            log.append(('%s 还色 %s→%s' % (i, L[i]['hex'], orig), L[i]['box']))
        L[i]['hex'] = orig     # 无条件按设定稿实测色赋值（id 后缀的量化色不可信）
        log.append(('%s→rim' % i, L[i]['box']))
    # 其余仍带旧 role 的层（如镜框上框残余 brow_fill）按表外一律不动，但要报警
    stray = [(l['id'], l['role']) for l in d['layers']
             if l.get('role') in ('brow', 'brow_fill', 'eye', 'lid', 'iris')
             and l['id'] not in tab['eye'] and l['id'] not in tab['brow']
             and l['id'] not in tab['rim']]
    # 重算 eyes[]：用真眼层
    eyes = []
    for side in (0, 1):
        ls = [L[i] for i, s in tab['eye'].items() if s == side]
        b = ls[0]['box']
        eyes.append({'cx': (b[0] + b[2]) / 2, 'cy': (b[1] + b[3]) / 2,
                     'w': b[2] - b[0], 'h': b[3] - b[1]})
    d['eyes'] = eyes
    d['brows'] = [{'side': L[i]['side'], 'box': L[i]['box'], 'hex': L[i]['hex']}
                  for i in tab['brow']]
    return log, len(stray), stray


def absorb_eye_region(key, d):
    """把「眼区矩形内的所有深色像素」统一收进眼睛，再从原层里扣掉这部分。

    为什么必须这么做（2026-10-28 根因）：设定稿里**镜框与眼睛上眼线是同一色 #26221C 且相连**，
    描摹按连通块取轮廓 → 一个 c28（镜腿+框）把眼睛的左半段眼线一起包进去（c28 面积 5919，
    bbox x362~598 横跨眼睛所在的 x475~591）。角色重定又把 c28 判成 rim（静态镜框），
    于是**眼睛的左半段被画成了镜框**：实测列厚 设定稿 14~35px / 成片只有 5~7px，
    成片里眼睛看着"细、没肉"、镜框看着"发胖"。
    """
    W, H = d['canvas']
    eyes = d['eyes']
    assert len(eyes) == 2
    regions = []
    for e in eyes:
        x0 = int(e['cx'] - e['w'] / 2) - 8
        x1 = int(e['cx'] + e['w'] / 2) + 8
        y0 = int(e['cy'] - e['h'] / 2) - 8
        y1 = int(e['cy'] + e['h'] / 2) + 8
        R = np.zeros((H, W), np.uint8)
        R[max(0, y0):y1, max(0, x0):x1] = 1
        regions.append(R)

    moved = 0
    for R in regions:
        for l in d['layers']:
            if l['id'].startswith(('patch', 'seam')) or lum(l['hex']) >= 100:
                continue
            # 眼层本身不能被「扣掉」——整只眼都在区域内，扣完成空（实测直接导致
            # 「眼掩膜太窄」断言失败，而且因为管道 grep 掩盖了退出码会静默跳过整步）
            if l.get('role') in ('brow', 'eye'):
                continue
            m = poly_mask(parse_d(l['d']), W, H)
            inside = m & R
            if int(inside.sum()) < 30:
                continue
            outside = m & ~R
            moved += int(inside.sum())
            if int(outside.sum()) < 30:
                l['d'] = 'M 0,0 Z'
                l['box'] = [0, 0, 0, 0]
                l['area'] = 0
                continue
            cons = contours_of(outside, min_area=12)
            l['d'] = ' '.join(to_d(c) for c in cons)
            ys, xs = np.nonzero(outside)
            l['box'] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
            l['area'] = int(outside.sum())
    return moved


def split(key, d):
    W, H = d['canvas']
    eyes = d['eyes']
    assert len(eyes) == 2, 'eyes[] 不对: %r' % (eyes,)
    eye_layers = [l for l in d['layers'] if l.get('role') in ('eye', 'lid', 'iris') and lum(l['hex']) < 150]
    assert eye_layers, '没有深色眼层'

    groups = {0: [], 1: []}
    for l in eye_layers:
        cx = (l['box'][0] + l['box'][2]) / 2
        i = 0 if abs(cx - eyes[0]['cx']) <= abs(cx - eyes[1]['cx']) else 1
        groups[i].append(l)

    new_layers, report = [], []
    for i in (0, 1):
        gl = groups[i]
        assert gl, '第 %d 只眼没有眼层' % i
        M = np.zeros((H, W), np.uint8)
        for l in gl:
            M |= poly_mask(parse_d(l['d']), W, H)
        # 眼区矩形内的深色像素一律属于眼睛（镜框/镜腿被描摹粘连进来的部分已经在
        # absorb_eye_region 里从原层扣掉，只会落在这里，不会重复计入别处）
        R = np.zeros((H, W), np.uint8)
        e = eyes[i]
        R[max(0, int(e['cy'] - e['h'] / 2) - 8):int(e['cy'] + e['h'] / 2) + 8,
          max(0, int(e['cx'] - e['w'] / 2) - 8):int(e['cx'] + e['w'] / 2) + 8] = 1
        dark = np.zeros((H, W), np.uint8)
        for l in d['layers']:
            if l['id'].startswith(('patch', 'seam')) or lum(l['hex']) >= 100:
                continue
            if l.get('role') in ('brow', 'lid', 'iris'):
                continue
            dark |= poly_mask(parse_d(l['d']), W, H)
        M |= (dark & R)
        area0 = int(M.sum())
        # 几何模型（设定稿实测）：眼 = **上眼线弧（带）+ 瞳孔圆**，瞳孔的顶部被眼线挡住。
        # 所以不能「从掩膜里挖最内切圆」——那挖出来的是「被截顶的圆」，直径小一圈，
        # 成片里瞳孔变小、眼线变细、中间漏皮肤（第一版就是这个错）。
        # 做法：
        #   ① 眼线厚度 T = 只有弧的列（薄列）厚度中位数
        #   ② 眼线带 band = 每列从轮廓上沿往下 T 像素 → 整条弧连续，瞳孔背后那段也补上
        #   ③ 可见瞳孔 V = 掩膜 − band（= 设定稿里真正露出来的那块，尺寸完全等于美术画的）
        #   ④ iris = V 的主体（向下外扩 3px 掖进眼线带里，避免移动时露缝）
        #      lid  = band ∪ (掩膜 − iris)   → **静止时 lid∪iris 与设定稿逐像素相同**，
        #            瞳孔在眼线后面滑，眼线永远连续
        colH = M.sum(axis=0)
        nz = colH[colH > 0]
        assert nz.size > 10, '第 %d 只眼掩膜太窄' % i
        # 眼线厚度必须取**瞳孔交界处**的列高，不能取「薄列中位数」：
        # 设定稿里眼线弧在与瞳孔相接处是加粗的（美术的笔触），取薄列会把整条弧做细
        # → 成片里眼睛变成「细线 + 小圆」，老板一眼看出「细节差很多」。
        # 瞳孔几何**自动求**（2026-10-30 S2，替代手量 PUPIL 表）：
        # 眼形掩膜里眼线弧只有 ~7px 厚，瞳孔是唯一"胖"的区域 → 距离变换峰值即瞳孔心与半径。
        # 之前手量 PUPIL 只是因为当时不知道这个不变量；实测两张已有设定稿都能自动求到。
        dt = cv2.distanceTransform(M.astype(np.uint8), cv2.DIST_L2, 5)
        r_core = float(dt.max())
        assert r_core >= 4, '第 %d 只眼找不到瞳孔圆核（r=%.1f）' % (i, r_core)
        cy0, cx0 = np.unravel_index(int(np.argmax(dt)), dt.shape)
        pcx, pcy = float(cx0), float(cy0)
        prx = pry = r_core * 1.18
        px0, px1 = int(pcx - prx), int(pcx + prx)
        flank = [int(colH[x]) for x in list(range(max(0, px0 - 10), max(1, px0))) +
                 list(range(min(W - 1, px1 + 1), min(W, px1 + 11))) if colH[x] > 0]
        assert flank, '第 %d 只眼交界处没有列' % i
        T = float(np.median(flank))
        T = float(min(max(T, 6.0), 30.0))
        # 眼线带厚度沿 x **平滑变化**（中间厚、两端薄）。
        # 用常数 T 会在瞳孔列上横切一条直线，成片 6 倍放大时瞳孔顶边是平的（明显不自然）；
        # 设计稿的笔触本来就是中间粗、两头收。T_x 用 sin 包络，端点取 55%。
        band = np.zeros((H, W), np.uint8)
        xs_band = np.where(colH > 0)[0]
        xa, xb = float(xs_band.min()), float(xs_band.max())
        for x in xs_band:
            ys = np.where(M[:, x])[0]
            t = (x - xa) / max(1e-6, (xb - xa))
            # 端点**不能低于** T：低于 T 时瞳孔会漫进眼线两端的尖角里（实测长宽比 3.30，瞳孔变成扁条）
            Tx = T * (1.0 + 0.35 * math.sin(math.pi * t))
            band[ys.min():int(ys.min() + round(Tx)) + 1, x] = 1
        band &= M

        # 瞳孔 = **眼形里最大的圆核**（距离变换峰值 + 半径），眼线 = 眼形 − 瞳孔。
        # 为什么不用「眼形 − 水平带」：带的下界在瞳孔列上是一条直线/正弦线，会把瞳孔顶边切成
        # 平顶 + 缺口（6 倍放大一眼可见，实测瞳孔顶部有台阶和凹口）。
        # 设计稿里瞳孔是**从眼线底下长出来的圆**：用圆核切，眼线在两端自然保持粗（设计稿正是
        # 两头厚、中间被瞳孔顶住），静止时 lid∪iris 仍与设定稿逐像素相等。
        # dt / r_core / (cx0,cy0) 已在上面自动求过，这里直接用
        disc = np.zeros((H, W), np.uint8)
        cv2.circle(disc, (int(cx0), int(cy0)), int(round(r_core * 1.18)), 1, -1)
        pupil = (disc & M).astype(np.uint8)
        # 掖进眼线 2px：瞳孔横移时边缘不留发丝缝（被 lid 盖住，看不见）
        pupil = cv2.dilate(pupil, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))) & M
        pa = int(pupil.sum())
        assert 0.28 <= pa / max(1, int(M.sum())) <= 0.80, \
            '第 %d 只眼瞳孔占比异常 %.2f' % (i, pa / max(1, int(M.sum())))
        ys_, xs_ = np.nonzero(pupil)
        bw, bh = xs_.max() - xs_.min() + 1, ys_.max() - ys_.min() + 1
        assert 0.60 <= bw / max(1, bh) <= 1.9, '第 %d 只眼瞳孔长宽比异常 %.2f' % (i, bw / max(1, bh))

        hex_best, best_ov = None, -1
        for l in gl:
            ov = int((poly_mask(parse_d(l['d']), W, H) & pupil).sum())
            if ov > best_ov:
                hex_best, best_ov = l['hex'], ov
        assert hex_best and best_ov > 0, '第 %d 只眼取不到瞳孔颜色' % i

        pcs = sorted(contours_of(pupil, min_area=40), key=lambda c: -cv2.contourArea(c))
        assert pcs, '第 %d 只眼瞳孔轮廓为空' % i
        main = pcs[0]
        xs, ys = main[:, 0], main[:, 1]
        iris = {'id': 'iris%d_%s' % (i, hex_best[1:]), 'hex': hex_best,
                'd': to_d([(int(x), int(y)) for x, y in main]),
                'box': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                'area': int(cv2.contourArea(main)), 'role': 'iris', 'side': i, 'eye': i}

        # 眼线 = 眼形 − 瞳孔（设计稿的两头厚、中间被瞳孔顶住的形状原样保留）
        lid_all = (M & (1 - pupil)).astype(np.uint8)
        lid_layers = []
        hexes = sorted({l['hex'] for l in gl}, key=lambda h: -sum(1 for l in gl if l['hex'] == h))
        for k2, hexv in enumerate(hexes):
            G = np.zeros((H, W), np.uint8)
            for l in gl:
                if l['hex'] == hexv:
                    G |= poly_mask(parse_d(l['d']), W, H)
            G = G & (1 - pupil)
            if k2 == 0:
                G = G | lid_all       # 主色组承担整条眼线（同色，不会看出接缝）
            if int(G.sum()) < 20:
                continue
            ccs = contours_of(G, min_area=20)
            if not ccs:
                continue
            pts_all = np.vstack(ccs)
            lid_layers.append({'id': 'lid%d_%s' % (i, hexv[1:]), 'hex': hexv,
                               'd': ' '.join(to_d([(int(x), int(y)) for x, y in c]) for c in ccs),
                               'box': [int(pts_all[:, 0].min()), int(pts_all[:, 1].min()),
                                       int(pts_all[:, 0].max()), int(pts_all[:, 1].max())],
                               'area': int(G.sum()), 'role': 'lid', 'side': i, 'eye': i,
                               'fillRule': 'evenodd'})
        assert lid_layers, '第 %d 只眼没有 lid 层' % i
        report.append((i, area0, pa, 100.0 * pa / area0, iris['box'], iris['area'], [l['id'] for l in lid_layers]))
        # 先 iris 后 lid：眼线压在瞳孔上（瞳孔在眼线后面滑），移开时眼线仍连续
        new_layers.append(iris)
        new_layers.extend(lid_layers)

    old_ids = {l['id'] for l in eye_layers}
    first = min(idx for idx, l in enumerate(d['layers']) if l['id'] in old_ids)
    before = [l for l in d['layers'][:first] if l['id'] not in old_ids]
    rest = [l for l in d['layers'] if l['id'] not in old_ids and l not in before]
    d['layers'] = before + new_layers + rest
    return report


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry = '--dry' in sys.argv
    for key in (args or ['no4']):
        # key 可以是角色名（走 chars/<key>.json），也可以直接给 json 路径（试跑不污染 chars/）
        path = key if ('/' in key or key.endswith('.json')) else CH % key
        d = json.load(open(path, encoding='utf-8'))
        rc = reclass(key, d)
        if rc[0]:
            log, nstray, stray = rc
            print('== %s 角色重定 %d 条' % (key, len(log)))
            for a, b in log:
                print('   %-22s y%4d-%4d x%4d-%4d' % (a, b[1], b[3], b[0], b[2]))
            if nstray:
                print('   ⚠ 表外仍带 role 的层 %d 条: %s' % (nstray, stray))
        moved = absorb_eye_region(key, d)
        if moved:
            print('== %s 眼区吸附：把镜框/镜腿里粘连的眼线摘回眼睛 %d px' % (key, moved))
        rep = split(key, d)
        # ── 断言 ──
        # 眉层底边必须在眼区之上（原来是写死的 no4 数字 645，换角色必假失败；
        # 改成相对眼框，任何角色都成立）
        eye_top = min(e['cy'] - e['h'] / 2 for e in d['eyes'])
        for l in d['layers']:
            if l.get('role') in ('brow', 'brow_fill'):
                assert l['box'][3] < eye_top, \
                    '眉层压到眼区: %s %s（眼顶 %.0f）' % (l['id'], l['box'], eye_top)
        irises = [l for l in d['layers'] if l.get('role') == 'iris']
        assert len(irises) == 2, 'iris 层数 %d' % len(irises)
        for it in irises:
            e = d['eyes'][it['eye']]
            assert it['box'][0] >= e['cx'] - e['w'] / 2 and it['box'][2] <= e['cx'] + e['w'] / 2, \
                'iris 超出眼框: %s %s vs %s' % (it['id'], it['box'], e)
        if not dry:
            bk = path + '.bak-' + datetime.datetime.now().strftime('%d%H%M%S')
            shutil.copy2(path, bk)
            json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
            print('   眼层重建：每眼 1 lid + 1 iris → 写盘（备份 %s）' % bk)
        for i, a0, pa, pct, ib, ia, lids in rep:
            print('   眼%d 原面积 %d → 瞳孔 %d (%.0f%%) box%s area%d | lid %s'
                  % (i, a0, pa, pct, ib, ia, lids))
        print('   eyes[] =', [(round(e['cx'], 1), round(e['cy'], 1), e['w'], e['h']) for e in d['eyes']])


if __name__ == '__main__':
    main()
