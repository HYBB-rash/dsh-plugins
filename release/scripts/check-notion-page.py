#!/usr/bin/env python3
"""Read-only Notion page and credential gate with a private-content-free receipt."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NoReturn


MAX_TOKEN_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
SUPPORTED_NOTION_API_VERSION = "2026-03-11"


class CheckError(RuntimeError):
    pass


class RedactingArgumentParser(argparse.ArgumentParser):
    """Do not echo an invalid argv value that might contain a secret."""

    def error(self, _message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(2, "Notion page check arguments are invalid\n")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def read_config(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CheckError("Notion public configuration is invalid") from error
    expected = {
        "schemaVersion",
        "apiBase",
        "apiVersion",
        "pageId",
        "credentialPath",
        "inboxPath",
    }
    if not isinstance(value, dict) or set(value) != expected or value.get("schemaVersion") != 1:
        raise CheckError("Notion public configuration is invalid")
    for key in expected - {"schemaVersion"}:
        if not isinstance(value.get(key), str) or not value[key]:
            raise CheckError("Notion public configuration is invalid")
        if any(character in value[key] for character in "\r\n\x00"):
            raise CheckError("Notion public configuration is invalid")
    if value["apiVersion"] != SUPPORTED_NOTION_API_VERSION:
        raise CheckError("Notion public configuration has an unsupported API version")
    parsed = urllib.parse.urlsplit(value["apiBase"])
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise CheckError("Notion public configuration is invalid")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise CheckError("Notion public configuration uses an insecure endpoint")
    credential = Path(value["credentialPath"])
    inbox = Path(value["inboxPath"])
    if (
        not credential.is_absolute()
        or credential.name != "notion.token"
        or credential.parent.name != "secrets"
        or not inbox.is_absolute()
    ):
        raise CheckError("Notion public configuration is invalid")
    return value


def read_token(path: Path, expected_uid: int, expected_gid: int) -> bytes:
    try:
        parent = path.parent.lstat()
        target = path.lstat()
    except OSError as error:
        raise CheckError("Notion credential file is unavailable") from error
    if (
        stat.S_ISLNK(parent.st_mode)
        or not stat.S_ISDIR(parent.st_mode)
        or stat.S_IMODE(parent.st_mode) != 0o700
        or parent.st_uid != expected_uid
        or parent.st_gid != expected_gid
        or stat.S_ISLNK(target.st_mode)
        or not stat.S_ISREG(target.st_mode)
        or target.st_nlink != 1
        or stat.S_IMODE(target.st_mode) != 0o600
        or target.st_uid != expected_uid
        or target.st_gid != expected_gid
    ):
        raise CheckError("Notion credential ownership or permissions are invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_uid != expected_uid
                or opened.st_gid != expected_gid
            ):
                raise CheckError("Notion credential file is unsafe")
            chunks: list[bytes] = []
            remaining = MAX_TOKEN_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            token = b"".join(chunks)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise CheckError("Notion credential file is unavailable") from error
    if (
        not token
        or len(token) > MAX_TOKEN_BYTES
        or any(byte <= 0x20 or byte >= 0x7F for byte in token)
    ):
        raise CheckError("Notion credential file is invalid")
    return token


def check_page(config: dict[str, object], token: bytes) -> tuple[int, str]:
    endpoint = (
        str(config["apiBase"]).rstrip("/")
        + "/pages/"
        + urllib.parse.quote(str(config["pageId"]), safe="")
        + "/markdown"
    )
    request = urllib.request.Request(
        endpoint,
        method="GET",
        headers={
            "Authorization": "Bearer " + token.decode("ascii"),
            "Accept": "application/json",
            "Notion-Version": str(config["apiVersion"]),
        },
    )
    try:
        with urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=15) as response:
            if response.status != 200:
                raise CheckError(f"Notion page read failed (HTTP {response.status})")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise CheckError(f"Notion page read failed (HTTP {error.code})") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CheckError("Notion page read failed (network)") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise CheckError("Notion page read response is too large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CheckError("Notion page read returned invalid JSON") from None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("markdown"), str)
        or value.get("truncated") is not False
        or value.get("unknown_block_ids") != []
    ):
        raise CheckError("Notion page read returned incomplete content")
    body = value["markdown"].encode("utf-8")
    return len(body), hashlib.sha256(body).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = RedactingArgumentParser(allow_abbrev=False)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--owner-uid", required=True, type=int)
    parser.add_argument("--owner-gid", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        if args.owner_uid < 0 or args.owner_gid < 0:
            raise CheckError("Notion credential owner is invalid")
        config = read_config(args.config)
        credential = Path(str(config["credentialPath"]))
        length, digest = check_page(config, read_token(credential, args.owner_uid, args.owner_gid))
    except CheckError as error:
        print(str(error), file=sys.stderr)
        return 4
    except BrokenPipeError:
        return 5
    except Exception:
        # Never expose a traceback containing the request or credential state.
        print("Notion page check failed unexpectedly", file=sys.stderr)
        return 5
    try:
        print(
            json.dumps(
                {
                    "target": str(credential),
                    "time": dt.datetime.now(dt.timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "permissions": {
                        "directory": "0700",
                        "file": "0600",
                        "ownerUid": args.owner_uid,
                        "ownerGid": args.owner_gid,
                    },
                    "pageReadable": True,
                    "bodyLength": length,
                    "bodySha256": digest,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    except BrokenPipeError:
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
