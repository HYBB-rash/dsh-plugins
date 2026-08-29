#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check-notion-automation-entrypoint.py"
SPEC = importlib.util.spec_from_file_location("notion_automation_gate", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


SOURCE = b"""#!/usr/bin/env python3
# --pull --set --push --force --retry-pending --json
# NOTION_TOKEN_FILE NOTION_INBOX_FILE NOTION_API_BASE NOTION_PAGE_ID
"""
PROBE_SHA256 = "a" * 64


class NotionAutomationEntrypointTests(unittest.TestCase):
    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory(prefix="dsh-notion-automation-gate-")
        dsh_home = Path(temporary.name) / ".dsh"
        entrypoint = dsh_home / MODULE.RELATIVE_ENTRYPOINT
        entrypoint.parent.mkdir(parents=True)
        entrypoint.write_bytes(SOURCE)
        entrypoint.chmod(0o755)
        test_receipt = dsh_home / MODULE.RELATIVE_TEST_RECEIPT
        test_receipt_bytes = (
            json.dumps(
                {
                    "schemaVersion": 1,
                    "interfaceVersion": 1,
                    "probeVersion": 1,
                    "entrypointSha256": hashlib.sha256(SOURCE).hexdigest(),
                    "probeSha256": PROBE_SHA256,
                    "testedAt": "2026-08-30T00:00:00Z",
                    "tests": {name: True for name in MODULE.HANDOFF_TESTS},
                },
                sort_keys=True,
                separators=(",", ":"),
            ) + "\n"
        ).encode("utf-8")
        test_receipt.write_bytes(test_receipt_bytes)
        test_receipt.chmod(0o600)
        handoff = dsh_home / MODULE.RELATIVE_HANDOFF
        handoff.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "interfaceVersion": 1,
                    "artifactContract": MODULE.ARTIFACT_CONTRACT,
                    "entrypointSha256": hashlib.sha256(SOURCE).hexdigest(),
                    "testReceiptSha256": hashlib.sha256(test_receipt_bytes).hexdigest(),
                    "testedAt": "2026-08-30T00:00:00Z",
                    "tests": {name: True for name in MODULE.HANDOFF_TESTS},
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        handoff.chmod(0o600)
        return temporary, dsh_home, entrypoint

    def test_reports_only_public_identity_and_hash(self) -> None:
        temporary, dsh_home, _entrypoint = self.fixture()
        with temporary:
            receipt = MODULE.inspect_entrypoint(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["owner"], "live-harness-workspace")
        self.assertEqual(receipt["path"], MODULE.RELATIVE_ENTRYPOINT.as_posix())
        self.assertEqual(receipt["handoffPath"], MODULE.RELATIVE_HANDOFF.as_posix())
        self.assertEqual(receipt["interfaceVersion"], 1)
        self.assertEqual(receipt["artifactContract"], MODULE.ARTIFACT_CONTRACT)
        self.assertEqual(receipt["size"], len(SOURCE))
        self.assertRegex(receipt["sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(receipt["handoffSha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(receipt["testReceiptSha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(receipt["testedAt"], "2026-08-30T00:00:00Z")
        self.assertNotIn("authorization", str(receipt).lower())

    def test_artifact_contract_and_atomic_test_are_strict(self) -> None:
        mutations = (
            lambda handoff: handoff["tests"].pop("atomicArtifacts"),
            lambda handoff: handoff["tests"].__setitem__("atomicArtifacts", False),
            lambda handoff: handoff["artifactContract"]["state"].__setitem__("path", "../outside.json"),
            lambda handoff: handoff["artifactContract"]["state"].__setitem__("mode", "0644"),
            lambda handoff: handoff["artifactContract"]["fingerprint"].__setitem__(
                "path", handoff["artifactContract"]["state"]["path"]
            ),
            lambda handoff: handoff["artifactContract"].__setitem__("interfaceVersion", 2),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                temporary, dsh_home, _entrypoint = self.fixture()
                with temporary:
                    handoff_path = dsh_home / MODULE.RELATIVE_HANDOFF
                    handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
                    mutate(handoff)
                    handoff_path.write_text(
                        json.dumps(handoff, sort_keys=True, separators=(",", ":")),
                        encoding="utf-8",
                    )
                    handoff_path.chmod(0o600)
                    with self.assertRaises(MODULE.GateError):
                        MODULE.inspect_entrypoint(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)

    def test_missing_symlink_and_interface_drift_fail_closed(self) -> None:
        temporary, dsh_home, entrypoint = self.fixture()
        with temporary:
            entrypoint.unlink()
            with self.assertRaises(MODULE.GateError):
                MODULE.inspect_entrypoint(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            outside = Path(temporary.name) / "outside.py"
            outside.write_bytes(SOURCE)
            entrypoint.symlink_to(outside)
            with self.assertRaises(MODULE.GateError):
                MODULE.inspect_entrypoint(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            entrypoint.unlink()
            entrypoint.write_bytes(b"# --pull PRIVATE-TASK-BODY")
            with self.assertRaises(MODULE.GateError):
                MODULE.inspect_entrypoint(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)

    def test_cli_error_is_fixed_and_does_not_echo_private_source(self) -> None:
        temporary, dsh_home, entrypoint = self.fixture()
        with temporary:
            entrypoint.write_bytes(b"PRIVATE-TASK-BODY NOTION_API_KEY")
            stdout = io.StringIO()
            stderr = io.StringIO()
            argv = [
                "check-notion-automation-entrypoint.py",
                "--dsh-home", str(dsh_home),
                "--owner-uid", str(os.getuid()),
                "--owner-gid", str(os.getgid()),
                "--expected-probe-sha256", PROBE_SHA256,
            ]
            with mock.patch("sys.argv", argv), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = MODULE.main()
        self.assertEqual(result, 4)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("PRIVATE-TASK-BODY", stderr.getvalue())
        self.assertNotIn("NOTION_API_KEY", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
