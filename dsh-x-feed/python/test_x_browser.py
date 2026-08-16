"""X browser recovery tests.

Run with: python3 -m unittest test_x_browser -v
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import x_browser


class TestTabClassification(unittest.TestCase):
    def test_x_tab_requires_x_host(self):
        self.assertTrue(x_browser.is_x_tab({"type": "page", "url": "https://x.com/home"}))
        self.assertTrue(x_browser.is_x_tab({"type": "page", "url": "https://twitter.com/home"}))
        self.assertFalse(x_browser.is_x_tab({"type": "page", "url": "https://example.com/x.com"}))
        self.assertFalse(x_browser.is_x_tab({"type": "page", "url": "about:blank"}))

    def test_login_state_is_not_inferred_from_missing_tab(self):
        self.assertEqual(x_browser.classify_x_page("https://x.com/home", ""), "ready")
        self.assertEqual(
            x_browser.classify_x_page("https://x.com/i/flow/login", "Sign in to X"),
            "not_logged_in",
        )
        self.assertEqual(
            x_browser.classify_x_page("https://x.com/home", "Something went wrong"),
            "page_error",
        )


class TestEnsureXTab(unittest.TestCase):
    @mock.patch.object(x_browser, "new_tab")
    @mock.patch.object(x_browser, "list_tabs")
    @mock.patch.object(x_browser, "ensure_cdp")
    def test_creates_x_tab_when_browser_is_up_but_x_tab_is_missing(
        self, ensure_cdp, list_tabs, new_tab
    ):
        ensure_cdp.return_value = {"ok": True, "recovered": False}
        list_tabs.side_effect = [
            [{"type": "page", "url": "about:blank"}],
            [{"type": "page", "url": "https://x.com/home", "id": "new",
              "webSocketDebuggerUrl": "ws://x/new"}],
        ]
        new_tab.return_value = {"type": "page", "url": "https://x.com/home", "id": "new"}

        tab = x_browser.ensure_x_tab()

        self.assertEqual(tab["id"], "new")
        new_tab.assert_called_once_with(x_browser.X_HOME_URL)

    @mock.patch.object(x_browser, "list_tabs")
    @mock.patch.object(x_browser, "ensure_cdp")
    def test_returns_structured_failure_when_tab_creation_fails(self, ensure_cdp, list_tabs):
        ensure_cdp.return_value = {"ok": True, "recovered": False}
        list_tabs.return_value = []
        with mock.patch.object(x_browser, "new_tab", side_effect=x_browser.BrowserRecoveryError("tab_unavailable")):
            with self.assertRaises(x_browser.BrowserRecoveryError) as ctx:
                x_browser.ensure_x_tab()
        self.assertEqual(ctx.exception.code, "tab_unavailable")


class TestEnsureCdp(unittest.TestCase):
    @mock.patch.object(x_browser, "run_browser_start")
    @mock.patch.object(x_browser, "cdp_ready")
    def test_starts_browser_when_cdp_is_down(self, cdp_ready, run_browser_start):
        cdp_ready.side_effect = [False, True]
        run_browser_start.return_value = 0

        result = x_browser.ensure_cdp()

        self.assertTrue(result["ok"])
        self.assertTrue(result["recovered"])
        run_browser_start.assert_called_once_with(restart=False)

    @mock.patch.object(x_browser, "run_browser_start")
    @mock.patch.object(x_browser, "cdp_ready")
    def test_reports_browser_failure_separately(self, cdp_ready, run_browser_start):
        cdp_ready.return_value = False
        run_browser_start.return_value = 1

        with self.assertRaises(x_browser.BrowserRecoveryError) as ctx:
            x_browser.ensure_cdp()
        self.assertEqual(ctx.exception.code, "browser_unavailable")


if __name__ == "__main__":
    unittest.main()
