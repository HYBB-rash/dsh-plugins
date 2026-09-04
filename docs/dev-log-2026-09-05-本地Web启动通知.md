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
7. 回归通知器、源码安装/运行拆分、普通归档打包和上传/启动合同。新 worktree 的 `self-describing-plugins` 因未安装完整上游 workspace `node_modules` 无法运行；该失败发生在缺少 `tsx`、`resolve.exports` 的模块加载阶段，与本次脚本改动无关，未用临时安装掩盖。

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
- GREEN：`bash -n` 与 `git diff --check` 通过。
- 本机服务激活与真实 Telegram、HTTP 验收结果将在完成 Home Manager 切换后补记。

## 遗留

- 源码分支验证时未在新 worktree 重装上游依赖，因此 `self-describing-plugins.test.sh` 未形成有效回归结果；本次相关脚本测试及生产打包/部署合同已通过。
- Home Manager 配置保持本机未提交状态，不 push。
