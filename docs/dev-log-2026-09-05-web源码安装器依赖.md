# 开发日志：Web 源码安装器依赖修复

- 日期：2026-09-05
- 范围：`scripts/dsh-web-install-plugins`、源码安装流程测试、构建依赖缓存忽略规则

## 目标

修复干净源码工作树中 `dsh-web-install-plugins` 无法真实构建三个本地插件、Harness 构建过程 pnpm 版本漂移，以及跳过安装脚本后 `fs-ext` native addon 缺失的问题。完成标准是：不修改 `upstream/`，继续保持安装与运行两段式入口，在隔离 `DSH_WEB_HOME` 中完成真实安装，三个插件各登记一次，并实际加载 `fs_ext.node`。

## 时间线

1. 用户确认直接修复安装器后，先冻结边界：只修改源码安装器及测试，不修改正在运行的 3080 服务、Home Manager 或 `~/.dsh`，也不新增第三套刷新入口。复杂度预算机械校验与独立挑战均确认这是既有安装器职责内部的修复，新增长期概念数为 0。
2. 从当时最新 `origin/main` 建立独立工作树和分支。测试先构造 pnpm 的真实分裂可见性：Harness 根 `node_modules` 独有 `@types/node`、`tsdown`，`.pnpm/node_modules` 独有 `@deepseek-ai/cordis`。当前脚本只把插件链接到后者，RED 以“无法解析 `@types/node`”失败；同一次检查也确认 native 标记不存在。
3. 首轮实现建立 Git 忽略的合成依赖视图，并按各插件 `package.json` 的真实包名建立自链接。测试先发现 `build_plugin` 仍把链接改回旧虚拟层；修正该旧引用后转绿。
4. 隔离真实安装继续暴露 pnpm 版本问题：顶层 `corepack pnpm` 并不能约束 Harness `build.ts` 内部的 `pnpm --filter ...`，嵌套命令命中了环境中的 pnpm 11.22，而 Harness 声明 11.7.0，因此 `build:web` 拒绝运行。
5. 为该现场失败新增 RED：测试把 PATH 中的 pnpm 模拟为错误版本，并让声明版本的假构建再次从 PATH 调用 `pnpm --filter`。随后安装器从 Harness `packageManager` 读取版本，只在当前安装进程的临时 PATH 中生成 Corepack shim；测试与真实 Harness Web 构建均通过。
6. 首次 native 方案使用 `pnpm rebuild fs-ext`。命令退出 0，但真实 `require()` 仍报缺少 `build/Release/fs_ext.node`，证明原测试在看到 rebuild 命令后直接制造标记是假阳性。
7. 工作期间主线推进 10 个提交，其中包含既有 Profile 刷新逻辑；先变基并保留“已安装插件先 remove、再 add”的主线行为。随后改正测试：假 `pnpm rebuild` 不再制造二进制，只有在唯一 `fs-ext` 包目录执行其 `npm run install` 才生成标记。测试按 native 缺失重新变红。
8. 安装器改为在 `pnpm install --ignore-scripts` 后定位唯一安装的 `fs-ext`，执行包自身的 `npm run install`。测试转绿；隔离真实安装完成 Harness、Web 和三个插件构建，随后真实 `require('fs-ext')` 通过。
9. 主线又推进一个纯文档提交，结束前再次变基。变基后重新运行入口测试、自描述插件测试、传输包测试和静态检查，全部通过。

## 逻辑链条

- 插件同时需要 Harness 根层构建工具和 pnpm 虚拟层 workspace 包，单独链接任一层都会缺另一类依赖；因此在安装器内部合成只读符号链接视图，而不修改 pnpm store 或上游源码。
- 目录名 `telegram-gateway` 不等于包名 `@deepseek-ai/dsh-telegram-gateway`；本地插件自链接必须读取 `package.json.name`，不能继续由目录名猜测。
- 没有改成普通 `pnpm install` 或设置 `CI=true`：这会打开 Lefthook 等与本问题无关的 lifecycle，扩大副作用。
- 没有使用 `pnpm rebuild --pending`：它会重建全部被跳过脚本的包。`pnpm rebuild fs-ext` 又已被真实结果证明会无声空操作，因此最终只运行已确认缺失包自己的 install 脚本。
- 没有把调查时的 `/tmp` union 手工操作原样固化；合成视图封装在既有安装器内，外部工作流不增加新入口。
- Profile 插件管理器末尾仍报告环境 pnpm 11.22，但它只负责隔离 Profile 的 `file:` 安装且成功；本次只固定已发生版本拒绝的 Harness 构建链，不扩大范围。

## 改动

- `.gitignore`：忽略安装器生成的 `.dsh-plugin-node_modules/`。
- `scripts/dsh-web-install-plugins`：
  - 从 Harness `packageManager` 生成进程内 pnpm shim，覆盖嵌套构建命令；
  - 定向执行唯一 `fs-ext` 包的 install 脚本；
  - 合并 Harness 根层与 pnpm 虚拟层依赖视图；
  - 按插件包名建立自链接，并让三个插件使用该完整视图构建；
  - 保留主线已有的 Profile remove 后 add 刷新行为。
- `scripts/tests/dsh-web-packages.test.sh`：覆盖分裂依赖布局、嵌套 pnpm 版本、真实包名链接及 native install 结果，不再由假 rebuild 制造成功标记。

## 验证

- TDD RED 1：旧实现缺 `@types/node`，同时无 native 标记。
- TDD RED 2：未钉住嵌套 PATH 时命中假 pnpm 11.22。
- TDD RED 3：取消假 rebuild 标记后，仅因 `fs_ext.node` 缺失失败。
- `nix develop -c env DSH_WEB_HOME=/tmp/dsh-web-installer-fix-check ./scripts/dsh-web-install-plugins`：通过；同一隔离 Profile 重复刷新通过。
- `nix develop -c node -e "require('./upstream/deepseek-harness/node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext')"`：通过。
- 隔离 `--dump-config`：`telegram-gateway=1`、`dsh-cron=1`、`dsh-assistant=1`。
- `nix develop -c bash scripts/tests/dsh-web-packages.test.sh`：通过。
- `nix develop -c bash scripts/tests/self-describing-plugins.test.sh`：通过。
- `nix develop -c bash scripts/tests/package-dsh-web.test.sh`：通过。
- `bash -n scripts/dsh-web-install-plugins scripts/dsh-web-runtime scripts/package-dsh-web`：通过。
- `git diff --check`：通过。

## 遗留

- 本任务没有刷新或重启真实 `~/.dsh` 的 3080 常驻实例；其运行状态保持不变。
- Home Manager 服务仍指向 `/home/herman/Projects/dsh-plugins-wave13-main-integrate`。改为长期稳定 checkout 属于后续独立任务，不在本修复范围内。
