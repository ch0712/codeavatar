# 角色 brief 模板（阶段 2 第 1 项）

> 每个新角色的建角请求都应先填这份 brief；`build` 的 manifest 会记录 sheet 路径，
> 本模板约定 brief 的最小字段与设定稿检查项的对应关系。
> 硬规格（尺寸/扁平度/眉眼配对/唇可定位）见 `docs/SPEC.md`，`codeavatar gate` 机检。

## brief 字段

| 字段 | 必填 | 说明 | 机检落点 |
|:--|:--|:--|:--|
| `key` | ✅ | 角色标识（`chars/<key>.json` 的文件名） | build |
| `sheet` | ✅ | 设定稿 PNG 路径 | gate |
| `background` | ✅ | `transparent` 或 `#RRGGBB` 纯色——gate 按"背景可分离"判据检查 | gate（背景判据） |
| `views` | ⬜ | 期望视图清单：`front`（必）+ `3-4`（可选侧视）。**当前流水线只消费 front 视图**，多视图作为身份回归的扩展输入登记 | identity_check（后续扩展） |
| `semantic_labels` | ⬜ | 语义标注：期望的可动件（brow/eye-lid/iris/lip/rim…），建角后与 `layers[].role` 对账 | gate_layer_roles + check_boundaries |
| `personality` | ⬜ | 风格提示（动作幅度倾向），落地到 `MotionStyle`（gazeGain/headGain 等） | style-check |

## 与流水线的对应

```
brief 填写 → gate（背景/尺寸/扁平度/眉眼/唇 判据，含 background 可分离性）
           → build（gate → trace → split-eyes → sync，manifest 留痕每步 hash/耗时）
           → grid（口型机检：六口型两两可分 ≥15%）
           → identity_check --update（15 张固定表演静帧 golden 入库）
           → 交付：chars/<key>.json + <key>.manifest.json + docs/identity/<key>.hashes.json
```

## 诚实边界（勿在 brief 里承诺）

- **只消费 front 视图**；多视图暂不参与建角，登记进 brief 是为后续身份回归扩展预留。
- 设定稿里没有画的平面造不出来（无鼻翼色块 → 无鼻子）。
- 扁平插画级；照片稿、厚涂、强光影会过不了 gate 的扁平度判据。
