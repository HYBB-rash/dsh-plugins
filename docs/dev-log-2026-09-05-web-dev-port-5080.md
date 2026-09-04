# 开发日志：开发服默认端口 5080

- 日期：2026-09-05
- 范围：本地 Web 运行入口、入口测试、项目协作规则和本地开发 Skill

## 目标

让源码开发服默认使用 `5080`，避免与本机正式部署固定使用的 `3080` 冲突。调用者显式传入 `--port` 时必须保留其选择；便携部署行为不得变化。

## 时间线

首先检索全部端口引用，确认正式部署入口 `scripts/dsh-web-start` 已通过 `DSH_WEB_PORT` 明确把 Harness 和 LAN 代理绑定到 `3080`，而源码开发入口 `scripts/dsh-web-runtime` 没有端口默认值，只是把参数交给 Harness，因此无参数启动时也落到 `3080`。

随后先扩展 `scripts/tests/dsh-web-packages.test.sh`：以无参数执行源码运行入口，要求真实转发给 Harness 的参数包含 `--port 5080`；当前实现按预期以“source Web runtime did not default to port 5080”失败。实现最小默认参数后测试转绿，并保留原有显式 `--port 3080` 用例，额外断言显式端口下不得再注入 `5080`。

第一次实现把默认端口放在用户参数前，实际运行 `--dump-config` 时 Harness 把导出参数误交给 Web 应用并报 unknown option。把默认端口移动到参数末尾后，Harness 又明确拒绝配置导出携带任何应用参数。于是新增第二个失败测试，最终规则改为遇到 `--dump-config` 或 `--dump-default-config` 时完全不注入开发端口；真实配置合成随后恢复成功。

最后同步项目 `AGENTS.md` 和 `$dsh-web-dev`，明确本机正式部署固定使用 `3080`、源码开发默认使用 `5080`，临时端口通过显式 `--port` 指定。

## 逻辑链条

不能修改共享 Web patch 的端口表达式，因为该 patch 同时进入开发和普通归档；在那里改成 `5080` 会把开发约定泄漏进正式部署。也不只修改 VS Code task，因为命令行直接运行仍会回到 `3080`。端口默认值属于源码运行入口，因此只在检测到源码仓库布局时注入；归档布局不注入，继续由 `dsh-web-start` 明确提供 `3080`。

显式端口必须优先。实现会识别 `--port <值>` 和 `--port=<值>`，只有两者都不存在时才补入开发默认值。配置导出不是运行服务，不接收 Web 端口参数，因此保持原命令不变。

## 改动

- `scripts/dsh-web-runtime`：源码模式无显式端口时补入 `--port 5080`。
- `scripts/tests/dsh-web-packages.test.sh`：覆盖开发默认端口和显式端口覆盖。
- `AGENTS.md`：记录开发 `5080`、本机部署 `3080` 的长期规则。
- `.agents/skills/dsh-web-dev/SKILL.md`：更新启动说明和示例。
- `docs/dev-log-2026-09-05-web-dev-port-5080.md`：记录本次判断、测试和边界。

## 验证

- TDD RED：原入口无参数时未传 `--port 5080`，聚焦测试按预期失败。
- TDD GREEN：加入源码默认端口后，聚焦测试通过。
- TDD RED：默认端口破坏 `--dump-config` 的 Harness 参数合同，聚焦测试按预期失败。
- TDD GREEN：配置导出跳过端口注入后，聚焦测试与实际 `--dump-config` 均通过，三个 bundle 各出现一次。
- `nix develop -c bash scripts/tests/dsh-web-packages.test.sh` 通过。
- `nix develop -c bash scripts/tests/self-describing-plugins.test.sh` 通过。
- `nix develop -c bash scripts/tests/package-dsh-web.test.sh` 通过；打包启动测试继续显式使用 `3080`。
- Shell 语法检查和 `git diff --check` 通过。
- 无显式 `--port` 执行源码运行入口后，真实监听地址为 `127.0.0.1:5080`；确认后以 Ctrl-C 停止，5080 已释放，另一个工作树占用的 3080 未受影响。

## 遗留

没有修改或重启本机正式部署；本次不进行生产发布。
