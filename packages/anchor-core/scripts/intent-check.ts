// 意图层与情绪连续控制数值断言（阶段 3 第 3 项验收）。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/intent-check.ts
import { poseAt, moodLabels } from '../src/perf';
import { synthesizePerf } from '../src/speech';
import { INTENT_VA, intentOffset } from '../src/intent';
import type { Perf, PerfFrame } from '../src/perf';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

const mkFrame = (o = 0): PerfFrame => ({ m: 'M', o, br: 0, nd: 0, g: 'none', env: o, sp: 0, gz: [0, 0] });
const mkPerf = (n: number, intent?: Perf['intent']): Perf => ({
  fps: 30,
  duration: n / 30,
  frames: Array.from({ length: n }, () => mkFrame(0)),
  gestures: [],
  ...(intent ? { intent } : {}),
});
const eq = (x: number, y: number) => Math.abs(x - y) < 1e-12;

// 1) 零漂移：无 intent 时情绪字段与旧公式（moodAt 混合）逐帧一致
const legacyPerf = mkPerf(60);
legacyPerf.gestures = [{ t: 0.5, t1: 1.5, kind: 'point', word: '' }]; // point → 强调
const labels = moodLabels(legacyPerf);
let drift = '';
for (let f = 0; f < 60; f += 3) {
  const p = poseAt(f, 30, legacyPerf, labels);
  // 复刻旧路径：moodAt 手算
  const to = labels[Math.min(f, 59)] ?? '中性';
  let start = f;
  while (start - 1 >= 0 && labels[start - 1] === to) start--;
  const from = start - 1 >= 0 ? labels[start - 1] : to;
  const w = from === to ? 1 : Math.min(1, Math.max(0, (f - start + 1) / 7));
  const M = (k: '强调' | '中性') => k === '强调' ? { brow: 0.75, browIn: 0.45, lid: 1.08, smile: 0.02 } : { brow: 0, browIn: 0, lid: 1, smile: 0.12 };
  const A = M(from as '强调' | '中性'), B = M(to as '强调' | '中性');
  const mix = (a: number, b: number) => a + (b - a) * w;
  if (!eq(p.brow, mix(A.brow, B.brow)) || !eq(p.smile, mix(A.smile, B.smile))) {
    drift += ` f${f}`;
  }
}
check('无 intent 时旧路径逐帧零漂移', drift === '', drift);

// 2) hold 平顶：span 内部（避开 ±RAMP 渗透区）参数恒定
const hold = mkPerf(120, { spans: [{ t: 1, t1: 3, intent: '强调', intensity: 0.9 }] });
const hl = moodLabels(hold);
const midFrames = [48, 54, 60, 66, 72]; // 1.6s ~ 2.4s，距两端 ≥0.35s
const ref = poseAt(midFrames[0], 30, hold, hl);
const flat = midFrames.every((f) => {
  const p = poseAt(f, 30, hold, hl);
  return eq(p.brow, ref.brow) && eq(p.smile, ref.smile) && eq(p.browIn, ref.browIn);
});
check('hold 平顶（span 内部参数恒定）', flat,
  `brow=${ref.brow.toFixed(3)} browIn=${ref.browIn.toFixed(3)} lid=${ref.lid.toFixed(3)}`);

// 3) onset 渐变：中性 → 渗透区 → 目标，单调上升
const at = (f: number) => poseAt(f, 30, hold, hl);
const pre = at(15);   // 0.5s，span 前 0.5s > RAMP → 中性
const ramp = at(24);  // 0.8s，渗透区内
const inSpan = at(45); // 1.5s，目标值
check('onset：span 外 0.5s 为中性',
  eq(pre.brow, 0) && eq(pre.browIn, 0) && eq(pre.smile, 0.12));
check('onset：渗透区介于中性与目标之间',
  pre.brow < ramp.brow && ramp.brow < inSpan.brow && pre.smile < ramp.smile + 1e-9 && ramp.brow < inSpan.brow,
  `brow ${pre.brow.toFixed(3)} → ${ramp.brow.toFixed(3)} → ${inSpan.brow.toFixed(3)}`);

// 4) onset/release 对称：距边界等距的两帧参数相同
const aIn = at(24);    // 0.8s，距 t=1s 0.2s
const aOut = at(93);   // 3.1s，距 t1=3s 0.1s → 取对称点 0.8s↔3.2s
const aOut2 = at(96);  // 3.2s，距 t1=3s 0.2s
check('onset/release 对称', eq(aIn.brow, aOut2.brow) && eq(aIn.browIn, aOut2.browIn),
  `0.8s brow=${aIn.brow.toFixed(4)} 3.2s brow=${aOut2.brow.toFixed(4)} (3.1s=${aOut.brow.toFixed(4)})`);

// 5) 相邻 span 无中性谷：逐帧扫描 brow 的最大相邻帧差（连续性）
const two = mkPerf(120, {
  spans: [
    { t: 0.5, t1: 1.5, intent: '强调', intensity: 0.9 },
    { t: 1.95, t1: 3, intent: '说明', intensity: 0.6 },
  ],
});
const tl = moodLabels(two);
let maxJump = 0;
for (let f = 1; f < 120; f++) {
  maxJump = Math.max(maxJump, Math.abs(poseAt(f, 30, two, tl).brow - poseAt(f - 1, 30, two, tl).brow));
}
check('相邻 span 情绪连续（无中性谷）', maxJump < 0.05, `max Δbrow=${maxJump.toFixed(4)}`);

// 6) 意图→参数排序：强调 > 说明（brow/lid），疑问 browAsym > 0
const offQ = intentOffset(INTENT_VA['疑问'].v, INTENT_VA['疑问'].a, 0.8);
const offS = intentOffset(INTENT_VA['说明'].v, INTENT_VA['说明'].a, 0.8);
const offE = intentOffset(INTENT_VA['强调'].v, INTENT_VA['强调'].a, 0.8);
check('强调 brow 高于说明', offE.brow > offS.brow,
  `强调 brow=${offE.brow.toFixed(3)} 说明 brow=${offS.brow.toFixed(3)}`);
check('疑问带单侧挑眉（browAsym>0）', offQ.browAsym > 0, `asym=${offQ.browAsym.toFixed(3)}`);
check('安抚效价 → smile 明显为正', intentOffset(INTENT_VA['安抚'].v, INTENT_VA['安抚'].a, 0.8).smile > 0.3);

// 7) synth 集成：句尾标点 → 意图轨
const pSyn = synthesizePerf('di4 yi1 ju4! di4 er4 ju4? di4 san1 ju4.', { pinyin: true });
check('synth 意图轨句数 = 句数', pSyn.intent?.spans.length === 3, `n=${pSyn.intent?.spans.length}`);
check('！→强调 / ？→疑问 / 。→说明',
  pSyn.intent?.spans[0].intent === '强调' && pSyn.intent?.spans[1].intent === '疑问' && pSyn.intent?.spans[2].intent === '说明');
check('意图窗口与手势窗口对齐',
  pSyn.intent?.spans.every((s, i) => eq(s.t, pSyn.gestures[i].t + 2 / 30) || eq(s.t, pSyn.gestures[i].t)) ?? false);

// 8) 确定性
const e1 = poseAt(50, 30, hold, hl);
const e2 = poseAt(50, 30, hold, hl);
check('确定性（同帧两次求值一致）', eq(e1.brow, e2.brow) && eq(e1.smile, e2.smile) && eq(e1.browIn, e2.browIn));

process.exit(failures ? 1 : 0);
