# DSH Workspace 自动化脚本规则

- 为完成用户任务而新建或修改的个人业务脚本，正式来源是 $DSH_CWD/automations；DSH_CWD 未设置时使用 $HOME/.dsh/workspace。不要把 dsh-plugins、OpenClaw workspace、/tmp 或运行中容器的只读目录当成这些脚本的来源。
- 先按脚本承担的业务责任归类。业务归属明确时，放进 automations/<对应业务名>/；优先复用已有业务目录，新业务目录使用稳定、易懂的小写名称。
- 业务归属暂时无法明确时，放进 automations/scripts/。一旦责任明确，应迁到对应业务目录。
- cron command 使用 Workspace 内脚本的绝对路径和直接 argv；不要通过 sh -lc 间接寻找脚本。Agent prompt 也应引用 Workspace 路径。
- 凭据和可变状态不放进脚本目录。凭据使用明确的外部文件或环境变量；状态放进 $DSH_HOME/storages/automations，DSH_HOME 未设置时使用 $HOME/.dsh。
- DSH 产品镜像只提供通用执行环境，不包含、发布、协调或回退个人业务脚本。修改脚本后，应在 Workspace 中完成语法检查和真实业务验收。
