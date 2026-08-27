#!/usr/bin/env bash
# send_tg_ops.sh — 通过 ops 监控 bot 发送 Telegram 告警(后台通道专用)
# 用法: send_tg_ops.sh "消息文本"
# 从 ops profile 的 .env 读取 token/chat, 不经过 cron 投递(cron 走主 bot, 无法按 profile 路由)
# 双机通用: OPS_ENV 按 $HOME 定位(可用 OPS_ENV 覆盖); 失败时退出码非 0, 调用方决定是否回退
# 注意: 成功路径完全静默(不输出到 stdout), 避免污染 cron no_agent 投递
set -u

OPS_ENV="${OPS_ENV:-$HOME/.openclaw/profiles/ops/.env}"
TOKEN=""
CHAT=""

if [ ! -r "$OPS_ENV" ]; then
    echo "❌ send_tg_ops: 无法读取 $OPS_ENV" >&2
    exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        TELEGRAM_BOT_TOKEN=*) TOKEN="${line#*=}" ;;
        TELEGRAM_HOME_CHANNEL=*) CHAT="${line#*=}" ;;
    esac
done < "$OPS_ENV"

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    echo "❌ send_tg_ops: $OPS_ENV 缺少 TELEGRAM_BOT_TOKEN/TELEGRAM_HOME_CHANNEL" >&2
    exit 1
fi

MSG="${1:-（空消息）}"
if ! curl -sf -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT}" \
    --data-urlencode "text=${MSG}" \
    -o /dev/null 2>/dev/null; then
    echo "❌ send_tg_ops: Telegram 发送失败" >&2
    exit 1
fi
exit 0
