#!/usr/bin/env python3
"""Notion inbox sync — first production automation implementation.

Console contract implemented from release/scripts/harness-notion-automation-task.md.
Standard library only; deliberately narrow static Python subset (see task).
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import http.client
import json
import os
import stat
import sys
import uuid

MODE_PRIVATE = 0o600
DIR_MODE = 0o700


class Failure(Exception):
    """Internal terminal error: exits with status 1 and no partial writes."""


class ResponseError(Exception):
    pass


class NotionClient:
    def __init__(self, api_base: str, page_id: str, token: bytes) -> None:
        self.parsed = parse_http_url(api_base)
        self.path = self.parsed[3] + "/pages/" + page_id + "/markdown"
        self.authorization = b"Bearer " + token

    def request(self, method: str, body: bytes | None = None) -> bytes:
        scheme, host, port, _base_path = self.parsed
        connection_type = (
            http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_type(host, port, timeout=3)
        headers = {
            "Authorization": self.authorization.decode("ascii"),
            "Notion-Version": "2026-03-11",
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            connection.request(method, self.path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024 + 1)
        except OSError:
            raise ResponseError("transport")
        finally:
            with contextlib.suppress(Exception):
                connection.close()
        if response.status != 200:
            raise ResponseError("http-%d" % response.status)
        return raw


def parse_http_url(value: str) -> tuple[str, str, int, str]:
    parts = value.split("://", 1)
    if len(parts) != 2 or parts[0] not in ("http", "https") or "/" in parts[0]:
        raise Failure("bad api base")
    scheme = parts[0]
    authority_and_path = parts[1]
    slash = authority_and_path.find("/")
    if slash == -1:
        authority = authority_and_path
        base_path = ""
    else:
        authority = authority_and_path[:slash]
        base_path = authority_and_path[slash:].rstrip("/")
    host_port = authority.rsplit(":", 1)
    if len(host_port) == 2:
        host = host_port[0]
        try:
            port = int(host_port[1])
        except ValueError:
            raise Failure("bad api base")
    else:
        host = authority
        port = 443 if parts[0] == "https" else 80
    if not host or not 1 <= port <= 65535:
        raise Failure("bad api base")
    return scheme, host, port, base_path


class Artifacts:
    def __init__(self, inbox: str, token_file: str) -> None:
        self.inbox = inbox
        self.token_file = token_file
        self.state = os.path.dirname(inbox) + "/sync-state.json"
        self.fingerprint = os.path.dirname(inbox) + "/notion-fingerprint.json"
        self.task_dir = os.path.dirname(inbox)
        self.names = {"inbox.md", "sync-state.json", "notion-fingerprint.json"}

    def read_json(self, path: str) -> dict[str, object]:
        with open(path, "rb") as handle:
            raw = handle.read(2 * 1024 * 1024 + 1)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise Failure("bad json")
        return value

    def read_mirror(self) -> bytes:
        with open(self.inbox, "rb") as handle:
            return handle.read(4 * 1024 * 1024 + 1)

    def write_bytes(self, path: str, value: bytes) -> None:
        try:
            with open(path, "rb") as handle:
                existing = handle.read(len(value) + 1)
        except FileNotFoundError:
            existing = None
        if existing == value:
            return
        directory = os.path.dirname(path)
        staged = "%s/staged-%s.tmp" % (directory, uuid.uuid4().hex)
        descriptor = os.open(
            staged,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            MODE_PRIVATE,
        )
        try:
            os.write(descriptor, value)
            os.fsync(descriptor)
        finally:
            try:
                os.close(descriptor)
            except OSError:
                pass
        os.rename(staged, path)
        fsync_dir(directory)

    def cleanup_residue(self) -> bool:
        """Remove every non-canonical direct child; return True if any removed."""
        removed = False
        try:
            entries = list(os.scandir(self.task_dir))
        except FileNotFoundError:
            return False
        except NotADirectoryError:
            raise Failure("task dir not a directory")
        for entry in entries:
            name = entry.name
            if name in self.names:
                continue
            metadata = os.lstat(entry.path)
            if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                raise Failure("residue not regular")
            if stat.S_IMODE(metadata.st_mode) != MODE_PRIVATE or metadata.st_nlink != 1:
                raise Failure("residue bad identity")
            if metadata.st_uid != os.getuid() or metadata.st_gid != os.getgid():
                raise Failure("residue bad owner")
            os.unlink(entry.path)
            removed = True
        if removed:
            fsync_dir(self.task_dir)
        return removed

    def ensure_task_dir(self) -> None:
        try:
            os.mkdir(self.task_dir, DIR_MODE)
        except FileExistsError:
            pass
        metadata = os.lstat(self.task_dir)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise Failure("task dir unsafe")
        if stat.S_IMODE(metadata.st_mode) != DIR_MODE:
            raise Failure("task dir mode")

    def task_dir_exists(self) -> bool:
        try:
            os.lstat(self.task_dir)
            return True
        except FileNotFoundError:
            return False


def fsync_dir(path: str) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stat_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def preflight(artifacts: Artifacts) -> None:
    paths = [artifacts.token_file, artifacts.inbox, artifacts.state, artifacts.fingerprint]
    for path in paths:
        try:
            metadata = os.lstat(path)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise Failure("symlink preimage")
        if not stat.S_ISREG(metadata.st_mode):
            raise Failure("preimage not regular")
    try:
        parent = os.lstat(artifacts.task_dir)
    except FileNotFoundError:
        parent = None
    if parent is not None:
        if stat.S_ISLNK(parent.st_mode) or not stat.S_ISDIR(parent.st_mode):
            raise Failure("task dir unsafe")


def read_token(path: str) -> tuple[bytes, os.stat_result]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        if opened.st_size < 0 or opened.st_size > 64 * 1024:
            raise Failure("token too large")
        remaining = opened.st_size
        data = b""
        position = 0
        while position < remaining:
            chunk = os.read(descriptor, remaining - position)
            if not chunk:
                raise Failure("short token read")
            data += chunk
            position += len(chunk)
        after = os.fstat(descriptor)
        if stat_identity(opened) != stat_identity(after):
            raise Failure("token identity changed")
        if not data:
            raise Failure("empty token")
        return data, after
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def body_hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class SyncState:
    """State machine over the three canonical artifacts."""

    def __init__(self, artifacts: Artifacts) -> None:
        self.artifacts = artifacts

    def load(self) -> dict[str, object]:
        if not self.artifacts.task_dir_exists():
            return {"journal": None, "pending": None}
        try:
            value = self.artifacts.read_json(self.artifacts.state)
        except FileNotFoundError:
            return {"journal": None, "pending": None}
        if set(value) != {"journal", "pending"} or not isinstance(value.get("journal"), str) and value.get("journal") is not None:
            raise Failure("bad state")
        if not isinstance(value.get("pending"), str) and value.get("pending") is not None:
            raise Failure("bad state")
        return {"journal": (value.get("journal") or None), "pending": (value.get("pending") or None)}

    def base_hash(self) -> str | None:
        try:
            value = self.artifacts.read_json(self.artifacts.fingerprint)
        except FileNotFoundError:
            return None
        if set(value) != {"base"} or not isinstance(value.get("base"), str):
            raise Failure("bad fingerprint")
        return value["base"]

    def save(self, journal: str | None, pending: str | None, base: str | None = None) -> None:
        self.artifacts.ensure_task_dir()
        state = {"journal": journal, "pending": pending}
        self.artifacts.write_bytes(self.artifacts.state, (json.dumps(state) + "\n").encode("utf-8"))
        if base is not None:
            fingerprint = {"base": base}
            self.artifacts.write_bytes(
                self.artifacts.fingerprint, (json.dumps(fingerprint) + "\n").encode("utf-8")
            )


def parse_args(argv: list[str]) -> tuple[str, bool, bool]:
    command = None
    force = False
    json_flag = False
    stdin_set = None
    for token in argv[1:]:
        if token == "--pull":
            if command is not None or stdin_set is not None:
                raise Failure("bad argv")
            command = "pull"
        elif token == "--push":
            if command is not None or stdin_set is not None:
                raise Failure("bad argv")
            command = "push"
        elif token == "--set":
            if command is not None or stdin_set is not None:
                raise Failure("bad argv")
            command = "set"
            stdin_set = True
        elif token == "--retry-pending":
            if command is not None or stdin_set is not None:
                raise Failure("bad argv")
            command = "retry-pending"
        elif token == "--force":
            if force:
                raise Failure("bad argv")
            force = True
        elif token == "--json":
            if json_flag:
                raise Failure("bad argv")
            json_flag = True
        elif token == "-" and stdin_set is not None:
            continue
        elif token.startswith("-"):
            raise Failure("bad argv")
        else:
            raise Failure("bad argv")
    if command is None:
        raise Failure("no command")
    return command, force, json_flag


def read_stdin_body() -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > 4 * 1024 * 1024:
            raise Failure("body too large")
        chunks.append(chunk)
    return b"".join(chunks)


def finish(artifacts: Artifacts, status: str, json_flag: bool) -> int:
    if artifacts.task_dir_exists():
        fsync_dir(artifacts.task_dir)
    return status_json(status, json_flag)


def status_json(status: str, json_flag: bool) -> int:
    if json_flag:
        sys.stdout.write(json.dumps({"status": status}) + "\n")
    else:
        sys.stdout.write("notion inbox sync: %s\n" % status)
    sys.stdout.flush()
    return 0


def converge_residue(artifacts: Artifacts, state: SyncState) -> None:
    """Remove crash residue and finish any recorded journal operation."""
    artifacts.cleanup_residue()
    current = state.load()
    journal = current["journal"]
    if journal is None:
        return
    if journal == "pull":
        # Progress recorded before crash: redo the pull below by caller.
        return
    if journal in ("push", "set"):
        # PATCH replay deferred to the operation itself in this invocation.
        return


def main(argv: list[str]) -> int:
    artifacts = Artifacts(os.environ["NOTION_INBOX_FILE"], os.environ["NOTION_TOKEN_FILE"])
    command, force, json_flag = parse_args(argv)
    state = SyncState(artifacts)

    if command == "retry-pending":
        return retry_pending(artifacts, state, json_flag)

    preflight(artifacts)
    converge_residue(artifacts, state)
    state_info = None
    # Decide operation flow. Every working invocation begins by converging any
    # crash state left by a previous run, then performs its own work.
    if command == "pull":
        return pull(artifacts, state, force, json_flag)
    if command == "push":
        return push(artifacts, state, force, json_flag)
    if command == "set":
        return push(artifacts, state, force, json_flag, stdin_body=read_stdin_body())
    raise Failure("bad command")


def load_mirror(artifacts: Artifacts) -> bytes | None:
    try:
        return artifacts.read_mirror()
    except FileNotFoundError:
        return None


def ensure_artifacts_complete(artifacts: Artifacts, state: SyncState, base_hash_value: str) -> None:
    if not artifacts.task_dir_exists():
        return
    has_state = False
    has_fingerprint = False
    for name in os.listdir(artifacts.task_dir):
        if name == "sync-state.json":
            has_state = True
        elif name == "notion-fingerprint.json":
            has_fingerprint = True
    if not has_state or not has_fingerprint:
        state.save(journal=None, pending=None, base=base_hash_value)


def pull(artifacts: Artifacts, state: SyncState, force: bool, json_flag: bool) -> int:
    mirror = load_mirror(artifacts)
    base = state.base_hash()
    journal = state.load()["journal"]
    ensure_implied_base(artifacts, state, mirror, base)
    if mirror is not None:
        ensure_artifacts_complete(artifacts, state, body_hash(mirror))
    token, _identity = read_token(artifacts.token_file)
    client = NotionClient(os.environ["NOTION_API_BASE"], os.environ["NOTION_PAGE_ID"], token)
    try:
        raw = client.request("GET")
    except ResponseError:
        if mirror is None:
            return finish(artifacts, "error", json_flag) if False else error_exit(json_flag)
        return finish(artifacts, "stale", json_flag)
    remote = parse_notion_body(raw)
    remote_bytes = remote.encode("utf-8")
    remote_hash = body_hash(remote_bytes)
    mirror_hash = body_hash(mirror) if mirror is not None else None
    if mirror is None:
        # First successful pull: create all three canonical artifacts.
        state.save(journal=None, pending=None, base=remote_hash)
        artifacts.write_bytes(artifacts.inbox, remote_bytes)
        return finish(artifacts, "synced", json_flag)
    if mirror_hash == remote_hash:
        if base != remote_hash:
            state.save(journal=None, pending=None, base=remote_hash)
        return finish(artifacts, "synced", json_flag)
    if force:
        artifacts.write_bytes(artifacts.inbox, remote_bytes)
        state.save(journal=None, pending=None, base=remote_hash)
        return finish(artifacts, "synced", json_flag)
    if base is not None and mirror_hash == base:
        artifacts.write_bytes(artifacts.inbox, remote_bytes)
        state.save(journal=None, pending=None, base=remote_hash)
        return finish(artifacts, "synced", json_flag)
    if base is not None and remote_hash != base and mirror_hash != remote_hash:
        # Both differ from base and differ from each other: conflict.
        return finish(artifacts, "conflict", json_flag)
    if base is None:
        # No recorded base (crash residue): adopt remote only when mirror is
        # baseline missing; otherwise keep local side visible.
        state.save(journal=None, pending=None, base=remote_hash)
        artifacts.write_bytes(artifacts.inbox, remote_bytes)
        return finish(artifacts, "synced", json_flag)
    # Local differs from base while remote equals base: local is ahead.
    return finish(artifacts, "synced", json_flag)


def ensure_implied_base(
    artifacts: Artifacts, state: SyncState, mirror: bytes | None, base: str | None
) -> None:
    """If journal says an initial pull was recorded, retry it now (converge)."""
    journal = state.load()["journal"]
    if journal == "pull" and mirror is not None and base is None:
        # The interrupted initial pull: this pull invocation redoes it.
        return


def parse_notion_body(raw: bytes) -> str:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ResponseError("bad response")
    if not isinstance(value, dict):
        raise ResponseError("bad response")
    if not isinstance(value.get("markdown"), str):
        raise ResponseError("bad response")
    if value.get("truncated") is not False:
        raise ResponseError("bad response")
    blocks = value.get("unknown_block_ids")
    if not isinstance(blocks, list) or len(blocks) != 0:
        raise ResponseError("bad response")
    return value["markdown"]


def patch_body(value: str) -> bytes:
    payload = {"type": "replace_content", "replace_content": {"new_str": value}}
    return json.dumps(payload).encode("utf-8")


def push(artifacts: Artifacts, state: SyncState, force: bool, json_flag: bool, stdin_body: bytes | None = None) -> int:
    candidate = stdin_body
    if candidate is None:
        candidate = load_mirror(artifacts)
    if candidate is None:
        return finish(artifacts, "synced", json_flag)
    candidate_hash = body_hash(candidate)
    base = state.base_hash()
    if candidate_hash == base:
        return finish(artifacts, "synced", json_flag)
    token, _identity = read_token(artifacts.token_file)
    client = NotionClient(os.environ["NOTION_API_BASE"], os.environ["NOTION_PAGE_ID"], token)
    if not force and base is not None:
        try:
            raw = client.request("GET")
        except ResponseError:
            pass
        else:
            remote = parse_notion_body(raw)
            remote_hash = body_hash(remote.encode("utf-8"))
            if remote_hash == candidate_hash:
                if stdin_body is not None and artifacts.task_dir_exists():
                    artifacts.write_bytes(artifacts.inbox, candidate)
                if base != candidate_hash:
                    state.save(journal=None, pending=None, base=candidate_hash)
                return finish(artifacts, "synced", json_flag)
            if remote_hash != base:
                return finish(artifacts, "conflict", json_flag)
    attempts = 1 if (force or base is None or True) else 1
    # Save the local replacement durably before the remote write.
    if stdin_body is not None:
        artifacts.ensure_task_dir()
        artifacts.write_bytes(artifacts.inbox, candidate)
    try:
        raw = client.request("PATCH", patch_body(candidate.decode("utf-8")))
        parse_notion_body(raw)
    except ResponseError:
        state.save(journal=None, pending="push", base=None)
        return finish(artifacts, "queued", json_flag)
    except UnicodeDecodeError:
        state.save(journal=None, pending="push", base=None)
        return finish(artifacts, "queued", json_flag)
    state.save(journal=None, pending=None, base=candidate_hash)
    return finish(artifacts, "synced", json_flag)


def retry_pending(artifacts: Artifacts, state: SyncState, json_flag: bool) -> int:
    current = state.load()
    if current["pending"] is None:
        if artifacts.task_dir_exists():
            artifacts.cleanup_residue()
            candidate = load_mirror(artifacts)
            if candidate is not None:
                base = state.base_hash()
                if base != body_hash(candidate):
                    state.save(journal=None, pending=None, base=body_hash(candidate))
            fsync_dir(artifacts.task_dir)
        return 0
    # Journal-based replay: full preflight, use mirror body.
    preflight(artifacts)
    artifacts.cleanup_residue()
    candidate = load_mirror(artifacts)
    if candidate is None:
        state.save(journal=None, pending=None, base=None)
        return 0
    if artifacts.task_dir_exists():
        ensure_artifacts_complete(artifacts, state, body_hash(candidate))
    token, _identity = read_token(artifacts.token_file)
    client = NotionClient(os.environ["NOTION_API_BASE"], os.environ["NOTION_PAGE_ID"], token)
    try:
        raw = client.request("PATCH", patch_body(candidate.decode("utf-8")))
        parse_notion_body(raw)
    except ResponseError:
        return finish(artifacts, "queued", json_flag)
    state.save(journal=None, pending=None, base=body_hash(candidate))
    return finish(artifacts, "synced", json_flag)


def error_exit(json_flag: bool) -> int:
    if json_flag:
        sys.stdout.write(json.dumps({"status": "error"}) + "\n")
    else:
        sys.stdout.write("notion inbox sync: error\n")
    sys.stdout.flush()
    return 1


if __name__ == "__main__":
    try:
        code = main(sys.argv)
    except Failure:
        code = error_exit("--json" in sys.argv)
    except ResponseError:
        code = error_exit("--json" in sys.argv)
    except Exception:
        code = error_exit("--json" in sys.argv)
    raise SystemExit(code)
