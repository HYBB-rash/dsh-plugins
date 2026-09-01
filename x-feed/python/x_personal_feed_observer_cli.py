#!/usr/bin/env python3
"""The bounded command-line entry for the X personal-feed observer."""

from __future__ import annotations

import contextlib
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
                raw = response.read(MAX_HTTP_BYTES)
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
    "(() => { const path = location.pathname; "
    "const tabs = [...document.querySelectorAll('[role=tab]')]; "
    "const selected = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'); "
    "return {pathname:path, selectedHomeTabOrdinal: selected < 0 ? null : selected, "
    "explore" + "Root:path === '/explore'}; })()"
)
_SNAPSHOT_EXPRESSION = (
    "(() => { const nodes = [...document.querySelectorAll('[data-testid=cellInnerDiv]')]; "
    "return {statusCandidates:nodes.map(node => ({sourceUrl:'',authorHandle:'',"
    "publishedAt:'',body:'',depth:0,insideQuote:false,showMore:false,placeholder:true})),"
    "explicitEmpty:nodes.length === 0}; })()"
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


def _item_value(item):
    if not isinstance(item, dict):
        return None
    result = {}
    source = _bounded_text(item.get("sourceUrl"), MAX_URL_BYTES)
    author = _bounded_text(item.get("authorHandle"), 64)
    published = _bounded_text(item.get("publishedAt"), 64)
    body = item.get("body")
    too_large = False
    if isinstance(body, str):
        try:
            too_large = len(body.encode("utf-8")) > MAX_BODY_BYTES
        except UnicodeError:
            too_large = True
    else:
        body = ""
    result.update(
        {
            "sourceUrl": source,
            "authorHandle": author,
            "publishedAt": published,
            "body": "" if too_large else body,
            "depth": item.get("depth") if isinstance(item.get("depth"), int) and not isinstance(item.get("depth"), bool) else 0,
            "insideQuote": item.get("insideQuote") is True,
            "showMore": item.get("showMore") is True,
            "placeholder": item.get("placeholder") is True or too_large,
        }
    )
    return result


def _snapshot_value(value):
    if not isinstance(value, dict):
        return {"statusCandidates": [], "explicitEmpty": True}
    if isinstance(value.get("statusCandidates"), list):
        candidates = []
        for item in value["statusCandidates"]:
            normalized = _item_value(item)
            if normalized is not None:
                candidates.append(normalized)
        return {"statusCandidates": candidates, "explicitEmpty": value.get("explicitEmpty") is True}
    result = {}
    for name in ("items", "cards"):
        values = value.get(name)
        if isinstance(values, list):
            result[name] = [normalized for item in values if (normalized := _item_value(item)) is not None]
    result["explicitEmpty"] = value.get("explicitEmpty") is True
    if not result.get("items") and not result.get("cards") and "items" not in result and "cards" not in result:
        result["items"] = []
        result["cards"] = []
    return result


class _MechanicalCdpEvaluator:
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
            "const nodes = [...document.querySelectorAll('[data-testid=cellInnerDiv]')]; "
            "const node = nodes.find(item => item.innerText.includes(target)); "
            "if (!node) return {ok:false}; const button = node.querySelector('button'); "
            "if (button) button.click(); return {ok:true}; })()"
        )
        return "Runtime.evaluate", {"expression": expression, "returnByValue": True}

    def evaluate(self, ws_url, action, *, surface, stable_id=None, timeout_seconds):
        socket = None
        try:
            if not _valid_ws_url(ws_url):
                raise _CdpFailure()
            timeout = _positive_timeout(timeout_seconds)
            method, params = self._command(action, surface, stable_id)
            socket = websocket.create_connection(ws_url, timeout=timeout)
            socket.settimeout(timeout)
            request_id = 1
            socket.send(json.dumps({"id": request_id, "method": method, "params": params}, separators=(",", ":")))
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
            if not isinstance(response, dict) or response.get("id") != request_id:
                raise _CdpFailure()
            value = response.get("result", {}).get("result", {}).get("value")
            if action == "navigate":
                if not isinstance(value, dict):
                    value = {}
                return {
                    "url": _bounded_text(value.get("url") or SURFACE_TARGETS[surface], MAX_URL_BYTES),
                    "body": _bounded_text(value.get("body"), MAX_BODY_BYTES),
                }
            if action == "probe":
                proof = value.get("surfaceProof") if isinstance(value, dict) else None
                return {"surfaceProof": proof if isinstance(proof, dict) else {}}
            if action == "snapshot":
                return _snapshot_value(value)
            return {"ok": bool(value.get("ok"))} if isinstance(value, dict) else {"ok": False}
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
