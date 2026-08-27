/** F09 fixed no-safe-action adapter: exact proposal, material and user notice composition. */

import { createHash } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ChatRef, FocusAuthority, FocusDecision } from './focus.ts'
import { isAuthenticCompletedEvidenceNoSafeAction } from './action-boundary.ts'
import {
  createNoSafeActionLivePort,
  parseCanonicalNoSafeActionStateRecord,
  type CanonicalNoSafeActionTransactionInput,
  type CanonicalStateTransaction,
  type FinalizedCanonicalNoSafeAction,
  type FinalizedNoSafeActionRecoveryPort,
  type NoSafeActionBoundary,
  type NoSafeActionRepairPort,
  type NoSafeActionStateRecord,
} from './state-transaction.ts'
import type {
  ActionBoundaryProposal,
  ActionFactBoundaryAuthority,
  ActionFactBoundaryStateHandoff,
  ActionRef,
  ActionableFactMeaning,
  ClaimedStructuredDirect,
  CompletedEvidenceNoSafeActionBoundary,
  CompleteActionFactBoundaryPort,
  C02Result,
  C20Result,
  C21Result,
  C22Result,
  DirectActionOrigin,
  EvidenceSourceRef,
  FactAffectedScope,
  FactRef,
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

export interface NoSafeActionMaterial {
  readonly family: 'no_safe_action'
  readonly target: string
  readonly focus: Extract<FocusDecision, { readonly kind: 'focus_established' }>
  readonly boundary: NoSafeActionBoundary
  readonly origin: DirectActionOrigin
  readonly body: string
  readonly bodyHash: string
}
export interface NoSafeActionDependencies {
  readonly focus: FocusAuthority
  readonly actionBoundaryOwner: ActionFactBoundaryAuthority
  readonly completeActionBoundary: CompleteActionFactBoundaryPort
  readonly stateTransaction: CanonicalStateTransaction
}
export interface NoSafeActionLiveResult {
  readonly material: NoSafeActionMaterial
  readonly handoff: ActionFactBoundaryStateHandoff
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly notice: UserMessage
}
type NoSafeActionFullLiveInputBase = Omit<CanonicalNoSafeActionTransactionInput,
  'actionOwner' | 'handoff' | 'material'>
export type NoSafeActionFullLiveProposalInput = NoSafeActionFullLiveInputBase & {
  readonly proposal: ActionBoundaryProposal
  readonly completion?: never
}
export type NoSafeActionFullLiveEvidenceInput = NoSafeActionFullLiveInputBase & {
  readonly completion: CompletedEvidenceNoSafeActionBoundary
  readonly proposal?: never
}
export type NoSafeActionFullLiveInput =
  | NoSafeActionFullLiveProposalInput
  | NoSafeActionFullLiveEvidenceInput
export interface NoSafeActionFullLiveResult extends NoSafeActionLiveResult {
  readonly finalized: FinalizedCanonicalNoSafeAction
}
export interface NoSafeActionFullLivePort {
  commit(input: NoSafeActionFullLiveInput): Promise<NoSafeActionFullLiveResult | undefined>
}

export class NoSafeActionAdapter {
  constructor(private readonly dependencies: NoSafeActionDependencies) {}

  /** Runtime admission only; this freezes the exact auxiliary value and signs no Cnn report. */
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
      || outcome.value.origin.chat !== focus.chat || claimed.admission.target !== focus.chat) return undefined
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
      origin: outcome.origin, focus: outcome.focus,
      actions: Object.freeze([...actions]) as readonly [ActionRef, ...ActionRef[]],
      proposedRequirements: Object.freeze(requirements) as BoundedActionFactNeedProposal['proposedRequirements'],
      usableInputs: Object.freeze(usable) as readonly UsableFact[],
      unresolvedInputs: Object.freeze(unresolved) as readonly UnresolvedFact[],
    })
    return Object.freeze({ admission: claimed.admission, unsigned })
  }

  render(boundary: NoSafeActionBoundary): string {
    const unresolved = boundary.unresolvedFacts.map(fact => fact.meaning).join('、')
    return `当前请求没有可安全执行的行动。已阻止：${boundary.preciselyBlockedActions.join('、')}。待确认：${unresolved}。`
  }

  formMaterial(
    focus: FocusDecision,
    boundary: NoSafeActionBoundary,
    origin: DirectActionOrigin,
  ): NoSafeActionMaterial | undefined {
    if (focus.kind !== 'focus_established' || focus.chat !== boundary.chat
      || boundary.preciselyBlockedActions.length === 0 || boundary.safelyContinuableActions.length !== 0) return undefined
    const body = this.render(boundary)
    return Object.freeze({ family: 'no_safe_action', target: focus.chat, focus, boundary,
      origin: Object.freeze({ ...origin }), body,
      bodyHash: createHash('sha256').update(body).digest('hex') })
  }

  createNotice(c22: C22Result): UserMessage | undefined {
    const boundary = c22.kind === 'business_result' && c22.value.kind === 'accepted_for_contract'
      ? c22.value.value : undefined
    if (boundary?.kind !== 'no_safe_action' || c22.identity.subject !== boundary.ref) return undefined
    return createUserMessage({
      content: [{ type: 'text', text: this.render(boundary) }],
      source: { kind: 'plugin', plugin: 'ui-context-compactor:no-safe-action',
        form: 'notice', summary: 'no safe action notice' },
    })
  }

  consumeBoundedProposal(focus: FocusDecision, proposal: ActionBoundaryProposal): NoSafeActionLiveResult | undefined {
    const handoff = this.dependencies.completeActionBoundary.accept(focus, proposal)
    const boundary = handoff?.c21.kind === 'business_result'
      && handoff.c21.value.kind === 'accepted_for_contract' ? handoff.c21.value.value : undefined
    if (handoff === undefined || boundary?.kind !== 'no_safe_action'
      || handoff.boundary !== boundary || handoff.c20.kind !== 'business_result'
      || handoff.c20.value.kind !== 'accepted_for_contract' || handoff.c20.value.value !== boundary
      || handoff.c22.kind !== 'business_result' || handoff.c22.value.value !== boundary) return undefined
    const material = this.formMaterial(focus, boundary, handoff.origin)
    const notice = this.createNotice(handoff.c22)
    return material === undefined || notice === undefined ? undefined : {
      material, handoff, c02: handoff.c02, c20: handoff.c20, c21: handoff.c21, c22: handoff.c22, notice,
    }
  }

  private consumeCompletedEvidence(
    focus: FocusDecision,
    completion: CompletedEvidenceNoSafeActionBoundary,
  ): NoSafeActionLiveResult | undefined {
    if (!isAuthenticCompletedEvidenceNoSafeAction(
      this.dependencies.actionBoundaryOwner,
      completion,
    )) return undefined
    const { handoff, boundary } = completion
    if (completion.family !== 'no_safe_action' || boundary.kind !== 'no_safe_action'
      || completion.origin !== handoff.origin || completion.c02 !== handoff.c02
      || completion.c20 !== handoff.c20 || completion.c21 !== handoff.c21
      || completion.c22 !== handoff.c22 || completion.boundary !== handoff.boundary
      || handoff.c20.kind !== 'business_result'
      || handoff.c20.value.kind !== 'accepted_for_contract'
      || handoff.c20.value.value !== boundary
      || handoff.c21.kind !== 'business_result'
      || handoff.c21.value.kind !== 'accepted_for_contract'
      || handoff.c21.value.value !== boundary
      || handoff.c22.kind !== 'business_result'
      || handoff.c22.value.kind !== 'accepted_for_contract'
      || handoff.c22.value.value !== boundary) return undefined
    const material = this.formMaterial(focus, boundary, completion.origin)
    const notice = this.createNotice(completion.c22)
    return material === undefined || notice === undefined ? undefined : {
      material, handoff,
      c02: completion.c02, c20: completion.c20, c21: completion.c21, c22: completion.c22, notice,
    }
  }

  createRepairPort(): NoSafeActionRepairPort {
    return this.dependencies.stateTransaction.createNoSafeActionRepairPort()
  }

  createRecoveryPort(): FinalizedNoSafeActionRecoveryPort {
    return this.dependencies.stateTransaction.createNoSafeActionRecoveryPort(
      this.dependencies.focus, this.dependencies.actionBoundaryOwner,
    )
  }

  createFullLivePort(): NoSafeActionFullLivePort {
    const state = createNoSafeActionLivePort(this.dependencies.stateTransaction)
    return Object.freeze({
      commit: async (input: NoSafeActionFullLiveInput): Promise<NoSafeActionFullLiveResult | undefined> => {
        if (('proposal' in input) === ('completion' in input)) return undefined
        const accepted = 'completion' in input
          ? this.consumeCompletedEvidence(input.focus, input.completion)
          : this.consumeBoundedProposal(input.focus, input.proposal)
        if (accepted === undefined) return undefined
        const finalized = await state.commit({
          sessionId: input.sessionId, session: input.session, record: input.record,
          focus: input.focus, actionOwner: this.dependencies.actionBoundaryOwner,
          handoff: accepted.handoff, save: input.save, flush: input.flush, readFrom: input.readFrom,
          material: accepted.material,
        })
        return { ...accepted, finalized }
      },
    })
  }

  currentGeneration(record: unknown): number | undefined {
    const exact = parseCanonicalNoSafeActionStateRecord(record)
    return exact?.transaction?.phase === 'finalized' ? exact.transaction.generation : undefined
  }
}

export function isFinalizedNoSafeActionRecord(record: unknown): record is NoSafeActionStateRecord & {
  readonly transaction: NonNullable<NoSafeActionStateRecord['transaction']> & { readonly phase: 'finalized' }
} {
  return parseCanonicalNoSafeActionStateRecord(record)?.transaction?.phase === 'finalized'
}
