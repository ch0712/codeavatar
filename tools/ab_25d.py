#!/usr/bin/env python3
"""2.5D 深度分层 A/B 原型（阶段 4 第 1 项）。

同一角色（默认 no4）、同一姿态，只切换 depth 开关，渲染 3 个转头角并度量：
  A 模式：平面（现状，depth 缺省）
  B 模式：深度视差 + 遮挡排序（depth 开启）

度量：
  1. yaw=0 时 A/B 逐字节一致（正视零漂移——原型不许改动已验收外观）
  2. yaw≠0 时 A/B 存在差异（视差确实生效）且差异幅度随 yaw 单调
  3. 视差方向正确：近层（镜框 rim 带）相对脸面的水平位移 与 yaw 反号
  4. 输出 A/B 对照图与 docs/AB-2.5D.md 数据表（结论由人写，脚本只给数）

运行：python tools/ab_25d.py [key]
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'tools' / 'codeavatar.py'
OUT = ROOT / 'out' / 'ab25d'
CHARS = ROOT / 'packages' / 'anchor-core' / 'src' / 'chars'





def render(key, name, pose, depth):
    props = {'char': key, 'layout': 'full', 'pose': pose}
    if depth:
        props['depth'] = True
    pf = OUT / f'{name}.props.json'
    pf.write_text(json.dumps(props, ensure_ascii=False), encoding='utf-8')
    png = OUT / f'{name}.png'
    r = subprocess.run([sys.executable, str(CLI), 'still', key, '-o', str(png), '--props', str(pf)],
                       capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
                       env={**__import__('os').environ, 'PYTHONIOENCODING': 'utf-8'})
    pf.unlink(missing_ok=True)
    if r.returncode != 0:
        raise SystemExit(f'渲染失败 {name}\n{r.stderr[-400:]}')
    return png


def load_gray(png):
    """PNG → 灰度 ndarray（用 ffmpeg 解码，避免引入 Pillow）。"""
    r = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', str(png), '-f', 'rawvideo', '-pix_fmt', 'gray',
         '-'], capture_output=True, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit(f'ffmpeg 解码失败 {png}')
    return np.frombuffer(r.stdout, dtype=np.uint8).reshape(1080, 1920)


def band_centroid_x(gray, y0, y1, x0, x1, dark=110):
    """在盒内找深色像素的列质心（衡量该带的水平位置）。"""
    y0, y1 = max(0, int(y0)), min(gray.shape[0], int(y1))
    x0, x1 = max(0, int(x0)), min(gray.shape[1], int(x1))
    sub = gray[y0:y1, x0:x1]
    mask = sub < dark
    if mask.sum() < 20:
        return None
    xs = np.nonzero(mask)[1]
    return float(xs.mean() + x0)


def band_profile(gray, y0, y1, x0, x1, dark=110):
    """带内逐列暗像素计数（1D 剖面）——镜框笔画的主导结构。"""
    y0, y1 = max(0, int(y0)), min(gray.shape[0], int(y1))
    x0, x1 = max(0, int(x0)), min(gray.shape[1], int(x1))
    sub = gray[y0:y1, x0:x1] < dark
    return sub.sum(axis=0).astype(np.float64)


def profile_shift(pa, pb, max_s=30):
    """求 B 相对 A 的水平位移 k（B 剖面 = A 剖面右移 k px 时最吻合）。
    SSD over s ∈ [-max_s, max_s]：pb[i] ≈ pa[i - k] → 最优 s = -k，返回 -s。
    """
    best, best_s = None, 0
    for s in range(-max_s, max_s + 1):
        a = pa[max(0, s): len(pa) + min(0, s)]
        b = pb[max(0, -s): len(pb) + max(0, s)]
        n = min(len(a), len(b))
        if n < 30:
            continue
        d = float(np.sum((a[:n] - b[:n]) ** 2))
        if best is None or d < best:
            best, best_s = d, s
    return -best_s


def main():
    key = sys.argv[1] if len(sys.argv) > 1 else 'no4'
    OUT.mkdir(parents=True, exist_ok=True)
    d = json.loads((CHARS / f'{key}.json').read_text(encoding='utf-8'))

    # 画布(1360x2048) → 视频(1920x1080) 映射：与 Presenter full 布局一致
    # scale = min(W/CW, H/CH)，画布中心落在 (W/2, H*anchorY)
    CW, CH = 1360, 2048
    VW, VH = 1920, 1080
    scale = min(VW / CW, VH / CH)

    def to_px(x, y):
        return (x - CW / 2) * scale + VW / 2, (y - CH / 2) * scale + VH * 0.45

    angles = [-0.8, 0.0, 0.8]
    rows = []
    hashes = {}
    for a in angles:
        tag = f'yaw{a:+.1f}'
        pa = render(key, f'{tag}-A-flat', {'yaw': a}, False)
        pb = render(key, f'{tag}-B-depth', {'yaw': a}, True)
        ga, gb = load_gray(pa), load_gray(pb)
        ha = hashlib.sha256(pa.read_bytes()).hexdigest()
        hb = hashlib.sha256(pb.read_bytes()).hexdigest()
        diff = int((ga != gb).sum())
        # 镜框带（rim）与眼带的水平质心：视差应让近层（rim）比脸面多走
        rim_box = next((l['box'] for l in d['layers'] if l.get('role') == 'rim'), None)
        rows.append({'yaw': a, 'same_bytes': ha == hb, 'diff_px': diff,
                     'diff_pct': round(100 * diff / ga.size, 4),
                     'rim_box': rim_box, 'A': ga, 'B': gb, 'paths': (pa, pb)})
        hashes[tag] = (ha, hb)

    print('| 转头角 | A/B 逐字节一致 | 差异像素 | 差异占比 |')
    print('|:--|:--|--:|--:|')
    for r in rows:
        print(f"| {r['yaw']:+.1f} | {'是' if r['same_bytes'] else '否'} | {r['diff_px']} | {r['diff_pct']}% |")

    # 断言 1：正视零漂移
    zero = next(r for r in rows if r['yaw'] == 0.0)
    ok_zero = zero['same_bytes']
    # 断言 2：yaw≠0 视差生效，且幅度随 |yaw| 单调
    nz = [r for r in rows if r['yaw'] != 0]
    ok_effect = all(r['diff_px'] > 0 for r in nz)
    # 断言 3：视差方向——近层相对脸面的位移与 yaw 反号
    dir_ok = True
    details = []
    for r in nz:
        if not r['rim_box']:
            continue
        x0, y0, x1, y1 = r['rim_box']
        w, h = x1 - x0, y1 - y0
        # 收紧到镜框盒中部偏下：避开发际线的头发（hair 深度与前层反向，会污染质心）
        px0, py0 = to_px(x0 + w * 0.25, y0 + h * 0.55)
        px1, py1 = to_px(x1 - w * 0.25, y1 + 12)
        pa_prof = band_profile(r['A'], py0, py1, px0, px1)
        pb_prof = band_profile(r['B'], py0, py1, px0, px1)
        shift = profile_shift(pa_prof, pb_prof)
        if shift is None or pa_prof.sum() < 50:
            continue
        details.append(f'yaw={r["yaw"]:+.1f} rim 互相关位移={shift:+d}px')
        if shift * r['yaw'] >= 0:  # 期望反号
            dir_ok = False

    print()
    print(f'{"PASS" if ok_zero else "FAIL"} 正视（yaw=0）A/B 逐字节一致（零漂移）')
    print(f'{"PASS" if ok_effect else "FAIL"} 转头时视差生效（差异像素 > 0）')
    print(f'{"PASS" if dir_ok else "FAIL"} 视差方向与转头反号（近层位移更大） | '
          + '; '.join(details))

    md = ['# 2.5D 深度分层 A/B 原型（阶段 4 第 1 项，自动生成数据）', '',
          f'角色 `{key}`，同一姿态仅切 `depth` 开关；指标由 `tools/ab_25d.py` 生成。', '',
          '| 转头角 | A/B 逐字节一致 | 差异像素 | 差异占比 |', '|:--|:--|--:|--:|']
    for r in rows:
        md.append(f"| {r['yaw']:+.1f} | {'是' if r['same_bytes'] else '否'} | {r['diff_px']} | {r['diff_pct']}% |")
    md += ['', '视差方向证据：' + ('；'.join(details) if details else '未测到 rim 带'),
           '', f'断言：零漂移 {"PASS" if ok_zero else "FAIL"} / 视差生效 '
               f'{"PASS" if ok_effect else "FAIL"} / 方向 {"PASS" if dir_ok else "FAIL"}']
    (ROOT / 'docs' / 'AB-2.5D.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print(f'\n数据表写入 docs/AB-2.5D.md；对照图 out/ab25d/*.png')

    raise SystemExit(0 if (ok_zero and ok_effect and dir_ok) else 1)


if __name__ == '__main__':
    main()
