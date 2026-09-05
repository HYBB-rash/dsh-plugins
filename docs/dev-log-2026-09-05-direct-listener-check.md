# 开发日志：远端直接监听与退役 LAN 代理

- 日期：2026-09-05
- 范围：官方 npm Web 运行时、第三方远程配对插件、现有 LAN 代理。
- 结果：远端直接监听及自有代理退役已上线，真实域名的临时设备配对/RPC/页面验收通过；用户随后确认“对，是拦截的，都OK了”，本次改动按用户反馈验收通过。自动化浏览器配对未完成的历史证据保留，不改写为自动化通过。

## 目标

如果官方运行时支持直接监听 `0.0.0.0:3080`，使用其认证与配对机制，删除本仓库维护的 LAN 转发代码及进程；保留路由器 HTTPS 反代。本机正式服务继续 loopback。不得修改上游或绕过其明确限制。

## 时间线

1. 约 12:04–12:05 核对干净工作树和 main：fetch 后本地 main ahead 3、behind 0；5011768 包含当前 main。临时创建 `codex/direct-web-listener` 任务分支。
2. 读取现役脚本、测试和官方已安装包。确认旧代理同时承载源 IP 白名单；删除它会使 LAN 设备可以连接端口，认证责任改由运行时与配对插件承担，已向用户说明。
3. 在现有合成 Profile 上执行一次真实隔离启动：Harness 0.1.2-rc.1、Web 0.3.16，禁用真实 Telegram 和 cron，使用空 Workspace、显式端口 5094、离线 npx 和不可达 registry。命令传入 `--host 0.0.0.0`，没有接触真实服务或凭据。
4. 同时先为拟删除代理编写启动参数、退出状态与停止子树的测试。3 项按预期失败，证明当前启动/上传入口仍依赖代理；尚未写生产实现。
5. 真实运行时在监听之前退出，原文为：`error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`。实验未生成配对 token，没有继续发送配对请求。
6. 约 12:08 查询官方 npm latest，仍为 `0.1.2-rc.1`。在实际发布文件 `@deepseek-ai/dsh-web-app/lib/startup.js:40` 找到对该参数的显式拒绝；不能归因于旧安装或我们脚本解析错误。
7. 撤销本轮尚未实现的测试变更，确认与 5011768 原测试完全一致；空实验分支未产生提交，切回原迁移任务分支，确认没有 worktree 关联后删除该空分支。未删除代理源码，未修改目标 Skill 的运行边界。
8. 继续检查第三方发布包时，发现 `dsh-remote-web-ui/lib/types/lan-bind.js` 明确说明：CLI 防护保持不变，主动 LAN 开放通过普通 webserver 配置完成。前面的“当前不能直连”结论过早，已向用户明确纠正。重新建立同名任务分支继续。
9. 用插件自身 writeLanBind 在隔离 Profile 生成配置，发现其会在默认顶层 `[]` 后直接追加列表，导致 YAML 无效。仅修正合成 Profile 后，官方 npm Web 实际监听 0.0.0.0:5094。未修改上游文件或正式 Profile。
10. 将生产候选收束为现有配置层增加 remote.patch.yml：与插件 LAN 配置同形，固定压缩参数；地址端口来自 start 的环境变量。不依赖插件私有函数、不写 Profile、不调用插件的防火墙自动调整。再次编写 RED 测试，3 项因旧代理依赖失败；随后实现单 Web 监督与归档配置。
11. 约 12:20–12:23 补验真实 settings/describe RPC。先修正 payload.args 契约；随后发现 Node 24 fetch 的自定义 Host 未按探测意图生效，改用 node:http 保留请求头。最终验证域名直接 API 403、未配对 remote API 403、配对成功并读设置 200/result.ok=true、域名签发 POST 403；不是拿不存在路径的 404/405 当作授权证据。
12. 12:24–12:26 按部署入口重新选择一次 latest、独立构建并运行 55 文件/1156 项测试，全部通过。批次 Harness 仍 0.1.2-rc.1，17 个 scoped Web 包 0.3.16，sidebar 0.18.0。上传归档 SHA `4522faad2a49a12a47f2139fbf5012e3a6ee783d9cc6e80add906e5acb3e3085`，检查包内有 remote.patch.yml、没有自有 LAN 代理、源码或 node_modules。
13. 在确认旧监督 PID 3197839、proxy 3197873、Web 3197907 身份未变后，按用户本轮授权 TERM 精确监督树。不能只看端口：刚退出监督时还可见 Web 后代，随后确认整树消失才开始备份。备份位置 `/home/herman/.local/share/dsh-web-backups/hermes-20260905-direct/`，包括完整 .dsh 与旧入口；本机服务未动。
14. 完整 .dsh 备份 SHA `170565a8ac1313b02cd514bd06d568dc78da8b0412344e85618e354f4bc49b61`，gzip 校验通过。安装未重新选版本、未强装；pnpm 的 Profile peer 报告缺少宿主 SDK/React，实际这些由独立 runtime 的加载机制提供，保留警告，不伪装报告通过。12:31:45 第一版启动，Web 3205413 真实持有 0.0.0.0:3080，无自有 proxy。
15. 首次现场启动暴露隔离测试盲点：官方 banner 带同一行 LAN 后缀，而 runtime 通知正则使用行尾锚定；因此没有 Telegram 启动通知。补实际 banner 的 RED 测试，抓住第一次链接被漏掉、误取后续链接的问题，再最小改为 URL 后允许行尾或空白。25 项脚本测试全部通过。
16. 重新经同一 package/deploy 入口准备新批次，未热改现役 release；55 文件/1156 项测试再次通过，版本组合未变。通知修正版归档 SHA `1df54a038a47ca01fc3fa3f2c97b5a7fc47d2614fab434286cfe609b00296438`。
17. 第一次浏览器配对链接跳转被 Vivaldi ERR_BLOCKED_BY_CLIENT 拦截，没有因此关闭浏览器保护。准备改走插件已有的粘贴链接/token 输入框；一次性 localhost 交接仅用于把官方签发链接交给当前浏览器，不打印凭据、不进入归档或部署。
18. 精确停止第一版 Web 树后，补充备份可能新写入的全部状态（不重拷未变的 runtime/node_modules 与历史备份），SHA `95ff818e628a767fec59d9cf9574c6402086f71c2c0952a9c8234cf2b5bbe3e9`。再次安装后，12:39:05 启动通知修正版监督 PID 3206492；本机 systemd MainPID 2255738、11:47:11 的启动时间未变。
19. 最终远端 Web PID 3206552、进程组 3206525，唯一 0.0.0.0:3080 监听由 Web 持有，cwd=/home/herman/.dsh/workspace，cron control socket 存在。账号和 Notion 凭据哈希分别仍为 `8fca45593da22a82dd5ef40de17e4425459ea9b705d60eda491122e86db906a8`、`3375bcda2ac21d5c84d34eccffed85264ffb2827a8928ee182984c8b58a16754`；通知 relay 的最终代码已更新、未报通知失败，但没有把用户实际收到消息视为已人工确认。
20. Vivaldi 也拦截了临时 localhost 交接页，未能把链接交给其输入框。延长临时页可读取时间后结果相同，停止继续尝试；没有调整浏览器安全/拦截设置，没有声明当前浏览器已配对。临时监听自然关闭，交接代码不入库、不留作运行依赖。
21. 约 12:45，改用普通 HTTP 客户端沿真实 https://dsh.man-her.icu 验证官方签发/接受链：配对 GET 303，跳转仍为 HTTPS；携测试设备 cookie 的 /remote/api/settings/describe 为 200 且 result.ok=true，/pair-app 页面为 200。finally 通过官方 revoke 只撤销本次测试 deviceId，成功回执已验证。说明路由器 HTTPS 链路与服务端配对可用，未以此代替当前浏览器交互验收。
22. 收尾 fetch 后本地 main 仍 ahead origin/main 3、behind 0，任务分支包含最新 main；保留任务分支待用户验收，不合并、不推送。
23. 无任何令牌的 `/pair-accept` 检查页也在浏览器自动化中返回 ERR_BLOCKED_BY_CLIENT；普通 HTTPS 客户端同一 URL 返回 200，响应无异常跳转。尚不能区分 Vivaldi/扩展拦截与自动化导航限制，需要用户手动打开该无令牌页做一次对照，不据此修改浏览器设置。
24. 用户确认拦截并反馈“都OK了”，随后明确授权“合并+推送”。收尾仅更新验收记录与 Git：fresh fetch 后 origin/main 是 main 的祖先、main 是任务分支的祖先，可以快进；不重新部署、不改浏览器设置。待推送确认后只清理本次已结束的 direct-web-listener 和 official-npm-runtime 分支，其他任务及 worktree 保留。

## 逻辑链条

- CLI 参数限制和插件有意支持的配置入口必须分开验证；仅依据其中一个就下结论会误判能力。
- 使用当前版本已验证的正常配置入口满足用户条件；不改上游、不恢复私有 fork、不引入第二个常驻进程。
- 退役自己的 LAN 代理也意味着退役其来源白名单，已向用户说明。仍保留外部路由器 HTTPS 反代、Harness 认证和插件配对；不通过全局 trusted-host 绕过 remote 通道。
- 通知器 public origin 与插件 public base 是两条配置，start 显式给插件设置同域名默认值。远端实例的配对不能由本机另一份 3080 代办。

## 改动

- 新增 config/web/remote.patch.yml；start 加载远端配置、提供外部域名、只监督 Web 组。
- package/deploy 不再携带或要求 LAN 代理；删除代理源码及专属测试，可从 Git 与旧发布包找回。
- 更新启动回归测试、部署说明、项目经验和部署 Skill 的监听边界。Skill 结构校验通过；只审计本次增量，不宣称整个历史 Skill 的语义门禁被重新验收。

## 验证

- registry 查询：`@deepseek-ai/dsh@latest` = `0.1.2-rc.1`。
- CLI 显式 0.0.0.0 失败；普通配置入口成功；合成实验进程已停止，Profile 不依赖写入的 managed block。
- 脚本回归 25 项通过，含离线入口、上传/安装/启动隔离、默认/自定义监听参数、冲突 CLI 参数拒绝、精确子树停止以及 LAN banner 下的一次通知。
- 55 文件/1156 项插件测试、插件边界检查、git diff --check 通过。Skill quick_validate 首次缺 PyYAML，使用同一 Nix flake 的一次性 python.withPackages 后原样校验通过，未改全局 Python。

## 遗留

- 用户已确认本次验收通过，不再把已确认的浏览器拦截作为本次上线阻塞；未调整浏览器设置。
- 自动测试和用户总体确认不等于每条 Telegram/cron/assistant/模型/Notion 流程都有新增自动化证据；保留上述实际验证范围，不擅自发消息或触发业务。
