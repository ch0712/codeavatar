#!/usr/bin/env node
/**
 * P2 diff 的视觉后果页：两版 rig 的 zone 框叠在同一张设定稿上（A 实线 / B 虚线），
 * 下方并排两版编译角色的六格，让「改了四个数字画面会变成什么样」一眼可见。
 *
 *   node tools/rig/diff.mjs --a <a.rig.json> --b <b.rig.json> \
 *        --charA <charA.json> --charB <charB.json> --out <diff.html>
 *
 * 纪律：角色画面严格复用 preview-entry.ts 的 frames()（内部就是 renderFaceSvg），
 * 这里只画 zone 框和排版，绝不另写渲染器。
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const pathA = arg('--a'), pathB = arg('--b');
const rigA = JSON.parse(readFileSync(abs(pathA), 'utf8'));
const rigB = JSON.parse(readFileSync(abs(pathB), 'utf8'));
const charA = JSON.parse(readFileSync(abs(arg('--charA')), 'utf8'));
const charB = JSON.parse(readFileSync(abs(arg('--charB')), 'utf8'));
const outPath = abs(arg('--out', 'out/rig/_diff/diff.html'));
const identical = arg('--identical', 'false') === 'true';
// 两份 rig 的 id 常常相同（同一角色的前后版本），只显示 id 会变成 "noF → noF"，
// 所以标题/图例一律带上文件名，让「哪一版是哪一版」无歧义。
const stem = (p) => String(p).replace(/\\/g, '/').split('/').pop().replace(/\.rig\.json$/i, '');
const labelA = stem(pathA), labelB = stem(pathB);

const bundlePath = join(ROOT, 'out', 'rig', 'preview-entry.cjs');
mkdirSync(dirname(bundlePath), { recursive: true });
await build({
  entryPoints: [join(ROOT, 'tools/rig/preview-entry.ts')],
  outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', logLevel: 'warning', loader: { '.json': 'json' },
});
const api = require(bundlePath);

const [W, H] = rigA.canvas;
const srcPath = abs(rigA.source);
const srcB64 = readFileSync(srcPath).toString('base64');
const srcMime = srcPath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A 实线蓝 / B 虚线橙；同一张设定稿上直接看框挪了多少
const boxes = (zones, color, dash, tag) => Object.entries(zones).map(([k, z]) => {
  const [x0, y0, x1, y1] = z;
  return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" `
    + `fill="none" stroke="${color}" stroke-width="6" ${dash ? 'stroke-dasharray="20 14"' : ''}/>`
    + `<text x="${x0 + 6}" y="${y0 - 8}" font-size="24" font-weight="700" fill="${color}" `
    + `font-family="system-ui,sans-serif">${tag}:${esc(k)}</text>`;
}).join('');

const overlay = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" `
  + `preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">`
  + boxes(rigA.zones, '#2F7FE0', false, 'A') + boxes(rigB.zones, '#E08A2F', true, 'B') + `</svg>`;

// 「改了标注但角色没变」是必须显式说出的结论：否则 Agent 会以为自己修好了。
const verdict = identical
  ? `<div class="verdict same"><b>两版编译产物逐字节相同</b>：zone 数值改了，但没有改变任何几何判定——
     这次改动对画面<b>没有影响</b>。若原意是修五官错位，说明改得太小，需要继续调。</div>`
  : `<div class="verdict diff"><b>两版编译产物不同</b>：改动确实传导到了角色几何，下方六格可直接比对后果。</div>`;

const rows = Object.keys(rigA.zones).map((k) => {
  const za = rigA.zones[k], zb = rigB.zones[k];
  const d = za.map((v, i) => Math.round((zb[i] - v) * 100) / 100);
  const changed = za.some((v, i) => v !== zb[i]);
  return `<tr${changed ? ' class="chg"' : ''}><td>${esc(k)}</td>`
    + `<td>[${za.join(', ')}]</td><td>[${zb.join(', ')}]</td>`
    + `<td>[${d.join(', ')}]</td><td>${changed ? '改动' : '—'}</td></tr>`;
}).join('');

const gridA = api.frames(charA, 'a');
const gridB = api.frames(charB, 'b');
const cell = (svg, i, tag) => `<div class="cell"><span class="tag ${tag}">`
  + `${tag.toUpperCase()} · ${api.GRID[i]}</span>${svg}</div>`;
const gridHtml = api.GRID.map((_, i) => cell(gridA[i], i, 'a') + cell(gridB[i], i, 'b')).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codeavatar · rig diff (${esc(labelA)} → ${esc(labelB)})</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0F0D13;color:#F4EFE6;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1400px;margin:0 auto;padding:36px 24px 64px}
.kicker{font-size:12px;letter-spacing:.22em;color:#B08C6A;font-weight:700}
h1{font-size:clamp(24px,3.6vw,34px);margin:12px 0 8px}
.lead{color:#A79EAC;line-height:1.8;font-size:15px;margin:0 0 24px;max-width:940px}
h2{font-size:17px;margin:30px 0 12px;color:#D7CBBB}
.wrap{display:grid;grid-template-columns:minmax(0,580px) 1fr;gap:18px;align-items:start}
@media(max-width:1000px){.wrap{grid-template-columns:1fr}}
.panel{background:#191620;border:1px solid #2A2630;border-radius:10px;overflow:hidden}
.cap{padding:10px 14px;font-size:13px;color:#A79EAC;border-bottom:1px solid #2A2630}
.frame{position:relative;width:100%;aspect-ratio:${W}/${H};background:#F9F2E4}
.frame img{position:absolute;inset:0;width:100%;height:100%;display:block}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:#A79EAC;margin:10px 0 0}
.legend i{display:inline-block;width:26px;height:0;border-top:4px solid #2F7FE0;vertical-align:middle;margin-right:7px}
.legend i.b{border-top:4px dashed #E08A2F}
.verdict{margin:0 0 20px;padding:12px 16px;border-radius:8px;font-size:14px;line-height:1.8}
.verdict.same{background:#2A2418;border:1px solid #6B5A2E;color:#E8D3A0}
.verdict.diff{background:#18271F;border:1px solid #33624A;color:#B4DFC6}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #2A2630;white-space:nowrap}
th{color:#8D8496;font-weight:600}
tr.chg td{background:#231C2C;color:#F0D9B8}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
@media(max-width:900px){.grid{grid-template-columns:repeat(4,1fr)}}
.cell{background:#191620;border:1px solid #2A2630;border-radius:8px;overflow:hidden;position:relative}
.cell .tag{position:absolute;top:7px;left:7px;font-size:11px;padding:3px 7px;border-radius:5px;z-index:2;color:#fff}
.cell .tag.a{background:#2F7FE0cc}.cell .tag.b{background:#E08A2Fcc}
.cell > svg{display:block;width:100%;height:auto}
.note{margin-top:32px;border-top:1px solid #2A2630;padding-top:18px;color:#8D8496;font-size:13px;line-height:1.9}
code{background:#241F2C;padding:2px 6px;border-radius:4px;font-size:12px;color:#D7A98B}
</style></head><body><main>
<div class="kicker">CODEAVATAR · RIG / P2 视觉后果 diff</div>
<h1>${esc(labelA)} → ${esc(labelB)}</h1>
<p class="lead">同一份设定稿上叠两版 zone 框：<b style="color:#2F7FE0">A 实线蓝</b>是改前，
<b style="color:#E08A2F">B 虚线橙</b>是改后。下方六格是各自编译出的角色——
改动不只是四个数字，而是可以直接看到的画面后果。</p>
${verdict}

<h2>分区改动（设定稿 + 两版框）</h2>
<div class="wrap">
  <div class="panel"><div class="cap">${esc(rigA.source)}</div>
    <div class="frame"><img src="data:${srcMime};base64,${srcB64}">${overlay}</div></div>
  <div class="panel"><div class="cap">逐字段 diff（设定稿像素）</div>
    <table><thead><tr><th>分区</th><th>A</th><th>B</th><th>Δ</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  </div>
</div>
<div class="legend"><span><i></i>A · ${esc(labelA)}（id: ${esc(rigA.id)}）</span>
<span><i class="b"></i>B · ${esc(labelB)}（id: ${esc(rigB.id)}）</span></div>

<h2>视觉后果：两版六格并排（每列同一口型）</h2>
<div class="grid">${gridHtml}</div>

<div class="note">
数值 diff 由 <code>agent.py diff</code> 以 JSON 返回（含两版 <code>charSha256</code> 是否相同）；
本页只负责让人一眼确认改动没有引入穿帮。<br>
命令：<code>python tools/rig/agent.py diff ${esc(labelA)}.rig.json ${esc(labelB)}.rig.json</code>
</div>
</main></body></html>`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`[rig] 视觉后果页 ${outPath.replace(ROOT, '').replace(/^[\\/]/, '')} `
  + `${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
