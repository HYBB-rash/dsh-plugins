#!/usr/bin/env bash
# DeepSeek Token 日报生成(每日): 余额 + 昨日最烧token操作
cd /home/herman/deepseek-usage-report || exit 1
exec python3 deepseek_report.py
