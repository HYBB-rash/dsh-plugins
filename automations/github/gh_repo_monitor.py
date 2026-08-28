#!/usr/bin/env python3
"""HYBB-rash/chatgpt-linux-nix 仓库监控:新 PR + Action 构建变化。
用法: python3 gh_repo_monitor.py
输出: 有新增->文本; 无新增->NO_REPLY
"""
import json, os, subprocess, time
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from automation_paths import state_file

REPO = "HYBB-rash/chatgpt-linux-nix"
STATE = state_file("gh_repo_state.json")
GH = os.path.expanduser("~/.local/bin/gh")

def gh_api(path):
    r = subprocess.run([GH, "api", path], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except Exception:
        return None

def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE))
        except Exception:
            return {}
    return {}

def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f, ensure_ascii=False)

def main():
    st = load_state()
    out = []

    # 1. PR:最近 10 条(open + 最近 closed/merged)
    prs = gh_api(f"repos/{REPO}/pulls?state=all&per_page=10") or []
    seen_prs = set(st.get("prs", []))
    new_prs = []
    for p in prs:
        pid = p.get("number")
        if pid in seen_prs:
            continue
        seen_prs.add(pid)
        title = p.get("title", "")
        user = (p.get("user") or {}).get("login", "?")
        state = p.get("state", "?")
        merged = p.get("merged_at") is not None
        branch = (p.get("head") or {}).get("ref", "?")
        # 重点:自动创建的 PR(agent 分支)
        tag = "🤖自动" if "agent/" in branch or "auto" in branch.lower() else ""
        status = "merged" if merged else state
        new_prs.append(f"- PR#{pid} {tag}[{status}] {title} (@{user}, 分支 {branch}) {p.get('html_url','')}")
    if new_prs:
        out.append("🆕 新 PR:")
        out.extend(new_prs[:5])
    st["prs"] = sorted(seen_prs)

    # 2. Actions runs:最近 10 条
    runs_data = gh_api(f"repos/{REPO}/actions/runs?per_page=10")
    runs = (runs_data or {}).get("workflow_runs", []) or []
    seen_runs = set(st.get("runs", []))
    new_runs = []
    for r in runs:
        rid = r.get("id")
        if rid in seen_runs:
            continue
        seen_runs.add(rid)
        name = r.get("name", "?")
        status = r.get("status", "?")
        conclusion = r.get("conclusion") or "pending"
        branch = r.get("head_branch", "?")
        event = r.get("event", "?")
        created = (r.get("created_at") or "")[5:16]
        # 例行定时检查成功 = 无新构建, 静默记录不打扰
        if event == "schedule" and conclusion == "success":
            continue
        # 只报: 失败/取消(异常) 或 非定时触发的真·新构建(push/PR/手动)
        icon = "✅" if conclusion == "success" else ("❌" if conclusion in ("failure","cancelled") else "⏳")
        new_runs.append(f"- {icon} {name} | {status}/{conclusion} | 分支 {branch} | {event} | {created}")
    if new_runs:
        out.append("⚙️ Action 构建:")
        out.extend(new_runs[:6])
    st["runs"] = sorted(seen_runs)

    save_state(st)

    if not out:
        print("NO_REPLY")
        return
    header = f"📦 chatgpt-linux-nix ({time.strftime('%m-%d %H:%M')})"
    print(header)
    for line in out:
        print(line)

if __name__ == "__main__":
    main()
