import { PersonalFeedScopeConflictError } from './errors.ts'
import { periodReferenceFor, runIdentityFor } from './identity.ts'
import { createSourceCandidateReportFinalizer } from './source-candidate-report.ts'
import { createCandidatePeriodFinalizer } from './candidate-period-finalizer.ts'
import type {
  C01Accepted,
  C02Accepted,
  C32Accepted,
  C33Accepted,
  C34Accepted,
  C35Accepted,
  CandidateMaterialProjection,
  CandidateReportingWindow,
  CurrentContextProjection,
  ExternalRunOpportunity,
  MechanicalAdmission,
  MechanicalAdmissionPeriodScopeRequest,
  MaterialProjectionReportScope,
  PeriodIdentity,
  PeriodStartNotice,
  RunOpportunityRequest,
  SourceIdentity,
  PeriodBusinessFinalizerOptions,
  SourceCandidateReportFinalizer,
  PeriodBusinessFinalizerContract,
  CandidatePeriodBusinessFinalizerOptions,
} from './types.ts'

function accepted<T>(value: T): { readonly status: 'accepted'; readonly value: T } {
  return Object.freeze({ status: 'accepted', value })
}

export interface RunOpportunityLifecycle {
  readonly requestRunOpportunity: (request: RunOpportunityRequest) => C01Accepted
}

export function createRunOpportunityLifecycle(): RunOpportunityLifecycle {
  return Object.freeze({
    requestRunOpportunity: (request: RunOpportunityRequest): C01Accepted => {
      const run = runIdentityFor(request.request)
      const opportunity: ExternalRunOpportunity = {
        request: request.request,
        run,
        period: { run, period: periodReferenceFor(run) },
        origin: request.origin,
        startFact: {
          kind: 'external_run_opportunity_accepted',
          request: request.request,
        },
      }
      return accepted(opportunity)
    },
  })
}

export interface PeriodBusinessScopeFinalizer {
  readonly establishPeriod: (start: PeriodStartNotice) => C02Accepted
  readonly acceptCandidateReportingWindow: (window: CandidateReportingWindow) => C34Accepted
}

export interface PeriodBusinessFinalizer extends PeriodBusinessScopeFinalizer, PeriodBusinessFinalizerContract {}

export function createPeriodBusinessFinalizer(): PeriodBusinessScopeFinalizer
export function createPeriodBusinessFinalizer(
  options: CandidatePeriodBusinessFinalizerOptions,
): PeriodBusinessFinalizer & SourceCandidateReportFinalizer
export function createPeriodBusinessFinalizer(
  options: PeriodBusinessFinalizerOptions,
): PeriodBusinessScopeFinalizer & SourceCandidateReportFinalizer
export function createPeriodBusinessFinalizer(
  options?: PeriodBusinessFinalizerOptions,
): PeriodBusinessScopeFinalizer
  | (PeriodBusinessScopeFinalizer & SourceCandidateReportFinalizer)
  | (PeriodBusinessFinalizer & SourceCandidateReportFinalizer) {
  const base = {
    establishPeriod: (start: PeriodStartNotice): C02Accepted => accepted({ start }),
    acceptCandidateReportingWindow: (window: CandidateReportingWindow): C34Accepted => accepted({ window }),
  }
  if (options === undefined) return Object.freeze(base)
  const candidatePeriod = options.candidatePeriodLedgerPath === undefined
    ? undefined
    : createCandidatePeriodFinalizer({
      ...options,
      candidatePeriodLedgerPath: options.candidatePeriodLedgerPath,
    })
  return Object.freeze({
    ...base,
    ...createSourceCandidateReportFinalizer(options),
    ...(candidatePeriod === undefined ? {} : candidatePeriod),
  })
}

export function createMechanicalAdmission(source: SourceIdentity): MechanicalAdmission {
  return Object.freeze({
    source,
    establishPeriodScope: (request: MechanicalAdmissionPeriodScopeRequest) => {
      if (request.source !== source) return { status: 'rejected' as const, input: request }
      if (!samePeriod(request.period, request.start.start.period)
        || !samePeriod(request.period, request.reportingWindow.window.period)
        || !request.reportingWindow.window.sources.includes(source)) {
        return { status: 'rejected' as const, input: request }
      }
      return accepted(request)
    },
  })
}

export function createCandidateMaterialProjection(source: SourceIdentity): CandidateMaterialProjection {
  return Object.freeze({
    source,
    establishReportScope: (scope: MaterialProjectionReportScope) => {
      if (scope.source !== source
        || !samePeriod(scope.period, scope.reportingWindow.window.period)
        || !scope.reportingWindow.window.sources.includes(source)) {
        return { status: 'rejected' as const, input: scope }
      }
      return accepted({ scope })
    },
  })
}

export function createCurrentContextProjection(): CurrentContextProjection {
  return Object.freeze({
    establishPeriodScope: (period: PeriodIdentity) => accepted({ period }),
  })
}

export function requireC32Accepted(
  result: Awaited<ReturnType<MechanicalAdmission['establishPeriodScope']>>,
  expected: MechanicalAdmissionPeriodScopeRequest,
): C32Accepted {
  if (result.status !== 'accepted' || !sameMechanicalScope(result.value, expected)) {
    throw new PersonalFeedScopeConflictError('C32 receiver did not establish the exact requested scope')
  }
  return result
}

export function requireC33Accepted(
  result: Awaited<ReturnType<CurrentContextProjection['establishPeriodScope']>>,
  expected: PeriodIdentity,
): C33Accepted {
  if (result.status !== 'accepted' || !samePeriod(result.value.period, expected)) {
    throw new PersonalFeedScopeConflictError('C33 receiver did not establish the exact requested period')
  }
  return result
}

export function requireC35Accepted(
  result: Awaited<ReturnType<CandidateMaterialProjection['establishReportScope']>>,
  expected: MaterialProjectionReportScope,
): C35Accepted {
  if (result.status !== 'accepted' || !sameMaterialScope(result.value.scope, expected)) {
    throw new PersonalFeedScopeConflictError('C35 receiver did not establish the exact requested scope')
  }
  return result
}

function sameOrigin(left: RunOpportunityRequest['origin'], right: RunOpportunityRequest['origin']): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'manual'
    ? left.request === (right as Extract<typeof right, { kind: 'manual' }>).request
    : left.trigger === (right as Extract<typeof right, { kind: 'scheduled' }>).trigger
}

export function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function sameWindow(
  left: MechanicalAdmissionPeriodScopeRequest['reportingWindow'],
  right: MechanicalAdmissionPeriodScopeRequest['reportingWindow'],
): boolean {
  return left.window.window === right.window.window
    && samePeriod(left.window.period, right.window.period)
    && left.window.closesAt === right.window.closesAt
    && left.window.sources.length === right.window.sources.length
    && left.window.sources.every((source, index) => source === right.window.sources[index])
}

function sameMechanicalScope(
  left: MechanicalAdmissionPeriodScopeRequest,
  right: MechanicalAdmissionPeriodScopeRequest,
): boolean {
  return samePeriod(left.period, right.period)
    && left.source === right.source
    && samePeriod(left.start.start.period, right.start.start.period)
    && left.start.start.startFact.request === right.start.start.startFact.request
    && sameOrigin(left.start.start.origin, right.start.start.origin)
    && sameWindow(left.reportingWindow, right.reportingWindow)
}

function sameMaterialScope(
  left: MaterialProjectionReportScope,
  right: MaterialProjectionReportScope,
): boolean {
  return samePeriod(left.period, right.period)
    && left.source === right.source
    && sameWindow(left.reportingWindow, right.reportingWindow)
}
