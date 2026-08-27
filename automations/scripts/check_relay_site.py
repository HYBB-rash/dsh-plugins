#!/usr/bin/env python3
"""check_relay_site — 中转站快速体检

用法:
  python3 check_relay_site.py runapi.co            # 查单个站
  python3 check_relay_site.py a.com b.com c.com    # 批量查

输出: 每个站的 Veridrop 独立检测评分 + Sub2API 指纹判定 + 基础连通性
"""
import sys
import re
import os
import json
import subprocess
import concurrent.futures

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"

# Sub2API 独有视图指纹
SUB2_PATTERN = re.compile(
    r'(RedeemView|AvailableChannelsView|AdminPaymentDashboardView|ChannelMonitorView|'
    r'SetupWizardView|ProxiesView|LinuxDoCallbackView|VipServiceView|BatchImageGuideView|'
    r'AdminAffiliateInvitesView|PublicTransitView|ModelPlazaView|OidcCallbackView|'
    r'DingTalkCallbackView|PromptAuditView|RiskControlView|AirwallexPaymentView|'
    r'WechatPaymentCallbackView|KeyUsageView)')

# NewAPI/OneAPI 特征(用于区分)
NEWAPI_PATTERN = re.compile(
    r'(channel[_-]?test|model[_-]?mapping|/api/token/|/api/channel/|'
    r'one-api|new-api|newapi)')


def _curl(url, timeout=10):
    r = subprocess.run(["curl", "-s", "-L", "-m", str(timeout), "-A", UA, url],
                       capture_output=True, text=True, timeout=timeout + 5)
    return r.stdout


def check_sub2api(domain):
    """抓首页 JS 判断是否 Sub2API"""
    site = f"https://{domain}" if not domain.startswith("http") else domain
    try:
        html = _curl(site + "/", 8)
        js_urls = re.findall(r'(?:src|href)="([^"]*\.js[^"]*)"', html)
        hits = set()
        for m in SUB2_PATTERN.findall(html):
            hits.add(m)
        for js in js_urls[:8]:
            if not js.startswith("http"):
                js = site.rstrip("/") + "/" + js.lstrip("/")
            body = _curl(js, 6)
            for m in SUB2_PATTERN.findall(body):
                hits.add(m)
        return sorted(hits)
    except Exception:
        return []


def check_veridrop(domain):
    """Veridrop 独立检测评分"""
    try:
        body = _curl(f"https://veridrop.org/leaderboard/{domain}", 10)
        m = re.search(r'(\d{2,3})/100', body)
        d = re.search(r'(优秀|良好|一般|较差|差|通过)', body)
        n = re.search(r'(\d+)\s*次独立检测', body)
        recent = re.search(r'最近一次检测[：:]\s*([\d-]+)', body)
        return {
            "score": m.group(1) if m else None,
            "verdict": d.group(1) if d else "未收录",
            "samples": int(n.group(1)) if n else 0,
            "last_check": recent.group(1) if recent else None,
        }
    except Exception:
        return {"score": None, "verdict": "?", "samples": 0, "last_check": None}


def check_alive(domain):
    """连通性"""
    site = f"https://{domain}" if not domain.startswith("http") else domain
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-L",
                        "-m", "8", site + "/"], capture_output=True, text=True, timeout=12)
    return r.stdout or "ERR"


def check_one(domain):
    domain = domain.strip().rstrip("/")
    if domain.startswith(("http://", "https://")):
        domain = re.sub(r'^https?://', '', domain).split("/")[0]
    sub2 = check_sub2api(domain)
    vd = check_veridrop(domain)
    alive = check_alive(domain)
    return {
        "domain": domain,
        "alive": alive,
        "sub2api": bool(sub2),
        "sub2_views": sub2[:6],
        "veridrop": vd,
    }


if __name__ == "__main__":
    domains = [d for d in sys.argv[1:] if d.strip()]
    if not domains:
        print("用法: check_relay_site.py <域名> [<域名>...]")
        sys.exit(1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(domains))) as ex:
        results = list(ex.map(check_one, domains))

    # 输出
    for r in results:
        vd = r["veridrop"]
        score = f"{vd['score']}/100" if vd["score"] else "无评分"
        verdict = vd["verdict"]
        samples = f"({vd['samples']}次检测)" if vd["samples"] else ""
        sub2 = "✅ Sub2API" if r["sub2api"] else "❌ 非Sub2API"
        print(f"{r['domain']:<28} alive={r['alive']:<4} {sub2:<12} "
              f"Veridrop: {score} {verdict}{samples}")
        if r["sub2_views"]:
            print(f"   指纹: {', '.join(r['sub2_views'])}")
