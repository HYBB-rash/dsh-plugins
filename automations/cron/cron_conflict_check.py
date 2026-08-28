#!/usr/bin/env python3
"""cron 投递时间冲突检查器(30s 冷却墙)。

用法:
  python3 cron_conflict_check.py "HH:MM"          # 今天/最近的 HH:MM
  python3 cron_conflict_check.py "MM-DD HH:MM"    # 指定日期
  python3 cron_conflict_check.py "every 2h"       # 或直接给 cron schedule 字符串

逻辑:
  - 折叠 DSH cron 的 jobs.jsonl，并读取 runs.jsonl 的最新 nextRunAt
  - 计算候选时间与每个任务下次投递时刻的最小间隔
  - 微信 iLink 冷却墙 = 30s; 稳妥建议错开 ≥60s(1 分钟)
  - 输出: 安全 / ⚠️ 紧贴 / ❌ 冲突 + 建议时间
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta

DSH_HOME = os.path.expanduser(os.environ.get("DSH_HOME", "~/.dsh"))
JOBS_FILE = os.environ.get(
    "DSH_CRON_JOBS_FILE", os.path.join(DSH_HOME, "storages/dsh-cron/jobs.jsonl"))
RUNS_FILE = os.environ.get(
    "DSH_CRON_RUNS_FILE", os.path.join(DSH_HOME, "storages/dsh-cron/runs.jsonl"))
COOLDOWN_S = 30      # 微信 iLink 冷却墙
SAFE_GAP_S = 60      # 建议的最小安全间隔

CRON_FIELD_RE = re.compile(r"^([0-9*/,-]+) ([0-9*/,-]+) ([0-9*/,-]+) ([0-9*/,-]+) ([0-9*/,-]+)$")


def _read_jsonl(path):
    """Read valid JSON objects, ignoring blank or partially written rows."""
    try:
        with open(path, encoding="utf-8") as f:
            rows = f.readlines()
    except OSError as exc:
        print(f"⚠️ 无法读取 {path}: {exc}")
        return []
    parsed = []
    for row in rows:
        try:
            value = json.loads(row)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            parsed.append(value)
    return parsed


def load_jobs(jobs_file=JOBS_FILE, runs_file=RUNS_FILE):
    """Fold the DSH append-only ledgers into active Telegram job schedules."""
    active = {}
    for row in _read_jsonl(jobs_file):
        job_id = row.get("id")
        if not isinstance(job_id, str):
            continue
        if row.get("op") == "create":
            active[job_id] = row
        elif row.get("op") == "delete":
            active.pop(job_id, None)

    next_runs = {}
    for row in _read_jsonl(runs_file):
        job_id = row.get("jobId")
        next_run = row.get("nextRunAt")
        if isinstance(job_id, str) and isinstance(next_run, str):
            next_runs[job_id] = next_run

    jobs = []
    for job_id, row in active.items():
        if row.get("deliver") != "telegram" or not isinstance(row.get("schedule"), dict):
            continue
        jobs.append({
            "id": job_id,
            "name": row.get("externalRef") or job_id,
            "schedule": row["schedule"],
            "created_at": row.get("createdAt", ""),
            "next_run_at": next_runs.get(job_id, ""),
        })
    return jobs


def cron_matches_in_range(cron_expr, start, end, step_s=30):
    """枚举 cron 表达式在 [start, end] 区间内的所有匹配时刻(30s 步进)。

    只支持本项目用到的 5 字段 cron(分/时; */N 或数字或 *)。
    """
    m = CRON_FIELD_RE.match(cron_expr)
    if not m:
        return []
    minute_f, hour_f, dom_f, mon_f, dow_f = m.groups()

    def expand(field):
        if field == "*":
            return None  # 任意
        if field.startswith("*/"):
            return ("step", int(field[2:]))
        if re.fullmatch(r"\d+", field):
            return ("eq", int(field))
        return ("bad", field)  # 不支持的格式

    mf, hf = expand(minute_f), expand(hour_f)
    # None = 任意字段(合法); 只有 bad 才是解析失败
    if (mf is not None and mf[0] == "bad") or (hf is not None and hf[0] == "bad"):
        return []

    matches = []
    t = start.replace(second=0, microsecond=0)
    while t <= end:
        ok_min = (mf is None or
                  (mf[0] == "step" and t.minute % mf[1] == 0) or
                  (mf[0] == "eq" and t.minute == mf[1]))
        ok_hour = (hf is None or
                   (hf[0] == "step" and t.hour % hf[1] == 0) or
                   (hf[0] == "eq" and t.hour == hf[1]))
        if ok_min and ok_hour:
            matches.append(t)
        t += timedelta(seconds=step_s)
    return matches


def cron_to_next(cron_expr, now):
    """极简 5 字段 cron 解析: 只处理分/时两字段(本项目任务都是小时级)。"""
    m = CRON_FIELD_RE.match(cron_expr)
    if not m:
        return None
    minute_f, hour_f, dom_f, mon_f, dow_f = m.groups()
    # 只支持 "*" 或 "*/N" 或数字(够用: 本项目都是 0 * * * * 级别)
    def expand(field):
        if field == "*":
            return None  # 任意
        if field.startswith("*/"):
            return ("step", int(field[2:]))
        if re.fullmatch(r"\d+", field):
            return ("eq", int(field))
        return ("bad", field)
    mf, hf = expand(minute_f), expand(hour_f)
    # None = 任意字段(合法); 只有 bad 才是解析失败
    if (mf is not None and mf[0] == "bad") or (hf is not None and hf[0] == "bad"):
        return None
    for delta_min in range(0, 60 * 24):
        t = now + timedelta(minutes=delta_min)
        ok_min = mf is None or (mf[0] == "step" and t.minute % mf[1] == 0) or (mf[0] == "eq" and t.minute == mf[1])
        ok_hour = hf is None or (hf[0] == "step" and t.hour % hf[1] == 0) or (hf[0] == "eq" and t.hour == hf[1])
        if ok_min and ok_hour:
            return t
    return None


def _parse_iso(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def events_for_job(job, start, end):
    """Return DSH schedule occurrences in a bounded local-time window."""
    schedule = job.get("schedule") or {}
    kind = schedule.get("kind")
    if kind == "cron":
        return cron_matches_in_range(schedule.get("expr", ""), start, end)
    if kind == "once":
        run_at = _parse_iso(schedule.get("runAt"))
        return [run_at] if run_at is not None and start <= run_at <= end else []
    if kind != "interval":
        return []
    try:
        period = timedelta(minutes=int(schedule["minutes"]))
    except (KeyError, TypeError, ValueError):
        return []
    if period.total_seconds() <= 0:
        return []
    cursor = _parse_iso(job.get("next_run_at"))
    if cursor is None:
        created = _parse_iso(job.get("created_at"))
        cursor = created + period if created is not None else None
    if cursor is None:
        return []
    while cursor < start:
        cursor += period
    events = []
    while cursor <= end:
        events.append(cursor)
        cursor += period
    return events


def next_event(job, now):
    end = now + timedelta(days=8)
    events = events_for_job(job, now, end)
    return min(events) if events else None


def parse_candidate(text, now):
    """把用户给的时刻文本解析成 datetime。"""
    text = text.strip()
    # 1. "every 2h" / "every 60m" 形式的相对周期
    m = re.fullmatch(r"every\s+(\d+)\s*(h|m|s)?", text, re.I)
    if m:
        n = int(m.group(1))
        unit = (m.group(2) or "h").lower()
        if unit == "h":
            return now + timedelta(hours=n)
        if unit == "m":
            return now + timedelta(minutes=n)
        return now + timedelta(seconds=n)
    # 2. "HH:MM" (可能带日期)
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", text)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        cand = now.replace(hour=h, minute=mi, second=0, microsecond=0)
        if cand < now:
            cand += timedelta(days=1)  # 已过 → 明天
        return cand
    # 3. "MM-DD HH:MM"
    m = re.fullmatch(r"(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})", text)
    if m:
        mo, d, h, mi = map(int, m.groups())
        return now.replace(month=mo, day=d, hour=h, minute=mi, second=0, microsecond=0)
    # 4. "N 分钟后" / "N分钟后" / "in N minutes"
    m = re.fullmatch(r"(\d+)\s*(分钟|分|分钟后|minutes?|mins?)?(后)?", text)
    if m and ("分" in text or "min" in text.lower()):
        return now + timedelta(minutes=int(m.group(1)))
    return None


def main():
    ap = argparse.ArgumentParser(description="cron 投递时间冲突检查")
    ap.add_argument("when", nargs="?", default="",
                    help="候选时间: HH:MM / MM-DD HH:MM / every 2h / N分钟后")
    args = ap.parse_args()
    now = datetime.now()

    jobs = load_jobs()
    if not jobs:
        print("(无已启用的 cron 任务)")
        return

    if args.when:
        cand = parse_candidate(args.when, now)
        if cand is None:
            print(f"⚠️ 无法解析时间: {args.when!r}(支持 HH:MM / MM-DD HH:MM / every 2h / N分钟后)")
            return
        print(f"候选时间: {cand.strftime('%m-%d %H:%M')}")
        if cand < now:
            print("  ⚠️ 该时间已过")
            return
    else:
        # 不带参数: 只看当前时刻表
        for j in jobs:
            t = next_event(j, now)
            if t:
                print(f"  {t.strftime('%m-%d %H:%M')}  {j['name']}")
        return

    # 收集所有任务在候选时间 ±90 分钟内的所有投递时刻(周期任务会多次命中)
    schedule_events = []
    for j in jobs:
        events = events_for_job(
            j, cand - timedelta(minutes=90), cand + timedelta(minutes=90))
        for t in events:
            schedule_events.append((j["name"], t))

    if not schedule_events:
        print("\n(无法解析任何 cron 时刻, 检查失败)")
        return

    # 找候选时间最近的前后投递
    before = [(name, t) for name, t in schedule_events if t <= cand]
    after = [(name, t) for name, t in schedule_events if t > cand]
    nearest_before = max(before, key=lambda x: x[1]) if before else None
    nearest_after = min(after, key=lambda x: x[1]) if after else None

    gaps = []
    if nearest_before:
        gaps.append(("上一个", cand - nearest_before[1], nearest_before))
    if nearest_after:
        gaps.append(("下一个", nearest_after[1] - cand, nearest_after))

    # 取最小间隔 = 最危险(冷却墙是下限, 间隔越小越容易撞)
    worst = min(gs for _, gs, _ in [(l, int(g.total_seconds()), t) for l, g, t in gaps]) if gaps else SAFE_GAP_S
    for label, gap, (name, t) in gaps:
        gs = int(gap.total_seconds())
        mark = "❌" if gs < COOLDOWN_S else ("⚠️" if gs < SAFE_GAP_S else "✅")
        print(f"  {mark} 与{label}「{name}」间隔 {gs}s (冷却墙 {COOLDOWN_S}s, 建议 ≥{SAFE_GAP_S}s)")

    if worst >= SAFE_GAP_S:
        print(f"\n✅ 安全: 与所有投递时刻间隔 ≥{SAFE_GAP_S}s, 不会撞冷却墙")
    elif worst >= COOLDOWN_S:
        print(f"\n⚠️ 紧贴: 间隔 {worst}s (>30s 冷却墙但 <60s 稳妥线)")
        print(f"   建议: 错开 1 分钟 → { (cand + timedelta(minutes=1)).strftime('%H:%M') } "
              f"或 { (cand - timedelta(minutes=1)).strftime('%H:%M') }")
    else:
        print(f"\n❌ 冲突: 间隔 {worst}s < 冷却墙 {COOLDOWN_S}s, 必撞限流!")
        print(f"   建议: 顺延 1 分钟 → { (cand + timedelta(minutes=1)).strftime('%H:%M') } "
              f"或提前到 { (cand - timedelta(minutes=1)).strftime('%H:%M') }")


if __name__ == "__main__":
    main()
