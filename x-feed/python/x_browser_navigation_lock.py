#!/usr/bin/env python3
"""Serialize browser navigation shared by X observers and collectors."""

from __future__ import annotations

import errno
import fcntl
import math
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import x_paths


TIMELINE_BROWSER_LOCK = Path(x_paths.data_dir()) / ".x_timeline_browser.lock"
_LOCK_POLL_INTERVAL_SECONDS = 0.05


class BrowserLockTimeout(TimeoutError):
    """Raised when a bounded attempt cannot acquire the browser lock."""


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
