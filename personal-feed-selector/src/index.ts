export {
  MAX_SELECTION_INPUT_CHARS,
  selectAttention,
  validateSelectionInput,
  type PersonalFeedSelectionInput,
  type SelectionExecutionResult,
  type SelectionFailureCode,
  type SelectionOutcome,
  type SemanticDecision,
  type SemanticJudge,
  type SemanticJudgmentResult,
} from './core.ts'

export {
  createDshSemanticJudge,
  selectionSystemPrompt,
  type DshSemanticJudgeConfig,
} from './dsh-semantic-judge.ts'

export {
  Config,
  apply,
  inject,
  installSelectionTools,
  registerSelectionTool,
  PERSONAL_FEED_SELECT_ATTENTION_TOOL,
  type Config as PluginConfig,
} from './plugin.ts'
