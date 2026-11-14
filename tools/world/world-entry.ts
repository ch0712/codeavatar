/**
 * WorldProgram 的 SSR 构建入口（只被 tools/world/export.mjs 用 esbuild 打包，不进发布包）。
 *
 * 存在的意义：把「角色表注入」这一步留在构建侧，
 * 让 packages/anchor-core/src/world.ts 保持**不引用 CHARS**——
 * 可发布运行时包因此不会被迫内置角色美术资产（合规纪律）。
 */
import { CHARS } from '../../packages/anchor-core/src/index';
import type { CharData } from '../../packages/anchor-core/src/index';
import {
  renderWorldFrame, validateWorldProgram, shotAt, stateAt, poseOf,
  faceBody, charIdPrefix, frameTimes, programDuration,
} from '../../packages/anchor-core/src/world';
import type { WorldProgram, WorldRenderOptions, BeatCast, CharTable } from '../../packages/anchor-core/src/world';
import type { Pose } from '../../packages/anchor-core/src/index';
import { renderFaceSvg } from '../../packages/anchor-core/src/svg';

const TABLE = CHARS as unknown as CharTable;

export const render = (p: WorldProgram, t: number, opts: WorldRenderOptions = {}): string =>
  renderWorldFrame(p, t, TABLE, opts);

/** 验证用：绕过世界层，直接用唯一渲染器出一帧角色，用于逐字节对账。 */
export const face = (key: string, pose: Pose, idPrefix: string): string =>
  renderFaceSvg(TABLE[key], pose, { transparentBg: true, idPrefix });

export const faceBodyOf = (key: string, pose: Pose, idPrefix: string): string =>
  faceBody(face(key, pose, idPrefix));

export {
  validateWorldProgram, shotAt, stateAt, poseOf, charIdPrefix, frameTimes, programDuration,
};
export type { WorldProgram, WorldRenderOptions, BeatCast };
