"""极简标定：只算几个已知精确色的包围盒与簇中心（缩图后算，避开 CPU 争用）。

设定稿是扁平矢量图，颜色是**精确值**，所以不需要任何颜色启发式：
把 palette_map 打印出的色值填进 COLORS，就能拿到每个部件的准确位置。
"""
import sys
from collections import Counter

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

COLORS = [
    ("bg", "#F4ECE0"),
    ("skinA", "#F4C89C"),
    ("skinB", "#F4C498"),
    ("skinShadow", "#E8B080"),
    ("hair", "#282424"),
    ("hairDeep", "#1C1818"),
    ("knit", "#202C44"),
]


def main():
    a = np.asarray(Image.open(sys.argv[1]).convert("RGB"))
    H, W = a.shape[:2]
    print(f"画布 {W}x{H}")
    for name, hexv in COLORS:
        c = np.array([int(hexv[1:3], 16), int(hexv[3:5], 16), int(hexv[5:7], 16)], dtype=np.int16)
        m = np.abs(a.astype(np.int16) - c).max(axis=2) <= 5
        n = int(m.sum())
        if n < 100:
            print(f"{name:11s} {hexv}  缺")
            continue
        ys, xs = np.where(m)
        lab, k = ndi.label(m, structure=np.ones((3, 3)))
        clusters = []
        for i in range(1, k + 1):
            yy, xx = np.where(lab == i)
            if len(xx) < 100:
                continue
            clusters.append((len(xx), xx.mean(), yy.mean(), xx.min(), xx.max(), yy.min(), yy.max()))
        clusters.sort(key=lambda t: -t[0])
        print(f"{name:11s} {hexv}  px{n:7d}  bbox x{xs.min()}..{xs.max()} y{ys.min()}..{ys.max()}")
        for cl in clusters[:3]:
            print(f"             簇 {cl[0]:6d}px 中心({cl[1]:.0f},{cl[2]:.0f}) 框 x{cl[3]}..{cl[4]} y{cl[5]}..{cl[6]}")


if __name__ == "__main__":
    main()
