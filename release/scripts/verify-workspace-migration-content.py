#!/usr/bin/env python3
"""Bind candidate workspace-migration metadata to the installed image bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
from pathlib import Path


EXPECTED_ENV = {
    "codeSha256": "DSH_EXPECTED_WORKSPACE_MIGRATION_CODE_SHA256",
    "manifestSha256": "DSH_EXPECTED_WORKSPACE_MIGRATION_MANIFEST_SHA256",
    "templateSha256": "DSH_EXPECTED_WORKSPACE_MIGRATION_TEMPLATE_SHA256",
    "rootInstructionsSha256": "DSH_EXPECTED_WORKSPACE_MIGRATION_ROOT_INSTRUCTIONS_SHA256",
    "personalTaskListSkillSha256": "DSH_EXPECTED_WORKSPACE_MIGRATION_PERSONAL_TASK_LIST_SKILL_SHA256",
}


class VerifyError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def read_regular(path: Path, label: str) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise VerifyError(f"candidate image is missing {label}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise VerifyError(f"candidate image {label} is not a single-link regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks), metadata
    finally:
        os.close(descriptor)


def file_sha256(path: Path, label: str) -> str:
    value, _ = read_regular(path, label)
    return sha256_bytes(value)


def tree_sha256(root: Path) -> str:
    try:
        root_info = root.lstat()
    except OSError as error:
        raise VerifyError("candidate image is missing personal-task-list Skill") from error
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise VerifyError("candidate image personal-task-list Skill is not a real directory")
    records: list[dict[str, object]] = []
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        directory_names.sort()
        file_names.sort()
        current_path = Path(current)
        for name in directory_names:
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise VerifyError("candidate image Skill tree contains an unsupported entry")
            records.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "type": "directory",
                    "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
                }
            )
        for name in file_names:
            path = current_path / name
            value, metadata = read_regular(path, "personal-task-list Skill file")
            records.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "type": "file",
                    "mode": f"{stat.S_IMODE(metadata.st_mode):04o}",
                    "size": len(value),
                    "sha256": sha256_bytes(value),
                }
            )
    records.sort(key=lambda item: str(item["path"]))
    return sha256_bytes(json.dumps(records, separators=(",", ":")).encode())


def verify(release_root: Path, plugins_root: Path) -> dict[str, object]:
    migration_root = release_root / "workspace-migrations/harness-only-v1"
    manifest_path = migration_root / "manifest.json"
    template_path = migration_root / "AGENTS.md"
    manifest_raw, _ = read_regular(manifest_path, "workspace migration manifest")
    try:
        manifest = json.loads(manifest_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerifyError("candidate image workspace migration manifest is invalid") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("migrationVersion") != 1
        or manifest.get("migrationId") != "harness-only-workspace-v1"
    ):
        raise VerifyError("candidate image workspace migration identity is invalid")

    actual = {
        "codeSha256": file_sha256(
            release_root / "scripts/migrate-workspace-state.py", "workspace migration engine"
        ),
        "manifestSha256": sha256_bytes(manifest_raw),
        "templateSha256": file_sha256(template_path, "workspace instruction template"),
        "rootInstructionsSha256": file_sha256(
            release_root / "harness-automation-instructions.md", "root Harness instructions"
        ),
        "personalTaskListSkillSha256": tree_sha256(
            plugins_root / "skills/personal-task-list"
        ),
    }
    declared_template = manifest.get("workspace", {}).get("agents", {}).get("postimageSha256")
    if declared_template != actual["templateSha256"].removeprefix("sha256:"):
        raise VerifyError("candidate image template does not match the migration manifest")

    for forbidden in (plugins_root / "automations", Path("/opt/dsh/automations")):
        if forbidden.exists() or forbidden.is_symlink():
            raise VerifyError("candidate image contains repository-owned business automation")

    supplied = {field: os.environ.get(name) for field, name in EXPECTED_ENV.items()}
    present = [field for field, value in supplied.items() if value is not None]
    if present and len(present) != len(EXPECTED_ENV):
        raise VerifyError("candidate image expected migration metadata is incomplete")
    if present:
        for field, expected in supplied.items():
            if expected != actual[field]:
                raise VerifyError(f"candidate image {field} does not match admitted metadata")

    return {
        "schemaVersion": 1,
        "status": "verified",
        "migrationId": "harness-only-workspace-v1",
        "metadataBound": bool(present),
        **actual,
        "businessAutomation": {
            "owner": "live-harness-workspace",
            "includedInCandidate": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--release-root", type=Path, default=Path("/opt/dsh/release-system"))
    parser.add_argument("--plugins-root", type=Path, default=Path("/opt/dsh/plugins-src"))
    args = parser.parse_args()
    try:
        receipt = verify(args.release_root, args.plugins_root)
    except VerifyError as error:
        print(str(error), file=sys.stderr)
        return 4
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
