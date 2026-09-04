# 开发日志：Telegram Workspace 工作目录修正

- 日期：2026-09-05
- 范围：本地 Web 运行入口、入口合同测试，以及用户明确授权后的 `.dsh-web` 与本机正式 `~/.dsh` Telegram 会话迁移；不修改 upstream，远端正确数据不重复改写

## 目标

本地 Web 启动时，让 Telegram Gateway 使用当前 DSH Home 下的 `workspace` 目录，而不是仓库目录。新建的 `session-telegram` 应因此归入 `.dsh-web/workspace` 对应的 Workspace，不再产生 `dsh-plugins` Workspace。

## 时间线

1. 复核 Gateway 后确认，它恢复已有 `session-telegram` 后会读取会话 header 中的 `cwd`，并将该会话挂入同路径 Workspace。
2. 复核 Harness Workspace 实现后确认，Workspace 会校验并按会话的不可变 `cwd` 投影成员；仅改变 `attachSession()` 的目标路径会被拒绝，不能用于迁移历史会话。
3. 对比正式和本地启动入口后发现，正式入口会设置 `DSH_CWD=$DSH_HOME/workspace` 并进入该目录，本地 `scripts/dsh-web-runtime` 只设置了 `DSH_HOME`，因此配置回退到了启动时的仓库目录。
4. 先扩充入口合同测试，要求运行时收到 `$DSH_HOME/workspace` 且实际从该目录启动；旧实现以 `DSH_CWD: unbound variable` 按预期失败。
5. 在本地及便携运行分支统一补齐 `DSH_CWD` 默认值，创建目录并在启动 Harness 前进入该目录；针对性测试随后通过。
6. 用户明确授权迁移本地历史并启动 5080 后，先确认 5080 未占用、目标仅为本地 `.dsh-web`，再备份两代原始 Session、Workspace 状态和投影缓存。
7. 离线把两代 `session-telegram` header 的 `cwd` 改为 `.dsh-web/workspace`，移动 Session 身份目录，并从旧 `dsh-plugins` Workspace 的持久化成员列表中只移除 `session-telegram`。两份日志的事件帧原字节保持不变。
8. 在 5080 启动本地 Web 后，Gateway 创建 `workspace` 并挂入 `session-telegram`。实际 Web 侧边栏显示 `Getting started` 位于 `workspace` 下；`dsh-plugins` 仍保留另外两个普通会话。
9. 用户验收后，把本任务、既有插件刷新和开发端口 5080 三组提交变基到本机最新 `main`；完整回归通过后快进合并并推送远端主线 `180801c`，随后删除已结束的任务分支。
10. 合并后只读核对本机正式 3080，确认其 `session-telegram` 仍使用历史目录。精确停止唯一 writer 后，备份 Session、Workspace 状态和投影缓存，再用相同帧级方法迁移到 `~/.dsh/workspace`。
11. 第一次恢复 3080 时误用 `DSH_HOME` 覆盖源码启动器；启动器实际只用 `DSH_WEB_HOME` 选择运行数据，因此临时实例指向主线 worktree 的 `.dsh-web`。发现实际进程环境不符后立即停止该实例，改用 `DSH_WEB_HOME=/home/herman/.dsh` 按原端口恢复。
12. 正确恢复后，本机 `workspace` 只挂入 `session-telegram`，标题、7 轮历史和 seq 96 保持不变。远端 `herman.hermes` 只读核对发现唯一 `session-telegram` 已在 `~/.dsh/workspace`，193 轮、seq 3611 且归属正确，因此没有停机或重复改写远端数据。

## 逻辑链条

Workspace 不是独立于会话工作目录的任意标签：当前 Harness 将会话 header 的 `cwd` 作为 Workspace 归属依据，并在绑定时校验二者一致。因此本次问题应在会话首次创建之前修正运行目录。

没有修改 Gateway 的 `attachSession()` 逻辑，因为把恢复会话强行绑定到当前配置路径既无法通过 Harness 校验，也会掩盖历史会话仍携带旧 `cwd` 的事实。没有修改 upstream，符合项目边界。

已有旧会话不能靠普通 Workspace 绑定迁移。保留历史并改变 Workspace 必须在服务停止时迁移会话的持久化身份与存储位置，并另做快照和完整性验证。本次只在用户明确授权后对确有错误的 `.dsh-web` 和本机正式 `~/.dsh` 执行。远端已经满足目标时，无写入是正确迁移结论。

## 改动

- `scripts/dsh-web-runtime`：默认导出 `DSH_CWD=$DSH_HOME/workspace`，确保目录存在，并从该目录启动 Harness。
- `scripts/tests/dsh-web-packages.test.sh`：验证运行时环境变量、实际启动目录和目录创建行为。
- 本地运行数据：`session-telegram` 从仓库 cwd 迁移到 `.dsh-web/workspace`；备份保存在 `.dsh-web/recovery/telegram-workspace-cwd-20260905-0125`。
- 本机正式数据：`session-telegram` 从历史 DeepSeek Harness cwd 迁移到 `~/.dsh/workspace`；备份保存在 `~/.dsh/recovery/telegram-workspace-cwd-20260905-0130`。
- `herman.hermes`：只读确认已是正确目标状态，零数据改动、零停机。

## 验证

- TDD RED：旧实现运行入口合同时报告 `DSH_CWD: unbound variable`。
- TDD GREEN：`nix develop -c bash scripts/tests/dsh-web-packages.test.sh` 通过。
- `scripts/dsh-web-runtime --dump-config` 成功合成现有本地 Web Profile，未启动真实服务。
- Telegram Gateway 完整测试：6 个测试文件、148 个用例全部通过。
- Web 入口测试：`dsh-web-packages.test.sh`、`self-describing-plugins.test.sh`、`package-dsh-web.test.sh` 全部通过。
- `bash -n scripts/dsh-web-runtime` 通过。
- `git diff --check` 通过。
- 离线迁移校验：v0 日志 384 个帧、v2 日志 10 个帧；迁移前后各自的事件字节 SHA-256 完全一致。
- 5080 实际 Web 验证：认证入口返回 200；侧边栏中 `workspace/Getting started` 可见且完整历史可展开，`dsh-plugins` 下不再包含该 Telegram 会话。
- 本地 Gateway 启动后收到了测试 Bot 队列中的一条待处理 `hi`，会话由 9 轮自然继续为 10 轮，证明迁移后的固定 Session 可继续追加消息。
- 最终合并结果完整回归：四项 Web/打包 Shell 测试、两个 Node 部署辅助测试共 7 个用例、Telegram Gateway 148 个用例、Shell 语法和 `git diff --check` 全部通过。
- 本机正式迁移：v0 日志 111 个帧、v2 日志 3 个帧，迁移前后事件字节摘要一致；恢复后的进程 `DSH_HOME=/home/herman/.dsh`、`DSH_CWD` 与实际 cwd 均为 `/home/herman/.dsh/workspace`，认证访问返回 200。
- 本机正式会话投影重建后仍为标题“用户喜欢第2条洞察”、7 轮、seq 96，并且只属于 `~/.dsh/workspace`。
- `herman.hermes` 唯一会话目录、header cwd、进程 cwd 和 Workspace 路径均为 `/home/herman/.dsh/workspace`；历史为标题“从 MEMORY.md 验收共享上下文”、193 轮、seq 3611。

## 遗留

本机和远端均未由本次流程发送一条专门的 Telegram 验收消息；已证明历史可读取、Workspace 归属正确和 Web 健康，真实 Telegram 新消息续接仍由用户按需观察。
