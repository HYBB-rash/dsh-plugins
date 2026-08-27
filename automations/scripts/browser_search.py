#!/usr/bin/env python3
"""browser_search.py — drive the user's research Chrome (CDP :9222).

Channel: ~/.config/openclaw-browser (copy of the user's real profile → keeps
Google login state). Chrome must be running with --remote-debugging-port=9222
(see browser_start.py). Pure stdlib — no pip deps.

Commands:
  status                       list tabs
  open <url>                   open/reuse research tab, wait load, print state+captcha
  search <query> [--engine auto|google|ddg|bing] [--n N]
                               engine fallback chain (google→ddg→bing), JSON results
  text [--maxlen N] [--selector sel]  visible text of the research tab
  captcha                      check research tab for human-verification markers
  wait-human [--timeout S]     poll until captcha clears (user solves it in the window)
  eval <js>                    raw Runtime.evaluate on the research tab
  close                        close the research tab
Exit codes: 0 ok, 2 captcha/human-needed, 3 engine blocked/failed, 4 no chrome/cdp.
"""
import argparse, base64, hashlib, json, os, socket, struct, subprocess, sys, time
import urllib.parse
import urllib.request

PORT = 9222
HOST = "127.0.0.1"
MARKER = "hermes=1"          # fragment marker to identify our research tab
ENGINES = {
    "google": "https://www.google.com/search?q={q}&{m}",
    "ddg":    "https://duckduckgo.com/?q={q}&ia=web&{m}",
    "bing":   "https://www.bing.com/search?q={q}&{m}",
}
CAPTCHA_MARKERS = [
    "recaptcha", "g-recaptcha", "hcaptcha", "captcha", "unusual traffic",
    "unusual activity", "i'm not a robot", "verify you are human",
    "verify you're a human", "验证您是人类", "人机验证", "安全验证", "请完成验证",
    "challenge", "cf-chl", "cf-challenge", "cloudflare", "turnstile",
]

# ---------------------------------------------------------------- CDP plumbing

class CDP:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.sock, self.conn_id = self._connect()
        self.msg_id = 0
        self.pending = {}

    def _connect(self):
        # parse ws://host:port/path
        rest = self.ws_url.split("://", 1)[1]
        hostport, path = rest.split("/", 1)
        path = "/" + path
        host, _, port = hostport.partition(":")
        port = int(port or 80)
        s = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {hostport}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += s.recv(4096)
        head, _, _ = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"ws handshake failed: {head[:100]}")
        return s, 0

    def _send_frame(self, opcode, payload=b""):
        mask = os.urandom(4)
        ln = len(payload)
        header = bytearray([0x80 | opcode])
        if ln < 126:
            header.append(0x80 | ln)
        elif ln < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", ln)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", ln)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def _recv_frame(self):
        h = self._recv_exact(2)
        opcode = h[0] & 0x0F
        ln = h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._recv_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._recv_exact(8))[0]
        masked = h[1] & 0x80
        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(ln)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("ws closed")
            buf += chunk
        return buf

    def call(self, method, params=None):
        self.msg_id += 1
        mid = self.msg_id
        self._send_frame(1, json.dumps({"id": mid, "method": method,
                                        "params": params or {}}).encode())
        while True:
            op, payload = self._recv_frame()
            if op == 9:                       # ping → pong
                self._send_frame(10, payload)
                continue
            if op != 1:
                continue
            msg = json.loads(payload)
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})
            # ignore events

    def close(self):
        try:
            self._send_frame(8)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass

# ---------------------------------------------------------------- helpers

def http_json(path):
    with urllib.request.urlopen(f"http://{HOST}:{PORT}{path}", timeout=5) as r:
        return json.loads(r.read())

def list_tabs():
    return [t for t in http_json("/json/list") if t.get("type") == "page"]

def research_tab():
    """Find our marked tab, else the newest page tab, else None."""
    tabs = list_tabs()
    for t in tabs:
        if MARKER in t.get("url", ""):
            return t
    return (tabs[0] if tabs else None)

def get_cdp(tab=None):
    tab = tab or research_tab()
    if not tab:
        return None, None
    return CDP(tab["webSocketDebuggerUrl"]), tab

def eval_js(cdp, js):
    res = cdp.call("Runtime.evaluate", {"expression": js, "returnByValue": True,
                                        "awaitPromise": True})
    exc = res.get("exceptionDetails")
    if exc:
        raise RuntimeError("JS error: " + json.dumps(exc, ensure_ascii=False)[:300])
    return res.get("result", {}).get("value")

def wait_loaded(cdp, timeout=15):
    """Poll document.readyState == complete."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if eval_js(cdp, "document.readyState") == "complete":
                time.sleep(1.2)          # let JS-rendered SERP settle
                return
        except Exception:
            pass
        time.sleep(0.4)
    raise RuntimeError("page load timeout")

def check_captcha(cdp):
    return eval_js(cdp, """(() => {
      const t = (document.body?document.body.innerText:'') + ' ' + document.title;
      const url = location.href;
      const frames = [...document.querySelectorAll('iframe')].map(f=>f.src||'').join(' ');
      const hay = (url+' '+t+' '+frames).toLowerCase();
      const markers = %s;
      return {captcha: markers.filter(m=>hay.includes(m)),
              url, title: document.title};
    })()""" % json.dumps(CAPTCHA_MARKERS))

SEARCH_JS = """(() => {
  const out = [], seen = new Set();
  const unwrap = (u) => {
    try {
      if (u.includes('google.com/url?q=')) {
        const q = new URL(u).searchParams.get('q');
        if (q) return q;
      }
      if (u.includes('/ck/a')) {            // Bing redirect
        const uu = new URL(u).searchParams.get('u');
        if (uu && uu.startsWith('a1')) return atob(uu.slice(2));
      }
    } catch(e) {}
    return u;
  };
  const selfish = /(google|bing|duckduckgo)\\.(com|co\\.\\w+)\\/[^ ]*\\?.*(search|q=)/i;
  const tabby = /^(pull requests|security|insights|issues|actions|releases|wiki|contributing|readme|overview|about|pulse)$/i;
  const push = (title, href, container) => {
    title = (title||'').trim().replace(/\\s+/g,' ');
    if (title.length < 4) return;
    const real = unwrap(href);
    if (selfish.test(real) || /\\/search\\?/.test(real)) return;
    if (/support\\.google\\.com\\/websearch/.test(real)) return;
    if (tabby.test(title)) return;
    let snippet = '';
    if (container) {
      snippet = (container.innerText||'').replace(/\\s+/g,' ').trim();
      if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
      else {
        const i = snippet.indexOf(title);
        if (i >= 0) snippet = snippet.slice(i + title.length).trim();
      }
    }
    const key = real.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push({title, url: real, snippet: snippet.slice(0,300)});
  };
  // mode 1: article containers (DuckDuckGo)
  const arts = document.querySelectorAll('article');
  if (arts.length) {
    for (const art of arts) {
      const link = art.querySelector('a[href^="http"]');
      const h = art.querySelector('h1,h2,h3,h4,h5');
      if (!link || !h) continue;
      push(h.innerText, link.href, art);
    }
  } else {
    // mode 2: b_algo containers (Bing)
    const algos = document.querySelectorAll('li.b_algo');
    if (algos.length) {
      for (const it of algos) {
        const link = it.querySelector('a[href^="http"]');
        const h = it.querySelector('h1,h2,h3,h4,h5');
        if (!link || !h) continue;
        push(h.innerText, link.href, it);
      }
    } else {
      // mode 3: heading-anchors (Google)
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.querySelector('h1,h2,h3,h4,h5');
        if (!h) continue;
        push(h.innerText, a.href, a);
      }
    }
  }
  return out.slice(0,30);
})()"""

def do_search(query, engine):
    q = urllib.parse.quote(query)
    url = ENGINES[engine].format(q=q, m=MARKER)
    tab = research_tab()
    cdp = None
    if tab and not tab.get("url", "").startswith("chrome://"):
        cdp = CDP(tab["webSocketDebuggerUrl"])
        cdp.call("Page.navigate", {"url": url})
    else:
        # open a fresh tab via the HTTP endpoint
        http_json("/json/new?" + urllib.parse.quote(url, safe=""))
        time.sleep(1.0)
        tab = research_tab()
        cdp = CDP(tab["webSocketDebuggerUrl"])
    wait_loaded(cdp)
    cap = check_captcha(cdp)
    results = []
    if not cap["captcha"]:
        # poll until results appear (JS-rendered SERPs settle at their own pace)
        t0 = time.time()
        while time.time() - t0 < 8:
            results = eval_js(cdp, SEARCH_JS)
            if results:
                break
            time.sleep(0.6)
    cdp.close()
    return cap, results

# ---------------------------------------------------------------- commands

def cmd_status():
    tabs = list_tabs()
    print(json.dumps([{"id": t["id"][:8], "url": t["url"][:100], "title": t.get("title","")[:60]}
                      for t in tabs], ensure_ascii=False, indent=1))

def cmd_open(url):
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    tab = research_tab()
    if tab and not tab.get("url", "").startswith("chrome://"):
        cdp = CDP(tab["webSocketDebuggerUrl"])
        cdp.call("Page.navigate", {"url": url})
    else:
        http_json("/json/new?" + urllib.parse.quote(url, safe=""))
        time.sleep(1.0)
        tab = research_tab()
        cdp = CDP(tab["webSocketDebuggerUrl"])
    wait_loaded(cdp)
    state = eval_js(cdp, "({url:location.href, title:document.title})")
    cap = check_captcha(cdp)
    cdp.close()
    out = {"url": state["url"], "title": state["title"], "captcha": cap["captcha"]}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 2 if cap["captcha"] else 0

def cmd_search(args):
    if args.engine == "auto":
        chain = ["google", "ddg", "bing"]
    else:
        chain = [args.engine]
    # 远端/headless 场景（无人解验证码）：HERMES_BROWSER_SKIP_CAPTCHA=1
    # 时 captcha 不再中断，记录后继续降级链；全链都验证码才报 captcha。
    skip_captcha = os.environ.get("HERMES_BROWSER_SKIP_CAPTCHA") in ("1", "true", "yes")
    last_err = None
    captcha_hit = None
    for eng in chain:
        try:
            cap, results = do_search(args.query, eng)
        except Exception as e:
            last_err = f"{eng}: {e}"
            continue
        if cap["captcha"]:
            if not skip_captcha:
                print(json.dumps({"engine": eng, "captcha": True,
                                  "markers": cap["captcha"], "url": cap["url"]},
                                 ensure_ascii=False))
                return 2
            captcha_hit = {"engine": eng, "markers": cap["captcha"], "url": cap["url"]}
            continue
        if results:
            out = {"engine": eng, "results": results[:args.n]}
            if captcha_hit:
                out["captcha_skipped"] = captcha_hit["engine"]
            print(json.dumps(out, ensure_ascii=False, indent=1))
            return 0
        last_err = f"{eng}: empty results"
    if captcha_hit:
        print(json.dumps(captcha_hit, ensure_ascii=False))
        return 2
    print(json.dumps({"error": "all engines failed", "detail": last_err},
                     ensure_ascii=False))
    return 3

def cmd_text(args):
    cdp, tab = get_cdp()
    if not cdp:
        print("no research tab", file=sys.stderr)
        return 4
    js = (f"document.querySelector({json.dumps(args.selector)}).innerText"
          if args.selector else "document.body.innerText")
    txt = eval_js(cdp, js) or ""
    cdp.close()
    print(txt[:args.maxlen])

def cmd_captcha():
    cdp, tab = get_cdp()
    if not cdp:
        print("no research tab", file=sys.stderr)
        return 4
    cap = check_captcha(cdp)
    cdp.close()
    print(json.dumps(cap, ensure_ascii=False))
    return 2 if cap["captcha"] else 0

def cmd_wait_human(args):
    t0 = time.time()
    while time.time() - t0 < args.timeout:
        cdp, tab = get_cdp()
        if cdp:
            cap = check_captcha(cdp)
            cdp.close()
            if not cap["captcha"]:
                print(json.dumps({"solved": True, "url": cap["url"],
                                  "title": cap["title"]}, ensure_ascii=False))
                return 0
        time.sleep(5)
    print(json.dumps({"solved": False}, ensure_ascii=False))
    return 2

def cmd_eval(js):
    cdp, tab = get_cdp()
    if not cdp:
        print("no research tab", file=sys.stderr)
        return 4
    v = eval_js(cdp, js)
    cdp.close()
    print(json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v)

def cmd_close():
    tab = research_tab()
    if not tab:
        return 0
    try:
        http_json("/json/close/" + tab["id"])
    except Exception:
        pass
    return 0

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p = sub.add_parser("open"); p.add_argument("url")
    p = sub.add_parser("search"); p.add_argument("query")
    p.add_argument("--engine", default="auto", choices=["auto", "google", "ddg", "bing"])
    p.add_argument("--n", type=int, default=8)
    p = sub.add_parser("text"); p.add_argument("--maxlen", type=int, default=20000)
    p.add_argument("--selector")
    sub.add_parser("captcha")
    p = sub.add_parser("wait-human"); p.add_argument("--timeout", type=int, default=300)
    p = sub.add_parser("eval"); p.add_argument("js")
    sub.add_parser("close")
    args = ap.parse_args()

    try:
        if args.cmd == "status": cmd_status()
        elif args.cmd == "open": sys.exit(cmd_open(args.url))
        elif args.cmd == "search": sys.exit(cmd_search(args))
        elif args.cmd == "text": cmd_text(args)
        elif args.cmd == "captcha": sys.exit(cmd_captcha())
        elif args.cmd == "wait-human": sys.exit(cmd_wait_human(args))
        elif args.cmd == "eval": cmd_eval(args.js)
        elif args.cmd == "close": cmd_close()
    except (ConnectionError, OSError, RuntimeError) as e:
        print(f"CDP error: {e}", file=sys.stderr)
        sys.exit(4)

if __name__ == "__main__":
    main()
