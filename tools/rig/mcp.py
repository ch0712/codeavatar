#!/usr/bin/env python3
"""MCP stdio server（P2，2026-11-14）：把建角闭环暴露给 Agent 客户端。

零依赖 JSON-RPC 2.0 over newline-delimited JSON，实现 MCP 最小工具面：
    initialize / notifications/initialized / tools/list / tools/call / ping

暴露 5 个 tool（全部复用 agent.py / compile.py 的库函数，**不经 CLI print**，
避免污染 stdout 协议通道）：

    rig_inspect  校验 + 数字量具（无像素自检）
    rig_write    写 → 编译 → 返图 → charSha256 / 量具 / 产物路径
    rig_fix      按 errors 的 path/code 机械修复
    rig_note     人在画面上指错（add/list/resolve）
    rig_diff     两版数值差 + 编译产物 sha + 视觉后果页

配置（~/.workbuddy/mcp.json 或客户端 MCP 配置）：
    {"mcpServers": {"codeavatar-rig": {
        "command": "python", "args": ["tools/rig/mcp.py"], "cwd": "<仓库绝对路径>"}}}

    python tools/rig/mcp_check.py    # 协议自证
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

from agent import (  # noqa: E402
    AGENT_VERSION, cmd_inspect, cmd_write, cmd_fix, cmd_note, cmd_diff,
)
from compile import EXIT_OK, EXIT_INVALID, EXIT_ENV  # noqa: E402

PROTOCOL = "2024-11-05"
SERVER_INFO = {"name": "codeavatar-rig", "version": "1.0.0"}

TOOLS = [
    {
        "name": "rig_inspect",
        "description": "校验一份 .rig.json 并返回结构化错误（path/code/message/fix）与分区数字量具，无需看像素。",
        "inputSchema": {
            "type": "object",
            "properties": {"rig": {"type": "string", "description": ".rig.json 路径（相对仓库根或绝对）"}},
            "required": ["rig"],
        },
    },
    {
        "name": "rig_write",
        "description": "编译 rig 并写即返图：返回 charSha256、结构量具、golden 状态、pose-sheet.html 路径。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "rig": {"type": "string"},
                "content": {"type": "string", "description": "可选：直接写入的 rig JSON 文本（写即返图）"},
                "noPreview": {"type": "boolean"},
                "verifyGolden": {"type": "boolean"},
            },
            "required": ["rig"],
        },
    },
    {
        "name": "rig_fix",
        "description": "按 inspect 返回的 errors 的 path/code 做机械修复，返回修复前后错误码对照。",
        "inputSchema": {
            "type": "object",
            "properties": {"rig": {"type": "string"}, "out": {"type": "string"}},
            "required": ["rig"],
        },
    },
    {
        "name": "rig_note",
        "description": "人在画面上指错回路：add/list/resolve。resolve 要求 rig 内容确实变过，否则拦下。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "rig": {"type": "string"},
                "action": {"type": "string", "enum": ["add", "list", "resolve"]},
                "zone": {"type": "string"}, "text": {"type": "string"},
                "at": {"type": "string", "description": "画面上的点 x,y"},
                "id": {"type": "string"}, "by": {"type": "string"},
                "all": {"type": "boolean"}, "force": {"type": "boolean"},
            },
            "required": ["rig", "action"],
        },
    },
    {
        "name": "rig_diff",
        "description": "比较两版 rig：逐字段数值差、两版 charSha256 是否相同、并排视觉后果页。",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "string"},
                           "noPreview": {"type": "boolean"}},
            "required": ["a", "b"],
        },
    },
]


class Args:
    """把 MCP arguments 适配成 agent.py 各 cmd_* 期望的 argparse Namespace。"""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def call_tool(name: str, args: dict) -> dict:
    try:
        if name == "rig_inspect":
            a = Args(rig=args["rig"])
            r = _capture(cmd_inspect, a)
        elif name == "rig_write":
            a = Args(rig=args["rig"], stdin=False, no_preview=args.get("noPreview", False),
                     verify_golden=args.get("verifyGolden", False), out=None)
            # content 模式：先落盘再编译（写即返图），不经过 stdin
            if "content" in args:
                p = a.rig if os.path.isabs(a.rig) else os.path.join(ROOT, a.rig)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(args["content"])
            r = _capture(cmd_write, a)
        elif name == "rig_fix":
            r = _capture(cmd_fix, Args(rig=args["rig"], out=args.get("out")))
        elif name == "rig_note":
            r = _capture(cmd_note, Args(
                rig=args["rig"], action=args["action"], zone=args.get("zone"),
                text=args.get("text", ""), at=args.get("at"), id=args.get("id"),
                by=args.get("by"), all=args.get("all", False), force=args.get("force", False),
            ))
        elif name == "rig_diff":
            r = _capture(cmd_diff, Args(a=args["a"], b=args["b"],
                                        no_preview=args.get("noPreview", False)))
        else:
            return {"ok": False, "message": f"未知 tool {name}", "exitCode": EXIT_INVALID}
        return r
    except KeyError as exc:
        return {"ok": False, "message": f"缺少参数 {exc}", "exitCode": EXIT_INVALID}
    except Exception as exc:  # 协议层必须兜住异常，不能让 server 崩掉
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}", "exitCode": EXIT_ENV}


def _capture(fn, a) -> dict:
    """cmd_* 会 print JSON 到 stdout；MCP 的 stdout 是协议通道，必须重定向。

    这里把 stdout 临时换成内存缓冲，取回 JSON 再恢复——这样复用 CLI 逻辑
    而不复制一份实现，也不会往协议流里混入任何非 JSON 行。
    """
    import io
    buf = io.StringIO()
    saved = sys.stdout
    try:
        sys.stdout = buf
        fn(a)
    finally:
        sys.stdout = saved
    text = buf.getvalue().strip()
    try:
        return json.loads(text)
    except Exception:
        return {"ok": False, "message": "工具未返回合法 JSON", "raw": text[-500:],
                "exitCode": EXIT_ENV}


def handle(msg: dict) -> dict | None:
    mid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid,
                "result": {"protocolVersion": PROTOCOL,
                           "capabilities": {"tools": {"listChanged": False}},
                           "serverInfo": SERVER_INFO}}
    if method == "notifications/initialized" or method == "notifications/cancelled":
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        tname = params.get("name")
        r = call_tool(tname, params.get("arguments") or {})
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": json.dumps(r, ensure_ascii=False, indent=2)}],
            "isError": not r.get("ok", False),
        }}
    if mid is None:
        return None
    return {"jsonrpc": "2.0", "id": mid,
            "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": "Parse error"}}), flush=True)
            continue
        try:
            resp = handle(msg)
        except Exception as exc:
            resp = {"jsonrpc": "2.0", "id": msg.get("id"),
                    "error": {"code": -32603, "message": f"Internal error: {exc}"}}
        if resp is not None:
            print(json.dumps(resp, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
