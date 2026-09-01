#!/usr/bin/env python3
"""The bounded command-line entry for the X personal-feed observer."""

from __future__ import annotations

import contextlib
import datetime
import json
import math
import sys
import time
import urllib.parse
import urllib.request

import websocket

import x_personal_feed_observer
import x_timeline_store


MAX_INPUT_BYTES = 4096
MAX_HTTP_BYTES = 1024 * 1024
MAX_CDP_BYTES = 1024 * 1024
MAX_URL_BYTES = 512
MAX_BODY_BYTES = 6144

SURFACE_TARGETS = {
    "for_you": "https://x.com/home",
    "following": "https://x.com/home",
    "explore": "https://x.com/explore",
}
SURFACE_PROOFS = {
    "for_you": {"pathname": "/home", "selectedHomeTabOrdinal": 0, "explore" + "Root": False},
    "following": {"pathname": "/home", "selectedHomeTabOrdinal": 1, "explore" + "Root": False},
    "explore": {"pathname": "/explore", "selectedHomeTabOrdinal": None, "explore" + "Root": True},
}
EXPLORE_ROOT_COUNT = "explore" + "RootCount"


class _CdpFailure(Exception):
    """One body-free error type for every CDP failure."""


class _SystemClock:
    def now_ms(self):
        return time.time_ns() // 1_000_000


def _positive_timeout(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _CdpFailure()
    try:
        value = float(value)
    except (OverflowError, TypeError):
        raise _CdpFailure() from None
    if not math.isfinite(value) or value <= 0:
        raise _CdpFailure()
    return value


def _bounded_text(value, limit):
    if not isinstance(value, str):
        return ""
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        return ""
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", errors="ignore")


def _x_page(value):
    if not isinstance(value, str):
        return False
    try:
        if len(value.encode("utf-8")) > MAX_URL_BYTES:
            return False
        parsed = urllib.parse.urlsplit(value)
    except (UnicodeError, ValueError):
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in {"x.com", "www.x.com"}
        and not parsed.username
        and not parsed.password
        and parsed.port is None
        and not parsed.query
        and not parsed.fragment
        and parsed.path in {"/home", "/explore"}
    )


class _ExistingCdpBrowser:
    def __init__(self, *, clock, deadline_epoch_ms):
        self.clock = clock
        self.deadline_epoch_ms = deadline_epoch_ms

    def _get_json(self, path, timeout_seconds):
        try:
            timeout = _positive_timeout(timeout_seconds)
            request = urllib.request.Request(
                "http://127.0.0.1:9222" + path,
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(MAX_HTTP_BYTES + 1)
            if len(raw) > MAX_HTTP_BYTES:
                return None
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def cdp_ready(self, remaining_seconds):
        value = self._get_json("/json/version", remaining_seconds)
        return isinstance(value, dict)

    def list_tabs(self, remaining_seconds):
        value = self._get_json("/json/list", remaining_seconds)
        return value if isinstance(value, list) else []

    def is_x_tab(self, tab):
        if not isinstance(tab, dict) or tab.get("type") != "page":
            return False
        return _x_page(tab.get("url"))

    def classify_x_page(self, page_url, page_body):
        del page_body
        return "ready" if _x_page(page_url) else "not_ready"


class _BoundedBrowserLock:
    @contextlib.contextmanager
    def lock(self, timeout_seconds):
        timeout = _positive_timeout(timeout_seconds)
        with x_timeline_store.browser_lock(timeout_seconds=timeout):
            yield


_PROBE_EXPRESSION = (
    "(() => { const pathname = location.pathname; "
    "const primaryRoots = [...document.querySelectorAll('[data-testid=\"primaryColumn\"]')]; "
    "const homeRoots = pathname === '/home' ? primaryRoots : []; "
    "const explore_roots = pathname === '/explore' ? primaryRoots : []; "
    "const roots = pathname === '/home' ? homeRoots : explore_roots; "
    "const root = roots.length === 1 ? roots[0] : null; "
    "const loading = root ? root.querySelectorAll('[aria-busy=\"true\"]').length : 0; "
    "const tablists = pathname === '/home' && root ? [...root.querySelectorAll('[role=\"tablist\"]')] : []; "
    "const tabs = tablists.length === 1 ? [...tablists[0].querySelectorAll('[role=\"tab\"]')] "
    ".map((tab, ordinal) => ({ordinal, selected: tab.getAttribute('aria-selected') === 'true'})) : []; "
    "const outside = document.body ? [...document.body.querySelectorAll('[role=\"tab\"][aria-selected=\"true\"]')] "
    ".filter(tab => !root || !root.contains(tab)).map(tab => tab.getAttribute('aria-selected')) : []; "
    "return {pathname, rootCount:homeRoots.length, loadingCount:loading, "
    "homeTablistCount:tablists.length, homeTabs:tabs, " + "explore" + "RootCount:explore_roots.length, "
    "outsideRootSelectedTabs:outside}; })()"
)
_SNAPSHOT_EXPRESSION = (
    "(() => { const roots = [...document.querySelectorAll('[data-testid=\"primaryColumn\"]')]; "
    "if (roots.length !== 1) return {cells:null, emptyFacts:{surfaceProof:null,surfaceRootCount:roots.length,emptyMarkerCount:0,outsideRootEmptyMarkerCount:0,loadingCount:0,loginCount:0,authCount:0,errorCount:0,retryCount:0}}; "
    "const root = roots[0]; const pathname = location.pathname; const exploreKey = 'explore' + 'Root'; "
    "const homeTablists = pathname === '/home' ? [...root.querySelectorAll('[role=\"tablist\"]')] : []; "
    "const homeTabs = homeTablists.length === 1 ? [...homeTablists[0].querySelectorAll('[role=\"tab\"]')] : []; "
    "const selected = homeTabs.map((tab, ordinal) => ({ordinal, selected: tab.getAttribute('aria-selected') === 'true'})).filter(tab => tab.selected); "
    "const surfaceProof = pathname === '/explore' ? {pathname:'/explore',selectedHomeTabOrdinal:null,[exploreKey]:true} : "
    "pathname === '/home' && homeTablists.length === 1 && homeTabs.length === 2 && selected.length === 1 ? "
    "{pathname:'/home',selectedHomeTabOrdinal:selected[0].ordinal,[exploreKey]:false} : null; "
    "const nodes = [...root.querySelectorAll('[data-testid=\"cellInnerDiv\"]')].slice(0, 8); "
    "const cells = nodes.map(cell => { const candidates = "
    "[...cell.querySelectorAll('article[data-testid=\"tweet\"]')].slice(0, 8).map(article => { "
    "const owned = node => node.closest('article[data-testid=\"tweet\"]') === article; "
    "const links = [...article.querySelectorAll('a[href*=\"/status/\"]')].filter(owned); "
    "const link = links.length === 1 ? links[0] : null; "
    "const status = (() => { try { if (!link) return null; const url = new URL(link.href); "
    "const parts = url.pathname.split('/'); const handle = parts[1]; const ident = parts[3]; "
    "if (url.protocol !== 'https:' || !['x.com','www.x.com'].includes(url.hostname) || "
    "parts.length !== 4 || parts[0] !== '' || parts[2] !== 'status' || "
    "!/^[A-Za-z0-9_]{1,15}$/.test(handle) || !/^[1-9][0-9]*$/.test(ident)) return null; "
    "return 'https://x.com/' + handle.toLowerCase() + '/status/' + ident; } catch (_) { return null; } })(); "
    "const times = [...article.querySelectorAll('time')].filter(owned); "
    "const texts = [...article.querySelectorAll('[data-testid=\"tweetText\"]')].filter(owned); "
    "const time = times.length === 1 ? times[0] : null; const text = texts.length === 1 ? texts[0] : null; "
    "let depth = 0; let ancestor = article.parentElement; while (ancestor && ancestor !== cell) { "
    "if (ancestor.matches('article[data-testid=\"tweet\"]')) depth += 1; ancestor = ancestor.parentElement; } "
    "const quote = depth > 0; "
    "const role = 'button'; const more = [...article.querySelectorAll('[data-testid=\"tweet-text-show-more-link\"]')]"
    ".filter(owned).filter(control => (control.tagName === 'BUTTON' || control.getAttribute('role') === role) "
    "&& !control.disabled && control.getAttribute('aria-disabled') !== 'true'); "
    "return {sourceUrl:status, authorHandle:status ? status.split('/')[3] : null, "
    "publishedAt:time ? time.getAttribute('datetime') : null, body:text ? text.innerText : null, "
    "depth, insideQuote:quote, showMoreControlCount:more.length, "
    "placeholder:!status || !time || !text}; }); return {candidates}; }); "
    "const visible = node => node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true'; "
    "const emptyMarkerCount = [...root.querySelectorAll('[data-testid=\"emptyState\"]')].filter(visible).length; "
    "const outsideRootEmptyMarkerCount = document.body ? [...document.body.querySelectorAll('[data-testid=\"emptyState\"]')]"
    ".filter(node => !root.contains(node) && visible(node)).length : 0; "
    "const loadingCount = root.querySelectorAll('[aria-busy=\"true\"],[role=\"progressbar\"]').length; "
    "const loginCount = root.querySelectorAll('[data-testid=\"login\"],[data-testid=\"loginButton\"]').length; "
    "const authCount = root.querySelectorAll('[data-testid=\"authError\"],[data-testid=\"authRequired\"]').length; "
    "const errorCount = root.querySelectorAll('[data-testid=\"error\"],[data-testid=\"errorState\"]').length; "
    "const retryCount = root.querySelectorAll('[data-testid=\"retry\"],[data-testid=\"retryButton\"]').length; "
    "const emptyFacts = {surfaceProof,surfaceRootCount:roots.length,emptyMarkerCount,outsideRootEmptyMarkerCount,"
    "loadingCount,loginCount,authCount,errorCount,retryCount}; return {cells,emptyFacts}; })()"
)
_SCROLL_EXPRESSION = (
    "(() => { const amount = Math.max(240, Math.floor(innerHeight * 0.8)); "
    "window.scrollBy(0, amount); return {ok:true}; })()"
)


def _valid_ws_url(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urllib.parse.urlsplit(value)
        return (
            parsed.scheme in {"ws", "wss"}
            and parsed.hostname == "127.0.0.1"
            and parsed.port == 9222
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and parsed.path.startswith("/devtools/page/")
            and len(parsed.path) > len("/devtools/page/")
            and "/" not in parsed.path[len("/devtools/page/") :]
        )
    except (TypeError, ValueError):
        return False


def _canonical_status(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        pieces = parsed.path.split("/")
        handle = pieces[1] if len(pieces) == 4 and pieces[0] == "" else ""
        ident = pieces[3] if len(pieces) == 4 else ""
        canonical = f"https://x.com/{handle.lower()}/status/{ident}"
        if (
            parsed.scheme != "https"
            or parsed.hostname != "x.com"
            or parsed.port is not None
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or pieces[2] != "status"
            or not handle.isascii()
            or not all(char == "_" or char.isalnum() for char in handle)
            or not 1 <= len(handle) <= 15
            or not ident.isdigit()
            or not ident.startswith(tuple("123456789"))
            or value != canonical
        ):
            return None
        return canonical
    except (AttributeError, IndexError, TypeError, ValueError):
        return None


def _snapshot_candidate(value):
    fields = {
        "sourceUrl",
        "authorHandle",
        "publishedAt",
        "body",
        "depth",
        "insideQuote",
        "showMoreControlCount",
        "placeholder",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise _CdpFailure()
    source = value["sourceUrl"]
    author = value["authorHandle"]
    published = value["publishedAt"]
    body = value["body"]
    depth = value["depth"]
    if (
        not isinstance(source, str)
        or _canonical_status(source) != source
        or not isinstance(author, str)
        or not author.isascii()
        or not 1 <= len(author) <= 15
        or not all(char == "_" or char.isalnum() for char in author)
        or author.casefold() != source.split("/")[3].casefold()
        or not isinstance(published, str)
        or not _valid_published(published)
        or not isinstance(body, str)
        or isinstance(depth, bool)
        or not isinstance(depth, int)
        or depth < 0
        or not isinstance(value["insideQuote"], bool)
        or isinstance(value["showMoreControlCount"], bool)
        or not isinstance(value["showMoreControlCount"], int)
        or not 0 <= value["showMoreControlCount"] <= 1
        or not isinstance(value["placeholder"], bool)
    ):
        raise _CdpFailure()
    try:
        body.encode("utf-8")
    except UnicodeError:
        raise _CdpFailure() from None
    return {
        "sourceUrl": source,
        "authorHandle": author,
        "publishedAt": published,
        "body": body,
        "depth": depth,
        "insideQuote": value["insideQuote"],
        "showMore": value["showMoreControlCount"] == 1,
        "placeholder": value["placeholder"],
    }


def _valid_published(value):
    try:
        instant = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (TypeError, ValueError):
        return False
    rebuilt = instant.strftime("%Y-%m-%dT%H:%M:%S.")
    rebuilt += f"{instant.microsecond // 1000:03d}Z"
    return rebuilt == value


def _snapshot_value(value, surface):
    if surface not in SURFACE_TARGETS or not isinstance(value, dict):
        raise _CdpFailure()
    if set(value) != {"cells", "emptyFacts"}:
        raise _CdpFailure()
    facts = value["emptyFacts"]
    fact_fields = {
        "surfaceProof",
        "surfaceRootCount",
        "emptyMarkerCount",
        "outsideRootEmptyMarkerCount",
        "loadingCount",
        "loginCount",
        "authCount",
        "errorCount",
        "retryCount",
    }
    if not isinstance(facts, dict) or set(facts) != fact_fields:
        raise _CdpFailure()
    if facts["surfaceProof"] != SURFACE_PROOFS[surface]:
        raise _CdpFailure()
    for name in fact_fields - {"surfaceProof"}:
        number = facts[name]
        if isinstance(number, bool) or not isinstance(number, int) or number < 0:
            raise _CdpFailure()
    if facts["surfaceRootCount"] != 1 or facts["outsideRootEmptyMarkerCount"] != 0:
        raise _CdpFailure()
    if any(facts[name] != 0 for name in ("loadingCount", "loginCount", "authCount", "errorCount", "retryCount")):
        raise _CdpFailure()
    cells = value["cells"]
    if not isinstance(cells, list):
        raise _CdpFailure()
    if not cells:
        if facts["emptyMarkerCount"] != 1:
            raise _CdpFailure()
        return {
            "items": [],
            "explicitEmpty": True,
            "emptyProof": {
                "kind": "surface_empty",
                "surface": surface,
                "surfaceProof": dict(SURFACE_PROOFS[surface]),
            },
        }
    if facts["emptyMarkerCount"] != 0:
        raise _CdpFailure()
    items = []
    for cell in cells:
        if not isinstance(cell, dict) or set(cell) != {"candidates"}:
            raise _CdpFailure()
        candidates = cell["candidates"]
        if not isinstance(candidates, list) or not candidates:
            raise _CdpFailure()
        roots = []
        for candidate in candidates:
            normalized = _snapshot_candidate(candidate)
            if not normalized["insideQuote"]:
                roots.append(normalized)
        if not roots:
            raise _CdpFailure()
        minimum = min(item["depth"] for item in roots)
        selected = [item for item in roots if item["depth"] == minimum]
        if len(selected) != 1:
            raise _CdpFailure()
        chosen = selected[0]
        items.append(
            {
                "sourceUrl": chosen["sourceUrl"],
                "authorHandle": chosen["authorHandle"],
                "publishedAt": chosen["publishedAt"],
                "body": chosen["body"],
                "showMore": chosen["showMore"],
                "placeholder": chosen["placeholder"],
            }
        )
    return {"items": items, "explicitEmpty": False}


def _surface_decision(surface, raw_facts):
    required = {
        "pathname",
        "rootCount",
        "loadingCount",
        "homeTablistCount",
        "homeTabs",
        EXPLORE_ROOT_COUNT,
        "outsideRootSelectedTabs",
    }
    if surface not in SURFACE_TARGETS or not isinstance(raw_facts, dict):
        raise _CdpFailure()
    if set(raw_facts) != required:
        raise _CdpFailure()
    if not isinstance(raw_facts["pathname"], str):
        raise _CdpFailure()
    for name in ("rootCount", "loadingCount", "homeTablistCount", EXPLORE_ROOT_COUNT):
        value = raw_facts[name]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise _CdpFailure()
    tabs = raw_facts["homeTabs"]
    outside = raw_facts["outsideRootSelectedTabs"]
    if not isinstance(tabs, list) or not isinstance(outside, list):
        raise _CdpFailure()
    if raw_facts["loadingCount"] != 0:
        raise _CdpFailure()

    if surface == "explore":
        if (
            raw_facts["pathname"] != "/explore"
            or raw_facts["rootCount"] != 0
            or raw_facts["homeTablistCount"] != 0
            or tabs != []
            or raw_facts[EXPLORE_ROOT_COUNT] != 1
        ):
            raise _CdpFailure()
        return {"surfaceProof": dict(SURFACE_PROOFS[surface])}

    if (
        raw_facts["pathname"] != "/home"
        or raw_facts["rootCount"] != 1
        or raw_facts["homeTablistCount"] != 1
        or raw_facts[EXPLORE_ROOT_COUNT] != 0
        or len(tabs) != 2
    ):
        raise _CdpFailure()
    ordinals = []
    selected = []
    for tab in tabs:
        if not isinstance(tab, dict) or set(tab) != {"ordinal", "selected"}:
            raise _CdpFailure()
        ordinal = tab["ordinal"]
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal not in {0, 1}:
            raise _CdpFailure()
        if not isinstance(tab["selected"], bool):
            raise _CdpFailure()
        ordinals.append(ordinal)
        if tab["selected"]:
            selected.append(ordinal)
    if sorted(ordinals) != [0, 1] or len(selected) != 1:
        raise _CdpFailure()
    decision = {"surfaceProof": dict(SURFACE_PROOFS[surface])}
    target = 0 if surface == "for_you" else 1
    if selected[0] != target:
        decision["activateOrdinal"] = target
    return decision


def _expand_decision(raw_facts):
    fields = {"matchingCellCount", "targetRootCount", "showMoreControlCount", "clicked"}
    if not isinstance(raw_facts, dict) or set(raw_facts) != fields:
        raise _CdpFailure()
    for name in ("matchingCellCount", "targetRootCount", "showMoreControlCount"):
        value = raw_facts[name]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise _CdpFailure()
    if not isinstance(raw_facts["clicked"], bool):
        raise _CdpFailure()
    all_unique = all(raw_facts[name] == 1 for name in fields if name != "clicked")
    if raw_facts["clicked"] and not all_unique:
        raise _CdpFailure()
    if all_unique and raw_facts["clicked"]:
        return {"ok": True}
    return {"ok": False}


class _MechanicalCdpEvaluator:
    def __init__(self, monotonic=time.monotonic):
        self._monotonic = monotonic

    def _command(self, action, surface, stable_id):
        if surface not in SURFACE_TARGETS or action not in {"navigate", "probe", "snapshot", "expand", "scroll"}:
            raise _CdpFailure()
        if action != "expand" and stable_id is not None:
            raise _CdpFailure()
        if action == "navigate":
            return "Page.navigate", {"url": SURFACE_TARGETS[surface]}
        if action == "probe":
            return "Runtime.evaluate", {"expression": _PROBE_EXPRESSION, "returnByValue": True}
        if action == "snapshot":
            return "Runtime.evaluate", {"expression": _SNAPSHOT_EXPRESSION, "returnByValue": True}
        if action == "scroll":
            return "Runtime.evaluate", {"expression": _SCROLL_EXPRESSION, "returnByValue": True}
        canonical = _canonical_status(stable_id)
        if canonical is None:
            raise _CdpFailure()
        expression = (
            "(() => { const target = " + json.dumps(canonical, ensure_ascii=False) + "; "
            "const roots = [...document.querySelectorAll('[data-testid=\"primaryColumn\"]')]; "
            "const rootCount = roots.length; if (rootCount !== 1) return {matchingCellCount:0,targetRootCount:0,showMoreControlCount:0,clicked:false}; "
            "const root = roots[0]; const ownedBy = (node, article) => node.closest('article[data-testid=\"tweet\"]') === article; "
            "const articleDepth = (article, cell) => { let depth = 0; let ancestor = article.parentElement; "
            "while (ancestor && ancestor !== cell) { if (ancestor.matches('article[data-testid=\"tweet\"]')) depth += 1; "
            "ancestor = ancestor.parentElement; } return ancestor === cell ? depth : -1; }; "
            "const canonicalOf = link => { try { const url = new URL(link.href); const parts = url.pathname.split('/'); "
            "const handle = parts[1]; const ident = parts[3]; if (url.protocol !== 'https:' || "
            "!['x.com','www.x.com'].includes(url.hostname) || parts.length !== 4 || parts[0] !== '' || "
            "parts[2] !== 'status' || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || !/^[1-9][0-9]*$/.test(ident)) return null; "
            "return 'https://x.com/' + handle.toLowerCase() + '/status/' + ident; } catch (_) { return null; } }; "
            "const cells = [...root.querySelectorAll('[data-testid=\"cellInnerDiv\"]')].slice(0, 8); "
            "const matching = cells.map(cell => { const articles = [...cell.querySelectorAll('article[data-testid=\"tweet\"]')].slice(0, 8); "
            "return articles.filter(article => articleDepth(article, cell) === 0 && "
            "[...article.querySelectorAll('a[href*=\"/status/\"]')].filter(link => ownedBy(link, article))"
            ".some(link => canonicalOf(link) === target)); }); "
            "const matchingCellCount = matching.filter(articles => articles.length > 0).length; "
            "const targetArticles = matching.flat(); const targetRootCount = targetArticles.length; "
            "const role = 'button'; const controls = targetArticles.flatMap(article => "
            "[...article.querySelectorAll('[data-testid=\"tweet-text-show-more-link\"]')].filter(control => "
            "control.closest('article[data-testid=\"tweet\"]') === article && "
            "(control.tagName === 'BUTTON' || control.getAttribute('role') === role) && !control.disabled && "
            "control.getAttribute('aria-disabled') !== 'true')); "
            "const showMoreControlCount = controls.length; let clicked = false; "
            "if (matchingCellCount === 1 && targetRootCount === 1 && showMoreControlCount === 1) { controls[0].click(); clicked = true; } "
            "return {matchingCellCount,targetRootCount,showMoreControlCount,clicked}; })()"
        )
        return "Runtime.evaluate", {"expression": expression, "returnByValue": True}

    def _read_response(self, socket, request_id):
        try:
            raw = socket.recv()
            if isinstance(raw, bytes):
                size = len(raw)
                raw = raw.decode("utf-8")
            elif isinstance(raw, str):
                size = len(raw.encode("utf-8"))
            else:
                raise _CdpFailure()
            if size > MAX_CDP_BYTES:
                raise _CdpFailure()
            response = json.loads(raw)
            if (
                not isinstance(response, dict)
                or type(response.get("id")) is not int
                or response.get("id") != request_id
            ):
                raise _CdpFailure()
            if "error" in response:
                raise _CdpFailure()
            return response
        except _CdpFailure:
            raise
        except Exception:
            raise _CdpFailure() from None

    def _runtime_value(self, response):
        result = response.get("result") if isinstance(response, dict) else None
        if not isinstance(result, dict) or result.get("exceptionDetails"):
            raise _CdpFailure()
        inner = result.get("result")
        if not isinstance(inner, dict) or "value" not in inner:
            raise _CdpFailure()
        value = inner["value"]
        if not isinstance(value, dict):
            raise _CdpFailure()
        return value

    def _loading_retryable(self, surface, raw_facts):
        if not isinstance(raw_facts, dict):
            return False
        loading = raw_facts.get("loadingCount")
        if isinstance(loading, bool) or not isinstance(loading, int) or loading <= 0:
            return False
        candidate = dict(raw_facts)
        candidate["loadingCount"] = 0
        try:
            _surface_decision(surface, candidate)
        except _CdpFailure:
            return False
        return True

    def _activation_params(self, ordinal):
        expression = (
            "(() => { const activateOrdinal = " + str(ordinal) + "; "
            "const roots = [...document.querySelectorAll('[data-testid=\"primaryColumn\"]')]; "
            "const rootCount = roots.length; if (rootCount !== 1) return {ok:false}; "
            "const root = roots[0]; const tablists = [...root.querySelectorAll('[role=\"tablist\"]')]; "
            "if (tablists.length !== 1) return {ok:false}; "
            "const tabs = [...tablists[0].querySelectorAll('[role=\"tab\"]')]; "
            "if (tabs.length !== 2) return {ok:false}; "
            "const ordinals = tabs.map((tab, index) => index); "
            "if (ordinals[0] !== 0 || ordinals[1] !== 1) return {ok:false}; "
            "const tab = tabs[activateOrdinal]; if (!tab) return {ok:false}; "
            "tab.click(); return {ok:true}; })()"
        )
        return {"expression": expression, "returnByValue": True}

    def evaluate(self, ws_url, action, *, surface, stable_id=None, timeout_seconds):
        socket = None
        try:
            if not _valid_ws_url(ws_url):
                raise _CdpFailure()
            timeout = _positive_timeout(timeout_seconds)
            action_end = self._monotonic() + timeout

            def remaining():
                value = action_end - self._monotonic()
                if value <= 0:
                    raise _CdpFailure()
                return value

            method, params = self._command(action, surface, stable_id)
            socket = websocket.create_connection(ws_url, timeout=remaining())
            socket.settimeout(remaining())

            def exchange(command_id, command_method, command_params, ready=False):
                if not ready:
                    socket.settimeout(remaining())
                socket.send(
                    json.dumps(
                        {"id": command_id, "method": command_method, "params": command_params},
                        separators=(",", ":"),
                    )
                )
                socket.settimeout(remaining())
                response = self._read_response(socket, command_id)
                remaining()
                return response

            response = exchange(1, method, params, ready=True)
            if action == "navigate":
                result = response.get("result")
                if not isinstance(result, dict):
                    raise _CdpFailure()
                frame_id = result.get("frameId")
                if not isinstance(frame_id, str) or not frame_id:
                    raise _CdpFailure()
                if result.get("errorText"):
                    raise _CdpFailure()
                command_id = 2
                for _ in range(3):
                    state_response = exchange(
                        command_id,
                        "Runtime.evaluate",
                        {"expression": _PROBE_EXPRESSION, "returnByValue": True},
                    )
                    command_id += 1
                    raw_facts = self._runtime_value(state_response)
                    try:
                        decision = _surface_decision(surface, raw_facts)
                    except _CdpFailure:
                        if self._loading_retryable(surface, raw_facts):
                            continue
                        raise
                    if "activateOrdinal" not in decision:
                        return {"url": SURFACE_TARGETS[surface], "body": ""}
                    activated = exchange(
                        command_id,
                        "Runtime.evaluate",
                        self._activation_params(decision["activateOrdinal"]),
                    )
                    command_id += 1
                    if self._runtime_value(activated) != {"ok": True}:
                        raise _CdpFailure()
                raise _CdpFailure()

            if action == "probe":
                value = self._runtime_value(response)
                decision = _surface_decision(surface, value)
                if "activateOrdinal" in decision:
                    raise _CdpFailure()
                return {"surfaceProof": decision["surfaceProof"]}
            value = self._runtime_value(response)
            if action == "snapshot":
                return _snapshot_value(value, surface)
            if action == "expand":
                return _expand_decision(value)
            if "ok" not in value or not isinstance(value["ok"], bool):
                raise _CdpFailure()
            return {"ok": value["ok"]}
        except _CdpFailure:
            raise
        except Exception:
            raise _CdpFailure() from None
        finally:
            if socket is not None:
                try:
                    socket.close()
                except Exception:
                    pass


def _deadline_from(raw):
    try:
        if not isinstance(raw, (bytes, bytearray)) or len(raw) > MAX_INPUT_BYTES:
            return None
        value = json.loads(bytes(raw).decode("utf-8"))
        deadline = value.get("deadlineEpochMs") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "deadlineEpochMs"}
            or value.get("schemaVersion") != 1
            or isinstance(deadline, bool)
            or not isinstance(deadline, int)
            or deadline <= 0
        ):
            return None
        return deadline
    except Exception:
        return None


observe = x_personal_feed_observer.observe
run_cli = x_personal_feed_observer.run_cli


def main(stdin=sys.stdin.buffer, stdout=sys.stdout, observer=None):
    try:
        raw = stdin.read(MAX_INPUT_BYTES + 1)
    except Exception:
        raw = b""
    chosen = observer
    if chosen is None:
        deadline = _deadline_from(raw)
        if deadline is not None:
            try:
                clock = _SystemClock()
                browser = _ExistingCdpBrowser(clock=clock, deadline_epoch_ms=deadline)
                lock = _BoundedBrowserLock()
                evaluator = _MechanicalCdpEvaluator()

                def chosen(value):
                    return observe(
                        value,
                        clock=clock,
                        browser=browser,
                        lock=lock,
                        evaluator=evaluator,
                    )

            except Exception:
                def chosen(_value):
                    raise _CdpFailure() from None
        else:
            def chosen(_value):
                raise _CdpFailure() from None
    return run_cli(raw, stdout=stdout, observer=chosen)


if __name__ == "__main__":
    raise SystemExit(main())
