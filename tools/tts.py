#!/usr/bin/env python3
"""文本 → 语音（TTS），供口播成片的音轨使用。

  python tools/tts.py "今天讲一下口型同步。" -o out/tts.mp3
  python tools/tts.py --list-voices | grep zh      # 列音色（原样透传 edge-tts）

引擎：优先 edge-tts（微软在线神经音色，质量好，需联网）；不可用时回退
pyttsx3（离线 SAPI，音色机械但可用）。stdout 只输出机器可读 JSON
（诊断走 stderr），duration 用 ffprobe 实测——这是 say --audio 对齐的依据。
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'


def probe_duration(path: Path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(r.stdout.strip()), 3)
    except (ValueError, AttributeError):
        return None


def synth_edge(text: str, out: Path, voice: str, rate: str) -> None:
    import asyncio
    import edge_tts

    async def run():
        await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
    asyncio.run(run())


def synth_pyttsx3(text: str, out: Path, voice: str, rate: str) -> None:
    try:
        import pyttsx3
    except ImportError as e:
        raise SystemExit('没有可用的 TTS 引擎。安装其一：\n'
                         '  pip install edge-tts   （在线，音质好）\n'
                         '  pip install pyttsx3    （离线，音质一般）') from e
    engine = pyttsx3.init()
    if voice:
        for v in engine.getProperty('voices'):
            if voice.lower() in (v.id + v.name).lower():
                engine.setProperty('voice', v.id)
                break
    if rate:
        try:
            engine.setProperty('rate', int(float(rate.strip('+%')) or 180))
        except ValueError:
            pass
    engine.save_to_file(text, str(out))
    engine.runAndWait()


def main(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(description='文本转语音（口播音轨）')
    p.add_argument('text', nargs='?', help='要念的文本')
    p.add_argument('-o', '--out', help='输出音频（mp3/wav）')
    p.add_argument('--voice', default=DEFAULT_VOICE, help=f'音色（默认 {DEFAULT_VOICE}）')
    p.add_argument('--rate', default='+0%', help='语速，如 +10%% / -15%%')
    p.add_argument('--list-voices', action='store_true', help='列出可用音色（透传 edge-tts）')
    a = p.parse_args(argv)

    if a.list_voices:
        try:
            import asyncio
            import edge_tts
            voices = asyncio.run(edge_tts.list_voices())
            for v in voices:
                if v['Locale'].startswith('zh'):
                    print(f"{v['ShortName']}\t{v['Gender']}")
            return 0
        except ImportError:
            raise SystemExit('--list-voices 需要 edge-tts：pip install edge-tts')

    if not a.text or not a.out:
        p.error('需要 text 与 -o/--out（或 --list-voices）')
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    engine = 'edge-tts'
    try:
        synth_edge(a.text, out, a.voice, a.rate)
    except Exception as e:  # 网络不通/包损坏 → 离线兜底
        sys.stderr.write(f'edge-tts 失败（{type(e).__name__}），回退 pyttsx3 离线引擎\n')
        engine = 'pyttsx3'
        synth_pyttsx3(a.text, out, a.voice, a.rate)

    if not out.exists() or out.stat().st_size == 0:
        raise SystemExit('TTS 未产出音频文件')
    dur = probe_duration(out)
    print(json.dumps({'ok': True, 'engine': engine, 'voice': a.voice,
                      'out': str(out), 'duration': dur}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
