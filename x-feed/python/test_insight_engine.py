#!/usr/bin/env python3
"""insight_engine.py 单元测试(TDD 先行)——通用信息流洞察引擎。
运行: python3 -m unittest test_insight_engine -v
"""
import json
import os
import random
import tempfile
import unittest

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import insight_engine as engine


def make_item(tid, text, source="x", url=None):
    return {
        "id": str(tid),
        "url": url or f"https://{source}.example/{tid}",
        "text": text,
        "source": source,
        "ts": 1786500000 + tid,
        "time": "2026-08-12T00:00:00.000Z",
        "user": "u",
    }


class TestItemModel(unittest.TestCase):
    """领域层: 统一数据模型"""

    def test_item_requires_core_fields(self):
        # load_items 应忽略缺核心字段的行
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "items.jsonl")
            with open(p, "w") as f:
                f.write(json.dumps({"id": "1", "url": "u", "text": "t", "source": "x"}) + "\n")
                f.write('{"broken": true}\n')
                f.write("not json\n")
            items = engine.load_items(p)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["id"], "1")
            self.assertEqual(items[0]["source"], "x")


class TestThemeClassifier(unittest.TestCase):
    """领域层: 通用主题分类"""

    def test_classify_ai(self):
        self.assertEqual(engine.classify("Codex is great"), "ai")
        self.assertEqual(engine.classify("OpenAI released"), "ai")
        self.assertEqual(engine.classify("GPT-5 news"), "ai")

    def test_classify_crypto(self):
        self.assertEqual(engine.classify("BTC cycle"), "crypto")
        self.assertEqual(engine.classify("比特币周期"), "crypto")

    def test_classify_trading(self):
        self.assertEqual(engine.classify("黄金现货 新高"), "trading")
        self.assertEqual(engine.classify("外汇 EURUSD"), "trading")

    def test_classify_reasoning(self):
        self.assertEqual(engine.classify("stealing reasoning traces"), "reasoning")
        self.assertEqual(engine.classify("chain-of-thought 解密"), "reasoning")

    def test_classify_unknown_none(self):
        self.assertIsNone(engine.classify("今天天气不错"))

    def test_custom_keywords_per_source(self):
        """新信息流可注入自定义关键词表"""
        custom = {"dev": ["youtube", "rust", "homelab"]}
        self.assertEqual(engine.classify("rust tutorial", custom), "dev")
        self.assertIsNone(engine.classify("BTC price", custom))


class TestAnalyze(unittest.TestCase):
    """应用层: analyze 决策包"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.items_path = os.path.join(self.tmp.name, "items.jsonl")
        self.last_path = os.path.join(self.tmp.name, "last.json")

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, items):
        with open(self.items_path, "w") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")

    def test_decision_package_shape(self):
        self._write([make_item(1, "Codex news"), make_item(2, "BTC price")])
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        for key in ("recent_count", "top_theme", "top_share", "flooded",
                    "same_as_last", "random_roll", "random_hit",
                    "wander_suggested", "candidates"):
            self.assertIn(key, pkg, f"缺少字段 {key}")

    def test_flood_at_40_percent(self):
        items = [make_item(i, "Codex OpenAI") for i in range(12)]
        items += [make_item(100 + i, "普通日常内容") for i in range(18)]
        self._write(items)
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertTrue(pkg["flooded"])
        self.assertEqual(pkg["top_theme"], "ai")

    def test_no_flood_under_threshold(self):
        items = [make_item(i, "Codex") for i in range(5)]
        items += [make_item(100 + i, "普通日常") for i in range(25)]
        self._write(items)
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertFalse(pkg["flooded"])

    def test_same_as_last(self):
        self._write([make_item(1, "Codex OpenAI")])
        with open(self.last_path, "w") as f:
            json.dump({"theme": "ai"}, f)
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertTrue(pkg["same_as_last"])

    def test_random_hit_rate(self):
        random.seed(42)
        hits = sum(1 for _ in range(1000) if engine.roll() < 0.3)
        self.assertGreater(hits, 200)
        self.assertLess(hits, 400)

    def test_candidates_exclude_top_theme(self):
        items = [make_item(i, "Codex OpenAI") for i in range(15)]
        items += [make_item(100 + i, f"美食 摄影 {i}") for i in range(15)]
        self._write(items)
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertTrue(pkg["candidates"])
        for c in pkg["candidates"]:
            self.assertNotEqual(c["theme"], "ai")

    def test_empty_graceful(self):
        self._write([])
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertEqual(pkg["recent_count"], 0)
        self.assertIsNone(pkg["top_theme"])

    def test_source_metadata_in_package(self):
        items = [make_item(i, "Codex", source="x") for i in range(10)]
        self._write(items)
        pkg = engine.analyze(self.items_path, self.last_path, recent=30)
        self.assertEqual(pkg["source"], "x")


class TestSourceIsolation(unittest.TestCase):
    """不同信息流的状态互相隔离"""

    def test_last_theme_per_source_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            x_last = os.path.join(tmp, "x_last.json")
            hn_last = os.path.join(tmp, "hn_last.json")
            engine.set_theme(x_last, "ai")
            engine.set_theme(hn_last, "dev")
            with open(x_last) as f:
                self.assertEqual(json.load(f)["theme"], "ai")
            with open(hn_last) as f:
                self.assertEqual(json.load(f)["theme"], "dev")


class TestSetTheme(unittest.TestCase):
    def test_write_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "last.json")
            engine.set_theme(p, "crypto")
            with open(p) as f:
                self.assertEqual(json.load(f)["theme"], "crypto")


class TestCLI(unittest.TestCase):
    def test_analyze_cli_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = os.path.join(tmp, "items.jsonl")
            last = os.path.join(tmp, "last.json")
            with open(items, "w") as f:
                for i in range(5):
                    f.write(json.dumps(make_item(i, "Codex OpenAI")) + "\n")
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with redirect_stdout(buf):
                engine.main(["analyze", "--items", items, "--last", last, "--recent", "30"])
            data = json.loads(buf.getvalue().strip())
            self.assertEqual(data["top_theme"], "ai")

    def test_set_theme_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            last = os.path.join(tmp, "last.json")
            engine.main(["set-theme", "--last", last, "--theme", "trading"])
            with open(last) as f:
                self.assertEqual(json.load(f)["theme"], "trading")


if __name__ == "__main__":
    unittest.main()
