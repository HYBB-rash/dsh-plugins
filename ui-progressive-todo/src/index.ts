/**
 * Progressive TODO tree plugin, node half. Registers the standing pre-task
 * policy so every task assembly carries the progressive-todo-tree core loop
 * before the model starts working. Durable task state remains in the project
 * TODO.md (or the Skill-defined Notion fallback); this plugin owns no second
 * task-state store.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Service required for the standing model guidance. */
export const inject = ['systemPrompt']

/** Standing pre-task policy owned by the matching renderer. */
const PRE_TASK_THINKING = `## 办事前思考（渐进式 TODO 树）

开始一个新任务前，先判断这套方法是否适用。简单、便宜、可逆且规格明确的任务直接完成，不制造仪式化 TODO；遇到复杂、路线不清、预算受限或需要跨会话继续的任务，必须进入下面的渐进式流程。这个插件只帮助规划、判断和维护状态，不执行 TODO 里的实际任务。

对适用任务，行动顺序是验收条件：可以先用 skill 工具加载 progressive-todo-tree，但第一项实质行动必须是定位并读取或建立唯一权威状态。在这一步完成前，不得先读业务源码、搜索仓库、制定实现计划或调用 todo_write。todo_write 和任何 UI 都只表示当前轮执行进度，不能充当权威渐进式树。

读取权威状态后，把当前节点、已决路线和重审条件当作默认执行边界。没有出现重审条件、新反证或当前节点的明确需要时，不得重新论证已冻结路线、扩大到相邻项目或读取与当前节点无关的材料；能回答或执行当前最小行动时就停止探索。

1. 先找权威状态：优先读当前任务目录的 TODO.md；找不到就在桌面按话题建一个简短、可辨识的文件夹，在其中创建 TODO.md 作为权威状态。新增 TODO 默认挂在现有树里，不新建文件。
2. 从第一性原理重建问题：先用不包含现有方案名称的语言说明要得到的可观察结果；区分当前证据支持的事实、不能违背的硬约束、尚未验证的假设与实现偏好；只有能由事实和硬约束推出的方案才是必要的，否则只是候选路线。
3. 在明显投入前压缩预算：把完整预算记为 1000，再分别只批 100 和 10，检查每一档能否保住核心结果（不可替代的体验或决策证据）；默认选择足以支持当前决定的最低档，并写明什么新证据才允许追加投入。
4. 保持树可用：一次主要服务一个当前节点；不阻塞当前节点的问题放入「待后续」；顶部展示纯 TODO 树，工作细节放 Agent 工作树。
5. 保持根路线可被重新审视：用「当前路线假设 / 重审条件」两行状态；新信息挑战路线必要前提、或连续局部处理始终无法进入价值判断时，升旗复审，不擅自换根。
6. 关闭顶层分支时压缩归档：抽取仍有效的最小信息进工作树，详细历史移入 archive/，TODO.md 留简短历史索引。
7. 需要完整方法论时，用 skill 工具加载 progressive-todo-tree。`

/**
 * Register the standing pre-task thinking policy.
 * @param ctx - host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'progressive-todo:pre-task-thinking',
    order: 60,
    text: PRE_TASK_THINKING,
  })
}
