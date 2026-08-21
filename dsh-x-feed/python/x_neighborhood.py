#!/usr/bin/env python3
"""x_neighborhood.py — 邻域漫游机械层(零模型调用, TDD 开发)。

职责(用户 2026-08-14 定稿):
- 机械动作全代码化: topology 邻接(1–2 跳) / topic 同义归一 / 冷却与 explored count / 低熟悉优先排序
- 只输出「数据驱动候选 + 指标」(hop/bridge/cooldown/familiarity), 最终选题权永远在 AI
- 数据全部来自可编辑 JSON, 领域层零硬编码画像; 禁区(restricted)可配置, 不写死在领域逻辑
- 领域层纯函数无 IO; 基础设施层管文件读写/锁; 应用层编排 CLI

数据文件(默认 data/, 种子样例见 data_seeds/):
- x_interest_graph.json  {anchors:[], edges:[{from,to,hop,bridge}], restricted:[]}
- x_topic_aliases.json   {surface: canonical_id}(同义归一的查表, 发现同义属 AI)
- x_wander_state.json    {topics:{<canonical_id>:{last_explored_ts,times}}, cooldown_s}
- x_wander_candidates.json  CLI 输出(供 AI 选题)

自动路径只使用本轮显式 roots 与校验后的 edges.from/to；raw anchors/restricted/bridge
保留在文件中供审计，不进入自动候选。

用法:
  python3 x_neighborhood.py candidates [--graph data/x_interest_graph.json]
      [--aliases data/x_topic_aliases.json] [--state data/x_wander_state.json]
      [--root <surface>]... [--now <ts>] [--cooldown <s>] [--out <path>]
  python3 x_neighborhood.py record --state <path> --topic <surface>
      [--aliases <path>] [--now <ts>]
"""
import fcntl
import json
import os
import sys
import tempfile

import x_paths

DATA = x_paths.data_dir()
DEFAULT_GRAPH = os.path.join(DATA, "x_interest_graph.json")
DEFAULT_ALIASES = os.path.join(DATA, "x_topic_aliases.json")
DEFAULT_STATE = os.path.join(DATA, "x_wander_state.json")
DEFAULT_OUT = os.path.join(DATA, "x_wander_candidates.json")
DEFAULT_COOLDOWN_S = 86400  # 24h; 可被 state 文件 cooldown_s 覆盖
MAX_HOPS = 2  # 邻域漫游只输出 1–2 跳候选(架构裁决)


# ---------- 领域层: 纯函数, 无 IO ----------

def normalize_surface(s):
    """表面字 → 查表键: 小写 + 去所有空白(中英文都适用)。"""
    return "".join(str(s or "").lower().split())


def normalize_aliases(raw):
    """别名表 {surface: canonical_id} → {normalized_surface: canonical_id}。"""
    return {normalize_surface(k): str(v) for k, v in (raw or {}).items()}


def canonical_topic(alias_map, surface):
    """同义归一: 查别名表; 查不到兜底为归一后的表面字本身。不猜同义, 只查表。"""
    normalized = normalize_surface(surface)
    if not normalized:
        return None
    return (alias_map or {}).get(normalized, normalized)


def is_restricted(canonical, restricted):
    """禁区(可配置)过滤: canonical id 在 restricted 列表内 → True。"""
    return canonical in set(restricted or [])


def explored_count(ledger, canonical):
    """该 canonical topic 的历史探索次数(熟悉度底数)。"""
    return int(((ledger or {}).get("topics", {}).get(canonical, {}) or {}).get("times", 0))


def cooldown_remaining(ledger, canonical, now, cooldown_s):
    """距冷却结束剩余秒数; 未探索过/已冷却 → 0。"""
    entry = (ledger or {}).get("topics", {}).get(canonical, {}) or {}
    last_ts = entry.get("last_explored_ts")
    if not last_ts:
        return 0
    remaining = int(cooldown_s) - (int(now) - int(last_ts))
    return max(0, remaining)


def recently_explored(ledger, canonical, now, window_s):
    """近期窗口内是否探索过(近期重复拒绝, 独立于冷却)。"""
    entry = (ledger or {}).get("topics", {}).get(canonical, {}) or {}
    last_ts = entry.get("last_explored_ts")
    if not last_ts:
        return False
    return int(now) - int(last_ts) < int(window_s)


def familiarity(times, scale=5.0):
    """0~1 熟悉度指标(机械计算): 探索 5 次封顶 1.0。越低越「陌生」, 越值得漫游。"""
    return round(min(1.0, float(times) / scale), 2)


def sanitize_edges(edges):
    """保留 topology 的 from/to；忽略 hop 和 AI bridge 自由文本。"""
    safe = []
    seen = set()
    for edge in edges or []:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("from", "") or "").strip()
        target = str(edge.get("to", "") or "").strip()
        if not source or not target or (source, target) in seen:
            continue
        seen.add((source, target))
        safe.append({"from": source, "to": target})
    return safe


def sanitize_graph(graph):
    """把 raw graph 转成自动路径可用的 topology 视图，不修改原对象。"""
    return {
        "anchors": [],
        "edges": sanitize_edges((graph or {}).get("edges", [])),
        "restricted": [],
    }


def graph_nodes(edges):
    """返回 topology 中所有精确节点，不推断同义词。"""
    return {node for edge in edges or [] for node in (
        edge.get("from", ""), edge.get("to", "")) if node}


def runtime_roots(alias_map, surfaces, edges):
    """从本轮主题精确得到 topology roots；没有模糊匹配或 raw anchor 回退。"""
    nodes = graph_nodes(edges)
    roots = []
    for surface in surfaces or []:
        canonical = canonical_topic(alias_map, surface)
        if canonical in nodes and canonical not in roots:
            roots.append(canonical)
    return roots


def novelty_rank(anchors, edges, restricted, ledger, now, cooldown_s,
                 recent_window_s=None, max_hops=MAX_HOPS):
    """从显式 roots 出发 BFS 1–2 跳，输出候选+指标，不做语义判断。

    ``anchors`` 参数名为历史兼容名称，但调用者必须传入已经审核过的
    runtime roots。restricted 只供纯机制调用者显式传入；自动路径传空列表。

    输出:
      candidates: 可漫游候选(冷却 ok 且非近期重复), 按 (hop, explored_count, last_ts) 升序 → 低熟悉优先
      blocked:    被拦下的节点及原因(restricted/cooldown/recently_explored), 供 AI 解释
      recent_explorations: 近期窗口内探索过的 canonical topic 列表(去重提示)
    """
    recent_window_s = cooldown_s if recent_window_s is None else recent_window_s
    restricted_set = set(restricted or [])
    anchor_list = list(anchors or [])
    anchor_set = set(anchor_list)

    # 无向 topology；不读取 edge.hop/edge.bridge，避免旧自由文本进入材料。
    adjacency = {}
    for e in (edges or []):
        if not isinstance(e, dict):
            continue
        frm = str(e.get("from", "") or "")
        to = str(e.get("to", "") or "")
        if not frm or not to:
            continue
        adjacency.setdefault(frm, []).append(to)
        adjacency.setdefault(to, []).append(frm)

    # BFS: 记录每个可达节点的最短 hop / 来源锚点 / 桥梁 / 经由节点
    best = {}
    for anchor in anchor_list:
        if anchor in restricted_set:
            continue
        seen = {anchor}
        frontier = [(anchor, 0, None)]
        while frontier:
            node, hop, parent = frontier.pop(0)
            if hop > 0 and node not in anchor_set:
                cur = best.get(node)
                if cur is None or hop < cur["hop"]:
                    best[node] = {
                        "hop": hop, "from_anchor": anchor,
                        "bridge": f"{parent} → {node}" if parent else "",
                        "via": parent,
                    }
            if hop >= max_hops:
                continue
            for nxt in adjacency.get(node, []):
                if nxt in seen:
                    continue
                seen.add(nxt)
                frontier.append((nxt, hop + 1, node))

    candidates, blocked = [], []
    for node in sorted(best):
        info = best[node]
        times = explored_count(ledger, node)
        last_ts = ((ledger or {}).get("topics", {}).get(node, {}) or {}).get("last_explored_ts")
        base = {
            "topic": node,
            "hop": info["hop"],
            "from_anchor": info["from_anchor"],
            "via": info["via"],
            "bridge": info["bridge"],
            "explored_count": times,
            "last_explored_ts": last_ts,
            "familiarity": familiarity(times),
        }
        if node in restricted_set:
            blocked.append({**base, "reason": "restricted", "cooldown_remaining_s": 0})
            continue
        rem = cooldown_remaining(ledger, node, now, cooldown_s)
        if rem > 0:
            blocked.append({**base, "reason": "cooldown", "cooldown_remaining_s": rem})
            continue
        if recently_explored(ledger, node, now, recent_window_s):
            blocked.append({**base, "reason": "recently_explored",
                            "cooldown_remaining_s": 0, "recently_explored": True})
            continue
        candidates.append({**base, "cooldown_ok": True, "cooldown_remaining_s": 0,
                           "recently_explored": False})

    # 低熟悉优先: hop 小 → 探索少 → 更久没探索 → 字典序
    candidates.sort(key=lambda c: (c["hop"], c["explored_count"],
                                   c["last_explored_ts"] or 0, c["topic"]))
    blocked.sort(key=lambda b: (b["topic"], b["reason"]))

    recent_explorations = []
    for cid, entry in ((ledger or {}).get("topics", {}) or {}).items():
        entry = entry or {}
        last_ts = entry.get("last_explored_ts")
        if last_ts and int(now) - int(last_ts) < int(recent_window_s):
            recent_explorations.append({
                "topic": cid, "last_explored_ts": last_ts,
                "times": int(entry.get("times", 0)),
            })
    recent_explorations.sort(key=lambda r: r["last_explored_ts"])

    return {
        "candidates": candidates,
        "blocked": blocked,
        "recent_explorations": recent_explorations,
    }


# ---------- 基础设施层: 文件读写 / 锁 / 原子写 ----------

def load_json_quiet(path, default):
    """容错读 JSON; 文件缺失/损坏返回 default。"""
    if not path or not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def load_graph(path):
    """读取 raw graph；自动路径必须先调用 sanitize_graph。"""
    data = load_json_quiet(path, {}) or {}
    return {
        "anchors": list(data.get("anchors") or []),
        "edges": list(data.get("edges") or []),
        "restricted": list(data.get("restricted") or []),
    }


def load_aliases(path):
    """别名表 → 归一化键查表。"""
    return normalize_aliases(load_json_quiet(path, {}) or {})


def load_wander_state(path):
    """探索台账: {topics:{cid:{last_explored_ts,times}}, cooldown_s}。"""
    data = load_json_quiet(path, {}) or {}
    cs = data.get("cooldown_s")
    cooldown_s = int(cs) if isinstance(cs, (int, float)) else DEFAULT_COOLDOWN_S
    return {"topics": data.get("topics") or {}, "cooldown_s": cooldown_s}


def save_wander_state(path, state):
    """原子写探索台账(临时文件 + fsync + os.replace)。"""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=parent, text=True)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, ensure_ascii=False)
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


def record_exploration(state_path, canonical, now):
    """幂等记录一次探索: times+1, last_explored_ts=now; flock + 原子写。"""
    if not canonical:
        return {"topic": None, "last_explored_ts": None, "times": 0}
    lock_path = state_path + ".lock"
    os.makedirs(os.path.dirname(os.path.abspath(state_path)), exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        state = load_wander_state(state_path)
        entry = state["topics"].setdefault(canonical, {"last_explored_ts": None, "times": 0})
        entry["last_explored_ts"] = int(now)
        entry["times"] = int(entry.get("times", 0)) + 1
        save_wander_state(state_path, state)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    return {"topic": canonical, "last_explored_ts": entry["last_explored_ts"],
            "times": entry["times"]}


def record_exploration_for_surface(aliases_path, state_path, surface, now):
    """搜索工具钩子: 表面字 → canonical(查别名表) → 记台账。"""
    canonical = canonical_topic(load_aliases(aliases_path), surface)
    return record_exploration(state_path, canonical, now)


# ---------- 应用层: 编排 ----------

def compute_candidates(graph_path, aliases_path, state_path, now, cooldown_s=None,
                       root_surfaces=None, roots=None):
    """读数据文件，使用显式 roots 计算安全 topology 邻域。

    ``roots`` 是已经确定的 canonical roots；``root_surfaces`` 只通过 aliases
    做精确归一。两者均为空时返回空候选，绝不回退到 raw anchors。
    """
    graph = load_graph(graph_path)
    safe_graph = sanitize_graph(graph)
    state = load_wander_state(state_path)
    cs = int(cooldown_s) if cooldown_s is not None else state["cooldown_s"]
    aliases = load_aliases(aliases_path)
    safe_roots = list(roots or [])
    if roots is None:
        safe_roots = runtime_roots(aliases, root_surfaces or [], safe_graph["edges"])
    else:
        safe_roots = [root for root in safe_roots if root in graph_nodes(safe_graph["edges"])]
    result = novelty_rank(safe_roots, safe_graph["edges"], [], state, now, cs)
    result.update({
        "generated_ts": int(now),
        "config_loaded": bool(graph_path) and os.path.exists(graph_path),
        "cooldown_s": cs,
        "roots": safe_roots,
    })
    return result


# ---------- CLI ----------

def _write_out(path, data):
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


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    cmd = args[0]
    if cmd == "candidates":
        graph = aliases = state = out = None
        now = cooldown = None
        roots = []
        i = 1
        while i < len(args):
            a = args[i]
            if a == "--graph" and i + 1 < len(args):
                graph = args[i + 1]; i += 2
            elif a == "--aliases" and i + 1 < len(args):
                aliases = args[i + 1]; i += 2
            elif a == "--state" and i + 1 < len(args):
                state = args[i + 1]; i += 2
            elif a == "--now" and i + 1 < len(args):
                now = int(args[i + 1]); i += 2
            elif a == "--cooldown" and i + 1 < len(args):
                cooldown = int(args[i + 1]); i += 2
            elif a == "--out" and i + 1 < len(args):
                out = args[i + 1]; i += 2
            elif a == "--root" and i + 1 < len(args):
                roots.append(args[i + 1]); i += 2
            else:
                i += 1
        now = now if now is not None else int(__import__("time").time())
        result = compute_candidates(graph or DEFAULT_GRAPH, aliases or DEFAULT_ALIASES,
                                    state or DEFAULT_STATE, now, cooldown,
                                    root_surfaces=roots)
        if out:
            _write_out(out, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    elif cmd == "record":
        state = topic = aliases = None
        now = None
        i = 1
        while i < len(args):
            a = args[i]
            if a == "--state" and i + 1 < len(args):
                state = args[i + 1]; i += 2
            elif a == "--topic" and i + 1 < len(args):
                topic = args[i + 1]; i += 2
            elif a == "--aliases" and i + 1 < len(args):
                aliases = args[i + 1]; i += 2
            elif a == "--now" and i + 1 < len(args):
                now = int(args[i + 1]); i += 2
            else:
                i += 1
        if not state or not topic:
            print("用法: x_neighborhood.py record --state <path> --topic <surface> [--aliases <path>] [--now <ts>]",
                  file=sys.stderr)
            return 1
        now = now if now is not None else int(__import__("time").time())
        result = record_exploration_for_surface(aliases or DEFAULT_ALIASES, state, topic, now)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
