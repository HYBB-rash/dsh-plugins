import { createHash } from 'node:crypto'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  type GenerateOptions,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type {
  Branded,
  ChatRef,
  DirectExpressionOrigin,
  ExplicitUserExpression,
  FocusDecision,
  FocusDecisionRef,
  FocusProposal,
  FocusProposalOutcome,
} from './focus.ts'
import type {
  ActionRef,
  ActionableFactMeaning,
  EvidenceSourceRef,
  FactAffectedScope,
  FactRef,
  UncertaintyMeaning,
  UsableFact,
  UnresolvedFact,
} from './action-boundary.ts'
import {
  isAuthenticBoundedEvidenceProposalRequest,
  type BoundedEvidenceProposalRequest,
  type EvidenceConclusion,
  type EvidencePromiseDescription,
} from './fact-resolution.ts'
import type { CanonicalStateRef } from './state-transaction.ts'

/** The only sidecar domain owned by the context manager. */
export const CONTEXT_MANAGER_STORAGE_DOMAIN = 'context_manager'

/** A fixed, H1-only reserve beyond the provider's hard output limit. */
export const H1_AUXILIARY_SAFETY_MARGIN_TOKENS = 128

export interface ManagedRuntimeConfig {
  readonly mode: 'observe' | 'enforce'
  readonly safeUpdateMarginTokens?: number
  readonly allowlist: readonly string[]
}

/** Validate configuration before any managed agent registration. */
export function resolveManagedRuntimeConfig(config: ManagedRuntimeConfig): ManagedRuntimeConfig {
  const margin = config.safeUpdateMarginTokens
  if (config.mode === 'enforce'
    && (!Number.isSafeInteger(margin) || (margin ?? 0) <= 0)) {
    throw new Error('ui-context-compactor: managed enforce mode requires a positive safeUpdateMarginTokens')
  }
  if (config.allowlist.some(id => id.trim().length === 0)) {
    throw new Error('ui-context-compactor: managed allowlist contains a blank session id')
  }
  return Object.freeze({ ...config, allowlist: Object.freeze([...config.allowlist]) })
}

/** One synchronous classifier shared by all future admission/capacity/native gates. */
export class ManagedInteractiveRootClassifier {
  private readonly allowlist: ReadonlySet<string>

  constructor(config: ManagedRuntimeConfig) {
    this.allowlist = new Set(config.allowlist)
  }

  isManagedInteractiveRoot(sessionId: string, delegationDepth: number | undefined): boolean {
    return (delegationDepth ?? 0) === 0 && this.allowlist.has(sessionId)
  }
}

export function directExpressionHash(messageId: string, text: string): string {
  return createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
}

/** Only structured direct-user messages are eligible; text never proves origin. */
export function isDirectUserSource(source: { readonly kind: string } | undefined): boolean {
  return source?.kind === 'user'
}

export interface BoundedAuxiliarySemanticCallConfig {
  readonly provider: string
  readonly model: string
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly maxExpressionChars: number
  /** Fixed H1 input ceiling, independent of a root request or session meter. */
  readonly maxProjectionTokens: number
  readonly safetyMarginTokens?: number
}

const AUXILIARY_INSTRUCTION = [
  'Classify only this one explicit user expression into one proposed focus action.',
  'Return exactly one JSON object with no markdown:',
  'For a new matter: {"kind":"focus","subject":"short current matter","relation":"new"}',
  'For the explicit close expression: {"kind":"close","relation":"current"}',
  'Do not invoke tools and do not use any prior conversation.',
].join('\n')

const ACTION_FACT_NEED_INSTRUCTION = [
  'Analyze only this one explicit user expression against the supplied already-established focus.',
  'Return exactly one JSON object with no markdown and these exact keys:',
  '{"actions":["action"],"proposedRequirements":[{"fact":"fact","neededFor":["action"]}],"usableInputs":[],"unresolvedInputs":[{"fact":"fact","meaning":"uncertainty","source":"direct","degree":"unknown","affected":"action"}]}',
  'Every action and fact id must be a non-blank stable label within this output.',
  'Every neededFor item must name an item in actions. Each required fact must occur exactly once in either usableInputs or unresolvedInputs.',
  'usableInputs may contain direct_fact or inherited_fact objects; unresolvedInputs degree is insufficient, conflicting, or unknown.',
  'Do not decide focus, do not close the matter, do not invoke tools, and do not use any prior conversation beyond the supplied focus projection.',
].join('\n')

const EVIDENCE_INSTRUCTION = [
  'Judge only whether this one bounded web material establishes the supplied fact.',
  'Return exactly one JSON object with no markdown.',
  'For established evidence use these exact keys:',
  '{"kind":"direct_fact","fact":"exact supplied fact","conclusion":"bounded conclusion","appliesWhen":"explicit applicability condition","observedAt":"exact supplied observation time","publishedAt":"exact supplied publication time or null","futureUse":"bounded future use","source":"exact supplied source","degree":"established","request":"exact request ref","material":"exact material ref","factNeeds":"exact fact-needs ref"}',
  'For unresolved evidence use these exact keys:',
  '{"kind":"unresolved","fact":"exact supplied fact","conclusion":"bounded uncertainty","appliesWhen":"explicit applicability condition","observedAt":"exact supplied observation time","publishedAt":"exact supplied publication time or null","futureUse":"bounded future use","source":"exact supplied source","degree":"insufficient","affected":"exact supplied scope","request":"exact request ref","material":"exact material ref","factNeeds":"exact fact-needs ref"}',
  'The unresolved degree may be insufficient, conflicting, or unknown.',
  'Never infer an applicability condition from a label: state the condition explicitly from this material, or return unresolved.',
  'Echo every supplied identity exactly. Do not invoke tools and do not decide action relevance.',
].join('\n')

const FUTURE_CRITICAL_INSTRUCTION = [
  'Condense only this one explicitly authorized bounded material into one unsigned future-critical proposal.',
  'Return exactly one JSON object with no markdown and these exact keys:',
  '{"material":"exact supplied material ref","source":"exact supplied source ref","conclusion":"bounded conclusion","appliesWhen":"explicit applicability condition","futureUse":"bounded future use"}',
  'Echo the supplied material and source identities exactly.',
  'Do not invoke tools, decide candidate qualification, or use any conversation or material outside the supplied excerpt.',
].join('\n')

type EvidenceApplicabilityCondition = Branded<'EvidenceApplicabilityCondition'>
type EvidenceFutureUse = Branded<'EvidenceFutureUse'>

export interface BoundedFutureCriticalProposalRequest {
  readonly material: string
  readonly source: string
  readonly authorizedExcerpt: string
}

export interface BoundedFutureCriticalProposal {
  readonly material: string
  readonly source: string
  readonly conclusion: string
  readonly appliesWhen: string
  readonly futureUse: string
}

export type BoundedFutureCriticalProposalOutcome =
  | {
      readonly kind: 'proposal'
      readonly request: BoundedFutureCriticalProposalRequest
      readonly value: BoundedFutureCriticalProposal
    }
  | {
      readonly kind: 'known_failure' | 'unknown'
      readonly request: BoundedFutureCriticalProposalRequest
      readonly detail: string
    }

const authenticFutureCriticalRequests = new WeakMap<
  BoundedFutureCriticalProposalRequest,
  BoundedAuxiliarySemanticCall
>()

/** @internal Register one owner-validated material projection for its exact bounded caller. */
export function bindAuthenticBoundedFutureCriticalProposalRequest(
  request: BoundedFutureCriticalProposalRequest,
  semantic: BoundedAuxiliarySemanticCall,
): boolean {
  const existing = authenticFutureCriticalRequests.get(request)
  if (existing !== undefined) return existing === semantic
  if (!Object.isFrozen(request)) return false
  authenticFutureCriticalRequests.set(request, semantic)
  return true
}

/**
 * Source-private T3 material finding. It is carried beside, never inside, the
 * unchanged public EvidenceConclusion consumed by T1/T2 and C13.
 */
interface EvidenceSemanticFinding {
  readonly factNeeds: BoundedEvidenceProposalRequest['factNeeds']['ref']
  readonly request: BoundedEvidenceProposalRequest['retrieval']['ref']
  readonly material: BoundedEvidenceProposalRequest['material']['ref']
  readonly fact: FactRef
  readonly source: EvidenceSourceRef
  readonly conclusion: ActionableFactMeaning | UncertaintyMeaning
  readonly appliesWhen: EvidenceApplicabilityCondition
  readonly observedAt: string
  readonly publishedAt: string | undefined
  readonly futureUse: EvidenceFutureUse
}

type EvidenceSemanticCallOutcome =
  | {
      readonly kind: 'proposal'
      readonly request: BoundedEvidenceProposalRequest
      readonly value: EvidenceConclusion
    }
  | {
      readonly kind: 'proposal'
      readonly request: BoundedEvidenceProposalRequest
      readonly value: EvidenceConclusion
      readonly finding: EvidenceSemanticFinding
    }
  | {
      readonly kind: 'known_failure' | 'unknown'
      readonly request: BoundedEvidenceProposalRequest
      readonly detail: EvidencePromiseDescription
    }

type ParsedEvidenceProposal =
  | { readonly kind: 'legacy'; readonly value: EvidenceConclusion }
  | {
      readonly kind: 'structured_finding'
      readonly value: EvidenceConclusion
      readonly finding: EvidenceSemanticFinding
    }

type EstablishedFocusDecision = Extract<FocusDecision, { readonly kind: 'focus_established' }>

export type DirectMessageRef = Branded<'DirectMessageRef'>
export type ExactDirectExpressionHash = Branded<'ExactDirectExpressionHash'>
export type PromiseDescription = Branded<'PromiseDescription'>
export interface ExactDirectOrigin {
  readonly message: DirectMessageRef
  readonly chat: ChatRef
  readonly expressionHash: ExactDirectExpressionHash
}
export type EstablishedFocusProjection = Omit<EstablishedFocusDecision, 'chat'>

export interface BoundedActionFactNeedProposalRequest {
  readonly origin: ExactDirectOrigin
  readonly focus: EstablishedFocusProjection
  readonly expression: ExplicitUserExpression
}

export interface BoundedActionFactNeedProposal {
  readonly origin: ExactDirectOrigin
  readonly focus: FocusDecisionRef
  readonly actions: readonly [ActionRef, ...ActionRef[]]
  readonly proposedRequirements: readonly {
    readonly fact: FactRef
    readonly neededFor: readonly [ActionRef, ...ActionRef[]]
  }[]
  readonly usableInputs: readonly UsableFact[]
  readonly unresolvedInputs: readonly UnresolvedFact[]
}

export type BoundedActionFactNeedProposalOutcome =
  | { readonly kind: 'proposal'; readonly origin: ExactDirectOrigin; readonly focus: FocusDecisionRef; readonly value: BoundedActionFactNeedProposal }
  | { readonly kind: 'known_failure'; readonly origin: ExactDirectOrigin; readonly focus: FocusDecisionRef; readonly detail: PromiseDescription }
  | { readonly kind: 'unknown'; readonly origin: ExactDirectOrigin; readonly focus: FocusDecisionRef; readonly detail: PromiseDescription }

/** Bind the new action-specific public origin without exposing focus's H1 runtime evidence shape. */
export function createBoundedActionFactNeedProposalRequest(
  expression: ExplicitUserExpression,
  origin: DirectExpressionOrigin,
  focus: EstablishedFocusDecision,
): BoundedActionFactNeedProposalRequest | undefined {
  if (expression.chat !== focus.chat || origin.messageId.trim().length === 0
    || origin.hash.trim().length === 0
    || directExpressionHash(origin.messageId, expression.expression) !== origin.hash) return undefined
  const exactOrigin: ExactDirectOrigin = Object.freeze({
    message: origin.messageId as DirectMessageRef,
    chat: focus.chat,
    expressionHash: origin.hash as ExactDirectExpressionHash,
  })
  const projection: EstablishedFocusProjection = Object.freeze({
    kind: focus.kind,
    ref: focus.ref,
    currentMatter: focus.currentMatter,
    latestCorrections: focus.latestCorrections,
  })
  return Object.freeze({
    origin: exactOrigin,
    focus: projection,
    expression: Object.freeze({ ...expression }),
  })
}

function validConfig(config: BoundedAuxiliarySemanticCallConfig): boolean {
  return config.provider.trim().length > 0
    && config.model.trim().length > 0
    && Number.isSafeInteger(config.maxOutputTokens)
    && config.maxOutputTokens > 0
    && Number.isSafeInteger(config.timeoutMs)
    && config.timeoutMs > 0
    && Number.isSafeInteger(config.maxExpressionChars)
    && config.maxExpressionChars > 0
    && Number.isSafeInteger(config.maxProjectionTokens)
    && config.maxProjectionTokens > 0
    && Number.isSafeInteger(config.safetyMarginTokens ?? H1_AUXILIARY_SAFETY_MARGIN_TOKENS)
    && (config.safetyMarginTokens ?? H1_AUXILIARY_SAFETY_MARGIN_TOKENS) > 0
}

function proposalFromOutput(output: string, origin: DirectExpressionOrigin): FocusProposal | undefined {
  if (output.length === 0 || output.length > 512) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.kind === 'close') {
    if (Object.keys(record).length !== 2 || record.relation !== 'current') return undefined
    return { kind: 'close', relation: 'current', origin }
  }
  if (Object.keys(record).length !== 3
    || record.kind !== 'focus'
    || record.relation !== 'new'
    || typeof record.subject !== 'string') return undefined
  const subject = record.subject.trim()
  if (subject.length === 0 || subject.length > 240) return undefined
  return { kind: 'focus', relation: 'new', subject, origin }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function futureCriticalProposalFromOutput(
  output: string,
  request: BoundedFutureCriticalProposalRequest,
): BoundedFutureCriticalProposal | undefined {
  if (output.length === 0 || output.length > 2_048) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  const raw = object(parsed)
  if (raw === undefined || !onlyKeys(raw, [
    'material', 'source', 'conclusion', 'appliesWhen', 'futureUse',
  ])
    || raw.material !== request.material
    || raw.source !== request.source
    || !nonblank(raw.conclusion)
    || !nonblank(raw.appliesWhen)
    || !nonblank(raw.futureUse)) return undefined
  return Object.freeze({
    material: request.material,
    source: request.source,
    conclusion: raw.conclusion,
    appliesWhen: raw.appliesWhen,
    futureUse: raw.futureUse,
  })
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nonblankStrings(value: unknown): readonly [string, ...string[]] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonblank)) return undefined
  return value as [string, ...string[]]
}

function usableFact(value: unknown): UsableFact | undefined {
  const fact = object(value)
  if (fact === undefined || !nonblank(fact.fact) || !nonblank(fact.meaning)
    || !nonblank(fact.source) || fact.degree !== 'established') return undefined
  if (fact.kind === 'direct_fact' && onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree'])) {
    return Object.freeze({ kind: 'direct_fact', fact: fact.fact as FactRef,
      meaning: fact.meaning as ActionableFactMeaning, source: fact.source as EvidenceSourceRef, degree: 'established' })
  }
  const inherited = object(fact.inheritedFrom)
  if (fact.kind !== 'inherited_fact'
    || !onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree', 'inheritedFrom'])
    || inherited === undefined || !onlyKeys(inherited, ['sourceChat', 'sourceCanonicalState'])
    || !nonblank(inherited.sourceChat) || !nonblank(inherited.sourceCanonicalState)) return undefined
  return Object.freeze({ kind: 'inherited_fact', fact: fact.fact as FactRef,
    meaning: fact.meaning as ActionableFactMeaning, source: fact.source as EvidenceSourceRef, degree: 'established',
    inheritedFrom: Object.freeze({ sourceChat: inherited.sourceChat as ChatRef,
      sourceCanonicalState: inherited.sourceCanonicalState as CanonicalStateRef }) })
}

function unresolvedFact(value: unknown): UnresolvedFact | undefined {
  const fact = object(value)
  if (fact === undefined || !onlyKeys(fact, ['fact', 'meaning', 'source', 'degree', 'affected'])
    || !nonblank(fact.fact) || !nonblank(fact.meaning) || !nonblank(fact.source) || !nonblank(fact.affected)
    || (fact.degree !== 'insufficient' && fact.degree !== 'conflicting' && fact.degree !== 'unknown')) return undefined
  return Object.freeze({ fact: fact.fact as FactRef, meaning: fact.meaning as UncertaintyMeaning,
    source: fact.source as EvidenceSourceRef, degree: fact.degree, affected: fact.affected as FactAffectedScope })
}

function actionFactNeedProposalFromOutput(
  output: string,
  request: BoundedActionFactNeedProposalRequest,
): BoundedActionFactNeedProposal | undefined {
  if (output.length === 0 || output.length > 8_192) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { return undefined }
  const raw = object(parsed)
  if (raw === undefined || !onlyKeys(raw, ['actions', 'proposedRequirements', 'usableInputs', 'unresolvedInputs'])) return undefined
  const actions = nonblankStrings(raw.actions)
  if (actions === undefined || new Set(actions).size !== actions.length || !Array.isArray(raw.proposedRequirements)
    || !Array.isArray(raw.usableInputs) || !Array.isArray(raw.unresolvedInputs)) return undefined
  const actionSet = new Set(actions)
  const requirements = raw.proposedRequirements.map(value => {
    const requirement = object(value)
    const neededFor = requirement === undefined ? undefined : nonblankStrings(requirement.neededFor)
    return requirement !== undefined && onlyKeys(requirement, ['fact', 'neededFor']) && nonblank(requirement.fact)
      && neededFor !== undefined && new Set(neededFor).size === neededFor.length
      && neededFor.every(action => actionSet.has(action))
      ? Object.freeze({ fact: requirement.fact as FactRef,
          neededFor: Object.freeze([...neededFor]) as readonly [ActionRef, ...ActionRef[]] })
      : undefined
  })
  const usable = raw.usableInputs.map(usableFact)
  const unresolved = raw.unresolvedInputs.map(unresolvedFact)
  if (requirements.some(value => value === undefined) || usable.some(value => value === undefined)
    || unresolved.some(value => value === undefined)) return undefined
  const requiredRefs = requirements.map(value => value!.fact)
  const usableRefs = usable.map(value => value!.fact)
  const unresolvedRefs = unresolved.map(value => value!.fact)
  const inputs = [...usableRefs, ...unresolvedRefs]
  if (new Set(requiredRefs).size !== requiredRefs.length || new Set(inputs).size !== inputs.length
    || requiredRefs.length !== inputs.length || requiredRefs.some(fact => !inputs.includes(fact))) return undefined
  return Object.freeze({ origin: request.origin, focus: request.focus.ref,
    actions: Object.freeze([...actions]) as readonly [ActionRef, ...ActionRef[]],
    proposedRequirements: Object.freeze(requirements) as BoundedActionFactNeedProposal['proposedRequirements'],
    usableInputs: Object.freeze(usable) as readonly UsableFact[],
    unresolvedInputs: Object.freeze(unresolved) as readonly UnresolvedFact[] })
}

function evidenceProposalFromOutput(
  output: string,
  request: BoundedEvidenceProposalRequest,
): ParsedEvidenceProposal | undefined {
  if (output.length === 0 || output.length > 8_192) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { return undefined }
  const raw = object(parsed)
  if (raw === undefined
    || raw.fact !== request.retrieval.need.fact
    || raw.source !== request.material.source
    || raw.request !== request.retrieval.ref
    || raw.material !== request.material.ref
    || raw.factNeeds !== request.factNeeds.ref) return undefined
  if (raw.kind === 'direct_fact') {
    if (onlyKeys(raw, ['kind', 'fact', 'meaning', 'source', 'degree', 'request', 'material', 'factNeeds'])
      && raw.degree === 'established' && nonblank(raw.meaning)) {
      return Object.freeze({ kind: 'legacy', value: Object.freeze({
        kind: 'direct_fact',
        fact: request.retrieval.need.fact,
        meaning: raw.meaning as ActionableFactMeaning,
        source: request.material.source,
        degree: 'established',
      }) })
    }
    if (!onlyKeys(raw, [
      'kind', 'fact', 'conclusion', 'appliesWhen', 'observedAt', 'publishedAt', 'futureUse',
      'source', 'degree', 'request', 'material', 'factNeeds',
    ]) || raw.degree !== 'established') return undefined
    const finding = structuredEvidenceFinding(raw, request, 'established')
    if (finding === undefined) return undefined
    return Object.freeze({ kind: 'structured_finding', finding, value: Object.freeze({
      kind: 'direct_fact',
      fact: request.retrieval.need.fact,
      meaning: finding.conclusion as ActionableFactMeaning,
      source: request.material.source,
      degree: 'established',
    }) })
  }
  if (raw.kind !== 'unresolved' || raw.affected !== request.affected
    || (raw.degree !== 'insufficient' && raw.degree !== 'conflicting' && raw.degree !== 'unknown')) return undefined
  if (onlyKeys(raw, ['kind', 'fact', 'meaning', 'source', 'degree', 'affected', 'request', 'material', 'factNeeds'])
    && nonblank(raw.meaning)) {
    return Object.freeze({ kind: 'legacy', value: Object.freeze({
      fact: request.retrieval.need.fact,
      meaning: raw.meaning as UncertaintyMeaning,
      source: request.material.source,
      degree: raw.degree,
      affected: request.affected,
    }) })
  }
  if (!onlyKeys(raw, [
    'kind', 'fact', 'conclusion', 'appliesWhen', 'observedAt', 'publishedAt', 'futureUse',
    'source', 'degree', 'affected', 'request', 'material', 'factNeeds',
  ])) return undefined
  const finding = structuredEvidenceFinding(raw, request, raw.degree)
  if (finding === undefined) return undefined
  return Object.freeze({ kind: 'structured_finding', finding, value: Object.freeze({
    fact: request.retrieval.need.fact,
    meaning: finding.conclusion as UncertaintyMeaning,
    source: request.material.source,
    degree: raw.degree,
    affected: request.affected,
  }) })
}

function structuredEvidenceFinding(
  raw: Record<string, unknown>,
  request: BoundedEvidenceProposalRequest,
  degree: 'established' | 'insufficient' | 'conflicting' | 'unknown',
): EvidenceSemanticFinding | undefined {
  const publishedAt = request.material.publishedAt
  if (!nonblank(raw.conclusion)
    || !nonblank(raw.appliesWhen)
    || !nonblank(raw.futureUse)
    || raw.observedAt !== request.material.observedAt
    || !nonblank(raw.observedAt)
    || !Number.isFinite(Date.parse(raw.observedAt))
    || (publishedAt === undefined
      ? raw.publishedAt !== null
      : raw.publishedAt !== publishedAt || !Number.isFinite(Date.parse(publishedAt)))) return undefined
  const conclusion = degree === 'established'
    ? raw.conclusion as ActionableFactMeaning
    : raw.conclusion as UncertaintyMeaning
  return Object.freeze({
    factNeeds: request.factNeeds.ref,
    request: request.retrieval.ref,
    material: request.material.ref,
    fact: request.retrieval.need.fact,
    source: request.material.source,
    conclusion,
    appliesWhen: raw.appliesWhen as EvidenceApplicabilityCondition,
    observedAt: request.material.observedAt,
    publishedAt,
    futureUse: raw.futureUse as EvidenceFutureUse,
  })
}

/**
 * One fixed-schema semantic call. It never reads a Session, uses no root
 * surface, and fails closed before provider dispatch on every budget/window
 * uncertainty. `estimateMessage` prices the exact two messages dispatched.
 */
export class BoundedAuxiliarySemanticCall {
  private readonly claimedOrigins = new Map<string, 'focus' | 'action-fact-need'>()
  private readonly claimedEvidenceRequests = new WeakSet<BoundedEvidenceProposalRequest>()
  private readonly claimedFutureCriticalRequests = new WeakSet<BoundedFutureCriticalProposalRequest>()

  constructor(
    private readonly llm: LlmRuntime,
    private readonly tokenMeter: TokenMeter,
    private readonly config: BoundedAuxiliarySemanticCallConfig,
  ) {}

  async propose(
    expression: string,
    origin: DirectExpressionOrigin,
    signal: AbortSignal,
  ): Promise<FocusProposalOutcome> {
    if (!validConfig(this.config)
      || expression.length === 0
      || expression.length > this.config.maxExpressionChars
      || signal.aborted) return { kind: 'known_failure', code: 'focus-canary', origin }

    if (!this.claimOrigin(origin.messageId, origin.hash, 'focus')) {
      return { kind: 'known_failure', code: 'focus-canary', origin }
    }
    const result = await this.perform(
      AUXILIARY_INSTRUCTION,
      'ui-context-compactor:focus-canary-schema',
      expression,
      signal,
    )
    if (result.kind !== 'output') return { kind: result.kind, code: 'focus-canary', origin }
    const proposal = proposalFromOutput(result.value, origin)
    return proposal === undefined
      ? { kind: 'known_failure', code: 'focus-canary', origin }
      : { kind: 'proposal', value: proposal, origin }
  }

  async proposeActionFacts(
    request: BoundedActionFactNeedProposalRequest,
    signal: AbortSignal,
  ): Promise<BoundedActionFactNeedProposalOutcome> {
    const { expression, origin, focus } = request
    const rawRequest = object(request)
    const rawOrigin = object(origin)
    const rawFocus = object(focus)
    const rawExpression = object(expression)
    const failure = (): BoundedActionFactNeedProposalOutcome => ({
      kind: 'known_failure', detail: 'action/fact-need proposal was not established' as PromiseDescription,
      origin, focus: focus.ref,
    })
    if (!validConfig(this.config)
      || rawRequest === undefined || !onlyKeys(rawRequest, ['origin', 'focus', 'expression'])
      || rawOrigin === undefined || !onlyKeys(rawOrigin, ['message', 'chat', 'expressionHash'])
      || rawFocus === undefined || !onlyKeys(rawFocus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])
      || rawExpression === undefined || !onlyKeys(rawExpression, ['expression', 'chat'])
      || focus.kind !== 'focus_established' || !nonblank(focus.ref) || !nonblank(focus.currentMatter)
      || expression.chat !== origin.chat
      || expression.expression.length === 0 || expression.expression.length > this.config.maxExpressionChars
      || origin.message.trim().length === 0 || origin.expressionHash.trim().length === 0
      || directExpressionHash(origin.message, expression.expression) !== origin.expressionHash
      || signal.aborted) return failure()
    if (!this.claimOrigin(origin.message, origin.expressionHash, 'action-fact-need')) return failure()
    const projection = JSON.stringify({
      focus: {
        kind: focus.kind,
        ref: focus.ref,
        currentMatter: focus.currentMatter,
        latestCorrections: focus.latestCorrections,
      },
      expression: expression.expression,
    })
    const result = await this.perform(
      ACTION_FACT_NEED_INSTRUCTION,
      'ui-context-compactor:action-fact-need-schema',
      projection,
      signal,
    )
    if (result.kind !== 'output') {
      return { kind: result.kind,
        detail: (result.kind === 'unknown'
          ? 'action/fact-need proposal outcome is unknown'
          : 'action/fact-need proposal was not established') as PromiseDescription,
        origin, focus: focus.ref }
    }
    const proposal = actionFactNeedProposalFromOutput(result.value, request)
    return proposal === undefined
      ? failure()
      : { kind: 'proposal', origin, focus: focus.ref, value: proposal }
  }

  /**
   * A second schema on the same bounded caller. It has a separate owner-issued
   * request identity and never claims the direct origin used by focus/action.
   */
  async proposeEvidence(
    request: BoundedEvidenceProposalRequest,
    signal: AbortSignal,
  ): Promise<EvidenceSemanticCallOutcome> {
    const rawRequest = object(request)
    const rawNeeds = object(request.factNeeds)
    const rawRetrieval = object(request.retrieval)
    const rawNeed = object(request.retrieval.need)
    const rawMaterial = object(request.material)
    const rawOrigin = object(request.origin)
    const failure = (kind: 'known_failure' | 'unknown' = 'known_failure'): EvidenceSemanticCallOutcome => ({
      kind,
      request,
      detail: (kind === 'unknown'
        ? 'evidence proposal outcome is unknown'
        : 'evidence proposal was not established') as EvidencePromiseDescription,
    })
    if (!validConfig(this.config)
      || !isAuthenticBoundedEvidenceProposalRequest(request, this)
      || this.claimedEvidenceRequests.has(request)
      || rawRequest === undefined
      || !onlyKeys(rawRequest, ['factNeeds', 'retrieval', 'material', 'origin', 'focus', 'affected'])
      || rawNeeds === undefined || !onlyKeys(rawNeeds, ['ref', 'chat', 'requirements'])
      || request.factNeeds.requirements.length < 1
      || request.factNeeds.requirements.length > 2
      || rawRetrieval === undefined || !onlyKeys(rawRetrieval, ['ref', 'need'])
      || rawNeed === undefined || !onlyKeys(rawNeed, ['fact', 'neededFor'])
      || !request.factNeeds.requirements.some(requirement => requirement === request.retrieval.need)
      || request.retrieval.need.neededFor.length === 0
      || rawMaterial === undefined
      || !onlyKeys(rawMaterial, [
        'ref', 'request', 'fact', 'source', 'url', 'content', 'observedAt', 'publishedAt', 'truncated',
      ])
      || request.material.request !== request.retrieval.ref
      || request.material.fact !== request.retrieval.need.fact
      || request.material.truncated !== false
      || !nonblank(request.material.ref)
      || !nonblank(request.material.source)
      || !nonblank(request.material.url)
      || !nonblank(request.material.content)
      || !nonblank(request.material.observedAt)
      || request.material.content.length > 4_096
      || rawOrigin === undefined || !onlyKeys(rawOrigin, ['messageId', 'hash', 'chat'])
      || request.origin.chat !== request.factNeeds.chat
      || !nonblank(request.origin.messageId)
      || !nonblank(request.origin.hash)
      || !nonblank(request.focus)
      || !nonblank(request.affected)
      || signal.aborted) return failure(signal.aborted ? 'unknown' : 'known_failure')
    this.claimedEvidenceRequests.add(request)
    const projection = JSON.stringify({
      factNeeds: request.factNeeds.ref,
      request: request.retrieval.ref,
      fact: request.retrieval.need.fact,
      neededFor: request.retrieval.need.neededFor,
      material: {
        ref: request.material.ref,
        source: request.material.source,
        url: request.material.url,
        content: request.material.content,
        observedAt: request.material.observedAt,
        publishedAt: request.material.publishedAt,
      },
      affected: request.affected,
    })
    const result = await this.perform(
      EVIDENCE_INSTRUCTION,
      'ui-context-compactor:evidence-schema',
      projection,
      signal,
    )
    if (result.kind !== 'output') return failure(result.kind)
    const proposal = evidenceProposalFromOutput(result.value, request)
    return proposal === undefined
      ? failure()
      : proposal.kind === 'legacy'
        ? { kind: 'proposal', request, value: proposal.value }
        : { kind: 'proposal', request, value: proposal.value, finding: proposal.finding }
  }

  /**
   * One optional T1F condensation call. The caller may supply only one bounded,
   * explicitly authorized material excerpt; this returns an unsigned proposal
   * and never creates or qualifies a Candidate.
   */
  async proposeFutureCriticalPoint(
    request: BoundedFutureCriticalProposalRequest,
    signal: AbortSignal,
  ): Promise<BoundedFutureCriticalProposalOutcome> {
    const raw = object(request)
    const failure = (
      kind: 'known_failure' | 'unknown' = 'known_failure',
    ): BoundedFutureCriticalProposalOutcome => ({
      kind,
      request,
      detail: kind === 'unknown'
        ? 'future-critical proposal outcome is unknown'
        : 'future-critical proposal was not established',
    })
    if (!validConfig(this.config)
      || authenticFutureCriticalRequests.get(request) !== this
      || this.claimedFutureCriticalRequests.has(request)
      || raw === undefined
      || !onlyKeys(raw, ['material', 'source', 'authorizedExcerpt'])
      || !Object.isFrozen(request)
      || !nonblank(request.material)
      || !nonblank(request.source)
      || !nonblank(request.authorizedExcerpt)
      || request.authorizedExcerpt.length > this.config.maxExpressionChars
      || signal.aborted) return failure(signal.aborted ? 'unknown' : 'known_failure')
    authenticFutureCriticalRequests.delete(request)
    this.claimedFutureCriticalRequests.add(request)
    const projection = JSON.stringify({
      material: request.material,
      source: request.source,
      authorizedExcerpt: request.authorizedExcerpt,
    })
    const result = await this.perform(
      FUTURE_CRITICAL_INSTRUCTION,
      'ui-context-compactor:future-critical-schema',
      projection,
      signal,
    )
    if (result.kind !== 'output') return failure(result.kind)
    const proposal = futureCriticalProposalFromOutput(result.value, request)
    return proposal === undefined
      ? failure()
      : { kind: 'proposal', request, value: proposal }
  }

  private claimOrigin(messageId: string, hash: string, schema: 'focus' | 'action-fact-need'): boolean {
    const key = `${messageId}\0${hash}`
    if (this.claimedOrigins.has(key)) return false
    this.claimedOrigins.set(key, schema)
    return true
  }

  private async perform(
    instructionText: string,
    sourcePlugin: string,
    expression: string,
    signal: AbortSignal,
  ): Promise<{ readonly kind: 'output'; readonly value: string } | { readonly kind: 'known_failure' | 'unknown' }> {

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const relay = () => controller.abort()
    signal.addEventListener('abort', relay, { once: true })
    // An abort can land between the early precondition check and listener
    // registration. Close that race before the first async model operation.
    if (signal.aborted) controller.abort()
    try {
      // Both fixed schema/instruction and the exact user expression are actual
      // GenerateOptions messages, rather than unpriced `system` text.
      const instruction = createUserMessage({
        content: [{ type: 'text', text: instructionText }],
        source: { kind: 'plugin', plugin: sourcePlugin },
      })
      const input = createUserMessage({
        content: [{ type: 'text', text: expression }],
        source: { kind: 'user' },
      })
      const options: GenerateOptions = deepFreeze({
        provider: this.config.provider,
        model: this.config.model,
        messages: [instruction, input],
        maxTokens: this.config.maxOutputTokens,
        signal: controller.signal,
      })
      const inputTokens = options.messages.reduce((total, message) => total + this.tokenMeter.estimateMessage(message), 0)
      if (!Number.isSafeInteger(inputTokens) || inputTokens > this.config.maxProjectionTokens) {
        return { kind: 'known_failure' }
      }
      const contextWindow = (await this.llm.resolveModelInfo(
        options.provider,
        options.model,
        controller.signal,
      )).context?.contextWindow
      const reserve = this.config.safetyMarginTokens ?? H1_AUXILIARY_SAFETY_MARGIN_TOKENS
      const maxTokens = options.maxTokens
      if (typeof contextWindow !== 'number'
        || !Number.isSafeInteger(contextWindow)
        || contextWindow <= 0
        || typeof maxTokens !== 'number'
        || !Number.isSafeInteger(maxTokens)
        || maxTokens <= 0
        || inputTokens + maxTokens + reserve > contextWindow) {
        return { kind: 'known_failure' }
      }
      const assembler = new BlockAssembler()
      for await (const chunk of this.llm.stream({ ...options, signal: controller.signal })) {
        assembler.push(chunk)
      }
      if (controller.signal.aborted || signal.aborted || assembler.finish.kind !== 'stop') {
        return { kind: 'unknown' }
      }
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type !== 'text')) return { kind: 'known_failure' }
      const output = blocks.flatMap(block => block.type === 'text' ? [block.text] : [])
        .join('')
      return { kind: 'output', value: output }
    } catch {
      return controller.signal.aborted || signal.aborted
        ? { kind: 'unknown' }
        : { kind: 'known_failure' }
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', relay)
    }
  }
}
