# 开发日志：修复生产 cron 控制面接线

- 日期：2026-09-05
- 范围：便携 Web Profile、cron/assistant 控制 socket 接线及部署验证

## 目标

让生产 Web 同时保留 cron 定时执行能力和 assistant 的 cron 管理能力。完成条件是：有效 Profile 中同时存在 scheduler 与 manager 两个 cron 实例，manager 实际提供控制 RPC socket，assistant 指向同一路径，并在发布后通过进程、HTTP、控制面和既有任务运行验证。

## 时间线

1. 线上 Telegram 连续返回 `REQUEST_EXTENSION: DeepSeek request extension preparation failed` 后，先核对了当前任务账本、会话日志、进程和磁盘证据。确认报错消息最终仍进入会话处理；磁盘没有出现能解释故障的持续 I/O 饱和。
2. 用户确认 `cron-67230202` 已作废后，通过 dsh-cron 的正式控制服务按 externalRef 删除，随后确认 active 投影为空且没有新运行记录。
3. 检查生产 Profile 时发现，`dsh-cron` 只以 `scheduler` 模式启动，而 `dsh-assistant` 配置了 `cronControlSocketPath`。现场也不存在对应 `control.sock`。因此确认这是配置缺项：执行面仍在，控制面没有启动。
4. 先扩展 `self-describing-plugins.test.sh`，要求真实 Harness 插件导入与配置合成结果包含独立的 `dsh-cron-manager`。修改前测试按预期失败，报告 manager 数量为 0。
5. 在便携 patch 中插入第二个 `@deepseek-ai/dsh-cron` 实例，保持原实例为 scheduler，新实例设为 manager，并与 assistant 使用同一个 DSH_HOME socket。
6. 初版测试用临时目录的绝对路径匹配 dump 结果，但 `--dump-config` 保留了 `!!js dshHomePath(...)` 表达式，导致断言本身失败。改为分别读取 manager 和 assistant 的配置键，并比较同一预期表达式后，配置回归通过。
7. 运行现有 manager/RPC 聚焦测试，16 项全部通过，确认 manager 能创建、服务和清理控制 socket。

## 逻辑链条

`dsh-cron` 的 `scheduler` 与 `manager` 是互斥角色：前者轮询并执行任务，后者注册管理工具并创建 RPC socket。把现有实例直接改成 manager 会修复助手管理但停止所有定时执行，因此不可接受。给插件新增“组合模式”会扩大 API 和测试面，也没有当前必要性。最小修正是在同一 Cordis Profile 中装载两个命名实例，各自承担一个既有角色。

测试选择真实执行 Harness 的插件导入和 `--dump-config`，因为只检查源 YAML 无法证明 `insert` 经过配置合成后仍存在，也无法防止实例 ID 或 socket 接线被后续 patch 覆盖。

## 改动

- `config/web/portable.patch.yml`：增加 `dsh-cron-manager` 实例，并接到 assistant 使用的控制 socket。
- `scripts/tests/self-describing-plugins.test.sh`：锁定四个有效实例、两个 cron 角色和共享 socket。
- `docs/dsh-web-portable-deployment.md`：说明统一 Profile 中 cron 执行面与控制面的双实例责任。
- `MEMORY.md`：记录可复用的双角色接线与配置验证经验。

## 验证

- 修改前：`nix develop -c bash scripts/tests/self-describing-plugins.test.sh` 失败，明确报告缺少 `dsh-cron-manager`。
- 修改后：同一测试通过。
- `dsh-cron/tests/managed-command-bindings.spec.ts` 与 `dsh-cron/tests/control-a1-rpc.spec.ts` 共 16 项通过。
- 完整便携部署测试矩阵与生产发布验证待后续时间线补录。

## 遗留

尚未完成完整部署测试、生产发布和真实 Telegram 用户入口验收。
