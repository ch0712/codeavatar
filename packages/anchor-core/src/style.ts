// 动作单元与角色风格协调（阶段 3 / ROADMAP §4-3 第 5 项）。
//
// 上一项把低幅动作变成了数据（MotionTrack 四条轨），但数据是"散装"的：
// 谁来生成、生成多少幅度、不同角色是否都合适、上层能不能只改其中一条轨——
// 没有答案。本文件给出组织方式：
//
//   动作单元 units     —— 原子动作构造器（nod/shake/glance/...），组装轨的积木
//   风格 MotionStyle   —— 角色级协调约束：幅度增益、轨开关、头-眼耦合、锁定
//   applyMotionStyle   —— 把风格应用到整条 MotionTrack（纯数据变换，确定性）
//
// 纪律：
//   - 求值器 poseAt 不动——风格只作用于**数据生成层**，渲染行为零漂移；
//   - 所有增益缺省 1、耦合缺省 0、开关缺省开：空 style 应用前后逐字段相等；
//   - 锁定（locked）语义是"数据说了算"：整条轨替换生成结果，不再被增益触碰。
import type {
  MotionTrack, GazeSpan, GazeTrack, BlinkEvent, BlinkTrack,
  HeadSpan, HeadTrack, BreathTrack,
} from './motion';

// ---------- 动作单元（原子动作构造器） ----------

/**
 * 动作单元 = 轨数据的参数化积木。返回单个 span/event，
 * 由调用方决定放进哪条轨、什么时刻。幅度语义与 motion.ts 契约一致
 * （yaw/tilt/nod ∈ -1..1，gaze target ∈ -1..1 画幅相对）。
 */
export const units = {
  /** 点头（强调/肯定）：预备-跟随-收势曲线由求值器给出 */
  nod: (t: number, dur = 0.8, amp = 0.5): HeadSpan => ({ t, t1: t + dur, nod: amp }),
  /** 摇头（否定/迟疑） */
  shake: (t: number, dur = 0.9, amp = 0.4): HeadSpan => ({ t, t1: t + dur, yaw: amp }),
  /** 歪头（疑问/卖萌） */
  tilt: (t: number, dur = 1.0, amp = 0.2): HeadSpan => ({ t, t1: t + dur, tilt: amp }),
  /** 看侧方：dir ±1 定左右，amp 为画幅相对幅度 */
  glance: (t: number, dur = 1.0, dir: 1 | -1, amp = 0.9): GazeSpan => ({
    t, t1: t + dur, target: { x: dir * amp, y: 0 },
  }),
  /** 看镜头（回观众） */
  lookCamera: (t: number, dur = 1.0): GazeSpan => ({ t, t1: t + dur, target: { x: 0, y: 0 } }),
  /** 单次眨眼 */
  blinkOnce: (t: number, amp = 1, rate = 2): BlinkEvent => ({ t, amp, rate }),
};

// ---------- 角色风格（协调约束） ----------

export type MotionStyle = {
  /** 注视幅度倍率（乘在 gaze target 上）。默认 1。 */
  gazeGain?: number;
  /** 头部幅度倍率（乘在 yaw/tilt/nod 上）。默认 1。 */
  headGain?: number;
  /** 呼吸频率覆盖（次/分）。缺省不改动。 */
  breathBpm?: number;
  /** 轨级开关：false = 该轨整体移除（角色不擅长/不适合的动作）。默认全开。 */
  allow?: { gaze?: boolean; blink?: boolean; head?: boolean; breath?: boolean };
  /**
   * 头-眼耦合 0..1：与头部动作时间重叠的注视 span 幅度按 (1-couple) 衰减——
   * 真人转头时眼睛不会同时做等幅扫视。默认 0（不耦合 = 零漂移）。
   */
  headGazeCouple?: number;
  /**
   * 锁定轨：给出的轨**整条替换**生成结果，且不再被增益/耦合触碰——
   * 这是"数据说了算"的逃逸口：上层手调的动作原样保留（可锁定、可重播）。
   */
  locked?: { gaze?: GazeTrack; blink?: BlinkTrack; head?: HeadTrack; breath?: BreathTrack };
};

const gainOr = (v: number | undefined, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;

/**
 * 把风格应用到 MotionTrack。纯函数、确定性；空 style ≡ 恒等变换
 * （返回等价数据，逐字段相等——由 style-check 断言）。
 *
 * 处理顺序（不可交换）：① locked 整条替换；② allow 移除；③ 增益缩放；
 * ④ 头-眼耦合衰减（作用于 gaze span，依据 head span 的时间重叠）。
 */
export const applyMotionStyle = (
  base: MotionTrack,
  style: MotionStyle = {},
): MotionTrack => {
  const out: MotionTrack = {};

  // ① 锁定：整条替换，跳过后续一切处理。
  // 赋值顺序与 synthesizePerf 的构造顺序一致（blink→gaze→head→breath），
  // 保证恒等路径 JSON 字节相同（重播/断言按字节比对）。
  const L = style.locked;
  out.blink = L?.blink ? { events: L.blink.events.map((e) => ({ ...e })) } : base.blink;
  out.gaze = L?.gaze ? { spans: L.gaze.spans.map((s) => ({ ...s, target: { ...s.target } })), ...(L.gaze.ramp !== undefined ? { ramp: L.gaze.ramp } : {}) } : base.gaze;
  out.head = L?.head ? { spans: L.head.spans.map((s) => ({ ...s })), ...(L.head.ramp !== undefined ? { ramp: L.head.ramp } : {}) } : base.head;
  out.breath = L?.breath ? { ...L.breath } : base.breath;
  // 锁定 = 数据说了算：后续增益/开关/耦合一律不触碰锁定轨
  const lockGaze = !!L?.gaze, lockHead = !!L?.head, lockBreath = !!L?.breath;

  // ② allow 开关
  const A = style.allow;
  if (A?.gaze === false) out.gaze = undefined;
  if (A?.blink === false) out.blink = undefined;
  if (A?.head === false) out.head = undefined;
  if (A?.breath === false) out.breath = undefined;

  // ③ 幅度增益（锁定轨跳过）
  const gg = gainOr(style.gazeGain, 1);
  const hg = gainOr(style.headGain, 1);
  if (out.gaze && !lockGaze && gg !== 1) {
    out.gaze = {
      ...out.gaze,
      spans: out.gaze.spans.map((s) => ({
        ...s, target: { x: s.target.x * gg, y: s.target.y * gg },
      })),
    };
  }
  if (out.head && !lockHead && hg !== 1) {
    out.head = {
      ...out.head,
      spans: out.head.spans.map((s) => ({
        ...s,
        ...(s.yaw !== undefined ? { yaw: s.yaw * hg } : {}),
        ...(s.tilt !== undefined ? { tilt: s.tilt * hg } : {}),
        ...(s.nod !== undefined ? { nod: s.nod * hg } : {}),
      })),
    };
  }
  if (out.breath && !lockBreath && style.breathBpm !== undefined) {
    out.breath = { ...out.breath, bpm: style.breathBpm };
  }

  // ④ 头-眼耦合：与 head span 重叠的 gaze span 幅度衰减（锁定 gaze 跳过）
  const couple = Math.min(1, Math.max(0, gainOr(style.headGazeCouple, 0)));
  if (couple > 0 && out.gaze && !lockGaze && out.head) {
    out.gaze = {
      ...out.gaze,
      spans: out.gaze.spans.map((s) => {
        const overlaps = out.head!.spans.some((h) => h.t < s.t1 && s.t < h.t1);
        return overlaps
          ? { ...s, target: { x: s.target.x * (1 - couple), y: s.target.y * (1 - couple) } }
          : s;
      }),
    };
  }

  return out;
};
