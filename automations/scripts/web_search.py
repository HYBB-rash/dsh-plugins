#!/usr/bin/env python3
"""web_search — 本机搜索引擎工具（绕开浏览器栈封锁）

三级降级链: Google(需人工解锁) → DuckDuckGo(真实Firefox) → Bing(curl)
用法:
  python3 web_search.py "查询词" [--engine google|ddg|bing] [--count N]
  python3 web_search.py --unlock-check        # 检查 Google 是否已解锁

输出: JSON 数组 [{title, url, snippet}]
"""

import sys
import os
import re
import json
import time
import html as htmllib
import subprocess
import urllib.parse

HOME = os.path.expanduser("~")
PYTHON = os.path.join(HOME, ".openclaw/workspace/scripts/search_env/bin/python")
GECKO = "/snap/bin/geckodriver"
FF_BIN = "/snap/firefox/current/usr/lib/firefox/firefox"
# Google cookie 复用的 profile: 优先用户解锁过的 snap firefox 默认 profile,
# 回退到本工具自建 profile
USER_FF_PROFILE = os.path.join(HOME, "snap/firefox/common/.mozilla/firefox/4ql60qce.default")
PROFILE = USER_FF_PROFILE if os.path.isdir(USER_FF_PROFILE) else os.path.join(HOME, ".openclaw/workspace/scripts/search_profile")
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
LOCK_FLAG = os.path.join(HOME, ".openclaw/workspace/scripts/search_profile/google_locked")


# ── 浏览器搜索(selenium + xvfb + firefox) ─────────────────────
_SELENIUM_SCRIPT = r'''
import sys, time, json, re, os
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

opts = Options()
opts.binary_location = sys.argv[1]
opts.add_argument("--headless")
opts.set_preference("general.useragent.override", sys.argv[2])
opts.set_preference("dom.webdriver.enabled", False)
opts.set_preference("useAutomationExtension", False)
if sys.argv[3] and os.path.isdir(sys.argv[3]):
    opts.profile = sys.argv[3]

svc = Service(sys.argv[4], log_output="/dev/null")
drv = webdriver.Firefox(options=opts, service=svc)
try:
    drv.get(sys.argv[5])
    time.sleep(float(sys.argv[6]))
    print("__CURL__=" + drv.current_url)
    print(drv.page_source)
finally:
    drv.quit()
'''


def _browser_get(url: str, profile: str = "", wait: float = 6.0) -> tuple:
    """返回 (final_url, html)"""
    script = os.path.join(HOME, ".openclaw/workspace/scripts/search_profile/_sel.py")
    os.makedirs(os.path.dirname(script), exist_ok=True)
    with open(script, "w") as f:
        f.write(_SELENIUM_SCRIPT)
    cmd = ["xvfb-run", "-a", PYTHON, script, FF_BIN, UA, profile, GECKO, url, str(wait)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    out = r.stdout
    m = re.search(r"__CURL__=(\S+)", out)
    final_url = m.group(1) if m else url
    # 去掉 __CURL__ 行, 其余是 HTML
    html = re.sub(r"__CURL__=\S+\n?", "", out, count=1)
    return final_url, html


# ── Google ─────────────────────────────────────────────────────
def search_google(q: str, n: int = 8):
    url = "https://www.google.com/search?q=" + urllib.parse.quote(q) + f"&num={n}&hl=zh-CN"
    final_url, html = _browser_get(url, profile=PROFILE, wait=7.0)
    if "sorry" in final_url or "sorry" in html[:2000].lower():
        # 标记锁定, 提示用户解锁
        with open(LOCK_FLAG, "w") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S"))
        return {"ok": False, "locked": True, "reason": "Google 需要人工解锁(见解锁指引)"}
    results = []
    # Google 新版: <a class="zReHs" href="https://真实URL"><h3>title</h3>
    # 老版: <a href="/url?q=..."><h3>title</h3>
    for m in re.finditer(r'<a[^>]*href="(/url\?q=|)([^"&]+)[^"]*"[^>]*>.*?<h3[^>]*>(.*?)</h3>', html, re.S):
        prefix, u, t = m.group(1), m.group(2), m.group(3)
        if prefix:
            u = htmllib.unescape(u)
        t = re.sub(r"<[^>]+>", "", t).strip()
        if "enablejs" in u or u.startswith("/httpservice"):
            continue  # Google 的 JS 重试噪声链接
        results.append({"title": t, "url": u})
        if len(results) >= n:
            break
    return {"ok": True, "engine": "google", "results": results}


# ── DuckDuckGo ────────────────────────────────────────────────
def search_ddg(q: str, n: int = 8):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
    final_url, html = _browser_get(url, wait=6.0)
    if "anomaly" in html.lower() or "captcha" in html.lower():
        return {"ok": False, "locked": True, "reason": "DDG anomaly, 可稍后重试或换 Bing"}
    results = []
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', html, re.S):
        u = m.group(1)
        t = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        # DDG 重定向解出真实 URL
        mm = re.search(r"uddg=([^&]+)", u)
        if mm:
            u = urllib.parse.unquote(mm.group(1))
        results.append({"title": t, "url": u})
        if len(results) >= n:
            break
    return {"ok": True, "engine": "ddg", "results": results}


# ── Bing (curl 快通道) ───────────────────────────────────────
def search_bing(q: str, n: int = 8):
    url = "https://www.bing.com/search?q=" + urllib.parse.quote(q) + f"&count={n}"
    r = subprocess.run(
        ["curl", "-s", "-m", "12", "-A", UA,
         "-H", "Accept-Language: zh-CN,zh;q=0.9",
         "-c", os.path.join(HOME, ".openclaw/workspace/scripts/search_profile/bing_cookies.txt"),
         "-b", os.path.join(HOME, ".openclaw/workspace/scripts/search_profile/bing_cookies.txt"),
         url],
        capture_output=True, text=True, timeout=20)
    body = r.stdout
    if re.search(r"captcha|challenge|b_captcha", body, re.I) and "b_results" not in body:
        return {"ok": False, "locked": True, "reason": "Bing captcha"}
    results = []
    for m in re.finditer(r'<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', body, re.S):
        u = htmllib.unescape(m.group(1))
        t = re.sub(r"<[^>]+>", "", m.group(2)).strip()
        real = re.search(r"u=a1([^&]+)", u)
        if real:
            try:
                u = __import__("base64").b64decode(real.group(1) + "==").decode()
            except Exception:
                pass
        results.append({"title": t, "url": u})
        if len(results) >= n:
            break
    return {"ok": True, "engine": "bing", "results": results}


# ── 主入口: 降级链 ───────────────────────────────────────────
def search(q: str, prefer: str = ""):
    chain = []
    if prefer == "google":
        chain = ["google", "ddg", "bing"]
    elif prefer == "ddg":
        chain = ["ddg", "bing", "google"]
    elif prefer == "bing":
        chain = ["bing", "ddg", "google"]
    else:
        chain = ["google", "ddg", "bing"]

    for eng in chain:
        fn = {"google": search_google, "ddg": search_ddg, "bing": search_bing}[eng]
        try:
            res = fn(q)
        except Exception as e:
            res = {"ok": False, "reason": f"{eng}: {e}"}
        if res.get("ok") and res.get("results"):
            return res
    # 全失败
    return {"ok": False, "reason": "所有引擎失败", "detail": chain}


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "reason": "用法: web_search.py '查询' [--engine x] [--count N]"}))
        sys.exit(1)
    q = args[0]
    prefer = ""
    n = 8
    if "--engine" in args:
        prefer = args[args.index("--engine") + 1]
    if "--count" in args:
        n = int(args[args.index("--count") + 1])
    if "--unlock-check" in args:
        res = search_google("test")
        print(json.dumps({"google_locked": res.get("locked", False),
                          "reason": res.get("reason", "")}))
        sys.exit(0)
    res = search(q, prefer)
    print(json.dumps(res, ensure_ascii=False, indent=1))
