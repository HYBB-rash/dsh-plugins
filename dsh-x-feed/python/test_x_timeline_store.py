#!/usr/bin/env python3
"""Tests for the locked X timeline JSONL append helper."""

import json
import multiprocessing
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_timeline_store as store


def _append_from_worker(path):
    """Worker used by the cross-process advisory-lock regression test."""
    return store.append_unique_records(
        path,
        [{"id": "parallel-1", "url": "https://x.com/u/status/parallel-1", "text": "same"}],
    )


class TestAppendUniqueRecords(unittest.TestCase):
    def test_rechecks_identity_under_lock_and_preserves_invalid_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "timeline.jsonl"
            path.write_text(
                '{"id":"1/analytics","url":"https://x.com/u/status/1/analytics",'
                '"text":"existing"}\n'
                'not json\n',
                encoding="utf-8",
            )

            inserted = store.append_unique_records(
                path,
                [
                    {"id": "1", "url": "https://x.com/u/status/1", "text": "duplicate"},
                    {"id": "2", "url": "https://x.com/u/status/2", "text": "new"},
                    {"id": "2/analytics", "url": "https://x.com/u/status/2/analytics", "text": "same batch"},
                ],
            )

            self.assertEqual([item["id"] for item in inserted], ["2"])
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 3)
            self.assertEqual(json.loads(lines[0])["id"], "1/analytics")
            self.assertEqual(lines[1], "not json")
            self.assertEqual(json.loads(lines[2])["id"], "2")

    def test_cross_process_writers_append_only_once(self):
        """The lock must protect the read/check/write sequence across PIDs."""
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "timeline.jsonl"
            ctx = multiprocessing.get_context("fork")
            with ctx.Pool(2) as pool:
                results = pool.map(_append_from_worker, [str(path), str(path)])

            written = [item for result in results for item in result]
            self.assertEqual(len(written), 1)
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["id"], "parallel-1")


class TestIdentity(unittest.TestCase):
    def test_numeric_status_id_normalizes_analytics(self):
        self.assertEqual(
            store.record_key({"id": "123/analytics", "url": "https://x.com/u/status/123/analytics"}),
            ("id", "123"),
        )

    def test_non_numeric_records_fall_back_to_canonical_url(self):
        self.assertEqual(
            store.record_key({"id": "opaque-a", "url": "https://twitter.com/u/post?ref=timeline"}),
            ("url", "https://x.com/u/post"),
        )


if __name__ == "__main__":
    unittest.main()
