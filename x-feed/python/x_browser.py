#!/usr/bin/env python3
"""Shared browser/CDP recovery for the X collectors.

The important distinction here is:

* ``browser_unavailable``: Chrome/CDP is down or unusable;
* ``tab_unavailable``: Chrome is healthy but creating a page failed;
* ``not_logged_in``: an X page exists and explicitly shows the login flow.

Missing an X tab is never treated as a login failure.  Callers can use
``ensure_x_tab`` before navigating and can retry with ``restart=True`` after
a stale target/WebSocket error.
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request


PORT = 9222
HOST = "127.0.0.1"
X_HOME_URL = "https://x.com/home"
HERE = os.path.dirname(os.path.abspath(__file__))
BROWSER_START = os.path.join(HERE, "browser_start.py")


class BrowserRecoveryError(RuntimeError):
    """A recoverable browser integration failure with a stable error code."""

    def __init__(self, code, detail=""):
        self.code = code
        self.detail = detail
        message = code if not detail else f"{code}: {detail}"
        super().__init__(message)


def _request_json(path, method=None):
    request = urllib.request.Request(f"http://{HOST}:{PORT}{path}", method=method)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    except Exception as exc:
        raise BrowserRecoveryError("browser_unavailable", str(exc)) from exc


def cdp_up():
    """Return whether the CDP version endpoint responds."""
    try:
        _request_json("/json/version")
        return True
    except BrowserRecoveryError:
        return False


def cdp_ready():
    """Return whether CDP responds with a usable target list.

    Checking only ``/json/version`` is insufficient: Chrome can leave the
    debugging port open while its target service is wedged.
    """
    try:
        version = _request_json("/json/version")
        tabs = _request_json("/json/list")
        return bool(isinstance(version, dict) and isinstance(tabs, list))
    except BrowserRecoveryError:
        return False


def run_browser_start(restart=False):
    """Start/recover the canonical research Chrome profile."""
    cmd = [sys.executable, BROWSER_START]
    if restart:
        cmd.append("--restart")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired):
        return 1
    return result.returncode


def ensure_cdp():
    """Ensure a responsive CDP endpoint, starting Chrome when needed."""
    if cdp_ready():
        return {"ok": True, "recovered": False}
    # browser_start.py distinguishes a dead port from a wedged target service
    # and only restarts the process bound to this debugging port.
    if run_browser_start(restart=False) == 0 and cdp_ready():
        return {"ok": True, "recovered": True}
    raise BrowserRecoveryError("browser_unavailable", "CDP did not become ready")


def list_tabs():
    """Return the current raw CDP target list."""
    tabs = _request_json("/json/list")
    if not isinstance(tabs, list):
        raise BrowserRecoveryError("browser_unavailable", "invalid CDP target list")
    return tabs


def is_x_tab(tab):
    """Whether a CDP page target is currently on x.com/twitter.com."""
    if not isinstance(tab, dict) or tab.get("type") != "page":
        return False
    try:
        host = (urllib.parse.urlsplit(tab.get("url", "")).hostname or "").lower()
    except ValueError:
        return False
    return host in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}


def new_tab(url=X_HOME_URL):
    """Create a new page through the DevTools HTTP API."""
    encoded = urllib.parse.quote(url, safe="")
    try:
        tab = _request_json(f"/json/new?{encoded}", method="PUT")
    except BrowserRecoveryError as exc:
        if exc.code == "browser_unavailable":
            raise BrowserRecoveryError("tab_unavailable", exc.detail) from exc
        raise
    if not isinstance(tab, dict):
        raise BrowserRecoveryError("tab_unavailable", "invalid /json/new response")
    return tab


def ensure_x_tab():
    """Ensure an X page target exists, creating one when Chrome has none."""
    ensure_cdp()
    tabs = list_tabs()
    for tab in tabs:
        if is_x_tab(tab) and tab.get("webSocketDebuggerUrl"):
            return tab

    # A healthy browser without an X tab is a normal recoverable state.  It
    # must not be reported as a login failure.
    created = new_tab(X_HOME_URL)
    if is_x_tab(created) and created.get("webSocketDebuggerUrl"):
        return created
    # Chrome may return the target before its URL is updated; resolve it once.
    for tab in list_tabs():
        if is_x_tab(tab) and tab.get("webSocketDebuggerUrl"):
            return tab
    raise BrowserRecoveryError("tab_unavailable", "X target was not created")


def classify_x_page(url, body):
    """Classify an already-observed X page without conflating missing tabs."""
    lowered_url = str(url or "").lower()
    lowered_body = str(body or "").lower()
    if "/i/flow/login" in lowered_url or "/login" in lowered_url:
        return "not_logged_in"
    login_markers = (
        "sign in to x", "log in to x", "create your account", "登录 x", "注册 x"
    )
    if any(marker in lowered_body for marker in login_markers):
        return "not_logged_in"
    error_markers = (
        "something went wrong", "try reloading", "this page is not available"
    )
    if any(marker in lowered_body for marker in error_markers):
        return "page_error"
    return "ready"
