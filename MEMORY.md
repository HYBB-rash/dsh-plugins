# 项目记忆

这里保存可复用的项目经验，不是当前运行状态的权威来源。开始任务时，按关键词检索相关段落；需要判断配置、运行状态、发布版本或外部系统时，必须做本次现场核对。当前任务、专项合同和更近目录规则优先。

## 产品与职责边界

- 对外 README 先用具体使用场景说明何时需要、装上后会怎样；再说明功能、边界和技术名词。展示名与搜索关键词服务于准确检索，不能替代真实体验或夸大承诺。
- 新能力按责任和失败模式选最轻充分载体：AI/Skill 处理模糊判断与工具编排；现有工具或 Skill 内小脚本处理确定性机械步骤；只有缺少通用运行时能力、或存在模型不可绕过的安全、并发、事务、唯一投递或恢复不变量时才引入 Plugin。混合需求由 Skill 编排，Plugin 不应知道上层业务故事。
- 私人助理先区分责任归属：用户说自己要做、正在做或需要提醒时，默认只安排、监督和跟进；只有明确要求 Agent 去做、查询、修改或落地时才执行任务内容。
- 用户验收的是工作是否被可靠保留并完成，不是内部 Agent 数量或分工；不要为了“一个 Agent 一项责任”预先制造复杂的下放、监督或异步调度体系。
- 长任务应按阶段主动汇报。用户未必要求严格按预计时间完成，但长时间无信息会破坏仍在负责的信任；阶段长时间无结果时也要说明进展或卡点。
- 多项责任并存时，暂停、恢复、完成或取消必须唯一定位目标；消息、引用和上下文仍有歧义时先问，不猜“最近一项”。

## DSH 助理、Cron 与持久状态

- `focus` 是唯一互斥的用户时间焦点；普通委派 `delegated` 与长期监控 `monitor` 可以并行。任何多项修改若无法唯一定位，必须返回候选并保持零副作用。
- 时间驱动周期任务由 `dsh-cron` 持有时钟和每轮唤醒；`dsh-assistant` 只保存持续责任、关联任务、结果与异常认知。桥接走正式接口，不能直接改 cron 的 `jobs.jsonl`；只管理用户时间的焦点提醒可由 assistant reminder 负责。
- 用户的个人待办、`dsh-assistant` 当前责任账本和定时任务是三个不同事实源。`assistant_task_status` 只权威回答当前责任；用户问完整待办时，应按部署 workspace 指引读取个人任务事实，不能由空责任账本推断没有任务。
- 每项 Agent 责任复用一个 continuable child：暂停要 interrupt，恢复要 followup 同一 child。`subagent/end` 的 `completed` 只代表一轮结束，只有满足明确的 completed/blocked 结果合同才能收口；长期监控的普通 completed 是提前停止，不是完成监控。
- 最终结果只能有一个用户可见投递负责人。worker 的阶段 `report` 与终态 outbox 必须保持单一、可计数的完整消息链，不能重复投递。
- 恢复责任时，必须先持久化新 residency 的 run id，之后才清掉 `resume_requested`；否则旧轮次的 aborted 可能造成 active 但无 worker 的假状态。
- `dsh-assistant` 的提示和工具只能注入用户交互 root；`session-cron-*` 也是运行时 root。工具全局注册或无差别遍历 roots 会泄漏承诺正文和修改能力给无人值守任务。
- Web 与 Telegram 的执行责任隔离，但状态认知可只读互查：Telegram 仅在用户问起时查询 Web 任务并转述，不能轮询、控制或接管；陈旧 running 只能诚实报告无法确认，旧 writer 的迟到事件不能覆盖新 writer。

## 发布与数据边界

- 本机到 `herman.hermes` 的发布唯一入口是 `./release/dsh`。Harness、插件、Profiles、Skills 和运行依赖应从明确 Git commit 构建为不可变 Docker/OCI 镜像；开发、上线前测试和生产运行使用同一候选。不要直接同步源码、修改线上 selector、远程安装依赖或恢复已退役的源码发布方式。
- 镜像只保存不可变代码；`~/.dsh`、工作区、Session、SQLite、cron 状态、凭据、Telegram offset、附件与日志在镜像外持久化。日常开发使用停机快照的独立副本、测试凭据、假 Telegram 和无真实任务 cron 台账，不能访问真实 Telegram、领取生产任务或写生产目录。
- 生产候选先在镜像中完成测试；获准停机后停止 DSH 写入者、确认 writer=0 并生成一致快照，再用快照副本做上线前验证。只有候选镜像与 archive 摘要一致、必要的 Web/LAN、Telegram、cron、SQLite、offset 与宿主能力门通过，才能启动生产候选。
- 上线后保持 `awaiting-user-acceptance`，由用户完成真实 Telegram/Web 验收并执行 `./release/dsh accept` 后才固定为 `last-good`。`rollback` 默认只说明恢复方案；只有用户明确批准 `--approved` 才能恢复上一镜像及该次停机前数据。工具不得静默恢复、覆盖或删除回退边界。
- 现场故障只有在明确属于挂载、权限、Compose、路径或启动参数，且仍处于限定现场窗口时，才可现场修复后重验；原因不明、需改 Harness/插件、改变数据语义或无法在窗口内解决时，先报告。产品代码回本地修复、提交、重建唯一候选，禁止在线改源码。
- `herman.hermes` 替代试运行使用独立 Telegram bot 和独立 `~/.dsh` 写入状态，只按需读取 OpenClaw 的 workspace、记忆、技能和任务事实。在真实替代验收前，OpenClaw 保持其进程、cron、Session、记忆索引与 Telegram token 的唯一写入权。

## Telegram gateway

- Telegram 正文采用消息级投递：保留 👀、typing、引用、reaction 与最终交付，忽略 `assistant/chunk`；把完整 text + tool-call `assistant/message` 串行投递为不可编辑中途消息，再由 `summarizeTurn()` 权威收口最终文本。相同完整正文只能成功交付一次，是否自然且不重放需真实客户端验收。
- Gateway 只保证完整事件、不可编辑、串行投递与完整可见文本精确去重；Telegram 专属 `dsh-assistant` persona 决定是否表达中途消息与如何避免语义重放。不要在 gateway 依据句号、空行、字数、前后缀 diff 或相似度切分消息。
- 普通 Telegram reaction 不能假设支持 ✅/❌；终态 reaction 使用官方允许列表，并在真实客户端验证，不能只测请求 payload。
- 日常正文用 Bot API `sendMessage` + MarkdownV2；仅遇到明确的、不可重试的格式拒绝时，使用相同 `reply_parameters` 回退一次纯文本。429、5xx、超时或暧昧响应不得重发，避免双消息。入站优先读取 `message.quote.text`，以同时支持 Markdown 渲染和局部引用。
- `ignoreFeedbackFailure` 要同时捕获同步 throw：`action()` 在 `.catch()` 挂载前已经执行，测试 HTTP stub 缺方法会令同步 TypeError 穿透。
- 测试 `session/event` 时，Harness ctx 需 mock `on` 并捕获 handler 的 `emit(session, event)`；监听器按 `session === agent.session && event.seq >= firstSeq` 过滤，TurnFeedback 再按 turn/step 边界过滤。
- session-telegram 日志发生 seq 冲突时，先快照到 `~/.dsh/recovery/`；删冲突行后用 node:zlib `zstdCompressSync` 且 `ZSTD_c_checksumFlag=1` 逐行一帧重建。zstd CLI 单帧不满足“每个 header line 一帧”的读取约束。

## 已停止或需复审的历史路线

- `dsh-explore` 与 `dsh-browser-readonly` 已从源码树移除；不要把旧名称当作可编辑的现役模块。探索若再启用，应以当前 `skills/explore-opportunity` 和现场目录为准。
- `dsh-x-feed` 已不再是本仓库插件目录；现役业务运行时为 `x-feed`，其宿主数据目录仍可使用 `DSH_HOME/storages/dsh-x-feed`。不要因旧数据目录或测试 marker 推断旧插件仍存在。
- Harness preset、Anchored 机制和早期 token A/B 是开发者预览期证据，容易随上游提示拼装、工具 schema、事件载荷和插件挂载而折旧。除非当前方案失效、官方稳定实现或已合并社区方案出现，不主动重开自研扩展或旧 token A/B；需要使用时先核对当前来源和专项研究。

## 经验记录

- 2026-08-30：插件通过 `ctx.llm.stream` 手工发起的嵌套模型调用不会自动继承主会话 UI 的 `reasoningEffort`；Max、High、Low、Off 的外层切换都不能证明内部请求改变。只需要短结构化结果的内部判断应在 `GenerateOptions` 显式指定 `ReasoningEffortId('off')`，用请求参数测试锁定，并以真实 Web 普通入口同时验收 selected、empty 与刷新重进；否则单元测试和主会话档位都可能掩盖生产 `invalid_model_output`。
- 2026-08-29：同一 Docker archive 在本机 Podman 与远端 Docker 中载入后，engine image ID 可能不同。清理时本机候选只与 `candidate.imageId` 比较，远端镜像只与 `release.production.engineImageId` 及实际容器引用比较；不能跨引擎强求 ID 相等。
- 2026-08-29：正式 Docker release 的 `accept` 是不可逆承诺点：真实健康通过且 `current`/`last-good` 同指本次 release 后先将 `rollbackBoundary` 标为 `retired-at-accept`，再幂等清理旧大体积归档和无容器引用的精确镜像。指针、当前候选或 latest snapshot 元数据不完整及任何部分失败都只记录 `accepted-cleanup-incomplete` 并保留残留；重试同一 accepted release 只重试清理，不重复业务验收，不得用 engine prune 扩大范围；小体积 JSON、测试/验收/失败与清理回执永久保留。
- 2026-08-29：新增运行时包后，除更新正式拓扑的 `requiredBy` 外，还要把该消费者加入拓扑测试构造的最终插件目录；否则测试夹具会先因“拓扑声明了不存在的消费者”失败，遮住它原本要验证的缺链、冲突路径和越界目标。只删真实 `requiredBy` 会压绿测试却破坏发布依赖真相。
- 2026-08-29：任何用户功能实现前，必须用用户可见入口、亲自动作和预期结果定义验收；内部 ID、配置、fixture、日志和测试不能替代用户路径。经过同等生命周期边界后用户仍不可达时，返回需求层；形成入口所需的责任属于该纵向切面。
- 2026-08-28：仓库自管自动化按明确业务拆出 `automations/<business>/` 后，`automations/scripts/` 只保留跨业务支持代码；镜像的 Python 编译、shell 语法、OpenClaw 缺席和退役文件门禁必须递归覆盖整个 `automations/`，不能继续只检查旧的平铺 `scripts/`。直接执行的业务脚本若复用共享模块，也要验证从新目录独立加载时的导入路径。
- 2026-08-28：开发容器的最小生命周期单位应是 worktree 环境，不是每次交互 shell。`dev prepare` 为每个 worktree 创建一个带明确归属的固定 toolbox，`dev shell` 只 exec 进入它；多个终端共用该 toolbox，不创建或登记额外容器。`dev down`、`dev retire`、main 镜像换代和发版验收都按 worktree 整体停止并清理，避免 shell 状态、孤儿识别和人工资源窗口。
- 2026-08-28：不可变镜像中的源码可能由 root 拥有且对运行 UID 只读；`compileall` 这类只做语法验证的构建检查仍会默认回写 `__pycache__`。应把 `PYTHONPYCACHEPREFIX` 指向构建期临时目录，而不是放宽源码权限或让检查污染镜像输入。
- 2026-08-28：Git 的 `100644` 只约束可执行位，不会自动修复工作树实际为 `0600` 的读权限；rootless 容器挂载源码时，这种权限漂移会让宿主可读文件在容器测试中报 `EACCES`。`dev prepare` 前应核对版本化运行输入对容器映射用户可读。旧 OpenClaw 代码可以先按原字节导入用于审计，但调用者确认已 disabled、被替代或只能在 OpenClaw 内执行后，原始提交已足够保留证据，不应继续用 `legacy` 目录把它们伪装成当前可交付资产。
- 2026-08-28：Docker 发版清理不能依赖无边界的 engine prune。构建命令只清理自己创建的临时目录、失败候选、暂存归档和唯一标签；开发底座与正式候选必须有不同用途身份，每个任务 worktree 持有独立开发租约。main 更新时先让新底座通过完整准备再换租约、删旧底座，release、latest 或其他任务仍引用的镜像必须保留；正式 release 一旦 accepted，则全部旧开发环境失效，清理其隔离数据、租约和无 release 引用的开发镜像，但保留源码 worktree 供 rebase 后重建。
- 2026-08-28：容器已挂载整个 `/home/herman` 时，只删除 `.openclaw` 的单独 bind mount 仍会通过父挂载暴露宿主目录；要验证 OpenClaw 可完全不存在，需在开发和生产容器中用空 tmpfs 遮蔽该子路径，并让活动脚本测试拒绝 OpenClaw CLI、目录和插件 API 标记。
- 2026-08-28：容器与宿主只有数值 UID/GID 相同仍不够；OpenSSH 等工具会从容器的 passwd 记录解析默认用户目录，而不只看 `HOME`。挂载 `/home/herman` 的运行镜像必须让 UID 1000 在 passwd 中对应 `herman:/home/herman`，并在镜像自测中同时验证 `id`、`getent passwd`、`HOME` 和 `ssh -G` 的默认 `known_hosts` 路径。
- 2026-08-27：根 `AGENTS.md` 曾混入项目现状、历史实验和精确测试数量，导致每轮注入既长又容易过时。稳定规则留在 `AGENTS.md`；可复用经验改记此文件，并在使用前按任务关键词检索、以现场状态复核。
- 2026-08-27：Docker 首次切换完成真实验收后，旧 DSH systemd units、旧远端发布树、本地 `deployment/herman-hermes` 与第一次切换兼容代码均已退役；随后完成一次真实 Docker→Docker 发布与显式回退演练，证明发布、健康检查和数据恢复不再依赖旧系统。A12 完整 UI 回归所需的 `context-manager-telegram-canary` 只作为已提交构建验证 fixture 保留，不是生产发布运行时。
- 2026-08-28：rootless Podman 的容器 UID 1000 会映射到宿主 subordinate UID；对大型镜像使用 `keep-id` 会触发昂贵的递归改属主。源码开发应以容器 root 完成宿主挂载编译，再用 `setpriv` 降权运行权限敏感测试，并把 npm/XDG 缓存放进隔离 `/tmp`，避免读取快照 Home 中不可写的用户缓存。
- 2026-08-28：开发镜像不能按 worktree 重复构建。`release/dsh build --purpose development` 对完整 `origin/main` 只保留一份共享镜像，同一 main 直接复用且不生成归档；main 前进时新镜像自检通过后清除全部旧开发环境与旧开发镜像。每个 worktree 只拥有独立容器、网络、Web 端口和数据；共享 Podman 的 build、正式 save/load 验证及镜像清理由入口全局锁自动排队，不再人工抢窗口。
- 2026-08-28：全量产品测试属于共享 main 开发镜像的构建回执，不属于每个 worktree 的容器准备。`dev prepare` 只重新编译被可编辑挂载遮住的当前正式包集合，并验证快照隔离、Web、假 Telegram、空 cron、真实 Telegram 阻断和镜像身份；不要让环境创建重复执行 Vitest/Python unittest，也不要把长命令回执提前结束误判为准备失败。
- 2026-08-28：可编辑源码的正式 verify 应分开身份：rootless toolbox 的 uid 0 只写入挂载源码的 type/build/bundle；Vitest/Python 要以 Containerfile 的 `1000:1000` 运行，并在每次创建、该 uid 可写、结束清理的临时 HOME/npm/XDG/data 中执行且清空 `NODE_PATH`。否则会污染宿主输出所有权、让 chmod 权限测试失真，或让镜像预装依赖越过 runtime-package-topology 的模块边界。
- 2026-08-28：共享 development candidate 的 `tested` 不能只信候选字段；消费时须验证镜像测试回执文件存在、摘要匹配且回执 `imageId` 绑定该 candidate。editable verify 还须在前后对全部 tracked 与非忽略 untracked 输入的路径和字节取同一指纹；变化或显式取消时不签 verify 回执，并保留既有 toolbox 与租约。
- 2026-08-28：盘点 OpenClaw 依赖时不能只查任务声明或同名脚本；应同时核对实际状态库、启用任务的调用链、systemd、插件和跨主机入口。历史 `jobs.json` 路径可能已不存在，而现役状态已迁到 SQLite；文件存在或名称相同也不能证明仍在运行或内容一致。
- 2026-08-29：`release/dsh dev verify` 的可编辑源码指纹会把本次删除但尚未提交的 tracked 路径继续列入输入，随后因路径不存在而拒绝验证。替换测试合同时应先保留原 tracked 路径改写内容；在验证器支持删除与重命名的脏工作树前，不要用删除或重命名作为待验证改动。
- 2026-08-31：当前 `release/dsh dev verify` 已把缺失的 tracked 路径稳定记为 `deleted`，可以直接验证包含删除的脏工作树，本条取代 2026-08-29 的对应限制。但 `dev prepare`/`dev verify` 只挂载当前源码和运行脚本，不会执行改过的 `release/Containerfile`；删除运行包或改变镜像包清单时，还要运行发布合同、开发工具箱生命周期和语法检查，在 `self-test.sh` 保留旧目录不存在的负向断言，并留待正式候选构建执行镜像自检。
- 2026-08-29：中断的正式 Podman 构建可能留下多个通过共享层阻塞后续不同 commit 候选的 Buildah external storage 容器；删除物理构建目录后，测试候选中的清理回执必须继续保存中断构建 ID。只允许 `release/dsh` 在全局锁内，凭完整构建目录或既有回执、镜像删除报错中的精确 ID、有效 image ID、`buildah` 命令、`storage` 状态和落在构建窗口内的创建时间逐个移除；不得扩大为批量清理。该操作可能连带移除候选镜像，确认镜像确实不存在后应直接从已完成归档重载，其他“找不到镜像”仍须失败。
- 2026-08-29：Compose 的 Web 健康只证明 Web 容器就绪，不能证明随后才启动的 LAN 代理已经监听。生产启动必须对本机 Web 和 LAN 地址分别做有界等待；LAN 第一次连接拒绝若随后自然恢复，属于发布时序缺陷，不能手工补写 selector 或把失败 release 冒充成功。
- 2026-08-29：自动选择运行后端时，镜像测试不能只导入公共依赖；必须覆盖生产环境会被实际选中的后端及其条件依赖。BZP 镜像同时提供 `gatttool` 后会自动选择该后端，因此 `pexpect` 必须进入锁定依赖并由镜像 self-test 直接导入，否则单元测试和假 BLE 都可能通过、真实读表却在连接前失败。
- 2026-08-29：个人业务自动化源码归持久化 DSH Workspace，任务定义归 dsh-cron 账本；产品仓库只保留通用执行环境和 Workspace 编写指导，不保存业务脚本、重复 manifest 或 reconciler。发版只验证 DSH 产品，不安装、迁移、验收或回退 Rita、BZP、OOM 等 Workspace 业务设施；本条取代 2026-08-28 的“仓库自管 automations”路线。
- 2026-08-31：退休数据库旧 schema 兼容前，先同时证明当前 accepted image 只接受目标 schema、正在运行的数据和 latest 一致快照都已处于该版本，并确认回退边界已退休。`accepted-cleanup-incomplete` 留下的历史归档不等于当前支持的恢复输入；应保留残留而不读取或删除，也不应让它阻塞 current-only 兼容退休。
- 2026-08-30：业务 automation 由线上 Harness 维护时，候选不能把脚本字节或测试实现收入仓库，也不能假定入口已经存在。发布应在停机前只读核验 Workspace 中精确入口、接口版本、源码哈希和脱敏测试回执，停机后再核同一身份；缺失或漂移必须在写状态迁移前失败，release 只消费结果，不创建、覆盖、删除脚本或修复其 cron binding。
- 2026-08-30：线上 automation 的历史测试布尔不能替代本次发布的状态证据。首次外部初始化需用隔离假服务分别统计成功 GET、被拒 GET、变更和异常请求，并把返回 fixture 与本地正文镜像哈希对应；正文、状态和指纹三件 artifact 均应以 nofollow 身份、权限、长度和摘要进入脱敏回执，第二次运行必须三件都不变且零新增请求。
- 2026-08-30：Podman 的 `--tmpfs` 默认会把镜像目录或父 bind mount 的原内容 copy-up 到新 tmpfs；小容量 `/tmp` 会因此在容器启动前误报 ENOSPC，嵌套遮蔽目录也可能先读取本应隔离的父内容。本地 Podman 的临时目录和旧路径遮蔽必须显式使用 `notmpcopyup`，并用父目录 sentinel 验证容器不可见且宿主字节不变；生产 Docker Compose 保持 Docker 支持的 tmpfs 语法，因为 Docker 直接遮蔽既有内容而不做该 copy-up。
- 2026-08-30：Podman 容器接入自定义 bridge 时，`HostConfig.NetworkMode` 仍可能只显示 `bridge`，不能用它证明连接了哪张网络。跨 Podman/Docker 的隔离健康门应同时要求目标 network 自身 `Internal=true`，并从每个容器的 `NetworkSettings.Networks` 核验唯一成员就是本次 worktree 的内部网络。
- 2026-08-30：线上 Harness 首次创建 Workspace 业务 automation 不能伪装成普通镜像发布，也不能让模型直接写生产目标。应使用单独授权的一次性入口和当前 accepted 镜像，在无生产 Workspace/Notion/Cron 挂载的暂存区生成；由 release-owned 假服务黑盒门独立验证接口、脱敏、原子写和崩溃恢复后，再以目标必须不存在的目录级 `RENAME_NOREPLACE` 原子安装。仓库只保存通用隔离编排和可信验证器，不保存生成的业务源码或正确实现 fixture。
- 2026-08-30：Docker CLI 的 `--mount type=bind` 可写挂载应依赖默认可写语义，不能附加无值的 `rw` 字段；线上 Harness one-shot 又使用 `--log-driver none` 时，任务等待器必须把 stdout 直接丢弃、只从有界 stderr 流提取固定白名单错误码，并显式约束模型输出预算和重试次数，否则 Docker 参数错误或 `max-tokens`/API 失败只会坍缩成不可诊断的统一退出码。
- 2026-08-30：不写生产的 one-shot 状态快照仍必须同时持有本机和远端 production operation 共享锁，否则会与正常 `release`/`accept`/`rollback` 入口拼出撕裂状态；若入口从精确 Git commit 读取 helper，helper 未提交前只能做本地聚焦测试，不能把工作树字节当作真实正常入口验收。
- 2026-08-30：正式镜像和开发 toolbox 的 `/tmp` 都是 `noexec`；测试替身即使在临时目录中 `chmod 0755` 也不能直接执行。需要动态命令行为时，应让已知的绝对解释器读取临时的非可执行脚本，或执行已提交在可执行文件系统上的固定 fixture，并在宿主与 `1000:1000` 的 noexec toolbox 中各跑一次同一测试；不能为测试放宽挂载或生产 helper 的净化环境。
- 2026-08-31：Harness Notion automation 的 no-op `--retry-pending --json` 边界比字面更严：探针的 token_forbidden 转换把任何 token 触碰都算违规，包括预检 `os.lstat`；作者合同若同时写"每次调用先预检 token"和"no-op 不读 token"，模型会按字面实现预检 lstat 并通过只做 FIFO 检测的生成测试，直到 trusted probe 在崩溃恢复后的收敛阶段拒绝。合同必须显式声明 no-op 路径不得 stat/readlink/open/read 凭据（预检仅在执行操作时进行），生成测试须把 NOTION_TOKEN_FILE 换成父目录无搜索权限的路径证明任何路径解析都会失败（FIFO 或普通不可读文件都不能拦下纯元数据检查）。
- 2026-08-31：one-shot 失败清理后生产只读状态会因既有容器 `RestartCount` 上升而整体拒绝（`harness notion automation --status` 严格等于 0），且 `docker events`/journal 往往已无重启证据；此类漂移与 harness 代码无关时需要区分报告，不能当作 one-shot 隔离失败，也不能用入口外的 docker 操作擅自恢复。
- 2026-08-31：Harness authoring 模型被 lockdown 禁用全部执行工具（tool-bash/subprocess/code-runtime 均 disabled），只有 /work 内文件读写编辑工具；它无法自跑测试，也无法看到探针。one-shot 的迭代闭环在仓库侧：每次失败按探针/闸门证据修订作者合同后重跑，不能把"模型应自验"写进不可完成的指令，也不要把 trusted probe 已覆盖的崩溃矩阵强加给生成测试（单次盲写模型会因新增复杂度引入新的测试自身缺陷）。
- 2026-08-31：Notion automation 最终以"仓库侧本地实现+装载"路径完成：本地按合同实现后，用 `verify-harness-notion-automation.py --entrypoint <path>` 即可在本地跑完整 trusted probe 矩阵（12 命名检查 + 原子/崩溃/恢复/收敛），实现通过后再作为 runner 内嵌资产装载。注意：实现文件的 git mode 只能是 100644（git 不保存 0600），否则 `requireCurrentHeadReleaseTree` 的字节树校验（含 mode）会在 one-shot 前失败；runner 写出时再以 0600 create-only 落盘。
- 2026-08-31：authoring 模型（deepseek-v4-flash、无执行工具、单次盲写）经 13+ 次 one-shot 抽签无法稳定通过探针；且其模型/工具配置被 accepted release 的 harness 身份钉合（EXPECTED_HARNESS_COMMIT/harnessPatchSha256 与 production release.json 绑定），本任务授权范围内无法升级。最终授权改变任务路径（本地实现）后才完成。
- 2026-08-31：并行发布完成 accept 后，其清理可能删除另一个仍处于 `waiting-for-release-authorization` 的旧 release 所引用的本机 candidate archive；该旧 release 随后不能继续消费，且不能从缺失归档重建或手工补写。继续发布前必须重新读取 waiting receipt 与 archive/摘要，缺失时保持生产不变并以当前 accepted release 为唯一现场事实。
- 2026-08-31：`dsh harness notion-automation --approved` 的 CLI 通道曾稳定复现"ssh 退出码 4"：根因是同一个 `harnessNotionAssets` 集合同时保存 5 个编排资产和 2 个 local 资产，CLI 把 7 项全部写入 `payload.assets`，又单独写入 `localImpl/localTests`，而远程 loader 要求 `assets` 精确只有 5 项，故在 runner 启动前拒绝；手工 scp+ssh 载荷只含 5 项所以能成功安装。修复时应拆成编排/local 两个精确集合，并以回归测试同时钉住 CLI 集合和 loader 负例；目标已存在时，正式 CLI 应通过 loader 后由 runner 以 create-only 退出 6，且保持零残留。
- 2026-08-31：退休公开开发命令前要先查内部调用；旧 `dev up` 同时承担正式 release 停机后的候选预检。正确收缩是把候选启动验证私有化，并与 `dev prepare` 共用启动器，只删除公开 `up`、`synthetic`、`reset` 和专属接线，不能删除发布预检。
- 2026-08-31：通过 `ssh ... bash -s` 从 stdin 发送远端发布脚本时，脚本内的 `docker compose run` 若保持默认交互 stdin，会吞掉尚未被 Bash 读取的后续脚本并以 0 提前结束；表面上只剩前序命令 stdout，selector 和启动回执均未执行。所有这类 one-shot 必须统一使用 `--interactive=false --no-TTY`，并以合同保证没有绕过非交互 helper 的调用。
- 2026-08-31：HTTP fake 只能证明请求方法、路径和原子状态机，不能证明生产 `https://` transport；曾有 Notion automation 接受 HTTPS URL 却始终构造 `HTTPConnection`，全部假服务探针通过后才在真实 443 端口失败。协议合同必须分别锁定 HTTP/HTTPS constructor。若错误字节已作为 create-only Workspace 资产安装，普通 release 不得覆盖；兼容层只能精确绑定固定 endpoint、复用标准库 TLS、保持入口与 cron argv 不变，并由后续首次安装实现直接修正。
- 2026-08-31：accepted release 缺少 schedule reanchor evidence 时，只能在停机快照摘要门之后，从最小 `jobs.jsonl`/`runs.jsonl` 隔离副本精确恢复；job projection、migration input、逐任务 schedule hash、next-run 和记录数任一不符都保持 conflict，只有完整不存在才可新建 migration。`dev prepare` 会清空隔离 cron 定义，不能据此判断生产快照漂移。
- 2026-08-31：Schemastery 可能把省略的嵌套 object 配置实体化为 `{}`；直接把 TypeScript 对象传给启动函数的测试无法发现这种运行时漂移。可选嵌套对象必须在 schema 中显式保留 `undefined`，并让回归测试先经过真实导出的 `Config(...)` 解析器；下游控制合同仍需独立严格验证，不能只信 schema。
- 2026-09-01：profile 启动时 `ensure` 受管 command binding，并由普通 Agent 的 `cron_list` 隐藏、`cron_delete` 按不存在处理，才能同时建立启动恢复和运行期所有权；必须用真实配置解析、隔离候选启动和 tombstone 后重启测试覆盖这条链。上述证据齐全后，生产发布只需等待通用 cron 控制面就绪并做真实业务验收，不应再复制一套绑定 argv、入口哈希和回执结构的 Notion 专用发布闸门。
- 2026-09-01：退休未上线的运行包时，先从仍需保留的真实入口切断它的源码依赖，再删除整包和正式接线；镜像包清单、开发挂载、profile manifest、runtime topology、发布夹具与自检必须同步收缩，并保留旧包目录不得出现的负向门。已删除的 cron job 和不再读取的旧账本保持原状，不应为了“清理干净”增加数据迁移或物理删除。
- 2026-09-01：改正式包集合后，脏工作树的 editable verify 可能被既有 `tsbuildinfo` 和已安装工作区依赖掩盖；本次正式 clean build 才发现五包的 Cordis `"*"` 会解析到 registry 4.0.2，与 Harness workspace 4.0.1 并存，导致 `session/event` 和 `invariants` 模块扩展消失。Harness 内运行包应把 Cordis 的 peer/dev 依赖绑定为 `workspace:*`，并在编译前和镜像 self-test 以真实解析路径证明五包只使用 Harness workspace 的同一份 Cordis；修改包清单后仍须由全新不可变候选验证安装解析。
- 2026-09-04：直接执行 Harness 的构建后 CLI 时，`--dump-config` 成功不代表插件可加载；其 loader 只有在 Node 带 `--expose-internals` 时才启用 Profile/Harness 的自定义模块解析。启动入口合同必须锁定该 Node 参数，并以隔离 Profile 的真实插件树初始化确认没有 `ERR_MODULE_NOT_FOUND`。
- 2026-09-04：普通归档部署应把“打包并上传”和“目标机校验、安装、切换、启动”拆成两个入口，上传端不得隐式远程执行。`herman.hermes` 有满足要求的 Node 与 corepack 但没有独立 pnpm；远程启动可在 release 私有目录生成 `corepack pnpm` shim 供 Harness 插件管理器使用，不全局安装依赖，也不形成 dev/prod 代码分支。
- 2026-09-04：从历史 commit 提取业务源码时，要把“提取来源”与“当前仓库清理分支的基线”分开：新仓可从固定历史快照取字节，原仓删除必须基于最新 `origin/main`。若把历史来源 commit 同时当作清理基线，隔离 `dev prepare` 会先暴露历史 profile 与当前 Harness 的兼容问题，既不能证明清理正确，也会把无关历史提交带进任务分支。
