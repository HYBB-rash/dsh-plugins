# insight_engine 架构规则(权威文档,勿破坏)

> 本文档是 `insight_engine.py`(通用信息流洞察引擎)的**唯一权威架构说明**。
> 任何人在此代码上开发(包括 AI agent、人类开发者),必须先读本文档,遵循分层与契约。
> 违反本文档结构 = 破坏架构,必须重写。最后更新: 2026-08-12。

## 0. 一句话定位

**通用信息流洞察引擎**:任何信息源(X/HN/Reddit/GitHub/arXiv/行情…)采集成同构 jsonl 后,
引擎统一做「主题统计 → 刷屏/同质检测 → 随机信号 → 候选抽取」,输出**决策支持数据包**,
供 AI 语义层决定「是否漫游/怎么逛/如何总结」。
**引擎只提供数据与信号,不做最终决策。** 这是用户 2026-08-12 定稿的原则。

## 1. 分层架构(整洁架构,从上到下依赖)

```
┌─ AI 语义层(决策,不进代码)──────────────────────────┐
│ 读决策包 → 决定: 是否漫游 / 选哪个动作 / 怎么逛 / 总结 │
│ (可采纳也可覆盖代码信号; 由 agent prompt 承载)        │
├─ 应用层 insight_engine.py(代码)────────────────────┤
│ analyze() → 决策包 {source, counts, signals, ...}   │
│ set-theme → 写 x_last_theme.json(按源路径隔离)       │
├─ 领域层(纯函数,代码)───────────────────────────────┤
│ classify(text, keywords?) → theme(关键词表可注入)    │
│ roll() → 0~1 随机数 / 阈值判断(flooded ≥ 40%)        │
└─ 基础设施层────────────────────────────────────────┘
   load_items() 读同构 jsonl / CLI 入口 / 状态文件
```

**依赖方向**: AI 语义层 → 应用层 → 领域层 → 基础设施。
**禁止**: 领域层/基础设施层调用应用层; 应用层里写 AI 语义决策。

## 2. 数据契约(接入新信息流的唯一要求)

任何新信息流采集器输出**同构 jsonl**, 每条至少含:

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一 ID |
| `url` | string | 原文链接 |
| `text` | string | 正文/标题(用于主题分类) |
| `source` | string | 数据源标识,如 `x` / `hn` / `reddit` |
| `ts` | number(可选) | 时间戳 |

缺 `id/url/text` 的行会被 `load_items()` 忽略(容错,不报错)。

**接入新源 = 2 步**:
1. 写采集器,输出上述同构 jsonl(如 `data/hn_items.jsonl`)
2. (可选)注入该源专属关键词表,如 `engine.analyze(..., keywords={"dev": ["rust", "homelab"]})`

引擎的刷屏检测/漫游信号/候选抽取/状态隔离**全部复用,零改动**。

## 3. analyze() 输出契约(决策支持数据包)

```json
{
  "source": "x",              // 数据源
  "recent_count": 30,         // 分析窗口条数
  "top_theme": "ai",          // 最热主题(null=无)
  "top_share": 0.933,         // 最热主题占比(0~1)
  "themes": {"ai": 28},       // 各主题计数
  "flooded": true,            // 刷屏: top_share ≥ 0.4
  "same_as_last": false,      // 与上轮主题相同(读状态文件)
  "random_roll": 0.206,       // 0~1 随机数
  "random_hit": true,         // random_roll < 0.3
  "wander_suggested": true,   // flooded || same_as_last || random_hit(建议,非命令)
  "candidates": [...]         // 非刷屏主题的候选内容(最多 3 条,供 AI 选)
}
```

**关键**: `wander_suggested` 是**建议信号**,不是最终决定。
AI 可基于它漫游,也可主观判断漫游/不漫游——决策权在 AI。

## 4. 状态文件(按数据源隔离)

- 每源独立状态文件,如 `data/x_last_theme.json`、`data/hn_last_theme.json`
- 格式: `{"theme": "ai"}`
- 用途: 下一轮 `same_as_last` 连续同质判断
- 写入: `insight_engine.py set-theme --last <path> --theme <主题>`

## 5. CLI 用法(固定)

```bash
# 分析某信息源, 输出决策包 JSON
python3 insight_engine.py analyze --items <jsonl路径> --last <状态文件> --recent 30

# 记录本轮主题(供下轮对比)
python3 insight_engine.py set-theme --last <状态文件> --theme <主题>
```

## 6. 开发规则(任何人必须遵守)

1. **TDD 测试先行**: 改动/新增功能, 先写 `test_insight_engine.py` 测试(红), 再实现(绿)。
   跑测试: `python3 -m unittest test_insight_engine -v`
2. **保持分层**: 领域层纯函数无 IO; 应用层编排; 基础设施管文件/CLI。
3. **不破坏输出契约**: analyze() 的字段名/含义是契约, 新增可, 删除/改名需同步改文档+测试。
4. **不把 AI 语义写进代码**: 漫游决策(是否逛/逛哪/怎么逛)永远是 AI 的事,
   代码最多输出 `wander_suggested` 建议信号。
5. **新信息源 = 新增 jsonl + 可选关键词表**, 不修改引擎核心逻辑。
   若必须改核心逻辑, 走完整流程: 架构评审 → TDD → 重构 → 终审。
6. **数据文件放 `DSH_X_FEED_DATA_DIR`**, 脚本和测试放在本仓库 `x-feed/python/`。

## 7. 相关文件

| 文件 | 角色 |
|---|---|
| `x-feed/python/insight_engine.py` | 通用引擎(唯一核心) |
| `x-feed/python/test_insight_engine.py` | 引擎测试(19 用例) |
| `x-feed/python/x_timeline_collector.py` | X 源采集器(示例) |
| `x-feed/python/x_topic_search.py` / `x_explorer.py` | X 搜索/探索工具 |
| `data/x_timeline.jsonl` | X 源数据 |
| `data/x_last_theme.json` | X 源主题状态 |
| 已退役: `x_wander.py` | 被 insight_engine 取代(勿恢复) |
