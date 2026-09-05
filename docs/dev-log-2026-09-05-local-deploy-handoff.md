# 开发日志：本机部署批次与 systemd 入口衔接

- 日期：2026-09-05
- 范围：本机准备入口、共用归档安装器、脚本测试与部署文档。

## 目标

让已准备的本机批次安装后更新 systemd 实际使用的 current，不要求用户手动维护软链接。准备、停机备份、安装、启动继续分离。本轮只修改代码和做隔离验证，不安装、停止或重启任何正式服务，不修改 Home Manager，不合并或推送。

## 时间线

1. 13:30–13:32 阅读项目规则、当前部署说明、开发／部署 Skill、TDD 及测试编写规则。工作树干净；本地 main 比 origin/main 多三个已存在的 cron 修复／记录提交，保留它们，从最新本地 main（2a0a2cc）创建 codex/local-deploy-handoff，没有回退到较旧远端。
2. 只读核对本机 unit：ExecStart 为包根目录 current/bin/web，正式服务 active，MainPID 2315861。旧安装器从 package_root 同时取归档并发布 current，因此直接在 incoming 执行会把指针发布到错误层级。
3. 13:32 写隔离回归：成功安装后运行 systemd 同路径的新 Web 替身；安装失败、服务活动、入口错配、坏校验和保持旧指针；准备缺本机凭据立即拒绝。第一版负向检查过弱，会因旧入口误走准备而“通过”，随即增加明确失败原因断言，确认六项新增测试均因缺失行为而失败，再修改实现。
4. 13:33 在共用安装器增加 --archive-dir，仅分开归档来源和发布目的地；在本机入口增加 install 子命令。第一次完整脚本回归 31 项通过。
5. 13:33–13:35 补 README 和部署步骤，强化“不自动启动”、安装失败退出码和 DSH_WEB_HOME 目标一致性断言。再次运行 31 项脚本测试通过；完整插件测试 55 文件、1160 项通过；插件依赖边界与 Bash 语法检查通过。
6. 13:35 只读复核正式服务仍 active、MainPID 2315861，未切换服务。整理本日志和项目经验，准备独立分支提交；发布、验收、合并与推送仍待各自授权。

## 逻辑链条

- 保留同一个归档安装器；不用复制、搬运归档到活跃目录来规避路径错位，也不再增加一套安装实现。
- 不改 unit：现有启动路径本身正确，问题是安装器更新错了目录。让安装明确指定 archive-dir 和 package root 即可。
- 不恢复旧自动停服／快进 checkout／重启脚本；准备不修改服务，安装检查已停服但不自动停服或启动。
- 本机准备强制显式凭据目录，避免默默沿用远端 bot 默认值；实际凭据内容未读取、未复制。
- install 使用新批自带的安装器，不重新构建或选择 latest。旧批次没有新参数，需重新准备，不混用新版入口与旧安装器。

## 改动

- scripts/dsh-web-local-deploy：保留无参数准备，增加 prepare 别名和 install <batch>；校验本机服务状态／入口；安装成功给出独立启动命令。
- scripts/dsh-web-install：可从 --archive-dir 读取归档，仍向 DSH_WEB_PACKAGE_ROOT 发布 releases/current；远端原调用方式不变。
- scripts/tests/web-deploy.test.mjs：新增六项本机流程回归，保留原远端、通知及监督进程测试。
- README.md、README.en.md、docs/dsh-web-portable-deployment.md：记录可重复执行的本机流程及失败边界。
- MEMORY.md：追加包根目录和 incoming 批次不能混淆的经验。

## 验证

- RED：新增六项测试失败，原因分别为 install 被当作 prepare、未执行安装／停服检查、缺少本机凭据保护。
- GREEN：nix develop -c npm run test:scripts，31/31 通过。
- nix develop -c npm test，55 文件、1160/1160 通过。
- nix develop -c bash scripts/tests/plugin-boundaries.test.sh，通过。
- nix develop -c bash -n scripts/dsh-web-local-deploy scripts/dsh-web-install，通过；git diff --check 通过。
- 测试实际调用本机脚本、归档安装器、tar、sha256sum、软链接发布与新入口；systemd 和包内安装／Web 用测试替身，防止真实服务及联网安装副作用。未声称真实 npm 重装或 systemd 重启已经验收。

## 遗留

- 正式安装、启动和真实业务验收未执行；本轮不授权这些动作。
- 安装失败保留 current 不等于数据事务回滚，runtime/Profile 可能部分变化；必须先停机备份，失败保持停止并报告。
- ActiveState/MainPID 检查不能代替操作者核实精确后代进程树与端口释放；需保持同一实例单写者。
- 本机 DSH_HOME 需与 unit 相同；脚本不修改系统配置、不自动备份全部业务状态、不增加自动回滚框架。
