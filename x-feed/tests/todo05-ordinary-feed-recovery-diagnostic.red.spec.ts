import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  CronAgentEnvironmentPrepareContext,
  CronRunDeliveryMeaningRunPort,
} from '@deepseek-ai/dsh-cron'
import type {
  C19Result,
  C37Result,
  ContextEnabledCrossSourceEditor,
  PeriodBusinessFinalizer,
  PeriodIdentity,
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createXSourceCandidateReportPorts,
  prepareAndSubmitXSourceCandidateReport,
  type XSourceCollectionItem,
} from '../src/x-cron/source-candidate-report.ts'
import { projectXAcceptedReportIntoEditingInputs } from '../src/x-cron/candidate-editing-input.ts'
import { createCandidateLocalState } from '../src/personal-feed/candidate-local-state.ts'
import { createOrdinaryBusinessFinalizationOwner } from '../src/personal-feed/ordinary-business-finalization-owner.ts'
import { createOrdinaryFeedRunLifecycle } from '../src/personal-feed/ordinary-feed-run-lifecycle.ts'

const SUBMIT_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'
const FIXED_DIAGNOSTIC_MESSAGE = 'ordinary Feed recovery failed'
const VALID_PROPOSAL = {
  title: 'Diagnostic title',
  sections: [{ kind: 'highlight', items: [{ itemId: 'item:x-status:1001', summary: 'Diagnostic summary' }] }],
  decisions: [
    { itemId: 'item:x-status:1001', kind: 'selected' },
    { itemId: 'item:x-status:1002', kind: 'not_selected', semanticReason: 'Diagnostic reason' },
  ],
} as const

type WireMode = 'valid' | 'no-submission' | 'throw' | 'rejected-proposal'

class DiagnosticWireAdapter extends LlmAdapter {
  constructor(private readonly mode: WireMode) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.mode === 'throw') throw new Error('dynamic secret: model execution body')
    if (this.mode === 'no-submission') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const proposal = this.mode === 'rejected-proposal'
      ? { title: 'Rejected secret title', sections: [], decisions: [] }
      : VALID_PROPOSAL
    const argumentsText = JSON.stringify(proposal)
    const callId = CallId('todo05-diagnostic-proposal-1')
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta', index: 0, id: callId, name: SUBMIT_PROPOSAL, argumentsDelta: argumentsText,
    }
    yield {
      type: 'block-end', index: 0, block: {
        type: 'tool-call', id: callId, name: SUBMIT_PROPOSAL, arguments: argumentsText,
      },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

interface DiagnosticFixture {
  readonly directory: string
  readonly personalFeedDataDir: string
  readonly period: PeriodIdentity
  readonly editor: ContextEnabledCrossSourceEditor
  readonly finalizer: PeriodBusinessFinalizer
  readonly deliveryAndReceipt: ReturnType<typeof createDeliveryAndReceipt>
  readonly candidateLocalState: ReturnType<typeof createCandidateLocalState>
  readonly finalizationOwner: ReturnType<typeof createOrdinaryBusinessFinalizationOwner>
  readonly prepareContext: CronAgentEnvironmentPrepareContext
  readonly ctx: Context
}

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

async function createRealContext(mode: WireMode): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'todo05-diagnostic', model: 'todo05-diagnostic' })
  ctx.llm.registerAdapter(['todo05-diagnostic'], new DiagnosticWireAdapter(mode))
  contexts.push(ctx)
  return ctx
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

function runDeliveryMeaningPort(): CronRunDeliveryMeaningRunPort {
  return Object.freeze({
    bindPreparedDelivery: async () => ({ status: 'accepted' as const }),
    acceptDurableReceipt: async input => ({ status: 'accepted' as const, value: { receipt: input } }),
    commitBusinessFinalization: async () => ({ status: 'accepted' as const }),
  })
}

async function createFixture(mode: WireMode): Promise<DiagnosticFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-recovery-diagnostic-'))
  directories.push(directory)
  const personalFeedDataDir = join(directory, 'personal-feed')
  mkdirSync(personalFeedDataDir, { recursive: true })
  const periodScopeLedgerPath = join(personalFeedDataDir, 'period-scopes.jsonl')
  const reportLedgerPath = join(personalFeedDataDir, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(personalFeedDataDir, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(personalFeedDataDir, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(personalFeedDataDir, 'period-business.jsonl')
  const currentContextInputLedgerPath = join(personalFeedDataDir, 'current-context-inputs.jsonl')
  const candidateLocalStateLedgerPath = join(personalFeedDataDir, 'candidate-local-state.jsonl')
  const deliveryLedgerPath = join(personalFeedDataDir, 'delivery-and-receipt.jsonl')
  const finalizationLedgerPath = join(personalFeedDataDir, 'ordinary-business-finalizations.jsonl')
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
        value: { scope, period: scope.period, unavailableFact: { kind: 'diagnostic_fixture' } },
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
  const established = await scopeService.establishExternalPeriodScope({
    requestIdentity: 'todo05:diagnostic',
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    runId: 'todo05-diagnostic-run',
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-24T00:05:00.000Z',
  })
  const c11 = await currentContextProjection.completeCurrentContextForEstablishedScope(established.c33.value)
  expect(c11.status).toBe('accepted')
  const candidateLocalState = createCandidateLocalState({ ledgerPath: candidateLocalStateLedgerPath })
  const deliveryAndReceipt = createDeliveryAndReceipt({ ledgerPath: deliveryLedgerPath })
  const finalizationOwner = createOrdinaryBusinessFinalizationOwner({ ledgerPath: finalizationLedgerPath })
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
    displayFactReceiver: editor,
    businessFinalizationReceiver: finalizationOwner.receiver,
  })
  const currentCollection = [
    xItem('1001', 'Material one', 'alice'),
    xItem('1002', 'Material two', 'bob'),
  ]
  const acceptedReport = await prepareAndSubmitXSourceCandidateReport({
    period: established.c01.value.period,
    mechanicalAdmissionScope: established.c32[0]!.value,
    materialProjectionReportScope: established.c35[0]!.value,
    collectionEvidence: {
      runId: 'todo05-diagnostic-run', source: 'x', collectionPath: '/tmp/diagnostic-collection.jsonl',
      collectionBatch: '/tmp/diagnostic-collection.jsonl', deliveryId: 'diagnostic-delivery', ts: 1_755_961_200,
    },
    currentCollection,
    candidatePort: createXSourceCandidateReportPorts(),
    reportPort: { submitSourceCandidateReport: report => finalizer.acceptSourceCandidateReport(report) },
  })
  await projectXAcceptedReportIntoEditingInputs({
    period: established.c01.value.period,
    collectionEvidence: {
      runId: 'todo05-diagnostic-run', source: 'x', collectionPath: '/tmp/diagnostic-collection.jsonl',
      collectionBatch: '/tmp/diagnostic-collection.jsonl', deliveryId: 'diagnostic-delivery', ts: 1_755_961_200,
    },
    acceptedReport,
    currentCollection,
    periodFinalizer: finalizer,
    crossSourceEditor: editor,
  })
  return {
    directory,
    personalFeedDataDir,
    period: established.c01.value.period,
    editor,
    finalizer,
    deliveryAndReceipt,
    candidateLocalState,
    finalizationOwner,
    prepareContext: {
      jobId: 'todo05-diagnostic-job', jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden',
      runId: 'todo05-diagnostic-run', trigger: 'scheduled',
      scheduledFor: '2026-08-24T00:00:00.000Z', claimedAt: '2026-08-24T00:00:01.000Z',
      runDeliveryMeaningPort: runDeliveryMeaningPort(),
    },
    ctx: await createRealContext(mode),
  }
}

function lifecycleFor(
  fixture: DiagnosticFixture,
  editor: ContextEnabledCrossSourceEditor = fixture.editor,
  finalizer: PeriodBusinessFinalizer = fixture.finalizer,
) {
  return createOrdinaryFeedRunLifecycle({
    ctx: fixture.ctx,
    editor,
    finalizer,
    deliveryAndReceipt: fixture.deliveryAndReceipt,
    candidateLocalState: fixture.candidateLocalState,
    finalizationOwner: fixture.finalizationOwner,
  })
}

function prepareOrdinaryFeed(
  fixture: DiagnosticFixture,
  editor = fixture.editor,
  finalizer = fixture.finalizer,
): Promise<unknown> {
  return lifecycleFor(fixture, editor, finalizer).prepareOrdinaryFeed({
    period: fixture.period,
    context: fixture.prepareContext,
  })
}

function ledgerBytes(directory: string): Map<string, string> {
  const files = ['candidate-period-facts.jsonl', 'editing-inputs.jsonl', 'period-business.jsonl', 'delivery-and-receipt.jsonl', 'ordinary-business-finalizations.jsonl']
  return new Map(files.map(name => {
    const path = join(directory, 'personal-feed', name)
    try { return [name, readFileSync(path, 'utf8')] }
    catch { return [name, ''] }
  }))
}

function errorSurface(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const own = Reflect.ownKeys(error).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    const value = descriptor?.value
    try { return `${String(key)}:${JSON.stringify(value)}` }
    catch { return `${String(key)}:${String(value)}` }
  })
  let json = ''
  try { json = JSON.stringify(error) }
  catch { json = String(error) }
  return [String(error), json, ...own].join('\n')
}

type LedgerAssertion = (
  before: Map<string, string>,
  after: Map<string, string>,
) => void

async function expectDiagnosticFailure(
  operation: Promise<unknown>,
  expected: { readonly stage: string; readonly code: string; readonly message: string },
  before: Map<string, string>,
  fixture: DiagnosticFixture,
  assertLedger: LedgerAssertion = (initial, after) => expect(after).toEqual(initial),
): Promise<void> {
  const error = await operation.then(() => undefined, value => value)
  expect(error).toBeDefined()
  expect(error).toMatchObject(expected)
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
  const exposed = errorSurface(error)
  expect(exposed).not.toContain('dynamic secret')
  expect(exposed).not.toContain('Diagnostic summary')
  expect(exposed).not.toContain('Rejected secret title')
  expect(exposed).not.toContain('Diagnostic reason')
  expect(error).not.toMatchObject({ status: 'accepted' })
  expect(error).not.toMatchObject({ status: 'not-ready' })
  assertLedger(before, ledgerBytes(fixture.directory))
}

describe('TODO05 ordinary Feed recovery diagnostic RED', () => {
  it.each([
    ['nonaccepted', () => [] as readonly unknown[]],
    ['throw', () => { throw new Error('dynamic secret: material reader') }],
  ])('classifies readModelMaterials %s at a fixed stage/code', async (_label, listAcceptedInputs) => {
    const fixture = await createFixture('valid')
    const editor = Object.freeze({ ...fixture.editor, listAcceptedInputs }) as unknown as ContextEnabledCrossSourceEditor
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture, editor),
      { stage: 'read_model_materials', code: 'materials_not_accepted', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
    )
  })

  it.each([
    ['no submission', 'no-submission' as const],
    ['execute throw', 'throw' as const],
  ])('classifies structured Agent %s at a fixed stage/code', async (_label, mode) => {
    const fixture = await createFixture(mode)
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture),
      { stage: 'structured_agent', code: 'structured_agent_failed', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
    )
  })

  it('classifies validator rejection at a fixed stage/code', async () => {
    const fixture = await createFixture('rejected-proposal')
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture),
      { stage: 'proposal_validation', code: 'proposal_not_accepted', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
    )
  })

  it('classifies validator failure at a fixed stage/code', async () => {
    const fixture = await createFixture('valid')
    let reads = 0
    const editor = Object.freeze({
      ...fixture.editor,
      listAcceptedInputs: () => {
        reads++
        return reads === 1 ? fixture.editor.listAcceptedInputs() : []
      },
    }) as unknown as ContextEnabledCrossSourceEditor
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture, editor),
      { stage: 'proposal_validation', code: 'proposal_not_accepted', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
    )
  })

  it('classifies C37 nonacceptance after an accepted proposal at a fixed stage/code', async () => {
    const fixture = await createFixture('valid')
    const finalizer = Object.freeze({
      ...fixture.finalizer,
      establishEditingInputClosure: () => ({ status: 'rejected', input: {} } as C37Result),
    }) as unknown as PeriodBusinessFinalizer
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture, fixture.editor, finalizer),
      { stage: 'adapter', code: 'adapter_not_accepted', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
    )
  })

  it('classifies C19 nonacceptance after an accepted proposal at a fixed stage/code', async () => {
    const fixture = await createFixture('valid')
    const finalizer = Object.freeze({
      ...fixture.finalizer,
      requestFormalContentDelivery: () => ({ status: 'rejected', input: {} } as C19Result),
    }) as unknown as PeriodBusinessFinalizer
    const before = ledgerBytes(fixture.directory)
    await expectDiagnosticFailure(
      prepareOrdinaryFeed(fixture, fixture.editor, finalizer),
      { stage: 'adapter', code: 'adapter_not_accepted', message: FIXED_DIAGNOSTIC_MESSAGE },
      before,
      fixture,
      (_initial, after) => {
        const editingInputs = after.get('editing-inputs.jsonl') ?? ''
        expect(editingInputs.match(/"event":"editing_input_closure_accepted"/g)).toHaveLength(1)
        expect(editingInputs.match(/"event":"raw_feed_content_conclusion_accepted"/g)).toHaveLength(1)
        const periodBusiness = after.get('period-business.jsonl') ?? ''
        expect(periodBusiness.match(/"event":"editing_input_closure_accepted"/g) ?? []).toHaveLength(1)
        expect(periodBusiness.match(/"event":"formal_editing_conclusion_accepted"/g) ?? []).toHaveLength(1)
        expect(periodBusiness.match(/"event":"formal_content_delivery_accepted"/g) ?? []).toHaveLength(0)
        expect(after.get('delivery-and-receipt.jsonl')).toBe('')
        expect(after.get('ordinary-business-finalizations.jsonl')).toBe('')
      },
    )
  })
})
