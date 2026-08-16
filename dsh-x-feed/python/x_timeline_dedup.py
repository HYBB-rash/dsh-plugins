#!/usr/bin/env python3
"""Safely de-duplicate the historical X timeline JSONL.

The default mode is a read-only dry-run.  Use ``--apply`` only after checking
the JSON summary.  Before replacing the source file, the script makes a
timestamped backup and quarantines malformed/non-object lines separately.

Examples:
    python3 scripts/x_timeline_dedup.py
    python3 scripts/x_timeline_dedup.py --input data/x_timeline.jsonl --apply
"""

from __future__ import annotations

import argparse
import copy
import datetime as _datetime
import json
import os
import shutil
import stat
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

import x_timeline_store as timeline_store
import x_paths


DEFAULT_INPUT = Path(x_paths.data_dir()) / "x_timeline.jsonl"
REQUIRED_FIELDS = ("id", "url", "text")


def status_id(value: Any) -> str:
    """Return a numeric X status id from an id or URL-like value."""
    return timeline_store.status_id(value)


def canonical_url(value: Any) -> str:
    """Normalize an X status URL for identity and output.

    Tracking query strings, fragments, the ``/analytics`` suffix, and the
    twitter.com hostname variant are not part of tweet identity.
    """
    return timeline_store.canonical_url(value)


def item_key(item: dict[str, Any]) -> tuple[str, str]:
    """Return the stable identity key used for grouping records."""
    return timeline_store.record_key(item)


def read_jsonl(path: os.PathLike[str] | str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read valid JSON objects and return invalid lines as quarantine records."""
    records: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                invalid.append({
                    "line": line_number,
                    "reason": "invalid_json",
                    "raw": raw.rstrip("\n"),
                })
                continue
            if not isinstance(value, dict):
                invalid.append({
                    "line": line_number,
                    "reason": "not_an_object",
                    "raw": raw.rstrip("\n"),
                })
                continue
            missing = [field for field in REQUIRED_FIELDS if not value.get(field)]
            if missing:
                invalid.append({
                    "line": line_number,
                    "reason": "missing_fields:" + ",".join(missing),
                    "raw": raw.rstrip("\n"),
                })
                continue
            records.append(value)
    return records, invalid


def _text_length(value: Any) -> int:
    return len(str(value or "").strip())


def _richness(item: dict[str, Any]) -> tuple[int, int, int]:
    """Prefer records with complete text and more populated fields."""
    populated = sum(value not in (None, "", [], {}) for value in item.values())
    media_count = len(item.get("media", [])) if isinstance(item.get("media"), list) else 0
    return (_text_length(item.get("text")), populated, media_count)


def _first_nonempty(records: Iterable[dict[str, Any]], field: str) -> Any:
    for record in records:
        value = record.get(field)
        if value not in (None, "", [], {}):
            return copy.deepcopy(value)
    return None


def _merge_group(records: list[dict[str, Any]], key: tuple[str, str]) -> dict[str, Any]:
    """Merge duplicates without losing richer text or auxiliary fields."""
    preferred = max(enumerate(records), key=lambda pair: (_richness(pair[1]), -pair[0]))[1]
    merged = copy.deepcopy(preferred)

    # Fill missing scalar/structured fields from the original encounter order.
    for record in records:
        for field, value in record.items():
            if field not in merged or merged[field] in (None, "", [], {}):
                merged[field] = copy.deepcopy(value)

    # The longest non-empty text is the most useful historical copy.
    text_values = [record.get("text") for record in records if _text_length(record.get("text"))]
    if text_values:
        merged["text"] = max(text_values, key=_text_length)

    # Media is a set-like field; preserve stable first-seen order.
    media: list[Any] = []
    for record in records:
        values = record.get("media", [])
        values = values if isinstance(values, list) else [values]
        for value in values:
            if value not in (None, "") and value not in media:
                media.append(copy.deepcopy(value))
    if media:
        merged["media"] = media

    if key[0] == "id":
        merged["id"] = key[1]
    merged_url = canonical_url(_first_nonempty(records, "url"))
    if merged_url:
        merged["url"] = merged_url
    return merged


def deduplicate_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Deduplicate records by status id, falling back to canonical URL."""
    groups: OrderedDict[tuple[str, str], list[dict[str, Any]]] = OrderedDict()
    for record in records:
        groups.setdefault(item_key(record), []).append(record)

    unique = [_merge_group(group, key) for key, group in groups.items()]
    duplicate_groups = sum(1 for group in groups.values() if len(group) > 1)
    duplicates_removed = len(records) - len(unique)
    report = {
        "input_records": len(records),
        "unique_records": len(unique),
        "duplicate_groups": duplicate_groups,
        "duplicates_removed": duplicates_removed,
    }
    return unique, report


def _stamp() -> str:
    now = _datetime.datetime.now().astimezone()
    return now.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"


def _new_sibling(path: Path, suffix: str) -> Path:
    candidate = path.with_name(path.name + suffix + _stamp())
    counter = 1
    while candidate.exists():
        candidate = path.with_name(path.name + suffix + _stamp() + f"-{counter}")
        counter += 1
    return candidate


def _write_jsonl_atomic(path: Path, records: list[dict[str, Any]], mode: int) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(mode))
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _write_invalid_quarantine(path: Path, invalid: list[dict[str, Any]]) -> Path | None:
    if not invalid:
        return None
    quarantine = _new_sibling(path, ".invalid-")
    with open(quarantine, "w", encoding="utf-8") as handle:
        for entry in invalid:
            handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return quarantine


def apply_dedup(path: Path, unique: list[dict[str, Any]], invalid: list[dict[str, Any]]) -> tuple[Path, Path | None]:
    """Backup, quarantine invalid lines, then atomically replace the source."""
    backup = _new_sibling(path, ".bak-")
    shutil.copy2(path, backup)
    quarantine = _write_invalid_quarantine(path, invalid)
    _write_jsonl_atomic(path, unique, path.stat().st_mode)
    return backup, quarantine


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="source JSONL path")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="backup and atomically replace the source; default is read-only dry-run",
    )
    args = parser.parse_args(argv)
    path = args.input.expanduser().resolve()
    if not path.exists():
        parser.error(f"input does not exist: {path}")
    if not path.is_file():
        parser.error(f"input is not a file: {path}")

    # Use the same sibling lock as all appenders.  Keep the read, backup,
    # quarantine, and atomic replacement in one critical section so a running
    # collector cannot append to a snapshot that is being replaced.
    with timeline_store.file_lock(path.with_name(path.name + ".lock")):
        records, invalid = read_jsonl(path)
        unique, report = deduplicate_records(records)
        if not records and path.stat().st_size:
            parser.error("no valid records found; refusing to replace a non-empty source")

        summary: dict[str, Any] = {
            "mode": "apply" if args.apply else "dry-run",
            "input": str(path),
            **report,
            "invalid_lines": len(invalid),
            "invalid_line_numbers": [entry["line"] for entry in invalid],
        }

        if args.apply:
            backup, quarantine = apply_dedup(path, unique, invalid)
            summary["backup"] = str(backup)
            summary["invalid_quarantine"] = str(quarantine) if quarantine else None
        else:
            summary["would_backup"] = str(_new_sibling(path, ".bak-"))
            summary["would_quarantine"] = bool(invalid)

    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
