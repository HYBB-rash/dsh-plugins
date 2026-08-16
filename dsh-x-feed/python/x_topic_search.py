#!/usr/bin/env python3
"""X 话题搜索器:按主题搜索,收集讨论推文(去重入库)。

探索流隔离(2026-08-14 架构裁决): 搜索结果默认写入独立 x_explore_items.jsonl,
带 topic(必选)与 anchor/bridge/hop(可选, hop ∈ {1,2}), 永不再写主时间线 x_timeline.jsonl。
搜索成功后把 canonical topic 记入 x_wander_state.json(冷却/探索次数台账, 机械簿记)。
用法: python3 x_topic_search.py "KAITO" [--rolls N] [--live] [--anchor <id>] [--bridge <文本>] [--hop 1|2]
"""
import json, os, subprocess, sys, time, urllib.request, argparse, urllib.parse

import x_timeline_store as timeline_store
import x_browser
import x_neighborhood
import x_paths

DATA = x_paths.data_dir()
OUT = os.path.join(DATA, "x_explore_items.jsonl")  # 独立探索流, 不污染主时间线
ALIASES = os.path.join(DATA, "x_topic_aliases.json")
WANDER_STATE = os.path.join(DATA, "x_wander_state.json")
os.makedirs(os.path.dirname(OUT), exist_ok=True)


def _tag_explore(item, topic, anchor=None, bridge=None, hop=None):
    """给搜索结果打探索字段: topic 必选, anchor/bridge/hop 可选(不传不出现)。"""
    tagged = dict(item)
    tagged["ts"] = int(time.time())
    tagged["topic"] = topic
    if anchor:
        tagged["anchor"] = anchor
    if bridge:
        tagged["bridge"] = bridge
    if hop is not None:
        tagged["hop"] = int(hop)
    return tagged


def append_explore_records(out_path, records):
    """安全去重追加到探索流(复用 timeline_store 的 flock + 锁内查重 + fsync)。"""
    return timeline_store.append_unique_records(out_path, records)


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
    r = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=35)
    try:
        return json.loads(r.stdout.strip().split('\n')[-1])
    except Exception:
        return {"ok": False, "err": r.stderr[:200]}

def grab_tweets(ws_url):
    expr = """(() => {
      const items = [];
      document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
        const link = a.querySelector('a[href*="/status/"]');
        const text = a.querySelector('[data-testid="tweetText"]');
        const time = a.querySelector('time');
        const user = a.querySelector('[data-testid="User-Name"]');
        if (link) {
          const id = link.href.split('/status/')[1]?.split('?')[0] || link.href;
          items.push({id, url: link.href.split('?')[0], text: text?.innerText || '', time: time?.getAttribute('datetime') || '', user: user?.innerText || ''});
        }
      });
      return JSON.stringify(items);
    })()"""
    return cdp(ws_url, expr)

def search_topic(topic, rolls=6, sleep_s=2.5, live=False, out=None,
                 anchor=None, bridge=None, hop=None):
    q = urllib.parse.quote(topic)
    url = f"https://x.com/search?q={q}&f=live" if live else f"https://x.com/search?q={q}"
    target = out or OUT
    # This process shares one X debug tab with the timeline collector and
    # explorer. Hold the lock across navigation and all scrolls so a second
    # job cannot change the page between CDP calls.
    with timeline_store.browser_lock():
        tab = None
        for attempt in range(2):
            try:
                tab = get_tab()
                break
            except x_browser.BrowserRecoveryError as exc:
                retryable = {'browser_unavailable', 'cdp_disconnected', 'cdp_timeout', 'tab_unavailable'}
                if attempt == 0 and exc.code in retryable and x_browser.run_browser_start(restart=True) == 0:
                    continue
                return {"ok": False, "state": "X_TAB_READY", "error_class": exc.code,
                        "retryable": exc.code in retryable, "attempts": attempt + 1,
                        "detail": exc.detail}
        if not tab:
            return {"ok": False, "state": "X_TAB_READY", "error_class": "tab_unavailable",
                    "retryable": True}
        ws = tab['webSocketDebuggerUrl']
        cdp(ws, f"location.href = {json.dumps(url)}; 'nav'", 500)
        time.sleep(7)

        new_items = []
        for i in range(rolls):
            r = grab_tweets(ws)
            if r.get('ok'):
                try:
                    candidates = []
                    for it in json.loads(r['val']):
                        if it['text']:
                            candidates.append(_tag_explore(it, topic, anchor, bridge, hop))
                    new_items.extend(append_explore_records(target, candidates))
                except Exception as e:
                    print(f"parse err: {e}", file=sys.stderr)
            cdp(ws, "window.scrollBy(0, window.innerHeight * 1.5); 'ok'")
            time.sleep(sleep_s)
            print(f"  [{topic}] roll {i+1}/{rolls}: +{len(new_items)}", file=sys.stderr)
    # 机械簿记: 探索过 canonical topic(冷却/次数台账); 失败不阻塞搜索结果
    try:
        x_neighborhood.record_exploration_for_surface(ALIASES, WANDER_STATE, topic, int(time.time()))
    except Exception as e:
        print(f"wander state note failed: {e}", file=sys.stderr)
    return {"ok": True, "topic": topic, "new": len(new_items)}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("topic", help="搜索话题")
    ap.add_argument("--rolls", type=int, default=6)
    ap.add_argument("--sleep", type=float, default=2.5)
    ap.add_argument("--live", action="store_true", help="按最新排序")
    ap.add_argument("--out", default=None, help="探索流输出文件(默认 data/x_explore_items.jsonl)")
    ap.add_argument("--anchor", default=None, help="锚点 canonical topic id(机械层搬运, 由 AI 选题者传入)")
    ap.add_argument("--bridge", default=None, help="桥梁解释文本(由 AI 写入, 机械层不生成语义)")
    ap.add_argument("--hop", type=int, choices=[1, 2], default=None, help="跳数(1 或 2)")
    a = ap.parse_args()
    r = search_topic(a.topic, a.rolls, a.sleep, a.live, a.out, a.anchor, a.bridge, a.hop)
    print(json.dumps(r, ensure_ascii=False))
