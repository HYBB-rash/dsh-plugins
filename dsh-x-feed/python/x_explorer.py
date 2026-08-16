#!/usr/bin/env python3
"""X 树状探索器:打开 URL 抓内容,支持推文详情/作者主页/搜索,溯源引用推文。
用法: python3 x_explorer.py --url <x_url> [--depth N]
"""
import json, os, subprocess, sys, time, urllib.request, argparse

import x_timeline_store as timeline_store
import x_browser
import x_paths

OUT_DIR = os.path.join(x_paths.data_dir(), "x_explore")
os.makedirs(OUT_DIR, exist_ok=True)

def get_tab():
    return x_browser.ensure_x_tab()

def cdp(ws_url, expr, wait_ms=1500):
    script = f"""
const ws = new WebSocket('{ws_url}');
let id = 0; const pending = {{}};
ws.onmessage = (e) => {{ const r = JSON.parse(e.data); if (r.id && pending[r.id]) {{ pending[r.id](r); delete pending[r.id]; }} }};
function cmd(m, p) {{ return new Promise(res => {{ const mid = ++id; pending[mid] = res; ws.send(JSON.stringify({{id: mid, method: m, params: p || {{}}}})); }}); }}
ws.onopen = async () => {{
  await new Promise(r => setTimeout(r, {wait_ms}));
  const r = await cmd('Runtime.evaluate', {{expression: {json.dumps(expr)}, returnByValue: true}});
  console.log(JSON.stringify({{ok: true, val: r.result?.result?.value || ''}}));
  ws.close(); process.exit(0);
}};
setTimeout(() => {{ console.log(JSON.stringify({{ok: false, err: 'timeout'}})); process.exit(1); }}, 25000);
"""
    try:
        r = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=35)
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "err": str(exc), "error_class": "cdp_timeout", "retryable": True}
    try:
        return json.loads(r.stdout.strip().split('\n')[-1])
    except Exception:
        return {"ok": False, "err": r.stderr[:200] or "CDP target disconnected",
                "error_class": "cdp_disconnected", "retryable": True}

def open_url(ws_url, url):
    """导航当前标签到 URL,等待加载"""
    expr = f"location.href = {json.dumps(url)}; 'nav'"
    nav = cdp(ws_url, expr, 500)
    if not nav.get('ok'):
        raise x_browser.BrowserRecoveryError(
            nav.get('error_class', 'cdp_disconnected'), nav.get('err', 'navigation failed'))
    time.sleep(6)
    # 抓标题+正文
    r = cdp(ws_url, "document.title + '\\n===BODY===\\n' + (document.body?.innerText || '').slice(0, 4000)")
    if not r.get('ok'):
        raise x_browser.BrowserRecoveryError(
            r.get('error_class', 'cdp_disconnected'), r.get('err', 'page read failed'))
    page_url = cdp(ws_url, "location.href")
    if not page_url.get('ok'):
        raise x_browser.BrowserRecoveryError(
            page_url.get('error_class', 'cdp_disconnected'), page_url.get('err', 'url read failed'))
    body = r.get('val', '').split('===BODY===', 1)[-1]
    page_status = x_browser.classify_x_page(page_url.get('val'), body)
    if page_status != 'ready':
        raise x_browser.BrowserRecoveryError(page_status, page_url.get('val', ''))
    return r

def extract_links(ws_url, url):
    """抓页面所有 X 链接(推文/作者/话题),用于树状展开"""
    expr = """(() => {
      const links = {};
      document.querySelectorAll('a[href*="/status/"], a[href*="/"]').forEach(a => {
        const h = a.href.split('?')[0];
        if (h.includes('x.com/') || h.includes('twitter.com/')) {
          if (h.includes('/status/')) links['tweet'] = links['tweet'] || h;
          else {
            const m = h.match(/x\\.com\\/([^\\/]+)$/);
            if (m && !['home','explore','notifications','messages','compose','search','settings','i'].includes(m[1])) links['author'] = links['author'] || h;
          }
        }
      });
      return JSON.stringify(links);
    })()"""
    return cdp(ws_url, expr)

def save(name, content):
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w') as f:
        f.write(content)
    return path

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="X URL 起点")
    ap.add_argument("--name", default="explore", help="保存文件名")
    a = ap.parse_args()
    with timeline_store.browser_lock():
        for attempt in range(2):
            try:
                tab = get_tab()
                ws = tab['webSocketDebuggerUrl']
                r = open_url(ws, a.url)
                text = r.get('val', '')
                title = text.split('===BODY===')[0][:100]
                body = text.split('===BODY===')[1] if '===BODY===' in text else text
                links = extract_links(ws, a.url)
                if not links.get('ok'):
                    raise x_browser.BrowserRecoveryError(
                        links.get('error_class', 'cdp_disconnected'), links.get('err', 'link extraction failed'))
                break
            except x_browser.BrowserRecoveryError as exc:
                retryable = {'browser_unavailable', 'cdp_disconnected', 'cdp_timeout', 'tab_unavailable'}
                if attempt == 0 and exc.code in retryable and x_browser.run_browser_start(restart=True) == 0:
                    continue
                print(json.dumps({"ok": False, "state": "EXTRACTING",
                                  "error_class": exc.code, "retryable": exc.code in retryable,
                                  "attempts": attempt + 1, "detail": exc.detail}, ensure_ascii=False))
                sys.exit(1)
    path = save(a.name + '.txt', f"URL: {a.url}\nTITLE: {title}\n\n{body}\n\nLINKS: {json.dumps(links, ensure_ascii=False)}")
    print(json.dumps({"ok": True, "title": title, "body_len": len(body), "links": links.get('val') if links.get('ok') else None, "saved": path}))
