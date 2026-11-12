/**
 * SSR 侧的构建入口（只被 tools/runtime/export.mjs 用 esbuild 打包，不进运行时包）。
 * 存在的意义：把「角色 JSON + Pose」变成一串可内嵌的 SVG 帧，供零依赖 demo 与
 * parity 校验消费。所有渲染仍然走 @anchor/core 的 renderFaceSvg → FaceTraced。
 */
import { CHARS, MOODS, NEUTRAL, VISEME, renderFaceSvg } from '../../packages/anchor-core/src/index';
import type { Pose, Viseme } from '../../packages/anchor-core/src/index';

/** 情绪名是 MOODS 的字符串键；core 的 Mood 是情绪对象类型，别混用。 */
export type MoodName = string;

export const GRID_ORDER: Viseme[] = ['M', 'A', 'O', 'E', 'I', 'U'];
export const DEMO_MOODS: MoodName[] = ['中性', '高兴', '认真'];
export const ALL_MOODS: MoodName[] = Object.keys(MOODS);

export const poseFor = (v: Viseme, m: MoodName): Pose => ({
  ...NEUTRAL,
  ...MOODS[m],
  ...VISEME[v],
});

export type Frame = { id: string; label: string; viseme: Viseme; mood: MoodName; svg: string };

/** 与 studio/src/VisemeGrid.tsx 完全相同的 pose 序列，用于逐像素 parity 校验。 */
export const buildGridFrames = (charKey: string): Frame[] => {
  const data = (CHARS as Record<string, Parameters<typeof renderFaceSvg>[0]>)[charKey];
  if (!data) throw new Error(`未知角色: ${charKey}`);
  return GRID_ORDER.map((v, i) => ({
    id: `grid-${v}`,
    label: v,
    viseme: v,
    mood: '中性' as MoodName,
    // idPrefix 必需：同页 6 个 SVG，独立 SSR 的 useId 会各自从零编号
    svg: renderFaceSvg(data, poseFor(v, '中性'), { transparentBg: true, idPrefix: `g${i}` }),
  }));
};

/** demo 交互帧：6 口型 × N 情绪。 */
export const buildDemoFrames = (charKey: string, moods: MoodName[] = DEMO_MOODS): Frame[] => {
  const data = (CHARS as Record<string, Parameters<typeof renderFaceSvg>[0]>)[charKey];
  if (!data) throw new Error(`未知角色: ${charKey}`);
  const out: Frame[] = [];
  let i = 0;
  for (const m of moods) {
    for (const v of GRID_ORDER) {
      out.push({
        id: `${m}-${v}`,
        label: `${m} · ${v}`,
        viseme: v,
        mood: m,
        svg: renderFaceSvg(data, poseFor(v, m), { transparentBg: true, idPrefix: `d${i++}` }),
      });
    }
  }
  return out;
};
