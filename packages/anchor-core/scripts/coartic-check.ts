// 共发音层数值断言（阶段 3 第 1 项验收）。运行：python tools/coartic_check.py
import { poseAt, moodLabels } from '../src/perf';
import { VISEME } from '../src/types';
import type { Perf, PerfFrame } from '../src/perf';

const mkFrame = (m: PerfFrame['m'], o = 0.5): PerfFrame => ({
  m, o, br: 0, nd: 0, g: 'none', env: o, sp: 0, gz: [0, 0],
});

const mkPerf = (visemes: Array<PerfFrame['m']>, coarticulation?: boolean): Perf => ({
  fps: 30,
  duration: visemes.length / 30,
  frames: visemes.map((m) => mkFrame(m, 0.7)),
  gestures: [],
  ...(coarticulation ? { coarticulation: true } : {}),
});

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

// A 段取 5 帧（≥ 窗口 W=2 两侧），中心帧才能验证稳态收敛
const visemes: Array<PerfFrame['m']> = ['M', 'M', 'A', 'A', 'A', 'A', 'A', 'M', 'O', 'O', 'O', 'E', 'I', 'I', 'U', 'U', 'M', 'M'];
const legacy = mkPerf(visemes);
const coart = mkPerf(visemes, true);
const labelsL = moodLabels(legacy);
const labelsC = moodLabels(coart);

// 1) 关闭路径零漂移：逐帧与 legacy 公式完全一致
let drift = '';
for (let f = 0; f < legacy.frames.length; f++) {
  const pose = poseAt(f, 30, legacy, labelsL);
  const pf = legacy.frames[f];
  const v = VISEME[pf.m];
  const env = Math.min(1, Math.max(0, 0.42 + 0.58 * pf.o));
  const expectOpen = v.mouthOpen * env;
  const expectWide = v.mouthWide * (0.55 + 0.45 * pf.o);
  if (Math.abs(pose.mouthOpen - expectOpen) > 1e-12 || Math.abs(pose.mouthWide - expectWide) > 1e-12) {
    drift += ` f${f}:${pose.mouthOpen.toFixed(4)}!=${expectOpen.toFixed(4)}`;
  }
}
check('关闭 coarticulation 时逐帧零漂移', drift === '', drift);

// 2) 开启路径：相邻帧口型跳变被压平
const maxJump = (perf: Perf, labels: ReturnType<typeof moodLabels>) => {
  let mx = 0;
  for (let f = 1; f < perf.frames.length; f++) {
    const a = poseAt(f - 1, 30, perf, labels);
    const b = poseAt(f, 30, perf, labels);
    mx = Math.max(mx, Math.abs(b.mouthOpen - a.mouthOpen), Math.abs(b.mouthWide - a.mouthWide));
  }
  return mx;
};
const jL = maxJump(legacy, labelsL);
const jC = maxJump(coart, labelsC);
check('共发音降低相邻帧跳变', jC < jL, `legacy=${jL.toFixed(4)} coartic=${jC.toFixed(4)}`);

// 3) 段内稳态收敛到目标：同 viseme 连续 ≥5 帧（≥窗口两侧）的中心帧 = legacy 值
const fCenter = 4; // A 段 [2..6] 的中心
const pc = poseAt(fCenter, 30, coart, labelsC);
const pl = poseAt(fCenter, 30, legacy, labelsL);
const err = Math.abs(pc.mouthOpen - pl.mouthOpen) + Math.abs(pc.jaw - pl.jaw);
check('段内稳态收敛到口型目标', err < 1e-9, `err=${err.toExponential(2)}`);

// 4) 确定性：同输入两次求值逐位相同
const a1 = poseAt(7, 30, coart, labelsC);
const a2 = poseAt(7, 30, coart, labelsC);
check('确定性（同帧两次求值一致）',
  a1.mouthOpen === a2.mouthOpen && a1.mouthWide === a2.mouthWide && a1.jaw === a2.jaw);

// 5) 预塑形：A 段起点之前的静音帧（f=1）嘴已提前张开（legacy 在 M 上≈0）
const p1c = poseAt(1, 30, coart, labelsC);
const p1l = poseAt(1, 30, legacy, labelsL);
check('预塑形：段起点之前嘴已提前就位', p1c.mouthOpen > p1l.mouthOpen,
  `f=1 coartic=${p1c.mouthOpen.toFixed(4)} legacy=${p1l.mouthOpen.toFixed(4)}`);

// 6) 边界：帧号越界取末帧不崩
const pe = poseAt(9999, 30, coart, labelsC);
check('越界帧不崩且取末帧', Number.isFinite(pe.mouthOpen));

process.exit(failures ? 1 : 0);
