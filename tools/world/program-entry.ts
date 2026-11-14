/** P3 验证的 SSR 构建入口（只被 tools/world/verify3.mjs 打包，不进发布包）。
 *  与 v0 的 world-entry.ts 分开，确保 P3 的改动一行都不会影响 v0 golden 链路。 */
import { CHARS } from '../../packages/anchor-core/src/index';
import type { CharData, Pose } from '../../packages/anchor-core/src/index';
import {
  renderWorldFrame, validateWorldProgram, faceBody, frameTimes, poseOf,
  shotAt, stateAt, charIdPrefix,
} from '../../packages/anchor-core/src/world';
import type { WorldProgram, WorldRenderOptions, CharTable, Beat, Viseme } from '../../packages/anchor-core/src/index';
import {
  validateStoryProgram, resolveStoryProgram, verifyCharLocks, charFingerprint,
} from '../../packages/anchor-core/src/program';
import type { StoryProgram, ResolveOptions } from '../../packages/anchor-core/src/program';
import { renderFaceSvg } from '../../packages/anchor-core/src/svg';

const TABLE = CHARS as unknown as CharTable;

export const render = (p: WorldProgram, t: number, opts: WorldRenderOptions = {}): string =>
  renderWorldFrame(p, t, TABLE, opts);

/** 直接调唯一渲染器出一帧角色（绕过世界层），用于身份一致性对账。 */
export const face = (key: string, pose: Pose, idPrefix: string): string =>
  renderFaceSvg(TABLE[key], pose, { transparentBg: true, idPrefix });
export const bodyOf = (svg: string): string => faceBody(svg);

export { TABLE, validateWorldProgram, validateStoryProgram, resolveStoryProgram,
  verifyCharLocks, charFingerprint, frameTimes, poseOf, shotAt, stateAt, charIdPrefix };

/** 与 v0 export.mjs 完全相同的对账入口：用世界帧的 idPrefix 直接渲一帧角色。 */
export const bodyForFrame = (p: WorldProgram, t: number, opts: WorldRenderOptions = {}): string[] => {
  const { shot, shotIndex, localT } = shotAt(p, t);
  const state = stateAt(shot, localT);
  const out: string[] = [];
  for (const [castKey, slot] of Object.entries(p.chars)) {
    const st = state[castKey];
    if (!st || st.hidden) continue;
    out.push(faceBody(face(slot.key, poseOf(st), charIdPrefix(opts, shotIndex, castKey))));
  }
  return out;
};
export type { WorldProgram, WorldRenderOptions, StoryProgram, ResolveOptions, CharData, Beat, Viseme };
