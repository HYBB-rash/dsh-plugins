#!/usr/bin/env python3
"""insight_engine.py — 通用信息流洞察引擎(多数据源)。

架构(整洁架构):
- 领域层(纯函数): Item 统一模型 / classify() 主题分类(关键词表可注入) / roll() 随机数
- 应用层: analyze() 输出「决策支持数据包」(统计+信号+候选, 不含最终决策)
         set_theme() 状态读写(按数据源路径隔离)
- 基础设施: load_items() jsonl 读取 / CLI 入口

设计原则(用户 2026-08-12 定稿):
- 固定动作(统计/刷屏检测/连续同质/30%随机/候选抽取/状态读写) → 代码化, 确定性、零 token
- 漫游决策(要不要逛/逛哪/怎么逛) → 仍由 AI 语义决定; 代码只提供「数据包」
- 多数据源: 任何新信息流(X/HN/Reddit/GitHub/arXiv/行情…)只要采集器输出同构
  jsonl(id/url/text/source/ts), 即可复用本引擎, 状态文件按源隔离(如 data/x_last_theme.json)

用法:
  python3 insight_engine.py analyze  --items data/x_timeline.jsonl --last data/x_last_theme.json --recent 30
  python3 insight_engine.py set-theme --last data/x_last_theme.json --theme <主题>
"""
import json
import os
import random
import sys

# ---------- 领域层: 主题分类 ----------

# 默认关键词 → 主题映射(小写匹配, 顺序即优先级); 新数据源可注入自定义表
DEFAULT_THEME_KEYWORDS = {
    "ai": ["codex", "openai", "chatgpt", "gpt", "claude", "anthropic", "gemini",
           "llm", "agent", "reasoning model", "o3", "o4"],
    "crypto": ["btc", "bitcoin", "eth", "ethereum", "crypto", "比特币", "以太坊",
               "加密", "币安", "bybit"],
    "trading": ["fx", "forex", "外汇", "期货", "futures", "黄金", "gold", "原油",
                "美指", "美元指数", "eurusd", "gbpusd", "usdjpy"],
    "reasoning": ["reasoning traces", "chain-of-thought", "chain of thought", "cot",
                  "stealing reasoning", "encrypted thinking", "隐藏推理",
                  "推理痕迹", "解密", "stolen-thoughts"],
    "linux": ["linux", "arch", "nixos", "nix", "ubuntu", "fedora", "debian"],
    "fitness": ["健身", "gym", "workout", "羽毛球", "badminton", "跑步"],
}


def classify(text, keywords=None):
    """将文本分类到主题(默认表或自定义表), 无命中返回 None。"""
    if not text:
        return None
    table = keywords if keywords is not None else DEFAULT_THEME_KEYWORDS
    t = text.lower()
    for theme, kws in table.items():
        for kw in kws:
            if kw in t:
                return theme
    return None


def roll():
    """0~1 随机数(30% 概率判定由调用方/AI 决定)。"""
    return random.random()


# ---------- 基础设施层: 数据读取 ----------

def load_items(path):
    """读取同构 jsonl(每条含 id/url/text/source/ts), 忽略坏行。"""
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
            # 核心字段缺失的行跳过
            if not all(k in d for k in ("id", "url", "text")):
                continue
            items.append(d)
    return items


# ---------- 应用层: analyze 决策支持数据包 ----------

def analyze(items_path, last_path, recent=30, seed=None, keywords=None):
    """读数据源 jsonl, 输出决策支持数据包:
    {source, recent_count, top_theme, top_share, themes, flooded,
     same_as_last, random_roll, random_hit, wander_suggested, candidates}
    """
    if seed is not None:
        random.seed(seed)

    items = load_items(items_path)
    window = items[-recent:] if recent > 0 else items

    counts = {}
    for it in window:
        theme = classify(it.get("text", ""), keywords)
        if theme:
            counts[theme] = counts.get(theme, 0) + 1

    n = len(window)
    top_theme = max(counts, key=counts.get) if counts else None
    top_share = (counts[top_theme] / n) if (top_theme and n > 0) else 0.0
    flooded = top_share >= 0.4

    same_as_last = False
    if os.path.exists(last_path):
        try:
            with open(last_path) as f:
                last_data = json.load(f)
            if last_data.get("theme") and top_theme:
                same_as_last = (last_data["theme"] == top_theme)
        except Exception:
            pass

    r = roll()
    random_hit = r < 0.3
    wander_suggested = flooded or same_as_last or random_hit

    # 候选: 非刷屏主题的内容(供 AI 漫游时选择, 最多 3 条)
    candidates = []
    for it in reversed(window):
        theme = classify(it.get("text", ""), keywords)
        if theme != top_theme:
            candidates.append({
                "url": it.get("url", ""),
                "text": (it.get("text", "") or "")[:80],
                "theme": theme,
            })
            if len(candidates) >= 3:
                break

    source = window[0].get("source") if window else None

    return {
        "source": source,
        "recent_count": n,
        "top_theme": top_theme,
        "top_share": round(top_share, 3),
        "themes": counts,
        "flooded": flooded,
        "same_as_last": same_as_last,
        "random_roll": round(r, 3),
        "random_hit": random_hit,
        "wander_suggested": wander_suggested,
        "candidates": candidates,
    }


# ---------- 应用层: 状态读写 ----------

def set_theme(last_path, theme):
    """写本轮主题到状态文件(供下轮连续同质判断)。"""
    os.makedirs(os.path.dirname(os.path.abspath(last_path)), exist_ok=True)
    with open(last_path, "w") as f:
        json.dump({"theme": theme}, f, ensure_ascii=False)


# ---------- CLI ----------

def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    cmd = args[0]
    if cmd == "analyze":
        items_p = last = None
        recent = 30
        i = 1
        while i < len(args):
            if args[i] in ("--items", "--timeline") and i + 1 < len(args):
                items_p = args[i + 1]; i += 2
            elif args[i] == "--last" and i + 1 < len(args):
                last = args[i + 1]; i += 2
            elif args[i] == "--recent" and i + 1 < len(args):
                recent = int(args[i + 1]); i += 2
            else:
                i += 1
        pkg = analyze(items_p, last, recent)
        print(json.dumps(pkg, ensure_ascii=False))
        return 0
    elif cmd == "set-theme":
        last = theme = None
        i = 1
        while i < len(args):
            if args[i] == "--last" and i + 1 < len(args):
                last = args[i + 1]; i += 2
            elif args[i] == "--theme" and i + 1 < len(args):
                theme = args[i + 1]; i += 2
            else:
                i += 1
        if not last or not theme:
            print("用法: insight_engine.py set-theme --last <path> --theme <主题>", file=sys.stderr)
            return 1
        set_theme(last, theme)
        print("ok")
        return 0
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
