# 项目规则

## 文档与现场事实

开始工作前，先阅读当前目录及更近作用域的 `AGENTS.md`，再按任务关键词检索根目录 `MEMORY.md`。其中的经验只能作为可借鉴线索；配置、运行状态和外部系统仍以本次现场核对为准。

`AGENTS.md` 只保存长期、跨任务、会约束后续行为的规则。项目现状、历史实验、验收记录和可复用踩坑应写入 `MEMORY.md` 或对应专项文档。用户当前任务、明确验收条件及更近目录的规则，优先于本文件和 `MEMORY.md`。

## 改动纪律

除非用户明确授权，保持改动最小，不覆盖或回退已有无关改动。开始修改前先检查工作树，并按风险做相称的验证。

每个开发任务必须使用独立分支，每个 Git 提交只包含一种内容。任务只有在该分支完成开发和发布后才算完成；完成后才能将分支合并到主线。

任务分支合并、废弃或被替代而结束生命周期后，先确认不再关联任何 worktree，再删除本地和远端分支；不得保留已结束的任务分支。

每个开发任务开始前，先确认其任务分支是否基于最新的 `main`；若不是，立即变基到最新 `main` 后再继续开发。准备结束任务或发版前，必须再次确认任务分支仍基于最新 `main`；若不是，立即变基后才能结束任务或发版。

## 开发依赖

除非当前规则明确要求进入已准备好的隔离运行时，否则先执行 `nix develop`；启用过 `direnv` 的工作树由 `.envrc` 自动进入同一环境。不要通过手工查找、拼接或猜测宿主程序路径，也不要用临时 `npm`/`pip` 安装来补开发依赖。

## 本地 Web 开发

涉及 Harness、`telegram-gateway`、`dsh-cron`、`dsh-assistant`、Web Profile、插件注册或本地 Web 开发服时，先读取并遵循 `$dsh-web-dev`。本地开发固定使用两段式入口：`./scripts/dsh-web-install-plugins` 负责构建和安装，`./scripts/dsh-web-runtime` 只负责启动；不得恢复已清退的 `scripts/dsh-web`，不得直接维护 Profile 的 `node_modules` 或手工登记 bundle。开发与传输包必须使用同一份 Harness、插件构建产物、Web patch 和 runtime 脚本；生产包唯一允许的环境差异是打包阶段附加 Git 忽略的线上凭据数据。

## 发布入口与隔离

`herman.hermes` 唯一现役发布入口是普通 `tar.gz` Web 部署。先读取并遵循 `$dsh-web-deploy` 与 `docs/dsh-web-portable-deployment.md`；只使用 `scripts/package-dsh-web`、`scripts/dsh-web-deploy` 和远端 `dsh-web-start`，上传与启动必须分离。旧 Docker/OCI `release/dsh` 系统已退役，不得恢复 `release/`、容器发布入口或与普通归档并行的第二套生产流程。

OpenClaw 始终在流程之外，不得改动；开发、测试、发布和运行都必须允许它完全不存在，也不得读取其目录、凭据、CLI、插件或状态。普通归档是秘密载体；生产凭据只允许由打包器从 Git 忽略目录加入，`DSH_HOME`、Workspace 和业务状态留在归档外。

## 停机、发布与验收

`scripts/dsh-web-deploy` 只上传，不授予停止或重启权限。获得明确停机许可后，按 `$dsh-web-deploy` 精确识别并停止当前 portable Web 监督进程树；禁止宽泛杀进程、并行启动第二份或触碰 OpenClaw。普通归档流程没有自动快照、accept 或 rollback，必须诚实报告这一边界。

生产验收必须覆盖监督进程、loopback/LAN/域名入口、认证状态、数据和真实 Telegram/cron/模型/Notion 业务，不能只看 PID 或 HTTP。现场修复只限明确、可逆且不改变业务或数据语义的问题；其他问题停止线上试错并报告。项目优先简单和可恢复，不得为缩短停机跳过验证。

## 经验记录

每项任务结束前，若本次发现了可复用的失败原因、边界或验证陷阱，向根目录 `MEMORY.md` 追加一条简短、可检索、带日期的经验；没有新经验则不要凑条目。
