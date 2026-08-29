#!/usr/bin/env python3
"""Exercise the real relay's anonymous-stdin secret lifetime boundary."""

from __future__ import annotations

import os
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


RELEASE_ROOT = Path(__file__).resolve().parents[1]
BRIDGE = RELEASE_ROOT / "scripts/harness-notion-automation-bridge.mjs"


class HarnessNotionBridgeContracts(unittest.TestCase):
    def test_relay_lives_until_sentinel_eof_then_erases_and_exits(self) -> None:
        token = b"synthetic-deepseek-token-never-upstream"
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "DSH_RELAY_BIND_ADDRESS": "127.0.0.1",
        }
        process = subprocess.Popen(
            ["node", str(BRIDGE), "relay"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        assert process.stdin is not None
        try:
            process.stdin.write(token + b"\n")
            process.stdin.flush()
            deadline = time.monotonic() + 5
            while True:
                if process.poll() is not None:
                    self.fail("relay exited before its anonymous stdin sentinel closed")
                try:
                    request = urllib.request.Request("http://127.0.0.1:8080/healthz")
                    with urllib.request.urlopen(request, timeout=0.25) as response:
                        self.assertEqual(204, response.status)
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        self.fail("relay health endpoint did not become ready")
                    time.sleep(0.05)
            self.assertIsNone(process.poll())
            process.stdin.close()
            process.wait(timeout=8)
            stdout = process.stdout.read() if process.stdout is not None else b""
            stderr = process.stderr.read() if process.stderr is not None else b""
            self.assertEqual(0, process.returncode)
            self.assertNotIn(token, stdout + stderr)
            self.assertEqual(b"", stdout)
            self.assertEqual(b"", stderr)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        finally:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()
            if process.stderr is not None and not process.stderr.closed:
                process.stderr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
