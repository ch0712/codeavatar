// 低幅动作层数值断言（阶段 3 第 4 项验收）。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/motion-check.ts
import { poseAt, moodLabels } from '../src/perf';
import { synthesizePerf } from '../src/speech';
import { gazeAt, blinkAt, headAt, breathAt, headCurve, GAZE_RAMP, BREATH_BPM } from '../src/motion';
import type { Perf, PerfFrame } from '../src/perf';
import golden from './motion-golden.json';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

const mkFrame = (o = 0, gz: [number, number] = [0, 0]): PerfFrame => ({
  m: 'M', o, br: 0, nd: 0, g: 'none', env: o, sp: 0, gz,
});
const eq = (x: number, y: number, eps = 1e-12) => Math.abs(x - y) < eps;

// ---------- 1) 零漂移：无 motion 时与接入前 golden 基线逐字段一致 ----------
const legacyPerf: Perf = {
  fps: 30, duration: 3, gestures: [{ t: 0.5, t1: 1.8, kind: 'point', word: '' }],
  frames: Array.from({ length: 90 }, (_, f) => mkFrame(f % 12 < 6 ? 0.8 : 0, [Math.sin(f / 9) * 0.5, Math.cos(f / 11) * 0.3])),
};
const synthGolden = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true });
const bigGaze: Perf = {
  fps: 30, duration: 1, gestures: [],
  frames: Array.from({ length: 30 }, () => mkFrame(0, [0.9, -0.7])),
};
const fixtures: Array<[string, Perf]> = [
  ['legacy', legacyPerf], ['synth', synthGolden], ['bigGaze', bigGaze],
];
let drift = '';
for (const [name, perf] of fixtures) {
  const labels = moodLabels(perf);
  const g = golden[name as keyof typeof golden] as Array<{ f: number; pose: Record<string, number> }>;
  for (const { f, pose } of g) {
    const p = poseAt(f, perf.fps, perf, labels) as unknown as Record<string, number>;
    for (const k of Object.keys(pose)) {
      if (!eq(p[k], pose[k])) drift += ` ${name}#f${f}.${k}`;
    }
  }
}
check('零漂移：无 motion 时与 golden 基线逐字段一致', drift === '', drift);

// ---------- 2) 显式眨眼替换隐式表：事件帧全闭、远处为 0 ----------
const blinkPerf: Perf = {
  ...bigGaze,
  motion: { blink: { events: [{ t: 1.0, amp: 1, rate: 2 }] } },
};
const bl = moodLabels(blinkPerf);
const bPeak = poseAt(30, 30, blinkPerf, bl);   // 事件帧（t=1.0s = f30）
const bFar = poseAt(10, 30, blinkPerf, bl);    // 距事件 20 帧 → 0
check('显式眨眼：事件帧全闭 amp=1', eq(bPeak.blink, 1), `blink=${bPeak.blink}`);
check('显式眨眼：远处无残留', eq(bFar.blink, 0), `blink=${bFar.blink}`);

// ---------- 3) 眨眼包络形状：rate 帧保持、之后 4 帧线性回落 ----------
const bk = blinkAt(0, 30, { events: [{ t: 0, amp: 0.9, rate: 2 }] });
check('眨眼包络：rate 帧内保持 amp', eq(bk, 0.9));
const bFall = [3, 4, 5, 6].map((d) => blinkAt(d, 30, { events: [{ t: 0, amp: 0.9, rate: 2 }] }));
check('眨眼包络：4 帧线性回落到 0',
  eq(bFall[0], 0.9 * 0.75) && eq(bFall[1], 0.9 * 0.5) && eq(bFall[2], 0.9 * 0.25) && eq(bFall[3], 0));

// ---------- 4) 注视：span 内平顶、span 外回镜头 ----------
const gazePerf: Perf = {
  ...bigGaze,
  motion: { gaze: { spans: [{ t: 1, t1: 2, target: { x: 0.6, y: -0.4 } }] } },
};
const gl = moodLabels(gazePerf);
const gHold = [40, 45, 50].map((f) => poseAt(f, 30, gazePerf, gl)); // 1.33~1.67s，远离渗透区
const gCam = poseAt(15, 30, gazePerf, gl); // 0.5s，距 span 0.5s > RAMP
// 平顶断言在轨层（合成层含微扫视/漂移叠加，本来就逐帧微动，不许恒定）
const th1 = gazeAt(40, 30, gazePerf.motion!.gaze!);
const th2 = gazeAt(50, 30, gazePerf.motion!.gaze!);
check('注视 hold 平顶（轨层精确恒定）', eq(th1.x, 0.6) && eq(th2.x, 0.6) && eq(th1.y, -0.4),
  `x=${th1.x},${th2.x} y=${th1.y}`);
check('微扫视层保留（合成层围绕目标浮动，幅度有界）',
  gHold.every((p) => Math.abs(p.gazeX - 0.6) <= 0.12 + 0.62 + 1e-9 && Math.abs(p.gazeY - (-0.4)) <= 0.5 + 1e-9),
  `gazeX=${gHold.map((p) => p.gazeX.toFixed(4)).join(',')}`);
check('注视 span 外回镜头：大 gz（0.9/-0.7）不影响目标轨',
  Math.abs(gCam.gazeX) < 0.2 && Math.abs(gCam.gazeY) < 0.2,
  `gazeX=${gCam.gazeX.toFixed(4)} gazeY=${gCam.gazeY.toFixed(4)}`);

// ---------- 5) 注视转移连续性：相邻 span 间无跳变 ----------
const twoGaze: Perf = {
  ...bigGaze,
  frames: Array.from({ length: 180 }, () => mkFrame(0, [0.9, -0.7])),
  motion: {
    gaze: {
      spans: [
        { t: 0.5, t1: 2.5, target: { x: -0.8, y: 0.3 } },
        { t: 3.0, t1: 5.0, target: { x: 0.7, y: -0.2 } },
      ],
    },
  },
};
const tg = moodLabels(twoGaze);
let maxJump = 0;
for (let f = 1; f < 180; f++) {
  const a = poseAt(f - 1, 30, twoGaze, tg);
  const b = poseAt(f, 30, twoGaze, tg);
  maxJump = Math.max(maxJump, Math.abs(b.gazeX - a.gazeX), Math.abs(b.gazeY - a.gazeY));
}
check('注视转移连续（含跨 saccade 叠加）', maxJump < 0.6, `max Δ=${maxJump.toFixed(4)}`);
// 轨层连续性：0.12s 渗透 = 真人 saccade 速度（快而短）。
// 1.5 单位的目标摆幅在 ~3.6 帧内完成 → 单帧 Δ 上限约 0.5；超过即视为跳变。
let trackJump = 0;
for (let f = 1; f < 180; f++) {
  const a = gazeAt(f - 1, 30, twoGaze.motion!.gaze!);
  const b = gazeAt(f, 30, twoGaze.motion!.gaze!);
  trackJump = Math.max(trackJump, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}
check('注视轨转移在 saccade 速度内（max Δ < 0.5/帧）', trackJump < 0.5, `max Δ=${trackJump.toFixed(4)}`);

// ---------- 6) 头部曲线：预备(-) → 跟随(1) → 收势(0)，端点连续 ----------
const c0 = headCurve(0), cPeak = headCurve(0.5), cEnd = headCurve(1);
check('头部曲线端点：a(0)=0，a(1)=0', eq(c0, 0) && eq(cEnd, 0), `a(0)=${c0} a(1)=${cEnd}`);
check('头部曲线峰值：a(0.5)=1（保持段）', eq(cPeak, 1), `a(0.5)=${cPeak}`);
const cAnt = headCurve(0.06);
check('头部预备段反向（a<0）', cAnt < 0, `a(0.06)=${cAnt.toFixed(4)}`);
let cJump = 0;
for (let i = 1; i <= 100; i++) cJump = Math.max(cJump, Math.abs(headCurve(i / 100) - headCurve((i - 1) / 100)));
check('头部曲线连续（max Δ < 0.15/百分位）', cJump < 0.15, `max Δ=${cJump.toFixed(4)}`);
const cSettle = [0.7, 0.8, 0.9].map(headCurve);
check('收势段单调回落（1 → 0 无回弹）',
  cSettle[0] > cSettle[1] && cSettle[1] > cSettle[2] && cSettle[2] > 0,
  `a=${cSettle.map((v) => v.toFixed(3)).join(',')}`);

// ---------- 7) 头部轨接线：span 内 nod/tilt 偏移生效，渗透区外归零 ----------
const headPerf: Perf = {
  ...bigGaze,
  frames: Array.from({ length: 120 }, () => mkFrame(0, [0, 0])),
  motion: { head: { spans: [{ t: 0.5, t1: 2.5, nod: 0.5, tilt: 0.3 }] } },
};
const hl2 = moodLabels(headPerf);
const hIn = poseAt(45, 30, headPerf, hl2);   // 1.5s，曲线峰值区
const hOut = poseAt(105, 30, headPerf, hl2); // 3.5s，距 span 1s > RAMP
const baseOut = (() => {
  // 无 motion 的同帧基线（只有正弦微动）
  const bare: Perf = { ...headPerf, motion: undefined };
  return poseAt(105, 30, bare, moodLabels(bare));
})();
check('头部 span 内偏移生效（峰值区 nod≈0.5）', eq(hIn.nod, 0.5, 1e-9), `nod=${hIn.nod.toFixed(4)}`);
check('头部 span 外归零（与无 motion 基线一致）',
  eq(hOut.tilt, baseOut.tilt) && eq(hOut.yaw, baseOut.yaw),
  `Δtilt=${Math.abs(hOut.tilt - baseOut.tilt).toExponential(2)} Δyaw=${Math.abs(hOut.yaw - baseOut.yaw).toExponential(2)}`);

// ---------- 8) 呼吸：周期与限幅 ----------
const breathPerf: Perf = { ...bigGaze, motion: { breath: { bpm: 15 } } };
const brl = moodLabels(breathPerf);
const brA = poseAt(30, 30, breathPerf, brl);
const brB = poseAt(150, 30, breathPerf, brl); // bpm15 → 周期 2s = 60 帧；150-30=120=2 周期
const bareB = poseAt(150, 30, { ...breathPerf, motion: undefined }, moodLabels({ ...breathPerf, motion: undefined }));
check('呼吸周期正确（15bpm=60 帧，f 与 f+2T 相位相同）',
  eq(brA.nod - bareB.nod, brB.nod - bareB.nod, 1e-9),
  `Δnod@f30=${(brA.nod - bareB.nod).toFixed(6)} @f150=${(brB.nod - bareB.nod).toFixed(6)}`);
// 限幅：全帧扫描呼吸贡献 ≤ BREATH_NOD_GAIN（±0.05）
let maxBreath = 0;
const bareFrames = moodLabels({ ...breathPerf, motion: undefined });
for (let f = 0; f < 30; f++) {
  const w = poseAt(f, 30, breathPerf, brl).nod - poseAt(f, 30, { ...breathPerf, motion: undefined }, bareFrames).nod;
  maxBreath = Math.max(maxBreath, Math.abs(w));
}
check('呼吸贡献限幅 ≤ 0.05', maxBreath <= 0.05 + 1e-12, `max |Δnod|=${maxBreath.toFixed(4)}`);
check('呼吸默认 14 bpm', BREATH_BPM === 14);

// ---------- 9) synth 显式开关：默认不生成 / 开启后四轨齐全且确定性 ----------
const noMotion = synthesizePerf('ce4 shi4.', { pinyin: true });
const withMotion1 = synthesizePerf('ce4 shi4.', { pinyin: true, motion: true });
const withMotion2 = synthesizePerf('ce4 shi4.', { pinyin: true, motion: true });
check('synth 默认不含 motion（零漂移）', noMotion.motion === undefined);
check('synth motion=true 四轨齐全',
  !!withMotion1.motion?.blink?.events.length && !!withMotion1.motion?.gaze?.spans.length
  && !!withMotion1.motion?.head?.spans.length && !!withMotion1.motion?.breath,
  `blink=${withMotion1.motion?.blink?.events.length} gaze=${withMotion1.motion?.gaze?.spans.length} head=${withMotion1.motion?.head?.spans.length}`);
check('synth motion 确定性（两次合成逐字节相同）',
  JSON.stringify(withMotion1.motion) === JSON.stringify(withMotion2.motion));
const mGaze = withMotion1.motion!.gaze!;
const camFirst = mGaze.spans[0].target.x === 0 && mGaze.spans[0].target.y === 0;
check('synth 注视首窗看镜头', camFirst, `首窗 target=(${mGaze.spans[0].target.x},${mGaze.spans[0].target.y})`);
// 强调句（！）→ 头部点头轨
const emph = synthesizePerf('kan4 zhe4 li3!', { pinyin: true, motion: true });
const hasNod = emph.motion!.head!.spans.some((s) => (s.nod ?? 0) > 0);
check('强调句 → 头部点头轨', hasNod, JSON.stringify(emph.motion!.head!.spans));

// 半角 '.' 中句切分（2026-11-03 修复的既有 bug：中句 '.' 不切句被末尾兜底掩盖，
// 说明句被并入下一句，intent/头部动作轨随之粘连）
const dotSplit = synthesizePerf('yi1 ju4. er4 ju4?', { pinyin: true, motion: true });
check('半角 . 中句切分（不被末尾兜底掩盖）',
  dotSplit.intent?.spans.length === 2
  && dotSplit.intent?.spans[0].intent === '说明'
  && dotSplit.intent?.spans[1].intent === '疑问',
  `n=${dotSplit.intent?.spans.length} intents=${dotSplit.intent?.spans.map((s) => s.intent).join(',')}`);
const dotHeads = dotSplit.motion!.head!.spans;
check('切分后头部轨逐句独立（说明句 tilt / 疑问句 nod）',
  dotHeads.length === 2 && (dotHeads[0].tilt ?? 0) !== 0 && (dotHeads[1].nod ?? 0) > 0,
  JSON.stringify(dotHeads));

// ---------- 10) 确定性：motion 路径同帧两次求值一致 ----------
const e1 = poseAt(45, 30, headPerf, hl2);
const e2 = poseAt(45, 30, headPerf, hl2);
check('motion 路径确定性', eq(e1.nod, e2.nod) && eq(e1.gazeX, e2.gazeX) && eq(e1.blink, e2.blink));

process.exit(failures ? 1 : 0);
