/**
 * 零依赖 SVG 运行时入口（2026-11-12，突破路线 P0）。
 *
 * FaceTraced 本身是纯函数组件：无 Remotion、无 DOM、无副作用，只依赖 React 的 useId。
 * 因此可以直接用 react-dom/server 把它渲染成**纯 SVG 字符串**——
 * 这条路径让同一个渲染器既能出 mp4（Remotion），也能在 Node / 浏览器 / Agent 里
 * 零 GPU、零构建地产生一帧角色，且不需要修改 FaceTraced 的任何一行。
 *
 * 硬纪律：这里是 FaceTraced 的唯一适配层，**不许另写一份 SVG 渲染器**。
 * 视觉等价由 tools/runtime_parity_check.py 与六格图逐像素比对守。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FaceTraced, CHARS } from './FaceTraced';
import type { CharData, CharKey } from './FaceTraced';
import type { Pose } from './types';
import { APPEARANCE_PRESETS, appearancePreset, resolveAppearance } from './appearance';
import type { AppearanceSpec } from './appearance';

export type SvgRenderOptions = {
  /** 不铺背景 rect（抠像/叠加用），与 FaceTraced 同义 */
  transparentBg?: boolean;
  /** 2.5D 深度原型开关，缺省 undefined = 平面路径（逐字节零漂移） */
  depth?: { gain?: number };
  /** 给 clipPath/mask 等文档级 id 加唯一前缀：同页多个 SVG 时必须给 */
  idPrefix?: string;
  /** Q3 外观质感（2026-11-17）：传 AppearanceSpec 对象或预设名
   *  （studio / sunset / night）。缺省 undefined = 平面路径，逐字节零漂移。 */
  appearance?: AppearanceSpec | string;
};

/** 预设名 → 校验过的 spec；undefined 表示「不开材质」。 */
const resolveOptAppearance = (a: SvgRenderOptions['appearance']): AppearanceSpec | undefined => {
  if (a === undefined) return undefined;
  const spec = typeof a === 'string' ? appearancePreset(a) : a;
  if (!spec) {
    throw new Error(`未知外观预设：${a}。可用：${Object.keys(APPEARANCE_PRESETS).join(' / ')}`);
  }
  return resolveAppearance(spec);
};

/** 把 SVG 里的 id 与 url(#id) 成对重命名，避免同页多实例解析到第一个 defs。
 *  FaceTraced 用 useId 保证单次渲染内唯一，但**多次独立 SSR**会各自从零编号。 */
export const uniquifySvgIds = (svg: string, prefix: string): string => {
  const ids = new Set<string>();
  for (const m of svg.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  let out = svg;
  for (const id of ids) {
    // url(#...) 里冒号/非 ASCII 不可解析，一并归一化
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
    const next = `${prefix}-${safe}`;
    out = out.split(`id="${id}"`).join(`id="${next}"`);
    out = out.split(`url(#${id})`).join(`url(#${next})`);
  }
  return out;
};

/** 渲染一帧为 SVG 字符串。data 由调用方提供 → 可只加载需要的角色，不必打包全部角色 JSON。 */
export const renderFaceSvg = (
  data: CharData,
  pose: Pose,
  opts: SvgRenderOptions = {},
): string => {
  const ap = resolveOptAppearance(opts.appearance);
  const svg = renderToStaticMarkup(
    React.createElement(FaceTraced, {
      pose,
      data,
      transparentBg: opts.transparentBg,
      depth: opts.depth,
      // 不传 appearance 时 props 对象与旧版逐字段相同（零漂移由构造保证）
      ...(ap ? { appearance: ap } : {}),
    }),
  );
  return opts.idPrefix ? uniquifySvgIds(svg, opts.idPrefix) : svg;
};

/** 按注册角色 key 渲染（便捷入口，会引用完整角色表）。 */
export const renderFaceSvgByKey = (
  key: CharKey,
  pose: Pose,
  opts: SvgRenderOptions = {},
): string => renderFaceSvg(CHARS[key], pose, opts);

/** 渲染一段表演为 SVG 帧序列（纯函数，可缓存、可 diff、可写进静态站点）。 */
export const renderFaceFrames = (
  data: CharData,
  poses: readonly Pose[],
  opts: SvgRenderOptions = {},
): string[] =>
  poses.map((pose, i) => renderFaceSvg(data, pose, { ...opts, idPrefix: `${opts.idPrefix ?? 'f'}${i}` }));
