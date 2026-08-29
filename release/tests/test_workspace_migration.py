#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RELEASE_ROOT = Path(__file__).resolve().parents[1]
MIGRATE = RELEASE_ROOT / "scripts/migrate-workspace-state.py"
HEALTH = RELEASE_ROOT / "scripts/check-harness-only-state.py"


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def tree_bytes(root: Path) -> dict[str, tuple[str, bytes | str, int]]:
    result: dict[str, tuple[str, bytes | str, int]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if path.is_symlink():
            result[relative] = ("link", os.readlink(path), mode)
        elif path.is_file():
            result[relative] = ("file", path.read_bytes(), mode)
        else:
            result[relative] = ("dir", b"", mode)
    return result


class WorkspaceFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.dsh_home = root / "dsh"
        self.workspace = self.dsh_home / "workspace"
        self.manifest_dir = root / "manifest"
        self.skills = root / "skills"
        self.external_a = root / "external-a"
        self.external_b = root / "external-b"
        for path in (
            self.workspace / "automations/notion",
            self.dsh_home / "profiles/web",
            self.manifest_dir,
            self.skills / "personal-task-list",
            self.external_a,
            self.external_b,
        ):
            path.mkdir(parents=True)
        self.old_agents = b"# Old routes\nRead another memory source.\n"
        self.new_agents = b"# Harness-only\nUse DSH_HOME for memory, tasks, and automations.\n"
        (self.workspace / "AGENTS.md").write_bytes(self.old_agents)
        os.chmod(self.workspace / "AGENTS.md", 0o644)
        (self.manifest_dir / "AGENTS.md").write_bytes(self.new_agents)

        self.memory_lines = [
            "# Memory\n".encode(),
            "[legacy source] - likes tea (confirmed)\n".encode(),
            "- stable middle fact\n".encode(),
            "merge a retired outside route\n".encode(),
            "- lives in Shanghai (probable) [source note]\n".encode(),
        ]
        self.old_memory = b"".join(self.memory_lines)
        prefix = b"[legacy source] "
        suffix = b" [source note]"
        line_two = self.memory_lines[1]
        line_five = self.memory_lines[4]
        suffix_start = line_five.index(suffix)
        self.new_memory_lines = [
            self.memory_lines[0],
            line_two[len(prefix) :],
            self.memory_lines[2],
            line_five[:suffix_start] + line_five[suffix_start + len(suffix) :],
        ]
        self.new_memory = b"".join(self.new_memory_lines)
        (self.workspace / "MEMORY.md").write_bytes(self.old_memory)
        os.chmod(self.workspace / "MEMORY.md", 0o600)

        automation = self.workspace / "automations/notion/notion_inbox_sync.py"
        automation.write_bytes(b"#!/usr/bin/env python3\nprint('workspace owned')\n")
        os.chmod(automation, 0o600)
        (self.dsh_home / "profiles/web/cordis.patch.yml").write_text("name: web\n", encoding="utf-8")
        (self.skills / "personal-task-list/SKILL.md").write_text("# Local task skill\n", encoding="utf-8")
        (self.external_a / "private.bin").write_bytes(b"outside-a\x00bytes")
        (self.external_b / "private.bin").write_bytes(b"outside-b\x00bytes")
        os.symlink(str(self.external_a), self.workspace / "openclaw-shared")
        os.symlink(str(self.external_b), self.workspace / "task-inbox-shared")

        transforms = [
            self._transform(2, self.memory_lines[1], 0, len(prefix), False),
            self._transform(4, self.memory_lines[3], 0, len(self.memory_lines[3]), True),
            self._transform(5, self.memory_lines[4], suffix_start, suffix_start + len(suffix), False),
        ]
        links = []
        for name, target in (("openclaw-shared", str(self.external_a)), ("task-inbox-shared", str(self.external_b))):
            target_bytes = os.fsencode(target)
            links.append({"path": name, "targetSha256": digest(target_bytes), "targetLength": len(target_bytes)})
        self.manifest = {
            "schemaVersion": 1,
            "migrationVersion": 1,
            "migrationId": "fixture-harness-only-v1",
            "workspace": {
                "agents": {
                    "path": "AGENTS.md",
                    "preimageSha256": digest(self.old_agents),
                    "postimageSha256": digest(self.new_agents),
                    "preimageMode": "0644",
                    "postimageMode": "0644",
                    "template": "AGENTS.md",
                },
                "memory": {
                    "path": "MEMORY.md",
                    "preimageSha256": digest(self.old_memory),
                    "postimageSha256": digest(self.new_memory),
                    "preimageMode": "0600",
                    "postimageMode": "0600",
                    "lineTransforms": transforms,
                },
                "removeSymlinks": links,
            },
        }
        self.manifest_path = self.manifest_dir / "manifest.json"
        self.write_manifest()

    @staticmethod
    def _transform(line_number: int, line: bytes, start: int, end: int, delete: bool) -> dict[str, object]:
        post = line[:start] + line[end:]
        return {
            "lineNumber": line_number,
            "preLineSha256": digest(line),
            "removeStartByte": start,
            "removeEndByte": end,
            "removedSha256": digest(line[start:end]),
            "postLineSha256": digest(post),
            "deleteLine": delete,
        }

    def write_manifest(self) -> None:
        self.manifest_path.write_text(json.dumps(self.manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def migrate(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(MIGRATE), "--dsh-home", str(self.dsh_home), "--manifest", str(self.manifest_path), "--json"],
            text=True,
            capture_output=True,
            check=False,
        )

    def health(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(HEALTH),
                "--dsh-home",
                str(self.dsh_home),
                "--manifest",
                str(self.manifest_path),
                "--product-skills-root",
                str(self.skills),
                "--json",
            ],
            text=True,
            capture_output=True,
            check=False,
        )


class WorkspaceMigrationTests(unittest.TestCase):
    def test_exact_migration_is_idempotent_and_preserves_owned_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            external_before = (tree_bytes(fixture.external_a), tree_bytes(fixture.external_b))
            automations_before = tree_bytes(fixture.workspace / "automations")
            first = fixture.migrate()
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertEqual(json.loads(first.stdout)["status"], "applied")
            self.assertEqual((fixture.workspace / "AGENTS.md").read_bytes(), fixture.new_agents)
            self.assertEqual((fixture.workspace / "MEMORY.md").read_bytes(), fixture.new_memory)
            self.assertEqual(fixture.new_memory_lines[1], b"- likes tea (confirmed)\n")
            self.assertEqual(fixture.new_memory_lines[-1], b"- lives in Shanghai (probable)\n")
            self.assertFalse((fixture.workspace / "openclaw-shared").is_symlink())
            self.assertFalse((fixture.workspace / "task-inbox-shared").is_symlink())
            self.assertEqual(tree_bytes(fixture.workspace / "automations"), automations_before)
            self.assertEqual((tree_bytes(fixture.external_a), tree_bytes(fixture.external_b)), external_before)
            receipt_path = next((fixture.dsh_home / "migration-receipts").iterdir())
            receipt = receipt_path.read_bytes()
            self.assertNotIn(b"likes tea", receipt)
            receipt_value = json.loads(receipt)
            self.assertEqual(receipt_value["schemaVersion"], 2)
            self.assertEqual(receipt_value["status"], "applied")
            self.assertEqual(receipt_value["manifestSha256"], digest(fixture.manifest_path.read_bytes()))
            self.assertEqual(receipt_value["migrationCodeSha256"], digest(MIGRATE.read_bytes()))
            self.assertEqual(receipt_value["templateSha256"], digest(fixture.new_agents))
            self.assertEqual(receipt_value["agents"]["preimageSha256"], digest(fixture.old_agents))
            self.assertEqual(receipt_value["agents"]["postimageSha256"], digest(fixture.new_agents))
            self.assertEqual(receipt_value["memory"]["preimageSha256"], digest(fixture.old_memory))
            self.assertEqual(receipt_value["memory"]["postimageSha256"], digest(fixture.new_memory))
            self.assertRegex(receipt_value["evidenceSha256"], r"^[0-9a-f]{64}$")
            state_before_second = tree_bytes(fixture.dsh_home)
            second = fixture.migrate()
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertEqual(json.loads(second.stdout)["status"], "already-applied")
            self.assertEqual(tree_bytes(fixture.dsh_home), state_before_second)

    def test_applied_receipt_allows_memory_append_without_reading_or_rewriting_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            self.assertEqual(fixture.migrate().returncode, 0)
            memory_path = fixture.workspace / "MEMORY.md"
            receipt_path = next((fixture.dsh_home / "migration-receipts").iterdir())
            appended = memory_path.read_bytes() + b"\n- ordinary newly appended fact (confirmed)\n"
            memory_path.write_bytes(appended)
            os.chmod(memory_path, 0o600)
            receipt_before = receipt_path.read_bytes()
            agents_before = (fixture.workspace / "AGENTS.md").read_bytes()

            rerun = fixture.migrate()
            self.assertEqual(rerun.returncode, 0, rerun.stdout + rerun.stderr)
            rerun_receipt = json.loads(rerun.stdout)
            self.assertEqual(rerun_receipt["status"], "already-applied")
            self.assertEqual(rerun_receipt["memoryState"], "mutable-after-applied")
            self.assertEqual(memory_path.read_bytes(), appended)
            self.assertEqual(receipt_path.read_bytes(), receipt_before)
            self.assertEqual((fixture.workspace / "AGENTS.md").read_bytes(), agents_before)

            health = fixture.health()
            self.assertEqual(health.returncode, 0, health.stdout + health.stderr)
            health_receipt = json.loads(health.stdout)
            self.assertEqual(health_receipt["workspaceMemoryState"], "mutable-after-applied-receipt")
            self.assertNotIn("workspaceMemorySha256", health_receipt)
            self.assertEqual(memory_path.read_bytes(), appended)

    def test_tampered_applied_receipt_is_rejected_without_state_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            self.assertEqual(fixture.migrate().returncode, 0)
            receipt_path = next((fixture.dsh_home / "migration-receipts").iterdir())
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            receipt["createdAt"] = "2000-01-01T00:00:00Z"
            receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8")
            os.chmod(receipt_path, 0o600)
            before = tree_bytes(fixture.dsh_home)

            rerun = fixture.migrate()
            self.assertEqual(rerun.returncode, 4)
            self.assertIn("evidence SHA-256 mismatch", rerun.stdout)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)
            health = fixture.health()
            self.assertEqual(health.returncode, 4)
            self.assertIn("evidence SHA-256 mismatch", health.stdout)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)

    def test_applied_receipt_rejects_agents_drift_without_repairing_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            self.assertEqual(fixture.migrate().returncode, 0)
            agents_path = fixture.workspace / "AGENTS.md"
            agents_path.write_bytes(b"# drift after migration\n")
            os.chmod(agents_path, 0o644)
            before = tree_bytes(fixture.dsh_home)

            self.assertEqual(fixture.migrate().returncode, 4)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)
            self.assertEqual(fixture.health().returncode, 4)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)

    def test_applied_receipt_rejects_recreated_obsolete_link_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            self.assertEqual(fixture.migrate().returncode, 0)
            os.symlink(str(fixture.external_a), fixture.workspace / "openclaw-shared")
            before = tree_bytes(fixture.dsh_home)
            external_before = tree_bytes(fixture.external_a)

            rerun = fixture.migrate()
            self.assertEqual(rerun.returncode, 4)
            self.assertIn("reappeared", rerun.stdout)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)
            self.assertEqual(tree_bytes(fixture.external_a), external_before)
            self.assertEqual(fixture.health().returncode, 4)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)
            self.assertEqual(tree_bytes(fixture.external_a), external_before)

    def test_unknown_preimage_is_zero_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            (fixture.workspace / "AGENTS.md").write_bytes(b"drift\n")
            before = tree_bytes(fixture.dsh_home)
            result = fixture.migrate()
            self.assertEqual(result.returncode, 4)
            self.assertEqual(tree_bytes(fixture.dsh_home), before)
            self.assertFalse((fixture.dsh_home / "migration-receipts").exists())

    def test_health_scans_active_paths_but_not_logs_or_task_bodies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = WorkspaceFixture(Path(temporary))
            self.assertEqual(fixture.migrate().returncode, 0)
            logs = fixture.workspace / "logs"
            logs.mkdir()
            (logs / "history.txt").write_text("historical .openclaw text\n", encoding="utf-8")
            inbox = fixture.dsh_home / "storages/task-inbox"
            inbox.mkdir(parents=True)
            (inbox / "inbox.md").write_text("user task mentions .openclaw\n", encoding="utf-8")
            memory = fixture.workspace / "MEMORY.md"
            memory.write_bytes(memory.read_bytes() + b"\n- historical user text mentions .openclaw\n")
            os.chmod(memory, 0o600)
            passed = fixture.health()
            self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
            automation = fixture.workspace / "automations/notion/notion_inbox_sync.py"
            automation.write_text("#!/bin/sh\nopenclaw status\n", encoding="utf-8")
            blocked = fixture.health()
            self.assertEqual(blocked.returncode, 4)
            self.assertIn("external-cli-invocation", blocked.stdout)


if __name__ == "__main__":
    unittest.main()
