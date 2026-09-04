# 开发日志：禁止修改上游源码

- 日期：2026-09-04
- 范围：仓库根规范 `AGENTS.md`

## 目标

为整个 `dsh-plugins` 仓库新增长期约束：确认问题位于 `upstream/` 上游代码模块后，不得修改上游源码，也不得提出依赖修改上游源码的方案；必须从本仓库侧处理，否则停止并报告。

## 时间线

1. 检查工作树、现有规范与 `upstream/` 结构，确认 `upstream/deepseek-harness` 是 submodule。
2. 起初误把用户提供的目录上下文理解为规范落点，计划新增 `upstream/AGENTS.md`；用户澄清规范应放在 `dsh-plugins` 仓库级规则中。
3. 放弃目录级规范方案，从最新 `origin/main` 创建独立任务分支。
4. 在根 `AGENTS.md` 的“改动纪律”中加入仓库级硬约束，未修改 `upstream/` 或 submodule。

## 逻辑链条

根 `AGENTS.md` 对整座仓库生效，符合用户要求的仓库级约束。目录级 `upstream/AGENTS.md` 只对该目录生效且不符合用户澄清，因此被否决。规则同时约束实际修改和方案来源，避免以修复问题为由把上游源码修改作为实现前提；本仓库无法规避时应停止并报告，而不是自行越权。

## 改动

- `AGENTS.md`：新增禁止擅自修改上游源码、禁止采用依赖上游源码修改方案的规则。
- `docs/dev-log-2026-09-04-forbid-upstream-source-edits.md`：记录本次规范调整过程。

## 验证

- 检查 Git 差异，确认规则仅加入根规范。
- 检查 submodule 状态，确认 `upstream/deepseek-harness` 未发生修改或指针变化。

## 遗留

无。
