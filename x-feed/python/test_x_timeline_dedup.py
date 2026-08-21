#!/usr/bin/env python3
"""x_timeline_dedup.py tests.

Run from this directory with:
    python3 -m unittest test_x_timeline_dedup -v
"""
import contextlib
import copy
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_timeline_dedup as dedup


class TestIdentity(unittest.TestCase):
    def test_status_id_strips_analytics_and_query(self):
        self.assertEqual(dedup.status_id("123/analytics"), "123")
        self.assertEqual(
            dedup.status_id("https://x.com/user/status/123/analytics?x=1"),
            "123",
        )

    def test_canonical_url_removes_analytics(self):
        self.assertEqual(
            dedup.canonical_url("https://x.com/user/status/123/analytics"),
            "https://x.com/user/status/123",
        )

    def test_deduplicate_records_rebuilds_canonical_status_url_for_status_suffixes(self):
        cases = [
            (
                "2090799874350735870/photo/1",
                "https://x.com/rahul/status/2090799874350735870/photo/1",
                "2090799874350735870",
                "https://x.com/rahul/status/2090799874350735870",
            ),
            (
                "123/photo/2",
                "https://x.com/user/status/123/photo/2",
                "123",
                "https://x.com/user/status/123",
            ),
            (
                "456/video/1",
                "https://x.com/user/status/456/video/1",
                "456",
                "https://x.com/user/status/456",
            ),
            (
                "789/history",
                "https://x.com/user/status/789/history",
                "789",
                "https://x.com/user/status/789",
            ),
            (
                "987/analytics",
                "https://twitter.com/user/status/987/analytics?ref=timeline#top",
                "987",
                "https://x.com/user/status/987",
            ),
        ]
        for raw_id, raw_url, expected_id, expected_url in cases:
            with self.subTest(raw_url=raw_url):
                records = [{"id": raw_id, "url": raw_url, "text": "candidate"}]
                original = copy.deepcopy(records)
                unique, report = dedup.deduplicate_records(records)
                self.assertEqual(report["unique_records"], 1)
                self.assertEqual(unique[0]["id"], expected_id)
                self.assertEqual(unique[0]["url"], expected_url)
                self.assertEqual(records, original)

    def test_non_status_urls_keep_existing_fallback_normalization(self):
        records = [{"id": "opaque", "url": "https://x.com/user/post?ref=timeline#top", "text": "candidate"}]
        original = copy.deepcopy(records)
        unique, _ = dedup.deduplicate_records(records)
        self.assertEqual(unique[0]["url"], "https://x.com/user/post")
        self.assertEqual(records, original)


class TestDedupe(unittest.TestCase):
    def test_dedupes_numeric_id_and_merges_best_fields(self):
        records = [
            {
                "id": "123/analytics",
                "url": "https://x.com/user/status/123/analytics",
                "text": "short",
                "time": "",
                "user": "user",
                "media": ["m1"],
            },
            {
                "id": "123",
                "url": "https://x.com/user/status/123",
                "text": "the complete text of the tweet",
                "time": "2026-08-13T00:00:00.000Z",
                "media": ["m2"],
            },
            {
                "id": "456",
                "url": "https://x.com/other/status/456",
                "text": "another tweet",
            },
        ]

        unique, report = dedup.deduplicate_records(records)

        self.assertEqual(len(unique), 2)
        self.assertEqual(report["duplicate_groups"], 1)
        self.assertEqual(report["duplicates_removed"], 1)
        merged = unique[0]
        self.assertEqual(merged["id"], "123")
        self.assertEqual(merged["url"], "https://x.com/user/status/123")
        self.assertEqual(merged["text"], "the complete text of the tweet")
        self.assertEqual(merged["time"], "2026-08-13T00:00:00.000Z")
        self.assertEqual(merged["media"], ["m1", "m2"])
        self.assertEqual(merged["user"], "user")

    def test_falls_back_to_canonical_url_without_numeric_id(self):
        records = [
            {"id": "a", "url": "https://twitter.com/u/post?x=1", "text": "one"},
            {"id": "b", "url": "https://x.com/u/post", "text": "two"},
        ]
        unique, report = dedup.deduplicate_records(records)
        self.assertEqual(len(unique), 1)
        self.assertEqual(report["duplicates_removed"], 1)


class TestReadAndApply(unittest.TestCase):
    def test_reports_malformed_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "timeline.jsonl"
            path.write_text(
                '{"id":"1","url":"https://x.com/u/status/1","text":"ok"}\n'
                '{"id":"broken"\n'
                '[]\n'
                '{"id":"2","url":"https://x.com/u/status/2","text":"ok2"}\n',
                encoding="utf-8",
            )
            records, invalid = dedup.read_jsonl(path)
            self.assertEqual([item["line"] for item in invalid], [2, 3])
            self.assertEqual([item["reason"] for item in invalid], [
                "invalid_json",
                "not_an_object",
            ])
            self.assertEqual(len(records), 2)

    def test_dry_run_does_not_modify_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "timeline.jsonl"
            original = (
                '{"id":"1","url":"https://x.com/u/status/1","text":"ok"}\n'
                '{"id":"1/analytics","url":"https://x.com/u/status/1/analytics",'
                '"text":"complete text"}\n'
            )
            path.write_text(original, encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = dedup.main(["--input", str(path)])
            self.assertEqual(code, 0)
            self.assertEqual(path.read_text(encoding="utf-8"), original)
            self.assertFalse(list(path.parent.glob("timeline.jsonl.bak-*")))
            summary = json.loads(out.getvalue())
            self.assertEqual(summary["mode"], "dry-run")
            self.assertEqual(summary["duplicates_removed"], 1)

    def test_apply_creates_backup_and_quarantines_invalid_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "timeline.jsonl"
            path.write_text(
                '{"id":"1","url":"https://x.com/u/status/1","text":"short"}\n'
                '{"id":"1/analytics","url":"https://x.com/u/status/1/analytics",'
                '"text":"complete text"}\n'
                '{"id":"broken"\n',
                encoding="utf-8",
            )
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = dedup.main(["--input", str(path), "--apply"])
            self.assertEqual(code, 0)
            summary = json.loads(out.getvalue())
            self.assertEqual(summary["mode"], "apply")
            self.assertEqual(summary["duplicates_removed"], 1)
            self.assertEqual(len(list(path.parent.glob("timeline.jsonl.bak-*"))), 1)
            self.assertEqual(len(list(path.parent.glob("timeline.jsonl.invalid-*"))), 1)
            output_lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(output_lines), 1)
            result = json.loads(output_lines[0])
            self.assertEqual(result["id"], "1")
            self.assertEqual(result["text"], "complete text")


if __name__ == "__main__":
    unittest.main()
