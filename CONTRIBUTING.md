# 贡献指南

这份仓库对"改对了"的定义比较窄：**同样的输入必须逐字节产出同样的输出**。
所以贡献流程的重点不是格式规范，而是让你能在本地证明自己没破坏这条性质。

English speakers are welcome: issues and PR descriptions can be in English.
Code comments and docs are Chinese for now (see the note at the bottom).

## 1. 环境

```bash
python -m pip install -r requirements.txt
npm ci
```

需要 Python 3.11+、Node.js 20+、FFmpeg。Windows 与 Linux 都是主支持平台，
不允许"只有 bash 才能跑通"的主流程（`repo_hygiene.py files` 会机检这条）。

## 2. 提交前必跑

一次跑全（任一失败就停下修，不要带着红灯提交）：

```bash
python tools/coartic_check.py packages/anchor-core/scripts/speech-check.ts
python tools/coartic_check.py packages/anchor-core/scripts/intent-check.ts
python tools/coartic_check.py packages/anchor-core/scripts/motion-check.ts
python tools/coartic_check.py packages/anchor-core/scripts/style-check.ts
python tools/coartic_check.py packages/anchor-core/scripts/schema-check.ts
python tools/coartic_check.py packages/anchor-core/scripts/depth-check.ts
python tools/cli_check.py
python tools/repo_hygiene.py licenses
python tools/repo_hygiene.py files
python packages/anchor-core/scripts/check_boundaries.py
python tools/identity_check.py no4          # 改过渲染器/角色数据时必跑
```

**改过渲染相关代码（`FaceTraced.tsx` / `perf.ts` / `motion.ts` / `style.ts` /
`depth.ts` / `Presenter.tsx`）时，`identity_check.py no4` 必须逐字节一致。**
它比"看着没问题"严格得多，是目前唯一能证明身份没漂移的手段。

## 3. 四条硬纪律

1. **角色数据只有一份**：`packages/anchor-core/src/chars/`。工具链写、消费方只读，
   别在别处复制一份角色 JSON 当缓存。
2. **不许静默降级**：新能力一律做成显式开关，缺省关闭、缺省路径零漂移。
   参考 `--motion`、`--coarticulate`、`--shot`、`depth` 的接法。
3. **契约改动要同轮同步**：改 `POSE_RANGES` 就同时跑
   `scripts/schema-dump.ts` 重新生成 `schema/perf-contract.json`，
   并在 `docs/TIMING.md` 补断言证据。两语言共享一份契约，不许各自维护范围表。
4. **断言分层**：轨层断恒定/连续，合成层只断有界；承担机检的量不要用随机抽样。

## 4. 提交信息

`<类型>(<范围>): <一句话说明，中文>`，正文可写动机与实测数据。
类型用 `feat` / `fix` / `docs` / `chore` / `test`。

坏例子：`update files`、`fix bug`。
好例子：`fix(cli): list 过滤 *.manifest.json——建角诊断产物落 chars/ 后被当角色读取崩溃`。

## 5. PR

- 从 `master` 切分支，PR 目标也是 `master`。
- 描述里写清楚：**改了什么、为什么、怎么验证的**（贴命令与关键输出）。
- CI 双平台必须全绿。CI 挂在本机能过，多半是"本机少跑了一步"——
  按第 2 节补齐，而不是重跑碰运气。
- 涉及视觉效果的改动，附前/后对照图或样片；视觉类改动**必须有 A/B 证据**，
  只说"看起来更好"的改动会被退回（参考 `docs/AB-2.5D.md` 的否定结论写法：
  结论为"不采用"也是有效结论）。

## 6. 不要做的事

- 不要提交 `out/` 下的产物、`node_modules/`、临时调试脚本。
- 不要把大模型生成的角色图直接当设定稿提交（`tools/codeavatar.py gate` 会拦规格，
  但版权是另一回事）。
- 不要为了让断言通过去改断言——先确认是实现错了还是断言错了，
  两者都可能，但必须说清楚是哪一个。

## 7. 关于语言

仓库文档与注释目前以中文为主。新增英文文档可以，但**不要造两套会漂移的真源**：
如果改了一份文档的事实性内容，同轮改另一语言版本，否则用一条链接指过去，
而不是复制内容。
