import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { deepFreeze, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  createProjectionFailure,
  validateCandidateFactAssessmentRequest,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type CandidateFactAssessmentAudit,
  type CandidateFactAssessmentPort,
  type CandidateFactAssessmentRequest,
  type LocatorAssessmentDecision,
  type ProjectionFailure,
  type ProjectionNotReady,
} from '../fact-projection/contracts.ts'
import { fingerprintCandidate } from '../fact-projection/project-candidate-facts.ts'
import type { FactDimension } from '../trusted-facts/model.ts'
import type { NavigationItem, NavigationSnapshot } from '../trusted-facts/navigation-contract.ts'
import {
  createCandidateNavigationRecall,
  type CandidateNavigationRecall,
  type CandidateNavigationRecallFailure,
  type CandidateNavigationRecallSuccess,
} from './navigation-recall.ts'

/** The single model-facing tool in one semantic candidate assessment segment. */
export const SUBMIT_X_CRON_ASSESSMENT = 'submit_x_cron_candidate_assessment'

/** Stable policy identity recorded in every audit. */
export const X_CRON_ASSESSMENT_POLICY_ID = 'x-cron-neutral-navigation-two-stage'
export const X_CRON_ASSESSMENT_POLICY_VERSION = '1'

/** Fixed limits are per segment, not a proxy for a total-token budget. */
export const DEFAULT_MAX_ITEMS_PER_SEGMENT = 8
export const DEFAULT_MAX_SEGMENT_SERIALIZED_BYTES = 12_000
export const DEFAULT_MAX_CANDIDATE_UTF8_BYTES = 8_000
export const DEFAULT_MAX_REASON_UTF8_BYTES = 2_000
export const DEFAULT_ASSESSMENT_TIMEOUT_MS = 30_000

const ASSESSMENT_SYSTEM_PROMPT = [
  '你是一次性 X 候选事实相关性 assessment Agent。',
  '这是一个两阶段流程：主机先用中立精确 key 定位，本轮只判断已经召回的导航段。',
  '你只能依据当前 user message 中的候选和当前导航段作判断，不得读取、猜测或延续其他会话、事实正文、反馈、偏好、图谱或原始历史。',
  `必须调用 ${SUBMIT_X_CRON_ASSESSMENT} 一次，提交当前段每一个 locator 的严格结构化 decision；不要输出普通文本。`,
  '不要把导航主题、对象或关系当成用户态度；这里只报告本轮候选与事实是否值得进入投影。',
].join('\n')

const ASSESSMENT_USER_PREFIX = '当前 X 候选事实 assessment 段（仅处理以下 JSON）：'

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locatorId: { type: 'string' },
    relevance: { type: 'string', enum: ['high', 'low_confidence', 'unrelated'] },
    essentiality: { type: 'string', enum: ['inline_priority', 'lookup_only'] },
    priority: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['locatorId', 'relevance', 'essentiality', 'priority', 'reason'],
} as const

/** Strict model-facing schema; no free-form output or unknown fields. */
export const SUBMIT_X_CRON_ASSESSMENT_SCHEMA: ToolSchema = {
  name: SUBMIT_X_CRON_ASSESSMENT,
  description: '提交当前导航段每个 locator 的严格事实相关性 assessment。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      decisions: { type: 'array', items: decisionSchema },
    },
    required: ['decisions'],
  },
}

export interface AssessmentAgentOptions {
  readonly timeoutMs?: number
  readonly modelSelection?: ModelSelection
  readonly defaultModelSelection?: () => ModelSelection
  readonly maxItemsPerSegment?: number
  /** Preferred spelling for the fixed segment byte limit. */
  readonly maxSegmentSerializedBytes?: number
  /** Backwards-compatible short spelling used by composition tests. */
  readonly maxSerializedBytes?: number
  readonly maxCandidateUtf8Bytes?: number
  readonly maxReasonUtf8Bytes?: number
}

export interface AssessmentPrimeOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface AssessmentSegment {
  readonly segmentId: string
  readonly locatorIds: readonly string[]
  readonly items: readonly NavigationItem[]
  readonly serialized: string
  readonly serializedBytes: number
}

/** The actual model request, with control-only fields removed. */
export interface AssessmentWireRequest {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system: string
  readonly tools: readonly ToolSchema[]
}

export interface AssessmentSegmentEvidence {
  readonly segment: AssessmentSegment
  readonly wire: AssessmentWireRequest
}

export interface AssessmentAgentPrimeSuccess {
  readonly kind: 'ready'
  readonly assessment: CandidateFactAssessment
  readonly recall: CandidateNavigationRecallSuccess
  readonly segments: readonly AssessmentSegment[]
  readonly wires: readonly AssessmentWireRequest[]
  readonly evidence: readonly AssessmentSegmentEvidence[]
}

export type AssessmentAgentErrorCode =
  | 'invalid-request'
  | 'recall-failure'
  | 'navigation-mismatch'
  | 'candidate-too-large'
  | 'segment-item-too-large'
  | 'segment-too-large'
  | 'invalid-submission'
  | 'stream-failed'
  | 'timeout'
  | 'aborted'
  | 'surface-contaminated'
  | 'cleanup-failed'
  | 'cache-mismatch'

/** Stable fail-closed boundary for setup, wire, model, and cleanup errors. */
export class CandidateFactAssessmentAgentError extends Error {
  readonly code: AssessmentAgentErrorCode
  readonly errors: readonly unknown[]
  readonly failure: ProjectionFailure | undefined
  readonly wires: readonly AssessmentWireRequest[]

  constructor(
    code: AssessmentAgentErrorCode,
    message: string,
    options: ErrorOptions & {
      readonly errors?: readonly unknown[]
      readonly failure?: ProjectionFailure
      readonly wires?: readonly AssessmentWireRequest[]
    } = {},
  ) {
    super(message, options)
    this.name = 'CandidateFactAssessmentAgentError'
    this.code = code
    this.errors = Object.freeze([...(options.errors ?? [])])
    this.failure = options.failure
    this.wires = Object.freeze([...(options.wires ?? [])])
  }
}

interface ResolvedLimits {
  readonly timeoutMs: number
  readonly maxItemsPerSegment: number
  readonly maxSegmentSerializedBytes: number
  readonly maxCandidateUtf8Bytes: number
  readonly maxReasonUtf8Bytes: number
}

interface CachedAssessment {
  readonly key: string
  readonly result: AssessmentAgentPrimeSuccess
}

interface SegmentRunResult {
  readonly decisions: readonly LocatorAssessmentDecision[]
  readonly wire: AssessmentWireRequest
}

interface SubmissionCallbacks {
  submit(value: unknown, exec: ToolRunContext): readonly LocatorAssessmentDecision[]
  preStep(): { kind: 'enter'; messages: ReturnType<typeof createAssessmentMessage>[] }
}

/**
 * Production adapter for TODO 5's synchronous assessment port.
 *
 * `prime()` is the only asynchronous boundary.  It pins one neutral navigation
 * snapshot, runs independent fresh Agents for recalled segments, and publishes
 * one exact cache entry only after every Agent has been cleaned up.  `assess()`
 * is deliberately synchronous so the TODO 5 projector contract remains pure
 * from its point of view.
 */
export class ProductionCandidateFactAssessmentPort implements CandidateFactAssessmentPort {
  readonly sourceRevision: NavigationSnapshot['sourceRevision']
  readonly navigation: NavigationSnapshot
  readonly #ctx: Context
  readonly #recall: CandidateNavigationRecall
  readonly #selection: ModelSelection | undefined
  readonly #defaultSelection: (() => ModelSelection) | undefined
  readonly #limits: ResolvedLimits
  #cache: CachedAssessment | undefined
  #primeGeneration = 0

  constructor(
    ctx: Context,
    pinnedNavigation: NavigationSnapshot,
    options: AssessmentAgentOptions = {},
  ) {
    if (!isContextLike(ctx)) throw new TypeError('Assessment Agent requires a Harness Context object.')
    const built = createCandidateNavigationRecall(pinnedNavigation)
    if (built.kind !== 'ready') throw new CandidateFactAssessmentAgentError(
      'recall-failure',
      built.message,
      { failure: recallFailureProjection(built) },
    )
    this.#ctx = ctx
    this.#recall = built.index
    this.navigation = Object.freeze(pinNavigationForAdapter(pinnedNavigation))
    this.sourceRevision = this.navigation.sourceRevision
    this.#selection = options.modelSelection
    this.#defaultSelection = options.defaultModelSelection
    this.#limits = resolveLimits(options)
  }

  /** Readiness probe used by TODO 5 preflight; this never starts a model run. */
  checkReadiness(): { readonly ready: true } | { readonly ready: false; readonly message: string } {
    const missingSurface = findMissingAssessmentSurface(this.#ctx)
    if (missingSurface !== undefined) return { ready: false, message: missingSurface }
    try {
      resolveModelSelection(this.#ctx, this.#selection, this.#defaultSelection)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ready: false, message: `X assessment model route is unavailable: ${message}` }
    }
    return { ready: true }
  }

  /**
   * Precompute one exact assessment. Failures throw a typed error and clear the
   * cache; callers must not invoke the synchronous port until this resolves.
   */
  async prime(
    requestValue: CandidateFactAssessmentRequest,
    options: AssessmentPrimeOptions = {},
  ): Promise<AssessmentAgentPrimeSuccess> {
    const generation = ++this.#primeGeneration
    this.#cache = undefined
    const request = validateRequest(requestValue, this.navigation)
    if (request.kind === 'failure') throw request.error

    const limits = options.timeoutMs === undefined
      ? this.#limits
      : { ...this.#limits, timeoutMs: options.timeoutMs }
    if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
      throw new RangeError('assessment timeoutMs must be a positive safe integer')
    }
    if (options.signal?.aborted) throw createAbortError(options.signal.reason)
    const recallResult = this.#recall.recall(deriveRecallRequest(request.candidate, this.sourceRevision))
    if (recallResult.kind === 'recall-failure') throw createRecallError(recallResult)

    const segmentLimit = Math.min(limits.maxSegmentSerializedBytes, request.budget.maxSerializedBytes)
    const materialLimits = segmentLimit === limits.maxSegmentSerializedBytes
      ? limits
      : { ...limits, maxSegmentSerializedBytes: segmentLimit }
    const segments = buildSegments(request.candidate, recallResult, materialLimits)
    if (segments.kind === 'failure') throw segments.error

    // Resolve the model route once for this prime.  Every segment remains a
    // fresh Agent, but a changing default selection cannot make one exact
    // request produce mixed provider/model evidence.
    const selection = segments.value.length === 0
      ? undefined
      : resolveModelSelection(this.#ctx, this.#selection, this.#defaultSelection)
    const capturedRequests: AssessmentWireRequest[] = []
    const evidence: AssessmentSegmentEvidence[] = []
    const semanticDecisions: LocatorAssessmentDecision[] = []
    const errors: CandidateFactAssessmentAgentError[] = []
    for (const segment of segments.value) {
      if (options.signal?.aborted) {
        errors.push(createAbortError(options.signal.reason))
        break
      }
      try {
        const result = await this.#runSegment(
          request.candidate,
          segment,
          limits,
          options.signal,
          selection as ModelSelection,
          capturedRequests,
        )
        semanticDecisions.push(...result.decisions)
        evidence.push({ segment, wire: result.wire })
      } catch (error) {
        const typed = toAssessmentError(error, 'invalid-submission')
        errors.push(typed)
        if (typed.code === 'aborted' || typed.code === 'timeout') break
      }
    }

    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, 'One or more assessment segments failed.')
      const first = errors[0]!
      throw new CandidateFactAssessmentAgentError(
        first.code,
        aggregate.message,
        { cause: aggregate, errors, wires: capturedRequests },
      )
    }

    if (generation !== this.#primeGeneration) {
      throw new CandidateFactAssessmentAgentError(
        'cache-mismatch',
        'Assessment prime was superseded by a newer prime on the same pinned port.',
      )
    }

    const assessment = createAssessment(request.candidate, this.navigation.items, semanticDecisions)
    const result: AssessmentAgentPrimeSuccess = Object.freeze({
      kind: 'ready',
      assessment,
      recall: recallResult,
      segments: Object.freeze([...segments.value]),
      wires: Object.freeze([...capturedRequests]),
      evidence: Object.freeze([...evidence]),
    })
    this.#cache = Object.freeze({ key: request.key, result })
    return result
  }

  /** Return only a result that came from the exact prior `prime()` request. */
  assess(
    requestValue: CandidateFactAssessmentRequest,
  ): CandidateFactAssessment | ProjectionNotReady | ProjectionFailure {
    const request = validateRequest(requestValue, this.navigation)
    if (request.kind === 'failure') return request.error.failure ?? createProjectionFailure(
      'unrepresentable',
      request.error.message,
    )
    if (this.#cache === undefined || this.#cache.key !== request.key) {
      return createProjectionFailure(
        'unrepresentable',
        'Candidate fact assessment has not been primed for this exact candidate, navigation, and budget.',
      )
    }
    return this.#cache.result.assessment
  }

  async #runSegment(
    candidate: CandidateDescriptor,
    segment: AssessmentSegment,
    limits: ResolvedLimits,
    signal: AbortSignal | undefined,
    selection: ModelSelection,
    capturedRequests: AssessmentWireRequest[],
  ): Promise<SegmentRunResult> {
    const sessionId = SessionId(`session-x-assessment-${randomUUID()}`)
    let handle: AgentHandle | undefined
    let preStepCount = 0
    let submitted: readonly LocatorAssessmentDecision[] | undefined
    let submitCount = 0
    let invalidSubmission = false
    let timedOut = false
    const segmentWireRequests: AssessmentWireRequest[] = []
    const captureSegmentWire = this.#ctx.on('llm/stream', (wireRequest, next) => {
      if (wireRequest.sessionId === sessionId) {
        const projected = projectWireRequest(wireRequest)
        segmentWireRequests.push(projected)
        capturedRequests.push(projected)
      }
      return next()
    })

    let primaryError: unknown
    try {
      handle = await this.#ctx.agents.create({
        sessionId,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installAssessmentSetup(agentCtx, selection, {
            preStep: () => {
              preStepCount += 1
              if (preStepCount !== 1) throw new CandidateFactAssessmentAgentError(
                'invalid-submission',
                'Assessment Agent received an unexpected second pre-step.',
              )
              return { kind: 'enter', messages: [createAssessmentMessage(candidate, segment.items)] }
            },
            submit: (value, exec) => {
              submitCount += 1
              if (submitCount !== 1) {
                invalidSubmission = true
                failClosed(exec, 'Assessment Agent submitted more than once.')
              }
              let decisions: readonly LocatorAssessmentDecision[]
              try {
                decisions = parseAssessmentSubmission(value, segment.locatorIds, limits.maxReasonUtf8Bytes, exec)
              } catch (error) {
                invalidSubmission = true
                throw error
              }
              submitted = decisions
              exec.concludeTurn()
              return decisions
            },
          })
        },
      })

      await assertAssessmentSurface(handle.agent)
      handle.agent.followup(createDriverMessage())
      await waitForAssessmentAgent(handle.agent, limits.timeoutMs, signal, () => {
        timedOut = true
        handle?.agent.cancel({ kind: 'hook', reason: 'X assessment timeout' })
      })
      if (timedOut) throw new CandidateFactAssessmentAgentError(
        'timeout',
        `Assessment Agent timed out after ${limits.timeoutMs}ms.`,
      )
      assertCompletedTurn(handle.agent)
      if (preStepCount !== 1 || submitCount !== 1 || submitted === undefined) {
        throw new CandidateFactAssessmentAgentError(
          'invalid-submission',
          'Assessment Agent did not produce exactly one valid segment submission.',
        )
      }
      if (segmentWireRequests.length !== 1) {
        throw new CandidateFactAssessmentAgentError(
          'invalid-submission',
          `Assessment segment produced ${segmentWireRequests.length} model requests instead of one.`,
          { wires: segmentWireRequests },
        )
      }
      assertAssessmentWireSurface(segmentWireRequests[0]!, segment)
    } catch (error) {
      primaryError = error
    } finally {
      captureSegmentWire()
    }

    const cleanupErrors = await cleanupAgent(this.#ctx, handle, primaryError)
    if (cleanupErrors.length > 0) {
      throw new CandidateFactAssessmentAgentError(
        'cleanup-failed',
        'Assessment Agent cleanup did not complete all required stages.',
        {
          cause: new AggregateError(cleanupErrors, 'Assessment cleanup failed.'),
          errors: cleanupErrors,
          wires: segmentWireRequests,
        },
      )
    }
    if (primaryError !== undefined) {
      throw normalizeSegmentError(primaryError, invalidSubmission, segmentWireRequests)
    }
    return { decisions: submitted as readonly LocatorAssessmentDecision[], wire: segmentWireRequests[0]! }
  }
}

/** Factory spelling for composition roots. */
export function createCandidateFactAssessmentPort(
  ctx: Context,
  pinnedNavigation: NavigationSnapshot,
  options: AssessmentAgentOptions = {},
): ProductionCandidateFactAssessmentPort {
  return new ProductionCandidateFactAssessmentPort(ctx, pinnedNavigation, options)
}

/** Explicit X naming aliases keep integration code readable without duplicate adapters. */
export const XCandidateFactAssessmentPort = ProductionCandidateFactAssessmentPort
export const CandidateFactAssessmentAgent = ProductionCandidateFactAssessmentPort

function validateRequest(
  value: unknown,
  pinnedNavigation: NavigationSnapshot,
): { readonly kind: 'ready'; readonly candidate: CandidateDescriptor; readonly budget: CandidateFactAssessmentRequest['budget']; readonly navigation: readonly NavigationItem[]; readonly key: string } | { readonly kind: 'failure'; readonly error: CandidateFactAssessmentAgentError } {
  const validated = validateCandidateFactAssessmentRequest(value)
  if (!validated.ok) {
    return { kind: 'failure', error: new CandidateFactAssessmentAgentError('invalid-request', validated.message) }
  }
  const navigation = flattenNavigation(validated.value.navigation)
  if (JSON.stringify(navigation) !== JSON.stringify(pinnedNavigation.items)) {
    return {
      kind: 'failure',
      error: new CandidateFactAssessmentAgentError(
        'navigation-mismatch',
        'Assessment request navigation is not the exact pinned navigation snapshot.',
      ),
    }
  }
  const key = JSON.stringify([validated.value.candidate, navigation, validated.value.budget])
  return {
    kind: 'ready',
    candidate: validated.value.candidate,
    navigation,
    budget: validated.value.budget,
    key,
  }
}

function deriveRecallRequest(
  candidate: CandidateDescriptor,
  sourceRevision: NavigationSnapshot['sourceRevision'],
): {
  readonly sourceRevision: NavigationSnapshot['sourceRevision']
  readonly targetIds: readonly string[]
  readonly canonicalSources: readonly string[]
  readonly topics: readonly string[]
  readonly relationKeys: readonly string[]
  readonly dimensions: readonly FactDimension[]
} {
  const canonicalSource = canonicalXStatusSource(candidate.source)
  const reliableTargetId = isCanonicalRecallText(candidate.id) ? candidate.id : undefined
  return {
    sourceRevision,
    targetIds: reliableTargetId === undefined ? [] : [reliableTargetId],
    canonicalSources: canonicalSource === undefined ? [] : [canonicalSource],
    topics: [],
    relationKeys: reliableTargetId === undefined ? [] : [`about-target:${reliableTargetId}`],
    dimensions: [],
  }
}

function buildSegments(
  candidate: CandidateDescriptor,
  recall: CandidateNavigationRecallSuccess,
  limits: ResolvedLimits,
): { readonly kind: 'ready'; readonly value: readonly AssessmentSegment[] } | { readonly kind: 'failure'; readonly error: CandidateFactAssessmentAgentError } {
  const candidateBytes = utf8Bytes(JSON.stringify({ id: candidate.id, content: candidate.content, source: candidate.source }))
  if (candidateBytes > limits.maxCandidateUtf8Bytes) {
    return {
      kind: 'failure',
      error: new CandidateFactAssessmentAgentError(
        'candidate-too-large',
        `Candidate material is ${candidateBytes} UTF-8 bytes; the fixed limit is ${limits.maxCandidateUtf8Bytes}.`,
      ),
    }
  }
  const segments: AssessmentSegment[] = []
  let current: NavigationItem[] = []
  for (const item of recall.navigation) {
    if (utf8Bytes(JSON.stringify(item)) > limits.maxSegmentSerializedBytes) {
      return {
        kind: 'failure',
        error: new CandidateFactAssessmentAgentError(
          'segment-item-too-large',
          `Navigation item ${item.locator.locatorId} exceeds the fixed segment byte limit.`,
        ),
      }
    }
    const candidateItems = [...current, item]
    const candidateSerialized = serializeAssessmentMaterial(candidate, candidateItems)
    if (current.length > 0 && (current.length >= limits.maxItemsPerSegment
      || utf8Bytes(candidateSerialized) > limits.maxSegmentSerializedBytes)) {
      segments.push(createSegment(segments.length, candidate, current))
      current = [item]
      const oneSerialized = serializeAssessmentMaterial(candidate, current)
      if (utf8Bytes(oneSerialized) > limits.maxSegmentSerializedBytes) {
        return {
          kind: 'failure',
          error: new CandidateFactAssessmentAgentError(
            'segment-too-large',
            `Navigation item ${item.locator.locatorId} cannot fit in a single assessment segment.`,
          ),
        }
      }
      continue
    }
    current.push(item)
    if (utf8Bytes(candidateSerialized) > limits.maxSegmentSerializedBytes) {
      return {
        kind: 'failure',
        error: new CandidateFactAssessmentAgentError(
          'segment-too-large',
          `Assessment segment cannot fit the fixed serialized byte limit.`,
        ),
      }
    }
  }
  if (current.length > 0) segments.push(createSegment(segments.length, candidate, current))
  return { kind: 'ready', value: Object.freeze(segments) }
}

function createSegment(index: number, candidate: CandidateDescriptor, items: readonly NavigationItem[]): AssessmentSegment {
  const serialized = serializeAssessmentMaterial(candidate, items)
  const locatorIds = [...items].map(item => item.locator.locatorId)
  return Object.freeze({
    segmentId: `assessment-segment-${index + 1}`,
    locatorIds: Object.freeze(locatorIds),
    items: Object.freeze([...items]),
    serialized,
    serializedBytes: utf8Bytes(serialized),
  })
}

function serializeAssessmentMaterial(candidate: CandidateDescriptor, items: readonly NavigationItem[]): string {
  return `${ASSESSMENT_USER_PREFIX}\n${JSON.stringify({
    candidate: { id: candidate.id, content: candidate.content, source: candidate.source },
    navigation: items,
  })}`
}

function createAssessmentMessage(candidate: CandidateDescriptor, items: readonly NavigationItem[]) {
  const serialized = serializeAssessmentMaterial(candidate, items)
  return freezeMessage({
    id: stableMessageId(`assessment:${serialized}`),
    role: 'user',
    content: [{ type: 'text', text: serialized }],
    source: { kind: 'plugin', plugin: 'x-feed' },
  })
}

function createDriverMessage() {
  return freezeMessage({
    id: stableMessageId('driver'),
    role: 'user',
    content: [{ type: 'text', text: 'assessment driver' }],
    source: { kind: 'plugin', plugin: 'x-feed' },
  })
}

function createAssessment(
  candidate: CandidateDescriptor,
  fullNavigation: readonly NavigationItem[],
  semanticDecisions: readonly LocatorAssessmentDecision[],
): CandidateFactAssessment {
  const recalled = new Map(semanticDecisions.map(decision => [decision.locatorId, decision]))
  const decisions = fullNavigation.map(item => recalled.get(item.locator.locatorId) ?? {
    locatorId: item.locator.locatorId,
    relevance: 'unrelated' as const,
    essentiality: 'lookup_only' as const,
    priority: 0,
    reason: 'neutral-key-closure-miss',
  })
  const audit: CandidateFactAssessmentAudit = Object.freeze({
    policyId: X_CRON_ASSESSMENT_POLICY_ID,
    policyVersion: X_CRON_ASSESSMENT_POLICY_VERSION,
    candidateFingerprint: fingerprintCandidate(candidate),
    decisions: Object.freeze(decisions),
  })
  return Object.freeze({ candidate, audit })
}

function installAssessmentSetup(
  agentCtx: Context,
  selection: ModelSelection,
  callbacks: SubmissionCallbacks,
): void {
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  installModelSelection(agentCtx, selected)
  agentCtx.systemPrompt.section({
    name: 'x-cron:assessment-system',
    order: -1_000,
    text: ASSESSMENT_SYSTEM_PROMPT,
    complete: true,
  })
  agentCtx.systemPrompt.suppressRuntimeContext()
  agentCtx.tools.restrict({ allow: [] })
  agentCtx.tools.presentAs('native')
  agentCtx.tools.register(createAssessmentSubmissionTool(callbacks.submit))
  agentCtx.on('agent/pre-step', async () => callbacks.preStep(), { prepend: true })
}

function createAssessmentSubmissionTool(
  submit: (value: unknown, exec: ToolRunContext) => readonly LocatorAssessmentDecision[],
): ToolDefinition {
  return {
    name: SUBMIT_X_CRON_ASSESSMENT,
    description: SUBMIT_X_CRON_ASSESSMENT_SCHEMA.description,
    parameters: SUBMIT_X_CRON_ASSESSMENT_SCHEMA.parameters,
    output: {
      schema: SUBMIT_X_CRON_ASSESSMENT_SCHEMA.parameters,
      render: () => [{ type: 'text', text: '已接收当前 assessment 段的严格 decision。' }],
    },
    execute: async (value, exec) => {
      const result = submit(value, exec)
      return { decisions: result }
    },
  }
}

function parseAssessmentSubmission(
  value: unknown,
  expectedLocatorIds: readonly string[],
  maxReasonUtf8Bytes: number,
  exec: ToolRunContext,
): readonly LocatorAssessmentDecision[] {
  if (!isRecord(value) || !hasExactKeys(value, ['decisions']) || !Array.isArray(value.decisions)) {
    return failClosed(exec, 'Assessment submission must contain exactly a decisions array.')
  }
  const expected = new Set(expectedLocatorIds)
  const seen = new Set<string>()
  const decisions: LocatorAssessmentDecision[] = []
  for (const raw of value.decisions) {
    if (!isRecord(raw) || !hasExactKeys(raw, ['locatorId', 'relevance', 'essentiality', 'priority', 'reason'])
      || !isNonEmptyString(raw.locatorId) || seen.has(raw.locatorId)
      || !isRelevance(raw.relevance) || !isEssentiality(raw.essentiality)
      || !isNonNegativeInteger(raw.priority) || !isNonEmptyString(raw.reason)
      || utf8Bytes(raw.reason) > maxReasonUtf8Bytes
      || (raw.relevance === 'unrelated' && raw.essentiality !== 'lookup_only')
      || (raw.relevance === 'low_confidence' && raw.essentiality !== 'lookup_only')) {
      return failClosed(exec, 'Assessment submission contains an invalid or forbidden decision.')
    }
    if (!expected.has(raw.locatorId)) return failClosed(exec, `Assessment submission named unknown locator ${raw.locatorId}.`)
    seen.add(raw.locatorId)
    decisions.push({
      locatorId: raw.locatorId,
      relevance: raw.relevance,
      essentiality: raw.essentiality,
      priority: raw.priority,
      reason: raw.reason,
    })
  }
  if (seen.size !== expected.size || [...expected].some(locatorId => !seen.has(locatorId))) {
    return failClosed(exec, 'Assessment submission must cover every and only current segment locator.')
  }
  decisions.sort((left, right) => left.locatorId < right.locatorId ? -1 : left.locatorId > right.locatorId ? 1 : 0)
  return Object.freeze(decisions)
}

function failClosed(exec: ToolRunContext, message: string): never {
  exec.agent?.cancel({ kind: 'hook', reason: message })
  throw new CandidateFactAssessmentAgentError('invalid-submission', message)
}

async function assertAssessmentSurface(agent: Agent): Promise<void> {
  const schemas = agent.ctx.tools.schemas(agent)
  if (schemas.length !== 1 || schemas[0]?.name !== SUBMIT_X_CRON_ASSESSMENT) {
    throw new CandidateFactAssessmentAgentError(
      'surface-contaminated',
      `Assessment tool surface is contaminated: ${schemas.map(schema => schema.name).join(', ') || '(none)'}`,
    )
  }
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  if (assembly.sections.length !== 1 || assembly.sections[0]?.text !== ASSESSMENT_SYSTEM_PROMPT) {
    throw new CandidateFactAssessmentAgentError('surface-contaminated', 'Assessment system prompt is not the sole complete prompt.')
  }
  if (assembly.contexts.length !== 0) {
    throw new CandidateFactAssessmentAgentError('surface-contaminated', 'Assessment runtime context is not suppressed.')
  }
  if (assembly.tools.length !== 1 || assembly.tools[0]?.name !== SUBMIT_X_CRON_ASSESSMENT) {
    throw new CandidateFactAssessmentAgentError('surface-contaminated', 'Assessment prompt tools are contaminated.')
  }
}

function assertAssessmentWireSurface(
  wire: AssessmentWireRequest,
  segment: AssessmentSegment,
): void {
  if (wire.system !== ASSESSMENT_SYSTEM_PROMPT
    || wire.tools.length !== 1
    || wire.tools[0]?.name !== SUBMIT_X_CRON_ASSESSMENT
    || wire.messages.length !== 1) {
    throw new CandidateFactAssessmentAgentError(
      'surface-contaminated',
      'Assessment wire contains a non-isolated prompt, tool, or message surface.',
      { wires: [wire] },
    )
  }
  const message = wire.messages[0]
  const block = message?.content.length === 1 ? message.content[0] : undefined
  if (message?.role !== 'user' || block?.type !== 'text' || block.text !== segment.serialized) {
    throw new CandidateFactAssessmentAgentError(
      'surface-contaminated',
      'Assessment wire does not contain exactly the current candidate and recalled segment.',
      { wires: [wire] },
    )
  }
}

function assertCompletedTurn(agent: Agent): void {
  const event = [...agent.session.events].reverse().find(event => event.type === 'turn/end')
  if (event === undefined || event.type !== 'turn/end') {
    throw new CandidateFactAssessmentAgentError('invalid-submission', 'Assessment Agent did not finish a turn.')
  }
  if (event.data.reason.kind !== 'completed') {
    const detail = event.data.reason.kind === 'error' ? `: ${event.data.reason.error.message}` : ''
    throw new CandidateFactAssessmentAgentError(
      event.data.reason.kind === 'aborted' ? 'aborted' : 'stream-failed',
      `Assessment Agent turn ended as ${event.data.reason.kind}${detail}`,
    )
  }
}

async function waitForAssessmentAgent(
  agent: Agent,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort = (): void => {}
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => reject(createAbortError(signal?.reason))
      if (signal?.aborted) {
        rejectAbort()
        return
      }
      if (signal !== undefined) {
        signal.addEventListener('abort', rejectAbort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', rejectAbort)
      }
    })
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Cleanup retries cancellation below and records any cancellation
        // failure with the other three teardown stages; never let a throwing
        // cancel escape the timer callback as an uncaught exception.
        try {
          onTimeout()
        } catch {
          // The timeout remains the primary failure; cleanupAgent captures the
          // cancellation error and keeps walking its required sequence.
        }
        reject(new CandidateFactAssessmentAgentError('timeout', `Assessment Agent timed out after ${timeoutMs}ms.`))
      }, timeoutMs)
    })
    await Promise.race([agent.whenIdle(), aborted, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort()
  }
}

async function cleanupAgent(
  ctx: Context,
  handle: AgentHandle | undefined,
  primaryError: unknown,
): Promise<readonly unknown[]> {
  if (handle === undefined) return []
  const errors: unknown[] = []
  try {
    if (handle.agent.status !== 'idle') {
      handle.agent.cancel({ kind: 'hook', reason: primaryError === undefined ? 'X assessment completed' : 'X assessment failed' })
    }
  } catch (error) {
    errors.push(error)
  }
  try {
    await handle.agent.whenIdle()
  } catch (error) {
    errors.push(error)
  }
  try {
    await ctx.sessions.flush(handle.agent.session)
  } catch (error) {
    errors.push(error)
  }
  try {
    await handle.dispose()
  } catch (error) {
    errors.push(error)
  }
  return Object.freeze(errors)
}

function resolveModelSelection(
  ctx: Context,
  explicit: ModelSelection | undefined,
  fallback: (() => ModelSelection) | undefined,
): ModelSelection {
  let value: unknown = explicit
  if (value === undefined && fallback !== undefined) value = fallback()
  if (value === undefined) {
    const context = ctx as unknown as { get?: (name: string) => unknown }
    const service = typeof context.get === 'function' ? context.get('agentDefaultModel') : undefined
    if (isRecord(service) && typeof service.currentSelection === 'function') {
      value = service.currentSelection()
    }
  }
  if (!isModelSelection(value)) {
    throw new CandidateFactAssessmentAgentError('invalid-request', 'X assessment requires a resolvable model selection.')
  }
  return value
}

function resolveLimits(options: AssessmentAgentOptions): ResolvedLimits {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS
  const maxItemsPerSegment = options.maxItemsPerSegment ?? DEFAULT_MAX_ITEMS_PER_SEGMENT
  const maxSegmentSerializedBytes = options.maxSegmentSerializedBytes ?? options.maxSerializedBytes
    ?? DEFAULT_MAX_SEGMENT_SERIALIZED_BYTES
  const maxCandidateUtf8Bytes = options.maxCandidateUtf8Bytes ?? DEFAULT_MAX_CANDIDATE_UTF8_BYTES
  const maxReasonUtf8Bytes = options.maxReasonUtf8Bytes ?? DEFAULT_MAX_REASON_UTF8_BYTES
  for (const [name, value] of Object.entries({
    timeoutMs,
    maxItemsPerSegment,
    maxSegmentSerializedBytes,
    maxCandidateUtf8Bytes,
    maxReasonUtf8Bytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`assessment ${name} must be a positive safe integer`)
  }
  return { timeoutMs, maxItemsPerSegment, maxSegmentSerializedBytes, maxCandidateUtf8Bytes, maxReasonUtf8Bytes }
}

function projectWireRequest(request: GenerateOptions): AssessmentWireRequest {
  if (request.sessionId === undefined || request.system === undefined || request.tools === undefined) {
    throw new CandidateFactAssessmentAgentError('surface-contaminated', 'Assessment wire omitted its sole system prompt or tool schema.')
  }
  return deepFreeze(structuredClone({
    sessionId: request.sessionId,
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    system: request.system,
    tools: request.tools,
  }))
}

function createRecallError(failure: CandidateNavigationRecallFailure): CandidateFactAssessmentAgentError {
  const projection = recallFailureProjection(failure)
  return new CandidateFactAssessmentAgentError('recall-failure', failure.message, { failure: projection })
}

function recallFailureProjection(failure: CandidateNavigationRecallFailure): ProjectionFailure {
  return Object.freeze({
    kind: 'projection-failure',
    code: 'unrepresentable',
    message: `[${failure.code}] ${failure.message}`,
    recallCode: failure.code,
  }) as ProjectionFailure
}

function toAssessmentError(error: unknown, fallback: AssessmentAgentErrorCode): CandidateFactAssessmentAgentError {
  if (error instanceof CandidateFactAssessmentAgentError) return error
  return new CandidateFactAssessmentAgentError(fallback, error instanceof Error ? error.message : String(error), { cause: error })
}

function normalizeSegmentError(
  error: unknown,
  invalidSubmission: boolean,
  wires: readonly AssessmentWireRequest[],
): CandidateFactAssessmentAgentError {
  const typed = toAssessmentError(error, 'invalid-submission')
  // A fail-closed submission cancels the turn to prevent a second model call.
  // Harness consequently records the turn as `aborted`; preserve the primary
  // protocol error rather than misreporting that deliberate cancellation.
  if (invalidSubmission && typed.code === 'aborted') {
    return new CandidateFactAssessmentAgentError(
      'invalid-submission',
      'Assessment Agent turn was cancelled after an invalid submission.',
      { cause: error, wires },
    )
  }
  return typed
}

function createAbortError(reason: unknown): CandidateFactAssessmentAgentError {
  return new CandidateFactAssessmentAgentError('aborted', reason instanceof Error ? reason.message : 'Assessment Agent was aborted.', { cause: reason })
}

function stableMessageId(seed: string): MessageId {
  return MessageId(`x-cron-assessment-${createHash('sha256').update(seed).digest('hex')}`)
}

function canonicalXStatusSource(value: string): string | undefined {
  const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d*)$/.exec(value)
  return match === null ? undefined : `https://x.com/${match[1]}/status/${match[2]}`
}

function isCanonicalRecallText(value: string): boolean {
  return value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function flattenNavigation(
  navigation: CandidateFactAssessmentRequest['navigation'],
): readonly NavigationItem[] {
  if (navigation.length === 0) return []
  if (navigation.every(item => item.kind === 'navigation-segment')) {
    return navigation.flatMap(segment => segment.items)
  }
  return navigation as readonly NavigationItem[]
}

function pinNavigationForAdapter(value: NavigationSnapshot): NavigationSnapshot {
  return {
    schemaVersion: 1,
    sourceRevision: value.sourceRevision,
    items: Object.freeze(value.items.map(item => Object.freeze({
      schemaVersion: 1,
      kind: 'trusted-fact-navigation' as const,
      origin: 'machine-derived' as const,
      derivation: Object.freeze({ method: item.derivation.method, version: item.derivation.version }),
      locator: Object.freeze({
        schemaVersion: 1 as const,
        locatorId: item.locator.locatorId,
        persistence: Object.freeze({ ...item.locator.persistence }),
      }),
      hints: Object.freeze({
        topics: Object.freeze([...item.hints.topics]),
        targetRefs: Object.freeze(item.hints.targetRefs.map(ref => Object.freeze({ ...ref }))),
        dimension: item.hints.dimension,
        relations: Object.freeze(item.hints.relations.map(relation => Object.freeze({ ...relation }))),
      }),
    }))),
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isContextLike(value: unknown): value is Context {
  return isRecord(value)
}

function findMissingAssessmentSurface(ctx: Context): string | undefined {
  const context = ctx as unknown as Record<string, unknown>
  const requiredServices: readonly [string, readonly string[]][] = [
    ['agents', ['create']],
    ['sessions', ['flush']],
    ['systemPrompt', ['section', 'suppressRuntimeContext', 'assemble']],
    ['tools', ['restrict', 'presentAs', 'register', 'schemas']],
  ]
  for (const [serviceName, methods] of requiredServices) {
    const service = context[serviceName]
    if (!isRecord(service)) return `X assessment requires the Harness ${serviceName} service.`
    const missingMethod = methods.find(method => typeof service[method] !== 'function')
    if (missingMethod !== undefined) {
      return `X assessment requires Harness ${serviceName}.${missingMethod}().`
    }
  }
  if (typeof context.on !== 'function') return 'X assessment requires the Harness Context event bus.'
  return undefined
}

function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value)
    && isNonEmptyString(value.provider)
    && isNonEmptyString(value.model)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, any> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRelevance(value: unknown): value is LocatorAssessmentDecision['relevance'] {
  return value === 'high' || value === 'low_confidence' || value === 'unrelated'
}

function isEssentiality(value: unknown): value is LocatorAssessmentDecision['essentiality'] {
  return value === 'inline_priority' || value === 'lookup_only'
}
