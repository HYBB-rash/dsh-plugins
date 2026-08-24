import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
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
  CronDeliveryReceipt,
  CronRunDeliveryMeaningRunPort,
  PreparedDeliveryObject,
} from '@deepseek-ai/dsh-cron'
import { describe, expect, it, vi } from 'vitest'
import { createCronEnvironmentExtension } from '../src/cron-extension.ts'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

const SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'

const ordinaryFeedSubmission = {
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
} as const

function ordinaryFeedToolResponse(): StreamChunk[] {
  const argumentsText = JSON.stringify(ordinaryFeedSubmission)
  const callId = CallId('ordinary-feed-tracer-editor-1')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
      argumentsDelta: argumentsText,
    },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: callId,
        name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
        arguments: argumentsText,
      },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class WireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<{
    readonly provider: string
    readonly id: string
    readonly name: string
  }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield* ordinaryFeedToolResponse()
  }
}

async function createHarness(adapter: WireAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  return ctx
}

async function readJsonLinesIfPresent(path: string): Promise<readonly Record<string, unknown>[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return []
    throw error
  }
}

/**
 * TODO05 ordinary-feed run-lifecycle package-private seam bootstrap RED.
 *
 * This test intentionally stops at the missing deep module/factory. It does
 * not construct a second period, inject C19, or mirror a future runtime
 * contract. The eventual module must stay package-internal and be assembled
 * only by createCronEnvironmentExtension from its own scope.
 */
describe('TODO05 ordinary-feed run-lifecycle bootstrap', () => {
  it('provides a package-private lifecycle factory', async () => {
    const modulePath = '../src/personal-feed/ordinary-feed-run-lifecycle.ts'

    await expect(import(modulePath)).resolves.toHaveProperty(
      'createOrdinaryFeedRunLifecycle',
    )
  })

  it('is assembled exactly once by the cron extension without widening config', async () => {
    const [indexSource, extensionSource] = await Promise.all([
      readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/cron-extension.ts', import.meta.url), 'utf8'),
    ])
    const lifecycleImports = extensionSource.match(
      /from\s+['"]\.\/personal-feed\/ordinary-feed-run-lifecycle\.ts['"]/g,
    ) ?? []
    const lifecycleFactoryCalls = extensionSource.match(
      /createOrdinaryFeedRunLifecycle\s*\(/g,
    ) ?? []

    expect(lifecycleImports).toHaveLength(1)
    expect(lifecycleFactoryCalls).toHaveLength(1)

    expect(indexSource).not.toContain('ordinary-feed-run-lifecycle')
    expect(indexSource).not.toContain('createOrdinaryFeedRunLifecycle')
    expect(extensionSource).not.toMatch(/rawConfig[^\n]*(?:lifecycle|period|candidate|C19)/i)
  })

  it('forms one scheduled period, C11, and two C10 inputs before the ordinary lifecycle boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-ordinary-tracer-'))
    const personalFeedDataDir = join(directory, 'personal-feed')
    const nowMs = Date.now()
    const scheduledFor = new Date(nowMs - 2_000).toISOString()
    const claimedAt = new Date(nowMs - 1_000).toISOString()
    const observedAt = new Date(nowMs - 2_000).toISOString()
    const observedTs = Math.floor((nowMs - 2_000) / 1_000)
    const runId = `cron-x@${scheduledFor}`
    const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
    const collectionBatch = join(directory, '.runs', runPart, 'collection.jsonl')
    const currentCollection = [
      {
        id: '1001',
        url: 'https://x.com/alice/status/1001',
        text: 'first current item',
        time: observedAt,
        user: 'alice',
        media: [],
        ts: observedTs,
      },
      {
        id: '1002',
        url: 'https://x.com/bob/status/1002',
        text: 'second current item',
        time: observedAt,
        user: 'bob',
        media: [],
        ts: observedTs,
      },
    ]
    const wire = new WireAdapter()
    let settlementReceipt: CronDeliveryReceipt | undefined
    let deliveryObjectId: string | undefined
    let deliveryPeriod: { readonly run: string; readonly period: string } | undefined
    const settlementSequence: string[] = []
    let ctx: Context | undefined
    const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
      bindPreparedDelivery: vi.fn(async () => ({ status: 'accepted' as const })),
      acceptDurableReceipt: vi.fn(async input => {
        settlementSequence.push('C1')
        expect(input).toBe(settlementReceipt)
        return { status: 'accepted' as const, value: { receipt: input } }
      }),
      commitBusinessFinalization: vi.fn(async () => {
        const periodBusiness = await readJsonLinesIfPresent(join(personalFeedDataDir, 'period-business.jsonl'))
        const receipts = periodBusiness.filter(record => record.event === 'formal_content_delivery_receipt_accepted')
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.receipt).toEqual({
          object: deliveryObjectId,
          period: deliveryPeriod,
          result: 'Delivered',
        })
        expect(periodBusiness.filter(record => record.event === 'business_finalization_accepted')).toHaveLength(1)

        const candidateLocal = await readJsonLinesIfPresent(join(personalFeedDataDir, 'candidate-local-state.jsonl'))
        const candidateOwners = candidateLocal.filter(record => record.event === 'candidate_disposition_accepted')
        expect(candidateOwners).toHaveLength(2)
        expect(candidateOwners.map(record => (
          record.disposition as { readonly value?: unknown }
        ).value).sort()).toEqual(['ReviewedNotSelected', 'Shown'])
        expect(candidateLocal.filter(record => record.event === 'source_disposition_completion_accepted'))
          .toHaveLength(2)

        const editingInputs = await readJsonLinesIfPresent(join(personalFeedDataDir, 'editing-inputs.jsonl'))
        expect(editingInputs.filter(record => record.event === 'display_fact_accepted')).toHaveLength(1)
        expect(await readJsonLinesIfPresent(join(personalFeedDataDir, 'ordinary-business-finalizations.jsonl')))
          .toHaveLength(1)
        settlementSequence.push('C2')
        return { status: 'accepted' as const }
      }),
    })

    try {
      const sources = createFileProjectionSources(directory)
      new FileNavigationSnapshotStore(directory).replace({
        schemaVersion: 1,
        sourceRevision: sources.facts.readLocatedSnapshot().sourceRevision,
        items: [],
      })
      await writeFile(join(directory, 'x_insight_package.json'), JSON.stringify({
        ok: true,
        collection_batch: collectionBatch,
        collection_status: 'ok',
        delivery_id: 'delivery-todo05-ordinary-tracer',
        ts: observedTs,
        current_collection: currentCollection,
        recent_items: [],
      }))
      await writeFile(join(directory, 'x_insight_pipeline.py'), '#!/bin/sh\necho ok >&2\necho \'{"ok":true}\'\n')

      ctx = await createHarness(wire)
      const rawConfig = {
        cronJobId: 'cron-x',
        dataDir: directory,
        pythonBin: '/bin/sh',
        pipelinePath: join(directory, 'x_insight_pipeline.py'),
        personalFeedDataDir,
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      } as const
      const extension = createCronEnvironmentExtension(ctx, rawConfig)

      let prepareError: unknown
      let prepared: unknown
      try {
        prepared = await extension.prepare({
          jobId: 'cron-x',
          jobKind: 'agent',
          sessionMode: 'per_run',
          gate: 'forbidden',
          runId,
          trigger: 'scheduled',
          scheduledFor,
          claimedAt,
          runDeliveryMeaningPort,
        } as never)
      } catch (error) {
        prepareError = error
      }

      const currentContextInputs = (await readFile(join(personalFeedDataDir, 'current-context-inputs.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
      const editingInputs = (await readFile(join(personalFeedDataDir, 'editing-inputs.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
      const acceptedEditingInputs = editingInputs.filter(input => input.event === 'editing_input_accepted')
      expect(currentContextInputs).toHaveLength(1)
      expect(acceptedEditingInputs).toHaveLength(2)
      expect(new Set(acceptedEditingInputs.map(input => JSON.stringify(input.material.period))).size).toBe(1)
      expect(acceptedEditingInputs.every(input => JSON.stringify(input.material.period) === JSON.stringify(currentContextInputs[0].period))).toBe(true)
      expect(prepareError).toBeUndefined()
      if (prepareError !== undefined) return

      expect(wire.requests).toHaveLength(1)
      const toolNames = wire.requests.flatMap(request => request.tools?.map(tool => tool.name) ?? [])
      expect(toolNames).toEqual([SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL])
      expect(toolNames).not.toContain('submit_x_cron_planner')
      expect(toolNames).not.toContain('submit_x_cron_composer')

      const lease = prepared as Record<string, unknown>
      expect(Object.keys(lease).sort()).toEqual([
        'dispose',
        'preparedDelivery',
        'settleDeliveryBeforeFinish',
        'setupAgent',
        'verifySurface',
      ])
      expect(lease).not.toHaveProperty('settleRun')
      const preparedDelivery = lease.preparedDelivery as PreparedDeliveryObject
      expect(typeof preparedDelivery.objectId).toBe('string')
      expect(preparedDelivery.objectId).not.toBe('')
      expect(typeof preparedDelivery.text).toBe('string')
      expect(preparedDelivery.text).not.toBe('')
      expect(runDeliveryMeaningPort.bindPreparedDelivery).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()

      const editingLedger = await readJsonLinesIfPresent(join(personalFeedDataDir, 'editing-inputs.jsonl'))
      expect(editingLedger.filter(record => record.event === 'editing_input_accepted')).toHaveLength(2)
      expect(editingLedger.filter(record => record.event === 'editing_input_closure_accepted')).toHaveLength(1)
      expect(editingLedger.filter(record => record.event === 'raw_feed_content_conclusion_accepted')).toHaveLength(1)

      const periodBusinessLedger = await readJsonLinesIfPresent(join(personalFeedDataDir, 'period-business.jsonl'))
      expect(periodBusinessLedger.filter(record => record.event === 'editing_input_closure_accepted')).toHaveLength(1)
      expect(periodBusinessLedger.filter(record => record.event === 'formal_editing_conclusion_accepted')).toHaveLength(1)
      expect(periodBusinessLedger.filter(record => record.event === 'formal_content_delivery_accepted')).toHaveLength(1)
      const periodBusinessDispositions = periodBusinessLedger.filter(record => record.event === 'candidate_disposition_accepted')
      expect(periodBusinessDispositions.filter(record => (
        record.disposition as { readonly value?: unknown } | undefined
      )?.value === 'ReviewedNotSelected')).toHaveLength(1)

      const deliveryLedger = await readJsonLinesIfPresent(join(personalFeedDataDir, 'delivery-and-receipt.jsonl'))
      const deliveryOwners = deliveryLedger.filter(record => record.event === 'formal_feed_content_delivery_accepted')
      expect(deliveryOwners).toHaveLength(1)
      const deliveryRequest = (deliveryOwners[0]?.request as {
        readonly object: {
          readonly object: string
          readonly period: { readonly run: string; readonly period: string }
          readonly content: { readonly body: string }
          readonly selected: { readonly candidates: readonly Record<string, unknown>[] }
        }
      }).object
      deliveryObjectId = deliveryRequest.object
      deliveryPeriod = deliveryRequest.period
      settlementReceipt = {
        objectId: deliveryRequest.object,
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-recovery-session',
        scheduledFor,
        deliveryState: 'delivered',
        deliveredAt: new Date(Date.parse(claimedAt) + 1_000).toISOString(),
      }
      expect(deliveryRequest.selected.candidates).toHaveLength(1)
      expect(deliveryRequest.selected.candidates[0]?.candidate).toBe('x-status:1001')
      expect(preparedDelivery.objectId).toBe(deliveryRequest.object)
      expect(preparedDelivery.text).toBe(deliveryRequest.content.body)

      const candidateLocalLedger = await readJsonLinesIfPresent(join(personalFeedDataDir, 'candidate-local-state.jsonl'))
      const candidateOwners = candidateLocalLedger.filter(record => record.event === 'candidate_disposition_accepted')
      expect(candidateOwners).toHaveLength(1)
      expect((candidateOwners[0]?.disposition as { readonly candidate?: { readonly candidate?: unknown } }).candidate?.candidate)
        .toBe('x-status:1002')
      expect((candidateOwners[0]?.disposition as { readonly value?: unknown }).value).toBe('ReviewedNotSelected')
      expect((candidateOwners[0]?.state as { readonly state?: unknown }).state).toBe('Suppressed')

      expect(extension.preparedDeliveryLifecycle).toBe(true)
      expect(extension.runDeliveryMeaningLifecycle).toBe(true)
      expect(typeof extension.bindPreparedDelivery).toBe('function')

      const ledgerPaths = [
        'period-scopes.jsonl',
        'source-candidate-reports.jsonl',
        'candidate-period-facts.jsonl',
        'editing-inputs.jsonl',
        'current-context-inputs.jsonl',
        'period-business.jsonl',
        'delivery-and-receipt.jsonl',
        'candidate-local-state.jsonl',
        'ordinary-business-finalizations.jsonl',
      ].map(name => join(personalFeedDataDir, name))
      const ledgerBytesBeforeBind = await Promise.all(ledgerPaths.map(readBytesOrUndefined))
      if (extension.bindPreparedDelivery === undefined) return
      await extension.bindPreparedDelivery({ preparedDelivery, runDeliveryMeaningPort })
      expect(runDeliveryMeaningPort.bindPreparedDelivery).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.bindPreparedDelivery).toHaveBeenCalledWith({
        businessRunId: deliveryRequest.period.run,
        businessPeriodId: deliveryRequest.period.period,
      })
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()
      expect(await Promise.all(ledgerPaths.map(readBytesOrUndefined))).toEqual(ledgerBytesBeforeBind)

      const recoveredExtension = createCronEnvironmentExtension(ctx, rawConfig)
      await expect(recoveredExtension.settleRecoveredDelivery!(settlementReceipt, runDeliveryMeaningPort))
        .resolves.toEqual({ status: 'accepted' })
      expect(settlementSequence).toEqual(['C1', 'C2'])
      expect(wire.requests).toHaveLength(1)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).toHaveBeenCalledOnce()
    } finally {
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function readBytesOrUndefined(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path)).toString('base64')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return undefined
    throw error
  }
}
