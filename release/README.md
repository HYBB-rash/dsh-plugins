# DSH Docker 发版系统

这个目录是 DSH 唯一发版入口。它把 Harness、五个正式运行包、Profiles、Skills 和运行依赖构建成一个不可变镜像；`~/.dsh`、工作区和业务数据只从镜像外挂载。线上不再安装依赖、构建源码或切换源码 selector。

## 不会偷偷发生的事

- `build` 只接受 Harness 和产品插件两个完整 Git commit，并分别用 `git archive` 取源码。Dockerfile、Profiles 和验收脚本单独取当前分支 HEAD 的精确发版工具 commit；正式 `build` 在归档前还会比较当前整棵 `release/` 与该 commit 的 archive，任何字节漂移都会硬停止。候选清单同时记录三者，未提交文件、旧 `node_modules` 和原工作树里的旧部署目录不会进入镜像。
- `release` 默认只打印停机影响和回退边界，退出码为 `3`。明确添加 `--approved-stop` 也只停止生产写入者并制作完整快照；随后仍须另行取得生产发布授权，使用 `--approved-release` 才会迁移和启动候选。
- `credential notion` 默认只打印目标、影响和批准后的准确命令，不读取 stdin、不写生产。凭据写入授权与停机、发布授权彼此独立。
- `harness notion-automation` 默认只打印一次性创建目标、隔离边界和准确批准命令，不连接生产。它是线上 Harness 创建自己业务代码的独立授权门，不属于凭据、停机、发布、验收或回退授权。
- Harness one-shot、凭据写入、生产停机、生产发布、真实业务验收后的 `accept` 和 `rollback` 都是彼此独立的授权门。任一批准都不能推导出其他批准；缺少当前步骤的明确批准时，流程只报告证据和下一步。
- Git merge 和 push 也分别需要独立授权；候选构建、生产授权或验收结论都不能替代这两个授权。
- `rollback` 默认只报告方案。只有明确添加 `--approved` 才会恢复数据和旧运行版本。
- 发版脚本不要求 OpenClaw 存在，也不会停止、重启或配置它；DSH 容器用空 tmpfs 遮蔽 `.openclaw`，避免残留目录成为隐式依赖。

## 常用流程

```bash
# 请求最新 main 的唯一开发基础镜像。同一 main 重复调用会直接复用，
# 只有 main 前进后第一次调用才真正构建并完成全量测试；这不是正式发版候选。
./release/dsh build \
  --purpose development \
  --harness-ref b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
  --plugins-ref "$(git rev-parse origin/main)"

# 每个 worktree 从上述已测试镜像创建自己的容器、网络、端口和数据副本；
# 只编译被挂载覆盖的可编辑源码，不重复运行全量测试。
./release/dsh dev prepare \
  --source "$(git rev-parse --show-toplevel)"

# 进入该 worktree 已有的固定 toolbox 容器；不会再创建 shell 容器
./release/dsh dev shell

# 显式验证当前 worktree（包括未提交改动）：只 exec 同一个 toolbox，
# 重新 type/build/bundle 后执行全部 TypeScript 与 Python 测试。
./release/dsh dev verify --source "$(git rev-parse --show-toplevel)"

# 内循环只验证一个已挂载包；x-feed 同时包含其 Python 测试。
./release/dsh dev verify --source "$(git rev-parse --show-toplevel)" --package x-feed

# 任务结束时只删除该 worktree 的容器和隔离数据；共享 main 镜像保留
./release/dsh dev down
./release/dsh dev retire --source "$(git rev-parse --show-toplevel)"

# 从两个精确提交构建唯一候选镜像
./release/dsh build \
  --purpose release \
  --harness-ref b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
  --plugins-ref <40位插件commit>

# 只检查 Notion 凭据目标和影响；不读 stdin、不改生产
./release/dsh credential notion

# 这是独立的生产凭据写入授权。token 只能从 stdin 进入，不得放入 argv 或环境变量；
# 已有不同 token 时还必须显式添加 --replace。
./release/dsh credential notion --stdin --approved < /path/to/secure-token-input
./release/dsh credential notion --stdin --approved --replace < /path/to/secure-token-input

# 只预览线上 Harness 首次创建 Notion automation 的目标和隔离边界；
# 返回退出码 3，不连接生产、不读取凭据、不创建业务代码。
./release/dsh harness notion-automation

# 这是独立的 Harness one-shot 授权。仅允许 herman.hermes，且目标目录必须不存在；
# 不授权停机、发布、真实 Notion 调用、Cron 变更、accept 或 rollback。
./release/dsh harness notion-automation --approved

# 第一次调用只申请停机，不改生产
./release/dsh release --candidate /path/to/candidate.json

# 用户明确批准停机后才执行；此命令只停止 writers、制作一致快照，
# 然后返回 waiting release ID，不会迁移、传输、加载或启动候选。
./release/dsh release --candidate /path/to/candidate.json --approved-stop

# 用户基于停机快照证据另行明确批准生产发布后，才从 waiting release 继续。
# 不能与 --approved-stop 合并，也不能由停机授权推断。
./release/dsh release --release <release-id> --approved-release

# 若停机后不再继续发布，waiting release 已有完整快照和上一 accepted image，
# 可直接进入独立 rollback 授权门；不需要也不得先补 --approved-release。
./release/dsh rollback --release <release-id>
./release/dsh rollback --release <release-id> --approved

# 真实 Telegram、Web、Notion 任务接口、Cron、提醒和记忆验收通过后，
# 逐项填写固定 schema；不允许附加说明正文、任务内容或其他字段。
cat >/path/to/dsh-acceptance-v1.json <<'JSON'
{
  "schemaVersion": 1,
  "checks": {
    "telegramWebTaskQuery": true,
    "notionReversibleTask": true,
    "temporaryMonitorLifecycle": true,
    "shanghaiReminder": true,
    "dailyCronNextRuns": true,
    "existingMemoryFact": true,
    "noLegacyPathEacces": true,
    "assistantSqliteIntegrity": true
  }
}
JSON

# accept 是不可逆的最终承诺点；缺项、false、额外字段或正文都会被拒绝。
# 若返回 accepted-cleanup-incomplete，修复清理错误后对同一 release 重试，
# 不再提供 --evidence，也不会重复真实业务验收。
./release/dsh accept --release <release-id> --evidence /path/to/dsh-acceptance-v1.json

# 只有 accept 前可以回退。accept 后即使清理尚未完成也会立即拒绝 rollback。
# accept 前，回退命令第一次只报告方案；用户明确批准后才能真正恢复。
./release/dsh rollback --release <release-id>
./release/dsh rollback --release <release-id> --approved

# 两类事故注入：挂载问题可现场恢复；业务源码错误必须阻止候选生成
./release/tests/fault-injection.sh /path/to/candidate.json
```

状态默认存放在 `~/.local/share/dsh-container`。可以用 `DSH_RELEASE_STATE_ROOT` 指向测试目录。本地默认使用 Podman；生产默认通过 SSH 连接 `herman.hermes` 并使用 Docker Compose。镜像不经过镜像仓库。

生产启动会分别等待本机 Web 入口、LAN 代理入口和 cron 控制面就绪。不得把 Web 容器的健康状态当成刚启动的 LAN 代理已经可达；两个入口在各自的有界等待后仍失败，发布才会停止并保留回退边界。

本机 Podman 构建显式使用目录内的 `containers-policy.json`，不修改用户全局容器配置。该策略不额外要求镜像签名；基础镜像身份由 `image.lock.json` 中不可变的完整 digest 锁定。

正式发版候选仍会在删除其唯一标签后重载 Docker archive，证明归档可以恢复同一个 image ID。这个共享存储敏感段和所有镜像构建、验收清理都由 `release/dsh` 的全局锁自动排队，不需要 Agent 人工协调窗口。若某次正式构建被中断，Podman 可能留下一个通过共享镜像层阻塞后续候选的 Buildah 外部存储容器；下一次构建只有在同时找到完整的未完成正式构建目录或先前测试候选保存的清理回执、删除报错中的精确容器 ID、有效 image ID、`buildah` 命令、`storage` 状态，并确认容器创建时间落在该中断构建开始后的 30 分钟内时，才会移除这个外部残留并记录到 candidate。清理回执会持续保存匹配的中断构建 ID，使一个构建留下的多个外部残留可以在后续构建中逐个受控清除，而不扩大成批量清理。清理该残留可能同时移除候选镜像；流程会在确认目标镜像确实不存在后直接从已写完的归档重载，其他“找不到镜像”仍视为失败。普通容器、运行容器、创建时间不属于已确认构建或身份不明的外部容器仍会硬停止，流程不会执行全局清理。若 `/dev/shm` 至少有 8 GiB 可用空间，正式归档会自动在那里暂存，重载成功后再复制到证据目录；也可用 `DSH_RELEASE_ARCHIVE_STAGING_ROOT` 指定其他临时文件系统。暂存归档未完成摘要校验前不会生成正式 `candidate.json`。

构建工作目录、未完成候选、失败构建标签和归档暂存文件都会由本次命令清理。开发底座与正式候选用途严格分开，开发底座不能发布。development 在镜像构建阶段完成五个包的构建、TypeScript/Python 全量测试和镜像自检，但不生成、保存或重载 Docker archive；它按完整 `origin/main` commit 使用稳定身份，本机始终只保留最新 main 的一份开发镜像。同一 main 的重复 build 在锁内确认镜像和测试回执后直接复用。main 前进时先完成新镜像构建和自检，再停止并删除所有旧开发容器、隔离数据、租约和旧开发镜像；旧开发候选的 JSON 与测试回执标记为 retired 后继续作为小体积历史证据保留，源码 worktree 始终保留。

每个 worktree 的开发环境使用路径摘要派生的独立 toolbox、Web、Telegram、假 Telegram、假 Notion 容器和无外网内部网络。所有容器都带有同一个 worktree 身份；一套环境是最小生命周期单位。因此多个任务可以从同一只读 main 镜像并行运行，`dev down`、`dev retire`、main 镜像更新和正式发布验收都只按 worktree 整体停止和清理。不得恢复固定的全局容器名，也不得直接调用 Podman 或执行全局 prune。

`dev prepare` 创建并持续运行该 worktree 的固定 toolbox；`dev shell` 只用容器引擎的 exec 进入它，不创建新容器、不登记 shell 状态。`dev verify` 同样只 exec 这个既有 toolbox，不新建验证容器、不写入生命周期状态；因此 shell、verify 和其他 worktree 可以并发。交互终端断开只会结束本次 bash，不会产生需要另行识别的容器。一个 worktree 可以同时打开多个终端，它们都进入同一个 toolbox；清理时只需要销毁整套 worktree 环境。

正式发版的生产快照测试副本和临时开发副本在测试结束或失败后都会清理。生产候选启动后、用户执行 `accept` 前，当前候选与上一 accepted 版本两代完整材料同时存在，停机快照与上一镜像共同构成完整回退边界。流程不会执行无边界的 `podman system prune` 或 `docker system prune`。

个人业务 automation 的运行时所有者是持久化 `$DSH_HOME/workspace/automations/`；安装后的源码、交接回执和任务定义分别由 Workspace 与 dsh-cron 账本持有。仓库可为一次性首次创建入口保存经过 trusted probe 验证的 bootstrap 实现和测试，但普通 build、release、migration 和 rollback 不把这些 bootstrap 字节安装进产品镜像，也不覆盖、删除、迁移或回退已存在的 Workspace automation。镜像只提供通用解释器、命令行工具、产品 Skill 行为和 Harness 指导；发布只读检查既有入口是否满足候选合同，缺失或漂移时停止。固定 profile 声明的受管 Cron binding 由 `dsh-cron` manager 在 control socket ready 前以 create-only 语义持久化：完全一致时重启幂等，冲突时启动失败；发布健康检查只调用 readiness/get，不会 ensure、replace 或修复 binding。

`harness notion-automation --approved` 是这条规则的窄而显式的首次创建入口，不是生产发布。当前确定性路径把 Git commit 绑定的 bootstrap 实现和测试作为独立 payload 交给隔离 runner；缺少该 payload 时才回退到线上 Harness 的两阶段 authoring。fallback 只开放 workspace-write sandbox 内的有界前台 bash，让作者运行编译检查和生成测试；持久 shell、后台 jobs、code-runtime、子代理和外网仍禁用。两条路径都运行在独立只读容器、临时 DSH_HOME 和无生产 Workspace/Notion token/Telegram/Cron 挂载的边界内，并必须在无外网假 Notion 上通过十二项独立合同门、原子写入与逐 rename 崩溃恢复门，随后才以 `renameat2(RENAME_NOREPLACE)` 把整个目录 create-only 安装到准确目标。目标已存在、accepted 身份漂移、生产容器不健康、测试自报、秘密泄漏、Docker 清理不完整或任一门失败都会保持目标原状；该命令不访问真实 Notion、不改 Cron、不停服务，也不授予后续发布权限。

Notion 任务入口同样由线上 Harness 维护，准确入口为 `$DSH_HOME/workspace/automations/notion/notion_inbox_sync.py`，交接回执为同目录的 `notion_inbox_sync.handoff.json`。正式发布在请求停机之前只读核验这两个文件的身份、owner、大小、入口 SHA-256 和接口，并把脱敏 handoff 身份与哈希锁入 waiting release；入口或回执缺失、不安全、漂移或不匹配都会在 writers 仍运行时阻断，发版不会用仓库或镜像内容补齐它们。停止 writers 后还会要求现场结果与停机前锁定的回执完全一致，避免把停机前看到的脚本替换成另一份脚本。

交接回执是严格的 schema v2 脱敏证据，只允许 `schemaVersion`、`interfaceVersion`、`artifactContract`、`entrypointSha256`、`testReceiptSha256`、`testedAt` 和 `tests`。`artifactContract.interfaceVersion=1`，并把本地状态固定为权限 `0600` 的 `state={role: state, path: storages/task-inbox/sync-state.json}` 与 `fingerprint={role: fingerprint, path: storages/task-inbox/notion-fingerprint.json}`；正文镜像仍由 `NOTION_INBOX_FILE` 固定在 `storages/task-inbox/inbox.md`。`tests` 必须准确包含并全部通过 `atomicArtifacts`、`firstPull`、`read`、`set`、`push`、`pendingRetry`、`conflict`、`force`、`networkRecovery`、`pullFailureNoPending`、`noPendingNoApi` 和 `secretRedaction`。入口还必须声明 `pull/set/push/force/retry-pending/json` 接口与 `NOTION_TOKEN_FILE`、`NOTION_INBOX_FILE`、`NOTION_API_BASE`、`NOTION_PAGE_ID` 配置接口，并不得引用退役路径或 OpenClaw。候选清单只声明业务 automation 的 owner 是 `live-harness-workspace` 且 `includedInCandidate=false`；发布回执只记录入口、交接回执及外部测试回执的哈希、大小、接口版本和测试时间，不记录 automation 实现、私有配置值、token、Authorization header、完整 HTTP 请求、任务正文或私人 Workspace 内容。

首次任务镜像初始化只允许 mirror、state 和 fingerprint 三个 artifact 全部不存在；发版通用包装器随后调用上述线上脚本的 `--pull --json`，按接口合同只对固定 Notion 页面执行 GET。只有脚本返回结构化 `status=synced`，且三个 artifact 都是正确 owner、权限 `0600`、硬链接数为 1、读取前后身份稳定的普通文件时才继续；任一 artifact 单独存在、缺失、不安全或读取中变化都 fail closed。三个 artifact 已全部存在时，包装器只读核验后返回 `already-initialized`，不启动脚本也不访问 Notion。初始化回执对每个 artifact 只保存 `role`、相对 `path`、`mode`、文件字节 `length` 和 SHA-256，并保存入口、handoff 与外部测试回执哈希；不保存 mirror、state、fingerprint 的正文或任何私有值。

上线前的停机快照副本会使用同一候选镜像、同一线上 Harness-owned 入口字节和一份额外隔离副本，在专用无外网内部网络中对通用 fake Notion sidecar 执行首次只读 GET 初始化；第二次调用必须直接返回已有 artifact 且 sidecar 请求计数不增加。两次回执中的 mirror、state、fingerprint 三份 `role/path/mode/length/SHA-256` 证据必须逐项完全不变。该门只证明已交接入口能在假服务上原子生成三个 artifact，并完成首次 GET 与第二次幂等 no-op，不把业务脚本、测试实现、artifact 正文或私有值收入仓库、镜像或候选。入口或 handoff 尚未由线上 Harness 提供时，发布必须在停机前阻断，不能由仓库 fixture 代替。

`accept` 是不可逆的最终承诺点。`--evidence` 必须是字段精确的结构化 JSON：`schemaVersion=1`，且上述八个固定 `checks` 必须逐项为布尔值 `true`；缺项、`false`、额外字段、说明正文、任务内容或私人事实都会在任何远端动作前被拒绝。命令只把规范化清单转换成固定摘要、SHA-256、UTF-8 字节长度、记录时间、版本化清单及通过计数；`release.json` 不保存输入 JSON、说明原文、任务正文或私人事实。真实健康验证通过并确认远端 `current`/`last-good` 同指本次 release 后，`release.json` 会记录 `rollbackBoundary.status=retired-at-accept`；从这一刻起不再支持恢复上一版本，清理失败也不会撤销 accepted。随后入口在同一全局镜像锁内幂等收敛正式材料：本机只保留当前 accepted candidate 的目录、`image.tar`、镜像测试回执和 Podman 镜像；远端只保留当前 release 的 `image.tar`、Compose、candidate 文件和正在运行的 Docker 镜像；本机与远端只保留 `snapshots/latest.json` 精确引用的一份一致生产快照归档。latest 生产快照继续保留给后续 `dev prepare` 使用。`accepted-cleanup-incomplete` 重试不再接收新 `--evidence`，且只有已保存的脱敏验收回执和健康回执仍精确符合当前 schema 时才继续清理；任何旧格式或漂移都会 fail closed。

其他历史 `release.json`、`candidate.json`、镜像测试回执、上线前测试/验收/失败回执、摘要、只含 SHA-256、长度、固定清单和计数的脱敏用户验收回执，以及每次清理回执都会保留；用户验收说明原文不会落盘。流程只删除 state root 内能由精确元数据识别、且没有容器引用的大体积归档和镜像。本机 Podman 镜像按 `candidate.imageId` 核对，远端 Docker 镜像按 `release.production.engineImageId` 核对；同一 archive 被两个引擎载入后的镜像 ID 不要求相同。失效的 `candidates/latest.json` 会一并删除。指针、当前候选或 latest snapshot 元数据不完整，容器仍引用旧镜像，或远端只完成部分操作时，结果为 `accepted-cleanup-incomplete`、退出码 `6`；`status` 会显示残留。对同一 accepted release 再次执行 `accept` 只重试清理，不重复 Telegram/Web 业务验收。每次 `cleanup` 回执都记录 `status`、受保护对象、本机/远端删除与保留对象、前后字节、错误和完成时间。

正式 release 完成 `accept` 后，本地开发环境和共享开发镜像立即失效并清理；任务源码 worktree 原样保留。未完成任务下次继续时，必须先同步新 main，请求最新 main 的唯一开发镜像，再执行自己的 `dev prepare`。

开发和预发布都禁止 host network。开发态的 Telegram、Web、cron 和测试 sidecar 只连接无外网内部网络；预发布中不需要 sidecar 的门使用 `--network none`，需要 fake Telegram/Notion 的运行门只使用本次隔离副本的专用内部网络。Harness Web 仍只绑定容器自己的 loopback，健康检查通过容器内 `curl` 完成，不为方便本机浏览器而恢复 host network；若以后需要交互浏览器入口，必须另设显式且只监听宿主 loopback 的受控 relay。Notion 测试只访问通用 fake sidecar 的固定 GET 页面；sidecar 不包含任务同步业务，也不读取 Workspace automation、生产 token 或私人正文。生产容器固定使用 `1000:1000`；本机 rootless Podman 为了让快照副本保持宿主用户可读写，在容器内显示为 uid 0，但仍映射为宿主普通用户，不获得宿主 root 权限。

`dev prepare` 是源码开发入口，不是测试或发版入口。它在准备开始和完成后都会重新 fetch：独立任务分支必须包含最新 `origin/main`，开发基础镜像的插件 commit 也必须精确等于该 `origin/main`；期间 main 一旦更新，就停止并要求 rebase、重建基础镜像和重新准备环境。正式 `build` 和 `release` 也会拒绝任何没有基于最新 `origin/main` 的产品或发版工具 commit。它只下载已有的一致生产快照，不会为开发申请停机或在线生成快照；远端没有快照、摘要不匹配或下载失败都会停止，不会退回合成数据。Harness 始终使用 `harness.lock.json` 的只读固定 commit。五个正式运行包、Skills、Profiles、runtime topology、materializer 和镜像运行脚本都从独立 worktree 可写挂入；镜像根文件系统仍为只读，编译产物留在 worktree 的忽略目录。由于可编辑挂载会遮住镜像内预构建的 `lib`，`prepare` 只快速重新编译五个包，然后检查 Web、假 Telegram、空 cron、真实 Telegram 阻断和镜像身份；它不重复 Vitest 或 Python unittest。需要验证当前未提交源码时，显式执行 `dev verify`：它在 rootless toolbox uid 0 中重做当前范围的 type/build/bundle，避免改变宿主挂载源码的 ownership；随后以 Containerfile 相同的 1000:1000 身份、Harness、Vitest 配置和默认模块解析跑 TypeScript/Python 测试，以保留 chmod 等权限测试语义。验证专用 HOME、npm/XDG cache 与 Python data 均在 toolbox tmpfs 中创建、仅交给 1000:1000 并在结束时清理，且清除外部 `NODE_PATH`，避免污染模块拓扑边界。回执同时列出共享 main 镜像的全量测试回执与本次 editable source 的状态摘要；后者不是可发布候选。生产目录和真实凭据不会被挂载。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `2` | 参数或输入错误 |
| `3` | 正在等待用户授权，未修改生产 |
| `4` | 安全门失败 |
| `5` | 构建或测试失败 |
| `6` | 生产启动/验收失败，或验收已成功但清理不完整 |

## 固定边界

- 产品代码和发版工具都来自清单记录的精确 Git commit；正式 `build`、生产 `release`、`approved-release`、`accept` 和 `rollback` 都会拒绝当前 `release/` 整树与绑定 commit 的任何字节漂移，候选中的 `release/` 只取该 commit 的 archive。工作树中的未提交文件不会进入镜像。
- `release` 在获得停机许可前不停止任何写入者；许可只覆盖该次候选和该次停机窗口，不覆盖生产发布。
- `harness notion-automation` 未批准时只返回计划。批准后也只允许在 `herman.hermes` 的稳定 accepted 运行边界中 create-only 安装一个此前不存在的 Harness-owned 目录；它不消费候选、不切换镜像，也不能替代任何发布授权。
- `--approved-stop` 只停止全部 writers 并做一致快照，然后固定为 `waiting-for-release-authorization`。只有另一次 `--approved-release` 才允许用 scrub 后的快照副本测试、执行迁移、传输候选和启动生产；它必须用 `--release <release-id>` 消费这份已存在的 waiting receipt，不能同时再传 candidate，也不能把停机批准当作发布批准。
- `waiting-for-release-authorization` 已具备完整停机快照和上一 accepted image，可不经过生产发布授权直接请求 `rollback`；真正恢复仍须单独添加 `rollback --approved`，停机授权或生产发布授权都不能代替回退授权。
- 快照副本在进入任何候选容器前清除真实 Telegram、Harness、Notion 凭据和外部写入能力；测试失败时生产保持停止并报告，不在线改产品代码。
- 明确属于挂载、权限、Compose、路径或启动参数的发版小问题，可在限定现场窗口内修正后重新验收；需要改 Harness、插件、数据语义或原因不清时，先向用户报告。只有用户批准后才能回退。
- 上线后状态先是 `awaiting-user-acceptance`。真实 Telegram、Web 和本次产品改动验收通过并执行 `accept` 后，该镜像才成为 `last-good`，随后只保留当前正式版本自身的恢复材料与 latest 生产快照。本次明确纳入的 Notion 任务入口、镜像和冲突/离线行为属于产品接口验收；其他无关 Workspace 业务任务仍不属于本次产品发版边界。
- 回退默认只打印恢复对象、快照和影响；只有 accept 前且显式添加 `--approved` 才能恢复上一 Docker 镜像及对应停机前数据。accepted release 在任何远端恢复动作前都会被拒绝。
- OpenClaw 始终在流程外且可完全不存在：不得停止、重启、改配置或接管其写入权，DSH 也不得读取它的目录、凭据、CLI、插件或状态。

## 已完成的切换

2026-08-27，首个 Docker release `20260827T124411650Z-a12dfe07e92b` 已通过真实验收并固定为 `current`/`last-good`。旧 systemd units、旧远端发布树、旧本地 `deployment/herman-hermes` 和第一次切换兼容代码均已删除。

同日使用候选 `20260827T143452209Z-a12dfe07e92b` 完成了一次真实 Docker→Docker 发布与回退演练：候选以同一镜像完成上线前测试和生产启动，随后经显式授权恢复到上述 `last-good`；容器、Web loopback/LAN、Telegram/cron、SQLite、offset 和 JSONL 均通过回退后验证，OpenClaw 未发生变化。以后发布和回退不再依赖旧源码发布树或旧 DSH systemd unit。
