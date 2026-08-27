/**
 * F01 candidate formation and the two independent candidate reviewers.
 *
 * The module is deliberately package-internal.  Formation is the only writer
 * of CandidateEnvelope objects.  The reviewers consume their own C04/C16/C17
 * or C05/C18/C19 standards and only report C26/C27; neither mutates a
 * candidate or decides final qualification.
 */

import { createHash, randomUUID } from 'node:crypto'
import type {
  Accepted,
  ChatRef,
  ContractCallRef,
  ContractCode,
  ContractReport,
  ContractScope,
  FocusDecision,
  FocusDecisionRef,
} from './focus.ts'
import type {
  ActionFactBoundary,
  ActionFactBoundaryRef,
} from './action-boundary.ts'
import type {
  EvidenceConclusionSet,
  EvidenceConclusionSetRef,
} from './fact-resolution.ts'
import type {
  CandidateAffectedScope,
  CandidateBasis,
  CandidateBasisFreshnessDecision,
  CandidateContentReviewDecision,
  CandidateEnvelope,
  CandidateFormationResult,
  CandidateRef,
  C25Result,
  C26Result,
  C27Result,
  ChangedAuthorityFact,
  ContentFailureReason,
  FutureCriticalPoint,
  SelfContainedBackgroundText,
} from './candidate-qualification.ts'
import type { FutureCriticalPointProjection } from './future-critical-candidate.ts'
import type { CanonicalBackgroundState } from './state-transaction.ts'

declare const candidateInputBrand: unique symbol
type Brand<Name extends string> = string & { readonly [candidateInputBrand]: Name }

export type CapacityDecisionRef = Brand<'CapacityDecisionRef'>

export type CapacityDecision =
  | { readonly kind: 'safe_update_margin_remains'; readonly ref: CapacityDecisionRef; readonly chat: ChatRef }
  | { readonly kind: 'cannot_delay_safe_update'; readonly ref: CapacityDecisionRef; readonly chat: ChatRef }
  | { readonly kind: 'cannot_safely_determine_capacity'; readonly ref: CapacityDecisionRef; readonly chat: ChatRef }

export interface ExactBackgroundUpdateOrigin {
  readonly messageId: string
  readonly hash: string
}

export interface CandidateAssemblySnapshot {
  readonly fingerprint: string
  readonly provider: string
  readonly model: string
  readonly headerFingerprint: string
  readonly contextFingerprint: string
  readonly revision: number
  readonly directMessageId: string
  readonly directHash: string
  readonly directText: string
  readonly directChat: ChatRef
  readonly baseInputTokens: number
}

export interface CandidatePreparationSnapshot {
  readonly fingerprint: string
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
  readonly outputTokens: number
}

/**
 * A closed, static proof produced from two public assembly observations and
 * two public prepareCall observations.  It contains measurements only: no
 * callback, provider, Context, state or mutable sidecar can hide behind it.
 */
export interface FixedH1CandidateBudgetProof {
  readonly kind: 'fixed_h1_known_envelope'
  readonly firstAssembly: CandidateAssemblySnapshot
  readonly secondAssembly: CandidateAssemblySnapshot
  readonly firstPreparation: CandidatePreparationSnapshot
  readonly secondPreparation: CandidatePreparationSnapshot
  readonly bodyHash: string
  readonly bodyTokens: number
  readonly safeUpdateMarginTokens: number
}

export interface ExplicitBackgroundUpdateRequest {
  readonly chat: ChatRef
}

/** @internal Runtime evidence for one already-admitted direct C38 event. */
export interface ExplicitBackgroundUpdateRuntimeEvidence {
  readonly chat: ChatRef
  readonly text: '请更新当前背景'
  readonly origin: ExactBackgroundUpdateOrigin
  readonly budget: FixedH1CandidateBudgetProof
  readonly futureCriticalPoints?: FutureCriticalPointProjection
}

/**
 * @internal A destructive per-chat read.  W4 binds it to the real current
 * Context/Session assembly; Formation has no provider or state dependency.
 */
export interface ExplicitBackgroundUpdateRuntimeEvidenceSource {
  takeExplicitUpdateEvidence(chat: ChatRef): ExplicitBackgroundUpdateRuntimeEvidence | undefined
}

export type C03Result = ContractReport<'C03', FocusDecisionRef, Accepted<FocusDecision>>
export type C04Result = ContractReport<'C04', FocusDecisionRef, Accepted<FocusDecision>>
export type C05Result = ContractReport<'C05', FocusDecisionRef, Accepted<FocusDecision>>
export type C10Result = ContractReport<'C10', CapacityDecisionRef, Accepted<CapacityDecision>>
export type C14Result = ContractReport<'C14', ActionFactBoundaryRef, Accepted<ActionFactBoundary>>
export type C15Result = ContractReport<'C15', EvidenceConclusionSetRef, Accepted<EvidenceConclusionSet>>
export type C16Result = ContractReport<'C16', ActionFactBoundaryRef, Accepted<ActionFactBoundary>>
export type C17Result = ContractReport<'C17', EvidenceConclusionSetRef, Accepted<EvidenceConclusionSet>>
export type C18Result = ContractReport<'C18', ActionFactBoundaryRef, Accepted<ActionFactBoundary>>
export type C19Result = ContractReport<'C19', EvidenceConclusionSetRef, Accepted<EvidenceConclusionSet>>
export type C23Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C23', Ref, Accepted<CandidateEnvelope<Ref>>
>
export type C24Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C24', Ref, Accepted<CandidateEnvelope<Ref>>
>
export type C38Result = ContractReport<
  'C38', ChatRef, { readonly kind: 'trigger_accepted'; readonly chat: ChatRef }
>
export type CanonicalStateForRollingCandidate = CanonicalBackgroundState
export type C41Result = ContractReport<
  'C41', CanonicalBackgroundState['ref'], Accepted<CanonicalStateForRollingCandidate>
>

interface CurrentCanonicalIdentity {
  readonly generation: number
}

/**
 * Package-internal provenance bridge for C41.  A structurally similar state
 * is not current merely because another caller can construct its fields.
 */
const currentCanonicalIdentities = new WeakMap<
  CanonicalStateForRollingCandidate,
  CurrentCanonicalIdentity
>()

const rollingCandidateGenerations = new WeakMap<CandidateEnvelope, number>()

/** @internal Called only after the C41 adapter has proved one finalized current state. */
export function bindCurrentCanonicalGeneration(
  state: CanonicalStateForRollingCandidate,
  generation: number,
): void {
  if (Number.isSafeInteger(generation) && generation >= 1) {
    currentCanonicalIdentities.set(state, Object.freeze({ generation }))
  }
}

/** @internal Read by the canonical transaction; cloned candidates have no binding. */
export function rollingCandidateGeneration(candidate: CandidateEnvelope): number | undefined {
  return rollingCandidateGenerations.get(candidate)
}

type FocusEstablished = Extract<FocusDecision, { readonly kind: 'focus_established' }>

export interface CandidateContentReviewSink {
  acceptContentReview<Ref extends CandidateRef>(
    review: CandidateContentReviewDecision<Ref>,
  ): C26Result<Ref>
}

export interface CandidateFreshnessReviewSink {
  acceptBasisFreshness<Ref extends CandidateRef>(
    freshness: CandidateBasisFreshnessDecision<Ref>,
  ): C27Result<Ref>
}

export interface CandidateFormationResultSink {
  acceptFormationResult<Ref extends CandidateRef>(
    result: CandidateFormationResult<Ref>,
  ): C25Result<Ref>
}

export interface CandidateForContentReviewReceiver {
  acceptCandidateForContentReview<Ref extends CandidateRef>(
    candidate: CandidateEnvelope<Ref>,
  ): C23Result<Ref>
}

export interface CandidateForFreshnessReviewReceiver {
  acceptCandidateForFreshnessReview<Ref extends CandidateRef>(
    candidate: CandidateEnvelope<Ref>,
  ): C24Result<Ref>
}

export interface BackgroundCandidateFormationDependencies {
  readonly contentReview: CandidateForContentReviewReceiver
  readonly freshnessReview: CandidateForFreshnessReviewReceiver
  readonly qualification: CandidateFormationResultSink
  readonly runtimeEvidence: ExplicitBackgroundUpdateRuntimeEvidenceSource
}

export interface CandidateContentReviewerDependencies {
  readonly qualification: CandidateContentReviewSink
}

export interface CandidateBasisFreshnessReviewerDependencies {
  readonly qualification: CandidateFreshnessReviewSink
}

interface CandidateRenderMaterial {
  readonly target: ChatRef
  readonly focus: CandidateEnvelope['formationFocus']
  readonly action: CandidateEnvelope['formationActionBoundary']
  readonly evidence: CandidateEnvelope['formationEvidence']
  readonly knownFutureCriticalPoints: CandidateEnvelope['knownFutureCriticalPoints']
}

interface FormationBasis {
  readonly focus: FocusEstablished
  readonly action: ActionFactBoundary
  readonly evidence: EvidenceConclusionSet
}

const formedFutureCriticalPoints = new WeakMap<
  CandidateEnvelope,
  readonly FutureCriticalPoint[]
>()

interface CandidateBudgetKnown {
  readonly kind: 'known'
}

interface CandidateBudgetUnavailable {
  readonly kind: 'unknown' | 'over_budget'
}

type CandidateBudgetResult = CandidateBudgetKnown | CandidateBudgetUnavailable

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function directDigest(messageId: string, text: string): string {
  return createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
}

function identity<Code extends ContractCode, Subject>(contract: Code, subject: Subject) {
  return {
    contract,
    call: `${contract}:${randomUUID()}` as ContractCallRef,
    subject,
  }
}

function accepted<Code extends ContractCode, Subject, Value>(
  contract: Code,
  subject: Subject,
  value: Value,
): ContractReport<Code, Subject, Accepted<Value>> {
  return {
    kind: 'business_result',
    identity: identity(contract, subject),
    value: { kind: 'accepted_for_contract', value },
  }
}

function rejected<Code extends ContractCode, Subject>(
  contract: Code,
  subject: Subject,
): Extract<ContractReport<Code, Subject, unknown>, { readonly kind: 'rejected' }> {
  return {
    kind: 'rejected',
    identity: identity(contract, subject),
    reason: {
      kind: 'known_business_precondition_not_met',
      detail: `${contract}:rejection` as ContractScope<Code, 'rejection'>,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function frozenClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key])
  return result
}

function sameStructured(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right))
}

function withoutChat<Value extends { readonly chat: ChatRef }>(value: Value): Omit<Value, 'chat'> {
  const { chat: _chat, ...rest } = value
  return frozenClone(rest)
}

/** The sole fixed-field renderer used by the candidate author. */
export function renderCandidateBackground(material: CandidateRenderMaterial): SelfContainedBackgroundText {
  return JSON.stringify({
    format: 'f01-background-candidate-v1',
    target: material.target,
    direction: {
      currentMatter: material.focus.currentMatter,
      latestCorrections: material.focus.latestCorrections,
    },
    actionableFacts: material.action.usableFacts,
    uncertainties: material.action.unresolvedFacts,
    requiredFacts: material.action.requiredFacts,
    actionBoundary: {
      kind: material.action.kind,
      preciselyBlockedActions: material.action.preciselyBlockedActions,
      safelyContinuableActions: material.action.safelyContinuableActions,
    },
    evidenceConclusions: material.evidence.conclusions,
    knownFutureCriticalPoints: material.knownFutureCriticalPoints,
  }) as SelfContainedBackgroundText
}

function sameAssembly(left: CandidateAssemblySnapshot, right: CandidateAssemblySnapshot): boolean {
  return sameStructured(left, right)
}

function samePreparation(left: CandidatePreparationSnapshot, right: CandidatePreparationSnapshot): boolean {
  return sameStructured(left, right)
}

/** Mechanical validation only. Unknown inputs never become a guessed budget. */
export function evaluateFixedH1CandidateBudget(
  proof: FixedH1CandidateBudgetProof | undefined,
  body: SelfContainedBackgroundText,
  evidence: Pick<ExplicitBackgroundUpdateRuntimeEvidence, 'chat' | 'text' | 'origin'>,
): CandidateBudgetResult {
  if (proof?.kind !== 'fixed_h1_known_envelope') return { kind: 'unknown' }
  const assembly = proof.firstAssembly
  const preparation = proof.firstPreparation
  if (assembly === proof.secondAssembly
    || preparation === proof.secondPreparation
    || !sameAssembly(assembly, proof.secondAssembly)
    || !samePreparation(preparation, proof.secondPreparation)
    || !nonblank(assembly.fingerprint)
    || !nonblank(assembly.provider)
    || !nonblank(assembly.model)
    || !nonblank(assembly.headerFingerprint)
    || !nonblank(assembly.contextFingerprint)
    || !safeInteger(assembly.revision)
    || assembly.directChat !== evidence.chat
    || assembly.directMessageId !== evidence.origin.messageId
    || assembly.directText !== evidence.text
    || assembly.directHash !== evidence.origin.hash
    || evidence.origin.hash !== directDigest(evidence.origin.messageId, evidence.text)
    || !safeInteger(assembly.baseInputTokens)
    || !nonblank(preparation.fingerprint)
    || preparation.provider !== assembly.provider
    || preparation.model !== assembly.model
    || !safeInteger(preparation.contextWindow)
    || preparation.contextWindow === 0
    || !safeInteger(preparation.outputTokens)
    || !safeInteger(proof.bodyTokens)
    || proof.bodyTokens === 0
    || proof.bodyHash !== digest(body)
    || !safeInteger(proof.safeUpdateMarginTokens)) {
    return { kind: 'unknown' }
  }
  const required = assembly.baseInputTokens
    + proof.bodyTokens
    + preparation.outputTokens
    + proof.safeUpdateMarginTokens
  return required <= preparation.contextWindow ? { kind: 'known' } : { kind: 'over_budget' }
}

function candidateAffected(value: string): CandidateAffectedScope {
  return value as CandidateAffectedScope
}

function changed(
  authority: ChangedAuthorityFact['authority'],
  formedRef: string,
  currentRef: string,
): ChangedAuthorityFact {
  return Object.freeze({ authority, formedRef, currentRef })
}

function completeFocus(value: FocusDecision): value is FocusEstablished {
  return value.kind === 'focus_established'
    && nonblank(value.ref)
    && nonblank(value.chat)
    && nonblank(value.currentMatter)
}

function completeAction(value: ActionFactBoundary): boolean {
  return nonblank(value.ref) && nonblank(value.chat) && nonblank(value.requiredFacts.ref)
}

function completeEvidence(value: EvidenceConclusionSet): boolean {
  return nonblank(value.ref) && nonblank(value.chat)
}

function completeCandidate(candidate: CandidateEnvelope): boolean {
  return Object.isFrozen(candidate)
    && nonblank(candidate.ref)
    && nonblank(candidate.target)
    && nonblank(candidate.background)
    && candidate.basis.focus === candidate.formationFocus.ref
    && candidate.basis.actionFacts === candidate.formationActionBoundary.ref
    && candidate.basis.evidence === candidate.formationEvidence.ref
}

function completeCurrentCanonicalState(
  state: CanonicalStateForRollingCandidate,
): boolean {
  return Object.isFrozen(state)
    && state.kind === 'background'
    && nonblank(state.ref)
    && nonblank(state.target)
    && nonblank(state.candidateRef)
    && state.focus.kind === 'focus_established'
    && nonblank(state.focus.ref)
    && nonblank(state.focus.currentMatter)
    && nonblank(state.boundary.ref)
}

function sameBasis(left: CandidateBasis, right: CandidateBasis): boolean {
  return left.focus === right.focus
    && left.actionFacts === right.actionFacts
    && left.evidence === right.evidence
}

function completeFutureCriticalPoint(value: FutureCriticalPoint): boolean {
  const raw = isRecord(value) ? value : undefined
  return raw !== undefined
    && Object.isFrozen(value)
    && Object.keys(raw).length === 3
    && Object.keys(raw).every(key => key === 'conclusion' || key === 'appliesWhen' || key === 'futureUse')
    && nonblank(value.conclusion)
    && nonblank(value.appliesWhen)
    && nonblank(value.futureUse)
}

function completeFutureCriticalPoints(
  values: readonly FutureCriticalPoint[],
): boolean {
  return Object.isFrozen(values)
    && values.length <= 1
    && values.every(completeFutureCriticalPoint)
}

export class CandidateContentReviewer {
  readonly #qualification: CandidateContentReviewSink
  readonly #focus = new Map<ChatRef, FocusEstablished>()
  readonly #actions = new Map<ChatRef, ActionFactBoundary>()
  readonly #evidence = new Map<ChatRef, EvidenceConclusionSet>()
  readonly #reviewed = new WeakSet<CandidateEnvelope>()

  constructor(dependencies: CandidateContentReviewerDependencies) {
    this.#qualification = dependencies.qualification
  }

  acceptRequiredFocus(focus: FocusDecision): C04Result {
    if (!completeFocus(focus)) return rejected('C04', focus.ref) as C04Result
    this.#focus.set(focus.chat, focus)
    return accepted('C04', focus.ref, focus) as C04Result
  }

  acceptRequiredActionFacts(boundary: ActionFactBoundary): C16Result {
    if (!completeAction(boundary)) return rejected('C16', boundary.ref) as C16Result
    this.#actions.set(boundary.chat, boundary)
    return accepted('C16', boundary.ref, boundary) as C16Result
  }

  acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): C17Result {
    if (!completeEvidence(conclusions)) return rejected('C17', conclusions.ref) as C17Result
    this.#evidence.set(conclusions.chat, conclusions)
    return accepted('C17', conclusions.ref, conclusions) as C17Result
  }

  acceptCandidateForContentReview<Ref extends CandidateRef>(candidate: CandidateEnvelope<Ref>): C23Result<Ref> {
    const focus = this.#focus.get(candidate.target)
    const action = this.#actions.get(candidate.target)
    const evidence = this.#evidence.get(candidate.target)
    if (!completeCandidate(candidate) || this.#reviewed.has(candidate)
      || focus === undefined || action === undefined || evidence === undefined) {
      return rejected('C23', candidate.ref) as C23Result<Ref>
    }
    this.#reviewed.add(candidate)
    const expectedFocus = withoutChat(focus)
    const expectedAction = withoutChat(action)
    const expectedEvidence = withoutChat(evidence)
    const expectedFutureCriticalPoints = formedFutureCriticalPoints.get(candidate)
    const expectedBody = renderCandidateBackground({
      target: candidate.target,
      focus: expectedFocus,
      action: expectedAction,
      evidence: expectedEvidence,
      knownFutureCriticalPoints: expectedFutureCriticalPoints ?? Object.freeze([]),
    })
    const reasons: ContentFailureReason[] = []
    if (candidate.basis.focus !== focus.ref
      || candidate.basis.actionFacts !== action.ref
      || candidate.basis.evidence !== evidence.ref) {
      reasons.push('required_content_missing')
    }
    if (!sameStructured(candidate.formationFocus, expectedFocus)
      || !sameStructured(candidate.formationActionBoundary, expectedAction)
      || !sameStructured(candidate.formationEvidence, expectedEvidence)) {
      reasons.push('meaning_distorted')
    }
    if (!sameStructured(candidate.actionableFacts, action.usableFacts)
      || !sameStructured(candidate.uncertainties, action.unresolvedFacts)
      || candidate.background !== expectedBody) {
      reasons.push('action_facts_not_self_contained')
    }
    if (expectedFutureCriticalPoints === undefined
      || !completeFutureCriticalPoints(candidate.knownFutureCriticalPoints)
      || !sameStructured(candidate.knownFutureCriticalPoints, expectedFutureCriticalPoints)
      || candidate.background !== expectedBody) {
      reasons.push('forbidden_old_content_included')
    }
    const uniqueReasons = [...new Set(reasons)]
    const review: CandidateContentReviewDecision<Ref> = uniqueReasons.length === 0
      ? Object.freeze({ kind: 'passed', candidate })
      : Object.freeze({
          kind: 'failed',
          candidate,
          reasons: Object.freeze(uniqueReasons) as readonly [ContentFailureReason, ...ContentFailureReason[]],
          affected: candidateAffected('candidate-background'),
        })
    this.#qualification.acceptContentReview(review)
    return accepted('C23', candidate.ref, candidate) as C23Result<Ref>
  }
}

export class CandidateBasisFreshnessReviewer {
  readonly #qualification: CandidateFreshnessReviewSink
  readonly #focus = new Map<ChatRef, FocusEstablished>()
  readonly #actions = new Map<ChatRef, ActionFactBoundary>()
  readonly #evidence = new Map<ChatRef, EvidenceConclusionSet>()
  readonly #reviewed = new WeakSet<CandidateEnvelope>()

  constructor(dependencies: CandidateBasisFreshnessReviewerDependencies) {
    this.#qualification = dependencies.qualification
  }

  acceptCurrentFocus(focus: FocusDecision): C05Result {
    if (!completeFocus(focus)) return rejected('C05', focus.ref) as C05Result
    this.#focus.set(focus.chat, focus)
    return accepted('C05', focus.ref, focus) as C05Result
  }

  acceptCurrentActionFacts(boundary: ActionFactBoundary): C18Result {
    if (!completeAction(boundary)) return rejected('C18', boundary.ref) as C18Result
    this.#actions.set(boundary.chat, boundary)
    return accepted('C18', boundary.ref, boundary) as C18Result
  }

  acceptCurrentEvidence(conclusions: EvidenceConclusionSet): C19Result {
    if (!completeEvidence(conclusions)) return rejected('C19', conclusions.ref) as C19Result
    this.#evidence.set(conclusions.chat, conclusions)
    return accepted('C19', conclusions.ref, conclusions) as C19Result
  }

  acceptCandidateForFreshnessReview<Ref extends CandidateRef>(candidate: CandidateEnvelope<Ref>): C24Result<Ref> {
    const focus = this.#focus.get(candidate.target)
    const action = this.#actions.get(candidate.target)
    const evidence = this.#evidence.get(candidate.target)
    if (!completeCandidate(candidate) || this.#reviewed.has(candidate)
      || focus === undefined || action === undefined || evidence === undefined) {
      return rejected('C24', candidate.ref) as C24Result<Ref>
    }
    this.#reviewed.add(candidate)
    const changes: ChangedAuthorityFact[] = []
    if (candidate.basis.focus !== focus.ref
      || !sameStructured(candidate.formationFocus, withoutChat(focus))) {
      changes.push(changed('focus', candidate.basis.focus, focus.ref))
    }
    if (candidate.basis.actionFacts !== action.ref
      || !sameStructured(candidate.formationActionBoundary, withoutChat(action))) {
      changes.push(changed('action_facts', candidate.basis.actionFacts, action.ref))
    }
    if (candidate.basis.evidence !== evidence.ref
      || !sameStructured(candidate.formationEvidence, withoutChat(evidence))) {
      changes.push(changed('evidence', candidate.basis.evidence, evidence.ref))
    }
    const freshness: CandidateBasisFreshnessDecision<Ref> = changes.length === 0
      ? Object.freeze({ kind: 'current', candidate, basis: candidate.basis })
      : Object.freeze({
          kind: 'stale',
          candidate,
          basis: candidate.basis,
          changed: Object.freeze(changes) as readonly [ChangedAuthorityFact, ...ChangedAuthorityFact[]],
          affected: candidateAffected('candidate-basis'),
        })
    this.#qualification.acceptBasisFreshness(freshness)
    return accepted('C24', candidate.ref, candidate) as C24Result<Ref>
  }
}

export class BackgroundCandidateFormation {
  readonly #dependencies: BackgroundCandidateFormationDependencies
  readonly #focus = new Map<ChatRef, FocusEstablished>()
  readonly #actions = new Map<ChatRef, ActionFactBoundary>()
  readonly #evidence = new Map<ChatRef, EvidenceConclusionSet>()
  readonly #triggers = new Set<string>()
  readonly #currentCanonical = new Map<ChatRef, {
    readonly state: CanonicalStateForRollingCandidate
    readonly generation: number
  }>()
  readonly #lastExplicitBasis = new Map<ChatRef, CandidateBasis>()

  constructor(dependencies: BackgroundCandidateFormationDependencies) {
    this.#dependencies = dependencies
  }

  acceptFocusBasis(focus: FocusDecision): C03Result {
    if (!completeFocus(focus)) return rejected('C03', focus.ref) as C03Result
    this.#focus.set(focus.chat, focus)
    if (this.#actions.has(focus.chat) && this.#evidence.has(focus.chat)) {
      this.#formOrReport(focus.chat, undefined)
    }
    return accepted('C03', focus.ref, focus) as C03Result
  }

  acceptCapacityDecision(decision: CapacityDecision): C10Result {
    if (!nonblank(decision.ref) || !nonblank(decision.chat)) {
      return rejected('C10', decision.ref) as C10Result
    }
    if (decision.kind !== 'safe_update_margin_remains') {
      const trigger = `C10\0${decision.ref}`
      if (!this.#triggers.has(trigger)) {
        this.#triggers.add(trigger)
        this.#formOrReport(decision.chat, undefined)
      }
    }
    return accepted('C10', decision.ref, decision) as C10Result
  }

  /** C14 is a cache input in T1 and cannot create a rolling trigger. */
  acceptActionFactBoundary(boundary: ActionFactBoundary): C14Result {
    if (!completeAction(boundary)) return rejected('C14', boundary.ref) as C14Result
    this.#actions.set(boundary.chat, boundary)
    return accepted('C14', boundary.ref, boundary) as C14Result
  }

  /** C15 is likewise only a cache input in T1. */
  acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): C15Result {
    if (!completeEvidence(conclusions)) return rejected('C15', conclusions.ref) as C15Result
    this.#evidence.set(conclusions.chat, conclusions)
    return accepted('C15', conclusions.ref, conclusions) as C15Result
  }

  acceptCurrentCanonicalState(state: CanonicalStateForRollingCandidate): C41Result {
    const identity = currentCanonicalIdentities.get(state)
    if (!completeCurrentCanonicalState(state)
      || identity === undefined) {
      return rejected('C41', state.ref) as C41Result
    }
    const existing = this.#currentCanonical.get(state.target)
    if (existing !== undefined
      && (identity.generation < existing.generation
        || identity.generation === existing.generation && existing.state !== state)) {
      return rejected('C41', state.ref) as C41Result
    }
    this.#currentCanonical.set(state.target, Object.freeze({
      state,
      generation: identity.generation,
    }))
    return accepted('C41', state.ref, state) as C41Result
  }

  requestExplicitBackgroundUpdate(request: ExplicitBackgroundUpdateRequest): C38Result {
    if (!nonblank(request.chat)
      || this.#lastExplicitBasis.has(request.chat) && !this.#currentCanonical.has(request.chat)) {
      return rejected('C38', request.chat) as C38Result
    }
    const currentCanonical = this.#currentCanonical.get(request.chat)
    try {
      const evidence = this.#dependencies.runtimeEvidence.takeExplicitUpdateEvidence(request.chat)
      if (evidence === undefined
        || evidence.chat !== request.chat
        || evidence.text !== '请更新当前背景'
        || !nonblank(evidence.origin.messageId)
        || evidence.origin.hash !== directDigest(evidence.origin.messageId, evidence.text)) {
        this.#dependencies.qualification.acceptFormationResult({
          kind: 'safely_not_formed',
          chat: request.chat,
          reason: 'formation_unknown',
        })
        return accepted('C38', request.chat, Object.freeze({
          kind: 'trigger_accepted',
          chat: request.chat,
        })) as C38Result
      }
      const trigger = `C38\0${request.chat}\0${evidence.origin.hash}`
      if (this.#triggers.has(trigger)) {
        this.#dependencies.qualification.acceptFormationResult({
          kind: 'safely_not_formed',
          chat: request.chat,
          reason: 'formation_unknown',
        })
        return accepted('C38', request.chat, Object.freeze({
          kind: 'trigger_accepted',
          chat: request.chat,
        })) as C38Result
      }
      this.#triggers.add(trigger)
      this.#formOrReport(request.chat, evidence)
      return accepted('C38', request.chat, Object.freeze({
        kind: 'trigger_accepted',
        chat: request.chat,
      })) as C38Result
    } finally {
      if (currentCanonical !== undefined
        && this.#currentCanonical.get(request.chat) === currentCanonical) {
        this.#currentCanonical.delete(request.chat)
      }
    }
  }

  #basis(chat: ChatRef): FormationBasis | undefined {
    const focus = this.#focus.get(chat)
    const action = this.#actions.get(chat)
    const evidence = this.#evidence.get(chat)
    if (focus === undefined || action === undefined || evidence === undefined
      || focus.chat !== action.chat || action.chat !== evidence.chat) return undefined
    return { focus, action, evidence }
  }

  #formOrReport(chat: ChatRef, evidence: ExplicitBackgroundUpdateRuntimeEvidence | undefined): void {
    const basis = this.#basis(chat)
    if (basis === undefined) {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: 'basis_incomplete',
      })
      return
    }
    const lastExplicitBasis = this.#lastExplicitBasis.get(chat)
    const currentCanonical = this.#currentCanonical.get(chat)
    if (lastExplicitBasis !== undefined
      && (currentCanonical === undefined || sameBasis(lastExplicitBasis, {
        focus: basis.focus.ref,
        actionFacts: basis.action.ref,
        evidence: basis.evidence.ref,
      }))) {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: 'basis_incomplete',
      })
      return
    }
    const formationFocus = withoutChat(basis.focus)
    const formationActionBoundary = withoutChat(basis.action)
    const formationEvidence = withoutChat(basis.evidence)
    if (evidence?.futureCriticalPoints?.kind === 'unavailable') {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: 'future_critical_points_not_supported',
      })
      return
    }
    const knownFutureCriticalPoints = evidence?.futureCriticalPoints?.kind === 'projected'
      ? frozenClone(evidence.futureCriticalPoints.points)
      : Object.freeze([])
    if (!completeFutureCriticalPoints(knownFutureCriticalPoints)) {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: 'future_critical_points_not_supported',
      })
      return
    }
    const background = renderCandidateBackground({
      target: chat,
      focus: formationFocus,
      action: formationActionBoundary,
      evidence: formationEvidence,
      knownFutureCriticalPoints,
    })
    if (evidence === undefined) {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: 'candidate_budget_unknown',
      })
      return
    }
    const budget = evaluateFixedH1CandidateBudget(evidence.budget, background, evidence)
    if (budget.kind !== 'known') {
      this.#dependencies.qualification.acceptFormationResult({
        kind: 'safely_not_formed',
        chat,
        reason: budget.kind === 'over_budget' ? 'candidate_over_budget' : 'candidate_budget_unknown',
      })
      return
    }
    const candidateBasis: CandidateBasis = Object.freeze({
      focus: basis.focus.ref,
      actionFacts: basis.action.ref,
      evidence: basis.evidence.ref,
    })
    const ref = `candidate:${digest(JSON.stringify({
      chat,
      background,
      focus: candidateBasis.focus,
      action: candidateBasis.actionFacts,
      evidence: candidateBasis.evidence,
    }))}` as CandidateRef
    const candidate: CandidateEnvelope<typeof ref> = deepFreeze({
      ref,
      target: chat,
      background,
      actionableFacts: frozenClone(basis.action.usableFacts),
      uncertainties: frozenClone(basis.action.unresolvedFacts),
      knownFutureCriticalPoints,
      basis: candidateBasis,
      formationFocus,
      formationActionBoundary,
      formationEvidence,
    })
    if (currentCanonical !== undefined) {
      rollingCandidateGenerations.set(candidate, currentCanonical.generation)
      this.#currentCanonical.delete(chat)
    }
    this.#lastExplicitBasis.set(chat, candidateBasis)
    formedFutureCriticalPoints.set(candidate, knownFutureCriticalPoints)
    const formed: CandidateFormationResult<typeof ref> = Object.freeze({ kind: 'formed', candidate })
    const formationReport = this.#dependencies.qualification.acceptFormationResult(formed)
    if (formationReport.kind !== 'business_result') return
    this.#dependencies.contentReview.acceptCandidateForContentReview(candidate)
    this.#dependencies.freshnessReview.acceptCandidateForFreshnessReview(candidate)
  }
}
