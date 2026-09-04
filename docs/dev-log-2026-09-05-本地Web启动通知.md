# 开发日志：本地 Web 启动通知

- 日期：2026-09-05
- 范围：源码 Web runtime、Telegram 启动 URL 通知器、本机 `dsh-web-local.service`

## 目标

让本机常驻 DSH Web 每次启动成功后，通过 `~/.dsh` 配置的本地 Telegram bot 发送当前 `127.0.0.1:3080` 认证地址；开发服默认不通知，且不引入生产 LAN、域名或 portable 启动流程。通知失败不得导致 Web 退出。

## 时间线

1. 现场确认 `dsh-web-local.service` 正常运行，入口为源码 `scripts/dsh-web-runtime`；该入口只输出启动 URL，不调用通知器。
2. 阅读 `scripts/dsh-web-start` 与 `scripts/dsh-web-notify-start-url.mjs`，确认生产启动器已有 stdout 中继和 Telegram 通知，但通知器默认把 loopback URL 改写为 `https://dsh.man-her.icu`，不能原样用于本地。
3. 通过复杂度预算确认不需要新增脚本、服务或插件：复用 runtime、通知器和既有 HM 服务，新增长期概念数为 0。
4. 在独立分支先补 RED：显式 loopback HTTP origin 被通知器拒绝；runtime 即使设置通知开关也不会调用通知器。生产 HTTPS 默认和非 loopback HTTP 拒绝用例保持通过。
5. 通知器最初只放宽显式 `http://127.0.0.1` origin；runtime 增加 opt-in stdout 中继。首轮 runtime 测试暴露 process substitution 在假 Web 立即退出时可能先返回、后中继，存在丢末尾输出的窗口。
6. 将中继改为同步管道，并显式取 `PIPESTATUS[0]` 作为 Web 退出码；修正测试夹具对绝对脚本路径的匹配后，runtime 集成测试转绿。
7. 回归通知器、源码安装/运行拆分、普通归档打包和上传/启动合同。新任务 worktree 的 `self-describing-plugins` 最初因未安装完整上游 workspace `node_modules` 无法运行；该失败发生在缺少 `tsx`、`resolve.exports` 的模块加载阶段，与本次脚本改动无关，未用临时安装掩盖。
8. 合并前发现原 `/home/herman/Projects/dsh-plugins` 已被另一个 cron 开发分支占用。为避免服务随开发 checkout 漂移，将本机 `main` ref 安全快进，并建立专用长期 checkout `/home/herman/Projects/dsh-plugins-web-local`。
9. 在长期 checkout 先用 `/tmp/dsh-web-local-stable-build` 完成真实隔离安装、三插件各一次的 `--dump-config` 和 Harness `fs-ext` 加载；随后备份真实 Profile，停服并刷新 `~/.dsh/profiles/web`。新 Profile 的三个 `file:` 引用均指向长期 checkout。
10. Home Manager 增加本地通知开关和 loopback origin，并把 `ExecStart` 改到长期 checkout。切换后服务自动启动，Telegram API 接受通知，loopback HTTP 认证与监听范围验收通过。

## 逻辑链条

- 本地服务不能改用 `dsh-web-start`：该入口同时承担生产归档切换、LAN proxy、trusted host 和域名通知，会破坏本机仅 loopback 的边界。
- 不新增本地专用通知脚本：现有通知器已经封装凭据读取、Telegram API、秘密不落日志和 stdin 传 token 的合同；只需允许显式 loopback origin。
- 不改变通知器默认 origin：默认仍为生产 HTTPS 域名，避免生产漏设环境变量时行为漂移。
- runtime 只在 `DSH_WEB_NOTIFY_START_URL=1` 时中继；未设置时继续 `exec` Node，因此 `.dsh-web:5080` 开发入口保持原行为。
- token 继续走 stdin，不进入 argv、环境变量或文件。通知错误只输出固定失败句，runtime 最终状态始终取 Web 进程退出码。

## 改动

- `scripts/dsh-web-notify-start-url.mjs`
  - 允许显式 `http://127.0.0.1[:port]` public origin；其他 HTTP origin 仍拒绝。
- `scripts/dsh-web-runtime`
  - 增加 `DSH_WEB_NOTIFY_START_URL=1` opt-in；识别首条 loopback token URL并调用现有通知器。
  - 默认路径保持直接 `exec`；通知失败不终止 Web。
- `scripts/tests/dsh-web-notify-start-url.test.mjs`
  - 覆盖 loopback HTTP 成功、非 loopback HTTP 拒绝及生产 HTTPS 默认不变。
- `scripts/tests/dsh-web-packages.test.sh`
  - 覆盖默认不通知、只通知一次、通知失败不改变 Web 退出状态。
- `/home/herman/.config/home-manager/home/applications.nix`
  - 本地服务最终启用通知开关并显式设置 loopback origin；该仓库改动按用户既有约束不提交。

## 验证

- RED：loopback origin 通知测试失败；runtime opt-in 集成测试失败。
- GREEN：`node --test scripts/tests/dsh-web-notify-start-url.test.mjs`，5/5 通过。
- GREEN：`scripts/tests/dsh-web-packages.test.sh` 通过。
- GREEN：`scripts/tests/package-dsh-web.test.sh` 通过。
- GREEN：`scripts/tests/dsh-web-deploy.test.sh` 通过，生产启动 URL 合同保持。
- GREEN：`self-describing-plugins.test.sh` 在依赖完整的长期 checkout 通过。
- GREEN：`bash -n` 与 `git diff --check` 通过。
- 真实 Profile：`--dump-config` 中 `telegram-gateway`、`dsh-cron`、`dsh-assistant` 各一次，三个源码引用均指向 `/home/herman/Projects/dsh-plugins-web-local`。
- Profile 备份：`~/.dsh/recovery/local-web-profile-before-notify-20260904T181040Z`。
- systemd：`active/running`，`NRestarts=0`，`ExecStart` 指向长期 checkout，仅监听 `127.0.0.1:3080`。
- journal：存在本次启动 URL，无通知失败、native、插件树、Telegram 冲突或 wave13 标记；通知请求获 Telegram API 成功响应。
- HTTP：无认证 `401`，使用本次启动 URL建立 cookie 后 `200`。

## 遗留

- Home Manager 配置保持本机未提交状态，不 push。
- Telegram API 已接受发送；最终客户端展示仍以用户 Telegram 客户端为准。
