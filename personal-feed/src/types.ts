declare const identityBrand: unique symbol

export type RunRequestIdentity = string & { readonly [identityBrand]: 'RunRequestIdentity' }
export type RunIdentity = string & { readonly [identityBrand]: 'RunIdentity' }
export type PeriodReference = string & { readonly [identityBrand]: 'PeriodReference' }
export type SourceIdentity = string & { readonly [identityBrand]: 'SourceIdentity' }
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

export type ContractResult<TAccepted, TInput> =
  | { readonly status: 'accepted'; readonly value: TAccepted }
  | { readonly status: 'rejected'; readonly input: TInput }
  | { readonly status: 'failed'; readonly input: TInput }
  | { readonly status: 'unknown'; readonly input: TInput }

export type C01Result = ContractResult<ExternalRunOpportunity, RunOpportunityRequest>
export type C02Result = ContractResult<PeriodEstablished, PeriodStartNotice>
export type C32Result = ContractResult<
  MechanicalAdmissionPeriodScopeEstablished,
  MechanicalAdmissionPeriodScopeRequest
>
export type C33Result = ContractResult<CurrentContextProjectionPeriodScopeEstablished, PeriodIdentity>
export type C34Result = ContractResult<CandidateReportingWindowAccepted, CandidateReportingWindow>
export type C35Result = ContractResult<MaterialProjectionReportScopeEstablished, MaterialProjectionReportScope>

export type C01Accepted = Extract<C01Result, { readonly status: 'accepted' }>
export type C02Accepted = Extract<C02Result, { readonly status: 'accepted' }>
export type C32Accepted = Extract<C32Result, { readonly status: 'accepted' }>
export type C33Accepted = Extract<C33Result, { readonly status: 'accepted' }>
export type C34Accepted = Extract<C34Result, { readonly status: 'accepted' }>
export type C35Accepted = Extract<C35Result, { readonly status: 'accepted' }>

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
