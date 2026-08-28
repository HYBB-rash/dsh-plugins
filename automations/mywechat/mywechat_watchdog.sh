#!/usr/bin/env bash
# my-wechat 同步监控看门狗(双机通用: herman 机 / rita 机)
# 1) 微信进程 / sync 守护 / 心跳新鲜度 监控(异常输出告警)
# 2) 告警通道: 显式配置 ops bot 时走 Telegram(stdout 静默),
#    否则回退 stdout，由调度器负责投递
# 路径自适应: 按 $HOME 探测仓库目录与健康文件, 可用环境变量覆盖(双机共用, 勿硬编码路径)
set -u

# ── 机器路径自适应 ──
MYWECHAT_DIR="${MYWECHAT_DIR:-}"
if [ -z "$MYWECHAT_DIR" ]; then
    for cand in "$HOME/my-wechat"; do
        if [ -d "$cand" ] && ls "$cand"/published_*.db >/dev/null 2>&1; then
            MYWECHAT_DIR="$cand"
            break
        fi
    done
fi
if [ -z "$MYWECHAT_DIR" ] || [ ! -d "$MYWECHAT_DIR" ]; then
    echo "⚠️ my-wechat 仓库目录未找到(可设 MYWECHAT_DIR 覆盖)"
    exit 1
fi

HEALTH_FILE="${MYWECHAT_HEALTH_FILE:-$(ls "$MYWECHAT_DIR"/sync_health_*.json 2>/dev/null | grep -v 'qq' | head -1)}"
QQ_HEALTH_FILE="${MYWECHAT_QQ_HEALTH_FILE:-$(ls "$MYWECHAT_DIR"/sync_health_qq_*.json 2>/dev/null | head -1)}"
AUTOMATIONS_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SEND_TG="${SEND_TG:-$AUTOMATIONS_DIR/telegram/send_tg_ops.sh}"

WX_PATTERN="WeChatAppEx|wechat"
SYNC_PATTERN="sync.py --interval"
MAX_HEARTBEAT_AGE=1200   # updated_at 超过 20 分钟未更新视为同步停止(sync 间隔 17 分钟, 留余量)

alerts=""

# ── 1. 微信进程 ──
if ! pgrep -f "$WX_PATTERN" >/dev/null 2>&1; then
    alerts="${alerts}⚠️ 微信进程未运行(WeChat 挂了)\n"
fi

# ── 2. sync 守护进程 ──
if ! pgrep -f "$SYNC_PATTERN" >/dev/null 2>&1; then
    alerts="${alerts}⚠️ 增量同步守护进程未运行(sync.py 挂了)\n"
fi

# ── 2b. QQ 同步守护 + 心跳(仅该机存在 QQ 健康文件时监控; 无则跳过, 避免跨机误报) ──
if [ -n "$QQ_HEALTH_FILE" ] && [ -f "$QQ_HEALTH_FILE" ]; then
    if ! pgrep -f "qq_sync.py" >/dev/null 2>&1; then
        alerts="${alerts}⚠️ QQ 同步守护进程未运行(qq_sync.py 挂了)\n"
    fi
    qq_upd=$(python3 -c "import json;print(json.load(open('$QQ_HEALTH_FILE')).get('updated_at',''))" 2>/dev/null)
    if [ -n "$qq_upd" ]; then
        qq_upd_ts=$(date -d "$qq_upd" +%s 2>/dev/null || echo 0)
        qq_now=$(date +%s)
        qq_age=$(( qq_now - qq_upd_ts ))
        if [ "$qq_age" -gt "$MAX_HEARTBEAT_AGE" ]; then
            alerts="${alerts}⚠️ QQ 同步心跳已 ${qq_age}s 未更新(可能卡死/停止)\n"
        fi
    fi
    qq_ok=$(python3 -c "import json;print(json.load(open('$QQ_HEALTH_FILE')).get('sync_ok',1))" 2>/dev/null)
    if [ "$qq_ok" = "0" ]; then
        alerts="${alerts}⚠️ 最近一轮 QQ 同步失败(sync_ok=0)\n"
    fi
fi

# ── 3. 微信同步心跳新鲜度 ──
if [ -n "$HEALTH_FILE" ] && [ -f "$HEALTH_FILE" ]; then
    upd=$(python3 -c "import json;print(json.load(open('$HEALTH_FILE')).get('updated_at',''))" 2>/dev/null)
    if [ -n "$upd" ]; then
        upd_ts=$(date -d "$upd" +%s 2>/dev/null || echo 0)
        now=$(date +%s)
        age=$(( now - upd_ts ))
        if [ "$age" -gt "$MAX_HEARTBEAT_AGE" ]; then
            alerts="${alerts}⚠️ 同步心跳已 ${age}s 未更新(可能卡死/停止)\n"
        fi
    fi
    ok=$(python3 -c "import json;print(json.load(open('$HEALTH_FILE')).get('last_sync_ok',True))" 2>/dev/null)
    if [ "$ok" = "False" ] || [ "$ok" = "false" ]; then
        alerts="${alerts}⚠️ 最近一轮同步失败(last_sync_ok=false)\n"
    fi
else
    alerts="${alerts}⚠️ 健康状态文件缺失(sync 可能从未成功运行)\n"
fi

# ── 输出: TG 优先(本机有 ops profile 时), 失败/缺失回退 stdout → cron 投递 ──
if [ -n "$alerts" ]; then
    body="$(printf '📡 my-wechat 同步监控:\n%b' "$alerts")"
    if [ -x "$SEND_TG" ] && bash "$SEND_TG" "$body" 2>/dev/null; then
        :  # TG 已送达 → stdout 留空 → no_agent cron 静默
    else
        printf '%s\n' "$body"  # 回退: stdout → cron 投递(origin)
    fi
fi
