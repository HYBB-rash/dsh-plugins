import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableJsonlStore from '../src/durable-jsonl-store.ts'
import { formalFeedContentObjectIdentityFor, rawFeedContentConclusionIdentityFor } from '../src/identity.ts'
import {
  candidateIdentity,
  createCandidateMaterialProjection,
  createCrossSourceEditor,
  createCurrentContextProjection,
  createDeliveryAndReceipt,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  sourceIdentity,
  sourceStableReference,
  type CandidateMaterial,
  type CandidateAcceptedIntoPeriod,
  type CandidateDispositionReceiver,
  type BusinessFinalization,
  type BusinessFinalizationReceiver,
  type CandidateEditingDecision,
  type DispositionBasisAccepted,
  type ContextEnabledCrossSourceEditor,
  type CurrentContextResult,
  type DeliveryAndReceipt,
  type EditingInputClosure,
  type EditingInputClosureReceiver,
  type FormalContentDeliveryReceiver,
  type FormalFeedContentDeliveryRequest,
  type ExternalPeriodScopeInput,
  type MaterialFact,
  type RawFeedContentInput,
  type SourceCandidateReference,
  type SourceDispositionState,
  type SourceCandidateReportAccepted,
  type SourceCandidateReportFinalizer,
  type UnscreenedMaterialCandidate,
  type UnscreenedSourceCandidateReport,
  type FormalEditingConclusion,
  type FormalCandidateDisposition,
  type FormalFeedContentDeliveryReceipt,
  type FormalFeedContentConclusion,
  type FormalOrdinaryFeedContent,
  type PeriodIdentity,
  type DisplayFact,
  type CandidatePeriodBusinessFinalizerOptions,
  type PeriodBusinessFinalizer,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function readLedgerLines(path: string): readonly string[] {
  try {
    const contents = readFileSync(path, 'utf8').trim()
    return contents === '' ? [] : contents.split('\n')
  } catch {
    return []
  }
}

function snapshotStoreDirectory(directory: string): readonly [string, Buffer][] {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isFile() ? [[name, readFileSync(path)] as [string, Buffer]] : []
  })
}

type Accepted<T> = Extract<T, { readonly status: 'accepted' }>
type Disposition = Parameters<CandidateDispositionReceiver['acceptFormalDisposition']>[0]
type Todo05Finalizer = PeriodBusinessFinalizer & SourceCandidateReportFinalizer

interface Todo05Fixture {
  readonly period: UnscreenedMaterialCandidate['period']
  readonly finalizer: Todo05Finalizer
  readonly editor: ContextEnabledCrossSourceEditor
  readonly rebuildFinalizer: () => Todo05Finalizer
  readonly rebuildFinalizerWithDeliveryReceiver: (receiver: FormalContentDeliveryReceiver) => Todo05Finalizer
  readonly rebuildEditor: () => ContextEnabledCrossSourceEditor
  readonly rebuildDeliveryAndReceipt: () => DeliveryAndReceipt
  readonly contextResult: CurrentContextResult
  readonly editingInputClosureCalls: EditingInputClosure[]
  readonly candidateDispositionCalls: Disposition[]
  readonly candidateDispositionAcceptedCalls: DispositionBasisAccepted[]
  readonly displayFactCalls: DisplayFact[]
  readonly businessFinalizationCalls: BusinessFinalization[]
  readonly businessFinalizationReceiverAcceptedFacts: BusinessFinalization[]
  readonly allowSelectedDisposition: () => void
  readonly allowDisplayFact: () => void
  readonly formalContentDeliveryCalls: FormalFeedContentDeliveryRequest[]
  readonly deliveryAndReceipt: DeliveryAndReceipt
  readonly periodBusinessLedgerPath: string
  readonly editingInputLedgerPath: string
  readonly deliveryLedgerPath: string
  readonly storeDirectory: string
  readonly acceptedReport: SourceCandidateReportAccepted
  readonly candidates: readonly UnscreenedMaterialCandidate[]
  readonly acceptedIntoPeriod: readonly CandidateAcceptedIntoPeriod[]
  readonly materials: readonly CandidateMaterial[]
  readonly materialFacts: readonly MaterialFact[]
}

interface Todo05FixtureOptions {
  readonly skipCandidateIndex?: number
  readonly allUnavailable?: boolean
  readonly secondRequiredSource?: boolean
  readonly acceptSecondReport?: boolean
  readonly receiverFault?: 'editing' | 'disposition' | 'delivery'
  readonly useRealDeliveryAndReceipt?: boolean
  readonly observeRealDeliveryAndReceipt?: boolean
  readonly now?: string
  readonly periodSuffix?: string
  readonly nulTupleCandidates?: boolean
  readonly businessFinalizationResult?: 'accepted' | 'rejected' | 'failed' | 'throw' | 'wrong'
  readonly omitDisplayFactReceiver?: boolean
  readonly displayFactReceiverResult?: 'rejected' | 'wrong' | 'accepted-without-owner'
  readonly blockedDisplayCandidateIndex?: number
  readonly rejectSelectedDispositionInitially?: boolean
  readonly blockedSelectedCandidateIndex?: number
}

async function createFixture(options: Todo05FixtureOptions = {}): Promise<Todo05Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo05-green-'))
  temporaryDirectories.push(directory)
  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(directory, 'period-business.jsonl')
  const deliveryLedgerPath = join(directory, 'delivery-and-receipt.jsonl')
  const currentContextInputLedgerPath = join(directory, 'current-context-inputs.jsonl')
  const source = sourceIdentity('todo05-source')
  const secondSource = sourceIdentity('todo05-second-source')
  const input: ExternalPeriodScopeInput = {
    requestIdentity: `dsh-cron:cron-feed:todo05-green-run-1${options.periodSuffix === undefined ? '' : `-${options.periodSuffix}`}`,
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T13:30:00.000Z',
    claimedAt: '2026-08-24T13:30:01.000Z',
    runId: `cron-feed@2026-08-24T13:30:00.000Z${options.periodSuffix === undefined ? '' : `-${options.periodSuffix}`}`,
    requiredSources: options.secondRequiredSource ? [source, secondSource] : [source],
    reportingWindowClosesAt: '2026-08-24T13:35:00.000Z',
  }
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [source, ...(options.secondRequiredSource ? [secondSource] : [])].map(scopeSource => ({
      source: scopeSource,
      mechanicalAdmission: createMechanicalAdmission(scopeSource),
      candidateMaterialProjection: createCandidateMaterialProjection(scopeSource),
    })),
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(input)
  const period = established.c01.value.period
  const mechanicalScope = established.c32[0].value
  const materialScope = established.c35[0].value
  const makeCandidate = (candidateId: string): UnscreenedMaterialCandidate => {
    const nulTuple = options.nulTupleCandidates === true && candidateId === 'formed-selected'
      ? { candidate: 'tuple-a\0tuple-b', stableReference: 'tuple-c' }
      : options.nulTupleCandidates === true && candidateId === 'formed-not-selected'
        ? { candidate: 'tuple-a', stableReference: 'tuple-b\0tuple-c' }
        : { candidate: candidateId, stableReference: `todo05:${candidateId}` }
    const reference = {
      source,
      candidate: candidateIdentity(nulTuple.candidate),
      stableReference: sourceStableReference(nulTuple.stableReference),
    }
    return {
      period,
      candidate: reference,
      qualification: {
        branch: 'unscreened', contract: 'C08', scope: mechanicalScope, period, candidate: reference,
        acceptedQualification: { contract: 'C08' },
      },
      materialBasis: { candidate: reference, acceptedBasis: { contract: 'C09' } },
    }
  }
  const candidates = [makeCandidate('formed-selected'), makeCandidate('formed-not-selected'), makeCandidate('unavailable')]
  const report: UnscreenedSourceCandidateReport = { branch: 'unscreened', scope: materialScope, period, source, candidates }
  const contextResult: CurrentContextResult = {
    kind: 'unavailable', value: { scope: established.c33.value, period, unavailableFact: { unavailable: true } },
  }
  let editor: ContextEnabledCrossSourceEditor = createCrossSourceEditor({
    candidatePeriodLedgerPath, editingInputLedgerPath, periodBusinessLedgerPath,
    periodScopeLedgerPath, currentContextInputLedgerPath,
  })
  const editingInputClosureCalls: EditingInputClosure[] = []
  const candidateDispositionCalls: Disposition[] = []
  const candidateDispositionAcceptedCalls: DispositionBasisAccepted[] = []
  let selectedDispositionBlocked = options.rejectSelectedDispositionInitially === true
    || options.blockedSelectedCandidateIndex !== undefined
  let displayFactReceiverResult = options.displayFactReceiverResult
  let blockedDisplayCandidate = options.blockedDisplayCandidateIndex === undefined
    ? undefined
    : candidates[options.blockedDisplayCandidateIndex]?.candidate
  const blockedSelectedCandidate = options.blockedSelectedCandidateIndex === undefined
    ? undefined
    : candidates[options.blockedSelectedCandidateIndex]?.candidate
  const displayFactCalls: DisplayFact[] = []
  const businessFinalizationCalls: BusinessFinalization[] = []
  const businessFinalizationReceiverAcceptedFacts: BusinessFinalization[] = []
  const formalContentDeliveryCalls: FormalFeedContentDeliveryRequest[] = []
  const deliveryAndReceipt = createDeliveryAndReceipt({ ledgerPath: deliveryLedgerPath })
  const editingInputClosureReceiver: EditingInputClosureReceiver = {
    acceptEditingInputClosure: (closure) => {
      editingInputClosureCalls.push(closure)
      if (options.receiverFault === 'editing') {
        return { status: 'accepted', value: { closure: { ...closure, candidatesInJudgment: [] } } }
      }
      return editor.acceptEditingInputClosure(closure)
    },
  }
  const candidateDispositionReceiver: CandidateDispositionReceiver = {
    acceptFormalDisposition: (disposition) => {
      candidateDispositionCalls.push(disposition)
      if (options.receiverFault === 'disposition' && disposition.value === 'ReviewedNotSelected') {
        return {
          status: 'accepted',
          value: { disposition: { ...disposition, value: 'PeriodAdmissionNotCompletedAndClosed' as const } },
        }
      }
      const blockedByCandidate = blockedSelectedCandidate === undefined
        || sameCandidateReference(disposition.candidate, blockedSelectedCandidate)
      if (selectedDispositionBlocked
        && blockedByCandidate
        && (['Shown', 'NotDeliveredThisPeriod', 'PossiblyDelivered'] as readonly string[]).includes(disposition.value)) {
        return { status: 'rejected', input: disposition }
      }
      const accepted = { status: 'accepted' as const, value: { disposition } }
      candidateDispositionAcceptedCalls.push(accepted.value)
      return accepted
    },
  }
  const displayFactReceiver: Pick<ContextEnabledCrossSourceEditor, 'acceptDisplayFact'> = {
    acceptDisplayFact: fact => {
      if (blockedDisplayCandidate !== undefined && sameCandidateReference(fact.candidate, blockedDisplayCandidate)) {
        displayFactCalls.push(fact)
        return { status: 'rejected', input: fact }
      }
      if (displayFactReceiverResult === 'rejected') {
        displayFactCalls.push(fact)
        return { status: 'rejected', input: fact }
      }
      if (displayFactReceiverResult === 'wrong') {
        displayFactCalls.push(fact)
        return {
          status: 'accepted',
          value: { fact: { ...fact, candidate: candidates[1].candidate } },
        }
      }
      if (displayFactReceiverResult === 'accepted-without-owner') {
        displayFactCalls.push(fact)
        return { status: 'accepted', value: { fact } }
      }
      const result = editor.acceptDisplayFact(fact)
      if (result.status === 'accepted') {
        const rebuiltEditor = createCrossSourceEditor({
          candidatePeriodLedgerPath,
          editingInputLedgerPath,
          periodBusinessLedgerPath,
          periodScopeLedgerPath,
          currentContextInputLedgerPath,
        })
        expect(rebuiltEditor.acceptDisplayFact(fact)).toEqual(result)
        expect(businessFinalizationCalls).toHaveLength(0)
      }
      displayFactCalls.push(fact)
      return result
    },
  }
  const businessFinalizationReceiver: BusinessFinalizationReceiver = {
    acceptBusinessFinalization: finalization => {
      const businessRecords = readLedgerRecords(periodBusinessLedgerPath)
      const periodStates = businessRecords.filter(record => record.event === 'source_disposition_state_accepted')
        .filter(record => {
          const state = record.state as Record<string, unknown> | undefined
          return state !== undefined && samePeriod(state.period as PeriodIdentity, finalization.period)
        })
      expect(periodStates).toHaveLength(candidates.length)
      const delivery = businessRecords.find(record => {
        if (record.event !== 'formal_content_delivery_accepted') return false
        const request = record.request as Record<string, unknown> | undefined
        const object = request?.object as Record<string, unknown> | undefined
        return object !== undefined && samePeriod(object.period as PeriodIdentity, finalization.period)
      })
      const deliveryObject = delivery?.request === undefined
        ? undefined
        : (delivery.request as Record<string, unknown>).object as Record<string, unknown>
      const selected = deliveryObject?.selected as { candidates?: readonly SourceCandidateReference[] } | undefined
      const owners = readLedgerRecords(editingInputLedgerPath)
        .filter(record => record.event === 'display_fact_accepted')
        .map(record => record.fact as DisplayFact)
      const selectedCandidates = selected?.candidates ?? []
      expect(owners.filter(owner => samePeriod(owner.period, finalization.period))).toHaveLength(selectedCandidates.length)
      for (const candidate of selectedCandidates) {
        expect(owners.filter(owner => samePeriod(owner.period, finalization.period)
          && sameCandidateReference(owner.candidate, candidate))).toHaveLength(1)
      }
      businessFinalizationCalls.push(finalization)
      if (options.businessFinalizationResult === 'throw') throw new Error('C23 receiver crashed')
      if (options.businessFinalizationResult === 'rejected') return { status: 'rejected', input: finalization }
      if (options.businessFinalizationResult === 'failed') return { status: 'failed', input: finalization }
      if (options.businessFinalizationResult === 'wrong') {
        return {
          status: 'accepted',
          value: { period: { ...finalization.period, period: 'wrong-period' as typeof finalization.period.period } },
        }
      }
      if (!businessFinalizationReceiverAcceptedFacts.some(existing => sameBusinessFinalization(existing, finalization))) {
        businessFinalizationReceiverAcceptedFacts.push(finalization)
      }
      return { status: 'accepted', value: { period: finalization.period } }
    },
  }
  const formalContentDeliveryReceiver: FormalContentDeliveryReceiver = options.observeRealDeliveryAndReceipt
    ? {
        acceptFormalFeedContent: (request) => {
          const result = deliveryAndReceipt.acceptFormalFeedContent(request)
          if (result.status === 'accepted') {
            expect(deliveryAndReceipt.readFormalFeedContentDeliveryRequest(request.object.object)).toEqual(request)
            const receiverLines = readLedgerLines(deliveryLedgerPath)
            expect(receiverLines).toHaveLength(1)
            expect(JSON.parse(receiverLines[0])).toMatchObject({ request })
            const businessLines = readLedgerLines(periodBusinessLedgerPath)
            expect(businessLines.filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')).toHaveLength(0)
          }
          return result
        },
      }
    : options.useRealDeliveryAndReceipt ? deliveryAndReceipt
    : {
        acceptFormalFeedContent: (request) => {
          formalContentDeliveryCalls.push(request)
          if (options.receiverFault === 'delivery') {
            return { status: 'accepted', value: { request: { object: { ...request.object, content: { body: 'wrong receiver value' } } } } }
          }
          return { status: 'accepted', value: { request } }
        },
      }
  const createFinalizer = (
    finalizerNow = options.now ?? '2026-08-24T13:32:00.000Z',
    deliveryReceiver = formalContentDeliveryReceiver,
  ): Todo05Finalizer => createPeriodBusinessFinalizer(({
    periodScopeLedgerPath, reportLedgerPath, candidatePeriodLedgerPath, editingInputLedgerPath,
    periodBusinessLedgerPath, now: () => finalizerNow,
    editingInputClosureReceiver, candidateDispositionReceiver,
    formalContentDeliveryReceiver: deliveryReceiver,
    businessFinalizationReceiver,
    ...(options.omitDisplayFactReceiver ? {} : { displayFactReceiver }),
  } as CandidatePeriodBusinessFinalizerOptions & { readonly displayFactReceiver: Pick<ContextEnabledCrossSourceEditor, 'acceptDisplayFact'> }))
  const finalizer = createFinalizer()
  const reportFinalizer = options.now === undefined ? finalizer : createFinalizer('2026-08-24T13:32:00.000Z')
  const acceptedReportResult = reportFinalizer.acceptSourceCandidateReport(report)
  expect(acceptedReportResult.status).toBe('accepted')
  if (acceptedReportResult.status !== 'accepted') throw new Error('C36 fixture did not produce an accepted report')
  if (options.acceptSecondReport) {
    const secondReport = {
      ...report,
      source: secondSource,
      scope: established.c35[1].value,
      candidates: [],
    }
    expect(reportFinalizer.acceptSourceCandidateReport(secondReport)).toMatchObject({ status: 'accepted' })
  }
  const acceptedIntoPeriod = candidates.flatMap((candidate, index) => {
    if (options.skipCandidateIndex === index) return []
    const result = finalizer.acceptCandidateIntoPeriod({ report: acceptedReportResult.value, candidate })
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') throw new Error('C26 fixture did not produce an accepted candidate')
    return result.value
  })
  const acceptedCandidateIndexes = candidates
    .map((_, index) => index)
    .filter(index => options.skipCandidateIndex !== index)
  const materials: CandidateMaterial[] = acceptedCandidateIndexes.map((candidateIndex, index) => ({
    acceptedIntoPeriod: acceptedIntoPeriod[index], period, candidate: candidates[candidateIndex].candidate,
    boundedContent: { title: `candidate ${candidateIndex}` }, attribution: { source },
    exactLookup: { stableReference: candidates[candidateIndex].candidate.stableReference },
  }))
  const materialFacts: MaterialFact[] = acceptedCandidateIndexes.map((candidateIndex, index) => (options.allUnavailable || candidateIndex === 2)
    ? { kind: 'material_unavailable' as const, acceptedIntoPeriod: acceptedIntoPeriod[index], period, candidate: candidates[candidateIndex].candidate, unavailableFact: { reason: 'source material was not available' } }
    : { kind: 'material_formed' as const, acceptedIntoPeriod: acceptedIntoPeriod[index], period, candidate: candidates[candidateIndex].candidate, materialFormedFact: { available: true } })
  return {
    period, finalizer, editor, rebuildFinalizer: createFinalizer,
    rebuildFinalizerWithDeliveryReceiver: deliveryReceiver => createFinalizer(options.now ?? '2026-08-24T13:32:00.000Z', deliveryReceiver),
    rebuildDeliveryAndReceipt: () => createDeliveryAndReceipt({ ledgerPath: deliveryLedgerPath }),
    periodBusinessLedgerPath, editingInputLedgerPath, storeDirectory: directory,
    deliveryAndReceipt, deliveryLedgerPath,
    rebuildEditor: () => {
      editor = createCrossSourceEditor({ candidatePeriodLedgerPath, editingInputLedgerPath, periodBusinessLedgerPath, periodScopeLedgerPath, currentContextInputLedgerPath })
      return editor
    },
    contextResult, editingInputClosureCalls, candidateDispositionCalls, candidateDispositionAcceptedCalls,
    displayFactCalls, businessFinalizationCalls, businessFinalizationReceiverAcceptedFacts, formalContentDeliveryCalls,
    allowSelectedDisposition: () => { selectedDispositionBlocked = false },
    allowDisplayFact: () => {
      displayFactReceiverResult = undefined
      blockedDisplayCandidate = undefined
    },
    acceptedReport: acceptedReportResult.value, candidates, acceptedIntoPeriod, materials, materialFacts,
  }
}

function editingClosure(fixture: Todo05Fixture, candidates: readonly SourceCandidateReference[] = fixture.candidates.slice(0, 2).map(value => value.candidate)): EditingInputClosure {
  return { period: fixture.period, candidatesInJudgment: candidates }
}

function editorConclusionInput(
  fixture: Todo05Fixture,
  closure: Accepted<ReturnType<PeriodBusinessFinalizer['establishEditingInputClosure']>>['value'],
  decisions: readonly CandidateEditingDecision[] = [
    { kind: 'selected', candidate: fixture.candidates[0].candidate },
    { kind: 'not_selected', candidate: fixture.candidates[1].candidate, semanticReason: 'Useful but lower value for this period.' },
  ],
): RawFeedContentInput {
  return {
    closure, content: { body: 'A concise ordinary Feed body.' },
    decisions: { candidatesInJudgment: fixture.candidates.slice(0, 2).map(value => value.candidate), decisions },
  }
}

function ordinaryFormal(value: FormalEditingConclusion): FormalFeedContentConclusion {
  if (!('content' in value) || !('candidates' in value.content.selected)) {
    throw new Error('expected ordinary formal Feed content')
  }
  return value as FormalFeedContentConclusion
}

function establishEditingPrerequisites(fixture: Todo05Fixture): void {
  expect(fixture.editor.acceptCurrentContext(fixture.contextResult)).toMatchObject({ status: 'accepted' })
  expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[0])).toMatchObject({ status: 'accepted' })
  expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[1])).toMatchObject({ status: 'accepted' })
  expect(fixture.editor.acceptCandidateMaterial(fixture.materials[0])).toMatchObject({ status: 'accepted' })
  expect(fixture.editor.acceptCandidateMaterial(fixture.materials[1])).toMatchObject({ status: 'accepted' })
  expect(fixture.editor.listAcceptedInputs()).toEqual([fixture.materials[0], fixture.materials[1]])
  expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[2])).toMatchObject({ status: 'accepted' })
  const disposition = { period: fixture.period, source: fixture.candidates[2].candidate.source, candidate: fixture.candidates[2].candidate, value: 'MaterialUnavailableAndClosed' as const }
  const c17 = fixture.finalizer.requestSourceDisposition(disposition)
  expect(c17.status).toBe('accepted')
  if (c17.status !== 'accepted') throw new Error('C17 fixture did not produce an accepted disposition basis')
  expect(c17.value).not.toHaveProperty('state')
  expect(fixture.candidateDispositionCalls).toEqual([c17.value.disposition])
  const c18 = fixture.finalizer.acceptSourceDispositionState({ period: fixture.period, candidate: fixture.candidates[2].candidate, state: 'Suppressed', sourceCompletion: c17.value })
  expect(c18.status).toBe('accepted')
  expect(c18).not.toEqual(c17)
}

function establishFormalDeliveryRequest(fixture: Todo05Fixture): FormalFeedContentDeliveryRequest {
  establishEditingPrerequisites(fixture)
  const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
  expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
  const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value))
  expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('editor did not return RawFeedContentConclusion')
  const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
  expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
  return { object: ordinaryFormal(formal.value).content }
}

function establishCompleteMixedDeliveryGates(fixture: Todo05Fixture): {
  readonly request: FormalFeedContentDeliveryRequest
  readonly receipt: FormalFeedContentDeliveryReceipt
  readonly selectedState: SourceDispositionState
} {
  const request = establishFormalDeliveryRequest(fixture)
  expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
  const receipt = deliveryReceipt(request, 'Delivered')
  expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
  const notSelected = fixture.candidateDispositionAcceptedCalls.find(value =>
    value.disposition.value === 'ReviewedNotSelected'
      && sameCandidateReference(value.disposition.candidate, fixture.candidates[1].candidate),
  )
  expect(notSelected).toBeDefined()
  if (notSelected === undefined) throw new Error('C15 did not establish NotSelected disposition')
  expect(fixture.finalizer.acceptSourceDispositionState({
    period: fixture.period,
    candidate: notSelected.disposition.candidate,
    state: 'Suppressed',
    sourceCompletion: notSelected,
  })).toMatchObject({ status: 'accepted' })
  const selected = fixture.candidateDispositionAcceptedCalls.find(value =>
    value.disposition.value === 'Shown'
      && sameCandidateReference(value.disposition.candidate, fixture.candidates[0].candidate),
  )
  expect(selected).toBeDefined()
  if (selected === undefined) throw new Error('C21 did not establish selected disposition')
  const selectedState = {
    period: fixture.period,
    candidate: selected.disposition.candidate,
    state: 'Displayed',
    sourceCompletion: selected,
  } as const
  expect(fixture.finalizer.acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'accepted' })
  return { request, receipt, selectedState }
}

function ordinaryDeliveryObject(request: FormalFeedContentDeliveryRequest): FormalOrdinaryFeedContent {
  if (!('candidates' in request.object.selected)) throw new Error('expected an ordinary delivery object')
  return request.object as FormalOrdinaryFeedContent
}

function deliveryReceipt(
  request: FormalFeedContentDeliveryRequest,
  result: FormalFeedContentDeliveryReceipt['result'],
): FormalFeedContentDeliveryReceipt {
  return { object: request.object.object, period: request.object.period, result }
}

function displayFactFor(
  request: FormalFeedContentDeliveryRequest,
  receipt: FormalFeedContentDeliveryReceipt,
  dispositionValue: FormalCandidateDisposition['value'],
  candidateOverride?: SourceCandidateReference,
): DisplayFact {
  const candidate = candidateOverride ?? ordinaryDeliveryObject(request).selected.candidates[0]
  const disposition = {
    period: request.object.period,
    source: candidate.source,
    candidate,
    value: dispositionValue,
  } satisfies FormalCandidateDisposition
  return { period: request.object.period, candidate, disposition, receipt } as DisplayFact
}

function establishDisplayFactOwner(fixture: Todo05Fixture): {
  readonly request: FormalFeedContentDeliveryRequest
  readonly receipt: FormalFeedContentDeliveryReceipt
  readonly fact: DisplayFact
} {
  const request = establishFormalDeliveryRequest(fixture)
  expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
  const receipt = deliveryReceipt(request, 'Delivered')
  expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
  const selected = fixture.candidateDispositionAcceptedCalls.find(value =>
    value.disposition.value === 'Shown'
      && sameCandidateReference(value.disposition.candidate, ordinaryDeliveryObject(request).selected.candidates[0]),
  )
  expect(selected).toBeDefined()
  if (selected === undefined) throw new Error('C21 did not establish selected disposition')
  expect(fixture.finalizer.acceptSourceDispositionState({
    period: request.object.period,
    candidate: selected.disposition.candidate,
    state: 'Displayed',
    sourceCompletion: selected,
  })).toMatchObject({ status: 'accepted' })
  const fact = displayFactFor(request, receipt, 'Shown')
  expect(fixture.editor.acceptDisplayFact(fact)).toEqual({ status: 'accepted', value: { fact } })
  return { request, receipt, fact }
}

function rewriteLedger(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function readLedgerRecords(path: string): Record<string, unknown>[] {
  return readLedgerLines(path).map(line => JSON.parse(line) as Record<string, unknown>)
}

function sameCandidateReference(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function sameBusinessFinalization(left: BusinessFinalization, right: BusinessFinalization): boolean {
  return left.kind === right.kind && samePeriod(left.period, right.period)
}

function candidateReferenceFromRecord(value: unknown): SourceCandidateReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.source !== 'string' || typeof record.candidate !== 'string' || typeof record.stableReference !== 'string') {
    return undefined
  }
  return record as unknown as SourceCandidateReference
}

function hasSourceStateRecord(
  ledgerPath: string,
  candidate: SourceCandidateReference,
  state: 'Displayed' | 'Suppressed',
): boolean {
  return readLedgerLines(ledgerPath).some(line => {
    const record: unknown = JSON.parse(line)
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return false
    const stateRecord = (record as Record<string, unknown>).state
    if (typeof stateRecord !== 'object' || stateRecord === null || Array.isArray(stateRecord)) return false
    const stateValue = stateRecord as Record<string, unknown>
    const recordCandidate = candidateReferenceFromRecord(stateValue.candidate)
    return stateValue.state === state && recordCandidate !== undefined && sameCandidateReference(recordCandidate, candidate)
  })
}

function compatibleDispositionValue(result: FormalFeedContentDeliveryReceipt['result']): FormalCandidateDisposition['value'] {
  return result === 'Delivered' ? 'Shown' : result === 'Failed' ? 'NotDeliveredThisPeriod' : 'PossiblyDelivered'
}

function alternateDeliveryResult(result: FormalFeedContentDeliveryReceipt['result']): FormalFeedContentDeliveryReceipt['result'] {
  return result === 'Delivered' ? 'Failed' : 'Delivered'
}

function readDeliveryRecord(path: string): Record<string, unknown> {
  const lines = readLedgerLines(path)
  expect(lines).toHaveLength(1)
  const value: unknown = JSON.parse(lines[0])
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('delivery row is not an object')
  return value as Record<string, unknown>
}

function writeDeliveryRecord(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

describe('TODO 05 ordinary Feed before delivery / GREEN boundary', () => {
  it('rejects C37 when a C36 report member has no C26 accepted fact', async () => {
    const fixture = await createFixture({ skipCandidateIndex: 2 })
    expect(fixture.editor.acceptCurrentContext(fixture.contextResult)).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[1])).toMatchObject({ status: 'accepted' })
    expect(fixture.editor.acceptCandidateMaterial(fixture.materials[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.editor.acceptCandidateMaterial(fixture.materials[1])).toMatchObject({ status: 'accepted' })
    const result = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(result).toMatchObject({ status: 'rejected' })
    expect(fixture.editingInputClosureCalls).toEqual([])
  })

  it('accepts C16 MaterialFormed and MaterialUnavailable, then closes only unavailable through C17/C18', async () => {
    const fixture = await createFixture()
    for (const fact of fixture.materialFacts) expect(fixture.finalizer.acceptMaterialFact(fact)).toEqual({ status: 'accepted', value: { fact } })
    const disposition = { period: fixture.period, source: fixture.candidates[2].candidate.source, candidate: fixture.candidates[2].candidate, value: 'MaterialUnavailableAndClosed' as const }
    const c17 = fixture.finalizer.requestSourceDisposition(disposition)
    expect(c17.status).toBe('accepted')
    if (c17.status !== 'accepted') throw new Error('C17 did not return an accepted disposition basis')
    expect(c17.value).toMatchObject({ disposition })
    expect(c17.value).not.toHaveProperty('state')
    expect(fixture.candidateDispositionCalls).toEqual([c17.value.disposition])
    const c18 = fixture.finalizer.acceptSourceDispositionState({ period: fixture.period, candidate: fixture.candidates[2].candidate, state: 'Suppressed', sourceCompletion: c17.value })
    expect(c18.status).toBe('accepted')
    expect(c18).not.toEqual(c17)
  })

  it('rejects C18 Displayed for unavailable and refuses C37 until Suppressed closure exists', async () => {
    const fixture = await createFixture()
    expect(fixture.editor.acceptCurrentContext(fixture.contextResult)).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[1])).toMatchObject({ status: 'accepted' })
    expect(fixture.editor.acceptCandidateMaterial(fixture.materials[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.editor.acceptCandidateMaterial(fixture.materials[1])).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptMaterialFact(fixture.materialFacts[2])).toMatchObject({ status: 'accepted' })
    const disposition = { period: fixture.period, source: fixture.candidates[2].candidate.source, candidate: fixture.candidates[2].candidate, value: 'MaterialUnavailableAndClosed' as const }
    const c17 = fixture.finalizer.requestSourceDisposition(disposition)
    expect(c17.status).toBe('accepted'); if (c17.status !== 'accepted') throw new Error('C17 did not accept')
    expect(fixture.finalizer.acceptSourceDispositionState({ period: fixture.period, candidate: fixture.candidates[2].candidate, state: 'Displayed', sourceCompletion: c17.value })).toMatchObject({ status: 'rejected' })
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))).toMatchObject({ status: 'rejected' })
    expect(fixture.editingInputClosureCalls).toEqual([])
  })

  it('rejects accepted receiver values that do not echo the exact request and leaves no durable success', async () => {
    const badEditing = await createFixture({ receiverFault: 'editing' }); establishEditingPrerequisites(badEditing)
    const closure = editingClosure(badEditing)
    expect(badEditing.finalizer.establishEditingInputClosure(closure)).toMatchObject({ status: 'rejected' })
    expect(badEditing.finalizer.establishEditingInputClosure(closure)).toMatchObject({ status: 'rejected' })
    expect(badEditing.editingInputClosureCalls).toEqual([closure, closure])

    const badDisposition = await createFixture({ receiverFault: 'disposition' }); establishEditingPrerequisites(badDisposition)
    const dispositionClosure = badDisposition.finalizer.establishEditingInputClosure(editingClosure(badDisposition))
    expect(dispositionClosure.status).toBe('accepted'); if (dispositionClosure.status !== 'accepted') throw new Error('C37 did not accept')
    const dispositionRaw = badDisposition.editor.formRawFeedContentConclusion(editorConclusionInput(badDisposition, dispositionClosure.value))
    expect(dispositionRaw.status).toBe('accepted'); if (dispositionRaw.status !== 'accepted') throw new Error('Raw did not accept')
    expect(badDisposition.finalizer.acceptEditingConclusion(dispositionRaw.value)).toMatchObject({ status: 'accepted' })
    const notSelected = {
      period: badDisposition.period,
      source: badDisposition.candidates[1].candidate.source,
      candidate: badDisposition.candidates[1].candidate,
      value: 'ReviewedNotSelected' as const,
    }
    expect(badDisposition.finalizer.requestSourceDisposition(notSelected)).toMatchObject({ status: 'rejected' })
    expect(badDisposition.finalizer.requestSourceDisposition(notSelected)).toMatchObject({ status: 'rejected' })
    expect(badDisposition.candidateDispositionCalls).toHaveLength(4)
    expect(badDisposition.candidateDispositionCalls[0].value).toBe('MaterialUnavailableAndClosed')
    expect(badDisposition.candidateDispositionCalls.slice(1)).toEqual([notSelected, notSelected, notSelected])

    const badDelivery = await createFixture({ receiverFault: 'delivery' }); establishEditingPrerequisites(badDelivery)
    const badClosure = badDelivery.finalizer.establishEditingInputClosure(editingClosure(badDelivery))
    expect(badClosure.status).toBe('accepted'); if (badClosure.status !== 'accepted') throw new Error('C37 did not accept')
    const badRaw = badDelivery.editor.formRawFeedContentConclusion(editorConclusionInput(badDelivery, badClosure.value))
    expect(badRaw.status).toBe('accepted'); if (badRaw.status !== 'accepted') throw new Error('Raw did not accept')
    const badFormal = badDelivery.finalizer.acceptEditingConclusion(badRaw.value)
    expect(badFormal.status).toBe('accepted'); if (badFormal.status !== 'accepted') throw new Error('C15 did not accept')
    const badRequest: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(badFormal.value).content }
    expect(badDelivery.finalizer.requestFormalContentDelivery(badRequest)).toMatchObject({ status: 'rejected' })
    expect(badDelivery.finalizer.requestFormalContentDelivery(badRequest)).toMatchObject({ status: 'rejected' })
    expect(badDelivery.formalContentDeliveryCalls).toEqual([badRequest, badRequest])
  })

  it('fails closed on malformed or incomplete period-business ledger records', async () => {
    const malformed = await createFixture()
    appendFileSync(malformed.periodBusinessLedgerPath, '{not-json}\n')
    expect(malformed.rebuildFinalizer().establishEditingInputClosure(editingClosure(malformed))).toMatchObject({ status: 'failed' })

    const missingNested = await createFixture()
    appendFileSync(missingNested.periodBusinessLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'editing_input_closure_accepted',
      closure: { period: missingNested.period },
    }) + '\n')
    expect(missingNested.rebuildFinalizer().establishEditingInputClosure(editingClosure(missingNested))).toMatchObject({ status: 'failed' })

    const wrongNested = await createFixture()
    appendFileSync(wrongNested.periodBusinessLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'source_disposition_state_accepted',
      state: {
        period: wrongNested.period,
        candidate: wrongNested.candidates[2].candidate,
        state: 'Suppressed',
      },
    }) + '\n')
    expect(wrongNested.rebuildFinalizer().establishEditingInputClosure(editingClosure(wrongNested))).toMatchObject({ status: 'failed' })

    const eventShapes = await createFixture()
    const candidate = eventShapes.candidates[0].candidate
    const period = eventShapes.period
    const closure = { period, candidatesInJudgment: [candidate] }
    const decisions = {
      candidatesInJudgment: [candidate],
      decisions: [{ kind: 'selected', candidate }],
    }
    const raw = {
      conclusion: 'editing-conclusion:raw',
      closure: { closure },
      content: { body: 'raw body' },
      decisions,
    }
    const formalContent = {
      object: 'feed-content:object',
      period,
      original: raw.conclusion,
      content: { body: 'raw body' },
      selected: { candidates: [candidate] },
    }
    const formal = { period, original: raw.conclusion, content: formalContent, decisions }
    const disposition = {
      period,
      source: candidate.source,
      candidate,
      value: 'ReviewedNotSelected',
    }
    const malformedEvents: readonly Record<string, unknown>[] = [
      { schemaVersion: 1, event: 'editing_input_closure_accepted', closure, extra: true },
      { schemaVersion: 1, event: 'formal_editing_conclusion_accepted', raw, formal: { ...formal, original: 'other' } },
      { schemaVersion: 1, event: 'candidate_disposition_accepted', disposition, accepted: { disposition: { ...disposition, value: 'Shown' } } },
      { schemaVersion: 1, event: 'source_disposition_state_accepted', state: { period, candidate, state: 'Suppressed', sourceCompletion: null } },
      {
        schemaVersion: 1,
        event: 'formal_content_delivery_accepted',
        request: { object: formalContent },
        accepted: { request: { object: { ...formalContent, content: { body: 'other' } } } },
      },
    ]
    for (const [index, record] of malformedEvents.entries()) {
      const fixture = index === 0 ? eventShapes : await createFixture()
      appendFileSync(fixture.periodBusinessLedgerPath, JSON.stringify(record) + '\n')
      expect(fixture.rebuildFinalizer().establishEditingInputClosure(editingClosure(fixture))).toMatchObject({ status: 'failed' })
    }

    const realConclusion = await createFixture(); establishEditingPrerequisites(realConclusion)
    const realClosure = realConclusion.finalizer.establishEditingInputClosure(editingClosure(realConclusion))
    expect(realClosure.status).toBe('accepted'); if (realClosure.status !== 'accepted') throw new Error('C37 did not accept')
    const realRaw = realConclusion.editor.formRawFeedContentConclusion(editorConclusionInput(realConclusion, realClosure.value))
    expect(realRaw.status).toBe('accepted'); if (realRaw.status !== 'accepted') throw new Error('Raw did not accept')
    const realFormal = realConclusion.finalizer.acceptEditingConclusion(realRaw.value)
    expect(realFormal.status).toBe('accepted'); if (realFormal.status !== 'accepted') throw new Error('C15 did not accept')
    const formalValue = ordinaryFormal(realFormal.value)
    appendFileSync(realConclusion.periodBusinessLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'formal_editing_conclusion_accepted',
      raw: realRaw.value,
      formal: { ...formalValue, original: 'formal/raw mismatch' },
    }) + '\n')
    expect(realConclusion.rebuildFinalizer().establishEditingInputClosure(editingClosure(realConclusion))).toMatchObject({ status: 'failed' })

    const forgedState = await createFixture()
    const forgedDisposition = {
      period: forgedState.period,
      source: forgedState.candidates[1].candidate.source,
      candidate: forgedState.candidates[1].candidate,
      value: 'ReviewedNotSelected' as const,
    }
    const forgedSourceState = {
      period: forgedState.period,
      candidate: forgedState.candidates[1].candidate,
      state: 'Suppressed' as const,
      sourceCompletion: { disposition: forgedDisposition },
    }
    appendFileSync(forgedState.periodBusinessLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'source_disposition_state_accepted',
      state: forgedSourceState,
    }) + '\n')
    expect(forgedState.rebuildFinalizer().acceptSourceDispositionState(forgedSourceState)).toMatchObject({ status: 'rejected' })

    const malformedClosure = await createFixture(); establishEditingPrerequisites(malformedClosure)
    appendFileSync(malformedClosure.editingInputLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'editing_input_closure_accepted',
      closure: {
        period: malformedClosure.period,
        candidatesInJudgment: [malformedClosure.candidates[0].candidate, malformedClosure.candidates[0].candidate],
      },
    }) + '\n')
    expect(malformedClosure.rebuildFinalizer().establishEditingInputClosure(editingClosure(malformedClosure))).toMatchObject({ status: 'failed' })

    const forgedRaw = await createFixture(); establishEditingPrerequisites(forgedRaw)
    const forgedRawClosure = forgedRaw.finalizer.establishEditingInputClosure(editingClosure(forgedRaw))
    expect(forgedRawClosure.status).toBe('accepted'); if (forgedRawClosure.status !== 'accepted') throw new Error('C37 did not accept')
    const forgedRawInput = editorConclusionInput(forgedRaw, forgedRawClosure.value)
    const forgedRawResult = forgedRaw.editor.formRawFeedContentConclusion(forgedRawInput)
    expect(forgedRawResult.status).toBe('accepted'); if (forgedRawResult.status !== 'accepted') throw new Error('Raw did not accept')
    appendFileSync(forgedRaw.editingInputLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'raw_feed_content_conclusion_accepted',
      input: forgedRawInput,
      conclusion: { ...forgedRawResult.value, conclusion: 'editing-conclusion:forged' },
    }) + '\n')
    expect(forgedRaw.rebuildFinalizer().acceptEditingConclusion(forgedRawResult.value)).toMatchObject({ status: 'failed' })

    const divergentRaw = await createFixture(); establishEditingPrerequisites(divergentRaw)
    const divergentClosure = divergentRaw.finalizer.establishEditingInputClosure(editingClosure(divergentRaw))
    expect(divergentClosure.status).toBe('accepted'); if (divergentClosure.status !== 'accepted') throw new Error('C37 did not accept')
    const divergentInput = editorConclusionInput(divergentRaw, divergentClosure.value)
    const divergentResult = divergentRaw.editor.formRawFeedContentConclusion(divergentInput)
    expect(divergentResult.status).toBe('accepted'); if (divergentResult.status !== 'accepted') throw new Error('Raw did not accept')
    appendFileSync(divergentRaw.editingInputLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'raw_feed_content_conclusion_accepted',
      input: divergentInput,
      conclusion: { ...divergentResult.value, content: { body: 'divergent durable content' } },
    }) + '\n')
    expect(divergentRaw.rebuildFinalizer().acceptEditingConclusion(divergentResult.value)).toMatchObject({ status: 'failed' })
  })

  it('does not turn an all-unavailable admitted report into an empty ordinary C37 closure', async () => {
    const fixture = await createFixture({ allUnavailable: true })
    expect(fixture.editor.acceptCurrentContext(fixture.contextResult)).toMatchObject({ status: 'accepted' })
    for (const [index, fact] of fixture.materialFacts.entries()) {
      expect(fixture.finalizer.acceptMaterialFact(fact)).toMatchObject({ status: 'accepted' })
      const disposition = { period: fixture.period, source: fixture.candidates[index].candidate.source, candidate: fixture.candidates[index].candidate, value: 'MaterialUnavailableAndClosed' as const }
      const c17 = fixture.finalizer.requestSourceDisposition(disposition)
      expect(c17.status).toBe('accepted'); if (c17.status !== 'accepted') throw new Error('C17 did not accept')
      expect(fixture.finalizer.acceptSourceDispositionState({ period: fixture.period, candidate: fixture.candidates[index].candidate, state: 'Suppressed', sourceCompletion: c17.value })).toMatchObject({ status: 'accepted' })
    }
    appendFileSync(fixture.editingInputLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'editing_input_closure_accepted',
      closure: { period: fixture.period, candidatesInJudgment: [] },
    }) + '\n')
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, []))).toMatchObject({ status: 'rejected' })
    expect(fixture.editingInputClosureCalls).toEqual([])
  })

  it('fails C15 closed when the editing-input ledger contains a forged Raw identity', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const input = editorConclusionInput(fixture, closure.value)
    const raw = fixture.editor.formRawFeedContentConclusion(input)
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('Raw did not accept')
    appendFileSync(fixture.editingInputLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'raw_feed_content_conclusion_accepted',
      input,
      conclusion: { ...raw.value, conclusion: 'editing-conclusion:forged-public-ledger' },
    }) + '\n')
    expect(fixture.rebuildFinalizer().acceptEditingConclusion(raw.value)).toMatchObject({ status: 'failed' })
  })

  it('keeps a mixed period alive: two formed candidates enter C10 and unavailable closes outside editing', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    expect(fixture.editor.listAcceptedInputs()).toEqual([fixture.materials[0], fixture.materials[1]])
    expect(fixture.editor.listAcceptedInputs()).not.toContain(fixture.materials[2])
  })

  it('allows C37 to close one exact formed range once and rejects duplicates, unavailable, out-of-range, and late C10', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = editingClosure(fixture)
    const first = fixture.finalizer.establishEditingInputClosure(closure)
    expect(first.status).toBe('accepted'); expect(fixture.editingInputClosureCalls).toEqual([closure])
    expect(fixture.finalizer.establishEditingInputClosure(closure)).toEqual(first)
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[1].candidate, fixture.candidates[0].candidate]))).toEqual(first)
    expect(fixture.editingInputClosureCalls).toEqual([closure])
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[0].candidate, fixture.candidates[0].candidate]))).toMatchObject({ status: 'rejected' })
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[0].candidate]))).toMatchObject({ status: 'rejected' })
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[0].candidate, fixture.candidates[1].candidate, fixture.candidates[2].candidate]))).toMatchObject({ status: 'rejected' })
    const outside = { source: fixture.candidates[0].candidate.source, candidate: candidateIdentity('outside-closure'), stableReference: sourceStableReference('todo05:outside-closure') }
    expect(fixture.finalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[0].candidate, outside]))).toMatchObject({ status: 'rejected' })
    expect(fixture.editor.acceptCandidateMaterial({ ...fixture.materials[0], boundedContent: { title: 'late C10 material' } })).toMatchObject({ status: 'rejected' })
    expect(fixture.editingInputClosureCalls).toEqual([closure])
  })

  it('fails closed across an editor-durable C37 before the business ledger append while preserving exact replays', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = editingClosure(fixture)
    expect(fixture.editor.acceptEditingInputClosure(closure)).toMatchObject({ status: 'accepted' })
    expect(fixture.rebuildFinalizer().establishEditingInputClosure(closure)).toMatchObject({ status: 'accepted' })
    expect(fixture.editingInputClosureCalls).toEqual([])
    expect(fixture.editor.acceptCandidateMaterial(fixture.materials[2])).toMatchObject({ status: 'rejected' })
    expect(fixture.editor.acceptCandidateMaterial({ ...fixture.materials[0], boundedContent: { title: 'crash-gap late C10' } })).toMatchObject({ status: 'rejected' })
    const lateFormedFact: MaterialFact = {
      kind: 'material_formed',
      acceptedIntoPeriod: fixture.materialFacts[0].acceptedIntoPeriod,
      period: fixture.period,
      candidate: fixture.candidates[0].candidate,
      materialFormedFact: { crashGap: true },
    }
    expect(fixture.finalizer.acceptMaterialFact(lateFormedFact)).toMatchObject({ status: 'rejected' })
    expect(fixture.finalizer.acceptCandidateIntoPeriod({ report: fixture.acceptedReport, candidate: fixture.candidates[0] })).toMatchObject({ status: 'accepted' })
  })

  it('preserves complete formed-candidate decisions through C15 after C37, including multiple Selected candidates', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const ordinaryInput = editorConclusionInput(fixture, closure.value)
    for (const malformedContent of [null, 'wrong shape', { wrongKey: true }]) {
      expect(fixture.editor.formRawFeedContentConclusion({ ...ordinaryInput, content: malformedContent } as unknown as RawFeedContentInput))
        .toMatchObject({ status: 'rejected' })
    }
    expect(fixture.editor.formRawFeedContentConclusion({
      ...ordinaryInput,
      decisions: { ...ordinaryInput.decisions, decisions: [
        { kind: 'selected', candidate: fixture.candidates[0].candidate, semanticReason: 'forbidden' },
        ordinaryInput.decisions.decisions[1],
      ] },
    } as unknown as RawFeedContentInput)).toMatchObject({ status: 'rejected' })
    expect(fixture.editor.formRawFeedContentConclusion({
      ...ordinaryInput,
      decisions: { ...ordinaryInput.decisions, decisions: [
        ordinaryInput.decisions.decisions[0],
        { kind: 'not_selected', candidate: fixture.candidates[1].candidate },
      ] },
    } as unknown as RawFeedContentInput)).toMatchObject({ status: 'rejected' })
    expect(fixture.editor.formRawFeedContentConclusion({
      ...ordinaryInput,
      decisions: { ...ordinaryInput.decisions, decisions: [
        ordinaryInput.decisions.decisions[0],
        { kind: 'not_selected', candidate: fixture.candidates[1].candidate, semanticReason: undefined },
      ] },
    } as unknown as RawFeedContentInput)).toMatchObject({ status: 'rejected' })
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value, [
      { kind: 'selected', candidate: fixture.candidates[0].candidate }, { kind: 'selected', candidate: fixture.candidates[1].candidate },
    ]))
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('editor did not return RawFeedContentConclusion')
    const reorderedInput: RawFeedContentInput = {
      ...editorConclusionInput(fixture, {
        closure: {
          ...closure.value.closure,
          candidatesInJudgment: [fixture.candidates[1].candidate, fixture.candidates[0].candidate],
        },
      }),
      decisions: {
        candidatesInJudgment: [fixture.candidates[1].candidate, fixture.candidates[0].candidate],
        decisions: [
          { kind: 'selected', candidate: fixture.candidates[1].candidate },
          { kind: 'selected', candidate: fixture.candidates[0].candidate },
        ],
      },
    }
    expect(fixture.editor.formRawFeedContentConclusion(reorderedInput)).toEqual(raw)
    const foreignFixture = await createFixture(); establishEditingPrerequisites(foreignFixture)
    const foreignClosure = foreignFixture.finalizer.establishEditingInputClosure(editingClosure(foreignFixture))
    expect(foreignClosure.status).toBe('accepted'); if (foreignClosure.status !== 'accepted') throw new Error('foreign C37 did not accept')
    const foreignRaw = foreignFixture.editor.formRawFeedContentConclusion(editorConclusionInput(foreignFixture, foreignClosure.value))
    expect(foreignRaw.status).toBe('accepted'); if (foreignRaw.status !== 'accepted') throw new Error('foreign Raw did not accept')
    expect(fixture.finalizer.acceptEditingConclusion(foreignRaw.value)).toMatchObject({ status: 'rejected' })
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    expect(formal.value).toMatchObject({ period: fixture.period, original: raw.value.conclusion, content: { period: fixture.period, original: raw.value.conclusion, content: raw.value.content, selected: { candidates: [fixture.candidates[0].candidate, fixture.candidates[1].candidate] } }, decisions: raw.value.decisions })
  })

  it('fails closed when raw identity input contains unsupported canonical JSON values', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const sparse: unknown[] = []; sparse.length = 1
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let getterCalls = 0
    const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get: () => { getterCalls += 1; return 1 } })
    for (const body of [undefined, NaN, Infinity, new Date('2026-08-24T00:00:00.000Z'), sparse, cycle, accessor]) {
      expect(fixture.editor.formRawFeedContentConclusion({
        ...editorConclusionInput(fixture, closure.value),
        content: { body },
      })).toMatchObject({ status: 'rejected' })
    }
    expect(getterCalls).toBe(0)
    const negativeFixture = await createFixture(); establishEditingPrerequisites(negativeFixture)
    const negativeClosure = negativeFixture.finalizer.establishEditingInputClosure(editingClosure(negativeFixture))
    expect(negativeClosure.status).toBe('accepted'); if (negativeClosure.status !== 'accepted') throw new Error('negative-zero C37 did not accept')
    const negativeRaw = negativeFixture.editor.formRawFeedContentConclusion({ ...editorConclusionInput(negativeFixture, negativeClosure.value), content: { body: -0 } })
    expect(negativeRaw.status).toBe('accepted'); if (negativeRaw.status !== 'accepted') throw new Error('negative-zero Raw did not accept')
    const positiveFixture = await createFixture(); establishEditingPrerequisites(positiveFixture)
    const positiveClosure = positiveFixture.finalizer.establishEditingInputClosure(editingClosure(positiveFixture))
    expect(positiveClosure.status).toBe('accepted'); if (positiveClosure.status !== 'accepted') throw new Error('positive-zero C37 did not accept')
    const positiveRaw = positiveFixture.editor.formRawFeedContentConclusion({ ...editorConclusionInput(positiveFixture, positiveClosure.value), content: { body: 0 } })
    expect(positiveRaw.status).toBe('accepted'); if (positiveRaw.status !== 'accepted') throw new Error('positive-zero Raw did not accept')
    expect(negativeRaw.value.conclusion).not.toBe(positiveRaw.value.conclusion)
  })

  it('requires every C34 source to have an accepted same-period C36 report before its close, but permits accepted reports after the boundary', async () => {
    const beforeBoundary = await createFixture({ secondRequiredSource: true })
    establishEditingPrerequisites(beforeBoundary)
    expect(beforeBoundary.finalizer.establishEditingInputClosure(editingClosure(beforeBoundary))).toMatchObject({ status: 'rejected' })
    expect(beforeBoundary.editingInputClosureCalls).toEqual([])
    expect(beforeBoundary.finalizer.acceptSourceCandidateReport({
      ...beforeBoundary.acceptedReport.report,
      period: { ...beforeBoundary.period, period: beforeBoundary.period.period + '-wrong-period' } as typeof beforeBoundary.period,
    })).toMatchObject({ status: 'rejected' })
    expect(beforeBoundary.finalizer.acceptSourceCandidateReport({
      ...beforeBoundary.acceptedReport.report,
      scope: {
        ...beforeBoundary.acceptedReport.report.scope,
        scope: {
          ...beforeBoundary.acceptedReport.report.scope.scope,
          reportingWindow: {
            ...beforeBoundary.acceptedReport.report.scope.scope.reportingWindow,
            window: {
              ...beforeBoundary.acceptedReport.report.scope.scope.reportingWindow.window,
              window: 'todo05-wrong-window' as typeof beforeBoundary.acceptedReport.report.scope.scope.reportingWindow.window.window,
            },
          },
        },
      },
    })).toMatchObject({ status: 'rejected' })

    const afterBoundary = await createFixture({ secondRequiredSource: true, now: '2026-08-24T13:36:00.000Z' })
    establishEditingPrerequisites(afterBoundary)
    expect(afterBoundary.finalizer.establishEditingInputClosure(editingClosure(afterBoundary))).toMatchObject({ status: 'accepted' })
  })

  it('lets C19 claim one responsibility from exact C15 content', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value))
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('editor did not return RawFeedContentConclusion')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    const first = fixture.finalizer.requestFormalContentDelivery(request)
    expect(first.status).toBe('accepted'); if (first.status !== 'accepted') throw new Error('C19 did not accept')
    expect(first.value).toEqual({ request }); expect(first.value).not.toHaveProperty('result')
    expect(fixture.formalContentDeliveryCalls).toEqual([request])
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toEqual(first)
    const conflict: FormalFeedContentDeliveryRequest = { object: { ...request.object, content: { body: 'conflicting delivery content' } } }
    expect(fixture.finalizer.requestFormalContentDelivery(conflict)).toMatchObject({ status: 'rejected' })
    expect(fixture.formalContentDeliveryCalls).toEqual([request])
  })

  it('claims C19 through the real DeliveryAndReceipt after C15 and reads back its exact request', async () => {
    const fixture = await createFixture({ observeRealDeliveryAndReceipt: true }); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value))
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('editor did not return RawFeedContentConclusion')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }

    const c19 = fixture.finalizer.requestFormalContentDelivery(request)
    expect(c19.status).toBe('accepted')
    if (c19.status !== 'accepted') throw new Error('C19 did not accept through the real DeliveryAndReceipt')
    expect(c19.value).toEqual({ request })
    expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(request.object.object)).toEqual(request)

    const deliveryLines = readLedgerLines(fixture.deliveryLedgerPath)
    expect(deliveryLines).toHaveLength(1)
    expect(JSON.parse(deliveryLines[0])).toMatchObject({ request })
    const businessLines = readFileSync(fixture.periodBusinessLedgerPath, 'utf8').trim().split('\n')
    expect(businessLines.filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')).toHaveLength(1)
  })

  it('closes NotSelected before C21 while rejecting premature Selected Shown', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value))
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('editor did not return RawFeedContentConclusion')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
    const notSelected = fixture.finalizer.requestSourceDisposition({ period: fixture.period, source: fixture.candidates[1].candidate.source, candidate: fixture.candidates[1].candidate, value: 'ReviewedNotSelected' as const })
    expect(notSelected.status).toBe('accepted'); if (notSelected.status !== 'accepted') throw new Error('C17 did not accept')
    expect(fixture.finalizer.requestSourceDisposition({ period: fixture.period, source: fixture.candidates[0].candidate.source, candidate: fixture.candidates[0].candidate, value: 'Shown' as const })).toMatchObject({ status: 'rejected' })
    expect(fixture.finalizer.acceptSourceDispositionState({ period: fixture.period, candidate: fixture.candidates[1].candidate, state: 'Suppressed', sourceCompletion: notSelected.value })).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.requestFormalContentDelivery({ object: ordinaryFormal(formal.value).content })).toMatchObject({ status: 'accepted' })
  })

  it('keeps C15 mixed closure independent: only formed NotSelected enters C17/C18', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    establishEditingPrerequisites(fixture)
    const prerequisiteRecords = readLedgerLines(fixture.periodBusinessLedgerPath).map(line => JSON.parse(line) as Record<string, unknown>)
    const unavailableC17Index = prerequisiteRecords.findIndex(record =>
      record.event === 'candidate_disposition_accepted'
      && (record.disposition as { value?: unknown } | undefined)?.value === 'MaterialUnavailableAndClosed')
    const unavailableC18Index = prerequisiteRecords.findIndex(record => {
      const stateRecord = record.state as { state?: unknown; candidate?: unknown } | undefined
      const recordCandidate = candidateReferenceFromRecord(stateRecord?.candidate)
      return record.event === 'source_disposition_state_accepted'
        && stateRecord?.state === 'Suppressed'
        && recordCandidate !== undefined
        && sameCandidateReference(recordCandidate, fixture.candidates[2].candidate)
    })
    expect(unavailableC17Index).toBeGreaterThanOrEqual(0)
    expect(unavailableC18Index).toBeGreaterThan(unavailableC17Index)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted'); if (closure.status !== 'accepted') throw new Error('C37 did not accept')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value))
    expect(raw.status).toBe('accepted'); if (raw.status !== 'accepted') throw new Error('Raw did not accept')
    const callsBeforeC15 = fixture.candidateDispositionCalls.length
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted'); if (formal.status !== 'accepted') throw new Error('C15 did not accept')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    const businessRecords = readLedgerLines(fixture.periodBusinessLedgerPath).map(line => JSON.parse(line) as Record<string, unknown>)
    const c37Index = businessRecords.findIndex(record => record.event === 'editing_input_closure_accepted')
    expect(unavailableC18Index).toBeLessThan(c37Index)
    expect(unavailableC17Index).toBeGreaterThanOrEqual(0)
    expect(fixture.candidateDispositionCalls).toHaveLength(callsBeforeC15 + 1)
    const disposition = {
      period: fixture.period,
      source: fixture.candidates[1].candidate.source,
      candidate: fixture.candidates[1].candidate,
      value: 'ReviewedNotSelected' as const,
    }
    expect(fixture.candidateDispositionCalls.at(-1)).toEqual(disposition)
    expect(fixture.candidateDispositionCalls.some(call => sameCandidateReference(call.candidate, fixture.candidates[0].candidate))).toBe(false)
    expect(fixture.candidateDispositionCalls.filter(call => sameCandidateReference(call.candidate, fixture.candidates[2].candidate))).toHaveLength(1)
    const c17 = fixture.candidateDispositionAcceptedCalls.at(-1)
    expect(c17).toEqual({ disposition })
    if (c17 === undefined) throw new Error('C15 did not request NotSelected through the receiver')
    const c18 = fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: fixture.candidates[1].candidate,
      state: 'Suppressed',
      sourceCompletion: c17,
    })
    expect(c18).toMatchObject({ status: 'accepted', value: { state: { state: 'Suppressed' } } })
    expect(c18).not.toEqual(c17)
    expect(fixture.finalizer.requestSourceDisposition(disposition)).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: fixture.candidates[1].candidate,
      state: 'Suppressed',
      sourceCompletion: c17,
    })).toEqual(c18)
    const notSelectedFact = displayFactFor(
      request,
      deliveryReceipt(request, 'Delivered'),
      'Shown',
      fixture.candidates[1].candidate,
    )
    const beforeNotSelectedC28 = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.editor.acceptDisplayFact(notSelectedFact)).not.toMatchObject({ status: 'accepted', value: { fact: notSelectedFact } })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeNotSelectedC28)
  })

  it.each(['Delivered', 'Failed', 'Uncertain'] as const)(
    'C21 maps %s to selected C17 and keeps C18/C28/C23 ordered',
    async result => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      const c19 = fixture.finalizer.requestFormalContentDelivery(request)
      expect(c19).toMatchObject({ status: 'accepted', value: { request } })
      const receipt = deliveryReceipt(request, result)
      const beforeC21 = snapshotStoreDirectory(fixture.storeDirectory)
      const dispositionCallsBeforeC21 = fixture.candidateDispositionCalls.length
      expect(fixture.displayFactCalls).toHaveLength(0)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
      const c21 = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
      expect(c21).toEqual({ status: 'accepted', value: { period: request.object.period, receipt } })
      expect(c21).not.toHaveProperty('channel')
      if (c21.status !== 'accepted') throw new Error('C21 did not accept the exact C19 receipt')

      const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
        value.disposition.value === compatibleDispositionValue(result)
        && sameCandidateReference(value.disposition.candidate, ordinaryDeliveryObject(request).selected.candidates[0]),
      )
      expect(selectedC17).toEqual({
        disposition: {
          period: request.object.period,
          source: ordinaryDeliveryObject(request).selected.candidates[0].source,
          candidate: ordinaryDeliveryObject(request).selected.candidates[0],
          value: compatibleDispositionValue(result),
        },
      })
      expect(fixture.candidateDispositionCalls).toHaveLength(dispositionCallsBeforeC21 + 1)
      expect(selectedC17).not.toHaveProperty('state')
      expect(fixture.displayFactCalls).toHaveLength(0)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
      expect(hasSourceStateRecord(
        fixture.periodBusinessLedgerPath,
        ordinaryDeliveryObject(request).selected.candidates[0],
        result === 'Delivered' ? 'Displayed' : 'Suppressed',
      )).toBe(false)

      const afterFirstC21 = snapshotStoreDirectory(fixture.storeDirectory)
      expect(afterFirstC21).not.toEqual(beforeC21)
      const replay = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
      expect(replay).toEqual(c21)
      expect(fixture.candidateDispositionCalls).toHaveLength(dispositionCallsBeforeC21 + 1)
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirstC21)

      const conflict = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt({
        ...receipt,
        result: alternateDeliveryResult(result),
      })
      expect(conflict).toMatchObject({ status: 'rejected' })
      expect(fixture.candidateDispositionCalls).toHaveLength(dispositionCallsBeforeC21 + 1)
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirstC21)

      if (selectedC17 === undefined) throw new Error('C21 did not request selected C17 through the receiver')
      const selectedC18 = fixture.finalizer.acceptSourceDispositionState({
        period: request.object.period,
        candidate: selectedC17.disposition.candidate,
        state: result === 'Delivered' ? 'Displayed' : 'Suppressed',
        sourceCompletion: selectedC17,
      })
      expect(selectedC18).toMatchObject({ status: 'accepted', value: { state: {
        state: result === 'Delivered' ? 'Displayed' : 'Suppressed',
      } } })
      expect(selectedC18).not.toEqual(selectedC17)
      expect(hasSourceStateRecord(
        fixture.periodBusinessLedgerPath,
        ordinaryDeliveryObject(request).selected.candidates[0],
        result === 'Delivered' ? 'Displayed' : 'Suppressed',
      )).toBe(true)

      const fact = displayFactFor(request, receipt, compatibleDispositionValue(result))
      // C17 is only the request basis. The finalizer must publish C28 after C18.
      expect(fixture.displayFactCalls).toHaveLength(1)
      expect(fixture.displayFactCalls[0]).toEqual(fact)
      const afterC28 = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toEqual({ status: 'accepted', value: { fact } })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterC28)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
    },
  )

  it.each(['missing C19', 'another real object/period', 'wrong period', 'extra runtime key'] as const)(
    'rejects a C21 receipt with %s without writing or invoking a receiver',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      let receipt = deliveryReceipt(request, 'Delivered')
      if (variant === 'another real object/period') {
        const otherFixture = await createFixture({ useRealDeliveryAndReceipt: true, periodSuffix: 'other-c21' })
        const otherRequest = establishFormalDeliveryRequest(otherFixture)
        expect(otherFixture.finalizer.requestFormalContentDelivery(otherRequest)).toMatchObject({ status: 'accepted' })
        receipt = deliveryReceipt(otherRequest, 'Delivered')
      } else if (variant === 'wrong period') {
        receipt = {
          ...receipt,
          period: { ...receipt.period, period: `${receipt.period.period}-wrong` as typeof receipt.period.period },
        }
      } else if (variant === 'extra runtime key') {
        receipt = { ...receipt, unexpected: true } as unknown as FormalFeedContentDeliveryReceipt
      }
      if (variant !== 'missing C19') {
        expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      }
      const before = snapshotStoreDirectory(fixture.storeDirectory)
      const candidateCallsBefore = fixture.candidateDispositionCalls.length
      const c21 = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
      expect(c21).toMatchObject({ status: 'rejected', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
      expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(variant === 'missing C19' ? 0 : 1)
      expect(fixture.candidateDispositionCalls).toHaveLength(candidateCallsBefore)
      expect(fixture.displayFactCalls).toHaveLength(0)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
    },
  )

  it('keeps a durable C21 receipt failed when selected C17 is not accepted, then repairs it on replay', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      rejectSelectedDispositionInitially: true,
      omitDisplayFactReceiver: true,
    })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    const beforeC21 = snapshotStoreDirectory(fixture.storeDirectory)
    const beforeC21BusinessLines = readLedgerLines(fixture.periodBusinessLedgerPath)
    const c21Failed = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(c21Failed).toEqual({ status: 'failed', input: receipt })
    const afterFailedC21 = snapshotStoreDirectory(fixture.storeDirectory)
    expect(afterFailedC21).not.toEqual(beforeC21)
    const afterFailedC21BusinessLines = readLedgerLines(fixture.periodBusinessLedgerPath)
    expect(afterFailedC21BusinessLines.slice(0, beforeC21BusinessLines.length)).toEqual(beforeC21BusinessLines)
    expect(afterFailedC21BusinessLines).toHaveLength(beforeC21BusinessLines.length + 1)
    const firstC21BusinessLine = afterFailedC21BusinessLines[beforeC21BusinessLines.length]
    expect(firstC21BusinessLine).toBeDefined()
    if (firstC21BusinessLine === undefined) throw new Error('C21 failed without a durable period-business line')
    expect(afterFailedC21BusinessLines.filter(line => line === firstC21BusinessLine)).toHaveLength(1)
    expect(fixture.candidateDispositionAcceptedCalls.some(value =>
      sameCandidateReference(value.disposition.candidate, fixture.candidates[0].candidate),
    )).toBe(false)

    const retryWhileBlocked = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(retryWhileBlocked).toEqual(c21Failed)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFailedC21)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath)).toEqual(afterFailedC21BusinessLines)

    const beforeC28 = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.editor.acceptDisplayFact(displayFactFor(request, receipt, 'Shown'))).toMatchObject({ status: 'rejected' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeC28)

    fixture.allowSelectedDisposition()
    const acceptedDispositionCountBeforeRepair = fixture.candidateDispositionAcceptedCalls.length
    const beforeRepairBusinessLines = readLedgerLines(fixture.periodBusinessLedgerPath)
    const repaired = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(repaired).toMatchObject({ status: 'accepted', value: { period: request.object.period, receipt } })
    const afterRepairBusinessLines = readLedgerLines(fixture.periodBusinessLedgerPath)
    expect(afterRepairBusinessLines.slice(0, beforeRepairBusinessLines.length)).toEqual(beforeRepairBusinessLines)
    expect(afterRepairBusinessLines).toHaveLength(beforeRepairBusinessLines.length + 1)
    expect(afterRepairBusinessLines.filter(line => line === firstC21BusinessLine)).toHaveLength(1)
    const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
      sameCandidateReference(value.disposition.candidate, fixture.candidates[0].candidate)
        && value.disposition.value === 'Shown',
    )
    expect(selectedC17).toBeDefined()
    expect(fixture.candidateDispositionAcceptedCalls).toHaveLength(acceptedDispositionCountBeforeRepair + 1)
    if (selectedC17 === undefined) throw new Error('replayed C21 did not establish selected C17')
    expect(fixture.editor.acceptDisplayFact(displayFactFor(request, receipt, 'Shown'))).toMatchObject({ status: 'rejected' })
  })

  it('records one exact C21 owner row and replays it from rebuilt period-business state', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    const first = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(first).toEqual({ status: 'accepted', value: { period: receipt.period, receipt } })

    const rows = readLedgerLines(fixture.periodBusinessLedgerPath)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const c21Rows = rows.filter(row => row.event === 'formal_content_delivery_receipt_accepted')
    expect(c21Rows).toHaveLength(1)
    expect(c21Rows[0]).toEqual({
      schemaVersion: 1,
      event: 'formal_content_delivery_receipt_accepted',
      receipt,
      accepted: { period: receipt.period, receipt },
    })

    const afterFirst = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toEqual(first)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirst)
  })

  it.each(['duplicate exact row', 'same-object conflicting tri-state row', 'orphan receipt row'] as const)(
    'fails closed on C21 %s and does not append another fact',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const lines = readLedgerLines(fixture.periodBusinessLedgerPath)
      const c21Index = lines.findIndex(line => JSON.parse(line).event === 'formal_content_delivery_receipt_accepted')
      expect(c21Index).toBeGreaterThanOrEqual(0)
      if (c21Index < 0) throw new Error('C21 first row was not durable')
      const row = JSON.parse(lines[c21Index]) as Record<string, unknown>
      if (variant === 'same-object conflicting tri-state row') {
        row.receipt = { ...receipt, result: 'Failed' }
        row.accepted = { period: receipt.period, receipt: row.receipt }
      } else if (variant === 'orphan receipt row') {
        const orphanReceipt = { ...receipt, object: `${receipt.object}-orphan` as typeof receipt.object }
        row.receipt = orphanReceipt
        row.accepted = { period: orphanReceipt.period, receipt: orphanReceipt }
      }
      const corrupted = variant === 'duplicate exact row'
        ? lines[c21Index]
        : JSON.stringify(row)
      if (corrupted === undefined) throw new Error('C21 first row was not durable')
      appendFileSync(fixture.periodBusinessLedgerPath, `${corrupted}\n`)
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      const formalRow = lines.map(line => JSON.parse(line) as Record<string, unknown>)
        .find(record => record.event === 'formal_editing_conclusion_accepted')
      const notSelected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'ReviewedNotSelected')
      expect(formalRow).toBeDefined()
      expect(notSelected).toBeDefined()
      if (formalRow === undefined || notSelected === undefined) throw new Error('C21 fixture facts were incomplete')
      const raw = formalRow.raw as Parameters<Todo05Finalizer['acceptEditingConclusion']>[0]
      const state = {
        period: fixture.period,
        candidate: notSelected.disposition.candidate,
        state: 'Suppressed' as const,
        sourceCompletion: notSelected,
      }
      const outcomes = [
        fixture.rebuildFinalizer().acceptEditingConclusion(raw),
        fixture.rebuildFinalizer().requestSourceDisposition(notSelected.disposition),
        fixture.rebuildFinalizer().acceptSourceDispositionState(state),
        fixture.rebuildFinalizer().requestFormalContentDelivery(request),
        fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt),
      ]
      expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
      expect(outcomes[4]).toMatchObject({ status: 'failed', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it.each(['top-level extra key', 'accepted period mismatch', 'accepted receipt mismatch'] as const)(
    'rejects C21 row with %s during rebuild without changing its bytes',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const lines = readLedgerLines(fixture.periodBusinessLedgerPath)
      const c21Index = lines.findIndex(line => JSON.parse(line).event === 'formal_content_delivery_receipt_accepted')
      expect(c21Index).toBeGreaterThanOrEqual(0)
      if (c21Index < 0) throw new Error('C21 first row was not durable')
      const row = JSON.parse(lines[c21Index]) as Record<string, unknown>
      if (variant === 'top-level extra key') {
        row.extra = true
      } else if (variant === 'accepted period mismatch') {
        row.accepted = { period: { ...receipt.period, period: `${receipt.period.period}-wrong` }, receipt }
      } else {
        row.accepted = { period: receipt.period, receipt: { ...receipt, result: 'Uncertain' } }
      }
      const rewritten = [...lines]
      rewritten[c21Index] = JSON.stringify(row)
      writeFileSync(fixture.periodBusinessLedgerPath, `${rewritten.join('\n')}\n`, 'utf8')
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it.each(['missing C19 row', 'malformed C19 row', 'conflicting C19 row'] as const)(
    'does not accept C21 from an existing-first %s',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const lines = readLedgerLines(fixture.periodBusinessLedgerPath)
      const c19Index = lines.findIndex(line => JSON.parse(line).event === 'formal_content_delivery_accepted')
      expect(c19Index).toBeGreaterThanOrEqual(0)
      if (c19Index < 0) throw new Error('C19 row was not durable')
      if (variant === 'missing C19 row') {
        lines.splice(c19Index, 1)
      } else if (variant === 'malformed C19 row') {
        lines[c19Index] = JSON.stringify({ schemaVersion: 1, event: 'formal_content_delivery_accepted', request })
      } else {
        const conflicting = JSON.parse(lines[c19Index]) as Record<string, unknown>
        const conflictingRequest = { object: { ...request.object, content: { body: 'conflicting C19 content' } } }
        conflicting.request = conflictingRequest
        conflicting.accepted = { request: conflictingRequest }
        lines.push(JSON.stringify(conflicting))
      }
      writeFileSync(fixture.periodBusinessLedgerPath, `${lines.join('\n')}\n`, 'utf8')
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it.each(['missing owner', 'malformed owner', 'duplicate owner', 'conflicting owner'] as const)(
    'does not accept C21 when the DeliveryAndReceipt owner is %s',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const ownerLines = readLedgerLines(fixture.deliveryLedgerPath)
      expect(ownerLines).toHaveLength(1)
      if (variant === 'missing owner') {
        rmSync(fixture.deliveryLedgerPath, { force: true })
      } else if (variant === 'malformed owner') {
        writeFileSync(fixture.deliveryLedgerPath, '{not-json}\n', 'utf8')
      } else if (variant === 'duplicate owner') {
        appendFileSync(fixture.deliveryLedgerPath, `${ownerLines[0]}\n`)
      } else {
        const owner = JSON.parse(ownerLines[0]) as Record<string, unknown>
        const ownerRequest = owner.request as Record<string, unknown>
        const ownerObject = ownerRequest.object as Record<string, unknown>
        owner.request = { object: { ...ownerObject, content: { body: 'conflicting owner content' } } }
        appendFileSync(fixture.deliveryLedgerPath, `${JSON.stringify(owner)}\n`)
      }
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it.each(['period-business read I/O', 'DeliveryAndReceipt owner read I/O'] as const)(
    'fails C21 on %s without creating a replacement fact',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const unreadablePath = variant === 'period-business read I/O'
        ? fixture.periodBusinessLedgerPath
        : fixture.deliveryLedgerPath
      rmSync(unreadablePath, { force: true })
      mkdirSync(unreadablePath)
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed', input: receipt })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it('fails every business writer when the C21 owner row is malformed', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
    const rows = readLedgerLines(fixture.periodBusinessLedgerPath)
    appendFileSync(fixture.periodBusinessLedgerPath, JSON.stringify({
      schemaVersion: 1,
      event: 'formal_content_delivery_receipt_accepted',
      receipt,
      accepted: { period: receipt.period },
    }) + '\n')
    const formalRow = rows.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(row => row.event === 'formal_editing_conclusion_accepted')
    const notSelected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'ReviewedNotSelected')
    expect(formalRow).toBeDefined()
    expect(notSelected).toBeDefined()
    if (formalRow === undefined || notSelected === undefined) throw new Error('C21 fixture facts were incomplete')
    const raw = formalRow.raw as Parameters<Todo05Finalizer['acceptEditingConclusion']>[0]
    const state = {
      period: fixture.period,
      candidate: notSelected.disposition.candidate,
      state: 'Suppressed' as const,
      sourceCompletion: notSelected,
    }
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptEditingConclusion(raw)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().requestSourceDisposition(notSelected.disposition)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('recovers C21 when append throws after the exact first row is durable', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    const append = durableJsonlStore.appendJsonLine
    let c21AppendCalls = 0
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce((path, records, record) => {
      c21AppendCalls += 1
      append(path, records, record)
      throw new Error('C21 append completed before acknowledgement was lost')
    })
    const result = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(c21AppendCalls).toBe(1)
    expect(appendSpy).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'accepted', value: { period: receipt.period, receipt } })
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => JSON.parse(line).event === 'formal_content_delivery_receipt_accepted')).toHaveLength(1)
    expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toEqual(result)
  })

  it('fails before appending C21 without changing the store directory', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce(() => {
      throw new Error('C21 append failed before write')
    })
    const result = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'failed', input: receipt })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => JSON.parse(line).event === 'formal_content_delivery_receipt_accepted')).toHaveLength(0)
  })

  it('repairs only the missing selected C17 across partial C21 replays', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      blockedSelectedCandidateIndex: 1,
    })
    establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure).toMatchObject({ status: 'accepted' })
    if (closure.status !== 'accepted') throw new Error('C37 did not accept the two-selected closure')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value, [
      { kind: 'selected', candidate: fixture.candidates[0].candidate },
      { kind: 'selected', candidate: fixture.candidates[1].candidate },
    ]))
    expect(raw).toMatchObject({ status: 'accepted' })
    if (raw.status !== 'accepted') throw new Error('editor did not form the two-selected Raw conclusion')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal).toMatchObject({ status: 'accepted' })
    if (formal.status !== 'accepted') throw new Error('C15 did not accept the two-selected conclusion')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    const selected = ordinaryDeliveryObject(request).selected.candidates
    expect(selected).toHaveLength(2)
    if (selected.length !== 2) throw new Error('C19 did not retain two selected candidates')

    const countSelectedAccepted = (candidate: SourceCandidateReference): number => fixture.candidateDispositionAcceptedCalls.filter(value =>
      value.disposition.value === 'Shown' && sameCandidateReference(value.disposition.candidate, candidate),
    ).length
    const countSelectedCalls = (candidate: SourceCandidateReference): number => fixture.candidateDispositionCalls.filter(value =>
      value.value === 'Shown' && sameCandidateReference(value.candidate, candidate),
    ).length
    const c21Count = (): number => readLedgerLines(fixture.periodBusinessLedgerPath)
      .filter(line => JSON.parse(line).event === 'formal_content_delivery_receipt_accepted').length

    const first = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(first).toEqual({ status: 'failed', input: receipt })
    expect(c21Count()).toBe(1)
    expect(countSelectedAccepted(selected[0])).toBe(1)
    expect(countSelectedAccepted(selected[1])).toBe(0)
    expect(countSelectedCalls(selected[0])).toBe(1)
    expect(countSelectedCalls(selected[1])).toBe(1)
    expect(hasSourceStateRecord(fixture.periodBusinessLedgerPath, selected[0], 'Displayed')).toBe(false)
    expect(hasSourceStateRecord(fixture.periodBusinessLedgerPath, selected[1], 'Displayed')).toBe(false)
    expect(fixture.displayFactCalls).toHaveLength(0)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)

    const afterFirst = snapshotStoreDirectory(fixture.storeDirectory)
    const blockedReplay = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(blockedReplay).toEqual(first)
    expect(c21Count()).toBe(1)
    expect(countSelectedAccepted(selected[0])).toBe(1)
    expect(countSelectedAccepted(selected[1])).toBe(0)
    expect(countSelectedCalls(selected[0])).toBe(1)
    expect(countSelectedCalls(selected[1])).toBe(2)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirst)

    fixture.allowSelectedDisposition()
    const beforeRepair = snapshotStoreDirectory(fixture.storeDirectory)
    const repaired = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(repaired).toEqual({ status: 'accepted', value: { period: receipt.period, receipt } })
    expect(c21Count()).toBe(1)
    expect(countSelectedAccepted(selected[0])).toBe(1)
    expect(countSelectedAccepted(selected[1])).toBe(1)
    expect(countSelectedCalls(selected[0])).toBe(1)
    expect(countSelectedCalls(selected[1])).toBe(3)
    expect(hasSourceStateRecord(fixture.periodBusinessLedgerPath, selected[0], 'Displayed')).toBe(false)
    expect(hasSourceStateRecord(fixture.periodBusinessLedgerPath, selected[1], 'Displayed')).toBe(false)
    expect(fixture.displayFactCalls).toHaveLength(0)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).not.toEqual(beforeRepair)

    const afterRepair = snapshotStoreDirectory(fixture.storeDirectory)
    const conflict = fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt({
      ...receipt,
      result: alternateDeliveryResult(receipt.result),
    })
    expect(conflict).toMatchObject({ status: 'rejected', input: { ...receipt, result: alternateDeliveryResult(receipt.result) } })
    expect(c21Count()).toBe(1)
    expect(countSelectedAccepted(selected[0])).toBe(1)
    expect(countSelectedAccepted(selected[1])).toBe(1)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterRepair)
  })

  it('accepts a selected DisplayFact only through the real editor C28 receiver seam', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const request = establishFormalDeliveryRequest(fixture)
    const c19 = fixture.finalizer.requestFormalContentDelivery(request)
    expect(c19).toMatchObject({ status: 'accepted', value: { request } })
    const receipt = deliveryReceipt(request, 'Delivered')
    const c21 = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(c21).toMatchObject({ status: 'accepted', value: { period: request.object.period, receipt } })
    if (c21.status !== 'accepted') throw new Error('C21 did not establish the receipt owner')
    const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
      value.disposition.value === 'Shown'
      && sameCandidateReference(value.disposition.candidate, ordinaryDeliveryObject(request).selected.candidates[0]),
    )
    expect(selectedC17).toBeDefined()
    if (selectedC17 === undefined) throw new Error('C21 did not establish selected C17')
    const c18 = fixture.finalizer.acceptSourceDispositionState({
      period: request.object.period,
      candidate: selectedC17.disposition.candidate,
      state: 'Displayed',
      sourceCompletion: selectedC17,
    })
    expect(c18).toMatchObject({ status: 'accepted', value: { state: { state: 'Displayed' } } })
    const fact = displayFactFor(request, receipt, 'Shown')
    const first = fixture.editor.acceptDisplayFact(fact)
    expect(first).toEqual({ status: 'accepted', value: { fact } })
    expect(fixture.displayFactCalls).toHaveLength(0)
    const afterFirst = snapshotStoreDirectory(fixture.storeDirectory)
    const replay = fixture.rebuildEditor().acceptDisplayFact(fact)
    expect(replay).toEqual({ status: 'accepted', value: { fact } })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirst)
    const conflictingFact = displayFactFor(
      request,
      { ...receipt, result: 'Failed' },
      'NotDeliveredThisPeriod',
    )
    const beforeConflict = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildEditor().acceptDisplayFact(conflictingFact)).toMatchObject({ status: 'rejected', input: conflictingFact })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeConflict)
  })

  it.each(['rejected', 'wrong', 'accepted-without-owner'] as const)(
    'keeps selected C18 durable when the finalizer C28 receiver returns %s',
    async receiverResult => {
      const fixture = await createFixture({
        useRealDeliveryAndReceipt: true,
        displayFactReceiverResult: receiverResult,
        businessFinalizationResult: 'accepted',
      })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
        value.disposition.value === 'Shown'
        && sameCandidateReference(value.disposition.candidate, ordinaryDeliveryObject(request).selected.candidates[0]),
      )
      expect(selectedC17).toBeDefined()
      if (selectedC17 === undefined) throw new Error('C21 did not establish selected C17')
      const c18 = fixture.finalizer.acceptSourceDispositionState({
        period: request.object.period,
        candidate: selectedC17.disposition.candidate,
        state: 'Displayed',
        sourceCompletion: selectedC17,
      })
      expect(c18).toMatchObject({ status: 'accepted', value: { state: { state: 'Displayed' } } })
      expect(hasSourceStateRecord(fixture.periodBusinessLedgerPath, selectedC17.disposition.candidate, 'Displayed')).toBe(true)
      expect(fixture.displayFactCalls).toHaveLength(1)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
    },
  )

  it.each(['rejected', 'wrong', 'accepted-without-owner'] as const)(
    'retries a missing C28 after %s receiver result without duplicating C18',
    async receiverResult => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true, displayFactReceiverResult: receiverResult })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
      const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
        value.disposition.value === 'Shown'
        && sameCandidateReference(value.disposition.candidate, ordinaryDeliveryObject(request).selected.candidates[0]),
      )
      expect(selectedC17).toBeDefined()
      if (selectedC17 === undefined) throw new Error('C21 did not establish selected C17')
      const state = {
        period: request.object.period,
        candidate: selectedC17.disposition.candidate,
        state: 'Displayed' as const,
        sourceCompletion: selectedC17,
      }
      const countC18 = (): number => readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => {
        const record = JSON.parse(line) as Record<string, unknown>
        const stateRecord = record.state as Record<string, unknown> | undefined
        const candidate = candidateReferenceFromRecord(stateRecord?.candidate)
        return record.event === 'source_disposition_state_accepted'
          && stateRecord?.state === 'Displayed'
          && candidate !== undefined
          && sameCandidateReference(candidate, state.candidate)
      }).length
      const first = fixture.finalizer.acceptSourceDispositionState(state)
      expect(first).toMatchObject({ status: 'accepted', value: { state } })
      expect(countC18()).toBe(1)
      expect(fixture.displayFactCalls).toHaveLength(1)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
      const countDisplayFacts = (): number => readLedgerLines(fixture.editingInputLedgerPath).filter(line => {
        const record = JSON.parse(line) as Record<string, unknown>
        return record.event === 'display_fact_accepted'
      }).length
      expect(countDisplayFacts()).toBe(0)

      const afterFirst = snapshotStoreDirectory(fixture.storeDirectory)
      const blockedReplay = fixture.rebuildFinalizer().acceptSourceDispositionState(state)
      expect(blockedReplay).toEqual(first)
      expect(countC18()).toBe(1)
      expect(fixture.displayFactCalls).toHaveLength(2)
      expect(countDisplayFacts()).toBe(0)
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirst)

      fixture.allowDisplayFact()
      const repaired = fixture.rebuildFinalizer().acceptSourceDispositionState(state)
      expect(repaired).toEqual(first)
      expect(countC18()).toBe(1)
      expect(fixture.displayFactCalls).toHaveLength(3)
      expect(countDisplayFacts()).toBe(1)
      expect(fixture.businessFinalizationCalls).toHaveLength(0)

      const afterRepair = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toEqual(first)
      expect(fixture.displayFactCalls).toHaveLength(3)
      expect(countDisplayFacts()).toBe(1)
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterRepair)
    },
  )

  it.each(['missing C21', 'missing selected C17', 'missing C18', 'incompatible receipt/disposition', 'extra runtime key'] as const)(
    'rejects C28 when its durable prerequisites are %s',
    async variant => {
      const fixture = await createFixture({
        useRealDeliveryAndReceipt: true,
        omitDisplayFactReceiver: true,
        rejectSelectedDispositionInitially: variant === 'missing selected C17',
      })
      const request = establishFormalDeliveryRequest(fixture)
      const receipt = deliveryReceipt(request, 'Delivered')
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      if (variant !== 'missing C21') {
        const c21 = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
        expect(c21).toMatchObject({ status: variant === 'missing selected C17' ? 'failed' : 'accepted' })
      }
      const selected = fixture.candidates[0].candidate
      const selectedC17 = fixture.candidateDispositionAcceptedCalls.find(value =>
        value.disposition.value === 'Shown' && sameCandidateReference(value.disposition.candidate, selected),
      )
      if (variant === 'incompatible receipt/disposition') {
        expect(selectedC17).toBeDefined()
      }
      if (variant === 'incompatible receipt/disposition' && selectedC17 !== undefined) {
        expect(fixture.finalizer.acceptSourceDispositionState({
          period: fixture.period,
          candidate: selected,
          state: 'Displayed',
          sourceCompletion: selectedC17,
        })).toMatchObject({ status: 'accepted' })
      }
      const incompatible = displayFactFor(
        request,
        receipt,
        variant === 'incompatible receipt/disposition' ? 'NotDeliveredThisPeriod' : 'Shown',
      )
      const input = variant === 'extra runtime key'
        ? { ...incompatible, extra: true } as unknown as DisplayFact
        : incompatible
      const before = snapshotStoreDirectory(fixture.storeDirectory)
      const result = fixture.editor.acceptDisplayFact(input)
      expect(result).toMatchObject({ status: 'rejected', input })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
      expect(fixture.displayFactCalls).toHaveLength(0)
    },
  )

  it.each(['cross-field conflict', 'duplicate exact', 'orphan owner'] as const)(
    'fails closed when the durable C28 owner is %s',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
      const { fact } = establishDisplayFactOwner(fixture)
      const rows = readLedgerRecords(fixture.editingInputLedgerPath)
      const displayIndex = rows.findIndex(record => record.event === 'display_fact_accepted')
      expect(displayIndex).toBeGreaterThanOrEqual(0)
      if (displayIndex < 0) throw new Error('C28 owner row was not durable')
      const owner = rows[displayIndex]
      if (owner === undefined || typeof owner.fact !== 'object' || owner.fact === null || Array.isArray(owner.fact)) {
        throw new Error('C28 owner row has no fact object')
      }
      if (variant === 'duplicate exact') {
        rows.push(structuredClone(owner))
      } else if (variant === 'cross-field conflict') {
        const ownerFact = owner.fact as Record<string, unknown>
        const receipt = ownerFact.receipt as Record<string, unknown>
        const disposition = ownerFact.disposition as Record<string, unknown>
        rows[displayIndex] = {
          ...owner,
          fact: {
            ...ownerFact,
            receipt: { ...receipt, result: 'Failed' },
            disposition: { ...disposition, value: 'NotDeliveredThisPeriod' },
          },
        }
      } else {
        const ownerFact = owner.fact as Record<string, unknown>
        rows[displayIndex] = {
          ...owner,
          fact: {
            ...ownerFact,
            receipt: { ...(ownerFact.receipt as Record<string, unknown>), object: 'orphan-object' },
          },
        }
      }
      rewriteLedger(fixture.editingInputLedgerPath, rows)
      const afterCorruption = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
    },
  )

  it.each(['formal_content_delivery_accepted', 'formal_content_delivery_receipt_accepted', 'candidate_disposition_accepted', 'source_disposition_state_accepted'] as const)(
    'does not let a missing C19/C21/C17/C18 parent hide an existing C28 owner (%s)',
    async event => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
      const { fact } = establishDisplayFactOwner(fixture)
      const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
      rewriteLedger(fixture.periodBusinessLedgerPath, rows.filter(record => record.event !== event))
      const afterCorruption = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
    },
  )

  it('fails C28 on editor-owner read I/O without changing any store bytes', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const { fact } = establishDisplayFactOwner(fixture)
    rmSync(fixture.editingInputLedgerPath, { force: true })
    mkdirSync(fixture.editingInputLedgerPath)
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('fails before C28 owner append without changing any store bytes', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const { fact } = establishDisplayFactOwner(fixture)
    const rows = readLedgerRecords(fixture.editingInputLedgerPath)
    rewriteLedger(fixture.editingInputLedgerPath, rows.filter(record => record.event !== 'display_fact_accepted'))
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce(() => {
      throw new Error('C28 append failed before write')
    })
    expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('accepts C28 when the first owner append is durable but acknowledgement is lost', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const { fact } = establishDisplayFactOwner(fixture)
    const rows = readLedgerRecords(fixture.editingInputLedgerPath)
    rewriteLedger(fixture.editingInputLedgerPath, rows.filter(record => record.event !== 'display_fact_accepted'))
    const append = durableJsonlStore.appendJsonLine
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce((path, records, record) => {
      append(path, records, record)
      throw new Error('C28 append completed before acknowledgement was lost')
    })
    expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'accepted', value: { fact } })
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toEqual({ status: 'accepted', value: { fact } })
    expect(readLedgerRecords(fixture.editingInputLedgerPath).filter(record => record.event === 'display_fact_accepted')).toHaveLength(1)
  })

  it('fails all editor shared writers when the C28 owner row is malformed', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const { fact } = establishDisplayFactOwner(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted')
    if (closure.status !== 'accepted') throw new Error('C37 replay did not return the closure')
    const rawInput = editorConclusionInput(fixture, closure.value)
    const rows = readLedgerRecords(fixture.editingInputLedgerPath)
    const displayIndex = rows.findIndex(record => record.event === 'display_fact_accepted')
    expect(displayIndex).toBeGreaterThanOrEqual(0)
    if (displayIndex < 0) throw new Error('C28 owner row was not durable')
    rows[displayIndex] = { schemaVersion: 1, event: 'display_fact_accepted', fact: { malformed: true } }
    rewriteLedger(fixture.editingInputLedgerPath, rows)
    const afterCorruption = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltEditor = fixture.rebuildEditor()
    expect(rebuiltEditor.acceptEditingInputClosure(editingClosure(fixture))).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
    expect(rebuiltEditor.formRawFeedContentConclusion(rawInput)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
    expect(rebuiltEditor.acceptDisplayFact(fact)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
  })

  it.each(['extra top-level', 'missing fact', 'wrong schema', 'wrong event'] as const)(
    'fails an exact C28 owner schema mutation (%s) without changing bytes',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
      const { fact } = establishDisplayFactOwner(fixture)
      const rows = readLedgerRecords(fixture.editingInputLedgerPath)
      const index = rows.findIndex(record => record.event === 'display_fact_accepted')
      expect(index).toBeGreaterThanOrEqual(0)
      if (index < 0) throw new Error('C28 owner row was not durable')
      const row = rows[index]
      if (row === undefined) throw new Error('C28 owner row disappeared')
      if (variant === 'extra top-level') rows[index] = { ...row, unexpected: true }
      if (variant === 'missing fact') {
        const { fact: _fact, ...withoutFact } = row
        rows[index] = withoutFact
      }
      if (variant === 'wrong schema') rows[index] = { ...row, schemaVersion: 2 }
      if (variant === 'wrong event') rows[index] = { ...row, event: 'display_fact_corrupt' }
      rewriteLedger(fixture.editingInputLedgerPath, rows)
      const afterMutation = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterMutation)
    },
  )

  it.each(['candidate disposition cross-field', 'source state cross-field', 'candidate disposition malformed', 'source state malformed'] as const)(
    'fails when a real C17/C18 parent row is corrupted (%s)',
    async variant => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
      const { fact } = establishDisplayFactOwner(fixture)
      const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
      const targetEvent = variant.startsWith('candidate') ? 'candidate_disposition_accepted' : 'source_disposition_state_accepted'
      const index = rows.findIndex(record => record.event === targetEvent)
      expect(index).toBeGreaterThanOrEqual(0)
      if (index < 0) throw new Error(`missing ${targetEvent} row`)
      const row = rows[index]
      if (row === undefined) throw new Error('parent row disappeared')
      if (variant === 'candidate disposition cross-field') {
        const disposition = row.disposition as Record<string, unknown>
        rows[index] = { ...row, accepted: { disposition: { ...disposition, value: 'NotDeliveredThisPeriod' } } }
      } else if (variant === 'source state cross-field') {
        const state = row.state as Record<string, unknown>
        rows[index] = { ...row, state: { ...state, candidate: { ...(state.candidate as Record<string, unknown>), candidate: 'wrong-candidate' } } }
      } else if (variant === 'candidate disposition malformed') {
        rows[index] = { ...row, accepted: { disposition: 'malformed' } }
      } else {
        rows[index] = { ...row, state: { state: 'Displayed' } }
      }
      rewriteLedger(fixture.periodBusinessLedgerPath, rows)
      const afterMutation = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildEditor().acceptDisplayFact(fact)).toMatchObject({ status: 'failed', input: fact })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterMutation)
    },
  )

  it('allows two distinct real formal objects and periods in one editing owner ledger', async () => {
    const firstFixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true })
    const secondFixture = await createFixture({ useRealDeliveryAndReceipt: true, omitDisplayFactReceiver: true, periodSuffix: 'second-c28' })
    const first = establishDisplayFactOwner(firstFixture)
    const second = establishDisplayFactOwner(secondFixture)
    expect(first.fact.receipt.object).not.toBe(second.fact.receipt.object)
    expect(first.fact.period).not.toEqual(second.fact.period)

    appendFileSync(firstFixture.editingInputLedgerPath, readFileSync(secondFixture.editingInputLedgerPath))
    appendFileSync(firstFixture.periodBusinessLedgerPath, readFileSync(secondFixture.periodBusinessLedgerPath))
    const editor = firstFixture.rebuildEditor()
    expect(editor.acceptDisplayFact(first.fact)).toEqual({ status: 'accepted', value: { fact: first.fact } })
    expect(editor.acceptDisplayFact(second.fact)).toEqual({ status: 'accepted', value: { fact: second.fact } })
    expect(readLedgerRecords(firstFixture.editingInputLedgerPath).filter(record => record.event === 'display_fact_accepted')).toHaveLength(2)
    const afterBoth = snapshotStoreDirectory(firstFixture.storeDirectory)
    expect(firstFixture.rebuildEditor().acceptDisplayFact(first.fact)).toEqual({ status: 'accepted', value: { fact: first.fact } })
    expect(firstFixture.rebuildEditor().acceptDisplayFact(second.fact)).toEqual({ status: 'accepted', value: { fact: second.fact } })
    expect(snapshotStoreDirectory(firstFixture.storeDirectory)).toEqual(afterBoth)
  })

  it('repairs only the missing second selected C28 owner after a partial display receiver failure', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      omitDisplayFactReceiver: false,
      blockedDisplayCandidateIndex: 1,
    })
    establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted')
    if (closure.status !== 'accepted') throw new Error('C37 did not accept two selected candidates')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value, [
      { kind: 'selected', candidate: fixture.candidates[0].candidate },
      { kind: 'selected', candidate: fixture.candidates[1].candidate },
    ]))
    expect(raw.status).toBe('accepted')
    if (raw.status !== 'accepted') throw new Error('Raw did not accept two selected candidates')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted')
    if (formal.status !== 'accepted') throw new Error('C15 did not accept two selected candidates')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
    const selected = ordinaryDeliveryObject(request).selected.candidates
    expect(selected).toHaveLength(2)
    if (selected.length !== 2) throw new Error('C21 did not retain two selected candidates')
    const dispositions = fixture.candidateDispositionAcceptedCalls.filter(value => value.disposition.value === 'Shown')
    expect(dispositions).toHaveLength(2)
    const states = dispositions.map(disposition => ({
      period: request.object.period,
      candidate: disposition.disposition.candidate,
      state: 'Displayed' as const,
      sourceCompletion: disposition,
    }))
    expect(fixture.finalizer.acceptSourceDispositionState(states[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptSourceDispositionState(states[1])).toMatchObject({ status: 'accepted' })
    const countOwners = (): number => readLedgerRecords(fixture.editingInputLedgerPath).filter(record => record.event === 'display_fact_accepted').length
    expect(countOwners()).toBe(1)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    const afterPartial = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[1])).toMatchObject({ status: 'accepted' })
    expect(countOwners()).toBe(1)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterPartial)
    fixture.allowDisplayFact()
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[1])).toMatchObject({ status: 'accepted' })
    expect(countOwners()).toBe(2)
    const afterRepair = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[0])).toMatchObject({ status: 'accepted' })
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[1])).toMatchObject({ status: 'accepted' })
    expect(countOwners()).toBe(2)
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.businessFinalizationCalls[0]).toEqual({ kind: 'ordinary_content_finalized', period: request.object.period })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterRepair)
    const editingRows = readLedgerRecords(fixture.editingInputLedgerPath)
    rewriteLedger(fixture.editingInputLedgerPath, editingRows.filter(row => {
      if (row.event !== 'display_fact_accepted') return true
      return !sameCandidateReference(row.fact.candidate as SourceCandidateReference, states[1].candidate)
    }))
    const beforeMissingOwnerReplay = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(states[0])).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeMissingOwnerReplay)
  })

  it.each(['accepted', 'rejected', 'failed', 'throw', 'wrong'] as const)(
    'publishes C23 only after all mixed C18/C28 gates, preserving C18/C28 on %s receiver outcome',
    async receiverOutcome => {
      const fixture = await createFixture({
        useRealDeliveryAndReceipt: true,
        businessFinalizationResult: receiverOutcome,
      })
      const { request, receipt, selectedState } = establishCompleteMixedDeliveryGates(fixture)
      expect(fixture.displayFactCalls).toHaveLength(1)
      expect(fixture.businessFinalizationCalls).toHaveLength(1)
      expect(fixture.businessFinalizationCalls[0]).toEqual({
        kind: 'ordinary_content_finalized',
        period: request.object.period,
      })
      expect(fixture.businessFinalizationCalls[0]?.period).toEqual(receipt.period)
      expect(fixture.businessFinalizationCalls[0]?.kind).toBe('ordinary_content_finalized')
      const finalizationRows = readLedgerLines(fixture.periodBusinessLedgerPath)
        .filter(line => line.includes('ordinary_content_finalized'))
      expect(finalizationRows).toHaveLength(receiverOutcome === 'accepted' ? 1 : 0)
      expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'accepted' })
      expect(fixture.businessFinalizationCalls).toHaveLength(receiverOutcome === 'accepted' ? 1 : 2)
      expect(fixture.displayFactCalls).toHaveLength(1)
      expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => line.includes('ordinary_content_finalized')))
        .toHaveLength(receiverOutcome === 'accepted' ? 1 : 0)
    },
  )

  it('explicitly repairs the receiver-first C23 crash gap and proves the PF projection is durable', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      businessFinalizationResult: 'accepted',
    })
    const append = durableJsonlStore.appendJsonLine
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementation(
      (path, records, record) => {
        if ((record as { readonly event?: unknown }).event === 'business_finalization_accepted') {
          throw new Error('controlled receiver-first C23 crash gap')
        }
        append(path, records, record)
      },
    )
    const { request } = establishCompleteMixedDeliveryGates(fixture)
    const finalization: BusinessFinalization = {
      kind: 'ordinary_content_finalized',
      period: request.object.period,
    }
    expect(fixture.businessFinalizationCalls).toEqual([finalization])
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toEqual([finalization])
    expect(readLedgerLines(fixture.periodBusinessLedgerPath)
      .filter(line => line.includes('business_finalization_accepted'))).toHaveLength(0)
    appendSpy.mockRestore()
    const finalizer = fixture.rebuildFinalizer()
    const appendAfterWriteSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce(
      (path, records, record) => {
        append(path, records, record)
        throw new Error('controlled C23 acknowledgement loss')
      },
    )

    const repaired = finalizer.ensureBusinessFinalization(finalization)

    expect(repaired).toEqual({ status: 'accepted', value: { period: request.object.period } })
    expect(appendAfterWriteSpy).toHaveBeenCalledOnce()
    expect(fixture.businessFinalizationCalls).toEqual([finalization, finalization])
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toEqual([finalization])
    expect(readLedgerLines(fixture.periodBusinessLedgerPath)
      .filter(line => line.includes('business_finalization_accepted'))).toHaveLength(1)
    appendAfterWriteSpy.mockRestore()
    const afterRepair = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().ensureBusinessFinalization(finalization)).toEqual(repaired)
    expect(fixture.businessFinalizationCalls).toEqual([finalization, finalization, finalization])
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toEqual([finalization])
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterRepair)
  })

  it('rejects invalid or premature explicit C23 input without invoking its receiver or writing a fact', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      businessFinalizationResult: 'accepted',
    })
    const inputs = [
      { kind: 'ordinary_content_finalized', period: fixture.period, extra: true },
      { kind: 'ordinary_content_finalized' },
      { kind: 'normal_empty_period_finalized', period: fixture.period },
      { kind: 'ordinary_content_finalized', period: fixture.period },
    ] as const
    const before = snapshotStoreDirectory(fixture.storeDirectory)

    for (const input of inputs) {
      expect(fixture.finalizer.ensureBusinessFinalization(input as unknown as BusinessFinalization))
        .toEqual({ status: 'rejected', input })
    }

    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(0)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it.each([
    ['rejected', 'rejected'],
    ['failed', 'failed'],
    ['throw', 'failed'],
    ['wrong', 'rejected'],
  ] as const)(
    'keeps explicit C23 retryable when its receiver returns %s',
    async (receiverOutcome, expectedStatus) => {
      const fixture = await createFixture({
        useRealDeliveryAndReceipt: true,
        omitDisplayFactReceiver: true,
        businessFinalizationResult: receiverOutcome,
      })
      const { request, receipt } = establishCompleteMixedDeliveryGates(fixture)
      const fact = displayFactFor(request, receipt, 'Shown')
      expect(fixture.editor.acceptDisplayFact(fact)).toEqual({ status: 'accepted', value: { fact } })
      expect(fixture.businessFinalizationCalls).toHaveLength(0)
      const before = snapshotStoreDirectory(fixture.storeDirectory)
      const finalization: BusinessFinalization = {
        kind: 'ordinary_content_finalized',
        period: request.object.period,
      }

      expect(fixture.rebuildFinalizer().ensureBusinessFinalization(finalization))
        .toEqual({ status: expectedStatus, input: finalization })

      expect(fixture.businessFinalizationCalls).toEqual([finalization])
      expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(0)
      expect(readLedgerLines(fixture.periodBusinessLedgerPath)
        .filter(line => line.includes('business_finalization_accepted'))).toHaveLength(0)
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
    },
  )

  it('fails explicit C23 replay closed when the durable PF projection is corrupt', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      businessFinalizationResult: 'accepted',
    })
    const { request } = establishCompleteMixedDeliveryGates(fixture)
    const records = readLedgerRecords(fixture.periodBusinessLedgerPath)
    const index = records.findIndex(record => record.event === 'business_finalization_accepted')
    expect(index).toBeGreaterThanOrEqual(0)
    const record = records[index]
    if (record === undefined) throw new Error('C23 fixture row is missing')
    records[index] = { ...record, unexpected: true }
    rewriteLedger(fixture.periodBusinessLedgerPath, records)
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const finalization: BusinessFinalization = {
      kind: 'ordinary_content_finalized',
      period: request.object.period,
    }

    expect(fixture.rebuildFinalizer().ensureBusinessFinalization(finalization))
      .toEqual({ status: 'failed', input: finalization })

    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toEqual([finalization])
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('keeps C23 at zero when a mixed period is missing selected C18', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(deliveryReceipt(request, 'Delivered'))).toMatchObject({ status: 'accepted' })
    const notSelected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'ReviewedNotSelected')
    expect(notSelected).toBeDefined()
    if (notSelected === undefined) throw new Error('NotSelected disposition was not established')
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: notSelected.disposition.candidate,
      state: 'Suppressed',
      sourceCompletion: notSelected,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
  })

  it('keeps C23 at zero when selected C18 exists but the selected C28 owner is missing', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, displayFactReceiverResult: 'rejected' })
    const { request } = establishCompleteMixedDeliveryGates(fixture)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    expect(fixture.displayFactCalls).toHaveLength(1)
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: request.object.period,
      candidate: fixture.candidates[0].candidate,
      state: 'Displayed',
      sourceCompletion: fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'Shown') as DispositionBasisAccepted,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
  })

  it('replays C18 to repair C28 and then attempts exactly one C23 without new input', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, displayFactReceiverResult: 'rejected' })
    const { request } = establishCompleteMixedDeliveryGates(fixture)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    fixture.allowDisplayFact()
    const selected = fixture.candidateDispositionAcceptedCalls.find(value =>
      value.disposition.value === 'Shown' && sameCandidateReference(value.disposition.candidate, fixture.candidates[0].candidate),
    )
    expect(selected).toBeDefined()
    if (selected === undefined) throw new Error('selected disposition was not established')
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState({
      period: request.object.period,
      candidate: selected.disposition.candidate,
      state: 'Displayed',
      sourceCompletion: selected,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.displayFactCalls).toHaveLength(2)
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
  })

  it('keeps C23 retryable when its append fails before writing after all C18/C28 owners exist', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      omitDisplayFactReceiver: true,
      businessFinalizationResult: 'accepted',
    })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
    const notSelected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'ReviewedNotSelected')
    const selected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'Shown')
    expect(notSelected).toBeDefined()
    expect(selected).toBeDefined()
    if (notSelected === undefined || selected === undefined) throw new Error('C21 did not establish both dispositions')
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: notSelected.disposition.candidate,
      state: 'Suppressed',
      sourceCompletion: notSelected,
    })).toMatchObject({ status: 'accepted' })
    const state = {
      period: fixture.period,
      candidate: selected.disposition.candidate,
      state: 'Displayed' as const,
      sourceCompletion: selected,
    }
    expect(fixture.finalizer.acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    const fact = displayFactFor(request, receipt, 'Shown')
    expect(fixture.editor.acceptDisplayFact(fact)).toMatchObject({ status: 'accepted' })
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const beforeNonC23BusinessRows = readLedgerLines(fixture.periodBusinessLedgerPath)
      .filter(line => !line.includes('ordinary_content_finalized'))
    const beforeEditingBytes = readFileSync(fixture.editingInputLedgerPath)
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce(() => {
      throw new Error('C23 append failed before write')
    })
    const firstAttempt = fixture.rebuildFinalizer().acceptSourceDispositionState(state)
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(firstAttempt).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => line.includes('ordinary_content_finalized'))).toHaveLength(0)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => !line.includes('ordinary_content_finalized')))
      .toEqual(beforeNonC23BusinessRows)
    expect(readFileSync(fixture.editingInputLedgerPath)).toEqual(beforeEditingBytes)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)

    appendSpy.mockRestore()
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(2)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => line.includes('ordinary_content_finalized'))).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => !line.includes('ordinary_content_finalized')))
      .toEqual(beforeNonC23BusinessRows)
    expect(readFileSync(fixture.editingInputLedgerPath)).toEqual(beforeEditingBytes)

    const afterSuccess = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(2)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => line.includes('ordinary_content_finalized'))).toHaveLength(1)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterSuccess)
  })

  it('reads back a C23 row after append acknowledgement is lost and does not repeat the receiver', async () => {
    const fixture = await createFixture({
      useRealDeliveryAndReceipt: true,
      omitDisplayFactReceiver: true,
      businessFinalizationResult: 'accepted',
    })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
    const notSelected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'ReviewedNotSelected')
    const selected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'Shown')
    expect(notSelected).toBeDefined()
    expect(selected).toBeDefined()
    if (notSelected === undefined || selected === undefined) throw new Error('C21 did not establish both dispositions')
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: notSelected.disposition.candidate,
      state: 'Suppressed',
      sourceCompletion: notSelected,
    })).toMatchObject({ status: 'accepted' })
    const state = {
      period: fixture.period,
      candidate: selected.disposition.candidate,
      state: 'Displayed' as const,
      sourceCompletion: selected,
    }
    expect(fixture.finalizer.acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    const fact = displayFactFor(request, receipt, 'Shown')
    expect(fixture.editor.acceptDisplayFact(fact)).toMatchObject({ status: 'accepted' })
    const append = durableJsonlStore.appendJsonLine
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce((path, records, record) => {
      append(path, records, record)
      throw new Error('C23 append completed before acknowledgement was lost')
    })
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(1)
    const afterAppend = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.businessFinalizationReceiverAcceptedFacts).toHaveLength(1)
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterAppend)
  })

  it('does not persist C23 finalization when its receiver rejects after all ordinary gates', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, businessFinalizationResult: 'rejected' })
    const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    const c19 = fixture.finalizer.requestFormalContentDelivery(request)
    expect(c19).toMatchObject({ status: 'accepted', value: { request } })
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    const receipt = deliveryReceipt(request, 'Delivered')
    const c21 = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
    expect(c21).toMatchObject({ status: 'accepted', value: { period: request.object.period, receipt } })
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    const notSelected = fixture.candidateDispositionAcceptedCalls.find(
      value => value.disposition.value === 'ReviewedNotSelected'
        && sameCandidateReference(value.disposition.candidate, fixture.candidates[1].candidate),
    )
    expect(notSelected).toBeDefined()
    if (notSelected === undefined) throw new Error('C15 did not request NotSelected through the receiver')
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: fixture.candidates[1].candidate,
      state: 'Suppressed',
      sourceCompletion: notSelected,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.businessFinalizationCalls).toHaveLength(0)
    const selected = fixture.candidateDispositionAcceptedCalls.find(
      value => value.disposition.value === 'Shown'
        && sameCandidateReference(value.disposition.candidate, fixture.candidates[0].candidate),
    )
    expect(selected).toBeDefined()
    if (selected === undefined) throw new Error('C21 did not request selected disposition through the receiver')
    expect(fixture.finalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: fixture.candidates[0].candidate,
      state: 'Displayed',
      sourceCompletion: selected,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.displayFactCalls).toHaveLength(1)
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
    expect(fixture.displayFactCalls[0]).toMatchObject({
      period: fixture.period,
      candidate: fixture.candidates[0].candidate,
      disposition: { period: fixture.period, candidate: fixture.candidates[0].candidate, value: 'Shown' },
      receipt,
    })
    expect(fixture.businessFinalizationCalls[0]).toEqual({
      kind: 'ordinary_content_finalized',
      period: fixture.period,
    })
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).some(line => line.includes('ordinary_content_finalized'))).toBe(false)

    const afterRejectedFinalization = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltFinalizer = fixture.rebuildFinalizer()
    expect(rebuiltFinalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({
      status: 'accepted', value: { period: fixture.period, receipt },
    })
    expect(rebuiltFinalizer.requestSourceDisposition(notSelected.disposition)).toMatchObject({ status: 'accepted' })
    expect(rebuiltFinalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: notSelected.disposition.candidate,
      state: 'Suppressed',
      sourceCompletion: notSelected,
    })).toMatchObject({ status: 'accepted' })
    expect(rebuiltFinalizer.requestSourceDisposition(selected.disposition)).toMatchObject({ status: 'accepted' })
    expect(rebuiltFinalizer.acceptSourceDispositionState({
      period: fixture.period,
      candidate: selected.disposition.candidate,
      state: 'Displayed',
      sourceCompletion: selected,
    })).toMatchObject({ status: 'accepted' })
    expect(fixture.rebuildEditor().acceptDisplayFact(fixture.displayFactCalls[0])).toMatchObject({
      status: 'accepted', value: { fact: fixture.displayFactCalls[0] },
    })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterRejectedFinalization)
  })

  it.each(['duplicate', 'conflict', 'orphan', 'extra', 'accepted-mismatch'] as const)(
    'fails closed when existing C23 is %s instead of trusting early replay',
    async corruption => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const { selectedState } = establishCompleteMixedDeliveryGates(fixture)
      const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
      const index = rows.findIndex(row => row.event === 'business_finalization_accepted')
      expect(index).toBeGreaterThanOrEqual(0)
      if (index < 0) throw new Error('C23 durable row was not established')
      const row = rows[index]
      if (row === undefined) throw new Error('C23 durable row disappeared')
      if (corruption === 'duplicate') {
        appendFileSync(fixture.periodBusinessLedgerPath, `${JSON.stringify(row)}\n`)
      } else if (corruption === 'conflict') {
        rows[index] = {
          ...row,
          finalization: { kind: 'normal_empty_period_finalized', period: fixture.period },
          accepted: { period: fixture.period },
        }
        rewriteLedger(fixture.periodBusinessLedgerPath, rows)
      } else if (corruption === 'orphan') {
        rows[index] = {
          ...row,
          finalization: { kind: 'ordinary_content_finalized', period: { ...fixture.period, period: 'orphan-c23-period' } },
          accepted: { period: { ...fixture.period, period: 'orphan-c23-period' } },
        }
        rewriteLedger(fixture.periodBusinessLedgerPath, rows)
      } else if (corruption === 'extra') {
        rows[index] = { ...row, unexpected: 'corrupt C23 key' }
        rewriteLedger(fixture.periodBusinessLedgerPath, rows)
      } else {
        rows[index] = {
          ...row,
          accepted: { period: { ...fixture.period, period: 'accepted-period-mismatch' } },
        }
        rewriteLedger(fixture.periodBusinessLedgerPath, rows)
      }
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      const replay = fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)
      expect(replay.status).not.toBe('accepted')
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it.each(['c19', 'c21', 'c17', 'c18'] as const)(
    'fails closed when an existing C23 loses its %s parent gate',
    async missing => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const { selectedState } = establishCompleteMixedDeliveryGates(fixture)
      const businessRows = readLedgerRecords(fixture.periodBusinessLedgerPath)
      rewriteLedger(fixture.periodBusinessLedgerPath, businessRows.filter(row => {
        if (missing === 'c19') return row.event !== 'formal_content_delivery_accepted'
        if (missing === 'c21') return row.event !== 'formal_content_delivery_receipt_accepted'
        if (missing === 'c17') {
          return row.event !== 'candidate_disposition_accepted'
            || !sameCandidateReference(row.disposition.candidate as SourceCandidateReference, fixture.candidates[1].candidate)
        }
        return row.event !== 'source_disposition_state_accepted'
      }))
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      const replay = fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)
      expect(replay.status).not.toBe('accepted')
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it('makes every existing period-business writer fail closed on a corrupt real C23 row', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const { request, receipt, selectedState } = establishCompleteMixedDeliveryGates(fixture)
    const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
    const index = rows.findIndex(row => row.event === 'business_finalization_accepted')
    const formal = rows.find(row => row.event === 'formal_editing_conclusion_accepted')
    const selected = fixture.candidateDispositionAcceptedCalls.find(value => value.disposition.value === 'Shown')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(formal).toBeDefined()
    expect(selected).toBeDefined()
    if (index < 0 || formal === undefined || selected === undefined) throw new Error('complete C23 facts were not established')
    const row = rows[index]
    if (row === undefined) throw new Error('C23 row disappeared')
    rows[index] = {
      ...row,
      accepted: { period: { ...fixture.period, period: 'corrupt-c23-period' } },
    }
    rewriteLedger(fixture.periodBusinessLedgerPath, rows)
    const raw = formal.raw as Parameters<Todo05Finalizer['acceptEditingConclusion']>[0]
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptEditingConclusion(raw)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().requestSourceDisposition(selected.disposition)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(fixture.rebuildFinalizer().acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('rejects a real PF C19 row that diverges from the durable C15 formal object', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const { request, selectedState } = establishCompleteMixedDeliveryGates(fixture)
    const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
    const index = rows.findIndex(row => row.event === 'formal_content_delivery_accepted')
    expect(index).toBeGreaterThanOrEqual(0)
    if (index < 0) throw new Error('C19 durable row was not established')
    const row = rows[index]
    if (row === undefined) throw new Error('C19 durable row disappeared')
    const divergentRequest = {
      object: { ...request.object, content: { body: 'C15/C19 divergent body' } },
    }
    rows[index] = { ...row, request: divergentRequest, accepted: { request: divergentRequest } }
    rewriteLedger(fixture.periodBusinessLedgerPath, rows)
    const ownerRows = readLedgerRecords(fixture.deliveryLedgerPath)
    const owner = ownerRows[0]
    expect(owner).toBeDefined()
    if (owner === undefined) throw new Error('DeliveryAndReceipt owner was not established')
    rewriteLedger(fixture.deliveryLedgerPath, [{ ...owner, request: divergentRequest }])
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it.each(['missing', 'malformed', 'duplicate'] as const)(
    'rejects a real C19 owner when DeliveryAndReceipt is %s',
    async corruption => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
      const ownerRows = readLedgerRecords(fixture.deliveryLedgerPath)
      if (corruption === 'missing') {
        rewriteLedger(fixture.deliveryLedgerPath, [])
      } else if (corruption === 'malformed') {
        const owner = ownerRows[0]
        expect(owner).toBeDefined()
        if (owner === undefined) throw new Error('delivery owner was not established')
        const divergentRequest = { object: { ...request.object, content: { body: 'corrupt delivery owner' } } }
        rewriteLedger(fixture.deliveryLedgerPath, [{ ...owner, request: divergentRequest }])
      } else {
        expect(ownerRows[0]).toBeDefined()
        appendFileSync(fixture.deliveryLedgerPath, `${JSON.stringify(ownerRows[0])}\n`)
      }
      const before = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
    },
  )

  it.each(['missing', 'malformed', 'duplicate'] as const)(
    'does not trust an existing C23 when its DeliveryAndReceipt owner is %s',
    async corruption => {
      const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
      const { selectedState } = establishCompleteMixedDeliveryGates(fixture)
      const ownerRows = readLedgerRecords(fixture.deliveryLedgerPath)
      if (corruption === 'missing') {
        rewriteLedger(fixture.deliveryLedgerPath, [])
      } else if (corruption === 'malformed') {
        const owner = ownerRows[0]
        expect(owner).toBeDefined()
        if (owner === undefined) throw new Error('delivery owner was not established')
        const request = owner.request as Record<string, unknown>
        const object = request.object as Record<string, unknown>
        const divergentRequest = { object: { ...object, content: { body: 'existing C23 owner mismatch' } } }
        rewriteLedger(fixture.deliveryLedgerPath, [{ ...owner, request: divergentRequest }])
      } else {
        expect(ownerRows[0]).toBeDefined()
        appendFileSync(fixture.deliveryLedgerPath, `${JSON.stringify(ownerRows[0])}\n`)
      }
      const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'failed' })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    },
  )

  it('does not trust an existing C23 when the real C37 closure diverges from C15', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const { selectedState } = establishCompleteMixedDeliveryGates(fixture)
    const rows = readLedgerRecords(fixture.periodBusinessLedgerPath)
    const index = rows.findIndex(row => row.event === 'editing_input_closure_accepted')
    expect(index).toBeGreaterThanOrEqual(0)
    if (index < 0) throw new Error('C37 durable row was not established')
    const row = rows[index]
    if (row === undefined) throw new Error('C37 durable row disappeared')
    rows[index] = { ...row, closure: { ...row.closure, candidatesInJudgment: [] } }
    rewriteLedger(fixture.periodBusinessLedgerPath, rows)
    const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
  })

  it('does not trust a C15 row whose durable Raw adds an outsider decision outside the real editor ledger', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true })
    const { selectedState } = establishCompleteMixedDeliveryGates(fixture)
    const businessRows = readLedgerRecords(fixture.periodBusinessLedgerPath)
    const formalIndex = businessRows.findIndex(row => row.event === 'formal_editing_conclusion_accepted')
    expect(formalIndex).toBeGreaterThanOrEqual(0)
    if (formalIndex < 0) throw new Error('C15 durable row was not established')
    const formalRow = businessRows[formalIndex]
    if (formalRow === undefined) throw new Error('C15 durable row disappeared')
    const originalRaw = formalRow.raw as RawFeedContentConclusion
    const originalFormal = formalRow.formal as FormalFeedContentConclusion
    const outsider: SourceCandidateReference = {
      source: sourceIdentity('todo05-outsider-source'),
      candidate: candidateIdentity('todo05-outsider-candidate'),
      stableReference: sourceStableReference('todo05:outsider'),
    }
    const alteredDecisions = {
      ...originalRaw.decisions,
      candidatesInJudgment: [...originalRaw.decisions.candidatesInJudgment, outsider],
      decisions: [
        ...originalRaw.decisions.decisions,
        { kind: 'not_selected' as const, candidate: outsider, semanticReason: 'Outside the sealed C37 scope.' },
      ],
    }
    const alteredRawInput: RawFeedContentInput = {
      closure: originalRaw.closure,
      content: originalRaw.content,
      decisions: alteredDecisions,
    }
    const alteredConclusion = rawFeedContentConclusionIdentityFor(alteredRawInput)
    expect(alteredConclusion).toBeDefined()
    if (alteredConclusion === undefined) throw new Error('altered Raw identity was not formed')
    const alteredObject = formalFeedContentObjectIdentityFor(alteredConclusion)
    const alteredRaw: RawFeedContentConclusion = {
      ...originalRaw,
      conclusion: alteredConclusion,
      decisions: alteredDecisions,
    }
    const alteredFormal: FormalFeedContentConclusion = {
      ...originalFormal,
      original: alteredConclusion,
      content: {
        ...originalFormal.content,
        object: alteredObject,
        original: alteredConclusion,
      },
      decisions: alteredDecisions,
    }
    businessRows[formalIndex] = { ...formalRow, raw: alteredRaw, formal: alteredFormal }
    const alteredRequest: FormalFeedContentDeliveryRequest = { object: alteredFormal.content }
    for (let index = 0; index < businessRows.length; index += 1) {
      const row = businessRows[index]
      if (row === undefined) continue
      if (row.event === 'formal_content_delivery_accepted') {
        businessRows[index] = { ...row, request: alteredRequest, accepted: { request: alteredRequest } }
      } else if (row.event === 'formal_content_delivery_receipt_accepted') {
        const receipt = { ...row.receipt, object: alteredObject }
        businessRows[index] = { ...row, receipt, accepted: { period: receipt.period, receipt } }
      }
    }
    rewriteLedger(fixture.periodBusinessLedgerPath, businessRows)

    const ownerRows = readLedgerRecords(fixture.deliveryLedgerPath)
    expect(ownerRows).toHaveLength(1)
    const owner = ownerRows[0]
    if (owner === undefined) throw new Error('DeliveryAndReceipt owner was not established')
    rewriteLedger(fixture.deliveryLedgerPath, [{ ...owner, request: alteredRequest }])

    const editingRows = readLedgerRecords(fixture.editingInputLedgerPath)
    rewriteLedger(fixture.editingInputLedgerPath, editingRows.map(row => {
      if (row.event !== 'display_fact_accepted') return row
      return { ...row, fact: { ...row.fact, receipt: { ...row.fact.receipt, object: alteredObject } } }
    }))

    const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildFinalizer().acceptSourceDispositionState(selectedState)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
  })

  it('keeps two real legal periods independently C23-finalized and replay-idempotent', async () => {
    const first = await createFixture({ useRealDeliveryAndReceipt: true })
    const second = await createFixture({ useRealDeliveryAndReceipt: true, periodSuffix: 'second-c23' })
    const firstGates = establishCompleteMixedDeliveryGates(first)
    const secondGates = establishCompleteMixedDeliveryGates(second)
    for (const name of ['candidate-period-facts.jsonl', 'editing-inputs.jsonl', 'period-business.jsonl', 'delivery-and-receipt.jsonl']) {
      appendFileSync(join(first.storeDirectory, name), readFileSync(join(second.storeDirectory, name)))
    }
    expect(first.rebuildFinalizer().acceptSourceDispositionState(firstGates.selectedState)).toMatchObject({ status: 'accepted' })
    expect(first.rebuildFinalizer().acceptSourceDispositionState(secondGates.selectedState)).toMatchObject({ status: 'accepted' })
    expect(readLedgerRecords(join(first.storeDirectory, 'period-business.jsonl')).filter(row => row.event === 'business_finalization_accepted')).toHaveLength(2)
    const afterReplay = snapshotStoreDirectory(first.storeDirectory)
    expect(first.rebuildFinalizer().acceptSourceDispositionState(firstGates.selectedState)).toMatchObject({ status: 'accepted' })
    expect(first.rebuildFinalizer().acceptSourceDispositionState(secondGates.selectedState)).toMatchObject({ status: 'accepted' })
    expect(snapshotStoreDirectory(first.storeDirectory)).toEqual(afterReplay)
  })

  it('keeps full real candidate tuple distinctions through the C23 chain', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true, nulTupleCandidates: true })
    establishEditingPrerequisites(fixture)
    const closure = fixture.finalizer.establishEditingInputClosure(editingClosure(fixture))
    expect(closure.status).toBe('accepted')
    if (closure.status !== 'accepted') throw new Error('C37 did not accept distinct NUL-bearing tuples')
    const raw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, closure.value, [
      { kind: 'selected', candidate: fixture.candidates[0].candidate },
      { kind: 'selected', candidate: fixture.candidates[1].candidate },
    ]))
    expect(raw.status).toBe('accepted')
    if (raw.status !== 'accepted') throw new Error('Raw did not accept distinct NUL-bearing tuples')
    const formal = fixture.finalizer.acceptEditingConclusion(raw.value)
    expect(formal.status).toBe('accepted')
    if (formal.status !== 'accepted') throw new Error('C15 did not accept distinct NUL-bearing tuples')
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(formal.value).content }
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const receipt = deliveryReceipt(request, 'Delivered')
    expect(fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toMatchObject({ status: 'accepted' })
    const selected = fixture.candidateDispositionAcceptedCalls.filter(value => value.disposition.value === 'Shown')
    expect(selected).toHaveLength(2)
    const selectedStates = selected.map(disposition => ({
      period: fixture.period,
      candidate: disposition.disposition.candidate,
      state: 'Displayed' as const,
      sourceCompletion: disposition,
    }))
    for (const state of selectedStates) {
      expect(fixture.finalizer.acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    }
    const businessRecords = readLedgerRecords(fixture.periodBusinessLedgerPath)
    expect(businessRecords.filter(row => row.event === 'formal_content_delivery_accepted')).toHaveLength(1)
    expect(businessRecords.filter(row => row.event === 'formal_content_delivery_receipt_accepted')).toHaveLength(1)
    expect(businessRecords.filter(row => row.event === 'business_finalization_accepted')).toHaveLength(1)
    expect(businessRecords.filter(row => row.event === 'candidate_disposition_accepted')).toHaveLength(3)
    expect(businessRecords.filter(row => row.event === 'source_disposition_state_accepted')).toHaveLength(3)
    expect(readLedgerRecords(fixture.editingInputLedgerPath).filter(row => row.event === 'display_fact_accepted')).toHaveLength(2)
    const beforeReplay = snapshotStoreDirectory(fixture.storeDirectory)
    for (const state of selectedStates) {
      expect(fixture.rebuildFinalizer().acceptSourceDispositionState(state)).toMatchObject({ status: 'accepted' })
    }
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeReplay)
    expect(fixture.businessFinalizationCalls).toHaveLength(1)
  })

  it('rebuilds C37/C15/C17/C18/C19 from durable facts without duplicate receiver calls', async () => {
    const fixture = await createFixture(); establishEditingPrerequisites(fixture)
    const closure = editingClosure(fixture)
    const firstClosure = fixture.finalizer.establishEditingInputClosure(closure)
    expect(firstClosure.status).toBe('accepted'); if (firstClosure.status !== 'accepted') throw new Error('C37 did not accept')
    expect(fixture.editingInputClosureCalls).toEqual([closure])
    const rebuiltEditor = fixture.rebuildEditor(); const rebuiltFinalizer = fixture.rebuildFinalizer()
    expect(rebuiltFinalizer.establishEditingInputClosure(closure)).toEqual(firstClosure)
    expect(fixture.editingInputClosureCalls).toEqual([closure])
    expect(rebuiltFinalizer.establishEditingInputClosure(editingClosure(fixture, [fixture.candidates[0].candidate, fixture.candidates[2].candidate]))).toMatchObject({ status: 'rejected' })
    const initialRaw = fixture.editor.formRawFeedContentConclusion(editorConclusionInput(fixture, firstClosure.value))
    expect(initialRaw.status).toBe('accepted'); if (initialRaw.status !== 'accepted') throw new Error('Raw did not accept')
    expect(rebuiltEditor.formRawFeedContentConclusion(editorConclusionInput(fixture, firstClosure.value))).toEqual(initialRaw)
    const firstFormal = fixture.finalizer.acceptEditingConclusion(initialRaw.value)
    expect(firstFormal.status).toBe('accepted'); if (firstFormal.status !== 'accepted') throw new Error('C15 did not accept')
    expect(rebuiltFinalizer.acceptEditingConclusion(initialRaw.value)).toEqual(firstFormal)
    expect(rebuiltFinalizer.acceptEditingConclusion({ ...initialRaw.value, content: { body: 'conflicting raw content' } })).toMatchObject({ status: 'rejected' })
    const disposition = { period: fixture.period, source: fixture.candidates[1].candidate.source, candidate: fixture.candidates[1].candidate, value: 'ReviewedNotSelected' as const }
    const firstC17 = fixture.finalizer.requestSourceDisposition(disposition)
    expect(firstC17.status).toBe('accepted'); if (firstC17.status !== 'accepted') throw new Error('C17 did not accept')
    const calls = fixture.candidateDispositionCalls.length
    expect(rebuiltFinalizer.requestSourceDisposition(disposition)).toEqual(firstC17); expect(fixture.candidateDispositionCalls).toHaveLength(calls)
    expect(rebuiltFinalizer.requestSourceDisposition({ ...disposition, value: 'EditingFailed' })).toMatchObject({ status: 'rejected' })
    const state = { period: fixture.period, candidate: fixture.candidates[1].candidate, state: 'Suppressed' as const, sourceCompletion: firstC17.value }
    const firstC18 = fixture.finalizer.acceptSourceDispositionState(state)
    expect(firstC18).toMatchObject({ status: 'accepted' }); expect(rebuiltFinalizer.acceptSourceDispositionState(state)).toEqual(firstC18)
    expect(rebuiltFinalizer.acceptSourceDispositionState({ ...state, state: 'Displayed' })).toMatchObject({ status: 'rejected' })
    const request: FormalFeedContentDeliveryRequest = { object: ordinaryFormal(firstFormal.value).content }
    const firstC19 = fixture.finalizer.requestFormalContentDelivery(request)
    expect(firstC19).toMatchObject({ status: 'accepted' }); const deliveryCalls = fixture.formalContentDeliveryCalls.length
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toEqual(firstC19); expect(fixture.formalContentDeliveryCalls).toHaveLength(deliveryCalls)
    expect(rebuiltFinalizer.requestFormalContentDelivery({ object: { ...request.object, content: { body: 'conflicting delivery content' } } })).toMatchObject({ status: 'rejected' })
    expect(fixture.formalContentDeliveryCalls).toHaveLength(deliveryCalls)
  })

  it('makes an exact receiver replay idempotent without changing ledger bytes', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const first = fixture.deliveryAndReceipt.acceptFormalFeedContent(request)
    expect(first).toEqual({ status: 'accepted', value: { request } }); if (first.status !== 'accepted') throw new Error('initial receiver claim did not accept')
    const afterFirst = snapshotStoreDirectory(fixture.storeDirectory)
    const replay = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(request)
    expect(replay).toEqual(first)
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterFirst)
  })

  it.each(['content', 'period'] as const)('rejects same-object %s conflict without changing the first receiver fact', async variant => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const first = fixture.deliveryAndReceipt.acceptFormalFeedContent(request)
    expect(first.status).toBe('accepted'); if (first.status !== 'accepted') throw new Error('initial receiver claim did not accept')
    const ordinary = ordinaryDeliveryObject(request)
    const conflictObject = variant === 'content'
      ? { ...ordinary, content: { body: 'conflicting delivery content' } }
      : { ...ordinary, period: { ...ordinary.period, period: `${ordinary.period.period}-conflict` as typeof ordinary.period.period } }
    const beforeConflict = snapshotStoreDirectory(fixture.storeDirectory)
    const conflict = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent({ object: conflictObject })
    expect(conflict).toMatchObject({ status: 'rejected' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeConflict)
  })

  it('rebuilds receiver and finalizer across the receiver-before-PF crash gap without duplicate delivery rows', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const first = fixture.deliveryAndReceipt.acceptFormalFeedContent(request)
    expect(first.status).toBe('accepted'); if (first.status !== 'accepted') throw new Error('receiver did not establish the crash-gap fact')
    const rebuiltReceiver = fixture.rebuildDeliveryAndReceipt()
    expect(rebuiltReceiver.readFormalFeedContentDeliveryRequest(request.object.object)).toEqual(request)
    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(rebuiltReceiver)
    const c19 = rebuiltFinalizer.requestFormalContentDelivery(request)
    expect(c19).toMatchObject({ status: 'accepted', value: { request } })
    expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')).toHaveLength(1)
    const replayFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(fixture.rebuildDeliveryAndReceipt())
    expect(replayFinalizer.requestFormalContentDelivery(request)).toEqual(c19)
    expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(1)
    expect(readLedgerLines(fixture.periodBusinessLedgerPath).filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')).toHaveLength(1)
  })

  it('does not let an existing PF C19 fact hide a missing receiver owner fact', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true }); const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    rmSync(fixture.deliveryLedgerPath, { force: true })
    const afterOwnerRemoval = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(fixture.rebuildDeliveryAndReceipt())
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterOwnerRemoval)
  })

  it('does not let an existing PF C19 fact hide a conflicting receiver owner fact', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true }); const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const row = readDeliveryRecord(fixture.deliveryLedgerPath)
    const ordinary = ordinaryDeliveryObject(request)
    writeDeliveryRecord(fixture.deliveryLedgerPath, {
      ...row,
      request: { object: { ...ordinary, content: { body: 'conflicting owner content' } } },
    })
    const afterCorruption = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(fixture.rebuildDeliveryAndReceipt())
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
  })

  it('does not let an existing PF C19 fact hide a structurally damaged receiver owner fact', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true }); const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const row = readDeliveryRecord(fixture.deliveryLedgerPath)
    const ordinary = ordinaryDeliveryObject(request)
    writeDeliveryRecord(fixture.deliveryLedgerPath, {
      ...row,
      request: { object: { ...ordinary, selected: { candidates: [] } } },
    })
    const afterCorruption = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(fixture.rebuildDeliveryAndReceipt())
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterCorruption)
  })

  it('does not let an existing PF C19 fact hide duplicate physical receiver ownership', async () => {
    const fixture = await createFixture({ useRealDeliveryAndReceipt: true }); const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.finalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'accepted' })
    const firstLine = readLedgerLines(fixture.deliveryLedgerPath)[0]
    appendFileSync(fixture.deliveryLedgerPath, `${firstLine}\n`)
    const afterDuplicate = snapshotStoreDirectory(fixture.storeDirectory)
    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(fixture.rebuildDeliveryAndReceipt())
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterDuplicate)
  })

  it.each(['empty selected array', 'duplicate selected reference'] as const)(
    'rejects a malformed ordinary selected set (%s) without writing a receiver fact',
    async variant => {
      const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
      const ordinary = ordinaryDeliveryObject(request)
      const candidates = variant === 'empty selected array'
        ? []
        : [ordinary.selected.candidates[0], ordinary.selected.candidates[0]]
      const invalid = { object: { ...ordinary, selected: { candidates } } }
      const before = snapshotStoreDirectory(fixture.storeDirectory)
      expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(invalid)).toMatchObject({ status: 'failed' })
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
    },
  )

  it('accepts the shared empty FormalFeedContent shape only with selected:{}', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const ordinary = ordinaryDeliveryObject(request)
    const emptyRequest = { object: { ...ordinary, selected: {} } }
    const result = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(emptyRequest)
    expect(result).toMatchObject({ status: 'accepted', value: { request: emptyRequest } })
    expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(emptyRequest.object.object)).toEqual(emptyRequest)
    expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(1)
  })

  it('does not collapse real -0 and 0 request payloads into an exact replay', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const ordinary = ordinaryDeliveryObject(request)
    const minusZeroRequest = { object: { ...ordinary, content: { body: -0 } } }
    const zeroRequest = { object: { ...ordinary, content: { body: 0 } } }
    expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(minusZeroRequest)).toMatchObject({ status: 'accepted' })
    const beforeConflict = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(zeroRequest)).toMatchObject({ status: 'rejected' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeConflict)
  })

  it.each(['extra top-level', 'missing request', 'wrong nested request', 'wrong object identity'] as const)(
    'fails closed on a %s receiver row without changing store bytes',
    async variant => {
      const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
      expect(fixture.deliveryAndReceipt.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })
      const row = readDeliveryRecord(fixture.deliveryLedgerPath)
      const ordinary = ordinaryDeliveryObject(request)
      let mutated: Record<string, unknown>
      if (variant === 'extra top-level') {
        mutated = { ...row, unexpected: true }
      } else if (variant === 'missing request') {
        const { request: _request, ...withoutRequest } = row
        mutated = withoutRequest
      } else if (variant === 'wrong nested request') {
        mutated = { ...row, request: { object: { ...ordinary, selected: { candidates: [] } } } }
      } else {
        mutated = { ...row, request: { object: { ...ordinary, object: 'forged-object-identity' } } }
      }
      writeDeliveryRecord(fixture.deliveryLedgerPath, mutated)
      const afterMutation = snapshotStoreDirectory(fixture.storeDirectory)
      const receiver = fixture.rebuildDeliveryAndReceipt()
      expect(receiver.acceptFormalFeedContent(request)).toMatchObject({ status: 'failed' })
      expect(receiver.readFormalFeedContentDeliveryRequest(request.object.object)).toBeUndefined()
      expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterMutation)
    },
  )

  it('rejects an exact duplicate physical receiver row as owner corruption', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    expect(fixture.deliveryAndReceipt.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })
    const firstLine = readLedgerLines(fixture.deliveryLedgerPath)[0]
    appendFileSync(fixture.deliveryLedgerPath, `${firstLine}\n`)
    const afterDuplicate = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(afterDuplicate)
  })

  it.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['Date', new Date('2026-08-24T00:00:00.000Z')],
    ['sparse array', Object.assign([], { length: 1 })],
    ['cyclic object', (() => { const value: Record<string, unknown> = {}; value.self = value; return value })()],
    ['accessor object', (() => { const value: Record<string, unknown> = {}; Object.defineProperty(value, 'value', { enumerable: true, get: () => 1 }); return value })()],
  ] as const)('fails closed without writing for unsupported canonical JSON %s', async (_name, body) => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const ordinary = ordinaryDeliveryObject(request)
    const invalid = { object: { ...ordinary, content: { body } } }
    expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(invalid)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('fails closed when the receiver ledger path is unreadable and leaves file bytes unchanged', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    rmSync(fixture.deliveryLedgerPath, { force: true })
    mkdirSync(fixture.deliveryLedgerPath)
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    expect(fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(request)).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
  })

  it('accepts an exact first receiver row when append reports an after-write exception', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const append = durableJsonlStore.appendJsonLine
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementation((path, records, record) => {
      append(path, records, record)
      throw new Error('append completed before acknowledgement was lost')
    })
    const result = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(request)
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'accepted', value: { request } })
    expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(1)
    expect(fixture.rebuildDeliveryAndReceipt().readFormalFeedContentDeliveryRequest(request.object.object)).toEqual(request)
  })

  it('fails before append without changing any store bytes when append throws before writing', async () => {
    const fixture = await createFixture(); const request = establishFormalDeliveryRequest(fixture)
    const before = snapshotStoreDirectory(fixture.storeDirectory)
    const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementationOnce(() => {
      throw new Error('append failed before write')
    })
    const result = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(request)
    expect(appendSpy).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'failed' })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(before)
    expect(readdirSync(fixture.storeDirectory)).not.toContain('delivery-and-receipt.jsonl')
  })

  it('does not confuse distinct full candidate references whose delimiter strings collide', async () => {
    const fixture = await createFixture()
    const request = establishFormalDeliveryRequest(fixture)
    const object = ordinaryDeliveryObject(request)
    const [reference] = object.selected.candidates
    const first = {
      ...reference,
      source: 'source-a',
      candidate: 'candidate-b\0candidate-c',
      stableReference: 'stable-d',
    } as typeof reference
    const second = {
      ...reference,
      source: 'source-a\0candidate-b',
      candidate: 'candidate-c',
      stableReference: 'stable-d',
    } as typeof reference
    const collisionRequest: FormalFeedContentDeliveryRequest = {
      object: { ...object, selected: { candidates: [first, second] } },
    }
    const result = fixture.rebuildDeliveryAndReceipt().acceptFormalFeedContent(collisionRequest)
    expect(result).toMatchObject({ status: 'accepted', value: { request: collisionRequest } })
    expect(readLedgerLines(fixture.deliveryLedgerPath)).toHaveLength(1)
  })

  it('allows two distinct real C15 objects to share one delivery ledger and replay independently', async () => {
    const firstFixture = await createFixture()
    const secondFixture = await createFixture({ periodSuffix: 'second' })
    const firstRequest = establishFormalDeliveryRequest(firstFixture)
    const secondRequest = establishFormalDeliveryRequest(secondFixture)
    expect(firstRequest.object.object).not.toBe(secondRequest.object.object)
    const sharedReceiver = firstFixture.rebuildDeliveryAndReceipt()
    const first = sharedReceiver.acceptFormalFeedContent(firstRequest)
    const second = sharedReceiver.acceptFormalFeedContent(secondRequest)
    expect(first).toMatchObject({ status: 'accepted', value: { request: firstRequest } })
    expect(second).toMatchObject({ status: 'accepted', value: { request: secondRequest } })
    expect(readLedgerLines(firstFixture.deliveryLedgerPath)).toHaveLength(2)
    expect(sharedReceiver.readFormalFeedContentDeliveryRequest(firstRequest.object.object)).toEqual(firstRequest)
    expect(sharedReceiver.readFormalFeedContentDeliveryRequest(secondRequest.object.object)).toEqual(secondRequest)
    const afterBoth = snapshotStoreDirectory(firstFixture.storeDirectory)
    expect(sharedReceiver.acceptFormalFeedContent(firstRequest)).toEqual(first)
    expect(sharedReceiver.acceptFormalFeedContent(secondRequest)).toEqual(second)
    expect(snapshotStoreDirectory(firstFixture.storeDirectory)).toEqual(afterBoth)
  })

  it('fails period recovery for two distinct real C15 owners in the same period', async () => {
    const firstFixture = await createFixture()
    const secondFixture = await createFixture({ nulTupleCandidates: true })
    const firstRequest = establishFormalDeliveryRequest(firstFixture)
    const secondRequest = establishFormalDeliveryRequest(secondFixture)
    expect(samePeriod(firstRequest.object.period, secondRequest.object.period)).toBe(true)
    expect(firstRequest.object.object).not.toBe(secondRequest.object.object)

    const sharedReceiver = firstFixture.rebuildDeliveryAndReceipt()
    expect(sharedReceiver.acceptFormalFeedContent(firstRequest)).toMatchObject({ status: 'accepted' })
    expect(sharedReceiver.acceptFormalFeedContent(secondRequest)).toMatchObject({ status: 'accepted' })
    const beforeRead = snapshotStoreDirectory(firstFixture.storeDirectory)
    const ownerRead = sharedReceiver.readFormalFeedContentDeliveryRequestForPeriod(firstFixture.period)

    expect.soft(ownerRead).toEqual({ status: 'failed', input: firstFixture.period })
    expect(snapshotStoreDirectory(firstFixture.storeDirectory)).toEqual(beforeRead)
  })

  it('recovers the one durable C19 request for an exact business period without caller object identity', async () => {
    const firstFixture = await createFixture()
    const secondFixture = await createFixture({ periodSuffix: 'period-reader-second' })
    const firstRequest = establishFormalDeliveryRequest(firstFixture)
    const secondRequest = establishFormalDeliveryRequest(secondFixture)
    const sharedReceiver = firstFixture.rebuildDeliveryAndReceipt()
    expect(sharedReceiver.acceptFormalFeedContent(firstRequest)).toMatchObject({ status: 'accepted' })
    expect(sharedReceiver.acceptFormalFeedContent(secondRequest)).toMatchObject({ status: 'accepted' })
    const afterBoth = snapshotStoreDirectory(firstFixture.storeDirectory)

    expect.soft(sharedReceiver.readFormalFeedContentDeliveryRequestForPeriod(firstFixture.period)).toEqual({
      status: 'found', value: { request: firstRequest },
    })
    const rebuiltReceiver = firstFixture.rebuildDeliveryAndReceipt()
    expect.soft(rebuiltReceiver.readFormalFeedContentDeliveryRequestForPeriod(secondFixture.period)).toEqual({
      status: 'found', value: { request: secondRequest },
    })
    const missingPeriod = {
      run: `${firstFixture.period.run}-missing` as typeof firstFixture.period.run,
      period: `${firstFixture.period.period}-missing` as typeof firstFixture.period.period,
    } as PeriodIdentity
    expect.soft(rebuiltReceiver.readFormalFeedContentDeliveryRequestForPeriod(missingPeriod)).toEqual({ status: 'missing' })
    expect.soft(rebuiltReceiver.readFormalFeedContentDeliveryRequestForPeriod(firstFixture.period)).toEqual({
      status: 'found', value: { request: firstRequest },
    })
    expect(snapshotStoreDirectory(firstFixture.storeDirectory)).toEqual(afterBoth)
  })

  it('fails period recovery when the real owner row is corrupted', async () => {
    const fixture = await createFixture()
    const request = establishFormalDeliveryRequest(fixture)
    const receiver = fixture.rebuildDeliveryAndReceipt()
    expect(receiver.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })
    const realRow = readLedgerLines(fixture.deliveryLedgerPath)[0]
    if (realRow === undefined) throw new Error('expected a real delivery owner row')
    writeFileSync(fixture.deliveryLedgerPath, `${realRow.slice(0, -1)}\n`, 'utf8')
    const beforeRead = snapshotStoreDirectory(fixture.storeDirectory)

    const ownerRead = receiver.readFormalFeedContentDeliveryRequestForPeriod(fixture.period)
    expect.soft(ownerRead).toEqual({ status: 'failed', input: fixture.period })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeRead)
  })

  it('fails period recovery on targeted owner read I/O without changing store bytes', async () => {
    const fixture = await createFixture()
    const request = establishFormalDeliveryRequest(fixture)
    const receiver = fixture.rebuildDeliveryAndReceipt()
    expect(receiver.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })
    rmSync(fixture.deliveryLedgerPath, { force: true })
    mkdirSync(fixture.deliveryLedgerPath)
    const beforeRead = snapshotStoreDirectory(fixture.storeDirectory)

    const ownerRead = receiver.readFormalFeedContentDeliveryRequestForPeriod(fixture.period)
    expect.soft(ownerRead).toEqual({ status: 'failed', input: fixture.period })
    expect(snapshotStoreDirectory(fixture.storeDirectory)).toEqual(beforeRead)
  })

  it('keeps owner recovery separate from PF C19 until the same finalizer replays', async () => {
    const fixture = await createFixture()
    const request = establishFormalDeliveryRequest(fixture)
    const owner = fixture.rebuildDeliveryAndReceipt()
    expect(owner.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })
    const c19Rows = (): readonly string[] => readLedgerLines(fixture.periodBusinessLedgerPath)
      .filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')
    expect(c19Rows()).toHaveLength(0)
    expect.soft(owner.readFormalFeedContentDeliveryRequestForPeriod(fixture.period)).toEqual({
      status: 'found', value: { request },
    })

    const rebuiltFinalizer = fixture.rebuildFinalizerWithDeliveryReceiver(owner)
    expect(rebuiltFinalizer.requestFormalContentDelivery(request)).toEqual({
      status: 'accepted', value: { request },
    })
    expect(c19Rows()).toHaveLength(1)
    expect.soft(owner.readFormalFeedContentDeliveryRequestForPeriod(fixture.period)).toEqual({
      status: 'found', value: { request },
    })
  })

  it('rejects a runtime-invalid period read while preserving the original input', async () => {
    const fixture = await createFixture()
    const request = establishFormalDeliveryRequest(fixture)
    const receiver = fixture.rebuildDeliveryAndReceipt()
    expect(receiver.acceptFormalFeedContent(request)).toMatchObject({ status: 'accepted' })

    const invalidPeriod = {
      ...fixture.period,
      unexpected: 'runtime-invalid',
    } as unknown as PeriodIdentity
    const ownerRead = receiver.readFormalFeedContentDeliveryRequestForPeriod(invalidPeriod)

    expect(ownerRead).toEqual({ status: 'rejected', input: invalidPeriod })
  })
})
