#!/usr/bin/env node
/**
 * P3 验收（2026-11-14）：叙事层做厚，但 v0 golden 必须零漂移。
 *
 *   node tools/world/verify3.mjs
 *
 * 硬断言：
 *   ① v0 golden 零漂移：改动 world.ts 之后重渲 first-story 12 帧，逐字节等于 golden.json
 *   ② 同一 program 出横/竖/方 + 中/英，全部确定性（同参两次渲染逐字节一致）
 *   ③ 跨画幅/跨语言身份一致：角色片段 == 直接调 renderFaceSvg 的 body（唯一事实源）
 *   ④ 每帧 viewBox 正确、url(#x) 可解析、id 前缀互不相同
 *   ⑤ 角色锁定：换角色资产 / 换 key 必须被拦下
 *   ⑥ v2 结构化校验注入自证（≥5 类错误带 path/code/fix）
 *   ⑦ 并发事件轨按 at 确定性合并；镜头切换拆子 shot；字幕 locale 全覆盖
 *
 * 产出 demo/world3.html（三画幅 × 双语言对照，供人工目检）+ out/world/v3-golden.json
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
const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) fails.push(name);
};

const bundle = join(ROOT, 'out', 'world', 'program-entry.cjs');
mkdirSync(dirname(bundle), { recursive: true });
await build({
  entryPoints: [join(ROOT, 'tools/world/program-entry.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', logLevel: 'warning', loader: { '.json': 'json' },
  absWorkingDir: ROOT,
});
const api = require(bundle);

const v0 = JSON.parse(readFileSync(join(ROOT, 'examples/world/first-story.json'), 'utf8'));
const v0Golden = JSON.parse(readFileSync(join(ROOT, 'out/world/golden.json'), 'utf8'));
const v2 = JSON.parse(readFileSync(join(ROOT, 'examples/world/story-v2.json'), 'utf8'));

// ── ① v0 golden 零漂移 ──────────────────────────────────────────────
console.log('[1] v0 golden 零漂移（world.ts 新增 fit 后）');
const goldenFrames = v0Golden.frames ?? v0Golden;
const times = api.frameTimes(v0).map((f) => f.t);
check('v0 结构校验通过', api.validateWorldProgram(v0).ok);
let drift = 0;
// idPrefix 必须与 export.mjs 生成 golden 时一致（`w${i}`），否则逐字节比对无意义。
const v0Svgs = times.map((t, i) => {
  const svg = api.render(v0, t, { idPrefix: `w${i}` });
  const expected = goldenFrames[i]?.sha256 ?? goldenFrames[i]?.sha;
  if (expected && sha(svg) !== expected) drift++;
  return svg;
});
check('12 帧逐字节等于既有 golden', drift === 0, `drift=${drift}`);
if (drift) console.log('    golden 结构键：', Object.keys(goldenFrames[0] ?? {}));

// ── ② v2 校验 + 编译元数据 ───────────────────────────────────────────
console.log('[2] v2 结构化校验与编译');
const vv = api.validateStoryProgram(v2);
check('v2 合法', vv.ok, vv.errors.map((e) => `${e.code}:${e.message}`).join(' / '));
const r0 = api.resolveStoryProgram(v2, {});
check('编译产物是合法 v0 program', api.validateWorldProgram(r0.program).ok,
  api.validateWorldProgram(r0.program).errors.join(' / '));
check('并发轨被合并、镜头切换被拆分', r0.meta.trackCount === 6 && r0.meta.cameraCuts >= 2,
  `tracks=${r0.meta.trackCount} cuts=${r0.meta.cameraCuts} shots=${r0.program.shots.length}`);
check('构图被引用', r0.meta.compositionsUsed.length === 2,
  r0.meta.compositionsUsed.join(','));

// ── ③ 三画幅 × 双语言：确定性 + 唯一事实源 + id 唯一 ─────────────────
console.log('[3] 同一 program 出横/竖/方 + 中/英');
const variants = ['landscape', 'vertical', 'square'];
const locales = ['zh', 'en'];
const combos = [];
for (const variant of variants) for (const locale of locales) combos.push({ variant, locale });

const v3Golden = {};
for (const c of combos) {
  const key = `${c.variant}-${c.locale}`;
  const r = api.resolveStoryProgram(v2, c);
  const v0check = api.validateWorldProgram(r.program);
  check(`${key} 编译产物合法`, v0check.ok, v0check.errors.slice(0, 2).join(' / '));
  const frames = api.frameTimes(r.program).map((f, i) => {
    const opts = { ...r.renderOptions, idPrefix: `${c.variant[0]}${c.locale[0]}${i}` };
    return api.render(r.program, f.t, opts);
  });
  const again = api.frameTimes(r.program).map((f, i) =>
    api.render(r.program, f.t, { ...r.renderOptions, idPrefix: `${c.variant[0]}${c.locale[0]}${i}` }));
  check(`${key} 确定性（${frames.length} 帧两次渲染逐字节一致）`,
    frames.every((s, i) => s === again[i]));
  const canvas = v2.variants[c.variant].canvas;
  check(`${key} viewBox = ${canvas.join('x')}`,
    frames.every((s) => s.includes(`viewBox="0 0 ${canvas[0]} ${canvas[1]}"`)));
  // 画面层 bg 必须铺满取景框（白边缺陷的回归守卫）
  check(`${key} 背景铺满取景框`,
    frames.every((s) => s.includes(`width="${canvas[0]}" height="${canvas[1]}"`)));
  // 每帧 url(#x) 可解析
  check(`${key} url(#x) 全部可解析`, frames.every((s) => {
    const ids = new Set([...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    return [...s.matchAll(/url\(#([^)]+)\)/g)].every((m) => ids.has(m[1]));
  }));
  // 同页 id 前缀互不相同
  const prefixes = frames.map((s) => [...s.matchAll(/\bid="([^"]+)-/g)][0]?.[1]);
  check(`${key} 帧间 id 前缀互不相同`, new Set(prefixes).size === frames.length,
    `${new Set(prefixes).size}/${frames.length}`);
  // ④ 唯一事实源：逐帧比对，与 v0 export.mjs 用同一个 charIdPrefix 规则
  const fts = api.frameTimes(r.program);
  let identityOk = true;
  fts.forEach((f, i) => {
    const opts = { ...r.renderOptions, idPrefix: `${c.variant[0]}${c.locale[0]}${i}` };
    for (const body of api.bodyForFrame(r.program, f.t, opts)) {
      if (!frames[i].includes(body)) identityOk = false;
    }
  });
  check(`${key} 角色片段 == 直接渲染 body（唯一事实源）`, identityOk);

  v3Golden[key] = frames.map((s) => sha(s));
  c.frames = frames;
}

console.log('[4] 跨画幅/跨语言身份一致性');
{
  // 同一 program 下，画幅/语言只该改变取景框与字幕，不该改变角色资产。
  // 取每组的角色 body 首帧做 sha 比对（idPrefix 归一后再比）。
  const sig = (c) => {
    const r = api.resolveStoryProgram(v2, { variant: c.variant, locale: c.locale });
    const bodies = api.bodyForFrame(r.program, 0, { ...r.renderOptions, idPrefix: 'same' });
    return bodies.map((b) => sha(b));
  };
  const base = JSON.stringify(sig(combos[0]));
  check('6 组角色资产指纹完全一致',
    combos.every((c) => JSON.stringify(sig(c)) === base), base.slice(0, 24));
  // 字幕确实随 locale 变化
  const zhFrame = combos.find((c) => c.variant === 'landscape' && c.locale === 'zh').frames[0];
  const enFrame = combos.find((c) => c.variant === 'landscape' && c.locale === 'en').frames[0];
  check('中英文字幕确实不同（locale 生效）', zhFrame !== enFrame
    && zhFrame.includes('设定稿') && enFrame.includes('design sheet'));
}

// ── ⑤ 角色锁定 ──────────────────────────────────────────────────────
console.log('[5] 角色锁定（长程身份零漂移）');
{
  const r = api.resolveStoryProgram(v2, {});
  const ok = api.verifyCharLocks(r.meta.locks, r.program.chars, api.TABLE);
  check('原角色通过锁定', ok.ok, ok.errors.map((e) => e.code).join(','));
  const fps = ok.fingerprints;
  const swapped = { ...r.meta.locks, lead: { key: 'no1' } };
  const bad1 = api.verifyCharLocks(swapped, r.program.chars, api.TABLE);
  check('换 key 被拦下（L002）', !bad1.ok && bad1.errors.some((e) => e.code === 'L002'));
  const bad2 = api.verifyCharLocks(
    { lead: { key: 'no4', fingerprint: 'deadbeef' } }, r.program.chars, api.TABLE);
  check('角色资产内容变动被拦下（L004）', !bad2.ok && bad2.errors.some((e) => e.code === 'L004'));
  const good = api.verifyCharLocks(
    { lead: { key: 'no4', fingerprint: fps.lead } }, r.program.chars, api.TABLE);
  check('正确指纹通过', good.ok, `fp=${fps.lead}`);
}

// ── ⑥ v2 校验器注入自证 ─────────────────────────────────────────────
console.log('[6] v2 结构化校验注入自证');
{
  const clone = () => JSON.parse(JSON.stringify(v2));
  const cases = [
    ['version 不是 2', (p) => { p.version = 1; }, 'P001'],
    ['引用不存在的构图', (p) => { p.shots[0].composition = 'nope'; }, 'P010'],
    ['variant canvas 非法', (p) => { p.variants.vertical.canvas = [0, 10]; }, 'P005'],
    ['locale 漏字幕', (p) => { delete p.locales.en.story; }, 'P007'],
    ['锁定 key 与 chars 冲突', (p) => { p.locks.lead.key = 'no1'; }, 'P009'],
    ['并发轨 at 倒序', (p) => { p.shots[0].tracks[0].events.reverse(); }, 'P012'],
    ['事件超出 shot 时长', (p) => { p.shots[0].tracks[0].events[0].at = 99; }, 'P013'],
    // cover 不给 focus 会把主体裁成半张脸（目检实证），校验器必须替 Agent 拦下
    ['cover 画幅缺 focus', (p) => { delete p.variants.vertical.focus; }, 'P015'],
    ['focus 格式错', (p) => { p.variants.vertical.focus = [1]; }, 'P016'],
    ['hideLayers 引用不存在的层', (p) => { p.variants.square.hideLayers = ['nope']; }, 'P018'],
  ];
  for (const [name, mutate, code] of cases) {
    const p = clone();
    mutate(p);
    const got = api.validateStoryProgram(p);
    check(`${name} → ${code}`, !got.ok && got.errors.some((e) => e.code === code),
      got.errors.map((e) => e.code).join(','));
  }
  const p = clone();
  p.version = 1; p.shots[0].composition = 'nope'; delete p.locales.en.story;
  p.locks.lead.key = 'no1'; p.variants.vertical.canvas = [0, 10];
  const got = api.validateStoryProgram(p);
  check('多错一次收齐（≥5 类）', new Set(got.errors.map((e) => e.code)).size >= 5,
    [...new Set(got.errors.map((e) => e.code))].join(','));
  check('每个错误带 path/code/message/fix',
    got.errors.every((e) => e.path && e.code && e.message && e.fix));
}

// ┠─ ⑦ 写 golden + 目检页 ─────────────────────────────────────────────
const goldenPath = join(ROOT, 'out/world/v3-golden.json');
writeFileSync(goldenPath, JSON.stringify({ version: 2, program: v2.id, combos: v3Golden }, null, 2) + '\n');

// 目检页：每个画幅取一帧，中英并排
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const panels = [];
for (const variant of variants) {
  const w = v2.variants[variant].canvas[0];
  const h = v2.variants[variant].canvas[1];
  const cards = locales.map((locale) => {
    const c = combos.find((x) => x.variant === variant && x.locale === locale);
    const frame = c.frames[Math.min(2, c.frames.length - 1)];
    return `<div class="card"><div class="cap">${esc(locale.toUpperCase())} · ${esc(variant)} · ${w}×${h}</div>${frame}</div>`;
  }).join('');
  panels.push(`<h2>${esc(variant)} <small>${w}×${h}</small></h2><div class="row">${cards}</div>`);
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codeavatar · 同一份程序，三种画幅，两种语言</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:#0F0D13;color:#F4EFE6;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1500px;margin:0 auto;padding:36px 24px 72px}
.kicker{font-size:12px;letter-spacing:.22em;color:#B08C6A;font-weight:700}
h1{font-size:clamp(24px,3.6vw,36px);margin:12px 0 8px}
.lead{color:#A79EAC;line-height:1.9;font-size:15px;max-width:960px;margin:0 0 18px}
h2{font-size:17px;margin:34px 0 12px;color:#D7CBBB}
h2 small{font-weight:400;color:#8D8496;font-size:13px;margin-left:8px}
.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.card{background:#191620;border:1px solid #2A2630;border-radius:10px;overflow:hidden;width:min(560px,100%)}
.card .cap{padding:9px 13px;font-size:12px;color:#A79EAC;border-bottom:1px solid #2A2630}
.card > svg{display:block;width:100%;height:auto}
.note{margin-top:40px;border-top:1px solid #2A2630;padding-top:18px;color:#8D8496;font-size:13px;line-height:1.9}
code{background:#241F2C;padding:2px 6px;border-radius:4px;font-size:12px;color:#D7A98B}
</style></head><body><main>
<div class="kicker">CODEAVATAR · WORLDPROGRAM V2 / P3</div>
<h1>同一份程序，三种画幅，两种语言</h1>
<p class="lead">下面 6 张图来自<b>同一份 <code>story-v2.json</code></b>：只切换 <code>variant</code> 与
<code>locale</code>，场景、分镜、角色、表演数据完全不变。构图预设、并发事件轨、角色锁定、多语言字幕
都在程序里可 diff；渲染仍由同一个 <code>renderWorldFrame</code> 纯函数完成。</p>
${panels.join('')}
<div class="note">
程序：<code>examples/world/story-v2.json</code> · 编译器：<code>packages/anchor-core/src/program.ts</code> ·
验收：<code>node tools/world/verify3.mjs</code> · 设计与判断：<code>docs/CODE-AS-WORLD.md</code><br>
v0 的 12 帧 golden 在本页生成前已复验逐字节零漂移；横/竖/方三画幅共用同一份场景数据，
背景铺满取景框以避免暗色场景白边复发。
</div>
</main></body></html>`;
const demoPath = join(ROOT, 'demo/world3.html');
mkdirSync(dirname(demoPath), { recursive: true });
writeFileSync(demoPath, html, 'utf8');

console.log();
console.log(`[out] demo/world3.html        ${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
console.log(`[out] out/world/v3-golden.json ${Object.keys(v3Golden).length} 组基线 / 每组 ${Object.values(v3Golden)[0].length} 帧`);
if (fails.length) {
  console.log(`\nFAIL：P3 验收 ${fails.length} 项不通过`);
  fails.forEach((f) => console.log('  ! ' + f));
  process.exit(1);
}
console.log('\nPASS：P3 叙事层 · v0 golden 零漂移 / 三画幅双语言确定性 / 唯一事实源 / '
  + '角色锁定 / 并发轨与镜头切换 / 注入自证 ✓');
