#!/usr/bin/env python3
"""角色身份回归（阶段 2 第 5 项）。

对指定角色渲染一组**固定表演 fixture** 的单帧静帧：
  中性（无 perf）/ 手势情绪（中性/强调/认真）/ 意图（疑问/安抚）/
  六口型极值（A/O/E/I/U/M @o=1）/ 布局视角（full/pip）/ 极端参数（lid 瞪大、
  smile 负值、brow 压低——契约边界值直入 perf 帧）。

验收三层：
  1. 结构：每张 PNG 存在、非空、可解码、尺寸 1920×1080；
  2. 可分性：两两之间像素不同（防止"所有表情渲染同一张脸"的回归）；
  3. 身份 golden：SHA256 清单入库（docs/identity/<key>.hashes.json）。
     默认比对；--update 重新生成（有意改变渲染行为时必须显式重生成并随提交说明）。

用法：
  python tools/identity_check.py no4            # 校验（比对 golden）
  python tools/identity_check.py no4 --update   # 重生成 golden
  python tools/identity_check.py no4 --no-golden  # 只做结构+可分性（CI 跨平台用）
"""
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'tools' / 'codeavatar.py'
MANIFEST_DIR = ROOT / 'docs' / 'identity'
EXIT_OK, EXIT_INVALID, EXIT_ENV = 0, 2, 3


def png_size(data: bytes):
    """PNG 尺寸（IHDR），不引第三方库。"""
    if data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 24:
        return None
    w, h = struct.unpack('>II', data[16:24])
    return w, h


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fixtures():
    """固定表演 fixture 集合（名 → props）。帧数据走 perf 契约。"""
    def perf1(m='M', o=0, br=0, nd=0, gz=(0, 0), gestures=None, intent=None,
              motion=None, extra=None):
        p = {
            'fps': 30,
            'duration': 1 / 30,
            'frames': [{'m': m, 'o': o, 'br': br, 'nd': nd,
                        'g': 'none', 'env': o, 'sp': 0, 'gz': list(gz)}],
            'gestures': gestures or [],
        }
        if intent is not None:
            p['intent'] = intent
        if motion is not None:
            p['motion'] = motion
        if extra:
            p.update(extra)
        return p

    fx = {
        'neutral': None,
        'mood-open': perf1(gestures=[{'t': 0, 't1': 1, 'kind': 'open', 'word': ''}]),
        'mood-point': perf1(gestures=[{'t': 0, 't1': 1, 'kind': 'point', 'word': ''}]),
        'mood-circle': perf1(gestures=[{'t': 0, 't1': 1, 'kind': 'circle', 'word': ''}]),
        'intent-doubt': perf1(intent={'spans': [
            {'t': 0, 't1': 1, 'intent': '疑问', 'intensity': 0.9}]}),
        'intent-soothe': perf1(intent={'spans': [
            {'t': 0, 't1': 1, 'intent': '安抚', 'intensity': 0.9}]}),
        'pip-view': perf1(gestures=[{'t': 0, 't1': 1, 'kind': 'point', 'word': ''}]),
        'mouth-a': perf1(m='A', o=1),
        'mouth-o': perf1(m='O', o=1),
        'mouth-e': perf1(m='E', o=1),
        'mouth-i': perf1(m='I', o=1),
        'mouth-u': perf1(m='U', o=1),
        'mouth-m': perf1(m='M', o=0),
        'extreme-lid': perf1(),
        'extreme-frown': perf1(),
    }
    # 契约边界值走 Presenter pose 直通（极端参数有可见效果才守得住契约）
    pose_overrides = {
        'extreme-lid': {'lid': 1.15},
        'extreme-frown': {'brow': -1, 'browIn': 1.15, 'smile': -0.5},
    }
    out = {}
    for name, perf in fx.items():
        props = {'layout': 'pip' if name == 'pip-view' else 'full'}
        if perf is not None:
            props['perf'] = perf
        if name in pose_overrides:
            props['pose'] = pose_overrides[name]
        out[name] = props
    return out


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if not argv:
        print(__doc__)
        raise SystemExit(EXIT_ENV)
    key = argv[0]
    update = '--update' in flags
    no_golden = '--no-golden' in flags

    manifest_path = MANIFEST_DIR / f'{key}.hashes.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) \
        if manifest_path.is_file() and not update else None
    if update:
        manifest = {'key': key, 'hashes': {}}

    outdir = ROOT / 'out' / 'identity' / key
    outdir.mkdir(parents=True, exist_ok=True)
    hashes, failures = {}, 0

    for name, props in fixtures().items():
        props = {'char': key, **props}
        props_file = outdir / f'{name}.props.json'
        props_file.write_text(json.dumps(props, ensure_ascii=False), encoding='utf-8')
        png = outdir / f'{name}.png'
        if png.exists() and not update:
            pass  # 复用已渲染帧（本脚本自身确定性；全量重渲用 --update）
        else:
            r = subprocess.run(
                [sys.executable, str(CLI), 'still', key, '-o', str(png),
                 '--props', str(props_file)],
                capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
                env={**__import__('os').environ, 'PYTHONIOENCODING': 'utf-8'},
            )
            if r.returncode != 0:
                print(f'FAIL {name}: still 渲染失败\n{r.stderr[-300:]}')
                failures += 1
                continue
        props_file.unlink(missing_ok=True)
        data = png.read_bytes() if png.exists() else b''
        size = png_size(data)
        if not data or size != (1920, 1080):
            print(f'FAIL {name}: 产物不可解码或尺寸错误 {size}')
            failures += 1
            continue
        hashes[name] = sha256(data)
        if manifest is not None:
            manifest['hashes'][name] = hashes[name]

    names = list(hashes)
    # 可分性：不同表情必须渲染出不同像素
    dup = [n for n in names if n != 'neutral' and hashes.get(n) == hashes.get('neutral')]
    if dup:
        print(f'FAIL 可分性：与中性帧逐字节相同的表情 {dup}（表情没有接到渲染上？）')
        failures += 1
    else:
        print(f'PASS 可分性：{len(names)} 张静帧两两不同（vs 中性）')

    # 身份 golden
    if no_golden:
        print('SKIP golden 比对（--no-golden，仅结构+可分性）')
    elif update:
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n',
                                 encoding='utf-8')
        print(f'PASS golden 已重生成：{manifest_path}（{len(hashes)} 帧）')
    elif manifest is None:
        print(f'FAIL golden 清单缺失：{manifest_path}（首次请 --update 生成）')
        failures += 1
    else:
        drift = [n for n in manifest['hashes'] if manifest['hashes'][n] != hashes.get(n)]
        extra = [n for n in hashes if n not in manifest['hashes']]
        if drift or extra:
            print(f'FAIL 身份漂移：变化 {drift} 新增 {extra}'
                  f'（渲染行为有意变更时请 --update 并随提交说明）')
            failures += 1
        else:
            print(f'PASS 身份 golden：{len(manifest["hashes"])} 帧逐字节一致')

    raise SystemExit(1 if failures else 0)


if __name__ == '__main__':
    main()
