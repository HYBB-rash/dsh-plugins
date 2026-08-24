import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExternalPeriodScopeInput,
  PeriodBusinessFinalizer,
  SourceCandidateReportFinalizer,
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
import { createCandidateLocalState } from '../../src/personal-feed/candidate-local-state.ts'
import { createOrdinaryBusinessFinalizationOwner } from '../../src/personal-feed/ordinary-business-finalization-owner.ts'
import { projectXAcceptedReportIntoEditingInputs } from '../../src/x-cron/candidate-editing-input.ts'
import {
  createXSourceCandidateReportPorts,
  prepareAndSubmitXSourceCandidateReport,
  type XSourceCollectionEvidence,
  type XSourceCollectionItem,
} from '../../src/x-cron/source-candidate-report.ts'

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
  const collectionPath = '/tmp/todo05-real-ordinary-feed/collection.jsonl'
  return {
    runId: 'todo05-real-ordinary-feed',
    source: 'x',
    collectionPath,
    collectionBatch: collectionPath,
    deliveryId: 'delivery-real-ordinary-feed',
    ts: 1_755_961_200,
  }
}

export function ordinaryFeedProposal(): unknown {
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

export async function createRealOrdinaryFeedFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-real-ordinary-'))
  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(directory, 'period-business.jsonl')
  const currentContextInputLedgerPath = join(directory, 'current-context-inputs.jsonl')
  const candidateLocalStateLedgerPath = join(directory, 'candidate-local-state.jsonl')
  const deliveryAndReceiptLedgerPath = join(directory, 'delivery-and-receipt.jsonl')
  const ordinaryBusinessFinalizationLedgerPath = join(directory, 'ordinary-business-finalizations.jsonl')
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
    requestIdentity: 'dsh-cron:todo05-real-ordinary-feed',
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    runId: 'todo05-real-ordinary-feed@2026-08-24T00:00:00.000Z',
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-24T00:05:00.000Z',
  }
  const established = await scopeService.establishExternalPeriodScope(input)
  const c11 = await currentContextProjection.completeCurrentContextForEstablishedScope(established.c33.value)
  if (c11.status !== 'accepted') throw new Error('real ordinary Feed fixture did not form C11')

  let finalizer: PeriodBusinessFinalizer & SourceCandidateReportFinalizer
  const completionPort = Object.freeze({
    requestSourceDisposition: (disposition: Parameters<PeriodBusinessFinalizer['requestSourceDisposition']>[0]) =>
      finalizer.requestSourceDisposition(disposition),
    acceptSourceDispositionState: (state: Parameters<PeriodBusinessFinalizer['acceptSourceDispositionState']>[0]) =>
      finalizer.acceptSourceDispositionState(state),
  })
  const createCandidateState = () => createCandidateLocalState({
    ledgerPath: candidateLocalStateLedgerPath,
    completionPort,
  })
  const candidateLocalState = createCandidateState()
  const deliveryAndReceipt = createDeliveryAndReceipt({ ledgerPath: deliveryAndReceiptLedgerPath })
  const createFinalizationOwner = () => createOrdinaryBusinessFinalizationOwner({
    ledgerPath: ordinaryBusinessFinalizationLedgerPath,
  })
  const finalizationOwner = createFinalizationOwner()
  const createFinalizer = (): PeriodBusinessFinalizer & SourceCandidateReportFinalizer => createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    now: () => '2026-08-24T00:02:00.000Z',
    editingInputClosureReceiver: editor,
    candidateDispositionReceiver: candidateLocalState.candidateDispositionReceiver,
    formalContentDeliveryReceiver: deliveryAndReceipt,
    displayFactReceiver: editor,
    businessFinalizationReceiver: finalizationOwner.receiver,
  })
  finalizer = createFinalizer()
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
  if (projected.length !== 2) throw new Error('real ordinary Feed fixture did not form two C10 inputs')

  return Object.freeze({
    directory,
    period: established.c01.value.period,
    editor,
    finalizer,
    deliveryAndReceipt,
    candidateLocalState,
    finalizationOwner,
    candidateLocalStateLedgerPath,
    deliveryAndReceiptLedgerPath,
    periodBusinessLedgerPath,
    editingInputLedgerPath,
    ordinaryBusinessFinalizationLedgerPath,
    rebuildFinalizer: () => {
      finalizer = createFinalizer()
      return finalizer
    },
    rebuildCandidateLocalState: createCandidateState,
    rebuildFinalizationOwner: createFinalizationOwner,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  })
}
