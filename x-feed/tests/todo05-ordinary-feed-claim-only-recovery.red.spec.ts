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
  CronAgentEnvironmentProvider,
  CronDeliveryReceipt,
  CronPreparedDeliveryRecoveryContext,
  CronRunDeliveryMeaningRunPort,
  PreparedDeliveryObject,
} from '@deepseek-ai/dsh-cron'
import { describe, expect, it, vi } from 'vitest'
import type { FormalFeedContentDeliveryRequest } from '@herman/personal-feed'
import { createCronEnvironmentExtension } from '../src/cron-extension.ts'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

const SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'

const ordinaryFeedSubmission = {
  title: 'Claim-only recovery target',
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
    const argumentsText = JSON.stringify(ordinaryFeedSubmission)
    const callId = CallId('ordinary-feed-claim-only-recovery-editor-1')
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
      argumentsDelta: argumentsText,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: callId,
        name: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
        arguments: argumentsText,
      },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
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

describe('TODO05 ordinary-feed claim-only recovery', () => {
  it('recovers one durable claim without first preparing the live run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-claim-only-recovery-'))
    const personalFeedDataDir = join(directory, 'personal-feed')
    const nowMs = Date.now()
    const scheduledFor = new Date(nowMs - 2_000).toISOString()
    const claimedAt = new Date(nowMs - 1_000).toISOString()
    const observedTs = Math.floor(Date.parse(scheduledFor) / 1_000)
    const runId = `cron-x@${scheduledFor}`
    const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
    const collectionBatch = join(directory, '.runs', runPart, 'collection.jsonl')
    const wire = new WireAdapter()
    const sequence: string[] = []
    let deliveryRequest: FormalFeedContentDeliveryRequest | undefined
    let preparedDelivery: PreparedDeliveryObject | undefined
    let receipt: CronDeliveryReceipt | undefined
    const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
      bindPreparedDelivery: vi.fn(async input => {
        expect(input).toEqual({
          businessRunId: deliveryRequest?.object.period.run,
          businessPeriodId: deliveryRequest?.object.period.period,
        })
        sequence.push('bind')
        return { status: 'accepted' as const }
      }),
      acceptDurableReceipt: vi.fn(async input => {
        expect(input).toBe(receipt)
        sequence.push('C1')
        return { status: 'accepted' as const, value: { receipt: input } }
      }),
      commitBusinessFinalization: vi.fn(async () => {
        sequence.push('C2')
        return { status: 'accepted' as const }
      }),
    })

    let ctx: Context | undefined
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
        delivery_id: 'delivery-todo05-claim-only-recovery',
        ts: observedTs,
        current_collection: [
          { id: '1001', url: 'https://x.com/alice/status/1001', text: 'first current item', time: scheduledFor, user: 'alice', media: [], ts: observedTs },
          { id: '1002', url: 'https://x.com/bob/status/1002', text: 'second current item', time: scheduledFor, user: 'bob', media: [], ts: observedTs },
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
      const provider: CronAgentEnvironmentProvider = createCronEnvironmentExtension(ctx, rawConfig)
      expect(await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
        .toHaveLength(0)
      expect(wire.requests).toHaveLength(0)

      const recoveryContext: CronPreparedDeliveryRecoveryContext = {
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-claim-only-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled',
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
        runDeliveryMeaningPort,
      }
      expect(typeof provider.recoverPreparedDelivery).toBe('function')
      if (typeof provider.recoverPreparedDelivery !== 'function') return

      const recovered = await provider.recoverPreparedDelivery(recoveryContext)
      expect(recovered.status).toBe('ready')
      if (recovered.status !== 'ready') return
      expect(recovered.claim).toEqual({
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-claim-only-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled',
      })
      preparedDelivery = recovered.preparedDelivery
      const deliveryOwners = (await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
        .filter(record => record.event === 'formal_feed_content_delivery_accepted')
      expect(deliveryOwners).toHaveLength(1)
      deliveryRequest = (deliveryOwners[0]?.request as FormalFeedContentDeliveryRequest | undefined)
      expect(deliveryRequest).toBeDefined()
      expect(preparedDelivery).toEqual({
        objectId: deliveryRequest?.object.object,
        text: deliveryRequest?.object.content.body,
      })
      const assertUniqueC19Owners = async (): Promise<void> => {
        const deliveryOwnerRows = (await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
          .filter(record => record.event === 'formal_feed_content_delivery_accepted')
        expect(deliveryOwnerRows).toHaveLength(1)
        expect(deliveryOwnerRows[0]?.request).toEqual(deliveryRequest)
        const periodBusinessOwnerRows = (await readJsonLines(join(personalFeedDataDir, 'period-business.jsonl')))
          .filter(record => record.event === 'formal_content_delivery_accepted')
        expect(periodBusinessOwnerRows).toHaveLength(1)
        expect(periodBusinessOwnerRows[0]?.request).toEqual(deliveryRequest)
      }
      receipt = {
        objectId: preparedDelivery.objectId,
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-claim-only-session',
        scheduledFor,
        deliveryState: 'delivered',
        deliveredAt: new Date(Date.parse(claimedAt) + 1_000).toISOString(),
      }
      await assertUniqueC19Owners()

      const beforeBind = await snapshotDirectory(directory)
      await provider.bindPreparedDelivery!({ preparedDelivery, runDeliveryMeaningPort })
      expect(wire.requests).toHaveLength(1)
      expect(await snapshotDirectory(directory)).toEqual(beforeBind)
      expect(sequence).toEqual(['bind'])
      const boundCandidateOwners = (await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl')))
        .filter(record => record.event === 'candidate_disposition_accepted')
      expect(boundCandidateOwners).toHaveLength(1)
      expect((boundCandidateOwners[0]?.disposition as { readonly value?: unknown }).value)
        .toBe('ReviewedNotSelected')
      expect((boundCandidateOwners[0]?.state as { readonly state?: unknown }).state).toBe('Suppressed')
      expect((boundCandidateOwners[0]?.disposition as { readonly period?: unknown }).period)
        .toEqual(deliveryRequest?.object.period)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()

      if (receipt === undefined) return
      await expect(provider.settleRecoveredDelivery!(receipt, runDeliveryMeaningPort))
        .resolves.toEqual({ status: 'accepted' })
      expect(sequence).toEqual(['bind', 'C1', 'C2'])
      expect(wire.requests).toHaveLength(1)
      const settledCandidateLocal = await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl'))
      expect(settledCandidateLocal.filter(record => record.event === 'candidate_disposition_accepted'))
        .toHaveLength(2)
      expect(settledCandidateLocal.map(record => (
        record.disposition as { readonly value?: unknown } | undefined
      )?.value).filter(value => value !== undefined).sort())
        .toEqual(['ReviewedNotSelected', 'Shown'])
      expect(settledCandidateLocal.filter(record => record.event === 'source_disposition_completion_accepted'))
        .toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'editing-inputs.jsonl')))
        .filter(record => record.event === 'display_fact_accepted')).toHaveLength(1)
      expect((await readJsonLines(join(personalFeedDataDir, 'ordinary-business-finalizations.jsonl'))))
        .toHaveLength(1)
      await assertUniqueC19Owners()

      const afterSettlement = await snapshotDirectory(directory)
      const replayProvider = createCronEnvironmentExtension(ctx, rawConfig)
      const replayed = await replayProvider.recoverPreparedDelivery!(recoveryContext)
      expect(replayed).toEqual(recovered)
      expect(await snapshotDirectory(directory)).toEqual(afterSettlement)
      await assertUniqueC19Owners()
      expect(wire.requests).toHaveLength(1)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).toHaveBeenCalledOnce()
    } finally {
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
