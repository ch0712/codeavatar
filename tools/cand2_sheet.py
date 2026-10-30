"""三张新候选拼一张联系表（标签写在左上），用于一眼挑稿。"""
from PIL import Image, ImageDraw

CD = "/H/.hermes/workspace/autocut/refs/dhk/anchor-code/cand2/"
OUT = "/H/.hermes/workspace/autocut/refs/dhk/out/cand2-sheet.png"
FILES = [("S5 高领女", "S5_highneck_woman.png"),
         ("S6 圆领男", "S6_crewneck_man.png"),
         ("S7 有领女", "S7_collar_woman.png")]
TH = 900
ims = []
for tag, fn in FILES:
    im = Image.open(CD + fn).convert("RGB")
    w = int(im.width * TH / im.height)
    ims.append((tag, im.resize((w, TH), Image.LANCZOS)))

pad = 14
W = sum(i.width for _, i in ims) + pad * (len(ims) + 1)
sheet = Image.new("RGB", (W, TH + 46), (16, 15, 20))
d = ImageDraw.Draw(sheet)
x = pad
for tag, im in ims:
    sheet.paste(im, (x, 40))
    d.text((x + 6, 14), tag, fill=(245, 240, 230))
    x += im.width + pad
sheet.save(OUT)
print("sheet", OUT, sheet.size)
