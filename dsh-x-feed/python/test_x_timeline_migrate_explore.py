#!/usr/bin/env python3
"""x_timeline_migrate_explore.py 单元测试(TDD 先行)——一次性迁移工具。
运行: python3 -m unittest test_x_timeline_migrate_explore -v
"""
import glob
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_timeline_migrate_explore as mig


def pure_row(tid, text):
    return json.dumps({"id": str(tid), "url": f"https://x.com/u/{tid}",
                       "text": text, "source": "x", "ts": 1786500000 + tid},
                      ensure_ascii=False)


def explore_row(tid, topic, extra=None):
    d = {"id": str(2000000000 + tid), "url": f"https://x.com/e/{tid}",
         "text": f"{topic} 内容", "source": "x", "ts": 1786500000 + tid, "topic": topic}
    if extra:
        d.update(extra)
    return json.dumps(d, ensure_ascii=False)


def write_lines(path, lines):
    with open(path, "w") as f:
        for line in lines:
            f.write(line + "\n")


class TestPartition(unittest.TestCase):
    def test_partition_splits_topic_rows(self):
        lines = [pure_row(1, "Codex"), explore_row(1, "羽毛球"),
                 "not json at all", pure_row(2, "Linux")]
        pure, explore = mig.partition_lines(lines)
        self.assertEqual(len(pure), 3)  # 2 纯行 + 1 坏行留在主时间线
        self.assertEqual(len(explore), 1)
        self.assertEqual(explore[0]["topic"], "羽毛球")


class TestDryRun(unittest.TestCase):
    def test_dry_run_no_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            write_lines(tl, [pure_row(1, "Codex"), explore_row(1, "羽毛球"), explore_row(2, "badminton")])
            before = open(tl).read()
            summary = mig.migrate(tl, ex, apply=False)
            self.assertTrue(summary["dry_run"])
            self.assertEqual(summary["explore_rows_found"], 2)
            self.assertEqual(summary["timeline_pure"], 1)
            self.assertFalse(os.path.exists(ex))
            self.assertEqual(open(tl).read(), before)
            self.assertEqual(glob.glob(os.path.join(tmp, "*.bak-*")), [])


class TestApply(unittest.TestCase):
    def test_apply_moves_rows_and_backs_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            write_lines(tl, [pure_row(1, "Codex"),
                             explore_row(1, "羽毛球"),
                             explore_row(2, "badminton", {"anchor": "fitness", "hop": 1})])
            summary = mig.migrate(tl, ex, apply=True)
            self.assertTrue(summary["applied"])
            self.assertEqual(summary["moved"], 2)
            new_tl = open(tl).read()
            self.assertNotIn("羽毛球", new_tl)
            self.assertIn("Codex", new_tl)
            ex_lines = [l for l in open(ex).read().strip().splitlines() if l.strip()]
            self.assertEqual(len(ex_lines), 2)
            parsed = [json.loads(l) for l in ex_lines]
            self.assertTrue(any(p["topic"] == "badminton" and p["hop"] == 1 for p in parsed))
            baks = glob.glob(os.path.join(tmp, "*.bak-*"))
            self.assertTrue(any("tl.jsonl" in b for b in baks))


class TestIdempotent(unittest.TestCase):
    def test_second_apply_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            write_lines(tl, [pure_row(1, "Codex"), explore_row(1, "羽毛球")])
            mig.migrate(tl, ex, apply=True)
            tl_after = open(tl).read()
            ex_after = open(ex).read()
            baks1 = sorted(glob.glob(os.path.join(tmp, "*.bak-*")))
            summary2 = mig.migrate(tl, ex, apply=True)
            self.assertEqual(summary2["moved"], 0)
            self.assertTrue(summary2.get("noop"))
            self.assertEqual(open(tl).read(), tl_after)
            self.assertEqual(open(ex).read(), ex_after)
            self.assertEqual(sorted(glob.glob(os.path.join(tmp, "*.bak-*"))), baks1)


class TestDedupeAgainstExisting(unittest.TestCase):
    def test_existing_explore_rows_not_duplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            write_lines(tl, [explore_row(7, "rust"), pure_row(1, "Codex"), explore_row(8, "健身")])
            with open(ex, "w") as f:
                f.write(explore_row(7, "rust") + "\n")  # 探索文件里已存在
            mig.migrate(tl, ex, apply=True)
            lines = [json.loads(l) for l in open(ex).read().strip().splitlines() if l.strip()]
            topics = [l.get("topic") for l in lines]
            self.assertEqual(topics.count("rust"), 1)
            self.assertEqual(topics.count("健身"), 1)


class TestCLI(unittest.TestCase):
    def test_cli_dry_run_then_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            write_lines(tl, [pure_row(1, "Codex"), explore_row(1, "羽毛球")])
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = mig.main(["--timeline", tl, "--explore", ex])
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(ex))
            with redirect_stdout(buf):
                code2 = mig.main(["--timeline", tl, "--explore", ex, "--apply"])
            self.assertEqual(code2, 0)
            self.assertTrue(os.path.exists(ex))


if __name__ == "__main__":
    unittest.main()
