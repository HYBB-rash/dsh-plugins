#!/usr/bin/env python3
"""Contract tests for the read-only Harness Notion production status helper."""

from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


RELEASE_ROOT = Path(__file__).resolve().parents[1]
HELPER = RELEASE_ROOT / "scripts/harness-notion-automation-status.py"
HELPER_SPEC = importlib.util.spec_from_file_location("harness_notion_status", HELPER)
assert HELPER_SPEC is not None and HELPER_SPEC.loader is not None
HELPER_MODULE = importlib.util.module_from_spec(HELPER_SPEC)
HELPER_SPEC.loader.exec_module(HELPER_MODULE)
COMMIT = "a" * 40
HARNESS_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
HARNESS_PATCH = "sha256:df85af4402b238a666bc7117092e559ae843df55c850ea6b711c1c8f3a292e0b"
PLUGINS_COMMIT = "b" * 40
RELEASE_COMMIT = "c" * 40
CANDIDATE_IMAGE = "d" * 64
ENGINE_IMAGE = "sha256:" + "e" * 64
RELEASE_ID = "20260830T120000000Z-cccccccccccc"


class StatusHelperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.home = self.root / "dsh-home"
        self.release = self.state / "releases" / RELEASE_ID
        self.locks = self.state / "locks"
        self.control = self.root / "docker-control.json"
        self.docker_log = self.root / "docker.log"
        self.docker = self.root / "docker"
        self.uid = os.getuid()
        self.gid = os.getgid()

        self.release.mkdir(parents=True)
        self.locks.mkdir()
        (self.home / "workspace/automations").mkdir(parents=True)
        lock = self.locks / "production-operation.lock"
        lock.touch(mode=0o600)
        lock.chmod(0o600)
        os.symlink(str(self.release), self.state / "current")
        os.symlink(str(self.release), self.state / "last-good")
        release = {
            "schemaVersion": 1,
            "releaseId": RELEASE_ID,
            "status": "accepted",
            "candidate": {
                "imageId": CANDIDATE_IMAGE,
                "imageTag": "localhost/dsh-candidate:accepted",
                "pluginsCommit": PLUGINS_COMMIT,
                "releaseToolCommit": RELEASE_COMMIT,
                "harnessCommit": HARNESS_COMMIT,
                "harnessPatchSha256": HARNESS_PATCH,
            },
            "production": {
                "engineImageId": ENGINE_IMAGE,
                "web": "true/0",
                "telegram": "true/0",
                "lan": "true/0",
                "prepare": "exited/0",
            },
        }
        release_path = self.release / "release.json"
        release_path.write_text(json.dumps(release), encoding="utf-8")
        release_path.chmod(0o600)
        self.write_control({})
        self.write_fake_docker()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_control(self, updates: dict[str, object]) -> None:
        value = {
            "containerCount": 0,
            "networkCount": 0,
            "webOom": False,
            "webDead": False,
            "webRestarting": False,
            "composeProject": "dsh",
            "block": False,
            **updates,
        }
        self.control.write_text(json.dumps(value), encoding="utf-8")

    def write_fake_docker(self) -> None:
        source = f'''#!{sys.executable}
import json, pathlib, sys
control = json.loads(pathlib.Path({str(self.control)!r}).read_text(encoding="utf-8"))
with pathlib.Path({str(self.docker_log)!r}).open("a", encoding="utf-8") as output:
    output.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:3] == ["image", "inspect", "--format"] and args[-1] == {ENGINE_IMAGE!r}:
    if control["block"]:
        pathlib.Path({str(self.root / "docker-blocked")!r}).touch()
        for _ in range(500):
            if pathlib.Path({str(self.root / "docker-release")!r}).exists():
                break
            import time
            time.sleep(0.01)
        else:
            raise SystemExit(8)
    print("|".join(({ENGINE_IMAGE!r}, "release", {HARNESS_COMMIT!r}, {HARNESS_PATCH!r}, {PLUGINS_COMMIT!r}, {RELEASE_COMMIT!r}, json.dumps(["localhost/dsh-candidate:accepted"]))))
elif args[:3] == ["container", "inspect", "--format"]:
    name = args[-1]
    expected = {{
        "dsh-web": ("true", "running", "healthy"),
        "dsh-telegram": ("true", "running", "none"),
        "dsh-lan-proxy": ("true", "running", "none"),
        "dsh-prepare": ("false", "exited", "none"),
    }}.get(name)
    if expected is None:
        raise SystemExit(9)
    running, status, health = expected
    oom = "true" if name == "dsh-web" and control["webOom"] else "false"
    dead = "true" if name == "dsh-web" and control["webDead"] else "false"
    restarting = "true" if name == "dsh-web" and control["webRestarting"] else "false"
    service = "lan-proxy" if name == "dsh-lan-proxy" else name.removeprefix("dsh-")
    print("|".join(({ENGINE_IMAGE!r}, running, status, "0", oom, dead, restarting, "0", health, control["composeProject"], service)))
elif args[:3] == ["container", "ls", "--all"]:
    for index in range(control["containerCount"]):
        print((str(index + 1) * 12)[:12])
elif args[:2] == ["network", "ls"]:
    for index in range(control["networkCount"]):
        print((format(index + 10, "x") * 12)[:12])
else:
    raise SystemExit(9)
'''
        self.docker.write_text(source, encoding="utf-8")
        self.docker.chmod(0o755)

    def command(self) -> list[str]:
        digest = hashlib.sha256(HELPER.read_bytes()).hexdigest()
        return [
            sys.executable,
            str(HELPER),
            "--state-root",
            str(self.state),
            "--dsh-home",
            str(self.home),
            "--docker",
            str(self.docker),
            "--owner-uid",
            str(self.uid),
            "--owner-gid",
            str(self.gid),
            "--source-commit",
            COMMIT,
            "--source-sha256",
            digest,
        ]

    def run_helper(self) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            self.command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
        )

    def assert_fixed_failure(self, result: subprocess.CompletedProcess[bytes]) -> None:
        self.assertEqual(result.returncode, 6)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"harness notion automation status unavailable\n")

    def expected_status(self, target: dict[str, str]) -> dict[str, object]:
        container = lambda name, running, status, health: {
            "name": name,
            "imageMatchesAccepted": True,
            "composeLabelsMatch": True,
            "running": running,
            "status": status,
            "exitCode": 0,
            "oomKilled": False,
            "dead": False,
            "restarting": False,
            "restartCount": 0,
            "health": health,
        }
        return {
            "schemaVersion": 1,
            "status": "accepted-production-boundary",
            "statusSource": {
                "commit": COMMIT,
                "sha256": "sha256:" + hashlib.sha256(HELPER.read_bytes()).hexdigest(),
            },
            "target": target,
            "harnessTasks": {"childCount": 0},
            "oneShotResources": {
                "ownerLabel": "io.dsh.owner=harness-notion-automation",
                "containerCount": 0,
                "networkCount": 0,
            },
            "release": {
                "currentEqualsLastGood": True,
                "releaseId": RELEASE_ID,
                "engineImageId": ENGINE_IMAGE,
                "imageTag": "localhost/dsh-candidate:accepted",
                "pluginsCommit": PLUGINS_COMMIT,
                "releaseToolCommit": RELEASE_COMMIT,
                "harnessCommit": HARNESS_COMMIT,
                "harnessPatchSha256": HARNESS_PATCH,
            },
            "containers": {
                "web": container("dsh-web", True, "running", "healthy"),
                "telegram": container("dsh-telegram", True, "running", "none"),
                "lan": container("dsh-lan-proxy", True, "running", "none"),
                "prepare": container("dsh-prepare", False, "exited", "none"),
            },
        }

    def test_absent_target_returns_exact_sanitized_receipt(self) -> None:
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), self.expected_status({"presence": "absent", "type": "absent"}))
        self.assertEqual(result.stderr, b"")
        commands = [json.loads(line) for line in self.docker_log.read_text().splitlines()]
        self.assertEqual(len(commands), 7)
        self.assertIn(["container", "ls", "--all", "--filter", "label=io.dsh.owner=harness-notion-automation", "--format", "{{.ID}}"], commands)

    def test_present_target_is_only_reported_as_directory(self) -> None:
        target = self.home / "workspace/automations/notion"
        target.mkdir()
        for name, secret in (
            ("notion_inbox_sync.py", "PRIVATE AUTOMATION SOURCE"),
            ("notion_inbox_sync.handoff.json", "PRIVATE RECEIPT BODY"),
        ):
            path = target / name
            path.write_text(secret, encoding="utf-8")
            path.chmod(0)
        secrets = self.home / "secrets"
        secrets.mkdir()
        token = secrets / "notion.token"
        token.write_text("PRIVATE TOKEN", encoding="utf-8")
        token.chmod(0)
        openclaw = self.home / ".openclaw"
        openclaw.mkdir()
        marker = openclaw / "PRIVATE"
        marker.write_text("PRIVATE OPENCLAW", encoding="utf-8")
        marker.chmod(0)

        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), self.expected_status({"presence": "present", "type": "directory"}))
        combined = result.stdout + result.stderr + self.docker_log.read_bytes()
        for private in (b"PRIVATE AUTOMATION", b"PRIVATE RECEIPT", b"PRIVATE TOKEN", b"PRIVATE OPENCLAW"):
            self.assertNotIn(private, combined)

    def test_missing_lock_fails_without_creating_it(self) -> None:
        lock = self.locks / "production-operation.lock"
        lock.unlink()
        result = self.run_helper()
        self.assert_fixed_failure(result)
        self.assertFalse(lock.exists())
        self.assertFalse(self.docker_log.exists())

    def test_busy_lock_fails_fast_without_reading_production(self) -> None:
        lock_path = self.locks / "production-operation.lock"
        with lock_path.open("rb") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            started = time.monotonic()
            result = self.run_helper()
            elapsed = time.monotonic() - started
        self.assert_fixed_failure(result)
        self.assertLess(elapsed, 2)
        self.assertFalse(self.docker_log.exists())

    def test_shared_lock_is_held_through_docker_and_target_snapshot(self) -> None:
        self.write_control({"block": True})
        process = subprocess.Popen(
            self.command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        blocked = self.root / "docker-blocked"
        for _ in range(200):
            if blocked.exists():
                break
            time.sleep(0.01)
        self.assertTrue(blocked.exists())
        lock_path = self.locks / "production-operation.lock"
        with lock_path.open("rb") as contender:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        (self.root / "docker-release").touch()
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertEqual(json.loads(stdout)["status"], "accepted-production-boundary")

    def test_residual_task_or_owned_resource_fails_closed(self) -> None:
        tasks = self.state / "harness-tasks"
        tasks.mkdir()
        (tasks / "residual").touch()
        self.assert_fixed_failure(self.run_helper())
        (tasks / "residual").unlink()
        self.write_control({"containerCount": 1})
        self.assert_fixed_failure(self.run_helper())
        self.write_control({"networkCount": 1})
        self.assert_fixed_failure(self.run_helper())

    def test_container_oom_or_release_drift_fails_closed(self) -> None:
        self.write_control({"webOom": True})
        self.assert_fixed_failure(self.run_helper())
        self.write_control({"webDead": True})
        self.assert_fixed_failure(self.run_helper())
        self.write_control({"webRestarting": True})
        self.assert_fixed_failure(self.run_helper())
        self.write_control({"composeProject": "not-dsh"})
        self.assert_fixed_failure(self.run_helper())
        self.write_control({})
        (self.state / "last-good").unlink()
        other = self.state / "releases" / "other"
        other.mkdir()
        os.symlink(str(other), self.state / "last-good")
        self.assert_fixed_failure(self.run_helper())

    def test_release_schema_drift_fails_closed(self) -> None:
        path = self.release / "release.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["schemaVersion"] = 99
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)
        self.assert_fixed_failure(self.run_helper())

    def test_target_parent_symlink_fails_without_traversal(self) -> None:
        workspace = self.home / "workspace"
        moved = self.home / "workspace-real"
        workspace.rename(moved)
        os.symlink(str(moved), workspace)
        result = self.run_helper()
        self.assert_fixed_failure(result)

    def test_target_parent_swap_is_rejected_before_return(self) -> None:
        original = HELPER_MODULE.revalidate_child_directory
        swapped = False

        def swap_then_revalidate(parent, name, descriptor, uid, gid):
            nonlocal swapped
            if name == "automations" and not swapped:
                swapped = True
                workspace = self.home / "workspace"
                old = workspace / "automations"
                detached = workspace / "automations-detached"
                old.rename(detached)
                old.mkdir()
            return original(parent, name, descriptor, uid, gid)

        HELPER_MODULE.revalidate_child_directory = swap_then_revalidate
        try:
            with self.assertRaises(HELPER_MODULE.StatusError):
                HELPER_MODULE.target_status(self.home, self.uid, self.gid)
        finally:
            HELPER_MODULE.revalidate_child_directory = original
        self.assertTrue(swapped)

    def test_state_root_swap_is_rejected_after_snapshot(self) -> None:
        self.write_control({"block": True})
        process = subprocess.Popen(
            self.command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        blocked = self.root / "docker-blocked"
        for _ in range(200):
            if blocked.exists():
                break
            time.sleep(0.01)
        self.assertTrue(blocked.exists())
        detached = self.root / "state-detached"
        self.state.rename(detached)
        self.state.mkdir()
        (self.root / "docker-release").touch()
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 6)
        self.assertEqual(stdout, b"")
        self.assertEqual(stderr, b"harness notion automation status unavailable\n")

    def test_source_has_no_business_or_secret_read_path(self) -> None:
        source = HELPER.read_text(encoding="utf-8")
        for forbidden in (
            ".openclaw",
            "notion.token",
            "notion_inbox_sync.py",
            "notion_inbox_sync.handoff.json",
            "Authorization",
        ):
            self.assertNotIn(forbidden, source)
        self.assertNotIn("O_CREAT", source)
        self.assertNotIn("mkdir(", source)
        self.assertNotIn("write_text", source)
        self.assertNotIn("write_bytes", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
