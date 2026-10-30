"""四张设定稿拼成一张联系表（按文件名给定顺序，标签写在左上）。"""
from PIL import Image, ImageDraw

CD = "/H/.hermes/workspace/autocut/refs/dhk/anchor-code/cand/"
OUT = "/H/.hermes/workspace/autocut/refs/dhk/out/design-candidates-4.png"

FILES = [
    ("1", "6-6103d9bb-367e-4616-977c-b6f89a33e30b.png"),
    ("2", "1-c1b9f143-1bf2-4c31-ac93-0626035a94f1.png"),
    ("3", "1-c4dc7c2d-c9cb-4adb-9768-4ee448be3a93.png"),
    ("4", "3-38b3bec7-e67a-467c-8c5a-849430170bfa.png"),
]
TH = 720
ims = []
for tag, fn in FILES:
    im = Image.open(CD + fn).convert("RGB")
    w = int(im.width * TH / im.height)
    ims.append((tag, im.resize((w, TH), Image.LANCZOS)))

pad = 12
W = sum(i.width for _, i in ims) + pad * (len(ims) + 1)
sheet = Image.new("RGB", (W, TH + 40), (16, 15, 20))
d = ImageDraw.Draw(sheet)
x = pad
for tag, im in ims:
    sheet.paste(im, (x, 34))
    d.text((x + 6, 10), "NO." + tag, fill=(245, 240, 230))
    x += im.width + pad
sheet.save(OUT)
print("sheet", OUT, sheet.size)
