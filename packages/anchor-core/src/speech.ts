// 文本 → 表演合成（阶段 3 / ROADMAP §4-3 第 2 项）。
//
// 分层回退（诚实降级，不冒充）：
//   pinyin 模式    —— 输入是拼音音节（可带调号），韵母主元音 → 六口型，
//                     b/p/m/f 声母给起音闭唇帧，音素视觉对应成立；
//   estimated 模式 —— 中文逐字节奏估计：时长与停顿按规则计算（确定性），
//                     但口型不保证对应发音，perf.meta.mode='estimated' 显式标注。
//
// 同文本同参数 → 逐字节相同的 Perf（确定性可复现，渲染可复现）。
// 音频对齐器接口留待后续：届时以 aligned 模式接入，本文件规则仅作回退。
import { Perf, PerfFrame } from './perf';
import { Viseme } from './types';
import type { MotionTrack } from './motion';
import { applyMotionStyle } from './style';
import type { MotionStyle } from './style';

export type SynthOptions = {
  fps?: number;
  /** 音节速率（每秒音节数），默认 5.5 ≈ 正常语速 */
  sps?: number;
  /** 确定性随机种子（视线游移用），默认 20261102 */
  seed?: number;
  /** 输入是拼音音节序列（音素视觉对应）；缺省按中文逐字估计 */
  pinyin?: boolean;
  /** 低幅动作轨（阶段 3 第 4 项）：显式开启才生成 Perf.motion
   * （注视目标 / 眨眼节奏 / 头部预备-跟随-收势 / 呼吸）。缺省不生成——
   * 已有产物的输出必须零漂移（硬纪律 #2）。 */
  motion?: boolean;
  /** 角色风格协调（阶段 3 第 5 项）：幅度增益/轨开关/头-眼耦合/锁定轨。
   * 给出即隐含 motion: true（风格没有对象就不成立）；空 style 应用后
   * 与纯 motion 产物逐字段相等。 */
  style?: MotionStyle;
  /** 对齐模式：真实字级时间戳（火山 TTS 等上游给出），单位秒。
   * 给出即走 aligned 分支——口型落在真实发音时刻，不再按平均语速摊。
   * 缺省不启用（默认路径零漂移）。syl 是可选拼音音节（有则音素视觉对应）。 */
  timings?: Array<{ s: number; e: number; syl?: string; punct?: string }>;
  /** 音轨总时长（秒）：aligned 模式下把静音尾巴补足到音频结束，
   * 保证成片与音轨等长。缺省按末字 endTime 收尾。 */
  duration?: number;
};

export const DEFAULT_SPS = 5.5;
const DEFAULT_FPS = 30;

/** 标点 → 停顿时长（秒）。连续同类标点折叠取最大（"……"不叠加）。 */
const PAUSE: Record<string, number> = {
  '，': 0.22, '、': 0.22, ',': 0.18, ';': 0.22, '；': 0.22,
  '：': 0.18, ':': 0.18,
  '。': 0.45, '.': 0.45, '!': 0.45, '！': 0.45, '?': 0.45, '？': 0.45,
  '…': 0.8, '—': 0.3,
};

const VOWEL_ORDER: Array<[string, Viseme]> = [
  ['a', 'A'], ['o', 'O'], ['e', 'E'], ['i', 'I'], ['u', 'U'], ['v', 'U'], ['ü', 'U'],
];
const CLOSED_ONSET = ['b', 'p', 'm', 'f'];

/** 拼音音节 → 口型。返回 null 表示不是合法拼音（调用方决定降级路径）。
 * 韵母按主元音映射（a>o>e>i>u>ü 扫描序，先还原 iu/ui/un 的省写）。 */
export const syllableViseme = (
  syl: string,
): { viseme: Viseme; closedOnset: boolean } | null => {
  const m = /^([a-züv]+)([1-5])?$/.exec(syl.toLowerCase().trim());
  if (!m) return null;
  let final = m[1];
  // 剥声母：最长匹配（zh/ch/sh 双字符优先）
  let onset = '';
  for (const ini of ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'y', 'w']) {
    if (final.startsWith(ini) && ini.length > onset.length) onset = ini;
  }
  if (onset.length >= final.length) return null; // 纯声母不是音节
  final = final.slice(onset.length);
  // 省写还原：iu=iou(main o)、ui=uei(main e)、un=uen(main e)
  final = final.replace('iu', 'iou').replace('ui', 'uei').replace('un', 'uen');
  let viseme: Viseme | null = null;
  for (const [ch, v] of VOWEL_ORDER) {
    if (final.includes(ch)) { viseme = v; break; }
  }
  if (viseme === null) viseme = 'E'; // 罕见残韵母回退
  return { viseme, closedOnset: CLOSED_ONSET.includes(onset) };
};

/** 音节内包络：正弦起音-峰-收，o ∈ (0,1]，确定性。 */
const envAt = (i: number, n: number): number =>
  Math.sin((Math.PI * (i + 0.5)) / n);

const mkFrame = (m: Viseme, o: number, nd = 0): PerfFrame => ({
  m, o, br: 0, nd, g: 'none', env: o, sp: 0, gz: [0, 0],
});

/** 确定性 LCG（与 perf.ts 扫视表同族），视线游移用。 */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

/**
 * 文本 → Perf（确定性）。
 *
 * 时长模型：每音节 round(fps/sps) 帧；标点停顿按 PAUSE 表；
 * ≥0.6s 的静音中点给 2 帧呼吸（m=M 闭唇、nd=0.12 轻微点头下沉）；
 * 句尾收势由包络自然衰减 + 句末停顿承担，无隐式副作用（纪律同 moodLabels）。
 * 手势：每句一个窗口，句序决定 kind（open/point/circle/strike）。
 * 视线：确定性游移（LCG 种子可调），幅度 ±0.55 / 垂直 ±0.3。
 */
export const synthesizePerf = (text: string, opts: SynthOptions = {}): Perf => {
  const fps = opts.fps ?? DEFAULT_FPS;
  const sps = opts.sps ?? DEFAULT_SPS;
  const frames: PerfFrame[] = [];
  const sentences: Array<{ a: number; b: number; punct: string }> = []; // 起/末发音帧 + 句尾标点
  const unknown: string[] = [];

  const syllableFrames = Math.max(2, Math.round(fps / sps));
  let curSentenceStart = -1;

  const pushSilence = (seconds: number, allowBreath = true) => {
    const n = Math.round(seconds * fps);
    if (n <= 0) return;
    const mid = n >> 1;
    const breath = allowBreath && n >= Math.round(0.6 * fps);
    for (let i = 0; i < n; i++) {
      // 呼吸：闭唇 + 轻微点头下沉（鼻呼吸嘴不张，诚实建模）
      frames.push(mkFrame('M', 0, breath && (i === mid || i === mid + 1) ? 0.12 : 0));
    }
  };

  const pushSyllable = (viseme: Viseme, closedOnset: boolean, stress: boolean,
                        n: number = syllableFrames) => {
    const onsetN = closedOnset && n >= 4 ? 2 : 0;
    const first = frames.length;
    for (let i = 0; i < n; i++) {
      let o = envAt(i, n);
      if (stress) o = Math.min(1, o * 1.15);
      if (i < onsetN) {
        frames.push(mkFrame('M', 0.15)); // 起音闭唇（双唇音成阻）
      } else {
        frames.push(mkFrame(viseme, o));
        if (curSentenceStart < 0) curSentenceStart = first;
      }
    }
    // 句尾收势由包络衰减承担（末帧 o≈0.31），无隐式强制
  };

  const endSentence = (punct = '') => {
    if (curSentenceStart >= 0) {
      sentences.push({ a: curSentenceStart, b: frames.length - 1, punct });
      curSentenceStart = -1;
    }
  };

  const CYCLE: Viseme[] = ['A', 'O', 'E', 'I', 'U'];

  if (opts.timings && opts.timings.length) {
    // ---- aligned 模式：真实字级时间戳（火山 TTS 等上游产物） ----
    // 帧位置直接由秒换帧，不参与平均语速模型；字间空档闭唇（不臆造呼吸）。
    // 有 syl 则音素视觉对应，无 syl 则按码点确定性轮转（诚实：音素不对应）。
    const timings = opts.timings;
    for (const tk of timings) {
      // 帧窗由**绝对时刻**决定（round(s*fps) .. round(e*fps)），不是
      // 「每字 round((e-s)*fps) 帧」—— 后者每字都会把 0.19s 抬成 6 帧（0.2s），
      // 19 字累计超前约 6 帧（0.2s），长文本越说越早。这里先截掉上一字的
      // 溢出帧再补静音，保证每字都精确落在自己的结束帧。
      const startF = Math.round(tk.s * fps);
      const endF = Math.round(tk.e * fps);
      if (frames.length > startF) frames.length = startF;
      while (frames.length < startF) frames.push(mkFrame('M', 0));
      const n = Math.max(1, endF - startF);
      const stress = /[!！?？]/.test(tk.punct ?? '');
      const sv = tk.syl ? syllableViseme(tk.syl) : null;
      if (sv === null) {
        const key = tk.syl ?? '·';
        pushSyllable(CYCLE[key.codePointAt(0)! % CYCLE.length], false, stress, n);
      } else {
        pushSyllable(sv.viseme, sv.closedOnset, stress, n);
      }
      if (tk.punct) endSentence(tk.punct);
    }
    const tail = opts.duration ?? timings[timings.length - 1].e;
    const total = Math.max(frames.length, Math.round(tail * fps));
    while (frames.length < total) frames.push(mkFrame('M', 0));
  } else if (opts.pinyin) {
    // ---- 拼音模式：音素视觉对应 ----
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const lead = /^[，。！？；：、,.!?;:…—]+/.exec(tok)?.[0] ?? '';
      const tail = /[，。！？；：、,.!?;:…—]+$/.exec(tok)?.[0] ?? '';
      const core = tok.slice(lead.length, tok.length - tail.length);
      for (const p of lead) pushSilence(PAUSE[p] ?? 0.2, true);
      if (core) {
        const sv = syllableViseme(core);
        if (sv === null) {
          // 非法音节：按静音处理并记录（诚实，不猜）
          if (!unknown.includes(core)) unknown.push(core);
          pushSilence(fps / sps, false);
        } else {
          const stress = /^[!！?？]+$/.test(tail);
          pushSyllable(sv.viseme, sv.closedOnset, stress);
        }
      }
      // 尾标点：同类折叠取最大停顿
      if (tail) {
        const maxPause = Math.max(...[...tail].map((p) => PAUSE[p] ?? 0.2));
        pushSilence(maxPause, true);
        // 半角 '.' 也要切句（2026-11-03 修：中句 '.' 结尾时句子不切分，
        // 说明句被并入下一句，intent/头部动作轨随之粘连——此前被末尾
        // endSentence('.') 兜底掩盖，中句场景一直漏）
        if (/[。！？!?.…]/.test(tail)) endSentence(tail);
      }
    }
  } else {
    // ---- 中文模式：节奏估计（诚实降级） ----
    let lastChar = '';
    for (const ch of text) {
      if (PAUSE[ch] !== undefined) {
        // 同类标点折叠（… 连续 / ！！ 连续不叠加）
        const seconds = ch === lastChar ? 0 : PAUSE[ch];
        lastChar = ch;
        if (seconds > 0) pushSilence(seconds, true);
        if ('。！？…'.includes(ch)) endSentence(ch);
        continue;
      }
      lastChar = '';
      if (/\s/.test(ch)) { pushSilence(0.06, false); continue; }
      if (/[\u4e00-\u9fff]/.test(ch)) {
        if (!unknown.includes(ch)) unknown.push(ch);
        // 口型占位：按码点确定性轮转五开口型（不含 M），节奏真实、音素不对应
        const cycle: Viseme[] = ['A', 'O', 'E', 'I', 'U'];
        const viseme = cycle[ch.codePointAt(0)! % cycle.length];
        pushSyllable(viseme, false, false);
        continue;
      }
      // 其他字符（字母数字等）：静音跳过
      pushSilence(0.08, false);
    }
  }
  endSentence('.');

  // 视线游移：确定性 LCG，停留 0.7~1.1s，3 帧缓动换目标
  const rnd = lcg(opts.seed ?? 20261102);
  let holdUntil = Math.round(0.5 * fps); // 开场 0.5s 看镜头
  let cur: [number, number] = [0, 0];
  let next: [number, number] = [0, 0];
  let jumpFrom = 0;
  for (let f = 0; f < frames.length; f++) {
    if (f >= holdUntil) {
      jumpFrom = f;
      next = [(rnd() * 2 - 1) * 0.55, (rnd() * 2 - 1) * 0.3];
      holdUntil = f + Math.round((0.7 + rnd() * 0.4) * fps);
    }
    const k = Math.min(1, (f - jumpFrom) / 3);
    cur = [cur[0] + (next[0] - cur[0]) * k, cur[1] + (next[1] - cur[1]) * k];
    frames[f].gz = [cur[0], cur[1]];
  }

  // 手势：每句一个窗口（起点略提前 2 帧，收在句末停顿前）
  const KINDS = ['open', 'point', 'circle', 'strike'];
  const gestures = sentences.map(({ a, b }, i) => ({
    t: Math.max(0, a - 2) / fps,
    t1: (b + 1) / fps,
    kind: i === 0 ? 'open' : KINDS[i % KINDS.length],
    word: '',
  }));

  // 意图轨（阶段 3）：句尾标点 → 意图；！强调(0.9) / ？疑问(0.8) / 其余说明(0.6)。
  // 情绪由 intentEmotionAt 连续驱动（onset/hold/release），不再从手势类别间接映射。
  const SENTENCE_INTENT: Record<string, { intent: '说明' | '强调' | '疑问'; k: number }> = {
    '!': { intent: '强调', k: 0.9 }, '！': { intent: '强调', k: 0.9 },
    '?': { intent: '疑问', k: 0.8 }, '？': { intent: '疑问', k: 0.8 },
  };
  const intent = {
    spans: sentences.map(({ a, b, punct }) => {
      const si = SENTENCE_INTENT[punct.slice(-1)] ?? { intent: '说明' as const, k: 0.6 };
      return { t: a / fps, t1: (b + 1) / fps, intent: si.intent, intensity: si.k };
    }),
  };

  // 低幅动作轨（显式开关，阶段 3 第 4 项）。全部确定性：同文本同参数逐字节相同。
  const wantMotion = opts.motion || opts.style !== undefined;
  let motion: MotionTrack | undefined;
  if (wantMotion) {
    const total = frames.length;
    // 眨眼节奏：首眨钳到素材内（0.5~1.3s，短句也不落空），之后间隔 0.9~2.0s、
    // 28% 概率紧跟补眨（幅度略小）。素材 <0.5s 时无眨眼（诚实：眨不完一次）。
    const blinkEvents: Array<{ t: number; amp: number; rate: number }> = [];
    let bf = total > Math.round(0.5 * fps) + 8
      ? Math.min((0.5 + rnd() * 0.8) * fps, total - 8)
      : Infinity;
    while (bf < total - 6) {
      blinkEvents.push({ t: bf / fps, amp: 0.82 + rnd() * 0.18, rate: 2 + Math.floor(rnd() * 2) });
      let nf = bf + (0.9 + rnd() * 1.1) * fps;
      if (rnd() < 0.28 && bf + 12 < total - 6) {
        blinkEvents.push({ t: (bf + 5 + Math.floor(rnd() * 3)) / fps, amp: 0.6 + rnd() * 0.25, rate: 2 });
        nf += 16;
      }
      bf = nf;
    }
    // 注视目标：0.9~1.3s 窗口轮换；偶数窗看镜头，奇数窗看侧方。
    // away 幅度不靠随机抽样（LCG 样本可能落在小幅度上，F2 瞳孔偏心判据就赌运气）：
    // 方向左右交替、幅度 0.7~1.0 满档，垂直 ±0.4。系数 1.0 与 motion 路径对齐。
    const gazeSpans: Array<{ t: number; t1: number; target: { x: number; y: number } }> = [];
    let gf = 0;
    let wi = 0;
    while (gf < total) {
      // 首窗固定 0.5s 看镜头（与旧 wander 的开场约定一致，短素材也能进轮换）
      const w = wi === 0 ? Math.round(0.5 * fps) : Math.round((0.9 + rnd() * 0.4) * fps);
      const a = gf, b = Math.min(total, gf + w);
      const isAway = wi % 2 === 1;
      const dir = wi % 4 === 1 ? -1 : 1;
      gazeSpans.push({
        t: a / fps, t1: b / fps,
        target: isAway
          ? { x: dir * (0.7 + rnd() * 0.3), y: (rnd() * 2 - 1) * 0.4 }
          : { x: 0, y: 0 },
      });
      gf = b;
      wi++;
    }
    // 头部：每句一个小动作——强调/疑问句点头（nod 0.5），其余句小幅侧倾（±0.2 交替）
    const headSpans = sentences.map(({ a, b, punct }, i) => {
      const emphatic = /[！!？?]/.test(punct);
      return {
        t: a / fps, t1: (b + 1) / fps,
        ...(emphatic ? { nod: 0.5 } : { tilt: (i % 2 === 0 ? 1 : -1) * 0.2 }),
      };
    });
    motion = {
      blink: { events: blinkEvents },
      gaze: { spans: gazeSpans },
      head: { spans: headSpans },
      breath: { bpm: 14 },
    };
    // 风格协调（阶段 3 第 5 项）：增益/开关/耦合/锁定应用于生成结果。
    // 空对象 ≡ 恒等变换（style-check 断言），默认零漂移。
    if (opts.style) motion = applyMotionStyle(motion, opts.style);
  }

  return {
    fps,
    duration: frames.length / fps,
    frames,
    gestures,
    intent,
    ...(motion ? { motion } : {}),
    meta: {
      mode: opts.timings && opts.timings.length
        ? 'aligned'
        : opts.pinyin ? 'pinyin' : 'estimated',
      ...(unknown.length ? { unknownChars: unknown } : {}),
    },
  };
};
