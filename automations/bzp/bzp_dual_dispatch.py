#!/usr/bin/env python3
"""Run the BLE monitor and fan out its user-facing stdout safely.

The successful monitor stdout contract is opaque: non-empty bytes are copied
unchanged to this process' stdout for the local Telegram no-agent cron.  The
same bytes are supplied on stdin to a fixed helper command over SSH for Rita's
WeChat delivery.  Message bytes never become shell text or an SSH argument.

Remote delivery is deliberately one-shot (no automatic retry).  An SSH error
after the remote send is ambiguous, so retrying here could duplicate a WeChat
message.  Failures are recorded only as metadata in the local JSONL log and
never written to stdout.

Planned local cron minute field: ``3-58/5`` (03,08,...,58).  No remote relay
cron is needed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from automation_paths import state_file


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SAFE_HOST_RE = re.compile(r"^[A-Za-z0-9_.@:-]+$")
SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]+$")
SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:@+-]+$")


def _safe_host(value: str) -> str:
    if not value or value.startswith("-") or not SAFE_HOST_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("ssh host contains unsafe characters")
    return value


def _safe_path(value: str) -> str:
    if not SAFE_PATH_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("remote helper must be a safe absolute path")
    return value


def _safe_token(value: str) -> str:
    if not value or value.startswith("-") or not SAFE_TOKEN_RE.fullmatch(value):
        raise argparse.ArgumentTypeError("value contains unsafe characters")
    return value


def append_log(path: str, event: str, **fields) -> None:
    """Append non-user-facing metadata; logging failure must not affect stdout."""
    try:
        parent = os.path.dirname(os.path.abspath(path)) or "."
        os.makedirs(parent, exist_ok=True)
        record = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "event": event,
            **fields,
        }
        line = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except OSError:
        pass


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="BLE monitor dual delivery: local stdout + Rita WeChat over SSH")
    parser.add_argument("--monitor-script",
                        default=os.path.join(SCRIPT_DIR, "bzp_ble_monitor.py"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--ssh-bin", default="/usr/bin/ssh")
    parser.add_argument("--ssh-host", required=True, type=_safe_host)
    parser.add_argument("--remote-helper", required=True, type=_safe_path)
    parser.add_argument("--weixin-sender-bin", required=True, type=_safe_path)
    parser.add_argument("--weixin-target", required=True, type=_safe_token)
    parser.add_argument("--log-file",
                        default=state_file("bzp_dual_dispatch.jsonl"))
    parser.add_argument("--monitor-timeout", type=float, default=90.0)
    parser.add_argument("--ssh-timeout", type=float, default=30.0)
    parser.add_argument("monitor_args", nargs=argparse.REMAINDER,
                        help="arguments passed unchanged to bzp_ble_monitor.py (after --)")
    opts = parser.parse_args(argv)
    if opts.monitor_args[:1] == ["--"]:
        opts.monitor_args = opts.monitor_args[1:]
    if opts.monitor_timeout <= 0 or opts.ssh_timeout <= 0:
        parser.error("timeouts must be positive")
    return opts


def _monitor_command(opts) -> list[str]:
    return [opts.python, opts.monitor_script, *opts.monitor_args]


def _ssh_command(opts) -> list[str]:
    # Everything after the host is fixed/strictly validated configuration.
    # User-facing message content is exclusively passed via stdin.
    return [
        opts.ssh_bin,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "--", opts.ssh_host,
        opts.remote_helper,
        "--sender-bin", opts.weixin_sender_bin,
        "--target", opts.weixin_target,
    ]


def dispatch_once(opts, stdout_buffer) -> int:
    """Run once.  Always return 0 so cron delivery depends solely on stdout."""
    try:
        monitor = subprocess.run(
            _monitor_command(opts), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=opts.monitor_timeout, check=False)
    except subprocess.TimeoutExpired:
        append_log(opts.log_file, "monitor_timeout")
        return 0
    except OSError as exc:
        append_log(opts.log_file, "monitor_exec_failed", error=type(exc).__name__)
        return 0

    if monitor.returncode != 0:
        append_log(opts.log_file, "monitor_failed", returncode=monitor.returncode)
        return 0
    payload = monitor.stdout or b""
    if not payload:
        return 0

    # Preserve the local Telegram contract byte-for-byte, including line endings.
    stdout_buffer.write(payload)
    stdout_buffer.flush()

    try:
        sent = subprocess.run(
            _ssh_command(opts), input=payload, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=opts.ssh_timeout, check=False)
    except subprocess.TimeoutExpired:
        append_log(opts.log_file, "ssh_timeout")
        return 0
    except OSError as exc:
        append_log(opts.log_file, "ssh_exec_failed", error=type(exc).__name__)
        return 0
    if sent.returncode != 0:
        append_log(opts.log_file, "ssh_failed", returncode=sent.returncode)
    return 0


def main(argv=None) -> int:
    return dispatch_once(parse_args(argv), sys.stdout.buffer)


if __name__ == "__main__":
    raise SystemExit(main())
