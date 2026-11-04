#!/usr/bin/env python3
"""人评结果汇总（docs/EVAL-PROTOCOL.md v0 判定线）。

  python tools/eval_score.py --date 2026-11-04 out/eval/2026-11-04/eval-*.csv
  python tools/eval_score.py --date 2026-11-04 out/eval/2026-11-04/*.csv --write

判定（协议 v0）：某模式「题均分（Q1~Q3 平均）≥3.5 且 Q1 均值 ≥4.0」→ 该模式本轮通过。
评审者 <3 人时不作结论（协议要求 ≥3，含作者外 1 人），只出参考表。

退出码：0 = 两模式均通过；1 = 有模式未通过（转缺陷单）；2 = 输入/样本问题。
"""
import csv
import glob
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'out' / 'eval'
Q_KEYS = ('q1', 'q2', 'q3')


def load_key(date: str):
    path = OUT / date / 'key.json'
    if not path.is_file():
        raise SystemExit(f'找不到 {path}，先跑 tools/eval_kit.py build --date {date}')
    return json.loads(path.read_text(encoding='utf-8'))


def read_rows(paths):
    rows, problems = [], []
    for p in paths:
        with open(p, encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f):
                clip = (r.get('clip') or '').strip()
                if not clip:
                    continue
                row = {'rater': (r.get('rater') or '匿名').strip() or '匿名',
                       'clip': clip, 'note': (r.get('q4_note') or '').strip(), 'src': Path(p).name}
                for k in Q_KEYS:
                    raw = (r.get(k) or '').strip()
                    try:
                        v = int(raw)
                    except ValueError:
                        problems.append(f'{Path(p).name}: {clip} {k} 不是整数（{raw!r}）')
                        v = None
                    if v is not None and not 1 <= v <= 5:
                        problems.append(f'{Path(p).name}: {clip} {k}={v} 超出 1~5')
                    row[k] = v
                if all(row[k] is not None for k in Q_KEYS):
                    rows.append(row)
    return rows, problems


def mean(xs):
    return round(statistics.fmean(xs), 2) if xs else None


def main(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(description='人评结果汇总')
    p.add_argument('--date', required=True)
    p.add_argument('csv', nargs='+', help='评审者导出的 CSV（可多个/通配）')
    p.add_argument('--write', action='store_true', help='写 docs/eval/<date>.md')
    args = p.parse_args(argv)

    key = load_key(args.date)
    clip_meta = {e['clip']: e for e in key['order']}
    paths = []
    for pattern in args.csv:
        hits = glob.glob(pattern)
        paths.extend(hits if hits else [pattern])
    paths = [Path(x) for x in paths]
    missing_files = [str(x) for x in paths if not x.is_file()]
    if missing_files:
        raise SystemExit('找不到评分文件: ' + ', '.join(missing_files))

    rows, problems = read_rows(paths)
    raters = sorted({r['rater'] for r in rows})
    unknown = sorted({r['clip'] for r in rows} - set(clip_meta))
    if unknown:
        raise SystemExit('评分里出现未知片段: ' + ', '.join(unknown))

    covered = {r['rater']: {x['clip'] for x in rows if x['rater'] == r['rater']} for r in rows}
    incomplete = {k: sorted(set(clip_meta) - v) for k, v in covered.items() if len(v) < len(clip_meta)}

    print(f'批次 {args.date} / 角色 {key["char"]} / 参数 {key["params"]}')
    print(f'评审者 {len(raters)} 人：{", ".join(raters) or "无"}；有效评分 {len(rows)} 条')
    if problems:
        for m in problems:
            print(f'  WARN {m}')
    for rater, miss in incomplete.items():
        print(f'  WARN {rater} 缺 {len(miss)} 段：{", ".join(miss)}')

    by_mode = {}
    for e in key['order']:
        by_mode.setdefault(e['mode'], []).append(e['clip'])

    results = {}
    print('\n模式        Q1均值  Q2均值  Q3均值  题均分  判定')
    for mode, clips in by_mode.items():
        sel = [r for r in rows if r['clip'] in clips]
        if not sel:
            print(f'{mode:<11} —       —       —       —       无评分')
            results[mode] = {'n': 0, 'pass': False}
            continue
        m1, m2, m3 = (mean([r['q1'] for r in sel]), mean([r['q2'] for r in sel]),
                      mean([r['q3'] for r in sel]))
        overall = round(statistics.fmean([m1, m2, m3]), 2)
        ok = overall >= 3.5 and m1 >= 4.0
        verdict = '通过' if ok else '未通过'
        print(f'{mode:<11} {m1:<7} {m2:<7} {m3:<7} {overall:<7} {verdict}')
        results[mode] = {'n': len(sel), 'q1': m1, 'q2': m2, 'q3': m3,
                         'overall': overall, 'pass': ok}

    notes = [(r, clip_meta[r['clip']]) for r in rows if r['note']]
    if notes:
        print('\nQ4 记录：')
        for r, meta in notes:
            print(f'  {r["clip"]} ({meta["mode"]}/{meta["case"]}) {r["rater"]}: {r["note"]}')

    if len(raters) < 3:
        print('\nNOTE 评审者不足 3 人，按协议不作结论（需含作者外 1 人）。')

    if args.write:
        path = write_report(args.date, key, raters, results, rows, notes, incomplete)
        print(f'\n报告: {path}')

    if len(raters) < 3:
        return 0
    return 0 if all(v.get('pass') for v in results.values()) else 1


def write_report(date, key, raters, results, rows, notes, incomplete) -> Path:
    outdir = ROOT / 'docs' / 'eval'
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / f'{date}.md'
    lines = [f'# 人评结果 {date}', '',
             f'- 协议：`docs/EVAL-PROTOCOL.md` v0（盲序、随机顺序、5 分制、失败样片不删）',
             f'- 角色：`{key["char"]}`；参数：`{key["params"]}`',
             f'- 评审者：{len(raters)} 人（{", ".join(raters)}）'
             + ('　**少于协议要求的 3 人，本轮只作参考**' if len(raters) < 3 else ''),
             '', '## 判定', '',
             '| 模式 | Q1 口型 | Q2 活 | Q3 情绪 | 题均分 | 判定 |',
             '|:--|:--|:--|:--|:--|:--|']
    for mode, r in results.items():
        if not r.get('n'):
            lines.append(f'| {mode} | — | — | — | — | 无评分 |')
            continue
        lines.append(f'| {mode} | {r["q1"]} | {r["q2"]} | {r["q3"]} | {r["overall"]} | '
                     f'{"通过" if r["pass"] else "未通过"} |')
    lines += ['', '判定线：题均分 ≥3.5 且 Q1 ≥4.0。', '',
              '## 片源（盲序与真值，评后公开）', '',
              '| 片段 | 模式 | 句型 | 时长 | sha256 |', '|:--|:--|:--|:--|:--|']
    for e in key['order']:
        lines.append(f'| {e["clip"]} | {e["mode"]} | {e["label"]} | {e["duration"]}s | '
                     f'`{e["sha256"][:16]}` |')
    if incomplete:
        lines += ['', '## 样本缺口', '']
        for rater, miss in incomplete.items():
            lines.append(f'- {rater} 缺 {len(miss)} 段：{", ".join(miss)}')
    lines += ['', '## 逐段原始分', '', '| 评审者 | 片段 | Q1 | Q2 | Q3 | Q4 备注 |',
              '|:--|:--|:--|:--|:--|:--|']
    for r in sorted(rows, key=lambda x: (x['rater'], x['clip'])):
        lines.append(f'| {r["rater"]} | {r["clip"]} | {r["q1"]} | {r["q2"]} | {r["q3"]} | '
                     f'{r["note"] or "—"} |')
    failed = [m for m, v in results.items() if not v.get('pass')]
    lines += ['', '## 结论', '']
    if len(raters) < 3:
        lines.append('评审者不足 3 人，本轮不作通过/不通过结论；补足后重出本报告。')
    elif failed:
        lines.append(f'未通过模式：{"、".join(failed)}。按协议转缺陷单，'
                     '失败样片按 Q4 备注定位帧号，**不删片**。')
    else:
        lines.append('两种模式均通过本轮判定线。')
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return path


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
