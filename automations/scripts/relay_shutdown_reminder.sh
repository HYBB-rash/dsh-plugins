#!/bin/bash
# 提醒哨兵 — 停用中转站收尾(用户派 agent 后台跑, 每 15m 提醒看进度)
STATE_DIR="${DSH_AUTOMATION_STATE_DIR:-${DSH_HOME:-$HOME/.dsh}/storages/automations}"
FLAG="$STATE_DIR/relay_shutdown_seen.flag"
[ -f "$FLAG" ] && exit 0   # 用户说完成 → touch 此文件; 空 stdout = 静默不发送
echo "⏰ 15分钟到了:去看下后台 agent 跑的中转站收尾进度, 顺便喝口水。完成/看了后跟我说一声就停。"
