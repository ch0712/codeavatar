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
