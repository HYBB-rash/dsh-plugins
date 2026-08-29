#!/usr/bin/env python3
"""Validate and atomically install the production Notion credential.

This is the remote, mechanical half of ``release/dsh credential notion``.  Its
command line contains public configuration only.  The credential is accepted
exclusively on a non-interactive stdin stream and is never included in output.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NoReturn


MAX_TOKEN_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
DEFAULT_NOTION_VERSION = "2026-03-11"
DEFAULT_STATE_ROOT = "/home/herman/.local/share/dsh-container"
DEFAULT_DOCKER = "/usr/bin/docker"
MAX_RELEASE_BYTES = 2 * 1024 * 1024


class CredentialError(Exception):
    """An expected, already-redacted credential operation failure."""

    def __init__(self, message: str, exit_code: int = 4) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class RedactingArgumentParser(argparse.ArgumentParser):
    """Never repeat an invalid argv value, which could itself be a token."""

    def error(self, _message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(2, "notion credential: invalid command arguments\n")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward the Authorization header across redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = RedactingArgumentParser(
        description="Validate a stdin Notion token with one GET, then install it atomically.",
        allow_abbrev=False,
    )
    parser.add_argument("--target", required=True)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--page-id", required=True)
    parser.add_argument("--api-version", default=DEFAULT_NOTION_VERSION)
    parser.add_argument("--owner-uid", type=int, default=os.getuid())
    parser.add_argument("--owner-gid", type=int, default=os.getgid())
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--docker", required=True)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def read_token_from_stdin() -> bytes:
    if sys.stdin.isatty():
        raise CredentialError("notion credential: token requires non-interactive stdin", 2)

    value = sys.stdin.buffer.read(MAX_TOKEN_BYTES + 2)
    if len(value) > MAX_TOKEN_BYTES + 1:
        raise CredentialError("notion credential: invalid token input", 2)
    if value.endswith(b"\r\n"):
        value = value[:-2]
    elif value.endswith(b"\n"):
        value = value[:-1]

    if (
        not value
        or len(value) > MAX_TOKEN_BYTES
        or b"\x00" in value
        or b"\r" in value
        or b"\n" in value
        or any(byte <= 0x20 or byte == 0x7F for byte in value)
    ):
        raise CredentialError("notion credential: invalid token input", 2)
    try:
        value.decode("ascii", errors="strict")
    except UnicodeDecodeError as error:
        raise CredentialError("notion credential: invalid token input", 2) from error
    return value


def validate_public_config(args: argparse.Namespace) -> tuple[Path, str, Path, Path]:
    target = Path(args.target)
    if not target.is_absolute() or target.name != "notion.token" or target.parent.name != "secrets":
        raise CredentialError("notion credential: invalid credential target", 2)
    if args.owner_uid < 0 or args.owner_gid < 0:
        raise CredentialError("notion credential: invalid owner", 2)
    state_root = Path(args.state_root)
    docker = Path(args.docker)
    if not state_root.is_absolute() or not docker.is_absolute():
        raise CredentialError("notion credential: invalid production boundary", 2)
    if not args.page_id or any(char in args.page_id for char in "\r\n\x00"):
        raise CredentialError("notion credential: invalid page configuration", 2)
    if args.api_version != DEFAULT_NOTION_VERSION:
        raise CredentialError("notion credential: invalid API version", 2)

    parsed = urllib.parse.urlsplit(args.api_base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise CredentialError("notion credential: invalid API endpoint", 2)
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise CredentialError("notion credential: insecure API endpoint", 2)

    endpoint = (
        args.api_base.rstrip("/")
        + "/pages/"
        + urllib.parse.quote(args.page_id, safe="")
        + "/markdown"
    )
    return target, endpoint, state_root, docker


def require_directory(path: Path, uid: int, gid: int) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise CredentialError("notion credential: production boundary unavailable") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != uid
        or info.st_gid != gid
    ):
        raise CredentialError("notion credential: unsafe production boundary")
    return info


def read_stable_regular(path: Path, maximum: int, uid: int, gid: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        before = path.lstat()
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CredentialError("notion credential: production boundary unavailable") from error
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or before.st_nlink != 1
            or opened.st_nlink != 1
            or before.st_dev != opened.st_dev
            or before.st_ino != opened.st_ino
            or before.st_uid != opened.st_uid
            or before.st_gid != opened.st_gid
            or opened.st_uid != uid
            or opened.st_gid != gid
            or before.st_size != opened.st_size
            or before.st_size < 1
            or before.st_size > maximum
        ):
            raise CredentialError("notion credential: unsafe production boundary")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                raise CredentialError("notion credential: unsafe production boundary")
        after = os.fstat(descriptor)
        stable_fields = (
            "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
            "st_size", "st_mtime_ns", "st_ctime_ns",
        )
        if any(getattr(opened, field) != getattr(after, field) for field in stable_fields):
            raise CredentialError("notion credential: production boundary changed")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def release_pointer(state_root: Path, name: str, uid: int, gid: int) -> Path:
    pointer = state_root / name
    try:
        before = pointer.lstat()
        raw_target = os.readlink(pointer)
        after = pointer.lstat()
    except OSError as error:
        raise CredentialError("notion credential: production boundary unavailable") from error
    stable_fields = (
        "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    )
    if (
        not stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != uid
        or before.st_gid != gid
        or any(getattr(before, field) != getattr(after, field) for field in stable_fields)
        or not raw_target
    ):
        raise CredentialError("notion credential: unsafe production boundary")
    releases = state_root / "releases"
    require_directory(releases, uid, gid)
    try:
        target = (pointer.parent / raw_target).resolve(strict=True)
        releases_resolved = releases.resolve(strict=True)
    except OSError as error:
        raise CredentialError("notion credential: production boundary unavailable") from error
    if target.parent != releases_resolved or not re.fullmatch(r"[0-9A-Za-z._-]+", target.name):
        raise CredentialError("notion credential: unsafe production boundary")
    require_directory(target, uid, gid)
    return target


def docker_json(docker: Path, *arguments: str) -> object:
    try:
        result = subprocess.run(
            [str(docker), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            # The production helper is invoked with /usr/bin/python3.  Adding
            # that interpreter's directory also lets the immutable test image
            # reuse its installed, executable Python fixture while /tmp stays
            # correctly mounted noexec.
            env={
                "PATH": os.pathsep.join(
                    (str(Path(sys.executable).resolve().parent), "/usr/local/bin", "/usr/bin", "/bin")
                ),
                "LANG": "C.UTF-8",
            },
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CredentialError("notion credential: production boundary unavailable") from error
    if result.returncode != 0 or len(result.stdout) > MAX_RELEASE_BYTES:
        raise CredentialError("notion credential: production boundary unavailable")
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CredentialError("notion credential: invalid production boundary") from error


def production_boundary(
    state_root: Path, docker: Path, uid: int, gid: int
) -> tuple[str, str, str]:
    require_directory(state_root, uid, gid)
    current = release_pointer(state_root, "current", uid, gid)
    last_good = release_pointer(state_root, "last-good", uid, gid)
    if current != last_good:
        raise CredentialError("notion credential: production release is not durably accepted")
    raw_release = read_stable_regular(current / "release.json", MAX_RELEASE_BYTES, uid, gid)
    try:
        release = json.loads(raw_release)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CredentialError("notion credential: invalid production boundary") from error
    if not isinstance(release, dict) or release.get("status") != "accepted" or release.get("releaseId") != current.name:
        raise CredentialError("notion credential: production release is not durably accepted")
    candidate = release.get("candidate")
    production = release.get("production")
    if not isinstance(candidate, dict) or not isinstance(production, dict):
        raise CredentialError("notion credential: invalid production boundary")
    image_id = production.get("engineImageId")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise CredentialError("notion credential: invalid production boundary")
    image = docker_json(docker, "image", "inspect", image_id)
    if not isinstance(image, list) or len(image) != 1 or not isinstance(image[0], dict) or image[0].get("Id") != image_id:
        raise CredentialError("notion credential: accepted image is unavailable")

    expected = (
        ("web", "true/0", "dsh-web", True, "running", 0),
        ("telegram", "true/0", "dsh-telegram", True, "running", 0),
        ("lan", "true/0", "dsh-lan-proxy", True, "running", 0),
        ("prepare", "exited/0", "dsh-prepare", False, "exited", 0),
    )
    for field, receipt, name, running, status, exit_code in expected:
        if production.get(field) != receipt:
            raise CredentialError("notion credential: production containers are not healthy")
        inspected = docker_json(docker, "container", "inspect", name)
        if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
            raise CredentialError("notion credential: production containers are not healthy")
        container = inspected[0]
        state = container.get("State")
        if (
            container.get("Image") != image_id
            or not isinstance(state, dict)
            or state.get("Running") is not running
            or state.get("Status") != status
            or state.get("ExitCode") != exit_code
            or container.get("RestartCount") != 0
        ):
            raise CredentialError("notion credential: production containers are not healthy")
    return current.name, image_id, hashlib.sha256(raw_release).hexdigest()


def acquire_production_lock(state_root: Path, uid: int, gid: int) -> int:
    require_directory(state_root, uid, gid)
    locks = state_root / "locks"
    try:
        locks.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as error:
        raise CredentialError("notion credential: production lock unavailable") from error
    require_directory(locks, uid, gid)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(locks / "production-operation.lock", flags, 0o600)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid:
            raise CredentialError("notion credential: unsafe production lock")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return descriptor
    except CredentialError:
        if descriptor is not None:
            os.close(descriptor)
        raise
    except OSError as error:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise CredentialError("notion credential: production lock unavailable") from error


def set_owner_and_mode(path: Path, uid: int, gid: int, mode: int) -> None:
    os.chown(path, uid, gid, follow_symlinks=False)
    os.chmod(path, mode, follow_symlinks=False)


def ensure_secret_directory(path: Path, uid: int, gid: int) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except FileNotFoundError as error:
        raise CredentialError("notion credential: credential parent is missing") from error
    except OSError as error:
        raise CredentialError("notion credential: cannot create credential directory") from error

    try:
        info = path.lstat()
    except OSError as error:
        raise CredentialError("notion credential: cannot inspect credential directory") from error
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise CredentialError("notion credential: unsafe credential directory")
    try:
        set_owner_and_mode(path, uid, gid, 0o700)
    except OSError as error:
        raise CredentialError("notion credential: cannot secure credential directory") from error


def inspect_existing_target(target: Path) -> os.stat_result | None:
    try:
        info = target.lstat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise CredentialError("notion credential: cannot inspect credential target") from error
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise CredentialError("notion credential: unsafe existing credential target")
    return info


def read_regular_file_no_follow(path: Path) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CredentialError("notion credential: cannot read existing credential") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise CredentialError("notion credential: unsafe existing credential target")
        chunks: list[bytes] = []
        remaining = MAX_TOKEN_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        value = b"".join(chunks)
        if len(value) > MAX_TOKEN_BYTES:
            raise CredentialError("notion credential: invalid existing credential")
        return value
    finally:
        os.close(descriptor)


def write_secure_temporary(
    directory: Path, token: bytes, uid: int, gid: int
) -> tuple[Path, int]:
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".notion.token.", dir=directory
        )
        temporary = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, uid, gid)
        written = 0
        while written < len(token):
            written += os.write(descriptor, token[written:])
        os.fsync(descriptor)
        return temporary, descriptor
    except OSError as error:
        try:
            os.close(descriptor)  # type: ignore[possibly-undefined]
        except (NameError, OSError):
            pass
        try:
            temporary.unlink()  # type: ignore[possibly-undefined]
        except (NameError, OSError):
            pass
        raise CredentialError("notion credential: cannot stage credential") from error


def validate_page(
    endpoint: str, token: bytes, api_version: str
) -> tuple[int, str]:
    request = urllib.request.Request(
        endpoint,
        method="GET",
        headers={
            "Authorization": "Bearer " + token.decode("ascii"),
            "Accept": "application/json",
            "Notion-Version": api_version,
        },
    )
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise CredentialError(
                    f"notion credential: page verification failed (HTTP {response.status})"
                )
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise CredentialError(
            f"notion credential: page verification failed (HTTP {error.code})"
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CredentialError("notion credential: page verification failed (network)") from None

    if len(body) > MAX_RESPONSE_BYTES:
        raise CredentialError("notion credential: page verification response is too large")
    try:
        decoded = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CredentialError("notion credential: page verification returned invalid JSON") from None
    if (
        not isinstance(decoded, dict)
        or not isinstance(decoded.get("markdown"), str)
        or decoded.get("truncated") is not False
        or decoded.get("unknown_block_ids") != []
    ):
        raise CredentialError("notion credential: page verification returned incomplete content")
    markdown = decoded["markdown"].encode("utf-8")
    return len(markdown), hashlib.sha256(markdown).hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def emit_receipt(
    target: Path,
    uid: int,
    gid: int,
    body_length: int,
    body_sha256: str,
) -> None:
    receipt = {
        "target": str(target),
        "time": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "permissions": {
            "directory": "0700",
            "file": "0600",
            "ownerUid": uid,
            "ownerGid": gid,
        },
        "pageReadable": True,
        "bodyLength": body_length,
        "bodySha256": body_sha256,
    }
    sys.stdout.write(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")


def run(args: argparse.Namespace) -> None:
    target, endpoint, state_root, docker = validate_public_config(args)
    lock_descriptor = acquire_production_lock(
        state_root, args.owner_uid, args.owner_gid
    )
    temporary: Path | None = None
    descriptor: int | None = None
    try:
        initial_boundary = production_boundary(
            state_root, docker, args.owner_uid, args.owner_gid
        )
        token = read_token_from_stdin()
        ensure_secret_directory(target.parent, args.owner_uid, args.owner_gid)
        existing = inspect_existing_target(target)
        temporary, descriptor = write_secure_temporary(
            target.parent, token, args.owner_uid, args.owner_gid
        )
        os.close(descriptor)
        descriptor = None

        same_token = False
        if existing is not None:
            current_token = read_regular_file_no_follow(target)
            same_token = hmac.compare_digest(current_token, token)
            if not same_token and not args.replace:
                raise CredentialError(
                    "notion credential: a different credential exists; --replace is required"
                )

        body_length, body_sha256 = validate_page(endpoint, token, args.api_version)

        # This is the last read-only gate before either publication path.  The
        # same remote production-operation lock is held across both checks and
        # the install, so release/rollback/Harness helpers cannot cross it.
        if production_boundary(
            state_root, docker, args.owner_uid, args.owner_gid
        ) != initial_boundary:
            raise CredentialError("notion credential: production boundary changed")

        if same_token:
            temporary.unlink()
            temporary = None
            set_owner_and_mode(target, args.owner_uid, args.owner_gid, 0o600)
        else:
            os.replace(temporary, target)
            temporary = None
            set_owner_and_mode(target, args.owner_uid, args.owner_gid, 0o600)
            fsync_directory(target.parent)

        emit_receipt(
            target,
            args.owner_uid,
            args.owner_gid,
            body_length,
            body_sha256,
        )
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        try:
            fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(lock_descriptor)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        run(args)
        return 0
    except CredentialError as error:
        sys.stderr.write(str(error) + "\n")
        return error.exit_code
    except BrokenPipeError:
        return 5
    except Exception:
        # The token and the HTTP request must never be exposed by a traceback or
        # by the string representation of an unexpected third-party exception.
        sys.stderr.write("notion credential: unexpected credential operation failure\n")
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
