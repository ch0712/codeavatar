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
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
CHARS = ROOT / 'packages' / 'anchor-core' / 'src' / 'chars'
STUDIO = ROOT / 'studio'


def run(cmd, cwd=None, check=True, env=None):
    print('  $', subprocess.list2cmdline([str(x) for x in cmd]))
    r = subprocess.run([str(x) for x in cmd], cwd=cwd, shell=False, env=env)
    if check and r.returncode != 0:
        raise SystemExit(f'失败（exit {r.returncode}）')
    return r.returncode


def py(script, *args):
    return run([sys.executable, TOOLS / script, *args])


def find_browser():
    """显式解析渲染用的 Chromium 二进制。

    Remotion 默认从 storage.googleapis.com 下载 Chrome Headless Shell；
    无外网/网络受限的环境会永久挂起。因此按优先级探测本地已有浏览器：
      1. CODEAVATAR_BROWSER 环境变量（显式指定，优先级最高）
      2. node_modules/.remotion 里 Remotion 自己缓存的 chrome-headless-shell
      3. 系统安装的 Chrome / Edge（win 常见路径 + PATH 里的 chromium 系可执行）
    找不到时返回 None，由 Remotion 走默认下载流程（行为不变，但打印告警）。
    """
    env_browser = os.environ.get('CODEAVATAR_BROWSER')
    if env_browser:
        p = Path(env_browser)
        if p.is_file():
            return p
        raise SystemExit(f'CODEAVATAR_BROWSER={env_browser} 不是可执行文件路径')
    candidates = [
        *sorted((ROOT / 'node_modules' / '.remotion').rglob('chrome-headless-shell*')),
        Path(os.environ.get('PROGRAMFILES', r'C:\Program Files')) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe',
        Path(os.environ.get('PROGRAMFILES(X86)', r'C:\Program Files (x86)')) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe',
        Path(os.environ.get('LOCALAPPDATA', '')) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe',
    ]
    for name in ('chromium', 'google-chrome', 'chrome', 'msedge'):
        which = shutil.which(name)
        if which:
            candidates.append(Path(which))
    for p in candidates:
        if p.is_file() and p.suffix.lower() in ('.exe', '.app', ''):
            return p
    return None


def remotion(*args):
    """Run the workspace-local Remotion CLI without shell or platform wrappers."""
    cli = ROOT / 'node_modules' / '@remotion' / 'cli' / 'remotion-cli.js'
    if not cli.is_file():
        raise SystemExit('未找到本地 Remotion CLI，请先在仓库根目录运行 npm install')
    node = shutil.which('node')
    if not node:
        raise SystemExit('未找到 Node.js，请安装 Node.js 并加入 PATH')
    cmd = [node, cli, *args]
    browser = find_browser()
    if browser is not None:
        print(f'  浏览器: {browser}')
        # 插在子命令之前：--browser-executable 是全局选项
        cmd = [node, cli, '--browser-executable', str(browser), *args]
    else:
        print('  ⚠ 未找到本地浏览器，Remotion 将尝试在线下载 Chrome Headless Shell'
              '（网络受限时会挂起；可用 CODEAVATAR_BROWSER=<浏览器路径> 显式指定）')
    return run(cmd, cwd=STUDIO)


def write_props_file(props):
    handle = tempfile.NamedTemporaryFile('w', encoding='utf-8', suffix='.json',
                                         prefix='codeavatar-props-', delete=False)
    with handle:
        json.dump(props, handle, ensure_ascii=False)
    return Path(handle.name)


def cmd_gate(a):
    py('sheet_gate.py', *[Path(s).resolve() for s in a.sheets])


def cmd_build(a):
    key = a.key
    out = CHARS / f'{key}.json'
    if os.path.exists(out) and not a.force:
        raise SystemExit(f'{out} 已存在。要覆盖加 --force（会覆盖一个已验收角色，慎用）')
    sheet = Path(a.sheet).resolve()
    print(f'[1/3] 合规闸门 {sheet}')
    py('sheet_gate.py', sheet)
    print(f'[2/3] 描摹 {a.sheet} → {key}.json')
    py('trace_design.py', 'auto', sheet, out)
    print('[3/4] 眼层拆分（lid / iris）')
    py('split_eye_layers.py', key)
    print('[4/4] 更新角色注册表')
    py('sync_char_registry.py')
    with out.open(encoding='utf-8') as f:
        d = json.load(f)
    movable = [(l['role'], l.get('side')) for l in d['layers'] if l.get('role')]
    print(f'\n✅ {key}: {len(d["layers"])} 层 · {len(movable)} 个可动件 {movable}')
    print(f'   skinBox {d["skinBox"]} · lipBox {d["lipBox"]}')
    print(f'   下一步：codeavatar grid {key}')


def cmd_grid(a):
    out = ROOT / 'out' / f'{a.key}-grid.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    props_file = write_props_file({'char': a.key})
    try:
        remotion('still', 'VisemeGrid', out, '--props', props_file, '--log=error')
    finally:
        props_file.unlink(missing_ok=True)
    print(f'  图: {out}')
    return py('gate_mouth.py', out, 3, 2, 640, 800, '--char', a.key)


def cmd_render(a):
    props = {'char': a.key, 'layout': a.layout, 'bg': a.bg}
    if a.props:
        with Path(a.props).resolve().open(encoding='utf-8') as f:
            loaded = json.load(f)
        # --props 的文件是一个 Perf（含 fps/frames/gestures），必须挂在 props.perf
        # 传给 Presenter；直接平铺会让 perf 静默丢失，渲染成静态中性脸。
        if isinstance(loaded, dict) and 'perf' in loaded:
            props.update(loaded)
        else:
            props['perf'] = loaded
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    props_file = write_props_file(props)
    try:
        remotion('render', 'TalkClip', out, '--props', props_file,
                 '--concurrency=1', '--log=error')
    finally:
        props_file.unlink(missing_ok=True)
    print(f'  成片: {out}')


def cmd_list(a):
    for f in sorted(CHARS.glob('*.json')):
        if not f.is_file():
            continue
        with f.open(encoding='utf-8') as stream:
            d = json.load(stream)
        roles = [l['role'] for l in d['layers'] if l.get('role')]
        print(f'{f.stem:6s} {len(d["layers"]):3d} 层  {len(roles):2d} 可动  '
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
