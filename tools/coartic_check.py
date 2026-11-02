#!/usr/bin/env python3
"""数值断言 runner（阶段 3 验收）。

用仓库内锁定的 esbuild 把断言入口（TS）打包为临时 CJS 后交给当前 node
执行，退出码透传（非 0 = 断言失败）。

用法：
  python tools/coartic_check.py                                   # 共发音层断言
  python tools/coartic_check.py packages/anchor-core/scripts/speech-check.ts
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENTRY = ROOT / 'packages' / 'anchor-core' / 'scripts' / 'coartic-check.ts'


def main():
    entry = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_ENTRY
    if not entry.is_file():
        raise SystemExit(f'找不到断言入口：{entry}')
    root_js = json.dumps(str(ROOT / 'package.json'))
    stub_src = f"""
    const {{ createRequire }} = require('module');
    const esbuild = createRequire({root_js})('esbuild');
    esbuild.build({{
      entryPoints: [{json.dumps(str(entry))}],
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
