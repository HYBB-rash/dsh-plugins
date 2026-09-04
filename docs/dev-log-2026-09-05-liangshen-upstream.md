# 开发日志：直接使用上游 dsh-web 子模块

- 日期：2026-09-05
- 范围：上游子模块、本地梁神插件安装来源。

## 目标

用户澄清：完整上游库作为子模块，直接使用上游已修复的插件，不要自己的 fork。

## 时间线

- 前两轮将插件单独导入并拆出 HYBB-rash/dsh-liangshen，属于误解；保留当时日志并标记已废弃，撤销当前项目对此仓库的引用。
- 核对 npm：@linxin666/dsh-liangshen 0.3.14 已发布。隔离 Profile 安装原版后，用当前 Harness 的真实 Session 验证新建和恢复两条首轮路径，均通过。
- npm 0.3.14 的 tool-bootstrap.mjs 与上游提交 69e7a4ee3d3e5d662caef95dc5dd48b5aa8dd5d2 的文件 SHA-256 一致，均为 4efb2cd0237551626c38b4f6a0197c298ff800f9eeda2ceb2b4fd522c539afaa。
- 删除旧 liangshen gitlink，添加整个 https://github.com/zhu1090093659/dsh-web.git 为 upstream/dsh-web 子模块，固定以上提交；无上游源码修改。
- 撤销此前为了本地 fork 新增的安装、构建、打包及对应测试接入，使这些脚本恢复主线版本。
- 使用本地 Harness 插件管理器移除 @deepseek-ai/dsh-liangshen、安装 @linxin666/dsh-liangshen@0.3.14，并启动本地服务。保持原 Telegram sessionId、agentPreset 和业务数据。

## 逻辑链条

上游已发布修复，没有继续维护私有补丁的必要。完整原库子模块保留上游结构和 Git 历史；运行时使用同版本上游 npm 发布物。源码追踪与插件启用是两件事：加入子模块不会自动启用整个 dsh-web 插件集合。

## 改动

- .gitmodules / upstream/dsh-web：上游原仓库子模块，插件位于 packages/dsh-liangshen。
- 移除 liangshen 旧子模块引用。
- 恢复 scripts/dsh-web-install-plugins、scripts/package-dsh-web 和对应三个测试为主线内容。
- 两份前序日志标记为历史方案。

## 验证

- 上游 npm 0.3.14：真实 Session 新建/恢复，pre-step 放行用户消息、首轮双工具组装、1024 输出预算均通过；无真实模型或 Telegram 消息发送。
- 发布物与固定源码的修复脚本校验和一致。
- 验证本地安装包版本、生成 preset、服务状态和启动错误日志。

## 遗留

误建的 HYBB-rash/dsh-liangshen 仓库不再被主项目或本地服使用；未擅自删除远端仓库。主仓库任务分支尚未合并或推送。远端服务没有部署此次变更。
