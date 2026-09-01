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
VALID_REQUEST = b'{"schemaVersion":1,"deadlineEpochMs":2000000000000}'
EXPIRED_REQUEST = b'{"schemaVersion":1,"deadlineEpochMs":1}'
TIMESTAMP = "2026-09-01T00:00:00.000Z"
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
        return {"url": SURFACE_TARGETS[surface], "body": "bounded page body"}
    if action == "probe":
        return {"surfaceProof": dict(SURFACE_PROOFS[surface])}
    if action == "snapshot":
        return {
            "statusCandidates": [
                {
                    "sourceUrl": "https://x.com/alice/status/42",
                    "authorHandle": "alice",
                    "publishedAt": TIMESTAMP,
                    "body": "root",
                    "depth": 0,
                    "insideQuote": False,
                    "showMore": False,
                    "placeholder": False,
                },
                {
                    "sourceUrl": "https://x.com/bob/status/43",
                    "authorHandle": "bob",
                    "publishedAt": TIMESTAMP,
                    "body": "quoted and reposted",
                    "depth": 1,
                    "insideQuote": True,
                    "showMore": True,
                    "placeholder": False,
                },
            ],
            "explicitEmpty": False,
        }
    if action in {"expand", "scroll"}:
        return {"ok": True}
    raise AssertionError(action)


class _FakeWebSocket:
    def __init__(self, value, *, response_id=None, recv_error=None, oversize=False):
        self.value = value
        self.response_id = response_id
        self.recv_error = recv_error
        self.oversize = oversize
        self.sent = []
        self.closed = False
        self.timeouts = []

    def settimeout(self, value):
        self.timeouts.append(value)

    def send(self, message):
        self.sent.append(json.loads(message))

    def recv(self):
        if self.recv_error is not None:
            raise self.recv_error
        request_id = self.sent[-1]["id"]
        response_id = request_id if self.response_id is None else self.response_id
        response = {"id": response_id, "result": {"result": {"value": self.value}}}
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
        return self.payload


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
        for expected in (success, incomplete):
            with self.subTest(kind=expected["kind"]):
                returncode, stdout, stderr = _run_bootstrap(SOURCE_PATH, expected)
                self.assertEqual(returncode, 0)
                self.assertEqual(stderr, b"")
                self.assertEqual(json.loads(stdout), expected)
                self.assertEqual(
                    stdout.decode("utf-8"),
                    json.dumps(expected, ensure_ascii=False, separators=(",", ":")) + "\n",
                )

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
        self.assertTrue(all(0 < size <= 1024 * 1024 for size in read_sizes))

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
        ws_url = "ws://127.0.0.1:9222/devtools/page/page-1"
        stable_id = "https://x.com/alice/status/42"
        created = []
        timeout_seconds = 2.0
        current_surface = ["for_you"]

        def create_connection(url, timeout=None, **kwargs):
            self.assertEqual(url, ws_url)
            socket = _FakeWebSocket(_response_value(current_action[0], current_surface[0]))
            socket.connection_kwargs = kwargs
            created.append(socket)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, timeout_seconds)
            return socket

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
                self.assertFalse(value["explicitEmpty"])
                self.assertEqual(value["statusCandidates"][1]["insideQuote"], True)
                for field in (
                    "sourceUrl", "authorHandle", "publishedAt", "body", "depth",
                    "insideQuote", "showMore", "placeholder",
                ):
                    self.assertIn(field, value["statusCandidates"][1])
            elif action == "expand":
                self.assertTrue(value["ok"])
                self.assertIn(stable_id, expression)
            else:
                self.assertTrue(value["ok"])
                self.assertIn("innerHeight", expression)

        explicit_empty = _FakeWebSocket({"items": [], "cards": [], "explicitEmpty": True})
        with mock.patch.object(module.websocket, "create_connection", return_value=explicit_empty):
            value = evaluator.evaluate(
                ws_url,
                "snapshot",
                surface="for_you",
                timeout_seconds=timeout_seconds,
            )
        self.assertEqual(value, {"items": [], "cards": [], "explicitEmpty": True})
        self.assertTrue(explicit_empty.closed)

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

        ambiguous = _FakeWebSocket({"ok": False})
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
            "session", "log", "sys.argv", "os.environ", "tempfile",
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
