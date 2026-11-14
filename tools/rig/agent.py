#!/usr/bin/env python3
"""Agent 接口（P2，2026-11-14）：写即返图 + 结构化错误 + 数字量具 + note 指错 + diff。

设计立场（talekit / TopoTopo / Rev2D 的共同结论）：
Agent 不该靠「看像素」判断自己写得对不对。每次写都应返回
**结构化、可 diff、可无头验证**的工程对象：

    inspect  只校验 → {errors:[{path,code,message,fix}], metrics}
    write    写 → 编译 → 返图 → {charSha256, artifacts, warnings}
    fix      按 errors 的 path/code 做机械修复（证明结构化错误可执行）
    note     人在画面上指错 → add/list/resolve，闭环可复现
    diff     两个版本 → 分区数值差 + 编译产物 sha + 并排视觉后果

所有子命令 stdout 恒为 JSON（机器读），人读日志走 stderr。
稳定退出码：0 成功 / 2 输入不合格（Agent 可自修）/ 3 工具链或环境错误。

    python tools/rig/agent.py inspect examples/rig/noF.rig.json
    python tools/rig/agent.py write examples/rig/noF.rig.json
    python tools/rig/agent.py fix broken.rig.json --out fixed.rig.json
    python tools/rig/agent.py note add examples/rig/noF.rig.json --zone eyeL --text "框偏左"
    python tools/rig/agent.py diff a.rig.json b.rig.json
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from compile import (  # noqa: E402
    compile_rig, EXIT_OK, EXIT_INVALID, EXIT_ENV, sha_bytes,
)
from schema import validate_rig, ZONE_KEYS, BUILD_KEYS, TOP_KEYS, _is_num  # noqa: E402

AGENT_VERSION = "rig-agent/1.0"


def out(obj: dict, exit_code: int | None = None) -> int:
    """唯一 stdout 出口：恒为 JSON。"""
    obj.setdefault("agent", AGENT_VERSION)
    code = obj.get("exitCode", EXIT_OK) if exit_code is None else exit_code
    obj["exitCode"] = code
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_rig(path: str) -> tuple[dict | None, str]:
    p = path if os.path.isabs(path) else os.path.join(ROOT, path)
    if not os.path.isfile(p):
        return None, f"文件不存在：{path}"
    try:
        return json.load(open(p, encoding="utf-8")), ""
    except Exception as exc:
        return None, f"JSON 解析失败：{exc}"


def notes_path(rig: dict) -> str:
    return os.path.join(ROOT, "out", "rig", rig["id"], "notes.json")


def load_notes(rig: dict) -> list:
    p = notes_path(rig)
    if not os.path.isfile(p):
        return []
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return []


def save_notes(rig: dict, notes: list) -> str:
    p = notes_path(rig)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(notes, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return p


# ── inspect ────────────────────────────────────────────────────────────────

def cmd_inspect(a) -> int:
    rig, err = read_rig(a.rig)
    if rig is None:
        return out({"ok": False, "command": "inspect", "message": err}, EXIT_ENV)
    v = validate_rig(rig, ROOT)
    return out({
        "ok": v["ok"], "command": "inspect", "exitCode": EXIT_OK if v["ok"] else EXIT_INVALID,
        "rig": a.rig, "id": rig.get("id"),
        "errors": v["errors"], "metrics": v["metrics"],
        "summary": {
            "errorCount": len(v["errors"]),
            "codes": sorted({e["code"] for e in v["errors"]}),
            "selfCheckableWithoutPixels": len(v["errors"]) > 0,
        },
        "next": "按 errors[].path + fix 修，然后 write" if not v["ok"] else "可 write 编译并返图",
    })


# ── write ──────────────────────────────────────────────────────────────────

def cmd_write(a) -> int:
    rig_arg = a.rig
    if a.stdin:
        raw = sys.stdin.buffer.read()
        p = rig_arg if os.path.isabs(rig_arg) else os.path.join(ROOT, rig_arg)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(raw)
        log(f"[agent] 已写入 {rig_arg}（{len(raw)} bytes）")
    r = compile_rig(rig_arg, no_preview=a.no_preview, verify_golden=a.verify_golden,
                    outdir=a.out)
    return out({**r, "command": "write"})


# ── fix：按结构化错误机械修复（证明 errors 可执行，不需看像素）────────────

def _get_path(obj, parts):
    cur = obj
    for p in parts:
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        else:
            return None, False
    return cur, True


def _del_path(obj, parts):
    cur = obj
    for p in parts[:-1]:
        if not isinstance(cur, dict) or p not in cur:
            return False
        cur = cur[p]
    if isinstance(cur, dict) and parts[-1] in cur:
        del cur[parts[-1]]
        return True
    return False


def _set_path(obj, parts, value):
    cur = obj
    for p in parts[:-1]:
        if not isinstance(cur, dict) or p not in cur:
            return False
        cur = cur[p]
    if isinstance(cur, dict):
        cur[parts[-1]] = value
        return True
    return False


# 每类可机械修复的错误 → (适用条件, 操作)。不可机械修复的（如 E009 缺分区）
# 保留在 unresolved 里，如实告诉 Agent「这一步需要人/Agent 在图上量」。
FIXABLE = {"E002", "E004", "E012", "E019", "E020"}


def apply_fixes(rig: dict, errors: list) -> tuple[dict, list, list]:
    fixed, unresolved = [], []
    obj = copy.deepcopy(rig)
    for e in errors:
        code, path = e["code"], e["path"]
        # validate_rig 的 path 用 JSON 点号路径（$.zones.mouth / $.build.eyeCarve）；
        # 只有「左右顺序」类错误才是复合路径 $.zones.eyeL/eyeR（不可机械修复）。
        # 早期版本按 "/" 切分，导致 5 类错误里只有 2 类落得到字段上 —— agent_check.py 抓到。
        parts = [p for p in path.lstrip("$.").split(".") if p]
        if code not in FIXABLE or not parts or any("/" in p for p in parts):
            unresolved.append({"code": code, "path": path, "reason": "需人工在图上判断，不能凭规则猜"})
            continue
        done = False
        if code == "E002":
            done = _set_path(obj, ["version"], 1)
        elif code == "E004":
            done = _del_path(obj, [parts[0]])
        elif code == "E019":
            done = _del_path(obj, ["build", parts[-1]])
        elif code == "E020":
            key = parts[-1]
            want = BUILD_KEYS.get(key)
            cur, ok = _get_path(obj, ["build", key])
            if ok and want is bool:
                done = _set_path(obj, ["build", key],
                                 cur if isinstance(cur, bool) else str(cur).strip().lower() in ('1', 'true', 'yes'))
            elif ok and want is int:
                try:
                    done = _set_path(obj, ["build", key], int(cur))
                except (TypeError, ValueError):
                    done = _del_path(obj, ["build", key])
            elif ok:
                try:
                    done = _set_path(obj, ["build", key], float(cur))
                except (TypeError, ValueError):
                    done = _del_path(obj, ["build", key])
        elif code == "E012":
            cur, ok = _get_path(obj, parts)
            if ok and isinstance(cur, list) and len(cur) == 4:
                x0, y0, x1, y1 = cur
                done = _set_path(obj, parts, [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)])
        if done:
            fixed.append({"code": code, "path": path, "action": e["fix"]})
        else:
            unresolved.append({"code": code, "path": path, "reason": "规则未能落到具体字段"})
    return obj, fixed, unresolved


def cmd_fix(a) -> int:
    rig, err = read_rig(a.rig)
    if rig is None:
        return out({"ok": False, "command": "fix", "message": err}, EXIT_ENV)
    v = validate_rig(rig, ROOT)
    if v["ok"]:
        return out({"ok": True, "command": "fix", "fixed": [], "unresolved": [],
                    "message": "本来就是合法 rig，无需修复"})
    obj, fixed, unresolved = apply_fixes(rig, v["errors"])
    after = validate_rig(obj, ROOT)
    dest = a.out or a.rig
    p = dest if os.path.isabs(dest) else os.path.join(ROOT, dest)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return out({
        "ok": after["ok"], "command": "fix",
        "exitCode": EXIT_OK if after["ok"] else EXIT_INVALID,
        "written": dest, "fixed": fixed, "unresolved": unresolved,
        "before": {"errorCount": len(v["errors"]), "codes": sorted({e["code"] for e in v["errors"]})},
        "after": {"ok": after["ok"], "errorCount": len(after["errors"]),
                  "codes": sorted({e["code"] for e in after["errors"]})},
        "next": "write 编译返图" if after["ok"] else "剩余错误需人工在图上量，见 unresolved",
    })


# ── note：人在画面上指错，Agent 带图修，复验后闭环 ─────────────────────────

def cmd_note(a) -> int:
    rig, err = read_rig(a.rig)
    if rig is None:
        return out({"ok": False, "command": "note", "message": err}, EXIT_ENV)
    v = validate_rig(rig, ROOT)
    if not v["ok"]:
        return out({"ok": False, "command": "note", "message": "rig 不合法，先修好再指错",
                    "errors": v["errors"]}, EXIT_INVALID)
    notes = load_notes(rig)

    if a.action == "add":
        if a.zone not in ZONE_KEYS:
            return out({"ok": False, "command": "note.add",
                        "message": f"zone 必须是 {list(ZONE_KEYS)} 之一"}, EXIT_INVALID)
        at = None
        if a.at:
            try:
                at = [float(x) for x in a.at.split(",")]
                if len(at) != 2:
                    raise ValueError
            except ValueError:
                return out({"ok": False, "command": "note.add",
                            "message": "--at 需为 x,y 两个数字"}, EXIT_INVALID)
        raw = open(a.rig if os.path.isabs(a.rig) else os.path.join(ROOT, a.rig), "rb").read()
        nid = f"n{len(notes) + 1:03d}"
        rec = {
            "id": nid, "status": "open",
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "by": a.by or "human", "zone": a.zone, "at": at, "text": a.text,
            "rigSha256": sha_bytes(raw),
            "preview": f"out/rig/{rig['id']}/pose-sheet.html",
        }
        notes.append(rec)
        save_notes(rig, notes)
        return out({"ok": True, "command": "note.add", "note": rec,
                    "openCount": sum(n["status"] == "open" for n in notes),
                    "next": "Agent 读 note → 改 .rig.json → write → note resolve"})

    if a.action == "list":
        sel = notes if a.all else [n for n in notes if n["status"] == "open"]
        return out({"ok": True, "command": "note.list", "id": rig["id"],
                    "notes": sel, "openCount": sum(n["status"] == "open" for n in notes),
                    "total": len(notes)})

    if a.action == "resolve":
        hit = next((n for n in notes if n["id"] == a.id), None)
        if hit is None:
            return out({"ok": False, "command": "note.resolve",
                        "message": f"没有 note {a.id}"}, EXIT_INVALID)
        if hit["status"] == "resolved":
            return out({"ok": True, "command": "note.resolve", "note": hit,
                        "message": "已处于 resolved"})
        # 闭环硬约束：rig 没变就 resolve 等于「没修就勾掉」，必须拦下。
        raw = open(a.rig if os.path.isabs(a.rig) else os.path.join(ROOT, a.rig), "rb").read()
        if sha_bytes(raw) == hit["rigSha256"] and not a.force:
            return out({"ok": False, "command": "note.resolve",
                        "exitCode": EXIT_INVALID,
                        "message": "rig 内容未变化：不能没修就把指错勾掉",
                        "hint": "先改 .rig.json 并 write 复验；确属误报可加 --force",
                        "note": hit}, EXIT_INVALID)
        hit["status"] = "resolved"
        hit["resolvedBy"] = a.by or "agent"
        hit["resolvedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        save_notes(rig, notes)
        return out({"ok": True, "command": "note.resolve", "note": hit,
                    "openCount": sum(n["status"] == "open" for n in notes),
                    "next": "闭环完成：指错 → 修改 → 复验 → 归档"})

    return out({"ok": False, "command": "note", "message": "未知 action"}, EXIT_INVALID)


# ── diff：两个版本的分区数值差 + 编译产物 sha + 视觉后果 ───────────────────

def cmd_diff(a) -> int:
    ra, e1 = read_rig(a.a)
    rb, e2 = read_rig(a.b)
    if ra is None or rb is None:
        return out({"ok": False, "command": "diff", "message": e1 or e2}, EXIT_ENV)
    va, vb = validate_rig(ra, ROOT), validate_rig(rb, ROOT)
    if not va["ok"] or not vb["ok"]:
        return out({"ok": False, "command": "diff",
                    "message": "两份 rig 都必须合法才能比视觉后果",
                    "a": va["errors"], "b": vb["errors"]}, EXIT_INVALID)

    zone_deltas = {}
    for k in ZONE_KEYS:
        za, zb = ra["zones"][k], rb["zones"][k]
        zone_deltas[k] = {
            "a": za, "b": zb,
            "delta": [round(float(zb[i]) - float(za[i]), 2) for i in range(4)],
            "changed": za != zb,
        }
    metric_deltas = {
        k: {"a": va["metrics"][k], "b": vb["metrics"][k],
            "delta": round(vb["metrics"][k] - va["metrics"][k], 3)}
        for k in ("eyeSpan", "browSpan", "eyeToMouth", "mouthOverEyeSpan")
    }
    build_a, build_b = ra.get("build", {}), rb.get("build", {})
    build_deltas = {}
    for k in sorted(set(build_a) | set(build_b)):
        if build_a.get(k) != build_b.get(k):
            build_deltas[k] = {"a": build_a.get(k), "b": build_b.get(k)}

    result = {
        "ok": True, "command": "diff", "a": a.a, "b": a.b,
        "rigSha256": {"a": sha_bytes(open(a.a if os.path.isabs(a.a) else os.path.join(ROOT, a.a), 'rb').read()),
                      "b": sha_bytes(open(a.b if os.path.isabs(a.b) else os.path.join(ROOT, a.b), 'rb').read())},
        "zoneDeltas": zone_deltas,
        "changedZones": [k for k, d in zone_deltas.items() if d["changed"]],
        "metricDeltas": metric_deltas, "buildDeltas": build_deltas,
        "source": {"a": ra.get("source"), "b": rb.get("source")},
    }

    if not a.no_preview:
        # 两版各编译到独立目录（互不覆盖 golden / notes），出并排视觉后果页
        base = os.path.join(ROOT, "out", "rig", "_diff")
        da, db = os.path.join(base, "a"), os.path.join(base, "b")
        ca, cb = compile_rig(a.a, outdir=da, no_preview=True), compile_rig(a.b, outdir=db, no_preview=True)
        result["compiled"] = {
            "a": {"ok": ca["ok"], "charSha256": ca.get("charSha256"), "warnings": ca.get("warnings", [])},
            "b": {"ok": cb["ok"], "charSha256": cb.get("charSha256"), "warnings": cb.get("warnings", [])},
            "identical": ca.get("charSha256") == cb.get("charSha256"),
        }
        if not ca["ok"] or not cb["ok"]:
            result["ok"] = False
            result["exitCode"] = EXIT_INVALID
            result["message"] = "至少一版编译未达标，仍返回数值 diff；视觉后果页不出"
            return out(result)
        html_out = os.path.join(base, "diff.html")
        pv = subprocess.run(
            ["node", "tools/rig/diff.mjs", "--a", a.a, "--b", a.b,
             "--charA", ca["artifacts"]["char"], "--charB", cb["artifacts"]["char"],
             "--identical", "true" if result["compiled"]["identical"] else "false",
             "--out", html_out],
            cwd=ROOT, capture_output=True, text=True,
        )
        if pv.returncode != 0:
            return out({**result, "ok": False, "exitCode": EXIT_ENV,
                        "message": "视觉后果页生成失败", "stderr": pv.stderr[-2000:]})
        result["artifacts"] = {"charA": ca["artifacts"]["char"],
                               "charB": cb["artifacts"]["char"], "html": html_out}
        result["next"] = "打开 diff.html 看两版 zone 框与六格的并排后果"
    return out(result)


def main() -> int:
    ap = argparse.ArgumentParser(description="codeavatar Agent 接口（stdout 恒为 JSON）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="只校验，返回结构化错误 + 数字量具")
    p.add_argument("rig")
    p.set_defaults(fn=cmd_inspect)

    p = sub.add_parser("write", help="写 → 编译 → 返图（每次写都返回图和量具）")
    p.add_argument("rig")
    p.add_argument("--stdin", action="store_true", help="从 stdin 读 rig 内容并写入目标文件")
    p.add_argument("--no-preview", action="store_true")
    p.add_argument("--verify-golden", action="store_true")
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_write)

    p = sub.add_parser("fix", help="按 errors 的 path/code 机械修复")
    p.add_argument("rig")
    p.add_argument("--out", default=None)
    p.set_defaults(fn=cmd_fix)

    p = sub.add_parser("note", help="人在画面上指错回路")
    p.add_argument("action", choices=["add", "list", "resolve"])
    p.add_argument("rig")
    p.add_argument("--zone", default=None)
    p.add_argument("--text", default="")
    p.add_argument("--at", default=None, help="画面上的点 x,y（设定稿像素）")
    p.add_argument("--id", default=None)
    p.add_argument("--by", default=None)
    p.add_argument("--all", action="store_true")
    p.add_argument("--force", action="store_true", help="确属误报时跳过「rig 必须变过」约束")
    p.set_defaults(fn=cmd_note)

    p = sub.add_parser("diff", help="两版 rig 的数值差 + 编译产物 sha + 并排视觉后果")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--no-preview", action="store_true")
    p.set_defaults(fn=cmd_diff)

    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
