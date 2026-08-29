#!/usr/bin/env python3
"""Apply an exact, resumable DSH workspace state migration."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MANIFEST_SCHEMA_VERSION = 1
RECEIPT_SCHEMA_VERSION = 2
MIGRATION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MODE_RE = re.compile(r"^0[0-7]{3}$")
UTC_SECONDS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class MigrationError(RuntimeError):
    """A fail-closed migration error safe to show to an operator."""


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_regular_bytes_nofollow(path: Path, label: str) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise MigrationError(f"cannot open {label} safely: {error.strerror or error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise MigrationError(f"{label} must be a single-link regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks), metadata
    except OSError as error:
        raise MigrationError(f"cannot read {label}: {error.strerror or error}") from error
    finally:
        os.close(descriptor)


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def require_utc_seconds(value: Any, label: str) -> str:
    if not isinstance(value, str) or not UTC_SECONDS_RE.fullmatch(value):
        raise MigrationError(f"{label} must be a UTC timestamp with second precision")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise MigrationError(f"{label} is not a valid UTC timestamp") from error
    return value


def require_exact_keys(value: dict[str, Any], required: set[str], label: str) -> None:
    keys = set(value)
    if keys != required:
        missing = sorted(required - keys)
        extra = sorted(keys - required)
        raise MigrationError(f"{label} keys mismatch: missing={missing} extra={extra}")


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MigrationError(f"{label} must be an object")
    return value


def require_positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise MigrationError(f"{label} must be a positive integer")
    return value


def require_nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MigrationError(f"{label} must be a non-negative integer")
    return value


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise MigrationError(f"{label} must be a lowercase SHA-256")
    return value


def require_mode(value: Any, label: str) -> int:
    if not isinstance(value, str) or not MODE_RE.fullmatch(value):
        raise MigrationError(f"{label} must be an octal mode such as 0600")
    return int(value, 8)


def parse_file_transition(value: Any, label: str, expected_path: str) -> dict[str, Any]:
    item = require_object(value, label)
    required = {
        "path",
        "preimageSha256",
        "postimageSha256",
        "preimageMode",
        "postimageMode",
    }
    if label.endswith(".agents"):
        required.add("template")
    else:
        required.add("lineTransforms")
    require_exact_keys(item, required, label)
    if item["path"] != expected_path:
        raise MigrationError(f"{label}.path must be {expected_path}")
    parsed: dict[str, Any] = {
        "path": expected_path,
        "preimageSha256": require_sha256(item["preimageSha256"], f"{label}.preimageSha256"),
        "postimageSha256": require_sha256(item["postimageSha256"], f"{label}.postimageSha256"),
        "preimageMode": require_mode(item["preimageMode"], f"{label}.preimageMode"),
        "postimageMode": require_mode(item["postimageMode"], f"{label}.postimageMode"),
    }
    if label.endswith(".agents"):
        template = item["template"]
        if not isinstance(template, str) or not template or "\x00" in template:
            raise MigrationError(f"{label}.template must be a non-empty path")
        parsed["template"] = template
        return parsed

    rules = item["lineTransforms"]
    if not isinstance(rules, list) or not rules:
        raise MigrationError(f"{label}.lineTransforms must be a non-empty array")
    parsed_rules: list[dict[str, Any]] = []
    seen_lines: set[int] = set()
    for index, raw_rule in enumerate(rules):
        rule_label = f"{label}.lineTransforms[{index}]"
        rule = require_object(raw_rule, rule_label)
        require_exact_keys(
            rule,
            {
                "lineNumber",
                "preLineSha256",
                "removeStartByte",
                "removeEndByte",
                "removedSha256",
                "postLineSha256",
                "deleteLine",
            },
            rule_label,
        )
        line_number = require_positive_int(rule["lineNumber"], f"{rule_label}.lineNumber")
        if line_number in seen_lines:
            raise MigrationError(f"{rule_label}.lineNumber must be unique")
        seen_lines.add(line_number)
        remove_start = require_nonnegative_int(rule["removeStartByte"], f"{rule_label}.removeStartByte")
        remove_end = require_positive_int(rule["removeEndByte"], f"{rule_label}.removeEndByte")
        if remove_end <= remove_start:
            raise MigrationError(f"{rule_label} byte range must be non-empty")
        delete_line = rule["deleteLine"]
        if not isinstance(delete_line, bool):
            raise MigrationError(f"{rule_label}.deleteLine must be a boolean")
        parsed_rules.append(
            {
                "lineNumber": line_number,
                "preLineSha256": require_sha256(rule["preLineSha256"], f"{rule_label}.preLineSha256"),
                "removeStartByte": remove_start,
                "removeEndByte": remove_end,
                "removedSha256": require_sha256(rule["removedSha256"], f"{rule_label}.removedSha256"),
                "postLineSha256": require_sha256(rule["postLineSha256"], f"{rule_label}.postLineSha256"),
                "deleteLine": delete_line,
            }
        )
    parsed["lineTransforms"] = sorted(parsed_rules, key=lambda rule: rule["lineNumber"])
    return parsed


def load_manifest(path: Path) -> tuple[dict[str, Any], bytes]:
    raw, _ = read_regular_bytes_nofollow(path, "manifest")
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MigrationError("manifest is not valid UTF-8 JSON") from error
    manifest = require_object(decoded, "manifest")
    require_exact_keys(manifest, {"schemaVersion", "migrationVersion", "migrationId", "workspace"}, "manifest")
    if manifest["schemaVersion"] != MANIFEST_SCHEMA_VERSION:
        raise MigrationError("unsupported manifest schemaVersion")
    migration_version = require_positive_int(manifest["migrationVersion"], "manifest.migrationVersion")
    migration_id = manifest["migrationId"]
    if not isinstance(migration_id, str) or not MIGRATION_ID_RE.fullmatch(migration_id):
        raise MigrationError("manifest.migrationId is invalid")
    workspace = require_object(manifest["workspace"], "manifest.workspace")
    require_exact_keys(workspace, {"agents", "memory", "removeSymlinks"}, "manifest.workspace")
    agents = parse_file_transition(workspace["agents"], "manifest.workspace.agents", "AGENTS.md")
    memory = parse_file_transition(workspace["memory"], "manifest.workspace.memory", "MEMORY.md")
    links = workspace["removeSymlinks"]
    if not isinstance(links, list) or not links:
        raise MigrationError("manifest.workspace.removeSymlinks must be a non-empty array")
    parsed_links: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    for index, raw_link in enumerate(links):
        label = f"manifest.workspace.removeSymlinks[{index}]"
        link = require_object(raw_link, label)
        require_exact_keys(link, {"path", "targetSha256", "targetLength"}, label)
        relative = link["path"]
        if (
            not isinstance(relative, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", relative)
            or relative in seen_paths
        ):
            raise MigrationError(f"{label}.path must be a unique workspace-root name")
        seen_paths.add(relative)
        parsed_links.append(
            {
                "path": relative,
                "targetSha256": require_sha256(link["targetSha256"], f"{label}.targetSha256"),
                "targetLength": require_positive_int(link["targetLength"], f"{label}.targetLength"),
            }
        )
    return (
        {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "migrationVersion": migration_version,
            "migrationId": migration_id,
            "workspace": {"agents": agents, "memory": memory, "removeSymlinks": parsed_links},
        },
        raw,
    )


def require_directory_without_symlink(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise MigrationError(f"{label} does not exist") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise MigrationError(f"{label} must be a real directory")


def read_regular_file(path: Path, label: str) -> tuple[bytes, int]:
    data, metadata = read_regular_bytes_nofollow(path, label)
    return data, stat.S_IMODE(metadata.st_mode)


def resolve_template(manifest_path: Path, relative: str) -> Path:
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise MigrationError("agents template must stay below the manifest directory")
    root = manifest_path.parent
    require_directory_without_symlink(root, "manifest directory")
    candidate = root / relative
    current = root
    for component in Path(relative).parts[:-1]:
        current = current / component
        require_directory_without_symlink(current, "agents template parent")
    # The subsequent no-follow open is the authoritative file-type check.
    read_regular_bytes_nofollow(candidate, "agents template")
    return candidate


def transform_memory(source: bytes, rules: list[dict[str, Any]]) -> tuple[bytes, list[dict[str, Any]]]:
    try:
        source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MigrationError("MEMORY.md preimage is not valid UTF-8") from error
    lines = source.splitlines(keepends=True)
    rules_by_line = {rule["lineNumber"]: rule for rule in rules}
    result: list[bytes] = []
    summaries: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        rule = rules_by_line.get(line_number)
        if rule is None:
            result.append(line)
            continue
        if sha256_bytes(line) != rule["preLineSha256"]:
            raise MigrationError(f"MEMORY.md line {line_number} exact preimage check failed")
        start = rule["removeStartByte"]
        end = rule["removeEndByte"]
        if end > len(line):
            raise MigrationError(f"MEMORY.md line {line_number} byte range is out of bounds")
        removed = line[start:end]
        if sha256_bytes(removed) != rule["removedSha256"]:
            raise MigrationError(f"MEMORY.md line {line_number} removed range hash mismatch")
        post_line = line[:start] + line[end:]
        if rule["deleteLine"]:
            if start != 0 or end != len(line) or post_line:
                raise MigrationError(f"MEMORY.md line {line_number} deleteLine must remove the exact full line")
        else:
            try:
                post_line.decode("utf-8")
                removed.decode("utf-8")
            except UnicodeDecodeError as error:
                raise MigrationError(f"MEMORY.md line {line_number} byte range splits UTF-8 text") from error
        if sha256_bytes(post_line) != rule["postLineSha256"]:
            raise MigrationError(f"MEMORY.md line {line_number} exact postimage check failed")
        if not rule["deleteLine"]:
            result.append(post_line)
        summaries.append(
            {
                "lineNumber": line_number,
                "preLineSha256": rule["preLineSha256"],
                "removeStartByte": start,
                "removeEndByte": end,
                "removedSha256": rule["removedSha256"],
                "postLineSha256": rule["postLineSha256"],
                "deleteLine": rule["deleteLine"],
            }
        )
    missing_lines = sorted(set(rules_by_line) - set(range(1, len(lines) + 1)))
    if missing_lines:
        raise MigrationError(f"MEMORY.md line transforms are out of range: {missing_lines}")
    transformed = b"".join(result)
    try:
        transformed.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MigrationError("MEMORY.md postimage is not valid UTF-8") from error
    return transformed, summaries


def tree_fingerprint(root: Path) -> dict[str, Any]:
    """Hash a tree without following symlinks or exposing file contents."""

    if not root.exists() and not root.is_symlink():
        return {"sha256": sha256_bytes(b"[]\n"), "files": 0, "directories": 0, "symlinks": 0}
    metadata = root.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise MigrationError("workspace/automations must be a real directory when present")
    entries: list[dict[str, Any]] = []
    counts = {"files": 0, "directories": 0, "symlinks": 0}
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_directories: list[str] = []
        for name in sorted(directory_names):
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            item_metadata = path.lstat()
            if stat.S_ISLNK(item_metadata.st_mode):
                target = os.readlink(path)
                entries.append(
                    {
                        "path": relative,
                        "type": "symlink",
                        "mode": f"{stat.S_IMODE(item_metadata.st_mode):04o}",
                        "targetSha256": sha256_bytes(target.encode("utf-8")),
                    }
                )
                counts["symlinks"] += 1
            elif stat.S_ISDIR(item_metadata.st_mode):
                entries.append(
                    {
                        "path": relative,
                        "type": "directory",
                        "mode": f"{stat.S_IMODE(item_metadata.st_mode):04o}",
                    }
                )
                counts["directories"] += 1
                kept_directories.append(name)
            else:
                raise MigrationError("workspace/automations contains an unsupported directory entry")
        directory_names[:] = kept_directories
        for name in sorted(file_names):
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            item_metadata = path.lstat()
            if stat.S_ISLNK(item_metadata.st_mode):
                target = os.readlink(path)
                entries.append(
                    {
                        "path": relative,
                        "type": "symlink",
                        "mode": f"{stat.S_IMODE(item_metadata.st_mode):04o}",
                        "targetSha256": sha256_bytes(target.encode("utf-8")),
                    }
                )
                counts["symlinks"] += 1
            elif stat.S_ISREG(item_metadata.st_mode):
                data, _ = read_regular_bytes_nofollow(path, f"workspace automation {relative}")
                entries.append(
                    {
                        "path": relative,
                        "type": "file",
                        "mode": f"{stat.S_IMODE(item_metadata.st_mode):04o}",
                        "sha256": sha256_bytes(data),
                        "size": len(data),
                    }
                )
                counts["files"] += 1
            else:
                raise MigrationError("workspace/automations contains an unsupported file entry")
    return {"sha256": sha256_bytes(canonical_json_bytes(entries)), **counts}


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    temporary = path.parent / f".{path.name}.next.{os.getpid()}"
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode, follow_symlinks=False)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def ensure_receipt_directory(dsh_home: Path) -> Path:
    receipt_directory = dsh_home / "migration-receipts"
    try:
        receipt_directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    require_directory_without_symlink(receipt_directory, "migration receipt directory")
    current_mode = stat.S_IMODE(receipt_directory.lstat().st_mode)
    if current_mode != 0o700:
        raise MigrationError("migration receipt directory mode must be 0700")
    return receipt_directory


def read_receipt(path: Path) -> dict[str, Any] | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise MigrationError("migration receipt must be a regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise MigrationError("migration receipt mode must be 0600")
    try:
        receipt_raw, _ = read_regular_bytes_nofollow(path, "migration receipt")
        receipt = json.loads(receipt_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MigrationError("migration receipt is invalid") from error
    return require_object(receipt, "migration receipt")


def receipt_evidence_sha256(receipt: dict[str, Any]) -> str:
    evidence = {field: value for field, value in receipt.items() if field != "evidenceSha256"}
    return sha256_bytes(canonical_json_bytes(evidence))


def validate_automation_evidence(value: Any) -> None:
    evidence = require_object(value, "migration receipt automations")
    require_exact_keys(
        evidence,
        {"sha256", "files", "directories", "symlinks"},
        "migration receipt automations",
    )
    require_sha256(evidence["sha256"], "migration receipt automations.sha256")
    for field in ("files", "directories", "symlinks"):
        require_nonnegative_int(evidence[field], f"migration receipt automations.{field}")


def validate_receipt_identity(
    receipt: dict[str, Any], manifest: dict[str, Any], manifest_sha256: str, code_sha256: str
) -> str:
    required = {
        "schemaVersion",
        "migrationVersion",
        "migrationId",
        "status",
        "createdAt",
        "manifestSha256",
        "migrationCodeSha256",
        "templateSha256",
        "evidenceSha256",
        "agents",
        "memory",
        "automations",
        "removedSymlinks",
    }
    if receipt.get("status") == "applied":
        required.add("appliedAt")
    require_exact_keys(receipt, required, "migration receipt")
    if receipt["schemaVersion"] != RECEIPT_SCHEMA_VERSION:
        raise MigrationError("migration receipt schemaVersion mismatch")
    if receipt["status"] not in {"pending", "applied"}:
        raise MigrationError("migration receipt status is invalid")
    created_at = require_utc_seconds(receipt["createdAt"], "migration receipt createdAt")
    if receipt["status"] == "applied":
        applied_at = require_utc_seconds(receipt["appliedAt"], "migration receipt appliedAt")
        if applied_at < created_at:
            raise MigrationError("migration receipt appliedAt precedes createdAt")
    evidence_sha256 = require_sha256(receipt["evidenceSha256"], "migration receipt evidenceSha256")
    if evidence_sha256 != receipt_evidence_sha256(receipt):
        raise MigrationError("migration receipt evidence SHA-256 mismatch")
    validate_automation_evidence(receipt["automations"])
    expected_identity = {
        "migrationVersion": manifest["migrationVersion"],
        "migrationId": manifest["migrationId"],
        "manifestSha256": manifest_sha256,
        "migrationCodeSha256": code_sha256,
        "templateSha256": manifest["workspace"]["agents"]["postimageSha256"],
    }
    for key, expected in expected_identity.items():
        if receipt.get(key) != expected:
            raise MigrationError(f"migration ID conflict: receipt {key} differs")
    return receipt["status"]


def file_state(path: Path) -> tuple[str, int, bytes]:
    data, mode = read_regular_file(path, path.name)
    return sha256_bytes(data), mode, data


def regular_file_mode_nofollow(path: Path, label: str) -> int:
    try:
        path_metadata = path.lstat()
    except OSError as error:
        raise MigrationError(f"cannot inspect {label}: {error.strerror or error}") from error
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not stat.S_ISREG(path_metadata.st_mode)
        or path_metadata.st_nlink != 1
    ):
        raise MigrationError(f"{label} must be a single-link regular file")
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise MigrationError(f"cannot open {label} safely: {error.strerror or error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise MigrationError(f"{label} must be a single-link regular file")
        return stat.S_IMODE(metadata.st_mode)
    finally:
        os.close(descriptor)


def expected_file_state(
    current_sha256: str, current_mode: int, transition: dict[str, Any], allow_postimage: bool
) -> str:
    if current_sha256 == transition["preimageSha256"] and current_mode == transition["preimageMode"]:
        return "preimage"
    if (
        allow_postimage
        and current_sha256 == transition["postimageSha256"]
        and current_mode == transition["postimageMode"]
    ):
        return "postimage"
    raise MigrationError(f"{transition['path']} exact preimage/postimage check failed")


def build_pending_receipt(
    manifest: dict[str, Any],
    manifest_sha256: str,
    code_sha256: str,
    line_transform_summaries: list[dict[str, Any]],
    automations: dict[str, Any],
) -> dict[str, Any]:
    agents = manifest["workspace"]["agents"]
    memory = manifest["workspace"]["memory"]
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "migrationVersion": manifest["migrationVersion"],
        "migrationId": manifest["migrationId"],
        "status": "pending",
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "manifestSha256": manifest_sha256,
        "migrationCodeSha256": code_sha256,
        "templateSha256": agents["postimageSha256"],
        "agents": {
            "preimageSha256": agents["preimageSha256"],
            "postimageSha256": agents["postimageSha256"],
        },
        "memory": {
            "preimageSha256": memory["preimageSha256"],
            "postimageSha256": memory["postimageSha256"],
            "lineTransforms": line_transform_summaries,
        },
        "automations": automations,
        "removedSymlinks": [
            {
                "path": item["path"],
                "targetSha256": item["targetSha256"],
                "targetLength": item["targetLength"],
            }
            for item in manifest["workspace"]["removeSymlinks"]
        ],
    }
    receipt["evidenceSha256"] = receipt_evidence_sha256(receipt)
    return receipt


def verify_receipt_plan(receipt: dict[str, Any], expected: dict[str, Any], include_automations: bool) -> None:
    keys = ["agents", "memory", "removedSymlinks"]
    if include_automations:
        keys.append("automations")
    for key in keys:
        if receipt.get(key) != expected.get(key):
            raise MigrationError(f"migration ID conflict: receipt {key} differs")


def apply_migration(dsh_home: Path, manifest_path: Path) -> dict[str, Any]:
    require_directory_without_symlink(dsh_home, "DSH_HOME")
    workspace = dsh_home / "workspace"
    require_directory_without_symlink(workspace, "DSH workspace")
    manifest, manifest_raw = load_manifest(manifest_path)
    manifest_sha256 = sha256_bytes(manifest_raw)
    code_bytes, _ = read_regular_bytes_nofollow(Path(__file__), "migration engine")
    code_sha256 = sha256_bytes(code_bytes)
    receipt_directory = dsh_home / "migration-receipts"
    receipt_path = receipt_directory / f"{manifest['migrationId']}.json"
    try:
        receipt_directory_metadata = receipt_directory.lstat()
    except FileNotFoundError:
        existing_receipt = None
    else:
        if stat.S_ISLNK(receipt_directory_metadata.st_mode) or not stat.S_ISDIR(receipt_directory_metadata.st_mode):
            raise MigrationError("migration receipt directory must be a real directory")
        if stat.S_IMODE(receipt_directory_metadata.st_mode) != 0o700:
            raise MigrationError("migration receipt directory mode must be 0700")
        existing_receipt = read_receipt(receipt_path)
    agents_transition = manifest["workspace"]["agents"]
    memory_transition = manifest["workspace"]["memory"]
    agents_path = workspace / "AGENTS.md"
    memory_path = workspace / "MEMORY.md"

    template_path = resolve_template(manifest_path, agents_transition["template"])
    template_data, _ = read_regular_file(template_path, "agents template")
    if sha256_bytes(template_data) != agents_transition["postimageSha256"]:
        raise MigrationError("agents template SHA-256 does not match the declared postimage")

    receipt_status: str | None = None
    if existing_receipt is not None:
        receipt_status = validate_receipt_identity(existing_receipt, manifest, manifest_sha256, code_sha256)

    allow_postimage = receipt_status is not None
    agents_sha256, agents_mode, _ = file_state(agents_path)
    agents_state = expected_file_state(agents_sha256, agents_mode, agents_transition, allow_postimage)

    if receipt_status == "applied":
        memory_mode = regular_file_mode_nofollow(memory_path, "MEMORY.md")
        if memory_mode != memory_transition["postimageMode"]:
            raise MigrationError("MEMORY.md mode changed after the applied migration")
        memory_state = "mutable-after-applied"
        memory_data = b""
        transformed_memory = b""
        line_transform_summaries = [dict(rule) for rule in memory_transition["lineTransforms"]]
    else:
        memory_sha256, memory_mode, memory_data = file_state(memory_path)
        memory_state = expected_file_state(memory_sha256, memory_mode, memory_transition, allow_postimage)

        if memory_state == "preimage":
            transformed_memory, line_transform_summaries = transform_memory(
                memory_data, memory_transition["lineTransforms"]
            )
            if sha256_bytes(transformed_memory) != memory_transition["postimageSha256"]:
                raise MigrationError("MEMORY.md deterministic postimage SHA-256 mismatch")
        else:
            line_transform_summaries = [dict(rule) for rule in memory_transition["lineTransforms"]]
            transformed_memory = memory_data

    link_states: dict[str, str] = {}
    for link in manifest["workspace"]["removeSymlinks"]:
        path = workspace / link["path"]
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            if receipt_status is None:
                raise MigrationError(f"obsolete symlink {link['path']} exact preimage check failed")
            link_states[link["path"]] = "absent"
            continue
        if receipt_status == "applied":
            raise MigrationError(f"obsolete link path {link['path']} reappeared after the applied migration")
        if not stat.S_ISLNK(metadata.st_mode):
            raise MigrationError(f"obsolete symlink {link['path']} exact target check failed")
        target_bytes = os.fsencode(os.readlink(path))
        if sha256_bytes(target_bytes) != link["targetSha256"] or len(target_bytes) != link["targetLength"]:
            raise MigrationError(f"obsolete symlink {link['path']} exact target check failed")
        link_states[link["path"]] = "present"

    if receipt_status == "applied":
        expected_plan = build_pending_receipt(
            manifest,
            manifest_sha256,
            code_sha256,
            line_transform_summaries,
            existing_receipt["automations"],
        )
        verify_receipt_plan(existing_receipt, expected_plan, include_automations=True)
        if agents_state != "postimage" or any(state != "absent" for state in link_states.values()):
            raise MigrationError("applied migration receipt does not match immutable workspace state")
        return {
            "status": "already-applied",
            "migrationId": manifest["migrationId"],
            "migrationVersion": manifest["migrationVersion"],
            "manifestSha256": manifest_sha256,
            "receiptSha256": sha256_bytes(read_regular_file(receipt_path, "migration receipt")[0]),
            "memoryState": memory_state,
        }

    automations_before = tree_fingerprint(workspace / "automations")
    pending_receipt = build_pending_receipt(
        manifest, manifest_sha256, code_sha256, line_transform_summaries, automations_before
    )
    if existing_receipt is None:
        receipt_directory = ensure_receipt_directory(dsh_home)
        receipt_path = receipt_directory / f"{manifest['migrationId']}.json"
        if receipt_path.exists() or receipt_path.is_symlink():
            raise MigrationError("migration receipt appeared after preflight; retry from a consistent state")
        atomic_write(receipt_path, canonical_json_bytes(pending_receipt), 0o600)
        receipt = pending_receipt
    else:
        verify_receipt_plan(existing_receipt, pending_receipt, include_automations=True)
        receipt = existing_receipt

    if agents_state == "preimage":
        atomic_write(agents_path, template_data, agents_transition["postimageMode"])
    if memory_state == "preimage":
        atomic_write(memory_path, transformed_memory, memory_transition["postimageMode"])
    for link in manifest["workspace"]["removeSymlinks"]:
        path = workspace / link["path"]
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISLNK(metadata.st_mode):
            raise MigrationError(f"obsolete symlink {link['path']} changed during migration")
        target_bytes = os.fsencode(os.readlink(path))
        if sha256_bytes(target_bytes) != link["targetSha256"] or len(target_bytes) != link["targetLength"]:
            raise MigrationError(f"obsolete symlink {link['path']} changed during migration")
        path.unlink()
        fsync_directory(workspace)

    final_agents_sha256, final_agents_mode, _ = file_state(agents_path)
    final_memory_sha256, final_memory_mode, _ = file_state(memory_path)
    expected_file_state(final_agents_sha256, final_agents_mode, agents_transition, True)
    expected_file_state(final_memory_sha256, final_memory_mode, memory_transition, True)
    if final_agents_sha256 != agents_transition["postimageSha256"]:
        raise MigrationError("AGENTS.md did not reach the exact postimage")
    if final_memory_sha256 != memory_transition["postimageSha256"]:
        raise MigrationError("MEMORY.md did not reach the exact postimage")
    for link in manifest["workspace"]["removeSymlinks"]:
        if (workspace / link["path"]).exists() or (workspace / link["path"]).is_symlink():
            raise MigrationError(f"obsolete symlink {link['path']} still exists")
    automations_after = tree_fingerprint(workspace / "automations")
    if automations_after != automations_before or automations_after != receipt["automations"]:
        raise MigrationError("workspace automations changed during migration")

    final_receipt = dict(receipt)
    final_receipt["status"] = "applied"
    final_receipt["appliedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    final_receipt["evidenceSha256"] = receipt_evidence_sha256(final_receipt)
    atomic_write(receipt_path, canonical_json_bytes(final_receipt), 0o600)
    return {
        "status": "applied",
        "migrationId": manifest["migrationId"],
        "migrationVersion": manifest["migrationVersion"],
        "manifestSha256": manifest_sha256,
        "receiptSha256": sha256_bytes(read_regular_file(receipt_path, "migration receipt")[0]),
        "removedSymlinkCount": len(manifest["workspace"]["removeSymlinks"]),
        "memoryLineTransformCount": len(line_transform_summaries),
        "automationsSha256": automations_after["sha256"],
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = apply_migration(args.dsh_home, args.manifest)
    except MigrationError as error:
        failure = {"status": "error", "error": str(error)}
        if args.json:
            print(json.dumps(failure, ensure_ascii=False, sort_keys=True))
        else:
            print(f"workspace migration blocked: {error}", file=sys.stderr)
        return 4
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        print(f"workspace migration {result['status']}: {result['migrationId']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
