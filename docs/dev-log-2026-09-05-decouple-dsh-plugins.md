# 开发日志：拆分 telegram-gateway、dsh-cron 与 dsh-assistant

- 日期：2026-09-05
- 范围：`telegram-gateway/`、`dsh-cron/`、`dsh-assistant/`、`scripts/dsh-web-install-plugins`、结构门禁与本地 Web 安装验证

## 目标

让三个插件可以分别构建、安装和启动，源码、测试、清单、声明文件和 bundle 不再引用兄弟插件。Telegram 传输只由 gateway 负责；cron 只负责调度、执行和账本；assistant 只通过自己定义的端口使用可选投递服务和 cron control v2。Harness/Cordis 继续作为三个插件共同的宿主实例。本次只交付本地候选分支，不修改 `upstream/`，不启动 Web 或真实 Telegram，不部署、合并或推送。

## 时间线

1. 在未修改的 `f2a81d8` 上记录基线。Gateway 为 6 个测试文件、148 项全过；Cron 为 23 个通过文件、1 个失败文件，625/626 项通过，失败是既有 fixed-session resume 断言；Assistant 为 19 个通过文件、2 个失败文件，347/348 项通过，分别是 Harness 缺少 `@deepseek-ai/dsh-tool-subagent-report` 和本次要消除的 cron import 边界红测。
2. 检查 Cordis 服务生命周期和 Unix socket HTTP 行为。实验确认共同 root 上注册的命名服务可以被消费者按次 `ctx.get`，dispose 后不应继续缓存 provider；Node 原生 HTTP client 可以覆盖现有 Unix socket 路径，无需再引入 control 包依赖。
3. 运行第一性原理机械预算校验，结果为 `PASS / concept_count=2`。长期只增加 Gateway 的 `dshTextDeliveryV1` 和 Cron 的中性投递值/旧数据读取边界。独立盲审与低成本挑战者均确认不能再压成一个概念。
4. 建立独立 worktree 和 `codex/decouple-dsh-plugins`。三名 worker 按目录并行执行 Gateway、Cron、Assistant，各自先补失败测试再写最小实现；Lead 独占根脚本、结构门禁、集成验证和文档，并逐个检查真实 diff。
5. Gateway 先提供版本化完整文本投递服务。测试覆盖成功、无 chat、明确拒绝、首片不确定、部分分片、中断、注册/撤销和首次授权后使用新 chatId。
6. Cron 删除 gateway/credentials 的源码和清单依赖，本地拥有 turn summary 与投递端口视图；投递时按次解析服务。领域值改为 `default|silent`，旧 `telegram` 只在读取边界归一化，control 只保留 v2。对空白成功时间和空白错误证据先补红测，再收紧为 `uncertain`。
7. Assistant 删除 cron/gateway/credentials 依赖，outbox 一次提交完整文本；本地实现五个操作的窄 control v2 client，并结构化校验 `dsh-cron/run-finished`。Gateway 或 cron 缺失时只让对应协作能力降级，不阻塞插件启动。
8. Source installer 改为先执行 Harness 的冻结安装和正常构建，再让三个插件复用 Harness 虚拟依赖层。只补 `@types/node`、`tsdown`，清退合成依赖树、pnpm shim、手工 `fs-ext` lifecycle 和兄弟插件链接。
9. 开发期间 `main` 从 `f2a81d8` 前进到 `b4700e5`，新增 Cron per-run Session 归档。收口前变基，冲突仅位于 `index.ts` 与 `scheduler.ts`；合并时保留 `workspaceRegistry`/归档行为，同时继续移除 credentials/gateway。
10. 变基后的完整 Cron 测试首次暴露一个新回归：主线新增归档测试仍按旧构造函数参数调用，实际没有使用测试注入的 `driveTurn`。迁移八处新增测试到新构造签名，并让投递 seam 返回合法 v1 结果；聚焦用例和最终全套随后通过。没有为旧内部构造签名增加生产兼容层。
11. 在 `/tmp/dsh-web-decouple-acceptance.bN3FXT` 作为隔离 `DSH_WEB_HOME` 执行真实插件安装和 `--dump-config`。Harness 和三包 clean build、Profile remove→add、配置展开均成功；没有启动 Web 服务。
12. 首次盲审收口期间，本机 `main` 又前进到 `d413868`，其中 `972123a` 修复 Cron 对当前 Harness `Session.snapshotEvents()` 的读取并增加真实 Session 回归。再次变基，保留该生产修复，把新增测试同步迁移为 `deliver:'default'` 和本地投递端口签名；在 `/tmp/dsh-web-decouple-final.zdgnK5` 重跑完整测试、clean build、隔离安装与配置展开后，盲审关闭基线漂移阻塞并最终判定 `PASS`。

## 逻辑链条

- 相同配置只说明值相同，不能保证运行时共享同一个 Cordis 实例。唯一实例来自同一 Harness 宿主及其虚拟依赖层，因此构建侧应复用宿主依赖，运行侧应使用命名服务，而不是让插件彼此 import。
- Telegram token、chatId、HTTP、分片和错误分类是一项传输责任，只属于 gateway。Cron 和 assistant 只需要“投递完整文本并得到终态”的能力。
- Cron 的 `default|silent` 表达通用产品策略；`telegram` 是历史传输实现名，只能在私有读取边界兼容。读取不主动重写旧 `jobs.jsonl`，避免为了重构增加数据迁移风险。
- Assistant 需要 cron 的五个控制操作，但不需要 cron 的领域类型和实现。已有 Unix socket/HTTP 协议足以支撑本地窄 client；同步升级唯一仓内消费者后，保留 v1/v2 双协议只会增加永久分支。
- 保留 `session-telegram` 的 run-now 工具组合，因为它是现有产品可见性，不会 import 或调用 gateway，也不阻塞 cron 独立启动。新增 `runNowSessionId` 公共配置不能降低当前依赖复杂度，反而扩大配置面，因此否决。
- 否决第四个 adapter 插件、共享 contracts 包、消息总线、channel registry、根 workspace、三份 lockfile、插件私有 Harness 和第二套 cron control 服务。这些方案都会新增长期 owner 或同步面，而当前两个端口已经覆盖真实变化。

## 改动

- `telegram-gateway/src/text-delivery.ts`：实现 `dshTextDeliveryV1`，Gateway 生命周期内注册/撤销，按当前已授权 chat 投递完整文本并返回 `delivered|failed|uncertain`。
- `dsh-cron/src/` 与 `dsh-cron/tests/`：本地投递端口、严格结果解码、中性投递值、旧行读取兼容、control v2，以及与主线 per-run Session 归档的组合测试。
- `dsh-assistant/src/delivery-port.ts`、`cron-control-adapter.ts`、`outbox.ts`、`index.ts`：assistant-owned adapters、完整文本 outbox 和结构化事件解码。
- 三个 `package.json`/`tsdown.config.ts`：删除兄弟包编译和打包依赖；Cron/Assistant 同时删除 credentials 依赖。
- `scripts/dsh-web-install-plugins`、`.gitignore`：复用 Harness 虚拟依赖层并删除旧合成依赖树入口。
- `scripts/tests/plugin-boundaries.test.sh`：同时检查源码/测试、manifest、clean bundle 和声明文件中的兄弟包引用。

## 验证

- 最新基线：本地 `main` 为 `d413868`，其中包含现场 `origin/main=b4700e5`；两者都是候选分支祖先。
- Gateway 完整 Vitest：7 个测试文件、155 项全部通过。
- Cron 完整 Vitest：26 个测试文件、644 项全部通过，包括主线新增的 per-run Session 归档和真实 `Session.snapshotEvents()` 回归。
- Assistant 完整 Vitest：21 个测试文件、354 项通过；唯一失败 suite 仍是基线已复现的 Harness 缺少 `@deepseek-ai/dsh-tool-subagent-report`，本次原有 cron-import 边界失败已消失。
- 三包 clean typecheck/bundle：隔离 installer 中全部通过。构建时 Harness 虚拟层内三个兄弟包遗留链接数为 0，三包源码 `node_modules` 均解析到同一虚拟层；`.dsh-plugin-node_modules` 不存在。
- 结构门禁：`plugin sibling dependency boundary passed`，覆盖 `src/`、`tests/`、四类 dependency 字段、`lib/**/*.js` 与 `lib/types/**/*.d.ts`。
- 根脚本：`dsh-web-packages.test.sh`、`self-describing-plugins.test.sh`、`package-dsh-web.test.sh` 全部通过；安装、runtime、打包脚本通过 `bash -n`；`git diff --check` 通过。
- 隔离安装：三个 bundle 均由同一 Harness 构建入口生成并成功加入 Profile；`--dump-config` 展开出 assistant、cron scheduler/manager 和 gateway 的既有 portable 配置，没有旧 token/chatId/apiBaseUrl 配置。
- 上游边界：`git -C upstream/deepseek-harness status --short --untracked-files=no` 为空，没有修改上游源码。

## 遗留

- Assistant 的 `tools-visibility.spec.ts` 仍依赖当前 Harness checkout 不提供的 `@deepseek-ai/dsh-tool-subagent-report`；该失败在改动前已复现，不由本次重构引入，也不能靠重新建立插件间依赖修复。
- 未执行真实 Web 启动、Telegram 实发、生产数据读取、部署、合并、推送或生产验收；这些动作继续等待单独授权。
- 仓内只发现 assistant 这个 control 消费者，因此本次只提供 v2。若未来部署前发现真实外部 v1 客户端，应作为新的兼容需求单独处理。
