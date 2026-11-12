#!/usr/bin/env node
/**
 * 构建可分发的零依赖 SVG 运行时。
 *
 *   node scripts/build.mjs
 *
 * 产物（提交入库，便于 CDN 直接引用仓库文件）：
 *   dist/index.mjs       ESM，浏览器 / Node / bundler 通用
 *   dist/index.cjs       CJS，Node
 *   dist/standalone.js   IIFE，挂到 window.CodeAvatar，可直接 <script src> 或 CDN
 *   dist/index.d.ts      手写契约镜像，由 verify.mjs 校验不漂移
 *
 * 纪律：渲染逻辑仍只有 core 的 FaceTraced 一份；这里只是打包，不写渲染器。
 * 合规：角色美术资产不在 MIT 范围内，必须被 tree-shake 掉，不得进入产物。
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '../..');
const DIST = join(PKG, 'dist');
const ENTRY = join(PKG, 'src/index.ts');

mkdirSync(DIST, { recursive: true });

const shared = {
  entryPoints: [ENTRY],
  bundle: true,
  logLevel: 'warning',
  loader: { '.json': 'json' },
  // 浏览器里没有 process；同时让 React 走生产分支，去掉 dev 警告代码
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  target: ['es2020'],
};

const jobs = [
  {
    name: 'ESM', outfile: join(DIST, 'index.mjs'),
    format: 'esm', platform: 'browser', conditions: ['browser'], minify: true,
  },
  {
    name: 'CJS', outfile: join(DIST, 'index.cjs'),
    format: 'cjs', platform: 'node', minify: false,
  },
  {
    name: 'standalone', outfile: join(DIST, 'standalone.js'),
    format: 'iife', platform: 'browser', conditions: ['browser'],
    globalName: 'CodeAvatar', minify: true,
  },
];

for (const j of jobs) {
  const { name, ...opts } = j;
  await build({ ...shared, ...opts });
  console.log(`[build] ${name.padEnd(11)} ${(statSync(opts.outfile).size / 1024).toFixed(0)} KB`);
}

cpSync(join(PKG, 'src/index.d.ts'), join(DIST, 'index.d.ts'));
const license = join(REPO, 'LICENSE');
cpSync(license, join(PKG, 'LICENSE'));
console.log('[build] index.d.ts / LICENSE 已就位');

// ── 合规闸门：角色美术资产不得进入可分发产物 ──
// chars/*.json 的授权是「保留所有权利，仅作管线示例，不得商用或再分发」。
// 运行时包若把它们打进去，就等于用 MIT 包再分发了非 MIT 资产。
const forbidden = ['"lipColor"', '"lipBox"', '"skinBox"', '#CA7162', '#F0B781', 'CHARACTER_DATA'];
for (const j of jobs) {
  const text = readFileSync(j.outfile, 'utf8');
  const hit = forbidden.filter((s) => text.includes(s));
  // 类型/字段名的字符串常量可能出现在 PropTypes 风格的报错文本里，
  // 这里只把「角色数据字面量」视为致命：出现颜色或角色键即失败。
  const leaked = hit.filter((s) => s.startsWith('#') || s === 'CHARACTER_DATA');
  if (leaked.length) {
    throw new Error(`${j.name} 泄漏角色美术资产（${leaked.join(', ')}）：请检查 tree-shaking`);
  }
  if (text.includes('remotion')) {
    throw new Error(`${j.name} 仍含 Remotion 引用：运行时必须零 Remotion 依赖`);
  }
}
console.log('[build] 合规自检通过：产物不含角色资产、不含 Remotion');

writeFileSync(join(DIST, '.build-info.json'), JSON.stringify({
  builtFrom: 'packages/anchor-core/src/FaceTraced.tsx',
  note: 'THIS IS A GENERATED BUNDLE. Edit core, then run node scripts/build.mjs',
}, null, 2) + '\n');
