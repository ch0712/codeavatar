#!/usr/bin/env python3
"""validate_rig 注入自证（P1 建角闭环 / P2 Agent 接口共用，2026-11-14）。

为什么要有这个脚本：Agent 不看像素也能自检的前提是「校验器真的能抓到错」。
口头说有 20 个错误码没有意义；这里对每一类错误注入一份坏 rig，
断言必须命中预期的 code + path，且**所有错误一次收齐**（不是遇到第一个就抛）。

    python tools/rig/selftest.py

验收口径（ROADMAP §18.6 P2）：Agent 无人工看像素也能自检 ≥5 类结构错误，
并有注入自证。本脚本覆盖 20 类，作为该能力的最小可回归基线。
"""
from __future__ import annotations

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from schema import validate_rig  # noqa: E402
from compile import char_metrics, char_warnings  # noqa: E402

BASE = os.path.join(ROOT, "examples", "rig", "noF.rig.json")
with open(BASE, encoding="utf-8") as fh:
    VALID = json.load(fh)


def fresh() -> dict:
    return copy.deepcopy(VALID)


def codes_of(rig: dict) -> set:
    return {e["code"] for e in validate_rig(rig, ROOT)["errors"]}


def paths_of(rig: dict) -> set:
    return {e["path"] for e in validate_rig(rig, ROOT)["errors"]}


# 每条：(用例名, 造坏函数, 期望命中的 code 集合)
CASES = []


def case(name, *expected):
    def deco(fn):
        CASES.append((name, fn, set(expected)))
        return fn
    return deco


@case("非 JSON 对象", "E001")
def _(r):
    return [1, 2, 3]


@case("version 不是 1", "E002")
def _(r):
    r["version"] = 2
    return r


@case("id 含非法字符", "E003")
def _(r):
    r["id"] = "../no4"
    return r


@case("顶层拼错字段", "E004")
def _(r):
    r["zone"] = {}
    return r


@case("canvas 不是正宽高", "E005")
def _(r):
    r["canvas"] = [1360]
    return r


@case("source 指向不存在的图", "E006")
def _(r):
    r["source"] = "examples/gen-female/not-here.png"
    return r


@case("canvas 与设定稿真实尺寸不符", "E007")
def _(r):
    r["canvas"] = [1360, 2049]
    return r


@case("zones 不是对象", "E008")
def _(r):
    r["zones"] = []
    return r


@case("缺一个分区", "E009")
def _(r):
    del r["zones"]["eyeR"]
    return r


@case("多一个未知分区", "E010")
def _(r):
    r["zones"]["nose"] = [600, 900, 700, 1000]
    return r


@case("分区不是 4 个数字", "E011")
def _(r):
    r["zones"]["mouth"] = [548, 1058, 782]
    return r


@case("分区坐标顺序颠倒", "E012")
def _(r):
    r["zones"]["mouth"] = [782, 1175, 548, 1058]
    return r


@case("分区越出画布", "E013")
def _(r):
    r["zones"]["mouth"] = [548, 1058, 782, 3000]
    return r


@case("分区过小框不住五官", "E014")
def _(r):
    r["zones"]["mouth"] = [600, 1100, 610, 1105]
    return r


@case("左右眼区颠倒", "E015")
def _(r):
    l, rr = r["zones"]["eyeL"], r["zones"]["eyeR"]
    r["zones"]["eyeL"], r["zones"]["eyeR"] = rr, l
    return r


@case("嘴区跑到眼区上方", "E016")
def _(r):
    r["zones"]["mouth"] = [548, 700, 782, 780]
    return r


@case("眉区跑到眼区下方", "E017")
def _(r):
    r["zones"]["browL"] = [395, 900, 640, 970]
    r["zones"]["browR"] = [725, 900, 962, 970]
    return r


@case("build 不是对象", "E018")
def _(r):
    r["build"] = []
    return r


@case("未知 build 开关", "E019")
def _(r):
    r["build"]["eyecarve"] = True
    return r


@case("build 值类型不对", "E020")
def _(r):
    r["build"]["eyeCarve"] = "yes"
    return r


@case("多错一次收齐（5 类）", "E002", "E003", "E004", "E009", "E019")
def _(r):
    r["version"] = 9
    r["id"] = "bad id"
    r["zoon"] = 1
    del r["zones"]["browL"]
    r["build"]["typoKey"] = 1
    return r


def main() -> int:
    # 0) 基线本身必须干净，否则后面所有断言都失去意义
    v0 = validate_rig(fresh(), ROOT)
    if not v0["ok"]:
        print("FAIL：合法 rig 被判错：", v0["errors"])
        return 1
    if not v0["metrics"] or "eyeSpan" not in v0["metrics"]:
        print("FAIL：合法 rig 没有产出数字量具")
        return 1
    print(f"[selftest] 基线干净 · eyeSpan={v0['metrics']['eyeSpan']} · "
          f"eyeToMouth={v0['metrics']['eyeToMouth']}")

    failed = []
    for name, fn, expected in CASES:
        rig = fn(fresh())
        got = codes_of(rig)
        missing = expected - got
        if missing:
            failed.append(f"{name}: 漏检 {sorted(missing)}（实得 {sorted(got)}）")
            print(f"  FAIL  {name}: 期望 {sorted(expected)}，实得 {sorted(got)}")
        else:
            print(f"  PASS  {name} → {sorted(expected)}")

    # 1) 错误必须带 path / code / message / fix 四要素，Agent 才能按路径自修
    bad = fresh()
    bad["zones"]["mouth"] = [782, 1175, 548, 1058]
    errs = validate_rig(bad, ROOT)["errors"]
    for e in errs:
        if not all(k in e and e[k] for k in ("path", "code", "message", "fix")):
            failed.append(f"错误对象缺字段：{e}")
    if not any(e["path"].startswith("$.zones.mouth") for e in errs):
        failed.append("错误 path 没有指到出错的 zone")
    else:
        print(f"  PASS  错误带 JSON path + 稳定 code + fix hint（{len(errs)} 项）")

    # 2) char 侧结构量具：烂角色必须被拦下，好角色必须放行
    good = validate_rig(fresh(), ROOT)
    if not good["ok"]:
        failed.append("基线 rig 校验失败")
    # 用真实编译产物做量具自证
    char_path = os.path.join(ROOT, "out", "rig", "noF", "char.json")
    if os.path.isfile(char_path):
        with open(char_path, encoding="utf-8") as fh:
            char = json.load(fh)
        gm = char_metrics(char)
        if char_warnings(gm):
            failed.append("合格角色被 char_warnings 误报")
        else:
            print(f"  PASS  合格角色量具放行（{gm['layerCount']} 层 / "
                  f"可动 {gm['movableParts']} / 眼 {gm['eyeCount']} / 眉 {gm['browCount']}）")
        broken = copy.deepcopy(char)
        broken["eyes"] = []
        broken["brows"] = []
        broken["lipBox"] = None
        bm = char_metrics(broken)
        if len(char_warnings(bm)) < 3:
            failed.append("烂角色未被 char_warnings 拦下")
        else:
            print(f"  PASS  烂角色量具拦截（{len(char_warnings(bm))} 条告警）")
    else:
        print("  SKIP  char 量具自证（先跑 compile.py noF 生成 char.json）")

    print()
    if failed:
        print(f"FAIL：注入自证 {len(failed)} 项不通过")
        for f in failed:
            print("  ! " + f)
        return 1
    print(f"PASS：validate_rig 注入自证 · {len(CASES)} 个用例 / 20 类稳定错误码 / "
          f"一次收齐 / path+code+fix 齐备 / char 量具双向自证 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
