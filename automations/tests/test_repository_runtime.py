from __future__ import annotations

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
AUTOMATIONS = ROOT / "automations"
SCRIPTS = AUTOMATIONS / "scripts"
BZP = AUTOMATIONS / "bzp"
CRON = AUTOMATIONS / "cron"
for source_dir in (SCRIPTS, BZP, CRON):
    sys.path.insert(0, str(source_dir))

import automation_paths
import bzp_dual_dispatch
import bzp_weixin_relay
import cron_conflict_check


class RepositoryIndependenceTests(unittest.TestCase):
    def test_active_automation_sources_do_not_reference_openclaw_runtime(self):
        forbidden = (
            ".openclaw",
            "openclaw-gateway",
            "openclaw-bin",
            "openclaw-weixin",
            "tools.call",
            "cron_changed",
        )
        offenders = []
        for path in AUTOMATIONS.rglob("*"):
            if AUTOMATIONS / "tests" in path.parents:
                continue
            if not path.is_file() or path.suffix not in {".py", ".sh", ".js", ".cjs"}:
                continue
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                if marker in text:
                    offenders.append(f"{path.relative_to(ROOT)}: {marker}")
        self.assertEqual(offenders, [])

    def test_retired_openclaw_sources_are_not_shipped(self):
        self.assertFalse((AUTOMATIONS / "legacy-openclaw").exists())
        retired_names = {
            "baozupo_ble_reminder.sh",
            "relay_shutdown_reminder.sh",
            "trade_system_reminder.sh",
            "rest_break_alarm.sh",
            "openclaw_daily_brief.sh",
            "openclaw_weekly_brief.sh",
            "info_monitor.py",
            "mywechat_sync_daemon.sh",
        }
        found = [
            str(path.relative_to(ROOT))
            for path in AUTOMATIONS.rglob("*")
            if path.is_file() and path.name in retired_names
        ]
        self.assertEqual(found, [])

    def test_only_shared_automation_support_stays_in_scripts(self):
        source_files = {
            path.name
            for path in SCRIPTS.iterdir()
            if path.is_file() and path.suffix in {".py", ".sh", ".js", ".cjs"}
        }
        self.assertEqual(source_files, {"automation_paths.py"})

    def test_direct_task_entrypoints_keep_executable_mode(self):
        entrypoints = (
            BZP / "bzp_ble_monitor.py",
            BZP / "bzp_ble_read_until_success.py",
            BZP / "bzp_dual_dispatch.py",
            BZP / "bzp_weixin_relay.py",
            CRON / "cron_conflict_check.py",
            AUTOMATIONS / "deepseek" / "deepseek_daily.sh",
            AUTOMATIONS / "mywechat" / "mywechat_ai_context_daily.sh",
            AUTOMATIONS / "mywechat" / "mywechat_ai_context_hourly.sh",
            AUTOMATIONS / "mywechat" / "mywechat_pull.sh",
            AUTOMATIONS / "mywechat" / "mywechat_watchdog.sh",
            AUTOMATIONS / "telegram" / "send_tg_ops.sh",
        )
        self.assertEqual(
            [str(path.relative_to(ROOT)) for path in entrypoints if not os.access(path, os.X_OK)],
            [],
        )


class PathTests(unittest.TestCase):
    def test_default_state_is_under_dsh_home_without_creating_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dsh"
            with mock.patch.dict(os.environ, {"DSH_HOME": str(target)}, clear=False):
                os.environ.pop("DSH_AUTOMATION_STATE_DIR", None)
                self.assertEqual(
                    automation_paths.state_dir(), target / "storages" / "automations")
                self.assertFalse(target.exists())

    def test_explicit_automation_state_root_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(
                os.environ, {"DSH_AUTOMATION_STATE_DIR": str(Path(tmp) / "state")}, clear=False
            ):
                self.assertEqual(
                    automation_paths.state_file("monitor.json"),
                    str(Path(tmp) / "state" / "monitor.json"),
                )


class RelayTests(unittest.TestCase):
    def test_relay_passes_message_on_stdin_without_openclaw_arguments(self):
        opts = SimpleNamespace(
            sender_bin="/opt/weixin/send",
            target="wife",
            max_bytes=1024,
            send_timeout=3.0,
        )
        completed = SimpleNamespace(returncode=0)
        with mock.patch.object(bzp_weixin_relay.subprocess, "run", return_value=completed) as run:
            code = bzp_weixin_relay.relay_once(opts, io.BytesIO("电量正常".encode()), None)
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.args[0], ["/opt/weixin/send", "--target", "wife"])
        self.assertEqual(run.call_args.kwargs["input"], "电量正常".encode())

    def test_dispatch_passes_explicit_remote_sender(self):
        opts = SimpleNamespace(
            ssh_bin="/usr/bin/ssh",
            ssh_host="rita.hermes",
            remote_helper="/opt/dsh/automations/bzp/bzp_weixin_relay.py",
            weixin_sender_bin="/opt/weixin/send",
            weixin_target="wife",
        )
        command = bzp_dual_dispatch._ssh_command(opts)
        self.assertIn("--sender-bin", command)
        self.assertIn("/opt/weixin/send", command)
        self.assertNotIn("--channel", command)


class CronLedgerTests(unittest.TestCase):
    def test_load_jobs_folds_dsh_jsonl_and_latest_next_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp) / "jobs.jsonl"
            runs = Path(tmp) / "runs.jsonl"
            jobs.write_text("\n".join([
                json.dumps({
                    "op": "create", "id": "active", "externalRef": "active-ref",
                    "schedule": {"kind": "interval", "minutes": 60},
                    "deliver": "telegram", "createdAt": "2026-08-28T00:00:00+08:00",
                }),
                json.dumps({
                    "op": "create", "id": "deleted",
                    "schedule": {"kind": "cron", "expr": "0 * * * *"},
                    "deliver": "telegram", "createdAt": "2026-08-28T00:00:00+08:00",
                }),
                json.dumps({"op": "delete", "id": "deleted"}),
                json.dumps({
                    "op": "create", "id": "silent",
                    "schedule": {"kind": "cron", "expr": "0 * * * *"},
                    "deliver": "silent", "createdAt": "2026-08-28T00:00:00+08:00",
                }),
            ]) + "\n", encoding="utf-8")
            runs.write_text(json.dumps({
                "jobId": "active", "nextRunAt": "2026-08-28T02:00:00+08:00",
            }) + "\n", encoding="utf-8")
            loaded = cron_conflict_check.load_jobs(str(jobs), str(runs))
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]["id"], "active")
        self.assertEqual(loaded[0]["next_run_at"], "2026-08-28T02:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
