#!/usr/bin/env python3
"""Synthetic black-box contract probe for a Harness-owned Notion automation.

The probe intentionally treats the entrypoint and any tests beside it as
untrusted input.  It exercises the command-line program against a loopback-only
fake Notion service and emits a receipt containing only hashes, a timestamp, and
the checks that actually completed successfully.
"""

from __future__ import annotations

import ast
import contextlib
import dataclasses
import datetime
import errno
import fcntl
import hashlib
import hmac
import http.server
import json
import os
import resource
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from pathlib import Path
from typing import Callable, Iterator, cast


PROBE_VERSION = 1
DSH_TRUSTED_PROBE_SOURCE_BYTES = globals().get("DSH_TRUSTED_PROBE_SOURCE_BYTES")
MAX_ENTRYPOINT_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_STATE_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_TRACE_BYTES = 2 * 1024 * 1024
MAX_RENAMES = 32
RENAME_FAILPOINTS_PER_RENAME = 2
MAX_RENAME_FAILPOINTS = MAX_RENAMES * RENAME_FAILPOINTS_PER_RENAME
CRASH_CODE = 86
COMMAND_TIMEOUT_SECONDS = 15
PAGE_ID = "f00df00df00df00df00df00df00df00d"
NOTION_VERSION = "2026-03-11"
FAKE_TOKEN = "dsh-contract-probe-fake-token-never-production"
REMOTE_INITIAL = "# Synthetic inbox\n\n- [ ] probe item alpha\n"
LOCAL_EDIT = "# Synthetic inbox\n\n- [x] probe item local edit\n"
REMOTE_EDIT = "# Synthetic inbox\n\n- [ ] probe item remote edit\n"
SET_EDIT = "# Synthetic inbox\n\n- [ ] probe item set replacement\n"
FORCE_SET_EDIT = "# Synthetic inbox\n\n- [ ] probe item force set replacement\n"
SECRET_BODY = "# Synthetic private marker\n\n- [ ] PROBE_BODY_MUST_NOT_LEAK_7f3c\n"
ERROR_SECRET = "PROBE_HTTP_ERROR_MUST_NOT_LEAK_92ad"
REDIRECT_SECRET = "PROBE_REDIRECT_LOCATION_MUST_NOT_LEAK_b3e0"
ALLOWED_STATUSES = {"synced", "queued", "stale", "conflict", "error"}
ARTIFACT_NAMES = {
    "inbox.md",
    "sync-state.json",
    "notion-fingerprint.json",
}
INITIAL_PULL_ARGUMENTS = ("--pull", "--json")
INITIAL_PULL_REQUIRED_ROLES = frozenset({"mirror", "state", "fingerprint"})
TEST_NAMES = (
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
PROBE_TEST_STAGES = {
    "atomicArtifacts": "test-atomic-artifacts",
    "conflict": "test-conflict",
    "firstPull": "test-first-pull",
    "force": "test-force",
    "networkRecovery": "test-network-recovery",
    "noPendingNoApi": "test-no-pending-no-api",
    "pendingRetry": "test-pending-retry",
    "pullFailureNoPending": "test-pull-failure-no-pending",
    "push": "test-push",
    "read": "test-read",
    "secretRedaction": "test-secret-redaction",
    "set": "test-set",
}
SYMLINK_PREFLIGHT_STAGES = {
    role: {
        bucket: f"test-atomic-artifacts-preflight-{role}-symlink-{bucket}"
        for bucket in ("command", "outcome", "preservation", "residue")
    }
    for role in ("token", "mirror", "state", "fingerprint")
}
ATOMIC_PROBE_STAGES = (
    "test-atomic-artifacts-preflight",
    *(
        SYMLINK_PREFLIGHT_STAGES[role][bucket]
        for role in ("token", "mirror", "state", "fingerprint")
        for bucket in ("command", "outcome", "preservation", "residue")
    ),
    "test-atomic-artifacts-initial-success",
    "test-atomic-artifacts-initial-crash-before",
    "test-atomic-artifacts-initial-crash-after",
    "test-atomic-artifacts-steady-success",
    "test-atomic-artifacts-steady-crash-before",
    "test-atomic-artifacts-steady-crash-after",
    "test-atomic-artifacts-recovery",
    "test-atomic-artifacts-convergence",
)
PROBE_FAILURE_STAGES = (
    "initialization",
    "source-policy",
    *(PROBE_TEST_STAGES[name] for name in TEST_NAMES),
    *ATOMIC_PROBE_STAGES,
    "receipt",
    "internal",
)
PROBE_FAILURE_PREFIX = "dsh-probe: "
REQUIRED_SOURCE_TOKENS = (
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
FORBIDDEN_SOURCE_TOKENS = (
    b".openclaw",
    b"NOTION_API_KEY",
    b"NOTION_ENV_FILE",
    b"/home/herman/task-inbox-workflow",
)
SAFE_IMPORT_ROOTS = {
    "__future__",
    "argparse",
    "contextlib",
    "dataclasses",
    "datetime",
    "errno",
    "fcntl",
    "hashlib",
    "http",
    "io",
    "json",
    "os",
    "pathlib",
    "re",
    "secrets",
    "shutil",
    "stat",
    "sys",
    "tempfile",
    "time",
    "typing",
    "urllib",
    "uuid",
}
FORBIDDEN_SOURCE_NAMES = {
    "__import__",
    "breakpoint",
    "callable",
    "chr",
    "compile",
    "delattr",
    "dir",
    "eval",
    "exec",
    "getattr",
    "globals",
    "hasattr",
    "id",
    "locals",
    "ord",
    "repr",
    "setattr",
    "type",
    "vars",
}
FORBIDDEN_SOURCE_ATTRIBUTES = {
    "_getframe",
    "ag_frame",
    "chmod",
    "chown",
    "copymode",
    "copystat",
    "cr_frame",
    "exc_info",
    "f_back",
    "f_builtins",
    "f_code",
    "f_globals",
    "f_locals",
    "fchmod",
    "fchown",
    "FileIO",
    "gi_frame",
    "getprofile",
    "gettrace",
    "hardlink_to",
    "link_to",
    "lchmod",
    "lchown",
    "modules",
    "mmap",
    "setprofile",
    "settrace",
    "symlink_to",
    "tb_frame",
    "tb_next",
    "with_traceback",
}
FORBIDDEN_OS_CALL_PREFIXES = ("exec", "fork", "kill", "posix_spawn", "spawn")
FORBIDDEN_OS_CALLS = {
    "_exit",
    "chmod",
    "chown",
    "eventfd",
    "fchmod",
    "fchown",
    "get_inheritable",
    "link",
    "lchmod",
    "lchown",
    "memfd_create",
    "openpty",
    "pidfd_open",
    "popen",
    "removedirs",
    "removexattr",
    "renames",
    "setxattr",
    "set_inheritable",
    "system",
    "symlink",
}
FORBIDDEN_PATH_FRAGMENTS = (
    "/dev/fd",
    "/proc",
    "dsh_trusted_probe",
    "runtime-trace",
    "trace_descriptor",
    "trusted-runpy",
    "verify-harness-notion-automation",
)
PROTECTED_ALIAS_ATTRIBUTES = {
    "fcntl": {"fcntl"},
    "io": {"open"},
    "os": {
        "close",
        "copy_file_range",
        "dup",
        "dup2",
        "fdopen",
        "fstat",
        "fsync",
        "ftruncate",
        "lstat",
        "lseek",
        "open",
        "path",
        "posix_fallocate",
        "pread",
        "preadv",
        "pwrite",
        "read",
        "readv",
        "remove",
        "rename",
        "replace",
        "rmdir",
        "sendfile",
        "splice",
        "truncate",
        "unlink",
        "write",
        "writev",
    },
    "sys": {"modules", "setprofile", "settrace"},
}
TRACE_WRAPPER_SOURCE = r'''#!/usr/bin/env python3
import builtins
import fcntl
import hashlib
import hmac
import io
import json
import os
import runpy
import stat
import sys

MAX_SNAPSHOT = 16 * 1024 * 1024
CRASH_CODE = 86
_real_fstat = os.fstat
_real_fsync = os.fsync
_real_ftruncate = os.ftruncate
_real_lstat = os.lstat
_real_builtin_open = builtins.open
_real_fdopen = os.fdopen
_real_io_open = io.open
_real_listdir = os.listdir
_real_lseek = os.lseek
_real_open = os.open
_real_dup = os.dup
_real_dup2 = os.dup2
_real_pread = getattr(os, "pread", None)
_real_preadv = getattr(os, "preadv", None)
_real_pwrite = getattr(os, "pwrite", None)
_real_read = os.read
_real_readv = getattr(os, "readv", None)
_real_readlink = os.readlink
_real_remove = os.remove
_real_rmdir = os.rmdir
_real_close = os.close
_real_exit = os._exit
_real_rename = os.rename
_real_replace = os.replace
_real_stat = os.stat
_real_truncate = os.truncate
_real_unlink = os.unlink
_real_write = os.write
_real_writev = getattr(os, "writev", None)
_real_copy_file_range = getattr(os, "copy_file_range", None)
_real_posix_fallocate = getattr(os, "posix_fallocate", None)
_real_sendfile = getattr(os, "sendfile", None)
_real_splice = getattr(os, "splice", None)
_real_fcntl = fcntl.fcntl
_real_hmac_digest = hmac.digest


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def resolve_path(value, directory_fd):
    raw = os.fsdecode(value)
    if os.path.isabs(raw):
        return os.path.normpath(raw)
    if directory_fd is None:
        base = os.getcwd()
    else:
        base = os.readlink("/proc/self/fd/" + str(directory_fd))
    return os.path.normpath(os.path.join(base, raw))


def snapshot(value, directory_fd):
    path = resolve_path(value, directory_fd)
    try:
        metadata = _real_stat(value, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return {"exists": False, "path": path}
    result = {
        "exists": True,
        "path": path,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "mode": stat.S_IMODE(metadata.st_mode),
        "kind": "file" if stat.S_ISREG(metadata.st_mode) else "dir" if stat.S_ISDIR(metadata.st_mode) else "other",
        "length": metadata.st_size,
    }
    if stat.S_ISREG(metadata.st_mode):
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = _real_open(value, flags, dir_fd=directory_fd)
        try:
            current = _real_fstat(descriptor)
            if current.st_dev != metadata.st_dev or current.st_ino != metadata.st_ino or current.st_size > MAX_SNAPSHOT:
                raise RuntimeError("unstable trace source")
            digest = hashlib.sha256()
            length = 0
            while True:
                chunk = _real_read(descriptor, 65536)
                if not chunk:
                    break
                digest.update(chunk)
                length += len(chunk)
                if length > MAX_SNAPSHOT:
                    raise RuntimeError("trace source too large")
            if length != current.st_size:
                raise RuntimeError("unstable trace source")
            result["sha256"] = digest.hexdigest()
        finally:
            _real_close(descriptor)
    return result


if len(sys.argv) < 5 or sys.argv[4] != "--":
    raise SystemExit(90)
target_path = sys.argv[1]
trace_descriptor = int(sys.argv[2])
fail_index = int(sys.argv[3])
target_arguments = sys.argv[5:]
key_candidates = []
required_key_seals = (
    fcntl.F_SEAL_SEAL
    | fcntl.F_SEAL_SHRINK
    | fcntl.F_SEAL_GROW
    | fcntl.F_SEAL_WRITE
)
for descriptor_name in _real_listdir("/proc/self/fd"):
    if not descriptor_name.isdecimal():
        continue
    candidate = int(descriptor_name)
    try:
        target = _real_readlink("/proc/self/fd/" + descriptor_name)
        candidate_flags = _real_fcntl(candidate, fcntl.F_GETFL)
        candidate_seals = _real_fcntl(candidate, fcntl.F_GET_SEALS)
        candidate_metadata = _real_fstat(candidate)
    except OSError:
        continue
    if (
        "memfd:dsh-notion-contract-trace-key-v1" in target
        and candidate_flags & os.O_ACCMODE == os.O_RDONLY
        and candidate_seals == required_key_seals
        and stat.S_ISREG(candidate_metadata.st_mode)
        and candidate_metadata.st_size == 32
    ):
        key_candidates.append(candidate)
if len(key_candidates) != 1:
    raise RuntimeError("trace key unavailable")
key_descriptor = key_candidates[0]
try:
    _real_lseek(key_descriptor, 0, os.SEEK_SET)
    key_chunks = []
    key_length = 0
    while True:
        key_chunk = _real_read(key_descriptor, 64)
        if not key_chunk:
            break
        key_chunks.append(key_chunk)
        key_length += len(key_chunk)
        if key_length > 32:
            raise RuntimeError("invalid trace key")
finally:
    _real_close(key_descriptor)
trace_key = b"".join(key_chunks)
if len(trace_key) != 32:
    raise RuntimeError("invalid trace key")
token_path = os.path.normpath(os.environ["NOTION_TOKEN_FILE"])
token_descriptors = set()
writable_descriptors = {}
published_inodes = set()
symlink_target_subjects = {}
rename_index = 0
failpoint_index = 0
trace_sequence = 0
trace_previous_mac = "0" * 64

raw_inbox_path = os.environ.get("NOTION_INBOX_FILE")
if raw_inbox_path:
    inbox_path = os.path.normpath(raw_inbox_path)
    artifact_directory = os.path.dirname(inbox_path)
    canonical_artifact_paths = {
        inbox_path,
        os.path.join(artifact_directory, "sync-state.json"),
        os.path.join(artifact_directory, "notion-fingerprint.json"),
    }
else:
    artifact_directory = None
    canonical_artifact_paths = set()

canonical_artifact_subjects = {}
if raw_inbox_path:
    canonical_artifact_subjects = {
        inbox_path: "mirror",
        os.path.join(artifact_directory, "sync-state.json"): "state",
        os.path.join(artifact_directory, "notion-fingerprint.json"): "fingerprint",
    }

for subject_path, subject in (
    (token_path, "token"),
    *canonical_artifact_subjects.items(),
):
    try:
        subject_link = _real_lstat(subject_path)
        subject_target = _real_stat(subject_path)
    except OSError:
        continue
    if stat.S_ISLNK(subject_link.st_mode) and stat.S_ISREG(subject_target.st_mode):
        key = (subject_target.st_dev, subject_target.st_ino)
        symlink_target_subjects.setdefault(key, set()).add(subject)

for artifact_path in canonical_artifact_paths:
    try:
        artifact_metadata = _real_lstat(artifact_path)
    except FileNotFoundError:
        continue
    if stat.S_ISREG(artifact_metadata.st_mode):
        published_inodes.add((artifact_metadata.st_dev, artifact_metadata.st_ino))


def emit(value):
    global trace_previous_mac, trace_sequence
    trace_sequence += 1
    authenticated = {
        "seq": trace_sequence,
        "prevMAC": trace_previous_mac,
        "payload": value,
    }
    message_mac = _real_hmac_digest(trace_key, canonical(authenticated), "sha256").hex()
    encoded = canonical({**authenticated, "HMAC": message_mac})
    offset = 0
    while offset < len(encoded):
        offset += _real_write(trace_descriptor, encoded[offset:])
    _real_fsync(trace_descriptor)
    trace_previous_mac = message_mac


def emit_symlink_target_open(descriptor, mechanism):
    try:
        metadata = _real_fstat(descriptor)
    except OSError:
        return
    subjects = symlink_target_subjects.get((metadata.st_dev, metadata.st_ino))
    if subjects:
        emit({
            "type": "symlink-target-open",
            "descriptor": descriptor,
            "mechanism": mechanism,
            "subjects": sorted(subjects),
        })


def traced_fsync(descriptor):
    result = _real_fsync(descriptor)
    metadata = _real_fstat(descriptor)
    event = {
        "type": "fsync",
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "kind": "file" if stat.S_ISREG(metadata.st_mode) else "dir" if stat.S_ISDIR(metadata.st_mode) else "other",
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
    }
    if stat.S_ISREG(metadata.st_mode):
        read_descriptor = _real_open(
            "/proc/self/fd/" + str(descriptor),
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0),
        )
        try:
            current = _real_fstat(read_descriptor)
            if current.st_dev != metadata.st_dev or current.st_ino != metadata.st_ino or current.st_size > MAX_SNAPSHOT:
                raise RuntimeError("unstable fsync source")
            digest = hashlib.sha256()
            length = 0
            while True:
                chunk = _real_read(read_descriptor, 65536)
                if not chunk:
                    break
                digest.update(chunk)
                length += len(chunk)
                if length > MAX_SNAPSHOT:
                    raise RuntimeError("fsync source too large")
            if length != current.st_size:
                raise RuntimeError("unstable fsync source")
            event["length"] = length
            event["sha256"] = digest.hexdigest()
        finally:
            _real_close(read_descriptor)
    emit(event)
    return result


def emit_create(descriptor, path, mechanism, requested_mode, flags):
    metadata = _real_fstat(descriptor)
    emit({
        "type": "create",
        "mechanism": mechanism,
        "path": resolve_path(path, None),
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "mode": stat.S_IMODE(metadata.st_mode),
        "requestedMode": requested_mode,
        "flags": flags,
        "createOnly": True,
    })


def descriptor_flags(descriptor):
    try:
        return _real_fcntl(descriptor, fcntl.F_GETFL)
    except OSError:
        return None


def flags_are_writable(flags):
    return flags is not None and flags & os.O_ACCMODE in (os.O_WRONLY, os.O_RDWR)


def register_writable_descriptor(descriptor, mechanism, create_only):
    flags = descriptor_flags(descriptor)
    if not flags_are_writable(flags):
        return
    metadata = _real_fstat(descriptor)
    record = {
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "flags": flags,
        "mechanism": mechanism,
        "createOnly": bool(create_only),
    }
    writable_descriptors[descriptor] = record
    emit({"type": "fd-open", "descriptor": descriptor, **record})


def discard_writable_descriptor(descriptor, reason):
    record = writable_descriptors.pop(descriptor, None)
    if record is not None:
        emit({
            "type": "fd-close",
            "descriptor": descriptor,
            "dev": record["dev"],
            "ino": record["ino"],
            "reason": reason,
        })


def prune_writable_descriptors():
    for descriptor, record in tuple(writable_descriptors.items()):
        flags = descriptor_flags(descriptor)
        try:
            metadata = _real_fstat(descriptor)
        except OSError:
            discard_writable_descriptor(descriptor, "observed-closed")
            continue
        if (
            not flags_are_writable(flags)
            or metadata.st_dev != record["dev"]
            or metadata.st_ino != record["ino"]
        ):
            discard_writable_descriptor(descriptor, "descriptor-reused")


def writable_descriptors_for_inode(device, inode):
    prune_writable_descriptors()
    descriptors = []
    try:
        names = _real_listdir("/proc/self/fd")
    except OSError:
        raise RuntimeError("artifact descriptor audit unavailable")
    for name in names:
        if not name.isdecimal():
            continue
        descriptor = int(name)
        flags = descriptor_flags(descriptor)
        if not flags_are_writable(flags):
            continue
        try:
            metadata = _real_fstat(descriptor)
        except OSError:
            continue
        if metadata.st_dev == device and metadata.st_ino == inode:
            descriptors.append(descriptor)
    return descriptors


def emit_fd_mutation(
    operation,
    descriptor,
    result=None,
    offset_before=None,
    offset_after=None,
):
    try:
        metadata = _real_fstat(descriptor)
    except OSError:
        emit({"type": "fd-write", "operation": operation, "descriptor": descriptor})
        return
    event = {
        "type": "fd-write",
        "operation": operation,
        "descriptor": descriptor,
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "kind": "file" if stat.S_ISREG(metadata.st_mode) else "other",
    }
    if isinstance(result, int):
        event["result"] = result
    if isinstance(offset_before, int) and isinstance(offset_after, int):
        event["offsetBefore"] = offset_before
        event["offsetAfter"] = offset_after
    emit(event)
    if stat.S_ISREG(metadata.st_mode) and (metadata.st_dev, metadata.st_ino) in published_inodes:
        emit({
            "type": "post-publish-write",
            "operation": operation,
            "descriptor": descriptor,
            "dev": metadata.st_dev,
            "ino": metadata.st_ino,
        })


def token_metadata(metadata):
    return {
        "dev": metadata.st_dev,
        "ino": metadata.st_ino,
        "kind": "file" if stat.S_ISREG(metadata.st_mode) else "other",
        "mode": stat.S_IMODE(metadata.st_mode),
        "nlink": metadata.st_nlink,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "size": metadata.st_size,
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
    }


def is_token_path(path, directory_fd=None):
    try:
        return resolve_path(path, directory_fd) == token_path
    except (OSError, TypeError, ValueError):
        return False


def traced_lstat(path, *, dir_fd=None):
    metadata = _real_lstat(path, dir_fd=dir_fd)
    if is_token_path(path, dir_fd):
        emit({"type": "token-lstat", **token_metadata(metadata)})
    return metadata


def traced_open(path, flags, mode=0o777, *, dir_fd=None):
    descriptor = _real_open(path, flags, mode, dir_fd=dir_fd)
    emit_symlink_target_open(descriptor, "os.open")
    access_mode = flags & os.O_ACCMODE
    create_only = bool(flags & os.O_CREAT and flags & os.O_EXCL)
    mutating_flags = flags & (os.O_CREAT | getattr(os, "O_TRUNC", 0))
    if not create_only and (access_mode in (os.O_WRONLY, os.O_RDWR) or mutating_flags):
        metadata = _real_fstat(descriptor)
        emit({
            "type": "unsafe-write-open",
            "mechanism": "os.open",
            "path": resolve_path(path, dir_fd),
            "dev": metadata.st_dev,
            "ino": metadata.st_ino,
            "mode": stat.S_IMODE(metadata.st_mode),
            "flags": flags,
        })
    if is_token_path(path, dir_fd):
        metadata = _real_fstat(descriptor)
        token_descriptors.add(descriptor)
        emit({
            "type": "token-open",
            "descriptor": descriptor,
            "flags": flags,
            **token_metadata(metadata),
        })
    if flags & os.O_CREAT and flags & os.O_EXCL:
        metadata = _real_fstat(descriptor)
        emit({
            "type": "create",
            "mechanism": "os.open",
            "path": resolve_path(path, dir_fd),
            "dev": metadata.st_dev,
            "ino": metadata.st_ino,
            "mode": stat.S_IMODE(metadata.st_mode),
            "requestedMode": stat.S_IMODE(mode),
            "flags": flags,
            "createOnly": True,
        })
    register_writable_descriptor(descriptor, "os.open", create_only)
    return descriptor


def traced_fstat(descriptor):
    metadata = _real_fstat(descriptor)
    if descriptor in token_descriptors:
        emit({
            "type": "token-fstat",
            "descriptor": descriptor,
            **token_metadata(metadata),
        })
    return metadata


def traced_read(descriptor, count):
    before_offset = _real_lseek(descriptor, 0, os.SEEK_CUR) if descriptor in token_descriptors else None
    value = _real_read(descriptor, count)
    if descriptor in token_descriptors:
        after_offset = _real_lseek(descriptor, 0, os.SEEK_CUR)
        emit({
            "type": "token-read",
            "descriptor": descriptor,
            "length": len(value),
            "offsetBefore": before_offset,
            "offsetAfter": after_offset,
        })
    return value


def traced_lseek(descriptor, position, how):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.lseek",
        })
    return _real_lseek(descriptor, position, how)


def traced_pread(descriptor, count, offset):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.pread",
        })
    return _real_pread(descriptor, count, offset)


def traced_preadv(descriptor, buffers, offset, flags=0):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.preadv",
        })
    return _real_preadv(descriptor, buffers, offset, flags)


def traced_readv(descriptor, buffers):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.readv",
        })
    return _real_readv(descriptor, buffers)


def traced_dup(descriptor):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.dup",
        })
    return _real_dup(descriptor)


def traced_dup2(descriptor, destination, inheritable=True):
    if descriptor in token_descriptors:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "os.dup2",
        })
    return _real_dup2(descriptor, destination, inheritable=inheritable)


def traced_fcntl(descriptor, command, argument=0):
    duplicate_commands = {
        value for value in (
            getattr(fcntl, "F_DUPFD", None),
            getattr(fcntl, "F_DUPFD_CLOEXEC", None),
        ) if value is not None
    }
    if descriptor in token_descriptors and command in duplicate_commands:
        emit({
            "type": "token-alternate-read",
            "descriptor": descriptor,
            "operation": "fcntl.fcntl-dup",
        })
    return _real_fcntl(descriptor, command, argument)


def traced_close(descriptor):
    if descriptor in token_descriptors:
        emit({"type": "token-close", "descriptor": descriptor})
        token_descriptors.discard(descriptor)
    result = _real_close(descriptor)
    discard_writable_descriptor(descriptor, "os.close")
    return result


def traced_high_level_open(function, mechanism, file, mode="r", *args, **kwargs):
    result = function(file, mode, *args, **kwargs)
    emit_symlink_target_open(result.fileno(), mechanism)
    if is_token_path(file) or (isinstance(file, int) and file in token_descriptors):
        emit({
            "type": "token-unsafe-high-level-open",
            "descriptor": file if isinstance(file, int) else result.fileno(),
        })
    if isinstance(mode, str):
        if "x" in mode:
            emit_create(result.fileno(), file, "open-x", None, None)
        elif any(character in mode for character in "wa+"):
            metadata = _real_fstat(result.fileno())
            emit({
                "type": "unsafe-write-open",
                "mechanism": "open",
                "path": resolve_path(file, None),
                "dev": metadata.st_dev,
                "ino": metadata.st_ino,
                "mode": stat.S_IMODE(metadata.st_mode),
                "openMode": mode,
            })
        register_writable_descriptor(result.fileno(), "open", "x" in mode)
    return result


def traced_builtin_open(file, mode="r", *args, **kwargs):
    return traced_high_level_open(
        _real_builtin_open, "builtins.open", file, mode, *args, **kwargs
    )


def traced_io_open(file, mode="r", *args, **kwargs):
    return traced_high_level_open(
        _real_io_open, "io.open", file, mode, *args, **kwargs
    )


def traced_fdopen(descriptor, *args, **kwargs):
    result = _real_fdopen(descriptor, *args, **kwargs)
    emit_symlink_target_open(descriptor, "os.fdopen")
    if descriptor in token_descriptors:
        emit({
            "type": "token-unsafe-high-level-open",
            "descriptor": descriptor,
        })
    existing = writable_descriptors.get(descriptor)
    create_only = existing is not None and existing.get("createOnly") is True
    register_writable_descriptor(descriptor, "os.fdopen", create_only)
    if descriptor in writable_descriptors:
        metadata = _real_fstat(descriptor)
        emit({
            "type": "fd-handle-open",
            "descriptor": descriptor,
            "dev": metadata.st_dev,
            "ino": metadata.st_ino,
            "mechanism": "os.fdopen",
        })
    return result


def traced_write(descriptor, value):
    try:
        offset_before = _real_lseek(descriptor, 0, os.SEEK_CUR)
    except OSError:
        offset_before = None
    result = _real_write(descriptor, value)
    try:
        offset_after = _real_lseek(descriptor, 0, os.SEEK_CUR)
    except OSError:
        offset_after = None
    emit_fd_mutation(
        "os.write",
        descriptor,
        result,
        offset_before,
        offset_after,
    )
    return result


def traced_pwrite(descriptor, value, offset):
    result = _real_pwrite(descriptor, value, offset)
    emit_fd_mutation("os.pwrite", descriptor, result)
    return result


def traced_writev(descriptor, buffers):
    result = _real_writev(descriptor, buffers)
    emit_fd_mutation("os.writev", descriptor, result)
    return result


def traced_ftruncate(descriptor, length):
    result = _real_ftruncate(descriptor, length)
    emit_fd_mutation("os.ftruncate", descriptor, length)
    return result


def traced_copy_file_range(source, destination, count, offset_src=None, offset_dst=None):
    if source in token_descriptors:
        emit({"type": "token-alternate-read", "operation": "os.copy_file_range"})
    result = _real_copy_file_range(source, destination, count, offset_src, offset_dst)
    emit_fd_mutation("os.copy_file_range", destination, result)
    return result


def traced_sendfile(destination, source, offset, count):
    if source in token_descriptors:
        emit({"type": "token-alternate-read", "operation": "os.sendfile"})
    result = _real_sendfile(destination, source, offset, count)
    emit_fd_mutation("os.sendfile", destination, result)
    return result


def traced_splice(source, destination, count, offset_src=None, offset_dst=None, flags=0):
    if source in token_descriptors:
        emit({"type": "token-alternate-read", "operation": "os.splice"})
    result = _real_splice(source, destination, count, offset_src, offset_dst, flags)
    emit_fd_mutation("os.splice", destination, result)
    return result


def traced_posix_fallocate(descriptor, offset, length):
    result = _real_posix_fallocate(descriptor, offset, length)
    emit_fd_mutation("os.posix_fallocate", descriptor, length)
    return result


def traced_truncate(path, length, *args, **kwargs):
    result = _real_truncate(path, length, *args, **kwargs)
    directory_fd = kwargs.get("dir_fd")
    value = snapshot(path, directory_fd)
    emit({
        "type": "unsafe-path-write",
        "operation": "os.truncate",
        "path": resolve_path(path, directory_fd),
        "destinationAfter": value,
    })
    if value.get("kind") == "file" and (value.get("dev"), value.get("ino")) in published_inodes:
        emit({
            "type": "post-publish-write",
            "operation": "os.truncate",
            "dev": value["dev"],
            "ino": value["ino"],
        })
    return result


def protected_path(path):
    return path in canonical_artifact_paths or (
        artifact_directory is not None and path == artifact_directory
    )


def traced_path_remove(operation, function, path, args, kwargs):
    directory_fd = kwargs.get("dir_fd")
    before = snapshot(path, directory_fd)
    resolved = resolve_path(path, directory_fd)
    blocked = protected_path(resolved)
    emit({
        "type": "path-remove",
        "operation": operation,
        "path": resolved,
        "before": before,
        "blocked": blocked,
    })
    if blocked:
        raise RuntimeError("protected artifact path removal")
    return function(path, *args, **kwargs)


def traced_unlink(path, *args, **kwargs):
    return traced_path_remove("os.unlink", _real_unlink, path, args, kwargs)


def traced_remove(path, *args, **kwargs):
    return traced_path_remove("os.remove", _real_remove, path, args, kwargs)


def traced_rmdir(path, *args, **kwargs):
    return traced_path_remove("os.rmdir", _real_rmdir, path, args, kwargs)


def injected_crash():
    emit({"type": "trace-end", "outcome": "injected-crash"})
    _real_fsync(trace_descriptor)
    _real_close(trace_descriptor)
    _real_exit(CRASH_CODE)


def traced_rename(operation, function, source, destination, args, kwargs):
    global failpoint_index, rename_index
    source_directory_fd = kwargs.get("src_dir_fd")
    destination_directory_fd = kwargs.get("dst_dir_fd")
    source_before = snapshot(source, source_directory_fd)
    destination_before = snapshot(destination, destination_directory_fd)
    if source_before.get("kind") == "file":
        source_metadata = _real_stat(
            source,
            dir_fd=source_directory_fd,
            follow_symlinks=False,
        )
        if (
            source_metadata.st_dev != source_before.get("dev")
            or source_metadata.st_ino != source_before.get("ino")
        ):
            raise RuntimeError("unstable rename source")
        source_before.update({
            "nlink": source_metadata.st_nlink,
            "uid": source_metadata.st_uid,
            "gid": source_metadata.st_gid,
            "mtimeNs": source_metadata.st_mtime_ns,
            "ctimeNs": source_metadata.st_ctime_ns,
        })
    source_path = resolve_path(source, source_directory_fd)
    destination_path = resolve_path(destination, destination_directory_fd)
    if protected_path(source_path) or (
        artifact_directory is not None and destination_path == artifact_directory
    ):
        emit({
            "type": "path-remove",
            "operation": operation,
            "path": source_path,
            "destination": destination_path,
            "before": source_before,
            "blocked": True,
        })
        raise RuntimeError("protected artifact path rename")
    publishing_artifact = destination_path in canonical_artifact_paths
    publishing_task_file = (
        artifact_directory is not None
        and os.path.dirname(destination_path) == artifact_directory
    )
    if publishing_task_file and source_before.get("kind") == "file":
        open_writers = writable_descriptors_for_inode(
            source_before["dev"],
            source_before["ino"],
        )
        if open_writers:
            emit({
                "type": "publish-with-open-writer",
                "operation": operation,
                "destination": destination_path,
                "dev": source_before["dev"],
                "ino": source_before["ino"],
                "writerCount": len(open_writers),
            })
            raise RuntimeError("artifact publication has an open writer")
    rename_index += 1
    failpoint_index += 1
    crash_before = fail_index == failpoint_index
    emit({
        "type": "rename-boundary",
        "index": rename_index,
        "failpointIndex": failpoint_index,
        "phase": "before",
        "operation": operation,
        "sourceBefore": source_before,
        "destinationBefore": destination_before,
        "crash": crash_before,
    })
    if crash_before:
        injected_crash()
    result = function(source, destination, *args, **kwargs)
    destination_after = snapshot(destination, destination_directory_fd)
    if publishing_artifact and destination_after.get("kind") == "file":
        if destination_before.get("kind") == "file":
            published_inodes.discard(
                (destination_before.get("dev"), destination_before.get("ino"))
            )
        published_inodes.add((destination_after["dev"], destination_after["ino"]))
    failpoint_index += 1
    should_crash = fail_index == failpoint_index
    emit({
        "type": "rename",
        "index": rename_index,
        "failpointIndex": failpoint_index,
        "operation": operation,
        "sourceBefore": source_before,
        "destinationBefore": destination_before,
        "destinationAfter": destination_after,
        "crash": should_crash,
    })
    if should_crash:
        injected_crash()
    return result


def replace(source, destination, *args, **kwargs):
    return traced_rename("replace", _real_replace, source, destination, args, kwargs)


def rename(source, destination, *args, **kwargs):
    return traced_rename("rename", _real_rename, source, destination, args, kwargs)


os.fsync = traced_fsync
os.fstat = traced_fstat
os.lstat = traced_lstat
os.fdopen = traced_fdopen
os.open = traced_open
os.read = traced_read
os.lseek = traced_lseek
os.dup = traced_dup
os.dup2 = traced_dup2
os.close = traced_close
os.ftruncate = traced_ftruncate
os.unlink = traced_unlink
os.remove = traced_remove
os.rmdir = traced_rmdir
os.replace = replace
os.rename = rename
os.truncate = traced_truncate
os.write = traced_write
fcntl.fcntl = traced_fcntl
if _real_pread is not None:
    os.pread = traced_pread
if _real_preadv is not None:
    os.preadv = traced_preadv
if _real_readv is not None:
    os.readv = traced_readv
if _real_pwrite is not None:
    os.pwrite = traced_pwrite
if _real_writev is not None:
    os.writev = traced_writev
if _real_copy_file_range is not None:
    os.copy_file_range = traced_copy_file_range
if _real_posix_fallocate is not None:
    os.posix_fallocate = traced_posix_fallocate
if _real_sendfile is not None:
    os.sendfile = traced_sendfile
if _real_splice is not None:
    os.splice = traced_splice
builtins.open = traced_builtin_open
io.open = traced_io_open
sys.argv = [target_path, *target_arguments]
emit({"type": "trace-start", "version": 1})
try:
    runpy.run_path(target_path, run_name="__main__")
except SystemExit as exit_error:
    exit_code = exit_error.code
    if exit_code is None or (isinstance(exit_code, int) and exit_code == 0):
        emit({"type": "trace-end", "outcome": "returned"})
        raise
    emit({"type": "trace-end", "outcome": "failed"})
    if isinstance(exit_code, int):
        raise
    raise SystemExit(1) from None
except BaseException:
    emit({"type": "trace-end", "outcome": "failed"})
    raise SystemExit(1) from None
else:
    emit({"type": "trace-end", "outcome": "returned"})
finally:
    _real_fsync(trace_descriptor)
    _real_close(trace_descriptor)
'''.encode("utf-8")
SENSITIVE_OUTPUT_MARKERS = tuple(
    value.encode("utf-8")
    for value in (
        FAKE_TOKEN,
        PAGE_ID,
        REMOTE_INITIAL,
        LOCAL_EDIT,
        REMOTE_EDIT,
        SET_EDIT,
        FORCE_SET_EDIT,
        SECRET_BODY,
        ERROR_SECRET,
        REDIRECT_SECRET,
    )
)


class ProbeFailure(Exception):
    """A trusted contract-probe failure."""


class ProbeStageFailure(ProbeFailure):
    """One fixed failure stage with a formatted root diagnostic."""

    def __init__(self, stage: str, diagnostic: str = "") -> None:
        if stage not in PROBE_FAILURE_STAGES:
            stage = "internal"
        self.stage = stage
        self.diagnostic = diagnostic
        super().__init__("Harness Notion automation contract probe failed")


def fail() -> None:
    raise ProbeFailure("Harness Notion automation contract probe failed")


def probe_stage(stage: str, operation: Callable[[], object]) -> object:
    """Run one probe stage while retaining the root failure for diagnosis."""
    if stage not in PROBE_FAILURE_STAGES:
        stage = "internal"
    diagnostic = ""
    try:
        return operation()
    except ProbeStageFailure:
        raise
    except Exception as error:
        diagnostic = "".join(traceback.format_exception(error))
    raise ProbeStageFailure(stage, diagnostic)


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def path_is_same_or_parent(parent: str, child: str) -> bool:
    return parent == child or child.startswith(parent.rstrip(os.sep) + os.sep)


def benign_missing_transition_remove(
    event: dict[str, object],
    canonical_paths: set[str],
    transition_source_paths: set[str],
) -> bool:
    path = event.get("path")
    return (
        isinstance(path, str)
        and path in transition_source_paths
        and path not in canonical_paths
        and event.get("operation") in {"os.unlink", "os.remove"}
        and event.get("blocked") is False
        and event.get("before") == {"exists": False, "path": path}
    )


def utc_now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def read_regular(path: Path, maximum: int, *, mode: int | None = None) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        before_path = os.lstat(path)
        descriptor = os.open(path, flags)
    except OSError:
        fail()
    try:
        before = os.fstat(descriptor)
        if (
            stat.S_ISLNK(before_path.st_mode)
            or not stat.S_ISREG(before_path.st_mode)
            or not stat.S_ISREG(before.st_mode)
            or before_path.st_dev != before.st_dev
            or before_path.st_ino != before.st_ino
            or before_path.st_nlink != 1
            or before.st_nlink != 1
            or before_path.st_uid != before.st_uid
            or before_path.st_gid != before.st_gid
            or before_path.st_size != before.st_size
            or before.st_size < 0
            or before.st_size > maximum
            or (mode is not None and stat.S_IMODE(before.st_mode) != mode)
        ):
            fail()
        chunks: list[bytes] = []
        length = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > maximum:
                fail()
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
        if length != before.st_size or any(
            getattr(before, field) != getattr(after, field) for field in stable_fields
        ):
            fail()
        return b"".join(chunks)
    finally:
        os.close(descriptor)


STABLE_IDENTITY_FIELDS = (
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


def lstat_identity(path: Path) -> tuple[int, ...]:
    try:
        metadata = os.lstat(path)
    except OSError:
        fail()
    return tuple(int(getattr(metadata, field)) for field in STABLE_IDENTITY_FIELDS)


def stable_regular_identity(
    path: Path,
    maximum: int,
    *,
    mode: int | None = None,
) -> tuple[tuple[int, ...], bytes]:
    before = lstat_identity(path)
    if stat.S_ISLNK(before[2]) or not stat.S_ISREG(before[2]):
        fail()
    value = read_regular(path, maximum, mode=mode)
    if lstat_identity(path) != before:
        fail()
    return before, value


def stable_symlink_identity(path: Path) -> tuple[tuple[int, ...], str]:
    before = lstat_identity(path)
    if not stat.S_ISLNK(before[2]):
        fail()
    try:
        target = os.readlink(path)
    except OSError:
        fail()
    if lstat_identity(path) != before:
        fail()
    return before, target


def preflight_tree_identity(root: Path) -> tuple[tuple[object, ...], ...]:
    """Snapshot a synthetic preflight tree, including links but not their targets."""
    root_identity = lstat_identity(root)
    if stat.S_ISLNK(root_identity[2]) or not stat.S_ISDIR(root_identity[2]):
        fail()
    result: list[tuple[object, ...]] = [(".", "directory", root_identity)]
    try:
        walk = os.walk(root, topdown=True, followlinks=False)
        for parent, directories, files in walk:
            directories.sort()
            files.sort()
            parent_path = Path(parent)
            for name in (*directories, *files):
                path = parent_path / name
                relative = path.relative_to(root).as_posix()
                identity = lstat_identity(path)
                if stat.S_ISLNK(identity[2]):
                    link_identity, target = stable_symlink_identity(path)
                    result.append((relative, "symlink", link_identity, target))
                elif stat.S_ISDIR(identity[2]):
                    result.append((relative, "directory", identity))
                elif stat.S_ISREG(identity[2]):
                    file_identity, value = stable_regular_identity(
                        path, MAX_ARTIFACT_BYTES
                    )
                    result.append(
                        (
                            relative,
                            "file",
                            file_identity,
                            sha256_bytes(value),
                        )
                    )
                else:
                    fail()
    except OSError:
        fail()
    if lstat_identity(root) != root_identity:
        fail()
    return tuple(result)


def random_private_marker(subject: str) -> bytes:
    if subject not in {"token", "mirror", "state", "fingerprint"}:
        fail()
    return f"dsh-private-{subject}-canary-{os.urandom(32).hex()}".encode("ascii")


def write_private_file(path: Path, value: bytes) -> None:
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


def randomized_descriptor_floor() -> int:
    """Choose a high randomized descriptor floor within the active fd limit."""
    try:
        soft_limit, _hard_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
    except (OSError, ValueError):
        fail()
    if soft_limit == resource.RLIM_INFINITY:
        ceiling = 65536
    else:
        ceiling = min(int(soft_limit), 65536)
    if ceiling < 256:
        fail()
    lower = ceiling // 2
    upper = ceiling - max(64, ceiling // 8)
    if upper <= lower:
        fail()
    entropy = int.from_bytes(os.urandom(4), "big")
    return lower + entropy % (upper - lower)


def anonymous_descriptor(name: str, initial: bytes = b"", *, seal: bool = False) -> int:
    if not hasattr(os, "memfd_create") or not hasattr(fcntl, "F_ADD_SEALS"):
        fail()
    flags = getattr(os, "MFD_CLOEXEC", 0) | getattr(os, "MFD_ALLOW_SEALING", 0)
    try:
        descriptor = os.memfd_create(name, flags)
        offset = 0
        while offset < len(initial):
            offset += os.write(descriptor, initial[offset:])
        os.fsync(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)
        if seal:
            seals = (
                fcntl.F_SEAL_SEAL
                | fcntl.F_SEAL_SHRINK
                | fcntl.F_SEAL_GROW
                | fcntl.F_SEAL_WRITE
            )
            fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, seals)
        minimum = randomized_descriptor_floor()
        relocated = fcntl.fcntl(descriptor, fcntl.F_DUPFD_CLOEXEC, minimum)
        os.close(descriptor)
        return relocated
    except (AttributeError, OSError):
        with contextlib.suppress(UnboundLocalError, OSError):
            os.close(descriptor)
        fail()


def one_shot_key_descriptor(value: bytes) -> int:
    if len(value) != 32:
        fail()
    writable_descriptor = -1
    readonly_descriptor = -1
    try:
        writable_descriptor = anonymous_descriptor(
            "dsh-notion-contract-trace-key-v1",
            value,
            seal=True,
        )
        readonly_descriptor = os.open(
            f"/proc/self/fd/{writable_descriptor}",
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0),
        )
        minimum = randomized_descriptor_floor()
        relocated = fcntl.fcntl(readonly_descriptor, fcntl.F_DUPFD_CLOEXEC, minimum)
        os.close(readonly_descriptor)
        readonly_descriptor = -1
        os.close(writable_descriptor)
        return relocated
    except (AttributeError, OSError):
        with contextlib.suppress(OSError):
            if readonly_descriptor >= 0:
                os.close(readonly_descriptor)
        with contextlib.suppress(OSError):
            if writable_descriptor >= 0:
                os.close(writable_descriptor)
        fail()


def read_descriptor_bounded(descriptor: int, maximum: int) -> bytes:
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > maximum:
            fail()
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        length = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > maximum:
                fail()
        after = os.fstat(descriptor)
        if length != metadata.st_size or after.st_size != metadata.st_size:
            fail()
        return b"".join(chunks)
    except OSError:
        fail()


def trusted_probe_source() -> bytes:
    provided = DSH_TRUSTED_PROBE_SOURCE_BYTES
    if isinstance(provided, bytes) and 0 < len(provided) <= 2 * 1024 * 1024:
        return provided
    if isinstance(provided, bytearray) and 0 < len(provided) <= 2 * 1024 * 1024:
        return bytes(provided)
    if provided is not None:
        fail()
    try:
        fallback = Path(__file__).resolve(strict=True)
    except (NameError, OSError):
        fail()
    return read_regular(fallback, 2 * 1024 * 1024)


def parse_trace(value: bytes, key: bytes) -> list[dict[str, object]]:
    if (
        len(key) != 32
        or not value
        or len(value) > MAX_TRACE_BYTES
        or not value.endswith(b"\n")
    ):
        fail()
    events: list[dict[str, object]] = []
    previous_mac = "0" * 64
    expected_sequence = 1
    for line in value.splitlines():
        try:
            envelope = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail()
        if (
            not isinstance(envelope, dict)
            or set(envelope) != {"seq", "prevMAC", "payload", "HMAC"}
            or envelope.get("seq") != expected_sequence
            or envelope.get("prevMAC") != previous_mac
            or not isinstance(envelope.get("payload"), dict)
            or not isinstance(envelope.get("HMAC"), str)
            or len(envelope["HMAC"]) != 64
        ):
            fail()
        authenticated = {
            "seq": envelope["seq"],
            "prevMAC": envelope["prevMAC"],
            "payload": envelope["payload"],
        }
        expected_mac = hmac.digest(key, canonical_json(authenticated), "sha256").hex()
        if not hmac.compare_digest(envelope["HMAC"], expected_mac):
            fail()
        previous_mac = envelope["HMAC"]
        expected_sequence += 1
        event = envelope["payload"]
        if event.get("type") not in {
            "create",
            "fd-close",
            "fd-handle-open",
            "fd-open",
            "fd-write",
            "fsync",
            "post-publish-write",
            "publish-with-open-writer",
            "path-remove",
            "rename",
            "rename-boundary",
            "symlink-target-open",
            "token-alternate-read",
            "token-close",
            "token-fstat",
            "token-lstat",
            "token-open",
            "token-read",
            "token-unsafe-high-level-open",
            "unsafe-path-write",
            "unsafe-write-open",
            "trace-end",
            "trace-start",
        }:
            fail()
        if event.get("type") == "symlink-target-open" and (
            set(event) != {"type", "descriptor", "mechanism", "subjects"}
            or not isinstance(event.get("descriptor"), int)
            or int(event["descriptor"]) < 0
            or event.get("mechanism")
            not in {"os.open", "builtins.open", "io.open", "os.fdopen"}
            or not isinstance(event.get("subjects"), list)
            or not event["subjects"]
            or any(not isinstance(subject, str) for subject in event["subjects"])
            or event["subjects"] != sorted(set(event["subjects"]))
            or not set(event["subjects"]).issubset(
                {"token", "mirror", "state", "fingerprint"}
            )
        ):
            fail()
        events.append(event)
    if (
        len(events) < 2
        or events[0] != {"type": "trace-start", "version": 1}
        or events[-1].get("type") != "trace-end"
        or set(events[-1]) != {"type", "outcome"}
        or events[-1].get("outcome") not in {"returned", "failed", "injected-crash"}
        or any(event.get("type") in {"trace-start", "trace-end"} for event in events[1:-1])
    ):
        fail()
    return events


def validate_trace_outcome(events: list[dict[str, object]], returncode: int) -> None:
    outcome = events[-1].get("outcome")
    if (
        (returncode == 0 and outcome != "returned")
        or (returncode == CRASH_CODE and outcome != "injected-crash")
        or (returncode not in {0, CRASH_CODE} and outcome != "failed")
    ):
        fail()


def reject_unsafe_write_events(events: list[dict[str, object]]) -> None:
    forbidden = {
        "path-remove",
        "post-publish-write",
        "publish-with-open-writer",
        "unsafe-path-write",
        "unsafe-write-open",
    }
    if any(
        event.get("type") in forbidden
        and (event.get("type") != "path-remove" or event.get("blocked") is True)
        for event in events
    ):
        fail()


class SafeEntrypointVisitor(ast.NodeVisitor):
    """Reject source capable of reaching or bypassing the in-process tracer."""

    def __init__(self) -> None:
        self.protected_module_roots = {
            "fcntl": "fcntl", "io": "io", "os": "os", "sys": "sys"
        }
        self.protected_value_names = {"open"}

    def protected_kind(self, value: ast.AST | None) -> str | None:
        if value is None:
            return None
        if isinstance(value, ast.Name):
            if value.id in self.protected_module_roots:
                return self.protected_module_roots[value.id]
            if value.id in self.protected_value_names:
                return "value"
            return None
        if isinstance(value, ast.Attribute):
            base_kind = self.protected_kind(value.value)
            if base_kind is None:
                return None
            if base_kind in {"fcntl", "io", "os", "sys"}:
                return "value" if value.attr in PROTECTED_ALIAS_ATTRIBUTES[base_kind] else None
            return "value"
        if isinstance(value, ast.Subscript):
            return "value" if self.protected_kind(value.value) is not None else None
        if isinstance(value, ast.NamedExpr):
            return self.protected_kind(value.value)
        if isinstance(value, ast.IfExp):
            kinds = {self.protected_kind(value.body), self.protected_kind(value.orelse)} - {None}
            return "value" if kinds else None
        if isinstance(value, (ast.Tuple, ast.List, ast.Set)):
            return "value" if any(self.protected_kind(element) is not None for element in value.elts) else None
        if isinstance(value, ast.Dict):
            members = (*value.keys, *value.values)
            return "value" if any(self.protected_kind(member) is not None for member in members) else None
        if isinstance(value, ast.BoolOp):
            return "value" if any(self.protected_kind(member) is not None for member in value.values) else None
        if isinstance(value, ast.BinOp):
            return (
                "value"
                if self.protected_kind(value.left) is not None or self.protected_kind(value.right) is not None
                else None
            )
        if isinstance(value, ast.UnaryOp):
            return "value" if self.protected_kind(value.operand) is not None else None
        if isinstance(value, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            members: list[ast.AST] = [value.elt]
            members.extend(generator.iter for generator in value.generators)
            return "value" if any(self.protected_kind(member) is not None for member in members) else None
        if isinstance(value, ast.DictComp):
            members = [value.key, value.value, *(generator.iter for generator in value.generators)]
            return "value" if any(self.protected_kind(member) is not None for member in members) else None
        return None

    def protected_name(self, name: str) -> bool:
        return name in self.protected_module_roots or name in self.protected_value_names

    def protected_assignment(self, target: ast.AST) -> bool:
        if isinstance(target, (ast.Tuple, ast.List)):
            return any(self.protected_assignment(element) for element in target.elts)
        if isinstance(target, ast.Starred):
            return self.protected_assignment(target.value)
        if isinstance(target, (ast.Attribute, ast.Subscript)) and self.protected_kind(target.value) is not None:
            return True
        current = target
        while isinstance(current, (ast.Attribute, ast.Subscript)):
            current = current.value
        return isinstance(current, ast.Name) and self.protected_name(current.id)

    def bind_target(self, target: ast.AST, kind: str | None) -> None:
        if kind is None:
            return
        if isinstance(target, ast.Name):
            if self.protected_name(target.id):
                fail()
            if kind in {"fcntl", "io", "os", "sys"}:
                self.protected_module_roots[target.id] = kind
            else:
                self.protected_value_names.add(target.id)
            return
        if isinstance(target, ast.Starred):
            self.bind_target(target.value, "value")
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self.bind_target(element, "value")
            return
        # Storing a protected module/object in an attribute or mapping would
        # erase the provenance needed to reject a later monkeypatch.
        fail()

    def bind_assignment(self, target: ast.AST, value: ast.AST | None) -> None:
        if (
            isinstance(target, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(target.elts) == len(value.elts)
        ):
            for target_element, value_element in zip(target.elts, value.elts, strict=True):
                self.bind_assignment(target_element, value_element)
            return
        self.bind_target(target, self.protected_kind(value))

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            root = alias.name.split(".", 1)[0]
            if root not in SAFE_IMPORT_ROOTS:
                fail()
            if root in {"fcntl", "io", "os", "sys"}:
                self.protected_module_roots[alias.asname or root] = root
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        if node.level or node.module is None or node.module.split(".", 1)[0] not in SAFE_IMPORT_ROOTS:
            fail()
        if any(
            alias.name == "*"
            or alias.name.startswith("_")
            or alias.name in {"builtins", "fcntl", "io", "os", "sys"}
            or alias.name in FORBIDDEN_SOURCE_ATTRIBUTES
            for alias in node.names
        ):
            fail()
        if node.module.split(".", 1)[0] == "os" and any(
            alias.name in FORBIDDEN_OS_CALLS or alias.name.startswith(FORBIDDEN_OS_CALL_PREFIXES)
            for alias in node.names
        ):
            fail()
        protected_root = node.module.split(".", 1)[0]
        if protected_root in {"fcntl", "io", "os", "sys"}:
            for alias in node.names:
                if protected_root == "os" and alias.name.startswith("O_"):
                    continue
                self.protected_value_names.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        if any(self.protected_assignment(target) for target in node.targets):
            fail()
        for target in node.targets:
            self.bind_assignment(target, node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:  # noqa: N802
        if self.protected_assignment(node.target):
            fail()
        self.bind_assignment(node.target, node.value)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:  # noqa: N802
        if self.protected_assignment(node.target):
            fail()
        self.bind_assignment(node.target, node.value)
        self.generic_visit(node)

    def visit_Delete(self, node: ast.Delete) -> None:  # noqa: N802
        if any(self.protected_assignment(target) for target in node.targets):
            fail()
        self.generic_visit(node)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:  # noqa: N802
        if self.protected_assignment(node.target):
            fail()
        self.bind_assignment(node.target, node.value)
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:  # noqa: N802
        self.bind_target(node.target, self.protected_kind(node.iter))
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:  # noqa: N802
        self.bind_target(node.target, self.protected_kind(node.iter))
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:  # noqa: N802
        if self.protected_kind(node.value) is not None:
            fail()
        self.generic_visit(node)

    def visit_Yield(self, node: ast.Yield) -> None:  # noqa: N802
        if self.protected_kind(node.value) is not None:
            fail()
        self.generic_visit(node)

    def visit_YieldFrom(self, node: ast.YieldFrom) -> None:  # noqa: N802
        if self.protected_kind(node.value) is not None:
            fail()
        self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:  # noqa: N802
        defaults = (*node.args.defaults, *(value for value in node.args.kw_defaults if value is not None))
        if self.protected_kind(node.body) is not None or any(
            self.protected_kind(value) is not None for value in defaults
        ):
            fail()
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        if self.protected_name(node.name):
            fail()
        defaults = (*node.args.defaults, *(value for value in node.args.kw_defaults if value is not None))
        if any(self.protected_kind(value) is not None for value in defaults):
            fail()
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self.visit_FunctionDef(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        if self.protected_name(node.name):
            fail()
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:  # noqa: N802
        if (
            node.attr.startswith("_")
            or node.attr in {"builtins", "io", "os", "sys"}
            or node.attr in FORBIDDEN_SOURCE_ATTRIBUTES
            or node.attr in FORBIDDEN_OS_CALLS
            or node.attr.startswith(FORBIDDEN_OS_CALL_PREFIXES)
        ):
            fail()
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:  # noqa: N802
        if node.id in FORBIDDEN_SOURCE_NAMES or (node.id.startswith("__") and node.id != "__name__"):
            fail()
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:  # noqa: N802
        if isinstance(node.value, (str, bytes)):
            raw = node.value.decode("utf-8", "ignore") if isinstance(node.value, bytes) else node.value
            lowered = raw.lower()
            if any(fragment in lowered for fragment in FORBIDDEN_PATH_FRAGMENTS):
                fail()
            if "__" in raw and raw != "__main__":
                fail()
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        if isinstance(node.func, ast.Name) and node.func.id == "getattr":
            if (
                len(node.args) != 3
                or node.keywords
                or not isinstance(node.args[0], ast.Name)
                or node.args[0].id != "os"
                or not isinstance(node.args[1], ast.Constant)
                or not isinstance(node.args[1].value, str)
                or not node.args[1].value.startswith("O_")
                or not isinstance(node.args[2], ast.Constant)
                or not isinstance(node.args[2].value, int)
            ):
                fail()
            for argument in node.args:
                self.visit(argument)
            return
        if any(self.protected_kind(argument) is not None for argument in node.args) or any(
            self.protected_kind(keyword.value) is not None for keyword in node.keywords
        ):
            fail()
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            if node.func.value.id == "os" and (
                node.func.attr in FORBIDDEN_OS_CALLS
                or node.func.attr.startswith(FORBIDDEN_OS_CALL_PREFIXES)
            ):
                fail()
        self.generic_visit(node)


def validate_safe_entrypoint_source(source: bytes) -> None:
    try:
        decoded = source.decode("utf-8")
        tree = ast.parse(decoded, filename="<harness-notion-entrypoint>", mode="exec")
    except (UnicodeDecodeError, SyntaxError, ValueError):
        fail()
    SafeEntrypointVisitor().visit(tree)


def source_identity(entrypoint: Path) -> tuple[bytes, str]:
    if not entrypoint.is_absolute():
        fail()
    source = read_regular(entrypoint, MAX_ENTRYPOINT_BYTES, mode=0o600)
    if not source or any(token not in source for token in REQUIRED_SOURCE_TOKENS):
        fail()
    if any(token in source for token in FORBIDDEN_SOURCE_TOKENS):
        fail()
    validate_safe_entrypoint_source(source)
    return source, sha256_bytes(source)


def tree_manifest(root: Path) -> tuple[tuple[object, ...], ...]:
    """Hash a source tree without following links or exposing its content."""
    try:
        root_stat = os.lstat(root)
    except OSError:
        fail()
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        fail()
    result: list[tuple[object, ...]] = []
    for parent, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        parent_path = Path(parent)
        for name in (*directories, *files):
            path = parent_path / name
            relative = path.relative_to(root).as_posix()
            try:
                metadata = os.lstat(path)
            except OSError:
                fail()
            if stat.S_ISLNK(metadata.st_mode):
                fail()
            if stat.S_ISDIR(metadata.st_mode):
                result.append((relative, "dir", stat.S_IMODE(metadata.st_mode)))
            elif stat.S_ISREG(metadata.st_mode):
                value = read_regular(path, 2 * 1024 * 1024)
                result.append(
                    (relative, "file", stat.S_IMODE(metadata.st_mode), len(value), sha256_bytes(value))
                )
            else:
                fail()
    return tuple(result)


@dataclasses.dataclass(frozen=True)
class RequestRecord:
    method: str
    path: str
    authorization: str
    notion_version: str
    request_body: bytes
    valid: bool


class FakeNotionState:
    def __init__(self, body: str = REMOTE_INITIAL) -> None:
        self.body = body
        self.fail_get = False
        self.fail_patch = False
        self.redirect_get: str | None = None
        self.get_response_override: dict[str, object] | None = None
        self.patch_response_override: dict[str, object] | None = None
        self.records: list[RequestRecord] = []
        self.lock = threading.Lock()

    def reset(self) -> None:
        with self.lock:
            self.records.clear()

    def record(self, value: RequestRecord) -> None:
        with self.lock:
            self.records.append(value)

    def snapshot(self) -> tuple[RequestRecord, ...]:
        with self.lock:
            return tuple(self.records)


class FakeNotionHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dsh-contract-probe"
    sys_version = ""

    @property
    def state(self) -> FakeNotionState:
        return self.server.probe_state  # type: ignore[attr-defined,no-any-return]

    @property
    def expected_path(self) -> str:
        return f"/v1/pages/{PAGE_ID}/markdown"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _read_request_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            return b""
        if length < 0 or length > MAX_ARTIFACT_BYTES:
            return b""
        return self.rfile.read(length)

    def _record(self, method: str, body: bytes, valid: bool) -> None:
        self.state.record(
            RequestRecord(
                method=method,
                path=self.path,
                authorization=self.headers.get("Authorization", ""),
                notion_version=self.headers.get("Notion-Version", ""),
                request_body=body,
                valid=valid,
            )
        )

    def _reply(self, status_code: int, value: object) -> None:
        body = canonical_json(value)
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def _valid_common(self) -> bool:
        return (
            urllib.parse.urlsplit(self.path).query == ""
            and self.path == self.expected_path
            and self.headers.get("Authorization") == f"Bearer {FAKE_TOKEN}"
            and self.headers.get("Notion-Version") == NOTION_VERSION
        )

    def _page_response(self) -> dict[str, object]:
        return {
            "object": "page_markdown",
            "id": PAGE_ID,
            "markdown": self.state.body,
            "truncated": False,
            "unknown_block_ids": [],
        }

    def do_GET(self) -> None:  # noqa: N802
        body = self._read_request_body()
        valid = self._valid_common() and body == b""
        self._record("GET", body, valid)
        if not valid:
            self._reply(400, {"object": "error", "code": "invalid_request"})
        elif self.state.redirect_get is not None:
            self._redirect(self.state.redirect_get)
        elif self.state.fail_get:
            self._reply(503, {"object": "error", "message": ERROR_SECRET})
        else:
            self._reply(
                200,
                self.state.get_response_override
                if self.state.get_response_override is not None
                else self._page_response(),
            )

    def do_PATCH(self) -> None:  # noqa: N802
        body = self._read_request_body()
        valid = self._valid_common()
        try:
            parsed = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        expected_keys = {"type", "replace_content"}
        if (
            not isinstance(parsed, dict)
            or set(parsed) != expected_keys
            or parsed.get("type") != "replace_content"
            or not isinstance(parsed.get("replace_content"), dict)
            or set(parsed["replace_content"]) != {"new_str"}
            or not isinstance(parsed["replace_content"].get("new_str"), str)
        ):
            valid = False
        self._record("PATCH", body, valid)
        if not valid:
            self._reply(400, {"object": "error", "code": "invalid_request"})
        elif self.state.fail_patch:
            self._reply(503, {"object": "error", "message": ERROR_SECRET})
        elif self.state.patch_response_override is not None:
            self._reply(200, self.state.patch_response_override)
        else:
            self.state.body = parsed["replace_content"]["new_str"]
            self._reply(200, self._page_response())

    def _unexpected(self) -> None:
        body = self._read_request_body()
        self._record(self.command, body, False)
        self._reply(405, {"object": "error", "code": "unsupported_method"})

    do_POST = _unexpected
    do_PUT = _unexpected
    do_DELETE = _unexpected
    do_HEAD = _unexpected
    do_OPTIONS = _unexpected


class LoopbackNotion:
    def __init__(self, body: str = REMOTE_INITIAL) -> None:
        self.state = FakeNotionState(body)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeNotionHandler)
        self.server.daemon_threads = True
        self.server.probe_state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01),
            daemon=True,
        )

    @property
    def api_base(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    def __enter__(self) -> "LoopbackNotion":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@contextlib.contextmanager
def closed_loopback_api() -> Iterator[str]:
    closed_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    closed_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    closed_socket.bind(("127.0.0.1", 0))
    host, port = closed_socket.getsockname()
    try:
        yield f"http://{host}:{port}/v1"
    finally:
        closed_socket.close()


@dataclasses.dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: bytes
    stderr: bytes


def fail_command_result(result: CommandResult) -> None:
    stdout = result.stdout.decode("utf-8", "replace")[-32768:]
    stderr = result.stderr.decode("utf-8", "replace")[-32768:]
    raise ProbeFailure(
        "Harness Notion automation child command failed "
        f"(returncode={result.returncode})\n"
        f"stdout tail:\n{stdout}\n"
        f"stderr tail:\n{stderr}"
    )


@dataclasses.dataclass(frozen=True)
class AtomicFileSnapshot:
    path: str
    dev: int
    ino: int
    uid: int
    gid: int
    mtime_ns: int
    ctime_ns: int
    length: int
    sha256: str

    def trace_value(self) -> dict[str, object]:
        return {
            "exists": True,
            "path": self.path,
            "dev": self.dev,
            "ino": self.ino,
            "mode": 0o600,
            "kind": "file",
            "length": self.length,
            "sha256": self.sha256,
        }


@dataclasses.dataclass(frozen=True)
class AtomicTreeSnapshot:
    canonical_values: dict[str, bytes]
    canonical_inodes: dict[str, tuple[int, int]]
    residues: dict[str, AtomicFileSnapshot]


@dataclasses.dataclass(frozen=True)
class AtomicTransition:
    result: CommandResult
    events: list[dict[str, object]]
    values: dict[str, bytes]
    inodes: dict[str, tuple[int, int]]
    failpoints: int


@dataclasses.dataclass(frozen=True)
class AtomicRecovery:
    values: dict[str, bytes]
    first_failpoints: int
    recovered_failpoints: int


@dataclasses.dataclass(frozen=True)
class AtomicScenario:
    name: str
    arguments: tuple[str, ...]
    input_text: str | None
    expected_status: str
    expected_mirror: str
    expected_remote: str
    patch_body: str | None


ATOMIC_SCENARIOS = (
    AtomicScenario(
        "pull",
        ("--pull", "--json"),
        None,
        "synced",
        REMOTE_EDIT,
        REMOTE_EDIT,
        None,
    ),
    AtomicScenario(
        "set",
        ("--set", "-", "--json"),
        SET_EDIT,
        "synced",
        SET_EDIT,
        SET_EDIT,
        SET_EDIT,
    ),
    AtomicScenario(
        "force-set",
        ("--set", "-", "--force", "--json"),
        FORCE_SET_EDIT,
        "synced",
        FORCE_SET_EDIT,
        FORCE_SET_EDIT,
        FORCE_SET_EDIT,
    ),
    AtomicScenario(
        "push",
        ("--push", "--json"),
        None,
        "synced",
        LOCAL_EDIT,
        LOCAL_EDIT,
        LOCAL_EDIT,
    ),
    AtomicScenario(
        "queued-set",
        ("--set", "-", "--json"),
        SET_EDIT,
        "queued",
        SET_EDIT,
        REMOTE_INITIAL,
        SET_EDIT,
    ),
    AtomicScenario(
        "queued-push",
        ("--push", "--json"),
        None,
        "queued",
        LOCAL_EDIT,
        REMOTE_INITIAL,
        LOCAL_EDIT,
    ),
    AtomicScenario(
        "queued-force-set",
        ("--set", "-", "--force", "--json"),
        FORCE_SET_EDIT,
        "queued",
        FORCE_SET_EDIT,
        REMOTE_EDIT,
        FORCE_SET_EDIT,
    ),
    AtomicScenario(
        "pending-retry",
        ("--retry-pending", "--json"),
        None,
        "synced",
        SET_EDIT,
        SET_EDIT,
        SET_EDIT,
    ),
    AtomicScenario(
        "pending-retry-push",
        ("--retry-pending", "--json"),
        None,
        "synced",
        LOCAL_EDIT,
        LOCAL_EDIT,
        LOCAL_EDIT,
    ),
    AtomicScenario(
        "pending-retry-force",
        ("--retry-pending", "--json"),
        None,
        "synced",
        FORCE_SET_EDIT,
        FORCE_SET_EDIT,
        FORCE_SET_EDIT,
    ),
)


def incomplete_page_responses(markdown: str) -> tuple[dict[str, object], ...]:
    common: dict[str, object] = {
        "object": "page_markdown",
        "id": PAGE_ID,
        "markdown": markdown,
        "truncated": False,
        "unknown_block_ids": [],
    }
    truncated = dict(common)
    truncated["truncated"] = True
    unknown = dict(common)
    unknown["unknown_block_ids"] = ["synthetic-unknown-block"]
    missing = dict(common)
    del missing["markdown"]
    non_string = dict(common)
    non_string["markdown"] = 17
    return truncated, unknown, missing, non_string


class ProbeSandbox:
    def __init__(self, entrypoint: Path, source_sha256: str, source_tree: tuple[tuple[object, ...], ...]) -> None:
        self.entrypoint = entrypoint
        self.source_sha256 = source_sha256
        self.source_tree = source_tree
        self.temporary = tempfile.TemporaryDirectory(prefix="dsh-notion-contract-probe-")
        self.root = Path(self.temporary.name)
        self.dsh_home = self.root / "dsh-home"
        self.process_home = self.root / "process-home"
        self.run_directory = self.root / "run"
        self.task_directory = self.dsh_home / "storages/task-inbox"
        self.inbox = self.task_directory / "inbox.md"
        self.state = self.task_directory / "sync-state.json"
        self.fingerprint = self.task_directory / "notion-fingerprint.json"
        self.token = self.root / "notion.token"
        self.dsh_home.mkdir(mode=0o700)
        self.process_home.mkdir(mode=0o700)
        self.run_directory.mkdir(mode=0o700)
        descriptor = os.open(self.token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, (FAKE_TOKEN + "\n").encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def close(self) -> None:
        self.temporary.cleanup()

    def env(self, api_base: str) -> dict[str, str]:
        return {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.process_home),
            "LANG": "C.UTF-8",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": str(self.run_directory),
            "NOTION_TOKEN_FILE": str(self.token),
            "NOTION_INBOX_FILE": str(self.inbox),
            "NOTION_API_BASE": api_base,
            "NOTION_PAGE_ID": PAGE_ID,
        }

    @contextlib.contextmanager
    def reject_token_access(self) -> Iterator[threading.Event]:
        """Replace the token with a FIFO and report any attempted blocking read."""
        saved_token = self.root / "notion.token.saved"
        os.replace(self.token, saved_token)
        os.mkfifo(self.token, 0o600)
        accessed = threading.Event()
        stopped = threading.Event()

        def detect_reader() -> None:
            while not stopped.is_set():
                try:
                    descriptor = os.open(self.token, os.O_WRONLY | os.O_NONBLOCK)
                except OSError as error:
                    if error.errno not in (errno.ENXIO, errno.ENOENT):
                        accessed.set()
                        return
                    time.sleep(0.01)
                    continue
                accessed.set()
                try:
                    os.write(descriptor, (FAKE_TOKEN + "\n").encode("utf-8"))
                except OSError:
                    pass
                finally:
                    os.close(descriptor)
                return

        detector = threading.Thread(target=detect_reader, daemon=True)
        detector.start()
        try:
            yield accessed
        finally:
            stopped.set()
            detector.join(timeout=2)
            with contextlib.suppress(FileNotFoundError):
                self.token.unlink()
            os.replace(saved_token, self.token)

    def assert_source_unchanged(self) -> None:
        value, digest = source_identity(self.entrypoint)
        if not value or digest != self.source_sha256 or tree_manifest(self.entrypoint.parent) != self.source_tree:
            fail()

    def assert_no_logs(self, *, allow_obstruction: bool = False) -> None:
        if set(path.name for path in self.root.iterdir()) != {
            "dsh-home",
            "process-home",
            "run",
            "notion.token",
        }:
            fail()
        if read_regular(self.token, 1024, mode=0o600) != (FAKE_TOKEN + "\n").encode("utf-8"):
            fail()
        if list(self.process_home.iterdir()) or list(self.run_directory.iterdir()):
            fail()
        allowed_directories = {
            self.dsh_home,
            self.dsh_home / "storages",
            self.task_directory,
        }
        allowed_files = {self.inbox, self.state, self.fingerprint}
        for parent, directories, files in os.walk(self.dsh_home, topdown=True, followlinks=False):
            parent_path = Path(parent)
            for name in directories:
                path = parent_path / name
                metadata = os.lstat(path)
                if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                    fail()
                if path not in allowed_directories and not (
                    allow_obstruction and path == self.fingerprint
                ):
                    fail()
            for name in files:
                path = parent_path / name
                if path not in allowed_files:
                    fail()

    def read_artifacts(self, expected_mirror: str | None = None) -> dict[str, bytes]:
        self.assert_no_logs()
        if not self.task_directory.is_dir() or set(path.name for path in self.task_directory.iterdir()) != ARTIFACT_NAMES:
            fail()
        values = {
            "mirror": read_regular(self.inbox, MAX_ARTIFACT_BYTES, mode=0o600),
            "state": read_regular(self.state, MAX_STATE_BYTES, mode=0o600),
            "fingerprint": read_regular(self.fingerprint, MAX_STATE_BYTES, mode=0o600),
        }
        for value in values.values():
            assert_artifact_redacted(value)
        if expected_mirror is not None and values["mirror"] != expected_mirror.encode("utf-8"):
            fail()
        for role in ("state", "fingerprint"):
            try:
                parsed = json.loads(values[role])
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail()
            if not isinstance(parsed, dict):
                fail()
        return values

    def assert_task_tree_redacted(self) -> None:
        if not self.task_directory.exists():
            return
        for parent, directories, files in os.walk(self.task_directory, topdown=True, followlinks=False):
            for name in (*directories, *files):
                path = Path(parent) / name
                metadata = os.lstat(path)
                if stat.S_ISLNK(metadata.st_mode):
                    fail()
                if stat.S_ISREG(metadata.st_mode):
                    assert_artifact_redacted(read_regular(path, MAX_ARTIFACT_BYTES))
                elif not stat.S_ISDIR(metadata.st_mode):
                    fail()

    def write_local_mirror(self, value: str) -> None:
        self.task_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.task_directory / ".probe-local-edit"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            encoded = value.encode("utf-8")
            offset = 0
            while offset < len(encoded):
                offset += os.write(descriptor, encoded[offset:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.inbox)
        directory_descriptor = os.open(self.task_directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)


def kill_process_group(process: subprocess.Popen[bytes]) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


def capture_command(
    args: list[str],
    *,
    env: dict[str, str],
    cwd: Path,
    input_bytes: bytes | None,
    pass_fds: tuple[int, ...] = (),
    close_after_spawn: tuple[int, ...] = (),
) -> CommandResult:
    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            close_fds=True,
            pass_fds=pass_fds,
            start_new_session=True,
        )
    except OSError:
        for descriptor in close_after_spawn:
            with contextlib.suppress(OSError):
                os.close(descriptor)
        fail()
    for descriptor in close_after_spawn:
        try:
            os.close(descriptor)
        except OSError:
            kill_process_group(process)
            fail()
    assert process.stdout is not None and process.stderr is not None
    if input_bytes is not None:
        assert process.stdin is not None
        try:
            process.stdin.write(input_bytes)
        except BrokenPipeError:
            pass
        finally:
            process.stdin.close()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                kill_process_group(process)
                fail()
            events = selector.select(min(remaining, 0.2))
            if not events and process.poll() is not None:
                events = [(key, selectors.EVENT_READ) for key in selector.get_map().values()]
            for key, _mask in events:
                try:
                    chunk = os.read(key.fd, 8192)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer = buffers[str(key.data)]
                buffer.extend(chunk)
                if len(buffer) > MAX_OUTPUT_BYTES:
                    kill_process_group(process)
                    fail()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            kill_process_group(process)
            fail()
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            kill_process_group(process)
            fail()
    finally:
        selector.close()
        # The direct child may have exited after forking a detached worker that
        # closed stdout/stderr.  The session is ours, so always clear its whole
        # process group before returning to the next isolated contract case.
        kill_process_group(process)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=2)
        process.stdout.close()
        process.stderr.close()
    return CommandResult(returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]))


def assert_redacted(result: CommandResult) -> None:
    combined = result.stdout + b"\n" + result.stderr
    lowered = combined.lower()
    if any(marker in combined for marker in SENSITIVE_OUTPUT_MARKERS):
        fail()
    if b"bearer " in lowered:
        fail()


def assert_private_markers_redacted(
    result: CommandResult,
    markers: tuple[bytes, ...],
) -> None:
    combined = result.stdout + b"\n" + result.stderr
    if any(not marker or marker in combined for marker in markers):
        fail()


def assert_artifact_redacted(value: bytes) -> None:
    lowered = value.lower()
    if FAKE_TOKEN.encode("utf-8") in value or b"bearer " in lowered or b"authorization" in lowered:
        fail()


def parse_status(result: CommandResult, expected: set[str]) -> dict[str, object]:
    assert_redacted(result)
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("status"), str)
        or value["status"] not in ALLOWED_STATUSES
        or value["status"] not in expected
    ):
        fail()
    return value


def assert_request_contract(
    notion: LoopbackNotion,
    *,
    gets: int | None = None,
    patches: int | None = None,
    patch_body: str | None = None,
) -> None:
    records = notion.state.snapshot()
    if any(not record.valid for record in records):
        fail()
    if gets is not None and sum(record.method == "GET" for record in records) != gets:
        fail()
    patch_records = [record for record in records if record.method == "PATCH"]
    if patches is not None and len(patch_records) != patches:
        fail()
    if patch_body is not None:
        if len(patch_records) != 1:
            fail()
        try:
            value = json.loads(patch_records[0].request_body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail()
        if value != {
            "type": "replace_content",
            "replace_content": {"new_str": patch_body},
        }:
            fail()


class ContractProbe:
    def __init__(self, entrypoint: Path) -> None:
        if not entrypoint.is_absolute():
            fail()
        self.entrypoint = entrypoint
        _source, self.entrypoint_sha256 = source_identity(self.entrypoint)
        self.source_tree = tree_manifest(self.entrypoint.parent)

    @contextlib.contextmanager
    def sandbox(self) -> Iterator[ProbeSandbox]:
        value = ProbeSandbox(self.entrypoint, self.entrypoint_sha256, self.source_tree)
        try:
            yield value
        finally:
            value.close()

    def command(
        self,
        sandbox: ProbeSandbox,
        api_base: str,
        arguments: list[str],
        *,
        input_text: str | None = None,
    ) -> CommandResult:
        result = capture_command(
            [sys.executable, "-I", "-S", "-B", str(self.entrypoint), *arguments],
            env=sandbox.env(api_base),
            cwd=sandbox.run_directory,
            input_bytes=None if input_text is None else input_text.encode("utf-8"),
        )
        assert_redacted(result)
        sandbox.assert_source_unchanged()
        return result

    def traced_command(
        self,
        sandbox: ProbeSandbox,
        api_base: str,
        arguments: list[str],
        *,
        fail_index: int = 0,
        input_text: str | None = None,
        private_markers: tuple[bytes, ...] = (),
    ) -> tuple[CommandResult, list[dict[str, object]]]:
        if fail_index < 0 or fail_index > MAX_RENAME_FAILPOINTS:
            fail()
        wrapper_descriptor = anonymous_descriptor(
            "dsh-notion-contract-wrapper",
            TRACE_WRAPPER_SOURCE,
            seal=True,
        )
        trace_descriptor = anonymous_descriptor("dsh-notion-contract-trace")
        trace_key = os.urandom(32)
        key_descriptor = one_shot_key_descriptor(trace_key)
        result: CommandResult | None = None
        trace_bytes: bytes | None = None
        try:
            result = capture_command(
                [
                    sys.executable,
                    "-I",
                    "-S",
                    "-B",
                    f"/proc/self/fd/{wrapper_descriptor}",
                    str(self.entrypoint),
                    str(trace_descriptor),
                    str(fail_index),
                    "--",
                    *arguments,
                ],
                env=sandbox.env(api_base),
                cwd=sandbox.run_directory,
                input_bytes=None if input_text is None else input_text.encode("utf-8"),
                pass_fds=(wrapper_descriptor, trace_descriptor, key_descriptor),
                close_after_spawn=(key_descriptor,),
            )
            trace_bytes = read_descriptor_bounded(trace_descriptor, MAX_TRACE_BYTES)
        finally:
            with contextlib.suppress(OSError):
                os.close(key_descriptor)
            os.close(trace_descriptor)
            os.close(wrapper_descriptor)
        if result is None or trace_bytes is None:
            fail()
        assert_redacted(result)
        assert_private_markers_redacted(result, private_markers)
        sandbox.assert_source_unchanged()
        events = parse_trace(trace_bytes, trace_key)
        validate_trace_outcome(events, result.returncode)
        reject_unsafe_write_events(events)
        return result, events

    @staticmethod
    def validate_symlink_preflight_trace(
        events: list[dict[str, object]],
    ) -> None:
        allowed = {"trace-start", "trace-end", "token-lstat"}
        if any(event.get("type") not in allowed for event in events):
            fail()

    @staticmethod
    def artifact_paths(sandbox: ProbeSandbox) -> dict[str, Path]:
        return {
            "mirror": sandbox.inbox,
            "state": sandbox.state,
            "fingerprint": sandbox.fingerprint,
        }

    def partial_atomic_snapshot(self, sandbox: ProbeSandbox) -> AtomicTreeSnapshot:
        canonical_by_path = {
            str(path): role for role, path in self.artifact_paths(sandbox).items()
        }
        values: dict[str, bytes] = {}
        inodes: dict[str, tuple[int, int]] = {}
        residues: dict[str, AtomicFileSnapshot] = {}
        for parent in (sandbox.dsh_home, sandbox.dsh_home / "storages"):
            try:
                parent_metadata = os.lstat(parent)
            except FileNotFoundError:
                if parent == sandbox.dsh_home:
                    fail()
                return AtomicTreeSnapshot(values, inodes, residues)
            except OSError:
                fail()
            if (
                stat.S_ISLNK(parent_metadata.st_mode)
                or not stat.S_ISDIR(parent_metadata.st_mode)
            ):
                fail()
        try:
            task_metadata = os.lstat(sandbox.task_directory)
        except FileNotFoundError:
            return AtomicTreeSnapshot(values, inodes, residues)
        except OSError:
            fail()
        if stat.S_ISLNK(task_metadata.st_mode) or not stat.S_ISDIR(task_metadata.st_mode):
            fail()
        try:
            children = list(sandbox.task_directory.iterdir())
        except OSError:
            fail()
        for path in children:
            try:
                before = os.lstat(path)
            except OSError:
                fail()
            if (
                stat.S_ISLNK(before.st_mode)
                or not stat.S_ISREG(before.st_mode)
                or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1
                or before.st_uid != os.getuid()
                or before.st_gid != os.getgid()
            ):
                fail()
            maximum = (
                MAX_ARTIFACT_BYTES
                if str(path) == str(sandbox.inbox) or str(path) not in canonical_by_path
                else MAX_STATE_BYTES
            )
            value = read_regular(path, maximum, mode=0o600)
            try:
                after = os.lstat(path)
            except OSError:
                fail()
            stable_fields = (
                "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
                "st_size", "st_mtime_ns", "st_ctime_ns",
            )
            if any(
                getattr(before, field) != getattr(after, field)
                for field in stable_fields
            ):
                fail()
            assert_artifact_redacted(value)
            role = canonical_by_path.get(str(path))
            if role is not None:
                if role != "mirror":
                    try:
                        parsed = json.loads(value)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        fail()
                    if not isinstance(parsed, dict):
                        fail()
                values[role] = value
                inodes[role] = (after.st_dev, after.st_ino)
                continue
            residues[str(path)] = AtomicFileSnapshot(
                path=str(path),
                dev=after.st_dev,
                ino=after.st_ino,
                uid=after.st_uid,
                gid=after.st_gid,
                mtime_ns=after.st_mtime_ns,
                ctime_ns=after.st_ctime_ns,
                length=len(value),
                sha256=sha256_bytes(value),
            )
        return AtomicTreeSnapshot(values, inodes, residues)

    def loose_artifacts(self, sandbox: ProbeSandbox) -> dict[str, bytes]:
        return self.partial_atomic_snapshot(sandbox).canonical_values

    @staticmethod
    def artifact_inodes(sandbox: ProbeSandbox) -> dict[str, tuple[int, int]]:
        values: dict[str, tuple[int, int]] = {}
        for role, path in ContractProbe.artifact_paths(sandbox).items():
            try:
                metadata = os.lstat(path)
            except OSError:
                fail()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                fail()
            values[role] = (metadata.st_dev, metadata.st_ino)
        return values

    @staticmethod
    def validate_token_trace(events: list[dict[str, object]]) -> None:
        token_events = [event for event in events if str(event.get("type", "")).startswith("token-")]
        if any(
            event.get("type") in {
                "token-alternate-read", "token-unsafe-high-level-open"
            }
            for event in token_events
        ):
            fail()
        if not token_events:
            fail()
        stable_fields = (
            "dev", "ino", "kind", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"
        )
        required_flags = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        open_positions: dict[int, int] = {}
        for event_position, event in enumerate(events):
            event_type = event.get("type")
            descriptor = event.get("descriptor")
            if event_type == "token-open":
                if not isinstance(descriptor, int) or descriptor in open_positions:
                    fail()
                open_positions[descriptor] = event_position
            elif event_type == "token-close":
                if not isinstance(descriptor, int) or descriptor not in open_positions:
                    fail()
                opened = open_positions.pop(descriptor)
                if any(
                    candidate.get("type") in {"rename-boundary", "rename"}
                    for candidate in events[opened + 1 : event_position]
                ):
                    fail()
        if open_positions:
            fail()
        position = 0
        while position < len(token_events):
            lstat_event: dict[str, object] | None = None
            if token_events[position].get("type") == "token-lstat":
                lstat_event = token_events[position]
                position += 1
            if position >= len(token_events) or token_events[position].get("type") != "token-open":
                fail()
            open_event = token_events[position]
            descriptor = open_event.get("descriptor")
            if not isinstance(descriptor, int) or descriptor < 0:
                fail()
            position += 1
            cycle: list[dict[str, object]] = []
            while position < len(token_events) and token_events[position].get("type") != "token-close":
                cycle.append(token_events[position])
                position += 1
            if position >= len(token_events):
                fail()
            close_event = token_events[position]
            position += 1
            if (
                close_event.get("descriptor") != descriptor
                or any(
                    event.get("type") not in {"token-fstat", "token-read"}
                    or event.get("descriptor") != descriptor
                    for event in cycle
                )
            ):
                fail()
            event_types = [event.get("type") for event in cycle]
            fstat_events = [event for event in cycle if event.get("type") == "token-fstat"]
            read_events = [event for event in cycle if event.get("type") == "token-read"]
            if len(fstat_events) < 2 or not read_events:
                fail()
            expected = tuple(open_event.get(field) for field in stable_fields)
            if (
                expected[2] != "file"
                or expected[3] != 0o600
                or expected[4] != 1
                or any(
                    tuple(event.get(field) for field in stable_fields) != expected
                    for event in fstat_events
                )
                or (
                    lstat_event is not None
                    and tuple(lstat_event.get(field) for field in stable_fields) != expected
                )
            ):
                fail()
            flags = open_event.get("flags")
            if (
                not isinstance(flags, int)
                or flags & os.O_ACCMODE != os.O_RDONLY
                or required_flags == 0
                or flags & required_flags != required_flags
            ):
                fail()
            first_fstat = event_types.index("token-fstat")
            last_fstat = len(event_types) - 1 - event_types[::-1].index("token-fstat")
            read_positions = [index for index, name in enumerate(event_types) if name == "token-read"]
            if min(read_positions) <= first_fstat or max(read_positions) >= last_fstat:
                fail()
            lengths = [event.get("length") for event in read_events]
            offsets = [
                (event.get("offsetBefore"), event.get("offsetAfter"))
                for event in read_events
            ]
            if (
                any(not isinstance(length, int) or length < 0 for length in lengths)
                or sum(lengths) != expected[7]
                or any(
                    not isinstance(before, int)
                    or not isinstance(after, int)
                    or after != before + length
                    for (before, after), length in zip(offsets, lengths, strict=True)
                )
                or offsets[0][0] != 0
                or offsets[-1][1] != expected[7]
                or any(
                    previous_after != next_before
                    for (_previous_before, previous_after), (next_before, _next_after)
                    in zip(offsets, offsets[1:])
                )
            ):
                fail()

    @staticmethod
    def validate_crash_token_trace(
        events: list[dict[str, object]],
        request_records: tuple[RequestRecord, ...],
    ) -> None:
        token_events = [
            event
            for event in events
            if str(event.get("type", "")).startswith("token-")
        ]
        lstat_only = bool(token_events) and all(
            event.get("type") == "token-lstat" for event in token_events
        )
        if lstat_only and not request_records:
            stable_fields = (
                "dev", "ino", "kind", "mode", "nlink", "uid", "gid",
                "size", "mtimeNs", "ctimeNs",
            )
            expected = tuple(token_events[0].get(field) for field in stable_fields)
            if (
                expected[2] != "file"
                or expected[3] != 0o600
                or expected[4] != 1
                or any(
                    tuple(event.get(field) for field in stable_fields) != expected
                    for event in token_events[1:]
                )
            ):
                fail()
            return
        if request_records or token_events:
            ContractProbe.validate_token_trace(events)

    @staticmethod
    def validate_trace_mutation_scope(
        sandbox: ProbeSandbox,
        events: list[dict[str, object]],
    ) -> None:
        task_path = str(sandbox.task_directory)
        required_create_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        for event in events:
            event_type = event.get("type")
            if event_type == "create":
                flags = event.get("flags")
                path = event.get("path")
                if (
                    event.get("mechanism") != "os.open"
                    or not isinstance(path, str)
                    or str(Path(path).parent) != task_path
                    or not isinstance(flags, int)
                    or required_create_flags == 0
                    or flags & required_create_flags != required_create_flags
                    or flags & os.O_ACCMODE != os.O_WRONLY
                    or event.get("createOnly") is not True
                    or event.get("mode") != 0o600
                    or event.get("requestedMode") != 0o600
                    or not isinstance(event.get("dev"), int)
                    or not isinstance(event.get("ino"), int)
                ):
                    fail()
                continue
            if event_type == "path-remove":
                path = event.get("path")
                if (
                    not isinstance(path, str)
                    or str(Path(path).parent) != task_path
                    or event.get("operation") not in {"os.unlink", "os.remove"}
                    or event.get("blocked") is not False
                ):
                    fail()

    def validate_rename_trace_contract(
        self,
        sandbox: ProbeSandbox,
        events: list[dict[str, object]],
        *,
        crashed: bool,
    ) -> list[tuple[int, dict[str, object]]]:
        self.validate_trace_mutation_scope(sandbox, events)
        task_path = str(sandbox.task_directory)
        boundaries = [
            (position, event)
            for position, event in enumerate(events)
            if event.get("type") == "rename-boundary"
        ]
        renames = [
            (position, event)
            for position, event in enumerate(events)
            if event.get("type") == "rename"
        ]
        if not boundaries or len(boundaries) > MAX_RENAMES:
            fail()
        if [event.get("index") for _position, event in boundaries] != list(
            range(1, len(boundaries) + 1)
        ):
            fail()
        if [event.get("index") for _position, event in renames] != list(
            range(1, len(renames) + 1)
        ):
            fail()
        if not crashed and len(boundaries) != len(renames):
            fail()
        if crashed and len(boundaries) not in {len(renames), len(renames) + 1}:
            fail()

        lineage: dict[tuple[object, object, str], int] = {}
        task_created_inodes: set[tuple[object, object]] = set()
        pending: dict[int, tuple[dict[str, object], dict[str, object]]] = {}

        for position, event in enumerate(events):
            event_type = event.get("type")
            if event_type == "create":
                path = event.get("path")
                task_created_inodes.add((event["dev"], event["ino"]))
                lineage[(event["dev"], event["ino"], str(path))] = position
                continue
            if (
                event_type == "fd-handle-open"
                and (event.get("dev"), event.get("ino")) in task_created_inodes
                ):
                fail()
            if event_type == "rename-boundary":
                source = event.get("sourceBefore")
                destination = event.get("destinationBefore")
                if not isinstance(source, dict) or not isinstance(destination, dict):
                    fail()
                source_path = source.get("path")
                destination_path = destination.get("path")
                if (
                    source.get("exists") is not True
                    or source.get("kind") != "file"
                    or source.get("mode") != 0o600
                    or source.get("nlink") != 1
                    or source.get("uid") != os.getuid()
                    or source.get("gid") != os.getgid()
                    or not isinstance(source_path, str)
                    or not isinstance(destination_path, str)
                    or str(Path(source_path).parent) != task_path
                    or str(Path(destination_path).parent) != task_path
                    or (
                        destination.get("exists") is True
                        and (
                            destination.get("kind") != "file"
                            or destination.get("mode") != 0o600
                        )
                    )
                ):
                    fail()
                identity_path = (source.get("dev"), source.get("ino"), source_path)
                create_position = lineage.get(identity_path)
                if create_position is None or create_position >= position:
                    fail()
                self.validate_fresh_staged_file(
                    events,
                    source,
                    create_position=create_position,
                    before_position=position,
                )
                index = event.get("index")
                if not isinstance(index, int) or index in pending:
                    fail()
                pending[index] = (source, destination)
                continue
            if event_type == "rename":
                index = event.get("index")
                if not isinstance(index, int) or index not in pending:
                    fail()
                source, destination = pending.pop(index)
                after = event.get("destinationAfter")
                if (
                    event.get("sourceBefore") != source
                    or event.get("destinationBefore") != destination
                    or not isinstance(after, dict)
                    or after.get("exists") is not True
                    or after.get("path") != destination.get("path")
                    or after.get("kind") != "file"
                    or after.get("mode") != 0o600
                    or (after.get("dev"), after.get("ino"))
                    != (source.get("dev"), source.get("ino"))
                    or after.get("sha256") != source.get("sha256")
                ):
                    fail()
                source_path = str(source["path"])
                destination_path = str(after["path"])
                create_position = lineage.pop(
                    (source.get("dev"), source.get("ino"), source_path),
                    None,
                )
                if create_position is None:
                    fail()
                lineage[
                    (after.get("dev"), after.get("ino"), destination_path)
                ] = create_position

        if pending:
            if (
                not crashed
                or len(pending) != 1
                or next(reversed(pending)) != len(boundaries)
                or boundaries[-1][1].get("crash") is not True
            ):
                fail()
        return renames

    @staticmethod
    def validate_fresh_staged_file(
        events: list[dict[str, object]],
        source: dict[str, object],
        *,
        create_position: int,
        before_position: int,
    ) -> None:
        if not 0 <= create_position < before_position <= len(events):
            fail()
        create = events[create_position]
        if (
            create.get("type") != "create"
            or (create.get("dev"), create.get("ino"))
            != (source.get("dev"), source.get("ino"))
        ):
            fail()
        mutations = [
            (position, event)
            for position, event in enumerate(events)
            if create_position < position < before_position
            and event.get("type") == "fd-write"
            and (event.get("dev"), event.get("ino"))
            == (source.get("dev"), source.get("ino"))
        ]
        expected_offset = 0
        for _position, mutation in mutations:
            result = mutation.get("result")
            if (
                mutation.get("operation") != "os.write"
                or not isinstance(result, int)
                or result < 0
                or mutation.get("offsetBefore") != expected_offset
                or mutation.get("offsetAfter") != expected_offset + result
            ):
                fail()
            expected_offset += result
        if expected_offset != source.get("length"):
            fail()
        last_mutation = mutations[-1][0] if mutations else create_position
        fsync_positions = [
            position
            for position, event in enumerate(events)
            if last_mutation < position < before_position
            and event.get("type") == "fsync"
            and event.get("kind") == "file"
            and (event.get("dev"), event.get("ino"))
            == (source.get("dev"), source.get("ino"))
            and event.get("sha256") == source.get("sha256")
            and event.get("length") == source.get("length")
        ]
        if not fsync_positions:
            fail()
        last_fsync = fsync_positions[-1]
        if any(
            create_position < position < before_position
            and event.get("type") == "fd-handle-open"
            and (event.get("dev"), event.get("ino"))
            == (source.get("dev"), source.get("ino"))
            for position, event in enumerate(events)
        ):
            fail()
        if not any(
            last_fsync < position < before_position
            and event.get("type") == "fd-close"
            and (event.get("dev"), event.get("ino"))
            == (source.get("dev"), source.get("ino"))
            for position, event in enumerate(events)
        ):
            fail()

    def validate_success_trace(
        self,
        sandbox: ProbeSandbox,
        events: list[dict[str, object]],
        before_values: dict[str, bytes],
        before_inodes: dict[str, tuple[int, int]],
        after_values: dict[str, bytes],
        after_inodes: dict[str, tuple[int, int]],
        required_roles: set[str],
        allowed_preexisting_removals: dict[str, dict[str, object]] | None = None,
    ) -> int:
        if not required_roles.issubset({"mirror", "state", "fingerprint"}):
            fail()
        if set(before_values) != set(before_inodes) or not set(before_values).issubset(
            {"mirror", "state", "fingerprint"}
        ):
            fail()
        paths = {role: str(path) for role, path in self.artifact_paths(sandbox).items()}
        positioned_renames = self.validate_rename_trace_contract(
            sandbox, events, crashed=False
        )
        renames = [event for _position, event in positioned_renames]
        if any(event.get("crash") is not False for event in renames):
            fail()
        canonical_paths = set(paths.values())
        transition_source_paths: set[str] = set()
        for event in renames:
            source = event.get("sourceBefore")
            if isinstance(source, dict) and isinstance(source.get("path"), str):
                transition_source_paths.add(source["path"])
        protected_transition_paths = canonical_paths | transition_source_paths
        allowed_removals = allowed_preexisting_removals or {}
        for event in events:
            path = event.get("path")
            if (
                event.get("type") == "path-remove"
                and isinstance(path, str)
                and any(
                    path_is_same_or_parent(path, protected)
                    for protected in protected_transition_paths
                )
                and not benign_missing_transition_remove(
                    event, canonical_paths, transition_source_paths
                )
                and not (
                    isinstance(path, str)
                    and path in allowed_removals
                    and event.get("operation") in {"os.unlink", "os.remove"}
                    and event.get("blocked") is False
                    and event.get("before") == allowed_removals[path]
                )
            ):
                fail()
        try:
            task_metadata = os.lstat(sandbox.task_directory)
        except OSError:
            fail()
        last_canonical_rename = -1
        for role, path in paths.items():
            matching: list[tuple[int, dict[str, object]]] = []
            for position, event in enumerate(events):
                if event.get("type") != "rename":
                    continue
                after = event.get("destinationAfter")
                source = event.get("sourceBefore")
                if not isinstance(after, dict) or not isinstance(source, dict):
                    fail()
                if after.get("path") == path:
                    matching.append((position, event))
            if not matching:
                if (
                    role in required_roles
                    or role not in before_inodes
                    or after_inodes[role] != before_inodes[role]
                    or after_values[role] != before_values[role]
                ):
                    fail()
                continue
            if role in before_inodes:
                expected_before_hash = sha256_bytes(before_values[role])
                predecessor: dict[str, object] = {
                    "exists": True,
                    "path": path,
                    "dev": before_inodes[role][0],
                    "ino": before_inodes[role][1],
                    "mode": 0o600,
                    "kind": "file",
                    "length": len(before_values[role]),
                    "sha256": expected_before_hash,
                }
            else:
                predecessor = {"exists": False, "path": path}
            for position, event in matching:
                last_canonical_rename = max(last_canonical_rename, position)
                source = event.get("sourceBefore")
                destination_before = event.get("destinationBefore")
                after = event.get("destinationAfter")
                if (
                    not isinstance(source, dict)
                    or not isinstance(destination_before, dict)
                    or not isinstance(after, dict)
                ):
                    fail()
                source_identity = (source.get("dev"), source.get("ino"))
                source_hash = source.get("sha256")
                source_path = source.get("path")
                predecessor_identity = (
                    predecessor.get("dev"), predecessor.get("ino")
                )
                if (
                    destination_before != predecessor
                    or source.get("exists") is not True
                    or not isinstance(source.get("path"), str)
                    or source.get("path") not in transition_source_paths
                    or source.get("kind") != "file"
                    or source.get("mode") != 0o600
                    or source.get("nlink") != 1
                    or source.get("uid") != os.getuid()
                    or source.get("gid") != os.getgid()
                    or not isinstance(source_path, str)
                    or str(Path(source_path).parent) != str(sandbox.task_directory)
                    or not isinstance(source_hash, str)
                    or after.get("exists") is not True
                    or after.get("path") != path
                    or after.get("kind") != "file"
                    or after.get("mode") != 0o600
                    or after.get("sha256") != source_hash
                    or after.get("length") != source.get("length")
                    or source_identity != (after.get("dev"), after.get("ino"))
                    or (
                        predecessor.get("exists") is True
                        and source_identity == predecessor_identity
                    )
                ):
                    fail()
                predecessor = after
            expected_hash = sha256_bytes(after_values[role])
            if (
                predecessor.get("sha256") != expected_hash
                or predecessor.get("length") != len(after_values[role])
                or (predecessor.get("dev"), predecessor.get("ino"))
                != after_inodes[role]
            ):
                fail()
        last_durable_change = max(
            [position for position, _event in positioned_renames]
            + [
                position
                for position, event in enumerate(events)
                if event.get("type") == "path-remove"
                and isinstance(event.get("before"), dict)
                and event["before"].get("exists") is True
            ]
        )
        directory_fsync_after_renames = any(
            position > max(last_canonical_rename, last_durable_change)
            and event.get("type") == "fsync"
            and event.get("kind") == "dir"
            and (event.get("dev"), event.get("ino")) == (task_metadata.st_dev, task_metadata.st_ino)
            for position, event in enumerate(events)
        )
        if not directory_fsync_after_renames:
            fail()
        return len(renames) * RENAME_FAILPOINTS_PER_RENAME

    def validate_recovery_path_events(
        self,
        sandbox: ProbeSandbox,
        before: AtomicTreeSnapshot,
        events: list[dict[str, object]],
        *,
        complete: bool = True,
    ) -> dict[str, dict[str, object]]:
        task_path = str(sandbox.task_directory)
        canonical_paths = {
            str(path) for path in self.artifact_paths(sandbox).values()
        }
        allowed_removals = {
            path: snapshot.trace_value()
            for path, snapshot in before.residues.items()
        }
        required_create_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        lineage_positions: dict[tuple[str, object, object], int] = {}
        removal_create_positions: dict[int, int] = {}
        for position, event in enumerate(events):
            if (
                event.get("type") == "create"
                and event.get("mechanism") == "os.open"
                and event.get("createOnly") is True
                and event.get("mode") == 0o600
                and event.get("requestedMode") == 0o600
                and isinstance(event.get("path"), str)
                and str(Path(str(event["path"])).parent) == task_path
                and isinstance(event.get("flags"), int)
                and event["flags"] & required_create_flags
                == required_create_flags
                and event["flags"] & os.O_ACCMODE == os.O_WRONLY
            ):
                lineage_positions[
                    (str(event["path"]), event.get("dev"), event.get("ino"))
                ] = position
                continue
            if event.get("type") == "rename":
                source = event.get("sourceBefore")
                destination = event.get("destinationAfter")
                if not isinstance(source, dict) or not isinstance(destination, dict):
                    fail()
                source_path = source.get("path")
                destination_path = destination.get("path")
                if not isinstance(source_path, str) or not isinstance(destination_path, str):
                    fail()
                create_position = lineage_positions.pop(
                    (source_path, source.get("dev"), source.get("ino")),
                    None,
                )
                if create_position is not None:
                    lineage_positions[
                        (
                            destination_path,
                            destination.get("dev"),
                            destination.get("ino"),
                        )
                    ] = create_position
                continue
            if event.get("type") == "path-remove":
                removed = event.get("before")
                path = event.get("path")
                if isinstance(removed, dict) and isinstance(path, str):
                    identity = (path, removed.get("dev"), removed.get("ino"))
                    create_position = lineage_positions.pop(identity, None)
                    if create_position is not None:
                        removal_create_positions[position] = create_position

        removed_residues: set[str] = set()
        last_existing_remove = -1
        for position, event in enumerate(events):
            event_type = event.get("type")
            if event_type in {"rename-boundary", "rename"}:
                source = event.get("sourceBefore")
                destination = (
                    event.get("destinationBefore")
                    if event_type == "rename-boundary"
                    else event.get("destinationAfter")
                )
                if not isinstance(source, dict) or not isinstance(destination, dict):
                    fail()
                source_path = source.get("path")
                destination_path = destination.get("path")
                if (
                    not isinstance(source_path, str)
                    or not isinstance(destination_path, str)
                    or str(Path(source_path).parent) != task_path
                    or str(Path(destination_path).parent) != task_path
                    or source_path in before.residues
                    or destination_path in before.residues
                ):
                    fail()
                continue
            if event_type != "path-remove":
                continue
            path = event.get("path")
            removed = event.get("before")
            if (
                not isinstance(path, str)
                or str(Path(path).parent) != task_path
                or path in canonical_paths
                or event.get("operation") not in {"os.unlink", "os.remove"}
                or event.get("blocked") is not False
                or not isinstance(removed, dict)
            ):
                fail()
            if removed.get("exists") is False:
                continue
            expected_residue = allowed_removals.get(path)
            if expected_residue is not None and removed == expected_residue:
                removed_residues.add(path)
                last_existing_remove = position
                continue
            create_position = removal_create_positions.get(position)
            if (
                removed.get("exists") is not True
                or removed.get("kind") != "file"
                or removed.get("mode") != 0o600
                or create_position is None
                or create_position >= position
            ):
                fail()
            self.validate_fresh_staged_file(
                events,
                removed,
                create_position=create_position,
                before_position=position,
            )
            last_existing_remove = position

        if complete and removed_residues != set(before.residues):
            fail()
        if complete and last_existing_remove >= 0:
            try:
                task_metadata = os.lstat(sandbox.task_directory)
            except OSError:
                fail()
            if not any(
                position > last_existing_remove
                and event.get("type") == "fsync"
                and event.get("kind") == "dir"
                and (event.get("dev"), event.get("ino"))
                == (task_metadata.st_dev, task_metadata.st_ino)
                for position, event in enumerate(events)
            ):
                fail()
        return allowed_removals

    def validate_no_canonical_transition(
        self,
        sandbox: ProbeSandbox,
        events: list[dict[str, object]],
    ) -> None:
        canonical_paths = {
            str(path) for path in self.artifact_paths(sandbox).values()
        }
        for event in events:
            if event.get("type") in {"rename-boundary", "rename"}:
                for key in ("sourceBefore", "destinationBefore", "destinationAfter"):
                    value = event.get(key)
                    if isinstance(value, dict) and value.get("path") in canonical_paths:
                        fail()
            if (
                event.get("type") == "path-remove"
                and isinstance(event.get("path"), str)
                and any(
                    path_is_same_or_parent(str(event["path"]), canonical)
                    or path_is_same_or_parent(canonical, str(event["path"]))
                    for canonical in canonical_paths
                )
            ):
                fail()

    def traced_atomic_transition(
        self,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        arguments: list[str],
        *,
        expected_mirror: str,
        input_text: str | None = None,
        token_forbidden: bool = False,
        require_recovery_fsync: bool = False,
    ) -> AtomicTransition:
        before = self.partial_atomic_snapshot(sandbox)
        token_accessed: threading.Event | None = None
        if token_forbidden:
            with sandbox.reject_token_access() as token_accessed:
                result, events = self.traced_command(
                    sandbox,
                    notion.api_base,
                    arguments,
                    input_text=input_text,
                )
        else:
            result, events = self.traced_command(
                sandbox,
                notion.api_base,
                arguments,
                input_text=input_text,
            )
        self.validate_trace_mutation_scope(sandbox, events)
        records = notion.state.snapshot()
        token_events = [
            event
            for event in events
            if str(event.get("type", "")).startswith("token-")
        ]
        if token_forbidden:
            if (
                token_events
                or records
                or token_accessed is None
                or token_accessed.is_set()
            ):
                fail()
        else:
            self.validate_crash_token_trace(events, records)
        after_values = sandbox.read_artifacts(expected_mirror)
        after_inodes = self.artifact_inodes(sandbox)
        allowed_removals = self.validate_recovery_path_events(
            sandbox, before, events
        )
        if require_recovery_fsync:
            try:
                task_metadata = os.lstat(sandbox.task_directory)
            except OSError:
                fail()
            if not any(
                event.get("type") == "fsync"
                and event.get("kind") == "dir"
                and (event.get("dev"), event.get("ino"))
                == (task_metadata.st_dev, task_metadata.st_ino)
                for event in events
            ):
                fail()
        changed_roles = {
            role
            for role in after_values
            if role not in before.canonical_values
            or before.canonical_values[role] != after_values[role]
        }
        if any(
            role not in changed_roles
            and before.canonical_inodes[role] != after_inodes[role]
            for role in before.canonical_inodes
        ):
            fail()
        if changed_roles:
            failpoints = self.validate_success_trace(
                sandbox,
                events,
                before.canonical_values,
                before.canonical_inodes,
                after_values,
                after_inodes,
                changed_roles,
                allowed_removals,
            )
        else:
            self.validate_no_canonical_transition(sandbox, events)
            rename_markers = [
                event
                for event in events
                if event.get("type") in {"rename-boundary", "rename"}
            ]
            if rename_markers:
                positioned_renames = self.validate_rename_trace_contract(
                    sandbox, events, crashed=False
                )
                failpoints = (
                    len(positioned_renames) * RENAME_FAILPOINTS_PER_RENAME
                )
            else:
                failpoints = 0
        return AtomicTransition(
            result=result,
            events=events,
            values=after_values,
            inodes=after_inodes,
            failpoints=failpoints,
        )

    def validate_recovery_crash_artifacts(
        self,
        sandbox: ProbeSandbox,
        before: AtomicTreeSnapshot,
        events: list[dict[str, object]],
    ) -> None:
        self.validate_rename_trace_contract(sandbox, events, crashed=True)
        paths = {
            role: str(path) for role, path in self.artifact_paths(sandbox).items()
        }
        current: dict[str, dict[str, object]] = {}
        for role, path in paths.items():
            if role not in before.canonical_values:
                current[role] = {"exists": False, "path": path}
                continue
            inode = before.canonical_inodes[role]
            value = before.canonical_values[role]
            current[role] = {
                "exists": True,
                "path": path,
                "dev": inode[0],
                "ino": inode[1],
                "mode": 0o600,
                "kind": "file",
                "length": len(value),
                "sha256": sha256_bytes(value),
            }
        renames = {
            event.get("index"): event
            for event in events
            if event.get("type") == "rename"
        }
        if len(renames) != sum(
            event.get("type") == "rename" for event in events
        ):
            fail()
        for position, boundary in enumerate(events):
            if boundary.get("type") != "rename-boundary":
                continue
            source = boundary.get("sourceBefore")
            destination_before = boundary.get("destinationBefore")
            if not isinstance(source, dict) or not isinstance(destination_before, dict):
                fail()
            matching = [
                role
                for role, path in paths.items()
                if destination_before.get("path") == path
            ]
            actual = renames.get(boundary.get("index"))
            if not matching:
                continue
            if len(matching) != 1:
                fail()
            role = matching[0]
            if destination_before != current[role]:
                fail()
            if actual is None:
                if boundary.get("crash") is not True:
                    fail()
                continue
            after = actual.get("destinationAfter")
            if (
                actual.get("sourceBefore") != source
                or actual.get("destinationBefore") != destination_before
                or not isinstance(after, dict)
                or after.get("exists") is not True
                or after.get("path") != paths[role]
                or after.get("kind") != "file"
                or after.get("mode") != 0o600
                or after.get("sha256") != source.get("sha256")
                or (after.get("dev"), after.get("ino"))
                != (source.get("dev"), source.get("ino"))
            ):
                fail()
            current[role] = after

        self.validate_recovery_path_events(
            sandbox, before, events, complete=False
        )
        observed = self.partial_atomic_snapshot(sandbox)
        for role, expected in current.items():
            if expected.get("exists") is False:
                if role in observed.canonical_values:
                    fail()
                continue
            if role not in observed.canonical_values:
                fail()
            if (
                sha256_bytes(observed.canonical_values[role])
                != expected.get("sha256")
                or observed.canonical_inodes[role]
                != (expected.get("dev"), expected.get("ino"))
            ):
                fail()

        required_create_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        for path, residue in observed.residues.items():
            previous = before.residues.get(path)
            if previous == residue:
                continue
            create_positions = [
                position
                for position, event in enumerate(events)
                if event.get("type") == "create"
                and event.get("mechanism") == "os.open"
                and event.get("path") == path
                and (event.get("dev"), event.get("ino"))
                == (residue.dev, residue.ino)
                and event.get("mode") == 0o600
                and event.get("requestedMode") == 0o600
                and isinstance(event.get("flags"), int)
                and event["flags"] & required_create_flags
                == required_create_flags
                and event["flags"] & os.O_ACCMODE == os.O_WRONLY
            ]
            if len(create_positions) != 1:
                fail()
            self.validate_fresh_staged_file(
                events,
                {
                    "dev": residue.dev,
                    "ino": residue.ino,
                    "length": residue.length,
                    "sha256": residue.sha256,
                    "mtimeNs": residue.mtime_ns,
                    "ctimeNs": residue.ctime_ns,
                },
                create_position=create_positions[0],
                before_position=len(events),
            )

    def traced_atomic_recovery_crash(
        self,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        arguments: list[str],
        *,
        fail_index: int,
        input_text: str | None = None,
    ) -> None:
        before = self.partial_atomic_snapshot(sandbox)
        result, events = self.traced_command(
            sandbox,
            notion.api_base,
            arguments,
            input_text=input_text,
            fail_index=fail_index,
        )
        self.validate_injected_crash(result, events, fail_index)
        self.validate_crash_token_trace(events, notion.state.snapshot())
        self.validate_recovery_crash_artifacts(sandbox, before, events)

    def validate_crash_artifacts(
        self,
        sandbox: ProbeSandbox,
        baseline: dict[str, bytes],
        events: list[dict[str, object]],
    ) -> None:
        self.validate_rename_trace_contract(sandbox, events, crashed=True)
        paths = {role: str(path) for role, path in self.artifact_paths(sandbox).items()}
        allowed = {role: {sha256_bytes(value)} for role, value in baseline.items()}
        current = {role: sha256_bytes(value) for role, value in baseline.items()}
        renames = {
            event.get("index"): event for event in events if event.get("type") == "rename"
        }
        if len(renames) != sum(event.get("type") == "rename" for event in events):
            fail()
        canonical_paths = set(paths.values())
        transition_source_paths: set[str] = set()
        for boundary_position, boundary in (
            (position, event)
            for position, event in enumerate(events)
            if event.get("type") == "rename-boundary"
        ):
            source = boundary.get("sourceBefore")
            before = boundary.get("destinationBefore")
            if not isinstance(source, dict) or not isinstance(before, dict):
                fail()
            source_path = source.get("path")
            if isinstance(source_path, str):
                transition_source_paths.add(source_path)
            matching_roles = [role for role, path in paths.items() if before.get("path") == path]
            actual = renames.get(boundary.get("index"))
            if not matching_roles:
                continue
            if len(matching_roles) != 1:
                fail()
            role = matching_roles[0]
            if (
                before.get("kind") != "file"
                or before.get("mode") != 0o600
                or before.get("sha256") != current[role]
                or source.get("kind") != "file"
                or source.get("mode") != 0o600
                or not isinstance(source.get("sha256"), str)
            ):
                fail()
            if actual is None:
                if boundary.get("crash") is not True:
                    fail()
                continue
            after = actual.get("destinationAfter")
            if (
                actual.get("sourceBefore") != source
                or actual.get("destinationBefore") != before
                or not isinstance(after, dict)
                or after.get("path") != paths[role]
                or after.get("kind") != "file"
                or after.get("mode") != 0o600
                or after.get("sha256") != source.get("sha256")
                or (source.get("dev"), source.get("ino"))
                != (after.get("dev"), after.get("ino"))
            ):
                fail()
            current[role] = str(source["sha256"])
            allowed[role].add(current[role])
        protected_transition_paths = canonical_paths | transition_source_paths
        for event in events:
            path = event.get("path")
            if (
                event.get("type") == "path-remove"
                and isinstance(path, str)
                and any(
                    path_is_same_or_parent(path, protected)
                    for protected in protected_transition_paths
                )
                and not benign_missing_transition_remove(
                    event, canonical_paths, transition_source_paths
                )
            ):
                fail()
        observed = self.loose_artifacts(sandbox)
        for role, value in observed.items():
            if sha256_bytes(value) not in allowed[role]:
                fail()

    @staticmethod
    def validate_injected_crash(
        result: CommandResult,
        events: list[dict[str, object]],
        fail_index: int,
    ) -> None:
        markers = [
            event
            for event in events
            if event.get("type") in {"rename-boundary", "rename"}
        ]
        if (
            result.returncode != CRASH_CODE
            or len(markers) != fail_index
            or [event.get("failpointIndex") for event in markers]
            != list(range(1, fail_index + 1))
            or any(event.get("crash") is not False for event in markers[:-1])
            or markers[-1].get("crash") is not True
        ):
            fail()
        for position, marker in enumerate(markers, 1):
            expected_type = "rename-boundary" if position % 2 else "rename"
            expected_index = (position + 1) // 2
            if (
                marker.get("type") != expected_type
                or marker.get("index") != expected_index
                or (
                    expected_type == "rename-boundary"
                    and marker.get("phase") != "before"
                )
            ):
                fail()

    def validate_initial_crash_artifacts(
        self,
        sandbox: ProbeSandbox,
        events: list[dict[str, object]],
    ) -> None:
        self.validate_rename_trace_contract(sandbox, events, crashed=True)
        paths = {role: str(path) for role, path in self.artifact_paths(sandbox).items()}
        current: dict[str, dict[str, object]] = {
            role: {"exists": False, "path": path}
            for role, path in paths.items()
        }
        canonical_paths = set(paths.values())
        transition_source_paths: set[str] = set()
        renames = {
            event.get("index"): event for event in events if event.get("type") == "rename"
        }
        for position, boundary in enumerate(events):
            if boundary.get("type") != "rename-boundary":
                continue
            source = boundary.get("sourceBefore")
            before = boundary.get("destinationBefore")
            if not isinstance(source, dict) or not isinstance(before, dict):
                fail()
            if isinstance(source.get("path"), str):
                transition_source_paths.add(source["path"])
            matching = [role for role, path in paths.items() if before.get("path") == path]
            if not matching:
                continue
            if len(matching) != 1:
                fail()
            role = matching[0]
            if before != current[role]:
                fail()
            actual = renames.get(boundary.get("index"))
            if actual is None:
                if boundary.get("crash") is not True:
                    fail()
                continue
            after = actual.get("destinationAfter")
            if (
                actual.get("sourceBefore") != source
                or actual.get("destinationBefore") != before
                or not isinstance(after, dict)
                or after.get("path") != paths[role]
                or after.get("kind") != "file"
                or after.get("mode") != 0o600
                or after.get("sha256") != source.get("sha256")
                or (source.get("dev"), source.get("ino"))
                != (after.get("dev"), after.get("ino"))
                or not isinstance(source.get("sha256"), str)
            ):
                fail()
            current[role] = after

        protected_transition_paths = canonical_paths | transition_source_paths
        for event in events:
            path = event.get("path")
            if (
                event.get("type") == "path-remove"
                and isinstance(path, str)
                and any(
                    path_is_same_or_parent(path, protected)
                    for protected in protected_transition_paths
                )
                and not benign_missing_transition_remove(
                    event, canonical_paths, transition_source_paths
                )
            ):
                fail()

        observed = self.partial_atomic_snapshot(sandbox)
        for role, expected in current.items():
            if expected.get("exists") is False:
                if role in observed.canonical_values:
                    fail()
                continue
            if (
                role not in observed.canonical_values
                or sha256_bytes(observed.canonical_values[role])
                != expected.get("sha256")
                or observed.canonical_inodes[role]
                != (expected.get("dev"), expected.get("ino"))
            ):
                fail()
        if (
            "mirror" in observed.canonical_values
            and observed.canonical_values["mirror"]
            != REMOTE_INITIAL.encode("utf-8")
        ):
            fail()

    def assert_symlink_artifact_rejected(self, role: str) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            paths = self.artifact_paths(sandbox)
            stages = SYMLINK_PREFLIGHT_STAGES.get(role)
            if role not in paths or stages is None:
                fail()
            canary_directory = sandbox.root / "external-canary"
            canary = canary_directory / f"{role}.txt"
            target = paths[role]
            private_marker = b""
            canary_before: tuple[tuple[int, ...], bytes] | None = None
            symlink_before: tuple[tuple[int, ...], str] | None = None
            tree_before: tuple[tuple[object, ...], ...] | None = None
            result: CommandResult | None = None
            events: list[dict[str, object]] | None = None

            def command() -> None:
                nonlocal private_marker, canary_before, symlink_before
                nonlocal tree_before, result, events
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                canary_directory.mkdir(mode=0o700)
                private_marker = random_private_marker(role)
                write_private_file(canary, private_marker)
                target.symlink_to(canary)
                canary_before = stable_regular_identity(
                    canary, 1024, mode=0o600
                )
                symlink_before = stable_symlink_identity(target)
                tree_before = preflight_tree_identity(sandbox.root)
                notion.state.reset()
                result, events = self.traced_command(
                    sandbox,
                    notion.api_base,
                    ["--pull", "--json"],
                    private_markers=(private_marker,),
                )

            probe_stage(stages["command"], command)

            def outcome() -> None:
                if result is None or events is None or result.returncode == 0:
                    fail()
                self.validate_symlink_preflight_trace(events)
                assert_request_contract(notion, gets=0, patches=0)

            probe_stage(stages["outcome"], outcome)

            def preservation() -> None:
                if (
                    canary_before is None
                    or symlink_before is None
                    or stable_regular_identity(canary, 1024, mode=0o600)
                    != canary_before
                    or stable_symlink_identity(target) != symlink_before
                ):
                    fail()

            probe_stage(stages["preservation"], preservation)

            def residue() -> None:
                if (
                    tree_before is None
                    or preflight_tree_identity(sandbox.root) != tree_before
                ):
                    fail()
                target.unlink()
                canary.unlink()
                canary_directory.rmdir()
                sandbox.assert_no_logs()

            probe_stage(stages["residue"], residue)

    def assert_symlink_token_rejected(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            stages = SYMLINK_PREFLIGHT_STAGES["token"]
            canary = sandbox.root / "external-token-canary"
            private_marker = b""
            canary_before: tuple[tuple[int, ...], bytes] | None = None
            symlink_before: tuple[tuple[int, ...], str] | None = None
            tree_before: tuple[tuple[object, ...], ...] | None = None
            result: CommandResult | None = None
            events: list[dict[str, object]] | None = None

            def command() -> None:
                nonlocal private_marker, canary_before, symlink_before
                nonlocal tree_before, result, events
                private_marker = random_private_marker("token")
                write_private_file(canary, private_marker)
                sandbox.token.unlink()
                sandbox.token.symlink_to(canary)
                canary_before = stable_regular_identity(
                    canary, 1024, mode=0o600
                )
                symlink_before = stable_symlink_identity(sandbox.token)
                tree_before = preflight_tree_identity(sandbox.root)
                notion.state.reset()
                result, events = self.traced_command(
                    sandbox,
                    notion.api_base,
                    ["--pull", "--json"],
                    private_markers=(private_marker,),
                )

            probe_stage(stages["command"], command)

            def outcome() -> None:
                if result is None or events is None or result.returncode == 0:
                    fail()
                self.validate_symlink_preflight_trace(events)
                assert_request_contract(notion, gets=0, patches=0)

            probe_stage(stages["outcome"], outcome)

            def preservation() -> None:
                if (
                    canary_before is None
                    or symlink_before is None
                    or stable_regular_identity(canary, 1024, mode=0o600)
                    != canary_before
                    or stable_symlink_identity(sandbox.token) != symlink_before
                ):
                    fail()

            probe_stage(stages["preservation"], preservation)

            def residue() -> None:
                if (
                    tree_before is None
                    or preflight_tree_identity(sandbox.root) != tree_before
                ):
                    fail()
                sandbox.token.unlink()
                canary.unlink()
                write_private_file(
                    sandbox.token,
                    (FAKE_TOKEN + "\n").encode("utf-8"),
                )
                sandbox.assert_no_logs()

            probe_stage(stages["residue"], residue)

    def first_pull(self, sandbox: ProbeSandbox, notion: LoopbackNotion, body: str = REMOTE_INITIAL) -> None:
        notion.state.body = body
        notion.state.reset()
        result = self.command(sandbox, notion.api_base, ["--pull", "--json"])
        if result.returncode != 0:
            fail()
        parse_status(result, {"synced"})
        sandbox.read_artifacts(body)
        assert_request_contract(notion, gets=1, patches=0)

    def prepare_atomic_scenario(
        self,
        scenario: AtomicScenario,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
    ) -> tuple[dict[str, bytes], dict[str, tuple[int, int]]]:
        self.first_pull(sandbox, notion)
        force_names = {"force-set", "queued-force-set", "pending-retry-force"}
        push_names = {"push", "queued-push", "pending-retry-push"}
        queued_names = {"queued-set", "queued-push", "queued-force-set"}
        pending_names = {"pending-retry", "pending-retry-push", "pending-retry-force"}
        if scenario.name == "pull":
            notion.state.body = REMOTE_EDIT
        elif scenario.name in push_names:
            sandbox.write_local_mirror(LOCAL_EDIT)
            sandbox.read_artifacts(LOCAL_EDIT)
        elif scenario.name in force_names:
            sandbox.write_local_mirror(LOCAL_EDIT)
            sandbox.read_artifacts(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
        elif scenario.name not in {"set", "queued-set", "pending-retry"}:
            fail()

        if scenario.name in queued_names:
            notion.state.fail_patch = True
        if scenario.name in pending_names:
            notion.state.fail_patch = True
            notion.state.reset()
            if scenario.name == "pending-retry":
                queued_arguments = ["--set", "-", "--json"]
                queued_input = SET_EDIT
            elif scenario.name == "pending-retry-push":
                queued_arguments = ["--push", "--json"]
                queued_input = None
            else:
                queued_arguments = ["--set", "-", "--force", "--json"]
                queued_input = FORCE_SET_EDIT
            queued = self.command(
                sandbox,
                notion.api_base,
                queued_arguments,
                input_text=queued_input,
            )
            parse_status(queued, {"queued"})
            sandbox.read_artifacts(scenario.expected_mirror)
            expected_remote = REMOTE_EDIT if scenario.name == "pending-retry-force" else REMOTE_INITIAL
            if notion.state.body != expected_remote:
                fail()
            assert_request_contract(notion, patches=1, patch_body=scenario.patch_body)
            notion.state.fail_patch = False
        notion.state.reset()
        if scenario.name in pending_names:
            before_mirror = scenario.expected_mirror
        elif scenario.name in push_names or scenario.name in force_names:
            before_mirror = LOCAL_EDIT
        else:
            before_mirror = REMOTE_INITIAL
        return sandbox.read_artifacts(before_mirror), self.artifact_inodes(sandbox)

    @staticmethod
    def assert_atomic_request_shape(
        notion: LoopbackNotion,
        scenario: AtomicScenario,
        *,
        complete: bool,
    ) -> None:
        records = notion.state.snapshot()
        if any(not record.valid for record in records):
            fail()
        gets = sum(record.method == "GET" for record in records)
        patches = [record for record in records if record.method == "PATCH"]
        if gets > 1 or len(patches) > 1:
            fail()
        if scenario.patch_body is None:
            if patches or (complete and gets != 1):
                fail()
            return
        if complete and len(patches) != 1:
            fail()
        if patches:
            try:
                value = json.loads(patches[0].request_body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail()
            if value != {
                "type": "replace_content",
                "replace_content": {"new_str": scenario.patch_body},
            }:
                fail()

    @staticmethod
    def assert_atomic_result(result: CommandResult, scenario: AtomicScenario) -> None:
        if scenario.expected_status == "synced" and result.returncode != 0:
            fail()
        parse_status(result, {scenario.expected_status})

    def prepare_and_crash_atomic_scenario(
        self,
        scenario: AtomicScenario,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        fail_index: int,
    ) -> None:
        baseline, _before_inodes = self.prepare_atomic_scenario(
            scenario, sandbox, notion
        )
        crashed, events = self.traced_command(
            sandbox,
            notion.api_base,
            list(scenario.arguments),
            fail_index=fail_index,
            input_text=scenario.input_text,
        )
        self.validate_injected_crash(crashed, events, fail_index)
        self.validate_crash_token_trace(events, notion.state.snapshot())
        self.validate_crash_artifacts(sandbox, baseline, events)
        self.assert_atomic_request_shape(notion, scenario, complete=False)
        initial_remote = (
            REMOTE_EDIT if "force" in scenario.name else REMOTE_INITIAL
        )
        if scenario.expected_status == "queued":
            if notion.state.body != scenario.expected_remote:
                fail()
        elif notion.state.body not in {initial_remote, scenario.expected_remote}:
            fail()

    def recover_crashed_atomic_scenario(
        self,
        scenario: AtomicScenario,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        *,
        crash_kind: str | None = None,
        crash_fail_index: int = 0,
    ) -> AtomicRecovery:
        queued_names = {"queued-set", "queued-push", "queued-force-set"}
        pending_names = {"pending-retry", "pending-retry-push", "pending-retry-force"}
        if crash_kind not in {None, "first", "recovered"}:
            fail()
        if (crash_kind is None) != (crash_fail_index == 0):
            fail()

        def run_transition(
            kind: str,
            arguments: list[str],
            *,
            input_text: str | None = None,
            require_recovery_fsync: bool = False,
        ) -> tuple[AtomicTransition, bool]:
            targeted = crash_kind == kind
            notion.state.reset()
            if targeted:
                self.traced_atomic_recovery_crash(
                    sandbox,
                    notion,
                    arguments,
                    fail_index=crash_fail_index,
                    input_text=input_text,
                )
                notion.state.reset()
            transition = self.traced_atomic_transition(
                sandbox,
                notion,
                arguments,
                expected_mirror=scenario.expected_mirror,
                input_text=input_text,
                require_recovery_fsync=require_recovery_fsync,
            )
            return transition, targeted

        recovered_failpoints = 0
        if scenario.name in queued_names:
            notion.state.fail_patch = True
            queued_transition, first_was_crashed = run_transition(
                "first",
                list(scenario.arguments),
                input_text=scenario.input_text,
                require_recovery_fsync=True,
            )
            queued = queued_transition.result
            first_transition = queued_transition
            parse_status(queued, {"queued"})
            if notion.state.body != scenario.expected_remote:
                fail()
            assert_request_contract(notion, patches=1, patch_body=scenario.patch_body)
            notion.state.fail_patch = False
            recovered_transition, recovered_was_crashed = run_transition(
                "recovered",
                ["--retry-pending", "--json"],
            )
            recovered = recovered_transition.result
            if recovered.returncode != 0:
                fail()
            if recovered.stdout or recovered.stderr:
                parse_status(recovered, {"synced"})
            if recovered_was_crashed:
                self.assert_atomic_request_shape(notion, scenario, complete=False)
            else:
                assert_request_contract(
                    notion, patches=1, patch_body=scenario.patch_body
                )
            recovered_failpoints = recovered_transition.failpoints
        elif scenario.name in pending_names:
            notion.state.fail_patch = False
            recovered_transition, first_was_crashed = run_transition(
                "first",
                ["--retry-pending", "--json"],
                require_recovery_fsync=True,
            )
            recovered = recovered_transition.result
            first_transition = recovered_transition
            if recovered.returncode != 0:
                fail()
            if recovered.stdout or recovered.stderr:
                parse_status(recovered, {"synced"})
            if notion.state.body != scenario.expected_remote:
                fail()
            self.assert_atomic_request_shape(notion, scenario, complete=False)
        else:
            notion.state.fail_patch = False
            recovered_transition, first_was_crashed = run_transition(
                "first",
                list(scenario.arguments),
                input_text=scenario.input_text,
                require_recovery_fsync=True,
            )
            recovered = recovered_transition.result
            first_transition = recovered_transition
            if recovered.returncode != 0:
                fail()
            parse_status(recovered, {"synced"})
            self.assert_atomic_request_shape(
                notion,
                scenario,
                complete=scenario.name == "pull" and not first_was_crashed,
            )
        converged_remote = (
            scenario.patch_body
            if scenario.expected_status == "queued" and scenario.patch_body is not None
            else scenario.expected_remote
        )
        if notion.state.body != converged_remote:
            fail()
        def converge() -> AtomicTransition:
            notion.state.reset()
            transition = self.traced_atomic_transition(
                sandbox,
                notion,
                ["--pull", "--json"],
                expected_mirror=scenario.expected_mirror,
            )
            convergence = transition.result
            if convergence.returncode != 0 or transition.failpoints != 0:
                fail()
            parse_status(convergence, {"synced"})
            assert_request_contract(notion, gets=1, patches=0)
            if notion.state.body != converged_remote:
                fail()
            return transition

        convergence_transition = cast(
            AtomicTransition,
            probe_stage("test-atomic-artifacts-convergence", converge),
        )
        return AtomicRecovery(
            convergence_transition.values,
            first_transition.failpoints,
            recovered_failpoints,
        )

    def assert_atomic_converged(
        self,
        scenario: AtomicScenario,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        recovered_values: dict[str, bytes],
    ) -> None:
        if scenario.name == "pull":
            notion.state.reset()
            repeated_transition = self.traced_atomic_transition(
                sandbox,
                notion,
                list(scenario.arguments),
                expected_mirror=scenario.expected_mirror,
                input_text=scenario.input_text,
            )
            repeated = repeated_transition.result
            if repeated.returncode != 0:
                fail()
            parse_status(repeated, {"synced"})
            if repeated_transition.values != recovered_values:
                fail()
            self.assert_atomic_request_shape(
                notion,
                scenario,
                complete=scenario.name == "pull",
            )

        notion.state.reset()
        no_pending_transition = self.traced_atomic_transition(
            sandbox,
            notion,
            ["--retry-pending", "--json"],
            expected_mirror=scenario.expected_mirror,
            token_forbidden=True,
        )
        no_pending = no_pending_transition.result
        if (
            no_pending.returncode != 0
            or no_pending.stdout != b""
            or no_pending.stderr != b""
        ):
            fail()
        if no_pending_transition.values != recovered_values:
            fail()
        converged_remote = (
            scenario.patch_body
            if scenario.expected_status == "queued" and scenario.patch_body is not None
            else scenario.expected_remote
        )
        if notion.state.body != converged_remote:
            fail()
        assert_request_contract(notion, gets=0, patches=0)

    def prepare_and_crash_initial_pull(
        self,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        fail_index: int,
    ) -> None:
        if sandbox.task_directory.exists():
            fail()
        notion.state.reset()
        crashed, events = self.traced_command(
            sandbox,
            notion.api_base,
            list(INITIAL_PULL_ARGUMENTS),
            fail_index=fail_index,
        )
        self.validate_injected_crash(crashed, events, fail_index)
        request_records = notion.state.snapshot()
        self.validate_crash_token_trace(events, request_records)
        self.validate_initial_crash_artifacts(sandbox, events)
        assert_request_contract(
            notion,
            gets=1 if request_records else 0,
            patches=0,
        )
        if notion.state.body != REMOTE_INITIAL:
            fail()

    def recover_initial_pull(
        self,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
    ) -> AtomicTransition:
        notion.state.reset()
        transition = self.traced_atomic_transition(
            sandbox,
            notion,
            ["--pull", "--json"],
            expected_mirror=REMOTE_INITIAL,
            require_recovery_fsync=True,
        )
        if transition.result.returncode != 0:
            fail()
        parse_status(transition.result, {"synced"})
        assert_request_contract(notion, gets=1, patches=0)
        return transition

    def assert_initial_pull_converged(
        self,
        sandbox: ProbeSandbox,
        notion: LoopbackNotion,
        recovered_values: dict[str, bytes],
    ) -> None:
        notion.state.reset()
        repeated = self.traced_atomic_transition(
            sandbox,
            notion,
            ["--pull", "--json"],
            expected_mirror=REMOTE_INITIAL,
        )
        if repeated.result.returncode != 0:
            fail()
        parse_status(repeated.result, {"synced"})
        if repeated.values != recovered_values:
            fail()
        assert_request_contract(notion, gets=1, patches=0)

        notion.state.reset()
        no_pending = self.traced_atomic_transition(
            sandbox,
            notion,
            ["--retry-pending", "--json"],
            expected_mirror=REMOTE_INITIAL,
            token_forbidden=True,
        )
        if (
            no_pending.result.returncode != 0
            or no_pending.result.stdout
            or no_pending.result.stderr
            or notion.state.snapshot()
            or no_pending.values != recovered_values
        ):
            fail()

    @staticmethod
    def secondary_axis_cases(
        recoveries: list[tuple[int, dict[str, int]]],
    ) -> tuple[tuple[int, str, int], ...]:
        """Bounded axis coverage, deliberately not a Cartesian product.

        Every primary crash state is fully recovered once by the caller.  For
        each real recovery-transition kind, all before/after boundaries are
        injected on the deterministic seed exposing the largest count; every
        other state exposing that kind also gets its first boundary injected.
        This proves the state and boundary axes independently without claiming
        every state-by-boundary combination.
        """
        cases: set[tuple[int, str, int]] = set()
        kinds = sorted(
            {
                kind
                for _seed, counts in recoveries
                for kind, count in counts.items()
                if count > 0
            }
        )
        for kind in kinds:
            candidates = [
                (seed, counts[kind])
                for seed, counts in recoveries
                if counts.get(kind, 0) > 0
            ]
            selected_seed, maximum = min(
                candidates,
                key=lambda value: (-value[1], value[0]),
            )
            cases.update(
                (selected_seed, kind, fail_index)
                for fail_index in range(1, maximum + 1)
            )
            cases.update(
                (seed, kind, 1)
                for seed, _count in candidates
                if seed != selected_seed
            )
        return tuple(sorted(cases))

    def check_initial_pull_atomic(self) -> int:
        def initial_success() -> int:
            with self.sandbox() as sandbox, LoopbackNotion() as notion:
                if sandbox.task_directory.exists():
                    fail()
                notion.state.reset()
                result, events = self.traced_command(
                    sandbox,
                    notion.api_base,
                    list(INITIAL_PULL_ARGUMENTS),
                )
                if result.returncode != 0:
                    fail_command_result(result)
                parse_status(result, {"synced"})
                self.validate_token_trace(events)
                after_values = sandbox.read_artifacts(REMOTE_INITIAL)
                after_inodes = self.artifact_inodes(sandbox)
                failpoints = self.validate_success_trace(
                    sandbox,
                    events,
                    {},
                    {},
                    after_values,
                    after_inodes,
                    set(INITIAL_PULL_REQUIRED_ROLES),
                )
                if failpoints <= 0:
                    fail()
                assert_request_contract(notion, gets=1, patches=0)
                return failpoints

        failpoints = cast(
            int,
            probe_stage(
                "test-atomic-artifacts-initial-success",
                initial_success,
            ),
        )

        primary_recoveries: list[tuple[int, dict[str, int]]] = []
        for fail_index in range(1, failpoints + 1):
            crash_stage = (
                "test-atomic-artifacts-initial-crash-before"
                if fail_index % RENAME_FAILPOINTS_PER_RENAME == 1
                else "test-atomic-artifacts-initial-crash-after"
            )

            def initial_crash_cycle() -> None:
                with self.sandbox() as sandbox, LoopbackNotion() as notion:
                    def initial_crash() -> None:
                        self.prepare_and_crash_initial_pull(
                            sandbox, notion, fail_index
                        )

                    probe_stage(crash_stage, initial_crash)

                    recovered_transition = cast(
                        AtomicTransition,
                        probe_stage(
                            "test-atomic-artifacts-recovery",
                            lambda: self.recover_initial_pull(sandbox, notion),
                        ),
                    )
                    recovered_values = recovered_transition.values
                    primary_recoveries.append(
                        (fail_index, {"first": recovered_transition.failpoints})
                    )

                    probe_stage(
                        "test-atomic-artifacts-convergence",
                        lambda: self.assert_initial_pull_converged(
                            sandbox, notion, recovered_values
                        ),
                    )

            probe_stage(crash_stage, initial_crash_cycle)

        for seed, kind, recovery_fail_index in self.secondary_axis_cases(
            primary_recoveries
        ):
            if kind != "first":
                fail()
            seed_stage = (
                "test-atomic-artifacts-initial-crash-before"
                if seed % RENAME_FAILPOINTS_PER_RENAME == 1
                else "test-atomic-artifacts-initial-crash-after"
            )
            with self.sandbox() as sandbox, LoopbackNotion() as notion:
                probe_stage(
                    seed_stage,
                    lambda: self.prepare_and_crash_initial_pull(
                        sandbox, notion, seed
                    ),
                )

                def secondary_recovery() -> AtomicTransition:
                    notion.state.reset()
                    self.traced_atomic_recovery_crash(
                        sandbox,
                        notion,
                        ["--pull", "--json"],
                        fail_index=recovery_fail_index,
                    )
                    return self.recover_initial_pull(sandbox, notion)

                recovered = cast(
                    AtomicTransition,
                    probe_stage(
                        "test-atomic-artifacts-recovery",
                        secondary_recovery,
                    ),
                )
                probe_stage(
                    "test-atomic-artifacts-convergence",
                    lambda: self.assert_initial_pull_converged(
                        sandbox, notion, recovered.values
                    ),
                )
        return failpoints

    def check_atomic_artifacts(self) -> None:
        def preflight() -> None:
            self.assert_symlink_token_rejected()
            for role in ("mirror", "state", "fingerprint"):
                self.assert_symlink_artifact_rejected(role)

        probe_stage("test-atomic-artifacts-preflight", preflight)

        self.check_initial_pull_atomic()

        failpoints: dict[str, int] = {}
        for scenario in ATOMIC_SCENARIOS:
            def steady_success() -> int:
                with self.sandbox() as sandbox, LoopbackNotion() as notion:
                    before_values, before_inodes = self.prepare_atomic_scenario(
                        scenario,
                        sandbox,
                        notion,
                    )
                    result, events = self.traced_command(
                        sandbox,
                        notion.api_base,
                        list(scenario.arguments),
                        input_text=scenario.input_text,
                    )
                    self.assert_atomic_result(result, scenario)
                    self.validate_token_trace(events)
                    after_values = sandbox.read_artifacts(scenario.expected_mirror)
                    after_inodes = self.artifact_inodes(sandbox)
                    scenario_failpoints = self.validate_success_trace(
                        sandbox,
                        events,
                        before_values,
                        before_inodes,
                        after_values,
                        after_inodes,
                        set(),
                    )
                    if notion.state.body != scenario.expected_remote:
                        fail()
                    self.assert_atomic_request_shape(
                        notion,
                        scenario,
                        complete=True,
                    )
                    return scenario_failpoints

            failpoints[scenario.name] = cast(
                int,
                probe_stage(
                    "test-atomic-artifacts-steady-success",
                    steady_success,
                ),
            )

        for scenario in ATOMIC_SCENARIOS:
            primary_recoveries: list[tuple[int, dict[str, int]]] = []
            for fail_index in range(1, failpoints[scenario.name] + 1):
                crash_stage = (
                    "test-atomic-artifacts-steady-crash-before"
                    if fail_index % RENAME_FAILPOINTS_PER_RENAME == 1
                    else "test-atomic-artifacts-steady-crash-after"
                )

                def steady_crash_cycle() -> None:
                    with self.sandbox() as sandbox, LoopbackNotion() as notion:
                        def steady_crash() -> None:
                            self.prepare_and_crash_atomic_scenario(
                                scenario, sandbox, notion, fail_index
                            )

                        probe_stage(crash_stage, steady_crash)

                        recovered = cast(
                            AtomicRecovery,
                            probe_stage(
                                "test-atomic-artifacts-recovery",
                                lambda: self.recover_crashed_atomic_scenario(
                                    scenario,
                                    sandbox,
                                    notion,
                                ),
                            ),
                        )
                        recovered_values = recovered.values
                        primary_recoveries.append(
                            (
                                fail_index,
                                {
                                    "first": recovered.first_failpoints,
                                    "recovered": recovered.recovered_failpoints,
                                },
                            )
                        )
                        probe_stage(
                            "test-atomic-artifacts-convergence",
                            lambda: self.assert_atomic_converged(
                                scenario,
                                sandbox,
                                notion,
                                recovered_values,
                            ),
                        )

                probe_stage(crash_stage, steady_crash_cycle)

            for seed, kind, recovery_fail_index in self.secondary_axis_cases(
                primary_recoveries
            ):
                seed_stage = (
                    "test-atomic-artifacts-steady-crash-before"
                    if seed % RENAME_FAILPOINTS_PER_RENAME == 1
                    else "test-atomic-artifacts-steady-crash-after"
                )
                with self.sandbox() as sandbox, LoopbackNotion() as notion:
                    probe_stage(
                        seed_stage,
                        lambda: self.prepare_and_crash_atomic_scenario(
                            scenario, sandbox, notion, seed
                        ),
                    )
                    recovered = cast(
                        AtomicRecovery,
                        probe_stage(
                            "test-atomic-artifacts-recovery",
                            lambda: self.recover_crashed_atomic_scenario(
                                scenario,
                                sandbox,
                                notion,
                                crash_kind=kind,
                                crash_fail_index=recovery_fail_index,
                            ),
                        ),
                    )
                    probe_stage(
                        "test-atomic-artifacts-convergence",
                        lambda: self.assert_atomic_converged(
                            scenario,
                            sandbox,
                            notion,
                            recovered.values,
                        ),
                    )

    def check_conflict(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
            notion.state.reset()
            result = self.command(sandbox, notion.api_base, ["--push", "--json"])
            parse_status(result, {"conflict"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != REMOTE_EDIT:
                fail()
            assert_request_contract(notion, gets=1, patches=0)

    def check_first_pull(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)

    def check_force(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
            notion.state.reset()
            conflict = self.command(sandbox, notion.api_base, ["--pull", "--json"])
            parse_status(conflict, {"conflict"})
            sandbox.read_artifacts(LOCAL_EDIT)
            assert_request_contract(notion, gets=1, patches=0)
            notion.state.reset()
            forced = self.command(sandbox, notion.api_base, ["--pull", "--force", "--json"])
            if forced.returncode != 0:
                fail()
            parse_status(forced, {"synced"})
            sandbox.read_artifacts(REMOTE_EDIT)
            assert_request_contract(notion, gets=1, patches=0)

        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
            notion.state.reset()
            conflict = self.command(sandbox, notion.api_base, ["--push", "--json"])
            parse_status(conflict, {"conflict"})
            assert_request_contract(notion, gets=1, patches=0)
            notion.state.reset()
            forced = self.command(sandbox, notion.api_base, ["--push", "--force", "--json"])
            if forced.returncode != 0:
                fail()
            parse_status(forced, {"synced"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != LOCAL_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)

        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
            notion.state.reset()
            conflict = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--json"],
                input_text=FORCE_SET_EDIT,
            )
            parse_status(conflict, {"conflict"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != REMOTE_EDIT:
                fail()
            assert_request_contract(notion, gets=1, patches=0)
            notion.state.reset()
            forced = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--force", "--json"],
                input_text=FORCE_SET_EDIT,
            )
            if forced.returncode != 0:
                fail()
            parse_status(forced, {"synced"})
            sandbox.read_artifacts(FORCE_SET_EDIT)
            if notion.state.body != FORCE_SET_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=FORCE_SET_EDIT)

        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.body = REMOTE_EDIT
            notion.state.fail_patch = True
            notion.state.reset()
            queued = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--force", "--json"],
                input_text=FORCE_SET_EDIT,
            )
            parse_status(queued, {"queued"})
            sandbox.read_artifacts(FORCE_SET_EDIT)
            if notion.state.body != REMOTE_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=FORCE_SET_EDIT)
            notion.state.fail_patch = False
            notion.state.reset()
            retry = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if retry.returncode != 0:
                fail()
            parse_status(retry, {"synced"})
            sandbox.read_artifacts(FORCE_SET_EDIT)
            if notion.state.body != FORCE_SET_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=FORCE_SET_EDIT)

    def check_network_recovery(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            notion.state.body = REMOTE_EDIT
            with closed_loopback_api() as unavailable:
                failure = self.command(sandbox, unavailable, ["--pull", "--json"])
            parse_status(failure, {"stale"})
            sandbox.read_artifacts(REMOTE_INITIAL)
            notion.state.reset()
            recovery = self.command(sandbox, notion.api_base, ["--pull", "--json"])
            if recovery.returncode != 0:
                fail()
            parse_status(recovery, {"synced"})
            sandbox.read_artifacts(REMOTE_EDIT)
            assert_request_contract(notion, gets=1, patches=0)

    def check_no_pending_no_api(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            notion.state.reset()
            with sandbox.reject_token_access() as token_accessed:
                result = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if result.returncode != 0 or result.stdout != b"" or result.stderr != b"":
                fail()
            if token_accessed.is_set():
                fail()
            sandbox.read_artifacts(REMOTE_INITIAL)
            assert_request_contract(notion, gets=0, patches=0)

    def check_pending_retry(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            notion.state.fail_patch = True
            notion.state.reset()
            queued = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--json"],
                input_text=SET_EDIT,
            )
            parse_status(queued, {"queued"})
            sandbox.read_artifacts(SET_EDIT)
            if notion.state.body != REMOTE_INITIAL:
                fail()
            assert_request_contract(notion, patches=1, patch_body=SET_EDIT)
            notion.state.fail_patch = False
            notion.state.reset()
            retry = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if retry.returncode != 0:
                fail()
            parse_status(retry, {"synced"})
            sandbox.read_artifacts(SET_EDIT)
            if notion.state.body != SET_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=SET_EDIT)
            notion.state.reset()
            with sandbox.reject_token_access() as token_accessed:
                empty = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if empty.returncode != 0 or empty.stdout != b"" or empty.stderr != b"":
                fail()
            if token_accessed.is_set():
                fail()
            assert_request_contract(notion, gets=0, patches=0)

        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.fail_patch = True
            notion.state.reset()
            queued = self.command(sandbox, notion.api_base, ["--push", "--json"])
            parse_status(queued, {"queued"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != REMOTE_INITIAL:
                fail()
            assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)
            notion.state.fail_patch = False
            notion.state.reset()
            retry = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if retry.returncode != 0:
                fail()
            parse_status(retry, {"synced"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != LOCAL_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)
            notion.state.reset()
            with sandbox.reject_token_access() as token_accessed:
                empty = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if (
                empty.returncode != 0
                or empty.stdout != b""
                or empty.stderr != b""
                or token_accessed.is_set()
            ):
                fail()
            assert_request_contract(notion, gets=0, patches=0)

    def check_pull_failure_no_pending(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            with closed_loopback_api() as unavailable:
                failure = self.command(sandbox, unavailable, ["--pull", "--json"])
            if failure.returncode == 0:
                fail()
            parse_status(failure, {"error"})
            if sandbox.task_directory.exists() and list(sandbox.task_directory.iterdir()):
                fail()
            sandbox.assert_no_logs()
            notion.state.reset()
            with sandbox.reject_token_access() as token_accessed:
                retry = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
            if retry.returncode != 0 or retry.stdout != b"" or retry.stderr != b"":
                fail()
            if token_accessed.is_set():
                fail()
            assert_request_contract(notion, gets=0, patches=0)

    def check_push(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            sandbox.write_local_mirror(LOCAL_EDIT)
            notion.state.reset()
            result = self.command(sandbox, notion.api_base, ["--push", "--json"])
            if result.returncode != 0:
                fail()
            parse_status(result, {"synced"})
            sandbox.read_artifacts(LOCAL_EDIT)
            if notion.state.body != LOCAL_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)

    def check_read(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            notion.state.body = REMOTE_EDIT
            notion.state.reset()
            result = self.command(sandbox, notion.api_base, ["--pull", "--json"])
            if result.returncode != 0:
                fail()
            parse_status(result, {"synced"})
            artifacts = sandbox.read_artifacts(REMOTE_EDIT)
            if artifacts["mirror"].decode("utf-8") != REMOTE_EDIT:
                fail()
            assert_request_contract(notion, gets=1, patches=0)

    def assert_incomplete_responses_fail_closed(self) -> None:
        for invalid in incomplete_page_responses(REMOTE_EDIT):
            with self.sandbox() as sandbox, LoopbackNotion() as notion:
                self.first_pull(sandbox, notion)
                before = sandbox.read_artifacts(REMOTE_INITIAL)
                notion.state.body = REMOTE_EDIT
                notion.state.get_response_override = invalid
                notion.state.reset()
                result = self.command(sandbox, notion.api_base, ["--pull", "--json"])
                parse_status(result, {"stale", "error"})
                if sandbox.read_artifacts(REMOTE_INITIAL) != before or notion.state.body != REMOTE_EDIT:
                    fail()
                assert_request_contract(notion, gets=1, patches=0)

        for invalid in incomplete_page_responses(LOCAL_EDIT):
            with self.sandbox() as sandbox, LoopbackNotion() as notion:
                self.first_pull(sandbox, notion)
                sandbox.write_local_mirror(LOCAL_EDIT)
                before = sandbox.read_artifacts(LOCAL_EDIT)
                notion.state.patch_response_override = invalid
                notion.state.reset()
                queued = self.command(sandbox, notion.api_base, ["--push", "--json"])
                parse_status(queued, {"queued"})
                after = sandbox.read_artifacts(LOCAL_EDIT)
                if (
                    after["mirror"] != before["mirror"]
                    or after["fingerprint"] != before["fingerprint"]
                    or after["state"] == before["state"]
                    or notion.state.body != REMOTE_INITIAL
                ):
                    fail()
                assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)
                notion.state.patch_response_override = None
                notion.state.reset()
                retry = self.command(sandbox, notion.api_base, ["--retry-pending", "--json"])
                if retry.returncode != 0:
                    fail()
                parse_status(retry, {"synced"})
                sandbox.read_artifacts(LOCAL_EDIT)
                if notion.state.body != LOCAL_EDIT:
                    fail()
                assert_request_contract(notion, patches=1, patch_body=LOCAL_EDIT)

    def check_secret_redaction(self) -> None:
        self.assert_incomplete_responses_fail_closed()
        with (
            self.sandbox() as sandbox,
            LoopbackNotion(SECRET_BODY) as notion,
            LoopbackNotion("synthetic redirect sentinel") as sentinel,
        ):
            self.first_pull(sandbox, notion, SECRET_BODY)
            before_redirect = sandbox.read_artifacts(SECRET_BODY)
            notion.state.redirect_get = (
                f"{sentinel.api_base}/pages/{PAGE_ID}/markdown?marker={REDIRECT_SECRET}"
            )
            notion.state.reset()
            sentinel.state.reset()
            redirected = self.command(sandbox, notion.api_base, ["--pull", "--json"])
            parse_status(redirected, {"stale"})
            if sandbox.read_artifacts(SECRET_BODY) != before_redirect:
                fail()
            assert_request_contract(notion, gets=1, patches=0)
            assert_request_contract(sentinel, gets=0, patches=0)
            notion.state.redirect_get = None
            notion.state.fail_get = True
            notion.state.reset()
            stale = self.command(sandbox, notion.api_base, ["--pull", "--json"])
            parse_status(stale, {"stale"})
            notion.state.fail_get = False
            notion.state.fail_patch = True
            notion.state.reset()
            queued = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--json"],
                input_text=SET_EDIT,
            )
            parse_status(queued, {"queued"})
            sandbox.read_artifacts(SET_EDIT)

    def check_set(self) -> None:
        with self.sandbox() as sandbox, LoopbackNotion() as notion:
            self.first_pull(sandbox, notion)
            notion.state.reset()
            result = self.command(
                sandbox,
                notion.api_base,
                ["--set", "-", "--json"],
                input_text=SET_EDIT,
            )
            if result.returncode != 0:
                fail()
            parse_status(result, {"synced"})
            sandbox.read_artifacts(SET_EDIT)
            if notion.state.body != SET_EDIT:
                fail()
            assert_request_contract(notion, patches=1, patch_body=SET_EDIT)

    def run_named(self, name: str) -> None:
        method = getattr(self, f"check_{_camel_to_snake(name)}", None)
        if method is None:
            fail()
        method()

    def run_all(self) -> dict[str, bool]:
        passed: dict[str, bool] = {}
        for name in TEST_NAMES:
            self.run_named(name)
            passed[name] = True
        if set(passed) != set(TEST_NAMES) or any(value is not True for value in passed.values()):
            fail()
        return passed


def _camel_to_snake(value: str) -> str:
    output: list[str] = []
    for character in value:
        if character.isupper():
            output.extend(("_", character.lower()))
        else:
            output.append(character)
    return "".join(output)


def verify_entrypoint(entrypoint: Path) -> dict[str, object]:
    probe = cast(
        ContractProbe,
        probe_stage("source-policy", lambda: ContractProbe(entrypoint)),
    )
    tests: dict[str, bool] = {}
    for name in TEST_NAMES:
        probe_stage(PROBE_TEST_STAGES[name], lambda name=name: probe.run_named(name))
        tests[name] = True

    def build_receipt() -> dict[str, object]:
        if set(tests) != set(TEST_NAMES) or any(value is not True for value in tests.values()):
            fail()
        probe_sha256 = sha256_bytes(trusted_probe_source())
        return {
            "schemaVersion": 1,
            "interfaceVersion": 1,
            "probeVersion": PROBE_VERSION,
            "entrypointSha256": probe.entrypoint_sha256,
            "probeSha256": probe_sha256,
            "testedAt": utc_now(),
            "tests": tests,
        }

    return cast(dict[str, object], probe_stage("receipt", build_receipt))


def parse_entrypoint_argument(argv: list[str]) -> Path:
    if len(argv) != 2 or argv[0] != "--entrypoint" or not argv[1]:
        fail()
    return Path(argv[1])


def main(argv: list[str] | None = None) -> int:
    try:
        entrypoint = cast(
            Path,
            probe_stage(
                "initialization",
                lambda: parse_entrypoint_argument(sys.argv[1:] if argv is None else argv),
            ),
        )
        receipt = verify_entrypoint(entrypoint)
        receipt_bytes = cast(
            bytes,
            probe_stage("receipt", lambda: canonical_json(receipt)),
        )
    except ProbeStageFailure as error:
        print(f"{PROBE_FAILURE_PREFIX}{error.stage}", file=sys.stderr)
        if error.diagnostic:
            print(
                error.diagnostic,
                file=sys.stderr,
                end="" if error.diagnostic.endswith("\n") else "\n",
            )
        return 4
    except Exception as error:
        print(f"{PROBE_FAILURE_PREFIX}internal", file=sys.stderr)
        traceback.print_exception(error, file=sys.stderr)
        return 4
    sys.stdout.buffer.write(receipt_bytes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
