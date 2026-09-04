# 开发日志：梁神插件改为子模块

> 历史记录：此处把子包拆成独立仓库是对用户意图的误解。当前已改为直接引用整个上游原库，见 dev-log-2026-09-05-liangshen-upstream.md。

- 日期：2026-09-05
- 范围：liangshen 源码管理、独立仓库和主仓库 gitlink。

## 目标

按用户要求，将上一轮直接纳入主仓库的梁神插件改为独立 Git 子模块，保留已验证的兼容修复、现有安装入口和本地运行状态。

## 时间线

- 04:34：核对任务工作树干净，变基至最新 origin/main。确认主仓库为公开仓库，账号为 HYBB-rash，dsh-liangshen 尚不存在。
- 04:35：用 git subtree split 提取 liangshen 子包历史到独立仓库；修正 package.json 仓库地址，补充 FORK.md 子模块操作说明和构建缓存忽略规则。
- 04:36：创建并推送 https://github.com/HYBB-rash/dsh-liangshen；主仓库同路径新增子模块，固定 ceda97c03973a2441899604e0fc2d08e7623951c。原目录先移至 /tmp/dsh-liangshen-submodule-migration.JOEQrd/liangshen 保留，再从远端克隆子模块。
- 04:36：在子模块布局下运行原有测试，9 个文件、103 项通过。主仓库安装入口和自动插件登记测试继续验证同一路径。

## 逻辑链条

子模块需要可获取的独立仓库与已发布提交，因此仅推送新的插件仓库；主仓库任务分支继续保留，不合并主线。沿用 liangshen 路径可避免改动安装、构建与归档脚本。独立仓库保留原子包导入历史、LICENSE 与 NOTICE；不复制整个 dsh-web monorepo。

## 改动

- .gitmodules：记录 liangshen 子模块远端。
- liangshen：普通目录改为 mode 160000 的 gitlink，固定具体提交。
- 独立仓库元数据和维护文档：指向 HYBB-rash/dsh-liangshen，说明依赖父项目 Harness 的开发方式。

## 验证

- 子模块布局下 103 项测试通过。
- dsh-web-packages.test.sh 与 self-describing-plugins.test.sh 验证安装路径和自动登记。
- 本次不改运行时代码或 preset 内容，不重启本地服务；上一轮安装归档继续运行。

## 遗留

主仓库分支尚未合并或推送；真实 Telegram 回复验收仍沿用上一轮的待确认状态。插件独立仓库已推送，主仓库引用的提交可从远端获取。
