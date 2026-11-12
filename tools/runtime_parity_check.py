#!/usr/bin/env python3
"""零依赖 SVG 运行时的视觉等价校验（突破路线 P0 的验收断言）。

主判据（同管线，严格逐像素）
--------------------------------
  out/{char}-grid.png              remotion still VisemeGrid   → React 直接渲染 <FaceTraced/>
  out/runtime/parity-runtime-grid.png  remotion still RuntimeGrid → 注入 renderFaceSvg() 的 SSR 字符串

两张图都经同一 Remotion CLI、同一 Chrome 实例类型、同一 CDP 截图管线输出，
页面骨架与 CSS 由 `RuntimeGrid.tsx` 精确复刻 `VisemeGrid.tsx`，
唯一变量是「SVG 由 React DOM 生成」还是「由 SSR 字符串注入」。
逐像素完全一致 ⇒ 同一个渲染器脱离 Remotion 后视觉零漂移，无需维护第二份渲染器。

为什么不能拿独立 HTML 的截图去和 Remotion 图逐像素比
--------------------------------------------------
排查过程中确认了两个真实根因，会伪造出「渲染不等价」：
  1. Remotion 注入全局 `* { box-sizing: border-box }`（remotion/dist/cjs/default-css.js）。
     独立页面若用默认 content-box，每格 1px 边框外扩、裁剪区错 1px。
  2. Remotion 走 openBrowser 启动的 Chrome + CDP Page.captureScreenshot(
     fromSurface:true, optimizeForSpeed:true)，且启动参数没有 --disable-gpu；
     chrome --headless --screenshot --disable-gpu 是另一条光栅路径。
即使把这两处都复刻（tools/runtime/screenshot.mjs 就是复刻版），
独立页面仍会与 Remotion 图产生约 5.7% 的 ±1～2 通道差异、>16 的大差异
100% 落在颜色边界上 —— 来自不同页面合成层的 Skia 舍入，不是内容错位。
因此跨管线对比只作报告（`--cross-check`），不作判定。

用法
----
  node tools/runtime/export.mjs --char noF        # 先生成 parity-props.json
  python tools/runtime_parity_check.py --char noF
  python tools/runtime_parity_check.py --char noF --cross-check   # 附带跨管线报告
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from codeavatar import remotion  # noqa: E402

PROPS = ROOT / 'out' / 'runtime' / 'parity-props.json'
SHOT = ROOT / 'out' / 'runtime' / 'parity-runtime-grid.png'
GRID_PAGE = ROOT / 'out' / 'runtime' / 'parity-grid.html'
CROSS_SHOT = ROOT / 'out' / 'runtime' / 'parity-ssr-grid.png'
CHROME = ROOT / 'node_modules' / '.remotion' / 'chrome-headless-shell' / 'win64' / 'chrome-headless-shell-win64' / 'chrome-headless-shell.exe'


def stats(ref: Path, got: Path) -> int:
    """打印两图的逐像素统计，返回差异像素数。"""
    from PIL import Image
    import numpy as np

    a = np.asarray(Image.open(ref).convert('RGB')).astype('int16')
    b = np.asarray(Image.open(got).convert('RGB')).astype('int16')
    if a.shape != b.shape:
        sys.exit(f'尺寸不一致：{a.shape} vs {b.shape}')
    d = np.abs(a - b).max(axis=2)
    H, W = d.shape
    n = int((d > 0).sum())
    print(f'  {ref.name} {W}x{H} · 差异 {n}/{W * H} ({n / (W * H) * 100:.3f}%) · 最大通道差 {int(d.max())}')
    if not n:
        return 0
    for i in range(6):
        y0, y1 = (i // 3) * 800, (i // 3 + 1) * 800
        x0, x1 = (i % 3) * 640, (i % 3 + 1) * 640
        cell = d[y0:y1, x0:x1]
        print(f'    格 {i} ({"MAOEIU"[i]}): {int((cell > 0).sum())} px / 最大差 {int(cell.max())}')
    for t in (2, 8, 16, 32):
        print(f'    >{t:2d}: {int((d > t).sum())} px ({(d > t).mean() * 100:.3f}%)')
    return n


def cross_check(ref: Path) -> None:
    """独立 HTML 截图：只记录跨管线差异，不参与 PASS/FAIL。"""
    if not GRID_PAGE.exists():
        print('  跳过跨管线报告：缺少 parity-grid.html')
        return
    if not CHROME.exists():
        print('  跳过跨管线报告：缺少 headless Chrome')
        return
    cmd = [
        str(CHROME), '--headless', '--disable-gpu', '--no-sandbox',
        '--hide-scrollbars', '--force-device-scale-factor=1',
        '--window-size=1920,1600', f'--screenshot={CROSS_SHOT}',
        GRID_PAGE.as_uri(),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if not CROSS_SHOT.exists() or CROSS_SHOT.stat().st_size == 0:
        print(f'  跨管线截图失败：{r.stderr[-300:]}')
        return
    print('\n跨管线报告（独立 HTML 直接截图，仅记录不判定）：')
    stats(ref, CROSS_SHOT)
    print('  说明：页面合成层不同会产生 Skia 舍入差异，见本文件顶部注释。')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', default='noF')
    ap.add_argument('--ref', default=None)
    ap.add_argument('--cross-check', action='store_true')
    args = ap.parse_args()

    ref = Path(args.ref) if args.ref else ROOT / 'out' / f'{args.char}-grid.png'
    if not ref.exists():
        sys.exit(f'缺少参考图 {ref}：先跑 python tools/codeavatar.py grid {args.char}')
    if not PROPS.exists():
        sys.exit(f'缺少 {PROPS}：先跑 node tools/runtime/export.mjs --char {args.char}')

    print('同管线 parity：Remotion still RuntimeGrid（注入 SSR SVG 字符串）')
    remotion('still', 'RuntimeGrid', str(SHOT), '--props', str(PROPS), '--log=error')
    print('\n参考（React 直接渲染 FaceTraced）:')
    n = stats(ref, SHOT)

    if n == 0:
        print('\nPASS：逐像素完全一致 · SSR 字符串与 React DOM 视觉等价，运行时零漂移 ✓')
    else:
        print('\nFAIL：SSR 字符串与 React DOM 存在像素差异，运行时不等价')
    if args.cross_check:
        cross_check(ref)
    return 0 if n == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
