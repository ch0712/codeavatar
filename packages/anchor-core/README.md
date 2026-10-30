# @anchor/core — 纯代码驱动数字人的能力单元

`设定稿 → 描摹成分层矢量角色 → 16 参数驱动表演`。不含任何片子包装（舞台/字幕/音轨/构图），
只负责「角色长什么样 + 怎么动」。渲染依赖 Remotion，但没有 Remotion 的片子概念。

## 目录

| 路径 | 内容 |
|:--|:--|
| `src/types.ts` | 契约：`Pose`(16 参数) / `VISEME`(6 口型) / `MOODS`(5 情绪) / `NEUTRAL` |
| `src/FaceTraced.tsx` | 参数化 SVG 渲染器（嘴/眼/鼻/眉/下颌的变换全在这里） |
| `src/chars/*.json` | 描摹产出的角色数据（**唯一一份**，别处不许有副本） |
| `src/perf.ts` | 表演驱动：`perf.json` + 帧号 → `Pose`。眨眼表/微扫视表/情绪交叉全在这里，确定性可复现 |
| `src/index.ts` | 统一出口，消费方只 `import ... from '@anchor/core'` |
| `scripts/check-boundaries.sh` | 四条边界判据，任何时候都必须全绿 |

## 消费方

| 项目 | 用法 |
|:--|:--|
| `refs/dhk` | `AnchorFilm` / `HotFilm` / `hotv2` 片子包装各自取 `poseAt` / `FaceTraced` |
| `render/film` | `src/free/anchor/` 的 `AnchorFigure`（画中画/角标落位方式） |

接入方式（两个项目都一样）：`tsconfig.json` 的 `paths` + `remotion.config.ts` 的 webpack `alias`，
两者必须指向**同一个** `src/index.ts`。

## 🔴 三条纪律（破坏任何一条，这个包就不能被提走）

1. **core 内不许出现 `../`**：只允许 `./` 与包名。它必须自包含。
2. **运行期依赖只许 peer**：`react` / `remotion` 由消费方提供，`dependencies` 保持为空。
3. **不许 import 消费方的片子数据**（`anchor/data/*.json`、`refs/dhk/*`、`render/film/*`）。

跑 `bash scripts/check-boundaries.sh` 全绿才算合规（含第 4 条：`chars/*.json` 全仓只能有一份）。

## ⚠️ 两个已踩过的坑（改配置前先读）

1. **`__dirname` / `import.meta` 在 `remotion.config.ts` 里都不能用**。
   Remotion 把 config 打进 `node_modules/@remotion/cli/dist` 以 **CJS** 执行：
   `__dirname` 会指向那个 dist 目录（不是项目根），`import.meta` 直接为空。
   → 统一用 `process.cwd()`（= 执行 remotion 的目录），并**断言 core 路径存在**，找不到就大声报错。
2. **core 在项目根之上，解析不到 `node_modules`**。
   光有 alias 不够，`react` / `remotion` 也要能找到：webpack 侧要给
   `resolve.modules = [<本项目>/node_modules, 'node_modules']`；
   TS 侧要在 `tsconfig.paths` 里显式映射 `react` / `react/jsx-runtime` / `remotion`。
   不这么做时症状是 `Cannot find module 'react'` 或 `Module not found: Can't resolve '@anchor/core'`。

## 什么时候把它提成独立仓库

出现下列任一条件就该提走（成本约 0.5 天，用 `git subtree split -P packages/anchor-core` 保留完整历史）：

- 出现第 3 个消费方（另一个项目/另一台机器要用它）
- 决定对外开源（B 层，配 GitHub 薄壳：规格 + 契约 + 闸门判据 + demo）
- 需要独立打版本号或独立 CI

提走后消费方只改一行依赖声明（`file:` → `git+ssh://...`），`import` 语句一行不动。

## 不做的事（边界）

- 不做实时驱动（那是 Live2D + 实时管线，形态不同）
- 不做真人级（这条路的上限是插画级，见 `refs/dhk/anchor-code/SPEC.md`）
- 不做片子包装（舞台/字幕/音轨/构图留在消费方）
