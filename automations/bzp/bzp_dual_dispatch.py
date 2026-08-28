#!/usr/bin/env python3
"""Run one scheduled meter monitor, then publish the combined Rita snapshot.

The monitor stdout remains the exact Telegram business payload. Rita no
longer receives a chat message: each successful dispatch writes one complete
electric/water JSON snapshot through bzp_snapshot.py.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from bzp_ble_monitor import FlockLock
from bzp_snapshot import publish_from_state_files


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="scheduled BZP monitor and Rita snapshot publisher")
    parser.add_argument("--meter", choices=("electric", "water"), required=True)
    parser.add_argument("--operation-lock", required=True)
    parser.add_argument("--operation-lock-timeout", type=float, default=5.0)
    parser.add_argument("--monitor-script", default=os.path.join(SCRIPT_DIR, "bzp_ble_monitor.py"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--monitor-timeout", type=float, default=360.0)
    parser.add_argument("--electric-state", required=True)
    parser.add_argument("--water-state", required=True)
    parser.add_argument("--image-id", default=os.environ.get("DSH_IMAGE_ID"))
    parser.add_argument("--ssh-bin", default="/usr/bin/ssh")
    parser.add_argument("--ssh-key", required=True)
    parser.add_argument("--ssh-host", default="rita@192.168.6.239")
    parser.add_argument(
        "--remote-path",
        default="/home/rita/.local/state/dsh-automations/bzp/latest.json",
    )
    parser.add_argument("--connect-timeout", type=int, default=10)
    parser.add_argument("--ssh-timeout", type=float, default=30.0)
    parser.add_argument("monitor_args", nargs=argparse.REMAINDER)
    opts = parser.parse_args(argv)
    if opts.monitor_args[:1] == ["--"]:
        opts.monitor_args = opts.monitor_args[1:]
    if not opts.monitor_args:
        parser.error("monitor arguments after -- are required")
    if opts.operation_lock_timeout < 0 or opts.monitor_timeout <= 0:
        parser.error("timeouts are invalid")
    if not opts.image_id:
        parser.error("--image-id or DSH_IMAGE_ID is required")
    opts.reason = "scheduled"
    return opts


def monitor_command(opts) -> list[str]:
    return [opts.python, opts.monitor_script, *opts.monitor_args]


def dispatch_once(opts, stdout_buffer) -> int:
    operation_lock = FlockLock(opts.operation_lock)
    if not operation_lock.acquire(opts.operation_lock_timeout):
        return 0
    try:
        try:
            monitor = subprocess.run(
                monitor_command(opts), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=opts.monitor_timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            sys.stderr.write("BZP monitor timed out\n")
            return 70
        except OSError as error:
            sys.stderr.write(f"BZP monitor exec failed: {type(error).__name__}\n")
            return 70
        if monitor.returncode != 0:
            sys.stderr.write(f"BZP monitor failed with exit {monitor.returncode}\n")
            return monitor.returncode

        payload = monitor.stdout or b""
        if payload:
            stdout_buffer.write(payload)
            stdout_buffer.flush()

        result = publish_from_state_files(opts)
        sys.stderr.write(json.dumps({"meter": opts.meter, **result}, sort_keys=True) + "\n")
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        sys.stderr.write(f"BZP snapshot publication failed: {error}\n")
        return 70
    finally:
        operation_lock.release()


def main(argv=None) -> int:
    return dispatch_once(parse_args(argv), sys.stdout.buffer)


if __name__ == "__main__":
    raise SystemExit(main())
