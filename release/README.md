# DSH Docker 发版系统

这个目录是 DSH 唯一发版入口。它把 Harness、六个插件、Profiles、Skills 和运行依赖构建成一个不可变镜像；`~/.dsh`、工作区和业务数据只从镜像外挂载。线上不再安装依赖、构建源码或切换源码 selector。

## 不会偷偷发生的事

- `build` 只接受 Harness 和产品插件两个完整 Git commit，并分别用 `git archive` 取源码。Dockerfile、Profiles 和验收脚本单独取当前分支 HEAD 的精确发版工具 commit。候选清单同时记录三者，未提交文件、旧 `node_modules` 和原工作树里的旧部署目录不会进入镜像。
- `release` 默认只打印停机影响和回退边界，退出码为 `3`。只有明确添加 `--approved-stop` 才会停止生产写入者。
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

# 只验证一个已经存在的不可变候选时，仍可使用原来的 dev up
./release/dsh dev up --snapshot synthetic --candidate /path/to/candidate.json

# 同一候选再次 up 会复用开发数据；确实要从快照重建时才加 --reset
./release/dsh dev up --snapshot synthetic --candidate /path/to/candidate.json --reset

# 从两个精确提交构建唯一候选镜像
./release/dsh build \
  --purpose release \
  --harness-ref b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
  --plugins-ref <40位插件commit>

# 第一次调用只申请停机，不改生产
./release/dsh release --candidate /path/to/candidate.json

# 用户明确批准停机后才执行
./release/dsh release --candidate /path/to/candidate.json --approved-stop

# 真实 Telegram 和 Web 验收通过后
./release/dsh accept --release <release-id> --evidence '真实 Telegram 单条回复且 Web 正常'

# 回退命令第一次只报告方案；用户明确批准后才能真正恢复
./release/dsh rollback --release <release-id>
./release/dsh rollback --release <release-id> --approved

# 两类事故注入：挂载问题可现场恢复；业务源码错误必须阻止候选生成
./release/tests/fault-injection.sh /path/to/candidate.json
```

状态默认存放在 `~/.local/share/dsh-container`。可以用 `DSH_RELEASE_STATE_ROOT` 指向测试目录。本地默认使用 Podman；生产默认通过 SSH 连接 `herman.hermes` 并使用 Docker Compose。镜像不经过镜像仓库。

本机 Podman 构建显式使用目录内的 `containers-policy.json`，不修改用户全局容器配置。该策略不额外要求镜像签名；基础镜像身份由 `image.lock.json` 中不可变的完整 digest 锁定。

正式发版候选仍会在删除其唯一标签后重载 Docker archive，证明归档可以恢复同一个 image ID。这个共享存储敏感段和所有镜像构建、验收清理都由 `release/dsh` 的全局锁自动排队，不需要 Agent 人工协调窗口。若某次正式构建被中断，Podman 可能留下一个通过共享镜像层阻塞后续候选的 Buildah 外部存储容器；下一次构建只有在同时找到完整的未完成正式构建目录、删除报错中的精确容器 ID、有效 image ID、`buildah` 命令和 `storage` 状态时，才会移除这个外部残留并记录到 candidate。普通容器、运行容器、身份不明的外部容器仍会硬停止，流程不会执行全局清理。若 `/dev/shm` 至少有 8 GiB 可用空间，正式归档会自动在那里暂存，重载成功后再复制到证据目录；也可用 `DSH_RELEASE_ARCHIVE_STAGING_ROOT` 指定其他临时文件系统。暂存归档未完成摘要校验前不会生成正式 `candidate.json`。

构建工作目录、未完成候选、失败构建标签和归档暂存文件都会由本次命令清理。开发底座与正式候选用途严格分开，开发底座不能发布。development 在镜像构建阶段完成六个包的构建、TypeScript/Python 全量测试和镜像自检，但不生成、保存或重载 Docker archive；它按完整 `origin/main` commit 使用稳定身份，本机始终只保留最新 main 的一份开发镜像。同一 main 的重复 build 在锁内确认镜像和测试回执后直接复用。main 前进时先完成新镜像构建和自检，再停止并删除所有旧开发容器、隔离数据、租约、旧候选和旧开发镜像；源码 worktree 始终保留。

每个 worktree 的开发环境使用路径摘要派生的独立 toolbox、Web、Telegram、假 Telegram 容器和内部网络，并在一个短状态锁内分配独立 Web 端口。所有容器都带有同一个 worktree 身份；一套环境是最小生命周期单位。因此多个任务可以从同一只读 main 镜像并行运行，`dev down`、`dev retire`、main 镜像更新和正式发布验收都只按 worktree 整体停止和清理。不得恢复固定的全局容器名，也不得直接调用 Podman 或执行全局 prune。

`dev prepare` 创建并持续运行该 worktree 的固定 toolbox；`dev shell` 只用容器引擎的 exec 进入它，不创建新容器、不登记 shell 状态。`dev verify` 同样只 exec 这个既有 toolbox，不新建验证容器、不写入生命周期状态；因此 shell、verify 和其他 worktree 可以并发。交互终端断开只会结束本次 bash，不会产生需要另行识别的容器。一个 worktree 可以同时打开多个终端，它们都进入同一个 toolbox；清理时只需要销毁整套 worktree 环境。

正式发版的生产快照测试副本和临时开发副本在测试结束或失败后都会清理，只保留快照、测试回执、候选归档和发布证据这些回退与审计所需内容。流程不会执行无边界的 `podman system prune` 或 `docker system prune`。

正式 release 完成 `accept` 后，本地开发环境和共享开发镜像立即失效并清理；任务源码 worktree 原样保留。未完成任务下次继续时，必须先同步新 main，请求最新 main 的唯一开发镜像，再执行自己的 `dev prepare`。

开发态的 Telegram/cron 容器只连接无外网的内部网络和假 Bot API；Web 由于 Harness 强制只绑定 loopback，使用宿主网络供本机浏览器访问，但只持有测试凭据，不承担 Telegram 或 cron 写入。生产容器固定使用 `1000:1000`；本机 rootless Podman 为了让快照副本保持宿主用户可读写，在容器内显示为 uid 0，但仍映射为宿主普通用户，不获得宿主 root 权限。

`dev prepare` 是源码开发入口，不是测试或发版入口。它在准备开始和完成后都会重新 fetch：独立任务分支必须包含最新 `origin/main`，开发基础镜像的插件 commit 也必须精确等于该 `origin/main`；期间 main 一旦更新，就停止并要求 rebase、重建基础镜像和重新准备环境。正式 `build` 和 `release` 也会拒绝任何没有基于最新 `origin/main` 的产品或发版工具 commit。它只下载已有的一致生产快照，不会为开发申请停机或在线生成快照；远端没有快照、摘要不匹配或下载失败都会停止，不会退回合成数据。Harness 始终使用 `harness.lock.json` 的只读固定 commit。六个插件、Skills、Profiles、runtime topology、materializer 和镜像运行脚本都从独立 worktree 可写挂入；镜像根文件系统仍为只读，编译产物留在 worktree 的忽略目录。由于可编辑挂载会遮住镜像内预构建的 `lib`，`prepare` 只快速重新编译六个包，然后检查 Web、假 Telegram、空 cron、真实 Telegram 阻断和镜像身份；它不重复 Vitest 或 Python unittest。需要验证当前未提交源码时，显式执行 `dev verify`：它在 rootless toolbox uid 0 中重做当前范围的 type/build/bundle，避免改变宿主挂载源码的 ownership；随后以 Containerfile 相同的 1000:1000 身份、Harness、Vitest 配置和默认模块解析跑 TypeScript/Python 测试，以保留 chmod 等权限测试语义。验证专用 HOME、npm/XDG cache 与 Python data 均在 toolbox tmpfs 中创建、仅交给 1000:1000 并在结束时清理，且清除外部 `NODE_PATH`，避免污染模块拓扑边界。回执同时列出共享 main 镜像的全量测试回执与本次 editable source 的状态摘要；后者不是可发布候选。生产目录和真实凭据不会被挂载。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `2` | 参数或输入错误 |
| `3` | 正在等待用户授权，未修改生产 |
| `4` | 安全门失败 |
| `5` | 构建或测试失败 |
| `6` | 生产启动或验收失败 |

## 固定边界

- 产品代码和发版工具都来自清单记录的精确 Git commit；工作树中的未提交文件不会进入镜像。
- `release` 在获得停机许可前不停止任何写入者；许可只覆盖该次候选和该次停机窗口。
- 停机后先做一致快照，再用快照副本执行上线前测试；测试失败时生产保持停止并报告，不在线改产品代码。
- 明确属于挂载、权限、Compose、路径或启动参数的发版小问题，可在限定现场窗口内修正后重新验收；需要改 Harness、插件、数据语义或原因不清时，先向用户报告。只有用户批准后才能回退。
- 上线后状态先是 `awaiting-user-acceptance`。真实 Telegram 与 Web 验收通过并执行 `accept` 后，该镜像才成为 `last-good`。
- 回退默认只打印恢复对象、快照和影响；只有显式 `--approved` 才能恢复上一 Docker 镜像及对应停机前数据。
- OpenClaw 始终在流程外且可完全不存在：不得停止、重启、改配置或接管其写入权，DSH 也不得读取它的目录、凭据、CLI、插件或状态。

## 已完成的切换

2026-08-27，首个 Docker release `20260827T124411650Z-a12dfe07e92b` 已通过真实验收并固定为 `current`/`last-good`。旧 systemd units、旧远端发布树、旧本地 `deployment/herman-hermes` 和第一次切换兼容代码均已删除。

同日使用候选 `20260827T143452209Z-a12dfe07e92b` 完成了一次真实 Docker→Docker 发布与回退演练：候选以同一镜像完成上线前测试和生产启动，随后经显式授权恢复到上述 `last-good`；容器、Web loopback/LAN、Telegram/cron、SQLite、offset 和 JSONL 均通过回退后验证，OpenClaw 未发生变化。以后发布和回退不再依赖旧源码发布树或旧 DSH systemd unit。

镜像仍包含 `context-manager-telegram-canary` 的已提交验证 fixture，因为 A12 完整 UI 回归明确依赖它；它只在镜像构建测试阶段使用，不进入生产 profile、持久化数据或运行时回退边界。
