# DSH Web 普通归档部署：完整逻辑链与现场经验

本文记录 `dsh-plugins` 当前普通 `tar.gz` Web 部署的结构、边界、现场故障和验证方式。它解释“为什么脚本里会有这些看似突然出现的细节”，供后续维护和排障使用。

操作任务使用项目 Skill：`$dsh-web-deploy`。本地源码开发使用 `$dsh-web-dev`。本文不是 Docker `release/dsh` 的说明，也不授权读取或操作 OpenClaw。

## 1. 总览

整条链有四个入口，不是一个混合所有副作用的“一键发布”脚本：

```text
本机源码
  │
  ├─ scripts/package-dsh-web       生成秘密 tar.gz
  │
  ├─ scripts/dsh-web-deploy       只上传，不启动
  │            │
  │            └──── SSH/SCP ────→ herman.hermes
  │                                  │
  │                                  └─ dsh-web-start
  │                                       ├─ 校验、解压
  │                                       ├─ 准备固定 Node/pnpm
  │                                       ├─ 安装插件与凭据
  │                                       ├─ 原子切换 current
  │                                       ├─ 启动 Harness Web
  │                                       ├─ 启动 LAN 代理
  │                                       └─ Telegram 发送登录 URL
  │
  └─ 包内 bin/install-plugins 与 bin/web
```

运行时有两个常驻进程：

```text
192.168.6.240:3080
        │
        ▼
dsh-web-lan-proxy.mjs     源 IP 白名单
        │
        ▼
127.0.0.1:3080
deepseek-harness Web
```

HTTPS 不在 `herman.hermes` 上终止：

```text
https://dsh.man-her.icu
        │
        ▼
现有网络 HTTPS 反向代理
        │  herman.hermes 看到来源 192.168.6.1
        ▼
192.168.6.240:3080
```

Token 只有在 Harness 真正启动并输出启动 URL 后才存在。因此上传完成时不能产生新 URL；Telegram 通知属于 `dsh-web-start`，不属于 `dsh-web-deploy`。

## 2. 打包阶段：`scripts/package-dsh-web`

### 2.1 归档内容

最终归档大致是：

```text
dsh-web/
├── harness/                    完整构建后的 Harness
├── runtime-node/               官方 Node v24.19.0 Linux x64
├── plugins/
│   ├── deepseek-ai-dsh-telegram-gateway-*.tgz
│   ├── deepseek-ai-dsh-cron-*.tgz
│   └── deepseek-ai-dsh-assistant-*.tgz
├── config/
│   └── web.patch.yml           来自 config/web/portable.patch.yml
├── production-credentials/
│   ├── .credentials.yaml
│   └── secrets/notion.token
└── bin/
    ├── install-plugins         来自 scripts/dsh-web-install-plugins
    └── web                     来自 scripts/dsh-web-runtime
```

打包器要求 Harness 和三个插件已经构建；它会拒绝缺少 `lib/index.js`、Web dist、CLI 或 patch 的输入，但不会在打包阶段偷偷重建源码。

### 2.2 不携带预制 Profile

归档不包含开发机的 `profiles/web`。目标机通过 Harness 原生插件管理器重新生成：

```text
$DSH_HOME/profiles/web
```

三个插件各自携带 `package.json`、`cordis.patch.yml` 和 `dsh.bundle` 声明。Harness 执行 `plugin --profile web add` 后自动登记 bundle，不由部署脚本手写 `dsh.profile.bundles` 或 `node_modules`。

现场曾发现旧 Web Profile 中有 `workspace:*` 依赖。该协议只在源码 monorepo 中成立，目标机安装时报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。当时只删除了可再生的 `/home/herman/.dsh/profiles/web`，没有删除 storage、Session、Workspace、cron、凭据或其他 Profile。这是一次性旧状态迁移；当前启动器不会每次删除 Profile。

### 2.3 插件 `.tgz` 与目标机边界

本机用 `pnpm pack` 生成三个第三方插件包。目标机只执行：

```text
plugin --profile web add --ignore-scripts <三个 tgz>
```

含义是：

- 允许安装已经构建的包；
- 禁止目标机编译插件；
- 禁止运行插件安装脚本；
- 由 Harness 统一维护 Profile 和 bundle 登记。

### 2.4 生产凭据与权限

生产凭据只存在于 Git 忽略目录：

```text
config/web/production-credentials/.credentials.yaml
config/web/production-credentials/secrets/notion.token
```

打包器 fail-closed：两者必须存在、是普通文件、不能是符号链接。它们以 `0600` 放入归档，最终归档本身也是 `0600`。脚本使用 `umask 077`，避免中间文件向组或其他用户开放。

源码开发的 `scripts/dsh-web-install-plugins` 不会把生产凭据复制进 `.dsh-web`；生产唯一特殊数据只在打包阶段附加。归档因此是秘密载体，不能公开上传或在回复中暴露内容。

### 2.5 现场故障：Node semver 通过，native ABI 失败

**现场现象：** 服务曾成功监听 `3080`，随后退出；日志出现 `fs-ext.node` 的 `ERR_DLOPEN_FAILED` 和缺失 V8 symbol。

**根因：** 构建端使用 Node 24，远端系统 Node 是 22。两者都满足 Harness 声明的 `^22.19.0 || >=24.0.0`，但构建端生成的 native addon 与远端 V8 ABI 不兼容。

```text
Node semver 兼容 ≠ native addon ABI 兼容
```

本机 Node 又是依赖大量 `/nix/store` 的 Nix 动态链接产物，不能直接复制到普通目标机。

**所以脚本中出现了：** 固定官方 `node-v24.19.0-linux-x64.tar.xz`，校验固定 SHA-256 后缓存并打入 `runtime-node/`。远端安装、pnpm shim、Harness、代理和通知脚本都使用这份 Node。缺失、符号链接、不可执行或版本不等于 `v24.19.0` 时立即停止。

这也意味着当前包面向 Linux x64，不是跨 CPU 架构归档。

### 2.6 其他打包防线

- `tar --no-same-owner`：解压时不继承构建机 UID/GID。
- 临时目录 + 最后 `mv`：归档构造失败时不留下半成品输出。
- 排除 `.git`、`.env`、`.env.*`：不把仓库元数据和环境文件带入包。
- 文件与归档 SHA 测试：防止“测试的是源码，传的是另一份字节”。

## 3. 上传阶段：`scripts/dsh-web-deploy`

上传器执行：

1. 调用 `package-dsh-web`；
2. 再生成归档校验和；
3. 在远端创建 `0700` 部署目录；
4. 上传归档、摘要、启动器、LAN 代理和通知脚本；
5. 打印远端启动命令。

上传内容是：

```text
dsh-web.tar.gz
dsh-web.tar.gz.sha256
dsh-web-start
dsh-web-lan-proxy.mjs
dsh-web-notify-start-url.mjs
```

它故意不执行远端启动。测试使用假 SSH/SCP 锁定这个边界。

原因是“上传成功”和“生产进程已切换”是两件事。若上传器隐式启动，就会把传输、停旧进程、修改 Profile、安装凭据和启动新服务混在一次不可区分的副作用里。

新 token 也只能由新 Harness 进程生成。上传时可能仍是旧进程、新进程尚未启动或新进程随后失败，因此 deploy 阶段不能可靠返回新 URL。

## 4. 远端启动：`scripts/dsh-web-start`

启动顺序是：

```text
检查输入与宿主工具
→ 校验 tar.gz SHA-256
→ 解压到 releases/<archive-sha256>/
→ 验证捆绑 Node
→ 准备固定 pnpm
→ 安装插件与凭据
→ 原子切换 current
→ 启动 Web 与 LAN 代理
→ 捕获启动 URL 并通知 Telegram
→ 监督两个常驻进程
```

### 4.1 内容寻址 release

归档解到：

```text
$DSH_WEB_PACKAGE_ROOT/releases/<sha256>/
```

相同归档复用同一目录。安装成功后先创建 `current.next`，再用原子 rename 切换 `current`，避免出现半截符号链接。

旧 release 目录会保留，但当前流程没有正式自动 rollback 命令。Profile 与凭据是包外状态，它们的更新也不属于完整事务。

### 4.2 现场故障：远端旧 Corepack 不能直接运行新 pnpm

**现场现象：** `herman.hermes` 有 Node 22.23.2 和 Corepack 0.24.0，没有独立 pnpm。旧 Corepack 直接运行 Harness 所需 pnpm 11.x 时出现 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`。

**根因：** 目标机 Corepack 的执行方式与新 pnpm 不兼容。

**所以脚本中出现了：** 从包内 `harness/package.json` 读取严格的 `packageManager: pnpm@x.y.z`，用 `corepack pack` 只下载对应包到部署私有目录，再由随包 Node 直接运行 `pnpm.cjs`。启动器生成私有 `runtime-bin/pnpm` shim 并将其放到 `PATH` 前面，因为 Harness 插件管理器内部会按名字调用 `pnpm`。

它不会全局安装或升级 pnpm，不影响机器上的其他项目。

当前流程不是完全离线：首次缓存 Node 发生在打包机；目标机首次准备 pnpm、安装普通依赖时仍可能访问 registry。

### 4.3 包内安装入口的两种模式

`scripts/dsh-web-install-plugins` 在源码树和归档中共用，但行为由目录结构区分：

- 源码模式：构建 Harness 和三个插件，以 `file:` 路径刷新开发 Profile，不安装生产凭据；
- 归档模式：只安装三个 `.tgz`，使用 `--ignore-scripts`，再把凭据以 `0600` 安装到外部 `$DSH_HOME`。

这样本地开发和生产遵循同一种插件安装模型，但生产目标机不编译。

### 4.4 现场故障：Harness loader 需要 `--expose-internals`

**现场现象：** `--dump-config` 成功，但完整启动产生大量 `ERR_MODULE_NOT_FOUND`。

**根因：** 配置可组合不等于插件可加载。构建后 Harness loader 需要 Node 的内部模块解析能力来解析 Profile 与 Harness 包。

**所以 `scripts/dsh-web-runtime` 中出现了：** `node --expose-internals`。它不是普通调试选项，而是当前构建后运行入口的要求。

### 4.5 现场故障：Harness 拒绝 `0.0.0.0`

**现场现象：** 尝试让 Harness 直接监听 LAN 时，CLI 明确拒绝 `--host 0.0.0.0`，指出这会把远程代码执行能力暴露到网络。

**所以架构变成：** Harness 永远保持 `127.0.0.1:3080`，LAN 访问由独立白名单代理提供。没有绕过 Harness 的安全门。

### 4.6 监督模型与已知关停限制

启动器同时后台运行 Web 和 LAN proxy，并用 `wait -n` 等待。任何一方先退出，启动器都会停止另一方，避免：

- Web 已死但代理继续占端口、只返回 502；
- 代理已死但 Web 仍在后台运行、LAN 永远不可达。

当前没有 systemd，实际运行使用 `nohup` 加 Bash 监督进程。

现场也发现：代理有活动连接时，Node `server.close()` 可能等待连接自然关闭；监督进程在 20 秒内不一定退出。安全重启必须对**精确识别的当前监督进程树**先发 TERM、有界等待、必要时只对同一棵树 KILL，然后确认 `127.0.0.1:3080` 与 `192.168.6.240:3080` 都已释放，才允许启动下一份。禁止用宽泛 `pkill`，禁止并行起第二份。

## 5. LAN 白名单代理

`scripts/dsh-web-lan-proxy.mjs` 监听：

```text
192.168.6.240:3080
```

并转发到：

```text
127.0.0.1:3080
```

默认允许 TCP 源地址：

```text
127.0.0.1
192.168.6.1
192.168.6.189
```

网络 HTTPS 反代到达 hermes 时，hermes 看到的是 `192.168.6.1`；域名解析所在的机器地址不是这里要加入的源 IP。

代理同时实现普通 HTTP 和 WebSocket upgrade。它把 `::ffff:x.x.x.x` 归一化为 IPv4，避免 Node 的 IPv4-mapped IPv6 表示导致白名单误判。

它不信任客户端自带的 `Forwarded` 或 `X-Forwarded-For`；这两个头会被清理，`X-Forwarded-For` 只写入实际 socket 源地址。白名单判断始终使用 `remoteAddress`。

## 6. 三层安全状态：两个 403 与一个 401

| 现象 | 拒绝者 | 含义 |
|---|---|---|
| 整个页面直接 `403 Forbidden\n` | LAN 代理 | TCP 源 IP 不在白名单 |
| 页面能开，但 `/api/...` 返回 403 | Harness Host/Origin 栅栏 | Host 未信任，或 Origin 与 Host 不一致 |
| `/api/...` 返回 401 | Harness 会话门 | 网络与 Host 都通过，但没有合法 Cookie/token |

源 IP、HTTP Host 和登录状态是三个不同维度：

```text
TCP 源地址白名单
→ Host/Origin 浏览器信任
→ token/Cookie 会话认证
```

### 6.1 现场故障：页面能打开，`listProviders` 仍是 403

**现场现象：** HTML 页面能打开，但 `/api/llm/listProviders` 返回 403。

**第一层根因：** 初版代理把 `Host` 改成 `127.0.0.1:3080`，浏览器 `Origin` 仍是 LAN IP 或 HTTPS 域名。Harness 判定 Host 与 Origin 不同源。

**第二层根因：** 只保留浏览器 LAN Host 仍不够。Harness 绑定 loopback 时，非 loopback Host 必须显式存在于 `trustedHosts`。

**所以最终必须同时：**

1. HTTP 与 WebSocket 代理都保留浏览器原始 Host；
2. Harness 启动参数包含：
   ```text
   --trusted-host 192.168.6.240 dsh.man-her.icu
   ```

`192.168.6.1` 是源 IP，不是 Host；`dsh.man-her.icu` 是 Host，不是源 IP，不能把两者混为一张“白名单”。

## 7. token 登录与健康检查

Harness 启动后输出 loopback 登录 URL。首次访问时：

```text
token URL
→ 303
→ Set-Cookie（HttpOnly、SameSite）
→ 跳转到 /
→ 后续请求使用 Cookie
→ 200
```

因此裸 `curl -f /` 可能因 401 被误判为服务失败。正确验证要区分：

- 监听是否存在；
- 无会话 API 是否是预期 401；
- 带 token、cookie jar、跟随 303 后是否为 200；
- Host/Origin 不匹配是否仍为 403；
- 非白名单源是否仍为 403。

任何自动化输出都不能打印实际 token 或 Cookie。

## 8. Telegram 启动 URL 通知

Token 是 Harness Web 启动时输出的，Cordis 中的 `telegram-gateway` 插件拿不到该值。因此没有把部署域名和启动 token 责任塞进通用 gateway，而是在 `dsh-web-start` 捕获 Harness stdout。

启动器通过 process substitution 原样转发 stdout，同时只匹配第一条合法的 loopback token URL，并通过 stdin 交给：

```text
scripts/dsh-web-notify-start-url.mjs
```

URL 不通过 argv 传递，避免出现在 `ps` 或 `/proc/<pid>/cmdline`。Harness 原始启动行仍会进入受保护的启动日志，因此部署日志目录也应视为秘密数据。

通知脚本：

1. 只接受 stdin，拒绝 URL 参数；
2. 验证输入是 loopback HTTP token URL；
3. 改写为 `https://dsh.man-her.icu/?token=...`；
4. 从 `$DSH_HOME/.credentials.yaml` 读取 bot token 和允许 chat ID；
5. 直接调用 Telegram Bot API `sendMessage` 一次；
6. 使用 10 秒超时，不重试；
7. stdout/stderr 不输出登录 token 或 bot token。

不重试是为了避免“远端已经收消息，但客户端超时”时产生重复通知。通知失败只写通用错误，不阻止 Web 与代理继续运行。

每次 `dsh-web-start` 真正生成新 token 后发送一次；单纯执行 deploy 不发送。通知成功只证明 Harness 到达生成启动 URL 的阶段，不替代后续进程、代理和业务健康验证。

## 9. `portable.patch.yml` 的责任

`config/web/portable.patch.yml` 只覆盖三个插件的运行参数：

- telegram gateway 的 Session、preset 和工作目录；
- cron 的 scheduler、轮询、并发和错误投递；
- assistant 的 Telegram 模式、轮询和 cron socket。

生产凭据、LAN 地址、源 IP 白名单、公网域名、代理和启动通知都留在部署层，不塞进业务 patch。这样源码开发和生产包使用同一 Harness、插件构建产物、patch 和 runtime，生产唯一特殊数据是打包时附加的凭据。

## 10. 验证矩阵

### 10.1 自动测试

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

这些测试分别锁定：

- 包结构、权限、凭据、固定 Node 和源码字节一致性；
- deploy 只上传、不远程启动；
- start 使用 bundled Node、固定 pnpm、外部 `DSH_HOME` 和两个 trusted host；
- 三个 bundle 自动登记且各出现一次；
- 代理允许/拒绝、HTTP/WebSocket Host/Origin 保留；
- Telegram 只发送一次 HTTPS URL，失败和日志均不泄密。

### 10.2 远端验收

启动后至少核验：

1. 监督进程持续存活；
2. `127.0.0.1:3080` 和 `192.168.6.240:3080` 都监听；
3. loopback token 登录经 303/Cookie 后为 200；
4. LAN 与域名 authority 的无会话 API 为 401，而不是 403；
5. 跨 Origin 仍为 403；
6. 非白名单源仍为 403；
7. 日志无 `ERR_DLOPEN_FAILED`、undefined symbol 或通知失败；
8. Telegram 实际收到一条 HTTPS 登录 URL；
9. 需要时再由用户验收模型、Telegram、cron 和 Notion 真实业务。

检查日志时必须脱敏 token，不能直接把启动行贴进回复。

## 11. 现场演进记录

| 提交 | 现场原因或能力 |
|---|---|
| `0ceb177` | Harness 构建后 loader 必须使用 `--expose-internals` |
| `091dac5` | 生产凭据只在打包阶段进入秘密归档 |
| `2540436` | 拆分上传与远端启动 |
| `c69f97a` | 旧 Corepack 无法直接运行新 pnpm，改用私有 pnpm 包和 bundled Node |
| `ef124c8` | Harness 拒绝 `0.0.0.0`，固定 loopback |
| `0b7d920` | Node 24 native addon 无法在远端 Node 22 加载，归档携带固定 Node |
| `d8bb614` | 增加独立 LAN 源 IP 白名单代理 |
| `e596a83` | 修复代理 Host 改写和 trustedHosts 缺失造成的 API 403 |
| `f730522` | 启动成功后 Telegram 发送 HTTPS token URL |

## 12. 已知限制

- 当前使用 `nohup` + Bash 监督，不是 systemd；
- 优雅关停可能被活动代理连接拖住，需要有界 TERM/KILL；
- 不是完全离线安装；
- 官方 Node 固定为 Linux x64；
- 没有正式自动 rollback 入口；
- release 目录是内容寻址，但 Profile 和凭据更新不是完整事务；
- Telegram 通知失败不会停止服务，也不会自动重试；
- HTTPS、证书和域名反向代理由外部网络设施负责，不在 hermes 部署脚本中。

这条部署链的核心原则是：不绕过 Harness 的 loopback 与浏览器信任边界，在外层补齐可传输运行时、可再生插件安装、受控 LAN 入口、明确的认证语义和可用的启动 URL 通知。
