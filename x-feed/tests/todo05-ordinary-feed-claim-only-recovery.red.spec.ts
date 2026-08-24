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

  constructor(private failBeforeProposal: boolean) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{
    readonly provider: string
    readonly id: string
    readonly name: string
  }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.failBeforeProposal) {
      this.failBeforeProposal = false
      throw new Error('controlled ordinary Feed editor failure before proposal')
    }
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

async function readInvocationCount(path: string): Promise<number> {
  const text = await readFile(path, 'utf8')
  return text.trim() === '' ? 0 : text.trim().split('\n').length
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

async function readEventRows(root: string, event: string): Promise<readonly Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (const entry of await snapshotDirectory(root)) {
    const text = Buffer.from(entry.base64, 'base64').toString('utf8').trim()
    if (text === '') continue
    for (const line of text.split('\n')) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (record.event === event) rows.push(record)
      } catch {
        // The test fixture also contains shell source and other non-JSON files.
      }
    }
  }
  return rows
}

describe('TODO05 ordinary-feed claim-only recovery', () => {
  it('recovers one durable claim from C36/C10 after editor failure without rerunning collection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-claim-only-recovery-'))
    const personalFeedDataDir = join(directory, 'personal-feed')
    const nowMs = Date.now()
    const scheduledFor = new Date(nowMs - 2_000).toISOString()
    const claimedAt = new Date(nowMs - 1_000).toISOString()
    const observedTs = Math.floor(Date.parse(scheduledFor) / 1_000)
    const runId = `cron-x@${scheduledFor}`
    const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
    const collectionBatch = join(directory, '.runs', runPart, 'collection.jsonl')
    const pipelineInvocationPath = join(directory, 'pipeline-invocations.log')
    const wire = new WireAdapter(true)
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
      await writeFile(
        join(directory, 'x_insight_pipeline.py'),
        `#!/bin/sh\nprintf '%s\\n' invoked >> ${JSON.stringify(pipelineInvocationPath)}\necho ok >&2\necho '{"ok":true}'\n`,
      )

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

      const firstRecovery = await provider.recoverPreparedDelivery(recoveryContext)
        .then(value => ({ status: 'resolved' as const, value }))
        .catch(error => ({ status: 'rejected' as const, error }))
      expect(firstRecovery.status).toBe('rejected')
      expect(await readInvocationCount(pipelineInvocationPath)).toBe(1)
      const sourceReportOwners = (await readJsonLines(join(personalFeedDataDir, 'source-candidate-reports.jsonl')))
        .filter(record => record.event === 'source_candidate_report_accepted')
      expect(sourceReportOwners).toHaveLength(1)
      expect((sourceReportOwners[0]?.accepted as { readonly report?: { readonly candidates?: readonly unknown[] } })
        .report?.candidates).toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'editing-inputs.jsonl')))
        .filter(record => record.event === 'editing_input_accepted')).toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'candidate-period-facts.jsonl')))
        .filter(record => record.event === 'candidate_accepted_into_period')).toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'candidate-period-facts.jsonl')))
        .filter(record => record.event === 'material_fact_recorded')).toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
        .filter(record => record.event === 'formal_feed_content_delivery_accepted')).toHaveLength(0)
      expect((await readJsonLines(join(personalFeedDataDir, 'period-business.jsonl')))
        .filter(record => record.event === 'formal_content_delivery_accepted')).toHaveLength(0)
      expect(sequence).toEqual([])
      expect(runDeliveryMeaningPort.bindPreparedDelivery).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()

      await writeFile(join(directory, 'trusted-fact-navigation.json'), '{ invalid navigation snapshot')

      const replayProvider = createCronEnvironmentExtension(ctx, rawConfig)
      const secondRecovery = await replayProvider.recoverPreparedDelivery!(recoveryContext)
        .then(value => ({ status: 'resolved' as const, value }))
        .catch(error => ({ status: 'rejected' as const, error }))
      expect(await readInvocationCount(pipelineInvocationPath)).toBe(1)
      expect(secondRecovery.status).toBe('resolved')
      if (secondRecovery.status !== 'resolved') return
      const recovered = secondRecovery.value
      expect(recovered.status).toBe('ready')
      if (recovered.status !== 'ready') return
      expect(wire.requests).toHaveLength(2)
      expect((await readJsonLines(join(personalFeedDataDir, 'source-candidate-reports.jsonl')))
        .filter(record => record.event === 'source_candidate_report_accepted')).toHaveLength(1)
      expect((await readJsonLines(join(personalFeedDataDir, 'editing-inputs.jsonl')))
        .filter(record => record.event === 'editing_input_accepted')).toHaveLength(2)
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
      const candidateOwnersBeforeBind = (await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl')))
        .filter(record => record.event === 'candidate_disposition_accepted')
      expect(candidateOwnersBeforeBind).toHaveLength(1)
      expect((candidateOwnersBeforeBind[0]?.disposition as { readonly value?: unknown }).value)
        .toBe('ReviewedNotSelected')
      expect((candidateOwnersBeforeBind[0]?.state as { readonly state?: unknown }).state).toBe('Suppressed')
      expect(sequence).toEqual([])
      expect(runDeliveryMeaningPort.bindPreparedDelivery).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()
      await assertUniqueC19Owners()

      const beforeBind = await snapshotDirectory(directory)
      await provider.bindPreparedDelivery!({ preparedDelivery, runDeliveryMeaningPort })
      expect(wire.requests).toHaveLength(2)
      expect(await snapshotDirectory(directory)).toEqual(beforeBind)
      expect(sequence).toEqual(['bind'])
      expect((candidateOwnersBeforeBind[0]?.disposition as { readonly period?: unknown }).period)
        .toEqual(deliveryRequest?.object.period)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()

      if (receipt === undefined) return
      await expect(provider.settleRecoveredDelivery!(receipt, runDeliveryMeaningPort))
        .resolves.toEqual({ status: 'accepted' })
      expect(sequence).toEqual(['bind', 'C1', 'C2'])
      expect(wire.requests).toHaveLength(2)
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
      const postSettlementProvider = createCronEnvironmentExtension(ctx, rawConfig)
      const replayed = await postSettlementProvider.recoverPreparedDelivery!(recoveryContext)
      expect(replayed).toEqual(recovered)
      expect(await snapshotDirectory(directory)).toEqual(afterSettlement)
      await assertUniqueC19Owners()
      expect(wire.requests).toHaveLength(2)
      expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledOnce()
      expect(runDeliveryMeaningPort.commitBusinessFinalization).toHaveBeenCalledOnce()
    } finally {
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns not-ready twice for a durable empty C36 without preparing or rerunning the claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-zero-c36-recovery-'))
    const personalFeedDataDir = join(directory, 'personal-feed')
    const nowMs = Date.now()
    const scheduledFor = new Date(nowMs - 2_000).toISOString()
    const claimedAt = new Date(nowMs - 1_000).toISOString()
    const observedTs = Math.floor(Date.parse(scheduledFor) / 1_000)
    const runId = `cron-x@${scheduledFor}`
    const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
    const collectionBatch = join(directory, '.runs', runPart, 'collection.jsonl')
    const pipelineInvocationPath = join(directory, 'pipeline-invocations.log')
    const wire = new WireAdapter(false)
    const sequence: string[] = []
    const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
      bindPreparedDelivery: vi.fn(async () => {
        sequence.push('bind')
        return { status: 'accepted' as const }
      }),
      acceptDurableReceipt: vi.fn(async () => {
        sequence.push('C1')
        return { status: 'accepted' as const, value: {} }
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
        collection_status: 'empty',
        delivery_id: 'delivery-todo05-zero-c36-recovery',
        ts: observedTs,
        current_collection: [],
        recent_items: [],
      }))
      await writeFile(
        join(directory, 'x_insight_pipeline.py'),
        `#!/bin/sh\nprintf '%s\\n' invoked >> ${JSON.stringify(pipelineInvocationPath)}\necho ok >&2\necho '{"ok":true}'\n`,
      )

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
      const recoveryContext: CronPreparedDeliveryRecoveryContext = {
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-zero-c36-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled',
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
        runDeliveryMeaningPort,
      }
      const claim = {
        jobId: 'cron-x',
        runId,
        sessionId: 'todo05-zero-c36-session',
        scheduledFor,
        claimedAt,
        trigger: 'scheduled' as const,
      }
      await provider.recoverPreparedDelivery!(recoveryContext).catch(() => undefined)

      const assertDurableZeroState = async (snapshotCount: number): Promise<void> => {
        expect(await readInvocationCount(pipelineInvocationPath)).toBe(1)
        const sourceReportOwners = (await readJsonLines(join(personalFeedDataDir, 'source-candidate-reports.jsonl')))
          .filter(record => record.event === 'source_candidate_report_accepted')
        expect(sourceReportOwners).toHaveLength(1)
        expect((sourceReportOwners[0]?.accepted as { readonly report?: { readonly candidates?: readonly unknown[] } })
          .report?.candidates).toHaveLength(0)
        expect(await readEventRows(directory, 'x_source_candidate_material_snapshot_accepted'))
          .toHaveLength(snapshotCount)
        expect((await readJsonLines(join(personalFeedDataDir, 'candidate-period-facts.jsonl')))
          .filter(record => record.event === 'candidate_accepted_into_period')).toHaveLength(0)
        expect((await readJsonLines(join(personalFeedDataDir, 'candidate-period-facts.jsonl')))
          .filter(record => record.event === 'material_fact_recorded')).toHaveLength(0)
        expect((await readJsonLines(join(personalFeedDataDir, 'editing-inputs.jsonl')))
          .filter(record => record.event === 'editing_input_accepted')).toHaveLength(0)
        expect((await readJsonLines(join(personalFeedDataDir, 'delivery-and-receipt.jsonl')))
          .filter(record => record.event === 'formal_feed_content_delivery_accepted')).toHaveLength(0)
        expect((await readJsonLines(join(personalFeedDataDir, 'period-business.jsonl')))
          .filter(record => record.event === 'formal_content_delivery_accepted')).toHaveLength(0)
        expect((await readJsonLines(join(personalFeedDataDir, 'candidate-local-state.jsonl')))
          .filter(record => record.event === 'candidate_disposition_accepted')).toHaveLength(0)
        expect(wire.requests).toHaveLength(0)
        expect(sequence).toEqual([])
        expect(runDeliveryMeaningPort.bindPreparedDelivery).not.toHaveBeenCalled()
        expect(runDeliveryMeaningPort.acceptDurableReceipt).not.toHaveBeenCalled()
        expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()
      }

      await assertDurableZeroState(1)
      await rm(join(directory, '.runs', runPart, 'source-candidate-material-snapshot.jsonl'))
      const beforeReplay = await snapshotDirectory(directory)
      await assertDurableZeroState(0)
      const replayProvider = createCronEnvironmentExtension(ctx, rawConfig)
      const expectedNotReady = { status: 'not-ready' as const, claim }
      const firstReplay = await replayProvider.recoverPreparedDelivery!(recoveryContext)
      expect(firstReplay).toEqual(expectedNotReady)
      await assertDurableZeroState(0)
      expect(await snapshotDirectory(directory)).toEqual(beforeReplay)

      const secondReplay = await replayProvider.recoverPreparedDelivery!(recoveryContext)
      expect(secondReplay).toEqual(expectedNotReady)
      await assertDurableZeroState(0)
      expect(await snapshotDirectory(directory)).toEqual(beforeReplay)
    } finally {
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
