"""查「某个像素最终由哪一层决定」：按绘制顺序取最后一个覆盖该点的层。

用途：渲染结果里颜色不对时，不要再靠猜——直接问数据"这一点是谁画的"。
用法：python3 tools/which_layer.py <x> <y> [<x> <y> ...]
"""
import json
import re
import sys

import numpy as np

P = "/H/.hermes/workspace/autocut/refs/dhk/src/anchor-code/traced.json"


def subpaths(d):
    out = []
    for seg in re.findall(r"M[^M]+", d):
        nums = list(map(float, re.findall(r"-?\d+\.?\d*", seg)))
        pts = list(zip(nums[0::2], nums[1::2]))
        if len(pts) >= 3:
            out.append(np.array(pts))
    return out


def inside(poly, x, y):
    n = len(poly)
    j = n - 1
    c = False
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            c = not c
        j = i
    return c


def main():
    data = json.load(open(P))
    layers = data["layers"]
    args = list(map(float, sys.argv[1:]))
    for k in range(0, len(args), 2):
        x, y = args[k], args[k + 1]
        hits = []
        for i, l in enumerate(layers):
            b = l["box"]
            if not (b[0] - 2 <= x <= b[2] + 2 and b[1] - 2 <= y <= b[3] + 2):
                continue
            for poly in subpaths(l["d"]):
                if inside(poly, x, y):
                    hits.append((i, l["hex"], l.get("role"), l["area"]))
                    break
        print(f"\n点 ({x:.0f},{y:.0f}) 被 {len(hits)} 层覆盖，绘制顺序由早到晚：")
        for i, hx, role, area in hits[-5:]:
            print(f"   #{i:<3d} {hx}  role={role or '-':10s} area={area}")


if __name__ == "__main__":
    main()
