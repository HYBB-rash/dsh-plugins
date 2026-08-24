import { readJsonLines, appendJsonLine } from './durable-jsonl-store.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import { formalFeedContentObjectIdentityFor, rawFeedContentConclusionIdentityFor } from './identity.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'
import type {
  DispositionBasisAccepted,
  CandidateEditingDecision,
  CompleteCandidateEditingDecisions,
  EditedFeedContent,
  EditingInputClosure,
  EditingInputClosureAccepted,
  FormalCandidateDisposition,
  FormalOrdinaryFeedContent,
  FormalFeedContentConclusion,
  FormalFeedContentDeliveryAccepted,
  FormalFeedContentDeliveryRequest,
  FormalFeedContentDeliveryReceipt,
  PeriodDeliveryResultRecorded,
  BusinessFinalization,
  RunFinalizationAccepted,
  EditingConclusionIdentity,
  RawFeedContentConclusion,
  PeriodIdentity,
  SourceCandidateReference,
  SourceDispositionState,
} from './types.ts'

export type PeriodBusinessRecord =
  | {
      readonly schemaVersion: 1
      readonly event: 'editing_input_closure_accepted'
      readonly closure: EditingInputClosure
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'formal_editing_conclusion_accepted'
      readonly raw: RawFeedContentConclusion
      readonly formal: FormalFeedContentConclusion
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'candidate_disposition_accepted'
      readonly disposition: FormalCandidateDisposition
      readonly accepted: DispositionBasisAccepted
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'source_disposition_state_accepted'
      readonly state: SourceDispositionState
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'formal_content_delivery_accepted'
      readonly request: FormalFeedContentDeliveryRequest
      readonly accepted: FormalFeedContentDeliveryAccepted
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'formal_content_delivery_receipt_accepted'
      readonly receipt: FormalFeedContentDeliveryReceipt
      readonly accepted: PeriodDeliveryResultRecorded
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'business_finalization_accepted'
      readonly finalization: BusinessFinalization
      readonly accepted: RunFinalizationAccepted
    }

export interface PeriodBusinessStore {
  readonly list: () => readonly PeriodBusinessRecord[]
  readonly append: (record: PeriodBusinessRecord) => void
}

export function createPeriodBusinessStore(path: string): PeriodBusinessStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed period business ledger path must be non-empty')
  }

  return Object.freeze({
    list: () => readRecords(path),
    append: (record: PeriodBusinessRecord) => appendRecord(path, record),
  })
}

function readRecords(path: string): readonly PeriodBusinessRecord[] {
  const records = readJsonLines(path, 'period business').map((value, index) => parseRecord(value, index + 1))
  validateDeliveryProjection(records)
  return records
}

function validateDeliveryProjection(records: readonly PeriodBusinessRecord[]): void {
  const deliveries = records.filter(record => record.event === 'formal_content_delivery_accepted')
  const receipts = records.filter(record => record.event === 'formal_content_delivery_receipt_accepted')
  const finalizations = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'business_finalization_accepted' }> =>
    record.event === 'business_finalization_accepted'
    && record.finalization.kind === 'ordinary_content_finalized')

  for (let index = 0; index < deliveries.length; index += 1) {
    const delivery = deliveries[index]
    if (delivery === undefined) continue
    if (deliveries.slice(index + 1).some(other => other.request.object.object === delivery.request.object.object)) {
      invalidDeliveryProjection('formal Feed object has more than one C19 owner')
    }
  }

  for (const receipt of receipts) {
    const parents = deliveries.filter(delivery => delivery.request.object.object === receipt.receipt.object
      && samePeriod(delivery.request.object.period, receipt.receipt.period))
    if (parents.length !== 1) {
      invalidDeliveryProjection('C21 receipt does not have exactly one C19 parent')
    }
  }

  for (const delivery of deliveries) {
    const children = receipts.filter(receipt => receipt.receipt.object === delivery.request.object.object
      && samePeriod(receipt.receipt.period, delivery.request.object.period))
    if (children.length > 1) {
      invalidDeliveryProjection('C19 owner has more than one C21 receipt')
    }
  }

  for (let index = 0; index < finalizations.length; index += 1) {
    const finalization = finalizations[index]
    if (finalization === undefined) continue
    if (finalizations.slice(index + 1).some(other => samePeriod(other.finalization.period, finalization.finalization.period))) {
      invalidDeliveryProjection('ordinary C23 has more than one finalization owner')
    }
    const parents = deliveries.filter(delivery => samePeriod(delivery.request.object.period, finalization.finalization.period))
    if (parents.length !== 1) {
      invalidDeliveryProjection('ordinary C23 does not have exactly one C19 parent')
    }
  }
}

function invalidDeliveryProjection(reason: string): never {
  throw new PersonalFeedScopeStoreError(`personal Feed period business delivery projection is invalid: ${reason}`)
}

function parseRecord(value: unknown, lineNumber: number): PeriodBusinessRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return invalidRecord(lineNumber)
  }
  if (typeof value.event !== 'string') return invalidRecord(lineNumber)
  let valid = false
  switch (value.event) {
    case 'editing_input_closure_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'closure']) && isEditingInputClosure(value.closure)
      break
    case 'formal_editing_conclusion_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'raw', 'formal'])
        && isRawFeedContentConclusion(value.raw)
        && isFormalEditingConclusionPair(value.raw, value.formal)
      break
    case 'candidate_disposition_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'disposition', 'accepted'])
        && isFormalCandidateDisposition(value.disposition)
        && isDispositionBasisAccepted(value.accepted)
        && sameValue(value.accepted.disposition, value.disposition)
      break
    case 'source_disposition_state_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'state']) && isSourceDispositionState(value.state)
      break
    case 'formal_content_delivery_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'request', 'accepted'])
        && isFormalFeedContentDeliveryRequest(value.request)
        && isFormalFeedContentDeliveryAccepted(value.accepted)
        && sameValue(value.accepted.request, value.request)
      break
    case 'formal_content_delivery_receipt_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'receipt', 'accepted'])
        && isFormalFeedContentDeliveryReceipt(value.receipt)
        && isPeriodDeliveryResultRecorded(value.accepted)
        && sameValue(value.accepted.receipt, value.receipt)
        && samePeriod(value.accepted.period, value.receipt.period)
      break
    case 'business_finalization_accepted':
      valid = hasExactKeys(value, ['schemaVersion', 'event', 'finalization', 'accepted'])
        && isBusinessFinalization(value.finalization)
        && isRunFinalizationAccepted(value.accepted)
        && samePeriod(value.accepted.period, value.finalization.period)
      break
  }
  if (!valid) return invalidRecord(lineNumber)
  return deepFreeze(value as PeriodBusinessRecord)
}

function invalidRecord(lineNumber: number): never {
  throw new PersonalFeedScopeStoreError(
    `personal Feed period business ledger line ${lineNumber} has an invalid record`,
  )
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isEditingInputClosure(value: unknown): value is EditingInputClosure {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'candidatesInJudgment'])
    && isPeriodIdentity(value.period)
    && Array.isArray(value.candidatesInJudgment)
    && value.candidatesInJudgment.every(isCandidateReference)
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value) && hasExactKeys(value, ['run', 'period'])
    && typeof value.run === 'string' && typeof value.period === 'string'
}

function isCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && hasExactKeys(value, ['source', 'candidate', 'stableReference'])
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function isEditedFeedContent(value: unknown): value is EditedFeedContent {
  return isRecord(value) && hasExactKeys(value, ['body'])
}

function isRawFeedContentConclusion(value: unknown): value is RawFeedContentConclusion {
  if (!isRecord(value)
    || !hasExactKeys(value, ['conclusion', 'closure', 'content', 'decisions'])
    || typeof value.conclusion !== 'string'
    || !isEditingInputClosureAccepted(value.closure)
    || !isEditedFeedContent(value.content)
    || !isCompleteDecisions(value.decisions)) return false
  const identity = rawFeedContentConclusionIdentityFor({
    closure: value.closure,
    content: value.content,
    decisions: value.decisions,
  })
  return identity !== undefined && value.conclusion === identity
}

function isRawFeedContentConclusionShape(value: unknown): value is RawFeedContentConclusion {
  return isRecord(value)
    && hasExactKeys(value, ['conclusion', 'closure', 'content', 'decisions'])
    && typeof value.conclusion === 'string'
    && isEditingInputClosureAccepted(value.closure)
    && isEditedFeedContent(value.content)
    && isCompleteDecisions(value.decisions)
}

function isEditingInputClosureAccepted(value: unknown): value is EditingInputClosureAccepted {
  return isRecord(value) && hasExactKeys(value, ['closure']) && isEditingInputClosure(value.closure)
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
  const candidateKeys = new Set(value.candidatesInJudgment.map(canonicalCandidateTupleKey))
  if (candidateKeys.size !== value.candidatesInJudgment.length) return false
  const decisionKeys = new Set<string>()
  let selected = 0
  for (const decision of value.decisions) {
    const key = canonicalCandidateTupleKey(decision.candidate)
    if (!candidateKeys.has(key) || decisionKeys.has(key)) return false
    decisionKeys.add(key)
    if (decision.kind === 'selected') selected += 1
  }
  return selected >= 1 && decisionKeys.size === candidateKeys.size
}

function isCandidateDecision(value: unknown): value is CandidateEditingDecision {
  if (!isRecord(value) || !isCandidateReference(value.candidate) || typeof value.kind !== 'string') return false
  if (value.kind === 'selected') return hasExactKeys(value, ['kind', 'candidate'])
  return value.kind === 'not_selected'
    && hasExactKeys(value, ['kind', 'candidate', 'semanticReason'])
    && value.semanticReason !== undefined
}

function isFormalEditingConclusionPair(raw: unknown, formal: unknown): boolean {
  if (!isRawFeedContentConclusionShape(raw) || !isFormalFeedContentConclusion(formal)) return false
  const closureCandidates = raw.closure.closure.candidatesInJudgment
  const decisionCandidates = raw.decisions.candidatesInJudgment
  return samePeriod(formal.period, raw.closure.closure.period)
    && uniqueReferences(closureCandidates)
    && uniqueReferences(decisionCandidates)
    && sameReferences(decisionCandidates, closureCandidates)
    && formal.original === raw.conclusion
    && formal.content.period.run === raw.closure.closure.period.run
    && formal.content.period.period === raw.closure.closure.period.period
    && formal.content.original === raw.conclusion
    && sameValue(formal.content.content, raw.content)
    && sameReferences(formal.content.selected.candidates, raw.decisions.decisions
      .filter(decision => decision.kind === 'selected')
      .map(decision => decision.candidate))
    && sameValue(formal.decisions, raw.decisions)
    && formal.content.object === formalFeedContentObjectIdentityFor(raw.conclusion as EditingConclusionIdentity)
}

function isFormalFeedContentConclusion(value: unknown): value is FormalFeedContentConclusion {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'original', 'content', 'decisions'])
    && isPeriodIdentity(value.period)
    && typeof value.original === 'string'
    && isFormalOrdinaryFeedContent(value.content)
    && isCompleteDecisions(value.decisions)
}

function isFormalOrdinaryFeedContent(value: unknown): value is FormalOrdinaryFeedContent {
  return isRecord(value)
    && hasExactKeys(value, ['object', 'period', 'original', 'content', 'selected'])
    && typeof value.object === 'string'
    && isPeriodIdentity(value.period)
    && typeof value.original === 'string'
    && isEditedFeedContent(value.content)
    && isRecord(value.selected)
    && hasExactKeys(value.selected, ['candidates'])
    && Array.isArray(value.selected.candidates)
    && value.selected.candidates.every(isCandidateReference)
}

function isFormalCandidateDisposition(value: unknown): value is FormalCandidateDisposition {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'source', 'candidate', 'value'])
    && isPeriodIdentity(value.period)
    && typeof value.source === 'string'
    && isCandidateReference(value.candidate)
    && typeof value.value === 'string'
    && new Set([
      'PeriodAdmissionNotCompletedAndClosed',
      'MaterialUnavailableAndClosed',
      'ReviewedNotSelected',
      'Shown',
      'NotDeliveredThisPeriod',
      'PossiblyDelivered',
      'EditingFailed',
      'PeriodExpired',
    ]).has(value.value)
}

function isDispositionBasisAccepted(value: unknown): value is DispositionBasisAccepted {
  return isRecord(value) && hasExactKeys(value, ['disposition']) && isFormalCandidateDisposition(value.disposition)
}

function isSourceDispositionState(value: unknown): value is SourceDispositionState {
  if (!isRecord(value)
    || !hasExactKeys(value, ['period', 'candidate', 'state', 'sourceCompletion'])
    || !isPeriodIdentity(value.period)
    || !isCandidateReference(value.candidate)
    || (value.state !== 'Displayed' && value.state !== 'Suppressed')
    || !isDispositionBasisAccepted(value.sourceCompletion)) return false
  const disposition = value.sourceCompletion.disposition
  return samePeriod(value.period, disposition.period)
    && sameCandidate(value.candidate, disposition.candidate)
    && value.candidate.source === disposition.source
    && value.state === (disposition.value === 'Shown' ? 'Displayed' : 'Suppressed')
}

function isFormalFeedContentDeliveryRequest(value: unknown): value is FormalFeedContentDeliveryRequest {
  return isRecord(value) && hasExactKeys(value, ['object']) && isFormalOrdinaryFeedContent(value.object)
}

function isFormalFeedContentDeliveryAccepted(value: unknown): value is FormalFeedContentDeliveryAccepted {
  return isRecord(value) && hasExactKeys(value, ['request']) && isFormalFeedContentDeliveryRequest(value.request)
}

function isFormalFeedContentDeliveryReceipt(value: unknown): value is FormalFeedContentDeliveryReceipt {
  return isRecord(value)
    && hasExactKeys(value, ['object', 'period', 'result'])
    && typeof value.object === 'string'
    && isPeriodIdentity(value.period)
    && (value.result === 'Delivered' || value.result === 'Failed' || value.result === 'Uncertain')
}

function isPeriodDeliveryResultRecorded(value: unknown): value is PeriodDeliveryResultRecorded {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'receipt'])
    && isPeriodIdentity(value.period)
    && isFormalFeedContentDeliveryReceipt(value.receipt)
}

function isRunFinalizationAccepted(value: unknown): value is RunFinalizationAccepted {
  return isRecord(value)
    && hasExactKeys(value, ['period'])
    && isPeriodIdentity(value.period)
}

function isBusinessFinalization(value: unknown): value is BusinessFinalization {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'period']) || !isPeriodIdentity(value.period)) return false
  return value.kind === 'ordinary_content_finalized'
    || value.kind === 'normal_empty_period_finalized'
    || value.kind === 'editing_failed_finalized'
    || value.kind === 'all_candidate_materials_unavailable_finalized'
    || value.kind === 'pre_content_period_send_failed_finalized'
}

function samePeriod(left: { readonly run: string; readonly period: string }, right: { readonly run: string; readonly period: string }): boolean {
  return left.run === right.run && left.period === right.period
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function sameReferences(left: readonly SourceCandidateReference[], right: readonly SourceCandidateReference[]): boolean {
  return left.length === right.length
    && left.every(candidate => right.some(other => sameCandidate(candidate, other)))
    && right.every(candidate => left.some(other => sameCandidate(candidate, other)))
}

function uniqueReferences(values: readonly SourceCandidateReference[]): boolean {
  return new Set(values.map(canonicalCandidateTupleKey)).size === values.length
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

function appendRecord(path: string, record: PeriodBusinessRecord): void {
  const records = readRecords(path)
  appendJsonLine(path, records, deepFreeze(structuredClone(record)))
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
