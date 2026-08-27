/** Live no-focus contract receivers plus their transaction-only composition. */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  FocusAuthority,
  claimAcceptedRestoredFocusReport,
  issueAuthenticatedRestoredFocusFact,
  isClaimedRestoredFocusReport,
  rehydrateFinalizedEstablishedFocusChain,
  rehydrateFinalizedNoFocusChain,
  rehydrateRecoveryFailureTarget,
  type Accepted,
  type C35Result,
  type ChatRef,
  type ContractCallRef,
  type ContractCode,
  type ContractIdentity,
  type ContractReport,
  type ContractScope,
  type CorrectionMeaning,
  type FocusDecision,
  type FocusDecisionRef,
  type NoUsableEstablishedFact,
} from './focus.ts'
export type {
  Accepted,
  ContractCallRef,
  ContractCode,
  ContractIdentity,
  ContractReport,
  ContractScope,
  NoUsableEstablishedFact,
  WithoutChat,
} from './focus.ts'
import {
  claimAcceptedRestoredActionBoundaryReport,
  consumeAuthenticLocalRestrictionAcceptance,
  consumeAuthenticNoSafeActionBoundaryStateHandoff,
  isClaimedRestoredActionBoundaryReport,
  issueAuthenticatedRestoredActionBoundary,
  type ActionFactBoundaryRef,
  type ActionFactBoundary,
  type ActionFactBoundaryAuthority,
  type ActionFactBoundaryStateHandoff,
  type C02Result as ActionBoundaryC02Result,
  type C22Result as ActionBoundaryC22Result,
  type C36Result as ActionBoundaryC36Result,
  type LocalRestrictionBoundary as ActionLocalRestrictionBoundary,
  type LocalRestrictionAcceptance,
  type NoSafeActionBoundary as ActionNoSafeActionBoundary,
  type PartialActionFactBoundary,
  type PreservedActionBoundary,
  type PreservedLocalRestrictionBoundary,
  type UsableFact,
  type UnresolvedFact,
} from './action-boundary.ts'
import {
  consumeAuthenticCandidateQualification,
  type CandidateEnvelope,
  type CandidateQualificationAuthority,
  type CandidateQualificationDecision,
  type CandidateRef,
  type C28Result,
} from './candidate-qualification.ts'
import { rollingCandidateGeneration } from './candidate.ts'

declare const stateBrand: unique symbol
type Brand<Name extends string> = string & { readonly [stateBrand]: Name }
export type PendingCanonicalStateRef = Brand<'PendingCanonicalStateRef'>
export type CanonicalStateRef = Brand<'CanonicalStateRef'>
export type CompleteStateMaterialRef = Brand<'CompleteStateMaterialRef'>
type RecoverableStateProofRef = Brand<'RecoverableStateProofRef'>
type UniqueVisibleStateProofRef = Brand<'UniqueVisibleStateProofRef'>
type SameSavedMaterialProofRef = Brand<'SameSavedMaterialProofRef'>
type CanonicalRestorationProofRef = Brand<'CanonicalRestorationProofRef'>
type PreservationAffectedScope = Brand<'PreservationAffectedScope'>
type VisibleContextAffectedScope = Brand<'VisibleContextAffectedScope'>
type StateMaterialAffectedScope = Brand<'StateMaterialAffectedScope'>
type Scope<Code extends ContractCode, Kind extends string> = ContractScope<Code, Kind>
export type NoFocusDecision = Extract<FocusDecision, { readonly kind: 'no_focus' }>
type EstablishedFocusDecision = Extract<FocusDecision, { readonly kind: 'focus_established' }>
export type CanonicalStateFamily = 'no_focus' | 'local_restriction' | 'no_safe_action' | 'background'

/** Live/canonical state contains the boundary fact, never a recovery C36. */
type PendingLocalRestrictionState<Boundary = LocalRestrictionBoundary> = {
  readonly kind: 'local_restriction'
  readonly ref: PendingCanonicalStateRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
}
type PendingNoSafeActionState<Boundary = NoSafeActionBoundary> = {
  readonly kind: 'no_safe_action'
  readonly ref: PendingCanonicalStateRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
}
type QualifiedCandidateDecision = Extract<CandidateQualificationDecision, { readonly kind: 'qualified' }>
type PendingBackgroundState<Boundary = ActionFactBoundary> = {
  readonly kind: 'background'
  readonly ref: PendingCanonicalStateRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
  readonly candidateRef: CandidateRef
  readonly qualification: C28Result
}
export type C06Result = ContractReport<'C06', FocusDecision['ref'], Accepted<FocusDecision>>
export type C07Result = ContractReport<'C07', FocusDecision['ref'], Accepted<FocusDecision>>
/**
 * Fixed-family C20/C21 carrier.  The action authority owns the meaning of the
 * boundary; this module only keeps its already-established identity together
 * with the one state family that may preserve it.
 */
export type LocalRestrictionBoundary = ActionLocalRestrictionBoundary
export type NoSafeActionBoundary = ActionNoSafeActionBoundary
export type PreservedNoSafeActionBoundary = Extract<PreservedActionBoundary, { readonly kind: 'no_safe_action' }>
export type C20Result = ContractReport<'C20', ActionFactBoundaryRef, Accepted<ActionFactBoundary>>
export type C21Result = ContractReport<
  'C21', ActionFactBoundaryRef, Accepted<ActionFactBoundary>, PartialActionFactBoundary
>

/** The default keeps every existing caller on the exact no-focus family. */
interface PendingNoFocusState {
  readonly kind: 'no_focus'
  readonly ref: PendingCanonicalStateRef
  readonly focus: NoFocusDecision
}
export type PendingCanonicalState<
  Family extends CanonicalStateFamily = 'no_focus',
  Boundary = LocalRestrictionBoundary,
> = Family extends 'no_focus' ? PendingNoFocusState
  : Family extends 'local_restriction' ? PendingLocalRestrictionState<Boundary>
    : Family extends 'no_safe_action' ? PendingNoSafeActionState<Boundary>
      : PendingBackgroundState<Boundary>
export type PreservationEligibility =
  | { readonly kind: 'eligible'; readonly state: PendingCanonicalStateRef }
  | { readonly kind: 'ineligible'; readonly state: PendingCanonicalStateRef; readonly missing: PreservationAffectedScope }
export type RecoverablePreservationResult =
  | { readonly kind: 'established'; readonly state: PendingCanonicalStateRef }
  | { readonly kind: 'same_complete_state_already_recoverable'; readonly state: PendingCanonicalStateRef; readonly proof: RecoverableStateProofRef }
export type VisibleReplacementResult =
  | { readonly kind: 'uniquely_replaced'; readonly state: PendingCanonicalStateRef }
  | { readonly kind: 'same_state_already_uniquely_visible'; readonly state: PendingCanonicalStateRef; readonly proof: UniqueVisibleStateProofRef }
export type OrdinarySaveResult =
  | { readonly kind: 'saved'; readonly material: CompleteStateMaterialRef }
  | { readonly kind: 'same_complete_material_already_saved'; readonly material: CompleteStateMaterialRef; readonly proof: SameSavedMaterialProofRef }
type CanonicalCurrentContextSubject = { readonly kind: 'canonical_state'; readonly state: CanonicalStateRef }
export interface CanonicalNoFocusState {
  readonly kind: 'no_focus'
  readonly ref: CanonicalStateRef
  readonly target: ChatRef
  readonly focus: Omit<NoFocusDecision, 'chat'>
}
export type CanonicalLocalRestrictionState<Boundary = PreservedLocalRestrictionBoundary> = {
  readonly kind: 'local_restriction'
  readonly ref: CanonicalStateRef
  readonly target: ChatRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
}
export type CanonicalNoSafeActionState<Boundary = PreservedNoSafeActionBoundary> = {
  readonly kind: 'no_safe_action'
  readonly ref: CanonicalStateRef
  readonly target: ChatRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
}
export type CanonicalBackgroundState<Boundary = PreservedActionBoundary> = {
  readonly kind: 'background'
  readonly ref: CanonicalStateRef
  readonly target: ChatRef
  readonly candidateRef: CandidateRef
  readonly focus: Omit<EstablishedFocusDecision, 'chat'>
  readonly boundary: Boundary
}
type PreservedNoFocusState = {
  readonly kind: 'no_focus'
  readonly ref: CanonicalStateRef
  readonly focus: Omit<NoFocusDecision, 'chat'>
}
type PreservedLocalRestrictionState<Boundary = PreservedLocalRestrictionBoundary> = Omit<
  CanonicalLocalRestrictionState<Boundary>, 'target'
>
type PreservedNoSafeActionState<Boundary = PreservedNoSafeActionBoundary> = Omit<
  CanonicalNoSafeActionState<Boundary>, 'target'
>
type PreservedBackgroundState<Boundary = PreservedActionBoundary> = Omit<
  CanonicalBackgroundState<Boundary>, 'target'
>
/** Existing public C32 surface remains the exact no-focus family. */
export type CurrentContextState = {
  readonly kind: 'canonical'
  readonly state: CanonicalNoFocusState
}
export type CurrentContextAccepted = { readonly kind: 'current_context_accepted'; readonly state: CurrentContextState }
export type LocalRestrictionCurrentContextState = {
  readonly kind: 'canonical'
  readonly state: CanonicalLocalRestrictionState
}
export type LocalRestrictionCurrentContextAccepted = {
  readonly kind: 'current_context_accepted'
  readonly state: LocalRestrictionCurrentContextState
}
export type NoSafeActionCurrentContextState = {
  readonly kind: 'canonical'
  readonly state: CanonicalNoSafeActionState
}
export type NoSafeActionCurrentContextAccepted = {
  readonly kind: 'current_context_accepted'
  readonly state: NoSafeActionCurrentContextState
}
export type BackgroundCurrentContextState = {
  readonly kind: 'canonical'
  readonly state: CanonicalBackgroundState
}
export type BackgroundCurrentContextAccepted = {
  readonly kind: 'current_context_accepted'
  readonly state: BackgroundCurrentContextState
}
type FixedCurrentContextState = CurrentContextState | LocalRestrictionCurrentContextState
  | NoSafeActionCurrentContextState | BackgroundCurrentContextState
export type C29Result = ContractReport<'C29', PendingCanonicalStateRef, PreservationEligibility>
export type C30Result = ContractReport<'C30', PendingCanonicalStateRef, RecoverablePreservationResult, { readonly state: PendingCanonicalStateRef; readonly establishedScope: PreservationAffectedScope }>
export type C31Result = ContractReport<'C31', PendingCanonicalStateRef, VisibleReplacementResult, { readonly state: PendingCanonicalStateRef; readonly changedScope: VisibleContextAffectedScope }>
/**
 * This is only the implemented C32 business-result branch. Its structure is
 * assignable to the shared C32Result business-result branch, but H1 never
 * claims the unimplemented partial, old-state, or no-safe-action branches.
 */
export type CurrentContextConsumerResult = {
  readonly kind: 'business_result'
  readonly identity: ContractIdentity<'C32', CanonicalCurrentContextSubject>
  readonly value: CurrentContextAccepted
}
export type LocalRestrictionCurrentContextConsumerResult = {
  readonly kind: 'business_result'
  readonly identity: ContractIdentity<'C32', CanonicalCurrentContextSubject>
  readonly value: LocalRestrictionCurrentContextAccepted
}
export type NoSafeActionCurrentContextConsumerResult = {
  readonly kind: 'business_result'
  readonly identity: ContractIdentity<'C32', CanonicalCurrentContextSubject>
  readonly value: NoSafeActionCurrentContextAccepted
}
export type BackgroundCurrentContextConsumerResult = {
  readonly kind: 'business_result'
  readonly identity: ContractIdentity<'C32', CanonicalCurrentContextSubject>
  readonly value: BackgroundCurrentContextAccepted
}
type FixedCurrentContextConsumerResult = CurrentContextConsumerResult | LocalRestrictionCurrentContextConsumerResult
  | NoSafeActionCurrentContextConsumerResult | BackgroundCurrentContextConsumerResult
export type C33Result = ContractReport<'C33', CompleteStateMaterialRef, OrdinarySaveResult, { readonly material: CompleteStateMaterialRef; readonly savedScope: StateMaterialAffectedScope }>

type RestorableCompleteStateMaterial = CompleteStateMaterial
  | CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
  | CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
  | CompleteStateMaterial<'background', PreservedActionBoundary>
type RestorablePendingCanonicalState = PendingCanonicalState
  | PendingCanonicalState<'local_restriction', LocalRestrictionBoundary>
  | PendingCanonicalState<'no_safe_action', NoSafeActionBoundary>
  | PendingCanonicalState<'background', ActionFactBoundary>
type NoFocusStoredStateReadout =
  | { readonly kind: 'existing_material'; readonly material: CompleteStateMaterial }
  | { readonly kind: 'expected_material_missing'; readonly target: ChatRef; readonly missing: StateMaterialAffectedScope }
  | { readonly kind: 'readout_unknown'; readonly target: ChatRef; readonly uncertain: StateMaterialAffectedScope }
  | { readonly kind: 'partial_material'; readonly value: { readonly target: ChatRef; readonly fragments: readonly [unknown, ...unknown[]]; readonly readScope: StateMaterialAffectedScope } }
type LocalRestrictionStoredStateReadout<ActionBoundaryReport = PreservedLocalRestrictionBoundary> =
  | { readonly kind: 'existing_material'; readonly material: CompleteStateMaterial<'local_restriction', ActionBoundaryReport> }
  | { readonly kind: 'expected_material_missing'; readonly target: ChatRef; readonly missing: StateMaterialAffectedScope }
  | { readonly kind: 'readout_unknown'; readonly target: ChatRef; readonly uncertain: StateMaterialAffectedScope }
type NoSafeActionStoredStateReadout<ActionBoundaryReport = PreservedNoSafeActionBoundary> =
  | { readonly kind: 'existing_material'; readonly material: CompleteStateMaterial<'no_safe_action', ActionBoundaryReport> }
  | { readonly kind: 'expected_material_missing'; readonly target: ChatRef; readonly missing: StateMaterialAffectedScope }
  | { readonly kind: 'readout_unknown'; readonly target: ChatRef; readonly uncertain: StateMaterialAffectedScope }
type BackgroundStoredStateReadout<ActionBoundaryReport = PreservedActionBoundary> =
  | { readonly kind: 'existing_material'; readonly material: CompleteStateMaterial<'background', ActionBoundaryReport> }
  | { readonly kind: 'expected_material_missing'; readonly target: ChatRef; readonly missing: StateMaterialAffectedScope }
  | { readonly kind: 'readout_unknown'; readonly target: ChatRef; readonly uncertain: StateMaterialAffectedScope }
export type StoredStateReadout<
  Family extends CanonicalStateFamily = 'no_focus',
  ActionBoundaryReport = PreservedLocalRestrictionBoundary,
> = Family extends 'no_focus' ? NoFocusStoredStateReadout
  : Family extends 'local_restriction' ? LocalRestrictionStoredStateReadout<ActionBoundaryReport>
    : Family extends 'no_safe_action' ? NoSafeActionStoredStateReadout<ActionBoundaryReport>
      : BackgroundStoredStateReadout<ActionBoundaryReport>
export type SuccessfulStoredStateReadout = Extract<StoredStateReadout, { readonly kind: 'existing_material' }>
type NoFocusC34Result = ContractReport<'C34', StoredStateReadout, Accepted<SuccessfulStoredStateReadout>, { readonly target: ChatRef; readonly fragments: readonly [unknown, ...unknown[]]; readonly readScope: StateMaterialAffectedScope }>

/** Stage 2's only type-level C34 entry for the fixed local family. */
export type LocalRestrictionC34Result<ActionBoundaryReport = PreservedLocalRestrictionBoundary> = ContractReport<
  'C34',
  StoredStateReadout<'local_restriction', ActionBoundaryReport>,
  Accepted<Extract<StoredStateReadout<'local_restriction', ActionBoundaryReport>, { readonly kind: 'existing_material' }>>,
  { readonly target: ChatRef; readonly fragments: readonly [unknown, ...unknown[]]; readonly readScope: StateMaterialAffectedScope }
>
export type NoSafeActionC34Result<ActionBoundaryReport = PreservedNoSafeActionBoundary> = ContractReport<
  'C34',
  StoredStateReadout<'no_safe_action', ActionBoundaryReport>,
  Accepted<Extract<StoredStateReadout<'no_safe_action', ActionBoundaryReport>, { readonly kind: 'existing_material' }>>,
  { readonly target: ChatRef; readonly fragments: readonly [unknown, ...unknown[]]; readonly readScope: StateMaterialAffectedScope }
>
export type BackgroundC34Result<ActionBoundaryReport = PreservedActionBoundary> = ContractReport<
  'C34',
  StoredStateReadout<'background', ActionBoundaryReport>,
  Accepted<Extract<StoredStateReadout<'background', ActionBoundaryReport>, { readonly kind: 'existing_material' }>>,
  { readonly target: ChatRef; readonly fragments: readonly [unknown, ...unknown[]]; readonly readScope: StateMaterialAffectedScope }
>
export type C34Result = NoFocusC34Result
  | LocalRestrictionC34Result<PreservedLocalRestrictionBoundary>
  | NoSafeActionC34Result<PreservedNoSafeActionBoundary>
  | BackgroundC34Result<PreservedActionBoundary>

interface NoFocusCanonicalRestoration {
  readonly kind: 'no_focus_restored'
  readonly material: CompleteStateMaterial
  readonly restorationProof: CanonicalRestorationProofRef
  readonly recoverableProof: RecoverableStateProofRef
  readonly visibleProof: UniqueVisibleStateProofRef
}
interface LocalRestrictionCanonicalRestoration {
  readonly kind: 'local_restriction_restored'
  readonly material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
  readonly restorationProof: CanonicalRestorationProofRef
  readonly recoverableProof: RecoverableStateProofRef
  readonly visibleProof: UniqueVisibleStateProofRef
}
interface NoSafeActionCanonicalRestoration {
  readonly kind: 'no_safe_action_restored'
  readonly material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
  readonly restorationProof: CanonicalRestorationProofRef
  readonly recoverableProof: RecoverableStateProofRef
  readonly visibleProof: UniqueVisibleStateProofRef
}
interface BackgroundCanonicalRestoration {
  readonly kind: 'background_restored'
  readonly material: CompleteStateMaterial<'background', PreservedActionBoundary>
  readonly restorationProof: CanonicalRestorationProofRef
  readonly recoverableProof: RecoverableStateProofRef
  readonly visibleProof: UniqueVisibleStateProofRef
}
export type CanonicalRestoration = NoFocusCanonicalRestoration | LocalRestrictionCanonicalRestoration
  | NoSafeActionCanonicalRestoration | BackgroundCanonicalRestoration
export type C37Result = ContractReport<'C37', ChatRef, Accepted<CanonicalRestoration>>

type LocalRestrictionRecoveryAttempt = {
  readonly family: 'local_restriction'
  readonly c34: LocalRestrictionC34Result<PreservedLocalRestrictionBoundary>
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c30: C30Result
  readonly c31: C31Result
  readonly material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
}
type NoSafeActionRecoveryAttempt = {
  readonly family: 'no_safe_action'
  readonly c34: NoSafeActionC34Result<PreservedNoSafeActionBoundary>
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c30: C30Result
  readonly c31: C31Result
  readonly material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
}
type BackgroundRecoveryAttempt = {
  readonly family: 'background'
  readonly c34: BackgroundC34Result<PreservedActionBoundary>
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c30: C30Result
  readonly c31: C31Result
  readonly material: CompleteStateMaterial<'background', PreservedActionBoundary>
}
type LocalRestrictionRestorationAssociation = LocalRestrictionRecoveryAttempt & {
    readonly c37Owner: CanonicalContextAuthority
    readonly focusAuthority: FocusAuthority
    readonly actionOwner: ActionFactBoundaryAuthority
    readonly phase: 'finalized_retained'
    readonly claim: RecoveryClaim
}
type NoSafeActionRestorationAssociation = NoSafeActionRecoveryAttempt & {
  readonly c37Owner: CanonicalContextAuthority
  readonly focusAuthority: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly phase: 'finalized_retained'
  readonly claim: RecoveryClaim
}
type BackgroundRestorationAssociation = BackgroundRecoveryAttempt & {
  readonly c37Owner: CanonicalContextAuthority
  readonly focusAuthority: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly phase: 'finalized_retained'
  readonly claim: RecoveryClaim
}
type FamilyRestorationAssociation = RestorationAssociation | LocalRestrictionRestorationAssociation
  | NoSafeActionRestorationAssociation | BackgroundRestorationAssociation

interface CompleteNoFocusStateMaterial {
  readonly kind: 'no_focus_material'
  readonly ref: CompleteStateMaterialRef
  readonly target: ChatRef
  /** This preserved projection deliberately has no runtime `target` field. */
  readonly canonicalState: PreservedNoFocusState
}
type CompleteLocalRestrictionStateMaterial<Boundary = PreservedLocalRestrictionBoundary> = {
  readonly kind: 'local_restriction_material'
  readonly ref: CompleteStateMaterialRef
  readonly target: ChatRef
  readonly canonicalState: PreservedLocalRestrictionState<Boundary>
}
type CompleteNoSafeActionStateMaterial<Boundary = PreservedNoSafeActionBoundary> = {
  readonly kind: 'no_safe_action_material'
  readonly ref: CompleteStateMaterialRef
  readonly target: ChatRef
  readonly canonicalState: PreservedNoSafeActionState<Boundary>
}
type CompleteBackgroundStateMaterial<Boundary = PreservedActionBoundary> = {
  readonly kind: 'background_material'
  readonly ref: CompleteStateMaterialRef
  readonly target: ChatRef
  readonly canonicalState: PreservedBackgroundState<Boundary>
}
export type CompleteStateMaterial<
  Family extends CanonicalStateFamily = 'no_focus',
  Boundary = PreservedLocalRestrictionBoundary,
> = Family extends 'no_focus'
  ? CompleteNoFocusStateMaterial
  : Family extends 'local_restriction'
    ? CompleteLocalRestrictionStateMaterial<Boundary>
    : Family extends 'no_safe_action'
      ? CompleteNoSafeActionStateMaterial<Boundary>
      : CompleteBackgroundStateMaterial<Boundary>

/** Private connection material; none of these fields expands PendingCanonicalState. */
export interface PrivatePendingNoFocus {
  readonly state: PendingCanonicalState
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly c06: C06Result
  readonly c07: C07Result
  readonly material: CompleteStateMaterial
}
export interface PrivatePendingLocalRestriction {
  readonly state: PendingCanonicalState<'local_restriction', LocalRestrictionBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly acceptance: LocalRestrictionAcceptance
  readonly c06: C06Result
  readonly c02: ActionBoundaryC02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: ActionBoundaryC22Result
  readonly material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
}
export interface PrivatePendingNoSafeAction {
  readonly state: PendingCanonicalState<'no_safe_action', NoSafeActionBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly handoff: ActionFactBoundaryStateHandoff
  readonly c06: C06Result
  readonly c02: ActionBoundaryC02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: ActionBoundaryC22Result
  readonly material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
}
export interface PrivatePendingBackground {
  readonly state: PendingCanonicalState<'background', ActionFactBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly decision: QualifiedCandidateDecision
  readonly c28: C28Result
  readonly c06: C06Result
  readonly c20: C20Result
  readonly material: CompleteStateMaterial<'background', PreservedActionBoundary>
}
export interface CanonicalNoFocusMachineProjection {
  readonly kind: 'no_focus'
  readonly focusRef: FocusDecisionRef
  readonly chat: ChatRef
  readonly latestCorrections: CorrectionMeaning
  readonly closeMessageId: string
  readonly closeHash: string
}

interface CanonicalLocalRestrictionMessageSource {
  readonly kind: 'context-manager-local-restriction'
  readonly phase: 'current' | 'finalized'
  readonly pendingStateRef: PendingCanonicalStateRef
  readonly canonicalStateRef: CanonicalStateRef
  readonly generation: number
  readonly chat: ChatRef
  readonly bodyHash: string
  readonly machine: {
    readonly kind: 'local_restriction'
    readonly focusRef: FocusDecisionRef
    readonly currentMatter: string
    readonly latestCorrections: CorrectionMeaning
    readonly boundaryRef: string
    readonly requiredFacts: LocalRestrictionBoundary['requiredFacts']
    readonly usableFacts: readonly UsableFact[]
    readonly unresolvedFacts: readonly UnresolvedFact[]
    readonly preciselyBlockedActions: readonly string[]
    readonly safelyContinuableActions: readonly string[]
    readonly originMessageId: string
    readonly originHash: string
  }
}
interface CanonicalNoSafeActionMessageSource {
  readonly kind: 'context-manager-no-safe-action'
  readonly phase: 'current' | 'finalized'
  readonly pendingStateRef: PendingCanonicalStateRef
  readonly canonicalStateRef: CanonicalStateRef
  readonly generation: number
  readonly chat: ChatRef
  readonly bodyHash: string
  readonly machine: {
    readonly kind: 'no_safe_action'
    readonly focusRef: FocusDecisionRef
    readonly currentMatter: string
    readonly latestCorrections: CorrectionMeaning
    readonly boundaryRef: string
    readonly requiredFacts: NoSafeActionBoundary['requiredFacts']
    readonly usableFacts: readonly UsableFact[]
    readonly unresolvedFacts: readonly UnresolvedFact[]
    readonly preciselyBlockedActions: readonly string[]
    readonly safelyContinuableActions: readonly []
    readonly originMessageId: string
    readonly originHash: string
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-manager-local-restriction': CanonicalLocalRestrictionMessageSource
    'context-manager-no-safe-action': CanonicalNoSafeActionMessageSource
  }
}
export interface CanonicalNoFocusTransaction {
  readonly phase: 'pending' | 'current' | 'finalized'
  readonly pendingRef: PendingCanonicalStateRef
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly machine: CanonicalNoFocusMachineProjection
  readonly body: string
  readonly bodyHash: string
  /** The exact C33 input, retained in the sidecar transaction snapshot. */
  readonly material: CompleteStateMaterial
  readonly c06: C06Result
  readonly c07: C07Result
  readonly c29: C29Result
  /** Absent only while the pending sidecar has not yet completed C33/C30. */
  readonly c33?: C33Result
  readonly c30?: C30Result
  readonly firstC31?: C31Result
  readonly firstC32?: CurrentContextConsumerResult
  readonly finalizedC31?: C31Result
  readonly finalizedC32?: CurrentContextConsumerResult
  readonly firstReplaceSeq?: number
  readonly finalizedReplaceSeq?: number
  /**
   * H1R-F's technical same-generation repair marker.  It is deliberately not
   * a Cnn result: the marker only makes an otherwise irreversible full-surface
   * replacement resumable without guessing a new message identity.
   */
  readonly repair?:
    | { readonly phase: 'repair_pending'; readonly targetMessageId: string }
    | { readonly phase: 'repair_finalized'; readonly targetMessageId: string; readonly targetReplaceSeq: number }
}

export interface CanonicalLocalRestrictionTransaction {
  readonly family: 'local_restriction'
  readonly phase: 'pending' | 'current' | 'finalized'
  readonly pendingRef: PendingCanonicalStateRef
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly machine: {
    readonly kind: 'local_restriction'
    readonly focusRef: FocusDecisionRef
    readonly currentMatter: string
    readonly latestCorrections: CorrectionMeaning
    readonly boundaryRef: string
    readonly requiredFacts: LocalRestrictionBoundary['requiredFacts']
    readonly usableFacts: readonly UsableFact[]
    readonly unresolvedFacts: readonly UnresolvedFact[]
    readonly preciselyBlockedActions: readonly string[]
    readonly safelyContinuableActions: readonly string[]
    readonly originMessageId: string
    readonly originHash: string
  }
  readonly body: string
  readonly bodyHash: string
  readonly material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
  readonly c06: C06Result
  readonly c02: ActionBoundaryC02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: ActionBoundaryC22Result
  readonly c29: C29Result
  readonly c33?: C33Result
  readonly c30?: C30Result
  readonly firstC31?: C31Result
  readonly firstC32?: LocalRestrictionCurrentContextConsumerResult
  readonly finalizedC31?: C31Result
  readonly finalizedC32?: LocalRestrictionCurrentContextConsumerResult
  readonly firstReplaceSeq?: number
  readonly finalizedReplaceSeq?: number
  /** Same-generation technical repair only; it is not a Cnn report or a new transaction. */
  readonly repair?:
    | { readonly phase: 'repair_pending'; readonly targetMessageId: string }
    | { readonly phase: 'repair_finalized'; readonly targetMessageId: string; readonly targetReplaceSeq: number }
}

export interface CanonicalNoSafeActionTransaction {
  readonly family: 'no_safe_action'
  readonly phase: 'pending' | 'current' | 'finalized'
  readonly pendingRef: PendingCanonicalStateRef
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly machine: {
    readonly kind: 'no_safe_action'
    readonly focusRef: FocusDecisionRef
    readonly currentMatter: string
    readonly latestCorrections: CorrectionMeaning
    readonly boundaryRef: string
    readonly requiredFacts: NoSafeActionBoundary['requiredFacts']
    readonly usableFacts: readonly UsableFact[]
    readonly unresolvedFacts: readonly UnresolvedFact[]
    readonly preciselyBlockedActions: readonly string[]
    readonly safelyContinuableActions: readonly []
    readonly originMessageId: string
    readonly originHash: string
  }
  readonly body: string
  readonly bodyHash: string
  readonly material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
  readonly c06: C06Result
  readonly c02: ActionBoundaryC02Result
  readonly c20: C20Result
  readonly c21: C21Result
  readonly c22: ActionBoundaryC22Result
  readonly c29: C29Result
  readonly c33?: C33Result
  readonly c30?: C30Result
  readonly firstC31?: C31Result
  readonly firstC32?: NoSafeActionCurrentContextConsumerResult
  readonly finalizedC31?: C31Result
  readonly finalizedC32?: NoSafeActionCurrentContextConsumerResult
  readonly firstReplaceSeq?: number
  readonly finalizedReplaceSeq?: number
  readonly repair?:
    | { readonly phase: 'repair_pending'; readonly targetMessageId: string }
    | { readonly phase: 'repair_finalized'; readonly targetMessageId: string; readonly targetReplaceSeq: number }
}
export interface CanonicalBackgroundTransaction {
  readonly family: 'background'
  readonly phase: 'pending' | 'current' | 'finalized'
  readonly pendingRef: PendingCanonicalStateRef
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
  readonly machine: {
    readonly kind: 'background'
    readonly candidateRef: CandidateRef
    readonly focusRef: FocusDecisionRef
    readonly currentMatter: string
    readonly latestCorrections: CorrectionMeaning
    readonly boundaryRef: ActionFactBoundaryRef
    readonly evidenceRef: string
    readonly originMessageId: string
    readonly originHash: string
  }
  readonly body: string
  readonly bodyHash: string
  readonly material: CompleteStateMaterial<'background', PreservedActionBoundary>
  readonly c28: C28Result
  readonly c06: C06Result
  readonly c20: C20Result
  readonly c29: C29Result
  readonly c33?: C33Result
  readonly c30?: C30Result
  readonly firstC31?: C31Result
  readonly firstC32?: BackgroundCurrentContextConsumerResult
  readonly finalizedC31?: C31Result
  readonly finalizedC32?: BackgroundCurrentContextConsumerResult
  readonly firstReplaceSeq?: number
  readonly finalizedReplaceSeq?: number
  readonly repair?:
    | { readonly phase: 'repair_pending'; readonly targetMessageId: string }
    | { readonly phase: 'repair_finalized'; readonly targetMessageId: string; readonly targetReplaceSeq: number }
}

export interface LocalRestrictionStateRecord {
  readonly family: 'local_restriction'
  readonly transaction?: CanonicalLocalRestrictionTransaction
}
export interface NoSafeActionStateRecord {
  readonly family: 'no_safe_action'
  readonly transaction?: CanonicalNoSafeActionTransaction
}
export interface BackgroundStateRecord {
  readonly family: 'background'
  readonly transaction?: CanonicalBackgroundTransaction
}

export interface CanonicalLocalRestrictionMaterial {
  readonly family: 'local_restriction'
  readonly body: string
  readonly bodyHash: string
  readonly origin: { readonly messageId: string; readonly hash: string }
}
export interface CanonicalNoSafeActionMaterial {
  readonly family: 'no_safe_action'
  readonly body: string
  readonly bodyHash: string
  readonly origin: { readonly messageId: string; readonly hash: string }
}
export interface CanonicalBackgroundMaterial {
  readonly body: string
  readonly bodyHash: string
  readonly origin: { readonly messageId: string; readonly hash: string }
  readonly create: (pending: PrivatePendingBackground, phase: 'current' | 'finalized') => UserMessage
}

export interface CanonicalLocalRestrictionTransactionInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: LocalRestrictionStateRecord
  readonly focus: EstablishedFocusDecision
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly acceptance: LocalRestrictionAcceptance
  readonly save: (record: LocalRestrictionStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  readonly material: CanonicalLocalRestrictionMaterial
}
export interface CanonicalNoSafeActionTransactionInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: NoSafeActionStateRecord
  readonly focus: EstablishedFocusDecision
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly handoff: ActionFactBoundaryStateHandoff
  readonly save: (record: NoSafeActionStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  readonly material: CanonicalNoSafeActionMaterial
}
export interface CanonicalBackgroundTransactionInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: BackgroundStateRecord
  readonly qualificationOwner: CandidateQualificationAuthority
  readonly decision: QualifiedCandidateDecision
  readonly c28: C28Result
  readonly focus: EstablishedFocusDecision
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly boundary: ActionFactBoundary
  readonly save: (record: BackgroundStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  readonly material: CanonicalBackgroundMaterial
}

export interface FinalizedCanonicalLocalRestriction {
  readonly current: LocalRestrictionCurrentContextConsumerResult
  readonly finalizedSeq: number
  readonly record: CanonicalLocalRestrictionTransaction
}

export interface LocalRestrictionLivePort {
  commit(input: CanonicalLocalRestrictionTransactionInput): Promise<FinalizedCanonicalLocalRestriction>
}
export interface LocalRestrictionRepairInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: unknown
  readonly save: (record: LocalRestrictionStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
}
export interface LocalRestrictionRepairPort {
  repair(input: LocalRestrictionRepairInput): Promise<LocalRestrictionStateRecord | undefined>
}
export interface FinalizedCanonicalNoSafeAction {
  readonly current: NoSafeActionCurrentContextConsumerResult
  readonly finalizedSeq: number
  readonly record: CanonicalNoSafeActionTransaction
}
export interface NoSafeActionLivePort {
  commit(input: CanonicalNoSafeActionTransactionInput): Promise<FinalizedCanonicalNoSafeAction>
}
export interface NoSafeActionRepairInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: unknown
  readonly save: (record: NoSafeActionStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
}
export interface NoSafeActionRepairPort {
  repair(input: NoSafeActionRepairInput): Promise<NoSafeActionStateRecord | undefined>
}
export interface FinalizedCanonicalBackground {
  readonly current: BackgroundCurrentContextConsumerResult
  readonly finalizedSeq: number
  readonly record: CanonicalBackgroundTransaction
}
export interface BackgroundLivePort {
  commit(input: CanonicalBackgroundTransactionInput): Promise<FinalizedCanonicalBackground>
}
export interface BackgroundRepairInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: unknown
  readonly save: (record: BackgroundStateRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  readonly create: CanonicalBackgroundMaterial['create']
}
export interface BackgroundRepairPort {
  repair(input: BackgroundRepairInput): Promise<BackgroundStateRecord | undefined>
}
export interface FinalizedBackgroundRecoveryResult {
  readonly c34: C34Result
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c37: C37Result
}
export interface FinalizedBackgroundRecoveryPort {
  restore(stored: StoredNoFocusRecoveryEvidence): FinalizedBackgroundRecoveryResult | undefined
}
/** Only a runtime-validated sidecar row may cross this carrier boundary. */
export interface NoFocusTransactionCarrier { readonly transaction?: CanonicalNoFocusTransaction }

export interface CanonicalNoFocusMaterial {
  readonly body: string
  readonly bodyHash: string
  readonly create: (pending: PrivatePendingNoFocus, phase: 'current' | 'finalized') => UserMessage
}
export interface CanonicalStateTransactionInput<Record extends NoFocusTransactionCarrier> {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: Record
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly focus: NoFocusDecision
  readonly save: (record: Record) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  readonly material: CanonicalNoFocusMaterial
}
export interface FinalizedCanonicalNoFocus { readonly current: CurrentContextConsumerResult; readonly finalizedSeq: number }

/**
 * H1R-P's cold-only input.  `record` deliberately remains raw until the
 * state module has checked every durable identity link against both the live
 * and freshly detached Session views.
 */
export interface PendingNoFocusReplayInput {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: unknown
  /** Index owns the schema admission for every rewritten raw sidecar row. */
  readonly save: (record: unknown) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
}
export interface PendingNoFocusReplayPort {
  replay(input: PendingNoFocusReplayInput): Promise<boolean>
}

/** Raw durable input. Only EffectiveStatePreservation may decode it for C34. */
export interface StoredNoFocusRecoveryEvidence {
  readonly session: Agent['session']
  readonly record: unknown
}

function call<Code extends ContractCode, Subject>(code: Code, subject: Subject): ContractIdentity<Code, Subject> {
  return { contract: code, call: `${code}:${crypto.randomUUID()}` as ContractCallRef, subject }
}
function result<Code extends ContractCode, Subject, Value, Partial = NoUsableEstablishedFact<Code>>(
  code: Code, subject: Subject, value: Value,
): ContractReport<Code, Subject, Value, Partial> {
  return { kind: 'business_result', identity: call(code, subject), value }
}
function value<Code extends ContractCode, Subject, Business, Partial>(report: ContractReport<Code, Subject, Business, Partial>): Business | undefined {
  return report.kind === 'business_result' ? report.value : undefined
}
function rejected<Code extends ContractCode, Subject>(code: Code, subject: Subject): Extract<ContractReport<Code, Subject, unknown>, { readonly kind: 'rejected' }> {
  return { kind: 'rejected', identity: call(code, subject), reason: { kind: 'known_business_precondition_not_met', detail: `${code}:rejection` as Scope<Code, 'rejection'> } }
}

const expectedActionBoundaryOwners = new WeakMap<object, ActionFactBoundaryAuthority>()

/** @internal Same-plugin composition hook; it is called by the sole action owner before any C34 raw read. */
export function bindExpectedActionBoundaryOwner(
  preservation: object,
  owner: ActionFactBoundaryAuthority,
): void {
  const existing = expectedActionBoundaryOwners.get(preservation)
  if (existing !== undefined && existing !== owner) throw new Error('state preservation already has a different action-boundary owner')
  expectedActionBoundaryOwners.set(preservation, owner)
}

/** Owns C06/C29/C30; it never declares a state current. */
export class EffectiveStatePreservation {
  /** Both recovery owners are fixed at construction, before any raw evidence read. */
  constructor(
    private readonly expectedRecoveryOwner?: FocusAuthority,
    expectedActionBoundaryOwner?: ActionFactBoundaryAuthority,
  ) {
    if (expectedActionBoundaryOwner !== undefined) bindExpectedActionBoundaryOwner(this, expectedActionBoundaryOwner)
  }
  hasExpectedRecoveryOwner(authority: FocusAuthority): boolean {
    return this.expectedRecoveryOwner === authority
  }
  hasExpectedActionBoundaryOwner(authority: ActionFactBoundaryAuthority): boolean {
    return expectedActionBoundaryOwners.get(this) === authority
  }
  acceptFocusFactToPreserve(focus: FocusDecision): C06Result {
    if (focus.kind !== 'no_focus' && focus.kind !== 'focus_established') return rejected('C06', focus.ref)
    return result('C06', focus.ref, { kind: 'accepted_for_contract', value: focus })
  }
  /** C20 receives an already established fixed-family boundary, never a proposal. */
  acceptActionBoundaryToPreserve(boundary: ActionFactBoundary): C20Result {
    if (!completeActionFactBoundary(boundary)) return rejected('C20', boundary.ref)
    const report: C20Result = result('C20', boundary.ref, { kind: 'accepted_for_contract' as const, value: boundary })
    const reports = acceptedC20Boundaries.get(this) ?? new WeakMap<C20Result, ActionFactBoundary>()
    reports.set(report, boundary)
    acceptedC20Boundaries.set(this, reports)
    return report
  }
  checkPreservationEligibility(state: RestorablePendingCanonicalState): C29Result {
    const binding = preservationBindings.get(this)?.get(state.ref)
    if (!bindingMatchesPending(binding, state)) return rejected('C29', state.ref)
    return result('C29', state.ref, { kind: 'eligible', state: state.ref })
  }
  async establishRecoverablePreservation(state: RestorablePendingCanonicalState): Promise<C30Result> {
    const binding = preservationBindings.get(this)?.get(state.ref)
    if (!bindingMatchesPending(binding, state)) return rejected('C30', state.ref)
    const saved = await binding.saveComplete(state)
    const save = value(saved)
    const expected = binding.expectedMaterialRef
    if (save === undefined
      || saved?.identity.subject !== expected || save.material !== expected) return rejected('C30', state.ref)
    return {
      kind: 'business_result', identity: call('C30', state.ref),
      value: { kind: 'established', state: state.ref },
    }
  }

  /** Fresh retained C30 over this instance's exact finalized C34 candidate/material binding. */
  establishRetainedRecoverablePreservation(c34: C34Result): C30Result | undefined {
    const candidate = storedRecoveryCandidates.get(this)?.get(c34)
    if (candidate === undefined || !exactFinalizedC34Candidate(c34, candidate)) return undefined
    const familyReports = candidate.family === 'no_focus'
      ? candidate.storedC06 !== undefined && candidate.storedC07 !== undefined
      : candidate.family === 'background'
        ? candidate.storedC28 !== undefined && candidate.storedC06 !== undefined && candidate.storedC20 !== undefined
      : candidate.storedC06 !== undefined && candidate.storedC02 !== undefined
        && candidate.storedC20 !== undefined && candidate.storedC21 !== undefined && candidate.storedC22 !== undefined
    if (!familyReports || candidate.storedC29 === undefined) return undefined
    return { kind: 'business_result', identity: call('C30', candidate.state.ref),
      value: { kind: 'same_complete_state_already_recoverable', state: candidate.state.ref,
        proof: `recoverable:${crypto.randomUUID()}` as RecoverableStateProofRef } }
  }

  /** C34 receiver: it accepts only a fully decoded stored-state readout. */
  acceptStoredStateReadout(
    readout: Extract<StoredStateReadout, { readonly kind: 'existing_material' }>,
  ): NoFocusC34Result
  acceptStoredStateReadout(
    readout: Extract<StoredStateReadout<'local_restriction', PreservedLocalRestrictionBoundary>, { readonly kind: 'existing_material' }>,
  ): LocalRestrictionC34Result<PreservedLocalRestrictionBoundary>
  acceptStoredStateReadout(
    readout: Extract<StoredStateReadout<'no_safe_action', PreservedNoSafeActionBoundary>, { readonly kind: 'existing_material' }>,
  ): NoSafeActionC34Result<PreservedNoSafeActionBoundary>
  acceptStoredStateReadout(
    readout: Extract<StoredStateReadout<'background', PreservedActionBoundary>, { readonly kind: 'existing_material' }>,
  ): BackgroundC34Result<PreservedActionBoundary>
  acceptStoredStateReadout(
    readout: StoredStateReadout | StoredStateReadout<'local_restriction', PreservedLocalRestrictionBoundary>
      | StoredStateReadout<'no_safe_action', PreservedNoSafeActionBoundary>
      | StoredStateReadout<'background', PreservedActionBoundary>,
  ): C34Result
  acceptStoredStateReadout(
    readout: StoredStateReadout | StoredStateReadout<'local_restriction', PreservedLocalRestrictionBoundary>
      | StoredStateReadout<'no_safe_action', PreservedNoSafeActionBoundary>
      | StoredStateReadout<'background', PreservedActionBoundary>,
  ): C34Result {
    if (readout.kind === 'existing_material') {
      if (readout.material.kind === 'no_focus_material') {
        const noFocusReadout: Extract<StoredStateReadout, { readonly kind: 'existing_material' }> = {
          kind: 'existing_material', material: readout.material,
        }
        if (!isCompleteNoFocusMaterial(noFocusReadout.material)) return rejected('C34', noFocusReadout)
        return {
          kind: 'business_result',
          identity: call('C34', noFocusReadout),
          value: { kind: 'accepted_for_contract', value: noFocusReadout },
        }
      }
      if (readout.material.kind === 'local_restriction_material') {
        const localReadout: Extract<StoredStateReadout<'local_restriction', PreservedLocalRestrictionBoundary>, { readonly kind: 'existing_material' }> = {
          kind: 'existing_material', material: readout.material,
        }
        if (!isCompleteLocalRestrictionMaterial(localReadout.material)) return rejected('C34', localReadout)
        return {
          kind: 'business_result',
          identity: call('C34', localReadout),
          value: { kind: 'accepted_for_contract', value: localReadout },
        }
      }
      if (readout.material.kind === 'background_material') {
        const backgroundReadout: Extract<StoredStateReadout<'background', PreservedActionBoundary>, { readonly kind: 'existing_material' }> = {
          kind: 'existing_material', material: readout.material,
        }
        if (!isCompleteBackgroundMaterial(backgroundReadout.material)) return rejected('C34', backgroundReadout)
        return {
          kind: 'business_result',
          identity: call('C34', backgroundReadout),
          value: { kind: 'accepted_for_contract', value: backgroundReadout },
        }
      }
      const noSafeReadout: Extract<StoredStateReadout<'no_safe_action', PreservedNoSafeActionBoundary>, { readonly kind: 'existing_material' }> = {
        kind: 'existing_material', material: readout.material,
      }
      if (!isCompleteNoSafeActionMaterial(noSafeReadout.material)) return rejected('C34', noSafeReadout)
      return {
        kind: 'business_result',
        identity: call('C34', noSafeReadout),
        value: { kind: 'accepted_for_contract', value: noSafeReadout },
      }
    }
    const noFocusReadout: NoFocusStoredStateReadout = readout
    return rejected('C34', noFocusReadout)
  }

  /**
   * The C34 receiver's durable reader. It is intentionally the only entry
   * that accepts raw sidecar data: callers cannot rebrand a Zod/plain object
   * into a restored fact.
   */
  readStoredNoFocusEvidence(evidence: StoredNoFocusRecoveryEvidence): C34Result {
    const owner = this.expectedRecoveryOwner
    const decoded = owner === undefined ? undefined : decodeStoredNoFocusMaterial(evidence, this, owner)
    if (decoded === undefined) {
      const target = recoveryFailureTarget(evidence.session, this, owner)
      const expectedMissing = evidence.record === undefined && hasExpectedNoFocusWithoutMaterial(evidence.session)
      if (expectedMissing) {
        return rejected('C34', {
          kind: 'expected_material_missing', target,
          missing: 'C34:missing_material' as StateMaterialAffectedScope,
        })
      }
      if (hasNoFocusFragments(evidence.record)) {
        return {
          kind: 'partial', identity: call('C34', {
            kind: 'partial_material', value: {
              target, fragments: [evidence.record], readScope: 'C34:partial_material' as StateMaterialAffectedScope,
            },
          }),
          established: {
            target, fragments: [evidence.record], readScope: 'C34:partial_material' as StateMaterialAffectedScope,
          },
          notEstablished: 'C34:partial_missing_scope' as Scope<'C34', 'partial_missing_scope'>,
        }
      }
      return {
        kind: 'unknown', identity: call('C34', {
          kind: 'readout_unknown', target, uncertain: 'C34:unknown_material' as StateMaterialAffectedScope,
        }),
        problem: {
          detail: 'C34:unknown' as Scope<'C34', 'unknown'>,
          affected: 'C34:unknown_scope' as Scope<'C34', 'unknown_scope'>,
        },
      }
    }
    const report = this.acceptStoredStateReadout({ kind: 'existing_material', material: decoded.material })
    if (report.kind === 'business_result') {
      const candidates = storedRecoveryCandidates.get(this) ?? new WeakMap<C34Result, StoredCanonicalRecoveryCandidate>()
      candidates.set(report, decoded)
      storedRecoveryCandidates.set(this, candidates)
      authenticFinalizedC34Candidates.set(report, decoded)
      finalizedRecoveryTokens.set(report, decoded.token)
    }
    return report
  }

  /** Fixed local-family C34 reader; action owner is bound before raw decode. */
  readStoredLocalRestrictionEvidence(
    evidence: StoredNoFocusRecoveryEvidence,
    actionOwner: ActionFactBoundaryAuthority,
  ): C34Result {
    const owner = this.expectedRecoveryOwner
    const decoded = owner === undefined || expectedActionBoundaryOwners.get(this) !== actionOwner ? undefined
      : decodeStoredLocalRestrictionMaterial(evidence, this, owner, actionOwner)
    if (decoded === undefined) {
      const target = recoveryFailureTarget(evidence.session, this, owner)
      return {
        kind: 'unknown', identity: call('C34', {
          kind: 'readout_unknown', target, uncertain: 'C34:unknown_material' as StateMaterialAffectedScope,
        }),
        problem: {
          detail: 'C34:unknown' as Scope<'C34', 'unknown'>,
          affected: 'C34:unknown_scope' as Scope<'C34', 'unknown_scope'>,
        },
      }
    }
    const readout: StoredStateReadout<'local_restriction', PreservedLocalRestrictionBoundary> = {
      kind: 'existing_material', material: decoded.material,
    }
    const report = this.acceptStoredStateReadout(readout)
    if (report.kind === 'business_result') {
      const candidates = storedRecoveryCandidates.get(this) ?? new WeakMap<C34Result, StoredCanonicalRecoveryCandidate>()
      candidates.set(report, decoded)
      storedRecoveryCandidates.set(this, candidates)
      authenticFinalizedC34Candidates.set(report, decoded)
      finalizedRecoveryTokens.set(report, decoded.token)
      actionFactBoundaryC36Bridges.set(decoded.token, {
        owner: actionOwner, c34: report, boundary: decoded.boundary, consumed: false,
      })
    }
    return report
  }

  /** Fixed no-safe-action C34 reader; action owner is bound before raw decode. */
  readStoredNoSafeActionEvidence(
    evidence: StoredNoFocusRecoveryEvidence,
    actionOwner: ActionFactBoundaryAuthority,
  ): NoSafeActionC34Result<PreservedNoSafeActionBoundary> {
    const owner = this.expectedRecoveryOwner
    const decoded = owner === undefined || expectedActionBoundaryOwners.get(this) !== actionOwner ? undefined
      : decodeStoredNoSafeActionMaterial(evidence, this, owner, actionOwner)
    if (decoded === undefined) {
      const target = recoveryFailureTarget(evidence.session, this, owner)
      return {
        kind: 'unknown', identity: call('C34', {
          kind: 'readout_unknown', target, uncertain: 'C34:unknown_material' as StateMaterialAffectedScope,
        }),
        problem: {
          detail: 'C34:unknown' as Scope<'C34', 'unknown'>,
          affected: 'C34:unknown_scope' as Scope<'C34', 'unknown_scope'>,
        },
      }
    }
    const readout: StoredStateReadout<'no_safe_action', PreservedNoSafeActionBoundary> = {
      kind: 'existing_material', material: decoded.material,
    }
    const report = this.acceptStoredStateReadout(readout)
    if (report.kind === 'business_result') {
      const candidates = storedRecoveryCandidates.get(this) ?? new WeakMap<C34Result, StoredCanonicalRecoveryCandidate>()
      candidates.set(report, decoded)
      storedRecoveryCandidates.set(this, candidates)
      authenticFinalizedC34Candidates.set(report, decoded)
      finalizedRecoveryTokens.set(report, decoded.token)
      actionFactBoundaryC36Bridges.set(decoded.token, {
        owner: actionOwner, c34: report, boundary: decoded.boundary, consumed: false,
      })
    }
    return report
  }

  readStoredBackgroundEvidence(
    evidence: StoredNoFocusRecoveryEvidence,
    actionOwner: ActionFactBoundaryAuthority,
  ): BackgroundC34Result<PreservedActionBoundary> {
    const owner = this.expectedRecoveryOwner
    const decoded = owner === undefined || expectedActionBoundaryOwners.get(this) !== actionOwner ? undefined
      : decodeStoredBackgroundMaterial(evidence, this, owner, actionOwner)
    if (decoded === undefined) {
      const target = recoveryFailureTarget(evidence.session, this, owner)
      return {
        kind: 'unknown', identity: call('C34', {
          kind: 'readout_unknown', target, uncertain: 'C34:unknown_material' as StateMaterialAffectedScope,
        }),
        problem: {
          detail: 'C34:unknown' as Scope<'C34', 'unknown'>,
          affected: 'C34:unknown_scope' as Scope<'C34', 'unknown_scope'>,
        },
      }
    }
    const readout: StoredStateReadout<'background', PreservedActionBoundary> = {
      kind: 'existing_material', material: decoded.material,
    }
    const report = this.acceptStoredStateReadout(readout)
    if (report.kind === 'business_result') {
      const candidates = storedRecoveryCandidates.get(this) ?? new WeakMap<C34Result, StoredCanonicalRecoveryCandidate>()
      candidates.set(report, decoded)
      storedRecoveryCandidates.set(this, candidates)
      authenticFinalizedC34Candidates.set(report, decoded)
      finalizedRecoveryTokens.set(report, decoded.token)
      actionFactBoundaryC36Bridges.set(decoded.token, {
        owner: actionOwner, c34: report, boundary: decoded.boundary, consumed: false,
      })
    }
    return report
  }

}

interface StoredNoFocusRecoveryCandidate {
  readonly family: 'no_focus'
  readonly owner: FocusAuthority
  readonly token: object
  readonly state: PendingCanonicalState
  readonly canonicalRef: CanonicalStateRef
  readonly material: CompleteStateMaterial
  readonly generation: number
  readonly session: Agent['session']
  readonly finalized: SessionEvent<'user/message'>
  readonly body: string
  readonly bodyHash: string
  readonly close: { readonly messageId: string; readonly hash: string }
  /** These were exact-validated in C34 and are reused, never re-signed. */
  readonly storedC06: unknown
  readonly storedC07: unknown
  readonly storedC29: unknown
}
interface StoredLocalRestrictionRecoveryCandidate {
  readonly family: 'local_restriction'
  readonly owner: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly token: object
  readonly state: PendingCanonicalState<'local_restriction', LocalRestrictionBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>
  readonly generation: number
  readonly session: Agent['session']
  readonly finalized: SessionEvent<'user/message'>
  readonly body: string
  readonly bodyHash: string
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly boundary: LocalRestrictionBoundary
  readonly storedC06: unknown
  readonly storedC02: unknown
  readonly storedC20: unknown
  readonly storedC21: unknown
  readonly storedC22: unknown
  readonly storedC29: unknown
}
interface StoredNoSafeActionRecoveryCandidate {
  readonly family: 'no_safe_action'
  readonly owner: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly token: object
  readonly state: PendingCanonicalState<'no_safe_action', NoSafeActionBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>
  readonly generation: number
  readonly session: Agent['session']
  readonly finalized: SessionEvent<'user/message'>
  readonly body: string
  readonly bodyHash: string
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly boundary: NoSafeActionBoundary
  readonly storedC06: unknown
  readonly storedC02: unknown
  readonly storedC20: unknown
  readonly storedC21: unknown
  readonly storedC22: unknown
  readonly storedC29: unknown
}
interface StoredBackgroundRecoveryCandidate {
  readonly family: 'background'
  readonly owner: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly token: object
  readonly state: PendingCanonicalState<'background', ActionFactBoundary>
  readonly canonicalRef: CanonicalStateRef
  readonly material: CompleteStateMaterial<'background', PreservedActionBoundary>
  readonly generation: number
  readonly session: Agent['session']
  readonly finalized: SessionEvent<'user/message'>
  readonly body: string
  readonly bodyHash: string
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly boundary: ActionFactBoundary
  readonly storedC28: unknown
  readonly storedC06: unknown
  readonly storedC20: unknown
  readonly storedC29: unknown
}
type StoredCanonicalRecoveryCandidate = StoredNoFocusRecoveryCandidate | StoredLocalRestrictionRecoveryCandidate
  | StoredNoSafeActionRecoveryCandidate | StoredBackgroundRecoveryCandidate
interface VerifiedFinalizedRecoveryBridge {
  readonly preservation: EffectiveStatePreservation
  readonly owner: FocusAuthority
  readonly token: object
  readonly chat: string
  readonly ref: string
  readonly latestCorrections: string
  readonly currentMatter?: string
}
const storedRecoveryCandidates = new WeakMap<EffectiveStatePreservation, WeakMap<C34Result, StoredCanonicalRecoveryCandidate>>()
const authenticFinalizedC34Candidates = new WeakMap<C34Result, StoredCanonicalRecoveryCandidate>()
const finalizedRecoveryTokens = new WeakMap<C34Result, object>()
const restoredReportTokens = new WeakMap<C35Result, object>()
const restoredReportC34 = new WeakMap<C35Result, C34Result>()
const restoredActionReportTokens = new WeakMap<ActionBoundaryC36Result, object>()
const restoredActionReportC34 = new WeakMap<ActionBoundaryC36Result, C34Result>()
interface RecoveryAttempt {
  readonly preservation: EffectiveStatePreservation
  readonly owner: FocusAuthority
  readonly token: object
  readonly c34: C34Result
  readonly candidate: StoredCanonicalRecoveryCandidate
}
const recoveryAttempts = new WeakMap<C34Result, RecoveryAttempt>()
const restoredReportAttempts = new WeakMap<C35Result, RecoveryAttempt>()
const restoredActionReportAttempts = new WeakMap<ActionBoundaryC36Result, RecoveryAttempt>()
const verifiedFinalizedRecoveryBridges = new WeakMap<object, VerifiedFinalizedRecoveryBridge>()
interface VerifiedRecoveryFailureBridge {
  readonly preservation: EffectiveStatePreservation
  readonly owner: FocusAuthority
  readonly token: object
  readonly session: Agent['session']
  readonly sessionId: string
}
const verifiedRecoveryFailureBridges = new WeakMap<object, VerifiedRecoveryFailureBridge>()

/**
 * Local C36 is intentionally independent from the no-focus C35 bridge.  The
 * entry is populated only after the local raw decoder has proved its finalized
 * record; the public predicate is read-only and consumes the exact token once.
 */
interface ActionFactBoundaryC36Bridge {
  readonly owner: object
  readonly c34: C34Result
  readonly boundary: ActionFactBoundary
  consumed: boolean
}
const actionFactBoundaryC36Bridges = new WeakMap<object, ActionFactBoundaryC36Bridge>()

export function isAuthenticActionFactBoundaryC36Bridge(
  owner: object,
  token: object,
  c34: C34Result,
  boundary: ActionFactBoundary,
): boolean {
  const bridge = actionFactBoundaryC36Bridges.get(token)
  if (bridge === undefined || bridge.consumed || bridge.owner !== owner
    || bridge.c34 !== c34 || bridge.boundary !== boundary || !completeActionFactBoundary(boundary)) return false
  bridge.consumed = true
  return true
}

function sameRestoredActionBoundaryReport(
  report: ActionBoundaryC36Result,
  boundary: ActionFactBoundary,
): boolean {
  if (report.kind !== 'business_result' || report.value.kind !== 'accepted_for_contract') return false
  const restoredBoundary = report.value.value
  return report.identity.contract === 'C36' && report.identity.subject === boundary.ref
    && restoredBoundary.target === boundary.chat
    && samePreservedActionBoundary(restoredBoundary.boundary, boundary)
}

/** Module-private finalized carrier; no recovery candidate escapes this module. */
function finalizedRecoveryCandidateFor(
  preservation: EffectiveStatePreservation,
  readout: C34Result,
): StoredCanonicalRecoveryCandidate | undefined {
  return storedRecoveryCandidates.get(preservation)?.get(readout)
}

/** @internal Read-only focus bridge predicate; registry mutation remains state-private. */
export function isAuthenticFinalizedRecoveryBridge(
  authority: FocusAuthority,
  token: object,
  value: { readonly chat: string; readonly ref: string; readonly latestCorrections: string; readonly currentMatter?: string },
): boolean {
  const bridge = verifiedFinalizedRecoveryBridges.get(token)
  return bridge !== undefined && bridge.owner === authority
    && bridge.chat === value.chat && bridge.ref === value.ref && bridge.latestCorrections === value.latestCorrections
    && bridge.currentMatter === value.currentMatter
}

/** @internal Read-only failure-target predicate over the exact Session object/id. */
export function isAuthenticRecoveryFailureBridge(
  authority: FocusAuthority,
  token: object,
  session: object,
  sessionId: string,
): boolean {
  const bridge = verifiedRecoveryFailureBridges.get(token)
  return bridge !== undefined && bridge.owner === authority
    && bridge.session === session && bridge.sessionId === sessionId
}

/** @internal Read-only exact-C34 predicate consumed by the focus bridge. */
export function isAuthenticFinalizedC34Bridge(readout: C34Result, authority: FocusAuthority, token: object): boolean {
  const candidate = authenticFinalizedC34Candidates.get(readout)
  const attempt = recoveryAttempts.get(readout)
  return candidate !== undefined && attempt !== undefined
    && attempt.owner === authority && attempt.token === token && attempt.c34 === readout && attempt.candidate === candidate
    && candidate.owner === authority && candidate.token === token
    && exactFinalizedC34Candidate(readout, candidate)
}

/** @internal Read-only claim predicate binds the exact C34/C35/token/owner quartet. */
export function isAuthenticRecoveryClaim(
  authority: FocusAuthority, token: object, c34: C34Result, c35: C35Result,
): boolean {
  const attempt = recoveryAttempts.get(c34)
  return attempt !== undefined && attempt.owner === authority && attempt.token === token && attempt.c34 === c34
    && restoredReportAttempts.get(c35) === attempt
    && finalizedRecoveryTokens.get(c34) === token
    && restoredReportTokens.get(c35) === token
    && restoredReportC34.get(c35) === c34
    && c35.kind === 'business_result'
}

/** @internal Read-only action claim predicate for the exact local recovery quartet. */
export function isAuthenticActionFactBoundaryRecoveryClaim(
  authority: ActionFactBoundaryAuthority,
  token: object,
  c34: C34Result,
  c36: ActionBoundaryC36Result,
): boolean {
  const bridge = actionFactBoundaryC36Bridges.get(token)
  return bridge !== undefined && bridge.consumed && bridge.owner === authority
    && bridge.c34 === c34
    && c36.kind === 'business_result'
    && sameRestoredActionBoundaryReport(c36, bridge.boundary)
}

/**
 * A recovery attempt is never re-opened.  Erasing these private associations
 * does not restore any FocusAuthority capability; it merely makes every
 * subsequent bridge predicate fail closed for this exact C34/C35 chain.
 */
function abandonRecoveryAttempt(
  attempt: RecoveryAttempt,
  c35?: C35Result,
  c36?: ActionBoundaryC36Result,
): void {
  recoveryAttempts.delete(attempt.c34)
  storedRecoveryCandidates.get(attempt.preservation)?.delete(attempt.c34)
  authenticFinalizedC34Candidates.delete(attempt.c34)
  finalizedRecoveryTokens.delete(attempt.c34)
  verifiedFinalizedRecoveryBridges.delete(attempt.token)
  actionFactBoundaryC36Bridges.delete(attempt.token)
  const restoration = recoveryRestorations.get(attempt)
  if (restoration !== undefined) {
    restorationAssociations.get(restoration.authority)?.delete(restoration.restoration)
    recoveryRestorations.delete(attempt)
  }
  if (c35 !== undefined) {
    restoredReportAttempts.delete(c35)
    restoredReportTokens.delete(c35)
    restoredReportC34.delete(c35)
    recoveryClaims.delete(c35)
  }
  if (c36 !== undefined) {
    restoredActionReportAttempts.delete(c36)
    restoredActionReportTokens.delete(c36)
    restoredActionReportC34.delete(c36)
  }
}

/** State-private destructive completion after focus has minted the exact fact. */
function consumeAuthenticFinalizedC34Bridge(readout: C34Result, authority: FocusAuthority, token: object): boolean {
  if (!isAuthenticFinalizedC34Bridge(readout, authority, token)) return false
  authenticFinalizedC34Candidates.delete(readout)
  verifiedFinalizedRecoveryBridges.delete(token)
  return true
}

function exactFinalizedC34Candidate(readout: C34Result, candidate: StoredCanonicalRecoveryCandidate): boolean {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return false
  const stored = readout.value.value
  const subject = readout.identity.subject
  if (stored.kind !== 'existing_material' || stored.material !== candidate.material
    || subject.kind !== 'existing_material' || subject.material !== candidate.material) return false
  if (candidate.family === 'no_focus') {
    return candidate.material.target === candidate.state.focus.chat
      && candidate.material.canonicalState.ref === candidate.canonicalRef
      && candidate.material.canonicalState.focus.ref === candidate.state.focus.ref
      && candidate.material.canonicalState.focus.latestCorrections === candidate.state.focus.latestCorrections
      && isCompleteNoFocusMaterial(candidate.material)
  }
  const sameAction = candidate.material.target === candidate.boundary.chat
    && candidate.material.canonicalState.ref === candidate.canonicalRef
    && candidate.material.canonicalState.focus.ref === candidate.state.focus.ref
    && candidate.material.canonicalState.focus.currentMatter === candidate.state.focus.currentMatter
    && candidate.material.canonicalState.focus.latestCorrections === candidate.state.focus.latestCorrections
    && samePreservedActionBoundary(candidate.material.canonicalState.boundary, candidate.boundary)
  return sameAction && (candidate.family === 'local_restriction'
    ? isCompleteLocalRestrictionMaterial(candidate.material)
    : candidate.family === 'no_safe_action'
      ? isCompleteNoSafeActionMaterial(candidate.material)
      : isCompleteBackgroundMaterial(candidate.material))
}

interface PreservationBinding {
  readonly state: RestorablePendingCanonicalState
  readonly material: RestorableCompleteStateMaterial
  readonly canonicalRef: CanonicalStateRef
  readonly expectedMaterialRef: CompleteStateMaterialRef
  readonly persistence: StatePersistence
  readonly saveCapability: (material: RestorableCompleteStateMaterial) => Promise<C33Result>
  readonly saveComplete: (state: RestorablePendingCanonicalState) => Promise<C33Result>
  readonly saved: () => C33Result | undefined
}
const preservationBindings = new WeakMap<EffectiveStatePreservation, Map<PendingCanonicalStateRef, PreservationBinding>>()
const acceptedC20Boundaries = new WeakMap<EffectiveStatePreservation, WeakMap<C20Result, ActionFactBoundary>>()
const acceptedC21Boundaries = new WeakMap<CanonicalContextAuthority, WeakMap<C21Result, ActionFactBoundary>>()
const decodedBackgroundReplayPendings = new WeakSet<PrivatePendingBackground>()

function bindCompleteMaterial(
  preservation: EffectiveStatePreservation,
  state: RestorablePendingCanonicalState,
  binding: PreservationBinding,
): void {
  const bindings = preservationBindings.get(preservation) ?? new Map<PendingCanonicalStateRef, PreservationBinding>()
  if (bindings.has(state.ref)) throw new Error('pending state already has a preservation binding')
  bindings.set(state.ref, binding)
  preservationBindings.set(preservation, bindings)
}
function clearCompleteMaterial(preservation: EffectiveStatePreservation, state: RestorablePendingCanonicalState): void {
  const bindings = preservationBindings.get(preservation)
  if (bindings === undefined) return
  bindings.delete(state.ref)
  if (bindings.size === 0) preservationBindings.delete(preservation)
}

function bindingMatchesPending(binding: PreservationBinding | undefined, state: RestorablePendingCanonicalState): binding is PreservationBinding {
  if (binding === undefined || binding.state !== state
    || binding.expectedMaterialRef !== binding.material.ref
    || binding.material.canonicalState.ref !== binding.canonicalRef
    || Object.prototype.hasOwnProperty.call(binding.material.canonicalState, 'target')) return false
  if (state.kind === 'no_focus') {
    if (binding.material.kind !== 'no_focus_material'
      || binding.material.target !== state.focus.chat
      || binding.material.canonicalState.kind !== 'no_focus'
      || binding.material.canonicalState.focus.kind !== state.focus.kind
      || binding.material.canonicalState.focus.ref !== state.focus.ref
      || binding.material.canonicalState.focus.latestCorrections !== state.focus.latestCorrections) return false
  } else if (state.kind === 'local_restriction') {
    const material = binding.material
    if (material.kind !== 'local_restriction_material'
      || material.target !== state.boundary.chat
      || material.canonicalState.kind !== 'local_restriction'
      || material.canonicalState.focus.kind !== 'focus_established'
      || material.canonicalState.focus.ref !== state.focus.ref
      || material.canonicalState.focus.currentMatter !== state.focus.currentMatter
      || material.canonicalState.focus.latestCorrections !== state.focus.latestCorrections
      || !samePreservedActionBoundary(material.canonicalState.boundary, state.boundary)) return false
  } else if (state.kind === 'no_safe_action') {
    const material = binding.material
    if (material.kind !== 'no_safe_action_material'
      || material.target !== state.boundary.chat
      || material.canonicalState.kind !== 'no_safe_action'
      || material.canonicalState.focus.kind !== 'focus_established'
      || material.canonicalState.focus.ref !== state.focus.ref
      || material.canonicalState.focus.currentMatter !== state.focus.currentMatter
      || material.canonicalState.focus.latestCorrections !== state.focus.latestCorrections
      || !samePreservedActionBoundary(material.canonicalState.boundary, state.boundary)) return false
  } else {
    const material = binding.material
    if (material.kind !== 'background_material'
      || material.target !== state.boundary.chat
      || material.canonicalState.kind !== 'background'
      || material.canonicalState.candidateRef !== state.candidateRef
      || material.canonicalState.focus.kind !== 'focus_established'
      || material.canonicalState.focus.ref !== state.focus.ref
      || material.canonicalState.focus.currentMatter !== state.focus.currentMatter
      || material.canonicalState.focus.latestCorrections !== state.focus.latestCorrections
      || state.qualification.kind !== 'business_result'
      || state.qualification.identity.subject.kind !== 'candidate'
      || state.qualification.identity.subject.candidate.ref !== state.candidateRef
      || !samePreservedActionBoundary(material.canonicalState.boundary, state.boundary)) return false
  }
  return statePersistenceCapability(binding.persistence) === binding.saveCapability
}

/** Owns C07 and privately composes the C07+C30+C31 evidence into state. */
export class CanonicalContextAuthority {
  constructor() {
    const pendings = new Map<PendingCanonicalStateRef, PrivatePendingNoFocus | PrivatePendingLocalRestriction
      | PrivatePendingNoSafeAction | PrivatePendingBackground>()
    const restorations = new WeakMap<CanonicalRestoration, FamilyRestorationAssociation>()
    restorationAssociations.set(this, restorations)
    authorityPorts.set(this, {
      prepareNoFocus: (c06, c07, material, generation) => {
        const pending = prepareNoFocus(c06, c07, material, generation)
        if (pending === undefined || pendings.has(pending.state.ref)) return undefined
        pendings.set(pending.state.ref, pending)
        return pending
      },
      prepareLocalRestriction: (preservation, actionOwner, acceptance, c06, session, material, generation) => {
        const pending = prepareLocalRestriction(
          preservation, this, actionOwner, acceptance, c06, session, material, generation,
        )
        if (pending === undefined || pendings.has(pending.state.ref)) return undefined
        pendings.set(pending.state.ref, pending)
        return pending
      },
      prepareNoSafeAction: (preservation, actionOwner, handoff, c06, session, material, generation) => {
        const pending = prepareNoSafeAction(
          preservation, this, actionOwner, handoff, c06, session, material, generation,
        )
        if (pending === undefined || pendings.has(pending.state.ref)) return undefined
        pendings.set(pending.state.ref, pending)
        return pending
      },
      prepareBackground: (preservation, actionOwner, decision, c28, focus, boundary, c06, c20, material, generation) => {
        const pending = prepareBackground(
          preservation, actionOwner, decision, c28, focus, boundary, c06, c20, material, generation,
        )
        if (pending === undefined || pendings.has(pending.state.ref)) return undefined
        pendings.set(pending.state.ref, pending)
        return pending
      },
      registerBackgroundReplay: pending => {
        if (!decodedBackgroundReplayPendings.has(pending) || pendings.has(pending.state.ref)) return false
        decodedBackgroundReplayPendings.delete(pending)
        pendings.set(pending.state.ref, pending)
        return true
      },
      formCurrentContext: (pending, c30, c31) => {
        if (pendings.get(pending.state.ref) !== pending) return undefined
        return formCurrentContext(pending, c30, c31)
      },
      formLocalCurrentContext: (pending, c30, c31) => {
        if (pendings.get(pending.state.ref) !== pending) return undefined
        return formLocalCurrentContext(pending, c30, c31)
      },
      formNoSafeCurrentContext: (pending, c30, c31) => {
        if (pendings.get(pending.state.ref) !== pending) return undefined
        return formNoSafeCurrentContext(pending, c30, c31)
      },
      formBackgroundCurrentContext: (pending, c30, c31) => {
        if (pendings.get(pending.state.ref) !== pending) return undefined
        return formBackgroundCurrentContext(pending, c30, c31)
      },
      releasePending: pending => {
        if (pendings.get(pending.state.ref) === pending) pendings.delete(pending.state.ref)
      },
      prepareRestoration: (focusAuthority, c34, c35, c30, c31, phase) => {
        const claim = recoveryClaims.get(c35)
        if (claim === undefined || claim.owner !== focusAuthority || claim.c34 !== c34 || claim.token !== restoredReportTokens.get(c35)) return undefined
        const restoration = formCanonicalRestoration(c34, c35, c30, c31)
        if (restoration === undefined || restoration.kind !== 'no_focus_restored') return undefined
        restorations.set(restoration, {
          focusAuthority, c34, c35, c30, c31, material: restoration.material, phase,
          claim,
        })
        recoveryRestorations.set(claim.attempt, { authority: this, restoration })
        return restoration
      },
      prepareLocalRestoration: (focusAuthority, actionOwner, c34, c35, c36, c30, c31, phase) => {
        const claim = recoveryClaims.get(c35)
        if (claim === undefined || claim.candidate.family !== 'local_restriction'
          || claim.owner !== focusAuthority || claim.candidate.actionOwner !== actionOwner
          || claim.c34 !== c34 || claim.token !== restoredReportTokens.get(c35)) return undefined
        const restoration = formLocalCanonicalRestoration(c34, c35, c36, c30, c31)
        if (restoration === undefined) return undefined
        restorations.set(restoration, {
          family: 'local_restriction', c37Owner: this, focusAuthority, actionOwner,
          c34: c34 as LocalRestrictionC34Result<PreservedLocalRestrictionBoundary>,
          c35, c36, c30, c31, material: restoration.material, phase, claim,
        })
        recoveryRestorations.set(claim.attempt, { authority: this, restoration })
        return restoration
      },
      prepareNoSafeRestoration: (focusAuthority, actionOwner, c34, c35, c36, c30, c31, phase) => {
        const claim = recoveryClaims.get(c35)
        if (claim === undefined || claim.candidate.family !== 'no_safe_action'
          || claim.owner !== focusAuthority || claim.candidate.actionOwner !== actionOwner
          || claim.c34 !== c34 || claim.token !== restoredReportTokens.get(c35)) return undefined
        const restoration = formNoSafeCanonicalRestoration(c34, c35, c36, c30, c31)
        if (restoration === undefined) return undefined
        restorations.set(restoration, {
          family: 'no_safe_action', c37Owner: this, focusAuthority, actionOwner,
          c34,
          c35, c36, c30, c31, material: restoration.material, phase, claim,
        })
        recoveryRestorations.set(claim.attempt, { authority: this, restoration })
        return restoration
      },
      prepareBackgroundRestoration: (focusAuthority, actionOwner, c34, c35, c36, c30, c31, phase) => {
        const claim = recoveryClaims.get(c35)
        if (claim === undefined || claim.candidate.family !== 'background'
          || claim.owner !== focusAuthority || claim.candidate.actionOwner !== actionOwner
          || claim.c34 !== c34 || claim.token !== restoredReportTokens.get(c35)) return undefined
        const restoration = formBackgroundCanonicalRestoration(c34, c35, c36, c30, c31)
        if (restoration === undefined) return undefined
        restorations.set(restoration, {
          family: 'background', c37Owner: this, focusAuthority, actionOwner,
          c34, c35, c36, c30, c31, material: restoration.material, phase, claim,
        })
        recoveryRestorations.set(claim.attempt, { authority: this, restoration })
        return restoration
      },
    })
  }
  acceptCurrentFocus(focus: FocusDecision): C07Result {
    if (focus.kind !== 'no_focus') return rejected('C07', focus.ref)
    return result('C07', focus.ref, { kind: 'accepted_for_contract', value: focus })
  }

  /** C21 is deliberately a receiver only; it cannot reinterpret an action boundary. */
  acceptActionSafetyBoundary(boundary: ActionFactBoundary): C21Result {
    if (!completeActionFactBoundary(boundary)) return rejected('C21', boundary.ref)
    const report = result<'C21', ActionFactBoundaryRef, Accepted<ActionFactBoundary>, PartialActionFactBoundary>(
      'C21', boundary.ref, { kind: 'accepted_for_contract', value: boundary },
    )
    const reports = acceptedC21Boundaries.get(this) ?? new WeakMap<C21Result, ActionFactBoundary>()
    reports.set(report, boundary)
    acceptedC21Boundaries.set(this, reports)
    return report
  }

  /** C37 receiver: recovery evidence is already signed by C34/C35/C30/C31. */
  acceptCanonicalRestoration(restoration: CanonicalRestoration): C37Result {
    const association = restorationAssociations.get(this)?.get(restoration)
    // An attempted C37 consumes this exact association even when validation
    // rejects it; failed recovery must not resurrect a claim token.
    restorationAssociations.get(this)?.delete(restoration)
    if (association !== undefined) recoveryClaims.delete(association.c35)
    if (association === undefined || association.material !== restoration.material
      || association.c34.kind !== 'business_result' || association.c35.kind !== 'business_result'
      || association.c30.kind !== 'business_result' || association.c31.kind !== 'business_result'
      || association.c34.value.kind !== 'accepted_for_contract'
      || association.c34.value.value.kind !== 'existing_material'
      || association.c34.value.value.material !== association.material
      || association.phase !== 'finalized_retained'
      || association.claim.c34 !== association.c34 || association.claim.c35 !== association.c35
      || association.claim.owner !== association.focusAuthority || association.claim.token !== restoredReportTokens.get(association.c35)
      || association.claim.attempt.c34 !== association.c34 || association.claim.attempt.owner !== association.focusAuthority
      || association.claim.attempt.token !== association.claim.token || association.claim.attempt.candidate !== association.claim.candidate
      || restoredReportAttempts.get(association.c35) !== association.claim.attempt
      || restoredReportC34.get(association.c35) !== association.c34
      || !sameRestoredFocusReport(association.c35, association.material)
      || !sameRecoveryStateReports(association.c30, association.c31, association.material)) {
      return rejected('C37', restoration.material.target)
    }
    if (restoration.kind === 'no_focus_restored') {
      if ('family' in association || association.material.kind !== 'no_focus_material'
        || !isCompleteNoFocusMaterial(restoration.material)) return rejected('C37', restoration.material.target)
    } else {
      const expectedFamily = restoration.kind === 'local_restriction_restored' ? 'local_restriction'
        : restoration.kind === 'no_safe_action_restored' ? 'no_safe_action' : 'background'
      const expectedMaterialKind = restoration.kind === 'local_restriction_restored'
        ? 'local_restriction_material'
        : restoration.kind === 'no_safe_action_restored' ? 'no_safe_action_material' : 'background_material'
      if (!('family' in association) || association.family !== expectedFamily
        || association.c37Owner !== this || association.material.kind !== expectedMaterialKind
        || association.claim.candidate.family !== expectedFamily
        || association.actionOwner !== association.claim.candidate.actionOwner
        || association.c36.kind !== 'business_result'
        || association.c36.identity.contract !== 'C36'
        || association.c36.identity.subject !== association.material.canonicalState.boundary.ref
        || !sameRestoredActionBoundaryReport(association.c36, association.claim.candidate.boundary)
        || restoredActionReportAttempts.get(association.c36) !== association.claim.attempt
        || restoredActionReportTokens.get(association.c36) !== association.claim.token
        || restoredActionReportC34.get(association.c36) !== association.c34
        || !isClaimedRestoredActionBoundaryReport(association.actionOwner, association.c36)
        || (restoration.kind === 'local_restriction_restored'
          ? !isCompleteLocalRestrictionMaterial(restoration.material)
          : restoration.kind === 'no_safe_action_restored'
            ? !isCompleteNoSafeActionMaterial(restoration.material)
            : !isCompleteBackgroundMaterial(restoration.material))) {
        return rejected('C37', restoration.material.target)
      }
    }
    return result('C37', restoration.material.target, { kind: 'accepted_for_contract', value: restoration })
  }
}

interface CanonicalAuthorityPort {
  readonly prepareNoFocus: typeof prepareNoFocus
  readonly prepareLocalRestriction: (
    preservation: EffectiveStatePreservation, actionOwner: ActionFactBoundaryAuthority,
    acceptance: LocalRestrictionAcceptance, c06: C06Result,
    session: Agent['session'],
    material: CanonicalLocalRestrictionMaterial, generation: number,
  ) => PrivatePendingLocalRestriction | undefined
  readonly prepareNoSafeAction: (
    preservation: EffectiveStatePreservation, actionOwner: ActionFactBoundaryAuthority,
    handoff: ActionFactBoundaryStateHandoff, c06: C06Result,
    session: Agent['session'], material: CanonicalNoSafeActionMaterial, generation: number,
  ) => PrivatePendingNoSafeAction | undefined
  readonly prepareBackground: (
    preservation: EffectiveStatePreservation,
    actionOwner: ActionFactBoundaryAuthority,
    decision: QualifiedCandidateDecision,
    c28: C28Result,
    focus: EstablishedFocusDecision,
    boundary: ActionFactBoundary,
    c06: C06Result,
    c20: C20Result,
    material: CanonicalBackgroundMaterial,
    generation: number,
  ) => PrivatePendingBackground | undefined
  readonly registerBackgroundReplay: (pending: PrivatePendingBackground) => boolean
  readonly formCurrentContext: typeof formCurrentContext
  readonly formLocalCurrentContext: typeof formLocalCurrentContext
  readonly formNoSafeCurrentContext: typeof formNoSafeCurrentContext
  readonly formBackgroundCurrentContext: typeof formBackgroundCurrentContext
  readonly releasePending: (pending: PrivatePendingNoFocus | PrivatePendingLocalRestriction
    | PrivatePendingNoSafeAction | PrivatePendingBackground) => void
  readonly prepareRestoration: (
    focusAuthority: FocusAuthority, c34: C34Result, c35: C35Result, c30: C30Result, c31: C31Result,
    phase: 'finalized_retained',
  ) => CanonicalRestoration | undefined
  readonly prepareLocalRestoration: (
    focusAuthority: FocusAuthority, actionOwner: ActionFactBoundaryAuthority,
    c34: C34Result, c35: C35Result, c36: ActionBoundaryC36Result,
    c30: C30Result, c31: C31Result, phase: 'finalized_retained',
  ) => LocalRestrictionCanonicalRestoration | undefined
  readonly prepareNoSafeRestoration: (
    focusAuthority: FocusAuthority, actionOwner: ActionFactBoundaryAuthority,
    c34: NoSafeActionC34Result<PreservedNoSafeActionBoundary>, c35: C35Result, c36: ActionBoundaryC36Result,
    c30: C30Result, c31: C31Result, phase: 'finalized_retained',
  ) => NoSafeActionCanonicalRestoration | undefined
  readonly prepareBackgroundRestoration: (
    focusAuthority: FocusAuthority, actionOwner: ActionFactBoundaryAuthority,
    c34: BackgroundC34Result<PreservedActionBoundary>, c35: C35Result, c36: ActionBoundaryC36Result,
    c30: C30Result, c31: C31Result, phase: 'finalized_retained',
  ) => BackgroundCanonicalRestoration | undefined
}
const authorityPorts = new WeakMap<CanonicalContextAuthority, CanonicalAuthorityPort>()
interface RestorationAssociation {
  readonly focusAuthority: FocusAuthority
  readonly c34: C34Result
  readonly c35: C35Result
  readonly c30: C30Result
  readonly c31: C31Result
  readonly material: CompleteStateMaterial
  readonly phase: 'finalized_retained'
  readonly claim: RecoveryClaim
}
const restorationAssociations = new WeakMap<CanonicalContextAuthority, WeakMap<CanonicalRestoration, FamilyRestorationAssociation>>()
const recoveryRestorations = new WeakMap<RecoveryAttempt, {
  readonly authority: CanonicalContextAuthority
  readonly restoration: CanonicalRestoration
}>()
interface RecoveryClaim {
  readonly attempt: RecoveryAttempt
  readonly owner: FocusAuthority
  readonly token: object
  readonly c34: C34Result
  readonly c35: C35Result
  readonly candidate: StoredCanonicalRecoveryCandidate
}
const recoveryClaims = new WeakMap<C35Result, RecoveryClaim>()
function canonicalAuthorityPort(authority: CanonicalContextAuthority): CanonicalAuthorityPort {
  const port = authorityPorts.get(authority)
  if (port === undefined) throw new Error('canonical authority has no private association port')
  return port
}

export interface FinalizedNoFocusRecoveryResult {
  readonly c34: C34Result
  readonly c35: C35Result
  readonly c37: C37Result
}
export interface FinalizedNoFocusRecoveryPort {
  restore(stored: StoredNoFocusRecoveryEvidence): FinalizedNoFocusRecoveryResult | undefined
}

/** The only recovery operation exposed across modules: one complete attempt. */
export function createFinalizedNoFocusRecoveryPort(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  authority: CanonicalContextAuthority,
): FinalizedNoFocusRecoveryPort {
  return Object.freeze({
    restore: (stored: StoredNoFocusRecoveryEvidence) => restoreFinalizedNoFocus(preservation, owner, authority, stored),
  })
}

function restoreFinalizedNoFocus(
  preservation: EffectiveStatePreservation, owner: FocusAuthority,
  authority: CanonicalContextAuthority, stored: StoredNoFocusRecoveryEvidence,
): FinalizedNoFocusRecoveryResult | undefined {
  if (!preservation.hasExpectedRecoveryOwner(owner)) return undefined
  const c34 = preservation.readStoredNoFocusEvidence(stored)
  const candidate = finalizedRecoveryCandidateFor(preservation, c34)
  const token = finalizedRecoveryTokens.get(c34)
  if (candidate === undefined || candidate.family !== 'no_focus'
    || token === undefined || candidate.owner !== owner) return undefined
  const attempt: RecoveryAttempt = { preservation, owner, token, c34, candidate }
  recoveryAttempts.set(c34, attempt)
  const fact = issueAuthenticatedRestoredFocusFact(owner, token, c34)
  if (fact === undefined || !consumeAuthenticFinalizedC34Bridge(c34, owner, token)) {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  const c35 = owner.acceptRestoredFocusFact(fact)
  if (c35.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  restoredReportTokens.set(c35, token)
  restoredReportC34.set(c35, c34)
  restoredReportAttempts.set(c35, attempt)
  const c30 = preservation.establishRetainedRecoverablePreservation(c34)
  if (c30 === undefined) { abandonRecoveryAttempt(attempt, c35); return undefined }
  const retained: VisibleRuntime = { session: candidate.session, pending: candidate, message: candidate.finalized.data,
    seq: candidate.finalized.seq, phase: 'finalized', material: { body: candidate.body, bodyHash: candidate.bodyHash },
    close: candidate.close, retained: true }
  const c31 = new UniqueVisibleContextReplacement(() => retained).replaceVisibleContext(candidate.state)
  if (c31.kind !== 'business_result' || c31.value.kind !== 'same_state_already_uniquely_visible') {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  if (!claimAcceptedRestoredFocusReport(owner, token, c34, c35)) {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  recoveryClaims.set(c35, { attempt, owner, token, c34, c35, candidate })
  recoveryAttempts.delete(c34)
  const restoration = canonicalAuthorityPort(authority).prepareRestoration(owner, c34, c35, c30, c31, 'finalized_retained')
  if (restoration === undefined || !isClaimedRestoredFocusReport(owner, c35)) {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  const c37 = authority.acceptCanonicalRestoration(restoration)
  if (c37.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  abandonRecoveryAttempt(attempt, c35)
  return { c34, c35, c37 }
}

export interface FinalizedLocalRestrictionRecoveryResult {
  readonly c34: C34Result
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c37: C37Result
}
export interface FinalizedLocalRestrictionRecoveryPort {
  restore(stored: StoredNoFocusRecoveryEvidence): FinalizedLocalRestrictionRecoveryResult | undefined
}

/** Complete cold port; opaque family token never crosses this closure. */
export function createFinalizedLocalRestrictionRecoveryPort(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
): FinalizedLocalRestrictionRecoveryPort {
  return Object.freeze({
    restore: (stored: StoredNoFocusRecoveryEvidence) =>
      restoreFinalizedLocalRestriction(preservation, owner, actionOwner, authority, stored),
  })
}

function restoreFinalizedLocalRestriction(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
  stored: StoredNoFocusRecoveryEvidence,
): FinalizedLocalRestrictionRecoveryResult | undefined {
  if (!preservation.hasExpectedRecoveryOwner(owner)) return undefined
  const c34 = preservation.readStoredLocalRestrictionEvidence(stored, actionOwner)
  const candidate = finalizedRecoveryCandidateFor(preservation, c34)
  const token = finalizedRecoveryTokens.get(c34)
  if (candidate === undefined || candidate.family !== 'local_restriction'
    || token === undefined || candidate.owner !== owner || candidate.actionOwner !== actionOwner) return undefined
  const attempt: RecoveryAttempt = { preservation, owner, token, c34, candidate }
  recoveryAttempts.set(c34, attempt)
  const fact = issueAuthenticatedRestoredFocusFact(owner, token, c34)
  if (fact === undefined || !consumeAuthenticFinalizedC34Bridge(c34, owner, token)) {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  const c35 = owner.acceptRestoredFocusFact(fact)
  if (c35.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  restoredReportTokens.set(c35, token)
  restoredReportC34.set(c35, c34)
  restoredReportAttempts.set(c35, attempt)
  const restoredBoundary = issueAuthenticatedRestoredActionBoundary(actionOwner, token, c34, candidate.boundary)
  if (restoredBoundary === undefined) {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  const c36 = actionOwner.acceptRestoredActionBoundary(restoredBoundary)
  if (!sameRestoredActionBoundaryReport(c36, candidate.boundary)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  restoredActionReportTokens.set(c36, token)
  restoredActionReportC34.set(c36, c34)
  restoredActionReportAttempts.set(c36, attempt)
  const c30 = preservation.establishRetainedRecoverablePreservation(c34)
  if (c30 === undefined) { abandonRecoveryAttempt(attempt, c35, c36); return undefined }
  const retained: VisibleRuntime = {
    session: candidate.session, pending: candidate, message: candidate.finalized.data,
    seq: candidate.finalized.seq, phase: 'finalized', material: { body: candidate.body, bodyHash: candidate.bodyHash },
    close: candidate.close, retained: true,
  }
  const c31 = new UniqueVisibleContextReplacement(() => retained).replaceVisibleContext(candidate.state)
  if (c31.kind !== 'business_result' || c31.value.kind !== 'same_state_already_uniquely_visible') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  if (!claimAcceptedRestoredFocusReport(owner, token, c34, c35)
    || !claimAcceptedRestoredActionBoundaryReport(actionOwner, token, c34, c36)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  recoveryClaims.set(c35, { attempt, owner, token, c34, c35, candidate })
  recoveryAttempts.delete(c34)
  const restoration = canonicalAuthorityPort(authority).prepareLocalRestoration(
    owner, actionOwner, c34, c35, c36, c30, c31, 'finalized_retained',
  )
  if (restoration === undefined || !isClaimedRestoredFocusReport(owner, c35)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  const c37 = authority.acceptCanonicalRestoration(restoration)
  if (c37.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  abandonRecoveryAttempt(attempt, c35, c36)
  return { c34, c35, c36, c37 }
}

export interface FinalizedNoSafeActionRecoveryResult {
  readonly c34: C34Result
  readonly c35: C35Result
  readonly c36: ActionBoundaryC36Result
  readonly c37: C37Result
}
export interface FinalizedNoSafeActionRecoveryPort {
  restore(stored: StoredNoFocusRecoveryEvidence): FinalizedNoSafeActionRecoveryResult | undefined
}

export function createFinalizedNoSafeActionRecoveryPort(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
): FinalizedNoSafeActionRecoveryPort {
  return Object.freeze({
    restore: (stored: StoredNoFocusRecoveryEvidence) =>
      restoreFinalizedNoSafeAction(preservation, owner, actionOwner, authority, stored),
  })
}

function restoreFinalizedNoSafeAction(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
  stored: StoredNoFocusRecoveryEvidence,
): FinalizedNoSafeActionRecoveryResult | undefined {
  if (!preservation.hasExpectedRecoveryOwner(owner)) return undefined
  const c34 = preservation.readStoredNoSafeActionEvidence(stored, actionOwner)
  const candidate = finalizedRecoveryCandidateFor(preservation, c34)
  const token = finalizedRecoveryTokens.get(c34)
  if (candidate === undefined || candidate.family !== 'no_safe_action'
    || token === undefined || candidate.owner !== owner || candidate.actionOwner !== actionOwner) return undefined
  const attempt: RecoveryAttempt = { preservation, owner, token, c34, candidate }
  recoveryAttempts.set(c34, attempt)
  const fact = issueAuthenticatedRestoredFocusFact(owner, token, c34)
  if (fact === undefined || !consumeAuthenticFinalizedC34Bridge(c34, owner, token)) {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  const c35 = owner.acceptRestoredFocusFact(fact)
  if (c35.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  restoredReportTokens.set(c35, token)
  restoredReportC34.set(c35, c34)
  restoredReportAttempts.set(c35, attempt)
  const restoredBoundary = issueAuthenticatedRestoredActionBoundary(actionOwner, token, c34, candidate.boundary)
  if (restoredBoundary === undefined) {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  const c36 = actionOwner.acceptRestoredActionBoundary(restoredBoundary)
  if (!sameRestoredActionBoundaryReport(c36, candidate.boundary)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  restoredActionReportTokens.set(c36, token)
  restoredActionReportC34.set(c36, c34)
  restoredActionReportAttempts.set(c36, attempt)
  const c30 = preservation.establishRetainedRecoverablePreservation(c34)
  if (c30 === undefined) { abandonRecoveryAttempt(attempt, c35, c36); return undefined }
  const retained: VisibleRuntime = {
    session: candidate.session, pending: candidate, message: candidate.finalized.data,
    seq: candidate.finalized.seq, phase: 'finalized', material: { body: candidate.body, bodyHash: candidate.bodyHash },
    close: candidate.close, retained: true,
  }
  const c31 = new UniqueVisibleContextReplacement(() => retained).replaceVisibleContext(candidate.state)
  if (c31.kind !== 'business_result' || c31.value.kind !== 'same_state_already_uniquely_visible') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  if (!claimAcceptedRestoredFocusReport(owner, token, c34, c35)
    || !claimAcceptedRestoredActionBoundaryReport(actionOwner, token, c34, c36)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  recoveryClaims.set(c35, { attempt, owner, token, c34, c35, candidate })
  recoveryAttempts.delete(c34)
  const restoration = canonicalAuthorityPort(authority).prepareNoSafeRestoration(
    owner, actionOwner, c34, c35, c36, c30, c31, 'finalized_retained',
  )
  if (restoration === undefined || !isClaimedRestoredFocusReport(owner, c35)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  const c37 = authority.acceptCanonicalRestoration(restoration)
  if (c37.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  abandonRecoveryAttempt(attempt, c35, c36)
  return { c34, c35, c36, c37 }
}

export function createFinalizedBackgroundRecoveryPort(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
): FinalizedBackgroundRecoveryPort {
  return Object.freeze({
    restore: (stored: StoredNoFocusRecoveryEvidence) =>
      restoreFinalizedBackground(preservation, owner, actionOwner, authority, stored),
  })
}

function restoreFinalizedBackground(
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  authority: CanonicalContextAuthority,
  stored: StoredNoFocusRecoveryEvidence,
): FinalizedBackgroundRecoveryResult | undefined {
  if (!preservation.hasExpectedRecoveryOwner(owner)) return undefined
  const c34 = preservation.readStoredBackgroundEvidence(stored, actionOwner)
  const candidate = finalizedRecoveryCandidateFor(preservation, c34)
  const token = finalizedRecoveryTokens.get(c34)
  if (candidate === undefined || candidate.family !== 'background'
    || token === undefined || candidate.owner !== owner || candidate.actionOwner !== actionOwner) return undefined
  const attempt: RecoveryAttempt = { preservation, owner, token, c34, candidate }
  recoveryAttempts.set(c34, attempt)
  const fact = issueAuthenticatedRestoredFocusFact(owner, token, c34)
  if (fact === undefined || !consumeAuthenticFinalizedC34Bridge(c34, owner, token)) {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  const c35 = owner.acceptRestoredFocusFact(fact)
  if (c35.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt)
    return undefined
  }
  restoredReportTokens.set(c35, token)
  restoredReportC34.set(c35, c34)
  restoredReportAttempts.set(c35, attempt)
  const restoredBoundary = issueAuthenticatedRestoredActionBoundary(actionOwner, token, c34, candidate.boundary)
  if (restoredBoundary === undefined) {
    abandonRecoveryAttempt(attempt, c35)
    return undefined
  }
  const c36 = actionOwner.acceptRestoredActionBoundary(restoredBoundary)
  if (!sameRestoredActionBoundaryReport(c36, candidate.boundary)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  restoredActionReportTokens.set(c36, token)
  restoredActionReportC34.set(c36, c34)
  restoredActionReportAttempts.set(c36, attempt)
  const c30 = preservation.establishRetainedRecoverablePreservation(c34)
  if (c30 === undefined) { abandonRecoveryAttempt(attempt, c35, c36); return undefined }
  const retained: VisibleRuntime = {
    session: candidate.session, pending: candidate, message: candidate.finalized.data,
    seq: candidate.finalized.seq, phase: 'finalized', material: { body: candidate.body, bodyHash: candidate.bodyHash },
    close: candidate.close, retained: true,
  }
  const c31 = new UniqueVisibleContextReplacement(() => retained).replaceVisibleContext(candidate.state)
  if (c31.kind !== 'business_result' || c31.value.kind !== 'same_state_already_uniquely_visible') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  if (!claimAcceptedRestoredFocusReport(owner, token, c34, c35)
    || !claimAcceptedRestoredActionBoundaryReport(actionOwner, token, c34, c36)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  recoveryClaims.set(c35, { attempt, owner, token, c34, c35, candidate })
  recoveryAttempts.delete(c34)
  const restoration = canonicalAuthorityPort(authority).prepareBackgroundRestoration(
    owner, actionOwner, c34, c35, c36, c30, c31, 'finalized_retained',
  )
  if (restoration === undefined || !isClaimedRestoredFocusReport(owner, c35)) {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  const c37 = authority.acceptCanonicalRestoration(restoration)
  if (c37.kind !== 'business_result') {
    abandonRecoveryAttempt(attempt, c35, c36)
    return undefined
  }
  abandonRecoveryAttempt(attempt, c35, c36)
  return { c34, c35, c36, c37 }
}

/** Internal association only; it is deliberately not an authority method. */
function prepareNoFocus(
  c06: C06Result, c07: C07Result, material: CanonicalNoFocusMaterial, generation: number,
): PrivatePendingNoFocus | undefined {
    const preserved = value(c06)?.value
    const accepted = value(c07)?.value
    if (preserved?.kind !== 'no_focus' || accepted?.kind !== 'no_focus'
      || preserved.ref !== accepted.ref || preserved.chat !== accepted.chat
      || preserved.latestCorrections !== accepted.latestCorrections) return undefined
    const canonicalRef = `canonical:${accepted.ref}` as CanonicalStateRef
    const state: PendingCanonicalState = {
      kind: 'no_focus',
      ref: `pending:${createHash('sha256').update(canonicalRef).update('\0').update(accepted.ref).digest('hex')}` as PendingCanonicalStateRef,
      focus: accepted,
    }
    const canonicalState: CanonicalNoFocusState = {
      kind: 'no_focus', ref: canonicalRef, target: accepted.chat,
      focus: { kind: 'no_focus', ref: accepted.ref, latestCorrections: accepted.latestCorrections },
    }
    return {
      state, canonicalRef, generation, c06, c07,
      material: {
        kind: 'no_focus_material',
        ref: `material:${createHash('sha256').update(state.ref).update('\0').update(material.bodyHash).digest('hex')}` as CompleteStateMaterialRef,
        target: accepted.chat,
        canonicalState: {
          kind: canonicalState.kind,
          ref: canonicalState.ref,
          focus: canonicalState.focus,
        },
      },
    }
}

/** Associates one exact owner-issued C02/C20/C21/C22 acceptance with the fixed local family. */
function prepareLocalRestriction(
  preservation: EffectiveStatePreservation,
  authority: CanonicalContextAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  acceptance: LocalRestrictionAcceptance,
  c06: C06Result,
  session: Agent['session'],
  material: CanonicalLocalRestrictionMaterial,
  generation: number,
): PrivatePendingLocalRestriction | undefined {
  const { c02, c20, c21, c22 } = acceptance
  const focus = c02.kind === 'business_result' ? c02.value.value : undefined
  const preservedFocusFact = value(c06)?.value
  const preservedBoundary = value(c20)?.value
  const currentBoundary = value(c21)?.value
  if (focus?.kind !== 'focus_established' || preservedFocusFact !== focus
    || c22.kind !== 'business_result'
    || preservedBoundary?.kind !== 'local_restriction'
    || currentBoundary?.kind !== 'local_restriction'
    || preservedBoundary !== currentBoundary
    || c22.value.value !== preservedBoundary
    || c02.identity.contract !== 'C02' || c02.identity.subject !== focus.ref
    || c22.identity.contract !== 'C22' || c22.identity.subject !== preservedBoundary.ref
    || acceptedC20Boundaries.get(preservation)?.get(c20) !== preservedBoundary
    || acceptedC21Boundaries.get(authority)?.get(c21) !== currentBoundary
    || preservedBoundary.chat !== focus.chat
    || material.family !== 'local_restriction'
    || material.origin.messageId.trim().length === 0 || material.origin.hash.length === 0
    || material.bodyHash !== createHash('sha256').update(material.body).digest('hex')
    || !consumeAuthenticLocalRestrictionAcceptance(
      actionOwner, acceptance, session, focus.chat, material.origin.messageId, material.origin.hash,
    )) return undefined
  const canonicalRef = `canonical:local-restriction:${createHash('sha256')
    .update(focus.ref).update('\0').update(preservedBoundary.ref).digest('hex')}` as CanonicalStateRef
  const pendingRef = `pending:${createHash('sha256')
    .update(canonicalRef).update('\0').update(focus.ref).update('\0').update(preservedBoundary.ref).digest('hex')}` as PendingCanonicalStateRef
  const preservedFocus: Omit<EstablishedFocusDecision, 'chat'> = Object.freeze({
    kind: 'focus_established', ref: focus.ref, currentMatter: focus.currentMatter,
    latestCorrections: focus.latestCorrections,
  })
  const state: PendingCanonicalState<'local_restriction', LocalRestrictionBoundary> = Object.freeze({
    kind: 'local_restriction', ref: pendingRef, focus: preservedFocus,
    boundary: preservedBoundary,
  })
  const complete: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary> = Object.freeze({
    kind: 'local_restriction_material',
    ref: `material:${createHash('sha256').update(pendingRef).update('\0').update(material.bodyHash).digest('hex')}` as CompleteStateMaterialRef,
    target: focus.chat,
    canonicalState: Object.freeze({
      kind: 'local_restriction', ref: canonicalRef, focus: preservedFocus,
      boundary: preserveActionBoundary(preservedBoundary),
    }),
  })
  return Object.freeze({
    state, canonicalRef, generation, actionOwner, acceptance,
    c06, c02, c20, c21, c22, material: complete,
  })
}

/** Associates one exact owner-issued general handoff with the fixed no-safe family. */
function prepareNoSafeAction(
  preservation: EffectiveStatePreservation,
  authority: CanonicalContextAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  handoff: ActionFactBoundaryStateHandoff,
  c06: C06Result,
  session: Agent['session'],
  material: CanonicalNoSafeActionMaterial,
  generation: number,
): PrivatePendingNoSafeAction | undefined {
  const { c02, c20, c21, c22 } = handoff
  const focus = c02.kind === 'business_result' ? c02.value.value : undefined
  const preservedFocusFact = value(c06)?.value
  const preservedBoundary = value(c20)?.value
  const currentBoundary = value(c21)?.value
  if (focus?.kind !== 'focus_established' || preservedFocusFact !== focus
    || c22.kind !== 'business_result'
    || preservedBoundary?.kind !== 'no_safe_action'
    || currentBoundary?.kind !== 'no_safe_action'
    || handoff.boundary !== preservedBoundary || preservedBoundary !== currentBoundary
    || c22.value.value !== preservedBoundary
    || c02.identity.contract !== 'C02' || c02.identity.subject !== focus.ref
    || c22.identity.contract !== 'C22' || c22.identity.subject !== preservedBoundary.ref
    || acceptedC20Boundaries.get(preservation)?.get(c20) !== preservedBoundary
    || acceptedC21Boundaries.get(authority)?.get(c21) !== currentBoundary
    || preservedBoundary.chat !== focus.chat
    || material.family !== 'no_safe_action'
    || material.origin.messageId !== handoff.origin.messageId || material.origin.hash !== handoff.origin.hash
    || material.origin.messageId.trim().length === 0 || material.origin.hash.length === 0
    || material.bodyHash !== createHash('sha256').update(material.body).digest('hex')
    || !consumeAuthenticNoSafeActionBoundaryStateHandoff(
      actionOwner, handoff, session, focus.chat, material.origin.messageId, material.origin.hash,
    )) return undefined
  const canonicalRef = `canonical:no-safe-action:${createHash('sha256')
    .update(focus.ref).update('\0').update(preservedBoundary.ref).digest('hex')}` as CanonicalStateRef
  const pendingRef = `pending:${createHash('sha256')
    .update(canonicalRef).update('\0').update(focus.ref).update('\0').update(preservedBoundary.ref).digest('hex')}` as PendingCanonicalStateRef
  const preservedFocus: Omit<EstablishedFocusDecision, 'chat'> = Object.freeze({
    kind: 'focus_established', ref: focus.ref, currentMatter: focus.currentMatter,
    latestCorrections: focus.latestCorrections,
  })
  const state: PendingCanonicalState<'no_safe_action', NoSafeActionBoundary> = Object.freeze({
    kind: 'no_safe_action', ref: pendingRef, focus: preservedFocus, boundary: preservedBoundary,
  })
  const complete: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary> = Object.freeze({
    kind: 'no_safe_action_material',
    ref: `material:${createHash('sha256').update(pendingRef).update('\0').update(material.bodyHash).digest('hex')}` as CompleteStateMaterialRef,
    target: focus.chat,
    canonicalState: Object.freeze({
      kind: 'no_safe_action', ref: canonicalRef, focus: preservedFocus,
      boundary: preserveNoSafeActionBoundary(preservedBoundary),
    }),
  })
  return Object.freeze({
    state, canonicalRef, generation, actionOwner, handoff,
    c06, c02, c20, c21, c22, material: complete,
  })
}

function exactRuntimeC28(
  report: C28Result,
  decision: QualifiedCandidateDecision,
): boolean {
  const candidate = decision.candidate
  return report.kind === 'business_result'
    && report.identity.contract === 'C28'
    && report.identity.subject.kind === 'candidate'
    && report.identity.subject.candidate === candidate
    && report.value.kind === 'accepted_for_contract'
    && report.value.value === decision
    && decision.content.kind === 'passed'
    && decision.content.candidate === candidate
    && decision.freshness.kind === 'current'
    && decision.freshness.candidate === candidate
    && decision.freshness.basis === candidate.basis
}

function prepareBackground(
  preservation: EffectiveStatePreservation,
  actionOwner: ActionFactBoundaryAuthority,
  decision: QualifiedCandidateDecision,
  c28: C28Result,
  focus: EstablishedFocusDecision,
  boundary: ActionFactBoundary,
  c06: C06Result,
  c20: C20Result,
  material: CanonicalBackgroundMaterial,
  generation: number,
): PrivatePendingBackground | undefined {
  const candidate = decision.candidate
  const preservedFocus = value(c06)?.value
  const preservedBoundary = value(c20)?.value
  if (!exactRuntimeC28(c28, decision)
    || candidate.target !== focus.chat || boundary.chat !== focus.chat
    || candidate.basis.focus !== focus.ref || candidate.basis.actionFacts !== boundary.ref
    || candidate.formationFocus.kind !== 'focus_established'
    || candidate.formationFocus.ref !== focus.ref
    || candidate.formationFocus.currentMatter !== focus.currentMatter
    || candidate.formationFocus.latestCorrections !== focus.latestCorrections
    || candidate.formationActionBoundary.ref !== boundary.ref
    || !samePreservedActionBoundary(candidate.formationActionBoundary, boundary)
    || candidate.basis.evidence !== candidate.formationEvidence.ref
    || preservedFocus !== focus || preservedBoundary !== boundary
    || acceptedC20Boundaries.get(preservation)?.get(c20) !== boundary
    || expectedActionBoundaryOwners.get(preservation) !== actionOwner
    || material.body !== candidate.background
    || createHash('sha256').update(material.body).digest('hex') !== material.bodyHash
    || !nonemptyString(material.origin.messageId) || !nonemptyString(material.origin.hash)) return undefined
  acceptedC20Boundaries.get(preservation)?.delete(c20)
  const canonicalRef = `canonical:background:${createHash('sha256')
    .update(candidate.ref).update('\0').update(c28.identity.call).digest('hex')}` as CanonicalStateRef
  const pendingRef = `pending:${createHash('sha256')
    .update(canonicalRef).update('\0').update(focus.ref).update('\0').update(boundary.ref).digest('hex')}` as PendingCanonicalStateRef
  const preservedAction = preserveAnyActionBoundary(boundary)
  const preservedFocusProjection: Omit<EstablishedFocusDecision, 'chat'> = Object.freeze({
    kind: 'focus_established', ref: focus.ref,
    currentMatter: focus.currentMatter, latestCorrections: focus.latestCorrections,
  })
  const state: PendingCanonicalState<'background', ActionFactBoundary> = Object.freeze({
    kind: 'background', ref: pendingRef, focus: preservedFocusProjection,
    boundary, candidateRef: candidate.ref, qualification: c28,
  })
  const complete: CompleteStateMaterial<'background', PreservedActionBoundary> = Object.freeze({
    kind: 'background_material',
    ref: `material:${createHash('sha256').update(pendingRef).update('\0').update(material.bodyHash).digest('hex')}` as CompleteStateMaterialRef,
    target: focus.chat,
    canonicalState: Object.freeze({
      kind: 'background', ref: canonicalRef, candidateRef: candidate.ref,
      focus: preservedFocusProjection, boundary: preservedAction,
    }),
  })
  return Object.freeze({
    state, canonicalRef, generation, actionOwner, decision, c28, c06, c20, material: complete,
  })
}

/** Internal conjunction of already-signed facts; it creates no Cnn report. */
function formCurrentContext(pending: PrivatePendingNoFocus, c30: C30Result, c31: C31Result): CurrentContextState | undefined {
    const preserved = value(pending.c06)?.value
    const accepted = value(pending.c07)?.value
    if (preserved?.kind !== 'no_focus' || accepted?.kind !== 'no_focus'
      || preserved.ref !== pending.state.focus.ref || preserved.chat !== pending.state.focus.chat
      || accepted.ref !== pending.state.focus.ref || accepted.chat !== pending.state.focus.chat
      || preserved.latestCorrections !== accepted.latestCorrections
      || accepted.latestCorrections !== pending.state.focus.latestCorrections
      || value(c30)?.state !== pending.state.ref || value(c31)?.state !== pending.state.ref) return undefined
    return {
      kind: 'canonical',
      state: {
        kind: 'no_focus', ref: pending.canonicalRef, target: pending.state.focus.chat,
        focus: { kind: 'no_focus', ref: pending.state.focus.ref, latestCorrections: pending.state.focus.latestCorrections },
      },
    }
}

function formLocalCurrentContext(
  pending: PrivatePendingLocalRestriction,
  c30: C30Result,
  c31: C31Result,
): LocalRestrictionCurrentContextState | undefined {
  const focus = pending.c02.kind === 'business_result' ? pending.c02.value.value : undefined
  const preservedBoundary = value(pending.c20)?.value
  const currentBoundary = value(pending.c21)?.value
  if (focus?.kind !== 'focus_established'
    || preservedBoundary?.kind !== 'local_restriction' || preservedBoundary !== currentBoundary
    || focus.ref !== pending.state.focus.ref || focus.currentMatter !== pending.state.focus.currentMatter
    || focus.latestCorrections !== pending.state.focus.latestCorrections
    || focus.chat !== pending.material.target
    || pending.state.boundary !== preservedBoundary
    || pending.c22.kind !== 'business_result' || pending.c22.value.value !== preservedBoundary
    || value(c30)?.state !== pending.state.ref || value(c31)?.state !== pending.state.ref) return undefined
  return {
    kind: 'canonical',
    state: {
      kind: 'local_restriction', ref: pending.canonicalRef, target: focus.chat,
      focus: pending.state.focus,
      boundary: pending.material.canonicalState.boundary,
    },
  }
}

function formNoSafeCurrentContext(
  pending: PrivatePendingNoSafeAction,
  c30: C30Result,
  c31: C31Result,
): NoSafeActionCurrentContextState | undefined {
  const focus = pending.c02.kind === 'business_result' ? pending.c02.value.value : undefined
  const preservedBoundary = value(pending.c20)?.value
  const currentBoundary = value(pending.c21)?.value
  if (focus?.kind !== 'focus_established'
    || preservedBoundary?.kind !== 'no_safe_action' || preservedBoundary !== currentBoundary
    || focus.ref !== pending.state.focus.ref || focus.currentMatter !== pending.state.focus.currentMatter
    || focus.latestCorrections !== pending.state.focus.latestCorrections
    || focus.chat !== pending.material.target || pending.state.boundary !== preservedBoundary
    || pending.c22.kind !== 'business_result' || pending.c22.value.value !== preservedBoundary
    || value(c30)?.state !== pending.state.ref || value(c31)?.state !== pending.state.ref) return undefined
  return {
    kind: 'canonical',
    state: {
      kind: 'no_safe_action', ref: pending.canonicalRef, target: focus.chat,
      focus: pending.state.focus,
      boundary: pending.material.canonicalState.boundary,
    },
  }
}

function formBackgroundCurrentContext(
  pending: PrivatePendingBackground,
  c30: C30Result,
  c31: C31Result,
): BackgroundCurrentContextState | undefined {
  const candidate = pending.decision.candidate
  const focus = value(pending.c06)?.value
  const boundary = value(pending.c20)?.value
  if (!exactRuntimeC28(pending.c28, pending.decision)
    || focus?.kind !== 'focus_established' || boundary === undefined
    || candidate.ref !== pending.state.candidateRef
    || focus.ref !== pending.state.focus.ref || focus.chat !== pending.material.target
    || focus.currentMatter !== pending.state.focus.currentMatter
    || focus.latestCorrections !== pending.state.focus.latestCorrections
    || pending.state.boundary !== boundary
    || value(c30)?.state !== pending.state.ref || value(c31)?.state !== pending.state.ref) return undefined
  return {
    kind: 'canonical',
    state: {
      kind: 'background', ref: pending.canonicalRef, target: focus.chat,
      candidateRef: candidate.ref, focus: pending.state.focus,
      boundary: pending.material.canonicalState.boundary,
    },
  }
}

interface CanonicalSurfaceState {
  readonly state: RestorablePendingCanonicalState
  readonly canonicalRef: CanonicalStateRef
  readonly generation: number
}
interface VisibleRuntime {
  readonly session: Agent['session']
  readonly pending: CanonicalSurfaceState
  readonly message: UserMessage
  readonly seq: number
  readonly phase: 'current' | 'finalized'
  readonly material: Pick<CanonicalNoFocusMaterial, 'body' | 'bodyHash'>
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly retained?: true
}

function replaceSurface(
  session: Agent['session'],
  pending: PrivatePendingNoFocus | PrivatePendingLocalRestriction | PrivatePendingNoSafeAction | PrivatePendingBackground,
  message: UserMessage,
): number {
  const sources = [...session.surface.nodes]
  if (sources.length === 0) {
    if (pending.state.kind !== 'background') throw new Error('canonical state has no surface to replace')
    return session.append('user/message', message, { surfaceOp: 'append' }).seq
  }
  if ((message.source.kind !== 'context-manager-canonical'
      && message.source.kind !== 'context-manager-local-restriction'
      && message.source.kind !== 'context-manager-no-safe-action')
    || message.source.pendingStateRef !== pending.state.ref
    || message.source.canonicalStateRef !== pending.canonicalRef
    || message.source.generation !== pending.generation) {
    throw new Error('canonical replacement does not carry the pending identity')
  }
  return session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: sources[0]!, end: sources.at(-1)! }, sourceEventSeqs: sources,
  }).seq
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((item, index) => item === right[index])
}

function nonemptyString(value: string): boolean {
  return value.trim().length > 0
}

function validStringList(value: readonly string[], nonempty = false): boolean {
  return (!nonempty || value.length > 0) && value.every(nonemptyString)
}

function validRequiredFacts(required: LocalRestrictionBoundary['requiredFacts']): boolean {
  return nonemptyString(required.ref) && required.requirements.every(requirement =>
    nonemptyString(requirement.fact) && validStringList(requirement.neededFor, true))
}

function validUsableFact(fact: UsableFact): boolean {
  return nonemptyString(fact.fact) && nonemptyString(fact.meaning) && nonemptyString(fact.source)
    && fact.degree === 'established'
    && (fact.kind === 'direct_fact' || fact.kind === 'inherited_fact'
      && nonemptyString(fact.inheritedFrom.sourceChat)
      && nonemptyString(fact.inheritedFrom.sourceCanonicalState))
}

function validUnresolvedFact(fact: UnresolvedFact): boolean {
  return nonemptyString(fact.fact) && nonemptyString(fact.meaning) && nonemptyString(fact.source)
    && nonemptyString(fact.affected)
    && (fact.degree === 'insufficient' || fact.degree === 'conflicting' || fact.degree === 'unknown')
}

function completeActionFactBoundary(boundary: ActionFactBoundary): boolean {
  const common = nonemptyString(boundary.ref) && nonemptyString(boundary.chat)
    && validRequiredFacts(boundary.requiredFacts)
    && boundary.usableFacts.every(validUsableFact)
    && boundary.unresolvedFacts.every(validUnresolvedFact)
    && validStringList(boundary.preciselyBlockedActions)
    && validStringList(boundary.safelyContinuableActions)
  if (!common) return false
  if (boundary.kind === 'actionable') {
    return boundary.preciselyBlockedActions.length === 0
      && boundary.safelyContinuableActions.length > 0
  }
  if (boundary.kind === 'local_restriction') {
    return boundary.preciselyBlockedActions.length > 0
      && boundary.safelyContinuableActions.length > 0
  }
  return boundary.kind === 'no_safe_action'
    && boundary.preciselyBlockedActions.length > 0
    && boundary.safelyContinuableActions.length === 0
}

function preserveActionBoundary(boundary: LocalRestrictionBoundary): PreservedLocalRestrictionBoundary {
  return Object.freeze({
    kind: 'local_restriction',
    ref: boundary.ref,
    requiredFacts: Object.freeze({
      ref: boundary.requiredFacts.ref,
      requirements: Object.freeze(boundary.requiredFacts.requirements.map(requirement => Object.freeze({
        fact: requirement.fact,
        neededFor: Object.freeze([...requirement.neededFor]) as typeof requirement.neededFor,
      }))),
    }),
    usableFacts: Object.freeze(boundary.usableFacts.map(fact => fact.kind === 'direct_fact'
      ? Object.freeze({ ...fact })
      : Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) }))),
    unresolvedFacts: Object.freeze(boundary.unresolvedFacts.map(fact => Object.freeze({ ...fact }))),
    preciselyBlockedActions: Object.freeze([...boundary.preciselyBlockedActions]) as typeof boundary.preciselyBlockedActions,
    safelyContinuableActions: Object.freeze([...boundary.safelyContinuableActions]) as typeof boundary.safelyContinuableActions,
  })
}

function preserveNoSafeActionBoundary(boundary: NoSafeActionBoundary): PreservedNoSafeActionBoundary {
  return Object.freeze({
    kind: 'no_safe_action',
    ref: boundary.ref,
    requiredFacts: Object.freeze({
      ref: boundary.requiredFacts.ref,
      requirements: Object.freeze(boundary.requiredFacts.requirements.map(requirement => Object.freeze({
        fact: requirement.fact,
        neededFor: Object.freeze([...requirement.neededFor]) as typeof requirement.neededFor,
      }))),
    }),
    usableFacts: Object.freeze(boundary.usableFacts.map(fact => fact.kind === 'direct_fact'
      ? Object.freeze({ ...fact })
      : Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) }))),
    unresolvedFacts: Object.freeze(boundary.unresolvedFacts.map(fact => Object.freeze({ ...fact }))),
    preciselyBlockedActions: Object.freeze([...boundary.preciselyBlockedActions]) as typeof boundary.preciselyBlockedActions,
    safelyContinuableActions: Object.freeze([] as const),
  })
}

function preserveAnyActionBoundary(boundary: ActionFactBoundary): PreservedActionBoundary {
  const common = {
    kind: boundary.kind,
    ref: boundary.ref,
    requiredFacts: Object.freeze({
      ref: boundary.requiredFacts.ref,
      requirements: Object.freeze(boundary.requiredFacts.requirements.map(requirement => Object.freeze({
        fact: requirement.fact,
        neededFor: Object.freeze([...requirement.neededFor]) as typeof requirement.neededFor,
      }))),
    }),
    usableFacts: Object.freeze(boundary.usableFacts.map(fact => fact.kind === 'direct_fact'
      ? Object.freeze({ ...fact })
      : Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) }))),
    unresolvedFacts: Object.freeze(boundary.unresolvedFacts.map(fact => Object.freeze({ ...fact }))),
    preciselyBlockedActions: Object.freeze([...boundary.preciselyBlockedActions]),
    safelyContinuableActions: Object.freeze([...boundary.safelyContinuableActions]),
  }
  return Object.freeze(common) as PreservedActionBoundary
}

function sameRequirements(
  actual: LocalRestrictionBoundary['requiredFacts'],
  expected: LocalRestrictionBoundary['requiredFacts'],
): boolean {
  return actual.ref === expected.ref && actual.requirements.length === expected.requirements.length
    && actual.requirements.every((requirement, index) => {
      const other = expected.requirements[index]
      return other !== undefined && requirement.fact === other.fact
        && sameStrings(requirement.neededFor, other.neededFor)
    })
}

function sameUsableFacts(actual: readonly UsableFact[], expected: readonly UsableFact[]): boolean {
  return actual.length === expected.length && actual.every((fact, index) => {
    const other = expected[index]
    if (other === undefined || fact.kind !== other.kind || fact.fact !== other.fact
      || fact.meaning !== other.meaning || fact.source !== other.source || fact.degree !== other.degree) return false
    return fact.kind === 'direct_fact' || other.kind === 'inherited_fact'
      && fact.inheritedFrom.sourceChat === other.inheritedFrom.sourceChat
      && fact.inheritedFrom.sourceCanonicalState === other.inheritedFrom.sourceCanonicalState
  })
}

function sameUnresolvedFacts(actual: readonly UnresolvedFact[], expected: readonly UnresolvedFact[]): boolean {
  return actual.length === expected.length && actual.every((fact, index) => {
    const other = expected[index]
    return other !== undefined && fact.fact === other.fact && fact.meaning === other.meaning
      && fact.source === other.source && fact.degree === other.degree && fact.affected === other.affected
  })
}

function samePreservedActionBoundary(
  actual: PreservedActionBoundary | CandidateEnvelope['formationActionBoundary'] | ActionFactBoundary,
  expected: PreservedActionBoundary | CandidateEnvelope['formationActionBoundary'] | ActionFactBoundary,
): boolean {
  return actual.kind === expected.kind
    && actual.ref === expected.ref
    && sameRequirements(actual.requiredFacts, expected.requiredFacts)
    && sameUsableFacts(actual.usableFacts, expected.usableFacts)
    && sameUnresolvedFacts(actual.unresolvedFacts, expected.unresolvedFacts)
    && sameStrings(actual.preciselyBlockedActions, expected.preciselyBlockedActions)
    && sameStrings(actual.safelyContinuableActions, expected.safelyContinuableActions)
}

function canonicalSourceMatches(
  source: UserMessage['source'],
  pending: CanonicalSurfaceState,
  phase: 'current' | 'finalized',
  close: { readonly messageId: string; readonly hash: string },
): boolean {
  const rawSource = object(source)
  const rawMachine = rawSource === undefined ? undefined : object(rawSource.machine)
  if (rawSource === undefined || rawMachine === undefined
    || !hasOnlyKeys(rawSource, ['kind', 'phase', 'pendingStateRef', 'canonicalStateRef', 'generation', 'chat', 'bodyHash', 'machine'])) return false
  if (rawSource.phase !== phase || rawSource.pendingStateRef !== pending.state.ref
    || rawSource.canonicalStateRef !== pending.canonicalRef || rawSource.generation !== pending.generation) return false
  if (pending.state.kind === 'no_focus') {
    return source.kind === 'context-manager-canonical'
      && hasOnlyKeys(rawMachine, ['kind', 'focusRef', 'latestCorrections', 'closeMessageId', 'closeHash'])
      && source.chat === pending.state.focus.chat
      && source.machine.kind === 'no_focus'
      && source.machine.focusRef === pending.state.focus.ref
      && source.machine.latestCorrections === pending.state.focus.latestCorrections
      && source.machine.closeMessageId === close.messageId
      && source.machine.closeHash === close.hash
  }
  if (pending.state.kind === 'background') {
    return rawSource.kind === 'context-manager-canonical'
      && hasOnlyKeys(rawMachine, ['kind', 'candidateRef', 'focusRef', 'currentMatter', 'latestCorrections',
        'boundaryRef', 'evidenceRef', 'originMessageId', 'originHash'])
      && rawSource.chat === pending.state.boundary.chat
      && rawMachine.kind === 'background'
      && rawMachine.candidateRef === pending.state.candidateRef
      && rawMachine.focusRef === pending.state.focus.ref
      && rawMachine.currentMatter === pending.state.focus.currentMatter
      && rawMachine.latestCorrections === pending.state.focus.latestCorrections
      && rawMachine.boundaryRef === pending.state.boundary.ref
      && rawMachine.originMessageId === close.messageId
      && rawMachine.originHash === close.hash
  }
  const boundary = pending.state.boundary
  const expectedKind = pending.state.kind
  const expectedSource = expectedKind === 'local_restriction'
    ? 'context-manager-local-restriction' : 'context-manager-no-safe-action'
  return source.kind === expectedSource
    && hasOnlyKeys(rawMachine, ['kind', 'focusRef', 'currentMatter', 'latestCorrections', 'boundaryRef',
      'requiredFacts', 'usableFacts', 'unresolvedFacts', 'preciselyBlockedActions',
      'safelyContinuableActions', 'originMessageId', 'originHash'])
    && source.chat === boundary.chat
    && source.machine.kind === expectedKind
    && source.machine.focusRef === pending.state.focus.ref
    && source.machine.currentMatter === pending.state.focus.currentMatter
    && source.machine.latestCorrections === pending.state.focus.latestCorrections
    && source.machine.boundaryRef === boundary.ref
    && sameRequirements(source.machine.requiredFacts, boundary.requiredFacts)
    && sameUsableFacts(source.machine.usableFacts, boundary.usableFacts)
    && sameUnresolvedFacts(source.machine.unresolvedFacts, boundary.unresolvedFacts)
    && sameStrings(source.machine.preciselyBlockedActions, boundary.preciselyBlockedActions)
    && sameStrings(source.machine.safelyContinuableActions, boundary.safelyContinuableActions)
    && source.machine.originMessageId === close.messageId
    && source.machine.originHash === close.hash
}

/** External surface port. Its runtime binding stays private to this module. */
export class UniqueVisibleContextReplacement {
  constructor(private readonly runtime: () => VisibleRuntime | undefined) {}
  replaceVisibleContext(state: RestorablePendingCanonicalState): C31Result {
    const runtime = this.runtime()
    if (runtime === undefined || runtime.pending.state.ref !== state.ref) return rejected('C31', state.ref)
    const { session, pending, message, seq, phase, material, close } = runtime
    const derived = session.deriveMessages()
    const only = derived[0]
    const text = only?.content.length === 1 && only.content[0]?.type === 'text'
      ? only.content[0].text : undefined
    const bodyHash = text === undefined ? undefined : createHash('sha256').update(text).digest('hex')
    if (derived.length !== 1 || only?.id !== message.id
      || (only.source.kind !== 'context-manager-canonical'
        && only.source.kind !== 'context-manager-local-restriction'
        && only.source.kind !== 'context-manager-no-safe-action')
      || !canonicalSourceMatches(only.source, pending, phase, close)
      || text !== material.body || bodyHash !== material.bodyHash || only.source.bodyHash !== bodyHash
      || !session.events.some(event => event.seq === seq && event.type === 'user/message' && event.data.id === message.id)) {
      return rejected('C31', pending.state.ref)
    }
    return {
      kind: 'business_result', identity: call('C31', pending.state.ref),
      value: runtime.retained === true
        ? {
            kind: 'same_state_already_uniquely_visible',
            state: pending.state.ref,
            proof: `visible:${crypto.randomUUID()}` as UniqueVisibleStateProofRef,
          }
        : { kind: 'uniquely_replaced', state: pending.state.ref },
    }
  }
}

/** Ordinary sidecar save only: C33 has no Session or visible-surface power. */
export class StatePersistence {
  constructor(
    private readonly saveBound: (material: RestorableCompleteStateMaterial) => Promise<void>,
    private readonly expected: RestorableCompleteStateMaterial,
  ) {}
  async saveCompleteState(material: RestorableCompleteStateMaterial): Promise<C33Result> {
    if (!sameCompleteStateMaterial(material, this.expected)) {
      throw new Error('C33 material is not the exact complete state material')
    }
    await this.saveBound(material)
    return {
      kind: 'business_result', identity: call('C33', material.ref),
      value: { kind: 'saved', material: material.ref },
    }
  }
}

const statePersistenceCapabilities = new WeakMap<StatePersistence, (material: RestorableCompleteStateMaterial) => Promise<C33Result>>()
function statePersistenceCapability(persistence: StatePersistence): (material: RestorableCompleteStateMaterial) => Promise<C33Result> {
  const existing = statePersistenceCapabilities.get(persistence)
  if (existing !== undefined) return existing
  const capability = async (material: RestorableCompleteStateMaterial): Promise<C33Result> => await persistence.saveCompleteState(material)
  statePersistenceCapabilities.set(persistence, capability)
  return capability
}

function sameCompleteStateMaterial(actual: RestorableCompleteStateMaterial, expected: RestorableCompleteStateMaterial): boolean {
  const actualState = actual.canonicalState
  const expectedState = expected.canonicalState
  if (actual.kind !== expected.kind || actualState.kind !== expectedState.kind) return false
  const sameBase = actual.ref === expected.ref
    && actual.target === expected.target
    && actualState.ref === expectedState.ref
    && actualState.focus.kind === expectedState.focus.kind
    && actualState.focus.ref === expectedState.focus.ref
    && actualState.focus.latestCorrections === expectedState.focus.latestCorrections
    && !Object.prototype.hasOwnProperty.call(actualState, 'target')
    && !Object.prototype.hasOwnProperty.call(expectedState, 'target')
  if (!sameBase) return false
  if (actual.kind === 'no_focus_material' && expected.kind === 'no_focus_material') return true
  if (actual.kind === 'background_material' && expected.kind === 'background_material'
    && actualState.kind === 'background' && expectedState.kind === 'background') {
    return actualState.candidateRef === expectedState.candidateRef
      && actualState.focus.currentMatter === expectedState.focus.currentMatter
      && samePreservedActionBoundary(actualState.boundary, expectedState.boundary)
  }
  if ((actual.kind !== 'local_restriction_material' && actual.kind !== 'no_safe_action_material')
    || actual.kind !== expected.kind
    || (actualState.kind !== 'local_restriction' && actualState.kind !== 'no_safe_action')
    || actualState.kind !== expectedState.kind) return false
  return actualState.focus.currentMatter === expectedState.focus.currentMatter
    && samePreservedActionBoundary(actualState.boundary, expectedState.boundary)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textMessage(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.content.length !== 1) return undefined
  const content = event.data.content[0]
  return content?.type === 'text' ? content.text : undefined
}

function storedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recoveryFailureTarget(
  session: Agent['session'], preservation: EffectiveStatePreservation, owner: FocusAuthority | undefined,
): ChatRef {
  if (owner === undefined) throw new Error('C34 recovery owner is not bound')
  const sessionId = String(session.id)
  if (sessionId.trim().length === 0) throw new Error('C34 recovery has no nonblank session identity')
  const token = Object.freeze({})
  verifiedRecoveryFailureBridges.set(token, { preservation, owner, token, session, sessionId })
  const target = rehydrateRecoveryFailureTarget(owner, token, session, sessionId)
  verifiedRecoveryFailureBridges.delete(token)
  if (target === undefined) throw new Error('C34 recovery has no valid chat identity')
  return target
}

function hasNoFocusFragments(record: unknown): boolean {
  const value = object(record)
  if (value === undefined) return false
  const closure = object(value.closure)
  const transaction = object(value.transaction)
  const decision = closure === undefined ? undefined : object(closure.decision)
  return decision?.kind === 'no_focus'
    || transaction?.phase === 'pending' || transaction?.phase === 'current' || transaction?.phase === 'finalized'
    || object(transaction?.machine)?.kind === 'no_focus'
}

function hasExpectedNoFocusWithoutMaterial(session: Agent['session']): boolean {
  const closeCount = session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && textMessage(event) === '这件事结束了').length
  const canonicalCount = session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-canonical').length
  return closeCount === 1 && canonicalCount === 0
}

function acceptedNoFocusReport(
  report: unknown,
  code: 'C06' | 'C07',
  ref: string,
  chat: string,
  corrections: string,
): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const accepted = value === undefined ? undefined : object(value.value)
  const focus = accepted === undefined ? undefined : object(accepted.value)
  return value?.kind === 'business_result'
    && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === code
    && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined
    && identity?.subject === ref
    && accepted?.kind === 'accepted_for_contract'
    && hasOnlyKeys(accepted, ['kind', 'value'])
    && focus?.kind === 'no_focus'
    && hasOnlyKeys(focus, ['kind', 'ref', 'chat', 'latestCorrections'])
    && focus.ref === ref
    && focus.chat === chat
    && focus.latestCorrections === corrections
}

function acceptedEligibleC29(report: unknown, pendingRef: string): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const eligibility = value === undefined ? undefined : object(value.value)
  return value?.kind === 'business_result'
    && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C29'
    && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined
    && identity?.subject === pendingRef
    && eligibility?.kind === 'eligible'
    && hasOnlyKeys(eligibility, ['kind', 'state'])
    && eligibility.state === pendingRef
}

function exactC33(report: unknown, materialRef: string): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const saved = value === undefined ? undefined : object(value.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C33' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === materialRef
    && saved?.kind === 'saved' && hasOnlyKeys(saved, ['kind', 'material']) && saved.material === materialRef
}
function exactC30(report: unknown, pendingRef: string): boolean {
  const value = object(report); const identity = value === undefined ? undefined : object(value.identity); const result = value === undefined ? undefined : object(value.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C30' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === pendingRef
    && result?.kind === 'established' && hasOnlyKeys(result, ['kind', 'state']) && result.state === pendingRef
}
function exactC31(report: unknown, pendingRef: string): boolean {
  const value = object(report); const identity = value === undefined ? undefined : object(value.identity); const result = value === undefined ? undefined : object(value.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C31' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === pendingRef
    && result?.kind === 'uniquely_replaced' && hasOnlyKeys(result, ['kind', 'state']) && result.state === pendingRef
}
function exactC32(report: unknown, canonicalRef: string, chat: string, ref: string, corrections: string): boolean {
  const value = object(report); const identity = value === undefined ? undefined : object(value.identity); const subject = identity === undefined ? undefined : object(identity.subject)
  const accepted = value === undefined ? undefined : object(value.value); const state = accepted === undefined ? undefined : object(accepted.state); const canonical = state === undefined ? undefined : object(state.state)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C32' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined
    && subject?.kind === 'canonical_state' && hasOnlyKeys(subject, ['kind', 'state']) && subject.state === canonicalRef
    && accepted?.kind === 'current_context_accepted' && hasOnlyKeys(accepted, ['kind', 'state'])
    && state?.kind === 'canonical' && hasOnlyKeys(state, ['kind', 'state'])
    && canonical?.kind === 'no_focus' && hasOnlyKeys(canonical, ['kind', 'ref', 'target', 'focus'])
    && canonical.ref === canonicalRef && canonical.target === chat
    && focus?.kind === 'no_focus' && hasOnlyKeys(focus, ['kind', 'ref', 'latestCorrections'])
    && focus.ref === ref && focus.latestCorrections === corrections
}

interface RawPreservedActionBoundary {
  readonly kind: ActionFactBoundary['kind']
  readonly ref: string
  readonly requiredFacts: {
    readonly ref: string
    readonly requirements: readonly { readonly fact: string; readonly neededFor: readonly string[] }[]
  }
  readonly usableFacts: readonly ({ readonly kind: 'direct_fact'; readonly fact: string; readonly meaning: string; readonly source: string; readonly degree: 'established' }
    | { readonly kind: 'inherited_fact'; readonly fact: string; readonly meaning: string; readonly source: string; readonly degree: 'established'; readonly inheritedFrom: { readonly sourceChat: string; readonly sourceCanonicalState: string } })[]
  readonly unresolvedFacts: readonly { readonly fact: string; readonly meaning: string; readonly source: string; readonly degree: 'insufficient' | 'conflicting' | 'unknown'; readonly affected: string }[]
  readonly preciselyBlockedActions: readonly string[]
  readonly safelyContinuableActions: readonly string[]
}

function exactActionC32(
  report: unknown,
  canonicalRef: string,
  chat: string,
  ref: string,
  currentMatter: string,
  corrections: string,
  boundary: RawPreservedActionBoundary,
  family: 'local_restriction' | 'no_safe_action',
): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const subject = identity === undefined ? undefined : object(identity.subject)
  const accepted = value === undefined ? undefined : object(value.value)
  const state = accepted === undefined ? undefined : object(accepted.state)
  const canonical = state === undefined ? undefined : object(state.state)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const storedBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C32' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined
    && subject?.kind === 'canonical_state' && hasOnlyKeys(subject, ['kind', 'state']) && subject.state === canonicalRef
    && accepted?.kind === 'current_context_accepted' && hasOnlyKeys(accepted, ['kind', 'state'])
    && state?.kind === 'canonical' && hasOnlyKeys(state, ['kind', 'state'])
    && canonical?.kind === family && hasOnlyKeys(canonical, ['kind', 'ref', 'target', 'focus', 'boundary'])
    && canonical.ref === canonicalRef && canonical.target === chat
    && focus?.kind === 'focus_established' && hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])
    && focus.ref === ref
    && focus.currentMatter === currentMatter && focus.latestCorrections === corrections
    && storedBoundary !== undefined && rawBoundaryMatchesProof(storedBoundary, boundary, false)
}

function exactLocalC32(
  report: unknown, canonicalRef: string, chat: string, ref: string,
  currentMatter: string, corrections: string, boundary: RawPreservedActionBoundary,
): boolean {
  return exactActionC32(report, canonicalRef, chat, ref, currentMatter, corrections, boundary, 'local_restriction')
}

function exactNoSafeC32(
  report: unknown, canonicalRef: string, chat: string, ref: string,
  currentMatter: string, corrections: string, boundary: RawPreservedActionBoundary,
): boolean {
  return exactActionC32(report, canonicalRef, chat, ref, currentMatter, corrections, boundary, 'no_safe_action')
}

function exactBackgroundC32(
  report: unknown,
  canonicalRef: string,
  chat: string,
  candidateRef: string,
  ref: string,
  currentMatter: string,
  corrections: string,
  boundary: RawPreservedActionBoundary,
): boolean {
  const raw = object(report)
  const identity = raw === undefined ? undefined : object(raw.identity)
  const subject = identity === undefined ? undefined : object(identity.subject)
  const accepted = raw === undefined ? undefined : object(raw.value)
  const state = accepted === undefined ? undefined : object(accepted.state)
  const canonical = state === undefined ? undefined : object(state.state)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const storedBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  return raw?.kind === 'business_result' && hasOnlyKeys(raw, ['kind', 'identity', 'value'])
    && identity?.contract === 'C32' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined
    && subject?.kind === 'canonical_state' && hasOnlyKeys(subject, ['kind', 'state'])
    && subject.state === canonicalRef
    && accepted?.kind === 'current_context_accepted' && hasOnlyKeys(accepted, ['kind', 'state'])
    && state?.kind === 'canonical' && hasOnlyKeys(state, ['kind', 'state'])
    && canonical?.kind === 'background'
    && hasOnlyKeys(canonical, ['kind', 'ref', 'target', 'candidateRef', 'focus', 'boundary'])
    && canonical.ref === canonicalRef && canonical.target === chat && canonical.candidateRef === candidateRef
    && focus?.kind === 'focus_established'
    && hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])
    && focus.ref === ref && focus.currentMatter === currentMatter && focus.latestCorrections === corrections
    && storedBoundary !== undefined && rawBoundaryMatchesProof(storedBoundary, boundary, false)
}

interface DecodedBackgroundQualification {
  readonly decision: QualifiedCandidateDecision
  readonly c28: C28Result
}

function decodeBackgroundQualification(
  report: unknown,
  candidateRef: string,
  chat: string,
  focusRef: string,
  currentMatter: string,
  corrections: string,
  boundary: RawPreservedActionBoundary,
  evidenceRef: string,
  body: string,
): DecodedBackgroundQualification | undefined {
  const raw = object(report)
  const identity = raw === undefined ? undefined : object(raw.identity)
  const subject = identity === undefined ? undefined : object(identity.subject)
  const accepted = raw === undefined ? undefined : object(raw.value)
  const decisionRaw = accepted === undefined ? undefined : object(accepted.value)
  const candidateRaw = decisionRaw === undefined ? undefined : object(decisionRaw.candidate)
  const subjectCandidate = subject === undefined ? undefined : object(subject.candidate)
  const contentRaw = decisionRaw === undefined ? undefined : object(decisionRaw.content)
  const contentCandidate = contentRaw === undefined ? undefined : object(contentRaw.candidate)
  const freshnessRaw = decisionRaw === undefined ? undefined : object(decisionRaw.freshness)
  const freshnessCandidate = freshnessRaw === undefined ? undefined : object(freshnessRaw.candidate)
  const basis = candidateRaw === undefined ? undefined : object(candidateRaw.basis)
  const formationFocus = candidateRaw === undefined ? undefined : object(candidateRaw.formationFocus)
  const formationAction = candidateRaw === undefined ? undefined : object(candidateRaw.formationActionBoundary)
  const formationEvidence = candidateRaw === undefined ? undefined : object(candidateRaw.formationEvidence)
  if (raw === undefined || identity === undefined || subject === undefined || accepted === undefined
    || decisionRaw === undefined || candidateRaw === undefined || subjectCandidate === undefined
    || contentRaw === undefined || contentCandidate === undefined || freshnessRaw === undefined
    || freshnessCandidate === undefined || basis === undefined || formationFocus === undefined
    || formationAction === undefined || formationEvidence === undefined
    || raw.kind !== 'business_result' || !hasOnlyKeys(raw, ['kind', 'identity', 'value'])
    || identity.contract !== 'C28' || !hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    || storedString(identity, 'call') === undefined
    || subject.kind !== 'candidate' || !hasOnlyKeys(subject, ['kind', 'candidate'])
    || accepted.kind !== 'accepted_for_contract' || !hasOnlyKeys(accepted, ['kind', 'value'])
    || decisionRaw.kind !== 'qualified'
    || !hasOnlyKeys(decisionRaw, ['kind', 'candidate', 'content', 'freshness'])
    || contentRaw.kind !== 'passed' || !hasOnlyKeys(contentRaw, ['kind', 'candidate'])
    || freshnessRaw.kind !== 'current' || !hasOnlyKeys(freshnessRaw, ['kind', 'candidate', 'basis'])
    || !hasOnlyKeys(candidateRaw, ['ref', 'target', 'background', 'actionableFacts', 'uncertainties',
      'knownFutureCriticalPoints', 'basis', 'formationFocus', 'formationActionBoundary', 'formationEvidence'])
    || candidateRaw.ref !== candidateRef || candidateRaw.target !== chat || candidateRaw.background !== body
    || basis.focus !== focusRef || basis.actionFacts !== boundary.ref || basis.evidence !== evidenceRef
    || formationFocus.kind !== 'focus_established' || formationFocus.ref !== focusRef
    || formationFocus.currentMatter !== currentMatter || formationFocus.latestCorrections !== corrections
    || formationAction.ref !== boundary.ref || !rawBoundaryMatchesProof(formationAction, boundary, false)
    || formationEvidence.ref !== evidenceRef
    || JSON.stringify(subjectCandidate) !== JSON.stringify(candidateRaw)
    || JSON.stringify(contentCandidate) !== JSON.stringify(candidateRaw)
    || JSON.stringify(freshnessCandidate) !== JSON.stringify(candidateRaw)
    || JSON.stringify(freshnessRaw.basis) !== JSON.stringify(basis)) return undefined
  const candidate = candidateRaw as unknown as CandidateEnvelope
  const decision: QualifiedCandidateDecision = Object.freeze({
    kind: 'qualified', candidate,
    content: Object.freeze({ kind: 'passed', candidate }),
    freshness: Object.freeze({ kind: 'current', candidate, basis: candidate.basis }),
  })
  const subjectValue = Object.freeze({ kind: 'candidate' as const, candidate })
  const c28: C28Result = Object.freeze({
    kind: 'business_result',
    identity: Object.freeze({
      contract: 'C28' as const,
      call: identity.call as ContractCallRef,
      subject: subjectValue,
    }),
    value: Object.freeze({ kind: 'accepted_for_contract' as const, value: decision }),
  })
  return Object.freeze({ decision, c28 })
}

function acceptedLocalBoundaryReport(
  report: unknown,
  code: 'C20' | 'C21',
  chat: string,
  boundary: RawPreservedActionBoundary,
): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const accepted = value === undefined ? undefined : object(value.value)
  const stored = accepted === undefined ? undefined : object(accepted.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === code && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === boundary.ref
    && accepted?.kind === 'accepted_for_contract' && hasOnlyKeys(accepted, ['kind', 'value'])
    && stored !== undefined && rawBoundaryMatchesProof(stored, boundary, true, chat)
}

function acceptedLocalC22Report(
  report: unknown,
  chat: string,
  boundary: RawPreservedActionBoundary,
): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const accepted = value === undefined ? undefined : object(value.value)
  const stored = accepted === undefined ? undefined : object(accepted.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === 'C22' && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === boundary.ref
    && accepted?.kind === 'accepted_for_contract' && hasOnlyKeys(accepted, ['kind', 'value'])
    && stored !== undefined && rawBoundaryMatchesProof(stored, boundary, true, chat)
}

function exactEstablishedFocusReport(
  report: unknown,
  code: 'C02' | 'C06',
  ref: string,
  chat: string,
  currentMatter: string,
  corrections: string,
): boolean {
  const value = object(report)
  const identity = value === undefined ? undefined : object(value.identity)
  const accepted = value === undefined ? undefined : object(value.value)
  const focus = accepted === undefined ? undefined : object(accepted.value)
  return value?.kind === 'business_result' && hasOnlyKeys(value, ['kind', 'identity', 'value'])
    && identity?.contract === code && hasOnlyKeys(identity, ['contract', 'call', 'subject'])
    && storedString(identity, 'call') !== undefined && identity.subject === ref
    && accepted?.kind === 'accepted_for_contract' && hasOnlyKeys(accepted, ['kind', 'value'])
    && focus?.kind === 'focus_established'
    && hasOnlyKeys(focus, ['kind', 'ref', 'chat', 'currentMatter', 'latestCorrections'])
    && focus.ref === ref && focus.chat === chat
    && focus.currentMatter === currentMatter && focus.latestCorrections === corrections
}

function rawStringArray(value: unknown, nonempty = true): readonly string[] | undefined {
  return Array.isArray(value) && (!nonempty || value.length > 0)
    && value.every(item => typeof item === 'string' && item.trim().length > 0) ? value : undefined
}

function rawRequirements(value: unknown): RawPreservedActionBoundary['requiredFacts'] | undefined {
  const raw = object(value)
  const ref = raw === undefined ? undefined : storedString(raw, 'ref')
  if (raw === undefined || ref === undefined || !hasOnlyKeys(raw, ['ref', 'requirements'])
    || !Array.isArray(raw.requirements)) return undefined
  const requirements: { readonly fact: string; readonly neededFor: readonly string[] }[] = []
  for (const entry of raw.requirements) {
    const requirement = object(entry)
    const fact = requirement === undefined ? undefined : storedString(requirement, 'fact')
    const neededFor = requirement === undefined ? undefined : rawStringArray(requirement.neededFor)
    if (requirement === undefined || !hasOnlyKeys(requirement, ['fact', 'neededFor'])
      || fact === undefined || neededFor === undefined) return undefined
    requirements.push(Object.freeze({ fact, neededFor: Object.freeze([...neededFor]) }))
  }
  return Object.freeze({ ref, requirements: Object.freeze(requirements) })
}

function rawUsableFacts(value: unknown): RawPreservedActionBoundary['usableFacts'] | undefined {
  if (!Array.isArray(value)) return undefined
  const facts: RawPreservedActionBoundary['usableFacts'][number][] = []
  for (const entry of value) {
    const fact = object(entry)
    if (fact === undefined) return undefined
    const factRef = storedString(fact, 'fact'); const meaning = storedString(fact, 'meaning'); const source = storedString(fact, 'source')
    if (factRef === undefined || meaning === undefined || source === undefined || fact.degree !== 'established') return undefined
    if (fact.kind === 'direct_fact') {
      if (!hasOnlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree'])) return undefined
      facts.push(Object.freeze({ kind: 'direct_fact', fact: factRef, meaning, source, degree: 'established' }))
    } else if (fact.kind === 'inherited_fact') {
      const inherited = object(fact.inheritedFrom)
      const sourceChat = inherited === undefined ? undefined : storedString(inherited, 'sourceChat')
      const sourceCanonicalState = inherited === undefined ? undefined : storedString(inherited, 'sourceCanonicalState')
      if (!hasOnlyKeys(fact, ['kind', 'fact', 'meaning', 'source', 'degree', 'inheritedFrom'])
        || inherited === undefined || !hasOnlyKeys(inherited, ['sourceChat', 'sourceCanonicalState'])
        || sourceChat === undefined || sourceCanonicalState === undefined) return undefined
      facts.push(Object.freeze({ kind: 'inherited_fact', fact: factRef, meaning, source, degree: 'established',
        inheritedFrom: Object.freeze({ sourceChat, sourceCanonicalState }) }))
    } else return undefined
  }
  return Object.freeze(facts)
}

function rawUnresolvedFacts(value: unknown): RawPreservedActionBoundary['unresolvedFacts'] | undefined {
  if (!Array.isArray(value)) return undefined
  const facts: RawPreservedActionBoundary['unresolvedFacts'][number][] = []
  for (const entry of value) {
    const fact = object(entry)
    const factRef = fact === undefined ? undefined : storedString(fact, 'fact')
    const meaning = fact === undefined ? undefined : storedString(fact, 'meaning')
    const source = fact === undefined ? undefined : storedString(fact, 'source')
    const affected = fact === undefined ? undefined : storedString(fact, 'affected')
    if (fact === undefined || !hasOnlyKeys(fact, ['fact', 'meaning', 'source', 'degree', 'affected'])
      || factRef === undefined || meaning === undefined || source === undefined || affected === undefined
      || (fact.degree !== 'insufficient' && fact.degree !== 'conflicting' && fact.degree !== 'unknown')) return undefined
    facts.push(Object.freeze({ fact: factRef, meaning, source, degree: fact.degree, affected }))
  }
  return Object.freeze(facts)
}

function sameRawRequirements(actual: RawPreservedActionBoundary['requiredFacts'], expected: RawPreservedActionBoundary['requiredFacts']): boolean {
  return actual.ref === expected.ref && actual.requirements.length === expected.requirements.length
    && actual.requirements.every((requirement, index) => requirement.fact === expected.requirements[index]?.fact
      && sameStrings(requirement.neededFor, expected.requirements[index]?.neededFor ?? []))
}
function sameRawUsable(actual: RawPreservedActionBoundary['usableFacts'], expected: RawPreservedActionBoundary['usableFacts']): boolean {
  return actual.length === expected.length && actual.every((fact, index) => {
    const other = expected[index]
    if (other === undefined || fact.kind !== other.kind || fact.fact !== other.fact || fact.meaning !== other.meaning
      || fact.source !== other.source || fact.degree !== other.degree) return false
    return fact.kind === 'direct_fact' || other.kind === 'inherited_fact'
      && fact.inheritedFrom.sourceChat === other.inheritedFrom.sourceChat
      && fact.inheritedFrom.sourceCanonicalState === other.inheritedFrom.sourceCanonicalState
  })
}
function sameRawUnresolved(actual: RawPreservedActionBoundary['unresolvedFacts'], expected: RawPreservedActionBoundary['unresolvedFacts']): boolean {
  return actual.length === expected.length && actual.every((fact, index) => {
    const other = expected[index]
    return other !== undefined && fact.fact === other.fact && fact.meaning === other.meaning && fact.source === other.source
      && fact.degree === other.degree && fact.affected === other.affected
  })
}

function rawPreservedActionBoundary(
  raw: Record<string, unknown>,
  family: ActionFactBoundary['kind'] = 'local_restriction',
): RawPreservedActionBoundary | undefined {
  const requiredFacts = rawRequirements(raw.requiredFacts)
  const usable = rawUsableFacts(raw.usableFacts)
  const unresolved = rawUnresolvedFacts(raw.unresolvedFacts)
  const blocked = rawStringArray(raw.preciselyBlockedActions, family !== 'actionable')
  const safe = rawStringArray(raw.safelyContinuableActions, family !== 'no_safe_action')
  const ref = storedString(raw, 'ref')
  if (!hasOnlyKeys(raw, ['kind', 'ref', 'requiredFacts', 'usableFacts', 'unresolvedFacts',
    'preciselyBlockedActions', 'safelyContinuableActions'])
    || raw.kind !== family || ref === undefined || requiredFacts === undefined
    || usable === undefined || unresolved === undefined || blocked === undefined || safe === undefined) return undefined
  if (family === 'actionable' && (blocked.length !== 0 || safe.length === 0)
    || family === 'local_restriction' && (blocked.length === 0 || safe.length === 0)
    || family === 'no_safe_action' && (blocked.length === 0 || safe.length !== 0)) return undefined
  return Object.freeze({
    kind: family, ref,
    requiredFacts,
    usableFacts: Object.freeze([...usable]),
    unresolvedFacts: Object.freeze([...unresolved]),
    preciselyBlockedActions: Object.freeze([...blocked]),
    safelyContinuableActions: Object.freeze([...safe]),
  })
}

function rawBoundaryMatchesProof(
  raw: Record<string, unknown>,
  boundary: RawPreservedActionBoundary,
  includeChat: boolean,
  chat?: string,
): boolean {
  const requiredFacts = rawRequirements(raw.requiredFacts)
  const usable = rawUsableFacts(raw.usableFacts)
  const unresolved = rawUnresolvedFacts(raw.unresolvedFacts)
  const blocked = rawStringArray(raw.preciselyBlockedActions, boundary.kind !== 'actionable')
  const safe = rawStringArray(raw.safelyContinuableActions, boundary.kind !== 'no_safe_action')
  const keys = ['kind', 'ref', 'requiredFacts', 'usableFacts', 'unresolvedFacts',
    'preciselyBlockedActions', 'safelyContinuableActions', ...(includeChat ? ['chat'] : [])]
  return hasOnlyKeys(raw, keys) && requiredFacts !== undefined
    && raw.kind === boundary.kind && raw.ref === boundary.ref
    && (!includeChat || raw.chat === chat)
    && usable !== undefined && unresolved !== undefined && blocked !== undefined && safe !== undefined
    && sameRawRequirements(requiredFacts, boundary.requiredFacts)
    && sameRawUsable(usable, boundary.usableFacts)
    && sameRawUnresolved(unresolved, boundary.unresolvedFacts)
    && sameStrings(blocked, boundary.preciselyBlockedActions)
    && sameStrings(safe, boundary.safelyContinuableActions)
}

interface CanonicalEventIdentity {
  readonly pendingRef?: unknown
  readonly canonicalRef?: unknown
  readonly generation?: unknown
}
function canonicalEventMatches(
  event: SessionEvent | undefined,
  phase: 'current' | 'finalized',
  transaction: CanonicalEventIdentity,
  chat: string,
  ref: string,
  corrections: string,
  closeId: string,
  closeHash: string,
  body: string,
  bodyHash: string,
): boolean {
  if (event?.type !== 'user/message' || textMessage(event) !== body) return false
  const source = object(event.data.source)
  const machine = source === undefined ? undefined : object(source.machine)
  return source?.kind === 'context-manager-canonical'
    && source.phase === phase
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === chat
    && source.bodyHash === bodyHash
    && machine?.kind === 'no_focus'
    && machine.focusRef === ref
    && machine.latestCorrections === corrections
    && machine.closeMessageId === closeId
    && machine.closeHash === closeHash
}

/**
 * Full C34 durable proof. This is deliberately private to state preservation:
 * it checks the physically retained close, every sidecar identity link, and
 * the Session material before it performs this module's local brand creation.
 */
function decodeStoredNoFocusMaterial(
  evidence: StoredNoFocusRecoveryEvidence,
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
): StoredNoFocusRecoveryCandidate | undefined {
  const record = object(evidence.record)
  const closure = record === undefined ? undefined : object(record.closure)
  const original = closure === undefined ? undefined : object(closure.original)
  const decision = closure === undefined ? undefined : object(closure.decision)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const material = transaction === undefined ? undefined : object(transaction.material)
  const canonical = material === undefined ? undefined : object(material.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const phase = transaction === undefined ? undefined : transaction.phase
  const closureOnly = record !== undefined && !Object.prototype.hasOwnProperty.call(record, 'focus')
  if (record === undefined || closure === undefined || original === undefined || decision === undefined
    || transaction === undefined || machine === undefined || material === undefined || canonical === undefined || focus === undefined
    || closure.phase !== 'physically_proved'
    || phase !== 'finalized') return undefined
  const closeId = storedString(original, 'messageId')
  const closeHash = storedString(original, 'hash')
  const chat = storedString(decision, 'chat')
  const ref = storedString(decision, 'ref')
  const corrections = typeof decision.latestCorrections === 'string' ? decision.latestCorrections : undefined
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(material, 'ref')
  const generation = transaction.generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return undefined
  const expectedCanonicalRef = ref === undefined ? undefined : `canonical:${ref}`
  const expectedPendingRef = expectedCanonicalRef === undefined || ref === undefined ? undefined : `pending:${createHash('sha256').update(expectedCanonicalRef).update('\0').update(ref).digest('hex')}`
  const expectedMaterialRef = expectedPendingRef === undefined || bodyHash === undefined ? undefined : `material:${createHash('sha256').update(expectedPendingRef).update('\0').update(bodyHash).digest('hex')}`
  if (closeId === undefined || closeHash === undefined || chat === undefined || ref === undefined || corrections === undefined
    || pendingRef === undefined || canonicalRef === undefined || body === undefined || bodyHash === undefined || materialRef === undefined
    || decision.kind !== 'no_focus'
    || machine.kind !== 'no_focus'
    || machine.chat !== chat || machine.focusRef !== ref || machine.latestCorrections !== corrections
    || machine.closeMessageId !== closeId || machine.closeHash !== closeHash
    || material.kind !== 'no_focus_material' || material.target !== chat
    || canonical.kind !== 'no_focus' || canonical.ref !== canonicalRef || Object.prototype.hasOwnProperty.call(canonical, 'target')
    || focus.kind !== 'no_focus' || focus.ref !== ref || focus.latestCorrections !== corrections
    || createHash('sha256').update(body).digest('hex') !== bodyHash
    || canonicalRef !== expectedCanonicalRef || pendingRef !== expectedPendingRef || materialRef !== expectedMaterialRef
    || `no-focus:${createHash('sha256').update(chat).update('\0').update(closeId).update('\0').update(closeHash).digest('hex')}` !== ref
    || !acceptedNoFocusReport(transaction.c06, 'C06', ref, chat, corrections)
    || !acceptedNoFocusReport(transaction.c07, 'C07', ref, chat, corrections)
    || !acceptedEligibleC29(transaction.c29, pendingRef)) return undefined

  const closeEvents = evidence.session.events.filter(
    (event): event is SessionEvent<'user/message'> => event.type === 'user/message' && String(event.data.id) === closeId,
  )
  const close = closeEvents[0]
  const closeText = close === undefined ? undefined : textMessage(close)
  if (closeEvents.length !== 1 || close?.data.source.kind !== 'user' || closeText !== '这件事结束了'
    || createHash('sha256').update(closeId).update('\0').update(closeText).digest('hex') !== closeHash) return undefined
  if (closureOnly) {
    const exactCloseCount = evidence.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && textMessage(event) === '这件事结束了').length
    const hasPreContext = evidence.session.events.some(event => event.seq < close.seq
      && (event.type === 'user/message' || event.type === 'assistant/message'))
    if (!hasOnlyKeys(record, ['closure', 'transaction'])
      || !hasOnlyKeys(closure, ['phase', 'original', 'proposal', 'decision'])
      || generation !== 1 || exactCloseCount !== 1 || !hasPreContext) return undefined
  }

  const firstSeq = transaction.firstReplaceSeq
  const repair = transaction.repair === undefined ? undefined : object(transaction.repair)
  const repairPhase = repair === undefined ? undefined : repair.phase
  const repairTargetId = repair === undefined ? undefined : storedString(repair, 'targetMessageId')
  const repairTargetSeq = repair === undefined ? undefined : repair.targetReplaceSeq
  if (repair !== undefined
    && (repairPhase !== 'repair_pending' && repairPhase !== 'repair_finalized'
      || repairTargetId === undefined
      || repairPhase === 'repair_finalized' && (!Number.isSafeInteger(repairTargetSeq)
        || (repairTargetSeq as number) <= (transaction.finalizedReplaceSeq as number)))) return undefined
  const finalizedSeq = repairPhase === 'repair_finalized' ? repairTargetSeq : transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstSeq) || (firstSeq as number) < 0) return undefined
  const firstEvents = evidence.session.events.filter(event => event.seq === firstSeq)
  const firstId = firstEvents[0]?.type === 'user/message' ? firstEvents[0].data.id : undefined
  if (firstEvents.length !== 1 || firstId === undefined
    || evidence.session.events.filter(event => event.type === 'user/message' && event.data.id === firstId).length !== 1
    || !canonicalEventMatches(firstEvents[0], 'current', transaction, chat, ref, corrections, closeId, closeHash, body, bodyHash)
    || !exactC33(transaction.c33, materialRef) || !exactC30(transaction.c30, pendingRef)
    || !exactC31(transaction.firstC31, pendingRef) || !exactC32(transaction.firstC32, canonicalRef, chat, ref, corrections)) return undefined
  if (!Number.isSafeInteger(finalizedSeq) || (finalizedSeq as number) <= (firstSeq as number)) return undefined
  const finalEvents = evidence.session.events.filter(event => event.seq === finalizedSeq)
  const final = finalEvents[0]
  const finalized = final?.type === 'user/message' ? final : undefined
  const finalId = finalized?.data.id
  const derived = evidence.session.deriveMessages()
  const derivedOnly = derived[0]
  if (finalEvents.length !== 1 || finalized === undefined
    || !canonicalEventMatches(finalized, 'finalized', transaction, chat, ref, corrections, closeId, closeHash, body, bodyHash)
    || finalId === undefined
    || repairTargetId !== undefined && finalId !== repairTargetId
    || evidence.session.events.filter(event => event.type === 'user/message' && event.data.id === finalId).length !== 1
    || !exactC31(transaction.finalizedC31, pendingRef) || !exactC32(transaction.finalizedC32, canonicalRef, chat, ref, corrections)
    || derived.length !== 1 || derivedOnly?.id !== finalId
    || derivedOnly?.source.kind !== 'context-manager-canonical'
    || derivedOnly.source.phase !== 'finalized'
    || derivedOnly.source.pendingStateRef !== pendingRef
    || derivedOnly.source.canonicalStateRef !== canonicalRef
    || derivedOnly.source.generation !== generation) return undefined

  // Only after every finalized C34 predicate above has passed do we mint this
  // candidate-specific opaque token and admit it to the focus read-only bridge.
  const token = Object.freeze({})
  verifiedFinalizedRecoveryBridges.set(token, {
    preservation, owner, token, chat, ref, latestCorrections: corrections,
  })
  const identity = rehydrateFinalizedNoFocusChain(owner, token, { chat, ref, latestCorrections: corrections })
  if (identity === undefined) {
    verifiedFinalizedRecoveryBridges.delete(token)
    return undefined
  }
  // Focus brands can only be issued by focus.ts after the whole evidence chain.
  return Object.freeze({
    family: 'no_focus',
    owner,
    token,
    state: Object.freeze({
      kind: 'no_focus',
      ref: pendingRef as PendingCanonicalStateRef,
      focus: Object.freeze({
        kind: 'no_focus', ref: identity.ref, chat: identity.chat, latestCorrections: identity.latestCorrections,
      }),
    }),
    canonicalRef: canonicalRef as CanonicalStateRef,
    material: Object.freeze({
      kind: 'no_focus_material',
      ref: materialRef as CompleteStateMaterialRef,
      target: identity.chat,
      canonicalState: Object.freeze({
        kind: 'no_focus',
        ref: canonicalRef as CanonicalStateRef,
        focus: Object.freeze({ kind: 'no_focus', ref: identity.ref, latestCorrections: identity.latestCorrections }),
      }),
    }),
    generation,
    session: evidence.session,
    finalized,
    body,
    bodyHash,
    close: Object.freeze({ messageId: closeId, hash: closeHash }),
    storedC06: transaction.c06,
    storedC07: transaction.c07,
    storedC29: transaction.c29,
  })
}

function actionCanonicalEventMatches(
  event: SessionEvent | undefined,
  phase: 'current' | 'finalized',
  transaction: Record<string, unknown>,
  chat: string,
  ref: string,
  currentMatter: string,
  corrections: string,
  boundary: RawPreservedActionBoundary,
  origin: { readonly messageId: string; readonly hash: string },
  body: string,
  bodyHash: string,
  family: 'local_restriction' | 'no_safe_action',
): boolean {
  if (event?.type !== 'user/message' || textMessage(event) !== body) return false
  const source = object(event.data.source)
  const machine = source === undefined ? undefined : object(source.machine)
  const requiredFacts = machine === undefined ? undefined : rawRequirements(machine.requiredFacts)
  const usable = machine === undefined ? undefined : rawUsableFacts(machine.usableFacts)
  const unresolved = machine === undefined ? undefined : rawUnresolvedFacts(machine.unresolvedFacts)
  const blocked = machine === undefined ? undefined : rawStringArray(machine.preciselyBlockedActions)
  const safe = machine === undefined ? undefined : rawStringArray(machine.safelyContinuableActions, family === 'local_restriction')
  const expectedSource = family === 'local_restriction'
    ? 'context-manager-local-restriction' : 'context-manager-no-safe-action'
  return source?.kind === expectedSource
    && hasOnlyKeys(source, ['kind', 'phase', 'pendingStateRef', 'canonicalStateRef', 'generation', 'chat', 'bodyHash', 'machine'])
    && machine !== undefined && hasOnlyKeys(machine, ['kind', 'focusRef', 'currentMatter', 'latestCorrections',
      'boundaryRef', 'requiredFacts', 'usableFacts', 'unresolvedFacts', 'preciselyBlockedActions',
      'safelyContinuableActions', 'originMessageId', 'originHash'])
    && source.phase === phase
    && source.pendingStateRef === transaction.pendingRef && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation && source.chat === chat && source.bodyHash === bodyHash
    && machine?.kind === family && machine.focusRef === ref
    && machine.currentMatter === currentMatter && machine.latestCorrections === corrections
    && machine.boundaryRef === boundary.ref
    && requiredFacts !== undefined && usable !== undefined && unresolved !== undefined && blocked !== undefined && safe !== undefined
    && sameRawRequirements(requiredFacts, boundary.requiredFacts)
    && sameRawUsable(usable, boundary.usableFacts)
    && sameRawUnresolved(unresolved, boundary.unresolvedFacts)
    && sameStrings(blocked, boundary.preciselyBlockedActions)
    && sameStrings(safe, boundary.safelyContinuableActions)
    && machine.originMessageId === origin.messageId && machine.originHash === origin.hash
}

function localCanonicalEventMatches(
  event: SessionEvent | undefined, phase: 'current' | 'finalized', transaction: Record<string, unknown>,
  chat: string, ref: string, currentMatter: string, corrections: string,
  boundary: RawPreservedActionBoundary, origin: { readonly messageId: string; readonly hash: string },
  body: string, bodyHash: string,
): boolean {
  return actionCanonicalEventMatches(event, phase, transaction, chat, ref, currentMatter, corrections,
    boundary, origin, body, bodyHash, 'local_restriction')
}

function noSafeCanonicalEventMatches(
  event: SessionEvent | undefined, phase: 'current' | 'finalized', transaction: Record<string, unknown>,
  chat: string, ref: string, currentMatter: string, corrections: string,
  boundary: RawPreservedActionBoundary, origin: { readonly messageId: string; readonly hash: string },
  body: string, bodyHash: string,
): boolean {
  return actionCanonicalEventMatches(event, phase, transaction, chat, ref, currentMatter, corrections,
    boundary, origin, body, bodyHash, 'no_safe_action')
}

function backgroundCanonicalEventMatches(
  event: SessionEvent | undefined,
  phase: 'current' | 'finalized',
  transaction: Record<string, unknown>,
  chat: string,
  candidateRef: string,
  ref: string,
  currentMatter: string,
  corrections: string,
  boundary: RawPreservedActionBoundary,
  evidenceRef: string,
  origin: { readonly messageId: string; readonly hash: string },
  body: string,
  bodyHash: string,
): boolean {
  if (event?.type !== 'user/message' || textMessage(event) !== body) return false
  const source = object(event.data.source)
  const machine = source === undefined ? undefined : object(source.machine)
  return source?.kind === 'context-manager-canonical'
    && source.phase === phase
    && source.pendingStateRef === transaction.pendingRef
    && source.canonicalStateRef === transaction.canonicalRef
    && source.generation === transaction.generation
    && source.chat === chat && source.bodyHash === bodyHash
    && machine?.kind === 'background'
    && hasOnlyKeys(machine, ['kind', 'candidateRef', 'focusRef', 'currentMatter', 'latestCorrections',
      'boundaryRef', 'evidenceRef', 'originMessageId', 'originHash'])
    && machine.candidateRef === candidateRef
    && machine.focusRef === ref && machine.currentMatter === currentMatter
    && machine.latestCorrections === corrections && machine.boundaryRef === boundary.ref
    && machine.evidenceRef === evidenceRef
    && machine.originMessageId === origin.messageId && machine.originHash === origin.hash
}

function hasExactOriginalFocusEvent(
  session: Agent['session'],
  chat: string,
  currentMatter: string,
  focusRef: string,
): boolean {
  const matches = session.events.filter((event): event is SessionEvent<'user/message'> => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return false
    const text = textMessage(event)
    const messageId = String(event.data.id)
    if (text === undefined || text.trim() !== currentMatter || messageId.trim().length === 0) return false
    const originHash = createHash('sha256').update(messageId).update('\0').update(text).digest('hex')
    const expectedRef = `focus:${createHash('sha256').update(chat).update('\0').update(messageId).update('\0').update(originHash).digest('hex')}`
    return expectedRef === focusRef
  })
  const event = matches[0]
  return matches.length === 1 && event !== undefined
    && session.events.filter(candidate => candidate.type === 'user/message' && candidate.data.id === event.data.id).length === 1
}

/** Record-only schema admission. Session continuity and C34 remain separate, stricter gates. */
function parseCanonicalActionStateRecord(
  raw: unknown,
  family: 'local_restriction' | 'no_safe_action',
): LocalRestrictionStateRecord | NoSafeActionStateRecord | undefined {
  const record = object(raw)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const material = transaction === undefined ? undefined : object(transaction.material)
  const canonical = material === undefined ? undefined : object(material.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const rawBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  if (record === undefined || transaction === undefined || machine === undefined || material === undefined
    || canonical === undefined || focus === undefined || rawBoundary === undefined
    || record.family !== family || transaction.family !== family
    || (transaction.phase !== 'pending' && transaction.phase !== 'current' && transaction.phase !== 'finalized')
    || !hasOnlyKeys(record, ['family', 'transaction'])
    || !hasOnlyKeys(transaction, ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine',
      'body', 'bodyHash', 'material', 'c06', 'c02', 'c20', 'c21', 'c22', 'c29', 'c33', 'c30',
      'firstC31', 'firstC32', 'finalizedC31', 'finalizedC32', 'firstReplaceSeq', 'finalizedReplaceSeq', 'repair'])
    || !hasOnlyKeys(machine, ['kind', 'focusRef', 'currentMatter', 'latestCorrections', 'boundaryRef',
      'requiredFacts', 'usableFacts', 'unresolvedFacts', 'preciselyBlockedActions',
      'safelyContinuableActions', 'originMessageId', 'originHash'])
    || !hasOnlyKeys(material, ['kind', 'ref', 'target', 'canonicalState'])
    || !hasOnlyKeys(canonical, ['kind', 'ref', 'focus', 'boundary'])
    || !hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])) return undefined
  const chat = storedString(material, 'target')
  const ref = storedString(focus, 'ref')
  const currentMatter = storedString(focus, 'currentMatter')
  const corrections = typeof focus.latestCorrections === 'string' ? focus.latestCorrections : undefined
  const boundary = rawPreservedActionBoundary(rawBoundary, family)
  const originId = storedString(machine, 'originMessageId')
  const originHash = storedString(machine, 'originHash')
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(material, 'ref')
  const generation = transaction.generation
  const firstSeq = transaction.firstReplaceSeq
  const finalizedSeq = transaction.finalizedReplaceSeq
  if (chat === undefined || ref === undefined || currentMatter === undefined || corrections === undefined
    || boundary === undefined || originId === undefined || originHash === undefined || pendingRef === undefined
    || canonicalRef === undefined || body === undefined || bodyHash === undefined || materialRef === undefined
    || !Number.isSafeInteger(generation) || (generation as number) < 1
    || focus.kind !== 'focus_established' || canonical.kind !== family
    || material.kind !== `${family}_material` || machine.kind !== family
    || machine.focusRef !== ref || machine.currentMatter !== currentMatter || machine.latestCorrections !== corrections
    || machine.boundaryRef !== boundary.ref
    || !sameRawRequirements(rawRequirements(machine.requiredFacts) ?? { ref: '', requirements: [] }, boundary.requiredFacts)
    || !sameRawUsable(rawUsableFacts(machine.usableFacts) ?? [], boundary.usableFacts)
    || !sameRawUnresolved(rawUnresolvedFacts(machine.unresolvedFacts) ?? [], boundary.unresolvedFacts)
    || !sameStrings(rawStringArray(machine.preciselyBlockedActions), boundary.preciselyBlockedActions)
    || !sameStrings(rawStringArray(machine.safelyContinuableActions, family === 'local_restriction'), boundary.safelyContinuableActions)
    || createHash('sha256').update(body).digest('hex') !== bodyHash) return undefined
  const boundaryHash = createHash('sha256').update(ref).update('\0').update(originId).update('\0').update(originHash)
    .update('\0').update(boundary.requiredFacts.ref).update('\0').update(String(boundary.requiredFacts.requirements.length))
  for (const requirement of boundary.requiredFacts.requirements) {
    boundaryHash.update('\0').update(requirement.fact).update('\0').update(String(requirement.neededFor.length))
    for (const action of requirement.neededFor) boundaryHash.update('\0').update(action)
  }
  boundaryHash.update('\0').update(String(boundary.usableFacts.length))
  for (const fact of boundary.usableFacts) {
    boundaryHash.update('\0').update(fact.kind).update('\0').update(fact.fact).update('\0').update(fact.meaning)
      .update('\0').update(fact.source).update('\0').update(fact.degree)
    if (fact.kind === 'inherited_fact') boundaryHash.update('\0').update(fact.inheritedFrom.sourceChat)
      .update('\0').update(fact.inheritedFrom.sourceCanonicalState)
  }
  boundaryHash.update('\0').update(String(boundary.unresolvedFacts.length))
  for (const fact of boundary.unresolvedFacts) boundaryHash.update('\0').update(fact.fact).update('\0').update(fact.meaning)
    .update('\0').update(fact.source).update('\0').update(fact.degree).update('\0').update(fact.affected)
  for (const list of [boundary.preciselyBlockedActions, boundary.safelyContinuableActions]) {
    boundaryHash.update('\0').update(String(list.length))
    for (const item of list) boundaryHash.update('\0').update(item)
  }
  const expectedBoundaryRef = `action-boundary:${boundaryHash.digest('hex')}`
  const canonicalPrefix = family === 'local_restriction' ? 'local-restriction' : 'no-safe-action'
  const expectedCanonicalRef = `canonical:${canonicalPrefix}:${createHash('sha256')
    .update(ref).update('\0').update(boundary.ref).digest('hex')}`
  const expectedPendingRef = `pending:${createHash('sha256')
    .update(expectedCanonicalRef).update('\0').update(ref).update('\0').update(boundary.ref).digest('hex')}`
  const expectedMaterialRef = `material:${createHash('sha256').update(expectedPendingRef).update('\0').update(bodyHash).digest('hex')}`
  if (boundary.ref !== expectedBoundaryRef || canonical.ref !== canonicalRef || canonicalRef !== expectedCanonicalRef
    || pendingRef !== expectedPendingRef || materialRef !== expectedMaterialRef
    || !exactEstablishedFocusReport(transaction.c06, 'C06', ref, chat, currentMatter, corrections)
    || !exactEstablishedFocusReport(transaction.c02, 'C02', ref, chat, currentMatter, corrections)
    || !acceptedLocalBoundaryReport(transaction.c20, 'C20', chat, boundary)
    || !acceptedLocalBoundaryReport(transaction.c21, 'C21', chat, boundary)
    || !acceptedLocalC22Report(transaction.c22, chat, boundary)
    || !acceptedEligibleC29(transaction.c29, pendingRef)) return undefined
  if (transaction.phase === 'pending') {
    return transaction.c33 === undefined && transaction.c30 === undefined
      && transaction.firstC31 === undefined && transaction.firstC32 === undefined
      && transaction.finalizedC31 === undefined && transaction.finalizedC32 === undefined
      && firstSeq === undefined && finalizedSeq === undefined && transaction.repair === undefined
      ? raw as LocalRestrictionStateRecord | NoSafeActionStateRecord : undefined
  }
  if (!Number.isSafeInteger(firstSeq) || (firstSeq as number) < 0
    || !exactC33(transaction.c33, materialRef) || !exactC30(transaction.c30, pendingRef)
    || !exactC31(transaction.firstC31, pendingRef)
    || !(family === 'local_restriction'
      ? exactLocalC32(transaction.firstC32, canonicalRef, chat, ref, currentMatter, corrections, boundary)
      : exactNoSafeC32(transaction.firstC32, canonicalRef, chat, ref, currentMatter, corrections, boundary))) return undefined
  if (transaction.phase === 'current') {
    return transaction.finalizedC31 === undefined && transaction.finalizedC32 === undefined
      && finalizedSeq === undefined && transaction.repair === undefined
      ? raw as LocalRestrictionStateRecord | NoSafeActionStateRecord : undefined
  }
  if (!Number.isSafeInteger(finalizedSeq) || (finalizedSeq as number) <= (firstSeq as number)
    || !exactC31(transaction.finalizedC31, pendingRef)
    || !(family === 'local_restriction'
      ? exactLocalC32(transaction.finalizedC32, canonicalRef, chat, ref, currentMatter, corrections, boundary)
      : exactNoSafeC32(transaction.finalizedC32, canonicalRef, chat, ref, currentMatter, corrections, boundary))) return undefined
  const repair = transaction.repair === undefined ? undefined : object(transaction.repair)
  if (repair !== undefined) {
    const phase = repair.phase
    const target = storedString(repair, 'targetMessageId')
    if ((phase !== 'repair_pending' && phase !== 'repair_finalized') || target === undefined
      || !hasOnlyKeys(repair, phase === 'repair_finalized'
        ? ['phase', 'targetMessageId', 'targetReplaceSeq'] : ['phase', 'targetMessageId'])
      || phase === 'repair_finalized' && (!Number.isSafeInteger(repair.targetReplaceSeq)
        || (repair.targetReplaceSeq as number) <= (finalizedSeq as number))) return undefined
  }
  return raw as LocalRestrictionStateRecord | NoSafeActionStateRecord
}

export function parseCanonicalLocalRestrictionStateRecord(raw: unknown): LocalRestrictionStateRecord | undefined {
  const record = parseCanonicalActionStateRecord(raw, 'local_restriction')
  return record?.family === 'local_restriction' ? record : undefined
}

export function parseCanonicalNoSafeActionStateRecord(raw: unknown): NoSafeActionStateRecord | undefined {
  const record = parseCanonicalActionStateRecord(raw, 'no_safe_action')
  return record?.family === 'no_safe_action' ? record : undefined
}

export function parseCanonicalBackgroundStateRecord(raw: unknown): BackgroundStateRecord | undefined {
  const record = object(raw)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const material = transaction === undefined ? undefined : object(transaction.material)
  const canonical = material === undefined ? undefined : object(material.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const rawBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  if (record === undefined || transaction === undefined || machine === undefined || material === undefined
    || canonical === undefined || focus === undefined || rawBoundary === undefined
    || record.family !== 'background' || transaction.family !== 'background'
    || (transaction.phase !== 'pending' && transaction.phase !== 'current' && transaction.phase !== 'finalized')
    || !hasOnlyKeys(record, ['family', 'transaction'])
    || !hasOnlyKeys(machine, ['kind', 'candidateRef', 'focusRef', 'currentMatter', 'latestCorrections',
      'boundaryRef', 'evidenceRef', 'originMessageId', 'originHash'])
    || !hasOnlyKeys(material, ['kind', 'ref', 'target', 'canonicalState'])
    || !hasOnlyKeys(canonical, ['kind', 'ref', 'candidateRef', 'focus', 'boundary'])
    || !hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])) return undefined
  const expectedKeys = transaction.phase === 'pending'
    ? ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine', 'body', 'bodyHash',
        'material', 'c28', 'c06', 'c20', 'c29']
    : transaction.phase === 'current'
      ? ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine', 'body', 'bodyHash',
          'material', 'c28', 'c06', 'c20', 'c29', 'c33', 'c30', 'firstC31', 'firstC32', 'firstReplaceSeq']
      : ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine', 'body', 'bodyHash',
          'material', 'c28', 'c06', 'c20', 'c29', 'c33', 'c30', 'firstC31', 'firstC32',
          'finalizedC31', 'finalizedC32', 'firstReplaceSeq', 'finalizedReplaceSeq', 'repair']
  if (!hasOnlyKeys(transaction, expectedKeys)) return undefined
  const chat = storedString(material, 'target')
  const candidateRef = storedString(machine, 'candidateRef')
  const ref = storedString(focus, 'ref')
  const currentMatter = storedString(focus, 'currentMatter')
  const corrections = typeof focus.latestCorrections === 'string' ? focus.latestCorrections : undefined
  const boundaryKind = rawBoundary.kind
  const boundary = boundaryKind === 'actionable' || boundaryKind === 'local_restriction' || boundaryKind === 'no_safe_action'
    ? rawPreservedActionBoundary(rawBoundary, boundaryKind) : undefined
  const evidenceRef = storedString(machine, 'evidenceRef')
  const originId = storedString(machine, 'originMessageId')
  const originHash = storedString(machine, 'originHash')
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(material, 'ref')
  const generation = transaction.generation
  if (chat === undefined || candidateRef === undefined || ref === undefined || currentMatter === undefined
    || corrections === undefined || boundary === undefined || evidenceRef === undefined
    || originId === undefined || originHash === undefined || pendingRef === undefined || canonicalRef === undefined
    || body === undefined || bodyHash === undefined || materialRef === undefined
    || !Number.isSafeInteger(generation) || (generation as number) < 1
    || focus.kind !== 'focus_established' || canonical.kind !== 'background'
    || canonical.candidateRef !== candidateRef || material.kind !== 'background_material'
    || machine.kind !== 'background' || machine.focusRef !== ref || machine.currentMatter !== currentMatter
    || machine.latestCorrections !== corrections || machine.boundaryRef !== boundary.ref
    || createHash('sha256').update(body).digest('hex') !== bodyHash) return undefined
  const qualification = decodeBackgroundQualification(
    transaction.c28, candidateRef, chat, ref, currentMatter, corrections, boundary, evidenceRef, body,
  )
  if (qualification === undefined) return undefined
  const expectedCanonicalRef = `canonical:background:${createHash('sha256')
    .update(candidateRef).update('\0').update(qualification.c28.identity.call).digest('hex')}`
  const expectedPendingRef = `pending:${createHash('sha256')
    .update(expectedCanonicalRef).update('\0').update(ref).update('\0').update(boundary.ref).digest('hex')}`
  const expectedMaterialRef = `material:${createHash('sha256')
    .update(expectedPendingRef).update('\0').update(bodyHash).digest('hex')}`
  if (canonical.ref !== canonicalRef || canonicalRef !== expectedCanonicalRef
    || pendingRef !== expectedPendingRef || materialRef !== expectedMaterialRef
    || !exactEstablishedFocusReport(transaction.c06, 'C06', ref, chat, currentMatter, corrections)
    || !acceptedLocalBoundaryReport(transaction.c20, 'C20', chat, boundary)
    || !acceptedEligibleC29(transaction.c29, pendingRef)) return undefined
  if (transaction.phase === 'pending') return raw as BackgroundStateRecord
  if (!exactC33(transaction.c33, materialRef) || !exactC30(transaction.c30, pendingRef)
    || !exactC31(transaction.firstC31, pendingRef)
    || !exactBackgroundC32(transaction.firstC32, canonicalRef, chat, candidateRef,
      ref, currentMatter, corrections, boundary)
    || !Number.isSafeInteger(transaction.firstReplaceSeq) || (transaction.firstReplaceSeq as number) < 0) return undefined
  if (transaction.phase === 'current') return raw as BackgroundStateRecord
  if (!exactC31(transaction.finalizedC31, pendingRef)
    || !exactBackgroundC32(transaction.finalizedC32, canonicalRef, chat, candidateRef,
      ref, currentMatter, corrections, boundary)
    || !Number.isSafeInteger(transaction.finalizedReplaceSeq)
    || (transaction.finalizedReplaceSeq as number) <= (transaction.firstReplaceSeq as number)) return undefined
  const repair = transaction.repair === undefined ? undefined : object(transaction.repair)
  if (repair !== undefined) {
    const phase = repair.phase
    const target = storedString(repair, 'targetMessageId')
    if ((phase !== 'repair_pending' && phase !== 'repair_finalized') || target === undefined
      || !hasOnlyKeys(repair, phase === 'repair_finalized'
        ? ['phase', 'targetMessageId', 'targetReplaceSeq'] : ['phase', 'targetMessageId'])
      || phase === 'repair_finalized' && (!Number.isSafeInteger(repair.targetReplaceSeq)
        || (repair.targetReplaceSeq as number) <= (transaction.finalizedReplaceSeq as number))) return undefined
  }
  return raw as BackgroundStateRecord
}

/** Exact finalized decoder shared only by the two fixed action-boundary families. */
function decodeStoredActionBoundaryMaterial(
  evidence: StoredNoFocusRecoveryEvidence,
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
  family: 'local_restriction' | 'no_safe_action',
): StoredLocalRestrictionRecoveryCandidate | StoredNoSafeActionRecoveryCandidate | undefined {
  const record = object(evidence.record)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const material = transaction === undefined ? undefined : object(transaction.material)
  const canonical = material === undefined ? undefined : object(material.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const rawBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  if (record === undefined || transaction === undefined || machine === undefined || material === undefined
    || canonical === undefined || focus === undefined || rawBoundary === undefined
    || record.family !== family || transaction.family !== family
    || transaction.phase !== 'finalized'
    || !hasOnlyKeys(record, ['family', 'transaction'])
    || !hasOnlyKeys(transaction, ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine',
      'body', 'bodyHash', 'material', 'c06', 'c02', 'c20', 'c21', 'c22', 'c29', 'c33', 'c30',
      'firstC31', 'firstC32', 'finalizedC31', 'finalizedC32', 'firstReplaceSeq', 'finalizedReplaceSeq', 'repair'])
    || !hasOnlyKeys(machine, ['kind', 'focusRef', 'currentMatter', 'latestCorrections', 'boundaryRef',
      'requiredFacts', 'usableFacts', 'unresolvedFacts', 'preciselyBlockedActions',
      'safelyContinuableActions', 'originMessageId', 'originHash'])
    || !hasOnlyKeys(material, ['kind', 'ref', 'target', 'canonicalState'])
    || !hasOnlyKeys(canonical, ['kind', 'ref', 'focus', 'boundary'])
    || !hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])
  ) return undefined

  const chat = storedString(material, 'target')
  const ref = storedString(focus, 'ref')
  const currentMatter = storedString(focus, 'currentMatter')
  const corrections = typeof focus.latestCorrections === 'string' ? focus.latestCorrections : undefined
  const boundaryProof = rawPreservedActionBoundary(rawBoundary, family)
  const boundaryRef = boundaryProof?.ref
  const originId = storedString(machine, 'originMessageId')
  const originHash = storedString(machine, 'originHash')
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(material, 'ref')
  const generation = transaction.generation
  if (chat === undefined || ref === undefined || currentMatter === undefined || corrections === undefined
    || boundaryProof === undefined || boundaryRef === undefined
    || originId === undefined || originHash === undefined
    || pendingRef === undefined || canonicalRef === undefined || body === undefined || bodyHash === undefined
    || materialRef === undefined || !Number.isSafeInteger(generation) || (generation as number) < 1
    || String(evidence.session.id) !== chat
    || !/^focus:[0-9a-f]{64}$/.test(ref)
    || focus.kind !== 'focus_established' || canonical.kind !== family
    || material.kind !== `${family}_material`
    || machine.kind !== family || machine.focusRef !== ref
    || machine.currentMatter !== currentMatter || machine.latestCorrections !== corrections
    || machine.boundaryRef !== boundaryRef
    || !sameRawRequirements(rawRequirements(machine.requiredFacts) ?? { ref: '', requirements: [] }, boundaryProof.requiredFacts)
    || !sameRawUsable(rawUsableFacts(machine.usableFacts) ?? [], boundaryProof.usableFacts)
    || !sameRawUnresolved(rawUnresolvedFacts(machine.unresolvedFacts) ?? [], boundaryProof.unresolvedFacts)
    || !sameStrings(rawStringArray(machine.preciselyBlockedActions), boundaryProof.preciselyBlockedActions)
    || !sameStrings(rawStringArray(machine.safelyContinuableActions, family === 'local_restriction'), boundaryProof.safelyContinuableActions)
    || createHash('sha256').update(body).digest('hex') !== bodyHash) return undefined

  const boundaryHash = createHash('sha256').update(ref)
    .update('\0').update(originId).update('\0').update(originHash)
    .update('\0').update(boundaryProof.requiredFacts.ref)
    .update('\0').update(String(boundaryProof.requiredFacts.requirements.length))
  for (const requirement of boundaryProof.requiredFacts.requirements) {
    boundaryHash.update('\0').update(requirement.fact).update('\0').update(String(requirement.neededFor.length))
    for (const action of requirement.neededFor) boundaryHash.update('\0').update(action)
  }
  boundaryHash.update('\0').update(String(boundaryProof.usableFacts.length))
  for (const fact of boundaryProof.usableFacts) {
    boundaryHash.update('\0').update(fact.kind).update('\0').update(fact.fact).update('\0').update(fact.meaning)
      .update('\0').update(fact.source).update('\0').update(fact.degree)
    if (fact.kind === 'inherited_fact') boundaryHash.update('\0').update(fact.inheritedFrom.sourceChat)
      .update('\0').update(fact.inheritedFrom.sourceCanonicalState)
  }
  boundaryHash.update('\0').update(String(boundaryProof.unresolvedFacts.length))
  for (const fact of boundaryProof.unresolvedFacts) {
    boundaryHash.update('\0').update(fact.fact).update('\0').update(fact.meaning).update('\0').update(fact.source)
      .update('\0').update(fact.degree).update('\0').update(fact.affected)
  }
  for (const list of [boundaryProof.preciselyBlockedActions, boundaryProof.safelyContinuableActions]) {
    boundaryHash.update('\0').update(String(list.length))
    for (const item of list) boundaryHash.update('\0').update(item)
  }
  const expectedBoundaryRef = `action-boundary:${boundaryHash.digest('hex')}`
  const canonicalPrefix = family === 'local_restriction' ? 'local-restriction' : 'no-safe-action'
  const expectedCanonicalRef = `canonical:${canonicalPrefix}:${createHash('sha256')
    .update(ref).update('\0').update(boundaryRef).digest('hex')}`
  const expectedPendingRef = `pending:${createHash('sha256')
    .update(expectedCanonicalRef).update('\0').update(ref).update('\0').update(boundaryRef).digest('hex')}`
  const expectedMaterialRef = `material:${createHash('sha256').update(expectedPendingRef).update('\0').update(bodyHash).digest('hex')}`
  if (boundaryRef !== expectedBoundaryRef || canonical.ref !== canonicalRef
    || canonicalRef !== expectedCanonicalRef || pendingRef !== expectedPendingRef || materialRef !== expectedMaterialRef) return undefined

  if (!exactEstablishedFocusReport(transaction.c06, 'C06', ref, chat, currentMatter, corrections)
    || !exactEstablishedFocusReport(transaction.c02, 'C02', ref, chat, currentMatter, corrections)
    || !acceptedLocalBoundaryReport(transaction.c20, 'C20', chat, boundaryProof)
    || !acceptedLocalBoundaryReport(transaction.c21, 'C21', chat, boundaryProof)
    || !acceptedLocalC22Report(transaction.c22, chat, boundaryProof)
    || !acceptedEligibleC29(transaction.c29, pendingRef)
    || !exactC33(transaction.c33, materialRef) || !exactC30(transaction.c30, pendingRef)
    || !exactC31(transaction.firstC31, pendingRef)
    || !(family === 'local_restriction'
      ? exactLocalC32(transaction.firstC32, canonicalRef, chat, ref, currentMatter, corrections, boundaryProof)
      : exactNoSafeC32(transaction.firstC32, canonicalRef, chat, ref, currentMatter, corrections, boundaryProof))
    || !exactC31(transaction.finalizedC31, pendingRef)
    || !(family === 'local_restriction'
      ? exactLocalC32(transaction.finalizedC32, canonicalRef, chat, ref, currentMatter, corrections, boundaryProof)
      : exactNoSafeC32(transaction.finalizedC32, canonicalRef, chat, ref, currentMatter, corrections, boundaryProof))) return undefined

  const originEvents = evidence.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === originId)
  const origin = originEvents[0]
  const originText = origin === undefined ? undefined : textMessage(origin)
  if (originEvents.length !== 1 || origin?.data.source.kind !== 'user' || originText === undefined
    || createHash('sha256').update(originId).update('\0').update(originText).digest('hex') !== originHash) return undefined

  const repair = transaction.repair === undefined ? undefined : object(transaction.repair)
  const repairPhase = repair?.phase
  const repairTargetMessageId = repair === undefined ? undefined : storedString(repair, 'targetMessageId')
  const repairTargetReplaceSeq = repair?.targetReplaceSeq
  if (repair !== undefined && (!hasOnlyKeys(repair, repairPhase === 'repair_finalized'
      ? ['phase', 'targetMessageId', 'targetReplaceSeq'] : ['phase', 'targetMessageId'])
    || (repairPhase !== 'repair_pending' && repairPhase !== 'repair_finalized')
    || repairTargetMessageId === undefined
    || repairPhase === 'repair_pending'
    || !Number.isSafeInteger(repairTargetReplaceSeq)
    || (repairTargetReplaceSeq as number) <= (transaction.finalizedReplaceSeq as number))) return undefined
  const firstSeq = transaction.firstReplaceSeq
  const finalizedSeq = repairPhase === 'repair_finalized' ? repairTargetReplaceSeq : transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstSeq) || !Number.isSafeInteger(finalizedSeq)
    || (firstSeq as number) < 0 || (finalizedSeq as number) <= (firstSeq as number)) return undefined
  const originProof = Object.freeze({ messageId: originId, hash: originHash })
  const firstEvents = evidence.session.events.filter(event => event.seq === firstSeq)
  const finalEvents = evidence.session.events.filter(event => event.seq === finalizedSeq)
  const first = firstEvents[0]
  const finalized = finalEvents[0]
  const firstId = first?.type === 'user/message' ? String(first.data.id) : undefined
  const finalId = finalized?.type === 'user/message' ? String(finalized.data.id) : undefined
  if (firstEvents.length !== 1 || finalEvents.length !== 1 || firstId === undefined || finalId === undefined
    || repairTargetMessageId !== undefined && finalId !== repairTargetMessageId
    || evidence.session.events.filter(event => event.type === 'user/message' && String(event.data.id) === firstId).length !== 1
    || evidence.session.events.filter(event => event.type === 'user/message' && String(event.data.id) === finalId).length !== 1
    || !(family === 'local_restriction'
      ? localCanonicalEventMatches(first, 'current', transaction, chat, ref, currentMatter, corrections,
          boundaryProof, originProof, body, bodyHash)
        && localCanonicalEventMatches(finalized, 'finalized', transaction, chat, ref, currentMatter, corrections,
          boundaryProof, originProof, body, bodyHash)
      : noSafeCanonicalEventMatches(first, 'current', transaction, chat, ref, currentMatter, corrections,
          boundaryProof, originProof, body, bodyHash)
        && noSafeCanonicalEventMatches(finalized, 'finalized', transaction, chat, ref, currentMatter, corrections,
          boundaryProof, originProof, body, bodyHash))) return undefined
  const derived = evidence.session.deriveMessages()
  const only = derived[0]
  const derivedText = only?.content.length === 1 && only.content[0]?.type === 'text' ? only.content[0].text : undefined
  if (derived.length !== 1 || only?.id === undefined || String(only.id) !== finalId
    || only.source.kind !== (family === 'local_restriction'
      ? 'context-manager-local-restriction' : 'context-manager-no-safe-action')
    || !(family === 'local_restriction'
      ? localCanonicalEventMatches({ type: 'user/message', seq: finalizedSeq as number, data: only } as SessionEvent,
          'finalized', transaction, chat, ref, currentMatter, corrections, boundaryProof, originProof, body, bodyHash)
      : noSafeCanonicalEventMatches({ type: 'user/message', seq: finalizedSeq as number, data: only } as SessionEvent,
          'finalized', transaction, chat, ref, currentMatter, corrections, boundaryProof, originProof, body, bodyHash))
    || derivedText !== body || createHash('sha256').update(derivedText).digest('hex') !== bodyHash
    || !hasExactOriginalFocusEvent(evidence.session, chat, currentMatter, ref)) return undefined

  const token = Object.freeze({})
  verifiedFinalizedRecoveryBridges.set(token, {
    preservation, owner, token, chat, ref, currentMatter, latestCorrections: corrections,
  })
  const identity = rehydrateFinalizedEstablishedFocusChain(owner, token, {
    chat, ref, currentMatter, latestCorrections: corrections,
  })
  if (identity === undefined || finalized?.type !== 'user/message') {
    verifiedFinalizedRecoveryBridges.delete(token)
    return undefined
  }
  const preservedFocus: Omit<EstablishedFocusDecision, 'chat'> = Object.freeze({
    kind: 'focus_established', ref: identity.ref, currentMatter: identity.currentMatter,
    latestCorrections: identity.latestCorrections,
  })
  const requiredFacts = Object.freeze({
    ref: boundaryProof.requiredFacts.ref as LocalRestrictionBoundary['requiredFacts']['ref'],
    requirements: Object.freeze(boundaryProof.requiredFacts.requirements.map(requirement => Object.freeze({
      fact: requirement.fact as LocalRestrictionBoundary['requiredFacts']['requirements'][number]['fact'],
      neededFor: Object.freeze([...requirement.neededFor]) as LocalRestrictionBoundary['requiredFacts']['requirements'][number]['neededFor'],
    }))),
  })
  const usableFacts = Object.freeze(boundaryProof.usableFacts.map(fact => fact.kind === 'direct_fact'
    ? Object.freeze({ ...fact }) : Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) }))) as readonly UsableFact[]
  const unresolvedFacts = Object.freeze(boundaryProof.unresolvedFacts.map(fact => Object.freeze({ ...fact }))) as readonly UnresolvedFact[]
  if (family === 'local_restriction') {
    const boundary: LocalRestrictionBoundary = Object.freeze({
      kind: 'local_restriction', ref: boundaryProof.ref as LocalRestrictionBoundary['ref'], chat: identity.chat,
      requiredFacts, usableFacts, unresolvedFacts,
      preciselyBlockedActions: Object.freeze([...boundaryProof.preciselyBlockedActions]) as LocalRestrictionBoundary['preciselyBlockedActions'],
      safelyContinuableActions: Object.freeze([...boundaryProof.safelyContinuableActions]) as LocalRestrictionBoundary['safelyContinuableActions'],
    })
    const state: PendingCanonicalState<'local_restriction', LocalRestrictionBoundary> = Object.freeze({
      kind: 'local_restriction', ref: pendingRef as PendingCanonicalStateRef, focus: preservedFocus, boundary,
    })
    const complete: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary> = Object.freeze({
      kind: 'local_restriction_material', ref: materialRef as CompleteStateMaterialRef, target: identity.chat,
      canonicalState: Object.freeze({
        kind: 'local_restriction', ref: canonicalRef as CanonicalStateRef, focus: preservedFocus,
        boundary: preserveActionBoundary(boundary),
      }),
    })
    return Object.freeze({
      family: 'local_restriction', owner, actionOwner, token, state,
      canonicalRef: canonicalRef as CanonicalStateRef, material: complete,
      generation: generation as number, session: evidence.session, finalized,
      body, bodyHash, close: originProof, boundary,
      storedC06: transaction.c06, storedC02: transaction.c02, storedC20: transaction.c20,
      storedC21: transaction.c21, storedC22: transaction.c22, storedC29: transaction.c29,
    })
  }
  const boundary: NoSafeActionBoundary = Object.freeze({
    kind: 'no_safe_action', ref: boundaryProof.ref as NoSafeActionBoundary['ref'], chat: identity.chat,
    requiredFacts, usableFacts, unresolvedFacts,
    preciselyBlockedActions: Object.freeze([...boundaryProof.preciselyBlockedActions]) as NoSafeActionBoundary['preciselyBlockedActions'],
    safelyContinuableActions: Object.freeze([] as const),
  })
  const state: PendingCanonicalState<'no_safe_action', NoSafeActionBoundary> = Object.freeze({
    kind: 'no_safe_action', ref: pendingRef as PendingCanonicalStateRef, focus: preservedFocus, boundary,
  })
  const complete: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary> = Object.freeze({
    kind: 'no_safe_action_material', ref: materialRef as CompleteStateMaterialRef, target: identity.chat,
    canonicalState: Object.freeze({
      kind: 'no_safe_action', ref: canonicalRef as CanonicalStateRef, focus: preservedFocus,
      boundary: preserveNoSafeActionBoundary(boundary),
    }),
  })
  return Object.freeze({
    family: 'no_safe_action', owner, actionOwner, token, state,
    canonicalRef: canonicalRef as CanonicalStateRef, material: complete,
    generation: generation as number, session: evidence.session, finalized,
    body, bodyHash, close: originProof, boundary,
    storedC06: transaction.c06, storedC02: transaction.c02, storedC20: transaction.c20,
    storedC21: transaction.c21, storedC22: transaction.c22, storedC29: transaction.c29,
  })
}

function decodeStoredLocalRestrictionMaterial(
  evidence: StoredNoFocusRecoveryEvidence,
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
): StoredLocalRestrictionRecoveryCandidate | undefined {
  const candidate = decodeStoredActionBoundaryMaterial(evidence, preservation, owner, actionOwner, 'local_restriction')
  return candidate?.family === 'local_restriction' ? candidate : undefined
}

function decodeStoredNoSafeActionMaterial(
  evidence: StoredNoFocusRecoveryEvidence,
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
): StoredNoSafeActionRecoveryCandidate | undefined {
  const candidate = decodeStoredActionBoundaryMaterial(evidence, preservation, owner, actionOwner, 'no_safe_action')
  return candidate?.family === 'no_safe_action' ? candidate : undefined
}

function rehydrateBackgroundBoundary(
  proof: RawPreservedActionBoundary,
  chat: ChatRef,
): ActionFactBoundary {
  const requiredFacts = Object.freeze({
    ref: proof.requiredFacts.ref as ActionFactBoundary['requiredFacts']['ref'],
    requirements: Object.freeze(proof.requiredFacts.requirements.map(requirement => Object.freeze({
      fact: requirement.fact as ActionFactBoundary['requiredFacts']['requirements'][number]['fact'],
      neededFor: Object.freeze([...requirement.neededFor]) as ActionFactBoundary['requiredFacts']['requirements'][number]['neededFor'],
    }))),
  })
  const usableFacts = Object.freeze(proof.usableFacts.map(fact => fact.kind === 'direct_fact'
    ? Object.freeze({ ...fact })
    : Object.freeze({ ...fact, inheritedFrom: Object.freeze({ ...fact.inheritedFrom }) }))) as readonly UsableFact[]
  const unresolvedFacts = Object.freeze(proof.unresolvedFacts.map(fact => Object.freeze({ ...fact }))) as readonly UnresolvedFact[]
  if (proof.kind === 'actionable') {
    return Object.freeze({
      kind: 'actionable', ref: proof.ref as ActionFactBoundaryRef, chat,
      requiredFacts, usableFacts, unresolvedFacts,
      preciselyBlockedActions: Object.freeze([] as const),
      safelyContinuableActions: Object.freeze([...proof.safelyContinuableActions]) as Extract<ActionFactBoundary, { readonly kind: 'actionable' }>['safelyContinuableActions'],
    })
  }
  if (proof.kind === 'local_restriction') {
    return Object.freeze({
      kind: 'local_restriction', ref: proof.ref as ActionFactBoundaryRef, chat,
      requiredFacts, usableFacts, unresolvedFacts,
      preciselyBlockedActions: Object.freeze([...proof.preciselyBlockedActions]) as Extract<ActionFactBoundary, { readonly kind: 'local_restriction' }>['preciselyBlockedActions'],
      safelyContinuableActions: Object.freeze([...proof.safelyContinuableActions]) as Extract<ActionFactBoundary, { readonly kind: 'local_restriction' }>['safelyContinuableActions'],
    })
  }
  return Object.freeze({
    kind: 'no_safe_action', ref: proof.ref as ActionFactBoundaryRef, chat,
    requiredFacts, usableFacts, unresolvedFacts,
    preciselyBlockedActions: Object.freeze([...proof.preciselyBlockedActions]) as Extract<ActionFactBoundary, { readonly kind: 'no_safe_action' }>['preciselyBlockedActions'],
    safelyContinuableActions: Object.freeze([] as const),
  })
}

function decodeStoredBackgroundMaterial(
  evidence: StoredNoFocusRecoveryEvidence,
  preservation: EffectiveStatePreservation,
  owner: FocusAuthority,
  actionOwner: ActionFactBoundaryAuthority,
): StoredBackgroundRecoveryCandidate | undefined {
  const record = object(evidence.record)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const material = transaction === undefined ? undefined : object(transaction.material)
  const canonical = material === undefined ? undefined : object(material.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const rawBoundary = canonical === undefined ? undefined : object(canonical.boundary)
  if (record === undefined || transaction === undefined || machine === undefined || material === undefined
    || canonical === undefined || focus === undefined || rawBoundary === undefined
    || record.family !== 'background' || transaction.family !== 'background'
    || transaction.phase !== 'finalized'
    || !hasOnlyKeys(record, ['family', 'transaction'])
    || !hasOnlyKeys(transaction, ['family', 'phase', 'pendingRef', 'canonicalRef', 'generation', 'machine',
      'body', 'bodyHash', 'material', 'c28', 'c06', 'c20', 'c29', 'c33', 'c30',
      'firstC31', 'firstC32', 'finalizedC31', 'finalizedC32', 'firstReplaceSeq', 'finalizedReplaceSeq', 'repair'])
    || !hasOnlyKeys(machine, ['kind', 'candidateRef', 'focusRef', 'currentMatter', 'latestCorrections',
      'boundaryRef', 'evidenceRef', 'originMessageId', 'originHash'])
    || !hasOnlyKeys(material, ['kind', 'ref', 'target', 'canonicalState'])
    || !hasOnlyKeys(canonical, ['kind', 'ref', 'candidateRef', 'focus', 'boundary'])
    || !hasOnlyKeys(focus, ['kind', 'ref', 'currentMatter', 'latestCorrections'])) return undefined
  const chat = storedString(material, 'target')
  const candidateRef = storedString(machine, 'candidateRef')
  const ref = storedString(focus, 'ref')
  const currentMatter = storedString(focus, 'currentMatter')
  const corrections = typeof focus.latestCorrections === 'string' ? focus.latestCorrections : undefined
  const boundaryKind = rawBoundary.kind
  const boundaryProof = boundaryKind === 'actionable' || boundaryKind === 'local_restriction' || boundaryKind === 'no_safe_action'
    ? rawPreservedActionBoundary(rawBoundary, boundaryKind) : undefined
  const evidenceRef = storedString(machine, 'evidenceRef')
  const originId = storedString(machine, 'originMessageId')
  const originHash = storedString(machine, 'originHash')
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(material, 'ref')
  const generation = transaction.generation
  if (chat === undefined || candidateRef === undefined || ref === undefined || currentMatter === undefined
    || corrections === undefined || boundaryProof === undefined || evidenceRef === undefined
    || originId === undefined || originHash === undefined || pendingRef === undefined || canonicalRef === undefined
    || body === undefined || bodyHash === undefined || materialRef === undefined
    || !Number.isSafeInteger(generation) || (generation as number) < 1
    || String(evidence.session.id) !== chat || focus.kind !== 'focus_established'
    || canonical.kind !== 'background' || canonical.candidateRef !== candidateRef
    || material.kind !== 'background_material' || machine.kind !== 'background'
    || machine.focusRef !== ref || machine.currentMatter !== currentMatter
    || machine.latestCorrections !== corrections || machine.boundaryRef !== boundaryProof.ref
    || createHash('sha256').update(body).digest('hex') !== bodyHash) return undefined
  const qualification = decodeBackgroundQualification(
    transaction.c28, candidateRef, chat, ref, currentMatter, corrections,
    boundaryProof, evidenceRef, body,
  )
  if (qualification === undefined) return undefined
  const expectedCanonicalRef = `canonical:background:${createHash('sha256')
    .update(candidateRef).update('\0').update(qualification.c28.identity.call).digest('hex')}`
  const expectedPendingRef = `pending:${createHash('sha256')
    .update(expectedCanonicalRef).update('\0').update(ref).update('\0').update(boundaryProof.ref).digest('hex')}`
  const expectedMaterialRef = `material:${createHash('sha256')
    .update(expectedPendingRef).update('\0').update(bodyHash).digest('hex')}`
  if (canonical.ref !== canonicalRef || canonicalRef !== expectedCanonicalRef
    || pendingRef !== expectedPendingRef || materialRef !== expectedMaterialRef
    || !exactEstablishedFocusReport(transaction.c06, 'C06', ref, chat, currentMatter, corrections)
    || !acceptedLocalBoundaryReport(transaction.c20, 'C20', chat, boundaryProof)
    || !acceptedEligibleC29(transaction.c29, pendingRef)
    || !exactC33(transaction.c33, materialRef) || !exactC30(transaction.c30, pendingRef)
    || !exactC31(transaction.firstC31, pendingRef)
    || !exactBackgroundC32(transaction.firstC32, canonicalRef, chat, candidateRef,
      ref, currentMatter, corrections, boundaryProof)
    || !exactC31(transaction.finalizedC31, pendingRef)
    || !exactBackgroundC32(transaction.finalizedC32, canonicalRef, chat, candidateRef,
      ref, currentMatter, corrections, boundaryProof)) return undefined
  const repair = transaction.repair === undefined ? undefined : object(transaction.repair)
  const repairPhase = repair?.phase
  const repairTargetMessageId = repair === undefined ? undefined : storedString(repair, 'targetMessageId')
  const repairTargetReplaceSeq = repair?.targetReplaceSeq
  if (repair !== undefined && (!hasOnlyKeys(repair, repairPhase === 'repair_finalized'
      ? ['phase', 'targetMessageId', 'targetReplaceSeq'] : ['phase', 'targetMessageId'])
    || repairPhase !== 'repair_finalized' || repairTargetMessageId === undefined
    || !Number.isSafeInteger(repairTargetReplaceSeq)
    || (repairTargetReplaceSeq as number) <= (transaction.finalizedReplaceSeq as number))) return undefined
  const firstSeq = transaction.firstReplaceSeq
  const finalizedSeq = repairPhase === 'repair_finalized' ? repairTargetReplaceSeq : transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstSeq) || !Number.isSafeInteger(finalizedSeq)
    || (firstSeq as number) < 0 || (finalizedSeq as number) <= (firstSeq as number)) return undefined
  const origin = Object.freeze({ messageId: originId, hash: originHash })
  const firstEvents = evidence.session.events.filter(event => event.seq === firstSeq)
  const finalEvents = evidence.session.events.filter(event => event.seq === finalizedSeq)
  const first = firstEvents[0]
  const finalized = finalEvents[0]
  const firstId = first?.type === 'user/message' ? String(first.data.id) : undefined
  const finalId = finalized?.type === 'user/message' ? String(finalized.data.id) : undefined
  if (firstEvents.length !== 1 || finalEvents.length !== 1 || firstId === undefined || finalId === undefined
    || repairTargetMessageId !== undefined && finalId !== repairTargetMessageId
    || evidence.session.events.filter(event => event.type === 'user/message' && String(event.data.id) === firstId).length !== 1
    || evidence.session.events.filter(event => event.type === 'user/message' && String(event.data.id) === finalId).length !== 1
    || !backgroundCanonicalEventMatches(first, 'current', transaction, chat, candidateRef,
      ref, currentMatter, corrections, boundaryProof, evidenceRef, origin, body, bodyHash)
    || !backgroundCanonicalEventMatches(finalized, 'finalized', transaction, chat, candidateRef,
      ref, currentMatter, corrections, boundaryProof, evidenceRef, origin, body, bodyHash)) return undefined
  const originEvents = evidence.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === originId)
  if (originEvents.length > 1) return undefined
  if (originEvents.length === 1) {
    const originText = textMessage(originEvents[0]!)
    if (originEvents[0]!.data.source.kind !== 'user' || originText === undefined
      || createHash('sha256').update(originId).update('\0').update(originText).digest('hex') !== originHash) return undefined
  }
  const derived = evidence.session.deriveMessages()
  const only = derived[0]
  if (derived.length !== 1 || only === undefined || String(only.id) !== finalId
    || !backgroundCanonicalEventMatches({ type: 'user/message', seq: finalizedSeq as number, data: only } as SessionEvent,
      'finalized', transaction, chat, candidateRef, ref, currentMatter, corrections,
      boundaryProof, evidenceRef, origin, body, bodyHash)
    || !hasExactOriginalFocusEvent(evidence.session, chat, currentMatter, ref)) return undefined
  const token = Object.freeze({})
  verifiedFinalizedRecoveryBridges.set(token, {
    preservation, owner, token, chat, ref, currentMatter, latestCorrections: corrections,
  })
  const identity = rehydrateFinalizedEstablishedFocusChain(owner, token, {
    chat, ref, currentMatter, latestCorrections: corrections,
  })
  if (identity === undefined || finalized?.type !== 'user/message') {
    verifiedFinalizedRecoveryBridges.delete(token)
    return undefined
  }
  const restoredFocus: Omit<EstablishedFocusDecision, 'chat'> = Object.freeze({
    kind: 'focus_established', ref: identity.ref,
    currentMatter: identity.currentMatter, latestCorrections: identity.latestCorrections,
  })
  const boundary = rehydrateBackgroundBoundary(boundaryProof, identity.chat)
  const state: PendingCanonicalState<'background', ActionFactBoundary> = Object.freeze({
    kind: 'background', ref: pendingRef as PendingCanonicalStateRef,
    focus: restoredFocus, boundary,
    candidateRef: candidateRef as CandidateRef, qualification: qualification.c28,
  })
  const complete: CompleteStateMaterial<'background', PreservedActionBoundary> = Object.freeze({
    kind: 'background_material', ref: materialRef as CompleteStateMaterialRef, target: identity.chat,
    canonicalState: Object.freeze({
      kind: 'background', ref: canonicalRef as CanonicalStateRef,
      candidateRef: candidateRef as CandidateRef, focus: restoredFocus,
      boundary: preserveAnyActionBoundary(boundary),
    }),
  })
  return Object.freeze({
    family: 'background', owner, actionOwner, token, state,
    canonicalRef: canonicalRef as CanonicalStateRef, material: complete,
    generation: generation as number, session: evidence.session, finalized,
    body, bodyHash, close: origin, boundary,
    storedC28: transaction.c28, storedC06: transaction.c06,
    storedC20: transaction.c20, storedC29: transaction.c29,
  })
}

interface DecodedPendingBackground {
  readonly record: BackgroundStateRecord
  readonly pending: PrivatePendingBackground
  readonly transaction: CanonicalBackgroundTransaction
  readonly material: CanonicalBackgroundMaterial
}

function decodePendingBackground(
  sessionId: string,
  session: Agent['session'],
  detached: readonly SessionEvent[],
  raw: unknown,
  actionOwner: ActionFactBoundaryAuthority,
  create: CanonicalBackgroundMaterial['create'],
): DecodedPendingBackground | undefined {
  const record = parseCanonicalBackgroundStateRecord(raw)
  const transaction = record?.transaction
  if (record === undefined || transaction === undefined || transaction.phase !== 'pending'
    || String(session.id) !== sessionId || transaction.material.target !== sessionId
    || session.events.some(event => event.type === 'user/message'
      && String(event.data.id) === transaction.machine.originMessageId)
    || detached.some(event => event.type === 'user/message'
      && String(event.data.id) === transaction.machine.originMessageId)
    || !hasExactOriginalFocusEvent(session, sessionId, transaction.machine.currentMatter, transaction.machine.focusRef)) {
    return undefined
  }
  const sameGeneration = (events: readonly SessionEvent[]): boolean => events.some(event => {
    if (event.type !== 'user/message') return false
    const source = object(event.data.source)
    const machine = source === undefined ? undefined : object(source.machine)
    return source?.kind === 'context-manager-canonical'
      && source.generation === transaction.generation && machine?.kind === 'background'
  })
  if (sameGeneration(session.events) || sameGeneration(detached)) return undefined
  const boundaryRaw = object(transaction.material.canonicalState.boundary)
  const boundaryKind = boundaryRaw?.kind
  const proof = boundaryRaw !== undefined
    && (boundaryKind === 'actionable' || boundaryKind === 'local_restriction' || boundaryKind === 'no_safe_action')
    ? rawPreservedActionBoundary(boundaryRaw, boundaryKind) : undefined
  if (proof === undefined) return undefined
  const qualification = decodeBackgroundQualification(
    transaction.c28, transaction.machine.candidateRef, transaction.material.target,
    transaction.machine.focusRef, transaction.machine.currentMatter,
    transaction.machine.latestCorrections, proof, transaction.machine.evidenceRef, transaction.body,
  )
  const focus = transaction.c06.kind === 'business_result'
    && transaction.c06.value.kind === 'accepted_for_contract'
    && transaction.c06.value.value.kind === 'focus_established'
    ? transaction.c06.value.value : undefined
  if (qualification === undefined || focus === undefined || focus.chat !== sessionId
    || transaction.c20.kind !== 'business_result'
    || transaction.c20.value.kind !== 'accepted_for_contract') return undefined
  const boundary = rehydrateBackgroundBoundary(proof, focus.chat)
  const c20: C20Result = Object.freeze({
    kind: 'business_result',
    identity: Object.freeze({ ...transaction.c20.identity }),
    value: Object.freeze({ kind: 'accepted_for_contract', value: boundary }),
  })
  const pending: PrivatePendingBackground = Object.freeze({
    state: Object.freeze({
      kind: 'background', ref: transaction.pendingRef,
      focus: Object.freeze({
        kind: 'focus_established', ref: focus.ref,
        currentMatter: focus.currentMatter, latestCorrections: focus.latestCorrections,
      }),
      boundary, candidateRef: qualification.decision.candidate.ref,
      qualification: qualification.c28,
    }),
    canonicalRef: transaction.canonicalRef,
    generation: transaction.generation,
    actionOwner,
    decision: qualification.decision,
    c28: qualification.c28,
    c06: transaction.c06,
    c20,
    material: Object.freeze({
      kind: 'background_material', ref: transaction.material.ref,
      target: transaction.material.target,
      canonicalState: Object.freeze({
        kind: 'background', ref: transaction.canonicalRef,
        candidateRef: qualification.decision.candidate.ref,
        focus: transaction.material.canonicalState.focus,
        boundary: preserveAnyActionBoundary(boundary),
      }),
    }),
  })
  decodedBackgroundReplayPendings.add(pending)
  return Object.freeze({
    record, pending, transaction,
    material: Object.freeze({
      body: transaction.body, bodyHash: transaction.bodyHash,
      origin: Object.freeze({
        messageId: transaction.machine.originMessageId,
        hash: transaction.machine.originHash,
      }),
      create,
    }),
  })
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

interface ExactPendingNoFocus {
  readonly record: Record<string, unknown>
  readonly pending: PrivatePendingNoFocus
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly transaction: CanonicalNoFocusTransaction
}

/**
 * H1R-P's one raw decoder.  It is intentionally stricter than the ordinary
 * finalized C34 reader: this path has not published a canonical replacement,
 * so an ambiguous trace must close rather than be interpreted as resumable.
 */
function decodeExactPendingNoFocus(
  sessionId: string,
  session: Agent['session'],
  detached: readonly SessionEvent[],
  raw: unknown,
): ExactPendingNoFocus | undefined {
  const record = object(raw)
  const closure = record === undefined ? undefined : object(record.closure)
  const original = closure === undefined ? undefined : object(closure.original)
  const proposal = closure === undefined ? undefined : object(closure.proposal)
  const decision = closure === undefined ? undefined : object(closure.decision)
  const preCanonical = record === undefined ? undefined : object(record.focus)
  const preCanonicalOriginal = preCanonical === undefined ? undefined : object(preCanonical.original)
  const preCanonicalProposal = preCanonical === undefined ? undefined : object(preCanonical.proposal)
  const preCanonicalDecision = preCanonical === undefined ? undefined : object(preCanonical.decision)
  const transaction = record === undefined ? undefined : object(record.transaction)
  const machine = transaction === undefined ? undefined : object(transaction.machine)
  const savedMaterial = transaction === undefined ? undefined : object(transaction.material)
  const canonical = savedMaterial === undefined ? undefined : object(savedMaterial.canonicalState)
  const focus = canonical === undefined ? undefined : object(canonical.focus)
  const closureOnly = record !== undefined && !Object.prototype.hasOwnProperty.call(record, 'focus')
  if (record === undefined || closure === undefined || original === undefined || proposal === undefined || decision === undefined
    || !closureOnly && (preCanonical === undefined || preCanonicalOriginal === undefined || preCanonicalProposal === undefined || preCanonicalDecision === undefined)
    || transaction === undefined || machine === undefined || savedMaterial === undefined || canonical === undefined || focus === undefined
    || closure.phase !== 'physically_proved' || transaction.phase !== 'pending'
    || !hasOnlyKeys(record, closureOnly ? ['closure', 'transaction'] : ['focus', 'closure', 'transaction'])
    || !hasOnlyKeys(closure, ['phase', 'original', 'proposal', 'decision'])
    || !hasOnlyKeys(original, ['messageId', 'hash'])
    || !hasOnlyKeys(proposal, ['kind', 'relation'])
    || !hasOnlyKeys(decision, ['kind', 'ref', 'chat', 'latestCorrections'])
    || !closureOnly && (!hasOnlyKeys(preCanonical!, ['original', 'proposal', 'decision'])
      || !hasOnlyKeys(preCanonicalOriginal!, ['messageId', 'hash'])
      || !hasOnlyKeys(preCanonicalProposal!, ['kind', 'relation', 'subject'])
      || !hasOnlyKeys(preCanonicalDecision!, ['kind', 'ref', 'chat', 'currentMatter', 'latestCorrections']))
    || !hasOnlyKeys(transaction, ['phase', 'pendingRef', 'canonicalRef', 'generation', 'machine', 'body', 'bodyHash', 'material', 'c06', 'c07', 'c29'])) return undefined
  const closeId = storedString(original, 'messageId')
  const closeHash = storedString(original, 'hash')
  const preCanonicalId = preCanonicalOriginal === undefined ? undefined : storedString(preCanonicalOriginal, 'messageId')
  const preCanonicalHash = preCanonicalOriginal === undefined ? undefined : storedString(preCanonicalOriginal, 'hash')
  const preCanonicalSubject = preCanonicalProposal === undefined ? undefined : storedString(preCanonicalProposal, 'subject')
  const preCanonicalRef = preCanonicalDecision === undefined ? undefined : storedString(preCanonicalDecision, 'ref')
  const preCanonicalMatter = preCanonicalDecision === undefined ? undefined : storedString(preCanonicalDecision, 'currentMatter')
  const preCanonicalCorrections = typeof preCanonicalDecision?.latestCorrections === 'string'
    ? preCanonicalDecision.latestCorrections : undefined
  const chat = storedString(decision, 'chat')
  const ref = storedString(decision, 'ref')
  const corrections = typeof decision.latestCorrections === 'string' ? decision.latestCorrections : undefined
  const pendingRef = storedString(transaction, 'pendingRef')
  const canonicalRef = storedString(transaction, 'canonicalRef')
  const body = typeof transaction.body === 'string' ? transaction.body : undefined
  const bodyHash = storedString(transaction, 'bodyHash')
  const materialRef = storedString(savedMaterial, 'ref')
  const generation = transaction.generation
  if (closeId === undefined || closeHash === undefined
    || !closureOnly && (preCanonicalId === undefined || preCanonicalHash === undefined || preCanonicalSubject === undefined
      || preCanonicalRef === undefined || preCanonicalMatter === undefined || preCanonicalCorrections === undefined)
    || chat === undefined || ref === undefined || corrections === undefined
    || pendingRef === undefined || canonicalRef === undefined || body === undefined || bodyHash === undefined || materialRef === undefined
    || String(session.id) !== sessionId || chat !== sessionId || proposal.kind !== 'close' || proposal.relation !== 'current'
    || !closureOnly && (preCanonicalProposal?.kind !== 'focus' || preCanonicalProposal.relation !== 'new')
    || !closureOnly && (preCanonicalDecision?.kind !== 'focus_established' || preCanonicalDecision.chat !== chat)
    || decision.kind !== 'no_focus' || machine.kind !== 'no_focus'
    || !Number.isSafeInteger(generation) || (generation as number) < 1
    || createHash('sha256').update(body).digest('hex') !== bodyHash
    || canonicalRef !== `canonical:${ref}`
    || pendingRef !== `pending:${createHash('sha256').update(canonicalRef).update('\0').update(ref).digest('hex')}`
    || materialRef !== `material:${createHash('sha256').update(pendingRef).update('\0').update(bodyHash).digest('hex')}`
    || ref !== `no-focus:${createHash('sha256').update(chat).update('\0').update(closeId).update('\0').update(closeHash).digest('hex')}`
    || machine.focusRef !== ref || machine.chat !== chat || machine.latestCorrections !== corrections
    || machine.closeMessageId !== closeId || machine.closeHash !== closeHash
    || body !== NO_FOCUS_CANONICAL_BODY
    || savedMaterial.kind !== 'no_focus_material' || savedMaterial.target !== chat
    || canonical.kind !== 'no_focus' || canonical.ref !== canonicalRef || Object.prototype.hasOwnProperty.call(canonical, 'target')
    || focus.kind !== 'no_focus' || focus.ref !== ref || focus.latestCorrections !== corrections
    || !acceptedNoFocusReport(transaction.c06, 'C06', ref, chat, corrections)
    || !acceptedNoFocusReport(transaction.c07, 'C07', ref, chat, corrections)
    || !acceptedEligibleC29(transaction.c29, pendingRef)) return undefined

  const exactDirect = (
    events: readonly SessionEvent[], id: string, hash: string, expectedText?: string,
  ): SessionEvent<'user/message'> | undefined => {
    const matches = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
      && String(event.data.id) === id)
    const event = matches[0]
    const text = event === undefined ? undefined : textMessage(event)
    return matches.length === 1 && event?.data.source.kind === 'user'
      && text !== undefined && (expectedText === undefined || text === expectedText)
      && createHash('sha256').update(id).update('\0').update(text).digest('hex') === hash
      ? event : undefined
  }
  const hasSameGenerationCanonical = (events: readonly SessionEvent[]): boolean => events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical'
      && event.data.source.generation === generation,
  )
  const liveClose = exactDirect(session.events, closeId, closeHash, '这件事结束了')
  const detachedClose = exactDirect(detached, closeId, closeHash, '这件事结束了')
  if (liveClose === undefined || detachedClose === undefined || liveClose.seq !== detachedClose.seq
    || hasSameGenerationCanonical(session.events) || hasSameGenerationCanonical(detached)) return undefined
  if (closureOnly) {
    const hasCanonical = (events: readonly SessionEvent[]): boolean => events.some(event =>
      event.type === 'user/message' && (event.data.source.kind === 'context-manager-canonical'
        || event.data.source.kind === 'context-manager-local-restriction'
        || event.data.source.kind === 'context-manager-no-safe-action'))
    const exactCloseCount = (events: readonly SessionEvent[]): number => events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user'
        && textMessage(event) === '这件事结束了').length
    const livePreContext = session.events.find(event => event.seq < liveClose.seq
      && (event.type === 'user/message' || event.type === 'assistant/message'))
    const detachedPreContext = livePreContext === undefined ? undefined : detached.find(event =>
      event.seq === livePreContext.seq && event.type === livePreContext.type)
    if (generation !== 1 || hasCanonical(session.events) || hasCanonical(detached)
      || exactCloseCount(session.events) !== 1 || exactCloseCount(detached) !== 1
      || livePreContext === undefined || detachedPreContext === undefined) return undefined
  } else {
    const livePreCanonical = exactDirect(session.events, preCanonicalId!, preCanonicalHash!)
    const detachedPreCanonical = exactDirect(detached, preCanonicalId!, preCanonicalHash!)
    if (preCanonicalId === closeId || livePreCanonical === undefined || detachedPreCanonical === undefined
      || livePreCanonical.seq !== detachedPreCanonical.seq || livePreCanonical.seq >= liveClose.seq) return undefined
  }

  const pending: PrivatePendingNoFocus = Object.freeze({
    state: Object.freeze({ kind: 'no_focus', ref: pendingRef as PendingCanonicalStateRef,
      focus: Object.freeze({ kind: 'no_focus', ref: ref as FocusDecisionRef, chat: chat as ChatRef, latestCorrections: corrections as CorrectionMeaning }) }),
    canonicalRef: canonicalRef as CanonicalStateRef,
    generation: generation as number,
    c06: transaction.c06 as C06Result,
    c07: transaction.c07 as C07Result,
    material: Object.freeze({ kind: 'no_focus_material', ref: materialRef as CompleteStateMaterialRef,
      target: chat as ChatRef, canonicalState: Object.freeze({ kind: 'no_focus', ref: canonicalRef as CanonicalStateRef,
        focus: Object.freeze({ kind: 'no_focus', ref: ref as FocusDecisionRef, latestCorrections: corrections as CorrectionMeaning }) }) }),
  })
  return Object.freeze({ record, pending, close: Object.freeze({ messageId: closeId, hash: closeHash }), transaction: transaction as unknown as CanonicalNoFocusTransaction })
}

const NO_FOCUS_CANONICAL_BODY = '当前没有正在进行的事项。请询问用户想开始哪件事。'

/** The replay uses only fields exact-validated by the raw decoder above. */
function replayMaterial(transaction: CanonicalNoFocusTransaction): CanonicalNoFocusMaterial {
  return {
    body: transaction.body,
    bodyHash: transaction.bodyHash,
    create: (pending, phase) => createUserMessage({
      content: [{ type: 'text', text: transaction.body }],
      source: {
        kind: 'context-manager-canonical', phase,
        pendingStateRef: pending.state.ref, canonicalStateRef: pending.canonicalRef,
        generation: pending.generation, chat: pending.state.focus.chat, bodyHash: transaction.bodyHash,
        machine: {
          kind: 'no_focus', focusRef: pending.state.focus.ref,
          latestCorrections: pending.state.focus.latestCorrections,
          closeMessageId: transaction.machine.closeMessageId, closeHash: transaction.machine.closeHash,
        },
      },
    }),
  }
}

function samePendingReplayIdentity(left: PrivatePendingNoFocus, right: PrivatePendingNoFocus): boolean {
  return left.state.ref === right.state.ref
    && left.canonicalRef === right.canonicalRef
    && left.generation === right.generation
    && left.c06 === right.c06 && left.c07 === right.c07
    && left.state.focus.ref === right.state.focus.ref
    && left.state.focus.chat === right.state.focus.chat
    && left.state.focus.latestCorrections === right.state.focus.latestCorrections
    && sameCompleteStateMaterial(left.material, right.material)
}

/** P-specific full-chain publication proof, before the finalized sidecar put. */
async function provePendingReplayPublication(
  input: PendingNoFocusReplayInput,
  pending: PrivatePendingNoFocus,
  transaction: CanonicalNoFocusTransaction,
  close: { readonly messageId: string; readonly hash: string },
  firstSeq: number,
  finalized: SessionEvent<'user/message'>,
): Promise<boolean> {
  if (!await input.flush()) return false
  const detached = await input.readFrom(0)
  const exactClose = (events: readonly SessionEvent[]): SessionEvent<'user/message'> | undefined => {
    const matches = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
      && String(event.data.id) === close.messageId)
    const event = matches[0]
    const text = event === undefined ? undefined : textMessage(event)
    return matches.length === 1 && event?.data.source.kind === 'user' && text === '这件事结束了'
      && createHash('sha256').update(close.messageId).update('\0').update(text).digest('hex') === close.hash ? event : undefined
  }
  const exactCanonical = (
    events: readonly SessionEvent[], phase: 'current' | 'finalized', seq: number, id: string,
  ): SessionEvent<'user/message'> | undefined => {
    const bySeq = events.filter(event => event.seq === seq)
    const event = bySeq[0]
    const byId = events.filter(candidate => candidate.type === 'user/message' && String(candidate.data.id) === id)
    return bySeq.length === 1 && byId.length === 1 && event?.type === 'user/message'
      && String(event.data.id) === id
      && canonicalEventMatches(event, phase, transaction, pending.state.focus.chat, pending.state.focus.ref,
        pending.state.focus.latestCorrections, close.messageId, close.hash, transaction.body, transaction.bodyHash)
      ? event : undefined
  }
  const finalId = String(finalized.data.id)
  const liveClose = exactClose(input.session.events)
  const detachedClose = exactClose(detached.events)
  const liveFirst = input.session.events.find((event): event is SessionEvent<'user/message'> =>
    event.seq === firstSeq && event.type === 'user/message')
  const liveCurrent = liveFirst === undefined ? undefined
    : exactCanonical(input.session.events, 'current', firstSeq, String(liveFirst.data.id))
  const detachedCurrent = liveCurrent === undefined ? undefined
    : exactCanonical(detached.events, 'current', firstSeq, String(liveCurrent.data.id))
  const liveFinalized = exactCanonical(input.session.events, 'finalized', finalized.seq, finalId)
  const detachedFinalized = exactCanonical(detached.events, 'finalized', finalized.seq, finalId)
  const derived = input.session.deriveMessages()
  const only = derived[0]
  const text = only?.content.length === 1 && only.content[0]?.type === 'text' ? only.content[0].text : undefined
  return liveClose !== undefined && detachedClose !== undefined && liveClose.seq === detachedClose.seq
    && liveCurrent !== undefined && detachedCurrent !== undefined && liveCurrent.seq === detachedCurrent.seq
    && liveFinalized !== undefined && detachedFinalized !== undefined && liveFinalized.seq === detachedFinalized.seq
    && derived.length === 1 && only?.id === finalized.data.id && only.source.kind === 'context-manager-canonical'
    && only.source.phase === 'finalized' && only.source.pendingStateRef === pending.state.ref
    && only.source.canonicalStateRef === pending.canonicalRef && only.source.generation === pending.generation
    && only.source.chat === pending.state.focus.chat && only.source.bodyHash === transaction.bodyHash
    && only.source.machine.kind === 'no_focus' && only.source.machine.focusRef === pending.state.focus.ref
    && only.source.machine.latestCorrections === pending.state.focus.latestCorrections
    && only.source.machine.closeMessageId === close.messageId && only.source.machine.closeHash === close.hash
    && text === transaction.body && createHash('sha256').update(text ?? '').digest('hex') === transaction.bodyHash
}

function isCompleteNoFocusMaterial(material: CompleteStateMaterial): boolean {
  return material.kind === 'no_focus_material'
    && material.ref.length > 0
    && material.target.length > 0
    && material.canonicalState.kind === 'no_focus'
    && material.canonicalState.ref.length > 0
    && material.canonicalState.focus.kind === 'no_focus'
    && material.canonicalState.focus.ref.length > 0
    && material.canonicalState.focus.latestCorrections !== undefined
    && !Object.prototype.hasOwnProperty.call(material.canonicalState, 'target')
}

function isCompleteLocalRestrictionMaterial(
  material: CompleteStateMaterial<'local_restriction', PreservedLocalRestrictionBoundary>,
): boolean {
  const state = material.canonicalState
  const boundary = state.boundary
  return state.kind === 'local_restriction'
    && material.ref.length > 0
    && material.target.length > 0
    && state.ref.length > 0
    && state.focus.kind === 'focus_established'
    && state.focus.ref.length > 0
    && state.focus.currentMatter !== undefined
    && state.focus.latestCorrections !== undefined
    && boundary.kind === 'local_restriction'
    && nonemptyString(boundary.ref)
    && validRequiredFacts(boundary.requiredFacts)
    && boundary.usableFacts.every(validUsableFact)
    && boundary.unresolvedFacts.every(validUnresolvedFact)
    && validStringList(boundary.preciselyBlockedActions, true)
    && validStringList(boundary.safelyContinuableActions, true)
    && !Object.prototype.hasOwnProperty.call(boundary, 'chat')
    && !Object.prototype.hasOwnProperty.call(state, 'target')
}

function isCompleteNoSafeActionMaterial(
  material: CompleteStateMaterial<'no_safe_action', PreservedNoSafeActionBoundary>,
): boolean {
  const state = material.canonicalState
  const boundary = state.boundary
  return state.kind === 'no_safe_action'
    && material.ref.length > 0
    && material.target.length > 0
    && state.ref.length > 0
    && state.focus.kind === 'focus_established'
    && state.focus.ref.length > 0
    && state.focus.currentMatter !== undefined
    && state.focus.latestCorrections !== undefined
    && boundary.kind === 'no_safe_action'
    && nonemptyString(boundary.ref)
    && validRequiredFacts(boundary.requiredFacts)
    && boundary.usableFacts.every(validUsableFact)
    && boundary.unresolvedFacts.every(validUnresolvedFact)
    && validStringList(boundary.preciselyBlockedActions, true)
    && boundary.safelyContinuableActions.length === 0
    && !Object.prototype.hasOwnProperty.call(boundary, 'chat')
    && !Object.prototype.hasOwnProperty.call(state, 'target')
}

function isCompleteBackgroundMaterial(
  material: CompleteStateMaterial<'background', PreservedActionBoundary>,
): boolean {
  const state = material.canonicalState
  const boundary = state.boundary
  return state.kind === 'background'
    && nonemptyString(material.ref) && nonemptyString(material.target)
    && nonemptyString(state.ref) && nonemptyString(state.candidateRef)
    && state.focus.kind === 'focus_established'
    && nonemptyString(state.focus.ref) && nonemptyString(state.focus.currentMatter)
    && state.focus.latestCorrections !== undefined
    && nonemptyString(boundary.ref)
    && validRequiredFacts(boundary.requiredFacts)
    && boundary.usableFacts.every(validUsableFact)
    && boundary.unresolvedFacts.every(validUnresolvedFact)
    && validStringList(boundary.preciselyBlockedActions)
    && validStringList(boundary.safelyContinuableActions)
    && (boundary.kind === 'actionable'
      ? boundary.preciselyBlockedActions.length === 0 && boundary.safelyContinuableActions.length > 0
      : boundary.kind === 'local_restriction'
        ? boundary.preciselyBlockedActions.length > 0 && boundary.safelyContinuableActions.length > 0
        : boundary.preciselyBlockedActions.length > 0 && boundary.safelyContinuableActions.length === 0)
    && !Object.prototype.hasOwnProperty.call(boundary, 'chat')
    && !Object.prototype.hasOwnProperty.call(state, 'target')
}

function sameRestoredFocusReport(report: C35Result, material: RestorableCompleteStateMaterial): boolean {
  if (report.kind !== 'business_result' || report.value.kind !== 'accepted_for_contract') return false
  const fact = report.value.value
  if (report.identity.contract !== 'C35'
    || report.identity.subject !== material.canonicalState.focus.ref
    || fact.target !== material.target
    || fact.focus.ref !== material.canonicalState.focus.ref
    || fact.focus.latestCorrections !== material.canonicalState.focus.latestCorrections) return false
  if (material.kind === 'no_focus_material') return fact.focus.kind === 'no_focus'
  return fact.focus.kind === 'focus_established'
    && fact.focus.currentMatter === material.canonicalState.focus.currentMatter
}

function sameRecoveryStateReports(
  c30: C30Result, c31: C31Result, material: RestorableCompleteStateMaterial,
): boolean {
  const hash = createHash('sha256').update(material.canonicalState.ref).update('\0').update(material.canonicalState.focus.ref)
  if (material.kind !== 'no_focus_material') hash.update('\0').update(material.canonicalState.boundary.ref)
  const pendingRef = `pending:${hash.digest('hex')}` as PendingCanonicalStateRef
  const recoverable = value(c30)
  const visible = value(c31)
  return c30.kind === 'business_result' && c30.identity.subject === pendingRef
    && c31.kind === 'business_result' && c31.identity.subject === pendingRef
    && recoverable?.kind === 'same_complete_state_already_recoverable'
    && recoverable.state === pendingRef
    && visible?.kind === 'same_state_already_uniquely_visible'
    && visible.state === pendingRef
}

/**
 * Private-proof construction for C37. This does not sign C37: the caller must
 * pass the result to CanonicalContextAuthority.acceptCanonicalRestoration.
 */
function formNoFocusCanonicalRestoration(
  readout: C34Result,
  restored: C35Result,
  c30: C30Result,
  c31: C31Result,
): CanonicalRestoration | undefined {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material' || stored.material.kind !== 'no_focus_material'
    || !isCompleteNoFocusMaterial(stored.material)) return undefined
  if (restored.kind !== 'business_result' || restored.value.kind !== 'accepted_for_contract') return undefined
  const fact = restored.value.value
  if (fact.target !== stored.material.target
    || fact.focus.kind !== 'no_focus'
    || fact.focus.ref !== stored.material.canonicalState.focus.ref
    || fact.focus.latestCorrections !== stored.material.canonicalState.focus.latestCorrections
    || restored.identity.subject !== fact.focus.ref) return undefined
  const recoverable = value(c30)
  const visible = value(c31)
  const pendingRef = `pending:${createHash('sha256')
    .update(stored.material.canonicalState.ref)
    .update('\0')
    .update(fact.focus.ref)
    .digest('hex')}` as PendingCanonicalStateRef
  if (recoverable?.kind !== 'same_complete_state_already_recoverable'
    || recoverable.state !== pendingRef
    || visible?.kind !== 'same_state_already_uniquely_visible'
    || visible.state !== pendingRef) return undefined
  return {
    kind: 'no_focus_restored',
    material: stored.material,
    restorationProof: `restoration:${crypto.randomUUID()}` as CanonicalRestorationProofRef,
    recoverableProof: recoverable.proof,
    visibleProof: visible.proof,
  }
}

function formLocalCanonicalRestoration(
  readout: C34Result,
  restored: C35Result,
  c36: ActionBoundaryC36Result,
  c30: C30Result,
  c31: C31Result,
): LocalRestrictionCanonicalRestoration | undefined {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material' || stored.material.kind !== 'local_restriction_material'
    || !isCompleteLocalRestrictionMaterial(stored.material)) return undefined
  if (restored.kind !== 'business_result' || restored.value.kind !== 'accepted_for_contract'
    || !sameRestoredFocusReport(restored, stored.material)) return undefined
  const boundary = stored.material.canonicalState.boundary
  const acceptedBoundary = c36.kind === 'business_result' && c36.value.kind === 'accepted_for_contract'
    ? c36.value.value : undefined
  if (c36.kind !== 'business_result' || c36.identity.contract !== 'C36'
    || c36.identity.subject !== boundary.ref || acceptedBoundary === undefined
    || acceptedBoundary.target !== stored.material.target
    || acceptedBoundary.boundary.kind !== 'local_restriction'
    || !samePreservedActionBoundary(acceptedBoundary.boundary, boundary)) return undefined
  const recoverable = value(c30)
  const visible = value(c31)
  const pendingRef = `pending:${createHash('sha256')
    .update(stored.material.canonicalState.ref).update('\0')
    .update(stored.material.canonicalState.focus.ref).update('\0').update(boundary.ref)
    .digest('hex')}` as PendingCanonicalStateRef
  if (recoverable?.kind !== 'same_complete_state_already_recoverable' || recoverable.state !== pendingRef
    || visible?.kind !== 'same_state_already_uniquely_visible' || visible.state !== pendingRef) return undefined
  return {
    kind: 'local_restriction_restored', material: stored.material,
    restorationProof: `restoration:${crypto.randomUUID()}` as CanonicalRestorationProofRef,
    recoverableProof: recoverable.proof, visibleProof: visible.proof,
  }
}

function formNoSafeCanonicalRestoration(
  readout: C34Result,
  restored: C35Result,
  c36: ActionBoundaryC36Result,
  c30: C30Result,
  c31: C31Result,
): NoSafeActionCanonicalRestoration | undefined {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material' || stored.material.kind !== 'no_safe_action_material'
    || !isCompleteNoSafeActionMaterial(stored.material)) return undefined
  if (restored.kind !== 'business_result' || restored.value.kind !== 'accepted_for_contract'
    || !sameRestoredFocusReport(restored, stored.material)) return undefined
  const boundary = stored.material.canonicalState.boundary
  const acceptedBoundary = c36.kind === 'business_result' && c36.value.kind === 'accepted_for_contract'
    ? c36.value.value : undefined
  if (c36.kind !== 'business_result' || c36.identity.contract !== 'C36'
    || c36.identity.subject !== boundary.ref || acceptedBoundary === undefined
    || acceptedBoundary.target !== stored.material.target
    || acceptedBoundary.boundary.kind !== 'no_safe_action'
    || !samePreservedActionBoundary(acceptedBoundary.boundary, boundary)) return undefined
  const recoverable = value(c30)
  const visible = value(c31)
  const pendingRef = `pending:${createHash('sha256')
    .update(stored.material.canonicalState.ref).update('\0')
    .update(stored.material.canonicalState.focus.ref).update('\0').update(boundary.ref)
    .digest('hex')}` as PendingCanonicalStateRef
  if (recoverable?.kind !== 'same_complete_state_already_recoverable' || recoverable.state !== pendingRef
    || visible?.kind !== 'same_state_already_uniquely_visible' || visible.state !== pendingRef) return undefined
  return {
    kind: 'no_safe_action_restored', material: stored.material,
    restorationProof: `restoration:${crypto.randomUUID()}` as CanonicalRestorationProofRef,
    recoverableProof: recoverable.proof, visibleProof: visible.proof,
  }
}

function formBackgroundCanonicalRestoration(
  readout: C34Result,
  restored: C35Result,
  c36: ActionBoundaryC36Result,
  c30: C30Result,
  c31: C31Result,
): BackgroundCanonicalRestoration | undefined {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material' || stored.material.kind !== 'background_material'
    || !isCompleteBackgroundMaterial(stored.material)) return undefined
  if (!sameRestoredFocusReport(restored, stored.material)) return undefined
  const boundary = stored.material.canonicalState.boundary
  const acceptedBoundary = c36.kind === 'business_result' && c36.value.kind === 'accepted_for_contract'
    ? c36.value.value : undefined
  if (c36.kind !== 'business_result' || c36.identity.contract !== 'C36'
    || c36.identity.subject !== boundary.ref || acceptedBoundary === undefined
    || acceptedBoundary.target !== stored.material.target
    || !samePreservedActionBoundary(acceptedBoundary.boundary, boundary)) return undefined
  const recoverable = value(c30)
  const visible = value(c31)
  const pendingRef = `pending:${createHash('sha256')
    .update(stored.material.canonicalState.ref).update('\0')
    .update(stored.material.canonicalState.focus.ref).update('\0').update(boundary.ref)
    .digest('hex')}` as PendingCanonicalStateRef
  if (recoverable?.kind !== 'same_complete_state_already_recoverable' || recoverable.state !== pendingRef
    || visible?.kind !== 'same_state_already_uniquely_visible' || visible.state !== pendingRef) return undefined
  return {
    kind: 'background_restored', material: stored.material,
    restorationProof: `restoration:${crypto.randomUUID()}` as CanonicalRestorationProofRef,
    recoverableProof: recoverable.proof, visibleProof: visible.proof,
  }
}

/** No-focus compatibility dispatch; local recovery requires the additional exact C36 report. */
function formCanonicalRestoration(
  readout: C34Result,
  restored: C35Result,
  c30: C30Result,
  c31: C31Result,
): CanonicalRestoration | undefined {
  if (readout.kind !== 'business_result' || readout.value.kind !== 'accepted_for_contract') return undefined
  const stored = readout.value.value
  if (stored.kind !== 'existing_material') return undefined
  if (stored.material.kind === 'no_focus_material') return formNoFocusCanonicalRestoration(readout, restored, c30, c31)
  return undefined
}

/** Private technical gate: physical publication evidence, never a Cnn signer. */
class FinalizedPublicationProbe {
  async prove(
    input: {
      readonly close: { readonly messageId: string; readonly hash: string }
      readonly flush: () => Promise<boolean>
      readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
      readonly material: Pick<CanonicalNoFocusMaterial, 'body' | 'bodyHash'>
    },
    pending: PrivatePendingNoFocus | PrivatePendingLocalRestriction | PrivatePendingNoSafeAction | PrivatePendingBackground,
    finalized: SessionEvent<'user/message'>,
  ): Promise<void> {
    if (!await input.flush()) throw new Error('canonical finalized publication has no persistence listener')
    const detached = await input.readFrom(finalized.seq)
    const sameSeq = detached.events.filter(event => event.seq === finalized.seq)
    const sameId = detached.events.filter(event => event.type === 'user/message' && event.data.id === finalized.data.id)
    const event = sameSeq[0]
    const text = event?.type === 'user/message' && event.data.content.length === 1 && event.data.content[0]?.type === 'text'
      ? event.data.content[0].text : undefined
    const bodyHash = text === undefined ? undefined : createHash('sha256').update(text).digest('hex')
    if (sameSeq.length !== 1 || sameId.length !== 1 || event?.type !== 'user/message'
      || event.data.id !== finalized.data.id
      || (event.data.source.kind !== 'context-manager-canonical'
        && event.data.source.kind !== 'context-manager-local-restriction'
        && event.data.source.kind !== 'context-manager-no-safe-action')
      || !canonicalSourceMatches(event.data.source, pending, 'finalized', input.close)
      || text !== input.material.body || bodyHash !== input.material.bodyHash || event.data.source.bodyHash !== bodyHash) {
      throw new Error('finalized canonical detached readback changed identity')
    }
  }
}

/** Consumer only receives an already-formed CurrentContextState and emits C32. */
export class CurrentContextConsumer {
  acceptCurrentContext(state: CurrentContextState): CurrentContextConsumerResult
  acceptCurrentContext(state: LocalRestrictionCurrentContextState): LocalRestrictionCurrentContextConsumerResult
  acceptCurrentContext(state: NoSafeActionCurrentContextState): NoSafeActionCurrentContextConsumerResult
  acceptCurrentContext(state: BackgroundCurrentContextState): BackgroundCurrentContextConsumerResult
  acceptCurrentContext(state: FixedCurrentContextState): FixedCurrentContextConsumerResult {
    const subject: CanonicalCurrentContextSubject = { kind: 'canonical_state', state: state.state.ref }
    if (isNoFocusCurrentContextState(state)) {
      const accepted: CurrentContextAccepted = { kind: 'current_context_accepted', state }
      return { kind: 'business_result', identity: call('C32', subject), value: accepted }
    }
    if (isLocalRestrictionCurrentContextState(state)) {
      const accepted: LocalRestrictionCurrentContextAccepted = {
        kind: 'current_context_accepted', state,
      }
      return { kind: 'business_result', identity: call('C32', subject), value: accepted }
    }
    if (isNoSafeActionCurrentContextState(state)) {
      const accepted: NoSafeActionCurrentContextAccepted = {
        kind: 'current_context_accepted', state,
      }
      return { kind: 'business_result', identity: call('C32', subject), value: accepted }
    }
    if (isBackgroundCurrentContextState(state)) {
      const accepted: BackgroundCurrentContextAccepted = {
        kind: 'current_context_accepted', state,
      }
      return { kind: 'business_result', identity: call('C32', subject), value: accepted }
    }
    throw new Error('current-context consumer received an unknown fixed family')
  }
}

function isNoFocusCurrentContextState(state: FixedCurrentContextState): state is CurrentContextState {
  return state.state.kind === 'no_focus'
}

function isLocalRestrictionCurrentContextState(
  state: FixedCurrentContextState,
): state is LocalRestrictionCurrentContextState {
  return state.state.kind === 'local_restriction'
}

function isNoSafeActionCurrentContextState(
  state: FixedCurrentContextState,
): state is NoSafeActionCurrentContextState {
  return state.state.kind === 'no_safe_action'
}

function isBackgroundCurrentContextState(
  state: FixedCurrentContextState,
): state is BackgroundCurrentContextState {
  return state.state.kind === 'background'
}

type CanonicalTransactionReports<Result extends FixedCurrentContextConsumerResult> = {
  readonly c33?: C33Result
  readonly c30?: C30Result
  readonly firstC31?: C31Result
  readonly firstC32?: Result
  readonly finalizedC31?: C31Result
  readonly finalizedC32?: Result
}

interface CanonicalSuffixCommon {
  readonly session: Agent['session']
  readonly preservation: EffectiveStatePreservation
  readonly authority: CanonicalContextAuthority
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  /** Cold clean-pending replay retains the already-issued exact C29 object. */
  readonly retainedC29?: C29Result
}
interface NoFocusCanonicalSuffixInput extends CanonicalSuffixCommon {
  readonly family: 'no_focus'
  readonly pending: PrivatePendingNoFocus
  readonly material: CanonicalNoFocusMaterial
  readonly save: (record: CanonicalNoFocusTransaction) => Promise<void>
}
interface LocalRestrictionCanonicalSuffixInput extends CanonicalSuffixCommon {
  readonly family: 'local_restriction'
  readonly pending: PrivatePendingLocalRestriction
  readonly material: CanonicalLocalRestrictionMaterial
  readonly save: (record: CanonicalLocalRestrictionTransaction) => Promise<void>
}
interface NoSafeActionCanonicalSuffixInput extends CanonicalSuffixCommon {
  readonly family: 'no_safe_action'
  readonly pending: PrivatePendingNoSafeAction
  readonly material: CanonicalNoSafeActionMaterial
  readonly save: (record: CanonicalNoSafeActionTransaction) => Promise<void>
}
interface BackgroundCanonicalSuffixInput extends CanonicalSuffixCommon {
  readonly family: 'background'
  readonly pending: PrivatePendingBackground
  readonly material: CanonicalBackgroundMaterial
  readonly save: (record: CanonicalBackgroundTransaction) => Promise<void>
}
type CanonicalSuffixInput = NoFocusCanonicalSuffixInput | LocalRestrictionCanonicalSuffixInput
  | NoSafeActionCanonicalSuffixInput | BackgroundCanonicalSuffixInput

function suffixMessage(input: CanonicalSuffixInput, phase: 'current' | 'finalized'): UserMessage {
  return input.family === 'no_focus'
    ? input.material.create(input.pending, phase)
    : input.family === 'local_restriction'
      ? createLocalRestrictionCanonicalMessage(input.pending, input.material, phase)
      : input.family === 'no_safe_action'
        ? createNoSafeActionCanonicalMessage(input.pending, input.material, phase)
        : input.material.create(input.pending, phase)
}

function suffixCurrentState(
  input: CanonicalSuffixInput,
  c30: C30Result,
  c31: C31Result,
): FixedCurrentContextState | undefined {
  const port = canonicalAuthorityPort(input.authority)
  return input.family === 'no_focus'
    ? port.formCurrentContext(input.pending, c30, c31)
    : input.family === 'local_restriction'
      ? port.formLocalCurrentContext(input.pending, c30, c31)
      : input.family === 'no_safe_action'
        ? port.formNoSafeCurrentContext(input.pending, c30, c31)
        : port.formBackgroundCurrentContext(input.pending, c30, c31)
}

function consumeSuffixCurrent(state: FixedCurrentContextState): FixedCurrentContextConsumerResult {
  const consumer = new CurrentContextConsumer()
  return isNoFocusCurrentContextState(state)
    ? consumer.acceptCurrentContext(state)
    : isLocalRestrictionCurrentContextState(state)
      ? consumer.acceptCurrentContext(state)
      : isNoSafeActionCurrentContextState(state)
        ? consumer.acceptCurrentContext(state)
        : consumer.acceptCurrentContext(state)
}

function isNoFocusCurrentContextResult(
  report: FixedCurrentContextConsumerResult,
): report is CurrentContextConsumerResult {
  return report.value.state.state.kind === 'no_focus'
}

function isLocalRestrictionCurrentContextResult(
  report: FixedCurrentContextConsumerResult,
): report is LocalRestrictionCurrentContextConsumerResult {
  return report.value.state.state.kind === 'local_restriction'
}

function isNoSafeActionCurrentContextResult(
  report: FixedCurrentContextConsumerResult,
): report is NoSafeActionCurrentContextConsumerResult {
  return report.value.state.state.kind === 'no_safe_action'
}

function isBackgroundCurrentContextResult(
  report: FixedCurrentContextConsumerResult,
): report is BackgroundCurrentContextConsumerResult {
  return report.value.state.state.kind === 'background'
}

function noFocusTransactionReports(
  reports: CanonicalTransactionReports<FixedCurrentContextConsumerResult>,
): reports is CanonicalTransactionReports<CurrentContextConsumerResult> {
  return (reports.firstC32 === undefined || isNoFocusCurrentContextResult(reports.firstC32))
    && (reports.finalizedC32 === undefined || isNoFocusCurrentContextResult(reports.finalizedC32))
}

function localRestrictionTransactionReports(
  reports: CanonicalTransactionReports<FixedCurrentContextConsumerResult>,
): reports is CanonicalTransactionReports<LocalRestrictionCurrentContextConsumerResult> {
  return (reports.firstC32 === undefined || isLocalRestrictionCurrentContextResult(reports.firstC32))
    && (reports.finalizedC32 === undefined || isLocalRestrictionCurrentContextResult(reports.finalizedC32))
}

function noSafeActionTransactionReports(
  reports: CanonicalTransactionReports<FixedCurrentContextConsumerResult>,
): reports is CanonicalTransactionReports<NoSafeActionCurrentContextConsumerResult> {
  return (reports.firstC32 === undefined || isNoSafeActionCurrentContextResult(reports.firstC32))
    && (reports.finalizedC32 === undefined || isNoSafeActionCurrentContextResult(reports.finalizedC32))
}

function backgroundTransactionReports(
  reports: CanonicalTransactionReports<FixedCurrentContextConsumerResult>,
): reports is CanonicalTransactionReports<BackgroundCurrentContextConsumerResult> {
  return (reports.firstC32 === undefined || isBackgroundCurrentContextResult(reports.firstC32))
    && (reports.finalizedC32 === undefined || isBackgroundCurrentContextResult(reports.finalizedC32))
}

function suffixRecord(
  input: NoFocusCanonicalSuffixInput,
  phase: CanonicalNoFocusTransaction['phase'], c29: C29Result, firstReplaceSeq?: number, finalizedReplaceSeq?: number,
  reports?: CanonicalTransactionReports<CurrentContextConsumerResult>,
): CanonicalNoFocusTransaction
function suffixRecord(
  input: LocalRestrictionCanonicalSuffixInput,
  phase: CanonicalLocalRestrictionTransaction['phase'], c29: C29Result, firstReplaceSeq?: number, finalizedReplaceSeq?: number,
  reports?: CanonicalTransactionReports<LocalRestrictionCurrentContextConsumerResult>,
): CanonicalLocalRestrictionTransaction
function suffixRecord(
  input: NoSafeActionCanonicalSuffixInput,
  phase: CanonicalNoSafeActionTransaction['phase'], c29: C29Result, firstReplaceSeq?: number, finalizedReplaceSeq?: number,
  reports?: CanonicalTransactionReports<NoSafeActionCurrentContextConsumerResult>,
): CanonicalNoSafeActionTransaction
function suffixRecord(
  input: BackgroundCanonicalSuffixInput,
  phase: CanonicalBackgroundTransaction['phase'], c29: C29Result, firstReplaceSeq?: number, finalizedReplaceSeq?: number,
  reports?: CanonicalTransactionReports<BackgroundCurrentContextConsumerResult>,
): CanonicalBackgroundTransaction
function suffixRecord(
  input: CanonicalSuffixInput,
  phase: CanonicalNoFocusTransaction['phase'], c29: C29Result, firstReplaceSeq?: number, finalizedReplaceSeq?: number,
  reports?: CanonicalTransactionReports<FixedCurrentContextConsumerResult>,
): CanonicalNoFocusTransaction | CanonicalLocalRestrictionTransaction | CanonicalNoSafeActionTransaction | CanonicalBackgroundTransaction {
  if (input.family === 'no_focus') {
    const pending = input.pending
    if (reports !== undefined && !noFocusTransactionReports(reports)) {
      throw new Error('fixed no-focus suffix received foreign C32 reports')
    }
    const exactReports = reports
    return {
      phase, pendingRef: pending.state.ref, canonicalRef: pending.canonicalRef, generation: pending.generation,
      machine: { kind: 'no_focus', focusRef: pending.state.focus.ref, chat: pending.state.focus.chat,
        latestCorrections: pending.state.focus.latestCorrections, closeMessageId: input.close.messageId, closeHash: input.close.hash },
      body: input.material.body, bodyHash: input.material.bodyHash, material: pending.material,
      c06: pending.c06, c07: pending.c07, c29, ...(exactReports ?? {}),
      ...(firstReplaceSeq === undefined ? {} : { firstReplaceSeq }),
      ...(finalizedReplaceSeq === undefined ? {} : { finalizedReplaceSeq }),
    }
  }
  if (input.family === 'local_restriction') {
    const pending = input.pending
    const boundary = pending.state.boundary
    const preserved = preserveActionBoundary(boundary)
    if (reports !== undefined && !localRestrictionTransactionReports(reports)) {
      throw new Error('fixed local suffix received foreign C32 reports')
    }
    const exactReports = reports
    return {
      family: 'local_restriction', phase,
      pendingRef: pending.state.ref, canonicalRef: pending.canonicalRef, generation: pending.generation,
      machine: {
        kind: 'local_restriction', focusRef: pending.state.focus.ref,
        currentMatter: pending.state.focus.currentMatter, latestCorrections: pending.state.focus.latestCorrections,
        boundaryRef: boundary.ref, requiredFacts: preserved.requiredFacts,
        usableFacts: preserved.usableFacts, unresolvedFacts: preserved.unresolvedFacts,
        preciselyBlockedActions: preserved.preciselyBlockedActions,
        safelyContinuableActions: preserved.safelyContinuableActions,
        originMessageId: input.material.origin.messageId, originHash: input.material.origin.hash,
      },
      body: input.material.body, bodyHash: input.material.bodyHash, material: pending.material,
      c06: pending.c06, c02: pending.c02, c20: pending.c20, c21: pending.c21, c22: pending.c22, c29,
      ...(exactReports ?? {}),
      ...(firstReplaceSeq === undefined ? {} : { firstReplaceSeq }),
      ...(finalizedReplaceSeq === undefined ? {} : { finalizedReplaceSeq }),
    }
  }
  if (input.family === 'background') {
    const pending = input.pending
    const candidate = pending.decision.candidate
    if (reports !== undefined && !backgroundTransactionReports(reports)) {
      throw new Error('background suffix received foreign C32 reports')
    }
    const exactReports = reports
    return {
      family: 'background', phase,
      pendingRef: pending.state.ref, canonicalRef: pending.canonicalRef, generation: pending.generation,
      machine: {
        kind: 'background', candidateRef: candidate.ref,
        focusRef: pending.state.focus.ref, currentMatter: pending.state.focus.currentMatter,
        latestCorrections: pending.state.focus.latestCorrections,
        boundaryRef: pending.state.boundary.ref, evidenceRef: candidate.formationEvidence.ref,
        originMessageId: input.material.origin.messageId, originHash: input.material.origin.hash,
      },
      body: input.material.body, bodyHash: input.material.bodyHash, material: pending.material,
      c28: pending.c28, c06: pending.c06, c20: pending.c20, c29,
      ...(exactReports ?? {}),
      ...(firstReplaceSeq === undefined ? {} : { firstReplaceSeq }),
      ...(finalizedReplaceSeq === undefined ? {} : { finalizedReplaceSeq }),
    }
  }
  const pending = input.pending
  const boundary = pending.state.boundary
  const preserved = preserveNoSafeActionBoundary(boundary)
  if (reports !== undefined && !noSafeActionTransactionReports(reports)) {
    throw new Error('fixed no-safe suffix received foreign C32 reports')
  }
  const exactReports = reports
  return {
    family: 'no_safe_action', phase,
    pendingRef: pending.state.ref, canonicalRef: pending.canonicalRef, generation: pending.generation,
    machine: {
      kind: 'no_safe_action', focusRef: pending.state.focus.ref,
      currentMatter: pending.state.focus.currentMatter, latestCorrections: pending.state.focus.latestCorrections,
      boundaryRef: boundary.ref, requiredFacts: preserved.requiredFacts,
      usableFacts: preserved.usableFacts, unresolvedFacts: preserved.unresolvedFacts,
      preciselyBlockedActions: preserved.preciselyBlockedActions,
      safelyContinuableActions: preserved.safelyContinuableActions,
      originMessageId: input.material.origin.messageId, originHash: input.material.origin.hash,
    },
    body: input.material.body, bodyHash: input.material.bodyHash, material: pending.material,
    c06: pending.c06, c02: pending.c02, c20: pending.c20, c21: pending.c21, c22: pending.c22, c29,
    ...(exactReports ?? {}),
    ...(firstReplaceSeq === undefined ? {} : { firstReplaceSeq }),
    ...(finalizedReplaceSeq === undefined ? {} : { finalizedReplaceSeq }),
  }
}

async function saveSuffixRecord(
  input: CanonicalSuffixInput,
  record: CanonicalNoFocusTransaction | CanonicalLocalRestrictionTransaction
    | CanonicalNoSafeActionTransaction | CanonicalBackgroundTransaction,
): Promise<void> {
  if (input.family === 'no_focus') {
    if ('family' in record) throw new Error('fixed no-focus suffix received a foreign family record')
    await input.save(record)
  } else if (input.family === 'local_restriction') {
    if (!('family' in record) || record.family !== 'local_restriction') throw new Error('fixed local suffix received a foreign family record')
    await input.save(record)
  } else if (input.family === 'no_safe_action') {
    if (!('family' in record) || record.family !== 'no_safe_action') throw new Error('fixed no-safe suffix received a foreign family record')
    await input.save(record)
  } else {
    if (!('family' in record) || record.family !== 'background') throw new Error('background suffix received a foreign family record')
    await input.save(record)
  }
}

/** Family-neutral C29 -> C33/C30 -> C31/C32 x2 -> detached publication suffix. */
async function runCanonicalTransactionSuffix(
  input: NoFocusCanonicalSuffixInput,
): Promise<{ readonly current: CurrentContextConsumerResult; readonly finalizedSeq: number; readonly record: CanonicalNoFocusTransaction }>
async function runCanonicalTransactionSuffix(
  input: LocalRestrictionCanonicalSuffixInput,
): Promise<{ readonly current: LocalRestrictionCurrentContextConsumerResult; readonly finalizedSeq: number; readonly record: CanonicalLocalRestrictionTransaction }>
async function runCanonicalTransactionSuffix(
  input: NoSafeActionCanonicalSuffixInput,
): Promise<{ readonly current: NoSafeActionCurrentContextConsumerResult; readonly finalizedSeq: number; readonly record: CanonicalNoSafeActionTransaction }>
async function runCanonicalTransactionSuffix(
  input: BackgroundCanonicalSuffixInput,
): Promise<{ readonly current: BackgroundCurrentContextConsumerResult; readonly finalizedSeq: number; readonly record: CanonicalBackgroundTransaction }>
async function runCanonicalTransactionSuffix(
  input: CanonicalSuffixInput,
): Promise<{ readonly current: FixedCurrentContextConsumerResult; readonly finalizedSeq: number; readonly record: CanonicalNoFocusTransaction | CanonicalLocalRestrictionTransaction | CanonicalNoSafeActionTransaction | CanonicalBackgroundTransaction }> {
  const probe = new FinalizedPublicationProbe()
  const { pending } = input
  let pendingRecord: CanonicalNoFocusTransaction | CanonicalLocalRestrictionTransaction
    | CanonicalNoSafeActionTransaction | CanonicalBackgroundTransaction | undefined
  const persistence = new StatePersistence(async material => {
    if (pendingRecord === undefined || !sameCompleteStateMaterial(pendingRecord.material, material)) {
      throw new Error('C33 sidecar record is not ready for this complete state material')
    }
    await saveSuffixRecord(input, pendingRecord)
  }, pending.material)
  const saveCapability = statePersistenceCapability(persistence)
  let saved: C33Result | undefined
  const binding: PreservationBinding = {
    state: pending.state,
    material: pending.material,
    canonicalRef: pending.canonicalRef,
    expectedMaterialRef: pending.material.ref,
    persistence,
    saveCapability,
    saved: () => saved,
    saveComplete: async state => {
      if (state !== pending.state) throw new Error('C33 state identity changed')
      const report = await saveCapability(pending.material)
      saved = report
      return report
    },
  }
  let bound = false
  try {
    bindCompleteMaterial(input.preservation, pending.state, binding)
    bound = true
    const c29 = input.retainedC29 ?? input.preservation.checkPreservationEligibility(pending.state)
    if (value(c29)?.kind !== 'eligible') throw new Error('C29 failed')
    pendingRecord = input.family === 'no_focus'
      ? suffixRecord(input, 'pending', c29)
      : input.family === 'local_restriction'
        ? suffixRecord(input, 'pending', c29)
        : input.family === 'no_safe_action'
          ? suffixRecord(input, 'pending', c29)
          : suffixRecord(input, 'pending', c29)
    const c30 = await input.preservation.establishRecoverablePreservation(pending.state)
    const c33 = binding.saved()
    if (value(c30) === undefined || c33 === undefined || value(c33) === undefined) throw new Error('C30/C33 failed')
    let visible: VisibleRuntime | undefined
    const replacement = new UniqueVisibleContextReplacement(() => visible)
    const first = replaceSurface(input.session, pending, suffixMessage(input, 'current'))
    const firstMessage = input.session.events.find((event): event is SessionEvent<'user/message'> =>
      event.seq === first && event.type === 'user/message')?.data
    if (firstMessage === undefined) throw new Error('current replacement was not logged')
    visible = { session: input.session, pending, message: firstMessage, seq: first, phase: 'current', material: input.material, close: input.close }
    const firstC31 = replacement.replaceVisibleContext(pending.state)
    if (value(firstC31) === undefined) throw new Error('first C31 failed')
    const firstState = suffixCurrentState(input, c30, firstC31)
    if (firstState === undefined) throw new Error('first family facts/C30/C31 did not agree')
    const firstC32 = consumeSuffixCurrent(firstState)
    if (firstC32.identity.subject.state !== pending.canonicalRef || firstC32.value.state !== firstState) {
      throw new Error('first C32 did not consume the established current state')
    }
    const currentRecord = input.family === 'no_focus'
      ? isNoFocusCurrentContextResult(firstC32)
        ? suffixRecord(input, 'current', c29, first, undefined, { c33, c30, firstC31, firstC32 })
        : (() => { throw new Error('no-focus suffix formed a foreign first C32') })()
      : input.family === 'local_restriction'
        ? isLocalRestrictionCurrentContextResult(firstC32)
          ? suffixRecord(input, 'current', c29, first, undefined, { c33, c30, firstC31, firstC32 })
          : (() => { throw new Error('local suffix formed a foreign first C32') })()
        : input.family === 'no_safe_action'
          ? isNoSafeActionCurrentContextResult(firstC32)
            ? suffixRecord(input, 'current', c29, first, undefined, { c33, c30, firstC31, firstC32 })
            : (() => { throw new Error('no-safe suffix formed a foreign first C32') })()
          : isBackgroundCurrentContextResult(firstC32)
            ? suffixRecord(input, 'current', c29, first, undefined, { c33, c30, firstC31, firstC32 })
            : (() => { throw new Error('background suffix formed a foreign first C32') })()
    await saveSuffixRecord(input, currentRecord)
    const finalSeq = replaceSurface(input.session, pending, suffixMessage(input, 'finalized'))
    const finalEvent = input.session.events.find((event): event is SessionEvent<'user/message'> =>
      event.seq === finalSeq && event.type === 'user/message')
    if (finalEvent === undefined) throw new Error('finalized replacement was not logged')
    visible = { session: input.session, pending, message: finalEvent.data, seq: finalSeq, phase: 'finalized', material: input.material, close: input.close }
    const finalizedC31 = replacement.replaceVisibleContext(pending.state)
    if (value(finalizedC31) === undefined) throw new Error('finalized C31 failed')
    const finalizedState = suffixCurrentState(input, c30, finalizedC31)
    if (finalizedState === undefined) throw new Error('finalized family facts/C30/C31 did not agree')
    const current = consumeSuffixCurrent(finalizedState)
    if (current.identity.subject.state !== pending.canonicalRef || current.value.state !== finalizedState) {
      throw new Error('finalized C32 did not consume the established current state')
    }
    await probe.prove(input, pending, finalEvent)
    const record = input.family === 'no_focus'
      ? isNoFocusCurrentContextResult(firstC32) && isNoFocusCurrentContextResult(current)
        ? suffixRecord(input, 'finalized', c29, first, finalSeq, {
            c33, c30, firstC31, firstC32, finalizedC31, finalizedC32: current,
          })
        : (() => { throw new Error('no-focus suffix formed foreign finalized C32 reports') })()
      : input.family === 'local_restriction'
        ? isLocalRestrictionCurrentContextResult(firstC32) && isLocalRestrictionCurrentContextResult(current)
          ? suffixRecord(input, 'finalized', c29, first, finalSeq, {
              c33, c30, firstC31, firstC32, finalizedC31, finalizedC32: current,
            })
          : (() => { throw new Error('local suffix formed foreign finalized C32 reports') })()
        : input.family === 'no_safe_action'
          ? isNoSafeActionCurrentContextResult(firstC32) && isNoSafeActionCurrentContextResult(current)
            ? suffixRecord(input, 'finalized', c29, first, finalSeq, {
                c33, c30, firstC31, firstC32, finalizedC31, finalizedC32: current,
              })
            : (() => { throw new Error('no-safe suffix formed foreign finalized C32 reports') })()
          : isBackgroundCurrentContextResult(firstC32) && isBackgroundCurrentContextResult(current)
            ? suffixRecord(input, 'finalized', c29, first, finalSeq, {
                c33, c30, firstC31, firstC32, finalizedC31, finalizedC32: current,
              })
            : (() => { throw new Error('background suffix formed foreign finalized C32 reports') })()
    await saveSuffixRecord(input, record)
    return { current, finalizedSeq: finalSeq, record }
  } finally {
    if (bound) clearCompleteMaterial(input.preservation, pending.state)
  }
}

function exactLocalPhaseEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalLocalRestrictionTransaction,
  phase: 'current' | 'finalized',
): event is SessionEvent<'user/message'> {
  const focus = transaction.material.canonicalState.focus
  const boundary = rawPreservedActionBoundary(transaction.material.canonicalState.boundary as unknown as Record<string, unknown>)
  return boundary !== undefined && localCanonicalEventMatches(
    event, phase, transaction as unknown as Record<string, unknown>, transaction.material.target,
    focus.ref, focus.currentMatter, focus.latestCorrections, boundary,
    { messageId: transaction.machine.originMessageId, hash: transaction.machine.originHash },
    transaction.body, transaction.bodyHash,
  )
}

function exactLocalFinalizedEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalLocalRestrictionTransaction,
): event is SessionEvent<'user/message'> {
  return exactLocalPhaseEvent(event, transaction, 'finalized')
}

function exactRequiredEventEnvelope(event: SessionEvent | undefined, surface: boolean): boolean {
  const raw = object(event)
  return raw !== undefined
    && hasOnlyKeys(raw, surface
      ? ['type', 'seq', 'time', 'data', 'sourceEventSeqs', 'surfaceOp']
      : ['type', 'seq', 'time', 'data'])
    && Number.isSafeInteger(event?.seq) && typeof event?.time === 'number' && Number.isFinite(event.time)
}

function exactTextUserMessageObject(message: UserMessage, sourceKind: string): boolean {
  const raw = object(message)
  const source = object(message.source)
  const block = object(message.content[0])
  return raw !== undefined && source !== undefined && block !== undefined
    && hasOnlyKeys(raw, ['id', 'role', 'content', 'source'])
    && message.role === 'user' && String(message.id).length > 0
    && message.content.length === 1 && block.type === 'text' && typeof block.text === 'string'
    && hasOnlyKeys(block, ['type', 'text']) && message.source.kind === sourceKind
}

function exactUserAbortTurnEnd(
  event: SessionEvent | undefined,
  turn: number,
): event is SessionEvent<'turn/end'> {
  if (event?.type !== 'turn/end' || !exactRequiredEventEnvelope(event, false)) return false
  const data = object(event.data)
  const reason = data === undefined ? undefined : object(data.reason)
  const cause = reason === undefined ? undefined : object(reason.reason)
  return data !== undefined && reason !== undefined && cause !== undefined
    && hasOnlyKeys(data, ['turn', 'reason']) && event.data.turn === turn
    && hasOnlyKeys(reason, ['kind', 'reason']) && reason.kind === 'aborted'
    && hasOnlyKeys(cause, ['kind']) && cause.kind === 'user'
}

function exactSeedEvent(event: SessionEvent | undefined): boolean {
  const data = event?.type === 'session/end-seed' ? object(event.data) : undefined
  return event?.type === 'session/end-seed' && exactRequiredEventEnvelope(event, false)
    && data !== undefined && hasOnlyKeys(data, [])
}

function fixedRepairHistoryKind(
  events: readonly SessionEvent[],
  finalizedReplaceSeq: number,
  repairTargetReplaceSeq: number,
  normalSourceCount: 3 | 4,
): 'postcommit_abort' | 'normal' | 'unknown' {
  const turnEnds = events.filter(event => event.seq > finalizedReplaceSeq && event.seq < repairTargetReplaceSeq
    && event.type === 'turn/end')
  const target = events.find(event => event.seq === repairTargetReplaceSeq)
  const targetSurface = target?.type === 'user/message' ? object(target.surfaceOp) : undefined
  const sources = target?.type === 'user/message' ? target.sourceEventSeqs : undefined
  const exactReplaceSpan = targetSurface?.op === 'replace' && targetSurface.start === finalizedReplaceSeq
    && sources !== undefined && sources[0] === finalizedReplaceSeq
    && targetSurface.end === sources.at(-1)
  if (turnEnds.some(event => event.type === 'turn/end' && object(event.data.reason)?.kind === 'aborted')
    || exactReplaceSpan && sources?.length === 2) return 'postcommit_abort'
  return exactReplaceSpan && sources?.length === normalSourceCount && turnEnds.some(event =>
    event.type === 'turn/end' && object(event.data.reason)?.kind !== 'aborted')
    ? 'normal' : 'unknown'
}

function abortTurnStartSeq(
  events: readonly SessionEvent[],
  firstReplaceSeq: number,
): number | undefined {
  const firstIndex = events.findIndex(event => event.seq === firstReplaceSeq)
  if (firstIndex < 0) return undefined
  for (let index = firstIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    if (candidate?.type === 'turn/start') return candidate.seq
  }
  return undefined
}

interface RepairableCanonicalTransaction {
  readonly firstReplaceSeq?: number
  readonly finalizedReplaceSeq?: number
  readonly machine: {
    readonly originMessageId: string
    readonly originHash: string
  }
}

/**
 * Detached proof for the one user-aborted postcommit repair family.  The read
 * begins at the owner-issued turn start so a canonical-only resumed surface
 * cannot hide a changed current/finalized/direct/abort prefix.
 */
function exactDetachedPostcommitAbortRepair(
  events: readonly SessionEvent[],
  transaction: RepairableCanonicalTransaction,
  targetReplaceSeq: number,
  targetMessageId: string,
  exactCurrent: (event: SessionEvent | undefined) => boolean,
  exactFinalized: (event: SessionEvent | undefined) => boolean,
): boolean {
  const firstReplaceSeq = transaction.firstReplaceSeq
  const finalizedReplaceSeq = transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstReplaceSeq) || !Number.isSafeInteger(finalizedReplaceSeq)
    || !Number.isSafeInteger(targetReplaceSeq) || events.length < 7) return false

  const start = events[0]
  const inbox = events[1]
  const first = events[2]
  const finalized = events[3]
  const direct = events[4]
  const turnEnd = events[5]
  if (start?.type !== 'turn/start' || !exactRequiredEventEnvelope(start, false)
    || object(start.data) === undefined || !hasOnlyKeys(start.data as unknown as Record<string, unknown>, ['turn'])
    || !Number.isSafeInteger(start.data.turn)) return false
  if (inbox?.type !== 'agent/inbox/spliced' || !exactRequiredEventEnvelope(inbox, false)
    || object(inbox.data) === undefined
    || !hasOnlyKeys(inbox.data as unknown as Record<string, unknown>, ['target', 'start', 'removedCount', 'inserted'])
    || inbox.data.target !== 'next-turn' || inbox.data.start !== 0 || inbox.data.removedCount !== 1
    || inbox.data.inserted.length !== 0) return false
  if (first?.type !== 'user/message' || finalized?.type !== 'user/message'
    || first.seq !== firstReplaceSeq || finalized.seq !== finalizedReplaceSeq
    || !exactCurrent(first) || !exactFinalized(finalized)
    || !exactRequiredEventEnvelope(first, true) || !exactRequiredEventEnvelope(finalized, true)
    || !exactTextUserMessageObject(first.data, first.data.source.kind)
    || !exactTextUserMessageObject(finalized.data, finalized.data.source.kind)
    || first.data.source.kind !== finalized.data.source.kind
    || String(first.data.id) === String(finalized.data.id)) return false
  if (direct?.type !== 'user/message' || !exactRequiredEventEnvelope(direct, true)
    || !exactTextUserMessageObject(direct.data, 'user')
    || object(direct.data.source) === undefined
    || !hasOnlyKeys(direct.data.source as unknown as Record<string, unknown>, ['kind'])
    || direct.surfaceOp !== 'append' || direct.sourceEventSeqs !== undefined
    || String(direct.data.id) !== transaction.machine.originMessageId) return false
  const directBlock = direct.data.content[0]
  if (directBlock?.type !== 'text'
    || createHash('sha256').update(String(direct.data.id)).update('\0').update(directBlock.text).digest('hex')
      !== transaction.machine.originHash || !exactUserAbortTurnEnd(turnEnd, start.data.turn)) return false

  const finalizedSurface = object(finalized.surfaceOp)
  if (finalizedSurface === undefined || !hasOnlyKeys(finalizedSurface, ['op', 'start', 'end'])
    || finalizedSurface.op !== 'replace' || finalizedSurface.start !== first.seq || finalizedSurface.end !== first.seq
    || finalized.sourceEventSeqs?.length !== 1 || finalized.sourceEventSeqs[0] !== first.seq) return false

  for (let index = 1; index <= 5; index += 1) {
    if (events[index]?.seq !== start.seq + index) return false
  }
  const ids = [String(first.data.id), String(finalized.data.id), String(direct.data.id)]
  if (new Set(ids).size !== ids.length
    || ids.some(id => events.filter(event => event.type === 'user/message' && String(event.data.id) === id).length !== 1)) return false

  let cursor = 6
  let expectedSeq = turnEnd.seq + 1
  const beforeTarget = events[cursor]
  if (beforeTarget !== undefined && beforeTarget.seq < targetReplaceSeq) {
    if (beforeTarget.seq !== expectedSeq || !exactSeedEvent(beforeTarget)) return false
    cursor += 1
    expectedSeq += 1
  }
  const target = events[cursor]
  if (target?.type !== 'user/message' || target.seq !== targetReplaceSeq || target.seq !== expectedSeq
    || !exactRequiredEventEnvelope(target, true) || !exactFinalized(target)
    || !exactTextUserMessageObject(target.data, finalized.data.source.kind)
    || String(target.data.id) !== targetMessageId
    || String(target.data.id) === String(first.data.id) || String(target.data.id) === String(finalized.data.id)
    || String(target.data.id) === String(direct.data.id)
    || events.filter(event => event.type === 'user/message' && String(event.data.id) === targetMessageId).length !== 1
    || events.filter(event => event.type === 'user/message'
      && String(event.data.id) === transaction.machine.originMessageId).length !== 1) return false
  const targetSurface = object(target.surfaceOp)
  if (targetSurface === undefined || !hasOnlyKeys(targetSurface, ['op', 'start', 'end'])
    || targetSurface.op !== 'replace' || targetSurface.start !== finalized.seq || targetSurface.end !== direct.seq
    || target.sourceEventSeqs?.length !== 2
    || target.sourceEventSeqs[0] !== finalized.seq || target.sourceEventSeqs[1] !== direct.seq) return false
  const afterTarget = events[cursor + 1]
  return (afterTarget === undefined
      || afterTarget.seq === target.seq + 1 && exactSeedEvent(afterTarget))
    && events[cursor + 2] === undefined
}

/**
 * The sole incomplete live tail admitted to same-generation fixed-family
 * repair.  AgentLoop owns the append-only aborted turn marker; callers cannot
 * replace it with a boolean.  The exact event slice also prevents an earlier
 * foreign direct, notice, model/tool output, or second direct from being
 * hidden by the canonical surface replacement.
 */
function exactPostcommitAbortTail(
  session: Agent['session'],
  transaction: RepairableCanonicalTransaction,
  exactCurrent: (event: SessionEvent | undefined) => boolean,
  exactFinalized: (event: SessionEvent | undefined) => boolean,
): boolean {
  const firstReplaceSeq = transaction.firstReplaceSeq
  const finalizedReplaceSeq = transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstReplaceSeq) || !Number.isSafeInteger(finalizedReplaceSeq)) return false
  const visible = session.deriveMessages()
  const canonical = visible[0]
  const direct = visible[1]
  if (visible.length !== 2 || canonical === undefined || direct === undefined
    || canonical.role !== 'user' || direct.role !== 'user' || direct.source.kind !== 'user'
    || direct.content.length !== 1 || direct.content[0]?.type !== 'text'
    || String(direct.id) !== transaction.machine.originMessageId
    || createHash('sha256').update(String(direct.id)).update('\0').update(direct.content[0].text).digest('hex')
      !== transaction.machine.originHash) return false

  const firstEvents = session.events.filter(event => event.seq === firstReplaceSeq)
  const finalizedEvents = session.events.filter(event => event.seq === finalizedReplaceSeq)
  const first = firstEvents[0]
  const finalized = finalizedEvents[0]
  const directEvents = session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === transaction.machine.originMessageId)
  const directEvent = directEvents[0]
  if (firstEvents.length !== 1 || finalizedEvents.length !== 1 || directEvents.length !== 1
    || !exactCurrent(first) || !exactFinalized(finalized)
    || first?.type !== 'user/message' || finalized?.type !== 'user/message'
    || String(canonical.id) !== String(finalized.data.id) || directEvent?.data !== direct) return false

  const finalizedIndex = session.events.indexOf(finalized)
  const tail = session.events.slice(finalizedIndex + 1)
  const turnEnd = tail[1]
  const seed = tail[2]
  if (tail[0] !== directEvent || turnEnd?.type !== 'turn/end'
    || !exactUserAbortTurnEnd(turnEnd, turnEnd.data.turn)
    || (seed !== undefined && !exactSeedEvent(seed))
    || tail.length !== (seed === undefined ? 2 : 3)) return false

  const turn = turnEnd.data.turn
  const starts = session.events.filter(event => event.type === 'turn/start' && event.data.turn === turn)
  const ends = session.events.filter(event => event.type === 'turn/end' && event.data.turn === turn)
  const start = starts[0]
  if (starts.length !== 1 || ends.length !== 1 || ends[0] !== turnEnd || start?.type !== 'turn/start') return false
  const startIndex = session.events.indexOf(start)
  const endIndex = session.events.indexOf(turnEnd)
  const turnBody = session.events.slice(startIndex + 1, endIndex)
  return start.seq < (firstReplaceSeq as number)
    && (firstReplaceSeq as number) < (finalizedReplaceSeq as number)
    && (finalizedReplaceSeq as number) < directEvent.seq
    && turnBody.length === 4
    && turnBody[0]?.type === 'agent/inbox/spliced'
    && turnBody[1] === first
    && turnBody[2] === finalized
    && turnBody[3] === directEvent
}

function cleanLocalFinalizedSurface(
  session: Agent['session'],
  transaction: CanonicalLocalRestrictionTransaction,
  expectedId?: string,
): boolean {
  const derived = session.deriveMessages()
  const only = derived[0]
  if (derived.length !== 1 || only === undefined || only.role !== 'user'
    || expectedId !== undefined && String(only.id) !== expectedId) return false
  const events = session.events.filter(event => event.type === 'user/message' && String(event.data.id) === String(only.id))
  return events.length === 1 && exactLocalFinalizedEvent(events[0], transaction)
}

/** Whitelist only the natural single direct -> single text model answer tail. */
function exactNormalLocalTail(
  session: Agent['session'],
  transaction: CanonicalLocalRestrictionTransaction,
): boolean {
  const visible = session.deriveMessages()
  const canonical = visible[0]
  const direct = visible[1]
  const assistant = visible[2]
  if (visible.length !== 3 || canonical === undefined || direct === undefined || assistant === undefined
    || canonical.role !== 'user' || direct.role !== 'user' || assistant.role !== 'assistant'
    || direct.source.kind !== 'user' || assistant.source.kind !== 'model'
    || direct.content.length !== 1 || direct.content[0]?.type !== 'text'
    || assistant.content.length !== 1 || assistant.content[0]?.type !== 'text'
    || String(direct.id) !== transaction.machine.originMessageId
    || createHash('sha256').update(String(direct.id)).update('\0').update(direct.content[0].text).digest('hex')
      !== transaction.machine.originHash) return false
  const finalized = session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactLocalFinalizedEvent(finalized, transaction) || String(finalized.data.id) !== String(canonical.id)) return false
  const directEvents = session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === transaction.machine.originMessageId)
  const assistantEvents = session.events.filter((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message' && String(event.data.message.id) === String(assistant.id))
  if (directEvents.length !== 1 || assistantEvents.length !== 1 || directEvents[0]?.data !== direct) return false
  const tail = session.events.slice(session.events.indexOf(finalized) + 1)
  const start = tail[0]
  const directEvent = tail[1]
  if (start?.type !== 'step/start' || directEvent !== directEvents[0]) return false
  let cursor = 2
  let chunks = 0
  while (tail[cursor]?.type === 'assistant/chunk') {
    const chunk = tail[cursor]
    if (chunk?.type !== 'assistant/chunk' || chunk.data.turn !== start.data.turn || chunk.data.step !== start.data.step) return false
    chunks += 1
    cursor += 1
  }
  const assistantEvent = tail[cursor]
  const stepEnd = tail[cursor + 1]
  const turnEnd = tail[cursor + 2]
  const seed = tail[cursor + 3]
  return chunks > 0 && assistantEvent !== undefined && assistantEvent === assistantEvents[0]
    && assistantEvent.type === 'assistant/message'
    && assistantEvent.data.turn === start.data.turn && assistantEvent.data.step === start.data.step
    && stepEnd?.type === 'step/end' && stepEnd.data.turn === start.data.turn && stepEnd.data.step === start.data.step
    && turnEnd?.type === 'turn/end' && turnEnd.data.turn === start.data.turn
    && (seed === undefined || seed.type === 'session/end-seed')
    && tail.length === cursor + (seed === undefined ? 3 : 4)
}

async function repairLocalRestriction(
  input: LocalRestrictionRepairInput,
): Promise<LocalRestrictionStateRecord | undefined> {
  const record = parseCanonicalLocalRestrictionStateRecord(input.record)
  const transaction = record?.transaction
  if (record === undefined || transaction === undefined || String(input.session.id) !== input.sessionId
    || transaction.phase !== 'finalized' || transaction.material.target !== input.sessionId) return undefined
  const finalizedReplaceSeq = transaction.finalizedReplaceSeq
  const firstReplaceSeq = transaction.firstReplaceSeq
  if (!Number.isSafeInteger(firstReplaceSeq) || !Number.isSafeInteger(finalizedReplaceSeq)) return undefined
  const exactFirstReplaceSeq = firstReplaceSeq as number
  const exactFinalizedReplaceSeq = finalizedReplaceSeq as number
  const proveDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const detached = await input.readFrom(seq)
    const exactSeq = detached.events.filter(event => event.seq === seq)
    const exactId = detached.events.filter(event => event.type === 'user/message'
      && String(event.data.id) === targetMessageId)
    return exactSeq.length === 1 && exactId.length === 1 && exactLocalFinalizedEvent(exactSeq[0], transaction)
  }
  const proveAbortDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const startSeq = abortTurnStartSeq(input.session.events, exactFirstReplaceSeq)
    if (startSeq === undefined) return false
    const detached = await input.readFrom(startSeq)
    return exactDetachedPostcommitAbortRepair(
      detached.events, transaction, seq, targetMessageId,
      event => exactLocalPhaseEvent(event, transaction, 'current'),
      event => exactLocalFinalizedEvent(event, transaction),
    )
  }
  if (transaction.repair?.phase === 'repair_finalized') {
    const history = fixedRepairHistoryKind(
      input.session.events, exactFinalizedReplaceSeq, transaction.repair.targetReplaceSeq, 3,
    )
    if (history === 'unknown') return undefined
    return cleanLocalFinalizedSurface(input.session, transaction, transaction.repair.targetMessageId)
      && await (history === 'postcommit_abort'
        ? proveAbortDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId)
        : proveDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId))
      ? record : undefined
  }
  if (transaction.repair === undefined && cleanLocalFinalizedSurface(input.session, transaction)) {
    const event = input.session.events.find(candidate => candidate.seq === finalizedReplaceSeq)
    return event?.type === 'user/message'
      && await proveDetached(finalizedReplaceSeq as number, String(event.data.id)) ? record : undefined
  }
  const existingTarget = transaction.repair === undefined ? [] : input.session.events.filter(
    (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
      && String(event.data.id) === transaction.repair!.targetMessageId,
  )
  const targetAlreadyVisible = existingTarget.length === 1 && exactLocalFinalizedEvent(existingTarget[0], transaction)
    && cleanLocalFinalizedSurface(input.session, transaction, transaction.repair?.targetMessageId)
  if (!targetAlreadyVisible
    && !exactNormalLocalTail(input.session, transaction)
    && !exactPostcommitAbortTail(
      input.session, transaction,
      event => exactLocalPhaseEvent(event, transaction, 'current'),
      event => exactLocalFinalizedEvent(event, transaction),
    )) return undefined
  const targetMessageId = transaction.repair?.targetMessageId ?? crypto.randomUUID()
  const pending: LocalRestrictionStateRecord = transaction.repair === undefined
    ? { family: 'local_restriction', transaction: { ...transaction,
        repair: { phase: 'repair_pending', targetMessageId } } }
    : record
  if (transaction.repair === undefined) await input.save(pending)
  const original = input.session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactLocalFinalizedEvent(original, transaction)) return undefined
  const target = freezeMessage({ ...original.data, id: MessageId(targetMessageId) })
  const existing = input.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === targetMessageId)
  let seq: number
  if (existing.length === 0) {
    const nodes = [...input.session.surface.nodes]
    if (nodes.length === 0) return undefined
    seq = input.session.append('user/message', target, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
    }).seq
  } else if (existing.length === 1 && exactLocalFinalizedEvent(existing[0], transaction)) {
    seq = existing[0].seq
  } else return undefined
  const history = fixedRepairHistoryKind(input.session.events, exactFinalizedReplaceSeq, seq, 3)
  if (history === 'unknown'
    || !await (history === 'postcommit_abort' ? proveAbortDetached(seq, targetMessageId) : proveDetached(seq, targetMessageId))
    || !cleanLocalFinalizedSurface(input.session, transaction, targetMessageId)) return undefined
  const finalized: LocalRestrictionStateRecord = {
    family: 'local_restriction',
    transaction: { ...transaction, repair: { phase: 'repair_finalized', targetMessageId, targetReplaceSeq: seq } },
  }
  await input.save(finalized)
  return finalized
}

function exactNoSafePhaseEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalNoSafeActionTransaction,
  phase: 'current' | 'finalized',
): event is SessionEvent<'user/message'> {
  const focus = transaction.material.canonicalState.focus
  const boundary = rawPreservedActionBoundary(
    transaction.material.canonicalState.boundary as unknown as Record<string, unknown>, 'no_safe_action',
  )
  return boundary !== undefined && noSafeCanonicalEventMatches(
    event, phase, transaction as unknown as Record<string, unknown>, transaction.material.target,
    focus.ref, focus.currentMatter, focus.latestCorrections, boundary,
    { messageId: transaction.machine.originMessageId, hash: transaction.machine.originHash },
    transaction.body, transaction.bodyHash,
  )
}

function exactNoSafeFinalizedEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalNoSafeActionTransaction,
): event is SessionEvent<'user/message'> {
  return exactNoSafePhaseEvent(event, transaction, 'finalized')
}

function cleanNoSafeFinalizedSurface(
  session: Agent['session'],
  transaction: CanonicalNoSafeActionTransaction,
  expectedId?: string,
): boolean {
  const derived = session.deriveMessages()
  const only = derived[0]
  if (derived.length !== 1 || only === undefined || only.role !== 'user'
    || expectedId !== undefined && String(only.id) !== expectedId) return false
  const events = session.events.filter(event => event.type === 'user/message' && String(event.data.id) === String(only.id))
  return events.length === 1 && exactNoSafeFinalizedEvent(events[0], transaction)
}

/** Whitelist only the normal direct request -> bounded notice -> model answer tail. */
function exactNormalNoSafeTail(
  session: Agent['session'],
  transaction: CanonicalNoSafeActionTransaction,
): boolean {
  const visible = session.deriveMessages()
  const canonical = visible[0]
  const direct = visible[1]
  const notice = visible[2]
  const assistant = visible[3]
  if (visible.length !== 4 || canonical === undefined || direct === undefined || notice === undefined || assistant === undefined
    || canonical.role !== 'user' || direct.role !== 'user' || notice.role !== 'user' || assistant.role !== 'assistant'
    || direct.source.kind !== 'user' || notice.source.kind !== 'plugin' || assistant.source.kind !== 'model'
    || notice.source.plugin !== 'ui-context-compactor:no-safe-action' || notice.source.form !== 'notice'
    || notice.source.summary !== 'no safe action notice'
    || direct.content.length !== 1 || direct.content[0]?.type !== 'text'
    || notice.content.length !== 1 || notice.content[0]?.type !== 'text'
    || assistant.content.length !== 1 || assistant.content[0]?.type !== 'text'
    || String(direct.id) !== transaction.machine.originMessageId
    || createHash('sha256').update(String(direct.id)).update('\0').update(direct.content[0].text).digest('hex')
      !== transaction.machine.originHash) return false
  const finalized = session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactNoSafeFinalizedEvent(finalized, transaction) || String(finalized.data.id) !== String(canonical.id)) return false
  const directEvents = session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === transaction.machine.originMessageId)
  const noticeEvents = session.events.filter(event => event.type === 'user/message' && event.data === notice)
  const assistantEvents = session.events.filter((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message' && String(event.data.message.id) === String(assistant.id))
  if (directEvents.length !== 1 || noticeEvents.length !== 1 || assistantEvents.length !== 1
    || directEvents[0]?.data !== direct) return false
  const tail = session.events.slice(session.events.indexOf(finalized) + 1)
  const start = tail[0]
  const directEvent = tail[1]
  const noticeEvent = tail[2]
  if (start?.type !== 'step/start' || directEvent !== directEvents[0] || noticeEvent !== noticeEvents[0]) return false
  let cursor = 3
  let chunks = 0
  while (tail[cursor]?.type === 'assistant/chunk') {
    const chunk = tail[cursor]
    if (chunk?.type !== 'assistant/chunk' || chunk.data.turn !== start.data.turn || chunk.data.step !== start.data.step) return false
    chunks += 1
    cursor += 1
  }
  const assistantEvent = tail[cursor]
  const stepEnd = tail[cursor + 1]
  const turnEnd = tail[cursor + 2]
  const seed = tail[cursor + 3]
  return chunks > 0 && assistantEvent !== undefined && assistantEvent === assistantEvents[0]
    && assistantEvent.type === 'assistant/message'
    && assistantEvent.data.turn === start.data.turn && assistantEvent.data.step === start.data.step
    && stepEnd?.type === 'step/end' && stepEnd.data.turn === start.data.turn && stepEnd.data.step === start.data.step
    && turnEnd?.type === 'turn/end' && turnEnd.data.turn === start.data.turn
    && (seed === undefined || seed.type === 'session/end-seed')
    && tail.length === cursor + (seed === undefined ? 3 : 4)
}

async function repairNoSafeAction(
  input: NoSafeActionRepairInput,
): Promise<NoSafeActionStateRecord | undefined> {
  const record = parseCanonicalNoSafeActionStateRecord(input.record)
  const transaction = record?.transaction
  if (record === undefined || transaction === undefined || String(input.session.id) !== input.sessionId
    || transaction.phase !== 'finalized' || transaction.material.target !== input.sessionId) return undefined
  const finalizedReplaceSeq = transaction.finalizedReplaceSeq
  const firstReplaceSeq = transaction.firstReplaceSeq
  if (!Number.isSafeInteger(firstReplaceSeq) || !Number.isSafeInteger(finalizedReplaceSeq)) return undefined
  const exactFirstReplaceSeq = firstReplaceSeq as number
  const exactFinalizedReplaceSeq = finalizedReplaceSeq as number
  const proveDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const detached = await input.readFrom(seq)
    const exactSeq = detached.events.filter(event => event.seq === seq)
    const exactId = detached.events.filter(event => event.type === 'user/message'
      && String(event.data.id) === targetMessageId)
    return exactSeq.length === 1 && exactId.length === 1 && exactNoSafeFinalizedEvent(exactSeq[0], transaction)
  }
  const proveAbortDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const startSeq = abortTurnStartSeq(input.session.events, exactFirstReplaceSeq)
    if (startSeq === undefined) return false
    const detached = await input.readFrom(startSeq)
    return exactDetachedPostcommitAbortRepair(
      detached.events, transaction, seq, targetMessageId,
      event => exactNoSafePhaseEvent(event, transaction, 'current'),
      event => exactNoSafeFinalizedEvent(event, transaction),
    )
  }
  if (transaction.repair?.phase === 'repair_finalized') {
    const history = fixedRepairHistoryKind(
      input.session.events, exactFinalizedReplaceSeq, transaction.repair.targetReplaceSeq, 4,
    )
    if (history === 'unknown') return undefined
    return cleanNoSafeFinalizedSurface(input.session, transaction, transaction.repair.targetMessageId)
      && await (history === 'postcommit_abort'
        ? proveAbortDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId)
        : proveDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId))
      ? record : undefined
  }
  if (transaction.repair === undefined && cleanNoSafeFinalizedSurface(input.session, transaction)) {
    const event = input.session.events.find(candidate => candidate.seq === finalizedReplaceSeq)
    return event?.type === 'user/message'
      && await proveDetached(finalizedReplaceSeq as number, String(event.data.id)) ? record : undefined
  }
  const existingTarget = transaction.repair === undefined ? [] : input.session.events.filter(
    (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
      && String(event.data.id) === transaction.repair!.targetMessageId,
  )
  const targetAlreadyVisible = existingTarget.length === 1 && exactNoSafeFinalizedEvent(existingTarget[0], transaction)
    && cleanNoSafeFinalizedSurface(input.session, transaction, transaction.repair?.targetMessageId)
  if (!targetAlreadyVisible
    && !exactNormalNoSafeTail(input.session, transaction)
    && !exactPostcommitAbortTail(
      input.session, transaction,
      event => exactNoSafePhaseEvent(event, transaction, 'current'),
      event => exactNoSafeFinalizedEvent(event, transaction),
    )) return undefined
  const targetMessageId = transaction.repair?.targetMessageId ?? crypto.randomUUID()
  const pending: NoSafeActionStateRecord = transaction.repair === undefined
    ? { family: 'no_safe_action', transaction: { ...transaction,
        repair: { phase: 'repair_pending', targetMessageId } } }
    : record
  if (transaction.repair === undefined) await input.save(pending)
  const original = input.session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactNoSafeFinalizedEvent(original, transaction)) return undefined
  const target = freezeMessage({ ...original.data, id: MessageId(targetMessageId) })
  const existing = input.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === targetMessageId)
  let seq: number
  if (existing.length === 0) {
    const nodes = [...input.session.surface.nodes]
    if (nodes.length === 0) return undefined
    seq = input.session.append('user/message', target, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
    }).seq
  } else if (existing.length === 1 && exactNoSafeFinalizedEvent(existing[0], transaction)) {
    seq = existing[0].seq
  } else return undefined
  const history = fixedRepairHistoryKind(input.session.events, exactFinalizedReplaceSeq, seq, 4)
  if (history === 'unknown'
    || !await (history === 'postcommit_abort' ? proveAbortDetached(seq, targetMessageId) : proveDetached(seq, targetMessageId))
    || !cleanNoSafeFinalizedSurface(input.session, transaction, targetMessageId)) return undefined
  const finalized: NoSafeActionStateRecord = {
    family: 'no_safe_action',
    transaction: { ...transaction, repair: { phase: 'repair_finalized', targetMessageId, targetReplaceSeq: seq } },
  }
  await input.save(finalized)
  return finalized
}

function exactBackgroundPhaseEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalBackgroundTransaction,
  phase: 'current' | 'finalized',
): event is SessionEvent<'user/message'> {
  const rawBoundary = object(transaction.material.canonicalState.boundary)
  const kind = rawBoundary?.kind
  const boundary = rawBoundary !== undefined
    && (kind === 'actionable' || kind === 'local_restriction' || kind === 'no_safe_action')
    ? rawPreservedActionBoundary(rawBoundary, kind) : undefined
  return boundary !== undefined && backgroundCanonicalEventMatches(
    event, phase, transaction as unknown as Record<string, unknown>,
    transaction.material.target, transaction.machine.candidateRef,
    transaction.machine.focusRef, transaction.machine.currentMatter,
    transaction.machine.latestCorrections, boundary, transaction.machine.evidenceRef,
    { messageId: transaction.machine.originMessageId, hash: transaction.machine.originHash },
    transaction.body, transaction.bodyHash,
  )
}

function exactBackgroundFinalizedEvent(
  event: SessionEvent | undefined,
  transaction: CanonicalBackgroundTransaction,
): event is SessionEvent<'user/message'> {
  return exactBackgroundPhaseEvent(event, transaction, 'finalized')
}

function cleanBackgroundFinalizedSurface(
  session: Agent['session'],
  transaction: CanonicalBackgroundTransaction,
  expectedId?: string,
): boolean {
  const derived = session.deriveMessages()
  const only = derived[0]
  if (derived.length !== 1 || only === undefined || only.role !== 'user'
    || expectedId !== undefined && String(only.id) !== expectedId) return false
  const events = session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(only.id))
  return events.length === 1 && exactBackgroundFinalizedEvent(events[0], transaction)
}

function exactNormalBackgroundTail(
  session: Agent['session'],
  transaction: CanonicalBackgroundTransaction,
): boolean {
  const visible = session.deriveMessages()
  const canonical = visible[0]
  const direct = visible[1]
  const assistant = visible[2]
  if (visible.length !== 3 || canonical === undefined || direct === undefined || assistant === undefined
    || canonical.role !== 'user' || direct.role !== 'user' || assistant.role !== 'assistant'
    || direct.source.kind !== 'user' || assistant.source.kind !== 'model'
    || direct.content.length !== 1 || direct.content[0]?.type !== 'text'
    || assistant.content.length !== 1 || assistant.content[0]?.type !== 'text'
    || String(direct.id) !== transaction.machine.originMessageId
    || createHash('sha256').update(String(direct.id)).update('\0').update(direct.content[0].text).digest('hex')
      !== transaction.machine.originHash) return false
  const finalized = session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactBackgroundFinalizedEvent(finalized, transaction)
    || String(finalized.data.id) !== String(canonical.id)) return false
  const directEvents = session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === transaction.machine.originMessageId)
  const assistantEvents = session.events.filter((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message' && String(event.data.message.id) === String(assistant.id))
  if (directEvents.length !== 1 || assistantEvents.length !== 1 || directEvents[0]?.data !== direct) return false
  const tail = session.events.slice(session.events.indexOf(finalized) + 1)
  const start = tail[0]
  const directEvent = tail[1]
  if (start?.type !== 'step/start' || directEvent !== directEvents[0]) return false
  let cursor = 2
  let chunks = 0
  while (tail[cursor]?.type === 'assistant/chunk') {
    const chunk = tail[cursor]
    if (chunk?.type !== 'assistant/chunk' || chunk.data.turn !== start.data.turn
      || chunk.data.step !== start.data.step) return false
    chunks += 1
    cursor += 1
  }
  const assistantEvent = tail[cursor]
  const stepEnd = tail[cursor + 1]
  const turnEnd = tail[cursor + 2]
  const seed = tail[cursor + 3]
  return chunks > 0 && assistantEvent !== undefined && assistantEvent === assistantEvents[0]
    && assistantEvent.type === 'assistant/message'
    && assistantEvent.data.turn === start.data.turn && assistantEvent.data.step === start.data.step
    && stepEnd?.type === 'step/end' && stepEnd.data.turn === start.data.turn
    && stepEnd.data.step === start.data.step
    && turnEnd?.type === 'turn/end' && turnEnd.data.turn === start.data.turn
    && (seed === undefined || seed.type === 'session/end-seed')
    && tail.length === cursor + (seed === undefined ? 3 : 4)
}

function exactFinalizedBackgroundCurrent(
  session: Agent['session'],
  transaction: CanonicalBackgroundTransaction,
): boolean {
  if (transaction.phase !== 'finalized') return false
  const matches = session.deriveMessages().filter(message => {
    if (message.role !== 'user' || message.source.kind !== 'context-manager-canonical'
      || message.source.machine.kind !== 'background') return false
    return session.events.some(event => event.type === 'user/message'
      && event.data === message && exactBackgroundFinalizedEvent(event, transaction))
  })
  const current = matches[0]
  if (matches.length !== 1 || current === undefined) return false
  const logged = session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === String(current.id))
  return logged.length === 1 && exactBackgroundFinalizedEvent(logged[0], transaction)
}

async function repairBackground(
  input: BackgroundRepairInput,
  preservation: EffectiveStatePreservation,
  authority: CanonicalContextAuthority,
): Promise<BackgroundStateRecord | undefined> {
  const actionOwner = expectedActionBoundaryOwners.get(preservation)
  if (actionOwner === undefined || String(input.session.id) !== input.sessionId) return undefined
  const parsed = parseCanonicalBackgroundStateRecord(input.record)
  const transaction = parsed?.transaction
  if (parsed === undefined || transaction === undefined || transaction.material.target !== input.sessionId) return undefined
  if (transaction.phase === 'pending') {
    if (!await input.flush()) return undefined
    const detached = await input.readFrom(0)
    const decoded = decodePendingBackground(
      input.sessionId, input.session, detached.events, parsed, actionOwner, input.create,
    )
    if (decoded === undefined) return undefined
    const port = canonicalAuthorityPort(authority)
    if (!port.registerBackgroundReplay(decoded.pending)) return undefined
    try {
      const committed = await runCanonicalTransactionSuffix({
        family: 'background', session: input.session, pending: decoded.pending,
        preservation, authority, material: decoded.material,
        close: decoded.material.origin,
        save: async next => await input.save({ family: 'background', transaction: next }),
        flush: input.flush, readFrom: input.readFrom,
        retainedC29: decoded.transaction.c29,
      })
      return { family: 'background', transaction: committed.record }
    } finally {
      port.releasePending(decoded.pending)
    }
  }
  if (transaction.phase !== 'finalized') return undefined
  const firstReplaceSeq = transaction.firstReplaceSeq
  const finalizedReplaceSeq = transaction.finalizedReplaceSeq
  if (!Number.isSafeInteger(firstReplaceSeq) || !Number.isSafeInteger(finalizedReplaceSeq)) return undefined
  const exactFirstReplaceSeq = firstReplaceSeq as number
  const exactFinalizedReplaceSeq = finalizedReplaceSeq as number
  const proveDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const detached = await input.readFrom(seq)
    const exactSeq = detached.events.filter(event => event.seq === seq)
    const exactId = detached.events.filter(event => event.type === 'user/message'
      && String(event.data.id) === targetMessageId)
    return exactSeq.length === 1 && exactId.length === 1
      && exactBackgroundFinalizedEvent(exactSeq[0], transaction)
  }
  const proveAbortDetached = async (seq: number, targetMessageId: string): Promise<boolean> => {
    if (!await input.flush()) return false
    const startSeq = abortTurnStartSeq(input.session.events, exactFirstReplaceSeq)
    if (startSeq === undefined) return false
    const detached = await input.readFrom(startSeq)
    return exactDetachedPostcommitAbortRepair(
      detached.events, transaction, seq, targetMessageId,
      event => exactBackgroundPhaseEvent(event, transaction, 'current'),
      event => exactBackgroundFinalizedEvent(event, transaction),
    )
  }
  if (transaction.repair?.phase === 'repair_finalized') {
    const history = fixedRepairHistoryKind(
      input.session.events, exactFinalizedReplaceSeq, transaction.repair.targetReplaceSeq, 3,
    )
    if (history === 'unknown') return undefined
    return cleanBackgroundFinalizedSurface(input.session, transaction, transaction.repair.targetMessageId)
      && await (history === 'postcommit_abort'
        ? proveAbortDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId)
        : proveDetached(transaction.repair.targetReplaceSeq, transaction.repair.targetMessageId))
      ? parsed : undefined
  }
  if (transaction.repair === undefined && cleanBackgroundFinalizedSurface(input.session, transaction)) {
    const event = input.session.events.find(candidate => candidate.seq === finalizedReplaceSeq)
    return event?.type === 'user/message'
      && await proveDetached(exactFinalizedReplaceSeq, String(event.data.id)) ? parsed : undefined
  }
  const existingTarget = transaction.repair === undefined ? [] : input.session.events.filter(
    (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
      && String(event.data.id) === transaction.repair!.targetMessageId,
  )
  const targetAlreadyVisible = existingTarget.length === 1
    && exactBackgroundFinalizedEvent(existingTarget[0], transaction)
    && cleanBackgroundFinalizedSurface(input.session, transaction, transaction.repair?.targetMessageId)
  if (!targetAlreadyVisible
    && !exactNormalBackgroundTail(input.session, transaction)
    && !exactPostcommitAbortTail(
      input.session, transaction,
      event => exactBackgroundPhaseEvent(event, transaction, 'current'),
      event => exactBackgroundFinalizedEvent(event, transaction),
    )) return undefined
  const targetMessageId = transaction.repair?.targetMessageId ?? crypto.randomUUID()
  const pending: BackgroundStateRecord = transaction.repair === undefined
    ? { family: 'background', transaction: {
        ...transaction, repair: { phase: 'repair_pending', targetMessageId },
      } }
    : parsed
  if (transaction.repair === undefined) await input.save(pending)
  const original = input.session.events.find(event => event.seq === transaction.finalizedReplaceSeq)
  if (!exactBackgroundFinalizedEvent(original, transaction)) return undefined
  const target = freezeMessage({ ...original.data, id: MessageId(targetMessageId) })
  const existing = input.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && String(event.data.id) === targetMessageId)
  let seq: number
  if (existing.length === 0) {
    const nodes = [...input.session.surface.nodes]
    if (nodes.length === 0) return undefined
    seq = input.session.append('user/message', target, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
    }).seq
  } else if (existing.length === 1 && exactBackgroundFinalizedEvent(existing[0], transaction)) {
    seq = existing[0].seq
  } else return undefined
  const history = fixedRepairHistoryKind(input.session.events, exactFinalizedReplaceSeq, seq, 3)
  if (history === 'unknown'
    || !await (history === 'postcommit_abort' ? proveAbortDetached(seq, targetMessageId) : proveDetached(seq, targetMessageId))
    || !cleanBackgroundFinalizedSurface(input.session, transaction, targetMessageId)) return undefined
  const finalized: BackgroundStateRecord = {
    family: 'background',
    transaction: {
      ...transaction,
      repair: { phase: 'repair_finalized', targetMessageId, targetReplaceSeq: seq },
    },
  }
  await input.save(finalized)
  return finalized
}

/** Orchestrates only. No Cnn result is manufactured here. */
export class CanonicalStateTransaction {
  constructor(
    private readonly preservation = new EffectiveStatePreservation(),
    private readonly authority = new CanonicalContextAuthority(),
  ) {}
  async commit<Record extends NoFocusTransactionCarrier>(input: CanonicalStateTransactionInput<Record>): Promise<FinalizedCanonicalNoFocus> {
    const prior = input.record.transaction
    if (String(input.session.id) !== input.sessionId || input.sessionId !== input.focus.chat
      || (prior !== undefined && prior.machine.chat !== input.focus.chat)) {
      throw new Error('canonical transaction chat identity is not mechanically continuous')
    }
    const c06 = this.preservation.acceptFocusFactToPreserve(input.focus)
    const c07 = this.authority.acceptCurrentFocus(input.focus)
    const generation = prior === undefined ? 1 : prior.generation + 1
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('canonical generation is not recoverably monotonic')
    }
    const authorityPort = canonicalAuthorityPort(this.authority)
    const pending = authorityPort.prepareNoFocus(c06, c07, input.material, generation)
    if (pending === undefined) throw new Error('C06/C07 did not establish one no-focus state')
    try {
      const committed = await runCanonicalTransactionSuffix({
        family: 'no_focus',
        session: input.session,
        pending,
        preservation: this.preservation,
        authority: this.authority,
        material: input.material,
        close: input.close,
        save: async transaction => await input.save({ ...input.record, transaction }),
        flush: input.flush,
        readFrom: input.readFrom,
      })
      return { current: committed.current, finalizedSeq: committed.finalizedSeq }
    } finally {
      authorityPort.releasePending(pending)
    }
  }

  /** Fixed local front half on this same transaction owner and preservation ledger. */
  createLocalRestrictionLivePort(): LocalRestrictionLivePort {
    return Object.freeze({
      commit: async (input: CanonicalLocalRestrictionTransactionInput) => await this.commitLocalRestriction(input),
    })
  }

  createLocalRestrictionRepairPort(): LocalRestrictionRepairPort {
    return Object.freeze({ repair: async (input: LocalRestrictionRepairInput) => await repairLocalRestriction(input) })
  }

  createNoSafeActionLivePort(): NoSafeActionLivePort {
    return Object.freeze({ commit: async (input: CanonicalNoSafeActionTransactionInput) => await this.commitNoSafeAction(input) })
  }

  createNoSafeActionRepairPort(): NoSafeActionRepairPort {
    return Object.freeze({ repair: async (input: NoSafeActionRepairInput) => await repairNoSafeAction(input) })
  }

  createLocalRestrictionRecoveryPort(
    owner: FocusAuthority,
    actionOwner: ActionFactBoundaryAuthority,
  ): FinalizedLocalRestrictionRecoveryPort {
    return createFinalizedLocalRestrictionRecoveryPort(
      this.preservation, owner, actionOwner, this.authority,
    )
  }

  createNoSafeActionRecoveryPort(
    owner: FocusAuthority,
    actionOwner: ActionFactBoundaryAuthority,
  ): FinalizedNoSafeActionRecoveryPort {
    return createFinalizedNoSafeActionRecoveryPort(
      this.preservation, owner, actionOwner, this.authority,
    )
  }

  createBackgroundLivePort(): BackgroundLivePort {
    return Object.freeze({
      commit: async (input: CanonicalBackgroundTransactionInput) => await this.commitBackground(input),
    })
  }

  createBackgroundRepairPort(): BackgroundRepairPort {
    return Object.freeze({
      repair: async (input: BackgroundRepairInput) =>
        await repairBackground(input, this.preservation, this.authority),
    })
  }

  createBackgroundRecoveryPort(
    owner: FocusAuthority,
    actionOwner: ActionFactBoundaryAuthority,
  ): FinalizedBackgroundRecoveryPort {
    return createFinalizedBackgroundRecoveryPort(
      this.preservation, owner, actionOwner, this.authority,
    )
  }

  private async commitBackground(
    input: CanonicalBackgroundTransactionInput,
  ): Promise<FinalizedCanonicalBackground> {
    const candidate = input.decision.candidate
    const prior = input.record.transaction
    const rollingGeneration = rollingCandidateGeneration(candidate)
    const parsedPrior = prior === undefined ? undefined : parseCanonicalBackgroundStateRecord(input.record)
    if (input.record.family !== 'background'
      || prior === undefined && rollingGeneration !== undefined
      || prior !== undefined && (parsedPrior?.transaction !== prior
        || prior.phase !== 'finalized'
        || prior.material.target !== input.sessionId
        || prior.machine.candidateRef !== prior.material.canonicalState.candidateRef
        || prior.canonicalRef !== prior.material.canonicalState.ref
        || rollingGeneration !== prior.generation
        || !exactFinalizedBackgroundCurrent(input.session, prior))
      || String(input.session.id) !== input.sessionId || input.sessionId !== input.focus.chat
      || input.boundary.chat !== input.focus.chat || candidate.target !== input.focus.chat
      || candidate.formationFocus.ref !== input.focus.ref
      || candidate.formationActionBoundary.ref !== input.boundary.ref
      || !samePreservedActionBoundary(candidate.formationActionBoundary, input.boundary)
      || !this.preservation.hasExpectedActionBoundaryOwner(input.actionOwner)
      || input.material.origin.messageId.trim().length === 0 || input.material.origin.hash.trim().length === 0
      || input.session.events.some(event => event.type === 'user/message'
        && String(event.data.id) === input.material.origin.messageId)) {
      throw new Error('background transaction identity is not mechanically continuous')
    }
    if (!consumeAuthenticCandidateQualification(input.qualificationOwner, input.c28, input.decision)) {
      throw new Error('background transaction C28 is not owner-authenticated')
    }
    const c06 = this.preservation.acceptFocusFactToPreserve(input.focus)
    const c20 = this.preservation.acceptActionBoundaryToPreserve(input.boundary)
    const authorityPort = canonicalAuthorityPort(this.authority)
    const generation = prior === undefined ? 1 : prior.generation + 1
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('background generation is not recoverably monotonic')
    }
    const pending = authorityPort.prepareBackground(
      this.preservation, input.actionOwner, input.decision, input.c28,
      input.focus, input.boundary, c06, c20, input.material, generation,
    )
    if (pending === undefined) throw new Error('C28/C06/C20 did not establish one background state')
    try {
      return await runCanonicalTransactionSuffix({
        family: 'background', session: input.session, pending,
        preservation: this.preservation, authority: this.authority,
        material: input.material, close: input.material.origin,
        save: async transaction => await input.save({ family: 'background', transaction }),
        flush: input.flush, readFrom: input.readFrom,
      })
    } finally {
      authorityPort.releasePending(pending)
    }
  }

  private async commitLocalRestriction(
    input: CanonicalLocalRestrictionTransactionInput,
  ): Promise<FinalizedCanonicalLocalRestriction> {
    const prior = input.record.transaction
    const boundary = input.acceptance.c22.kind === 'business_result'
      ? input.acceptance.c22.value.value : undefined
    if (input.record.family !== 'local_restriction'
      || String(input.session.id) !== input.sessionId
      || input.sessionId !== input.focus.chat || boundary?.kind !== 'local_restriction' || boundary.chat !== input.focus.chat
      || input.acceptance.c02.kind !== 'business_result' || input.acceptance.c02.value.value !== input.focus
      || !this.preservation.hasExpectedActionBoundaryOwner(input.actionOwner)
      || input.material.family !== 'local_restriction'
      || input.material.origin.messageId !== input.acceptance.origin.messageId
      || input.material.origin.hash !== input.acceptance.origin.hash
      || (prior !== undefined && !exactPriorLocalRestriction(prior, input.focus, boundary))) {
      throw new Error('local restriction transaction identity is not mechanically continuous')
    }
    const c06 = this.preservation.acceptFocusFactToPreserve(input.focus)
    const generation = prior === undefined ? 1 : prior.generation + 1
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('local restriction generation is not recoverably monotonic')
    }
    const authorityPort = canonicalAuthorityPort(this.authority)
    const pending = authorityPort.prepareLocalRestriction(
      this.preservation, input.actionOwner, input.acceptance, c06, input.session, input.material, generation,
    )
    if (pending === undefined || pending.state.boundary !== boundary) {
      throw new Error('C06/C20/C21 did not establish one local restriction state')
    }
    try {
      return await runCanonicalTransactionSuffix({
        family: 'local_restriction', session: input.session, pending,
        preservation: this.preservation, authority: this.authority,
        material: input.material, close: input.material.origin,
        save: async transaction => await input.save({ family: 'local_restriction', transaction }),
        flush: input.flush, readFrom: input.readFrom,
      })
    } finally {
      authorityPort.releasePending(pending)
    }
  }

  private async commitNoSafeAction(
    input: CanonicalNoSafeActionTransactionInput,
  ): Promise<FinalizedCanonicalNoSafeAction> {
    const prior = input.record.transaction
    const boundary = input.handoff.c22.kind === 'business_result'
      ? input.handoff.c22.value.value : undefined
    if (input.record.family !== 'no_safe_action'
      || String(input.session.id) !== input.sessionId
      || input.sessionId !== input.focus.chat || boundary?.kind !== 'no_safe_action' || boundary.chat !== input.focus.chat
      || input.handoff.c02.kind !== 'business_result' || input.handoff.c02.value.value !== input.focus
      || !this.preservation.hasExpectedActionBoundaryOwner(input.actionOwner)
      || input.material.family !== 'no_safe_action'
      || input.material.origin.messageId !== input.handoff.origin.messageId
      || input.material.origin.hash !== input.handoff.origin.hash
      || (prior !== undefined && !exactPriorNoSafeAction(prior, input.focus, boundary))) {
      throw new Error('no-safe-action transaction identity is not mechanically continuous')
    }
    const c06 = this.preservation.acceptFocusFactToPreserve(input.focus)
    const generation = prior === undefined ? 1 : prior.generation + 1
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('no-safe-action generation is not recoverably monotonic')
    }
    const authorityPort = canonicalAuthorityPort(this.authority)
    const pending = authorityPort.prepareNoSafeAction(
      this.preservation, input.actionOwner, input.handoff, c06, input.session, input.material, generation,
    )
    if (pending === undefined || pending.state.boundary !== boundary) {
      throw new Error('C06/C20/C21 did not establish one no-safe-action state')
    }
    try {
      return await runCanonicalTransactionSuffix({
        family: 'no_safe_action', session: input.session, pending,
        preservation: this.preservation, authority: this.authority,
        material: input.material, close: input.material.origin,
        save: async transaction => await input.save({ family: 'no_safe_action', transaction }),
        flush: input.flush, readFrom: input.readFrom,
      })
    } finally {
      authorityPort.releasePending(pending)
    }
  }
}

function createLocalRestrictionCanonicalMessage(
  pending: PrivatePendingLocalRestriction,
  material: CanonicalLocalRestrictionMaterial,
  phase: 'current' | 'finalized',
): UserMessage {
  const boundary = pending.state.boundary
  const preservedBoundary = preserveActionBoundary(boundary)
  return createUserMessage({
    content: [{ type: 'text', text: material.body }],
    source: {
      kind: 'context-manager-local-restriction', phase,
      pendingStateRef: pending.state.ref, canonicalStateRef: pending.canonicalRef,
      generation: pending.generation, chat: boundary.chat, bodyHash: material.bodyHash,
      machine: {
        kind: 'local_restriction', focusRef: pending.state.focus.ref,
        currentMatter: pending.state.focus.currentMatter,
        latestCorrections: pending.state.focus.latestCorrections,
        boundaryRef: boundary.ref,
        requiredFacts: preservedBoundary.requiredFacts,
        usableFacts: preservedBoundary.usableFacts,
        unresolvedFacts: preservedBoundary.unresolvedFacts,
        preciselyBlockedActions: Object.freeze([...boundary.preciselyBlockedActions]),
        safelyContinuableActions: Object.freeze([...boundary.safelyContinuableActions]),
        originMessageId: material.origin.messageId,
        originHash: material.origin.hash,
      },
    },
  })
}

function createNoSafeActionCanonicalMessage(
  pending: PrivatePendingNoSafeAction,
  material: CanonicalNoSafeActionMaterial,
  phase: 'current' | 'finalized',
): UserMessage {
  const boundary = pending.state.boundary
  const preservedBoundary = preserveNoSafeActionBoundary(boundary)
  return createUserMessage({
    content: [{ type: 'text', text: material.body }],
    source: {
      kind: 'context-manager-no-safe-action', phase,
      pendingStateRef: pending.state.ref, canonicalStateRef: pending.canonicalRef,
      generation: pending.generation, chat: boundary.chat, bodyHash: material.bodyHash,
      machine: {
        kind: 'no_safe_action', focusRef: pending.state.focus.ref,
        currentMatter: pending.state.focus.currentMatter,
        latestCorrections: pending.state.focus.latestCorrections,
        boundaryRef: boundary.ref,
        requiredFacts: preservedBoundary.requiredFacts,
        usableFacts: preservedBoundary.usableFacts,
        unresolvedFacts: preservedBoundary.unresolvedFacts,
        preciselyBlockedActions: Object.freeze([...boundary.preciselyBlockedActions]),
        safelyContinuableActions: Object.freeze([] as const),
        originMessageId: material.origin.messageId,
        originHash: material.origin.hash,
      },
    },
  })
}

function exactPriorLocalRestriction(
  prior: CanonicalLocalRestrictionTransaction,
  focus: EstablishedFocusDecision,
  boundary: LocalRestrictionBoundary,
): boolean {
  return prior.family === 'local_restriction' && prior.phase === 'finalized'
    && Number.isSafeInteger(prior.generation) && prior.generation >= 1
    && isCompleteLocalRestrictionMaterial(prior.material)
    && prior.material.target === focus.chat
    && prior.material.canonicalState.focus.ref === focus.ref
    && prior.material.canonicalState.focus.currentMatter === focus.currentMatter
    && prior.material.canonicalState.focus.latestCorrections === focus.latestCorrections
    && samePreservedActionBoundary(prior.material.canonicalState.boundary, boundary)
    && prior.machine.kind === 'local_restriction'
    && prior.machine.focusRef === focus.ref && prior.machine.currentMatter === focus.currentMatter
    && prior.machine.latestCorrections === focus.latestCorrections
    && prior.machine.boundaryRef === boundary.ref
    && sameRequirements(prior.machine.requiredFacts, boundary.requiredFacts)
    && sameUsableFacts(prior.machine.usableFacts, boundary.usableFacts)
    && sameUnresolvedFacts(prior.machine.unresolvedFacts, boundary.unresolvedFacts)
    && sameStrings(prior.machine.preciselyBlockedActions, boundary.preciselyBlockedActions)
    && sameStrings(prior.machine.safelyContinuableActions, boundary.safelyContinuableActions)
}

function exactPriorNoSafeAction(
  prior: CanonicalNoSafeActionTransaction,
  focus: EstablishedFocusDecision,
  boundary: NoSafeActionBoundary,
): boolean {
  return prior.family === 'no_safe_action' && prior.phase === 'finalized'
    && Number.isSafeInteger(prior.generation) && prior.generation >= 1
    && isCompleteNoSafeActionMaterial(prior.material)
    && prior.material.target === focus.chat
    && prior.material.canonicalState.focus.ref === focus.ref
    && prior.material.canonicalState.focus.currentMatter === focus.currentMatter
    && prior.material.canonicalState.focus.latestCorrections === focus.latestCorrections
    && samePreservedActionBoundary(prior.material.canonicalState.boundary, boundary)
    && prior.machine.kind === 'no_safe_action'
    && prior.machine.focusRef === focus.ref && prior.machine.currentMatter === focus.currentMatter
    && prior.machine.latestCorrections === focus.latestCorrections
    && prior.machine.boundaryRef === boundary.ref
    && sameRequirements(prior.machine.requiredFacts, boundary.requiredFacts)
    && sameUsableFacts(prior.machine.usableFacts, boundary.usableFacts)
    && sameUnresolvedFacts(prior.machine.unresolvedFacts, boundary.unresolvedFacts)
    && sameStrings(prior.machine.preciselyBlockedActions, boundary.preciselyBlockedActions)
    && prior.machine.safelyContinuableActions.length === 0
}

export function createLocalRestrictionLivePort(
  transaction: CanonicalStateTransaction,
): LocalRestrictionLivePort {
  return transaction.createLocalRestrictionLivePort()
}

export function createNoSafeActionLivePort(
  transaction: CanonicalStateTransaction,
): NoSafeActionLivePort {
  return transaction.createNoSafeActionLivePort()
}

/**
 * H1R-P owns only the already-signed pending suffix.  It deliberately does
 * not share `CanonicalStateTransaction.commit()`: that entrypoint signs C06/
 * C07 again and advances generation, both of which would turn a replay into a
 * different canonical state.
 */
class PendingNoFocusReplay {
  private readonly consumer = new CurrentContextConsumer()
  constructor(
    private readonly preservation: EffectiveStatePreservation,
    private readonly authority: CanonicalContextAuthority,
  ) {}

  async replay(input: PendingNoFocusReplayInput): Promise<boolean> {
    if (String(input.session.id) !== input.sessionId) return false
    try {
      // No sidecar or visible write precedes the physical proof of the exact
      // pending candidate.  Read from zero so duplicate close/canonical ids
      // cannot hide outside a suffix boundary.
      if (!await input.flush()) return false
      const detached = await input.readFrom(0)
      const decoded = decodeExactPendingNoFocus(input.sessionId, input.session, detached.events, input.record)
      if (decoded === undefined) return false
      const { close, transaction } = decoded
      const material = replayMaterial(transaction)
      const authorityPort = canonicalAuthorityPort(this.authority)
      let registeredPending: PrivatePendingNoFocus | undefined
      try {
        // `prepareNoFocus` only associates existing C06/C07 facts with this
        // authority. It does not issue a report; object identity must remain
        // the exact stored pair accepted by the raw decoder.
        const registered = authorityPort.prepareNoFocus(transaction.c06, transaction.c07, material, transaction.generation)
        if (registered === undefined) return false
        registeredPending = registered
        if (!samePendingReplayIdentity(registered, decoded.pending)) return false
        const pending = registered
      const persist = async (next: CanonicalNoFocusTransaction): Promise<void> => {
        await input.save({ ...decoded.record, transaction: next })
      }
      let pendingRecord: CanonicalNoFocusTransaction | undefined = transaction
      const persistence = new StatePersistence(async material => {
        if (pendingRecord !== transaction || !sameCompleteStateMaterial(transaction.material, material)) {
          throw new Error('pending replay C33 material changed')
        }
        // C33 may durably save this exact existing pending row again.  It must
        // not invent a C33 report before the receiver has completed.
        await persist(pendingRecord)
      }, pending.material)
      const saveCapability = statePersistenceCapability(persistence)
      let saved: C33Result | undefined
      const binding: PreservationBinding = {
        state: pending.state,
        material: pending.material,
        canonicalRef: pending.canonicalRef,
        expectedMaterialRef: pending.material.ref,
        persistence,
        saveCapability,
        saved: () => saved,
        saveComplete: async state => {
          if (state !== pending.state) throw new Error('pending replay C33 state identity changed')
          const report = await saveCapability(pending.material)
          saved = report
          return report
        },
      }
      let bound = false
      try {
        bindCompleteMaterial(this.preservation, pending.state, binding)
        bound = true
        // These three reports were validated as exact durable objects by the
        // raw decoder; replay must retain their object identity and call id.
        const c29 = transaction.c29
        if (value(c29)?.kind !== 'eligible') return false
        const c30 = await this.preservation.establishRecoverablePreservation(pending.state)
        const c33 = binding.saved()
        if (value(c30) === undefined || c33 === undefined || value(c33) === undefined) return false
        let visible: VisibleRuntime | undefined
        const replacement = new UniqueVisibleContextReplacement(() => visible)
        const first = replaceSurface(input.session, pending, material.create(pending, 'current'))
        const firstMessage = input.session.events.find((event): event is SessionEvent<'user/message'> => event.seq === first && event.type === 'user/message')?.data
        if (firstMessage === undefined) return false
        visible = { session: input.session, pending, message: firstMessage, seq: first, phase: 'current', material, close }
        const firstC31 = replacement.replaceVisibleContext(pending.state)
        if (value(firstC31) === undefined) return false
        const firstState = authorityPort.formCurrentContext(pending, c30, firstC31)
        if (firstState === undefined) return false
        const firstC32 = this.consumer.acceptCurrentContext(firstState)
        if (firstC32.identity.subject.state !== pending.canonicalRef || firstC32.value.state !== firstState) return false
        pendingRecord = {
          ...transaction, phase: 'current', c33, c30, firstC31, firstC32, firstReplaceSeq: first,
        }
        await persist(pendingRecord)
        const finalSeq = replaceSurface(input.session, pending, material.create(pending, 'finalized'))
        const finalEvent = input.session.events.find((event): event is SessionEvent<'user/message'> => event.seq === finalSeq && event.type === 'user/message')
        if (finalEvent === undefined) return false
        visible = { session: input.session, pending, message: finalEvent.data, seq: finalSeq, phase: 'finalized', material, close }
        const finalizedC31 = replacement.replaceVisibleContext(pending.state)
        if (value(finalizedC31) === undefined) return false
        const finalizedState = authorityPort.formCurrentContext(pending, c30, finalizedC31)
        if (finalizedState === undefined) return false
        const current = this.consumer.acceptCurrentContext(finalizedState)
        if (current.identity.subject.state !== pending.canonicalRef || current.value.state !== finalizedState) return false
        if (!await provePendingReplayPublication(input, pending, transaction, close, first, finalEvent)) return false
        pendingRecord = {
          ...transaction, phase: 'finalized', c33, c30, firstC31, firstC32, firstReplaceSeq: first,
          finalizedC31, finalizedC32: current, finalizedReplaceSeq: finalSeq,
        }
        await persist(pendingRecord)
        return true
      } finally {
        if (bound) clearCompleteMaterial(this.preservation, pending.state)
      }
      } finally {
        if (registeredPending !== undefined) authorityPort.releasePending(registeredPending)
      }
    } catch {
      // Any post-replace exception leaves a same-generation trace, which the
      // next raw decode will reject before maintenance can write again.
      return false
    }
  }
}

/** The sole exported H1R-P state operation; no pending candidate escapes it. */
export function createPendingNoFocusReplayPort(
  preservation: EffectiveStatePreservation,
  authority: CanonicalContextAuthority,
): PendingNoFocusReplayPort {
  const replay = new PendingNoFocusReplay(preservation, authority)
  return Object.freeze({
    replay: async (input: PendingNoFocusReplayInput): Promise<boolean> => await replay.replay(input),
  })
}
