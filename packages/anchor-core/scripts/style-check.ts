// 动作单元与角色风格协调数值断言（阶段 3 第 5 项验收）。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/style-check.ts
import { synthesizePerf } from '../src/speech';
import { units, applyMotionStyle } from '../src/style';
import { gazeAt, headAt } from '../src/motion';
import type { MotionTrack, HeadSpan, GazeSpan } from '../src/motion';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};
const eq = (x: number, y: number, eps = 1e-12) => Math.abs(x - y) < eps;

const base: MotionTrack = {
  blink: { events: [{ t: 1.0, amp: 0.9, rate: 2 }] },
  gaze: { spans: [
    { t: 0, t1: 1, target: { x: 0, y: 0 } },
    { t: 1, t1: 2, target: { x: -0.8, y: 0.3 } },
    { t: 2, t1: 3, target: { x: 0, y: 0 } },
  ] },
  head: { spans: [
    { t: 0.5, t1: 1.5, nod: 0.5 },
    { t: 2.0, t1: 2.6, tilt: -0.2 },
  ] },
  breath: { bpm: 14 },
};

// ---------- 1) 恒等性：空 style 应用前后逐字段相等 ----------
const id = applyMotionStyle(base, {});
const idJson = JSON.stringify(id) === JSON.stringify(base);
check('空 style ≡ 恒等变换', idJson, idJson ? '' : JSON.stringify(id).slice(0, 120));

// ---------- 2) 增益缩放 ----------
const g2 = applyMotionStyle(base, { gazeGain: 0.5 });
const g2span = g2.gaze!.spans[1].target;
check('gazeGain 缩放注视目标（0.5×）',
  eq(g2span.x, -0.4) && eq(g2span.y, 0.15) && eq(g2.gaze!.spans[0].target.x, 0),
  `x=${g2span.x} y=${g2span.y}`);
const h2 = applyMotionStyle(base, { headGain: 1.6 });
check('headGain 缩放头部幅度（1.6×）',
  eq(h2.head!.spans[0].nod!, 0.8) && eq(h2.head!.spans[1].tilt!, -0.32),
  `nod=${h2.head!.spans[0].nod} tilt=${h2.head!.spans[1].tilt}`);
check('breathBpm 覆盖呼吸频率',
  applyMotionStyle(base, { breathBpm: 16 }).breath!.bpm === 16
  && base.breath!.bpm === 14);

// ---------- 3) allow 轨开关 ----------
const noGaze = applyMotionStyle(base, { allow: { gaze: false } });
check('allow.gaze=false 移除注视轨',
  noGaze.gaze === undefined && !!noGaze.blink && !!noGaze.head && !!noGaze.breath);
const allOff = applyMotionStyle(base, {
  allow: { gaze: false, blink: false, head: false, breath: false },
});
check('四轨全关 → 空 motion', JSON.stringify(allOff) === '{}');

// ---------- 4) 锁定：整条替换且不被增益触碰 ----------
const lockedGaze: GazeSpan[] = [{ t: 0, t1: 3, target: { x: 0.33, y: -0.44 } }];
const lk = applyMotionStyle(base, {
  locked: { gaze: { spans: lockedGaze } },
  gazeGain: 0.5, // 不得作用于锁定轨
});
check('locked.gaze 整条替换', lk.gaze!.spans.length === 1 && eq(lk.gaze!.spans[0].target.x, 0.33));
check('锁定轨不被增益触碰', eq(lk.gaze!.spans[0].target.y, -0.44));

// ---------- 5) 头-眼耦合：与 head span 重叠的 gaze span 衰减 ----------
const cp = applyMotionStyle(base, { headGazeCouple: 0.6 });
check('耦合：重叠 span 幅度 ×(1-0.6)',
  eq(cp.gaze!.spans[1].target.x, -0.8 * 0.4) && eq(cp.gaze!.spans[1].target.y, 0.3 * 0.4),
  `x=${cp.gaze!.spans[1].target.x}`);
check('耦合：不重叠 span（镜头窗）不变',
  eq(cp.gaze!.spans[0].target.x, 0) && eq(cp.gaze!.spans[2].target.x, 0));
check('耦合默认 0：不指定时与恒等变换一致',
  JSON.stringify(applyMotionStyle(base, { headGazeCouple: 0 })) === JSON.stringify(base));

// ---------- 6) 耦合的实际效果：头部动作期间视线摆动变小 ----------
const gzAt = (trk: MotionTrack, f: number) => gazeAt(f, 30, trk.gaze!);
const plain = gzAt(base, 45);      // 1.5s：head span (0.5~1.5) 尾部 + gaze away 窗
const coupled = gzAt(applyMotionStyle(base, { headGazeCouple: 0.6 }), 45);
check('耦合使头部动作期间注视摆动收窄',
  Math.abs(coupled.x) < Math.abs(plain.x), `${Math.abs(coupled.x).toFixed(3)} < ${Math.abs(plain.x).toFixed(3)}`);

// ---------- 7) 动作单元形状 ----------
const n = units.nod(2, 0.8, 0.6);
check('units.nod 形状（t/t1/amp）', n.t === 2 && eq(n.t1!, 2.8) && eq(n.nod!, 0.6));
const s = units.shake(1, 0.9, 0.4);
check('units.shake 是 yaw 轨', s.yaw === 0.4 && s.nod === undefined);
const gl = units.glance(3, 1.0, 1, 0.9);
check('units.glance 方向×幅度', eq(gl.target!.x, 0.9) && eq(gl.target!.y, 0));
const cam = units.lookCamera(4, 0.8);
check('units.lookCamera 回镜头', cam.target!.x === 0 && cam.target!.y === 0);
const bk = units.blinkOnce(5, 0.85, 3);
check('units.blinkOnce 事件', bk.t === 5 && bk.amp === 0.85 && bk.rate === 3);
// 单元组装 → 求值：nod 单元在头部轨上给出峰值
const assembled: MotionTrack = { head: { spans: [units.nod(0, 1, 0.6)] } };
check('单元组装可求值（峰值 = amp）', eq(headAt(15, 30, assembled.head!).nod, 0.6, 1e-9));

// ---------- 8) synth 集成：style 隐含 motion / 空恒等 / 增益生效 / 锁定 / 重播 ----------
const mOnly = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true, motion: true });
const mEmpty = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true, style: {} });
check('style={} 与 motion=true 产物逐字节相同', JSON.stringify(mOnly) === JSON.stringify(mEmpty));
const mGained = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', { pinyin: true, style: { headGain: 2 } });
const baseNodSpan = mOnly.motion!.head!.spans.find((s) => s.nod !== undefined);
const gainNodSpan = mGained.motion!.head!.spans.find((s) => s.nod !== undefined);
check('synth style.headGain 作用于生成轨',
  !!baseNodSpan?.nod && !!gainNodSpan?.nod && eq(gainNodSpan.nod, baseNodSpan.nod * 2),
  `${baseNodSpan?.nod} ×2 = ${gainNodSpan?.nod}`);
const mLocked = synthesizePerf('ni3 hao3! zhe4 shi4 ce4 shi4.', {
  pinyin: true,
  style: { locked: { blink: { events: [units.blinkOnce(1.234, 1, 2)] } } },
});
check('synth 锁定眨眼轨整条替换',
  mLocked.motion!.blink!.events.length === 1 && eq(mLocked.motion!.blink!.events[0].t, 1.234, 1e-9),
  `n=${mLocked.motion!.blink!.events.length}`);
// 重播：同参数逐字节相同；不同 seed 不同
const r1 = synthesizePerf('ni3 hao3!', { pinyin: true, style: { gazeGain: 0.8, headGazeCouple: 0.3 } });
const r2 = synthesizePerf('ni3 hao3!', { pinyin: true, style: { gazeGain: 0.8, headGazeCouple: 0.3 } });
const r3 = synthesizePerf('ni3 hao3!', { pinyin: true, seed: 777, style: { gazeGain: 0.8, headGazeCouple: 0.3 } });
check('重播：同参数同 seed 逐字节相同', JSON.stringify(r1.motion) === JSON.stringify(r2.motion));
check('异 seed 产物不同（非退化）', JSON.stringify(r1.motion) !== JSON.stringify(r3.motion));
// 无 motion 无 style：零漂移（产物无 motion 字段）
check('缺省两者不生成 motion', synthesizePerf('ni3 hao3.').motion === undefined);

process.exit(failures ? 1 : 0);
