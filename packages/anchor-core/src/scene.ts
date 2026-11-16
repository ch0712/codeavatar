/**
 * SceneProgram v1 —— 场景层做厚（2026-11-16）。
 *
 * 背景：WorldProgram v0 的场景只有 rect/circle/line/text 四种图元 + 一个 repeat，
 * 目检结果确实是 CODE-AS-WORLD.md §12.4 警告的「基础设施很厚、画面停在火柴人」。
 *
 * 本文件不写第二套渲染器（E5-075）：SceneProgram 是可 diff 的**语义超集**，
 * `resolveSceneProgram()` 把它编译成一份普通 `SceneDef`（world.ts 的受限图元 +
 * defs 渐变 / 可复用组件），最终仍由同一个 `renderWorldFrame()` 求值。
 *
 * 三条红线：
 *   ① 确定性：不用 Math.random、不读系统时钟，重复布局全部由 seed + LCG 决定；
 *   ② 受限：产物只有 world.ts 白名单里的图元，`d` 只含路径指令，属性经 esc() 转义；
 *   ③ 可验证：错误带 path/code/message/fix，编译末尾委托 v0 校验器再守一遍。
 */
import type {
  WorldProgram, SceneDef, SceneShape, SceneLayer, SceneGradient, SceneSymbol,
} from './world';
import { validateWorldProgram } from './world';

// ─────────────────────────────── schema ───────────────────────────────

export type SceneMood = 'dawn' | 'day' | 'dusk' | 'night';

/** 语义词 W 真正参与画面：mood → 一整套调色板，palette 可按键覆盖。 */
export type ScenePalette = {
  skyTop: string; skyBottom: string;
  sun: string; glow: string;
  haze: string; ridge: string;
  ground: string; groundLine: string;
  building: string; buildingDark: string; window: string;
  trunk: string; crown: string;
  beam: string;
};

export const SCENE_PALETTES: Record<SceneMood, ScenePalette> = {
  dawn: {
    skyTop: '#2B3A67', skyBottom: '#E9A87C', sun: '#FFE9B0', glow: '#FFC98A',
    haze: '#F4C9A8', ridge: '#6D5A73', ground: '#3B3340', groundLine: '#8A7390',
    building: '#4B4059', buildingDark: '#332C43', window: '#FFD79A',
    trunk: '#3A2E33', crown: '#4E6B58', beam: '#FFD9A0',
  },
  day: {
    skyTop: '#5EA9E0', skyBottom: '#CFEBF7', sun: '#FFF6D8', glow: '#FFF0BC',
    haze: '#E7F2F5', ridge: '#8FA9A6', ground: '#8C9A79', groundLine: '#D8DEC0',
    building: '#D9D2BE', buildingDark: '#A9A290', window: '#8FC4D8',
    trunk: '#6B5540', crown: '#5E8C55', beam: '#FFF3C4',
  },
  dusk: {
    skyTop: '#20284F', skyBottom: '#C46A72', sun: '#FFD9A0', glow: '#FF9E7A',
    haze: '#E29A87', ridge: '#4A3B5C', ground: '#2C2635', groundLine: '#6B5670',
    building: '#3A3048', buildingDark: '#261F34', window: '#FFC978',
    trunk: '#2E2630', crown: '#3E5A4E', beam: '#FFB27A',
  },
  night: {
    skyTop: '#0B1026', skyBottom: '#2C3A63', sun: '#EAF1FF', glow: '#9FB8FF',
    haze: '#3E4C78', ridge: '#232B4B', ground: '#141A2E', groundLine: '#4A5680',
    building: '#1D2542', buildingDark: '#121830', window: '#FFD98A',
    trunk: '#1A1B2A', crown: '#2C4A44', beam: '#A8C0FF',
  },
};

/** 参数化组件：Agent 写的是「几个语义参数」，不是几百行坐标。 */
export type SceneComponent =
  | { kind: 'sky'; sun?: { x: number; y: number; r: number } }
  | { kind: 'horizon'; y: number; peaks?: number; amplitude?: number }
  | { kind: 'ground'; y: number }
  | { kind: 'buildings'; y: number; count: number; minW: number; maxW: number; minH: number; maxH: number; windows?: boolean; seed?: number }
  | { kind: 'trees'; y: number; count: number; minH: number; maxH: number; seed?: number }
  | { kind: 'light'; x: number; y: number; rx: number; ry: number; beams?: number };

export type SceneProgram = {
  version: 1;
  id: string;
  /** 语义词（The Scene Language 的 W）：给人 / Agent 读，同时 mood 决定配色 */
  words: string;
  mood: SceneMood;
  canvas: [number, number];
  components: SceneComponent[];
  anchors: Record<string, [number, number]>;
  /** 按键覆盖 mood 预设，值必须是 #RRGGBB */
  palette?: Partial<ScenePalette>;
};

export type SceneError = { path: string; code: string; message: string; fix: string };

export type SceneMetrics = {
  components: number;
  anchors: number;
  paletteOverrides: number;
  /** 估计图元数：不看像素也能发现「count=200 且窗户全开」这类离谱程序 */
  shapeBudget: number;
  defsBudget: number;
};

export type SceneValidation = { ok: boolean; errors: SceneError[]; metrics: SceneMetrics };

// ─────────────────────────────── 校验 ───────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNum);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const COMPONENT_KINDS = ['sky', 'horizon', 'ground', 'buildings', 'trees', 'light'];

const err = (path: string, code: string, message: string, fix: string): SceneError =>
  ({ path, code, message, fix });

/** 所有错误一次收齐；任何坏输入都不抛异常（E3-071：校验器自身也会崩）。 */
export const validateSceneProgram = (p: unknown): SceneValidation => {
  const errors: SceneError[] = [];
  const o = isObj(p) ? p : {};
  if (!isObj(p)) errors.push(err('$', 'S001', '程序必须是对象', '把根节点写成 JSON 对象'));
  if (o.version !== 1) errors.push(err('$.version', 'S001', 'version 必须为 1', '设 "version": 1'));
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) {
    errors.push(err('$.id', 'S002', 'id 缺失或含非法字符', '用字母开头的 [a-zA-Z0-9_-] 标识符'));
  }
  if (typeof o.words !== 'string' || !o.words.trim()) {
    errors.push(err('$.words', 'S003', '语义词 words 不能为空', '写一句「这个场景是什么」的自然语言描述'));
  }
  if (!isPair(o.canvas) || (o.canvas as number[]).some((v) => v <= 0)) {
    errors.push(err('$.canvas', 'S004', 'canvas 必须为 [正数, 正数]', '例如 [1920, 1080]'));
  }
  if (typeof o.mood !== 'string' || !Object.prototype.hasOwnProperty.call(SCENE_PALETTES, o.mood)) {
    errors.push(err('$.mood', 'S005', 'mood 必须为 dawn / day / dusk / night', '选一个 SCENE_PALETTES 里的键'));
  }
  const [W, H] = (isPair(o.canvas) ? o.canvas : [1920, 1080]) as [number, number];

  const comps = Array.isArray(o.components) ? o.components : [];
  if (!Array.isArray(o.components) || comps.length === 0) {
    errors.push(err('$.components', 'S006', 'components 不能为空', '至少放一个 sky / horizon / ground 组件'));
  }

  const palette = isObj(o.palette) ? o.palette : {};
  for (const [k, v] of Object.entries(palette)) {
    if (!Object.prototype.hasOwnProperty.call(SCENE_PALETTES.day, k)) {
      errors.push(err(`$.palette.${k}`, 'S007', `未知的调色板键 ${k}`, '只覆盖 SCENE_PALETTES 里已有的键'));
    } else if (typeof v !== 'string' || !HEX_RE.test(v)) {
      errors.push(err(`$.palette.${k}`, 'S008', '颜色必须是 #RRGGBB', '例如 "#2B3A67"'));
    }
  }

  const anchors = isObj(o.anchors) ? o.anchors : {};
  if (!isObj(o.anchors) || Object.keys(anchors).length === 0) {
    errors.push(err('$.anchors', 'S009', 'anchors 不能为空', '至少给角色留一个命名锚点'));
  }
  for (const [k, v] of Object.entries(anchors)) {
    if (!isPair(v)) {
      errors.push(err(`$.anchors.${k}`, 'S010', '锚点必须为 [数字, 数字]', '例如 [90, 70]'));
    } else if ((v as number[])[0] < 0 || (v as number[])[0] > W || (v as number[])[1] < 0 || (v as number[])[1] > H) {
      errors.push(err(`$.anchors.${k}`, 'S010', '锚点超出画布', `把坐标收进 [0..${W}, 0..${H}]`));
    }
  }

  let shapeBudget = 0;
  let defsBudget = 0;
  comps.forEach((raw, i) => {
    const at = `$.components[${i}]`;
    const c = isObj(raw) ? raw : {};
    if (!isObj(raw)) { errors.push(err(at, 'S011', '组件必须是对象', '写成 {"kind": "..."}')); return; }
    if (typeof c.kind !== 'string' || !COMPONENT_KINDS.includes(c.kind)) {
      errors.push(err(`${at}.kind`, 'S011', `未知组件 ${String(c.kind)}`, `kind 取 ${COMPONENT_KINDS.join(' / ')}`));
      return;
    }
    // 所有数值参数统一类型检查
    for (const k of ['x', 'y', 'rx', 'ry', 'peaks', 'amplitude', 'count', 'minW', 'maxW', 'minH', 'maxH', 'beams']) {
      if (k in c && c[k] !== undefined && !isNum(c[k])) {
        errors.push(err(`${at}.${k}`, 'S012', `${k} 必须为数字`, '填有限数字，不要字符串或 null'));
      }
    }
    if ('y' in c && isNum(c.y) && (c.y < 0 || c.y > H)) {
      errors.push(err(`${at}.y`, 'S013', 'y 超出画布高度', `把 y 收进 0..${H}`));
    }
    if ('count' in c && (!isNum(c.count) || (c.count as number) < 1 || (c.count as number) > 200 || !Number.isInteger(c.count))) {
      errors.push(err(`${at}.count`, 'S014', 'count 必须为 1..200 的整数', '例如 8'));
      shapeBudget += 200;
    } else if ('count' in c && isNum(c.count)) {
      shapeBudget += (c.count as number) * (c.kind === 'buildings' ? 18 : 2);
    }
    for (const [lo, hi] of [['minW', 'maxW'], ['minH', 'maxH']] as const) {
      if (isNum(c[lo]) && isNum(c[hi]) && (c[lo] as number) > (c[hi] as number)) {
        errors.push(err(`${at}.${lo}`, 'S015', `${lo} 不能大于 ${hi}`, '交换两值或调小下界'));
      }
      if (isNum(c[lo]) && (c[lo] as number) <= 0 && (lo === 'minW' || lo === 'minH')) {
        errors.push(err(`${at}.${lo}`, 'S015', `${lo} 必须为正数`, '填 > 0 的数'));
      }
    }
    if ('seed' in c && c.seed !== undefined && (!isNum(c.seed) || !Number.isInteger(c.seed))) {
      errors.push(err(`${at}.seed`, 'S016', 'seed 必须为整数（确定性随机源）', '例如 7'));
    }
    if (c.kind === 'sky' && c.sun !== undefined) {
      // 嵌套字段也要给到**精确 path**（E3-072：结构化错误是可执行契约）。
      // 只报一句「sun 非法」Agent 不知道该改 x 还是 r。
      const s = isObj(c.sun) ? c.sun : {};
      if (!isObj(c.sun)) {
        errors.push(err(`${at}.sun`, 'S017', 'sun 必须是对象', '例如 {"x":1400,"y":240,"r":72}'));
      } else {
        for (const k of ['x', 'y', 'r']) {
          if (s[k] === undefined) errors.push(err(`${at}.sun.${k}`, 'S017', `sun.${k} 缺失`, '补齐 x / y / r 三个字段'));
          else if (!isNum(s[k])) errors.push(err(`${at}.sun.${k}`, 'S012', `sun.${k} 必须为数字`, '填有限数字，不要字符串或 null'));
        }
        if (isNum(s.r) && (s.r as number) <= 0) {
          errors.push(err(`${at}.sun.r`, 'S017', 'r 必须为正数', '例如 72'));
        }
        if (isNum(s.x) && isNum(s.y)
          && ((s.x as number) < 0 || (s.x as number) > W || (s.y as number) < 0 || (s.y as number) > H)) {
          errors.push(err(`${at}.sun`, 'S017', '太阳中心超出画布', `把 x/y 收进画布 [${W},${H}]`));
        }
      }
      defsBudget += 2;
    }
    if (c.kind === 'light' && c.beams !== undefined && (!isNum(c.beams) || !Number.isInteger(c.beams) || (c.beams as number) < 0 || (c.beams as number) > 12)) {
      errors.push(err(`${at}.beams`, 'S018', 'beams 必须为 0..12 的整数', '例如 4'));
    }
    if (c.kind === 'horizon') defsBudget += 2;
    if (c.kind === 'buildings' || c.kind === 'trees' || c.kind === 'light') defsBudget += 1;
  });
  // 阈值必须落在 count ≤ 200 能触达的区间，否则这条规则是永远不会亮的死代码：
  // 一栋楼约 18 个图元（楼体 + 屋顶 + 窗户），200 栋 ≈ 3600，正常场景 < 250。
  if (shapeBudget > 2000) {
    errors.push(err('$.components', 'S019', `估计图元数 ${shapeBudget} 超过预算 2000`, '降低 count 或关掉 buildings.windows'));
  }

  return {
    ok: errors.length === 0,
    errors,
    metrics: {
      components: comps.length,
      anchors: Object.keys(anchors).length,
      paletteOverrides: Object.keys(palette).length,
      shapeBudget,
      defsBudget,
    },
  };
};

// ─────────────────────────── 确定性工具 ───────────────────────────

/** LCG：同一 seed 永远给出同一序列。禁止 Math.random（纯函数红线）。 */
const rng = (seed: number): (() => number) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const n = (v: number, d = 2): string => String(Math.round(v * 10 ** d) / 10 ** d);

// ─────────────────────────── 编译降级 ───────────────────────────

/** 编译成普通 SceneDef；产物只含 world.ts 白名单图元，由同一个 renderWorldFrame 求值。 */
export const resolveSceneProgram = (program: SceneProgram): SceneDef => {
  const v = validateSceneProgram(program);
  if (!v.ok) {
    throw new Error(`SceneProgram 非法：\n  ${v.errors.map((e) => `${e.code} ${e.path} ${e.message}`).join('\n  ')}`);
  }
  const p = program;
  const [W, H] = p.canvas;
  const pal: ScenePalette = { ...SCENE_PALETTES[p.mood], ...(p.palette ?? {}) };
  const gradients: SceneGradient[] = [];
  const symbols: SceneSymbol[] = [];
  const layers: SceneLayer[] = [];
  const push = (id: string, role: SceneLayer['role'], shapes: SceneShape[], repeat?: SceneLayer['repeat']) =>
    layers.push({ id, role, shapes, ...(repeat ? { repeat } : {}) });

  // 绘制层次是编译决策，不取决于人在 JSON 里书写的先后。
  // 若按原顺序出 layers，把 ground 写在 sky 前面就会被天空盖掉；
  // 稳定排序（同 kind 保留书写顺序）让「可 diff 的语义程序」不携带隐性顺序契约。
  const DRAW_ORDER: Record<SceneComponent['kind'], number> = {
    sky: 0, horizon: 1, ground: 2, buildings: 3, trees: 4, light: 5,
  };
  const ordered = p.components
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => DRAW_ORDER[a.c.kind] - DRAW_ORDER[b.c.kind] || a.idx - b.idx);

  ordered.forEach(({ c, idx }) => {
    // defs id 带组件序号：同一组件出现两次也不会撞 id
    const tag = `c${idx}`;
    const gid = (name: string) => `${name}-${tag}`;
    switch (c.kind) {
      case 'sky': {
        gradients.push({
          id: gid('sky'), kind: 'linear', from: [0, 0], to: [0, 1],
          stops: [
            { offset: 0, color: pal.skyTop },
            { offset: 0.62, color: pal.skyBottom },
            { offset: 1, color: pal.haze },
          ],
        });
        push(`${tag}-sky`, 'far', [{ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: `url(#${gid('sky')})` }]);
        if (c.sun) {
          gradients.push({
            id: gid('sunGlow'), kind: 'radial', center: [0.5, 0.5], radius: 0.5,
            stops: [{ offset: 0, color: pal.glow, opacity: 0.72 }, { offset: 1, color: pal.glow, opacity: 0 }],
          });
          push(`${tag}-sun`, 'far', [
            { kind: 'ellipse', cx: c.sun.x, cy: c.sun.y, rx: c.sun.r * 3.6, ry: c.sun.r * 3.6, fill: `url(#${gid('sunGlow')})` },
            { kind: 'circle', cx: c.sun.x, cy: c.sun.y, r: c.sun.r, fill: pal.sun },
          ]);
        }
        break;
      }
      case 'horizon': {
        const peaks = c.peaks ?? 7;
        const amp = c.amplitude ?? 90;
        const r = rng(20261116 + idx);
        const ridge = (base: number, scale: number, color: string, opacity: number): SceneShape => {
          const parts = [`M 0 ${n(base)}`];
          for (let i = 0; i <= peaks; i++) {
            parts.push(`L ${n((W / peaks) * i)} ${n(base - amp * scale * (0.3 + 0.7 * r()))}`);
          }
          parts.push(`L ${W} ${H}`, `L 0 ${H}`, 'Z');
          return { kind: 'path', d: parts.join(' '), fill: color, opacity };
        };
        gradients.push({
          id: gid('mist'), kind: 'linear', from: [0, 0], to: [0, 1],
          stops: [
            { offset: 0, color: pal.haze, opacity: 0 },
            { offset: 0.5, color: pal.haze, opacity: 0.5 },
            { offset: 1, color: pal.haze, opacity: 0 },
          ],
        });
        push(`${tag}-ridge-far`, 'far', [ridge(c.y, 1, pal.ridge, 0.72)]);
        push(`${tag}-ridge-near`, 'far', [ridge(c.y + amp * 0.55, 0.55, pal.buildingDark, 0.55)]);
        push(`${tag}-mist`, 'far', [
          { kind: 'rect', x: 0, y: c.y - 20, w: W, h: 210, fill: `url(#${gid('mist')})` },
        ]);
        break;
      }
      case 'ground': {
        // 地面属 far：若设 near，它会盖住 mid 层的树干与建筑底部（目检级穿帮）。
        push(`${tag}-ground`, 'far', [
          { kind: 'rect', x: 0, y: c.y, w: W, h: H - c.y, fill: pal.ground },
          { kind: 'line', x1: 0, y1: c.y, x2: W, y2: c.y, stroke: pal.groundLine, width: 3 },
        ]);
        // repeat：一份数据表达多条透视线，而不是 n 行坐标
        push(`${tag}-ground-lines`, 'far', [
          { kind: 'line', x1: 0, y1: c.y + 44, x2: W, y2: c.y + 44, stroke: pal.groundLine, width: 1, opacity: 0.22 },
        ], { count: 5, dx: 0, dy: 46 });
        break;
      }
      case 'buildings': {
        const r = rng(c.seed ?? 7);
        const windowId = gid('window');
        symbols.push({ id: windowId, shapes: [
          { kind: 'rect', x: 0, y: 0, w: 16, h: 26, fill: pal.window, opacity: 0.9 },
        ] });
        const shapes: SceneShape[] = [];
        let x = -20;
        for (let i = 0; i < c.count; i++) {
          const w = c.minW + (c.maxW - c.minW) * r();
          const h = c.minH + (c.maxH - c.minH) * r();
          shapes.push({ kind: 'rect', x, y: c.y - h, w, h, fill: i % 3 === 0 ? pal.buildingDark : pal.building });
          shapes.push({ kind: 'polygon', points: [
            [x - 6, c.y - h], [x + w + 6, c.y - h], [x + w / 2, c.y - h - 26],
          ], fill: pal.buildingDark, opacity: 0.75 });
          if (c.windows !== false) {
            const cols = Math.max(1, Math.floor(w / 44));
            const rows = Math.max(1, Math.floor((h - 40) / 52));
            for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
              if (r() < 0.28) continue;
              shapes.push({ kind: 'use', symbol: windowId, x: x + 18 + a * 42, y: c.y - h + 30 + b * 52 });
            }
          }
          x += w + 10;
        }
        push(`${tag}-buildings`, 'mid', shapes);
        break;
      }
      case 'trees': {
        const treeId = gid('tree');
        symbols.push({ id: treeId, shapes: [
          { kind: 'rect', x: -7, y: -70, w: 14, h: 70, fill: pal.trunk },
          { kind: 'circle', cx: 0, cy: -96, r: 38, fill: pal.crown },
          { kind: 'circle', cx: -30, cy: -78, r: 30, fill: pal.crown },
          { kind: 'circle', cx: 30, cy: -78, r: 30, fill: pal.crown },
          { kind: 'ellipse', cx: 0, cy: -122, rx: 34, ry: 40, fill: pal.crown, opacity: 0.85 },
        ] });
        const r = rng(c.seed ?? 19);
        const shapes: SceneShape[] = [];
        for (let i = 0; i < c.count; i++) {
          const x = W * (0.06 + 0.88 * (i + 0.5) / c.count) + (r() - 0.5) * 40;
          const h = c.minH + (c.maxH - c.minH) * r();
          shapes.push({ kind: 'use', symbol: treeId, x, y: c.y, scale: h / 140 });
        }
        push(`${tag}-trees`, 'mid', shapes);
        break;
      }
      case 'light': {
        const beamId = gid('beam');
        gradients.push({
          id: beamId, kind: 'radial', center: [0.5, 0.5], radius: 0.5,
          stops: [{ offset: 0, color: pal.beam, opacity: 0.5 }, { offset: 1, color: pal.beam, opacity: 0 }],
        });
        const shapes: SceneShape[] = [
          { kind: 'ellipse', cx: c.x, cy: c.y, rx: c.rx, ry: c.ry, fill: `url(#${beamId})` },
        ];
        const beams = c.beams ?? 0;
        for (let i = 0; i < beams; i++) {
          const spread = c.rx * (0.3 + 0.7 * i / Math.max(1, beams - 1));
          shapes.push({ kind: 'polygon', points: [
            [c.x - 14, c.y - 20], [c.x + 14, c.y - 20],
            [c.x + spread, c.y + c.ry * 1.6], [c.x - spread, c.y + c.ry * 1.6],
          ], fill: pal.beam, opacity: 0.07 });
        }
        push(`${tag}-light`, 'near', shapes);
        break;
      }
    }
  });

  const def: SceneDef = {
    id: p.id,
    words: `${p.words} / mood=${p.mood}`,
    bg: pal.skyBottom,
    layers,
    anchors: p.anchors,
    ...(gradients.length || symbols.length ? { defs: { gradients, symbols } } : {}),
  };

  // 编译末尾委托 v0 校验器再守一遍（E5-075）：编译产物必须是合法 WorldProgram 的场景。
  const probe: WorldProgram = {
    version: 1, id: `_scene_probe_${p.id}`, title: '', canvas: p.canvas, fps: 30,
    chars: {}, scenes: { [p.id]: def },
    shots: [{ id: 'probe', scene: p.id, duration: 1, beats: [{ at: 0 }] }],
  };
  const errs = validateWorldProgram(probe).errors;
  if (errs.length) throw new Error(`SceneProgram 编译产物未通过 world 校验：\n  ${errs.join('\n  ')}`);
  return def;
};

/** 故事的 scenes 直接写语义 SceneProgram，整份 program 就没有任何坐标堆砌。
 *  编译成普通 WorldProgram 后仍由同一个 renderWorldFrame 求值。 */
export type ScenedWorldProgram = Omit<WorldProgram, 'scenes'> & {
  scenes: Record<string, SceneProgram>;
};

export const resolveScenedWorld = (p: ScenedWorldProgram): WorldProgram => {
  const scenes: Record<string, SceneDef> = {};
  for (const [k, sp] of Object.entries(p.scenes ?? {})) {
    if (!sp || sp.id !== k) throw new Error(`场景 ${k} 的 id 与键名不一致`);
    if (!Array.isArray(sp.canvas) || sp.canvas[0] !== p.canvas[0] || sp.canvas[1] !== p.canvas[1]) {
      throw new Error(`场景 ${k} 的 canvas 与世界画布不一致：${JSON.stringify(sp.canvas)} vs ${JSON.stringify(p.canvas)}`);
    }
    scenes[k] = resolveSceneProgram(sp);
  }
  const out: WorldProgram = {
    version: 1, id: p.id, title: p.title, canvas: p.canvas, fps: p.fps,
    chars: p.chars, scenes, shots: p.shots,
  };
  const v = validateWorldProgram(out);
  if (!v.ok) throw new Error(`编译后的世界程序非法：\n  ${v.errors.join('\n  ')}`);
  return out;
};
