#!/usr/bin/env python3
"""Rita-side stdin relay for a repository-independent WeChat sender.

This helper prints nothing.  It reads one bounded UTF-8 message from stdin and
passes the exact bytes on stdin to one explicitly configured sender executable.
The sender's stdout/stderr are suppressed so internal errors cannot become
wife-facing content through a command-output delivery path.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys


SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:@+-]+$")


def _safe_token(value: str) -> str:
    if not value or value.startswith("-") or not SAFE_TOKEN_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("value contains unsafe characters")
    return value


def _safe_path(value: str) -> str:
    if not value.startswith("/") or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value):
        raise argparse.ArgumentTypeError("sender executable must be a safe absolute path")
    return value


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="stdin to external WeChat sender relay")
    parser.add_argument("--sender-bin", required=True, type=_safe_path,
                        help="executable accepting --target and message bytes on stdin")
    parser.add_argument("--target", required=True, type=_safe_token)
    parser.add_argument("--max-bytes", type=int, default=65536)
    parser.add_argument("--send-timeout", type=float, default=30.0)
    opts = parser.parse_args(argv)
    if opts.max_bytes <= 0 or opts.send_timeout <= 0:
        parser.error("limits must be positive")
    return opts


def relay_once(opts, stdin_buffer, _stdout) -> int:
    """Return nonzero on rejection/send failure, while always keeping stdout empty."""
    data = stdin_buffer.read(opts.max_bytes + 1)
    if not data or len(data) > opts.max_bytes or b"\x00" in data:
        return 64
    try:
        message = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return 64
    try:
        result = subprocess.run([
            opts.sender_bin, "--target", opts.target,
        ], input=message.encode("utf-8"), stdout=subprocess.DEVNULL,
           stderr=subprocess.DEVNULL, timeout=opts.send_timeout,
           check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired):
        return 70
    return 0 if result.returncode == 0 else 70


def main(argv=None) -> int:
    return relay_once(parse_args(argv), sys.stdin.buffer, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
