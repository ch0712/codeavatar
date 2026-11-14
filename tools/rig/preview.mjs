#!/usr/bin/env node
/**
 * 写即返图（P1）：把「设定稿 + zone 框」「编译角色 + zone 框」「六格 pose sheet」
 * 合成一张单文件 HTML。改 .rig.json 重跑 compile，这张图就变——
 * 分区框错在哪一眼可见，不必等渲染器出成片才发现（no4 镜框上沿漂移 / noF 嘴部两轮返工）。
 *
 *   node tools/rig/preview.mjs --rig <rig.json> --char <char.json> --out <pose-sheet.html>
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

const rigPath = abs(arg('--rig', 'examples/rig/noF.rig.json'));
const charPath = abs(arg('--char', 'out/rig/noF/char.json'));
const outPath = abs(arg('--out', 'out/rig/noF/pose-sheet.html'));

const bundlePath = join(ROOT, 'out', 'rig', 'preview-entry.cjs');
mkdirSync(dirname(bundlePath), { recursive: true });
await build({
  entryPoints: [join(ROOT, 'tools/rig/preview-entry.ts')],
  outfile: bundlePath,
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  logLevel: 'warning', loader: { '.json': 'json' },
});
const api = require(bundlePath);

const rig = JSON.parse(readFileSync(rigPath, 'utf8'));
const char = JSON.parse(readFileSync(charPath, 'utf8'));
const zones = rig.zones;
const [CW, CH] = rig.canvas;

const grid = api.frames(char, 'p');
const zoned = api.zonedFrame(char, zones);
const overlay = api.zoneOverlay(zones, [CW, CH]);

let report = null;
const reportPath = join(dirname(charPath), 'report.json');
try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* 单独调用 preview 时无报告 */ }

const srcPath = isAbsolute(rig.source) ? rig.source : join(ROOT, rig.source);
const srcB64 = readFileSync(srcPath).toString('base64');
const srcMime = srcPath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';

const zoneRows = Object.entries(zones).map(([k, z]) => {
  const m = report?.zoneMetrics?.[k];
  return `<tr><td><span class="dot" style="background:${api.COLORS[k]}"></span>${k}</td>`
    + `<td>[${z.join(', ')}]</td><td>${m ? m.w + ' × ' + m.h : '-'}</td>`
    + `<td>${m ? m.cx + ', ' + m.cy : '-'}</td><td>${m ? m.wRatio : '-'} / ${m ? m.hRatio : '-'}</td></tr>`;
}).join('');

const extraRows = report?.zoneMetrics ? `
  <tr><td>eyeSpan</td><td colspan="4">${report.zoneMetrics.eyeSpan} px（两眼心水平距离）</td></tr>
  <tr><td>eyeToMouth</td><td colspan="4">${report.zoneMetrics.eyeToMouth} px（眼心 → 嘴心）</td></tr>
  <tr><td>mouthOverEyeSpan</td><td colspan="4">${report.zoneMetrics.mouthOverEyeSpan}（嘴宽 / 眼距，离谱即分区错位）</td></tr>` : '';

const charRows = report?.charMetrics ? `
  <div class="kv"><b>编译产物量具</b>
    <span>轮廓 ${report.charMetrics.layerCount} 层</span>
    <span>可动部件 ${report.charMetrics.movableParts} 条</span>
    <span>眼 ${report.charMetrics.eyeCount} / 眉 ${report.charMetrics.browCount}</span>
    <span>嘴模型 ${report.charMetrics.mouthModel}</span>
    <span>lipBox ${JSON.stringify(report.charMetrics.lipBox)}</span>
  </div>` : '';

const warnHtml = report?.warnings?.length
  ? `<div class="warn"><b>结构量具告警</b><ul>${report.warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>`
  : '';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codeavatar · ${esc(rig.id)} 建角目检</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0F0D13;color:#F4EFE6;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1400px;margin:0 auto;padding:36px 24px 64px}
.kicker{font-size:12px;letter-spacing:.22em;color:#B08C6A;font-weight:700}
h1{font-size:clamp(26px,4vw,38px);margin:12px 0 8px}
.lead{color:#A79EAC;line-height:1.8;font-size:15px;margin:0 0 26px;max-width:900px}
h2{font-size:17px;margin:32px 0 12px;color:#D7CBBB;letter-spacing:.02em}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:900px){.pair{grid-template-columns:1fr}}
.panel{background:#191620;border:1px solid #2A2630;border-radius:10px;overflow:hidden}
.panel .cap{padding:10px 14px;font-size:13px;color:#A79EAC;border-bottom:1px solid #2A2630}
.frame{position:relative;width:100%;aspect-ratio:${CW}/${CH};background:#F9F2E4}
.frame img,.frame > svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.frame.zoned > svg:first-child{position:relative}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #2A2630}
th{color:#8D8496;font-weight:600}
.dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:8px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}}
.cell{background:#191620;border:1px solid #2A2630;border-radius:8px;overflow:hidden;position:relative}
.cell .tag{position:absolute;top:8px;left:8px;background:#141117cc;color:#F4EFE6;font-size:12px;padding:3px 9px;border-radius:5px;z-index:2}
.cell > svg{display:block;width:100%;height:auto}
.kv{display:flex;flex-wrap:wrap;gap:10px 18px;font-size:13px;color:#A79EAC;margin-top:14px}
.kv b{color:#D7CBBB;width:100%}
.kv span{background:#191620;border:1px solid #2A2630;padding:5px 10px;border-radius:6px}
.warn{margin-top:18px;background:#2A1B1B;border:1px solid #6B3A3A;border-radius:8px;padding:12px 16px;font-size:13px;color:#E8B4A8}
.warn ul{margin:8px 0 0;padding-left:20px}
.note{margin-top:36px;border-top:1px solid #2A2630;padding-top:20px;color:#8D8496;font-size:13px;line-height:1.9}
code{background:#241F2C;padding:2px 6px;border-radius:4px;font-size:12px;color:#D7A98B}
</style></head><body><main>
<div class="kicker">CODEAVATAR · RIG / P1 写即返图</div>
<h1>${esc(rig.id)} · 建角目检</h1>
<p class="lead">左边是设定稿，右边是这份标注编译出的角色；两张图叠的是<b>同一组 zone 框</b>。
框没套住五官，就直接改 <code>${esc(rig.name || rig.id)}</code> 对应的
<code>.rig.json</code> 里的数字，重跑编译——改动在 git 里是一行 diff，不用改 Python 源码。</p>

<h2>设定稿 vs 编译结果（zone 框叠加）</h2>
<div class="pair">
  <div class="panel"><div class="cap">设定稿 · ${esc(rig.source)}</div>
    <div class="frame"><img src="data:${srcMime};base64,${srcB64}">${overlay}</div></div>
  <div class="panel"><div class="cap">编译角色 · char.json（${char.layers?.length ?? 0} 层）</div>
    <div class="frame">${zoned}</div></div>
</div>
${charRows}${warnHtml}

<h2>分区数字量具（不用看像素也能发现离谱的框）</h2>
<div class="panel"><table><thead><tr><th>分区</th><th>[x0,y0,x1,y1]</th><th>宽 × 高</th><th>中心</th><th>占画布 w/h</th></tr></thead>
<tbody>${zoneRows}${extraRows}</tbody></table></div>

<h2>六格口型（确认编译出的角色真的能驱动）</h2>
<div class="grid">${grid.map((svg, i) => `<div class="cell"><span class="tag">${api.GRID[i]}</span>${svg}</div>`).join('')}</div>

<div class="note">
<b>这一层解决什么</b>：换角色不再往 <code>tools/trace_design.py</code> 的 <code>PRESETS</code>
里加一条、也不靠环境变量口头约定开关；标注、构建开关、来源稿都在一份可 diff 的 JSON 里，
编译前有结构化校验（带路径和修法），编译后有量具和这张图。<br>
<b>刻意不承诺</b>：自动分区。<code>zone_auto</code> 对本项目两张真实设定稿都配不出 2 对眉眼
（深色五官与侧发同色相连），所以标注仍需人/Agent 在图上量；本工具把「量」变成可复核、可回放的工程动作。<br>
程序：<code>examples/rig/${esc(rig.id)}.rig.json</code> ·
命令：<code>python tools/rig/compile.py examples/rig/${esc(rig.id)}.rig.json</code> ·
设计与判断：<code>docs/CODE-AS-WORLD.md</code>
</div>
</main></body></html>`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`[rig] 写即返图 ${outPath.replace(ROOT + '\\', '').replace(ROOT + '/', '')} `
  + `${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)} MB（含设定稿内嵌 + 分区框 + 六格）`);
