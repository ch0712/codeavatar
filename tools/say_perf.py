#!/usr/bin/env python3
"""文本 → Perf 合成 runner。

用仓库内锁定的 esbuild 打包 packages/anchor-core/scripts/say-perf.ts，
stdin 传 JSON 请求，stdout 取 Perf JSON（唯一 stdout 输出，日志走 stderr）。

用法：echo '{"text":"...","pinyin":true}' | python tools/say_perf.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'packages' / 'anchor-core' / 'scripts' / 'say-perf.ts'


def main():
    request = sys.stdin.read()
    if not ENTRY.is_file():
        raise SystemExit(f'找不到合成入口：{ENTRY}')
    node = shutil.which('node')
    if not node:
        raise SystemExit('未找到 Node.js，请安装并加入 PATH')
    with tempfile.TemporaryDirectory() as td:
        outfile = Path(td) / 'say-perf.cjs'
        stub = Path(td) / 'build.cjs'
        stub_src = (
            "const { createRequire } = require('module');\n"
            f"const esbuild = createRequire({json.dumps(str(ROOT / 'package.json'))})('esbuild');\n"
            "esbuild.build({\n"
            f"  entryPoints: [{json.dumps(str(ENTRY))}],\n"
            "  bundle: true, platform: 'node', format: 'cjs',\n"
            f"  outfile: {json.dumps(str(outfile))}, logLevel: 'silent',\n"
            "}).catch((e) => { console.error(e.message); process.exit(2); });\n"
        )
        stub.write_text(stub_src, encoding='utf-8')
        b = subprocess.run([node, str(stub)], cwd=ROOT)
        if b.returncode != 0:
            raise SystemExit(f'esbuild 打包失败（exit {b.returncode}）')
        r = subprocess.run(
            [node, str(outfile)], cwd=ROOT, input=request,
            capture_output=True, text=True, encoding='utf-8',
        )
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            raise SystemExit(f'合成失败（exit {r.returncode}）')
        if r.stderr:
            sys.stderr.write(r.stderr)
        sys.stdout.write(r.stdout)


if __name__ == '__main__':
    main()
