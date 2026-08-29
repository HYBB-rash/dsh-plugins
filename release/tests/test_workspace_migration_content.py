#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts/verify-workspace-migration-content.py"
SPEC = importlib.util.spec_from_file_location("verify_workspace_migration_content", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkspaceMigrationContentTests(unittest.TestCase):
    def environment_without_expected_metadata(self) -> dict[str, str]:
        expected_names = set(MODULE.EXPECTED_ENV.values())
        return {
            name: value
            for name, value in os.environ.items()
            if name not in expected_names
        }

    def fixture(self, root: Path) -> tuple[Path, Path]:
        release = root / "release-system"
        plugins = root / "plugins-src"
        migration = release / "workspace-migrations/harness-only-v1"
        scripts = release / "scripts"
        skill = plugins / "skills/personal-task-list/agents"
        migration.mkdir(parents=True)
        scripts.mkdir()
        skill.mkdir(parents=True)
        template = b"# Harness-only fixture\n"
        (migration / "AGENTS.md").write_bytes(template)
        manifest = {
            "schemaVersion": 1,
            "migrationVersion": 1,
            "migrationId": "harness-only-workspace-v1",
            "workspace": {
                "agents": {"postimageSha256": MODULE.sha256_bytes(template)},
            },
        }
        manifest["workspace"]["agents"]["postimageSha256"] = manifest["workspace"]["agents"]["postimageSha256"].removeprefix("sha256:")
        (migration / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (scripts / "migrate-workspace-state.py").write_text("# fixture\n", encoding="utf-8")
        (release / "harness-automation-instructions.md").write_text("# root fixture\n", encoding="utf-8")
        (skill.parent / "SKILL.md").write_text("# skill fixture\n", encoding="utf-8")
        (skill / "openai.yaml").write_text("name: fixture\n", encoding="utf-8")
        return release, plugins

    def test_exact_metadata_passes_and_business_automation_is_external(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release, plugins = self.fixture(Path(temporary))
            # Candidate self-tests intentionally inherit the real admitted hashes.
            # Keep the synthetic fixture's unbound baseline independent of them.
            with patch.dict(
                os.environ, self.environment_without_expected_metadata(), clear=True
            ):
                first = MODULE.verify(release, plugins)
            expected = {
                environment: first[field]
                for field, environment in MODULE.EXPECTED_ENV.items()
            }
            with patch.dict(os.environ, expected, clear=False):
                receipt = MODULE.verify(release, plugins)
            self.assertTrue(receipt["metadataBound"])
            self.assertEqual(
                receipt["businessAutomation"],
                {"owner": "live-harness-workspace", "includedInCandidate": False},
            )

    def test_drift_and_repository_automation_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release, plugins = self.fixture(Path(temporary))
            with patch.dict(
                os.environ, self.environment_without_expected_metadata(), clear=True
            ):
                actual = MODULE.verify(release, plugins)
            expected = {
                environment: actual[field]
                for field, environment in MODULE.EXPECTED_ENV.items()
            }
            expected[MODULE.EXPECTED_ENV["codeSha256"]] = "sha256:" + "0" * 64
            with patch.dict(os.environ, expected, clear=False):
                with self.assertRaisesRegex(MODULE.VerifyError, "does not match"):
                    MODULE.verify(release, plugins)

            (plugins / "automations").mkdir()
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(MODULE.VerifyError, "business automation"):
                    MODULE.verify(release, plugins)


if __name__ == "__main__":
    unittest.main()
