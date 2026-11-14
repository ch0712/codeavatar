#!/usr/bin/env node
/**
 * WorldProgram v0 导出器 / 验收器（docs/CODE-AS-WORLD.md 第一刀）。
 *
 *   node tools/world/export.mjs
 *
 * 产物：
 *   demo/world.html                 单文件、零依赖、可播放的「纯代码讲故事」demo
 *   out/world/frames/NN.svg         每一拍独立可 diff、可目检的静态帧
 *   out/world/golden.json           帧 sha256 基线（重跑必须逐字节一致）
 *
 * 硬断言（任一失败即非零退出，不放宽阈值）：
 *   1. 程序结构校验通过（validateWorldProgram）
 *   2. 同一 t 渲染两次逐字节一致（纯函数 / 确定性）
 *   3. 世界帧里的角色片段 == 直接调用 renderFaceSvg 的 body（唯一事实源，零漂移）
 *   4. 每帧 url(#x) 都能解析到本帧内的 id，且同页 12 帧 id 前缀互不相同
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'out', 'world');
const PROGRAM = join(ROOT, 'examples/world/first-story.json');
const DEMO = join(ROOT, 'demo');

mkdirSync(join(OUT, 'frames'), { recursive: true });
mkdirSync(DEMO, { recursive: true });

// ── 1. 打包 SSR 入口（bundle 含 React / react-dom-server，只在构建时用） ──
const bundlePath = join(OUT, 'world-entry.cjs');
await build({
  entryPoints: [join(ROOT, 'tools/world/world-entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  loader: { '.json': 'json' },
});
const w = require(bundlePath);

const programText = readFileSync(PROGRAM, 'utf8');
const program = JSON.parse(programText);

// ── 2. 结构校验 ──
const v = w.validateWorldProgram(program);
if (!v.ok) {
  console.error('FAIL：WorldProgram 结构校验失败');
  for (const e of v.errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`[world] 结构校验通过 · ${Object.keys(program.scenes).length} 场景 / ${program.shots.length} 分镜 / ${Object.keys(program.chars).length} 角色`);

// ── 3. 逐帧渲染 + 硬断言 ──
const times = w.frameTimes(program);
const duration = w.programDuration(program);
const frames = [];
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

for (let i = 0; i < times.length; i++) {
  const { t, shotId } = times[i];
  const opts = { idPrefix: `w${i}` };
  const svg = w.render(program, t, opts);

  // 断言 2：确定性
  const again = w.render(program, t, opts);
  if (svg !== again) throw new Error(`帧 ${i} (t=${t}) 两次渲染不一致：纯函数被破坏`);

  // 断言 3：唯一事实源——世界帧里的角色片段必须逐字节等于直接 renderFaceSvg
  const { shot, shotIndex, localT } = w.shotAt(program, t);
  const state = w.stateAt(shot, localT);
  for (const [castKey, slot] of Object.entries(program.chars)) {
    const st = state[castKey];
    if (!st || st.hidden) continue;
    const prefix = w.charIdPrefix(opts, shotIndex, castKey);
    const body = w.faceBodyOf(slot.key, w.poseOf(st), prefix);
    if (!svg.includes(body)) {
      throw new Error(`帧 ${i} 角色 ${castKey} 与直接渲染结果不一致：世界层另写了渲染器？`);
    }
  }

  // 断言 4：文档级 id
  const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !ids.has(r));
  if (missing.length) throw new Error(`帧 ${i}: 悬空 id 引用 ${missing.join(', ')}`);
  if (/url\(#[^)]*:/.test(svg)) throw new Error(`帧 ${i}: url(#) 含冒号，浏览器不可解析`);
  for (const id of ids) {
    if (!id.startsWith(`w${i}-`)) throw new Error(`帧 ${i}: 角色 id 未加唯一前缀 → ${id}`);
  }

  writeFileSync(join(OUT, 'frames', String(i).padStart(2, '0') + '.svg'), svg, 'utf8');
  frames.push({ i, t, shotId, bytes: Buffer.byteLength(svg, 'utf8'), sha256: sha(svg) });
}
console.log(`[world] ${frames.length} 帧 · 总时长 ${duration.toFixed(1)}s · 均值 ${Math.round(frames.reduce((a, f) => a + f.bytes, 0) / frames.length / 1024)} KB/帧`);
console.log('[world] 确定性 / 唯一事实源 / id 唯一化：全部逐字节通过');

// ── 4. golden 基线 ──
const golden = {
  program: 'examples/world/first-story.json',
  programSha256: sha(programText),
  duration,
  frameCount: frames.length,
  frames,
};
writeFileSync(join(OUT, 'golden.json'), JSON.stringify(golden, null, 2) + '\n', 'utf8');

// ── 5. 单文件 demo ──
// 只转义 </script，避免把 12 帧 SVG 里的 "<" 全量膨胀成 \u003c。
const payload = JSON.stringify({ frames: frames.map((f, i) => ({
  t: f.t, shotId: f.shotId,
  svg: readFileSync(join(OUT, 'frames', String(i).padStart(2, '0') + '.svg'), 'utf8'),
})) }).replace(/<\/script/gi, '<\\/script');

const title = program.title.replace(/[<>&"]/g, '');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codeavatar · ${title}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0F0D13;color:#F4EFE6;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:40px 24px 64px}
.kicker{font-size:12px;letter-spacing:.22em;color:#B08C6A;font-weight:700}
h1{font-size:clamp(28px,5vw,46px);margin:14px 0 10px;line-height:1.2;letter-spacing:-.02em}
.lead{color:#A79EAC;font-size:16px;line-height:1.8;margin:0 0 28px;max-width:760px}
.stage{position:relative;width:100%;aspect-ratio:16/9;background:#141117;border:1px solid #2A2630;border-radius:12px;overflow:hidden}
.frame{position:absolute;inset:0;display:none}
.frame.on{display:block}
.frame svg{display:block;width:100%;height:100%}
.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}
button{background:#241F2C;color:#F4EFE6;border:1px solid #3A3344;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer;font-family:inherit}
button:hover{background:#302839}
button.primary{background:#D7825D;color:#1A1216;border-color:#D7825D;font-weight:700}
.meta{color:#8D8496;font-size:13px;font-variant-numeric:tabular-nums;margin-left:auto}
.track{flex:1 1 100%;height:4px;background:#2A2630;border-radius:4px;overflow:hidden;margin-top:6px}
.track i{display:block;height:100%;width:0;background:#D7825D;transition:width .08s linear}
.note{margin-top:40px;border-top:1px solid #2A2630;padding-top:22px;color:#8D8496;font-size:13px;line-height:1.9}
.note b{color:#C9BFAF;font-weight:600}
code{background:#241F2C;padding:2px 6px;border-radius:4px;font-size:12px;color:#D7A98B}
</style></head><body><main>
<div class="kicker">CODEAVATAR · WORLD PROGRAM V0</div>
<h1>${title}</h1>
<p class="lead">这一整段画面没有视频文件：角色、场景、镜头和字幕都写在一份 JSON 里，
浏览器只是按时间换帧。改一个数字，故事就变一帧。</p>
<div class="stage" id="stage"></div>
<div class="bar">
  <button class="primary" id="play">播放</button>
  <button id="prev">上一帧</button>
  <button id="next">下一帧</button>
  <span class="meta" id="meta"></span>
  <div class="track"><i id="bar"></i></div>
</div>
<div class="note">
<b>这一刀验证了什么</b>：角色、场景、叙事是同一份可 diff 程序的三层，共用
<code>renderWorldFrame(program, t)</code> 这一个纯函数。角色部分严格复用原有渲染器，
12 帧逐字节对账通过；场景用受限图元与 <code>repeat</code> 表达循环；
叙事用分镜 + 镜头 + 稀疏状态更新表达。<br>
<b>刻意没做什么</b>：没有插值、没有音频、没有 MP4、没有生成模型。
先把「抽象统一 + 确定性 + 可验证」做实，再谈好不好看。<br>
程序源码：<code>examples/world/first-story.json</code> ·
设计与判断：<code>docs/CODE-AS-WORLD.md</code>
</div>
</main>
<script id="data" type="application/json">${payload}</script>
<script>
(function(){
  var D=JSON.parse(document.getElementById('data').textContent);
  var F=D.frames, stage=document.getElementById('stage'), meta=document.getElementById('meta');
  var bar=document.getElementById('bar'), btn=document.getElementById('play');
  var TOTAL=${duration}, i=0, timer=null, playing=false;
  F.forEach(function(f){var d=document.createElement('div');d.className='frame';d.innerHTML=f.svg;stage.appendChild(d);});
  var els=stage.children;
  function show(k){
    i=(k+F.length)%F.length;
    for(var j=0;j<els.length;j++) els[j].className=(j===i?'frame on':'frame');
    meta.textContent='第 '+(i+1)+' / '+F.length+' 帧  ·  '+F[i].shotId+'  ·  '+F[i].t.toFixed(1)+'s';
    bar.style.width=(F[i].t/TOTAL*100)+'%';
  }
  function delay(k){ var n=F[k+1]?F[k+1].t:TOTAL; return Math.max(120,(n-F[k].t)*1000); }
  function tick(){
    if(!playing) return;
    show(i);
    var d=delay(i);
    timer=setTimeout(function(){ i=(i+1)%F.length; tick(); },d);
  }
  function stop(){ playing=false; clearTimeout(timer); btn.textContent='播放'; }
  btn.onclick=function(){ if(playing){stop();return;} playing=true;btn.textContent='暂停';tick(); };
  document.getElementById('prev').onclick=function(){stop();show(i-1);};
  document.getElementById('next').onclick=function(){stop();show(i+1);};
  show(0);
})();
</script></body></html>`;
writeFileSync(join(DEMO, 'world.html'), html, 'utf8');

console.log(`[world] demo/world.html        ${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
console.log(`[world] out/world/golden.json  ${frames.length} 帧 sha256 基线`);
console.log('\nPASS：WorldProgram v0 —— 三层共用同一纯函数，确定性 / 唯一事实源 / 零漂移 ✓');
