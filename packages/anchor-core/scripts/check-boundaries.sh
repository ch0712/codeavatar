#!/usr/bin/env bash
# @anchor/core 边界机检 —— 「这个包随时可以被提走」的三条判据。
# 任何一条失败 = 包已经和 autocut 缠在一起，必须先修再提交。
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1) core 内不许出现上级目录引用（只许 './' 与包名）
if grep -rnE "from '\.\./|from \"\.\./" src/ --include=*.ts --include=*.tsx >/tmp/_core_bref 2>/dev/null; then
  echo "❌ 判据1：core 内出现 ../ 引用（包不再自包含）"; cat /tmp/_core_bref; fail=1
else
  echo "✅ 判据1：无 ../ 引用"
fi

# 2) 运行期依赖只许 peer（react / remotion）
deps=$(python3 - <<'PY'
import json
p=json.load(open('package.json'))
print(' '.join(p.get('dependencies',{})))
PY
)
if [ -n "${deps// /}" ]; then
  echo "❌ 判据2：出现运行期 dependencies（应为 peer）：$deps"; fail=1
else
  echo "✅ 判据2：无运行期 dependencies，仅 peer（react/remotion）"
fi

# 3) 不许 import 消费方的片子数据或项目路径（只看 import 行，注释里的说明不算）
if grep -rnE "^import .*(anchor/data|refs/dhk|render/film)" src/ --include=*.ts --include=*.tsx >/tmp/_core_bref2 2>/dev/null; then
  echo "❌ 判据3：core 引用了消费方的片子数据或路径"; cat /tmp/_core_bref2; fail=1
else
  echo "✅ 判据3：未引用任何消费方路径"
fi

# 4) 角色数据只能有一份（chars/*.json 之外不许再出现同名副本）
dup=$(cd /H/.hermes/workspace/autocut && find . -path ./node_modules -prune -o -name 'no4.json' -print 2>/dev/null | grep -v node_modules | wc -l)
if [ "$dup" -ne 1 ]; then
  echo "❌ 判据4：no4.json 出现 $dup 份（单一事实源被破坏）"
  (cd /H/.hermes/workspace/autocut && find . -path ./node_modules -prune -o -name 'no4.json' -print 2>/dev/null | grep -v node_modules)
  fail=1
else
  echo "✅ 判据4：角色数据唯一一份"
fi

exit $fail
