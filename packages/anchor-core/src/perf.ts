// 表演驱动层 —— 从 AnchorFilm.tsx 剥离（2026-10-30，S1）。纯函数，无 React。
// 组装顺序：NEUTRAL（底子）→ MOODS[情绪] → VISEME[口型] → 该帧微动。
import { interpolate } from 'remotion';
import { MOODS, NEUTRAL, Pose, VISEME, Viseme } from './types';

export type PerfFrame = {
  m: Viseme;
  o: number;
  br: number;
  nd: number;
  g: string;
  env: number;
  sp: number;
  gz: [number, number];
};
export type Perf = {
  fps: number;
  duration: number;
  frames: PerfFrame[];
  gestures: Array<{ t: number; t1: number; kind: string; word: string }>;
};
export type Caption = { t0: number; t1: number; text: string };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const SACC_CACHE = new Map<number, Array<[number, number]>>();

/**
 * 微扫视（saccade）：人眼在不看固定目标时每 0.4~1.2 秒跳一次（跳的过程只占 1~2 帧），
 * 从不静止。上一版视线只吃 perf.gz，而 gz 本身很平 → 成片「眼睛不动、没生气」。
 * 这里叠一层确定性扫视表：相同帧号必得相同结果（渲染可复现），
 * 停留 12~24 帧、跳变 2 帧（30fps 下 ≈ 0.07s，接近真人 saccade 时长）。
 */
const saccadeTable = (n: number): Array<[number, number]> => {
  let s = 20261028;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: Array<[number, number]> = new Array(n);
  let cur: [number, number] = [0, 0];
  let next: [number, number] = [0, 0];
  let holdUntil = 0;
  let jumpFrom = 0;
  for (let f = 0; f < n; f++) {
    if (f >= holdUntil) {
      // 新目标：水平为主（±1），垂直幅度小（±0.45）
      jumpFrom = f;
      next = [(rnd() * 2 - 1) * 1.0, (rnd() * 2 - 1) * 0.45];
      holdUntil = f + 12 + Math.floor(rnd() * 13);
    }
    const k = clamp((f - jumpFrom) / 2, 0, 1);
    out[f] = [cur[0] + (next[0] - cur[0]) * k, cur[1] + (next[1] - cur[1]) * k];
    if (k >= 1) cur = next;
  }
  return out;
};
/** 眨眼表：不等间隔（0.9~2.0s）+ 28% 概率紧跟一次「补眨」，每次闭合帧数与幅度都不同。 */
type Blink = { f: number; amp: number; rate: number };
const BLINK_CACHE = new Map<number, Blink[]>();
const blinkTable = (n: number): Blink[] => {
  let s = 77123;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: Blink[] = [];
  let f = 4 + Math.floor(rnd() * 12);
  while (f < n - 6) {
    const amp = 0.82 + rnd() * 0.18;
    const rate = 2 + Math.floor(rnd() * 2);
    out.push({ f, amp, rate });
    let next = f + 26 + Math.floor(rnd() * 34);
    if (rnd() < 0.28 && f + rate + 8 < n - 6) {
      out.push({ f: f + rate + 3 + Math.floor(rnd() * 3), amp: 0.6 + rnd() * 0.25, rate: 2 });
      next += 16;
    }
    f = next;
  }
  return out;
};
const blinks = (n: number): Blink[] => {
  if (!BLINK_CACHE.has(n)) BLINK_CACHE.set(n, blinkTable(n));
  return BLINK_CACHE.get(n) as Blink[];
};

const saccades = (n: number): Array<[number, number]> => {
  if (!SACC_CACHE.has(n)) SACC_CACHE.set(n, saccadeTable(n));
  return SACC_CACHE.get(n) as Array<[number, number]>;
};

/** 手势语义 → 情绪。这些手势本来就是按句子语义排的（开场/指认/绕圈/敲击）。 */
const GESTURE_MOOD: Record<string, keyof typeof MOODS> = {
  open: '中性',
  point: '强调',
  circle: '认真',
  strike: '强调',
  none: '中性',
};

/** 逐帧情绪标签：手势窗口优先，最后 0.9 秒收尾转「轻松」。 */
export const moodLabels = (perf: Perf): Array<keyof typeof MOODS> => {
  const n = perf.frames.length;
  const labels: Array<keyof typeof MOODS> = new Array(n).fill('中性');
  perf.gestures.forEach((g) => {
    const a = Math.round(g.t * perf.fps);
    const b = Math.round(g.t1 * perf.fps);
    const mood = GESTURE_MOOD[g.kind] ?? '中性';
    for (let f = a; f < Math.min(b, n); f++) labels[f] = mood;
  });
  const closeFrom = Math.round((perf.duration - 0.9) * perf.fps);
  for (let f = closeFrom; f < n; f++) labels[f] = '轻松';
  return labels;
};

/** 情绪段交叉：换标签后 7 帧内从上一段的参数线性过渡到这一段，避免"换脸"。 */
const moodAt = (
  frame: number,
  labels: Array<keyof typeof MOODS>,
): { from: keyof typeof MOODS; to: keyof typeof MOODS; w: number } => {
  const to = labels[Math.min(frame, labels.length - 1)] ?? '中性';
  let start = frame;
  while (start - 1 >= 0 && labels[start - 1] === to) start--;
  const from = start - 1 >= 0 ? labels[start - 1] : to;
  return { from, to, w: from === to ? 1 : clamp((frame - start + 1) / 7, 0, 1) };
};

const moodBrow = (m: keyof typeof MOODS) => (MOODS[m] ?? MOODS['中性']).brow;
const moodBrowIn = (m: keyof typeof MOODS) => (MOODS[m] ?? MOODS['中性']).browIn;
const moodLid = (m: keyof typeof MOODS) => (MOODS[m] ?? MOODS['中性']).lid;
const moodSmile = (m: keyof typeof MOODS) => (MOODS[m] ?? MOODS['中性']).smile;

export const poseAt = (frame: number, fps: number, perf: Perf, labels: Array<keyof typeof MOODS>): Pose => {
  const { from, to, w } = moodAt(frame, labels);
  const mix = (a: number, b: number) => a + (b - a) * w;
  const pf: PerfFrame =
    perf.frames[Math.min(frame, perf.frames.length - 1)] ?? { m: 'M', o: 0, br: 0, nd: 0, g: 'none', env: 0, sp: 0, gz: [0, 0] };

  const p: Pose = { ...NEUTRAL };
  p.brow = mix(moodBrow(from), moodBrow(to));
  p.browIn = mix(moodBrowIn(from), moodBrowIn(to));
  p.lid = mix(moodLid(from), moodLid(to));
  p.smile = mix(moodSmile(from), moodSmile(to));

  // 口型：音节包络 o 决定"这个音张多大"，viseme 决定"张成什么形状"
  const v = VISEME[pf.m] ?? VISEME.M;
  const env = clamp(0.42 + 0.58 * pf.o, 0, 1);
  p.mouthOpen = v.mouthOpen * env;
  p.mouthWide = v.mouthWide * (0.55 + 0.45 * pf.o);
  p.mouthRound = v.mouthRound;
  p.jaw = v.jaw * env;

  // 该帧的头部/视线微动（来自真实语音的重音包络与视线轨迹）
  const t = frame / fps;
  const sway = Math.sin((t / 7.3) * Math.PI * 2);
  const glance = Math.sin((t / 5.7) * Math.PI * 2 + 1.1);
  p.brow = clamp(p.brow + pf.br * 0.42, -1, 1.15);
  p.nod = pf.nd * 0.6 + pf.env * 0.12;
  p.tilt = sway * 0.28;
  p.yaw = glance * 0.22;
  // 视线 = 真实轨迹（gz）+ 缓慢漂移（sway）+ 微扫视（saccade），三者叠加后才「像在看着人」
  const SACC = saccades(perf.frames.length);
  const sc = SACC[Math.min(frame, SACC.length - 1)] ?? [0, 0];
  p.gazeX = clamp(pf.gz[0] * 1.6 + sway * 0.12 + sc[0] * 0.62, -1.15, 1.15);
  p.gazeY = clamp((pf.gz[1] - 0.13) * 1.2 + sc[1] * 0.5, -1.0, 1.0);

  // 眨眼：不等间隔 + 偶尔补眨（真人不会每 2 秒准时眨一次）。
  // 上一版是写死的 4 个等距帧 [38,96,158,232]，节奏机械，是「看着像木偶」的来源之一。
  p.blink = blinks(perf.frames.length).reduce((acc, e) => {
    const v = interpolate(Math.abs(frame - e.f), [0, e.rate, e.rate + 4], [1, 1, 0], { extrapolateRight: 'clamp' });
    return Math.max(acc, v * e.amp);
  }, 0);

  // 眼睑跟着视线走：往下看时上眼睑略垂、往上看时略抬（真人联动，只加 6~10%，不夸张）
  const g = p.gazeY;
  if (g > 0) p.lid *= 1 - 0.10 * Math.min(1, g);
  else p.lid *= 1 + 0.06 * Math.min(1, -g);
  return p;
};
