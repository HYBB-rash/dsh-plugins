#!/usr/bin/env python3
"""Build a read-only daily material package from the shared X timeline.

The timeline is an append-only input.  This command never opens a browser,
never calls a collector, and never mutates the timeline or its ledgers.
Collection day is determined exclusively from ``ts`` in Asia/Shanghai;
``time`` is retained only as tweet metadata for the semantic report layer.

Examples:
    python3 scripts/x_daily_report.py --day 2026-08-13 --out data/x_daily/2026-08-13.json
    python3 scripts/x_daily_report.py --timeline data/x_timeline.jsonl --dry-run
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import insight_engine
import x_timeline_store


HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
DEFAULT_TIMELINE = WORKSPACE / "data" / "x_timeline.jsonl"
SHANGHAI = ZoneInfo("Asia/Shanghai")
SOURCE = "x"
CORE_FIELDS = ("id", "url", "text")
QUALITY_KEYS = ("invalid_json", "not_object", "missing_fields", "invalid_ts", "missing_ts")


def _empty_quality() -> dict[str, int]:
    return {key: 0 for key in QUALITY_KEYS}


def _empty_filters() -> dict[str, int]:
    return {
        "test_label": 0,
        "before_epoch": 0,
        "explicit_exclusion": 0,
        "duplicates": 0,
    }


def _valid_ts(value: Any) -> bool:
    """True iff ``value`` is a number ``datetime.fromtimestamp`` can map to a day.

    Rejects booleans, non-numbers, values that overflow ``float()`` (e.g. huge
    ints like ``10**400``), non-finite values (inf/nan), and finite values
    outside the platform time range (e.g. ``1e20``) so that extreme numeric
    timestamps are counted as ``invalid_ts`` instead of crashing the build.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        fval = float(value)
    except (OverflowError, ValueError):
        return False
    if not math.isfinite(fval):
        return False
    try:
        dt.datetime.fromtimestamp(fval, tz=SHANGHAI)
    except (OverflowError, OSError, ValueError):
        return False
    return True


def _day_from_ts(value: int | float) -> str:
    return dt.datetime.fromtimestamp(float(value), tz=SHANGHAI).date().isoformat()


def _parse_day(value: str) -> str:
    try:
        parsed = dt.date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid day (expected YYYY-MM-DD): {value!r}") from exc
    normalized = parsed.isoformat()
    if normalized != value:
        raise ValueError(f"invalid day (expected YYYY-MM-DD): {value!r}")
    return normalized


def _record_aliases(record: dict[str, Any]) -> set[tuple[str, str]]:
    """Return writer-compatible identity aliases for defensive report dedup.

    ``record_key`` is the canonical writer identity.  URL/status aliases are
    also retained so a malformed historical row whose id disagrees with its
    status URL cannot appear twice in one report.
    """
    aliases = {x_timeline_store.record_key(record)}
    status = x_timeline_store.status_id(record.get("id"))
    url_status = x_timeline_store.status_id(record.get("url"))
    canonical = x_timeline_store.canonical_url(record.get("url"))
    if status:
        aliases.add(("id", status))
    if url_status:
        aliases.add(("id", url_status))
    if canonical:
        aliases.add(("url", canonical))
    return aliases


def _read_exclusions(path: os.PathLike[str] | str | None) -> tuple[set[str], set[tuple[str, str]]]:
    """Read one id/url per line; blank and comment lines are ignored."""
    ids: set[str] = set()
    keys: set[tuple[str, str]] = set()
    if not path:
        return ids, keys
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            value = raw.strip()
            if not value or value.startswith("#"):
                continue
            ids.add(value)
            status = x_timeline_store.status_id(value)
            canonical = x_timeline_store.canonical_url(value)
            if status:
                keys.add(("id", status))
            if canonical:
                keys.add(("url", canonical))
    return ids, keys


def _is_explicitly_excluded(record: dict[str, Any], ids: set[str], keys: set[tuple[str, str]]) -> bool:
    if str(record.get("id", "")) in ids or str(record.get("url", "")) in ids:
        return True
    return bool(_record_aliases(record) & keys)


def _normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(record)
    value.setdefault("source", SOURCE)
    value.setdefault("label", "prod")
    return value


def _load_records(path: os.PathLike[str] | str) -> tuple[list[dict[str, Any]], dict[str, int], int]:
    """Read JSONL without changing it, returning valid records and quality data."""
    records: list[dict[str, Any]] = []
    quality = _empty_quality()
    total = 0
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            total += 1
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                quality["invalid_json"] += 1
                continue
            if not isinstance(value, dict):
                quality["not_object"] += 1
                continue
            missing = [field for field in CORE_FIELDS if not value.get(field)]
            if missing:
                quality["missing_fields"] += 1
                continue
            if "ts" not in value:
                quality["missing_ts"] += 1
                continue
            if not _valid_ts(value.get("ts")):
                quality["invalid_ts"] += 1
                continue
            records.append(value)
    return records, quality, total


def _dedupe(records: Iterable[dict[str, Any]], filters: dict[str, int]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    known: set[tuple[str, str]] = set()
    for record in records:
        aliases = _record_aliases(record)
        if aliases & known:
            filters["duplicates"] += 1
            continue
        known.update(aliases)
        selected.append(_normalize_record(record))
    return selected


def _seed_for_day(day: str) -> int:
    """Stable per-day seed for the engine's random signal.

    Seeding from the calendar day keeps same-day builds byte-stable while
    letting ``random_roll`` vary across natural days, so the 30% wander signal
    (``random_hit``) is no longer permanently pinned to a single value.
    """
    return int(day.replace("-", ""))


def _decision(items: list[dict[str, Any]], recent: int, day: str) -> dict[str, Any]:
    if not items:
        return {
            "source": SOURCE,
            "recent_count": 0,
            "top_theme": None,
            "top_share": 0.0,
            "themes": {},
            "flooded": False,
            "same_as_last": False,
            "random_roll": 0.0,
            "random_hit": False,
            "wander_suggested": False,
            "candidates": [],
        }
    fd, temp_name = tempfile.mkstemp(prefix="x-daily-items-", suffix=".jsonl")
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for item in items:
                handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        # A non-existent last-theme path keeps this report pure/read-only.
        return insight_engine.analyze(
            str(temp_path),
            str(temp_path) + ".last-theme-do-not-write",
            recent=recent,
            seed=_seed_for_day(day),
        )
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def build_report(
    timeline: os.PathLike[str] | str = DEFAULT_TIMELINE,
    day: str | None = None,
    *,
    report_epoch: int | float | None = None,
    include_test: bool = False,
    exclude_id_file: os.PathLike[str] | str | None = None,
    recent: int = 60,
) -> dict[str, Any]:
    """Build a deterministic package from one timeline snapshot."""
    timeline_path = Path(timeline).expanduser().resolve()
    if not timeline_path.exists():
        raise FileNotFoundError(timeline_path)
    if recent < 0:
        raise ValueError("recent must be >= 0")
    if report_epoch is not None and not _valid_ts(report_epoch):
        raise ValueError(
            "report_epoch must be a finite numeric timestamp within the platform time range"
        )

    records, quality, total = _load_records(timeline_path)
    if day is None:
        if records:
            day = max(_day_from_ts(record["ts"]) for record in records)
        else:
            day = dt.datetime.now(tz=SHANGHAI).date().isoformat()
    day = _parse_day(day)

    filters = _empty_filters()
    excluded_ids, excluded_keys = _read_exclusions(exclude_id_file)
    in_day: list[dict[str, Any]] = []
    for record in records:
        if _day_from_ts(record["ts"]) != day:
            continue
        if not include_test and record.get("label") == "test":
            filters["test_label"] += 1
            continue
        if report_epoch is not None and float(record["ts"]) < float(report_epoch):
            filters["before_epoch"] += 1
            continue
        if _is_explicitly_excluded(record, excluded_ids, excluded_keys):
            filters["explicit_exclusion"] += 1
            continue
        in_day.append(record)

    items = _dedupe(in_day, filters)
    decision = _decision(items, recent, day)
    items_missing_time = sum(1 for item in items if not item.get("time"))
    media_count = sum(len(item.get("media", [])) for item in items if isinstance(item.get("media"), list))
    by_topic: dict[str, int] = {}
    for item in items:
        topic = item.get("topic")
        if topic:
            by_topic[str(topic)] = by_topic.get(str(topic), 0) + 1

    first_ts = min((record["ts"] for record in items), default=None)
    last_ts = max((record["ts"] for record in items), default=None)
    skipped_bad_lines = sum(quality.values())
    payload_items = [copy.deepcopy(item) for item in items]
    package: dict[str, Any] = {
        "day": day,
        "timezone": "Asia/Shanghai",
        "source": SOURCE,
        "collected": len(payload_items),
        "first_ts": first_ts,
        "last_ts": last_ts,
        "items": payload_items,
        "tweets": copy.deepcopy(payload_items),
        "items_missing_time": items_missing_time,
        "skipped_bad_lines": skipped_bad_lines,
        "quality": quality,
        "filters": filters,
        "stats": {
            "by_topic": dict(sorted(by_topic.items())),
            "media_count": media_count,
            "empty_time": items_missing_time,
        },
        "counts": {
            "total": total,
            "bad_json": quality["invalid_json"],
            "bad_object": quality["not_object"],
            "missing_core": quality["missing_fields"],
            "bad_ts": quality["invalid_ts"] + quality["missing_ts"],
            "excluded_label_test": filters["test_label"],
            "excluded_old": filters["before_epoch"],
            "duplicates": filters["duplicates"],
        },
        "decision": decision,
        # Deterministic: this is the observed collection watermark, not now().
        "generated_at": last_ts,
        "delivery_id": f"x-daily-{day}",
    }
    return package


def _serialize(package: dict[str, Any]) -> str:
    return json.dumps(package, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def _atomic_write(path: os.PathLike[str] | str, text: str) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def write_report(
    timeline: os.PathLike[str] | str = DEFAULT_TIMELINE,
    day: str | None = None,
    *,
    out: os.PathLike[str] | str | None = None,
    report_epoch: int | float | None = None,
    include_test: bool = False,
    exclude_id_file: os.PathLike[str] | str | None = None,
    recent: int = 60,
    dry_run: bool = False,
) -> int:
    package = build_report(
        timeline,
        day,
        report_epoch=report_epoch,
        include_test=include_test,
        exclude_id_file=exclude_id_file,
        recent=recent,
    )
    text = _serialize(package)
    if out and not dry_run:
        _atomic_write(out, text)
    print(text, end="")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeline", type=Path, default=DEFAULT_TIMELINE)
    parser.add_argument("--day", help="collection day in YYYY-MM-DD; defaults to latest valid ts day")
    parser.add_argument("--report-epoch", type=float, default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--exclude-id-file", "--exclude-ids", dest="exclude_id_file", type=Path, default=None)
    parser.add_argument("--include-test", action="store_true")
    parser.add_argument("--recent", type=int, default=60)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        return write_report(
            args.timeline,
            args.day,
            out=args.out,
            report_epoch=args.report_epoch,
            include_test=args.include_test,
            exclude_id_file=args.exclude_id_file,
            recent=args.recent,
            dry_run=args.dry_run,
        )
    except (FileNotFoundError, OSError, ValueError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
