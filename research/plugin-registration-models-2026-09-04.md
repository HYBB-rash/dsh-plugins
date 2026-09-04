# 市面插件动态注册方式调查

日期：2026-09-04

## 结论

成熟插件系统通常没有把插件代码编进宿主二进制，也没有把代码写进配置。它们统一提供三层机制：

1. **安装**：将一个完整、自包含的插件单元放入固定插件目录。
2. **注册**：manifest 或配置只声明插件身份、代码入口、启用状态和参数。
3. **运行状态**：插件产生的数据放在另外的用户数据或应用数据目录。

这些产品看起来简单，不是因为动态加载本身没有复杂度，而是宿主统一拥有插件目录、安装器、manifest loader 和启停生命周期。插件作者与部署者不必各自处理源码链接、依赖安装位置和模块解析。

## 产品对照

| 产品 | 插件代码如何交付 | 如何注册和启用 | 代码与状态的关系 |
| --- | --- | --- | --- |
| VS Code | 扩展打成 VSIX，安装后复制到 VS Code 扩展目录 | 根目录 `package.json` 声明贡献点和激活条件，运行时代码再调用 VS Code API 注册行为 | 代码位于统一扩展目录；配置只声明入口和能力 |
| Obsidian | 发布 `manifest.json`、构建后的 `main.js` 和可选 `styles.css`，放入 `.obsidian/plugins/<id>` | 用户在设置中启用插件，Obsidian 按 manifest 加载 `main.js` | 构建产物作为一个独立插件目录交付，不携带源码依赖树 |
| Grafana | 从 Catalog、CLI 或 ZIP 安装；ZIP 解压到配置指定的插件目录 | Grafana 启动时扫描插件目录中的 `plugin.json`；有 `dist` 时加载 `dist` | 插件目录由部署拥有，运行配置和应用数据另行管理 |
| Koishi | Marketplace/依赖管理先安装插件包 | 安装后不会自动启用；用户再建立配置并启用，禁用不删除代码或配置 | “安装代码”和“启用配置”是两项独立操作 |

## 关键证据

### VS Code

每个 VS Code 扩展根目录必须有 `package.json` manifest。扩展通过 manifest 中的 Contribution Points 静态声明能力和激活条件，激活后的 JavaScript 再通过 VS Code API 注册具体行为。[Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy) · [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

VS Code 使用 `vsce package` 生成包含扩展内容的 `.vsix`。VSIX 可以通过 Marketplace、UI 或命令安装；官方文档明确说明加载扩展时会把文件复制到 VS Code 的扩展目录，Linux 默认为 `~/.vscode/extensions`。[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

VS Code 还建议用 esbuild、webpack 等把多源码文件和 npm 依赖打成较少的文件，因为开发期的模块拆分会增加安装和加载成本。这是优化手段，不改变“独立扩展包 + manifest”的模型。[Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)

### Obsidian

Obsidian 官方 sample plugin 将 TypeScript 编译为 `main.js`。发布版本上传 `manifest.json`、`main.js` 和 `styles.css`；开发时可直接把插件目录放入 `.obsidian/plugins/<plugin-id>`，然后在设置中启用。[Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)

这意味着 Obsidian 的部署单元不是源码仓库或共享 `node_modules`，而是一个包含 manifest 与构建后入口的自包含插件目录。

### Grafana

所有 Grafana 插件都需要 `plugin.json`。Grafana 启动时扫描插件目录，挂载包含 `plugin.json` 的插件；如果插件目录包含 `dist` 子目录，则挂载构建后的 `dist`。[Plugin metadata](https://grafana.com/developers/plugin-tools/reference/plugin-json)

Grafana 支持 UI、CLI 和 ZIP 安装。离线安装的官方步骤是把 ZIP 解压到配置文件指定的插件目录；配置也可通过插件 ID 声明预安装插件。[Install a plugin](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-install/)

### Koishi

Koishi 把插件安装、启用和配置明确分开。Marketplace 安装成功后插件不会自动启用；用户在 Plugin Configuration 中建立配置并启用。禁用插件不会删除插件代码或配置。[Install and Configure Plugins](https://koishi.chat/en-US/manual/usage/market.html)

Koishi 插件在代码层是接收 Context 与配置的函数、类或带 `apply` 方法的对象；加载插件等价于宿主调用该入口。[About Plugin](https://koishi.chat/en-US/guide/plugin/)

## 为什么它们没有显得这么复杂

它们把以下规则固定成宿主能力：

- 插件只能从一个约定目录或安装数据库发现；
- 每个插件有一个可独立搬运的构建产物；
- manifest 给出稳定 ID、版本、入口和兼容范围；
- “代码是否已安装”和“当前是否启用”分开；
- Loader 负责解析入口、激活和卸载；
- 插件数据由另一套数据目录或设置系统管理。

因此日常操作只剩：

```text
安装插件包 → 在配置中启用插件
```

复杂度仍然存在，但只实现一次，藏在宿主的插件管理器中。

## 当前 DSH 为什么显得复杂

当前本地流程同时处理了四件不同的事：

1. 为开发编译建立从 Harness `node_modules` 到工作区插件源码的绝对符号链接；
2. 编译 Harness 与六个本地插件；
3. 通过 Profile 自己的 pnpm 项目再次安装插件；
4. 尝试从包含 Profile、插件安装树和运行状态的 `DSH_HOME` 中提取部署包。

这些步骤分别属于开发解析、构建、安装和运行状态管理，却出现在同一个 `scripts/dsh-web` 流程里。难点主要来自职责混合，而不是 Cordis 动态注册本身。

## 对当前 DSH 的最小启示

针对“服务器包不可变、远端不安装依赖”的已确认要求，更接近 Grafana 的固定插件目录模型：

```text
不可变程序包/
  harness/
  plugins/<plugin-id>/
    package.json
    lib/
    其他运行资源
  profiles/web/
    插件 ID、入口与参数

外部 DSH_HOME/
  storages/
  workspace/
  credentials/
  机器级覆盖配置
```

构建阶段把每个插件变成自包含目录并放入包内固定 `plugins/` 根目录。Profile 只声明插件 ID、入口和参数；Loader 只从这个固定根目录解析。运行时不再执行 pnpm，也不把开发源码链接当成部署格式。

这不要求把插件合并进 `bin.js`。`bin.js` 仍可动态加载插件，但解析位置由程序包拥有，而不是由可变运行 Home 中的包管理器拥有。

## 反证与限制

- VS Code 和 Obsidian 的插件代码同样位于用户可写目录。因此“插件代码在可写目录”本身不必然错误；当产品允许用户随时安装、升级和删除插件时，这个目录就是统一插件管理器拥有的安装区。
- Koishi 也把插件依赖管理作为运行安装能力，因此不是“远端永不安装”的直接模板。
- 当前 DSH 的服务器目标要求不可变包和远端零安装，所以固定 package-owned plugin root 更合适。这是根据当前项目约束得出的选择，不是所有插件系统的普遍要求。
- 本次调查只比较插件发现、安装、注册和状态边界，没有比较沙箱、安全签名、版本求解或热更新实现。

## 来源

- [VS Code: Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [VS Code: Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [VS Code: Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VS Code: Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Grafana: Plugin metadata](https://grafana.com/developers/plugin-tools/reference/plugin-json)
- [Grafana: Install a plugin](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-install/)
- [Koishi: Install and Configure Plugins](https://koishi.chat/en-US/manual/usage/market.html)
- [Koishi: About Plugin](https://koishi.chat/en-US/guide/plugin/)
