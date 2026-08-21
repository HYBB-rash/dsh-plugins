#!/usr/bin/env python3
"""x_timeline_collector.py 单元测试(TDD 先行)——时间线随机化改造。
运行: python3 -m unittest test_x_timeline_collector -v
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_timeline_collector as col


class TestPickStartSource(unittest.TestCase):
    """随机起始源: For You / Following / Explore 三选一"""

    def test_returns_valid_sources(self):
        for seed in range(30):
            src = col.pick_start_source(seed=seed)
            self.assertIn(src, ("for_you", "following", "explore"), f"seed={seed} 非法: {src}")

    def test_all_sources_appear_over_many_seeds(self):
        seen = set()
        for seed in range(100):
            seen.add(col.pick_start_source(seed=seed))
        self.assertEqual(seen, {"for_you", "following", "explore"}, "应三选一全覆盖")

    def test_deterministic_with_seed(self):
        self.assertEqual(col.pick_start_source(seed=42), col.pick_start_source(seed=42))


class TestStartUrl(unittest.TestCase):
    """起始 URL 映射"""

    def test_for_you_url(self):
        self.assertIn("/home", col.start_url("for_you"))

    def test_following_url(self):
        self.assertIn("following", col.start_url("following"))

    def test_explore_url(self):
        self.assertIn("/explore", col.start_url("explore"))

    def test_unknown_falls_back_home(self):
        self.assertIn("/home", col.start_url("whatever"))


class TestRefreshExpr(unittest.TestCase):
    """「查看新帖子」刷新按钮点击表达式"""

    def test_expr_targets_refresh_button(self):
        expr = col.refresh_button_expr()
        # 应查找"查看新帖子"/Show new posts 按钮并点击
        self.assertIn("查看新帖子", expr)
        self.assertIn("click", expr)

    def test_expr_is_valid_js(self):
        expr = col.refresh_button_expr()
        # 简单 JS 语法校验: 括号配平
        self.assertEqual(expr.count("("), expr.count(")"))
        self.assertEqual(expr.count("{"), expr.count("}"))


class TestNavExpr(unittest.TestCase):
    """导航表达式"""

    def test_nav_to_url_expr(self):
        expr = col.nav_to_url_expr("https://x.com/home")
        self.assertIn("https://x.com/home", expr)
        self.assertIn("location.href", expr)


if __name__ == "__main__":
    unittest.main()
