# codeavatar

纯代码驱动的角色：**设定稿 → 描摹分层矢量角色 → 表情/动作参数化 → 口播成片**。

不使用任何真人素材，不调用 SadTalker / HeyGem / Live2D 这类口型驱动或分层绑定引擎。
角色是**从一张扁平设定稿描摹出来的 SVG 图层**，表演是**数值参数**（16 参数 / 6 口型 / 5 情绪），
渲染是 Remotion + React，输出确定性、可复现、可逐帧定位。

## 能力边界（先看这段，避免误期待）

| 能 | 不能 |
|:--|:--|
| 插画级角色的**口型/表情/眉眼**参数化动画 | 真人级写实（那是 GPU 口型驱动模型的领域） |
| 换角色**零人工**：新设定稿进去、角色出来 | 造出设定稿里没有画的平面（如鼻翼没有独立色块 → 就没有鼻子） |
| 独立输出口播视频（画面/口型/字幕） | 全屏主体级美术（画中画/中等景别是舒适区） |

实测档次：**扁平插画级**。够当画中画解说员或竖屏口播主体，不适合当大屏全屏主角。

## 目录

```
packages/anchor-core/     TS 能力包（唯一事实源）
  src/types.ts              契约：Pose 16 参数 / 6 口型 / 5 情绪
  src/FaceTraced.tsx        参数化脸部渲染器（纯 SVG，无贴图）
  src/perf.ts               perf.json → 逐帧 Pose（确定性）
  src/chars/*.json          角色数据（描摹产物，每个角色一份）
  src/chars/index.ts         自动生成的角色注册表
  scripts/check_boundaries.py   跨平台包边界机检（提走/开源前必跑）
tools/                    Python 工具链
  sheet_gate.py             设定稿合规闸门
  zone_auto.py              五官分区自动定位（结构地标法）
  trace_design.py           分层描摹（auto 模式零人工）
  split_eye_layers.py       眼层拆分 lid / iris（瞳孔几何自动求）
  curve_fit.py              轮廓曲线化
  gate_mouth.py             六格口型机检（幅度/可分性）
  gate_structure.py         结构闸门（缺件/畸形）
  gate_layer_roles.py       层角色闸门
  gate_film_perf.py         成片级表演闸门（口腔溢出/闭唇占比）
  validate_perf.py          Perf 契约校验（读 schema/perf-contract.json）
  cli_check.py              CLI 退出码/dry-run/结构化输出场景断言
  codeavatar.py             统一 CLI
studio/                   Remotion 工程（口播成片输出）
docs/SPEC.md              设定稿硬规格（含负面清单）
docs/TIMING.md            时间采样/插值/事件轨/track 混合规范（逐条附断言证据）
docs/CHANGELOG-char-automation.md   自动化过程的实测记录与踩坑
```

## 契约与唯一事实源（阶段 1）

- **Pose 数值范围**：唯一事实源是 `packages/anchor-core/src/types.ts` 的 `POSE_RANGES`
  （机器可校验常量，渲染端 clamp 与 schema 校验都从它取值）。此前是注释约定且与
  实际渲染行为不一致（brow 注释 0..1 实际 -1..1.15），已修正为"注释 = 契约 = 渲染行为"。
- **Perf 契约**：`packages/anchor-core/schema/perf-contract.json`（由 TS 常量经
  `scripts/schema-dump.ts` 生成入库，CI 断言与 TS 逐字节同步）。TS 侧 `validatePerf()`
  与 Python 侧 `tools/validate_perf.py` 读**同一份**契约——两语言不许各自维护范围表。
- **代码生成边界**：`src/chars/index.ts` 是自动生成的角色注册表，勿手改；
  角色数据 `src/chars/*.json` 由 `build` 流水线产出，只许工具链写。
- **退出码**：CLI 稳定退出码 `0` 成功 / `2` 输入或契约违规 / `3` 环境缺失；
  `--json` 时 stdout 只有机器可读 JSON，诊断信息走 stderr。

```bash
# 契约校验（渲染前拦截契约外值，显式报错而非静默 clamp）
python tools/validate_perf.py out/perf.json

# dry-run：合成 + 契约校验 + 路径检查，不渲染（CI/第三方集成用）
python tools/codeavatar.py render no4 -o out/clip.mp4 --props out/perf.json --dry-run --json
```

## 用法

```bash
# 先安装依赖（Windows、Linux 通用）
python -m pip install -r requirements.txt
npm ci

# 1) 设定稿过闸（不合规会明确指出差哪一条）
python tools/codeavatar.py gate examples/sheet-S5.png

# 2) 一条命令出角色（gate → 描摹 → 眼层拆分）
python tools/codeavatar.py build examples/sheet-S5.png demo

# 3) 六格口型表 + 机检
python tools/codeavatar.py grid no4

# 4) 口播成片
python tools/codeavatar.py render no4 -o out/clip.mp4 --props examples/perf.json

# 4b) 文本直接成片（确定性合成）
python tools/codeavatar.py say no4 "da4 jia1 hao3! jin1 tian1 jiang3 kou3 xing2." \
    -o out/talk.mp4 --pinyin --coarticulate   # 拼音：音素视觉对应
python tools/codeavatar.py say no4 "大家好，今天讲口型。" \
    -o out/talk.mp4                            # 中文：节奏估计（诚实降级，
                                               # perf.meta.mode=estimated，口型不保证对应发音）
python tools/codeavatar.py say no4 "ni3 hao3!" \
    -o out/talk.mp4 --pinyin --motion          # +低幅动作轨：注视目标/眨眼节奏/
                                               # 头部预备-跟随-收势/呼吸（显式开启，
                                               # 缺省关闭保证已验收角色零漂移）
# 角色风格协调（幅度增益/轨开关/头-眼耦合/锁定轨）走 JSON 路线：
#   echo '{"text":"ni3 hao3!","pinyin":true,"style":{"gazeGain":1.1,
#         "headGain":1.3,"headGazeCouple":0.3}}' | python tools/say_perf.py
#   → out/perf.json 后用 render --props 消费；style 里给出 locked 轨可
#   整条替换自动生成的动作（锁定），同参数同 seed 逐字节重播。

# 5) 有哪些角色
python tools/codeavatar.py list
```

支持 Windows 和 Linux。需要 Python 3.11、Node.js 20、FFmpeg，以及项目 Python 依赖；在仓库根目录运行 `npm ci` 安装锁定的 JavaScript 依赖。Remotion 4.0.537 的商业授权要求请按其当前条款核对。

## 两条硬纪律

1. **角色数据只有一份**，在 `packages/anchor-core/src/chars/`。工具链直接读写这里，
   消费方只读不改。`python packages/anchor-core/scripts/check_boundaries.py` 会机检这件事。
2. **改动不许静默降级**。已验收角色的输出必须逐字段可复现；任何"只在某些图上生效"的
   启发式都必须做成显式开关（例：`FOLK_NOISE_FLATTEN=1`），默认路径保持零漂移。

## 来源

本仓从 autocut（`refs/dhk` 的 anchor-code 子系统）剥离而来。
剥离时的验收标准是：两个消费方（dhk 片子 / film 免费通道）改造前后渲染静帧 **逐字节相同**。
详见 `docs/CHANGELOG-char-automation.md`。

## 镜像

- GitHub（公开仓库）: https://github.com/ch0712/codeavatar
