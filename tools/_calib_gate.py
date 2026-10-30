"""标定「设计稿合规闸门」的阈值：在 4 张已知图（2 张已验收 + 2 张候选）上量指标。"""
import sys
import numpy as np
from PIL import Image

SHEETS = {
    'no4(已验收)': 'anchor-code/cand/3-38b3bec7-e67a-467c-8c5a-849430170bfa.png',
    'no1(已验收)': 'anchor-code/cand/6-6103d9bb-367e-4616-977c-b6f89a33e30b.png',
    '候选4(可描摹)': 'anchor-code/cand/1-c4dc7c2d-c9cb-4adb-9768-4ee448be3a93.png',
    '候选1(不合规)': 'anchor-code/cand/1-c1b9f143-1bf2-4c31-ac93-0626035a94f1.png',
}

print(f"{'图':14s} {'尺寸':12s} {'K14量化误差':>10s} {'唯一色':>8s} {'胶片感(高频)':>10s}")
for name, p in SHEETS.items():
    im = Image.open(p).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    H, W = a.shape[:2]
    q = np.asarray(im.quantize(colors=14, method=Image.MEDIANCUT).convert('RGB')).astype(np.int16)
    err = float(np.abs(a - q).mean())
    # 唯一色（8 档分桶，避免抗锯齿噪声把颜色数撑爆）
    binned = (a // 16)
    uniq = len(np.unique(binned.reshape(-1, 3), axis=0))
    # 高频能量：Sobel 幅度均值（扁平硬边 = 少量强边；柔光渐变 = 大量弱边）
    g = a.mean(axis=2)
    gx = np.abs(np.diff(g, axis=1)).mean()
    gy = np.abs(np.diff(g, axis=0)).mean()
    print(f"{name:14s} {W}x{H:<7d} {err:10.2f} {uniq:8d} {(gx+gy)/2:10.2f}")
