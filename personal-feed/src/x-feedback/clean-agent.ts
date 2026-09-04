import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  CLEAN_FEEDBACK_SYSTEM_PROMPT,
  createCleanFeedbackMessage,
  SUBMIT_X_FEEDBACK_INTERPRETATION,
  SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA,
} from './clean-prompt.ts'
import type { CleanFeedbackRequest, FeedbackInterpretation } from './contract.ts'

const CLEAN_PROMPT_SECTION = 'x-feedback:clean-system'
const CLEAN_FEEDBACK_TIMEOUT_MS = 30_000

/** Captured model input, excluding non-wire control fields such as AbortSignal. */
export interface CleanFeedbackWireRequest {
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
}

/** Options that affect only this short-lived interpreter invocation. */
export interface CleanFeedbackAgentOptions {
  /** Positive timeout for the complete one-shot run. */
  readonly timeoutMs?: number
  /** Explicit selection used by callers that already resolved the default. */
  readonly modelSelection?: ModelSelection
  /** Test/deployment seam for reading the current default selection. */
  readonly defaultModelSelection?: () => ModelSelection
}

/** Successful output; no business effect is run by this module. */
export interface CleanFeedbackResult {
  readonly interpretation: FeedbackInterpretation
  readonly sessionId: SessionId
  readonly wire: CleanFeedbackWireRequest
}

/** Stable failure boundary for clean-agent setup, wire, and result validation. */
export class CleanFeedbackAgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CleanFeedbackAgentError'
  }
}

interface DefaultModelSelectionService {
  currentSelection(): ModelSelection
}

/**
 * Run one X feedback interpretation in a fresh, disposable Agent.
 *
 * The caller owns business effects. This boundary only accepts a validated
 * interpretation and the evidence needed to audit the isolated request.
 */
export async function runCleanFeedback(
  ctx: Context,
  request: CleanFeedbackRequest,
  options: CleanFeedbackAgentOptions = {},
): Promise<CleanFeedbackResult> {
  const timeoutMs = resolveTimeout(options.timeoutMs)
  const selection = resolveModelSelection(ctx, options)
  const sessionId = SessionId(`session-x-feedback-${randomUUID()}`)
  const cleanMessage = createCleanFeedbackMessage(request)
  const capturedRequests: CleanFeedbackWireRequest[] = []
  let submitted: FeedbackInterpretation | undefined
  let submitCallCount = 0
  let preStepCount = 0
  let timedOut = false
  let handle: AgentHandle | undefined

  const disposeWireCapture = ctx.on('llm/stream', (wireRequest, next) => {
    if (wireRequest.sessionId === sessionId) {
      capturedRequests.push(projectWireRequest(wireRequest))
    }
    return next()
  })

  try {
    handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installCleanAgentSetup(agentCtx, selection, {
          onPreStep: () => {
            preStepCount += 1
            if (preStepCount !== 1) {
              throw new CleanFeedbackAgentError('clean feedback Agent received an unexpected second pre-step')
            }
            return { kind: 'enter', messages: [cleanMessage] }
          },
          submit: (value, exec) => {
            submitCallCount += 1
            if (submitted !== undefined) {
              failClosed(exec, 'duplicate X feedback interpretation submission')
            }
            const interpretation = parseFeedbackInterpretation(value)
            submitted = interpretation
            exec.concludeTurn()
            return interpretation
          },
        })
      },
    })

    await assertCleanAgentSurface(handle.agent)
    handle.agent.followup(createDriverMessage())
    await waitForCleanAgent(handle.agent, timeoutMs, () => {
      timedOut = true
      handle?.agent.cancel({ kind: 'hook', reason: 'clean feedback timeout' })
    })

    if (timedOut) throw new CleanFeedbackAgentError(`clean feedback Agent timed out after ${timeoutMs}ms`)
    assertCompletedTurn(handle.agent)
    if (preStepCount !== 1) throw new CleanFeedbackAgentError('clean feedback Agent did not enter exactly one pre-step')
    if (submitCallCount !== 1 || submitted === undefined) {
      throw new CleanFeedbackAgentError('clean feedback Agent produced no valid interpretation')
    }
    const interpretation = submitted
    const wire = requireSingleWireRequest(capturedRequests)
    await ctx.sessions.flush(handle.agent.session)
    return { interpretation, sessionId, wire }
  } catch (error: unknown) {
    if (handle !== undefined && handle.agent.status !== 'idle') {
      handle.agent.cancel({ kind: 'hook', reason: 'clean feedback failed' })
    }
    throw error
  } finally {
    disposeWireCapture()
    if (handle !== undefined) await handle.dispose()
  }
}

interface CleanAgentSetupCallbacks {
  onPreStep(): { kind: 'enter'; messages: ReturnType<typeof createCleanFeedbackMessage>[] }
  submit(value: unknown, exec: ToolRunContext): FeedbackInterpretation
}

function installCleanAgentSetup(
  agentCtx: Context,
  selection: ModelSelection,
  callbacks: CleanAgentSetupCallbacks,
): void {
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  installModelSelection(agentCtx, selected)
  agentCtx.systemPrompt.section({
    name: CLEAN_PROMPT_SECTION,
    order: -1_000,
    text: CLEAN_FEEDBACK_SYSTEM_PROMPT,
    complete: true,
  })
  agentCtx.systemPrompt.suppressRuntimeContext()
  agentCtx.tools.restrict({ allow: [] })
  agentCtx.tools.presentAs('native')
  agentCtx.tools.register(createSubmissionTool(callbacks.submit))
  agentCtx.on('agent/pre-step', async () => callbacks.onPreStep(), { prepend: true })
}

function createSubmissionTool(
  submit: (value: unknown, exec: ToolRunContext) => FeedbackInterpretation,
): ToolDefinition {
  return {
    name: SUBMIT_X_FEEDBACK_INTERPRETATION,
    description: SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA.description,
    parameters: SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA.parameters,
    output: {
      schema: SUBMIT_X_FEEDBACK_INTERPRETATION_SCHEMA.parameters,
      render: () => [{ type: 'text', text: '已接收严格结构化反馈。' }],
    },
    execute: async (value, exec) => submit(value, exec),
  }
}

function createDriverMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: 'clean feedback driver' }],
    source: { kind: 'plugin', plugin: 'personal-feed' },
  })
}

async function assertCleanAgentSurface(agent: Agent): Promise<void> {
  const schemas = agent.ctx.tools.schemas(agent)
  if (schemas.length !== 1 || schemas[0]?.name !== SUBMIT_X_FEEDBACK_INTERPRETATION) {
    throw new CleanFeedbackAgentError(
      `clean feedback tool surface is contaminated: ${schemas.map(schema => schema.name).join(', ') || '(none)'}`,
    )
  }

  // The registry assertion above catches capability contamination. This
  // second check catches a global prompt waterfall that tries to inject a
  // model-visible schema after registry projection.
  await assertPromptSurface(agent)
}

async function assertPromptSurface(agent: Agent): Promise<void> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  const sections = assembly.sections
  const toolNames = assembly.tools.map(tool => tool.name)
  if (sections.length !== 1 || sections[0]?.text !== CLEAN_FEEDBACK_SYSTEM_PROMPT) {
    throw new CleanFeedbackAgentError('clean feedback system prompt is not the sole complete prompt')
  }
  if (assembly.contexts.length !== 0) {
    throw new CleanFeedbackAgentError('clean feedback runtime context is not suppressed')
  }
  if (toolNames.length !== 1 || toolNames[0] !== SUBMIT_X_FEEDBACK_INTERPRETATION) {
    throw new CleanFeedbackAgentError(`clean feedback prompt tools are contaminated: ${toolNames.join(', ') || '(none)'}`)
  }
}

function assertCompletedTurn(agent: Agent): void {
  const event = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  if (event === undefined || event.type !== 'turn/end') {
    throw new CleanFeedbackAgentError('clean feedback Agent did not finish a turn')
  }
  if (event.data.reason.kind !== 'completed') {
    const detail = event.data.reason.kind === 'error' ? `: ${event.data.reason.error.message}` : ''
    throw new CleanFeedbackAgentError(`clean feedback Agent turn ended as ${event.data.reason.kind}${detail}`)
  }
}

async function waitForCleanAgent(
  agent: Agent,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(new CleanFeedbackAgentError(`clean feedback Agent timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function resolveTimeout(value: number | undefined): number {
  const timeoutMs = value ?? CLEAN_FEEDBACK_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('clean feedback timeoutMs must be a positive finite number')
  }
  return timeoutMs
}

function resolveModelSelection(ctx: Context, options: CleanFeedbackAgentOptions): ModelSelection {
  if (options.modelSelection !== undefined) return options.modelSelection
  if (options.defaultModelSelection !== undefined) return options.defaultModelSelection()

  const service = (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel')
  if (isDefaultModelSelectionService(service)) return service.currentSelection()
  throw new CleanFeedbackAgentError('clean feedback requires the current default model selection')
}

function isDefaultModelSelectionService(value: unknown): value is DefaultModelSelectionService {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { currentSelection?: unknown }).currentSelection === 'function'
}

function createSubmissionError(message: string): CleanFeedbackAgentError {
  return new CleanFeedbackAgentError(message)
}

function failClosed(exec: ToolRunContext, message: string): never {
  exec.agent?.cancel({ kind: 'hook', reason: message })
  throw createSubmissionError(message)
}

/** Parse and normalize the closed FeedbackInterpretation union at runtime. */
export function parseFeedbackInterpretation(value: unknown): FeedbackInterpretation {
  if (!isPlainRecord(value)) throw createSubmissionError('submitted interpretation must be a plain object')
  const kind = value.kind
  switch (kind) {
    case 'pass':
      requireKeys(value, ['kind', 'reason'])
      if (!isPassReason(value.reason)) throw createSubmissionError('submitted pass reason is invalid')
      return Object.freeze({ kind, reason: value.reason })
    case 'operation':
      requireKeys(value, ['kind', 'operation', 'targetId'])
      if (!isOperation(value.operation) || !isNonEmptyString(value.targetId)) {
        throw createSubmissionError('submitted operation interpretation is invalid')
      }
      return Object.freeze({ kind, operation: value.operation, targetId: value.targetId })
    case 'rating':
      requireKeys(value, ['kind', 'sentiment', 'targetId', 'dimension'], ['reason'])
      if (!isSentiment(value.sentiment) || !isNonEmptyString(value.targetId) || !isDimension(value.dimension)) {
        throw createSubmissionError('submitted rating interpretation is invalid')
      }
      if (value.reason !== undefined && !isNonEmptyString(value.reason)) {
        throw createSubmissionError('submitted rating reason is invalid')
      }
      return Object.freeze({
        kind,
        sentiment: value.sentiment,
        targetId: value.targetId,
        dimension: value.dimension,
        ...value.reason === undefined ? {} : { reason: value.reason },
      })
    case 'reason_answer':
      requireKeys(value, ['kind', 'reason'])
      if (!isNonEmptyString(value.reason)) throw createSubmissionError('submitted reason answer is invalid')
      return Object.freeze({ kind, reason: value.reason })
    case 'prior_reason_reference':
      requireKeys(value, ['kind', 'targetId', 'dimension'])
      if (!isNonEmptyString(value.targetId) || !isDimension(value.dimension)) {
        throw createSubmissionError('submitted prior reason reference is invalid')
      }
      return Object.freeze({ kind, targetId: value.targetId, dimension: value.dimension })
    case 'candidate_reason':
      requireKeys(value, ['kind', 'sentiment', 'targetId', 'dimension', 'candidate'])
      if (!isSentiment(value.sentiment) || !isNonEmptyString(value.targetId)
        || !isDimension(value.dimension) || !isNonEmptyString(value.candidate)) {
        throw createSubmissionError('submitted candidate reason is invalid')
      }
      return Object.freeze({
        kind,
        sentiment: value.sentiment,
        targetId: value.targetId,
        dimension: value.dimension,
        candidate: value.candidate,
      })
    case 'confirm_candidate':
      requireKeys(value, ['kind', 'confirmation'])
      if (!isNonEmptyString(value.confirmation)) throw createSubmissionError('submitted candidate confirmation is invalid')
      return Object.freeze({ kind, confirmation: value.confirmation })
    case 'abandon_pending':
      requireKeys(value, ['kind'])
      return Object.freeze({ kind })
    default:
      throw createSubmissionError('submitted interpretation kind is invalid')
  }
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw createSubmissionError(`submitted interpretation has unknown fields: ${unknown.join(', ')}`)
  if (required.some(key => !Object.hasOwn(value, key))) {
    throw createSubmissionError('submitted interpretation is missing a required field')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPassReason(value: unknown): value is Extract<FeedbackInterpretation, { kind: 'pass' }>['reason'] {
  return value === 'ordinary' || value === 'not_feedback' || value === 'mixed_intent' || value === 'target_ambiguous'
}

function isOperation(value: unknown): value is 'save' | 'unsave' {
  return value === 'save' || value === 'unsave'
}

function isSentiment(value: unknown): value is 'like' | 'dislike' {
  return value === 'like' || value === 'dislike'
}

function isDimension(value: unknown): value is 'content_value' | 'argument_quality' | 'factual_accuracy' {
  return value === 'content_value' || value === 'argument_quality' || value === 'factual_accuracy'
}

function projectWireRequest(request: GenerateOptions): CleanFeedbackWireRequest {
  const projected = {
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    ...request.system === undefined ? {} : { system: request.system },
    ...request.tools === undefined ? {} : { tools: request.tools },
  }
  return structuredClone(projected)
}

/** Extract the only request that may be returned as clean-agent evidence. */
function requireSingleWireRequest(requests: readonly CleanFeedbackWireRequest[]): CleanFeedbackWireRequest {
  if (requests.length !== 1) {
    throw new CleanFeedbackAgentError(
      `clean feedback Agent made ${requests.length} model requests; exactly one is allowed`,
    )
  }
  const [request] = requests
  if (request === undefined) throw new CleanFeedbackAgentError('clean feedback wire request was not captured')
  return request
}
