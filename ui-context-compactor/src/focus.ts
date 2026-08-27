/**
 * Focus C01/C08 business boundary for the temporary H1 canary.
 *
 * The provider's proposal is deliberately not a C01 input. It is only
 * construction material for this authority; callers can invoke C01 with an
 * explicit user expression and receive the full contract-report vocabulary.
 */

import { createHash } from 'node:crypto'
import {
  isAuthenticFinalizedRecoveryBridge,
  isAuthenticFinalizedC34Bridge,
  isAuthenticRecoveryClaim,
  isAuthenticRecoveryFailureBridge,
  type C34Result,
} from './state-transaction.ts'
import type {
  C38Result,
  ExplicitBackgroundUpdateRequest,
} from './candidate.ts'
import type {
  CandidateRef,
  CandidateQualificationIssue,
  C42Result,
  ContentFailureReason,
  SafeNonFormationReason,
} from './candidate-qualification.ts'

export const FOCUS_CANARY_ERROR = 'focus-canary'

declare const focusBusinessBrand: unique symbol

export type Branded<Name extends string, Base = string> = Base & {
  readonly [focusBusinessBrand]: Name
}

export type ChatRef = Branded<'ChatRef'>
export type FocusDecisionRef = Branded<'FocusDecisionRef'>
export type ContractCallRef = Branded<'ContractCallRef'>
export type ContractCode =
  | 'C01' | 'C02' | 'C03' | 'C04' | 'C05' | 'C06' | 'C07' | 'C08' | 'C09' | 'C10'
  | 'C11' | 'C12' | 'C13' | 'C14' | 'C15' | 'C16' | 'C17' | 'C18' | 'C19' | 'C20'
  | 'C21' | 'C22' | 'C23' | 'C24' | 'C25' | 'C26' | 'C27' | 'C28' | 'C29' | 'C30'
  | 'C31' | 'C32' | 'C33' | 'C34' | 'C35' | 'C36' | 'C37' | 'C38' | 'C39' | 'C40'
  | 'C41' | 'C42' | 'C43'
export type CurrentMatterMeaning = Branded<'CurrentMatterMeaning'>
export type CorrectionMeaning = Branded<'CorrectionMeaning'>
export type UserDecisionPoint = Branded<'UserDecisionPoint'>
export type ContractScope<Code extends ContractCode, Kind extends string> = Branded<`${Code}:${Kind}`>

export interface ExplicitUserExpression {
  readonly expression: Branded<'ExplicitUserExpression'>
  readonly chat: ChatRef
}

/** Runtime-only evidence: deliberately absent from the public C01 object shape. */
export interface DirectExpressionOrigin {
  readonly messageId: string
  readonly hash: string
}

const originEvidence = Symbol('focus-canary-origin')

/** Build the public expression while binding non-enumerable direct-event evidence. */
export function createExplicitUserExpression(
  expression: string,
  chat: ChatRef,
  origin: DirectExpressionOrigin,
): ExplicitUserExpression {
  const value = {
    expression: expression as Branded<'ExplicitUserExpression'>,
    chat,
  }
  Object.defineProperty(value, originEvidence, {
    value: Object.freeze({ ...origin }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(value)
}

function originOf(expression: ExplicitUserExpression): DirectExpressionOrigin | undefined {
  const value = expression as ExplicitUserExpression & {
    readonly [originEvidence]?: DirectExpressionOrigin
  }
  return value[originEvidence]
}

export type FocusDecision =
  | {
      readonly kind: 'focus_established'
      readonly ref: FocusDecisionRef
      readonly chat: ChatRef
      readonly currentMatter: CurrentMatterMeaning
      readonly latestCorrections: CorrectionMeaning
    }
  | {
      readonly kind: 'no_focus'
      readonly ref: FocusDecisionRef
      readonly chat: ChatRef
      readonly latestCorrections: CorrectionMeaning
    }
  | {
      readonly kind: 'matter_relation_pending'
      readonly ref: FocusDecisionRef
      readonly chat: ChatRef
      readonly latestCorrections: CorrectionMeaning
      readonly pendingPoint: UserDecisionPoint
    }
  | {
      readonly kind: 'multiple_unrelated_matters_pending'
      readonly ref: FocusDecisionRef
      readonly chat: ChatRef
      readonly latestCorrections: CorrectionMeaning
      readonly pendingPoint: UserDecisionPoint
    }

export type Accepted<Value> = { readonly kind: 'accepted_for_contract'; readonly value: Value }

export type ContractIdentity<Code extends ContractCode, Subject> = {
  readonly contract: Code
  readonly call: ContractCallRef
  readonly subject: Subject
}

export interface NoUsableEstablishedFact<Code extends ContractCode> {
  readonly kind: 'no_usable_established_fact'
  readonly processedPart: ContractScope<Code, 'processed_part'>
}

export type ContractRejection<Code extends ContractCode> =
  | { readonly kind: 'outside_receiver_authority'; readonly detail: ContractScope<Code, 'rejection'> }
  | { readonly kind: 'target_not_uniquely_identified'; readonly detail: ContractScope<Code, 'rejection'> }
  | { readonly kind: 'known_business_precondition_not_met'; readonly detail: ContractScope<Code, 'rejection'> }

export interface ContractProblem<
  Code extends ContractCode,
  Kind extends 'failure' | 'unknown',
> {
  readonly detail: ContractScope<Code, Kind>
  readonly affected: ContractScope<Code, `${Kind}_scope`>
}

export type ContractReport<
  Code extends ContractCode,
  Subject,
  Business,
  PartialEstablished = NoUsableEstablishedFact<Code>,
> =
  | { readonly kind: 'received'; readonly identity: ContractIdentity<Code, Subject> }
  | { readonly kind: 'accepted'; readonly identity: ContractIdentity<Code, Subject> }
  | { readonly kind: 'business_result'; readonly identity: ContractIdentity<Code, Subject>; readonly value: Business }
  | {
      readonly kind: 'rejected'
      readonly identity: ContractIdentity<Code, Subject>
      readonly reason: ContractRejection<Code>
    }
  | {
      readonly kind: 'known_failure'
      readonly identity: ContractIdentity<Code, Subject>
      readonly problem: ContractProblem<Code, 'failure'>
    }
  | {
      readonly kind: 'unknown'
      readonly identity: ContractIdentity<Code, Subject>
      readonly problem: ContractProblem<Code, 'unknown'>
    }
  | {
      readonly kind: 'partial'
      readonly identity: ContractIdentity<Code, Subject>
      readonly established: PartialEstablished
      readonly notEstablished: ContractScope<Code, 'partial_missing_scope'>
    }

export type C01Result = ContractReport<'C01', ExplicitUserExpression, FocusDecision>
export type C08Result = ContractReport<'C08', FocusDecisionRef, Accepted<FocusDecision>>
/** The public C35 input deliberately omits close input and storage details. */
export type WithoutChat<Value> = Value extends { readonly chat: ChatRef } ? Omit<Value, 'chat'> : Value
export type PreservedFocusDecision = WithoutChat<FocusDecision>
export interface RestoredFocusFact {
  readonly target: ChatRef
  readonly focus: PreservedFocusDecision
}
export type C35Result = ContractReport<'C35', FocusDecisionRef, Accepted<RestoredFocusFact>>

/** Untrusted input produced by the bounded auxiliary runtime, never a C01 signature. */
export interface NewFocusProposal {
  readonly kind: 'focus'
  readonly subject: string
  readonly relation: 'new'
  readonly origin: DirectExpressionOrigin
}

/** A narrow H2 canary proposal: it can only suggest closing the current matter. */
export interface CloseFocusProposal {
  readonly kind: 'close'
  readonly relation: 'current'
  readonly origin: DirectExpressionOrigin
}

export type FocusProposal = NewFocusProposal | CloseFocusProposal

export type FocusProposalOutcome =
  | { readonly kind: 'proposal'; readonly value: FocusProposal; readonly origin: DirectExpressionOrigin }
  | { readonly kind: 'known_failure'; readonly code: typeof FOCUS_CANARY_ERROR; readonly origin: DirectExpressionOrigin }
  | { readonly kind: 'unknown'; readonly code: typeof FOCUS_CANARY_ERROR; readonly origin: DirectExpressionOrigin }

function call<Code extends ContractCode, Subject>(
  code: Code,
  subject: Subject,
): ContractIdentity<Code, Subject> {
  return {
    contract: code,
    call: `${code}:${crypto.randomUUID()}` as ContractCallRef,
    subject,
  }
}

function scope<Code extends ContractCode, Kind extends string>(
  code: Code,
  kind: Kind,
): ContractScope<Code, Kind> {
  return `${code}:${kind}` as ContractScope<Code, Kind>
}

/**
 * The process-local focus authority signs both C01 and C35. Proposal material
 * is kept in a one-shot bound capability so concurrent A/B calls cannot share
 * or overwrite it. The owner itself never stores an untrusted proposal.
 */
const boundFocusPorts = new WeakMap<FocusAuthority, (expression: ExplicitUserExpression, proposal: FocusProposalOutcome) => C01Result>()
const restoredFacts = new WeakMap<FocusAuthority, WeakSet<RestoredFocusFact>>()
const acceptedRestoredReports = new WeakMap<FocusAuthority, WeakSet<C35Result>>()
const claimedRestoredReports = new WeakMap<FocusAuthority, WeakSet<C35Result>>()

export interface EstablishedFocusCandidateReceivers {
  readonly formation: {
    acceptFocusBasis(focus: FocusDecision): unknown
  }
  readonly contentReview: {
    acceptRequiredFocus(focus: FocusDecision): unknown
  }
  readonly freshnessReview: {
    acceptCurrentFocus(focus: FocusDecision): unknown
  }
}

const establishedFocusCandidateReceivers = new WeakMap<FocusAuthority, EstablishedFocusCandidateReceivers>()

/** @internal One process-local binding, installed before any direct focus input. */
export function bindEstablishedFocusCandidateReceivers(
  authority: FocusAuthority,
  receivers: EstablishedFocusCandidateReceivers,
): boolean {
  if (establishedFocusCandidateReceivers.has(authority)
    || typeof receivers.formation?.acceptFocusBasis !== 'function'
    || typeof receivers.contentReview?.acceptRequiredFocus !== 'function'
    || typeof receivers.freshnessReview?.acceptCurrentFocus !== 'function') return false
  establishedFocusCandidateReceivers.set(authority, Object.freeze({ ...receivers }))
  return true
}

function acceptedSameFocus(
  report: unknown,
  contract: 'C03' | 'C04' | 'C05',
  focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>,
): boolean {
  if (report === null || typeof report !== 'object') return false
  const value = report as {
    readonly kind?: unknown
    readonly identity?: { readonly contract?: unknown; readonly subject?: unknown }
    readonly value?: { readonly kind?: unknown; readonly value?: unknown }
  }
  return value.kind === 'business_result'
    && value.identity?.contract === contract
    && value.identity.subject === focus.ref
    && value.value?.kind === 'accepted_for_contract'
    && value.value.value === focus
}

function fanoutEstablishedFocus(
  authority: FocusAuthority,
  focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>,
): boolean {
  const receivers = establishedFocusCandidateReceivers.get(authority)
  if (receivers === undefined) return true
  try {
    // Review standards are established first. Formation is last, so a failed
    // reviewer delivery cannot expose a candidate with only one reviewer live.
    const c04 = receivers.contentReview.acceptRequiredFocus(focus)
    if (!acceptedSameFocus(c04, 'C04', focus)) return false
    const c05 = receivers.freshnessReview.acceptCurrentFocus(focus)
    if (!acceptedSameFocus(c05, 'C05', focus)) return false
    const c03 = receivers.formation.acceptFocusBasis(focus)
    return acceptedSameFocus(c03, 'C03', focus)
  } catch {
    return false
  }
}

/** C35 restores only an established focus or the existing no-focus result. */
function isRestorableFocus(focus: PreservedFocusDecision): boolean {
  if (focus.ref.length === 0 || focus.latestCorrections === undefined) return false
  return (focus.kind === 'no_focus')
    || (focus.kind === 'focus_established' && focus.currentMatter !== undefined)
}

interface VerifiedFinalizedNoFocusChain {
  readonly chat: string
  readonly ref: string
  readonly latestCorrections: string
}

interface VerifiedFinalizedEstablishedFocusChain extends VerifiedFinalizedNoFocusChain {
  readonly currentMatter: string
}

/** @internal Token-gated finalized-chain rehydration, not a general raw decoder. */
export function rehydrateFinalizedNoFocusChain(
  authority: FocusAuthority,
  token: object,
  input: VerifiedFinalizedNoFocusChain,
): {
  readonly chat: ChatRef
  readonly ref: FocusDecisionRef
  readonly latestCorrections: CorrectionMeaning
} | undefined {
  if (!isAuthenticFinalizedRecoveryBridge(authority, token, input)) return undefined
  if (input.chat.length === 0
    || !/^no-focus:[0-9a-f]{64}$/.test(input.ref)
    || input.latestCorrections === undefined) return undefined
  return Object.freeze({
    chat: input.chat as ChatRef,
    ref: input.ref as FocusDecisionRef,
    latestCorrections: input.latestCorrections as CorrectionMeaning,
  })
}

/** @internal Token-gated finalized-chain rehydration for the fixed local family. */
export function rehydrateFinalizedEstablishedFocusChain(
  authority: FocusAuthority,
  token: object,
  input: VerifiedFinalizedEstablishedFocusChain,
): {
  readonly chat: ChatRef
  readonly ref: FocusDecisionRef
  readonly currentMatter: CurrentMatterMeaning
  readonly latestCorrections: CorrectionMeaning
} | undefined {
  if (!isAuthenticFinalizedRecoveryBridge(authority, token, input)) return undefined
  if (input.chat.length === 0 || !/^focus:[0-9a-f]{64}$/.test(input.ref)
    || input.currentMatter.trim().length === 0 || input.latestCorrections === undefined) return undefined
  return Object.freeze({
    chat: input.chat as ChatRef,
    ref: input.ref as FocusDecisionRef,
    currentMatter: input.currentMatter as CurrentMatterMeaning,
    latestCorrections: input.latestCorrections as CorrectionMeaning,
  })
}

/** @internal Token-gated failure target from the real Session identity only. */
export function rehydrateRecoveryFailureTarget(
  authority: FocusAuthority,
  token: object,
  session: object,
  sessionId: string,
): ChatRef | undefined {
  if (sessionId.trim().length === 0 || !isAuthenticRecoveryFailureBridge(authority, token, session, sessionId)) return undefined
  return sessionId as ChatRef
}

export class FocusAuthority {
  private constructor() {
    boundFocusPorts.set(this, (expression, proposal) => this.decideBoundFocus(expression, proposal))
    restoredFacts.set(this, new WeakSet())
    acceptedRestoredReports.set(this, new WeakSet())
    claimedRestoredReports.set(this, new WeakSet())
  }

  /** One formal owner per installed plugin/context; index owns its lifecycle. */
  static createOwner(): FocusAuthority {
    return new FocusAuthority()
  }

  /**
   * Compatibility-only entry for existing characterization callers. Production
   * installation captures one owner and calls its instance method instead.
   */
  static fromBoundProposal(proposal: FocusProposalOutcome): BoundFocusProposal {
    return FocusAuthority.createOwner().fromBoundProposal(proposal)
  }

  fromBoundProposal(proposal: FocusProposalOutcome): BoundFocusProposal {
    return new BoundFocusProposal(this, proposal)
  }

  /** C35 receiver: only a successful C34 report may be decoded into this fact. */
  acceptRestoredFocusFact(fact: RestoredFocusFact): C35Result {
    const identity = call('C35', fact.focus.ref)
    const issued = restoredFacts.get(this)
    if (issued === undefined || !issued.has(fact)
      || fact.target.length === 0
      || !isRestorableFocus(fact.focus)) {
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C35', 'rejection') },
      }
    }
    issued.delete(fact)
    const report: C35Result = { kind: 'business_result', identity, value: { kind: 'accepted_for_contract', value: fact } }
    acceptedRestoredReports.get(this)?.add(report)
    return report
  }

  /** The C01 implementation stays proposal-bound; only the binding moved out. */
  private decideBoundFocus(expression: ExplicitUserExpression, proposalOutcome: FocusProposalOutcome): C01Result {
    const identity = call('C01', expression)
    const origin = originOf(expression)
    if (expression.expression.trim().length === 0 || expression.chat.length === 0 || origin === undefined) {
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
      }
    }
    // Admission establishes direct-user eligibility from the structured
    // inbox identity and same-id claim. Recompute the digest here only to
    // detect wrong binding or mutation of that admitted id/text pair; it is
    // not authentication for an arbitrary in-process caller, and C01 does
    // not acquire a Session dependency to attempt one.
    const expectedHash = createHash('sha256')
      .update(origin.messageId)
      .update('\0')
      .update(expression.expression)
      .digest('hex')
    if (origin.messageId.trim().length === 0 || origin.hash !== expectedHash) {
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
      }
    }
    if (proposalOutcome.origin.messageId !== origin.messageId || proposalOutcome.origin.hash !== origin.hash) {
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
      }
    }
    if (proposalOutcome.kind === 'known_failure') {
      return {
        kind: 'known_failure',
        identity,
        problem: { detail: scope('C01', 'failure'), affected: scope('C01', 'failure_scope') },
      }
    }
    if (proposalOutcome.kind === 'unknown') {
      return {
        kind: 'unknown',
        identity,
        problem: { detail: scope('C01', 'unknown'), affected: scope('C01', 'unknown_scope') },
      }
    }
    const matter = expression.expression.trim()
    const proposal = proposalOutcome.value
    if (proposal.origin.messageId !== origin.messageId
      || proposal.origin.hash !== origin.hash
      || matter.length > 240) {
      return {
        kind: 'known_failure',
        identity,
        problem: { detail: scope('C01', 'failure'), affected: scope('C01', 'failure_scope') },
      }
    }
    if (proposal.kind === 'close') {
      // The auxiliary output is untrusted. H2 recognizes exactly this narrow
      // direct-user close expression so "好，谢谢" can never become no-focus
      // merely because a provider classified it that way.
      if (proposal.relation !== 'current' || matter !== '这件事结束了') {
        return {
          kind: 'rejected',
          identity,
          reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
        }
      }
      return {
        kind: 'business_result',
        identity,
        value: Object.freeze({
          kind: 'no_focus',
          ref: `no-focus:${createHash('sha256')
            .update(expression.chat)
            .update('\0')
            .update(origin.messageId)
            .update('\0')
            .update(origin.hash)
            .digest('hex')}` as FocusDecisionRef,
          chat: expression.chat,
          latestCorrections: '' as CorrectionMeaning,
        }),
      }
    }
    if (proposal.subject.trim().length === 0
      || proposal.subject.length > 240
      || proposal.relation !== 'new') {
      return {
        kind: 'known_failure',
        identity,
        problem: { detail: scope('C01', 'failure'), affected: scope('C01', 'failure_scope') },
      }
    }
    const decision = Object.freeze({
      kind: 'focus_established' as const,
      ref: `focus:${createHash('sha256')
        .update(expression.chat)
        .update('\0')
        .update(origin.messageId)
        .update('\0')
        .update(origin.hash)
        .digest('hex')}` as FocusDecisionRef,
      chat: expression.chat,
      currentMatter: matter as CurrentMatterMeaning,
      latestCorrections: '' as CorrectionMeaning,
    })
    if (!fanoutEstablishedFocus(this, decision)) {
      return {
        kind: 'known_failure',
        identity,
        problem: { detail: scope('C01', 'failure'), affected: scope('C01', 'failure_scope') },
      }
    }
    return {
      kind: 'business_result',
      identity,
      value: decision,
    }
  }
}

/**
 * @internal This is not a business port or a raw decoder. It accepts only a
 * C34 object that state-transaction has registered by object identity after
 * full finalized proof; a structurally similar report cannot mint a fact.
 */
export function issueAuthenticatedRestoredFocusFact(
  authority: FocusAuthority,
  token: object,
  readout: C34Result,
): RestoredFocusFact | undefined {
  if (!isAuthenticFinalizedC34Bridge(readout, authority, token)
    || readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material') return undefined
  const material = stored.material
  const noFocus = material.kind === 'no_focus_material'
    && material.target.length > 0
    && material.canonicalState.kind === 'no_focus'
    && material.canonicalState.ref.length > 0
    && material.canonicalState.focus.kind === 'no_focus'
    && material.canonicalState.focus.ref.length > 0
    && material.canonicalState.focus.latestCorrections !== undefined
    && !Object.prototype.hasOwnProperty.call(material.canonicalState, 'target')
  const local = material.kind === 'local_restriction_material'
    && material.target.length > 0
    && material.canonicalState.kind === 'local_restriction'
    && material.canonicalState.ref.length > 0
    && material.canonicalState.focus.kind === 'focus_established'
    && material.canonicalState.focus.ref.length > 0
    && material.canonicalState.focus.currentMatter !== undefined
    && material.canonicalState.focus.latestCorrections !== undefined
    && !Object.prototype.hasOwnProperty.call(material.canonicalState, 'target')
  const noSafe = material.kind === 'no_safe_action_material'
    && material.target.length > 0
    && material.canonicalState.kind === 'no_safe_action'
    && material.canonicalState.ref.length > 0
    && material.canonicalState.focus.kind === 'focus_established'
    && material.canonicalState.focus.ref.length > 0
    && material.canonicalState.focus.currentMatter !== undefined
    && material.canonicalState.focus.latestCorrections !== undefined
    && !Object.prototype.hasOwnProperty.call(material.canonicalState, 'target')
  const background = material.kind === 'background_material'
    && material.target.length > 0
    && material.canonicalState.kind === 'background'
    && material.canonicalState.ref.length > 0
    && material.canonicalState.candidateRef.length > 0
    && material.canonicalState.focus.kind === 'focus_established'
    && material.canonicalState.focus.ref.length > 0
    && material.canonicalState.focus.currentMatter !== undefined
    && material.canonicalState.focus.latestCorrections !== undefined
    && material.canonicalState.boundary.ref.length > 0
    && (material.canonicalState.boundary.kind === 'actionable'
      || material.canonicalState.boundary.kind === 'local_restriction'
      || material.canonicalState.boundary.kind === 'no_safe_action')
    && !Object.prototype.hasOwnProperty.call(material.canonicalState.boundary, 'chat')
    && !Object.prototype.hasOwnProperty.call(material.canonicalState, 'target')
  if (!noFocus && !local && !noSafe && !background) return undefined
  const fact = Object.freeze({
    target: material.target,
    focus: material.canonicalState.focus,
  })
  restoredFacts.get(authority)?.add(fact)
  return fact
}

/**
 * Implementation-only recovery association. It exposes neither a raw decoder
 * nor a fact factory: the report must already have been issued by this owner.
 * Claiming is intentionally destructive so every recovery attempt is one use.
 */
export function claimAcceptedRestoredFocusReport(
  authority: FocusAuthority, token: object, c34: C34Result, report: C35Result,
): boolean {
  const accepted = acceptedRestoredReports.get(authority)
  const claimed = claimedRestoredReports.get(authority)
  if (!isAuthenticRecoveryClaim(authority, token, c34, report)
    || accepted?.has(report) !== true || claimed === undefined || claimed.has(report)) return false
  claimed.add(report)
  return true
}

/** Implementation-only C37 verifier for an already destructively claimed report. */
export function isClaimedRestoredFocusReport(authority: FocusAuthority, report: C35Result): boolean {
  return claimedRestoredReports.get(authority)?.has(report) === true
}

/** A one-use capability; it is not an authority and carries no C35 surface. */
export class BoundFocusProposal {
  private consumed = false
  constructor(
    private readonly authority: FocusAuthority,
    private readonly proposal: FocusProposalOutcome,
  ) {}

  decideFocus(expression: ExplicitUserExpression): C01Result {
    if (this.consumed) {
      const identity = call('C01', expression)
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
      }
    }
    this.consumed = true
    const decide = boundFocusPorts.get(this.authority)
    if (decide === undefined) {
      const identity = call('C01', expression)
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C01', 'rejection') },
      }
    }
    return decide(expression, this.proposal)
  }
}

/**
 * C35's only decoder. C34 is the formal full-chain receiver: this function
 * accepts no raw sidecar/session fields, so close ids, hashes and generations
 * cannot leak into RestoredFocusFact's public shape.
 */

export interface CandidateAdviceReceivers {
  readonly formation: {
    requestExplicitBackgroundUpdate(request: ExplicitBackgroundUpdateRequest): C38Result
  }
}

const candidateAdviceReceivers = new WeakMap<UserInteractionAdvice, CandidateAdviceReceivers>()

/** @internal One local H1 binding; it is neither a global registry nor an authority. */
export function bindCandidateAdviceReceivers(
  advice: UserInteractionAdvice,
  receivers: CandidateAdviceReceivers,
): boolean {
  if (candidateAdviceReceivers.has(advice)
    || typeof receivers.formation?.requestExplicitBackgroundUpdate !== 'function') return false
  candidateAdviceReceivers.set(advice, Object.freeze({ ...receivers }))
  return true
}

function c38Failure(chat: ChatRef): C38Result {
  return {
    kind: 'known_failure',
    identity: call('C38', chat),
    problem: { detail: scope('C38', 'failure'), affected: scope('C38', 'failure_scope') },
  }
}

function authenticQualificationIssue(issue: CandidateQualificationIssue): boolean {
  if (!Object.isFrozen(issue)
    || typeof issue.affected !== 'string'
    || issue.affected.trim().length === 0) return false
  if (issue.subject.kind === 'candidate') {
    const candidate = issue.subject.candidate
    if (!Object.isFrozen(candidate)
      || !/^candidate:[0-9a-f]{64}$/.test(candidate.ref)
      || candidate.target.length === 0
      || candidate.background.length === 0) return false
  } else if (issue.subject.chat.length === 0) return false
  return issue.kind === 'explicitly_disqualified'
    ? issue.reasons.length > 0 && issue.reasons.every(reason => typeof reason === 'string' && reason.length > 0)
    : issue.missingOrUncertain.length > 0
      && issue.missingOrUncertain.every(reason => typeof reason === 'string' && reason.length > 0)
}

const contentReasonPresentation: Readonly<Record<ContentFailureReason, string>> = Object.freeze({
  required_content_missing: '必要内容不完整',
  meaning_distorted: '已成立含义被改写',
  action_facts_not_self_contained: '行动事实不能独立续接',
  forbidden_old_content_included: '夹带了不应回流的旧内容',
})

const unavailableReasonPresentation: Readonly<Record<SafeNonFormationReason, string>> = Object.freeze({
  no_focus: '当前没有已成立焦点',
  matter_relation_pending: '当前事项关系仍待确认',
  required_facts_insufficient: '必要事实仍不充分',
  evidence_conflict: '依据仍有冲突',
  non_capacity_safety_constraint: '存在容量以外的安全限制',
  basis_incomplete: '形成依据尚不完整',
  candidate_budget_unknown: '无法证明完整候选能安全容纳',
  candidate_over_budget: '完整候选超出已知安全余量',
  future_critical_points_not_supported: '远期关键点依据尚不完整',
  formation_unknown: '当前无法确认候选形成条件',
})

function qualificationReasonPresentation(reason: string): string {
  if (reason in contentReasonPresentation) {
    return contentReasonPresentation[reason as ContentFailureReason]
  }
  if (reason in unavailableReasonPresentation) {
    return unavailableReasonPresentation[reason as SafeNonFormationReason]
  }
  if (reason.startsWith('focus:')) return '焦点依据已改变'
  if (reason.startsWith('action_facts:')) return '行动事实依据已改变'
  if (reason.startsWith('evidence:')) return '证据依据已改变'
  return '候选资格条件未满足'
}

function qualificationScopePresentation(scopeValue: string): string {
  if (scopeValue === 'candidate-background') return '候选背景正文'
  if (scopeValue === 'candidate-basis') return '候选形成依据'
  if (scopeValue === 'candidate-qualification') return '候选资格整体'
  return '候选资格范围'
}

/** C08/C38/C42 receiver. It cannot edit focus, candidate or qualification. */
export class UserInteractionAdvice {
  readonly #candidateIssues = new WeakSet<object>()
  readonly #acceptedCandidateIssueReports = new WeakSet<object>()
  readonly #presentedCandidateIssueReports = new WeakSet<object>()

  acceptMatterRelation(focus: FocusDecision): C08Result {
    const identity = call('C08', focus.ref)
    return {
      kind: 'business_result',
      identity,
      value: { kind: 'accepted_for_contract', value: focus },
    }
  }

  requestExplicitBackgroundUpdate(request: ExplicitBackgroundUpdateRequest): C38Result {
    if (request.chat.length === 0
      || Object.keys(request).length !== 1
      || !Object.prototype.hasOwnProperty.call(request, 'chat')) return c38Failure(request.chat)
    const receivers = candidateAdviceReceivers.get(this)
    if (receivers === undefined) return c38Failure(request.chat)
    try {
      const result = receivers.formation.requestExplicitBackgroundUpdate(request)
      if (result.kind !== 'business_result'
        || result.identity.contract !== 'C38'
        || result.identity.subject !== request.chat) return c38Failure(request.chat)
      return result
    } catch {
      return c38Failure(request.chat)
    }
  }

  acceptCandidateQualificationIssue<Ref extends CandidateRef>(
    issue: CandidateQualificationIssue<Ref>,
  ): C42Result<Ref> {
    const identity = call('C42', issue.subject)
    if (!authenticQualificationIssue(issue)
      || this.#candidateIssues.has(issue)) {
      return {
        kind: 'rejected',
        identity,
        reason: { kind: 'known_business_precondition_not_met', detail: scope('C42', 'rejection') },
      }
    }
    this.#candidateIssues.add(issue)
    const report: C42Result<Ref> = {
      kind: 'business_result',
      identity,
      value: { kind: 'accepted_for_contract', value: issue },
    }
    this.#acceptedCandidateIssueReports.add(report)
    return report
  }

  presentCandidateQualificationIssue<Ref extends CandidateRef>(result: C42Result<Ref>): string | undefined {
    if (result.kind !== 'business_result'
      || !this.#acceptedCandidateIssueReports.has(result)
      || this.#presentedCandidateIssueReports.has(result)) return undefined
    this.#presentedCandidateIssueReports.add(result)
    const issue = result.value.value
    const subject = issue.subject.kind === 'candidate' ? '当前候选' : '尚未形成候选'
    const scopeText = qualificationScopePresentation(issue.affected)
    if (issue.kind === 'explicitly_disqualified') {
      const reasons = issue.reasons.map(qualificationReasonPresentation).join('；')
      return `${subject}明确未通过资格检查：${reasons}。影响范围：${scopeText}。`
    }
    const missing = issue.missingOrUncertain.map(qualificationReasonPresentation).join('；')
    return `${subject}目前无法证明合格：${missing}。影响范围：${scopeText}。`
  }
}

/**
 * A canary-only visible projection. It has no authority: only an accepted
 * C08 business result can be rendered, and the projection is not C08 itself.
 */
export function presentFocusCanaryAdvice(result: C08Result): string | undefined {
  if (result.kind !== 'business_result') return undefined
  const focus = result.value.value
  if (focus.kind !== 'focus_established') return undefined
  return `已记录当前焦点：${focus.currentMatter}`
}
