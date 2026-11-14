/** Rig 预览的 SSR 入口（只被 preview.mjs 用 esbuild 打包，不进发布包）。
 *  角色画面严格复用 svg.ts 的 renderFaceSvg；这里只负责把 zone 框叠加上去。 */
import { renderFaceSvg } from '../../packages/anchor-core/src/svg';
import { NEUTRAL, VISEME, MOODS } from '../../packages/anchor-core/src/types';
import type { Pose, Viseme } from '../../packages/anchor-core/src/types';
import type { CharData } from '../../packages/anchor-core/src/FaceTraced';

export const GRID: Viseme[] = ['M', 'A', 'O', 'E', 'I', 'U'];
export const LABELS: Record<string, string> = {
  mouth: '嘴 mouth', browL: '左眉 browL', browR: '右眉 browR',
  eyeL: '左眼 eyeL', eyeR: '右眼 eyeR',
};
export const COLORS: Record<string, string> = {
  mouth: '#D7825D', browL: '#6C8EBF', browR: '#8F7BC8',
  eyeL: '#4FA88B', eyeR: '#4FA88B',
};
export type Zones = Record<string, [number, number, number, number]>;

const esc = (v: unknown): string => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const poseFor = (v: Viseme): Pose => ({ ...NEUTRAL, ...MOODS['中性'], ...VISEME[v] }) as Pose;

/** 六格口型，每帧独立 idPrefix（同页多 SVG 必须唯一）。 */
export const frames = (data: CharData, prefix = 'p'): string[] =>
  GRID.map((v, i) => renderFaceSvg(data, poseFor(v), { idPrefix: `${prefix}${i}` }));

/** 在角色 SVG 的 user space（= 设定稿像素坐标）上叠 zone 框。
 *  viewBox 与 canvas 同源，所以框坐标可以直接用，不需要换算。 */
export const withZones = (svg: string, zones: Zones, labels = true): string => {
  const parts = Object.entries(zones).map(([k, z]) => {
    const c = COLORS[k] ?? '#888888';
    const [x0, y0, x1, y1] = z;
    return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" `
      + `fill="${c}" fill-opacity="0.10" stroke="${c}" stroke-width="5" stroke-dasharray="18 12"/>`
      + (labels
        ? `<rect x="${x0}" y="${Math.max(0, y0 - 42)}" width="${Math.max(150, (LABELS[k] ?? k).length * 20)}" height="40" fill="${c}" rx="6"/>`
          + `<text x="${x0 + 10}" y="${Math.max(30, y0 - 12)}" font-size="27" fill="#141117" font-family="system-ui,sans-serif" font-weight="700">${esc(LABELS[k] ?? k)}</text>`
        : '');
  }).join('');
  return svg.replace('</svg>', `<g>${parts}</g></svg>`);
};

/** 单独一张「角色 + 分区」标注大图，用独立 id 前缀避免与六格帧冲突。 */
export const zonedFrame = (data: CharData, zones: Zones): string =>
  withZones(renderFaceSvg(data, poseFor('M'), { idPrefix: 'pz' }), zones, true);

/** 给「设定稿原图」叠同款 zone 框（透明底 SVG，绝对定位盖在 PNG 上）。 */
export const zoneOverlay = (zones: Zones, canvas: [number, number]): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas[0]} ${canvas[1]}" `
  + `preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">`
  + withZones(`<svg viewBox="0 0 ${canvas[0]} ${canvas[1]}"></svg>`, zones, true)
    .replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  + `</svg>`;
