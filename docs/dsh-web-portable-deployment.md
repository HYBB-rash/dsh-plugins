# DSH Web：官方 npm 运行时与普通归档部署

## 当前结构

仓库只维护 telegram-gateway、dsh-cron、dsh-assistant 和薄脚本；不含上游源码、fork 或补丁。第三方 Web 功能由 `config/web/plugins.json` 的固定独立包清单提供，不安装聚合 all 或 perf，不自动追踪新增成员。

运行时为官方 `@deepseek-ai/dsh`。每次准备安装／部署只解析一次 latest；SDK 取所选运行时实际发布的依赖版本，构建和测试三个自有插件，再生成 tgz。不要把各个 SDK 单独设为 latest，官方各包标签未必同步。准备失败不升级现有实例。

归档包含：

```text
dsh-web/
  runtime/package.json + package-lock.json
  plugins/*.tgz
  config/web.patch.yml
  config/remote.patch.yml
  bin/dsh, install, web, start
  scripts/lib/web-package.mjs
  scripts/dsh-web-notify-start-url.mjs
  production-credentials/.credentials.yaml
  production-credentials/secrets/notion.token
```

不包含 Harness、Node、node_modules、预制 Profile、Workspace 或业务状态。目标机通过 npm 安装目标平台的依赖，避免跨 Node ABI 搬运 native addon。Node 必须支持 node:sqlite；npm、flock、setsid 等由目标环境提供，脚本不会升级系统软件。安装前检查 SQLite 和普通子进程；npm 安装后还实际运行 node-pty 子进程，成功才开始改动 Profile。

归档是秘密载体，模式 0600；只打入明确的两个凭据文件，凭据文件同为 0600，不打印其内容。

## 本地开发

```bash
nix develop
npm ci --ignore-scripts
npm run build
npm test
npm run test:scripts

# 选择一次最新版、独立构建、通过官方插件管理器安装；不启动。
DSH_WEB_HOME=/absolute/isolated-home ./scripts/dsh-web-install-plugins
# 普通启动不安装、不更新；默认开发端口 5080。
DSH_WEB_HOME=/absolute/isolated-home ./scripts/dsh-web-runtime --no-open
```

三个自有包通过官方 `plugin --profile web add --ignore-scripts` 安装。Profile 的 bundle 和 node_modules 只归官方插件管理器写入。运行时安装在 `$DSH_HOME/runtime`，tgz 保存于 `$DSH_HOME/plugin-packages`，不引用会被清理的临时构建目录。

`bin/dsh` 检查所选安装的 CLI 与精确版本，然后通过 offline npx 和 `node --expose-internals` 启动。npx 在 runtime 目录选择已安装命令，内部应用进程切回 `DSH_CWD`（未指定时保留调用目录）；不能只设置 DSH_CWD 环境变量，当前官方包并不读取它。不能换回裸 npx web：当前发布版会因此无法解析外置插件。命令缺依赖就失败，不回退全局或另一份缓存安装。

## 准备与上传

```bash
nix develop -c ./scripts/package-dsh-web /absolute/output.tar.gz
nix develop -c ./scripts/dsh-web-deploy
```

打包默认从 Git 忽略的 `config/web/production-credentials` 取远端凭据。正式本机使用不同 bot 时，`DSH_WEB_PRODUCTION_CREDENTIALS` 必须指向 Git 忽略目录中的本机凭据副本，并在停机前核对目标；不得把默认远端凭据覆盖到本机。测试时该参数只能指向合成凭据。

deploy 只上传到 `incoming/<archive-sha>`，不覆盖运行中的 start 脚本，不安装、不停机、不启动。记录输出的目录和 SHA。本地 `dsh-web-local-deploy` 在 `incoming/batch.*` 新目录准备普通归档，不覆盖旧入口，不再停止 systemd、重置 checkout 或自动重启。

## 授权后安装，再单独启动

开始前先核实当前 DSH 监督进程及其后代、DSH_HOME、Workspace 和端口。明确停机授权后，由当前服务管理器或精确识别的监督进程树停止旧实例；确认端口释放。禁止宽泛 pkill、并行第二份或触碰 OpenClaw。

在上传目录：

```bash
DSH_HOME=/absolute/existing-home ./dsh-web-install --migrate
DSH_HOME=/absolute/existing-home ./dsh-web-start
```

首次迁移旧 Profile 必须显式传 `--migrate`，含义是操作者已经停止旧实例，不是脚本自动取得停机权限。安装器先备份 Profile、runtime、插件 tgz 和凭据到 home/recovery，再按普通 npm lock 安装；先通过官方 `add --save-exact` 登记本批 Web 版本，再 remove 聚合包、perf 和旧自有包，最后重新 add 自有 tgz，保留其他插件。完成后才更新 current。

安装会写 runtime、Profile 和凭据；这些写入不是完整事务。业务 storage 不由安装器删除或转换。切换前另对会话、cron、assistant 状态做停机一致性备份，并先在副本验证兼容性。安装失败保持停止并报告，人工按备份恢复；没有自动 rollback。

新版 runtime 和 installer 共用 home 内运行锁，避免运行时被重装。旧版没有这个锁，所以不能省略首次人工确认停机。不要在测试时使用真实 home。

Web 插件管理器的主动升级与普通重启是不同操作。若现有 package/lock 已升级，而 pnpm 的发布时间策略记录仍旧，精确 add 也可能被策略拒绝。先在状态副本复现；只有获得停机许可、完整备份并验证恢复路径后，才可人工用官方 `plugin --profile web clean --lockfile` 重建可安装的 Profile 依赖与 lock，再安装已选定批次。它不是安装器自动步骤；不要关闭策略、手改 bundle 或删除业务数据。

普通 restart 只运行 current 与已安装 runtime；不读取新归档、不解压、不执行 npm install、不选择 latest。现有 Bash 只监督一棵 Web 进程树，使用独立进程组接受终止信号；不再启动自有 LAN 代理。

start 先把 current 解析为真实 release 路径，固定本次启动输入。现役本机由 `dsh-web-local.service` 调用 `/home/herman/.local/share/dsh-web-package-local/current/bin/web --host 127.0.0.1 --port 3080 --no-open`；服务定义在 Home Manager 的 `home/applications.nix`。本机不加载 remote.patch.yml，继续只监听 loopback。原迁移切换与备份记录见 [双端上线日志](dev-log-2026-09-05-local-hermes-npm-deploy.md)。

## 入口、安全与通知

- 本机正式端口 3080；开发默认 5080。临时端口必须显式指定。
- 远端 start 通过普通 webserver 配置直接绑定 `0.0.0.0:3080`，同时接受 loopback 和 LAN 连接；自有 LAN 代理与其源 IP 白名单已退役。LAN 设备现在都能连接端口，但仍须通过认证和设备配对。不会自动修改系统防火墙。
- 远端监听地址、端口用 `DSH_WEB_HOST` / `DSH_WEB_PORT` 设置，不向 start 传 `--host` / `--port`。本机 bin/web 与开发 runtime 仍支持原 CLI 参数。
- 远端不再添加全局 trusted-host；远程设备通过插件的 `/remote` 通道读取数据，直接 `/api` 保留 Harness 的 Host/Origin 与浏览器认证边界。
- 当前 Harness 会把实际绑定机器的 LAN IP 视作可用 authority，所以 LAN 直接 API 未认证为 401，而域名直接 API 为 403。插件的 posture 探测把前者标成 OPEN；这不等于匿名请求已能读数据，也不意味着配对撤销能撤销另行兑换的 Harness 浏览器凭据。两种凭据不要混为一谈。
- 远程访问插件还可能要求浏览器设备配对。HTTP token 登录成功不等于设备已获授权；若页面提示未配对，须按插件的主电脑配对入口完成授权，不能通过关闭认证来凑验收。
- 2026-09-05 实测：Harness `0.1.2-rc.1` 拒绝 CLI `--host 0.0.0.0`，但 `dsh-remote-web-ui` 0.3.16 明确通过 webserver 配置支持主动 LAN 开放。`remote.patch.yml` 使用同一配置形式，不修改上游、调用插件私有函数或自动写 Profile；压缩配置也保留。不要据 CLI 拒绝推断普通配置不可用。
- start 将插件的 `DSH_REMOTE_PUBLIC_BASE_URL` 默认设为通知器的 `DSH_WEB_PUBLIC_ORIGIN`，本环境为 `https://dsh.man-her.icu`。两者原本是独立配置；插件已有的 publicBaseUrl 设置优先于环境默认值。配对控制台属于远端实例；本机另一份 3080 不能为它签发设备令牌。详见 [直连实验与切换日志](dev-log-2026-09-05-direct-listener-check.md)。
- TLS、DNS 与域名反代继续由既有外部设施负责；不安装另一套反代。
- 启动器从 stdout 取得首条 loopback token URL（兼容同一行附带 LAN 链接），经 stdin 通知 Telegram 一次；不重试，通知失败不终止 Web。日志仍可能含启动 token，读取必须脱敏。
- 本地源码 runtime 默认不通知；现有本机服务可保留显式 DSH_WEB_NOTIFY_START_URL=1 与本地 public origin。
- 统一 Web Profile 保留 gateway、cron scheduler、cron manager、assistant。cron manager 和 assistant 使用同一个控制 socket。
- OpenClaw 完全不参与依赖、凭据、进程识别或验收。

## 验收

自动测试：

```bash
nix develop -c npm test
nix develop -c npm run test:scripts
nix develop -c bash scripts/tests/plugin-boundaries.test.sh
git diff --check
```

真实隔离验收使用合成 home、空 Workspace 和显式测试端口，禁用 Telegram polling、cron scheduler 和其他外部副作用。验证官方 plugin add 自动登记、自有包可加载、独立 Web 插件真实可见／可交互，并验证断开 registry 后重启不变版。

获得切换授权后才验证真实业务：只有一棵 Web 树且 0.0.0.0:3080 由 Web 持有；loopback 未登录为 401，域名直接 API 为 403，未配对 remote API 为 403；token 经 303/Cookie 登录，设备配对后真实 remote RPC 成功；保留 Host/Origin 检查。再核对 Telegram 新链接、既有会话续接、cron、assistant、模型和 Notion。不要请求不存在的 /api 根路径后把 404 当作权限证明；自定义 Host 的检查用能保留该头的 HTTP 客户端。PID、HTTP 或单元测试通过不等于真实业务验收。

### 本次迁移已批准的单项例外

2026-09-05 用户允许历史 Web 会话 `session-e9b22c88-9f93-45cd-8763-f1b578ff6602` 暂不纳入新版续接验收，完整保留其原始日志；该日志含本次选用的 npm Harness 0.1.2-rc.1 不识别的 `context-route/change` 事件。此例外只针对这一条会话，不允许删事件、转换格式、移动或删除原文件，也不自动跳过其他不兼容会话。切换前的一致性备份仍必须包含它；这项批准不授权停机、安装或切换。原路径、校验值和批准记录见 [本次开发日志](dev-log-2026-09-05-official-npm-runtime.md)。

## 历史边界

旧包曾携带 Node 24 来匹配构建端 native ABI，并通过 Corepack 私有 shim 启动 pnpm；这两项随“目标机安装官方 npm 依赖”退役，不应恢复。旧 Docker/OCI release 系统仍保持退役。
