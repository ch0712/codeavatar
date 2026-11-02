// 文本→表演合成器数值断言（阶段 3 第 2 项验收）。运行：python tools/coartic_check.py packages/anchor-core/scripts/speech-check.ts
import { synthesizePerf, syllableViseme } from '../src/speech';
import type { Perf } from '../src/perf';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

// 1) 音节→口型映射：主元音 + 闭唇声母 + 省写还原
check('ni → I', syllableViseme('ni3')?.viseme === 'I');
check('hao → A（ao 主元音 a）', syllableViseme('hao3')?.viseme === 'A');
check('zhong → O（ong 主元音 o）', syllableViseme('zhong1')?.viseme === 'O');
check('liu → O（iu=iou 还原）', syllableViseme('liu4')?.viseme === 'O');
check('shui → E（ui=uei 还原）', syllableViseme('shui3')?.viseme === 'E');
check('dun → E（un=uen 还原）', syllableViseme('dun1')?.viseme === 'E');
check('ma 闭唇起音', syllableViseme('ma')?.closedOnset === true);
check('ni 非闭唇起音', syllableViseme('ni2')?.closedOnset === false);
check('非法输入返回 null', syllableViseme('xyz!') === null);

// 2) 确定性：同输入两次合成逐字节相同
const a = JSON.stringify(synthesizePerf('da4 jia1 hao3! jin1 tian1 jiang3 pin1 yin1.'));
const b = JSON.stringify(synthesizePerf('da4 jia1 hao3! jin1 tian1 jiang3 pin1 yin1.'));
check('确定性（两次合成逐字节相同）', a === b);

// 3) 音素对应：ma1 的前 2 帧是 M（双唇成阻），随后是 A
const pMa = synthesizePerf('ma1', { pinyin: true });
const ms = pMa.frames.map((f) => f.m).slice(0, 4);
check('ma1 起音 2 帧 M 后转 A', ms[0] === 'M' && ms[1] === 'M' && ms[2] === 'A' && ms[3] === 'A', ms.join(','));

// 4) 句号停顿 ≈ round(0.45*30) 帧静音（m=M, o=0）
const pPause = synthesizePerf('ni3 hao3.', { pinyin: true });
const last = pPause.frames.length - 1;
const silenceRun = (() => {
  let n = 0;
  for (let i = last; i >= 0 && pPause.frames[i].m === 'M' && pPause.frames[i].o === 0; i--) n++;
  return n;
})();
check('句号停顿 ≈ 13~14 帧静音', silenceRun >= 12 && silenceRun <= 15, `run=${silenceRun}`);

// 5) 长停顿（≥0.6s）含呼吸帧（nd=0.12，嘴保持闭合）
const pBreath = synthesizePerf('ni3 hao3…', { pinyin: true });
const hasBreath = pBreath.frames.some((f) => f.nd > 0 && f.m === 'M' && f.o === 0);
check('长停顿（…=0.8s）有呼吸帧（闭唇+轻微点头）', hasBreath);

// 6) 句尾收势：句子最后发音帧包络已衰减（o ≤ 0.4）
const pEnd = synthesizePerf('pin1 yin1.', { pinyin: true });
const endSpeech = pEnd.frames.map((f) => f.o).filter((o) => o > 0);
check('句尾收势（末发音帧包络 ≤0.4）', endSpeech.length > 0 && endSpeech[endSpeech.length - 1] <= 0.4,
  `末帧 o=${endSpeech[endSpeech.length - 1]?.toFixed(3)}`);

// 7) estimated 模式：诚实标注 + 口型占位不含 M
const pEst = synthesizePerf('大家好，今天讲口型。');
check('estimated 模式标注', pEst.meta?.mode === 'estimated');
check('unknownChars 收录全部汉字', (pEst.meta?.unknownChars ?? []).join('') === '大家好今天讲口型');
check('estimated 口型占位不含 M', !pEst.frames.some((f, i) => i < pEst.frames.length - 14 && f.m === 'M' && f.o > 0));

// 8) 手势：句数与窗口对齐（t 单调、t1>t）
const pG = synthesizePerf('di4 yi1 ju4! di4 er4 ju4? di4 san1 ju4.', { pinyin: true });
check('手势窗口数 = 句数（3）', pG.gestures.length === 3, `n=${pG.gestures.length}`);
check('手势窗口 t/t1 单调且有序',
  pG.gestures.every((g, i, arr) => g.t1 > g.t && (i === 0 || g.t >= arr[i - 1].t1 - 0.15)));
check('首句手势 open', pG.gestures[0].kind === 'open');

// 9) 帧数与时长自洽
const pSelf = synthesizePerf('yi1 er2 san1 si4 wu3.', { pinyin: true });
check('帧数与 duration 自洽', Math.abs(pSelf.duration * pSelf.fps - pSelf.frames.length) < 1e-9);

// 10) sps 生效：更快语速 → 更少帧
const slow = synthesizePerf('yi1 er2 san1.', { pinyin: true, sps: 4 });
const fast = synthesizePerf('yi1 er2 san1.', { pinyin: true, sps: 8 });
check('sps 生效（快语速帧数更少）', fast.frames.length < slow.frames.length,
  `slow=${slow.frames.length} fast=${fast.frames.length}`);

process.exit(failures ? 1 : 0);
