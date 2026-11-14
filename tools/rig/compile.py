#!/usr/bin/env python3
"""Rig 编译器（P1 建角闭环，2026-11-14；P2 重构为 library + CLI）。

    python tools/rig/compile.py examples/rig/noF.rig.json
    python tools/rig/compile.py examples/rig/noF.rig.json --check
    python tools/rig/compile.py examples/rig/noF.rig.json --verify-golden

链路：validate_rig（结构化错误）→ trace_design.py（几何管线原样复用）
      → char.json + report.json（数字量具）+ pose-sheet.html（写即返图）
      → golden.json（逐字节基线）

硬纪律：
  · rig 是**唯一事实源**：调用子进程时清掉 FOLK_* / MERGE_TOL 环境变量，
    避免「本地环境变量不同 → 同一份 rig 编出不同角色」。
  · 编译产物不自动写进 packages/anchor-core/src/chars/：入库是显式决定，
    避免一次草稿编译污染已验收的角色资产（E3-050 的教训）。
  · 结构量具不达标即非零退出：宁可让 Agent 拿到一条带路径的错误，
    也不静默产出一个「看着成功」的烂脸（E3-053）。
  · 不合格产物不写 golden：否则一次草稿会把烂脸固化成基线。

`compile_rig()` 是纯函数式入口（不打印、返回 dict），供 `agent.py` 复用；
`main()` 只负责把 dict 格式化成人读输出并映射稳定退出码。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from schema import validate_rig, format_errors  # noqa: E402

TOOL_VERSION = "rig-compile/1.1"
ENV_OVERRIDES = ("FOLK_NOISE_FLATTEN", "FOLK_MERGE_TOL", "FOLK_EYE_CARVE", "MERGE_TOL")

# 稳定退出码（沿用 tools/cli_check.py 的 CLI 契约）
EXIT_OK = 0
EXIT_INVALID = 2      # 输入（rig / 结构量具）不合格 → Agent 可据此自修
EXIT_ENV = 3          # 工具链 / 环境 / golden 漂移 → 不是改 rig 能修的


def sha_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha_file(path: str) -> str:
    with open(path, "rb") as fh:
        return sha_bytes(fh.read())


def char_metrics(char: dict) -> dict:
    layers = char.get("layers", [])
    roles = Counter((l.get("role") or "static") for l in layers)
    return {
        "canvas": char.get("canvas"),
        "layerCount": len(layers),
        "roleCounts": dict(roles),
        "movableParts": sum(v for k, v in roles.items() if k != "static"),
        "eyeCount": len(char.get("eyes", [])),
        "browCount": len(char.get("brows", [])),
        "lipBox": char.get("lipBox"),
        "lipColor": char.get("lipColor"),
        "mouthModel": char.get("mouth", "thinLips"),
        "key": char.get("key"),
    }


def char_warnings(m: dict) -> list:
    """Agent 不用看像素也能自检的结构问题（P2 复用这组量具）。"""
    out = []
    if m["eyeCount"] != 2:
        out.append(f"eyes 应为 2，实得 {m['eyeCount']}：眼区框没框住两只眼")
    if m["browCount"] < 2:
        out.append(f"brows 少于 2（实得 {m['browCount']}）：眉区框位置不对")
    if not m["lipBox"] or not m["lipColor"]:
        out.append("没检出 lipBox/lipColor：嘴区框位置不对")
    if m["movableParts"] < 4:
        out.append(f"可动部件仅 {m['movableParts']} 条（<4）：分区几乎没命中五官")
    if m["layerCount"] < 10:
        out.append(f"轮廓仅 {m['layerCount']} 层（<10）：设定稿可能被色噪净化吃掉了")
    return out


def _fail(stage: str, message: str, *, exit_code: int = EXIT_INVALID, **extra) -> dict:
    out = {"ok": False, "stage": stage, "exitCode": exit_code, "message": message}
    out.update(extra)
    return out


def compile_rig(rig_arg: str, *, check_only: bool = False, no_preview: bool = False,
                verify_golden: bool = False, outdir: str | None = None) -> dict:
    """编译一份 .rig.json，返回结构化结果（不打印，供 CLI 与 Agent 共用）。

    result 恒含 ok / stage / exitCode；成功时另含 id / metrics / charMetrics /
    warnings / artifacts / golden；失败时含 message，校验失败另含 errors（带 path+code+fix）。
    """
    rig_path = rig_arg if os.path.isabs(rig_arg) else os.path.join(ROOT, rig_arg)
    if not os.path.isfile(rig_path):
        return _fail("read", f"标注文件不存在 {rig_arg}", exit_code=EXIT_ENV)
    raw = open(rig_path, "rb").read()
    try:
        rig = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return _fail("parse", f"rig 不是合法 JSON：{exc}")

    v = validate_rig(rig, ROOT)
    if not v["ok"]:
        return _fail("validate", f"rig 结构校验失败（{len(v['errors'])} 项）",
                     errors=v["errors"], errorText=format_errors(v["errors"]),
                     metrics=v["metrics"])
    rid = rig["id"]
    base = {
        "ok": True, "stage": "done", "exitCode": EXIT_OK,
        "id": rid, "rig": rig_arg, "metrics": v["metrics"],
    }
    if check_only:
        return {**base, "stage": "checked", "artifacts": {},
                "message": "只校验模式（未编译）"}

    out_dir = outdir or os.path.join(ROOT, "out", "rig", rid)
    os.makedirs(out_dir, exist_ok=True)
    char_path = os.path.join(out_dir, "char.json")

    # rig 是唯一事实源：清掉会覆盖它的环境变量。
    env = {k: val for k, val in os.environ.items() if k not in ENV_OVERRIDES}
    cmd = [sys.executable, "tools/trace_design.py", rig_arg, rig["source"], char_path]
    proc = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        return _fail("geometry", "几何编译失败", exit_code=EXIT_ENV,
                     stdout=proc.stdout[-2000:], stderr=proc.stderr[-2000:])
    if not os.path.isfile(char_path):
        return _fail("geometry", "几何编译未产出 char.json", exit_code=EXIT_ENV)

    char = json.load(open(char_path, encoding="utf-8"))
    cm = char_metrics(char)
    warns = char_warnings(cm)
    src_abs = rig["source"] if os.path.isabs(rig["source"]) else os.path.join(ROOT, rig["source"])

    report = {
        "tool": TOOL_VERSION,
        "id": rid,
        "rig": rig_arg,
        "rigSha256": sha_bytes(raw),
        "source": rig["source"],
        "sourceSha256": sha_file(src_abs),
        "charSha256": sha_file(char_path),
        "build": rig.get("build", {}),
        "zoneMetrics": v["metrics"],
        "charMetrics": cm,
        "warnings": warns,
    }
    report_path = os.path.join(out_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    golden_path = os.path.join(out_dir, "golden.json")
    golden_info = {"path": golden_path, "written": False, "verified": False}
    if verify_golden:
        if not os.path.isfile(golden_path):
            return _fail("golden", f"没有 golden 基线 {golden_path}", exit_code=EXIT_ENV)
        old = json.load(open(golden_path, encoding="utf-8"))
        if old.get("charSha256") != report["charSha256"]:
            return _fail("golden", "golden 漂移", exit_code=EXIT_ENV,
                         expected=old.get("charSha256"), actual=report["charSha256"])
        golden_info["verified"] = True
    elif warns:
        # 不合格角色绝不落基线：否则一次草稿编译会污染 golden，
        # 之后 --verify-golden 会把「烂脸」当成正确结果放行（E3-053 同型）。
        golden_info["skipped"] = "结构量具未达标，不把烂脸固化成基线"
    else:
        with open(golden_path, "w", encoding="utf-8") as fh:
            json.dump({"id": rid, "rigSha256": report["rigSha256"],
                       "sourceSha256": report["sourceSha256"],
                       "charSha256": report["charSha256"]}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        golden_info["written"] = True

    artifacts = {
        "char": char_path, "report": report_path,
        "golden": golden_path if os.path.isfile(golden_path) else None,
        "preview": None,
    }
    preview_msg = ""
    if not no_preview:
        pv_out = os.path.join(out_dir, "pose-sheet.html")
        pv = subprocess.run(
            ["node", "tools/rig/preview.mjs", "--rig", rig_arg,
             "--char", char_path, "--out", pv_out],
            cwd=ROOT, capture_output=True, text=True,
        )
        if pv.returncode != 0:
            return _fail("preview", "写即返图失败", exit_code=EXIT_ENV,
                         stdout=pv.stdout[-2000:], stderr=pv.stderr[-2000:],
                         artifacts=artifacts)
        artifacts["preview"] = pv_out
        preview_msg = pv.stdout.strip()

    result = {
        **base,
        "charMetrics": cm,
        "warnings": warns,
        "rigSha256": report["rigSha256"],
        "charSha256": report["charSha256"],
        "artifacts": artifacts,
        "golden": golden_info,
        "previewMessage": preview_msg,
    }
    if warns:
        result.update({
            "ok": False, "stage": "metrics", "exitCode": EXIT_INVALID,
            "message": "结构量具未达标，不静默交付角色",
            "next": "打开 pose-sheet.html 看 zone 框，按 errors 无（属量具告警）微调 zones 后重编译",
        })
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="把 .rig.json 编译成角色 JSON + 目检图 + 量具报告")
    ap.add_argument("rig", help="语义标注 JSON 路径（相对仓库根或绝对）")
    ap.add_argument("--out", default=None, help="输出目录，默认 out/rig/<id>")
    ap.add_argument("--check", action="store_true", help="只做结构校验并打印数字量具，不编译")
    ap.add_argument("--no-preview", action="store_true", help="跳过写即返图（pose-sheet.html）")
    ap.add_argument("--verify-golden", action="store_true", help="与已有 golden.json 比对，不覆盖")
    ap.add_argument("--json", dest="json_out", action="store_true", help="结构化 JSON 输出（Agent 用）")
    args = ap.parse_args()

    r = compile_rig(args.rig, check_only=args.check, no_preview=args.no_preview,
                    verify_golden=args.verify_golden, outdir=args.out)

    if args.json_out:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return r["exitCode"]

    # 人读输出（P1 既有格式保持不变）
    if r["stage"] in ("read", "parse"):
        print(f"FAIL：{r['message']}")
    elif r["stage"] == "validate":
        print(f"FAIL：{r['message']}")
        print(r["errorText"])
    elif r["stage"] in ("geometry", "preview"):
        print(f"FAIL：{r['message']}")
        print(r.get("stdout", "")[-2000:])
        print(r.get("stderr", "")[-2000:])
    elif r["stage"] == "golden":
        print(f"FAIL：{r['message']}")
        if "expected" in r:
            print(f"  基线 {r['expected']}\n  本次 {r['actual']}")
    else:
        print(f"[rig] 结构校验通过 · {r['id']} · 5 分区 · "
              f"{len(r['metrics']) - 4} 组分区量具 + 4 组派生量具")
        if r["stage"] == "checked":
            print("[rig] 分区数字量具：")
            print(json.dumps(r["metrics"], ensure_ascii=False, indent=2))
            print("PASS：只校验模式（未编译）")
            return EXIT_OK
        g = r["golden"]
        if g["verified"]:
            print("[rig] golden 逐字节一致 ✓")
        elif g.get("skipped"):
            print(f"[rig] {g['skipped']}")
        if r["previewMessage"]:
            print(r["previewMessage"])
        cm = r["charMetrics"]
        print(f"[rig] char.json  {cm['layerCount']} 层 / 可动部件 {cm['movableParts']} 条 / "
              f"眼 {cm['eyeCount']} / 眉 {cm['browCount']} / 嘴模型 {cm['mouthModel']}")
        if r["warnings"]:
            print("[rig] 结构量具告警（分区可能需要微调，见 pose-sheet.html 的 zone 框）：")
            for w in r["warnings"]:
                print("  ! " + w)
            print("FAIL：结构量具未达标，不静默交付角色")
            return EXIT_INVALID
        print(f"\nPASS：{r['id']} 编译完成 · 产物 {os.path.relpath(os.path.dirname(r['artifacts']['char']), ROOT)} · 未写入 chars/")
    return r["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
