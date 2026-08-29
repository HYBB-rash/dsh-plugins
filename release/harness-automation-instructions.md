# DSH Harness Workspace 规则

- `DSH_HOME` 是唯一状态根。私有记忆、任务镜像、业务自动化、回执和凭据都必须解析到 `DSH_HOME` 内；路径缺失、含糊或越界时停止，不要寻找宿主替代目录。
- `$DSH_HOME/workspace/MEMORY.md` 是唯一私有记忆源。不要从其他记忆源读取、导入、合并、比较、验证或补充用户事实。
- 个人业务 automation 只由在线 Harness Workspace 维护，正式来源是 `$DSH_HOME/workspace/automations/`。产品仓库、镜像和 release migration 不安装、复制、生成、覆盖、删除或回退这些脚本。
- 调用业务 automation 前，先从当前 Workspace 指令或其 registry 解析受控入口；入口必须是 `DSH_HOME` 内当前用户可访问的普通文件。入口缺失或不合法时如实报告不可用，不要从产品镜像修复。
- Notion 是个人任务主源；`$DSH_HOME/storages/task-inbox/inbox.md` 只是规范镜像和离线缓冲。不要用其他宿主 inbox 覆盖它。
- 凭据只使用 `DSH_HOME` 内受控文件路径，token 不进入 argv、环境、日志或回执。可变状态放在 `$DSH_HOME/storages/`，不要放进业务脚本目录。
- Cron 变化只走 dsh-cron 正式控制或 maintenance API；不要直接编辑 `jobs.jsonl`、`runs.jsonl`。SQLite 也只使用所属产品的正式 API 或只读健康检查。
- 日志和回执不得包含完整私人记忆、任务正文、凭据、Authorization header 或完整外部请求。
