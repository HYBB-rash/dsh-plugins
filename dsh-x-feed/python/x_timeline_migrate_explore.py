#!/usr/bin/env python3
"""x_timeline_migrate_explore.py — 一次性迁移: 旧 topic 行搬入独立探索文件。

问题: 历史 x_timeline.jsonl 混入大量带 topic 字段的搜索结果行(羽毛球/Codex Linux…),
导致 analyze() 窗口被污染、空批次回填出陈旧漫游候选。

方案(架构裁决):
- 主时间线只保留纯采集行(原样字节保留, 含坏行), 探索行(id/url/text/source/ts + topic/anchor/bridge/hop)
  转入 x_explore_items.jsonl(独立探索流, 永不再入主时间线)。
- 默认 dry-run 只报告; --apply 才落盘。
- apply 时: 备份 timeline/explore(.bak-<ts>-<rand6>) → flock 临界区 → 原子替换; 幂等(重复 apply = noop)。

用法:
  python3 x_timeline_migrate_explore.py [--timeline data/x_timeline.jsonl] [--explore data/x_explore_items.jsonl]
  python3 x_timeline_migrate_explore.py [--timeline ...] [--explore ...] --apply
"""
import argparse
import json
import os
import random
import shutil
import sys
import tempfile
import time
from pathlib import Path

import x_timeline_store as timeline_store
import x_paths

DEFAULT_TIMELINE = os.path.join(x_paths.data_dir(), "x_timeline.jsonl")
DEFAULT_EXPLORE = os.path.join(x_paths.data_dir(), "x_explore_items.jsonl")


def is_explore_record(record):
    """探索行判定: 带 topic 字段或 kind == explore。"""
    return "topic" in record or record.get("kind") == "explore"


def partition_lines(lines):
    """把原始行分成 (纯行列表[raw str], 探索行列表[dict])。

    坏行/非对象行原样留在主时间线(与 dedup 工具一致, 不静默改写历史)。
    """
    pure_lines = []
    explore_records = []
    for raw in lines:
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            pure_lines.append(raw)
            continue
        if not isinstance(value, dict):
            pure_lines.append(raw)
            continue
        if is_explore_record(value):
            explore_records.append(value)
        else:
            pure_lines.append(raw)
    return pure_lines, explore_records


def _read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, errors="replace") as f:
        return [line.rstrip("\n") for line in f]


def _backup_path(path):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{path}.bak-{stamp}-{random.randint(100000, 999999)}"


def _atomic_write_lines(path, lines):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".jsonl", dir=parent, text=True)
    try:
        with os.fdopen(fd, "w") as f:
            for line in lines:
                f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def migrate(timeline_path, explore_path, apply=False):
    """分区迁移; 默认 dry-run。返回结构化摘要; 幂等。"""
    tl = str(timeline_path)
    ex = str(explore_path)
    if not os.path.exists(tl):
        return {"ok": False, "err": f"timeline 不存在: {tl}"}

    # 锁顺序: 先 timeline 写锁, 再 explore 写锁, 再迁移专用锁(无环)
    with timeline_store.file_lock(tl + ".lock"):
        with timeline_store.file_lock(ex + ".lock"):
            with timeline_store.file_lock(tl + ".migrate.lock"):
                lines = _read_lines(tl)
                pure_lines, explore_records = partition_lines(lines)
                existing_lines = _read_lines(ex)
                known = set()
                for raw in existing_lines:
                    try:
                        value = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(value, dict):
                        known.add(timeline_store.record_key(value))
                to_move = [r for r in explore_records
                           if timeline_store.record_key(r) not in known]

                summary = {
                    "ok": True,
                    "apply": bool(apply),
                    "dry_run": not apply,
                    "timeline_lines_total": len(lines),
                    "timeline_pure": len(pure_lines),
                    "explore_rows_found": len(explore_records),
                    "explore_rows_new": len(to_move),
                    "moved": len(to_move),
                }

                if not apply:
                    summary["applied"] = False
                    return summary

                if not to_move:
                    # 幂等: 无新迁移 → 不重复备份、不改文件
                    summary["applied"] = True
                    summary["noop"] = True
                    summary["backups"] = []
                    return summary

                backups = []
                timeline_bak = _backup_path(tl)
                shutil.copy2(tl, timeline_bak)
                backups.append(timeline_bak)
                if existing_lines:
                    explore_bak = _backup_path(ex)
                    shutil.copy2(ex, explore_bak)
                    backups.append(explore_bak)

                new_timeline_lines = pure_lines  # 纯行 + 坏行, 原样保留
                moved_lines = [json.dumps(r, ensure_ascii=False, separators=(",", ":"))
                               for r in to_move]
                new_explore_lines = existing_lines + moved_lines

                _atomic_write_lines(tl, new_timeline_lines)
                _atomic_write_lines(ex, new_explore_lines)

                summary["applied"] = True
                summary["noop"] = False
                summary["backups"] = backups
                return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeline", default=DEFAULT_TIMELINE, help="主时间线 jsonl")
    parser.add_argument("--explore", default=DEFAULT_EXPLORE, help="探索流 jsonl")
    parser.add_argument("--apply", action="store_true", help="落盘(默认 dry-run)")
    args = parser.parse_args(argv)
    result = migrate(args.timeline, args.explore, apply=args.apply)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
