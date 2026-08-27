# 项目级 OpenClaw 脚本依赖盘点

日期：2026-08-28

分支：`feat/repository-managed-openclaw-scripts`

基线 `main`：`93e8e91aaad410f1416f9fc25fa4dd2af6affb58`

## 盘点口径

本次盘点对象不是“哪些 cron 任务还在 OpenClaw”，而是当前项目的脚本及其传递运行依赖：

- 本仓库源码、构建和生产 Compose 中的 OpenClaw 触点；
- Herman OpenClaw workspace 顶层自定义脚本；
- 脚本调用的其他脚本、外部 Git 项目、状态、凭据入口和专有运行时能力；
- DSH、OpenClaw、systemd、OpenClaw Skill/插件对这些脚本的当前引用；
- Rita 上由 Herman 脚本跨机调用的脚本；
- OpenClaw cron 内联 JavaScript，因为它们是代码，只是没有独立文件。

以下内容不因“位于 OpenClaw workspace”而自动算作项目脚本：第三方 Skill 自带的通用脚本、任务工作副本、记忆/会话材料、虚拟环境依赖包、浏览器 profile、cookie、凭据和业务状态。它们只在确实构成目标脚本的运行依赖时记录为外部资产，不作为待提交源码。

本阶段全部操作为只读现场盘点。没有修改或触发 OpenClaw/DSH cron，没有修改、停止或重启服务；凭据正文没有写入本文档或仓库。

## 结论摘要

### 仓库代码本身

本仓库源码中没有业务脚本直接调用 OpenClaw CLI。明确的运行桥只有生产 Compose 将 `/home/herman/.openclaw` 只读挂入 DSH 容器；当前 DSH cron 再通过这个挂载执行 workspace 脚本。

其余仓库命中不是待迁业务脚本：

- `release/cli.mjs` 对 `openclaw-gateway.service` 的 PID/重启计数检查是发版隔离护栏；
- `.agents/skills/dsh-release/SKILL.md` 是“不改 OpenClaw”的操作规则；
- `telegram-gateway` 的 OpenClaw error taxonomy 是兼容性说明；
- 仓库版 `browser_start.py` 中的 `openclaw-browser` 只出现在旧 profile 的注释里。

这些内容不能因为脚本仓库化而顺手删除。

### 现场脚本总量

Herman 的 `/home/herman/.openclaw/workspace/scripts` 顶层共有：

- 41 个非测试自定义脚本；
- 10 个测试脚本；
- 另有一个支持脚本 `search_profile/_sel.py`，由 `web_search.py` 传递调用；
- `search_env/` 是现成 Python 虚拟环境，`search_profile/` 还含浏览器状态和 cookie，二者不能整体提交 Git。

此外还有：

- 1 个已加载的 OpenClaw 插件脚本：`plugins/x-delivery-receipt/index.cjs`；
- 1 个会生成 OpenClaw 路径的模板：`skills/user-inbox-workflow/templates/sentinel-reminder.sh`；
- 5 段 OpenClaw cron 内联 JavaScript trigger，当前全部 disabled；
- Rita 上 1 个正在被调用的 `bzp_weixin_relay.py` 副本，与 Herman 副本哈希一致。

41 个非测试脚本中：

- 34 个在正文中明确绑定了宿主机路径、OpenClaw/Hermes 状态、workspace 相对目录、外部项目或虚拟环境；
- 其余 7 个没有此类显式字符串，但源码仍只寄存在 OpenClaw workspace，调用者也使用该绝对路径；
- 11 个在本仓库已有同名版本：3 个完全一致，8 个已经漂移；
- 7 个在 `/home/herman/my-wechat` Git 仓库已有同名版本：1 个完全一致，6 个已经漂移；
- 剩余 23 个没有在本仓库、`my-wechat`、`deepseek-usage-report`、`task-inbox-workflow` 或 `.hermes` 中找到同名源码事实源。

因此，问题不是只有几个 cron 命令写错路径，而是存在“未受管源码、多个 Git 源、生产副本漂移、OpenClaw 专有能力、OpenClaw 状态路径”混在一起的项目级依赖。

## 依赖类型

| 代号 | 含义 | 仓库化时代表什么 |
| --- | --- | --- |
| `API` | 调用 OpenClaw CLI、插件 API 或 trigger JS 沙箱 | 只搬文件不能脱离 OpenClaw，必须保留或替换专有能力 |
| `FS` | 读取/写入 OpenClaw/Hermes/workspace 绑定的状态、凭据、脚本、虚拟环境或 profile | 源码和可变/秘密资产必须分离，不能把整个目录提交 Git |
| `CALLER` | 脚本本身可独立运行，但当前由 OpenClaw 调度，或调用者写死 workspace 路径 | 需要迁调用路径和发布身份，不一定要重写业务逻辑 |
| `EXT` | 调用另一个 Git 项目、宿主服务、设备或独立工具链 | 只能记录契约，不能未经确认复制其源码或状态 |
| `NAME` | 只是在监控 OpenClaw 上游、文件名/注释提到 OpenClaw | 不是 OpenClaw 运行依赖 |

## 当前实际执行或加载的代码

任务清单只用于证明调用者，脚本本身才是本表主体。

| 脚本 | 当前调用者 | 依赖 | 现场结论 |
| --- | --- | --- | --- |
| `bzp_dual_dispatch.py` | OpenClaw 电量、水表任务 | `CALLER`, `EXT` | OpenClaw 执行；再调用本地 monitor 和 Rita SSH relay |
| `bzp_ble_monitor.py` | `bzp_dual_dispatch.py` 默认 monitor | `CALLER`, `EXT` | 先前按 argv 盘点时漏掉的传递脚本 |
| `bzp_ble_read_until_success.py` | BLE monitor 的 reader | `CALLER`, `EXT` | 使用外置设备认证、BLE 和业务状态；源码位于 workspace |
| `bzp_weixin_relay.py` | Herman dispatch 经 SSH 调 Rita | `API`, `CALLER` | Rita 端直接执行 `openclaw message send`；这是最强的 OpenClaw 运行时依赖 |
| `gh_repo_monitor.py` | OpenClaw 仓库监控任务 | `FS`, `CALLER` | 状态写入 workspace `data/gh_repo_state.json` |
| `deepseek_daily.sh` | DSH cron | `CALLER`, `EXT` | DSH 通过只读 OpenClaw 挂载执行，再进入独立 `deepseek-usage-report` Git 仓库 |
| `mywechat_pull.sh` | DSH cron | `CALLER`, `EXT` | 生产副本与 `my-wechat` Git 版本不一致 |
| `mywechat_watchdog.sh` | DSH cron | `CALLER`, `EXT` | 生产副本漂移；部分旧 Hermes 依赖当前不存在，见下文 |
| `mywechat_ai_context_daily.sh` | DSH 日报 Agent | `CALLER`, `EXT` | prompt 和 cwd 都绑定 OpenClaw workspace；再进入 `my-wechat` |
| `mywechat_ai_context_hourly.sh` | DSH 小时报 Agent | `CALLER`, `EXT` | 盘点时观察到真实运行进程使用该 workspace 路径 |
| `wechat_oom_protect.py` | 系统级 `wechat-oom-protect.service` | `CALLER`, `EXT` | 服务 active/running、`NRestarts=0`；ExecStart 写死 workspace 路径 |
| `plugins/x-delivery-receipt/index.cjs` | OpenClaw 插件系统 | `API`, `FS` | 插件 enabled/loaded；监听 OpenClaw `cron_changed`，但目标旧 X job 当前 disabled |

OpenClaw 当前启用的 Memory Dreaming 是内部 `agentTurn`，不是脚本文件，不纳入源码清单。

## 41 个非测试脚本完整清单

### BLE 与跨机投递（6）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `baozupo_ble_reminder.sh` | `FS`, `CALLER` | OpenClaw state flag 提醒哨兵；未发现当前启用调用者 |
| `bzp_ble_monitor.py` | `CALLER`, `EXT` | 当前 BLE 电量/水表链路的 monitor |
| `bzp_ble_read_until_success.py` | `CALLER`, `EXT` | 当前 BLE reader；另有 disabled systemd 用户单元也引用它 |
| `bzp_dual_dispatch.py` | `CALLER`, `EXT` | 当前 OpenClaw 任务入口；本地 stdout + Rita SSH 分发 |
| `bzp_meter_query.py` | `CALLER`, `EXT` | `baozupo-meter` Skill 可调用；脚本本身不要求 OpenClaw 进程 |
| `bzp_weixin_relay.py` | `API`, `CALLER` | Rita 当前副本直接调用 OpenClaw CLI 发微信 |

### 浏览器与搜索（4）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `browser_search.py` | `FS`, `CALLER`, `EXT` | Skill 调用；使用 `~/.config/openclaw-browser` 登录态和 CDP |
| `browser_start.py` | `CALLER`, `EXT` | 本仓库已有完全一致版本；OpenClaw 只出现在旧 profile 注释里 |
| `web_search.py` | `FS`, `CALLER`, `EXT` | 使用 workspace 内 `search_env`、`search_profile/_sel.py` 和 cookie 文件 |
| `zerochan_lucy_grab.py` | `CALLER`, `EXT` | 只依赖本机 CDP；未发现 OpenClaw API/状态依赖 |

### API 中转与告警（4）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `check_relay_site.py` | `CALLER`, `EXT` | 被 relay watch 和多个 Skill 调用；自身可独立运行 |
| `relay_daily_watch.py` | `FS`, `CALLER`, `EXT` | 状态在 `~/.openclaw/relay_watch_state.json`，调用 `check_relay_site.py` |
| `relay_shutdown_reminder.sh` | `FS`, `CALLER` | OpenClaw state flag 提醒哨兵；未发现当前启用调用者 |
| `send_tg_ops.sh` | `FS`, `CALLER`, `EXT` | 从 OpenClaw ops profile 取凭据；`my-wechat` Git 版本与 workspace 副本已漂移 |

### cron 与提醒（3）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `cron_conflict_check.py` | `FS`, `CALLER` | 读取旧 `~/.hermes/cron/jobs.json`；该路径当前不存在 |
| `rest_break_alarm.sh` | `CALLER` | 脚本独立；旧 OpenClaw 任务 disabled |
| `trade_system_reminder.sh` | `FS`, `CALLER` | OpenClaw state flag 提醒哨兵；未发现当前启用调用者 |

### 报告、信息流和工作流（7）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `deepseek_daily.sh` | `CALLER`, `EXT` | DSH 当前执行；进入独立 `deepseek-usage-report` Git 仓库 |
| `gh_repo_monitor.py` | `FS`, `CALLER`, `EXT` | OpenClaw 当前执行；状态留在 workspace data |
| `info_monitor.py` | `FS`, `CALLER`, `EXT` | 状态留在 workspace data；旧 OpenClaw 和 DSH 调用当前均未启用 |
| `notion_inbox_sync.py` | `FS`, `CALLER`, `EXT` | 读取 `~/.openclaw/.env` 和 `~/.openclaw/state`；被 inbox Skill 引用 |
| `openclaw_daily_brief.sh` | `NAME`, `CALLER`, `EXT` | 监控 OpenClaw 上游 Git；脚本本身不需要 OpenClaw 运行时，未发现当前调用者 |
| `openclaw-daily-trigger.js` | `API`, `NAME` | 使用 OpenClaw trigger 沙箱的 `tools.call/json`；对应旧任务 disabled |
| `openclaw_weekly_brief.sh` | `NAME`, `CALLER`, `EXT` | 监控 OpenClaw 上游 Git；脚本本身不需要 OpenClaw 运行时，未发现当前调用者 |

### my-wechat 与桌面守护（6）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `mywechat_ai_context_daily.sh` | `CALLER`, `EXT` | DSH 当前执行；`my-wechat` Git 版本与生产副本漂移 |
| `mywechat_ai_context_hourly.sh` | `CALLER`, `EXT` | DSH 当前执行；`my-wechat` Git 版本与生产副本漂移 |
| `mywechat_pull.sh` | `CALLER`, `EXT` | DSH 当前执行；`my-wechat` Git 版本与生产副本漂移 |
| `mywechat_sync_daemon.sh` | `CALLER`, `EXT` | Skill/历史运维入口；当前 systemd 直接运行 `my-wechat/sync.py`，不运行该 wrapper |
| `mywechat_watchdog.sh` | `CALLER`, `EXT` | DSH 当前执行；旧 cron/ops helper 路径当前都不存在 |
| `wechat_oom_protect.py` | `CALLER`, `EXT` | 系统服务当前执行；脚本内部不依赖 OpenClaw API，只是 ExecStart 写死 workspace |

### X 数据管线（11）

| 脚本 | 依赖 | 当前状态/用途 |
| --- | --- | --- |
| `insight_engine.py` | `CALLER` | 本仓库有完全一致版本；旧 OpenClaw X 状态仍存在 |
| `x_browser.py` | `CALLER`, `EXT` | 本仓库有完全一致版本；依赖本机 Chrome/CDP |
| `x_daily_report.py` | `CALLER`, `FS` | 使用 workspace 相对 `data/`；本仓库没有同名版本 |
| `x_explorer.py` | `FS`, `CALLER`, `EXT` | workspace 副本与仓库版漂移；旧数据写入 OpenClaw data |
| `x_insight_pipeline.py` | `FS`, `CALLER`, `EXT` | workspace 副本与仓库版漂移；旧插件还引用它 |
| `x_neighborhood.py` | `FS`, `CALLER` | workspace 副本与仓库版漂移；使用相对 `data/` |
| `x_timeline_collector.py` | `FS`, `CALLER`, `EXT` | workspace 副本与仓库版漂移；旧输出写 OpenClaw data |
| `x_timeline_dedup.py` | `FS`, `CALLER` | workspace 副本与仓库版漂移 |
| `x_timeline_migrate_explore.py` | `FS`, `CALLER` | workspace 副本与仓库版漂移 |
| `x_timeline_store.py` | `CALLER` | workspace 副本与仓库版漂移 |
| `x_topic_search.py` | `FS`, `CALLER`, `EXT` | workspace 副本与仓库版漂移 |

仓库版 X 管线已通过 `DSH_X_FEED_DATA_DIR` 使用 `~/.dsh/storages/dsh-x-feed`；旧 OpenClaw X 数据和已加载旧插件仍并存，不能把“仓库已有 X 代码”误报成“旧副本和旧状态已经退役”。

## 测试脚本和额外代码

顶层 10 个测试脚本：

- `test_bzp_ble_read_until_success.py`：本仓库没有同名版本；
- `test_insight_engine.py`：本仓库没有同名版本；
- `test_x_browser.py`、`test_x_timeline_collector.py`、`test_x_timeline_migrate_explore.py`、`test_x_timeline_store.py`、`test_x_topic_search.py`：与本仓库同名版本哈希一致；
- `test_x_insight_pipeline.py`、`test_x_neighborhood.py`、`test_x_timeline_dedup.py`：与本仓库同名版本已漂移。

额外代码：

- `plugins/x-delivery-receipt/index.cjs`：OpenClaw 专属插件 API + OpenClaw X 路径，当前 enabled/loaded；仓库内已有 DSH 原生 receipt 实现，但旧插件尚未卸载；
- `skills/user-inbox-workflow/templates/sentinel-reminder.sh`：模板明确要求复制到 OpenClaw workspace，并把 flag 写进 OpenClaw state；
- `scripts/search_profile/_sel.py`：`web_search.py` 的传递 helper；应作为源码候选单独处理，不能连 browser profile/cookie 一起提交；
- Rita `/home/rita/.openclaw/workspace/scripts/bzp_weixin_relay.py`：哈希与 Herman 副本相同，当前真实被调用。

OpenClaw cron 还有 5 段内联 trigger JavaScript，全部 disabled：

| 名称 | 字节数 | 依赖 |
| --- | ---: | --- |
| 信息流监控（中文） | 736 | OpenClaw trigger JS 沙箱 + workspace 脚本/数据 |
| X 洞察总结 | 571 | OpenClaw trigger JS 沙箱 |
| OpenClaw 代码库每日简报 | 810 | OpenClaw trigger JS 沙箱 |
| OpenClaw 代码库周报 | 562 | OpenClaw trigger JS 沙箱 |
| Codex Linux 发布监控 | 81 | OpenClaw trigger JS 沙箱 |

它们不是普通任务配置字段，而是只能在 OpenClaw trigger 环境运行的代码。是否继续保留功能与是否把源码文件纳入仓库，应分开处理。

## 源码归属与漂移

### 本仓库已有同名版本（11）

- 哈希一致：`browser_start.py`、`insight_engine.py`、`x_browser.py`；
- 哈希不同：`x_explorer.py`、`x_insight_pipeline.py`、`x_neighborhood.py`、`x_timeline_collector.py`、`x_timeline_dedup.py`、`x_timeline_migrate_explore.py`、`x_timeline_store.py`、`x_topic_search.py`。

### `my-wechat` Git 仓库已有同名版本（7）

- 哈希一致：`cron_conflict_check.py`；
- 哈希不同：`mywechat_ai_context_daily.sh`、`mywechat_ai_context_hourly.sh`、`mywechat_pull.sh`、`mywechat_sync_daemon.sh`、`mywechat_watchdog.sh`、`send_tg_ops.sh`。

### 未找到其他同名 Git 源（23）

`baozupo_ble_reminder.sh`、`browser_search.py`、`bzp_ble_monitor.py`、`bzp_ble_read_until_success.py`、`bzp_dual_dispatch.py`、`bzp_meter_query.py`、`bzp_weixin_relay.py`、`check_relay_site.py`、`deepseek_daily.sh`、`gh_repo_monitor.py`、`info_monitor.py`、`notion_inbox_sync.py`、`openclaw_daily_brief.sh`、`openclaw-daily-trigger.js`、`openclaw_weekly_brief.sh`、`relay_daily_watch.py`、`relay_shutdown_reminder.sh`、`rest_break_alarm.sh`、`trade_system_reminder.sh`、`web_search.py`、`wechat_oom_protect.py`、`x_daily_report.py`、`zerochan_lucy_grab.py`。

“有另一个 Git 版本”不代表生产受控：当前调用者仍指向 OpenClaw workspace，且 14 个副本已经与对应 Git 版本漂移。

## 已验证的断裂或陈旧依赖

- `cron_conflict_check.py` 读取 `~/.hermes/cron/jobs.json`，但该文件不存在；OpenClaw 当前事实源是权限 `0600` 的 `~/.openclaw/state/openclaw.sqlite`，不能直接改库。
- `mywechat_watchdog.sh` 也引用不存在的 `~/.hermes/cron/jobs.json`，所以旧 cron 投递失败补发分支不能依赖该文件工作。
- `mywechat_watchdog.sh` 优先调用 `$HOME/.hermes/scripts/send_tg_ops.sh`，该路径不存在；当前只能走脚本设计中的 stdout 回退。workspace 和 `my-wechat` 各有一份 `send_tg_ops.sh`，且哈希不同。
- OpenClaw 旧 X 状态与当前 DSH X 状态目录同时存在；旧插件仍 loaded，但它绑定的旧 X job disabled。
- `wechat-oom-protect.service` 是系统级 unit，不在 DSH Docker 发布边界内；只把脚本放进镜像不能改变其宿主 ExecStart。
- Rita relay 是跨机脚本，并且直接使用 Rita OpenClaw CLI；Herman 的 DSH Docker 发布不能证明或更新 Rita 的运行文件。

## 外置资产边界

以下是运行依赖，但不是应原样进入仓库的脚本源码：

- `[REDACTED_SECRET]`：`~/.openclaw/.env`、`~/.openclaw/profiles/ops/.env`、systemd 环境中的现有凭据；
- BLE 认证、设备参数、读数状态和日志；
- OpenClaw SQLite、WAL/SHM、cron 历史、Session 和 Memory；
- `search_env` 虚拟环境、Chrome/Firefox profile、cookie 和登录态；
- OpenClaw/DSH X 业务状态和投递账本；
- `my-wechat` 数据库、虚拟环境、同步健康文件和独立 Git 源码；
- `deepseek-usage-report`、`task-inbox-workflow`、`openclaw-upstream` 等独立项目；
- Rita 端业务状态和 OpenClaw 配置。

## SHA-256 现场基线

以下哈希对应 2026-08-28 只读盘点时 Herman workspace 顶层文件。测试也单列，避免后续只搬生产脚本却丢掉现有行为证据。

```text
229974959f36eaf97efeef6ba6497b66b1546953f1769b722336ebdb9909fc49  baozupo_ble_reminder.sh
0e886839fadc794c47ac4b6272e80c235044c26caf32498f2050d1212f79212d  browser_search.py
454175b6753bad0dd393ed7e945db7f44fed56345cbc7f35822ea9c97fdb1b29  browser_start.py
7f3880c266fb06a7d63d74e62eb83b07ac9bf3ca50350ce70f5475a62a31461d  bzp_ble_monitor.py
70bceca0b6c1c805499026c194d33ed866f7a2233aeeec0b01d92c02ce74cf92  bzp_ble_read_until_success.py
4a4ce70b8db38dda5f4c3792f0aee5296cbdf0c5bc797935a63a7b3d6b560ab3  bzp_dual_dispatch.py
f2cf0cc28c49b2c67ec7d38025299f3f3090f9c24049348fe44798f017f4f0f0  bzp_meter_query.py
74685510df0d90086018b850b0d6ac27232e813598acb27c8fae7e79be472a05  bzp_weixin_relay.py
f01c76fb61d0700cf1675a204f90cf0595811664669d0ea8ef4da7c91ddc1d5b  check_relay_site.py
db382ed033ba149b95c51f9a823551849e867814c030df07246f59a9d5caabb5  cron_conflict_check.py
832019697083ccd42a68780087428c7e938202bdb63d6de3ab6a1a0f62ff077a  deepseek_daily.sh
29fa8e5020795376ca04d750a744f8ae1acee7375080f3860549b0663b6aac47  gh_repo_monitor.py
15d02b1d75211477c8bd07267e2eea97a8381eb845910529036b99ef56923ed3  info_monitor.py
b7d3eaca8d2ff2abb86ba51ea8e01ad88d8e81a97277196bf2b0f7e954c70616  insight_engine.py
e0105d8f741688d7873518f6da5f2b41ffe7bdbc0c12e8ce6570153a34b799fb  mywechat_ai_context_daily.sh
c59b2d76b45631e7002086580e282bff2186cf55651364dd9c7cf3a6e8336648  mywechat_ai_context_hourly.sh
9c61acbac2b322f07df7bb47c10ede7ee95d0c8d1f79f7dcb9e7fcf7e7c128ec  mywechat_pull.sh
b9bc8451b11db04bb0f5387706aceda8b6b7356044215b08850d4aba2a2f086d  mywechat_sync_daemon.sh
a9cc4a2465aef6e41b8d9d5b7783f01b637e362102bfabd6168bb06b941fda8d  mywechat_watchdog.sh
4ec15ff283e56a11c1ae22043a81f896bff3b549e135c98316630b259876828f  notion_inbox_sync.py
6ff48e90d0788c8c74314f518fdfa28909f830b7bcc074d9e5ac09bd90f12bf8  openclaw_daily_brief.sh
e16b7ad503db36fa85ef925b63e899329696d813a913d6e229a4cf93947b120c  openclaw-daily-trigger.js
4fa562369a7b7b6ed412e57e4d38f5d965dad85f2783a3250f58537993b654bd  openclaw_weekly_brief.sh
e6f9c1113222da89605a1ad0abdd45f50b48cce387605a97dcc05837d7b84de8  relay_daily_watch.py
a19a34a090486d60de00459217dd90b51ed2e300d8eba75be12baadfb1c95b6b  relay_shutdown_reminder.sh
158ce47d02ed3fb9722c3eadc05f06b21a3c5aca7b2833858854b8382e2812af  rest_break_alarm.sh
b38db8081009ff5a8144d7a2c1ae47b961740fbec4587cbe57396be1f78d3f12  send_tg_ops.sh
da72216b0f6781158a899bea4fdd3de0ee7c072e78ed5b73ed8304599240f220  trade_system_reminder.sh
cab8c88b7a8a022f40d98fbd25b59cb2009fea174bd3867a98f4a4f1c9121979  web_search.py
2108c4ade87aa9a286457fa0544542b16244a1d9a933e0edbe34c929e0dde3c9  wechat_oom_protect.py
3d0ce735e9fa508b20d18e9805f5546cbb7bb180396ad0c27e0cd9f1e9e8cf31  x_browser.py
f4edd865f69a322e87563ca84edf0195e63af759ef309cd48a800789e27e4950  x_daily_report.py
bd0b37de84b91fc482482e47b00c0e4964cd4dd8a81f76837b9b6b8782c7cc2f  x_explorer.py
11f6075f82f77aab1fa7c9fb8702447927cedda61333536ece6eee5b38a58b4d  x_insight_pipeline.py
97a4950704f4be6ec1706d7454763da79cc6e67b42f65496c51d18fd890c26f4  x_neighborhood.py
46439392f67525d6b005b43fc8864bedfc5decf894dc163789572636eec7d442  x_timeline_collector.py
6d5c9b6cd93c170e0d264175c7f144032cc05fad82c867184d696b9b9ab0be72  x_timeline_dedup.py
f99876c83bb78872a3559b9917c916afcb9219084d578e00b0f2a090382d13f6  x_timeline_migrate_explore.py
d32833e8165fcfc4978d8af7a5c4d3febf0db7a45368cfef483851f2e5a41b91  x_timeline_store.py
22a940e31f285aa6171cd0262ae49a58eb72f56660c799f095ab20b9919c9a8c  x_topic_search.py
20b4a08ed5e729394c0367c2e5a40bd031bbe2e3efb570f68d16636968249f7b  zerochan_lucy_grab.py

e1d27a07fa014110b1e28ab16358c546876162654f4e79279b59c3ff2c0e4df0  test_bzp_ble_read_until_success.py
ddce467ad4054839f9f898e2b8cc19132a1bbeeb4c8d5e095b37efde83188def  test_insight_engine.py
20bbbeabb2efdb1cf58f51881c3c1f12ed41c76e10982814f21f2db049f022dc  test_x_browser.py
61a3f783b1b9d38384a3c792a7760a2b328821f68a0372d035b7b251243066a5  test_x_insight_pipeline.py
7799a4c4f70d9df70c1918becd37a8b904704abe63bc2ec9530bef463975176d  test_x_neighborhood.py
7a9eb56870d23774dd41c89081c57eef1d0cc0f0c4c3fc8903aeadd533fbce60  test_x_timeline_collector.py
391b26efef711451b53e00ce921bc95312725f1029710082a0dd504dd76807f5  test_x_timeline_dedup.py
3eec4447b7f7388558a36dca0de5950c0b39539302754673ac53b2ec66299b2c  test_x_timeline_migrate_explore.py
c35e4347e91b692fcfbae7352df286f023225ac56b14126559a087f789a0cac8  test_x_timeline_store.py
001d0ec56ea52a8f966ac1d9c70aaaec7e872b5fa583e80d82931a22a76fd9d3  test_x_topic_search.py
```

额外文件哈希：

```text
bd0322bae2c9a8ab3d112443f8c98b326ec4c1f66fc79aa1f9779c5d2472a03f  plugins/x-delivery-receipt/index.cjs
df28449b5adcd1ae4fa04d0c423ee3bf972185833b3a759e491d2f8836339974  skills/user-inbox-workflow/templates/sentinel-reminder.sh
74685510df0d90086018b850b0d6ac27232e813598acb27c8fae7e79be472a05  Rita bzp_weixin_relay.py
```

## 这份盘点能证明什么

这份基线已经回答“有哪些脚本依赖 OpenClaw 或寄存在 OpenClaw 才能被当前项目调用”，并把任务、脚本、状态和运行时能力分开。它还不能证明任何脚本已经适合直接搬进镜像，也没有替用户决定下列范围：

- 23 个无其他 Git 源的脚本是否全部成为本仓库源码；
- 14 个漂移副本以生产版本、已有 Git 版本还是逐项合并后的版本为准；
- `my-wechat` wrapper 是否从独立仓库转移所有权，还是本仓库只管发布引用；
- OpenClaw 专属 CLI、插件和 trigger 功能是保留、替换还是退役；
- 系统级 OOM unit、Rita relay 和宿主浏览器工具分别由什么发布入口管理。

这些是下一阶段的责任和验收边界，不应在盘点阶段静默代答。
