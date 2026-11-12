#!/usr/bin/env node
/**
 * 发布前验收：把「可分发的 bundle」接进既有的 parity 证据链。
 *
 * 证据链：
 *   React DOM 渲染 FaceTraced  ==（runtime_parity_check.py 逐像素）==  SSR SVG 字符串
 *   SSR SVG 字符串（tools/runtime）  ==（本脚本逐字节）==  发布产物渲染的 SVG
 *   ⇒ 发布产物与 Remotion 成片渲染视觉等价，且三种入口互相一致。
 *
 * 另外校验：
 *   - ESM / CJS / standalone 三个入口输出逐字节一致
 *   - standalone 能在无 React / 无 Remotion 的裸上下文里工作（CDN 场景）
 *   - 手写 d.ts 的 Pose 字段与 core 的 POSE_RANGES 契约逐项一致
 *   - 产物不含角色美术资产
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '../..');
const DIST = join(PKG, 'dist');
const require = createRequire(import.meta.url);

const fail = (msg) => { throw new Error(msg); };
const ORDER = ['M', 'A', 'O', 'E', 'I', 'U'];

const charData = JSON.parse(
  readFileSync(join(REPO, 'packages/anchor-core/src/chars/noF.json'), 'utf8'),
);

const cjs = require(join(DIST, 'index.cjs'));
const esm = await import(pathToFileURL(join(DIST, 'index.mjs')).href);
const standaloneCode = readFileSync(join(DIST, 'standalone.js'), 'utf8');

// standalone 的裸上下文：故意不提供 React / Remotion / require，模拟 CDN <script> 场景
// React 的 browser scheduler 在模块加载时会 new MessageChannel()。
// 同步的 renderToStaticMarkup 用不到调度，但真实 MessageChannel 的 port
// 会让 Node 事件循环一直不退出，因此给 vm 一个不持有句柄的 stub。
class StubMessageChannel {
  constructor() {
    const port = () => ({
      onmessage: null, postMessage() {}, close() {},
      addEventListener() {}, removeEventListener() {}, start() {},
    });
    this.port1 = port();
    this.port2 = port();
  }
}
const sandbox = vm.createContext({
  console, TextEncoder, TextDecoder, queueMicrotask, performance,
  setTimeout, clearTimeout, URL, MessageChannel: StubMessageChannel,
});
vm.runInContext(standaloneCode, sandbox, { filename: 'standalone.js' });
const standalone = sandbox.CodeAvatar;
if (!standalone?.renderFaceSvg) fail('standalone 未挂载 window.CodeAvatar.renderFaceSvg');
console.log('[verify] standalone 在裸上下文中可用（无 React / 无 Remotion / 无 require）');

const apis = { CJS: cjs, ESM: esm, standalone };
const framesOf = (api) => ORDER.map((v, i) => api.renderFaceSvg(
  charData,
  { ...api.NEUTRAL, ...api.MOODS['中性'], ...api.VISEME[v] },
  { transparentBg: true, idPrefix: `g${i}` },
));

const base = framesOf(cjs);
for (const [name, api] of Object.entries(apis)) {
  const frames = framesOf(api);
  if (frames.length !== 6) fail(`${name}: 帧数 ${frames.length} != 6`);
  for (let i = 0; i < 6; i++) {
    if (!frames[i].startsWith('<svg')) fail(`${name} 帧 ${i} 不是 SVG`);
    if (!frames[i].includes('</svg>')) fail(`${name} 帧 ${i} 缺少闭合标签`);
    if (frames[i] !== base[i]) {
      const k = [...frames[i]].findIndex((c, n) => c !== base[i][n]);
      fail(`${name} 帧 ${i} 与 CJS 产物不一致（首个差异 @${k}）`);
    }
  }
  console.log(`[verify] ${name.padEnd(11)} 6 帧 SVG 与基准逐字节一致`);
}

// 接进 parity 证据链：与已通过 Remotion 逐像素校验的 SSR 帧比对
const propsPath = join(REPO, 'out/runtime/parity-props.json');
if (!existsSync(propsPath)) {
  console.log('[verify] 跳过 parity 链接：缺少 out/runtime/parity-props.json（先跑 export.mjs）');
} else {
  const props = JSON.parse(readFileSync(propsPath, 'utf8'));
  if (!Array.isArray(props.frames) || props.frames.length !== 6) fail('parity-props.json 帧数异常');
  for (let i = 0; i < 6; i++) {
    if (props.frames[i] !== base[i]) {
      const k = [...props.frames[i]].findIndex((c, n) => c !== base[i][n]);
      fail(`发布产物帧 ${i} 与 parity SSR 帧不一致（首个差异 @${k}）`);
    }
  }
  console.log('[verify] 发布产物 == parity SSR 帧 ==（已验证）React DOM 渲染');
}

// 契约漂移检查：d.ts 的 Pose 字段必须覆盖 core 的 POSE_RANGES 全部键
const coreTypes = readFileSync(join(REPO, 'packages/anchor-core/src/types.ts'), 'utf8');
const decl = readFileSync(join(DIST, 'index.d.ts'), 'utf8');
const rangeBlock = coreTypes.match(/POSE_RANGES[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
const keys = [...rangeBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const poseBlock = decl.match(/export interface Pose \{([\s\S]*?)\n\}/)?.[1] ?? '';
const declared = [...poseBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const missing = keys.filter((k) => !declared.includes(k));
const extra = declared.filter((k) => !keys.includes(k));
if (keys.length === 0 || missing.length || extra.length) {
  fail(`d.ts 与 POSE_RANGES 漂移：缺 [${missing}] / 多 [${extra}]（core 共 ${keys.length} 项）`);
}
console.log(`[verify] d.ts Pose 契约与 core POSE_RANGES 一致（${keys.length} 项）`);

// 合规：产物不含角色资产
for (const f of ['index.mjs', 'index.cjs', 'standalone.js']) {
  const t = readFileSync(join(DIST, f), 'utf8');
  for (const s of ['#CA7162', '#F0B781', 'CHARACTER_DATA']) {
    if (t.includes(s)) fail(`${f} 泄漏角色资产特征 ${s}`);
  }
}
console.log('[verify] 合规检查通过：产物不含角色美术资产');
console.log('\nPASS：codeavatar-runtime 可发布（零依赖 / 零漂移 / 无资产泄漏）');
process.exit(0);
