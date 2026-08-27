#!/usr/bin/env bash
# send_tg_ops.sh — 通过 ops 监控 bot 发送 Telegram 告警(后台通道专用)
# 用法: send_tg_ops.sh "消息文本"
# 从显式环境变量或 OPS_ENV 读取 token/chat，不绑定任何已安装运行时。
# 失败时退出码非 0，由调用方决定是否回退。
# 注意: 成功路径完全静默(不输出到 stdout), 避免污染 cron no_agent 投递
set -u

OPS_ENV="${OPS_ENV:-}"
TOKEN="${TELEGRAM_OPS_BOT_TOKEN:-}"
CHAT="${TELEGRAM_OPS_CHAT_ID:-}"

if [ -n "$OPS_ENV" ] && [ ! -r "$OPS_ENV" ]; then
    echo "❌ send_tg_ops: 无法读取 $OPS_ENV" >&2
    exit 1
fi

if [ -n "$OPS_ENV" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            TELEGRAM_BOT_TOKEN=*) TOKEN="${line#*=}" ;;
            TELEGRAM_HOME_CHANNEL=*) CHAT="${line#*=}" ;;
        esac
    done < "$OPS_ENV"
fi

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    echo "❌ send_tg_ops: 需设置 TELEGRAM_OPS_BOT_TOKEN/TELEGRAM_OPS_CHAT_ID，或显式 OPS_ENV" >&2
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
