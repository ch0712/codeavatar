// 表演驱动层 —— 从 AnchorFilm.tsx 剥离（2026-10-30，S1）。纯函数，无 React。
// 组装顺序：NEUTRAL（底子）→ MOODS[情绪] → VISEME[口型] → 该帧微动。
import { interpolate } from 'remotion';
import { MOODS, NEUTRAL, Pose, VISEME, Viseme } from './types';
import { intentEmotionAt } from './intent';
import type { IntentTrack } from './intent';

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
  /** 共发音时间曲线开关（阶段 3）：开启后口型四参数跨帧平滑过渡，替代逐帧硬切。
   * 默认关闭——已验收角色的输出必须零漂移（硬纪律 #2），显式开启才生效。 */
  coarticulation?: boolean;
  /** 合成来源标注（synthesizePerf 产物）：pinyin=音素视觉对应；estimated=中文逐字
   * 节奏估计，口型不保证对应发音。消费方应把 estimated 当作占位表演。 */
  meta?: { mode: 'pinyin' | 'estimated'; unknownChars?: string[] };
  /** 意图轨（阶段 3）：存在时情绪由 intent → 效价/唤醒连续驱动（onset/hold/release），
   * 覆盖 moodLabels/GESTURE_MOOD 旧路径；缺省走旧路径（已验收角色零漂移）。 */
  intent?: IntentTrack;
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

/** 逐帧情绪标签：手势窗口覆盖默认中性情绪。
 *
 * 结束时强制切到“轻松”会让短片从开头就带笑，也会覆盖用户指定的结尾。
 * 收势应由上层表演轨明确给出，不能是渲染器的隐式副作用。
 */
export const moodLabels = (perf: Perf): Array<keyof typeof MOODS> => {
  const n = perf.frames.length;
  const labels: Array<keyof typeof MOODS> = new Array(n).fill('中性');
  perf.gestures.forEach((g) => {
    const a = Math.round(g.t * perf.fps);
    const b = Math.round(g.t1 * perf.fps);
    const mood = GESTURE_MOOD[g.kind] ?? '中性';
    for (let f = a; f < Math.min(b, n); f++) labels[f] = mood;
  });
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

/** 单帧口型目标（legacy 路径与共发音路径共用同一公式，保证关闭时零漂移）。 */
export type MouthTarget = { open: number; wide: number; round: number; jaw: number };
const legacyMouth = (pf: PerfFrame): MouthTarget => {
  // 口型：音节包络 o 决定"这个音张多大"，viseme 决定"张成什么形状"
  const v = VISEME[pf.m] ?? VISEME.M;
  const env = clamp(0.42 + 0.58 * pf.o, 0, 1);
  return {
    open: v.mouthOpen * env,
    wide: v.mouthWide * (0.55 + 0.45 * pf.o),
    round: v.mouthRound,
    jaw: v.jaw * env,
  };
};

/**
 * 共发音时间曲线（阶段 3 / ROADMAP §4-3 第 1 项）：
 * 六张嘴形逐帧硬切是「贴纸式」说话——相邻口型之间没有任何过渡，
 * 换音瞬间形状跳变。真人的发音器官有质量，形状变化连续且有预塑形
 * （发下一个音之前嘴已经开始就位）。
 *
 * 做法：先按 legacy 公式逐帧算目标向量，再做 5 点余弦窗时域平滑
 * （W=2 帧 @30fps ≈ 66ms，覆盖大多数辅音过渡）；future 侧权重 1.0、
 * past 侧 0.8 —— 预塑形略强于滞后，符合协同发音的生理方向。
 * 同一 frames 数组只算一次（WeakMap 缓存），确定性可复现。
 */
const COARTIC_CACHE = new WeakMap<PerfFrame[], MouthTarget[]>();
const coarticulated = (frames: PerfFrame[]): MouthTarget[] => {
  const hit = COARTIC_CACHE.get(frames);
  if (hit) return hit;
  const n = frames.length;
  const targets = frames.map(legacyMouth);
  const W = 2;
  const kernel: number[] = [];
  for (let k = -W; k <= W; k++) {
    const base = Math.cos((k / (W + 1)) * (Math.PI / 2)) ** 2;
    kernel.push(k < 0 ? base * 0.8 : base); // 预塑形：未来帧权重 > 过去帧
  }
  const out: MouthTarget[] = new Array(n);
  for (let f = 0; f < n; f++) {
    let open = 0, wide = 0, round = 0, jaw = 0, wsum = 0;
    for (let k = -W; k <= W; k++) {
      const g = f + k;
      if (g < 0 || g >= n) continue;
      const w = kernel[k + W];
      open += targets[g].open * w;
      wide += targets[g].wide * w;
      round += targets[g].round * w;
      jaw += targets[g].jaw * w;
      wsum += w;
    }
    out[f] = { open: open / wsum, wide: wide / wsum, round: round / wsum, jaw: jaw / wsum };
  }
  COARTIC_CACHE.set(frames, out);
  return out;
};

export const poseAt = (frame: number, fps: number, perf: Perf, labels: Array<keyof typeof MOODS>): Pose => {
  const pf: PerfFrame =
    perf.frames[Math.min(frame, perf.frames.length - 1)] ?? { m: 'M', o: 0, br: 0, nd: 0, g: 'none', env: 0, sp: 0, gz: [0, 0] };

  const p: Pose = { ...NEUTRAL };
  if (perf.intent && perf.intent.spans.length > 0) {
    // 意图轨路径：情绪连续（onset/hold/release），意图缺省段回中性基线
    const e = intentEmotionAt(frame, fps, perf.intent);
    p.brow = e.brow;
    p.browIn = e.browIn;
    p.browAsym = e.browAsym;
    p.lid = e.lid;
    p.smile = e.smile;
  } else {
    // 旧路径：手势窗口映射情绪段 + 7 帧硬过渡（已验收角色零漂移）
    const { from, to, w } = moodAt(frame, labels);
    const mix = (a: number, b: number) => a + (b - a) * w;
    p.brow = mix(moodBrow(from), moodBrow(to));
    p.browIn = mix(moodBrowIn(from), moodBrowIn(to));
    p.lid = mix(moodLid(from), moodLid(to));
    p.smile = mix(moodSmile(from), moodSmile(to));
  }

  // 口型：legacy = 逐帧硬切（零漂移默认路径）；coarticulation = 时间曲线（显式开启）
  const mouth: MouthTarget = perf.coarticulation
    ? coarticulated(perf.frames)[Math.min(frame, perf.frames.length - 1)]
    : legacyMouth(pf);
  p.mouthOpen = mouth.open;
  p.mouthWide = mouth.wide;
  p.mouthRound = mouth.round;
  p.jaw = mouth.jaw;

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
