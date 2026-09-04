# 开发日志：Telegram Workspace 工作目录修正

- 日期：2026-09-05
- 范围：本地 Web 运行入口、入口合同测试，以及用户明确授权后的本地 `.dsh-web` Telegram 会话迁移；不修改 upstream 和正式 `~/.dsh`

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

## 逻辑链条

Workspace 不是独立于会话工作目录的任意标签：当前 Harness 将会话 header 的 `cwd` 作为 Workspace 归属依据，并在绑定时校验二者一致。因此本次问题应在会话首次创建之前修正运行目录。

没有修改 Gateway 的 `attachSession()` 逻辑，因为把恢复会话强行绑定到当前配置路径既无法通过 Harness 校验，也会掩盖历史会话仍携带旧 `cwd` 的事实。没有修改 upstream，符合项目边界。

已有旧会话不能靠普通 Workspace 绑定迁移。保留历史并改变 Workspace 必须在服务停止时迁移会话的持久化身份与存储位置，并另做快照和完整性验证。本次只在用户另行明确授权后对本地 `.dsh-web/session-telegram` 执行，未触碰正式数据。

## 改动

- `scripts/dsh-web-runtime`：默认导出 `DSH_CWD=$DSH_HOME/workspace`，确保目录存在，并从该目录启动 Harness。
- `scripts/tests/dsh-web-packages.test.sh`：验证运行时环境变量、实际启动目录和目录创建行为。
- 本地运行数据：`session-telegram` 从仓库 cwd 迁移到 `.dsh-web/workspace`；备份保存在 `.dsh-web/recovery/telegram-workspace-cwd-20260905-0125`。

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

## 遗留

正式 `~/.dsh` 中已有、header 仍记录旧目录的 `session-telegram` 没有改动。正式迁移仍需单独授权停服、快照、数据变更和真实业务验收。
