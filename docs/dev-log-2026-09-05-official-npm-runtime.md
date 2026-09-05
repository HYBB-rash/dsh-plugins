# 开发日志：官方 npm 运行时迁移候选

- 日期：2026-09-05
- 范围：三个自有插件、独立 npm 构建、Web 安装/运行与归档部署入口、相关说明和项目 Skill。
- 状态：本文记录截至 10:52 的候选实现阶段，当时尚未发布；唯一旧会话续接阻塞已按用户批准的单项例外关闭，原始数据保留，兼容性问题本身未修复。随后用户另行授权双端上线，现场经过与最终状态见 [双端上线日志](dev-log-2026-09-05-local-hermes-npm-deploy.md)。合并与推送仍分开。

## 目标

移除 Harness 与 dsh-web 源码子模块，仓库只维护自有插件和薄脚本。安装时选一次官方最新发布组合，自有插件基于该组合的 SDK 构建为 tgz，由官方插件管理器装进统一 Web Profile；重启不重新选择版本。保留数据、凭据、安全入口及人工切换权限。

## 时间线

以下按本轮实际操作顺序记录；没有记录精确时刻的步骤不补造时间。

1. 核对项目规则、现役开发/部署 Skill 和工作树。原分支为 `codex/install-dsh-web-all`；fetch 后确认 main `5b4a903` 不落后远端，从 main 建立 `codex/official-npm-runtime`。本机现役 3080 属于另一个 checkout，保留不动。
2. 建立根 npm workspace、工具链和测试配置，把 peer/dev SDK 改为真实发布依赖。首先用返回 SessionHeader 的测试夹具暴露 gateway/cron 的旧快照访问；相关测试先红，再把三处调用改为 `list(signal)` 与 `header.id`，189 项聚焦测试转绿。
3. 助理原测试引用当前 npm 系列没有发布的报告工具。没有永久跳过，而是保留真实 Cordis scope 工具隔离，并用已发布的子代理生命周期接口、真实 WorkerController/SQLite 验证完成回传及重复事件幂等。
4. 初次 npm 安装复用了历史 node_modules 链接，不能作为独立构建证据。把旧目录移到 `.cache/pre-npm-runtime-node_modules-20260905`，重建根 lock 并全新安装；清除三个插件目录下的旧依赖链接。之后所有构建与完整测试使用发布 SDK。
5. 核对两个子模块干净后移除 gitlink 和 `.gitmodules`。工作目录移到 `/tmp/dsh-upstream-retired.Dru1Gi` 保留恢复，不修改上游。仓库实现不再从其中构建或解析模块。
6. 重写安装/运行、打包/上传/目标安装/启动入口。采用已选运行时的 npm lock、官方 remove/add、offline npx 与 `--expose-internals`。归档只列入 tgz、清单、配置和薄脚本；合成凭据测试发现额外文件会被带入，先保留失败测试，再改为两个凭据文件白名单。
7. 在新的临时构建目录中解析官方 `0.1.2-rc.1` 与 18 个固定 Web 包，按运行时 lock 选择 SDK。55 文件、1156 项全部通过后产出三个 tgz。约 05:55 开始在空 home 真实安装同批官方运行时与插件；未复制生产凭据。
8. 隔离启动最初因测试叠加 patch 重复插入 cron manager 而失败。确认官方多次 `--patch` 为追加而非替换后，测试附加 patch 只保留覆盖项；不修改生产 patch。5092 成功启动，禁用 gateway polling 与 cron scheduler，assistant 为 web 模式。
9. 本机浏览器可以读页面，但常规鼠标自动化及截图超时；重新开同浏览器标签页，并用文档允许的页面调试接口激活页面真实按钮处理器后，中文侧栏、设置、插件列表/管理、皮肤和任务看板正常响应。没有直接伪造服务端状态或调用隐藏业务 API。创建了一张不执行、不开定时的测试卡片，返回 revision 1、待办 1。
10. 补测本地准备入口不得覆盖旧启动器，以及原生终端失败不得先改 Profile；两条先失败，随后把本地准备改为新的 incoming/batch 目录，安装增加 node-pty 真实子进程探针。SQLite、普通子进程和 node-pty 在本机均实测通过。
11. 用真实状态副本检查兼容性。会话 JSONL 与预设/cron 仅复制，assistant 用只读 SQLite backup；探针初次把官方 inspection 的字段误写为 header，按发布类型纠正为 meta。最终列出 89 会话，88 个 inspect/prepare 成功，1 个历史 Web 会话被未知 `context-route/change` 事件拒绝。固定 Telegram 会话不在失败项中。未过滤、改写或删除原日志事件。
12. 06:15 从 Git index 导出 `/tmp/dsh-clean-npm.Wy0VTf`，不带 upstream、历史 lib 或 node_modules；npm ci、构建、55 文件/1156 项测试及当时 21 项脚本测试全部通过。之后补上真实 tar 安装的成功/失败 current 行为测试，脚本测试现为 23 项通过。
13. 只停止本轮 5092 进程，在 registry 指向不可达 loopback、npm offline 的条件下重新启动。运行时与 Profile 的四个清单/锁文件哈希前后相同，stderr 为空，未认证 HTTP 仍为 401，已有浏览器认证可继续访问。现役 3080 PID 保持不变。
14. 使用同批无凭据制品运行 `self-describing-plugins.test.sh`，官方安装到另一临时 Profile，三个 bundle 各一次、四个自有实例各一次、没有 all/perf 的断言全部通过。目标临时目录由测试脚本清理；供应链查询出现一次 registry 重试，最终成功，没有改用另一版本。
15. 收尾停止本轮离线验收实例、关闭本轮浏览器标签页；确认 5092 已释放，3080 仍是原 PID 2094121。状态副本与实验日志留在 Git 忽略的 `.cache`，未删除原始数据。两个上游源码工作目录仍在上述临时恢复目录。
16. 用户回复“允许”，明确批准：只将已识别的一个历史 Web 会话暂时排除在新版续接验收之外，完整保留原文件。这不扩大停机、安装、切换、合并或推送权限，也不允许过滤日志事件或将其他会话自动列为例外。
17. 10:52 只读复核该会话原文件与此前实验副本，二者 SHA-256 都为 `f24e6a77a91ebec915b7ceb2351b4fd4090f2dbafddd44ffbf91697a115f5ca8`；原文件为普通文件、权限 0600、大小 57453 字节。3080 仍由原 PID 2094121 监听，5092 无监听。本次只更新验收记录，不改运行代码或业务数据。

## 逻辑链条

- 不保留源码或 fork：SDK、CLI 和 Web 包均取正式 npm 制品；原始源码工作目录只临时留作人工恢复，不参与实现。
- 不将 SDK 各自设为 latest：从本批已装 Harness 的真实 lock 取版本，编译/测试失败即中止，目标机使用本批版本而非再次选择。
- 不把 npx 缓存当安装树：薄入口验证实际 CLI 路径与安装版本，只在指定 runtime 工作目录执行 offline npx。
- 不手改 Profile：自有 tgz 有稳定保留路径，所有 bundle 登记与移除经官方插件命令。先删除选定旧包再安装，保留第三方 provider 在自有 consumer 之前。
- 不运输 native addon：归档没有 Node/node_modules；在目标平台安装并实际测试伪终端能力。不自动修改系统软件。
- 不把副本失败解释为“可安全迁移”：缺少的事件语义属于上游发布能力；删除事件、伪装 ignorable、写持久化兼容层均超出本方案，未实施。

## 改动

- 根 `package.json`、`package-lock.json`、`vitest.config.ts` 和三个插件清单；删除旧源码别名测试配置。
- gateway/cron 三处列表 API 适配；assistant 子代理完成测试与 persona 提示。
- `bin/dsh`、`scripts/lib/web-package.mjs`、两个本地入口、打包/上传/独立目标安装/启动入口。
- `config/web/plugins.json` 固定 18 包；不安装 all/perf，不自动扩张成员。
- README、中英文说明、AGENTS、VS Code 任务及两份项目 Skill 候选说明；中文部署说明记录人工备份与失败边界。

## 验证

| 项目 | 证据与结论 |
| --- | --- |
| 独立/干净构建 | 发布 SDK 安装后构建成功；临时构建和干净 index 导出分别完整通过 55 文件/1156 测试，未跳过 |
| 脚本契约 | 23 测试通过：字面量参数、默认/显式端口、离线入口、锁、版本、上传隔离、安装失败、current、监督、归档与凭据、既有代理/通知 |
| 官方运行时 | 本批 Harness 0.1.2-rc.1；17 个 scoped Web 包 0.3.14，dsh-better-sidebar 0.18.0；真实 Profile 与页面列出自有 3 包和 Web 18 包 |
| 原生能力 | Node SQLite 内存查询、普通子进程、node-pty 打印预期输出并正常退出 |
| 页面交互 | 中文、侧栏、插件管理、主题面板、任务看板与测试卡片真实交互；不是仅安装回执。没有执行 SSH/模型/Telegram 等真实业务 |
| 状态副本 | 88/89 会话可读取并准备续接，失败 1；10 个 cron 任务、0 无效定义；assistant 0 开放项、0 待发、3 Web observation；1 用户预设无 broken |
| 重启 | registry 不可达时 Web 启动；四个版本/依赖清单哈希不变；401 与已有认证访问正常 |
| 边界 | 插件 sibling 依赖边界、Docker 退役检查、Bash 语法、git diff --check 通过；无 gitlink |
| Skill | 两份 quick_validate.py 均通过；为规则拆分与真实机械测试使用 skill-creator / deterministic-skill-creator。仅结构通过，不宣称整个运行行为门禁或生产验收已完成 |

## 遗留

1. **已批准的单项例外，原续接阻塞关闭：** `session-e9b22c88-9f93-45cd-8763-f1b578ff6602` 暂不要求在新版续接；不代表未知 `context-route/change` 事件已获兼容。原文件保留在 `$DSH_HOME/sessions/--home-herman-Projects-DeepSeekHarness--/session-e9b22c88-9f93-45cd-8763-f1b578ff6602/session.jsonl.zstd`，此前完整实验副本在 `.cache/data-copy-YeUSBe`。用户没有允许删除、转换或跳过其他会话。正式切换时仍应将原文件纳入停机一致性备份；以后官方兼容时可在副本上重新验证。
2. 真实 Telegram/cron/assistant/模型/Notion、远端平台原生能力、LAN/域名入口和 Telegram 新登录链接仍未验收；本轮没有相应停机、切换、发送业务消息授权。
3. 安装写 runtime/Profile 不是事务；一次性备份与人工恢复边界保持明确，无自动 rollback。未提交、未发布、未合并、未推送。
4. 官方独立 Profile 的 peer 检查会把由宿主提供的 SDK/React 报为缺少或范围警告；这不等同于已证实的实际不兼容。本轮实际运行可加载，未强装额外 SDK 或隐藏警告。以后新批次仍须实际验证，不能继承本次 PASS。
5. 浏览器自动化鼠标/截图通道的超时没有改动插件来绕过；UI 证据限于真实 DOM 状态和原生按钮处理器交互，未声称逐像素验收。
6. Skill 候选已反映新入口，但完整行为门禁没有宣告通过：部分补证测试并未单独经历红绿循环，生产授权/目标识别的代表性结果也未用户验收。临时分类记录不参与运行时，不新增自动操作框架。
