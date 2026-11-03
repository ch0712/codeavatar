// 意图层（阶段 3 / ROADMAP §4-3 第 3 项）。
//
// 旧路径（moodLabels/GESTURE_MOOD）是"贴纸式"情绪：静态偏移 + 7 帧硬过渡，
// 且手势类别间接决定情绪（隐式副作用）。本文件提供连续替代：
//
//   意图 intent → (效价 valence, 唤醒 arousal) → Pose 偏移（连续函数）
//
// onset/hold/release：对每个 span 用「带符号距离场 + smoothstep」计算影响权重
// w ∈ 0..1——span 内平顶（hold），前后 ±R 秒渗透（onset/release 对称），
// 相邻 span 的交叠区按 w 加权混合，**无中性谷**（句间情绪连续）。
// 纯函数、确定性；Perf.intent 缺省时 poseAt 走旧路径（零漂移）。

export type Intent = '说明' | '强调' | '疑问' | '安抚' | '肯定';
export type IntentSpan = { t: number; t1: number; intent: Intent; intensity?: number };
export type IntentTrack = { spans: IntentSpan[] };

/** 意图 → 效价/唤醒基点。效价 v ∈ -1..1（不快→愉快），唤醒 a ∈ 0..1（平静→激动）。 */
export const INTENT_VA: Record<Intent, { v: number; a: number }> = {
  说明: { v: 0.10, a: 0.35 },
  强调: { v: 0.20, a: 0.85 },
  疑问: { v: 0.05, a: 0.60 },
  安抚: { v: 0.70, a: 0.25 },
  肯定: { v: 0.60, a: 0.50 },
};

/** onset/release 渗透半宽（秒）。30fps 下 0.35s ≈ 10 帧，与真人表情启动时序同量级。 */
export const INTENT_RAMP = 0.35;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/** (效价, 唤醒, 强度) → Pose 情绪目标。字段是绝对目标值（含 NEUTRAL 基线），
 * intentEmotionAt 内部转为偏移量混合——渗透区向中性回退，而不是向 0 回退
 * （否则 smile 会在 onset 途中跌破 0.12，出现"先僵后笑"的反自然轨迹）。 */
export const intentOffset = (v: number, a: number, k: number) => ({
  brow: (a - 0.35) * 0.55 * k,                                  // 唤醒抬眉（偏移，NEUTRAL=0）
  browIn: a > 0.6 && v < 0.3 ? (a - 0.6) * 0.9 * k : 0,         // 高唤醒低效价 → 眉间用力
  browAsym: a > 0.5 && a <= 0.7 ? (a - 0.5) * 1.2 * k : 0,      // 中段唤醒 → 单侧挑眉（疑问感）
  lid: 1 + (a - 0.35) * 0.25 * k,                               // 唤醒睁眼（绝对值，基线 1）
  smile: 0.12 + v * 0.55 * k,                                   // 效价决定嘴角（绝对值，基线 0.12）
});

export type EmotionOffset = ReturnType<typeof intentOffset>;

const NEUTRAL_EMOTION: EmotionOffset = { brow: 0, browIn: 0, browAsym: 0, lid: 1, smile: 0.12 };

/**
 * 逐帧情绪：覆盖 frame 的所有 span 按 w 加权混合（wsum=0 → 中性）。
 * w_i = smoothstep(1 - dist/R)，dist 为帧到 span 的带符号距离（span 内为 0）。
 */
export const intentEmotionAt = (
  frame: number,
  fps: number,
  track: IntentTrack,
): EmotionOffset => {
  const t = frame / fps;
  let brow = 0, browIn = 0, browAsym = 0, lidOff = 0, smileOff = 0, wsum = 0;
  for (const span of track.spans as IntentSpan[]) {
    const dist = t < span.t ? span.t - t : t > span.t1 ? t - span.t1 : 0;
    const w = smoothstep(clamp01(1 - dist / INTENT_RAMP));
    if (w <= 0) continue;
    const va = INTENT_VA[span.intent] ?? INTENT_VA['说明'];
    const off = intentOffset(va.v, va.a, clamp01(span.intensity ?? 0.8));
    brow += off.brow * w;
    browIn += off.browIn * w;
    browAsym += off.browAsym * w;
    lidOff += (off.lid - 1) * w;      // 转偏移量：渗透区向中性回退而非向 0
    smileOff += (off.smile - 0.12) * w;
    wsum += w;
  }
  if (wsum <= 0) return NEUTRAL_EMOTION;
  // 分母用 max(1, wsum)：
  //  - 渗透区（单 span，wsum<1）：结果 = 中性 + w·偏移（onset/release 渐变）
  //  - hold（wsum=1）：结果 = 目标值
  //  - 交叠区（相邻 span，wsum>1）：按 w 归一混合，句间情绪连续无谷
  const denom = Math.max(1, wsum);
  return {
    brow: brow / denom,
    browIn: browIn / denom,
    browAsym: browAsym / denom,
    lid: 1 + lidOff / denom,
    smile: 0.12 + smileOff / denom,
  };
};
