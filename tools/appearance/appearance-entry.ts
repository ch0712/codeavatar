/** Q3 外观质感验收的 SSR 构建入口（只被 tools/appearance/verify_appearance.mjs 打包）。
 *  与 world / program / scene 三条既有链路物理隔离，保证本轮改动一行都碰不到 golden 链。 */
import { CHARS } from '../../packages/anchor-core/src/index';
import type { CharData, Pose, SvgRenderOptions } from '../../packages/anchor-core/src/index';
import { NEUTRAL, VISEME } from '../../packages/anchor-core/src/types';
import {
  renderFaceSvg, APPEARANCE_PRESETS, appearancePreset,
  validateAppearance, resolveAppearance,
} from '../../packages/anchor-core/src/index';
import { renderWorldFrame } from '../../packages/anchor-core/src/world';
import type { WorldProgram, WorldRenderOptions, CharTable } from '../../packages/anchor-core/src/index';
import { resolveScenedWorld } from '../../packages/anchor-core/src/scene';
import type { ScenedWorldProgram } from '../../packages/anchor-core/src/scene';

const TABLE = CHARS as unknown as CharTable;

export const GRID = ['M', 'A', 'O', 'E', 'I', 'U'] as const;
export const poseFor = (v: string): Pose => ({ ...NEUTRAL, ...VISEME[v] } as Pose);

/** 直接调唯一渲染器出一帧角色。appearance 缺省时与既有链路逐字节一致。 */
export const face = (key: string, pose: Pose, opts: SvgRenderOptions = {}): string =>
  renderFaceSvg(TABLE[key], pose, opts);

export const renderWorld = (p: WorldProgram, t: number, opts: WorldRenderOptions = {}): string =>
  renderWorldFrame(p, t, TABLE, opts);

export const compileStory = (p: ScenedWorldProgram): WorldProgram => resolveScenedWorld(p);

export {
  TABLE, renderFaceSvg, APPEARANCE_PRESETS, appearancePreset,
  validateAppearance, resolveAppearance,
};
export type { WorldProgram, WorldRenderOptions, SvgRenderOptions, CharData, ScenedWorldProgram };
