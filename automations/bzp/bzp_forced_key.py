#!/usr/bin/env python3
"""Manage the one exact Rita-to-Herman forced-command authorized key line."""
from __future__ import annotations

import argparse
import json
import os
import re
import uuid
from pathlib import Path


MARKER = "dsh-bzp-refresh-v1"
FORCED_COMMAND = (
    "docker exec --env SSH_ORIGINAL_COMMAND dsh-telegram "
    "/opt/dsh/automations/bzp/bzp_refresh_enqueue.py"
)
KEY_RE = re.compile(r"^(ssh-ed25519|ecdsa-sha2-nistp256) ([A-Za-z0-9+/]+={0,2})(?:\s+.*)?$")


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.tmp.{uuid.uuid4().hex}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _public_key(path: str) -> tuple[str, str]:
    value = Path(path).read_text(encoding="ascii").strip()
    match = KEY_RE.fullmatch(value)
    if match is None:
        raise ValueError("Rita refresh public key has an unsupported format")
    return match.group(1), match.group(2)


def managed_line(key_type: str, key_data: str) -> str:
    command = FORCED_COMMAND.replace("\\", "\\\\").replace('"', '\\"')
    options = (
        "restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,"
        f"no-X11-forwarding,command=\"{command}\""
    )
    return f"{options} {key_type} {key_data} {MARKER}"


def install(public_key_file: str, authorized_keys: str) -> dict:
    key_type, key_data = _public_key(public_key_file)
    desired = managed_line(key_type, key_data)
    path = Path(authorized_keys)
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = original.splitlines()
    marked = [line for line in lines if line.rstrip().endswith(f" {MARKER}")]
    if len(marked) > 1:
        raise ValueError("multiple managed Rita refresh key lines")
    if marked == [desired]:
        return {"action": "install", "changed": False, "marker": MARKER}
    if marked:
        raise ValueError("managed Rita refresh key line drift")
    lines.append(desired)
    _atomic_write(path, "\n".join(lines) + "\n")
    return {"action": "install", "changed": True, "marker": MARKER}


def remove(authorized_keys: str) -> dict:
    path = Path(authorized_keys)
    if not path.exists():
        return {"action": "remove", "changed": False, "marker": MARKER}
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines()
    retained = [line for line in lines if not line.rstrip().endswith(f" {MARKER}")]
    removed = len(lines) - len(retained)
    if removed > 1:
        raise ValueError("multiple managed Rita refresh key lines")
    if removed == 0:
        return {"action": "remove", "changed": False, "marker": MARKER}
    _atomic_write(path, ("\n".join(retained) + "\n") if retained else "")
    return {"action": "remove", "changed": True, "marker": MARKER}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="manage the Rita BZP forced-command key")
    parser.add_argument("action", choices=("install", "remove"))
    parser.add_argument("--authorized-keys", default="/home/herman/.ssh/authorized_keys")
    parser.add_argument(
        "--public-key-file",
        default="/home/herman/.local/share/dsh-container/secrets/rita-bzp-refresh.pub",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    opts = parse_args(argv)
    result = install(opts.public_key_file, opts.authorized_keys) if opts.action == "install" else remove(opts.authorized_keys)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
