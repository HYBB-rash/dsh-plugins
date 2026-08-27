#!/bin/bash
# OpenClaw 上游代码库周报(command payload,零模型成本,每周一 09:10)
# 汇总近 7 天:提交数/类型/合并PR/Release/贡献者;gh 已授权则含 PR+Release 数据,未授权自动降级 git-only
REPO=/home/herman/openclaw-upstream
LOG=$REPO/.weekly-update.log

cd "$REPO" || { echo "NO_REPLY"; exit 0; }
git pull --ff-only -q >>"$LOG" 2>&1 || true

SINCE=$(date -d '7 days ago' +%Y-%m-%d)
TODAY=$(date +%m-%d)
COUNT=$(git log --oneline --no-merges --since="$SINCE" 2>/dev/null | wc -l)
[ "$COUNT" -eq 0 ] && { echo "NO_REPLY"; exit 0; }

{
  echo "📦 OpenClaw 代码库周报 ($(date -d '7 days ago' +%m-%d) ~ $TODAY)"
  echo "本周新增 $COUNT 个提交"
  echo ""
  echo "【按类型】"
  for t in feat fix refactor docs test chore perf; do
    n=$(git log --pretty=format:'%s' --no-merges --since="$SINCE" 2>/dev/null | grep -ic "^$t[:(]" || true)
    [ "$n" -gt 0 ] && echo "- $t: $n"
  done
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo ""
    echo "【合并 PR】"
    gh api "search/issues?q=repo:openclaw/openclaw+is:pr+is:merged+merged:>=$SINCE&per_page=10" \
      --jq '.items[] | "- #\(.number) \(.title)"' 2>/dev/null | head -10
    echo ""
    echo "【Release】"
    gh api "repos/openclaw/openclaw/releases?per_page=10" \
      --jq '.[] | select(.published_at >= "'$SINCE'T00:00:00Z") | "- \(.tag_name): \(.name)"' 2>/dev/null | head -5
  fi
  echo ""
  echo "【主要贡献者】"
  git log --format='%an' --no-merges --since="$SINCE" 2>/dev/null | sort | uniq -c | sort -rn | head -5 | awk '{print "- "$2": "$1" commits"}'
  echo ""
  echo "【提交列表】"
  git log --pretty=format:'%h %s' --no-merges --since="$SINCE" 2>/dev/null | head -30
  echo ""
} > /tmp/openclaw-weekly.txt
cat /tmp/openclaw-weekly.txt
