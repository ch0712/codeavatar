// 契约固化：从 TS 常量生成 perf-contract.json 入库（Python 侧共享的机器校验源）。
// CI 断言该文件与 TS 常量同步（重新生成后 diff 为空）——防止两份契约各自腐烂。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/schema-dump.ts
import { writeFileSync } from 'fs';
import { join } from 'path';
import { perfContractJson } from '../src/schema';

const dest = join(process.cwd(), 'packages', 'anchor-core', 'schema', 'perf-contract.json');
writeFileSync(dest, JSON.stringify(perfContractJson(), null, 2) + '\n', 'utf-8');
console.log(`契约写入 ${dest}`);
