#!/usr/bin/env python3
"""Hold exactly one advisory flock until stdin closes or the process stops."""

from __future__ import annotations

import argparse
import fcntl
import os
import signal
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    args = parser.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.path)), mode=0o700, exist_ok=True)
    def stop(_signum: int, _frame: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with open(args.path, "a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        sys.stdout.write("LOCKED\n")
        sys.stdout.flush()
        while sys.stdin.buffer.readline():
            pass
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
