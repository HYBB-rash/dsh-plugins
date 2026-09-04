# 开发日志：本地 Web 一键部署

- 日期：2026-09-05
- 范围：本机 3080 DSH Web 的代码同步、构建、Profile 刷新、服务切换与验收

## 目标

提供一个可直接运行的本机部署入口。代码变更完成并提交后，用户不再手工串联 stop、安装、配置检查和 start；脚本只把干净且可快进的提交部署到 `dsh-web-local.service` 使用的长期 `main` checkout，不影响 `.dsh-web:5080` 开发服。

## 时间线

1. 用户指出仅说明手工命令不算完成，需要以后可直接 deploy 到本机。
2. 复核现有边界：3080 使用 `~/.dsh` 和专用 checkout，5080 使用开发树和 `.dsh-web`；VM 的 `dsh-web-deploy` / `dsh-web-start` 带归档、LAN 和域名职责，不能复用。
3. 复杂度门禁确认脚本只是串联既有安装器、runtime、systemd unit 和长期 checkout，新增长期概念数为 0。
4. 在独立任务分支先写部署流程测试。首次 RED 为缺少 `scripts/dsh-web-local-deploy`。
5. 实现后首轮测试错误调用真实 Git。定位为测试夹具创建假 `git/systemctl/nix/ss` 后漏设执行位；补齐执行位后，测试开始验证真实脚本行为。
6. 测试覆盖脏源、脏目标、非 fast-forward、安装失败、有效配置插件数量错误、非 loopback 监听、成功顺序和源等于目标。安装或配置失败不启动服务；启动后发现非 loopback 监听会再次停服。
7. 回归源码安装/运行拆分、Telegram 通知器、普通归档打包和 VM 部署合同，确认本地入口没有调用生产启动器。

## 逻辑链条

- 3080 不能直接运行当前开发 worktree：该目录可能切分支或含未提交字节，曾导致服务入口和 Profile 引用失效。开发中代码继续由 5080 验证。
- 部署源可以是功能分支，但必须工作树干净，且其提交必须以长期 checkout 当前 HEAD 为祖先关系上的快进后继；脚本以 `reset --hard <source HEAD>` 完成同仓库 `main` 的 fast-forward，不接受分叉历史。
- 目标目录不写死：从 systemd unit 的 `ExecStart` 解析 runtime，再验证源和目标共享同一 Git common dir、目标分支为 `main` 且工作树干净。
- 构建只调用 `dsh-web-install-plugins`，不复制另一套构建逻辑。`--dump-config` 必须看到三个插件各一次，Profile 的三个 `file:` 必须全部指向长期 checkout。
- 任一构建或配置门禁失败都保持停机，不能重新启动旧代码冒充部署成功。启动后还要确认 service active 且 3080 没有非 loopback listener。

## 改动

- `scripts/dsh-web-local-deploy`
  - 新增本机一键部署入口。
  - 检查干净工作树、同仓库、目标 `main` 和 fast-forward 关系。
  - 停服后同步长期 checkout、初始化 submodule、通过 Nix 环境运行统一安装器。
  - 验证三插件、Profile 源码引用、服务状态和 loopback 监听。
- `scripts/tests/dsh-web-local-deploy.test.sh`
  - 用隔离夹具和假系统命令覆盖成功顺序及失败边界。
- `MEMORY.md`
  - 记录 3080 的统一部署入口及与 5080、VM 发布流程的边界。

## 验证

- RED：部署测试因入口不存在而失败。
- GREEN：`scripts/tests/dsh-web-local-deploy.test.sh` 通过。
- GREEN：`scripts/tests/dsh-web-packages.test.sh` 通过。
- GREEN：`node --test scripts/tests/dsh-web-notify-start-url.test.mjs`，5/5 通过。
- GREEN：`scripts/tests/package-dsh-web.test.sh` 通过。
- GREEN：`scripts/tests/dsh-web-deploy.test.sh` 通过。
- GREEN：`bash -n` 与 `git diff --check` 通过。
- 真实自部署及 3080 验收将在文档提交后补记。

## 遗留

- Home Manager 现有本机修改继续保持未提交，不 push。
- 脚本故意拒绝未提交或无法 fast-forward 的代码；此类代码只允许在 5080 开发服中验证。
