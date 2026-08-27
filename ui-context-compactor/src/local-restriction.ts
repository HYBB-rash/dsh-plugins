/** F08 fixed-family adapter: material/rendering and owner-only composition. */

import { createHash } from 'node:crypto'
import type { ChatRef, FocusAuthority, FocusDecision } from './focus.ts'
import { isAuthenticCompletedEvidenceLocalRestriction } from './action-boundary.ts'
import {
  createLocalRestrictionLivePort,
  type CanonicalStateTransaction,
  type CanonicalLocalRestrictionTransactionInput,
  type FinalizedCanonicalLocalRestriction,
  type FinalizedLocalRestrictionRecoveryPort,
  type LocalRestrictionBoundary,
} from './state-transaction.ts'
import type {
  ActionFactBoundaryAuthority,
  ActionBoundaryProposal,
  ActionFactBoundary,
  ActionFactBoundaryRef,
  ActionRef,
  ActionableFactMeaning,
  ClaimedStructuredDirect,
  CompletedEvidenceLocalRestrictionBoundary,
  ContractCallRef,
  ContractScope,
  CompleteLocalRestrictionBoundaryPort,
  C02Result,
  C20Result,
  C21Result,
  C22Result,
  EvidenceSourceRef,
  FactAffectedScope,
  FactRef,
  DirectActionOrigin,
  LocalRestrictionAcceptance,
  UncertaintyMeaning,
  UsableFact,
  UnresolvedFact,
} from './action-boundary.ts'
import type {
  BoundedActionFactNeedProposal,
  BoundedActionFactNeedProposalOutcome,
} from './managed-runtime.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}
function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function exactStrings(value: unknown, nonempty = false): readonly string[] | undefined {
  if (!Array.isArray(value) || (nonempty && value.length === 0) || !value.every(nonblank)
    || new Set(value).size !== value.length) return undefined
  return value
}
function exactUsable(value: unknown): UsableFact | undefined {
  const fact = object(value)
  if (fact === undefined || !nonblank(fact.fact) || !nonblank(fact.meaning)
    || !nonblank(fact.source) || fact.degree !== 'established') return undefined
  if (fact.kind === 'direct_fact' && onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree'])) {
    return Object.freeze({ kind: 'direct_fact', fact: fact.fact as FactRef,
      meaning: fact.meaning as ActionableFactMeaning, source: fact.source as EvidenceSourceRef, degree: 'established' })
  }
  const inherited = object(fact.inheritedFrom)
  if (fact.kind !== 'inherited_fact' || !onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree', 'inheritedFrom'])
    || inherited === undefined || !onlyKeys(inherited, ['sourceChat', 'sourceCanonicalState'])
    || !nonblank(inherited.sourceChat) || !nonblank(inherited.sourceCanonicalState)) return undefined
  return Object.freeze({ kind: 'inherited_fact', fact: fact.fact as FactRef,
    meaning: fact.meaning as ActionableFactMeaning, source: fact.source as EvidenceSourceRef, degree: 'established',
    inheritedFrom: Object.freeze({ sourceChat: inherited.sourceChat as ChatRef,
    sourceCanonicalState: inherited.sourceCanonicalState as import('./state-transaction.ts').CanonicalStateRef }) })
}
function exactUnresolved(value: unknown): UnresolvedFact | undefined {
  const fact = object(value)
  if (fact === undefined || !onlyKeys(fact, ['fact', 'meaning', 'source', 'degree', 'affected'])
    || !nonblank(fact.fact) || !nonblank(fact.meaning) || !nonblank(fact.source) || !nonblank(fact.affected)
    || (fact.degree !== 'insufficient' && fact.degree !== 'conflicting' && fact.degree !== 'unknown')) return undefined
  return Object.freeze({ fact: fact.fact as FactRef, meaning: fact.meaning as UncertaintyMeaning,
    source: fact.source as EvidenceSourceRef, degree: fact.degree, affected: fact.affected as FactAffectedScope })
}

/** The formal C22 receiver. ActionFactBoundaryAuthority may carry, but never signs, this report. */
export class UserInteractionAdvice {
  acceptFactDecisionNeeds(boundary: ActionFactBoundary): C22Result {
    const complete = boundary.ref.trim().length > 0 && boundary.chat.trim().length > 0
      && boundary.requiredFacts.ref.trim().length > 0
      && boundary.requiredFacts.requirements.every(requirement => requirement.fact.trim().length > 0
        && requirement.neededFor.length > 0 && requirement.neededFor.every(action => action.trim().length > 0))
      && boundary.usableFacts.every(fact => fact.fact.trim().length > 0 && fact.meaning.trim().length > 0
        && fact.source.trim().length > 0 && fact.degree === 'established'
        && (fact.kind === 'direct_fact' || fact.kind === 'inherited_fact'
          && fact.inheritedFrom.sourceChat.trim().length > 0
          && fact.inheritedFrom.sourceCanonicalState.trim().length > 0))
      && boundary.unresolvedFacts.every(fact => fact.fact.trim().length > 0 && fact.meaning.trim().length > 0
        && fact.source.trim().length > 0 && fact.affected.trim().length > 0
        && (fact.degree === 'insufficient' || fact.degree === 'conflicting' || fact.degree === 'unknown'))
      && boundary.preciselyBlockedActions.every(action => action.trim().length > 0)
      && boundary.safelyContinuableActions.every(action => action.trim().length > 0)
      && (boundary.kind === 'actionable'
        ? boundary.preciselyBlockedActions.length === 0 && boundary.safelyContinuableActions.length > 0
        : boundary.kind === 'local_restriction'
          ? boundary.preciselyBlockedActions.length > 0 && boundary.safelyContinuableActions.length > 0
          : boundary.kind === 'no_safe_action'
            && boundary.preciselyBlockedActions.length > 0 && boundary.safelyContinuableActions.length === 0)
    const identity = Object.freeze({ contract: 'C22' as const,
      call: `C22:${crypto.randomUUID()}` as ContractCallRef, subject: boundary.ref as ActionFactBoundaryRef })
    return complete
      ? Object.freeze({ kind: 'business_result', identity,
          value: Object.freeze({ kind: 'accepted_for_contract' as const, value: boundary }) })
      : Object.freeze({ kind: 'rejected', identity,
          reason: Object.freeze({ kind: 'known_business_precondition_not_met' as const,
            detail: 'C22:rejection' as ContractScope<'C22', 'rejection'> }) })
  }
}

export interface LocalRestrictionMaterial {
  readonly family: 'local_restriction'
  readonly target: string
  readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>
  readonly boundary: LocalRestrictionBoundary
  readonly origin: DirectActionOrigin
  readonly body: string
  readonly bodyHash: string
}
export interface LocalRestrictionDependencies {
  readonly focus: FocusAuthority
  readonly actionBoundaryOwner: ActionFactBoundaryAuthority
  readonly completeActionBoundary: CompleteLocalRestrictionBoundaryPort
  readonly stateTransaction: CanonicalStateTransaction
}
export interface LocalRestrictionLiveResult {
  readonly material: LocalRestrictionMaterial
  readonly acceptance: LocalRestrictionAcceptance
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
}
type LocalRestrictionFullLiveInputBase = Omit<CanonicalLocalRestrictionTransactionInput,
  'actionOwner' | 'acceptance' | 'material'>
export type LocalRestrictionFullLiveProposalInput = LocalRestrictionFullLiveInputBase & {
  readonly proposal: ActionBoundaryProposal
  readonly completion?: never
}
export type LocalRestrictionFullLiveEvidenceInput = LocalRestrictionFullLiveInputBase & {
  readonly completion: CompletedEvidenceLocalRestrictionBoundary
  readonly proposal?: never
}
export type LocalRestrictionFullLiveInput =
  | LocalRestrictionFullLiveProposalInput
  | LocalRestrictionFullLiveEvidenceInput
export interface LocalRestrictionFullLiveResult extends LocalRestrictionLiveResult {
  readonly finalized: FinalizedCanonicalLocalRestriction
}
export interface LocalRestrictionFullLivePort {
  commit(input: LocalRestrictionFullLiveInput): Promise<LocalRestrictionFullLiveResult | undefined>
}
export interface LocalRestrictionRecoveryAdapter {
  createRecoveryPort(): FinalizedLocalRestrictionRecoveryPort
}

/** This adapter owns no authority and never constructs a second state owner. */
export class LocalRestrictionAdapter {
  constructor(private readonly dependencies: LocalRestrictionDependencies) {}

  /** Runtime admission only: this validates and freezes unsigned fields; it signs no Cnn. */
  formActionBoundaryProposal(
    focus: FocusDecision,
    outcome: BoundedActionFactNeedProposalOutcome,
    claimed: ClaimedStructuredDirect,
  ): ActionBoundaryProposal | undefined {
    const rawOutcome = object(outcome)
    const rawOutcomeOrigin = rawOutcome === undefined ? undefined : object(rawOutcome.origin)
    const rawValue = rawOutcome === undefined ? undefined : object(rawOutcome.value)
    const rawValueOrigin = rawValue === undefined ? undefined : object(rawValue.origin)
    if (focus.kind !== 'focus_established' || outcome.kind !== 'proposal'
      || rawOutcome === undefined || !onlyKeys(rawOutcome, ['kind', 'origin', 'focus', 'value'])
      || rawOutcomeOrigin === undefined || !onlyKeys(rawOutcomeOrigin, ['message', 'chat', 'expressionHash'])
      || rawValueOrigin === undefined || !onlyKeys(rawValueOrigin, ['message', 'chat', 'expressionHash'])
      || outcome.focus !== focus.ref || outcome.origin.message !== claimed.origin.messageId
      || outcome.origin.expressionHash !== claimed.origin.hash || outcome.origin.chat !== focus.chat
      || outcome.value.focus !== focus.ref || outcome.value.origin !== outcome.origin
      || outcome.value.origin.message !== claimed.origin.messageId
      || outcome.value.origin.expressionHash !== claimed.origin.hash
      || outcome.value.origin.chat !== focus.chat
      || claimed.admission.target !== focus.chat) return undefined
    const raw = rawValue
    if (raw === undefined || !onlyKeys(raw, ['origin', 'focus', 'actions', 'proposedRequirements', 'usableInputs', 'unresolvedInputs'])) return undefined
    const actions = exactStrings(raw.actions, true)
    if (actions === undefined || !Array.isArray(raw.proposedRequirements)
      || !Array.isArray(raw.usableInputs) || !Array.isArray(raw.unresolvedInputs)) return undefined
    const actionSet = new Set(actions)
    const requirements = raw.proposedRequirements.map(value => {
      const requirement = object(value)
      const neededFor = requirement === undefined ? undefined : exactStrings(requirement.neededFor, true)
      return requirement !== undefined && onlyKeys(requirement, ['fact', 'neededFor'])
        && nonblank(requirement.fact) && neededFor !== undefined && neededFor.every(action => actionSet.has(action))
        ? Object.freeze({ fact: requirement.fact as FactRef,
            neededFor: Object.freeze([...neededFor]) as readonly [ActionRef, ...ActionRef[]] }) : undefined
    })
    const usable = raw.usableInputs.map(exactUsable)
    const unresolved = raw.unresolvedInputs.map(exactUnresolved)
    if (requirements.some(value => value === undefined) || usable.some(value => value === undefined)
      || unresolved.some(value => value === undefined)) return undefined
    const requiredRefs = requirements.map(value => value!.fact)
    const inputRefs = [...usable.map(value => value!.fact), ...unresolved.map(value => value!.fact)]
    if (new Set(requiredRefs).size !== requiredRefs.length || new Set(inputRefs).size !== inputRefs.length
      || requiredRefs.length !== inputRefs.length || requiredRefs.some(fact => !inputRefs.includes(fact))) return undefined
    const unsigned: BoundedActionFactNeedProposal = Object.freeze({
      origin: outcome.origin,
      focus: outcome.focus,
      actions: Object.freeze([...actions]) as readonly [ActionRef, ...ActionRef[]],
      proposedRequirements: Object.freeze(requirements) as BoundedActionFactNeedProposal['proposedRequirements'],
      usableInputs: Object.freeze(usable) as readonly UsableFact[],
      unresolvedInputs: Object.freeze(unresolved) as readonly UnresolvedFact[],
    })
    return Object.freeze({
      admission: claimed.admission,
      unsigned,
    })
  }

  render(boundary: LocalRestrictionBoundary): string {
    return `受限行动：${boundary.preciselyBlockedActions.join('、')}。可继续：${boundary.safelyContinuableActions.join('、')}。`
  }
  formMaterial(
    focus: FocusDecision,
    boundary: LocalRestrictionBoundary,
    origin: DirectActionOrigin,
  ): LocalRestrictionMaterial | undefined {
    if (focus.kind !== 'focus_established' || focus.chat !== boundary.chat) return undefined
    const body = this.render(boundary)
    return Object.freeze({ family: 'local_restriction', target: focus.chat, focus, boundary, origin: Object.freeze({ ...origin }), body,
      bodyHash: createHash('sha256').update(body).digest('hex') })
  }
  consumeBoundedProposal(focus: FocusDecision, proposal: ActionBoundaryProposal): LocalRestrictionLiveResult | undefined {
    const accepted = this.dependencies.completeActionBoundary.accept(focus, proposal)
    if (accepted === undefined) return undefined
    if (accepted.c21.kind !== 'business_result' || accepted.c21.value.kind !== 'accepted_for_contract'
      || accepted.c21.value.value.kind !== 'local_restriction') return undefined
    const material = this.formMaterial(focus, accepted.c21.value.value, accepted.origin)
    return material === undefined ? undefined : {
      material, acceptance: accepted,
      c02: accepted.c02, c20: accepted.c20, c21: accepted.c21, c22: accepted.c22,
    }
  }

  private consumeCompletedEvidence(
    focus: FocusDecision,
    completion: CompletedEvidenceLocalRestrictionBoundary,
  ): LocalRestrictionLiveResult | undefined {
    if (!isAuthenticCompletedEvidenceLocalRestriction(
      this.dependencies.actionBoundaryOwner,
      completion,
    )) return undefined
    const { acceptance, boundary } = completion
    if (completion.family !== 'local_restriction' || boundary.kind !== 'local_restriction'
      || completion.origin !== acceptance.origin
      || completion.c02 !== acceptance.c02 || completion.c20 !== acceptance.c20
      || completion.c21 !== acceptance.c21 || completion.c22 !== acceptance.c22
      || acceptance.c20.kind !== 'business_result'
      || acceptance.c20.value.kind !== 'accepted_for_contract'
      || acceptance.c20.value.value !== boundary
      || acceptance.c21.kind !== 'business_result'
      || acceptance.c21.value.kind !== 'accepted_for_contract'
      || acceptance.c21.value.value !== boundary
      || acceptance.c22.kind !== 'business_result'
      || acceptance.c22.value.kind !== 'accepted_for_contract'
      || acceptance.c22.value.value !== boundary) return undefined
    const material = this.formMaterial(focus, boundary, completion.origin)
    return material === undefined ? undefined : {
      material, acceptance,
      c02: completion.c02, c20: completion.c20, c21: completion.c21, c22: completion.c22,
    }
  }

  createRecoveryPort(): FinalizedLocalRestrictionRecoveryPort {
    return this.dependencies.stateTransaction.createLocalRestrictionRecoveryPort(
      this.dependencies.focus, this.dependencies.actionBoundaryOwner,
    )
  }

  /** Full fixed-family port; it composes existing owners and creates no ledger. */
  createFullLivePort(): LocalRestrictionFullLivePort {
    const state = createLocalRestrictionLivePort(this.dependencies.stateTransaction)
    return Object.freeze({
      commit: async (input: LocalRestrictionFullLiveInput): Promise<LocalRestrictionFullLiveResult | undefined> => {
        if (('proposal' in input) === ('completion' in input)) return undefined
        const accepted = 'completion' in input
          ? this.consumeCompletedEvidence(input.focus, input.completion)
          : this.consumeBoundedProposal(input.focus, input.proposal)
        if (accepted === undefined) return undefined
        const finalized = await state.commit({
          sessionId: input.sessionId, session: input.session, record: input.record,
          focus: input.focus,
          actionOwner: this.dependencies.actionBoundaryOwner,
          acceptance: accepted.acceptance,
          save: input.save, flush: input.flush, readFrom: input.readFrom,
          material: accepted.material,
        })
        return { ...accepted, finalized }
      },
    })
  }
}
