// @anchor/core —— 纯代码驱动数字人能力单元的统一出口。
//
// 单一事实源：这里导出的东西，dhk 片子与 render/film free 通道**唯一**的来源。
// 消费方不许再各自维护一份表演层或渲染器。

// 契约：表情是数值不是贴图（16 参数 / 6 口型 / 5 情绪）
export { NEUTRAL, VISEME, MOODS } from './types';
export type { Pose, Viseme, Mood } from './types';

// 角色数据 + 参数化渲染器
export { FaceTraced, CHARS } from './FaceTraced';
export type { CharData, CharKey, CharLayer } from './FaceTraced';

// 表演驱动：perf.json → 逐帧 Pose（确定性，可复现）
export { poseAt, moodLabels } from './perf';
export type { Perf, PerfFrame, Caption } from './perf';

// 文本 → 表演合成（阶段 3）：拼音模式音素对应 / 中文模式节奏估计（诚实标注）
export { synthesizePerf, syllableViseme } from './speech';

// 意图层（阶段 3）：意图 → 效价/唤醒 → 连续情绪偏移（onset/hold/release）
export { intentEmotionAt, intentOffset, INTENT_VA, INTENT_RAMP } from './intent';
export type { Intent, IntentSpan, IntentTrack, EmotionOffset } from './intent';

// 低幅动作层（阶段 3）：注视目标 / 显式眨眼 / 头部预备-跟随-收势 / 呼吸（事件轨 + 纯函数求值）
export {
  gazeAt, blinkAt, headAt, breathAt, headCurve,
  GAZE_RAMP, HEAD_RAMP, BREATH_BPM, BREATH_NOD_GAIN,
} from './motion';
export type {
  GazeTarget, GazeSpan, GazeTrack,
  BlinkEvent, BlinkTrack,
  HeadSpan, HeadTrack, HeadOffset,
  BreathTrack, MotionTrack,
} from './motion';

// 动作单元与角色风格协调（阶段 3）：原子动作构造器 + 增益/开关/耦合/锁定
export { units, applyMotionStyle } from './style';
export type { MotionStyle } from './style';

// 2.5D 深度分层原型（阶段 4 A/B）：层深度表 + 视差 + 遮挡排序
export { DEPTH_BY_ROLE, DEPTH_GAIN, parallaxFor, orderByDepth } from './depth';
export type { Parallax } from './depth';
