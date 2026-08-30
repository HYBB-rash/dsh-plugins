#!/usr/bin/env python3
"""Self-tests for the release-owned Harness Notion black-box probe."""

from __future__ import annotations

import ast
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.request
from pathlib import Path
from types import ModuleType
from typing import Iterator
from unittest import mock


def probe_path_for(tests_file: Path) -> Path:
    return tests_file.resolve().parents[1] / "scripts/verify-harness-notion-automation.py"


RELEASE_ROOT = Path(__file__).resolve().parents[1]
PROBE_PATH = probe_path_for(Path(__file__))
INTERFACE_MARKERS = """
# Interface markers required by the outer identity gate:
# --pull --set --push --force --retry-pending --json
# NOTION_TOKEN_FILE NOTION_INBOX_FILE NOTION_API_BASE NOTION_PAGE_ID
"""
REPEATED_STATE_PUBLISHER = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

task = Path(sys.argv[1])
state = task / "sync-state.json"
temporary = task / "sync-state.json.tmp"

def publish(value):
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    offset = 0
    while offset < len(value):
        offset += os.write(descriptor, value[offset:])
    os.fsync(descriptor)
    os.close(descriptor)
    os.replace(temporary, state)
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass

publish(b'{"pending":true}\n')
publish(b'{"pending":false}\n')
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''


def load_probe() -> ModuleType:
    spec = importlib.util.spec_from_file_location("dsh_harness_notion_probe", PROBE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("probe module unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PROBE = load_probe()


def capture_trace_wrapper(
    target: Path,
    arguments: list[str],
    *,
    fail_index: int = 0,
    environment: dict[str, str] | None = None,
) -> tuple[object, bytes, bytes]:
    wrapper_descriptor = PROBE.anonymous_descriptor(
        "dsh-probe-self-test-wrapper",
        PROBE.TRACE_WRAPPER_SOURCE,
        seal=True,
    )
    trace_descriptor = PROBE.anonymous_descriptor("dsh-probe-self-test-trace")
    trace_key = os.urandom(32)
    key_descriptor = PROBE.one_shot_key_descriptor(trace_key)
    try:
        completed = PROBE.capture_command(
            [
                sys.executable,
                "-I",
                "-S",
                "-B",
                f"/proc/self/fd/{wrapper_descriptor}",
                str(target),
                str(trace_descriptor),
                str(fail_index),
                "--",
                *arguments,
            ],
            env=environment or {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "NOTION_TOKEN_FILE": "/unavailable/synthetic-token",
            },
            cwd=target.parent,
            input_bytes=None,
            pass_fds=(wrapper_descriptor, trace_descriptor, key_descriptor),
            close_after_spawn=(key_descriptor,),
        )
        trace = PROBE.read_descriptor_bounded(trace_descriptor, PROBE.MAX_TRACE_BYTES)
        return completed, trace, trace_key
    finally:
        with contextlib.suppress(OSError):
            os.close(key_descriptor)
        os.close(trace_descriptor)
        os.close(wrapper_descriptor)


def execute_trace_wrapper(
    target: Path,
    arguments: list[str],
    *,
    fail_index: int = 0,
    environment: dict[str, str] | None = None,
) -> tuple[object, list[dict[str, object]]]:
    completed, trace, trace_key = capture_trace_wrapper(
        target,
        arguments,
        fail_index=fail_index,
        environment=environment,
    )
    events = PROBE.parse_trace(trace, trace_key)
    PROBE.validate_trace_outcome(events, completed.returncode)
    return completed, events


@contextlib.contextmanager
def malicious_fixture(source: str) -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="dsh-malicious-notion-fixture-") as raw_root:
        path = Path(raw_root) / "notion_inbox_sync.py"
        path.write_text(source + INTERFACE_MARKERS, encoding="utf-8")
        path.chmod(0o600)
        yield path


class HarnessNotionAutomationProbeTests(unittest.TestCase):
    @staticmethod
    def seed_atomic_tree(
        sandbox: object,
        *,
        mirror: str = PROBE.REMOTE_INITIAL,
        residue: bool = True,
    ) -> None:
        sandbox.task_directory.mkdir(parents=True, mode=0o700)
        PROBE.write_private_file(sandbox.inbox, mirror.encode("utf-8"))
        PROBE.write_private_file(sandbox.state, b'{"pending":null}\n')
        PROBE.write_private_file(sandbox.fingerprint, b'{"base":"synthetic"}\n')
        if residue:
            PROBE.write_private_file(
                sandbox.task_directory / "crash-residue.tmp",
                b"synthetic crash residue\n",
            )

    def assert_rejected(self, source: str, check: str) -> None:
        with malicious_fixture(source) as entrypoint:
            with self.assertRaises(PROBE.ProbeFailure):
                PROBE.ContractProbe(entrypoint).run_named(check)

    def test_probe_sandbox_matches_the_production_first_pull_boundary(self) -> None:
        with malicious_fixture("raise SystemExit(0)\n") as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox:
                self.assertTrue(sandbox.storages_directory.is_dir())
                self.assertFalse(sandbox.task_directory.exists())
                self.assertEqual(
                    PROBE.read_regular(sandbox.token, 1024, mode=0o600),
                    PROBE.FAKE_TOKEN.encode("utf-8"),
                )

    def test_probe_and_remote_runner_failure_stage_allowlists_match(self) -> None:
        runner_path = RELEASE_ROOT / "scripts/harness-notion-automation-remote.py"
        tree = ast.parse(runner_path.read_text(encoding="utf-8"))
        assignments = [
            node
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name)
                and target.id == "TRUSTED_PROBE_STAGES"
                for target in node.targets
            )
        ]
        self.assertEqual(1, len(assignments))
        remote_stages = tuple(ast.literal_eval(assignments[0].value))
        self.assertEqual(len(remote_stages), len(set(remote_stages)))
        self.assertEqual(set(PROBE.PROBE_FAILURE_STAGES), set(remote_stages))

    def test_atomic_scenarios_cover_remote_and_local_write_recovery_paths(self) -> None:
        scenarios = {scenario.name: scenario for scenario in PROBE.ATOMIC_SCENARIOS}
        self.assertEqual(
            set(scenarios),
            {
                "pull",
                "set",
                "force-set",
                "push",
                "queued-set",
                "queued-push",
                "queued-force-set",
                "pending-retry",
                "pending-retry-push",
                "pending-retry-force",
            },
        )
        self.assertEqual(scenarios["set"].arguments, ("--set", "-", "--json"))
        self.assertEqual(scenarios["push"].arguments, ("--push", "--json"))
        self.assertEqual(
            scenarios["pending-retry"].arguments,
            ("--retry-pending", "--json"),
        )
        self.assertEqual(scenarios["queued-set"].expected_status, "queued")
        self.assertEqual(scenarios["queued-push"].expected_status, "queued")
        self.assertEqual(scenarios["queued-force-set"].expected_status, "queued")
        self.assertEqual(scenarios["pending-retry"].expected_status, "synced")
        self.assertTrue(
            all(
                not hasattr(scenario, "required_roles")
                for scenario in scenarios.values()
            )
        )
        self.assertEqual(
            PROBE.INITIAL_PULL_REQUIRED_ROLES,
            frozenset({"mirror", "state", "fingerprint"}),
        )

    def test_initial_pull_has_a_traced_pre_and_post_rename_crash_matrix(self) -> None:
        self.assertEqual(PROBE.INITIAL_PULL_ARGUMENTS, ("--pull", "--json"))
        self.assertEqual(
            PROBE.INITIAL_PULL_REQUIRED_ROLES,
            frozenset({"mirror", "state", "fingerprint"}),
        )

        def nested_code_names(code: types.CodeType) -> set[str]:
            names = set(code.co_names)
            for value in code.co_consts:
                if isinstance(value, type(code)):
                    names.update(nested_code_names(value))
            return names

        def nested_string_constants(code: types.CodeType) -> set[str]:
            values = {
                value for value in code.co_consts if isinstance(value, str)
            }
            for value in code.co_consts:
                if isinstance(value, type(code)):
                    values.update(nested_string_constants(value))
            return values

        names = nested_code_names(
            PROBE.ContractProbe.check_initial_pull_atomic.__code__
        )
        self.assertTrue(
            {
                "traced_command",
                "validate_success_trace",
                "prepare_and_crash_initial_pull",
                "recover_initial_pull",
                "traced_atomic_recovery_crash",
                "assert_initial_pull_converged",
            }
            <= names
        )
        wired_stages = nested_string_constants(
            PROBE.ContractProbe.check_initial_pull_atomic.__code__
        ) | nested_string_constants(
            PROBE.ContractProbe.check_atomic_artifacts.__code__
        )
        symlink_stages = {
            stage
            for buckets in PROBE.SYMLINK_PREFLIGHT_STAGES.values()
            for stage in buckets.values()
        }
        self.assertTrue(
            set(PROBE.ATOMIC_PROBE_STAGES) - symlink_stages <= wired_stages
        )

    def test_secondary_crash_axis_is_linear_and_covers_each_real_kind(self) -> None:
        recoveries = [
            (
                seed,
                {
                    "first": PROBE.MAX_RENAME_FAILPOINTS,
                    "recovered": PROBE.MAX_RENAME_FAILPOINTS // 2,
                },
            )
            for seed in range(1, PROBE.MAX_RENAME_FAILPOINTS + 1)
        ]
        cases = PROBE.ContractProbe.secondary_axis_cases(recoveries)
        self.assertLessEqual(
            len(cases),
            (
                PROBE.MAX_RENAME_FAILPOINTS
                + PROBE.MAX_RENAME_FAILPOINTS // 2
                + 2 * (len(recoveries) - 1)
            ),
        )
        self.assertEqual(
            {
                fail_index
                for seed, kind, fail_index in cases
                if seed == 1 and kind == "first"
            },
            set(range(1, PROBE.MAX_RENAME_FAILPOINTS + 1)),
        )
        self.assertEqual(
            {
                fail_index
                for seed, kind, fail_index in cases
                if seed == 1 and kind == "recovered"
            },
            set(range(1, PROBE.MAX_RENAME_FAILPOINTS // 2 + 1)),
        )
        for seed in range(2, PROBE.MAX_RENAME_FAILPOINTS + 1):
            self.assertIn((seed, "first", 1), cases)
            self.assertIn((seed, "recovered", 1), cases)

    def test_success_trace_accepts_repeated_state_publish_and_missing_temp_cleanup(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="dsh-repeated-state-publish-") as raw_root:
            root = Path(raw_root)
            task = root / "task-inbox"
            task.mkdir()
            paths = {
                "mirror": task / "inbox.md",
                "state": task / "sync-state.json",
                "fingerprint": task / "notion-fingerprint.json",
            }
            initial = {
                "mirror": b"synthetic mirror\n",
                "state": b'{"pending":null}\n',
                "fingerprint": b"{}\n",
            }
            for role, path in paths.items():
                path.write_bytes(initial[role])
                path.chmod(0o600)
            before_values = {
                role: path.read_bytes() for role, path in paths.items()
            }
            before_inodes = {
                role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                for role, path in paths.items()
            }
            target = root / "publisher.py"
            target.write_text(REPEATED_STATE_PUBLISHER, encoding="utf-8")
            target.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [str(task)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": str(root / "unused-token"),
                    "NOTION_INBOX_FILE": str(paths["mirror"]),
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            after_values = {
                role: path.read_bytes() for role, path in paths.items()
            }
            after_inodes = {
                role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                for role, path in paths.items()
            }

            class SandboxView:
                task_directory = task
                inbox = paths["mirror"]
                state = paths["state"]
                fingerprint = paths["fingerprint"]

            probe = object.__new__(PROBE.ContractProbe)
            PROBE.reject_unsafe_write_events(events)
            self.assertFalse(
                any(
                    event.get("type") == "post-publish-write"
                    for event in events
                )
            )
            self.assertEqual(
                4,
                probe.validate_success_trace(
                    SandboxView(),
                    events,
                    before_values,
                    before_inodes,
                    after_values,
                    after_inodes,
                    set(),
                ),
            )
            first_create_position = next(
                position
                for position, event in enumerate(events)
                if event.get("type") == "create"
            )
            first_create = events[first_create_position]
            handle_events = list(events)
            handle_events.insert(
                first_create_position + 1,
                {
                    "type": "fd-handle-open",
                    "descriptor": 99,
                    "dev": first_create["dev"],
                    "ino": first_create["ino"],
                    "mechanism": "os.fdopen",
                },
            )
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_rename_trace_contract(
                    SandboxView(),
                    handle_events,
                    crashed=False,
                )
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_success_trace(
                    SandboxView(),
                    events,
                    before_values,
                    before_inodes,
                    after_values,
                    after_inodes,
                    {"unknown-role"},
                )
            missing_cleanups = [
                event
                for event in events
                if event.get("type") == "path-remove"
                and event.get("path") == str(task / "sync-state.json.tmp")
            ]
            self.assertEqual(2, len(missing_cleanups))
            self.assertTrue(
                all(event.get("before", {}).get("exists") is False for event in missing_cleanups)
            )

            predecessor_drift = json.loads(json.dumps(events))
            state_renames = [
                event
                for event in predecessor_drift
                if event.get("type") == "rename"
                and event.get("destinationAfter", {}).get("path") == str(paths["state"])
            ]
            self.assertEqual(2, len(state_renames))
            state_renames[1]["destinationBefore"]["sha256"] = "0" * 64
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_success_trace(
                    SandboxView(), predecessor_drift, before_values, before_inodes,
                    after_values, after_inodes, {"state"},
                )

            existing_temp_remove = json.loads(json.dumps(events))
            removal = next(
                event
                for event in existing_temp_remove
                if event.get("type") == "path-remove"
            )
            removal["before"] = {
                "exists": True,
                "path": removal["path"],
                "kind": "file",
                "mode": 0o600,
            }
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_success_trace(
                    SandboxView(), existing_temp_remove, before_values, before_inodes,
                    after_values, after_inodes, {"state"},
                )

    def test_initial_crash_accepts_repeated_state_publish_and_missing_temp_cleanup(
        self,
    ) -> None:
        for fail_index in range(1, 5):
            with self.subTest(fail_index=fail_index), tempfile.TemporaryDirectory(
                prefix="dsh-initial-repeated-state-crash-"
            ) as raw_root:
                root = Path(raw_root)
                task = root / "storages/task-inbox"
                task.mkdir(parents=True)
                target = root / "publisher.py"
                target.write_text(REPEATED_STATE_PUBLISHER, encoding="utf-8")
                target.chmod(0o600)
                completed, events = execute_trace_wrapper(
                    target,
                    [str(task)],
                    fail_index=fail_index,
                    environment={
                        "PATH": "/usr/local/bin:/usr/bin:/bin",
                        "LANG": "C.UTF-8",
                        "NOTION_TOKEN_FILE": str(root / "unused-token"),
                        "NOTION_INBOX_FILE": str(task / "inbox.md"),
                    },
                )

                class SandboxView:
                    dsh_home = root
                    task_directory = task
                    inbox = task / "inbox.md"
                    state = task / "sync-state.json"
                    fingerprint = task / "notion-fingerprint.json"

                    def assert_task_tree_redacted(self) -> None:
                        for candidate in self.task_directory.iterdir():
                            if candidate.is_file():
                                PROBE.assert_artifact_redacted(candidate.read_bytes())

                probe = object.__new__(PROBE.ContractProbe)
                probe.validate_injected_crash(completed, events, fail_index)
                probe.validate_initial_crash_artifacts(SandboxView(), events)

    def test_success_trace_rejects_off_task_create_write_and_cleanup(self) -> None:
        source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

task = Path(sys.argv[1])
escaped = task.parent / "off-task-private.tmp"
descriptor = os.open(
    escaped,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
private_value = b"synthetic private content"
offset = 0
while offset < len(private_value):
    offset += os.write(descriptor, private_value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.unlink(escaped)

state = task / "sync-state.json"
temporary = task / "sync-state.json.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
state_value = b'{"pending":false}\n'
offset = 0
while offset < len(state_value):
    offset += os.write(descriptor, state_value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, state)
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-off-task-create-") as raw_root:
            root = Path(raw_root)
            task = root / "task-inbox"
            task.mkdir()
            paths = {
                "mirror": task / "inbox.md",
                "state": task / "sync-state.json",
                "fingerprint": task / "notion-fingerprint.json",
            }
            initial = {
                "mirror": b"synthetic mirror\n",
                "state": b'{"pending":null}\n',
                "fingerprint": b"{}\n",
            }
            for role, path in paths.items():
                path.write_bytes(initial[role])
                path.chmod(0o600)
            before_values = {
                role: path.read_bytes() for role, path in paths.items()
            }
            before_inodes = {
                role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                for role, path in paths.items()
            }
            target = root / "publisher.py"
            target.write_text(source, encoding="utf-8")
            target.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [str(task)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": str(root / "unused-token"),
                    "NOTION_INBOX_FILE": str(paths["mirror"]),
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertFalse((root / "off-task-private.tmp").exists())
            after_values = {
                role: path.read_bytes() for role, path in paths.items()
            }
            after_inodes = {
                role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                for role, path in paths.items()
            }

            class SandboxView:
                task_directory = task
                inbox = paths["mirror"]
                state = paths["state"]
                fingerprint = paths["fingerprint"]

            escaped_path = str(root / "off-task-private.tmp")
            escaped_create = next(
                event
                for event in events
                if event.get("type") == "create"
                and event.get("path") == escaped_path
            )
            escaped_identity = (escaped_create["dev"], escaped_create["ino"])
            escaped_event_types = [
                event.get("type")
                for event in events
                if (
                    (event.get("dev"), event.get("ino")) == escaped_identity
                    or event.get("path") == escaped_path
                )
            ]
            self.assertTrue(
                {"create", "fd-write", "fsync", "fd-close", "path-remove"}
                <= set(escaped_event_types)
            )
            PROBE.reject_unsafe_write_events(events)
            probe = object.__new__(PROBE.ContractProbe)
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_success_trace(
                    SandboxView(),
                    events,
                    before_values,
                    before_inodes,
                    after_values,
                    after_inodes,
                    {"state"},
                )

            without_escaped_create = [
                event
                for event in events
                if not (
                    event.get("type") == "create"
                    and event.get("path") == escaped_path
                )
            ]
            with self.assertRaises(PROBE.ProbeFailure):
                probe.validate_success_trace(
                    SandboxView(),
                    without_escaped_create,
                    before_values,
                    before_inodes,
                    after_values,
                    after_inodes,
                    {"state"},
                )

    def test_no_change_transition_rejects_retained_off_task_create(self) -> None:
        source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
escaped = Path("/dev/shm") / (
    "dsh-off-task-retained-" + Path(os.environ["NOTION_TOKEN_FILE"]).parent.name
)
descriptor = os.open(
    escaped,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
private_value = b"synthetic retained private content"
offset = 0
while offset < len(private_value):
    offset += os.write(descriptor, private_value[offset:])
os.fsync(descriptor)
os.close(descriptor)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox, residue=False)
                before = probe.partial_atomic_snapshot(sandbox)
                escaped = Path("/dev/shm") / (
                    "dsh-off-task-retained-" + sandbox.root.name
                )
                self.assertFalse(escaped.exists())
                try:
                    with self.assertRaises(PROBE.ProbeFailure):
                        probe.traced_atomic_transition(
                            sandbox,
                            notion,
                            ["--retry-pending", "--json"],
                            expected_mirror=PROBE.REMOTE_INITIAL,
                            token_forbidden=True,
                        )
                    self.assertTrue(escaped.is_file())
                    self.assertEqual(
                        before.canonical_values,
                        {
                            role: path.read_bytes()
                            for role, path in probe.artifact_paths(sandbox).items()
                        },
                    )
                    self.assertEqual((), notion.state.snapshot())
                finally:
                    escaped.unlink(missing_ok=True)
                self.assertEqual(
                    before.canonical_values,
                    sandbox.read_artifacts(PROBE.REMOTE_INITIAL),
                )

    def test_entrypoint_introspection_and_process_escape_sources_fail_closed(self) -> None:
        hostile_sources = (
            "import inspect\ninspect.currentframe()\n",
            "import gc\ngc.get_objects()\n",
            "import runpy\nrunpy.run_path('x')\n",
            "import ctypes\nctypes.CDLL(None)\n",
            "import sys\nsys._getframe()\n",
            "import os\nos.listdir('/proc/self/fd')\n",
            "import os\nos.system('true')\n",
            "import os\nos.open = lambda *args: 7\n",
            "import os as disguised\ndisguised.replace = lambda *args: None\n",
            "import io\nio.open = lambda *args: None\n",
            "import os\nfirst = os\nsecond = first\nsecond.write = lambda *args: 0\n",
            "import os, io\nfirst = second = os\nsecond.write = lambda *args: 0\n",
            "import os, io\n(first, second) = (os, io)\nfirst.write = lambda *args: 0\n",
            "import os\nalias: object = os\nalias.write = lambda *args: 0\n",
            "import os\n(alias := os)\nalias.write = lambda *args: 0\n",
            "import os\nwriter = os.write\nsecondary = writer\nsecondary.marker = True\n",
            "alias = open\nsecondary = alias\nsecondary.marker = True\n",
            "import os\ndef identity():\n    return os\nalias = identity()\nalias.write = lambda *args: 0\n",
            "import os\ndef patch(alias):\n    alias.write = lambda *args: 0\npatch(os)\n",
            "import os\nfor alias in (os,):\n    alias.write = lambda *args: 0\n",
            "import builtins\nbuiltins.open = lambda *args: None\n",
            "import urllib.request\nalias = urllib.request.os\nalias.write = lambda *args: 0\n",
            "from urllib.request import os as alias\nalias.write = lambda *args: 0\n",
            "def open(*args):\n    return None\n",
            "from os import execve\n",
            "import subprocess\nsubprocess.run(['true'])\n",
            "getattr(lambda: None, '__globals__')\n",
            "exec(compile('pass', 'x', 'exec'))\n",
            "import os\nprint(type(os.open))\n",
        )
        for source in hostile_sources:
            with self.subTest(source=source), malicious_fixture(source) as entrypoint:
                with self.assertRaises(PROBE.ProbeFailure):
                    PROBE.ContractProbe(entrypoint)

    def test_entrypoint_policy_allows_narrow_standard_library_mechanics(self) -> None:
        source = b'''from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

def _flags():
    return os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)

if __name__ == "__main__":
    Path(os.environ["NOTION_INBOX_FILE"])
    json.dumps({"status": "error"})
    sys.exit(1)
'''
        PROBE.validate_safe_entrypoint_source(source)

    def test_trace_wrapper_and_trace_are_anonymous_descriptors(self) -> None:
        wrapper = PROBE.anonymous_descriptor("synthetic-sealed-wrapper", b"print('x')\n", seal=True)
        trace = PROBE.anonymous_descriptor("synthetic-trace")
        key = PROBE.one_shot_key_descriptor(b"k" * 32)
        try:
            seals = fcntl.fcntl(wrapper, fcntl.F_GET_SEALS)
            self.assertEqual(
                seals,
                fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE,
            )
            with self.assertRaises(OSError):
                os.write(wrapper, b"tamper")
            self.assertIn("memfd:synthetic-sealed-wrapper", os.readlink(f"/proc/self/fd/{wrapper}"))
            self.assertIn("memfd:synthetic-trace", os.readlink(f"/proc/self/fd/{trace}"))
            self.assertIn(
                "memfd:dsh-notion-contract-trace-key-v1",
                os.readlink(f"/proc/self/fd/{key}"),
            )
            self.assertEqual(fcntl.fcntl(key, fcntl.F_GETFL) & os.O_ACCMODE, os.O_RDONLY)
            self.assertEqual(fcntl.fcntl(key, fcntl.F_GET_SEALS), seals)
        finally:
            os.close(key)
            os.close(trace)
            os.close(wrapper)

    def test_anonymous_descriptors_respect_a_1024_soft_fd_limit(self) -> None:
        script = f'''\
import os
import resource
import runpy

soft_limit, hard_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
if hard_limit != resource.RLIM_INFINITY and hard_limit < 1024:
    raise SystemExit(77)
resource.setrlimit(resource.RLIMIT_NOFILE, (1024, hard_limit))
probe = runpy.run_path({str(PROBE_PATH)!r}, run_name="fd_limit_probe")
wrapper = probe["anonymous_descriptor"]("limited-wrapper", b"print('x')\\n", seal=True)
trace = probe["anonymous_descriptor"]("limited-trace")
key = probe["one_shot_key_descriptor"](b"k" * 32)
try:
    descriptors = (wrapper, trace, key)
    if not all(512 <= descriptor < 1024 for descriptor in descriptors):
        raise SystemExit(78)
finally:
    os.close(key)
    os.close(trace)
    os.close(wrapper)
'''
        completed = subprocess.run(
            [sys.executable, "-B", "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)

        with mock.patch.object(
            PROBE.resource, "getrlimit", return_value=(1024, 1024)
        ), mock.patch.object(
            PROBE.os, "urandom", return_value=(383).to_bytes(4, "big")
        ):
            self.assertEqual(895, PROBE.randomized_descriptor_floor())

    def test_child_command_failure_keeps_the_bounded_output_tail(self) -> None:
        result = PROBE.CommandResult(
            17,
            b"stdout-prefix\n" + b"x" * 40000 + b"stdout-tail\n",
            b"stderr-prefix\n" + b"y" * 40000 + b"stderr-tail\n",
        )
        with self.assertRaises(PROBE.ProbeFailure) as raised:
            PROBE.fail_command_result(result)
        message = str(raised.exception)
        self.assertIn("returncode=17", message)
        self.assertIn("stdout-tail", message)
        self.assertIn("stderr-tail", message)
        self.assertNotIn("stdout-prefix", message)
        self.assertNotIn("stderr-prefix", message)

    def test_authenticated_trace_rejects_tamper_drop_replay_and_wrong_key(self) -> None:
        target_source = "#!/usr/bin/env python3\n"
        with tempfile.TemporaryDirectory(prefix="dsh-trace-auth-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            completed, trace, key = capture_trace_wrapper(target, [])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        events = PROBE.parse_trace(trace, key)
        PROBE.validate_trace_outcome(events, completed.returncode)
        self.assertEqual(events[0], {"type": "trace-start", "version": 1})
        self.assertEqual(events[-1], {"type": "trace-end", "outcome": "returned"})
        lines = trace.splitlines(keepends=True)
        variants = (
            trace.replace(b'"version":1', b'"version":2', 1),
            b"".join(lines[1:]),
            b"".join(lines[:-1]),
            trace + lines[0],
            lines[0] + lines[0] + b"".join(lines[1:]),
        )
        for tampered in variants:
            with self.subTest(tampered=tampered[:32]), self.assertRaises(PROBE.ProbeFailure):
                PROBE.parse_trace(tampered, key)
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.parse_trace(trace, os.urandom(32))

    def test_trace_exit_outcome_matches_returncode_without_exception_leakage(self) -> None:
        cases = (
            ("natural", "pass\n", 0, "returned", b""),
            ("system-exit-none", "raise SystemExit(None)\n", 0, "returned", b""),
            ("system-exit-zero", "raise SystemExit(0)\n", 0, "returned", b""),
            ("system-exit-nonzero", "raise SystemExit(7)\n", 7, "failed", b""),
            (
                "system-exit-noninteger",
                "raise SystemExit('SYNTHETIC_EXIT_MUST_NOT_LEAK')\n",
                1,
                "failed",
                b"SYNTHETIC_EXIT_MUST_NOT_LEAK",
            ),
            (
                "exception",
                "raise RuntimeError('SYNTHETIC_EXCEPTION_MUST_NOT_LEAK')\n",
                1,
                "failed",
                b"SYNTHETIC_EXCEPTION_MUST_NOT_LEAK",
            ),
        )
        for name, body, returncode, outcome, secret in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory(
                prefix="dsh-trace-exit-test-"
            ) as raw_root:
                target = Path(raw_root) / "target.py"
                target.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
                target.chmod(0o600)
                completed, events = execute_trace_wrapper(target, [])
                self.assertEqual(completed.returncode, returncode)
                self.assertEqual(events[-1], {"type": "trace-end", "outcome": outcome})
                self.assertEqual(completed.stdout, b"")
                self.assertEqual(completed.stderr, b"")
                if secret:
                    self.assertNotIn(secret, PROBE.canonical_json(events))

    def test_scanned_trace_fd_truncate_and_fabrication_cannot_forge_evidence(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import fcntl
import io
import json
import os
import stat

command_path = "/" + "proc" + "/self/" + "cmdline"
command_descriptor = os.open(command_path, os.O_RDONLY)
command_line = b""
while True:
    chunk = os.read(command_descriptor, 4096)
    if not chunk:
        break
    command_line += chunk
os.close(command_descriptor)
arguments = command_line.split(b"\0")
separator = arguments.index(b"--")
computed_fail_index = int(arguments[separator - 1])

candidates = []
descriptor_root = "/" + "proc" + "/self/" + "fd"
for name in os.listdir(descriptor_root):
    if not name.isdecimal():
        continue
    descriptor = int(name)
    try:
        metadata = os.fstat(descriptor)
        seals = fcntl.fcntl(descriptor, fcntl.F_GET_SEALS)
    except OSError:
        continue
    if stat.S_ISREG(metadata.st_mode) and seals == 0:
        candidates.append(descriptor)
if len(candidates) != 1:
    raise SystemExit(7)
fabricated = {
    "type": "rename",
    "index": computed_fail_index,
    "crash": bool(computed_fail_index),
}
stream = io.FileIO(candidates[0], "r+", closefd=False)
stream.seek(0)
stream.truncate(0)
stream.write((json.dumps(fabricated, sort_keys=True) + "\n").encode("utf-8"))
stream.flush()
'''
        with tempfile.TemporaryDirectory(prefix="dsh-trace-forge-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            completed, trace, key = capture_trace_wrapper(target, [], fail_index=0)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(key, trace)
        self.assertNotIn(key, completed.stdout)
        self.assertNotIn(key, completed.stderr)
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.parse_trace(trace, key)

    def test_token_trace_requires_nofollow_stable_identity_and_full_read(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os

path = os.environ["NOTION_TOKEN_FILE"]
for attempt in range(2):
    before = os.lstat(path)
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    remaining = opened.st_size
    while remaining:
        chunk = os.read(descriptor, remaining)
        if not chunk:
            raise SystemExit(2)
        remaining -= len(chunk)
    after = os.fstat(descriptor)
    os.close(descriptor)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-token-trace-test-") as raw_root:
            root = Path(raw_root)
            target = root / "token-reader.py"
            token = root / "token"
            target.write_text(target_source, encoding="utf-8")
            token.write_text("synthetic-token\n", encoding="utf-8")
            target.chmod(0o600)
            token.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": str(token),
                },
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        PROBE.ContractProbe.validate_token_trace(events)
        insecure = [dict(event) for event in events]
        next(event for event in insecure if event.get("type") == "token-open")["flags"] = os.O_RDONLY
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_token_trace(insecure)
        no_cloexec = [dict(event) for event in events]
        next(event for event in no_cloexec if event.get("type") == "token-open")[
            "flags"
        ] = os.O_RDONLY | os.O_NOFOLLOW
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_token_trace(no_cloexec)

    def test_token_trace_accepts_fstat_only_and_rejects_mismatched_optional_lstat(
        self,
    ) -> None:
        target_source = r'''#!/usr/bin/env python3
import os

path = os.environ["NOTION_TOKEN_FILE"]
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
descriptor = os.open(path, flags)
opened = os.fstat(descriptor)
remaining = opened.st_size
while remaining:
    chunk = os.read(descriptor, remaining)
    if not chunk:
        raise SystemExit(2)
    remaining -= len(chunk)
os.fstat(descriptor)
os.close(descriptor)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-token-fstat-only-test-") as raw_root:
            root = Path(raw_root)
            target = root / "token-reader.py"
            token = root / "token"
            target.write_text(target_source, encoding="utf-8")
            token.write_text("synthetic-token\n", encoding="utf-8")
            target.chmod(0o600)
            token.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": str(token),
                },
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(any(event.get("type") == "token-lstat" for event in events))
        PROBE.ContractProbe.validate_token_trace(events)

        stable_fields = (
            "dev", "ino", "kind", "mode", "nlink", "uid", "gid", "size",
            "mtimeNs", "ctimeNs",
        )
        with_optional_lstat: list[dict[str, object]] = []
        for event in events:
            if event.get("type") == "token-open":
                with_optional_lstat.append({
                    "type": "token-lstat",
                    **{field: event.get(field) for field in stable_fields},
                })
            with_optional_lstat.append(dict(event))
        PROBE.ContractProbe.validate_token_trace(with_optional_lstat)
        PROBE.ContractProbe.validate_crash_token_trace(with_optional_lstat, ())
        mismatch = [dict(event) for event in with_optional_lstat]
        lstat_event = next(
            event for event in mismatch if event.get("type") == "token-lstat"
        )
        lstat_event["ino"] = int(lstat_event["ino"]) + 1
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_token_trace(mismatch)

    def test_token_trace_rejects_nested_insecure_descriptor_cycle(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os

path = os.environ["NOTION_TOKEN_FILE"]
safe = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
os.fstat(safe)
unsafe = os.open(path, os.O_RDONLY)
size = os.fstat(unsafe).st_size
os.read(unsafe, size)
os.fstat(unsafe)
os.close(unsafe)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-token-nested-fd-test-") as raw_root:
            root = Path(raw_root)
            target = root / "token-reader.py"
            token = root / "token"
            target.write_text(target_source, encoding="utf-8")
            token.write_text("synthetic-token\n", encoding="utf-8")
            target.chmod(0o600)
            token.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": str(token),
                },
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        opens = [event for event in events if event.get("type") == "token-open"]
        self.assertEqual(len(opens), 2)
        self.assertNotEqual(opens[0].get("descriptor"), opens[1].get("descriptor"))
        self.assertEqual(opens[1].get("flags"), os.O_RDONLY)
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_token_trace(events)

    def test_crash_token_trace_allows_pre_token_crash_only_before_any_request(
        self,
    ) -> None:
        PROBE.ContractProbe.validate_crash_token_trace([], ())
        pre_open = [{
            "type": "token-lstat",
            "dev": 1,
            "ino": 2,
            "kind": "file",
            "mode": 0o600,
            "nlink": 1,
            "uid": 1000,
            "gid": 1000,
            "size": 17,
            "mtimeNs": 3,
            "ctimeNs": 4,
        }]
        PROBE.ContractProbe.validate_crash_token_trace(pre_open, ())
        request = PROBE.RequestRecord(
            method="PATCH",
            path="/v1/pages/synthetic/markdown",
            authorization="Bearer synthetic",
            notion_version=PROBE.NOTION_VERSION,
            request_body=b"{}",
            valid=True,
        )
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_crash_token_trace([], (request,))
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_crash_token_trace(pre_open, (request,))
        drifted_pre_open = [dict(pre_open[0]), dict(pre_open[0])]
        drifted_pre_open[1]["ino"] = 3
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_crash_token_trace(drifted_pre_open, ())
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.ContractProbe.validate_crash_token_trace(
                [{"type": "token-open", "descriptor": 3}],
                (),
            )

    def test_atomic_convergence_repeats_only_equivalent_pull(self) -> None:
        scenario = next(
            value for value in PROBE.ATOMIC_SCENARIOS if value.name == "set"
        )
        recovered_values = {
            "mirror": b"synthetic mirror",
            "state": b"synthetic state",
            "fingerprint": b"synthetic fingerprint",
        }
        sandbox = mock.Mock()
        notion = mock.Mock()
        notion.state.body = scenario.expected_remote
        notion.state.snapshot.return_value = ()
        probe = object.__new__(PROBE.ContractProbe)
        probe.traced_atomic_transition = mock.Mock(
            return_value=PROBE.AtomicTransition(
                PROBE.CommandResult(0, b"", b""),
                [],
                recovered_values,
                {"mirror": (1, 1), "state": (1, 2), "fingerprint": (1, 3)},
                0,
            )
        )

        probe.assert_atomic_converged(
            scenario,
            sandbox,
            notion,
            recovered_values,
        )

        probe.traced_atomic_transition.assert_called_once_with(
            sandbox,
            notion,
            ["--retry-pending", "--json"],
            expected_mirror=scenario.expected_mirror,
            token_forbidden=True,
        )

    def test_partial_atomic_snapshot_accepts_missing_canonical_and_safe_residue(self) -> None:
        with malicious_fixture("raise SystemExit(0)\n") as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                PROBE.write_private_file(
                    sandbox.inbox, PROBE.REMOTE_INITIAL.encode("utf-8")
                )
                PROBE.write_private_file(
                    sandbox.task_directory / "crash-residue.tmp",
                    b"synthetic crash residue\n",
                )
                snapshot = probe.partial_atomic_snapshot(sandbox)
                self.assertEqual(set(snapshot.canonical_values), {"mirror"})
                self.assertEqual(
                    set(Path(path).name for path in snapshot.residues),
                    {"crash-residue.tmp"},
                )

            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                residue = sandbox.task_directory / "wrong-mode.tmp"
                residue.write_bytes(b"synthetic wrong mode\n")
                residue.chmod(0o644)
                with self.assertRaises(PROBE.ProbeFailure):
                    probe.partial_atomic_snapshot(sandbox)

            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                external = sandbox.root / "external"
                PROBE.write_private_file(external, b"synthetic external\n")
                (sandbox.task_directory / "residue-link").symlink_to(external)
                with self.assertRaises(PROBE.ProbeFailure):
                    probe.partial_atomic_snapshot(sandbox)

            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                (sandbox.task_directory / "residue-directory").mkdir()
                with self.assertRaises(PROBE.ProbeFailure):
                    probe.partial_atomic_snapshot(sandbox)

            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                external = sandbox.root / "hardlink-source"
                PROBE.write_private_file(external, b"synthetic hardlink\n")
                os.link(external, sandbox.task_directory / "residue-hardlink")
                with self.assertRaises(PROBE.ProbeFailure):
                    probe.partial_atomic_snapshot(sandbox)

    def test_traced_recovery_accepts_safe_cleanup_and_safe_fresh_publication(self) -> None:
        cleanup_source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
os.unlink(task / "crash-residue.tmp")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with malicious_fixture(cleanup_source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox)
                notion.state.reset()
                transition = probe.traced_atomic_transition(
                    sandbox,
                    notion,
                    ["--pull", "--json"],
                    expected_mirror=PROBE.REMOTE_INITIAL,
                    require_recovery_fsync=True,
                )
                self.assertEqual(transition.result.returncode, 0)
                self.assertEqual(transition.failpoints, 0)
                self.assertEqual(notion.state.snapshot(), ())

        staged_cleanup_source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
os.unlink(task / "crash-residue.tmp")
first = task / "fresh-cleanup-a.tmp"
second = task / "fresh-cleanup-b.tmp"
descriptor = os.open(
    first,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = b"synthetic transient cleanup bytes"
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(first, second)
os.unlink(second)
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with malicious_fixture(staged_cleanup_source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox)
                notion.state.reset()
                transition = probe.traced_atomic_transition(
                    sandbox,
                    notion,
                    ["--pull", "--json"],
                    expected_mirror=PROBE.REMOTE_INITIAL,
                    token_forbidden=True,
                    require_recovery_fsync=True,
                )
                self.assertEqual(transition.result.returncode, 0)
                self.assertEqual(transition.failpoints, 2)
                self.assertEqual(notion.state.snapshot(), ())

        fsync_only_source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with malicious_fixture(fsync_only_source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox, residue=False)
                notion.state.reset()
                transition = probe.traced_atomic_transition(
                    sandbox,
                    notion,
                    ["--pull", "--json"],
                    expected_mirror=PROBE.REMOTE_INITIAL,
                    require_recovery_fsync=True,
                )
                self.assertEqual(transition.failpoints, 0)

        replacement = repr(PROBE.LOCAL_EDIT.encode("utf-8"))
        publish_source = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
os.unlink(task / "crash-residue.tmp")
temporary = task / "fresh-recovery.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {replacement}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with malicious_fixture(publish_source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox)
                notion.state.reset()
                transition = probe.traced_atomic_transition(
                    sandbox,
                    notion,
                    ["--pull", "--json"],
                    expected_mirror=PROBE.LOCAL_EDIT,
                    require_recovery_fsync=True,
                )
                self.assertEqual(transition.result.returncode, 0)
                self.assertEqual(transition.failpoints, 2)
                self.assertEqual(transition.values["mirror"], PROBE.LOCAL_EDIT.encode())

    def test_traced_recovery_rejects_unsafe_overwrite_and_token_reader(self) -> None:
        mirror_value = repr(PROBE.REMOTE_INITIAL.encode("utf-8"))
        unsafe_overwrite = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
with open(os.environ["NOTION_INBOX_FILE"], "wb") as stream:
    stream.write({mirror_value})
    stream.flush()
    os.fsync(stream.fileno())
os.unlink(task / "crash-residue.tmp")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        unsafe_token = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
with open(os.environ["NOTION_TOKEN_FILE"], "rb") as stream:
    stream.read()
os.unlink(task / "crash-residue.tmp")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        missing_cleanup_fsync = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
os.unlink(task / "crash-residue.tmp")
'''
        missing_post_rename_fsync = "raise SystemExit(0)\n"
        for name, source in {
            "direct-overwrite": unsafe_overwrite,
            "high-level-token": unsafe_token,
            "missing-cleanup-fsync": missing_cleanup_fsync,
            "missing-post-rename-fsync": missing_post_rename_fsync,
        }.items():
            with self.subTest(name=name), malicious_fixture(source) as entrypoint:
                probe = PROBE.ContractProbe(entrypoint)
                with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                    self.seed_atomic_tree(
                        sandbox,
                        residue=name != "missing-post-rename-fsync",
                    )
                    notion.state.reset()
                    with self.assertRaises(PROBE.ProbeFailure):
                        probe.traced_atomic_transition(
                            sandbox,
                            notion,
                            ["--pull", "--json"],
                            expected_mirror=PROBE.REMOTE_INITIAL,
                            require_recovery_fsync=True,
                        )

    def test_traced_no_pending_transition_rejects_token_metadata_preflight(self) -> None:
        metadata_only = r'''#!/usr/bin/env python3
import os
import sys

if "--retry-pending" in sys.argv:
    os.lstat(os.environ["NOTION_TOKEN_FILE"])
    raise SystemExit(0)
raise SystemExit(1)
'''
        with malicious_fixture(metadata_only) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                self.seed_atomic_tree(sandbox, residue=False)
                notion.state.reset()
                with self.assertRaises(PROBE.ProbeFailure):
                    probe.traced_atomic_transition(
                        sandbox,
                        notion,
                        ["--retry-pending", "--json"],
                        expected_mirror=PROBE.REMOTE_INITIAL,
                        token_forbidden=True,
                    )

    def test_traced_transition_rejects_untracked_temp_and_rename_shapes(self) -> None:
        high_level_cleanup = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
with open(task / "ephemeral.tmp", "xb") as stream:
    stream.write(b"synthetic ephemeral bytes")
os.unlink(task / "ephemeral.tmp")
os.unlink(task / "crash-residue.tmp")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        external_publication = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
temporary = task.parent / "outside.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {repr(PROBE.LOCAL_EDIT.encode("utf-8"))}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        caught_failed_rename = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
try:
    os.replace(task / "missing.tmp", task / "ignored.tmp")
except FileNotFoundError:
    pass
temporary = task / "fresh.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {repr(PROBE.LOCAL_EDIT.encode("utf-8"))}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        fdopen_empty = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
temporary = task / "empty.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
handle = os.fdopen(descriptor, "wb", closefd=False)
handle.close()
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        high_level_then_publish = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
untracked = task / "high-level.tmp"
with open(untracked, "xb") as stream:
    stream.write(b"synthetic high-level temporary bytes")
    stream.flush()
    os.fsync(stream.fileno())
os.unlink(untracked)
temporary = task / "fresh.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {repr(PROBE.LOCAL_EDIT.encode("utf-8"))}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        fdopen_then_publish = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
untracked = task / "fdopen.tmp"
untracked_descriptor = os.open(
    untracked,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
stream = os.fdopen(untracked_descriptor, "wb", closefd=False)
stream.write(b"synthetic fdopen temporary bytes")
stream.flush()
os.fsync(stream.fileno())
stream.close()
os.close(untracked_descriptor)
os.unlink(untracked)
temporary = task / "fresh.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {repr(PROBE.LOCAL_EDIT.encode("utf-8"))}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        nested_then_publish = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
nested = task / "nested-journal"
nested.mkdir(mode=0o700)
with open(nested / "journal.tmp", "xb") as stream:
    stream.write(b"synthetic nested journal bytes")
    stream.flush()
    os.fsync(stream.fileno())
os.unlink(nested / "journal.tmp")
os.rmdir(nested)
temporary = task / "fresh.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {repr(PROBE.LOCAL_EDIT.encode("utf-8"))}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        cases = {
            "high-level-cleanup": (high_level_cleanup, PROBE.REMOTE_INITIAL, True),
            "outside-publication": (external_publication, PROBE.LOCAL_EDIT, False),
            "caught-failed-rename": (caught_failed_rename, PROBE.LOCAL_EDIT, False),
            "fdopen-empty": (fdopen_empty, "", False),
            "high-level-then-publish": (
                high_level_then_publish,
                PROBE.LOCAL_EDIT,
                False,
            ),
            "fdopen-then-publish": (fdopen_then_publish, PROBE.LOCAL_EDIT, False),
            "nested-then-publish": (nested_then_publish, PROBE.LOCAL_EDIT, False),
        }
        for name, (source, expected_mirror, residue) in cases.items():
            with self.subTest(name=name), malicious_fixture(source) as entrypoint:
                probe = PROBE.ContractProbe(entrypoint)
                with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                    self.seed_atomic_tree(sandbox, residue=residue)
                    notion.state.reset()
                    with self.assertRaises(PROBE.ProbeFailure):
                        probe.traced_atomic_transition(
                            sandbox,
                            notion,
                            ["--pull", "--json"],
                            expected_mirror=expected_mirror,
                            token_forbidden=True,
                            require_recovery_fsync=True,
                        )

        for name, source in {
            "high-level-crash-residue": high_level_then_publish.replace(
                "os.unlink(untracked)", "# retain the unsafe crash residue"
            ),
            "nested-cleaned-before-crash": nested_then_publish,
        }.items():
            with self.subTest(name=name), malicious_fixture(source) as entrypoint:
                probe = PROBE.ContractProbe(entrypoint)
                with probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                    self.seed_atomic_tree(sandbox, residue=False)
                    result, events = probe.traced_command(
                        sandbox,
                        notion.api_base,
                        ["--pull", "--json"],
                        fail_index=1,
                    )
                    self.assertEqual(result.returncode, PROBE.CRASH_CODE)
                    with self.assertRaises(PROBE.ProbeFailure):
                        probe.validate_rename_trace_contract(
                            sandbox,
                            events,
                            crashed=True,
                        )

    def test_link_primitives_are_rejected_by_source_policy(self) -> None:
        for source in (
            "import os\nos.link('a', 'b')\n",
            "from pathlib import Path\nPath('a').hardlink_to('b')\n",
            "from pathlib import Path\nPath('a').symlink_to('b')\n",
        ):
            with self.subTest(source=source), malicious_fixture(source) as entrypoint:
                with self.assertRaises(PROBE.ProbeFailure):
                    PROBE.ContractProbe(entrypoint)

    def test_permission_ownership_and_acl_mutators_are_rejected_by_source_policy(
        self,
    ) -> None:
        temporary_mode_escape = r'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
temporary = task / "mode-escape.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.fchmod(descriptor, 0o644)
os.write(descriptor, b"synthetic private bytes")
os.fchmod(descriptor, 0o600)
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
'''
        for source in (
            temporary_mode_escape,
            "import os\nos.chmod('a', 0o644)\n",
            "import os\nos.lchmod('a', 0o644)\n",
            "import os\nos.chown('a', 1, 1)\n",
            "import os\nos.fchown(3, 1, 1)\n",
            "import os\nos.lchown('a', 1, 1)\n",
            "import os\nos.setxattr('a', 'user.synthetic', b'x')\n",
            "import os\nos.removexattr('a', 'user.synthetic')\n",
            "import shutil\nshutil.copymode('a', 'b')\n",
            "import shutil\nshutil.copystat('a', 'b')\n",
            "from pathlib import Path\nPath('a').chmod(0o644)\n",
        ):
            with self.subTest(source=source), malicious_fixture(source) as entrypoint:
                with self.assertRaises(PROBE.ProbeFailure):
                    PROBE.ContractProbe(entrypoint)

    def test_recovery_publication_has_before_and_after_crash_gates(self) -> None:
        replacement = repr(PROBE.LOCAL_EDIT.encode("utf-8"))
        source = rf'''#!/usr/bin/env python3
import os
from pathlib import Path

task = Path(os.environ["NOTION_INBOX_FILE"]).parent
os.unlink(task / "crash-residue.tmp")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
temporary = task / "fresh-recovery.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = {replacement}
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, Path(os.environ["NOTION_INBOX_FILE"]))
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            for fail_index in (1, 2):
                with self.subTest(fail_index=fail_index), probe.sandbox() as sandbox, PROBE.LoopbackNotion() as notion:
                    self.seed_atomic_tree(sandbox)
                    notion.state.reset()
                    probe.traced_atomic_recovery_crash(
                        sandbox,
                        notion,
                        ["--pull", "--json"],
                        fail_index=fail_index,
                    )
                    snapshot = probe.partial_atomic_snapshot(sandbox)
                    if fail_index == 1:
                        self.assertEqual(
                            snapshot.canonical_values["mirror"],
                            PROBE.REMOTE_INITIAL.encode(),
                        )
                        self.assertEqual(
                            set(Path(path).name for path in snapshot.residues),
                            {"fresh-recovery.tmp"},
                        )
                    else:
                        self.assertEqual(
                            snapshot.canonical_values["mirror"],
                            PROBE.LOCAL_EDIT.encode(),
                        )
                        self.assertEqual(snapshot.residues, {})

    def test_token_trace_rejects_seek_duplicate_and_alternate_reads(self) -> None:
        cases = {
            "seek-duplicate": r'''#!/usr/bin/env python3
import os
path = os.environ["NOTION_TOKEN_FILE"]
descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
size = os.fstat(descriptor).st_size
first = size // 2
os.read(descriptor, first)
os.lseek(descriptor, 0, os.SEEK_SET)
os.read(descriptor, size - first)
os.fstat(descriptor)
os.close(descriptor)
''',
            "pread": r'''#!/usr/bin/env python3
import os
path = os.environ["NOTION_TOKEN_FILE"]
descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
size = os.fstat(descriptor).st_size
os.pread(descriptor, size, 0)
os.read(descriptor, size)
os.fstat(descriptor)
os.close(descriptor)
''',
            "fdopen": r'''#!/usr/bin/env python3
import os
path = os.environ["NOTION_TOKEN_FILE"]
descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
size = os.fstat(descriptor).st_size
with os.fdopen(descriptor, "rb", closefd=False) as handle:
    handle.read()
os.fstat(descriptor)
os.close(descriptor)
''',
        }
        if hasattr(os, "preadv"):
            cases["preadv"] = r'''#!/usr/bin/env python3
import os
path = os.environ["NOTION_TOKEN_FILE"]
descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
size = os.fstat(descriptor).st_size
buffer = bytearray(size)
os.preadv(descriptor, [buffer], 0)
os.read(descriptor, size)
os.fstat(descriptor)
os.close(descriptor)
'''
        for name, source in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(
                prefix="dsh-token-alternate-read-test-"
            ) as raw_root:
                root = Path(raw_root)
                target = root / "token-reader.py"
                token = root / "token"
                target.write_text(source, encoding="utf-8")
                token.write_text("synthetic-token\n", encoding="utf-8")
                target.chmod(0o600)
                token.chmod(0o600)
                completed, events = execute_trace_wrapper(
                    target,
                    [],
                    environment={
                        "PATH": "/usr/local/bin:/usr/bin:/bin",
                        "LANG": "C.UTF-8",
                        "NOTION_TOKEN_FILE": str(token),
                    },
                )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(any(
                event.get("type") in {
                    "token-alternate-read", "token-unsafe-high-level-open"
                }
                for event in events
            ))
            with self.assertRaises(PROBE.ProbeFailure):
                PROBE.ContractProbe.validate_token_trace(events)

    def test_token_symlink_follower_is_detected_before_api_acceptance(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
import sys
import urllib.request
from pathlib import Path

if "--pull" in sys.argv:
    token = Path(os.environ["NOTION_TOKEN_FILE"]).read_text(encoding="utf-8").strip()
    url = os.environ["NOTION_API_BASE"].rstrip("/") + "/pages/" + os.environ["NOTION_PAGE_ID"] + "/markdown"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Notion-Version": "2026-03-11",
    }, method="GET")
    with urllib.request.urlopen(request, timeout=3):
        pass
    print(json.dumps({"status": "error"}))
    raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with self.assertRaises(PROBE.ProbeFailure):
                probe.assert_symlink_token_rejected()

    def test_symlink_target_open_trace_covers_resolved_low_and_high_level_paths(
        self,
    ) -> None:
        source = r'''#!/usr/bin/env python3
import io
import os
import sys

resolved = os.path.realpath(os.environ["NOTION_INBOX_FILE"])
mechanism = sys.argv[1]
if mechanism == "os.open":
    descriptor = os.open(resolved, os.O_RDONLY | os.O_CLOEXEC)
    os.read(descriptor, 4096)
    os.close(descriptor)
elif mechanism == "builtins.open":
    with open(resolved, "rb") as handle:
        handle.read()
elif mechanism == "io.open":
    with io.open(resolved, "rb") as handle:
        handle.read()
elif mechanism == "os.fdopen":
    descriptor = os.open(resolved, os.O_RDONLY | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as handle:
        handle.read()
'''
        for mechanism in (
            "os.open",
            "builtins.open",
            "io.open",
            "os.fdopen",
        ):
            with self.subTest(mechanism=mechanism), tempfile.TemporaryDirectory(
                prefix="dsh-symlink-subject-trace-test-"
            ) as raw_root:
                root = Path(raw_root)
                target = root / "reader.py"
                task = root / "task-inbox"
                canary = root / "canary"
                inbox = task / "inbox.md"
                target.write_text(source, encoding="utf-8")
                task.mkdir()
                canary.write_bytes(os.urandom(32))
                inbox.symlink_to(canary)
                target.chmod(0o600)
                canary.chmod(0o600)
                completed, events = execute_trace_wrapper(
                    target,
                    [mechanism],
                    environment={
                        "PATH": "/usr/local/bin:/usr/bin:/bin",
                        "LANG": "C.UTF-8",
                        "NOTION_TOKEN_FILE": str(root / "unused-token"),
                        "NOTION_INBOX_FILE": str(inbox),
                    },
                )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            subject_events = [
                event
                for event in events
                if event.get("type") == "symlink-target-open"
            ]
            self.assertTrue(subject_events)
            self.assertIn(
                mechanism,
                {event.get("mechanism") for event in subject_events},
            )
            self.assertTrue(
                all(event.get("subjects") == ["mirror"] for event in subject_events)
            )

    def test_symlink_preflight_contract_positive_and_fixed_stage_wiring(self) -> None:
        source = r'''#!/usr/bin/env python3
import os
import stat

inbox = os.environ["NOTION_INBOX_FILE"]
artifact_directory = os.path.dirname(inbox)
paths = (
    os.environ["NOTION_TOKEN_FILE"],
    inbox,
    os.path.join(artifact_directory, "sync-state.json"),
    os.path.join(artifact_directory, "notion-fingerprint.json"),
)
for path in paths:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(2)
raise SystemExit(1)
'''
        observed: list[str] = []

        def record_stage(stage: str, operation: object) -> object:
            observed.append(stage)
            return operation()

        with malicious_fixture(source) as entrypoint, mock.patch.object(
            PROBE, "probe_stage", side_effect=record_stage
        ):
            probe = PROBE.ContractProbe(entrypoint)
            probe.assert_symlink_token_rejected()
            for role in ("mirror", "state", "fingerprint"):
                probe.assert_symlink_artifact_rejected(role)

        expected = [
            PROBE.SYMLINK_PREFLIGHT_STAGES[role][bucket]
            for role in ("token", "mirror", "state", "fingerprint")
            for bucket in ("command", "outcome", "preservation", "residue")
        ]
        self.assertEqual(expected, observed)
        self.assertEqual(16, len(set(expected)))
        self.assertTrue(set(expected) <= set(PROBE.ATOMIC_PROBE_STAGES))
        self.assertTrue(set(expected) <= set(PROBE.PROBE_FAILURE_STAGES))

    def test_symlink_preflight_allows_nonsecret_authorization_and_pages_words(
        self,
    ) -> None:
        source = r'''#!/usr/bin/env python3
import os
import stat

inbox = os.environ["NOTION_INBOX_FILE"]
artifact_directory = os.path.dirname(inbox)
paths = (
    os.environ["NOTION_TOKEN_FILE"],
    inbox,
    os.path.join(artifact_directory, "sync-state.json"),
    os.path.join(artifact_directory, "notion-fingerprint.json"),
)
for path in paths:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(metadata.st_mode):
        print("authorization unavailable; /pages/ route unavailable")
        raise SystemExit(2)
raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            probe.assert_symlink_token_rejected()
            for role in ("mirror", "state", "fingerprint"):
                probe.assert_symlink_artifact_rejected(role)

    def test_token_symlink_resolved_read_then_fixed_failure_is_outcome_failure(
        self,
    ) -> None:
        source = r'''#!/usr/bin/env python3
import os

resolved = os.path.realpath(os.environ["NOTION_TOKEN_FILE"])
descriptor = os.open(resolved, os.O_RDONLY | os.O_CLOEXEC)
os.read(descriptor, 4096)
os.close(descriptor)
raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                probe.assert_symlink_token_rejected()
        self.assertEqual(
            PROBE.SYMLINK_PREFLIGHT_STAGES["token"]["outcome"],
            raised.exception.stage,
        )

    def test_artifact_symlink_output_is_command_failure(self) -> None:
        source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

value = Path(os.environ["NOTION_INBOX_FILE"]).read_bytes()
os.write(1, value)
raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                probe.assert_symlink_artifact_rejected("mirror")
        self.assertEqual(
            PROBE.SYMLINK_PREFLIGHT_STAGES["mirror"]["command"],
            raised.exception.stage,
        )

    def test_artifact_equal_byte_replacement_is_preservation_failure(self) -> None:
        source = r'''#!/usr/bin/env python3
import os
from pathlib import Path

target = Path(os.environ["NOTION_INBOX_FILE"])
value = target.read_bytes()
temporary = target.parent / "replacement.tmp"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
offset = 0
while offset < len(value):
    offset += os.write(descriptor, value[offset:])
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, target)
raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with mock.patch.object(
                probe, "validate_symlink_preflight_trace", return_value=None
            ), self.assertRaises(PROBE.ProbeStageFailure) as raised:
                probe.assert_symlink_artifact_rejected("mirror")
        self.assertEqual(
            PROBE.SYMLINK_PREFLIGHT_STAGES["mirror"]["preservation"],
            raised.exception.stage,
        )

    def test_symlink_preflight_untracked_empty_directory_is_residue_failure(
        self,
    ) -> None:
        source = r'''#!/usr/bin/env python3
import os
import stat

metadata = os.lstat(os.environ["NOTION_TOKEN_FILE"])
if stat.S_ISLNK(metadata.st_mode):
    os.mkdir(os.path.join(os.environ["HOME"], "untracked-residue"), 0o700)
    raise SystemExit(2)
raise SystemExit(1)
'''
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                probe.assert_symlink_token_rejected()
        self.assertEqual(
            PROBE.SYMLINK_PREFLIGHT_STAGES["token"]["residue"],
            raised.exception.stage,
        )

    def test_artifact_secret_markers_are_rejected(self) -> None:
        for value in (
            PROBE.FAKE_TOKEN.encode(),
            b'{"Authorization":"synthetic"}',
            b'{"header":"Bearer synthetic"}',
        ):
            with self.subTest(value=value), self.assertRaises(PROBE.ProbeFailure):
                PROBE.assert_artifact_redacted(value)

    def test_crash_leftover_secret_marker_is_rejected(self) -> None:
        with malicious_fixture("#!/usr/bin/env python3\n") as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox:
                sandbox.task_directory.mkdir(parents=True, mode=0o700)
                leftover = sandbox.task_directory / ".crash-leftover"
                leftover.write_bytes(PROBE.FAKE_TOKEN.encode("utf-8"))
                leftover.chmod(0o600)
                with self.assertRaises(PROBE.ProbeFailure):
                    sandbox.assert_task_tree_redacted()

    def test_fake_notion_responses_have_exact_top_level_markdown_shape(self) -> None:
        with PROBE.LoopbackNotion("synthetic response") as notion:
            request = urllib.request.Request(
                f"{notion.api_base}/pages/{PROBE.PAGE_ID}/markdown",
                headers={
                    "Authorization": f"Bearer {PROBE.FAKE_TOKEN}",
                    "Notion-Version": PROBE.NOTION_VERSION,
                },
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                get_value = json.load(response)
            patch_body = {
                "type": "replace_content",
                "replace_content": {"new_str": "synthetic replacement"},
            }
            patch = urllib.request.Request(
                f"{notion.api_base}/pages/{PROBE.PAGE_ID}/markdown",
                data=json.dumps(patch_body).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {PROBE.FAKE_TOKEN}",
                    "Notion-Version": PROBE.NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                method="PATCH",
            )
            with urllib.request.urlopen(patch, timeout=5) as response:
                patch_value = json.load(response)
        expected_common = {
            "object": "page_markdown",
            "id": PROBE.PAGE_ID,
            "truncated": False,
            "unknown_block_ids": [],
        }
        self.assertEqual(get_value, {**expected_common, "markdown": "synthetic response"})
        self.assertEqual(patch_value, {**expected_common, "markdown": "synthetic replacement"})

    def test_fake_notion_incomplete_response_injection_does_not_mutate_patch_body(self) -> None:
        invalid_responses = PROBE.incomplete_page_responses("synthetic attempted replacement")
        self.assertEqual(len(invalid_responses), 4)
        for invalid in invalid_responses:
            with self.subTest(invalid=invalid), PROBE.LoopbackNotion("synthetic original") as notion:
                notion.state.get_response_override = invalid
                get_request = urllib.request.Request(
                    f"{notion.api_base}/pages/{PROBE.PAGE_ID}/markdown",
                    headers={
                        "Authorization": f"Bearer {PROBE.FAKE_TOKEN}",
                        "Notion-Version": PROBE.NOTION_VERSION,
                    },
                    method="GET",
                )
                with urllib.request.urlopen(get_request, timeout=5) as response:
                    self.assertEqual(json.load(response), invalid)
                notion.state.get_response_override = None
                notion.state.patch_response_override = invalid
                patch_body = {
                    "type": "replace_content",
                    "replace_content": {"new_str": "synthetic attempted replacement"},
                }
                request = urllib.request.Request(
                    f"{notion.api_base}/pages/{PROBE.PAGE_ID}/markdown",
                    data=json.dumps(patch_body).encode("utf-8"),
                    headers={
                        "Authorization": f"Bearer {PROBE.FAKE_TOKEN}",
                        "Notion-Version": PROBE.NOTION_VERSION,
                        "Content-Type": "application/json",
                    },
                    method="PATCH",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response), invalid)
                self.assertEqual(notion.state.body, "synthetic original")

    def test_probe_path_matches_installed_release_system_layout(self) -> None:
        installed_test = Path(
            "/opt/dsh/release-system/tests/harness-notion-automation-probe.py"
        )
        self.assertEqual(
            probe_path_for(installed_test),
            Path(
                "/opt/dsh/release-system/scripts/verify-harness-notion-automation.py"
            ),
        )
        self.assertEqual(PROBE_PATH.parent, RELEASE_ROOT / "scripts")

    def test_probe_does_not_inject_dsh_home_or_unrelated_business_config(self) -> None:
        source = "#!/usr/bin/env python3\n"
        with malicious_fixture(source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            with probe.sandbox() as sandbox:
                environment = sandbox.env("http://127.0.0.1:1/v1")
        notion_names = {name for name in environment if name.startswith("NOTION_")}
        self.assertEqual(
            notion_names,
            {
                "NOTION_TOKEN_FILE",
                "NOTION_INBOX_FILE",
                "NOTION_API_BASE",
                "NOTION_PAGE_ID",
            },
        )
        self.assertNotIn("DSH_HOME", environment)
        self.assertNotIn("NOTION_API_KEY", environment)
        self.assertNotIn("NOTION_ENV_FILE", environment)

    def test_trusted_loader_source_bytes_do_not_require_readable_dunder_file(self) -> None:
        original_source = PROBE.DSH_TRUSTED_PROBE_SOURCE_BYTES
        original_file = PROBE.__file__
        provided = b"synthetic trusted probe source bytes"
        try:
            PROBE.DSH_TRUSTED_PROBE_SOURCE_BYTES = provided
            PROBE.__file__ = "/unavailable/trusted-probe.py"
            self.assertEqual(PROBE.trusted_probe_source(), provided)
        finally:
            PROBE.DSH_TRUSTED_PROBE_SOURCE_BYTES = original_source
            PROBE.__file__ = original_file

    def test_trusted_runpy_wrapper_records_fsync_rename_and_crash(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
temporary = root / "value.tmp"
final = root / "value.bin"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.write(descriptor, b"complete synthetic value")
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, final)
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(directory)
os.close(directory)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-trace-wrapper-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)

            def execute(fail_index: int) -> tuple[subprocess.CompletedProcess[bytes], list[dict[str, object]]]:
                return execute_trace_wrapper(target, [str(root)], fail_index=fail_index)

            normal, events = execute(0)
            self.assertEqual(normal.returncode, 0, normal.stderr)
            self.assertEqual((root / "value.bin").read_bytes(), b"complete synthetic value")
            self.assertTrue(
                any(
                    event.get("type") == "create"
                    and event.get("mechanism") == "os.open"
                    and event.get("mode") == 0o600
                    and event.get("createOnly") is True
                    for event in events
                )
            )
            self.assertTrue(any(event.get("type") == "rename" for event in events))
            self.assertTrue(any(event.get("type") == "fsync" and event.get("kind") == "file" for event in events))
            self.assertTrue(any(event.get("type") == "fsync" and event.get("kind") == "dir" for event in events))

            (root / "value.bin").unlink()
            crashed_before, before_events = execute(1)
            self.assertEqual(crashed_before.returncode, 86, crashed_before.stderr)
            self.assertFalse((root / "value.bin").exists())
            self.assertEqual((root / "value.tmp").read_bytes(), b"complete synthetic value")
            boundaries = [
                event for event in before_events if event.get("type") == "rename-boundary"
            ]
            self.assertEqual(len(boundaries), 1)
            self.assertIs(boundaries[0].get("crash"), True)

            (root / "value.tmp").unlink()
            crashed, crash_events = execute(2)
            self.assertEqual(crashed.returncode, 86, crashed.stderr)
            self.assertEqual((root / "value.bin").read_bytes(), b"complete synthetic value")
            renames = [event for event in crash_events if event.get("type") == "rename"]
            self.assertEqual(len(renames), 1)
            self.assertIs(renames[0].get("crash"), True)

    def test_rename_failpoint_bound_tracks_two_boundaries_per_rename(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

root = Path(os.environ["NOTION_INBOX_FILE"]).parent
root.mkdir(parents=True, exist_ok=True)
for index in range(int(sys.argv[1])):
    temporary = root / f"synthetic-{index}.tmp"
    final = root / f"synthetic-{index}.bin"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    os.write(descriptor, f"synthetic-{index}".encode("ascii"))
    os.fsync(descriptor)
    os.close(descriptor)
    os.replace(temporary, final)
'''
        self.assertEqual(
            PROBE.MAX_RENAME_FAILPOINTS,
            PROBE.MAX_RENAMES * PROBE.RENAME_FAILPOINTS_PER_RENAME,
        )
        with malicious_fixture(target_source) as entrypoint:
            probe = PROBE.ContractProbe(entrypoint)
            for rename_count, fail_index in ((17, 33), (17, 34), (32, 63), (32, 64)):
                with self.subTest(
                    rename_count=rename_count, fail_index=fail_index
                ), probe.sandbox() as sandbox:
                    result, events = probe.traced_command(
                        sandbox,
                        "http://127.0.0.1:1/v1",
                        [str(rename_count)],
                        fail_index=fail_index,
                    )
                    probe.validate_injected_crash(result, events, fail_index)
                    self.assertEqual(
                        fail_index // PROBE.RENAME_FAILPOINTS_PER_RENAME,
                        sum(event.get("type") == "rename" for event in events),
                    )

            with probe.sandbox() as sandbox, self.assertRaises(PROBE.ProbeFailure):
                probe.traced_command(
                    sandbox,
                    "http://127.0.0.1:1/v1",
                    [str(PROBE.MAX_RENAMES)],
                    fail_index=PROBE.MAX_RENAME_FAILPOINTS + 1,
                )

    def test_total_rename_limit_counts_staged_and_canonical_calls(self) -> None:
        publisher = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

task = Path(sys.argv[1])
count = int(sys.argv[2])
source = task / "rename-chain-0.tmp"
descriptor = os.open(
    source,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
value = b'{"generation":"replacement"}\n'
os.write(descriptor, value)
os.fsync(descriptor)
os.close(descriptor)
for index in range(1, count):
    destination = task / f"rename-chain-{index}.tmp"
    os.replace(source, destination)
    source = destination
os.replace(source, task / "sync-state.json")
directory = os.open(task, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
os.fsync(directory)
os.close(directory)
'''
        for total, accepted in ((PROBE.MAX_RENAMES, True), (PROBE.MAX_RENAMES + 1, False)):
            with self.subTest(total=total), tempfile.TemporaryDirectory(
                prefix="dsh-total-rename-limit-"
            ) as raw_root:
                root = Path(raw_root)
                task = root / "task-inbox"
                task.mkdir()
                paths = {
                    "mirror": task / "inbox.md",
                    "state": task / "sync-state.json",
                    "fingerprint": task / "notion-fingerprint.json",
                }
                initial = {
                    "mirror": b"synthetic mirror\n",
                    "state": b'{"generation":"initial"}\n',
                    "fingerprint": b"{}\n",
                }
                for role, path in paths.items():
                    path.write_bytes(initial[role])
                    path.chmod(0o600)
                before_values = {
                    role: path.read_bytes() for role, path in paths.items()
                }
                before_inodes = {
                    role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                    for role, path in paths.items()
                }
                target = root / "publisher.py"
                target.write_text(publisher, encoding="utf-8")
                target.chmod(0o600)
                completed, events = execute_trace_wrapper(
                    target,
                    [str(task), str(total)],
                    environment={
                        "PATH": "/usr/local/bin:/usr/bin:/bin",
                        "LANG": "C.UTF-8",
                        "NOTION_TOKEN_FILE": str(root / "unused-token"),
                        "NOTION_INBOX_FILE": str(paths["mirror"]),
                    },
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(
                    total,
                    sum(event.get("type") == "rename" for event in events),
                )
                after_values = {
                    role: path.read_bytes() for role, path in paths.items()
                }
                after_inodes = {
                    role: (os.lstat(path).st_dev, os.lstat(path).st_ino)
                    for role, path in paths.items()
                }

                class SandboxView:
                    task_directory = task
                    inbox = paths["mirror"]
                    state = paths["state"]
                    fingerprint = paths["fingerprint"]

                probe = object.__new__(PROBE.ContractProbe)
                if accepted:
                    self.assertEqual(
                        PROBE.MAX_RENAME_FAILPOINTS,
                        probe.validate_success_trace(
                            SandboxView(), events, before_values, before_inodes,
                            after_values, after_inodes, {"state"},
                        ),
                    )
                else:
                    with self.assertRaises(PROBE.ProbeFailure):
                        probe.validate_success_trace(
                            SandboxView(), events, before_values, before_inodes,
                            after_values, after_inodes, {"state"},
                        )

    def test_trusted_runpy_wrapper_accepts_x_mode_create_only(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
previous = os.umask(0o077)
try:
    with open(root / "value.tmp", "xb") as stream:
        stream.write(b"synthetic x-mode value")
        stream.flush()
        os.fsync(stream.fileno())
finally:
    os.umask(previous)
os.replace(root / "value.tmp", root / "value.bin")
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(directory)
os.close(directory)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-trace-x-mode-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [str(root)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": "/unavailable/synthetic-token",
                    "NOTION_INBOX_FILE": str(root / "value.bin"),
                },
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(
            any(
                event.get("type") == "create"
                and event.get("mechanism") == "open-x"
                and event.get("mode") == 0o600
                and event.get("createOnly") is True
                for event in events
            )
        )

    def test_post_rename_direct_same_bytes_rewrite_is_rejected(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import io
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
value = b"complete synthetic unchanged bytes"
temporary = root / "value.tmp"
final = root / "value.bin"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.write(descriptor, value)
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, final)
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(directory)
os.close(directory)

with open(final, "wb") as stream:
    stream.write(value)
    stream.flush()
    os.fsync(stream.fileno())
descriptor = os.open(final, os.O_WRONLY)
os.write(descriptor, value)
os.pwrite(descriptor, value, 0)
os.lseek(descriptor, 0, os.SEEK_SET)
os.writev(descriptor, [value])
os.ftruncate(descriptor, len(value))
os.fsync(descriptor)
os.close(descriptor)
with io.open(final, "ab") as stream:
    stream.write(b"")
    stream.flush()
    os.fsync(stream.fileno())
with open(final, "r+b") as stream:
    stream.seek(0)
    stream.write(value)
    stream.flush()
    os.fsync(stream.fileno())
'''
        with tempfile.TemporaryDirectory(prefix="dsh-post-rename-rewrite-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            previous = b"synthetic exact previous canonical bytes"
            (root / "value.bin").write_bytes(previous)
            (root / "value.bin").chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [str(root)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": "/unavailable/synthetic-token",
                    "NOTION_INBOX_FILE": str(root / "value.bin"),
                },
            )
            self.assertEqual(
                (root / "value.bin").read_bytes(),
                b"complete synthetic unchanged bytes",
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        renames = [event for event in events if event.get("type") == "rename"]
        self.assertEqual(len(renames), 1)
        self.assertEqual(
            renames[0].get("destinationBefore", {}).get("sha256"),
            PROBE.sha256_bytes(previous),
        )
        self.assertEqual(
            renames[0].get("destinationBefore", {}).get("kind"),
            "file",
        )
        unsafe = [event for event in events if event.get("type") == "unsafe-write-open"]
        self.assertEqual(len(unsafe), 4)
        self.assertEqual(
            {event.get("mechanism") for event in unsafe},
            {"open", "os.open"},
        )
        self.assertEqual(
            {event.get("openMode") for event in unsafe if "openMode" in event},
            {"wb", "ab", "r+b"},
        )
        post_publish_operations = {
            event.get("operation")
            for event in events
            if event.get("type") == "post-publish-write"
        }
        self.assertTrue(
            {"os.write", "os.pwrite", "os.writev", "os.ftruncate"}
            <= post_publish_operations
        )
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.reject_unsafe_write_events(events)

    def test_retained_writable_fd_cannot_publish_then_rewrite_an_artifact(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
expected = b"complete synthetic retained-fd value"
temporary = root / "value.tmp"
final = root / "inbox.md"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.write(descriptor, expected)
os.fsync(descriptor)
os.replace(temporary, final)

# These mutations deliberately retain the pre-publication descriptor.  A
# trusted publication gate must stop above, even though the last write would
# restore the expected bytes and make a final-state-only check look clean.
os.lseek(descriptor, 0, os.SEEK_SET)
os.write(descriptor, b"corrupt synthetic retained-fd value")
os.ftruncate(descriptor, 36)
os.fsync(descriptor)
os.lseek(descriptor, 0, os.SEEK_SET)
os.write(descriptor, expected)
os.ftruncate(descriptor, len(expected))
os.fsync(descriptor)
os.close(descriptor)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-retained-fd-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            final = root / "inbox.md"
            completed, events = execute_trace_wrapper(
                target,
                [str(root)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": "/unavailable/synthetic-token",
                    "NOTION_INBOX_FILE": str(final),
                },
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse(final.exists())
            self.assertEqual(
                (root / "value.tmp").read_bytes(),
                b"complete synthetic retained-fd value",
            )
        blocked = [
            event for event in events if event.get("type") == "publish-with-open-writer"
        ]
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0].get("writerCount"), 1)
        self.assertFalse(any(event.get("type") == "rename" for event in events))
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.reject_unsafe_write_events(events)

    def test_unlink_then_replace_is_rejected_before_canonical_disappears(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
temporary = root / "value.tmp"
final = root / "inbox.md"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.write(descriptor, b"synthetic replacement")
os.fsync(descriptor)
os.close(descriptor)
os.unlink(final)
os.replace(temporary, final)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-unlink-replace-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            final = root / "inbox.md"
            final.write_bytes(b"synthetic existing canonical")
            final.chmod(0o600)
            completed, events = execute_trace_wrapper(
                target,
                [str(root)],
                environment={
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "NOTION_TOKEN_FILE": "/unavailable/synthetic-token",
                    "NOTION_INBOX_FILE": str(final),
                },
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(final.read_bytes(), b"synthetic existing canonical")
            self.assertEqual((root / "value.tmp").read_bytes(), b"synthetic replacement")
        removals = [event for event in events if event.get("type") == "path-remove"]
        self.assertEqual(len(removals), 1)
        self.assertEqual(removals[0].get("operation"), "os.unlink")
        self.assertIs(removals[0].get("blocked"), True)
        self.assertFalse(any(event.get("type") == "rename" for event in events))
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.reject_unsafe_write_events(events)

    def test_protected_module_secondary_alias_cannot_filter_trace_events(self) -> None:
        target_source = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

original_write = os.write
module_alias = os

def filtered_write(descriptor, value):
    if b'"type":"unsafe-write-open"' in value:
        return len(value)
    return original_write(descriptor, value)

module_alias.write = filtered_write
root = Path(sys.argv[1])
value = b"synthetic alias bypass bytes"
temporary = root / "value.tmp"
final = root / "value.bin"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
    0o600,
)
os.write(descriptor, value)
os.fsync(descriptor)
os.close(descriptor)
os.replace(temporary, final)
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(directory)
os.close(directory)
with open(final, "wb") as stream:
    stream.write(value)
    stream.flush()
    os.fsync(stream.fileno())
'''
        with tempfile.TemporaryDirectory(prefix="dsh-alias-trace-bypass-test-") as raw_root:
            root = Path(raw_root)
            target = root / "target.py"
            target.write_text(target_source, encoding="utf-8")
            target.chmod(0o600)
            completed, events = execute_trace_wrapper(target, [str(root)])
            self.assertEqual(
                (root / "value.bin").read_bytes(),
                b"synthetic alias bypass bytes",
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(any(event.get("type") == "unsafe-write-open" for event in events))
        with self.assertRaises(PROBE.ProbeFailure):
            PROBE.reject_unsafe_write_events(events)

        with malicious_fixture(target_source) as entrypoint:
            with self.assertRaises(PROBE.ProbeFailure):
                PROBE.ContractProbe(entrypoint)

    def test_symlink_entrypoint_is_rejected_before_execution(self) -> None:
        with malicious_fixture("#!/usr/bin/env python3\n") as entrypoint:
            symlink = entrypoint.parent / "linked.py"
            symlink.symlink_to(entrypoint.name)
            with self.assertRaises(PROBE.ProbeFailure):
                PROBE.ContractProbe(symlink)

    def test_all_true_self_report_cannot_satisfy_first_pull(self) -> None:
        tests = {name: True for name in PROBE.TEST_NAMES}
        source = f"""#!/usr/bin/env python3
import json
print(json.dumps({{"status": "synced", "tests": {tests!r}}}))
"""
        self.assert_rejected(source, "firstPull")

    def test_pull_that_creates_pending_artifacts_is_rejected(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

inbox = Path(os.environ["NOTION_INBOX_FILE"])
inbox.parent.mkdir(parents=True, exist_ok=True)
inbox.write_text("synthetic unsourced body", encoding="utf-8")
state = inbox.parent / "sync-state.json"
state.write_text(json.dumps({"pending": {"operation": "pull"}}), encoding="utf-8")
fingerprint = inbox.parent / "notion-fingerprint.json"
fingerprint.write_text("{}", encoding="utf-8")
for path in (inbox, state, fingerprint):
    path.chmod(0o600)
print(json.dumps({"status": "error"}))
raise SystemExit(1)
'''
        self.assert_rejected(source, "pullFailureNoPending")

    def test_no_pending_retry_that_reads_token_and_calls_api_is_rejected(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
import sys
import urllib.request
from pathlib import Path

def token():
    return Path(os.environ["NOTION_TOKEN_FILE"]).read_text(encoding="utf-8").strip()

def get_remote():
    url = os.environ["NOTION_API_BASE"].rstrip("/") + "/pages/" + os.environ["NOTION_PAGE_ID"] + "/markdown"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token(),
        "Notion-Version": "2026-03-11",
    }, method="GET")
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)["markdown"]

def write_artifacts(body):
    inbox = Path(os.environ["NOTION_INBOX_FILE"])
    inbox.parent.mkdir(parents=True, exist_ok=True)
    values = {
        inbox: body,
        inbox.parent / "sync-state.json": "{}",
        inbox.parent / "notion-fingerprint.json": "{}",
    }
    for path, value in values.items():
        path.write_text(value, encoding="utf-8")
        path.chmod(0o600)

if "--pull" in sys.argv:
    write_artifacts(get_remote())
    print(json.dumps({"status": "synced"}))
elif "--retry-pending" in sys.argv:
    get_remote()
    print(json.dumps({"status": "synced"}))
'''
        self.assert_rejected(source, "noPendingNoApi")

    def test_redirect_following_client_is_rejected(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

def pull():
    token = Path(os.environ["NOTION_TOKEN_FILE"]).read_text(encoding="utf-8").strip()
    url = os.environ["NOTION_API_BASE"].rstrip("/") + "/pages/" + os.environ["NOTION_PAGE_ID"] + "/markdown"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Notion-Version": "2026-03-11",
    }, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            body = json.load(response)["markdown"]
    except Exception:
        print(json.dumps({"status": "stale"}))
        raise SystemExit(1)
    inbox = Path(os.environ["NOTION_INBOX_FILE"])
    inbox.parent.mkdir(parents=True, exist_ok=True)
    artifacts = {
        inbox: body,
        inbox.parent / "sync-state.json": "{}",
        inbox.parent / "notion-fingerprint.json": "{}",
    }
    for path, value in artifacts.items():
        path.write_text(value, encoding="utf-8")
        path.chmod(0o600)
    print(json.dumps({"status": "synced"}))

if "--pull" in sys.argv:
    pull()
'''
        self.assert_rejected(source, "secretRedaction")

    def test_secret_written_to_stdout_is_rejected(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path

token = Path(os.environ["NOTION_TOKEN_FILE"]).read_text(encoding="utf-8").strip()
print(json.dumps({"status": "synced", "token": token}))
'''
        self.assert_rejected(source, "secretRedaction")

    def test_half_written_artifact_set_is_rejected(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path

inbox = Path(os.environ["NOTION_INBOX_FILE"])
inbox.write_text("synthetic half write", encoding="utf-8")
inbox.chmod(0o600)
state = inbox.parent / "sync-state.json"
state.write_text("{}", encoding="utf-8")
state.chmod(0o600)
print(json.dumps({"status": "error"}))
raise SystemExit(1)
'''
        self.assert_rejected(source, "atomicArtifacts")

    def test_probe_stage_mapping_is_fixed_and_retains_root_diagnostics(self) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"

        class SyntheticProbe:
            entrypoint_sha256 = "a" * 64

            def __init__(self, failed_name: str | None = None) -> None:
                self.failed_name = failed_name

            def run_named(self, name: str) -> None:
                if name == self.failed_name:
                    raise RuntimeError(canary)

        with mock.patch.object(
            PROBE, "ContractProbe", side_effect=RuntimeError(canary)
        ):
            with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                PROBE.verify_entrypoint(Path("/synthetic/notion_inbox_sync.py"))
        self.assertEqual("source-policy", raised.exception.stage)
        self.assertIsNone(raised.exception.__context__)
        self.assertIn(canary, raised.exception.diagnostic)

        for name in PROBE.TEST_NAMES:
            with self.subTest(test_name=name):
                synthetic = SyntheticProbe(name)
                with mock.patch.object(
                    PROBE, "ContractProbe", return_value=synthetic
                ), mock.patch.object(
                    PROBE, "trusted_probe_source", return_value=b"synthetic probe"
                ):
                    with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                        PROBE.verify_entrypoint(
                            Path("/synthetic/notion_inbox_sync.py")
                        )
                self.assertEqual(
                    PROBE.PROBE_TEST_STAGES[name], raised.exception.stage
                )
                self.assertIsNone(raised.exception.__context__)
                self.assertIn(canary, raised.exception.diagnostic)

        synthetic = SyntheticProbe()
        with mock.patch.object(
            PROBE, "ContractProbe", return_value=synthetic
        ), mock.patch.object(
            PROBE, "trusted_probe_source", side_effect=RuntimeError(canary)
        ):
            with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                PROBE.verify_entrypoint(Path("/synthetic/notion_inbox_sync.py"))
        self.assertEqual("receipt", raised.exception.stage)
        self.assertIsNone(raised.exception.__context__)
        self.assertIn(canary, raised.exception.diagnostic)

        def private_failure() -> None:
            raise RuntimeError(canary)

        for stage in PROBE.ATOMIC_PROBE_STAGES:
            with self.subTest(atomic_stage=stage):
                with self.assertRaises(PROBE.ProbeStageFailure) as raised:
                    PROBE.probe_stage(
                        PROBE.PROBE_TEST_STAGES["atomicArtifacts"],
                        lambda stage=stage: PROBE.probe_stage(
                            stage,
                            private_failure,
                        ),
                    )
                self.assertEqual(stage, raised.exception.stage)
                self.assertIsNone(raised.exception.__context__)
                self.assertIn(canary, raised.exception.diagnostic)

        with mock.patch.object(
            PROBE, "ContractProbe", return_value=SyntheticProbe()
        ), mock.patch.object(
            PROBE, "trusted_probe_source", return_value=b"synthetic probe"
        ):
            receipt = PROBE.verify_entrypoint(
                Path("/synthetic/notion_inbox_sync.py")
            )
        self.assertEqual(
            {name: True for name in PROBE.TEST_NAMES}, receipt["tests"]
        )

    def test_probe_main_emits_only_allowlisted_initialization_and_internal_stages(
        self,
    ) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(4, PROBE.main(["--invalid"]))
        self.assertTrue(stderr.getvalue().startswith(
            f"{PROBE.PROBE_FAILURE_PREFIX}initialization\n"
        ))
        self.assertIn("ProbeFailure", stderr.getvalue())

        for stage in PROBE.PROBE_FAILURE_STAGES:
            with self.subTest(stage=stage):
                stderr = io.StringIO()
                with mock.patch.object(
                    PROBE,
                    "verify_entrypoint",
                    side_effect=PROBE.ProbeStageFailure(stage),
                ), contextlib.redirect_stderr(stderr):
                    self.assertEqual(
                        4,
                        PROBE.main([
                            "--entrypoint", "/synthetic/notion_inbox_sync.py"
                        ]),
                    )
                self.assertEqual(
                    f"{PROBE.PROBE_FAILURE_PREFIX}{stage}\n", stderr.getvalue()
                )
                self.assertNotIn(canary, stderr.getvalue())

        stderr = io.StringIO()
        with mock.patch.object(
            PROBE, "verify_entrypoint", side_effect=RuntimeError(canary)
        ), contextlib.redirect_stderr(stderr):
            self.assertEqual(
                4,
                PROBE.main(["--entrypoint", "/synthetic/notion_inbox_sync.py"]),
            )
        self.assertTrue(stderr.getvalue().startswith(
            f"{PROBE.PROBE_FAILURE_PREFIX}internal\n"
        ))
        self.assertIn(canary, stderr.getvalue())

    def test_failed_probe_cli_emits_no_receipt_or_child_output(self) -> None:
        source = r'''#!/usr/bin/env python3
import json
print(json.dumps({"status": "synced", "private": "must not be forwarded"}))
'''
        with malicious_fixture(source) as entrypoint:
            completed = subprocess.run(
                [sys.executable, str(PROBE_PATH), "--entrypoint", str(entrypoint)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
                timeout=30,
                check=False,
            )
        self.assertEqual(completed.returncode, 4)
        self.assertEqual(completed.stdout, b"")
        self.assertTrue(completed.stderr.startswith(
            b"dsh-probe: test-atomic-artifacts-preflight-token-symlink-outcome\n"
        ))
        self.assertIn(b"ProbeFailure", completed.stderr)
        self.assertNotIn(b"must not be forwarded", completed.stderr)

    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX process groups")
    def test_capture_command_kills_forked_descendant_after_parent_exit(self) -> None:
        child_source = r'''#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

sentinel = Path(sys.argv[1])
child = os.fork()
if child == 0:
    os.close(1)
    os.close(2)
    time.sleep(0.5)
    sentinel.write_text("descendant survived", encoding="utf-8")
    os._exit(0)
os._exit(0)
'''
        with tempfile.TemporaryDirectory(prefix="dsh-process-group-test-") as raw_root:
            root = Path(raw_root)
            target = root / "forker.py"
            sentinel = root / "survived.txt"
            target.write_text(child_source, encoding="utf-8")
            target.chmod(0o600)
            result = PROBE.capture_command(
                [sys.executable, "-I", "-S", "-B", str(target), str(sentinel)],
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
                cwd=root,
                input_bytes=None,
            )
            self.assertEqual(result.returncode, 0)
            time.sleep(0.8)
            self.assertFalse(sentinel.exists())


if __name__ == "__main__":
    unittest.main()
