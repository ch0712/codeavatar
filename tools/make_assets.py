#!/usr/bin/env python3
"""生成 README / 落地页用的视觉资产（可重复生成，产物入库）。

  python tools/make_assets.py --char noF

产物：
  docs/assets/talk.gif   六格口型循环动图，证明「角色真的会动」
  docs/assets/hero.png   1200×480 横幅：主张 + 角色三态

素材只来自 `out/{char}-grid.png`（由 codeavatar grid 渲染的六格口型表），
不引入新的人工素材，也不改动任何角色数据。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'docs' / 'assets'
CW, CH = 640, 800
ORDER = 'MAOEIU'

BG = '#141117'
INK = '#F5F1EA'
MUTED = '#A49CA6'
ACCENT = '#D4705A'
LINE = '#2A2630'


def fonts() -> tuple[ImageFont.FreeTypeFont, ...]:
    """中文字体优先微软雅黑；缺字体时退回 PIL 默认（英文仍可读）。"""
    candidates = [
        Path('C:/Windows/Fonts/msyhbd.ttc'),
        Path('/System/Library/Fonts/PingFang.ttc'),
        Path('/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc'),
    ]
    regular = [
        Path('C:/Windows/Fonts/msyh.ttc'),
        Path('/System/Library/Fonts/PingFang.ttc'),
        Path('/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'),
    ]
    def pick(paths, size, fallback):
        for p in paths:
            if p.exists():
                return ImageFont.truetype(str(p), size)
        return fallback(size)
    fb = ImageFont.load_default
    return (
        pick(candidates, 42, lambda s: fb(size=s)),
        pick(candidates, 20, lambda s: fb(size=s)),
        pick(regular, 17, lambda s: fb(size=s)),
        pick(regular, 14, lambda s: fb(size=s)),
        pick(candidates, 16, lambda s: fb(size=s)),
    )


def cell_images(grid: Image.Image) -> list[Image.Image]:
    return [
        grid.crop(((i % 3) * CW, (i // 3) * CH, (i % 3 + 1) * CW, (i // 3 + 1) * CH))
        for i in range(6)
    ]


def make_gif(cells: list[Image.Image]) -> Path:
    ASSETS.mkdir(parents=True, exist_ok=True)
    out = ASSETS / 'talk.gif'
    size = (320, 400)
    shots = [c.resize(size, Image.LANCZOS).convert('RGB') for c in cells]
    # 每格停 2 帧放慢节奏，末尾回闭口，循环时不会突跳
    seq: list[Image.Image] = []
    for s in shots + [shots[0]]:
        seq.extend([s, s])
    seq[0].save(
        out, save_all=True, append_images=seq[1:],
        duration=130, loop=0, optimize=True, disposal=2,
    )
    return out


def make_hero(cells: list[Image.Image]) -> Path:
    f_title, f_sub, f_body, f_small, f_badge = fonts()
    W, H = 1200, 480
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # 左：主张
    d.text((48, 62), 'AVATAR-AS-CODE', font=f_small, fill=ACCENT)
    d.text((48, 100), '一个角色，就是一份 JSON', font=f_title, fill=INK)
    d.text((48, 166), '一行代码，让它在任何网页里说话', font=f_sub, fill=INK)
    d.text((48, 204), '角色 = 可 diff 的文本 · 表演 = 数值 · 渲染 = 纯函数', font=f_body, fill=MUTED)

    # 只写事实，不写法律结论（项目红线：不代替第三方判断合规义务）
    for i, label in enumerate(['零 GPU', '零模型权重', '无真人素材', '非拟真合成']):
        x = 48 + i * 122
        w = 108 if i < 2 else (112 if i == 2 else 112)
        d.rounded_rectangle((x, 256, x + w, 288), radius=6, outline=LINE, fill='#1D1922')
        d.text((x + 10, 262), label, font=f_small, fill=MUTED)

    d.line((48, 330, 520, 330), fill=LINE, width=1)
    d.text((48, 350), 'renderFaceSvg(char, pose) → SVG', font=f_badge, fill=ACCENT)
    d.text((48, 380), '同一份 FaceTraced，既能出 MP4，也能零依赖嵌进网页', font=f_small, fill=MUTED)
    d.text((48, 420), 'MIT · 纯插画 · 无真人素材 · 确定性可复现', font=f_small, fill=MUTED)

    # 右：M / A / O 三态（A 大开、O 收圆，一眼看出是口型驱动）
    labels = ['M 闭口', 'A 大开', 'O 收圆']
    picks = [cells[0], cells[1], cells[2]]
    thumb = (176, 220)
    gap = 16
    x0 = 600
    y0 = 96
    for i, (c, label) in enumerate(zip(picks, labels)):
        x = x0 + i * (thumb[0] + gap)
        shot = c.resize(thumb, Image.LANCZOS)
        img.paste(shot, (x, y0))
        d.rectangle((x, y0, x + thumb[0] - 1, y0 + thumb[1] - 1), outline=LINE, width=1)
        d.text((x, y0 + thumb[1] + 10), label, font=f_badge, fill=INK)
    d.text((x0, 366), '6 口型 / 5 情绪 / 15 通道姿态', font=f_small, fill=MUTED)
    d.text((x0, 396), '↑ 同一张脸，只有数值变了', font=f_small, fill=MUTED)

    out = ASSETS / 'hero.png'
    img.save(out, optimize=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', default='noF')
    args = ap.parse_args()
    grid_path = ROOT / 'out' / f'{args.char}-grid.png'
    if not grid_path.exists():
        raise SystemExit(f'缺少 {grid_path}：先跑 python tools/codeavatar.py grid {args.char}')
    grid = Image.open(grid_path).convert('RGB')
    if grid.size != (1920, 1600):
        raise SystemExit(f'六格图尺寸异常：{grid.size}')
    cells = cell_images(grid)
    for p in (make_gif(cells), make_hero(cells)):
        print(f'  {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
