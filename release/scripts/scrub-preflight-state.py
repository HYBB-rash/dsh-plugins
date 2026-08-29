#!/usr/bin/env python3
"""Remove production write credentials from an isolated DSH snapshot copy.

This command is deliberately unsuitable for production state.  The caller must
pass a path below an explicitly marked preflight root.  It replaces only the
known runtime credential stores; business Workspace files are left byte-for-
byte untouched and are isolated separately by running every preflight
container without an external network.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path


class ScrubError(RuntimeError):
    pass


FAKE_CREDENTIALS = b"""version: 1
refs:
  DEEPSEEK_API_KEY: isolated-preflight-key
  TELEGRAM_BOT_TOKEN: isolated-preflight-token
  TELEGRAM_ALLOWED_CHAT_ID: \"1\"
"""
FAKE_NOTION_TOKEN = b"dsh-fake-notion-token-v1"


def require_real_directory(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ScrubError(f"{label} is unavailable") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ScrubError(f"{label} must be a real directory")


def atomic_write(path: Path, value: bytes, mode: int) -> None:
    temporary = path.with_name(f".{path.name}.next-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, mode)
    try:
        os.fchmod(descriptor, mode)
        written = 0
        while written < len(value):
            written += os.write(descriptor, value[written:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def remove_entry(path: Path) -> int:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return 0
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        count = sum(1 for item in path.rglob("*") if item.is_file() or item.is_symlink())
        shutil.rmtree(path)
        return count
    path.unlink()
    return 1


def scrub(dsh_home: Path, preflight_root: Path) -> dict[str, object]:
    require_real_directory(dsh_home, "DSH_HOME snapshot copy")
    require_real_directory(preflight_root, "preflight root")
    dsh_home = dsh_home.resolve(strict=True)
    preflight_root = preflight_root.resolve(strict=True)
    try:
        dsh_home.relative_to(preflight_root)
    except ValueError as error:
        raise ScrubError("DSH_HOME must stay below the declared preflight root") from error
    if dsh_home.name != ".dsh":
        raise ScrubError("preflight DSH_HOME must end in .dsh")

    removed = 0
    for name in (".credentials.yaml", ".credentials.json"):
        removed += remove_entry(dsh_home / name)
    secrets = dsh_home / "secrets"
    removed += remove_entry(secrets)
    secrets.mkdir(mode=0o700)
    os.chmod(secrets, 0o700)

    atomic_write(dsh_home / ".credentials.yaml", FAKE_CREDENTIALS, 0o600)
    atomic_write(secrets / "notion.token", FAKE_NOTION_TOKEN, 0o600)
    return {
        "schemaVersion": 1,
        "status": "scrubbed",
        "removedCredentialEntries": removed,
        "installedFixtures": ["harness-telegram", "notion"],
        "externalNetworkRequired": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--preflight-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = scrub(args.dsh_home, args.preflight_root)
    except ScrubError as error:
        print(str(error), file=sys.stderr)
        return 4
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
