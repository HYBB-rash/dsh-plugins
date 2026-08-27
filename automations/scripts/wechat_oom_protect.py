#!/usr/bin/env python3
"""微信 OOM 保护守护进程。

把微信相关进程的 oom_score_adj 调为 -600,使系统内存紧张时
OOM killer 优先杀其他进程(浏览器等),而不是微信。

微信是 flatpak 启动的,scope 名每次启动都变,无法用 systemd 静态配置,
所以用循环监控的方式持续修正。

用法: 由 systemd user service (wechat-oom-protect.service) 常驻运行。
"""
import os
import subprocess
import time

TARGET_ADJ = -600
CHECK_INTERVAL = 5
# 微信相关进程关键字(路径特征,避免误伤)
KEYWORDS = (
    "/app/extra/wechat",
    "RadiumWMPF",
    "WeChatAppEx",
    "wxocr",
)

def wechat_pids():
    """返回所有微信相关进程 PID 集合。"""
    pids = set()
    try:
        out = subprocess.run(
            ["pgrep", "-f", "/app/extra/wechat|RadiumWMPF|WeChatAppEx"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                pids.add(int(line))
    except Exception:
        pass
    return pids

def adjust(pid):
    """将单进程 oom_score_adj 调为目标值(负数降低被杀优先级)。"""
    path = f"/proc/{pid}/oom_score_adj"
    try:
        with open(path, "r") as f:
            cur = int(f.read().strip())
        if cur != TARGET_ADJ:
            with open(path, "w") as f:
                f.write(str(TARGET_ADJ))
            return True
    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
        pass
    return False

def main():
    # 首次运行立即调整一轮
    for pid in wechat_pids():
        if adjust(pid):
            print(f"[oom-protect] wechat pid {pid} oom_score_adj -> {TARGET_ADJ}", flush=True)
    while True:
        time.sleep(CHECK_INTERVAL)
        for pid in wechat_pids():
            if adjust(pid):
                print(f"[oom-protect] wechat pid {pid} oom_score_adj -> {TARGET_ADJ}", flush=True)

if __name__ == "__main__":
    main()
