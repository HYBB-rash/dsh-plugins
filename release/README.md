# DSH Docker 发版系统

这个目录是 DSH 唯一发版入口。它把 Harness、六个插件、Profiles、Skills 和运行依赖构建成一个不可变镜像；`~/.dsh`、工作区和业务数据只从镜像外挂载。线上不再安装依赖、构建源码或切换源码 selector。

## 不会偷偷发生的事

- `build` 只接受 Harness 和产品插件两个完整 Git commit，并分别用 `git archive` 取源码。Dockerfile、Profiles 和验收脚本单独取当前分支 HEAD 的精确发版工具 commit。候选清单同时记录三者，未提交文件、旧 `node_modules` 和原工作树里的旧部署目录不会进入镜像。
- `release` 默认只打印停机影响和回退边界，退出码为 `3`。只有明确添加 `--approved-stop` 才会停止生产写入者。
- `rollback` 默认只报告方案。只有明确添加 `--approved` 才会恢复数据和旧运行版本。
- 发版脚本不停止、不重启、不配置 OpenClaw；生产切换前后会比较 OpenClaw PID 和重启计数。

## 常用流程

```bash
# 开发任务先从最新 main 构建开发基础镜像；这不是正式发版候选
./release/dsh build \
  --harness-ref b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
  --plugins-ref "$(git rev-parse origin/main)"

# 自动下载已有的最新生产快照，挂入当前独立 worktree 的可编辑源码，
# 完成六个插件的全量构建、全量测试和隔离 Web/假 Telegram/空 cron 验收
./release/dsh dev prepare \
  --source "$(git rev-parse --show-toplevel)" \
  --candidate ~/.local/share/dsh-container/candidates/latest.json

# 进入同一镜像、同一隔离数据和同一源码挂载的开发 shell
./release/dsh dev shell --candidate ~/.local/share/dsh-container/candidates/latest.json

# 只验证一个已经存在的不可变候选时，仍可使用原来的 dev up
./release/dsh dev up --snapshot synthetic --candidate /path/to/candidate.json

# 同一候选再次 up 会复用开发数据；确实要从快照重建时才加 --reset
./release/dsh dev up --snapshot synthetic --candidate /path/to/candidate.json --reset

# 从两个精确提交构建唯一候选镜像
./release/dsh build \
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

构建仍会在删除标签后重载 Docker archive，证明归档可以恢复同一个 image ID。若 `/dev/shm` 至少有 8 GiB 可用空间，归档会自动在那里暂存，重载成功后再复制到证据目录，避免根盘同时承受镜像层和归档的峰值占用；也可用 `DSH_RELEASE_ARCHIVE_STAGING_ROOT` 指定其他临时文件系统。暂存归档未完成摘要校验前不会生成 `candidate.json`。

开发态的 Telegram/cron 容器只连接无外网的内部网络和假 Bot API；Web 由于 Harness 强制只绑定 loopback，使用宿主网络供本机浏览器访问，但只持有测试凭据，不承担 Telegram 或 cron 写入。生产容器固定使用 `1000:1000`；本机 rootless Podman 为了让快照副本保持宿主用户可读写，在容器内显示为 uid 0，但仍映射为宿主普通用户，不获得宿主 root 权限。

`dev prepare` 是源码开发入口，不是发版入口。它在准备开始和完成后都会重新 fetch：独立任务分支必须包含最新 `origin/main`，开发基础镜像的插件 commit 也必须精确等于该 `origin/main`；期间 main 一旦更新，就停止并要求 rebase、重建基础镜像和重跑门禁。正式 `build` 和 `release` 也会拒绝任何没有基于最新 `origin/main` 的产品或发版工具 commit。它只下载已有的一致生产快照，不会为开发申请停机或在线生成快照；远端没有快照、摘要不匹配或下载失败都会停止，不会退回合成数据。Harness 始终使用 `harness.lock.json` 的只读固定 commit。六个插件、Skills、Profiles、runtime topology、materializer 和镜像运行脚本都从独立 worktree 可写挂入；镜像根文件系统仍为只读，编译产物留在 worktree 的忽略目录。生产目录和真实凭据不会被挂载。

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
- OpenClaw 始终在流程外：不得停止、重启、改配置或接管其写入权。

## 已完成的切换

2026-08-27，首个 Docker release `20260827T124411650Z-a12dfe07e92b` 已通过真实验收并固定为 `current`/`last-good`。旧 systemd units、旧远端发布树、旧本地 `deployment/herman-hermes` 和第一次切换兼容代码均已删除。

同日使用候选 `20260827T143452209Z-a12dfe07e92b` 完成了一次真实 Docker→Docker 发布与回退演练：候选以同一镜像完成上线前测试和生产启动，随后经显式授权恢复到上述 `last-good`；容器、Web loopback/LAN、Telegram/cron、SQLite、offset 和 JSONL 均通过回退后验证，OpenClaw 未发生变化。以后发布和回退不再依赖旧源码发布树或旧 DSH systemd unit。

镜像仍包含 `context-manager-telegram-canary` 的已提交验证 fixture，因为 A12 完整 UI 回归明确依赖它；它只在镜像构建测试阶段使用，不进入生产 profile、持久化数据或运行时回退边界。
