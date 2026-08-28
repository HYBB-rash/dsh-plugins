from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace


BZP = Path(__file__).resolve().parents[1] / "bzp"
sys.path.insert(0, str(BZP))

import bzp_ble_monitor
import bzp_refresh_enqueue
import bzp_refresh_worker
import bzp_snapshot
import bzp_forced_key


IMAGE_ID = "a" * 64
NOW = "2026-08-28T05:00:00Z"


def monitor_state(total=100.5, surplus=12.25, switch=1, *, ok=True, reason="ok"):
    return {
        "last_success": {
            "read_at": "2026-08-28T12:59:00+08:00",
            "total": total,
            "surplus": surplus,
            "switch_state": switch,
            "source": "ble_live",
        },
        "last_read_attempt": {
            "at": "2026-08-28T13:00:00+08:00",
            "ok": ok,
            "reason": reason,
        },
    }


def publisher_opts(**overrides):
    values = {
        "ssh_bin": "/usr/bin/ssh",
        "ssh_key": "/home/herman/.ssh/bzp",
        "ssh_host": "rita@192.168.6.239",
        "remote_path": "/home/rita/.local/state/dsh-automations/bzp/latest.json",
        "connect_timeout": 10,
        "ssh_timeout": 30.0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class SnapshotTests(unittest.TestCase):
    def test_combined_snapshot_keeps_both_meters_and_exact_units(self):
        snapshot = bzp_snapshot.build_snapshot(
            monitor_state(), monitor_state(total=55, surplus=4.5, switch=0),
            published_at=NOW, producer_image_id=IMAGE_ID,
            publication_reason="scheduled",
        )
        self.assertEqual(snapshot["producerImageId"], f"sha256:{IMAGE_ID}")
        self.assertEqual(snapshot["meters"]["electric"]["unit"], "kWh")
        self.assertEqual(snapshot["meters"]["water"]["unit"], "m3")
        self.assertEqual(snapshot["meters"]["water"]["lastSuccess"]["switchState"], 0)
        self.assertEqual(snapshot["meters"]["electric"]["lastSuccess"]["source"], "ble_live")

    def test_absent_reading_is_null_and_failed_attempt_does_not_erase_old_success(self):
        empty = bzp_snapshot.build_snapshot(
            {}, {}, published_at=NOW, producer_image_id=IMAGE_ID,
            publication_reason="requested",
        )
        self.assertIsNone(empty["meters"]["electric"]["lastSuccess"])
        self.assertIsNone(empty["meters"]["water"]["lastAttempt"])

        failed = monitor_state(ok=False, reason="timeout")
        projected = bzp_snapshot.build_snapshot(
            failed, {}, published_at=NOW, producer_image_id=IMAGE_ID,
            publication_reason="requested",
        )["meters"]["electric"]
        self.assertEqual(projected["lastSuccess"]["total"], 100.5)
        self.assertEqual(projected["lastAttempt"], {
            "at": "2026-08-28T13:00:00+08:00", "ok": False, "reason": "timeout"
        })

    def test_rejects_nonfinite_wrong_switch_and_nonlive_values(self):
        for state in (
            monitor_state(total=float("nan")),
            monitor_state(switch=2),
            {**monitor_state(), "last_success": {**monitor_state()["last_success"], "source": "cache"}},
        ):
            with self.subTest(state=state):
                with self.assertRaises(ValueError):
                    bzp_snapshot.build_snapshot(
                        state, {}, published_at=NOW, producer_image_id=IMAGE_ID,
                        publication_reason="scheduled",
                    )

    def test_fixed_json_bytes_and_remote_atomic_writer_permissions(self):
        snapshot = bzp_snapshot.build_snapshot(
            monitor_state(), monitor_state(), published_at=NOW,
            producer_image_id=IMAGE_ID, publication_reason="scheduled",
        )
        payload = bzp_snapshot.snapshot_bytes(snapshot)
        self.assertEqual(payload, bzp_snapshot.snapshot_bytes(snapshot))
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "rita" / "latest.json"
            result = subprocess.run(
                [sys.executable, "-c", bzp_snapshot.REMOTE_ATOMIC_WRITER, str(target)],
                input=payload, capture_output=True, check=False,
            )
            expected = "sha256:" + hashlib.sha256(payload).hexdigest()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout.decode().strip(), expected)
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)

            old = target.read_bytes()
            rejected = subprocess.run(
                [sys.executable, "-c", bzp_snapshot.REMOTE_ATOMIC_WRITER, str(target)],
                input=b"{}\n", capture_output=True, check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(target.read_bytes(), old)
            self.assertEqual(list(target.parent.glob(".latest.json.tmp.*")), [])
            self.assertEqual(list(target.parent.glob(".latest.json.before.*")), [])

    def test_ssh_failure_remote_failure_and_digest_mismatch_fail_closed(self):
        payload = b"payload\n"
        expected = b"sha256:" + hashlib.sha256(payload).hexdigest().encode() + b"\n"
        cases = [
            SimpleNamespace(returncode=255, stdout=b"", stderr=b"ssh"),
            SimpleNamespace(returncode=1, stdout=b"", stderr=b"remote"),
            SimpleNamespace(returncode=0, stdout=b"sha256:" + b"0" * 64 + b"\n", stderr=b""),
        ]
        for result in cases:
            with self.subTest(result=result):
                with self.assertRaises(RuntimeError):
                    bzp_snapshot.publish_bytes(payload, publisher_opts(), runner=lambda *a, **k: result)
        self.assertEqual(
            bzp_snapshot.publish_bytes(
                payload, publisher_opts(),
                runner=lambda *a, **k: SimpleNamespace(returncode=0, stdout=expected, stderr=b""),
            ),
            expected.decode().strip(),
        )


class MonitorStateTests(unittest.TestCase):
    def test_nonattempt_preserves_attempt_and_failure_preserves_success(self):
        opts = bzp_ble_monitor.default_opts()
        old = bzp_ble_monitor.new_state()
        old["last_success"] = {
            "at": "2026-08-28T12:00:00+08:00", "epoch": 1,
            "total": 10, "surplus": 20, "switch_state": 1,
            "source": "ble_live", "read_at": "2026-08-28T12:00:00+08:00",
        }
        old["last_success_hour"] = "2026-08-28T12"
        old["last_read_attempt"] = {"at": "2026-08-28T12:00:00+08:00", "ok": True, "reason": "ok"}
        now = bzp_ble_monitor.parse_dt("2026-08-28T12:05:00+08:00")
        unchanged, _ = bzp_ble_monitor.apply_outcome(old, now, opts, False, None, attempted=False)
        self.assertEqual(unchanged["last_read_attempt"], old["last_read_attempt"])
        failed, _ = bzp_ble_monitor.apply_outcome(
            old, now, opts, False, None, attempted=True, failure_reason="timeout"
        )
        self.assertEqual(failed["last_success"], old["last_success"])
        self.assertEqual(failed["last_read_attempt"]["reason"], "timeout")

    def test_shared_flock_rejects_parallel_holder(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "hci0.lock")
            first = bzp_ble_monitor.FlockLock(path)
            second = bzp_ble_monitor.FlockLock(path)
            self.assertTrue(first.acquire(0))
            try:
                self.assertFalse(second.acquire(0))
            finally:
                first.release()


class RefreshQueueTests(unittest.TestCase):
    def test_three_commands_enqueue_and_short_duplicate_coalesces(self):
        now = datetime(2026, 8, 28, 5, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            for index, target in enumerate(("electric", "water", "all")):
                result = bzp_refresh_enqueue.enqueue_request(
                    f"refresh {target}", str(Path(tmp) / target), now=now,
                    request_id=str(uuid.UUID(int=index + 1)),
                )
                self.assertTrue(result["queued"])
            root = Path(tmp) / "dedupe"
            first = bzp_refresh_enqueue.enqueue_request(
                "refresh electric", str(root), now=now, request_id=str(uuid.UUID(int=10))
            )
            second = bzp_refresh_enqueue.enqueue_request("refresh electric", str(root), now=now)
            self.assertFalse(first["coalesced"])
            self.assertTrue(second["coalesced"])
            self.assertEqual(len(list((root / "pending").glob("*.json"))), 1)

    def test_invalid_command_and_full_queue_never_acknowledge_a_new_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                bzp_refresh_enqueue.enqueue_request("refresh shell", tmp)
            bzp_refresh_enqueue.enqueue_request(
                "refresh electric", tmp, max_requests=1, dedupe_seconds=0,
                request_id=str(uuid.UUID(int=20)),
            )
            with self.assertRaises(OverflowError):
                bzp_refresh_enqueue.enqueue_request("refresh water", tmp, max_requests=1)

    def test_full_queue_still_acknowledges_a_durable_recent_duplicate(self):
        now = datetime(2026, 8, 28, 5, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            bzp_refresh_enqueue.enqueue_request(
                "refresh electric", tmp, max_requests=1, now=now,
                request_id=str(uuid.UUID(int=21)),
            )
            duplicate = bzp_refresh_enqueue.enqueue_request(
                "refresh electric", tmp, max_requests=1, now=now,
            )
            self.assertTrue(duplicate["coalesced"])

    def test_forced_command_stdout_is_exact_ack_after_durable_enqueue(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "SSH_ORIGINAL_COMMAND": "refresh all"}
            accepted = subprocess.run(
                [sys.executable, str(BZP / "bzp_refresh_enqueue.py"), "--queue-root", tmp],
                env=env, capture_output=True, check=False,
            )
            self.assertEqual(accepted.returncode, 0)
            self.assertEqual(accepted.stdout, "收到\n".encode())
            self.assertEqual(len(list((Path(tmp) / "pending").glob("*.json"))), 1)
            rejected = subprocess.run(
                [sys.executable, str(BZP / "bzp_refresh_enqueue.py"), "--queue-root", tmp],
                env={**os.environ, "SSH_ORIGINAL_COMMAND": "uname -a"},
                capture_output=True, check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(rejected.stdout, b"")

    def test_worker_recovers_processing_and_orders_coalesced_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in (root / "pending", root / "processing"):
                directory.mkdir(parents=True, mode=0o700)
            records = [
                (root / "processing" / "one.json", "water"),
                (root / "pending" / "two.json", "electric"),
                (root / "pending" / "three.json", "electric"),
            ]
            for index, (path, target) in enumerate(records):
                path.write_text(json.dumps({
                    "schemaVersion": 1,
                    "requestId": str(uuid.UUID(int=index + 100)),
                    "target": target,
                    "enqueuedAt": NOW,
                }) + "\n", encoding="utf-8")
            claimed = bzp_refresh_worker.claim_requests(str(root))
            self.assertEqual(len(claimed), 3)
            self.assertEqual(bzp_refresh_worker.request_targets(claimed), ["electric", "water"])
            self.assertEqual(len(list((root / "processing").glob("*.json"))), 3)

    def test_forced_key_install_is_exact_idempotent_and_marker_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "rita.pub"
            authorized = root / ".ssh" / "authorized_keys"
            public.write_text("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAA rita\n")
            authorized.parent.mkdir()
            authorized.write_text("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBB other\n")
            first = bzp_forced_key.install(str(public), str(authorized))
            second = bzp_forced_key.install(str(public), str(authorized))
            text = authorized.read_text()
            self.assertTrue(first["changed"])
            self.assertFalse(second["changed"])
            self.assertIn("restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding", text)
            self.assertIn("command=\"docker exec --env SSH_ORIGINAL_COMMAND dsh-telegram", text)
            self.assertEqual(text.count(bzp_forced_key.MARKER), 1)
            removed = bzp_forced_key.remove(str(authorized))
            self.assertTrue(removed["changed"])
            self.assertIn(" other\n", authorized.read_text())
            self.assertNotIn(bzp_forced_key.MARKER, authorized.read_text())


if __name__ == "__main__":
    unittest.main()
