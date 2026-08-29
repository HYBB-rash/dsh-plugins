#!/usr/bin/env python3
"""Isolated tests for the read-only Notion page release gate."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path


RELEASE_ROOT = Path(__file__).resolve().parents[1]
CHECKER = RELEASE_ROOT / "scripts/check-notion-page.py"
MARKDOWN_BODY = "# private checker fixture\n\n- local-only task\n"
UNKNOWN_BLOCK_ID = "fixture-private-unknown-block"


class FakeNotionHandler(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, str]] = []

    def do_GET(self) -> None:  # noqa: N802
        type(self).requests.append(
            {
                "method": "GET",
                "path": self.path,
                "authorization": self.headers.get("Authorization", ""),
                "notionVersion": self.headers.get("Notion-Version", ""),
            }
        )
        page_id = self.path.removesuffix("/markdown").rsplit("/", 1)[-1]
        if page_id == "unauthorized":
            response = {"object": "error", "status": 401}
            status = 401
        else:
            response = {
                "id": page_id,
                "markdown": MARKDOWN_BODY,
                "truncated": page_id == "truncated",
                "unknown_block_ids": (
                    [UNKNOWN_BLOCK_ID] if page_id == "unknown-blocks" else []
                ),
            }
            status = 200
        body = json.dumps(response, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class FakeNotionServer:
    def __enter__(self) -> "FakeNotionServer":
        FakeNotionHandler.requests = []
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


class NotionPageCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.secret_directory = self.root / ".dsh/secrets"
        self.secret_directory.mkdir(parents=True, mode=0o700)
        self.credential = self.secret_directory / "notion.token"
        self.token = b"fixture-checker-token"
        self.credential.write_bytes(self.token)
        self.credential.chmod(0o600)
        self.config = self.root / "notion.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_config(
        self,
        api_base: str,
        *,
        page_id: str = "fixture-page",
        api_version: str = "2026-03-11",
    ) -> None:
        self.config.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "apiBase": api_base,
                    "apiVersion": api_version,
                    "pageId": page_id,
                    "credentialPath": str(self.credential),
                    "inboxPath": str(
                        self.root / ".dsh/storages/task-inbox/inbox.md"
                    ),
                }
            ),
            encoding="utf-8",
        )

    def run_checker(
        self, *, extra_args: list[str] | None = None
    ) -> subprocess.CompletedProcess[bytes]:
        command = [
            "python3",
            str(CHECKER),
            "--config",
            str(self.config),
            "--owner-uid",
            str(os.getuid()),
            "--owner-gid",
            str(os.getgid()),
        ]
        if extra_args:
            command.extend(extra_args)
        return subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def assert_no_secret_output(self, result: subprocess.CompletedProcess[bytes]) -> None:
        output = result.stdout + result.stderr
        for private_value in (
            self.token,
            MARKDOWN_BODY.encode(),
            b"private checker fixture",
            UNKNOWN_BLOCK_ID.encode(),
            b"Authorization",
            b"Bearer",
        ):
            self.assertNotIn(private_value, output)

    def test_read_only_get_returns_private_content_free_receipt(self) -> None:
        with FakeNotionServer() as fake:
            self.write_config(fake.api_base)
            before = self.credential.stat()
            result = self.run_checker()

        after = self.credential.stat()
        self.assertEqual(0, result.returncode, result.stderr.decode())
        self.assertEqual(self.token, self.credential.read_bytes())
        self.assertEqual(before.st_ino, after.st_ino)
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
        self.assertEqual(
            [
                {
                    "method": "GET",
                    "path": "/v1/pages/fixture-page/markdown",
                    "authorization": "Bearer fixture-checker-token",
                    "notionVersion": "2026-03-11",
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
        body = MARKDOWN_BODY.encode()
        self.assertEqual(len(body), receipt["bodyLength"])
        self.assertEqual(hashlib.sha256(body).hexdigest(), receipt["bodySha256"])
        self.assertEqual(str(self.credential), receipt["target"])
        self.assertTrue(receipt["pageReadable"])
        self.assertEqual(
            {
                "directory": "0700",
                "file": "0600",
                "ownerUid": os.getuid(),
                "ownerGid": os.getgid(),
            },
            receipt["permissions"],
        )
        self.assert_no_secret_output(result)

    def assert_incomplete_response_is_rejected(self, page_id: str) -> None:
        with FakeNotionServer() as fake:
            self.write_config(fake.api_base, page_id=page_id)
            before = self.credential.stat()
            result = self.run_checker()

        after = self.credential.stat()
        self.assertEqual(4, result.returncode)
        self.assertEqual(b"", result.stdout)
        self.assertIn(b"incomplete content", result.stderr)
        self.assertEqual(self.token, self.credential.read_bytes())
        self.assertEqual(before.st_ino, after.st_ino)
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
        self.assert_no_secret_output(result)

    def test_truncated_markdown_is_rejected(self) -> None:
        self.assert_incomplete_response_is_rejected("truncated")

    def test_unknown_blocks_are_rejected(self) -> None:
        self.assert_incomplete_response_is_rejected("unknown-blocks")

    def test_401_is_redacted_and_does_not_touch_credential(self) -> None:
        with FakeNotionServer() as fake:
            self.write_config(fake.api_base, page_id="unauthorized")
            before = self.credential.stat()
            result = self.run_checker()

        after = self.credential.stat()
        self.assertEqual(4, result.returncode)
        self.assertEqual(b"", result.stdout)
        self.assertIn(b"HTTP 401", result.stderr)
        self.assertEqual(self.token, self.credential.read_bytes())
        self.assertEqual(before.st_ino, after.st_ino)
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
        self.assert_no_secret_output(result)

    def test_credential_modes_are_fail_closed_before_network(self) -> None:
        with FakeNotionServer() as fake:
            self.write_config(fake.api_base)

            self.credential.chmod(0o640)
            bad_file = self.run_checker()
            self.credential.chmod(0o600)

            self.secret_directory.chmod(0o750)
            bad_directory = self.run_checker()
            self.secret_directory.chmod(0o700)

        self.assertEqual(4, bad_file.returncode)
        self.assertEqual(4, bad_directory.returncode)
        self.assertEqual([], FakeNotionHandler.requests)
        self.assertEqual(self.token, self.credential.read_bytes())
        self.assert_no_secret_output(bad_file)
        self.assert_no_secret_output(bad_directory)

    def test_api_version_drift_is_rejected_before_network(self) -> None:
        with FakeNotionServer() as fake:
            self.write_config(fake.api_base, api_version="2025-09-03")
            result = self.run_checker()

        self.assertEqual(4, result.returncode)
        self.assertEqual([], FakeNotionHandler.requests)
        self.assertEqual(self.token, self.credential.read_bytes())
        self.assert_no_secret_output(result)

    def test_invalid_argv_does_not_echo_possible_secret(self) -> None:
        possible_secret = "fixture-argv-secret"
        result = self.run_checker(extra_args=["--token", possible_secret])

        self.assertEqual(2, result.returncode)
        self.assertNotIn(possible_secret.encode(), result.stdout + result.stderr)
        self.assertEqual(self.token, self.credential.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
