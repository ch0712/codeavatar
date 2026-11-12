/**
 * codeavatar-runtime 的公开入口（构建期入口，产物是自包含 bundle）。
 *
 * 唯一事实源仍然是 packages/anchor-core/src/FaceTraced.tsx：
 * 本包不复制、不重写任何渲染逻辑，只把它的纯函数适配层打包成可分发的形态。
 *
 * 刻意不导出 CHARS / renderFaceSvgByKey：
 * 角色美术资产（chars/*.json）不在 MIT 授权范围内，不能随 npm 包再分发。
 * 角色 JSON 由调用方自己提供（自己画的设定稿跑 build 生成的产物归自己所有）。
 */
export { NEUTRAL, VISEME, MOODS, POSE_RANGES } from '../../anchor-core/src/types';
export type { Pose, Viseme, Mood } from '../../anchor-core/src/types';
export {
  renderFaceSvg,
  renderFaceFrames,
  uniquifySvgIds,
} from '../../anchor-core/src/svg';
export type { SvgRenderOptions } from '../../anchor-core/src/svg';
export type { CharData, CharLayer } from '../../anchor-core/src/FaceTraced';
