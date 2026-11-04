#!/usr/bin/env python3
"""火山豆包 TTS 2.0 客户端（异步任务 + 字级时间戳）。

  python tools/tts_volc.py "要念的文稿" -o out/tts-volc [--speaker zh_male_liufei_uranus_bigtts]
  python tools/tts_volc.py --check          # 只校验凭据与连通性，不合成

凭据只从环境变量或本地未入库文件读（**不写进代码、不进仓库、不打印**）：
  $VOLC_TTS_API_KEY
  或 仓库根 .volc.env（格式：VOLC_TTS_API_KEY=xxx，已在 .gitignore 的 *volc* 规则内）

产出（与 docs 契约一致，下游直接吃）：
  <out>/voice.mp3       48k 单声道 mp3
  <out>/words.json      字级时间戳，恒为数组
  <out>/words.meta.json 引擎/音色/estimated=false/task_id

文档里 6 个坑的处置：
  坑1 resource 与音色不匹配   → 只接受 *_uranus_bigtts，给错立刻本地报错（省一次请求）
  坑2 参数层级错 → 静默失效   → 参数写死在 audio_params 内，并有断言脚本守
  坑3 mp3 需 48000 才有时间戳 → sample_rate 写死 48000，回包无 sentences 直接报错
  坑4 audio_url 1 小时过期    → 现取现下，不落库
  坑5 非法字符 >10% 拒单      → 提交前清洗 \x00-\x08\x0b\x0c\x0e-\x1f
  坑6 loudness_rate 不可靠    → 不做响度承诺，交给混流前的 loudnorm
"""
import json
import os
import re
import sys
import time
import uuid
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://openspeech.bytedance.com/api/v3/tts'
RESOURCE_ID = 'seed-tts-2.0'
OK = 20000000
DEFAULT_SPEAKER = 'zh_male_liufei_uranus_bigtts'
SPEAKERS = {
    'male': 'zh_male_liufei_uranus_bigtts',      # 刘飞，讲述型
    'female': 'zh_female_vv_uranus_bigtts',      # VV，情感向
}
ILLEGAL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def load_key() -> str:
    key = os.environ.get('VOLC_TTS_API_KEY', '').strip()
    if key:
        return key
    env_file = ROOT / '.volc.env'
    if env_file.is_file():
        for line in env_file.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line.startswith('VOLC_TTS_API_KEY='):
                return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit(
        '缺少火山 TTS 凭据。二选一（key 不会进仓库）：\n'
        '  1) 设环境变量 VOLC_TTS_API_KEY\n'
        '  2) 在仓库根建 .volc.env，内容一行：VOLC_TTS_API_KEY=xxx（已被 .gitignore 的 *volc* 覆盖）')


def _post(url: str, body: dict, key: str) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'X-Api-Key': key,
            'X-Api-Resource-Id': RESOURCE_ID,
            'X-Api-Request-Id': str(uuid.uuid4()),
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            logid = resp.headers.get('x-tt-logid', '(无 logid)')
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:400]
        raise SystemExit(f'HTTP {e.code} 请求失败：{detail}') from e
    if data.get('code') != OK:
        raise SystemExit(f"tts 失败 code={data.get('code')} "
                         f"message={data.get('message')} logid={logid}")
    return data['data']


def check_speaker(speaker: str) -> None:
    if not speaker.endswith('_uranus_bigtts'):
        raise SystemExit(
            f'音色 {speaker} 与 resource {RESOURCE_ID} 不匹配：只接受 *_uranus_bigtts 系列\n'
            f'（moon_bigtts 等会报 55000000；可选：{", ".join(SPEAKERS.values())}）')


def synthesize(text: str, out_dir: Path, speaker: str, key: str,
               speech_rate: int = 10) -> dict:
    check_speaker(speaker)
    text = ILLEGAL.sub('', text)
    if not text.strip():
        raise SystemExit('文本为空（清洗非法字符后）')

    task_id = str(uuid.uuid4())
    _post(f'{BASE}/submit', {
        'user': {'uid': 'codeavatar'},
        'unique_id': task_id,
        'req_params': {
            'text': text,
            'speaker': speaker,
            'audio_params': {
                'format': 'mp3',
                'sample_rate': 48000,        # 坑3：必须 48000，否则时间戳丢失
                'speech_rate': speech_rate,  # 坑2：必须在 audio_params 内
                'enable_timestamp': True,
            },
            'explicit_language': 'zh-cn',
            'disable_markdown_filter': True,
        },
    }, key)

    deadline = time.time() + 300
    while True:
        d = _post(f'{BASE}/query', {'task_id': task_id}, key)
        st = d.get('task_status')
        if st == 2:
            break
        if st == 3:
            raise SystemExit(f'tts 任务失败 task_id={task_id} message={d.get("message")}')
        if time.time() > deadline:
            raise SystemExit(f'tts 轮询超时 task_id={task_id}')
        time.sleep(2)

    out_dir.mkdir(parents=True, exist_ok=True)
    audio_path = out_dir / 'voice.mp3'
    with urllib.request.urlopen(d['audio_url'], timeout=120) as r:
        buf = r.read()
    if len(buf) < 1024:
        raise SystemExit(f'音频过小 {len(buf)} B，疑似失败')
    audio_path.write_bytes(buf)

    sentences = d.get('sentences') or []
    if not sentences:
        raise SystemExit('sentences 为空：检查 enable_timestamp 是否在 audio_params 内、'
                         'sample_rate 是否 48000（坑2/坑3）')
    segments = []
    for s in sentences:
        words = [{'w': w['word'],
                  's': round(w['startTime'], 3),
                  'e': round(w['endTime'], 3),
                  'p': round(w.get('confidence', 1.0), 3)} for w in s.get('words', [])]
        if not words:
            raise SystemExit(f"分句没有字级时间戳：{(s.get('text') or '')[:12]}")
        segments.append({'start': round(s['startTime'], 3),
                         'end': round(s['endTime'], 3),
                         'text': s['text'],
                         'words': words})

    flat = [w for seg in segments for w in seg['words']]
    for i in range(1, len(flat)):
        if flat[i]['s'] < flat[i - 1]['s']:
            raise SystemExit(f"字级时间戳非单调，第 {i} 字「{flat[i]['w']}」")

    (out_dir / 'words.json').write_text(
        json.dumps(segments, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (out_dir / 'words.meta.json').write_text(
        json.dumps({'engine': 'volc-doubao-tts-2.0', 'speaker': speaker,
                    'estimated': False, 'task_id': task_id,
                    'segments': len(segments), 'chars': len(flat)},
                   ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    return {'ok': True, 'task_id': task_id, 'audio': str(audio_path),
            'bytes': len(buf), 'segments': len(segments), 'chars': len(flat),
            'speech_first': flat[0]['s'], 'speech_last': flat[-1]['e']}


def main(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(description='火山豆包 TTS 2.0（字级时间戳）')
    p.add_argument('text', nargs='?')
    p.add_argument('-o', '--out', help='输出目录（voice.mp3 / words.json / words.meta.json）')
    p.add_argument('--speaker', default=DEFAULT_SPEAKER,
                   help=f'音色；也可写 male/female（默认 {DEFAULT_SPEAKER}）')
    p.add_argument('--rate', type=int, default=10, help='语速 [-50,100]，默认 10')
    p.add_argument('--check', action='store_true', help='只校验凭据（不合成）')
    a = p.parse_args(argv)

    key = load_key()
    if a.check:
        print(json.dumps({'ok': True, 'keyFound': True,
                          'keyLength': len(key), 'speakers': SPEAKERS},
                         ensure_ascii=False))
        return 0
    if not a.text or not a.out:
        p.error('需要 text 与 -o/--out（或 --check）')
    speaker = SPEAKERS.get(a.speaker, a.speaker)
    r = synthesize(a.text, Path(a.out).resolve(), speaker, key, a.rate)
    print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
