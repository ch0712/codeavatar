"""本轮打磨（数据层，不改代码）：
  ① 门襟描摹线 c15_26221C 颜色 #26221C（近黑，成片里像一道划痕）→ 衬衫同色系暗一档 #45442E
  ② 发际线那根细竖条：c32（头发多边形）在 x∈[690,720] 处往下探到 y≈407，
     与两侧发际（y≈374~395）形成一根 10px 宽、27px 深的细楔子 → 抬回 y=374（只动这一小段）
做法：只改 src/anchor-code/chars/no4.json，先备份。
"""
import json, re, shutil, datetime, sys
import os as _os
_CHARS_DIR = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "packages", "anchor-core", "src", "chars",
)

P = _os.path.join(_CHARS_DIR, 'no4.json')
bk = P + '.bak-' + datetime.datetime.now().strftime('%d%H%M%S')
shutil.copy2(P, bk)
d = json.load(open(P, encoding='utf-8'))
L = {l['id']: l for l in d['layers']}

# ① 门襟线
c15 = L['c15_26221C']
assert c15['hex'] == '#26221C', c15['hex']
c15['hex'] = '#45442E'

# ② 发际线下探的细楔子
c32 = L['c32_26221C']
nums = re.findall(r'-?\d+(?:\.\d+)?', c32['d'])
assert len(nums) % 2 == 0, len(nums)
pts = [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums), 2)]
CLAMP_Y = 374.0
hit = 0
for i, (x, y) in enumerate(pts):
    if 688 <= x <= 722 and 376 < y < 415:
        pts[i] = (x, CLAMP_Y)
        hit += 1
assert hit > 0, '没找到要夹的点，别乱写'

# 重拼 d（保留闭合 Z）
body = ' '.join(
    ('M' if i == 0 else 'L') + ' %g,%g' % (x, y) for i, (x, y) in enumerate(pts)
)
c32['d'] = body + ' Z'

# 重算 c32 的 bbox（高度会略变小）
xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
c32['box'] = [min(xs), min(ys), max(xs), max(ys)]

json.dump(d, open(P, 'w', encoding='utf-8'), ensure_ascii=False)
print('backup', bk)
print('c15 hex ->', c15['hex'], '| c32 clamped points:', hit, '| new box', [round(v, 1) for v in c32['box']])
