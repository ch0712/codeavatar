/** P4 场景层验收的 SSR 构建入口（只被 tools/world/verify4.mjs 打包，不进发布包）。
 *
 *  与 v0 的 world-entry.ts / P3 的 program-entry.ts 物理隔离，保证 P4 改动一行
 *  都不会碰到既有 golden 链路。这里刻意不读文件、不依赖 cwd：文件装配由
 *  verify4.mjs 在 Node 侧完成，本入口只暴露纯函数 + 构建侧注入的角色表。 */
import { CHARS } from '../../packages/anchor-core/src/index';
import type { CharData, Pose } from '../../packages/anchor-core/src/index';
import {
  renderWorldFrame, validateWorldProgram, faceBody, frameTimes, poseOf,
  shotAt, stateAt, charIdPrefix, sceneIdPrefix,
} from '../../packages/anchor-core/src/world';
import type { WorldProgram, WorldRenderOptions, CharTable } from '../../packages/anchor-core/src/index';
import {
  SCENE_PALETTES, validateSceneProgram, resolveSceneProgram, resolveScenedWorld,
} from '../../packages/anchor-core/src/scene';
import type { SceneProgram, ScenedWorldProgram } from '../../packages/anchor-core/src/scene';
import { validateStoryProgram, resolveStoryProgram } from '../../packages/anchor-core/src/program';
import { renderFaceSvg } from '../../packages/anchor-core/src/svg';

const TABLE = CHARS as unknown as CharTable;

export const render = (p: WorldProgram, t: number, opts: WorldRenderOptions = {}): string =>
  renderWorldFrame(p, t, TABLE, opts);

/** 直接调唯一渲染器出一帧角色（绕过世界层），用于身份一致性对账。 */
export const face = (key: string, pose: Pose, idPrefix: string): string =>
  renderFaceSvg(TABLE[key], pose, { transparentBg: true, idPrefix });
export const bodyOf = (svg: string): string => faceBody(svg);

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

export {
  TABLE, SCENE_PALETTES, validateWorldProgram, validateSceneProgram,
  resolveSceneProgram, resolveScenedWorld, validateStoryProgram, resolveStoryProgram,
  frameTimes, poseOf, shotAt, stateAt,
  charIdPrefix, sceneIdPrefix, faceBody,
};
export type { WorldProgram, WorldRenderOptions, SceneProgram, ScenedWorldProgram, CharData };
