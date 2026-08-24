import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  title: 'Existing prepared recovery target',
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
  const callId = CallId('ordinary-feed-existing-recovery-editor-1')
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

async function readJsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
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

async function snapshotDirectory(root: string): Promise<readonly { readonly path: string; readonly base64: string }[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const snapshots: { path: string; base64: string }[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      snapshots.push(...await snapshotDirectory(path).then(children => children.map(child => ({
        path: join(entry.name, child.path),
        base64: child.base64,
      }))))
      continue
    }
    snapshots.push({ path: entry.name, base64: (await readFile(path)).toString('base64') })
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path))
}

interface DeliveryRequest {
  readonly object: string
  readonly period: { readonly run: string; readonly period: string }
  readonly content: { readonly body: string }
  readonly selected: { readonly candidates: readonly Record<string, unknown>[] }
}

describe('TODO05 ordinary-feed existing prepared recovery', () => {
  it('rebinds and settles one persisted prepared object without recomputing the run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-existing-recovery-'))
    const personalFeedDataDir = join(directory, 'personal-feed')
    const nowMs = Date.now()
    const scheduledFor = new Date(nowMs - 2_000).toISOString()
    const claimedAt = new Date(nowMs - 1_000).toISOString()
    const observedAt = scheduledFor
    const observedTs = Math.floor(Date.parse(observedAt) / 1_000)
    const runId = `cron-x@${scheduledFor}`
    const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
    const collectionBatch = join(directory, '.runs', runPart, 'collection.jsonl')
    const wire = new WireAdapter()
    let deliveryRequest: DeliveryRequest | undefined
    let settlementReceipt: CronDeliveryReceipt | undefined
    let ctx: Context | undefined
    const sequence: string[] = []
    const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
      bindPreparedDelivery: vi.fn(async input => {
        expect(input).toEqual({
          businessRunId: deliveryRequest?.period.run,
          businessPeriodId: deliveryRequest?.period.period,
        })
        sequence.push('bind')
        return { status: 'accepted' as const }
      }),
      acceptDurableReceipt: vi.fn(async input => {
        expect(input).toBe(settlementReceipt)
        sequence.push('C1')
        return { status: 'accepted' as const, value: { receipt: input } }
      }),
      commitBusinessFinalization: vi.fn(async () => {
        expect(sequence.at(-1)).toBe('C1')
        const periodBusiness = await readJsonLines(join(personalFeedDataDir, 'period-business.jsonl'))
        const receipts = periodBusiness.filter(record => record.event === 'formal_content_delivery_receipt_accepted')
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.receipt).toEqual({
          object: deliveryRequest?.object,
          period: deliveryRequest?.period,
          result: 'Delivered',
        })
        expect(periodBusiness.filter(record => record.event === 'business_finalization_accepted')).toHaveLength(1)
        const candidateLocal = await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl'))
        expect(candidateLocal.filter(record => record.event === 'candidate_disposition_accepted'))
          .toHaveLength(2)
        expect(candidateLocal.filter(record => record.event === 'source_disposition_completion_accepted'))
          .toHaveLength(2)
        expect(candidateLocal.map(record => (
          record.disposition as { readonly value?: unknown } | undefined
        )?.value).filter(value => value !== undefined).sort())
          .toEqual(['ReviewedNotSelected', 'Shown'])
        expect((await readJsonLines(join(personalFeedDataDir, 'editing-inputs.jsonl')))
          .filter(record => record.event === 'display_fact_accepted')).toHaveLength(1)
        expect(await readJsonLines(join(personalFeedDataDir, 'ordinary-business-finalizations.jsonl')))
          .toHaveLength(1)
        sequence.push('C2')
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
        delivery_id: 'delivery-todo05-existing-recovery',
        ts: observedTs,
        current_collection: [
          { id: '1001', url: 'https://x.com/alice/status/1001', text: 'first current item', time: observedAt, user: 'alice', media: [], ts: observedTs },
          { id: '1002', url: 'https://x.com/bob/status/1002', text: 'second current item', time: observedAt, user: 'bob', media: [], ts: observedTs },
        ],
        recent_items: [],
      }))
      await writeFile(join(directory, 'x_insight_pipeline.py'), '#!/bin/sh\necho ok >&2\necho \'{"ok":true}\'\n')

      const rawConfig = {
        cronJobId: 'cron-x',
        dataDir: directory,
        pythonBin: '/bin/sh',
        pipelinePath: join(directory, 'x_insight_pipeline.py'),
        personalFeedDataDir,
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      } as const
      ctx = await createHarness(wire)
      const firstExtension = createCronEnvironmentExtension(ctx, rawConfig)
      const firstPrepared = await firstExtension.prepare({
        jobId: 'cron-x',
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
        runId,
        trigger: 'scheduled',
        scheduledFor,
        claimedAt,
        runDeliveryMeaningPort,
      })
      if ('kind' in firstPrepared) throw new Error('existing recovery fixture unexpectedly skipped')
      const preparedDelivery = firstPrepared.preparedDelivery
      expect(preparedDelivery).toEqual(expect.objectContaining({ objectId: expect.any(String), text: expect.any(String) }))
      const deliveryOwners = await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl'))
      const ownerRequest = deliveryOwners.find(record => record.event === 'formal_feed_content_delivery_accepted')?.request as {
        readonly object?: DeliveryRequest
      } | undefined
      deliveryRequest = ownerRequest?.object
      expect(deliveryRequest).toBeDefined()
      expect(preparedDelivery).toEqual({ objectId: deliveryRequest?.object, text: deliveryRequest?.content.body })
      const assertUniqueC19Owners = async (): Promise<void> => {
        const deliveryOwners = (await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
          .filter(record => record.event === 'formal_feed_content_delivery_accepted')
        expect(deliveryOwners).toHaveLength(1)
        expect(deliveryOwners[0]?.request).toEqual({ object: deliveryRequest })
        const periodBusinessOwners = (await readJsonLines(join(personalFeedDataDir, 'period-business.jsonl')))
          .filter(record => record.event === 'formal_content_delivery_accepted')
        expect(periodBusinessOwners).toHaveLength(1)
        expect(periodBusinessOwners[0]?.request).toEqual({ object: deliveryRequest })
      }
      settlementReceipt = {
        objectId: preparedDelivery.objectId,
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-existing-recovery-session',
        scheduledFor,
        deliveryState: 'delivered',
        deliveredAt: new Date(Date.parse(claimedAt) + 1_000).toISOString(),
      }
      const recoveryContext = {
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-existing-recovery-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled' as const,
        jobKind: 'agent' as const,
        sessionMode: 'per_run' as const,
        gate: 'forbidden' as const,
        runDeliveryMeaningPort,
      }
      const beforeRecovery = await snapshotDirectory(directory)
      const sourceReportBeforeRecovery = (await readJsonLines(
        join(personalFeedDataDir, 'source-candidate-reports.jsonl'),
      )).filter(record => record.event === 'source_candidate_report_accepted')
      const candidateOwnersBeforeRecovery = (await readJsonLines(
        join(personalFeedDataDir, 'candidate-local-state.jsonl'),
      )).filter(record => record.event === 'candidate_disposition_accepted')

      const rebuiltExtension = createCronEnvironmentExtension(ctx, rawConfig)
      const recovered = await rebuiltExtension.recoverPreparedDelivery!(recoveryContext)
      expect(recovered.status).toBe('ready')
      if (recovered.status !== 'ready') return
      expect(recovered.claim).toEqual({
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-existing-recovery-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled',
      })
      expect(recovered.preparedDelivery.objectId).toBe(preparedDelivery.objectId)
      expect(recovered.preparedDelivery.text).toBe(preparedDelivery.text)
      expect(wire.requests).toHaveLength(1)
      expect(await snapshotDirectory(directory)).toEqual(beforeRecovery)
      expect((await readJsonLines(join(personalFeedDataDir, 'source-candidate-reports.jsonl')))
        .filter(record => record.event === 'source_candidate_report_accepted'))
        .toEqual(sourceReportBeforeRecovery)
      expect((await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl')))
        .filter(record => record.event === 'candidate_disposition_accepted'))
        .toEqual(candidateOwnersBeforeRecovery)
      expect(sequence).toEqual([])

      await rebuiltExtension.bindPreparedDelivery!({
        preparedDelivery: recovered.preparedDelivery,
        runDeliveryMeaningPort,
      })
      expect(wire.requests).toHaveLength(1)
      expect(await snapshotDirectory(directory)).toEqual(beforeRecovery)
      expect(sequence).toEqual(['bind'])

      await expect(rebuiltExtension.settleRecoveredDelivery!(settlementReceipt, runDeliveryMeaningPort))
        .resolves.toEqual({ status: 'accepted' })
      expect(sequence).toEqual(['bind', 'C1', 'C2'])
      expect(wire.requests).toHaveLength(1)
      expect(runDeliveryMeaningPort.bindPreparedDelivery).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).toHaveBeenCalledOnce()
      await assertUniqueC19Owners()

      const afterSettlement = await snapshotDirectory(directory)
      const replayExtension = createCronEnvironmentExtension(ctx, rawConfig)
      await expect(replayExtension.settleRecoveredDelivery!(settlementReceipt, runDeliveryMeaningPort))
        .resolves.toEqual({ status: 'accepted' })
      expect(await snapshotDirectory(directory)).toEqual(afterSettlement)
      await assertUniqueC19Owners()
      expect(sequence).toEqual(['bind', 'C1', 'C2', 'C1', 'C2'])
      expect(wire.requests).toHaveLength(1)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledTimes(2)
      expect(runDeliveryMeaningPort.commitBusinessFinalization).toHaveBeenCalledTimes(2)
    } finally {
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
