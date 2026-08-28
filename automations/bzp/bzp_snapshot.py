#!/usr/bin/env python3
"""Build and atomically publish the combined electric/water snapshot to Rita."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
MAX_SNAPSHOT_BYTES = 131_072
SAFE_HOST = re.compile(r"^[A-Za-z0-9_.@:-]+$")
SAFE_REMOTE_PATH = re.compile(r"^/home/rita/[A-Za-z0-9_./-]+$")
IMAGE_ID = re.compile(r"^(?:sha256:)?[a-f0-9]{64}$")
UNITS = {"electric": "kWh", "water": "m3"}


def _iso_timestamp(value: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty ISO-8601 timestamp")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must include an offset")
    return value


def _finite_number(value, label: str):
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return value


def _switch_state(value, label: str) -> int:
    if isinstance(value, bool):
        value = int(value)
    try:
        value = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be 0 or 1") from error
    if value not in (0, 1):
        raise ValueError(f"{label} must be 0 or 1")
    return value


def _last_success(state: dict, meter: str):
    value = state.get("last_success")
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("source") != "ble_live":
        raise ValueError(f"{meter}.last_success must come from ble_live")
    return {
        "readAt": _iso_timestamp(value.get("read_at") or value.get("at"), f"{meter}.lastSuccess.readAt"),
        "total": _finite_number(value.get("total"), f"{meter}.lastSuccess.total"),
        "surplus": _finite_number(value.get("surplus"), f"{meter}.lastSuccess.surplus"),
        "switchState": _switch_state(
            value.get("switch_state", value.get("switchState")),
            f"{meter}.lastSuccess.switchState",
        ),
        "source": "ble_live",
    }


def _last_attempt(state: dict, meter: str):
    value = state.get("last_read_attempt")
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
        raise ValueError(f"{meter}.lastAttempt is invalid")
    reason = value.get("reason")
    if not isinstance(reason, str) or not reason or len(reason) > 160:
        raise ValueError(f"{meter}.lastAttempt.reason is invalid")
    return {
        "at": _iso_timestamp(value.get("at"), f"{meter}.lastAttempt.at"),
        "ok": value["ok"],
        "reason": reason,
    }


def load_monitor_state(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"monitor state is not an object: {path}")
    return value


def normalize_image_id(value: str) -> str:
    if not isinstance(value, str) or not IMAGE_ID.fullmatch(value):
        raise ValueError("DSH_IMAGE_ID must be a 64-hex image identity")
    return value if value.startswith("sha256:") else f"sha256:{value}"


def build_snapshot(electric_state: dict, water_state: dict, *, published_at: str,
                   producer_image_id: str, publication_reason: str) -> dict:
    if publication_reason not in ("scheduled", "requested"):
        raise ValueError("publicationReason must be scheduled or requested")
    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "publishedAt": _iso_timestamp(published_at, "publishedAt"),
        "producerImageId": normalize_image_id(producer_image_id),
        "publicationReason": publication_reason,
        "meters": {},
    }
    for meter, state in (("electric", electric_state), ("water", water_state)):
        snapshot["meters"][meter] = {
            "unit": UNITS[meter],
            "lastSuccess": _last_success(state, meter),
            "lastAttempt": _last_attempt(state, meter),
        }
    validate_snapshot(snapshot)
    return snapshot


def validate_snapshot(snapshot: dict) -> None:
    if not isinstance(snapshot, dict) or set(snapshot) != {
        "schemaVersion", "publishedAt", "producerImageId", "publicationReason", "meters"
    }:
        raise ValueError("snapshot top-level fields are invalid")
    if snapshot["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("snapshot schemaVersion is invalid")
    _iso_timestamp(snapshot["publishedAt"], "publishedAt")
    normalize_image_id(snapshot["producerImageId"])
    if snapshot["publicationReason"] not in ("scheduled", "requested"):
        raise ValueError("snapshot publicationReason is invalid")
    if not isinstance(snapshot["meters"], dict) or set(snapshot["meters"]) != set(UNITS):
        raise ValueError("snapshot meters are invalid")
    for meter, unit in UNITS.items():
        projection = snapshot["meters"][meter]
        if not isinstance(projection, dict) or set(projection) != {"unit", "lastSuccess", "lastAttempt"}:
            raise ValueError(f"{meter} projection fields are invalid")
        if projection["unit"] != unit:
            raise ValueError(f"{meter} unit is invalid")
        if projection["lastSuccess"] is not None:
            success = projection["lastSuccess"]
            if not isinstance(success, dict) or set(success) != {
                "readAt", "total", "surplus", "switchState", "source"
            } or success["source"] != "ble_live":
                raise ValueError(f"{meter}.lastSuccess is invalid")
            _iso_timestamp(success["readAt"], f"{meter}.lastSuccess.readAt")
            _finite_number(success["total"], f"{meter}.lastSuccess.total")
            _finite_number(success["surplus"], f"{meter}.lastSuccess.surplus")
            _switch_state(success["switchState"], f"{meter}.lastSuccess.switchState")
        if projection["lastAttempt"] is not None:
            attempt = projection["lastAttempt"]
            if not isinstance(attempt, dict) or set(attempt) != {"at", "ok", "reason"}:
                raise ValueError(f"{meter}.lastAttempt is invalid")
            _iso_timestamp(attempt["at"], f"{meter}.lastAttempt.at")
            if not isinstance(attempt["ok"], bool) or not isinstance(attempt["reason"], str):
                raise ValueError(f"{meter}.lastAttempt is invalid")


def snapshot_bytes(snapshot: dict) -> bytes:
    validate_snapshot(snapshot)
    payload = (json.dumps(
        snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n").encode("utf-8")
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot exceeds byte limit")
    return payload


REMOTE_ATOMIC_WRITER = r'''
import hashlib,json,math,os,sys,uuid
limit=131072
target=sys.argv[1]
payload=sys.stdin.buffer.read(limit+1)
if not payload or len(payload)>limit: raise SystemExit(64)
value=json.loads(payload)
if value.get("schemaVersion")!=1 or value.get("publicationReason") not in ("scheduled","requested"): raise SystemExit(64)
if set(value.get("meters",{}))!={"electric","water"}: raise SystemExit(64)
for name,unit in (("electric","kWh"),("water","m3")):
 p=value["meters"][name]
 if p.get("unit")!=unit: raise SystemExit(64)
 success=p.get("lastSuccess")
 if success is not None:
  if success.get("source")!="ble_live" or success.get("switchState") not in (0,1): raise SystemExit(64)
  if any(isinstance(success.get(k),bool) or not math.isfinite(float(success.get(k))) for k in ("total","surplus")): raise SystemExit(64)
parent=os.path.dirname(target)
os.makedirs(parent,mode=0o700,exist_ok=True)
os.chmod(parent,0o700)
tmp=os.path.join(parent,".latest.json.tmp."+uuid.uuid4().hex)
backup=os.path.join(parent,".latest.json.before."+uuid.uuid4().hex)
had_old=os.path.isfile(target)
directory=os.open(parent,os.O_RDONLY)
if had_old:
 os.link(target,backup)
 os.fsync(directory)
replaced=False
try:
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,"wb") as handle:
  handle.write(payload); handle.flush(); os.fsync(handle.fileno())
 os.replace(tmp,target); replaced=True; os.chmod(target,0o600)
 os.fsync(directory)
except BaseException:
 try: os.unlink(tmp)
 except FileNotFoundError: pass
 if replaced:
  if had_old: os.replace(backup,target)
  else:
   try: os.unlink(target)
   except FileNotFoundError: pass
  os.fsync(directory)
 else:
  try: os.unlink(backup)
  except FileNotFoundError: pass
 raise
finally:
 os.close(directory)
try: os.unlink(backup)
except FileNotFoundError: pass
sys.stdout.write("sha256:"+hashlib.sha256(payload).hexdigest()+"\n")
'''.strip()


def ssh_command(opts) -> list[str]:
    if not SAFE_HOST.fullmatch(opts.ssh_host) or opts.ssh_host.startswith("-"):
        raise ValueError("unsafe SSH host")
    if not SAFE_REMOTE_PATH.fullmatch(opts.remote_path):
        raise ValueError("unsafe Rita snapshot path")
    remote = "/usr/bin/python3 -c %s %s" % (
        shlex.quote(REMOTE_ATOMIC_WRITER), shlex.quote(opts.remote_path)
    )
    return [
        opts.ssh_bin,
        "-i", opts.ssh_key,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", f"ConnectTimeout={opts.connect_timeout}",
        "--", opts.ssh_host, remote,
    ]


def publish_bytes(payload: bytes, opts, runner=subprocess.run) -> str:
    expected = "sha256:" + hashlib.sha256(payload).hexdigest()
    try:
        result = runner(
            ssh_command(opts), input=payload, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=opts.ssh_timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Rita snapshot SSH failed: {type(error).__name__}") from error
    if result.returncode != 0:
        raise RuntimeError(f"Rita snapshot writer failed with exit {result.returncode}")
    returned = result.stdout.decode("ascii", "strict").strip()
    if returned != expected:
        raise RuntimeError("Rita snapshot digest mismatch")
    return expected


def publish_from_state_files(opts) -> dict:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    snapshot = build_snapshot(
        load_monitor_state(opts.electric_state),
        load_monitor_state(opts.water_state),
        published_at=now,
        producer_image_id=opts.image_id,
        publication_reason=opts.reason,
    )
    payload = snapshot_bytes(snapshot)
    digest = publish_bytes(payload, opts)
    return {"publishedAt": snapshot["publishedAt"], "sha256": digest, "bytes": len(payload)}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="publish combined BZP meter snapshot to Rita")
    parser.add_argument("--electric-state", required=True)
    parser.add_argument("--water-state", required=True)
    parser.add_argument("--reason", choices=("scheduled", "requested"), required=True)
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
    if opts.connect_timeout <= 0 or opts.ssh_timeout <= 0:
        parser.error("SSH timeouts must be positive")
    return opts


def main(argv=None) -> int:
    result = publish_from_state_files(parse_args(argv))
    sys.stderr.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
