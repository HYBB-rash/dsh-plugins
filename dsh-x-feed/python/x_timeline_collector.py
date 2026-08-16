#!/usr/bin/env python3
"""X 时间线漫游收集器 v2:滚动抓取推文(含媒体图片/视频链接),存 JSONL 去重。
用法: python3 x_timeline_collector.py [--rolls N] [--sleep S]
"""
import json, os, subprocess, sys, time, urllib.request, argparse

import x_timeline_store as timeline_store
import x_browser
import x_paths

OUT = os.path.join(x_paths.data_dir(), "x_timeline.jsonl")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# 随机起始源: For You / Following / Explore(用户 2026-08-13 定稿: 让时间线乱一点)
START_SOURCES = ("for_you", "following", "explore")


def pick_start_source(seed=None):
    """随机三选一起始源: for_you / following / explore。"""
    import random
    if seed is not None:
        random.seed(seed)
    return random.choice(START_SOURCES)


def start_url(source):
    """起始源 → URL。"""
    if source == "following":
        return "https://x.com/home?feed=following"
    if source == "explore":
        return "https://x.com/explore"
    return "https://x.com/home"  # for_you / 默认


def refresh_button_expr():
    """点击「查看新帖子」按钮(比 reload 干净, 拉真正新内容)。"""
    return """(() => {
      const btn = [...document.querySelectorAll('[role="button"]')]
        .find(b => (b.innerText || '').includes('查看新帖子') || (b.innerText || '').includes('Show new posts'));
      if (btn) { btn.click(); return 'clicked'; }
      return 'no_button';
    })()"""


def nav_to_url_expr(url):
    """导航到指定 URL。"""
    return f"location.href = {json.dumps(url)}; 'nav'"


def get_tab():
    """Return a usable X target, recovering Chrome/creating a tab if needed."""
    return x_browser.ensure_x_tab()


def page_state_expr():
    """Small DOM snapshot used to distinguish login from browser failures."""
    return """JSON.stringify({url: location.href, body: (document.body?.innerText || '').slice(0, 12000)})"""


def ensure_home_tab(ws_url):
    """随机选择起始源并导航(用户 2026-08-13: 三选一乱序, 避免总看同一批内容)。
    每次收集都重新随机选 For You / Following / Explore 之一导航——
    不依赖当前页状态, 保证轮换; 导航后点「查看新帖子」拉新内容。"""
    source = pick_start_source()
    nav = grab_text(ws_url, nav_to_url_expr(start_url(source)))
    if not nav.get('ok'):
        raise x_browser.BrowserRecoveryError(
            nav.get('error_class', 'cdp_disconnected'), nav.get('err', 'navigation failed'))
    time.sleep(6)
    state = grab_text(ws_url, page_state_expr())
    if not state.get('ok'):
        raise x_browser.BrowserRecoveryError(
            state.get('error_class', 'cdp_disconnected'), state.get('err', 'page probe failed'))
    try:
        page = json.loads(state.get('val') or '{}')
    except (TypeError, ValueError) as exc:
        raise x_browser.BrowserRecoveryError('payload_invalid', str(exc)) from exc
    page_status = x_browser.classify_x_page(page.get('url'), page.get('body'))
    if page_status != 'ready':
        raise x_browser.BrowserRecoveryError(page_status, page.get('url', ''))
    # 尝试点「查看新帖子」拉真正新内容(有按钮才点, 没有就靠导航本身)
    res = grab_text(ws_url, refresh_button_expr())
    if not res.get('ok'):
        raise x_browser.BrowserRecoveryError(
            res.get('error_class', 'cdp_disconnected'), res.get('err', 'refresh failed'))
    if res.get('val') == 'clicked':
        time.sleep(3)
    return True

def grab_text(ws_url, expr):
    script = f"""
const ws = new WebSocket('{ws_url}');
let id = 0; const pending = {{}};
ws.onmessage = (e) => {{ const r = JSON.parse(e.data); if (r.id && pending[r.id]) {{ pending[r.id](r); delete pending[r.id]; }} }};
function cmd(m, p) {{ return new Promise(res => {{ const mid = ++id; pending[mid] = res; ws.send(JSON.stringify({{id: mid, method: m, params: p || {{}}}})); }}); }}
ws.onopen = async () => {{
  await new Promise(r => setTimeout(r, 1500));
  const r = await cmd('Runtime.evaluate', {{expression: {json.dumps(expr)}, returnByValue: true}});
  console.log(JSON.stringify({{ok: true, val: r.result?.result?.value || ''}}));
  ws.close(); process.exit(0);
}};
setTimeout(() => {{ console.log(JSON.stringify({{ok: false, err: 'timeout'}})); process.exit(1); }}, 20000);
"""
    try:
        r = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "err": str(exc), "error_class": "cdp_timeout", "retryable": True}
    try:
        return json.loads(r.stdout.strip().split('\n')[-1])
    except Exception:
        return {"ok": False, "err": r.stderr[:200] or "CDP target disconnected",
                "error_class": "cdp_disconnected", "retryable": True}

def scroll_and_grab(ws_url, rolls, sleep_s, batch_out=None):
    new_items = []
    if batch_out:
        os.makedirs(os.path.dirname(os.path.abspath(batch_out)), exist_ok=True)
    for i in range(rolls):
        expr = """(() => {
          const items = [];
          document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
            const link = a.querySelector('a[href*="/status/"]');
            const text = a.querySelector('[data-testid="tweetText"]');
            const time = a.querySelector('time');
            const user = a.querySelector('[data-testid="User-Name"]');
            const media = [];
            a.querySelectorAll('img[src*="twimg.com/media"]').forEach(img => {
              let src = img.src.split('&name=')[0] + '&name=orig';
              if (!media.includes(src)) media.push(src);
            });
            a.querySelectorAll('video').forEach(v => {
              const src = v.src || v.querySelector('source')?.src;
              if (src && src.includes('twimg') && !media.includes(src)) media.push(src);
            });
            a.querySelectorAll('a[href*="/video/"]').forEach(v => {
              if (!media.includes(v.href)) media.push(v.href);
            });
            if (link) {
              const id = link.href.split('/status/')[1]?.split('?')[0] || link.href;
              items.push({id, url: link.href.split('?')[0], text: text?.innerText || '', time: time?.getAttribute('datetime') || '', user: user?.innerText || '', media});
            }
          });
          return JSON.stringify(items);
        })()"""
        r = grab_text(ws_url, expr)
        if r.get('ok'):
            try:
                candidates = []
                for it in json.loads(r['val']):
                    if it['text']:
                        it['ts'] = int(time.time())
                        candidates.append(it)
                inserted = timeline_store.append_unique_records(OUT, candidates)
                new_items.extend(inserted)
                if batch_out and inserted:
                    with open(batch_out, 'a', encoding='utf-8') as batch_handle:
                        for it in inserted:
                            batch_handle.write(json.dumps(it, ensure_ascii=False) + '\n')
            except Exception as e:
                print(f"parse err: {e}", file=sys.stderr)
        grab_text(ws_url, "window.scrollBy(0, window.innerHeight * 1.5); 'ok'")
        time.sleep(sleep_s)
        print(f"roll {i+1}/{rolls}: 累计新抓 {len(new_items)}", file=sys.stderr)
    return new_items

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rolls", type=int, default=8)
    ap.add_argument("--sleep", type=float, default=3.0)
    ap.add_argument("--batch-out", type=str, default=None, help="本轮新抓推文同时写入的 batch jsonl 路径")
    a = ap.parse_args()
    # Collector, topic search, and explorer share one debug tab. Serialize the
    # complete navigation/scroll session, not only the JSONL append.
    with timeline_store.browser_lock():
        tab = None
        last_error = None
        # A stale target/WebSocket is a browser failure. Recreate the browser
        # once, then reacquire the target; login errors are never retried as
        # browser failures.
        for attempt in range(2):
            try:
                tab = get_tab()
                # 先确保在时间线主页(否则会在单条推文页重复滚动)
                ensure_home_tab(tab['webSocketDebuggerUrl'])
                last_error = None
                break
            except x_browser.BrowserRecoveryError as exc:
                last_error = exc
                if attempt == 0 and exc.code in {
                    'browser_unavailable', 'cdp_disconnected', 'cdp_timeout', 'tab_unavailable'
                }:
                    if x_browser.run_browser_start(restart=True) == 0:
                        continue
                print(json.dumps({
                    "ok": False,
                    "state": "X_TAB_READY",
                    "error_class": exc.code,
                    "retryable": exc.code in {'browser_unavailable', 'cdp_disconnected', 'cdp_timeout'},
                    "attempts": attempt + 1,
                    "detail": exc.detail,
                }, ensure_ascii=False))
                sys.exit(1)
        if not tab or last_error:
            print(json.dumps({"ok": False, "state": "X_TAB_READY",
                              "error_class": "unknown", "retryable": False}))
            sys.exit(1)
        items = scroll_and_grab(tab['webSocketDebuggerUrl'], a.rolls, a.sleep, batch_out=a.batch_out)
    print(json.dumps({"ok": True, "new": len(items), "total_file": sum(1 for _ in open(OUT)) if os.path.exists(OUT) else 0}))
