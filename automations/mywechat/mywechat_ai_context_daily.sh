#!/usr/bin/env bash
# my-wechat 日报 AI 上下文: 近三天背景 + 过去24小时事件流
# 路径自适应(双机通用, 勿硬编码): 按 $HOME 探测仓库目录, 可用 MYWECHAT_DIR 覆盖
set -u

MYWECHAT_DIR="${MYWECHAT_DIR:-}"
if [ -z "$MYWECHAT_DIR" ]; then
    for cand in "$HOME/my-wechat"; do
        if [ -d "$cand" ] && [ -x "$cand/.venv/bin/python" ]; then
            MYWECHAT_DIR="$cand"
            break
        fi
    done
fi
if [ -z "$MYWECHAT_DIR" ] || [ ! -d "$MYWECHAT_DIR" ]; then
    echo "⚠️ my-wechat 仓库目录未找到(可设 MYWECHAT_DIR 覆盖)" >&2
    exit 1
fi

cd "$MYWECHAT_DIR" || exit 1
exec .venv/bin/python gen_ai_context.py 1440
