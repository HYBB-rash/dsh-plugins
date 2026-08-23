declare const identityBrand: unique symbol

export type RunRequestIdentity = string & { readonly [identityBrand]: 'RunRequestIdentity' }
export type RunIdentity = string & { readonly [identityBrand]: 'RunIdentity' }
export type PeriodReference = string & { readonly [identityBrand]: 'PeriodReference' }
export type SourceIdentity = string & { readonly [identityBrand]: 'SourceIdentity' }
export type CandidateIdentity = string & { readonly [identityBrand]: 'CandidateIdentity' }
export type SourceStableReference = string & { readonly [identityBrand]: 'SourceStableReference' }
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
export type C36Result = ContractResult<SourceCandidateReportAccepted, SourceCandidateReport>

export type C01Accepted = Extract<C01Result, { readonly status: 'accepted' }>
export type C02Accepted = Extract<C02Result, { readonly status: 'accepted' }>
export type C32Accepted = Extract<C32Result, { readonly status: 'accepted' }>
export type C33Accepted = Extract<C33Result, { readonly status: 'accepted' }>
export type C34Accepted = Extract<C34Result, { readonly status: 'accepted' }>
export type C35Accepted = Extract<C35Result, { readonly status: 'accepted' }>
export type C36Accepted = Extract<C36Result, { readonly status: 'accepted' }>

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
  readonly now: () => string
}

export interface SourceCandidateReportFinalizer {
  readonly acceptSourceCandidateReport: (report: SourceCandidateReport) => C36Result
}
