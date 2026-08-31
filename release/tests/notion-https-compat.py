#!/usr/bin/env python3
"""Tests for the create-only Notion HTTPS transport compatibility shim."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


COMPAT_ROOT = Path(__file__).resolve().parents[1] / "scripts/notion-https-compat"
PROBE = r"""
import http.client
import json

notion = http.client.HTTPConnection("api.notion.com", 443, timeout=3)
other = http.client.HTTPConnection("example.invalid", 80, timeout=3)
print(json.dumps({
    "notion": type(notion).__name__,
    "notionTls": isinstance(notion, http.client.HTTPSConnection),
    "other": type(other).__name__,
    "otherTls": isinstance(other, http.client.HTTPSConnection),
}, sort_keys=True))
"""


class NotionHttpsCompatTests(unittest.TestCase):
    def run_probe(self, api_base: str) -> dict[str, object]:
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(COMPAT_ROOT),
            "NOTION_API_BASE": api_base,
        }
        completed = subprocess.run(
            [sys.executable, "-B", "-c", PROBE],
            env=environment,
            capture_output=True,
            check=False,
            timeout=30,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual(b"", completed.stderr)
        return json.loads(completed.stdout)

    def test_exact_production_endpoint_upgrades_only_notion_to_tls(self) -> None:
        result = self.run_probe("https://api.notion.com/v1")
        self.assertEqual(
            {
                "notion": "HTTPSConnection",
                "notionTls": True,
                "other": "HTTPConnection",
                "otherTls": False,
            },
            result,
        )

    def test_nonproduction_endpoint_does_not_patch_http_client(self) -> None:
        result = self.run_probe("http://fake-notion:8081/v1")
        self.assertEqual(
            {
                "notion": "HTTPConnection",
                "notionTls": False,
                "other": "HTTPConnection",
                "otherTls": False,
            },
            result,
        )


if __name__ == "__main__":
    unittest.main()
