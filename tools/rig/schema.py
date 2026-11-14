"""Rig 语义标注的 schema、结构化校验与数字量具（P1 建角闭环，2026-11-14）。

为什么要有这一层：`tools/trace_design.py` 的 `PRESETS` 是硬编码 Python 字典，
换角色要人手量五区再改源码；`tools/zone_auto.py` 里还抄了一份副本。
本模块把「人工标注」变成一等公民的工程对象：

    examples/rig/<id>.rig.json   ← 可 git diff、可复核、可被 Agent 读写
              ↓ validate_rig()   ← 带 JSON path + 稳定 code + fix hint
              ↓ trace_design.py  ← 几何管线原样复用，不另写渲染器
              ↓ char.json + pose-sheet.html（写即返图）+ report.json（数字量具）

刻意**不承诺自动建角**：zone_auto 对本项目两张真实设定稿都配不出 2 对眉眼
（深色五官与侧发同色相连）。P1 解决的是「标注可编辑、可校验、可目检、可回放」，
不是「不用人标」。这一点在 CODE-AS-WORLD.md §9 已写明。
"""
from __future__ import annotations

import os
import re
from typing import Any

ZONE_KEYS = ("mouth", "browL", "browR", "eyeL", "eyeR")
BUILD_KEYS = {
    "noiseFlatten": bool,
    "mergeTol": int,
    "featureMergeTol": (int, float),
    "eyeCarve": bool,
}
TOP_KEYS = {"version", "id", "name", "source", "canvas", "zones", "build", "notes"}
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _err(errors: list, path: str, code: str, message: str, fix: str) -> None:
    errors.append({"path": path, "code": code, "message": message, "fix": fix})


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _metrics(zones: dict, canvas: list) -> dict:
    """给 Agent / 人看的数字量具：不用看像素也能判断分区是否离谱。"""
    W, H = canvas
    # 坏 rig 也要能走完校验并返回结构化错误，不能让校验器自己抛异常：
    # Agent 需要的是 [{path,code,fix}]，不是 traceback（selftest 的 E005 注入暴露）。
    W = W or 1
    H = H or 1
    out = {}
    for k in ZONE_KEYS:
        x0, y0, x1, y1 = zones[k]
        out[k] = {
            "box": [x0, y0, x1, y1],
            "w": x1 - x0, "h": y1 - y0,
            "cx": round((x0 + x1) / 2, 1), "cy": round((y0 + y1) / 2, 1),
            "wRatio": round((x1 - x0) / W, 4), "hRatio": round((y1 - y0) / H, 4),
        }
    out["eyeSpan"] = round(out["eyeR"]["cx"] - out["eyeL"]["cx"], 1)
    out["browSpan"] = round(out["browR"]["cx"] - out["browL"]["cx"], 1)
    out["eyeToMouth"] = round(out["mouth"]["cy"] - max(out["eyeL"]["cy"], out["eyeR"]["cy"]), 1)
    out["mouthOverEyeSpan"] = round(out["mouth"]["w"] / max(1, out["eyeSpan"]), 3)
    return out


def validate_rig(rig: Any, base_dir: str) -> dict:
    """返回 {ok, errors:[{path,code,message,fix}], metrics}。
    所有错误一次性收齐（不是遇到第一个就抛），Agent 可以一轮改完。"""
    errors: list = []
    if not isinstance(rig, dict):
        _err(errors, "$", "E001", "rig 必须是 JSON 对象", "写成 {\"version\":1, ...}")
        return {"ok": False, "errors": errors, "metrics": {}}

    # E002 版本
    if rig.get("version") != 1:
        _err(errors, "$.version", "E002", "version 必须为 1", "改成 1；新 schema 请升版本号并同步本文件")

    # E003 id
    rid = rig.get("id")
    if not isinstance(rid, str) or not ID_RE.match(rid):
        _err(errors, "$.id", "E003", "id 缺失或不是合法角色 key（字母开头，仅字母/数字/下划线）",
             "例如 \"no4\"；它会写进角色资产的 key 字段，不能含路径或空格")

    # E004 顶层未知字段（防拼写错静默生效）
    for k in rig:
        if k not in TOP_KEYS:
            _err(errors, f"$.{k}", "E004", f"未知顶层字段 {k}",
                 f"可用字段：{', '.join(sorted(TOP_KEYS))}；删除或改名")

    # E005 canvas
    canvas = rig.get("canvas")
    if (not isinstance(canvas, list) or len(canvas) != 2
            or not all(_is_num(v) and v > 0 for v in canvas)):
        _err(errors, "$.canvas", "E005", "canvas 必须是 [正宽, 正高]",
             "例如 [1360, 2048]；必须等于设定稿像素尺寸")
        canvas = [0, 0]

    # E006 source
    src = rig.get("source")
    src_ok = False
    if not isinstance(src, str) or not src:
        _err(errors, "$.source", "E006", "source 缺失（设定稿路径，相对仓库根）",
             "填入如 examples/gen-female/female-v1.png")
    else:
        p = src if os.path.isabs(src) else os.path.join(base_dir, src)
        if not os.path.isfile(p):
            _err(errors, "$.source", "E006", f"设定稿不存在：{src}", "改成仓库内存在的 PNG 路径")
        else:
            src_ok = True
            # E007 源图尺寸与 canvas 不符
            try:
                from PIL import Image
                with Image.open(p) as im:
                    if list(im.size) != [int(canvas[0]), int(canvas[1])]:
                        _err(errors, "$.canvas", "E007",
                             f"canvas {canvas[:2]} 与设定稿实际尺寸 {list(im.size)} 不符",
                             "把 canvas 改成设定稿真实像素尺寸；zone 坐标是按该尺寸量的")
            except Exception as exc:  # pragma: no cover - PIL 读取异常
                _err(errors, "$.source", "E006", f"设定稿无法读取：{exc}", "换成有效 PNG")

    # zones
    zones = rig.get("zones")
    if not isinstance(zones, dict):
        _err(errors, "$.zones", "E008", "zones 必须是对象",
             f"必须且只能包含 {', '.join(ZONE_KEYS)} 五个框")
        return {"ok": False, "errors": errors, "metrics": {}}

    for k in ZONE_KEYS:
        if k not in zones:
            _err(errors, f"$.zones.{k}", "E009", f"缺少分区 {k}", f"补上 {k}: [x0,y0,x1,y1]")
    for k in zones:
        if k not in ZONE_KEYS:
            _err(errors, f"$.zones.{k}", "E010", f"未知分区 {k}",
                 f"只能是 {', '.join(ZONE_KEYS)}；多余分区不会参与判角色")

    parsed = {}
    for k in ZONE_KEYS:
        z = zones.get(k)
        path = f"$.zones.{k}"
        if not isinstance(z, list) or len(z) != 4 or not all(_is_num(v) for v in z):
            _err(errors, path, "E011", "分区必须是 4 个数字 [x0,y0,x1,y1]",
                 "坐标为设定稿像素，左上角原点；顺序不可颠倒")
            continue
        x0, y0, x1, y1 = [float(v) for v in z]
        if x1 <= x0 or y1 <= y0:
            _err(errors, path, "E012", f"分区顺序颠倒或零面积：{z}",
                 "必须 x1 > x0 且 y1 > y0")
            continue
        if x0 < 0 or y0 < 0 or x1 > canvas[0] or y1 > canvas[1]:
            _err(errors, path, "E013", f"分区越出画布 {canvas[:2]}：{z}",
                 "把框收回设定稿范围内")
        if (x1 - x0) < 20 or (y1 - y0) < 15:
            _err(errors, path, "E014", f"分区过小（{(x1-x0):.0f}x{(y1-y0):.0f}），框不住五官",
                 "zone 应比五官松一圈；过小会让轮廓 bbox 完整落在框外的判据永远不命中")
        parsed[k] = (x0, y0, x1, y1)

    metrics = _metrics(parsed, canvas) if len(parsed) == len(ZONE_KEYS) else {}

    if len(parsed) == len(ZONE_KEYS):
        # E015 左右顺序
        for a, b, label in (("browL", "browR", "眉"), ("eyeL", "eyeR", "眼")):
            if parsed[a][2] > parsed[b][0]:
                _err(errors, f"$.zones.{a}/{b}", "E015",
                     f"左右{label}区重叠或颠倒（{a}.x1={parsed[a][2]:.0f} > {b}.x0={parsed[b][0]:.0f}）",
                     "L 在左、R 在右，两框不应交叠")
        # E016 垂直序：嘴必须在眼之下
        if parsed["mouth"][1] < max(parsed["eyeL"][3], parsed["eyeR"][3]):
            _err(errors, "$.zones.mouth", "E016", "嘴区跑到眼区上方或与之交叠",
                 "嘴区 y0 应大于两眼区 y1；y 轴向下")
        # E017 眉必须在眼之上
        if max(parsed["browL"][3], parsed["browR"][3]) > min(parsed["eyeL"][1], parsed["eyeR"][1]):
            _err(errors, "$.zones.browL/browR", "E017", "眉区跑到眼区下方或与之交叠",
                 "眉区 y1 应小于两眼区 y0")

    # build 开关
    build = rig.get("build", {})
    if not isinstance(build, dict):
        _err(errors, "$.build", "E018", "build 必须是对象", "留空 {} 表示全部沿用默认开关")
    else:
        for k, v in build.items():
            if k not in BUILD_KEYS:
                _err(errors, f"$.build.{k}", "E019", f"未知 build 开关 {k}",
                     f"可用：{', '.join(sorted(BUILD_KEYS))}")
                continue
            want = BUILD_KEYS[k]
            if want is bool:
                ok = isinstance(v, bool)
            elif want is int:
                ok = isinstance(v, int) and not isinstance(v, bool) and v > 0
            else:
                ok = _is_num(v) and v > 0
            if not ok:
                _err(errors, f"$.build.{k}", "E020",
                     f"build.{k} 值类型不对：{v!r}",
                     f"期望 {'布尔' if want is bool else '正数'}，例如 {True if want is bool else 12}")

    return {"ok": len(errors) == 0, "errors": errors, "metrics": metrics, "sourceExists": src_ok}


def format_errors(errors: list) -> str:
    return "\n".join(
        f"  [{e['code']}] {e['path']}: {e['message']}\n        修法：{e['fix']}"
        for e in errors
    )
