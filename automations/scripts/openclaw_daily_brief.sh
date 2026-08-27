#!/bin/bash
# OpenClaw 上游代码库每日更新简报(command payload,零模型成本)
# 每天由 cron 调用:git pull 保持镜像最新;有新提交则输出简报(announce 投递到 Telegram),无更新输出 NO_REPLY 静默
REPO=/home/herman/openclaw-upstream
STATE=$REPO/.last-brief-sha
LOG=$REPO/.daily-update.log

cd "$REPO" || { echo "NO_REPLY"; exit 0; }

# 拉取更新(失败不阻断,下次再试)
git pull --ff-only -q >>"$LOG" 2>&1 || true

NEW=$(git rev-parse HEAD 2>/dev/null)
[ -z "$NEW" ] && { echo "NO_REPLY"; exit 0; }

PREV=$(cat "$STATE" 2>/dev/null)
if [ -z "$PREV" ]; then
  # 首次运行:只记基线,不打扰
  echo "$NEW" > "$STATE"
  echo "NO_REPLY"
  exit 0
fi

[ "$NEW" = "$PREV" ] && { echo "NO_REPLY"; exit 0; }

COUNT=$(git rev-list --count "$PREV..$NEW" 2>/dev/null || echo 0)

{
  echo "📦 OpenClaw 代码库更新简报 ($(date '+%m-%d'))"
  echo "新增 $COUNT 个提交 ($(echo "$PREV" | cut -c1-7)..$(echo "$NEW" | cut -c1-7))"
  echo ""
  echo "【按类型】"
  for t in feat fix refactor docs test chore perf; do
    n=$(git log --pretty=format:'%s' --no-merges "$PREV..$NEW" 2>/dev/null | grep -ic "^$t[:(]" || true)
    [ "$n" -gt 0 ] && echo "- $t: $n"
  done
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo ""
    echo "【今日合并 PR】"
    gh api "search/issues?q=repo:openclaw/openclaw+is:pr+is:merged+merged:>=$(date '+%Y-%m-%d')&per_page=5" \
      --jq '.items[] | "- #\(.number) \(.title)"' 2>/dev/null | head -5
    echo ""
    echo "【Release】"
    gh api "repos/openclaw/openclaw/releases?per_page=3" \
      --jq '.[] | select(.published_at >= "'$(date '+%Y-%m-%d')'T00:00:00Z") | "- \(.tag_name): \(.name)"' 2>/dev/null | head -3
  fi
  echo ""
  echo "【提交列表】"
  git log --pretty=format:'%h %s' --no-merges "$PREV..$NEW" 2>/dev/null | head -40
  echo ""
} > /tmp/openclaw-brief.txt

# 更新基线(简报已生成)
echo "$NEW" > "$STATE"
cat /tmp/openclaw-brief.txt
