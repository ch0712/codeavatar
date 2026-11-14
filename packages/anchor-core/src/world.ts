/**
 * WorldProgram v0 —— 「代码作为视觉世界」第一刀（2026-11-14）。
 *
 * 主张（docs/CODE-AS-WORLD.md）：角色、场景、叙事不是三个功能，
 * 而是同一份**可 diff 的程序**在不同尺度上的展开。核心契约只有一个纯函数：
 *
 *     renderWorldFrame(program, t, chars) -> SVG 字符串
 *
 * 任意时刻 t 求值，不依赖系统时钟、不依赖 DOM、不依赖 Remotion。
 * 角色部分**严格复用 svg.ts 的 renderFaceSvg**（唯一事实源纪律），
 * 本文件只负责「场景图元 + 锚点放置 + 时间线状态合并 + 组合」，
 * 绝不再写一份人脸渲染器。
 *
 * 三层对应：
 *   scenes —— 场景程序：受限图元 + repeat（层次/循环）+ 语义词 words + 锚点 anchors
 *   shots  —— 叙事程序：分镜 + 镜头 + 稀疏状态更新（与 VAnim 的 SSU 同构）+ 字幕
 *   chars  —— 角色引用：只放放置参数；CharData 由调用方注入，
 *             因此可发布运行时包不会被迫内置角色美术资产。
 *
 * 刻意不做（v0 边界）：不做帧间插值、不做音频、不生成 MP4、不做自由 SVG 注入。
 * 理由见 CODE-AS-WORLD.md §12：先证明「抽象统一 + 确定性 + 可验证」，
 * 不急着证明「好看」——后者正是 animdsl 三次重写和 noF 两轮返工的共同教训。
 */
import { NEUTRAL, VISEME, MOODS, POSE_RANGES } from './types';
import type { Pose, Viseme } from './types';
import { renderFaceSvg } from './svg';
import type { CharData } from './FaceTraced';

// ─────────────────────────────── 程序 schema ───────────────────────────────

/** 场景图元：刻意是**受限集合**而不是自由 SVG 字符串。
 *  自由 SVG 会让场景重新变成不可 diff、不可校验、Agent 容易写坏的黑盒。 */
export type SceneShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string; r?: number; opacity?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; opacity?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width?: number; opacity?: number }
  | { kind: 'text'; x: number; y: number; text: string; size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number };

export type SceneLayer = {
  id: string;
  role: 'far' | 'mid' | 'near';
  shapes: SceneShape[];
  /** 程序化重复：把 shapes 按 dx/dy 平移 count 份。
   *  这是 The Scene Language 里 program(P) 的最小可运行形态：
   *  循环与重复模式用一份数据表达，而不是 n 份坐标。 */
  repeat?: { count: number; dx: number; dy: number };
};

export type SceneDef = {
  id: string;
  /** 语义词（The Scene Language 的 W）：给人和 Agent 读，不参与渲染 */
  words: string;
  bg: string;
  layers: SceneLayer[];
  /** 命名锚点：角色/道具按名字落位，而不是写死坐标 */
  anchors: Record<string, [number, number]>;
};

export type CharSlot = {
  /** 角色 key，由调用方注入的 CharTable 提供 CharData */
  key: string;
  anchor: string;
  scale: number;
  offset?: [number, number];
};

/** 一次稀疏状态更新：只写这一拍相对上一拍变化的字段。
 *  与 VAnim 的 Sparse State Updates 同构——持久结构上只改 (id, attr, value)。 */
export type BeatCast = {
  viseme?: Viseme;
  mood?: string;
  pose?: Partial<Pose>;
  /** 隐藏该角色（换场/空镜） */
  hidden?: boolean;
};

export type Beat = {
  /** shot 内相对秒；同一 shot 内必须单调递增 */
  at: number;
  cast?: Record<string, BeatCast>;
  caption?: string;
};

export type Shot = {
  id: string;
  scene: string;
  /** 秒 */
  duration: number;
  /** 镜头：屏幕坐标平移 + 缩放。刻意用 screen coords，
   *  与 Prose Storyboard Language 一致——不引入世界坐标。 */
  camera?: { x?: number; y?: number; zoom?: number };
  beats: Beat[];
};

export type WorldProgram = {
  version: 1;
  id: string;
  title: string;
  canvas: [number, number];
  fps: number;
  /** 角色引用表：只放放置参数，不放 CharData */
  chars: Record<string, CharSlot>;
  scenes: Record<string, SceneDef>;
  shots: Shot[];
};

export type CharTable = Record<string, CharData>;

export type WorldRenderOptions = {
  /** 文档级 id 前缀：同页放多帧时必须给不同值 */
  idPrefix?: string;
  /** P3 多画幅（可选）：把「同一份 program」适配到另一尺寸的画布。
   *
   *  刻意做成渲染选项而不是改 program.canvas：program 仍是唯一事实源，
   *  横版/竖版/方形共用同一份场景与分镜数据，只是取景框不同。
   *  **不传 fit 时输出逐字节等于 v0**（golden 零漂移靠这一点守住）。
   *  contain = 全内容可见（可能留边，由 bg 铺满）；cover = 铺满（可能裁切）。
   *
   *  focus = 世界坐标里的取景焦点，会落在画幅中心。**竖版/方版必须给**：
   *  2026-11-14 目检发现，居中的 cover 会把角色裁成画面左缘一条侧脸，
   *  居中的 contain 会让 16:9 世界缩在竖版顶部、下方 70% 空白。
   *  换画幅不是「把整张横版塞进另一个框」，而是「对准主体重新取景」。
   *  zoom 可覆盖自动缩放（例如竖版不想把主体放得过大）。 */
  fit?: {
    canvas: [number, number];
    mode?: 'contain' | 'cover';
    focus?: [number, number];
    zoom?: number;
  };
};

// ─────────────────────────────── 校验 ───────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isViseme = (v: string): v is Viseme => Object.prototype.hasOwnProperty.call(VISEME, v);

/** 结构化校验：返回带路径的错误列表，供 Agent 直接照着改。
 *  对应 Rev2D 的 validate / open-bot-avatar 的 validateAvatar：
 *  「Agent 能在说自己做完之前先证明程序合法」。 */
export const validateWorldProgram = (p: WorldProgram): { ok: boolean; errors: string[] } => {
  const e: string[] = [];
  if (!p || p.version !== 1) e.push('$.version 必须为 1');
  if (!p || !Array.isArray(p.canvas) || p.canvas.length !== 2 || !p.canvas.every(isNum) || p.canvas.some((v) => v <= 0)) {
    e.push('$.canvas 必须为 [正数, 正数]');
  }
  if (!p || !isNum(p.fps) || p.fps <= 0) e.push('$.fps 必须为正数');
  if (!p) return { ok: false, errors: e };

  if (!p.shots || !p.shots.length) e.push('$.shots 不能为空');
  if (!p.scenes || !Object.keys(p.scenes).length) e.push('$.scenes 不能为空');

  for (const [ck, slot] of Object.entries(p.chars ?? {})) {
    if (!slot.key) e.push(`$.chars.${ck}.key 缺失`);
    if (!isNum(slot.scale) || slot.scale <= 0) e.push(`$.chars.${ck}.scale 必须为正数`);
    if (!slot.anchor) e.push(`$.chars.${ck}.anchor 缺失`);
  }

  for (const [sid, scene] of Object.entries(p.scenes ?? {})) {
    if (scene.id !== sid) e.push(`$.scenes.${sid}.id 与键名不一致`);
    if (!scene.anchors || !Object.keys(scene.anchors).length) e.push(`$.scenes.${sid}.anchors 不能为空`);
    for (const [aid, xy] of Object.entries(scene.anchors ?? {})) {
      if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(isNum)) e.push(`$.scenes.${sid}.anchors.${aid} 必须为 [数字, 数字]`);
    }
    for (const layer of scene.layers ?? []) {
      if (!['far', 'mid', 'near'].includes(layer.role)) e.push(`$.scenes.${sid}.layers.${layer.id}.role 非法`);
      if (layer.repeat && (!isNum(layer.repeat.count) || layer.repeat.count < 1 || layer.repeat.count > 200)) {
        e.push(`$.scenes.${sid}.layers.${layer.id}.repeat.count 必须在 1..200`);
      }
      for (const s of layer.shapes ?? []) checkShape(s, `$.scenes.${sid}.layers.${layer.id}`, e);
    }
  }

  (p.shots ?? []).forEach((shot, i) => {
    const at = `$.shots[${i}]`;
    let prevAt = -1;
    if (!isNum(shot.duration) || shot.duration <= 0) e.push(`${at}.duration 必须为正数`);
    if (!p.scenes?.[shot.scene]) e.push(`${at}.scene 引用了不存在的场景 ${shot.scene}`);
    if (!shot.beats?.length) e.push(`${at}.beats 不能为空`);
    for (const [bi, beat] of (shot.beats ?? []).entries()) {
      if (!isNum(beat.at) || beat.at < 0) e.push(`${at}.beats[${bi}].at 必须 >= 0`);
      if (isNum(beat.at)) {
        if (beat.at < prevAt) e.push(`${at}.beats[${bi}].at 必须单调递增`);
        if (isNum(shot.duration) && beat.at >= shot.duration) e.push(`${at}.beats[${bi}].at 超出 shot 时长`);
        prevAt = beat.at;
      }
      for (const [castKey, st] of Object.entries(beat.cast ?? {})) {
        if (!p.chars?.[castKey]) e.push(`${at}.beats[${bi}].cast.${castKey} 未注册在 $.chars`);
        if (st.viseme && !isViseme(st.viseme)) e.push(`${at}.beats[${bi}].cast.${castKey}.viseme 非法`);
        if (st.mood && !MOODS[st.mood]) e.push(`${at}.beats[${bi}].cast.${castKey}.mood 不存在于 MOODS`);
        for (const [pk, pv] of Object.entries(st.pose ?? {})) {
          const range = (POSE_RANGES as Record<string, [number, number]>)[pk];
          if (!range) e.push(`${at}.beats[${bi}].cast.${castKey}.pose.${pk} 不是合法 Pose 字段`);
          else if (!isNum(pv) || pv < range[0] || pv > range[1]) {
            e.push(`${at}.beats[${bi}].cast.${castKey}.pose.${pk} 超出 [${range[0]}, ${range[1]}]`);
          }
        }
      }
    }
    // 每个角色的锚点必须在它出现的场景里存在
    for (const [castKey, slot] of Object.entries(p.chars ?? {})) {
      const used = (shot.beats ?? []).some((b) => b.cast?.[castKey]);
      if (used && !p.scenes?.[shot.scene]?.anchors?.[slot.anchor]) {
        e.push(`${at}: 角色 ${castKey} 的锚点 ${slot.anchor} 不在场景 ${shot.scene} 中`);
      }
    }
  });

  return { ok: e.length === 0, errors: e };
};

const checkShape = (s: SceneShape, at: string, e: string[]): void => {
  const nums: Record<string, unknown> = s as unknown as Record<string, unknown>;
  for (const k of ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'size', 'width', 'opacity', 'weight']) {
    if (k in nums && nums[k] !== undefined && !isNum(nums[k])) e.push(`${at}.shape.${s.kind}.${k} 必须为数字`);
  }
  if (s.kind === 'text' && typeof s.text !== 'string') e.push(`${at}.shape.text.text 必须为字符串`);
  if (s.kind === 'rect' && isNum(s.w) && s.w <= 0) e.push(`${at}.shape.rect.w 必须为正数`);
  if ((s.kind === 'circle') && isNum(s.r) && s.r <= 0) e.push(`${at}.shape.circle.r 必须为正数`);
};

// ─────────────────────────── 时间线求值（纯函数） ───────────────────────────

export type ShotState = { shot: Shot; shotIndex: number; localT: number };

/** 定位 t 落在哪个分镜；t 超出总时长时钳到最后一镜末尾（确定性，不抛错）。 */
export const shotAt = (p: WorldProgram, t: number): ShotState => {
  let acc = 0;
  for (let i = 0; i < p.shots.length; i++) {
    const d = p.shots[i].duration;
    if (t < acc + d || i === p.shots.length - 1) {
      return { shot: p.shots[i], shotIndex: i, localT: Math.max(0, Math.min(d, t - acc)) };
    }
    acc += d;
  }
  return { shot: p.shots[0], shotIndex: 0, localT: 0 };
};

export const programDuration = (p: WorldProgram): number =>
  p.shots.reduce((a, s) => a + s.duration, 0);

/** 稀疏状态合并：从 shot 起点扫到 localT，后写覆盖前写。
 *  没有插值——v0 用 hold，保证每一帧都能独立求值、独立验证、独立做 golden。
 *  （DyCraft 的 pose-to-pose：先把静态关键帧做对，再谈运动。） */
export const stateAt = (shot: Shot, localT: number): Record<string, BeatCast> & { caption?: string } => {
  const out: Record<string, BeatCast> & { caption?: string } = {};
  for (const beat of shot.beats) {
    if (beat.at > localT) break;
    if (beat.caption !== undefined) out.caption = beat.caption;
    for (const [k, st] of Object.entries(beat.cast ?? {})) {
      out[k] = { ...(out[k] ?? {}), ...st, pose: { ...(out[k]?.pose ?? {}), ...(st.pose ?? {}) } };
    }
  }
  return out;
};

/** 稀疏状态 → 完整 Pose。叠加顺序与 studio/src/VisemeGrid.tsx 一致，
 *  保证同一组参数在运行时、Remotion、WorldProgram 三个入口下画面一致。 */
export const poseOf = (st: BeatCast): Pose => ({
  ...NEUTRAL,
  ...(st.mood ? MOODS[st.mood] : {}),
  ...(st.viseme ? VISEME[st.viseme] : {}),
  ...(st.pose ?? {}),
}) as Pose;

/** 文档级 id 前缀规则：一处定义，渲染与验证共用，避免两边拼法漂移。 */
export const charIdPrefix = (opts: WorldRenderOptions, shotIndex: number, castKey: string): string =>
  `${opts.idPrefix ?? 'w'}-s${shotIndex}-${castKey}`;

/** demo 采样点：每个 beat 的绝对时间（换帧即换状态，浏览器只负责显示）。 */
export const frameTimes = (p: WorldProgram): { t: number; shotId: string; beatAt: number }[] => {
  let acc = 0;
  const out: { t: number; shotId: string; beatAt: number }[] = [];
  for (const shot of p.shots) {
    for (const beat of shot.beats) out.push({ t: acc + beat.at, shotId: shot.id, beatAt: beat.at });
    acc += shot.duration;
  }
  return out;
};

// ─────────────────────────────── 渲染 ───────────────────────────────

const esc = (v: unknown): string => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (v: number, d = 2): string => String(Math.round(v * 10 ** d) / 10 ** d);

const shapeSvg = (s: SceneShape, dx: number, dy: number): string => {
  const op = (v?: number) => (v === undefined ? '' : ` opacity="${num(v, 3)}"`);
  switch (s.kind) {
    case 'rect':
      return `<rect x="${num(s.x + dx)}" y="${num(s.y + dy)}" width="${num(s.w)}" height="${num(s.h)}" rx="${num(s.r ?? 0)}" fill="${esc(s.fill)}"${op(s.opacity)}/>`;
    case 'circle':
      return `<circle cx="${num(s.cx + dx)}" cy="${num(s.cy + dy)}" r="${num(s.r)}" fill="${esc(s.fill)}"${op(s.opacity)}/>`;
    case 'line':
      return `<line x1="${num(s.x1 + dx)}" y1="${num(s.y1 + dy)}" x2="${num(s.x2 + dx)}" y2="${num(s.y2 + dy)}" stroke="${esc(s.stroke)}" stroke-width="${num(s.width ?? 1)}"${op(s.opacity)}/>`;
    case 'text':
      return `<text x="${num(s.x + dx)}" y="${num(s.y + dy)}" font-size="${num(s.size ?? 32)}" fill="${esc(s.fill ?? '#1D1922')}" text-anchor="${esc(s.anchor ?? 'start')}" font-weight="${num(s.weight ?? 400, 0)}" font-family="system-ui,-apple-system,Segoe UI,sans-serif">${esc(s.text)}</text>`;
  }
};

const layerSvg = (layer: SceneLayer): string => {
  const n = layer.repeat?.count ?? 1;
  const dx = layer.repeat?.dx ?? 0;
  const dy = layer.repeat?.dy ?? 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    for (const s of layer.shapes) out += shapeSvg(s, dx * i, dy * i);
  }
  return out;
};

/** 剥掉角色 SVG 的根 <svg> 标签，取其内部内容。
 *  FaceTraced 输出形如 <svg viewBox="0 0 1360 2048" ...>…</svg>（单根、无 xmlns 依赖），
 *  内部全部是 user space 坐标，因此可以直接放进 <g transform>。 */
export const faceBody = (svg: string): string =>
  svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** 渲染世界在时刻 t 的一帧为纯 SVG 字符串。
 *  纯函数：同 program + 同 t + 同 chars + 同 opts ⇒ 逐字节相同。 */
export const renderWorldFrame = (
  p: WorldProgram,
  t: number,
  chars: CharTable,
  opts: WorldRenderOptions = {},
): string => {
  const v = validateWorldProgram(p);
  if (!v.ok) throw new Error(`WorldProgram 非法：\n  ${v.errors.join('\n  ')}`);

  const [W, H] = p.canvas;
  const { shot, shotIndex, localT } = shotAt(p, t);
  const scene = p.scenes[shot.scene];
  const state = stateAt(shot, localT);
  const cam = shot.camera ?? {};

  const cameraTransform =
    `translate(${num(W / 2 + (cam.x ?? 0))} ${num(H / 2 + (cam.y ?? 0))}) ` +
    `scale(${num(cam.zoom ?? 1, 4)}) translate(${num(-W / 2)} ${num(-H / 2)})`;

  // 场景层按 role 排序（far → mid → near），同 role 内保持 JSON 中的顺序
  const rank: Record<SceneLayer['role'], number> = { far: 0, mid: 1, near: 2 };
  const layers = [...scene.layers].sort((a, b) => rank[a.role] - rank[b.role]);
  // P3 多画幅：取景框与程序画布分离。不传 fit 时 [VW,VH] === [W,H]，
  // 下面所有字符串与 v0 逐字节相同（verify3.mjs 用 golden 守这条）。
  const fit = opts.fit;
  const [VW, VH] = fit?.canvas ?? [W, H];
  const fitS = fit
    ? (fit.zoom ?? (fit.mode === 'cover' ? Math.max(VW / W, VH / H) : Math.min(VW / W, VH / H)))
    : 1;
  // 无 focus 时退化为「整幅居中」（= 旧行为，v0/v3 既有输出不受影响）；
  // 给 focus 时把该世界坐标点平移到取景框中心，主体就不会被裁出画外。
  const focus = fit?.focus ?? [W / 2, H / 2];
  const fitTx = (VW - W * fitS) / 2 + (W / 2 - focus[0]) * fitS;
  const fitTy = (VH - H * fitS) / 2 + (H / 2 - focus[1]) * fitS;
  const fitOpen = fit
    ? `<g transform="translate(${num(fitTx)} ${num(fitTy)}) scale(${num(fitS, 6)})">`
    : '';
  const fitClose = fit ? '</g>' : '';

  // 背景是「画面层」不是「世界层」：必须铺在 camera 变换之外。
  // 2026-11-14 目检发现：把背景色块放进 camera 组后，镜头横移会在画面边缘
  // 露出未绘制区域（暗色场景右侧一条白边）——而全部机检断言都 PASS。
  // 这与 noF 嘴部「量具 PASS 但人眼看出失败」是同一类盲区，故背景与字幕同列。
  // 多画幅时铺满取景框，保证任何画幅都不会露出未绘制区域（同型缺陷不复发）。
  const bgSvg = `<rect x="0" y="0" width="${VW}" height="${VH}" fill="${esc(scene.bg)}"/>`;
  let sceneSvg = '';
  for (const layer of layers) sceneSvg += layerSvg(layer);

  // 角色：稀疏状态更新 → 完整 Pose → 唯一渲染器 renderFaceSvg
  for (const [castKey, slot] of Object.entries(p.chars)) {
    const st = state[castKey];
    if (!st || st.hidden) continue;
    const data = chars[slot.key];
    if (!data) throw new Error(`角色表缺少 ${slot.key}（cast ${castKey}）`);
    const anchor = scene.anchors[slot.anchor];
    if (!anchor) throw new Error(`场景 ${scene.id} 缺少锚点 ${slot.anchor}`);
    const prefix = charIdPrefix(opts, shotIndex, castKey);
    const face = renderFaceSvg(data, poseOf(st), { transparentBg: true, idPrefix: prefix });
    const [ox, oy] = slot.offset ?? [0, 0];
    sceneSvg += `<g transform="translate(${num(anchor[0] + ox)} ${num(anchor[1] + oy)}) scale(${num(slot.scale, 4)})">`
      + faceBody(face) + `</g>`;
  }

  // 字幕在屏幕空间，不随镜头移动（PSL：字幕是画面层，不是世界层）
  // 多画幅时贴在取景框底部，而不是程序画布底部。
  let overlay = '';
  if (state.caption) {
    const text = esc(state.caption);
    overlay = `<g><rect x="0" y="${num(VH - 132)}" width="${VW}" height="132" fill="#141117" opacity="0.82"/>`
      + `<text x="${num(VW / 2)}" y="${num(VH - 58)}" font-size="40" fill="#F9F2E4" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif">${text}</text></g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="100%" height="100%" style="display:block">`
    + `${bgSvg}${fitOpen}<g transform="${cameraTransform}">${sceneSvg}</g>${fitClose}${overlay}</svg>`;
};
