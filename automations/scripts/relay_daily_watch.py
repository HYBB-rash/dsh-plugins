#!/usr/bin/env python3
"""relay_daily_watch — 每日中转站新站发现日报

流程:
1. 拉取新站候选源: awesome-ai-proxy 汇总 + Sub2API README 赞助商 + Veridrop 收录站
2. 与本地已知榜单(~/sub2api_sites.md)对比, 找出"新站"(榜单里没有的)
3. 对新站做体检: Sub2API 指纹 + Veridrop 评分 + 连通性
4. 输出日报(no_agent 模式, stdout 直接投递)

用法:
  python3 relay_daily_watch.py            # 正常跑, 有发现才输出(静默机制)
  python3 relay_daily_watch.py --force    # 强制输出(即使无新站)
"""
import sys
import re
import os
import json
import subprocess
import concurrent.futures

from automation_paths import state_file

HOME = os.path.expanduser("~")
KNOWN_FILE = os.path.join(HOME, "sub2api_sites.md")
STATE_FILE = state_file("relay_watch_state.json")
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"

SUB2_PATTERN = re.compile(
    r'(RedeemView|AvailableChannelsView|AdminPaymentDashboardView|ChannelMonitorView|'
    r'SetupWizardView|ProxiesView|LinuxDoCallbackView|VipServiceView|BatchImageGuideView|'
    r'AdminAffiliateInvitesView|PublicTransitView|ModelPlazaView|OidcCallbackView|'
    r'DingTalkCallbackView|PromptAuditView|RiskControlView|AirwallexPaymentView|'
    r'WechatPaymentCallbackView|KeyUsageView)')


def _curl(url, timeout=10):
    r = subprocess.run(["curl", "-s", "-L", "-m", str(timeout), "-A", UA, url],
                       capture_output=True, text=True, timeout=timeout + 5)
    return r.stdout


def load_known_domains():
    """从本地榜单文件提取已知域名"""
    known = set()
    if os.path.exists(KNOWN_FILE):
        text = open(KNOWN_FILE, encoding="utf-8").read()
        for m in re.finditer(r'https?://([a-zA-Z0-9.-]+)', text):
            known.add(m.group(1).lower().lstrip("www."))
    return known


def load_state():
    """读取已报告过的新站(避免每天重复报)"""
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {"reported": []}


def save_state(reported):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        json.dump({"reported": sorted(set(reported))}, open(STATE_FILE, "w"))
    except Exception:
        pass


# ── 候选源 ────────────────────────────────────────────────
def candidates_from_awesome_proxy():
    r = subprocess.run(["curl", "-s", "-L", "-m", "15",
        "https://raw.githubusercontent.com/mn-api/awesome-ai-proxy/main/README.md"],
        capture_output=True, text=True, timeout=20)
    md = r.stdout
    return set(re.findall(r'https?://([a-zA-Z0-9.-]+)', md))


def candidates_from_sub2api_readme():
    r = subprocess.run(["curl", "-s", "-L", "-m", "15",
        "https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README_CN.md"],
        capture_output=True, text=True, timeout=20)
    md = r.stdout
    return set(re.findall(r'https?://([a-zA-Z0-9.-]+)', md))


def candidates_from_veridrop():
    """Veridrop 红黑榜首页收录站"""
    body = _curl("https://veridrop.org/leaderboard", 12)
    return set(re.findall(r'leaderboard/([a-zA-Z0-9.-]+)', body))


# ── 体检 ──────────────────────────────────────────────────
def check_sub2api(domain):
    site = f"https://{domain}"
    try:
        html = _curl(site + "/", 8)
        js_urls = re.findall(r'(?:src|href)="([^"]*\.js[^"]*)"', html)
        hits = set()
        for m in SUB2_PATTERN.findall(html):
            hits.add(m)
        for js in js_urls[:6]:
            if not js.startswith("http"):
                js = site.rstrip("/") + "/" + js.lstrip("/")
            for m in SUB2_PATTERN.findall(_curl(js, 5)):
                hits.add(m)
        return sorted(hits)
    except Exception:
        return []


def check_veridrop(domain):
    try:
        body = _curl(f"https://veridrop.org/leaderboard/{domain}", 10)
        m = re.search(r'(\d{2,3})/100', body)
        d = re.search(r'(优秀|良好|一般|较差|差|通过)', body)
        n = re.search(r'(\d+)\s*次独立检测', body)
        return {
            "score": m.group(1) if m else None,
            "verdict": d.group(1) if d else "未收录",
            "samples": int(n.group(1)) if n else 0,
        }
    except Exception:
        return {"score": None, "verdict": "?", "samples": 0}


def check_alive(domain):
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-L",
                        "-m", "8", f"https://{domain}/"],
        capture_output=True, text=True, timeout=12)
    return r.stdout or "ERR"


def main():
    force = "--force" in sys.argv
    known = load_known_domains()
    state = load_state()
    reported = set(state.get("reported", []))

    # 收集候选
    all_candidates = set()
    for fn in [candidates_from_awesome_proxy, candidates_from_sub2api_readme, candidates_from_veridrop]:
        try:
            all_candidates |= fn()
        except Exception:
            pass

    # 过滤: 去掉已知域名 + 非中转站域名(如 github/raw/赞助商广告域)
    noise = {"github.com", "raw.githubusercontent.com", "img.shields.io", "localhost",
             "t.me", "telegram.me", "x.com", "twitter.com", "youtube.com", "bilibili.com",
             "star-history.com", "golang.org", "vuejs.org", "docker.com", "postgresql.org",
             "redis.io", "creativecommons.org", "trendshift.io", "linux.do", "s.qiniu.com",
             "google.com", "microsoft.com", "apple.com", "cloudflare.com", "veridrop.org",
             "llmtest.cn", "mozhenzhen.com", "hvoy.ai", "helpaio.com", "apiranking.com",
             "priceai.cc", "veridrop.org", "aishare.jizhiku.net",
             "anthropic.com", "openai.com", "api.openai.com", "api.anthropic.com",
             "api.google.com", "generativelanguage.googleapis.com", "deepseek.com",
             "api.deepseek.com", "openrouter.ai", "api.openrouter.ai"}
    fresh = set()
    for d in all_candidates:
        d = d.lower().lstrip("www.")
        if d in known or d in reported or d in noise:
            continue
        if re.search(r'(github|google|microsoft|apple|amazon|cloudflare|vercel|wix|godaddy|namecheap)', d):
            continue
        if len(d) < 6 or "." not in d:
            continue
        fresh.add(d)

    if not fresh:
        if force:
            print("📡 中转站新站监控：今日无新站")
        return  # 静默

    # 限制体检数量: 优先有 Veridrop 收录的站(说明已被第三方检测), 最多 25 个
    # (先快速查 Veridrop 评分来排序, 无评分的排后面)
    def _quick_score(d):
        try:
            body = _curl(f"https://veridrop.org/leaderboard/{d}", 6)
            m = re.search(r'(\d{2,3})/100', body)
            return int(m.group(1)) if m else 0
        except Exception:
            return 0

    fresh_list = sorted(fresh)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        scores = list(ex.map(_quick_score, fresh_list))
    ranked = sorted(zip(fresh_list, scores), key=lambda x: -x[1])
    ranked = ranked[:25]
    to_check = {d for d, s in ranked if s > 0} | {d for d, s in ranked[:10]}  # 有评分的全要 + 前10个无评分候选

    # 体检新站
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {d: ex.submit(check_sub2api, d) for d in to_check}
        vd_futs = {d: ex.submit(check_veridrop, d) for d in to_check}
        alive_futs = {d: ex.submit(check_alive, d) for d in to_check}
        sub2_map = {d: futs[d].result() for d in to_check}
        vd_map = {d: vd_futs[d].result() for d in to_check}
        alive_map = {d: alive_futs[d].result() for d in to_check}

    for d in sorted(to_check):
        sub2 = sub2_map[d]
        vd = vd_map[d]
        alive = alive_map[d]
        if not sub2 and not vd.get("score"):
            continue  # 既非 Sub2API 又无评分的不报
        results.append({
            "domain": d, "alive": alive, "sub2api": bool(sub2),
            "sub2_views": sub2[:4], "veridrop": vd,
        })

    if not results:
        if force:
            print("📡 中转站新站监控：今日无有效新站")
        return

    # 输出日报
    lines = ["📡 中转站新站监控日报:"]
    sub2_sites = [r for r in results if r["sub2api"]]
    other_sites = [r for r in results if not r["sub2api"]]

    if sub2_sites:
        lines.append("")
        lines.append("## ✅ Sub2API 新站")
        for r in sorted(sub2_sites, key=lambda x: -(int(x["veridrop"]["score"]) if x["veridrop"].get("score") else 0)):
            vd = r["veridrop"]
            score = f"{vd['score']}/100" if vd["score"] else "无评分"
            cnt = f"({vd['samples']}次)" if vd["samples"] else ""
            lines.append(f"- {r['domain']} | alive={r['alive']} | Veridrop: {score} {vd['verdict']}{cnt}")

    if other_sites:
        lines.append("")
        lines.append("## 其他中转站(非Sub2API)")
        for r in sorted(other_sites, key=lambda x: -(int(x["veridrop"]["score"]) if x["veridrop"].get("score") else 0)):
            vd = r["veridrop"]
            score = f"{vd['score']}/100" if vd["score"] else "无评分"
            lines.append(f"- {r['domain']} | alive={r['alive']} | Veridrop: {score} {vd['verdict']}")

    lines.append("")
    lines.append("> 已体检可加入榜单的站, 用 check_relay_site.py 复查后决定是否收录。")

    # 记录已报告
    reported |= to_check
    save_state(reported)

    print("\n".join(lines))


if __name__ == "__main__":
    main()
