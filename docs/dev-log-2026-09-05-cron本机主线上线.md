# 开发日志：cron 本机主线上线

- 日期：2026-09-05
- 范围：将 cron 修复合并本地 main，部署本机正式 3080 服务。

## 目标

用户在远端真实微信任务通过后要求本机也上线，并补充“先合并到主线，再上线”。本轮先合并，再从 main 构建和安装本机包，不使用远端 bot 凭据。

## 时间线

以下时间均为北京时间。

1. 13:18：核对根规则、当前技能和部署说明。本机 `dsh-web-local.service` 已停止，MainPID 为 0，3080 无监听；其 ExecStart 已指向 `/home/herman/.local/share/dsh-web-package-local/current/bin/web`，实际 Workspace 为 `/home/herman/.dsh/workspace`。旧 MEMORY 中“本机部署脚本自动停服并快进 checkout”的描述已失效，当前脚本只准备归档。
2. 重新 fetch main，确认本地及远端基线仍为 `91e353c`，主工作树与任务分支干净。按用户补充要求，将 `codex/cron-list-output-cwd` 快进合并到本地 main `2a0a2cc`，其中代码提交为 `6f7bed8`。
3. 13:19：从本机现有凭据复制到 Git 忽略的私有目录，核对哈希一致且与远端凭据不同。从 main 通过 `nix develop` 和 `scripts/dsh-web-local-deploy` 准备本机普通归档。当前脚本不安装、不启动。
4. 在已停止的本机保存一致性状态备份到 `/home/herman/.local/share/dsh-web-backups/local-20260905-cron-tools`，包括旧 current、unit 和业务数据；归档 274147434 字节，仅排除可重装 node_modules 和历史备份目录。记录 cron 账本和凭据哈希。在隔离副本折叠 10 个活跃任务与各自运行账本，0 个无效定义。检查脚本最初误用 fold().jobs，按现有 API 改为 active 后通过；未影响源数据。
5. 13:20—13:25：npm 准备依赖时一个官方包请求长时间没有返回，独立只读网络请求为 200。核对准备进程及其父进程后，只终止该 npm 子进程，让打包器失败退出并清理临时目录；当时没有修改正式 runtime。随后按同一入口重试，将网络超时限制为 20 秒、重试 2 次，未改变依赖选择和版本策略。
6. 约 13:27：重试批次 55 文件、1160 项测试全部通过，得到归档 `ba57eef2c5ef6d8fa08bc32cc28bb0ba7c61bd74ee5fdb9438f416065028fc78`，Harness 仍为 `0.1.2-rc.1`。再次核对归档凭据、旧数据哈希和停机状态，通过普通安装器完成安装，current 更新到该 SHA。已有官方 npm runtime 无需重复首次迁移，安装前另做的完整状态备份保留。
7. 约 13:28：安装前后 cron 两个账本与凭据哈希一致。通过现有 systemd unit 启动，主 PID 2315861、Web PID 2315890，只监听 `127.0.0.1:3080`，实际 cwd 为原 Workspace；cron control socket ready。正常 token/Cookie 登录后可读取 92 条会话摘要，未认证 401、错误 Host/Origin 403。一次检查脚本末尾误留无用 import 导致检查退出 1，删除该检查错误后正常 RPC 验证通过，没有修改应用。
8. 13:29—13:30：创建独立验收 Web 会话，沿用已配置的 DeepSeek-V4-Flash。模型先成功调用 cron_list，再创建静默一次性任务 `cron-7f04b000`。该任务于 13:29:58 开始，真实调用 bash 执行固定 printf，13:30:00 成功结束，工具输出和最终回答均为 `DSH_LOCAL_CRON_OK_20260905`。
9. 13:30—13:31：通过同一模型会话调用 cron_delete 清理唯一测试任务，再用 cron_list 验证；账本只比安装前新增该任务的 create/delete 两行，原有行完全一致。首次启动 URL 通知失败；Python 与 Node 的 Telegram getMe 均返回 200，核对本机 bot 后，用原版通知脚本补发当前链接一次，退出 0。未改通知重试策略。
10. Codex 内置浏览器访问 loopback 被浏览器客户端以 ERR_BLOCKED_BY_CLIENT 阻止，因此未把 RPC 成功写成 GUI 点击验收。服务端真实模型和 cron 已验证。完成文档后再次核对主线，合并文档并清理已结束的任务分支和 worktree。

## 逻辑链条

本机 current、systemd unit 与现场脚本证明现在采用普通归档，而非旧源码 checkout 部署。运行时保持本机 loopback 3080，继续由同一个 systemd unit 管理，使用本机原有凭据。先合并主线再打包，保证安装源可追溯。

## 改动

没有新增运行时代码；本轮发布已经过远端实测的 cron_list 输出字段与 scheduler 执行预设修复。文档补录本机发布和旧经验更新。

## 验证

- 任务分支已快进合并 main，发布源为 main `2a0a2cc`。
- 本机原有 10 个任务及运行账本副本折叠成功，凭据副本与本机一致。
- 本机归档完整测试 1160 项通过；官方插件安装及供应链策略检查通过，保留原有额外插件。
- 真实 cron_list 无输出合同错误；实际 cron 请求声明包含 bash/read，bash 返回固定标记且最终回答一致，任务 success、deliveryState=silent。
- 临时任务已删除，原有任务定义记录和凭据未改；systemd active，NRestarts=0。启动通知一次补发成功。
- 认证与后端会话、真实模型、cron 已通过；GUI 浏览器验收受客户端限制，未声称完成。Notion 真实写入未在本轮重跑。

## 遗留

不推送 main；远端服务保持上一轮已验证的部署。本机没有微信脚本任务，本轮不复制远端的微信任务、数据或 bot 凭据。
