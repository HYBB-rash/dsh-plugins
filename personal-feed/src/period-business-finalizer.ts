import { createCandidatePeriodStore } from './candidate-period-store.ts'
import { createEditingInputStore } from './editing-input-store.ts'
import { createPeriodBusinessStore, type PeriodBusinessRecord } from './period-business-store.ts'
import { createPeriodScopeStore } from './store.ts'
import { createSourceCandidateReportStore } from './source-candidate-report-store.ts'
import { formalFeedContentObjectIdentityFor } from './identity.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'
import type {
  C15Result,
  C17Result,
  C18Result,
  C19Result,
  C21Result,
  C23Result,
  C37Result,
  CandidateDispositionReceiver,
  CandidateDispositionValue,
  BusinessFinalization,
  BusinessFinalizationReceiver,
  EditingInputClosure,
  FormalCandidateDisposition,
  FormalContentDeliveryReceiver,
  FormalFeedContentConclusion,
  FormalFeedContentDeliveryRequest,
  FormalFeedContentDeliveryReceipt,
  FeedContentDeliveryObjectIdentity,
  DisplayFact,
  CrossSourceEditor,
  PeriodDeliveryResultRecorded,
  RawFeedContentConclusion,
  RawEditingConclusion,
  SourceCandidateReference,
  PeriodScopeEstablished,
  SourceCandidateReportAccepted,
  SourceDispositionState,
} from './types.ts'
import type { EditingInputClosureReceiver } from './types.ts'

interface PeriodBusinessFinalizerOperations {
  readonly establishEditingInputClosure: (closure: EditingInputClosure) => C37Result
  readonly acceptEditingConclusion: (conclusion: RawEditingConclusion) => C15Result
  readonly requestSourceDisposition: (disposition: FormalCandidateDisposition) => C17Result
  readonly acceptSourceDispositionState: (state: SourceDispositionState) => C18Result
  readonly requestFormalContentDelivery: (request: FormalFeedContentDeliveryRequest) => C19Result
  readonly acceptFormalFeedContentDeliveryReceipt: (receipt: FormalFeedContentDeliveryReceipt) => C21Result
  readonly ensureBusinessFinalization: (finalization: BusinessFinalization) => C23Result
}

interface PeriodBusinessFinalizerOperationOptions {
  readonly candidatePeriodLedgerPath: string
  readonly editingInputLedgerPath: string
  readonly periodScopeLedgerPath: string
  readonly reportLedgerPath: string
  readonly periodBusinessLedgerPath: string
  readonly now: () => string
  readonly editingInputClosureReceiver?: EditingInputClosureReceiver
  readonly candidateDispositionReceiver?: CandidateDispositionReceiver
  readonly formalContentDeliveryReceiver?: FormalContentDeliveryReceiver
  readonly displayFactReceiver?: Pick<CrossSourceEditor, 'acceptDisplayFact'>
  readonly businessFinalizationReceiver?: BusinessFinalizationReceiver
}

type FormalContentDeliveryOwnerReader = {
  readonly readFormalFeedContentDeliveryRequest: (
    object: FeedContentDeliveryObjectIdentity,
  ) => FormalFeedContentDeliveryRequest | undefined
}

export function createPeriodBusinessFinalizerOperations(
  options: PeriodBusinessFinalizerOperationOptions,
): PeriodBusinessFinalizerOperations {
  const candidates = createCandidatePeriodStore(options.candidatePeriodLedgerPath)
  const editingInputs = createEditingInputStore(options.editingInputLedgerPath)
  const scopes = createPeriodScopeStore(options.periodScopeLedgerPath)
  const reports = createSourceCandidateReportStore(options.reportLedgerPath)
  const business = createPeriodBusinessStore(options.periodBusinessLedgerPath)

  const operations: PeriodBusinessFinalizerOperations = {
    establishEditingInputClosure: (closure: EditingInputClosure): C37Result => {
      try {
        const existing = findClosure(business.list(), closure)
        if (existing !== undefined) {
          return sameClosure(existing.closure, closure)
            ? accepted({ closure: existing.closure })
            : rejected(closure)
        }
        if (!isClosureReady(closure, candidates, editingInputs, business.list(), scopes, reports, options.now)) return rejected(closure)
        const editorClosure = editingInputs.findClosure(closure)
        if (editorClosure !== undefined) {
          business.append({ schemaVersion: 1, event: 'editing_input_closure_accepted', closure: editorClosure.closure })
          return accepted(editorClosure)
        }
        if (editingInputs.findClosureByPeriod(closure.period) !== undefined) return rejected(closure)
        const receiver = options.editingInputClosureReceiver
        if (receiver === undefined) return failed(closure)
        const result = receiver.acceptEditingInputClosure(closure)
        if (result.status !== 'accepted') return { status: result.status, input: closure }
        if (!sameClosure(result.value.closure, closure)) return rejected(closure)
        business.append({ schemaVersion: 1, event: 'editing_input_closure_accepted', closure })
        return accepted(result.value)
      } catch {
        return failed(closure)
      }
    },
    acceptEditingConclusion: (raw: RawEditingConclusion): C15Result => {
      try {
        if (!isRawFeedContentConclusion(raw)) return rejected(raw)
        const durableRaw = editingInputs.findRawConclusionByIdentity(raw.conclusion)
        if (durableRaw === undefined || !sameRawConclusion(durableRaw, raw)) return rejected(raw)
        const existing = findFormalConclusion(business.list(), raw)
        if (existing !== undefined) {
          if (!sameRawConclusion(existing.raw, raw)) return rejected(raw)
          requestNotSelectedDispositions(existing.formal, operations.requestSourceDisposition)
          return accepted(existing.formal)
        }
        if (findFormalConclusionByClosure(business.list(), raw) !== undefined) return rejected(raw)
        if (!isRawConclusionReady(raw, business.list())) return rejected(raw)
        const formal: FormalFeedContentConclusion = {
          period: raw.closure.closure.period,
          original: raw.conclusion,
          content: {
            object: formalFeedContentObjectIdentityFor(raw.conclusion),
            period: raw.closure.closure.period,
            original: raw.conclusion,
            content: raw.content,
            selected: {
              candidates: raw.decisions.decisions
                .filter(decision => decision.kind === 'selected')
                .map(decision => decision.candidate),
            },
          },
          decisions: raw.decisions,
        }
        business.append({
          schemaVersion: 1,
          event: 'formal_editing_conclusion_accepted',
          raw,
          formal,
        })
        requestNotSelectedDispositions(formal, operations.requestSourceDisposition)
        return accepted(formal)
      } catch {
        return failed(raw)
      }
    },
    requestSourceDisposition: (disposition: FormalCandidateDisposition): C17Result => {
      try {
        const existing = findDisposition(business.list(), disposition)
        if (existing !== undefined) return sameValue(existing.disposition, disposition)
          ? accepted(existing.accepted)
          : rejected(disposition)
        if (!isDispositionAllowed(disposition, candidates, business.list())) return rejected(disposition)
        const receiver = options.candidateDispositionReceiver
        if (receiver === undefined) return failed(disposition)
        const result = receiver.acceptFormalDisposition(disposition)
        if (result.status !== 'accepted') return { status: result.status, input: disposition }
        if (!sameValue(result.value.disposition, disposition)) return rejected(disposition)
        business.append({
          schemaVersion: 1,
          event: 'candidate_disposition_accepted',
          disposition,
          accepted: result.value,
        })
        return accepted(result.value)
      } catch {
        return failed(disposition)
      }
    },
    acceptSourceDispositionState: (state: SourceDispositionState): C18Result => {
      try {
        const records = business.list()
        if (options.businessFinalizationReceiver !== undefined
          && records.some(record => record.event === 'business_finalization_accepted'
            && samePeriod(record.finalization.period, state.period))) {
          attemptBusinessFinalization(
            state.period,
            candidates,
            editingInputs,
            business,
            options.formalContentDeliveryReceiver,
            options.businessFinalizationReceiver,
          )
        }
        const existing = findSourceState(records, state.candidate, state.period, state.sourceCompletion)
        const basis = findDispositionForCandidate(records, state)
        if (existing !== undefined) {
          const result = basis !== undefined
            && sameValue(state.sourceCompletion, basis.accepted)
            && sameValue(existing, state)
            ? accepted({ state: existing })
            : rejected(state)
          if (result.status === 'accepted') publishDisplayFactForState(state, records, editingInputs, options.displayFactReceiver)
          if (result.status === 'accepted') attemptBusinessFinalization(
            state.period,
            candidates,
            editingInputs,
            business,
            options.formalContentDeliveryReceiver,
            options.businessFinalizationReceiver,
          )
          return result
        }
        if (basis === undefined || !sameValue(state.sourceCompletion, basis.accepted)
          || !sameCandidate(state.candidate, basis.disposition.candidate)
          || !samePeriod(state.period, basis.disposition.period)
          || state.state !== (basis.disposition.value === 'Shown' ? 'Displayed' : 'Suppressed')) return rejected(state)
        business.append({ schemaVersion: 1, event: 'source_disposition_state_accepted', state })
        const result = accepted({ state })
        publishDisplayFactForState(state, business.list(), editingInputs, options.displayFactReceiver)
        attemptBusinessFinalization(
          state.period,
          candidates,
          editingInputs,
          business,
          options.formalContentDeliveryReceiver,
          options.businessFinalizationReceiver,
        )
        return result
      } catch {
        return failed(state)
      }
    },
    requestFormalContentDelivery: (request: FormalFeedContentDeliveryRequest): C19Result => {
      try {
        const receiver = options.formalContentDeliveryReceiver
        const existing = findDelivery(business.list(), request)
        if (existing !== undefined) {
          if (receiver !== undefined && isFormalContentDeliveryOwnerReader(receiver)) {
            const owner = receiver.readFormalFeedContentDeliveryRequest(request.object.object)
            if (owner === undefined || !sameValue(owner, existing.request)) return failed(request)
          }
          return sameValue(existing.request, request)
            ? accepted(existing.accepted)
            : rejected(request)
        }
        if (!isFormalContentKnown(business.list(), request)) return rejected(request)
        if (receiver === undefined) return failed(request)
        const result = receiver.acceptFormalFeedContent(request)
        if (result.status !== 'accepted') return { status: result.status, input: request }
        if (!sameValue(result.value.request, request)) return rejected(request)
        business.append({
          schemaVersion: 1,
          event: 'formal_content_delivery_accepted',
          request,
          accepted: result.value,
        })
        return accepted(result.value)
      } catch {
        return failed(request)
      }
    },
    acceptFormalFeedContentDeliveryReceipt: (receipt: FormalFeedContentDeliveryReceipt): C21Result => {
      try {
        if (!isFormalFeedContentDeliveryReceipt(receipt)) return rejected(receipt)
        const records = business.list()
        const delivery = findDeliveryForReceipt(records, receipt)
        if (delivery === undefined) return rejected(receipt)
        const receiver = options.formalContentDeliveryReceiver
        if (receiver === undefined || !isFormalContentDeliveryOwnerReader(receiver)) return failed(receipt)
        const owner = receiver.readFormalFeedContentDeliveryRequest(receipt.object)
        if (owner === undefined || !sameValue(owner, delivery.request)) return failed(receipt)
        const selectedCandidates = selectedCandidatesForDelivery(delivery.request)
        if (selectedCandidates === undefined) return rejected(receipt)
        let existing = findReceiptResult(records, receipt)
        const conflict = findReceiptResultForObject(records, receipt)
        if (conflict !== undefined && !sameValue(conflict.receipt, receipt)) return rejected(receipt)
        const acceptedResult: PeriodDeliveryResultRecorded = { period: receipt.period, receipt }
        if (existing === undefined) {
          try {
            business.append({
              schemaVersion: 1,
              event: 'formal_content_delivery_receipt_accepted',
              receipt,
              accepted: acceptedResult,
            })
          } catch {
            try {
              existing = findReceiptResult(business.list(), receipt)
            } catch {
              return failed(receipt)
            }
            if (existing === undefined) return failed(receipt)
          }
        }
        const dispositionsComplete = requestSelectedDispositions(
          selectedCandidates,
          receipt,
          operations.requestSourceDisposition,
        )
        if (!dispositionsComplete) return failed(receipt)
        return accepted(existing?.accepted ?? acceptedResult)
      } catch {
        return failed(receipt)
      }
    },
    ensureBusinessFinalization: (finalization: BusinessFinalization): C23Result => {
      if (!isOrdinaryBusinessFinalization(finalization)) return rejected(finalization)
      try {
        const period = finalization.period
        const records = business.list()
        const allFinalizations = records.filter(record => record.event === 'business_finalization_accepted'
          && samePeriod(record.finalization.period, period))
        const existing = allFinalizations.filter((record): record is Extract<PeriodBusinessRecord, { event: 'business_finalization_accepted' }> =>
          record.event === 'business_finalization_accepted'
            && record.finalization.kind === 'ordinary_content_finalized')
        if (allFinalizations.length > 0
          && (allFinalizations.length !== 1
            || existing.length !== 1
            || !sameValue(existing[0]?.finalization, finalization)
            || !sameValue(existing[0]?.accepted.period, period))) {
          return failed(finalization)
        }
        if (!ordinaryBusinessGatesReady(
          period,
          candidates,
          editingInputs,
          records,
          options.formalContentDeliveryReceiver,
        )) return allFinalizations.length === 0 ? rejected(finalization) : failed(finalization)
        const receiver = options.businessFinalizationReceiver
        if (receiver === undefined) return failed(finalization)
        const receiverResult = receiver.acceptBusinessFinalization(finalization)
        if (receiverResult.status !== 'accepted') {
          return { status: receiverResult.status, input: finalization }
        }
        if (!sameValue(receiverResult.value, { period })) return rejected(finalization)
        if (existing.length === 1) return accepted(existing[0]!.accepted)
        try {
          business.append({
            schemaVersion: 1,
            event: 'business_finalization_accepted',
            finalization,
            accepted: { period },
          })
        } catch {
          const readBack = business.list().filter((record): record is Extract<PeriodBusinessRecord, { event: 'business_finalization_accepted' }> =>
            record.event === 'business_finalization_accepted' && samePeriod(record.finalization.period, period))
          if (readBack.length !== 1
            || !sameValue(readBack[0]?.finalization, finalization)
            || !sameValue(readBack[0]?.accepted.period, period)) return failed(finalization)
        }
        return accepted({ period })
      } catch {
        return failed(finalization)
      }
    },
  }
  return Object.freeze(operations)
}

function requestNotSelectedDispositions(
  formal: FormalFeedContentConclusion,
  requestDisposition: (disposition: FormalCandidateDisposition) => C17Result,
): void {
  for (const decision of formal.decisions.decisions) {
    if (decision.kind !== 'not_selected') continue
    requestDisposition({
      period: formal.period,
      source: decision.candidate.source,
      candidate: decision.candidate,
      value: 'ReviewedNotSelected',
    })
  }
}

function publishDisplayFactForState(
  state: SourceDispositionState,
  records: readonly PeriodBusinessRecord[],
  editingInputs: ReturnType<typeof createEditingInputStore>,
  receiver: Pick<CrossSourceEditor, 'acceptDisplayFact'> | undefined,
): void {
  const dispositionRecord = records.find((record): record is Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> =>
    record.event === 'candidate_disposition_accepted'
      && samePeriod(record.disposition.period, state.period)
      && sameCandidate(record.disposition.candidate, state.candidate)
      && sameValue(record.accepted, state.sourceCompletion))
  if (dispositionRecord === undefined) return
  const disposition = dispositionRecord.disposition
  if (disposition.value !== 'Shown'
    && disposition.value !== 'NotDeliveredThisPeriod'
    && disposition.value !== 'PossiblyDelivered') return
  const matches = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> =>
    record.event === 'formal_content_delivery_receipt_accepted'
      && samePeriod(record.receipt.period, state.period)
      && records.some(candidateRecord => candidateRecord.event === 'formal_content_delivery_accepted'
        && candidateRecord.request.object.object === record.receipt.object
        && samePeriod(candidateRecord.request.object.period, record.receipt.period)
        && 'candidates' in candidateRecord.request.object.selected
        && candidateRecord.request.object.selected.candidates.some(candidate => sameCandidate(candidate, state.candidate))))
  if (matches.length !== 1) return
  const receipt = matches[0]?.receipt
  if (receipt === undefined) return
  const fact = displayFactForReceipt(state.period, state.candidate, disposition, receipt)
  if (fact === undefined) return
  const existing = editingInputs.listDisplayFacts().find(value => sameDisplayScope(value, fact))
  if (existing !== undefined) {
    if (sameValue(existing, fact)) return
    return
  }
  if (receiver === undefined) return
  try {
    const result = receiver.acceptDisplayFact(fact)
    if (result.status !== 'accepted' || !sameValue(result.value.fact, fact)) return
    const owner = editingInputs.listDisplayFacts().find(value => sameDisplayScope(value, fact))
    if (owner === undefined || !sameValue(owner, fact)) return
  } catch {
    // C18 remains the durable fact when C28 is unavailable or rejects.
  }
}

function attemptBusinessFinalization(
  period: SourceDispositionState['period'],
  candidates: ReturnType<typeof createCandidatePeriodStore>,
  editingInputs: ReturnType<typeof createEditingInputStore>,
  business: ReturnType<typeof createPeriodBusinessStore>,
  formalContentDeliveryReceiver: FormalContentDeliveryReceiver | undefined,
  receiver: BusinessFinalizationReceiver | undefined,
): void {
  if (receiver === undefined) return
  const records = business.list()
  const finalization: Extract<BusinessFinalization, { readonly kind: 'ordinary_content_finalized' }> = {
    kind: 'ordinary_content_finalized',
    period,
  }
  const allFinalizations = records.filter(record => record.event === 'business_finalization_accepted'
    && samePeriod(record.finalization.period, period))
  const existing = allFinalizations.filter((record): record is Extract<PeriodBusinessRecord, { event: 'business_finalization_accepted' }> =>
    record.event === 'business_finalization_accepted'
      && record.finalization.kind === 'ordinary_content_finalized')
  if (allFinalizations.length > 0) {
    if (allFinalizations.length !== 1
      || existing.length !== 1
      || !sameValue(existing[0]?.finalization, finalization)
      || !sameValue(existing[0]?.accepted.period, period)
      || !ordinaryBusinessGatesReady(period, candidates, editingInputs, records, formalContentDeliveryReceiver)) {
      throw new Error('personal Feed existing C23 projection is invalid')
    }
    return
  }
  if (!ordinaryBusinessGatesReady(period, candidates, editingInputs, records, formalContentDeliveryReceiver)) return
  try {
    const result = receiver.acceptBusinessFinalization(finalization)
    if (result.status !== 'accepted' || !sameValue(result.value.period, period)) return
    try {
      business.append({
        schemaVersion: 1,
        event: 'business_finalization_accepted',
        finalization,
        accepted: { period },
      })
    } catch {
      try {
        const readBack = business.list().filter((record): record is Extract<PeriodBusinessRecord, { event: 'business_finalization_accepted' }> =>
          record.event === 'business_finalization_accepted' && samePeriod(record.finalization.period, period))
        if (readBack.length !== 1
          || !sameValue(readBack[0]?.finalization, finalization)
          || !sameValue(readBack[0]?.accepted.period, period)) return
      } catch {
        return
      }
    }
  } catch {
    // C18 remains accepted when C23 is unavailable or cannot be persisted.
  }
}

function ordinaryBusinessGatesReady(
  period: SourceDispositionState['period'],
  candidates: ReturnType<typeof createCandidatePeriodStore>,
  editingInputs: ReturnType<typeof createEditingInputStore>,
  records: readonly PeriodBusinessRecord[],
  formalContentDeliveryReceiver: FormalContentDeliveryReceiver | undefined,
): boolean {
  const periodCandidates = candidates.listCandidates().filter(value => samePeriod(value.period, period))
  const materialFacts = candidates.listMaterialFacts().filter(value => samePeriod(value.period, period))
  if (periodCandidates.length === 0
    || !allUniqueCandidates(periodCandidates.map(value => value.candidate))
    || materialFacts.length !== periodCandidates.length) return false

  for (const candidate of periodCandidates) {
    const facts = materialFacts.filter(value => sameCandidate(value.candidate, candidate.candidate))
    if (facts.length !== 1 || !sameValue(facts[0]?.acceptedIntoPeriod, candidate)) return false
  }

  const closures = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'editing_input_closure_accepted' }> =>
    record.event === 'editing_input_closure_accepted' && samePeriod(record.closure.period, period))
  if (closures.length !== 1) return false
  const closure = closures[0]?.closure
  if (closure === undefined) return false
  const formedCandidates = materialFacts
    .filter(fact => fact.kind === 'material_formed')
    .map(fact => fact.candidate)
  if (!sameReferences(closure.candidatesInJudgment, formedCandidates)) return false

  const conclusions = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_editing_conclusion_accepted' }> =>
    record.event === 'formal_editing_conclusion_accepted' && samePeriod(record.formal.period, period))
  if (conclusions.length !== 1) return false
  const conclusion = conclusions[0]
  if (conclusion === undefined
    || !sameClosure(conclusion.raw.closure.closure, closure)) return false

  const deliveries = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> =>
    record.event === 'formal_content_delivery_accepted' && samePeriod(record.request.object.period, period))
  if (deliveries.length !== 1) return false
  const delivery = deliveries[0]
  if (delivery === undefined) return false
  if (!sameValue(conclusion.formal.content, delivery.request.object)) return false
  if (formalContentDeliveryReceiver === undefined || !isFormalContentDeliveryOwnerReader(formalContentDeliveryReceiver)) return false
  const deliveryOwner = formalContentDeliveryReceiver.readFormalFeedContentDeliveryRequest(delivery.request.object.object)
  if (deliveryOwner === undefined || !sameValue(deliveryOwner, delivery.request)) return false
  const selected = selectedCandidatesForDelivery(delivery.request)
  if (selected === undefined || selected.length === 0 || !allUniqueCandidates(selected)) return false
  if (selected.some(candidate => periodCandidates.every(value => !sameCandidate(value.candidate, candidate)))) return false

  const receipts = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> =>
    record.event === 'formal_content_delivery_receipt_accepted'
      && record.receipt.object === delivery.request.object.object
      && samePeriod(record.receipt.period, period))
  if (receipts.length !== 1) return false
  const receipt = receipts[0]?.receipt
  if (receipt === undefined) return false

  for (const candidate of periodCandidates) {
    const dispositions = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> =>
      record.event === 'candidate_disposition_accepted'
        && samePeriod(record.disposition.period, period)
        && sameCandidate(record.disposition.candidate, candidate.candidate))
    const states = records.filter((record): record is Extract<PeriodBusinessRecord, { event: 'source_disposition_state_accepted' }> =>
      record.event === 'source_disposition_state_accepted'
        && samePeriod(record.state.period, period)
        && sameCandidate(record.state.candidate, candidate.candidate))
    if (dispositions.length !== 1 || states.length !== 1) return false
    const disposition = dispositions[0]
    const stateRecord = states[0]
    const state = stateRecord?.state
    if (disposition === undefined || state === undefined
      || !sameValue(state.sourceCompletion, disposition.accepted)) {
      return false
    }

    const fact = materialFacts.find(value => sameCandidate(value.candidate, candidate.candidate))
    if (fact === undefined) return false
    const isSelected = selected.some(value => sameCandidate(value, candidate.candidate))
    const expectedValue = fact.kind === 'material_unavailable'
      ? 'MaterialUnavailableAndClosed'
      : isSelected
        ? receipt.result === 'Delivered' ? 'Shown' : receipt.result === 'Failed' ? 'NotDeliveredThisPeriod' : 'PossiblyDelivered'
        : 'ReviewedNotSelected'
    if (disposition.disposition.value !== expectedValue
      || state.state !== (expectedValue === 'Shown' ? 'Displayed' : 'Suppressed')) return false
  }

  const owners = editingInputs.listDisplayFacts().filter(value => samePeriod(value.period, period))
  if (owners.length !== selected.length
    || owners.some(owner => selected.every(candidate => !sameCandidate(candidate, owner.candidate)))) return false
  for (const candidate of selected) {
    const disposition = records.find((record): record is Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> =>
      record.event === 'candidate_disposition_accepted'
        && samePeriod(record.disposition.period, period)
        && sameCandidate(record.disposition.candidate, candidate))
    if (disposition === undefined) return false
    const expected = displayFactForReceipt(period, candidate, disposition.disposition, receipt)
    const matching = owners.filter(owner => sameCandidate(owner.candidate, candidate))
    if (matching.length !== 1 || expected === undefined || !sameValue(matching[0], expected)) return false
  }
  return true
}

function allUniqueCandidates(candidates: readonly SourceCandidateReference[]): boolean {
  return candidates.every((candidate, index) => candidates.findIndex(other => sameCandidate(other, candidate)) === index)
}

function displayFactForReceipt(
  period: SourceDispositionState['period'],
  candidate: SourceCandidateReference,
  disposition: FormalCandidateDisposition,
  receipt: FormalFeedContentDeliveryReceipt,
): DisplayFact | undefined {
  if (receipt.result === 'Delivered' && disposition.value === 'Shown') {
    return {
      period,
      candidate,
      disposition: { ...disposition, value: 'Shown' },
      receipt: { ...receipt, result: 'Delivered' },
    }
  }
  if (receipt.result === 'Failed' && disposition.value === 'NotDeliveredThisPeriod') {
    return {
      period,
      candidate,
      disposition: { ...disposition, value: 'NotDeliveredThisPeriod' },
      receipt: { ...receipt, result: 'Failed' },
    }
  }
  if (receipt.result === 'Uncertain' && disposition.value === 'PossiblyDelivered') {
    return {
      period,
      candidate,
      disposition: { ...disposition, value: 'PossiblyDelivered' },
      receipt: { ...receipt, result: 'Uncertain' },
    }
  }
  return undefined
}

function sameDisplayScope(left: DisplayFact, right: DisplayFact): boolean {
  return samePeriod(left.period, right.period)
    && left.receipt.object === right.receipt.object
    && sameCandidate(left.candidate, right.candidate)
}

function isClosureReady(
  closure: EditingInputClosure,
  candidates: ReturnType<typeof createCandidatePeriodStore>,
  editingInputs: ReturnType<typeof createEditingInputStore>,
  records: readonly PeriodBusinessRecord[],
  scopes: ReturnType<typeof createPeriodScopeStore>,
  reports: ReturnType<typeof createSourceCandidateReportStore>,
  now: () => string,
): boolean {
  const scope = scopes.list().find(record => samePeriod(record.c01.value.period, closure.period))
  if (scope === undefined) return false
  const periodReports = reports.list().filter(report => {
    if (!samePeriod(report.report.period, closure.period)) return false
    const establishedReportScope = scope.c35.find(value => value.value.scope.source === report.report.source
      && samePeriod(value.value.scope.period, report.report.period))
    return establishedReportScope !== undefined && sameValue(report.report.scope, establishedReportScope.value)
  })
  if (!hasRequiredReports(scope, periodReports, now)) return false
  const reportedCandidates = periodReports.flatMap(report => report.report.candidates.map(candidate => candidate.candidate))
  const periodCandidates = candidates.listCandidates().filter(candidate => samePeriod(candidate.period, closure.period))
  const facts = candidates.listMaterialFacts().filter(fact => samePeriod(fact.period, closure.period))
  const formed = facts.filter(fact => fact.kind === 'material_formed').map(fact => fact.candidate)
  const unavailable = facts.filter(fact => fact.kind === 'material_unavailable')
  const acceptedInputs = editingInputs.list().filter(input => samePeriod(input.period, closure.period))
  if (reportedCandidates.length === 0
    || !sameReferences(periodCandidates.map(candidate => candidate.candidate), reportedCandidates)
    || !sameReferences(facts.map(fact => fact.candidate), periodCandidates.map(candidate => candidate.candidate))
    || !periodCandidates.every(candidate => facts.some(fact => sameCandidate(fact.candidate, candidate.candidate)
      && sameValue(fact.acceptedIntoPeriod, candidate)))
    || !sameReferences(closure.candidatesInJudgment, formed)
    || !sameReferences(acceptedInputs.map(input => input.candidate), formed)
    || !acceptedInputs.every(input => periodCandidates.some(candidate => sameCandidate(input.candidate, candidate.candidate)
      && sameValue(input.acceptedIntoPeriod, candidate)))) {
    return false
  }
  return formed.length > 0
    && unavailable.length + formed.length === reportedCandidates.length
    && unavailable.every(fact => {
      const disposition = findCompletedDisposition(records, fact.candidate, fact.period, 'MaterialUnavailableAndClosed')
      return disposition !== undefined
        && findSourceState(records, fact.candidate, fact.period, disposition.accepted) !== undefined
    })
}

function hasRequiredReports(
  scope: PeriodScopeEstablished,
  reports: readonly SourceCandidateReportAccepted[],
  now: () => string,
): boolean {
  const closesAt = Date.parse(scope.c34.value.window.closesAt)
  const current = Date.parse(now())
  if (!Number.isFinite(closesAt) || !Number.isFinite(current) || reports.length === 0) return false
  if (current >= closesAt) return true
  return scope.c34.value.window.sources.every(source => reports.some(report => report.report.source === source))
}

function isRawConclusionReady(raw: RawFeedContentConclusion, records: readonly PeriodBusinessRecord[]): boolean {
  const closure = findClosure(records, raw.closure.closure)
  if (closure === undefined || !sameClosure(closure.closure, raw.closure.closure)) return false
  if (!sameReferences(raw.decisions.candidatesInJudgment, raw.closure.closure.candidatesInJudgment)
    || raw.decisions.decisions.length !== raw.decisions.candidatesInJudgment.length) return false
  const expected = new Set(raw.closure.closure.candidatesInJudgment.map(canonicalCandidateTupleKey))
  const seen = new Set<string>()
  let selected = 0
  for (const decision of raw.decisions.decisions) {
    const key = canonicalCandidateTupleKey(decision.candidate)
    if (!expected.has(key) || seen.has(key)) return false
    seen.add(key)
    if (decision.kind === 'selected') {
      if (Object.hasOwn(decision, 'semanticReason')) return false
      selected += 1
    } else if (decision.kind !== 'not_selected'
      || !Object.hasOwn(decision, 'semanticReason')
      || decision.semanticReason === undefined) return false
  }
  return selected >= 1 && seen.size === expected.size
}

function isRawFeedContentConclusion(value: RawEditingConclusion): value is RawFeedContentConclusion {
  return isRecord(value)
    && Object.hasOwn(value, 'content')
    && isEditedFeedContent(value.content)
    && Object.hasOwn(value, 'decisions')
    && isRecord(value.closure)
}

function isEditedFeedContent(value: unknown): value is { readonly body: unknown } {
  return isRecord(value) && Object.hasOwn(value, 'body')
}

function sameRawConclusion(left: RawFeedContentConclusion, right: RawFeedContentConclusion): boolean {
  return left.conclusion === right.conclusion
    && sameClosure(left.closure.closure, right.closure.closure)
    && sameValue(left.content, right.content)
    && sameReferences(left.decisions.candidatesInJudgment, right.decisions.candidatesInJudgment)
    && sameDecisions(left.decisions.decisions, right.decisions.decisions)
}

function sameDecisions(
  left: RawFeedContentConclusion['decisions']['decisions'],
  right: RawFeedContentConclusion['decisions']['decisions'],
): boolean {
  if (left.length !== right.length) return false
  return left.every(decision => {
    const match = right.find(candidate => sameCandidate(candidate.candidate, decision.candidate))
    return match !== undefined && sameValue(match, decision)
  })
}

function isDispositionAllowed(
  disposition: FormalCandidateDisposition,
  candidates: ReturnType<typeof createCandidatePeriodStore>,
  records: readonly PeriodBusinessRecord[],
): boolean {
  if (disposition.source !== disposition.candidate.source
    || candidates.findCandidate(disposition.period, disposition.candidate) === undefined) return false
  if (disposition.value === 'MaterialUnavailableAndClosed') {
    return candidates.findMaterialFact(disposition.period, disposition.candidate)?.kind === 'material_unavailable'
  }
  if (disposition.value === 'ReviewedNotSelected') {
    return records.some(record => record.event === 'formal_editing_conclusion_accepted'
      && record.formal.period.run === disposition.period.run
      && record.formal.period.period === disposition.period.period
      && record.formal.decisions.decisions.some(decision =>
        decision.kind === 'not_selected' && sameCandidate(decision.candidate, disposition.candidate)))
  }
  if (disposition.value === 'Shown'
    || disposition.value === 'NotDeliveredThisPeriod'
    || disposition.value === 'PossiblyDelivered') {
    return records.some(record => {
      if (record.event !== 'formal_content_delivery_receipt_accepted'
        || !samePeriod(record.receipt.period, disposition.period)) return false
      const delivery = records.find(candidateRecord => {
        if (candidateRecord.event !== 'formal_content_delivery_accepted') return false
        return candidateRecord.request.object.object === record.receipt.object
          && samePeriod(candidateRecord.request.object.period, record.receipt.period)
      }) as Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> | undefined
      const selected = delivery === undefined ? undefined : selectedCandidatesForDelivery(delivery.request)
      const expectedValue = record.receipt.result === 'Delivered'
        ? 'Shown'
        : record.receipt.result === 'Failed'
          ? 'NotDeliveredThisPeriod'
          : 'PossiblyDelivered'
      return selected !== undefined
        && selected.some(candidate => sameCandidate(candidate, disposition.candidate))
        && disposition.value === expectedValue
    })
  }
  return false
}

function isFormalContentKnown(records: readonly PeriodBusinessRecord[], request: FormalFeedContentDeliveryRequest): boolean {
  return records.some(record => record.event === 'formal_editing_conclusion_accepted'
    && sameValue(record.formal.content, request.object))
}

function findClosure(records: readonly PeriodBusinessRecord[], closure: EditingInputClosure): { readonly closure: EditingInputClosure } | undefined {
  const record = records.find(record => record.event === 'editing_input_closure_accepted'
    && sameClosure(record.closure, closure))
  return record?.event === 'editing_input_closure_accepted' ? { closure: record.closure } : undefined
}

function findFormalConclusion(records: readonly PeriodBusinessRecord[], raw: RawFeedContentConclusion): {
  readonly raw: RawFeedContentConclusion
  readonly formal: FormalFeedContentConclusion
} | undefined {
  return records.find(record => record.event === 'formal_editing_conclusion_accepted'
    && record.raw.conclusion === raw.conclusion) as {
      readonly raw: RawFeedContentConclusion
      readonly formal: FormalFeedContentConclusion
    } | undefined
}

function findFormalConclusionByClosure(
  records: readonly PeriodBusinessRecord[],
  raw: RawFeedContentConclusion,
): Extract<PeriodBusinessRecord, { event: 'formal_editing_conclusion_accepted' }> | undefined {
  return records.find(record => record.event === 'formal_editing_conclusion_accepted'
    && sameClosure(record.raw.closure.closure, raw.closure.closure)) as Extract<PeriodBusinessRecord, { event: 'formal_editing_conclusion_accepted' }> | undefined
}

function findDisposition(records: readonly PeriodBusinessRecord[], disposition: FormalCandidateDisposition): Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined {
  return records.find(record => record.event === 'candidate_disposition_accepted'
    && sameCandidate(record.disposition.candidate, disposition.candidate)
    && samePeriod(record.disposition.period, disposition.period)) as Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined
}

function findDispositionForCandidate(records: readonly PeriodBusinessRecord[], state: SourceDispositionState): Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined {
  return records.find(record => record.event === 'candidate_disposition_accepted'
    && sameCandidate(record.disposition.candidate, state.candidate)
    && samePeriod(record.disposition.period, state.period)) as Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined
}

function findCompletedDisposition(records: readonly PeriodBusinessRecord[], candidate: SourceCandidateReference, period: { readonly run: string; readonly period: string }, value: CandidateDispositionValue): Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined {
  return records.find(record => record.event === 'candidate_disposition_accepted'
    && sameCandidate(record.disposition.candidate, candidate)
    && samePeriod(record.disposition.period, period)
    && record.disposition.value === value) as Extract<PeriodBusinessRecord, { event: 'candidate_disposition_accepted' }> | undefined
}

function findSourceState(
  records: readonly PeriodBusinessRecord[],
  candidate: SourceCandidateReference,
  period: { readonly run: string; readonly period: string },
  sourceCompletion: unknown,
): SourceDispositionState | undefined {
  const record = records.find(record => record.event === 'source_disposition_state_accepted'
    && sameCandidate(record.state.candidate, candidate)
    && samePeriod(record.state.period, period)
    && sameValue(record.state.sourceCompletion, sourceCompletion))
  return record?.event === 'source_disposition_state_accepted' ? record.state : undefined
}

function findDelivery(records: readonly PeriodBusinessRecord[], request: FormalFeedContentDeliveryRequest): Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> | undefined {
  return records.find(record => record.event === 'formal_content_delivery_accepted'
    && sameValue(record.request.object, request.object)) as Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> | undefined
}

function findDeliveryForReceipt(
  records: readonly PeriodBusinessRecord[],
  receipt: FormalFeedContentDeliveryReceipt,
): Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> | undefined {
  return records.find(record => record.event === 'formal_content_delivery_accepted'
    && record.request.object.object === receipt.object
    && samePeriod(record.request.object.period, receipt.period)) as Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_accepted' }> | undefined
}

function findReceiptResult(
  records: readonly PeriodBusinessRecord[],
  receipt: FormalFeedContentDeliveryReceipt,
): Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> | undefined {
  return records.find(record => record.event === 'formal_content_delivery_receipt_accepted'
    && sameValue(record.receipt, receipt)) as Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> | undefined
}

function findReceiptResultForObject(
  records: readonly PeriodBusinessRecord[],
  receipt: FormalFeedContentDeliveryReceipt,
): Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> | undefined {
  return records.find(record => record.event === 'formal_content_delivery_receipt_accepted'
    && record.receipt.object === receipt.object
    && samePeriod(record.receipt.period, receipt.period)) as Extract<PeriodBusinessRecord, { event: 'formal_content_delivery_receipt_accepted' }> | undefined
}

function selectedCandidatesForDelivery(
  request: FormalFeedContentDeliveryRequest,
): readonly SourceCandidateReference[] | undefined {
  const selected = request.object.selected
  if (!isRecord(selected) || !Array.isArray(selected.candidates)) return undefined
  return selected.candidates
}

function requestSelectedDispositions(
  candidates: readonly SourceCandidateReference[],
  receipt: FormalFeedContentDeliveryReceipt,
  requestDisposition: (disposition: FormalCandidateDisposition) => C17Result,
): boolean {
  const value = receipt.result === 'Delivered'
    ? 'Shown'
    : receipt.result === 'Failed'
      ? 'NotDeliveredThisPeriod'
      : 'PossiblyDelivered'
  let complete = true
  for (const candidate of candidates) {
    const result = requestDisposition({
      period: receipt.period,
      source: candidate.source,
      candidate,
      value,
    })
    if (result.status !== 'accepted') complete = false
  }
  return complete
}

function accepted<T>(value: T): { readonly status: 'accepted'; readonly value: T } {
  return { status: 'accepted', value }
}

function rejected<T>(input: T): { readonly status: 'rejected'; readonly input: T } {
  return { status: 'rejected', input }
}

function failed<T>(input: T): { readonly status: 'failed'; readonly input: T } {
  return { status: 'failed', input }
}

function samePeriod(left: { readonly run: string; readonly period: string }, right: { readonly run: string; readonly period: string }): boolean {
  return left.run === right.run && left.period === right.period
}

function sameCandidate(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source && left.candidate === right.candidate && left.stableReference === right.stableReference
}

function sameClosure(left: EditingInputClosure, right: EditingInputClosure): boolean {
  return samePeriod(left.period, right.period) && sameReferences(left.candidatesInJudgment, right.candidatesInJudgment)
}

function sameReferences(left: readonly SourceCandidateReference[], right: readonly SourceCandidateReference[]): boolean {
  return left.length === right.length
    && new Set(left.map(canonicalCandidateTupleKey)).size === left.length
    && new Set(right.map(canonicalCandidateTupleKey)).size === right.length
    && left.every(value => right.some(candidate => sameCandidate(value, candidate)))
}

function isFormalContentDeliveryOwnerReader(
  receiver: FormalContentDeliveryReceiver,
): receiver is FormalContentDeliveryReceiver & FormalContentDeliveryOwnerReader {
  return typeof (receiver as Partial<FormalContentDeliveryOwnerReader>).readFormalFeedContentDeliveryRequest === 'function'
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function isFormalFeedContentDeliveryReceipt(value: unknown): value is FormalFeedContentDeliveryReceipt {
  return isRecord(value)
    && hasExactKeys(value, ['object', 'period', 'result'])
    && typeof value.object === 'string'
    && isPeriodIdentity(value.period)
    && (value.result === 'Delivered' || value.result === 'Failed' || value.result === 'Uncertain')
}

function isOrdinaryBusinessFinalization(
  value: BusinessFinalization,
): value is Extract<BusinessFinalization, { readonly kind: 'ordinary_content_finalized' }> {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'period'])
    && value.kind === 'ordinary_content_finalized'
    && isPeriodIdentity(value.period)
}

function isPeriodIdentity(value: unknown): value is { readonly run: string; readonly period: string } {
  return isRecord(value)
    && hasExactKeys(value, ['run', 'period'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
