#!/usr/bin/env python3
"""Isolated tests for the remote Notion credential installer."""

from __future__ import annotations

import fcntl
import hashlib
import http.server
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path


RELEASE_ROOT = Path(__file__).resolve().parents[1]
HELPER = RELEASE_ROOT / "scripts/notion-credential-remote.py"
CLI = RELEASE_ROOT / "cli.mjs"
WRAPPER = RELEASE_ROOT / "dsh"
MARKDOWN_BODY = "# private fixture body\n\n- first task\n"
IMAGE_ID = "sha256:" + "a" * 64
PAGE_RESPONSE = json.dumps(
    {
        "id": "fixture-page",
        "markdown": MARKDOWN_BODY,
        "truncated": False,
        "unknown_block_ids": [],
    },
    separators=(",", ":"),
).encode()


def run_fake_docker() -> int:
    """Serve the Docker inspect fixture from this executable test file.

    Runtime self-tests deliberately mount /tmp with noexec.  Reusing this
    already-installed executable keeps the fixture honest in both the image
    build and the immutable runtime gate without weakening that mount.
    """

    state_path = Path.cwd() / "fake-docker-state.json"
    log_path = Path.cwd() / "fake-docker.log"
    arguments = sys.argv[1:]
    try:
        state = json.loads(state_path.read_text())
        with log_path.open("a", encoding="utf-8") as log:
            log.write(json.dumps(arguments, separators=(",", ":")) + "\n")
    except (OSError, json.JSONDecodeError):
        return 2

    if arguments[:2] == ["image", "inspect"]:
        if not state.get("imageAvailable", False):
            return 2
        print(json.dumps([{"Id": state["imageId"]}]))
        return 0
    if arguments[:2] == ["container", "inspect"] and len(arguments) == 3:
        container = state.get("containers", {}).get(arguments[2])
        if container is None:
            return 2
        print(json.dumps([container]))
        return 0
    return 2


class FakeNotionHandler(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, object]] = []
    stage_directory: Path | None = None
    boundary_callback = None
    after_request: Callable[[], None] | None = None

    def do_GET(self) -> None:  # noqa: N802
        staged = (
            sorted(type(self).stage_directory.glob(".notion.token.*"))
            if type(self).stage_directory is not None
            else []
        )
        type(self).requests.append(
            {
                "method": "GET",
                "path": self.path,
                "authorization": self.headers.get("Authorization", ""),
                "notionVersion": self.headers.get("Notion-Version", ""),
                "stagedCount": len(staged),
                "stagedMode": stat.S_IMODE(staged[0].stat().st_mode) if staged else None,
                "stagedUid": staged[0].stat().st_uid if staged else None,
                "stagedGid": staged[0].stat().st_gid if staged else None,
            }
        )
        if type(self).boundary_callback is not None:
            callback = type(self).boundary_callback
            type(self).boundary_callback = None
            callback()
        callback = type(self).after_request
        type(self).after_request = None
        if callback is not None:
            callback()
        if self.path.endswith("/unauthorized/markdown"):
            body = b'{"object":"error","status":401}'
            self.send_response(401)
        else:
            value = json.loads(PAGE_RESPONSE)
            if self.path.endswith("/truncated/markdown"):
                value["truncated"] = True
            if self.path.endswith("/unknown-blocks/markdown"):
                value["unknown_block_ids"] = ["fixture-unknown-block"]
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class FakeNotionServer:
    def __enter__(self) -> "FakeNotionServer":
        FakeNotionHandler.requests = []
        FakeNotionHandler.boundary_callback = None
        FakeNotionHandler.after_request = None
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeNotionHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def api_base(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"


class NotionCredentialRemoteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        (self.root / ".dsh").mkdir()
        self.target = self.root / ".dsh/secrets/notion.token"
        self.state_root = self.root / "state"
        release = self.state_root / "releases/accepted-fixture"
        release.mkdir(parents=True)
        (self.state_root / "locks").mkdir()
        production = {
            "engineImageId": IMAGE_ID,
            "web": "true/0",
            "telegram": "true/0",
            "lan": "true/0",
            "prepare": "exited/0",
        }
        (release / "release.json").write_text(json.dumps({
            "status": "accepted",
            "releaseId": "accepted-fixture",
            "candidate": {},
            "production": production,
        }))
        os.symlink("releases/accepted-fixture", self.state_root / "current")
        os.symlink("releases/accepted-fixture", self.state_root / "last-good")
        self.docker_state = self.root / "fake-docker-state.json"
        self.docker_log = self.root / "fake-docker.log"
        self.write_docker_state()
        self.docker = Path(__file__).resolve()

    def tearDown(self) -> None:
        FakeNotionHandler.after_request = None
        self.tempdir.cleanup()

    def write_docker_state(
        self,
        *,
        image_id: str = IMAGE_ID,
        image_available: bool = True,
        stopped: set[str] | None = None,
    ) -> None:
        stopped = stopped or set()
        containers: dict[str, object] = {}
        for name in ("dsh-web", "dsh-telegram", "dsh-lan-proxy", "dsh-prepare"):
            running = name != "dsh-prepare" and name not in stopped
            status = "running" if running else "exited"
            containers[name] = {
                "Image": image_id,
                "RestartCount": 0,
                "State": {
                    "Running": running,
                    "Status": status,
                    "ExitCode": 0,
                },
            }
        temporary = self.docker_state.with_suffix(".new")
        temporary.write_text(json.dumps({
            "imageId": image_id,
            "imageAvailable": image_available,
            "containers": containers,
        }))
        os.replace(temporary, self.docker_state)

    def install_fixture_token(self, token: bytes) -> int:
        self.target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.target.parent.chmod(0o700)
        self.target.write_bytes(token)
        self.target.chmod(0o600)
        return self.target.stat().st_ino

    def helper_command(
        self,
        api_base: str,
        *,
        page_id: str = "fixture-page",
        replace: bool = False,
        extra_args: list[str] | None = None,
    ) -> list[str]:
        command = [
            sys.executable,
            str(HELPER),
            "--target",
            str(self.target),
            "--api-base",
            api_base,
            "--page-id",
            page_id,
            "--owner-uid",
            str(os.getuid()),
            "--owner-gid",
            str(os.getgid()),
            "--state-root",
            str(self.state_root),
            "--docker",
            str(self.docker),
        ]
        if replace:
            command.append("--replace")
        if extra_args:
            command.extend(extra_args)
        return command

    def run_helper(
        self,
        api_base: str,
        token: bytes,
        *,
        page_id: str = "fixture-page",
        replace: bool = False,
        extra_args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        FakeNotionHandler.stage_directory = self.target.parent
        return subprocess.run(
            self.helper_command(
                api_base,
                page_id=page_id,
                replace=replace,
                extra_args=extra_args,
            ),
            input=token,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=env,
            cwd=self.root,
        )

    def assert_no_secret_output(
        self,
        result: subprocess.CompletedProcess[bytes],
        *secrets: bytes,
    ) -> None:
        output = result.stdout + result.stderr
        for secret in secrets:
            self.assertNotIn(secret, output)
        self.assertNotIn(b"Authorization", output)
        self.assertNotIn(b"Bearer", output)
        self.assertNotIn(PAGE_RESPONSE, output)
        self.assertNotIn(MARKDOWN_BODY.encode(), output)
        self.assertNotIn(b"private fixture body", output)
        self.assertNotIn(b"fixture-unknown-block", output)

    def assert_no_temporary_credentials(self) -> None:
        if not self.target.parent.exists():
            return
        self.assertEqual(
            [],
            sorted(self.target.parent.glob(".notion.token.*")),
            "staged credential was not removed",
        )

    def test_first_install_is_get_only_atomic_and_strictly_private(self) -> None:
        token = b"fixture-first-token"
        with FakeNotionServer() as fake:
            result = self.run_helper(fake.api_base, token + b"\n")

        self.assertEqual(0, result.returncode, result.stderr.decode())
        self.assertEqual(token, self.target.read_bytes())
        self.assertEqual(0o700, stat.S_IMODE(self.target.parent.stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE(self.target.stat().st_mode))
        self.assertEqual(os.getuid(), self.target.stat().st_uid)
        self.assertEqual(os.getgid(), self.target.stat().st_gid)
        self.assertEqual(
            [
                {
                    "method": "GET",
                    "path": "/v1/pages/fixture-page/markdown",
                    "authorization": "Bearer fixture-first-token",
                    "notionVersion": "2026-03-11",
                    "stagedCount": 1,
                    "stagedMode": 0o600,
                    "stagedUid": os.getuid(),
                    "stagedGid": os.getgid(),
                }
            ],
            FakeNotionHandler.requests,
        )

        receipt = json.loads(result.stdout)
        self.assertEqual(
            {
                "bodyLength",
                "bodySha256",
                "pageReadable",
                "permissions",
                "target",
                "time",
            },
            set(receipt),
        )
        self.assertEqual(str(self.target), receipt["target"])
        self.assertTrue(receipt["pageReadable"])
        markdown_bytes = MARKDOWN_BODY.encode()
        self.assertEqual(len(markdown_bytes), receipt["bodyLength"])
        self.assertEqual(hashlib.sha256(markdown_bytes).hexdigest(), receipt["bodySha256"])
        self.assertEqual(
            {
                "directory": "0700",
                "file": "0600",
                "ownerUid": os.getuid(),
                "ownerGid": os.getgid(),
            },
            receipt["permissions"],
        )
        self.assert_no_secret_output(result, token)
        self.assert_no_temporary_credentials()

    def test_same_token_is_idempotent_but_revalidates_page(self) -> None:
        token = b"fixture-same-token"
        with FakeNotionServer() as fake:
            first = self.run_helper(fake.api_base, token)
            inode = self.target.stat().st_ino
            second = self.run_helper(fake.api_base, token)

        self.assertEqual(0, first.returncode, first.stderr.decode())
        self.assertEqual(0, second.returncode, second.stderr.decode())
        self.assertEqual(inode, self.target.stat().st_ino)
        self.assertEqual(token, self.target.read_bytes())
        self.assertEqual(2, len(FakeNotionHandler.requests))
        self.assertTrue(all(item["method"] == "GET" for item in FakeNotionHandler.requests))
        self.assert_no_secret_output(first, token)
        self.assert_no_secret_output(second, token)
        self.assert_no_temporary_credentials()

    def test_different_token_requires_replace_without_contacting_notion(self) -> None:
        old_token = b"fixture-old-token"
        new_token = b"fixture-new-token"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)
            FakeNotionHandler.requests = []
            refused = self.run_helper(fake.api_base, new_token)

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(4, refused.returncode)
        self.assertEqual(old_token, self.target.read_bytes())
        self.assertEqual([], FakeNotionHandler.requests)
        self.assert_no_secret_output(refused, old_token, new_token)
        self.assert_no_temporary_credentials()

    def test_explicit_replace_validates_then_atomically_installs(self) -> None:
        old_token = b"fixture-replace-old"
        new_token = b"fixture-replace-new"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)
            old_inode = self.target.stat().st_ino
            FakeNotionHandler.requests = []
            replaced = self.run_helper(fake.api_base, new_token, replace=True)

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(0, replaced.returncode, replaced.stderr.decode())
        self.assertEqual(new_token, self.target.read_bytes())
        self.assertNotEqual(old_inode, self.target.stat().st_ino)
        self.assertEqual(1, len(FakeNotionHandler.requests))
        self.assertEqual("GET", FakeNotionHandler.requests[0]["method"])
        self.assert_no_secret_output(replaced, old_token, new_token)
        self.assert_no_temporary_credentials()

    def test_http_401_deletes_stage_and_preserves_old_credential(self) -> None:
        old_token = b"fixture-401-old"
        rejected_token = b"fixture-401-new"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)
            rejected = self.run_helper(
                fake.api_base,
                rejected_token,
                page_id="unauthorized",
                replace=True,
            )

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(4, rejected.returncode)
        self.assertEqual(b"", rejected.stdout)
        self.assertIn(b"HTTP 401", rejected.stderr)
        self.assertEqual(old_token, self.target.read_bytes())
        self.assert_no_secret_output(rejected, old_token, rejected_token)
        self.assert_no_temporary_credentials()

    def test_network_failure_deletes_stage_and_preserves_old_credential(self) -> None:
        old_token = b"fixture-network-old"
        new_token = b"fixture-network-new"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)

        unused = socket.socket()
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
        unused.close()
        failed = self.run_helper(
            f"http://127.0.0.1:{port}/v1",
            new_token,
            replace=True,
        )

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(4, failed.returncode)
        self.assertEqual(b"", failed.stdout)
        self.assertIn(b"network", failed.stderr)
        self.assertEqual(old_token, self.target.read_bytes())
        self.assert_no_secret_output(failed, old_token, new_token)
        self.assert_no_temporary_credentials()

    def test_truncated_markdown_deletes_stage_and_preserves_old_credential(self) -> None:
        old_token = b"fixture-truncated-old"
        new_token = b"fixture-truncated-new"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)
            failed = self.run_helper(
                fake.api_base,
                new_token,
                page_id="truncated",
                replace=True,
            )

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(4, failed.returncode)
        self.assertEqual(b"", failed.stdout)
        self.assertIn(b"incomplete content", failed.stderr)
        self.assertEqual(old_token, self.target.read_bytes())
        self.assert_no_secret_output(failed, old_token, new_token)
        self.assert_no_temporary_credentials()

    def test_unknown_blocks_delete_stage_and_preserve_old_credential(self) -> None:
        old_token = b"fixture-unknown-old"
        new_token = b"fixture-unknown-new"
        with FakeNotionServer() as fake:
            installed = self.run_helper(fake.api_base, old_token)
            failed = self.run_helper(
                fake.api_base,
                new_token,
                page_id="unknown-blocks",
                replace=True,
            )

        self.assertEqual(0, installed.returncode, installed.stderr.decode())
        self.assertEqual(4, failed.returncode)
        self.assertEqual(b"", failed.stdout)
        self.assertIn(b"incomplete content", failed.stderr)
        self.assertEqual(old_token, self.target.read_bytes())
        self.assert_no_secret_output(failed, old_token, new_token)
        self.assert_no_temporary_credentials()

    def test_token_cannot_be_supplied_by_argv_or_environment(self) -> None:
        argv_token = b"fixture-argv-secret"
        env_token = b"fixture-env-secret"
        with FakeNotionServer() as fake:
            argv_result = self.run_helper(
                fake.api_base,
                b"",
                extra_args=["--token", argv_token.decode()],
            )
            environment = os.environ.copy()
            environment["NOTION_TOKEN"] = env_token.decode()
            env_result = self.run_helper(fake.api_base, b"", env=environment)

        self.assertEqual(2, argv_result.returncode)
        self.assertEqual(2, env_result.returncode)
        self.assertFalse(self.target.exists())
        self.assert_no_secret_output(argv_result, argv_token)
        self.assert_no_secret_output(env_result, env_token)
        self.assertEqual([], FakeNotionHandler.requests)
        self.assert_no_temporary_credentials()

    def test_nonaccepted_production_boundary_rejects_before_token_or_api(self) -> None:
        release_path = self.state_root / "releases/accepted-fixture/release.json"
        value = json.loads(release_path.read_text())
        value["status"] = "awaiting-user-acceptance"
        release_path.write_text(json.dumps(value))
        token = b"fixture-boundary-token"
        with FakeNotionServer() as fake:
            result = self.run_helper(fake.api_base, token)
        self.assertEqual(4, result.returncode)
        self.assertEqual([], FakeNotionHandler.requests)
        self.assertFalse(self.target.exists())
        self.assert_no_secret_output(result, token)

    def test_boundary_is_rechecked_after_api_before_atomic_install(self) -> None:
        release_path = self.state_root / "releases/accepted-fixture/release.json"

        def cross_release_boundary() -> None:
            value = json.loads(release_path.read_text())
            value["status"] = "waiting-for-release-authorization"
            release_path.write_text(json.dumps(value))

        FakeNotionHandler.boundary_callback = cross_release_boundary
        token = b"fixture-recheck-token"
        with FakeNotionServer() as fake:
            # FakeNotionServer resets callbacks; arm it only after entry.
            FakeNotionHandler.boundary_callback = cross_release_boundary
            result = self.run_helper(fake.api_base, token)
        self.assertEqual(4, result.returncode)
        self.assertEqual(1, len(FakeNotionHandler.requests))
        self.assertFalse(self.target.exists())
        self.assert_no_temporary_credentials()
        self.assert_no_secret_output(result, token)

    def test_cli_uses_commit_bound_helper_checker_and_public_config(self) -> None:
        source = CLI.read_text()
        self.assertIn("productionNotionConfig(credentialReleaseCommit)", source)
        self.assertIn(
            "'release/scripts/notion-credential-remote.py'", source
        )
        self.assertIn("productionNotionConfig(candidate.releaseToolCommit)", source)
        self.assertIn("'release/scripts/check-notion-page.py'", source)
        self.assertIn("'release/notion.production.json'", source)
        guard = source.index("Notion production credential 只获准在 herman.hermes 安装")
        self.assertLess(guard, source.index("生产 credential 编排", guard))
        self.assertLess(guard, source.index("readFileSync(0)", guard))

    def test_cli_preview_binds_actual_host_and_wrong_host_approval_is_local(self) -> None:
        environment = os.environ.copy()
        environment["DSH_RELEASE_STATE_ROOT"] = str(self.state_root)
        preview = subprocess.run(
            [str(WRAPPER), "credential", "notion"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=environment,
        )
        self.assertEqual(3, preview.returncode)
        self.assertEqual(
            "herman.hermes:/home/herman/.dsh/secrets/notion.token",
            json.loads(preview.stdout)["target"],
        )

        marker = self.root / "ssh-called"
        fake_bin = self.root / "command-bin"
        fake_bin.mkdir()
        ssh = fake_bin / "ssh"
        ssh.write_text(f"#!/bin/sh\n: > {marker}\nexit 97\n")
        ssh.chmod(0o700)
        environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
        environment["DSH_DEPLOY_TARGET"] = "unexpected.invalid"
        wrong_preview = subprocess.run(
            [str(WRAPPER), "credential", "notion"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=environment,
        )
        self.assertEqual(3, wrong_preview.returncode)
        self.assertEqual(
            "unexpected.invalid:/home/herman/.dsh/secrets/notion.token",
            json.loads(wrong_preview.stdout)["target"],
        )
        approved = subprocess.run(
            [str(WRAPPER), "credential", "notion", "--stdin", "--approved"],
            input=b"synthetic-command-token",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=environment,
        )
        self.assertEqual(4, approved.returncode)
        self.assertFalse(marker.exists())
        self.assert_no_secret_output(approved, b"synthetic-command-token")

    def test_cli_rejects_inline_token_without_echoing_it(self) -> None:
        secret = b"synthetic-inline-argv-secret"
        environment = os.environ.copy()
        environment["DSH_RELEASE_STATE_ROOT"] = str(self.state_root)
        result = subprocess.run(
            [str(WRAPPER), "credential", "notion", f"--token={secret.decode()}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=environment,
        )
        self.assertEqual(2, result.returncode)
        self.assert_no_secret_output(result, secret)


if __name__ == "__main__":
    if sys.argv[1:2] in (["image"], ["container"]):
        raise SystemExit(run_fake_docker())
    unittest.main(verbosity=2)
