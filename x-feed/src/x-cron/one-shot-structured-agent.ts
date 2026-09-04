import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk, ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const DEFAULT_ONE_SHOT_STRUCTURED_AGENT_TIMEOUT_MS = 30_000

/** The captured request omits control-only fields such as AbortSignal. */
export interface OneShotStructuredAgentWireRequest {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system: string
  readonly tools: readonly ToolSchema[]
}

export interface OneShotStructuredAgentResult<T> {
  readonly value: T
  readonly sessionId: SessionId
  readonly wire: OneShotStructuredAgentWireRequest
}

export type OneShotStructuredAgentErrorCode =
  | 'invalid-options'
  | 'surface-contaminated'
  | 'invalid-submission'
  | 'timeout'
  | 'aborted'
  | 'stream-failed'
  | 'not-completed'
  | 'missing-submission'
  | 'wrong-request-count'
  | 'outcome-invalid'
  | 'cleanup-failed'

export class OneShotStructuredAgentError extends Error {
  readonly code: OneShotStructuredAgentErrorCode
  readonly wires: readonly OneShotStructuredAgentWireRequest[]

  constructor(
    code: OneShotStructuredAgentErrorCode,
    message: string,
    options: ErrorOptions & { readonly wires?: readonly OneShotStructuredAgentWireRequest[] } = {},
  ) {
    super(message, options)
    this.name = 'OneShotStructuredAgentError'
    this.code = code
    this.wires = Object.freeze([...(options.wires ?? [])])
  }
}

export interface StructuredAgentSurfaceOptions<T> {
  readonly promptSectionName: string
  readonly systemPrompt: string
  readonly toolSchema: ToolSchema
  readonly materialMessage: UserMessage
  readonly parseSubmission: (value: unknown, exec: ToolRunContext) => T
  readonly serializeOutcome: (value: T) => string
  readonly modelSelection?: ModelSelection
}

/** Shared protocol surface for fresh one-shot and scheduler-owned Agents. */
export class OneShotStructuredAgentSurface<T> {
  readonly wires: OneShotStructuredAgentWireRequest[] = []
  readonly toolNames: readonly string[]
  private readonly options: StructuredAgentSurfaceOptions<T>
  private disposeCapture: (() => void) | undefined
  private expectedSessionId: SessionId | undefined
  private agent: Agent | undefined
  private preStepCount = 0
  private submitCount = 0
  private submitted: T | undefined
  private failure: OneShotStructuredAgentError | undefined
  private closed = false

  constructor(options: StructuredAgentSurfaceOptions<T>) {
    this.options = options
    this.toolNames = Object.freeze([options.toolSchema.name])
  }

  get sessionId(): SessionId | undefined { return this.expectedSessionId }
  get failed(): boolean { return this.failure !== undefined }
  get serializedOutcome(): string | undefined {
    return this.submitted === undefined ? undefined : this.options.serializeOutcome(this.submitted)
  }

  setupAgent(agentCtx: Context): void {
    if (this.options.modelSelection !== undefined) {
      installModelSelection(agentCtx, { current: this.options.modelSelection, assembled: undefined })
    }
    agentCtx.systemPrompt.section({ name: this.options.promptSectionName, order: -1_000, text: this.options.systemPrompt, complete: true })
    agentCtx.systemPrompt.suppressRuntimeContext()
    agentCtx.tools.restrict({ allow: [] })
    agentCtx.tools.presentAs('native')
    agentCtx.tools.register({
      name: this.options.toolSchema.name,
      description: this.options.toolSchema.description,
      parameters: this.options.toolSchema.parameters,
      output: {
        schema: this.options.toolSchema.parameters,
        render: () => [{ type: 'text', text: '已接收严格结构化结果。' }],
      },
      execute: async (value, exec) => this.submit(value, exec),
    } satisfies ToolDefinition)
    agentCtx.on('agent/pre-step', async () => {
      this.preStepCount += 1
      if (this.preStepCount !== 1) {
        this.fail('invalid-submission', 'structured Agent received an unexpected second pre-step')
        return { kind: 'reject' as const }
      }
      return { kind: 'enter' as const, messages: [this.options.materialMessage] }
    }, { prepend: true })
  }

  capture(ctx: Context, sessionId: SessionId): void {
    if (this.disposeCapture !== undefined) this.fail('surface-contaminated', 'structured wire capture is already installed')
    if (this.closed) this.fail('surface-contaminated', 'structured wire capture is already closed')
    this.expectedSessionId = sessionId
    this.disposeCapture = ctx.on('llm/stream', (request, next) => {
      if (request.sessionId !== sessionId) return next()
      if (this.closed) return emptyStream()
      // A tool may conclude the turn while a harness-owned internal stream is
      // already queued. Once the DTO is accepted, that follow-up has no
      // business work and must not become a second captured or adapter call.
      if (this.submitted !== undefined) return emptyStream()
      try {
        const wire = projectWireRequest(request)
        this.wires.push(wire)
        this.validateWire(wire)
      } catch (error) {
        this.failure = asStructuredError(error, 'surface-contaminated')
        this.agent?.cancel({ kind: 'hook', reason: this.failure.message })
        return emptyStream()
      }
      return next()
    })
  }

  async verifySurface(agent: Agent): Promise<void> {
    this.agent = agent
    if (this.expectedSessionId === undefined || agent.session.id !== this.expectedSessionId) this.fail('surface-contaminated', 'structured surface is attached to the wrong session')
    const schemas = agent.ctx.tools.schemas(agent)
    if (schemas.length !== 1 || schemas[0]?.name !== this.options.toolSchema.name) this.fail('surface-contaminated', 'structured tool surface is contaminated')
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    if (assembly.sections.length !== 1 || assembly.sections[0]?.text !== this.options.systemPrompt || assembly.contexts.length !== 0 || assembly.tools.length !== 1 || assembly.tools[0]?.name !== this.options.toolSchema.name) {
      this.fail('surface-contaminated', 'structured prompt surface is contaminated')
    }
  }

  finalizeOutcome(outcome: { readonly text: string; readonly error: string | undefined }): T {
    if (outcome.error !== undefined) this.fail('outcome-invalid', `structured Agent outcome failed: ${outcome.error}`)
    if (this.failure !== undefined) throw this.failure
    if (this.preStepCount !== 1) this.fail('outcome-invalid', 'structured Agent did not enter exactly one pre-step')
    if (this.wires.length !== 1) this.fail('wrong-request-count', `structured Agent produced ${this.wires.length} model requests instead of one`)
    if (this.submitCount !== 1 || this.submitted === undefined) this.fail('invalid-submission', 'structured Agent did not produce exactly one valid submission')
    if (outcome.text !== this.options.serializeOutcome(this.submitted)) this.fail('outcome-invalid', 'structured outcome is not the mechanical submitted DTO serialization')
    return this.submitted
  }

  dispose(): void {
    this.closed = true
    this.disposeCapture?.()
    this.disposeCapture = undefined
  }

  private async submit(value: unknown, exec: ToolRunContext): Promise<T> {
    if (this.closed) this.fail('timeout', 'structured Agent submitted after its surface was closed')
    this.submitCount += 1
    if (this.submitCount !== 1) this.failSubmission(exec, 'structured Agent submitted more than once')
    try {
      this.submitted = this.options.parseSubmission(value, exec)
    } catch (error) {
      this.failSubmission(exec, error instanceof Error ? error.message : String(error), error)
    }
    this.appendOutcomeMessage(exec)
    exec.concludeTurn()
    return this.submitted!
  }

  private appendOutcomeMessage(exec: ToolRunContext): void {
    const agent = exec.agent
    const step = agent === undefined
      ? undefined
      : agent.session.snapshotEvents().findLast(event => event.type === 'step/start')
    if (agent === undefined || step === undefined || step.type !== 'step/start' || this.submitted === undefined) {
      this.failSubmission(exec, 'structured Agent cannot record its mechanical DTO outcome')
    }
    const text = this.options.serializeOutcome(this.submitted!)
    agent.session.append('assistant/message', {
      turn: step.data.turn,
      step: step.data.step,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: {
          provider: agent.options.provider ?? 'structured-agent',
          model: agent.options.model ?? 'structured-agent',
        },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
  }

  private failSubmission(exec: ToolRunContext, message: string, cause?: unknown): never {
    try { exec.agent?.cancel({ kind: 'hook', reason: message }) } catch { /* preserve protocol error */ }
    this.failure = new OneShotStructuredAgentError('invalid-submission', message, { cause })
    throw this.failure
  }

  private fail(code: OneShotStructuredAgentErrorCode | 'outcome-invalid', message: string): never {
    this.failure = new OneShotStructuredAgentError(code, message)
    throw this.failure
  }

  private validateWire(wire: OneShotStructuredAgentWireRequest): void {
    if (this.wires.length !== 1 || wire.sessionId !== this.expectedSessionId || wire.system !== this.options.systemPrompt || wire.tools.length !== 1 || wire.tools[0]?.name !== this.options.toolSchema.name || wire.messages.length !== 1 || JSON.stringify(wire.messages[0]) !== JSON.stringify(this.options.materialMessage)) {
      throw new OneShotStructuredAgentError(this.wires.length === 1 ? 'surface-contaminated' : 'wrong-request-count', 'structured wire is not the exact isolated one-request surface')
    }
  }
}

export interface OneShotStructuredAgentOptions<T> {
  readonly ctx: Context
  readonly sessionPrefix: string
  readonly promptSectionName: string
  readonly systemPrompt: string
  readonly inputMessage: UserMessage
  readonly toolName: string
  readonly toolDescription: string
  readonly toolParameters: ToolSchema['parameters']
  readonly parseSubmission: (value: unknown, exec: ToolRunContext) => T
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly modelSelection?: ModelSelection
  readonly defaultModelSelection?: () => ModelSelection
  readonly driverText?: string
}

/**
 * Run one strict structured call in a disposable Agent.
 *
 * The adapter owns no business effects: it only validates the one tool result,
 * concludes the turn, and returns the DTO together with the exact wire. Every
 * invocation gets a new session and a new input message; seed and resume
 * options are deliberately absent from Agent creation.
 */
export async function runOneShotStructuredAgent<T>(
  options: OneShotStructuredAgentOptions<T>,
): Promise<OneShotStructuredAgentResult<T>> {
  const timeoutMs = resolveTimeout(options.timeoutMs)
  const selection = resolveModelSelection(options.ctx, options)
  const sessionId = SessionId(`${options.sessionPrefix}-${randomUUID()}`)
  const toolSchema: ToolSchema = {
    name: options.toolName,
    description: options.toolDescription,
    parameters: options.toolParameters,
  }
  const surface = new OneShotStructuredAgentSurface<T>({
    promptSectionName: options.promptSectionName,
    systemPrompt: options.systemPrompt,
    toolSchema,
    materialMessage: options.inputMessage,
    parseSubmission: options.parseSubmission,
    serializeOutcome: value => JSON.stringify(value),
    modelSelection: selection,
  })
  let handle: AgentHandle | undefined
  let flushed = false
  let flushAttempted = false
  let successResult: OneShotStructuredAgentResult<T> | undefined
  let primaryError: unknown
  let disposeStreamGuard: (() => void) | undefined

  surface.capture(options.ctx, sessionId)
  const deadline = createOneShotOperationDeadline(timeoutMs, options.signal, () => {
    surface.dispose()
    cancelAgent(handle, 'structured Agent total operation deadline expired')
  })

  try {
    deadline.assertActive()
    const creation = options.ctx.agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      signal: deadline.signal,
      setup: agentCtx => surface.setupAgent(agentCtx),
    })
    observeLateHandle(options.ctx, creation, deadline)
    handle = await awaitWithinDeadline(deadline, creation)
    await awaitWithinDeadline(deadline, surface.verifySurface(handle.agent))
    disposeStreamGuard = options.ctx.on('llm/stream', (request, next) => {
      if (request.sessionId !== sessionId) return next()
      return deadline.wrap(next())
    })
    deadline.assertActive()
    handle.agent.followup(createDriverMessage(options.driverText ?? 'structured planner driver'))
    await awaitWithinDeadline(deadline, handle.agent.whenIdle())
    assertCompletedTurn(handle.agent, surface.failed)
    const serializedOutcome = surface.serializedOutcome
    if (serializedOutcome === undefined) throw new OneShotStructuredAgentError('missing-submission', 'structured Agent produced no valid submission')
    const value = surface.finalizeOutcome({ text: serializedOutcome, error: undefined })
    const wire = surface.wires[0]
    if (wire === undefined) throw new OneShotStructuredAgentError('wrong-request-count', 'structured Agent produced no captured wire')
    flushAttempted = true
    await awaitWithinDeadline(deadline, options.ctx.sessions.flush(handle.agent.session))
    flushed = true
    successResult = { value, sessionId, wire }
  } catch (error) {
    primaryError = error
  } finally {
    disposeStreamGuard?.()
    surface.dispose()
    if (handle !== undefined) {
      const cleanup = startAgentCleanup(options.ctx, handle, primaryError, !(flushed || flushAttempted))
      try {
        const cleanupErrors = await awaitWithinDeadline(deadline, cleanup)
        if (cleanupErrors.length > 0) {
          primaryError = createCleanupError(
            primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
            surface.wires,
          )
        }
      } catch (error) {
        if (primaryError === undefined) primaryError = error
      }
    }
    deadline.dispose()
  }

  if (primaryError !== undefined) {
    throw primaryError instanceof Error ? primaryError : new OneShotStructuredAgentError('stream-failed', String(primaryError))
  }
  if (successResult !== undefined) return successResult
  throw new OneShotStructuredAgentError('stream-failed', 'structured Agent ended without a result')
}

function assertCompletedTurn(agent: Agent, invalidSubmission: boolean): void {
  const event = agent.session.snapshotEvents().findLast(value => value.type === 'turn/end')
  if (event === undefined || event.type !== 'turn/end') {
    throw new OneShotStructuredAgentError('not-completed', 'structured Agent did not finish a turn')
  }
  if (event.data.reason.kind !== 'completed') {
    const detail = event.data.reason.kind === 'error' ? `: ${event.data.reason.error.message}` : ''
    throw new OneShotStructuredAgentError(
      event.data.reason.kind === 'aborted' && invalidSubmission ? 'invalid-submission'
        : event.data.reason.kind === 'aborted' ? 'aborted' : 'stream-failed',
      event.data.reason.kind === 'aborted' && invalidSubmission
        ? 'structured Agent turn was cancelled after an invalid submission'
        : `structured Agent turn ended as ${event.data.reason.kind}${detail}`,
    )
  }
}

function startAgentCleanup(
  ctx: Context,
  handle: AgentHandle,
  primaryError: unknown,
  flushRequired: boolean,
): Promise<readonly unknown[]> {
  const errors: unknown[] = []
  try {
    if (handle.agent.status !== 'idle') {
      handle.agent.cancel({ kind: 'hook', reason: primaryError === undefined ? 'structured Agent completed' : 'structured Agent failed' })
    }
  } catch (error) {
    errors.push(error)
  }
  const disposal = observeCleanupTask(() => handle.dispose(), errors)
  const idle = observeCleanupTask(() => handle.agent.whenIdle(), errors)
  const flush = flushRequired
    ? observeCleanupTask(() => ctx.sessions.flush(handle.agent.session), errors)
    : Promise.resolve()
  return Promise.all([disposal, idle, flush]).then(() => Object.freeze(errors))
}

function observeLateHandle(
  ctx: Context,
  creation: Promise<AgentHandle>,
  deadline: OneShotOperationDeadline,
): void {
  void creation.then(handle => {
    if (!deadline.hasFailed) return
    void startAgentCleanup(ctx, handle, new OneShotStructuredAgentError('timeout', 'structured Agent creation settled after its operation deadline'), true)
      .catch(() => undefined)
  }).catch(() => undefined)
}

function observeCleanupTask(
  start: () => PromiseLike<unknown>,
  errors: unknown[],
): Promise<void> {
  try {
    const task = Promise.resolve(start())
    return task.then(
      () => undefined,
      error => { errors.push(error) },
    )
  } catch (error) {
    errors.push(error)
    return Promise.resolve()
  }
}

function cancelAgent(handle: AgentHandle | undefined, reason: string): void {
  try {
    handle?.agent.cancel({ kind: 'hook', reason })
  } catch {
    // A deadline must preserve its primary error when best-effort cancellation fails.
  }
}

function createCleanupError(
  cleanupErrors: readonly unknown[],
  wires: readonly OneShotStructuredAgentWireRequest[],
): OneShotStructuredAgentError {
  return new OneShotStructuredAgentError('cleanup-failed', 'structured Agent cleanup failed', {
    cause: new AggregateError(cleanupErrors, 'structured Agent cleanup failed'),
    wires,
  })
}

function resolveTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_ONE_SHOT_STRUCTURED_AGENT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('structured Agent timeoutMs must be a positive safe integer')
  return timeoutMs
}

function resolveModelSelection(ctx: Context, options: OneShotStructuredAgentOptions<unknown>): ModelSelection {
  if (options.modelSelection !== undefined) return options.modelSelection
  if (options.defaultModelSelection !== undefined) return options.defaultModelSelection()
  const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.('agentDefaultModel')
  if (isModelSelectionService(service)) return service.currentSelection()
  throw new OneShotStructuredAgentError('invalid-options', 'structured Agent requires the current default model selection')
}

function isModelSelectionService(value: unknown): value is { currentSelection(): ModelSelection } {
  return typeof value === 'object' && value !== null && typeof (value as { currentSelection?: unknown }).currentSelection === 'function'
}

function projectWireRequest(request: GenerateOptions): OneShotStructuredAgentWireRequest {
  if (request.sessionId === undefined || request.system === undefined || request.tools === undefined) {
    throw new OneShotStructuredAgentError('surface-contaminated', 'structured wire omitted its system prompt or tool schema')
  }
  return structuredClone({
    sessionId: request.sessionId,
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    system: request.system,
    tools: request.tools,
  })
}

function createDriverMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'x-feed' },
  })
}

function createAbortError(reason: unknown): OneShotStructuredAgentError {
  return new OneShotStructuredAgentError('aborted', reason instanceof Error ? reason.message : 'structured Agent was aborted')
}

interface OneShotOperationDeadline {
  readonly signal: AbortSignal
  readonly hasFailed: boolean
  readonly failure: Promise<never>
  readonly wrap: (source: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  readonly assertActive: () => void
  readonly dispose: () => void
}

function createOneShotOperationDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  closeSurfaceAndCancel: () => void,
): OneShotOperationDeadline {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failureError: OneShotStructuredAgentError | undefined
  let rejectFailure: (error: OneShotStructuredAgentError) => void = () => {}
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
  void failure.catch(() => undefined)

  const fail = (error: OneShotStructuredAgentError): void => {
    if (disposed) return
    disposed = true
    failureError = error
    try { closeSurfaceAndCancel() } catch { /* deadline failure must still reject */ }
    controller.abort(error)
    rejectFailure(error)
  }
  const onAbort = (): void => fail(createAbortError(signal?.reason))
  if (signal?.aborted) onAbort()
  else if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  if (!disposed) {
    timer = setTimeout(() => fail(new OneShotStructuredAgentError('timeout', `structured Agent timed out after ${timeoutMs}ms`)), timeoutMs)
  }

  return {
    signal: controller.signal,
    get hasFailed(): boolean { return failureError !== undefined },
    failure,
    wrap: source => wrapOneShotStream(source, failure),
    assertActive: (): void => {
      if (failureError !== undefined) throw failureError
    },
    dispose: () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

function awaitWithinDeadline<T>(deadline: OneShotOperationDeadline, source: PromiseLike<T>): Promise<T> {
  const observed = Promise.resolve(source)
  void observed.catch(() => undefined)
  return Promise.race([observed, deadline.failure])
}

function wrapOneShotStream(
  source: AsyncIterable<StreamChunk>,
  failure: Promise<never>,
): AsyncIterable<StreamChunk> {
  const sourceIterator = source[Symbol.asyncIterator]()
  let closed = false

  const closeSource = (): void => {
    if (closed) return
    closed = true
    try {
      const closing = sourceIterator.return?.()
      if (closing !== undefined) void Promise.resolve(closing).catch(() => undefined)
    } catch {
      // The stream is already failing; a best-effort close must not replace it.
    }
  }

  const iterator: AsyncIterableIterator<StreamChunk> = {
    next: () => {
      if (closed) return Promise.resolve({ done: true, value: undefined })
      let pending: Promise<IteratorResult<StreamChunk>>
      try {
        pending = Promise.resolve(sourceIterator.next())
      } catch (error) {
        return Promise.reject(error)
      }
      void pending.catch(() => undefined)
      return Promise.race([pending, failure]).catch(error => {
        closeSource()
        throw error
      })
    },
    return: () => {
      closeSource()
      return Promise.resolve({ done: true, value: undefined })
    },
    [Symbol.asyncIterator]() { return this },
  }
  return iterator
}

async function* emptyStream(): AsyncIterable<never> {
  // Stopping the waterfall here prevents the adapter from being reached.
}

function asStructuredError(error: unknown, fallback: OneShotStructuredAgentErrorCode): OneShotStructuredAgentError {
  if (error instanceof OneShotStructuredAgentError) return error
  return new OneShotStructuredAgentError(fallback, error instanceof Error ? error.message : String(error), { cause: error })
}
