#!/usr/bin/env python3
"""GitHub 仓库流量监督。

用途：定期巡检仓库的浏览/克隆趋势与来源，输出可直接贴进日报的摘要，
并把快照追加到 `.workbuddy/memory/traffic/history.jsonl`（供长期趋势对比）。

凭据：优先 `GH_TOKEN` / `GITHUB_TOKEN` 环境变量；否则通过本地
git-credential-manager 现取（token 不打印、不落盘）。
`/traffic/*` 端点需要对该仓库有 push 权限的 token；GitHub 只保留**最近 14 天**。

用法：
  python tools/gh_traffic.py                 # 近 7 天 vs 上一个 7 天
  python tools/gh_traffic.py --days 14       # 近 14 天 vs 之前（最多 14）
  python tools/gh_traffic.py --json          # 机器可读（自动化/看板消费）
  python tools/gh_traffic.py --repo owner/name
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_REPO = "ch0712/codeavatar"
API = "https://api.github.com"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HISTORY = ROOT / ".workbuddy" / "memory" / "traffic" / "history.jsonl"

# 本机 Git 凭据管理器（Windows 全路径；其它平台回退到 PATH 里的同名程序）
GCM_CANDIDATES = [
    Path.home() / ".workbuddy" / "binaries" / "PortableGit" / "versions" / "1.3.0" / "mingw64" / "bin" / "git-credential-manager.exe",
    Path("C:/Users/HH/.workbuddy/binaries/PortableGit/versions/1.3.0/mingw64/bin/git-credential-manager.exe"),
]


def _token_from_gcm() -> str | None:
    """从 git 凭据管理器现取 GitHub token（不打印、不写盘）。"""
    exe = next((p for p in GCM_CANDIDATES if p.exists()), None)
    cmd = [str(exe)] if exe else ["git-credential-manager"]
    try:
        r = subprocess.run(  # noqa: S603 - 固定参数调用本机凭据助手
            cmd + ["get"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in r.stdout.splitlines():
        if line.startswith("password="):
            tok = line.split("=", 1)[1].strip()
            if tok:
                return tok
    return None


def token() -> str:
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or _token_from_gcm()
    if not tok:
        sys.exit(
            "未取得 GitHub token：请设 GH_TOKEN 环境变量，或先用有 push 权限的账号做一次 git 推送"
            "（凭据会被 git-credential-manager 记住）。"
        )
    return tok


def get(path: str, tok: str) -> dict:
    req = urllib.request.Request(
        API + path,
        headers={
            "Authorization": "token " + tok,
            "Accept": "application/vnd.github+json",
            "User-Agent": "codeavatar-gh-traffic",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:  # noqa: S310 - 固定 https 域名
            return json.load(r)
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"GitHub API {path} 失败：HTTP {e.code} {msg}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"GitHub API {path} 网络失败：{e.reason}") from e


def split_window(days: list[dict], recent: int) -> tuple[dict, dict]:
    """把 14 天序列切成「最近 recent 天」和「之前 equally 长的一段」。"""
    days = sorted(days, key=lambda d: d["timestamp"])
    recent_part = days[-recent:]
    prior_part = days[-2 * recent : -recent] if len(days) > recent else []
    def agg(part: list[dict]) -> dict:
        return {
            "count": sum(int(d.get("count", 0)) for d in part),
            "uniques": sum(int(d.get("uniques", 0)) for d in part),
            "days": len(part),
        }
    return agg(recent_part), agg(prior_part)


def pct(cur: int, prev: int) -> str:
    if prev == 0:
        return "—" if cur == 0 else "新增"
    return f"{(cur - prev) / prev * 100:+.0f}%"


def load_last_snapshot() -> dict | None:
    if not HISTORY.exists():
        return None
    last = None
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                last = json.loads(line)
            except json.JSONDecodeError:
                continue
    return last


def main() -> int:
    ap = argparse.ArgumentParser(description="GitHub 仓库流量监督")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--days", type=int, default=7, choices=range(1, 15), metavar="1-14")
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON（不写历史）")
    ap.add_argument("--no-history", action="store_true", help="不追加历史快照")
    args = ap.parse_args()

    tok = token()
    repo = get(f"/repos/{args.repo}", tok)
    views_raw = get(f"/repos/{args.repo}/traffic/views", tok)
    clones_raw = get(f"/repos/{args.repo}/traffic/clones", tok)
    referrers = get(f"/repos/{args.repo}/traffic/popular/referrers", tok)
    paths = get(f"/repos/{args.repo}/traffic/popular/paths", tok)

    views, views_prev = split_window(views_raw.get("views", []), args.days)
    clones, clones_prev = split_window(clones_raw.get("clones", []), args.days)

    snap = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "repo": args.repo,
        "stars": repo.get("stargazers_count", 0),
        "forks": repo.get("forks_count", 0),
        "watchers": repo.get("subscribers_count", 0),
        "open_issues": repo.get("open_issues_count", 0),
        "pushed_at": repo.get("pushed_at"),
        "window_days": args.days,
        "views": views,
        "views_prev": views_prev,
        "clones": clones,
        "clones_prev": clones_prev,
        "referrers": [
            {"site": r.get("referrer"), "count": r.get("count"), "uniques": r.get("uniques")}
            for r in referrers[:5]
        ],
        "paths": [
            {"path": p.get("path"), "title": p.get("title"), "count": p.get("count"), "uniques": p.get("uniques")}
            for p in paths[:5]
        ],
    }

    last = load_last_snapshot()
    if last:
        snap["delta"] = {
            "stars": snap["stars"] - int(last.get("stars", 0)),
            "forks": snap["forks"] - int(last.get("forks", 0)),
            "watchers": snap["watchers"] - int(last.get("watchers", 0)),
        }
    if not args.no_history and not args.json:
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        with HISTORY.open("a", encoding="utf-8") as f:
            f.write(json.dumps(snap, ensure_ascii=False) + "\n")

    if args.json:
        print(json.dumps(snap, ensure_ascii=False, indent=2))
        return 0

    d = args.days
    print(f"=== GitHub 流量监督 · {args.repo} ===")
    print(f"快照 {snap['ts']}｜窗口 近 {d} 天 vs 前 {d} 天（GitHub 上限 14 天）")
    print(
        f"仓库：★{snap['stars']} · fork {snap['forks']} · watch {snap['watchers']} · "
        f"open issues {snap['open_issues']} · 最近推送 {snap['pushed_at']}"
    )
    print(
        f"浏览：{views['count']} 次 / {views['uniques']} 人"
        f"（前 {d} 天 {views_prev['count']} / {views_prev['uniques']}，{pct(views['count'], views_prev['count'])}）"
    )
    print(
        f"克隆：{clones['count']} 次 / {clones['uniques']} 人"
        f"（前 {d} 天 {clones_prev['count']} / {clones_prev['uniques']}，{pct(clones['count'], clones_prev['count'])}）"
    )
    if snap.get("delta"):
        dl = snap["delta"]
        print(f"对比上次快照：★{dl['stars']:+d} · fork {dl['forks']:+d} · watch {dl['watchers']:+d}")
    if snap["referrers"]:
        print("来源：" + "；".join(f"{r['site']} {r['count']}次/{r['uniques']}人" for r in snap["referrers"]))
    else:
        print("来源：无外部来源（直接在 GitHub 站内访问/克隆）")
    if snap["paths"]:
        print("热门路径：" + "；".join(f"{p['path']} {p['count']}次" for p in snap["paths"]))

    notes = []
    if views["count"] == 0 and clones["count"] == 0:
        notes.append("窗口内零浏览零克隆——检查是否有推广动作/链接失效")
    if clones["uniques"] > 0 and views["uniques"] == 0:
        notes.append("有克隆无浏览：多为自动化/镜像抓取，别当成真人关注")
    if notes:
        print("提示：" + "；".join(notes))
    print(f"历史快照：{HISTORY.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
