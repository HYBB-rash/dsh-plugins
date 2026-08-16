#!/usr/bin/env python3
"""未决投递保护测试(落地指南 §7.3)——先红后绿。

锁住四类行为:
- prepared package 阻止新收集且所有数据文件不变;
- delivered/failed/不存在的 package 不阻止下一轮;
- confirm-prepared delivered 仍然幂等;
- confirm-prepared not-delivered 不写 shown, 并解除 pending。

主 pipeline 的 guard 行为通过真实 CLI(subprocess + DSH_X_FEED_DATA_DIR)
验证, 与 dsh-x-feed 插件的 execFile 调用方式一致。
运行: python3 -m unittest test_x_prepared_guard -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

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

    def _prepared_package(self, tmp, pending, shown_urls=None, shown_ids=None):
        pkg = os.path.join(tmp, "x_insight_package.json")
        with open(pkg, "w") as f:
            json.dump({"delivery_status": "prepared", "pending_urls": pending,
                       "selected_urls": pending}, f)
        shown = os.path.join(tmp, "x_shown.json")
        with open(shown, "w") as f:
            json.dump({"urls": shown_urls or [], "ids": shown_ids or []}, f)
        return pkg, shown

    def test_confirm_prepared_delivered_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg, shown = self._prepared_package(
                tmp, ["https://x.com/u/1"], shown_urls=[])
            first = pipe.confirm_prepared_delivery(pkg, shown, "delivered")
            self.assertTrue(first["ok"])
            self.assertEqual(first["marked"], 1)
            with open(shown) as f:
                self.assertEqual(json.load(f)["urls"], ["https://x.com/u/1"])
            # 第二次回执: 不再是 prepared → noop, shown 不重复增加
            second = pipe.confirm_prepared_delivery(pkg, shown, "delivered")
            self.assertTrue(second["ok"])
            self.assertEqual(second.get("noop"), True)
            with open(shown) as f:
                self.assertEqual(json.load(f)["urls"], ["https://x.com/u/1"])

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


if __name__ == "__main__":
    unittest.main()
