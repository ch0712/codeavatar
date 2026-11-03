# 时间采样、曲线插值、事件轨与 track 混合规范（阶段 1）

> 本文是**规范**：每条规则附可执行的断言证据（CI 中的数值断言）。实现与断言相离即视为规范被破坏。
> 适用范围：`packages/anchor-core` 的表演层（`perf.ts` / `intent.ts` / `motion.ts` / `speech.ts` / `style.ts`）。

## 1. 帧采样语义

- **时间基准 = 帧号**：`t = frame / fps`。一切轨（情绪、注视、头部、意图）的 span 用秒声明，求值时换算为帧；采样点只在整数帧上定义，渲染器不做子帧插值。
- **确定性**：同一 perf 在同一帧号必得同一 Pose（LCG 种子表 + 纯函数，无 Date/random）。证据：intent-check「确定性」、motion-check「motion 路径确定性」、style-check「同参数同 seed 逐字节相同」。
- **fps 一致性**：`duration ≈ frames.length / fps`（容差 1 帧）。证据：schema-check「duration 与帧数不符 → E_INCONSISTENT」。

## 2. 曲线插值

- **余弦窗时域平滑**（共发音）：5 点窗，future 权重 1.0 / past 0.8（预塑形强于滞后）。证据：coartic-check 6 项。
- **smoothstep 渗透**（意图/注视/头部的 span 边界）：`w = smoothstep(clamp01(1 − dist/R))`，R 为渗透半宽（INTENT_RAMP=0.35s、GAZE_RAMP=0.12s、HEAD_RAMP=0.2s）。渗透区向**中性基线**回退而非向 0（分母 `max(1, Σw)`）。证据：intent-check ③④⑤。
- **头部三段曲线** `headCurve(u)`：预备 `[0,0.12)` 反向至 −0.15 → 跟随 `[0.12,0.45)` smoothstep 至 1 → 保持 `[0.45,0.6)` → 余弦收势 `[0.6,1]` 回 0。端点连续。证据：motion-check ⑥。
- **眨眼包络**：事件帧保持 `rate` 帧 → 4 帧线性回落。证据：motion-check ③。
- **呼吸**：正弦，周期 `60/bpm` 秒。证据：motion-check ⑧（15bpm=60 帧相位回归 + 限幅 ±0.05）。

## 3. 事件轨约定

- span 形状 `{ t, t1, … }`，秒单位，`t1 ≥ t`（违者 schema E_INCONSISTENT）。
- 无覆盖区 = 回默认：注视回镜头 (0,0)、情绪回中性、头部回 0——**没有隐式结尾动作**（收势由数据明确给出，渲染器无隐式副作用）。
- 显式事件表（`motion.blink.events`）**替换**渲染器生成的隐式表，不叠加。证据：motion-check ②。
- 微动作层（saccade/sway/漂移）与目标轨**分属两层**：目标选哪由数据决定，"活人感"微动始终叠加；断言必须分层写（轨层断形状、合成层断有界）。证据：motion-check ④⑤。

## 4. track 混合顺序

`poseAt` 组装顺序固定，后者叠加前者：

1. 中性底 → 情绪（intent 轨优先，缺省走 mood 旧路径——零漂移开关）
2. 口型（coarticulation 开关：legacy 硬切 / 余弦曲线）
3. 语音微动（br→brow、nd/env→nod）
4. motion 轨（gaze 目标替换 gz 消费；blink 事件表替换；head/-breath 叠加）
5. 眼睑-视线联动（最后乘法，只 6~10%）

各开关（`coarticulation` / `intent` / `motion`）缺省关闭 = 输出与接入前**逐位一致**。证据：motion-check「零漂移 golden 基线」（60 采样帧 × 16 参数逐位比对）、intent-check「旧路径零漂移」。

## 5. 契约边界

- 轨数据的数值范围由 `schema/perf-contract.json`（TS 常量生成、Python 共享）机器校验，契约外值**显式报错**（退出码 2），禁止静默 clamp 通过。证据：schema-check 14 项、cli_check 8 场景。
- 风格变换（增益/耦合）只作用于数据生成层；锁定轨不被任何变换触碰。证据：style-check ④。
