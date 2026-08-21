#!/usr/bin/env python3
"""x_paths.py — 极小路径帮助模块：X 数据根目录一律从 DSH_X_FEED_DATA_DIR 派生。

迁移合同（Harness-X-信息流迁移-第一批落地指南 §7.2）：
- 生产每次调用必须由 X 业务运行时显式设置
  DSH_X_FEED_DATA_DIR=<resolveDshHome()>/storages/dsh-x-feed；
- 测试可以显式把环境变量指向临时目录；
- 未设置时回退到脚本树旁的 data/（等价原 WORKSPACE/data 布局，
  仅用于本地/迁移探针等非生产调用），不允许依赖进程当前工作目录。

所有运行脚本的默认数据路径（pipeline 的 DATA/package/timeline/shown/last
theme/collection/explore/wander/interest graph/topic aliases/锁文件，
collector 的 OUT，explorer 的 OUT_DIR，topic_search 的 DATA/OUT/ALIASES/
WANDER_STATE，neighborhood 的默认数据文件，timeline_store 的浏览器锁，
dedup/migrate 的默认输入）都必须从这里派生。
"""

import os

ENV_DATA_DIR = "DSH_X_FEED_DATA_DIR"


def data_dir():
    """X 数据根目录（不含尾部斜杠）。"""
    value = os.environ.get(ENV_DATA_DIR, "").strip()
    if value:
        return value.rstrip("/")
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "data")


def join(*parts):
    """data_dir() 下拼接路径。"""
    return os.path.join(data_dir(), *parts)
