#!/usr/bin/env python3
"""Run one tightly isolated Harness authoring task on the accepted DSH image."""

from __future__ import annotations

import ast
import contextlib
import ctypes
import datetime
import errno
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import types
import uuid
from pathlib import Path
from typing import Any, NamedTuple


STATE_ROOT = Path("/home/herman/.local/share/dsh-container")
RELEASES_ROOT = STATE_ROOT / "releases"
LOCK_PATH = STATE_ROOT / "locks/production-operation.lock"
DSH_HOME = Path("/home/herman/.dsh")
PRODUCTION_CREDENTIAL = DSH_HOME / ".credentials.yaml"
AUTOMATIONS_ROOT = DSH_HOME / "workspace/automations"
TARGET = AUTOMATIONS_ROOT / "notion"
TASKS_ROOT = STATE_ROOT / "harness-tasks"
ENTRYPOINT = Path("notion_inbox_sync.py")
TEST_INIT = Path("tests/__init__.py")
TEST_SUITE = Path("tests/test_notion_inbox_sync.py")
TEST_RECEIPT = Path("notion_inbox_sync.test-receipt.json")
HANDOFF = Path("notion_inbox_sync.handoff.json")
IMPLEMENTATION_FILES = (ENTRYPOINT,)
GENERATED_FILES = (ENTRYPOINT, TEST_INIT, TEST_SUITE)
INSTALLED_FILES = (*GENERATED_FILES, TEST_RECEIPT, HANDOFF)
TEST_CLASS = "NotionInboxSyncContractTests"
TEST_METHODS = (
    "test_atomic_artifacts",
    "test_conflict",
    "test_first_pull",
    "test_force",
    "test_network_recovery",
    "test_no_pending_no_api",
    "test_pending_retry",
    "test_pull_failure_no_pending",
    "test_push",
    "test_read",
    "test_secret_redaction",
    "test_set",
)
HANDOFF_NAMES = {
    "test_atomic_artifacts": "atomicArtifacts",
    "test_conflict": "conflict",
    "test_first_pull": "firstPull",
    "test_force": "force",
    "test_network_recovery": "networkRecovery",
    "test_no_pending_no_api": "noPendingNoApi",
    "test_pending_retry": "pendingRetry",
    "test_pull_failure_no_pending": "pullFailureNoPending",
    "test_push": "push",
    "test_read": "read",
    "test_secret_redaction": "secretRedaction",
    "test_set": "set",
}
ARTIFACT_CONTRACT = {
    "interfaceVersion": 1,
    "state": {"role": "state", "path": "storages/task-inbox/sync-state.json", "mode": "0600"},
    "fingerprint": {
        "role": "fingerprint",
        "path": "storages/task-inbox/notion-fingerprint.json",
        "mode": "0600",
    },
}
MAX_SOURCE_BYTES = 1024 * 1024
MAX_CREDENTIAL_BYTES = 1024 * 1024
MAX_TEST_BYTES = 2 * 1024 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
MAX_PROBE_BYTES = 512 * 1024
EXPECTED_HARNESS_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
EXPECTED_HARNESS_PATCH_SHA256 = "sha256:df85af4402b238a666bc7117092e559ae843df55c850ea6b711c1c8f3a292e0b"
ASSET_LIMITS = {
    "bridge": 64 * 1024,
    "patch": 64 * 1024,
    "prompt": 128 * 1024,
    "checker": 256 * 1024,
    "probe": MAX_PROBE_BYTES,
}
DOCKER_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/home/herman",
    "LANG": "C.UTF-8",
}
RESOURCE_OWNER_LABEL = "io.dsh.owner"
RESOURCE_OWNER_VALUE = "harness-notion-automation"
RESOURCE_NONCE_LABEL = "io.dsh.operation-nonce"


class ContainerRef(NamedTuple):
    name: str
    resource_id: str
    nonce: str
    image_id: str


class NetworkRef(NamedTuple):
    name: str
    resource_id: str
    nonce: str
    internal: bool


class RunnerError(Exception):
    pass


HEADLESS_CODE_CLASSES = {
    "ABORTED": "aborted",
    "AUTH": "auth",
    "CONTEXT_WINDOW_EXCEEDED": "context-window",
    "EMPTY_RESPONSE": "empty-response",
    "HTTP_400": "http-error",
    "HTTP_401": "auth",
    "HTTP_403": "auth",
    "HTTP_404": "http-error",
    "HTTP_409": "http-error",
    "HTTP_413": "invalid-request",
    "HTTP_429": "rate-limit",
    "INVALID_CREDENTIAL": "auth",
    "INVALID_REQUEST": "invalid-request",
    "MALFORMED_RESPONSE": "malformed-response",
    "MISSING_CREDENTIAL": "auth",
    "NO_ADAPTER": "model-configuration",
    "QUOTA": "quota",
    "RATE_LIMIT": "rate-limit",
    "SERVER": "server",
    "STREAM_CLOSED": "stream-closed",
    "TIMEOUT": "timeout",
    "TRANSPORT": "transport",
    "UNSUPPORTED_CONTENT": "unsupported-content",
}
HEADLESS_TERMINAL_CLASSES = frozenset({
    *HEADLESS_CODE_CLASSES.values(),
    "container-oom",
    "diagnostic-overflow",
    "noncompleted-no-code",
    "runner-timeout",
    "unclassified",
})
HEADLESS_DIAGNOSTIC_LIMIT = 16 * 1024
AUTHORING_PHASES = ("implementation", "tests")
AUTHORING_PHASE_TIMEOUT = 780
GENERATED_TEST_GATE_CATEGORIES = (
    "generated-test-00",
    "generated-test-01",
    "generated-test-02",
    "generated-test-03",
    "generated-test-04",
    "generated-test-05",
    "generated-test-06",
    "generated-test-07",
    "generated-test-08",
    "generated-test-09",
    "generated-test-10",
    "generated-test-11",
)
GENERATED_TEST_DIAGNOSTIC_LIMIT = 256 * 1024
TRUSTED_PROBE_STAGES = (
    "initialization",
    "source-policy",
    "test-atomic-artifacts",
    "test-atomic-artifacts-preflight",
    "test-atomic-artifacts-preflight-token-symlink-command",
    "test-atomic-artifacts-preflight-token-symlink-outcome",
    "test-atomic-artifacts-preflight-token-symlink-preservation",
    "test-atomic-artifacts-preflight-token-symlink-residue",
    "test-atomic-artifacts-preflight-mirror-symlink-command",
    "test-atomic-artifacts-preflight-mirror-symlink-outcome",
    "test-atomic-artifacts-preflight-mirror-symlink-preservation",
    "test-atomic-artifacts-preflight-mirror-symlink-residue",
    "test-atomic-artifacts-preflight-state-symlink-command",
    "test-atomic-artifacts-preflight-state-symlink-outcome",
    "test-atomic-artifacts-preflight-state-symlink-preservation",
    "test-atomic-artifacts-preflight-state-symlink-residue",
    "test-atomic-artifacts-preflight-fingerprint-symlink-command",
    "test-atomic-artifacts-preflight-fingerprint-symlink-outcome",
    "test-atomic-artifacts-preflight-fingerprint-symlink-preservation",
    "test-atomic-artifacts-preflight-fingerprint-symlink-residue",
    "test-atomic-artifacts-initial-success",
    "test-atomic-artifacts-initial-crash-before",
    "test-atomic-artifacts-initial-crash-after",
    "test-atomic-artifacts-steady-success",
    "test-atomic-artifacts-steady-crash-before",
    "test-atomic-artifacts-steady-crash-after",
    "test-atomic-artifacts-recovery",
    "test-atomic-artifacts-convergence",
    "test-conflict",
    "test-first-pull",
    "test-force",
    "test-network-recovery",
    "test-no-pending-no-api",
    "test-pending-retry",
    "test-pull-failure-no-pending",
    "test-push",
    "test-read",
    "test-secret-redaction",
    "test-set",
    "receipt",
    "internal",
)
TRUSTED_PROBE_DIAGNOSTIC_LIMIT = 256 * 1024
TRUSTED_PROBE_FAILURE_PREFIX = b"dsh-probe: "
FIXED_GATE_CATEGORIES = frozenset({
    "authoring-teardown",
    *GENERATED_TEST_GATE_CATEGORIES,
    "implementation-artifact",
    "tests-tree",
    "tests-source-identity",
    "tests-modes",
    "tests-manifest",
    "tests-shape",
})
PHASE_DIRECTIVES = {
    "implementation": b"""
AUTHORING PHASE 1 OF 2 - IMPLEMENTATION

Create exactly one persistent file: `/work/notion_inbox_sync.py`.  The existing
empty `/work/tests` directory is reserved for the next phase; leave it empty.
Do not create any other file, directory, cache, receipt, handoff, log, fixture,
or configuration artifact under `/work`.  Implement the complete command-line
program described by the shared contract.  Finish only after the source parses
and compiles.  Your final response must contain no source or private content;
say only that the implementation file was created for external verification.
""".strip(),
    "tests": b"""
AUTHORING PHASE 2 OF 2 - TESTS

The completed `/work/notion_inbox_sync.py` is available read-only.  Read it and
create exactly two persistent files: an empty `/work/tests/__init__.py` and
`/work/tests/test_notion_inbox_sync.py`.  Do not attempt to modify, replace,
rename, or unlink the implementation.  Do not create any other file, directory,
cache, receipt, handoff, log, fixture, or configuration artifact under
`/work/tests`.  Implement all twelve tests described by the shared contract.
Before finishing, run the complete suite yourself and require every test to
pass; the harness will rerun each test method in its own fresh process and
container, so every method must be self-contained and pass independently, and
every assertion must match the exact wire contract in the shared prompt.
Your final response must contain no source, test body, token, task text, or
workspace content; say only that the two test files were created for external
verification.
""".strip(),
}


class HeadlessTaskFailure(RunnerError):
    """A fixed, redacted terminal class from the isolated authoring task."""

    def __init__(self, phase: str, terminal_class: str) -> None:
        if phase not in AUTHORING_PHASES:
            phase = "unclassified"
        if terminal_class not in HEADLESS_TERMINAL_CLASSES:
            terminal_class = "unclassified"
        self.phase = phase
        self.terminal_class = terminal_class
        super().__init__("harness notion automation headless task failed")


class FixedGateFailure(RunnerError):
    """One allowlisted structural gate failure with optional diagnostics."""

    def __init__(self, category: str, diagnostic: bytes = b"") -> None:
        if category not in FIXED_GATE_CATEGORIES:
            raise RunnerError("harness notion automation operation failed")
        self.category = category
        self.diagnostic = bytes(diagnostic[:GENERATED_TEST_DIAGNOSTIC_LIMIT])
        super().__init__("harness notion automation fixed gate failed")


class TrustedProbeFailure(RunnerError):
    """One allowlisted trusted-probe stage plus bounded diagnostics."""

    def __init__(self, stage: str, diagnostic: bytes = b"") -> None:
        if stage not in TRUSTED_PROBE_STAGES:
            stage = "internal"
        self.stage = stage
        self.diagnostic = bytes(diagnostic[:TRUSTED_PROBE_DIAGNOSTIC_LIMIT])
        super().__init__("harness notion automation trusted probe failed")


class SourceSnapshot(NamedTuple):
    identity: tuple[int, int, int, int, int, int, int, int, int]
    sha256: str


class HeadlessStderrClassifier:
    """Consume stderr while retaining only the bounded machine error code."""

    prefix = b"dsh: "

    def __init__(self) -> None:
        self.total = 0
        self.prefix_offset = 0
        self.code = bytearray()
        self.complete = False
        self.invalid = False
        self.overflow = False

    def feed(self, chunk: bytes) -> None:
        for byte in chunk:
            self.total += 1
            if self.total > HEADLESS_DIAGNOSTIC_LIMIT:
                self.overflow = True
            if self.complete or self.invalid or self.overflow:
                continue
            if self.prefix_offset < len(self.prefix):
                if byte != self.prefix[self.prefix_offset]:
                    self.invalid = True
                else:
                    self.prefix_offset += 1
                continue
            if byte == ord(":"):
                if not self.code or not (65 <= self.code[0] <= 90):
                    self.invalid = True
                else:
                    self.complete = True
                continue
            if len(self.code) >= 64 or not (
                65 <= byte <= 90 or 48 <= byte <= 57 or byte == ord("_")
            ):
                self.invalid = True
                continue
            self.code.append(byte)

    def terminal_class(self) -> str:
        if self.total == 0:
            return "noncompleted-no-code"
        if self.overflow:
            return "diagnostic-overflow"
        if self.invalid or not self.complete:
            return "unclassified"
        try:
            code = self.code.decode("ascii")
        except UnicodeDecodeError:
            return "unclassified"
        return HEADLESS_CODE_CLASSES.get(code, "unclassified")


class TrustedProbeStderrClassifier:
    """Match one fixed probe stage without retaining any stderr bytes."""

    lines = {
        stage: TRUSTED_PROBE_FAILURE_PREFIX + stage.encode("ascii") + b"\n"
        for stage in TRUSTED_PROBE_STAGES
    }

    def __init__(self) -> None:
        self.total = 0
        self.position = 0
        self.candidates = tuple(TRUSTED_PROBE_STAGES)
        self.stage: str | None = None
        self.invalid = False
        self.overflow = False

    def feed(self, chunk: bytes) -> None:
        for byte in chunk:
            self.total += 1
            if self.total > TRUSTED_PROBE_DIAGNOSTIC_LIMIT:
                self.overflow = True
            if self.invalid or self.overflow:
                continue
            if self.stage is not None:
                continue
            self.candidates = tuple(
                stage
                for stage in self.candidates
                if len(self.lines[stage]) > self.position
                and self.lines[stage][self.position] == byte
            )
            if not self.candidates:
                self.invalid = True
                continue
            self.position += 1
            complete = tuple(
                stage
                for stage in self.candidates
                if len(self.lines[stage]) == self.position
            )
            if complete:
                if len(complete) != 1 or len(self.candidates) != 1:
                    self.invalid = True
                else:
                    self.stage = complete[0]

    def terminal_stage(self) -> str:
        if self.invalid or self.overflow or self.stage is None:
            return "internal"
        return self.stage


def fail(_reason: str = "") -> None:
    raise RunnerError("harness notion automation operation failed")


def fixed_gate(category: str, operation: Any) -> Any:
    """Run one structural gate without retaining its private failure object."""
    if category not in FIXED_GATE_CATEGORIES:
        fail()
    try:
        return operation()
    except FixedGateFailure:
        raise
    except Exception:
        pass
    # Raise outside the except block so the fixed exception does not retain the
    # original exception as context.  The original may contain a path or source.
    raise FixedGateFailure(category)


def trusted_probe_gate(default_stage: str, operation: Any) -> Any:
    """Run a probe boundary without discarding trusted diagnostics."""
    if default_stage not in TRUSTED_PROBE_STAGES:
        default_stage = "internal"
    try:
        return operation()
    except TrustedProbeFailure:
        raise
    except Exception:
        pass
    raise TrustedProbeFailure(default_stage)


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def require_real_directory(
    path: Path, *, owner: int | None = None, group: int | None = None
) -> os.stat_result:
    try:
        entry = os.lstat(path)
    except OSError:
        fail()
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
        fail()
    expected_group = owner if group is None else group
    if owner is not None and (
        entry.st_uid != owner or entry.st_gid != expected_group
    ):
        fail()
    return entry


def read_regular(path: Path, maximum: int, *, owner: int = 1000, mode: int | None = 0o600) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        path_entry = os.lstat(path)
        descriptor = os.open(path, flags)
    except OSError:
        fail()
    try:
        before = os.fstat(descriptor)
        stable = (
            stat.S_ISREG(path_entry.st_mode)
            and stat.S_ISREG(before.st_mode)
            and not stat.S_ISLNK(path_entry.st_mode)
            and before.st_nlink == 1
            and path_entry.st_nlink == 1
            and before.st_dev == path_entry.st_dev
            and before.st_ino == path_entry.st_ino
            and before.st_mode == path_entry.st_mode
            and before.st_uid == path_entry.st_uid == owner
            and before.st_gid == path_entry.st_gid == owner
            and (mode is None or stat.S_IMODE(before.st_mode) == mode)
            and before.st_size == path_entry.st_size
            and 0 <= before.st_size <= maximum
        )
        if not stable:
            fail()
        chunks: list[bytes] = []
        length = 0
        while True:
            chunk = os.read(descriptor, min(65536, maximum + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > maximum:
                fail()
        after = os.fstat(descriptor)
        fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")
        if length != before.st_size or any(getattr(before, key) != getattr(after, key) for key in fields):
            fail()
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def require_stable_regular_metadata(
    path: Path, maximum: int, *, owner: int = 1000, mode: int = 0o600
) -> tuple[int, int, int, int, int, int, int, int, int]:
    """Validate a sensitive bind source without reading its contents."""

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        entry = os.lstat(path)
        descriptor = os.open(path, flags)
    except OSError:
        fail()
    try:
        opened = os.fstat(descriptor)
        fields = (
            "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
            "st_size", "st_mtime_ns", "st_ctime_ns",
        )
        if (
            stat.S_ISLNK(entry.st_mode)
            or not stat.S_ISREG(entry.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or entry.st_nlink != 1
            or opened.st_nlink != 1
            or entry.st_uid != owner
            or entry.st_gid != owner
            or opened.st_uid != owner
            or opened.st_gid != owner
            or stat.S_IMODE(entry.st_mode) != mode
            or stat.S_IMODE(opened.st_mode) != mode
            or entry.st_size < 1
            or entry.st_size > maximum
            or any(getattr(entry, field) != getattr(opened, field) for field in fields)
        ):
            fail()
        after = os.fstat(descriptor)
        if any(getattr(opened, field) != getattr(after, field) for field in fields):
            fail()
        return tuple(getattr(after, field) for field in fields)
    finally:
        os.close(descriptor)


def write_create_only(path: Path, value: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError:
        fail()
    try:
        offset = 0
        while offset < len(value):
            offset += os.write(descriptor, value[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def parse_json_bytes(value: bytes) -> object:
    try:
        return json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()


def run_command(
    args: list[str],
    *,
    input_bytes: bytes | bytearray | None = None,
    timeout: int = 120,
    capture: bool = True,
) -> bytes:
    try:
        completed = subprocess.run(
            args,
            input=input_bytes,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=DOCKER_ENV,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail()
    if completed.returncode != 0:
        fail()
    return completed.stdout if capture else b""


def docker(*args: str, timeout: int = 120, capture: bool = True) -> bytes:
    return run_command(["docker", *args], timeout=timeout, capture=capture)


def load_checker(source: bytes) -> types.ModuleType:
    module = types.ModuleType("dsh_notion_automation_checker")
    module.__file__ = "check-notion-automation-entrypoint.py"
    try:
        exec(compile(source, module.__file__, "exec"), module.__dict__)
    except Exception:
        fail()
    return module


def exact_names(
    root: Path,
    expected_files: tuple[Path, ...],
    *,
    owner: int = 1000,
    group: int = 1000,
) -> None:
    require_real_directory(root, owner=owner, group=group)
    require_real_directory(root / "tests", owner=owner, group=group)
    expected = {path.as_posix() for path in expected_files} | {"tests"}
    observed: set[str] = set()
    for parent, directories, files in os.walk(root, topdown=True, followlinks=False):
        parent_path = Path(parent)
        relative_parent = parent_path.relative_to(root)
        for name in directories:
            path = parent_path / name
            entry = os.lstat(path)
            if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode) or entry.st_uid != owner or entry.st_gid != group:
                fail()
            observed.add((relative_parent / name).as_posix())
        for name in files:
            observed.add((relative_parent / name).as_posix())
    if observed != expected:
        fail()


def implementation_snapshot(
    root: Path, *, owner: int = 1000, group: int = 1000
) -> SourceSnapshot:
    """Compile and fingerprint the exact implementation inode without executing it."""
    path = root / ENTRYPOINT
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fields = (
        "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    )
    try:
        entry = os.lstat(path)
        descriptor = os.open(path, flags)
    except OSError:
        fail()
    try:
        before = os.fstat(descriptor)
        identity = tuple(getattr(before, field) for field in fields)
        if (
            stat.S_ISLNK(entry.st_mode)
            or not stat.S_ISREG(entry.st_mode)
            or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or entry.st_nlink != 1
            or before.st_uid != owner
            or before.st_gid != group
            or tuple(getattr(entry, field) for field in fields) != identity
            or not (1 <= before.st_size <= MAX_SOURCE_BYTES)
        ):
            fail()
        chunks: list[bytes] = []
        length = 0
        while True:
            chunk = os.read(descriptor, min(65536, MAX_SOURCE_BYTES + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > MAX_SOURCE_BYTES:
                fail()
        after = os.fstat(descriptor)
        if length != before.st_size or tuple(getattr(after, field) for field in fields) != identity:
            fail()
        source = b"".join(chunks)
        try:
            compile(source, ENTRYPOINT.as_posix(), "exec", dont_inherit=True)
        except (SyntaxError, UnicodeDecodeError, ValueError, TypeError):
            fail()
        return SourceSnapshot(identity, sha256_bytes(source))
    finally:
        os.close(descriptor)


def validate_implementation_stage(
    root: Path, *, owner: int = 1000, group: int = 1000
) -> SourceSnapshot:
    exact_names(root, IMPLEMENTATION_FILES, owner=owner, group=group)
    return implementation_snapshot(root, owner=owner, group=group)


def validate_tests_tree(
    root: Path, *, owner: int = 1000, group: int = 1000
) -> None:
    exact_names(root, GENERATED_FILES, owner=owner, group=group)


def validate_tests_source_identity(
    root: Path,
    expected_source: SourceSnapshot,
    *,
    owner: int = 1000,
    group: int = 1000,
) -> None:
    if implementation_snapshot(root, owner=owner, group=group) != expected_source:
        fail()


def validate_tests_stage(
    root: Path,
    expected_source: SourceSnapshot,
    *,
    owner: int = 1000,
    group: int = 1000,
) -> None:
    validate_tests_tree(root, owner=owner, group=group)
    validate_tests_source_identity(
        root, expected_source, owner=owner, group=group
    )


def normalize_generated_modes(root: Path) -> None:
    """Normalize only the three exact Agent outputs after their identity is proven."""
    exact_names(root, GENERATED_FILES)
    for directory in (root, root / "tests"):
        entry = require_real_directory(directory, owner=1000)
        if entry.st_nlink < 2:
            fail()
        os.chmod(directory, 0o700, follow_symlinks=False)
    for relative in GENERATED_FILES:
        path = root / relative
        flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
            current = os.fstat(descriptor)
        except OSError:
            fail()
        try:
            if (
                not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1
                or current.st_uid != 1000
                or current.st_gid != 1000
            ):
                fail()
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    for directory in (root / "tests", root):
        descriptor, _identity = open_directory(directory)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def generated_file_manifest(root: Path) -> dict[str, dict[str, object]]:
    exact_names(root, GENERATED_FILES)
    values: dict[str, dict[str, object]] = {}
    for relative in GENERATED_FILES:
        maximum = MAX_TEST_BYTES if relative == TEST_SUITE else MAX_SOURCE_BYTES
        value = read_regular(root / relative, maximum)
        if relative != TEST_INIT and len(value) < 1:
            fail()
        if relative == TEST_INIT and value != b"":
            fail()
        values[relative.as_posix()] = {"length": len(value), "sha256": sha256_bytes(value), "mode": "0600"}
    return values


def validate_test_shape(source: bytes) -> None:
    try:
        tree = ast.parse(source)
    except (SyntaxError, UnicodeDecodeError):
        fail()
    target = next((node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == TEST_CLASS), None)
    if target is None:
        fail()
    methods = [node for node in target.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")]
    if {node.name for node in methods} != set(TEST_METHODS) or len(methods) != len(TEST_METHODS):
        fail()
    for method in methods:
        if method.decorator_list or not method.body or all(isinstance(node, (ast.Pass, ast.Expr)) and (
            isinstance(node, ast.Pass) or isinstance(getattr(node, "value", None), ast.Constant)
        ) for node in method.body):
            fail()


def validate_generated_test_shape(root: Path) -> None:
    validate_test_shape(read_regular(root / TEST_SUITE, MAX_TEST_BYTES))


def generated_manifest(root: Path) -> dict[str, dict[str, object]]:
    values = generated_file_manifest(root)
    validate_generated_test_shape(root)
    return values


def validate_receipts(root: Path) -> dict[str, object]:
    manifest = generated_manifest_with_receipts(root)
    source = read_regular(root / ENTRYPOINT, MAX_SOURCE_BYTES)
    receipt_bytes = read_regular(root / TEST_RECEIPT, MAX_RECEIPT_BYTES)
    handoff_bytes = read_regular(root / HANDOFF, MAX_RECEIPT_BYTES)
    receipt = parse_json_bytes(receipt_bytes)
    handoff = parse_json_bytes(handoff_bytes)
    test_values = {name: True for name in HANDOFF_NAMES.values()}
    receipt_keys = {"schemaVersion", "interfaceVersion", "probeVersion", "entrypointSha256", "probeSha256", "testedAt", "tests"}
    if not isinstance(receipt, dict) or set(receipt) != receipt_keys:
        fail()
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("interfaceVersion") != 1
        or receipt.get("probeVersion") != 1
        or receipt.get("entrypointSha256") != sha256_bytes(source)
        or not isinstance(receipt.get("probeSha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("probeSha256")))
        or receipt.get("tests") != test_values
        or not isinstance(receipt.get("testedAt"), str)
        or not str(receipt["testedAt"]).endswith("Z")
        or canonical_json(receipt) != receipt_bytes
    ):
        fail()
    handoff_keys = {"schemaVersion", "interfaceVersion", "artifactContract", "entrypointSha256", "testReceiptSha256", "testedAt", "tests"}
    if not isinstance(handoff, dict) or set(handoff) != handoff_keys:
        fail()
    if (
        handoff.get("schemaVersion") != 2
        or handoff.get("interfaceVersion") != 1
        or handoff.get("artifactContract") != ARTIFACT_CONTRACT
        or handoff.get("entrypointSha256") != sha256_bytes(source)
        or handoff.get("testReceiptSha256") != sha256_bytes(receipt_bytes)
        or handoff.get("testedAt") != receipt.get("testedAt")
        or handoff.get("tests") != test_values
    ):
        fail()
    return {
        "manifest": manifest,
        "sourceLength": len(source),
        "sourceSha256": sha256_bytes(source),
        "handoffSha256": sha256_bytes(handoff_bytes),
        "testReceiptSha256": sha256_bytes(receipt_bytes),
        "probeSha256": receipt["probeSha256"],
        "testedAt": receipt["testedAt"],
    }


def generated_manifest_with_receipts(root: Path) -> dict[str, dict[str, object]]:
    exact_names(root, INSTALLED_FILES)
    values: dict[str, dict[str, object]] = {}
    for relative in INSTALLED_FILES:
        maximum = MAX_TEST_BYTES if relative == TEST_SUITE else MAX_SOURCE_BYTES
        if relative in (TEST_RECEIPT, HANDOFF):
            maximum = MAX_RECEIPT_BYTES
        value = read_regular(root / relative, maximum)
        if relative != TEST_INIT and len(value) < 1:
            fail()
        values[relative.as_posix()] = {"length": len(value), "sha256": sha256_bytes(value), "mode": "0600"}
    validate_test_shape(read_regular(root / TEST_SUITE, MAX_TEST_BYTES))
    return values


def checker_receipt(checker: types.ModuleType, dsh_home: Path, expected_probe_sha256: str) -> dict[str, object]:
    try:
        receipt = checker.inspect_entrypoint(dsh_home, 1000, 1000, expected_probe_sha256)
    except Exception:
        fail()
    if not isinstance(receipt, dict) or receipt.get("status") != "ready":
        fail()
    return receipt


def open_directory(
    path: Path, *, owner: int = 1000, group: int | None = None
) -> tuple[int, tuple[int, int, int, int, int]]:
    """Open one exact directory without inspecting any of its children."""
    expected_group = owner if group is None else group
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        before = os.lstat(path)
        descriptor = os.open(path, flags)
        current = os.fstat(descriptor)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or not stat.S_ISDIR(current.st_mode)
        or before.st_dev != current.st_dev
        or before.st_ino != current.st_ino
        or before.st_uid != owner
        or current.st_uid != owner
        or before.st_gid != expected_group
        or current.st_gid != expected_group
    ):
        os.close(descriptor)
        fail()
    return descriptor, (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid)


def require_directory_identity(descriptor: int, expected: tuple[int, int, int, int, int]) -> None:
    current = os.fstat(descriptor)
    if (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid) != expected:
        fail()


def require_path_chain_identity(
    path: Path,
    descriptor: int,
    expected: tuple[int, int, int, int, int],
) -> None:
    """Prove an absolute no-follow path still resolves to one held directory."""

    if not path.is_absolute() or any(part in ("", ".", "..") for part in path.parts[1:]):
        fail()
    flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        current_fd = os.open("/", flags)
    except OSError:
        fail()
    try:
        for component in path.parts[1:]:
            next_fd: int | None = None
            try:
                before = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
                next_fd = os.open(component, flags, dir_fd=current_fd)
                opened = os.fstat(next_fd)
            except OSError:
                if next_fd is not None:
                    os.close(next_fd)
                fail()
            if (
                stat.S_ISLNK(before.st_mode)
                or not stat.S_ISDIR(before.st_mode)
                or not stat.S_ISDIR(opened.st_mode)
                or (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid)
                != (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_gid)
            ):
                os.close(next_fd)
                fail()
            os.close(current_fd)
            current_fd = next_fd
        current = os.fstat(current_fd)
        held = os.fstat(descriptor)
        observed = (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid)
        held_identity = (held.st_dev, held.st_ino, held.st_mode, held.st_uid, held.st_gid)
        if observed != expected or held_identity != expected:
            fail()
    finally:
        os.close(current_fd)


def target_lstat() -> os.stat_result | None:
    try:
        return os.lstat(TARGET)
    except FileNotFoundError:
        return None
    except OSError:
        fail()


def read_release_json(path: Path) -> dict[str, object]:
    value = parse_json_bytes(read_regular(path, 2 * 1024 * 1024, mode=None))
    if not isinstance(value, dict):
        fail()
    return value


def validate_production_containers(production: dict[str, object], image_id: str) -> None:
    expected = (
        ("web", "true/0", "dsh-web", True, "running", 0),
        ("telegram", "true/0", "dsh-telegram", True, "running", 0),
        ("lan", "true/0", "dsh-lan-proxy", True, "running", 0),
        ("prepare", "exited/0", "dsh-prepare", False, "exited", 0),
    )
    for receipt_field, receipt_value, container, running, state, exit_code in expected:
        if production.get(receipt_field) != receipt_value:
            fail()
        value = docker(
            "inspect", "--format", "{{.Image}} {{.State.Running}} {{.State.Status}} {{.State.ExitCode}}",
            container, timeout=30,
        ).decode("ascii", "strict").strip().split()
        if value != [image_id, str(running).lower(), state, str(exit_code)]:
            fail()


def release_pointer(name: str) -> Path:
    pointer = STATE_ROOT / name
    try:
        before = os.lstat(pointer)
        raw_target = os.readlink(pointer)
        after = os.lstat(pointer)
    except OSError:
        fail()
    fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")
    if (
        not stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != 1000
        or before.st_gid != 1000
        or any(getattr(before, field) != getattr(after, field) for field in fields)
        or not raw_target
    ):
        fail()
    try:
        target = (pointer.parent / raw_target).resolve(strict=True)
        releases = RELEASES_ROOT.resolve(strict=True)
    except OSError:
        fail()
    if target.parent != releases or not re.fullmatch(r"[0-9A-Za-z._-]+", target.name):
        fail()
    return target


def accepted_image() -> dict[str, str]:
    current = release_pointer("current")
    last_good = release_pointer("last-good")
    if current != last_good or current.parent != RELEASES_ROOT or not re.fullmatch(r"[0-9A-Za-z._-]+", current.name):
        fail()
    require_real_directory(current, owner=1000)
    release = read_release_json(current / "release.json")
    candidate = release.get("candidate")
    production = release.get("production")
    if release.get("status") != "accepted" or release.get("releaseId") != current.name:
        fail()
    if not isinstance(candidate, dict) or not isinstance(production, dict):
        fail()
    image_id = production.get("engineImageId")
    harness_commit = candidate.get("harnessCommit")
    harness_patch_sha256 = candidate.get("harnessPatchSha256")
    plugins_commit = candidate.get("pluginsCommit")
    release_commit = candidate.get("releaseToolCommit")
    image_tag = candidate.get("imageTag")
    if not all(isinstance(value, str) for value in (image_id, harness_commit, harness_patch_sha256, plugins_commit, release_commit, image_tag)):
        fail()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) or not all(
        re.fullmatch(r"[0-9a-f]{40}", value) for value in (harness_commit, plugins_commit, release_commit)
    ):
        fail()
    if harness_commit != EXPECTED_HARNESS_COMMIT or harness_patch_sha256 != EXPECTED_HARNESS_PATCH_SHA256:
        fail()
    inspected = parse_json_bytes(docker("image", "inspect", image_id))
    if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
        fail()
    image = inspected[0]
    labels = (image.get("Config") or {}).get("Labels")
    tags = image.get("RepoTags")
    if image.get("Id") != image_id or not isinstance(labels, dict) or not isinstance(tags, list):
        fail()
    if image_tag not in tags and f"localhost/{image_tag}" not in tags:
        fail()
    expected = {
        "io.dsh.candidate.purpose": "release",
        "io.dsh.harness.revision": harness_commit,
        "io.dsh.harness.patch-sha256": harness_patch_sha256,
        "org.opencontainers.image.revision": plugins_commit,
        "io.dsh.release.revision": release_commit,
    }
    if any(labels.get(key) != value for key, value in expected.items()):
        fail()
    for entry in (image.get("Config") or {}).get("Env") or []:
        name = str(entry).split("=", 1)[0]
        if re.search(r"(?:TOKEN|SECRET|API_KEY|AUTHORIZATION)$", name, re.IGNORECASE):
            fail()
    validate_production_containers(production, image_id)
    return {
        "releaseId": current.name,
        "imageId": image_id,
        "harnessCommit": harness_commit,
        "harnessPatchSha256": harness_patch_sha256,
        "acceptedReleaseToolCommit": release_commit,
    }


def revalidate_image(expected: dict[str, str]) -> None:
    if accepted_image() != expected:
        fail()


def acquire_lock() -> int:
    require_real_directory(STATE_ROOT, owner=1000)
    locks = STATE_ROOT / "locks"
    if not locks.exists():
        os.mkdir(locks, 0o700)
    require_real_directory(locks, owner=1000)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(LOCK_PATH, flags, 0o600)
        entry = os.fstat(descriptor)
        if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or entry.st_uid != 1000 or entry.st_gid != 1000:
            fail()
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except OSError:
        fail()


def install_noreplace(
    source_parent_fd: int,
    source_parent_identity: tuple[int, int, int, int, int],
    destination_parent_fd: int,
    destination_parent_identity: tuple[int, int, int, int, int],
    *,
    destination_path: Path,
) -> tuple[int, int]:
    require_directory_identity(source_parent_fd, source_parent_identity)
    require_path_chain_identity(
        destination_path, destination_parent_fd, destination_parent_identity
    )
    try:
        source_before = os.stat("notion", dir_fd=source_parent_fd, follow_symlinks=False)
        os.stat("notion", dir_fd=destination_parent_fd, follow_symlinks=False)
    except FileNotFoundError as error:
        if error.filename == "notion":
            # The source is required and the destination is required absent.  A
            # separate fstatat below distinguishes the two without looking at siblings.
            try:
                source_before = os.stat("notion", dir_fd=source_parent_fd, follow_symlinks=False)
            except OSError:
                fail()
        else:
            fail()
    else:
        fail()
    try:
        os.stat("notion", dir_fd=destination_parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    except OSError:
        fail()
    else:
        fail()
    if not stat.S_ISDIR(source_before.st_mode) or stat.S_ISLNK(source_before.st_mode):
        fail()
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        fail()
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(source_parent_fd, b"notion", destination_parent_fd, b"notion", 1)
    if result != 0:
        error = ctypes.get_errno()
        if error in (errno.EEXIST, errno.ENOTEMPTY):
            fail()
        fail()
    try:
        os.fsync(source_parent_fd)
        os.fsync(destination_parent_fd)
        require_directory_identity(source_parent_fd, source_parent_identity)
        require_path_chain_identity(
            destination_path, destination_parent_fd, destination_parent_identity
        )
        try:
            installed = os.stat("notion", dir_fd=destination_parent_fd, follow_symlinks=False)
        except OSError:
            fail()
        if (
            not stat.S_ISDIR(installed.st_mode)
            or installed.st_dev != source_before.st_dev
            or installed.st_ino != source_before.st_ino
        ):
            fail()
        return installed.st_dev, installed.st_ino
    except Exception:
        # renameat2 has already published the directory, but the caller has not
        # yet received its identity and therefore cannot own rollback.  The
        # open parent descriptors and the exact moved inode are sufficient to
        # move only our directory back even when a post-move parent check was
        # the operation that failed.
        rollback_moved_install(
            source_parent_fd,
            destination_parent_fd,
            (source_before.st_dev, source_before.st_ino),
        )
        raise


def rollback_moved_install(
    source_parent_fd: int,
    destination_parent_fd: int,
    installed_identity: tuple[int, int],
) -> None:
    try:
        os.stat("notion", dir_fd=source_parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    except OSError:
        fail()
    else:
        fail()
    try:
        installed = os.stat("notion", dir_fd=destination_parent_fd, follow_symlinks=False)
    except OSError:
        fail()
    if (
        not stat.S_ISDIR(installed.st_mode)
        or (installed.st_dev, installed.st_ino) != installed_identity
    ):
        fail()
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        fail()
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(destination_parent_fd, b"notion", source_parent_fd, b"notion", 1) != 0:
        fail()
    try:
        restored = os.stat("notion", dir_fd=source_parent_fd, follow_symlinks=False)
        os.stat("notion", dir_fd=destination_parent_fd, follow_symlinks=False)
    except FileNotFoundError as error:
        if error.filename != "notion":
            fail()
    except OSError:
        fail()
    else:
        fail()
    if (
        not stat.S_ISDIR(restored.st_mode)
        or (restored.st_dev, restored.st_ino) != installed_identity
    ):
        fail()
    sync_failed = False
    for descriptor in (destination_parent_fd, source_parent_fd):
        try:
            os.fsync(descriptor)
        except OSError:
            sync_failed = True
    if sync_failed:
        fail()


def rollback_created_install(
    source_parent_fd: int,
    source_parent_identity: tuple[int, int, int, int, int],
    destination_parent_fd: int,
    destination_parent_identity: tuple[int, int, int, int, int],
    installed_identity: tuple[int, int],
) -> None:
    # The exact held dirfds and installed inode are the rollback authority.
    # Do not repeat the check that may have caused the post-publication fault
    # before restoring the create-only target.
    rollback_moved_install(
        source_parent_fd, destination_parent_fd, installed_identity
    )


def fsync_tree(root: Path) -> None:
    for relative in INSTALLED_FILES:
        descriptor = os.open(root / relative, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    # The receipts are new directory entries.  Persist the nested test files
    # first, then the publication root itself, before moving the whole tree.
    for directory in (root / "tests", root):
        descriptor = os.open(
            directory,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                fail()
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def prepare_publication_stage(
    task_root: Path, notion: Path, *, owner: int = 1000, group: int = 1000
) -> Path:
    """Collapse the verified fake DSH_HOME to one task-root/notion entry."""
    control = task_root / "control"
    for name in ("bridge.mjs", "lockdown.patch.yml"):
        path = control / name
        entry = os.lstat(path)
        if (
            stat.S_ISLNK(entry.st_mode)
            or not stat.S_ISREG(entry.st_mode)
            or entry.st_nlink != 1
            or entry.st_uid != owner
            or entry.st_gid != group
            or stat.S_IMODE(entry.st_mode) != 0o600
        ):
            fail()
        os.unlink(path)
    os.rmdir(control)

    deep_parent_fd, deep_parent_identity = open_directory(
        notion.parent, owner=owner, group=group
    )
    task_parent_fd, task_parent_identity = open_directory(
        task_root, owner=owner, group=group
    )
    try:
        require_directory_identity(deep_parent_fd, deep_parent_identity)
        require_directory_identity(task_parent_fd, task_parent_identity)
        try:
            os.stat("notion", dir_fd=task_parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail()
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            fail()
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        if renameat2(deep_parent_fd, b"notion", task_parent_fd, b"notion", 1) != 0:
            fail()
        os.fsync(deep_parent_fd)
        os.fsync(task_parent_fd)
    finally:
        os.close(deep_parent_fd)
        os.close(task_parent_fd)

    os.rmdir(notion.parent)
    os.rmdir(notion.parent.parent)
    os.rmdir(notion.parent.parent.parent)
    entries = list(os.scandir(task_root))
    if len(entries) != 1 or entries[0].name != "notion" or not entries[0].is_dir(follow_symlinks=False):
        fail()
    return task_root / "notion"


def create_task_tree() -> tuple[Path, Path, bool]:
    tasks_created = False
    if not TASKS_ROOT.exists():
        os.mkdir(TASKS_ROOT, 0o700)
        tasks_created = True
    tasks_entry = require_real_directory(TASKS_ROOT, owner=1000)
    if stat.S_IMODE(tasks_entry.st_mode) != 0o700:
        fail()
    nonce = uuid.uuid4().hex
    task_root = TASKS_ROOT / nonce
    os.mkdir(task_root, 0o700)
    if stat.S_IMODE(require_real_directory(task_root, owner=1000).st_mode) != 0o700:
        fail()
    fake_home = task_root / "dsh-home"
    notion = fake_home / "workspace/automations/notion"
    notion.mkdir(parents=True, mode=0o700)
    (notion / "tests").mkdir(mode=0o700)
    control = task_root / "control"
    control.mkdir(mode=0o700)
    return task_root, notion, tasks_created


def write_control_assets(task_root: Path, assets: dict[str, bytes]) -> dict[str, Path]:
    control = task_root / "control"
    paths: dict[str, Path] = {}
    for name in ("bridge", "patch"):
        value = assets.get(name)
        if not isinstance(value, bytes) or not value:
            fail()
        path = control / {
            "bridge": "bridge.mjs",
            "patch": "lockdown.patch.yml",
        }[name]
        write_create_only(path, value)
        paths[name] = path
    return paths


def common_container_args(name: str, network: str, nonce: str) -> list[str]:
    if not re.fullmatch(r"[0-9a-f]{32}", nonce):
        fail()
    return [
        "create", "--name", name, "--pull", "never", "--log-driver", "none", "--network", network,
        "--label", f"{RESOURCE_OWNER_LABEL}={RESOURCE_OWNER_VALUE}",
        "--label", f"{RESOURCE_NONCE_LABEL}={nonce}",
        "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "256",
    ]


def model_isolation_tmpfs() -> list[str]:
    """Mask product/release surfaces that the authoring model never needs."""
    return [
        "--tmpfs", "/opt/dsh/release-system:rw,nosuid,nodev,noexec,size=4k,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/opt/dsh/plugins-src:rw,nosuid,nodev,noexec,size=4k,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/opt/dsh/harness/local-plugins:rw,nosuid,nodev,noexec,size=4k,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/opt/dsh/harness/local-profiles:rw,nosuid,nodev,noexec,size=4k,mode=0700,uid=1000,gid=1000",
    ]


def inspect_docker_resource(kind: str, reference: str) -> dict[str, object] | None:
    if kind not in ("container", "network") or not reference:
        fail()
    try:
        inspection = subprocess.run(
            ["docker", kind, "inspect", reference], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=DOCKER_ENV, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail()
    if len(inspection.stdout) > 2 * 1024 * 1024:
        fail()
    if inspection.returncode == 0:
        value = parse_json_bytes(inspection.stdout)
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            fail()
        return value[0]
    if inspection.returncode != 1:
        fail()
    try:
        daemon = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Version}}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=DOCKER_ENV,
            timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail()
    if daemon.returncode != 0:
        fail()
    return None


def container_ref_from_inspection(
    inspected: dict[str, object] | None,
    name: str,
    nonce: str,
    image_id: str,
) -> ContainerRef | None:
    if (
        inspected is None
        or not re.fullmatch(r"[0-9a-z][0-9a-z_.-]*", name)
        or not re.fullmatch(r"[0-9a-f]{32}", nonce)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
    ):
        return None
    config = inspected.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    resource_id = inspected.get("Id")
    observed_name = inspected.get("Name")
    if (
        not isinstance(resource_id, str)
        or not re.fullmatch(r"[0-9a-f]{64}", resource_id)
        or observed_name not in (name, f"/{name}")
        or inspected.get("Image") != image_id
        or not isinstance(labels, dict)
        or labels.get(RESOURCE_OWNER_LABEL) != RESOURCE_OWNER_VALUE
        or labels.get(RESOURCE_NONCE_LABEL) != nonce
    ):
        return None
    return ContainerRef(name, resource_id, nonce, image_id)


def inspect_container_ref(reference: ContainerRef) -> bool:
    inspected = inspect_docker_resource("container", reference.resource_id)
    if inspected is None:
        return False
    if container_ref_from_inspection(
        inspected, reference.name, reference.nonce, reference.image_id
    ) != reference:
        fail()
    return True


def create_container(
    name: str,
    args: list[str],
    nonce: str,
    image_id: str,
) -> ContainerRef:
    if (
        not re.fullmatch(r"[0-9a-z][0-9a-z_.-]*", name)
        or not re.fullmatch(r"[0-9a-f]{32}", nonce)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
    ):
        fail()
    if inspect_docker_resource("container", name) is not None:
        fail()
    try:
        raw_created = docker(*args, timeout=60).decode("ascii", "strict").strip()
    except Exception:
        raw_created = ""
    inspected = inspect_docker_resource("container", name)
    owned = container_ref_from_inspection(inspected, name, nonce, image_id)
    if not re.fullmatch(r"[0-9a-f]{64}", raw_created) or owned is None or owned.resource_id != raw_created:
        # A failed or malformed create is ambiguous.  Remove only an object
        # whose immutable ID, image and unguessable full-operation label prove
        # that this invocation created it.  A collision is deliberately kept.
        if owned is not None:
            stop_container(owned, strict=True)
        fail()
    return owned


def wait_detached_container(container: ContainerRef, timeout: int) -> None:
    try:
        docker("start", container.resource_id, timeout=30, capture=False)
        status = docker("wait", container.resource_id, timeout=timeout).decode("ascii", "strict").strip()
    except Exception:
        stop_container(container, strict=True)
        raise
    stop_container(container, strict=True)
    if status != "0":
        fail()


def bounded_generated_test_diagnostic(
    diagnostic: bytes | bytearray,
    suffix: bytes = b"",
) -> bytes:
    if len(suffix) > GENERATED_TEST_DIAGNOSTIC_LIMIT:
        suffix = suffix[-GENERATED_TEST_DIAGNOSTIC_LIMIT:]
    prefix_limit = GENERATED_TEST_DIAGNOSTIC_LIMIT - len(suffix)
    return bytes(diagnostic[:prefix_limit]) + suffix


def wait_generated_test_container(
    container: ContainerRef,
    timeout: int,
    category: str,
) -> None:
    """Run one generated unittest and retain bounded combined diagnostics."""
    if category not in GENERATED_TEST_GATE_CATEGORIES:
        fail()
    process: subprocess.Popen[bytes] | None = None
    reader: threading.Thread | None = None
    reader_started = False
    diagnostic = bytearray()
    diagnostic_overflow = False
    stream_failed = False
    failure: FixedGateFailure | None = None
    succeeded = False
    cleanup_failed = False

    def drain_output(stream: Any) -> None:
        nonlocal diagnostic_overflow, stream_failed
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                remaining = max(
                    0,
                    GENERATED_TEST_DIAGNOSTIC_LIMIT - len(diagnostic),
                )
                diagnostic.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    diagnostic_overflow = True
        except Exception:
            stream_failed = True

    try:
        process = subprocess.Popen(
            ["docker", "start", "--attach", container.resource_id],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=DOCKER_ENV,
        )
        if process.stdout is None:
            fail()
        reader = threading.Thread(
            target=drain_output,
            args=(process.stdout,),
            daemon=True,
        )
        reader.start()
        reader_started = True
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop_container(container, strict=False)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            if reader_started:
                reader.join(timeout=10)
            suffix = b"\ngenerated unittest timed out\n"
            if not reader_started or reader.is_alive() or stream_failed:
                suffix = b"\ngenerated unittest runtime failed after timeout\n"
            raise FixedGateFailure(
                category,
                bounded_generated_test_diagnostic(diagnostic, suffix),
            )
        if reader_started:
            reader.join(timeout=10)
        if (
            not reader_started
            or reader.is_alive()
            or stream_failed
        ):
            raise FixedGateFailure(
                category,
                bounded_generated_test_diagnostic(
                    diagnostic,
                    b"\ngenerated unittest runtime failed\n",
                ),
            )
        try:
            state = docker(
                "container", "inspect", "--format",
                "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
                container.resource_id,
                timeout=30,
            ).decode("ascii", "strict").strip()
        except Exception:
            raise FixedGateFailure(
                category,
                bounded_generated_test_diagnostic(
                    diagnostic,
                    b"\ngenerated unittest state inspection failed\n",
                ),
            )
        match = re.fullmatch(r"exited (-?[0-9]+) (true|false)", state)
        if match is None or process.returncode != int(match.group(1)):
            raise FixedGateFailure(
                category,
                bounded_generated_test_diagnostic(
                    diagnostic,
                    b"\ngenerated unittest runtime failed\n",
                ),
            )
        exit_code = int(match.group(1))
        if exit_code == 0 and match.group(2) == "false" and not diagnostic_overflow:
            succeeded = True
        else:
            suffix = b""
            if match.group(2) == "true":
                suffix = b"\ngenerated unittest container was OOM-killed\n"
            elif diagnostic_overflow:
                suffix = b"\ngenerated unittest diagnostic exceeded limit\n"
            failure = FixedGateFailure(
                category,
                bounded_generated_test_diagnostic(diagnostic, suffix),
            )
    except FixedGateFailure as error:
        failure = error
    except Exception:
        failure = FixedGateFailure(
            category,
            bounded_generated_test_diagnostic(
                diagnostic,
                b"\ngenerated unittest runtime failed\n",
            ),
        )
    finally:
        try:
            if process is not None and process.poll() is None:
                stop_container(container, strict=False)
                process.kill()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    cleanup_failed = True
            if reader_started:
                reader.join(timeout=10)
                if reader.is_alive():
                    cleanup_failed = True
        except Exception:
            cleanup_failed = True
        try:
            stop_container(container, strict=True)
        except Exception:
            cleanup_failed = True
    if cleanup_failed:
        existing = failure.diagnostic if failure is not None else diagnostic
        raise FixedGateFailure(
            category,
            bounded_generated_test_diagnostic(
                existing,
                b"\ngenerated unittest cleanup failed\n",
            ),
        )
    if failure is not None:
        raise failure
    if not succeeded:
        raise FixedGateFailure(
            category,
            bounded_generated_test_diagnostic(
                diagnostic,
                b"\ngenerated unittest runtime failed\n",
            ),
        )


def wait_headless_container(container: ContainerRef, timeout: int, phase: str) -> None:
    """Run the authoring task while retaining no model text or raw diagnostic."""
    if phase not in AUTHORING_PHASES:
        fail()
    process: subprocess.Popen[bytes] | None = None
    reader: threading.Thread | None = None
    classifier = HeadlessStderrClassifier()

    def drain_stderr(stream: Any) -> None:
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                classifier.feed(chunk)
        except Exception:
            classifier.invalid = True

    try:
        process = subprocess.Popen(
            ["docker", "start", "--attach", container.resource_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=DOCKER_ENV,
        )
        if process.stderr is None:
            fail()
        reader = threading.Thread(target=drain_stderr, args=(process.stderr,), daemon=True)
        reader.start()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            stop_container(container, strict=False)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            raise HeadlessTaskFailure(phase, "runner-timeout") from error
        state = docker(
            "container", "inspect", "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            container.resource_id,
            timeout=30,
        ).decode("ascii", "strict").strip()
        match = re.fullmatch(r"exited (-?[0-9]+) (true|false)", state)
        if match is None:
            fail()
        exit_code = int(match.group(1))
        if process.returncode != exit_code:
            fail()
        if reader is not None:
            reader.join(timeout=10)
            if reader.is_alive():
                fail()
        if exit_code == 0:
            return
        if match.group(2) == "true":
            raise HeadlessTaskFailure(phase, "container-oom")
        raise HeadlessTaskFailure(phase, classifier.terminal_class())
    except HeadlessTaskFailure:
        raise
    except Exception:
        fail()
    finally:
        if process is not None and process.poll() is None:
            stop_container(container, strict=False)
            process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if reader is not None:
            reader.join(timeout=10)
        stop_container(container, strict=True)


def wait_attached_container(
    container: ContainerRef,
    timeout: int,
    maximum_output: int,
    *,
    input_bytes: bytes | None = None,
) -> bytes:
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            ["docker", "start", "--attach", *( ["--interactive"] if input_bytes is not None else [] ), container.resource_id],
            stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=DOCKER_ENV,
        )
        output, _stderr = process.communicate(input=input_bytes, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        stop_container(container, strict=False)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        fail()
    finally:
        stop_container(container, strict=True)
    if process.returncode != 0 or len(output) > maximum_output:
        fail()
    return output


def wait_trusted_probe_container(
    container: ContainerRef,
    timeout: int,
    maximum_output: int,
    probe_source: bytes,
) -> bytes:
    """Capture a bounded receipt and bounded trusted-probe diagnostics."""
    process: subprocess.Popen[bytes] | None = None
    workers: list[threading.Thread] = []
    classifier = TrustedProbeStderrClassifier()
    output = bytearray()
    diagnostic = bytearray()
    output_overflow = False
    stream_failed = False

    def drain_stdout(stream: Any) -> None:
        nonlocal output_overflow, stream_failed
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                remaining = max(0, maximum_output + 1 - len(output))
                if remaining:
                    output.extend(chunk[:remaining])
                if len(chunk) > remaining or len(output) > maximum_output:
                    output_overflow = True
        except Exception:
            stream_failed = True

    def drain_stderr(stream: Any) -> None:
        nonlocal stream_failed
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                classifier.feed(chunk)
                remaining = max(
                    0,
                    TRUSTED_PROBE_DIAGNOSTIC_LIMIT - len(diagnostic),
                )
                if remaining:
                    diagnostic.extend(chunk[:remaining])
        except Exception:
            stream_failed = True

    def write_stdin(stream: Any) -> None:
        nonlocal stream_failed
        try:
            offset = 0
            while offset < len(probe_source):
                written = stream.write(probe_source[offset:])
                if not isinstance(written, int) or written <= 0:
                    stream_failed = True
                    return
                offset += written
            stream.close()
        except Exception:
            stream_failed = True

    def start_worker(worker: threading.Thread) -> None:
        worker.start()
        workers.append(worker)

    try:
        process = subprocess.Popen(
            ["docker", "start", "--attach", "--interactive", container.resource_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=DOCKER_ENV,
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            fail()
        start_worker(threading.Thread(
            target=drain_stdout, args=(process.stdout,), daemon=True
        ))
        start_worker(threading.Thread(
            target=drain_stderr, args=(process.stderr,), daemon=True
        ))
        start_worker(threading.Thread(
            target=write_stdin, args=(process.stdin,), daemon=True
        ))
        process.wait(timeout=timeout)
        for worker in workers:
            worker.join(timeout=10)
        if any(worker.is_alive() for worker in workers) or stream_failed:
            output.clear()
            fail()
        state = docker(
            "container", "inspect", "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            container.resource_id,
            timeout=30,
        ).decode("ascii", "strict").strip()
        match = re.fullmatch(r"exited (-?[0-9]+) (true|false)", state)
        if match is None or process.returncode != int(match.group(1)):
            output.clear()
            raise TrustedProbeFailure("internal", bytes(diagnostic))
        exit_code = int(match.group(1))
        if exit_code != 0:
            output.clear()
            if exit_code == 4 and match.group(2) == "false":
                raise TrustedProbeFailure(
                    classifier.terminal_stage(), bytes(diagnostic)
                )
            raise TrustedProbeFailure("internal", bytes(diagnostic))
        if match.group(2) != "false":
            output.clear()
            raise TrustedProbeFailure("internal", bytes(diagnostic))
        if classifier.total != 0:
            output.clear()
            raise TrustedProbeFailure("internal", bytes(diagnostic))
        if output_overflow:
            output.clear()
            raise TrustedProbeFailure("receipt")
        return bytes(output)
    except TrustedProbeFailure:
        raise
    except (OSError, subprocess.TimeoutExpired):
        stop_container(container, strict=False)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        raise
    finally:
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                with contextlib.suppress(OSError):
                    process.stdin.close()
            if process.poll() is None:
                stop_container(container, strict=False)
                process.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=10)
        for worker in workers:
            with contextlib.suppress(RuntimeError):
                worker.join(timeout=10)
        output.clear()
        stop_container(container, strict=True)


ACTIVE_ROWS = {
    "timer", "llm", "session", "agent", "agent-default-model", "llm-retry",
    "session-persistence-jsonl", "sandbox-policy", "approval", "fs-observation-policy",
    "tool-fs", "timeout-policy", "tools", "system-prompt", "agent-loop", "fs-sandbox",
    "llm-deepseek", "headless-startup", "headless-runner",
}


def validate_dump(value: bytes) -> None:
    if len(value) < 1 or len(value) > 512 * 1024 or b"\0" in value:
        fail()
    try:
        lines = value.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail()
    rows: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines:
        match = re.fullmatch(r"- id: ([0-9a-z-]+)", line)
        if line.startswith("- id: ") and match is None:
            fail()
        if match:
            current = match.group(1)
            if current in rows:
                fail()
            rows[current] = [line]
        elif current is not None:
            rows[current].append(line)
    active = {
        name for name, block in rows.items()
        if "  disabled: true" not in block
    }
    if active != ACTIVE_ROWS:
        fail()
    required_blocks = {
        "agent-default-model": (
            "    provider: deepseek-official", "    model: deepseek-v4-flash",
        ),
        "llm-deepseek": (
            "    apiKeyEnv: DEEPSEEK_API_KEY", "    baseURL: http://deepseek-relay:8080",
            "    thinking: enabled", "    reasoningEffort: low", "    maxTokens: 65536",
            "    retryPolicy:", "      mode: normal", "      maxRetries: 0",
            "      - id: deepseek-v4-flash", "        maxTokens: 65536", "          - text",
        ),
        "tools": ("    mode: native", "    maxParallelSubCalls: 1"),
        "agent-loop": ("    agents: []", "    maxParallelToolCalls: 1"),
        "sandbox-policy": ("    mode: workspace-write", "    workspaceRoot: /work"),
    }
    for name, expected_lines in required_blocks.items():
        block = rows.get(name, [])
        if any(line not in block for line in expected_lines):
            fail()


def run_dump_config(image_id: str, patch: Path, nonce: str) -> None:
    name = f"dsh-harness-notion-{nonce[:12]}-dump"
    args = [
        *common_container_args(name, "none", nonce),
        "--memory", "768m", "--workdir", "/work",
        *model_isolation_tmpfs(),
        "--tmpfs", "/work:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/home/herman/.dsh:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=1000,gid=1000",
        "--mount", f"type=bind,src={patch},dst=/run/dsh-control/lockdown.patch.yml,readonly",
        "--env", "DSH_HOME=/home/herman/.dsh", "--env", "HOME=/home/herman",
        "--env", "DSH_PERMISSION_MODE=workspace-write", "--env", "DSH_TOOLS_MODE=native",
        "--env", "DSH_TELEMETRY_DISABLED=1", "--env", "DEEPSEEK_API_KEY=dsh-relay-placeholder",
        "--env", "DEEPSEEK_BASE_URL=http://deepseek-relay:8080",
        "--entrypoint", "/usr/bin/tini", image_id,
        "--", "/usr/local/bin/node", "--expose-internals", "/opt/dsh/harness/apps/cli/lib/bin.js",
        "--profile", "headless", "--patch", "/run/dsh-control/lockdown.patch.yml", "--dump-config",
    ]
    container = create_container(name, args, nonce, image_id)
    validate_dump(wait_attached_container(container, 120, 512 * 1024))


def network_ref_from_inspection(
    inspected: dict[str, object] | None,
    name: str,
    nonce: str,
    internal: bool,
) -> NetworkRef | None:
    if (
        inspected is None
        or not re.fullmatch(r"[0-9a-z][0-9a-z_.-]*", name)
        or not re.fullmatch(r"[0-9a-f]{32}", nonce)
    ):
        return None
    labels = inspected.get("Labels")
    resource_id = inspected.get("Id")
    if (
        not isinstance(resource_id, str)
        or not re.fullmatch(r"[0-9a-f]{64}", resource_id)
        or inspected.get("Name") != name
        or inspected.get("Driver") != "bridge"
        or inspected.get("Internal") is not internal
        or not isinstance(labels, dict)
        or labels.get(RESOURCE_OWNER_LABEL) != RESOURCE_OWNER_VALUE
        or labels.get(RESOURCE_NONCE_LABEL) != nonce
    ):
        return None
    return NetworkRef(name, resource_id, nonce, internal)


def inspect_network_ref(reference: NetworkRef) -> bool:
    inspected = inspect_docker_resource("network", reference.resource_id)
    if inspected is None:
        return False
    if network_ref_from_inspection(
        inspected, reference.name, reference.nonce, reference.internal
    ) != reference:
        fail()
    return True


def create_network(name: str, nonce: str, *, internal: bool, role: str) -> NetworkRef:
    if (
        not re.fullmatch(r"[0-9a-z][0-9a-z_.-]*", name)
        or not re.fullmatch(r"[0-9a-f]{32}", nonce)
        or not re.fullmatch(r"[0-9a-z-]+", role)
    ):
        fail()
    if inspect_docker_resource("network", name) is not None:
        fail()
    args = [
        "network", "create", "--driver", "bridge",
        *( ["--internal"] if internal else [] ),
        "--label", f"{RESOURCE_OWNER_LABEL}={RESOURCE_OWNER_VALUE}",
        "--label", f"{RESOURCE_NONCE_LABEL}={nonce}",
        "--label", f"io.dsh.role={role}",
        name,
    ]
    try:
        raw_created = docker(*args, timeout=60).decode("ascii", "strict").strip()
    except Exception:
        raw_created = ""
    inspected = inspect_docker_resource("network", name)
    owned = network_ref_from_inspection(inspected, name, nonce, internal)
    if not re.fullmatch(r"[0-9a-f]{64}", raw_created) or owned is None or owned.resource_id != raw_created:
        if owned is not None:
            cleanup_network(owned, strict=True)
        fail()
    return owned


def network_ip(network: NetworkRef) -> str:
    inspected = inspect_docker_resource("network", network.resource_id)
    if network_ref_from_inspection(
        inspected, network.name, network.nonce, network.internal
    ) != network:
        fail()
    if inspected is None:
        fail()
    try:
        subnet = inspected["IPAM"]["Config"][0]["Subnet"]
        parsed = ipaddress.ip_network(subnet, strict=True)
        address = parsed.network_address + 10
    except (IndexError, KeyError, TypeError, ValueError):
        fail()
    if not isinstance(parsed, ipaddress.IPv4Network) or address >= parsed.broadcast_address:
        fail()
    return str(address)


def start_secret_bridge(
    image_id: str,
    bridge: Path,
    nonce: str,
    task_network: NetworkRef,
    egress_network: NetworkRef,
) -> tuple[ContainerRef, subprocess.Popen[bytes], int]:
    credential_identity = require_stable_regular_metadata(
        PRODUCTION_CREDENTIAL, MAX_CREDENTIAL_BYTES
    )
    relay_name = f"dsh-harness-notion-{nonce[:12]}-relay"
    extractor_name = f"dsh-harness-notion-{nonce[:12]}-extract"
    relay_ip = network_ip(task_network)
    relay_args = [
        *common_container_args(relay_name, task_network.resource_id, nonce), "--ip", relay_ip,
        "--network-alias", "deepseek-relay", "--interactive", "--memory", "512m",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
        "--mount", f"type=bind,src={bridge},dst=/run/dsh-control/bridge.mjs,readonly",
        "--env", f"DSH_RELAY_BIND_ADDRESS={relay_ip}",
        "--entrypoint", "/usr/bin/tini", image_id,
        "--", "/usr/local/bin/node", "/run/dsh-control/bridge.mjs", "relay",
    ]
    extractor_args = [
        *common_container_args(extractor_name, "none", nonce), "--memory", "256m",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
        "--mount", f"type=bind,src={PRODUCTION_CREDENTIAL},dst=/run/dsh-production-credentials/.credentials.yaml,readonly",
        "--mount", f"type=bind,src={bridge},dst=/run/dsh-control/bridge.mjs,readonly",
        "--entrypoint", "/usr/bin/tini", image_id,
        "--", "/usr/local/bin/node", "/run/dsh-control/bridge.mjs", "extract",
    ]
    relay_container: ContainerRef | None = None
    extractor_container: ContainerRef | None = None
    read_fd: int | None = None
    write_fd: int | None = None
    sentinel_fd: int | None = None
    relay_process: subprocess.Popen[bytes] | None = None
    extractor_process: subprocess.Popen[bytes] | None = None
    transferred = False
    try:
        relay_container = create_container(relay_name, relay_args, nonce, image_id)
        docker(
            "network", "connect", egress_network.resource_id,
            relay_container.resource_id, timeout=30, capture=False,
        )
        if require_stable_regular_metadata(
            PRODUCTION_CREDENTIAL, MAX_CREDENTIAL_BYTES
        ) != credential_identity:
            fail()
        extractor_container = create_container(
            extractor_name, extractor_args, nonce, image_id
        )
        if require_stable_regular_metadata(
            PRODUCTION_CREDENTIAL, MAX_CREDENTIAL_BYTES
        ) != credential_identity:
            fail()
        read_fd, write_fd = os.pipe2(getattr(os, "O_CLOEXEC", 0))
        sentinel_fd = os.dup(write_fd)
        relay_process = subprocess.Popen(
            ["docker", "start", "--attach", "--interactive", relay_container.resource_id],
            stdin=read_fd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=DOCKER_ENV,
        )
        extractor_process = subprocess.Popen(
            ["docker", "start", "--attach", extractor_container.resource_id],
            stdout=write_fd, stderr=subprocess.DEVNULL, env=DOCKER_ENV,
        )
        os.close(read_fd)
        read_fd = None
        os.close(write_fd)
        write_fd = None
        try:
            extractor_status = extractor_process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            fail()
        stop_container(extractor_container, strict=True)
        extractor_container = None
        if extractor_status != 0 or relay_process.poll() is not None:
            fail()
        transferred = True
        return relay_container, relay_process, sentinel_fd
    finally:
        if read_fd is not None:
            try:
                os.close(read_fd)
            except OSError:
                pass
        if write_fd is not None:
            try:
                os.close(write_fd)
            except OSError:
                pass
        if not transferred:
            # The sentinel is the primary secret-lifetime boundary.  Closing
            # the last writer makes the relay erase its token and exit even if
            # Docker cleanup is temporarily unhealthy.
            if sentinel_fd is not None:
                try:
                    os.close(sentinel_fd)
                except OSError:
                    pass
            if extractor_process is not None and extractor_process.poll() is None:
                extractor_process.kill()
                try:
                    extractor_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            if relay_process is not None:
                try:
                    relay_process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    relay_process.kill()
                    try:
                        relay_process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
            if extractor_container is not None:
                stop_container(extractor_container, strict=True)
            if relay_container is not None:
                stop_container(relay_container, strict=True)


def wait_relay(image_id: str, network: NetworkRef, nonce: str) -> None:
    script = "const h=require('http');const r=h.get('http://deepseek-relay:8080/healthz',x=>process.exit(x.statusCode===204?0:2));r.on('error',()=>process.exit(3));r.setTimeout(1000,()=>r.destroy())"
    for attempt in range(30):
        name = f"dsh-harness-notion-{nonce[:12]}-health-{attempt:02d}"
        args = [
            *common_container_args(name, network.resource_id, nonce), "--memory", "128m",
            "--entrypoint", "/usr/local/bin/node", image_id, "-e", script,
        ]
        container = create_container(name, args, nonce, image_id)
        try:
            wait_detached_container(container, 10)
            return
        except RunnerError:
            time.sleep(1)
    fail()


def authoring_prompt(shared_prompt: bytes, phase: str) -> bytes:
    directive = PHASE_DIRECTIVES.get(phase)
    if directive is None or phase not in AUTHORING_PHASES:
        fail()
    try:
        shared_prompt.decode("utf-8")
        directive.decode("utf-8")
    except UnicodeDecodeError:
        fail()
    combined = shared_prompt.rstrip() + b"\n\n" + directive + b"\n"
    if (
        not shared_prompt.strip()
        or b"\0" in combined
        or len(combined) > ASSET_LIMITS["prompt"]
    ):
        fail()
    return combined


def run_agent(
    image_id: str,
    notion: Path,
    patch: Path,
    shared_prompt: bytes,
    network: NetworkRef,
    nonce: str,
    phase: str,
) -> None:
    prompt = authoring_prompt(shared_prompt, phase)
    prompt_text = prompt.decode("utf-8")
    name = f"dsh-harness-notion-{nonce[:12]}-task-{phase}"
    if phase == "implementation":
        workspace_mounts = [
            "--mount", f"type=bind,src={notion},dst=/work",
            "--mount", f"type=bind,src={notion / 'tests'},dst=/work/tests,readonly",
        ]
    elif phase == "tests":
        workspace_mounts = [
            "--mount", f"type=bind,src={notion},dst=/work,readonly",
            "--mount", f"type=bind,src={notion / 'tests'},dst=/work/tests",
        ]
    else:
        fail()
    args = [
        *common_container_args(name, network.resource_id, nonce),
        "--memory", "4g", "--cpus", "2", "--workdir", "/work",
        *model_isolation_tmpfs(),
        "--tmpfs", "/home/herman/.dsh:rw,nosuid,nodev,noexec,size=512m,mode=0700,uid=1000,gid=1000",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000",
        *workspace_mounts,
        "--mount", f"type=bind,src={patch},dst=/run/dsh-control/lockdown.patch.yml,readonly",
        "--env", "DSH_HOME=/home/herman/.dsh",
        "--env", "HOME=/home/herman",
        "--env", "DSH_PERMISSION_MODE=workspace-write",
        "--env", "DSH_TOOLS_MODE=native",
        "--env", "DSH_TELEMETRY_DISABLED=1",
        "--env", "DEEPSEEK_API_KEY=dsh-relay-placeholder",
        "--env", "DEEPSEEK_BASE_URL=http://deepseek-relay:8080",
        "--env", "NO_PROXY=deepseek-relay",
        "--entrypoint", "/usr/bin/tini", image_id,
        "--", "/usr/local/bin/node", "--expose-internals", "/opt/dsh/harness/apps/cli/lib/bin.js",
        "--profile", "headless", "--patch", "/run/dsh-control/lockdown.patch.yml", prompt_text,
    ]
    container = create_container(name, args, nonce, image_id)
    wait_headless_container(container, AUTHORING_PHASE_TIMEOUT, phase)


def run_tests(
    image_id: str,
    notion: Path,
    nonce: str,
    baseline: dict[str, dict[str, object]],
) -> None:
    for index, method in enumerate(TEST_METHODS):
        category = GENERATED_TEST_GATE_CATEGORIES[index]

        def generated_test() -> None:
            name = f"dsh-harness-notion-{nonce[:12]}-test-{index:02d}"
            selector = f"tests.test_notion_inbox_sync.{TEST_CLASS}.{method}"
            args = [
                *common_container_args(name, "none", nonce),
                "--memory", "768m", "--cpus", "1", "--workdir", "/work",
                "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000",
                "--mount", f"type=bind,src={notion},dst=/work,readonly",
                "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp",
                "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "PYTHONPYCACHEPREFIX=/tmp/pycache",
                "--entrypoint", "/usr/bin/python3", image_id,
                "-B", "-m", "unittest", selector,
            ]
            container = create_container(name, args, nonce, image_id)
            wait_generated_test_container(container, 180, category)
            if generated_manifest(notion) != baseline:
                fail()

        fixed_gate(category, generated_test)


def teardown_authoring(
    relay_container: ContainerRef,
    relay_process: subprocess.Popen[bytes],
    relay_sentinel_fd: int,
    task_network: NetworkRef,
    egress_network: NetworkRef,
) -> None:
    os.close(relay_sentinel_fd)
    try:
        relay_status = relay_process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        relay_process.kill()
        relay_process.wait(timeout=10)
        fail()
    if relay_status != 0:
        fail()
    stop_container(relay_container, strict=True)
    cleanup_network(task_network, strict=True)
    cleanup_network(egress_network, strict=True)


def run_trusted_probe(
    image_id: str,
    notion: Path,
    probe_source: bytes,
    probe_sha256: str,
    nonce: str,
) -> dict[str, object]:
    name = f"dsh-harness-notion-{nonce[:12]}-trusted-probe"
    loader = """import sys
source = sys.stdin.buffer.read(524289)
if not 0 < len(source) <= 524288:
    raise SystemExit(4)
code = compile(source, 'verify-harness-notion-automation.py', 'exec')
scope = {
    '__name__': '__main__',
    '__file__': 'verify-harness-notion-automation.py',
    'DSH_TRUSTED_PROBE_SOURCE_BYTES': source,
}
source = b''
sys.stdin.close()
exec(code, scope)
"""
    args = [
        *common_container_args(name, "none", nonce), "--memory", "768m", "--cpus", "1",
        "--interactive",
        "--workdir", "/work", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=0700,uid=1000,gid=1000",
        "--mount", f"type=bind,src={notion},dst=/work,readonly",
        "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp",
        "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "PYTHONPYCACHEPREFIX=/tmp/pycache",
        "--entrypoint", "/usr/bin/python3", image_id,
        "-B", "-c", loader, "--entrypoint", "/work/notion_inbox_sync.py",
    ]
    container = create_container(name, args, nonce, image_id)
    receipt_bytes = wait_trusted_probe_container(
        container, 900, MAX_RECEIPT_BYTES, probe_source,
    )

    def validate_receipt() -> dict[str, object]:
        receipt = parse_json_bytes(receipt_bytes)
        source_sha256 = sha256_bytes(read_regular(notion / ENTRYPOINT, MAX_SOURCE_BYTES))
        keys = {"schemaVersion", "interfaceVersion", "probeVersion", "entrypointSha256", "probeSha256", "testedAt", "tests"}
        expected_tests = {name: True for name in HANDOFF_NAMES.values()}
        if (
            not isinstance(receipt, dict)
            or set(receipt) != keys
            or receipt.get("schemaVersion") != 1
            or receipt.get("interfaceVersion") != 1
            or receipt.get("probeVersion") != 1
            or receipt.get("entrypointSha256") != source_sha256
            or receipt.get("probeSha256") != probe_sha256
            or receipt.get("tests") != expected_tests
            or not isinstance(receipt.get("testedAt"), str)
            or not str(receipt["testedAt"]).endswith("Z")
            or canonical_json(receipt) != receipt_bytes
        ):
            fail()
        return receipt

    return trusted_probe_gate("receipt", validate_receipt)


def create_receipts(notion: Path, probe_receipt: dict[str, object]) -> dict[str, object]:
    manifest = generated_manifest(notion)
    source_sha = str(manifest[ENTRYPOINT.as_posix()]["sha256"])
    tests = {name: True for name in HANDOFF_NAMES.values()}
    if probe_receipt.get("entrypointSha256") != source_sha or probe_receipt.get("tests") != tests:
        fail()
    receipt_bytes = canonical_json(probe_receipt)
    write_create_only(notion / TEST_RECEIPT, receipt_bytes)
    handoff = {
        "schemaVersion": 2,
        "interfaceVersion": 1,
        "artifactContract": ARTIFACT_CONTRACT,
        "entrypointSha256": source_sha,
        "testReceiptSha256": sha256_bytes(receipt_bytes),
        "testedAt": probe_receipt["testedAt"],
        "tests": tests,
    }
    write_create_only(notion / HANDOFF, canonical_json(handoff))
    return validate_receipts(notion)


def stop_container(container: ContainerRef, *, strict: bool) -> None:
    removed = False
    try:
        if not inspect_container_ref(container):
            return
        removal = subprocess.run(
            ["docker", "rm", "--force", container.resource_id], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=DOCKER_ENV, timeout=30, check=False,
        )
        removed = removal.returncode in (0, 1) and not inspect_container_ref(container)
    except (OSError, subprocess.TimeoutExpired, RunnerError):
        removed = False
    if strict and not removed:
        fail()


def cleanup_network(network: NetworkRef, *, strict: bool) -> None:
    removed = False
    try:
        if not inspect_network_ref(network):
            return
        removal = subprocess.run(
            ["docker", "network", "rm", network.resource_id], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=DOCKER_ENV, timeout=30, check=False,
        )
        removed = removal.returncode in (0, 1) and not inspect_network_ref(network)
    except (OSError, subprocess.TimeoutExpired, RunnerError):
        removed = False
    if strict and not removed:
        fail()


def result_receipt(
    operation: str,
    image: dict[str, str],
    checked: dict[str, object],
    parent_identity: tuple[int, int, int, int, int],
    prompt: bytes,
    orchestration_commit: str,
    runner_sha256: str,
    asset_hashes: dict[str, str],
    *,
    executed_now: bool,
) -> dict[str, object]:
    return {
        "status": operation,
        "owner": "live-harness-workspace",
        "path": "workspace/automations/notion/notion_inbox_sync.py",
        "handoffPath": "workspace/automations/notion/notion_inbox_sync.handoff.json",
        "interfaceVersion": 1,
        "size": checked["sourceLength"],
        "sha256": checked["sourceSha256"],
        "handoffSha256": checked["handoffSha256"],
        "testReceiptSha256": checked["testReceiptSha256"],
        "probeSha256": checked["probeSha256"],
        "testedAt": checked["testedAt"],
        "testsPassed": len(TEST_METHODS),
        "releaseId": image["releaseId"],
        "imageId": image["imageId"],
        "harnessCommit": image["harnessCommit"],
        "harnessPatchSha256": image["harnessPatchSha256"],
        "acceptedReleaseToolCommit": image["acceptedReleaseToolCommit"],
        "orchestrationCommit": orchestration_commit,
        "orchestrationSha256": {
            "runner": runner_sha256,
            "bridge": asset_hashes["bridge"],
            "lockdownPatch": asset_hashes["patch"],
            "prompt": asset_hashes["prompt"],
            "checker": asset_hashes["checker"],
            "probe": asset_hashes["probe"],
        },
        "promptSha256": sha256_bytes(prompt),
        "targetParentIdentitySha256": sha256_bytes(canonical_json(list(parent_identity))),
        "siblingInspection": "not-performed-private-boundary",
        "executedNow": executed_now,
        "evidenceSource": "this-invocation-trusted-probe" if executed_now else "previous-trusted-receipt",
        "network": "task-internal-relay-api.deepseek.com-chat-completions-only",
    }


def validate_assets(assets: dict[str, bytes], asset_hashes: dict[str, str]) -> None:
    if set(assets) != set(ASSET_LIMITS) or set(asset_hashes) != set(ASSET_LIMITS):
        fail()
    for name, maximum in ASSET_LIMITS.items():
        value = assets.get(name)
        expected = asset_hashes.get(name)
        if (
            not isinstance(value, bytes)
            or not (1 <= len(value) <= maximum)
            or not isinstance(expected, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected)
            or sha256_bytes(value) != expected
        ):
            fail()


def cleanup_task_tree(task_root: Path) -> None:
    if task_root.parent != TASKS_ROOT or not re.fullmatch(r"[0-9a-f]{32}", task_root.name):
        fail()
    try:
        entry = os.lstat(task_root)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode) or entry.st_uid != 1000 or entry.st_gid != 1000:
        fail()
    shutil.rmtree(task_root)


def execute(
    assets: dict[str, bytes],
    asset_hashes: dict[str, str],
    orchestration_commit: str,
    runner_sha256: str,
) -> dict[str, object]:
    validate_assets(assets, asset_hashes)
    if not re.fullmatch(r"[0-9a-f]{40}", orchestration_commit) or not re.fullmatch(r"[0-9a-f]{64}", runner_sha256):
        fail()
    lock_descriptor = acquire_lock()
    task_root: Path | None = None
    tasks_created = False
    relay_container: ContainerRef | None = None
    relay_process: subprocess.Popen[bytes] | None = None
    relay_sentinel_fd: int | None = None
    task_network: NetworkRef | None = None
    egress_network: NetworkRef | None = None
    destination_parent_fd: int | None = None
    source_parent_fd: int | None = None
    destination_parent_identity: tuple[int, int, int, int, int] | None = None
    source_parent_identity: tuple[int, int, int, int, int] | None = None
    installed_identity: tuple[int, int] | None = None
    try:
        require_real_directory(DSH_HOME, owner=1000)
        require_real_directory(DSH_HOME / "workspace", owner=1000)
        require_real_directory(AUTOMATIONS_ROOT, owner=1000)
        destination_parent_fd, destination_parent_identity = open_directory(AUTOMATIONS_ROOT)
        require_path_chain_identity(
            AUTOMATIONS_ROOT, destination_parent_fd, destination_parent_identity
        )
        checker = load_checker(assets["checker"])
        image = accepted_image()
        existing = target_lstat()
        if existing is not None:
            # First bootstrap is intentionally create-only.  A future idempotent
            # workflow needs a separate, explicitly reviewed production contract.
            fail()

        task_root, notion, tasks_created = create_task_tree()
        if os.lstat(task_root).st_dev != destination_parent_identity[0]:
            fail()
        paths = write_control_assets(task_root, assets)
        nonce = task_root.name
        run_dump_config(image["imageId"], paths["patch"], nonce)
        task_network = create_network(
            f"dsh-harness-notion-{nonce[:12]}-internal", nonce,
            internal=True, role="harness-notion-task",
        )
        egress_network = create_network(
            f"dsh-harness-notion-{nonce[:12]}-egress", nonce,
            internal=False, role="harness-notion-relay",
        )
        relay_container, relay_process, relay_sentinel_fd = start_secret_bridge(
            image["imageId"], paths["bridge"], nonce, task_network, egress_network,
        )
        wait_relay(image["imageId"], task_network, nonce)
        revalidate_image(image)
        run_agent(
            image["imageId"], notion, paths["patch"], assets["prompt"],
            task_network, nonce, "implementation",
        )
        source_snapshot = fixed_gate(
            "implementation-artifact",
            lambda: validate_implementation_stage(notion),
        )
        revalidate_image(image)
        run_agent(
            image["imageId"], notion, paths["patch"], assets["prompt"],
            task_network, nonce, "tests",
        )
        fixed_gate("tests-tree", lambda: validate_tests_tree(notion))
        fixed_gate(
            "tests-source-identity",
            lambda: validate_tests_source_identity(notion, source_snapshot),
        )
        teardown_sentinel_fd = relay_sentinel_fd
        relay_sentinel_fd = None
        fixed_gate(
            "authoring-teardown",
            lambda: teardown_authoring(
                relay_container,
                relay_process,
                teardown_sentinel_fd,
                task_network,
                egress_network,
            ),
        )
        relay_process = None
        relay_container = None
        task_network = None
        egress_network = None

        fixed_gate("tests-modes", lambda: normalize_generated_modes(notion))
        generated_baseline = fixed_gate(
            "tests-manifest", lambda: generated_file_manifest(notion)
        )
        fixed_gate(
            "tests-shape", lambda: validate_generated_test_shape(notion)
        )
        run_tests(image["imageId"], notion, nonce, generated_baseline)
        probe_receipt = trusted_probe_gate(
            "internal",
            lambda: run_trusted_probe(
                image["imageId"], notion, assets["probe"],
                asset_hashes["probe"], nonce,
            ),
        )
        checked = create_receipts(notion, probe_receipt)
        formal = checker_receipt(checker, task_root / "dsh-home", asset_hashes["probe"])
        if (
            formal.get("sha256") != checked["sourceSha256"]
            or formal.get("handoffSha256") != checked["handoffSha256"]
            or formal.get("testReceiptSha256") != checked["testReceiptSha256"]
        ):
            fail()
        if checked.get("probeSha256") != asset_hashes["probe"] or target_lstat() is not None:
            fail()
        fsync_tree(notion)
        notion = prepare_publication_stage(task_root, notion)
        source_parent_fd, source_parent_identity = open_directory(notion.parent)
        if source_parent_identity[0] != destination_parent_identity[0]:
            fail()
        require_path_chain_identity(
            AUTOMATIONS_ROOT, destination_parent_fd, destination_parent_identity
        )
        revalidate_image(image)
        pending_result = result_receipt(
            "installed", image, checked, destination_parent_identity, assets["prompt"],
            orchestration_commit, runner_sha256, asset_hashes, executed_now=True,
        )
        installed_identity = install_noreplace(
            source_parent_fd, source_parent_identity, destination_parent_fd, destination_parent_identity,
            destination_path=AUTOMATIONS_ROOT,
        )
        try:
            final = validate_receipts(TARGET)
            final_formal = checker_receipt(checker, DSH_HOME, asset_hashes["probe"])
            if (
                final != checked
                or final_formal.get("sha256") != checked["sourceSha256"]
                or final_formal.get("handoffSha256") != checked["handoffSha256"]
                or final_formal.get("testReceiptSha256") != checked["testReceiptSha256"]
            ):
                fail()
            require_path_chain_identity(
                AUTOMATIONS_ROOT, destination_parent_fd, destination_parent_identity
            )
            revalidate_image(image)
            try:
                os.rmdir(task_root)
            except OSError:
                fail()
        except Exception:
            rollback_created_install(
                source_parent_fd, source_parent_identity,
                destination_parent_fd, destination_parent_identity, installed_identity,
            )
            installed_identity = None
            raise
        installed_identity = None
        task_root = None
        return pending_result
    finally:
        if relay_sentinel_fd is not None:
            try:
                os.close(relay_sentinel_fd)
            except OSError:
                pass
            relay_sentinel_fd = None
        if relay_process is not None:
            try:
                relay_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                relay_process.kill()
                try:
                    relay_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        if relay_container is not None:
            stop_container(relay_container, strict=False)
        if task_network is not None:
            cleanup_network(task_network, strict=False)
        if egress_network is not None:
            cleanup_network(egress_network, strict=False)
        if task_root is not None and task_root.exists():
            cleanup_task_tree(task_root)
        if source_parent_fd is not None:
            try:
                os.close(source_parent_fd)
            except OSError:
                pass
        if destination_parent_fd is not None:
            try:
                os.close(destination_parent_fd)
            except OSError:
                pass
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(lock_descriptor)
        except OSError:
            pass


def main() -> int:
    try:
        assets = globals().get("EMBEDDED_ASSETS")
        asset_hashes = globals().get("EMBEDDED_ASSET_HASHES")
        orchestration_commit = globals().get("ORCHESTRATION_COMMIT")
        runner_sha256 = globals().get("RUNNER_SHA256")
        if (
            not isinstance(assets, dict)
            or not isinstance(asset_hashes, dict)
            or not isinstance(orchestration_commit, str)
            or not isinstance(runner_sha256, str)
        ):
            fail()
        result = execute(assets, asset_hashes, orchestration_commit, runner_sha256)
    except HeadlessTaskFailure as error:
        print(
            "harness notion automation remote operation failed "
            f"({error.phase}/{error.terminal_class})",
            file=sys.stderr,
        )
        return 6
    except TrustedProbeFailure as error:
        print(
            "harness notion automation remote operation failed "
            f"(post-authoring/trusted-probe-{error.stage})",
            file=sys.stderr,
        )
        if error.diagnostic:
            diagnostic = error.diagnostic.decode("utf-8", "backslashreplace")
            print(
                diagnostic,
                file=sys.stderr,
                end="" if diagnostic.endswith("\n") else "\n",
            )
        return 6
    except FixedGateFailure as error:
        print(
            "harness notion automation remote operation failed "
            f"(post-authoring/{error.category})",
            file=sys.stderr,
        )
        if error.diagnostic:
            diagnostic = error.diagnostic.decode("utf-8", "backslashreplace")
            print(
                diagnostic,
                file=sys.stderr,
                end="" if diagnostic.endswith("\n") else "\n",
            )
        return 6
    except Exception:
        print("harness notion automation remote operation failed", file=sys.stderr)
        return 6
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
