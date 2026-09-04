# 开发日志：梁神插件本地维护版

- 日期：2026-09-05
- 范围：liangshen 子包、插件安装及归档打包、本地 Web Profile。

## 目标

把梁神插件 fork 到本仓库维护，修复当前 Harness 兼容问题，替换本地 Telegram 使用的旧插件。保留原许可、来源、preset id 和已有会话。

## 时间线

- 04:20 前后：前序调查定位旧版 0.3.13 的 scanEvents 对 session.events.length 读取失败。现场全新 session-telegram-liangshen 第 1 轮在模型调用前结束。
- 04:23：建立基于最新 origin/main 的 codex/liangshen-local-fork 工作树。查询安装包元数据，确认源码来自 zhu1090093659/dsh-web 的 packages/dsh-liangshen。
- 04:24：拉取来源提交 69e7a4ee3d3e5d662caef95dc5dd48b5aa8dd5d2，发现 0.3.14 已带 #1350 的 snapshotEvents 修复。导入子包源码、测试和许可证，采用本仓库包名 @deepseek-ai/dsh-liangshen。
- 04:26–04:29：独立 Harness 构建第一次因上游 Git hook 对子模块 worktree 配置限制失败；使用其支持的 CI=true 完成构建。测试配置补齐路径别名与标准装饰器转换。原版未作用域 schemastery 在本仓库依赖视图中不存在，改用 Harness 自带 @deepseek-ai/schemastery。上游 announcement 测试的默认 Home 改为测试临时目录，避免写真实 preset。
- 04:29–04:30：103 项测试通过。用同一真实 Session 测试加载现场旧 0.3.13，精确复现 scanEvents:345 的 undefined.length；维护版通过。安装脚本、打包脚本和自动 bundle 合成测试通过，隔离 Profile 安装成功。
- 04:30：观察到其他操作曾在 04:29:48 重启本地服；复核配置仍为 liangshen，旧包仍为 0.3.13，无活跃 Telegram 回合。未覆盖现场 portable.patch.yml。
- 04:31:27：停止本地 dsh-web-local.service，备份原 Profile 和 preset，通过 Harness 插件管理器移除原版、安装维护版 tarball，再启动服务。实际 preset 校验和与维护版源码一致；服务 active，启动日志无错误。

## 逻辑链条

故障是外部插件读取被删除的 Session API。采用上游已发布源码修复，避免改 Harness。fork 的单位是插件子包，不引入整个 dsh-web 仓库。独立包名保证原版升级不会覆盖维护版；preset id 不变以维持当前会话绑定。安装器主动移除原版，防止两个同步器争写同一 preset。

## 改动

- liangshen/：导入 0.3.14，版本为 0.3.14-herman.1；保留 LICENSE/NOTICE，新增 FORK.md 说明来源和维护边界；调整构建、schema 依赖和包标识。
- scripts/dsh-web-install-plugins、scripts/package-dsh-web：第四个本地插件参与构建、安装和归档；安装前移除原版。
- scripts/tests/：扩展四插件安装、打包、自动登记验证。
- liangshen/tests/current-session.test.ts：当前真实 Session 新建/恢复的首轮 pre-step、组装和请求预算；支持只读加载历史版本进行回归对照。

## 验证

- 9 个测试文件、103 项通过；旧版对照在预期位置失败。
- dsh-web-packages.test.sh、package-dsh-web.test.sh、self-describing-plugins.test.sh 通过。
- 隔离 Home /tmp/dsh-liangshen-install-20260905 安装及 dump-config 通过，liangshen 行只出现一次。
- 本地安装来源：/home/herman/.local/share/dsh-local-plugins/deepseek-ai-dsh-liangshen-0.3.14-herman.1.tgz。
- 旧状态备份：/home/herman/.dsh/recovery/liangshen-maintained.31stfN。它只是本次人工备份，不是新增自动回滚机制。

## 遗留

尚待用户通过真实 Telegram 消息确认回复。自动测试没有调用真实模型或发送 Telegram 消息。未部署远端，未推送或合并分支。服务运行入口仍是既有本地 checkout；插件作为独立安装归档载入。
