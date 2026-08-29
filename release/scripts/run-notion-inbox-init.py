#!/usr/bin/env python3
"""Initialize the local task mirror through the live Harness-owned sync CLI."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parent
CHECKER_PATH = SCRIPT_ROOT / "check-notion-automation-entrypoint.py"
CHECKER_SPEC = importlib.util.spec_from_file_location("notion_automation_entrypoint", CHECKER_PATH)
if CHECKER_SPEC is None or CHECKER_SPEC.loader is None:
    raise RuntimeError("Notion automation checker is unavailable")
CHECKER = importlib.util.module_from_spec(CHECKER_SPEC)
CHECKER_SPEC.loader.exec_module(CHECKER)

MAX_OUTPUT_BYTES = 64 * 1024
MAX_MIRROR_BYTES = 16 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
RELATIVE_MIRROR = Path("storages/task-inbox/inbox.md")
ARTIFACT_PATHS = {
    "mirror": RELATIVE_MIRROR,
    "state": Path(CHECKER.ARTIFACT_CONTRACT["state"]["path"]),
    "fingerprint": Path(CHECKER.ARTIFACT_CONTRACT["fingerprint"]["path"]),
}
ARTIFACT_LIMITS = {
    "mirror": MAX_MIRROR_BYTES,
    "state": MAX_METADATA_BYTES,
    "fingerprint": MAX_METADATA_BYTES,
}


class InitError(Exception):
    pass


def require_real_directory(path: Path, label: str, owner_uid: int, owner_gid: int) -> None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as error:
        raise InitError(f"{label} is unavailable") from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != owner_uid
        or metadata.st_gid != owner_gid
    ):
        raise InitError(f"{label} has an unsafe identity")


def artifact_present(path: Path) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return False
    return True


def inspect_artifact(
    dsh_home: Path,
    role: str,
    owner_uid: int,
    owner_gid: int,
) -> dict[str, object]:
    relative_path = ARTIFACT_PATHS[role]
    path = dsh_home / relative_path
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        path_metadata = os.lstat(path)
        descriptor = os.open(path, flags)
    except OSError as error:
        raise InitError(f"{role} artifact is unavailable") from error
    try:
        before = os.fstat(descriptor)
        if (
            stat.S_ISLNK(path_metadata.st_mode)
            or not stat.S_ISREG(path_metadata.st_mode)
            or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_dev != path_metadata.st_dev
            or before.st_ino != path_metadata.st_ino
            or before.st_mode != path_metadata.st_mode
            or before.st_nlink != path_metadata.st_nlink
            or before.st_size != path_metadata.st_size
            or before.st_uid != path_metadata.st_uid
            or before.st_gid != path_metadata.st_gid
            or before.st_mtime_ns != path_metadata.st_mtime_ns
            or before.st_ctime_ns != path_metadata.st_ctime_ns
            or before.st_uid != owner_uid
            or before.st_gid != owner_gid
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_size < 1
            or before.st_size > ARTIFACT_LIMITS[role]
        ):
            raise InitError(f"{role} artifact has an unsafe identity")
        digest = hashlib.sha256()
        length = 0
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            length += len(chunk)
            if length > ARTIFACT_LIMITS[role]:
                raise InitError(f"{role} artifact exceeds its size limit")
            digest.update(chunk)
        after = os.fstat(descriptor)
        stable_fields = (
            "st_dev",
            "st_ino",
            "st_mode",
            "st_nlink",
            "st_uid",
            "st_gid",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
        )
        if length != before.st_size or any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise InitError(f"{role} artifact changed during inspection")
    except OSError as error:
        raise InitError(f"{role} artifact could not be inspected") from error
    finally:
        os.close(descriptor)
    return {
        "role": role,
        "path": relative_path.as_posix(),
        "mode": "0600",
        "length": length,
        "sha256": digest.hexdigest(),
    }


def inspect_artifacts(dsh_home: Path, owner_uid: int, owner_gid: int) -> dict[str, dict[str, object]]:
    return {
        role: inspect_artifact(dsh_home, role, owner_uid, owner_gid)
        for role in ("mirror", "state", "fingerprint")
    }


def safe_environment() -> dict[str, str]:
    allowed_notion = {"NOTION_TOKEN_FILE", "NOTION_INBOX_FILE", "NOTION_API_BASE", "NOTION_PAGE_ID"}
    return {
        name: value
        for name, value in os.environ.items()
        if name != "AUTHORIZATION"
        and not (
            name.startswith("NOTION_")
            and name not in allowed_notion
            and re.search(r"TOKEN|SECRET|KEY|AUTHORIZATION", name, re.IGNORECASE)
        )
    }


def initialize(
    dsh_home: Path,
    owner_uid: int,
    owner_gid: int,
    expected_probe_sha256: str,
) -> dict[str, object]:
    expected_mirror = dsh_home / RELATIVE_MIRROR
    configured_mirror = Path(os.environ.get("NOTION_INBOX_FILE", str(expected_mirror)))
    if not configured_mirror.is_absolute() or configured_mirror != expected_mirror:
        raise InitError("NOTION_INBOX_FILE does not match the product mirror path")
    handoff = CHECKER.inspect_entrypoint(dsh_home, owner_uid, owner_gid, expected_probe_sha256)
    require_real_directory(dsh_home, "DSH_HOME", owner_uid, owner_gid)
    storages = dsh_home / "storages"
    task_inbox = storages / "task-inbox"
    require_real_directory(storages, "DSH storages", owner_uid, owner_gid)
    try:
        os.lstat(task_inbox)
    except FileNotFoundError:
        task_inbox_exists = False
    else:
        task_inbox_exists = True
        require_real_directory(task_inbox, "task inbox directory", owner_uid, owner_gid)
    present = (
        {
            role: artifact_present(dsh_home / relative_path)
            for role, relative_path in ARTIFACT_PATHS.items()
        }
        if task_inbox_exists
        else {role: False for role in ARTIFACT_PATHS}
    )
    if present["mirror"]:
        artifacts = inspect_artifacts(dsh_home, owner_uid, owner_gid)
        return {
            "status": "already-initialized",
            "entrypointSha256": handoff["sha256"],
            "handoffSha256": handoff["handoffSha256"],
            "testReceiptSha256": handoff["testReceiptSha256"],
            "artifacts": artifacts,
            "remoteMethod": "none",
        }
    if any(present.values()):
        raise InitError("task mirror artifacts are only partially initialized")

    entrypoint = dsh_home / CHECKER.RELATIVE_ENTRYPOINT
    workspace = dsh_home / "workspace"
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            completed = subprocess.run(
                [sys.executable, str(entrypoint), "--pull", "--json"],
                cwd=workspace,
                env=safe_environment(),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                timeout=300,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise InitError("Notion mirror initialization timed out") from error
        stdout_size = os.fstat(stdout.fileno()).st_size
        stderr_size = os.fstat(stderr.fileno()).st_size
        if stdout_size > MAX_OUTPUT_BYTES or stderr_size > MAX_OUTPUT_BYTES:
            raise InitError("Notion mirror initialization output exceeded its bound")
        stdout.seek(0)
        output = stdout.read()
    if completed.returncode != 0:
        raise InitError("Notion mirror initialization command failed")
    try:
        operation = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InitError("Notion mirror initialization returned invalid JSON") from error
    if not isinstance(operation, dict) or operation.get("status") != "synced":
        raise InitError("Notion mirror initialization did not report synced")
    require_real_directory(task_inbox, "task inbox directory", owner_uid, owner_gid)
    artifacts = inspect_artifacts(dsh_home, owner_uid, owner_gid)
    return {
        "status": "initialized",
        "entrypointSha256": handoff["sha256"],
        "handoffSha256": handoff["handoffSha256"],
        "testReceiptSha256": handoff["testReceiptSha256"],
        "artifacts": artifacts,
        "remoteMethod": "GET",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--dsh-home", required=True)
    parser.add_argument("--owner-uid", required=True, type=int)
    parser.add_argument("--owner-gid", required=True, type=int)
    parser.add_argument("--expected-probe-sha256", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        receipt = initialize(
            Path(args.dsh_home), args.owner_uid, args.owner_gid, args.expected_probe_sha256,
        )
    except (CHECKER.GateError, InitError, OSError, ValueError):
        print("Harness-owned Notion mirror initialization failed", file=sys.stderr)
        return 4
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
