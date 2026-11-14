/**
 * StoryProgram v2 —— P3 叙事层做厚（2026-11-14）。
 *
 * 设计立场：**不写第二套渲染器**。v2 是 v0 `WorldProgram` 的可 diff 超集，
 * 由 `resolveStoryProgram()` 编译成「一份普通 v0 program + 一份渲染选项」，
 * 再交给同一个 `renderWorldFrame(program, t, chars, opts)` 求值。
 *
 * 因此：
 *   · v0 golden 天然零漂移（未启用 v2 特性时编译结果逐字段等于原 program）；
 *   · 同一份 program 可以出横版 / 竖版 / 多语言，差异只在 `opts.fit` 与字幕查表；
 *   · 所有新能力仍是纯数据、可 diff、可无头校验。
 *
 * 借鉴：PSL 的 shot/composition 分离（构图与分镜解耦）、TPN 式并发事件轨、
 *       VAnim 的稀疏状态更新、talekit 的 shots + 多语言文本分离。
 *
 * 刻意不做：帧间插值、音频、自由 SVG 注入、自动分镜。理由见 CODE-AS-WORLD.md §12。
 */
import type {
  WorldProgram, Shot, Beat, BeatCast, SceneDef, CharSlot, WorldRenderOptions, CharTable,
} from './world';
import { validateWorldProgram } from './world';

// ─────────────────────────── v2 schema ───────────────────────────

/** 构图预设：与分镜解耦。分镜引用 composition id，构图里放镜头与角色落位默认值。 */
export type Composition = {
  id: string;
  /** 镜头默认值；shot.camera 的字段逐项覆盖它 */
  camera?: { x?: number; y?: number; zoom?: number };
  /** 该构图下角色锚点覆盖（castKey → 场景锚点名） */
  anchors?: Record<string, string>;
};

/** 画幅变体：只描述取景框，不复制场景数据。 */
export type Variant = {
  id: string;
  canvas: [number, number];
  mode?: 'contain' | 'cover';
  /** 世界坐标取景焦点（画幅会把它放在中心）。竖版/方版必给，否则主体会被裁掉。 */
  focus?: [number, number];
  /** 覆盖自动缩放倍率 */
  zoom?: number;
  /** 该画幅下隐藏的场景层 id。换画幅是重新取景，不该把说明性文字切成半截字母。
   *  场景数据仍只有一份，可见性是构图决策，不复制场景。 */
  hideLayers?: string[];
  /** 可选：按画幅微调镜头（竖版常需把主体上移） */
  camera?: { x?: number; y?: number; zoom?: number };
};

/** 并发事件轨：镜头、角色、字幕各自独立计时，编译时确定性合并。
 *  这是「并发事件」的最小可运行形态：不引入调度器、不引入时间不确定性。 */
export type EventTrack = {
  id: string;
  events: {
    at: number;
    cast?: Record<string, BeatCast>;
    captionKey?: string;
    caption?: string;
    /** 该事件切换镜头（编译时会把 shot 拆成子 shot） */
    camera?: { x?: number; y?: number; zoom?: number };
  }[];
};

/** 角色锁定：长程身份零漂移的可验证约束。
 *  `fingerprint` 是 CharData 结构化内容的确定性指纹，由 `charFingerprint()` 计算。 */
export type CharLock = {
  key: string;
  fingerprint?: string;
};

export type StoryShot = Omit<Shot, 'beats' | 'camera'> & {
  composition?: string;
  /** 引用 compositions 里的构图；与 shot.camera 可同时给（shot 优先） */
  camera?: { x?: number; y?: number; zoom?: number };
  /** v0 兼容：主轨事件 */
  beats?: Beat[];
  /** v2 并发轨 */
  tracks?: EventTrack[];
};

export type StoryProgram = Omit<WorldProgram, 'shots' | 'version'> & {
  version: 2;
  shots: StoryShot[];
  compositions?: Record<string, Composition>;
  variants?: Record<string, Variant>;
  /** locale → captionKey → 文案 */
  locales?: Record<string, Record<string, string>>;
  locks?: Record<string, CharLock>;
};

export type ProgramError = { path: string; code: string; message: string; fix: string };

export type ResolveOptions = {
  variant?: string;
  locale?: string;
};

export type ResolvedStory = {
  program: WorldProgram;
  renderOptions: WorldRenderOptions;
  /** 编译期元数据，供 Agent / 验证脚本读，不参与渲染 */
  meta: {
    variant: string | null;
    locale: string | null;
    compositionsUsed: string[];
    trackCount: number;
    cameraCuts: number;
    captionKeysResolved: number;
    locks: Record<string, CharLock>;
  };
};

// ─────────────────────────── 校验 ───────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const err = (out: ProgramError[], path: string, code: string, message: string, fix: string): void => {
  out.push({ path, code, message, fix });
};

/** v2 结构化校验：带 path + 稳定 code + fix，与 rig 校验器同形，Agent 可直接自修。 */
export const validateStoryProgram = (p: StoryProgram): { ok: boolean; errors: ProgramError[] } => {
  const e: ProgramError[] = [];
  if (!p || p.version !== 2) err(e, '$.version', 'P001', 'version 必须为 2', 'v0 program 请保持 version:1 并直接用 renderWorldFrame');
  if (!p) return { ok: false, errors: e };

  for (const [cid, c] of Object.entries(p.compositions ?? {})) {
    if (c.id !== cid) err(e, `$.compositions.${cid}.id`, 'P002', 'composition.id 与键名不一致', '改成与键名相同');
    for (const [k, anchor] of Object.entries(c.anchors ?? {})) {
      if (typeof anchor !== 'string') err(e, `$.compositions.${cid}.anchors.${k}`, 'P003', '锚点覆盖必须是字符串', '填入场景中存在的锚点名');
    }
  }
  for (const [vid, v] of Object.entries(p.variants ?? {})) {
    if (v.id !== vid) err(e, `$.variants.${vid}.id`, 'P004', 'variant.id 与键名不一致', '改成与键名相同');
    if (!Array.isArray(v.canvas) || v.canvas.length !== 2 || !v.canvas.every(isNum) || v.canvas.some((n) => n <= 0)) {
      err(e, `$.variants.${vid}.canvas`, 'P005', 'canvas 必须为 [正数, 正数]', '例如 [1080, 1920]');
    }
    if (v.mode && !['contain', 'cover'].includes(v.mode)) {
      err(e, `$.variants.${vid}.mode`, 'P006', 'mode 只能是 contain / cover', '删掉该字段即默认 contain');
    }
    // cover 不给 focus 会把主体裁出画外（2026-11-14 目检实证）：
    // 校验器必须替 Agent 拦下，而不是等成片里发现「只剩半张脸」。
    if (v.mode === 'cover' && !v.focus) {
      err(e, `$.variants.${vid}.focus`, 'P015', 'cover 画幅必须给 focus（世界坐标主体中心）',
          '例如 [380, 500]；它会被放到画幅中心，避免主体被裁出画面');
    }
    if (v.focus && (!Array.isArray(v.focus) || v.focus.length !== 2 || !v.focus.every(isNum))) {
      err(e, `$.variants.${vid}.focus`, 'P016', 'focus 必须为 [数字, 数字]', '填世界坐标点');
    }
    if (v.hideLayers !== undefined) {
      if (!Array.isArray(v.hideLayers) || !v.hideLayers.every((x) => typeof x === 'string')) {
        err(e, `$.variants.${vid}.hideLayers`, 'P017', 'hideLayers 必须是字符串数组', '例如 ["notes"]');
      } else {
        const known = new Set(Object.values(p.scenes ?? {}).flatMap((s) => s.layers.map((l) => l.id)));
        for (const lid of v.hideLayers) {
          if (!known.has(lid)) {
            err(e, `$.variants.${vid}.hideLayers`, 'P018', `场景里没有层 ${lid}`,
                `可用层：${[...known].join(', ')}`);
          }
        }
      }
    }
  }
  // 多语言覆盖完整性：每个 locale 必须包含所有 captionKey
  const keys = new Set<string>();
  for (const s of p.shots ?? []) {
    for (const t of s.tracks ?? []) for (const ev of t.events ?? []) if (ev.captionKey) keys.add(ev.captionKey);
  }
  for (const [loc, table] of Object.entries(p.locales ?? {})) {
    for (const k of keys) {
      if (typeof table?.[k] !== 'string') {
        err(e, `$.locales.${loc}.${k}`, 'P007', `locale ${loc} 缺少字幕 ${k}`,
            `补上 "${k}" 的本地化文案；漏了会在成片里出现空字幕`);
      }
    }
  }
  for (const [ck, lock] of Object.entries(p.locks ?? {})) {
    if (!p.chars?.[ck]) err(e, `$.locks.${ck}`, 'P008', `锁定的角色 ${ck} 未注册在 $.chars`, '先注册角色或删掉这条锁');
    else if (lock.key && p.chars[ck].key !== lock.key) {
      err(e, `$.locks.${ck}.key`, 'P009', `锁 ${lock.key} 与 $.chars.${ck}.key=${p.chars[ck].key} 冲突`,
          '两者必须一致：锁是用来防止角色被悄悄换掉的');
    }
  }

  p.shots?.forEach((s, i) => {
    const at = `$.shots[${i}]`;
    if (s.composition && !p.compositions?.[s.composition]) {
      err(e, `${at}.composition`, 'P010', `引用了不存在的构图 ${s.composition}`, '在 $.compositions 里补上，或改成已存在的 id');
    }
    for (const [ti, tr] of (s.tracks ?? []).entries()) {
      let prev = -1;
      for (const [ei, ev] of (tr.events ?? []).entries()) {
        const ep = `${at}.tracks[${ti}].events[${ei}]`;
        if (!isNum(ev.at) || ev.at < 0) err(e, `${ep}.at`, 'P011', 'at 必须 >= 0', '填非负秒数');
        else {
          if (ev.at < prev) err(e, `${ep}.at`, 'P012', '同一轨内 at 必须单调递增', '按时间顺序排列');
          if (isNum(s.duration) && ev.at >= s.duration) err(e, `${ep}.at`, 'P013', 'at 超出 shot 时长', '缩小 at 或加长 duration');
          prev = ev.at;
        }
        if (ev.captionKey && !p.locales) {
          err(e, `${ep}.captionKey`, 'P014', '用了 captionKey 但没有 $.locales', '补上 locales，或改回 caption 直接写文案');
        }
      }
    }
  });

  // 最后委托 v0 校验器：编译产物必须本来就是合法 program。
  // 先做一次免 locale 的解析，让 v0 把场景/锚点/Pose 等老规则再守一遍。
  try {
    const probe = resolveStoryProgram(p, {}, true);
    const v0 = validateWorldProgram(probe.program);
    for (const m of v0.errors) err(e, '$.(v0)', 'P099', m, '按 v0 校验器的提示修正');
  } catch (ex) {
    err(e, '$.', 'P098', `编译期异常：${(ex as Error).message}`, '检查 shots / tracks / compositions 的引用完整性');
  }
  return { ok: e.length === 0, errors: e };
};

// ─────────────────────────── 角色指纹 ───────────────────────────

/** CharData 的确定性内容指纹（FNV-1a over JSON.stringify）。
 *  刻意不引入 crypto：这是「同一份角色资产有没有被换掉」的工程校验，
 *  不是安全签名；纯函数、跨平台、无依赖。 */
export const charFingerprint = (data: unknown): string => {
  const s = JSON.stringify(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** 角色锁定复核：在渲染前显式验，避免「长程身份漂移」等到成片才发现。 */
export const verifyCharLocks = (
  locks: Record<string, CharLock> | undefined,
  slots: Record<string, CharSlot>,
  chars?: CharTable,
): { ok: boolean; errors: ProgramError[]; fingerprints: Record<string, string> } => {
  const e: ProgramError[] = [];
  const fingerprints: Record<string, string> = {};
  for (const [ck, lock] of Object.entries(locks ?? {})) {
    const slot = slots[ck];
    if (!slot) { err(e, `$.locks.${ck}`, 'L001', '锁定的角色未注册', '在 $.chars 注册'); continue; }
    if (slot.key !== lock.key) {
      err(e, `$.chars.${ck}.key`, 'L002', `角色被换掉：期望 ${lock.key}，实得 ${slot.key}`, '恢复原角色 key，或显式更新锁并留 diff');
      continue;
    }
    const data = chars?.[slot.key];
    if (!data) {
      if (lock.fingerprint) err(e, `$.locks.${ck}.fingerprint`, 'L003', '角色表缺少该角色，无法验指纹', '注入 CharTable 后再校验');
      continue;
    }
    const fp = charFingerprint(data);
    fingerprints[ck] = fp;
    if (lock.fingerprint && lock.fingerprint !== fp) {
      err(e, `$.locks.${ck}.fingerprint`, 'L004',
          `角色资产内容变了：锁 ${lock.fingerprint}，实得 ${fp}`,
          '确认是有意换资产则更新锁并在 git diff 里写清原因；否则恢复原资产');
    }
  }
  return { ok: e.length === 0, errors: e, fingerprints };
};

// ─────────────────────────── 编译 ───────────────────────────

type MergedEvent = {
  at: number;
  order: number;
  cast?: Record<string, BeatCast>;
  captionKey?: string;
  caption?: string;
  camera?: { x?: number; y?: number; zoom?: number };
};

const mergeCamera = (
  ...layers: ({ x?: number; y?: number; zoom?: number } | undefined)[]
): { x?: number; y?: number; zoom?: number } => {
  const out: { x?: number; y?: number; zoom?: number } = {};
  for (const l of layers) if (l) {
    if (l.x !== undefined) out.x = l.x;
    if (l.y !== undefined) out.y = l.y;
    if (l.zoom !== undefined) out.zoom = l.zoom;
  }
  return out;
};

/** 把 v2 编译成「普通 v0 program + 渲染选项」。
 *
 *  `probeOnly=true` 供校验器免 locale 地走一遍编译，不抛字幕缺失异常。
 *  纯函数：同输入必得同输出，不读时钟、不读环境变量。 */
export const resolveStoryProgram = (
  p: StoryProgram,
  opts: ResolveOptions = {},
  probeOnly = false,
): ResolvedStory => {
  const variant = opts.variant ? p.variants?.[opts.variant] : undefined;
  if (opts.variant && !variant) throw new Error(`不存在的画幅变体 ${opts.variant}`);
  const locale = opts.locale ?? null;
  if (locale && !p.locales?.[locale]) throw new Error(`不存在的语言 ${locale}`);

  const compositionsUsed = new Set<string>();
  let trackCount = 0;
  let cameraCuts = 0;
  let captionKeysResolved = 0;

  const shots: Shot[] = [];
  for (const s of p.shots) {
    const comp = s.composition ? p.compositions?.[s.composition] : undefined;
    if (s.composition) compositionsUsed.add(s.composition);
    // 构图 → 画幅覆盖 → 分镜自身，后者逐字段优先
    const baseCamera = mergeCamera(comp?.camera, variant?.camera, s.camera);

    // 1) 收集所有事件（v0 主轨 + v2 并发轨），确定性排序：at → 轨序 → 事件序
    const events: MergedEvent[] = [];
    (s.beats ?? []).forEach((b, i) => events.push({ ...b, order: i }));
    (s.tracks ?? []).forEach((tr, ti) => {
      trackCount++;
      (tr.events ?? []).forEach((ev, ei) => events.push({ ...ev, order: 1000 * (ti + 1) + ei }));
    });
    events.sort((a, b) => a.at - b.at || a.order - b.order);

    // 2) 同一 at 的事件合并成一个 beat（并发 = 同时生效，不是排队）
    const merged: MergedEvent[] = [];
    for (const ev of events) {
      const last = merged[merged.length - 1];
      if (last && last.at === ev.at) {
        last.cast = { ...(last.cast ?? {}), ...(ev.cast ?? {}) };
        if (ev.captionKey !== undefined) last.captionKey = ev.captionKey;
        if (ev.caption !== undefined) last.caption = ev.caption;
        if (ev.camera) last.camera = mergeCamera(last.camera, ev.camera);
      } else {
        merged.push({ ...ev, cast: { ...(ev.cast ?? {}) } });
      }
    }

    // 3) 字幕查表：captionKey → locales[locale][key]
    const resolvedCaption = (m: MergedEvent): string | undefined => {
      if (m.captionKey) {
        const text = locale ? p.locales?.[locale]?.[m.captionKey] : undefined;
        captionKeysResolved++;
        // 没选语言时退回原文案（若给了），避免编译出空字幕
        return text ?? m.caption ?? (probeOnly ? m.captionKey : undefined);
      }
      return m.caption;
    };

    // 4) 镜头切换事件把 shot 拆成子 shot（v0 的 camera 是 shot 级常量，
    //    用拆分表达时间轴上的镜头变化，不污染 v0 schema）
    const cuts = merged.filter((m) => m.camera);
    if (!cuts.length) {
      shots.push({
        id: s.id, scene: s.scene, duration: s.duration,
        camera: Object.keys(baseCamera).length ? baseCamera : undefined,
        beats: merged.map((m) => {
          const b: Beat = { at: m.at };
          if (Object.keys(m.cast ?? {}).length) b.cast = m.cast;
          const cap = resolvedCaption(m);
          if (cap !== undefined) b.caption = cap;
          return b;
        }),
      });
      continue;
    }
    cameraCuts += cuts.length;
    let activeCamera = mergeCamera(baseCamera);
    let segStart = 0;
    let segIdx = 0;
    let segBeats: Beat[] = [];
    const flush = (end: number): void => {
      const duration = end - segStart;
      // 镜头切在 at=0 时上一段长度为 0；跳过空段，否则 v0 校验器会报
      // "duration 必须为正数 / beats 不能为空"（verify3 首次运行暴露）。
      if (duration <= 0 || segBeats.length === 0) return;
      shots.push({
        id: `${s.id}#${segIdx}`, scene: s.scene, duration,
        camera: Object.keys(activeCamera).length ? { ...activeCamera } : undefined,
        beats: segBeats,
      });
      segIdx++;
    };
    for (const m of merged) {
      if (m.camera) {
        // 镜头事件是**新段起点**：先收上一段，再重置起点与镜头，
        // 最后才把该事件落在新段的 at=0（顺序反了会让 beat.at 超出段时长）。
        flush(m.at);
        segStart = m.at;
        segBeats = [];
        activeCamera = mergeCamera(baseCamera, m.camera);
      }
      const beat: Beat = { at: m.at - segStart };
      if (Object.keys(m.cast ?? {}).length) beat.cast = m.cast;
      const cap = resolvedCaption(m);
      if (cap !== undefined) beat.caption = cap;
      segBeats.push(beat);
    }
    flush(s.duration);
  }

  // 5) 构图里的锚点覆盖：不改场景，只改角色引用（场景仍是唯一事实源）
  const chars: Record<string, CharSlot> = {};
  for (const [ck, slot] of Object.entries(p.chars)) {
    let anchor = slot.anchor;
    for (const s of p.shots) {
      if (s.composition && (s.beats ?? []).some((b) => b.cast?.[ck])) {
        const override = p.compositions?.[s.composition]?.anchors?.[ck];
        if (override) { anchor = override; break; }
      }
    }
    chars[ck] = { ...slot, anchor };
  }

  // 画幅级图层可见性：只过滤层，不复制/改写场景图元（场景仍是唯一事实源）。
  const hide = new Set(variant?.hideLayers ?? []);
  const scenes: Record<string, SceneDef> = {};
  for (const [sid, scene] of Object.entries(p.scenes as Record<string, SceneDef>)) {
    scenes[sid] = hide.size
      ? { ...scene, layers: scene.layers.filter((l) => !hide.has(l.id)) }
      : scene;
  }

  const program: WorldProgram = {
    version: 1, id: p.id, title: p.title, canvas: p.canvas, fps: p.fps,
    chars, scenes, shots,
  };
  const renderOptions: WorldRenderOptions = variant
    ? { fit: { canvas: variant.canvas, mode: variant.mode ?? 'contain',
               ...(variant.focus ? { focus: variant.focus } : {}),
               ...(variant.zoom !== undefined ? { zoom: variant.zoom } : {}) } }
    : {};
  return {
    program, renderOptions,
    meta: {
      variant: variant?.id ?? null, locale,
      compositionsUsed: [...compositionsUsed].sort(),
      trackCount, cameraCuts, captionKeysResolved,
      locks: p.locks ?? {},
    },
  };
};
