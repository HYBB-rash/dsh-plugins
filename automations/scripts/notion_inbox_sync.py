#!/usr/bin/env python3
"""inbox ↔ Notion「任务」页 同步器 (Notion 主写 + 本地存档, 2026-08-09 反转)

方向: Notion「任务」页是任务主写入口, ~/task-inbox-workflow/inbox.md 是本地存档镜像。
     本地仅作 Notion 不可达时的离线缓冲(pending), 恢复后自动补推送。

行为:
- 无参(auto): 有 pending → push 补同步; 无 pending → pull 存档刷新(收尾兜底)
- --set <file|->: 全文直写 Notion(主流程), 成功后存档本地; Notion 不可达 → 自动落本地 + pending
- --pull: Notion → 本地存档; 有 pending 时拒绝(防止覆盖离线缓冲)
- --push: 本地 → Notion(离线恢复补同步); 冲突检测同前
- --force: 跳过冲突检测强制覆盖

冲突检测: 推送前比对「Notion 当前内容 vs 上次同步指纹」。Notion 被改过(≠ 指纹)
且 ≠ 待推内容 → 不覆盖, 打印冲突信息, exit 1 (用户裁决: --force 覆盖 / pull 拉回)。
"""
import os
import sys
import json
import hashlib
import urllib.request
import urllib.error

from automation_paths import state_dir

INBOX = os.path.expanduser(os.environ.get(
    "NOTION_INBOX_FILE", "~/task-inbox-workflow/inbox.md"))
PAGE_ID = "3b059c119f80803cb8ace3ead7eefc81"  # 任务拆解 → 任务(子页面)
ENV_FILE = os.path.expanduser(os.environ.get("NOTION_ENV_FILE", ""))
STATE_DIR = str(state_dir() / "notion-inbox-sync")
LAST_INBOX_FILE = os.path.join(STATE_DIR, "notion_inbox_sync.last_inbox.md5")   # 上次同步后本地内容指纹
LAST_NOTION_FILE = os.path.join(STATE_DIR, "notion_inbox_sync.last_notion.md5")  # 上次同步后 Notion 实际内容指纹(冲突基准)
PENDING_FILE = os.path.join(STATE_DIR, "notion_inbox_sync.pending")
TIMEOUT = 15
NOTION_API = "https://api.notion.com"


def md5s(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def load_key():
    if ENV_FILE and os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("NOTION_API_KEY="):
                    return line.split("=", 1)[1].strip()
    return os.environ.get("NOTION_API_KEY", "")


def _req(path, method, body=None):
    headers = {
        "Authorization": f"Bearer {load_key()}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(
        f"{NOTION_API}/v1/{path}",
        data=body,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def notion_get():
    """读取 Notion 页面当前 markdown。失败抛异常。"""
    d = _req(f"pages/{PAGE_ID}/markdown", "GET")
    return d.get("markdown", "")


def notion_push(md):
    """整体替换 Notion 页面内容, 返回推送后 Notion 实际内容(作下次冲突基准)。失败抛异常。"""
    body = json.dumps({
        "type": "replace_content",
        "replace_content": {"new_str": md, "markdown": md},
    }).encode("utf-8")
    d = _req(f"pages/{PAGE_ID}/markdown", "PATCH", body)
    return d.get("markdown", md)


def read_fingerprint(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def write_fingerprint(path, digest):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(digest)


def has_pending():
    return os.path.exists(PENDING_FILE)


def mark_pending():
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(PENDING_FILE, "w", encoding="utf-8") as f:
        f.write("pending")


def clear_pending():
    try:
        os.remove(PENDING_FILE)
    except FileNotFoundError:
        pass


def write_local(md):
    """干净 UTF-8 重写本地存档(顺带清除历史 NUL 字节)。"""
    with open(INBOX, "w", encoding="utf-8") as f:
        f.write(md)


def pull_to_local():
    """Notion → ~/task-inbox-workflow/inbox.md 存档刷新。有 pending 时拒绝(本地有未推送离线改动)。"""
    if has_pending():
        print("⚠️ 存在待补同步(pending): 本地有未推送的离线改动, 先跑同步推送(无参或 --push), 再 pull")
        sys.exit(1)
    try:
        notion_md = notion_get()
    except Exception as e:
        mark_pending()
        print(f"⚠️ Notion 暂不可达, 无法拉取存档; 已记录待补状态 ({e})")
        sys.exit(0)
    write_local(notion_md)
    write_fingerprint(LAST_INBOX_FILE, md5s(notion_md))
    write_fingerprint(LAST_NOTION_FILE, md5s(notion_md))
    clear_pending()
    print("✅ 已从 Notion 拉取存档到本地 inbox.md")


def set_content(md, force=False):
    """全文直写 Notion(主流程)。md 为空 → 提示并跳过。"""
    if not md.strip():
        print("⚠️ 内容为空, 跳过")
        sys.exit(0)
    # 1. 读 Notion 当前内容(不可达 → 落本地 + pending, 离线兜底)
    try:
        notion_md = notion_get()
    except Exception as e:
        write_local(md)
        mark_pending()
        print(f"⚠️ Notion 不可达, 内容已写入本地 inbox.md 并记录待补同步, 恢复后自动补 ({e})")
        sys.exit(0)
    # 2. 冲突检测: Notion 被改过(≠ 上次同步指纹)且 ≠ 待推内容 → 不覆盖
    last_notion = read_fingerprint(LAST_NOTION_FILE)
    if not force and last_notion and md5s(notion_md) != last_notion and notion_md != md:
        print("⚠️ Notion「任务」页已被修改(另一会话直写或手动编辑), 为避免覆盖主源上的新改动, 已跳过。")
        print("   决定: 以Notion为准 → 告诉我「以Notion为准」(先 pull 拉回本地存档再改)")
        print("         以本次内容为准 → 告诉我「以inbox为准」(--force 强制覆盖)")
        sys.exit(1)
    # 3. 推送 + 存档
    try:
        pushed_md = notion_push(md)
    except Exception as e:
        write_local(md)
        mark_pending()
        print(f"⚠️ Notion 推送失败, 内容已写入本地 inbox.md 并记录待补同步, 恢复后自动补 ({e})")
        sys.exit(0)
    write_local(pushed_md)
    write_fingerprint(LAST_INBOX_FILE, md5s(pushed_md))
    write_fingerprint(LAST_NOTION_FILE, md5s(pushed_md))
    clear_pending()
    print("✅ 已直写 Notion 并同步本地存档")


def main_push(force=False):
    """本地 → Notion(离线恢复补同步 / 显式 --push)。冲突检测同前。"""
    if not os.path.exists(INBOX):
        print(f"❌ Notion 同步失败: inbox.md 不存在 ({INBOX})")
        sys.exit(1)
    with open(INBOX, encoding="utf-8") as f:
        md = f.read()
    inbox_digest = md5s(md)
    if not md.strip():
        print("⚠️ inbox.md 为空, 跳过同步")
        sys.exit(0)
    try:
        notion_md = notion_get()
    except Exception as e:
        mark_pending()
        print(f"⚠️ Notion 暂不可达, inbox 已写入; 已记录待补同步, 恢复后自动同步回去 ({e})")
        sys.exit(0)
    last_inbox = read_fingerprint(LAST_INBOX_FILE)
    last_notion = read_fingerprint(LAST_NOTION_FILE)
    if not force and last_notion and md5s(notion_md) != last_notion:
        print("⚠️ 检测到 Notion「任务」页被手动修改(内容 ≠ 上次推送快照), 已跳过覆盖, 不会丢你的改动。")
        print("   决定: 以 Notion 为准 → 告诉我「以Notion为准」(把 Notion 内容拉回 inbox)")
        print("         以 inbox 为准 → 告诉我「以inbox为准」(强制覆盖 Notion)")
        sys.exit(1)
    if not force and not has_pending() and inbox_digest == last_inbox:
        sys.exit(0)  # 无变化, 静默
    try:
        pushed_md = notion_push(md)
    except Exception as e:
        mark_pending()
        print(f"⚠️ Notion 推送失败, 已记录待补同步, 恢复后自动补 ({e})")
        sys.exit(0)
    write_fingerprint(LAST_INBOX_FILE, inbox_digest)
    write_fingerprint(LAST_NOTION_FILE, md5s(pushed_md))
    clear_pending()
    sys.exit(0)


def main():
    force = "--force" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    mode = args[0] if args else "auto"  # auto | pull | push | set

    key = load_key()
    if not key:
        print("❌ Notion 同步失败: NOTION_API_KEY 未配置")
        sys.exit(1)

    if mode == "pull":
        pull_to_local()
    elif mode == "push":
        main_push(force)
    elif mode == "set":
        src = args[1] if len(args) > 1 else "-"  # 文件路径或 "-" 读 stdin
        if src == "-":
            md = sys.stdin.read()
        else:
            with open(src, encoding="utf-8") as f:
                md = f.read()
        set_content(md, force)
    else:  # auto: 有 pending → push; 无 pending → pull
        if has_pending():
            main_push(force)
        else:
            pull_to_local()


if __name__ == "__main__":
    main()
