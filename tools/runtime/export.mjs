#!/usr/bin/env node
/**
 * 零依赖运行时导出器（突破路线 P0 第一刀）。
 *
 *   node tools/runtime/export.mjs --char noF
 *
 * 产物：
 *   demo/runtime.html              单文件、零依赖、打开即说话的角色 demo
 *   out/runtime/parity-grid.html   与 studio/src/VisemeGrid.tsx 同布局的六格图（parity 校验用）
 *
 * 实现：esbuild 把 ssr-entry.ts 打成临时 CJS → Node 内调用 renderFaceSvg →
 *      把 SVG 帧内嵌进 HTML；浏览器端只负责换帧。这是当前实现，不是能力上限。
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'out', 'runtime');
const DEMO = join(ROOT, 'demo');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const charKey = arg('--char', 'noF');

mkdirSync(OUT, { recursive: true });
mkdirSync(DEMO, { recursive: true });

// ── 1. 打包 SSR 入口（bundle 含 React / react-dom-server，只在构建时用） ──
const bundlePath = join(OUT, 'ssr-entry.cjs');
await build({
  entryPoints: [join(ROOT, 'tools/runtime/ssr-entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  loader: { '.json': 'json' },
});
const ssr = require(bundlePath);
const gridFrames = ssr.buildGridFrames(charKey);
const demoFrames = ssr.buildDemoFrames(charKey);
console.log(`[runtime] ${charKey}: 六格 ${gridFrames.length} 帧 / demo ${demoFrames.length} 帧`);

// ── 2. 文档级 id 自检：每个 SVG 的 url(#x) 必须能解析到本 SVG 内的 id ──
const checkIds = (frames) => {
  for (const f of frames) {
    const ids = new Set([...f.svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...f.svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    const missing = refs.filter((r) => !ids.has(r));
    if (missing.length) throw new Error(`${f.id}: 悬空引用 ${missing.join(', ')}`);
    if (/url\(#[^)]*:/.test(f.svg)) throw new Error(`${f.id}: url(#) 含冒号，浏览器不可解析`);
  }
};
checkIds(gridFrames);
checkIds(demoFrames);
console.log('[runtime] clipPath/mask id 自检通过（无悬空引用、无非法字符）');

// ── 3. parity 页面：精确复刻 studio/src/VisemeGrid.tsx 的布局 ──
const CW = 640, CH = 800;
const gridHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
/* Remotion 在渲染时注入 *{box-sizing:border-box}（remotion/dist/cjs/default-css.js）。
   缺少这一条会让 .cell 的 1px 边框外扩、overflow 裁剪区多 1px，
   造成整幅图系统性 1px 错位，parity 必须复刻它。 */
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#141117}
#root{position:relative;width:1920px;height:1600px;background:#141117;overflow:hidden}
.cell{position:absolute;width:${CW}px;height:${CH}px;overflow:hidden;border-right:1px solid #2A2630;border-bottom:1px solid #2A2630}
.inner{position:absolute;left:${CW / 2 - (1360 * 0.52) / 2}px;top:-190px;width:${1360 * 0.52}px;height:${2048 * 0.52}px}
.inner svg{display:block;width:100%;height:100%}
</style></head><body><div id="root">${gridFrames
  .map((f, i) => `<div class="cell" style="left:${(i % 3) * CW}px;top:${Math.floor(i / 3) * CH}px"><div class="inner">${f.svg}</div></div>`)
  .join('')}</div></body></html>`;
writeFileSync(join(OUT, 'parity-grid.html'), gridHtml, 'utf8');

// 同管线 parity 的 props：把 6 帧 SSR SVG 交给 studio 的 RuntimeGrid composition。
// 这样参考图与校验图都由 `remotion still` 输出，页面/Chrome/截图管线完全一致。
writeFileSync(
  join(OUT, 'parity-props.json'),
  JSON.stringify({ frames: gridFrames.map((f) => f.svg) }),
  'utf8',
);

// ── 4. 单文件 demo ──
const framesJson = JSON.stringify(Object.fromEntries(demoFrames.map((f) => [f.id, f.svg])))
  .replace(/</g, '\\u003c')
  .replace(/\u2028|\u2029/g, '');
const charJson = readFileSync(join(ROOT, 'packages/anchor-core/src/chars', `${charKey}.json`), 'utf8');
const charData = JSON.parse(charJson);
const avgBytes = Math.round(demoFrames.reduce((s, f) => s + f.svg.length, 0) / demoFrames.length);
const moods = ssr.DEMO_MOODS;
const visemes = ssr.GRID_ORDER;

const demoHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codeavatar · 会说话的角色</title>
<style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1c1a;--muted:#6b6862;--line:#e4e1da;--accent:#b4553f;--accent-soft:#fbeee9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:48px 24px 64px}
header{margin-bottom:32px}
.kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
h1{font-size:32px;line-height:1.25;margin:10px 0 8px;letter-spacing:-.02em}
.lead{color:var(--muted);font-size:16px;max-width:720px;margin:0}
.grid{display:grid;grid-template-columns:420px 1fr;gap:24px;align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.stage{width:100%;aspect-ratio:1360/2048;background:#f1e9dc;border-radius:10px;overflow:hidden;position:relative}
.stage svg{display:block;width:100%;height:100%}
.stage .tag{position:absolute;left:10px;bottom:10px;background:rgba(255,255,255,.85);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--muted);z-index:2}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:700}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px}
button{font:inherit;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:8px;padding:7px 14px;cursor:pointer;transition:.15s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=text]{font:inherit;width:100%;border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:10px;background:#fff}
.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.primary:hover{color:#fff;opacity:.9}
.hint{font-size:12px;color:var(--muted);margin-top:8px}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
.fact{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.fact b{display:block;font-size:20px;color:var(--accent);letter-spacing:-.02em}
.fact span{font-size:12px;color:var(--muted)}
pre{background:#201f1d;color:#eae6dd;border-radius:10px;padding:16px;overflow:auto;font-size:12.5px;line-height:1.6;margin:10px 0 0}
.note{font-size:12.5px;color:var(--muted);border-left:3px solid var(--accent-soft);padding-left:12px;margin-top:24px}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
footer{margin-top:40px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px}
@media(max-width:860px){.grid{grid-template-columns:1fr}.facts{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header>
  <div class="kicker">CODEAVATAR · 角色演示</div>
  <h1>让你的角色开口说话</h1>
  <p class="lead">点上面的口型和情绪，看看这张脸怎么变；输入一句话，它会跟着开口说话
  （语音由浏览器本地合成，不联网）。同一份角色也能拿去出口播视频、放进网页，
  或接在 Agent 的回答里。</p>
</header>

<div class="grid">
  <div class="card">
    <div class="stage" id="stage"><div class="tag" id="tag">中性 · M</div></div>
  </div>
  <div>
    <div class="card">
      <h2>口型</h2><div class="row" id="visemes"></div>
      <h2>情绪</h2><div class="row" id="moods"></div>
      <h2>说一句话</h2>
      <input type="text" id="text" value="大家好，我是小屿，很高兴见到你。">
      <button class="primary" id="speak">播放</button>
      <div class="hint">口型按节奏轮播（演示用，非音素对齐）；语音由浏览器本地合成，不联网。</div>
    </div>
  </div>
</div>

<div class="facts">
  <div class="fact"><b>6</b><span>种口型 · 从闭唇到大开，随时切换</span></div>
  <div class="fact"><b>3</b><span>种情绪演示 · 中性、高兴、认真</span></div>
  <div class="fact"><b>1</b><span>份角色数据 · 视频、网页、Agent 都是同一张脸</span></div>
</div>

<div class="card" style="margin-top:24px">
  <h2>想放进自己的页面？</h2>
  <pre><code>import { renderFaceSvg, VISEME, NEUTRAL } from 'codeavatar-runtime';

const pose = { ...NEUTRAL, ...VISEME.A };
document.querySelector('#stage').innerHTML =
  renderFaceSvg(charJson, pose, { transparentBg: true, idPrefix: 'a1' });</code></pre>
  <div class="hint"><code>charJson</code> 是你自己的角色数据 —— 自己画一张设定稿，跑一次
  <code>build</code> 就有。包已构建并通过验收，<strong>尚未发布到 npm</strong>；
  当前可用 <code>npm pack ./packages/avatar-runtime</code>、仓库内 <code>dist/</code> 或 CDN。</div>
  <div class="hint">实现说明：这些画面由同一个渲染器预先生成，所以页面打开就能用、不联网。
  这是当前的做法，<strong>不是能力上限</strong> —— 哪种方案能让效果更好，就可以用哪种。</div>
</div>

<div class="note">
  说明：这里的「说话」是按节奏轮播，还不是逐字对齐发音。想做真正对得上口型的成片，
  仓库里的 <code>aligned</code> 模式用字级时间戳驱动口型，配合 TTS 音轨直接出片。
</div>

<div class="note">
  授权：本页内嵌的 18 帧示例角色画面属于<strong>角色美术资产</strong>，与
  <code>chars/*.json</code> 授权相同（保留所有权利，仅作管线示例，不得商用或再分发）。
  页面代码与运行时包本身是 MIT。
</div>

<footer>
  角色 <code>${charKey}</code> · 画布 ${charData.canvas[0]}×${charData.canvas[1]} ·
  ${charData.layers?.length ?? 0} 个描摹层 · 单帧 SVG 均值 ${avgBytes} 字节 ·
  由 <code>node tools/runtime/export.mjs --char ${charKey}</code> 生成
</footer>
</div>

<script id="frames" type="application/json">${framesJson}</script>
<script>
const FRAMES = JSON.parse(document.getElementById('frames').textContent);
const VISEMES = ${JSON.stringify(visemes)}, MOODS = ${JSON.stringify(moods)};
let mood = MOODS[0], viseme = 'M', timer = null;
const stage = document.getElementById('stage'), tag = document.getElementById('tag');
function show(v, m){
  const svg = FRAMES[m + '-' + v];
  if(!svg) return;
  stage.innerHTML = svg + '<div class="tag">' + m + ' · ' + v + '</div>';
  document.querySelectorAll('#visemes button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('#moods button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
}
VISEMES.forEach(v => { const b = document.createElement('button'); b.textContent = v; b.dataset.v = v;
  b.onclick = () => { viseme = v; show(v, mood); }; document.getElementById('visemes').appendChild(b); });
MOODS.forEach(m => { const b = document.createElement('button'); b.textContent = m; b.dataset.m = m;
  b.onclick = () => { mood = m; show(viseme, m); }; document.getElementById('moods').appendChild(b); });
document.getElementById('speak').onclick = () => {
  const text = document.getElementById('text').value.trim();
  if(!text) return;
  clearInterval(timer);
  const seq = ['A','O','E','I','U','M'];
  let i = 0;
  timer = setInterval(() => {
    if(i >= text.length * 2){ clearInterval(timer); show(viseme, mood); return; }
    show(seq[Math.floor(i/2) % seq.length], mood); i++;
  }, 110);
  if('speechSynthesis' in window){
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = 1;
    window.speechSynthesis.speak(u);
  }
};
show('M', mood);
</script></body></html>`;
writeFileSync(join(DEMO, 'runtime.html'), demoHtml, 'utf8');

console.log(`[runtime] demo/runtime.html       ${(Buffer.byteLength(demoHtml) / 1024).toFixed(0)} KB`);
console.log(`[runtime] out/runtime/parity-grid.html ${(Buffer.byteLength(gridHtml) / 1024).toFixed(0)} KB`);
