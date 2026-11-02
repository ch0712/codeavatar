"""Cross-platform checks for the @anchor/core package boundary."""
import os
from pathlib import Path
import re
import sys

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
SOURCE = PACKAGE / 'src'
SCAN = Path(os.environ.get('CODEAVATAR_SCAN', str(ROOT))).resolve()
FAILURES = 0


def check(condition, success, failure):
    global FAILURES
    if condition:
        print(f'PASS {success}')
    else:
        print(f'FAIL {failure}')
        FAILURES += 1


sources = [*SOURCE.rglob('*.ts'), *SOURCE.rglob('*.tsx')]
outside_imports = []
consumer_imports = []
for path in sources:
    content = path.read_text(encoding='utf-8')
    for line_no, line in enumerate(content.splitlines(), 1):
        if re.search(r"\bfrom\s+['\"]\.\./", line):
            outside_imports.append(f'{path.relative_to(ROOT)}:{line_no}:{line.strip()}')
        if re.match(r"\s*import\b.*(?:anchor/data|refs/dhk|render/film)", line):
            consumer_imports.append(f'{path.relative_to(ROOT)}:{line_no}:{line.strip()}')
check(not outside_imports, 'core has no parent-relative imports', '\n'.join(outside_imports))

import json
package = json.loads((PACKAGE / 'package.json').read_text(encoding='utf-8'))
dependencies = package.get('dependencies', {})
check(not dependencies, 'core has no runtime dependencies', f'runtime dependencies: {dependencies}')
check(not consumer_imports, 'core imports no consumer project data', '\n'.join(consumer_imports))

try:
    matches = [p for p in SCAN.rglob('no4.json') if 'node_modules' not in p.parts]
except OSError as exc:
    print(f'FAIL cannot scan {SCAN}: {exc}')
    sys.exit(2)
check(len(matches) == 1, f'no4.json is unique under {SCAN}',
      f'found {len(matches)} copies under {SCAN}: {[str(p) for p in matches]}')
sys.exit(1 if FAILURES else 0)
