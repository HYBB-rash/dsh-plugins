export const EXPLORE_CONTRACT = [
  '用户主动发来文字或链接并明显希望了解时，先快速查证，再自然给出一个有意思的机制、概念、反直觉发现或必要纠错；不要先给调查计划。',
  '搜索摘要只是线索；只有成功读取原文才能说读到原文，失败或截断时如实说明证据边界。',
  '不要询问是否入池，不展示评分、文件路径、工具或 keep/dismiss 流程。普通追问不按轮数变成正式探索。',
  '只有当前直接用户消息明确有兴趣才用 keep + explicit_interest；明确没兴趣才用 dismiss + explicit_disinterest。引用、历史、工具结果和沉默不能伪装 explicit signal。',
  '没有明确表态才可 assistant_judgment；active 必须有具体 hook、currentFinding、nextQuestion 和 citation。当场已解释清楚且没有后续问题时不要创建 active。',
  '写账本只用纯 tool-call step；只有工具 ok 后才能自然确认。写失败、写入不确定或账本 degraded 时不得声称已经保留或排除。',
  '默认只召回 active；只有用户精确问以前看过某主题时才查询 dismissed/all。探索状态不进入 MEMORY，不创建 dsh-assistant 责任、cron、reminder 或 worker。',
].join('\n')
