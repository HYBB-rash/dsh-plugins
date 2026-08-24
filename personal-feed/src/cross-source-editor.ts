import { createCandidatePeriodStore } from './candidate-period-store.ts'
import { createCurrentContextInputStore, currentContextInputReceiptFor } from './current-context-input-store.ts'
import { createEditingInputStore } from './editing-input-store.ts'
import { createPeriodBusinessStore, type PeriodBusinessRecord } from './period-business-store.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import { createPeriodScopeStore } from './store.ts'
import type {
  C10Result,
  C11Result,
  C28Result,
  C37Result,
  CandidateMaterial,
  ContextEnabledCrossSourceEditor,
  CurrentContextEditorOptions,
  CrossSourceEditor,
  CurrentContextProjectionPeriodScopeEstablished,
  CurrentContextResult,
  DisplayFact,
  FormalCandidateDisposition,
  FormalFeedContentDeliveryReceipt,
  EditingInputAccepted,
  PeriodIdentity,
  CompleteCandidateEditingDecisions,
  EditingInputClosure,
  RawFeedContentConclusion,
  RawFeedContentInput,
  SourceCandidateReference,
} from './types.ts'
import { rawFeedContentConclusionIdentityFor } from './identity.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'

export interface CrossSourceEditorOptions {
  readonly candidatePeriodLedgerPath: string
  readonly editingInputLedgerPath: string
  readonly periodBusinessLedgerPath?: string
}

export type ContextEnabledCrossSourceEditorOptions = CrossSourceEditorOptions & CurrentContextEditorOptions

export function createCrossSourceEditor(
  options: ContextEnabledCrossSourceEditorOptions,
): ContextEnabledCrossSourceEditor
export function createCrossSourceEditor(options: CrossSourceEditorOptions): CrossSourceEditor
export function createCrossSourceEditor(
  options: CrossSourceEditorOptions | ContextEnabledCrossSourceEditorOptions,
): CrossSourceEditor | ContextEnabledCrossSourceEditor {
  validateContextOptions(options)
  const candidatePeriodStore = createCandidatePeriodStore(options.candidatePeriodLedgerPath)
  const editingInputStore = createEditingInputStore(options.editingInputLedgerPath)
  const periodBusinessStore = createPeriodBusinessStore(
    options.periodBusinessLedgerPath ?? `${options.candidatePeriodLedgerPath}.business.jsonl`,
  )
  const contextEnabled = 'periodScopeLedgerPath' in options
    && 'currentContextInputLedgerPath' in options
  const periodScopeStore = contextEnabled
    ? createPeriodScopeStore(options.periodScopeLedgerPath)
    : undefined
  const currentContextInputStore = contextEnabled
    ? createCurrentContextInputStore(options.currentContextInputLedgerPath)
    : undefined

  const editor: CrossSourceEditor = {
    acceptCandidateMaterial: (input: CandidateMaterial): C10Result => {
      try {
        if (!hasCompleteMaterial(input)) return { status: 'rejected', input }
        const accepted = candidatePeriodStore.findCandidate(input.period, input.candidate)
        if (accepted === undefined
          || !sameValue(accepted, input.acceptedIntoPeriod)
          || !sameValue(accepted.nomination, input.nomination)) {
          return { status: 'rejected', input }
        }

        const existing = editingInputStore.findByCandidate(input)
        if (existing !== undefined) {
          return sameValue(existing, input)
            ? acceptedInputResult(existing)
            : { status: 'rejected', input }
        }
        if (editingInputStore.findClosureByPeriod(input.period) !== undefined) {
          return { status: 'rejected', input }
        }
        if (periodBusinessStore.list().some(record => record.event === 'editing_input_closure_accepted'
          && samePeriod(record.closure.period, input.period))) {
          return { status: 'rejected', input }
        }

        editingInputStore.append(input)
        return acceptedInputResult(deepFreeze(structuredClone(input)))
      } catch {
        return { status: 'failed', input }
      }
    },
    listAcceptedInputs: () => editingInputStore.list(),
    acceptEditingInputClosure: (input: EditingInputClosure): C37Result => {
      try {
        if (!isEditingInputClosure(input)) return { status: 'rejected', input }
        const existing = editingInputStore.findClosureByPeriod(input.period)
        if (existing !== undefined) {
          return sameClosure(existing.closure, input)
            ? { status: 'accepted', value: existing }
            : { status: 'rejected', input }
        }
        const acceptedInputs = editingInputStore.list()
          .filter(value => samePeriod(value.period, input.period))
        if (!sameReferences(acceptedInputs.map(value => value.candidate), input.candidatesInJudgment)) {
          return { status: 'rejected', input }
        }
        editingInputStore.appendClosure(input)
        return { status: 'accepted', value: { closure: input } }
      } catch {
        return { status: 'failed', input }
      }
    },
    formRawFeedContentConclusion: (input: RawFeedContentInput) => {
      try {
        if (!isRawFeedContentInput(input)) return { status: 'rejected', input }
        const acceptedClosure = editingInputStore.findClosure(input.closure.closure)
        if (acceptedClosure === undefined || !sameClosure(acceptedClosure.closure, input.closure.closure)) {
          return { status: 'rejected', input }
        }
        if (currentContextInputStore?.findByPeriod(input.closure.closure.period) === undefined) {
          return { status: 'rejected', input }
        }
        const acceptedInputs = editingInputStore.list()
          .filter(value => samePeriod(value.period, input.closure.closure.period))
        if (!sameReferences(acceptedInputs.map(value => value.candidate), input.decisions.candidatesInJudgment)
          || !validDecisions(input.decisions, input.closure.closure.candidatesInJudgment)) {
          return { status: 'rejected', input }
        }
        const existing = editingInputStore.findRawConclusion(input)
        if (existing !== undefined) return { status: 'accepted', value: existing }
        if (editingInputStore.findRawConclusionByClosure(input.closure) !== undefined) {
          return { status: 'rejected', input }
        }
        const conclusionIdentity = rawFeedContentConclusionIdentityFor(input)
        if (conclusionIdentity === undefined) return { status: 'rejected', input }
        const conclusion: RawFeedContentConclusion = {
          conclusion: conclusionIdentity,
          closure: input.closure,
          content: input.content,
          decisions: input.decisions,
        }
        editingInputStore.appendRawConclusion(input, conclusion)
        return { status: 'accepted', value: conclusion }
      } catch {
        return { status: 'failed', input }
      }
    },
    acceptDisplayFact: (fact: DisplayFact): C28Result => {
      try {
        if (!isDisplayFact(fact)) return { status: 'rejected', input: fact }
        const records = periodBusinessStore.list()
        const owners = editingInputStore.listDisplayFacts()
        if (!hasValidDisplayFactProjection(records, owners)) return { status: 'failed', input: fact }
        if (!hasDisplayFactPrerequisites(records, fact)) return { status: 'rejected', input: fact }
        const existing = owners.find(value => sameDisplayScope(value, fact))
        if (existing !== undefined) {
          return sameValue(existing, fact)
            ? { status: 'accepted', value: { fact: existing } }
            : { status: 'rejected', input: fact }
        }
        try {
          editingInputStore.appendDisplayFact(fact)
        } catch {
          const readbackOwners = editingInputStore.listDisplayFacts()
          if (!hasValidDisplayFactProjection(records, readbackOwners)) return { status: 'failed', input: fact }
          const matching = readbackOwners.filter(value => sameValue(value, fact))
          const matched = matching[0]
          if (matching.length !== 1 || matched === undefined) return { status: 'failed', input: fact }
          return { status: 'accepted', value: { fact: matched } }
        }
        const readbackOwners = editingInputStore.listDisplayFacts()
        if (!hasValidDisplayFactProjection(records, readbackOwners)) return { status: 'failed', input: fact }
        const matching = readbackOwners.filter(value => sameValue(value, fact))
        const matched = matching[0]
        return matching.length === 1
          && matched !== undefined
          ? { status: 'accepted', value: { fact: deepFreeze(structuredClone(matched)) } }
          : { status: 'failed', input: fact }
      } catch {
        return { status: 'failed', input: fact }
      }
    },
  }
  Object.defineProperty(editor, 'acceptDisplayFact', { enumerable: false })
  Object.defineProperty(editor, 'acceptEditingInputClosure', { enumerable: false })
  Object.defineProperty(editor, 'formRawFeedContentConclusion', { enumerable: false })
  if (!contextEnabled || periodScopeStore === undefined || currentContextInputStore === undefined) {
    return Object.freeze(editor)
  }
  Object.defineProperty(editor, 'acceptCurrentContext', {
    enumerable: true,
    value: (input: CurrentContextResult): C11Result => {
      try {
        if (!isRecord(input) || (input.kind !== 'available' && input.kind !== 'unavailable')) {
          return { status: 'rejected', input }
        }
        const identity = currentContextIdentity(input)
        if (identity === undefined) return { status: 'rejected', input }
        const periodScope = periodScopeStore.list().find(record => samePeriod(record.c01.value.period, identity.period))
        if (periodScope === undefined || !sameValue(periodScope.c33.value, identity.scope)) {
          return { status: 'rejected', input }
        }

        const receipt = currentContextInputReceiptFor(input)
        if (receipt === undefined) return { status: 'rejected', input }
        const existing = currentContextInputStore.findByPeriod(identity.period)
        if (existing !== undefined) {
          return existing.digest === receipt.digest && existing.branch === receipt.branch
            ? { status: 'accepted', value: input }
            : { status: 'rejected', input }
        }
        currentContextInputStore.append(receipt)
        return { status: 'accepted', value: input }
      } catch {
        return { status: 'failed', input }
      }
    },
  })
  return Object.freeze(editor as ContextEnabledCrossSourceEditor)
}

function validateContextOptions(options: CrossSourceEditorOptions | ContextEnabledCrossSourceEditorOptions): void {
  const hasPeriodScopeLedger = 'periodScopeLedgerPath' in options
  const hasContextInputLedger = 'currentContextInputLedgerPath' in options
  if (hasPeriodScopeLedger !== hasContextInputLedger) {
    throw new PersonalFeedScopeStoreError(
      'personal Feed C11 requires both periodScopeLedgerPath and currentContextInputLedgerPath',
    )
  }
}

function hasDisplayFactPrerequisites(records: readonly PeriodBusinessRecord[], fact: DisplayFact): boolean {
  const deliveries = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> =>
    record.event === 'formal_content_delivery_accepted'
      && record.request.object.object === fact.receipt.object
      && samePeriod(record.request.object.period, fact.period))
  if (deliveries.length !== 1) return false
  const delivery = deliveries[0]
  if (delivery === undefined || delivery.request.object.object !== fact.receipt.object) return false
  const selected = 'candidates' in delivery.request.object.selected
    ? delivery.request.object.selected.candidates
    : undefined
  if (selected === undefined || selected.filter(candidate => sameCandidate(candidate, fact.candidate)).length !== 1) return false

  const receipts = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> =>
    record.event === 'formal_content_delivery_receipt_accepted'
      && record.receipt.object === fact.receipt.object
      && samePeriod(record.receipt.period, fact.period))
  if (receipts.length !== 1 || receipts[0]?.receipt.result !== fact.receipt.result) return false

  const dispositions = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> =>
    record.event === 'candidate_disposition_accepted'
      && samePeriod(record.disposition.period, fact.period)
      && sameCandidate(record.disposition.candidate, fact.candidate)
      && record.disposition.source === fact.candidate.source
      && record.disposition.value === fact.disposition.value)
  if (dispositions.length !== 1) return false
  const disposition = dispositions[0]
  if (disposition === undefined || !sameValue(disposition.accepted.disposition, disposition.disposition)) return false

  const states = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'source_disposition_state_accepted' }> =>
    record.event === 'source_disposition_state_accepted'
      && samePeriod(record.state.period, fact.period)
      && sameCandidate(record.state.candidate, fact.candidate)
      && record.state.state === (fact.receipt.result === 'Delivered' ? 'Displayed' : 'Suppressed')
      && sameValue(record.state.sourceCompletion, disposition.accepted))
  return states.length === 1
}

function hasValidDisplayFactProjection(
  records: readonly PeriodBusinessRecord[],
  owners: readonly DisplayFact[],
): boolean {
  return owners.every(owner => owners.filter(value => sameDisplayScope(value, owner)).length === 1
    && hasDisplayFactPrerequisites(records, owner))
}

function isDisplayFact(value: unknown): value is DisplayFact {
  if (!isRecord(value)
    || !hasExactKeys(value, ['period', 'candidate', 'disposition', 'receipt'])
    || !isPeriodIdentity(value.period)
    || !isDisplayCandidateReference(value.candidate)
    || !isFormalCandidateDisposition(value.disposition)
    || !isFormalFeedContentDeliveryReceipt(value.receipt)
    || !samePeriod(value.period, value.disposition.period)
    || !sameCandidate(value.candidate, value.disposition.candidate)
    || value.disposition.source !== value.candidate.source
    || !samePeriod(value.period, value.receipt.period)) return false
  return value.receipt.result === 'Delivered'
    ? value.disposition.value === 'Shown'
    : value.receipt.result === 'Failed'
      ? value.disposition.value === 'NotDeliveredThisPeriod'
      : value.disposition.value === 'PossiblyDelivered'
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

function isFormalFeedContentDeliveryReceipt(value: unknown): value is FormalFeedContentDeliveryReceipt {
  return isRecord(value)
    && hasExactKeys(value, ['object', 'period', 'result'])
    && typeof value.object === 'string'
    && isPeriodIdentity(value.period)
    && (value.result === 'Delivered' || value.result === 'Failed' || value.result === 'Uncertain')
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['run', 'period'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function isDisplayCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && hasExactKeys(value, ['source', 'candidate', 'stableReference'])
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function sameDisplayScope(left: DisplayFact, right: DisplayFact): boolean {
  return samePeriod(left.period, right.period)
    && left.receipt.object === right.receipt.object
    && sameCandidate(left.candidate, right.candidate)
}

interface CurrentContextIdentity {
  readonly period: PeriodIdentity
  readonly scope: CurrentContextProjectionPeriodScopeEstablished
}

function currentContextIdentity(input: CurrentContextResult): CurrentContextIdentity | undefined {
  if (input.kind === 'available') {
    if (!isCurrentContext(input.context)
      || !samePeriod(input.context.scope.period, input.context.period)) return undefined
    return { period: input.context.period, scope: input.context.scope }
  }
  if (!isContextUnavailable(input.value)
    || !samePeriod(input.value.scope.period, input.value.period)) return undefined
  return { period: input.value.period, scope: input.value.scope }
}

function isCurrentContext(value: unknown): value is Extract<CurrentContextResult, { readonly kind: 'available' }>['context'] {
  return isRecord(value)
    && isContextScope(value.scope)
    && isPeriod(value.period)
    && Array.isArray(value.clues)
    && value.clues.every(isCurrentContextClue)
}

function isCurrentContextClue(value: unknown): boolean {
  return isRecord(value)
    && Object.hasOwn(value, 'factOwner')
    && Object.hasOwn(value, 'originalAttribution')
    && Object.hasOwn(value, 'exactLookup')
    && Object.hasOwn(value, 'currentFact')
}

function isContextUnavailable(value: unknown): value is Extract<CurrentContextResult, { readonly kind: 'unavailable' }>['value'] {
  return isRecord(value)
    && isContextScope(value.scope)
    && isPeriod(value.period)
    && Object.hasOwn(value, 'unavailableFact')
}

function isContextScope(value: unknown): value is { readonly period: { readonly run: string; readonly period: string } } {
  return isRecord(value) && isPeriod(value.period)
}

function isPeriod(value: unknown): value is { readonly run: string; readonly period: string } {
  return isRecord(value) && typeof value.run === 'string' && typeof value.period === 'string'
}

function samePeriod(left: { readonly run: string; readonly period: string }, right: { readonly run: string; readonly period: string }): boolean {
  return left.run === right.run && left.period === right.period
}

function acceptedInputResult(material: CandidateMaterial): C10Result {
  const value: EditingInputAccepted = { material }
  return { status: 'accepted', value }
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

function hasCompleteMaterial(value: CandidateMaterial): boolean {
  return isRecord(value)
    && value.boundedContent !== undefined
    && value.attribution !== undefined
    && value.exactLookup !== undefined
}

function isEditingInputClosure(value: unknown): value is EditingInputClosure {
  return isRecord(value)
    && isPeriod(value.period)
    && Array.isArray(value.candidatesInJudgment)
    && value.candidatesInJudgment.every(isCandidateReference)
}

function isRawFeedContentInput(value: unknown): value is RawFeedContentInput {
  return isRecord(value)
    && isRecord(value.closure)
    && isEditingInputClosure(value.closure.closure)
    && Object.hasOwn(value, 'content')
    && isEditedFeedContent(value.content)
    && isRecord(value.decisions)
    && Array.isArray(value.decisions.candidatesInJudgment)
    && Array.isArray(value.decisions.decisions)
}

function isEditedFeedContent(value: unknown): value is { readonly body: unknown } {
  return isRecord(value) && Object.hasOwn(value, 'body')
}

function validDecisions(
  decisions: CompleteCandidateEditingDecisions,
  expectedCandidates: readonly SourceCandidateReference[],
): boolean {
  if (!sameReferences(decisions.candidatesInJudgment, expectedCandidates)
    || decisions.decisions.length !== expectedCandidates.length) return false
  const seen = new Set<string>()
  let selected = 0
  for (const decision of decisions.decisions) {
    if (!isRecord(decision) || !isCandidateReference(decision.candidate)) return false
    const key = canonicalCandidateTupleKey(decision.candidate)
    if (seen.has(key) || !expectedCandidates.some(candidate => canonicalCandidateTupleKey(candidate) === key)) return false
    seen.add(key)
    if (decision.kind === 'selected') {
      if (Object.hasOwn(decision, 'semanticReason')) return false
      selected += 1
    } else if (decision.kind !== 'not_selected'
      || !Object.hasOwn(decision, 'semanticReason')
      || decision.semanticReason === undefined) return false
  }
  return selected >= 1 && seen.size === expectedCandidates.length
}

function sameReferences(left: readonly SourceCandidateReference[], right: readonly SourceCandidateReference[]): boolean {
  return left.length === right.length
    && new Set(left.map(canonicalCandidateTupleKey)).size === left.length
    && new Set(right.map(canonicalCandidateTupleKey)).size === right.length
    && left.every(value => right.some(candidate => canonicalCandidateTupleKey(value) === canonicalCandidateTupleKey(candidate)))
}

function sameClosure(left: EditingInputClosure, right: EditingInputClosure): boolean {
  return samePeriod(left.period, right.period)
    && sameReferences(left.candidatesInJudgment, right.candidatesInJudgment)
}

function isCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
