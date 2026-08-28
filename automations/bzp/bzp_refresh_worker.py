#!/usr/bin/env python3
"""Process durable Rita refresh requests without holding the SSH session open."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from bzp_ble_monitor import FlockLock
from bzp_snapshot import publish_from_state_files


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_ORDER = ("electric", "water")


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _ensure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def claim_requests(queue_root: str) -> list[Path]:
    root = Path(queue_root)
    pending = root / "pending"
    processing = root / "processing"
    for directory in (root, pending, processing):
        _ensure_directory(directory)
    claimed = sorted(path for path in processing.iterdir() if path.is_file() and path.suffix == ".json")
    for source in sorted(path for path in pending.iterdir() if path.is_file() and path.suffix == ".json"):
        target = processing / source.name
        try:
            os.replace(source, target)
        except FileNotFoundError:
            continue
        claimed.append(target)
    _fsync_directory(pending)
    _fsync_directory(processing)
    return sorted(set(claimed))


def request_targets(paths: list[Path]) -> list[str]:
    requested = set()
    for path in paths:
        if path.stat().st_size > 4096:
            raise ValueError(f"oversized refresh request: {path.name}")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise ValueError(f"invalid refresh request: {path.name}")
        target = value.get("target")
        if target not in ("electric", "water", "all"):
            raise ValueError(f"invalid refresh target: {path.name}")
        if target == "all":
            requested.update(TARGET_ORDER)
        else:
            requested.add(target)
    return [target for target in TARGET_ORDER if target in requested]


def monitor_command(opts, meter: str) -> list[str]:
    prefix = meter.replace("-", "_")
    return [
        opts.python,
        opts.monitor_script,
        "--force-read",
        "--fail-on-read-error",
        "--meter-kind", meter,
        "--state-file", getattr(opts, f"{prefix}_state"),
        "--log-file", getattr(opts, f"{prefix}_log"),
        "--lock-file", opts.hci_lock,
        "--reader-script", opts.reader_script,
        "--auth-file", opts.auth_file,
        "--sn", getattr(opts, f"{prefix}_sn"),
        "--mac", getattr(opts, f"{prefix}_mac"),
        "--low-power-threshold", str(getattr(opts, f"{prefix}_threshold")),
        "--read-budget", str(opts.read_budget),
        "--max-rounds", str(opts.max_rounds),
        "--lock-timeout", str(opts.hci_lock_timeout),
    ]


def complete_requests(paths: list[Path]) -> None:
    directories = set()
    for path in paths:
        directories.add(path.parent)
        path.unlink()
    for directory in directories:
        _fsync_directory(directory)


def run_worker(opts) -> int:
    worker_lock = FlockLock(opts.worker_lock)
    if not worker_lock.acquire(0):
        return 0
    try:
        claimed = claim_requests(opts.queue_root)
        if not claimed:
            return 0
        targets = request_targets(claimed)
        operation_lock = FlockLock(opts.operation_lock)
        if not operation_lock.acquire(opts.operation_lock_timeout):
            return 0
        failures = []
        try:
            for meter in targets:
                try:
                    result = subprocess.run(
                        monitor_command(opts, meter), stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE, timeout=opts.monitor_timeout, check=False,
                    )
                except (OSError, subprocess.TimeoutExpired) as error:
                    failures.append(f"{meter}:{type(error).__name__}")
                    continue
                if result.returncode != 0:
                    failures.append(f"{meter}:exit={result.returncode}")
            try:
                publication = publish_from_state_files(opts)
                sys.stderr.write(json.dumps({"targets": targets, **publication}, sort_keys=True) + "\n")
            except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
                failures.append(f"publish:{error}")
            if failures:
                sys.stderr.write("BZP refresh incomplete: %s\n" % ",".join(failures))
                return 70
            complete_requests(claimed)
            return 0
        finally:
            operation_lock.release()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        sys.stderr.write(f"BZP refresh queue failed: {error}\n")
        return 70
    finally:
        worker_lock.release()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="process queued BZP refresh requests")
    base = "/home/herman/.dsh/storages/automations/bzp"
    parser.add_argument("--queue-root", default=f"{base}/refresh-requests")
    parser.add_argument("--worker-lock", default=f"{base}/refresh-worker.lock")
    parser.add_argument("--operation-lock", default=f"{base}/operation.lock")
    parser.add_argument("--operation-lock-timeout", type=float, default=5.0)
    parser.add_argument("--hci-lock", default=f"{base}/hci0.lock")
    parser.add_argument("--hci-lock-timeout", type=float, default=5.0)
    parser.add_argument("--monitor-script", default=os.path.join(SCRIPT_DIR, "bzp_ble_monitor.py"))
    parser.add_argument("--reader-script", default=os.path.join(SCRIPT_DIR, "bzp_ble_read_until_success.py"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--auth-file", default="/home/herman/.local/share/bzp-ble/auth.json")
    parser.add_argument("--electric-state", default=f"{base}/electric/state.json")
    parser.add_argument("--water-state", default=f"{base}/water/state.json")
    parser.add_argument("--electric-log", default=f"{base}/electric/monitor.log")
    parser.add_argument("--water-log", default=f"{base}/water/monitor.log")
    parser.add_argument("--electric-sn", default="YM00236K2A68")
    parser.add_argument("--electric-mac", default="23:06:20:00:2A:68")
    parser.add_argument("--water-sn", default="YM00234J0667")
    parser.add_argument("--water-mac", default="23:04:19:00:06:67")
    parser.add_argument("--electric-threshold", type=float, default=10)
    parser.add_argument("--water-threshold", type=float, default=5)
    parser.add_argument("--read-budget", type=float, default=300)
    parser.add_argument("--max-rounds", type=int, default=10)
    parser.add_argument("--monitor-timeout", type=float, default=350)
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
    opts = parser.parse_args(argv)
    if not opts.image_id:
        parser.error("--image-id or DSH_IMAGE_ID is required")
    opts.reason = "requested"
    return opts


def main(argv=None) -> int:
    return run_worker(parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
