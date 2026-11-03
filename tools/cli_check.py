#!/usr/bin/env python3
"""CLI 契约场景断言（阶段 1 第 4 项 + §8 验收清单第 4 项）。

子进程逐场景验证：退出码稳定、dry-run 不渲染、--json 结构化输出、
契约违规显式报错、从仓库外目录调用时路径基准一致。
运行：python tools/cli_check.py   （全部场景 ≤ 数秒，不渲染真实视频）
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'tools' / 'codeavatar.py'
EXIT_OK, EXIT_INVALID, EXIT_ENV = 0, 2, 3

failures = 0


def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name}{' | ' + detail if detail else ''}")
    if not ok:
        failures += 1


def run_cli(args, cwd=ROOT, stdin=None):
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True, text=True, encoding='utf-8', cwd=cwd,
        input=stdin, env={**__import__('os').environ, 'PYTHONIOENCODING': 'utf-8'},
    )


# 生成一份合法 perf 与一份坏 perf（o=2 越界）
good = json.loads(Path(ROOT / 'out' / 'perf-motion.json').read_text(encoding='utf-8')) \
    if (ROOT / 'out' / 'perf-motion.json').is_file() else None
if good is None:
    # CI 干净环境兜底：用 say-perf 现场合成
    r = run_cli(['say', 'no4', 'ni3 hao3.', '-o', 'out/cli-check.mp4', '--pinyin', '--dry-run'])
    good = json.loads(subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'say_perf.py')],
        input=json.dumps({'text': 'ni3 hao3.', 'pinyin': True}, ensure_ascii=False),
        capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
    ).stdout)
bad = json.loads(json.dumps(good))
bad['frames'][0]['o'] = 2.0

with tempfile.TemporaryDirectory() as td:
    tdp = Path(td)
    good_p, bad_p = tdp / 'good.json', tdp / 'bad.json'
    good_p.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
    bad_p.write_text(json.dumps(bad, ensure_ascii=False), encoding='utf-8')

    # 1) dry-run 合法 → exit 0，不产出文件
    r = run_cli(['render', 'no4', '-o', str(tdp / 'x.mp4'), '--props', str(good_p), '--dry-run'])
    check('render --dry-run 合法 perf → exit 0',
          r.returncode == EXIT_OK and '[dry-run]' in r.stdout,
          f'rc={r.returncode} {r.stderr[-80:]}')

    # 2) dry-run 坏 perf → exit 2 + 结构化错误码
    r = run_cli(['render', 'no4', '-o', str(tdp / 'x.mp4'), '--props', str(bad_p), '--dry-run'])
    check('render --dry-run 坏 perf → exit 2 + E_RANGE',
          r.returncode == EXIT_INVALID and 'E_RANGE' in r.stderr,
          f'rc={r.returncode}')

    # 3) dry-run --json 结构化输出
    r = run_cli(['render', 'no4', '-o', str(tdp / 'x.mp4'), '--props', str(good_p),
                 '--dry-run', '--json'])
    j = json.loads(r.stdout) if r.returncode == EXIT_OK else {}
    check('render --dry-run --json → {ok,dryRun,out}',
          j.get('ok') is True and j.get('dryRun') is True and j.get('out', '').endswith('x.mp4'),
          r.stdout[-100:])

    # 4) 仓库外目录调用：相对基准 = 调用者 cwd，绝对 props 路径直达
    r = run_cli(['render', 'no4', '-o', 'x.mp4', '--props', str(good_p), '--dry-run'], cwd=td)
    check('仓库外目录调用 CLI（绝对 props 路径）→ exit 0',
          r.returncode == EXIT_OK, f'rc={r.returncode} {r.stderr[-100:]}')

    # 5) say --dry-run --json（合成+校验，不渲染）
    r = run_cli(['say', 'no4', 'ni3 hao3.', '-o', str(tdp / 'y.mp4'),
                 '--pinyin', '--dry-run', '--json'])
    j = json.loads(r.stdout) if r.returncode == EXIT_OK else {}
    check('say --dry-run --json → 帧数与时长入结果',
          j.get('ok') is True and isinstance(j.get('frames'), int) and j['frames'] > 0,
          r.stdout[-120:])

    # 6) 未知子命令 → argparse exit 2
    r = run_cli(['no-such-cmd'])
    check('未知子命令 → exit 2', r.returncode == 2, f'rc={r.returncode}')

    # 7) help → exit 0
    r = run_cli(['--help'])
    check('--help → exit 0', r.returncode == EXIT_OK)

    # 8) Python 校验器直跑（TS↔Python 契约同步的运行时证据）
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'validate_perf.py'), str(bad_p)],
                       capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    check('validate_perf.py 坏 perf → exit 2 + stderr 错误列表',
          r.returncode == EXIT_INVALID and 'E_RANGE' in r.stderr)

    # 9) 含空格与非 ASCII 字符的路径传递（§8-197）
    weird = tdp / '测 试 目录'
    weird.mkdir(exist_ok=True)
    weird_props = weird / 'perf 测试.json'
    weird_props.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
    weird_out = weird / '成片 测试.mp4'
    r = run_cli(['render', 'no4', '-o', str(weird_out), '--props', str(weird_props), '--dry-run'])
    check('含空格/中文路径（输入+输出）→ exit 0',
          r.returncode == EXIT_OK, f'rc={r.returncode} {r.stderr[-100:]}')

raise SystemExit(1 if failures else 0)
