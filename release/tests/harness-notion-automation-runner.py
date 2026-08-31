#!/usr/bin/env python3
"""Focused, network-free contracts for the trusted Harness task runner."""

from __future__ import annotations

import importlib.util
import io
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
import uuid
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from unittest import mock


RELEASE_ROOT = Path(__file__).resolve().parents[1]
RUNNER = RELEASE_ROOT / "scripts/harness-notion-automation-remote.py"
SPEC = importlib.util.spec_from_file_location("harness_notion_runner", RUNNER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HarnessNotionRunnerContracts(unittest.TestCase):
    NONCE = "d" * 32
    IMAGE_ID = "sha256:" + "a" * 64

    def test_attached_container_pipes_only_explicit_trusted_input(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-attached",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )

        class FakeProcess:
            def __init__(self, output: bytes) -> None:
                self.output = output
                self.returncode = 0
                self.received: bytes | None = None

            def communicate(
                self, *, input: bytes | None, timeout: int
            ) -> tuple[bytes, bytes]:
                self.received = input
                return self.output, b""

        for trusted_input in (b"synthetic trusted probe", None):
            with self.subTest(trusted_input=trusted_input is not None):
                process = FakeProcess(b"synthetic receipt")
                with mock.patch.object(
                    MODULE.subprocess, "Popen", return_value=process
                ) as popen, mock.patch.object(MODULE, "stop_container") as cleanup:
                    output = MODULE.wait_attached_container(
                        container,
                        30,
                        1024,
                        input_bytes=trusted_input,
                    )

                self.assertEqual(b"synthetic receipt", output)
                self.assertEqual(trusted_input, process.received)
                args, kwargs = popen.call_args
                self.assertEqual(
                    MODULE.subprocess.PIPE
                    if trusted_input is not None
                    else MODULE.subprocess.DEVNULL,
                    kwargs["stdin"],
                )
                self.assertEqual(trusted_input is not None, "--interactive" in args[0])
                self.assertIs(MODULE.subprocess.PIPE, kwargs["stdout"])
                self.assertIs(MODULE.subprocess.DEVNULL, kwargs["stderr"])
                cleanup.assert_called_once_with(container, strict=True)

    def container_inspection(
        self, name: str, resource_id: str, *, nonce: str | None = None
    ) -> dict[str, object]:
        return {
            "Id": resource_id,
            "Name": f"/{name}",
            "Image": self.IMAGE_ID,
            "Config": {
                "Labels": {
                    MODULE.RESOURCE_OWNER_LABEL: MODULE.RESOURCE_OWNER_VALUE,
                    MODULE.RESOURCE_NONCE_LABEL: nonce or self.NONCE,
                }
            },
        }

    def network_inspection(
        self,
        name: str,
        resource_id: str,
        *,
        nonce: str | None = None,
        internal: bool = True,
    ) -> dict[str, object]:
        return {
            "Id": resource_id,
            "Name": name,
            "Driver": "bridge",
            "Internal": internal,
            "Labels": {
                MODULE.RESOURCE_OWNER_LABEL: MODULE.RESOURCE_OWNER_VALUE,
                MODULE.RESOURCE_NONCE_LABEL: nonce or self.NONCE,
            },
        }

    def install_fixture(self, root: Path) -> tuple[Path, Path, int, tuple[int, ...], int, tuple[int, ...]]:
        source = root / "source"
        destination = root / "destination"
        notion = source / "notion"
        notion.mkdir(parents=True)
        destination.mkdir()
        (notion / "sentinel").write_text("synthetic")
        source_fd, source_identity = MODULE.open_directory(
            source, owner=os.getuid(), group=os.getgid()
        )
        destination_fd, destination_identity = MODULE.open_directory(
            destination, owner=os.getuid(), group=os.getgid()
        )
        return source, destination, source_fd, source_identity, destination_fd, destination_identity

    def test_rename_noreplace_and_transactional_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.mkdir()
            destination.mkdir()
            notion = source / "notion"
            notion.mkdir()
            (notion / "sentinel").write_text("synthetic")
            source_fd, source_identity = MODULE.open_directory(
                source, owner=os.getuid(), group=os.getgid()
            )
            destination_fd, destination_identity = MODULE.open_directory(
                destination, owner=os.getuid(), group=os.getgid()
            )
            try:
                installed = MODULE.install_noreplace(
                    source_fd, source_identity, destination_fd, destination_identity,
                    destination_path=destination,
                )
                self.assertFalse((source / "notion").exists())
                self.assertEqual("synthetic", (destination / "notion/sentinel").read_text())
                MODULE.rollback_created_install(
                    source_fd,
                    source_identity,
                    destination_fd,
                    destination_identity,
                    installed,
                )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_rename_noreplace_refuses_existing_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            (source / "notion").mkdir(parents=True)
            (destination / "notion").mkdir(parents=True)
            source_fd, source_identity = MODULE.open_directory(
                source, owner=os.getuid(), group=os.getgid()
            )
            destination_fd, destination_identity = MODULE.open_directory(
                destination, owner=os.getuid(), group=os.getgid()
            )
            try:
                with self.assertRaises(MODULE.RunnerError):
                    MODULE.install_noreplace(
                        source_fd, source_identity, destination_fd, destination_identity,
                        destination_path=destination,
                    )
                self.assertTrue((source / "notion").is_dir())
                self.assertTrue((destination / "notion").is_dir())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_post_rename_fsync_failure_rolls_the_exact_directory_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(Path(temporary))
            try:
                with mock.patch.object(
                    MODULE.os, "fsync", side_effect=[OSError("synthetic fsync"), None, None]
                ):
                    with self.assertRaises(OSError):
                        MODULE.install_noreplace(
                            source_fd, source_identity, destination_fd, destination_identity,
                            destination_path=destination,
                        )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_post_rename_parent_identity_failure_rolls_the_exact_directory_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(Path(temporary))
            real_require = MODULE.require_directory_identity
            calls = 0

            def fail_first_post_move(descriptor: int, expected: tuple[int, ...]) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise MODULE.RunnerError("synthetic identity failure")
                real_require(descriptor, expected)

            try:
                with mock.patch.object(
                    MODULE, "require_directory_identity", side_effect=fail_first_post_move
                ):
                    with self.assertRaises(MODULE.RunnerError):
                        MODULE.install_noreplace(
                            source_fd, source_identity, destination_fd, destination_identity,
                            destination_path=destination,
                        )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_post_rename_stat_failure_rolls_the_exact_directory_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(Path(temporary))
            real_stat = MODULE.os.stat
            destination_stats = 0

            def fail_post_move_stat(path: str | os.PathLike[str], *args: object, **kwargs: object):
                nonlocal destination_stats
                if path == "notion" and kwargs.get("dir_fd") == destination_fd:
                    destination_stats += 1
                    if destination_stats == 3:
                        raise OSError("synthetic stat failure")
                return real_stat(path, *args, **kwargs)

            try:
                with mock.patch.object(MODULE.os, "stat", side_effect=fail_post_move_stat):
                    with self.assertRaises(MODULE.RunnerError):
                        MODULE.install_noreplace(
                            source_fd, source_identity, destination_fd, destination_identity,
                            destination_path=destination,
                        )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_post_rename_path_chain_failure_rolls_the_exact_directory_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(Path(temporary))
            real_require = MODULE.require_path_chain_identity
            calls = 0

            def fail_post_move(
                path: Path, descriptor: int, expected: tuple[int, ...]
            ) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise MODULE.RunnerError("synthetic path-chain failure")
                real_require(path, descriptor, expected)

            try:
                with mock.patch.object(
                    MODULE, "require_path_chain_identity", side_effect=fail_post_move
                ):
                    with self.assertRaises(MODULE.RunnerError):
                        MODULE.install_noreplace(
                            source_fd,
                            source_identity,
                            destination_fd,
                            destination_identity,
                            destination_path=destination,
                        )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_path_chain_symlink_is_rejected_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(root)
            alias = root / "destination-alias"
            alias.symlink_to(destination, target_is_directory=True)
            try:
                with self.assertRaises(MODULE.RunnerError):
                    MODULE.install_noreplace(
                        source_fd,
                        source_identity,
                        destination_fd,
                        destination_identity,
                        destination_path=alias,
                    )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
                self.assertTrue(alias.is_symlink())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_rollback_is_not_blocked_by_repeated_parent_identity_fault(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination, source_fd, source_identity, destination_fd, destination_identity = self.install_fixture(Path(temporary))
            try:
                installed = MODULE.install_noreplace(
                    source_fd,
                    source_identity,
                    destination_fd,
                    destination_identity,
                    destination_path=destination,
                )
                with mock.patch.object(
                    MODULE,
                    "require_directory_identity",
                    side_effect=MODULE.RunnerError("persistent parent fault"),
                ):
                    MODULE.rollback_created_install(
                        source_fd,
                        source_identity,
                        destination_fd,
                        destination_identity,
                        installed,
                    )
                self.assertEqual("synthetic", (source / "notion/sentinel").read_text())
                self.assertFalse((destination / "notion").exists())
            finally:
                os.close(source_fd)
                os.close(destination_fd)

    def test_prepare_publication_stage_leaves_exact_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            task_root = Path(temporary) / ("a" * 32)
            notion = task_root / "dsh-home/workspace/automations/notion"
            notion.mkdir(parents=True)
            (notion / "tests").mkdir()
            control = task_root / "control"
            control.mkdir()
            for name in ("bridge.mjs", "lockdown.patch.yml"):
                path = control / name
                path.write_text("synthetic")
                path.chmod(0o600)
            prepared = MODULE.prepare_publication_stage(
                task_root, notion, owner=os.getuid(), group=os.getgid()
            )
            self.assertEqual(task_root / "notion", prepared)
            self.assertEqual(["notion"], sorted(path.name for path in task_root.iterdir()))

    def test_fsync_tree_persists_files_and_their_directories_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            notion = Path(temporary) / "notion"
            (notion / "tests").mkdir(parents=True)
            for relative in MODULE.INSTALLED_FILES:
                path = notion / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic")
            synced: list[Path] = []
            real_fsync = os.fsync

            def record_fsync(descriptor: int) -> None:
                synced.append(Path(os.readlink(f"/proc/self/fd/{descriptor}")).resolve())
                real_fsync(descriptor)

            with mock.patch.object(MODULE.os, "fsync", side_effect=record_fsync):
                MODULE.fsync_tree(notion)

            expected = [(notion / relative).resolve() for relative in MODULE.INSTALLED_FILES]
            expected.extend([(notion / "tests").resolve(), notion.resolve()])
            self.assertEqual(expected, synced)
            source = RUNNER.read_text()
            self.assertLess(
                source.index("fsync_tree(notion)"),
                source.index("notion = prepare_publication_stage(task_root, notion)"),
            )

    def test_create_container_cleans_only_matching_ambiguous_create(self) -> None:
        name = "dsh-harness-notion-deadbeef-test"
        resource_id = "b" * 64
        with mock.patch.object(
            MODULE,
            "inspect_docker_resource",
            side_effect=[None, self.container_inspection(name, resource_id)],
        ), mock.patch.object(MODULE, "docker", return_value=b"malformed\n"), mock.patch.object(
            MODULE, "stop_container"
        ) as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.create_container(
                    name, ["create"], self.NONCE, self.IMAGE_ID
                )
        cleanup.assert_called_once_with(
            MODULE.ContainerRef(name, resource_id, self.NONCE, self.IMAGE_ID),
            strict=True,
        )

    def test_create_container_name_collision_is_preserved(self) -> None:
        name = "dsh-harness-notion-deadbeef-test"
        canary = self.container_inspection(name, "c" * 64, nonce="e" * 32)
        with mock.patch.object(
            MODULE, "inspect_docker_resource", return_value=canary
        ), mock.patch.object(MODULE, "docker") as docker_call, mock.patch.object(
            MODULE, "stop_container"
        ) as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.create_container(
                    name, ["create"], self.NONCE, self.IMAGE_ID
                )
        docker_call.assert_not_called()
        cleanup.assert_not_called()

    def test_create_container_ambiguous_collision_is_preserved(self) -> None:
        name = "dsh-harness-notion-deadbeef-test"
        canary = self.container_inspection(name, "c" * 64, nonce="e" * 32)
        with mock.patch.object(
            MODULE, "inspect_docker_resource", side_effect=[None, canary]
        ), mock.patch.object(
            MODULE, "docker", side_effect=MODULE.RunnerError("ambiguous create")
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.create_container(
                    name, ["create"], self.NONCE, self.IMAGE_ID
                )
        cleanup.assert_not_called()

    def test_create_network_name_collision_is_preserved(self) -> None:
        name = "dsh-harness-notion-deadbeef-internal"
        canary = self.network_inspection(name, "f" * 64, nonce="e" * 32)
        with mock.patch.object(
            MODULE, "inspect_docker_resource", return_value=canary
        ), mock.patch.object(MODULE, "docker") as docker_call, mock.patch.object(
            MODULE, "cleanup_network"
        ) as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.create_network(
                    name, self.NONCE, internal=True, role="harness-notion-task"
                )
        docker_call.assert_not_called()
        cleanup.assert_not_called()

    def test_create_network_cleans_only_matching_ambiguous_create(self) -> None:
        name = "dsh-harness-notion-deadbeef-internal"
        resource_id = "f" * 64
        with mock.patch.object(
            MODULE,
            "inspect_docker_resource",
            side_effect=[None, self.network_inspection(name, resource_id)],
        ), mock.patch.object(MODULE, "docker", return_value=b"malformed\n"), mock.patch.object(
            MODULE, "cleanup_network"
        ) as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.create_network(
                    name, self.NONCE, internal=True, role="harness-notion-task"
                )
        cleanup.assert_called_once_with(
            MODULE.NetworkRef(name, resource_id, self.NONCE, True), strict=True
        )

    def test_container_start_wait_and_cleanup_use_immutable_id(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        with mock.patch.object(
            MODULE, "docker", side_effect=[b"", b"0\n"]
        ) as docker_call, mock.patch.object(MODULE, "stop_container") as cleanup:
            MODULE.wait_detached_container(container, 30)
        self.assertEqual(
            [
                mock.call("start", container.resource_id, timeout=30, capture=False),
                mock.call("wait", container.resource_id, timeout=30),
            ],
            docker_call.call_args_list,
        )
        cleanup.assert_called_once_with(container, strict=True)

    def test_generated_test_wait_returns_bounded_unittest_diagnostic(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        output = b"AssertionError: expected conflict status\n"

        class AttachedProcess:
            def __init__(self) -> None:
                self.stdout = io.BytesIO(output)
                self.returncode = 1

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9

        process = AttachedProcess()
        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=process
        ) as popen, mock.patch.object(
            MODULE, "docker", return_value=b"exited 1 false\n"
        ) as docker_call, mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.FixedGateFailure) as raised:
                MODULE.wait_generated_test_container(
                    container, 30, "generated-test-01"
                )
        self.assertEqual("generated-test-01", raised.exception.category)
        self.assertEqual(output, raised.exception.diagnostic)
        self.assertIs(subprocess.PIPE, popen.call_args.kwargs["stdout"])
        self.assertIs(subprocess.STDOUT, popen.call_args.kwargs["stderr"])
        docker_call.assert_called_once_with(
            "container", "inspect", "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            container.resource_id,
            timeout=30,
        )
        cleanup.assert_called_once_with(container, strict=True)

        suffix = b"\ngenerated unittest diagnostic exceeded limit\n"
        bounded = MODULE.bounded_generated_test_diagnostic(
            b"x" * (MODULE.GENERATED_TEST_DIAGNOSTIC_LIMIT + 1),
            suffix,
        )
        self.assertEqual(MODULE.GENERATED_TEST_DIAGNOSTIC_LIMIT, len(bounded))
        self.assertTrue(bounded.endswith(suffix))

    def test_generated_test_reader_start_failure_still_cleans_container(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )

        class AttachedProcess:
            stdout = io.BytesIO(b"")
            returncode = 1

            def poll(self) -> int:
                return self.returncode

        class FailedReader:
            def start(self) -> None:
                raise RuntimeError("synthetic thread failure")

            def join(self, timeout: int) -> None:
                raise AssertionError("unstarted reader must not be joined")

        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=AttachedProcess()
        ), mock.patch.object(
            MODULE.threading, "Thread", return_value=FailedReader()
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.FixedGateFailure) as raised:
                MODULE.wait_generated_test_container(
                    container, 30, "generated-test-01"
                )
        self.assertEqual("generated-test-01", raised.exception.category)
        self.assertTrue(
            raised.exception.diagnostic.endswith(
                b"generated unittest runtime failed\n"
            )
        )
        cleanup.assert_called_once_with(container, strict=True)

    def test_generated_test_cleanup_failure_preserves_category_and_output(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        output = b"AssertionError: expected conflict status\n"

        class AttachedProcess:
            def __init__(self) -> None:
                self.stdout = io.BytesIO(output)
                self.returncode = 1

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=AttachedProcess()
        ), mock.patch.object(
            MODULE, "docker", return_value=b"exited 1 false\n"
        ), mock.patch.object(
            MODULE,
            "stop_container",
            side_effect=MODULE.RunnerError("synthetic cleanup failure"),
        ):
            with self.assertRaises(MODULE.FixedGateFailure) as raised:
                MODULE.wait_generated_test_container(
                    container, 30, "generated-test-01"
                )
        self.assertEqual("generated-test-01", raised.exception.category)
        self.assertTrue(raised.exception.diagnostic.startswith(output))
        self.assertTrue(
            raised.exception.diagnostic.endswith(
                b"generated unittest cleanup failed\n"
            )
        )

    def test_generated_test_inspect_failure_has_fixed_diagnostic(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        output = b"unittest process output\n"

        class AttachedProcess:
            def __init__(self) -> None:
                self.stdout = io.BytesIO(output)
                self.returncode = 1

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=AttachedProcess()
        ), mock.patch.object(
            MODULE,
            "docker",
            side_effect=MODULE.RunnerError("synthetic inspect failure"),
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.FixedGateFailure) as raised:
                MODULE.wait_generated_test_container(
                    container, 30, "generated-test-01"
                )
        self.assertEqual("generated-test-01", raised.exception.category)
        self.assertTrue(raised.exception.diagnostic.startswith(output))
        self.assertTrue(
            raised.exception.diagnostic.endswith(
                b"generated unittest state inspection failed\n"
            )
        )
        cleanup.assert_called_once_with(container, strict=True)

    def test_headless_wait_keeps_only_allowlisted_code(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-task",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        secret = b"SYNTHETIC_TOKEN_PROMPT_AND_SOURCE_CANARY"

        class AttachedProcess:
            def __init__(self) -> None:
                self.stderr = io.BytesIO(b"dsh: TIMEOUT: " + secret + b"\n")
                self.returncode = 1

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9

        process = AttachedProcess()
        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=process
        ) as popen, mock.patch.object(
            MODULE, "docker", return_value=b"exited 1 false\n"
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.HeadlessTaskFailure) as raised:
                MODULE.wait_headless_container(container, 30, "implementation")
        self.assertEqual("implementation", raised.exception.phase)
        self.assertEqual("timeout", raised.exception.terminal_class)
        self.assertNotIn(secret.decode(), repr(raised.exception.__dict__))
        self.assertIs(popen.call_args.kwargs["stdout"], subprocess.DEVNULL)
        cleanup.assert_called_once_with(container, strict=True)

    def test_headless_stderr_classifier_is_bounded_and_redacted(self) -> None:
        cases = (
            (b"", "noncompleted-no-code"),
            (b"dsh: UNKNOWN_CODE: synthetic private message\n", "unclassified"),
            (b"dsh: TIME\x00OUT: synthetic private message\n", "unclassified"),
            (b"dsh: " + b"A" * 65 + b": synthetic private message\n", "unclassified"),
            (
                b"dsh: TIMEOUT: " + b"x" * MODULE.HEADLESS_DIAGNOSTIC_LIMIT,
                "diagnostic-overflow",
            ),
        )
        for value, expected in cases:
            with self.subTest(expected=expected):
                classifier = MODULE.HeadlessStderrClassifier()
                for offset in range(0, len(value), 7):
                    classifier.feed(value[offset:offset + 7])
                self.assertEqual(expected, classifier.terminal_class())
                self.assertNotIn("synthetic private message", repr(classifier.__dict__))

    def test_trusted_probe_stderr_classifier_accepts_bounded_diagnostics(
        self,
    ) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"
        self.assertLessEqual(
            max(
                len(
                    MODULE.TRUSTED_PROBE_FAILURE_PREFIX
                    + stage.encode("ascii")
                    + b"\n"
                )
                for stage in MODULE.TRUSTED_PROBE_STAGES
            ),
            MODULE.TRUSTED_PROBE_DIAGNOSTIC_LIMIT,
        )
        for stage in MODULE.TRUSTED_PROBE_STAGES:
            with self.subTest(stage=stage):
                classifier = MODULE.TrustedProbeStderrClassifier()
                value = MODULE.TRUSTED_PROBE_FAILURE_PREFIX + stage.encode() + b"\n"
                for offset in range(0, len(value), 3):
                    classifier.feed(value[offset:offset + 3])
                self.assertEqual(stage, classifier.terminal_stage())

        for value in (
            MODULE.TRUSTED_PROBE_FAILURE_PREFIX + canary.encode() + b"\n",
            b"x" * (MODULE.TRUSTED_PROBE_DIAGNOSTIC_LIMIT + 1),
            b"",
        ):
            with self.subTest(invalid_length=len(value)):
                classifier = MODULE.TrustedProbeStderrClassifier()
                classifier.feed(value)
                self.assertEqual("internal", classifier.terminal_stage())
                self.assertNotIn(canary, repr(classifier.__dict__))

        classifier = MODULE.TrustedProbeStderrClassifier()
        classifier.feed(
            MODULE.TRUSTED_PROBE_FAILURE_PREFIX
            + b"receipt\nTraceback: synthetic root diagnostic\n"
        )
        self.assertEqual("receipt", classifier.terminal_stage())

    def test_trusted_probe_wait_promotes_stage_diagnostic_and_cleans_container(
        self,
    ) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-trusted-probe",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"

        class FailedProbeProcess:
            def __init__(self, stderr: bytes) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO(canary.encode())
                self.stderr = io.BytesIO(stderr)
                self.returncode = 4

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9

        cases = (
            (b"dsh-probe: test-pending-retry\n", "test-pending-retry"),
            (f"dsh-probe: {canary}\n".encode(), "internal"),
            (b"x" * (MODULE.TRUSTED_PROBE_DIAGNOSTIC_LIMIT + 1), "internal"),
        )
        for stderr, expected in cases:
            with self.subTest(expected=expected, length=len(stderr)):
                process = FailedProbeProcess(stderr)
                with mock.patch.object(
                    MODULE.subprocess, "Popen", return_value=process
                ) as popen, mock.patch.object(
                    MODULE, "stop_container"
                ) as cleanup, mock.patch.object(
                    MODULE, "docker", return_value=b"exited 4 false\n"
                ) as inspect:
                    with self.assertRaises(MODULE.TrustedProbeFailure) as raised:
                        MODULE.trusted_probe_gate(
                            "internal",
                            lambda: MODULE.wait_trusted_probe_container(
                                container, 30, 1024, b"synthetic probe source"
                            ),
                        )
                self.assertEqual(expected, raised.exception.stage)
                self.assertIsNone(raised.exception.__context__)
                self.assertEqual(
                    stderr[:MODULE.TRUSTED_PROBE_DIAGNOSTIC_LIMIT],
                    raised.exception.diagnostic,
                )
                self.assertIs(subprocess.PIPE, popen.call_args.kwargs["stderr"])
                cleanup.assert_called_once_with(container, strict=True)
                inspect.assert_called_once_with(
                    "container", "inspect", "--format",
                    "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
                    container.resource_id,
                    timeout=30,
                )

    def test_trusted_probe_wait_rejects_oom_and_attach_state_mismatch(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-trusted-probe",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )

        class ProbeProcess:
            def __init__(self, returncode: int) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO()
                self.stderr = io.BytesIO(b"dsh-probe: test-set\n")
                self.returncode = returncode

            def wait(self, timeout: int) -> int:
                return self.returncode

            def poll(self) -> int:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9

        for attach_code, state in (
            (137, b"exited 137 true\n"),
            (4, b"exited 1 false\n"),
            (1, b"running 1 false\n"),
        ):
            with self.subTest(attach_code=attach_code, state=state):
                process = ProbeProcess(attach_code)
                with mock.patch.object(
                    MODULE.subprocess, "Popen", return_value=process
                ), mock.patch.object(
                    MODULE, "docker", return_value=state
                ), mock.patch.object(MODULE, "stop_container") as cleanup:
                    with self.assertRaises(MODULE.TrustedProbeFailure) as raised:
                        MODULE.trusted_probe_gate(
                            "internal",
                            lambda: MODULE.wait_trusted_probe_container(
                                container, 30, 1024, b"synthetic probe source"
                            ),
                        )
                self.assertEqual("internal", raised.exception.stage)
                cleanup.assert_called_once_with(container, strict=True)

    def test_trusted_probe_stdin_write_is_bounded_by_process_wait_timeout(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-trusted-probe",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        release_writer = threading.Event()

        class BlockingStdin:
            def __init__(self) -> None:
                self.closed = False
                self.main_thread_write = False

            def write(self, value: bytes) -> int:
                if threading.current_thread() is threading.main_thread():
                    self.main_thread_write = True
                    raise AssertionError("probe input write blocked the timeout thread")
                release_writer.wait(timeout=2)
                return len(value)

            def close(self) -> None:
                self.closed = True
                release_writer.set()

        class TimeoutProcess:
            def __init__(self) -> None:
                self.stdin = BlockingStdin()
                self.stdout = io.BytesIO()
                self.stderr = io.BytesIO()
                self.returncode: int | None = None

            def wait(self, timeout: int) -> int:
                if self.returncode is None:
                    release_writer.set()
                    raise subprocess.TimeoutExpired("docker start", timeout)
                return self.returncode

            def poll(self) -> int | None:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9
                release_writer.set()

        process = TimeoutProcess()
        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=process
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.TrustedProbeFailure) as raised:
                MODULE.trusted_probe_gate(
                    "internal",
                    lambda: MODULE.wait_trusted_probe_container(
                        container, 30, 1024, b"synthetic probe source"
                    ),
                )
        self.assertEqual("internal", raised.exception.stage)
        self.assertFalse(process.stdin.main_thread_write)
        self.assertTrue(process.stdin.closed)
        self.assertIn(mock.call(container, strict=False), cleanup.call_args_list)
        self.assertEqual(mock.call(container, strict=True), cleanup.call_args_list[-1])

    def test_trusted_probe_reader_start_failure_still_cleans_container(self) -> None:
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-trusted-probe",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )

        class ProbeProcess:
            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO()
                self.stderr = io.BytesIO()
                self.returncode: int | None = None

            def wait(self, timeout: int) -> int:
                if self.returncode is None:
                    raise AssertionError("wait must not run after reader start failure")
                return self.returncode

            def poll(self) -> int | None:
                return self.returncode

            def kill(self) -> None:
                self.returncode = -9

        first = mock.Mock()
        first.is_alive.return_value = False
        second = mock.Mock()
        second.start.side_effect = RuntimeError("synthetic thread start failure")
        process = ProbeProcess()
        with mock.patch.object(
            MODULE.subprocess, "Popen", return_value=process
        ), mock.patch.object(
            MODULE.threading, "Thread", side_effect=(first, second)
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.TrustedProbeFailure) as raised:
                MODULE.trusted_probe_gate(
                    "internal",
                    lambda: MODULE.wait_trusted_probe_container(
                        container, 30, 1024, b"synthetic probe source"
                    ),
                )
        self.assertEqual("internal", raised.exception.stage)
        first.join.assert_called_once_with(timeout=10)
        second.join.assert_not_called()
        self.assertIn(mock.call(container, strict=False), cleanup.call_args_list)
        self.assertEqual(mock.call(container, strict=True), cleanup.call_args_list[-1])

    def test_headless_failure_main_output_is_fixed_and_redacted(self) -> None:
        canary = "SYNTHETIC_TOKEN_PROMPT_AND_SOURCE_CANARY"
        values = {
            "EMBEDDED_ASSETS": {},
            "EMBEDDED_ASSET_HASHES": {},
            "ORCHESTRATION_COMMIT": "a" * 40,
            "RUNNER_SHA256": "b" * 64,
        }
        stderr = io.StringIO()
        with mock.patch.dict(MODULE.__dict__, values), mock.patch.object(
            MODULE,
            "execute",
            side_effect=MODULE.HeadlessTaskFailure(
                "tests", "noncompleted-no-code"
            ),
        ), redirect_stderr(stderr):
            self.assertEqual(6, MODULE.main())
        self.assertEqual(
            "harness notion automation remote operation failed "
            "(tests/noncompleted-no-code)\n",
            stderr.getvalue(),
        )
        self.assertNotIn(canary, stderr.getvalue())

    def test_fixed_gate_discards_private_failure_and_rejects_unknown_category(
        self,
    ) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"

        def private_failure() -> None:
            raise MODULE.RunnerError(canary)

        for category in sorted(MODULE.FIXED_GATE_CATEGORIES):
            with self.subTest(category=category):
                with self.assertRaises(MODULE.FixedGateFailure) as raised:
                    MODULE.fixed_gate(category, private_failure)
                self.assertEqual(category, raised.exception.category)
                self.assertIsNone(raised.exception.__context__)
                self.assertNotIn(canary, repr(raised.exception))
                self.assertNotIn(canary, repr(raised.exception.__dict__))

        with self.assertRaises(MODULE.RunnerError) as raised:
            MODULE.fixed_gate(canary, private_failure)
        self.assertNotIsInstance(raised.exception, MODULE.FixedGateFailure)
        self.assertNotIn(canary, str(raised.exception))

        nested = MODULE.FixedGateFailure("tests-tree")

        def nested_failure() -> None:
            raise nested

        with self.assertRaises(MODULE.FixedGateFailure) as raised:
            MODULE.fixed_gate("tests-shape", nested_failure)
        self.assertIs(nested, raised.exception)
        self.assertEqual("tests-tree", raised.exception.category)

    def test_fixed_gate_failure_main_output_is_allowlisted_and_redacted(
        self,
    ) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"
        values = {
            "EMBEDDED_ASSETS": {},
            "EMBEDDED_ASSET_HASHES": {},
            "ORCHESTRATION_COMMIT": "a" * 40,
            "RUNNER_SHA256": "b" * 64,
        }
        for category in sorted(MODULE.FIXED_GATE_CATEGORIES):
            with self.subTest(category=category):
                stderr = io.StringIO()
                with mock.patch.dict(MODULE.__dict__, values), mock.patch.object(
                    MODULE,
                    "execute",
                    side_effect=MODULE.FixedGateFailure(category),
                ), redirect_stderr(stderr):
                    self.assertEqual(6, MODULE.main())
                self.assertEqual(
                    "harness notion automation remote operation failed "
                    f"(post-authoring/{category})\n",
                    stderr.getvalue(),
                )
                self.assertNotIn(canary, stderr.getvalue())

        stderr = io.StringIO()
        diagnostic = f"AssertionError: {canary}\n".encode()
        with mock.patch.dict(MODULE.__dict__, values), mock.patch.object(
            MODULE,
            "execute",
            side_effect=MODULE.FixedGateFailure(
                "generated-test-01", diagnostic
            ),
        ), redirect_stderr(stderr):
            self.assertEqual(6, MODULE.main())
        self.assertEqual(
            "harness notion automation remote operation failed "
            "(post-authoring/generated-test-01)\n"
            f"AssertionError: {canary}\n",
            stderr.getvalue(),
        )

    def test_trusted_probe_failure_main_outputs_stage_and_diagnostic(
        self,
    ) -> None:
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"
        values = {
            "EMBEDDED_ASSETS": {},
            "EMBEDDED_ASSET_HASHES": {},
            "ORCHESTRATION_COMMIT": "a" * 40,
            "RUNNER_SHA256": "b" * 64,
        }
        for stage in MODULE.TRUSTED_PROBE_STAGES:
            with self.subTest(stage=stage):
                stderr = io.StringIO()
                with mock.patch.dict(MODULE.__dict__, values), mock.patch.object(
                    MODULE,
                    "execute",
                    side_effect=MODULE.TrustedProbeFailure(stage),
                ), redirect_stderr(stderr):
                    self.assertEqual(6, MODULE.main())
                self.assertEqual(
                    "harness notion automation remote operation failed "
                    f"(post-authoring/trusted-probe-{stage})\n",
                    stderr.getvalue(),
                )
                self.assertNotIn(canary, stderr.getvalue())

        stderr = io.StringIO()
        diagnostic = f"Traceback: {canary}\n".encode()
        with mock.patch.dict(MODULE.__dict__, values), mock.patch.object(
            MODULE,
            "execute",
            side_effect=MODULE.TrustedProbeFailure("internal", diagnostic),
        ), redirect_stderr(stderr):
            self.assertEqual(6, MODULE.main())
        self.assertEqual(
            "harness notion automation remote operation failed "
            "(post-authoring/trusted-probe-internal)\n"
            f"Traceback: {canary}\n",
            stderr.getvalue(),
        )

    def test_headless_patch_has_one_bounded_attempt_and_larger_output_budget(self) -> None:
        patch = (RELEASE_ROOT / "scripts/harness-notion-automation.patch.yml").read_text()
        self.assertEqual(2, patch.count("maxTokens: 65536"))
        self.assertNotIn("maxTokens: 32768", patch)
        self.assertEqual(1, patch.count("reasoningEffort: low"))
        self.assertNotIn("reasoningEffort: high", patch)
        self.assertIn("retryPolicy:\n      mode: normal\n      maxRetries: 0", patch)

        task = (RELEASE_ROOT / "scripts/harness-notion-automation-task.md").read_text()
        normalized_task = " ".join(task.split())
        for required in (
            "mode is 0600 from the instant",
            "close every writable",
            "only after creation is not sufficient",
            "Permission, ownership, ACL, and metadata-copy mutators are unavailable",
            "`chmod`, `fchmod`, `lchmod`, `chown`, `fchown`, `lchown`, `setxattr`",
            "`removexattr`, `copymode`, or `copystat`",
            "deliberately narrow static Python subset",
            "Do not access underscore-prefixed",
            "`type`",
            "`getattr`",
            "`chr`",
            "`ord`",
            "Call traced `fcntl`, `io`, `os`, `sys`, and `open` operations directly",
            "do not alias, store, pass, return, yield",
            "`io.FileIO` is unavailable everywhere",
            "Complete all four preflight checks before opening or reading the token",
            "without GET, PATCH, or other HTTP traffic",
            "do not even create and remove an empty task directory",
            "Preserve every directory entry",
            "target canary's bytes and full stable identity",
            "stdout nor stderr may contain any byte sequence read from a symlink target",
            "read-only descriptor opened with both `O_NOFOLLOW` and `O_CLOEXEC`",
            "before and after the complete read",
            "sequentially and directly with `os.read` from offset zero",
            "Do not seek, duplicate, transfer, wrap, or reopen",
            "`fdopen`, `open(fd)`, `io.open`, or `io.FileIO`",
            "The first successful pull must create all three canonical artifacts",
            "rewrite only the canonical artifacts whose content or durable state actually changes",
            "must not be rewritten at all — its inode must remain identical, including in a",
            "Persist any retryable pending operation inside the three canonical artifacts",
            "at most one GET, at most one PATCH, and at most 32 total rename calls",
            "including canonical, staged, and journal paths",
            "every attempted rename must complete",
            "Never place a rename between opening and closing the token descriptor",
            "A crash may occur before the token is opened, or after a",
            "complete safe token read but before any API request",
            "immediately before or after any individual rename",
            "remove every staged temporary or extra journal artifact left by either boundary",
            "Crash residues must be direct-child regular files in the task directory",
            "owned by the current process uid and gid, mode 0600 with one link",
            "`os.open` using `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC`",
            "write it sequentially with `os.write`",
            "Do not use high-level writable file handles, hard links, or symbolic links",
            "Never publish a staged file left by a prior process",
            "replacement at a fresh direct-child pathname",
            "Keep every staged or journal path directly inside the task directory",
            "Fsync the task directory after removing crash residue",
            "task directory after any completed invocation must contain exactly the three",
            "must be validated as owned by",
            "mode 0600, one link, removed, and the task",
            "recovery finds nothing more to upload",
            "the next invocation must return the task directory to exactly those three files",
            "A second equivalent pull must leave all three canonical artifact bytes unchanged",
            "crash-recovery invocation must converge the journal as well",
            "must end by opening the task directory itself",
            "`os.fsync`ing that directory descriptor as its final durability step",
            "fsyncing a file descriptor or any other directory does not satisfy this",
            "At the start of every invocation that performs an operation",
            "path is the sole exception: when the persisted journal",
            "resolve nothing token-related at all (no stat,",
            "it must not even perform a metadata check (stat or readlink) on",
            "exactly `json.dumps` of its status object with",
            "Tests must construct the expected bytes with",
            "must not expect any other whitespace",
            "boundary at the filesystem level: after the common base is established",
            "A FIFO or an unreadable file alone is insufficient: a metadata-only check still succeeds on",
            "then run the same silent no-op proof with the un-resolvable",
            "directory to contain exactly the three canonical artifacts with no extra",
            "The common base is the exact Notion body last confirmed by a successful sync",
            "a pull with only the remote body changed adopts the remote body and returns `synced`",
            "a push with only the local mirror changed PATCHes the local body and returns `synced`",
            "a set while the remote body still equals the common base",
            "both differ from the common base and also differ from each other",
            "candidate local body and current remote body are already equal",
            "the exact wire contract (the release-owned contract",
            "conflict` detection for `--pull`, `--push`, or `--set`",
            "performs exactly one GET (to fetch the current remote body) and zero PATCHes",
            "a successful `--push` or `--set` performs at most one GET",
            "`queued` result performs exactly one attempted PATCH",
            "`--retry-pending` replays exactly one PATCH with the same body",
            "Never PATCH on a `--pull`",
            "runs every test method in its own fresh process and",
            "pass independently of any other method",
            "counters start from zero for every test method",
            "lifetime total must be asserted by exact number, never computed as a",
            "finishes at exactly 1 GET and 0 PATCHes",
            "finishes at exactly 2 GETs (first pull plus equivalent",
            "finishes at exactly 2 GETs (the baseline first pull plus the conflict",
            "The total of 2 GETs includes the baseline pull: a conflict operation adds exactly one GET",
            "Every test that needs an initialized state must establish its common base",
            "a test that explicitly verifies a failed first pull may start without a common base",
            "Use this exact production-equivalent boundary for every first-pull test",
            "the visibly fake token file contains printable non-whitespace ASCII token bytes with no line terminator",
            "`Path(NOTION_INBOX_FILE).parent.parent` already exists",
            "`Path(NOTION_INBOX_FILE).parent` and all three canonical artifacts are absent",
            "`NOTION_API_BASE` ends exactly in `/v1` with no trailing slash",
            "`/v1/pages/{NOTION_PAGE_ID}/markdown`",
            "URL construction preserves the configured base path",
            "Treat the contents of `sync-state.json` and `notion-fingerprint.json` as private implementation details",
            "must not fabricate, rewrite, or depend on any private field or schema",
            "leave both the mirror and fake remote body unchanged",
            "run an equivalent second pull and require `synced` with all three artifact bytes unchanged",
            "Do not turn `test_atomic_artifacts` into a conflict scenario",
        ):
            with self.subTest(task_contract=required):
                self.assertIn(required, normalized_task)
        self.assertNotIn(
            "If both local and remote differ from their common base, a normal operation is `conflict`",
            normalized_task,
        )

    def test_common_container_args_carry_full_operation_nonce(self) -> None:
        args = MODULE.common_container_args(
            "dsh-harness-notion-deadbeef-test", "none", self.NONCE
        )
        self.assertIn(
            f"{MODULE.RESOURCE_NONCE_LABEL}={self.NONCE}", args
        )
        self.assertNotIn(self.NONCE[:12], args)

    def test_two_authoring_phases_have_inverse_nested_mounts_and_fixed_prompts(self) -> None:
        notion = Path("/synthetic/notion")
        patch = Path("/synthetic/lockdown.patch.yml")
        network = MODULE.NetworkRef(
            "synthetic-internal", "c" * 64, self.NONCE, True
        )

        def created(name: str, _args: list[str], nonce: str, image_id: str):
            return MODULE.ContainerRef(name, uuid.uuid4().hex * 2, nonce, image_id)

        with mock.patch.object(
            MODULE, "create_container", side_effect=created
        ) as create, mock.patch.object(MODULE, "wait_headless_container") as wait:
            MODULE.run_agent(
                self.IMAGE_ID, notion, patch, b"shared public contract",
                network, self.NONCE, "implementation",
            )
            MODULE.run_agent(
                self.IMAGE_ID, notion, patch, b"shared public contract",
                network, self.NONCE, "tests",
            )

        self.assertEqual(("implementation", "tests"), MODULE.AUTHORING_PHASES)
        self.assertEqual(2, create.call_count)
        self.assertEqual(2, wait.call_count)
        root_rw = f"type=bind,src={notion},dst=/work"
        root_ro = root_rw + ",readonly"
        tests_rw = f"type=bind,src={notion / 'tests'},dst=/work/tests"
        tests_ro = tests_rw + ",readonly"
        expected = (
            ("implementation", root_rw, tests_ro),
            ("tests", root_ro, tests_rw),
        )
        for index, (phase, root_mount, nested_mount) in enumerate(expected):
            name, args, nonce, image_id = create.call_args_list[index].args
            self.assertEqual(
                f"dsh-harness-notion-{self.NONCE[:12]}-task-{phase}", name
            )
            self.assertEqual(self.NONCE, nonce)
            self.assertEqual(self.IMAGE_ID, image_id)
            self.assertLess(args.index(root_mount), args.index(nested_mount))
            self.assertEqual(1, args.count(root_mount))
            self.assertEqual(1, args.count(nested_mount))
            self.assertEqual(
                1,
                args.count(
                    "/home/herman/.dsh:rw,nosuid,nodev,noexec,size=512m,mode=0700,uid=1000,gid=1000"
                ),
            )
            phase_prompt = args[-1]
            self.assertIn("shared public contract", phase_prompt)
            self.assertIn(f"AUTHORING PHASE {index + 1} OF 2", phase_prompt)
            self.assertNotIn("SYNTHETIC_TOKEN_PROMPT_AND_SOURCE_CANARY", phase_prompt)
            waited_container, timeout, waited_phase = wait.call_args_list[index].args
            self.assertEqual(name, waited_container.name)
            self.assertEqual(MODULE.AUTHORING_PHASE_TIMEOUT, timeout)
            self.assertEqual(780, timeout)
            self.assertEqual(phase, waited_phase)

    def test_authoring_stage_validators_lock_partial_and_final_trees(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            notion = Path(temporary) / "notion"
            tests = notion / "tests"
            tests.mkdir(parents=True)
            source = notion / MODULE.ENTRYPOINT
            source.write_bytes(b"VALUE = 1\n")

            ownership = {"owner": os.getuid(), "group": os.getgid()}
            snapshot = MODULE.validate_implementation_stage(notion, **ownership)
            self.assertEqual(64, len(snapshot.sha256))
            extra = notion / "unexpected"
            extra.write_bytes(b"synthetic")
            with self.assertRaises(MODULE.RunnerError):
                MODULE.validate_implementation_stage(notion, **ownership)
            extra.unlink()

            (notion / MODULE.TEST_INIT).write_bytes(b"")
            (notion / MODULE.TEST_SUITE).write_bytes(b"synthetic tests")
            MODULE.validate_tests_stage(notion, snapshot, **ownership)
            extra = tests / "unexpected"
            extra.write_bytes(b"synthetic")
            with self.assertRaises(MODULE.RunnerError):
                MODULE.validate_tests_stage(notion, snapshot, **ownership)
            extra.unlink()

            replacement = notion / "replacement"
            replacement.write_bytes(source.read_bytes())
            os.replace(replacement, source)
            self.assertEqual(snapshot.sha256, MODULE.sha256_bytes(source.read_bytes()))
            self.assertNotEqual(snapshot.identity[1], os.lstat(source).st_ino)
            with self.assertRaises(MODULE.RunnerError):
                MODULE.validate_tests_stage(notion, snapshot, **ownership)

    def assert_pretest_failure_cleans_without_publication(
        self,
        *,
        failed_phase: str | None = None,
        failed_gate: str | None = None,
        failed_probe_stage: str | None = None,
        reuse_teardown_fd: bool = False,
        through_main: bool = False,
    ) -> None:
        self.assertEqual(
            1,
            int(failed_phase is not None)
            + int(failed_gate is not None)
            + int(failed_probe_stage is not None),
        )
        if reuse_teardown_fd:
            self.assertEqual("authoring-teardown", failed_gate)
        if through_main:
            self.assertEqual("implementation-artifact", failed_gate)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dsh_home = root / "dsh-home"
            automations = dsh_home / "workspace/automations"
            automations.mkdir(parents=True)
            target = automations / "notion"
            tasks_root = root / "tasks"
            tasks_root.mkdir()
            nonce = "a" * 32
            task_root = tasks_root / nonce
            notion = task_root / "dsh-home/workspace/automations/notion"
            (notion / "tests").mkdir(parents=True)
            relay = MODULE.ContainerRef(
                f"dsh-harness-notion-{nonce[:12]}-relay",
                "b" * 64,
                nonce,
                self.IMAGE_ID,
            )
            internal = MODULE.NetworkRef(
                "synthetic-internal", "c" * 64, nonce, True
            )
            egress = MODULE.NetworkRef(
                "synthetic-egress", "d" * 64, nonce, False
            )

            class CompletedRelay:
                def wait(self, timeout: int) -> int:
                    return 0

                def poll(self) -> None:
                    return None

                def kill(self) -> None:
                    raise AssertionError("completed relay must not be killed")

            def acquire_test_lock() -> int:
                return os.open(
                    root / "operation.lock", os.O_RDWR | os.O_CREAT, 0o600
                )

            def test_directory(path: Path, **_kwargs: object):
                entry = os.lstat(path)
                if not stat.S_ISDIR(entry.st_mode):
                    raise MODULE.RunnerError("synthetic directory mismatch")
                return entry

            real_open_directory = MODULE.open_directory

            def test_open_directory(
                path: Path, *, owner: int = 1000, group: int | None = None
            ):
                return real_open_directory(
                    path, owner=os.getuid(), group=os.getgid()
                )

            def start_bridge(*_args: object, **_kwargs: object):
                return relay, CompletedRelay(), os.open(os.devnull, os.O_WRONLY)

            def author_phase(*args: object) -> None:
                phase = str(args[-1])
                if failed_phase is not None and phase == failed_phase:
                    raise MODULE.HeadlessTaskFailure(phase, "timeout")

            canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"
            real_fixed_gate = MODULE.fixed_gate
            replacement_fd: int | None = None

            def structural_gate(category: str, operation: object) -> object:
                if category == failed_gate:
                    if reuse_teardown_fd or category == "implementation-artifact":
                        return real_fixed_gate(category, operation)

                    def private_failure() -> None:
                        raise MODULE.RunnerError(canary)

                    return real_fixed_gate(category, private_failure)
                return operation()

            def generated_test_phases(*_args: object) -> None:
                for category in MODULE.GENERATED_TEST_GATE_CATEGORIES:
                    MODULE.fixed_gate(category, lambda: None)

            def trusted_probe(*_args: object) -> dict[str, object]:
                if failed_probe_stage is None:
                    return {}

                def private_failure() -> None:
                    raise MODULE.RunnerError(canary)

                return MODULE.trusted_probe_gate(
                    failed_probe_stage, private_failure
                )

            def teardown_authoring(
                _relay: object,
                _process: object,
                sentinel_fd: int,
                _internal: object,
                _egress: object,
            ) -> None:
                nonlocal replacement_fd
                if not reuse_teardown_fd:
                    return
                os.close(sentinel_fd)
                replacement_fd = os.open(
                    root / "replacement-fd", os.O_WRONLY | os.O_CREAT, 0o600
                )
                self.assertEqual(sentinel_fd, replacement_fd)
                raise MODULE.RunnerError(canary)

            def remove_task(path: Path) -> None:
                self.assertEqual(task_root, path)
                shutil.rmtree(path)

            assets = {name: b"synthetic" for name in MODULE.ASSET_LIMITS}
            asset_hashes = {name: "8" * 64 for name in MODULE.ASSET_LIMITS}
            image = {"imageId": self.IMAGE_ID}
            with ExitStack() as stack:
                for name, value in (
                    ("DSH_HOME", dsh_home),
                    ("AUTOMATIONS_ROOT", automations),
                    ("TARGET", target),
                    ("TASKS_ROOT", tasks_root),
                ):
                    stack.enter_context(mock.patch.object(MODULE, name, value))
                stack.enter_context(mock.patch.object(MODULE, "validate_assets"))
                stack.enter_context(mock.patch.object(
                    MODULE, "require_real_directory", side_effect=test_directory
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "open_directory", side_effect=test_open_directory
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "require_path_chain_identity"
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "acquire_lock", side_effect=acquire_test_lock
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "load_checker", return_value=object()
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "accepted_image", return_value=image
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "create_task_tree",
                    return_value=(task_root, notion, False),
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "write_control_assets",
                    return_value={
                        "bridge": root / "synthetic.bridge.mjs",
                        "patch": root / "synthetic.patch.yml",
                    },
                ))
                stack.enter_context(mock.patch.object(MODULE, "run_dump_config"))
                stack.enter_context(mock.patch.object(
                    MODULE, "create_network", side_effect=[internal, egress]
                ))
                stack.enter_context(mock.patch.object(
                    MODULE, "start_secret_bridge", side_effect=start_bridge
                ))
                stack.enter_context(mock.patch.object(MODULE, "wait_relay"))
                stack.enter_context(mock.patch.object(MODULE, "revalidate_image"))
                run_agent = stack.enter_context(mock.patch.object(
                    MODULE, "run_agent", side_effect=author_phase
                ))
                implementation_gate = stack.enter_context(mock.patch.object(
                    MODULE,
                    "validate_implementation_stage",
                    side_effect=(
                        MODULE.RunnerError(canary)
                        if failed_gate == "implementation-artifact"
                        else None
                    ),
                    return_value=MODULE.SourceSnapshot((1,) * 9, "a" * 64),
                ))
                tests_tree = stack.enter_context(mock.patch.object(
                    MODULE, "validate_tests_tree"
                ))
                tests_source = stack.enter_context(mock.patch.object(
                    MODULE, "validate_tests_source_identity"
                ))
                teardown = stack.enter_context(mock.patch.object(
                    MODULE, "teardown_authoring", side_effect=teardown_authoring
                ))
                normalize = stack.enter_context(mock.patch.object(
                    MODULE, "normalize_generated_modes"
                ))
                manifest = stack.enter_context(mock.patch.object(
                    MODULE, "generated_file_manifest", return_value={}
                ))
                shape = stack.enter_context(mock.patch.object(
                    MODULE, "validate_generated_test_shape"
                ))
                generated_tests = stack.enter_context(mock.patch.object(
                    MODULE, "run_tests", side_effect=generated_test_phases
                ))
                probe = stack.enter_context(mock.patch.object(
                    MODULE, "run_trusted_probe", side_effect=trusted_probe
                ))
                install = stack.enter_context(mock.patch.object(
                    MODULE, "install_noreplace"
                ))
                stack.enter_context(mock.patch.object(MODULE, "stop_container"))
                stack.enter_context(mock.patch.object(MODULE, "cleanup_network"))
                gate = stack.enter_context(mock.patch.object(
                    MODULE, "fixed_gate", side_effect=structural_gate
                ))
                cleanup = stack.enter_context(mock.patch.object(
                    MODULE, "cleanup_task_tree", side_effect=remove_task
                ))
                if through_main:
                    stderr = io.StringIO()
                    values = {
                        "EMBEDDED_ASSETS": assets,
                        "EMBEDDED_ASSET_HASHES": asset_hashes,
                        "ORCHESTRATION_COMMIT": "9" * 40,
                        "RUNNER_SHA256": "0" * 64,
                    }
                    with mock.patch.dict(MODULE.__dict__, values), redirect_stderr(stderr):
                        self.assertEqual(6, MODULE.main())
                    self.assertEqual(
                        "harness notion automation remote operation failed "
                        "(post-authoring/implementation-artifact)\n",
                        stderr.getvalue(),
                    )
                    self.assertNotIn(canary, stderr.getvalue())
                    raised = None
                else:
                    expected_failure = (
                        MODULE.HeadlessTaskFailure
                        if failed_phase is not None
                        else MODULE.TrustedProbeFailure
                        if failed_probe_stage is not None
                        else MODULE.FixedGateFailure
                    )
                    with self.assertRaises(expected_failure) as raised:
                        MODULE.execute(assets, asset_hashes, "9" * 40, "0" * 64)

            if raised is not None:
                if failed_phase is not None:
                    self.assertEqual(failed_phase, raised.exception.phase)
                elif failed_probe_stage is not None:
                    self.assertEqual(failed_probe_stage, raised.exception.stage)
                    self.assertIsNone(raised.exception.__context__)
                    self.assertNotIn(canary, repr(raised.exception))
                    self.assertNotIn(canary, repr(raised.exception.__dict__))
                else:
                    self.assertEqual(failed_gate, raised.exception.category)
                    self.assertIsNone(raised.exception.__context__)
                    self.assertNotIn(canary, repr(raised.exception))
                    self.assertNotIn(canary, repr(raised.exception.__dict__))
            expected_phases = (
                ["implementation"]
                if failed_phase == "implementation"
                or failed_gate == "implementation-artifact"
                else ["implementation", "tests"]
            )
            self.assertEqual(
                expected_phases, [call.args[-1] for call in run_agent.call_args_list]
            )
            self.assertEqual(
                0 if failed_phase == "implementation" else 1,
                implementation_gate.call_count,
            )
            structural_operations = (
                ("implementation-artifact", implementation_gate),
                ("tests-tree", tests_tree),
                ("tests-source-identity", tests_source),
                ("authoring-teardown", teardown),
                ("tests-modes", normalize),
                ("tests-manifest", manifest),
                ("tests-shape", shape),
            )
            post_authoring_categories = (
                *[category for category, _operation in structural_operations],
                *MODULE.GENERATED_TEST_GATE_CATEGORIES,
            )
            if failed_phase == "implementation":
                expected_gate_categories: list[str] = []
                failed_index = -1
                reached_operation_indices: set[int] = set()
            elif failed_phase == "tests":
                expected_gate_categories = ["implementation-artifact"]
                failed_index = 0
                reached_operation_indices = {0}
            elif failed_probe_stage is not None:
                failed_index = len(post_authoring_categories)
                expected_gate_categories = list(post_authoring_categories)
                reached_operation_indices = set(range(len(structural_operations)))
            else:
                failed_index = post_authoring_categories.index(str(failed_gate))
                expected_gate_categories = list(
                    post_authoring_categories[: failed_index + 1]
                )
                reached_operation_indices = set(range(failed_index))
                if reuse_teardown_fd or failed_gate == "implementation-artifact":
                    reached_operation_indices.add(failed_index)
            self.assertEqual(
                expected_gate_categories,
                [call.args[0] for call in gate.call_args_list],
            )
            for index, (_category, operation) in enumerate(structural_operations):
                self.assertEqual(
                    1 if index in reached_operation_indices else 0,
                    operation.call_count,
                )
            generated_start = len(structural_operations)
            self.assertEqual(
                1 if failed_index >= generated_start else 0,
                generated_tests.call_count,
            )
            self.assertEqual(1 if failed_probe_stage is not None else 0, probe.call_count)
            install.assert_not_called()
            cleanup.assert_called_once_with(task_root)
            self.assertFalse(task_root.exists())
            self.assertFalse(target.exists())
            if reuse_teardown_fd:
                self.assertIsNotNone(replacement_fd)
                try:
                    os.fstat(replacement_fd)
                finally:
                    try:
                        os.close(replacement_fd)
                    except OSError:
                        pass

    def test_implementation_phase_failure_cleans_without_publication(self) -> None:
        self.assert_pretest_failure_cleans_without_publication(
            failed_phase="implementation"
        )

    def test_tests_phase_failure_cleans_without_publication(self) -> None:
        self.assert_pretest_failure_cleans_without_publication(failed_phase="tests")

    def test_implementation_artifact_failure_is_fixed_redacted_and_terminal(
        self,
    ) -> None:
        self.assert_pretest_failure_cleans_without_publication(
            failed_gate="implementation-artifact"
        )
        self.assert_pretest_failure_cleans_without_publication(
            failed_gate="implementation-artifact",
            through_main=True,
        )

    def test_each_fixed_gate_failure_cleans_without_publication(self) -> None:
        for category in sorted(MODULE.FIXED_GATE_CATEGORIES):
            with self.subTest(category=category):
                self.assert_pretest_failure_cleans_without_publication(
                    failed_gate=category
                )

    def test_each_trusted_probe_stage_failure_cleans_without_publication(self) -> None:
        for stage in MODULE.TRUSTED_PROBE_STAGES:
            with self.subTest(stage=stage):
                self.assert_pretest_failure_cleans_without_publication(
                    failed_probe_stage=stage
                )

    def test_teardown_failure_does_not_close_reused_sentinel_fd(self) -> None:
        self.assert_pretest_failure_cleans_without_publication(
            failed_gate="authoring-teardown",
            reuse_teardown_fd=True,
        )

    def test_generated_tests_mount_the_complete_tree_readonly(self) -> None:
        notion = Path("/synthetic/notion")
        container = MODULE.ContainerRef(
            f"dsh-harness-notion-{self.NONCE[:12]}-test-00",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        with mock.patch.object(
            MODULE, "generated_manifest", return_value={}
        ), mock.patch.object(
            MODULE, "create_container", return_value=container
        ) as create, mock.patch.object(
            MODULE, "wait_generated_test_container"
        ) as wait:
            MODULE.run_tests(self.IMAGE_ID, notion, self.NONCE, {})
        self.assertEqual(len(MODULE.TEST_METHODS), create.call_count)
        for call in create.call_args_list:
            args = call.args[1]
            self.assertIn(
                f"type=bind,src={notion},dst=/work,readonly", args
            )
            self.assertNotIn(f"type=bind,src={notion},dst=/work", args)
        self.assertEqual(
            list(MODULE.GENERATED_TEST_GATE_CATEGORIES),
            [call.args[2] for call in wait.call_args_list],
        )

    def test_generated_test_07_wait_and_manifest_failures_are_fixed_and_redacted(
        self,
    ) -> None:
        notion = Path("/synthetic/notion")
        baseline: dict[str, dict[str, object]] = {}
        canary = "SYNTHETIC_TOKEN_PATH_SOURCE_BODY_CANARY"

        def created(name: str, _args: list[str], nonce: str, image_id: str):
            return MODULE.ContainerRef(name, uuid.uuid4().hex * 2, nonce, image_id)

        for fault in ("wait", "manifest"):
            with self.subTest(fault=fault):
                wait_count = 0
                manifest_count = 0

                def wait(
                    _container: object,
                    _timeout: int,
                    _category: str,
                ) -> None:
                    nonlocal wait_count
                    index = wait_count
                    wait_count += 1
                    if fault == "wait" and index == 7:
                        raise MODULE.RunnerError(canary)

                def manifest(_root: Path) -> dict[str, dict[str, object]]:
                    nonlocal manifest_count
                    index = manifest_count
                    manifest_count += 1
                    if fault == "manifest" and index == 7:
                        return {canary: {}}
                    return baseline

                with mock.patch.object(
                    MODULE, "create_container", side_effect=created
                ) as create, mock.patch.object(
                    MODULE, "wait_generated_test_container", side_effect=wait
                ), mock.patch.object(
                    MODULE, "generated_manifest", side_effect=manifest
                ):
                    with self.assertRaises(MODULE.FixedGateFailure) as raised:
                        MODULE.run_tests(
                            self.IMAGE_ID, notion, self.NONCE, baseline
                        )

                self.assertEqual("generated-test-07", raised.exception.category)
                self.assertIsNone(raised.exception.__context__)
                self.assertNotIn(canary, repr(raised.exception))
                self.assertNotIn(canary, repr(raised.exception.__dict__))
                self.assertEqual(8, create.call_count)
                self.assertEqual(8, wait_count)
                self.assertEqual(7 if fault == "wait" else 8, manifest_count)

    def test_secret_bridge_keeps_relay_ownership_on_setup_failure(self) -> None:
        relay = MODULE.ContainerRef(
            f"dsh-harness-notion-{self.NONCE[:12]}-relay",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        internal = MODULE.NetworkRef("synthetic-internal", "c" * 64, self.NONCE, True)
        egress = MODULE.NetworkRef("synthetic-egress", "d" * 64, self.NONCE, False)
        with mock.patch.object(
            MODULE, "require_stable_regular_metadata", return_value=(1,) * 9
        ), mock.patch.object(MODULE, "network_ip", return_value="172.31.0.10"), mock.patch.object(
            MODULE, "create_container", return_value=relay
        ) as create, mock.patch.object(
            MODULE, "docker", side_effect=MODULE.RunnerError("synthetic connect failure")
        ), mock.patch.object(MODULE, "stop_container") as cleanup:
            with self.assertRaises(MODULE.RunnerError):
                MODULE.start_secret_bridge(
                    self.IMAGE_ID,
                    Path("/synthetic/bridge.mjs"),
                    self.NONCE,
                    internal,
                    egress,
                )
        self.assertEqual(1, create.call_count)
        cleanup.assert_called_once_with(relay, strict=True)

    def test_secret_bridge_rejects_host_credential_symlink_before_docker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            canary = root / "external-credential-canary"
            canary.write_bytes(b"synthetic-external-secret")
            canary.chmod(0o600)
            credential = root / ".credentials.yaml"
            credential.symlink_to(canary)
            before = canary.read_bytes()
            with mock.patch.object(MODULE, "PRODUCTION_CREDENTIAL", credential), mock.patch.object(
                MODULE, "network_ip"
            ) as network_ip, mock.patch.object(MODULE, "create_container") as create:
                with self.assertRaisesRegex(
                    MODULE.RunnerError, "^harness notion automation operation failed$"
                ):
                    MODULE.start_secret_bridge(
                        self.IMAGE_ID,
                        Path("/synthetic/bridge.mjs"),
                        self.NONCE,
                        MODULE.NetworkRef("synthetic-internal", "c" * 64, self.NONCE, True),
                        MODULE.NetworkRef("synthetic-egress", "d" * 64, self.NONCE, False),
                    )
            self.assertEqual(before, canary.read_bytes())
            self.assertTrue(credential.is_symlink())
            network_ip.assert_not_called()
            create.assert_not_called()

    def test_strict_cleanup_fault_is_fatal(self) -> None:
        timed_out = subprocess.TimeoutExpired(["docker", "rm"], 30)
        container = MODULE.ContainerRef(
            "dsh-harness-notion-deadbeef-test",
            "b" * 64,
            self.NONCE,
            self.IMAGE_ID,
        )
        with mock.patch.object(
            MODULE, "inspect_container_ref", return_value=True
        ), mock.patch.object(MODULE.subprocess, "run", side_effect=timed_out):
            with self.assertRaises(MODULE.RunnerError):
                MODULE.stop_container(container, strict=True)

    def assert_execute_publication_fault_rolls_back(self, fault: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dsh_home = root / "dsh-home"
            automations = dsh_home / "workspace/automations"
            automations.mkdir(parents=True)
            tasks_root = root / "tasks"
            target = automations / "notion"
            nonce = "a" * 32
            task_root = tasks_root / nonce
            checked = {
                "sourceLength": 9,
                "sourceSha256": "1" * 64,
                "handoffSha256": "2" * 64,
                "testReceiptSha256": "3" * 64,
                "probeSha256": "4" * 64,
                "testedAt": "2026-08-30T00:00:00Z",
            }
            formal = {
                "sha256": checked["sourceSha256"],
                "handoffSha256": checked["handoffSha256"],
                "testReceiptSha256": checked["testReceiptSha256"],
            }
            image = {
                "releaseId": "synthetic-release",
                "imageId": self.IMAGE_ID,
                "harnessCommit": "5" * 40,
                "harnessPatchSha256": "sha256:" + "6" * 64,
                "acceptedReleaseToolCommit": "7" * 40,
            }
            assets = {name: b"synthetic" for name in MODULE.ASSET_LIMITS}
            asset_hashes = {name: "8" * 64 for name in MODULE.ASSET_LIMITS}
            asset_hashes["probe"] = checked["probeSha256"]
            relay = MODULE.ContainerRef(
                f"dsh-harness-notion-{nonce[:12]}-relay",
                "b" * 64,
                nonce,
                self.IMAGE_ID,
            )
            internal = MODULE.NetworkRef("synthetic-internal", "c" * 64, nonce, True)
            egress = MODULE.NetworkRef("synthetic-egress", "d" * 64, nonce, False)

            class CompletedRelay:
                def wait(self, timeout: int) -> int:
                    return 0

                def poll(self) -> None:
                    return None

            def acquire_test_lock() -> int:
                return os.open(root / "operation.lock", os.O_RDWR | os.O_CREAT, 0o600)

            def start_bridge(*_args: object, **_kwargs: object):
                return relay, CompletedRelay(), os.open(os.devnull, os.O_WRONLY)

            def leave_sentinel(notion: Path) -> None:
                (notion / "sentinel").write_text("synthetic")

            real_path_check = MODULE.require_path_chain_identity
            path_checks = 0

            def maybe_fail_path(
                path: Path, descriptor: int, expected: tuple[int, ...]
            ) -> None:
                nonlocal path_checks
                path_checks += 1
                if fault == "path-identity" and path_checks == 5:
                    raise MODULE.RunnerError("synthetic post-install path fault")
                real_path_check(path, descriptor, expected)

            def validate_final(_target: Path) -> dict[str, object]:
                if fault == "validation":
                    raise MODULE.RunnerError("synthetic post-install validation fault")
                return checked

            real_open_directory = MODULE.open_directory
            real_prepare_publication_stage = MODULE.prepare_publication_stage

            def test_directory(path: Path, *, owner: int | None = None):
                entry = os.lstat(path)
                if not stat.S_ISDIR(entry.st_mode):
                    raise MODULE.RunnerError("synthetic directory mismatch")
                return entry

            def test_open_directory(
                path: Path, *, owner: int = 1000, group: int | None = None
            ):
                return real_open_directory(
                    path, owner=os.getuid(), group=os.getgid()
                )

            def test_prepare_publication_stage(task: Path, notion: Path) -> Path:
                return real_prepare_publication_stage(
                    task, notion, owner=os.getuid(), group=os.getgid()
                )

            with ExitStack() as stack:
                for name, value in (
                    ("DSH_HOME", dsh_home),
                    ("AUTOMATIONS_ROOT", automations),
                    ("TARGET", target),
                    ("TASKS_ROOT", tasks_root),
                ):
                    stack.enter_context(mock.patch.object(MODULE, name, value))
                stack.enter_context(mock.patch.object(MODULE, "validate_assets"))
                stack.enter_context(mock.patch.object(MODULE, "require_real_directory", side_effect=test_directory))
                stack.enter_context(mock.patch.object(MODULE, "open_directory", side_effect=test_open_directory))
                stack.enter_context(mock.patch.object(MODULE, "prepare_publication_stage", side_effect=test_prepare_publication_stage))
                stack.enter_context(mock.patch.object(MODULE, "acquire_lock", side_effect=acquire_test_lock))
                stack.enter_context(mock.patch.object(MODULE, "load_checker", return_value=object()))
                stack.enter_context(mock.patch.object(MODULE, "accepted_image", return_value=image))
                stack.enter_context(mock.patch.object(MODULE.uuid, "uuid4", return_value=uuid.UUID(hex=nonce)))
                stack.enter_context(mock.patch.object(MODULE, "run_dump_config"))
                stack.enter_context(mock.patch.object(MODULE, "create_network", side_effect=[internal, egress]))
                stack.enter_context(mock.patch.object(MODULE, "start_secret_bridge", side_effect=start_bridge))
                stack.enter_context(mock.patch.object(MODULE, "wait_relay"))
                stack.enter_context(mock.patch.object(MODULE, "revalidate_image"))
                run_agent = stack.enter_context(mock.patch.object(MODULE, "run_agent"))
                stack.enter_context(mock.patch.object(
                    MODULE,
                    "validate_implementation_stage",
                    return_value=MODULE.SourceSnapshot((1,) * 9, "a" * 64),
                ))
                stack.enter_context(mock.patch.object(MODULE, "validate_tests_tree"))
                stack.enter_context(mock.patch.object(MODULE, "validate_tests_source_identity"))
                stack.enter_context(mock.patch.object(MODULE, "stop_container"))
                stack.enter_context(mock.patch.object(MODULE, "cleanup_network"))
                stack.enter_context(mock.patch.object(MODULE, "normalize_generated_modes", side_effect=leave_sentinel))
                stack.enter_context(mock.patch.object(MODULE, "generated_file_manifest", return_value={}))
                stack.enter_context(mock.patch.object(MODULE, "validate_generated_test_shape"))
                stack.enter_context(mock.patch.object(MODULE, "run_tests"))
                stack.enter_context(mock.patch.object(MODULE, "run_trusted_probe", return_value={}))
                stack.enter_context(mock.patch.object(MODULE, "create_receipts", return_value=checked))
                stack.enter_context(mock.patch.object(MODULE, "checker_receipt", return_value=formal))
                stack.enter_context(mock.patch.object(MODULE, "fsync_tree"))
                stack.enter_context(mock.patch.object(MODULE, "validate_receipts", side_effect=validate_final))
                stack.enter_context(mock.patch.object(MODULE, "require_path_chain_identity", side_effect=maybe_fail_path))
                stack.enter_context(mock.patch.object(MODULE, "cleanup_task_tree"))
                with self.assertRaises(MODULE.RunnerError):
                    MODULE.execute(assets, asset_hashes, "9" * 40, "0" * 64)

            self.assertEqual(2, run_agent.call_count)
            self.assertEqual(
                ["implementation", "tests"],
                [call.args[-1] for call in run_agent.call_args_list],
            )
            self.assertFalse(target.exists())
            restored = task_root / "notion/sentinel"
            self.assertTrue(
                restored.is_file(),
                [path.relative_to(root).as_posix() for path in root.rglob("*")],
            )
            self.assertEqual("synthetic", restored.read_text())

    def test_execute_post_install_path_identity_fault_rolls_back(self) -> None:
        self.assert_execute_publication_fault_rolls_back("path-identity")

    def test_execute_post_install_validation_fault_rolls_back(self) -> None:
        self.assert_execute_publication_fault_rolls_back("validation")

    def test_dump_config_rejects_one_extra_active_row(self) -> None:
        blocks: list[str] = []
        required = {
            "agent-default-model": [
                "    provider: deepseek-official",
                "    model: deepseek-v4-flash",
            ],
            "llm-deepseek": [
                "    apiKeyEnv: DEEPSEEK_API_KEY",
                "    baseURL: http://deepseek-relay:8080",
                "    thinking: enabled",
                "    reasoningEffort: low",
                "    maxTokens: 65536",
                "    retryPolicy:",
                "      mode: normal",
                "      maxRetries: 0",
                "      - id: deepseek-v4-flash",
                "        maxTokens: 65536",
                "          - text",
            ],
            "tools": ["    mode: native", "    maxParallelSubCalls: 1"],
            "agent-loop": ["    agents: []", "    maxParallelToolCalls: 1"],
            "sandbox-policy": [
                "    mode: workspace-write",
                "    workspaceRoot: /work",
            ],
        }
        for row in sorted(MODULE.ACTIVE_ROWS):
            blocks.extend([f"- id: {row}", *required.get(row, [])])
        MODULE.validate_dump(("\n".join(blocks) + "\n").encode())
        without_reasoning_effort = [
            line for line in blocks if line != "    reasoningEffort: low"
        ]
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(
                ("\n".join(without_reasoning_effort) + "\n").encode()
            )
        high_reasoning_effort = [
            "    reasoningEffort: high"
            if line == "    reasoningEffort: low"
            else line
            for line in blocks
        ]
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(
                ("\n".join(high_reasoning_effort) + "\n").encode()
            )
        without_thinking = [
            line for line in blocks if line != "    thinking: enabled"
        ]
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(("\n".join(without_thinking) + "\n").encode())
        disabled_thinking = [
            "    thinking: disabled" if line == "    thinking: enabled" else line
            for line in blocks
        ]
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(("\n".join(disabled_thinking) + "\n").encode())
        without_retry_parent = [line for line in blocks if line != "    retryPolicy:"]
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(("\n".join(without_retry_parent) + "\n").encode())
        blocks.append("- id: untrusted-extra")
        with self.assertRaises(MODULE.RunnerError):
            MODULE.validate_dump(("\n".join(blocks) + "\n").encode())


if __name__ == "__main__":
    unittest.main(verbosity=2)
