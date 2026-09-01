"""RED contract for the fixed personal-feed observer production CLI.

The implementation is deliberately imported inside each test.  A missing
production module therefore reports the same actionable capability failure
for every contract instead of breaking unittest collection.
"""

import ast
import contextlib
import importlib
import inspect
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest import mock


MODULE_NAME = "x_personal_feed_observer_cli"
SOURCE_PATH = Path(__file__).with_name(MODULE_NAME + ".py")
MISSING_CAPABILITY = "personal Feed X observer production CLI capability is missing"
INVALID_LINE = '{"schemaVersion":1,"kind":"invalid_input"}\n'
TIMESTAMP = "2026-09-01T00:00:00.000Z"
REQUEST_ID = "telegram:7:11"
SHANGHAI_DAY = "2026-09-01"
VALID_REQUEST = (
    b'{"schemaVersion":1,"requestId":"telegram:7:11",'
    b'"cutoff":"2026-09-01T00:00:00.000Z","shanghaiDay":"2026-09-01",'
    b'"deadlineEpochMs":2000000000000}'
)
EXPIRED_REQUEST = (
    b'{"schemaVersion":1,"requestId":"telegram:7:11",'
    b'"cutoff":"2026-09-01T00:00:00.000Z","shanghaiDay":"2026-09-01",'
    b'"deadlineEpochMs":1}'
)
SURFACE_TARGETS = {
    "for_you": "https://x.com/home",
    "following": "https://x.com/home",
    "explore": "https://x.com/explore",
}
SURFACE_PROOFS = {
    "for_you": {"pathname": "/home", "selectedHomeTabOrdinal": 0, "exploreRoot": False},
    "following": {"pathname": "/home", "selectedHomeTabOrdinal": 1, "exploreRoot": False},
    "explore": {"pathname": "/explore", "selectedHomeTabOrdinal": None, "exploreRoot": True},
}

if str(SOURCE_PATH.parent) not in sys.path:
    sys.path.insert(0, str(SOURCE_PATH.parent))


def _surface_facts(surface, *, selected=None, loading=0, root_count=None,
                   home_tablist_count=None, home_tabs=None, explore_root_count=None,
                   outside_selected_tabs=None, pathname=None):
    if surface in {"for_you", "following"}:
        selected = 0 if selected is None and surface == "for_you" else selected
        selected = 1 if selected is None else selected
        root_count = 1 if root_count is None else root_count
        home_tablist_count = 1 if home_tablist_count is None else home_tablist_count
        home_tabs = (
            [{"ordinal": 0, "selected": selected == 0},
             {"ordinal": 1, "selected": selected == 1}]
            if home_tabs is None else home_tabs
        )
        explore_root_count = 0 if explore_root_count is None else explore_root_count
        pathname = "/home" if pathname is None else pathname
    else:
        root_count = 0 if root_count is None else root_count
        home_tablist_count = 0 if home_tablist_count is None else home_tablist_count
        home_tabs = [] if home_tabs is None else home_tabs
        explore_root_count = 1 if explore_root_count is None else explore_root_count
        pathname = "/explore" if pathname is None else pathname
    return {
        "pathname": pathname,
        "rootCount": root_count,
        "loadingCount": loading,
        "homeTablistCount": home_tablist_count,
        "homeTabs": home_tabs,
        "exploreRootCount": explore_root_count,
        "outsideRootSelectedTabs": [] if outside_selected_tabs is None else outside_selected_tabs,
    }


def _surface_decision_result(surface, activate_ordinal=None):
    value = {"surfaceProof": dict(SURFACE_PROOFS[surface])}
    if activate_ordinal is not None:
        value["activateOrdinal"] = activate_ordinal
    return value


def _empty_facts(surface, **counts):
    value = {
        "surfaceProof": dict(SURFACE_PROOFS[surface]),
        "surfaceRootCount": 1,
        "emptyMarkerCount": 0,
        "outsideRootEmptyMarkerCount": 0,
        "loadingCount": 0,
        "loginCount": 0,
        "authCount": 0,
        "errorCount": 0,
        "retryCount": 0,
    }
    value.update(counts)
    return value


def _require_cli(case):
    # x_timeline_store derives its lock path at import time.  Point that
    # derivation at a non-default, non-production location and restore the
    # caller's environment before returning; the tests never let this lock
    # implementation touch the path.
    data_dir = str(Path(tempfile.gettempdir()) / "personal-feed-observer-cli-test-data")
    previous = os.environ.get("DSH_X_FEED_DATA_DIR")
    os.environ["DSH_X_FEED_DATA_DIR"] = data_dir
    try:
        return importlib.import_module(MODULE_NAME)
    except ModuleNotFoundError as exc:
        if exc.name == MODULE_NAME:
            case.fail(MISSING_CAPABILITY)
        raise
    finally:
        if previous is None:
            os.environ.pop("DSH_X_FEED_DATA_DIR", None)
        else:
            os.environ["DSH_X_FEED_DATA_DIR"] = previous


def _compact_line(case, stream):
    value = stream.getvalue()
    case.assertTrue(value.endswith("\n"))
    case.assertEqual(value.count("\n"), 1)
    payload = value[:-1]
    parsed = json.loads(payload)
    case.assertEqual(
        payload,
        json.dumps(parsed, ensure_ascii=False, separators=(",", ":")),
    )
    return parsed


def _assert_invalid_line(case, stdout):
    case.assertEqual(stdout, INVALID_LINE)
    _compact_line(case, io.StringIO(stdout))


def _assert_body_free_incomplete(case, result):
    case.assertIsInstance(result, dict)
    case.assertEqual(result.get("kind"), "incomplete")
    serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    for field in ("body", "text", "sourceUrl", "authorHandle", "publishedAt"):
        case.assertNotIn(field, serialized)


def _run_child(source, raw):
    """Run one bounded child and always reap it, including timeout paths."""
    process = subprocess.Popen(
        [sys.executable, str(source)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        try:
            stdout, stderr = process.communicate(input=raw, timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
            raise AssertionError("production CLI child exceeded bounded test timeout")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    return process.returncode, stdout, stderr


def _json_bootstrap(source, result):
    result_literal = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    return (
        "import json,sys;"
        f"sys.path.insert(0,{str(source.parent)!r});"
        f"import {MODULE_NAME} as m;"
        f"result=json.loads({result_literal!r});"
        "raise SystemExit(m.main(sys.stdin.buffer,sys.stdout,observer=lambda _deadline: result))"
    )


def _run_bootstrap(source, result):
    process = subprocess.Popen(
        [sys.executable, "-c", _json_bootstrap(source, result)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        try:
            stdout, stderr = process.communicate(input=VALID_REQUEST, timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
            raise AssertionError("python -c CLI bootstrap exceeded bounded test timeout")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    return process.returncode, stdout, stderr


def _response_value(action, surface="for_you"):
    if action == "navigate":
        return {"url": SURFACE_TARGETS[surface], "body": ""}
    if action == "probe":
        return _surface_facts(surface)
    if action == "snapshot":
        root = {
            "sourceUrl": "https://x.com/alice/status/42",
            "authorHandle": "alice",
            "publishedAt": TIMESTAMP,
            "body": "root",
            "depth": 0,
            "insideQuote": False,
            "showMoreControlCount": 0,
            "placeholder": False,
        }
        nested_quote = {
            "sourceUrl": "https://x.com/bob/status/43",
            "authorHandle": "bob",
            "publishedAt": TIMESTAMP,
            "body": "nested quote",
            "depth": 1,
            "insideQuote": True,
            "showMoreControlCount": 0,
            "placeholder": False,
        }
        return {
            "cells": [{"candidates": [root, nested_quote]}],
            "emptyFacts": _empty_facts(surface),
        }
    if action == "expand":
        return {
            "matchingCellCount": 1,
            "targetRootCount": 1,
            "showMoreControlCount": 1,
            "clicked": True,
        }
    if action == "scroll":
        return {"ok": True}
    raise AssertionError(action)


class _FakeWebSocket:
    def __init__(
        self,
        value,
        *,
        response_id=None,
        recv_error=None,
        oversize=False,
        frame_factory=None,
        raw_frame=None,
        on_settimeout=None,
        on_send=None,
        on_recv=None,
    ):
        self.value = value
        self.response_id = response_id
        self.recv_error = recv_error
        self.oversize = oversize
        self.frame_factory = frame_factory
        self.raw_frame = raw_frame
        self.on_settimeout = on_settimeout
        self.on_send = on_send
        self.on_recv = on_recv
        self.sent = []
        self.closed = False
        self.timeouts = []
        self.recv_count = 0
        self.send_count = 0

    def settimeout(self, value):
        self.timeouts.append(value)
        if self.on_settimeout is not None:
            self.on_settimeout(value)

    def send(self, message):
        self.send_count += 1
        self.sent.append(json.loads(message))
        if self.on_send is not None:
            self.on_send()

    def recv(self):
        self.recv_count += 1
        if self.on_recv is not None:
            self.on_recv()
        if self.recv_error is not None:
            raise self.recv_error
        if self.raw_frame is not None:
            return self.raw_frame
        request_id = self.sent[-1]["id"]
        response_id = request_id if self.response_id is None else self.response_id
        if self.frame_factory is not None:
            response = self.frame_factory(self.sent[-1], response_id, self.value)
        elif self.sent[-1]["method"] == "Page.navigate":
            response = {
                "id": response_id,
                "result": {"frameId": "frame-1", "loaderId": "loader-1"},
            }
        else:
            response = {
                "id": response_id,
                "result": {
                    "result": {"type": "object", "value": self.value},
                },
            }
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        if self.oversize:
            encoded += "x" * (1024 * 1024)
        return encoded

    def close(self):
        self.closed = True


class _FakeHTTPResponse:
    def __init__(self, payload, read_sizes):
        self.payload = payload
        self.read_sizes = read_sizes

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size=-1):
        self.read_sizes.append(size)
        if size < 0:
            raise AssertionError("CDP response must be read with a finite byte cap")
        return self.payload[:size]


class _FakeMonotonic:
    def __init__(self):
        self.value = 0.0
        self.calls = []
        self.sleeps = []

    def __call__(self):
        self.calls.append(self.value)
        return self.value

    def advance(self, seconds):
        self.value += seconds

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.advance(seconds)


class TestPersonalFeedObserverCli(unittest.TestCase):
    def test_fixed_production_entry_and_real_child_wire(self):
        module = _require_cli(self)
        self.assertTrue(SOURCE_PATH.is_file())
        signature = inspect.signature(module.main)
        self.assertEqual(list(signature.parameters), ["stdin", "stdout", "observer"])
        self.assertIs(signature.parameters["observer"].default, None)
        source = inspect.getsource(module)
        self.assertRegex(source, r"if\s+__name__\s*==\s*[\"']__main__[\"']")

        for raw in (b"not-json", b"{" + b"a" * 4097 + b"}"):
            with self.subTest(raw_size=len(raw)):
                returncode, stdout, stderr = _run_child(SOURCE_PATH, raw)
                self.assertEqual(returncode, 0)
                self.assertEqual(stderr, b"")
                _assert_invalid_line(self, stdout.decode("utf-8"))

        success = {
            "schemaVersion": 1,
            "kind": "complete",
            "startedAt": TIMESTAMP,
            "completedAt": TIMESTAMP,
            "surfaces": [],
        }
        incomplete = {
            "schemaVersion": 1,
            "kind": "incomplete",
            "startedAt": TIMESTAMP,
            "completedAt": TIMESTAMP,
            "surfaces": [],
        }
        identity = {
            "requestId": REQUEST_ID,
            "cutoff": TIMESTAMP,
            "shanghaiDay": SHANGHAI_DAY,
        }
        for base, expected in ((success, {**success, **identity}), (incomplete, {**incomplete, **identity})):
            with self.subTest(kind=expected["kind"]):
                returncode, stdout, stderr = _run_bootstrap(SOURCE_PATH, base)
                self.assertEqual(returncode, 0)
                self.assertEqual(stderr, b"")
                self.assertEqual(json.loads(stdout), expected)
                self.assertEqual(
                    stdout.decode("utf-8"),
                    json.dumps(expected, ensure_ascii=False, separators=(",", ":")) + "\n",
                )

    def test_main_requires_exact_request_identity_without_echoing_invalid_identity(self):
        module = _require_cli(self)
        identity = {
            "requestId": REQUEST_ID,
            "cutoff": TIMESTAMP,
            "shanghaiDay": SHANGHAI_DAY,
        }
        result = {
            "schemaVersion": 1,
            "kind": "complete",
            "startedAt": TIMESTAMP,
            "completedAt": TIMESTAMP,
            "surfaces": [],
        }
        observed_deadlines = []
        stdout = io.StringIO()
        rc = module.main(
            io.BytesIO(VALID_REQUEST),
            stdout,
            observer=lambda deadline: (observed_deadlines.append(deadline), result)[1],
        )
        self.assertEqual(rc, 0)
        self.assertEqual(observed_deadlines, [2_000_000_000_000])
        self.assertEqual(_compact_line(self, stdout), {**result, **identity})

        invalid_inputs = (
            ("extra", {"extra": True}),
            ("missing requestId", {"requestId": None}),
            ("malformed requestId", {"requestId": "identity-canary"}),
            ("zero chat id", {"requestId": "telegram:0:11"}),
            ("zero message id", {"requestId": "telegram:7:0"}),
            ("negative message id", {"requestId": "telegram:7:-11"}),
            ("chat id above JavaScript safe integer", {"requestId": "telegram:9007199254740992:11"}),
            ("message id above JavaScript safe integer", {"requestId": "telegram:7:9007199254740992"}),
            ("malformed cutoff", {"cutoff": "not-a-canonical-cutoff"}),
            ("mismatched Shanghai day", {"shanghaiDay": "2026-09-02"}),
        )
        for name, change in invalid_inputs:
            with self.subTest(case=name):
                request = {
                    "schemaVersion": 1,
                    "requestId": REQUEST_ID,
                    "cutoff": TIMESTAMP,
                    "shanghaiDay": SHANGHAI_DAY,
                    "deadlineEpochMs": 2_000_000_000_000,
                }
                if name == "extra":
                    request.update(change)
                elif name == "missing requestId":
                    request.pop("requestId")
                else:
                    request.update(change)
                invalid_stdout = io.StringIO()
                invalid_stderr = io.StringIO()

                def must_not_run(_deadline):
                    raise AssertionError("observer must not run")

                with contextlib.redirect_stderr(invalid_stderr):
                    rc = module.main(
                        io.BytesIO(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()),
                        invalid_stdout,
                        observer=must_not_run,
                    )
                self.assertEqual(rc, 0)
                self.assertEqual(_compact_line(self, invalid_stdout), {"schemaVersion": 1, "kind": "invalid_input"})
                serialized = invalid_stdout.getvalue() + invalid_stderr.getvalue()
                self.assertEqual(invalid_stderr.getvalue(), "")
                self.assertNotIn("body", serialized)
                self.assertNotIn("canary", serialized)

    def test_default_main_composes_production_observer(self):
        module = _require_cli(self)
        observer_parameter = inspect.signature(module.main).parameters["observer"]
        self.assertIs(observer_parameter.default, None)
        self.assertEqual(observer_parameter.kind, inspect.Parameter.POSITIONAL_OR_KEYWORD)

        clock_type = getattr(module, "_SystemClock", None)
        browser_type = getattr(module, "_ExistingCdpBrowser", None)
        lock_type = getattr(module, "_BoundedBrowserLock", None)
        evaluator_type = getattr(module, "_MechanicalCdpEvaluator", None)
        for adapter in (clock_type, browser_type, lock_type, evaluator_type):
            self.assertIsNotNone(adapter)

        incomplete = {
            "schemaVersion": 1,
            "kind": "incomplete",
            "startedAt": TIMESTAMP,
            "completedAt": TIMESTAMP,
            "surfaces": [],
            "requestId": REQUEST_ID,
            "cutoff": TIMESTAMP,
            "shanghaiDay": SHANGHAI_DAY,
        }
        observe_owner = getattr(module, "x_personal_feed_observer", None)
        patches = []
        if observe_owner is not None:
            patches.append(mock.patch.object(observe_owner, "observe", return_value=incomplete))
        if hasattr(module, "observe"):
            patches.append(mock.patch.object(module, "observe", return_value=incomplete))
        self.assertTrue(patches)

        with contextlib.ExitStack() as stack:
            observed = [stack.enter_context(patcher) for patcher in patches]
            clock_ctor = stack.enter_context(mock.patch.object(module, "_SystemClock", wraps=clock_type))
            browser_ctor = stack.enter_context(
                mock.patch.object(module, "_ExistingCdpBrowser", wraps=browser_type)
            )
            lock_ctor = stack.enter_context(
                mock.patch.object(module, "_BoundedBrowserLock", wraps=lock_type)
            )
            evaluator_ctor = stack.enter_context(
                mock.patch.object(module, "_MechanicalCdpEvaluator", wraps=evaluator_type)
            )
            stdout = io.StringIO()
            result_code = module.main(io.BytesIO(EXPIRED_REQUEST), stdout)

        self.assertEqual(result_code, 0)
        result = _compact_line(self, stdout)
        _assert_body_free_incomplete(self, result)
        self.assertNotEqual(result.get("kind"), "observer_failed")
        self.assertEqual(sum(spy.call_count for spy in observed), 1)
        call = next(spy.call_args for spy in observed if spy.call_count)
        self.assertTrue(call.args)
        self.assertEqual(call.args[0], 1)
        self.assertIsInstance(call.kwargs["clock"], clock_type)
        self.assertIsInstance(call.kwargs["browser"], browser_type)
        self.assertIsInstance(call.kwargs["lock"], lock_type)
        self.assertIsInstance(call.kwargs["evaluator"], evaluator_type)
        self.assertEqual(clock_ctor.call_count, 1)
        self.assertEqual(browser_ctor.call_count, 1)
        self.assertEqual(lock_ctor.call_count, 1)
        self.assertEqual(evaluator_ctor.call_count, 1)

    def test_browser_and_lock_ports_are_bounded_without_recovery(self):
        module = _require_cli(self)
        browser_type = getattr(module, "_ExistingCdpBrowser", None)
        lock_type = getattr(module, "_BoundedBrowserLock", None)
        self.assertIsNotNone(browser_type)
        self.assertIsNotNone(lock_type)

        remaining = 2.5
        read_sizes = []
        requests = []
        responses = {
            "/json/version": b'{"Browser":"Chrome/130"}',
            "/json/list": b'[{"type":"page","url":"https://x.com/home","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/1"}]',
        }

        def urlopen(request, timeout=None):
            requests.append((request, timeout))
            self.assertEqual(request.full_url.split("?", 1)[0], request.full_url)
            self.assertEqual(request.get_method(), "GET")
            path = request.full_url.split("127.0.0.1:9222", 1)[1]
            self.assertIn(path, responses)
            return _FakeHTTPResponse(responses[path], read_sizes)

        # The constructor is intentionally explicit: an existing browser gets
        # a clock/deadline, never a recovery callback or an argv/env selector.
        browser = browser_type(clock=mock.Mock(), deadline_epoch_ms=10_000)
        with mock.patch.object(urllib.request, "urlopen", side_effect=urlopen):
            self.assertTrue(browser.cdp_ready(remaining))
            tabs = browser.list_tabs(remaining)
            self.assertIsInstance(tabs, list)
            before_pure_helpers = len(requests)
            self.assertTrue(browser.is_x_tab(tabs[0]))
            self.assertEqual(browser.classify_x_page("https://x.com/home", ""), "ready")
            self.assertEqual(len(requests), before_pure_helpers)

        self.assertEqual(
            [request.full_url for request, _timeout in requests],
            ["http://127.0.0.1:9222/json/version", "http://127.0.0.1:9222/json/list"],
        )
        for _request, timeout in requests:
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, remaining)
        self.assertTrue(read_sizes)
        self.assertTrue(all(size > 0 for size in read_sizes))

        max_http_bytes = getattr(module, "MAX_HTTP_BYTES", None)
        self.assertIsInstance(max_http_bytes, int)
        self.assertGreater(max_http_bytes, 0)
        legal_exact = b"{}" + b" " * (max_http_bytes - len(b"{}"))
        self.assertEqual(len(legal_exact), max_http_bytes)
        exact_reads = []

        def exact_urlopen(request, timeout=None):
            self.assertEqual(request.full_url, "http://127.0.0.1:9222/json/version")
            return _FakeHTTPResponse(legal_exact, exact_reads)

        with mock.patch.object(urllib.request, "urlopen", side_effect=exact_urlopen):
            self.assertTrue(browser.cdp_ready(remaining))
        self.assertEqual(exact_reads, [max_http_bytes + 1])

        overflow_reads = []
        overflow = legal_exact + b"x"

        def overflow_urlopen(request, timeout=None):
            self.assertEqual(request.full_url, "http://127.0.0.1:9222/json/version")
            return _FakeHTTPResponse(overflow, overflow_reads)

        with mock.patch.object(urllib.request, "urlopen", side_effect=overflow_urlopen):
            self.assertFalse(browser.cdp_ready(remaining))
        self.assertEqual(overflow_reads, [max_http_bytes + 1])

        lock_calls = []

        @contextlib.contextmanager
        def fake_browser_lock(timeout_seconds=None):
            lock_calls.append(timeout_seconds)
            yield

        lock = lock_type()
        patches = [mock.patch.object(module, "browser_lock", fake_browser_lock, create=True)]
        store = getattr(module, "x_timeline_store", None)
        if store is not None:
            patches.append(mock.patch.object(store, "browser_lock", fake_browser_lock))
        with contextlib.ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            with lock.lock(remaining):
                pass
        self.assertEqual(lock_calls, [remaining])
        self.assertGreater(lock_calls[0], 0)

        for forbidden in ("ensure_cdp", "ensure_x_tab", "new_tab", "run_browser_start"):
            replacement = mock.Mock(side_effect=AssertionError(forbidden + " was called"))
            with mock.patch.object(module, forbidden, replacement, create=True):
                with mock.patch.object(urllib.request, "urlopen", side_effect=urlopen):
                    browser.cdp_ready(remaining)
                    browser.list_tabs(remaining)
                    browser.is_x_tab(tabs[0])
                    browser.classify_x_page("https://x.com/home", "")
            replacement.assert_not_called()

    def test_mechanical_cdp_evaluator_uses_fixed_bounded_actions(self):
        module = _require_cli(self)
        evaluator_type = getattr(module, "_MechanicalCdpEvaluator", None)
        self.assertIsNotNone(evaluator_type)
        evaluator = evaluator_type()
        decision = getattr(module, "_surface_decision", None)
        self.assertTrue(callable(decision))

        for surface in ("for_you", "following", "explore"):
            with self.subTest(surface_decision=(surface, "already_selected")):
                facts = _surface_facts(surface)
                result = decision(surface, facts)
                self.assertEqual(result, _surface_decision_result(surface))
                self.assertEqual(
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    '{"surfaceProof":' + json.dumps(
                        SURFACE_PROOFS[surface], ensure_ascii=False, separators=(",", ":")
                    ) + "}",
                )

        for surface, selected, activate in (
            ("for_you", 1, 0),
            ("following", 0, 1),
        ):
            with self.subTest(surface_decision=(surface, "activate")):
                self.assertEqual(
                    decision(surface, _surface_facts(surface, selected=selected)),
                    _surface_decision_result(surface, activate),
                )

        scoped_facts = _surface_facts(
            "for_you",
            selected=0,
            outside_selected_tabs=[
                {"ordinal": 99, "selected": True},
                {"ordinal": 100, "selected": True},
            ],
        )
        self.assertEqual(decision("for_you", scoped_facts), _surface_decision_result("for_you"))

        invalid_decisions = (
            ("home_root_zero", "for_you", {"root_count": 0}),
            ("home_root_two", "following", {"root_count": 2}),
            ("home_tablist_zero", "for_you", {"home_tablist_count": 0}),
            ("home_tablist_two", "following", {"home_tablist_count": 2}),
            ("tab_count_wrong", "for_you", {"home_tabs": [{"ordinal": 0, "selected": True}]}),
            (
                "tab_ordinal_wrong",
                "for_you",
                {"home_tabs": [{"ordinal": 0, "selected": True}, {"ordinal": 2, "selected": False}]},
            ),
            (
                "selected_zero",
                "for_you",
                {"home_tabs": [{"ordinal": 0, "selected": False}, {"ordinal": 1, "selected": False}]},
            ),
            (
                "selected_two",
                "following",
                {"home_tabs": [{"ordinal": 0, "selected": True}, {"ordinal": 1, "selected": True}]},
            ),
            (
                "selected_cannot_unique_activate",
                "for_you",
                {"home_tabs": [{"ordinal": 0, "selected": False}, {"ordinal": 0, "selected": True}]},
            ),
            ("loading", "following", {"loading": 1}),
            ("pathname_wrong", "for_you", {"pathname": "/explore"}),
            ("explore_root_zero", "explore", {"explore_root_count": 0}),
            ("explore_root_two", "explore", {"explore_root_count": 2}),
            (
                "explore_contains_home_selected",
                "explore",
                {
                    "home_tablist_count": 1,
                    "home_tabs": [{"ordinal": 0, "selected": True}, {"ordinal": 1, "selected": False}],
                },
            ),
        )
        decision_error_type = None
        for name, surface, changes in invalid_decisions:
            with self.subTest(surface_decision=(name, surface)):
                with self.assertRaises(Exception) as context:
                    decision(surface, _surface_facts(surface, **changes))
                if decision_error_type is None:
                    decision_error_type = type(context.exception)
                self.assertIs(type(context.exception), decision_error_type)

        ws_url = "ws://127.0.0.1:9222/devtools/page/page-1"
        stable_id = "https://x.com/alice/status/42"
        created = []
        timeout_seconds = 2.0
        current_surface = ["for_you"]

        def create_connection(url, timeout=None, **kwargs):
            self.assertEqual(url, ws_url)
            raw_value = _response_value(current_action[0], current_surface[0])
            if current_action[0] == "navigate":
                raw_value = _surface_facts(current_surface[0])
            socket = _FakeWebSocket(raw_value)
            socket.connection_kwargs = kwargs
            created.append(socket)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, timeout_seconds)
            return socket

        fixed_error_type = None

        def assert_fixed_error(call, canary=None):
            nonlocal fixed_error_type
            with self.assertRaises(Exception) as context:
                call()
            if fixed_error_type is None:
                fixed_error_type = type(context.exception)
            self.assertIs(type(context.exception), fixed_error_type)
            if canary is not None:
                self.assertNotIn(canary, str(context.exception))

        def navigate_sequence(surface, values, capture=None):
            clock = _FakeMonotonic()
            state_checks = [0]
            frame_index = [0]

            def frame_factory(request, response_id, _value):
                if request["method"] == "Page.navigate":
                    return {
                        "id": response_id,
                        "result": {"frameId": "frame-1", "loaderId": "loader-1"},
                    }
                self.assertEqual(request["method"], "Runtime.evaluate")
                self.assertLess(frame_index[0], len(values))
                raw_value, is_state_check = values[frame_index[0]]
                frame_index[0] += 1
                if is_state_check:
                    state_checks[0] += 1
                return {
                    "id": response_id,
                    "result": {
                        "result": {"type": "object", "value": raw_value},
                    },
                }

            sockets = []
            passed_timeouts = []
            if capture is not None:
                capture["sockets"] = sockets
                capture["state_checks"] = state_checks

            def connect(url, timeout=None, **_kwargs):
                self.assertEqual(url, ws_url)
                self.assertGreater(timeout, 0)
                self.assertLessEqual(timeout, timeout_seconds)
                passed_timeouts.append(timeout)
                clock.advance(0.01)
                socket = _FakeWebSocket(
                    {},
                    frame_factory=frame_factory,
                    on_settimeout=lambda value: passed_timeouts.append(value),
                    on_send=lambda: clock.advance(0.01),
                    on_recv=lambda: clock.advance(0.01),
                )
                sockets.append(socket)
                return socket

            evaluator_for_surface = evaluator_type(monotonic=clock)
            with mock.patch.object(module.websocket, "create_connection", side_effect=connect) as connector:
                result = evaluator_for_surface.evaluate(
                    ws_url,
                    "navigate",
                    surface=surface,
                    timeout_seconds=timeout_seconds,
                )
            self.assertEqual(connector.call_count, 1)
            self.assertEqual(len(sockets), 1)
            socket = sockets[0]
            self.assertTrue(socket.closed)
            self.assertTrue(all(value > 0 for value in passed_timeouts))
            self.assertTrue(
                all(left >= right for left, right in zip(passed_timeouts, passed_timeouts[1:]))
            )
            return result, socket, state_checks[0]

        def assert_root_scoped_expression(expression, *, activation=False, explore=False):
            self.assertIsInstance(expression, str)
            self.assertIn("primaryColumn", expression)
            self.assertRegex(expression, r"\[data-testid=[\"']?primaryColumn")
            self.assertRegex(expression, r"querySelector(?:All)?\([^)]*primaryColumn")
            self.assertIn("rootCount", expression)
            self.assertNotIn("cellInnerDiv", expression)
            self.assertNotRegex(
                expression,
                r"document\.querySelectorAll\([^)]*\[role=(?:['\"])?tab",
            )
            self.assertRegex(expression, r"(?:root|primary)[A-Za-z_]*\.querySelector")
            if explore:
                self.assertRegex(expression, r"(?:pathname|location)")
                self.assertNotRegex(expression, r"For You|Following|Explore")
            else:
                self.assertRegex(expression, r"(?:tablist|role)")
                self.assertRegex(expression, r"tablist[\s\S]{0,300}querySelectorAll")
            if activation:
                self.assertRegex(expression, r"(?:tablist|role)")
                self.assertRegex(expression, r"tablist[\s\S]{0,300}querySelectorAll")
                self.assertRegex(expression, r"(?:click|ordinal)")

        for surface, opposite_selected, target_ordinal in (
            ("for_you", 1, 0),
            ("following", 0, 1),
        ):
            with self.subTest(navigate_activation=surface):
                initial = _surface_facts(surface, selected=opposite_selected)
                activated = {"ok": True}
                final = _surface_facts(surface, selected=target_ordinal)
                result, socket, state_checks = navigate_sequence(
                    surface,
                    [(initial, True), (activated, False), (final, True)],
                )
                self.assertEqual(result, {"url": SURFACE_TARGETS[surface], "body": ""})
                self.assertEqual(state_checks, 2)
                self.assertEqual(
                    [message["id"] for message in socket.sent],
                    list(range(1, len(socket.sent) + 1)),
                )
                self.assertEqual(sum(message["method"] == "Page.navigate" for message in socket.sent), 1)
                self.assertEqual(
                    [message["params"]["url"] for message in socket.sent if message["method"] == "Page.navigate"],
                    [SURFACE_TARGETS[surface]],
                )
                self.assertEqual(sum(message["method"] == "Runtime.evaluate" for message in socket.sent), 3)
                runtime_messages = [
                    message for message in socket.sent if message["method"] == "Runtime.evaluate"
                ]
                assert_root_scoped_expression(
                    runtime_messages[0]["params"]["expression"],
                )
                assert_root_scoped_expression(
                    runtime_messages[1]["params"]["expression"],
                    activation=True,
                )
                assert_root_scoped_expression(
                    runtime_messages[2]["params"]["expression"],
                )

        with self.subTest(navigate_activation="explore_no_home_activation"):
            result, socket, state_checks = navigate_sequence(
                "explore",
                [(_surface_facts("explore"), True)],
            )
            self.assertEqual(result, {"url": SURFACE_TARGETS["explore"], "body": ""})
            self.assertEqual(state_checks, 1)
            self.assertEqual(
                [message["id"] for message in socket.sent],
                list(range(1, len(socket.sent) + 1)),
            )
            self.assertEqual(sum(message["method"] == "Page.navigate" for message in socket.sent), 1)
            self.assertEqual(sum(message["method"] == "Runtime.evaluate" for message in socket.sent), 1)
            runtime_messages = [
                message for message in socket.sent if message["method"] == "Runtime.evaluate"
            ]
            assert_root_scoped_expression(
                runtime_messages[0]["params"]["expression"],
                explore=True,
            )

        for name, facts in (
            ("probe_wrong_path", _surface_facts("for_you", pathname="/explore")),
            ("probe_loading", _surface_facts("for_you", loading=1)),
        ):
            failure = _FakeWebSocket(facts)
            with self.subTest(probe_failure=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    assert_fixed_error(
                        lambda: evaluator.evaluate(
                            ws_url,
                            "probe",
                            surface="for_you",
                            timeout_seconds=timeout_seconds,
                        )
                    )
                self.assertTrue(failure.closed)
                self.assertEqual(failure.recv_count, 1)

        for name, values in (
            (
                "always_loading",
                [(_surface_facts("for_you", loading=1), True)] * 3,
            ),
            (
                "never_target",
                [
                    (_surface_facts("for_you", selected=1), True),
                    ({"ok": True}, False),
                    (_surface_facts("for_you", selected=1), True),
                ],
            ),
        ):
            with self.subTest(navigate_bounded_failure=name):
                capture = {}
                with self.assertRaises(Exception) as context:
                    navigate_sequence("for_you", values, capture=capture)
                self.assertIs(type(context.exception), fixed_error_type)
                self.assertEqual(len(capture["sockets"]), 1)
                self.assertTrue(capture["sockets"][0].closed)
                self.assertLessEqual(capture["state_checks"][0], 3)

        current_action = ["navigate"]
        for surface, target in SURFACE_TARGETS.items():
            with self.subTest(navigate_surface=surface):
                current_surface[0] = surface
                created.clear()
                with mock.patch.object(module.websocket, "create_connection", side_effect=create_connection):
                    navigate = evaluator.evaluate(
                        ws_url,
                        "navigate",
                        surface=surface,
                        timeout_seconds=timeout_seconds,
                    )
                self.assertEqual(navigate["url"], target)
                self.assertIn("body", navigate)
                self.assertEqual(navigate["body"], "")
                self.assertLessEqual(len(navigate["url"].encode("utf-8")), 512)
                self.assertLessEqual(len(navigate["body"].encode("utf-8")), 6144)
                self.assertTrue(created[-1].closed)
                self.assertEqual(created[-1].sent[0]["method"], "Page.navigate")
                self.assertEqual(created[-1].sent[0]["params"], {"url": target})

        current_surface[0] = "for_you"
        current_action[0] = "probe"
        for surface, proof in SURFACE_PROOFS.items():
            with self.subTest(probe_surface=surface):
                current_surface[0] = surface
                created.clear()
                with mock.patch.object(module.websocket, "create_connection", side_effect=create_connection):
                    probe = evaluator.evaluate(
                        ws_url,
                        "probe",
                        surface=surface,
                        timeout_seconds=timeout_seconds,
                    )
                self.assertEqual(probe["surfaceProof"], proof)
                self.assertTrue(created[-1].closed)
                self.assertEqual(created[-1].sent[0]["method"], "Runtime.evaluate")

        current_surface[0] = "for_you"
        for action in ("snapshot", "expand", "scroll"):
            current_action[0] = action
            created.clear()
            with mock.patch.object(module.websocket, "create_connection", side_effect=create_connection):
                value = evaluator.evaluate(
                    ws_url,
                    action,
                    surface="for_you",
                    stable_id=stable_id if action == "expand" else None,
                    timeout_seconds=timeout_seconds,
                )
            self.assertTrue(created[-1].closed)
            for socket_timeout in created[-1].timeouts:
                self.assertGreater(socket_timeout, 0)
                self.assertLessEqual(socket_timeout, timeout_seconds)
            self.assertEqual(created[-1].sent[0]["method"], "Runtime.evaluate")
            expression = created[-1].sent[0]["params"]["expression"]
            self.assertIsInstance(expression, str)
            if action == "probe":
                self.assertEqual(value["surfaceProof"], SURFACE_PROOFS["for_you"])
            elif action == "snapshot":
                self.assertEqual(
                    value,
                    {
                        "items": [{
                            "sourceUrl": "https://x.com/alice/status/42",
                            "authorHandle": "alice",
                            "publishedAt": TIMESTAMP,
                            "body": "root",
                            "showMore": False,
                            "placeholder": False,
                        }],
                        "explicitEmpty": False,
                    },
                )
                self.assertEqual(len(value["items"]), 1)
                self.assertNotIn("depth", value["items"][0])
                self.assertNotIn("insideQuote", value["items"][0])
            elif action == "expand":
                self.assertTrue(value["ok"])
                self.assertIn(stable_id, expression)
            else:
                self.assertTrue(value["ok"])
                self.assertIn("innerHeight", expression)

        explicit_empty = _FakeWebSocket({"items": [], "cards": [], "explicitEmpty": True})
        with mock.patch.object(module.websocket, "create_connection", return_value=explicit_empty):
            assert_fixed_error(
                lambda: evaluator.evaluate(
                    ws_url,
                    "snapshot",
                    surface="for_you",
                    timeout_seconds=timeout_seconds,
                )
            )
        self.assertTrue(explicit_empty.closed)

        def snapshot_candidate(source_url, author, published_at, body, depth, inside_quote,
                               show_more_control_count=0, placeholder=False):
            return {
                "sourceUrl": source_url,
                "authorHandle": author,
                "publishedAt": published_at,
                "body": body,
                "depth": depth,
                "insideQuote": inside_quote,
                "showMoreControlCount": show_more_control_count,
                "placeholder": placeholder,
            }

        alice_root = snapshot_candidate(
            "https://x.com/alice/status/101", "alice", TIMESTAMP, "alice root", 0, False,
        )
        alice_quote = snapshot_candidate(
            "https://x.com/bob/status/102", "bob", "2026-09-01T00:00:01.000Z", "nested quote", 1, True,
        )
        carol_root = snapshot_candidate(
            "https://x.com/carol/status/201", "carol", "2026-09-01T00:00:02.000Z", "carol root", 0, False,
        )
        carol_quote = snapshot_candidate(
            "https://x.com/dan/status/202", "dan", "2026-09-01T00:00:03.000Z", "nested quote", 1, True,
        )
        snapshot_cells = [
            {"candidates": [alice_root, alice_quote]},
            {"candidates": [carol_root, carol_quote]},
        ]
        snapshot_socket = _FakeWebSocket({"cells": snapshot_cells, "emptyFacts": _empty_facts("for_you")})
        with mock.patch.object(module.websocket, "create_connection", return_value=snapshot_socket):
            projected_snapshot = evaluator.evaluate(
                ws_url,
                "snapshot",
                surface="for_you",
                timeout_seconds=timeout_seconds,
            )
        expected_items = [
            {
                "sourceUrl": alice_root["sourceUrl"],
                "authorHandle": alice_root["authorHandle"],
                "publishedAt": alice_root["publishedAt"],
                "body": alice_root["body"],
                "showMore": False,
                "placeholder": False,
            },
            {
                "sourceUrl": carol_root["sourceUrl"],
                "authorHandle": carol_root["authorHandle"],
                "publishedAt": carol_root["publishedAt"],
                "body": carol_root["body"],
                "showMore": False,
                "placeholder": False,
            },
        ]
        self.assertEqual(
            projected_snapshot,
            {"items": expected_items, "explicitEmpty": False},
        )
        self.assertTrue(snapshot_socket.closed)
        observer_module = getattr(module, "x_personal_feed_observer", None)
        if observer_module is None:
            observer_module = importlib.import_module("x_personal_feed_observer")
        prepared = observer_module._prepared_items(projected_snapshot, set(), 8)
        self.assertEqual(
            [source for source, _item in prepared],
            [item["sourceUrl"] for item in expected_items],
        )
        self.assertEqual(len(prepared), 2)
        self.assertEqual(
            observer_module._candidate_items(projected_snapshot),
            expected_items,
        )
        show_more_socket = _FakeWebSocket({
            "cells": [{"candidates": [{**alice_root, "showMoreControlCount": 1}]}],
            "emptyFacts": _empty_facts("for_you"),
        })
        with mock.patch.object(module.websocket, "create_connection", return_value=show_more_socket):
            show_more_snapshot = evaluator.evaluate(
                ws_url,
                "snapshot",
                surface="for_you",
                timeout_seconds=timeout_seconds,
            )
        self.assertEqual(
            show_more_snapshot,
            {
                "items": [{
                    "sourceUrl": alice_root["sourceUrl"],
                    "authorHandle": alice_root["authorHandle"],
                    "publishedAt": alice_root["publishedAt"],
                    "body": alice_root["body"],
                    "showMore": True,
                    "placeholder": False,
                }],
                "explicitEmpty": False,
            },
        )
        self.assertTrue(show_more_socket.closed)
        snapshot_expression = snapshot_socket.sent[0]["params"]["expression"]
        self.assertIn("primaryColumn", snapshot_expression)
        self.assertRegex(snapshot_expression, r"\[data-testid=[\"']?primaryColumn")
        self.assertRegex(snapshot_expression, r"(?:root|primary)[A-Za-z_]*\.querySelectorAll")
        self.assertIn("cellInnerDiv", snapshot_expression)
        self.assertIn("article", snapshot_expression)
        self.assertIn("cells", snapshot_expression)
        self.assertIn("candidates", snapshot_expression)
        self.assertNotIn("statusCandidates", snapshot_expression)
        self.assertIn("showMoreControlCount", snapshot_expression)
        self.assertIn("tweet-text-show-more-link", snapshot_expression)
        self.assertRegex(snapshot_expression, r"querySelectorAll\([^)]*tweet-text-show-more-link")
        self.assertRegex(snapshot_expression, r"(?:disabled|aria-disabled)")
        self.assertRegex(snapshot_expression, r"(?:role\s*[=:]\s*[\"']?button|<button)")
        self.assertNotRegex(snapshot_expression, r"querySelector\([^)]*button")
        self.assertNotRegex(snapshot_expression, r"Show more|显示更多")
        self.assertNotRegex(
            snapshot_expression,
            r"\.filter\([^)]*candidates[^)]*(?:length|size)[^)]*>\s*0",
        )
        self.assertRegex(
            snapshot_expression,
            r"\.closest\([^)]*article\[data-testid[^)]*tweet[^)]*\)\s*===\s*article",
        )
        self.assertNotRegex(
            snapshot_expression,
            r"\barticle\.closest\([^)]*blockquote",
        )
        for hardcoded_empty in ('"sourceUrl":""', '"authorHandle":""', '"publishedAt":""', '"body":""'):
            self.assertNotIn(hardcoded_empty, snapshot_expression)

        malformed_snapshot = {
            "cells": snapshot_cells,
            "emptyFacts": _empty_facts("for_you"),
        }

        def snapshot_failure(name, cells, *, canary=None):
            failure = _FakeWebSocket({"cells": cells, "emptyFacts": _empty_facts("for_you")})
            with self.subTest(snapshot_failure=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    assert_fixed_error(
                        lambda: evaluator.evaluate(
                            ws_url,
                            "snapshot",
                            surface="for_you",
                            timeout_seconds=timeout_seconds,
                        ),
                        canary=canary,
                    )
                self.assertTrue(failure.closed)
                self.assertEqual(failure.recv_count, 1)

        missing_published_canary = dict(alice_root)
        missing_published_canary.pop("publishedAt")
        missing_published_canary["body"] = "正文CANARY"
        invalid_snapshot_cases = (
            ("two_same_depth_nonquote_roots", [{"candidates": [alice_root, carol_root]}], None),
            ("nonempty_cell_without_nonquote_root", [{"candidates": [alice_quote]}], None),
            ("cells_not_list", "not-a-list", None),
            ("candidates_not_list", [{"candidates": "not-a-list"}], None),
            ("empty_cell", [{"candidates": []}], None),
            ("candidate_missing_field", [{"candidates": [missing_published_canary]}], "正文CANARY"),
            ("candidate_extra_key", [{"candidates": [{**alice_root, "extra": True}]}], None),
            ("url_not_canonical", [{"candidates": [{**alice_root, "sourceUrl": "https://x.com/alice/status/101?x=1"}]}], None),
            ("author_mismatch", [{"candidates": [{**alice_root, "authorHandle": "not_alice"}]}], None),
            ("published_not_canonical_utc", [{"candidates": [{**alice_root, "publishedAt": "2026-09-01T00:00:00Z"}]}], None),
            ("depth_bool", [{"candidates": [{**alice_root, "depth": True}]}], None),
            ("depth_negative", [{"candidates": [{**alice_root, "depth": -1}]}], None),
            ("inside_quote_not_bool", [{"candidates": [{**alice_root, "insideQuote": 0}]}], None),
            ("show_more_count_gt_one", [{"candidates": [{**alice_root, "showMoreControlCount": 2}]}], None),
            ("show_more_count_bool", [{"candidates": [{**alice_root, "showMoreControlCount": True}]}], None),
            ("show_more_count_negative", [{"candidates": [{**alice_root, "showMoreControlCount": -1}]}], None),
            ("placeholder_not_bool", [{"candidates": [{**alice_root, "placeholder": None}]}], None),
            ("body_not_string", [{"candidates": [{**alice_root, "body": 42}]}], None),
            (
                "valid_cell_plus_malformed_cell",
                [{"candidates": [alice_root]}, {"candidates": []}],
                None,
            ),
        )
        for name, cells, canary in invalid_snapshot_cases:
            snapshot_failure(name, cells, canary=canary)
        self.assertEqual(malformed_snapshot["cells"], snapshot_cells)

        expand_decision = getattr(module, "_expand_decision", None)
        self.assertTrue(callable(expand_decision))
        expand_success_facts = {
            "matchingCellCount": 1,
            "targetRootCount": 1,
            "showMoreControlCount": 1,
            "clicked": True,
        }
        self.assertEqual(expand_decision(expand_success_facts), {"ok": True})
        for name, clicked in (
            ("clicked_false", False),
            ("matching_cell_zero", False),
            ("matching_cell_two", False),
            ("target_root_zero", False),
            ("target_root_two", False),
            ("show_more_control_zero", False),
            ("show_more_control_two", False),
        ):
            facts = dict(expand_success_facts)
            if name == "clicked_false":
                facts["clicked"] = clicked
            elif name == "matching_cell_zero":
                facts["matchingCellCount"] = 0
            elif name == "matching_cell_two":
                facts["matchingCellCount"] = 2
            elif name == "target_root_zero":
                facts["targetRootCount"] = 0
            elif name == "target_root_two":
                facts["targetRootCount"] = 2
            elif name == "show_more_control_zero":
                facts["showMoreControlCount"] = 0
            else:
                facts["showMoreControlCount"] = 2
            if name != "clicked_false":
                facts["clicked"] = False
            with self.subTest(expand_decision=name):
                self.assertEqual(expand_decision(facts), {"ok": False})

        malformed_expand_facts = (
            ("missing_key", {key: value for key, value in expand_success_facts.items() if key != "clicked"}),
            ("extra_key", {**expand_success_facts, "body": "正文CANARY"}),
            ("matching_cell_bool", {**expand_success_facts, "matchingCellCount": True}),
            ("target_root_string", {**expand_success_facts, "targetRootCount": "1"}),
            ("show_more_control_negative", {**expand_success_facts, "showMoreControlCount": -1}),
            ("count_inconsistent_clicked_true", {**expand_success_facts, "matchingCellCount": 2}),
            ("clicked_integer", {**expand_success_facts, "clicked": 1}),
        )
        for name, facts in malformed_expand_facts:
            with self.subTest(expand_decision=name):
                assert_fixed_error(
                    lambda facts=facts: expand_decision(facts),
                    canary="正文CANARY" if name == "extra_key" else None,
                )

        expand_socket = _FakeWebSocket(expand_success_facts)
        with mock.patch.object(module.websocket, "create_connection", return_value=expand_socket):
            expanded = evaluator.evaluate(
                ws_url,
                "expand",
                surface="for_you",
                stable_id="https://x.com/alice/status/42",
                timeout_seconds=timeout_seconds,
            )
        self.assertEqual(expanded, {"ok": True})
        self.assertTrue(expand_socket.closed)
        expand_expression = expand_socket.sent[0]["params"]["expression"]
        self.assertIn("primaryColumn", expand_expression)
        self.assertRegex(expand_expression, r"\[data-testid=[\"']?primaryColumn")
        self.assertRegex(
            expand_expression,
            r"\.closest\([^)]*article\[data-testid[^)]*tweet[^)]*\)\s*===\s*article",
        )
        self.assertRegex(expand_expression, r"(?:articleDepth|ancestor[A-Za-z]*Article|parentElement|parentNode)")
        self.assertRegex(expand_expression, r"(?:depth|insideQuote)")
        self.assertNotRegex(expand_expression, r"\barticle\.closest\([^)]*blockquote")
        self.assertIn("https://x.com/alice/status/42", expand_expression)
        self.assertIn("href", expand_expression)
        self.assertNotIn("innerText", expand_expression)
        self.assertNotRegex(
            expand_expression,
            r"(?:innerText|textContent)[^;\n]*(?:includes|indexOf|contains)",
        )
        self.assertIn("matchingCellCount", expand_expression)
        self.assertIn("targetRootCount", expand_expression)
        self.assertIn("showMoreControlCount", expand_expression)
        self.assertIn("clicked", expand_expression)
        self.assertIn("tweet-text-show-more-link", expand_expression)
        self.assertRegex(expand_expression, r"querySelectorAll\([^)]*tweet-text-show-more-link")
        self.assertRegex(expand_expression, r"(?:disabled|aria-disabled)")
        self.assertRegex(expand_expression, r"(?:role\s*[=:]\s*[\"']?button|<button)")
        self.assertRegex(expand_expression, r"(?:click|\.click\s*\()")
        self.assertNotRegex(expand_expression, r"querySelector\([^)]*button")
        self.assertNotRegex(expand_expression, r"Show more|显示更多")

        expand_not_ok_cases = (
            ("matching_cell_zero", {**expand_success_facts, "matchingCellCount": 0, "clicked": False}),
            ("matching_cell_two", {**expand_success_facts, "matchingCellCount": 2, "clicked": False}),
            ("target_root_zero", {**expand_success_facts, "targetRootCount": 0, "clicked": False}),
            ("target_root_two", {**expand_success_facts, "targetRootCount": 2, "clicked": False}),
            ("ordinary_button_count_zero", {**expand_success_facts, "showMoreControlCount": 0, "clicked": False}),
            ("show_more_control_count_two", {**expand_success_facts, "showMoreControlCount": 2, "clicked": False}),
            ("clicked_false", {**expand_success_facts, "clicked": False}),
        )
        for name, facts in expand_not_ok_cases:
            failure = _FakeWebSocket(facts)
            with self.subTest(expand_result=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    self.assertEqual(
                        evaluator.evaluate(
                            ws_url,
                            "expand",
                            surface="for_you",
                            stable_id="https://x.com/alice/status/42",
                            timeout_seconds=timeout_seconds,
                        ),
                        {"ok": False},
                    )
                self.assertTrue(failure.closed)

        for name, facts in (
            ("expand_malformed_missing", {"matchingCellCount": 1, "targetRootCount": 1, "clicked": True}),
            ("expand_malformed_extra", {**expand_success_facts, "body": "正文CANARY"}),
            ("expand_malformed_bool", {**expand_success_facts, "showMoreControlCount": True}),
        ):
            failure = _FakeWebSocket(facts)
            with self.subTest(expand_result=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    assert_fixed_error(
                        lambda: evaluator.evaluate(
                            ws_url,
                            "expand",
                            surface="for_you",
                            stable_id="https://x.com/alice/status/42",
                            timeout_seconds=timeout_seconds,
                        ),
                        canary="正文CANARY" if "extra" in name else None,
                    )
                self.assertTrue(failure.closed)

        def page_frame_without_frame_id(_request, response_id, _value):
            return {"id": response_id, "result": {"loaderId": "loader-1"}}

        def page_frame_with_empty_frame_id(_request, response_id, _value):
            return {
                "id": response_id,
                "result": {"frameId": "", "loaderId": "loader-1"},
            }

        def page_frame_with_error_text(_request, response_id, _value):
            return {"id": response_id, "result": {"errorText": "Navigation failed"}}

        def runtime_frame_with_exception(_request, response_id, _value):
            return {
                "id": response_id,
                "result": {
                    "result": {
                        "type": "object",
                        "value": {"body": "正文CANARY"},
                    },
                    "exceptionDetails": {"text": "正文CANARY"},
                },
            }

        def runtime_frame_with_empty_exception_details(_request, response_id, _value):
            return {
                "id": response_id,
                "result": {
                    "result": {
                        "type": "object",
                        "value": _surface_facts("for_you"),
                    },
                    "exceptionDetails": {},
                },
            }

        def runtime_frame_with_empty_exception_details_canary(_request, response_id, _value):
            return {
                "id": response_id,
                "result": {
                    "result": {
                        "type": "object",
                        "value": {"body": "正文CANARY"},
                    },
                    "exceptionDetails": {},
                },
            }

        def runtime_frame_without_value(_request, response_id, _value):
            return {
                "id": response_id,
                "result": {"result": {"type": "object"}},
            }

        def top_level_error(_request, response_id, _value):
            return {
                "id": response_id,
                "error": {"code": -32000, "message": "正文CANARY"},
            }

        event_frames_seen = [0]

        def event_then_matching_success(request, response_id, value):
            event_frames_seen[0] += 1
            if event_frames_seen[0] == 1:
                return {
                    "method": "Page.loadEventFired",
                    "params": {"canary": "正文CANARY"},
                }
            return {
                "id": response_id,
                "result": {"result": {"type": "object", "value": value}},
            }

        protocol_failures = (
            ("navigate_missing_frame_id", "navigate", page_frame_without_frame_id),
            ("navigate_empty_frame_id", "navigate", page_frame_with_empty_frame_id),
            ("navigate_error_text", "navigate", page_frame_with_error_text),
            ("matching_top_level_error", "probe", top_level_error),
            ("runtime_exception_details", "probe", runtime_frame_with_exception),
            (
                "runtime_empty_exception_details",
                "probe",
                runtime_frame_with_empty_exception_details,
            ),
            ("runtime_inner_result_without_value", "probe", runtime_frame_without_value),
            ("snapshot_missing_value", "snapshot", runtime_frame_without_value),
        )

        empty_exception_canary_response = runtime_frame_with_empty_exception_details_canary(
            None,
            1,
            None,
        )
        with self.assertRaises(Exception) as empty_exception_context:
            evaluator._runtime_value(empty_exception_canary_response)
        self.assertNotIn("正文CANARY", str(empty_exception_context.exception))

        for name, action, frame_factory in protocol_failures:
            failure = _FakeWebSocket(
                {"body": "正文CANARY"},
                frame_factory=frame_factory,
            )
            with self.subTest(protocol_failure=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    assert_fixed_error(
                        lambda action=action: evaluator.evaluate(
                            ws_url,
                            action,
                            surface="for_you",
                            timeout_seconds=timeout_seconds,
                        ),
                        canary="正文CANARY",
                    )
                self.assertTrue(failure.closed)
                self.assertEqual(failure.recv_count, 1)

        event_frames_seen[0] = 0
        event_clock = _FakeMonotonic()
        event_frame = _FakeWebSocket(
            _surface_facts("for_you"),
            frame_factory=event_then_matching_success,
            on_recv=lambda: event_clock.advance(0.01),
        )
        with self.subTest(protocol_failure="event_without_id"):
            with mock.patch.object(module.websocket, "create_connection", return_value=event_frame):
                event_result = evaluator_type(monotonic=event_clock).evaluate(
                    ws_url,
                    "probe",
                    surface="for_you",
                    timeout_seconds=timeout_seconds,
                )
            self.assertEqual(event_result, {"surfaceProof": SURFACE_PROOFS["for_you"]})
            self.assertNotIn("正文CANARY", str(event_result))
            self.assertTrue(event_frame.closed)
            self.assertEqual(event_frame.recv_count, 2)
            self.assertTrue(all(value > 0 for value in event_frame.timeouts))
            self.assertTrue(
                all(left >= right for left, right in zip(event_frame.timeouts, event_frame.timeouts[1:]))
            )

        def assert_recv_timeout_contract(socket):
            self.assertTrue(all(value > 0 for value in socket.timeouts))
            self.assertTrue(
                all(left >= right for left, right in zip(socket.timeouts, socket.timeouts[1:]))
            )

        def malformed_no_id_event(_request, _response_id, _value):
            return {"method": "Page.loadEventFired", "params": []}

        malformed_event = _FakeWebSocket(
            {},
            frame_factory=malformed_no_id_event,
        )
        with self.subTest(protocol_failure="malformed_event_without_id"):
            with mock.patch.object(module.websocket, "create_connection", return_value=malformed_event):
                assert_fixed_error(
                    lambda: evaluator.evaluate(
                        ws_url,
                        "probe",
                        surface="for_you",
                        timeout_seconds=timeout_seconds,
                    )
                )
            self.assertTrue(malformed_event.closed)
            self.assertEqual(malformed_event.recv_count, 1)
            assert_recv_timeout_contract(malformed_event)

        event_budget_clock = _FakeMonotonic()
        event_budget_seen = [0]

        def eight_events_then_matching_success(_request, response_id, value):
            event_budget_seen[0] += 1
            if event_budget_seen[0] <= 8:
                return {
                    "method": "Page.loadEventFired",
                    "params": {"canary": "正文CANARY"},
                }
            return {
                "id": response_id,
                "result": {"result": {"type": "object", "value": value}},
            }

        eight_events = _FakeWebSocket(
            _surface_facts("for_you"),
            frame_factory=eight_events_then_matching_success,
            on_recv=lambda: event_budget_clock.advance(0.01),
        )
        with self.subTest(protocol_failure="eight_events_then_matching_success"):
            with mock.patch.object(module.websocket, "create_connection", return_value=eight_events):
                result = evaluator_type(monotonic=event_budget_clock).evaluate(
                    ws_url,
                    "probe",
                    surface="for_you",
                    timeout_seconds=timeout_seconds,
                )
            self.assertEqual(result, {"surfaceProof": SURFACE_PROOFS["for_you"]})
            self.assertNotIn("正文CANARY", str(result))
            self.assertTrue(eight_events.closed)
            self.assertEqual(eight_events.recv_count, 9)
            assert_recv_timeout_contract(eight_events)

        ninth_event_clock = _FakeMonotonic()
        ninth_event_seen = [0]

        def nine_events_then_no_response(_request, _response_id, _value):
            ninth_event_seen[0] += 1
            return {
                "method": "Page.loadEventFired",
                "params": {"canary": "正文CANARY"},
            }

        nine_events = _FakeWebSocket(
            {},
            frame_factory=nine_events_then_no_response,
            on_recv=lambda: ninth_event_clock.advance(0.01),
        )
        with self.subTest(protocol_failure="ninth_event_immediate_failure"):
            with mock.patch.object(module.websocket, "create_connection", return_value=nine_events):
                assert_fixed_error(
                    lambda: evaluator_type(monotonic=ninth_event_clock).evaluate(
                        ws_url,
                        "probe",
                        surface="for_you",
                        timeout_seconds=timeout_seconds,
                    ),
                    canary="正文CANARY",
                )
            self.assertTrue(nine_events.closed)
            self.assertEqual(nine_events.recv_count, 9)
            self.assertEqual(ninth_event_seen[0], 9)
            assert_recv_timeout_contract(nine_events)

        cumulative_clock = _FakeMonotonic()
        cumulative_frames_seen = [0]
        cumulative_wire_sizes = []
        cumulative_padding = "x" * (module.MAX_CDP_BYTES // 2)

        def cumulative_frame_then_matching(request, response_id, _value):
            cumulative_frames_seen[0] += 1
            if cumulative_frames_seen[0] <= 2:
                response = {
                    "method": "Page.loadEventFired",
                    "params": {
                        "padding": cumulative_padding,
                        "canary": "正文CANARY",
                    },
                }
            else:
                response = {
                    "id": response_id,
                    "result": {
                        "result": {
                            "type": "object",
                            "value": _surface_facts("for_you"),
                        },
                        "padding": cumulative_padding,
                    },
                }
            encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
            cumulative_wire_sizes.append(len(encoded.encode("utf-8")))
            self.assertLess(cumulative_wire_sizes[-1], module.MAX_CDP_BYTES)
            return response

        cumulative_socket = _FakeWebSocket(
            {},
            frame_factory=cumulative_frame_then_matching,
            on_recv=lambda: cumulative_clock.advance(0.01),
        )
        with self.subTest(protocol_failure="cumulative_event_response_bytes"):
            with mock.patch.object(module.websocket, "create_connection", return_value=cumulative_socket):
                assert_fixed_error(
                    lambda: evaluator_type(monotonic=cumulative_clock).evaluate(
                        ws_url,
                        "probe",
                        surface="for_you",
                        timeout_seconds=timeout_seconds,
                    ),
                    canary="正文CANARY",
                )
            self.assertEqual(cumulative_frames_seen[0], 2)
            self.assertEqual(cumulative_socket.recv_count, 2)
            self.assertGreater(sum(cumulative_wire_sizes), module.MAX_CDP_BYTES)
            self.assertTrue(cumulative_socket.closed)
            assert_recv_timeout_contract(cumulative_socket)

        for name, raw_frame in (
            ("malformed_json", "{malformed-json"),
            ("non_dict_frame", "[1,2,3]"),
        ):
            failure = _FakeWebSocket({}, raw_frame=raw_frame)
            with self.subTest(protocol_failure=name):
                with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                    assert_fixed_error(
                        lambda: evaluator.evaluate(
                            ws_url,
                            "snapshot",
                            surface="for_you",
                            timeout_seconds=timeout_seconds,
                        )
                    )
                self.assertTrue(failure.closed)
                self.assertEqual(failure.recv_count, 1)

        action_budget = 1.0
        timing_clock = _FakeMonotonic()
        timing_evaluator = evaluator_type(monotonic=timing_clock)
        timing_sockets = []
        timing_timeouts = []
        send_finished = [False]

        def timing_settimeout(value):
            timing_timeouts.append(value)
            self.assertGreater(value, 0)
            if send_finished[0]:
                self.assertLessEqual(value, 0.3 + 1e-9)
            else:
                self.assertLessEqual(value, 0.6 + 1e-9)

        def timing_send():
            timing_clock.advance(0.3)
            send_finished[0] = True

        def timing_recv():
            timing_clock.advance(0.2)

        def timing_create_connection(url, timeout=None, **_kwargs):
            self.assertEqual(url, ws_url)
            timing_timeouts.append(timeout)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, action_budget)
            timing_clock.advance(0.4)
            socket = _FakeWebSocket(
                _response_value("probe", "for_you"),
                on_settimeout=timing_settimeout,
                on_send=timing_send,
                on_recv=timing_recv,
            )
            timing_sockets.append(socket)
            return socket

        with mock.patch.object(module.websocket, "create_connection", side_effect=timing_create_connection):
            timing_result = timing_evaluator.evaluate(
                ws_url,
                "probe",
                surface="for_you",
                timeout_seconds=action_budget,
            )
        self.assertEqual(timing_result["surfaceProof"], SURFACE_PROOFS["for_you"])
        self.assertEqual(len(timing_sockets), 1)
        self.assertTrue(timing_sockets[0].closed)
        self.assertEqual(timing_sockets[0].send_count, 1)
        self.assertEqual(timing_sockets[0].recv_count, 1)
        self.assertGreaterEqual(len(timing_sockets[0].timeouts), 2)
        self.assertLessEqual(timing_sockets[0].timeouts[0], 0.6 + 1e-9)
        self.assertLessEqual(timing_sockets[0].timeouts[1], 0.3 + 1e-9)
        self.assertTrue(all(value > 0 for value in timing_timeouts))
        self.assertTrue(
            all(left >= right for left, right in zip(timing_timeouts, timing_timeouts[1:]))
        )

        timing_cases = (
            (
                "connect_exhausted",
                1.0,
                0.3,
                0.2,
                0,
                0,
            ),
            (
                "send_exhausted",
                0.4,
                0.7,
                0.2,
                1,
                0,
            ),
            (
                "recv_exhausted",
                0.4,
                0.3,
                0.4,
                1,
                1,
            ),
        )
        for name, connect_advance, send_advance, recv_advance, expected_sends, expected_recvs in timing_cases:
            with self.subTest(deadline_case=name):
                clock = _FakeMonotonic()
                deadline_sockets = []

                def deadline_create_connection(url, timeout=None, **_kwargs):
                    self.assertEqual(url, ws_url)
                    self.assertGreater(timeout, 0)
                    self.assertLessEqual(timeout, action_budget)
                    clock.advance(connect_advance)
                    socket = _FakeWebSocket(
                        _response_value("probe", "for_you"),
                        on_send=lambda: clock.advance(send_advance),
                        on_recv=lambda: clock.advance(recv_advance),
                    )
                    deadline_sockets.append(socket)
                    return socket

                deadline_evaluator = evaluator_type(monotonic=clock)
                with mock.patch.object(
                    module.websocket,
                    "create_connection",
                    side_effect=deadline_create_connection,
                ):
                    assert_fixed_error(
                        lambda: deadline_evaluator.evaluate(
                            ws_url,
                            "probe",
                            surface="for_you",
                            timeout_seconds=action_budget,
                        )
                    )
                self.assertEqual(len(deadline_sockets), 1)
                self.assertTrue(deadline_sockets[0].closed)
                self.assertEqual(deadline_sockets[0].send_count, expected_sends)
                self.assertEqual(deadline_sockets[0].recv_count, expected_recvs)

        for invalid_url in (
            "ws://user:pass@127.0.0.1:9222/devtools/page/1",
            "ws://127.0.0.1:9222/devtools/page/1?secret=yes",
            "ws://127.0.0.1:9222/devtools/page/1#fragment",
            "ws://localhost:9223/devtools/page/1",
            "ws://10.0.0.1:9222/devtools/page/1",
            "ws://127.0.0.1:9222/devtools/other/1",
        ):
            assert_fixed_error(
                lambda invalid_url=invalid_url: evaluator.evaluate(
                    invalid_url, "probe", surface="for_you", timeout_seconds=timeout_seconds
                )
            )
        assert_fixed_error(
            lambda: evaluator.evaluate(
                ws_url, "unknown", surface="for_you", timeout_seconds=timeout_seconds
            )
        )
        assert_fixed_error(
            lambda: evaluator.evaluate(
                ws_url, "navigate", surface="not-a-surface", timeout_seconds=timeout_seconds
            )
        )

        for failure in (
            _FakeWebSocket({"body": "正文CANARY"}, response_id=999),
            _FakeWebSocket({"body": "正文CANARY"}, recv_error=TimeoutError("timeout")),
            _FakeWebSocket({"body": "正文CANARY"}, recv_error=ConnectionError("disconnected")),
            _FakeWebSocket({"body": "正文CANARY"}, oversize=True),
        ):
            with mock.patch.object(module.websocket, "create_connection", return_value=failure):
                assert_fixed_error(
                    lambda: evaluator.evaluate(
                        ws_url,
                        "probe",
                        surface="for_you",
                        timeout_seconds=timeout_seconds,
                    ),
                    canary="正文CANARY",
                )
            self.assertTrue(failure.closed)

        ambiguous = _FakeWebSocket({
            "matchingCellCount": 0,
            "targetRootCount": 0,
            "showMoreControlCount": 0,
            "clicked": False,
        })
        with mock.patch.object(module.websocket, "create_connection", return_value=ambiguous):
            result = evaluator.evaluate(
                ws_url,
                "expand",
                surface="for_you",
                stable_id=stable_id,
                timeout_seconds=timeout_seconds,
            )
        self.assertEqual(result, {"ok": False})
        self.assertTrue(ambiguous.closed)

    def test_navigation_waits_for_surface_transition_with_bounded_sleep(self):
        module = _require_cli(self)
        evaluator_type = getattr(module, "_MechanicalCdpEvaluator", None)
        self.assertIsNotNone(evaluator_type)
        ws_url = "ws://127.0.0.1:9222/devtools/page/page-f2"
        timeout_seconds = 2.0

        def run_navigation(surface, values, *, expected_result=None, expected_probes,
                           expected_activation, expected_sleeps, should_fail=False):
            clock = _FakeMonotonic()
            frame_index = [0]
            sockets = []
            passed_timeouts = []

            def frame_factory(request, response_id, _value):
                if request["method"] == "Page.navigate":
                    return {
                        "id": response_id,
                        "result": {"frameId": "frame-1", "loaderId": "loader-1"},
                    }
                self.assertEqual(request["method"], "Runtime.evaluate")
                self.assertLess(frame_index[0], len(values))
                value = values[frame_index[0]]
                frame_index[0] += 1
                return {
                    "id": response_id,
                    "result": {
                        "result": {"type": "object", "value": value},
                    },
                }

            def connect(url, timeout=None, **_kwargs):
                self.assertEqual(url, ws_url)
                self.assertGreater(timeout, 0)
                self.assertLessEqual(timeout, timeout_seconds)
                passed_timeouts.append(timeout)
                socket = _FakeWebSocket(
                    {},
                    frame_factory=frame_factory,
                    on_settimeout=lambda value: passed_timeouts.append(value),
                    on_send=lambda: clock.advance(0.01),
                    on_recv=lambda: clock.advance(0.01),
                )
                sockets.append(socket)
                return socket

            evaluator = evaluator_type(monotonic=clock, sleeper=clock.sleep)
            forbidden = (
                "ensure_cdp",
                "ensure_x_tab",
                "new_tab",
                "run_browser_start",
            )
            with contextlib.ExitStack() as stack:
                for name in forbidden:
                    stack.enter_context(
                        mock.patch.object(
                            module,
                            name,
                            mock.Mock(side_effect=AssertionError(name + " was called")),
                            create=True,
                        )
                    )
                stack.enter_context(
                    mock.patch.object(module.websocket, "create_connection", side_effect=connect)
                )
                if should_fail:
                    with self.assertRaises(Exception):
                        evaluator.evaluate(
                            ws_url,
                            "navigate",
                            surface=surface,
                            timeout_seconds=timeout_seconds,
                        )
                else:
                    result = evaluator.evaluate(
                        ws_url,
                        "navigate",
                        surface=surface,
                        timeout_seconds=timeout_seconds,
                    )

            self.assertEqual(len(sockets), 1)
            socket = sockets[0]
            self.assertTrue(socket.closed)
            self.assertEqual(frame_index[0], expected_probes + expected_activation)
            runtime_messages = [
                message for message in socket.sent if message["method"] == "Runtime.evaluate"
            ]
            self.assertEqual(len(runtime_messages), expected_probes + expected_activation)
            self.assertEqual(
                sum("activateOrdinal" in message["params"]["expression"] for message in runtime_messages),
                expected_activation,
            )
            self.assertEqual(len(clock.sleeps), expected_sleeps)
            self.assertTrue(all(value > 0 for value in clock.sleeps))
            self.assertTrue(all(value > 0 for value in passed_timeouts))
            self.assertTrue(
                all(left >= right for left, right in zip(passed_timeouts, passed_timeouts[1:]))
            )
            self.assertEqual(
                [message["id"] for message in socket.sent],
                list(range(1, len(socket.sent) + 1)),
            )
            if expected_result is not None:
                self.assertEqual(result, expected_result)
            return clock, socket

        with self.subTest(navigate_transition="explore_old_home_then_exact_explore"):
            run_navigation(
                "explore",
                [
                    _surface_facts("for_you"),
                    _surface_facts("explore"),
                ],
                expected_result={"url": SURFACE_TARGETS["explore"], "body": ""},
                expected_probes=2,
                expected_activation=0,
                expected_sleeps=1,
            )

        with self.subTest(navigate_transition="following_activate_loading_then_following"):
            run_navigation(
                "following",
                [
                    _surface_facts("following", selected=0),
                    {"ok": True},
                    _surface_facts(
                        "following",
                        home_tabs=[
                            {"ordinal": 0, "selected": False},
                            {"ordinal": 1, "selected": False},
                        ],
                    ),
                    _surface_facts("following", selected=1),
                ],
                expected_result={"url": SURFACE_TARGETS["following"], "body": ""},
                expected_probes=3,
                expected_activation=1,
                expected_sleeps=2,
            )

        with self.subTest(navigate_transition="following_path_root_tablist_mount"):
            run_navigation(
                "following",
                [
                    _surface_facts(
                        "following",
                        root_count=0,
                        home_tablist_count=0,
                        home_tabs=[],
                        explore_root_count=0,
                    ),
                    _surface_facts(
                        "following",
                        home_tablist_count=0,
                        home_tabs=[],
                        explore_root_count=0,
                    ),
                    _surface_facts("following", selected=1),
                ],
                expected_result={"url": SURFACE_TARGETS["following"], "body": ""},
                expected_probes=3,
                expected_activation=0,
                expected_sleeps=2,
            )

        with self.subTest(navigate_transition="always_loading_bounded"):
            run_navigation(
                "following",
                [_surface_facts("following", loading=1)] * 3,
                expected_probes=3,
                expected_activation=0,
                expected_sleeps=2,
                should_fail=True,
            )

        invalid_cases = (
            ("unknown_pathname", _surface_facts("for_you", pathname="/unknown")),
            ("duplicate_root", _surface_facts("for_you", root_count=2)),
            ("duplicate_tablist", _surface_facts("for_you", home_tablist_count=2)),
            (
                "duplicate_ordinal",
                _surface_facts(
                    "for_you",
                    home_tabs=[
                        {"ordinal": 0, "selected": True},
                        {"ordinal": 0, "selected": False},
                    ],
                ),
            ),
            (
                "illegal_ordinal",
                _surface_facts(
                    "for_you",
                    home_tabs=[
                        {"ordinal": 0, "selected": True},
                        {"ordinal": 2, "selected": False},
                    ],
                ),
            ),
            (
                "two_selected",
                _surface_facts(
                    "for_you",
                    home_tabs=[
                        {"ordinal": 0, "selected": True},
                        {"ordinal": 1, "selected": True},
                    ],
                ),
            ),
            (
                "missing_field",
                {
                    key: value
                    for key, value in _surface_facts("for_you").items()
                    if key != "pathname"
                },
            ),
            (
                "extra_field",
                {**_surface_facts("for_you"), "canary": "正文CANARY"},
            ),
            (
                "wrong_type",
                {**_surface_facts("for_you"), "homeTabs": "not-a-list"},
            ),
            ("negative_count", _surface_facts("for_you", root_count=-1)),
            (
                "pathname_root_contradiction",
                _surface_facts("for_you", explore_root_count=1),
            ),
        )
        for name, facts in invalid_cases:
            with self.subTest(navigate_invalid_first_probe=name):
                run_navigation(
                    "for_you",
                    [facts],
                    expected_probes=1,
                    expected_activation=0,
                    expected_sleeps=0,
                    should_fail=True,
                )

    def test_snapshot_empty_facts_are_surface_scoped_and_bounded(self):
        module = _require_cli(self)
        evaluator_type = getattr(module, "_MechanicalCdpEvaluator", None)
        self.assertIsNotNone(evaluator_type)
        evaluator = evaluator_type()
        ws_url = "ws://127.0.0.1:9222/devtools/page/page-c8"
        timeout_seconds = 2.0
        empty_fact_keys = {
            "surfaceProof", "surfaceRootCount", "emptyMarkerCount",
            "outsideRootEmptyMarkerCount", "loadingCount", "loginCount",
            "authCount", "errorCount", "retryCount",
        }
        blocker_selectors = {
            "loadingCount": '[aria-busy="true"],[role="progressbar"]',
            "loginCount": '[data-testid="login"],[data-testid="loginButton"]',
            "authCount": '[data-testid="authError"],[data-testid="authRequired"]',
            "errorCount": '[data-testid="error"],[data-testid="errorState"]',
            "retryCount": '[data-testid="retry"],[data-testid="retryButton"]',
        }
        for surface in SURFACE_TARGETS:
            facts = _empty_facts(surface, emptyMarkerCount=1)
            self.assertEqual(set(facts), empty_fact_keys)
            socket = _FakeWebSocket({"cells": [], "emptyFacts": facts})
            with self.subTest(empty_surface=surface):
                with mock.patch.object(module.websocket, "create_connection", return_value=socket):
                    result = evaluator.evaluate(
                        ws_url,
                        "snapshot",
                        surface=surface,
                        timeout_seconds=timeout_seconds,
                    )
                self.assertEqual(
                    result,
                    {
                        "items": [],
                        "explicitEmpty": True,
                        "emptyProof": {
                            "kind": "surface_empty",
                            "surface": surface,
                            "surfaceProof": dict(SURFACE_PROOFS[surface]),
                        },
                    },
                )
                self.assertTrue(socket.closed)
                if surface == "for_you":
                    self.assertEqual(len(socket.sent), 1)
                    request = socket.sent[0]
                    self.assertEqual(request["method"], "Runtime.evaluate")
                    expression = request["params"]["expression"]
                    self.assertIsInstance(expression, str)
                    self.assertIn("emptyFacts", expression)
                    for field in (
                        "surfaceProof",
                        "surfaceRootCount",
                        "emptyMarkerCount",
                        "outsideRootEmptyMarkerCount",
                        "loadingCount",
                        "loginCount",
                        "authCount",
                        "errorCount",
                        "retryCount",
                    ):
                        self.assertIn(field, expression)
                    self.assertIn("roots.length !== 1", expression)
                    self.assertIn('data-testid="emptyState"', expression)
                    self.assertIn("root.querySelectorAll", expression)
                    self.assertIn("!root.contains", expression)
                    self.assertIn('[aria-busy="true"]', expression)
                    self.assertIn('[role="progressbar"]', expression)
                    self.assertIn("getClientRects", expression)
                    self.assertIn("aria-hidden", expression)
                    for field, selector in blocker_selectors.items():
                        field_position = expression.index(field)
                        field_context = expression[
                            max(0, field_position - 800):field_position + 800
                        ]
                        self.assertIn("querySelector", field_context)
                        self.assertTrue(
                            any(
                                selector in field_context
                                for selector in ("[data-testid=", "[role=", "[aria-")
                            )
                        )
                        outside_needle = f"document.body.querySelectorAll('{selector}')"
                        outside_position = expression.index(outside_needle)
                        outside_context = expression[outside_position:outside_position + 500]
                        self.assertIn("!root.contains(node)", outside_context)
                        self.assertIn("visible(node)", outside_context)
                        self.assertNotIn("innerText", field_context)
                        self.assertNotIn("textContent", field_context)

        error_type = None

        def assert_snapshot_failure(call, canary=None):
            nonlocal error_type
            with self.assertRaises(Exception) as context:
                call()
            if error_type is None:
                error_type = type(context.exception)
            self.assertIs(type(context.exception), error_type)
            if canary is not None:
                self.assertNotIn(canary, str(context.exception))

        def evaluate_snapshot(surface, raw, *, canary=None):
            socket = _FakeWebSocket(raw)
            with mock.patch.object(module.websocket, "create_connection", return_value=socket):
                assert_snapshot_failure(
                    lambda: evaluator.evaluate(
                        ws_url,
                        "snapshot",
                        surface=surface,
                        timeout_seconds=timeout_seconds,
                    ),
                    canary=canary,
                )
            self.assertTrue(socket.closed)

        for surface in SURFACE_TARGETS:
            base = _empty_facts(surface, emptyMarkerCount=1)
            invalid_zero = [
                ("no_marker", {**base, "emptyMarkerCount": 0}, None),
                ("two_markers", {**base, "emptyMarkerCount": 2}, None),
                ("outside_marker", {**base, "outsideRootEmptyMarkerCount": 1}, None),
                ("surface_root_zero", {**base, "surfaceRootCount": 0}, None),
                ("surface_root_two", {**base, "surfaceRootCount": 2}, None),
                ("wrong_surface_proof", {
                    **base,
                    "surfaceProof": dict(SURFACE_PROOFS["explore" if surface != "explore" else "for_you"]),
                }, None),
                ("surface_proof_not_dict", {**base, "surfaceProof": "wrong"}, None),
                ("missing_fact", {key: value for key, value in base.items() if key != "retryCount"}, None),
                ("extra_fact", {**base, "extra": "正文CANARY"}, "正文CANARY"),
                ("bool_count", {**base, "emptyMarkerCount": True}, None),
                ("negative_count", {**base, "surfaceRootCount": -1}, None),
            ]
            for blocker in ("loadingCount", "loginCount", "authCount", "errorCount", "retryCount"):
                invalid_zero.append((blocker, {**base, blocker: 1}, None))
            for name, facts, canary in invalid_zero:
                with self.subTest(empty_failure=(surface, name)):
                    evaluate_snapshot(
                        surface,
                        {"cells": [], "emptyFacts": facts},
                        canary=canary,
                    )

            top_level_invalid = (
                ("missing_empty_facts", {"cells": []}, None),
                ("extra_top_level_key", {
                    "cells": [], "emptyFacts": base, "extra": "正文CANARY",
                }, "正文CANARY"),
                ("cells_not_list", {"cells": "not-a-list", "emptyFacts": base}, None),
                ("empty_facts_not_dict", {"cells": [], "emptyFacts": "not-a-dict"}, None),
            )
            for name, raw, canary in top_level_invalid:
                with self.subTest(empty_failure=(surface, name)):
                    evaluate_snapshot(surface, raw, canary=canary)

            with self.subTest(empty_failure=(surface, "legacy_explicit_empty")):
                evaluate_snapshot(
                    surface,
                    {"items": [], "cards": [], "explicitEmpty": True},
                )

        nonempty_candidate = {
            "sourceUrl": "https://x.com/alice/status/808",
            "authorHandle": "alice",
            "publishedAt": TIMESTAMP,
            "body": "nonempty",
            "depth": 0,
            "insideQuote": False,
            "showMoreControlCount": 0,
            "placeholder": False,
        }
        with self.subTest(nonempty_failure="empty_marker_claim"):
            evaluate_snapshot(
                "for_you",
                {
                    "cells": [{"candidates": [nonempty_candidate]}],
                    "emptyFacts": _empty_facts("for_you", emptyMarkerCount=1),
                },
            )
        with self.subTest(nonempty_failure="blocker_claim"):
            evaluate_snapshot(
                "for_you",
                {
                    "cells": [{"candidates": [nonempty_candidate]}],
                    "emptyFacts": _empty_facts("for_you", loadingCount=1),
                },
            )

    def test_cli_static_and_persistence_boundaries(self):
        module = _require_cli(self)
        source = inspect.getsource(module)
        tree = ast.parse(source)
        stdlib = set(getattr(sys, "stdlib_module_names", ()))
        allowed_nonstdlib = {
            "__future__", "websocket", "x_timeline_store",
            "x_personal_feed_observer",
        }
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module.split(".", 1)[0])
        for imported in imports:
            self.assertTrue(imported in stdlib or imported in allowed_nonstdlib, imported)

        lowered = source.lower()
        forbidden_fragments = (
            "collector", "explorer", "topic_search", "pipeline", "dedup", "migrate",
            "daily_report", "insight_engine", "neighborhood", "subprocess",
            "ensure_cdp", "ensure_x_tab", "new_tab", "browser_start", "restart",
            "timeline.append", "append_unique", "history", "shown", "current_collection",
            "session", "logging", "logger", "sys.stderr", "sys.argv", "os.environ", "tempfile",
        )
        for fragment in forbidden_fragments:
            self.assertNotIn(fragment, lowered, fragment)
        path_write_methods = {
            "write_text", "write_bytes", "mkdir", "makedirs", "replace", "rename",
            "unlink", "rmdir", "touch",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotEqual(node.func.id, "open")
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, path_write_methods)

        canary = "正文CANARY_SHOULD_NOT_PERSIST"
        success = {
            "schemaVersion": 1,
            "kind": "complete",
            "startedAt": TIMESTAMP,
            "completedAt": TIMESTAMP,
            "surfaces": [],
            "body": canary,
        }
        with tempfile.TemporaryDirectory() as directory:
            business = Path(directory) / "business"
            business.mkdir()
            files = {
                business / "state.json": b'{"existing":"state"}\n',
                business / "notes.txt": b"existing notes\n",
                business / ".x_timeline_browser.lock": b"precreated lock\n",
            }
            for path, content in files.items():
                path.write_bytes(content)
            before = {path: path.read_bytes() for path in files}

            def failing_observer(_deadline):
                raise RuntimeError(canary)

            for observer in (lambda _deadline: success, failing_observer):
                stderr = io.StringIO()
                stdout = io.StringIO()
                with mock.patch.dict(
                    os.environ,
                    {"DSH_X_FEED_DATA_DIR": str(business)},
                    clear=False,
                ), contextlib.redirect_stderr(stderr):
                    try:
                        result_code = module.main(io.BytesIO(VALID_REQUEST), stdout, observer=observer)
                    except Exception as exc:
                        self.assertNotIn(canary, str(exc))
                        self.fail("production CLI leaked an observer exception")
                self.assertEqual(result_code, 0)
                self.assertNotIn(canary, stderr.getvalue())
                self.assertNotIn(canary, str(stderr))
                after = {path: path.read_bytes() for path in files}
                self.assertEqual(after, before)
                self.assertEqual(
                    sorted(path.relative_to(business).as_posix() for path in business.rglob("*")),
                    sorted(path.relative_to(business).as_posix() for path in files),
                )


if __name__ == "__main__":
    unittest.main()
