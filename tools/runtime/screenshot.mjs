#!/usr/bin/env node
/**
 * 用「和 Remotion 渲染 still 完全相同」的浏览器管线截 parity 页面。
 *
 * 为什么不能用 chrome --headless --screenshot：
 *   Remotion (@remotion/renderer/dist/screenshot-task.js) 走的是
 *     openBrowser(...) 启动的 Chrome + CDP Page.captureScreenshot({
 *       fromSurface:true, optimizeForSpeed:true, captureBeyondViewport:true })
 *   且启动参数里没有 --disable-gpu，反而有 --ignore-gpu-blocklist、
 *   --font-render-hinting=none 等。命令行 --screenshot + --disable-gpu 是另一条
 *   光栅路径，会让大面积半透明合成产生 ±1 通道差异，伪装成「渲染器不等价」。
 *
 * 这里复用 openBrowser + 同样的 CDP 调用，把截图管线这个变量消掉，
 * 剩下的差异才真正归因于「SVG 内容」，也就是 parity 想验证的东西。
 *
 *   node tools/runtime/screenshot.mjs [--url file:///...] [--out out/runtime/parity-ssr-grid.png]
 */
import { openBrowser } from '@remotion/renderer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const WIDTH = 1920;
const HEIGHT = 1600;
const pagePath = resolve(ROOT, arg('--url', 'out/runtime/parity-grid.html'));
const outPath = resolve(ROOT, arg('--out', 'out/runtime/parity-ssr-grid.png'));
const url = pagePath.includes('://') ? pagePath : pathToFileURL(pagePath).href;

const browser = await openBrowser('chrome', { logLevel: 'error' });
try {
  // HeadlessBrowser.newPage 是 Remotion 定制签名，context 仅作 sourceMapGetter，可为空
  const page = await browser.newPage({ logLevel: 'error', indent: false, pageIndex: 0 });
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  // Remotion 的 Page 是定制封装：goto 收对象、evaluate 收字符串
  await page.goto({ url, timeout: 30000, options: { waitUntil: 'load' } });
  await page.evaluate('document.fonts.ready.then(() => true)');

  // 与 screenshot-task.js 一致的截图调用（含 omitBackground 的默认背景覆盖）
  const client = page._client();
  const target = page.target();
  await client.send('Target.activateTarget', { targetId: target._targetId });
  await client.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  // Remotion 的 CDPSession.send 返回 { value: <CDP result> }，不是裸 CDP 结果
  const { value } = await client.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    captureBeyondViewport: true,
    optimizeForSpeed: true,
    fromSurface: true,
  });
  if (!value?.data) throw new Error('CDP 未返回截图数据（可能落到 shared-memory 路径）');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(value.data, 'base64'));
  console.log(`[screenshot] ${outPath} (${WIDTH}x${HEIGHT}, Remotion CDP 管线)`);
} finally {
  // Remotion 的 HeadlessBrowser.close 签名要求显式传 { silent }
  await browser.close({ silent: true });
}
