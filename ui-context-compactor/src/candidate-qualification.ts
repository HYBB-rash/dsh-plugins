/**
 * F01 candidate qualification core.
 *
 * This module owns only the passive C25/C26/C27 conjunction.  It neither
 * creates candidates nor invokes either reviewer. A qualified decision is
 * delivered to one receiver and is authenticated for one later state
 * consumption by this authority's identity plus the exact decision/report
 * objects. No canonical/state/apply port is present here.
 */

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
  UsableFact,
  UnresolvedFact,
} from './action-boundary.ts'
import type {
  EvidenceConclusionSet,
  EvidenceConclusionSetRef,
} from './fact-resolution.ts'

declare const candidateBrand: unique symbol
type Brand<Name extends string> = string & { readonly [candidateBrand]: Name }

export type CandidateRef = Brand<'CandidateRef'>
export type SelfContainedBackgroundText = Brand<'SelfContainedBackgroundText'>
export type CandidateAffectedScope = Brand<'CandidateAffectedScope'>
export type QualificationReason = Brand<'QualificationReason'>
export type CandidatePromiseDescription = Brand<'CandidatePromiseDescription'>
export type FutureCriticalConclusion = Brand<'FutureCriticalConclusion'>
export type FutureCriticalCondition = Brand<'FutureCriticalCondition'>
export type FutureCriticalUse = Brand<'FutureCriticalUse'>

export interface FutureCriticalPoint {
  readonly conclusion: FutureCriticalConclusion
  readonly appliesWhen: FutureCriticalCondition
  readonly futureUse: FutureCriticalUse
}

export type CandidateFocusSnapshot = Omit<
  Extract<FocusDecision, { readonly kind: 'focus_established' }>,
  'chat'
>
export type CandidateActionSnapshot = Omit<ActionFactBoundary, 'chat'>
export type CandidateEvidenceSnapshot = Omit<EvidenceConclusionSet, 'chat'>

export interface CandidateBasis {
  readonly focus: FocusDecisionRef
  readonly actionFacts: ActionFactBoundaryRef
  readonly evidence: EvidenceConclusionSetRef
}

export interface CandidateEnvelope<Ref extends CandidateRef = CandidateRef> {
  readonly ref: Ref
  readonly target: ChatRef
  readonly background: SelfContainedBackgroundText
  readonly actionableFacts: readonly UsableFact[]
  readonly uncertainties: readonly UnresolvedFact[]
  readonly knownFutureCriticalPoints: readonly FutureCriticalPoint[]
  readonly basis: CandidateBasis
  readonly formationFocus: CandidateFocusSnapshot
  readonly formationActionBoundary: CandidateActionSnapshot
  readonly formationEvidence: CandidateEvidenceSnapshot
}

export type SafeNonFormationReason =
  | 'no_focus'
  | 'matter_relation_pending'
  | 'required_facts_insufficient'
  | 'evidence_conflict'
  | 'non_capacity_safety_constraint'
  | 'basis_incomplete'
  | 'candidate_budget_unknown'
  | 'candidate_over_budget'
  | 'future_critical_points_not_supported'
  | 'formation_unknown'

export type CandidateFormationResult<Ref extends CandidateRef = CandidateRef> =
  | { readonly kind: 'formed'; readonly candidate: CandidateEnvelope<Ref> }
  | { readonly kind: 'safely_not_formed'; readonly chat: ChatRef; readonly reason: SafeNonFormationReason }

export type ContentFailureReason =
  | 'required_content_missing'
  | 'meaning_distorted'
  | 'action_facts_not_self_contained'
  | 'forbidden_old_content_included'

/** C26 carries the same actual envelope object, not merely a matching string. */
export type CandidateContentReviewDecision<Ref extends CandidateRef = CandidateRef> =
  | { readonly kind: 'passed'; readonly candidate: CandidateEnvelope<Ref> }
  | {
      readonly kind: 'failed'
      readonly candidate: CandidateEnvelope<Ref>
      readonly reasons: readonly [ContentFailureReason, ...ContentFailureReason[]]
      readonly affected: CandidateAffectedScope
    }

export interface ChangedAuthorityFact {
  readonly authority: 'focus' | 'action_facts' | 'evidence'
  readonly formedRef: string
  readonly currentRef: string
}

/** C27 also carries the same actual envelope object. */
export type CandidateBasisFreshnessDecision<Ref extends CandidateRef = CandidateRef> =
  | {
      readonly kind: 'current'
      readonly candidate: CandidateEnvelope<Ref>
      readonly basis: CandidateBasis
    }
  | {
      readonly kind: 'stale'
      readonly candidate: CandidateEnvelope<Ref>
      readonly basis: CandidateBasis
      readonly changed: readonly [ChangedAuthorityFact, ...ChangedAuthorityFact[]]
      readonly affected: CandidateAffectedScope
    }

export type PassedContentEvidence<Ref extends CandidateRef = CandidateRef> = Extract<
  CandidateContentReviewDecision<Ref>,
  { readonly kind: 'passed' }
>
export type CurrentFreshnessEvidence<Ref extends CandidateRef = CandidateRef> = Extract<
  CandidateBasisFreshnessDecision<Ref>,
  { readonly kind: 'current' }
>

export type CandidateSubject<Ref extends CandidateRef = CandidateRef> =
  | { readonly kind: 'candidate'; readonly candidate: CandidateEnvelope<Ref> }
  | { readonly kind: 'no_candidate'; readonly chat: ChatRef }

export type CandidateQualificationDecision<Ref extends CandidateRef = CandidateRef> =
  | {
      readonly kind: 'qualified'
      readonly candidate: CandidateEnvelope<Ref>
      readonly content: PassedContentEvidence<Ref>
      readonly freshness: CurrentFreshnessEvidence<Ref>
    }
  | {
      readonly kind: 'explicitly_disqualified'
      readonly subject: Extract<CandidateSubject<Ref>, { readonly kind: 'candidate' }>
      readonly reasons: readonly [QualificationReason, ...QualificationReason[]]
      readonly affected: CandidateAffectedScope
    }
  | {
      readonly kind: 'currently_unprovable'
      readonly subject: CandidateSubject<Ref>
      readonly missingOrUncertain: readonly [CandidatePromiseDescription, ...CandidatePromiseDescription[]]
      readonly affected: CandidateAffectedScope
    }

export type CandidateQualificationIssue<Ref extends CandidateRef = CandidateRef> = Extract<
  CandidateQualificationDecision<Ref>,
  { readonly kind: 'explicitly_disqualified' | 'currently_unprovable' }
>

export type C25Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C25',
  CandidateSubject<Ref>,
  Accepted<CandidateFormationResult<Ref>>
>
export type C26Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C26',
  Ref,
  Accepted<CandidateContentReviewDecision<Ref>>
>
export type C27Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C27',
  Ref,
  Accepted<CandidateBasisFreshnessDecision<Ref>>
>
export type C28Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C28',
  CandidateSubject<Ref>,
  Accepted<CandidateQualificationDecision<Ref>>
>
export type C42Result<Ref extends CandidateRef = CandidateRef> = ContractReport<
  'C42',
  CandidateSubject<Ref>,
  Accepted<CandidateQualificationIssue<Ref>>
>

export interface CandidateQualificationReceiver {
  acceptCandidateQualification<Ref extends CandidateRef>(
    decision: Extract<CandidateQualificationDecision<Ref>, { readonly kind: 'qualified' }>,
  ): C28Result<Ref>
}

/** Compatibility name for the pre-apply read-only receiver shape. */
export type ReadOnlyCandidateQualificationObserver = CandidateQualificationReceiver

export interface CandidateQualificationIssueReceiver {
  acceptCandidateQualificationIssue<Ref extends CandidateRef>(
    issue: CandidateQualificationIssue<Ref>,
  ): C42Result<Ref>
}

export interface CandidateQualificationDependencies {
  readonly observer: CandidateQualificationReceiver
  readonly userAdvice: CandidateQualificationIssueReceiver
}

interface QualificationRun<Ref extends CandidateRef = CandidateRef> {
  readonly candidate: CandidateEnvelope<Ref>
  content?: CandidateContentReviewDecision<Ref>
  freshness?: CandidateBasisFreshnessDecision<Ref>
  terminal: boolean
}

type QualifiedDecision<Ref extends CandidateRef = CandidateRef> = Extract<
  CandidateQualificationDecision<Ref>,
  { readonly kind: 'qualified' }
>

const authenticQualifications = new WeakMap<
  CandidateQualificationAuthority,
  WeakMap<C28Result, QualifiedDecision>
>()

function identity<Code extends ContractCode, Subject>(
  contract: Code,
  subject: Subject,
) {
  return {
    contract,
    call: `${contract}:${crypto.randomUUID()}` as ContractCallRef,
    subject,
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

function nonblank(value: string): boolean {
  return value.trim().length > 0
}

function authenticCandidate(candidate: CandidateEnvelope): boolean {
  return Object.isFrozen(candidate)
    && nonblank(candidate.ref)
    && nonblank(candidate.target)
    && nonblank(candidate.background)
    && candidate.basis.focus === candidate.formationFocus.ref
    && candidate.basis.actionFacts === candidate.formationActionBoundary.ref
    && candidate.basis.evidence === candidate.formationEvidence.ref
}

function subjectOf<Ref extends CandidateRef>(
  candidate: CandidateEnvelope<Ref>,
): Extract<CandidateSubject<Ref>, { readonly kind: 'candidate' }> {
  return Object.freeze({ kind: 'candidate', candidate })
}

function affected(value: string): CandidateAffectedScope {
  return value as CandidateAffectedScope
}

function promise(value: string): CandidatePromiseDescription {
  return value as CandidatePromiseDescription
}

function qualificationReason(value: string): QualificationReason {
  return value as QualificationReason
}

function exactQualifiedReport<Ref extends CandidateRef>(
  report: C28Result<Ref>,
  decision: QualifiedDecision<Ref>,
): boolean {
  return report.kind === 'business_result'
    && report.identity.contract === 'C28'
    && report.identity.subject.kind === 'candidate'
    && report.identity.subject.candidate === decision.candidate
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === decision
}

/**
 * Passive C25/C26/C27 authority.  Correct inputs are consumed once per actual
 * envelope object; cloned or foreign objects cannot occupy the real run.
 */
export class CandidateQualificationAuthority {
  readonly #dependencies: CandidateQualificationDependencies
  readonly #runs = new Map<CandidateRef, QualificationRun>()
  readonly #closedWithoutCandidate = new Set<string>()

  constructor(dependencies: CandidateQualificationDependencies) {
    this.#dependencies = dependencies
    authenticQualifications.set(this, new WeakMap())
  }

  acceptFormationResult<Ref extends CandidateRef>(
    result: CandidateFormationResult<Ref>,
  ): C25Result<Ref> {
    if (result.kind === 'safely_not_formed') {
      const subject: CandidateSubject<Ref> = Object.freeze({
        kind: 'no_candidate',
        chat: result.chat,
      })
      const key = `${result.chat}\0${result.reason}`
      if (!nonblank(result.chat) || this.#closedWithoutCandidate.has(key)) {
        return rejected('C25', subject) as C25Result<Ref>
      }
      this.#closedWithoutCandidate.add(key)
      const issue: CandidateQualificationIssue<Ref> = Object.freeze({
        kind: 'currently_unprovable',
        subject,
        missingOrUncertain: Object.freeze([
          promise(result.reason),
        ]) as readonly [CandidatePromiseDescription, ...CandidatePromiseDescription[]],
        affected: affected('candidate-qualification'),
      })
      this.#dependencies.userAdvice.acceptCandidateQualificationIssue(issue)
      return accepted('C25', subject, result) as C25Result<Ref>
    }

    const candidate = result.candidate
    const subject = subjectOf(candidate)
    const existing = this.#runs.get(candidate.ref)
    if (!authenticCandidate(candidate) || existing !== undefined) {
      return rejected('C25', subject) as C25Result<Ref>
    }
    this.#runs.set(candidate.ref, { candidate, terminal: false })
    return accepted('C25', subject, result) as C25Result<Ref>
  }

  acceptContentReview<Ref extends CandidateRef>(
    review: CandidateContentReviewDecision<Ref>,
  ): C26Result<Ref> {
    const candidate = review.candidate
    const ref = candidate?.ref
    const run = typeof ref === 'string' ? this.#runs.get(ref as CandidateRef) : undefined
    if (run === undefined || run.terminal || run.candidate !== candidate || run.content !== undefined) {
      return rejected('C26', (ref ?? 'candidate-ref:invalid') as Ref) as C26Result<Ref>
    }
    run.content = review as CandidateContentReviewDecision
    const report = accepted('C26', candidate.ref, review) as C26Result<Ref>
    if (review.kind === 'failed') {
      this.#emitDisqualified(run, review.reasons.map(qualificationReason) as [QualificationReason, ...QualificationReason[]], review.affected)
    } else {
      this.#maybeQualify(run)
    }
    return report
  }

  acceptBasisFreshness<Ref extends CandidateRef>(
    freshness: CandidateBasisFreshnessDecision<Ref>,
  ): C27Result<Ref> {
    const candidate = freshness.candidate
    const ref = candidate?.ref
    const run = typeof ref === 'string' ? this.#runs.get(ref as CandidateRef) : undefined
    if (run === undefined || run.terminal || run.candidate !== candidate || run.freshness !== undefined
      || freshness.basis !== candidate.basis) {
      return rejected('C27', (ref ?? 'candidate-ref:invalid') as Ref) as C27Result<Ref>
    }
    run.freshness = freshness as CandidateBasisFreshnessDecision
    const report = accepted('C27', candidate.ref, freshness) as C27Result<Ref>
    if (freshness.kind === 'stale') {
      const reasons = freshness.changed.map(change => qualificationReason(
        `${change.authority}:${change.formedRef}->${change.currentRef}`,
      )) as [QualificationReason, ...QualificationReason[]]
      this.#emitDisqualified(run, reasons, freshness.affected)
    } else {
      this.#maybeQualify(run)
    }
    return report
  }

  #emitDisqualified(
    run: QualificationRun,
    reasons: readonly [QualificationReason, ...QualificationReason[]],
    scope: CandidateAffectedScope,
  ): void {
    if (run.terminal) return
    run.terminal = true
    const issue: CandidateQualificationIssue = Object.freeze({
      kind: 'explicitly_disqualified',
      subject: subjectOf(run.candidate),
      reasons: Object.freeze([...reasons]) as readonly [QualificationReason, ...QualificationReason[]],
      affected: scope,
    })
    this.#dependencies.userAdvice.acceptCandidateQualificationIssue(issue)
  }

  #maybeQualify(run: QualificationRun): void {
    if (run.terminal || run.content?.kind !== 'passed' || run.freshness?.kind !== 'current') return
    run.terminal = true
    const decision: Extract<CandidateQualificationDecision, { readonly kind: 'qualified' }> = Object.freeze({
      kind: 'qualified',
      candidate: run.candidate,
      content: run.content,
      freshness: run.freshness,
    })
    const report = this.#dependencies.observer.acceptCandidateQualification(decision)
    if (!exactQualifiedReport(report, decision)) return
    authenticQualifications.get(this)?.set(report, decision)
  }
}

/**
 * State's one-use C28 bridge. Wrong owner or structurally copied objects leave
 * the genuine owner-issued decision/report association available.
 */
export function consumeAuthenticCandidateQualification<Ref extends CandidateRef>(
  authority: CandidateQualificationAuthority,
  report: C28Result<Ref>,
  decision: QualifiedDecision<Ref>,
): boolean {
  const qualifications = authenticQualifications.get(authority)
  if (qualifications?.get(report) !== decision || !exactQualifiedReport(report, decision)) return false
  qualifications.delete(report)
  return true
}
