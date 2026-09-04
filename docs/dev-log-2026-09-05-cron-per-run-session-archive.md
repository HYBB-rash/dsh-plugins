# 开发日志：Cron per_run Session 自动归档

- 日期：2026-09-05
- 范围：`dsh-cron` 的 run ledger、Scheduler 轮询归档、Workspace 服务依赖与回归测试

## 目标

让已有唯一有效 finish、身份与 `runId` 哈希严格一致、且确有持久化实体的 `per_run` Session，在 Scheduler 下一次轮询时进入 Workspace 全局归档。历史记录与已删除 job 使用同一规则收敛；persistent、command、claim-only、无实体和歧义记录保持不变。归档失败不得改变 Cron 结果、重复投递或重跑业务。

## 时间线

1. 先执行 `git fetch origin`，确认本地 `main` 只比 `origin/main` 单向领先 12 个此前已验收提交；将这 12 个提交快进推送到远端主线后，从最新 `origin/main` 建立 `codex/cron-per-run-session-archive`。现存 `upstream/deepseek-harness` 未跟踪构建产物保持原状。
2. 按 TDD 先跑 `run-ledger` 基线，27 个测试全部通过。新增“跨已删除 job 投影唯一 finish、重复 finish 判冲突”测试，观察到 `inspectTerminalFinishes is not a function` 的预期红灯；补最小账本投影后转绿为 28/28。
3. 新增 Scheduler 历史归档测试，先观察到 archived 集合仍为空的预期红灯；随后接入全量 finish 投影、精确哈希校验、Session persistence 实体交集和 `WorkspaceRegistry.archiveSession()`。
4. 修正 persistent-resume 测试夹具：旧夹具返回 `{ id }`，生产接口实际为 `snapshot.header.id`；改为包含完整 Session header 的 snapshot。同步移除“per_run 永不读取 persistence”的旧测试假设，因为归档收敛必须在 finish 后读取持久 Session 清单。
5. 继续补 success、error、interrupted、finish 前零归档、下一轮归档、首次失败后重试、业务与投递不重跑、已删除 job、错误哈希、相似前缀、重复 finish、persistent、command、claim-only、无实体、once+persistent、重复轮询幂等、账本/枚举/单条归档失败隔离等测试。
6. 一次直接执行 `pnpm bundle` 触发独立 workspace 解析失败：插件目录无法解析 `@deepseek-ai/cordis@workspace:*`。这是错误的构建入口，没有据此修改依赖；改用项目规定的 Harness 工具链和两段式 Web 入口。
7. 第一次隔离 Web 安装漏进 `nix develop`，因宿主没有 `make` 导致 `fs-ext` 构建失败。换全新临时目录并在 Nix 开发环境中重跑后，Harness、三个插件和 Profile 安装全部成功。
8. 独立复杂度复核一度建议再加一个 singleflight guard。现场复核确认 `requestDrive()` 只置请求位、`runRequested()` 串行等待每个 `driveOnce()`，生产没有并发 `reload()` 路径；Workspace 归档本身也幂等，因此不重复增加状态，复核结论改为 `PASS`。
9. 发布前重新完整核对：本机没有 `per_run` Session，25 个 Cron Session 均为 `persistent`；`herman.hermes` 仍有 112 个候选，终态为 99 success、11 error、2 interrupted，可见性为 96 个未分组、16 个已有 Workspace membership、0 个已归档。候选 ID 清单摘要为 `7c3e62aa…50aaff`。
10. 将归档实现快进合入并推送主线后，先停止精确的本机 `dsh-web-local.service`，备份 Workspace 状态，再通过 `scripts/dsh-web-local-deploy` 重建安装。本机最终仍为 0 个 `per_run` 候选、25 个 `persistent`，loopback token 登录为 303→200，无会话 API 为 401。
11. 远端上传归档 `3e758c8a…c5715` 后，精确停止原 portable 监督进程树并确认两个 3080 监听释放。停机状态下备份 Workspace、112 个候选、147 个 Session 文件及 membership；物理文件摘要为 `fc573aec…3433a8c`。新版首次轮询只把这 112 个 ID 加入全局 archived set，Workspace tables 和 147 个文件逐字节未变。
12. 前两次远端启动都曾短时监听后无显式 stderr 退出；一次 transient user-systemd 诊断又因错误传入私有 pnpm wrapper 形成自调用，尚未启动 Web 即被精确停止，没有作为最终运行方式保留。恢复启动器的 Corepack 选择后，日志给出了真正的确定性错误：Telegram gateway 解析 `liangshen` preset 时，provider 尚未挂载。
13. 对比 Profile 发现本机 bundle 顺序为 `liangshen → assistant → cron → telegram`，远端历史顺序却是三个自研插件在前、`liangshen` 在后。源码安装分支已有“先 remove、再 add”规则，portable 分支只有 add，因而保留错误历史顺序。先新增真实归档安装测试并观察到“portable installer did not remove installed source plugins”的预期红灯，再给 portable 分支补同一刷新规则，测试转绿。
14. 现场发现另一个未推送任务已让本地 `main` 前进 8 个提交。为避免把无关改动夹带进远端，本任务没有改写或推送那 8 个提交，而是让 `origin/main` 仅从归档实现快进到顺序修复 `4e2a185`。重新上传归档 `e2059f45…90cf15`，以现役 `nohup + dsh-web-start` 启动 run `20260904T200750Z`；最终 Profile 顺序稳定，portable 监督进程和双监听持续存活。

## 逻辑链条

- Agent handle 的 `dispose` 只释放运行资源，不会改变持久 Session 的侧栏归档状态；归档必须由 Workspace 服务完成。
- finish 是“这轮业务真实结束”的现有持久事实。只处理唯一有效 finish，可排除 claim-only 和歧义账本；扫描完整账本而非 active jobs，才能覆盖已删除 job 和历史记录。
- `session-cron-run-${sha256(runId).slice(0, 32)}` 是现有 `per_run` Session 的确定身份。精确相等排除 persistent、command、相似前缀和伪造 ID。
- 即使身份匹配，provider skip、空 gate、过期 once 等路径可能没有创建 Session。与 `sessionPersistence.list()` 的真实实体取交集，避免归档不存在的会话。
- 归档放在每次 `reload/poll` 的恢复和环境 settlement 之后，不挂进 Agent close 或 finish 主路径；因此历史、finish 后崩溃和暂时失败都由同一个幂等规则补偿，不新增迁移状态。
- no-throw 只隔离归档收敛本身。账本检查、服务取得、archive state、Session 枚举或单条 archive 失败都记录阶段；单条失败不阻断后续候选，下次 poll 再试。
- 未采用按 Session 前缀或 cwd 扫描侧栏、按同目录批量挂 Workspace、独立迁移脚本、归档确认账本和额外 singleflight 状态，因为它们不是当前闭环所需。

## 改动

- `dsh-cron/src/store.ts`：复用同一 revision 快照，新增完整账本的唯一 terminal finish 投影并显式返回重复冲突。
- `dsh-cron/src/scheduler.ts`：复用统一的 `per_run` Session ID 计算；在 reload 末尾执行 no-throw 归档收敛，记录带 stage、`runId`、`sessionId` 的错误。
- `dsh-cron/src/index.ts`、`dsh-cron/package.json`：声明并注入现有 Workspace 服务。
- `dsh-cron/tests/run-ledger.spec.ts`、`dsh-cron/tests/scheduler.spec.ts`：增加账本与 Scheduler 行为测试，并修正真实 persistence snapshot 夹具。
- 没有修改 `upstream/`，没有新增配置、外部 API、数据库字段、账本事件、迁移程序或后台任务。

## 验证

- TDD 红灯：账本方法缺失；Scheduler 历史归档结果为空。两者均在最小实现后转绿。
- `dsh-cron` 最终全量：24 个测试文件、636 个测试全部通过。
- 类型构建：`upstream/deepseek-harness/node_modules/.bin/tsc -b dsh-cron` 通过。
- 正式两段式构建/安装：在 `/tmp/dsh-cron-archive-web-check.C6LEZo` 中通过 `nix develop` + `DSH_WEB_HOME=... ./scripts/dsh-web-install-plugins` 完成；`dsh-cron` bundle 成功。
- 无副作用配置合成：`./scripts/dsh-web-runtime --dump-config` 通过；`telegram-gateway`、`dsh-cron`、`dsh-assistant` 各出现一次，另有预期的 `dsh-cron-manager` 实例；没有启动 Web 服务。
- Web 合同：`dsh-web-packages.test.sh`、`self-describing-plugins.test.sh`、`package-dsh-web.test.sh` 全部通过。
- portable 顺序修复 TDD：缺少 remove 时，归档内真实安装入口以预期消息失败；补最小 remove/add 后，`package-dsh-web.test.sh` 转绿。
- 完整发布合同复跑：`dsh-web-deploy.test.sh`、`package-dsh-web.test.sh`、`dsh-web-packages.test.sh`、`self-describing-plugins.test.sh`、LAN proxy/notify Node 测试、Shell 语法检查和 `git diff --check` 全部通过。
- 本机正式部署：`dsh-web-local.service` active，`127.0.0.1:3080` 单监听；token 登录 303→Cookie 200；归档错误日志为空；Workspace 备份位于 `/home/herman/.dsh/recovery/cron-per-run-session-archive-20260904T193747Z/local`。
- 远端历史收敛：archived set 从 1 增至 113，新增集合严格等于冻结的 112 个候选；原 16 个 membership 不变，96 个原未分组会话因归档不再显示；Workspace tables 未变。
- 远端 Session 完整性：112 个目录、147 个普通文件、9,573,075 字节，物理 manifest 仍为 `fc573aeca24f5ef57c222eadff83de92e85fbdcfd2f9add735507b5183433a8c`。
- 远端运行：归档 SHA 为 `e2059f4565565f90e67fb220b9ff686ec5be898d7191c6af58e95fa95990cf15`；run id 为 `20260904T200750Z`，监督 PID 为 `3146728`；loopback/LAN 两个 3080 listener 正常，连续观察超过 3 分钟。
- 远端 HTTP：token 登录 303→Cookie 200；LAN 与公网域名无会话 API 为 401；跨 Origin 和非白名单来源均为 403；stderr 为 0，未发现 preset、ABI、通知或归档错误。
- `git diff --check` 通过。
- 多 Agent 复杂度复核：现有 Scheduler 串行驱动已提供单飞保证，不增加第二套锁或状态，复杂度预算仍为 C1 一个长期规则，结论 `PASS`。
- 独立最终审查：`BLOCKER` 为 0；核心历史归档测试已改走公开的 Scheduler 启动/轮询路径，账本故障测试也不再替换私有字段。

## 遗留

- Telegram 启动通知器没有记录失败，表示 Telegram API 接受了发送请求；用户是否实际收到新的 HTTPS 登录 URL，仍需用户侧确认。
- 自动验收没有主动触发真实模型、Telegram 对话、Cron 业务任务或 Notion 写入；这些真实业务行为与本次进程、认证和数据完整性验证保持区分。
- 普通归档流程仍没有完整事务式 rollback。恢复点保存了迁移前 Workspace、候选、membership 和 Session 文件摘要，但 Profile 与 release 切换不属于自动回滚事务。
