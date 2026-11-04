#!/usr/bin/env python3
"""仓库卫生检查（§8 验收清单第 6 项 + 许可证扫描）。

场景：
  python tools/repo_hygiene.py licenses   # 第三方依赖许可证扫描（归类汇总）
  python tools/repo_hygiene.py files      # CRLF / 权限位 / 构建脚本边界
  python tools/repo_hygiene.py docs       # 发布物料齐备 + 双语 README 结构一致
退出码：0 = 通过（或仅 NOTE 级）；1 = 有 FAIL 级问题。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
failures = 0


def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name}{' | ' + detail if detail else ''}")
    if not ok:
        failures += 1


def scan_licenses():
    """node_modules 顶层包 + workspace 包的 license 字段归类。"""
    counts: dict = {}
    unknown = []
    for pkg_json in (ROOT / 'node_modules').glob('*/package.json'):
        try:
            d = json.loads(pkg_json.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        lic = d.get('license')
        lic = lic if isinstance(lic, str) else json.dumps(lic) if lic else '(none)'
        counts[lic] = counts.get(lic, 0) + 1
    for ws in ('packages/anchor-core', ):
        d = json.loads((ROOT / ws / 'package.json').read_text(encoding='utf-8'))
        counts[f'(workspace) {ws}: {d.get("license")}'] = 1
    for lic, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f'  {n:5d}  {lic}')
    # 供应链红旗：GPL 系进依赖会让"开源发布"需要谨慎核对
    flags = [k for k in counts if 'GPL' in k.upper() and 'LGPL' not in k.upper()]
    check('无 GPL 系依赖（避免强传染条款混入发布物）', not flags, ', '.join(flags))
    check('无未知 license 占比异常', counts.get('(none)', 0) <= 5,
          f"none={counts.get('(none)', 0)}")


def scan_files():
    """CRLF 检查基于 git index（i/ 列）——工作区行尾由 .gitattributes/autocrlf
    管理，仓库内行尾才是跨平台一致性的本体。"""
    import subprocess
    r = subprocess.run(
        ['git', 'ls-files', '--eol', '*.py', '*.ts', '*.tsx', '*.md', '*.json'],
        capture_output=True, text=True, encoding='utf-8', cwd=ROOT,
    )
    bad_crlf = []
    for line in (r.stdout or '').splitlines():
        fields = line.split('\t')
        # git ls-files --eol 格式：i/<eol>\tw/<eol>\t<attr>\t<path>
        if len(fields) >= 4 and fields[0].startswith('i/') and 'crlf' in fields[0]:
            bad_crlf.append(f'{fields[0]} {fields[-1]}')
    check('git index 源文件全部 LF（跨平台一致性）', not bad_crlf, '; '.join(bad_crlf[:6]))
    # Windows 不依赖 bash 才能完成主流程：tools/ 下没有 .sh 作为主入口
    sh_files = [str(f.relative_to(ROOT)) for f in (ROOT / 'tools').glob('*.sh')]
    check('tools/ 无 bash 主入口（Windows 主流程不依赖 bash）', not sh_files, ', '.join(sh_files))


def scan_docs():
    """发布物料与双语 README 一致性。

    双语 README 的真源是两份文件，漂移靠机检而不是靠记性：章节数必须相等，
    且互有语言切换链接。译文措辞不同属正常，只断结构可比的那部分。
    """
    import re
    required = ['LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
                'docs/LICENSES.md', 'README.md', 'README.en.md']
    missing = [f for f in required if not (ROOT / f).is_file()]
    check('发布物料齐备', not missing, '缺失: ' + ', '.join(missing))

    def headings(p):
        text = (ROOT / p).read_text(encoding='utf-8')
        return [ln for ln in text.splitlines() if re.match(r'^##\s+\S', ln)]

    zh, en = headings('README.md'), headings('README.en.md')
    check('双语 README 章节数一致', len(zh) == len(en),
          f'zh={len(zh)} en={len(en)}')
    zh_text = (ROOT / 'README.md').read_text(encoding='utf-8')
    en_text = (ROOT / 'README.en.md').read_text(encoding='utf-8')
    check('两份 README 互有语言切换链接',
          'README.en.md' in zh_text and 'README.md' in en_text)
    # 代码块数量也是结构信号：译文漏抄整段命令会在这里暴露
    fences = lambda t: t.count('```') // 2
    check('双语 README 代码块数量一致', fences(zh_text) == fences(en_text),
          f"zh={fences(zh_text)} en={fences(en_text)}")


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'licenses':
        scan_licenses()
    elif mode == 'files':
        scan_files()
    elif mode == 'docs':
        scan_docs()
    else:
        print(__doc__)
        raise SystemExit(0 if not failures else 1)
    raise SystemExit(1 if failures else 0)
