#!/bin/bash
# 提醒哨兵 — 前台交易系统迭代 + 后台蓝牙棒/包租婆(agent 跑), 每 15m 提醒
FLAG="$HOME/.openclaw/state/trade_ble_seen.flag"
[ -f "$FLAG" ] && exit 0   # 用户说完成 → touch 此文件; 空 stdout = 静默不发送
echo "⏰ 15分钟到了: 交易系统迭代进度如何? 顺便看下后台 agent 的蓝牙棒/包租婆进度, 喝口水。完成/看了后跟我说一声就停。"
