import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import type { CleanFeedbackRequest } from './contract.ts'

/** The only model-facing tool in one clean X-feedback interaction. */
export const SUBMIT_X_FEEDBACK_INTERPRETATION = 'submit_x_feedback_interpretation'

/**
 * Fixed instructions for the isolated interpreter. Dynamic material belongs in
 * the one user message created by {@link createCleanFeedbackMessage}; keeping
 * it out of this section makes the complete-prompt boundary auditable.
 */
export const CLEAN_FEEDBACK_SYSTEM_PROMPT = [
  '你是一次性 X 内容反馈解释器。',
  '你只能依据当前用户反馈请求中的材料作判断，不得读取、猜测或延续其他会话。',
  `必须调用 ${SUBMIT_X_FEEDBACK_INTERPRETATION} 一次提交一个解释结果；不要输出普通文本。`,
  '工具参数必须严格符合其 schema，不要添加未声明字段。',
].join('\n')

const feedbackDimensionSchema = {
  type: 'string',
  enum: ['content_value', 'argument_quality', 'factual_accuracy'],
} as const

const nonEmptyStringSchema = {
  type: 'string',
} as const

const passSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'pass' },
    reason: {
      type: 'string',
      enum: ['ordinary', 'not_feedback', 'mixed_intent', 'target_ambiguous'],
    },
  },
  required: ['kind', 'reason'],
} as const

const operationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'operation' },
    operation: { type: 'string', enum: ['save', 'unsave'] },
    targetId: nonEmptyStringSchema,
  },
  required: ['kind', 'operation', 'targetId'],
} as const

const ratingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'rating' },
    sentiment: { type: 'string', enum: ['like', 'dislike'] },
    targetId: nonEmptyStringSchema,
    dimension: feedbackDimensionSchema,
    reason: nonEmptyStringSchema,
  },
  required: ['kind', 'sentiment', 'targetId', 'dimension'],
} as const

const reasonAnswerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'reason_answer' },
    reason: nonEmptyStringSchema,
  },
  required: ['kind', 'reason'],
} as const

const priorReasonReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'prior_reason_reference' },
    targetId: nonEmptyStringSchema,
    dimension: feedbackDimensionSchema,
  },
  required: ['kind', 'targetId', 'dimension'],
} as const

const candidateReasonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'candidate_reason' },
    sentiment: { type: 'string', enum: ['like', 'dislike'] },
    targetId: nonEmptyStringSchema,
    dimension: feedbackDimensionSchema,
    candidate: nonEmptyStringSchema,
  },
  required: ['kind', 'sentiment', 'targetId', 'dimension', 'candidate'],
} as const

const confirmCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'confirm_candidate' },
    confirmation: nonEmptyStringSchema,
  },
  required: ['kind', 'confirmation'],
} as const

const abandonPendingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'abandon_pending' },
  },
  required: ['kind'],
} as const

/** Strict model-facing argument schema for the closed interpretation union. */
export const SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA: ToolSchema = {
  name: SUBMIT_X_FEEDBACK_INTERPRETATION,
  description: '提交一个严格符合 X 反馈解释联合类型的结果。',
  parameters: {
    oneOf: [
      passSchema,
      operationSchema,
      ratingSchema,
      reasonAnswerSchema,
      priorReasonReferenceSchema,
      candidateReasonSchema,
      confirmCandidateSchema,
      abandonPendingSchema,
    ],
  },
}

/** Stable user-message prefix; the request JSON is the only dynamic payload. */
export const CLEAN_FEEDBACK_REQUEST_PREFIX = '当前一次性 X 反馈请求（仅处理以下 JSON）：'

/**
 * Build the sole user message admitted by the clean Agent's pre-step.
 * `JSON.stringify()` is intentionally the only serialization of dynamic input.
 */
export function createCleanFeedbackMessage(request: CleanFeedbackRequest): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `${CLEAN_FEEDBACK_REQUEST_PREFIX}\n${JSON.stringify(request)}` }],
    source: { kind: 'plugin', plugin: 'x-feed' },
  })
}
