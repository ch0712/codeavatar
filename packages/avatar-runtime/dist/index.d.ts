/**
 * codeavatar-runtime 公开类型声明。
 *
 * 这些类型是 packages/anchor-core/src/types.ts 与 FaceTraced.tsx 契约的镜像。
 * `scripts/verify.mjs` 会校验 Pose 字段与 core 的 POSE_RANGES 逐项一致，
 * 防止手写声明与唯一事实源漂移。
 */

export type Viseme = 'M' | 'A' | 'O' | 'E' | 'I' | 'U';

/** 一个瞬间的姿态向量：全部为数值，可插值、可 diff、可由音频驱动。 */
export interface Pose {
  brow: number;
  browIn: number;
  browAsym: number;
  lid: number;
  smile: number;
  gazeX: number;
  gazeY: number;
  mouthOpen: number;
  mouthWide: number;
  mouthRound: number;
  jaw: number;
  tilt: number;
  nod: number;
  yaw: number;
  blink: number;
}

export interface Mood {
  name: string;
  [key: string]: string | number | undefined;
}

export interface CharLayer {
  id: string;
  hex: string;
  d: string;
  box: [number, number, number, number];
  area: number;
  role?: string | null;
  side?: string | number | null;
  eye?: number;
}

/** 角色 = 一份纯文本 JSON。由调用方提供（本包不附带角色美术资产）。 */
export interface CharData {
  canvas: [number, number];
  bg: string;
  skin: string;
  skinBox: [number, number, number, number];
  lipBox: [number, number, number, number] | null;
  lipColor?: string | null;
  eyes: { cx: number; cy: number; w: number; h: number }[];
  brows: { side?: string; box: [number, number, number, number]; hex: string }[];
  layers: CharLayer[];
  key?: string;
  mouth?: 'fullLips';
}

export interface SvgRenderOptions {
  /** 不铺背景 rect（抠像/叠加用） */
  transparentBg?: boolean;
  /** 2.5D 深度原型开关，缺省 undefined = 平面路径 */
  depth?: { gain?: number };
  /** 同页多个 SVG 时必须给，避免 clipPath/mask 的文档级 id 串台 */
  idPrefix?: string;
}

export const NEUTRAL: Pose;
export const POSE_RANGES: Record<keyof Pose, [number, number]>;
export const VISEME: Record<Viseme, Pick<Pose, 'mouthOpen' | 'mouthWide' | 'mouthRound' | 'jaw'>>;
export const MOODS: Record<string, Mood>;

/** 渲染一帧为纯 SVG 字符串（SSR，无 DOM 依赖）。 */
export function renderFaceSvg(data: CharData, pose: Pose, opts?: SvgRenderOptions): string;
/** 渲染一段表演为 SVG 帧序列。 */
export function renderFaceFrames(data: CharData, poses: readonly Pose[], opts?: SvgRenderOptions): string[];
/** 把 SVG 内 id 与 url(#id) 成对重命名。 */
export function uniquifySvgIds(svg: string, prefix: string): string;
