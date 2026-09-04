# 开发日志：调查 Models Tab 设置不可用

- 日期：2026-09-04
- 范围：DeepSeek Harness Models 设置页面、DSH Web 普通归档部署与调查文档

## 目标

调查生产 Web“设置 → 模型”页面显示 `settings are unavailable in this browser` 的原因，判断是否应在 `dsh-plugins` 修复，并留下可复盘的中文记录。

最终完成标准调整为：不修改只读上游 `upstream/deepseek-harness`，不绕过其非本地设置边界；明确加、改模型的正确操作方式；把原因、被否决方案、误操作和遗留风险写入 `docs/`。

## 时间线

1. 用户报告 Models Tab 挂掉，截图显示 `加载提供方目录失败: settings are unavailable in this browser`，最初要求调查、修复、测试、提交和上线。
2. 开始时先读取本地 Web 与普通归档部署规则，检查 Git 和生产相关文档。最初把该现象与历史 `listProviders` 401/403 故障放在一起检索，随后根据精确错误字符串转向上游 Models 客户端代码。
3. 在 `ui-settings-models/src/client/store.ts` 找到错误来源：Models 页面同时读取提供方目录、settings mirror 和凭据状态；settings mirror 没有 view 时显示该英文错误。
4. 在 `ui-settings/src/client/index.ts` 找到直接原因：非 loopback 页面选择 `memory` persistence，不读取 Host settings。生产域名和 LAN 页面因此无法完成 Models 页面需要的设置合并。
5. 此时错误地把 `upstream/deepseek-harness` 当作可修改代码，直接改变其 persistence 判断，增加测试，并生成 Harness 构建产物。相关测试通过后，又错误地将该本地产物打包上传并重启了生产服务。
6. 推送 upstream 分支时 GitHub 返回 403。用户随即明确指出 DeepSeek Harness 是上游，不能修改。该反馈推翻了此前实现路径。
7. 立即停止继续实现和推送：将 upstream 源码与指针重置回官方 `origin/master`，将根仓库 main 恢复到 `origin/main`，确认两个错误提交均未进入 Git 远端。
8. 后续检查发现，Git 重置不会清除被忽略的 `lib/client.js` 等构建产物；其中仍残留错误代码。于是从已恢复的官方源码执行一次完整官方构建，确认 bundle 恢复为 `isLoopback ? "host" : "memory"`，避免下次直接打包再次夹带本地修改。
9. 按第一性原理重新研究方案。确认上游 README 与 theme、permission、welcome 等测试都把非 loopback settings 视为 process-local 或 unavailable；这不是偶发的 API 故障，而是当前上游明确边界。
10. 比较了 SSH 本地端口转发、等待上游升级、配置 patch、伪造 loopback、自有 settings compatibility provider 和重写 Models 页面。用户最终确认不修复远程配置能力，加、改模型改用本地或 SSH 转发的 `127.0.0.1` 页面。
11. 创建 `docs/model-tab-settings-unavailable.md`，记录根因、官方使用方式、被否决方案、误操作恢复和调查结束时的线上风险，并提交、合入本地 main。
12. 随后发现本地分支 `docs/chinese-development-logs` 已引入新的中文开发日志规范。将未推送的调查报告提交变基到该规范之后，再创建独立任务分支补写本日志。

## 逻辑链条

- 错误文字来自 settings mirror 缺失，而不是提供方目录接口自身失败，因此 `listProviders` 的 401/403 排障矩阵不能直接解释该现象。
- 上游源码和 README 共同表明：只有浏览器以 loopback authority 打开时，settings 才使用 Host persistence。域名和 LAN 页面能正常聊天、使用已配置模型，并不意味着它们可以修改 Host settings。
- `portable.patch.yml` 只能启停或配置 Loader entry，不能改变上游客户端内部判断；用配置文件“修”这一行为没有正式接口。
- 全局伪造 `isLoopback` 或 `ownsHost` 会同时改变其他本机专属功能，影响范围超过 Models 页面，不能采用。
- 自有 compatibility provider 技术上可行，但需要长期兼容 settings mirror、revision、schema 以及多个现有消费者；重写 Models 页面还会复制模型编辑器和 onboarding。用户接受通过 loopback 管理模型后，这些长期复杂度都失去必要性。
- SSH 本地端口转发不改变上游代码，也不放宽生产域名权限；浏览器仍以 `127.0.0.1` 访问，因此符合上游现有判断，是远程管理服务器时的最小方式。
- Git 远端未被污染不代表生产没有受影响：普通归档部署直接打包工作区构建产物，不依赖 Git push。反过来，Git reset 也不保证 ignored 构建产物已经恢复，必须核对实际打包输入。

## 改动

- `docs/model-tab-settings-unavailable.md`：新增调查报告，记录上游边界、正确操作方式、方案取舍、误操作恢复和线上遗留状态。
- `docs/dev-log-2026-09-04-模型tab设置不可用.md`：新增本开发日志，按真实顺序记录调查和决策过程。
- `MEMORY.md`：追加本次可复用经验，区分 non-loopback settings 限制、API 401/403 与 ignored 构建产物污染。

没有修改 `upstream/deepseek-harness` 的 tracked 源码或 submodule 指针，没有新增兼容插件，也没有改变最终程序行为。

## 验证

- 确认 upstream Git 状态为 `master...origin/master`，tracked 工作树干净。
- 从官方源码完成 Harness 全量构建，并在生成的 `ui-settings/lib/client.js` 中确认仍为 `isLoopback ? "host" : "memory"`。
- 确认根仓库错误提交和 upstream 错误提交都未推送到远端。
- 精确核对上游 `ModelsSettingsStore.load()`、`ui-settings` persistence 选择、Connection loopback 判定以及 settings controller 的远程 API 边界。
- 使用第一性原理概念预算比较候选方案，机械校验结果为 1 个概念；在用户决定使用 loopback 管理后，该新增概念不再必要，因此最终不实施。
- 检查调查报告与本日志均为中文、位于 `docs/`，并包含时间线、判断依据、被否决方案、验证和遗留风险。
- 运行 `git diff --check`，确认文档无空白错误。

## 遗留

- 调查结束时，生产仍可能运行曾由错误本地构建生成的归档 `ee12dc84b2003e8d8279fc802d2dee6d2c367f69544e08fb0d9d2695823c2b46`；当时记录的监督 PID 为 `3109779`，但这些现场值会变化，后续必须重新核对。
- 上一份官方 release 摘要为 `4a37a2181a451d5b9da530477aa138b80179f227ac8c9e3b08e6cfd5cd831473`。本任务没有新的停机或回滚授权，因此没有操作生产进程。
- 本地 main 尚未推送到 `origin/main`。
