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


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/run-notion-inbox-init.py"
SPEC = importlib.util.spec_from_file_location("notion_inbox_init", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PROBE_SHA256 = "a" * 64


class NotionInboxInitTests(unittest.TestCase):
    def fixture(
        self,
        status: str = "synced",
        omit_artifact: str | None = None,
    ) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory(prefix="dsh-notion-init-")
        dsh_home = Path(temporary.name) / ".dsh"
        entrypoint = dsh_home / MODULE.CHECKER.RELATIVE_ENTRYPOINT
        entrypoint.parent.mkdir(parents=True)
        (dsh_home / "storages").mkdir()
        source = f'''#!/usr/bin/env python3
# --pull --set --push --force --retry-pending --json
# NOTION_TOKEN_FILE NOTION_INBOX_FILE NOTION_API_BASE NOTION_PAGE_ID
import json, os
from pathlib import Path
marker = Path(os.environ["DSH_INIT_MARKER"])
marker.write_text(marker.read_text() + "call\\n" if marker.exists() else "call\\n")
artifacts = {{
    "mirror": (Path(os.environ["NOTION_INBOX_FILE"]), "PRIVATE TASK MIRROR"),
    "state": (Path(os.environ["DSH_HOME"]) / {str(MODULE.ARTIFACT_PATHS["state"])!r}, "PRIVATE SYNC STATE"),
    "fingerprint": (Path(os.environ["DSH_HOME"]) / {str(MODULE.ARTIFACT_PATHS["fingerprint"])!r}, "PRIVATE SOURCE FINGERPRINT"),
}}
for role, (path, value) in artifacts.items():
    if role == {omit_artifact!r}:
        continue
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)
print(json.dumps({{"status": "{status}"}}))
'''.encode()
        entrypoint.write_bytes(source)
        entrypoint.chmod(0o755)
        test_receipt = dsh_home / MODULE.CHECKER.RELATIVE_TEST_RECEIPT
        test_receipt_bytes = (
            json.dumps({
                "schemaVersion": 1,
                "interfaceVersion": 1,
                "probeVersion": 1,
                "entrypointSha256": hashlib.sha256(source).hexdigest(),
                "probeSha256": PROBE_SHA256,
                "testedAt": "2026-08-30T00:00:00Z",
                "tests": {name: True for name in MODULE.CHECKER.HANDOFF_TESTS},
            }, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        test_receipt.write_bytes(test_receipt_bytes)
        test_receipt.chmod(0o600)
        handoff = dsh_home / MODULE.CHECKER.RELATIVE_HANDOFF
        handoff.write_text(json.dumps({
            "schemaVersion": 2,
            "interfaceVersion": 1,
            "artifactContract": MODULE.CHECKER.ARTIFACT_CONTRACT,
            "entrypointSha256": hashlib.sha256(source).hexdigest(),
            "testReceiptSha256": hashlib.sha256(test_receipt_bytes).hexdigest(),
            "testedAt": "2026-08-30T00:00:00Z",
            "tests": {name: True for name in MODULE.CHECKER.HANDOFF_TESTS},
        }, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        handoff.chmod(0o600)
        marker = Path(temporary.name) / "calls.txt"
        return temporary, dsh_home, marker

    def environment(self, dsh_home: Path, marker: Path) -> dict[str, str]:
        return {
            "DSH_HOME": str(dsh_home),
            "NOTION_INBOX_FILE": str(dsh_home / MODULE.RELATIVE_MIRROR),
            "NOTION_TOKEN_FILE": str(dsh_home / "secrets/notion.token"),
            "NOTION_API_BASE": "http://fake-notion.invalid/v1",
            "NOTION_PAGE_ID": "0" * 32,
            "DSH_INIT_MARKER": str(marker),
        }

    def test_first_initialization_and_second_noop_are_private_free(self) -> None:
        temporary, dsh_home, marker = self.fixture()
        with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
            first = MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            second = MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            calls = marker.read_text(encoding="utf-8")
        self.assertEqual(first["status"], "initialized")
        self.assertEqual(first["remoteMethod"], "GET")
        self.assertEqual(second["status"], "already-initialized")
        self.assertEqual(second["remoteMethod"], "none")
        self.assertEqual(calls, "call\n")
        self.assertEqual(first["artifacts"], second["artifacts"])
        self.assertEqual(set(first["artifacts"]), {"mirror", "state", "fingerprint"})
        for role, artifact in first["artifacts"].items():
            self.assertEqual(
                set(artifact),
                {"role", "path", "mode", "length", "sha256"},
            )
            self.assertEqual(artifact["role"], role)
            self.assertEqual(artifact["path"], MODULE.ARTIFACT_PATHS[role].as_posix())
            self.assertEqual(artifact["mode"], "0600")
            self.assertGreater(artifact["length"], 0)
            self.assertRegex(artifact["sha256"], r"^[0-9a-f]{64}$")
        serialized = json.dumps({"first": first, "second": second})
        for private_value in (
            "PRIVATE TASK MIRROR",
            "PRIVATE SYNC STATE",
            "PRIVATE SOURCE FINGERPRINT",
        ):
            self.assertNotIn(private_value, serialized)

    def test_missing_or_unsafe_artifacts_fail_closed(self) -> None:
        for role in ("state", "fingerprint"):
            with self.subTest(missing=role):
                temporary, dsh_home, marker = self.fixture(omit_artifact=role)
                with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
                    with self.assertRaises(MODULE.InitError):
                        MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)

        temporary, dsh_home, marker = self.fixture()
        with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
            first = MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            self.assertEqual(first["status"], "initialized")
            state_path = dsh_home / MODULE.ARTIFACT_PATHS["state"]
            state_path.chmod(0o644)
            with self.assertRaises(MODULE.InitError):
                MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)

    def test_partial_preimage_never_runs_the_business_entrypoint(self) -> None:
        temporary, dsh_home, marker = self.fixture()
        mirror = dsh_home / MODULE.RELATIVE_MIRROR
        mirror.parent.mkdir(parents=True, exist_ok=True)
        mirror.write_text("PRIVATE PARTIAL MIRROR", encoding="utf-8")
        mirror.chmod(0o600)
        with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
            with self.assertRaises(MODULE.InitError):
                MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
            self.assertFalse(marker.exists())

    def test_parent_symlinks_are_rejected_without_touching_external_bytes(self) -> None:
        for linked_parent in ("storages", "task-inbox"):
            with self.subTest(linked_parent=linked_parent):
                temporary, dsh_home, marker = self.fixture()
                external_root = Path(temporary.name) / "external"
                external_inbox = external_root / "task-inbox"
                external_inbox.mkdir(parents=True)
                external_values = {
                    "inbox.md": b"PRIVATE EXTERNAL MIRROR",
                    "sync-state.json": b"PRIVATE EXTERNAL STATE",
                    "notion-fingerprint.json": b"PRIVATE EXTERNAL FINGERPRINT",
                }
                for name, value in external_values.items():
                    path = external_inbox / name
                    path.write_bytes(value)
                    path.chmod(0o600)
                if linked_parent == "storages":
                    (dsh_home / "storages").rmdir()
                    (dsh_home / "storages").symlink_to(external_root, target_is_directory=True)
                else:
                    (dsh_home / "storages/task-inbox").symlink_to(
                        external_inbox,
                        target_is_directory=True,
                    )
                before = {name: (external_inbox / name).read_bytes() for name in external_values}
                with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
                    with self.assertRaises(MODULE.InitError):
                        MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)
                    after = {name: (external_inbox / name).read_bytes() for name in external_values}
                    self.assertEqual(after, before)
                    self.assertFalse(marker.exists())

    def test_non_synced_status_fails_without_echoing_private_output(self) -> None:
        temporary, dsh_home, marker = self.fixture("queued")
        with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False):
            with self.assertRaises(MODULE.InitError):
                MODULE.initialize(dsh_home, os.getuid(), os.getgid(), PROBE_SHA256)

    def test_cli_error_is_fixed_and_private_free(self) -> None:
        temporary, dsh_home, marker = self.fixture("error")
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = [
            "run-notion-inbox-init.py", "--dsh-home", str(dsh_home),
            "--owner-uid", str(os.getuid()), "--owner-gid", str(os.getgid()),
            "--expected-probe-sha256", PROBE_SHA256,
        ]
        with temporary, mock.patch.dict(os.environ, self.environment(dsh_home, marker), clear=False), \
                mock.patch("sys.argv", argv), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = MODULE.main()
        self.assertEqual(result, 4)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("PRIVATE TASK MIRROR", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
