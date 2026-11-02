#!/usr/bin/env python3
"""共发音层数值断言 runner（阶段 3 第 1 项验收）。

用仓库内锁定的 esbuild 把 packages/anchor-core/scripts/coartic-check.ts
打包为临时 CJS 后交给当前 node 执行，退出码透传（非 0 = 断言失败）。

用法：python tools/coartic_check.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'packages' / 'anchor-core' / 'scripts' / 'coartic-check.ts'


def main():
    if not ENTRY.is_file():
        raise SystemExit(f'找不到断言入口：{ENTRY}')
    root_js = json.dumps(str(ROOT / 'package.json'))
    stub_src = f"""
    const {{ createRequire }} = require('module');
    const esbuild = createRequire({root_js})('esbuild');
    esbuild.build({{
      entryPoints: [{json.dumps(str(ENTRY))}],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: {{outfile}},
      logLevel: 'silent',
    }}).catch((e) => {{ console.error(e.message); process.exit(2); }});
    """
    with tempfile.TemporaryDirectory() as td:
        outfile = Path(td) / 'coartic-check.cjs'
        stub = Path(td) / 'build.cjs'
        stub.write_text(stub_src.replace('{outfile}', json.dumps(str(outfile))), encoding='utf-8')
        node = shutil.which('node')
        if not node:
            raise SystemExit('未找到 Node.js，请安装并加入 PATH')
        b = subprocess.run([node, str(stub)], cwd=ROOT)
        if b.returncode != 0:
            raise SystemExit(f'esbuild 打包失败（exit {b.returncode}）')
        t = subprocess.run([node, str(outfile)], cwd=ROOT)
        raise SystemExit(t.returncode)


if __name__ == '__main__':
    main()
