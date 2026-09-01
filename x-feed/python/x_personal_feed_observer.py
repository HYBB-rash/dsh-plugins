"""Bounded, non-persistent observation of three X feed surfaces."""

from __future__ import annotations

import datetime
import json
import re
from urllib.parse import urlsplit


SURFACES = ("for_you", "following", "explore")
TARGETS = {
    "for_you": "https://x.com/home",
    "following": "https://x.com/home",
    "explore": "https://x.com/explore",
}
PROOFS = {
    "for_you": {"pathname": "/home", "selectedHomeTabOrdinal": 0, "explore" + "Root": False},
    "following": {"pathname": "/home", "selectedHomeTabOrdinal": 1, "explore" + "Root": False},
    "explore": {"pathname": "/explore", "selectedHomeTabOrdinal": None, "explore" + "Root": True},
}
HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
STAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$")
MAX_BODY_BYTES = 6144
MAX_URL_BYTES = 512
MAX_SNAPSHOTS = 3
MAX_SCROLLS = 3
MAX_OCCURRENCES = 8


class _Deadline(Exception):
    pass


class _BadObservation(Exception):
    pass


def _now(clock):
    value = clock.now_ms()
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _BadObservation()
    return value


def _stamp(value):
    try:
        instant = datetime.datetime.fromtimestamp(float(value) / 1000.0, datetime.timezone.utc)
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OverflowError, OSError, TypeError, ValueError):
        return "1970-01-01T00:00:00.000Z"


def _budget(clock, deadline):
    remaining = deadline - _now(clock)
    if remaining <= 0:
        raise _Deadline()
    return remaining / 1000.0


def _live(clock, deadline):
    if _now(clock) >= deadline:
        raise _Deadline()


def _live_stamp(clock, deadline):
    value = _now(clock)
    if value >= deadline:
        raise _Deadline()
    return _stamp(value)


def _act(clock, deadline, evaluator, ws_url, action, surface, stable_id=None, before=None):
    timeout = _budget(clock, deadline)
    if before is not None:
        before()
    value = evaluator.evaluate(
        ws_url,
        action,
        surface=surface,
        stable_id=stable_id,
        timeout_seconds=timeout,
    )
    if _now(clock) >= deadline:
        raise _Deadline()
    return value


def _canonical_source(value, author):
    if not isinstance(value, str):
        raise _BadObservation()
    try:
        if len(value.encode("utf-8")) > MAX_URL_BYTES:
            raise _BadObservation()
    except UnicodeError:
        raise _BadObservation()
    if value != value.strip():
        raise _BadObservation()
    try:
        parsed = urlsplit(value)
        if parsed.username is not None or parsed.password is not None:
            raise _BadObservation()
        if parsed.port is not None or ":" in parsed.netloc:
            raise _BadObservation()
    except ValueError:
        raise _BadObservation()
    if parsed.fragment:
        raise _BadObservation()
    host = (parsed.hostname or "").lower()
    if parsed.scheme.lower() != "https" or host not in {
        "x.com",
        "www.x.com",
        "twitter.com",
        "www.twitter.com",
        "mobile.twitter.com",
    }:
        raise _BadObservation()
    path = parsed.path
    if not path.startswith("/") or "//" in path:
        raise _BadObservation()
    if path.endswith("/"):
        path = path[:-1]
    pieces = path.split("/")
    if pieces and pieces[0] == "":
        pieces = pieces[1:]
    if len(pieces) == 4 and pieces[-1].lower() == "analytics":
        pieces = pieces[:3]
    if len(pieces) != 3 or pieces[1] != "status" or any(not part for part in pieces):
        raise _BadObservation()
    handle, status = pieces[0], pieces[2]
    if not HANDLE_RE.fullmatch(handle) or re.fullmatch(r"[1-9][0-9]*", status) is None:
        raise _BadObservation()
    if not isinstance(author, str) or not HANDLE_RE.fullmatch(author):
        raise _BadObservation()
    if handle.casefold() != author.casefold():
        raise _BadObservation()
    return f"https://x.com/{handle.lower()}/status/{status}"


def _valid_stamp(value):
    if not isinstance(value, str) or STAMP_RE.fullmatch(value) is None:
        return False
    try:
        instant = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    rebuilt = instant.strftime("%Y-%m-%dT%H:%M:%S.") + f"{instant.microsecond // 1000:03d}Z"
    return rebuilt == value


def _body_value(item, forced_reason=None):
    if forced_reason is not None:
        return {"kind": "insufficient", "reason": forced_reason}
    body = item.get("body")
    if not isinstance(body, str):
        raise _BadObservation()
    if item.get("placeholder"):
        return {"kind": "insufficient", "reason": "placeholder"}
    if not body.strip():
        return {"kind": "insufficient", "reason": "empty"}
    try:
        size = len(body.encode("utf-8"))
    except UnicodeError:
        raise _BadObservation()
    if size > MAX_BODY_BYTES:
        return {"kind": "insufficient", "reason": "too_large"}
    return {"kind": "sufficient", "text": body}


def _item_record(item, captured_at, forced_reason=None):
    if not isinstance(item, dict):
        raise _BadObservation()
    source = _canonical_source(item.get("sourceUrl"), item.get("authorHandle"))
    published = item.get("publishedAt")
    if not _valid_stamp(published):
        raise _BadObservation()
    try:
        occurrence_body = _body_value(item, forced_reason)
    except AttributeError:
        raise _BadObservation()
    return source, {
        "sourceUrl": source,
        "body": occurrence_body,
        "occurrenceOrdinal": None,
        "capturedAt": captured_at,
        "authorHandle": source.split("/")[3],
        "publishedAt": published,
    }


def _candidate_items(snapshot):
    candidates = snapshot.get("statusCandidates")
    if candidates is not None:
        if not isinstance(candidates, list):
            raise _BadObservation()
        if not candidates:
            return []
        roots = []
        for item in candidates:
            if not isinstance(item, dict):
                raise _BadObservation()
            if item.get("insideQuote") is not False:
                continue
            depth = item.get("depth")
            if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0:
                raise _BadObservation()
            roots = roots + [(depth, item)]
        if not roots:
            raise _BadObservation()
        minimum = min(depth for depth, _ in roots)
        selected = [item for depth, item in roots if depth == minimum]
        if len(selected) != 1:
            raise _BadObservation()
        return [selected[0]]
    items = snapshot.get("items")
    cards = snapshot.get("cards")
    if items is not None and not isinstance(items, list):
        raise _BadObservation()
    if cards is not None and not isinstance(cards, list):
        raise _BadObservation()
    return list(items or []) + list(cards or [])


def _proof_matches(surface, value):
    return isinstance(value, dict) and value == PROOFS[surface]


def _face(surface, ordinal, kind, started, completed, occurrences=None):
    if kind in {"complete", "natural_zero"}:
        return {
            "kind": kind,
            "surface": surface,
            "surfaceOrdinal": ordinal,
            "startedAt": started,
            "completedAt": completed,
            "occurrences": occurrences or [],
        }
    return {"surface": surface, "surfaceOrdinal": ordinal, "kind": kind}


def _incomplete(started, clock, kinds=None):
    try:
        completed = _stamp(_now(clock))
    except Exception:
        completed = started
    kinds = kinds or {}
    return {
        "schemaVersion": 1,
        "kind": "incomplete",
        "startedAt": started,
        "completedAt": completed,
        "surfaces": [
            {"surface": surface, "surfaceOrdinal": ordinal, "kind": kinds.get(surface, "unknown")}
            for ordinal, surface in enumerate(SURFACES)
        ],
    }


def _complete_result(started, clock, completed_faces):
    try:
        completed = _stamp(_now(clock))
    except Exception:
        completed = started
    return {
        "schemaVersion": 1,
        "kind": "complete",
        "startedAt": started,
        "completedAt": completed,
        "surfaces": [completed_faces[surface] for surface in SURFACES],
    }


def _prepared_items(snapshot, known, limit):
    if limit <= 0:
        return []
    raw_items = _candidate_items(snapshot)
    prepared = []
    local = set()
    for item in raw_items:
        if len(prepared) >= limit:
            break
        if not isinstance(item, dict):
            raise _BadObservation()
        source = _canonical_source(item.get("sourceUrl"), item.get("authorHandle"))
        if source in known or source in local:
            continue
        local.add(source)
        if len(prepared) < limit:
            prepared = prepared + [(source, item)]
    return prepared


def _surface_observe(surface, ordinal, ws_url, deadline, clock, evaluator, started):
    snapshots = 0
    scrolls = 0
    expands = 0
    occurrences = []
    known = set()

    while snapshots < MAX_SNAPSHOTS:
        try:
            snapshot = _act(clock, deadline, evaluator, ws_url, "snapshot", surface)
        except _Deadline:
            return ("partial" if occurrences else "failed"), occurrences
        except Exception:
            return ("partial" if occurrences else "failed"), occurrences
        snapshots += 1
        if not isinstance(snapshot, dict):
            return ("partial" if occurrences else "failed"), occurrences
        try:
            prepared = _prepared_items(snapshot, known, MAX_OCCURRENCES - len(occurrences))
        except Exception:
            return ("partial" if occurrences else "failed"), occurrences
        expansion_failures = set()
        expansion_successes = set()
        resnapshot_done = False
        for source, item in prepared:
            if not item.get("showMore"):
                continue
            if expands >= MAX_OCCURRENCES:
                expansion_failures.add(source)
                continue
            expands += 1
            try:
                result = _act(clock, deadline, evaluator, ws_url, "expand", surface, source)
            except _Deadline:
                return ("partial" if occurrences else "failed"), occurrences
            except Exception:
                return ("partial" if occurrences else "failed"), occurrences
            if isinstance(result, dict) and result.get("ok"):
                expansion_successes.add(source)
            else:
                expansion_failures.add(source)
        if expansion_successes and snapshots < MAX_SNAPSHOTS:
            try:
                snapshot = _act(clock, deadline, evaluator, ws_url, "snapshot", surface)
            except _Deadline:
                return ("partial" if occurrences else "failed"), occurrences
            except Exception:
                return ("partial" if occurrences else "failed"), occurrences
            snapshots += 1
            resnapshot_done = True
            if not isinstance(snapshot, dict):
                return ("partial" if occurrences else "failed"), occurrences
            try:
                refreshed = _prepared_items(
                    snapshot, known, MAX_OCCURRENCES - len(occurrences)
                )
            except Exception:
                return ("partial" if occurrences else "failed"), occurrences
            refreshed_map = {source: item for source, item in refreshed}
            expansion_failures = expansion_failures | {
                source for source in expansion_successes if source not in refreshed_map
            }
            for source in expansion_successes:
                item = refreshed_map.get(source)
                try:
                    verified = (
                        isinstance(item, dict)
                        and not item.get("showMore")
                        and not item.get("placeholder")
                        and _body_value(item).get("kind") == "sufficient"
                    )
                except Exception:
                    verified = False
                if not verified:
                    expansion_failures.add(source)
            prepared = [(source, refreshed_map.get(source, item)) for source, item in prepared]
            prepared_sources = {source for source, _ in prepared}
            prepared = prepared + [
                (source, item) for source, item in refreshed
                if source not in prepared_sources
            ]
            prepared = prepared[:MAX_OCCURRENCES - len(occurrences)]
        elif expansion_successes:
            expansion_failures = expansion_failures | expansion_successes

        previous_count = len(occurrences)
        for source, item in prepared:
            try:
                captured_at = _live_stamp(clock, deadline)
            except _Deadline:
                return ("partial" if occurrences else "failed"), occurrences
            forced = "show_more_failed" if source in expansion_failures else None
            try:
                checked_source, record = _item_record(item, captured_at, forced)
            except Exception:
                return ("partial" if occurrences else "failed"), occurrences
            if checked_source in known:
                continue
            known.add(checked_source)
            record["occurrenceOrdinal"] = len(occurrences)
            occurrences = occurrences + [record]
            if len(occurrences) >= MAX_OCCURRENCES:
                break

        if resnapshot_done and expansion_successes and expansion_successes <= expansion_failures:
            return ("complete" if occurrences else "unknown"), occurrences

        values = snapshot.get("items")
        cards = snapshot.get("cards")
        has_values = bool(values or cards or snapshot.get("statusCandidates"))
        if len(occurrences) >= MAX_OCCURRENCES:
            break
        if snapshot.get("explicitEmpty") is True and not has_values:
            if not occurrences:
                return "natural_zero", occurrences
            break
        if len(occurrences) == previous_count:
            return ("complete" if occurrences else "unknown"), occurrences
        try:
            _live(clock, deadline)
        except _Deadline:
            return ("partial" if occurrences else "failed"), occurrences
        if snapshots >= MAX_SNAPSHOTS or scrolls >= MAX_SCROLLS:
            break
        try:
            _act(clock, deadline, evaluator, ws_url, "scroll", surface)
        except _Deadline:
            return ("partial" if occurrences else "failed"), occurrences
        except Exception:
            return ("partial" if occurrences else "failed"), occurrences
        scrolls += 1

    if occurrences:
        return "complete", occurrences
    return "unknown", occurrences


def observe(deadline_epoch_ms, *, clock, browser, lock, evaluator):
    """Observe each target while every external action stays within the deadline."""
    try:
        if isinstance(deadline_epoch_ms, bool) or not isinstance(deadline_epoch_ms, (int, float)):
            raise _BadObservation()
        deadline = deadline_epoch_ms
        first_now = _now(clock)
        started = _stamp(first_now)
        if deadline <= first_now:
            return _incomplete(started, clock)
    except Exception:
        started = "1970-01-01T00:00:00.000Z"
        return _incomplete(started, clock)

    kinds = {surface: "unknown" for surface in SURFACES}
    completed_faces = {}
    try:
        with lock.lock(timeout_seconds=_budget(clock, deadline)):
            ready = browser.cdp_ready(_budget(clock, deadline))
            _live(clock, deadline)
            if not ready:
                raise _BadObservation()
            tabs = browser.list_tabs(_budget(clock, deadline))
            _live(clock, deadline)
            if not isinstance(tabs, list):
                raise _BadObservation()
            tab = None
            for candidate in tabs:
                if browser.is_x_tab(candidate) and candidate.get("webSocketDebuggerUrl"):
                    tab = candidate
                    break
            if tab is None:
                raise _BadObservation()
            ws_url = tab.get("webSocketDebuggerUrl")
            if not isinstance(ws_url, str) or not ws_url:
                raise _BadObservation()
            for ordinal, surface in enumerate(SURFACES):
                face_started = _stamp(_now(clock))
                navigation = _act(
                    clock,
                    deadline,
                    evaluator,
                    ws_url,
                    "navigate",
                    surface,
                    before=lambda: kinds.__setitem__(surface, "failed"),
                )
                if not isinstance(navigation, dict):
                    raise _BadObservation()
                page_url = navigation.get("url")
                page_body = navigation.get("body")
                classifier = getattr(browser, "classify_x_page", None)
                if callable(classifier) and classifier(page_url, page_body) != "ready":
                    raise _BadObservation()
                probe = _act(clock, deadline, evaluator, ws_url, "probe", surface)
                if not isinstance(probe, dict) or not _proof_matches(surface, probe.get("surfaceProof")):
                    kinds[surface] = "unknown"
                    raise _BadObservation()
                kind, occurrences = _surface_observe(
                    surface, ordinal, ws_url, deadline, clock, evaluator, face_started
                )
                kinds[surface] = kind
                if kind not in {"complete", "natural_zero"}:
                    raise _BadObservation()
                try:
                    _live(clock, deadline)
                    completed_at = _live_stamp(clock, deadline)
                except _Deadline:
                    kinds[surface] = "partial" if occurrences else "failed"
                    raise
                completed_faces[surface] = _face(
                    surface,
                    ordinal,
                    kind,
                    face_started,
                    completed_at,
                    occurrences,
                )
    except Exception:
        return _incomplete(started, clock, kinds)

    if any(kind not in {"complete", "natural_zero"} for kind in kinds.values()) or len(kinds) != len(SURFACES):
        return _incomplete(started, clock, kinds)
    try:
        _live(clock, deadline)
    except Exception:
        return _incomplete(started, clock, kinds)
    return _complete_result(started, clock, completed_faces)


def run_cli(raw_input: bytes, *, stdout, observer):
    """Decode one bounded request and print exactly one compact response line."""
    invalid = {"schemaVersion": 1, "kind": "invalid_input"}
    try:
        if not isinstance(raw_input, (bytes, bytearray)) or len(raw_input) > 4096:
            raise ValueError()
        value = json.loads(bytes(raw_input).decode("utf-8"))
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "deadlineEpochMs"}
            or value.get("schemaVersion") != 1
            or isinstance(value.get("deadlineEpochMs"), bool)
            or not isinstance(value.get("deadlineEpochMs"), int)
            or value.get("deadlineEpochMs") <= 0
        ):
            raise ValueError()
    except Exception:
        print(json.dumps(invalid, ensure_ascii=False, separators=(",", ":")), file=stdout)
        return 0
    try:
        result = observer(value["deadlineEpochMs"])
        if not isinstance(result, dict):
            raise ValueError()
    except Exception:
        result = {"schemaVersion": 1, "kind": "observer_failed"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), file=stdout)
    return 0
