#!/usr/bin/env python3
"""人评评审包生成器（docs/EVAL-PROTOCOL.md v0 的执行工具）。

  python tools/eval_kit.py build --date 2026-11-04 [--char no4] [--shot medium]
  python tools/eval_kit.py show  --date 2026-11-04        # 打印盲序与片源信息（含 key）

产出 out/eval/<date>/：
  clip-01.mp4 … clip-06.mp4   盲序成片（评审者只看这些）
  key.json                    盲序映射 + 参数 + sha256（评审期间不给评审者）
  questionnaire.html          自包含问卷页（离线可开，评分后导出 CSV）
  评分表.csv                   手填模板（不用网页时用这个）
  RATERS.md                   给评审者看的说明（不含模式信息）

设计约束：
  - 两种模式（pinyin / estimated）**同参数**（同一角色、同一景别、都开 motion 与
    coarticulate），只有"是否音素对应"这一个变量不同，否则评不出模式差异。
  - 盲序由 date 派生的固定种子决定：同日期重跑顺序一致（可复现），
    但键文件不给评审者，因此对人仍是不透明的。
"""
import hashlib
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
OUT = ROOT / 'out' / 'eval'

CASES = [
    {
        'case': 'stmt',
        'label': '陈述句',
        'text': '今天讲一下口型同步的具体做法和常见问题。',
        'pinyin': 'jin1 tian1 jiang3 yi2 xia4 kou3 xing2 tong2 bu4 de5 ju4 ti3 '
                  'zuo4 fa3 he2 chang2 jian4 wen4 ti2.',
    },
    {
        'case': 'excl',
        'label': '强调句',
        'text': '这个方法真的很快，而且完全不用手工调整！',
        'pinyin': 'zhe4 ge4 fang1 fa3 zhen1 de5 hen3 kuai4, er2 qie3 wan2 quan2 '
                  'bu4 yong4 shou3 gong1 tiao2 zheng3!',
    },
    {
        'case': 'ques',
        'label': '疑问句',
        'text': '你有没有遇到过口型和声音对不上的情况呢？',
        'pinyin': 'ni3 you3 mei2 you3 yu4 dao4 guo4 kou3 xing2 he2 sheng1 yin1 '
                  'dui4 bu4 shang4 de5 qing2 kuang4 ne5?',
    },
]
MODES = ['pinyin', 'estimated']


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def duration_of(path: Path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(r.stdout.strip()), 2)
    except (ValueError, AttributeError):
        return None


def render_clip(mode: str, case: dict, target: Path, args) -> None:
    text = case['pinyin'] if mode == 'pinyin' else case['text']
    cmd = [sys.executable, str(TOOLS / 'codeavatar.py'), 'say', args.char, text,
           '-o', str(target), '--sps', str(args.sps), '--motion',
           '--coarticulate', '--shot', args.shot, '--json']
    if mode == 'pinyin':
        cmd.append('--pinyin')
    print(f'  渲染 {mode}/{case["case"]} → {target.name} …', flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:])
        raise SystemExit(f'渲染失败（exit {r.returncode}）: {mode}/{case["case"]}')


def cmd_build(args) -> int:
    date = args.date
    outdir = OUT / date
    raw = outdir / 'raw'
    raw.mkdir(parents=True, exist_ok=True)

    entries = []
    for case in CASES:
        line = {'case': case['case'], 'label': case['label'], 'text': case['text']}
        for mode in MODES:
            target = raw / f'{mode}-{case["case"]}.mp4'
            if args.force or not target.exists():
                render_clip(mode, case, target, args)
            if not target.exists():
                raise SystemExit(f'缺少成片且未渲染: {target}')
            entries.append({
                'mode': mode, 'case': case['case'], 'label': case['label'],
                'text': (case['pinyin'] if mode == 'pinyin' else case['text']),
                'sha256': sha256(target),
                'duration': duration_of(target),
                '_src': target,
            })

    order = list(entries)
    random.Random(f'codeavatar-eval-{date}').shuffle(order)
    for i, e in enumerate(order, 1):
        e['clip'] = f'clip-{i:02d}.mp4'
        shutil.copy2(e.pop('_src'), outdir / e['clip'])

    key = {
        'date': date, 'char': args.char,
        'params': {'shot': args.shot, 'sps': args.sps,
                   'motion': True, 'coarticulate': True, 'layout': 'full'},
        'protocol': 'docs/EVAL-PROTOCOL.md',
        'seed': f'codeavatar-eval-{date}',
        'order': order,
        'warning': '本文件含模式真值，评审期间不要交给评审者。',
    }
    (outdir / 'key.json').write_text(
        json.dumps(key, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (outdir / 'questionnaire.html').write_text(
        build_questionnaire(order, date), encoding='utf-8')
    (outdir / '评分表.csv').write_text(
        'rater,clip,q1,q2,q3,q4_note\n'
        + '\n'.join(f'评审者A,{e["clip"]},,,,' for e in order) + '\n',
        encoding='utf-8')
    (outdir / 'RATERS.md').write_text(RATERS_GUIDE, encoding='utf-8')

    print(f'\n评审包: {outdir}')
    for e in order:
        print(f'  {e["clip"]}  {e["duration"]}s  {e["sha256"][:12]}')
    print(f'\n发给评审者：{outdir} 整个文件夹（或 questionnaire.html + 6 个 mp4）')
    print('回收：评审者导出的 CSV 或 评分表.csv，然后跑 python tools/eval_score.py')
    return 0


RATERS_GUIDE = """# 评审说明（请先读完再开始）

这批素材是 **6 段 4~6 秒的数字人口播短片**，来自同一套纯代码管线。
请就"看起来像不像一个在说话的人"给分，不需要懂技术。

## 怎么做（约 10 分钟）

1. 打开 `questionnaire.html`（双击即可，不需要联网）。
2. 6 段依次出现。每段可以**反复看**，但**不要跳着比**——按顺序一段一段评。
3. 每段 4 题：
   - 第 1~3 题打 1~5 分（1 最差，5 最好）。
   - 第 4 题是文字，只在你觉得"一眼假/出戏"时写一句，尽量写秒数（如"1.2s 嘴型卡住"）。
4. 全部评完点页面底部「导出 CSV」，把文件发回来。
5. **不要**和别人讨论后再改分——这一轮要的是各自的独立判断。

## 两点说明

- 6 段里有两种技术模式，比例是 3:3，但**不告诉你哪段是哪种**，也别去猜；
  猜出来再评价会污染结果。
- 觉得都差不多就给 3 分，不用刻意拉开差距；真的很好才给 5 分。

## 打分参考锚点

| 分 | 第 1 题（口型对得上吗） | 第 2 题（像活人吗） | 第 3 题（情绪读得出吗） |
|:--|:--|:--|:--|
| 1 | 明显错位、像在乱动 | 完全木偶 | 三种语气一样 |
| 3 | 大致对，个别音含糊 | 有眨眼但动作机械 | 勉强能分 |
| 5 | 自然同步，看不出破绽 | 眼神、呼吸、头动都自然 | 强调/疑问一眼看出 |
"""


def build_questionnaire(order, date: str) -> str:
    blocks = []
    for e in order:
        clip = e['clip']
        radios = []
        for qi, q in enumerate([
            '口型与"应该发的音"对得上吗？',
            '人物看起来"活"吗？（眼神/眨眼/头部微动）',
            '情绪读得出来吗？（强调/疑问的区分）',
        ], 1):
            opts = ''.join(
                f'<label><input type="radio" name="{clip}-q{qi}" value="{v}"> {v}</label>'
                for v in range(1, 6))
            radios.append(
                f'<div class="q"><p>Q{qi}. {q}</p><div class="scale">{opts}</div>'
                f'<div class="anchors"><span>1 差</span><span>3 一般</span><span>5 好</span></div></div>')
        blocks.append(f"""
<section data-clip="{clip}">
  <h2>{clip.replace('clip-', '第 ').replace('.mp4', '')} 段</h2>
  <video src="{clip}" controls preload="metadata"></video>
  {''.join(radios)}
  <div class="q"><p>Q4. 有一眼假 / 出戏的瞬间吗？（可留空，写秒数更好）</p>
  <input type="text" name="{clip}-q4" placeholder="例如：1.2s 嘴型卡住"></div>
</section>""")
    return f"""<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>codeavatar 人评问卷 {date}</title>
<style>
body{{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:0 auto;
padding:24px 16px 80px;color:#222;background:#fafafa;line-height:1.6}}
h1{{font-size:20px;font-weight:500;margin:0 0 8px}}
p.lead{{color:#555;font-size:14px;margin:0 0 24px}}
section{{background:#fff;border:1px solid #e4e4e4;border-radius:12px;padding:16px;margin:0 0 20px}}
section h2{{font-size:15px;font-weight:500;margin:0 0 12px;color:#333}}
video{{width:100%;max-height:420px;background:#000;border-radius:8px;display:block;margin:0 0 16px}}
.q{{margin:0 0 14px}}
.q p{{margin:0 0 6px;font-size:14px}}
.scale{{display:flex;gap:14px}}
.scale label{{font-size:14px;display:flex;align-items:center;gap:4px;cursor:pointer}}
.anchors{{display:flex;justify-content:space-between;font-size:11px;color:#999;margin-top:4px;max-width:200px}}
input[type=text]{{width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px}}
.rater{{position:sticky;top:0;background:#fff;border:1px solid #e4e4e4;border-radius:12px;
padding:12px 16px;margin:0 0 20px;z-index:2}}
.rater input{{padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;width:240px}}
button{{background:#222;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer}}
button:hover{{background:#000}}
footer{{margin-top:8px;color:#888;font-size:12px}}
</style>
<h1>数字人口播 · 主观评分</h1>
<p class="lead">共 6 段，每段 4 题，约 10 分钟。可以反复看，但请按顺序逐段评。
全部评完后点底部按钮导出 CSV 发回。</p>
<div class="rater">你的名字/代号：<input type="text" id="rater" placeholder="例如：小王"></div>
{''.join(blocks)}
<button id="export">全部评完，导出 CSV</button>
<footer>导出的文件名形如 eval-&lt;你的名字&gt;.csv，直接发回即可。</footer>
<script>
var CLIPS = {json.dumps([e['clip'] for e in order])};
document.getElementById('export').onclick = function () {{
  var rater = (document.getElementById('rater').value || '').trim();
  if (!rater) {{ alert('请先填名字/代号，便于区分多份评分'); return; }}
  var rows = [['rater','clip','q1','q2','q3','q4_note']];
  var missing = [];
  CLIPS.forEach(function (c) {{
    var v = [1,2,3].map(function (i) {{
      var el = document.querySelector('input[name="' + c + '-q' + i + '"]:checked');
      return el ? el.value : '';
    }});
    if (v.some(function (x) {{ return x === ''; }})) missing.push(c);
    var note = document.querySelector('input[name="' + c + '-q4"]').value || '';
    rows.push([rater, c, v[0], v[1], v[2], note.replace(/"/g, '""')]);
  }});
  if (missing.length) {{ alert('还有没评的段：' + missing.join('、')); return; }}
  var csv = rows.map(function (r) {{
    return r.map(function (x) {{ return /[",\\n]/.test(x) ? '"' + x + '"' : x; }}).join(',');
  }}).join('\\n');
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,%EF%BB%BF' + encodeURIComponent(csv);
  a.download = 'eval-' + rater + '.csv';
  a.click();
}};
</script>
</html>
"""


def cmd_show(args) -> int:
    key = json.loads((OUT / args.date / 'key.json').read_text(encoding='utf-8'))
    print(f"日期 {key['date']} / 角色 {key['char']} / 参数 {key['params']}")
    for e in key['order']:
        print(f"  {e['clip']}  {e['mode']:<9} {e['case']:<5} {e['duration']}s  "
              f"{e['sha256'][:12]}  {e['text'][:28]}")
    return 0


def main(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(description='人评评审包生成器')
    sub = p.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build', help='渲染并生成评审包')
    b.add_argument('--date', required=True, help='评审批次日期，如 2026-11-04')
    b.add_argument('--char', default='no4')
    b.add_argument('--shot', default='medium', choices=['full', 'medium', 'closeup'])
    b.add_argument('--sps', type=float, default=4.2, help='音节速率（默认 4.2，稍慢于 5.5）')
    b.add_argument('--force', action='store_true', help='重渲已有成片')
    b.set_defaults(fn=cmd_build)
    s = sub.add_parser('show', help='打印盲序与片源信息')
    s.add_argument('--date', required=True)
    s.set_defaults(fn=cmd_show)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
