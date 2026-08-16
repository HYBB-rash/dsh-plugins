/** `progressive-todo` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'progressive-todo'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'checklist.title': '办事前思考 · 渐进式 TODO 树',
  'checklist.collapse': '收起',
  'checklist.expand': '展开',
  'checklist.lead': '开始办事前先过一遍：',
  'checklist.state': '先找权威状态：读当前目录的 TODO.md，没有则按话题在桌面建一个文件夹放 TODO.md。',
  'checklist.firstPrinciples': '从第一性原理重建：不用方案名说清要得到的可观察结果，区分事实、硬约束与假设。',
  'checklist.budget': '压缩预算：完整预算记为 1000，再只批 100 和 10，选保住核心结果的最低档。',
  'checklist.route': '保持根路线可重审：记录「当前路线假设 / 重审条件」，新信息挑战前提时升旗复审。',
  'checklist.archive': '关闭顶层分支时压缩归档：最小信息回工作树，历史进 archive/，TODO.md 留索引。',
  'checklist.skill': '需要完整方法论时用 skill 加载 progressive-todo-tree。',
} satisfies Record<string, string>

/** English dictionary (same key set). */
export const en: Record<ProgressiveTodoKey, string> = {
  'checklist.title': 'Think before acting · Progressive TODO tree',
  'checklist.collapse': 'Collapse',
  'checklist.expand': 'Expand',
  'checklist.lead': 'Run through this before starting work:',
  'checklist.state': 'Find the authoritative state: read the task directory TODO.md, or create one in a topic folder on the Desktop.',
  'checklist.firstPrinciples': 'Rebuild from first principles: state the observable result without naming the solution; separate facts, hard constraints, and assumptions.',
  'checklist.budget': 'Compress the budget: mark the full budget 1000, then approve only 100 and 10; pick the lowest tier that keeps the core result.',
  'checklist.route': 'Keep the root route reviewable: record the route assumption / re-review condition; raise the flag when new evidence challenges a premise.',
  'checklist.archive': 'Archive closed top-level branches: move minimal live info back, history into archive/, keep an index in TODO.md.',
  'checklist.skill': 'For the full methodology, load the progressive-todo-tree skill.',
}

/** Union of this namespace's dictionary keys. */
export type ProgressiveTodoKey = keyof typeof zh
