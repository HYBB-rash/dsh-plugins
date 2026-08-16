#!/usr/bin/env python3
"""x_insight_pipeline.py 单元测试(TDD 先行)——X 洞察机械管道(零模型调用)。
运行: python3 -m unittest test_x_insight_pipeline -v
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_insight_pipeline as pipe


class TestChromeCheck(unittest.TestCase):
    def test_chrome_check_no_crash(self):
        ok = pipe.ensure_chrome()
        self.assertIsInstance(ok, bool)


class TestCollect(unittest.TestCase):
    def test_collect_runs_collector(self):
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"DSH_X_FEED_DATA_DIR": tmp}):
                r = pipe.run_collector(
                    rolls=1,
                    sleep_s=1,
                    batch_out=os.path.join(tmp, "collection.jsonl"),
                )
        self.assertIsInstance(r, dict)
        self.assertIn("ok", r)


class TestRecentItems(unittest.TestCase):
    def test_recent_items_reads_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            with open(tl, "w") as f:
                for i in range(5):
                    f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                        "text": f"text {i}", "source": "x", "ts": 100 + i}) + "\n")
            items = pipe.recent_items(tl, n=3)
            self.assertEqual(len(items), 3)
            self.assertEqual(items[-1]["id"], "4")
            self.assertIn("url", items[0])
            self.assertIn("text", items[0])

    def test_recent_items_missing_file(self):
        self.assertEqual(pipe.recent_items("/nonexistent.jsonl"), [])

    def test_recent_items_keep_full_text_for_ai(self):
        """高优判断归 AI——脚本必须保留完整 text, 不做关键词预过滤。"""
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            with open(tl, "w") as f:
                f.write(json.dumps({"id": "1", "url": "u1",
                                    "text": "Stealing reasoning traces from LLM APIs",
                                    "source": "x"}) + "\n")
                f.write(json.dumps({"id": "2", "url": "u2",
                                    "text": "BTC price action today",
                                    "source": "x"}) + "\n")
                f.write(json.dumps({"id": "3", "url": "u3",
                                    "text": "chain-of-thought 解密 新论文",
                                    "source": "x"}) + "\n")
            items = pipe.recent_items(tl, n=10)
            self.assertEqual(len(items), 3)
            # 完整 text 原样保留, 让 AI 语义判断高优
            self.assertEqual(items[0]["text"], "Stealing reasoning traces from LLM APIs")
            self.assertTrue(all(it.get("text") for it in items))


class TestBuildPackage(unittest.TestCase):
    def test_package_shape_and_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            with open(tl, "w") as f:
                for i in range(10):
                    f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                        "text": "Codex OpenAI" if i % 2 == 0 else "普通日常",
                                        "source": "x", "ts": 1000 + i}) + "\n")
            pkg = pipe.build_package(tl, last, recent=10)
            for key in ("decision", "recent_items", "ts"):
                self.assertIn(key, pkg, f"缺少 {key}")
            self.assertEqual(pkg["decision"]["top_theme"], "ai")
            self.assertEqual(len(pkg["recent_items"]), 10)

    def test_package_recent_capped(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            with open(tl, "w") as f:
                for i in range(50):
                    f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                        "text": f"t{i}", "source": "x", "ts": i}) + "\n")
            pkg = pipe.build_package(tl, last, recent=30, cap_items=15)
            self.assertEqual(len(pkg["recent_items"]), 15)


class TestMain(unittest.TestCase):
    def test_main_writes_package_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "pkg.json")
            with unittest.mock.patch.object(pipe, "DATA", os.path.join(tmp, "data")):
                code = pipe.main(["--rolls", "0", "--out", out, "--no-collect"])
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(out))
            with open(out) as f:
                data = json.load(f)
            self.assertIn("decision", data)


class TestFeedbackContext(unittest.TestCase):
    """每轮主 pipeline 都携带最新偏好和有效反馈，不靠长 Session 自己重读。"""

    @staticmethod
    def feedback_event(number, topic=None):
        return {
            "schemaVersion": 1,
            "id": f"feedback-{number}",
            "createdAt": f"2026-08-16T00:00:{number:02d}.000Z",
            "operation": "dislike",
            "topic": topic or f"topic-{number}",
        }

    def test_missing_preference_and_feedback_files_return_empty_structured_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(pipe.load_feedback_context(tmp), {
                "legacy_preferences": "",
                "recent_feedback": [],
            })

    def test_corrupt_feedback_lines_are_skipped_without_rewriting_source_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "legacy-x-preferences.md"), "w") as f:
                f.write("少发纯转述内容\n")
            ledger = os.path.join(tmp, "feedback.jsonl")
            valid = self.feedback_event(1)
            raw = (
                json.dumps(valid, ensure_ascii=False).encode("utf-8") + b"\n"
                + b'{"broken"\n'
                + b'{"operation":"like"}\n'
            )
            with open(ledger, "wb") as f:
                f.write(raw)

            context = pipe.load_feedback_context(tmp)

            self.assertEqual(context["legacy_preferences"], "少发纯转述内容\n")
            self.assertEqual(context["recent_feedback"], [valid])
            with open(ledger, "rb") as f:
                self.assertEqual(f.read(), raw)

    def test_only_most_recent_200_valid_feedback_events_are_returned_without_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = os.path.join(tmp, "feedback.jsonl")
            events = [self.feedback_event(number) for number in range(205)]
            raw = "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)
            raw += '{"broken"\n'
            with open(ledger, "w") as f:
                f.write(raw)

            context = pipe.load_feedback_context(tmp)

            self.assertEqual(len(context["recent_feedback"]), 200)
            self.assertEqual(context["recent_feedback"][0]["topic"], "topic-5")
            self.assertEqual(context["recent_feedback"][-1]["topic"], "topic-204")
            with open(ledger) as f:
                self.assertEqual(f.read(), raw)

    def test_second_main_pipeline_round_returns_feedback_added_after_first_round(self):
        """同一进程中的第二轮必须重新从账本取得新增反馈并写入主输出。"""
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "legacy-x-preferences.md"), "w") as f:
                f.write("保留有新增信息的内容\n")
            ledger = os.path.join(tmp, "feedback.jsonl")
            with open(ledger, "w") as f:
                f.write(json.dumps(self.feedback_event(1), ensure_ascii=False) + "\n")

            def run_round(name):
                output = io.StringIO()
                package_path = os.path.join(tmp, name)
                with unittest.mock.patch.object(pipe, "DATA", tmp), \
                     unittest.mock.patch.object(pipe, "delivery_receipt_pending", return_value=False), \
                     unittest.mock.patch.object(pipe, "pipeline_lock", return_value=contextlib.nullcontext()), \
                     unittest.mock.patch.object(
                         pipe,
                         "build_package",
                         side_effect=lambda **_: {
                             "decision": {},
                             "recent_items": [],
                             "delivery_id": f"delivery-{name}",
                             "ts": 1,
                         },
                     ):
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(pipe.main(["--no-collect", "--out", package_path]), 0)
                return json.loads(output.getvalue().strip().splitlines()[-1]), json.load(open(package_path))

            first_output, first_package = run_round("first.json")
            with open(ledger, "a") as f:
                f.write(json.dumps(self.feedback_event(2, "少发 Codex 纯转述"), ensure_ascii=False) + "\n")
            second_output, second_package = run_round("second.json")

            self.assertEqual(len(first_output["feedback_context"]["recent_feedback"]), 1)
            self.assertEqual(len(second_output["feedback_context"]["recent_feedback"]), 2)
            self.assertEqual(second_output["feedback_context"]["recent_feedback"][-1]["topic"], "少发 Codex 纯转述")
            self.assertEqual(first_package["feedback_context"], first_output["feedback_context"])
            self.assertEqual(second_package["feedback_context"], second_output["feedback_context"])


if __name__ == "__main__":
    unittest.main()


class TestWanderSignals(unittest.TestCase):
    """漫游信号由代码算, 方向决策归 AI——管道输出 wander_suggested + candidates 即可"""

    def test_decision_contains_wander_signal_and_candidates(self):
        """刷屏时: 管道输出 wander_suggested=true + 非刷屏候选, AI 据此决定往哪去"""
        def fake_run(cmd, *a, **kw):
            cmd_str = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
            if "insight_engine.py" in cmd_str:
                decision = {
                    "source": "x", "recent_count": 15, "top_theme": "ai",
                    "top_share": 0.533, "themes": {"ai": 8}, "flooded": True,
                    "same_as_last": False, "random_roll": 0.5, "random_hit": False,
                    "wander_suggested": True,
                    "candidates": [{"url": "u_cand", "text": "非热门内容", "theme": None}],
                }
                return unittest.mock.Mock(stdout=json.dumps(decision), returncode=0)
            return unittest.mock.Mock(stdout='{"ok": true}', returncode=0)

        with unittest.mock.patch("x_insight_pipeline.subprocess.run", side_effect=fake_run):
            with tempfile.TemporaryDirectory() as tmp:
                tl = os.path.join(tmp, "tl.jsonl")
                last = os.path.join(tmp, "last.json")
                with open(tl, "w") as f:
                    for i in range(15):
                        f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                            "text": "Codex OpenAI" if i % 2 == 0 else "普通日常",
                                            "source": "x", "ts": 1000 + i}) + "\n")
                pkg = pipe.build_package(tl, last, recent=30, seed=42)
                self.assertTrue(pkg["decision"]["wander_suggested"])
                self.assertTrue(pkg["decision"]["flooded"])
                self.assertTrue(pkg["decision"]["candidates"], "应提供候选供 AI 选择方向")

    def test_no_signal_no_wander_hint(self):
        """无信号时 wander_suggested=false, AI 无需漫游"""
        def fake_no_signal(cmd, *a, **kw):
            cmd_str = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
            if "insight_engine.py" in cmd_str:
                decision = {
                    "source": "x", "recent_count": 5, "top_theme": None,
                    "top_share": 0.0, "themes": {}, "flooded": False,
                    "same_as_last": False, "random_roll": 0.9, "random_hit": False,
                    "wander_suggested": False, "candidates": [],
                }
                return unittest.mock.Mock(stdout=json.dumps(decision), returncode=0)
            return unittest.mock.Mock(stdout='{"ok": true}', returncode=0)

        with unittest.mock.patch("x_insight_pipeline.subprocess.run", side_effect=fake_no_signal):
            with tempfile.TemporaryDirectory() as tmp:
                tl = os.path.join(tmp, "tl.jsonl")
                last = os.path.join(tmp, "last.json")
                with open(tl, "w") as f:
                    for i in range(5):
                        f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                            "text": f"普通内容{i}",
                                            "source": "x", "ts": i}) + "\n")
                pkg = pipe.build_package(tl, last, recent=30, seed=1)
                self.assertFalse(pkg["decision"]["wander_suggested"])


if __name__ == "__main__":
    unittest.main()


class TestShownFilter(unittest.TestCase):
    """展示层去重: 已展示过的推文下次不再给 AI 挑"""

    def test_mark_and_filter_shown(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            # 标记两条已展示
            pipe.mark_shown(shown, ["https://x.com/a/1", "https://x.com/b/2"])
            # 过滤: 已展示的排除, 未展示的保留
            items = [
                {"id": "1", "url": "https://x.com/a/1", "text": "已看过A", "source": "x"},
                {"id": "2", "url": "https://x.com/b/2", "text": "已看过B", "source": "x"},
                {"id": "3", "url": "https://x.com/c/3", "text": "新内容C", "source": "x"},
            ]
            fresh = pipe.filter_fresh(items, shown)
            self.assertEqual(len(fresh), 1)
            self.assertEqual(fresh[0]["id"], "3")

    def test_mark_shown_creates_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            pipe.mark_shown(shown, ["https://x.com/x/1"])
            self.assertTrue(os.path.exists(shown))
            import json as _json
            data = _json.load(open(shown))
            self.assertIn("https://x.com/x/1", data["urls"])

    def test_filter_fresh_missing_file(self):
        items = [{"id": "1", "url": "u1", "text": "t", "source": "x"}]
        self.assertEqual(pipe.filter_fresh(items, "/nonexistent.json"), items)

    def test_mark_shown_accumulates(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            pipe.mark_shown(shown, ["u1"])
            pipe.mark_shown(shown, ["u2"])
            import json as _json
            data = _json.load(open(shown))
            self.assertEqual(len(data["urls"]), 2)


class TestCollectionBoundary(unittest.TestCase):
    """本轮新采集优先，历史内容只能作为未展示的补位。"""

    def test_current_batch_is_prioritized_over_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            pipe.mark_shown(shown, ["https://x.com/old/1"])
            current = [
                {"id": "new-a", "url": "https://x.com/new/a", "text": "本轮A", "source": "x"},
                {"id": "new-b", "url": "https://x.com/new/b", "text": "本轮B", "source": "x"},
            ]
            history = [
                {"id": "old", "url": "https://x.com/old/1", "text": "已展示", "source": "x"},
                {"id": "fallback", "url": "https://x.com/old/2", "text": "未展示历史", "source": "x"},
                *current,
            ]
            selected = pipe.select_package_items(current, history, shown, cap_items=3)
            self.assertEqual([it["id"] for it in selected], ["new-a", "new-b", "fallback"])

    def test_shown_history_is_not_used_as_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            pipe.mark_shown(shown, ["https://x.com/old/1", "https://x.com/old/2"])
            history = [
                {"id": "old-1", "url": "https://x.com/old/1", "text": "已展示1", "source": "x"},
                {"id": "old-2", "url": "https://x.com/old/2", "text": "已展示2", "source": "x"},
            ]
            selected = pipe.select_package_items([], history, shown, cap_items=5)
            self.assertEqual(selected, [])

    def test_delta_uses_items_added_after_snapshot(self):
        before = {"a", "b"}
        after = [
            {"id": "a", "url": "https://x.com/a", "text": "旧", "source": "x"},
            {"id": "c", "url": "https://x.com/c", "text": "新", "source": "x"},
        ]
        self.assertEqual([it["id"] for it in pipe.new_items_since(before, after)], ["c"])


class TestMarkShownCliData(unittest.TestCase):
    def test_mark_shown_normalizes_query_urls_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            shown = os.path.join(tmp, "shown.json")
            pipe.mark_shown(shown, ["https://x.com/a/1?ref=foo", "https://x.com/a/1"])
            data = json.load(open(shown))
            self.assertEqual(data["urls"], ["https://x.com/a/1"])


class TestEmptyBatchSemantics(unittest.TestCase):
    """空采集批次不得从旧主时间线/探索历史补位伪装为本轮新内容。"""

    def test_empty_batch_not_backfilled_from_history(self):
        """回归: 旧实现空批次回退到混合历史 → 前三个候选全是羽毛球。"""
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            shown = os.path.join(tmp, "shown.json")
            history = []
            for i in range(30):
                history.append({"id": f"h{i}", "url": f"https://x.com/h/{i}",
                                "text": "羽毛球 训练", "source": "x", "ts": 1000 + i})
            with open(tl, "w") as f:
                for r in history:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            pkg = pipe.build_package(tl, last, recent=30, cap_items=25,
                                     shown_path=shown, current_items=[])
            self.assertEqual(pkg["collection_status"], "empty")
            self.assertEqual(pkg["recent_items"], [])
            self.assertEqual(pkg["selected_urls"], [])
            self.assertEqual(pkg["decision"]["recent_count"], 0)
            self.assertEqual(pkg["decision"]["candidates"], [])
            self.assertFalse(pkg["decision"]["wander_suggested"])
            for key in ("recent_count", "top_theme", "top_share", "flooded",
                        "same_as_last", "random_roll", "random_hit",
                        "wander_suggested", "candidates", "themes"):
                self.assertIn(key, pkg["decision"])

    def test_nonempty_batch_status_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            current = [{"id": f"n{i}", "url": f"https://x.com/n/{i}",
                        "text": f"新内容 {i}", "source": "x"} for i in range(3)]
            pkg = pipe.build_package(tl, last, recent=30, current_items=current)
            self.assertEqual(pkg["collection_status"], "ok")
            self.assertEqual(pkg["decision"]["recent_count"], 3)

    def test_legacy_mode_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            with open(tl, "w") as f:
                f.write(json.dumps({"id": "1", "url": "u1", "text": "Codex",
                                    "source": "x"}) + "\n")
            pkg = pipe.build_package(tl, last, recent=30)
            self.assertEqual(pkg["collection_status"], "legacy")


class TestDeliveryGuardrail(unittest.TestCase):
    """真实投递机械护栏: 只登记发送成功 URL 子集; 失败不能登记; 幂等。"""

    def _pkg(self, path, urls):
        with open(path, "w") as f:
            json.dump({"delivery_id": "x-1", "selected_urls": urls,
                       "delivered_urls": [], "delivery_status": "pending"}, f)

    def test_records_delivered_subset_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/b/2", "https://x.com/c/3"])
            r = pipe.record_delivery(pkg, shown, ["https://x.com/b/2"])
            self.assertTrue(r["ok"])
            self.assertEqual(r["marked"], 1)
            self.assertEqual(r["rejected"], [])
            data = json.load(open(shown))
            self.assertEqual(data["urls"], ["https://x.com/b/2"])
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivered_urls"], ["https://x.com/b/2"])
            self.assertEqual(pkg_data["delivery_status"], "delivered")

    def test_rejects_url_outside_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            r = pipe.record_delivery(pkg, shown, ["https://x.com/evil/9"])
            self.assertFalse(r["ok"])
            self.assertEqual(r["rejected"], ["https://x.com/evil/9"])
            self.assertFalse(os.path.exists(shown))
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivery_status"], "pending")

    def test_mixed_accepted_rejected(self):
        """F1 fail-loud 契约: 输入含任一包外 URL → 整体 ok:false, shown/package 均不修改。"""
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/b/2"])
            r = pipe.record_delivery(pkg, shown, ["https://x.com/a/1", "https://x.com/evil/9"])
            self.assertFalse(r["ok"])
            self.assertEqual(r["marked"], 0)
            self.assertEqual(r["rejected"], ["https://x.com/evil/9"])
            # shown 未被修改(合法 URL 也未登记):
            self.assertFalse(os.path.exists(shown))
            # package 未被修改:
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivered_urls"], [])
            self.assertEqual(pkg_data["delivery_status"], "pending")

    def test_idempotent_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            pipe.record_delivery(pkg, shown, ["https://x.com/a/1"])
            r2 = pipe.record_delivery(pkg, shown, ["https://x.com/a/1"])
            self.assertTrue(r2["ok"])
            data = json.load(open(shown))
            self.assertEqual(len(data["urls"]), 1)
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivered_urls"], ["https://x.com/a/1"])

    def test_failure_does_not_mark_shown(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            r = pipe.mark_failed(pkg)
            self.assertTrue(r["ok"])
            self.assertFalse(os.path.exists(shown))
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivery_status"], "failed")

    def test_verify_delivery_reports_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/b/2", "https://x.com/c/3"])
            pipe.record_delivery(pkg, shown, ["https://x.com/b/2"])
            v = pipe.verify_delivery(pkg, shown)
            self.assertEqual(v["selected"], 3)
            self.assertEqual(v["delivered"], 1)
            self.assertEqual(len(v["missing"]), 2)

    def test_mark_delivered_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/b/2"])
            code = pipe._mark_delivered_cli(["mark-delivered", "--package", pkg,
                                             "--shown", shown, "--urls", "https://x.com/b/2"])
            self.assertEqual(code, 0)
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/b/2"])

    def test_prepare_then_confirm_after_delivery_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/b/2"])
            prepared = pipe.prepare_delivery(pkg, ["https://x.com/b/2"],
                                             cron_job_id="cron-x", now=123)
            self.assertTrue(prepared["ok"])
            self.assertFalse(os.path.exists(shown))
            pkg_data = json.load(open(pkg))
            self.assertEqual(pkg_data["delivery_status"], "prepared")
            self.assertEqual(pkg_data["pending_urls"], ["https://x.com/b/2"])

            confirmed = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", cron_job_id="cron-x")
            self.assertTrue(confirmed["ok"])
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/b/2"])
            self.assertEqual(json.load(open(pkg))["delivery_status"], "delivered")

    def test_prepare_accepts_outside_package_urls(self):
        """2026-08-14 契约更新: prepare 接受 AI 草稿实际采用的包外 URL(否则永不登记 shown,
        下一轮重复投递)。包外 URL 计入 pending_urls, 不拒绝。"""
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            result = pipe.prepare_delivery(
                pkg, ["https://x.com/a/1", "https://x.com/evil/9"],
                cron_job_id="cron-x", now=123)
            self.assertTrue(result["ok"])
            self.assertEqual(result["prepared"], 2)
            self.assertEqual(result["rejected"], [])
            pkg_data = json.load(open(pkg))
            self.assertIn("https://x.com/evil/9", pkg_data["pending_urls"])

    def test_failed_receipt_does_not_mark_shown(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            pipe.prepare_delivery(pkg, ["https://x.com/a/1"], cron_job_id="cron-x")
            result = pipe.confirm_prepared_delivery(
                pkg, shown, "not-delivered", cron_job_id="cron-x")
            self.assertTrue(result["ok"])
            self.assertFalse(os.path.exists(shown))
            self.assertEqual(json.load(open(pkg))["delivery_status"], "failed")

    def test_receipt_for_other_cron_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            pipe.prepare_delivery(pkg, ["https://x.com/a/1"], cron_job_id="cron-x")
            result = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", cron_job_id="other")
            self.assertTrue(result["ok"])
            self.assertTrue(result["noop"])
            self.assertFalse(os.path.exists(shown))


class TestWanderInPackage(unittest.TestCase):
    """决策包附机械层邻域候选(数据驱动, 1–2 跳, 禁区过滤), 选题权在 AI。"""

    def test_explore_candidates_attached_when_graph_provided(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            graph = os.path.join(tmp, "graph.json")
            aliases = os.path.join(tmp, "aliases.json")
            state = os.path.join(tmp, "state.json")
            with open(tl, "w") as f:
                for i in range(5):
                    f.write(json.dumps({"id": str(i), "url": f"u{i}",
                                        "text": f"t{i}", "source": "x"}) + "\n")
            with open(graph, "w") as f:
                json.dump({
                    "anchors": ["fitness", "ai-agent"],
                    "restricted": ["badminton"],
                    "edges": [
                        {"from": "fitness", "to": "badminton", "hop": 1, "bridge": "羽毛球(禁区)"},
                        {"from": "fitness", "to": "home-workout", "hop": 1, "bridge": "居家健身"},
                        {"from": "ai-agent", "to": "agent-ux", "hop": 1, "bridge": "人机协作边界"},
                        {"from": "agent-ux", "to": "human-supervision", "hop": 2, "bridge": "人类监督设计"},
                    ],
                }, f, ensure_ascii=False)
            with open(aliases, "w") as f:
                json.dump({"羽毛球": "badminton"}, f, ensure_ascii=False)
            with open(state, "w") as f:
                json.dump({"topics": {}, "cooldown_s": 3600}, f)
            pkg = pipe.build_package(tl, last, recent=10, graph_path=graph,
                                     aliases_path=aliases, state_path=state, wander_now=1000)
            self.assertIn("explore_candidates", pkg)
            topics = {c["topic"] for c in pkg["explore_candidates"]}
            self.assertNotIn("badminton", topics)
            self.assertIn("home-workout", topics)
            self.assertIn("agent-ux", topics)
            self.assertIn("human-supervision", topics)
            for c in pkg["explore_candidates"]:
                self.assertLessEqual(c["hop"], 2)
            self.assertTrue(pkg["wander"]["config_loaded"])

    def test_no_graph_no_wander_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            tl = os.path.join(tmp, "tl.jsonl")
            last = os.path.join(tmp, "last.json")
            with open(tl, "w") as f:
                f.write(json.dumps({"id": "1", "url": "u1", "text": "Codex",
                                    "source": "x"}) + "\n")
            pkg = pipe.build_package(tl, last, recent=10)
            self.assertNotIn("explore_candidates", pkg)
            self.assertNotIn("wander", pkg)


class TestAgentAdoptedUrlRegistration(unittest.TestCase):
    """回归测试(2026-08-14 修复): AI 草稿实际采用的 URL 无论是否在 selected_urls,
    只要投递回执 delivered, 必须登记 shown, 否则下一轮重复投递。
    复现 05:17 轮三条重复 + realchendahuang 4 轮重复的根因。
    """

    def _pkg(self, path, urls):
        with open(path, "w") as f:
            json.dump({"delivery_id": "x-1", "selected_urls": urls,
                       "delivered_urls": [], "delivery_status": "pending"}, f)

    def test_prepare_accepts_agent_adopted_urls_outside_selected(self):
        """prepare-delivery 不应拒绝草稿实际采用的包外 URL。"""
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            r = pipe.prepare_delivery(
                pkg, ["https://x.com/a/1", "https://x.com/agent-picked/9"],
                cron_job_id="cron-x", now=123)
            self.assertTrue(r["ok"], msg=f"prepare rejected: {r}")
            self.assertEqual(r["rejected"], [])
            pkg_data = json.load(open(pkg))
            self.assertIn("https://x.com/agent-picked/9", pkg_data["pending_urls"])

    def test_confirm_delivered_registers_out_of_selected_urls(self):
        """confirm delivered 时, pending 里的包外 URL 也必须登记 shown。"""
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1"])
            prepared = pipe.prepare_delivery(
                pkg, ["https://x.com/a/1", "https://x.com/agent-picked/9"],
                cron_job_id="cron-x", now=123)
            self.assertTrue(prepared["ok"])
            confirmed = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", cron_job_id="cron-x")
            self.assertTrue(confirmed["ok"], msg=f"confirm failed: {confirmed}")
            self.assertEqual(confirmed["marked"], 2)
            data = json.load(open(shown))
            self.assertIn("https://x.com/a/1", data["urls"])
            self.assertIn("https://x.com/agent-picked/9", data["urls"])
            # 下一轮 analyze 不会再把 agent-picked/9 当新内容:
            state = pipe._shown_state(shown)
            self.assertIn("https://x.com/agent-picked/9", state["urls"])

    def test_next_round_does_not_reselect_delivered_url(self):
        """回归: 登记后同一 URL 不再被 verify_delivery 报缺失/被重选。"""
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "pkg.json")
            shown = os.path.join(tmp, "shown.json")
            self._pkg(pkg, ["https://x.com/a/1", "https://x.com/agent-picked/9"])
            pipe.prepare_delivery(
                pkg, ["https://x.com/a/1", "https://x.com/agent-picked/9"],
                cron_job_id="cron-x", now=123)
            pipe.confirm_prepared_delivery(pkg, shown, "delivered", cron_job_id="cron-x")
            v = pipe.verify_delivery(pkg, shown)
            self.assertEqual(v["missing"], [])
