import { readJsonLines, appendJsonLine } from './durable-jsonl-store.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import type {
  CandidateAcceptedIntoPeriod,
  MaterialFact,
  PeriodIdentity,
  SourceCandidateReference,
} from './types.ts'

type CandidatePeriodRecord =
  | {
      readonly schemaVersion: 1
      readonly event: 'candidate_accepted_into_period'
      readonly accepted: CandidateAcceptedIntoPeriod
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'material_fact_recorded'
      readonly fact: MaterialFact
    }

export interface CandidatePeriodStore {
  readonly findCandidate: (
    period: PeriodIdentity,
    candidate: SourceCandidateReference,
  ) => CandidateAcceptedIntoPeriod | undefined
  readonly findMaterialFact: (
    period: PeriodIdentity,
    candidate: SourceCandidateReference,
  ) => MaterialFact | undefined
  readonly listCandidates: () => readonly CandidateAcceptedIntoPeriod[]
  readonly listMaterialFacts: () => readonly MaterialFact[]
  readonly appendCandidate: (accepted: CandidateAcceptedIntoPeriod) => void
  readonly appendMaterialFact: (fact: MaterialFact) => void
}

export function createCandidatePeriodStore(path: string): CandidatePeriodStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed candidate period ledger path must be non-empty')
  }

  return Object.freeze({
    findCandidate: (period: PeriodIdentity, candidate: SourceCandidateReference) =>
      readRecords(path)
        .filter((record): record is Extract<CandidatePeriodRecord, { event: 'candidate_accepted_into_period' }> =>
          record.event === 'candidate_accepted_into_period')
        .map(record => record.accepted)
        .find(value => sameCandidatePeriod(value.period, value.candidate, period, candidate)),
    findMaterialFact: (period: PeriodIdentity, candidate: SourceCandidateReference) =>
      readRecords(path)
        .filter((record): record is Extract<CandidatePeriodRecord, { event: 'material_fact_recorded' }> =>
          record.event === 'material_fact_recorded')
        .map(record => record.fact)
        .find(value => sameCandidatePeriod(value.period, value.candidate, period, candidate)),
    listCandidates: () => readRecords(path)
      .filter((record): record is Extract<CandidatePeriodRecord, { event: 'candidate_accepted_into_period' }> =>
        record.event === 'candidate_accepted_into_period')
      .map(record => record.accepted),
    listMaterialFacts: () => readRecords(path)
      .filter((record): record is Extract<CandidatePeriodRecord, { event: 'material_fact_recorded' }> =>
        record.event === 'material_fact_recorded')
      .map(record => record.fact),
    appendCandidate: (accepted: CandidateAcceptedIntoPeriod) => {
      append(path, { schemaVersion: 1, event: 'candidate_accepted_into_period', accepted })
    },
    appendMaterialFact: (fact: MaterialFact) => {
      append(path, { schemaVersion: 1, event: 'material_fact_recorded', fact })
    },
  })
}

function readRecords(path: string): readonly CandidatePeriodRecord[] {
  return readJsonLines(path, 'candidate period').map((value, index) => parseRecord(value, index + 1))
}

function parseRecord(value: unknown, lineNumber: number): CandidatePeriodRecord {
  if (!isRecord(value) || value.schemaVersion !== 1
    || (value.event !== 'candidate_accepted_into_period' && value.event !== 'material_fact_recorded')) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed candidate period ledger line ${lineNumber} has an unsupported schema`,
    )
  }
  if (value.event === 'candidate_accepted_into_period' && !isRecord(value.accepted)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed candidate period ledger line ${lineNumber} has an invalid candidate fact`,
    )
  }
  if (value.event === 'material_fact_recorded' && !isRecord(value.fact)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed candidate period ledger line ${lineNumber} has an invalid material fact`,
    )
  }
  return deepFreeze(value as CandidatePeriodRecord)
}

function append(path: string, record: CandidatePeriodRecord): void {
  const records = readRecords(path)
  appendJsonLine(path, records, deepFreeze(structuredClone(record)))
}

function sameCandidatePeriod(
  leftPeriod: PeriodIdentity,
  leftCandidate: SourceCandidateReference,
  rightPeriod: PeriodIdentity,
  rightCandidate: SourceCandidateReference,
): boolean {
  return leftPeriod.run === rightPeriod.run
    && leftPeriod.period === rightPeriod.period
    && leftCandidate.source === rightCandidate.source
    && leftCandidate.candidate === rightCandidate.candidate
    && leftCandidate.stableReference === rightCandidate.stableReference
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
