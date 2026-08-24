import { createCandidatePeriodStore } from './candidate-period-store.ts'
import { createPeriodBusinessStore } from './period-business-store.ts'
import { createEditingInputStore } from './editing-input-store.ts'
import {
  createSourceCandidateReportStore,
  sourceCandidateReportScopeKey,
} from './source-candidate-report-store.ts'
import type {
  C16Result,
  C26Result,
  CandidateAcceptedIntoPeriod,
  MaterialFact,
  PeriodBusinessFinalizerOptions,
  ReportedMaterialCandidate,
  SourceCandidateReference,
} from './types.ts'

export function createCandidatePeriodFinalizer(
  options: PeriodBusinessFinalizerOptions & { readonly candidatePeriodLedgerPath: string },
): {
  readonly acceptCandidateIntoPeriod: (candidate: ReportedMaterialCandidate) => C26Result
  readonly acceptMaterialFact: (fact: MaterialFact) => C16Result
} {
  const reports = createSourceCandidateReportStore(options.reportLedgerPath)
  const candidates = createCandidatePeriodStore(options.candidatePeriodLedgerPath)
  const business = createPeriodBusinessStore(
    options.periodBusinessLedgerPath ?? `${options.candidatePeriodLedgerPath}.business.jsonl`,
  )
  const editingInputs = createEditingInputStore(
    options.editingInputLedgerPath ?? `${options.candidatePeriodLedgerPath}.editing-inputs.jsonl`,
  )

  return Object.freeze({
    acceptCandidateIntoPeriod: (input: ReportedMaterialCandidate): C26Result => {
      try {
        const persisted = reports.findByScope(sourceCandidateReportScopeKey(input.report.report))
        if (persisted === undefined || !sameValue(persisted, input.report)) return rejectedCandidate(input)

        const member = persisted.report.candidates.find(candidate => sameValue(candidate, input.candidate))
        if (member === undefined) return rejectedCandidate(input)

        const accepted: CandidateAcceptedIntoPeriod = deepFreeze({
          period: member.period,
          candidate: member.candidate,
          ...(member.nomination === undefined ? {} : { nomination: member.nomination }),
        })
        const existing = candidates.findCandidate(accepted.period, accepted.candidate)
        if (existing !== undefined) {
          return sameValue(existing, accepted)
            ? acceptedResult(existing)
            : rejectedCandidate(input)
        }
        if (editingInputs.findClosureByPeriod(input.candidate.period) !== undefined) {
          return rejectedCandidate(input)
        }
        if (business.list().some(record => record.event === 'editing_input_closure_accepted'
          && samePeriod(record.closure.period, input.candidate.period))) {
          return rejectedCandidate(input)
        }
        if (candidates.listCandidates().some(value => samePeriodCandidate(value.period, value.candidate, accepted.period, accepted.candidate))) {
          return rejectedCandidate(input)
        }
        candidates.appendCandidate(accepted)
        return acceptedResult(accepted)
      } catch {
        return failedCandidate(input)
      }
    },
    acceptMaterialFact: (input: MaterialFact): C16Result => {
      try {
        const accepted = candidates.findCandidate(input.period, input.candidate)
        if (accepted === undefined || !sameValue(accepted, input.acceptedIntoPeriod)
          || !samePeriodCandidate(accepted.period, accepted.candidate, input.period, input.candidate)) {
          return rejectedFact(input)
        }
        const existing = candidates.findMaterialFact(input.period, input.candidate)
        if (existing !== undefined) {
          return sameValue(existing, input) ? factResult(existing) : rejectedFact(input)
        }
        if (editingInputs.findClosureByPeriod(input.period) !== undefined) {
          return rejectedFact(input)
        }
        if (business.list().some(record => record.event === 'editing_input_closure_accepted'
          && samePeriod(record.closure.period, input.period))) {
          return rejectedFact(input)
        }
        candidates.appendMaterialFact(input)
        return factResult(candidates.findMaterialFact(input.period, input.candidate) ?? input)
      } catch {
        return failedFact(input)
      }
    },
  })
}

function acceptedResult(value: CandidateAcceptedIntoPeriod): C26Result {
  return { status: 'accepted', value }
}

function factResult(fact: MaterialFact): C16Result {
  return { status: 'accepted', value: { fact } }
}

function rejectedCandidate(input: ReportedMaterialCandidate): C26Result {
  return { status: 'rejected', input }
}

function failedCandidate(input: ReportedMaterialCandidate): C26Result {
  return { status: 'failed', input }
}

function rejectedFact(input: MaterialFact): C16Result {
  return { status: 'rejected', input }
}

function failedFact(input: MaterialFact): C16Result {
  return { status: 'failed', input }
}

function samePeriodCandidate(
  leftPeriod: { readonly run: string; readonly period: string },
  leftCandidate: SourceCandidateReference,
  rightPeriod: { readonly run: string; readonly period: string },
  rightCandidate: SourceCandidateReference,
): boolean {
  return leftPeriod.run === rightPeriod.run
    && leftPeriod.period === rightPeriod.period
    && leftCandidate.source === rightCandidate.source
    && leftCandidate.candidate === rightCandidate.candidate
}

function samePeriod(
  left: { readonly run: string; readonly period: string },
  right: { readonly run: string; readonly period: string },
): boolean {
  return left.run === right.run && left.period === right.period
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
