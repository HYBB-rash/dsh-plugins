import { readJsonLines, appendJsonLine } from './durable-jsonl-store.ts'
import { rawFeedContentConclusionIdentityFor } from './identity.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'
import type {
  CandidateMaterial,
  CandidateEditingDecision,
  CompleteCandidateEditingDecisions,
  EditedFeedContent,
  EditingInputClosure,
  EditingInputClosureAccepted,
  EditingConclusionIdentity,
  PeriodIdentity,
  RawFeedContentConclusion,
  RawFeedContentInput,
  SourceCandidateReference,
  DisplayFact,
  FormalCandidateDisposition,
} from './types.ts'

type EditingInputRecord =
  | {
      readonly schemaVersion: 1
      readonly event: 'editing_input_accepted'
      readonly material: CandidateMaterial
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'editing_input_closure_accepted'
      readonly closure: EditingInputClosure
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'raw_feed_content_conclusion_accepted'
      readonly input: RawFeedContentInput
      readonly conclusion: RawFeedContentConclusion
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'display_fact_accepted'
      readonly fact: DisplayFact
    }

export interface EditingInputStore {
  readonly findByCandidate: (material: CandidateMaterial) => CandidateMaterial | undefined
  readonly list: () => readonly CandidateMaterial[]
  readonly append: (material: CandidateMaterial) => void
  readonly findClosure: (closure: EditingInputClosure) => EditingInputClosureAccepted | undefined
  readonly findClosureByPeriod: (period: EditingInputClosure['period']) => EditingInputClosureAccepted | undefined
  readonly appendClosure: (closure: EditingInputClosure) => void
  readonly findRawConclusion: (input: RawFeedContentInput) => RawFeedContentConclusion | undefined
  readonly findRawConclusionByIdentity: (identity: RawFeedContentConclusion['conclusion']) => RawFeedContentConclusion | undefined
  readonly findRawConclusionByClosure: (closure: EditingInputClosureAccepted) => RawFeedContentConclusion | undefined
  readonly appendRawConclusion: (input: RawFeedContentInput, conclusion: RawFeedContentConclusion) => void
  readonly listDisplayFacts: () => readonly DisplayFact[]
  readonly appendDisplayFact: (fact: DisplayFact) => void
}

export function createEditingInputStore(path: string): EditingInputStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed editing input ledger path must be non-empty')
  }

  return Object.freeze({
    findByCandidate: (material: CandidateMaterial) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'editing_input_accepted' }> =>
        record.event === 'editing_input_accepted')
      .map(record => record.material)
      .find(existing => sameCandidatePeriod(existing, material)),
    list: () => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'editing_input_accepted' }> =>
        record.event === 'editing_input_accepted')
      .map(record => record.material),
    append: (material: CandidateMaterial) => {
      const records = readRecords(path)
      const nextRecord: EditingInputRecord = {
        schemaVersion: 1,
        event: 'editing_input_accepted',
        material: deepFreeze(structuredClone(material)),
      }
      appendJsonLine(path, records, nextRecord)
    },
    findClosure: (closure: EditingInputClosure) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'editing_input_closure_accepted' }> =>
        record.event === 'editing_input_closure_accepted')
      .map(record => ({ closure: record.closure }))
      .find(existing => sameClosure(existing.closure, closure)),
    findClosureByPeriod: (period: EditingInputClosure['period']) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'editing_input_closure_accepted' }> =>
        record.event === 'editing_input_closure_accepted')
      .map(record => ({ closure: record.closure }))
      .find(existing => samePeriod(existing.closure.period, period)),
    appendClosure: (closure: EditingInputClosure) => appendRecord(path, {
      schemaVersion: 1,
      event: 'editing_input_closure_accepted',
      closure,
    }),
    findRawConclusion: (input: RawFeedContentInput) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'raw_feed_content_conclusion_accepted' }> =>
        record.event === 'raw_feed_content_conclusion_accepted')
      .find(record => record.conclusion.conclusion === rawFeedContentConclusionIdentityFor(input))?.conclusion,
    findRawConclusionByIdentity: (identity: EditingConclusionIdentity) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'raw_feed_content_conclusion_accepted' }> =>
        record.event === 'raw_feed_content_conclusion_accepted')
      .find(record => record.conclusion.conclusion === identity)?.conclusion,
    findRawConclusionByClosure: (closure: EditingInputClosureAccepted) => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'raw_feed_content_conclusion_accepted' }> =>
        record.event === 'raw_feed_content_conclusion_accepted')
      .find(record => sameClosure(record.input.closure.closure, closure.closure))?.conclusion,
    appendRawConclusion: (input: RawFeedContentInput, conclusion: RawFeedContentConclusion) => appendRecord(path, {
      schemaVersion: 1,
      event: 'raw_feed_content_conclusion_accepted',
      input,
      conclusion,
    }),
    listDisplayFacts: () => readRecords(path)
      .filter((record): record is Extract<EditingInputRecord, { event: 'display_fact_accepted' }> =>
        record.event === 'display_fact_accepted')
      .map(record => record.fact),
    appendDisplayFact: (fact: DisplayFact) => appendRecord(path, {
      schemaVersion: 1,
      event: 'display_fact_accepted',
      fact,
    }),
  })
}

function readRecords(path: string): readonly EditingInputRecord[] {
  return readJsonLines(path, 'editing input').map((value, index) => parseRecord(value, index + 1))
}

function parseRecord(value: unknown, lineNumber: number): EditingInputRecord {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.event !== 'string'
    || !['editing_input_accepted', 'editing_input_closure_accepted', 'raw_feed_content_conclusion_accepted', 'display_fact_accepted']
      .includes(value.event)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed editing input ledger line ${lineNumber} has an unsupported schema`,
    )
  }
  if (value.event === 'editing_input_accepted' && !isRecord(value.material)) {
    throw new PersonalFeedScopeStoreError(`personal Feed editing input ledger line ${lineNumber} has an invalid material fact`)
  }
  if (value.event === 'editing_input_closure_accepted'
    && (!hasExactKeys(value, ['schemaVersion', 'event', 'closure']) || !isEditingInputClosure(value.closure))) {
    throw new PersonalFeedScopeStoreError(`personal Feed editing input ledger line ${lineNumber} has an invalid closure fact`)
  }
  if (value.event === 'raw_feed_content_conclusion_accepted'
    && (!hasExactKeys(value, ['schemaVersion', 'event', 'input', 'conclusion'])
      || !isRawFeedContentInput(value.input)
      || !isRawFeedContentConclusion(value.conclusion)
      || !sameValue(value.conclusion.closure, value.input.closure)
      || !sameValue(value.conclusion.content, value.input.content)
      || !sameValue(value.conclusion.decisions, value.input.decisions)
      || rawFeedContentConclusionIdentityFor(value.input) !== value.conclusion.conclusion)) {
    throw new PersonalFeedScopeStoreError(`personal Feed editing input ledger line ${lineNumber} has an invalid raw conclusion fact`)
  }
  if (value.event === 'display_fact_accepted'
    && (!hasExactKeys(value, ['schemaVersion', 'event', 'fact']) || !isDisplayFact(value.fact))) {
    throw new PersonalFeedScopeStoreError(`personal Feed editing input ledger line ${lineNumber} has an invalid display fact`)
  }
  return deepFreeze(value as unknown as EditingInputRecord)
}

function appendRecord(path: string, record: EditingInputRecord): void {
  const records = readRecords(path)
  appendJsonLine(path, records, deepFreeze(structuredClone(record)))
}

function sameCandidatePeriod(left: CandidateMaterial, right: CandidateMaterial): boolean {
  return left.period.run === right.period.run
    && left.period.period === right.period.period
    && left.candidate.source === right.candidate.source
    && left.candidate.candidate === right.candidate.candidate
    && left.candidate.stableReference === right.candidate.stableReference
}

function isEditingInputClosure(value: unknown): value is EditingInputClosure {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'candidatesInJudgment'])
    && isPeriodIdentity(value.period)
    && Array.isArray(value.candidatesInJudgment)
    && value.candidatesInJudgment.every(isCandidateReference)
    && new Set(value.candidatesInJudgment.map(canonicalCandidateTupleKey)).size === value.candidatesInJudgment.length
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['run', 'period'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function isCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && hasExactKeys(value, ['source', 'candidate', 'stableReference'])
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function isRawFeedContentInput(value: unknown): value is RawFeedContentInput {
  return isRecord(value)
    && hasExactKeys(value, ['closure', 'content', 'decisions'])
    && isEditingInputClosureAccepted(value.closure)
    && isEditedFeedContent(value.content)
    && isCompleteDecisions(value.decisions)
}

function isEditingInputClosureAccepted(value: unknown): value is EditingInputClosureAccepted {
  return isRecord(value) && hasExactKeys(value, ['closure']) && isEditingInputClosure(value.closure)
}

function isEditedFeedContent(value: unknown): value is EditedFeedContent {
  return isRecord(value) && hasExactKeys(value, ['body'])
}

function isDisplayFact(value: unknown): value is DisplayFact {
  if (!isRecord(value)
    || !hasExactKeys(value, ['period', 'candidate', 'disposition', 'receipt'])
    || !isPeriodIdentity(value.period)
    || !isCandidateReference(value.candidate)
    || !isFormalCandidateDisposition(value.disposition)
    || !isFormalFeedContentDeliveryReceipt(value.receipt)
    || !samePeriod(value.period, value.disposition.period)
    || !sameCandidate(value.candidate, value.disposition.candidate)
    || value.disposition.source !== value.candidate.source
    || !samePeriod(value.period, value.receipt.period)) return false
  const compatible = value.receipt.result === 'Delivered'
    ? value.disposition.value === 'Shown'
    : value.receipt.result === 'Failed'
      ? value.disposition.value === 'NotDeliveredThisPeriod'
      : value.disposition.value === 'PossiblyDelivered'
  return compatible
}

function isFormalCandidateDisposition(value: unknown): value is FormalCandidateDisposition {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'source', 'candidate', 'value'])
    && isPeriodIdentity(value.period)
    && typeof value.source === 'string'
    && isCandidateReference(value.candidate)
    && typeof value.value === 'string'
    && ['PeriodAdmissionNotCompletedAndClosed', 'MaterialUnavailableAndClosed', 'ReviewedNotSelected',
      'Shown', 'NotDeliveredThisPeriod', 'PossiblyDelivered', 'EditingFailed', 'PeriodExpired'].includes(value.value)
}

function isFormalFeedContentDeliveryReceipt(value: unknown): value is {
  readonly object: string
  readonly period: PeriodIdentity
  readonly result: 'Delivered' | 'Failed' | 'Uncertain'
} {
  return isRecord(value)
    && hasExactKeys(value, ['object', 'period', 'result'])
    && typeof value.object === 'string'
    && isPeriodIdentity(value.period)
    && (value.result === 'Delivered' || value.result === 'Failed' || value.result === 'Uncertain')
}

function isCompleteDecisions(value: unknown): value is CompleteCandidateEditingDecisions {
  if (!isRecord(value)
    || !hasExactKeys(value, ['candidatesInJudgment', 'decisions'])
    || !Array.isArray(value.candidatesInJudgment)
    || !value.candidatesInJudgment.every(isCandidateReference)
    || !Array.isArray(value.decisions)
    || !value.decisions.every(isCandidateDecision)
    || value.candidatesInJudgment.length === 0
    || value.decisions.length !== value.candidatesInJudgment.length) return false
  const candidates = new Set(value.candidatesInJudgment.map(canonicalCandidateTupleKey))
  if (candidates.size !== value.candidatesInJudgment.length) return false
  const decisions = new Set<string>()
  let selected = 0
  for (const decision of value.decisions) {
    const key = canonicalCandidateTupleKey(decision.candidate)
    if (!candidates.has(key) || decisions.has(key)) return false
    decisions.add(key)
    if (decision.kind === 'selected') selected += 1
  }
  return selected >= 1 && decisions.size === candidates.size
}

function isCandidateDecision(value: unknown): value is CandidateEditingDecision {
  if (!isRecord(value) || !isCandidateReference(value.candidate) || typeof value.kind !== 'string') return false
  if (value.kind === 'selected') return hasExactKeys(value, ['kind', 'candidate'])
  return value.kind === 'not_selected'
    && hasExactKeys(value, ['kind', 'candidate', 'semanticReason'])
    && value.semanticReason !== undefined
}

function isRawFeedContentConclusion(value: unknown): value is RawFeedContentConclusion {
  return isRecord(value)
    && hasExactKeys(value, ['conclusion', 'closure', 'content', 'decisions'])
    && typeof value.conclusion === 'string'
    && isEditingInputClosureAccepted(value.closure)
    && isEditedFeedContent(value.content)
    && isCompleteDecisions(value.decisions)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function sameClosure(left: EditingInputClosure, right: EditingInputClosure): boolean {
  return samePeriod(left.period, right.period)
    && left.candidatesInJudgment.length === right.candidatesInJudgment.length
    && new Set(left.candidatesInJudgment.map(canonicalCandidateTupleKey)).size === left.candidatesInJudgment.length
    && new Set(right.candidatesInJudgment.map(canonicalCandidateTupleKey)).size === right.candidatesInJudgment.length
    && left.candidatesInJudgment.every(candidate => right.candidatesInJudgment.some(value => canonicalCandidateTupleKey(value) === canonicalCandidateTupleKey(candidate)))
}

function samePeriod(
  left: { readonly run: string; readonly period: string },
  right: { readonly run: string; readonly period: string },
): boolean {
  return left.run === right.run && left.period === right.period
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
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
