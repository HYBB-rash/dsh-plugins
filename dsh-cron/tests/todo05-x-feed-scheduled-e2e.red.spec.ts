/**
 * TODO05 scheduled X E2E scaffold.
 *
 * This first gate only proves that the real X editing Context can be built
 * and disposed. Provider/scheduler composition is intentionally a later
 * gate; this file does not manufacture any delivery or business facts.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCronEnvironmentExtension } from '../../x-feed/src/cron-extension.ts'
import { createFileProjectionSources } from '../../x-feed/src/fact-projection/file-projection-sources.ts'
import { FileNavigationSnapshotStore } from '../../x-feed/src/navigation/file-navigation-snapshot-store.ts'
import {
  CRON_AGENT_ENVIRONMENT_REGISTRY,
  CRON_RUN_DELIVERY_MEANING_LIFECYCLE,
  provideCronAgentEnvironmentRegistry,
} from '../src/run-environment.ts'
import {
  createCronRunDeliveryMeaningLifecycle,
  provideCronRunDeliveryMeaningPortFactory,
} from '../src/run-delivery-meaning.ts'
import { SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { RunLedger } from '../src/store.ts'
import type { Job } from '../src/types.ts'

const SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'

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
    const callId = CallId('todo05-scheduled-scaffold')
    const argumentsText = JSON.stringify({
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
    })
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

function schedulerConfig(storeDir: string): SchedulerConfig {
  return {
    storeDir,
    apiBaseUrl: 'https://api.telegram.org',
    tokenRef: 'TELEGRAM_BOT_TOKEN',
    chatIdRef: 'TELEGRAM_ALLOWED_CHAT_ID',
    pollIntervalMs: 60_000,
    maxConcurrent: 1,
    deliverOnError: false,
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now()
  while (!await condition()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

async function readJsonLinesIfPresent(path: string): Promise<readonly Record<string, unknown>[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return []
    throw error
  }
}

interface ScheduledXFixture {
  readonly dataDir: string
  readonly personalFeedDataDir: string
  readonly collectionBatch: string
  readonly runId: string
}

interface ScheduledDeliveryOutcome {
  readonly deliveryState: 'delivered' | 'failed' | 'uncertain'
  readonly formalResult: 'Delivered' | 'Failed' | 'Uncertain'
  readonly selectedDisposition: 'Shown' | 'NotDeliveredThisPeriod' | 'PossiblyDelivered'
  readonly selectedSourceState: 'Displayed' | 'Suppressed'
  readonly deliveryError?: string
}

const scheduledDeliveryOutcomes = [
  ['Delivered', {
    deliveryState: 'delivered',
    formalResult: 'Delivered',
    selectedDisposition: 'Shown',
    selectedSourceState: 'Displayed',
  }],
  ['Failed', {
    deliveryState: 'failed',
    formalResult: 'Failed',
    selectedDisposition: 'NotDeliveredThisPeriod',
    selectedSourceState: 'Suppressed',
    deliveryError: 'controlled delivery failure',
  }],
  ['Uncertain', {
    deliveryState: 'uncertain',
    formalResult: 'Uncertain',
    selectedDisposition: 'PossiblyDelivered',
    selectedSourceState: 'Suppressed',
    deliveryError: 'controlled ambiguous delivery result',
  }],
] as const satisfies readonly (readonly [string, ScheduledDeliveryOutcome])[]

async function createScheduledXFixture(
  root: string,
  jobId: string,
  scheduledFor: string,
  runId = `${jobId}@${new Date(scheduledFor).toISOString()}`,
): Promise<ScheduledXFixture> {
  const dataDir = join(root, 'x')
  const personalFeedDataDir = join(root, 'personal-feed')
  const scheduledForIso = new Date(scheduledFor).toISOString()
  const scheduledMs = Date.parse(scheduledForIso)
  if (!Number.isFinite(scheduledMs) || scheduledMs <= 0) {
    throw new Error('scheduledFor must resolve to a positive timestamp')
  }
  const runPart = `run-${createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32)}`
  const collectionBatch = join(dataDir, '.runs', runPart, 'collection.jsonl')
  const observedAt = scheduledForIso
  const observedTs = Math.floor(scheduledMs / 1_000)

  const sources = createFileProjectionSources(dataDir)
  new FileNavigationSnapshotStore(dataDir).replace({
    schemaVersion: 1,
    sourceRevision: sources.facts.readLocatedSnapshot().sourceRevision,
    items: [],
  })
  await writeFile(join(dataDir, 'x_insight_package.json'), JSON.stringify({
    ok: true,
    collection_batch: collectionBatch,
    collection_status: 'ok',
    delivery_id: `delivery-${jobId}`,
    ts: observedTs,
    current_collection: [
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
    ],
    recent_items: [],
  }))
  await writeFile(join(dataDir, 'x_insight_pipeline.py'), '#!/bin/sh\necho ok >&2\necho \'{"ok":true}\'\n')

  return Object.freeze({ dataDir, personalFeedDataDir, collectionBatch, runId })
}

describe('TODO05 scheduled X E2E scaffold', () => {
  it('creates and disposes the real X editing harness context', async () => {
    const adapter = new WireAdapter()
    const ctx = await createHarness(adapter)

    try {
      expect(ctx.llm).toBeDefined()
      await expect(adapter.resolveModel('wire-test', 'wire-model')).resolves.toEqual({
        provider: 'wire-test',
        id: 'wire-model',
        name: 'wire-model',
      })
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('installs the real X provider and scheduler-owned services in one context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'todo05-scheduled-services-'))
    const ctx = await createHarness(new WireAdapter())
    let unregister: (() => void) | undefined

    try {
      const registry = provideCronAgentEnvironmentRegistry(ctx)
      const provider = createCronEnvironmentExtension(ctx, {
        cronJobId: 'todo05-x-feed-scheduled-e2e',
        dataDir: join(root, 'x'),
        pythonBin: '/bin/sh',
        pipelinePath: join(root, 'x', 'x_insight_pipeline.py'),
        personalFeedDataDir: join(root, 'personal-feed'),
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      unregister = registry.register(provider)
      const factory = provideCronRunDeliveryMeaningPortFactory(ctx, { storeDir: join(root, 'cron') })

      expect(provider.marker).toBe('dsh-x-feed/v1')
      expect(registry.resolve(provider.marker)).toEqual({ ok: true, provider })
      expect(ctx.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBe(registry)
      expect(ctx.get(CRON_RUN_DELIVERY_MEANING_LIFECYCLE)).toBe(factory)
      expect(Object.keys(factory)).toEqual(['createRunPort'])
      expect(typeof factory.createRunPort).toBe('function')
    } finally {
      unregister?.()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds the exact two-candidate X fixture for a scheduled run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'todo05-scheduled-fixture-'))
    const jobId = 'todo05-x-feed-scheduled-e2e'
    const scheduledFor = new Date(Date.now() - 1_000).toISOString()
    const expectedRunId = `${jobId}@${scheduledFor}`
    const expectedRunPart = `run-${createHash('sha256').update(expectedRunId, 'utf8').digest('hex').slice(0, 32)}`
    const expectedCollectionBatch = join(root, 'x', '.runs', expectedRunPart, 'collection.jsonl')

    try {
      const fixture = await createScheduledXFixture(root, jobId, scheduledFor)
      const packageValue = JSON.parse(await readFile(join(fixture.dataDir, 'x_insight_package.json'), 'utf8')) as {
        readonly collection_batch: unknown
        readonly current_collection: readonly { readonly id: unknown }[]
      }

      expect(fixture.runId).toBe(expectedRunId)
      expect(fixture.collectionBatch).toBe(expectedCollectionBatch)
      expect(packageValue.collection_batch).toBe(expectedCollectionBatch)
      expect(packageValue.current_collection.map(item => item.id)).toEqual(['1001', '1002'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts and disposes the real scheduler with no jobs or provider prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'todo05-scheduled-empty-'))
    const storeDir = join(root, 'cron')
    await mkdir(storeDir, { recursive: true })
    let ctx: Context | undefined
    let runtime: SchedulerRuntime | undefined
    let unregister: (() => void) | undefined
    let prepareCalls = 0
    let driveCalls = 0
    let sends = 0

    try {
      ctx = await createHarness(new WireAdapter())
      const registry = provideCronAgentEnvironmentRegistry(ctx)
      const provider = createCronEnvironmentExtension(ctx, {
        cronJobId: 'todo05-x-feed-scheduled-e2e',
        dataDir: join(root, 'x'),
        pythonBin: '/bin/sh',
        pipelinePath: join(root, 'x', 'x_insight_pipeline.py'),
        personalFeedDataDir: join(root, 'personal-feed'),
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      const observedProvider = {
        ...provider,
        prepare: async (context: Parameters<typeof provider.prepare>[0]) => {
          prepareCalls++
          return provider.prepare(context)
        },
      }
      unregister = registry.register(observedProvider)
      provideCronRunDeliveryMeaningPortFactory(ctx, { storeDir })

      const controller = new AbortController()
      runtime = new SchedulerRuntime(ctx, schedulerConfig(storeDir), {} as never, 0, controller.signal, {
        driveTurn: async () => {
          driveCalls++
          return { text: 'unexpected text', error: undefined }
        },
        deliverText: async () => {
          sends++
          return { state: 'delivered', deliveredAt: new Date().toISOString() }
        },
      })
      runtime.start()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await runtime.dispose()
      runtime = undefined

      expect(new RunLedger(storeDir).foldJob('todo05-x-feed-scheduled-e2e').claims.size).toBe(0)
      expect(prepareCalls).toBe(0)
      expect(driveCalls).toBe(0)
      expect(sends).toBe(0)
    } finally {
      await runtime?.dispose()
      unregister?.()
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(scheduledDeliveryOutcomes)('claims one due scheduled job and settles %s once', async (_label, outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'todo05-scheduled-due-'))
    const jobId = 'todo05-x-feed-scheduled-e2e'
    const scheduledFor = new Date(Date.now() - 2_000).toISOString()
    let ctx: Context | undefined
    let runtime: SchedulerRuntime | undefined
    let unregister: (() => void) | undefined
    let prepareCalls = 0
    let driveCalls = 0
    let sends = 0
    let transportPrepared: {
      readonly jobId: string
      readonly runId: string
      readonly objectId: string
      readonly text: string
    } | undefined
    let transportDeliveryAttemptClaims = 0
    let transportDeliveryReceipts = 0
    let transportMeaning: readonly Record<string, unknown>[] = []
    let transportPeriodBusiness: readonly Record<string, unknown>[] = []
    let transportDeliveryAndReceipt: readonly Record<string, unknown>[] = []
    let transportCandidateLocalState: readonly Record<string, unknown>[] = []
    let retryBeforeSettlement: unknown
    let retryAfterSettlement: unknown

    try {
      const fixture = await createScheduledXFixture(root, jobId, scheduledFor)
      const storeDir = join(root, 'cron')
      await mkdir(storeDir, { recursive: true })
      const ledgerPaths = [
        join(storeDir, 'runs.jsonl'),
        join(storeDir, 'run-delivery-meaning.jsonl'),
        join(fixture.personalFeedDataDir, 'period-business.jsonl'),
        join(fixture.personalFeedDataDir, 'delivery-and-receipt.jsonl'),
        join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'),
        join(fixture.personalFeedDataDir, 'editing-inputs.jsonl'),
        join(fixture.personalFeedDataDir, 'ordinary-business-finalizations.jsonl'),
      ]
      const job = {
        id: jobId,
        externalRef: 'dsh-x-feed:primary',
        schedule: { kind: 'once', runAt: scheduledFor },
        prompt: 'Prepare the ordinary X feed editing run.',
        deliver: 'telegram',
        sessionMode: 'per_run',
        agentEnvironment: 'dsh-x-feed/v1',
        createdAt: new Date().toISOString(),
      } satisfies Job
      await appendFile(join(storeDir, 'jobs.jsonl'), `${JSON.stringify({ op: 'create', ...job })}\n`, 'utf8')

      const wire = new WireAdapter()
      ctx = await createHarness(wire)
      const registry = provideCronAgentEnvironmentRegistry(ctx)
      const provider = createCronEnvironmentExtension(ctx, {
        cronJobId: 'legacy-profile-job',
        dataDir: fixture.dataDir,
        pythonBin: '/bin/sh',
        pipelinePath: join(fixture.dataDir, 'x_insight_pipeline.py'),
        personalFeedDataDir: fixture.personalFeedDataDir,
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      const observedProvider = {
        ...provider,
        prepare: async (context: Parameters<typeof provider.prepare>[0]) => {
          prepareCalls++
          const lease = await provider.prepare(context)
          if (!('settleDeliveryBeforeFinish' in lease)) return lease
          const meaningLifecycle = createCronRunDeliveryMeaningLifecycle({ storeDir })
          return {
            ...lease,
            settleDeliveryBeforeFinish: async receipt => {
              const before = meaningLifecycle.acceptDeliveryReceipt({ receipt })
              if (before.status !== 'accepted') throw new Error('expected pre-C2 receipt meaning acceptance')
              retryBeforeSettlement = before.value.retry
              const result = await lease.settleDeliveryBeforeFinish(receipt)
              const after = meaningLifecycle.acceptDeliveryReceipt({ receipt })
              if (after.status !== 'accepted') throw new Error('expected post-C2 receipt meaning acceptance')
              retryAfterSettlement = after.value.retry
              return result
            },
          }
        },
      }
      unregister = registry.register(observedProvider)
      provideCronRunDeliveryMeaningPortFactory(ctx, { storeDir })

      const controller = new AbortController()
      runtime = new SchedulerRuntime(ctx, schedulerConfig(storeDir), {} as never, 0, controller.signal, {
        driveTurn: async () => {
          driveCalls++
          return { text: 'unexpected text', error: undefined }
        },
        deliverText: async () => {
          sends++
          const foldedAtTransport = new RunLedger(storeDir).foldJob(jobId)
          const prepared = foldedAtTransport.preparedDeliveries.get(fixture.runId)
          transportPrepared = prepared === undefined
            ? undefined
            : {
                jobId: prepared.jobId,
                runId: prepared.runId,
                objectId: prepared.objectId,
                text: prepared.text,
              }
          transportDeliveryAttemptClaims = [...foldedAtTransport.deliveryAttemptClaims.values()]
            .filter(record => record.runId === fixture.runId).length
          transportDeliveryReceipts = [...foldedAtTransport.deliveryReceipts.values()]
            .filter(record => record.runId === fixture.runId).length
          transportMeaning = await readJsonLinesIfPresent(join(storeDir, 'run-delivery-meaning.jsonl'))
          transportPeriodBusiness = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'period-business.jsonl'))
          transportDeliveryAndReceipt = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'delivery-and-receipt.jsonl'))
          transportCandidateLocalState = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'))
          return {
            state: outcome.deliveryState,
            ...(outcome.deliveryError === undefined ? {} : { error: outcome.deliveryError }),
            ...(outcome.deliveryState === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}),
          }
        },
      })
      runtime.start()

      await waitFor(() => prepareCalls === 1
        && new RunLedger(storeDir).foldJob(jobId).claims.size === 1
        && sends === 1)
      await waitFor(async () => {
        const rows = await readJsonLinesIfPresent(join(storeDir, 'runs.jsonl'))
        return rows.filter(record => record.event === 'finish'
          && record.jobId === jobId
          && record.runId === fixture.runId).length === 1
      })
      const beforeRedriveBytes = await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))
      runtime.requestDrive()
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      expect(prepareCalls).toBe(1)
      expect(sends).toBe(1)
      expect(driveCalls).toBe(0)
      expect(wire.requests).toHaveLength(1)
      expect(await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))).toEqual(beforeRedriveBytes)
      await runtime.dispose()
      runtime = undefined

      unregister?.()
      unregister = undefined
      await ctx.fiber.dispose()
      ctx = undefined
      const afterFirstDisposeBytes = await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))

      const restartWire = new WireAdapter()
      let restartPrepareCalls = 0
      let restartDriveCalls = 0
      let restartSends = 0
      ctx = await createHarness(restartWire)
      const restartRegistry = provideCronAgentEnvironmentRegistry(ctx)
      const restartProvider = createCronEnvironmentExtension(ctx, {
        cronJobId: 'legacy-profile-job',
        dataDir: fixture.dataDir,
        pythonBin: '/bin/sh',
        pipelinePath: join(fixture.dataDir, 'x_insight_pipeline.py'),
        personalFeedDataDir: fixture.personalFeedDataDir,
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      const observedRestartProvider = {
        ...restartProvider,
        prepare: async (context: Parameters<typeof restartProvider.prepare>[0]) => {
          restartPrepareCalls++
          return restartProvider.prepare(context)
        },
      }
      unregister = restartRegistry.register(observedRestartProvider)
      provideCronRunDeliveryMeaningPortFactory(ctx, { storeDir })
      const restartController = new AbortController()
      runtime = new SchedulerRuntime(ctx, schedulerConfig(storeDir), {} as never, 0, restartController.signal, {
        driveTurn: async () => {
          restartDriveCalls++
          return { text: 'unexpected restart text', error: undefined }
        },
        deliverText: async () => {
          restartSends++
          return { state: 'delivered', deliveredAt: new Date().toISOString() }
        },
      })
      runtime.start()
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      await runtime.dispose()
      runtime = undefined
      expect(restartPrepareCalls).toBe(0)
      expect(restartDriveCalls).toBe(0)
      expect(restartSends).toBe(0)
      expect(restartWire.requests).toHaveLength(0)
      expect(sends).toBe(1)
      expect(await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))).toEqual(afterFirstDisposeBytes)

      const finalRunRows = await readJsonLinesIfPresent(join(storeDir, 'runs.jsonl'))
      const targetRunRows = finalRunRows.filter(record => record.jobId === jobId && record.runId === fixture.runId)
      const lifecycleEvents = [
        'claim',
        'prepared-delivery',
        'delivery-attempt-claim',
        'delivery-receipt',
        'environment-prefinish-settle',
        'finish',
      ] as const
      for (const event of lifecycleEvents) {
        expect(targetRunRows.filter(record => record.event === event)).toHaveLength(1)
      }
      const lifecycleIndices = lifecycleEvents.map(event => targetRunRows.findIndex(record => record.event === event))
      for (let index = 1; index < lifecycleIndices.length; index++) {
        expect(lifecycleIndices[index - 1]!).toBeLessThan(lifecycleIndices[index]!)
      }

      const finalClaim = targetRunRows.find(record => record.event === 'claim') as {
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
        readonly claimedAt: string
        readonly trigger: string
      }
      const finalPrepared = targetRunRows.find(record => record.event === 'prepared-delivery') as {
        readonly objectId: string
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
      }
      const finalAttempt = targetRunRows.find(record => record.event === 'delivery-attempt-claim') as {
        readonly objectId: string
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
      }
      const finalReceipt = targetRunRows.find(record => record.event === 'delivery-receipt') as {
        readonly objectId: string
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
        readonly deliveryState: string
        readonly deliveredAt?: unknown
        readonly deliveryError?: unknown
      }
      const finalAck = targetRunRows.find(record => record.event === 'environment-prefinish-settle') as {
        readonly objectId: string
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
        readonly deliveryState: string
        readonly deliveredAt?: unknown
        readonly deliveryError?: unknown
      }
      const finalFinish = targetRunRows.find(record => record.event === 'finish') as {
        readonly jobId: string
        readonly runId: string
        readonly sessionId: string
        readonly scheduledFor: string
        readonly trigger?: string
        readonly status: string
        readonly deliveryState?: string
        readonly deliveredAt?: unknown
        readonly deliveryError?: unknown
      }
      const expectedReceiptIdentity = {
        objectId: finalPrepared.objectId,
        jobId: finalClaim.jobId,
        runId: finalClaim.runId,
        sessionId: finalClaim.sessionId,
        scheduledFor: finalClaim.scheduledFor,
      }
      expect(finalPrepared).toMatchObject({
        jobId: finalClaim.jobId,
        runId: finalClaim.runId,
        sessionId: finalClaim.sessionId,
        scheduledFor: finalClaim.scheduledFor,
      })
      expect(finalAttempt).toEqual(expect.objectContaining(expectedReceiptIdentity))
      expect(finalReceipt).toEqual(expect.objectContaining({
        ...expectedReceiptIdentity,
        deliveryState: outcome.deliveryState,
        ...(outcome.deliveryError === undefined ? {} : { deliveryError: outcome.deliveryError }),
      }))
      if (outcome.deliveryState === 'delivered') {
        expect(finalReceipt.deliveredAt).toEqual(expect.any(String))
      } else {
        expect(finalReceipt.deliveredAt).toBeUndefined()
      }
      expect(finalAck).toEqual(expect.objectContaining({
        ...expectedReceiptIdentity,
        deliveryState: outcome.deliveryState,
        ...(outcome.deliveryError === undefined ? {} : { deliveryError: outcome.deliveryError }),
        ...(finalReceipt.deliveredAt === undefined ? {} : { deliveredAt: finalReceipt.deliveredAt }),
      }))
      expect(finalFinish).toEqual(expect.objectContaining({
        jobId: finalClaim.jobId,
        runId: finalClaim.runId,
        sessionId: finalClaim.sessionId,
        scheduledFor: finalClaim.scheduledFor,
        trigger: 'scheduled',
        status: 'success',
        deliveryState: outcome.deliveryState,
        ...(outcome.deliveryError === undefined ? {} : { deliveryError: outcome.deliveryError }),
        ...(finalReceipt.deliveredAt === undefined ? {} : { deliveredAt: finalReceipt.deliveredAt }),
      }))
      expect(new RunLedger(storeDir).foldJob(jobId).interrupted).toHaveLength(0)

      const finalPeriodBusiness = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'period-business.jsonl'))
      const finalC19Rows = finalPeriodBusiness.filter(record => record.event === 'formal_content_delivery_accepted')
      expect(finalC19Rows).toHaveLength(1)
      const finalC19Object = (finalC19Rows[0]!.request as {
        readonly object: {
          readonly object: string
          readonly period: { readonly run: string; readonly period: string }
        }
      }).object
      const finalMeaning = await readJsonLinesIfPresent(join(storeDir, 'run-delivery-meaning.jsonl'))
      const finalMeaningOwners = finalMeaning.filter(record => record.event === 'run-delivery-meaning')
      const finalBusinessOwners = finalMeaning.filter(record => record.event === 'primary-run-content-business-finalization')
      expect(finalMeaningOwners).toHaveLength(1)
      expect(finalBusinessOwners).toHaveLength(1)
      const expectedBusinessBinding = {
        objectId: finalC19Object.object,
        businessRunId: finalC19Object.period.run,
        businessPeriodId: finalC19Object.period.period,
      }
      for (const owner of [...finalMeaningOwners, ...finalBusinessOwners]) {
        expect(owner.claim).toEqual({
          jobId: finalClaim.jobId,
          runId: finalClaim.runId,
          sessionId: finalClaim.sessionId,
          scheduledFor: finalClaim.scheduledFor,
          claimedAt: finalClaim.claimedAt,
          trigger: finalClaim.trigger,
        })
        expect(owner).toEqual(expect.objectContaining(expectedBusinessBinding))
      }
      if (outcome.deliveryState === 'failed') {
        const expectedRetryAuthorization = {
          binding: expect.objectContaining({
            claim: expect.objectContaining({
              jobId: finalClaim.jobId,
              runId: finalClaim.runId,
              sessionId: finalClaim.sessionId,
              scheduledFor: finalClaim.scheduledFor,
              claimedAt: finalClaim.claimedAt,
              trigger: finalClaim.trigger,
            }),
            objectId: finalC19Object.object,
            businessRunId: finalC19Object.period.run,
            businessPeriodId: finalC19Object.period.period,
          }),
          receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        }
        expect(retryBeforeSettlement).toEqual(expect.objectContaining({
          status: 'authorized',
          category: 'primary_run_content_delivery_failed',
          readiness: 'not_ready',
          authorization: expectedRetryAuthorization,
        }))
        expect(retryAfterSettlement).toEqual(expect.objectContaining({
          status: 'authorized',
          category: 'primary_run_content_delivery_failed',
          readiness: 'ready',
          authorization: expectedRetryAuthorization,
        }))
        expect((retryAfterSettlement as { readonly authorization: unknown }).authorization)
          .toEqual((retryBeforeSettlement as { readonly authorization: unknown }).authorization)
      } else {
        expect(retryBeforeSettlement).toEqual({ status: 'not_authorized' })
        expect(retryAfterSettlement).toEqual({ status: 'not_authorized' })
      }

      const finalReceiptOwners = finalPeriodBusiness.filter(record => record.event === 'formal_content_delivery_receipt_accepted')
      expect(finalReceiptOwners).toHaveLength(1)
      expect(finalReceiptOwners[0]!.receipt).toEqual({
        object: finalC19Object.object,
        period: finalC19Object.period,
        result: outcome.formalResult,
      })
      const finalCandidateDispositions = finalPeriodBusiness.filter(record => record.event === 'candidate_disposition_accepted')
      expect(finalCandidateDispositions).toHaveLength(2)
      expect(finalCandidateDispositions.map(record => (record.disposition as { readonly value: unknown }).value).sort())
        .toEqual(['ReviewedNotSelected', outcome.selectedDisposition].sort())
      const finalSourceStates = finalPeriodBusiness.filter(record => record.event === 'source_disposition_state_accepted')
      expect(finalSourceStates).toHaveLength(2)
      expect(finalSourceStates.map(record => (record.state as { readonly state: unknown }).state).sort())
        .toEqual(['Suppressed', outcome.selectedSourceState].sort())
      const finalBusinessFinalizations = finalPeriodBusiness.filter(record => record.event === 'business_finalization_accepted')
      expect(finalBusinessFinalizations).toHaveLength(1)
      expect((finalBusinessFinalizations[0]!.finalization as {
        readonly period: unknown
      }).period).toEqual(finalC19Object.period)

      const finalCandidateLocalState = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'))
      expect(finalCandidateLocalState.filter(record => record.event === 'source_disposition_completion_accepted'))
        .toHaveLength(2)
      const finalEditingInputs = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'editing-inputs.jsonl'))
      const finalDisplayFacts = finalEditingInputs.filter(record => record.event === 'display_fact_accepted')
      expect(finalDisplayFacts).toHaveLength(1)
      expect(finalDisplayFacts[0]!.fact).toEqual(expect.objectContaining({
        disposition: expect.objectContaining({
          candidate: expect.objectContaining({ candidate: 'x-status:1001' }),
          value: outcome.selectedDisposition,
        }),
        receipt: expect.objectContaining({ result: outcome.formalResult }),
      }))
      const finalOrdinaryFinalizations = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'ordinary-business-finalizations.jsonl'))
      const finalOrdinaryOwners = finalOrdinaryFinalizations.filter(record => record.event === 'ordinary_business_finalization_accepted')
      expect(finalOrdinaryOwners).toHaveLength(1)
      expect((finalOrdinaryOwners[0]!.finalization as {
        readonly period: unknown
      }).period).toEqual(finalC19Object.period)

      const claims = [...new RunLedger(storeDir).foldJob(jobId).claims.values()]
      expect(claims).toHaveLength(1)
      const claim = claims[0]!
      expect(claim.jobId).toBe(jobId)
      expect(claim.runId).toBe(fixture.runId)
      expect(claim.scheduledFor).toBe(scheduledFor)
      expect(claim.trigger).toBe('scheduled')
      expect(claim.agentEnvironment).toBe('dsh-x-feed/v1')
      expect(claim.deliveryLifecycle).toBe('prepared')
      expect(prepareCalls).toBe(1)
      expect(driveCalls).toBe(0)
      expect(sends).toBe(1)
      expect(wire.requests).toHaveLength(1)
      expect(transportDeliveryAttemptClaims).toBe(1)
      expect(transportDeliveryReceipts).toBe(0)

      expect(transportPrepared).toBeDefined()
      const preparedAtTransport = transportPrepared!
      expect(preparedAtTransport.jobId).toBe(jobId)
      expect(preparedAtTransport.runId).toBe(fixture.runId)
      expect(preparedAtTransport.objectId.trim()).not.toBe('')
      expect(preparedAtTransport.text.trim()).not.toBe('')
      const preparedAtTransportLedger = new RunLedger(storeDir).foldJob(jobId).preparedDeliveries
      expect([...preparedAtTransportLedger.values()]).toHaveLength(1)
      expect(preparedAtTransportLedger.get(fixture.runId)?.objectId).toBe(preparedAtTransport.objectId)

      const transportC19 = transportPeriodBusiness.filter(record => record.event === 'formal_content_delivery_accepted')
      expect(transportC19).toHaveLength(1)
      const c19Object = (transportC19[0]!.request as {
        readonly object: {
          readonly object: string
          readonly period: { readonly run: string; readonly period: string }
          readonly content: { readonly body: string }
          readonly selected: { readonly candidates: readonly Record<string, unknown>[] }
        }
      }).object
      expect(c19Object.selected.candidates).toHaveLength(1)
      expect(c19Object.selected.candidates[0]?.candidate).toBe('x-status:1001')
      expect(preparedAtTransport.objectId).toBe(c19Object.object)
      expect(preparedAtTransport.text).toBe(c19Object.content.body)

      const transportDeliveryOwners = transportDeliveryAndReceipt
        .filter(record => record.event === 'formal_feed_content_delivery_accepted')
      expect(transportDeliveryOwners).toHaveLength(1)
      const deliveryObject = (transportDeliveryOwners[0]!.request as {
        readonly object: { readonly object: string }
      }).object
      expect(deliveryObject.object).toBe(c19Object.object)

      const transportCandidateOwners = transportCandidateLocalState
        .filter(record => record.event === 'candidate_disposition_accepted')
      expect(transportCandidateOwners).toHaveLength(1)
      expect((transportCandidateOwners[0]!.disposition as {
        readonly candidate?: { readonly candidate?: unknown }
      }).candidate?.candidate).toBe('x-status:1002')
      expect((transportCandidateOwners[0]!.disposition as { readonly value?: unknown }).value)
        .toBe('ReviewedNotSelected')
      expect((transportCandidateOwners[0]!.state as { readonly state?: unknown }).state).toBe('Suppressed')

      const transportLineageOwners = transportMeaning.filter(record => record.event === 'external-first-lineage')
      const transportPrimaryOwners = transportMeaning.filter(record => record.event === 'primary-run-content-object')
      expect(transportLineageOwners).toHaveLength(1)
      expect(transportPrimaryOwners).toHaveLength(1)
      const expectedOwnerClaim = {
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
      }
      for (const owner of [transportLineageOwners[0]!, transportPrimaryOwners[0]!]) {
        expect(owner.claim).toEqual(expectedOwnerClaim)
      }
      expect(transportPrimaryOwners[0]!.objectId).toBe(preparedAtTransport.objectId)
      expect(transportPrimaryOwners[0]!.businessRunId).toBe(c19Object.period.run)
      expect(transportPrimaryOwners[0]!.businessPeriodId).toBe(c19Object.period.period)

      const periodBusinessAfterDispose = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'period-business.jsonl'))
      expect(periodBusinessAfterDispose.filter(record => record.event === 'formal_content_delivery_accepted'))
        .toHaveLength(1)
      const preparedAfterDispose = new RunLedger(storeDir).foldJob(jobId).preparedDeliveries
      expect([...preparedAfterDispose.values()]).toHaveLength(1)
      expect(preparedAfterDispose.get(fixture.runId)?.objectId).toBe(preparedAtTransport.objectId)
      const meaningAfterDispose = await readJsonLinesIfPresent(join(storeDir, 'run-delivery-meaning.jsonl'))
      expect(meaningAfterDispose.filter(record => record.event === 'external-first-lineage')).toHaveLength(1)
      expect(meaningAfterDispose.filter(record => record.event === 'primary-run-content-object')).toHaveLength(1)
      const deliveryAfterDispose = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'delivery-and-receipt.jsonl'))
      expect(deliveryAfterDispose.filter(record => record.event === 'formal_feed_content_delivery_accepted'))
        .toHaveLength(1)
      const candidateLocalAfterDispose = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'))
      const candidateOwnersAfterDispose = candidateLocalAfterDispose
        .filter(record => record.event === 'candidate_disposition_accepted')
        .filter(record => (record.disposition as {
          readonly candidate?: { readonly candidate?: unknown }
        }).candidate?.candidate === 'x-status:1002')
      expect(candidateOwnersAfterDispose).toHaveLength(1)
      expect((candidateOwnersAfterDispose[0]!.disposition as {
        readonly candidate?: { readonly candidate?: unknown }
      }).candidate?.candidate).toBe('x-status:1002')
      expect((candidateOwnersAfterDispose[0]!.disposition as { readonly value?: unknown }).value)
        .toBe('ReviewedNotSelected')
      expect((candidateOwnersAfterDispose[0]!.state as { readonly state?: unknown }).state).toBe('Suppressed')
      expect(sends).toBe(1)
    } finally {
      await runtime?.dispose()
      unregister?.()
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs one manual Delivered job through the real X lifecycle without consuming its future schedule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'todo05-manual-delivered-'))
    const jobId = 'todo05-x-feed-manual-delivered-e2e'
    const requestKey = 'todo05-x-feed-manual-delivered-request'
    const manualRunId = `manual:${jobId}:${createHash('sha256').update(requestKey, 'utf8').digest('hex')}`
    const naturalScheduledFor = new Date(Date.now() + 60_000).toISOString()
    const fixtureObservedAt = new Date(Date.now() - 1_000).toISOString()
    let ctx: Context | undefined
    let runtime: SchedulerRuntime | undefined
    let unregister: (() => void) | undefined
    const firstCounters = { prepare: 0, drive: 0, sends: 0 }

    try {
      const fixture = await createScheduledXFixture(root, jobId, fixtureObservedAt, manualRunId)
      const storeDir = join(root, 'cron')
      await mkdir(storeDir, { recursive: true })
      const ledgerPaths = [
        join(storeDir, 'runs.jsonl'),
        join(storeDir, 'run-delivery-meaning.jsonl'),
        join(fixture.personalFeedDataDir, 'period-business.jsonl'),
        join(fixture.personalFeedDataDir, 'delivery-and-receipt.jsonl'),
        join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'),
        join(fixture.personalFeedDataDir, 'editing-inputs.jsonl'),
        join(fixture.personalFeedDataDir, 'ordinary-business-finalizations.jsonl'),
      ]
      const job = {
        id: jobId,
        externalRef: 'dsh-x-feed:primary',
        schedule: { kind: 'once', runAt: naturalScheduledFor },
        prompt: 'Prepare the ordinary X feed editing run manually.',
        deliver: 'telegram',
        sessionMode: 'per_run',
        agentEnvironment: 'dsh-x-feed/v1',
        createdAt: new Date().toISOString(),
      } satisfies Job
      await appendFile(join(storeDir, 'jobs.jsonl'), `${JSON.stringify({ op: 'create', ...job })}\n`, 'utf8')

      const startRuntime = async (
        wire: WireAdapter,
        counters: { prepare: number; drive: number; sends: number },
      ): Promise<{
        readonly ctx: Context
        readonly runtime: SchedulerRuntime
        readonly unregister: () => void
      }> => {
        const nextCtx = await createHarness(wire)
        const registry = provideCronAgentEnvironmentRegistry(nextCtx)
        const provider = createCronEnvironmentExtension(nextCtx, {
          cronJobId: 'legacy-profile-job',
          dataDir: fixture.dataDir,
          pythonBin: '/bin/sh',
          pipelinePath: join(fixture.dataDir, 'x_insight_pipeline.py'),
          personalFeedDataDir: fixture.personalFeedDataDir,
          personalFeedRequiredSources: ['x'],
          candidateReportingWindowMs: 300_000,
        })
        const observedProvider = {
          ...provider,
          prepare: async (context: Parameters<typeof provider.prepare>[0]) => {
            counters.prepare++
            return provider.prepare(context)
          },
        }
        const unregisterProvider = registry.register(observedProvider)
        provideCronRunDeliveryMeaningPortFactory(nextCtx, { storeDir })
        const controller = new AbortController()
        const nextRuntime = new SchedulerRuntime(nextCtx, schedulerConfig(storeDir), {} as never, 0, controller.signal, {
          driveTurn: async () => {
            counters.drive++
            return { text: 'unexpected manual drive text', error: undefined }
          },
          deliverText: async () => {
            counters.sends++
            return { state: 'delivered', deliveredAt: new Date().toISOString() }
          },
        })
        return { ctx: nextCtx, runtime: nextRuntime, unregister: unregisterProvider }
      }

      const wire = new WireAdapter()
      const first = await startRuntime(wire, firstCounters)
      ctx = first.ctx
      runtime = first.runtime
      unregister = first.unregister
      runtime.start()

      const manualLowerBound = Date.now()
      const firstRun = await runtime.runNow({ jobId, requestKey })
      const manualUpperBound = Date.now()
      expect(firstRun).toEqual({
        ok: true,
        runId: manualRunId,
      })
      await waitFor(async () => (await readJsonLinesIfPresent(join(storeDir, 'runs.jsonl')))
        .filter(record => record.event === 'finish' && record.runId === manualRunId).length === 1)
      await new Promise<void>(resolve => setTimeout(resolve, 25))

      const initialRows = await readJsonLinesIfPresent(join(storeDir, 'runs.jsonl'))
      const claims = initialRows.filter(record => record.event === 'claim' && record.runId === manualRunId)
      expect(claims).toHaveLength(1)
      const manualClaim = claims[0]!
      const manualClaimIdentity = {
        jobId: manualClaim.jobId as string,
        runId: manualClaim.runId as string,
        sessionId: manualClaim.sessionId as string,
        scheduledFor: manualClaim.scheduledFor as string,
        claimedAt: manualClaim.claimedAt as string,
        trigger: manualClaim.trigger as string,
      }
      expect(manualClaim).toEqual(expect.objectContaining(manualClaimIdentity))
      expect(manualClaimIdentity.jobId).toBe(jobId)
      expect(manualClaimIdentity.runId).toBe(manualRunId)
      expect(manualClaimIdentity.trigger).toBe('manual')
      const manualScheduledForMs = Date.parse(manualClaimIdentity.scheduledFor)
      const manualClaimedAtMs = Date.parse(manualClaimIdentity.claimedAt)
      const naturalScheduledForMs = Date.parse(naturalScheduledFor)
      expect(Number.isFinite(manualScheduledForMs)).toBe(true)
      expect(Number.isFinite(manualClaimedAtMs)).toBe(true)
      expect(manualScheduledForMs).toBeGreaterThanOrEqual(manualLowerBound)
      expect(manualScheduledForMs).toBeLessThanOrEqual(manualUpperBound)
      expect(manualScheduledForMs).toBeLessThanOrEqual(manualClaimedAtMs)
      expect(manualScheduledForMs).not.toBe(naturalScheduledForMs)
      expect(manualScheduledForMs).toBeLessThan(naturalScheduledForMs)
      expect(manualClaim.nextRunAt).toBeUndefined()
      expect(initialRows.filter(record => record.event === 'claim' && record.trigger === 'scheduled'))
        .toHaveLength(0)
      expect(initialRows.filter(record => record.event === 'finish' && record.runId === manualRunId))
        .toHaveLength(1)
      const finish = initialRows.find(record => record.event === 'finish' && record.runId === manualRunId)!
      expect(finish).toEqual(expect.objectContaining({
        jobId: manualClaimIdentity.jobId,
        runId: manualClaimIdentity.runId,
        sessionId: manualClaimIdentity.sessionId,
        scheduledFor: manualClaimIdentity.scheduledFor,
        trigger: 'manual',
        status: 'success',
        deliveryState: 'delivered',
      }))
      expect(finish.nextRunAt).toBeUndefined()

      const folded = new RunLedger(storeDir).foldJob(jobId)
      expect(folded.claims.size).toBe(1)
      expect(folded.preparedDeliveries.size).toBe(1)
      expect(folded.deliveryAttemptClaims.size).toBe(1)
      expect(folded.deliveryReceipts.size).toBe(1)
      expect(folded.prefinishSettledDeliveries.size).toBe(1)
      expect(folded.interrupted).toHaveLength(0)
      expect(firstCounters.prepare).toBe(1)
      expect(firstCounters.drive).toBe(0)
      expect(firstCounters.sends).toBe(1)
      expect(wire.requests).toHaveLength(1)

      const prepared = folded.preparedDeliveries.get(manualRunId)!
      const attempt = folded.deliveryAttemptClaims.get(manualRunId)!
      const receipt = folded.deliveryReceipts.get(manualRunId)!
      const acknowledgement = folded.prefinishSettledDeliveries.get(manualRunId)!
      const runIdentity = {
        jobId: manualClaimIdentity.jobId,
        runId: manualClaimIdentity.runId,
        sessionId: manualClaimIdentity.sessionId,
        scheduledFor: manualClaimIdentity.scheduledFor,
      }
      expect(prepared).toEqual(expect.objectContaining(runIdentity))
      expect(attempt).toEqual(expect.objectContaining(runIdentity))
      expect(receipt).toEqual(expect.objectContaining(runIdentity))
      expect(acknowledgement).toEqual(expect.objectContaining(runIdentity))
      expect(attempt.objectId).toBe(prepared.objectId)
      expect(receipt.objectId).toBe(prepared.objectId)
      expect(acknowledgement.objectId).toBe(receipt.objectId)
      expect(receipt.deliveryState).toBe('delivered')
      expect(acknowledgement.deliveryState).toBe(receipt.deliveryState)
      expect(acknowledgement.deliveredAt).toBe(receipt.deliveredAt)
      expect(finish.deliveryState).toBe(receipt.deliveryState)
      expect(finish.deliveredAt).toBe(receipt.deliveredAt)
      const periodBusiness = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'period-business.jsonl'))
      const c19Rows = periodBusiness.filter(record => record.event === 'formal_content_delivery_accepted')
      expect(c19Rows).toHaveLength(1)
      const c19Object = (c19Rows[0]!.request as {
        readonly object: {
          readonly object: string
          readonly period: { readonly run: string; readonly period: string }
          readonly content: { readonly body: string }
          readonly selected: { readonly candidates: readonly Record<string, unknown>[] }
        }
      }).object
      expect(c19Object.selected.candidates).toHaveLength(1)
      expect(c19Object.selected.candidates[0]?.candidate).toBe('x-status:1001')
      expect(prepared.objectId).toBe(c19Object.object)
      expect(prepared.text).toBe(c19Object.content.body)

      const deliveryReceiptRows = periodBusiness.filter(record => record.event === 'formal_content_delivery_receipt_accepted')
      expect(deliveryReceiptRows).toHaveLength(1)
      expect(deliveryReceiptRows[0]!.receipt).toEqual({
        object: c19Object.object,
        period: c19Object.period,
        result: 'Delivered',
      })
      const candidateDispositions = periodBusiness.filter(record => record.event === 'candidate_disposition_accepted')
      expect(candidateDispositions.map(record => (record.disposition as { readonly value: unknown }).value).sort())
        .toEqual(['ReviewedNotSelected', 'Shown'])
      expect(periodBusiness.filter(record => record.event === 'source_disposition_state_accepted')
        .map(record => (record.state as { readonly state: unknown }).state).sort())
        .toEqual(['Displayed', 'Suppressed'])
      expect(periodBusiness.filter(record => record.event === 'business_finalization_accepted')).toHaveLength(1)

      const deliveryOwner = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'delivery-and-receipt.jsonl'))
      expect(deliveryOwner.filter(record => record.event === 'formal_feed_content_delivery_accepted')).toHaveLength(1)
      const candidateLocal = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'candidate-local-state.jsonl'))
      expect(candidateLocal.filter(record => record.event === 'candidate_disposition_accepted')).toHaveLength(2)
      expect(candidateLocal.filter(record => record.event === 'source_disposition_completion_accepted')).toHaveLength(2)
      const editingInputs = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'editing-inputs.jsonl'))
      const displayFacts = editingInputs.filter(record => record.event === 'display_fact_accepted')
      expect(displayFacts).toHaveLength(1)
      expect(displayFacts[0]!.fact).toEqual(expect.objectContaining({
        candidate: expect.objectContaining({ candidate: expect.any(String) }),
        disposition: expect.objectContaining({ value: 'Shown' }),
        receipt: expect.objectContaining({ result: 'Delivered' }),
      }))
      expect((displayFacts[0]!.fact as {
        readonly candidate: { readonly candidate: unknown }
      }).candidate.candidate).toBe('x-status:1001')
      const ordinaryFinalizations = await readJsonLinesIfPresent(join(fixture.personalFeedDataDir, 'ordinary-business-finalizations.jsonl'))
      expect(ordinaryFinalizations.filter(record => record.event === 'ordinary_business_finalization_accepted'))
        .toHaveLength(1)

      const meaningOwners = await readJsonLinesIfPresent(join(storeDir, 'run-delivery-meaning.jsonl'))
      expect(meaningOwners.filter(record => record.event === 'external-first-lineage')).toHaveLength(1)
      expect(meaningOwners.filter(record => record.event === 'primary-run-content-object')).toHaveLength(1)
      expect(meaningOwners.filter(record => record.event === 'run-delivery-meaning')).toHaveLength(1)
      expect(meaningOwners.filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(1)
      const expectedOwnerClaim = {
        jobId: manualClaimIdentity.jobId,
        runId: manualClaimIdentity.runId,
        sessionId: manualClaimIdentity.sessionId,
        scheduledFor: manualClaimIdentity.scheduledFor,
        claimedAt: manualClaimIdentity.claimedAt,
        trigger: manualClaimIdentity.trigger,
      }
      for (const owner of [
        ...meaningOwners.filter(record => record.event === 'external-first-lineage'),
        ...meaningOwners.filter(record => record.event === 'primary-run-content-object'),
        ...meaningOwners.filter(record => record.event === 'run-delivery-meaning'),
        ...meaningOwners.filter(record => record.event === 'primary-run-content-business-finalization'),
      ]) {
        expect(owner.claim).toEqual(expectedOwnerClaim)
      }
      const primaryOwner = meaningOwners.find(record => record.event === 'primary-run-content-object')!
      expect(primaryOwner).toEqual(expect.objectContaining({
        objectId: c19Object.object,
        businessRunId: c19Object.period.run,
        businessPeriodId: c19Object.period.period,
      }))
      const ownerClaim = primaryOwner.claim as Record<string, unknown>
      expect(ownerClaim).toEqual(expect.objectContaining({
        jobId,
        runId: manualRunId,
        trigger: 'manual',
      }))

      const beforeReplayBytes = await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))
      await expect(runtime.runNow({ jobId, requestKey })).resolves.toEqual({
        ok: true,
        alreadyAccepted: true,
        runId: manualRunId,
      })
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      expect(firstCounters.prepare).toBe(1)
      expect(firstCounters.drive).toBe(0)
      expect(firstCounters.sends).toBe(1)
      expect(await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))).toEqual(beforeReplayBytes)

      await runtime.dispose()
      runtime = undefined
      unregister?.()
      unregister = undefined
      await ctx.fiber.dispose()
      ctx = undefined
      const afterFirstDisposeBytes = await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))

      const restartWire = new WireAdapter()
      const restartCounters = { prepare: 0, drive: 0, sends: 0 }
      const restarted = await startRuntime(restartWire, restartCounters)
      ctx = restarted.ctx
      runtime = restarted.runtime
      unregister = restarted.unregister
      runtime.start()
      await expect(runtime.runNow({ jobId, requestKey })).resolves.toEqual({
        ok: true,
        alreadyAccepted: true,
        runId: manualRunId,
      })
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      expect(restartCounters).toEqual({ prepare: 0, drive: 0, sends: 0 })
      expect(restartWire.requests).toHaveLength(0)
      expect(firstCounters.sends).toBe(1)
      expect(await Promise.all(ledgerPaths.map(path => readFile(path, 'utf8')))).toEqual(afterFirstDisposeBytes)
      expect(new RunLedger(storeDir).foldJob(jobId).claims.size).toBe(1)
      expect(new RunLedger(storeDir).foldJob(jobId).claims.get(manualRunId)?.trigger).toBe('manual')
    } finally {
      await runtime?.dispose()
      unregister?.()
      if (ctx !== undefined) await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
