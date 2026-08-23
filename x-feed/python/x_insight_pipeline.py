#!/usr/bin/env python3
"""x_insight_pipeline.py — X 洞察机械管道(零模型调用, TDD 开发)。

职责(用户 2026-08-12 定稿):
- 机械动作全代码化: 检查 Chrome / 时间线收集 / 决策包(insight_engine) / 最近推文全量输出
- 留给 AI 语义层(本脚本不做): ① 高优主题判断(LLM 推理痕迹等, 语义识别) ② 漫游决策
  ③ 话题聚焦选择 ④ 中文总结
- 输出 data/x_insight_package.json: {decision, recent_items, ts}
  AI 只需读这一个文件即可决策+总结, 无需自己跑收集/分析。

用法:
  python3 x_insight_pipeline.py [--rolls 8] [--sleep 2] [--recent 30] [--cap-items 20] [--out <path>] [--no-collect]
"""
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit

import x_browser
import x_neighborhood
import x_paths
import x_timeline_dedup

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = x_paths.data_dir()
DEFAULT_OUT = os.path.join(DATA, "x_insight_package.json")
TIMELINE = os.path.join(DATA, "x_timeline.jsonl")
LAST_THEME = os.path.join(DATA, "x_last_theme.json")
DEFAULT_SHOWN = os.path.join(DATA, "x_shown.json")
COLLECTION_DIR = os.path.join(DATA, "x_collections")
PIPELINE_LOCK = os.path.join(DATA, ".x_insight_pipeline.lock")
EXPLORE_DIR = os.path.join(DATA, "x_explore")
EXPLORE_ITEMS = os.path.join(DATA, "x_explore_items.jsonl")
WANDER_STATE = os.path.join(DATA, "x_wander_state.json")
INTEREST_GRAPH = os.path.join(DATA, "x_interest_graph.json")
TOPIC_ALIASES = os.path.join(DATA, "x_topic_aliases.json")


def canonical_url(url):
    """Return a stable X URL for display-layer deduplication.

    Query strings and fragments are tracking/UI state, not tweet identity.
    twitter.com is normalized to x.com while the original URL remains in the
    item used for display.
    """
    if not url:
        return ""
    raw = str(url).strip()
    try:
        parsed = urlsplit(raw)
        if not parsed.netloc:
            return raw.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        host = (parsed.hostname or "").lower()
        if host in {"twitter.com", "www.twitter.com", "mobile.twitter.com"}:
            host = "x.com"
        path = (parsed.path or "").rstrip("/")
        return urlunsplit(("https", host, path, "", "", ""))
    except ValueError:
        return raw.split("?", 1)[0].split("#", 1)[0].rstrip("/")


def tweet_id(item_or_url):
    """Extract the numeric X status id when possible."""
    value = item_or_url
    if isinstance(item_or_url, dict):
        value = item_or_url.get("id") or item_or_url.get("url") or ""
        url = item_or_url.get("url") or ""
    else:
        url = str(item_or_url or "")
    text = str(value or "")
    if "/status/" in url:
        text = url.split("/status/", 1)[1]
    text = text.split("?", 1)[0].split("#", 1)[0].strip("/")
    if "/" in text:
        text = text.split("/", 1)[0]
    return text if text.isdigit() else ""


def item_key(item):
    """Stable identity key: tweet id first, canonical URL as fallback."""
    ident = tweet_id(item)
    if ident:
        return f"id:{ident}"
    return f"url:{canonical_url(item.get('url', '') if isinstance(item, dict) else item)}"


def _shown_state(shown_path):
    """Read both current and legacy shown ledgers into normalized sets."""
    state = {"urls": set(), "ids": set()}
    if not shown_path or not os.path.exists(shown_path):
        return state
    try:
        with open(shown_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError, TypeError):
        return state
    for url in data.get("urls", []) if isinstance(data, dict) else []:
        normalized = canonical_url(url)
        if normalized:
            state["urls"].add(normalized)
        ident = tweet_id(url)
        if ident:
            state["ids"].add(ident)
    for ident in data.get("ids", []) if isinstance(data, dict) else []:
        if str(ident):
            state["ids"].add(str(ident))
    return state


def _is_shown(item, state):
    ident = tweet_id(item)
    return (ident and ident in state["ids"]) or canonical_url(item.get("url", "")) in state["urls"]


def _atomic_json_write(path, data):
    """Write JSON without exposing a partially-written package/ledger."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=parent, text=True)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


@contextmanager
def pipeline_lock(path=None):
    """Serialize browser navigation and shown-ledger selection per source."""
    import fcntl
    path = path or os.path.join(DATA, ".x_insight_pipeline.lock")
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    with open(path, "w") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("X 洞察管道已有另一轮运行中")
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def ensure_chrome():
    """确认 9222 调试 Chrome/CDP 可用, 挂了自动恢复。返回 bool。"""
    try:
        x_browser.ensure_cdp()
        return True
    except x_browser.BrowserRecoveryError:
        return False


def run_collector(rolls=8, sleep_s=2, batch_out=None):
    """跑时间线收集器, 返回结果 dict。"""
    try:
        cmd = [sys.executable, os.path.join(HERE, "x_timeline_collector.py"),
               "--rolls", str(rolls), "--sleep", str(sleep_s)]
        if batch_out:
            cmd.extend(["--batch-out", batch_out])
        r = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=300)
        lines = r.stdout.strip().splitlines()
        last = lines[-1] if lines else "{}"
        try:
            result = json.loads(last)
        except Exception:
            return {"ok": False, "err": r.stdout[-300:] + r.stderr[-300:]}
        if r.returncode != 0 or not result.get("ok"):
            return {
                "ok": False,
                "err": result.get("err") or result.get("detail") or r.stderr[-500:],
                "error_class": result.get("error_class", "collector_failed"),
                "state": result.get("state", "COLLECTING"),
                "retryable": result.get("retryable", False),
                "collector": result,
            }
        if batch_out:
            result["batch_path"] = batch_out
            result["items"] = load_items(batch_out)
        return result
    except Exception as e:
        return {"ok": False, "err": str(e)}


def run_engine_analyze(items_path, last_path, recent=30):
    """跑 insight_engine 出决策包, 返回 dict。"""
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(HERE, "insight_engine.py"),
             "analyze", "--items", items_path, "--last", last_path,
             "--recent", str(recent)],
            capture_output=True, text=True, timeout=60)
        try:
            return json.loads(r.stdout.strip())
        except Exception:
            return {"err": r.stdout[-300:] + r.stderr[-300:]}
    except Exception as e:
        return {"err": str(e)}


def load_items(path):
    """读同构 jsonl(容错), 返回 list[dict]。"""
    items = []
    if not path or not os.path.exists(path):
        return items
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if not all(k in d for k in ("id", "url", "text")):
                continue
            items.append(d)
    return items


def recent_items(path, n=25):
    """读最近 n 条推文(完整 text 保留, 供 AI 语义判断高优), 无文件返回 []。"""
    items = load_items(path)
    return items[-n:] if n > 0 else items


def mark_shown(shown_path, urls):
    """记录已展示的推文 URL(展示层去重, 避免重复推送)。"""
    import fcntl
    lock_path = shown_path + ".lock"
    os.makedirs(os.path.dirname(os.path.abspath(shown_path)), exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        state = _shown_state(shown_path)
        for url in urls or []:
            normalized = canonical_url(url)
            if normalized:
                state["urls"].add(normalized)
            ident = tweet_id(url)
            if ident:
                state["ids"].add(ident)
        _atomic_json_write(shown_path, {
            "urls": sorted(state["urls"]),
            "ids": sorted(state["ids"]),
        })
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def filter_fresh(items, shown_path):
    """过滤掉已展示过的推文, 返回未展示的(fresh)。无文件时全量返回。"""
    state = _shown_state(shown_path)
    return [it for it in items if not _is_shown(it, state)]


def new_items_since(before_ids, after_items):
    """Return items whose raw ids were not in a pre-collection snapshot."""
    before = {str(value) for value in (before_ids or set())}
    result = []
    for item in after_items:
        raw_id = str(item.get("id", ""))
        if raw_id not in before:
            result.append(item)
    return result


def select_package_items(current_items, history_items, shown_path, cap_items=20):
    """Select current-batch fresh items first, then fresh history as fallback."""
    if cap_items <= 0:
        return []
    state = _shown_state(shown_path)
    selected = []
    seen = set()
    for pool in (current_items or [], reversed(history_items or [])):
        for item in pool:
            key = item_key(item)
            if key in seen or _is_shown(item, state):
                continue
            seen.add(key)
            selected.append(item)
            if len(selected) >= cap_items:
                return selected
    return selected


def current_collection_items(current_items, shown_path):
    """Return this run's complete fresh collection without planner limits.

    The collection is deliberately projected from ``current_items`` only:
    history fallback belongs to ``recent_items`` and must not become source
    evidence for the current run.  Stable identity deduplication keeps the
    richer record, while the shown ledger remains a mechanical exclusion.
    """
    state = _shown_state(shown_path)
    fresh_items = [
        item for item in (current_items or [])
        if not _is_shown(item, state)
    ]
    collection, _ = x_timeline_dedup.deduplicate_records(fresh_items)
    return collection


def _write_items_file(items):
    os.makedirs(DATA, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix="x-analysis-", suffix=".jsonl", dir=DATA, text=True)
    with os.fdopen(fd, "w") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    return path


def build_package(items_path=TIMELINE, last_path=LAST_THEME, recent=30, cap_items=20,
                  seed=None, shown_path=None, current_items=None, delivery_id=None,
                  graph_path=None, aliases_path=None, state_path=None, wander_now=None):
    """组装 AI 决策支持包: {decision, recent_items, shown_count, ts}。

    空采集批次(collection_status="empty")不从不相关历史补位伪装为本轮新内容;
    decision 保持契约并反映 0 条。graph_path/aliases_path/state_path 提供时,
    附上机械层邻域候选(数据驱动 1–2 跳, 选题权在 AI)。
    """
    history = load_items(items_path)
    collection_status = "legacy"
    analysis_path = items_path
    temp_path = None
    if current_items is None:
        # 显式分析既有时间线(--no-collect / 兼容模式)
        selected = select_package_items(None, history, shown_path, cap_items)
        analysis_items = selected or recent_items(items_path, recent)
    else:
        if not current_items:
            # 空批次: 禁止用旧主时间线/探索历史补位伪装为本轮新内容
            selected = []
            analysis_items = []
            collection_status = "empty"
        else:
            selected = select_package_items(current_items, history, shown_path, cap_items)
            analysis_items = current_items
            collection_status = "ok"
        temp_path = _write_items_file(analysis_items)
        analysis_path = temp_path
    try:
        decision = run_engine_analyze(analysis_path, last_path, recent)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
    if collection_status == "empty":
        # 无新数据 → 决策包反映 0 条; 漫游与否由 AI 基于自身判断决定, 代码不硬推
        decision["recent_count"] = 0
        decision["candidates"] = []
        decision["wander_suggested"] = False
    package_items, _ = x_timeline_dedup.deduplicate_records(selected)
    state = _shown_state(shown_path)
    shown_count = sum(1 for item in history if _is_shown(item, state))
    delivery_id = delivery_id or f"x-{int(time.time())}-{uuid.uuid4().hex[:10]}"
    pkg = {
        "decision": decision,
        "recent_items": package_items,
        "selected_urls": [item.get("url", "") for item in package_items if item.get("url")],
        "selected_ids": [tweet_id(item) for item in package_items if tweet_id(item)],
        "shown_count": shown_count,
        "delivery_id": delivery_id,
        "collection_status": collection_status,
        "ts": int(time.time()),
    }
    if current_items is not None:
        pkg["current_collection"] = current_collection_items(current_items, shown_path)
    if graph_path is not None:
        wnow = int(wander_now) if wander_now is not None else int(time.time())
        root_surfaces = []
        if decision.get("top_theme"):
            root_surfaces.append(decision["top_theme"])
        root_surfaces.extend((decision.get("themes") or {}).keys())
        cand = x_neighborhood.compute_candidates(
            graph_path, aliases_path, state_path, now=wnow,
            root_surfaces=root_surfaces)
        pkg["explore_candidates"] = cand["candidates"]
        pkg["wander"] = {
            "config_loaded": cand["config_loaded"],
            "cooldown_s": cand["cooldown_s"],
            "blocked": cand["blocked"],
            "recent_explorations": cand["recent_explorations"],
        }
    return pkg


def record_delivery(package_path, shown_path, urls, allow_out_of_package=False):
    """真实投递成功后登记: 只登记实际发送成功的 URL 子集, 幂等(set 语义)。

    机械护栏(README fail-loud 契约): 人工 mark-delivered 默认只允许登记
    selected_urls 子集; 输入含任一包外 URL → 整个调用 ok:false 且不改 shown/package。
    confirm-prepared 回执链路(allow_out_of_package=True)例外: pending_urls 是
    agent 草稿实际采用并已 prepare 登记的 URL, 投递成功后必须全部登记 shown,
    否则下一轮重复投递(2026-08-14 修复)。投递失败请调用 mark_failed。
    """
    urls = [url for url in (urls or []) if url]
    allowed = None
    package = None
    if package_path and os.path.exists(package_path):
        package = json.load(open(package_path))
        sel = package.get("selected_urls") or []
        if sel and not allow_out_of_package:
            allowed = {canonical_url(u) for u in sel}
    accepted, rejected = [], []
    for url in urls:
        if allowed is not None and canonical_url(url) not in allowed:
            rejected.append(url)
        else:
            accepted.append(url)
    if rejected:
        # fail-loud: 任一包外 URL → 整个调用失败, shown/package 均不修改
        return {"ok": False, "marked": 0, "rejected": rejected,
                "reason": "out_of_package_urls"}
    if not accepted:
        return {"ok": False, "marked": 0, "rejected": rejected,
                "reason": "no_deliverable_urls"}
    mark_shown(shown_path, accepted)
    if package is not None:
        delivered = list(dict.fromkeys(package.get("delivered_urls", []) + accepted))
        package["delivered_urls"] = delivered
        package["delivery_status"] = "delivered"
        package["delivered_at"] = int(time.time())
        package.pop("pending_urls", None)
        _atomic_json_write(package_path, package)
    return {"ok": True, "marked": len(accepted), "rejected": rejected}


def prepare_delivery(package_path, urls, cron_job_id=None, now=None,
                     pending_theme=None):
    """在最终回复前暂存拟投递 URL；不写 shown，等待 cron 真实投递回执。

    AI 语义层是选题最终决策者：草稿实际采用的 URL 无论是否在 selected_urls，
    一律计入 pending_urls（否则该 URL 永不登记 shown，下一轮重复投递）。
    """
    if pending_theme is not None and (
            not isinstance(pending_theme, str)
            or pending_theme.strip() != pending_theme
            or not pending_theme
            or len(pending_theme) > 128):
        return {"ok": False, "marked": 0, "reason": "invalid_pending_theme"}
    if not package_path or not os.path.exists(package_path):
        return {"ok": False, "marked": 0, "reason": "package_not_found"}
    lock_path = os.path.join(os.path.dirname(os.path.abspath(package_path)),
                             ".x_insight_pipeline.lock")
    with pipeline_lock(lock_path):
        package = json.load(open(package_path))
        pending, seen = [], set()
        for url in (urls or []):
            if not url:
                continue
            canonical = canonical_url(url)
            if canonical not in seen:
                pending.append(url)
                seen.add(canonical)
        package["pending_urls"] = pending
        if pending_theme is None:
            package.pop("pending_theme", None)
        else:
            package["pending_theme"] = pending_theme
        package["delivery_status"] = "prepared"
        package["prepared_at"] = int(time.time() if now is None else now)
        if cron_job_id:
            package["delivery_cron_job_id"] = cron_job_id
        _atomic_json_write(package_path, package)
    return {"ok": True, "prepared": len(pending), "rejected": []}


def confirm_prepared_delivery(package_path, shown_path, delivery_status,
                              cron_job_id=None, last_theme_path=None):
    """消费 cron 回执：仅 delivered 才登记 pending_urls；其他状态只标失败。"""
    if not package_path or not os.path.exists(package_path):
        return {"ok": True, "noop": True, "reason": "package_not_found"}
    lock_path = os.path.join(os.path.dirname(os.path.abspath(package_path)),
                             ".x_insight_pipeline.lock")
    with pipeline_lock(lock_path):
        package = json.load(open(package_path))
        if package.get("delivery_status") != "prepared":
            return {"ok": True, "noop": True, "reason": "not_prepared"}
        expected_job = package.get("delivery_cron_job_id")
        if expected_job and cron_job_id and expected_job != cron_job_id:
            return {"ok": True, "noop": True, "reason": "cron_job_mismatch"}
        pending = package.get("pending_urls") or []
        if delivery_status != "delivered":
            package["delivery_status"] = "failed"
            package["failed_at"] = int(time.time())
            package.pop("pending_urls", None)
            package.pop("pending_theme", None)
            _atomic_json_write(package_path, package)
            return {"ok": True, "status": "failed"}
        if pending:
            # pending_urls 是 agent 草稿实际采用的 URL（prepare 阶段已登记），
            # 回执 delivered 后全部登记 shown，不再受 selected_urls 白名单限制。
            mark_shown(shown_path, pending)
        pending_theme = package.get("pending_theme")
        if pending_theme:
            theme_path = last_theme_path or os.path.join(
                os.path.dirname(os.path.abspath(package_path)), "x_last_theme.json")
            _atomic_json_write(theme_path, {"theme": pending_theme})
        delivered = list(dict.fromkeys(package.get("delivered_urls", []) + pending))
        package["delivered_urls"] = delivered
        package["delivery_status"] = "delivered"
        package["delivered_at"] = int(time.time())
        package.pop("pending_urls", None)
        package.pop("pending_theme", None)
        _atomic_json_write(package_path, package)
        return {"ok": True, "marked": len(pending), "rejected": []}


def mark_failed(package_path):
    """投递失败: 只标记 package delivery_status=failed, 不动 shown ledger。"""
    if package_path and os.path.exists(package_path):
        package = json.load(open(package_path))
        package["delivery_status"] = "failed"
        package["failed_at"] = int(time.time())
        package.pop("pending_urls", None)
        package.pop("pending_theme", None)
        _atomic_json_write(package_path, package)
    return {"ok": True, "status": "failed"}


def delivery_receipt_pending(package_path):
    """未决投递保护(落地指南 §7.3): 目标 package 已是 prepared 时返回 True。

    原因: Telegram 已接收但进程在本地终态持久化前崩溃时, 任何系统都无法
    凭空知道消息是否真正到达。此时宁可暂停一轮, 也不要覆盖 pending 后再次
    把同一批内容发出来。损坏/缺失/已终态的 package 不视为 pending。
    """
    if not package_path or not os.path.exists(package_path):
        return False
    try:
        with open(package_path) as f:
            package = json.load(f)
    except (OSError, ValueError, TypeError):
        return False
    return package.get("delivery_status") == "prepared"


def verify_delivery(package_path, shown_path):
    """机械护栏: 校验 selected_urls 是否全部已投递(以 x_shown.json 为唯一真源)。"""
    package = {}
    if package_path and os.path.exists(package_path):
        package = json.load(open(package_path))
    sel = [url for url in (package.get("selected_urls") or []) if url]
    state = _shown_state(shown_path)
    missing = []
    for url in sel:
        ident = tweet_id(url)
        if canonical_url(url) in state["urls"] or (ident and ident in state["ids"]):
            continue
        missing.append(url)
    return {"selected": len(sel), "delivered": len(sel) - len(missing), "missing": missing}


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    rolls, sleep_s, recent, cap, out = 8, 2, 30, 20, DEFAULT_OUT
    no_collect = False
    shown_path = os.path.join(DATA, "x_shown.json")
    batch_out = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--rolls" and i + 1 < len(args):
            rolls = int(args[i + 1]); i += 2
        elif a == "--sleep" and i + 1 < len(args):
            sleep_s = float(args[i + 1]); i += 2
        elif a == "--recent" and i + 1 < len(args):
            recent = int(args[i + 1]); i += 2
        elif a == "--cap-items" and i + 1 < len(args):
            cap = int(args[i + 1]); i += 2
        elif a == "--out" and i + 1 < len(args):
            out = args[i + 1]; i += 2
        elif a == "--no-collect":
            no_collect = True; i += 1
        elif a == "--shown" and i + 1 < len(args):
            shown_path = args[i + 1]; i += 2
        elif a == "--batch-out" and i + 1 < len(args):
            batch_out = args[i + 1]; i += 2
        else:
            i += 1

    # 未决投递保护(§7.3): 目标 package 仍是 prepared 时, 新一轮主 pipeline
    # 必须 fail closed——不打开浏览器、不收集、不修改 timeline/shown/package。
    if delivery_receipt_pending(out):
        print(json.dumps({
            "ok": False,
            "error_class": "delivery_receipt_pending",
        }, ensure_ascii=False))
        return 4

    try:
        with pipeline_lock(os.path.join(DATA, ".x_insight_pipeline.lock")):
            current_items = None
            delivery_id = f"x-{int(time.time())}-{uuid.uuid4().hex[:10]}"
            if not no_collect:
                if not ensure_chrome():
                    print(json.dumps({"ok": False, "state": "CDP_READY",
                                      "error_class": "browser_unavailable",
                                      "retryable": True,
                                      "detail": "Chrome/CDP did not become ready"}, ensure_ascii=False))
                    return 2
                if not batch_out:
                    collection_dir = os.path.join(DATA, "x_collections")
                    os.makedirs(collection_dir, exist_ok=True)
                    batch_out = os.path.join(collection_dir, delivery_id + ".jsonl")
                result = run_collector(rolls, sleep_s, batch_out=batch_out)
                if not result.get("ok"):
                    print(json.dumps({
                        "ok": False,
                        "err": result.get("err", "collector failed"),
                    }, ensure_ascii=False))
                    return 2
                current_items = result.get("items", [])

            pkg = build_package(
                items_path=os.path.join(DATA, "x_timeline.jsonl"),
                last_path=os.path.join(DATA, "x_last_theme.json"),
                recent=recent,
                cap_items=cap,
                shown_path=shown_path,
                current_items=current_items,
                delivery_id=delivery_id,
                graph_path=os.path.join(DATA, "x_interest_graph.json"),
                aliases_path=os.path.join(DATA, "x_topic_aliases.json"),
                state_path=os.path.join(DATA, "x_wander_state.json"),
            )
            pkg["collection_batch"] = batch_out
            pkg["collection_count"] = len(current_items) if current_items is not None else None
            _atomic_json_write(out, pkg)
            print(json.dumps({"ok": True, "out": out, "delivery_id": pkg["delivery_id"],
                              "collection_count": pkg["collection_count"],
                              "selected_count": len(pkg["recent_items"]), "ts": pkg["ts"]},
                         ensure_ascii=False))
            return 0
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "err": str(exc)}, ensure_ascii=False))
        return 3


def _mark_shown_cli(args):
    shown_path = DEFAULT_SHOWN
    package_path = None
    urls = []
    i = 1
    while i < len(args):
        if args[i] == "--shown" and i + 1 < len(args):
            shown_path = args[i + 1]; i += 2
        elif args[i] == "--package" and i + 1 < len(args):
            package_path = args[i + 1]; i += 2
        elif args[i] in ("--url", "--urls"):
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                urls.append(args[i]); i += 1
        else:
            i += 1
    if package_path and not urls:
        print("mark-shown 要求 --url/--urls，避免把未实际投递的候选误记为已展示", file=sys.stderr)
        return 1
    if not urls:
        print("用法: x_insight_pipeline.py mark-shown --package <包> --urls <url...>", file=sys.stderr)
        return 1
    result = record_delivery(package_path, shown_path, urls)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def _mark_delivered_cli(args):
    """面向真实投递方的登记 CLI: 只登记发送成功 URL 子集; 失败用 --status failed。"""
    shown_path = DEFAULT_SHOWN
    package_path = None
    status = "delivered"
    urls = []
    i = 1
    while i < len(args):
        if args[i] == "--shown" and i + 1 < len(args):
            shown_path = args[i + 1]; i += 2
        elif args[i] == "--package" and i + 1 < len(args):
            package_path = args[i + 1]; i += 2
        elif args[i] == "--status" and i + 1 < len(args):
            status = args[i + 1]; i += 2
        elif args[i] in ("--url", "--urls"):
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                urls.append(args[i]); i += 1
        else:
            i += 1
    if status == "failed":
        print(json.dumps(mark_failed(package_path), ensure_ascii=False))
        return 0
    if package_path and not urls:
        print("mark-delivered 要求 --url/--urls(发送成功的 URL 子集); 失败请用 --status failed",
              file=sys.stderr)
        return 1
    result = record_delivery(package_path, shown_path, urls)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def _verify_delivery_cli(args):
    shown_path = DEFAULT_SHOWN
    package_path = None
    i = 1
    while i < len(args):
        if args[i] == "--shown" and i + 1 < len(args):
            shown_path = args[i + 1]; i += 2
        elif args[i] == "--package" and i + 1 < len(args):
            package_path = args[i + 1]; i += 2
        else:
            i += 1
    if not package_path:
        print("用法: x_insight_pipeline.py verify-delivery --package <包> --shown <shown>",
              file=sys.stderr)
        return 1
    result = verify_delivery(package_path, shown_path)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("missing") == [] else 1


def _prepare_delivery_cli(args):
    package_path = None
    cron_job_id = None
    pending_theme = None
    last_theme_path = None
    urls = []
    i = 1
    while i < len(args):
        if args[i] == "--package" and i + 1 < len(args):
            package_path = args[i + 1]; i += 2
        elif args[i] == "--cron-job-id" and i + 1 < len(args):
            cron_job_id = args[i + 1]; i += 2
        elif args[i] == "--pending-theme" and i + 1 < len(args):
            pending_theme = args[i + 1]; i += 2
        elif args[i] == "--last-theme" and i + 1 < len(args):
            last_theme_path = args[i + 1]; i += 2
        elif args[i] in ("--url", "--urls"):
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                urls.append(args[i]); i += 1
        else:
            i += 1
    # last_theme_path is intentionally accepted at the CLI boundary so the
    # prepare/confirm commands carry one explicit run-local state path; prepare
    # itself never writes it.
    _ = last_theme_path
    result = prepare_delivery(package_path, urls, cron_job_id=cron_job_id,
                              pending_theme=pending_theme)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def _confirm_prepared_cli(args):
    package_path = None
    shown_path = DEFAULT_SHOWN
    cron_job_id = None
    last_theme_path = None
    status = "unknown"
    i = 1
    while i < len(args):
        if args[i] == "--package" and i + 1 < len(args):
            package_path = args[i + 1]; i += 2
        elif args[i] == "--shown" and i + 1 < len(args):
            shown_path = args[i + 1]; i += 2
        elif args[i] == "--cron-job-id" and i + 1 < len(args):
            cron_job_id = args[i + 1]; i += 2
        elif args[i] == "--last-theme" and i + 1 < len(args):
            last_theme_path = args[i + 1]; i += 2
        elif args[i] == "--status" and i + 1 < len(args):
            status = args[i + 1]; i += 2
        else:
            i += 1
    if last_theme_path is None and package_path:
        last_theme_path = os.path.join(
            os.path.dirname(os.path.abspath(package_path)), "x_last_theme.json")
    result = confirm_prepared_delivery(
        package_path, shown_path, status, cron_job_id=cron_job_id,
        last_theme_path=last_theme_path)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    first = sys.argv[1:2]
    if first == ["mark-shown"]:
        sys.exit(_mark_shown_cli(sys.argv[1:]))
    if first == ["mark-delivered"]:
        sys.exit(_mark_delivered_cli(sys.argv[1:]))
    if first == ["verify-delivery"]:
        sys.exit(_verify_delivery_cli(sys.argv[1:]))
    if first == ["prepare-delivery"]:
        sys.exit(_prepare_delivery_cli(sys.argv[1:]))
    if first == ["confirm-prepared"]:
        sys.exit(_confirm_prepared_cli(sys.argv[1:]))
    sys.exit(main())
