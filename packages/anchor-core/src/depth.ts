// 2.5D 深度分层原型（阶段 4 / ROADMAP §4-4 第 1 项）。
//
// 现状是**纯平面**：所有层共享同一个 head transform，转头是整幅横向缩放，
// 没有视差、没有遮挡变化——这是"矢量干净但不像立体"的表示能力边界。
// 本文件给 A/B 原型提供最小实现：
//
//   DEPTH_BY_ROLE  —— 角色语义层 → 深度（-1..1，0=脸面基准，正=靠前）
//   parallaxFor()  —— 深度 + 转头角 → 该层的屏幕位移（近层位移大 = 视差）
//   orderByDepth() —— 按深度重排绘制顺序（近层后画 = 自然遮挡）
//
// 纪律：**只是原型开关**。FaceTraced 的 `depth` 缺省不传 → 旧平面路径零漂移；
// 是否并入主线由 docs/AB-2.5D.md 的 A/B 实测数据与决策门决定，不是代码先行。
import type { CharLayer } from './FaceTraced';

/** 语义层 → 深度。缺省 0（脸面基准）。正值靠前、负值靠后。 */
export const DEPTH_BY_ROLE: Record<string, number> = {
  skin: 0, face: 0, chin: 0.05, seam: 0.02, blush: 0.03,
  ear: -0.08, hair_back: -0.45,
  brow: 0.10, brow_fill: 0.10,
  eye: 0.14, lid: 0.16, iris: 0.18,
  nose: 0.20,
  mouth: 0.22, mouthline: 0.24, lip: 0.22,
  rim: 0.5, glasses: 0.5,
  hair: 0.6,
};

/** 视差基准：每 1.0 深度 × 1.0 转头角 在角色画布坐标下的位移（px）。 */
export const DEPTH_GAIN = 26;

export type Parallax = { dx: number; dy: number; depth: number };

/** 某层在给定转头角下的视差位移。yaw=0 时恒为 0（正视零漂移）。 */
export const parallaxFor = (role: string | null | undefined, yaw: number, gain = DEPTH_GAIN): Parallax => {
  const depth = role ? (DEPTH_BY_ROLE[role] ?? 0) : 0;
  return { dx: -yaw * depth * gain, dy: 0, depth };
};

/** 按深度重排绘制顺序：后（小）先画、前（大）后画——近层自然遮挡远层。
 * 稳定排序：同深度保持原始层序（不引入未声明的变化）。 */
export const orderByDepth = (layers: CharLayer[]): CharLayer[] => {
  const idx = new Map(layers.map((l, i) => [l.id, i]));
  return [...layers].sort((a, b) => {
    const da = a.role ? (DEPTH_BY_ROLE[a.role] ?? 0) : 0;
    const db = b.role ? (DEPTH_BY_ROLE[b.role] ?? 0) : 0;
    if (da !== db) return da - db;
    return (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0);
  });
};
