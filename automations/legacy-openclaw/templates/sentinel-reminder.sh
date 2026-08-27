#!/bin/bash
# 提醒哨兵脚本模板 — 用法见 SKILL.md §6
# 复制为 ~/.openclaw/workspace/scripts/<name>_reminder.sh, 替换 <name> 与提醒文案
FLAG="$HOME/.openclaw/state/<name>_seen.flag"
[ -f "$FLAG" ] && exit 0   # 用户说完成 → touch 此文件; no_agent 空 stdout = 静默不发送
echo "⏰ <提醒文案, 含'完成/看了后跟我说一声就停'>"
