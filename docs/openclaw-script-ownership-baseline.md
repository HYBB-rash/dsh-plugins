# OpenClaw 脚本仓库化准备基线

日期：2026-08-27
分支：`feat/repository-managed-openclaw-scripts`

## 本阶段边界

本文件只记录开发前基线。此次盘点没有修改 OpenClaw/DSH 任务、服务、脚本、状态或凭据，也没有触发生产任务。

“OpenClaw 触点”不能一概当成迁移对象：`release/` 中对 OpenClaw PID、重启计数和只读挂载的检查属于发版安全护栏；`telegram-gateway` 中的 OpenClaw 错误分类只是兼容性说明。它们不是业务脚本源码，不应在脚本仓库化时顺手删除。

## 已核实的现场事实

- 本仓库开始盘点时为干净的 `main`，随后为本任务建立了独立分支。
- `herman.hermes` 的 `/home/herman/.openclaw/workspace` 不是 Git 仓库。
- Rita 的 `/home/rita/.openclaw/workspace` 也不是 Git 仓库。
- 当前仓库历史中没有下表 9 个生产脚本的同名受管版本。
- `herman.hermes` 上的 `/home/herman/deepseek-usage-report` 和 `/home/herman/my-wechat` 各自已经是独立 Git 仓库；它们是脚本调用的外部业务项目，不应未经确认被复制进本仓库。
- OpenClaw 当前有 4 个启用任务：电量监控、水表监控、`chatgpt-linux-nix` 仓库监控和 Memory Dreaming。前三个是 command 任务；Memory Dreaming 是 OpenClaw 内部 `agentTurn`，不是待收编脚本。
- DSH 当前有效账本中有 5 个由旧 OpenClaw 任务迁来的任务：DeepSeek Token 日报、my-wechat 自动拉取、日报、小时报和同步看门狗。
- OpenClaw 服务现场基线为 `active/running`、`NRestarts=0`。本阶段未改变它。

历史状态已经漂移：2026-08-20 的记录是 7 条任务由 DSH 调度、OpenClaw 只保留仓库监控和 Dreaming；当前电量任务已回到 OpenClaw，新增了水表任务，而 DSH 有效账本只剩 5 条。在两套已盘点的调度器中，旧“信息流监控”OpenClaw 定义为 disabled，DSH 对应绑定也已不在有效账本中。本任务不能沿用旧清单直接实施。

## 当前生产实际引用、但未由本仓库管控的脚本

### OpenClaw 当前启用任务

| 脚本 | 运行位置 | 调用者 | 大小 | SHA-256 |
| --- | --- | --- | ---: | --- |
| `bzp_dual_dispatch.py` | Herman OpenClaw workspace | 电量、水表监控 | 5,900 | `4a4ce70b8db38dda5f4c3792f0aee5296cbdf0c5bc797935a63a7b3d6b560ab3` |
| `bzp_ble_read_until_success.py` | Herman OpenClaw workspace | 电量、水表监控的 reader 参数 | 65,257 | `70bceca0b6c1c805499026c194d33ed866f7a2233aeeec0b01d92c02ce74cf92` |
| `gh_repo_monitor.py` | Herman OpenClaw workspace | `chatgpt-linux-nix` 仓库监控 | 3,357 | `29fa8e5020795376ca04d750a744f8ae1acee7375080f3860549b0663b6aac47` |
| `bzp_weixin_relay.py` | Rita OpenClaw workspace | Herman 的 BLE dispatch 通过 SSH 调用 | 2,425 | `74685510df0d90086018b850b0d6ac27232e813598acb27c8fae7e79be472a05` |

两个 BLE 任务共享相同的 dispatch、reader 和 Rita relay；设备参数、认证文件、状态文件和日志不是源码，仍应留在镜像/仓库之外。

### DSH 当前有效任务

| 脚本 | 调用者 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `deepseek_daily.sh` | DeepSeek Token 日报 | 172 | `832019697083ccd42a68780087428c7e938202bdb63d6de3ab6a1a0f62ff077a` |
| `mywechat_pull.sh` | my-wechat 每小时自动拉取 | 1,716 | `9c61acbac2b322f07df7bb47c10ede7ee95d0c8d1f79f7dcb9e7fcf7e7c128ec` |
| `mywechat_watchdog.sh` | my-wechat 同步看门狗 | 4,648 | `a9cc4a2465aef6e41b8d9d5b7783f01b637e362102bfabd6168bb06b941fda8d` |
| `mywechat_ai_context_daily.sh` | my-wechat 日报 Agent | 741 | `e0105d8f741688d7873518f6da5f2b41ffe7bdbc0c12e8ce6570153a34b799fb` |
| `mywechat_ai_context_hourly.sh` | my-wechat 小时报 Agent | 742 | `c59b2d76b45631e7002086580e282bff2186cf55651364dd9c7cf3a6e8336648` |

这些 DSH 任务虽然不再由 OpenClaw 调度，命令或 prompt 仍直接引用 `/home/herman/.openclaw/workspace/scripts/...`。当前生产 Compose 把整个 `~/.openclaw` 只读挂入 DSH 容器，因此“调度已迁移”不等于“脚本源码已经归仓库”。

## 已发现的传递依赖和状态边界

- `deepseek_daily.sh` 进入独立 Git 仓库 `/home/herman/deepseek-usage-report`，再执行其中的 `deepseek_report.py`。当前缺口是 OpenClaw workspace 中的 wrapper；下游项目本身已有独立源码归属。
- 四个 my-wechat wrapper 进入独立 Git 仓库 `/home/herman/my-wechat`，使用其中的虚拟环境、`gen_ai_context.py`、`sync.py` 和 `qq_sync.py`。这些业务代码和数据不应被当成 wrapper 一起搬迁。
- `mywechat_watchdog.sh` 还可调用 `$HOME/.hermes/scripts/send_tg_ops.sh`。这是另一条宿主机运维依赖，不是 OpenClaw 源码；后续设计必须显式保留、替换或判定为可选，不能漏掉。
- `gh_repo_monitor.py` 把可变状态写到 `/home/herman/.openclaw/workspace/data/gh_repo_state.json`。若目标包含消除 OpenClaw 目录依赖，必须单独迁移这个状态路径；只移动 `.py` 文件会留下隐性依赖。
- BLE 脚本使用外置认证、设备状态和日志，并跨机调用 Rita relay。源码进 Git 不代表这些凭据和状态也应进 Git。

## 禁用任务仍保留的脚本引用

除上表已由 DSH 调用的 5 个脚本外，OpenClaw 的 12 个 disabled 定义中还能提取到以下路径：

- 本仓库当前没有同名历史：`info_monitor.py`、`relay_daily_watch.py`、`rest_break_alarm.sh`。
- 本仓库已有对应 X 脚本：`x_insight_pipeline.py`、`x_topic_search.py`、`x_explorer.py`、`insight_engine.py`。
- 其中 `insight_engine.py` 的 OpenClaw 副本与仓库版本 SHA-256 相同；另外三个 X 脚本的哈希不同，不能假定副本等价。

这些引用当前不承担生产调度。是否连 disabled 定义及其旧副本一起纳入“所有脚本”，会直接改变任务范围，需要在实施前确认。

## 实施前必须冻结的口径

以下是准备阶段提出的验收候选，还不是已经确认的设计：

1. 源码：目标脚本正文由本仓库 Git commit 唯一标识，不再以 OpenClaw workspace 中的散落副本为源码事实源。
2. 构建：Herman 上由 DSH 使用的脚本应进入同一不可变候选镜像，生产不得临时复制源码或进容器补文件。
3. 运行引用：任务定义应引用候选镜像内的固定路径；如暂时保留兼容路径，必须能证明它由同一 commit 生成且不会双源漂移。
4. 状态：认证、数据库、日志、游标和设备状态继续外置；仓库只管源码和必要的声明，不提交秘密或运行状态。
5. 控制面：DSH 任务只能经 cron control 单写者更新；OpenClaw 任务只能经正式 OpenClaw CLI 更新；不得直接编辑 JSONL 或 SQLite。
6. 跨机：Rita relay 需要独立的发布/校验边界。本仓库现有 `release/dsh` 只发布 Herman 的 DSH Docker 系统，并明确不修改 OpenClaw；不能把“源码已提交”误报成“Rita 已使用该源码”。
7. 验收：除测试和路径/hash 校验外，还要逐项证明调度、静默、投递、失败处理、状态连续性和真实自然运行；在新任务验证前不得提前停旧入口，且要防止双发。

## 下一步入口

范围确认后，先把纳入范围的现场脚本按上述 SHA-256 固定为原始样本并补 characterization tests，再决定仓库目录、镜像路径、状态迁移和 Rita 发布边界。准备阶段不直接重写脚本，也不修改生产任务。
