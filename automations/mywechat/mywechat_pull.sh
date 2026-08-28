#!/usr/bin/env bash
# my-wechat 仓库每小时自动更新脚本
# 设计: 有更新才输出(投递通知), 无更新静默(no_agent 模式下空 stdout = 不打扰)
# 路径自适应(双机通用, 勿硬编码): 按 $HOME 探测仓库目录, 可用 MYWECHAT_DIR 覆盖
set -u

REPO="${MYWECHAT_DIR:-}"
if [ -z "$REPO" ]; then
    for cand in "$HOME/my-wechat"; do
        if [ -d "$cand/.git" ] && [ -x "$cand/.venv/bin/python" ]; then
            REPO="$cand"
            break
        fi
    done
fi
BRANCH="dev"   # 默认分支

cd "$REPO" || { echo "❌ 仓库目录不存在: $REPO"; exit 1; }

# 1. fetch 远端
if ! git fetch origin 2>/tmp/mywechat_fetch_err.txt; then
    echo "❌ git fetch 失败: $(cat /tmp/mywechat_fetch_err.txt | head -3)"
    exit 1
fi

# 2. 当前分支(仓库默认分支可能变化, 跟随 origin/HEAD)
CUR_BRANCH=$(git branch --show-current 2>/dev/null)
[ -z "$CUR_BRANCH" ] && CUR_BRANCH="$BRANCH"

# 3. 检查是否有新提交
BEHIND=$(git rev-list --count "HEAD..origin/$CUR_BRANCH" 2>/dev/null || echo 0)
if [ "${BEHIND:-0}" -eq 0 ] 2>/dev/null; then
    # 无更新 → 静默
    exit 0
fi

# 4. 有更新 → 尝试 fast-forward 拉取
LOCAL_OLD=$(git log --oneline -1 HEAD)
if ! git pull --ff-only origin "$CUR_BRANCH" 2>/tmp/mywechat_pull_err.txt; then
    echo "⚠️ 仓库有 $BEHIND 个新提交, 但自动拉取失败(可能有本地未提交改动):"
    echo "$(head -5 /tmp/mywechat_pull_err.txt)"
    exit 1
fi

# 5. 成功 → 输出更新摘要
echo "✅ my-wechat 已更新 ($CUR_BRANCH):"
echo "  $LOCAL_OLD"
git log --oneline -1 HEAD | sed 's/^/  → /'
echo "  共拉取 $BEHIND 个提交"
