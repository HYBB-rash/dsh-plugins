# 开发日志：修复生产 cron 控制面与账本解析放大

- 日期：2026-09-05
- 范围：便携 Web Profile、cron/assistant 控制 socket 接线、运行账本读取及部署验证

## 目标

解决两项相互独立的生产问题：让 Web 同时保留 cron 定时执行能力和 assistant 的 cron 管理能力；消除 scheduler 对大体积 `runs.jsonl` 的重复全量 JSON 解析。完成条件是：有效 Profile 中同时存在 scheduler 与 manager 两个 cron 实例，manager 实际提供控制 RPC socket，assistant 指向同一路径；同一账本版本只解析一次且文件变化后重新读取；发布后通过进程、HTTP、控制面、解析计数和既有任务运行验证。

## 时间线

1. 线上 Telegram 连续返回 `REQUEST_EXTENSION: DeepSeek request extension preparation failed` 后，先核对了当前任务账本、会话日志、进程和磁盘证据。确认报错消息最终仍进入会话处理；磁盘没有出现能解释故障的持续 I/O 饱和。
2. 用户确认 `cron-67230202` 已作废后，通过 dsh-cron 的正式控制服务按 externalRef 删除，随后确认 active 投影为空且没有新运行记录。
3. 检查生产 Profile 时发现，`dsh-cron` 只以 `scheduler` 模式启动，而 `dsh-assistant` 配置了 `cronControlSocketPath`。现场也不存在对应 `control.sock`。因此确认这是配置缺项：执行面仍在，控制面没有启动。
4. 先扩展 `self-describing-plugins.test.sh`，要求真实 Harness 插件导入与配置合成结果包含独立的 `dsh-cron-manager`。修改前测试按预期失败，报告 manager 数量为 0。
5. 在便携 patch 中插入第二个 `@deepseek-ai/dsh-cron` 实例，保持原实例为 scheduler，新实例设为 manager，并与 assistant 使用同一个 DSH_HOME socket。
6. 初版测试用临时目录的绝对路径匹配 dump 结果，但 `--dump-config` 保留了 `!!js dshHomePath(...)` 表达式，导致断言本身失败。改为分别读取 manager 和 assistant 的配置键，并比较同一预期表达式后，配置回归通过。
7. 运行现有 manager/RPC 聚焦测试，16 项全部通过，确认 manager 能创建、服务和清理控制 socket。
8. 第一版候选上传后，生产真实启动在切换 release 后失败。错误明确指出第二个 cron 实例重复注册 `cronAgentEnvironmentRegistry`；没有 Web 或代理进程存活，因此没有并行启动第二份。
9. 同期取得的 02:01 崩溃 core 与 perf JIT map 把原始 503 收敛到 scheduler `reload` → `RunLedger.foldJob` → `foldRunLines` → `JSON.parse`。这证明 control socket 是独立配置问题，不能解释原始 SIGSEGV。
10. 现场 `runs.jsonl` 为 12,692,500 字节、34,252 行且全部 JSON 有效，8 个 active job。旧 `reload` 至少为每个任务 fold 两遍，单轮至少 548,032 次 JSON.parse；低写入采样记录显示崩溃进程约 44 分 50 秒累计 227,140,196 次 JSON.parse，现场没有 OOM、磁盘写满或 I/O error。
11. 先增加两个失败测试：同一 Cordis Context 第二次提供 registry 会报重名；同一未变化账本为第二个 job 做 projection 会再次执行 JSON.parse。最初尝试让第二个角色先 `get` 再复用 registry，单 Context 测试转绿，但第二次生产启动证明 Cordis sibling 会禁止重复 `provide`、同时又不能彼此 `get`，这个测试模型不真实。
12. 收缩角色责任：环境 registry 只属于 scheduler 执行面，manager 控制面不再提供它。先把“manager 启动后 registry 仍不存在”写成失败测试，再移动入口接线，相关 55 项测试通过。`RunLedger` 同时按文件 revision 缓存一次解析结果、跨 job 复用，外部原子替换文件后失效重读。
13. dsh-cron 全量测试 627 项中 626 项通过，唯一失败为“旧 cron 恢复持久 session”测试。用未包含本次改动的最新 `main` 独立 worktree 复跑同一测试，得到相同失败，确认是基线既有问题，不由本次缓存改动引入；本次相关的测试全部通过，bundle 构建通过。
14. 第二次生产启动仍因 sibling registry 重名失败，证实“先 get 再复用”不能跨 Cordis sibling 成立。改用 scheduler-only registry 边界、重新构建和上传后，第三次启动成功；运行号 `20260904T182047Z`，监督 PID 3132860，Web PID 3133120。
15. 生产验证时两个 3080 listener 同时存在，control socket 为 herman 所有的 0600 Unix socket，RPC 返回 `ready=true`、`writer=manager`、协议版本 1。已删除的 `dsh:notion-task-inbox:retry:v1` 仍无 active job。
16. loopback、允许来源 LAN 和公网未认证 API 分别返回 401，错误 Origin 返回 403；token 首跳 303 并建立 Cookie，认证后页面返回 200。启动 stderr 为 0，诊断环境存在且未产生崩溃报告。
17. 新进程完成首次账本加载后，空闲 5 秒窗口为 23 次 JSON.parse/秒；随后 45 秒跨过一次任务运行，累计增加 69,486 次，约 1,544 次/秒，同时 runs 由 34,284 增长到 34,286 行。相比旧进程约 84,439 次/秒，含一次文件 revision 更新的观察窗口下降约 55 倍；纯空闲窗口下降约 3,670 倍。该结果与“每个新原子文件版本解析一次、相同版本跨 reload/job 复用”一致，scheduler 仍在真实追加记录。

## 逻辑链条

`dsh-cron` 的 `scheduler` 与 `manager` 是互斥角色：前者轮询并执行任务，后者注册管理工具并创建 RPC socket。把现有实例直接改成 manager 会修复助手管理但停止所有定时执行，因此不可接受。给插件新增“组合模式”会扩大 API 和测试面，也没有当前必要性。最小修正是在同一 Cordis Profile 中装载两个命名实例，各自承担一个既有角色。

环境 registry 服务只被 scheduler 的运行环境解析和恢复使用，manager 的工具与控制 RPC 不消费它。Cordis sibling 既不能读取彼此的私有服务，又会拒绝同名服务重复注册，所以“两个实例共享 registry”并不是可行边界；正确修正是只让 scheduler 提供，manager 不注册。

原始 SIGSEGV 与 control socket 没有同根因证据。core 的原生栈和 JIT 调用链都指向运行账本解析；因此另行修复解析放大。没有改变 JSONL 格式、事件折叠规则或写入协议，只把同一个原子文件版本的解析结果作为内部缓存。文件由 tmp + rename 原子更新，`dev/ino/size/mtimeNs` 任一变化都会丢弃缓存；若读取期间版本变化则失败关闭，不返回撕裂投影。

测试选择真实执行 Harness 的插件导入和 `--dump-config`，因为只检查源 YAML 无法证明 `insert` 经过配置合成后仍存在，也无法防止实例 ID 或 socket 接线被后续 patch 覆盖。

## 改动

- `config/web/portable.patch.yml`：增加 `dsh-cron-manager` 实例，并接到 assistant 使用的控制 socket。
- `dsh-cron/src/index.ts`：环境 registry 和 provider 只在 scheduler 角色中装载，manager 不再重复注册。
- `dsh-cron/src/store.ts`：按原子文件版本缓存 runs ledger 的一次解析结果和各 job projection。
- `dsh-cron/tests/run-environment.spec.ts`、`dsh-cron/tests/run-ledger.spec.ts`：覆盖双角色共享服务、跨 job 单次解析和文件更新失效。
- `scripts/tests/self-describing-plugins.test.sh`：锁定四个有效实例、两个 cron 角色和共享 socket。
- `docs/dsh-web-portable-deployment.md`：说明统一 Profile 中 cron 执行面与控制面的双实例责任。
- `MEMORY.md`：记录可复用的双角色接线与配置验证经验。

## 验证

- 修改前：`nix develop -c bash scripts/tests/self-describing-plugins.test.sh` 失败，明确报告缺少 `dsh-cron-manager`。
- 修改后：同一测试通过。
- `dsh-cron/tests/managed-command-bindings.spec.ts` 与 `dsh-cron/tests/control-a1-rpc.spec.ts` 共 16 项通过。
- 新增 manager 角色边界和 ledger 缓存测试修改前均失败，修改后连同 manager/RPC 测试共 55 项通过。
- dsh-cron bundle 构建通过。
- dsh-cron 全量：626/627 通过；唯一失败在未改动的 `main` 独立 worktree 中可同样复现，属于既有测试夹具与当前 session persistence 形状不一致。
- 便携部署矩阵通过：deploy、package、packages、有效 Profile、LAN proxy、Telegram 启动通知、shell 语法与 `git diff --check` 全部通过。
- 生产 release `c1e02fd24301e54bd9ee87b1e20852921b1506e609c5acf78a55a5701924ebd4` 启动成功；监督进程、Web、LAN proxy、两个 listener、RPC socket、HTTP 三层状态、token 登录、诊断环境和 scheduler 账本追加均已验证。

## 遗留

真实 Telegram 中由用户发起的 assistant cron 管理对话尚待用户使用时确认。当前约 4 分钟生产观察无退出、stderr 或崩溃报告；解析放大已显著下降，但仅靠短时观察不能证明底层 V8 永不再次崩溃，低写入诊断会继续保留后续证据。
