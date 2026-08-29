#!/usr/bin/env python3
"""Report one fixed, read-only view of the Harness Notion production boundary."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


MAX_RELEASE_BYTES = 2 * 1024 * 1024
MAX_DOCKER_OUTPUT = 256 * 1024
OWNER_LABEL = "io.dsh.owner=harness-notion-automation"
EXPECTED_HARNESS_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
EXPECTED_HARNESS_PATCH_SHA256 = (
    "sha256:df85af4402b238a666bc7117092e559ae843df55c850ea6b711c1c8f3a292e0b"
)
ERROR = "harness notion automation status unavailable"


class StatusError(Exception):
    pass


def reject() -> None:
    raise StatusError


def exact_identity(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def directory_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NOATIME", 0)
    )


def validate_directory(value: os.stat_result, uid: int, gid: int) -> None:
    if (
        stat.S_ISLNK(value.st_mode)
        or not stat.S_ISDIR(value.st_mode)
        or value.st_uid != uid
        or value.st_gid != gid
    ):
        reject()


def open_directory_path(path: Path, uid: int, gid: int) -> int:
    descriptor: int | None = None
    try:
        before = os.lstat(path)
        descriptor = os.open(path, directory_flags())
        opened = os.fstat(descriptor)
        after = os.lstat(path)
        if (
            exact_identity(before) != exact_identity(opened)
            or exact_identity(opened) != exact_identity(after)
        ):
            reject()
        validate_directory(opened, uid, gid)
        return descriptor
    except (OSError, StatusError):
        if descriptor is not None:
            os.close(descriptor)
        reject()


def open_child_directory(parent: int, name: str, uid: int, gid: int) -> int:
    if not re.fullmatch(r"[0-9A-Za-z._-]+", name):
        reject()
    descriptor: int | None = None
    try:
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        descriptor = os.open(name, directory_flags(), dir_fd=parent)
        opened = os.fstat(descriptor)
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        reject()
    if (
        exact_identity(before) != exact_identity(opened)
        or exact_identity(opened) != exact_identity(after)
    ):
        os.close(descriptor)
        reject()
    try:
        validate_directory(opened, uid, gid)
    except StatusError:
        os.close(descriptor)
        reject()
    return descriptor


def revalidate_directory_path(path: Path, descriptor: int, uid: int, gid: int) -> None:
    try:
        observed = os.lstat(path)
        held = os.fstat(descriptor)
    except OSError:
        reject()
    validate_directory(held, uid, gid)
    if exact_identity(observed) != exact_identity(held):
        reject()


def revalidate_child_directory(
    parent: int, name: str, descriptor: int, uid: int, gid: int
) -> None:
    try:
        observed = os.stat(name, dir_fd=parent, follow_symlinks=False)
        held = os.fstat(descriptor)
    except OSError:
        reject()
    validate_directory(held, uid, gid)
    if exact_identity(observed) != exact_identity(held):
        reject()


def acquire_read_lock(state_root: Path, uid: int, gid: int) -> tuple[int, int]:
    state_descriptor = open_directory_path(state_root, uid, gid)
    locks_descriptor: int | None = None
    lock_descriptor: int | None = None
    try:
        locks_descriptor = open_child_directory(state_descriptor, "locks", uid, gid)
        name = "production-operation.lock"
        before = os.stat(name, dir_fd=locks_descriptor, follow_symlinks=False)
        flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NOATIME", 0)
        )
        lock_descriptor = os.open(name, flags, dir_fd=locks_descriptor)
        opened = os.fstat(lock_descriptor)
        if (
            exact_identity(before) != exact_identity(opened)
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_uid != uid
            or opened.st_gid != gid
            or stat.S_IMODE(opened.st_mode) != 0o600
        ):
            reject()
        fcntl.flock(lock_descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
        after = os.stat(name, dir_fd=locks_descriptor, follow_symlinks=False)
        if exact_identity(opened) != exact_identity(after):
            reject()
        os.close(locks_descriptor)
        return lock_descriptor, state_descriptor
    except (OSError, StatusError):
        for descriptor in (lock_descriptor, locks_descriptor, state_descriptor):
            if descriptor is not None:
                os.close(descriptor)
        reject()


def release_pointer(
    state_root: Path, state_descriptor: int, name: str, uid: int, gid: int
) -> str:
    try:
        before = os.stat(name, dir_fd=state_descriptor, follow_symlinks=False)
        raw_target = os.readlink(name, dir_fd=state_descriptor)
        after = os.stat(name, dir_fd=state_descriptor, follow_symlinks=False)
    except OSError:
        reject()
    release_id = Path(raw_target).name
    if (
        exact_identity(before) != exact_identity(after)
        or not stat.S_ISLNK(before.st_mode)
        or before.st_nlink != 1
        or before.st_uid != uid
        or before.st_gid != gid
        or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._-]{0,127}", release_id)
        or raw_target != str(state_root / "releases" / release_id)
    ):
        reject()
    return release_id


def read_release(release_descriptor: int, uid: int, gid: int) -> dict[str, Any]:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NOATIME", 0)
    )
    descriptor: int | None = None
    try:
        before = os.stat("release.json", dir_fd=release_descriptor, follow_symlinks=False)
        descriptor = os.open("release.json", flags, dir_fd=release_descriptor)
        opened = os.fstat(descriptor)
        after = os.stat("release.json", dir_fd=release_descriptor, follow_symlinks=False)
        if (
            exact_identity(before) != exact_identity(opened)
            or exact_identity(opened) != exact_identity(after)
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_uid != uid
            or opened.st_gid != gid
            or not (1 <= opened.st_size <= MAX_RELEASE_BYTES)
        ):
            reject()
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 64 * 1024))
            if not chunk:
                reject()
            chunks.append(chunk)
            remaining -= len(chunk)
        if (
            os.read(descriptor, 1)
            or exact_identity(opened) != exact_identity(os.fstat(descriptor))
            or exact_identity(opened) != exact_identity(
                os.stat("release.json", dir_fd=release_descriptor, follow_symlinks=False)
            )
        ):
            reject()
        value = json.loads(b"".join(chunks))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, StatusError):
        reject()
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if not isinstance(value, dict):
        reject()
    return value


def docker(docker_path: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            [str(docker_path), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": "/nonexistent",
                "DOCKER_CONFIG": "/nonexistent/dsh-read-only-status",
                "LANG": "C.UTF-8",
            },
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        reject()
    if result.returncode != 0 or len(result.stdout) > MAX_DOCKER_OUTPUT:
        reject()
    try:
        return result.stdout.decode("ascii", "strict").strip()
    except UnicodeDecodeError:
        reject()


def resource_count(docker_path: Path, kind: str) -> int:
    if kind == "container":
        output = docker(
            docker_path,
            "container",
            "ls",
            "--all",
            "--filter",
            f"label={OWNER_LABEL}",
            "--format",
            "{{.ID}}",
        )
    elif kind == "network":
        output = docker(
            docker_path,
            "network",
            "ls",
            "--filter",
            f"label={OWNER_LABEL}",
            "--format",
            "{{.ID}}",
        )
    else:
        reject()
    identifiers = [] if not output else output.splitlines()
    if (
        len(set(identifiers)) != len(identifiers)
        or any(not re.fullmatch(r"[0-9a-f]{12,64}", value) for value in identifiers)
    ):
        reject()
    return len(identifiers)


def target_status(dsh_home: Path, uid: int, gid: int) -> dict[str, str]:
    held: list[int] = []
    try:
        held.append(open_directory_path(dsh_home, uid, gid))
        held.append(open_child_directory(held[-1], "workspace", uid, gid))
        held.append(open_child_directory(held[-1], "automations", uid, gid))
        try:
            value = os.stat("notion", dir_fd=held[-1], follow_symlinks=False)
        except FileNotFoundError:
            value = None
        except OSError:
            reject()
        if value is not None and (stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode)):
            reject()
        revalidate_child_directory(held[1], "automations", held[2], uid, gid)
        revalidate_child_directory(held[0], "workspace", held[1], uid, gid)
        revalidate_directory_path(dsh_home, held[0], uid, gid)
        try:
            after = os.stat("notion", dir_fd=held[-1], follow_symlinks=False)
        except FileNotFoundError:
            after = None
        except OSError:
            reject()
        if (value is None) != (after is None) or (
            value is not None and after is not None and exact_identity(value) != exact_identity(after)
        ):
            reject()
        return (
            {"presence": "absent", "type": "absent"}
            if value is None
            else {"presence": "present", "type": "directory"}
        )
    finally:
        for descriptor in reversed(held):
            os.close(descriptor)


def direct_child_count(state_descriptor: int, uid: int, gid: int) -> int:
    try:
        before = os.stat("harness-tasks", dir_fd=state_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        try:
            os.stat("harness-tasks", dir_fd=state_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return 0
        except OSError:
            reject()
        reject()
    except OSError:
        reject()
    descriptor: int | None = None
    try:
        descriptor = os.open("harness-tasks", directory_flags(), dir_fd=state_descriptor)
        opened = os.fstat(descriptor)
        after = os.stat("harness-tasks", dir_fd=state_descriptor, follow_symlinks=False)
        if exact_identity(before) != exact_identity(opened) or exact_identity(opened) != exact_identity(after):
            reject()
        validate_directory(opened, uid, gid)
        with os.scandir(descriptor) as children:
            count = sum(1 for _ in children)
        if (
            exact_identity(opened) != exact_identity(os.fstat(descriptor))
            or exact_identity(opened) != exact_identity(
                os.stat("harness-tasks", dir_fd=state_descriptor, follow_symlinks=False)
            )
        ):
            reject()
        return count
    except (OSError, StatusError):
        reject()
    finally:
        if descriptor is not None:
            os.close(descriptor)


def validate_release_identity(
    release: dict[str, Any], release_id: str
) -> dict[str, str]:
    candidate = release.get("candidate")
    production = release.get("production")
    if (
        release.get("schemaVersion") != 1
        or release.get("status") != "accepted"
        or release.get("releaseId") != release_id
        or not isinstance(candidate, dict)
        or not isinstance(production, dict)
    ):
        reject()
    candidate_image_id = candidate.get("imageId")
    values = {
        "releaseId": release_id,
        "engineImageId": production.get("engineImageId"),
        "imageTag": candidate.get("imageTag"),
        "pluginsCommit": candidate.get("pluginsCommit"),
        "releaseToolCommit": candidate.get("releaseToolCommit"),
        "harnessCommit": candidate.get("harnessCommit"),
        "harnessPatchSha256": candidate.get("harnessPatchSha256"),
    }
    if not all(isinstance(value, str) for value in values.values()):
        reject()
    if not isinstance(candidate_image_id, str) or not re.fullmatch(r"[0-9a-f]{64}", candidate_image_id):
        reject()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", values["engineImageId"]):
        reject()
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._/:+-]{0,255}", values["imageTag"]):
        reject()
    for key in ("pluginsCommit", "releaseToolCommit", "harnessCommit"):
        if not re.fullmatch(r"[0-9a-f]{40}", values[key]):
            reject()
    if (
        values["harnessCommit"] != EXPECTED_HARNESS_COMMIT
        or values["harnessPatchSha256"] != EXPECTED_HARNESS_PATCH_SHA256
        or any(production.get(key) != expected for key, expected in {
            "web": "true/0",
            "telegram": "true/0",
            "lan": "true/0",
            "prepare": "exited/0",
        }.items())
    ):
        reject()
    return values


def validate_image(docker_path: Path, release: dict[str, str]) -> None:
    template = "|".join((
        "{{.Id}}",
        '{{index .Config.Labels "io.dsh.candidate.purpose"}}',
        '{{index .Config.Labels "io.dsh.harness.revision"}}',
        '{{index .Config.Labels "io.dsh.harness.patch-sha256"}}',
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        '{{index .Config.Labels "io.dsh.release.revision"}}',
        "{{json .RepoTags}}",
    ))
    value = docker(
        docker_path, "image", "inspect", "--format", template, release["engineImageId"]
    ).split("|")
    if len(value) != 7 or value[:6] != [
        release["engineImageId"],
        "release",
        release["harnessCommit"],
        release["harnessPatchSha256"],
        release["pluginsCommit"],
        release["releaseToolCommit"],
    ]:
        reject()
    try:
        tags = json.loads(value[6])
    except json.JSONDecodeError:
        reject()
    accepted_tags = {release["imageTag"]}
    if not release["imageTag"].startswith("localhost/"):
        accepted_tags.add(f"localhost/{release['imageTag']}")
    if (
        not isinstance(tags, list)
        or not all(isinstance(tag, str) for tag in tags)
        or accepted_tags.isdisjoint(tags)
    ):
        reject()


def container_status(
    docker_path: Path,
    role: str,
    name: str,
    image_id: str,
    expected_running: bool,
    expected_status: str,
    expected_health: str,
) -> dict[str, Any]:
    template = "|".join((
        "{{.Image}}",
        "{{.State.Running}}",
        "{{.State.Status}}",
        "{{.State.ExitCode}}",
        "{{.State.OOMKilled}}",
        "{{.State.Dead}}",
        "{{.State.Restarting}}",
        "{{.RestartCount}}",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        '{{index .Config.Labels "com.docker.compose.project"}}',
        '{{index .Config.Labels "com.docker.compose.service"}}',
    ))
    value = docker(docker_path, "container", "inspect", "--format", template, name).split("|")
    expected = [
        image_id,
        str(expected_running).lower(),
        expected_status,
        "0",
        "false",
        "false",
        "false",
        "0",
        expected_health,
        "dsh",
        "lan-proxy" if role == "lan" else role,
    ]
    if value != expected:
        reject()
    return {
        "name": name,
        "imageMatchesAccepted": True,
        "composeLabelsMatch": True,
        "running": expected_running,
        "status": expected_status,
        "exitCode": 0,
        "oomKilled": False,
        "dead": False,
        "restarting": False,
        "restartCount": 0,
        "health": expected_health,
    }


def collect_status(
    state_root: Path,
    dsh_home: Path,
    docker_path: Path,
    uid: int,
    gid: int,
    source_commit: str,
    source_sha256: str,
) -> dict[str, Any]:
    if (
        not state_root.is_absolute()
        or not dsh_home.is_absolute()
        or not docker_path.is_absolute()
        or not re.fullmatch(r"[0-9a-f]{40}", source_commit)
        or not re.fullmatch(r"[0-9a-f]{64}", source_sha256)
    ):
        reject()
    lock, state_descriptor = acquire_read_lock(state_root, uid, gid)
    releases_descriptor: int | None = None
    release_descriptor: int | None = None
    try:
        releases_descriptor = open_child_directory(state_descriptor, "releases", uid, gid)
        current_id = release_pointer(state_root, state_descriptor, "current", uid, gid)
        last_good_id = release_pointer(state_root, state_descriptor, "last-good", uid, gid)
        if current_id != last_good_id:
            reject()
        release_descriptor = open_child_directory(releases_descriptor, current_id, uid, gid)
        release = validate_release_identity(
            read_release(release_descriptor, uid, gid), current_id
        )
        validate_image(docker_path, release)
        containers = {
            "web": container_status(
                docker_path, "web", "dsh-web", release["engineImageId"], True, "running", "healthy"
            ),
            "telegram": container_status(
                docker_path, "telegram", "dsh-telegram", release["engineImageId"], True, "running", "none"
            ),
            "lan": container_status(
                docker_path, "lan", "dsh-lan-proxy", release["engineImageId"], True, "running", "none"
            ),
            "prepare": container_status(
                docker_path, "prepare", "dsh-prepare", release["engineImageId"], False, "exited", "none"
            ),
        }
        task_count = direct_child_count(state_descriptor, uid, gid)
        container_count = resource_count(docker_path, "container")
        network_count = resource_count(docker_path, "network")
        if task_count != 0 or container_count != 0 or network_count != 0:
            reject()
        receipt = {
            "schemaVersion": 1,
            "status": "accepted-production-boundary",
            "statusSource": {
                "commit": source_commit,
                "sha256": f"sha256:{source_sha256}",
            },
            "target": target_status(dsh_home, uid, gid),
            "harnessTasks": {"childCount": task_count},
            "oneShotResources": {
                "ownerLabel": OWNER_LABEL,
                "containerCount": container_count,
                "networkCount": network_count,
            },
            "release": {"currentEqualsLastGood": True, **release},
            "containers": containers,
        }
        if release_pointer(state_root, state_descriptor, "current", uid, gid) != current_id:
            reject()
        if release_pointer(state_root, state_descriptor, "last-good", uid, gid) != last_good_id:
            reject()
        revalidate_child_directory(releases_descriptor, current_id, release_descriptor, uid, gid)
        revalidate_child_directory(state_descriptor, "releases", releases_descriptor, uid, gid)
        revalidate_directory_path(state_root, state_descriptor, uid, gid)
        return receipt
    finally:
        if release_descriptor is not None:
            os.close(release_descriptor)
        if releases_descriptor is not None:
            os.close(releases_descriptor)
        os.close(state_descriptor)
        os.close(lock)


def parse_args(argv: list[str]) -> tuple[Path, Path, Path, int, int, str, str]:
    names = (
        "--state-root",
        "--dsh-home",
        "--docker",
        "--owner-uid",
        "--owner-gid",
        "--source-commit",
        "--source-sha256",
    )
    if len(argv) != len(names) * 2 or tuple(argv[::2]) != names:
        reject()
    try:
        uid = int(argv[7])
        gid = int(argv[9])
    except (TypeError, ValueError):
        reject()
    if uid < 0 or gid < 0:
        reject()
    return (
        Path(argv[1]),
        Path(argv[3]),
        Path(argv[5]),
        uid,
        gid,
        argv[11],
        argv[13],
    )


def main() -> None:
    try:
        result = collect_status(*parse_args(sys.argv[1:]))
    except (StatusError, OSError, ValueError, TypeError, subprocess.SubprocessError):
        sys.stderr.write(f"{ERROR}\n")
        raise SystemExit(6)
    payload = json.dumps(result, sort_keys=True, separators=(",", ":"))
    sys.stdout.write(f"{payload}\n")


if __name__ == "__main__":
    main()
