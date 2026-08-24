import { createPeriodScopeStore } from './store.ts'
import {
  createSourceCandidateReportStore,
  sourceCandidateReportScopeKey,
} from './source-candidate-report-store.ts'
import type {
  C36Result,
  MechanicalAdmissionPeriodScopeEstablished,
  MaterialCandidate,
  MaterialProjectionReportScope,
  MaterialProjectionReportScopeEstablished,
  PeriodIdentity,
  PeriodScopeEstablished,
  PeriodBusinessFinalizerOptions,
  SourceCandidateReference,
  SourceCandidateReport,
  SourceCandidateReportAccepted,
  SourceCandidateReportFinalizer,
} from './types.ts'

type ReportBranch = SourceCandidateReport['branch']

export interface SourceCandidateReportReaderOptions {
  readonly reportLedgerPath: string
}

export type SourceCandidateReportReaderResult =
  | { readonly status: 'found'; readonly value: SourceCandidateReportAccepted }
  | {
      readonly status: 'missing' | 'rejected' | 'failed'
      readonly input: MaterialProjectionReportScopeEstablished
    }

export interface SourceCandidateReportReader {
  readonly readAcceptedSourceCandidateReport: (
    scope: MaterialProjectionReportScopeEstablished,
  ) => SourceCandidateReportReaderResult
}

/**
 * Package boundary for reading an accepted C36 report.
 *
 * The reader exposes the narrow durable read contract for accepted C36
 * reports while keeping all storage and validation details inside this
 * component.
 */
export function createSourceCandidateReportReader(
  options: SourceCandidateReportReaderOptions,
): SourceCandidateReportReader {
  if (options.reportLedgerPath.trim() === '') {
    throw new Error('source candidate report reader ledger path must be non-empty')
  }
  const reportStore = createSourceCandidateReportStore(options.reportLedgerPath)

  return Object.freeze({
    readAcceptedSourceCandidateReport: (
      scope: MaterialProjectionReportScopeEstablished,
    ): SourceCandidateReportReaderResult => {
      if (!isReaderScope(scope)) return { status: 'rejected', input: scope }
      try {
        const acceptedReports = reportStore.list()
        if (acceptedReports.some(accepted => !validateReportShape(accepted.report))) {
          return { status: 'failed', input: scope }
        }
        const matches = acceptedReports.filter(accepted => matchesReportScope(accepted.report, scope))
        if (matches.length === 0) return { status: 'missing', input: scope }
        if (matches.length !== 1) return { status: 'failed', input: scope }
        const accepted = matches[0]
        if (accepted === undefined) return { status: 'failed', input: scope }
        return { status: 'found', value: deepFreeze(accepted) }
      } catch {
        return { status: 'failed', input: scope }
      }
    },
  })
}

export function createSourceCandidateReportFinalizer(
  options: PeriodBusinessFinalizerOptions,
): SourceCandidateReportFinalizer {
  const periodScopeStore = createPeriodScopeStore(options.periodScopeLedgerPath)
  const reportStore = createSourceCandidateReportStore(options.reportLedgerPath)

  return Object.freeze({
    acceptSourceCandidateReport: (report: SourceCandidateReport): C36Result => {
      const input = report
      const validation = validateReportShape(report)
      if (!validation) return rejected(input)

      try {
        const now = Date.parse(options.now())
        if (!Number.isFinite(now)) return failed(input)
        const established = findEstablishedScope(periodScopeStore.list(), report)
        if (established === undefined) return rejected(input)

        const c32 = established.c32.find(scope => scope.value.source === report.source
          && samePeriod(scope.value.period, report.period))
        const c35 = established.c35.find(scope => scope.value.scope.source === report.source
          && samePeriod(scope.value.scope.period, report.period))
        if (c32 === undefined || c35 === undefined
          || !sameValue(c32.value.reportingWindow, c35.value.scope.reportingWindow)) {
          return rejected(input)
        }
        if (!matchesReportScope(report, c35.value)) return rejected(input)
        const closesAt = Date.parse(c35.value.scope.reportingWindow.window.closesAt)
        if (!Number.isFinite(closesAt)) return failed(input)
        if (now >= closesAt) {
          return rejected(input)
        }
        if (!matchesCandidates(report, c32.value)) return rejected(input)

        const accepted = freezeAcceptedReport(report)
        const scopeKey = sourceCandidateReportScopeKey(accepted.report)
        if (reportStore.findByScope(scopeKey) !== undefined) return rejected(input)
        reportStore.append(accepted)
        return { status: 'accepted', value: accepted }
      } catch {
        return failed(input)
      }
    },
  })
}

function findEstablishedScope(
  records: readonly PeriodScopeEstablished[],
  report: SourceCandidateReport,
): PeriodScopeEstablished | undefined {
  return records.find(record => {
    const period = record.c01.value.period
    return samePeriod(period, report.period)
      && report.source !== undefined
      && record.c34.value.window.sources.includes(report.source)
  })
}

function matchesReportScope(
  report: SourceCandidateReport,
  establishedScope: PeriodScopeEstablished['c35'][number]['value'],
): boolean {
  return sameValue(report.scope, establishedScope)
    && samePeriod(report.period, establishedScope.scope.period)
    && report.source === establishedScope.scope.source
}

function matchesCandidates(
  report: SourceCandidateReport,
  mechanicalScope: MechanicalAdmissionPeriodScopeEstablished,
): boolean {
  const candidateIdentities = new Set<string>()
  const stableReferences = new Set<string>()
  for (const candidate of report.candidates) {
    if (!matchesCandidate(report, mechanicalScope, candidate)) return false
    const candidateKey = candidateIdentityKey(candidate.candidate)
    const stableReferenceKey = stableReferenceIdentityKey(candidate.candidate)
    if (candidateIdentities.has(candidateKey) || stableReferences.has(stableReferenceKey)) return false
    candidateIdentities.add(candidateKey)
    stableReferences.add(stableReferenceKey)
  }
  return true
}

function matchesCandidate(
  report: SourceCandidateReport,
  mechanicalScope: MechanicalAdmissionPeriodScopeEstablished,
  candidate: MaterialCandidate,
): boolean {
  if (!samePeriod(candidate.period, report.period)
    || candidate.candidate.source !== report.source
    || !sameValue(candidate.period, report.period)) {
    return false
  }

  const qualification = candidate.qualification
  if (qualification.branch !== report.branch
    || (report.branch === 'unscreened' && qualification.contract !== 'C08')
    || (report.branch === 'screened' && qualification.contract !== 'C30')
    || !sameValue(qualification.scope, mechanicalScope)
    || !samePeriod(qualification.period, report.period)
    || !sameValue(qualification.candidate, candidate.candidate)
    || qualification.acceptedQualification === undefined) {
    return false
  }

  return sameValue(candidate.materialBasis.candidate, candidate.candidate)
    && candidate.materialBasis.acceptedBasis !== undefined
}

function validateReportShape(value: unknown): value is SourceCandidateReport {
  if (!isRecord(value)) return false
  const branch = value.branch
  if (!isReportBranch(branch)
    || !isRecord(value.scope)
    || !isRecord(value.scope.scope)
    || !isRecord(value.period)
    || !Array.isArray(value.candidates)) {
    return false
  }
  if (!isPeriodIdentity(value.period)
    || typeof value.source !== 'string'
    || !isMaterialProjectionScope(value.scope.scope)) {
    return false
  }
  return value.candidates.every(candidate => validateCandidateShape(candidate, branch))
}

function isReaderScope(value: unknown): value is MaterialProjectionReportScopeEstablished {
  if (!isRecord(value) || !hasExactKeys(value, ['scope'])) return false
  const scope = value.scope
  if (!isRecord(scope) || !hasExactKeys(scope, ['period', 'source', 'reportingWindow'])) return false
  if (!isMaterialProjectionScope(scope) || !isNonEmptyString(scope.source)) return false
  if (!hasExactKeys(scope.reportingWindow, ['window'])) return false
  const window = scope.reportingWindow.window
  return isRecord(window)
    && hasExactKeys(window, ['window', 'period', 'sources', 'closesAt'])
    && isPeriodIdentity(window.period)
    && isNonEmptyString(window.window)
    && isNonEmptyString(window.closesAt)
    && Array.isArray(window.sources)
    && window.sources.every(source => isNonEmptyString(source))
}

function validateCandidateShape(value: unknown, branch: ReportBranch): value is MaterialCandidate {
  if (!isRecord(value)
    || !isPeriodIdentity(value.period)
    || !isCandidateReference(value.candidate)
    || !isRecord(value.qualification)
    || !isRecord(value.materialBasis)) {
    return false
  }
  const qualification = value.qualification
  const materialBasis = value.materialBasis
  const expectedContract = branch === 'unscreened' ? 'C08' : 'C30'
  return qualification.branch === branch
    && qualification.contract === expectedContract
    && isPeriodIdentity(qualification.period)
    && isCandidateReference(qualification.candidate)
    && 'scope' in qualification
    && 'acceptedQualification' in qualification
    && qualification.acceptedQualification !== undefined
    && isCandidateReference(materialBasis.candidate)
    && 'acceptedBasis' in materialBasis
    && materialBasis.acceptedBasis !== undefined
}

function isReportBranch(value: unknown): value is ReportBranch {
  return value === 'unscreened' || value === 'screened'
}

function isMaterialProjectionScope(value: unknown): value is MaterialProjectionReportScope {
  if (!isRecord(value)
    || !isPeriodIdentity(value.period)
    || typeof value.source !== 'string'
    || !isRecord(value.reportingWindow)
    || !isRecord(value.reportingWindow.window)) {
    return false
  }
  const window = value.reportingWindow.window
  return isPeriodIdentity(window.period)
    && typeof window.window === 'string'
    && typeof window.closesAt === 'string'
    && Array.isArray(window.sources)
    && window.sources.every(source => typeof source === 'string')
}

function isCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && isNonEmptyString(value.source)
    && isNonEmptyString(value.candidate)
    && isNonEmptyString(value.stableReference)
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function candidateIdentityKey(reference: SourceCandidateReference): string {
  return `${reference.source}\u0000${reference.candidate}`
}

function stableReferenceIdentityKey(reference: SourceCandidateReference): string {
  return `${reference.source}\u0000${reference.stableReference}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function freezeAcceptedReport(report: SourceCandidateReport): {
  readonly report: SourceCandidateReport
} {
  const snapshot = deepFreeze(structuredClone(report))
  return Object.freeze({ report: snapshot })
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function rejected(input: SourceCandidateReport): C36Result {
  return { status: 'rejected', input }
}

function failed(input: SourceCandidateReport): C36Result {
  return { status: 'failed', input }
}
