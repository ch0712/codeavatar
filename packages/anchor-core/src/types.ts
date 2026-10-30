// src/anchor-code/types.ts
/**
 * 纯代码主播的参数契约。
 *
 * 设计原则：**表情不是贴图，是数值**。
 * 每一个可见变化都必须对应这里的一个 0..1（或 -1..1）参数，
 * 这样它才能被插值、被 spring 驱动、被音频驱动、被复用——这是代码相对生图的唯一硬优势。
 * 任何"只能靠换图才能变"的东西，都不许进这个角色。
 */

/** 一个瞬间的姿态向量。全部可选，缺省取中性。 */
export interface Pose {
  /** 眉毛整体抬高 0..1（惊讶/强调） */
  brow: number;
  /** 眉毛内端下压 0..1（皱眉/用力），和外端抬高组合出"质疑" */
  browIn: number;
  /** 左右眉不对称 -1..1（正值右侧抬高）—— "挑一边眉毛"的怀疑脸靠它 */
  browAsym: number;
  /** 眼睑开合 0.06..1（0.06≈闭眼，1=正常，1.15=瞪大） */
  lid: number;
  /** 嘴角上扬 -1..1（负=嘴角向下，沮丧） */
  smile: number;
  /** 视线：-1..1 画幅相对偏移 */
  gazeX: number;
  gazeY: number;
  /** 张口 0..1 —— viseme 的主参数 */
  mouthOpen: number;
  /** 嘴横向展开 0..1 —— 决定「衣/诶」这类扁口型 */
  mouthWide: number;
  /** 嘴收圆 0..1 —— 决定「哦/乌」这类圆口型 */
  mouthRound: number;
  /** 下颌下沉 0..1（跟着 mouthOpen 联动，但可以独立加重音） */
  jaw: number;
  /** 头部倾斜 -1..1（度 × 3.2） */
  tilt: number;
  /** 点头 -1..1 */
  nod: number;
  /** 转头（伪 3D，横向缩放 + 单侧阴影） -1..1 */
  yaw: number;
  /** 眨眼 0..1（1=完全闭） */
  blink: number;
}

export const NEUTRAL: Pose = {
  brow: 0,
  browIn: 0,
  browAsym: 0,
  lid: 1,
  smile: 0.12,
  gazeX: 0,
  gazeY: 0,
  mouthOpen: 0,
  mouthWide: 0,
  mouthRound: 0,
  jaw: 0,
  tilt: 0,
  nod: 0,
  yaw: 0,
  blink: 0,
};

export type Viseme = 'M' | 'A' | 'O' | 'E' | 'I' | 'U';

/**
 * 口型表：每个音素是嘴部三个参数的组合。
 * 这里就是"精准控制"的落点——改一个数字，所有用到该口型的帧一起变。
 */
export const VISEME: Record<Viseme, Pick<Pose, 'mouthOpen' | 'mouthWide' | 'mouthRound' | 'jaw'>> = {
  // 2026-10-27 重定：按 gpt-6 的"形状可分"要求拉开差距。
  // 判据：六个口型的（唇高, 唇宽, 宽高比）两两之间至少一项差 ≥15%。
  M: { mouthOpen: 0.02, mouthWide: 0.0, mouthRound: 0.0, jaw: 0.0 },
  // A：最大开口 + 下颌下沉最多
  A: { mouthOpen: 1.0, mouthWide: 0.25, mouthRound: 0.0, jaw: 0.8 },
  // O：中等开口 + 明显收窄成圆
  O: { mouthOpen: 0.68, mouthWide: -0.35, mouthRound: 1.0, jaw: 0.5 },
  // E：中等偏小开口 + 横向展开（扁）
  E: { mouthOpen: 0.52, mouthWide: 0.68, mouthRound: 0.0, jaw: 0.24 },
  // I：小开口 + 最大横向展开（2026-10-28：开口 0.16→0.24、jaw 0.05→0.10，让「衣」在高、宽两维都和闭嘴拉开）
  I: { mouthOpen: 0.24, mouthWide: 1.0, mouthRound: 0.0, jaw: 0.1 },
  // U：小开口 + 强收圆收窄
  U: { mouthOpen: 0.3, mouthWide: -0.5, mouthRound: 0.95, jaw: 0.14 },
};

/** 情绪预设 = 一组姿态偏移，叠加在中性脸上 */
export interface Mood {
  name: string;
  brow: number;
  browIn: number;
  browAsym?: number;
  lid: number;
  smile: number;
  /** 嘴角向外拉的幅度（" profissional 微笑"和"真诚笑"的差别在这里） */
  cheek: number;
}

export const MOODS: Record<string, Mood> = {
  中性: { name: '中性', brow: 0, browIn: 0, lid: 1, smile: 0.12, cheek: 0 },
  // 强调：眉整体抬起 + 内端下压（"眉间用力"），眼略睁大
  强调: { name: '强调', brow: 0.75, browIn: 0.45, lid: 1.08, smile: 0.02, cheek: 0.15 },
  // 怀疑：单侧抬眉 + 眼睑压到一半 + 嘴角向下，是最容易一眼读出的组合
  怀疑: { name: '怀疑', brow: 0.05, browIn: 0.85, browAsym: 0.75, lid: 0.46, smile: -0.3, cheek: 0 },
  // 轻松：眉放松、眼弯成月牙、咧嘴
  轻松: { name: '轻松', brow: 0.25, browIn: 0, lid: 0.72, smile: 0.85, cheek: 0.9 },
  // 认真：眉压低内端、眼微收、嘴闭紧（压实 30%：表情表里原来偏弱，读不出"认真"）
  认真: { name: '认真', brow: -0.7, browIn: 1.15, lid: 0.72, smile: -0.1, cheek: 0 },
};
