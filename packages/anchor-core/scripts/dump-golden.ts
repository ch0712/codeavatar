// golden 基线生成器（阶段 3 第 4 项验收配套）。
//
// 用途：在**改动 poseAt 之前**固化当前实现对固定 fixtures 的逐帧 Pose 输出，
// 作为 motion 层接入后的零漂移回归基线（motion-check.ts 消费 motion-golden.json）。
// 以后任何有意改变 poseAt 行为的提交，必须显式重跑本脚本并随提交附说明，
// 否则 motion-check 的零漂移断言会失败——这正是目的。
//
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/dump-golden.ts
import { writeFileSync } from 'fs';
import { join } from 'path';
import { poseAt, moodLabels } from '../src/perf';
import { synthesizePerf } from '../src/speech';
import type { Perf, PerfFrame } from '../src/perf';

const mkFrame = (o = 0, gz: [number, number] = [0, 0]): PerfFrame => ({
  m: 'M', o, br: 0, nd: 0, g: 'none', env: o, sp: 0, gz,
});

// fixture 1：纯静态 + 手势窗口（走旧情绪路径）
const legacy = {
  fps: 30, duration: 3, gestures: [{ t: 0.5, t1: 1.8, kind: 'point', word: '' }],
  frames: Array.from({ length: 90 }, (_, f) => mkFrame(f % 12 < 6 ? 0.8 : 0, [Math.sin(f / 9) * 0.5, Math.cos(f / 11) * 0.3])),
} as Perf;

// fixture 2：合成器产物（pinyin，带意图轨）——覆盖 intent 路径
const synth = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true });

// fixture 3：大视线幅度（区分 gaze 接线来源）
const bigGaze = {
  fps: 30, duration: 1, gestures: [],
  frames: Array.from({ length: 30 }, () => mkFrame(0, [0.9, -0.7])),
} as Perf;

const sample = (perf: Perf) => {
  const labels = moodLabels(perf);
  const out: Record<string, unknown>[] = [];
  for (let f = 0; f < perf.frames.length; f += 3) {
    out.push({ f, pose: poseAt(f, perf.fps, perf, labels) });
  }
  return out;
};

const golden = {
  note: 'poseAt 零漂移基线（生成于 motion 层接入前）。重生成：python tools/coartic_check.py packages/anchor-core/scripts/dump-golden.ts',
  legacy: sample(legacy),
  synth: sample(synth),
  bigGaze: sample(bigGaze),
};

// esbuild 打包后 __dirname 指向临时 bundle 目录，runner 固定以仓库根为 cwd，用 cwd 定位
const dest = join(process.cwd(), 'packages', 'anchor-core', 'scripts', 'motion-golden.json');
writeFileSync(dest, JSON.stringify(golden, null, 1), 'utf-8');
console.log(`golden 写入 ${dest}（legacy ${golden.legacy.length} 帧 / synth ${golden.synth.length} 帧 / bigGaze ${golden.bigGaze.length} 帧）`);
