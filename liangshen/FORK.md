# 本仓库维护的梁神模式

来源：https://github.com/zhu1090093659/dsh-web ，子目录 `packages/dsh-liangshen`，提交 `69e7a4ee3d3e5d662caef95dc5dd48b5aa8dd5d2`（0.3.14）。本次是子包源码 fork，没有创建整个 dsh-web 的 GitHub fork。

本地包名 `@deepseek-ai/dsh-liangshen` 沿用本仓库命名惯例，不表示官方维护，不发布到 npm。保留 Apache-2.0 LICENSE、preset NOTICE 和原始来源说明。原版文档描述上游用法，本文件描述本仓库差异。

继承 0.3.14 的 #1350 修复：通过 snapshotEvents 读取新 Harness 会话事件。现场旧版 0.3.13 对已删除的 session.events 读 length，导致首轮失败。

由本仓库安装和打包脚本构建维护，preset id 仍为 liangshen。安装替换前，通过 Harness 插件管理器移除 @linxin666/dsh-liangshen，避免两个同步器维护同一 preset。不得直接编辑 Profile node_modules 或生成后的 preset。
