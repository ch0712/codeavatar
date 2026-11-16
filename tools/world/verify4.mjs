#!/usr/bin/env node
/**
 * P4 验收（2026-11-16）：场景层做厚，但既有抽象与基线一律不许动。
 *
 *   node tools/world/verify4.mjs
 *
 * 硬断言：
 *   ① v0 12 帧 golden 零漂移 + v3 六组 golden 零漂移（world.ts 扩展图元后重渲比对）
 *   ② SceneProgram 校验 + 编译降级：产物只含受限图元，委托 v0 校验器通过
 *   ③ 同一 seed 确定性；不同 seed / mood / 组件集合确实改变画面（语义参数不是摆设）
 *   ④ 任意 t 两次渲染逐字节一致；角色片段 == 直接 renderFaceSvg（唯一事实源）
 *   ⑤ defs 的 url(#x) / href 全部可解析、id 前缀不串帧、多画幅背景铺满
 *   ⑥ SceneProgram 注入自证 ≥10 类稳定错误码 + world 新图元校验自证
 *
 * 产出 demo/world4.html（写即返图目检页）+ out/world/v4-golden.json
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) fails.push(name);
};

const bundle = join(ROOT, 'out', 'world', 'scene-entry.cjs');
mkdirSync(dirname(bundle), { recursive: true });
await build({
  entryPoints: [join(ROOT, 'tools/world/scene-entry.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', logLevel: 'warning', loader: { '.json': 'json' },
  absWorkingDir: ROOT,
});
const api = require(bundle);

const v0 = readJson('examples/world/first-story.json');
const v0Golden = readJson('out/world/golden.json');
const v3Golden = readJson('out/world/v3-golden.json');
const v2 = readJson('examples/world/story-v2.json');
const rawStory = readJson('examples/world/story-with-scenes.json');

// ── 装配：story 里写 $scene 引用，独立 .scene.json 是唯一事实源 ──────────
console.log('[0] 场景库装配');
const scenePaths = {};
const story = { ...rawStory, scenes: {} };
for (const [k, ref] of Object.entries(rawStory.scenes)) {
  check(`${k} 引用存在`, typeof ref?.$scene === 'string', String(ref?.$scene ?? ''));
  const sp = readJson(ref.$scene);
  check(`${k} id 与键名一致`, sp.id === k, sp.id);
  check(`${k} canvas 与世界画布一致`,
    JSON.stringify(sp.canvas) === JSON.stringify(rawStory.canvas), JSON.stringify(sp.canvas));
  scenePaths[k] = ref.$scene;
  story.scenes[k] = sp;
}
const scenePrograms = Object.values(story.scenes);

// ── ① 既有两条 golden 链路零漂移 ─────────────────────────────────────
console.log('[1] 既有 golden 零漂移（world.ts 扩展 defs / 图元后）');
{
  const goldenFrames = v0Golden.frames ?? v0Golden;
  const times = api.frameTimes(v0).map((f) => f.t);
  let drift = 0;
  times.forEach((t, i) => {
    const svg = api.render(v0, t, { idPrefix: `w${i}` });
    const expected = goldenFrames[i]?.sha256 ?? goldenFrames[i]?.sha;
    if (expected && sha(svg) !== expected) drift++;
  });
  check('v0 12 帧逐字节等于既有 golden', drift === 0, `drift=${drift}`);

  let v3drift = 0;
  let combos = 0;
  for (const variant of ['landscape', 'vertical', 'square']) for (const locale of ['zh', 'en']) {
    const key = `${variant}-${locale}`;
    const r = api.resolveStoryProgram(v2, { variant, locale });
    const frames = api.frameTimes(r.program).map((f, i) =>
      api.render(r.program, f.t, { ...r.renderOptions, idPrefix: `${variant[0]}${locale[0]}${i}` }));
    const expected = v3Golden.combos?.[key] ?? [];
    if (!expected.length || frames.some((s, i) => sha(s) !== expected[i])) v3drift++;
    combos++;
  }
  check(`v3 ${combos} 组 × 6 帧逐字节等于既有 golden`, v3drift === 0, `drift=${v3drift}`);
}

// ── ② SceneProgram 校验 + 编译降级 ───────────────────────────────────
console.log('[2] 语义场景校验与编译降级');
const defs = {};
for (const sp of scenePrograms) {
  const v = api.validateSceneProgram(sp);
  check(`${sp.id} 语义校验通过`, v.ok, v.errors.map((e) => e.code).join(','));
  const d = api.resolveSceneProgram(sp);
  defs[sp.id] = d;
  const probe = {
    version: 1, id: `_probe_${sp.id}`, title: '', canvas: sp.canvas, fps: 30,
    chars: {}, scenes: { [sp.id]: d },
    shots: [{ id: 'p', scene: sp.id, duration: 1, beats: [{ at: 0 }] }],
  };
  check(`${sp.id} 编译产物通过 world 校验`, api.validateWorldProgram(probe).ok,
    api.validateWorldProgram(probe).errors.slice(0, 2).join(' / '));
}
{
  const allShapes = Object.values(defs).flatMap((d) => d.layers.flatMap((l) => l.shapes));
  const kinds = [...new Set(allShapes.map((s) => s.kind))].sort();
  check('新图元全部被真实场景用到',
    ['path', 'polygon', 'ellipse', 'use', 'rect', 'circle', 'line'].every((k) => kinds.includes(k)),
    kinds.join(','));
  const gradients = Object.values(defs).reduce((a, d) => a + (d.defs?.gradients?.length ?? 0), 0);
  const symbols = Object.values(defs).reduce((a, d) => a + (d.defs?.symbols?.length ?? 0), 0);
  check('defs 含渐变与可复用组件', gradients >= 9 && symbols >= 3,
    `gradients=${gradients} symbols=${symbols}`);
  const repeats = Object.values(defs).reduce((a, d) => a + d.layers.filter((l) => l.repeat).length, 0);
  check('repeat 仍参与编译', repeats >= 3, `layers with repeat=${repeats}`);
}
const world = api.resolveScenedWorld(story);
check('整份故事编译成合法 WorldProgram', api.validateWorldProgram(world).ok,
  api.validateWorldProgram(world).errors.slice(0, 2).join(' / '));
check('3 个场景全部来自语义程序', Object.keys(world.scenes).length === 3,
  Object.keys(world.scenes).join(','));

// ── ③ 语义参数真的决定画面 ───────────────────────────────────────────
console.log('[3] 确定性 & 语义参数生效');
{
  const base = scenePrograms[0];
  const a = JSON.stringify(api.resolveSceneProgram(base));
  const b = JSON.stringify(api.resolveSceneProgram(JSON.parse(JSON.stringify(base))));
  check('同 seed 两次编译逐字节一致', a === b, `sha=${sha(a).slice(0, 12)}`);

  const seed2 = JSON.parse(JSON.stringify(base));
  seed2.components.find((c) => c.kind === 'buildings').seed = 8;
  check('换 seed 确实改变楼群布局', JSON.stringify(api.resolveSceneProgram(seed2)) !== a);

  const mood2 = { ...base, id: 'mood-probe', mood: 'night' };
  const m = JSON.stringify(api.resolveSceneProgram(mood2));
  check('换 mood 确实改变配色', m !== a && m.includes('#0B1026'), 'night skyTop 出现');

  const noBuildings = { ...base, id: 'no-buildings',
    components: base.components.filter((c) => c.kind !== 'buildings') };
  const nb = api.resolveSceneProgram(noBuildings);
  check('删掉 buildings 组件确实少一层、且不残留 use 窗户',
    nb.layers.length < defs[base.id].layers.length
    && !nb.layers.some((l) => l.shapes.some((s) => s.kind === 'use' && s.symbol.includes('window'))),
    `layers ${defs[base.id].layers.length} → ${nb.layers.length}`);

  const count2 = JSON.parse(JSON.stringify(base));
  count2.components.find((c) => c.kind === 'buildings').count = 4;
  const c4 = api.resolveSceneProgram(count2);
  const countShapes = (d) => d.layers.reduce((a, l) => a + l.shapes.length, 0);
  check('count 变小确实少图元（不是摆设参数）',
    countShapes(c4) < countShapes(defs[base.id]),
    `${countShapes(defs[base.id])} → ${countShapes(c4)}`);
}

// ── ④ 帧级确定性 / 唯一事实源 / id 可解析 ────────────────────────────
console.log('[4] 帧级硬断言');
const times = api.frameTimes(world);
const frames = [];
{
  let deterministic = true, identity = true, refs = true, hrefs = true;
  const prefixes = [];
  times.forEach((f, i) => {
    const opts = { idPrefix: `p${i}` };
    const svg = api.render(world, f.t, opts);
    frames.push({ ...f, svg, opts });
    if (svg !== api.render(world, f.t, opts)) deterministic = false;
    for (const body of api.bodyForFrame(world, f.t, opts)) {
      if (!svg.includes(body)) identity = false;
    }
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    if ([...svg.matchAll(/url\(#([^)]+)\)/g)].some((m) => !ids.has(m[1]))) refs = false;
    if ([...svg.matchAll(/href="#([^"]+)"/g)].some((m) => !ids.has(m[1]))) hrefs = false;
    const first = [...svg.matchAll(/\bid="([^"]+)-/g)][0]?.[1];
    prefixes.push(first);
  });
  check(`${times.length} 帧两次渲染逐字节一致`, deterministic);
  check('角色片段 == 直接渲染 body（唯一事实源）', identity);
  check('每帧 url(#x) 全部可解析（渐变不串帧）', refs);
  check('每帧 use href 全部可解析（组件不串帧）', hrefs);
  check('帧间 id 前缀互不相同', new Set(prefixes).size === times.length,
    `${new Set(prefixes).size}/${times.length}`);
  const emptyFrames = frames.filter((f) => api.bodyForFrame(world, f.t, f.opts).length === 0);
  check('空镜帧真的不渲染角色', emptyFrames.length >= 3, `empty=${emptyFrames.length}`);
}

// ── ⑤ 多画幅：3 场景 × 横/竖/方 ─────────────────────────────────────
console.log('[5] 多画幅取景与背景铺满');
const fits = {
  landscape: { fit: { canvas: [1920, 1080], mode: 'contain' } },
  vertical: { fit: { canvas: [1080, 1920], mode: 'cover', focus: [1200, 540] } },
  square: { fit: { canvas: [1080, 1080], mode: 'cover', focus: [1100, 540] } },
};
const gallery = [];
{
  let ok = true, bg = true, det = true, refOk = true;
  let idx = 0;
  for (const [sceneId, t] of [
    ['dawn-city', 0], ['day-park', 4], ['night-city', 10],
  ]) {
    for (const [name, f] of Object.entries(fits)) {
      const opts = { ...f, idPrefix: `g${idx++}` };
      const svg = api.render(world, t, opts);
      const [w, h] = f.fit.canvas;
      if (!svg.includes(`viewBox="0 0 ${w} ${h}"`)) ok = false;
      if (!svg.includes(`width="${w}" height="${h}"`)) bg = false;
      if (svg !== api.render(world, t, opts)) det = false;
      const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      if ([...svg.matchAll(/url\(#([^)]+)\)/g)].some((m) => !ids.has(m[1]))) refOk = false;
      if (f.fit.mode === 'cover' && !f.fit.focus) ok = false;
      gallery.push({ sceneId, name, w, h, svg });
    }
  }
  check('9 组 viewBox 正确且 cover 均带 focus', ok);
  check('9 组背景铺满取景框（无白边）', bg);
  check('9 组两次渲染逐字节一致', det);
  check('9 组 url(#x) 全部可解析', refOk);
}
const withChar = [
  { sceneId: 'dawn-city', t: 2, label: '黎明 · 角色入画' },
  { sceneId: 'night-city', t: 8, label: '深夜 · 角色入画' },
].map((c, i) => ({ ...c, svg: api.render(world, c.t, { idPrefix: `c${i}` }), w: 1920, h: 1080 }));

// ── ⑥ 注入自证 ──────────────────────────────────────────────────────
console.log('[6] SceneProgram 结构化错误注入自证');
{
  const clone = () => JSON.parse(JSON.stringify(scenePrograms[0]));
  const cases = [
    ['version 错', (p) => { p.version = 2; }, 'S001'],
    ['id 非法', (p) => { p.id = '9 bad'; }, 'S002'],
    ['语义词缺失', (p) => { p.words = ''; }, 'S003'],
    ['canvas 非法', (p) => { p.canvas = [1920]; }, 'S004'],
    ['mood 非法', (p) => { p.mood = 'sunrise'; }, 'S005'],
    ['components 空', (p) => { p.components = []; }, 'S006'],
    ['palette 未知键', (p) => { p.palette = { nope: '#112233' }; }, 'S007'],
    ['palette 色值非法', (p) => { p.palette = { skyTop: 'red' }; }, 'S008'],
    ['anchors 空', (p) => { p.anchors = {}; }, 'S009'],
    ['锚点越界', (p) => { p.anchors.lead = [9999, 0]; }, 'S010'],
    ['未知组件', (p) => { p.components[0].kind = 'ocean'; }, 'S011'],
    ['组件数值写成字符串', (p) => { p.components[0].sun.x = '1400'; }, 'S012'],
    ['y 超画布', (p) => { p.components.find((c) => c.kind === 'ground').y = 9999; }, 'S013'],
    ['count 越界', (p) => { p.components.find((c) => c.kind === 'buildings').count = 500; }, 'S014'],
    ['minW > maxW', (p) => { const c = p.components.find((x) => x.kind === 'buildings'); c.minW = 300; }, 'S015'],
    ['seed 非整数', (p) => { p.components.find((c) => c.kind === 'buildings').seed = 1.5; }, 'S016'],
    ['sun 参数非法', (p) => { p.components[0].sun = { x: 1, y: 2 }; }, 'S017'],
    ['beams 越界', (p) => { p.components.find((c) => c.kind === 'light').beams = 99; }, 'S018'],
    ['图元预算爆表', (p) => { const c = p.components.find((x) => x.kind === 'buildings'); c.count = 200; c.windows = true; }, 'S019'],
  ];
  for (const [name, mutate, code] of cases) {
    const p = clone();
    mutate(p);
    const got = api.validateSceneProgram(p);
    check(`${name} → ${code}`, !got.ok && got.errors.some((e) => e.code === code),
      got.errors.map((e) => e.code).join(','));
  }
  const multi = clone();
  multi.version = 2; multi.mood = 'x'; multi.words = '';
  multi.palette = { nope: 'red' }; multi.anchors = {};
  multi.components[0].kind = 'ocean';
  const got = api.validateSceneProgram(multi);
  check('多错一次收齐（≥5 类）', new Set(got.errors.map((e) => e.code)).size >= 5,
    [...new Set(got.errors.map((e) => e.code))].join(','));
  check('每个错误带 path/code/message/fix',
    got.errors.every((e) => e.path && e.code && e.message && e.fix));
  // E3-071：校验器自己不能崩
  let noCrash = true;
  for (const bad of [null, undefined, 42, [], {}, { components: [null] }, { components: [{}] },
    { canvas: [0, 0], components: [{ kind: 'sky', sun: null }] }]) {
    try {
      const r = api.validateSceneProgram(bad);
      if (!r || !Array.isArray(r.errors)) noCrash = false;
    } catch { noCrash = false; }
  }
  check('任何坏输入都不抛异常（校验器自身不崩）', noCrash);
}

console.log('[7] world 新图元校验自证');
{
  const mk = (def) => ({
    version: 1, id: 'probe', title: '', canvas: [1920, 1080], fps: 30,
    chars: {}, scenes: { probe: def },
    shots: [{ id: 's', scene: 'probe', duration: 1, beats: [{ at: 0 }] }],
  });
  const base = () => ({
    id: 'probe', words: 'w', bg: '#000',
    anchors: { a: [1, 1] },
    layers: [{ id: 'l', role: 'far', shapes: [] }],
    defs: { gradients: [{ id: 'g', kind: 'linear', from: [0, 0], to: [0, 1],
      stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }],
      symbols: [{ id: 'sym', shapes: [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#fff' }] }] },
  });
  const cases = [
    ['未知 shape kind', (d) => { d.layers[0].shapes = [{ kind: 'iframe', x: 0 }]; }, '非法'],
    ['fill 引用不存在的 def', (d) => { d.layers[0].shapes = [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'url(#nope)' }]; }, '不存在的 def'],
    ['use 引用不存在的 symbol', (d) => { d.layers[0].shapes = [{ kind: 'use', symbol: 'nope', x: 0, y: 0 }]; }, '不存在的 def'],
    ['symbol 内嵌套 use', (d) => { d.defs.symbols[0].shapes.push({ kind: 'use', symbol: 'sym', x: 0, y: 0 }); }, '循环引用'],
    ['path.d 含标签注入字符', (d) => { d.layers[0].shapes = [{ kind: 'path', d: 'M0 0"/><script>alert(1)</script>' }]; }, '只允许路径指令'],
    ['渐变 stops 不足', (d) => { d.defs.gradients[0].stops = [{ offset: 0, color: '#000' }]; }, '至少需要 2 个色标'],
    ['gradient id 重复', (d) => { d.defs.gradients.push({ ...d.defs.gradients[0] }); }, '重复'],
    ['ellipse rx 非正', (d) => { d.layers[0].shapes = [{ kind: 'ellipse', cx: 1, cy: 1, rx: 0, ry: 2, fill: '#fff' }]; }, 'rx 必须为正数'],
    ['polygon 点数不足', (d) => { d.layers[0].shapes = [{ kind: 'polygon', points: [[0, 0], [1, 1]] }]; }, '至少 3 个点'],
  ];
  for (const [name, mutate, needle] of cases) {
    const d = base(); mutate(d);
    let got = '';
    try { got = api.validateWorldProgram(mk(d)).errors.join(' / '); } catch (e) { got = `THREW ${e.message}`; }
    check(`${name} 被拦下`, got.includes(needle), got.slice(0, 90));
  }
  const d = base();
  d.layers[0].shapes = [
    { kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'url(#g)' },
    { kind: 'use', symbol: 'sym', x: 2, y: 2 },
    { kind: 'path', d: 'M0 0 L10 0 L10 10 Z' },
  ];
  check('合法新图元组合放行', api.validateWorldProgram(mk(d)).ok,
    api.validateWorldProgram(mk(d)).errors.join(' / '));
}

// ── 写 golden + 写即返图目检页 ───────────────────────────────────────
writeFileSync(join(ROOT, 'out/world/v4-golden.json'),
  JSON.stringify({
    version: 4, program: world.id,
    scenes: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, sha(JSON.stringify(d))])),
    frames: frames.map((f) => ({ t: f.t, shotId: f.shotId, sha256: sha(f.svg) })),
    gallery: gallery.map((g) => ({ sceneId: g.sceneId, name: g.name, sha256: sha(g.svg) })),
  }, null, 2) + '\n');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const card = (title, sub, svg, w, h) =>
  `<div class="card"><div class="cap"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`
  + `<div class="frame" style="aspect-ratio:${w}/${h}">${svg}</div></div>`;
const metricsRows = scenePrograms.map((sp) => {
  const d = defs[sp.id];
  const shapes = d.layers.reduce((a, l) => a + l.shapes.length, 0);
  const v = api.validateSceneProgram(sp);
  return `<tr><td>${esc(sp.id)}</td><td>${esc(sp.mood)}</td><td>${esc(sp.words)}</td>`
    + `<td>${d.layers.length}</td><td>${shapes}</td><td>${d.defs?.gradients?.length ?? 0}</td>`
    + `<td>${d.defs?.symbols?.length ?? 0}</td><td>${v.metrics.shapeBudget}</td>`
    + `<td>${esc(scenePaths[sp.id])}</td></tr>`;
}).join('');

const galleryCards = gallery.map((g) =>
  card(`${g.sceneId} · ${g.name}`, `${g.w}×${g.h} · 空镜（只看场景）`, g.svg, g.w, g.h)).join('');
const charCards = withChar.map((c) =>
  card(c.label, '1920×1080 · 角色 + 场景合成（唯一渲染器）', c.svg, c.w, c.h)).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>场景层做厚 · SceneProgram v1 目检页</title>
<style>
:root{--bg:#f5f2ea;--ink:#201c26;--sub:#6b6375;--line:#ddd6c9;--panel:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:36px 0 12px;border-left:4px solid #b4844a;padding-left:10px}
p.lead{color:var(--sub);margin:0 0 18px;max-width:1000px}
table{border-collapse:collapse;width:100%;background:var(--panel);font-size:13px}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#efe9dc;white-space:nowrap}
/* 三列里混着 16:9 / 9:16 / 1:1，默认 stretch 会把矮卡片拉到竖版高度、
   在卡片下方留一大片空白——那是目检页的假空白，不是渲染产物缺陷。
   让每张卡按自身 aspect-ratio 收高，目检时才能看清「整张卡片」。 */
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;align-self:start}
.cap{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px}
.cap span{color:var(--sub);font-size:12px;text-align:right}
.frame{width:100%;background:#222;overflow:hidden}
.frame svg{display:block;width:100%;height:100%}
.note{background:#fff6e6;border:1px solid #e8cda0;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:14px}
code{background:#ece6da;padding:1px 5px;border-radius:3px;font-size:13px}
</style></head><body><div class="wrap">
<h1>场景层做厚 · SceneProgram v1</h1>
<p class="lead">同一份可 diff 的语义程序 → 编译降级到 <code>SceneDef</code> → 仍由唯一的
<code>renderWorldFrame(program, t)</code> 求值。三套场景只靠 mood / 组件集合 / 数字参数区分，
没有任何手写坐标堆砌。下面是<strong>写即返图</strong>的真实渲染结果，请整张卡片目检。</p>
<div class="note"><b>目检要点</b>：① 是否还停在「一张脸 + 几条线」；② 渐变天空 / 远山 / 楼群窗灯 / 树 / 光束是否都在；
③ 横竖方三画幅有无白边、裁切、半截元素；④ 角色是否被地面或光斑盖住；⑤ 相邻卡片的渐变有没有串帧。</div>
<h2>场景库数字量具（不看像素也能发现离谱程序）</h2>
<table><thead><tr><th>场景</th><th>mood</th><th>语义词 words</th><th>layers</th><th>shapes</th>
<th>gradients</th><th>symbols</th><th>估算图元预算</th><th>唯一事实源</th></tr></thead>
<tbody>${metricsRows}</tbody></table>
<h2>A · 三个场景 × 横 / 竖 / 方（空镜，专门看场景）</h2>
<div class="grid">${galleryCards}</div>
<h2>B · 角色入画（唯一事实源：角色片段 == 直接 renderFaceSvg）</h2>
<div class="grid two">${charCards}</div>
<h2>这页验证过的硬断言</h2>
<p class="lead">v0 12 帧 golden 零漂移 · v3 六组 golden 零漂移 · 帧级两次渲染逐字节一致 ·
角色片段等于唯一渲染器 · <code>url(#x)</code> 与 <code>href</code> 全部可解析 · id 前缀不串帧 ·
多画幅背景铺满 · 19 类 SceneProgram 结构化错误 + 9 类 world 新图元错误注入自证 ·
同 seed 确定性 / 换 seed·mood·组件集合确实改变画面。</p>
</div></body></html>`;
writeFileSync(join(ROOT, 'demo/world4.html'), html, 'utf8');
console.log(`\n[out] demo/world4.html        ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
console.log('[out] out/world/v4-golden.json  3 场景 + 帧与画幅基线');

if (fails.length) {
  console.error(`\nFAIL：${fails.length} 项未通过\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nPASS：P4 场景层 · 既有 golden 零漂移 / 语义编译降级 / 确定性 / 唯一事实源 / 多画幅 / 注入自证 ✓');
