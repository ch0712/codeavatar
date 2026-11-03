# 第三方 CLI 集成指南（阶段 5）

> `tools/codeavatar.py` 是唯一入口。本页给出集成所需的全部契约：调用、退出码、
> 结构化输出、输入输出样例、版本兼容。

## 退出码（稳定承诺）

| 码 | 含义 | 场景 |
|:--|:--|:--|
| 0 | 成功 | 含 `--dry-run` 通过 |
| 1 | 未分类失败 | 子命令内部异常（诊断见 stderr） |
| 2 | 输入/契约违规 | perf 契约校验失败、未知子命令、参数错误 |
| 3 | 环境缺失 | 缺 Node/FFmpeg、契约文件缺失、输入不可读 |

## stdout / stderr 分离

- `--json` 时 **stdout 只有一行 JSON**（机器可读），全部诊断信息走 stderr；
- 无 `--json` 时 stdout 是人类可读进度，脚本集成一律加 `--json`。

## 样例

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

## 输入格式

perf JSON 契约见 `packages/anchor-core/schema/perf-contract.json`（范围表 +
错误码枚举）。生成端推荐 `tools/say_perf.py`（stdin JSON → stdout perf，
参数：`text / pinyin / sps / seed / motion / style`），产物已过契约。

## 路径基准

- 相对路径按**调用者当前目录**解析（`--props` / `-o` 同规则）；
- 从仓库外目录调用受支持（`tools/cli_check.py` 场景 4 常驻验证）；
- 角色数据定位不依赖 cwd（脚本内以自身位置为锚）。

## 版本兼容

- CLI 退出码与 `--json` 字段（`ok/out/frames/duration/dryRun`）自 2026-11-03 起为稳定承诺；
  新增字段不破坏兼容，删除/改名需升主版本并在 CHANGELOG 声明。
- perf 契约版本 `schemaVersion=1`；更高版本 perf 会被当前工具拒绝（前向不兼容，
  显式报错而非静默解析）。
