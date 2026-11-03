// 低幅动作层（阶段 3 / ROADMAP §4-3 第 4 项）。
//
// 旧链路的动作是"渲染器隐式副作用"：眨眼/扫视表写死在 poseAt 里、
// 头部 sway/glance 是按时间正弦、呼吸只出现在合成器的静音帧。
// 本文件把这些动作变成**数据**：事件轨进 Perf.motion，求值纯函数化，
// 上层可以生成、锁定、覆盖、重播——为第 5 项（动作单元协调）铺路。
//
// 四条轨，全部独立、全部缺省关闭（硬纪律 #2：Perf.motion 缺省时 poseAt
// 输出与接入前逐位一致，由 motion-golden.json 基线断言保证）：
//   gaze   —— 注视目标事件轨（镜头/侧方/away），smoothstep 渗透转移
//   blink  —— 显式眨眼事件表（替换渲染器生成的隐式节奏）
//   head   —— 头部预备-跟随-收势三段曲线（anticipation-follow-settle）
//   breath —— 呼吸相位正弦（默认 14 次/分，贡献限幅在 nod ±0.05）
import { interpolate } from 'remotion';

// ---------- 契约 ----------

export type GazeTarget = { x: number; y: number };
export type GazeSpan = { t: number; t1: number; target: GazeTarget };
export type GazeTrack = { spans: GazeSpan[]; ramp?: number };

export type BlinkEvent = { t: number; amp?: number; rate?: number };
export type BlinkTrack = { events: BlinkEvent[] };

export type HeadSpan = { t: number; t1: number; yaw?: number; tilt?: number; nod?: number };
export type HeadTrack = { spans: HeadSpan[]; ramp?: number };

export type BreathTrack = { bpm?: number; phase?: number };

export type MotionTrack = {
  gaze?: GazeTrack;
  blink?: BlinkTrack;
  head?: HeadTrack;
  breath?: BreathTrack;
};

// ---------- 常量 ----------

/** 注视转移半宽（秒）。真人 saccade 后视线在 ~100ms 内稳定到新目标。 */
export const GAZE_RAMP = 0.12;
/** 头部动作渗透半宽（秒）。头部有质量，启动/收势比视线慢。 */
export const HEAD_RAMP = 0.2;
/** 静息呼吸频率（次/分）。成人在静息态约 12~18 次/分。 */
export const BREATH_BPM = 14;
/** 呼吸对 nod 的最大贡献（限幅：低幅动作不许喧宾夺主）。 */
export const BREATH_NOD_GAIN = 0.05;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (x: number) => x * x * (3 - 2 * x);

// ---------- 注视 ----------

/**
 * 逐帧注视目标：覆盖 frame 的所有 span 按 w 加权混合（同 intent 的距离场模式）。
 * 无 span 覆盖 → 看镜头 (0,0)（口播默认对象就是观众）。
 * 渗透区（wsum<1）向镜头回退而非向 0 突跳；交叠区按 w 归一，转移连续无跳变。
 */
export const gazeAt = (frame: number, fps: number, track: GazeTrack): GazeTarget => {
  const R = track.ramp ?? GAZE_RAMP;
  const t = frame / fps;
  let x = 0, y = 0, wsum = 0;
  for (const s of track.spans) {
    const dist = t < s.t ? s.t - t : t > s.t1 ? t - s.t1 : 0;
    const w = smoothstep(clamp01(1 - dist / R));
    if (w <= 0) continue;
    x += s.target.x * w;
    y += s.target.y * w;
    wsum += w;
  }
  if (wsum <= 0) return { x: 0, y: 0 };
  const d = Math.max(1, wsum);
  return { x: x / d, y: y / d };
};

// ---------- 眨眼 ----------

/**
 * 显式眨眼事件表求值。包络与 poseAt 旧表一致：rate 帧内保持全闭，
 * 之后 4 帧线性回落——同一形状，只是节奏的控制权从渲染器移交给数据。
 */
export const blinkAt = (frame: number, fps: number, track: BlinkTrack): number => {
  let acc = 0;
  for (const e of track.events) {
    const ef = Math.round(e.t * fps);
    const amp = e.amp ?? 1;
    const rate = e.rate ?? 2;
    const v = interpolate(Math.abs(frame - ef), [0, rate, rate + 4], [1, 1, 0], {
      extrapolateRight: 'clamp',
    });
    acc = Math.max(acc, v * amp);
  }
  return acc;
};

// ---------- 头部：预备-跟随-收势 ----------

/**
 * 头部动作幅度曲线 a(u)，u ∈ 0..1 为 span 内归一化时间。
 * 三段设计（运动学原则：大幅动作前有反向预备，收势有缓冲不急停）：
 *   预备 [0, 0.12)    —— 反向小位移到 -0.15（像点头前先微微后仰蓄力）
 *   跟随 [0.12, 0.45) —— smoothstep 冲到 +1（主体动作）
 *   收势 [0.6, 1]     —— 余弦缓落回 0（无急停、无回弹）
 * 中段 [0.45, 0.6) 为峰值保持。端点连续：a(0)=0，a(1)=0。
 */
export const headCurve = (u: number): number => {
  const x = clamp01(u);
  if (x < 0.12) return -0.15 * smoothstep(x / 0.12);
  if (x < 0.45) return -0.15 + 1.15 * smoothstep((x - 0.12) / 0.33);
  if (x < 0.6) return 1;
  const v = (x - 0.6) / 0.4;
  return (1 + Math.cos(Math.PI * v)) / 2;
};

export type HeadOffset = { yaw: number; tilt: number; nod: number };

/** 逐帧头部偏移：span 内按 headCurve 乘目标值，渗透区按 w 衰减（含收势后回中性）。 */
export const headAt = (frame: number, fps: number, track: HeadTrack): HeadOffset => {
  const R = track.ramp ?? HEAD_RAMP;
  const t = frame / fps;
  let yaw = 0, tilt = 0, nod = 0, wsum = 0;
  for (const s of track.spans) {
    const dist = t < s.t ? s.t - t : t > s.t1 ? t - s.t1 : 0;
    const w = smoothstep(clamp01(1 - dist / R));
    if (w <= 0) continue;
    const u = clamp01((t - s.t) / Math.max(1e-6, s.t1 - s.t));
    const a = headCurve(u);
    yaw += (s.yaw ?? 0) * a * w;
    tilt += (s.tilt ?? 0) * a * w;
    nod += (s.nod ?? 0) * a * w;
    wsum += w;
  }
  if (wsum <= 0) return { yaw: 0, tilt: 0, nod: 0 };
  const d = Math.max(1, wsum);
  return { yaw: yaw / d, tilt: tilt / d, nod: nod / d };
};

// ---------- 呼吸 ----------

/** 呼吸相位 ∈ -1..1（正弦）。bpm 缺省 14 次/分；phase 秒用于错开多条呼吸轨。 */
export const breathAt = (frame: number, fps: number, track: BreathTrack): number => {
  const bpm = track.bpm ?? BREATH_BPM;
  const period = 60 / bpm;
  const phase = track.phase ?? 0;
  return Math.sin(((frame / fps + phase) / period) * Math.PI * 2);
};
