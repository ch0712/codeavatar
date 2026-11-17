#!/usr/bin/env node
/**
 * Q3 角色外观质感验收（2026-11-17）。
 *
 *   node tools/appearance/verify_appearance.mjs
 *
 * 硬约束：appearance 缺省时 FaceTraced 的 JSX 一行都不增 ——
 * ① v4-golden 的 12 帧世界帧逐字节复验（world 层透传不改数据）
 * ② identity / parity 由既有脚本守，这里再验「undefined 与不传完全一致」
 *
 * 新能力断言：
 * ③ 启用材质后确定性、参数确实改变画面（不做摆设）
 * ④ url(#x) / clip-path 全部可解析、材质罩裁在角色轮廓内、嘴部几何与色值不被污染
 * ⑤ 预设名与对象两种写法一致、未知预设报错、A001~A009 结构化错误注入自证
 *
 * 产出 demo/appearance.html（写即返图对照页）、out/appearance/grid-studio.html（供 gate_mouth 截图）
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

const OUT = join(ROOT, 'out', 'appearance');
mkdirSync(OUT, { recursive: true });
const bundle = join(OUT, 'appearance-entry.cjs');
await build({
  entryPoints: [join(ROOT, 'tools/appearance/appearance-entry.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', logLevel: 'warning', loader: { '.json': 'json' },
  absWorkingDir: ROOT,
});
const api = require(bundle);

const POSES = api.GRID.map((v) => api.poseFor(v));
const mkSpec = (over = {}) => ({
  version: 1, light: { x: -0.6, y: -0.5 },
  diffuse: 0.42, ambient: 0.30, specular: 0.34, rim: 0.16, ...over,
});
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── ① 默认路径零漂移 ─────────────────────────────────────────────────
console.log('[1] 默认路径零漂移（显式开关的构造性保证）');
{
  let same = true;
  for (const pose of POSES) {
    const a = api.face('no4', pose, { transparentBg: true, idPrefix: 'z' });
    const b = api.face('no4', pose, { transparentBg: true, idPrefix: 'z', appearance: undefined });
    if (a !== b) same = false;
  }
  check('六格「不传」与「appearance: undefined」逐字节一致', same);

  const rawStory = readJson('examples/world/story-with-scenes.json');
  const story = { ...rawStory, scenes: {} };
  for (const [k, ref] of Object.entries(rawStory.scenes)) story.scenes[k] = readJson(ref.$scene);
  const world = api.compileStory(story);
  const v4 = readJson('out/world/v4-golden.json');
  let drift = 0;
  (v4.frames ?? []).forEach((f, i) => {
    const svg = api.renderWorld(world, f.t, { idPrefix: `p${i}` });
    if (sha(svg) !== f.sha256) drift++;
  });
  check('v4 12 帧世界帧逐字节等于既有 golden', drift === 0, `drift=${drift}`);
  globalThis.__world = world;
  globalThis.__story = story;
}

// ── ② 启用材质后确定性 ──────────────────────────────────────────────
console.log('[2] 启用材质后确定性');
const presets = ['studio', 'sunset', 'night'];
{
  let det = true;
  for (const name of presets) for (const pose of POSES) {
    const opts = { transparentBg: true, idPrefix: 'q', appearance: name };
    if (api.face('no4', pose, opts) !== api.face('no4', pose, opts)) det = false;
  }
  check('3 预设 × 6 口型，两次渲染逐字节一致', det);
  const byName = api.face('no4', POSES[0], { transparentBg: true, idPrefix: 'q', appearance: 'studio' });
  const byObj = api.face('no4', POSES[0], { transparentBg: true, idPrefix: 'q', appearance: api.appearancePreset('studio') });
  check('预设名与 spec 对象两种写法产出一致', byName === byObj);
}

// ── ③ 语义参数真的改变画面 ──────────────────────────────────────────
console.log('[3] 参数生效（不是摆设）');
const base = api.face('no4', POSES[1], { transparentBg: true, idPrefix: 'q' });
{
  const f = (over, name) => api.face('no4', POSES[1], {
    transparentBg: true, idPrefix: 'q', appearance: mkSpec(over),
  });
  check('无材质 ≠ studio', base !== f({}, 'studio'));
  check('换光源方向确实改变画面', f({ light: { x: 0.7, y: 0.4 } }) !== f({}));
  check('diffuse 0 → 0.6 确实改变画面', f({ diffuse: 0 }) !== f({ diffuse: 0.6 }));
  check('ambient 0 → 0.6 确实改变画面', f({ ambient: 0 }) !== f({ ambient: 0.6 }));
  check('specular 0 → 0.6 确实改变画面', f({ specular: 0 }) !== f({ specular: 0.6 }));
  check('rim 0 → 0.4 确实改变画面', f({ rim: 0 }) !== f({ rim: 0.4 }));
  const set = new Set(presets.map((name) => api.face('no4', POSES[1], {
    transparentBg: true, idPrefix: 'q', appearance: name,
  })));
  check('三套预设画面互不相同', set.size === 3, `distinct=${set.size}`);
}

// ── ④ 结构完整性：defs 可解析 / 光罩被裁 / 嘴部不被污染 ────────────────
console.log('[4] 结构完整性与唯一事实源');
const lit = api.face('no4', POSES[1], { transparentBg: true, idPrefix: 'q', appearance: 'studio' });
{
  const ids = new Set([...lit.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...lit.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  const baseRefs = [...base.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  // 不写「>=5」这种拍脑袋阈值（E3-077）：精确要求四类材质 defs 一个不少，
  // 且相对基线恰好新增 4 个引用、全部能在同帧 id 集合里解析。
  const expected = ['ap-clip', 'ap-diffuse', 'ap-ambient', 'ap-spec'];
  const kinds = new Set(refs.map((r) => r.replace(/^.*-ap-/, 'ap-')).filter((r) => expected.includes(r)));
  const missing = refs.filter((r) => !ids.has(r));
  check('启用后 4 类材质 defs 全部生成且 url(#x) 可解析',
    expected.every((k) => kinds.has(k))
      && refs.length === baseRefs.length + expected.length
      && missing.length === 0,
    `refs=${refs.length} base=${baseRefs.length} kinds=${[...kinds].sort().join(',')} missing=${missing.length}`);
  check('材质罩包在 clip-path 组内（不溢出透明背景）',
    /<g clip-path="url\(#[^"]+-ap-clip\)"><rect[^>]+ap-diffuse/.test(lit));
  check('材质罩位于嘴组之前（嘴部量具不受污染）',
    lit.indexOf('ap-diffuse') < lit.indexOf('#42201C') && lit.indexOf('ap-diffuse') > 0,
    `ap=${lit.indexOf('ap-diffuse')} mouth=${lit.indexOf('#42201C')}`);
  // 嘴 / 牙 / 口腔的关键色值与路径在两种帧里必须原样保留
  const mouthTokens = ['#42201C', '#E9E1D3', '#8E4038'];
  check('嘴部关键色值原样保留', mouthTokens.every((t) => lit.includes(t) && base.includes(t)));
  const pathsOf = (s) => [...s.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const basePaths = pathsOf(base);
  check('既有 body/mouth 路径一条不改（只追加节点）',
    basePaths.every((d) => lit.includes(`d="${d}"`)), `paths=${basePaths.length}`);
  check('不传材质时不含任何 ap- 节点', !base.includes('ap-diffuse') && !base.includes('ap-clip'));
}

// ── ⑤ world 层透传 ──────────────────────────────────────────────────
console.log('[5] 世界层透传（同一份 program 换灯位）');
{
  const world = globalThis.__world;
  const t = 2; // dawn-city 角色入画帧
  const opts = { idPrefix: 'wc' };
  const plain = api.renderWorld(world, t, opts);
  const warm = api.renderWorld(world, t, { ...opts, appearance: 'sunset' });
  check('透传后画面确实改变', plain !== warm);
  check('透传后仍确定性', warm === api.renderWorld(world, t, { ...opts, appearance: 'sunset' }));
  check('透传后 url(#x) 全部可解析', (() => {
    const ids = new Set([...warm.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    return [...warm.matchAll(/url\(#([^)]+)\)/g)].every((m) => ids.has(m[1]));
  })());
  globalThis.__worldPlain = plain;
  globalThis.__worldWarm = warm;
}

// ── ⑥ 结构化错误注入自证 ────────────────────────────────────────────
console.log('[6] AppearanceSpec 结构化错误注入自证');
{
  const cases = [
    ['非对象', null, 'A001'],
    ['version 错', { ...mkSpec(), version: 2 }, 'A002'],
    ['light 非对象', { ...mkSpec(), light: 'left' }, 'A003'],
    ['light.x 越界', { ...mkSpec(), light: { x: 9, y: 0 } }, 'A004'],
    ['strength 非数字', { ...mkSpec(), diffuse: '0.4' }, 'A005'],
    ['strength 越界', { ...mkSpec(), ambient: 1.8 }, 'A006'],
    ['颜色非法', { ...mkSpec(), highlight: 'red' }, 'A007'],
    ['未知参数', { ...mkSpec(), blur: 3 }, 'A008'],
    ['四项全零等于没开', mkSpec({ diffuse: 0, ambient: 0, specular: 0, rim: 0 }), 'A009'],
  ];
  for (const [name, bad, code] of cases) {
    const r = api.validateAppearance(bad);
    check(`${name} → ${code}`, !r.ok && r.errors.some((e) => e.code === code),
      r.errors.map((e) => e.code).join(','));
  }
  const multi = { ...mkSpec({ diffuse: 3, ambient: 'x' }), version: 3, light: { x: 9, y: 0 }, blur: 1 };
  const got = api.validateAppearance(multi);
  check('多错一次收齐（≥5 类）', new Set(got.errors.map((e) => e.code)).size >= 5,
    [...new Set(got.errors.map((e) => e.code))].join(','));
  check('每个错误带 path/code/message/fix',
    got.errors.every((e) => e.path && e.code && e.message && e.fix));
  let noCrash = true;
  for (const bad of [null, undefined, 42, [], {}, { light: null }, { light: { x: {}, y: [] } }]) {
    try { const r = api.validateAppearance(bad); if (!r || !Array.isArray(r.errors)) noCrash = false; }
    catch { noCrash = false; }
  }
  check('任何坏输入都不抛异常（校验器自身不崩）', noCrash);
  let threw = false;
  try { api.face('no4', POSES[0], { appearance: 'no-such-preset' }); } catch { threw = true; }
  check('未知预设名被明确拒绝', threw);
  let badSpecThrew = false;
  try { api.resolveAppearance({ ...mkSpec(), diffuse: 9 }); } catch { badSpecThrew = true; }
  check('非法 spec 经 resolveAppearance 被拒绝', badSpecThrew);
}

// ── 写 golden + 写即返图目检页 ───────────────────────────────────────
// 五官放大：只改展示副本的 viewBox，渲染产物本身不动。
// 注意必须**重新渲染一份带独立 idPrefix 的 SVG**，不能复用 open 的字符串再改 viewBox：
// 同页两个 id 相同的 defs 会让浏览器都解析到第一个，是「目检页自己制造假象」（E3-080）。
const cropFace = (svg) => svg.replace(/viewBox="0 0 1360 2048"/, 'viewBox="280 580 800 800"');
const cards = [];
const cols = [
  { name: '平面（基线）', app: undefined, note: 'appearance 缺省 · 与既有 golden 逐字节一致' },
  { name: 'studio', app: 'studio', note: '左上柔光 · 中性色温' },
  { name: 'sunset', app: 'sunset', note: '右侧暖光 · 暖轮廓' },
  { name: 'night', app: 'night', note: '顶部冷光 · 强暗角' },
];
for (const c of cols) {
  const opts = { transparentBg: true, idPrefix: `c-${c.name.replace(/[^a-zA-Z]/g, '')}` };
  const mk = (pose, prefix) => api.face('no4', pose,
    { ...opts, idPrefix: prefix, ...(c.app ? { appearance: c.app } : {}) });
  const closed = mk(POSES[0], `${opts.idPrefix}-m`);
  const open = mk(POSES[1], `${opts.idPrefix}-a`);
  const zoom = cropFace(mk(POSES[1], `${opts.idPrefix}-zoom`));
  cards.push({ ...c, closed, open, zoom });
}
// B 区两帧同样各给一份独立 idPrefix，避免同页 defs 串帧；断言仍用同前缀的 plain/warm 比对。
const worldPlainHtml = api.renderWorld(globalThis.__world, 2, { idPrefix: 'wp' });
const worldWarmHtml = api.renderWorld(globalThis.__world, 2, { idPrefix: 'ww', appearance: 'sunset' });

const card = (title, sub, svg, ratio = '1360/2048') =>
  `<div class="card"><div class="cap"><b>${esc(title)}</b><span>${esc(sub)}</span></div>`
  + `<div class="frame" style="aspect-ratio:${ratio}">${svg}</div></div>`;

const gridA = cards.map((c) =>
  `<div class="col"><h3>${esc(c.name)}<small>${esc(c.note)}</small></h3>`
  + card(`${c.name} · M 闭口`, '全脸', c.closed)
  + card(`${c.name} · A 张口`, '全脸', c.open)
  + card(`${c.name} · 五官放大`, 'viewBox 裁剪 280 580 800 800', c.zoom, '1/1')
  + `</div>`).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>角色外观质感 · AppearanceSpec v1 目检页</title>
<style>
:root{--bg:#f5f2ea;--ink:#201c26;--sub:#6b6375;--line:#ddd6c9;--panel:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:34px 0 12px;border-left:4px solid #b4844a;padding-left:10px}
h3{font-size:15px;margin:0 0 10px}h3 small{display:block;color:var(--sub);font-weight:400;font-size:12px}
p.lead{color:var(--sub);margin:0 0 18px;max-width:1050px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:start}
.col{display:flex;flex-direction:column;gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.cap{display:flex;justify-content:space-between;gap:8px;padding:7px 9px;border-bottom:1px solid var(--line);font-size:12px}
.cap span{color:var(--sub);text-align:right}
.frame{width:100%;background:radial-gradient(circle at 50% 40%,#e9e2d4,#cfc6b6);overflow:hidden}
.frame svg{display:block;width:100%;height:100%}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.note{background:#fff6e6;border:1px solid #e8cda0;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:14px}
code{background:#ece6da;padding:1px 5px;border-radius:3px;font-size:13px}
table{border-collapse:collapse;width:100%;background:var(--panel);font-size:13px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left}
th{background:#efe9dc}
</style></head><body><div class="wrap">
<h1>角色外观质感 · AppearanceSpec v1</h1>
<p class="lead">Q3：给纯色矢量脸加参数化的方向光 / 环境暗角 / 局部高光 / 轮廓光。
全部是 SVG gradient + clipPath + path，<strong>没有滤镜</strong>；材质罩裁在角色轮廓内、
放在嘴组之前，因此嘴部色值与 <code>gate_mouth</code> 判据不受影响。
<code>appearance</code> 是显式开关，不传时输出与既有 golden 逐字节一致。</p>
<div class="note"><b>目检要点</b>：① 脸是否有明暗体积感而不是一块平色；② 光罩有没有溢出到背景
（背景应保持棋盘/灰色，不能出现色块）；③ 边缘描边有没有变成卡通线稿或压住五官；
④ 嘴、牙、眼在放大图里是否干净；⑤ 四列之间差异是否真能看出来。</div>
<h2>参数对照</h2>
<table><thead><tr><th>预设</th><th>光源 (x,y)</th><th>diffuse</th><th>ambient</th><th>specular</th><th>rim</th></tr></thead><tbody>
${presets.map((n) => { const p = api.APPEARANCE_PRESETS[n];
  return `<tr><td>${n}</td><td>(${p.light.x}, ${p.light.y})</td><td>${p.diffuse}</td><td>${p.ambient}</td><td>${p.specular}</td><td>${p.rim}</td></tr>`; }).join('')}
</tbody></table>
<h2>A · 四列对照（全脸 M / A + 五官放大）</h2>
<div class="grid">${gridA}</div>
<h2>B · 场景合成（同一份世界程序，只换灯位）</h2>
<p class="lead">诚实边界：角色在故事里 scale 0.42，全画幅 1920×1080 下脸只有几十像素，
换灯位的差异主要体现在整体色温；光照细节请看上节 A 的五官放大图。
这一区验证的是「世界层透传确实生效且仍确定性」，不是画质对比。</p>
<div class="two">
${card('dawn-city · 平面', 'appearance 缺省', worldPlainHtml, '16/9')}
${card('dawn-city · sunset', 'appearance: sunset', worldWarmHtml, '16/9')}
</div>
<h2>硬断言</h2>
<p class="lead">v4 12 帧世界 golden 零漂移 · 不传与 undefined 逐字节一致 · 3 预设 × 6 口型确定性 ·
换光源 / diffuse / ambient / specular / rim 都确实改变画面 · <code>url(#x)</code> 与 clip 全可解析 ·
材质罩在嘴组之前且既有 path 一条不改 · A001~A009 注入自证 + 坏输入不抛异常。</p>
</div></body></html>`;
{
  // 同页多 SVG 时 defs id 必须全局唯一，否则渐变/clip 会互相解析到第一份（E3-080）。
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  check('目检页同页 id 全局唯一（不制造解析串帧假象）', dup.length === 0,
    `ids=${ids.length} dup=${dup.slice(0, 4).join(',')}`);
}
writeFileSync(join(ROOT, 'demo/appearance.html'), html, 'utf8');

// 六格图（3×2，每格 640×800）供 gate_mouth.py 截图后复核嘴部量具
const gridSvgs = POSES.map((pose, i) => api.face('no4', pose, {
  transparentBg: false, idPrefix: `gs${i}`, appearance: 'studio',
}));
const gridHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}body{width:1920px;height:1600px;display:grid;
grid-template-columns:repeat(3,640px);grid-template-rows:repeat(2,800px)}
div{width:640px;height:800px;overflow:hidden}svg{display:block;width:100%;height:100%}
</style></head><body>${gridSvgs.map((s) => `<div>${s}</div>`).join('')}</body></html>`;
writeFileSync(join(OUT, 'grid-studio.html'), gridHtml, 'utf8');

// 聚焦目检页：整页缩略图会把五官压没，单独出一张 2×2 的近距离对照，
// 用来判「明暗体积感 / 轮廓描边是否压五官 / 嘴是否干净」（机检不能替目检）。
const zoomHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:1440px;background:#f5f2ea;font:14px/1.5 system-ui,sans-serif;padding:14px}
.grid{display:grid;grid-template-columns:repeat(2,700px);gap:14px}
.cell{background:#fffdf8;border:1px solid #ddd6c9;border-radius:6px;overflow:hidden}
.cell b{display:block;padding:6px 10px;font-size:14px}
.frame{width:700px;height:700px;background:radial-gradient(circle at 50% 40%,#e9e2d4,#cfc6b6);overflow:hidden}
.frame svg{display:block;width:100%;height:100%}
</style></head><body><div class="grid">${cards.map((c) =>
  `<div class="cell"><b>${esc(c.name)} · 五官放大</b><div class="frame">${c.zoom}</div></div>`).join('')}</div></body></html>`;
writeFileSync(join(OUT, 'zoom.html'), zoomHtml, 'utf8');
{
  const ids = [...zoomHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  check('聚焦目检页同页 id 全局唯一', dup.length === 0, `ids=${ids.length} dup=${dup.slice(0, 4).join(',')}`);
}

writeFileSync(join(OUT, 'golden.json'), JSON.stringify({
  version: 1,
  presets: Object.fromEntries(presets.map((n) => [n, sha(api.face('no4', POSES[1], {
    transparentBg: true, idPrefix: 'golden', appearance: n,
  }))])),
  baseline: sha(base),
}, null, 2) + '\n');

console.log(`\n[out] demo/appearance.html       ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
console.log('[out] out/appearance/grid-studio.html 六格图（供 gate_mouth 复核）');
console.log('[out] out/appearance/zoom.html        2×2 五官放大聚焦目检');
console.log('[out] out/appearance/golden.json  3 预设基线');

if (fails.length) {
  console.error(`\nFAIL：${fails.length} 项未通过\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('\nPASS：Q3 外观质感 · 零漂移 / 确定性 / 参数生效 / 唯一事实源 / 结构化错误自证 ✓');
