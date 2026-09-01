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


def _browser_lock_holder(control):
    """Hold the shared browser lock until the parent explicitly releases it."""
    with store.browser_lock():
        control.send("acquired")
        if control.recv() != "release":
            raise RuntimeError("unexpected holder command")
    control.send("released")


def _browser_lock_contender(control):
    """Attempt the same lock only after the parent has observed readiness."""
    control.send("ready")
    if control.recv() != "attempt":
        raise RuntimeError("unexpected contender command")
    control.send("attempting")
    with store.browser_lock():
        control.send("entered")
        if control.recv() != "finish":
            raise RuntimeError("unexpected contender command")
    control.send("exited")


def _expect_message(connection, expected, timeout=2):
    """Receive one deterministic worker handshake, failing on timeout/order."""
    if not connection.poll(timeout):
        raise AssertionError(f"timed out waiting for {expected!r}")
    actual = connection.recv()
    if actual != expected:
        raise AssertionError(f"expected {expected!r}, got {actual!r}")


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


class TestBrowserLock(unittest.TestCase):
    def test_browser_lock_uses_exact_path_and_leaves_lock_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            original_path = store.TIMELINE_BROWSER_LOCK
            lock_path = pathlib.Path(tmp) / "browser.lock"
            store.TIMELINE_BROWSER_LOCK = lock_path
            try:
                with store.browser_lock():
                    self.assertEqual(store.TIMELINE_BROWSER_LOCK, lock_path)
                    self.assertTrue(lock_path.exists())
                self.assertTrue(lock_path.exists())
            finally:
                store.TIMELINE_BROWSER_LOCK = original_path

    def test_browser_lock_serializes_real_holder_and_contender_processes(self):
        """A contender cannot enter until the holder's explicit release."""
        with tempfile.TemporaryDirectory() as tmp:
            original_path = store.TIMELINE_BROWSER_LOCK
            store.TIMELINE_BROWSER_LOCK = pathlib.Path(tmp) / "browser.lock"
            ctx = multiprocessing.get_context("fork")
            holder_parent, holder_child = ctx.Pipe()
            contender_parent, contender_child = ctx.Pipe()
            holder = ctx.Process(target=_browser_lock_holder, args=(holder_child,))
            contender = ctx.Process(target=_browser_lock_contender, args=(contender_child,))
            processes = [holder, contender]
            try:
                holder.start()
                holder_child.close()
                _expect_message(holder_parent, "acquired")

                contender.start()
                contender_child.close()
                _expect_message(contender_parent, "ready")
                contender_parent.send("attempt")
                _expect_message(contender_parent, "attempting")

                self.assertFalse(
                    contender_parent.poll(0.5),
                    "contender entered while the holder still owned the lock",
                )

                holder_parent.send("release")
                _expect_message(holder_parent, "released")
                _expect_message(contender_parent, "entered")
                contender_parent.send("finish")
                _expect_message(contender_parent, "exited")

                holder.join(timeout=2)
                contender.join(timeout=2)
                self.assertEqual(holder.exitcode, 0)
                self.assertEqual(contender.exitcode, 0)
            finally:
                for connection in (holder_parent, contender_parent):
                    connection.close()
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                    process.join(timeout=2)
                store.TIMELINE_BROWSER_LOCK = original_path


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
