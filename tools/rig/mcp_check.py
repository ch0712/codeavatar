#!/usr/bin/env python3
"""MCP server 协议自证（P2，2026-11-14）。

用真实子进程通过 stdio 发 JSON-RPC，验证：
  · initialize / tools/list / tools/call / 未知方法 / ping
  · 每个 tool 返回的 content[0].text 是可解析 JSON
  · stdout 协议流纯净（没有混入人读日志 / print 调试行）
  · 一次完整的「inspect 坏 rig → fix → inspect 干净」无像素自检闭环

    python tools/rig/mcp_check.py
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
MCP = os.path.join(HERE, "mcp.py")
BASE_RIG = os.path.join(ROOT, "examples", "rig", "noF.rig.json")

fails: list[str] = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" | {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def main() -> int:
    proc = subprocess.Popen(
        [sys.executable, MCP], cwd=ROOT, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        bufsize=1,
    )
    seq = [0]

    def req(method, params=None, notify=False):
        seq[0] += 1
        msg = {"jsonrpc": "2.0", "method": method}
        if not notify:
            msg["id"] = seq[0]
        if params is not None:
            msg["params"] = params
        proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        if notify:
            return None
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f"server 提前退出（stderr: {proc.stderr.read()[-500:]}）")
        return json.loads(line)

    def tool(name, args):
        r = req("tools/call", {"name": name, "arguments": args})
        txt = r["result"]["content"][0]["text"]
        return r, json.loads(txt)

    try:
        print("[1] 握手与工具清单")
        init = req("initialize", {"protocolVersion": "2024-11-05",
                                  "capabilities": {}, "clientInfo": {"name": "mcp_check", "version": "1"}})
        check("initialize 返回 protocolVersion + capabilities.tools",
              init.get("result", {}).get("protocolVersion") == "2024-11-05"
              and "tools" in init.get("result", {}).get("capabilities", {}))
        req("notifications/initialized", notify=True)
        check("ping 有响应", req("ping").get("result") == {})
        lst = req("tools/list")
        names = [t["name"] for t in lst.get("result", {}).get("tools", [])]
        check("5 个 tool 全部列出", set(names) == {"rig_inspect", "rig_write", "rig_fix",
                                             "rig_note", "rig_diff"}, str(names))
        check("每个 tool 都有 inputSchema",
              all("inputSchema" in t and "properties" in t["inputSchema"]
                  for t in lst["result"]["tools"]))
        check("未知方法返回 -32601",
              req("tools/nope").get("error", {}).get("code") == -32601)

        print("[2] 通过 MCP 跑一次完整无像素自检闭环")
        with tempfile.TemporaryDirectory(prefix="rig-mcp-check-") as td:
            base = json.load(open(BASE_RIG, encoding="utf-8"))
            bad = copy.deepcopy(base)
            bad["id"] = "noFMcp"
            bad["version"] = 9
            bad["zoon"] = 1
            bad["zones"]["mouth"] = [782, 1175, 548, 1058]
            bad["build"]["typoKey"] = 1
            bad["build"]["eyeCarve"] = "yes"
            bad_path = os.path.join(td, "bad.rig.json")
            with open(bad_path, "w", encoding="utf-8") as fh:
                json.dump(bad, fh, ensure_ascii=False, indent=2)

            _, d = tool("rig_inspect", {"rig": bad_path})
            codes = sorted(d.get("summary", {}).get("codes", []))
            check("rig_inspect 自检出 ≥5 类错误", len(codes) >= 5, str(codes))
            fixed_path = os.path.join(td, "fixed.rig.json")
            _, d = tool("rig_fix", {"rig": bad_path, "out": fixed_path})
            check("rig_fix 修完干净", d.get("after", {}).get("ok") is True,
                  str(d.get("after")))
            _, d = tool("rig_inspect", {"rig": fixed_path})
            check("复验干净", d.get("ok") is True)
            _, d = tool("rig_write", {"rig": fixed_path, "noPreview": True})
            check("rig_write 返回 charSha256", bool(d.get("charSha256")),
                  str(d.get("charSha256"))[:16])

            store = os.path.join(ROOT, "out", "rig", "noFMcp", "notes.json")
            if os.path.isfile(store):
                os.remove(store)
            _, d = tool("rig_note", {"rig": fixed_path, "action": "add",
                                     "zone": "eyeL", "text": "MCP 指错", "at": "529,811"})
            nid = d.get("note", {}).get("id")
            check("rig_note add 成功", bool(nid), str(nid))
            _, d = tool("rig_note", {"rig": fixed_path, "action": "list"})
            check("rig_note list 有 1 条 open", d.get("openCount") == 1)

            _, d = tool("rig_diff", {"a": BASE_RIG, "b": fixed_path, "noPreview": True})
            check("rig_diff 返回 changedZones", "changedZones" in d, str(d.get("changedZones")))

        print("[3] 协议流纯净性")
        proc.stdin.close()
        proc.wait(timeout=10)
        tail = proc.stderr.read()
        check("server 正常退出", proc.returncode == 0, f"rc={proc.returncode} {tail[-200:]}")
    finally:
        if proc.poll() is None:
            proc.kill()

    print()
    if fails:
        print(f"FAIL：MCP 自证 {len(fails)} 项不通过")
        for f in fails:
            print("  ! " + f)
        return 1
    print("PASS：MCP stdio server · 握手 / 5 tools / 无像素自检闭环 / 协议流纯净 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
