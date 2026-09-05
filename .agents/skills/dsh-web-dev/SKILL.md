---
name: dsh-web-dev
description: 在 dsh-plugins 中独立构建自有插件，通过官方 npm Harness 和 plugin add 安装、刷新或启动本地 Web。适用于 telegram-gateway、dsh-cron、dsh-assistant、Web Profile 和插件注册；不执行线上切换。
---

# 本地 Web 开发

先读根 AGENTS.md，并完整读 [部署与运行说明](../../../docs/dsh-web-portable-deployment.md)。仓库已移除上游源码；不要恢复子模块、fork、上游 patch、源码工具链借用或旧 scripts/dsh-web。

## 已确定的执行入口

从任务分支进入 nix develop。构建和测试使用 npm ci --ignore-scripts、npm run build、npm test、npm run test:scripts；依赖均来自本仓库清单与发布 SDK。

- 安装／刷新：`DSH_WEB_HOME=<绝对路径> ./scripts/dsh-web-install-plugins`。脚本一次解析最新运行时、按其 SDK 构建测试，再通过官方插件管理器装包；不启动。
- 启动：`DSH_WEB_HOME=<同一路径> ./scripts/dsh-web-runtime --no-open`。默认 5080，临时端口通过 --port 指定；不安装、不更新。
- 只合成配置：同一 runtime 入口加 --dump-config。不把它当作完整加载或业务验收。
- 已安装 CLI：`DSH_HOME=<同一路径> ./bin/dsh <官方参数>`；保留脚本内 offline npx 和 loader 参数。

不要手写 Profile bundle 或维护 Profile node_modules。缺发布 SDK、peer 冲突、原生依赖不可用时报告安装失败；不强装、不改上游、不自动降级。

## 状态与权限

测试必须用隔离 home 和合成配置；不要读真实凭据或启动真实 Telegram/cron。正式本机端口固定 3080。

安装器拒绝新版运行锁；旧 Profile 必须先明确停机，才能加 --migrate。此参数只声明停机已经完成，不授予停机权限。安装失败保持现场，不清空 home、业务 storage 或所有 Profiles，不临时拼清理／恢复脚本。

可选动作仅为上述构建、测试、隔离安装、隔离启动、配置查看；真实实例的安装／启动必须有该次明确授权。权限不明则报告 unsupported 和缺少的具体授权，不执行外部动作。源码或行为修改仍依据当前用户任务，不由本 Skill 扩张需求。

## 交付证据

报告构建与全部测试、官方 tgz 安装、最终插件列表和真实 UI 验证结果，明确区分配置合成、启动成功与业务验收。遵循项目开发日志和分支规则。打包／上传／真实远端运行转交相邻 dsh-web-deploy。
