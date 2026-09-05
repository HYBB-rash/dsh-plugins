# 开发日志：cron 执行工具与列表输出

- 日期：2026-09-05
- 范围：herman.hermes 只读故障调查；本仓库 dsh-cron 与 portable Web 配置的本地修复候选。

## 目标

解释微信 cron 为什么投递排期说明而不是报告，修复本仓库导致执行会话缺工具和 cron_list 输出校验失败的缺陷。线上安装、停机、真实业务重跑和任务删除不属于本次已执行动作。

## 时间线

以下均为北京时间，按实际发生顺序记录。

1. 11:08—11:09：读取项目规则、部署说明和相关技能，进入 nix develop。发现原工作树已有整批官方 npm 迁移暂存改动，因此只读核对 herman.hermes。现场 current 当时为 aa1acc8bb3be7aa334156ba1ccc38a5ec226da21882987ffe85ebbf187d2e6d6。
2. 11:09—11:10：确认 cron-3aab4b9e 已有删除记录；cron-241d3a1a 于 11:09:00.664 被 claim，11:09:58.738 finish 为 success，11:09:59.671 记为 delivered。最初把这理解为任务执行成功，随后查看 outputPreview，发现投递内容仍是重新排期说明，立即纠正为“执行过程结束并投递，业务未完成”。
3. 11:10—11:11：读取线上安装的 cron bundle，确认 cron_list 对象禁止额外字段，但 execute 对带 cwd 的记录返回 cwd。线上有多条带 cwd 的任务。fetch origin/main，核对本地 main 为 5b4a903 且包含远端 main，从 main 创建独立分支 codex/cron-list-output-cwd 和独立 worktree。
4. 11:11—11:12：第一次解压压缩会话只得到 header，发现 Node 同步 zstd 解压只消费首帧；改用 info.engine.bytesWritten 逐帧推进，读取完整 17 帧。仅核对指定 DSH 会话的请求工具声明和工具调用，不将模型推理正文写入项目。request/header.tools 确认为 cron_create、cron_delete、cron_list，没有 shell 或读取文件工具。该会话创建 cron-a6788611，计划 11:14 再运行。
5. 11:12：为带 cwd 和不带 cwd 的 cron_list 结果增加真实 SDK 输出校验测试，先得到与线上一致的 `value must match exactly one oneOf branch (matched 0)`。补上可选 cwd 字段后，manager 15 项测试通过。
6. 11:13—11:15：定位 scheduler.acquireAgent 只安装模型；对照本仓库 Telegram 的已有预设挂载方式，为普通 cron 增加可选 agentPreset，portable 选择 standard。新建、恢复、per_run 三种路径的测试先因执行工具缺失失败，再补实现。一次初稿错误引用未保存的 config，改为构造时保存 agentPreset，三种测试转绿。显式环境继续由 provider 自己装配，增加相应成功结果验证。
7. 11:15—11:17：独立分支的 cron 全部 26 文件、648 测试通过。单独对旧 main 源码使用当前 npm SDK 做类型检查时，出现原有 SessionPersistence.list 的 4 条 API 类型错误；它们属于原工作树已经准备的 npm 迁移。导出原工作树 Git index 到 /tmp/dsh-cron-tools-candidate，再叠加本次修复，统一验证当前 npm 候选，不改动原工作树。
8. 11:17—11:19：临时副本首次整仓验证有两个准备问题：尚未构建 Telegram 声明文件；零上下文补丁因已有测试行数变化把新增 it 插到另一个 it 内。改为复制完整修复文件，并只应用已核实的 Session API 兼容变化，先构建再验证。三个插件构建、23 项脚本测试及插件 sibling 依赖边界通过。
9. 11:18：现场 current 已切换为 93e4c57750e68258136b656a9bf3311efb2bc1712a9687786748040893c8cbc3；该切换不是本任务执行。再次只读检查当前安装代码，两个缺陷仍在。11:17 的账本还显示 cron-98192775 计划于 11:20 执行；没有删除或重跑它。
10. 11:19：最终整仓验证 55 文件、1160 测试全部通过；复核分支仍基于最新本地 main 且包含 fetch 后的 origin/main，整理本地修复和调查记录。

## 逻辑链条

主故障是工具装配缺失：任务正文要求 bash，但实际模型请求仅有三个管理工具。运行中的 Agent 再创建同样的任务，新会话仍没有执行工具，因而投递排期说明。账本 success 只表示模型回合正常结束，不能证明微信脚本执行或报告合格。

cron_list 另有独立的本仓库输出合同缺陷：声明拒绝额外字段，却返回未声明的 cwd。保留 cwd 并声明其类型即可；无需修改 Harness，也不应放宽整个输出校验或删改业务账本。

执行工具沿用现有 agent-presets 接口，不引入上游修改或第二套脚本执行器。只对没有显式环境的普通 Agent 任务挂载配置的预设；不向受限 provider 环境追加通用工具。预设服务不可用时抛错，不带着缺失的配置静默运行。

## 改动

- dsh-cron/src/manager.ts：声明 cron_list 的可选 cwd。
- dsh-cron/src/index.ts、src/scheduler.ts：透传 agentPreset，并在普通新建、恢复和 per_run Agent setup 中挂载。
- dsh-cron/package.json：声明 dsh-agent-presets 依赖。基于 npm 迁移整合时应使用该批精确 SDK 版本并同步 lock；临时验证副本已如此处理。
- config/web/portable.patch.yml：scheduler 配置 standard 预设。
- dsh-cron/tests/manager.spec.ts、tests/scheduler.spec.ts：输出合同、三种执行路径、显式环境隔离回归。

## 验证

- 独立分支：cron 26 文件、648 测试通过；git diff --check 通过。
- 合并现有 npm 迁移的临时副本：类型检查、三个插件构建、23 项脚本测试、插件依赖边界通过。
- 整仓最终验证：55 个测试文件、1160 项全部通过；此结果来自已有 npm 迁移加本次修复的临时副本，不代表正式部署或真实业务验收。

## 遗留

候选未上传、安装或重启；没有发送 Telegram 消息、删除 cron 或手动执行微信脚本。真实 cron 会话能否执行脚本并产出符合模板的报告，仍需授权上线后的业务验收，不能由本地测试替代。

普通任务仍可看到 cron 管理工具；本次不改变其管理权限，也不把成功标记升级为业务语义校验。已生成的重复任务须按最新账本确认后处理，不能仅凭历史 ID 批量删除。任务分支保持候选状态，未发布、未合并到 main、未推送。
