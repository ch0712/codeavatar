// Performance schema 契约数值断言（阶段 1 第 1+2 项验收）。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/schema-check.ts
import { validatePerf, perfContractJson, PERF_SCHEMA_VERSION } from '../src/schema';
import { POSE_RANGES, MOODS } from '../src/types';
import { synthesizePerf } from '../src/speech';
import { readFileSync } from 'fs';
import { join } from 'path';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};
const codes = (p: unknown, pathSuffix: string) =>
  validatePerf(p).errors.filter((e) => e.path.endsWith(pathSuffix)).map((e) => e.code);

// 1) 合法产物通过：三种来源
const synth = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true });
const synthM = synthesizePerf('ni3 hao3!', { pinyin: true, motion: true, style: { headGazeCouple: 0.3 } });
check('合法 perf（纯帧）通过契约', validatePerf(synth).ok, JSON.stringify(validatePerf(synth).errors));
check('合法 perf（含 intent+motion+style）通过契约', validatePerf(synthM).ok, JSON.stringify(validatePerf(synthM).errors.slice(0, 3)));

// 2) 枚举 / 范围 / 结构 / 一致性 / 版本
const bad = JSON.parse(JSON.stringify(synth));
bad.frames[0].m = 'X';
check('非法口型 → E_ENUM', codes(bad, '.m')[0] === 'E_ENUM');
bad.frames[1].o = 1.5;
check('音节包络越界 → E_RANGE', codes(bad, 'frames[1].o')[0] === 'E_RANGE');
bad.frames[2].gz = [0];
check('gz 非二元 → E_TYPE', codes(bad, 'frames[2].gz')[0] === 'E_TYPE');
bad.duration = 99;
check('duration 与帧数不符 → E_INCONSISTENT', codes(bad, '$.duration')[0] === 'E_INCONSISTENT');
const empty = { ...synth, frames: [] };
check('空帧表 → E_MISSING', codes(empty, '$.frames')[0] === 'E_MISSING');
check('未来版本 → E_SCHEMA_VERSION', codes({ ...synth, v: PERF_SCHEMA_VERSION + 1 }, '$.v')[0] === 'E_SCHEMA_VERSION');
check('非法意图 → E_ENUM', codes(
  { ...synth, intent: { spans: [{ t: 0, t1: 1, intent: '愤怒' }] } }, '.intent')[0] === 'E_ENUM');

// 3) motion 轨范围（与渲染 clamp 一致）
const badM = JSON.parse(JSON.stringify(synthM));
badM.motion.gaze.spans[0].target.x = 2;
check('gaze target 越界 → E_RANGE', codes(badM, 'target.x')[0] === 'E_RANGE');
badM.motion.head.spans[0].nod = 3;
check('head nod 越界 → E_RANGE', codes(badM, '.nod').includes('E_RANGE'));

// 4) 错误截断上限
const many = JSON.parse(JSON.stringify(synth));
for (let i = 0; i < 100 && i < many.frames.length; i++) many.frames[i].o = 5;
const manyRes = validatePerf(many);
check('错误数截断 ≤50', manyRes.errors.length <= 50, `n=${manyRes.errors.length}`);

// 5) 契约与既有预设不打架：所有 MOODS 值都在 POSE_RANGES 内
let moodViolations = '';
for (const [name, m] of Object.entries(MOODS)) {
  const pairs: Array<[string, number | undefined]> = [
    ['brow', m.brow], ['browIn', m.browIn], ['browAsym', m.browAsym],
    ['lid', m.lid], ['smile', m.smile],
  ];
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    const [lo, hi] = POSE_RANGES[k as keyof typeof POSE_RANGES];
    if (v < lo || v > hi) moodViolations += ` ${name}.${k}=${v}`;
  }
}
check('MOODS 预设全部落在 POSE_RANGES 内', moodViolations === '', moodViolations);

// 6) 契约 JSON 与入库文件逐字节同步（Python 共享源防腐烂）
const disk = readFileSync(join(process.cwd(), 'packages', 'anchor-core', 'schema', 'perf-contract.json'), 'utf-8');
check('perf-contract.json 与 TS 常量逐字节同步', disk === JSON.stringify(perfContractJson(), null, 2) + '\n');

process.exit(failures ? 1 : 0);
