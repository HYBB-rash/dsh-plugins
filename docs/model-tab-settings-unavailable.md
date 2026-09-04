# Models Tab 非本地访问不可配置调查记录

日期：2026-09-04

## 结论

不在 `dsh-plugins` 中修复该行为。

DeepSeek Harness 当前明确只允许 loopback 页面持久读取和修改 Host settings。因此：

- 通过生产域名或 LAN 页面仍可聊天、查看会话，并使用已经配置好的模型；
- 通过生产域名或 LAN 页面的 Models Tab 不能新增或修改模型提供方配置；
- 新增或修改模型配置应从浏览器访问 `127.0.0.1`；服务器不在本机时，可使用 SSH 本地端口转发，让浏览器仍以 `127.0.0.1` 打开远端 Web。

本仓库不绕过这项上游边界，不替换上游 settings 服务，也不伪造 loopback 身份。

## 现象

在生产域名或 LAN 页面打开“设置 → 模型”，页面不显示提供方卡片，而是显示：

```text
加载提供方目录失败: settings are unavailable in this browser
```

## 代码路径

上游 Models 页面位于：

```text
upstream/deepseek-harness/packages/client/ui-settings-models
```

`src/client/store.ts` 的 `ModelsSettingsStore.load()` 同时读取：

1. `llm/listProviders`
2. `llm/listConfigurableProviders`
3. 共享 settings mirror

当 settings mirror 没有 view 时，它使用以下兜底错误：

```text
settings are unavailable in this browser
```

settings mirror 由以下上游文件创建：

```text
upstream/deepseek-harness/packages/client/ui-settings/src/client/index.ts
```

当前上游选择方式是：

```ts
const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
```

生产域名和 LAN authority 不是 loopback，因此使用 `memory` 模式；该模式不会读取 Host settings，Models 页面也就无法完成提供方目录与设置、凭据状态的合并。

上游 `packages/client/ui-settings/README.md` 已把 “Non-loopback pages get no durable settings” 列为当前限制。theme、permission、welcome 等相关测试也把远程浏览器 settings 视为 process-local 或 unavailable。

## 不是以下故障

该报错不是由以下问题直接造成：

- `/api/llm/listProviders` 的 `401` 或 `403`；
- LAN proxy 的 Host/Origin 转发；
- Node native ABI；
- pnpm 或插件安装失败；
- 模型适配器缺失。

页面可以成功访问且其他业务可用，并不表示 Models settings 在非 loopback 页面应当可写；这是两个独立边界。

## 可用的官方方式

需要增加或修改模型时，使用本地浏览器 authority：

```text
http://127.0.0.1:<本地转发端口>
```

远端服务器可通过 SSH 本地端口转发访问。例如把本机某个空闲端口转发到远端 Harness 的 `127.0.0.1:3080`，再从浏览器打开本机 `127.0.0.1`。登录 token 和 Cookie 仍按现有认证流程处理，不应写入命令记录、报告或日志摘录。

SSH 转发是管理入口，不改变生产域名的行为，也不要求修改或重新构建 Harness。

## 方案比较与决定

### 不采用：修改 upstream

`upstream/deepseek-harness` 是只读上游 submodule。本仓库不得直接修改其源码或提交本地 fork 指针。

### 不采用：修改 `portable.patch.yml`

该配置只能启停 Loader entry 或修改插件配置，不能改变 `ui-settings` 内部的 persistence 判断。

### 不采用：伪造 `isLoopback` 或 `ownsHost`

这会影响所有使用“本机特权表面”判断的上游功能，而不只是 Models Tab，影响范围过大。

### 不采用：自有 settings compatibility provider

技术上可通过禁用上游 `ui-settings`、再由本仓库插件提供兼容的 `settingsScope`/`settingsSchema` 服务，使生产域名使用 Host settings；但这需要长期兼容上游 settings mirror、revision、schema 和多消费者合同，且主动覆盖上游明确的 non-loopback 边界。当前需求可通过 loopback 管理入口完成，因此不引入这项长期责任。

### 不采用：重写 Models 页面

这会复制 Models UI、provider editor、模型目录、凭据状态和 onboarding 等大量上游职责，复杂度远高于当前结果所需。

## 误操作与恢复记录

调查期间曾错误地直接修改上游 `ui-settings`，生成本地 Harness 构建产物，并将该产物打包启动到生产。随后已完成以下本地恢复：

- upstream Git 源码和指针恢复到官方 `origin/master`；
- 根仓库 `main` 恢复到 `origin/main`；
- 错误提交未推送到根仓库或 upstream 远端；
- 被 Git 忽略的 Harness 构建产物已从官方源码完整重建，避免后续打包再次夹带修改。

调查结束时，生产仍可能运行误打包归档：

```text
archive sha256: ee12dc84b2003e8d8279fc802d2dee6d2c367f69544e08fb0d9d2695823c2b46
supervisor pid: 3109779
```

此前官方 release 目录对应摘要：

```text
4a37a2181a451d5b9da530477aa138b80179f227ac8c9e3b08e6cfd5cd831473
```

这些运行状态只记录调查结束时的现场，后续必须重新核对。由于没有新的停机/回滚授权，本次没有停止、重启或回滚生产服务。

## 最终决定

- 不修复生产域名/LAN 下的 Models settings。
- 加模型、改模型使用 loopback 页面，必要时通过 SSH 本地端口转发。
- 不修改上游 Harness，不增加替代 settings 服务，不新增 Models 页面。
- 本报告仅留档，不授权任何生产操作。
