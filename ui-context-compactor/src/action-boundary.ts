/**
 * F08's sole action-fact authority.
 *
 * It intentionally accepts only an established focus and a one-use proposal
 * issued for that exact direct input.  Storage, state replacement and user
 * rendering are separate receivers, so none can manufacture a C21 result.
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { BoundedActionFactNeedProposal } from './managed-runtime.ts'
import type {
  Accepted,
  ChatRef,
  ContractCallRef,
  ContractCode,
  ContractReport,
  ContractScope,
  FocusDecision,
  FocusDecisionRef,
  WithoutChat,
} from './focus.ts'
import {
  EvidenceResolution,
  bindEvidenceConclusionCandidateReceivers,
  bindExpectedFactNeedOwner,
  issueOwnerBoundFactNeedSet,
  type C11Result,
  type C12Result,
  type C13Result,
  type EvidenceConclusionProvenance,
  type EvidenceConclusionCandidateReceivers,
  type EvidenceConclusionSet,
  type EvidenceResolutionDependencies,
  type EvidenceResolutionOutcome,
  type EvidenceResolutionResult,
  type MultiFactEvidenceResolutionItem,
  type MultiFactEvidenceResolutionOutcome,
  type MultiSourceEvidenceResolutionOutcome,
  type EvidenceRetrievalRequest,
  F03_PRIVATE_SEARCH_QUERY,
  isMultiFactEvidenceResolutionOutcome,
} from './fact-resolution.ts'
import {
  exactTwo,
  projectExactTwoFactResults,
  type ExactTwo,
} from './multi-fact-resolution.ts'
export type {
  Accepted,
  ContractCallRef,
  ContractCode,
  ContractIdentity,
  ContractProblem,
  ContractRejection,
  ContractReport,
  ContractScope,
  NoUsableEstablishedFact,
  WithoutChat,
} from './focus.ts'
import {
  bindExpectedActionBoundaryOwner,
  isAuthenticActionFactBoundaryC36Bridge,
  isAuthenticActionFactBoundaryRecoveryClaim,
  type C34Result,
  type CanonicalStateRef,
} from './state-transaction.ts'
import type {
  C20Result as PreservationC20Result,
  C21Result as CanonicalC21Result,
} from './state-transaction.ts'

declare const actionFactBrand: unique symbol
type Brand<Name extends string> = string & { readonly [actionFactBrand]: Name }
export type ActionFactBoundaryRef = Brand<'ActionFactBoundaryRef'>
export type FactNeedSetRef = Brand<'FactNeedSetRef'>
export type ActionRef = Brand<'ActionRef'>
export type FactRef = Brand<'FactRef'>
export type EvidenceSourceRef = Brand<'EvidenceSourceRef'>
export type ActionableFactMeaning = Brand<'ActionableFactMeaning'>
export type UncertaintyMeaning = Brand<'UncertaintyMeaning'>
export type FactAffectedScope = Brand<'FactAffectedScope'>
export type ActionAffectedScope = Brand<'ActionAffectedScope'>
export type DirectActionOrigin = { readonly messageId: string; readonly hash: string }

const claimedDirectActionCapabilityBrand: unique symbol = Symbol('claimed-direct-action-capability')
export interface ClaimedDirectActionCapability {
  readonly [claimedDirectActionCapabilityBrand]: 'ClaimedDirectActionCapability'
}
export interface ClaimedDirectActionAdmission {
  readonly capability: ClaimedDirectActionCapability
  readonly session: Agent['session']
  readonly target: ChatRef
}
export interface ClaimedStructuredDirect {
  readonly admission: ClaimedDirectActionAdmission
  readonly origin: DirectActionOrigin
}
export interface ClaimedStructuredDirectIssuer {
  issue(session: Agent['session'], target: ChatRef, message: UserMessage): ClaimedStructuredDirect | undefined
}

export interface FactRequirement {
  readonly fact: FactRef
  readonly neededFor: readonly [ActionRef, ...ActionRef[]]
}
export interface FactNeedSet {
  readonly ref: FactNeedSetRef
  readonly chat: ChatRef
  readonly requirements: readonly FactRequirement[]
}
export interface DirectFact {
  readonly kind: 'direct_fact'
  readonly fact: FactRef
  readonly meaning: ActionableFactMeaning
  readonly source: EvidenceSourceRef
  readonly degree: 'established'
}
export interface InheritedFact {
  readonly kind: 'inherited_fact'
  readonly fact: FactRef
  readonly meaning: ActionableFactMeaning
  readonly source: EvidenceSourceRef
  readonly degree: 'established'
  readonly inheritedFrom: {
    readonly sourceChat: ChatRef
    readonly sourceCanonicalState: CanonicalStateRef
  }
}
export type UsableFact = DirectFact | InheritedFact
export interface UnresolvedFact {
  readonly fact: FactRef
  readonly meaning: UncertaintyMeaning
  readonly source: EvidenceSourceRef
  readonly degree: 'insufficient' | 'conflicting' | 'unknown'
  readonly affected: FactAffectedScope
}
export interface ActionFactBoundaryCore {
  readonly ref: ActionFactBoundaryRef
  readonly chat: ChatRef
  readonly requiredFacts: Omit<FactNeedSet, 'chat'>
  readonly usableFacts: readonly UsableFact[]
  readonly unresolvedFacts: readonly UnresolvedFact[]
}
export interface LocalRestrictionBoundary extends ActionFactBoundaryCore {
  readonly kind: 'local_restriction'
  readonly preciselyBlockedActions: readonly [ActionRef, ...ActionRef[]]
  readonly safelyContinuableActions: readonly [ActionRef, ...ActionRef[]]
}
export interface ActionableBoundary extends ActionFactBoundaryCore {
  readonly kind: 'actionable'
  readonly preciselyBlockedActions: readonly []
  readonly safelyContinuableActions: readonly ActionRef[]
}
export interface NoSafeActionBoundary extends ActionFactBoundaryCore {
  readonly kind: 'no_safe_action'
  readonly preciselyBlockedActions: readonly ActionRef[]
  readonly safelyContinuableActions: readonly []
}
export type ActionFactBoundary = ActionableBoundary | LocalRestrictionBoundary | NoSafeActionBoundary
export type PreservedActionBoundary = WithoutChat<ActionFactBoundary>
export type PreservedLocalRestrictionBoundary = Extract<PreservedActionBoundary, { readonly kind: 'local_restriction' }>

export type ActionSafety = ActionFactBoundary

export interface PartialActionFactBoundary {
  readonly ref: ActionFactBoundaryRef
  readonly usableFacts: readonly UsableFact[]
  readonly unresolvedFacts: readonly UnresolvedFact[]
  readonly preciselyBlockedActions: readonly ActionRef[]
  readonly safelyContinuableActions: readonly ActionRef[]
  readonly establishedActionScope: ActionAffectedScope
  readonly complete: false
}
export type C02Result = ContractReport<'C02', FocusDecisionRef, Accepted<FocusDecision>>
export type C20Result = PreservationC20Result
export type C21Result = CanonicalC21Result
export type C22Result = ContractReport<'C22', ActionFactBoundaryRef, Accepted<ActionFactBoundary>, PartialActionFactBoundary>
export type C36Result = ContractReport<'C36', ActionFactBoundaryRef, Accepted<RestoredActionBoundary>>

export interface RestoredActionBoundary {
  readonly target: ChatRef
  readonly boundary: PreservedActionBoundary
}
export interface UserInteractionAdvicePort { acceptFactDecisionNeeds(boundary: ActionFactBoundary): C22Result }
export interface ActionBoundaryDependencies {
  readonly preservation: { acceptActionBoundaryToPreserve(boundary: ActionFactBoundary): PreservationC20Result }
  readonly canonicalContext: { acceptActionSafetyBoundary(boundary: ActionFactBoundary): CanonicalC21Result }
  readonly userInteraction: UserInteractionAdvicePort
}

export interface ActionBoundaryCandidateReceivers {
  readonly contentReview: {
    acceptRequiredActionFacts(boundary: ActionFactBoundary): unknown
  }
  readonly freshnessReview: {
    acceptCurrentActionFacts(boundary: ActionFactBoundary): unknown
  }
  readonly formation: {
    acceptActionFactBoundary(boundary: ActionFactBoundary): unknown
  }
}

export interface ActionBoundaryProposal {
  readonly admission: ClaimedDirectActionAdmission
  readonly unsigned: BoundedActionFactNeedProposal
}

/** One synchronous, complete F08 path; no intermediate action capability escapes. */
export interface CompleteLocalRestrictionBoundaryPort {
  accept(focus: FocusDecision, proposal: ActionBoundaryProposal): LocalRestrictionAcceptance | undefined
}

/** Stable F09 path; it completes C02/C22/C20/C21 before returning. */
export interface CompleteActionFactBoundaryPort {
  accept(focus: FocusDecision, proposal: ActionBoundaryProposal): ActionFactBoundaryStateHandoff | undefined
}

export interface CompletedSingleEvidenceActionableBoundary {
  readonly family: 'actionable'
  readonly provenance: EvidenceConclusionProvenance
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: ActionableBoundary
}
export interface CompletedMultiFactEvidenceActionableBoundary {
  readonly kind: 'multi' | 'multi_source'
  readonly family: 'actionable'
  readonly provenances: ExactTwo<EvidenceConclusionProvenance>
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: ActionableBoundary
}
interface AuthenticatedMultiSourceFinding {
  readonly source: EvidenceSourceRef
  readonly url: string
  readonly conclusion: string
  readonly appliesWhen: string
  readonly observedAt: string
  readonly publishedAt: string | undefined
  readonly futureUse: string
}
export interface CompletedMultiSourceEvidenceActionableBoundary {
  readonly kind: 'multi_source'
  readonly resolution: 'agree' | 'conditional'
  readonly family: 'actionable'
  readonly provenances: ExactTwo<EvidenceConclusionProvenance>
  readonly sourceFindings: ExactTwo<AuthenticatedMultiSourceFinding>
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: ActionableBoundary
}
export type CompletedEvidenceActionableBoundary =
  | CompletedSingleEvidenceActionableBoundary
  | CompletedMultiFactEvidenceActionableBoundary
  | CompletedMultiSourceEvidenceActionableBoundary

export interface CompletedSingleEvidenceLocalRestrictionBoundary {
  readonly family: 'local_restriction'
  readonly provenance: EvidenceConclusionProvenance
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: LocalRestrictionBoundary
  readonly acceptance: LocalRestrictionAcceptance
}
export interface CompletedMultiFactEvidenceLocalRestrictionBoundary {
  readonly kind: 'multi'
  readonly family: 'local_restriction'
  readonly provenances: ExactTwo<EvidenceConclusionProvenance>
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: LocalRestrictionBoundary
  readonly acceptance: LocalRestrictionAcceptance
}
export interface CompletedMultiSourceEvidenceLocalRestrictionBoundary {
  readonly kind: 'multi_source'
  readonly resolution: 'conflict' | 'source_incomplete'
  readonly family: 'local_restriction'
  readonly provenances: readonly EvidenceConclusionProvenance[]
  readonly sourceFindings: readonly AuthenticatedMultiSourceFinding[]
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: LocalRestrictionBoundary
  readonly acceptance: LocalRestrictionAcceptance
}
export type CompletedEvidenceLocalRestrictionBoundary =
  | CompletedSingleEvidenceLocalRestrictionBoundary
  | CompletedMultiFactEvidenceLocalRestrictionBoundary
  | CompletedMultiSourceEvidenceLocalRestrictionBoundary

export interface CompletedSingleEvidenceNoSafeActionBoundary {
  readonly family: 'no_safe_action'
  readonly provenance: EvidenceConclusionProvenance
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: NoSafeActionBoundary
  readonly handoff: ActionFactBoundaryStateHandoff
}
export interface CompletedMultiFactEvidenceNoSafeActionBoundary {
  readonly kind: 'multi'
  readonly family: 'no_safe_action'
  readonly provenances: ExactTwo<EvidenceConclusionProvenance>
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: NoSafeActionBoundary
  readonly handoff: ActionFactBoundaryStateHandoff
}
export interface CompletedMultiSourceEvidenceNoSafeActionBoundary {
  readonly kind: 'multi_source'
  readonly resolution: 'conflict' | 'source_incomplete'
  readonly family: 'no_safe_action'
  readonly provenances: readonly EvidenceConclusionProvenance[]
  readonly sourceFindings: readonly AuthenticatedMultiSourceFinding[]
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
  readonly boundary: NoSafeActionBoundary
  readonly handoff: ActionFactBoundaryStateHandoff
}
export type CompletedEvidenceNoSafeActionBoundary =
  | CompletedSingleEvidenceNoSafeActionBoundary
  | CompletedMultiFactEvidenceNoSafeActionBoundary
  | CompletedMultiSourceEvidenceNoSafeActionBoundary
export type CompletedEvidenceActionFactBoundary =
  | CompletedEvidenceActionableBoundary
  | CompletedEvidenceLocalRestrictionBoundary
  | CompletedEvidenceNoSafeActionBoundary

/** F03's complete asynchronous fixed-family path; no C11/C12/C13 capability escapes. */
export interface CompleteEvidenceActionFactBoundaryPort {
  accept(
    focus: FocusDecision,
    proposal: ActionBoundaryProposal,
    signal: AbortSignal,
  ): Promise<CompletedEvidenceActionFactBoundary | undefined>
}

/**
 * One owner-issued live result.  It is a capability by object identity, not a
 * structural bundle that callers may recreate before entering state C29.
 */
export interface LocalRestrictionAcceptance {
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: C22Result
}
export interface ActionFactBoundaryAcceptance {
  readonly origin: DirectActionOrigin
  readonly c02: C02Result
  readonly c22: C22Result
  readonly boundary: ActionFactBoundary
}
export interface ActionFactBoundaryStateHandoff extends ActionFactBoundaryAcceptance {
  readonly c20: C20Result
  readonly c21: C21Result
}

interface PersistableActionBoundaryProposal {
  readonly origin: DirectActionOrigin
  readonly actions: readonly [ActionRef, ...ActionRef[]]
  readonly requiredFacts: Omit<FactNeedSet, 'chat'>
  readonly usableFacts: readonly UsableFact[]
  readonly unresolvedFacts: readonly UnresolvedFact[]
}
interface ClaimedDirectActionBinding {
  readonly owner: ActionFactBoundaryAuthority
  readonly session: Agent['session']
  readonly target: ChatRef
  readonly messageId: string
  readonly hash: string
}
interface ClaimedDirectRegistry {
  readonly claims: WeakMap<ClaimedDirectActionCapability, ClaimedDirectActionBinding>
  readonly registeredMessageIds: WeakMap<Agent['session'], Set<string>>
}
class ClaimedDirectActionToken implements ClaimedDirectActionCapability {
  readonly [claimedDirectActionCapabilityBrand]: 'ClaimedDirectActionCapability' = 'ClaimedDirectActionCapability'
}
type IssuedProposal = {
  readonly focus: FocusDecision
  readonly c02: C02Result
  readonly factNeeds: FactNeedSet
  readonly proposal: PersistableActionBoundaryProposal
  readonly admission: ClaimedDirectActionBinding
}
type PendingEvidenceConclusion =
  | {
      readonly kind: 'single'
      readonly capability: object
      readonly needs: FactNeedSet
      readonly c11: C11Result
      readonly request: EvidenceRetrievalRequest
      readonly c12: C12Result
    }
  | {
      readonly kind: 'multi'
      readonly capability: object
      readonly needs: FactNeedSet
      readonly resolved: MultiFactEvidenceResolutionOutcome
    }
  | {
      readonly kind: 'multi_source'
      readonly capability: object
      readonly needs: FactNeedSet
      readonly resolved: MultiSourceEvidenceResolutionOutcome
    }
type CompletedEvidenceProjection =
  | { readonly kind: 'single'; readonly provenance: EvidenceConclusionProvenance }
  | { readonly kind: 'multi'; readonly provenances: ExactTwo<EvidenceConclusionProvenance> }
  | {
      readonly kind: 'multi_source'
      readonly resolution: MultiSourceEvidenceResolutionOutcome['resolution']
      readonly provenances: readonly EvidenceConclusionProvenance[]
      readonly sourceFindings: readonly AuthenticatedMultiSourceFinding[]
    }
type EvidenceBoundaryRun =
  | {
      readonly stage: 'resolving'
      readonly focus: FocusDecision
      readonly proposal: ActionBoundaryProposal
      readonly capability: object
    }
  | {
      readonly stage: 'c22'
      readonly focus: FocusDecision
      readonly proposal: ActionBoundaryProposal
      readonly capability: object
      readonly evidence: CompletedEvidenceProjection
    }
  | {
      readonly stage: 'c20'
      readonly focus: FocusDecision
      readonly proposal: ActionBoundaryProposal
      readonly accepted: ActionFactBoundaryAcceptance
      readonly evidence: CompletedEvidenceProjection
    }
  | {
      readonly stage: 'c21'
      readonly focus: FocusDecision
      readonly proposal: ActionBoundaryProposal
      readonly accepted: ActionFactBoundaryAcceptance
      readonly c20: C20Result
      readonly evidence: CompletedEvidenceProjection
    }
interface CompletedEvidenceStateHandoff {
  readonly handoff: ActionFactBoundaryStateHandoff
  readonly evidence: CompletedEvidenceProjection
}
const claimedDirectRegistries = new WeakMap<ActionFactBoundaryAuthority, ClaimedDirectRegistry>()
const issued = new WeakMap<ActionFactBoundaryAuthority, WeakSet<object>>()
const payloads = new WeakMap<object, IssuedProposal>()
const restored = new WeakMap<ActionFactBoundaryAuthority, WeakSet<RestoredActionBoundary>>()
const liveAcceptances = new WeakMap<ActionFactBoundaryAuthority, WeakSet<LocalRestrictionAcceptance>>()
const boundaryAcceptances = new WeakMap<ActionFactBoundaryAuthority, WeakSet<ActionFactBoundaryAcceptance>>()
const stateHandoffs = new WeakMap<ActionFactBoundaryAuthority, WeakSet<ActionFactBoundaryStateHandoff>>()
const boundaryAdmissions = new WeakMap<ActionFactBoundaryAcceptance, ClaimedDirectActionBinding>()
const handoffAdmissions = new WeakMap<ActionFactBoundaryStateHandoff, ClaimedDirectActionBinding>()
const localAdmissions = new WeakMap<LocalRestrictionAcceptance, ClaimedDirectActionBinding>()
const acceptedRestoredReports = new WeakMap<ActionFactBoundaryAuthority, WeakSet<C36Result>>()
const claimedRestoredReports = new WeakMap<ActionFactBoundaryAuthority, WeakSet<C36Result>>()
const pendingEvidenceConclusions = new WeakMap<EvidenceConclusionSet, PendingEvidenceConclusion>()
const evidenceBoundaryRuns = new WeakMap<
  ActionFactBoundaryAuthority,
  WeakMap<ActionBoundaryProposal, EvidenceBoundaryRun>
>()
const authenticEvidenceFixedFamilyCompletions = new WeakMap<
  ActionFactBoundaryAuthority,
  WeakSet<CompletedEvidenceLocalRestrictionBoundary | CompletedEvidenceNoSafeActionBoundary>
>()
const actionBoundaryCandidateReceivers = new WeakMap<
  ActionFactBoundaryAuthority,
  ActionBoundaryCandidateReceivers
>()
const actionEvidenceCandidateReceiversBound = new WeakSet<ActionFactBoundaryAuthority>()
const actionEvidenceProcessingStarted = new WeakSet<ActionFactBoundaryAuthority>()
const actionBoundaryCandidateFanoutRuns = new WeakMap<
  ActionFactBoundaryAuthority,
  WeakMap<ActionFactBoundary, { nextStage: 0 | 1 | 2 | 3; active: boolean }>
>()
const pendingActionBoundaryCandidateFanout = new WeakMap<
  ActionFactBoundaryAuthority,
  WeakMap<ActionBoundaryProposal, {
    readonly focus: FocusDecision
    readonly boundary: ActionFactBoundary
  }>
>()

/** @internal One package-local binding; it cannot create or edit a boundary. */
export function bindActionBoundaryCandidateReceivers(
  authority: ActionFactBoundaryAuthority,
  receivers: ActionBoundaryCandidateReceivers,
): boolean {
  const existing = actionBoundaryCandidateReceivers.get(authority)
  if (existing !== undefined) return existing === receivers
  if (typeof receivers.contentReview?.acceptRequiredActionFacts !== 'function'
    || typeof receivers.freshnessReview?.acceptCurrentActionFacts !== 'function'
    || typeof receivers.formation?.acceptActionFactBoundary !== 'function') return false
  actionBoundaryCandidateReceivers.set(authority, receivers)
  return true
}

function identity<Code extends ContractCode, Subject>(contract: Code, subject: Subject) {
  return { contract, call: `${contract}:${crypto.randomUUID()}` as ContractCallRef, subject }
}
function rejected<Code extends ContractCode, Subject>(
  contract: Code,
  subject: Subject,
): Extract<ContractReport<Code, Subject, unknown>, { readonly kind: 'rejected' }> {
  return { kind: 'rejected', identity: identity(contract, subject),
    reason: { kind: 'known_business_precondition_not_met', detail: `${contract}:rejection` as ContractScope<Code, 'rejection'> } }
}

function nonblank(value: string): boolean { return value.trim().length > 0 }
function onlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}
function exactAcceptedBoundaryReport(
  report: C20Result | C21Result,
  contract: 'C20' | 'C21',
  boundary: ActionFactBoundary,
): boolean {
  return report.kind === 'business_result'
    && onlyKeys(report, ['kind', 'identity', 'value'])
    && onlyKeys(report.identity, ['contract', 'call', 'subject'])
    && report.identity.contract === contract
    && nonblank(report.identity.call)
    && report.identity.subject === boundary.ref
    && onlyKeys(report.value, ['kind', 'value'])
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === boundary
}
function exactAcceptedFocusReport(report: C02Result, focus: FocusDecision): boolean {
  return report.kind === 'business_result'
    && onlyKeys(report, ['kind', 'identity', 'value'])
    && onlyKeys(report.identity, ['contract', 'call', 'subject'])
    && report.identity.contract === 'C02'
    && nonblank(report.identity.call)
    && report.identity.subject === focus.ref
    && onlyKeys(report.value, ['kind', 'value'])
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === focus
}
function exactAcceptedBoundaryAdviceReport(
  report: C22Result,
  boundary: ActionFactBoundary,
): boolean {
  return report.kind === 'business_result'
    && onlyKeys(report, ['kind', 'identity', 'value'])
    && onlyKeys(report.identity, ['contract', 'call', 'subject'])
    && report.identity.contract === 'C22'
    && nonblank(report.identity.call)
    && report.identity.subject === boundary.ref
    && onlyKeys(report.value, ['kind', 'value'])
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === boundary
}
function nonemptyTuple<Value>(items: readonly [Value, ...Value[]]): readonly [Value, ...Value[]] {
  return Object.freeze([items[0], ...items.slice(1)]) as readonly [Value, ...Value[]]
}
function frozenUsableFact(fact: UsableFact): UsableFact | undefined {
  if (!nonblank(fact.fact) || !nonblank(fact.meaning) || !nonblank(fact.source) || fact.degree !== 'established') return undefined
  if (fact.kind === 'direct_fact') {
    return onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree'])
      ? Object.freeze({ ...fact }) : undefined
  }
  if (fact.kind !== 'inherited_fact'
    || !onlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree', 'inheritedFrom'])
    || !onlyKeys(fact.inheritedFrom, ['sourceChat', 'sourceCanonicalState'])
    || !nonblank(fact.inheritedFrom.sourceChat)
    || !nonblank(fact.inheritedFrom.sourceCanonicalState)) return undefined
  return Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) })
}
function frozenUnresolvedFact(fact: UnresolvedFact): UnresolvedFact | undefined {
  if (!onlyKeys(fact, ['fact', 'meaning', 'source', 'degree', 'affected'])
    || !nonblank(fact.fact) || !nonblank(fact.meaning) || !nonblank(fact.source) || !nonblank(fact.affected)
    || (fact.degree !== 'insufficient' && fact.degree !== 'conflicting' && fact.degree !== 'unknown')) return undefined
  return Object.freeze({ ...fact })
}
function isDirectEvidenceConclusion(
  conclusion: EvidenceConclusionSet['conclusions'][number],
): conclusion is DirectFact {
  return 'kind' in conclusion && conclusion.kind === 'direct_fact'
}
function validEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
function exactAcceptedFactNeedsReport(report: C11Result, needs: FactNeedSet): boolean {
  return report.kind === 'business_result'
    && onlyKeys(report, ['kind', 'identity', 'value'])
    && onlyKeys(report.identity, ['contract', 'call', 'subject'])
    && report.identity.contract === 'C11'
    && nonblank(report.identity.call)
    && report.identity.subject === needs.ref
    && onlyKeys(report.value, ['kind', 'value'])
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === needs
}
function exactEvidenceRetrievalReport(
  report: C12Result,
  request: EvidenceRetrievalRequest,
  hasMaterial: boolean,
): boolean {
  if (report.kind === 'business_result') {
    return hasMaterial
      && onlyKeys(report, ['kind', 'identity', 'value'])
      && onlyKeys(report.identity, ['contract', 'call', 'subject'])
      && report.identity.contract === 'C12'
      && nonblank(report.identity.call)
      && report.identity.subject === request.ref
      && onlyKeys(report.value, [
        'request', 'actualMaterials', 'sources', 'observedGaps', 'observedConflicts',
      ])
  }
  if (report.kind !== 'known_failure' && report.kind !== 'unknown') return false
  return !hasMaterial
    && onlyKeys(report, ['kind', 'identity', 'problem'])
    && onlyKeys(report.identity, ['contract', 'call', 'subject'])
    && report.identity.contract === 'C12'
    && nonblank(report.identity.call)
    && report.identity.subject === request.ref
    && onlyKeys(report.problem, ['detail', 'affected'])
    && nonblank(report.problem.detail)
    && nonblank(report.problem.affected)
}
function exactEvidenceConclusion(
  conclusion: EvidenceConclusionSet['conclusions'][number],
  requirement: FactRequirement,
): boolean {
  if (conclusion.fact !== requirement.fact
    || !nonblank(conclusion.meaning)
    || !nonblank(conclusion.source)) return false
  if (isDirectEvidenceConclusion(conclusion)) {
    return onlyKeys(conclusion, ['kind', 'fact', 'meaning', 'source', 'degree'])
      && conclusion.degree === 'established'
  }
  return onlyKeys(conclusion, ['fact', 'meaning', 'source', 'degree', 'affected'])
    && conclusion.affected === `actions:${requirement.neededFor.join('|')}`
    && (conclusion.degree === 'insufficient'
      || conclusion.degree === 'conflicting'
      || conclusion.degree === 'unknown')
}
function exactResolvedEvidence(
  payload: IssuedProposal,
  resolved: EvidenceResolutionOutcome,
): boolean {
  const requirement = payload.factNeeds.requirements[0]
  const conclusion = resolved.conclusions.conclusions[0]
  const provenance = resolved.provenance
  if (requirement === undefined || conclusion === undefined
    || !onlyKeys(resolved, ['c11', 'request', 'c12', 'conclusions', 'material', 'provenance'])
    || !onlyKeys(resolved.request, ['ref', 'need'])
    || !nonblank(resolved.request.ref)
    || resolved.request.need !== requirement
    || !exactAcceptedFactNeedsReport(resolved.c11, payload.factNeeds)
    || !onlyKeys(resolved.conclusions, ['ref', 'chat', 'conclusions'])
    || !nonblank(resolved.conclusions.ref)
    || resolved.conclusions.chat !== payload.factNeeds.chat
    || resolved.conclusions.conclusions.length !== 1
    || !exactEvidenceConclusion(conclusion, requirement)
    || !onlyKeys(provenance, ['conclusion', 'source', 'url', 'observedAt', 'publishedAt'])
    || provenance.conclusion !== conclusion
    || provenance.source !== conclusion.source
    || !nonblank(provenance.source)) return false
  const material = resolved.material
  if (material === undefined) {
    return !isDirectEvidenceConclusion(conclusion)
      && exactEvidenceRetrievalReport(resolved.c12, resolved.request, false)
      && provenance.url === undefined
      && provenance.observedAt === undefined
      && provenance.publishedAt === undefined
  }
  return onlyKeys(material, [
    'ref', 'request', 'fact', 'source', 'url', 'content',
    'observedAt', 'publishedAt', 'truncated',
  ])
    && material.request === resolved.request.ref
    && material.fact === requirement.fact
    && material.source === conclusion.source
    && material.truncated === false
    && nonblank(material.content)
    && validEvidenceUrl(material.url)
    && nonblank(material.observedAt)
    && Number.isFinite(Date.parse(material.observedAt))
    && (material.publishedAt === undefined
      || nonblank(material.publishedAt) && Number.isFinite(Date.parse(material.publishedAt)))
    && exactEvidenceRetrievalReport(resolved.c12, resolved.request, true)
    && resolved.c12.kind === 'business_result'
    && resolved.c12.value.request === resolved.request.ref
    && resolved.c12.value.actualMaterials.length === 1
    && resolved.c12.value.actualMaterials[0] === material.ref
    && resolved.c12.value.sources.length === 1
    && resolved.c12.value.sources[0] === material.source
    && resolved.c12.value.observedGaps.length === 0
    && resolved.c12.value.observedConflicts.length === 0
    && provenance.url === material.url
    && provenance.observedAt === material.observedAt
    && provenance.publishedAt === material.publishedAt
}
function safelyExactResolvedEvidence(
  payload: IssuedProposal,
  resolved: EvidenceResolutionOutcome,
): boolean {
  try {
    return exactResolvedEvidence(payload, resolved)
  } catch {
    return false
  }
}
function exactMultiFactEvidenceItem(
  item: MultiFactEvidenceResolutionItem,
  requirement: FactRequirement,
): boolean {
  const { request, c12, material, conclusion, provenance } = item
  if (!onlyKeys(item, ['requirement', 'request', 'c12', 'material', 'conclusion', 'provenance'])
    || item.requirement !== requirement
    || !onlyKeys(request, ['ref', 'need'])
    || !nonblank(request.ref)
    || request.need !== requirement
    || !exactEvidenceConclusion(conclusion, requirement)
    || !onlyKeys(provenance, ['conclusion', 'source', 'url', 'observedAt', 'publishedAt'])
    || provenance.conclusion !== conclusion
    || provenance.source !== conclusion.source
    || !nonblank(provenance.source)) return false
  if (material === undefined) {
    return !isDirectEvidenceConclusion(conclusion)
      && exactEvidenceRetrievalReport(c12, request, false)
      && provenance.url === undefined
      && provenance.observedAt === undefined
      && provenance.publishedAt === undefined
  }
  return onlyKeys(material, [
    'ref', 'request', 'fact', 'source', 'url', 'content',
    'observedAt', 'publishedAt', 'truncated',
  ])
    && material.request === request.ref
    && material.fact === requirement.fact
    && material.source === conclusion.source
    && material.truncated === false
    && nonblank(material.content)
    && validEvidenceUrl(material.url)
    && nonblank(material.observedAt)
    && Number.isFinite(Date.parse(material.observedAt))
    && (material.publishedAt === undefined
      || nonblank(material.publishedAt) && Number.isFinite(Date.parse(material.publishedAt)))
    && exactEvidenceRetrievalReport(c12, request, true)
    && c12.kind === 'business_result'
    && c12.value.request === request.ref
    && c12.value.actualMaterials.length === 1
    && c12.value.actualMaterials[0] === material.ref
    && c12.value.sources.length === 1
    && c12.value.sources[0] === material.source
    && c12.value.observedGaps.length === 0
    && c12.value.observedConflicts.length === 0
    && provenance.url === material.url
    && provenance.observedAt === material.observedAt
    && provenance.publishedAt === material.publishedAt
}
function exactResolvedMultiFactEvidence(
  payload: IssuedProposal,
  resolved: MultiFactEvidenceResolutionOutcome,
): boolean {
  const requirements = exactTwo(payload.factNeeds.requirements)
  const items = exactTwo(resolved.items)
  if (requirements === undefined || items === undefined
    || !onlyKeys(resolved, ['kind', 'c11', 'items', 'conclusions'])
    || resolved.kind !== 'multi'
    || !exactAcceptedFactNeedsReport(resolved.c11, payload.factNeeds)
    || !onlyKeys(resolved.conclusions, ['ref', 'chat', 'conclusions'])
    || !nonblank(resolved.conclusions.ref)
    || resolved.conclusions.chat !== payload.factNeeds.chat
    || resolved.conclusions.conclusions.length !== 2
    || resolved.conclusions.conclusions[0] !== items[0].conclusion
    || resolved.conclusions.conclusions[1] !== items[1].conclusion
    || !exactMultiFactEvidenceItem(items[0], requirements[0])
    || !exactMultiFactEvidenceItem(items[1], requirements[1])) return false
  return projectExactTwoFactResults(requirements, items, isDirectEvidenceConclusion) !== undefined
}
function isMultiSourceEvidenceResolutionOutcome(
  resolved: EvidenceResolutionResult,
): resolved is MultiSourceEvidenceResolutionOutcome {
  return 'kind' in resolved && resolved.kind === 'multi_source'
}
function expectedMultiSourceConclusionSource(
  resolved: MultiSourceEvidenceResolutionOutcome,
): EvidenceSourceRef {
  if (resolved.materials.length !== 2) {
    return `web-source:${createHash('sha256').update(F03_PRIVATE_SEARCH_QUERY).digest('hex')}` as EvidenceSourceRef
  }
  const sources = resolved.materials.map(material => material.source).sort()
  const hash = createHash('sha256').update('multi-source-evidence')
  for (const source of sources) hash.update('\0').update(source)
  return `multi-source:${hash.digest('hex')}` as EvidenceSourceRef
}
function exactResolvedMultiSourceEvidence(
  payload: IssuedProposal,
  resolved: MultiSourceEvidenceResolutionOutcome,
): boolean {
  const requirement = payload.factNeeds.requirements[0]
  const conclusion = resolved.conclusions.conclusions[0]
  if (requirement === undefined || payload.factNeeds.requirements.length !== 1
    || conclusion === undefined
    || !onlyKeys(resolved, [
      'kind', 'resolution', 'c11', 'request', 'c12', 'materials', 'findings',
      'conclusions', 'provenances',
    ])
    || resolved.kind !== 'multi_source'
    || (resolved.resolution !== 'agree'
      && resolved.resolution !== 'conditional'
      && resolved.resolution !== 'conflict'
      && resolved.resolution !== 'source_incomplete')
    || !exactAcceptedFactNeedsReport(resolved.c11, payload.factNeeds)
    || !onlyKeys(resolved.request, ['ref', 'need'])
    || !nonblank(resolved.request.ref)
    || resolved.request.need !== requirement
    || !onlyKeys(resolved.conclusions, ['ref', 'chat', 'conclusions'])
    || !nonblank(resolved.conclusions.ref)
    || resolved.conclusions.chat !== payload.factNeeds.chat
    || resolved.conclusions.conclusions.length !== 1
    || !exactEvidenceConclusion(conclusion, requirement)
    || conclusion.source !== expectedMultiSourceConclusionSource(resolved)
    || resolved.materials.length > 2
    || resolved.findings.length > 2
    || resolved.provenances.length > 2) return false

  const materialRefs = new Set<string>()
  const materialSources = new Set<string>()
  const materialUrls = new Set<string>()
  for (const material of resolved.materials) {
    if (!onlyKeys(material, [
      'ref', 'request', 'fact', 'source', 'url', 'content',
      'observedAt', 'publishedAt', 'truncated',
    ])
      || material.request !== resolved.request.ref
      || material.fact !== requirement.fact
      || !nonblank(material.ref)
      || !nonblank(material.source)
      || !validEvidenceUrl(material.url)
      || !nonblank(material.content)
      || !nonblank(material.observedAt)
      || !Number.isFinite(Date.parse(material.observedAt))
      || (material.publishedAt !== undefined
        && (!nonblank(material.publishedAt) || !Number.isFinite(Date.parse(material.publishedAt))))
      || material.truncated !== false
      || materialRefs.has(material.ref)
      || materialSources.has(material.source)
      || materialUrls.has(material.url)) return false
    materialRefs.add(material.ref)
    materialSources.add(material.source)
    materialUrls.add(material.url)
  }

  const findingMaterials = new Set<string>()
  for (const finding of resolved.findings) {
    if (!onlyKeys(finding, [
      'factNeeds', 'request', 'material', 'fact', 'source', 'conclusion',
      'appliesWhen', 'observedAt', 'publishedAt', 'futureUse',
    ])
      || finding.factNeeds !== payload.factNeeds.ref
      || finding.request !== resolved.request.ref
      || finding.fact !== requirement.fact
      || !nonblank(finding.conclusion)
      || !nonblank(finding.appliesWhen)
      || !nonblank(finding.observedAt)
      || !Number.isFinite(Date.parse(finding.observedAt))
      || (finding.publishedAt !== undefined
        && (!nonblank(finding.publishedAt) || !Number.isFinite(Date.parse(finding.publishedAt))))
      || !nonblank(finding.futureUse)
      || findingMaterials.has(finding.material)) return false
    const material = resolved.materials.find(candidate => candidate.ref === finding.material)
    if (material === undefined
      || finding.source !== material.source
      || finding.observedAt !== material.observedAt
      || finding.publishedAt !== material.publishedAt) return false
    findingMaterials.add(finding.material)
  }

  const provenanceSources = new Set<string>()
  for (const provenance of resolved.provenances) {
    if (!onlyKeys(provenance, ['conclusion', 'source', 'url', 'observedAt', 'publishedAt'])
      || provenance.conclusion !== conclusion
      || !nonblank(provenance.source)
      || provenance.url === undefined
      || provenance.observedAt === undefined
      || provenanceSources.has(provenance.source)) return false
    const material = resolved.materials.find(candidate => candidate.source === provenance.source)
    if (material === undefined
      || provenance.url !== material.url
      || provenance.observedAt !== material.observedAt
      || provenance.publishedAt !== material.publishedAt) return false
    provenanceSources.add(provenance.source)
  }

  if (!exactEvidenceRetrievalReport(resolved.c12, resolved.request, resolved.materials.length > 0)) return false
  if (resolved.materials.length === 0) {
    if (resolved.c12.kind === 'business_result') return false
  } else {
    if (resolved.c12.kind !== 'business_result'
      || resolved.c12.value.request !== resolved.request.ref
      || resolved.c12.value.actualMaterials.length !== resolved.materials.length
      || resolved.c12.value.sources.length !== resolved.materials.length
      || resolved.c12.value.actualMaterials.some(ref => !materialRefs.has(ref))
      || resolved.c12.value.sources.some(source => !materialSources.has(source))
      || resolved.c12.value.observedGaps.length !== 0
      || resolved.c12.value.observedConflicts.length !== 0) return false
  }

  if (resolved.resolution === 'agree' || resolved.resolution === 'conditional') {
    return isDirectEvidenceConclusion(conclusion)
      && resolved.materials.length === 2
      && resolved.findings.length === 2
      && resolved.provenances.length === 2
  }
  if (resolved.resolution === 'conflict') {
    return !isDirectEvidenceConclusion(conclusion)
      && conclusion.degree === 'conflicting'
      && resolved.materials.length === 2
      && resolved.findings.length === 2
      && resolved.provenances.length === 2
  }
  return !isDirectEvidenceConclusion(conclusion)
    && (conclusion.degree === 'insufficient' || conclusion.degree === 'unknown')
    && resolved.findings.length <= resolved.materials.length
    && resolved.provenances.length === resolved.materials.length
}
function authenticatedMultiSourceFindings(
  resolved: MultiSourceEvidenceResolutionOutcome,
): readonly AuthenticatedMultiSourceFinding[] | undefined {
  const projected: AuthenticatedMultiSourceFinding[] = []
  for (const finding of resolved.findings) {
    const material = resolved.materials.find(candidate => candidate.ref === finding.material)
    const provenance = resolved.provenances.find(candidate => candidate.source === finding.source)
    if (material === undefined || provenance === undefined
      || provenance.url !== material.url
      || provenance.observedAt !== finding.observedAt
      || provenance.publishedAt !== finding.publishedAt) return undefined
    projected.push(Object.freeze({
      source: material.source,
      url: material.url,
      conclusion: finding.conclusion,
      appliesWhen: finding.appliesWhen,
      observedAt: finding.observedAt,
      publishedAt: finding.publishedAt,
      futureUse: finding.futureUse,
    }))
  }
  return Object.freeze(projected)
}
function safelyExactEvidenceResult(
  payload: IssuedProposal,
  resolved: EvidenceResolutionResult,
): boolean {
  return isMultiFactEvidenceResolutionOutcome(resolved)
    ? exactResolvedMultiFactEvidence(payload, resolved)
    : isMultiSourceEvidenceResolutionOutcome(resolved)
      ? exactResolvedMultiSourceEvidence(payload, resolved)
      : safelyExactResolvedEvidence(payload, resolved)
}
function hashStrings(hash: ReturnType<typeof createHash>, values: readonly string[]): void {
  hash.update('\0').update(String(values.length))
  for (const value of values) hash.update('\0').update(value)
}

function hasUserMessageId(session: Agent['session'], messageId: string): boolean {
  return session.events.some(event => event.type === 'user/message'
    && String(event.data.id) === messageId)
}

function issueClaimedStructuredDirect(
  owner: ActionFactBoundaryAuthority,
  session: Agent['session'],
  target: ChatRef,
  message: UserMessage,
): ClaimedStructuredDirect | undefined {
  const content = message.content
  const only = content.length === 1 ? content[0] : undefined
  const text = only?.type === 'text' ? only.text : undefined
  const messageId = String(message.id)
  if (message.role !== 'user' || message.source.kind !== 'user'
    || String(session.id) !== target || messageId.trim().length === 0
    || text === undefined || text.trim().length === 0) return undefined
  if (hasUserMessageId(session, messageId)) return undefined
  const registry = claimedDirectRegistries.get(owner)
  if (registry === undefined) return undefined
  const registered = registry.registeredMessageIds.get(session) ?? new Set<string>()
  if (registered.has(messageId)) return undefined
  const hash = createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
  const capability = Object.freeze(new ClaimedDirectActionToken())
  const binding: ClaimedDirectActionBinding = Object.freeze({ owner, session, target, messageId, hash })
  registered.add(messageId)
  registry.registeredMessageIds.set(session, registered)
  registry.claims.set(capability, binding)
  return Object.freeze({
    admission: Object.freeze({ capability, session, target }),
    origin: Object.freeze({ messageId, hash }),
  })
}

export interface ActionFactBoundaryComposition {
  readonly authority: ActionFactBoundaryAuthority
  readonly claimedStructuredDirectIssuer: ClaimedStructuredDirectIssuer
  /** @internal Bind candidate receivers to this composition's actual F03 resolution owner. */
  readonly bindEvidenceConclusionCandidateReceivers: (
    receivers: EvidenceConclusionCandidateReceivers,
  ) => boolean
  readonly completeLocalRestrictionBoundary: CompleteLocalRestrictionBoundaryPort
  readonly completeActionFactBoundary: CompleteActionFactBoundaryPort
  readonly completeEvidenceActionFactBoundary: CompleteEvidenceActionFactBoundaryPort
}

export class ActionFactBoundaryAuthority {
  readonly #evidenceResolution: EvidenceResolution | undefined
  readonly #evidenceOwnerBound: boolean

  private constructor(
    private readonly dependencies: ActionBoundaryDependencies,
    evidenceDependencies: EvidenceResolutionDependencies | undefined,
  ) {
    this.#evidenceResolution = evidenceDependencies === undefined
      ? undefined
      : EvidenceResolution.create(
          evidenceDependencies.web,
          evidenceDependencies.semantic,
          evidenceDependencies.now,
        )
    bindExpectedActionBoundaryOwner(dependencies.preservation, this)
    this.#evidenceOwnerBound = this.#evidenceResolution === undefined
      ? false
      : bindExpectedFactNeedOwner(this.#evidenceResolution, this)
    issued.set(this, new WeakSet())
    restored.set(this, new WeakSet())
    liveAcceptances.set(this, new WeakSet())
    boundaryAcceptances.set(this, new WeakSet())
    stateHandoffs.set(this, new WeakSet())
    acceptedRestoredReports.set(this, new WeakSet())
    claimedRestoredReports.set(this, new WeakSet())
    evidenceBoundaryRuns.set(this, new WeakMap())
    authenticEvidenceFixedFamilyCompletions.set(this, new WeakSet())
    actionBoundaryCandidateFanoutRuns.set(this, new WeakMap())
    pendingActionBoundaryCandidateFanout.set(this, new WeakMap())
    claimedDirectRegistries.set(this, {
      claims: new WeakMap(),
      registeredMessageIds: new WeakMap(),
    })
  }
  static createComposition(
    dependencies: ActionBoundaryDependencies,
    evidenceDependencies?: EvidenceResolutionDependencies,
  ): ActionFactBoundaryComposition {
    const authority = new ActionFactBoundaryAuthority(dependencies, evidenceDependencies)
    const claimedStructuredDirectIssuer: ClaimedStructuredDirectIssuer = Object.freeze({
      issue: (session: Agent['session'], target: ChatRef, message: UserMessage) => {
        actionEvidenceProcessingStarted.add(authority)
        return issueClaimedStructuredDirect(authority, session, target, message)
      },
    })
    const bindCandidateEvidenceReceivers = (
      receivers: EvidenceConclusionCandidateReceivers,
    ): boolean => {
      const resolution = authority.#evidenceResolution
      if (resolution === undefined
        || actionEvidenceCandidateReceiversBound.has(authority)
        || actionEvidenceProcessingStarted.has(authority)
        || !bindEvidenceConclusionCandidateReceivers(resolution, receivers)) return false
      actionEvidenceCandidateReceiversBound.add(authority)
      return true
    }
    const completeLocalRestrictionBoundary: CompleteLocalRestrictionBoundaryPort = Object.freeze({
      accept: (focus: FocusDecision, proposal: ActionBoundaryProposal) =>
        authority.completeLocalRestriction(focus, proposal),
    })
    const completeActionFactBoundary: CompleteActionFactBoundaryPort = Object.freeze({
      accept: (focus: FocusDecision, proposal: ActionBoundaryProposal) =>
        authority.completeGeneralBoundary(focus, proposal),
    })
    const completeEvidenceActionFactBoundary: CompleteEvidenceActionFactBoundaryPort = Object.freeze({
      accept: (focus: FocusDecision, proposal: ActionBoundaryProposal, signal: AbortSignal) =>
        authority.#completeEvidenceBoundary(focus, proposal, signal),
    })
    return Object.freeze({ authority, claimedStructuredDirectIssuer,
      bindEvidenceConclusionCandidateReceivers: bindCandidateEvidenceReceivers,
      completeLocalRestrictionBoundary, completeActionFactBoundary, completeEvidenceActionFactBoundary })
  }

  private acceptFocusForActionBoundary(focus: FocusDecision): C02Result {
    if (focus.kind !== 'focus_established') return rejected('C02', focus.ref)
    return { kind: 'business_result', identity: identity('C02', focus.ref), value: { kind: 'accepted_for_contract', value: focus } }
  }

  #acceptedCandidateBoundaryDelivery(
    report: unknown,
    contract: 'C14' | 'C16' | 'C18',
    boundary: ActionFactBoundary,
  ): boolean {
    if (report === null || typeof report !== 'object') return false
    const value = report as {
      readonly kind?: unknown
      readonly identity?: { readonly contract?: unknown; readonly subject?: unknown }
      readonly value?: { readonly kind?: unknown; readonly value?: unknown }
    }
    return value.kind === 'business_result'
      && value.identity?.contract === contract
      && value.identity.subject === boundary.ref
      && value.value?.kind === 'accepted_for_contract'
      && value.value.value === boundary
  }

  #fanoutCandidateBoundary(boundary: ActionFactBoundary): boolean {
    const receivers = actionBoundaryCandidateReceivers.get(this)
    if (receivers === undefined) return true
    if (!Object.isFrozen(boundary)
      || !Object.isFrozen(boundary.usableFacts)
      || !Object.isFrozen(boundary.unresolvedFacts)
      || !Object.isFrozen(boundary.preciselyBlockedActions)
      || !Object.isFrozen(boundary.safelyContinuableActions)
      || !nonblank(boundary.ref)
      || !nonblank(boundary.chat)) return false
    const runs = actionBoundaryCandidateFanoutRuns.get(this)
    if (runs === undefined) return false
    let run = runs.get(boundary)
    if (run === undefined) {
      run = { nextStage: 0, active: false }
      runs.set(boundary, run)
    }
    if (run.active) return false
    if (run.nextStage === 3) return true
    run.active = true
    try {
      while (run.nextStage < 3) {
        let contract: 'C14' | 'C16' | 'C18'
        let report: unknown
        try {
          if (run.nextStage === 0) {
            contract = 'C16'
            report = receivers.contentReview.acceptRequiredActionFacts(boundary)
          } else if (run.nextStage === 1) {
            contract = 'C18'
            report = receivers.freshnessReview.acceptCurrentActionFacts(boundary)
          } else {
            contract = 'C14'
            report = receivers.formation.acceptActionFactBoundary(boundary)
          }
        } catch {
          return false
        }
        if (!this.#acceptedCandidateBoundaryDelivery(report, contract, boundary)) return false
        run.nextStage = (run.nextStage + 1) as 1 | 2 | 3
      }
      return true
    } finally {
      run.active = false
    }
  }

  #deliverCandidateBoundary(
    focus: FocusDecision,
    proposal: ActionBoundaryProposal,
    boundary: ActionFactBoundary,
  ): void {
    const pending = pendingActionBoundaryCandidateFanout.get(this)
    if (pending === undefined) return
    if (this.#fanoutCandidateBoundary(boundary)) pending.delete(proposal)
    else pending.set(proposal, Object.freeze({ focus, boundary }))
  }

  #retryCandidateBoundary(focus: FocusDecision, proposal: ActionBoundaryProposal): void {
    const pending = pendingActionBoundaryCandidateFanout.get(this)
    const delivery = pending?.get(proposal)
    if (delivery === undefined || delivery.focus !== focus) return
    if (this.#fanoutCandidateBoundary(delivery.boundary)) pending?.delete(proposal)
  }

  /** The bounded caller receives no authority: only this owner may consume it once. */
  private issueBoundedProposal(focus: FocusDecision, proposal: ActionBoundaryProposal): object | undefined {
    const unsigned = proposal.unsigned
    if (focus.kind !== 'focus_established'
      || proposal.admission.target !== focus.chat
      || !onlyKeys(proposal, ['admission', 'unsigned'])
      || !onlyKeys(unsigned, ['origin', 'focus', 'actions', 'proposedRequirements', 'usableInputs', 'unresolvedInputs'])
      || !onlyKeys(unsigned.origin, ['message', 'chat', 'expressionHash'])
      || unsigned.focus !== focus.ref || unsigned.origin.chat !== focus.chat
      || !nonblank(unsigned.origin.message) || !nonblank(unsigned.origin.expressionHash)
      || unsigned.actions.length === 0 || unsigned.actions.some(action => !nonblank(action))
      || new Set(unsigned.actions).size !== unsigned.actions.length
      || unsigned.proposedRequirements.some(requirement => !onlyKeys(requirement, ['fact', 'neededFor'])
        || !nonblank(requirement.fact) || requirement.neededFor.length === 0
        || requirement.neededFor.some(action => !nonblank(action)))) return undefined
    const usableFacts = unsigned.usableInputs.map(frozenUsableFact)
    const unresolvedFacts = unsigned.unresolvedInputs.map(frozenUnresolvedFact)
    if (usableFacts.some(fact => fact === undefined) || unresolvedFacts.some(fact => fact === undefined)) return undefined
    const requirements = unsigned.proposedRequirements.map(requirement => Object.freeze({
      fact: requirement.fact,
      neededFor: nonemptyTuple(requirement.neededFor),
    }))
    const requiredFactRefs = requirements.map(requirement => requirement.fact)
    const usableFactRefs = unsigned.usableInputs.map(fact => fact.fact)
    const unresolvedFactRefs = unsigned.unresolvedInputs.map(fact => fact.fact)
    const establishedFactRefs = [...usableFactRefs, ...unresolvedFactRefs]
    const actionSet = new Set(unsigned.actions)
    if (new Set(requiredFactRefs).size !== requiredFactRefs.length
      || new Set(usableFactRefs).size !== usableFactRefs.length
      || new Set(unresolvedFactRefs).size !== unresolvedFactRefs.length
      || new Set(establishedFactRefs).size !== establishedFactRefs.length
      || new Set(establishedFactRefs).size !== new Set(requiredFactRefs).size
      || requiredFactRefs.some(fact => !establishedFactRefs.includes(fact))
      || requirements.some(requirement => requirement.neededFor.some(action => !actionSet.has(action)))) return undefined
    const claimRegistry = claimedDirectRegistries.get(this)
    const admission = claimRegistry?.claims.get(proposal.admission.capability)
    if (admission === undefined || admission.owner !== this
      || admission.session !== proposal.admission.session
      || admission.target !== proposal.admission.target
      || admission.messageId !== unsigned.origin.message
      || admission.hash !== unsigned.origin.expressionHash) return undefined
    if (hasUserMessageId(admission.session, admission.messageId)) return undefined
    claimRegistry?.claims.delete(proposal.admission.capability)
    const c02 = this.acceptFocusForActionBoundary(focus)
    if (c02.kind !== 'business_result') return undefined
    const factNeedHash = createHash('sha256').update('fact-need-set')
      .update('\0').update(focus.ref).update('\0').update(focus.chat)
      .update('\0').update(unsigned.origin.message).update('\0').update(unsigned.origin.expressionHash)
    factNeedHash.update('\0').update(String(requirements.length))
    for (const requirement of requirements) {
      factNeedHash.update('\0').update(requirement.fact)
      hashStrings(factNeedHash, requirement.neededFor)
    }
    const factNeedSet: FactNeedSet = Object.freeze({
      ref: `fact-needs:${factNeedHash.digest('hex')}` as FactNeedSetRef,
      chat: focus.chat,
      requirements: Object.freeze(requirements),
    })
    const snapshot: PersistableActionBoundaryProposal = Object.freeze({
      origin: Object.freeze({ messageId: admission.messageId, hash: admission.hash }),
      actions: nonemptyTuple(unsigned.actions),
      requiredFacts: Object.freeze({ ref: factNeedSet.ref, requirements: factNeedSet.requirements }),
      usableFacts: Object.freeze(usableFacts) as readonly UsableFact[],
      unresolvedFacts: Object.freeze(unresolvedFacts) as readonly UnresolvedFact[],
    })
    const capability = Object.freeze({})
    issued.get(this)?.add(capability)
    payloads.set(capability, { focus, c02, factNeeds: factNeedSet, proposal: snapshot, admission })
    return capability
  }

  private consumeIssuedBoundary(
    capability: object,
    requireExactReport = false,
  ): ActionFactBoundaryAcceptance | undefined {
    if (issued.get(this)?.has(capability) !== true) return undefined
    const payload = payloads.get(capability)
    if (payload === undefined || payload.focus.kind !== 'focus_established') return undefined
    const proposal = payload.proposal
    const unresolved = new Set(proposal.unresolvedFacts.map(fact => fact.fact))
    const blockedSet = new Set<ActionRef>()
    for (const requirement of proposal.requiredFacts.requirements) {
      if (unresolved.has(requirement.fact)) for (const action of requirement.neededFor) blockedSet.add(action)
    }
    const blocked = proposal.actions.filter(action => blockedSet.has(action))
    const safe = proposal.actions.filter(action => !blockedSet.has(action))
    const refHash = createHash('sha256').update(payload.focus.ref)
      .update('\0').update(proposal.origin.messageId).update('\0').update(proposal.origin.hash)
    refHash.update('\0').update(proposal.requiredFacts.ref)
    refHash.update('\0').update(String(proposal.requiredFacts.requirements.length))
    for (const requirement of proposal.requiredFacts.requirements) {
      refHash.update('\0').update(requirement.fact)
      hashStrings(refHash, requirement.neededFor)
    }
    refHash.update('\0').update(String(proposal.usableFacts.length))
    for (const fact of proposal.usableFacts) {
      refHash.update('\0').update(fact.kind).update('\0').update(fact.fact)
        .update('\0').update(fact.meaning).update('\0').update(fact.source).update('\0').update(fact.degree)
      if (fact.kind === 'inherited_fact') refHash.update('\0').update(fact.inheritedFrom.sourceChat)
        .update('\0').update(fact.inheritedFrom.sourceCanonicalState)
    }
    refHash.update('\0').update(String(proposal.unresolvedFacts.length))
    for (const fact of proposal.unresolvedFacts) {
      refHash.update('\0').update(fact.fact).update('\0').update(fact.meaning)
        .update('\0').update(fact.source).update('\0').update(fact.degree).update('\0').update(fact.affected)
    }
    hashStrings(refHash, blocked)
    hashStrings(refHash, safe)
    const ref = `action-boundary:${refHash.digest('hex')}` as ActionFactBoundaryRef
    const core = {
      ref, chat: payload.focus.chat, requiredFacts: proposal.requiredFacts,
      usableFacts: proposal.usableFacts, unresolvedFacts: proposal.unresolvedFacts,
    }
    const boundary: ActionFactBoundary = blocked.length === 0
      ? Object.freeze({ ...core, kind: 'actionable' as const, preciselyBlockedActions: Object.freeze([] as const),
          safelyContinuableActions: nonemptyTuple(proposal.actions) })
      : safe.length === 0
        ? Object.freeze({ ...core, kind: 'no_safe_action' as const,
            preciselyBlockedActions: nonemptyTuple(proposal.actions), safelyContinuableActions: Object.freeze([] as const) })
        : Object.freeze({ ...core, kind: 'local_restriction' as const,
            preciselyBlockedActions: nonemptyTuple(blocked as [ActionRef, ...ActionRef[]]),
            safelyContinuableActions: nonemptyTuple(safe as [ActionRef, ...ActionRef[]]) })
    const c22 = this.dependencies.userInteraction.acceptFactDecisionNeeds(boundary)
    if (c22.kind !== 'business_result' || c22.identity.contract !== 'C22'
      || c22.identity.subject !== boundary.ref || c22.value.kind !== 'accepted_for_contract'
      || c22.value.value !== boundary
      || (requireExactReport && !exactAcceptedBoundaryAdviceReport(c22, boundary))) return undefined
    issued.get(this)?.delete(capability)
    payloads.delete(capability)
    const acceptance: ActionFactBoundaryAcceptance = Object.freeze({
      origin: proposal.origin, c02: payload.c02, c22, boundary,
    })
    boundaryAcceptances.get(this)?.add(acceptance)
    boundaryAdmissions.set(acceptance, payload.admission)
    return acceptance
  }

  /** Stable F09 handoff: the sole owner sends one exact general boundary to the formal C20/C21 receivers once. */
  private sendActionBoundaryToState(acceptedBoundary: ActionFactBoundaryAcceptance): ActionFactBoundaryStateHandoff | undefined {
    const acceptances = boundaryAcceptances.get(this)
    if (acceptances?.has(acceptedBoundary) !== true) return undefined
    acceptances.delete(acceptedBoundary)
    const boundary = acceptedBoundary.boundary
    const c20 = this.dependencies.preservation.acceptActionBoundaryToPreserve(boundary)
    const c21 = this.dependencies.canonicalContext.acceptActionSafetyBoundary(boundary)
    const handoff: ActionFactBoundaryStateHandoff = Object.freeze({ ...acceptedBoundary, c20, c21 })
    stateHandoffs.get(this)?.add(handoff)
    const admission = boundaryAdmissions.get(acceptedBoundary)
    boundaryAdmissions.delete(acceptedBoundary)
    if (admission !== undefined) handoffAdmissions.set(handoff, admission)
    return handoff
  }

  /** Local provider consumes only a successful exact local handoff; foreign/wrong/reused objects consume nothing. */
  private acceptLocalRestriction(handoff: ActionFactBoundaryStateHandoff): LocalRestrictionAcceptance | undefined {
    const handoffs = stateHandoffs.get(this)
    if (handoffs?.has(handoff) !== true || handoff.boundary.kind !== 'local_restriction') return undefined
    const { boundary, c20, c21 } = handoff
    if (c20.kind !== 'business_result' || c21.kind !== 'business_result'
      || c20.value.kind !== 'accepted_for_contract' || c20.value.value !== boundary
      || c21.value.kind !== 'accepted_for_contract' || c21.value.value !== boundary) return undefined
    handoffs.delete(handoff)
    const acceptance: LocalRestrictionAcceptance = Object.freeze({
      origin: handoff.origin,
      c02: handoff.c02,
      c20,
      c21,
      c22: handoff.c22,
    })
    liveAcceptances.get(this)?.add(acceptance)
    const admission = handoffAdmissions.get(handoff)
    handoffAdmissions.delete(handoff)
    if (admission !== undefined) localAdmissions.set(acceptance, admission)
    return acceptance
  }

  /**
   * C13 is the sole evidence receiver. Only the exact conclusion object bound
   * to this authority's still-issued proposal may update facts, and it does so
   * once without changing C02/C20/C21/C22 ownership or shape.
   */
  #acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): C13Result {
    const pending = pendingEvidenceConclusions.get(conclusions)
    return pending?.kind === 'multi_source'
      ? this.#acceptMultiSourceEvidenceConclusions(conclusions, pending)
      : pending?.kind === 'multi'
      ? this.#acceptMultiFactEvidenceConclusions(conclusions, pending)
      : this.#acceptSingleEvidenceConclusions(conclusions)
  }

  #acceptSingleEvidenceConclusions(conclusions: EvidenceConclusionSet): C13Result {
    const pending = pendingEvidenceConclusions.get(conclusions)
    const payload = pending?.kind === 'single' ? payloads.get(pending.capability) : undefined
    const conclusion = conclusions.conclusions[0]
    const requirement = pending?.kind === 'single' ? pending.needs.requirements[0] : undefined
    if (pending?.kind !== 'single' || payload === undefined || requirement === undefined
      || issued.get(this)?.has(pending.capability) !== true
      || payload.factNeeds !== pending.needs
      || pending.c11.kind !== 'business_result'
      || pending.c11.identity.contract !== 'C11'
      || pending.c11.identity.subject !== pending.needs.ref
      || pending.c11.value.kind !== 'accepted_for_contract'
      || pending.c11.value.value !== pending.needs
      || pending.request.need !== requirement
      || pending.c12.identity.contract !== 'C12'
      || pending.c12.identity.subject !== pending.request.ref
      || !onlyKeys(conclusions, ['ref', 'chat', 'conclusions'])
      || !nonblank(conclusions.ref)
      || conclusions.chat !== pending.needs.chat
      || conclusions.conclusions.length !== 1
      || conclusion === undefined
      || conclusion.fact !== requirement.fact
      || !nonblank(conclusion.meaning)
      || !nonblank(conclusion.source)) return rejected('C13', conclusions.ref)
    if (isDirectEvidenceConclusion(conclusion)) {
      if (!onlyKeys(conclusion, ['kind', 'fact', 'meaning', 'source', 'degree'])
        || conclusion.degree !== 'established'
        || pending.c12.kind !== 'business_result'
        || pending.c12.value.request !== pending.request.ref
        || pending.c12.value.actualMaterials.length !== 1
        || pending.c12.value.sources.length !== 1
        || pending.c12.value.sources[0] !== conclusion.source
        || pending.c12.value.observedGaps.length !== 0
        || pending.c12.value.observedConflicts.length !== 0) return rejected('C13', conclusions.ref)
    } else if (!onlyKeys(conclusion, ['fact', 'meaning', 'source', 'degree', 'affected'])
      || !nonblank(conclusion.affected)
      || conclusion.affected !== `actions:${requirement.neededFor.join('|')}`
      || (conclusion.degree !== 'insufficient'
        && conclusion.degree !== 'conflicting'
        && conclusion.degree !== 'unknown')) return rejected('C13', conclusions.ref)

    const previous = payload.proposal
    const usableFacts = isDirectEvidenceConclusion(conclusion)
      ? Object.freeze([
          ...previous.usableFacts.filter(fact => fact.fact !== conclusion.fact),
          conclusion,
        ])
      : Object.freeze(previous.usableFacts.filter(fact => fact.fact !== conclusion.fact))
    const unresolvedFacts = isDirectEvidenceConclusion(conclusion)
      ? Object.freeze(previous.unresolvedFacts.filter(fact => fact.fact !== conclusion.fact))
      : Object.freeze([
          ...previous.unresolvedFacts.filter(fact => fact.fact !== conclusion.fact),
          conclusion,
        ])
    const updated: PersistableActionBoundaryProposal = Object.freeze({
      origin: previous.origin,
      actions: previous.actions,
      requiredFacts: previous.requiredFacts,
      usableFacts,
      unresolvedFacts,
    })
    const c13: C13Result = {
      kind: 'business_result',
      identity: identity('C13', conclusions.ref),
      value: { kind: 'accepted_for_contract', value: conclusions },
    }
    pendingEvidenceConclusions.delete(conclusions)
    payloads.set(pending.capability, Object.freeze({ ...payload, proposal: updated }))
    return c13
  }

  #acceptMultiFactEvidenceConclusions(
    conclusions: EvidenceConclusionSet,
    pending: Extract<PendingEvidenceConclusion, { readonly kind: 'multi' }>,
  ): C13Result {
    const payload = payloads.get(pending.capability)
    if (payload === undefined
      || pending.resolved.conclusions !== conclusions
      || issued.get(this)?.has(pending.capability) !== true
      || payload.factNeeds !== pending.needs
      || !exactResolvedMultiFactEvidence(payload, pending.resolved)) return rejected('C13', conclusions.ref)
    const projection = projectExactTwoFactResults(
      payload.factNeeds.requirements,
      pending.resolved.items,
      isDirectEvidenceConclusion,
    )
    if (projection === undefined) return rejected('C13', conclusions.ref)
    const previous = payload.proposal
    const updated: PersistableActionBoundaryProposal = Object.freeze({
      origin: previous.origin,
      actions: previous.actions,
      requiredFacts: previous.requiredFacts,
      usableFacts: Object.freeze(projection.usableFacts) as readonly UsableFact[],
      unresolvedFacts: Object.freeze(projection.unresolvedFacts) as readonly UnresolvedFact[],
    })
    const c13: C13Result = {
      kind: 'business_result',
      identity: identity('C13', conclusions.ref),
      value: { kind: 'accepted_for_contract', value: conclusions },
    }
    pendingEvidenceConclusions.delete(conclusions)
    payloads.set(pending.capability, Object.freeze({ ...payload, proposal: updated }))
    return c13
  }

  #acceptMultiSourceEvidenceConclusions(
    conclusions: EvidenceConclusionSet,
    pending: Extract<PendingEvidenceConclusion, { readonly kind: 'multi_source' }>,
  ): C13Result {
    const payload = payloads.get(pending.capability)
    const conclusion = conclusions.conclusions[0]
    if (payload === undefined || conclusion === undefined
      || pending.resolved.conclusions !== conclusions
      || issued.get(this)?.has(pending.capability) !== true
      || payload.factNeeds !== pending.needs
      || !exactResolvedMultiSourceEvidence(payload, pending.resolved)) {
      return rejected('C13', conclusions.ref)
    }
    const previous = payload.proposal
    const usableFacts = isDirectEvidenceConclusion(conclusion)
      ? Object.freeze([
          ...previous.usableFacts.filter(fact => fact.fact !== conclusion.fact),
          conclusion,
        ])
      : Object.freeze(previous.usableFacts.filter(fact => fact.fact !== conclusion.fact))
    const unresolvedFacts = isDirectEvidenceConclusion(conclusion)
      ? Object.freeze(previous.unresolvedFacts.filter(fact => fact.fact !== conclusion.fact))
      : Object.freeze([
          ...previous.unresolvedFacts.filter(fact => fact.fact !== conclusion.fact),
          conclusion,
        ])
    const updated: PersistableActionBoundaryProposal = Object.freeze({
      origin: previous.origin,
      actions: previous.actions,
      requiredFacts: previous.requiredFacts,
      usableFacts,
      unresolvedFacts,
    })
    const c13: C13Result = {
      kind: 'business_result',
      identity: identity('C13', conclusions.ref),
      value: { kind: 'accepted_for_contract', value: conclusions },
    }
    pendingEvidenceConclusions.delete(conclusions)
    payloads.set(pending.capability, Object.freeze({ ...payload, proposal: updated }))
    return c13
  }

  /** One complete F03 chain. No intermediate capability leaves this method. */
  async #completeEvidenceBoundary(
    focus: FocusDecision,
    proposal: ActionBoundaryProposal,
    signal: AbortSignal,
  ): Promise<CompletedEvidenceActionFactBoundary | undefined> {
    actionEvidenceProcessingStarted.add(this)
    const resolution = this.#evidenceResolution
    const runs = evidenceBoundaryRuns.get(this)
    if (resolution === undefined || !this.#evidenceOwnerBound || runs === undefined) return undefined
    this.#retryCandidateBoundary(focus, proposal)
    const prior = runs.get(proposal)
    if (prior !== undefined) {
      if (prior.focus !== focus || prior.proposal !== proposal) return undefined
      if (prior.stage === 'resolving') return await this.#resumeEvidenceResolution(prior, signal)
      const completedState = this.#resumeEvidenceBoundary(prior)
      return completedState === undefined ? undefined : this.#completeEvidenceFamily(completedState)
    }
    if (signal.aborted) return undefined
    const capability = this.issueBoundedProposal(focus, proposal)
    if (capability === undefined) return undefined
    const payload = payloads.get(capability)
    if (payload === undefined || payload.focus.kind !== 'focus_established') return undefined
    const requirements = payload.factNeeds.requirements
    const unresolved = payload.proposal.unresolvedFacts
    if (requirements.length < 1 || requirements.length > 2
      || payload.proposal.usableFacts.length !== 0
      || unresolved.length !== requirements.length
      || requirements.some(requirement => !unresolved.some(fact => fact.fact === requirement.fact))
      || unresolved.some(fact => !requirements.some(requirement => requirement.fact === fact.fact))) return undefined
    const resolving: Extract<EvidenceBoundaryRun, { readonly stage: 'resolving' }> = Object.freeze({
      stage: 'resolving', focus, proposal, capability,
    })
    runs.set(proposal, resolving)
    if (!issueOwnerBoundFactNeedSet(
      resolution,
      this,
      payload.factNeeds,
      payload.focus,
      Object.freeze({
        messageId: payload.admission.messageId,
        hash: payload.admission.hash,
        chat: payload.admission.target,
      }),
    )) return undefined
    return await this.#resumeEvidenceResolution(resolving, signal)
  }

  /** Retry only the private resolution receiver; direct admission and C02 remain consumed exactly once. */
  async #resumeEvidenceResolution(
    run: Extract<EvidenceBoundaryRun, { readonly stage: 'resolving' }>,
    signal: AbortSignal,
  ): Promise<CompletedEvidenceActionFactBoundary | undefined> {
    const resolution = this.#evidenceResolution
    const runs = evidenceBoundaryRuns.get(this)
    const payload = payloads.get(run.capability)
    if (resolution === undefined || runs?.get(run.proposal) !== run
      || payload === undefined || payload.focus !== run.focus) return undefined
    let resolved: EvidenceResolutionResult | undefined
    try {
      resolved = await resolution.acceptFactNeeds(payload.factNeeds, signal)
    } catch {
      return undefined
    }
    if (resolved === undefined
      || !safelyExactEvidenceResult(payload, resolved)
      || pendingEvidenceConclusions.has(resolved.conclusions)) return undefined
    pendingEvidenceConclusions.set(resolved.conclusions,
      isMultiSourceEvidenceResolutionOutcome(resolved)
        ? Object.freeze({
            kind: 'multi_source',
            capability: run.capability,
            needs: payload.factNeeds,
            resolved,
          })
        : isMultiFactEvidenceResolutionOutcome(resolved)
          ? Object.freeze({
              kind: 'multi',
              capability: run.capability,
              needs: payload.factNeeds,
              resolved,
            })
          : Object.freeze({
              kind: 'single',
              capability: run.capability,
              needs: payload.factNeeds,
              c11: resolved.c11,
              request: resolved.request,
              c12: resolved.c12,
            }))
    const c13 = this.#acceptEvidenceConclusions(resolved.conclusions)
    if (c13.kind !== 'business_result'
      || c13.identity.contract !== 'C13'
      || c13.identity.subject !== resolved.conclusions.ref
      || c13.value.kind !== 'accepted_for_contract'
      || c13.value.value !== resolved.conclusions
      || !safelyExactEvidenceResult(payload, resolved)) return undefined
    const sourceFindings = isMultiSourceEvidenceResolutionOutcome(resolved)
      ? authenticatedMultiSourceFindings(resolved)
      : undefined
    if (isMultiSourceEvidenceResolutionOutcome(resolved) && sourceFindings === undefined) return undefined
    const evidence: CompletedEvidenceProjection = isMultiSourceEvidenceResolutionOutcome(resolved)
      ? Object.freeze({
          kind: 'multi_source',
          resolution: resolved.resolution,
          provenances: Object.freeze([...resolved.provenances]),
          sourceFindings: sourceFindings ?? Object.freeze([]),
        })
      : isMultiFactEvidenceResolutionOutcome(resolved)
        ? Object.freeze({
            kind: 'multi',
            provenances: Object.freeze([
              resolved.items[0].provenance,
              resolved.items[1].provenance,
            ]) as ExactTwo<EvidenceConclusionProvenance>,
          })
        : Object.freeze({ kind: 'single', provenance: resolved.provenance })
    const ready: EvidenceBoundaryRun = Object.freeze({
      stage: 'c22', focus: run.focus, proposal: run.proposal,
      capability: run.capability, evidence,
    })
    runs.set(run.proposal, ready)
    const completedState = this.#resumeEvidenceBoundary(ready)
    return completedState === undefined ? undefined : this.#completeEvidenceFamily(completedState)
  }

  /** Resume only the exact proposal's next receiver; prior successful stages are never replayed. */
  #resumeEvidenceBoundary(
    initial: Exclude<EvidenceBoundaryRun, { readonly stage: 'resolving' }>,
  ): CompletedEvidenceStateHandoff | undefined {
    const runs = evidenceBoundaryRuns.get(this)
    if (runs === undefined || runs.get(initial.proposal) !== initial) return undefined
    let run = initial
    if (run.stage === 'c22') {
      let accepted: ActionFactBoundaryAcceptance | undefined
      try {
        accepted = this.consumeIssuedBoundary(run.capability, true)
      } catch {
        return undefined
      }
      if (accepted === undefined
        || !exactAcceptedFocusReport(accepted.c02, run.focus)
        || !exactAcceptedBoundaryAdviceReport(accepted.c22, accepted.boundary)) return undefined
      this.#deliverCandidateBoundary(run.focus, run.proposal, accepted.boundary)
      const next: EvidenceBoundaryRun = Object.freeze({
        stage: 'c20', focus: run.focus, proposal: run.proposal,
        accepted, evidence: run.evidence,
      })
      runs.set(run.proposal, next)
      run = next
    }
    if (run.stage === 'c20') {
      let c20: C20Result
      try {
        c20 = this.dependencies.preservation.acceptActionBoundaryToPreserve(run.accepted.boundary)
      } catch {
        return undefined
      }
      if (!exactAcceptedBoundaryReport(c20, 'C20', run.accepted.boundary)) return undefined
      const next: EvidenceBoundaryRun = Object.freeze({
        stage: 'c21', focus: run.focus, proposal: run.proposal,
        accepted: run.accepted, c20, evidence: run.evidence,
      })
      runs.set(run.proposal, next)
      run = next
    }
    let c21: C21Result
    try {
      c21 = this.dependencies.canonicalContext.acceptActionSafetyBoundary(run.accepted.boundary)
    } catch {
      return undefined
    }
    if (!exactAcceptedBoundaryReport(c21, 'C21', run.accepted.boundary)) return undefined
    const acceptances = boundaryAcceptances.get(this)
    if (acceptances?.has(run.accepted) !== true
      || !exactAcceptedFocusReport(run.accepted.c02, run.focus)
      || !exactAcceptedBoundaryReport(run.c20, 'C20', run.accepted.boundary)) return undefined
    acceptances.delete(run.accepted)
    const handoff: ActionFactBoundaryStateHandoff = Object.freeze({ ...run.accepted, c20: run.c20, c21 })
    stateHandoffs.get(this)?.add(handoff)
    const admission = boundaryAdmissions.get(run.accepted)
    boundaryAdmissions.delete(run.accepted)
    if (admission !== undefined) handoffAdmissions.set(handoff, admission)
    runs.delete(run.proposal)
    return Object.freeze({ handoff, evidence: run.evidence })
  }

  /** Dispatch one completed evidence handoff exactly once inside its owner. */
  #completeEvidenceFamily(
    completedState: CompletedEvidenceStateHandoff,
  ): CompletedEvidenceActionFactBoundary | undefined {
    const { handoff, evidence } = completedState
    const boundary = handoff.boundary
    if (boundary.kind === 'local_restriction') {
      const acceptance = this.acceptLocalRestriction(handoff)
      if (acceptance === undefined) return undefined
      const completion: CompletedEvidenceLocalRestrictionBoundary | undefined = evidence.kind === 'multi_source'
        ? evidence.resolution === 'conflict' || evidence.resolution === 'source_incomplete'
          ? Object.freeze({
              kind: 'multi_source', resolution: evidence.resolution,
              family: 'local_restriction', provenances: evidence.provenances,
              sourceFindings: evidence.sourceFindings,
              origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
              c21: handoff.c21, c22: handoff.c22, boundary, acceptance,
            })
          : undefined
        : evidence.kind === 'multi'
        ? Object.freeze({
            kind: 'multi', family: 'local_restriction', provenances: evidence.provenances,
            origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
            c21: handoff.c21, c22: handoff.c22, boundary, acceptance,
          })
        : Object.freeze({
            family: 'local_restriction', provenance: evidence.provenance, origin: handoff.origin,
            c02: handoff.c02, c20: handoff.c20, c21: handoff.c21, c22: handoff.c22,
            boundary, acceptance,
          })
      if (completion === undefined) return undefined
      authenticEvidenceFixedFamilyCompletions.get(this)?.add(completion)
      return completion
    }
    if (boundary.kind === 'no_safe_action') {
      const completion: CompletedEvidenceNoSafeActionBoundary | undefined = evidence.kind === 'multi_source'
        ? evidence.resolution === 'conflict' || evidence.resolution === 'source_incomplete'
          ? Object.freeze({
              kind: 'multi_source', resolution: evidence.resolution,
              family: 'no_safe_action', provenances: evidence.provenances,
              sourceFindings: evidence.sourceFindings,
              origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
              c21: handoff.c21, c22: handoff.c22, boundary, handoff,
            })
          : undefined
        : evidence.kind === 'multi'
        ? Object.freeze({
            kind: 'multi', family: 'no_safe_action', provenances: evidence.provenances,
            origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
            c21: handoff.c21, c22: handoff.c22, boundary, handoff,
          })
        : Object.freeze({
            family: 'no_safe_action', provenance: evidence.provenance, origin: handoff.origin,
            c02: handoff.c02, c20: handoff.c20, c21: handoff.c21, c22: handoff.c22,
            boundary, handoff,
          })
      if (completion === undefined) return undefined
      authenticEvidenceFixedFamilyCompletions.get(this)?.add(completion)
      return completion
    }
    const handoffs = stateHandoffs.get(this)
    if (handoffs?.has(handoff) !== true) return undefined
    handoffs.delete(handoff)
    handoffAdmissions.delete(handoff)
    if (evidence.kind === 'multi_source') {
      const provenances = exactTwo(evidence.provenances)
      const sourceFindings = exactTwo(evidence.sourceFindings)
      return (evidence.resolution === 'agree' || evidence.resolution === 'conditional')
        && provenances !== undefined
        && sourceFindings !== undefined
        ? Object.freeze({
            kind: 'multi_source', resolution: evidence.resolution,
            family: 'actionable', provenances,
            sourceFindings,
            origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
            c21: handoff.c21, c22: handoff.c22, boundary,
          })
        : undefined
    }
    return evidence.kind === 'multi'
      ? Object.freeze({
          kind: 'multi', family: 'actionable', provenances: evidence.provenances,
          origin: handoff.origin, c02: handoff.c02, c20: handoff.c20,
          c21: handoff.c21, c22: handoff.c22, boundary,
        })
      : Object.freeze({
          family: 'actionable', provenance: evidence.provenance, origin: handoff.origin,
          c02: handoff.c02, c20: handoff.c20, c21: handoff.c21, c22: handoff.c22,
          boundary,
        })
  }

  private completeGeneralBoundary(
    focus: FocusDecision,
    proposal: ActionBoundaryProposal,
  ): ActionFactBoundaryStateHandoff | undefined {
    this.#retryCandidateBoundary(focus, proposal)
    const capability = this.issueBoundedProposal(focus, proposal)
    if (capability === undefined) return undefined
    const accepted = this.consumeIssuedBoundary(capability)
    if (accepted === undefined) return undefined
    if (exactAcceptedBoundaryAdviceReport(accepted.c22, accepted.boundary)) {
      this.#deliverCandidateBoundary(focus, proposal, accepted.boundary)
    }
    return this.sendActionBoundaryToState(accepted)
  }

  private completeLocalRestriction(
    focus: FocusDecision,
    proposal: ActionBoundaryProposal,
  ): LocalRestrictionAcceptance | undefined {
    const handoff = this.completeGeneralBoundary(focus, proposal)
    return handoff === undefined ? undefined : this.acceptLocalRestriction(handoff)
  }

  acceptRestoredActionBoundary(value: RestoredActionBoundary): C36Result {
    if (restored.get(this)?.has(value) !== true) return rejected('C36', value.boundary.ref)
    restored.get(this)?.delete(value)
    const report: C36Result = { kind: 'business_result', identity: identity('C36', value.boundary.ref),
      value: { kind: 'accepted_for_contract', value } }
    acceptedRestoredReports.get(this)?.add(report)
    return report
  }
}

/** @internal Read-only exact-outer predicate; it never exposes or consumes the inner acceptance. */
export function isAuthenticCompletedEvidenceLocalRestriction(
  authority: ActionFactBoundaryAuthority,
  completion: CompletedEvidenceLocalRestrictionBoundary,
): boolean {
  return authenticEvidenceFixedFamilyCompletions.get(authority)?.has(completion) === true
}

/** @internal Read-only exact-outer predicate; it never exposes or consumes the inner handoff. */
export function isAuthenticCompletedEvidenceNoSafeAction(
  authority: ActionFactBoundaryAuthority,
  completion: CompletedEvidenceNoSafeActionBoundary,
): boolean {
  return authenticEvidenceFixedFamilyCompletions.get(authority)?.has(completion) === true
}

/**
 * State's one-use live bridge. Wrong owner/foreign structure does not consume
 * the genuine acceptance; the exact owner-issued object succeeds once.
 */
export function consumeAuthenticLocalRestrictionAcceptance(
  authority: ActionFactBoundaryAuthority,
  acceptance: LocalRestrictionAcceptance,
  session: Agent['session'],
  target: ChatRef,
  messageId: string,
  hash: string,
): boolean {
  const accepted = liveAcceptances.get(authority)
  const admission = localAdmissions.get(acceptance)
  if (accepted?.has(acceptance) !== true || admission === undefined
    || admission.session !== session || admission.target !== target
    || admission.messageId !== messageId || admission.hash !== hash) return false
  accepted.delete(acceptance)
  localAdmissions.delete(acceptance)
  return true
}

/**
 * No-safe state's one-use live bridge.  Every supplied identity must match
 * before either private registry is consumed, so a foreign, malformed or
 * replayed handoff cannot spend the genuine direct-input admission.
 */
export function consumeAuthenticNoSafeActionBoundaryStateHandoff(
  authority: ActionFactBoundaryAuthority,
  handoff: ActionFactBoundaryStateHandoff,
  session: Agent['session'],
  target: ChatRef,
  messageId: string,
  hash: string,
): boolean {
  const handoffs = stateHandoffs.get(authority)
  const admission = handoffAdmissions.get(handoff)
  if (handoffs?.has(handoff) !== true || handoff.boundary.kind !== 'no_safe_action'
    || admission === undefined || admission.owner !== authority
    || admission.session !== session || admission.target !== target
    || admission.messageId !== messageId || admission.hash !== hash) return false
  handoffs.delete(handoff)
  handoffAdmissions.delete(handoff)
  return true
}

/**
 * Internal state-to-owner bridge.  A live C20/C21 boundary is never enough:
 * state must prove the exact finalized C34 candidate and its owner token.
 */
export function issueAuthenticatedRestoredActionBoundary(
  authority: ActionFactBoundaryAuthority,
  token: object,
  c34: C34Result,
  boundary: ActionFactBoundary,
): RestoredActionBoundary | undefined {
  if (!isAuthenticActionFactBoundaryC36Bridge(authority, token, c34, boundary)) return undefined
  const { chat, ...preserved } = boundary
  const value: RestoredActionBoundary = Object.freeze({ target: chat, boundary: Object.freeze(preserved) })
  restored.get(authority)?.add(value)
  return value
}

/**
 * Implementation-only recovery association.  The state predicate binds the
 * exact owner/token/C34 quartet; this module additionally requires a C36
 * report issued by that owner and marks it once without exposing the token.
 */
export function claimAcceptedRestoredActionBoundaryReport(
  authority: ActionFactBoundaryAuthority,
  token: object,
  c34: C34Result,
  report: C36Result,
): boolean {
  const accepted = acceptedRestoredReports.get(authority)
  const claimed = claimedRestoredReports.get(authority)
  if (!isAuthenticActionFactBoundaryRecoveryClaim(authority, token, c34, report)
    || accepted?.has(report) !== true || claimed === undefined || claimed.has(report)) return false
  claimed.add(report)
  return true
}

/** C37 verifier for an already destructively claimed owner-issued C36. */
export function isClaimedRestoredActionBoundaryReport(
  authority: ActionFactBoundaryAuthority,
  report: C36Result,
): boolean {
  return claimedRestoredReports.get(authority)?.has(report) === true
}
