#!/usr/bin/env python3
"""Check active DSH instructions, automations, profiles, and product Skills."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


TEXT_SUFFIXES = {
    ".cjs",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".txt",
    ".yaml",
    ".yml",
}
SCRIPT_SUFFIXES = {".cjs", ".js", ".mjs", ".py", ".sh", ".ts"}
FORBIDDEN_LINK_NAMES = {"openclaw-shared", "task-inbox-shared"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UTC_SECONDS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
RECEIPT_SCHEMA_VERSION = 2
FORBIDDEN_BYTE_PATTERNS = (
    (
        "external-state-path",
        re.compile(rb"(?i)(?:^|[\\/])\.openclaw(?:[\\/]|$)|/home/herman/task-inbox-workflow(?:[\\/]|$)"),
    ),
    ("obsolete-shared-link", re.compile(rb"(?i)\b(?:openclaw-shared|task-inbox-shared)\b")),
)
CLI_PATTERNS = (
    re.compile(rb"(?im)(?:^|&&|\|\||;|\|)[ \t]*(?:exec[ \t]+|command[ \t]+)?openclaw(?:[ \t]|$)"),
    re.compile(
        rb"(?i)(?:spawn|execfile|subprocess\.(?:run|call|popen|check_call|check_output))"
        rb"[^\n]{0,160}['\"]openclaw['\"]"
    ),
)


class HealthError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def require_exact_keys(value: Any, required: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != required:
        raise HealthError(f"{label} fields do not match the release contract")


def require_utc_seconds(value: Any, label: str) -> str:
    if not isinstance(value, str) or not UTC_SECONDS_RE.fullmatch(value):
        raise HealthError(f"{label} is invalid")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise HealthError(f"{label} is invalid") from error
    return value


def read_regular_bytes_nofollow(path: Path, label: str) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise HealthError(f"cannot open {label} safely: {error.strerror or error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise HealthError(f"{label} must be a single-link regular file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    except OSError as error:
        raise HealthError(f"cannot read {label}: {error.strerror or error}") from error
    finally:
        os.close(descriptor)


def require_real_directory(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise HealthError(f"{label} does not exist") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise HealthError(f"{label} must be a real directory")


def require_regular(path: Path, label: str) -> bytes:
    return read_regular_bytes_nofollow(path, label)


def load_manifest(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = read_regular_bytes_nofollow(path, "workspace migration manifest")
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HealthError("workspace migration manifest is not valid JSON") from error
    try:
        require_exact_keys(manifest, {"schemaVersion", "migrationVersion", "migrationId", "workspace"}, "manifest")
        if (
            manifest["schemaVersion"] != 1
            or isinstance(manifest["migrationVersion"], bool)
            or not isinstance(manifest["migrationVersion"], int)
            or manifest["migrationVersion"] < 1
        ):
            raise HealthError("unsupported workspace migration manifest")
        if not isinstance(manifest["migrationId"], str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9._-]{0,95}", manifest["migrationId"]
        ):
            raise HealthError("workspace migration manifest has an invalid migration ID")
        workspace = manifest["workspace"]
        require_exact_keys(workspace, {"agents", "memory", "removeSymlinks"}, "manifest workspace")
        agents = workspace["agents"]
        memory = workspace["memory"]
        links = workspace["removeSymlinks"]
        require_exact_keys(
            agents,
            {"path", "preimageSha256", "postimageSha256", "preimageMode", "postimageMode", "template"},
            "manifest agents transition",
        )
        require_exact_keys(
            memory,
            {
                "path",
                "preimageSha256",
                "postimageSha256",
                "preimageMode",
                "postimageMode",
                "lineTransforms",
            },
            "manifest memory transition",
        )
        if agents["path"] != "AGENTS.md" or memory["path"] != "MEMORY.md":
            raise HealthError("workspace migration manifest has unexpected state paths")
        for digest in (
            agents["preimageSha256"],
            agents["postimageSha256"],
            memory["preimageSha256"],
            memory["postimageSha256"],
        ):
            if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
                raise HealthError("workspace migration manifest has an invalid postimage hash")
        if agents["preimageMode"] != "0644" or agents["postimageMode"] != "0644":
            raise HealthError("workspace AGENTS.md modes are invalid")
        if memory["preimageMode"] != "0600" or memory["postimageMode"] != "0600":
            raise HealthError("workspace MEMORY.md modes are invalid")
        if not isinstance(agents["template"], str) or not agents["template"]:
            raise HealthError("workspace AGENTS.md template path is invalid")
        if not isinstance(memory["lineTransforms"], list) or not memory["lineTransforms"]:
            raise HealthError("workspace MEMORY.md transforms are invalid")
        transform_fields = {
            "lineNumber",
            "preLineSha256",
            "removeStartByte",
            "removeEndByte",
            "removedSha256",
            "postLineSha256",
            "deleteLine",
        }
        seen_lines: set[int] = set()
        for transform in memory["lineTransforms"]:
            require_exact_keys(transform, transform_fields, "manifest MEMORY.md transform")
            line_number = transform["lineNumber"]
            if (
                isinstance(line_number, bool)
                or not isinstance(line_number, int)
                or line_number < 1
                or line_number in seen_lines
            ):
                raise HealthError("workspace MEMORY.md transforms are invalid")
            seen_lines.add(line_number)
            for field in ("preLineSha256", "removedSha256", "postLineSha256"):
                if not isinstance(transform[field], str) or not SHA256_RE.fullmatch(transform[field]):
                    raise HealthError("workspace MEMORY.md transforms are invalid")
            start = transform["removeStartByte"]
            end = transform["removeEndByte"]
            if (
                isinstance(start, bool)
                or not isinstance(start, int)
                or start < 0
                or isinstance(end, bool)
                or not isinstance(end, int)
                or end <= start
                or not isinstance(transform["deleteLine"], bool)
            ):
                raise HealthError("workspace MEMORY.md transforms are invalid")
        if not isinstance(links, list) or not links:
            raise HealthError("workspace migration manifest has no obsolete symlinks")
        seen_links: set[str] = set()
        for link in links:
            require_exact_keys(link, {"path", "targetSha256", "targetLength"}, "manifest symlink transition")
            if (
                not isinstance(link["path"], str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", link["path"])
                or link["path"] in seen_links
                or not isinstance(link["targetSha256"], str)
                or not SHA256_RE.fullmatch(link["targetSha256"])
                or isinstance(link["targetLength"], bool)
                or not isinstance(link["targetLength"], int)
                or link["targetLength"] < 1
            ):
                raise HealthError("workspace migration manifest has an invalid symlink rule")
            seen_links.add(link["path"])
    except (KeyError, TypeError) as error:
        raise HealthError("workspace migration manifest is incomplete") from error
    return manifest, raw


def walk_active_files(root: Path, category: str, suffixes: set[str]) -> Iterable[tuple[Path, str]]:
    require_real_directory(root, category)
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_directories: list[str] = []
        for name in sorted(directory_names):
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                yield path, f"{category}-symlink"
            elif stat.S_ISDIR(metadata.st_mode):
                kept_directories.append(name)
            else:
                yield path, f"{category}-unsupported"
        directory_names[:] = kept_directories
        for name in sorted(file_names):
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                yield path, f"{category}-symlink"
            elif stat.S_ISREG(metadata.st_mode) and path.suffix.lower() in suffixes:
                yield path, category


def relative_display(path: Path, roots: list[tuple[Path, str]]) -> str:
    for root, label in roots:
        try:
            return f"{label}/{path.relative_to(root).as_posix()}"
        except ValueError:
            continue
    return path.name


def scan_file(path: Path, category: str, display: str) -> list[dict[str, Any]]:
    data = require_regular(path, display)
    findings: list[dict[str, Any]] = []
    for rule, pattern in FORBIDDEN_BYTE_PATTERNS:
        match = pattern.search(data)
        if match:
            findings.append({"path": display, "rule": rule, "line": data.count(b"\n", 0, match.start()) + 1})
    if path.suffix.lower() in SCRIPT_SUFFIXES or category == "automation":
        for pattern in CLI_PATTERNS:
            match = pattern.search(data)
            if match:
                findings.append(
                    {"path": display, "rule": "external-cli-invocation", "line": data.count(b"\n", 0, match.start()) + 1}
                )
                break
    return findings


def receipt_evidence_sha256(receipt: dict[str, Any]) -> str:
    evidence = {field: value for field, value in receipt.items() if field != "evidenceSha256"}
    return sha256_bytes(canonical_json_bytes(evidence))


def expected_receipt_plan(manifest: dict[str, Any]) -> dict[str, Any]:
    agents = manifest["workspace"]["agents"]
    memory = manifest["workspace"]["memory"]
    transforms = sorted(memory["lineTransforms"], key=lambda rule: rule["lineNumber"])
    return {
        "agents": {
            "preimageSha256": agents["preimageSha256"],
            "postimageSha256": agents["postimageSha256"],
        },
        "memory": {
            "preimageSha256": memory["preimageSha256"],
            "postimageSha256": memory["postimageSha256"],
            "lineTransforms": transforms,
        },
        "removedSymlinks": [
            {
                "path": item["path"],
                "targetSha256": item["targetSha256"],
                "targetLength": item["targetLength"],
            }
            for item in manifest["workspace"]["removeSymlinks"]
        ],
    }


def validate_automation_evidence(value: Any) -> None:
    if not isinstance(value, dict):
        raise HealthError("migration receipt automation evidence is invalid")
    require_exact_keys(
        value,
        {"sha256", "files", "directories", "symlinks"},
        "migration receipt automation evidence",
    )
    if not isinstance(value["sha256"], str) or not SHA256_RE.fullmatch(value["sha256"]):
        raise HealthError("migration receipt automation evidence is invalid")
    for field in ("files", "directories", "symlinks"):
        count = value[field]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise HealthError("migration receipt automation evidence is invalid")


def load_and_validate_applied_receipt(
    dsh_home: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    manifest_raw: bytes,
) -> tuple[dict[str, Any], str]:
    receipt_directory = dsh_home / "migration-receipts"
    require_real_directory(receipt_directory, "migration receipt directory")
    if stat.S_IMODE(receipt_directory.lstat().st_mode) != 0o700:
        raise HealthError("migration receipt directory mode must be 0700")
    receipt_path = receipt_directory / f"{manifest['migrationId']}.json"
    receipt_raw = read_regular_bytes_nofollow(receipt_path, "migration receipt")
    if stat.S_IMODE(receipt_path.lstat().st_mode) != 0o600:
        raise HealthError("migration receipt mode must be 0600")
    try:
        receipt = json.loads(receipt_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HealthError("migration receipt is invalid") from error
    if not isinstance(receipt, dict):
        raise HealthError("migration receipt is invalid")
    require_exact_keys(
        receipt,
        {
            "schemaVersion",
            "migrationVersion",
            "migrationId",
            "status",
            "createdAt",
            "appliedAt",
            "manifestSha256",
            "migrationCodeSha256",
            "templateSha256",
            "evidenceSha256",
            "agents",
            "memory",
            "automations",
            "removedSymlinks",
        },
        "migration receipt",
    )
    if receipt["schemaVersion"] != RECEIPT_SCHEMA_VERSION or receipt["status"] != "applied":
        raise HealthError("migration receipt is not an applied receipt for this release")
    created_at = require_utc_seconds(receipt["createdAt"], "migration receipt createdAt")
    applied_at = require_utc_seconds(receipt["appliedAt"], "migration receipt appliedAt")
    if applied_at < created_at:
        raise HealthError("migration receipt appliedAt precedes createdAt")

    code_path = Path(__file__).with_name("migrate-workspace-state.py")
    code_sha256 = sha256_bytes(read_regular_bytes_nofollow(code_path, "migration engine"))
    template_relative = Path(manifest["workspace"]["agents"]["template"])
    if template_relative.is_absolute() or ".." in template_relative.parts:
        raise HealthError("workspace AGENTS.md template path escapes the manifest directory")
    template_path = manifest_path.parent / template_relative
    template_sha256 = sha256_bytes(read_regular_bytes_nofollow(template_path, "workspace AGENTS.md template"))
    expected_identity = {
        "migrationVersion": manifest["migrationVersion"],
        "migrationId": manifest["migrationId"],
        "manifestSha256": sha256_bytes(manifest_raw),
        "migrationCodeSha256": code_sha256,
        "templateSha256": manifest["workspace"]["agents"]["postimageSha256"],
    }
    if template_sha256 != expected_identity["templateSha256"]:
        raise HealthError("workspace AGENTS.md template differs from the manifest")
    for field, expected in expected_identity.items():
        if receipt.get(field) != expected:
            raise HealthError(f"migration receipt {field} differs from the installed release")
    expected_plan = expected_receipt_plan(manifest)
    for field, expected in expected_plan.items():
        if receipt.get(field) != expected:
            raise HealthError(f"migration receipt {field} does not preserve the first transition evidence")
    validate_automation_evidence(receipt["automations"])
    evidence_sha256 = receipt["evidenceSha256"]
    if not isinstance(evidence_sha256, str) or not SHA256_RE.fullmatch(evidence_sha256):
        raise HealthError("migration receipt evidence SHA-256 is invalid")
    if evidence_sha256 != receipt_evidence_sha256(receipt):
        raise HealthError("migration receipt evidence SHA-256 mismatch")
    return receipt, sha256_bytes(receipt_raw)


def check_state(dsh_home: Path, manifest_path: Path, product_skills_root: Path) -> dict[str, Any]:
    require_real_directory(dsh_home, "DSH_HOME")
    workspace = dsh_home / "workspace"
    profiles = dsh_home / "profiles"
    require_real_directory(workspace, "DSH workspace")
    require_real_directory(profiles, "DSH profiles")
    require_real_directory(product_skills_root, "product Skills root")
    manifest, manifest_raw = load_manifest(manifest_path)
    receipt, receipt_sha256 = load_and_validate_applied_receipt(
        dsh_home, manifest_path, manifest, manifest_raw
    )

    agents_path = workspace / "AGENTS.md"
    memory_path = workspace / "MEMORY.md"
    agents_data = require_regular(agents_path, "workspace/AGENTS.md")
    if sha256_bytes(agents_data) != manifest["workspace"]["agents"]["postimageSha256"]:
        raise HealthError("workspace/AGENTS.md does not match the declared postimage")
    if stat.S_IMODE(agents_path.lstat().st_mode) != 0o644:
        raise HealthError("workspace/AGENTS.md mode must remain 0644")
    # MEMORY.md is intentionally mutable after the applied receipt. Health
    # checks only its safe file identity/mode and never reads or scans its body.
    try:
        memory_metadata = memory_path.lstat()
    except OSError as error:
        raise HealthError("workspace/MEMORY.md is unavailable") from error
    if (
        stat.S_ISLNK(memory_metadata.st_mode)
        or not stat.S_ISREG(memory_metadata.st_mode)
        or memory_metadata.st_nlink != 1
        or stat.S_IMODE(memory_metadata.st_mode) != 0o600
    ):
        raise HealthError("workspace/MEMORY.md must remain a private single-link regular file")

    findings: list[dict[str, Any]] = []
    for link in manifest["workspace"]["removeSymlinks"]:
        path = workspace / link["path"]
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            target = os.fsencode(os.readlink(path))
            findings.append(
                {
                    "path": f"workspace/{link['path']}",
                    "rule": "obsolete-shared-link",
                    "targetSha256": sha256_bytes(target),
                }
            )
        else:
            findings.append({"path": f"workspace/{link['path']}", "rule": "obsolete-link-path-reused"})

    roots = [(workspace, "workspace"), (profiles, "profiles"), (product_skills_root, "skills")]
    scanned_files = 0
    findings.extend(scan_file(agents_path, "instruction", "workspace/AGENTS.md"))
    scanned_files += 1

    root_agents = dsh_home / "AGENTS.md"
    if root_agents.exists() or root_agents.is_symlink():
        findings.extend(scan_file(root_agents, "instruction", "dsh-home/AGENTS.md"))
        scanned_files += 1

    automations = workspace / "automations"
    if automations.exists() or automations.is_symlink():
        for path, category in walk_active_files(automations, "automation", TEXT_SUFFIXES):
            display = relative_display(path, roots)
            if category.endswith("-symlink"):
                target = os.fsencode(os.readlink(path))
                findings.append(
                    {
                        "path": display,
                        "rule": "automation-symlink-not-allowed",
                        "targetSha256": sha256_bytes(target),
                    }
                )
                continue
            if category.endswith("-unsupported"):
                findings.append({"path": display, "rule": "unsupported-active-entry"})
                continue
            findings.extend(scan_file(path, "automation", display))
            scanned_files += 1

    for root, category, suffixes in (
        (profiles, "profile", TEXT_SUFFIXES),
        (product_skills_root, "skill", TEXT_SUFFIXES),
    ):
        for path, observed_category in walk_active_files(root, category, suffixes):
            display = relative_display(path, roots)
            if observed_category.endswith("-symlink"):
                target = os.fsencode(os.readlink(path))
                if path.name in FORBIDDEN_LINK_NAMES or any(
                    pattern.search(target) for _, pattern in FORBIDDEN_BYTE_PATTERNS
                ):
                    findings.append(
                        {
                            "path": display,
                            "rule": "obsolete-shared-link",
                            "targetSha256": sha256_bytes(target),
                        }
                    )
                continue
            if observed_category.endswith("-unsupported"):
                findings.append({"path": display, "rule": "unsupported-active-entry"})
                continue
            findings.extend(scan_file(path, category, display))
            scanned_files += 1

    if findings:
        raise HealthError(json.dumps({"findings": findings}, ensure_ascii=False, sort_keys=True))
    return {
        "status": "pass",
        "scannedFileCount": scanned_files,
        "workspaceAgentsSha256": sha256_bytes(agents_data),
        "workspaceMemoryState": "mutable-after-applied-receipt",
        "migrationReceiptSha256": receipt_sha256,
        "migrationEvidenceSha256": receipt["evidenceSha256"],
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--product-skills-root", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = check_state(args.dsh_home, args.manifest, args.product_skills_root)
    except HealthError as error:
        detail: Any
        try:
            detail = json.loads(str(error))
        except json.JSONDecodeError:
            detail = {"message": str(error)}
        failure = {"status": "error", "error": detail}
        if args.json:
            print(json.dumps(failure, ensure_ascii=False, sort_keys=True))
        else:
            print(f"Harness-only state check failed: {error}", file=sys.stderr)
        return 4
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        print(f"Harness-only state check passed: files={result['scannedFileCount']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
