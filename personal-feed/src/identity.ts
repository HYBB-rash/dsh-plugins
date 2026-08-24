import { createHash } from 'node:crypto'
import type {
  CandidateReportingWindowIdentity,
  CandidateIdentity,
  PeriodReference,
  RunIdentity,
  RunRequestIdentity,
  SourceIdentity,
  SourceStableReference,
  RawFeedContentInput,
  EditingConclusionIdentity,
  FeedContentDeliveryObjectIdentity,
  SourceCandidateReference,
} from './types.ts'
import { encodeCanonicalJson } from './canonical-json.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'

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

export function candidateIdentity(value: string): CandidateIdentity {
  return value as CandidateIdentity
}

export function sourceStableReference(value: string): SourceStableReference {
  return value as SourceStableReference
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

export function rawFeedContentConclusionIdentityFor(input: RawFeedContentInput): EditingConclusionIdentity | undefined {
  if (encodeCanonicalJson(input) === undefined) return undefined
  const canonical = encodeCanonicalJson(normalizeRawConclusionInput(input))
  return canonical === undefined
    ? undefined
    : identity('personal-feed-raw-conclusion', canonical) as EditingConclusionIdentity
}

function normalizeRawConclusionInput(input: RawFeedContentInput): RawFeedContentInput {
  const candidateOrder = (left: { readonly candidate: SourceCandidateReference }, right: typeof left) =>
    compareStrings(canonicalCandidateTupleKey(left.candidate), canonicalCandidateTupleKey(right.candidate))
  return {
    ...input,
    closure: {
      ...input.closure,
      closure: {
        ...input.closure.closure,
        candidatesInJudgment: [...input.closure.closure.candidatesInJudgment].sort((left, right) => compareStrings(canonicalCandidateTupleKey(left), canonicalCandidateTupleKey(right))),
      },
    },
    decisions: {
      ...input.decisions,
      candidatesInJudgment: [...input.decisions.candidatesInJudgment].sort((left, right) => compareStrings(canonicalCandidateTupleKey(left), canonicalCandidateTupleKey(right))),
      decisions: [...input.decisions.decisions].sort(candidateOrder),
    },
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function formalFeedContentObjectIdentityFor(conclusion: EditingConclusionIdentity): FeedContentDeliveryObjectIdentity {
  return identity('personal-feed-formal-content', conclusion) as FeedContentDeliveryObjectIdentity
}
