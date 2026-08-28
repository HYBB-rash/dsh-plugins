#!/usr/bin/env python3
"""Forced-command SSH entrypoint for durable, bounded BZP refresh requests."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


COMMAND = re.compile(r"^refresh (electric|water|all)$")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _ensure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def _read_request(path: Path) -> dict | None:
    try:
        if path.stat().st_size > 4096:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        return None
    return value


def _parse_time(value: str) -> datetime | None:
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo is not None else None
    except (TypeError, ValueError):
        return None


def _request_covers(existing: str, requested: str) -> bool:
    return existing == "all" or existing == requested


def enqueue_request(command: str, queue_root: str, *, max_requests: int = 100,
                    dedupe_seconds: int = 30, now: datetime | None = None,
                    request_id: str | None = None) -> dict:
    match = COMMAND.fullmatch(command or "")
    if match is None:
        raise ValueError("invalid refresh command")
    if max_requests <= 0 or dedupe_seconds < 0:
        raise ValueError("invalid queue limits")
    target = match.group(1)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("queue time must be timezone-aware")
    root = Path(queue_root)
    pending = root / "pending"
    processing = root / "processing"
    _ensure_directory(root)
    _ensure_directory(pending)
    _ensure_directory(processing)
    files = sorted([
        path for directory in (pending, processing)
        for path in directory.iterdir()
        if path.is_file() and path.name.endswith(".json")
    ])
    recent_targets = set()
    for path in files:
        value = _read_request(path)
        enqueued = _parse_time(value.get("enqueuedAt")) if value else None
        if value is None or enqueued is None:
            continue
        age = (current.astimezone(timezone.utc) - enqueued.astimezone(timezone.utc)).total_seconds()
        if 0 <= age <= dedupe_seconds:
            recent_targets.add(value.get("target"))
    covered = any(_request_covers(existing, target) for existing in recent_targets)
    if target == "all" and {"electric", "water"}.issubset(recent_targets):
        covered = True
    if covered:
        return {"queued": True, "coalesced": True, "target": target, "requestId": None}
    if len(files) >= max_requests:
        raise OverflowError("refresh queue is full")

    identifier = request_id or str(uuid.uuid4())
    try:
        uuid.UUID(identifier)
    except ValueError as error:
        raise ValueError("request id must be a UUID") from error
    record = {
        "schemaVersion": 1,
        "requestId": identifier,
        "target": target,
        "enqueuedAt": current.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    final = pending / f"{identifier}.json"
    temporary = pending / f".{identifier}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, final)
        final.chmod(0o600)
        _fsync_directory(pending)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    return {"queued": True, "coalesced": False, "target": target, "requestId": identifier}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="enqueue a forced-command BZP refresh request")
    parser.add_argument(
        "--queue-root",
        default="/home/herman/.dsh/storages/automations/bzp/refresh-requests",
    )
    parser.add_argument("--max-requests", type=int, default=100)
    parser.add_argument("--dedupe-seconds", type=int, default=30)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    opts = parse_args(argv)
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    try:
        enqueue_request(
            command, opts.queue_root,
            max_requests=opts.max_requests,
            dedupe_seconds=opts.dedupe_seconds,
        )
    except (OSError, ValueError, OverflowError) as error:
        sys.stderr.write(f"refresh request rejected: {error}\n")
        return 64
    sys.stdout.write("收到\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
