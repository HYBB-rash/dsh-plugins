#!/usr/bin/env python3
"""信息流监控聚合器:抓取非交易类站点(OpenAI状态/HF新模型/HN/GitHub/Reddit),去重输出新增。
用法: python3 info_monitor.py
输出: 有新增->格式化文本; 无新增->NO_REPLY(静默)
"""
import json, os, re, sys, time, urllib.request, urllib.parse

STATE = "/home/herman/.openclaw/workspace/data/info_monitor_state.json"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"}

def fetch(url, timeout=12):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:
        return None

def load_state():
    if os.path.exists(STATE):
        try:
            d = json.load(open(STATE))
            # set 兼容:list -> set
            for k in d:
                if isinstance(d[k], list):
                    d[k] = set(d[k])
            return d
        except Exception:
            return {}
    return {}

def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    # set -> list 才能 json 序列化
    out = {k: (list(v) if isinstance(v, set) else v) for k, v in st.items()}
    with open(STATE, "w") as f:
        json.dump(out, f, ensure_ascii=False)

def main():
    st = load_state()
    out = []

    # 1. OpenAI Status incidents
    try:
        d = json.loads(fetch("https://status.openai.com/api/v2/incidents.json") or "{}")
        incs = d.get("incidents", [])
        new_inc = []
        for i in incs:
            if i.get("status") in ("investigating", "identified", "monitoring") or i.get("impact") != "none":
                if i.get("id") not in st.get("openai_inc", set()):
                    new_inc.append(i)
        if new_inc:
            st["openai_inc"] = st.get("openai_inc", set()) | {i["id"] for i in new_inc}
            for i in new_inc[:3]:
                out.append(f"- [OpenAI 状态] {i.get('name','?')} ({i.get('status','?')}) {i.get('shortlink','')}")
    except Exception:
        pass

    # 2. HuggingFace trending 模型
    try:
        d = json.loads(fetch("https://huggingface.co/api/models?sort=trendingScore&limit=8") or "[]")
        for m in d:
            mid = m.get("id", "")
            if mid and mid not in st.get("hf_models", set()):
                st["hf_models"] = st.get("hf_models", set()) | {mid}
                likes = m.get("likes", 0)
                out.append(f"- [HF 新模型] {mid} (👍{likes}) https://huggingface.co/{mid}")
    except Exception:
        pass

    # 3. HN topstories(过滤 AI/agent 关键词)
    try:
        ids = json.loads(fetch("https://hacker-news.firebaseio.com/v0/topstories.json") or "[]")[:30]
        kws = ["ai", "llm", "agent", "gpt", "claude", "codex", "openai", "anthropic", "deepseek", "model", "reasoning", "nixos", "arch", "linux"]
        for hid in ids:
            item = json.loads(fetch(f"https://hacker-news.firebaseio.com/v0/item/{hid}.json") or "{}")
            title = item.get("title", "")
            if title and any(k in title.lower() for k in kws):
                key = f"hn:{hid}"
                if key not in st.get("hn_items", set()):
                    st["hn_items"] = st.get("hn_items", set()) | {key}
                    out.append(f"- [HN] {title} https://news.ycombinator.com/item?id={hid}")
                if len([x for x in out if x.startswith("- [HN]")]) >= 5:
                    break
    except Exception:
        pass

    # 4. GitHub releases(openai/codex + ilysenko 打包项目)
    for repo in ["openai/codex", "ilysenko/codex-desktop-linux"]:
        try:
            d = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases?per_page=2") or "[]")
            for r in d:
                tag = r.get("tag_name", "")
                key = f"gh:{repo}:{tag}"
                if tag and key not in st.get("gh_rel", set()):
                    st["gh_rel"] = st.get("gh_rel", set()) | {key}
                    out.append(f"- [GitHub] {repo} 发布 {tag} {r.get('html_url','')}")
        except Exception:
            pass

    # 5. Reddit(CodexAI 等;429 时提示用户)
    subs = ["CodexAI", "ReverseEngineering", "osdev", "fitness"]
    reddit_blocked = False
    for sub in subs:
        try:
            txt = fetch(f"https://www.reddit.com/r/{sub}/.rss?limit=5")
            if not txt:
                reddit_blocked = True
                continue
            # 简单提取 title/link
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link[^>]*href=\"([^\"]+)\"", txt) or re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:6]):  # 跳过 feed title
                key = f"rd:{sub}:{t}"
                if key not in st.get("rd_items", set()):
                    st["rd_items"] = st.get("rd_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else f"https://www.reddit.com/r/{sub}/"
                    out.append(f"- [r/{sub}] {t} {url}")
        except Exception:
            reddit_blocked = True

    # 6. 期货/外汇/宏观(用户 2026-08-12 更新:主做美指期货/商品期货/外汇)
    # FXStreet 外汇新闻
    try:
        txt = fetch("https://www.fxstreet.com/rss/news")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:6]):
                key = f"fx:{t}"
                if key not in st.get("fx_items", set()):
                    st["fx_items"] = st.get("fx_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else "https://www.fxstreet.com/"
                    out.append(f"- [FXStreet] {t} {url}")
    except Exception:
        pass
    # TradingEconomics 宏观日历
    try:
        txt = fetch("https://tradingeconomics.com/calendar")
        if txt:
            # 只提取未来几天的关键事件标题(粗略)
            m = re.findall(r"<a[^>]*href=\"/[a-z]+/[a-z]+\"[^>]*>([^<]{3,60})</a>", txt)
            for t in m[:8]:
                key = f"te:{t}"
                if key not in st.get("te_items", set()):
                    st["te_items"] = st.get("te_items", set()) | {key}
                    out.append(f"- [宏观日历] {t}")
    except Exception:
        pass
    # FRED 暂无 API key,跳过(留位)
    pass
    # Yahoo Finance 市场新闻(期货/美股)
    try:
        txt = fetch("https://finance.yahoo.com/news/rssindex")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:6]):
                key = f"yahoo:{t}"
                if key not in st.get("yahoo_items", set()):
                    st["yahoo_items"] = st.get("yahoo_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else "https://finance.yahoo.com/"
                    out.append(f"- [Yahoo市场] {t} {url}")
    except Exception:
        pass

    # 6. 期货/外汇/宏观(用户主做美指期货/商品期货/外汇)
    # FXStreet 外汇新闻
    try:
        txt = fetch("https://www.fxstreet.com/rss/news")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:7]):
                key = f"fx:{t}"
                if key not in st.get("fx_items", set()):
                    st["fx_items"] = st.get("fx_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else "https://www.fxstreet.com/"
                    out.append(f"- [FXStreet] {t} {url}")
    except Exception:
        pass
    # MarketWatch 市场新闻
    try:
        txt = fetch("https://feeds.content.dowjones.io/public/rss/mw_topstories")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:7]):
                key = f"mw:{t}"
                if key not in st.get("mw_items", set()):
                    st["mw_items"] = st.get("mw_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else "https://www.marketwatch.com/"
                    out.append(f"- [MarketWatch] {t} {url}")
    except Exception:
        pass
    # TradingEconomics 宏观日历
    try:
        txt = fetch("https://tradingeconomics.com/calendar")
        if txt:
            m = re.findall(r"<a[^>]*href=\"/[a-z]+/[a-z]+\"[^>]*>([^<]{3,60})</a>", txt)
            for t in m[:6]:
                key = f"te:{t}"
                if key not in st.get("te_items", set()):
                    st["te_items"] = st.get("te_items", set()) | {key}
                    out.append(f"- [宏观日历] {t}")
    except Exception:
        pass
    # Yahoo Finance 市场新闻
    try:
        txt = fetch("https://finance.yahoo.com/news/rssindex")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            for i, t in enumerate(titles[1:7]):
                key = f"yf:{t}"
                if key not in st.get("yf_items", set()):
                    st["yf_items"] = st.get("yf_items", set()) | {key}
                    url = links[i+1] if i+1 < len(links) else "https://finance.yahoo.com/"
                    out.append(f"- [Yahoo市场] {t} {url}")
    except Exception:
        pass

    # 7. BTC/ETH 主流币(用户 2026-08-12:加密做得少但仍在做,只看主流币)
    try:
        txt = fetch("https://cointelegraph.com/rss")
        if txt:
            titles = re.findall(r"<title>([^<]+)</title>", txt)
            links = re.findall(r"<link>([^<]+)</link>", txt)
            btceth_kw = ["bitcoin", "btc", "ethereum", "eth ", "ether"]
            n = 0
            for i, t in enumerate(titles[1:15]):
                tl = t.lower()
                if any(k in tl for k in btceth_kw):
                    key = f"ct:{t}"
                    if key not in st.get("ct_items", set()):
                        st["ct_items"] = st.get("ct_items", set()) | {key}
                        url = links[i+1] if i+1 < len(links) else "https://cointelegraph.com/"
                        out.append(f"- [BTC/ETH] {t} {url}")
                        n += 1
                        if n >= 3:
                            break
    except Exception:
        pass

    save_state(st)

    import sys as _sys
    json_mode = "--json" in _sys.argv
    if json_mode:
        # 结构化输出:items + blocked 标记(供 trigger/AI 翻译用)
        import re as _re
        items = []
        for line in out[:15]:
            m = _re.match(r"^- \[([^\]]+)\] (.+?)( https?://\S+)?$", line)
            if m:
                tag = m.group(1)
                title = m.group(2).strip()
                url = (m.group(3) or "").strip()
                items.append({"tag": tag, "title": title, "url": url})
        print(json.dumps({"items": items, "reddit_blocked": reddit_blocked, "ts": int(time.time())}, ensure_ascii=False))
        return
    if reddit_blocked and not out:
        print("⚠️ Reddit 被限流(429),其余源无新增——需要用户手动解开 Reddit 限流")
        return
    if not out:
        print("NO_REPLY")
        return
    header = f"📡 信息流 ({time.strftime('%m-%d %H:%M')})"
    print(header)
    for line in out[:15]:
        print(line)

if __name__ == "__main__":
    main()
