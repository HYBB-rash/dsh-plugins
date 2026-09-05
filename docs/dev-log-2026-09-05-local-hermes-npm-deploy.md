# 开发日志：本机与 Hermes 切换官方 npm 运行时

- 日期：2026-09-05
- 范围：本机 3080、herman.hermes 普通归档部署、薄启动器与本机 Nix 服务单元。
- 状态：两端已切换并运行最终官方 npm 包，Workspace、入口和认证检查通过。本机 Profile 策略不一致已通过停机备份后的官方依赖重建解决；保留用户 HM 改动。远端浏览器仍需设备配对，本机测试会话曾选择未配置的 OpenAI provider，真实业务验收未通过；未合并或推送。

## 目标

按用户“本地和 herman.hermes 都上线”的明确授权，停机备份后分别安装、启动官方 npm 运行时，保留两个 bot 各自的凭据、Workspace 与业务数据。仍不改上游，不接触 OpenClaw。

## 时间线

1. 约 11:02 现场核对：本机 systemd 服务主 PID 2094117、Web PID 2094121；远端旧监督 PID 3151381、Web 3151611、代理 3151612。两端 home 都为 `/home/herman/.dsh`，但 bot 凭据指纹不同。远端生产凭据与仓库忽略目录匹配；本机包由打包器使用另一个 Git 忽略目录中的本机凭据副本。
2. 本机服务来自 Home Manager，现役入口指向旧源码 checkout。Nix 整体 diff 暴露无关 Claude/Codex/OpenCode/Thunderbird 降级，因此没有整体激活。只修改现有 DSH 单元的 ExecStart，Nix 构建该单元并保留 GC root；稍后只替换同一个服务的生成链接。未修改旧源码 checkout。
3. 两个准备批次均新选 Harness `0.1.2-rc.1`、17 个 scoped Web 包 `0.3.15`、sidebar `0.18.0`，各自完整通过 55 文件、1156 项测试。此前验收的 scoped Web 包为 0.3.14，不能直接沿用其结果。新 0.3.15 已在无凭据隔离 Profile 安装并启动；远端 Node 22.23.2 也通过安装、SQLite、普通子进程与真实 node-pty 探针。
4. 远端业务状态只读复制到本机：144 会话均可 inspect/prepare，43 cron 定义有效，assistant 有 4 开放项、0 待发、14 Web observations、0 bindings，1 预设无 broken。副本为 `.cache/data-copy-qJJ5HD`。未修改原始日志。
5. 隔离验证初次把额外 --patch 放在 Web 参数之后，被官方参数解析拒绝；把启动层参数提前后成功。浏览器自动化访问 401 页面报告 ERR_BLOCKED_BY_CLIENT，未关闭认证或加登录旁路；本次新版页面的交互结果不能以 HTTP 冒充。
6. 约 11:14 停止本机原 systemd 服务，确认 3080 释放。完整 `.dsh` 备份及旧服务链接保存在 `/home/herman/.local/share/dsh-web-backups/local-20260905-1115`。安装器另保存旧 Profile/runtime。11:15:27 用 Nix 生成的新单元启动，主 PID 2222932，Web PID 2222962。
7. 本机初验：未登录 root/API 401，错误 Host 403；内部读取启动链接测试得到 303、Cookie 和认证后 200，未打印 token/Cookie。cron socket ready；Profile 有 21 插件依赖和 23 bundles，无 all/perf。凭据哈希未变，获批例外旧会话 SHA-256 仍为 `f24e6a77a91ebec915b7ceb2351b4fd4090f2dbafddd44ffbf91697a115f5ca8`。
8. 约 11:16 精确停止远端旧监督树，确认旧 PID 与两个监听均消失。完整 `.dsh`、旧 outer launcher、归档、checksum 和 current 链接保存在 `/home/herman/.local/share/dsh-web-backups/hermes-20260905-1116`；旧 releases 原样保留。新 npm 包安装成功，未升级系统 Node/npm。
9. 远端初次启动退出 0，LAN 与 Web 均未保留监听，域名返回 503。前台诊断定位为 LAN 代理入口判断：Node 的 import.meta.url 为真实路径，argv 为 current 软链接路径，两者不等，代理没有进入监听。没有把安装或短暂 PID 当成上线。
10. 增加真实代理经过 current 启动的回归测试，先失败。薄 start 在调用子程序前把 release 解析为物理路径，测试转绿；24 项脚本测试全部通过。没有改上游或代理业务规则，远端保持停止，本机不受影响。通过正常 deploy 入口重新准备、测试和上传修复包，不在线拼接另一套发布流程。
11. 约 11:25 远端安装代理修复包 `2d6196f22ffada4951f1db9f0996668ba4c34fe0d6407153abee58aa624f371d` 后启动，监督 PID 3191528、Web 3191596、LAN 代理 3191562。loopback/LAN/域名 401；loopback 与域名 token 登录 303、认证后 200、错误 Origin 403。初次域名探针错误保留了原 URL 的 3080 端口，修正一次性探针后通过；不是服务故障。
12. 只读确认本机 bot 为 DSHLocalHost_bot、远端为 herman_notice_bot；两端 Telegram getMe 和 Notion users/me 均返回 200。两个启动日志均没有通知失败，但这不能代替用户确认收到链接。assistant 两端 SQLite quick_check 均为 ok；远端既有 3 个 blocked monitor 与历史 failed outbox 未被清除或伪装为成功。
13. 进一步核实实际工作目录，发现 npx 内部 Node 仍在 runtime，官方包不读取 DSH_CWD。把测试从检查环境变量改为检查 process.cwd()，两个测试先失败；bin/dsh 在 npx 选定安装后让内部命令切回 Workspace，测试转绿。不可达 registry 下真实隔离 Web 仍返回 401，`/proc/<pid>/cwd` 指向隔离 Workspace。旧会话/gateway 的显式 cwd 不等于新建 Web 会话默认 cwd 正确。
14. 本机重新停机前补充状态备份 `/home/herman/.local/share/dsh-web-backups/local-20260905-final/dsh-state.tar.gz`，包含全部业务状态、配置、Profile 清单与 lock，仅排除已有备份/可重装的 runtime 与 Profile node_modules。SHA-256 为 `23644bdaaf1fd53afad8e47845ebd8060839b7a1588e45390b6f442390d414df`。尝试安装工作目录修复包时，pnpm 拒绝现有 lock 中 17 个刚发布的 0.3.16 条目；current 没有前移。
15. 初步把该问题归因于 ^ 范围漂移，随后核对停机前备份推翻了这一判断：11:29 的 Profile 已精确写为 0.3.16，pnpm-workspace 策略仍是 11:14 的 0.3.15 记录。用户明确确认在 Web 插件管理器点击过升级；不是普通重启暗中升级。未覆盖用户升级记录，未关闭发布时间检查。
16. 安装器补上 --save-exact，并把明确的 Web 版本 add 放在移除旧自有 bundle 之前，再重装自有包保留 provider 在前。25 项脚本测试通过。在旧 0.3.15 的隔离 Profile 中，官方 add 自动登记所请求的 0.3.16 例外，完整安装成功；在模拟“lock 已是 0.3.16 但政策记录仍旧”的隔离状态中，即便先 add 仍被拒绝。不能把前一个实验当成后一种现役状态已修复。
17. 11:36:28 本机服务被本轮之外的操作重新启动，主 PID 2245447、Web 2245614，current 仍为首批 22afcf…；NRestarts=0。没有擅自再次停止或改写这一新进程关联的活跃安装树，已询问用户协调其他部署/重启操作。远端仍为本轮成功启动的 3191528 监督树。
18. 截至 11:38，含全部代码修复的新候选已按正常入口构建/上传，两批各自 55 文件/1156 项测试通过；本机在 incoming/batch.lpvIqc，远端在 incoming/f2dffb…。当时尚未最终安装/启动，不能用制品测试代替最终部署。官方 `plugin --profile web clean --lockfile` 帮助确认会同时移除 Profile 的 node_modules 与 lock；当时尚未在真实 home 执行该恢复动作。
19. 用户确认 11:36 重启来自其 HM 配置操作，协调疑点关闭；保留其已提交和应用的 HM 修改。隔离副本验证官方 clean --lockfile 后，原供应链策略保持启用，正常安装本批精确版本成功。再次停止精确本机服务，保存 `/home/herman/.local/share/dsh-web-backups/local-20260905-post-hm/dsh-state.tar.gz`，SHA-256 `4d1626191615a7243aed78a3f86eb703e4161f6e8bdb05c6cdd8b551b73860c6`；仅排除已有完整备份内的可重装 node_modules 与 recovery。随后在真实 Profile 执行同一官方重建流程并正常安装成功，未手改 node_modules/bundle，没有关闭策略或自动降级。
20. 约 11:47 本机启动最终 db14d1… 包：服务主 PID 2255738，Web PID 2255769，NRestarts=0。实际 `/proc/2255769/cwd` 是 `/home/herman/.dsh/workspace`。登录 303、有 Cookie、认证后 200、错误 Origin 403；凭据指纹和例外旧会话 SHA 均未变。首次 Telegram 通知记录失败，但随后 getMe 成功，通过同一个通知脚本一次性人工补发返回 0；没有加入自动重试机制，不能把 API 接收当作用户已读。
21. 约 11:48 对远端 3191528 监督树发 TERM；监听先释放，旧代理仍短暂等待连接关闭，因此首次退出检查停止了安装步骤。复核时原树已自行完全退出，后续 KILL 命令因前置 PID 检查不通过而未执行。确认原 PID 全部不存在后保存 `/home/herman/.local/share/dsh-web-backups/hermes-20260905-final/dsh-state.tar.gz`，SHA-256 `1634c18fa21d9a1ca203af66aee1a2a9590861f1c75275d0fc5b222f4aa0ff6d`，再安装已上传 f2dffb…，没有重新选择版本。
22. 约 11:50 远端最终启动：监督 PID 3197839、Web PID 3197907、LAN 代理 PID 3197873，断开 SSH 后保持运行；Web 实际 cwd 是原 Workspace。loopback/LAN/域名未认证 401，loopback/域名登录 303 和认证后 200、错误 Origin 403。启动日志没有通知失败；两端 Telegram getMe/Notion users/me 200，凭据指纹不变。两端 cron 控制 socket 有监听，assistant quick_check=ok；远端既有 blocked/failed 状态保持原样。
23. 最终包为 Harness 0.1.2-rc.1、17 个 scoped Web 0.3.16、sidebar 0.18.0；安装时两端各 21 依赖、23 bundles，无 all/perf。单独对 Profile 执行 pnpm peers check 仍有警告，不能记为零警告安装；只读检查确认三个自有插件要求的宿主 SDK 均由 runtime 提供且满足精确版本。React 18.3.1 由 runtime 提供，部分前端模块不是独立 node_modules 包，浏览器交互另行检查；better-locale 是 sidebar 声明的 optional peer。没有通过 force 补装另一套宿主。
24. 约 11:52–11:55 在新建浏览器验收页实际打开本机任务看板、中文侧栏、设置、Web 插件配置、插件管理列表、皮肤页；不改主题、不安装/升级/卸载插件。普通自动点击 Web 插件按钮超时，查看状态后用已定位按钮的 CDP DOM click 成功，未修改页面源码。列表确认自有三个包已开启，所选 Web 版本与本批一致；此时另出现非本轮安装的 chatgpt-subscription 0.1.39，保留不动，不重新覆盖 Profile。
25. 本机既有 test 会话展示 11:38–11:39 的 openai-codex/openai 未配置错误，默认模型为 openai/gpt-5.6-terra；核对时原凭据只有 DeepSeek/Grok 与 Telegram，未替用户改模型或补凭据。远端域名页面能加载，但远程访问插件提示浏览器未配对，阻止工作区数据访问。保留设备认证，未绕过；HTTP 检查与页面资源加载不能替代远端业务验收。

## 逻辑链条

- 不整体切换 Home Manager：本次只授权 DSH 上线，无关应用降级不在范围内。配置源和生成单元仍都由 Nix 定义，未新增长期 drop-in 配置所有者。
- 两端各自打包：bot 不同，不能把默认远端凭据覆盖到本机；版本均从各自准备批次一次确定。
- 真实代理测试补足 mock 的盲区：原监督测试的假代理没有入口判断，未覆盖软链接与 ESM 路径相等条件。
- 失败不自动回滚：按已明确的边界，保留备份与停止现场，仅修正明确可逆的启动路径问题。

## 改动

- `scripts/dsh-web-start`：子进程使用选定 release 的真实路径。
- `scripts/tests/web-deploy.test.mjs`：真实 LAN 代理通过 current 的回归测试。
- `bin/dsh`、`scripts/tests/npm-runtime.test.mjs`：区分 npx 解析目录与应用实际 Workspace。
- `scripts/lib/web-package.mjs`、`scripts/tests/web-package.test.mjs`：通过官方 add 精确登记 Web 版本后再移除旧自有包；不自动处理不一致的供应链策略记录。
- `/home/herman/.config/home-manager/home/applications.nix`：已有 DSH 服务改用本机归档 current/bin/web；格式化该已有块，保留其他配置。
- 两端官方 runtime/Profile/稳定 tgz、归档 current；不删除会话、预设、cron、assistant、Workspace。

## 验证

- 首轮本机归档 SHA-256：`22afcf9ddcccbc227277dcb2985a30db23c5205e41fe0005cb85ef2310e6906b`。
- 首轮远端归档 SHA-256：`93e4c57750e68258136b656a9bf3311efb2bc1712a9687786748040893c8cbc3`，安装成功但启动失败，不作为通过制品。
- 本机完整 home 备份 SHA-256：`c0fb36329da5d1460a3cbd0a711a71e31a4453639e99d7de20a1b165818241d2`。
- 远端完整 home 备份 SHA-256：`d9b5da3bf77fdee13b780a1805a5153d70f456fdb23acd1cb2a61a5d534b1036`。
- Nix：修改文件 nixfmt 检查通过；flake check --no-build 通过；只构建/链接 DSH 单元，未运行整体 switch。
- 最终活跃 current：本机 `db14d1f82b8697fbdf08d0e7a21ab3f6edc607873676fe54a418a220090b7b3b`；远端 `f2dffbda169d100f36101872f9cf544d38c4b9660d7ede13377d002f5ab340e7`。二者都已实际安装和启动，未携带源码、Node 或 node_modules。
- 远端新运行期 cron 账本存在 11:31 的 success/silent 完成记录；本机最近完成记录仍为切换前 10:38 success/delivered。没有人为触发真实任务来凑验收。
- 11:55 收尾复跑 25 项脚本测试全部通过，git diff --check 通过；fetch 后本地 main 相对 origin/main ahead 3、behind 0，任务分支包含当前 main。浏览器临时验收页已关闭，未关闭用户原有页面。

## 遗留

- HM 协调、Profile 重建及两端最终切换已完成；不再以它们作为阻塞项，不在运行中的目录重复安装。
- 远端浏览器需完成插件要求的设备配对；本机测试会话需选择已配置模型或完成相应 provider 配置。没有擅自关闭认证或改变用户选择。
- 真实 Telegram 回复、模型/Notion 业务及最终新版全部 UI 功能仍待验收；已验证的页面导航和凭据 API 不等于业务通过。
- 本机旧会话单项例外继续适用，原文件完整保留；没有扩大到其他会话。
- 不承诺自动恢复；未合并或推送项目分支。
