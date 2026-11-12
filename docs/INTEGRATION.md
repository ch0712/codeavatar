# 第三方集成指南

> 三条入口：**库级 / 浏览器级**（零依赖 SVG 运行时，推荐）、**Agent 级**（文本 → 数值 → 帧）、
> **CLI 级**（成片工具链）。本页给出全部契约：调用、数据结构、退出码、版本兼容。

## A. 库级 / 浏览器级接入（零依赖运行时）

`packages/avatar-runtime/` 是唯一面向第三方消费的运行时包。它**不复制渲染器**，
只是把 `packages/anchor-core/src/FaceTraced.tsx` 的纯函数适配层打包成可分发的形态。

| 入口 | 文件 | 场景 |
|:--|:--|:--|
| ESM | `dist/index.mjs` | Vite / Next / 现代 Node / bundler |
| CJS | `dist/index.cjs` | Node `require` / 服务端 SSR |
| CDN | `dist/standalone.js` | 纯 HTML `<script>`，挂到 `window.CodeAvatar` |

```js
// ESM / CJS
import { renderFaceSvg, renderFaceFrames, NEUTRAL, VISEME, MOODS } from 'codeavatar-runtime';
```
```html
<!-- CDN（无需 npm、无需构建） -->
<script src="https://cdn.jsdelivr.net/gh/ch0712/codeavatar@master/packages/avatar-runtime/dist/standalone.js"></script>
```

### API

| 函数 | 签名 | 说明 |
|:--|:--|:--|
| `renderFaceSvg` | `(data: CharData, pose: Pose, opts?) => string` | 一帧 → 纯 SVG 字符串 |
| `renderFaceFrames` | `(data, poses[], opts?) => string[]` | 一段表演 → SVG 帧序列，纯函数、可缓存、可写进静态站点 |
| `uniquifySvgIds` | `(svg: string, prefix: string) => string` | 同页多实例时成对重命名 `id` / `url(#id)` |
| `NEUTRAL` / `VISEME` / `MOODS` / `POSE_RANGES` | 数值契约 | 表演 = 数值，不需要任何贴图或模型 |

选项 `SvgRenderOptions`：`transparentBg`（不铺背景，便于叠加）、
`depth`（2.5D 原型，缺省为平面路径）、`idPrefix`（**同页多个 SVG 必给**，
否则 clipPath / mask 的文档级 id 会全部解析到第一个 defs）。

### 最小示例

```js
const pose = { ...NEUTRAL, ...VISEME.A };
const svg = renderFaceSvg(charJson, pose, { transparentBg: true, idPrefix: 'a1' });
document.querySelector('#stage').innerHTML = svg;
```

`charJson` 由调用方提供。**运行包刻意不内置角色数据**：`chars/*.json` 的授权是
「保留所有权利，仅作管线示例，不得商用或再分发」，不能随 MIT 包分发。
用你自己画的设定稿跑 `python tools/codeavatar.py build <sheet> <key>` 生成的产物归你所有。
数据结构（`CharData`）见 `packages/avatar-runtime/dist/index.d.ts`。

### Agent 级：文字 → 数值 → 帧

Agent 不需要 GPU，也不需要视频管线；输出一段文本后，用现成的节奏/音素映射生成
Pose 序列，再一次性渲染成 SVG 帧：

```js
import { renderFaceFrames, NEUTRAL, VISEME } from 'codeavatar-runtime';

// Agent 给出（或由 tts 的字级时间戳给出）口型序列
const visemes = ['M','A','O','E','I','U','M'];
const poses = visemes.map(v => ({ ...NEUTRAL, ...VISEME[v] }));
const frames = renderFaceFrames(charJson, poses, { transparentBg: true, idPrefix: 'turn' });
// frames[i] 可直接 innerHTML / 写成静态 HTML / 通过 SSE 推给浏览器
```

字级时间戳（`aligned` 模式）与中文节奏估计（`estimated` 模式）的差别见 README；
运行时层不假装做音素对齐，只负责把 Pose 确定性地变成画面。

### 可复现性与验收

- `renderFaceSvg` 是纯函数：同 `data + pose + opts` → 逐字节相同字符串。
- 运行时与 Remotion 成片共用同一个 `FaceTraced`。`tools/runtime_parity_check.py`
  让两张图走同一条 `remotion still` 管线，只换 SVG 来源，逐像素比对
  （当前 `noF`：0 / 3,072,000 像素差异）。
- `packages/avatar-runtime/scripts/verify.mjs` 校验 ESM / CJS / CDN 三入口逐字节一致，
  并与上述 parity 帧对齐，同时检查产物未夹带角色资产、`d.ts` 契约未漂移。

参考实现：[`demo/runtime.html`](../demo/runtime.html)（单文件、18 帧预渲染 SVG、打开即用）。

---

## B. CLI 集成（成片工具链）

> `tools/codeavatar.py` 是 CLI 的唯一入口。以下给出退出码、结构化输出、
> 输入输出样例与版本兼容承诺。

### 退出码（稳定承诺）

| 码 | 含义 | 场景 |
|:--|:--|:--|
| 0 | 成功 | 含 `--dry-run` 通过 |
| 1 | 未分类失败 | 子命令内部异常（诊断见 stderr） |
| 2 | 输入/契约违规 | perf 契约校验失败、未知子命令、参数错误 |
| 3 | 环境缺失 | 缺 Node/FFmpeg、契约文件缺失、输入不可读 |

### stdout / stderr 分离

- `--json` 时 **stdout 只有一行 JSON**（机器可读），全部诊断信息走 stderr；
- 无 `--json` 时 stdout 是人类可读进度，脚本集成一律加 `--json`。

### 样例

```bash
# 合成 + 校验 + 不渲染（CI 预检）
python tools/codeavatar.py say no4 "ni3 hao3." \
    -o out/talk.mp4 --pinyin --dry-run --json
# → {"ok": true, "dryRun": true, "out": "…\\out\\talk.mp4", "frames": 24, "duration": 0.8}

# 渲染成片
python tools/codeavatar.py render no4 -o out/clip.mp4 --props out/perf.json --json
# → {"ok": true, "out": "…\\out\\clip.mp4", "frames": 136, "duration": 4.53}

# 契约校验（两语言同一份契约 perf-contract.json）
python tools/validate_perf.py out/perf.json       # 0=通过 2=违规（错误列表→stderr）
```

### 输入格式

perf JSON 契约见 `packages/anchor-core/schema/perf-contract.json`（范围表 +
错误码枚举）。生成端推荐 `tools/say_perf.py`（stdin JSON → stdout perf，
参数：`text / pinyin / sps / seed / motion / style`），产物已过契约。

### 路径基准

- 相对路径按**调用者当前目录**解析（`--props` / `-o` 同规则）；
- 从仓库外目录调用受支持（`tools/cli_check.py` 场景 4 常驻验证）；
- 角色数据定位不依赖 cwd（脚本内以自身位置为锚）。

### 版本兼容

- CLI 退出码与 `--json` 字段（`ok/out/frames/duration/dryRun`）自 2026-11-03 起为稳定承诺；
  新增字段不破坏兼容，删除/改名需升主版本并在 CHANGELOG 声明。
- perf 契约版本 `schemaVersion=1`；更高版本 perf 会被当前工具拒绝（前向不兼容，
  显式报错而非静默解析）。
