# 开发日志：本地插件重复安装刷新

- 日期：2026-09-05
- 范围：本地 Web 插件安装入口、入口测试、实际 `.dsh-web` Profile 验证

## 目标

修复源码模式下重复运行 `scripts/dsh-web-install-plugins` 时，本轮已经构建的新插件字节没有进入既有 Web Profile 的问题。完成标准是：首次安装保持正常；既有 Profile 中的三个本地插件会先通过 Harness 插件管理器移除，再从当前源码重新安装；实际 Profile 的构建产物与源码产物一致。

## 时间线

首先确认 `telegram-gateway/lib/index.js` 已包含 Workspace 归属逻辑，但 `.dsh-web/profiles/web/node_modules/@deepseek-ai/dsh-telegram-gateway/lib/index.js` 仍是旧 SHA。随后对实际 `.dsh-web` 完整运行原安装脚本：命令退出 0，pnpm 报告 `Already up to date`，但 Profile 文件仍未变化，由此排除了“用户只构建、没有完整安装”这一解释，并确认真实 Profile 上存在刷新缺陷。

最初在隔离 Profile 中尝试 `plugin update --force`，该命令能刷新临时副本，因此先写测试并做了候选实现。但把候选用于实际 Profile 后，pnpm 仍报告 `Already up to date`，Profile SHA 仍旧。该候选随即撤销，没有作为最终实现保留。

之后在实际 Profile 上验证 Harness 官方管理路径 `plugin remove` 后重新 `plugin add`。三项本地依赖被重新安装，Telegram 源文件和 Profile 文件 SHA 同为 `2168be0e3a5febe94f8d42609b3ce67b66ac384a8451c7c872ebac3362a59bf4`。在此事实基础上重新写失败测试，要求旧 Profile 先 remove 再 add；同时补充首次安装不得无条件 remove 的边界。最终实现只在发现已安装包时移除对应包，再走原 add 入口。

最后用最终脚本完整安装实际 `.dsh-web`。命令退出 0，三个插件的 `lib/index.js` 均与源码逐字节一致，合成配置中三个 bundle 各出现一次。没有由本任务启动或重启 Web；端口 3080 的现有监听者来自另一个 `dsh-plugins-wave13-main-integrate` 工作树，不属于本次 Profile。

获得用户临时运行授权后，使用当前工作树的 `.dsh-web` 在 `127.0.0.1:3081` 启动真实运行时。新版 gateway 启动后把 `session-telegram` 加入路径为 `/home/herman/Projects/dsh-plugins` 的既有 Workspace；该 Workspace 原有另一个会话仍在。会话投影仍显示标题 `Getting started`、`cwd=/home/herman/Projects/dsh-plugins`、9 轮历史。验证完成后以 Ctrl-C 停止临时进程，3081 端口已释放，另一个工作树占用的 3080 未受影响。

## 逻辑链条

`file:` 依赖的地址和版本没有变化时，实际 hoisted Profile 上的 `plugin add --force` 和 `plugin update --force` 都可能被 pnpm 判定为无需重新复制。单次版本 bump 只能绕过一次，直接复制 `node_modules` 又会绕过 Harness/pnpm 的状态所有权，因此均被否决。

Harness 已公开支持 `plugin remove` 和 `plugin add`，所以最终方案没有新增安装模型：安装器仍通过同一个插件管理入口工作。首次安装时没有旧包可删；重复安装时只移除实际存在的三个本地插件，随后统一重新添加。测试锁定 remove 必须先于 add，避免顺序回退后旧字节再次被保留。

## 改动

- `scripts/dsh-web-install-plugins`：源码模式检测现有三个本地插件，通过 Harness 移除已安装项后重新添加。
- `scripts/tests/dsh-web-packages.test.sh`：覆盖首次安装不 remove、重复安装先 remove 后 add，以及原有构建、配置和不启动运行时合同。
- `docs/dev-log-2026-09-05-local-plugin-refresh.md`：记录现场证据、失败候选、最终实现和验证边界。

## 验证

- TDD RED：旧脚本缺少刷新 remove，测试以 `source installer did not remove stale local plugin copies before adding them` 失败。
- TDD GREEN：修改后 `nix develop -c bash scripts/tests/dsh-web-packages.test.sh` 通过。
- `nix develop -c bash scripts/tests/self-describing-plugins.test.sh` 通过。
- `nix develop -c bash scripts/tests/package-dsh-web.test.sh` 通过。
- `bash -n scripts/dsh-web-install-plugins scripts/dsh-web-runtime scripts/package-dsh-web` 通过。
- `git diff --check` 通过。
- 最终脚本针对实际 `.dsh-web` 退出 0；Telegram、cron、assistant 的源码和 Profile `lib/index.js` SHA 分别完全一致。
- `scripts/dsh-web-runtime --dump-config` 显示 `telegram-gateway`、`dsh-cron`、`dsh-assistant` 各一次。
- 当前工作树真实运行时在 3081 启动后，`workspace.json` 中目标 Workspace 的 `sessionIds` 包含原 `session-telegram`；会话投影保持原 cwd、标题和 9 轮历史。停止后 3081 无监听，3080 的其他工作树进程未变化。

## 遗留

本地启动已经验证历史会话归组，但没有从 Telegram 客户端发送一条新消息，因此“真实消息继续进入同一 session”仍需用户侧消息验收。没有发布或修改生产环境。
