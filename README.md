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
  scripts/check-boundaries.sh   包边界机检（提走/开源前必跑）
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
  codeavatar.py             统一 CLI
studio/                   Remotion 工程（口播成片输出）
docs/SPEC.md              设定稿硬规格（含负面清单）
docs/CHANGELOG-char-automation.md   自动化过程的实测记录与踩坑
```

## 用法

```bash
# 1) 设定稿过闸（不合规会明确指出差哪一条）
python3 tools/codeavatar.py gate examples/sheet.png

# 2) 一条命令出角色（gate → 描摹 → 眼层拆分）
python3 tools/codeavatar.py build examples/sheet.png no7

# 3) 六格口型表 + 机检
python3 tools/codeavatar.py grid no7

# 4) 口播成片
python3 tools/codeavatar.py render no7 -o out/clip.mp4 --props examples/perf.json

# 5) 有哪些角色
python3 tools/codeavatar.py list
```

首次使用需要 `npm install`（Remotion 4.0.537，个人/≤3 人公司免费，大公司需商业授权）。

## 两条硬纪律

1. **角色数据只有一份**，在 `packages/anchor-core/src/chars/`。工具链直接读写这里，
   消费方只读不改。`check-boundaries.sh` 会机检这件事。
2. **改动不许静默降级**。已验收角色的输出必须逐字段可复现；任何"只在某些图上生效"的
   启发式都必须做成显式开关（例：`FOLK_NOISE_FLATTEN=1`），默认路径保持零漂移。

## 来源

本仓从 autocut（`refs/dhk` 的 anchor-code 子系统）剥离而来。
剥离时的验收标准是：两个消费方（dhk 片子 / film 免费通道）改造前后渲染静帧 **逐字节相同**。
详见 `docs/CHANGELOG-char-automation.md`。

## 镜像

- Gitee（主）: https://gitee.com/xumijie/codeavatar
- GitHub（镜像，PUBLIC）: https://github.com/ch0712/codeavatar
