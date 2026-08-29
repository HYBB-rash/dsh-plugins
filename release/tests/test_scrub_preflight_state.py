#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "scrub-preflight-state.py"
SPEC = importlib.util.spec_from_file_location("scrub_preflight_state", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ScrubPreflightStateTests(unittest.TestCase):
    def test_scrubs_known_credentials_without_touching_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "preflight"
            dsh_home = root / "home" / "herman" / ".dsh"
            workspace = dsh_home / "workspace" / "automations"
            secrets = dsh_home / "secrets"
            workspace.mkdir(parents=True)
            secrets.mkdir()
            private = b"production-secret-sentinel"
            (dsh_home / ".credentials.yaml").write_bytes(private)
            (dsh_home / ".credentials.json").write_bytes(private)
            (secrets / "notion.token").write_bytes(private)
            (secrets / "other.token").write_bytes(private)
            automation = workspace / "owned-online.py"
            automation.write_bytes(b"# Harness-owned business code\n")
            before = automation.read_bytes()

            receipt = MODULE.scrub(dsh_home, root)

            self.assertEqual(receipt["status"], "scrubbed")
            self.assertEqual(automation.read_bytes(), before)
            self.assertNotIn(private, (dsh_home / ".credentials.yaml").read_bytes())
            self.assertNotIn(private, (secrets / "notion.token").read_bytes())
            self.assertFalse((dsh_home / ".credentials.json").exists())
            self.assertFalse((secrets / "other.token").exists())
            self.assertEqual(os.stat(dsh_home / ".credentials.yaml").st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(secrets).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(secrets / "notion.token").st_mode & 0o777, 0o600)

    def test_rejects_state_outside_declared_preflight_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "preflight"
            root.mkdir()
            outside = base / "home" / ".dsh"
            outside.mkdir(parents=True)
            with self.assertRaisesRegex(MODULE.ScrubError, "must stay below"):
                MODULE.scrub(outside, root)

    def test_rejects_symlinked_dsh_home_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "preflight"
            target = root / "real" / ".dsh"
            target.mkdir(parents=True)
            linked = root / "linked" / ".dsh"
            linked.parent.mkdir()
            linked.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(MODULE.ScrubError, "must be a real directory"):
                MODULE.scrub(linked, root)


if __name__ == "__main__":
    unittest.main()
