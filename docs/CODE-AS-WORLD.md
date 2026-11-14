# 代码作为视觉世界：从数字人到场景，再到纯代码讲故事

> **命题来源（用户 2026-11-13 纠偏原话）**：
> 「我们的初始目标是代码驱动的数字人，不是 minimax H3、seedance2.5 这类视频生成，
> 它们已经很成熟了，而我们要做的是代码生成数字人……因为数字人只是我们的第一步。
> 第二步就扩散到场景。后期我们可以用纯代码来讲故事。」
>
> 状态：**方向判断 / 全网调研 / 第一刀验证**。本文重建项目的根命题，并给出解决之道。
> 与 `ROADMAP.md §17` 的关系：§17 回答的是「口播效果再好一点」，属于**这一层里的一个子问题**；
> 它不是根命题。§17 保留为历史判断轨迹，不再代表最终研究方向（见 §0.3）。
> 产品原则继续适用 `ROADMAP.md §16`：**技术选择服务于效果，缩减资源不是产品目标。**

---

## 0. 方向纠偏：上一轮为什么跑偏

### 0.1 错在哪

`ROADMAP.md §17` 从「继续推进高质量数字人口播」出发，顺着行业惯性去调研
MiniMax H3 / Seedance / LongCat / LTX 这类整帧生成模型，然后花了大半篇幅论证
「我们该不该转神经渲染」。这有三个问题：

1. **把参照系选错了**。把「视频生成模型」当同行，就等于默认我们也在做「生成画面」。
   一旦接受这个前提，后面所有讨论都只能是「画质、成本、要不要上 GPU」，
   而项目真正在做的事——**让画面成为一份可编辑的程序**——反而消失了。
2. **把「口播」当成了终点**。口播是角色层的一个应用，不是项目目标。
   用户从一开始就说了：数字人是第一步，后面还有场景，还有用纯代码讲故事。
3. **顺着最卷的方向找突破口**。视频生成模型已经很成熟、价格被打到 $0.04/分钟，
   在这条曲线上追赶既没有稀缺性，也会丢掉我们唯一的东西（确定性、可编辑、同一张脸）。

### 0.2 重新界定

| | 上一轮（§17） | 本文（根命题） |
|:--|:--|:--|
| 问题 | 怎么让嘴更跟得上声音 | **视觉世界能不能成为一份程序** |
| 参照系 | 视频生成 / 口播 SaaS | 程序合成、矢量图形学、PCG、叙事 DSL、Agent 工具链 |
| 单位 | 一帧画面 / 一段视频 | 一份可 diff、可校验、可回放的 `program` |
| 终点 | 更自然的口播 | 角色 → 场景 → 叙事，共用同一个纯函数 |
| 数字人的位置 | 全部 | **第一个节点** |

### 0.3 保留但不继承

§17 的**技术内容仍然有效**：音素级对齐、协同发音 dominance、上半脸跟韵律、
`gate_sync.py`、盲评门槛——这些是角色层内部的效果改进，Q1 路线可以照做。
被否定的只是它的**参照系和终点设定**。本文不删 §17，按项目惯例留作判断轨迹。

---

## 1. 一句话主张

> **视觉世界 = 一份可由 LLM / Agent 生成、可 diff、可验证、可回放的程序。**
> 角色、场景、叙事不是三个功能，是**同一个抽象在三个尺度上的展开**：
>
> ```
> renderWorldFrame(program, t) -> SVG 字符串
> ```
>
> `t` 是唯一自变量；同一份 program + 同一个 t 永远给出逐字节相同的画面。

这与视频生成是**两个物种**，不是同一条曲线的两端：

| | 像素生成（MiniMax H3 / Seedance / Wan-Animate / SCAIL） | 视觉世界程序（本项目） |
|:--|:--|:--|
| 中间产物 | 隐空间 latent，不可寻址 | 结构化 JSON / DSL / SVG DOM |
| 改一个细节 | 重抽卡，其余像素一起变 | 改一个字段，其余逐字节不变 |
| 跨镜头身份 | 靠参考图条件，长时会漂移 | 同一份 `chars` 引用，构造上不漂移 |
| 谁来验证 | 人看片 / VLM 打分 | 结构校验 + 量具 + 逐字节 golden + 人看片 |
| 谁能不能写 | 只有模型 | **LLM / Agent / 人 / 脚本都能写** |
| 失败模式 | 崩坏、伪影、重出 | 语法错、锚点错、构图错——**可定位、可修** |

关键不是「我们更省算力」，而是**中间表征不同**。所以模型越成熟，越衬托出
「可编辑、可治理、确定性的那一侧」稀缺——它们不冲突，是分工。

---

## 2. 研究范围与证据口径

- **方法**：2026-11-14 三轮检索。`domain_search` 做跨源谱系综合（2 次），
  `WebSearch` 逐项核实项目/论文真伪与架构细节（11 次）；国内外来源都覆盖。
- **一手源优先**：arXiv / CVF Open Access / GitHub 仓库 README 与 `docs/architecture.md` /
  npm 包页 / 项目主页。二手转述只用于发现线索，不用于下结论。
- **口径纪律**（承接 §17.8）：
  - 论文里的百分比、加速比、偏好率**全是作者自报**，且各在不同硬件/骨干/任务集上测得，
    **不可跨设置比较，也不当本项目验收线**；
  - star 数、融资额、市场规模来自快照，不同来源差 20%–100%，只作趋势不作结论；
  - **许可单独核对**，见 §12.3——这是能不能做产品的硬门槛，不是脚注。
- 本文所有外部项目的存在性与核心机制均已在本轮核实；凡未核实到一手源的一律不写入。

---

## 3. 技术谱系全景

三个此前相对独立的社区，近两年在经历**同一次范式转变**：
从「直接生成像素/网格」转向「生成可执行、可编辑的中间结构」。

```text
                    ┌─ L1 矢量/分层表征 ─────────────────────────┐
文本 / 图像 ────────┤ SVG token → 语义分组 → 稀疏状态更新(SSU)   │──→ 可编辑角色
                    └──────────────────────────────────────────┘
                    ┌─ L2 程序化（代码即资产）───────────────────┐
文本 ───────────────┤ 层次/关系 program + 语义词 + 约束求解器    │──→ 可编辑场景
                    └──────────────────────────────────────────┘
                    ┌─ L3 叙事编排 ─────────────────────────────┐
故事 / 概念 ────────┤ 分镜 → 镜头 → 时间线 → 静态关键帧验证      │──→ 可编辑故事
                    └──────────────────────────────────────────┘
        ══════════ 横切底座：可验证的程序中间表征（§3.1）══════════
```

**L1 与 L2 解决「能不能编辑」，L3 解决「能不能讲完整的故事」。
目前没有一个开源系统把三者闭环，且同时保住高保真角色——这就是缺口（§6）。**

### 3.1 横切底座：可验证的程序中间表征

这是本轮调研最重要的收敛结论：**多个互不相关的社区，在 2025–2026 同时得出
「面向 Agent 的中间表征必须是结构化、可 diff、可无头验证的」**。

| 证据 | 具体做法 |
|:--|:--|
| `Rev2D`（MIT） | 一个 rig = 一份 `*.r2d.json`；确定性无头渲染（同输入同像素）；`validate → render → sheet → inspect/analyze → atomic ops` 闭环；`inspect` 直接给数字：bone transforms / part bounds / IK reach / physics clamping / loop seams |
| `talekit`（MIT） | 「Paper for video」：**every write returns a picture so the agent can see and fix its output**；`write_character` 返回 pose sheet，`write_scene` 返回 anchor sheet，人把「哪里不对」写进 `notes.json`，`list_notes` 带图交回 Agent 修 |
| `TopoTopo` | 节点图即 JSON 程序，确定性无头 cook、无 GPU；MCP 提供 `assert` / `explain` / `diff`，Agent 自检 |
| `open-bot-avatar`（MIT） | 角色定义是一小份 JSON；`validateAvatar()` 返回 `{ok, errors}`；`renderAvatarSvg()` 返回 SVG 字符串、不需要 DOM；附 `system-prompt.md` 让任意聊天模型直接写定义 |
| `novatar` | 同 seed 跨机器/运行时/回放 **byte-identical**；MCP server + `AGENTS.md`；「No prompts. No network.」 |
| `huashu-motion` | 预览时按 C 键点画面任意一帧输入修改意见，Agent 定点改那一处——「指图给反馈」的产品化 |

**读法**：这些项目不是「更聪明的生成模型」，是**把生成结果变成工程对象**。
而工程对象的价值不在生成那一刻，在**之后能不能被检查、被改、被合流、被回放**。
这与本项目 `identity_check` 15 帧逐字节 / 同管线 parity 0 差异 / 发布包三入口一致，
是同一套纪律——我们已经有半个身子站在这里了（§7）。

### 3.2 L1 角色程序：生成、绑定、动画三件事

**生成侧**（文本/图 → 可编辑矢量）分两派：

- **优化派**：`DiffVG`（SIGGRAPH 2020）提供可微光栅化底座，
  `CLIPDraw`（NeurIPS 2022）/ `VectorFusion`（CVPR 2023）/ `DiffSketcher`（NeurIPS 2023）/
  `SVGDreamer`（CVPR 2024）/ `LIVE`（CVPR 2022）逐张优化路径参数；
  `PyTorch-SVGRender` 把它们收进统一框架。缺点是每张图单独优化、慢，且路径结构松散。
- **LLM token 派**：`StarVector`（CVPR 2025，SVG-Stack 2.1M / SVG-Bench / DinoScore）
  把矢量化重定义为代码生成；`OmniSVG`（NeurIPS 2025，arXiv 2504.06263，Qwen2.5-VL 底座）
  把 SVG 命令与坐标**参数化为离散 token**，发布 MMSVG-2M 与 MMSVG-Bench，
  并提供**角色参考生成**（同一角色换姿势/场景）；`InternSVG`（arXiv 2510.11341）
  用统一 MLLM 做理解/编辑/生成，SAgoge 数据集明确覆盖 dynamic animation；
  `SVGenius` 基准（2377 query / 22 模型）指出所有模型随复杂度上升系统性退化。

  > **口径陷阱**：OmniSVG 论文对比里，传统描摹工具 `VTracer` 的 SSIM/LPIPS/MSE 反而更好，
  > 代价是输出 52.4k tokens 的不可编辑路径。**「视觉保真」和「结构可编辑性」是两回事**，
  > DinoScore / MMSVG-Bench / SArena 都还在解决这个评测缺口。
  > 另有三处「可编辑」定义互不通用：OmniSVG 指能导进 Illustrator 改路径，
  > VAnim 指 DOM 拓扑不变，Live2D 系指 rig 参数可调——论文里不能互换。

**绑定侧**（矢量 → 可驱动）：`OpenMascot`（MIT）最值得读——
普通 SVG 上打 `data-om-*` 标注，`compileRig(svg)` 编译成
`Rig { bones, slots, art }`，DOM-free core（20.6 kB），`renderSvg()` 出字符串，
clip 是 plain JSON（README 原话「great for AI agents」）。
另有 `Inochi2D`（BSD-2）、`DragonBones`、`Synfig`、`Ayatsuri2D`（读写 moc3）等生态；
`Rev2D` 则是把 Live2D/Spine 的概念整个重做成 Agent 可读写的形式。

**动画侧**：`VAnim`（arXiv 2605.01517，ICML 2026）是本轮最关键的学术锚点。
它把动画重新定义为**持久 SVG DOM 树上的稀疏状态更新（Sparse State Updates, SSU）**：
相邻帧 85%+ 语法不变，只预测变化的 `(id, attr, value)`，24 帧序列压缩 9.86×；
结构不变性由表示本身保证，因而**构造上消除身份漂移**；
配 Identification-First Motion Planning、Rendering-Aware GRPO（渲染成视频用 PE-Core 给奖励）、
SVGAnim-134k 基准。作者自述限制：假设拓扑固定、训练数据偏干净 Lottie 图形。
`Vector Prism`（arXiv 2512.14336）进一步诊断：VLM 做 SVG 动画失败的根因
不是规划能力，而是**视觉连贯部件被拆成低层 shape**，需要先恢复语义分组。

> **这一步对本项目的意义**：我们三年前凭工程直觉选的架构
> ——角色 JSON 是持久结构、Pose 是稀疏参数、`FaceTraced` 是纯函数渲染——
> 现在被 VAnim 从学术上命名为 SSU 并证明是「结构保持 + 身份不漂移」的正解。
> 不是我们要去追 VAnim，是**我们已经在同一个范式里，而且起点是高保真人脸**。

### 3.3 L2 场景程序：从规则到 LLM 写程序

- **第 0/1 代**：PCG（WFC、L-system、噪声地形）、Houdini SOP / Blender Geometry Nodes。
  知识库概括很准：PCG 的可控度介于手工与 AIGC 之间，但**用户只能用设计者显式定义的指标控制**。
- **第 2 代 声明式约束**：`Infinigen` / `Infinigen Indoors`（Princeton VL，BSD-3）
  全程序化 40k+ 行、不使用任何外部静态资产；Indoors 加约束 DSL + 求解器做家具布置。
  官方文档明确：程序化场景**不自动提供**经验证的碰撞体/动力学。
- **第 3 代 LLM 写程序**：`SceneCraft`（arXiv 2403.01248）
  把 scene graph 转数值约束 → Blender 渲染 → GPT-V 评图迭代，外层做 library learning 沉淀可复用函数；
  `ImperativeScene`（SIGGRAPH Asia 2025，作者含 WFC 原作者 Maxim Gumin）对比命令式与声明式，
  强制选择偏好率 82% / 94%，核心论点是：**LLM 空间推理弱、数值参数常错，
  纠错必须在「程序空间」做，在「对象空间」做梯度式修补无效**。
- **理论锚点 `The Scene Language`**（CVPR 2025，arXiv 2410.16770，Stanford）：
  `Φ(s) = (W, P, Z)` —— `P` 是指定实体层次与关系的 **program**，
  `W` 是自然语言**语义词**，`Z` 是**视觉身份嵌入**；
  可由预训练语言模型 training-free 推断，再交给传统/神经/混合渲染器出 3D/4D。
  论文明确主张：比 scene graph 保真度更高，且**因为显式建模结构，所以能精确控制和编辑**。
- **Agent 可自检**：`TopoTopo`（节点图 JSON + 确定性 cook + MCP `assert/explain/diff`）。

> 对我们的启示不是「去做 3D」，而是两条：
> ① **程序 + 词 + 身份** 这个三元组可以原样落到 2D SVG——
>    把 `Z` 从向量嵌入换成**可 diff 的资产引用**（`chars` / layer ref），更符合代码纪律；
> ② 场景错误要在**程序里改**（改 `repeat.count`、改锚点、改层序），
>    不要去改渲染后的像素——这正是 `ImperativeScene` 的实验结论。

### 3.4 L3 叙事程序：镜头、时间线、可验证的关键帧

- **`Prose Storyboard Language`**（arXiv 1508.07593，2012 WICED 起）：
  上下文无关语言 + PEG 语法，语义用 **Timed Petri Net**（持续性事件=place，
  瞬时事件=transition）；刻意用**屏幕坐标**而非世界坐标；
  严格区分 `shot`（连续拍摄）与 `composition`（画面内排布）；默认值放 stylesheet。
  手工标注《回到未来》《西北偏北》《夺魂索》《历劫佳人》共 177 shots / 330 compositions 验证表达力。
  这套「形式化但可读」的设计，比自由文本 prompt 更适合当 Agent 的输出契约。
- **端到端雏形**：`talekit`（MIT，2026-10，20 个 MCP 工具）把故事拆成
  `characters/*.json`（rigged puppet，按部件 SVG + 口/眼 variant map）、
  `scenes/*.json`（背景 SVG + 命名地面锚点 + far/near 视差层）、
  `shots/NN-*.json`（场景 + cast + timed actions），
  `composeFrame(project, shot, t)` 返回 SVG，resvg 光栅化 + ffmpeg 编码，**不需要浏览器**。
  `animdsl`（Rust + pest PEG + tiny-skia，7665 行，全部由 Agent 生成）
  用 `.anim` DSL 出 4 幕 ~90 秒《The Last Barista》：23 个关节/表情参数、
  走循环、相机、转场、重叠检测、SVG 背景。
- **`animdsl` 的失败模式必须抄下来**：作者自述项目经历三次重写
  V1 刚性 SVG 木偶 → V2 骨骼 rig → V3 完全程序化贝塞尔；
  并明确写道「**Agent 一直过度工程化基础设施，视觉输出却停在火柴人质量，
  需要直白尖锐的反馈才打破循环**」；重叠检测是角色互相穿过之后才加的，
  身体角度是所有人都像纸片之后才加的。
  **纯代码讲故事的技术可行性没问题，真正的瓶颈是「没有视觉验收闭环」。**
- **`DyCraft`**（Stanford，arXiv 2610.40754）给出解法方向：
  裸 Agent 的根本问题是「一次性脚本化整段动画，无法验证、无法拆时空约束」；
  借人类动画师的 **pose-to-pose + 3D storyboard**——先建静态场景，
  再做**每帧都可独立构建和调试**的关键姿态，最后才在已验证的起止状态之间授权局部运动。
  24 个长程多镜头任务上人类偏好率 89.7%（vs VIGA）/ 72.3%（vs 裸 Codex agent，均作者自报）。
- 生态里还有 `Fogsight`（LLM 驱动叙事动画，LUI 多轮自然语言精调镜头）、
  `ArcReel`（角色 DNA + 分镜帧锁一致性）、`OpenMontage`、`MM-StoryAgent`、
  `Remotion` / `Motion Canvas` / `Manim` / `HyperFrames` / `Revideo` 等代码动画框架。
  **它们大多以像素视频为最终产物**，这正是与本项目分道的位置。

### 3.5 三条线合起来说明什么

生成侧能出可编辑矢量，绑定侧能把它驱动起来，场景侧能程序化造世界，
叙事侧能把镜头和时间线形式化——**每一段都有成熟工作，但没有一条链把它们接起来，
还同时保住高保真角色 + 确定性 + 可验证**。这比「哪个模型更强」重要得多。

---

## 4. 类似项目逐一对账

> 列「我们能抄什么」和「不能抄什么」，不是列清单。许可栏见 §12.3 的陷阱提醒。

### 4.1 最接近的四个（必须逐行读）

| 项目 | 中间表征 | 生成 | 绑定 | 场景 | 叙事 | 验证闭环 | 我们抄什么 / 不抄什么 |
|:--|:--|:--:|:--:|:--:|:--:|:--|:--|
| **talekit** (MIT, 0★, 2026-10) | `characters/` `scenes/` `shots/` 三份 JSON + `composeFrame→SVG` | Agent 写 | ✅ | ✅ | ✅ | **写即返图 + notes.json 人工指错** | 抄：三段式目录、锚点、每次写入返回预览、人在画面上标注的回路。不抄：它自己画卡通角色（视觉质量低），我们用现成高保真脸 |
| **Rev2D** (MIT, ~40★) | 一份 `*.r2d.json` = 完整 rig | ❌ | ✅ | ❌ | ❌ | **inspect/analyze 给数字 + atomic ops 原子批改** | 抄：结构化错误（带 JSON pointer + 稳定 code + fix hint）、参数 sweep 出 contact sheet、数字量具。不抄：WebGL2 编辑器（我们暂无人力） |
| **OpenMascot** (MIT) | 带 `data-om-*` 标注的普通 SVG → `compileRig` | ❌ | ✅ | ❌ | clips | 编译期 warnings / RigError | 抄：标注式编译（设计师画、Agent 标、代码编译）、DOM-free 字符串渲染、clip = plain JSON。不抄：通用吉祥物 2.5D 求解（我们是人脸特写） |
| **animdsl** (Rust) | `.anim` PEG DSL | ❌ | 程序化 | ✅ | ✅ | `check` 语法校验 + overlap detection | 抄：**整段动画先拆成可独立验证的静态关键帧**；程序化 `repeat`/相机/转场。不抄：从零用贝塞尔画人（我们已有设定稿描摹路径） |

### 4.2 学术 / 底座

| 工作 | 一句话结论 | 对本项目的用处 |
|:--|:--|:--|
| `The Scene Language` (CVPR 2025) | `(W, P, Z)` = 词 / 程序 / 身份；显式结构 ⇒ 可精确控制编辑 | 场景层 schema 的理论骨架 |
| `VAnim` (ICML 2026) | 动画 = 持久 DOM 上的稀疏状态更新，构造上不漂移 | 印证并命名我们已有的角色/Pose 架构 |
| `ImperativeScene` (SIGGRAPH Asia 2025) | 纠错必须在程序空间，不在对象空间 | 支撑「改 JSON 而不是改像素」的纪律 |
| `OmniSVG` (NeurIPS 2025) | 参数化 SVG token；有角色参考生成 | P1 自动建角的可选后端（但需 26GB 显存、自然图会失败） |
| `StarVector` (CVPR 2025) | 矢量化 = 代码生成；DinoScore / SVG-Bench | 评测口径参考（像素指标与矢量感知脱节） |
| `InternSVG` / `SVGenius` / `Vector Prism` / `Decomate` | 统一 SVG 任务 / 复杂度退化 / 语义分组是动画前提 / 自然语言迭代重构 | 「语义部件」先于动画，支持我们按 role 组织层 |
| `DiffVG` + `PyTorch-SVGRender` 系 | 可微光栅化 + SDS 优化 | **暂不引入**：优化派产出路径松散，与可编辑目标冲突 |
| `PSL` (arXiv 1508.07593) | PEG + TPN + 屏幕坐标 + shot/composition 分离 | 叙事层形式化契约 |
| `DyCraft` (Stanford) | pose-to-pose，先静态可验证关键帧 | 支撑 v0 不做插值、每帧独立 golden 的选择 |

### 4.3 国内：已经卡住上游模型位

- **商汤 `SenseNova 6.8 Code2Video`**（2026-10-24，27B，512K 上下文，Apache-2.0）：
  不猜像素，靠**编写可执行代码**（HTML/CSS、Canvas、SVG、Three.js、Manim、p5.js）生成视频；
  每帧是时间 `t` 的**纯函数**，确定性逐帧捕获，「同一份代码无论运行多少次分毫不差」；
  支持多轮自然语言精修，甚至把无源码参考视频逆向重构成可编辑代码工程。
  作者自陈边界：不做写实影像、仅有定性样例无系统评测、视觉精致度与长程可靠性
  明显落后最强闭源模型、单次制作需 4 卡数小时。
  > **这家国内大厂和我们是同一个核心机制**（`f(t)` 纯函数、确定性、可编辑），
  > 差别在它做通用视频、我们做高保真可驱动角色 + 后续世界。
  > 这既验证方向，也说明**模型层不构成壁垒**——不必训自己的模型。
- 同侧还有 `AesCode-8B/32B`（微软，图为参考、代码为产出）、`MOSS-Image`（JSON 描述布局、
  改元素即改字段）、`SenseNova-U1.5`；工程侧 `huashu-design` / `huashu-art-motion`
  （36 艺术风格 + 9 叙述语法 + 8 参数化片段）、`lemo-opuscar`（59 种纯代码影片风格，
  明确不调用视频生成模型）、`huashu-motion`（点图反馈）。
- **必须划清界线**：`Wan-Animate-2`（阿里，DiT 端到端角色动画，Apache-2.0）、
  `SCAIL-2`（智谱 + 清华，去掉骨骼中间表示的扩散变换器）
  属于 §1 表里左列的**像素生成**，技术很强但不是本项目路线。
  用户点名的 MiniMax H3 / Seedance 同理。

### 4.4 产业侧：需求很热，结构很畸形

- `Code2Video-Compass`（2104 任务 / 10 大类 / 24 子类 / 12 客观 + 5 主观 / 15 个 MLLM）
  核心发现：**视觉质量与执行可靠性不相关**，执行成功率区间低至 **0.52–0.97**；
  模型幻觉出不存在的 NPM 包、用过期 API 是常见失败。
- `VibeVideoBench`（arXiv 2610.35864，239 个中英双语任务，9 个 Agent 系统，2151 次评分，
  1 小时 / 8 CPU / **无 GPU / 无生成模型** 沙箱）：最强系统全项达标率 **76.3%**；
  **约 3/4 的失败发生在最后一步——渲染来不及，而不是内容做不出来**。
- 生态盘点：AI 设计类 8 个仓库合计 158.8K stars、视频即代码类项目众多，
  但**九成以上是「技能包 / 管线」，不是产品**；star 反映的是
  「Agent 技能层的注意力」，不是生产工作流的渗透率
  （对照：Remotion star 更少，但月均 npm 安装 500–900 万、800+ 付费客户）。
- 商汤自己也承认：「代码驱动视频的 benchmark 是一个**重要开放问题**」。

---

## 5. 论文与项目索引（本轮核实过的一手源）

**矢量生成 / 动画**
- OmniSVG — https://arxiv.org/abs/2504.06263 · https://github.com/OmniSVG/OmniSVG
- StarVector (CVPR 2025) — https://starvector.github.io/ · https://github.com/joanrod/star-vector
- InternSVG — https://arxiv.org/abs/2510.11341
- VAnim — https://arxiv.org/abs/2605.01517 · https://yukinonooo.github.io/VAnimProject/
- Vector Prism — https://arxiv.org/abs/2512.14336 ；Decomate — https://arxiv.org/abs/2511.06297
- DiffVG (SIGGRAPH 2020) / PyTorch-SVGRender — https://github.com/ximinng/PyTorch-SVGRender
- VectorFusion (CVPR 2023) — http://vectorfusion.github.io/

**绑定 / Agent 中间表征**
- OpenMascot — https://github.com/jbraunschweiger/openmascot （`docs/architecture.md`, `docs/api.md`）
- Rev2D — https://github.com/RevStudio/Rev2D
- open-bot-avatar — https://github.com/DominikScholz/open-bot-avatar
- novatar — https://github.com/nika-loki/novatar
- TopoTopo — npm `topotopo` v0.5.3

**场景 / 叙事**
- The Scene Language (CVPR 2025) — https://arxiv.org/abs/2410.16770 · CVF Open Access
- Infinigen — https://github.com/princeton-vl/infinigen
- ImperativeScene (SIGGRAPH Asia 2025) — https://github.com/mxgmn/ImperativeScene
- SceneCraft — https://arxiv.org/abs/2403.01248
- Prose Storyboard Language — https://arxiv.org/abs/1508.07593
- DyCraft — https://arxiv.org/abs/2610.40754
- talekit — https://github.com/vivekg7/talekit
- animdsl — https://github.com/frankhart2018/animdsl

**国内 / 评测 / 产业**
- SenseNova 6.8 Code2Video — https://github.com/OpenSenseNova/SenseNova-6.8-Code2Video
- Code2Video-Compass / VibeVideoBench — https://arxiv.org/abs/2610.35864
- Remotion 许可与定价 — https://www.remotion.dev/ （**source-available，非 OSI 开源**）

---

## 6. 空白判断：突破口到底在哪

### 6.1 没有人站在的位置

把 §4 的能力矩阵横着看：

| | 高保真角色 | 参数化表演 | 程序化场景 | 叙事时间线 | Agent 生成 | 确定性验证 |
|:--|:--:|:--:|:--:|:--:|:--:|:--:|
| OmniSVG / StarVector / VAnim | △（图形，非可驱动角色） | △ | ❌ | ❌ | ✅ | △ |
| OpenMascot / Rev2D / Inochi2D | △（卡通/需美术） | ✅ | ❌ | clips | 部分 | ✅ |
| talekit / animdsl | ❌（火柴人/卡通） | ✅ | ✅ | ✅ | ✅ | 部分 |
| The Scene Language / Infinigen | — | — | ✅ | ❌ | 部分 | ✅ |
| PSL / DyCraft / Video-Coder | — | — | △ | ✅ | ✅ | 部分 |
| 视频生成模型 | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| **本项目** | **✅（no4 设定稿，用户认可）** | **✅（15 维 Pose / 6 viseme / 5 mood）** | **本轮 v0** | **本轮 v0** | **待补（P2）** | **✅（golden / parity / 三入口）** |

**没有任何单一开源系统同时具备这六项。** 尤其「高保真角色 + 确定性验证」这一组合，
恰恰是别人要么不重视、要么做不到，而我们已经有现成证据链的地方。

### 6.2 产业证据：真正缺的不是生成，是交付

`Code2Video-Compass` 与 `VibeVideoBench` 从两个独立角度给出同一个结论：
**代码驱动视觉的瓶颈在「执行可靠性 / 最后一公里」，不在画质，也不在模型能力**。
而「确定性、可校验、可回归、可定位失败」正是我们过去两个月为修 noF 嘴部
被迫建立起来的东西（`identity_check`、同管线 parity、发布包三入口一致、
`world.ts` 的 `validateWorldProgram`）。

> 这不是「我们比别人强」，是**这个位置没人站，而我们已经有半个身子在那**。
> 战略上应该往这里挤，而不是掉头去追已经卷完的像素生成。

### 6.3 因此我们不做「入口画布」

产业侧还有一个明确警告：Anthropic（Claude Design）、Figma、Canva、Replit
正在把「入口画布」重估成模型厂的附属品；上游模型通吃风险最高的就是这一层。
我们应该站在它们**下游**，做它们做不了的「最后一公里」：
确定性渲染、视觉回归、可 diff 的资产、跨端点同一张脸。

---

## 7. 我们停在哪：代码级对账

| 能力 | 现状（文件） | 评价 | 缺口 |
|:--|:--|:--|:--|
| 角色几何 | `FaceTraced.tsx` + `chars/no4.json`（50 层，描摹自设定稿） | **最强项**：高保真、可编辑、逐层语义 | — |
| 表演参数 | `types.ts` 15 维 `POSE_RANGES`、`VISEME` 6、`MOODS` 5 | 已是 JALI 式控制空间雏形 | 默认出片仍是逐帧硬切（§17 已对账） |
| 纯函数渲染 | `svg.ts` `renderFaceSvg(data, pose)` | 唯一事实源；SSR 出纯 SVG 字符串 | — |
| 确定性证据 | `identity_check.py` 15 帧逐字节 / `runtime_parity_check.py` 0 差异 / `verify.mjs` 三入口一致 | **稀缺资产**，正是产业空白 | 尚未产品化成对外能力 |
| 可发布运行时 | `packages/avatar-runtime@0.2.0`（CJS/ESM/standalone） | 可用 | 未发 npm |
| **建角** | `trace_design.py` 手量 `PRESETS`，换角色要人量五区 | **最硬的瓶颈**：不是渲染，是建角 | 需要可 diff 标注 + 编译 + 目检闭环 |
| **场景** | 无（本轮前） | — | `world.ts` v0 已补最小形态 |
| **叙事** | `perf.ts` 时间线 + Remotion composition | 只有「一段口播」，没有分镜/镜头/多场景 | `Shot` / `camera` / `beats` v0 已补 |
| **Agent 接口** | 无 | — | 无 MCP / CLI，Agent 不能「写→看→改」 |
| **视觉验收闭环** | 人工目检（靠纪律，非工具） | noF 两次返工证明**必要但不可靠地执行** | 需要「写即返图 + 结构化指错」产品化 |

**读法**：我们的短板不在画质，在**「让这份程序能被生成、被看见、被改」**。
上一轮 §17 想解决的是画质/表演，这一轮要解决的是可生产性。

---

## 8. 解决之道：三层展开 + 一个底座

### 8.1 程序形状

```text
WorldProgram (一份 JSON，可 git diff)
├─ chars   : { lead: { key:"no4", anchor:"lead", scale:0.42 } }   ← 只放引用，不放美术资产
├─ scenes  : {                                                     ← L2 场景程序
│     plain: { words, bg, anchors, layers:[
│                { role:"far", shapes:[...], repeat:{count,dx,dy} }   ← P：层次 + 循环
│             ] } }
└─ shots   : [ { id, scene, duration, camera:{x,y,zoom},          ← L3 叙事程序
                 beats:[ { at, cast:{ lead:{viseme,mood,pose} }, caption } ] } ]
                                          ↑ VAnim 式稀疏状态更新（SSU）

renderWorldFrame(program, t, chars) -> SVG 字符串     ← 唯一纯函数
                                  └─ 角色部分固定调用 renderFaceSvg（唯一事实源）
```

三个尺度共用**同一个 `t`、同一份程序、同一个渲染器**。
这就是为什么「数字人只是第一步」而不是「再开一个新项目」：
场景不是另一个引擎，是把 `program.scenes` 填进去；
讲故事不是接一个视频模型，是把 `program.shots` 排成时间线。

### 8.2 五条设计纪律（从本轮调研 + 本项目踩坑里提炼）

1. **唯一事实源**：角色画面只能由 `renderFaceSvg` 产生。`world.ts` 只做组合，
   不许出现第二条人脸绘制路径。由硬断言逐字节守（§11）。
2. **稀疏状态更新**：帧不存整张脸，只存 `(charKey → {viseme, mood, pose})` 的变化量；
   结构不变 ⇒ 身份构造上不漂移（VAnim 的结论，我们已经在做）。
3. **每帧独立可验证**：任意 `t` 都能单独求值、单独出 SVG、单独 golden、单独目检。
   v0 刻意**不做插值**（DyCraft 的 pose-to-pose：先把静态关键帧做对）。
4. **错误在程序空间修**：结构化 `validateWorldProgram` 返回带路径的错误，
   改 JSON 字段而不是改渲染后像素（ImperativeScene 的实验结论）。
5. **人工目检是最后一门，且要变成工具**：
   `talekit` 的「每次写返回一张图」+ `huashu-motion` 的「点图给反馈」+
   我们 noF 的教训，共同说明**机检永远有盲区**。本轮又实证了一次（§11.3）。

### 8.3 与产品原则不冲突

§16 定的是「技术选择服务于效果，不为缩减资源而缩减资源」。
本文选择「程序中间表征」**不是因为它省算力**，而是因为它是
唯一能同时给出「可编辑 / 确定 / 跨端点同一张脸 / Agent 可写」的表征。
若将来某一段（材质、光照、神经纹理、甚至局部视频生成）能显著提升效果，
按 §16 直接引入——它作为**可选离线后端**挂在同一个 `program` 上即可，
不需要改这三层抽象。`§17.6 决策门 D` 的判据继续有效。

---

## 9. 分阶段路线与验收口径

| 阶段 | 做什么 | 借鉴 | 验收（写死，不靠感觉） |
|:--|:--|:--|:--|
| **P0 · 本轮已做** | `WorldProgram v0`：场景图元 + `repeat` + 锚点 + 分镜 + 镜头 + 稀疏 beats + 字幕；共用 `renderFaceSvg` | The Scene Language (W/P)、PSL (screen coords)、VAnim (SSU)、talekit (三段 JSON) | §11 的四条硬断言全 PASS；no4 golden 零漂移；人眼目检无穿帮 |
| **P1 · 建角闭环**（最该先做） | 换角色不再靠手量 `PRESETS`：`design sheet → 可 diff 语义分区标注 JSON → compileRig 风格编译 → 六格目检 + gate + golden` | OpenMascot 标注编译、Rev2D `validate/inspect/ops`、OmniSVG 角色参考（可选后端） | 新增一个角色全程不改渲染器；标注 JSON 可 diff；目检无「白胡子/肤色缝」类结构错误 |
| **P2 · Agent 接口** | CLI + MCP：`write_program` 返回结构校验 + 预览图 + 数字量具；`note` 机制让人在画面上指错，Agent 带图修；`diff` 看两个版本视觉后果 | talekit 写即返图 + notes.json、TopoTopo assert/explain/diff、Rev2D atomic ops | Agent 无人工看像素也能自检至少 5 类结构错误；一次「指错→修→复验」闭环可复现 |
| **P3 · 叙事层做厚** | 按 PSL 引入 shot/composition 分离、TPN 式并发事件、角色锁定、镜头预设库、多画幅/多语言变体；再考虑插值与音频 | PSL、DyCraft、talekit shots、animdsl camera/transition | 同一 program 出横/竖/多语言帧一致；长程身份零漂移；盲评观感不劣于 v0 |
| **贯穿** | §17 的 Q1（音素对齐 / 协同发音 / `gate_sync` / 盲评）作为**角色层内部效果线**并行推进 | §17 | §17.7 口径 |

**明确不排进路线**：训自己的视频生成模型、做通用入口画布、以 star 数当效果指标、
为「守住零依赖」而拒绝能提升效果的后端。

---

## 10. 明确不做（同样重要）

1. **不做整帧像素生成主线**。不是因为贵，是因为它会同时丢掉可编辑、确定性、
   跨端点同一张脸、批量结果一致——恰好是 `Code2Video-Compass` 说行业最缺的「稳」。
2. **不训基础模型**。商汤 Code2Video / AesCode / MOSS-Image 已把「代码即视觉」的
   基座开源化且国内厂商占多数，模型层不构成壁垒；壁垒在**工作流、治理、验证、分发**。
3. **不做入口画布**。上游模型厂正在通吃这一层（§6.3）。
4. **不把「零依赖 / 零 GPU」当卖点或约束**（§16）。README 定稿标题里的
   「可编辑、0算力成本」是用户认可的产品表达，不是技术禁令。
5. **不用 star / clone 数判断效果**（`ROADMAP §14` 既有结论）。

---

## 11. 第一刀验证记录（2026-11-14 实测）

### 11.1 落地文件

| 文件 | 作用 |
|:--|:--|
| `packages/anchor-core/src/world.ts` | `WorldProgram` schema + `validateWorldProgram` + `shotAt` / `stateAt` / `poseOf` + `renderWorldFrame`（纯函数） |
| `packages/anchor-core/src/index.ts` | 导出 world API；**刻意不引用 `CHARS`**，发布包不会被迫内置美术资产 |
| `examples/world/first-story.json` | 可 diff 的故事程序：2 场景 / 6 分镜 / 12 拍 / 10 秒 / 1 角色 |
| `tools/world/world-entry.ts` | SSR 构建入口，只在构建侧注入角色表 |
| `tools/world/export.mjs` | 导出 + 四条硬断言 + golden 基线 + 单文件 demo |
| `demo/world.html` | 零依赖、打开即播放的「纯代码讲故事」demo（2.98 MB） |
| `tools/runtime/screenshot.mjs` | 增加 `--width/--height`（默认不变），用于人工目检 |

### 11.2 实测输出

```text
[world] 结构校验通过 · 2 场景 / 6 分镜 / 1 角色
[world] 12 帧 · 总时长 10.0s · 均值 253 KB/帧
[world] 确定性 / 唯一事实源 / id 唯一化：全部逐字节通过
[world] demo/world.html        2.98 MB
[world] out/world/golden.json  12 帧 sha256 基线
PASS：WorldProgram v0 —— 三层共用同一纯函数，确定性 / 唯一事实源 / 零漂移 ✓
```

四条硬断言：① 结构校验；② 同一 `t` 渲染两次逐字节一致；
③ 世界帧里的角色片段 **==** 直接调用 `renderFaceSvg` 的 body（证明没有第二套渲染器）；
④ 每帧 `url(#x)` 可解析、12 帧 id 前缀互不相同。
另测：校验器局部重构前后 `golden.json` 12 帧 sha256 **零变化**；`tsc --noEmit` 通过。

### 11.3 机检 PASS 但目检 FAIL 的一次实证（必须记下来）

初版把场景背景色块放进了 camera 变换组。暗色场景 `camera.x = -30`
把背景一起平移，**画面右侧露出一条白色未绘制区域**。
四条硬断言全部 PASS、golden 全部一致——因为这个错误在 SVG 语法、确定性、
id 引用、角色一致性四个维度上都是「合法」的。

修复：背景与字幕同列为**画面层**，铺在 camera 组之外
（`PSL` 用屏幕坐标的同一条推理）。重跑后目检白边消失。

> 这是 noF 嘴部「`gate_mouth` PASS 但人眼看出完全失败」之后的**第二次同型复发**。
> 结论不是「再加一条机检」，而是：**任何程序化视觉管线都必须把「写即返图 +
> 人能在画面上指错」做成一等公民，而不是靠开发者记得去截图**。
> 它直接决定 P2 的形态。

---

## 12. 诚实边界与风险

### 12.1 v0 证明了什么、没证明什么

- **证明了**：角色 / 场景 / 叙事可以是同一份可 diff 程序；任意 `t` 确定性求值；
  三层共用一个渲染器；每帧可独立做 golden；这套抽象能被结构化校验。
- **没证明**：画面好看、能讲复杂故事、能商用、Agent 能稳定写对 program。
  `animdsl` 的三次重写和 `talekit` 0★ 都在提醒：**「跑通」离「好看」还很远**。
- 场景层目前是**受限图元**（rect/circle/line/text + repeat），表达力有限；
  这不是退化，是刻意先保证可 diff、可校验、Agent 不易写坏。放开自由 SVG 是后面的决策。

### 12.2 外部数据口径

§4.4 的执行成功率、达标率、偏好率、star 数、融资额均来自公开报道/论文自报，
**不是本项目实测**；`Code2Video-Compass` 的 ES 区间与 `VibeVideoBench` 的 76.3%
在不同任务集与沙箱下测得，不可互相推导，更不可当作我们的验收线。
本项目的验收只认 §11 与 `ROADMAP §17.7` 的本地硬断言 + 盲评。

### 12.3 许可陷阱（做产品前必须逐项核对）

| 项目 | 实际许可 | 坑 |
|:--|:--|:--|
| OmniSVG | 代码 Apache-2.0，**MMSVG 数据集 CC BY-NC-SA 4.0** | 数据与代码分离授权，用数据训练会沾 NC/SA |
| Fogsight | **CC BY-NC-ND 4.0** | 禁止商用、禁止演绎；二手文章常写成「完全免费开源」 |
| ArcReel / OpenMontage | **AGPL-3.0** | 包成「客户登录的托管产品」触发网络条款 |
| Remotion | **source-available，非 OSI 开源** | ≥4 人公司需 Company License；$0.01/render + $100/月最低；5.0 起强制 telemetry |
| HyperFrames / Motion Canvas / Infinigen / talekit / Rev2D / OpenMascot / open-bot-avatar | Apache-2.0 / MIT / BSD-3 / MIT / MIT / MIT / MIT | 相对安全，仍需在引入时复核 |
| 本项目 | MIT | 保持核心宽松，把 metering / 托管 / 审计放在服务层 |

### 12.4 战略风险

- **上游通吃**：模型厂已把「可编辑生成」变成基础能力，`Claude Design` 类工具向下延伸很快。
  能活下来的中间层必须是模型厂不愿做或做不好的（跨引擎、合规审计、行业垂直）。
- **视觉质量是最大不确定性**：程序化路线的历史失败模式从来不是「不可行」，
  而是「基础设施越做越多、画面一直停在火柴人」（`animdsl` 原话）。
  P1/P2 必须把视觉验收闭环放在功能之前。
- **不要再把参照系漂回去**：一旦开始讨论「要不要接某个视频模型提升画质」，
  先回 §0 与 §1 确认讨论的是「可选离线后端」还是「改换物种」。

---

## 13. 一句话收口

**别人在让模型画得更好，我们在让画面变成一份能被程序、Agent 和人共同修改的资产。**
数字人是这份程序的第一个节点；场景是它的第二层；用纯代码讲故事，
只是把 `program.shots` 排得更长一点而已。
第一刀已经证明这三件事共用同一个 `renderWorldFrame(program, t)`——
接下来该做的不是换模型，是**让 Agent 能写、能看见、能改这份程序**（P1/P2）。
