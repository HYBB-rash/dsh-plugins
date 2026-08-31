#!/usr/bin/env python3
"""Contract tests for the local Notion inbox automation implementation.

Mirrors release/scripts/harness-notion-automation-task.md's twelve-method
contract.  Each method owns its own loopback fake server and its own sandbox
directory; the harness reruns each method in its own fresh process.
"""

from __future__ import annotations

import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

FAKE_TOKEN = b"dsh-contract-probe-fake-token-never-production"
PAGE_ID = "f00df00df00df00df00df00df00df00d"
REMOTE_INITIAL = "# Synthetic inbox\n\n- [ ] probe item alpha\n"
LOCAL_EDIT = "# Synthetic inbox\n\n- [x] probe item local edit\n"
REMOTE_EDIT = "# Synthetic inbox\n\n- [ ] probe item remote edit\n"
SET_EDIT = "# Synthetic inbox\n\n- [ ] probe item set replacement\n"
FORCE_SET_EDIT = "# Synthetic inbox\n\n- [ ] probe item force set replacement\n"

ENTRYPOINT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "notion_inbox_sync.py")
)
ENTRYPOINT_SPEC = importlib.util.spec_from_file_location("notion_inbox_sync", ENTRYPOINT)
assert ENTRYPOINT_SPEC is not None and ENTRYPOINT_SPEC.loader is not None
ENTRYPOINT_MODULE = importlib.util.module_from_spec(ENTRYPOINT_SPEC)
ENTRYPOINT_SPEC.loader.exec_module(ENTRYPOINT_MODULE)


class FakeRecord:
    def __init__(self, method: str, path: str, valid: bool, body: bytes = b"") -> None:
        self.method = method
        self.path = path
        self.valid = valid
        self.body = body


class FakeNotion:
    def __init__(self, body: str = REMOTE_INITIAL) -> None:
        self.body = body
        self.records: list[FakeRecord] = []
        self.fail_get = False
        self.fail_patch = False

    def counts(self) -> tuple[int, int]:
        gets = sum(1 for record in self.records if record.method == "GET")
        patches = sum(1 for record in self.records if record.method == "PATCH")
        return gets, patches


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "fake-notion-local"
    sys_version = ""

    @property
    def state(self) -> FakeNotion:
        return self.server.probe_state  # type: ignore[attr-defined,no-any-return]

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _reply(self, code: int, value: object) -> None:
        raw = json.dumps(value).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def _valid(self) -> bool:
        return (
            self.path == f"/v1/pages/{PAGE_ID}/markdown"
            and self.headers.get("Authorization") == "Bearer " + FAKE_TOKEN.decode("ascii")
            and self.headers.get("Notion-Version") == "2026-03-11"
        )

    def do_GET(self) -> None:  # noqa: N802
        valid = self._valid()
        self.state.records.append(FakeRecord("GET", self.path, valid))
        if not valid:
            self._reply(400, {"object": "error", "code": "invalid_request"})
        elif self.state.fail_get:
            self._reply(503, {"object": "error", "code": "unavailable"})
        else:
            self._reply(
                200,
                {
                    "object": "page_markdown",
                    "id": PAGE_ID,
                    "markdown": self.state.body,
                    "truncated": False,
                    "unknown_block_ids": [],
                },
            )

    def do_PATCH(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        valid = self._valid()
        try:
            parsed = json.loads(body)
            replacement = parsed["replace_content"]["new_str"]
            if not isinstance(replacement, str):
                valid = False
        except (UnicodeDecodeError, ValueError, KeyError, TypeError):
            valid = False
        self.state.records.append(FakeRecord("PATCH", self.path, valid, body))
        if not valid:
            self._reply(400, {"object": "error", "code": "invalid_request"})
        elif self.state.fail_patch:
            self._reply(503, {"object": "error", "code": "unavailable"})
        else:
            self.state.body = replacement
            self._reply(
                200,
                {
                    "object": "page_markdown",
                    "id": PAGE_ID,
                    "markdown": replacement,
                    "truncated": False,
                    "unknown_block_ids": [],
                },
            )


class Sandbox:
    def __init__(self, notion: FakeNotion) -> None:
        self.root = tempfile.mkdtemp(prefix="dsh-local-test-")
        self.token = os.path.join(self.root, "notion.token")
        with open(self.token, "wb") as handle:
            handle.write(FAKE_TOKEN)
        self.task_dir = os.path.join(self.root, "dsh-home", "storages", "task-inbox")
        os.makedirs(os.path.dirname(self.task_dir), mode=0o700, exist_ok=True)
        self.inbox = os.path.join(self.task_dir, "inbox.md")
        self.state = os.path.join(self.task_dir, "sync-state.json")
        self.fingerprint = os.path.join(self.task_dir, "notion-fingerprint.json")
        self.api_base = ""

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class NotionInboxSyncContractTests(unittest.TestCase):
    server = None
    thread = None
    notion: FakeNotion

    def setUp(self) -> None:
        self.notion = FakeNotion()
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.probe_state = self.notion  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.sandbox = Sandbox(self.notion)
        self.sandbox.api_base = f"http://{host}:{port}/v1"
        self.sandbox.token = os.path.join(self.sandbox.root, "notion.token")
        with open(self.sandbox.token, "wb") as handle:
            handle.write(FAKE_TOKEN)

    def tearDown(self) -> None:
        self.sandbox.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def env(self) -> dict[str, str]:
        return {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": self.sandbox.root,
            "LANG": "C.UTF-8",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": self.sandbox.root,
            "NOTION_TOKEN_FILE": self.sandbox.token,
            "NOTION_INBOX_FILE": self.sandbox.inbox,
            "NOTION_API_BASE": self.sandbox.api_base,
            "NOTION_PAGE_ID": PAGE_ID,
        }

    def run_cli(self, *arguments: str, stdin: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-I", "-S", "-B", ENTRYPOINT, *arguments],
            env=self.env(),
            cwd=self.sandbox.root,
            input=None if stdin is None else stdin.encode("utf-8"),
            capture_output=True,
            timeout=30,
        )

    def first_pull(self) -> subprocess.CompletedProcess:
        result = self.run_cli("--pull", "--json")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('{"status": "synced"}\n', result.stdout.decode())
        return result

    def read_mirror(self) -> str:
        with open(self.sandbox.inbox, "r", encoding="utf-8") as handle:
            return handle.read()

    def test_first_pull(self) -> None:
        calls: list[tuple[str, int]] = []

        class FakeResponse:
            status = 200

            @staticmethod
            def read(_limit: int) -> bytes:
                return b"{}"

        class FakeHTTPSConnection:
            def __init__(self, host: str, port: int, timeout: int) -> None:
                self.host = host
                self.port = port
                self.timeout = timeout

            def request(
                self,
                _method: str,
                _path: str,
                body: bytes | None,
                headers: dict[str, str],
            ) -> None:
                self.body = body
                self.headers = headers
                calls.append((self.host, self.port))

            @staticmethod
            def getresponse() -> FakeResponse:
                return FakeResponse()

            @staticmethod
            def close() -> None:
                return

        with mock.patch.object(
            ENTRYPOINT_MODULE.http.client,
            "HTTPSConnection",
            FakeHTTPSConnection,
        ), mock.patch.object(
            ENTRYPOINT_MODULE.http.client,
            "HTTPConnection",
            side_effect=AssertionError("https must not use HTTPConnection"),
        ):
            client = ENTRYPOINT_MODULE.NotionClient(
                "https://api.notion.com/v1", PAGE_ID, FAKE_TOKEN,
            )
            self.assertEqual(b"{}", client.request("GET"))
        self.assertEqual([("api.notion.com", 443)], calls)

        result = self.first_pull()
        self.assertEqual(0, result.returncode)
        self.assertEqual((1, 0), self.notion.counts())
        with open(self.sandbox.state, "r", encoding="utf-8") as handle:
            state = json.loads(handle.read())
        self.assertEqual({"journal": None, "pending": None}, state)

    def test_atomic_artifacts(self) -> None:
        self.first_pull()
        saved = {}
        for path in (self.sandbox.inbox, self.sandbox.state, self.sandbox.fingerprint):
            with open(path, "rb") as handle:
                saved[path] = handle.read()
        second = self.run_cli("--pull", "--json")
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertEqual('{"status": "synced"}\n', second.stdout.decode())
        for path, value in saved.items():
            with open(path, "rb") as handle:
                self.assertEqual(value, handle.read())
        self.assertEqual((2, 0), self.notion.counts())
        noop = self.run_cli("--retry-pending", "--json")
        self.assertEqual(0, noop.returncode)
        self.assertEqual(b"", noop.stdout)
        self.assertEqual(b"", noop.stderr)
        entries = os.listdir(self.sandbox.task_dir)
        self.assertEqual(sorted(entries), ["inbox.md", "notion-fingerprint.json", "sync-state.json"])

    def test_read(self) -> None:
        self.first_pull()
        self.notion.body = REMOTE_EDIT
        result = self.run_cli("--pull", "--json")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('{"status": "synced"}\n', result.stdout.decode())
        self.assertEqual(REMOTE_EDIT, self.read_mirror())
        self.assertEqual(self.notion.body, REMOTE_EDIT)

    def test_push(self) -> None:
        self.first_pull()
        with open(self.sandbox.inbox, "w", encoding="utf-8") as handle:
            handle.write(LOCAL_EDIT)
        result = self.run_cli("--push", "--json")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('{"status": "synced"}\n', result.stdout.decode())
        self.assertEqual(LOCAL_EDIT, self.notion.body)
        self.assertEqual(LOCAL_EDIT, self.read_mirror())

    def test_set(self) -> None:
        self.first_pull()
        result = self.run_cli("--set", "-", "--json", stdin=SET_EDIT)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('{"status": "synced"}\n', result.stdout.decode())
        self.assertEqual(SET_EDIT, self.notion.body)
        self.assertEqual(SET_EDIT, self.read_mirror())

    def test_conflict(self) -> None:
        self.first_pull()
        with open(self.sandbox.inbox, "w", encoding="utf-8") as handle:
            handle.write(LOCAL_EDIT)
        self.notion.body = REMOTE_EDIT
        result = self.run_cli("--push", "--json")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual('{"status": "conflict"}\n', result.stdout.decode())
        self.assertEqual(LOCAL_EDIT, self.read_mirror())
        self.assertEqual(REMOTE_EDIT, self.notion.body)
        self.assertEqual((2, 0), self.notion.counts())

    def test_force(self) -> None:
        self.first_pull()
        with open(self.sandbox.inbox, "w", encoding="utf-8") as handle:
            handle.write(LOCAL_EDIT)
        self.notion.body = REMOTE_EDIT
        forced = self.run_cli("--push", "--force", "--json")
        self.assertEqual(0, forced.returncode, forced.stderr)
        self.assertEqual('{"status": "synced"}\n', forced.stdout.decode())
        self.assertEqual(LOCAL_EDIT, self.notion.body)
        self.assertEqual(LOCAL_EDIT, self.read_mirror())

    def test_network_recovery(self) -> None:
        self.first_pull()
        with open(self.sandbox.inbox, "w", encoding="utf-8") as handle:
            handle.write(LOCAL_EDIT)
        self.notion.fail_patch = True
        queued = self.run_cli("--push", "--json")
        self.assertEqual(0, queued.returncode, queued.stderr)
        self.assertEqual('{"status": "queued"}\n', queued.stdout.decode())
        self.notion.fail_patch = False
        retry = self.run_cli("--retry-pending", "--json")
        self.assertEqual(0, retry.returncode, retry.stderr)
        self.assertEqual('{"status": "synced"}\n', retry.stdout.decode())
        self.assertEqual(LOCAL_EDIT, self.notion.body)
        self.assertEqual(LOCAL_EDIT, self.read_mirror())

    def test_pending_retry(self) -> None:
        self.first_pull()
        self.notion.fail_patch = True
        queued = self.run_cli("--set", "-", "--json", stdin=SET_EDIT)
        self.assertEqual(0, queued.returncode, queued.stderr)
        self.assertEqual('{"status": "queued"}\n', queued.stdout.decode())
        self.notion.fail_patch = False
        retry = self.run_cli("--retry-pending", "--json")
        self.assertEqual(0, retry.returncode, retry.stderr)
        self.assertEqual('{"status": "synced"}\n', retry.stdout.decode())
        self.assertEqual(SET_EDIT, self.notion.body)

    def test_no_pending_no_api(self) -> None:
        self.first_pull()
        unreadable = os.path.join(self.sandbox.root, "blocked")
        os.makedirs(unreadable, mode=0o700)
        with open(os.path.join(unreadable, "tok"), "wb") as handle:
            handle.write(FAKE_TOKEN)
        os.chmod(unreadable, 0o000)
        env = self.env()
        env["NOTION_TOKEN_FILE"] = os.path.join(unreadable, "tok")
        result = subprocess.run(
            [sys.executable, "-I", "-S", "-B", ENTRYPOINT, "--retry-pending", "--json"],
            env=env, cwd=self.sandbox.root, capture_output=True, timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(b"", result.stdout)
        self.assertEqual(b"", result.stderr)
        self.assertEqual((1, 0), self.notion.counts())

    def test_pull_failure_no_pending(self) -> None:
        self.notion.fail_get = True
        failed = self.run_cli("--pull", "--json")
        self.assertNotEqual(0, failed.returncode)
        self.assertEqual('{"status": "error"}\n', failed.stdout.decode())
        self.assertFalse(os.path.exists(os.path.join(self.sandbox.task_dir, "inbox.md")))
        result = self.run_cli("--retry-pending", "--json")
        self.assertEqual(0, result.returncode)
        self.assertEqual(b"", result.stdout)
        self.assertEqual(b"", result.stderr)

    def test_secret_redaction(self) -> None:
        self.first_pull()
        result = self.run_cli("--set", "-", "--json", stdin=SET_EDIT)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn(FAKE_TOKEN.decode("ascii"), result.stdout.decode())
        self.assertNotIn(FAKE_TOKEN.decode("ascii"), result.stderr.decode())
        self.assertNotIn(b"authorization", (result.stdout + result.stderr).lower())
        with open(self.sandbox.state, "rb") as handle:
            self.assertNotIn(FAKE_TOKEN, handle.read())
        with open(self.sandbox.fingerprint, "rb") as handle:
            self.assertNotIn(FAKE_TOKEN, handle.read())


if __name__ == "__main__":
    unittest.main()
