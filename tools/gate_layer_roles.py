"""层角色闸门（数据级）：渲前就能拦住「眉毛拖着镜框动」「眼睛没有可动瞳孔」这一类错。

背景：2026-10-28 老板看片指出——抬眉时镜框上沿跟着抬、眼睛全程不动。
两处都是**层角色判错**（镜框带被标成 brow、眼线+瞳孔一团标成 eye 而没有 iris），
而当时的闸门只查字幕/口型/构图，不查「哪一层允许动」。这里把判据补上。

判据（任一不满足 → 非 0 退出，不出片）：
  G1  每只眼恰好 1 个 iris 层、≥1 个 lid 层；iris 的 bbox 完全落在该眼框内
  G2  **动层与静止镜框零重叠**：brow/lid/iris 的像素 ∩ rim 层像素 = 0
  G3  **眉与镜框必须脱开**：每个 brow 层 bbox 的下沿，至少低于镜框带上沿 3px 之上
  G4  **视线必须真能动**：增益 × 脸宽 ≥ 6 设定稿px，且位移上限不超过瞳孔到眼线外端余量
  G5  镜片下沿/镜腿等不得带可动角色（eye/lid/iris/brow 残留在 rim 带里 → 眨眼会把镜框压扁）

用法：python3 tools/gate_layer_roles.py [no1 no4 ...]
"""
import json
import re
import sys

import cv2
import numpy as np

import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)
CH = _os.path.join(_CHARS_DIR, '%s.json')
GAZE_GAIN_X = 0.012   # FaceTraced.tsx 里的 gazeX 增益（脸宽的比例），改那边要同步这里
MIN_GAZE_PX = 6.0     # 成片可辨的最小瞳孔位移（设定稿 px）
BROW_RIM_GAP = 3.0    # 眉下沿与镜框带上沿的最小间隙


def parse_d(d):
    nums = re.findall(r'-?\d+\.?\d*', d)
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums) - 1, 2)]


def mask_of(l, W, H):
    m = np.zeros((H, W), np.uint8)
    for s in [s for s in l['d'].split(' Z ') if len(parse_d(s)) >= 3]:
        mm = np.zeros((H, W), np.uint8)
        cv2.fillPoly(mm, [np.round(np.array(parse_d(s))).astype(np.int32)], 1)
        m ^= mm  # even-odd：lid 的路径带内洞
    return m


def check(key):
    d = json.load(open(CH % key, encoding='utf-8'))
    W, H = d['canvas']
    L = d['layers']
    eyes = d['eyes']
    errs, notes = [], []

    # ── G1 眼层结构 ──
    irises = [l for l in L if l.get('role') == 'iris']
    lids = [l for l in L if l.get('role') in ('lid', 'eye')]
    if len(irises) != 2:
        errs.append('G1 iris 层应为 2，实际 %d' % len(irises))
    if not lids:
        errs.append('G1 没有 lid/eye 层')
    for it in irises:
        e = eyes[it['eye']]
        if not (it['box'][0] >= e['cx'] - e['w'] / 2 and it['box'][2] <= e['cx'] + e['w'] / 2):
            errs.append('G1 %s 超出眼框 %s' % (it['id'], it['box']))
    notes.append('iris %d / lid %d' % (len(irises), len(lids)))

    # ── G2 动层 ∩ 镜框 = 0 ──
    rim = [l for l in L if l.get('role') == 'rim']
    rim_mask = np.zeros((H, W), np.uint8)
    for l in rim:
        rim_mask |= mask_of(l, W, H)
    if not rim:
        notes.append('无 rim 层（该角色镜框不参与深色层判定）')
    else:
        for l in L:
            if l.get('role') not in ('brow', 'brow_fill', 'iris', 'lid', 'eye'):
                continue
            ov = int((mask_of(l, W, H) & rim_mask).sum())
            if ov > 0:
                errs.append('G2 动层 %s(%s) 与镜框重叠 %d px' % (l['id'], l.get('role'), ov))
    notes.append('rim %d 层 %d px' % (len(rim), int(rim_mask.sum())))

    # ── G3 眉与镜框脱开 ──
    if rim:
        rim_top = min(l['box'][1] for l in rim if l['box'][1] > 550) if any(
            l['box'][1] > 550 for l in rim) else min(l['box'][1] for l in rim)
        for l in L:
            if l.get('role') in ('brow', 'brow_fill'):
                gap = rim_top - l['box'][3]
                if gap < BROW_RIM_GAP:
                    errs.append('G3 眉层 %s 下沿 %.0f 与镜框带上沿 %.0f 只差 %.1fpx'
                                % (l['id'], l['box'][3], rim_top, gap))
        notes.append('眉-镜框间隙 %.1fpx' % (min([rim_top - l['box'][3] for l in L
                                                 if l.get('role') in ('brow', 'brow_fill')] or [0])))

    # ── G4 视线可达性 ──
    faceW = d['skinBox'][2] - d['skinBox'][0]
    gx = GAZE_GAIN_X * faceW
    if gx < MIN_GAZE_PX:
        errs.append('G4 视线位移上限 %.1fpx < 门槛 %.1fpx（眼睛会像冻住）' % (gx, MIN_GAZE_PX))
    for it in irises:
        e = eyes[it['eye']]
        room = (e['w'] / 2) - (it['box'][2] - it['box'][0]) / 2
        if gx > room:
            errs.append('G4 %s 位移 %.1f > 到眼线外端余量 %.1f（会顶出眼线）' % (it['id'], gx, room))
        notes.append('眼%d 位移上限 %.1f / 余量 %.1f' % (it['eye'], gx, room))

    # ── G6 眉必须在眼上方（不依赖 rim 是否标对）──
    #   这一条是「眉毛拖着镜框」的兜底判据：镜框再被误标成 brow，它也会掉到眼睛上方以下。
    eye_top = min(e['cy'] - e['h'] / 2 for e in eyes)
    for l in L:
        if l.get('role') in ('brow', 'brow_fill'):
            if l['box'][3] > eye_top - 20:
                errs.append('G6 眉层 %s 下沿 %.0f 探到眼睛上沿 %.0f 附近（镜框被当眉毛了）'
                            % (l['id'], l['box'][3], eye_top))

    # ── G5 rim 带里不许残留可动角色 ──
    if rim:
        low = [l for l in L if l.get('role') in ('eye', 'lid', 'iris')
               and l['box'][1] > (d['eyes'][0]['cy'] + d['eyes'][0]['h'] / 2 + 6)]
        for l in low:
            errs.append('G5 %s 在眼睛下方却被标成可动层（眨眼会压坏镜框/脸颊）' % l['id'])

    print('== %s  %s' % (key, ' | '.join(notes)))
    if errs:
        for e in errs:
            print('   ✗ %s' % e)
        return False
    print('   ✓ G1~G5 全过')
    return True


if __name__ == '__main__':
    keys = sys.argv[1:] or ['no1', 'no4']
    ok = all(check(k) for k in keys)
    sys.exit(0 if ok else 1)
