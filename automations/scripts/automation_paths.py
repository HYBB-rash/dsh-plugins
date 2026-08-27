#!/usr/bin/env python3
"""Shared repository-owned paths for standalone automation scripts."""

from __future__ import annotations

import os
from pathlib import Path


def dsh_home() -> Path:
    """Return the persistent DSH home without requiring an installed runtime."""
    configured = os.environ.get("DSH_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".dsh"


def state_dir() -> Path:
    """Return the writable automation state root without touching the filesystem."""
    configured = os.environ.get("DSH_AUTOMATION_STATE_DIR")
    return Path(configured).expanduser() if configured else dsh_home() / "storages" / "automations"


def state_file(name: str) -> str:
    if not name or Path(name).name != name:
        raise ValueError("state file name must be one plain path component")
    return str(state_dir() / name)
