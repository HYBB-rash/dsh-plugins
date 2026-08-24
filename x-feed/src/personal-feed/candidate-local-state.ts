import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { X_FEED_SOURCE_IDENTITY } from '../feed-scope-adapter.ts'
import type {
  C17Result,
  C18Result,
  CandidateDispositionReceiver,
  CandidateDispositionValue,
  DispositionBasisAccepted,
  FormalCandidateDisposition,
  PeriodIdentity,
  SourceCandidateReference,
  SourceDispositionState,
} from '@herman/personal-feed'

type CandidateLocalEntry = {
  readonly disposition: FormalCandidateDisposition
  readonly state: SourceDispositionState
}

type CandidateLocalProjection = {
  readonly entries: readonly CandidateLocalEntry[]
  readonly completions: readonly SourceDispositionState[]
}

const dispositionValues: readonly CandidateDispositionValue[] = [
  'PeriodAdmissionNotCompletedAndClosed',
  'MaterialUnavailableAndClosed',
  'ReviewedNotSelected',
  'Shown',
  'NotDeliveredThisPeriod',
  'PossiblyDelivered',
  'EditingFailed',
  'PeriodExpired',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPeriod(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['run', 'period'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function isCandidate(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && hasExactKeys(value, ['source', 'candidate', 'stableReference'])
    && value.source === X_FEED_SOURCE_IDENTITY
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function isDisposition(value: unknown): value is FormalCandidateDisposition {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'source', 'candidate', 'value'])
    && isPeriod(value.period)
    && value.source === X_FEED_SOURCE_IDENTITY
    && isCandidate(value.candidate)
    && value.candidate.source === value.source
    && typeof value.value === 'string'
    && dispositionValues.includes(value.value as CandidateDispositionValue)
}

function sourceCompletionMatches(value: unknown, disposition: FormalCandidateDisposition): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['disposition'])
    && isDisposition(value.disposition)
    && sameDisposition(value.disposition, disposition)
}

function isState(value: unknown, disposition: FormalCandidateDisposition): value is SourceDispositionState {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'candidate', 'state', 'sourceCompletion'])
    && isPeriod(value.period)
    && isCandidate(value.candidate)
    && (value.state === 'Displayed' || value.state === 'Suppressed')
    && samePeriod(value.period, disposition.period)
    && sameCandidate(value.candidate, disposition.candidate)
    && value.state === stateValue(disposition.value)
    && sourceCompletionMatches(value.sourceCompletion, disposition)
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function sameScope(
  left: { readonly period: PeriodIdentity; readonly candidate: SourceCandidateReference },
  right: { readonly period: PeriodIdentity; readonly candidate: SourceCandidateReference },
): boolean {
  return samePeriod(left.period, right.period) && sameCandidate(left.candidate, right.candidate)
}

function sameDisposition(left: FormalCandidateDisposition, right: FormalCandidateDisposition): boolean {
  return sameScope(left, right) && left.source === right.source && left.value === right.value
}

function sameCompletion(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false
  if (!hasExactKeys(left, ['disposition']) || !hasExactKeys(right, ['disposition'])) return false
  return isDisposition(left.disposition)
    && isDisposition(right.disposition)
    && sameDisposition(left.disposition, right.disposition)
}

function sameEntry(left: CandidateLocalEntry, right: CandidateLocalEntry): boolean {
  return sameDisposition(left.disposition, right.disposition)
    && sameScope(left.state, right.state)
    && left.state.state === right.state.state
    && sameCompletion(left.state.sourceCompletion, right.state.sourceCompletion)
}

function sameEntrySet(left: readonly CandidateLocalEntry[], right: readonly CandidateLocalEntry[]): boolean {
  if (left.length !== right.length) return false
  const matched = new Set<number>()
  for (const expected of left) {
    const matchIndex = right.findIndex((candidate, index) => !matched.has(index) && sameEntry(expected, candidate))
    if (matchIndex < 0) return false
    matched.add(matchIndex)
  }
  return true
}

function sameState(left: SourceDispositionState, right: SourceDispositionState): boolean {
  return sameScope(left, right)
    && left.state === right.state
    && sameCompletion(left.sourceCompletion, right.sourceCompletion)
}

function sameStateSet(left: readonly SourceDispositionState[], right: readonly SourceDispositionState[]): boolean {
  if (left.length !== right.length) return false
  const matched = new Set<number>()
  for (const expected of left) {
    const matchIndex = right.findIndex((state, index) => !matched.has(index) && sameState(expected, state))
    if (matchIndex < 0) return false
    matched.add(matchIndex)
  }
  return true
}

function sameProjection(left: CandidateLocalProjection, right: CandidateLocalProjection): boolean {
  return sameEntrySet(left.entries, right.entries)
    && sameStateSet(left.completions, right.completions)
}

function sameOrderedProjection(left: CandidateLocalProjection, right: CandidateLocalProjection): boolean {
  return left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const other = right.entries[index]
      return other !== undefined && sameEntry(entry, other)
    })
    && left.completions.length === right.completions.length
    && left.completions.every((state, index) => {
      const other = right.completions[index]
      return other !== undefined && sameState(state, other)
    })
}

function stateValue(value: CandidateDispositionValue): SourceDispositionState['state'] {
  return value === 'Shown' ? 'Displayed' : 'Suppressed'
}

function createState(disposition: FormalCandidateDisposition): SourceDispositionState {
  const sourceCompletion: DispositionBasisAccepted = { disposition }
  return {
    period: disposition.period,
    candidate: disposition.candidate,
    state: stateValue(disposition.value),
    sourceCompletion,
  }
}

function readProjection(path: string): CandidateLocalProjection {
  if (!existsSync(path)) return { entries: [], completions: [] }
  const text = readFileSync(path, 'utf8')
  if (text === '') return { entries: [], completions: [] }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const entries: CandidateLocalEntry[] = []
  const completions: SourceDispositionState[] = []
  for (const line of lines) {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.event !== 'string') {
      throw new Error('candidate-local-state ledger entry has an invalid shape')
    }
    if (value.event === 'candidate_disposition_accepted') {
      if (!hasExactKeys(value, ['schemaVersion', 'event', 'disposition', 'state'])
        || !isDisposition(value.disposition)
        || !isState(value.state, value.disposition)) {
        throw new Error('candidate-local-state ledger entry has an invalid owner')
      }
      entries.push({ disposition: value.disposition, state: value.state })
      continue
    }
    if (value.event === 'source_disposition_completion_accepted') {
      if (!hasExactKeys(value, ['schemaVersion', 'event', 'state'])) {
        throw new Error('candidate-local-state ledger entry has an invalid completion')
      }
      const completionState = value.state
      if (!isRecord(completionState)) {
        throw new Error('candidate-local-state ledger entry has an invalid completion')
      }
      const sourceCompletion = completionState.sourceCompletion
      if (!isRecord(sourceCompletion)
        || !isDisposition(sourceCompletion.disposition)
        || !isState(completionState, sourceCompletion.disposition)) {
        throw new Error('candidate-local-state ledger entry has an invalid completion')
      }
      if (!entries.some(entry => sameState(entry.state, completionState))) {
        throw new Error('candidate-local-state completion precedes its exact owner')
      }
      if (completions.some(completion => sameScope(completion, completionState))) {
        throw new Error('candidate-local-state ledger has more than one completion for a scope')
      }
      completions.push(completionState)
      continue
    }
    throw new Error('candidate-local-state ledger entry has an unsupported schema')
  }
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      if (sameScope(left.disposition, right.disposition)) {
        throw new Error('candidate-local-state ledger has more than one owner for a scope')
      }
    }
  }
  for (const completion of completions) {
    if (!entries.some(entry => sameState(entry.state, completion))) {
      throw new Error('candidate-local-state completion has no exact owner')
    }
  }
  return { entries, completions }
}

function writeProjection(path: string, projection: CandidateLocalProjection): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const records = projection.entries.map(existing => ({
    schemaVersion: 1,
    event: 'candidate_disposition_accepted',
    disposition: existing.disposition,
    state: existing.state,
  }))
  const completionRecords = projection.completions.map(state => ({
    schemaVersion: 1,
    event: 'source_disposition_completion_accepted',
    state,
  }))
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryPath, `${[...records, ...completionRecords].map(record => JSON.stringify(record)).join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

export type CandidateLocalCompletionResult =
  | { readonly status: 'failed' }
  | { readonly status: 'completed'; readonly value: { readonly completed: number } }

export type CandidateLocalCompletionPort = {
  readonly requestSourceDisposition: (disposition: FormalCandidateDisposition) => C17Result
  readonly acceptSourceDispositionState: (state: SourceDispositionState) => C18Result
}

export type CandidateLocalStateOptions = {
  readonly ledgerPath: string
  readonly completionPort?: CandidateLocalCompletionPort
}

export type CandidateLocalStateRuntime = {
  readonly candidateDispositionReceiver: CandidateDispositionReceiver
  readonly completePendingSourceDispositions: () => CandidateLocalCompletionResult
  readonly readSourceDispositionState: (
    period: PeriodIdentity,
    candidate: SourceCandidateReference,
  ) => SourceDispositionState | undefined
}

export function createCandidateLocalState(
  options: CandidateLocalStateOptions,
): CandidateLocalStateRuntime {
  const acceptFormalDisposition = (disposition: FormalCandidateDisposition): C17Result => {
    if (!isDisposition(disposition)) return { status: 'rejected', input: disposition }

    let projection: CandidateLocalProjection
    try {
      projection = readProjection(options.ledgerPath)
    } catch {
      return { status: 'failed', input: disposition }
    }
    const existing = projection.entries.find(entry => sameScope(entry.disposition, disposition))
    if (existing !== undefined) {
      return sameDisposition(existing.disposition, disposition)
        ? { status: 'accepted', value: { disposition } }
        : { status: 'rejected', input: disposition }
    }
    const entry: CandidateLocalEntry = {
      disposition,
      state: createState(disposition),
    }
    try {
      writeProjection(options.ledgerPath, {
        entries: [...projection.entries, entry],
        completions: projection.completions,
      })
    } catch {
      try {
        const recovered = readProjection(options.ledgerPath)
        if (sameProjection({
          entries: [...projection.entries, entry],
          completions: projection.completions,
        }, recovered)) {
          return { status: 'accepted', value: { disposition } }
        }
      } catch {
        return { status: 'failed', input: disposition }
      }
      return { status: 'failed', input: disposition }
    }
    return { status: 'accepted', value: { disposition } }
  }

  const candidateDispositionReceiver: CandidateDispositionReceiver = Object.freeze({
    acceptFormalDisposition,
  })

  return Object.freeze({
    candidateDispositionReceiver,
    completePendingSourceDispositions: (): CandidateLocalCompletionResult => {
      if (options.completionPort === undefined) return { status: 'failed' }
      let projection: CandidateLocalProjection
      try {
        projection = readProjection(options.ledgerPath)
      } catch {
        return { status: 'failed' }
      }
      let completed = 0
      let hadFailure = false
      for (const entry of projection.entries) {
        if (projection.completions.some(state => sameState(state, entry.state))) continue
        let dispositionResult: C17Result
        try {
          dispositionResult = options.completionPort.requestSourceDisposition(entry.disposition)
        } catch {
          hadFailure = true
          continue
        }
        if (dispositionResult.status !== 'accepted'
          || !sameDisposition(dispositionResult.value.disposition, entry.disposition)) {
          hadFailure = true
          continue
        }
        let completionResult: C18Result
        try {
          completionResult = options.completionPort.acceptSourceDispositionState(entry.state)
        } catch {
          hadFailure = true
          continue
        }
        if (completionResult.status !== 'accepted'
          || !sameState(completionResult.value.state, entry.state)) {
          hadFailure = true
          continue
        }
        const nextProjection = {
          entries: projection.entries,
          completions: [...projection.completions, entry.state],
        }
        try {
          writeProjection(options.ledgerPath, nextProjection)
        } catch {
          try {
            const recovered = readProjection(options.ledgerPath)
            if (!sameOrderedProjection(nextProjection, recovered)) {
              hadFailure = true
              continue
            }
          } catch {
            hadFailure = true
            continue
          }
        }
        projection = nextProjection
        completed += 1
      }
      return hadFailure ? { status: 'failed' } : { status: 'completed', value: { completed } }
    },
    readSourceDispositionState: (period, candidate): SourceDispositionState | undefined => {
      return readProjection(options.ledgerPath).entries
        .find(entry => sameScope(entry.state, { period, candidate }))?.state
    },
  })
}
