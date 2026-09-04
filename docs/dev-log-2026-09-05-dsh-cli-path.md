# 开发日志：暴露 DSH CLI 命令

- 日期：2026-09-05
- 范围：DSH Web 源码运行入口、portable 归档入口与入口合同测试

## 目标

让 DSH Web 运行时及其 Agent 子进程能从 `PATH` 找到 `dsh` 命令，同时继续执行当前 checkout 已构建的 Harness CLI，并保留 loader 所需的 `--expose-internals`。源码运行与 portable 归档必须使用同一个薄启动器；不修改上游源码，不增加第二套 CLI 构建或安装流程。

## 时间线

首先核对当前 shell、`nix develop` 和 3080 常驻服务。两种 shell 都没有 `dsh` 命令，但当前开发 checkout 和常驻服务 checkout 的 `apps/cli/lib/bin.js` 均能直接输出版本和帮助；常驻服务的启动脚本也在直接执行该文件。由此确认问题是命令没有进入运行时 `PATH`，不是 CLI 没有构建。

随后从最新 `origin/main` 创建独立任务 worktree 和 `codex/expose-dsh-cli-path` 分支。先修改两个入口测试：源码测试要求 Web runtime 启动的子进程能定位并执行 `dsh`，归档测试要求 portable 包携带同一入口并通过捆绑 Node 执行 CLI。实现前两个测试均因缺少 `bin/dsh` 明确失败。

最小实现增加 `bin/dsh`，源码 checkout 使用当前开发环境的 Node，portable 归档优先使用自身的 `runtime-node/bin/node`；两种布局都执行各自的 `apps/cli/lib/bin.js` 并固定附加 `--expose-internals`。`dsh-web-runtime` 只把 `$package_root/bin` 前置到 `PATH`，没有承担构建或插件安装责任。打包器则校验并复制同一启动器到归档的 `bin/dsh`。

第一次真实隔离安装误从宿主 shell 直接执行，`fs-ext` 在缺少 `make` 时失败。该次失败发生在临时 `DSH_WEB_HOME`，没有触碰真实 Profile。随后按仓库合同改用 `nix develop` 重跑同一安装，Harness、三个插件和 Web Profile 均成功构建、安装。

最后通过启动器实际执行 `dsh --version`，并通过 runtime 的 `--dump-config` 合成隔离 Profile；没有启动或重启 3080 服务。

## 逻辑链条

没有采用全局 `npm link`、用户级 PATH 安装或修改上游 `package.json`。这些方案会把命令可用性绑定到机器全局状态，或越过本仓库不得修改上游源码的边界。

没有让 Agent 调用一条包含 checkout 绝对路径的 Node 命令。独立的 `bin/dsh` 隐藏源码布局与归档布局差异，运行时只负责暴露这一稳定命令名。

portable 启动器优先使用归档携带的 Node，而不是碰巧从宿主 `PATH` 找到的 Node，以保持 CLI、native addon 和构建 ABI 的现有一致性。源码启动器则继续依赖 `nix develop` 提供 Node，不复制开发依赖。

另核对 Harness 的本地 subprocess 实现：它会清除凭据形态和旧 `DSH_*` 环境变量，但明确保留父进程的 `PATH`。因此 runtime 前置的 `bin` 目录会进入 Agent 的 Bash 子进程，不只对 Web 主进程自身有效。

## 改动

- `bin/dsh`：新增源码与归档共用的薄 CLI 启动器。
- `scripts/dsh-web-runtime`：将仓库或归档的 `bin` 目录加入子进程 `PATH`。
- `scripts/package-dsh-web`：校验并打包 `bin/dsh`。
- `scripts/tests/dsh-web-packages.test.sh`：验证源码 runtime 的子进程可定位并正确执行 `dsh`。
- `scripts/tests/package-dsh-web.test.sh`：验证归档携带启动器并使用捆绑 Node 与归档内 CLI。

## 验证

- TDD 红测：源码与归档测试均以 `missing executable bin/dsh launcher` 退出 1。
- `nix develop -c bash scripts/tests/dsh-web-packages.test.sh`：通过。
- `nix develop -c bash scripts/tests/self-describing-plugins.test.sh`：通过。
- `nix develop -c bash scripts/tests/package-dsh-web.test.sh`：通过。
- `bash -n bin/dsh scripts/dsh-web-install-plugins scripts/dsh-web-runtime scripts/package-dsh-web`：通过。
- `git diff --check`：通过。
- 隔离真实安装：`DSH_WEB_HOME=/tmp/dsh-cli-path-check.5kj3rz ./scripts/dsh-web-install-plugins` 在 `nix develop` 内退出 0。
- 隔离 CLI：`DSH_HOME=/tmp/dsh-cli-path-check.5kj3rz ./bin/dsh --version` 输出 `0.1.3-alpha.1`。
- 隔离配置合成：`telegram-gateway`、`dsh-cron`、`dsh-assistant` 各出现一次。

## 遗留

代码尚未合并或部署到 3080 常驻服务。现有服务不会在重启前获得新 `PATH`；停服、部署、重启和真实 Agent 验收仍是独立授权步骤。
