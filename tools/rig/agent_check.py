#!/usr/bin/env python3
"""P2 端到端闭环自证（2026-11-14）。

验收口径（ROADMAP §18.6 / CODE-AS-WORLD §9）：
  ① Agent 无人工看像素也能自检 ≥5 类结构错误；
  ② 一次「指错 → 修 → 复验」闭环可复现。

全部通过**真实 CLI 子进程**验证（`agent.py` / `compile.py`），不直接调内部函数，
这样同时验到了 stdout 恒为 JSON、稳定退出码、从仓库外路径调用仍以仓库根为基准。

    python tools/rig/agent_check.py
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
AGENT = os.path.join(HERE, "agent.py")
BASE_RIG = os.path.join(ROOT, "examples", "rig", "noF.rig.json")
BASE_SHA = "ee38c6a11426a5c9aab14bd09066924368f2ff19ee8b27142a144912409472fa"

fails: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" | {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def cli(*args, stdin: str | None = None) -> tuple[int, dict]:
    p = subprocess.run(
        [sys.executable, AGENT, *map(str, args)],
        cwd=ROOT, input=stdin, capture_output=True, text=True, encoding="utf-8",
    )
    try:
        data = json.loads(p.stdout)
    except Exception:
        data = {"_raw": p.stdout[-800:], "_stderr": p.stderr[-800:]}
    return p.returncode, data


def main() -> int:
    with open(BASE_RIG, encoding="utf-8") as fh:
        base = json.load(fh)

    with tempfile.TemporaryDirectory(prefix="rig-agent-check-") as td:
        # notes 按角色 id 存在 out/rig/<id>/，跨次运行会累积。
        # 自证必须幂等：开跑前清掉本测试专用 id 的归档（不碰 noF 的真实 notes）。
        test_id = "noFCheck"
        store = os.path.join(ROOT, "out", "rig", test_id, "notes.json")
        if os.path.isfile(store):
            os.remove(store)

        # ── ① 注入 5 类结构错误，Agent 不看像素自检 ──────────────────────
        broken = copy.deepcopy(base)
        broken["id"] = test_id             # 独立 id，不污染 noF 的 notes/golden
        broken["version"] = 9              # E002
        broken["zoon"] = 1                 # E004
        broken["zones"]["mouth"] = [782, 1175, 548, 1058]  # E012（颠倒）
        broken["build"]["typoKey"] = 1     # E019
        broken["build"]["eyeCarve"] = "yes"  # E020
        broken_path = os.path.join(td, "broken.rig.json")
        with open(broken_path, "w", encoding="utf-8") as fh:
            json.dump(broken, fh, ensure_ascii=False, indent=2)

        print("[1] 注入 5 类结构错误 → inspect 自检")
        rc, d = cli("inspect", broken_path)
        codes = sorted(d.get("summary", {}).get("codes", []))
        errs = d.get("errors", [])
        check("inspect 退出码 2（输入不合格）", rc == 2 and d.get("exitCode") == 2, f"rc={rc}")
        check("stdout 是合法 JSON", "_raw" not in d)
        check("一次自检出 ≥5 类错误", len(codes) >= 5, f"codes={codes}")
        check("命中预期的 5 类", set(codes) >= {"E002", "E004", "E012", "E019", "E020"}, f"{codes}")
        check("每个错误都带 path/code/message/fix",
              all(all(e.get(k) for k in ("path", "code", "message", "fix")) for e in errs),
              f"{len(errs)} 项")

        # ── ② 按结构化错误机械修复 → 复验干净 → 编译产物等于金标准 ────────
        print("[2] 按 path/code/fix 机械修复 → 复验 → 编译")
        fixed_path = os.path.join(td, "fixed.rig.json")
        rc, d = cli("fix", broken_path, "--out", fixed_path)
        check("fix 返回 ok", rc == 0 and d.get("ok") is True, f"rc={rc}")
        check("5 类全部机械修复", len(d.get("fixed", [])) >= 5, f"fixed={len(d.get('fixed', []))}")
        check("无残留错误", d.get("after", {}).get("ok") is True, str(d.get("after")))

        rc, d2 = cli("inspect", fixed_path)
        check("复验干净", rc == 0 and d2.get("ok") is True and not d2.get("errors"))

        # 金标准：用原版 rig 现场编译到独立目录（不依赖 out/ 里残留的产物）
        ref_dir = os.path.join(td, "ref")
        rc, ref = cli("write", BASE_RIG, "--no-preview", "--out", ref_dir)
        check("金标准现场编译成功", rc == 0 and ref.get("charSha256") == BASE_SHA,
              str(ref.get("charSha256"))[:16])

        rc, d3 = cli("write", fixed_path, "--no-preview")
        check("write 编译成功", rc == 0 and d3.get("ok") is True, f"stage={d3.get('stage')}")
        # 测试 rig 刻意用了独立 id（避免污染 noF 的 notes/golden），
        # 所以 char.key 必然是 noFCheck；除此之外的几何字段必须与金标准逐字段全等。
        ref_char = json.load(open(os.path.join(ref_dir, "char.json"), encoding="utf-8"))
        got_char = json.load(open(d3["artifacts"]["char"], encoding="utf-8"))
        geometry = lambda c: {k: v for k, v in c.items() if k != "key"}
        check("修复后几何 == 金标准逐字段全等（仅 key 因独立 id 不同）",
              geometry(ref_char) == geometry(got_char),
              f"key: {ref_char.get('key')} vs {got_char.get('key')}")
        check("结构量具无告警", not d3.get("warnings"), str(d3.get("warnings")))

        # ── ③ 指错 → 修 → 复验闭环 ───────────────────────────────────────
        print("[3] 人在画面上指错 → 修 → 复验 → 归档")
        rc, d = cli("note", "add", fixed_path, "--zone", "mouth", "--at", "665,1116",
                    "--text", "嘴区框上沿偏高 2px", "--by", "reviewer")
        nid = d.get("note", {}).get("id")
        check("note add 成功且带 rigSha256", rc == 0 and bool(nid)
              and bool(d.get("note", {}).get("rigSha256")), f"id={nid}")
        check("note 指向预览图", "pose-sheet.html" in d.get("note", {}).get("preview", ""))

        rc, d = cli("note", "list", fixed_path)
        check("note list 有 1 条 open", rc == 0 and d.get("openCount") == 1,
              f"open={d.get('openCount')}")

        rc, d = cli("note", "resolve", fixed_path, "--id", nid)
        check("没改 rig 就想 resolve 被拦下", rc == 2 and d.get("ok") is False,
              str(d.get("message"))[:40])

        # 真改：嘴区框下移 2px，让 rigSha256 变化
        tuned = json.load(open(fixed_path, encoding="utf-8"))
        tuned["zones"]["mouth"] = [548, 1060, 782, 1177]
        tuned_path = os.path.join(td, "tuned.rig.json")
        with open(tuned_path, "w", encoding="utf-8") as fh:
            json.dump(tuned, fh, ensure_ascii=False, indent=2)
        rc, dw = cli("write", tuned_path, "--no-preview")
        check("改动版能编译返图", rc == 0 and dw.get("ok") is True, f"rc={rc}")

        rc, d = cli("note", "resolve", tuned_path, "--id", nid)
        check("改动后 resolve 成功", rc == 0 and d.get("ok") is True
              and d.get("note", {}).get("status") == "resolved", str(d.get("message"))[:40])
        rc, d = cli("note", "list", tuned_path)
        check("闭环收口：0 条 open", rc == 0 and d.get("openCount") == 0,
              f"open={d.get('openCount')}")
        rc, d = cli("note", "list", tuned_path, "--all")
        archived = d.get("notes", [])
        check("归档可回放（含 resolved 状态与修法证据）",
              rc == 0 and d.get("total") == 1
              and archived[0].get("status") == "resolved"
              and archived[0].get("zone") == "mouth"
              and archived[0].get("at") == [665.0, 1116.0]
              and archived[0].get("resolvedBy") == "agent",
              str(archived[:1])[:150])

        # ── ④ diff：数值 + 编译产物 sha + 视觉后果页 ─────────────────────
        print("[4] diff：改了四个数字，画面后果可查")
        rc, d = cli("diff", fixed_path, tuned_path)
        check("diff 退出码 0", rc == 0 and d.get("ok") is True, f"rc={rc}")
        check("识别到 mouth 分区改动", "mouth" in d.get("changedZones", []),
              str(d.get("changedZones")))
        check("给出逐字段 Δ", d.get("zoneDeltas", {}).get("mouth", {}).get("delta")
              == [0, 2, 0, 2], str(d.get("zoneDeltas", {}).get("mouth", {}).get("delta")))
        check("两版 charSha256 都返回",
              bool(d.get("compiled", {}).get("a", {}).get("charSha256"))
              and bool(d.get("compiled", {}).get("b", {}).get("charSha256")))
        check("视觉后果页生成", os.path.isfile(d.get("artifacts", {}).get("html", "")),
              str(d.get("artifacts", {}).get("html"))[-40:])
        diff_html = d.get("artifacts", {}).get("html", "")
        if diff_html and os.path.isfile(diff_html):
            body = open(diff_html, encoding="utf-8").read()
            check("后果页内嵌两版六格（12 帧）", body.count("<svg") >= 12,
                  f"svg={body.count('<svg')}")
            check("后果页叠了 A/B 两套 zone 框", "A:mouth" in body and "B:mouth" in body)
            # 两版只差 2px、几何未变：必须显式说「改动对画面没有影响」，
            # 不能让 Agent 以为改了数字就等于修好了（机检 PASS ≠ 视觉已修）。
            check("产物相同被显式告知（不静默假装改动生效）",
                  d.get("compiled", {}).get("identical") is True
                  and "两版编译产物逐字节相同" in body
                  and "没有影响" in body)
            check("标题用文件名区分两版，不出现 id→id 的歧义",
                  "<h1>fixed → tuned</h1>" in body and "noFCheck → noFCheck" not in body)

        # ── ⑤ 契约：从仓库外目录调用仍以仓库根为基准 ─────────────────────
        print("[5] CLI 契约")
        p = subprocess.run(
            [sys.executable, AGENT, "inspect", "examples/rig/noF.rig.json"],
            cwd=td, capture_output=True, text=True, encoding="utf-8",
        )
        check("仓库外 cwd 调用路径基准一致",
              p.returncode == 0 and json.loads(p.stdout).get("ok") is True)

        print()
        if fails:
            print(f"FAIL：P2 闭环自证 {len(fails)} 项不通过")
            for f in fails:
                print("  ! " + f)
            return 1
        print("PASS：P2 Agent 接口闭环 · 5 类错误无像素自检 / 机械修复→金标准逐字节一致 / "
              "指错→修→复验→归档 / diff 视觉后果 / CLI 契约 ✓")
        return 0


if __name__ == "__main__":
    sys.exit(main())
