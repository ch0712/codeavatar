"""把可选的角色设定稿拼成一张联系表（带标签），便于一次看完再挑选。"""
import json
import os

from PIL import Image, ImageDraw

CD = "/H/.hermes/workspace/autocut/refs/dhk/anchor-code/cand/"
OUT = "/H/.hermes/workspace/autocut/refs/dhk/out/design-candidates.png"

# 已知映射（S4 来自第一批，S2/S3 来自重试批）
known = {"S4_character": "3-38b3bec7-e67a-467c-8c5a-849430170bfa.png",
         "S1_intellectual": "6-6103d9bb-367e-4616-977c-b6f89a33e30b.png"}
res = json.load(open(CD + "_batch_result.json"))
for s in res.get("success", []):
    known[s["id"]] = os.path.basename(s["local_path"])

order = ["S1_intellectual", "S2_sharp", "S3_warm", "S4_character"]
OUT = "/H/.hermes/workspace/autocut/refs/dhk/out/design-candidates-4.png"
items = [(k, known[k]) for k in order if k in known]
print("present:", [k for k, _ in items])

TH = 760
ims = []
for tag, fn in items:
    im = Image.open(CD + fn).convert("RGB")
    w = int(im.width * TH / im.height)
    ims.append((tag, im.resize((w, TH), Image.LANCZOS)))

pad = 14
W = sum(i.width for _, i in ims) + pad * (len(ims) + 1)
sheet = Image.new("RGB", (W, TH + 46), (18, 17, 22))
d = ImageDraw.Draw(sheet)
x = pad
for tag, im in ims:
    sheet.paste(im, (x, 38))
    d.text((x + 4, 12), tag, fill=(240, 235, 225))
    x += im.width + pad
sheet.save(OUT)
print("sheet", OUT, sheet.size)
