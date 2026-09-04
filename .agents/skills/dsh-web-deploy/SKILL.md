---
name: dsh-web-deploy
description: 在 dsh-plugins 仓库中打包、上传、启动、重启或排查 herman.hermes 的普通 tar.gz DSH Web 部署。涉及 scripts/package-dsh-web、dsh-web-deploy、dsh-web-start、Node native ABI、Corepack/pnpm、LAN 白名单、trusted-host、listProviders 401/403、dsh.man-her.icu 或 Telegram 启动 URL 时使用。该流程是唯一现役发布入口，不用于本地 Web 开发。
---

# DSH Web 普通归档部署

先完整阅读 [`../../../docs/dsh-web-portable-deployment.md`](../../../docs/dsh-web-portable-deployment.md)，再操作。该文档解释每个现场兼容层和安全边界；不得只根据本 Skill 猜测当前运行状态。

本 Skill 只覆盖普通 `tar.gz` 到 `herman.hermes` 的 Web 部署，也是仓库唯一现役发布流程。本地源码安装、刷新和启动使用相邻的 `$dsh-web-dev`；任务同时触及本地开发行为时，还要读取 `../dsh-web-dev/SKILL.md`。旧 Docker/OCI、快照、accept 和 rollback 系统已经退役，不得恢复或混用。

## 固定边界

- `scripts/dsh-web-deploy` 只打包和上传，禁止隐式 SSH 启动。
- Token 只在 `dsh-web-start` 成功启动 Harness 后生成；单纯 deploy 不会发送 URL。
- Harness 只监听 `127.0.0.1:3080`，不得改成 `0.0.0.0` 或关闭认证。
- LAN 代理监听 `192.168.6.240:3080`，默认源 IP 只允许 `127.0.0.1`、`192.168.6.1`、`192.168.6.189`。
- Harness trusted hosts 包含 `192.168.6.240` 和 `dsh.man-her.icu`。源 IP 白名单与 HTTP Host 信任不是同一机制。
- HTTPS、DNS 和证书由外部网络反代负责；不要在 hermes 安装或配置 Caddy/nginx。
- `$DSH_HOME`、Workspace 和业务数据在归档外；生产凭据只由打包器从 Git 忽略目录加入秘密归档。
- 不读取、停止、配置或依赖 OpenClaw；不得恢复已删除的 `release/`。
- 不在命令输出、日志摘录、提交信息或回复中打印 token、Cookie、bot token、API key 或 Notion token。

## 开始前

1. 阅读当前作用域 `AGENTS.md`，检索 `MEMORY.md` 中 `普通归档`、`Node ABI`、`trusted-host`、`pnpm` 等关键词。
2. 检查 Git 分支和工作树，保留用户无关改动。
3. 若要改代码，确认任务分支基于最新 `origin/main`，并从仓库根目录使用 `nix develop`。
4. 用现场事实确认远端状态；历史 PID、日志名、archive SHA 和监听状态都可能过期。
5. deploy 本身不停机；任何停止或重启真实 DSH writer 的动作都需要用户明确授权。

## 只上传新包

从仓库根目录运行：

```bash
nix develop -c ./scripts/dsh-web-deploy
```

记录输出的归档 SHA-256 和远端目录。成功只表示以下文件已上传，不表示新服务已启动：

```text
dsh-web.tar.gz
dsh-web.tar.gz.sha256
dsh-web-start
dsh-web-lan-proxy.mjs
dsh-web-notify-start-url.mjs
```

不要在 deploy 后擅自执行远端 start。新 token 和 Telegram URL 只有 start 后才存在。

## 重启前核对

在获得停机/重启授权后：

1. 找到当前 portable Web 的监督 PID，并验证它的命令确实是部署目录中的 `dsh-web-start`。
2. 枚举该监督 PID 的完整后代，确认其中的 Web/代理进程拥有预期的两个 `3080` listener。
3. 核对远端归档摘要：

   ```bash
   ssh herman.hermes 'cd /home/herman/.local/share/dsh-web-package && sha256sum -c dsh-web.tar.gz.sha256'
   ```

4. 比较本地与远端 `dsh-web-start`、LAN proxy、notify 脚本的 SHA-256；只比较摘要，不输出秘密文件。
5. 若身份、PID 或进程树有歧义，停止并报告；禁止用 `pkill node`、`pkill dsh` 或端口范围杀进程。

## 安全停止当前实例

当前监督模型是 Bash `wait -n`，代理有活动连接时优雅关闭可能被拖住：

1. 对**精确识别的当前监督进程树**发送 `SIGTERM`；
2. 有界等待最多 30 秒；
3. 仍存活时，只对同一棵已识别进程树发送 `SIGKILL`；
4. 确认监督 PID 和全部后代消失；
5. 确认以下两个 listener 都不存在：
   - `127.0.0.1:3080`
   - `192.168.6.240:3080`

两个端口未释放时禁止启动第二份。不得触碰任何遗留 Docker 状态或 OpenClaw。

## 启动远端实例

在远端部署目录使用 `umask 077` 创建日志，以 `nohup` 启动一份监督进程，并记录本次 UTC run id、PID、stdout 和 stderr 路径。核心入口是：

```bash
/home/herman/.local/share/dsh-web-package/dsh-web-start
```

不要复制、在线编辑或补装 release 内代码。启动器会自行：

- 校验 archive SHA；
- 解压/复用 `releases/<sha256>`；
- 验证 bundled Node `v24.19.0`；
- 准备固定 pnpm shim；
- 安装三个插件和凭据；
- 原子切换 `current`；
- 启动 Web 与 LAN proxy；
- 捕获启动 token，通过 Telegram 发送一次 `https://dsh.man-her.icu/?token=...`。

日志中 Harness 原始启动行包含 token。读取日志时只做匹配或脱敏，不能 `cat` 后粘贴到回复。

## 必做健康检查

启动后有界等待，并同时证明：

1. 监督 PID持续存活；
2. `127.0.0.1:3080` 和 `192.168.6.240:3080` 都在监听；
3. stderr 无 `ERR_DLOPEN_FAILED`、undefined symbol、fatal 或通知失败；
4. 从日志把 token URL读入变量，不输出；用临时 cookie jar 跟随 `303`，loopback 最终为 `200`；
5. LAN authority 和域名 authority 的无会话 `/api/llm/listProviders` 为 `401`，不是 `403`；
6. Host/Origin 不一致仍为 `403`；
7. 从非白名单源访问代理仍为 `403 Forbidden`；
8. `https://dsh.man-her.icu/api/llm/listProviders` 无会话为 `401`，证明外部反代已到 Harness；
9. 用户确认 Telegram 收到一条新的 HTTPS 登录 URL。

不要把裸 `/` 的非 2xx 自动解释为进程失败。Harness 首次登录是 token → `303` → Cookie → `200`。

## 401/403 快速判断

| 现象 | 含义 | 排查方向 |
|---|---|---|
| 整页是 `403 Forbidden\n` | LAN 代理拒绝源 IP | 检查 socket `remoteAddress`；不要相信客户端 X-Forwarded-For |
| 页面能开但 `/api` 为 403 | Harness Host/Origin 栅栏 | 检查代理是否保留 Host，以及 `--trusted-host` 是否含当前 authority |
| `/api` 为 401 | 网络和 Host 已通过，缺会话 | 用当前 Telegram token URL登录，不要关闭认证 |
| 监听后退出且有 `ERR_DLOPEN_FAILED` | native addon ABI 不匹配 | 确认全链使用包内 Node 24.19.0 |
| Corepack 动态 import 错误 | 旧 Corepack 直接执行新 pnpm | 保持 `corepack pack` + bundled Node 运行 `pnpm.cjs` |
| `workspace:*` 找不到包 | 遗留的可再生 Web Profile | 停服并证明边界后，只清理 `$DSH_HOME/profiles/web`；保留所有业务状态 |
| 大量 `ERR_MODULE_NOT_FOUND` | Harness loader 缺运行参数 | 保持 `node --expose-internals` |

## 修改部署代码

实现任何功能或修复前先写失败测试。按改动范围至少运行：

```bash
nix develop -c bash scripts/tests/dsh-web-deploy.test.sh
nix develop -c bash scripts/tests/package-dsh-web.test.sh
nix develop -c bash scripts/tests/dsh-web-packages.test.sh
nix develop -c bash scripts/tests/self-describing-plugins.test.sh
nix develop -c node --test \
  scripts/tests/dsh-web-lan-proxy.test.mjs \
  scripts/tests/dsh-web-notify-start-url.test.mjs
bash -n \
  scripts/package-dsh-web \
  scripts/dsh-web-deploy \
  scripts/dsh-web-start \
  scripts/dsh-web-install-plugins \
  scripts/dsh-web-runtime \
  scripts/tests/dsh-web-deploy.test.sh
git diff --check
```

保持以下负向合同：

- deploy 不远程启动；
- 目标机不编译、不运行插件安装脚本；
- 缺 bundled Node、凭据、摘要或辅助脚本时 fail-closed；
- 代理 HTTP 与 WebSocket 都保留浏览器 Host；
- notify 只从 stdin 接收启动 URL，绝不把 token 放 argv；
- notify 失败不停止 Web，也不重试造成重复消息；
- 本地 `dsh-web-runtime` 不发送生产 Telegram 通知。

## 完成报告

报告实际 archive SHA、run id/PID、两个 listener、HTTP 状态矩阵、ABI/通知错误是否存在，以及用户是否完成真实 Telegram/Web 业务验收。明确区分：

- 自动测试；
- 远端服务健康；
- 用户真实业务验收；
- 未完成的 systemd、完全离线、rollback、push/merge 等事项。

不要复述 token。未获得授权时停在上传或报告边界。
