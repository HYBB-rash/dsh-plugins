declare const identityBrand: unique symbol

export type RunRequestIdentity = string & { readonly [identityBrand]: 'RunRequestIdentity' }
export type RunIdentity = string & { readonly [identityBrand]: 'RunIdentity' }
export type PeriodReference = string & { readonly [identityBrand]: 'PeriodReference' }
export type SourceIdentity = string & { readonly [identityBrand]: 'SourceIdentity' }
export type CandidateIdentity = string & { readonly [identityBrand]: 'CandidateIdentity' }
export type SourceStableReference = string & { readonly [identityBrand]: 'SourceStableReference' }
export type EditingConclusionIdentity = string & { readonly [identityBrand]: 'EditingConclusionIdentity' }
export type FeedContentDeliveryObjectIdentity = string & {
  readonly [identityBrand]: 'FeedContentDeliveryObjectIdentity'
}
export type CandidateReportingWindowIdentity = string & {
  readonly [identityBrand]: 'CandidateReportingWindowIdentity'
}

export interface PeriodIdentity {
  readonly run: RunIdentity
  readonly period: PeriodReference
}

export type ExternalRunOpportunityOrigin =
  | { readonly kind: 'scheduled'; readonly trigger: string }
  | { readonly kind: 'manual'; readonly request: RunRequestIdentity }

export interface RunOpportunityRequest {
  readonly request: RunRequestIdentity
  readonly origin: ExternalRunOpportunityOrigin
}

export interface ExternalRunStartFact {
  readonly kind: 'external_run_opportunity_accepted'
  readonly request: RunRequestIdentity
}

export interface ExternalRunOpportunity {
  readonly request: RunRequestIdentity
  readonly run: RunIdentity
  readonly period: PeriodIdentity
  readonly origin: ExternalRunOpportunityOrigin
  readonly startFact: ExternalRunStartFact
}

export interface PeriodStartNotice {
  readonly period: PeriodIdentity
  readonly startFact: ExternalRunStartFact
  readonly origin: ExternalRunOpportunityOrigin
}

export interface PeriodEstablished {
  readonly start: PeriodStartNotice
}

export interface CandidateReportingWindow {
  readonly window: CandidateReportingWindowIdentity
  readonly period: PeriodIdentity
  readonly sources: readonly SourceIdentity[]
  readonly closesAt: string
}

export interface CandidateReportingWindowAccepted {
  readonly window: CandidateReportingWindow
}

export interface MechanicalAdmissionPeriodScopeRequest {
  readonly period: PeriodIdentity
  readonly source: SourceIdentity
  readonly start: PeriodEstablished
  readonly reportingWindow: CandidateReportingWindowAccepted
}

export type MechanicalAdmissionPeriodScopeEstablished = MechanicalAdmissionPeriodScopeRequest

export interface CurrentContextProjectionPeriodScopeEstablished {
  readonly period: PeriodIdentity
}

export interface CurrentContextClue {
  readonly factOwner: unknown
  readonly originalAttribution: unknown
  readonly exactLookup: unknown
  readonly currentFact: unknown
}

export interface CurrentContext {
  readonly scope: CurrentContextProjectionPeriodScopeEstablished
  readonly period: PeriodIdentity
  readonly clues: readonly CurrentContextClue[]
}

export interface ContextUnavailable {
  readonly scope: CurrentContextProjectionPeriodScopeEstablished
  readonly period: PeriodIdentity
  readonly unavailableFact: unknown
}

export type CurrentContextResult =
  | { readonly kind: 'available'; readonly context: CurrentContext }
  | { readonly kind: 'unavailable'; readonly value: ContextUnavailable }

export interface MaterialProjectionReportScope {
  readonly period: PeriodIdentity
  readonly source: SourceIdentity
  readonly reportingWindow: CandidateReportingWindowAccepted
}

export interface MaterialProjectionReportScopeEstablished {
  readonly scope: MaterialProjectionReportScope
}

export interface SourceCandidateReference {
  readonly source: SourceIdentity
  readonly candidate: CandidateIdentity
  readonly stableReference: SourceStableReference
}

export type AdmissionCandidateBasis =
  | { readonly kind: 'objective_new_content'; readonly fact: unknown }
  | { readonly kind: 'historical_continuation'; readonly registration: unknown }

export interface AdmissionSourceFacts {
  readonly candidate: SourceCandidateReference
  readonly authorization: unknown
  readonly originalObject: unknown
  readonly attribution: unknown
  readonly exactDuplicateFact: unknown
  readonly readabilityFact: unknown
  readonly candidateBasis: AdmissionCandidateBasis
}

export interface AdmissionSourceFactsAccepted {
  readonly facts: AdmissionSourceFacts
}

export interface MechanicalCandidate {
  readonly scope: MechanicalAdmissionPeriodScopeEstablished
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly admissionFact: unknown
  readonly nomination?: unknown
}

export interface MaterialSourceFacts {
  readonly candidate: SourceCandidateReference
  readonly originalObject: unknown
  readonly attribution: unknown
  readonly boundedRelations: unknown
  readonly accessibility: unknown
  readonly version: unknown
}

export interface UnscreenedMaterialCandidateAccepted {
  readonly branch: 'unscreened'
  readonly contract: 'C08'
  readonly scope: MechanicalAdmissionPeriodScopeEstablished
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly acceptedQualification: unknown
}

export interface ScreenedMaterialCandidateAccepted {
  readonly branch: 'screened'
  readonly contract: 'C30'
  readonly scope: MechanicalAdmissionPeriodScopeEstablished
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly acceptedQualification: unknown
}

export interface MaterialBasisAccepted {
  readonly candidate: SourceCandidateReference
  readonly acceptedBasis: unknown
}

export interface UnscreenedMaterialCandidate {
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly qualification: UnscreenedMaterialCandidateAccepted
  readonly materialBasis: MaterialBasisAccepted
  readonly nomination?: unknown
}

export interface ScreenedMaterialCandidate {
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly qualification: ScreenedMaterialCandidateAccepted
  readonly materialBasis: MaterialBasisAccepted
  readonly nomination?: unknown
}

export type MaterialCandidate = UnscreenedMaterialCandidate | ScreenedMaterialCandidate

export interface UnscreenedSourceCandidateReport {
  readonly branch: 'unscreened'
  readonly scope: MaterialProjectionReportScopeEstablished
  readonly period: PeriodIdentity
  readonly source: SourceIdentity
  readonly candidates: readonly UnscreenedMaterialCandidate[]
}

export interface ScreenedSourceCandidateReport {
  readonly branch: 'screened'
  readonly scope: MaterialProjectionReportScopeEstablished
  readonly period: PeriodIdentity
  readonly source: SourceIdentity
  readonly candidates: readonly ScreenedMaterialCandidate[]
}

export type SourceCandidateReport = UnscreenedSourceCandidateReport | ScreenedSourceCandidateReport

export interface SourceCandidateReportAccepted {
  readonly report: SourceCandidateReport
}

export interface ReportedMaterialCandidate {
  readonly report: SourceCandidateReportAccepted
  readonly candidate: MaterialCandidate
}

export interface CandidateAcceptedIntoPeriod {
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly nomination?: unknown
}

export interface CandidateMaterial {
  readonly acceptedIntoPeriod: CandidateAcceptedIntoPeriod
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly boundedContent: unknown
  readonly attribution: unknown
  readonly exactLookup: unknown
  readonly nomination?: unknown
}

export interface MaterialFormed {
  readonly kind: 'material_formed'
  readonly acceptedIntoPeriod: CandidateAcceptedIntoPeriod
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly materialFormedFact: unknown
}

export interface MaterialUnavailable {
  readonly kind: 'material_unavailable'
  readonly acceptedIntoPeriod: CandidateAcceptedIntoPeriod
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly unavailableFact: unknown
}

export type MaterialFact = MaterialFormed | MaterialUnavailable

export interface MaterialFactRecorded {
  readonly fact: MaterialFact
}

export interface EditingInputAccepted {
  readonly material: CandidateMaterial
}

export interface EditingInputClosure {
  readonly period: PeriodIdentity
  readonly candidatesInJudgment: readonly SourceCandidateReference[]
}

export interface EditingInputClosureAccepted {
  readonly closure: EditingInputClosure
}

export type CandidateEditingDecision =
  | { readonly kind: 'selected'; readonly candidate: SourceCandidateReference }
  | {
      readonly kind: 'not_selected'
      readonly candidate: SourceCandidateReference
      readonly semanticReason: unknown
    }

export interface CompleteCandidateEditingDecisions {
  readonly candidatesInJudgment: readonly SourceCandidateReference[]
  readonly decisions: readonly CandidateEditingDecision[]
}

export interface EditedFeedContent {
  readonly body: unknown
}
export interface SelectedCandidateSet {
  readonly candidates: readonly SourceCandidateReference[]
}

export type EmptyCandidateSelection = Record<never, never>

export interface RawFeedContentConclusion {
  readonly conclusion: EditingConclusionIdentity
  readonly closure: EditingInputClosureAccepted
  readonly content: EditedFeedContent
  readonly decisions: CompleteCandidateEditingDecisions
}

export interface EditingFailure {
  readonly candidatesInJudgment: readonly SourceCandidateReference[]
  readonly failureFact: unknown
}

export interface RawEmptyFeedConclusion {
  readonly conclusion: EditingConclusionIdentity
  readonly closure: EditingInputClosureAccepted
  readonly content: EditedFeedContent
  readonly decisions: CompleteCandidateEditingDecisions
}

export interface RawEditingFailureConclusion {
  readonly conclusion: EditingConclusionIdentity
  readonly closure: EditingInputClosureAccepted
  readonly failure: EditingFailure
}

export type RawEditingConclusion = RawFeedContentConclusion | RawEmptyFeedConclusion | RawEditingFailureConclusion

export interface FormalOrdinaryFeedContent {
  readonly object: FeedContentDeliveryObjectIdentity
  readonly period: PeriodIdentity
  readonly original: EditingConclusionIdentity
  readonly content: EditedFeedContent
  readonly selected: SelectedCandidateSet
}

export interface FormalFeedContentConclusion {
  readonly period: PeriodIdentity
  readonly original: EditingConclusionIdentity
  readonly content: FormalOrdinaryFeedContent
  readonly decisions: CompleteCandidateEditingDecisions
}

export interface FormalEmptyFeedContent {
  readonly object: FeedContentDeliveryObjectIdentity
  readonly period: PeriodIdentity
  readonly original: EditingConclusionIdentity
  readonly content: EditedFeedContent
  readonly selected: EmptyCandidateSelection
}

export interface FormalEmptyFeedConclusion {
  readonly period: PeriodIdentity
  readonly original: EditingConclusionIdentity
  readonly content: FormalEmptyFeedContent
  readonly decisions: CompleteCandidateEditingDecisions
}

export interface FormalEditingFailureConclusion {
  readonly period: PeriodIdentity
  readonly original: EditingConclusionIdentity
  readonly failure: EditingFailure
}

export type FormalEditingConclusion =
  | FormalFeedContentConclusion
  | FormalEmptyFeedConclusion
  | FormalEditingFailureConclusion

export type CandidateDispositionValue =
  | 'PeriodAdmissionNotCompletedAndClosed'
  | 'MaterialUnavailableAndClosed'
  | 'ReviewedNotSelected'
  | 'Shown'
  | 'NotDeliveredThisPeriod'
  | 'PossiblyDelivered'
  | 'EditingFailed'
  | 'PeriodExpired'

export interface FormalCandidateDisposition {
  readonly period: PeriodIdentity
  readonly source: SourceIdentity
  readonly candidate: SourceCandidateReference
  readonly value: CandidateDispositionValue
}

export interface DispositionBasisAccepted {
  readonly disposition: FormalCandidateDisposition
}

export type SourceDispositionValue = 'Displayed' | 'Suppressed'

export interface SourceDispositionState {
  readonly period: PeriodIdentity
  readonly candidate: SourceCandidateReference
  readonly state: SourceDispositionValue
  readonly sourceCompletion: unknown
}

export interface SourceClosureAccepted {
  readonly state: SourceDispositionState
}

export type FormalFeedContent = FormalOrdinaryFeedContent | FormalEmptyFeedContent

export type DeliveryChannelResult = 'Delivered' | 'Failed' | 'Uncertain'

export interface FormalFeedContentDeliveryReceipt {
  readonly object: FeedContentDeliveryObjectIdentity
  readonly period: PeriodIdentity
  readonly result: DeliveryChannelResult
}

export interface FormalFeedContentDeliveryRequest {
  readonly object: FormalFeedContent
}

export type FormalFeedContentDeliveryOwnerRead =
  | { readonly status: 'found'; readonly value: { readonly request: FormalFeedContentDeliveryRequest } }
  | { readonly status: 'missing' }
  | { readonly status: 'rejected'; readonly input: PeriodIdentity }
  | { readonly status: 'failed'; readonly input: PeriodIdentity }

export interface FormalFeedContentDeliveryAccepted {
  readonly request: FormalFeedContentDeliveryRequest
}

export type DisplayFact =
  | {
      readonly period: PeriodIdentity
      readonly candidate: SourceCandidateReference
      readonly disposition: FormalCandidateDisposition & { readonly value: 'Shown' }
      readonly receipt: FormalFeedContentDeliveryReceipt & { readonly result: 'Delivered' }
    }
  | {
      readonly period: PeriodIdentity
      readonly candidate: SourceCandidateReference
      readonly disposition: FormalCandidateDisposition & { readonly value: 'NotDeliveredThisPeriod' }
      readonly receipt: FormalFeedContentDeliveryReceipt & { readonly result: 'Failed' }
    }
  | {
      readonly period: PeriodIdentity
      readonly candidate: SourceCandidateReference
      readonly disposition: FormalCandidateDisposition & { readonly value: 'PossiblyDelivered' }
      readonly receipt: FormalFeedContentDeliveryReceipt & { readonly result: 'Uncertain' }
    }

export interface RecentDeduplicationBasisAccepted {
  readonly fact: DisplayFact
}

export interface RunFeedContentDeliveryMeaningRecorded {
  readonly receipt: FormalFeedContentDeliveryReceipt
}

export interface PeriodDeliveryResultRecorded {
  readonly period: PeriodIdentity
  readonly receipt: FormalFeedContentDeliveryReceipt
}

export interface RunFinalizationAccepted {
  readonly period: PeriodIdentity
}

export interface OrdinaryContentFinalized {
  readonly kind: 'ordinary_content_finalized'
  readonly period: PeriodIdentity
}

export interface NormalEmptyPeriodFinalized {
  readonly kind: 'normal_empty_period_finalized'
  readonly period: PeriodIdentity
}

export interface EditingFailedFinalized {
  readonly kind: 'editing_failed_finalized'
  readonly period: PeriodIdentity
}

export interface AllCandidateMaterialsUnavailableFinalized {
  readonly kind: 'all_candidate_materials_unavailable_finalized'
  readonly period: PeriodIdentity
}

export interface PreContentPeriodSendFailedFinalized {
  readonly kind: 'pre_content_period_send_failed_finalized'
  readonly period: PeriodIdentity
}

export type BusinessFinalization =
  | OrdinaryContentFinalized
  | NormalEmptyPeriodFinalized
  | EditingFailedFinalized
  | AllCandidateMaterialsUnavailableFinalized
  | PreContentPeriodSendFailedFinalized

export type C15Result = ContractResult<FormalEditingConclusion, RawEditingConclusion>
export type C17Result = ContractResult<DispositionBasisAccepted, FormalCandidateDisposition>
export type C18Result = ContractResult<SourceClosureAccepted, SourceDispositionState>
export type C19Result = ContractResult<FormalFeedContentDeliveryAccepted, FormalFeedContentDeliveryRequest>
export type C20FormalFeedContentResult = ContractResult<RunFeedContentDeliveryMeaningRecorded, FormalFeedContentDeliveryReceipt>
export type C21Result = ContractResult<PeriodDeliveryResultRecorded, FormalFeedContentDeliveryReceipt>
export type C28Result = ContractResult<RecentDeduplicationBasisAccepted, DisplayFact>
export type C23Result = ContractResult<RunFinalizationAccepted, BusinessFinalization>
export type C37Result = ContractResult<EditingInputClosureAccepted, EditingInputClosure>

export interface CandidateDispositionReceiver {
  readonly acceptFormalDisposition: (disposition: FormalCandidateDisposition) => C17Result
}

export interface FormalContentDeliveryReceiver {
  readonly acceptFormalFeedContent: (request: FormalFeedContentDeliveryRequest) => C19Result
}

export interface BusinessFinalizationReceiver {
  readonly acceptBusinessFinalization: (finalization: BusinessFinalization) => C23Result
}

export interface EditingInputClosureReceiver {
  readonly acceptEditingInputClosure: (closure: EditingInputClosure) => C37Result
}

export interface RawFeedContentInput {
  readonly closure: EditingInputClosureAccepted
  readonly content: EditedFeedContent
  readonly decisions: CompleteCandidateEditingDecisions
}

export type ContractResult<TAccepted, TInput> =
  | { readonly status: 'accepted'; readonly value: TAccepted }
  | { readonly status: 'rejected'; readonly input: TInput }
  | { readonly status: 'failed'; readonly input: TInput }
  | { readonly status: 'unknown'; readonly input: TInput }

export type C01Result = ContractResult<ExternalRunOpportunity, RunOpportunityRequest>
export type C02Result = ContractResult<PeriodEstablished, PeriodStartNotice>
export type C03Result = ContractResult<AdmissionSourceFactsAccepted, AdmissionSourceFacts>
export type C32Result = ContractResult<
  MechanicalAdmissionPeriodScopeEstablished,
  MechanicalAdmissionPeriodScopeRequest
>
export type C33Result = ContractResult<CurrentContextProjectionPeriodScopeEstablished, PeriodIdentity>
export type C34Result = ContractResult<CandidateReportingWindowAccepted, CandidateReportingWindow>
export type C35Result = ContractResult<MaterialProjectionReportScopeEstablished, MaterialProjectionReportScope>
export type C08Result = ContractResult<UnscreenedMaterialCandidateAccepted, MechanicalCandidate>
export type C09Result = ContractResult<MaterialBasisAccepted, MaterialSourceFacts>
export type C10Result = ContractResult<EditingInputAccepted, CandidateMaterial>
export type C11Result = ContractResult<CurrentContextResult, CurrentContextResult>
export type C16Result = ContractResult<MaterialFactRecorded, MaterialFact>
export type C36Result = ContractResult<SourceCandidateReportAccepted, SourceCandidateReport>
export type C26Result = ContractResult<CandidateAcceptedIntoPeriod, ReportedMaterialCandidate>

export type C01Accepted = Extract<C01Result, { readonly status: 'accepted' }>
export type C02Accepted = Extract<C02Result, { readonly status: 'accepted' }>
export type C32Accepted = Extract<C32Result, { readonly status: 'accepted' }>
export type C33Accepted = Extract<C33Result, { readonly status: 'accepted' }>
export type C34Accepted = Extract<C34Result, { readonly status: 'accepted' }>
export type C35Accepted = Extract<C35Result, { readonly status: 'accepted' }>
export type C36Accepted = Extract<C36Result, { readonly status: 'accepted' }>
export type C10Accepted = Extract<C10Result, { readonly status: 'accepted' }>
export type C11Accepted = Extract<C11Result, { readonly status: 'accepted' }>
export type C16Accepted = Extract<C16Result, { readonly status: 'accepted' }>
export type C26Accepted = Extract<C26Result, { readonly status: 'accepted' }>

export interface MechanicalAdmission {
  readonly source: SourceIdentity
  readonly establishPeriodScope: (
    request: MechanicalAdmissionPeriodScopeRequest,
  ) => C32Result | Promise<C32Result>
}

export interface CandidateMaterialProjection {
  readonly source: SourceIdentity
  readonly establishReportScope: (
    scope: MaterialProjectionReportScope,
  ) => C35Result | Promise<C35Result>
}

export interface CurrentContextProjection {
  readonly establishPeriodScope: (
    period: PeriodIdentity,
  ) => C33Result | Promise<C33Result>
}

export interface CurrentContextResultProducer {
  readonly produceCurrentContextResult: (
    scope: CurrentContextProjectionPeriodScopeEstablished,
  ) => CurrentContextResult | Promise<CurrentContextResult>
}

export interface CurrentContextResultReceiver {
  readonly acceptCurrentContext: (
    result: CurrentContextResult,
  ) => C11Result | Promise<C11Result>
}

export interface CurrentContextProjectionOptions {
  readonly resultProducer: CurrentContextResultProducer
  readonly c11Receiver: CurrentContextResultReceiver
}

export interface ConfiguredCurrentContextProjection extends CurrentContextProjection {
  readonly completeCurrentContextForEstablishedScope: (
    scope: CurrentContextProjectionPeriodScopeEstablished,
  ) => Promise<C11Result>
}

export interface SourceScopeComponents {
  readonly source: SourceIdentity
  readonly mechanicalAdmission: MechanicalAdmission
  readonly candidateMaterialProjection: CandidateMaterialProjection
}

/** Explicit instance inputs supplied by the outer trigger adapter. */
export interface ExternalPeriodScopeInput {
  readonly requestIdentity: string
  readonly trigger: 'scheduled' | 'manual'
  readonly scheduledFor: string
  readonly claimedAt: string
  readonly runId: string
  readonly requiredSources: readonly SourceIdentity[]
  readonly reportingWindowClosesAt: string
}

/** The complete, bounded TODO 01 audit fact; no later Feed result belongs here. */
export interface PeriodScopeEstablished {
  readonly schemaVersion: 1
  readonly event: 'period_scope_established'
  readonly external: ExternalPeriodScopeInput
  readonly c01: C01Accepted
  readonly c02: C02Accepted
  readonly c34: C34Accepted
  readonly c32: readonly C32Accepted[]
  readonly c33: C33Accepted
  readonly c35: readonly C35Accepted[]
}

export interface PersonalFeedScopeService {
  readonly establishExternalPeriodScope: (
    input: ExternalPeriodScopeInput,
  ) => Promise<PeriodScopeEstablished>
}

export interface PeriodBusinessFinalizerOptions {
  readonly periodScopeLedgerPath: string
  readonly reportLedgerPath: string
  readonly candidatePeriodLedgerPath?: string
  readonly editingInputLedgerPath?: string
  readonly periodBusinessLedgerPath?: string
  readonly now: () => string
  readonly editingInputClosureReceiver?: EditingInputClosureReceiver
  readonly candidateDispositionReceiver?: CandidateDispositionReceiver
  readonly formalContentDeliveryReceiver?: FormalContentDeliveryReceiver
  readonly displayFactReceiver?: Pick<CrossSourceEditor, 'acceptDisplayFact'>
  readonly businessFinalizationReceiver?: BusinessFinalizationReceiver
}

export interface CandidatePeriodBusinessFinalizerOptions extends PeriodBusinessFinalizerOptions {
  readonly candidatePeriodLedgerPath: string
}

export interface SourceCandidateReportFinalizer {
  readonly acceptSourceCandidateReport: (report: SourceCandidateReport) => C36Result
}

export interface PeriodBusinessFinalizerContract {
  readonly acceptCandidateIntoPeriod: (candidate: ReportedMaterialCandidate) => C26Result
  readonly acceptMaterialFact: (fact: MaterialFact) => C16Result
  readonly establishEditingInputClosure: (closure: EditingInputClosure) => C37Result
  readonly acceptEditingConclusion: (conclusion: RawEditingConclusion) => C15Result
  readonly requestSourceDisposition: (disposition: FormalCandidateDisposition) => C17Result
  readonly acceptSourceDispositionState: (state: SourceDispositionState) => C18Result
  readonly requestFormalContentDelivery: (request: FormalFeedContentDeliveryRequest) => C19Result
  readonly acceptFormalFeedContentDeliveryReceipt: (receipt: FormalFeedContentDeliveryReceipt) => C21Result
  readonly ensureBusinessFinalization: (finalization: BusinessFinalization) => C23Result
}

export interface CrossSourceEditor {
  readonly acceptCandidateMaterial: (material: CandidateMaterial) => C10Result
  readonly listAcceptedInputs: () => readonly CandidateMaterial[]
  readonly acceptEditingInputClosure: (closure: EditingInputClosure) => C37Result
  readonly formRawFeedContentConclusion: (input: RawFeedContentInput) => ContractResult<RawFeedContentConclusion, RawFeedContentInput>
  readonly acceptDisplayFact: (fact: DisplayFact) => C28Result
}

export interface CurrentContextEditorOptions {
  readonly periodScopeLedgerPath: string
  readonly currentContextInputLedgerPath: string
}

export interface ContextEnabledCrossSourceEditor extends CrossSourceEditor, CurrentContextResultReceiver {}
