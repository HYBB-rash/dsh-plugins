---
name: personal-task-list
description: 当用户查询、增加、删除或修改个人任务清单，询问待办或要求重试尚未同步的任务变更时使用。不要把 dsh-assistant 当前责任账本、cron 任务或其他 Markdown 当作完整个人任务清单。
---

# 个人任务清单

Notion 是任务主源；`$DSH_HOME/storages/task-inbox/inbox.md` 只是规范镜像和离线缓冲。

## 先定位受控入口

受控入口固定为
`$DSH_HOME/workspace/automations/notion/notion_inbox_sync.py`。该入口必须由在线 Harness
Workspace 自己维护，且解析后的实际路径必须仍位于 `DSH_HOME` 内，是当前容器用户可读的
普通文件。

入口缺失、不可读、含糊、越出 `DSH_HOME` 或返回未知状态时，明确说明任务同步能力当前
不可用并停止。不要从产品仓库或镜像安装、复制、生成、覆盖或修复业务脚本，也不要改用
临时脚本、Notion 连接器或手工 HTTP 请求绕过它。

只接受同步器的五种结构化状态：`synced`、`queued`、`stale`、`conflict`、`error`。
stdout 不是合法 JSON、缺少状态或出现其他状态都按 `error` 处理。

## 查询任务

1. 先通过受控入口执行只读 `--pull --json`。
2. 再读取 `$DSH_HOME/storages/task-inbox/inbox.md`，用镜像正文回答。
3. `synced` 表示本次已从 Notion 刷新。只有同步器明确报告网络不可达并返回
   `stale`，且镜像已经存在时，才可用镜像回答；必须同时说明数据可能已过期。
4. 只读 pull 返回 `queued` 或 `conflict` 属于协议异常；不得把它解释为新建了 pending。
   鉴权、权限、入口或格式错误也不得伪装成可用的旧数据。

不要仅凭镜像不存在或为空断言 Notion 没有任务。

## 增加、删除或修改任务

1. 基于当前完整镜像生成修改后的完整正文，不做局部文件拼接。
2. 将完整正文经 stdin 交给受控入口的 `--set - --json`；正文不得进入 argv、日志或回执。
3. `synced` 后再确认 Notion 与本地镜像已经同步。
4. `queued` 表示 Notion 写入失败但完整正文已原子保存为本地 pending。明确告诉用户内容
   尚未同步到 Notion；不要声称修改已经在线生效。
5. `conflict` 时不覆盖任何一边，只让用户选择“以 Notion 为准”或“以本次修改为准”。

用户明确选择“以 Notion 为准”后，才调用 `--pull --force --json`；明确选择“以本次修改为准”
后，才调用 `--push --force --json`。一次选择只授权这一次对应的 force 操作，不能推断为以后的
force 权限。

## Pending 重试

用户明确要求重试时调用 `--retry-pending --json`。没有 pending 时同步器应静默且不访问
Notion；不要为了证明连通而创建测试任务。自动重试由 dsh-cron 的正式控制协议负责，本 Skill
不创建、编辑或删除 cron 账本。

不要读取或写入同步器的状态、指纹、pending 标记、token 文件或 Authorization header；这些
都由 Workspace 自有同步器负责。
