#!/usr/bin/env python3
"""Perf 契约校验（阶段 1）——Python 侧机器校验源。

契约来自 packages/anchor-core/schema/perf-contract.json（由 TS 常量
scripts/schema-dump.ts 生成入库，CI 断言与 TS 同步）——单一事实源，
两语言读同一份范围表。

用法：
  python tools/validate_perf.py out/perf.json        # 校验文件，错误列表到 stderr
  python tools/validate_perf.py --quiet out/perf.json  # 只看退出码

退出码：0 = 通过；2 = 契约违规（结构化错误列表）；3 = 环境缺失。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / 'packages' / 'anchor-core' / 'schema' / 'perf-contract.json'

EXIT_OK, EXIT_INVALID, EXIT_ENV = 0, 2, 3


def load_contract():
    if not CONTRACT.is_file():
        raise SystemExit(f'契约文件缺失：{CONTRACT}（exit {EXIT_ENV}）')
    return json.loads(CONTRACT.read_text(encoding='utf-8'))


def validate(perf, c):
    """返回错误列表 [{path, code, message}]。语义与 TS validatePerf 一致。"""
    errors = []

    def err(path, code, msg):
        errors.append({'path': path, 'code': code, 'message': msg})

    def rng(path, v, lo, hi, code='E_RANGE'):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            err(path, 'E_TYPE', f'期望数值，得到 {type(v).__name__}')
            return
        if v < lo or v > hi:
            err(path, code, f'值 {v} 超出契约范围 [{lo}, {hi}]')

    if not isinstance(perf, dict):
        return [{'path': '$', 'code': 'E_TYPE', 'message': 'Perf 必须是对象'}]

    v = perf.get('v', c['schemaVersion'])
    if v != c['schemaVersion']:
        err('$.v', 'E_SCHEMA_VERSION', f"schema 版本 {v} 不受支持（当前 {c['schemaVersion']}）")

    rng('$.fps', perf.get('fps'), *c['fps'])
    if isinstance(perf.get('fps'), float):
        err('$.fps', 'E_TYPE', 'fps 必须是整数')

    frames = perf.get('frames')
    if not isinstance(frames, list) or not frames:
        err('$.frames', 'E_MISSING', 'frames 必须是非空数组')
    else:
        fenum = c['frame']['m']['enum']
        for i, fr in enumerate(frames):
            p = f'$.frames[{i}]'
            if not isinstance(fr, dict):
                err(p, 'E_TYPE', '帧必须是对象')
                continue
            if fr.get('m') not in fenum:
                err(f'{p}.m', 'E_ENUM', f"口型必须是 {'/'.join(fenum)}，得到 {fr.get('m')!r}")
            for k in ('o', 'env', 'br', 'nd'):
                rng(f'{p}.{k}', fr.get(k), *c['frame'][k])
            gz = fr.get('gz')
            if isinstance(gz, list) and len(gz) == 2:
                for j, g in enumerate(gz):
                    rng(f'{p}.gz[{j}]', g, *c['frame']['gz'])
            else:
                err(f'{p}.gz', 'E_TYPE', 'gz 必须是二元数值数组')
        fps = perf.get('fps')
        dur = perf.get('duration')
        if isinstance(fps, int) and isinstance(dur, (int, float)):
            expect = len(frames) / fps
            if abs(dur - expect) > 1 / fps:
                err('$.duration', 'E_INCONSISTENT',
                    f'duration {dur} 与 frames.length/fps = {expect:.4f} 不符（容差 1 帧）')

    gestures = perf.get('gestures')
    if not isinstance(gestures, list):
        err('$.gestures', 'E_MISSING', 'gestures 必须是数组（可为空）')
    else:
        for i, g in enumerate(gestures):
            if isinstance(g, dict) and isinstance(g.get('t'), (int, float)) \
                    and isinstance(g.get('t1'), (int, float)) and g['t1'] < g['t']:
                err(f'$.gestures[{i}].t1', 'E_INCONSISTENT', f"t1 {g['t1']} < t {g['t']}")

    intent = perf.get('intent')
    if intent is not None:
        spans = intent.get('spans') if isinstance(intent, dict) else None
        if not isinstance(spans, list):
            err('$.intent.spans', 'E_MISSING', 'intent.spans 必须是数组')
        else:
            for i, s in enumerate(spans):
                p = f'$.intent.spans[{i}]'
                if not isinstance(s, dict):
                    err(p, 'E_TYPE', '意图 span 必须是对象')
                    continue
                if s.get('intent') not in c['intents']:
                    err(f'{p}.intent', 'E_ENUM',
                        f"意图必须是 {'/'.join(c['intents'])}，得到 {s.get('intent')!r}")
                rng(f'{p}.intensity', s.get('intensity', 0.8), 0, 1)

    motion = perf.get('motion')
    if isinstance(motion, dict):
        mc = c['motion']
        gaze = motion.get('gaze')
        if isinstance(gaze, dict):
            spans = gaze.get('spans')
            if not isinstance(spans, list):
                err('$.motion.gaze.spans', 'E_MISSING', 'gaze.spans 必须是数组')
            else:
                for i, s in enumerate(spans):
                    p = f'$.motion.gaze.spans[{i}].target'
                    t = s.get('target') if isinstance(s, dict) else None
                    if not isinstance(t, dict):
                        err(p, 'E_TYPE', 'gaze target 必须是对象')
                        continue
                    rng(f'{p}.x', t.get('x'), *mc['gazeTargetX'])
                    rng(f'{p}.y', t.get('y'), *mc['gazeTargetY'])
        blink = motion.get('blink')
        if isinstance(blink, dict):
            events = blink.get('events')
            if not isinstance(events, list):
                err('$.motion.blink.events', 'E_MISSING', 'blink.events 必须是数组')
            else:
                for i, e in enumerate(events):
                    if isinstance(e, dict):
                        rng(f'$.motion.blink.events[{i}].amp', e.get('amp', 1), *mc['blinkAmp'])
                        rng(f'$.motion.blink.events[{i}].rate', e.get('rate', 2), *mc['blinkRate'])
        head = motion.get('head')
        if isinstance(head, dict):
            spans = head.get('spans')
            if not isinstance(spans, list):
                err('$.motion.head.spans', 'E_MISSING', 'head.spans 必须是数组')
            else:
                for i, s in enumerate(spans):
                    if isinstance(s, dict):
                        for k in ('yaw', 'tilt', 'nod'):
                            if s.get(k) is not None:
                                rng(f'$.motion.head.spans[{i}].{k}', s[k], *mc['headYawTiltNod'])
        breath = motion.get('breath')
        if isinstance(breath, dict):
            rng('$.motion.breath.bpm', breath.get('bpm', 14), *mc['breathBpm'])

    return errors


def main():
    args = [a for a in sys.argv[1:] if a != '--quiet']
    quiet = '--quiet' in sys.argv
    try:
        if args:
            perf = json.loads(Path(args[0]).read_text(encoding='utf-8'))
        else:
            # 无文件参数 = stdin（供 CLI 进程内接线，避免临时文件）
            perf = json.loads(sys.stdin.read() or '{}')
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f'E_ENV 无法读取/解析 perf：{e}\n')
        raise SystemExit(EXIT_ENV)
    errors = validate(perf, load_contract())
    if errors:
        if not quiet:
            for e in errors:
                sys.stderr.write(f"{e['code']} {e['path']}: {e['message']}\n")
            sys.stderr.write(f'契约校验失败：{len(errors)} 项错误\n')
        raise SystemExit(EXIT_INVALID)
    if not quiet:
        print('契约校验通过')
    raise SystemExit(EXIT_OK)


if __name__ == '__main__':
    main()
