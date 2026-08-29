#!/usr/bin/env python3
"""Read-only identity and interface gate for the live Harness Notion automation."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import stat
import sys
from copy import deepcopy
from pathlib import Path


MAX_BYTES = 1024 * 1024
RELATIVE_ENTRYPOINT = Path("workspace/automations/notion/notion_inbox_sync.py")
RELATIVE_HANDOFF = Path("workspace/automations/notion/notion_inbox_sync.handoff.json")
RELATIVE_TEST_RECEIPT = Path("workspace/automations/notion/notion_inbox_sync.test-receipt.json")
HANDOFF_TESTS = (
    "atomicArtifacts",
    "conflict",
    "firstPull",
    "force",
    "networkRecovery",
    "noPendingNoApi",
    "pendingRetry",
    "pullFailureNoPending",
    "push",
    "read",
    "secretRedaction",
    "set",
)
ARTIFACT_CONTRACT = {
    "interfaceVersion": 1,
    "state": {
        "role": "state",
        "path": "storages/task-inbox/sync-state.json",
        "mode": "0600",
    },
    "fingerprint": {
        "role": "fingerprint",
        "path": "storages/task-inbox/notion-fingerprint.json",
        "mode": "0600",
    },
}
REQUIRED_TOKENS = (
    b"--pull",
    b"--set",
    b"--push",
    b"--force",
    b"--retry-pending",
    b"--json",
    b"NOTION_TOKEN_FILE",
    b"NOTION_INBOX_FILE",
    b"NOTION_API_BASE",
    b"NOTION_PAGE_ID",
)
FORBIDDEN_TOKENS = (
    b".openclaw",
    b"NOTION_API_KEY",
    b"NOTION_ENV_FILE",
    b"/home/herman/task-inbox-workflow",
)


class GateError(Exception):
    pass


def read_bounded_regular(
    path: Path,
    owner_uid: int,
    owner_gid: int,
    maximum: int,
    *,
    required_mode: int | None = None,
) -> bytes:
    try:
        before = os.lstat(path)
    except FileNotFoundError as error:
        raise GateError("required Harness handoff file is unavailable") from error
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != owner_uid
        or before.st_gid != owner_gid
        or before.st_size < 1
        or before.st_size > maximum
        or (required_mode is not None and stat.S_IMODE(before.st_mode) != required_mode)
    ):
        raise GateError("required Harness handoff file has an unsafe identity")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or current.st_ino != before.st_ino
            or current.st_dev != before.st_dev
            or current.st_size != before.st_size
            or current.st_uid != owner_uid
            or current.st_gid != owner_gid
        ):
            raise GateError("required Harness handoff file changed during inspection")
        chunks: list[bytes] = []
        length = 0
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            length += len(chunk)
            if length > maximum:
                raise GateError("required Harness handoff file exceeds the size limit")
            chunks.append(chunk)
        value = b"".join(chunks)
    finally:
        os.close(descriptor)
    if len(value) != before.st_size:
        raise GateError("required Harness handoff file changed during inspection")
    return value


def canonical_time(value: object) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == datetime.timedelta(0)


def valid_artifact_contract(value: object) -> bool:
    if value != ARTIFACT_CONTRACT:
        return False
    if not isinstance(value, dict) or set(value) != {"interfaceVersion", "state", "fingerprint"}:
        return False
    if value["interfaceVersion"] != 1:
        return False
    observed_paths: set[str] = set()
    for role in ("state", "fingerprint"):
        artifact = value.get(role)
        if not isinstance(artifact, dict) or set(artifact) != {"role", "path", "mode"}:
            return False
        path = artifact.get("path")
        if artifact.get("role") != role or artifact.get("mode") != "0600" or not isinstance(path, str):
            return False
        relative = Path(path)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.parts[:2] != ("storages", "task-inbox")
            or len(relative.parts) != 3
            or path in observed_paths
        ):
            return False
        observed_paths.add(path)
    return True


def inspect_entrypoint(
    dsh_home: Path,
    owner_uid: int,
    owner_gid: int,
    expected_probe_sha256: str,
) -> dict[str, object]:
    if not dsh_home.is_absolute():
        raise GateError("DSH_HOME must be absolute")
    if (
        len(expected_probe_sha256) != 64
        or any(character not in "0123456789abcdef" for character in expected_probe_sha256)
    ):
        raise GateError("trusted probe identity is invalid")
    automation_root = dsh_home / "workspace/automations"
    notion_root = automation_root / "notion"
    entrypoint = dsh_home / RELATIVE_ENTRYPOINT
    for path, label in (
        (dsh_home, "DSH_HOME"),
        (dsh_home / "workspace", "workspace"),
        (automation_root, "automation root"),
        (notion_root, "Notion automation root"),
    ):
        try:
            metadata = os.lstat(path)
        except FileNotFoundError as error:
            raise GateError(f"{label} is unavailable") from error
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise GateError(f"{label} is not a real directory")

    source = read_bounded_regular(entrypoint, owner_uid, owner_gid, MAX_BYTES)
    if any(token not in source for token in REQUIRED_TOKENS):
        raise GateError("Notion automation entrypoint is missing the product interface")
    if any(token in source for token in FORBIDDEN_TOKENS):
        raise GateError("Notion automation entrypoint contains a retired dependency")
    entrypoint_sha256 = hashlib.sha256(source).hexdigest()

    test_receipt_path = dsh_home / RELATIVE_TEST_RECEIPT
    test_receipt_bytes = read_bounded_regular(
        test_receipt_path, owner_uid, owner_gid, 64 * 1024, required_mode=0o600,
    )
    try:
        test_receipt = json.loads(test_receipt_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("Notion automation test receipt is invalid") from error
    required_test_receipt = {
        "schemaVersion", "interfaceVersion", "probeVersion", "entrypointSha256",
        "probeSha256", "testedAt", "tests",
    }
    canonical_test_receipt = (
        json.dumps(test_receipt, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if (
        not isinstance(test_receipt, dict)
        or set(test_receipt) != required_test_receipt
        or test_receipt["schemaVersion"] != 1
        or test_receipt["interfaceVersion"] != 1
        or test_receipt["probeVersion"] != 1
        or test_receipt["entrypointSha256"] != entrypoint_sha256
        or test_receipt["probeSha256"] != expected_probe_sha256
        or not canonical_time(test_receipt["testedAt"])
        or not isinstance(test_receipt["tests"], dict)
        or set(test_receipt["tests"]) != set(HANDOFF_TESTS)
        or any(test_receipt["tests"][name] is not True for name in HANDOFF_TESTS)
        or canonical_test_receipt != test_receipt_bytes
    ):
        raise GateError("Notion automation test receipt is not trusted probe evidence")
    test_receipt_sha256 = hashlib.sha256(test_receipt_bytes).hexdigest()

    handoff_path = dsh_home / RELATIVE_HANDOFF
    handoff_bytes = read_bounded_regular(
        handoff_path, owner_uid, owner_gid, 64 * 1024, required_mode=0o600,
    )
    try:
        handoff = json.loads(handoff_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("Notion automation handoff receipt is invalid") from error
    required_handoff = {
        "schemaVersion",
        "interfaceVersion",
        "artifactContract",
        "entrypointSha256",
        "testReceiptSha256",
        "testedAt",
        "tests",
    }
    if (
        not isinstance(handoff, dict)
        or set(handoff) != required_handoff
        or handoff["schemaVersion"] != 2
        or handoff["interfaceVersion"] != 1
        or not valid_artifact_contract(handoff["artifactContract"])
        or handoff["entrypointSha256"] != entrypoint_sha256
        or handoff["testReceiptSha256"] != test_receipt_sha256
        or not canonical_time(handoff["testedAt"])
        or handoff["testedAt"] != test_receipt["testedAt"]
        or not isinstance(handoff["tests"], dict)
        or set(handoff["tests"]) != set(HANDOFF_TESTS)
        or any(handoff["tests"][name] is not True for name in HANDOFF_TESTS)
    ):
        raise GateError("Notion automation handoff receipt does not match the product contract")
    return {
        "status": "ready",
        "owner": "live-harness-workspace",
        "path": RELATIVE_ENTRYPOINT.as_posix(),
        "handoffPath": RELATIVE_HANDOFF.as_posix(),
        "interfaceVersion": 1,
        "artifactContract": deepcopy(ARTIFACT_CONTRACT),
        "size": len(source),
        "sha256": entrypoint_sha256,
        "handoffSha256": hashlib.sha256(handoff_bytes).hexdigest(),
        "testReceiptSha256": test_receipt_sha256,
        "testedAt": handoff["testedAt"],
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
        receipt = inspect_entrypoint(
            Path(args.dsh_home), args.owner_uid, args.owner_gid, args.expected_probe_sha256,
        )
    except (GateError, OSError, ValueError):
        print("live Harness Notion automation handoff is unavailable", file=sys.stderr)
        return 4
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
