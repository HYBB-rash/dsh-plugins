#!/bin/bash
# 提醒哨兵 — 交易系统迭代优化(用户自己做), 每 15m 提醒
FLAG="$HOME/.openclaw/state/trade_system_seen.flag"
[ -f "$FLAG" ] && exit 0   # 用户说完成 → touch 此文件; 空 stdout = 静默不发送
echo "⏰ 15分钟到了: 交易系统问题分析进度如何? 顺便喝口水。完成/看了后跟我说一声就停。"
