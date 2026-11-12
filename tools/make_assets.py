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

    # 左：主张——标题定稿（用户指定）：一句话说清是什么 + 两个关键性质。
    d.text((48, 62), 'CODEAVATAR', font=f_small, fill=ACCENT)
    d.text((48, 100), '用代码驱动的AI数字人', font=f_title, fill=INK)
    d.text((48, 166), '可编辑、0算力成本', font=f_sub, fill=ACCENT)
    d.text((48, 204), '一张设定稿进去，视频、网页、Agent 里都是同一张脸', font=f_body, fill=MUTED)
    d.text((48, 230), '表情和口型是数字：改一个数字就换，不用重画、不用重录', font=f_body, fill=MUTED)

    for i, label in enumerate(['可编辑', '0算力成本', '跨视频网页', '改数字就换脸']):
        x = 48 + i * 122
        w = 108 if i < 2 else 112
        d.rounded_rectangle((x, 262, x + w, 294), radius=6, outline=LINE, fill='#1D1922')
        d.text((x + 10, 268), label, font=f_small, fill=MUTED)

    d.line((48, 330, 520, 330), fill=LINE, width=1)
    d.text((48, 350), '同一份角色，出片、上线、实时驱动都不用重做', font=f_badge, fill=ACCENT)
    d.text((48, 380), '画风由你的设定稿决定：插画、吉祥物、课件形象都能用', font=f_small, fill=MUTED)
    d.text((48, 420), '自己画的设定稿，产物归你 · 代码 MIT', font=f_small, fill=MUTED)

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
    d.text((x0, 366), '上面三张，是同一个角色的三种口型', font=f_small, fill=MUTED)
    d.text((x0, 396), '表情说改就改，不用重新画、不用重新生成', font=f_small, fill=MUTED)

    out = ASSETS / 'hero.png'
    img.save(out, optimize=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--char', default='no4')
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
