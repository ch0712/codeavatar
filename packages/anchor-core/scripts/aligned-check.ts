// aligned 模式（真实字级时间戳对齐）数值断言。
// 运行：python tools/coartic_check.py packages/anchor-core/scripts/aligned-check.ts
//
// 断的是「口型是否落在上游给的真实发音时刻」——这是火山 TTS 字级时间戳接入后
// 唯一能证明对齐没退化的一组量；不涉及渲染，纯合成层。
import { synthesizePerf } from '../src/speech';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failures++;
};

const FPS = 30;
const CHARS = '今天讲一下口型同步的具体做法和常见问题';
// 与线上一致的形态：首字 0.355s 起，每字 0.19s（火山实测起点量级）
const words = [...CHARS].map((ch, i) => ({
  ch, s: +(0.355 + i * 0.19).toFixed(3), e: +(0.355 + i * 0.19 + 0.19).toFixed(3),
}));
const texts = {
  zh: CHARS + '。',
  pinyin: 'jin1 tian1 jiang3 yi2 xia4 kou3 xing2 tong2 bu4 de5 ju4 ti3 zuo4 fa3 he2 chang2 jian4 wen4 ti2.',
};
const pinyinSyllables = texts.pinyin.replace(/[.]/g, '').split(/\s+/);

const mkTimings = (withSyl: boolean) => words.map((w, i) => ({
  s: w.s, e: w.e,
  ...(withSyl ? { syl: pinyinSyllables[i] } : {}),
  ...(i === words.length - 1 ? { punct: '.' } : {}),
}));

// 1) 静音前缀：首字之前必须闭唇（不是随便张嘴等）
const p = synthesizePerf(texts.pinyin, { pinyin: true, timings: mkTimings(true), duration: 4.536 });
const firstFrame = Math.round(words[0].s * FPS);
check('meta.mode = aligned', p.meta.mode === 'aligned', String(p.meta.mode));
check('首字前全部闭唇且张口度为 0',
  p.frames.slice(0, firstFrame).every((f) => f.m === 'M' && f.o === 0),
  `前 ${firstFrame} 帧`);
check('首字起帧正好落在 round(s*fps)',
  p.frames[firstFrame].m !== 'M' || p.frames[firstFrame].o > 0,
  `frame=${firstFrame}`);

// 2) 逐字口型：韵母主元音映射（jin1→I、tian1→A、kou3→O）
const at = (i: number) => p.frames[Math.round(words[i].s * FPS) + 3]; // 跳过起音闭唇帧
check('「今」jin1 → I', at(0).m === 'I', at(0).m);
check('「天」tian1 → A', at(1).m === 'A', at(1).m);
check("「口」kou3 → O", at(5).m === "O", at(5).m);

// 3) 时长与音轨一致（帧数 = round(duration*fps)，不是按语速摊出来的）
check('帧数由音轨时长决定', p.frames.length === Math.round(4.536 * FPS),
  `${p.frames.length} vs ${Math.round(4.536 * FPS)}`);
check('末字之后补闭唇到尾',
  p.frames.slice(Math.round(words[words.length - 1].e * FPS) + 1).every((f) => f.m === 'M'));

// 4) 无拼音时口型按码点确定性轮转（诚实：音素不对应，但位置仍准）
const pz = synthesizePerf(texts.zh, { timings: mkTimings(false), duration: 4.536 });
const a1 = pz.frames[Math.round(words[0].s * FPS) + 3].m;
const pz2 = synthesizePerf(texts.zh, { timings: mkTimings(false), duration: 4.536 });
check('无拼音：同一字口型确定（两次相同）',
  a1 === pz2.frames[Math.round(words[0].s * FPS) + 3].m, a1);
check('无拼音：mode 仍是 aligned（不冒充音素对应）', pz.meta.mode === 'aligned');

// 5) 句末标点驱动意图轨（标点要归到前一个发音单元）
check('句末 "." → 意图 span 收在末字处',
  pz.intent.spans.length === 1
    && Math.abs(pz.intent.spans[0].t1 - (words[words.length - 1].e + 1 / FPS)) < 0.05,
  JSON.stringify(pz.intent.spans[0]));
check('句末标点 → 说明类意图', pz.intent.spans[0].intent === '说明');

// 6) 缺省零漂移：不给 timings 时走原路径，不由 aligned 影响
const legacy = synthesizePerf(texts.zh, {});
check('无 timings → mode=estimated（缺省不受影响）', legacy.meta.mode === 'estimated');
const legacyP = synthesizePerf(texts.pinyin, { pinyin: true });
check('无 timings + pinyin → mode=pinyin', legacyP.meta.mode === 'pinyin');

// 7) 空 timings 数组按缺省处理（不静默变成 0 帧）
const empty = synthesizePerf(texts.zh, { timings: [] });
check('空 timings 回落到缺省路径', empty.meta.mode === 'estimated' && empty.frames.length > 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
