#!/usr/bin/env python3
"""Concurrency-safe append helpers for the shared X timeline JSONL store.

The timeline is written by the collector and by topic searches.  All writers
must use this module so that two browser jobs cannot append the same tweet at
the same time, and so malformed historical lines are preserved for the
deduplication/quarantine tool instead of being silently rewritten.
"""

from __future__ import annotations

import copy
import errno
import fcntl
import json
import math
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import urlsplit, urlunsplit


import x_paths


TIMELINE_BROWSER_LOCK = Path(x_paths.data_dir()) / ".x_timeline_browser.lock"
_LOCK_POLL_INTERVAL_SECONDS = 0.05


class BrowserLockTimeout(TimeoutError):
    """Raised when a bounded attempt cannot acquire the browser lock."""


def status_id(value: Any) -> str:
    """Extract a numeric X status id, ignoring ``/analytics`` and queries."""
    raw = str(value or "").strip()
    if "/status/" in raw:
        raw = raw.split("/status/", 1)[1]
    raw = raw.split("?", 1)[0].split("#", 1)[0].strip("/")
    if "/" in raw:
        raw = raw.split("/", 1)[0]
    return raw if raw.isdigit() else ""


def canonical_url(value: Any) -> str:
    """Normalize a URL for identity without changing stored display URLs."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return raw.split("?", 1)[0].split("#", 1)[0].rstrip("/")

    if not parsed.netloc:
        path = parsed.path.rstrip("/")
        if path.endswith("/analytics"):
            path = path[: -len("/analytics")].rstrip("/")
        return path

    host = (parsed.hostname or "").lower()
    if host in {"twitter.com", "www.twitter.com", "mobile.twitter.com"}:
        host = "x.com"
    path = (parsed.path or "").rstrip("/")

    # X exposes media/history views as suffixes on the status URL.  Once the
    # host and path identify a numeric status, keep only that identity so
    # every downstream consumer receives the provider's canonical URL.
    ident = status_id(raw)
    if host == "x.com" and "/status/" in path and ident:
        prefix = path.split("/status/", 1)[0]
        path = f"{prefix}/status/{ident}"
    if path.endswith("/analytics"):
        path = path[: -len("/analytics")].rstrip("/")
    return urlunsplit(("https", host, path, "", ""))


def record_key(record: dict[str, Any]) -> tuple[str, str]:
    """Return the stable identity key used by every timeline writer."""
    ident = status_id(record.get("id")) or status_id(record.get("url"))
    if ident:
        return ("id", ident)
    return ("url", canonical_url(record.get("url") or record.get("id")))


def _validate_timeout(timeout_seconds: int | float | None) -> float:
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
        raise TypeError("timeout_seconds must be an int or float")
    try:
        normalized = float(timeout_seconds)
    except OverflowError:
        raise ValueError("timeout_seconds must be finite and greater than zero") from None
    if not math.isfinite(normalized) or normalized <= 0:
        raise ValueError("timeout_seconds must be finite and greater than zero")
    return normalized


@contextmanager
def file_lock(
    lock_path: os.PathLike[str] | str,
    timeout_seconds: int | float | None = None,
) -> Iterator[None]:
    """Hold an advisory exclusive lock until the context exits."""
    normalized_timeout = None
    if timeout_seconds is not None:
        normalized_timeout = _validate_timeout(timeout_seconds)
    path = Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        acquired = False
        try:
            if timeout_seconds is None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            else:
                deadline = time.monotonic() + normalized_timeout
                while True:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
                            raise
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise BrowserLockTimeout("timed out waiting for lock")
                        time.sleep(min(_LOCK_POLL_INTERVAL_SECONDS, remaining))
                    else:
                        break
            acquired = True
            yield
        finally:
            if acquired:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def browser_lock(timeout_seconds: int | float | None = None) -> Iterator[None]:
    """Serialize navigation of the shared X debugging tab."""
    with file_lock(TIMELINE_BROWSER_LOCK, timeout_seconds=timeout_seconds):
        yield


def _read_existing_keys(path: Path) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    if not path.exists():
        return keys
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                # Invalid historical lines are intentionally left untouched.
                continue
            if isinstance(value, dict):
                keys.add(record_key(value))
    return keys


def append_unique_records(
    path: os.PathLike[str] | str,
    records: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Append records that are not already present, under an exclusive lock.

    Identity is checked twice conceptually: the existing file is scanned while
    holding the lock, then the incoming batch is checked in encounter order.
    This makes concurrent collectors safe and preserves first-seen ordering.
    The returned list contains exactly the records written.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_name(target.name + ".lock")
    inserted: list[dict[str, Any]] = []
    with file_lock(lock_path):
        known = _read_existing_keys(target)
        with open(target, "a", encoding="utf-8") as handle:
            for record in records:
                if not isinstance(record, dict):
                    continue
                key = record_key(record)
                if key in known:
                    continue
                value = copy.deepcopy(record)
                handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
                known.add(key)
                inserted.append(value)
            handle.flush()
            os.fsync(handle.fileno())
    return inserted


def existing_keys(path: os.PathLike[str] | str) -> set[tuple[str, str]]:
    """Read identity keys consistently for a collector's fast-path filter."""
    target = Path(path)
    lock_path = target.with_name(target.name + ".lock")
    with file_lock(lock_path):
        return _read_existing_keys(target)
