#!/usr/bin/env python3
"""x_neighborhood.py 单元测试(TDD 先行)——邻域漫游机械层。
运行: python3 -m unittest test_x_neighborhood -v
"""
import io
import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_neighborhood as nb


def sample_graph():
    return {
        "anchors": ["ai-agent", "linux-oss", "fitness", "reading"],
        "restricted": ["badminton"],
        "edges": [
            {"from": "ai-agent", "to": "agent-ux", "hop": 1, "bridge": "Agent 人机协作边界"},
            {"from": "agent-ux", "to": "human-supervision", "hop": 2, "bridge": "人类监督设计"},
            {"from": "linux-oss", "to": "rust", "hop": 1, "bridge": "Linux 常用语言"},
            {"from": "fitness", "to": "badminton", "hop": 1, "bridge": "羽毛球(禁区)"},
            {"from": "fitness", "to": "home-workout", "hop": 1, "bridge": "居家健身"},
            {"from": "reading", "to": "bookos", "hop": 1, "bridge": "BookOS 阅读器"},
            {"from": "bookos", "to": "digital-reading", "hop": 2, "bridge": "数字阅读设备"},
        ],
    }


class TestCanonicalTopic(unittest.TestCase):
    """同义归一: 别名表 surface → canonical id, 兜底字符串归一, 语义归 AI"""

    def test_normalize_surface(self):
        self.assertEqual(nb.normalize_surface("  AI Agent "), "aiagent")
        self.assertEqual(nb.normalize_surface("羽毛球训练"), "羽毛球训练")

    def test_alias_canonicalization(self):
        aliases = nb.normalize_aliases({"羽毛球训练": "badminton", "AI Agent": "ai-agent"})
        self.assertEqual(nb.canonical_topic(aliases, "羽毛球训练"), "badminton")
        self.assertEqual(nb.canonical_topic(aliases, "羽毛球 训练"), "badminton")  # 空格归一
        self.assertEqual(nb.canonical_topic(aliases, "AI Agent"), "ai-agent")

    def test_identity_fallback(self):
        self.assertEqual(nb.canonical_topic({}, "独立开发"), "独立开发")


class TestRestricted(unittest.TestCase):
    """禁区可配置, 不硬编码在领域逻辑"""

    def test_is_restricted(self):
        self.assertTrue(nb.is_restricted("badminton", ["badminton"]))
        self.assertFalse(nb.is_restricted("badminton", []))
        self.assertFalse(nb.is_restricted("rust", ["badminton"]))


class TestLedgerMetrics(unittest.TestCase):
    """冷却/熟悉度/近期重复指标"""

    def test_explored_count(self):
        ledger = {"topics": {"rust": {"times": 3, "last_explored_ts": 100}}}
        self.assertEqual(nb.explored_count(ledger, "rust"), 3)
        self.assertEqual(nb.explored_count(ledger, "unknown"), 0)

    def test_cooldown_remaining(self):
        ledger = {"topics": {"rust": {"times": 1, "last_explored_ts": 100}}}
        self.assertEqual(nb.cooldown_remaining(ledger, "rust", now=100, cooldown_s=3600), 3600)
        self.assertEqual(nb.cooldown_remaining(ledger, "rust", now=100 + 3600, cooldown_s=3600), 0)
        self.assertEqual(nb.cooldown_remaining(ledger, "unknown", now=100, cooldown_s=3600), 0)

    def test_recently_explored(self):
        ledger = {"topics": {"rust": {"times": 1, "last_explored_ts": 100}}}
        self.assertTrue(nb.recently_explored(ledger, "rust", now=150, window_s=60))
        self.assertFalse(nb.recently_explored(ledger, "rust", now=200, window_s=60))

    def test_familiarity(self):
        self.assertEqual(nb.familiarity(0), 0.0)
        self.assertEqual(nb.familiarity(5), 1.0)
        self.assertLess(nb.familiarity(2), nb.familiarity(4))


class TestNoveltyRank(unittest.TestCase):
    """1–2 跳邻域候选 + 禁区 + 冷却 + 近期重复 + 低熟悉优先(纯函数)"""

    def test_one_and_two_hop_candidates(self):
        g = sample_graph()
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"],
                              {"topics": {}}, now=1000, cooldown_s=3600)
        topics = {c["topic"]: c for c in out["candidates"]}
        self.assertIn("agent-ux", topics)
        self.assertIn("human-supervision", topics)
        self.assertIn("rust", topics)
        self.assertIn("home-workout", topics)
        self.assertIn("bookos", topics)
        self.assertIn("digital-reading", topics)
        self.assertEqual(topics["agent-ux"]["hop"], 1)
        self.assertEqual(topics["human-supervision"]["hop"], 2)
        for c in out["candidates"]:
            self.assertLessEqual(c["hop"], 2)
            self.assertIn("bridge", c)
            self.assertIn("from_anchor", c)
            self.assertIn("familiarity", c)
            self.assertIn("explored_count", c)

    def test_restricted_excluded(self):
        g = sample_graph()
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"],
                              {"topics": {}}, now=1000, cooldown_s=3600)
        topics = {c["topic"] for c in out["candidates"]}
        self.assertNotIn("badminton", topics)
        blocked_topics = [b["topic"] for b in out["blocked"]]
        self.assertIn("badminton", blocked_topics)
        b = next(b for b in out["blocked"] if b["topic"] == "badminton")
        self.assertEqual(b["reason"], "restricted")

    def test_anchors_not_candidates(self):
        g = sample_graph()
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"],
                              {"topics": {}}, now=1000, cooldown_s=3600)
        topics = {c["topic"] for c in out["candidates"]}
        for a in g["anchors"]:
            self.assertNotIn(a, topics)

    def test_no_edges_no_candidates(self):
        out = nb.novelty_rank(["ai-agent"], [], ["badminton"], {"topics": {}},
                              now=1000, cooldown_s=3600)
        self.assertEqual(out["candidates"], [])

    def test_empty_graph(self):
        out = nb.novelty_rank([], [], [], {"topics": {}}, now=1000, cooldown_s=3600)
        self.assertEqual(out["candidates"], [])

    def test_synonym_cooldown_blocks_canonical(self):
        """同义冷却: 别名表面字(羽毛球训练)归一为 canonical(badminton), 冷却按 canonical 记账"""
        g = {"anchors": ["fitness"], "restricted": [],
             "edges": [{"from": "fitness", "to": "badminton", "hop": 1, "bridge": "羽毛球"}]}
        ledger = {"topics": {"badminton": {"times": 12, "last_explored_ts": 990}}}
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"], ledger,
                              now=1000, cooldown_s=3600)
        self.assertNotIn("badminton", {c["topic"] for c in out["candidates"]})
        b = next(b for b in out["blocked"] if b["topic"] == "badminton")
        self.assertEqual(b["reason"], "cooldown")
        self.assertEqual(b["cooldown_remaining_s"], 3590)

    def test_recently_explored_rejected(self):
        """近期重复: 冷却已过但仍在近期窗口内 → 拒绝并标注"""
        g = {"anchors": ["fitness"], "restricted": [],
             "edges": [{"from": "fitness", "to": "home-workout", "hop": 1, "bridge": "居家健身"}]}
        ledger = {"topics": {"home-workout": {"times": 2, "last_explored_ts": 990}}}
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"], ledger,
                              now=1000, cooldown_s=1, recent_window_s=60)
        self.assertNotIn("home-workout", {c["topic"] for c in out["candidates"]})
        b = next(b for b in out["blocked"] if b["topic"] == "home-workout")
        self.assertEqual(b["reason"], "recently_explored")
        self.assertIn({"topic": "home-workout", "last_explored_ts": 990, "times": 2},
                      out["recent_explorations"])

    def test_low_familiarity_first(self):
        """低熟悉优先: explored_count 少的排前面, familiarity 分数越低越优先"""
        g = {"anchors": ["ai-agent"], "restricted": [], "edges": [
            {"from": "ai-agent", "to": "well-known", "hop": 1, "bridge": "b1"},
            {"from": "ai-agent", "to": "fresh", "hop": 1, "bridge": "b2"},
        ]}
        ledger = {"topics": {"well-known": {"times": 9, "last_explored_ts": 900},
                             "fresh": {"times": 0, "last_explored_ts": None}}}
        out = nb.novelty_rank(g["anchors"], g["edges"], g["restricted"], ledger,
                              now=1000, cooldown_s=3600)
        order = [c["topic"] for c in out["candidates"]]
        self.assertEqual(order[0], "fresh")
        self.assertLess(nb.familiarity(0), nb.familiarity(9))


class TestWanderState(unittest.TestCase):
    """探索台账: 幂等累加 explored count, 原子持久化"""

    def test_record_exploration_increments(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "state.json")
            r1 = nb.record_exploration(state, "badminton", 1000)
            self.assertEqual(r1["times"], 1)
            r2 = nb.record_exploration(state, "badminton", 2000)
            self.assertEqual(r2["times"], 2)
            self.assertEqual(r2["last_explored_ts"], 2000)
            loaded = nb.load_wander_state(state)
            self.assertEqual(loaded["topics"]["badminton"]["times"], 2)

    def test_record_via_alias_surface(self):
        with tempfile.TemporaryDirectory() as tmp:
            aliases = os.path.join(tmp, "aliases.json")
            state = os.path.join(tmp, "state.json")
            with open(aliases, "w") as f:
                json.dump({"羽毛球训练": "badminton"}, f)
            r = nb.record_exploration_for_surface(aliases, state, "羽毛球训练", 1000)
            self.assertEqual(r["topic"], "badminton")

    def test_load_graph_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            g = nb.load_graph(os.path.join(tmp, "missing.json"))
            self.assertEqual(g["anchors"], [])
            self.assertEqual(g["edges"], [])
            self.assertEqual(g["restricted"], [])


class TestComputeCandidates(unittest.TestCase):
    """编排层: 读数据文件 → 候选+指标, 供 AI 选题"""

    def test_compute_candidates_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            gpath = os.path.join(tmp, "graph.json")
            apath = os.path.join(tmp, "aliases.json")
            spath = os.path.join(tmp, "state.json")
            with open(gpath, "w") as f:
                json.dump(sample_graph(), f, ensure_ascii=False)
            with open(apath, "w") as f:
                json.dump({"羽毛球训练": "badminton"}, f, ensure_ascii=False)
            with open(spath, "w") as f:
                json.dump({"topics": {"badminton": {"times": 12, "last_explored_ts": None}},
                           "cooldown_s": 3600}, f)
            out = nb.compute_candidates(
                gpath, apath, spath, now=1000,
                root_surfaces=["ai-agent", "linux-oss", "fitness", "reading"])
            self.assertTrue(out["config_loaded"])
            topics = {c["topic"] for c in out["candidates"]}
            self.assertIn("badminton", topics)
            self.assertTrue(topics)
            for c in out["candidates"]:
                self.assertLessEqual(c["hop"], 2)

    def test_missing_graph_no_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = nb.compute_candidates(os.path.join(tmp, "no.json"), None, None, now=1000)
            self.assertFalse(out["config_loaded"])
            self.assertEqual(out["candidates"], [])

    def test_cli_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            gpath = os.path.join(tmp, "graph.json")
            apath = os.path.join(tmp, "aliases.json")
            spath = os.path.join(tmp, "state.json")
            with open(gpath, "w") as f:
                json.dump(sample_graph(), f, ensure_ascii=False)
            with open(spath, "w") as f:
                json.dump({"topics": {}}, f)
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = nb.main(["candidates", "--graph", gpath, "--aliases", apath,
                                "--state", spath, "--now", "1000"])
            self.assertEqual(code, 0)
            data = json.loads(buf.getvalue().strip())
            self.assertIn("candidates", data)

    def test_cli_candidates_requires_explicit_root_and_accepts_exact_or_alias_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            gpath = os.path.join(tmp, "graph.json")
            apath = os.path.join(tmp, "aliases.json")
            spath = os.path.join(tmp, "state.json")
            with open(gpath, "w") as f:
                json.dump({
                    "anchors": ["old-like-anchor"],
                    "restricted": ["old-dislike-restricted"],
                    "edges": [
                        {"from": "safe-theme", "to": "safe-one", "hop": 99,
                         "bridge": "old-model-summary-marker"},
                        {"from": "safe-one", "to": "safe-two", "hop": 99,
                         "bridge": "old-model-summary-marker"},
                    ],
                }, f)
            with open(apath, "w") as f:
                json.dump({"当前主题": "safe-theme"}, f, ensure_ascii=False)
            with open(spath, "w") as f:
                json.dump({"topics": {}}, f)

            def run(*roots):
                buf = io.StringIO()
                argv = ["candidates", "--graph", gpath, "--aliases", apath,
                        "--state", spath, "--now", "1000"]
                for root in roots:
                    argv.extend(["--root", root])
                with redirect_stdout(buf):
                    self.assertEqual(nb.main(argv), 0)
                return json.loads(buf.getvalue().strip())

            no_root = run()
            self.assertEqual(no_root["candidates"], [])
            exact_root = run("safe-theme")
            self.assertEqual([c["topic"] for c in exact_root["candidates"]],
                             ["safe-one", "safe-two"])
            alias_root = run("当前主题")
            self.assertEqual(alias_root["roots"], ["safe-theme"])
            self.assertNotIn("old-like-anchor", json.dumps(alias_root, ensure_ascii=False))
            self.assertNotIn("old-dislike-restricted", json.dumps(alias_root, ensure_ascii=False))
            self.assertNotIn("old-model-summary-marker", json.dumps(alias_root, ensure_ascii=False))

    def test_cli_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            spath = os.path.join(tmp, "state.json")
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = nb.main(["record", "--state", spath, "--topic", "羽毛球训练",
                                "--aliases", os.path.join(tmp, "no-aliases.json"), "--now", "1000"])
            self.assertEqual(code, 0)
            self.assertEqual(nb.explored_count(nb.load_wander_state(spath), "羽毛球训练"), 1)


class TestAutomaticGraphSanitizer(unittest.TestCase):
    """自动路径只使用安全拓扑与本轮显式 roots。"""

    def test_automatic_path_drops_old_preference_fields_and_recomputes_hops(self):
        graph = {
            "anchors": ["old-like-anchor"],
            "restricted": ["old-dislike-restricted"],
            "edges": [
                {"from": "safe-theme", "to": "safe-one", "hop": 99,
                 "bridge": "old-model-summary-marker"},
                {"from": "safe-one", "to": "safe-two", "hop": 99,
                 "bridge": "old-model-summary-marker"},
                {"from": "safe-theme", "to": "old-dislike-restricted", "hop": 1,
                 "bridge": "old-model-summary-marker"},
            ],
        }
        source_bytes = json.dumps(graph, ensure_ascii=False, sort_keys=True).encode()
        source_hash = hashlib.sha256(source_bytes).hexdigest()
        safe = nb.sanitize_graph(graph)
        self.assertEqual(safe["anchors"], [])
        self.assertEqual(safe["restricted"], [])
        self.assertEqual(safe["edges"], [
            {"from": "safe-theme", "to": "safe-one"},
            {"from": "safe-one", "to": "safe-two"},
            {"from": "safe-theme", "to": "old-dislike-restricted"},
        ])
        out = nb.novelty_rank(
            ["safe-theme"], safe["edges"], [],
            {"topics": {}}, now=1000, cooldown_s=3600)
        by_topic = {item["topic"]: item for item in out["candidates"]}
        self.assertEqual(by_topic["safe-one"]["hop"], 1)
        self.assertEqual(by_topic["safe-two"]["hop"], 2)
        self.assertEqual(by_topic["safe-one"]["bridge"], "safe-theme → safe-one")
        self.assertIn("old-dislike-restricted", by_topic)
        self.assertNotIn("old-model-summary-marker", json.dumps(out, ensure_ascii=False))
        self.assertEqual(
            hashlib.sha256(json.dumps(graph, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
            source_hash,
        )

    def test_runtime_roots_require_exact_alias_and_graph_intersection(self):
        edges = [{"from": "safe-theme", "to": "safe-one"}]
        aliases = {"当前主题": "safe-theme", "模糊主题": "not-in-graph"}
        self.assertEqual(
            nb.runtime_roots(aliases, ["当前主题", "模糊主题"], edges),
            ["safe-theme"],
        )
        self.assertEqual(nb.runtime_roots(aliases, ["不应模糊命中"], edges), [])

    def test_compute_candidates_never_falls_back_to_raw_anchors(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph_path = os.path.join(tmp, "graph.json")
            state_path = os.path.join(tmp, "state.json")
            with open(graph_path, "w") as handle:
                json.dump({
                    "anchors": ["old-like-anchor"],
                    "restricted": ["old-dislike-restricted"],
                    "edges": [{"from": "safe-theme", "to": "safe-one",
                               "hop": 1, "bridge": "old-model-summary-marker"}],
                }, handle)
            with open(state_path, "w") as handle:
                json.dump({"topics": {}, "cooldown_s": 3600}, handle)
            no_roots = nb.compute_candidates(graph_path, None, state_path, now=1000)
            self.assertEqual(no_roots["candidates"], [])
            self.assertEqual(no_roots["roots"], [])
            with_roots = nb.compute_candidates(
                graph_path, None, state_path, now=1000,
                root_surfaces=["safe-theme"])
            self.assertEqual([c["topic"] for c in with_roots["candidates"]], ["safe-one"])
            self.assertNotIn("old-like-anchor", json.dumps(with_roots, ensure_ascii=False))
            self.assertNotIn("old-model-summary-marker", json.dumps(with_roots, ensure_ascii=False))
            self.assertNotIn("old-dislike-restricted", json.dumps(with_roots, ensure_ascii=False))



if __name__ == "__main__":
    unittest.main()
