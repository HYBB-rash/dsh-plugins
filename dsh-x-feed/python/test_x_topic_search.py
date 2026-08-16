#!/usr/bin/env python3
"""x_topic_search.py 单元测试(TDD 先行)——探索流污染隔离。
运行: python3 -m unittest test_x_topic_search -v
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_topic_search as ts
import insight_engine as engine


class TestExploreOutputIsolation(unittest.TestCase):
    """搜索探索结果默认写独立 x_explore_items.jsonl, 禁止污染 x_timeline.jsonl"""

    def test_default_out_is_explore_not_timeline(self):
        self.assertTrue(ts.OUT.endswith("x_explore_items.jsonl"))
        self.assertFalse(ts.OUT.endswith("x_timeline.jsonl"))

    def test_tag_explore_core_fields(self):
        item = {"id": "1", "url": "https://x.com/u/1", "text": "t"}
        r = ts._tag_explore(item, "羽毛球", anchor="fitness", bridge="羽毛球运动", hop=1)
        self.assertEqual(r["topic"], "羽毛球")
        self.assertEqual(r["anchor"], "fitness")
        self.assertEqual(r["bridge"], "羽毛球运动")
        self.assertEqual(r["hop"], 1)
        self.assertIn("ts", r)

    def test_tag_explore_optional_fields_absent(self):
        item = {"id": "2", "url": "https://x.com/u/2", "text": "t2"}
        r = ts._tag_explore(item, "rust")
        self.assertEqual(r["topic"], "rust")
        self.assertNotIn("anchor", r)
        self.assertNotIn("bridge", r)
        self.assertNotIn("hop", r)

    def test_search_appends_to_explore_file_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            with open(tl, "w") as f:
                f.write(json.dumps({"id": "1", "url": "https://x.com/a/1",
                                    "text": "pure", "source": "x"}) + "\n")
            tl_before = open(tl).read()
            records = [ts._tag_explore({"id": "9", "url": "https://x.com/e/9",
                                        "text": "羽毛球 内容"}, "羽毛球")]
            inserted = ts.append_explore_records(ex, records)
            self.assertEqual(len(inserted), 1)
            self.assertEqual(open(tl).read(), tl_before)  # 主时间线零污染
            lines = [json.loads(l) for l in open(ex).read().strip().splitlines()]
            self.assertEqual(lines[0]["topic"], "羽毛球")

    def test_explore_rows_never_feed_analyze(self):
        """引擎只读主时间线: 探索文件里的羽毛球行不进 analyze 窗口/候选"""
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            ex = os.path.join(tmp, "explore.jsonl")
            with open(tl, "w") as f:
                for i in range(30):
                    f.write(json.dumps({"id": str(i), "url": f"https://x.com/t/{i}",
                                        "text": "Codex OpenAI", "source": "x"}) + "\n")
            with open(ex, "w") as f:
                for i in range(30):
                    f.write(json.dumps({"id": f"e{i}", "url": f"https://x.com/e/{i}",
                                        "text": "羽毛球 训练", "source": "x",
                                        "topic": "羽毛球"}) + "\n")
            pkg = engine.analyze(tl, os.path.join(tmp, "last.json"), recent=30)
            self.assertEqual(pkg["recent_count"], 30)
            self.assertEqual(pkg["top_theme"], "ai")
            self.assertNotIn("fitness", pkg["themes"])
            for c in pkg["candidates"]:
                self.assertNotEqual(c["theme"], "fitness")


if __name__ == "__main__":
    unittest.main()
