import { createHash } from 'node:crypto'
import type {
  CandidateReportingWindowIdentity,
  PeriodReference,
  RunIdentity,
  RunRequestIdentity,
  SourceIdentity,
} from './types.ts'

function identity(namespace: string, evidence: string): string {
  const digest = createHash('sha256').update(`${namespace}\0${evidence}`).digest('hex')
  return `${namespace}:${digest}`
}

export function runRequestIdentity(value: string): RunRequestIdentity {
  return value as RunRequestIdentity
}

export function sourceIdentity(value: string): SourceIdentity {
  return value as SourceIdentity
}

export function runIdentityFor(request: RunRequestIdentity): RunIdentity {
  return identity('personal-feed-run', request) as RunIdentity
}

export function periodReferenceFor(run: RunIdentity): PeriodReference {
  return identity('personal-feed-period', run) as PeriodReference
}

export function reportingWindowIdentityFor(evidence: string): CandidateReportingWindowIdentity {
  return identity('personal-feed-window', evidence) as CandidateReportingWindowIdentity
}
