---
name: dsh-web-dev
description: 在 dsh-plugins 仓库中安装、刷新和启动本地 DSH Web 开发环境。涉及 upstream/deepseek-harness、telegram-gateway、dsh-cron、dsh-assistant、本地 Web Profile、cordis patch、VS Code Web 启动任务，或用户要求启动/重建本地开发服时使用。采用“先安装插件、再单独启动运行时”的两段式流程；不恢复旧 scripts/dsh-web，不直接维护 Profile node_modules。
---

# DSH Web 本地开发

使用仓库提供的两段式入口，使源码开发与可传输包保持同一种安装/启动模型：插件由 Harness 插件管理器安装，运行入口只负责启动。开发与生产包必须使用字节一致的 Harness、插件构建产物、Web patch 和 runtime 脚本；生产唯一特殊性是 `package-dsh-web` 在打包阶段附加 Git 忽略的线上凭据数据，不得为生产另建代码或配置分支。

## 适用边界

在 `/home/herman/Projects/dsh-plugins` 中进行以下工作时使用：

- 启动或重建本地 DSH Web；
- 修改 `upstream/deepseek-harness`；
- 修改 `telegram-gateway`、`dsh-cron`、`dsh-assistant` 的源码、构建配置、包清单或 `cordis.patch.yml`；
- 修改 `config/web/portable.patch.yml` 或本地 Web 启动任务；
- 排查本地 Web Profile 的插件安装、登记或配置合成问题。

本文只覆盖本地源码开发入口。生产发布、Docker、快照、验收和回退遵循仓库其他专门规则。

## 开始前

1. 阅读仓库 `AGENTS.md`，检索 `MEMORY.md` 中与本次问题相关的记录。
2. 检查 Git 分支和工作树，保留用户的无关改动。
3. 从仓库根目录进入开发环境：

   ```bash
   nix develop
   ```

   已由 direnv 进入同一环境时无需重复嵌套。

## 安装或刷新插件

首次准备环境，或 Harness、任一插件源码、插件 `package.json`、`cordis.patch.yml` 发生变化后运行：

```bash
./scripts/dsh-web-install-plugins
```

源码仓库模式下，该入口会：

1. 使用 `${DSH_WEB_HOME:-$PWD/.dsh-web}` 作为 `DSH_HOME`；
2. 安装并构建 Harness；
3. 构建 `telegram-gateway`、`dsh-cron`、`dsh-assistant`；
4. 通过 Harness 的 `plugin --profile web add --ignore-scripts --force` 刷新三个本地插件；
5. 让插件自己的 `dsh.bundle.patch` 自动登记到 Web Profile。

不要直接写 `$DSH_HOME/profiles/web/node_modules`，不要手改 `dsh.profile.bundles` 代替插件安装器，也不要恢复已清退的组合入口 `scripts/dsh-web`。

## 启动开发服

安装成功后单独运行：

```bash
./scripts/dsh-web-runtime
```

参数会原样传给 Harness，例如：

```bash
./scripts/dsh-web-runtime --host 127.0.0.1 --port 3080 --no-open
```

该入口只启动运行时，不构建、不安装插件。源码模式使用 `config/web/portable.patch.yml`；运行目录默认是 `.dsh-web`，可用 `DSH_WEB_HOME=/path/to/home` 隔离多个本地环境。

VS Code 中对应两个任务：

1. `DSH: Install Web Plugins (source)`
2. `DSH: Start Web (source)`

不要把二者重新合并成一个任务。

## 无副作用验证

自动验证优先合成配置，不直接启动可能连接 Telegram 或领取 cron 工作的真实服务：

```bash
./scripts/dsh-web-runtime --dump-config > /tmp/dsh-web-effective.yml
```

确认三个插件各出现一次：

```bash
for id in telegram-gateway dsh-cron dsh-assistant; do
  test "$(grep -Ec "^[[:space:]]*- id: $id$" /tmp/dsh-web-effective.yml)" -eq 1
done
```

只有用户明确要求真实运行验收，且凭据、Telegram、cron 和其他外部写入边界已经确认时，才启动完整服务。

## 清理旧版 Profile

若安装报错指向已经删除的旧 `file:` 依赖：

1. 先确认本地 Web 进程已停止；
2. 检查 `${DSH_WEB_HOME:-$PWD/.dsh-web}/profiles/web/package.json`，确认它确实是旧脚本生成的 Profile；
3. 只删除可再生的 `profiles/` 安装状态：

   ```bash
   rm -rf "${DSH_WEB_HOME:-$PWD/.dsh-web}/profiles"
   ./scripts/dsh-web-install-plugins
   ```

不得删除 `.dsh-web` 整体；保留其中的 storage、凭据和业务数据。不能证明 Profile 可再生时停止并询问用户，不要猜测清理。

## 修改后的验证

按改动范围运行，至少覆盖入口合同和配置合成：

```bash
nix develop -c bash scripts/tests/dsh-web-packages.test.sh
nix develop -c bash scripts/tests/self-describing-plugins.test.sh
nix develop -c bash scripts/tests/package-dsh-web.test.sh
bash -n scripts/dsh-web-install-plugins scripts/dsh-web-runtime scripts/package-dsh-web
git diff --check
```

随后用隔离的 `DSH_WEB_HOME` 完成一次真实安装和 `--dump-config`：

```bash
DSH_WEB_HOME=/tmp/dsh-web-dev-check ./scripts/dsh-web-install-plugins
DSH_WEB_HOME=/tmp/dsh-web-dev-check ./scripts/dsh-web-runtime --dump-config \
  > /tmp/dsh-web-effective.yml
```

报告安装是否成功、最终 bundle 列表、三个插件是否各出现一次，以及是否实际启动过服务。不要把“配置可合成”描述为完整业务健康验收。
