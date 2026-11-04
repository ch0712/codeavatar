// 2.5D 深度分层原型数值断言（阶段 4 A/B 原型配套）。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/depth-check.ts
import { DEPTH_BY_ROLE, DEPTH_GAIN, parallaxFor, orderByDepth } from '../src/depth';
import type { CharLayer } from '../src/FaceTraced';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};
const eq = (x: number, y: number, eps = 1e-12) => Math.abs(x - y) < eps;

// 1) 正视零位移（A/B 的基线对照必须严格一致）
const roles = Object.keys(DEPTH_BY_ROLE);
check('yaw=0 时所有层位移为 0', roles.every((r) => eq(parallaxFor(r, 0).dx, 0)),
  roles.map((r) => parallaxFor(r, 0).dx).filter((v) => v !== 0).join(','));
check('未标注角色的层深度为 0（缺省不动）',
  eq(parallaxFor(undefined, 0.8).dx, 0) && eq(parallaxFor('unknown_role', 0.8).dx, 0));

// 2) 深度排序语义：近层位移大（视差量级 ∝ 深度）
const rim = parallaxFor('rim', 0.8);   // 0.5
const brow = parallaxFor('brow', 0.8); // 0.10
const face = parallaxFor('skin', 0.8); // 0
const hairBack = parallaxFor('hair_back', 0.8); // -0.45（反向）
check('近层（rim）位移大于远层（brow）', Math.abs(rim.dx) > Math.abs(brow.dx),
  `rim=${rim.dx.toFixed(2)} brow=${brow.dx.toFixed(2)}`);
check('脸面层不动（深度 0 基准）', eq(face.dx, 0));
check('后层（hair_back）与前层反向', rim.dx * hairBack.dx < 0,
  `rim=${rim.dx.toFixed(2)} hair_back=${hairBack.dx.toFixed(2)}`);
check('位移随 yaw 线性（0.4→0.8 翻倍）',
  eq(parallaxFor('rim', 0.8).dx, parallaxFor('rim', 0.4).dx * 2));

// 3) gain 可调且与位移成正比
const g2 = parallaxFor('rim', 0.8, DEPTH_GAIN * 2);
check('gain 翻倍 → 位移翻倍', eq(g2.dx, rim.dx * 2), `g=${g2.dx.toFixed(2)}`);

// 4) 遮挡排序：近层后画、同深度稳定、集合不变
const mk = (id: string, role: string | null): CharLayer =>
  ({ id, role, d: '', hex: '#000000', box: [0, 0, 1, 1], area: 1 } as unknown as CharLayer);
const layers = [mk('a', 'rim'), mk('b', 'skin'), mk('c', 'hair_back'), mk('d', 'skin'), mk('e', null)];
const sorted = orderByDepth(layers);
check('遮挡排序：最深（hair_back）最先画、rim 最后画',
  sorted[0].id === 'c' && sorted[sorted.length - 1].id === 'a',
  sorted.map((l) => `${l.id}:${l.role}`).join(' → '));
check('同深度保持原始层序（稳定）',
  sorted.filter((l) => l.role === 'skin' || l.role === null).map((l) => l.id).join(',') === 'b,d,e',
  sorted.map((l) => l.id).join(','));
check('排序不增删层', sorted.length === layers.length
  && new Set(sorted.map((l) => l.id)).size === layers.length);
check('原始数组未被就地修改', layers[0].id === 'a');

// 5) 确定性
check('同输入两次结果一致',
  JSON.stringify(orderByDepth(layers).map((l) => l.id))
  === JSON.stringify(orderByDepth(layers).map((l) => l.id)));

process.exit(failures ? 1 : 0);
