/**
 * TODO05 ordinary-feed editor contract bootstrap.
 *
 * This test reaches only the future package-private adapter seam. It does not
 * copy Personal Feed types, construct a parallel proposal contract, or test
 * editor behavior before the real module/factory exists.
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrdinaryFeedEditorAdapter,
  type OrdinaryFeedEditorAdapter,
  type OrdinaryFeedEditorAdapterOptions,
  type OrdinaryFeedEditorFinalizerPort,
  type OrdinaryFeedEditorInputPort,
  type OrdinaryFeedEditorResult,
} from '../src/personal-feed/ordinary-feed-editor-adapter.ts'
import type {
  ExternalPeriodScopeInput,
  FormalContentDeliveryReceiver,
  FormalFeedContentDeliveryAccepted,
  PeriodIdentity,
  PeriodReference,
  RunIdentity,
} from '@herman/personal-feed'
import {
  createCandidateMaterialProjection,
  createCrossSourceEditor,
  createCurrentContextProjection,
  createDeliveryAndReceipt,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  sourceIdentity,
} from '@herman/personal-feed'
import {
  createXSourceCandidateReportPorts,
  prepareAndSubmitXSourceCandidateReport,
  type XSourceCollectionEvidence,
  type XSourceCollectionItem,
} from '../src/x-cron/source-candidate-report.ts'
import { projectXAcceptedReportIntoEditingInputs } from '../src/x-cron/candidate-editing-input.ts'
import { createCandidateLocalState } from '../src/personal-feed/candidate-local-state.ts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type _OptionsKeys = Assert<Equal<keyof OrdinaryFeedEditorAdapterOptions, 'period' | 'editor' | 'finalizer'>>
type _EditorKeys = Assert<Equal<keyof OrdinaryFeedEditorInputPort, 'listAcceptedInputs' | 'formRawFeedContentConclusion'>>
type _FinalizerKeys = Assert<Equal<keyof OrdinaryFeedEditorFinalizerPort, 'establishEditingInputClosure' | 'acceptEditingConclusion' | 'requestFormalContentDelivery'>>
type _RuntimeKeys = Assert<Equal<keyof OrdinaryFeedEditorAdapter, 'acceptEditingProposal'>>
type _FactoryOptions = Assert<Equal<Parameters<typeof createOrdinaryFeedEditorAdapter>[0], OrdinaryFeedEditorAdapterOptions>>
type _FactoryRuntime = Assert<Equal<ReturnType<typeof createOrdinaryFeedEditorAdapter>, OrdinaryFeedEditorAdapter>>
type _Result = Assert<Equal<ReturnType<OrdinaryFeedEditorAdapter['acceptEditingProposal']>, OrdinaryFeedEditorResult>>
type _AcceptedValue = Assert<Equal<Extract<OrdinaryFeedEditorResult, { readonly status: 'accepted' }>['value'], FormalFeedContentDeliveryAccepted>>

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function readLedgerRecords(path: string): readonly Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const contents = readFileSync(path, 'utf8').trim()
  return contents === ''
    ? []
    : contents.split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function recordsForEvent(
  path: string,
  event: string,
): readonly Record<string, unknown>[] {
  return readLedgerRecords(path).filter(record => record.event === event)
}

function rewriteLedger(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, records.length === 0 ? '' : `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
}

function snapshotDirectory(
  directory: string,
  relativeDirectory = '',
): readonly { readonly path: string; readonly base64: string }[] {
  const current = join(directory, relativeDirectory)
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const relativePath = relativeDirectory === ''
        ? entry.name
        : join(relativeDirectory, entry.name)
      if (entry.isDirectory()) return snapshotDirectory(directory, relativePath)
      return [{ path: relativePath, base64: readFileSync(join(directory, relativePath)).toString('base64') }]
    })
}

function xItem(id: string, text: string, user: string): XSourceCollectionItem {
  return {
    id,
    url: `https://x.com/${user}/status/${id}`,
    text,
    time: '2026-08-24T00:00:00.000Z',
    user,
    media: [],
    ts: 1_755_961_200,
  }
}

function xEvidence(): XSourceCollectionEvidence {
  const collectionPath = '/tmp/todo05-x-editor-adapter/collection.jsonl'
  return {
    runId: 'todo05-x-editor-adapter',
    source: 'x',
    collectionPath,
    collectionBatch: collectionPath,
    deliveryId: 'delivery-adapter',
    ts: 1_755_961_200,
  }
}

function ordinaryProposal(): unknown {
  return {
    title: 'Ordinary target feed',
    sections: [{
      kind: 'highlight',
      items: [{ itemId: 'item:x-status:1001', summary: 'A target insight' }],
    }],
    decisions: [
      { itemId: 'item:x-status:1001', kind: 'selected' },
      {
        itemId: 'item:x-status:1002',
        kind: 'not_selected',
        semanticReason: 'Lower relevance for this period.',
      },
    ],
  }
}

function acceptedResultWithExtra<Result extends object>(result: Result): Result {
  return { ...result, extra: true } as Result
}

function acceptedResultWithCustomPrototype<Result extends object>(result: Result): Result {
  return Object.create({ hidden: true }, Object.getOwnPropertyDescriptors(result)) as Result
}

function acceptedResultWithSymbol<Result extends object>(result: Result): Result {
  const symbol = Symbol('hidden')
  return Object.assign({}, result, { [symbol]: true }) as Result
}

function acceptedResultWithNonEnumerable<Result extends object>(result: Result): Result {
  const copy = { ...result }
  Object.defineProperty(copy, 'hidden', { value: true })
  return copy
}

function acceptedResultWithValueAccessor<Result extends { readonly value: unknown }>(
  result: Result,
  accessed: () => void,
): Result {
  const copy = { ...result }
  Object.defineProperty(copy, 'value', {
    enumerable: true,
    configurable: true,
    get: () => {
      accessed()
      return result.value
    },
  })
  return copy
}

const stageFailureModes = ['rejected', 'failed', 'unknown', 'throw'] as const
type StageFailureMode = typeof stageFailureModes[number]

function stageFailure<Result>(mode: StageFailureMode, input: unknown): Result {
  if (mode === 'throw') throw new Error('controlled stage failure')
  return { status: mode, input } as Result
}

function expectedStageFailure(mode: StageFailureMode, input: unknown): OrdinaryFeedEditorResult {
  return { status: mode === 'throw' ? 'failed' : mode, input }
}

async function createRealC11AndC10Fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-editor-adapter-'))
  temporaryDirectories.push(directory)
  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(directory, 'period-business.jsonl')
  const currentContextInputLedgerPath = join(directory, 'current-context-inputs.jsonl')
  const candidateLocalStateLedgerPath = join(directory, 'candidate-local-state.jsonl')
  const deliveryAndReceiptLedgerPath = join(directory, 'delivery-and-receipt.jsonl')
  const source = sourceIdentity('x')
  const editor = createCrossSourceEditor({
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    periodScopeLedgerPath,
    currentContextInputLedgerPath,
  })
  const currentContextProjection = createCurrentContextProjection({
    resultProducer: {
      produceCurrentContextResult: scope => ({
        kind: 'unavailable',
        value: {
          scope,
          period: scope.period,
          unavailableFact: { kind: 'no_configured_authorized_context_source' },
        },
      }),
    },
    c11Receiver: editor,
  })
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source,
      mechanicalAdmission: createMechanicalAdmission(source),
      candidateMaterialProjection: createCandidateMaterialProjection(source),
    }],
    currentContextProjection,
  })
  const input: ExternalPeriodScopeInput = {
    requestIdentity: 'dsh-cron:todo05-editor-adapter',
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    runId: 'todo05-editor-adapter@2026-08-24T00:00:00.000Z',
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-24T00:05:00.000Z',
  }
  const established = await scopeService.establishExternalPeriodScope(input)
  const c11 = await currentContextProjection.completeCurrentContextForEstablishedScope(established.c33.value)
  expect(c11).toMatchObject({
    status: 'accepted',
    value: { kind: 'unavailable', value: { scope: established.c33.value, period: established.c01.value.period } },
  })

  const candidateLocalState = createCandidateLocalState({ ledgerPath: candidateLocalStateLedgerPath })
  const deliveryAndReceipt = createDeliveryAndReceipt({ ledgerPath: deliveryAndReceiptLedgerPath })
  const finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    now: () => '2026-08-24T00:02:00.000Z',
    editingInputClosureReceiver: editor,
    candidateDispositionReceiver: candidateLocalState.candidateDispositionReceiver,
    formalContentDeliveryReceiver: deliveryAndReceipt,
  })
  const currentCollection = [
    xItem('1001', 'A target text', 'alice'),
    xItem('1002', 'B target text', 'bob'),
  ]
  const acceptedReport = await prepareAndSubmitXSourceCandidateReport({
    period: established.c01.value.period,
    mechanicalAdmissionScope: established.c32[0]!.value,
    materialProjectionReportScope: established.c35[0]!.value,
    collectionEvidence: xEvidence(),
    currentCollection,
    candidatePort: createXSourceCandidateReportPorts(),
    reportPort: { submitSourceCandidateReport: report => finalizer.acceptSourceCandidateReport(report) },
  })
  const projected = await projectXAcceptedReportIntoEditingInputs({
    period: established.c01.value.period,
    collectionEvidence: xEvidence(),
    acceptedReport,
    currentCollection,
    periodFinalizer: finalizer,
    crossSourceEditor: editor,
  })
  return {
    directory,
    period: established.c01.value.period,
    editor,
    finalizer,
    candidateLocalState,
    deliveryAndReceipt,
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    candidateLocalStateLedgerPath,
    deliveryAndReceiptLedgerPath,
    projected,
  }
}

type RealAdapterFixture = Awaited<ReturnType<typeof createRealC11AndC10Fixture>>

function rebuildFinalizer(
  fixture: RealAdapterFixture,
  formalContentDeliveryReceiver: FormalContentDeliveryReceiver = fixture.deliveryAndReceipt,
) {
  return createPeriodBusinessFinalizer({
    periodScopeLedgerPath: fixture.periodScopeLedgerPath,
    reportLedgerPath: fixture.reportLedgerPath,
    candidatePeriodLedgerPath: fixture.candidatePeriodLedgerPath,
    editingInputLedgerPath: fixture.editingInputLedgerPath,
    periodBusinessLedgerPath: fixture.periodBusinessLedgerPath,
    now: () => '2026-08-24T00:02:00.000Z',
    editingInputClosureReceiver: fixture.editor,
    candidateDispositionReceiver: fixture.candidateLocalState.candidateDispositionReceiver,
    formalContentDeliveryReceiver,
  })
}

function expectCompleteAdapterFacts(fixture: RealAdapterFixture): void {
  expect(recordsForEvent(fixture.editingInputLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.candidateLocalStateLedgerPath, 'candidate_disposition_accepted')).toHaveLength(1)
  expect(recordsForEvent(fixture.deliveryAndReceiptLedgerPath, 'formal_feed_content_delivery_accepted')).toHaveLength(1)
}

function repairAndReplay(
  fixture: RealAdapterFixture,
  input: unknown,
): FormalFeedContentDeliveryAccepted {
  const repaired = createOrdinaryFeedEditorAdapter({
    period: fixture.period,
    editor: fixture.editor,
    finalizer: fixture.finalizer,
  }).acceptEditingProposal(input)
  expect(repaired.status).toBe('accepted')
  if (repaired.status !== 'accepted') throw new Error('adapter repair did not reach real C19')
  expectCompleteAdapterFacts(fixture)
  const beforeReplay = snapshotDirectory(fixture.directory)
  const replayed = createOrdinaryFeedEditorAdapter({
    period: fixture.period,
    editor: fixture.editor,
    finalizer: fixture.finalizer,
  }).acceptEditingProposal(input)
  expect(replayed).toEqual(repaired)
  expect(snapshotDirectory(fixture.directory)).toEqual(beforeReplay)
  return repaired.value
}

describe('TODO05 ordinary-feed editor adapter bootstrap', () => {
  it('builds C11 and two C10 inputs through the configured current-context and real X report seams', async () => {
    const fixture = await createRealC11AndC10Fixture()

    expect(fixture.projected).toHaveLength(2)
    expect(fixture.editor.listAcceptedInputs()).toEqual(fixture.projected.map(value => value.editingInput.material))
  })

  it('turns one complete X proposal into the real durable C19 request and replays it exactly', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const adapter = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer: fixture.finalizer,
    })

    const first = adapter.acceptEditingProposal(input)
    expect(first.status).toBe('accepted')
    if (first.status !== 'accepted') throw new Error('real ordinary Feed proposal was not accepted')
    expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(first.value.request.object.object))
      .toEqual(first.value.request)
    const notSelected = fixture.projected[1]!.candidate
    expect(fixture.candidateLocalState.readSourceDispositionState(fixture.period, notSelected)).toEqual({
      period: fixture.period,
      candidate: notSelected,
      state: 'Suppressed',
      sourceCompletion: {
        disposition: {
          period: fixture.period,
          source: notSelected.source,
          candidate: notSelected,
          value: 'ReviewedNotSelected',
        },
      },
    })

    const editorClosures = recordsForEvent(
      fixture.editingInputLedgerPath,
      'editing_input_closure_accepted',
    )
    const rawConclusions = recordsForEvent(
      fixture.editingInputLedgerPath,
      'raw_feed_content_conclusion_accepted',
    )
    const businessClosures = recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'editing_input_closure_accepted',
    )
    const formalConclusions = recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'formal_editing_conclusion_accepted',
    )
    const formalDeliveries = recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'formal_content_delivery_accepted',
    )
    const candidateDispositions = recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'candidate_disposition_accepted',
    )
    const deliveryOwners = recordsForEvent(
      fixture.deliveryAndReceiptLedgerPath,
      'formal_feed_content_delivery_accepted',
    )
    const candidateLocalOwners = recordsForEvent(
      fixture.candidateLocalStateLedgerPath,
      'candidate_disposition_accepted',
    )
    expect(editorClosures).toHaveLength(1)
    expect(rawConclusions).toHaveLength(1)
    expect(businessClosures).toHaveLength(1)
    expect(formalConclusions).toHaveLength(1)
    expect(formalDeliveries).toHaveLength(1)
    expect(candidateDispositions).toHaveLength(1)
    expect(deliveryOwners).toHaveLength(1)
    expect(candidateLocalOwners).toHaveLength(1)
    const expectedNotSelectedDisposition = {
      period: fixture.period,
      source: notSelected.source,
      candidate: notSelected,
      value: 'ReviewedNotSelected',
    }
    expect(candidateDispositions[0]?.disposition).toEqual(expectedNotSelectedDisposition)
    expect(candidateLocalOwners[0]).toMatchObject({
      disposition: expectedNotSelectedDisposition,
      state: { state: 'Suppressed' },
    })
    expect(businessClosures[0]?.closure).toEqual(editorClosures[0]?.closure)
    expect(formalConclusions[0]?.raw).toEqual(rawConclusions[0]?.conclusion)
    expect(formalDeliveries[0]?.request).toEqual(first.value.request)
    expect(deliveryOwners[0]?.request).toEqual(first.value.request)

    const beforeReplay = snapshotDirectory(fixture.directory)
    expect(beforeReplay.map(file => file.path)).toEqual([
      'candidate-local-state.jsonl',
      'candidate-period-facts.jsonl',
      'current-context-inputs.jsonl',
      'delivery-and-receipt.jsonl',
      'editing-inputs.jsonl',
      'period-business.jsonl',
      'period-scopes.jsonl',
      'source-candidate-reports.jsonl',
    ])

    const rebuiltAdapter = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer: fixture.finalizer,
    })
    expect(rebuiltAdapter.acceptEditingProposal(input)).toEqual(first)
    expect(snapshotDirectory(fixture.directory)).toEqual(beforeReplay)
  })

  it('does not advance past a C37 accepted envelope with extra data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: closure => {
        const accepted = fixture.finalizer.establishEditingInputClosure(closure)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C37 delegate was not accepted')
        expect(recordsForEvent(
          fixture.periodBusinessLedgerPath,
          'editing_input_closure_accepted',
        )).toHaveLength(1)
        return acceptedResultWithExtra(accepted)
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(formRaw).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
    expect('input' in result && result.input).toBe(input)
  })

  it('does not advance past a Raw accepted envelope with extra data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const acceptConclusion = vi.fn<OrdinaryFeedEditorFinalizerPort['acceptEditingConclusion']>(
      value => fixture.finalizer.acceptEditingConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: rawInput => {
        const accepted = fixture.editor.formRawFeedContentConclusion(rawInput)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real Raw delegate was not accepted')
        expect(recordsForEvent(
          fixture.editingInputLedgerPath,
          'raw_feed_content_conclusion_accepted',
        )).toHaveLength(1)
        return acceptedResultWithExtra(accepted)
      },
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: acceptConclusion,
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(acceptConclusion).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
    expect('input' in result && result.input).toBe(input)
  })

  it('does not advance past a C15 accepted envelope with extra data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const requestDelivery = vi.fn<OrdinaryFeedEditorFinalizerPort['requestFormalContentDelivery']>(
      value => fixture.finalizer.requestFormalContentDelivery(value),
    )
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => {
        const accepted = fixture.finalizer.acceptEditingConclusion(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C15 delegate was not accepted')
        expect(recordsForEvent(
          fixture.periodBusinessLedgerPath,
          'formal_editing_conclusion_accepted',
        )).toHaveLength(1)
        return acceptedResultWithExtra(accepted)
      },
      requestFormalContentDelivery: requestDelivery,
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(requestDelivery).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
    expect('input' in result && result.input).toBe(input)
  })

  it('does not accept a C19 accepted envelope with extra data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => {
        const accepted = fixture.finalizer.requestFormalContentDelivery(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C19 delegate was not accepted')
        expect(recordsForEvent(
          fixture.periodBusinessLedgerPath,
          'formal_content_delivery_accepted',
        )).toHaveLength(1)
        expect(recordsForEvent(
          fixture.deliveryAndReceiptLedgerPath,
          'formal_feed_content_delivery_accepted',
        )).toHaveLength(1)
        return acceptedResultWithExtra(accepted)
      },
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'rejected', input })
    expect('input' in result && result.input).toBe(input)
  })

  it('does not advance past a C37 accepted envelope with a custom prototype', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: closure => {
        const accepted = fixture.finalizer.establishEditingInputClosure(closure)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C37 delegate was not accepted')
        expect(recordsForEvent(
          fixture.periodBusinessLedgerPath,
          'editing_input_closure_accepted',
        )).toHaveLength(1)
        return acceptedResultWithCustomPrototype(accepted)
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(formRaw).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not advance past a Raw accepted envelope with symbol data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const acceptConclusion = vi.fn<OrdinaryFeedEditorFinalizerPort['acceptEditingConclusion']>(
      value => fixture.finalizer.acceptEditingConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: value => {
        const accepted = fixture.editor.formRawFeedContentConclusion(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real Raw delegate was not accepted')
        expect(recordsForEvent(
          fixture.editingInputLedgerPath,
          'raw_feed_content_conclusion_accepted',
        )).toHaveLength(1)
        return acceptedResultWithSymbol(accepted)
      },
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: acceptConclusion,
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(acceptConclusion).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not advance past a C15 accepted envelope with non-enumerable data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const requestDelivery = vi.fn<OrdinaryFeedEditorFinalizerPort['requestFormalContentDelivery']>(
      value => fixture.finalizer.requestFormalContentDelivery(value),
    )
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => {
        const accepted = fixture.finalizer.acceptEditingConclusion(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C15 delegate was not accepted')
        expect(recordsForEvent(
          fixture.periodBusinessLedgerPath,
          'formal_editing_conclusion_accepted',
        )).toHaveLength(1)
        return acceptedResultWithNonEnumerable(accepted)
      },
      requestFormalContentDelivery: requestDelivery,
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(requestDelivery).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not execute a C19 accepted value accessor', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const accessed = vi.fn()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => {
        const result = fixture.finalizer.requestFormalContentDelivery(value)
        if (result.status !== 'accepted') return result
        return acceptedResultWithValueAccessor(result, accessed)
      },
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(accessed).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not advance past a C37 accepted value with a custom prototype', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: closure => {
        const result = fixture.finalizer.establishEditingInputClosure(closure)
        if (result.status !== 'accepted') return result
        return {
          status: 'accepted',
          value: acceptedResultWithCustomPrototype(result.value),
        }
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(formRaw).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not advance past a Raw accepted value with symbol data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const acceptConclusion = vi.fn<OrdinaryFeedEditorFinalizerPort['acceptEditingConclusion']>(
      value => fixture.finalizer.acceptEditingConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: value => {
        const result = fixture.editor.formRawFeedContentConclusion(value)
        if (result.status !== 'accepted') return result
        return {
          status: 'accepted',
          value: acceptedResultWithSymbol(result.value),
        }
      },
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: acceptConclusion,
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(acceptConclusion).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not advance past a C15 accepted value with non-enumerable data', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const requestDelivery = vi.fn<OrdinaryFeedEditorFinalizerPort['requestFormalContentDelivery']>(
      value => fixture.finalizer.requestFormalContentDelivery(value),
    )
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => {
        const result = fixture.finalizer.acceptEditingConclusion(value)
        if (result.status !== 'accepted') return result
        return {
          status: 'accepted',
          value: acceptedResultWithNonEnumerable(result.value),
        }
      },
      requestFormalContentDelivery: requestDelivery,
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(requestDelivery).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('does not execute a C19 accepted request accessor', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const accessed = vi.fn()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => {
        const result = fixture.finalizer.requestFormalContentDelivery(value)
        if (result.status !== 'accepted') return result
        const accepted = { ...result.value }
        Object.defineProperty(accepted, 'request', {
          enumerable: true,
          configurable: true,
          get: () => {
            accessed()
            return result.value.request
          },
        })
        return { status: 'accepted', value: accepted }
      },
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(accessed).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'rejected', input })
  })

  it('fails closed without recursing forever when a real C37 accepted value becomes cyclic', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: closure => {
        const accepted = fixture.finalizer.establishEditingInputClosure(closure)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C37 delegate was not accepted')
        Object.defineProperty(closure, 'cycle', {
          enumerable: true,
          configurable: true,
          value: closure,
        })
        return accepted
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'rejected', input })
    expect(formRaw).not.toHaveBeenCalled()
    expect(recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'editing_input_closure_accepted',
    )).toHaveLength(1)
  })

  it('maps a throwing Proxy around a real C37 accepted value to failed', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: closure => {
        const accepted = fixture.finalizer.establishEditingInputClosure(closure)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C37 delegate was not accepted')
        return {
          status: 'accepted',
          value: new Proxy(accepted.value, {
            getPrototypeOf: () => {
              throw new Error('controlled accepted-value proxy failure')
            },
          }),
        }
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'failed', input })
    expect(formRaw).not.toHaveBeenCalled()
    expect(recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'editing_input_closure_accepted',
    )).toHaveLength(1)
  })

  it('accepts an acyclic Raw clone when equivalent candidate references no longer share identity', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: value => {
        const accepted = fixture.editor.formRawFeedContentConclusion(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real Raw delegate was not accepted')
        expect(accepted.value.closure.closure.candidatesInJudgment)
          .toBe(accepted.value.decisions.candidatesInJudgment)
        const clone = structuredClone(accepted.value)
        const clonedValue = {
          ...clone,
          decisions: {
            ...clone.decisions,
            candidatesInJudgment: structuredClone(clone.decisions.candidatesInJudgment),
          },
        }
        expect(clonedValue.closure.closure.candidatesInJudgment)
          .not.toBe(clonedValue.decisions.candidatesInJudgment)
        return { status: 'accepted', value: clonedValue }
      },
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer: fixture.finalizer,
    }).acceptEditingProposal(input)

    expect(result.status).toBe('accepted')
    expectCompleteAdapterFacts(fixture)
  })

  it('rejects a deep nested extra in a real C19 accepted value', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => {
        const accepted = fixture.finalizer.requestFormalContentDelivery(value)
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') throw new Error('real C19 delegate was not accepted')
        return {
          status: 'accepted',
          value: {
            request: {
              object: {
                ...accepted.value.request.object,
                content: {
                  ...accepted.value.request.object.content,
                  extra: true,
                },
              },
            },
          },
        }
      },
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'rejected', input })
    expect(recordsForEvent(
      fixture.periodBusinessLedgerPath,
      'formal_content_delivery_accepted',
    )).toHaveLength(1)
    expect(recordsForEvent(
      fixture.deliveryAndReceiptLedgerPath,
      'formal_feed_content_delivery_accepted',
    )).toHaveLength(1)
  })

  it.each(stageFailureModes)('stops before Raw when C37 returns %s', async mode => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => stageFailure(mode, value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(formRaw).not.toHaveBeenCalled()
    expect(result).toEqual(expectedStageFailure(mode, input))
    expect('input' in result && result.input).toBe(input)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'editing_input_closure_accepted')).toHaveLength(0)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(0)
  })

  it.each(stageFailureModes)('stops before C15 when Raw returns %s', async mode => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const acceptConclusion = vi.fn<OrdinaryFeedEditorFinalizerPort['acceptEditingConclusion']>(
      value => fixture.finalizer.acceptEditingConclusion(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: value => stageFailure(mode, value),
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: acceptConclusion,
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(acceptConclusion).not.toHaveBeenCalled()
    expect(result).toEqual(expectedStageFailure(mode, input))
    expect('input' in result && result.input).toBe(input)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(0)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(0)
  })

  it.each(stageFailureModes)('stops before C19 when C15 returns %s', async mode => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const requestDelivery = vi.fn<OrdinaryFeedEditorFinalizerPort['requestFormalContentDelivery']>(
      value => fixture.finalizer.requestFormalContentDelivery(value),
    )
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => stageFailure(mode, value),
      requestFormalContentDelivery: requestDelivery,
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(requestDelivery).not.toHaveBeenCalled()
    expect(result).toEqual(expectedStageFailure(mode, input))
    expect('input' in result && result.input).toBe(input)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(0)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toHaveLength(0)
  })

  it.each(stageFailureModes)('does not invent C19 when delivery returns %s', async mode => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => stageFailure(mode, value),
    }

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual(expectedStageFailure(mode, input))
    expect('input' in result && result.input).toBe(input)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toHaveLength(0)
    expect(recordsForEvent(fixture.deliveryAndReceiptLedgerPath, 'formal_feed_content_delivery_accepted')).toHaveLength(0)
  })

  it('repairs the same proposal after C37 became durable before its caller observed success', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => {
        const result = fixture.finalizer.establishEditingInputClosure(value)
        if (result.status === 'accepted') throw new Error('controlled post-C37 crash')
        return result
      },
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const first = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(first).toEqual({ status: 'failed', input })
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(0)
    repairAndReplay(fixture, input)
  })

  it('repairs the same proposal after Raw became durable before its caller observed success', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: () => fixture.editor.listAcceptedInputs(),
      formRawFeedContentConclusion: value => {
        const result = fixture.editor.formRawFeedContentConclusion(value)
        if (result.status === 'accepted') throw new Error('controlled post-Raw crash')
        return result
      },
    }

    const first = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer: fixture.finalizer,
    }).acceptEditingProposal(input)

    expect(first).toEqual({ status: 'failed', input })
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'editing_input_closure_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.editingInputLedgerPath, 'raw_feed_content_conclusion_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(0)
    repairAndReplay(fixture, input)
  })

  it('repairs the same proposal after C15 became durable before its caller observed success', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => {
        const result = fixture.finalizer.acceptEditingConclusion(value)
        if (result.status === 'accepted') throw new Error('controlled post-C15 crash')
        return result
      },
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }

    const first = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(first).toEqual({ status: 'failed', input })
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_editing_conclusion_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.candidateLocalStateLedgerPath, 'candidate_disposition_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toHaveLength(0)
    repairAndReplay(fixture, input)
  })

  it('replays the same C19 after both delivery owners became durable before success was observed', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: value => fixture.finalizer.establishEditingInputClosure(value),
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => {
        const result = fixture.finalizer.requestFormalContentDelivery(value)
        if (result.status === 'accepted') throw new Error('controlled post-C19 crash')
        return result
      },
    }

    const first = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(first).toEqual({ status: 'failed', input })
    expectCompleteAdapterFacts(fixture)
    repairAndReplay(fixture, input)
  })

  it('repairs C19 when DeliveryAndReceipt owned the request before the period ledger did', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const ownerOnlyReceiver = {
      acceptFormalFeedContent: vi.fn<FormalContentDeliveryReceiver['acceptFormalFeedContent']>(request => {
        const result = fixture.deliveryAndReceipt.acceptFormalFeedContent(request)
        return result.status === 'accepted' ? { status: 'failed', input: request } : result
      }),
      readFormalFeedContentDeliveryRequest: fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest,
    }
    const interruptedFinalizer = rebuildFinalizer(fixture, ownerOnlyReceiver)

    const first = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer: interruptedFinalizer,
    }).acceptEditingProposal(input)

    expect(first).toEqual({ status: 'failed', input })
    expect(ownerOnlyReceiver.acceptFormalFeedContent).toHaveBeenCalledTimes(1)
    expect(recordsForEvent(fixture.deliveryAndReceiptLedgerPath, 'formal_feed_content_delivery_accepted')).toHaveLength(1)
    expect(recordsForEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toHaveLength(0)

    const repairedFinalizer = rebuildFinalizer(fixture)
    const repaired = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer: repairedFinalizer,
    }).acceptEditingProposal(input)
    expect(repaired.status).toBe('accepted')
    expectCompleteAdapterFacts(fixture)
    const beforeReplay = snapshotDirectory(fixture.directory)
    expect(createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer: rebuildFinalizer(fixture),
    }).acceptEditingProposal(input)).toEqual(repaired)
    expect(snapshotDirectory(fixture.directory)).toEqual(beforeReplay)
  })

  it('rejects an invalid proposal without creating any business fact', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = {
      ...ordinaryProposal() as Record<string, unknown>,
      decisions: [{ itemId: 'item:x-status:1001', kind: 'selected' }],
    }
    const establishClosure = vi.fn<OrdinaryFeedEditorFinalizerPort['establishEditingInputClosure']>(
      value => fixture.finalizer.establishEditingInputClosure(value),
    )
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: establishClosure,
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }
    const before = snapshotDirectory(fixture.directory)

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor: fixture.editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'rejected', input })
    expect('input' in result && result.input).toBe(input)
    expect(establishClosure).not.toHaveBeenCalled()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails when the C10 owner cannot be read and does not call later ports', async () => {
    const fixture = await createRealC11AndC10Fixture()
    const input = ordinaryProposal()
    const listAcceptedInputs = vi.fn<OrdinaryFeedEditorInputPort['listAcceptedInputs']>(() => {
      throw new Error('controlled C10 owner failure')
    })
    const formRaw = vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(
      value => fixture.editor.formRawFeedContentConclusion(value),
    )
    const establishClosure = vi.fn<OrdinaryFeedEditorFinalizerPort['establishEditingInputClosure']>(
      value => fixture.finalizer.establishEditingInputClosure(value),
    )
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs,
      formRawFeedContentConclusion: formRaw,
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: establishClosure,
      acceptEditingConclusion: value => fixture.finalizer.acceptEditingConclusion(value),
      requestFormalContentDelivery: value => fixture.finalizer.requestFormalContentDelivery(value),
    }
    const before = snapshotDirectory(fixture.directory)

    const result = createOrdinaryFeedEditorAdapter({
      period: fixture.period,
      editor,
      finalizer,
    }).acceptEditingProposal(input)

    expect(result).toEqual({ status: 'failed', input })
    expect('input' in result && result.input).toBe(input)
    expect(listAcceptedInputs).toHaveBeenCalledTimes(1)
    expect(establishClosure).not.toHaveBeenCalled()
    expect(formRaw).not.toHaveBeenCalled()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it.each(['missing', 'malformed', 'duplicate'] as const)(
    'fails closed when an existing C19 DeliveryAndReceipt owner is %s',
    async corruption => {
      const fixture = await createRealC11AndC10Fixture()
      const input = ordinaryProposal()
      const accepted = createOrdinaryFeedEditorAdapter({
        period: fixture.period,
        editor: fixture.editor,
        finalizer: fixture.finalizer,
      }).acceptEditingProposal(input)
      expect(accepted.status).toBe('accepted')
      const owners = readLedgerRecords(fixture.deliveryAndReceiptLedgerPath)
      expect(owners).toHaveLength(1)
      const owner = owners[0]
      if (owner === undefined) throw new Error('C19 delivery owner was not formed')
      if (corruption === 'missing') {
        rewriteLedger(fixture.deliveryAndReceiptLedgerPath, [])
      } else if (corruption === 'malformed') {
        rewriteLedger(fixture.deliveryAndReceiptLedgerPath, [{ ...owner, extra: true }])
      } else {
        appendFileSync(fixture.deliveryAndReceiptLedgerPath, `${JSON.stringify(owner)}\n`)
      }
      const before = snapshotDirectory(fixture.directory)

      const replay = createOrdinaryFeedEditorAdapter({
        period: fixture.period,
        editor: fixture.editor,
        finalizer: rebuildFinalizer(fixture),
      }).acceptEditingProposal(input)

      expect(replay).toEqual({ status: 'failed', input })
      expect('input' in replay && replay.input).toBe(input)
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    },
  )

  it('exposes a frozen fail-closed runtime without calling injected Personal Feed ports', () => {
    const editor: OrdinaryFeedEditorInputPort = {
      listAcceptedInputs: vi.fn<OrdinaryFeedEditorInputPort['listAcceptedInputs']>(() => []),
      formRawFeedContentConclusion: vi.fn<OrdinaryFeedEditorInputPort['formRawFeedContentConclusion']>(),
    }
    const finalizer: OrdinaryFeedEditorFinalizerPort = {
      establishEditingInputClosure: vi.fn<OrdinaryFeedEditorFinalizerPort['establishEditingInputClosure']>(),
      acceptEditingConclusion: vi.fn<OrdinaryFeedEditorFinalizerPort['acceptEditingConclusion']>(),
      requestFormalContentDelivery: vi.fn<OrdinaryFeedEditorFinalizerPort['requestFormalContentDelivery']>(),
    }
    const period: PeriodIdentity = {
      run: 'todo05-ordinary-feed-editor-run' as RunIdentity,
      period: 'todo05-ordinary-feed-editor-period' as PeriodReference,
    }
    const runtime = createOrdinaryFeedEditorAdapter({ period, editor, finalizer })
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.keys(runtime)).toEqual(['acceptEditingProposal'])

    const input = Object.freeze({
      title: 'bootstrap proposal',
      sections: [],
      decisions: [],
    })
    const result = runtime.acceptEditingProposal(input)
    expect(result).toEqual({ status: 'failed', input })
    expect('input' in result).toBe(true)
    if (!('input' in result)) throw new Error('fail-closed editor result did not preserve its input')
    expect(result.input).toBe(input)
    expect(editor.listAcceptedInputs).toHaveBeenCalledOnce()
    expect(editor.formRawFeedContentConclusion).not.toHaveBeenCalled()
    expect(finalizer.establishEditingInputClosure).not.toHaveBeenCalled()
    expect(finalizer.acceptEditingConclusion).not.toHaveBeenCalled()
    expect(finalizer.requestFormalContentDelivery).not.toHaveBeenCalled()
  })
})
