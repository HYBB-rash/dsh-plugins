---
name: dsh-web-deploy
description: 在 dsh-plugins 中准备和上传官方 npm 运行时的普通 tar.gz Web 包，或在明确授权后安装、启动及验收 herman.hermes。保留 LAN 白名单、trusted-host、认证和 Telegram 启动通知；不用于本地源码开发。
---

# 官方 npm 普通归档部署

开始前完整读取 [部署说明](../../../docs/dsh-web-portable-deployment.md) 和根 AGENTS.md。该文档是当前参数、包内容、权限与失败处理的唯一详细说明；历史 PID、版本和日志不代表当前状态。

## 有限动作

1. 准备：`nix develop -c ./scripts/package-dsh-web <绝对输出路径>`。
2. 上传：`nix develop -c ./scripts/dsh-web-deploy`。只上传到独立 incoming 批次，不取得停机／安装／启动权限。
3. 安装：目标上传目录中的 `dsh-web-install`；首次旧 Profile 迁移加 --migrate，前提是已明确授权且旧服务已停止。
4. 启动／重启：该批次的 `dsh-web-start`。只使用 current 与已安装版本，不安装、不升级。
5. 查看和验收：按部署说明核对指定 DSH 服务、监听及 HTTP 矩阵；日志必须脱敏。
6. unsupported：请求越出动作边界、授权不明、旧进程身份不清、安装失败或依赖不满足时，报告具体缺口，保持现场。不要临时生成线上修复、清理或恢复流程。

第一次安装或修改活跃 Profile 前，需要用户明确停机许可，并由当前服务管理器或已确认的精确监督进程树停止旧实例、确认端口释放。当前 Skill 不自行扩大进程目标；禁止宽泛杀进程或并行启动第二份。未响应就不执行该动作。

## 固定约束

- 每批只在准备时选一次 latest，目标使用该批精确版本。SDK 不各自追 latest；无法兼容即失败。
- 归档不含 Harness 源码、Node、node_modules 或业务状态。目标 npm 安装自己的平台依赖；不升级系统环境。
- 凭据只由打包器从 Git 忽略目录加入；不得打印 token、Cookie、bot/API/Notion 密钥。
- 新版运行和安装互斥；旧版没有该锁，--migrate 不能替代人工停机确认。
- 不清空 home 或业务数据；失败保持停止并报告，人工恢复，不声称自动 rollback。
- 保留 loopback、LAN 白名单、Host/Origin 检查及一次性 Telegram URL 通知，不关闭认证。
- OpenClaw、旧 Docker/OCI release、另一套发布平台均在范围外。

## 验证与报告

改代码使用失败测试保护；本地运行 npm test、npm run test:scripts 及相关插件边界检查。用隔离副本检查旧数据兼容，不用正式数据试错。

真实启动后核对监督树、loopback/LAN/域名、401/403/登录跳转、Telegram 通知和会话／cron／assistant／模型／Notion 业务。逐项报告已证实和未验收；上传成功、测试通过、PID 存活都不等于生产验收。

保留当前任务范围和原有授权门槛；不要因为需要更强证据而擅自重启、发送真实业务消息、合并或推送。
