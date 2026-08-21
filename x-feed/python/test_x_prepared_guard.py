#!/usr/bin/env python3
"""未决投递保护测试(落地指南 §7.3)——先红后绿。

锁住四类行为:
- prepared package 阻止新收集且所有数据文件不变;
- delivered/failed/不存在的 package 不阻止下一轮;
- confirm-prepared delivered 仍然幂等;
- confirm-prepared not-delivered 不写 shown, 并解除 pending。

主 pipeline 的 guard 行为通过真实 CLI(subprocess + DSH_X_FEED_DATA_DIR)
验证，与 X 业务运行时的 execFile 调用方式一致。
运行: python3 -m unittest test_x_prepared_guard -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_insight_pipeline as pipe

HERE = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.join(HERE, "x_insight_pipeline.py")


def run_main(data_dir, extra_args=None):
    """以真实子进程运行主 pipeline, 显式设置 DSH_X_FEED_DATA_DIR。"""
    env = dict(os.environ)
    env["DSH_X_FEED_DATA_DIR"] = data_dir
    return subprocess.run(
        [sys.executable, PIPELINE] + (extra_args or []),
        capture_output=True, text=True, env=env, timeout=60)


def last_json(stdout):
    lines = [line for line in stdout.strip().splitlines() if line.strip()]
    return json.loads(lines[-1]) if lines else {}


class TestDeliveryReceiptPendingFlag(unittest.TestCase):
    """delivery_receipt_pending() 纯函数判定。"""

    def test_prepared_package_is_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "x_insight_package.json")
            with open(pkg, "w") as f:
                json.dump({"delivery_status": "prepared", "pending_urls": ["https://x.com/u/1"]}, f)
            self.assertTrue(pipe.delivery_receipt_pending(pkg))

    def test_delivered_failed_missing_are_not_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            for status in ("delivered", "failed"):
                pkg = os.path.join(tmp, "pkg-%s.json" % status)
                with open(pkg, "w") as f:
                    json.dump({"delivery_status": status}, f)
                self.assertFalse(pipe.delivery_receipt_pending(pkg),
                                 "%s 不应视为 pending" % status)
            self.assertFalse(pipe.delivery_receipt_pending(os.path.join(tmp, "missing.json")))

    def test_corrupt_package_is_not_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "corrupt.json")
            with open(pkg, "w") as f:
                f.write("{not json")
            self.assertFalse(pipe.delivery_receipt_pending(pkg))


class TestMainGuardCli(unittest.TestCase):
    """主 pipeline CLI 的 fail-closed 行为。"""

    def test_prepared_package_blocks_new_collection_and_keeps_all_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "x_insight_package.json")
            with open(pkg, "w") as f:
                json.dump({"delivery_status": "prepared",
                           "pending_urls": ["https://x.com/u/1"],
                           "delivery_cron_job_id": "cron-x-test"}, f)
            tl = os.path.join(tmp, "x_timeline.jsonl")
            tl_before = '{"id": "1", "url": "https://x.com/u/1", "text": "t"}\n'
            with open(tl, "w") as f:
                f.write(tl_before)
            shown = os.path.join(tmp, "x_shown.json")
            shown_before = '{"urls": [], "ids": []}\n'
            with open(shown, "w") as f:
                f.write(shown_before)
            # 不带 --no-collect: guard 必须在尝试 Chrome/CDP 之前触发
            r = run_main(tmp, ["--rolls", "8", "--sleep", "2"])
            self.assertNotEqual(r.returncode, 0)
            result = last_json(r.stdout)
            self.assertFalse(result.get("ok"))
            self.assertEqual(result.get("error_class"), "delivery_receipt_pending")
            # 不是浏览器不可用——证明根本没走到 collection
            self.assertNotIn("browser_unavailable", r.stdout)
            # 所有数据文件原样
            with open(pkg) as f:
                self.assertEqual(json.load(f)["delivery_status"], "prepared")
            with open(tl) as f:
                self.assertEqual(f.read(), tl_before)
            with open(shown) as f:
                self.assertEqual(f.read(), shown_before)
            self.assertFalse(os.path.exists(os.path.join(tmp, "x_collections")))

    def test_delivered_and_failed_packages_do_not_block_next_round(self):
        for status in ("delivered", "failed"):
            with tempfile.TemporaryDirectory() as tmp:
                with open(os.path.join(tmp, "x_insight_package.json"), "w") as f:
                    json.dump({"delivery_status": status}, f)
                r = run_main(tmp, ["--no-collect"])
                self.assertEqual(r.returncode, 0,
                                 "%s 不应阻止下一轮: %s %s" % (status, r.stdout, r.stderr))
                # 下一轮正常生成新 package(尚未 prepare, 因此无 delivery_status 或非 prepared)
                with open(os.path.join(tmp, "x_insight_package.json")) as f:
                    fresh = json.load(f)
                self.assertNotEqual(fresh.get("delivery_status"), "prepared")

    def test_missing_package_does_not_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run_main(tmp, ["--no-collect"])
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue(os.path.exists(os.path.join(tmp, "x_insight_package.json")))


class TestConfirmPreparedReceipt(unittest.TestCase):
    """confirm-prepared 回执语义(§7.3 后两条)。"""

    def _prepared_package(self, tmp, pending, shown_urls=None, shown_ids=None,
                          pending_theme=None):
        pkg = os.path.join(tmp, "x_insight_package.json")
        with open(pkg, "w") as f:
            package = {"delivery_status": "prepared", "pending_urls": pending,
                       "selected_urls": pending}
            if pending_theme is not None:
                package["pending_theme"] = pending_theme
            json.dump(package, f)
        shown = os.path.join(tmp, "x_shown.json")
        with open(shown, "w") as f:
            json.dump({"urls": shown_urls or [], "ids": shown_ids or []}, f)
        return pkg, shown

    def test_confirm_prepared_delivered_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], shown_urls=[])
            last = os.path.join(tmp, "x_last_theme.json")
            with open(last, "w") as f:
                json.dump({"theme": "old"}, f)
            first = pipe.confirm_prepared_delivery(pkg, shown, "delivered",
                                                    last_theme_path=last)
            self.assertTrue(first["ok"])
            self.assertEqual(first["marked"], 1)
            with open(shown) as f:
                self.assertEqual(json.load(f)["urls"], ["https://x.com/u/1"])
            # 第二次回执: 不再是 prepared → noop, shown 不重复增加
            second = pipe.confirm_prepared_delivery(pkg, shown, "delivered",
                                                     last_theme_path=last)
            self.assertTrue(second["ok"])
            self.assertEqual(second.get("noop"), True)
            with open(shown) as f:
                self.assertEqual(json.load(f)["urls"], ["https://x.com/u/1"])
            with open(last) as f:
                self.assertEqual(json.load(f), {"theme": "old"})

    def test_confirm_prepared_not_delivered_does_not_write_shown_and_clears_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], shown_urls=["https://x.com/u/0"])
            r = pipe.confirm_prepared_delivery(pkg, shown, "not-delivered")
            self.assertTrue(r["ok"])
            self.assertEqual(r["status"], "failed")
            # shown 未增加
            with open(shown) as f:
                self.assertEqual(json.load(f)["urls"], ["https://x.com/u/0"])
            # pending 已解除, 下一轮不被 guard 拦截
            with open(pkg) as f:
                package = json.load(f)
            self.assertEqual(package["delivery_status"], "failed")
            self.assertNotIn("pending_urls", package)
            self.assertFalse(pipe.delivery_receipt_pending(pkg))

    def test_prepare_and_delivered_confirm_commits_theme_without_preexisting_last_theme(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "x_insight_package.json")
            shown = os.path.join(tmp, "x_shown.json")
            last = os.path.join(tmp, "x_last_theme.json")
            with open(pkg, "w") as f:
                json.dump({"delivery_status": "pending", "selected_urls": ["https://x.com/u/1"]}, f)

            prepared = pipe.prepare_delivery(
                pkg, ["https://x.com/u/1"], cron_job_id="cron-x",
                pending_theme="agentic-systems")
            self.assertTrue(prepared["ok"])
            package = json.load(open(pkg))
            self.assertEqual(package["pending_theme"], "agentic-systems")
            self.assertEqual(package["delivery_status"], "prepared")
            self.assertFalse(os.path.exists(shown))
            self.assertFalse(os.path.exists(last))

            confirmed = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", cron_job_id="cron-x", last_theme_path=last)
            self.assertTrue(confirmed["ok"])
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/u/1"])
            self.assertEqual(json.load(open(last)), {"theme": "agentic-systems"})
            package = json.load(open(pkg))
            self.assertEqual(package["delivery_status"], "delivered")
            self.assertNotIn("pending_urls", package)
            self.assertNotIn("pending_theme", package)

    def test_prepare_rejects_empty_untrimmed_or_oversized_theme_before_write(self):
        for theme in ("", " agentic-systems", "agentic-systems ", "x" * 129):
            with self.subTest(theme=repr(theme)), tempfile.TemporaryDirectory() as tmp:
                pkg = os.path.join(tmp, "x_insight_package.json")
                with open(pkg, "w") as f:
                    json.dump({"delivery_status": "pending"}, f)
                before = open(pkg).read()
                result = pipe.prepare_delivery(
                    pkg, ["https://x.com/u/1"], pending_theme=theme)
                self.assertFalse(result["ok"])
                self.assertEqual(result["reason"], "invalid_pending_theme")
                self.assertEqual(open(pkg).read(), before)

    def test_not_delivered_clears_theme_without_touching_existing_last_theme(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "x_insight_package.json")
            shown = os.path.join(tmp, "x_shown.json")
            last = os.path.join(tmp, "x_last_theme.json")
            with open(pkg, "w") as f:
                json.dump({"delivery_status": "pending", "selected_urls": ["https://x.com/u/1"]}, f)
            with open(shown, "w") as f:
                json.dump({"urls": ["https://x.com/u/0"], "ids": []}, f)
            with open(last, "w") as f:
                json.dump({"theme": "old"}, f)

            pipe.prepare_delivery(
                pkg, ["https://x.com/u/1"], cron_job_id="cron-x",
                pending_theme="agentic-systems")
            result = pipe.confirm_prepared_delivery(
                pkg, shown, "not-delivered", cron_job_id="cron-x", last_theme_path=last)

            self.assertTrue(result["ok"])
            package = json.load(open(pkg))
            self.assertEqual(package["delivery_status"], "failed")
            self.assertNotIn("pending_urls", package)
            self.assertNotIn("pending_theme", package)
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/u/0"])
            self.assertEqual(json.load(open(last)), {"theme": "old"})

    def test_delivered_and_failed_replays_are_noops(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], pending_theme="agentic-systems")
            last = os.path.join(tmp, "x_last_theme.json")
            first = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", last_theme_path=last)
            replay = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", last_theme_path=last)
            self.assertTrue(first["ok"])
            self.assertTrue(replay["noop"])
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/u/1"])
            self.assertEqual(json.load(open(last)), {"theme": "agentic-systems"})

            failed_pkg, failed_shown = self._prepared_package(
                tmp, ["https://x.com/u/2"], pending_theme="agentic-systems")
            failed_last = os.path.join(tmp, "failed_last_theme.json")
            failed = pipe.confirm_prepared_delivery(
                failed_pkg, failed_shown, "not-delivered", last_theme_path=failed_last)
            failed_replay = pipe.confirm_prepared_delivery(
                failed_pkg, failed_shown, "not-delivered", last_theme_path=failed_last)
            self.assertEqual(failed["status"], "failed")
            self.assertTrue(failed_replay["noop"])
            self.assertEqual(json.load(open(failed_shown))["urls"], [])
            self.assertFalse(os.path.exists(failed_last))

    def test_wrong_cron_is_zero_state_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], pending_theme="agentic-systems")
            last = os.path.join(tmp, "x_last_theme.json")
            with open(pkg) as f:
                package = json.load(f)
            package["delivery_cron_job_id"] = "cron-x"
            with open(pkg, "w") as f:
                json.dump(package, f)
            before = open(pkg).read()
            result = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", cron_job_id="other",
                last_theme_path=last)
            self.assertTrue(result["noop"])
            self.assertEqual(open(pkg).read(), before)
            self.assertEqual(json.load(open(shown))["urls"], [])
            self.assertFalse(os.path.exists(last))

    def test_replay_after_shown_commit_but_before_last_theme_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], pending_theme="agentic-systems")
            last = os.path.join(tmp, "x_last_theme.json")
            original = pipe._atomic_json_write

            def fail_before_last(path, data):
                if path == last:
                    raise RuntimeError("injected last-theme failure")
                original(path, data)

            with mock.patch.object(pipe, "_atomic_json_write", side_effect=fail_before_last):
                with self.assertRaises(RuntimeError):
                    pipe.confirm_prepared_delivery(
                        pkg, shown, "delivered", last_theme_path=last)
            self.assertEqual(json.load(open(pkg))["delivery_status"], "prepared")
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/u/1"])
            self.assertFalse(os.path.exists(last))

            result = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", last_theme_path=last)
            self.assertTrue(result["ok"])
            self.assertEqual(json.load(open(last)), {"theme": "agentic-systems"})
            self.assertEqual(json.load(open(pkg))["delivery_status"], "delivered")

    def test_replay_after_last_theme_commit_but_before_package_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], pending_theme="agentic-systems")
            last = os.path.join(tmp, "x_last_theme.json")
            original = pipe._atomic_json_write

            def fail_before_package(path, data):
                if path == pkg:
                    raise RuntimeError("injected package failure")
                original(path, data)

            with mock.patch.object(pipe, "_atomic_json_write", side_effect=fail_before_package):
                with self.assertRaises(RuntimeError):
                    pipe.confirm_prepared_delivery(
                        pkg, shown, "delivered", last_theme_path=last)
            self.assertEqual(json.load(open(pkg))["delivery_status"], "prepared")
            self.assertEqual(json.load(open(shown))["urls"], ["https://x.com/u/1"])
            self.assertEqual(json.load(open(last)), {"theme": "agentic-systems"})

            result = pipe.confirm_prepared_delivery(
                pkg, shown, "delivered", last_theme_path=last)
            self.assertTrue(result["ok"])
            package = json.load(open(pkg))
            self.assertEqual(package["delivery_status"], "delivered")
            self.assertNotIn("pending_urls", package)
            self.assertNotIn("pending_theme", package)


if __name__ == "__main__":
    unittest.main()
