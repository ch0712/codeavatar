/**
 * AppearanceSpec v1 —— 角色外观质感（2026-11-17）。
 *
 * 背景：§17.3 对账写的是「矢量干净但塑料」，`FaceTraced.tsx` 里除了鼻子一个
 * `shadowHex` 椭圆，没有任何光照 / 材质 / 高光 / 轮廓系统。Q3 要补这一层。
 *
 * 设计纪律（与 P3/P4 一脉相承）：
 *   ① **显式开关**：appearance 缺省 undefined 时，FaceTraced 的 JSX 一行都不增，
 *      输出逐字节不变 —— no4 15 帧 golden / parity / world v0·v3·v4 golden
 *      的零漂移由构造保证，不靠回归碰运气。
 *   ② **可 diff**：灯光方向与强度是数值参数，不是贴图或滤镜字符串；
 *      预设是一份可读 JSON 式对象，Agent 能按 path 改。
 *   ③ **纯 SVG 图元**：只用 linear/radialGradient + clipPath + path，
 *      不引入 feGaussianBlur / feSpecularLighting 等滤镜 —— 后者跨宿主光栅化
 *      口径不一，会破坏同管线 parity（E3-061）。
 *   ④ **不碰嘴部量具**：材质罩插在嘴组之前，且 clip 只含 body layers。
 *      gate_mouth 的色彩判据（E3-054）因此不受影响。
 */
export type AppearanceSpec = {
  version: 1;
  /** 光源方向，各分量 -1..1；x 为负表示光从左侧来，y 为负表示从上方来 */
  light: { x: number; y: number };
  /** 主光（方向性明暗）强度 0..1 */
  diffuse: number;
  /** 边缘暗角 / 环境遮蔽强度 0..1 */
  ambient: number;
  /** 局部高光（颧骨 / 额头）强度 0..1 */
  specular: number;
  /** 轮廓描边强度 0..1 */
  rim: number;
  /** 可选配色覆盖，均为 #RRGGBB */
  highlight?: string;
  shadow?: string;
  rimColor?: string;
};

/** 语义预设：一句名字就是一整套灯位，避免 Agent 逐字段猜数。
 *  shadow 一律用近乎中性的深色：阴影是整屏叠加上去的，若带饱和紫/蓝，
 *  会把纯黑的头发与镜框染出灰紫块（目检实锤）；冷暖交给 highlight / rimColor。 */

export const APPEARANCE_PRESETS: Record<string, AppearanceSpec> = {
  studio: {
    version: 1, light: { x: -0.6, y: -0.5 },
    diffuse: 0.42, ambient: 0.30, specular: 0.34, rim: 0.16,
  },
  sunset: {
    version: 1, light: { x: 0.62, y: 0.10 },
    diffuse: 0.54, ambient: 0.26, specular: 0.42, rim: 0.22,
    highlight: '#FFE2B0', rimColor: '#FFD9A0', shadow: '#241C22',
  },
  night: {
    version: 1, light: { x: 0.30, y: -0.70 },
    diffuse: 0.30, ambient: 0.46, specular: 0.22, rim: 0.28,
    highlight: '#B9CFFF', rimColor: '#9FB8FF', shadow: '#0A0D18',
  },
};

export type AppearanceError = { path: string; code: string; message: string; fix: string };
export type AppearanceValidation = { ok: boolean; errors: AppearanceError[] };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const err = (path: string, code: string, message: string, fix: string): AppearanceError =>
  ({ path, code, message, fix });

const STRENGTH_KEYS = ['diffuse', 'ambient', 'specular', 'rim'] as const;
const COLOR_KEYS = ['highlight', 'shadow', 'rimColor'] as const;
const ALLOWED = new Set(['version', 'light', ...STRENGTH_KEYS, ...COLOR_KEYS]);

/** 一次收齐全部错误；任何坏输入都不抛异常（E3-071）。 */
export const validateAppearance = (a: unknown): AppearanceValidation => {
  const e: AppearanceError[] = [];
  if (!isObj(a)) return { ok: false, errors: [err('$', 'A001', '外观参数必须是对象', '传一个 AppearanceSpec 或预设名对应的对象')] };
  if (a.version !== 1) e.push(err('$.version', 'A002', 'version 必须为 1', '填 1'));
  if (!isObj(a.light)) {
    e.push(err('$.light', 'A003', 'light 必须为 {x, y}', '例如 {"x":-0.6,"y":-0.5}'));
  } else {
    for (const k of ['x', 'y'] as const) {
      if (!isNum(a.light[k])) e.push(err(`$.light.${k}`, 'A004', `light.${k} 必须为数字`, '填 -1..1 之间的有限数字'));
      else if ((a.light[k] as number) < -1 || (a.light[k] as number) > 1) {
        e.push(err(`$.light.${k}`, 'A004', `light.${k} 超出 -1..1`, '把方向归一化到 -1..1'));
      }
    }
  }
  for (const k of STRENGTH_KEYS) {
    if (!isNum(a[k])) e.push(err(`$.${k}`, 'A005', `${k} 必须为数字`, '填 0..1 的有限数字'));
    else if ((a[k] as number) < 0 || (a[k] as number) > 1) {
      e.push(err(`$.${k}`, 'A006', `${k} 超出 0..1`, '收进 0..1'));
    }
  }
  for (const k of COLOR_KEYS) {
    if (a[k] !== undefined && (typeof a[k] !== 'string' || !HEX_RE.test(a[k] as string))) {
      e.push(err(`$.${k}`, 'A007', `${k} 必须是 #RRGGBB`, '例如 "#FFE2B0"'));
    }
  }
  for (const k of Object.keys(a)) {
    if (!ALLOWED.has(k)) e.push(err(`$.${k}`, 'A008', `未知参数 ${k}`, '只使用 AppearanceSpec 里声明的字段'));
  }
  if (STRENGTH_KEYS.every((k) => isNum(a[k]) && (a[k] as number) === 0)) {
    e.push(err('$', 'A009', '四项强度全为 0，等于没开材质（静默无效）', '至少给 diffuse 一个正值，或干脆不传 appearance'));
  }
  return { ok: e.length === 0, errors: e };
};

/** 校验并补齐默认色。渲染器只接受这里返回的对象。 */
export const resolveAppearance = (a: AppearanceSpec): AppearanceSpec => {
  const v = validateAppearance(a);
  if (!v.ok) throw new Error(`AppearanceSpec 非法：\n  ${v.errors.map((x) => `${x.code} ${x.path} ${x.message}`).join('\n  ')}`);
  return {
    version: 1,
    light: { x: a.light.x, y: a.light.y },
    diffuse: a.diffuse, ambient: a.ambient, specular: a.specular, rim: a.rim,
    highlight: a.highlight ?? '#FFFFFF',
    shadow: a.shadow ?? '#161018',
    rimColor: a.rimColor ?? '#FFF3D8',
  };
};

/** 预设名 → spec 副本；未知名字返回 undefined，由调用方决定报错还是忽略。 */
export const appearancePreset = (name: string): AppearanceSpec | undefined => {
  const p = APPEARANCE_PRESETS[name];
  return p ? JSON.parse(JSON.stringify(p)) as AppearanceSpec : undefined;
};
