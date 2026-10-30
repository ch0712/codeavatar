#!/usr/bin/env python3
"""codeavatar —— 纯代码驱动角色的统一入口。

设计约束：**所有能力都从这里出去**。autocut 等消费方只允许调这个 CLI 或依赖
`packages/anchor-core`，不允许复制这里的任何工具或数据。

  codeavatar gate    <设定稿.png> [...]        合规闸门（尺寸/扁平度/眉眼可配对/唇可定位）
  codeavatar build   <设定稿.png> <key>        一条命令出角色：gate → 描摹 → 眼层拆分
  codeavatar grid    <key>                    渲六格口型表 + 机检（输出 PNG 路径）
  codeavatar render  <key> -o out.mp4 ...     渲口播成片
  codeavatar list                             列出已注册角色

环境变量：
  FOLK_NOISE_FLATTEN=1   生图稿带低幅度色噪时打开调色板净化（默认关，保已验收角色零漂移）
  MEM_MAX=2600M          渲染内存上限（本机 3.7G，必须限）
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
CHARS = os.path.join(ROOT, 'packages', 'anchor-core', 'src', 'chars')
STUDIO = os.path.join(ROOT, 'studio')
MEM_MAX = os.environ.get('MEM_MAX', '2600M')


def run(cmd, cwd=None, check=True):
    print('  $', ' '.join(cmd) if isinstance(cmd, list) else cmd)
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str))
    if check and r.returncode != 0:
        raise SystemExit(f'失败（exit {r.returncode}）')
    return r.returncode


def py(script, *args):
    return run([sys.executable, os.path.join(TOOLS, script), *[str(a) for a in args]])


def cmd_gate(a):
    py('sheet_gate.py', *a.sheets)


def cmd_build(a):
    key = a.key
    out = os.path.join(CHARS, f'{key}.json')
    if os.path.exists(out) and not a.force:
        raise SystemExit(f'{out} 已存在。要覆盖加 --force（会覆盖一个已验收角色，慎用）')
    print(f'[1/3] 合规闸门 {a.sheet}')
    py('sheet_gate.py', a.sheet)
    print(f'[2/3] 描摹 {a.sheet} → {key}.json')
    py('trace_design.py', 'auto', a.sheet, out)
    print('[3/3] 眼层拆分（lid / iris）')
    py('split_eye_layers.py', key)
    d = json.load(open(out, encoding='utf-8'))
    movable = [(l['role'], l.get('side')) for l in d['layers'] if l.get('role')]
    print(f'\n✅ {key}: {len(d["layers"])} 层 · {len(movable)} 个可动件 {movable}')
    print(f'   skinBox {d["skinBox"]} · lipBox {d["lipBox"]}')
    print(f'   下一步：codeavatar grid {key}')


def cmd_grid(a):
    out = os.path.join(ROOT, 'out', f'{a.key}-grid.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    run(['systemd-run', '--scope', '-q', '-p', f'MemoryMax={MEM_MAX}', '--',
         'npx', 'remotion', 'still', 'VisemeGrid', out,
         '--props', json.dumps({'char': a.key}), '--log=error'], cwd=STUDIO)
    print(f'  图: {out}')
    return py('gate_mouth.py', out, 3, 2, 640, 800, '--char', a.key)


def cmd_render(a):
    props = {'char': a.key, 'layout': a.layout, 'bg': a.bg}
    if a.props:
        props.update(json.load(open(a.props, encoding='utf-8')))
    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    run(['systemd-run', '--scope', '-q', '-p', f'MemoryMax={MEM_MAX}', '--',
         'npx', 'remotion', 'render', 'TalkClip', out,
         '--props', json.dumps(props), '--concurrency=1', '--log=error'], cwd=STUDIO)
    print(f'  成片: {out}')


def cmd_list(a):
    for f in sorted(os.listdir(CHARS)):
        if not f.endswith('.json'):
            continue
        d = json.load(open(os.path.join(CHARS, f), encoding='utf-8'))
        roles = [l['role'] for l in d['layers'] if l.get('role')]
        print(f'{f[:-5]:6s} {len(d["layers"]):3d} 层  {len(roles):2d} 可动  '
              f'skin{d["skinBox"]}  lip{d["lipBox"]}')


def main():
    p = argparse.ArgumentParser(prog='codeavatar', description='纯代码驱动角色')
    sub = p.add_subparsers(dest='cmd', required=True)

    g = sub.add_parser('gate', help='设定稿合规闸门')
    g.add_argument('sheets', nargs='+')
    g.set_defaults(fn=cmd_gate)

    b = sub.add_parser('build', help='设定稿 → 角色')
    b.add_argument('sheet')
    b.add_argument('key')
    b.add_argument('--force', action='store_true')
    b.set_defaults(fn=cmd_build)

    gr = sub.add_parser('grid', help='六格口型表 + 机检')
    gr.add_argument('key')
    gr.set_defaults(fn=cmd_grid)

    r = sub.add_parser('render', help='渲口播成片')
    r.add_argument('key')
    r.add_argument('-o', '--out', required=True)
    r.add_argument('--props', help='表演数据 JSON（perf / captions / audio）')
    r.add_argument('--layout', default='full', choices=['full', 'pip'])
    r.add_argument('--bg', default='#141117')
    r.set_defaults(fn=cmd_render)

    ls = sub.add_parser('list', help='列出角色')
    ls.set_defaults(fn=cmd_list)

    a = p.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
