# DSH Docker 发版系统

这个目录是 DSH 唯一的新发版入口。它把 Harness、六个插件、Profiles、Skills 和运行依赖构建成一个不可变镜像；`~/.dsh`、工作区和业务数据只从镜像外挂载。

当前阶段仍保留旧 systemd 发版系统，只用于第一次 Docker 切换失败后的回退。第一个 Docker release 完成真实 Telegram/Web 验收并执行 `accept` 前，禁止删除旧系统。

## 不会偷偷发生的事

- `build` 只接受两个完整 Git commit，并分别用 `git archive` 取源码。未提交文件、旧 `node_modules` 和原工作树里的旧部署目录不会进入镜像。
- `release` 默认只打印停机影响和回退边界，退出码为 `3`。只有明确添加 `--approved-stop` 才会停止生产写入者。
- `rollback` 默认只报告方案。只有明确添加 `--approved` 才会恢复数据和旧运行版本。
- `retire-legacy` 同时要求 release 已经是 `accepted`，并再次添加 `--approved`。它不能在第一次真实验收前运行。
- 发版脚本不停止、不重启、不配置 OpenClaw；生产切换前后会比较 OpenClaw PID 和重启计数。

## 常用流程

```bash
# 第一次没有生产快照时，用合成数据启动开发环境
./release/dsh dev up --snapshot synthetic --candidate /path/to/candidate.json

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
```

状态默认存放在 `~/.local/share/dsh-container`。可以用 `DSH_RELEASE_STATE_ROOT` 指向测试目录。本地默认使用 Podman；生产默认通过 SSH 连接 `herman.hermes` 并使用 Docker Compose。镜像不经过镜像仓库。

本机 Podman 构建显式使用目录内的 `containers-policy.json`，不修改用户全局容器配置。该策略不额外要求镜像签名；基础镜像身份由 `image.lock.json` 中不可变的完整 digest 锁定。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `2` | 参数或输入错误 |
| `3` | 正在等待用户授权，未修改生产 |
| `4` | 安全门失败 |
| `5` | 构建或测试失败 |
| `6` | 生产启动或验收失败 |

## 第一次切换后的收尾

第一次 release 被 `accept` 后，还不能立即宣布改造完成。需要先确认其他任务不再使用旧流程，再执行 `retire-legacy`；随后从源码删除一次性的 systemd 回退兼容代码和旧文档引用，并完成一次纯 Docker→Docker 发布/回退演练。
