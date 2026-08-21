#!/usr/bin/env python3
"""browser_start.py — ensure the research Chrome (CDP :9222) is running.

Launches google-chrome-stable with the shared research profile
(~/.config/google-chrome-debug by default; preserves the existing X session)
and remote debugging on 127.0.0.1:9222. Safe to run anytime; no-op if already
up. Pure stdlib.
"""
import json, os, shutil, signal, subprocess, sys, time, urllib.request

PORT = 9222
# Keep one profile for every X entry point.  The old collector/pipeline used
# google-chrome-debug while this helper used openclaw-browser, which made a
# recovery launch look like a fresh, logged-out browser.
PROFILE = os.path.expanduser(
    os.environ.get("HERMES_BROWSER_PROFILE", "~/.config/google-chrome-debug")
)

# Chromium 系浏览器自动探测（本机 + 远端通用）：
# 环境变量 HERMES_BROWSER_BIN 可显式指定；否则依次探测常见命令。
_CHROME_CANDIDATES = [
    "google-chrome-stable", "google-chrome",
    "microsoft-edge-stable", "microsoft-edge",
    "chromium", "chromium-browser",
]

def _find_chrome():
    override = os.environ.get("HERMES_BROWSER_BIN")
    if override:
        return override
    for name in _CHROME_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None

def cdp_up():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False

def cdp_ready():
    """Check both the version endpoint and the target service."""
    if not cdp_up():
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2) as r:
            data = r.read()
        return isinstance(json.loads(data), list)
    except Exception:
        return False

def _debug_browser_pids():
    """Find only browser roots that explicitly own our CDP port."""
    try:
        ps = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True,
                            text=True, check=False)
    except OSError:
        return []
    pids = []
    for line in ps.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or "--remote-debugging-port=%s" % PORT not in fields[1]:
            continue
        if "--type=" in fields[1]:
            continue
        try:
            pids.append(int(fields[0]))
        except ValueError:
            continue
    return pids

def _restart_debug_browser():
    """Stop only the Chrome root bound to :9222 so it can be relaunched."""
    pids = _debug_browser_pids()
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.time() + 10
    while time.time() < deadline and _debug_browser_pids():
        time.sleep(0.25)
    for pid in _debug_browser_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

def main():
    force_restart = "--restart" in sys.argv[1:]
    if force_restart:
        _restart_debug_browser()
    elif cdp_ready():
        print(f"CDP already up on :{PORT}")
        return 0
    elif _debug_browser_pids():
        # The browser root still exists but CDP is down or target enumeration
        # is wedged: this is a browser failure, not a missing-login condition.
        _restart_debug_browser()
    os.makedirs(PROFILE, exist_ok=True)
    chrome = _find_chrome()
    if not chrome:
        print("no chromium-family browser found (tried: %s); "
              "set HERMES_BROWSER_BIN to point at one"
              % ", ".join(_CHROME_CANDIDATES), file=sys.stderr)
        return 1
    # 无可用 X 会话（SSH/远程/容器）时自动降级 headless——CDP 协议不受影响。
    # 显式 HERMES_BROWSER_HEADLESS=0/1 可强制。
    headless = os.environ.get("HERMES_BROWSER_HEADLESS")
    if headless is None:
        headless = "0" if os.environ.get("DISPLAY") else "1"
    # Chrome 136+: --remote-debugging-port is ignored with the DEFAULT profile
    # dir, so we always pass the research profile explicitly.
    cmd = [chrome,
           f"--remote-debugging-port={PORT}",
           f"--user-data-dir={PROFILE}",
           "--no-first-run", "--no-default-browser-check",
           "--restore-last-session=false"]
    if headless in ("1", "true", "yes"):
        cmd.append("--headless=new")
    cmd.append("about:blank")
    devnull = open(os.devnull, "wb")
    subprocess.Popen(cmd, stdout=devnull, stderr=devnull,
                     start_new_session=True, close_fds=True)
    for _ in range(20):
        time.sleep(1)
        if cdp_ready():
            print(f"research Chrome up on :{PORT} (profile: {PROFILE})")
            return 0
    print("Chrome started but CDP not responding", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())
