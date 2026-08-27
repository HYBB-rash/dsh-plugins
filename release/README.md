# DSH Docker 发版系统

这个目录是 DSH 唯一发版入口。它把 Harness、六个插件、Profiles、Skills 和运行依赖构建成一个不可变镜像；`~/.dsh`、工作区和业务数据只从镜像外挂载。线上不再安装依赖、构建源码或切换源码 selector。

## 不会偷偷发生的事

- `build` 只接受 Harness 和产品插件两个完整 Git commit，并分别用 `git archive` 取源码。Dockerfile、Profiles 和验收脚本单独取当前分支 HEAD 的精确发版工具 commit。候选清单同时记录三者，未提交文件、旧 `node_modules` 和原工作树里的旧部署目录不会进入镜像。
- `release` 默认只打印停机影响和回退边界，退出码为 `3`。只有明确添加 `--approved-stop` 才会停止生产写入者。
- `rollback` 默认只报告方案。只有明确添加 `--approved` 才会恢复数据和旧运行版本。
- 发版脚本不停止、不重启、不配置 OpenClaw；生产切换前后会比较 OpenClaw PID 和重启计数。

## 常用流程

```bash
# 第一次没有生产快照时，用合成数据启动开发环境
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

开发态的 Telegram/cron 容器只连接无外网的内部网络和假 Bot API；Web 由于 Harness 强制只绑定 loopback，使用宿主网络供本机浏览器访问，但只持有测试凭据，不承担 Telegram 或 cron 写入。生产容器固定使用 `1000:1000`；本机 rootless Podman 为了让快照副本保持宿主用户可读写，在容器内显示为 uid 0，但仍映射为宿主普通用户，不获得宿主 root 权限。

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
