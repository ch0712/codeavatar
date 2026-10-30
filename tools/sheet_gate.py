"""设计稿合规闸门：在描摹之前回答「这张图能不能自动出角色」。

为什么需要：不合规的图现在的表现是 `trace_design.py` 里某处 assert 崩掉（例如
「配对失败：只找到 0 对疑似眉/眼块」），看不出是「稿子不合格」还是「描摹器有 bug」。
闸门把不可用的稿子在**第一步**挡住，并说清差哪一条。

四道判据（阈值都在 4 张已知稿上标定过，见 `_calib_gate.py`）：

| # | 判据 | 阈值 | 依据 |
|:--|:--|:--|:--|
| 1 | 尺寸 | 1360x2048（±6%） | 全部脚本的坐标常量都按这个画布标定 |
| 2 | 扁平度 | K=14 量化误差 ≤ 8、唯一色 ≤ 800 | 已验收 no4 1.32/260、no1 1.83/264；有渐变的稿会显著升高 |
| 3 | 眉/眼可配对 | 必须有 2 对镜像宽扁深色块 | 分区算法的基础；镜框/头发是被「高>0.05H」排除的巨块 |
| 4 | 唇可定位 | 深色唇线 或 比皮肤更红的块 | 嘴部参数化的基准点 |

用法：
  python3 tools/sheet_gate.py <设定稿.png> [更多图...]
  退出码 0 = 全部 PASS；1 = 至少一张 FAIL
"""
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from zone_auto import ZoneError, detect_zones  # noqa: E402

WANT_W, WANT_H = 1360, 2048
MAX_QUANT_ERR = 8.0
MAX_UNIQ = 800


def check(path):
    """返回 [(项目, 结论, 说明)]，以及总判定。"""
    rows = []
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    H, W = a.shape[:2]

    # 1 尺寸
    dw, dh = abs(W - WANT_W) / WANT_W, abs(H - WANT_H) / WANT_H
    if dw <= 0.06 and dh <= 0.06:
        rows.append(('尺寸', True, f'{W}x{H}'))
    else:
        rows.append(('尺寸', False, f'{W}x{H}，要求 {WANT_W}x{WANT_H}（±6%）'))

    # 2 扁平度
    q = np.asarray(im.quantize(colors=14, method=Image.MEDIANCUT).convert('RGB')).astype(np.int16)
    err = float(np.abs(a - q).mean())
    uniq = len(np.unique((a // 16).reshape(-1, 3), axis=0))
    ok_flat = err <= MAX_QUANT_ERR and uniq <= MAX_UNIQ
    rows.append(('扁平度', ok_flat, f'K14 误差 {err:.2f}（≤{MAX_QUANT_ERR}）· 唯一色 {uniq}（≤{MAX_UNIQ}）'))

    # 3/4 可定位性（眉/眼配对 + 唇）
    try:
        Z, meta = detect_zones(path)
        rows.append(('眉/眼可配对', True,
                     f'眉 cy{meta["brow_pair_cy"]:.0f} · 眼 cy{meta["eye_pair_cy"]:.0f}'))
        rows.append(('唇可定位', True, f'{meta["mouth_src"]} → {meta["mouth_box"]}'))
    except ZoneError as e:
        rows.append(('眉/眼可配对', False, str(e)))
    except Exception as e:                                    # noqa: BLE001
        rows.append(('可定位性', False, f'{type(e).__name__}: {e}'))

    return rows


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    bad = 0
    for path in sys.argv[1:]:
        print(f'\n=== {path.split("/")[-1]} ===')
        rows = check(path)
        for name, ok, note in rows:
            print(f'  {"✅" if ok else "❌"} {name:10s} {note}')
        verdict = all(ok for _, ok, _ in rows)
        if not verdict:
            bad += 1
        print(f'  → {"PASS 可以描摹" if verdict else "FAIL 换稿或人工补层后再来"}')
    sys.exit(0 if bad == 0 else 1)


if __name__ == '__main__':
    main()
