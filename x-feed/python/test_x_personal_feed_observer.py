"""Strict RED contract for the personal-feed observer.

The production module is intentionally loaded at test time.  That keeps a
missing implementation as a readable test failure instead of making unittest
collection fail before any contract is reported.
"""

import ast
import importlib
import io
import inspect
import json
import os
import re
import sys
import tempfile
import unittest


MODULE_NAME = "x_personal_feed_observer"
SURFACES = ("for_you", "following", "explore")
SURFACE_URLS = {
    "for_you": "https://x.com/home",
    "following": "https://x.com/home",
    "explore": "https://x.com/explore",
}
SURFACE_PROOFS = {
    "for_you": {"pathname": "/home", "selectedHomeTabOrdinal": 0, "exploreRoot": False},
    "following": {"pathname": "/home", "selectedHomeTabOrdinal": 1, "exploreRoot": False},
    "explore": {"pathname": "/explore", "selectedHomeTabOrdinal": None, "exploreRoot": True},
}
TIMESTAMP = "2026-09-01T00:00:00.000Z"


def _body_item(source_url, author="alice", body="hello", published_at=TIMESTAMP, **extra):
    value = {
        "sourceUrl": source_url,
        "authorHandle": author,
        "publishedAt": published_at,
        "body": body,
        "showMore": False,
        "placeholder": False,
    }
    value.update(extra)
    return value


def _candidate(source_url, author, published_at, body, depth, inside_quote, **extra):
    value = {
        "sourceUrl": source_url,
        "authorHandle": author,
        "publishedAt": published_at,
        "body": body,
        "depth": depth,
        "insideQuote": inside_quote,
        "showMore": False,
        "placeholder": False,
    }
    value.update(extra)
    return value


class _FakeClock:
    def __init__(self, now=1_000_000, advance_each_evaluation=0):
        self.now = now
        self.advance_each_evaluation = advance_each_evaluation
        self.exhaust_at = None
        self.calls = []

    def now_ms(self):
        self.calls.append(("now_ms", self.now))
        return self.now

    def sleep(self, seconds):
        self.calls.append(("sleep", seconds, self.now))
        self.now += int(float(seconds) * 1000)


class _LockContext:
    def __init__(self, owner):
        self.owner = owner

    def __enter__(self):
        self.owner.entered += 1
        if self.owner.error is not None:
            raise self.owner.error
        return self

    def __exit__(self, exc_type, exc, tb):
        self.owner.exited += 1
        return False


class _FakeLock:
    def __init__(self, error=None):
        self.error = error
        self.calls = []
        self.entered = 0
        self.exited = 0

    def lock(self, timeout_seconds=None):
        self.calls.append(timeout_seconds)
        return _LockContext(self)


class _FakeBrowser:
    def __init__(self, clock, tabs=None, cdp=True, classifications=None):
        self.clock = clock
        self.tabs = list(tabs if tabs is not None else [{
            "type": "page",
            "url": SURFACE_URLS["for_you"],
            "webSocketDebuggerUrl": "ws://x/shared",
        }])
        self.cdp = cdp
        self.classifications = classifications or {}
        self.calls = []

    def cdp_ready(self, timeout_seconds):
        self.calls.append(("cdp_ready", timeout_seconds, self.clock.now))
        return self.cdp

    def list_tabs(self, timeout_seconds):
        self.calls.append(("list_tabs", timeout_seconds, self.clock.now))
        return list(self.tabs)

    def is_x_tab(self, tab):
        self.calls.append(("is_x_tab", tab.get("url", ""), self.clock.now))
        return tab.get("type") == "page" and "x.com" in tab.get("url", "")

    def classify_x_page(self, url, body):
        self.calls.append(("classify_x_page", url, self.clock.now))
        return self.classifications.get(url, "ready")


class _FakeEvaluator:
    def __init__(self, clock, plans=None, error_actions=None, exhaust_on=None):
        self.clock = clock
        self.plans = plans or {}
        self.error_actions = set(error_actions or ())
        self.exhaust_on = exhaust_on
        self.calls = []
        self._indexes = {}

    def evaluate(self, ws_url, action, *, surface, stable_id=None, timeout_seconds=None):
        self.calls.append({
            "ws_url": ws_url,
            "action": action,
            "surface": surface,
            "stable_id": stable_id,
            "timeout_seconds": timeout_seconds,
            "at_ms": self.clock.now,
        })
        if (surface, action) in self.error_actions or action in self.error_actions:
            raise RuntimeError("evaluate_failed")
        if self.exhaust_on == (surface, action):
            value = self._value(surface, action)
            if self.clock.exhaust_at is not None:
                self.clock.now = self.clock.exhaust_at
            else:
                self.clock.now = self.clock.now + self.clock.advance_each_evaluation
            return value
        value = self._value(surface, action)
        if self.clock.advance_each_evaluation:
            self.clock.now += self.clock.advance_each_evaluation
        return value

    def _value(self, surface, action):
        key = (surface, action)
        values = self.plans.get(key)
        if values is None:
            return self._default_value(surface, action)
        if not isinstance(values, list):
            return values
        index = self._indexes.get(key, 0)
        self._indexes[key] = index + 1
        if not values:
            return {}
        value = values[index] if index < len(values) else values[-1]
        if isinstance(value, BaseException):
            raise value
        return value

    def _default_value(self, surface, action):
        url = SURFACE_URLS[surface]
        item = _body_item(f"https://x.com/alice/status/{100 + len(surface)}")
        if action == "navigate":
            return {"url": url, "body": "timeline"}
        if action == "probe":
            return {"url": url, "body": "timeline", "surfaceProof": dict(SURFACE_PROOFS[surface])}
        if action == "snapshot":
            return {"items": [item], "cards": [item], "explicitEmpty": False}
        if action == "expand":
            return {"ok": True}
        if action == "scroll":
            return {"ok": True}
        raise AssertionError(f"unexpected action from observer: {action}")


def _plans_for_snapshot(snapshot, surface_proof=None):
    plans = {}
    for surface in SURFACES:
        proof = SURFACE_PROOFS[surface] if surface_proof is None else surface_proof
        plans[(surface, "navigate")] = [{"url": SURFACE_URLS[surface], "body": "timeline"}]
        plans[(surface, "probe")] = [{
            "url": SURFACE_URLS[surface],
            "body": "timeline",
            "surfaceProof": dict(proof),
        }]
        plans[(surface, "snapshot")] = [snapshot]
    return plans


def _invoke(module, clock, browser, lock, evaluator, deadline=1_100_000):
    return module.observe(
        deadline,
        clock=clock,
        browser=browser,
        lock=lock,
        evaluator=evaluator,
    )


def _require_observer(case):
    try:
        return importlib.import_module(MODULE_NAME)
    except ModuleNotFoundError as exc:
        case.fail(
            f"{MODULE_NAME}.py is missing; implement the frozen observer seam "
            f"before exercising this behavior ({exc})"
        )
    except ImportError as exc:
        case.fail(f"{MODULE_NAME} could not be imported without collection failure: {exc}")


def _surface_map(case, result):
    case.assertIsInstance(result, dict)
    case.assertIn("surfaces", result)
    return {entry["surface"]: entry for entry in result["surfaces"]}


def _assert_compact_json_line(case, stream):
    lines = stream.getvalue().splitlines()
    case.assertEqual(len(lines), 1)
    parsed = json.loads(lines[0])
    case.assertEqual(lines[0], json.dumps(parsed, ensure_ascii=False, separators=(",", ":")))
    return parsed


def _assert_utc_z(case, value):
    case.assertIsInstance(value, str)
    case.assertRegex(value, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")


def _assert_incomplete_body_free(case, result, canary=None):
    case.assertEqual(result["kind"], "incomplete")
    for face in result["surfaces"]:
        case.assertEqual(set(face), {"surface", "surfaceOrdinal", "kind"})
    serialized = json.dumps(result, ensure_ascii=False)
    for forbidden in ("body", "text", "sourceUrl", "authorHandle", "publishedAt"):
        case.assertNotIn(forbidden, serialized)
    if canary is not None:
        case.assertNotIn(canary, serialized)


class TestPersonalFeedObserver(unittest.TestCase):
    def test_observe_locks_once_and_walks_fixed_surface_sequence_with_bounded_actions(self):
        module = _require_observer(self)
        clock = _FakeClock(1_000_000, advance_each_evaluation=80)
        deadline = 1_001_000
        clock.exhaust_at = deadline
        browser = _FakeBrowser(clock)
        lock = _FakeLock()
        evaluator = _FakeEvaluator(
            clock,
            plans=_plans_for_snapshot({
                "items": [_body_item("https://x.com/alice/status/101")],
                "cards": [_body_item("https://x.com/alice/status/101")],
                "explicitEmpty": False,
            }),
            exhaust_on=("explore", "snapshot"),
        )

        result = _invoke(module, clock, browser, lock, evaluator, deadline)

        self.assertEqual(lock.entered, 1)
        self.assertEqual(lock.exited, 1)
        first_surface_order = []
        for entry in evaluator.calls:
            if entry["surface"] not in first_surface_order:
                first_surface_order.append(entry["surface"])
        self.assertEqual(first_surface_order, list(SURFACES))
        self.assertEqual(
            [surface for surface in SURFACES if any(c["surface"] == surface for c in evaluator.calls)],
            list(SURFACES),
        )
        self.assertTrue(clock.now >= deadline)
        self.assertFalse(any(call["at_ms"] >= deadline for call in evaluator.calls[1:]))
        for timeout in lock.calls:
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout * 1000, deadline - 1_000_000)
        for call in evaluator.calls:
            remaining_ms = deadline - call["at_ms"]
            self.assertGreater(call["timeout_seconds"], 0)
            self.assertLessEqual(call["timeout_seconds"] * 1000, remaining_ms)
            self.assertIn(call["action"], {"navigate", "probe", "snapshot", "expand", "scroll"})
        self.assertEqual(result["kind"], "incomplete")
        for face in result["surfaces"]:
            self.assertEqual(set(face), {"surface", "surfaceOrdinal", "kind"})

    def test_observe_emits_exact_complete_schema_and_byte_body_union(self):
        module = _require_observer(self)
        cases = (
            ("exact_6144", "你" * 2048, None),
            ("oversize_6145", ("你" * 2048) + "a", None),
            ("empty", "", None),
            ("placeholder", "Show more", {"placeholder": True}),
            ("show_more_failed", "", {"placeholder": True, "showMore": True, "expand_rejected": True}),
            ("show_more_succeeded", "", {"placeholder": True, "showMore": True, "expand_success": True}),
        )
        for name, body, options in cases:
            with self.subTest(case=name):
                clock = _FakeClock()
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                options = options or {}
                item = _body_item(
                    "https://x.com/alice/status/101",
                    body=body,
                    placeholder=options.get("placeholder", False),
                    showMore=options.get("showMore", False),
                )
                plans = _plans_for_snapshot({
                    "items": [item],
                    "cards": [item],
                    "explicitEmpty": False,
                })
                if options.get("expand_rejected"):
                    for surface in SURFACES:
                        plans[(surface, "expand")] = [{"ok": False}]
                if options.get("expand_success"):
                    expanded = _body_item("https://x.com/alice/status/101", body="expanded body")
                    for surface in SURFACES:
                        plans[(surface, "snapshot")] = [
                            {"items": [item], "cards": [item], "explicitEmpty": False},
                            {"items": [expanded], "cards": [expanded], "explicitEmpty": False},
                        ]
                evaluator = _FakeEvaluator(clock, plans=plans)
                result = _invoke(module, clock, browser, lock, evaluator)
                surfaces = _surface_map(self, result)
                self.assertEqual(set(result), {"schemaVersion", "kind", "startedAt", "completedAt", "surfaces"})
                self.assertEqual(result["schemaVersion"], 1)
                self.assertEqual(result["kind"], "complete")
                _assert_utc_z(self, result["startedAt"])
                _assert_utc_z(self, result["completedAt"])
                self.assertEqual(set(surfaces), set(SURFACES))
                for ordinal, surface in enumerate(SURFACES):
                    face = surfaces[surface]
                    self.assertEqual(
                        set(face),
                        {"kind", "surface", "surfaceOrdinal", "startedAt", "completedAt", "occurrences"},
                    )
                    self.assertEqual((face["surface"], face["surfaceOrdinal"]), (surface, ordinal))
                    _assert_utc_z(self, face["startedAt"])
                    _assert_utc_z(self, face["completedAt"])
                    self.assertGreaterEqual(len(face["occurrences"]), 1)
                    occurrence = face["occurrences"][0]
                    self.assertEqual(
                        set(occurrence),
                        {"sourceUrl", "body", "occurrenceOrdinal", "capturedAt", "authorHandle", "publishedAt"},
                    )
                    _assert_utc_z(self, occurrence["capturedAt"])
                    _assert_utc_z(self, occurrence["publishedAt"])
                    self.assertEqual(set(occurrence["body"]), {"kind", "text"} if name in {"exact_6144", "show_more_succeeded"} else {"kind", "reason"})
                    if name == "exact_6144":
                        self.assertEqual(len(body.encode("utf-8")), 6144)
                        self.assertEqual(occurrence["body"], {"kind": "sufficient", "text": body})
                    elif name == "oversize_6145":
                        self.assertEqual(len(body.encode("utf-8")), 6145)
                        self.assertEqual(occurrence["body"]["kind"], "insufficient")
                        self.assertEqual(occurrence["body"]["reason"], "too_large")
                        self.assertNotIn("text", occurrence["body"])
                    elif name == "empty":
                        self.assertEqual(occurrence["body"], {"kind": "insufficient", "reason": "empty"})
                    elif name == "placeholder":
                        self.assertEqual(occurrence["body"], {"kind": "insufficient", "reason": "placeholder"})
                    elif name == "show_more_failed":
                        self.assertEqual(occurrence["body"], {"kind": "insufficient", "reason": "show_more_failed"})
                    elif name == "show_more_succeeded":
                        self.assertEqual(occurrence["body"], {"kind": "sufficient", "text": "expanded body"})

        first = _body_item("https://x.com/alice/status/651", body="first snapshot")
        second = _body_item("https://x.com/alice/status/652", body="second snapshot")
        show_more = _body_item(
            "https://x.com/alice/status/653",
            body="UNCONFIRMED_SHOW_MORE_BODY",
            placeholder=True,
            showMore=True,
        )
        three_snapshot_plans = {}
        for surface in SURFACES:
            three_snapshot_plans[(surface, "snapshot")] = [
                {"items": [first], "cards": [first], "explicitEmpty": False},
                {"items": [second], "cards": [second], "explicitEmpty": False},
                {"items": [show_more], "cards": [show_more], "explicitEmpty": False},
                RuntimeError("fourth_snapshot_forbidden"),
            ]
            three_snapshot_plans[(surface, "expand")] = [{"ok": True}]
        three_clock = _FakeClock()
        three_browser = _FakeBrowser(three_clock)
        three_lock = _FakeLock()
        three_evaluator = _FakeEvaluator(three_clock, plans=three_snapshot_plans)
        three_result = _invoke(module, three_clock, three_browser, three_lock, three_evaluator)
        three_faces = _surface_map(self, three_result)
        self.assertEqual(three_result["kind"], "complete")
        self.assertNotIn("UNCONFIRMED_SHOW_MORE_BODY", json.dumps(three_result, ensure_ascii=False))
        for surface in SURFACES:
            snapshots = [c for c in three_evaluator.calls if c["surface"] == surface and c["action"] == "snapshot"]
            self.assertEqual(len(snapshots), 3)
            candidates = three_faces[surface]["occurrences"]
            self.assertEqual(candidates[2]["body"], {"kind": "insufficient", "reason": "show_more_failed"})
            self.assertEqual(len([c for c in three_evaluator.calls if c["surface"] == surface and c["action"] == "expand"]), 1)
        for call in three_evaluator.calls:
            remaining_ms = 1_100_000 - call["at_ms"]
            self.assertGreater(call["timeout_seconds"], 0)
            self.assertLessEqual(call["timeout_seconds"] * 1000, remaining_ms)

        twelve = [
            _body_item(
                f"https://x.com/alice/status/{700 + index}",
                body=f"UNCONFIRMED_EXPAND_BODY_{index}",
                placeholder=True,
                showMore=True,
            )
            for index in range(12)
        ]
        twelve_plans = _plans_for_snapshot({"items": [], "cards": [], "explicitEmpty": True})
        twelve_plans[("for_you", "snapshot")] = [{
            "items": twelve,
            "cards": twelve,
            "explicitEmpty": False,
        }]
        twelve_plans[("for_you", "expand")] = [{"ok": False}]
        twelve_clock = _FakeClock()
        twelve_browser = _FakeBrowser(twelve_clock)
        twelve_lock = _FakeLock()
        twelve_evaluator = _FakeEvaluator(twelve_clock, plans=twelve_plans)
        twelve_result = _invoke(module, twelve_clock, twelve_browser, twelve_lock, twelve_evaluator)
        twelve_faces = _surface_map(self, twelve_result)
        self.assertEqual(twelve_result["kind"], "complete")
        self.assertEqual(len(twelve_faces["for_you"]["occurrences"]), 8)
        self.assertNotIn("UNCONFIRMED_EXPAND_BODY", json.dumps(twelve_result, ensure_ascii=False))
        fy_expands = [c for c in twelve_evaluator.calls if c["surface"] == "for_you" and c["action"] == "expand"]
        self.assertEqual(len(fy_expands), 8)
        self.assertEqual(
            len([c for c in twelve_evaluator.calls if c["surface"] == "for_you" and c["action"] == "snapshot"]),
            1,
        )
        self.assertEqual(
            len([c for c in twelve_evaluator.calls if c["surface"] == "for_you" and c["action"] == "scroll"]),
            0,
        )
        for late_id in ("708", "709", "710", "711"):
            self.assertFalse(any(late_id in str(call["stable_id"]) for call in fy_expands))
        for call in twelve_evaluator.calls:
            remaining_ms = 1_100_000 - call["at_ms"]
            self.assertGreater(call["timeout_seconds"], 0)
            self.assertLessEqual(call["timeout_seconds"] * 1000, remaining_ms)

        repeat_placeholder = _body_item(
            "https://x.com/alice/status/654",
            body="UNCONFIRMED_REPEAT_PLACEHOLDER_CANARY",
            placeholder=True,
            showMore=True,
        )
        repeat_plans = _plans_for_snapshot({"items": [], "cards": [], "explicitEmpty": True})
        repeat_plans[("for_you", "snapshot")] = [
            {"items": [repeat_placeholder], "cards": [repeat_placeholder], "explicitEmpty": False},
            {"items": [repeat_placeholder], "cards": [repeat_placeholder], "explicitEmpty": False},
        ]
        repeat_plans[("for_you", "expand")] = [{"ok": True}]
        repeat_clock = _FakeClock()
        repeat_browser = _FakeBrowser(repeat_clock)
        repeat_lock = _FakeLock()
        repeat_evaluator = _FakeEvaluator(repeat_clock, plans=repeat_plans)
        repeat_result = _invoke(module, repeat_clock, repeat_browser, repeat_lock, repeat_evaluator)
        repeat_faces = _surface_map(self, repeat_result)
        self.assertEqual(repeat_result["kind"], "complete")
        self.assertEqual(
            repeat_faces["for_you"]["occurrences"],
            [{
                "sourceUrl": "https://x.com/alice/status/654",
                "body": {"kind": "insufficient", "reason": "show_more_failed"},
                "occurrenceOrdinal": 0,
                "capturedAt": repeat_faces["for_you"]["occurrences"][0]["capturedAt"],
                "authorHandle": "alice",
                "publishedAt": TIMESTAMP,
            }],
        )
        self.assertNotIn("UNCONFIRMED_REPEAT_PLACEHOLDER_CANARY", json.dumps(repeat_result, ensure_ascii=False))
        self.assertEqual(
            len([c for c in repeat_evaluator.calls if c["surface"] == "for_you" and c["action"] == "snapshot"]),
            2,
        )
        self.assertEqual(
            len([c for c in repeat_evaluator.calls if c["surface"] == "for_you" and c["action"] == "expand"]),
            1,
        )

    def test_observe_uses_five_surface_states_and_natural_zero_proof(self):
        module = _require_observer(self)
        item = _body_item("https://x.com/alice/status/201")
        cases = (
            ("complete", {"items": [item], "cards": [item], "explicitEmpty": False}, None, None, "complete"),
            ("natural_zero", {"items": [], "cards": [], "explicitEmpty": True}, None, None, "complete"),
            ("empty_without_proof", {"items": [], "cards": []}, None, None, "incomplete"),
            ("partial", {"items": [item], "cards": [item]}, {("for_you", "snapshot"): [
                {"items": [item], "cards": [item], "explicitEmpty": False},
                RuntimeError("snapshot_failed"),
            ]}, None, "incomplete"),
            ("failed", {"items": [], "cards": []}, {("for_you", "snapshot"): [RuntimeError("snapshot_failed")]}, None, "incomplete"),
            ("unknown", {"items": [], "cards": [], "explicitEmpty": True}, None, "mismatch", "incomplete"),
        )
        for name, snapshot, errors, proof_mode, overall_kind in cases:
            with self.subTest(case=name):
                clock = _FakeClock()
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                mismatch = {"pathname": "/notifications", "selectedHomeTabOrdinal": 0, "exploreRoot": False}
                plans = _plans_for_snapshot(snapshot, surface_proof=mismatch if proof_mode == "mismatch" else None)
                if errors:
                    plans.update(errors)
                evaluator = _FakeEvaluator(clock, plans=plans)
                result = _invoke(module, clock, browser, lock, evaluator)
                faces = _surface_map(self, result)
                self.assertEqual(result["kind"], overall_kind)
                for face in faces.values():
                    self.assertIn(face["kind"], {"complete", "natural_zero", "partial", "failed", "unknown"})
                if name == "natural_zero":
                    self.assertTrue(all(faces[s]["kind"] == "natural_zero" for s in SURFACES))
                if name == "empty_without_proof":
                    self.assertNotEqual(faces["for_you"]["kind"], "natural_zero")
                if name == "complete":
                    self.assertTrue(all(faces[s]["kind"] == "complete" for s in SURFACES))
                if overall_kind == "incomplete":
                    for face in result["surfaces"]:
                        self.assertEqual(set(face), {"surface", "surfaceOrdinal", "kind"})

        candidate_empty_clock = _FakeClock()
        candidate_empty_browser = _FakeBrowser(candidate_empty_clock)
        candidate_empty_lock = _FakeLock()
        candidate_empty_plans = _plans_for_snapshot({
            "statusCandidates": [],
            "cards": [],
            "explicitEmpty": True,
        })
        candidate_empty_evaluator = _FakeEvaluator(candidate_empty_clock, plans=candidate_empty_plans)
        candidate_empty_result = _invoke(
            module,
            candidate_empty_clock,
            candidate_empty_browser,
            candidate_empty_lock,
            candidate_empty_evaluator,
        )
        candidate_empty_faces = _surface_map(self, candidate_empty_result)
        self.assertEqual(candidate_empty_result["kind"], "complete")
        self.assertTrue(all(candidate_empty_faces[s]["kind"] == "natural_zero" for s in SURFACES))

    def test_observe_deduplicates_status_per_surface_only(self):
        module = _require_observer(self)
        clock = _FakeClock()
        browser = _FakeBrowser(clock)
        lock = _FakeLock()
        plans = {}
        first = _body_item("https://x.com/alice/status/777", body="first")
        rerender = _body_item("https://x.com/alice/status/777?ref=rerender", body="rerender")
        for surface in SURFACES:
            plans[(surface, "navigate")] = [{"url": SURFACE_URLS[surface], "body": "timeline"}]
            plans[(surface, "probe")] = [{
                "url": SURFACE_URLS[surface],
                "body": "timeline",
                "surfaceProof": dict(SURFACE_PROOFS[surface]),
            }]
            plans[(surface, "snapshot")] = [
                {"items": [first, rerender], "cards": [first, rerender], "explicitEmpty": False},
                {"items": [], "cards": [], "explicitEmpty": False},
            ]
        result = _invoke(module, clock, browser, lock, _FakeEvaluator(clock, plans=plans))
        faces = _surface_map(self, result)
        for surface in SURFACES:
            self.assertEqual(faces[surface]["kind"], "complete")
            self.assertEqual(len(faces[surface]["occurrences"]), 1)
            self.assertEqual(faces[surface]["occurrences"][0]["sourceUrl"], first["sourceUrl"])
            self.assertEqual(faces[surface]["occurrences"][0]["body"].get("text"), "first")
            self.assertEqual(faces[surface]["occurrences"][0]["occurrenceOrdinal"], 0)
        self.assertEqual(
            [faces[s]["occurrences"][0]["sourceUrl"] for s in SURFACES],
            [first["sourceUrl"]] * 3,
            "the same status remains independently observable on every surface",
        )

    def test_observe_selects_canonical_original_from_quote_repost_fixture(self):
        module = _require_observer(self)
        valid_candidates = [
            _candidate(
                "https://x.com/bob/status/200",
                "bob",
                "2026-08-31T23:59:00.000Z",
                "quoted text",
                1,
                True,
            ),
            _candidate(
                "https://twitter.com/alice/status/300/analytics?ref=home",
                "alice",
                "2026-09-01T00:01:00.000Z",
                "reposted original",
                0,
                False,
            ),
        ]
        for candidate in valid_candidates:
            self.assertEqual(set(candidate), {
                "sourceUrl", "authorHandle", "publishedAt", "body", "depth",
                "insideQuote", "showMore", "placeholder",
            })
        canary = "QUOTE_REPOST_BODY_CANARY"
        cases = (
            ("valid_quote_repost", valid_candidates, True),
            ("ambiguous_root_candidates", valid_candidates + [_candidate(
                "https://x.com/carol/status/301", "carol", "2026-09-01T00:02:00.000Z", "other", 0, False
            )], False),
            ("wrong_url_attribution", [
                valid_candidates[0],
                _candidate(
                    "https://x.com/bob/status/302", "alice", "2026-09-01T00:01:00.000Z", "mismatch", 0, False
                ),
            ], False),
            ("invalid_handle", [
                valid_candidates[0],
                _candidate(
                    "https://x.com/alice/status/303", "bad-handle", "2026-09-01T00:01:00.000Z", canary, 0, False
                ),
            ], False),
            ("source_url_over_512_utf8_bytes", [
                valid_candidates[0],
                _candidate(
                    "https://x.com/alice/status/304?" + ("q" * 600),
                    "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
                ),
            ], False),
            ("impossible_date", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/305", "alice", "2026-02-30T00:01:00.000Z", canary, 0, False
            )], False),
            ("missing_milliseconds", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/306", "alice", "2026-09-01T00:01:00Z", canary, 0, False
            )], False),
            ("status_zero", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/0", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("status_leading_zero", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/01", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("unicode_digit_status", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/１２３", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("username_userinfo", [valid_candidates[0], _candidate(
                "https://token@x.com/alice/status/307", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("username_and_password", [valid_candidates[0], _candidate(
                "https://alice:password@x.com/alice/status/308", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("explicit_default_port", [valid_candidates[0], _candidate(
                "https://x.com:443/alice/status/309", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("non_default_port", [valid_candidates[0], _candidate(
                "https://x.com:8443/alice/status/310", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("text_port", [valid_candidates[0], _candidate(
                "https://x.com:abc/alice/status/311", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("double_slash_path", [valid_candidates[0], _candidate(
                "https://x.com//alice/status/312", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("extra_path", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/313/media", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("disallowed_host", [valid_candidates[0], _candidate(
                "https://example.com/alice/status/314", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
            ("fragment", [valid_candidates[0], _candidate(
                "https://x.com/alice/status/315#frag", "alice", "2026-09-01T00:01:00.000Z", canary, 0, False
            )], False),
        )
        for name, candidates, should_capture in cases:
            with self.subTest(case=name):
                clock = _FakeClock()
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                plans = _plans_for_snapshot({
                    "statusCandidates": candidates,
                    "explicitEmpty": False,
                })
                result = _invoke(module, clock, browser, lock, _FakeEvaluator(clock, plans=plans))
                faces = _surface_map(self, result)
                if should_capture:
                    for surface in SURFACES:
                        occurrence = faces[surface]["occurrences"][0]
                        self.assertEqual(occurrence["sourceUrl"], "https://x.com/alice/status/300")
                        self.assertEqual(occurrence["authorHandle"], "alice")
                        self.assertEqual(occurrence["publishedAt"], "2026-09-01T00:01:00.000Z")
                        self.assertNotIn("twitter.com", occurrence["sourceUrl"])
                else:
                    _assert_incomplete_body_free(self, result, canary=canary)

    def test_observe_bounds_capture_and_keeps_incomplete_body_free(self):
        module = _require_observer(self)
        item = _body_item("https://x.com/alice/status/401")
        cases = ("partial_after_items", "failed_before_items", "proof_unknown")
        for name in cases:
            with self.subTest(case=name):
                clock = _FakeClock()
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                plans = _plans_for_snapshot({"items": [item], "cards": [item], "explicitEmpty": False})
                errors = {}
                if name == "partial_after_items":
                    plans[("for_you", "snapshot")] = [
                        {"items": [item], "cards": [item], "explicitEmpty": False},
                        RuntimeError("snapshot_failed"),
                    ]
                elif name == "failed_before_items":
                    errors[("following", "snapshot")] = [RuntimeError("snapshot_failed")]
                    plans.update(errors)
                else:
                    plans = _plans_for_snapshot({"items": [], "cards": []}, surface_proof={
                        "pathname": "/notifications",
                        "selectedHomeTabOrdinal": 0,
                        "exploreRoot": False,
                    })
                evaluator = _FakeEvaluator(clock, plans=plans)
                result = _invoke(module, clock, browser, lock, evaluator)
                self.assertEqual(result["kind"], "incomplete")
                for face in result["surfaces"]:
                    self.assertEqual(set(face), {"surface", "surfaceOrdinal", "kind"})
                if name == "partial_after_items":
                    self.assertEqual(_surface_map(self, result)["for_you"]["kind"], "partial")
                elif name == "failed_before_items":
                    self.assertEqual(_surface_map(self, result)["following"]["kind"], "failed")
                else:
                    faces = _surface_map(self, result)
                    self.assertTrue(all(faces[s]["kind"] == "unknown" for s in SURFACES))
                for surface in SURFACES:
                    snapshot_calls = [
                        c for c in evaluator.calls
                        if c["surface"] == surface and c["action"] == "snapshot"
                    ]
                    scroll_calls = [
                        c for c in evaluator.calls
                        if c["surface"] == surface and c["action"] == "scroll"
                    ]
                    self.assertLessEqual(len(snapshot_calls), 3)
                    self.assertLessEqual(len(scroll_calls), 3)

        eight_items = [
            _body_item(f"https://x.com/alice/status/{500 + index}", body=f"item-{index}")
            for index in range(8)
        ]
        stop_plans = _plans_for_snapshot({"items": [], "cards": [], "explicitEmpty": True})
        stop_plans[("for_you", "snapshot")] = [{
            "items": eight_items,
            "cards": eight_items,
            "explicitEmpty": False,
        }, RuntimeError("ninth_snapshot_forbidden")]
        stop_evaluator = _FakeEvaluator(
            _FakeClock(),
            plans=stop_plans,
        )
        stop_clock = stop_evaluator.clock
        stop_browser = _FakeBrowser(stop_clock)
        stop_lock = _FakeLock()
        stop_result = _invoke(module, stop_clock, stop_browser, stop_lock, stop_evaluator)
        stop_faces = _surface_map(self, stop_result)
        self.assertEqual(stop_faces["for_you"]["kind"], "complete")
        self.assertEqual(len(stop_faces["for_you"]["occurrences"]), 8)
        self.assertEqual(
            len([c for c in stop_evaluator.calls if c["surface"] == "for_you" and c["action"] == "snapshot"]),
            1,
        )
        self.assertEqual(
            len([c for c in stop_evaluator.calls if c["surface"] == "for_you" and c["action"] == "scroll"]),
            0,
            "eight occurrences stop capture before a ninth scroll",
        )

        slot_items = [
            _body_item(f"https://x.com/alice/status/{800 + index}", body=f"slot-{index}")
            for index in range(8)
        ]
        slot_canary = "SLOT_NINTH_INVALID_URL_CANARY"
        invalid_ninth = _body_item(
            "not-a-url",
            body=slot_canary,
            placeholder=True,
            showMore=True,
        )
        nine_plans = _plans_for_snapshot({"items": [], "cards": [], "explicitEmpty": True})
        nine_plans[("for_you", "snapshot")] = [{
            "items": slot_items + [invalid_ninth],
            "cards": slot_items + [invalid_ninth],
            "explicitEmpty": False,
        }]
        nine_clock = _FakeClock()
        nine_browser = _FakeBrowser(nine_clock)
        nine_lock = _FakeLock()
        nine_evaluator = _FakeEvaluator(nine_clock, plans=nine_plans)
        nine_result = _invoke(module, nine_clock, nine_browser, nine_lock, nine_evaluator)
        nine_faces = _surface_map(self, nine_result)
        self.assertEqual(nine_result["kind"], "complete")
        self.assertEqual(len(nine_faces["for_you"]["occurrences"]), 8)
        self.assertNotIn(slot_canary, json.dumps(nine_result, ensure_ascii=False))
        self.assertFalse(any("808" in str(call["stable_id"]) for call in nine_evaluator.calls if call["action"] == "expand"))
        self.assertEqual(
            len([c for c in nine_evaluator.calls if c["surface"] == "for_you" and c["action"] == "snapshot"]),
            1,
        )
        self.assertEqual(
            len([c for c in nine_evaluator.calls if c["surface"] == "for_you" and c["action"] == "scroll"]),
            0,
        )

    def test_observe_fails_closed_on_browser_lock_tab_navigation_and_deadline(self):
        module = _require_observer(self)
        cases = (
            ("cdp_unavailable", "browser_unavailable"),
            ("lock_timeout", "lock_timeout"),
            ("no_x_tab", "tab_unavailable"),
            ("navigation_error", "navigation_failed"),
            ("evaluate_error", "evaluate_failed"),
            ("deadline_exhausted", "deadline_exhausted"),
        )
        for name, expected_reason in cases:
            with self.subTest(case=name):
                clock = _FakeClock(1_000_000)
                deadline = 1_000_000 if name == "deadline_exhausted" else 1_100_000
                tabs = [] if name == "no_x_tab" else None
                browser = _FakeBrowser(clock, tabs=tabs, cdp=name != "cdp_unavailable")
                lock = _FakeLock(TimeoutError(expected_reason) if name == "lock_timeout" else None)
                errors = {("for_you", "navigate")} if name == "navigation_error" else set()
                if name == "evaluate_error":
                    errors = {("for_you", "probe")}
                evaluator = _FakeEvaluator(clock, plans=_plans_for_snapshot({"items": []}), error_actions=errors)
                result = _invoke(module, clock, browser, lock, evaluator, deadline)
                _assert_incomplete_body_free(self, result)
                touched_surfaces = {call["surface"] for call in evaluator.calls}
                self.assertNotIn("following", touched_surfaces)
                self.assertNotIn("explore", touched_surfaces)
                if name == "deadline_exhausted":
                    self.assertEqual(evaluator.calls, [])
                self.assertNotIn("body", json.dumps(result, ensure_ascii=False))
                self.assertNotIn("ensure_cdp", browser.calls)
                self.assertNotIn("ensure_x_tab", browser.calls)
                self.assertNotIn("new_tab", browser.calls)
                self.assertNotIn("run_browser_start", browser.calls)
                if name in {"cdp_unavailable", "lock_timeout", "no_x_tab"}:
                    self.assertEqual([face["kind"] for face in result["surfaces"]], ["unknown"] * 3)

        canary = "LATE_CANARY_BODY"
        item = _body_item("https://x.com/alice/status/601", body=canary)
        matrix = (
            ("fy_navigation_failed", ["failed", "unknown", "unknown"], {("for_you", "navigate"): RuntimeError("navigation_failed")}, None, None),
            ("fy_complete_following_navigation_failed", ["complete", "failed", "unknown"], {("following", "navigate"): RuntimeError("navigation_failed")}, None, None),
            ("proof_mismatch_and_closed_tail", ["unknown", "unknown", "unknown"], {}, {
                "pathname": "/notifications", "selectedHomeTabOrdinal": 0, "exploreRoot": False,
            }, None),
            ("fy_canary_scroll_deadline", ["partial", "unknown", "unknown"], {}, None, ("for_you", "scroll")),
        )
        for name, expected_kinds, errors, proof_override, exhaust_on in matrix:
            with self.subTest(matrix_case=name):
                clock = _FakeClock()
                deadline = 1_100_000
                clock.exhaust_at = deadline if exhaust_on else None
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                plans = _plans_for_snapshot({
                    "items": [item] if name != "proof_mismatch_and_closed_tail" else [],
                    "cards": [item] if name != "proof_mismatch_and_closed_tail" else [],
                    "explicitEmpty": False,
                }, surface_proof=proof_override)
                if name == "fy_complete_following_navigation_failed":
                    following_empty = {"items": [], "cards": [], "explicitEmpty": True}
                    plans[("for_you", "snapshot")] = [{"items": [item], "cards": [item], "explicitEmpty": False}, following_empty]
                    plans[("following", "navigate")] = [{"url": SURFACE_URLS["following"], "body": "timeline"}]
                if name == "fy_canary_scroll_deadline":
                    plans[("for_you", "snapshot")] = [{"items": [item], "cards": [item], "explicitEmpty": False}]
                evaluator = _FakeEvaluator(clock, plans=plans, error_actions=errors, exhaust_on=exhaust_on)
                result = _invoke(module, clock, browser, lock, evaluator, deadline)
                _assert_incomplete_body_free(self, result, canary=canary)
                self.assertEqual([face["kind"] for face in result["surfaces"]], expected_kinds)
                touched = {call["surface"] for call in evaluator.calls}
                first_nonclosed = expected_kinds.index(next(kind for kind in expected_kinds if kind != "complete"))
                self.assertEqual(
                    touched.intersection(SURFACES[first_nonclosed + 1:]),
                    set(),
                    "no evaluator call is allowed after the first non-closed surface",
                )
                for call in evaluator.calls:
                    remaining_ms = deadline - call["at_ms"]
                    self.assertGreater(call["timeout_seconds"], 0)
                    self.assertLessEqual(call["timeout_seconds"] * 1000, remaining_ms)

        expand_placeholder = _body_item(
            "https://x.com/alice/status/602",
            body=canary,
            placeholder=True,
            showMore=True,
        )
        expand_cases = (
            ("expand_error_without_trusted_occurrence", ["failed", "unknown", "unknown"], [expand_placeholder]),
            ("expand_error_after_trusted_occurrence", ["partial", "unknown", "unknown"], [item, expand_placeholder]),
        )
        for name, expected_kinds, items in expand_cases:
            with self.subTest(expand_matrix_case=name):
                clock = _FakeClock()
                deadline = 1_100_000
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                plans = _plans_for_snapshot({
                    "items": [],
                    "cards": [],
                    "explicitEmpty": True,
                })
                if name == "expand_error_after_trusted_occurrence":
                    plans[("for_you", "snapshot")] = [
                        {
                            "items": [items[0]],
                            "cards": [items[0]],
                            "explicitEmpty": False,
                        },
                        {
                            "items": [items[1]],
                            "cards": [items[1]],
                            "explicitEmpty": False,
                        },
                    ]
                else:
                    plans[("for_you", "snapshot")] = [{
                        "items": items,
                        "cards": items,
                        "explicitEmpty": False,
                    }]
                evaluator = _FakeEvaluator(
                    clock,
                    plans=plans,
                    error_actions={("for_you", "expand")},
                )
                result = _invoke(module, clock, browser, lock, evaluator, deadline)
                _assert_incomplete_body_free(self, result, canary=canary)
                self.assertEqual([face["kind"] for face in result["surfaces"]], expected_kinds)
                self.assertEqual(
                    len([c for c in evaluator.calls if c["surface"] == "for_you" and c["action"] == "expand"]),
                    1,
                )
                if name == "expand_error_after_trusted_occurrence":
                    fy_calls = [c for c in evaluator.calls if c["surface"] == "for_you"]
                    snapshot_indexes = [i for i, call in enumerate(fy_calls) if call["action"] == "snapshot"]
                    scroll_indexes = [i for i, call in enumerate(fy_calls) if call["action"] == "scroll"]
                    expand_indexes = [i for i, call in enumerate(fy_calls) if call["action"] == "expand"]
                    self.assertEqual(len(snapshot_indexes), 2)
                    self.assertTrue(any(snapshot_indexes[0] < i < snapshot_indexes[1] for i in scroll_indexes))
                    self.assertTrue(expand_indexes and expand_indexes[0] > snapshot_indexes[1])
                self.assertEqual(
                    {call["surface"] for call in evaluator.calls if call["surface"] != "for_you"},
                    set(),
                )

    def test_run_cli_encodes_injected_observer_results_and_bad_input(self):
        module = _require_observer(self)
        observer_parameter = inspect.signature(module.run_cli).parameters["observer"]
        self.assertEqual(observer_parameter.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(observer_parameter.default, inspect.Signature.empty)
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
            "surfaces": [{"surface": "for_you", "surfaceOrdinal": 0, "kind": "failed"}],
        }
        valid_raw = json.dumps({"schemaVersion": 1, "deadlineEpochMs": 1_100_000}, separators=(",", ":")).encode()
        with self.assertRaises(TypeError):
            module.run_cli(valid_raw, stdout=io.StringIO())
        for name, raw, observer, expected_kind in (
            ("success", valid_raw, lambda *args, **kwargs: success, "complete"),
            ("incomplete", valid_raw, lambda *args, **kwargs: incomplete, "incomplete"),
            ("malformed", b"not-json", lambda *args, **kwargs: self.fail("observer must not run"), "invalid_input"),
            ("wrong_schema", b'{"schemaVersion":2,"deadlineEpochMs":1100000}', lambda *args, **kwargs: self.fail("observer must not run"), "invalid_input"),
            ("zero_deadline", b'{"schemaVersion":1,"deadlineEpochMs":0}', lambda *args, **kwargs: self.fail("observer must not run"), "invalid_input"),
            ("oversize", b"{" + b"a" * 4097 + b"}", lambda *args, **kwargs: self.fail("observer must not run"), "invalid_input"),
            ("observer_throw", valid_raw, lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")), "observer_failed"),
        ):
            with self.subTest(case=name):
                stdout = io.StringIO()
                rc = module.run_cli(raw, stdout=stdout, observer=observer)
                self.assertEqual(rc, 0)
                value = _assert_compact_json_line(self, stdout)
                self.assertEqual(value["kind"], expected_kind)
                if name == "observer_throw":
                    self.assertEqual(value, {"schemaVersion": 1, "kind": "observer_failed"})
                    self.assertNotIn("boom", stdout.getvalue())
                if name in {"malformed", "wrong_schema", "zero_deadline", "oversize"}:
                    self.assertNotIn("body", stdout.getvalue())

    def test_observer_static_and_persistence_boundaries(self):
        module = _require_observer(self)
        source = inspect.getsource(module)
        tree = ast.parse(source)
        stdlib = set(getattr(sys, "stdlib_module_names", ()))
        allowed_nonstdlib = {"__future__", "websocket", "x_browser", "x_timeline_store"}
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module.split(".", 1)[0])
        for imported in imports:
            self.assertTrue(imported in stdlib or imported in allowed_nonstdlib, imported)
        forbidden_fragments = (
            "collector", "explorer", "topic_search", "pipeline", "dedup", "migrate",
            "daily_report", "insight_engine", "neighborhood", "subprocess", "browser_start",
            "ensure_cdp", "ensure_x_tab", "new_tab", "restart", "append_unique", "os.makedirs",
            "os.replace", "tempfile", "shutil",
        )
        lowered = source.lower()
        for fragment in forbidden_fragments:
            self.assertNotIn(fragment, lowered, fragment)
        for identifier in ("timeline", "history", "shown", "current_collection"):
            self.assertIsNone(re.search(rf"\b{re.escape(identifier)}\b", lowered), identifier)
        self.assertIsNone(re.search(r"\bopen\s*\(", source))
        self.assertIsNone(re.search(r"\b(?:write|append|unlink|remove|mkdir)\s*\(", source))

        with tempfile.TemporaryDirectory() as directory:
            lock_path = os.path.join(directory, ".x_timeline_browser.lock")
            with open(lock_path, "wb") as handle:
                handle.write(b"lock-only\n")
            before = []
            for root, dirs, files in os.walk(directory):
                for filename in sorted(files):
                    path = os.path.join(root, filename)
                    with open(path, "rb") as handle:
                        content = handle.read()
                    before.append((os.path.relpath(path, directory), content))
            old_cwd = os.getcwd()
            try:
                os.chdir(directory)
                clock = _FakeClock()
                browser = _FakeBrowser(clock)
                lock = _FakeLock()
                evaluator = _FakeEvaluator(clock, plans=_plans_for_snapshot({
                    "items": [_body_item("https://x.com/alice/status/999", body="PERSISTENCE_CANARY")],
                    "cards": [],
                    "explicitEmpty": False,
                }))
                result = _invoke(module, clock, browser, lock, evaluator)
            finally:
                os.chdir(old_cwd)
            after = []
            for root, dirs, files in os.walk(directory):
                for filename in sorted(files):
                    path = os.path.join(root, filename)
                    with open(path, "rb") as handle:
                        content = handle.read()
                    after.append((os.path.relpath(path, directory), content))
            self.assertEqual(after, before)
            self.assertNotIn(b"PERSISTENCE_CANARY", b"".join(content for _, content in after))
            self.assertIsInstance(result, dict)


    def test_observe_expansion_resnapshot_scrolls_and_collects_new_root(self):
        module = _require_observer(self)
        clock = _FakeClock(1_000_000, advance_each_evaluation=80)
        deadline = 1_010_000
        canary = "UNCONFIRMED_PLACEHOLDER_BODY_CANARY"
        source_a = "https://x.com/alice/status/101"
        source_b = "https://x.com/bob/status/202"

        snapshot_one = {
            "items": [
                _candidate(
                    source_a,
                    "alice",
                    TIMESTAMP,
                    canary,
                    0,
                    False,
                    showMore=True,
                    placeholder=True,
                )
            ],
            "cards": [],
            "explicitEmpty": False,
        }
        snapshot_two = {
            "items": [
                _candidate(
                    source_a,
                    "alice",
                    TIMESTAMP,
                    "expanded A",
                    0,
                    False,
                    showMore=False,
                    placeholder=False,
                )
            ],
            "cards": [],
            "explicitEmpty": False,
        }
        snapshot_three = {
            "items": [
                _candidate(
                    source_b,
                    "bob",
                    "2026-09-01T00:00:01.000Z",
                    "B",
                    0,
                    False,
                    showMore=False,
                    placeholder=False,
                )
            ],
            "cards": [],
            "explicitEmpty": False,
        }
        ordinary_snapshot = {
            "items": [_body_item("https://x.com/carol/status/303", author="carol", body="ordinary")],
            "cards": [],
            "explicitEmpty": False,
        }
        plans = _plans_for_snapshot(ordinary_snapshot)
        plans[("for_you", "snapshot")] = [
            snapshot_one,
            snapshot_two,
            snapshot_three,
            RuntimeError(canary),
        ]
        plans[("for_you", "expand")] = [{"ok": True}]
        evaluator = _FakeEvaluator(clock, plans=plans)
        browser = _FakeBrowser(clock)
        lock = _FakeLock()

        result = _invoke(module, clock, browser, lock, evaluator, deadline)

        self.assertEqual(result["kind"], "complete")
        self.assertNotIn(canary, json.dumps(result, ensure_ascii=False))
        faces = _surface_map(self, result)
        for surface in ("following", "explore"):
            self.assertIn(faces[surface]["kind"], {"complete", "natural_zero"})

        for_you = faces["for_you"]
        self.assertEqual(for_you["kind"], "complete")
        occurrences = for_you["occurrences"]
        self.assertEqual([item["sourceUrl"] for item in occurrences], [source_a, source_b])
        self.assertEqual([item["occurrenceOrdinal"] for item in occurrences], [0, 1])
        self.assertEqual(
            [item["body"] for item in occurrences],
            [
                {"kind": "sufficient", "text": "expanded A"},
                {"kind": "sufficient", "text": "B"},
            ],
        )
        for item in occurrences:
            _assert_utc_z(self, item["capturedAt"])

        for_you_calls = [call for call in evaluator.calls if call["surface"] == "for_you"]
        snapshot_calls = [call for call in for_you_calls if call["action"] == "snapshot"]
        expand_calls = [call for call in for_you_calls if call["action"] == "expand"]
        scroll_calls = [call for call in for_you_calls if call["action"] == "scroll"]
        self.assertEqual(len(snapshot_calls), 3)
        self.assertEqual(len(expand_calls), 1)
        self.assertEqual(expand_calls[0]["stable_id"], source_a)
        self.assertEqual(len(scroll_calls), 1)
        snapshot_indexes = [index for index, call in enumerate(for_you_calls) if call["action"] == "snapshot"]
        expand_indexes = [index for index, call in enumerate(for_you_calls) if call["action"] == "expand"]
        scroll_indexes = [index for index, call in enumerate(for_you_calls) if call["action"] == "scroll"]
        self.assertEqual(len(snapshot_indexes), 3)
        self.assertEqual(len(expand_indexes), 1)
        self.assertTrue(snapshot_indexes[0] < expand_indexes[0] < snapshot_indexes[1])
        self.assertTrue(snapshot_indexes[1] < scroll_indexes[0] < snapshot_indexes[2])
        self.assertEqual(
            [call["action"] for call in for_you_calls],
            ["navigate", "probe", "snapshot", "expand", "snapshot", "scroll", "snapshot"],
        )

        self.assertEqual(lock.entered, 1)
        self.assertEqual(lock.exited, 1)
        for timeout in lock.calls:
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout * 1000, deadline - 1_000_000)
        for call in evaluator.calls:
            remaining_ms = deadline - call["at_ms"]
            self.assertGreater(call["timeout_seconds"], 0)
            self.assertLessEqual(call["timeout_seconds"] * 1000, remaining_ms)


if __name__ == "__main__":
    unittest.main()
