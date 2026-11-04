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
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import shutil

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
CHARS = ROOT / 'packages' / 'anchor-core' / 'src' / 'chars'
STUDIO = ROOT / 'studio'

# Windows 控制台默认 cp1252/gbk，中文 help 与诊断输出会 UnicodeEncodeError
# （CI windows-latest 上 --help 即崩，实测复现）。统一把 stdio 切到 UTF-8；
# errors='replace' 保证极端情况下只丢字符、不再因编码崩溃。
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')


def run(cmd, cwd=None, check=True, env=None):
    print('  $', subprocess.list2cmdline([str(x) for x in cmd]))
    # 子进程（sheet_gate/trace_design 等）打印 ✅/❌/中文，Windows cp1252 控制台会
    # UnicodeEncodeError（CI windows-latest gate 步骤实锤）。统一让子进程 stdio 用 UTF-8。
    child_env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    if env:
        child_env.update(env)
    r = subprocess.run([str(x) for x in cmd], cwd=cwd, shell=False, env=child_env)
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
    # 事务性 manifest（阶段 2 第 2+3 项）：每步记录命令/耗时/产物 hash，
    # 失败步骤也留痕（manifest 随每步落盘）——可解释、可诊断、可复现。
    manifest_path = CHARS / f'{key}.manifest.json'
    manifest: dict = {'key': key, 'sheet': str(sheet), 'schemaVersion': 1, 'steps': []}

    def flush():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n',
                                 encoding='utf-8')

    def step(name, script, *args_, artifact=None):
        t0 = time.time()
        try:
            py(script, *args_)
        except SystemExit as e:
            manifest['steps'].append({
                'step': name, 'script': script, 'ok': False,
                'ms': round((time.time() - t0) * 1000), 'error': str(e),
            })
            flush()
            print(f'  manifest（含失败步骤）已写 {manifest_path}')
            raise
        rec: dict = {'step': name, 'script': script, 'ok': True,
                     'ms': round((time.time() - t0) * 1000)}
        if artifact is not None and Path(artifact).is_file():
            rec['artifact'] = str(artifact)
            rec['sha256'] = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()
        manifest['steps'].append(rec)
        flush()

    print(f'[1/4] 合规闸门 {sheet}')
    step('gate', 'sheet_gate.py', sheet)
    print(f'[2/4] 描摹 {a.sheet} → {key}.json')
    step('trace', 'trace_design.py', 'auto', sheet, out, artifact=out)
    print('[3/4] 眼层拆分（lid / iris）')
    step('split-eyes', 'split_eye_layers.py', key, artifact=out)
    print('[4/4] 更新角色注册表')
    step('sync-registry', 'sync_char_registry.py')
    with out.open(encoding='utf-8') as f:
        d = json.load(f)
    movable = [(l['role'], l.get('side')) for l in d['layers'] if l.get('role')]
    print(f'\n✅ {key}: {len(d["layers"])} 层 · {len(movable)} 个可动件 {movable}')
    print(f'   skinBox {d["skinBox"]} · lipBox {d["lipBox"]}')
    print(f'   manifest: {manifest_path}')
    print(f'   下一步：codeavatar grid {key}')


def cmd_relayer(a):
    """局部重跑（阶段 2 第 4 项）：只重跑受影响步骤，不重跑全图描摹——
    避免为改一个部件重跑全流水线引入身份漂移。追加记录到 manifest。"""
    key = a.key
    char_json = CHARS / f'{key}.json'
    if not char_json.is_file():
        raise SystemExit(f'{char_json} 不存在（先 build）')
    manifest_path = CHARS / f'{key}.manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) \
        if manifest_path.is_file() else {'key': key, 'steps': []}
    t0 = time.time()
    try:
        if a.only == 'split-eyes':
            print(f'[relayer] 眼层拆分（只动 lid/iris 层）{key}')
            py('split_eye_layers.py', key)
        elif a.only == 'sync':
            print('[relayer] 更新角色注册表')
            py('sync_char_registry.py')
        else:
            raise SystemExit(f'未知步骤 {a.only}')
    except SystemExit as e:
        manifest['steps'].append({'step': a.only, 'script': 'relayer', 'ok': False,
                                  'ms': round((time.time() - t0) * 1000), 'error': str(e)})
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n',
                                 encoding='utf-8')
        raise
    manifest['steps'].append({
        'step': a.only, 'script': 'relayer', 'ok': True,
        'ms': round((time.time() - t0) * 1000),
        'sha256': hashlib.sha256(char_json.read_bytes()).hexdigest(),
        'artifact': str(char_json),
    })
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n',
                             encoding='utf-8')
    print(f'  manifest 已更新 {manifest_path}')


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


def validate_perf_or_exit(perf, source):
    """Perf 契约校验（阶段 1）：契约外值显式报错，禁止静默通过。
    错误语义与 TS validatePerf 一致（共享 perf-contract.json）。"""
    r = subprocess.run(
        [sys.executable, TOOLS / 'validate_perf.py', '--quiet'],
        input=json.dumps(perf, ensure_ascii=False),
        capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
    )
    if r.returncode == 3:
        sys.stderr.write(r.stderr)
        raise SystemExit(3)
    if r.returncode != 0:
        # 结构化错误列表复用校验器的 stderr（stdout 留给机器可读结果）
        detail = subprocess.run(
            [sys.executable, TOOLS / 'validate_perf.py'],
            input=json.dumps(perf, ensure_ascii=False),
            capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
        )
        sys.stderr.write(detail.stderr)
        raise SystemExit(2)


def cmd_render(a):
    props = {'char': a.key, 'layout': a.layout, 'bg': a.bg}
    if getattr(a, 'shot', 'full') != 'full':
        props['shot'] = a.shot
    if a.props:
        with Path(a.props).resolve().open(encoding='utf-8') as f:
            loaded = json.load(f)
        # --props 的文件是一个 Perf（含 fps/frames/gestures），必须挂在 props.perf
        # 传给 Presenter；直接平铺会让 perf 静默丢失，渲染成静态中性脸。
        if isinstance(loaded, dict) and 'perf' in loaded:
            props.update(loaded)
        else:
            props['perf'] = loaded
    if getattr(a, 'coarticulate', False):
        perf = props.get('perf')
        if isinstance(perf, dict):
            props['perf'] = {**perf, 'coarticulation': True}
        else:
            raise SystemExit('--coarticulate 需要 --props 提供 perf')
    if isinstance(props.get('perf'), dict):
        validate_perf_or_exit(props['perf'], a.props)
    if getattr(a, 'dry_run', False):
        if getattr(a, 'json_out', False):
            print(json.dumps({'ok': True, 'dryRun': True,
                              'out': str(Path(a.out).resolve())}, ensure_ascii=False))
        else:
            print(f'  [dry-run] 校验通过，未渲染。目标: {Path(a.out).resolve()}')
        return
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    props_file = write_props_file(props)
    try:
        remotion('render', 'TalkClip', out, '--props', props_file,
                 '--concurrency=1', '--log=error')
    finally:
        props_file.unlink(missing_ok=True)
    if getattr(a, 'json_out', False):
        perf = props.get('perf') or {}
        print(json.dumps({'ok': True, 'out': str(out),
                          'frames': len(perf.get('frames', [])),
                          'duration': perf.get('duration')}, ensure_ascii=False))
    else:
        print(f'  成片: {out}')


def cmd_say(a):
    """文本 → 表演合成 → 口播成片（阶段 3：确定性合成 + 诚实降级）。"""
    req = json.dumps({'text': a.text, 'pinyin': a.pinyin, 'sps': a.sps,
                      'motion': a.motion}, ensure_ascii=False)
    r = subprocess.run([sys.executable, TOOLS / 'say_perf.py'], input=req,
                       capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        raise SystemExit(f'表演合成失败（exit {r.returncode}）')
    perf = json.loads(r.stdout)
    validate_perf_or_exit(perf, 'say 合成产物（内部错误，请反馈）')
    meta = perf.get('meta') or {}
    # stdout/stderr 分离（§8）：--json 时 stdout 只留机器可读结果，诊断走 stderr
    say_info = (lambda s: sys.stderr.write(s + '\n')) if getattr(a, 'json_out', False) else print
    if meta.get('mode') == 'estimated':
        unk = ''.join(meta.get('unknownChars') or [])
        say_info('  ⚠ estimated 模式：中文逐字节奏估计，口型不保证对应发音；'
                 f'需音素对应请用 --pinyin 传拼音。未知字符：{unk or "无"}')
    else:
        say_info(f'  pinyin 模式：{len(perf["frames"])} 帧 / {perf["duration"]:.2f}s（音素视觉对应）')
    if a.coarticulate:
        perf['coarticulation'] = True
    if a.motion and not perf.get('motion'):
        raise SystemExit('--motion 生成的 perf 缺少 motion 轨（合成器未生效？）')
    props = {'char': a.key, 'layout': a.layout, 'bg': a.bg, 'perf': perf}
    if getattr(a, 'shot', 'full') != 'full':
        props['shot'] = a.shot
    out = Path(a.out).resolve()
    if getattr(a, 'dry_run', False):
        if getattr(a, 'json_out', False):
            print(json.dumps({'ok': True, 'dryRun': True,
                              'out': str(out), 'frames': len(perf['frames']),
                              'duration': perf['duration']}, ensure_ascii=False))
        else:
            print(f'  [dry-run] 合成与校验通过，未渲染。目标: {out}')
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    props_file = write_props_file(props)
    try:
        remotion('render', 'TalkClip', out, '--props', props_file,
                 '--concurrency=1', '--log=error')
    finally:
        props_file.unlink(missing_ok=True)
    if getattr(a, 'json_out', False):
        print(json.dumps({'ok': True, 'out': str(out),
                          'frames': len(perf['frames']),
                          'duration': perf['duration']}, ensure_ascii=False))
    else:
        print(f'  成片: {out}')


def cmd_still(a):
    """单帧静帧（身份回归/预览）：char + 可选 perf（单帧）→ PNG。"""
    props = {'char': a.key, 'layout': a.layout, 'bg': a.bg}
    if a.props:
        with Path(a.props).resolve().open(encoding='utf-8') as f:
            loaded = json.load(f)
        if isinstance(loaded, dict) and 'perf' in loaded:
            props.update(loaded)
        elif isinstance(loaded, dict) and 'frames' in loaded:
            # 裸 Perf（有 frames 无 perf 键）→ 挂到 props.perf
            props['perf'] = loaded
        else:
            props.update(loaded)  # 裸 props（char/layout/bg 等），无表演数据
        if isinstance(props.get('perf'), dict):
            validate_perf_or_exit(props['perf'], a.props)
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    props_file = write_props_file(props)
    try:
        remotion('still', 'CharStill', out, '--props', props_file, '--log=error')
    finally:
        props_file.unlink(missing_ok=True)
    print(f'  静帧: {out}')


def cmd_list(a):
    for f in sorted(CHARS.glob('*.json')):
        # manifest 是建角诊断产物（<key>.manifest.json），不是角色数据
        if not f.is_file() or f.name.endswith('.manifest.json'):
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
    r.add_argument('--shot', default='full', choices=['full', 'medium', 'closeup'],
                   help='镜头景别预设（构图）：full 全身 / medium 中景 / closeup 特写。'
                        '缺省 full 保持既有输出零漂移')
    r.add_argument('--bg', default='#141117')
    r.add_argument('--coarticulate', action='store_true',
                   help='口型共发音时间曲线（相邻口型平滑过渡+预塑形）。'
                        '默认关闭：已验收角色的输出必须零漂移，显式开启才生效')
    r.add_argument('--dry-run', action='store_true',
                   help='只做契约校验与路径检查，不渲染（退出码 0=可渲染）')
    r.add_argument('--json', dest='json_out', action='store_true',
                   help='stdout 输出结构化 JSON 结果（第三方集成）')
    r.set_defaults(fn=cmd_render)

    s = sub.add_parser('say', help='文本 → 表演 → 口播成片（确定性合成）')
    s.add_argument('key')
    s.add_argument('text', help='拼音（--pinyin，音素对应）或中文（节奏估计，诚实降级）')
    s.add_argument('-o', '--out', required=True)
    s.add_argument('--pinyin', action='store_true',
                   help='输入是拼音音节序列（音素视觉对应）；缺省按中文估计节奏')
    s.add_argument('--sps', type=float, default=5.5, help='音节速率（每秒音节数，默认 5.5）')
    s.add_argument('--coarticulate', action='store_true', help='开启共发音时间曲线')
    s.add_argument('--motion', action='store_true',
                   help='开启低幅动作轨：注视目标/眨眼节奏/头部预备-跟随-收势/呼吸')
    s.add_argument('--dry-run', action='store_true',
                   help='只合成与校验，不渲染')
    s.add_argument('--json', dest='json_out', action='store_true',
                   help='stdout 输出结构化 JSON 结果（第三方集成）')
    s.add_argument('--layout', default='full', choices=['full', 'pip'])
    s.add_argument('--shot', default='full', choices=['full', 'medium', 'closeup'],
                   help='镜头景别预设（构图）：缺省 full 保持既有输出零漂移')
    s.add_argument('--bg', default='#141117')
    s.set_defaults(fn=cmd_say)

    ls = sub.add_parser('list', help='列出角色')
    ls.set_defaults(fn=cmd_list)

    rl = sub.add_parser('relayer', help='局部重跑建角步骤（不重跑全图描摹，防身份漂移）')
    rl.add_argument('key')
    rl.add_argument('--only', required=True, choices=['split-eyes', 'sync'],
                    help='split-eyes=眼层拆分（前置条件：角色刚 trace 未拆分，'
                         '对已拆分角色重跑会因重定表引用原始层失败——需 build --force '
                         '整链重跑）/ sync=注册表（幂等）')
    rl.set_defaults(fn=cmd_relayer)

    st = sub.add_parser('still', help='单帧静帧 PNG（身份回归/预览）')
    st.add_argument('key')
    st.add_argument('-o', '--out', required=True)
    st.add_argument('--props', help='单帧表演 JSON（可选）')
    st.add_argument('--layout', default='full', choices=['full', 'pip'])
    st.add_argument('--bg', default='#141117')
    st.set_defaults(fn=cmd_still)

    a = p.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
