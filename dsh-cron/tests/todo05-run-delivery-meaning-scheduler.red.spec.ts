/**
 * TODO05 scheduler RED: create/inject the run-scoped meaning port and gate
 * pre-finish completion on the durable C2 owner fact.
 *
 * This file owns scheduler-side B/C1/C2 RED coverage. It does not define
 * receipt policy or a test-owned lifecycle.
 */

import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CRON_AGENT_ENVIRONMENT_REGISTRY,
  CRON_RUN_DELIVERY_MEANING_LIFECYCLE,
  createCronAgentEnvironmentRegistry,
  toCronPreparedDeliveryClaimBinding,
  type CronPreparedDeliveryClaimBinding,
  type CronPreparedDeliveryRecoveryContext,
  type CronAgentEnvironmentPrepareContext,
  type CronAgentEnvironmentProvider,
  type CronRunDeliveryMeaningPortFactory,
} from '../src/run-environment.ts'
import {
  inspectPreparedDeliveryBinding,
  registerPreparedDeliveryBindingInspector,
} from '../src/run-delivery-meaning-inspector.ts'
import { SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { RunLedger } from '../src/store.ts'
import type {
  CronDeliveryReceipt,
  Job,
  PreparedDeliveryObject,
  RunClaimRecord,
  RunDeliveryReceiptRecord,
  RunEnvironmentPrefinishSettleRecord,
  RunFinishRecord,
} from '../src/types.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
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

function futureMarkedJob(id: string, deliver: 'silent' | 'telegram' = 'telegram'): Job {
  return {
    id,
    schedule: { kind: 'once', runAt: new Date(Date.now() + 60 * 60_000).toISOString() },
    prompt: 'scheduler bridge prompt',
    deliver,
    sessionMode: 'per_run',
    agentEnvironment: 'scheduler-bridge/v1',
    createdAt: new Date().toISOString(),
  }
}

function seedJob(storeDir: string, job: Job): void {
  const line = JSON.stringify({ op: 'create', ...job })
  const path = join(storeDir, 'jobs.jsonl')
  appendFileSync(path, `${line}\n`, 'utf8')
}

function readRecords(storeDir: string): Array<Record<string, unknown>> {
  const path = join(storeDir, 'runs.jsonl')
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

function directoryBytes(storeDir: string): Map<string, string> {
  return new Map(readdirSync(storeDir).sort().map(name => [
    name,
    Buffer.from(readFileSync(join(storeDir, name))).toString('base64'),
  ]))
}

function readOwnerRecords(storeDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(storeDir, 'run-delivery-meaning.jsonl'), 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('scheduler bridge waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function schedulerContext(
  registry: ReturnType<typeof createCronAgentEnvironmentRegistry>,
  lifecycleFactory: unknown,
) {
  return {
    get(name: string) {
      if (name === CRON_AGENT_ENVIRONMENT_REGISTRY) return registry
      if (name === CRON_RUN_DELIVERY_MEANING_LIFECYCLE) return lifecycleFactory
      if (name === 'sessions') return { flush: async () => undefined }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) }
      if (name === 'agents') return {
        get: () => undefined,
        create: async () => ({ agent: { session: { seq: 0, events: [] }, followup: () => undefined, whenIdle: async () => undefined }, dispose: async () => undefined }),
        resume: async () => ({ agent: { session: { seq: 0, events: [] }, followup: () => undefined, whenIdle: async () => undefined }, dispose: async () => undefined }),
      }
      return undefined
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    parallel: async () => undefined,
  } as never
}

async function realFactory(storeDir: string): Promise<unknown> {
  const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>
  const createFactory = module.createCronRunDeliveryMeaningPortFactory
  expect(typeof createFactory).toBe('function')
  if (typeof createFactory !== 'function') return undefined
  return (createFactory as (config: { readonly storeDir: string }) => unknown)({ storeDir })
}

async function seedExistingReceipt(
  storeDir: string,
  claim: RunClaimRecord,
  objectId: string,
  commitC2: boolean,
): Promise<CronDeliveryReceipt> {
  const factory = await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory
  const created = await factory.createRunPort(toCronPreparedDeliveryClaimBinding(claim as CronPreparedDeliveryRecoveryContext))
  if (created.status !== 'accepted') throw new Error('expected existing recovery port')
  expect(await created.port.bindPreparedDelivery({
    businessRunId: `${claim.runId}-business`,
    businessPeriodId: `${claim.runId}-period`,
  })).toEqual({ status: 'accepted' })
  const ledger = new RunLedger(storeDir)
  ledger.claimDeliveryAttempt({
    schemaVersion: 2,
    event: 'delivery-attempt-claim',
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    claimedAt: new Date(Date.parse(claim.claimedAt) + 1_000).toISOString(),
    objectId,
  })
  const receipt: CronDeliveryReceipt = {
    objectId,
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    deliveryState: 'delivered',
    deliveredAt: new Date(Date.parse(claim.claimedAt) + 2_000).toISOString(),
  }
  ledger.recordDeliveryReceipt({
    schemaVersion: 2,
    event: 'delivery-receipt',
    ...receipt,
    receiptAt: new Date(Date.parse(claim.claimedAt) + 3_000).toISOString(),
  })
  expect(await created.port.acceptDurableReceipt(receipt)).toEqual({ status: 'accepted', value: { receipt } })
  if (commitC2) expect(await created.port.commitBusinessFinalization()).toEqual({ status: 'accepted' })
  await created.dispose()
  return receipt
}

async function seedPreparedTerminalRun(
  storeDir: string,
  claim: RunClaimRecord,
  objectId: string,
  text: string,
): Promise<CronDeliveryReceipt> {
  const ledger = new RunLedger(storeDir)
  ledger.claim(claim)
  ledger.prepareDelivery({
    schemaVersion: 2,
    event: 'prepared-delivery',
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    preparedAt: new Date(Date.parse(claim.claimedAt) + 500).toISOString(),
    objectId,
    text,
  })
  const receipt = await seedExistingReceipt(storeDir, claim, objectId, false)
  const settledAt = new Date(Date.parse(receipt.deliveredAt!) + 1_000).toISOString()
  ledger.environmentPrefinishSettled({
    schemaVersion: 2,
    event: 'environment-prefinish-settle',
    ...receipt,
    settledAt,
  } satisfies RunEnvironmentPrefinishSettleRecord)
  ledger.finish({
    schemaVersion: 2,
    event: 'finish',
    trigger: claim.trigger,
    runId: claim.runId,
    jobId: claim.jobId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    startedAt: claim.claimedAt,
    finishedAt: new Date(Date.parse(settledAt) + 1_000).toISOString(),
    status: 'success',
    deliveryState: receipt.deliveryState,
    deliveredAt: receipt.deliveredAt,
    ...(claim.nextRunAt === undefined ? {} : { nextRunAt: claim.nextRunAt }),
  } satisfies RunFinishRecord)
  return receipt
}

function observeFactory(delegate: CronRunDeliveryMeaningPortFactory) {
  const bindings: CronPreparedDeliveryClaimBinding[] = []
  const ports: unknown[] = []
  const disposeCounts: number[] = []
  const factory: CronRunDeliveryMeaningPortFactory = {
    createRunPort: async binding => {
      bindings.push(binding)
      const result = await delegate.createRunPort(binding)
      if (result.status !== 'accepted') return result
      ports.push(result.port)
      let disposeCount = 0
      const originalDispose = result.dispose
      disposeCounts.push(0)
      return {
        ...result,
        dispose: async () => {
          disposeCount++
          disposeCounts[disposeCounts.length - 1] = disposeCount
          await originalDispose()
        },
      }
    },
  }
  return { factory, bindings, ports, disposeCounts }
}

function wrongAcceptedReceiptFactory(delegate: CronRunDeliveryMeaningPortFactory) {
  let c1Calls = 0
  const factory: CronRunDeliveryMeaningPortFactory = {
    createRunPort: async binding => {
      const result = await delegate.createRunPort(binding)
      if (result.status !== 'accepted') return result
      const original = result.port
      const proxy = Object.freeze({
        bindPreparedDelivery: original.bindPreparedDelivery,
        acceptDurableReceipt: async (receipt: CronDeliveryReceipt) => {
          c1Calls++
          return {
            status: 'accepted' as const,
            value: { receipt: { ...receipt, objectId: `${receipt.objectId}-wrong` } },
          }
        },
        commitBusinessFinalization: original.commitBusinessFinalization,
      })
      const unregister = registerPreparedDeliveryBindingInspector(
        proxy,
        preparedDelivery => inspectPreparedDeliveryBinding(original, preparedDelivery),
      )
      let disposed = false
      return {
        status: 'accepted' as const,
        port: proxy,
        dispose: async () => {
          if (disposed) return
          disposed = true
          unregister()
          await result.dispose()
        },
      }
    },
  }
  return { factory, c1Calls: () => c1Calls }
}

function legacyLease() {
  return {
    setupAgent: async () => undefined,
    verifySurface: async () => undefined,
    dispose: async () => undefined,
  }
}

function preparedLease(
  preparedDelivery: PreparedDeliveryObject,
  settle: (receipt: CronDeliveryReceipt) => Promise<{ readonly status: 'accepted' }>,
) {
  return {
    ...legacyLease(),
    preparedDelivery,
    settleDeliveryBeforeFinish: settle,
  }
}

describe('TODO05 scheduler-owned run-scoped meaning port RED', () => {
  it('durably records C1 before the live pre-finish hook and never lets the hook outrun it', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-live-')
    const job = futureMarkedJob('scheduler-c1-live', 'telegram')
    seedJob(storeDir, job)
    let meaningPort: CronAgentEnvironmentPrepareContext['runDeliveryMeaningPort']
    let hookCalls = 0
    let sends = 0
    let ownerRowsAtHook: Array<Record<string, unknown>> = []
    let replayResult: unknown
    let receiptAtHook: CronDeliveryReceipt | undefined
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async context => {
        meaningPort = context.runDeliveryMeaningPort
        return {
          ...legacyLease(),
          preparedDelivery: { objectId: 'scheduler-c1-live-object', text: 'scheduler c1 live text' },
          settleDeliveryBeforeFinish: async receipt => {
            hookCalls++
            receiptAtHook = receipt
            ownerRowsAtHook = readOwnerRecords(storeDir)
            replayResult = await meaningPort!.acceptDurableReceipt(receipt)
            throw new Error('intentional pre-finish hold after C1 observation')
          },
        }
      },
      bindPreparedDelivery: async context => {
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-live-business',
          businessPeriodId: 'scheduler-c1-live-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++; return { state: 'delivered', deliveredAt: new Date().toISOString() } },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c1-live' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => hookCalls === 1)
      expect(ownerRowsAtHook.filter(record => record.event === 'run-delivery-meaning')).toHaveLength(1)
      expect(replayResult).toEqual({ status: 'accepted', value: { receipt: receiptAtHook } })
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('durably records C1 before claim-only recovery settlement', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-claim-only-')
    const job = futureMarkedJob('scheduler-c1-claim-only', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c1-claim-only-run',
      sessionId: 'scheduler-c1-claim-only-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    let recoveryCalls = 0
    let settleCalls = 0
    let sends = 0
    let ownerRowsAtSettle: Array<Record<string, unknown>> = []
    let replayResult: unknown
    let receiptAtSettle: CronDeliveryReceipt | undefined
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => {
        recoveryCalls++
        return {
          status: 'ready',
          claim: toCronPreparedDeliveryClaimBinding(context),
          preparedDelivery: { objectId: 'scheduler-c1-claim-only-object', text: 'scheduler c1 claim-only text' },
        }
      },
      bindPreparedDelivery: async context => {
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-claim-only-business',
          businessPeriodId: 'scheduler-c1-claim-only-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async (receipt, port) => {
        settleCalls++
        receiptAtSettle = receipt
        ownerRowsAtSettle = readOwnerRecords(storeDir)
        replayResult = await port!.acceptDurableReceipt(receipt)
        throw new Error('intentional recovery hold after C1 observation')
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++; return { state: 'delivered', deliveredAt: new Date().toISOString() } },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      expect(recoveryCalls).toBe(1)
      expect(ownerRowsAtSettle.filter(record => record.event === 'run-delivery-meaning')).toHaveLength(1)
      expect(replayResult).toEqual({ status: 'accepted', value: { receipt: receiptAtSettle } })
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects an accepted C1 result whose receipt differs from the durable receipt', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-wrong-receipt-')
    const job = futureMarkedJob('scheduler-c1-wrong-receipt', 'telegram')
    seedJob(storeDir, job)
    let hookCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c1-wrong-object', text: 'scheduler c1 wrong receipt text' },
        settleDeliveryBeforeFinish: async () => {
          hookCalls++
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-wrong-business',
          businessPeriodId: 'scheduler-c1-wrong-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const real = await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory
    const wrong = wrongAcceptedReceiptFactory(real)
    const observed = observeFactory(wrong.factory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++; return { state: 'delivered', deliveredAt: new Date().toISOString() } },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c1-wrong-receipt' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => sends === 1)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(wrong.c1Calls()).toBe(1)
      expect(hookCalls).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: 'c1-wrong-receipt-second' })
      expect(second.ok).toBe(false)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('injects the exact live claim port before provider prepare and holds without it', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-live-port-')
    const job = futureMarkedJob('scheduler-live-port', 'telegram')
    seedJob(storeDir, job)
    const prepareContexts: CronAgentEnvironmentPrepareContext[] = []
    let driveCalls = 0
    let sendCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async context => {
        prepareContexts.push(context)
        // A legacy-shaped lease is public and intentionally invalid for this
        // opt-in provider, so this RED isolates port injection before any
        // prepared/transport lifecycle can begin.
        return legacyLease()
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => { driveCalls++; return { text: 'must not drive' } },
        deliverText: async () => { sendCalls++; return { state: 'delivered' } },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'live-port' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => prepareContexts.length === 1)
      const context = prepareContexts[0]!
      expect.soft(Object.keys(context).sort()).toEqual([
        'claimedAt', 'gate', 'jobId', 'jobKind', 'runDeliveryMeaningPort',
        'runId', 'scheduledFor', 'sessionMode', 'trigger',
      ])
      expect.soft(context.runDeliveryMeaningPort).toEqual(expect.any(Object))

      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(driveCalls).toBe(0)
      expect(sendCalls).toBe(0)
      const claim = records.find(record => record.event === 'claim')
      const lineage = readOwnerRecords(storeDir).filter(record => record.event === 'external-first-lineage')
      expect.soft(lineage).toHaveLength(1)
      expect.soft(lineage[0]?.claim).toEqual({
        jobId: claim?.jobId,
        runId: claim?.runId,
        sessionId: claim?.sessionId,
        scheduledFor: claim?.scheduledFor,
        claimedAt: claim?.claimedAt,
        trigger: claim?.trigger,
      })
      expect.soft(observed.bindings[0]).toEqual({
        jobId: claim?.jobId,
        runId: claim?.runId,
        sessionId: claim?.sessionId,
        scheduledFor: claim?.scheduledFor,
        claimedAt: claim?.claimedAt,
        trigger: claim?.trigger,
      })
      expect.soft(observed.ports[0]).toEqual(expect.any(Object))
      expect.soft(context.runDeliveryMeaningPort).toBe(observed.ports[0])
      if (observed.ports.length === 1) {
        await waitFor(() => observed.disposeCounts[0] === 1)
      }
      expect.soft(observed.disposeCounts).toEqual([1])
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    ['missing canonical service', undefined],
    ['factory with no corresponding claim', 'independent-store'],
  ] as const)('%s holds an opted-in live claim before provider side effects', async (_name, mode) => {
    const storeDir = temporaryDirectory(`todo05-scheduler-service-${mode ?? 'missing'}-`)
    const serviceDir = mode === undefined ? undefined : temporaryDirectory('todo05-scheduler-service-independent-')
    const job = futureMarkedJob(`scheduler-service-${mode ?? 'missing'}`, 'telegram')
    seedJob(storeDir, job)
    let prepareCalls = 0
    let sendCalls = 0
    let driveCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { prepareCalls++; return legacyLease() },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = serviceDir === undefined
      ? undefined
      : observeFactory(await realFactory(serviceDir) as CronRunDeliveryMeaningPortFactory)
    const serviceBefore = serviceDir === undefined ? undefined : directoryBytes(serviceDir)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed?.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { driveCalls++; return { text: 'must not drive' } }, deliverText: async () => { sendCalls++ } },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: `service-${mode ?? 'missing'}` })).resolves.toMatchObject({ ok: true })
      await waitFor(() => readRecords(storeDir).filter(record => record.event === 'claim').length === 1)
      const before = directoryBytes(storeDir)
      runtime.requestDrive()
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: `service-${mode ?? 'missing'}-second` })
      expect(second.ok).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect.soft(prepareCalls).toBe(0)
      expect(sendCalls).toBe(0)
      expect(driveCalls).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(before)
      if (serviceDir !== undefined && serviceBefore !== undefined) {
        expect(directoryBytes(serviceDir)).toEqual(serviceBefore)
        const claim = records.find(record => record.event === 'claim')
        expect.soft(observed?.bindings).toEqual([{
          jobId: claim?.jobId,
          runId: claim?.runId,
          sessionId: claim?.sessionId,
          scheduledFor: claim?.scheduledFor,
          claimedAt: claim?.claimedAt,
          trigger: claim?.trigger,
        }])
        expect.soft(observed?.ports).toHaveLength(0)
        expect.soft(observed?.disposeCounts).toEqual([])
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('does not add a port to legacy provider context', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-legacy-port-')
    const job = futureMarkedJob('scheduler-legacy-port', 'silent')
    seedJob(storeDir, job)
    const contexts: CronAgentEnvironmentPrepareContext[] = []
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async context => { contexts.push(context); return { kind: 'skip', outcome: { text: undefined, error: undefined } } },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, undefined),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'legacy-port' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'finish'))
      expect(contexts).toHaveLength(1)
      expect(Object.keys(contexts[0]!).sort()).toEqual([
        'claimedAt', 'gate', 'jobId', 'jobKind', 'runId', 'scheduledFor', 'sessionMode', 'trigger',
      ])
      expect(contexts[0]!.runDeliveryMeaningPort).toBeUndefined()
      expect(readRecords(storeDir).filter(record => record.event === 'prepared-delivery')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('preserves the prepared provider path when meaning opt-in is absent', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-prepared-legacy-')
    const job = futureMarkedJob('scheduler-prepared-legacy', 'telegram')
    seedJob(storeDir, job)
    const contexts: CronAgentEnvironmentPrepareContext[] = []
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: false,
      prepare: async context => {
        contexts.push(context)
        return preparedLease(
          { objectId: 'prepared-legacy-object', text: 'prepared legacy text' },
          async () => ({ status: 'accepted' }),
        )
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, undefined),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive' }), deliverText: async () => { sends++; return { state: 'delivered' } } },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'prepared-legacy' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'finish'))
      expect(contexts).toHaveLength(1)
      expect(contexts[0]!.runDeliveryMeaningPort).toBeUndefined()
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(sends).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('injects the exact claim-only recovery port before provider recovery', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-claim-only-port-')
    const job = futureMarkedJob('scheduler-claim-only-port', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'claim-only-run',
      sessionId: 'claim-only-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    const contexts: Array<Parameters<NonNullable<CronAgentEnvironmentProvider['recoverPreparedDelivery']>>[0]> = []
    let prepareCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { prepareCalls++; return legacyLease() },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
      recoverPreparedDelivery: async context => {
        contexts.push(context)
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive' }), deliverText: async () => ({ state: 'delivered' }) },
    )
    runtime.start()
    try {
      await waitFor(() => contexts.length === 1)
      const context = contexts[0]!
      expect.soft(Object.keys(context).sort()).toEqual([
        'claimedAt', 'gate', 'jobId', 'jobKind', 'runDeliveryMeaningPort',
        'runId', 'scheduledFor', 'sessionId', 'sessionMode', 'trigger',
      ])
      expect.soft(context.runDeliveryMeaningPort).toEqual(expect.any(Object))
      expect(prepareCalls).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      const lineage = readOwnerRecords(storeDir).filter(record => record.event === 'external-first-lineage')
      expect.soft(lineage).toHaveLength(1)
      expect.soft(lineage[0]?.claim).toEqual({
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
      })
      expect.soft(observed.bindings[0]).toEqual({
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
      })
      expect.soft(observed.ports[0]).toEqual(expect.any(Object))
      expect.soft(context.runDeliveryMeaningPort).toBe(observed.ports[0])
      if (observed.ports.length === 1) {
        await waitFor(() => observed.disposeCounts[0] === 1)
      }
      expect.soft(observed.disposeCounts).toEqual([1])
      await new Promise(resolve => setTimeout(resolve, 80))
      runtime.requestDrive()
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(contexts).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('records C1 before existing-prepared recovery settlement', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-existing-port-')
    const job = futureMarkedJob('scheduler-existing-port', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'existing-prepared-run',
      sessionId: 'existing-prepared-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'existing-object',
      text: 'existing prepared text',
    })
    const setupFactory = await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory
    const setupPort = await setupFactory.createRunPort({
      jobId: claim.jobId,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      claimedAt: claim.claimedAt,
      trigger: claim.trigger,
    })
    expect(setupPort.status).toBe('accepted')
    if (setupPort.status === 'accepted') {
      await setupPort.port.bindPreparedDelivery({
        businessRunId: 'existing-business',
        businessPeriodId: 'existing-period',
      })
      await setupPort.dispose()
    }
    ledger.claimDeliveryAttempt({
      schemaVersion: 2,
      event: 'delivery-attempt-claim',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      claimedAt: new Date().toISOString(),
      objectId: 'existing-object',
    })
    ledger.recordDeliveryReceipt({
      schemaVersion: 2,
      event: 'delivery-receipt',
      objectId: 'existing-object',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      deliveryState: 'delivered',
      deliveredAt: new Date().toISOString(),
      receiptAt: new Date().toISOString(),
    })
    const settlePorts: unknown[] = []
    let ownerRowsAtSettle: Array<Record<string, unknown>> = []
    let replayResult: unknown
    let receiptAtSettle: CronDeliveryReceipt | undefined
    let prepareCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { prepareCalls++; return legacyLease() },
      bindPreparedDelivery: async context => {
        await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'existing-business',
          businessPeriodId: 'existing-period',
        })
      },
      settleRecoveredDelivery: async (receipt, port) => {
        settlePorts.push(port)
        receiptAtSettle = receipt
        ownerRowsAtSettle = readOwnerRecords(storeDir)
        replayResult = await port!.acceptDurableReceipt(receipt)
        throw new Error('intentional existing recovery hold after C1 observation')
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    let sends = 0
    let drives = 0
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await waitFor(() => settlePorts.length === 1)
      expect(prepareCalls).toBe(0)
      expect(ownerRowsAtSettle.filter(record => record.event === 'run-delivery-meaning')).toHaveLength(1)
      expect(replayResult).toEqual({ status: 'accepted', value: { receipt: receiptAtSettle } })
      expect.soft(settlePorts).toHaveLength(1)
      expect.soft(settlePorts[0]).toEqual(expect.any(Object))
      expect(readRecords(storeDir).filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(readRecords(storeDir).filter(record => record.event === 'finish')).toHaveLength(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const lineage = readOwnerRecords(storeDir).filter(record => record.event === 'external-first-lineage')
      expect.soft(lineage).toHaveLength(1)
      expect.soft(lineage[0]?.claim).toEqual({
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
      })
      expect.soft(settlePorts[0]).toBe(observed.ports[0])
      expect.soft(observed.ports[0]).toEqual(expect.any(Object))
      expect.soft(observed.bindings[0]).toEqual({
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
      })
      if (observed.ports.length === 1) {
        await waitFor(() => observed.disposeCounts[0] === 1)
      }
      expect.soft(observed.disposeCounts).toEqual([1])
    } finally {
      await runtime.dispose()
    }
  })

  it('does not settle existing-prepared recovery when ack exists before C1 meaning', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-ack-before-meaning-')
    const job = futureMarkedJob('scheduler-c1-ack-before-meaning', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c1-ack-before-meaning-run',
      sessionId: 'scheduler-c1-ack-before-meaning-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c1-ack-before-meaning-object',
      text: 'scheduler c1 ack before meaning text',
    })
    const setupFactory = await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory
    const setupPort = await setupFactory.createRunPort({
      jobId: claim.jobId,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      claimedAt: claim.claimedAt,
      trigger: claim.trigger!,
    })
    expect(setupPort.status).toBe('accepted')
    if (setupPort.status === 'accepted') {
      await expect(setupPort.port.bindPreparedDelivery({
        businessRunId: 'scheduler-c1-ack-before-meaning-business',
        businessPeriodId: 'scheduler-c1-ack-before-meaning-period',
      })).resolves.toEqual({ status: 'accepted' })
      await setupPort.dispose()
    }
    ledger.claimDeliveryAttempt({
      schemaVersion: 2,
      event: 'delivery-attempt-claim',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      claimedAt: new Date().toISOString(),
      objectId: 'scheduler-c1-ack-before-meaning-object',
    })
    const receipt: RunDeliveryReceiptRecord = {
      schemaVersion: 2,
      event: 'delivery-receipt',
      objectId: 'scheduler-c1-ack-before-meaning-object',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      deliveryState: 'delivered',
      deliveredAt: new Date().toISOString(),
      receiptAt: new Date().toISOString(),
    }
    ledger.recordDeliveryReceipt(receipt)
    ledger.environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      objectId: receipt.objectId,
      jobId: receipt.jobId,
      runId: receipt.runId,
      sessionId: receipt.sessionId,
      scheduledFor: receipt.scheduledFor,
      deliveryState: receipt.deliveryState,
      deliveredAt: receipt.deliveredAt,
      settledAt: new Date().toISOString(),
    })
    const seededFold = ledger.foldJob(job.id)
    expect(seededFold.prefinishSettledDeliveries.has(claim.runId)).toBe(true)
    expect(seededFold.preparedDeliveries.has(claim.runId)).toBe(true)
    expect(seededFold.deliveryAttemptClaims.has(claim.runId)).toBe(true)
    expect(seededFold.deliveryReceipts.has(claim.runId)).toBe(true)
    expect(seededFold.interrupted.some(item => item.runId === claim.runId)).toBe(true)
    let settleCalls = 0
    let bindCalls = 0
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        bindCalls++
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-ack-before-meaning-business',
          businessPeriodId: 'scheduler-c1-ack-before-meaning-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await waitFor(() => observed.ports.length === 1)
      await waitFor(() => observed.disposeCounts[0] === 1)
      expect(bindCalls).toBe(1)
      expect(settleCalls).toBe(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'run-delivery-meaning')).toHaveLength(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a live run when owner B is corrupted before C1 and does not call pre-finish', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-live-corrupt-')
    const job = futureMarkedJob('scheduler-c1-live-corrupt', 'telegram')
    seedJob(storeDir, job)
    let hookCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c1-live-corrupt-object', text: 'scheduler c1 live corrupt text' },
        settleDeliveryBeforeFinish: async () => {
          hookCalls++
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-live-corrupt-business',
          businessPeriodId: 'scheduler-c1-live-corrupt-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => {
          sends++
          const ownerPath = join(storeDir, 'run-delivery-meaning.jsonl')
          const rows = readOwnerRecords(storeDir)
          const primaryIndex = rows.findIndex(record => record.event === 'primary-run-content-object')
          expect(primaryIndex).toBeGreaterThanOrEqual(0)
          const primary = rows[primaryIndex]!
          rows[primaryIndex] = { ...primary, objectId: 'scheduler-c1-live-corrupt-other-object' }
          writeFileSync(ownerPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
          return { state: 'delivered', deliveredAt: new Date().toISOString() }
        },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c1-live-corrupt' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => sends === 1)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(hookCalls).toBe(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: 'c1-live-corrupt-second' })
      expect(second.ok).toBe(false)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'run-delivery-meaning')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds claim-only recovery when owner B is corrupted before C1 and does not settle', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c1-recovery-corrupt-')
    const job = futureMarkedJob('scheduler-c1-recovery-corrupt', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c1-recovery-corrupt-run',
      sessionId: 'scheduler-c1-recovery-corrupt-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => ({
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: 'scheduler-c1-recovery-corrupt-object', text: 'scheduler c1 recovery corrupt text' },
      }),
      bindPreparedDelivery: async context => {
        const result = await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c1-recovery-corrupt-business',
          businessPeriodId: 'scheduler-c1-recovery-corrupt-period',
        })
        expect(result).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => {
          sends++
          const ownerPath = join(storeDir, 'run-delivery-meaning.jsonl')
          const rows = readOwnerRecords(storeDir)
          const primaryIndex = rows.findIndex(record => record.event === 'primary-run-content-object')
          expect(primaryIndex).toBeGreaterThanOrEqual(0)
          const primary = rows[primaryIndex]!
          rows[primaryIndex] = { ...primary, objectId: 'scheduler-c1-recovery-corrupt-other-object' }
          writeFileSync(ownerPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
          return { state: 'delivered', deliveredAt: new Date().toISOString() }
        },
      },
    )
    runtime.start()
    try {
      await waitFor(() => sends === 1)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(settleCalls).toBe(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: 'c1-recovery-corrupt-second' })
      expect(second.ok).toBe(false)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'run-delivery-meaning')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('calls live provider bind only after prepared row and before transport', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-live-bind-')
    const job = futureMarkedJob('scheduler-live-bind', 'telegram')
    seedJob(storeDir, job)
    const bindContexts: Array<{ readonly preparedDelivery: PreparedDeliveryObject; readonly runDeliveryMeaningPort: unknown }> = []
    const bindResults: unknown[] = []
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => preparedLease(
        { objectId: 'scheduler-live-bind-object', text: 'scheduler live bind text' },
        async () => ({ status: 'accepted' }),
      ),
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
      bindPreparedDelivery: async context => {
        bindContexts.push(context)
        const records = readRecords(storeDir)
        expect(Object.keys(context).sort()).toEqual(['preparedDelivery', 'runDeliveryMeaningPort'])
        expect(context.preparedDelivery).toEqual({ objectId: 'scheduler-live-bind-object', text: 'scheduler live bind text' })
        expect(context.runDeliveryMeaningPort).toBe(observed.ports[0])
        expect(Object.keys(context.runDeliveryMeaningPort).sort()).toEqual([
          'acceptDurableReceipt', 'bindPreparedDelivery', 'commitBusinessFinalization',
        ])
        expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
        expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
        expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
        expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
        bindResults.push(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-live-business',
          businessPeriodId: 'scheduler-live-period',
        }))
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive' }), deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'live-bind' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => bindContexts.length === 1)
      await waitFor(() => sends === 1)
      expect(bindResults).toEqual([{ status: 'accepted' }])
      const ownerRows = readOwnerRecords(storeDir)
      const claimRecord = readRecords(storeDir).find(record => record.event === 'claim')
      const primary = ownerRows.filter(record => record.event === 'primary-run-content-object')
      expect(primary).toHaveLength(1)
      expect(primary[0]).toMatchObject({
        claim: {
          jobId: claimRecord?.jobId,
          runId: claimRecord?.runId,
          sessionId: claimRecord?.sessionId,
          scheduledFor: claimRecord?.scheduledFor,
          claimedAt: claimRecord?.claimedAt,
          trigger: claimRecord?.trigger,
        },
        objectId: 'scheduler-live-bind-object',
        businessRunId: 'scheduler-live-business',
        businessPeriodId: 'scheduler-live-period',
      })
      expect(sends).toBe(1)
      expect(observed.ports).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('calls claim-only ready bind after appending prepared and before transport', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-recovery-bind-')
    const job = futureMarkedJob('scheduler-recovery-bind', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-recovery-bind-run',
      sessionId: 'scheduler-recovery-bind-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    const bindContexts: Array<{ readonly preparedDelivery: PreparedDeliveryObject; readonly runDeliveryMeaningPort: unknown }> = []
    const bindResults: unknown[] = []
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => ({
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: 'scheduler-recovery-bind-object', text: 'scheduler recovery bind text' },
      }),
      bindPreparedDelivery: async context => {
        bindContexts.push(context)
        const records = readRecords(storeDir)
        expect(Object.keys(context).sort()).toEqual(['preparedDelivery', 'runDeliveryMeaningPort'])
        expect(context.preparedDelivery).toEqual({ objectId: 'scheduler-recovery-bind-object', text: 'scheduler recovery bind text' })
        expect(context.runDeliveryMeaningPort).toBe(observed.ports[0])
        expect(Object.keys(context.runDeliveryMeaningPort).sort()).toEqual([
          'acceptDurableReceipt', 'bindPreparedDelivery', 'commitBusinessFinalization',
        ])
        expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
        expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
        expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
        bindResults.push(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-recovery-business',
          businessPeriodId: 'scheduler-recovery-period',
        }))
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await waitFor(() => bindContexts.length === 1)
      await waitFor(() => sends === 1)
      expect(bindResults).toEqual([{ status: 'accepted' }])
      expect(drives).toBe(0)
      expect(sends).toBe(1)
      const primary = readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-object')
      expect(primary).toHaveLength(1)
      expect(primary[0]).toMatchObject({
        claim: {
          jobId: claim.jobId,
          runId: claim.runId,
          sessionId: claim.sessionId,
          scheduledFor: claim.scheduledFor,
          claimedAt: claim.claimedAt,
          trigger: claim.trigger,
        },
        objectId: 'scheduler-recovery-bind-object',
        businessRunId: 'scheduler-recovery-business',
        businessPeriodId: 'scheduler-recovery-period',
      })
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('calls existing-prepared bind before recovery transport', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-existing-bind-')
    const job = futureMarkedJob('scheduler-existing-bind', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-existing-bind-run',
      sessionId: 'scheduler-existing-bind-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-existing-bind-object',
      text: 'scheduler existing bind text',
    })
    const bindContexts: Array<{ readonly preparedDelivery: PreparedDeliveryObject; readonly runDeliveryMeaningPort: unknown }> = []
    const bindResults: unknown[] = []
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        bindContexts.push(context)
        const records = readRecords(storeDir)
        expect(Object.keys(context).sort()).toEqual(['preparedDelivery', 'runDeliveryMeaningPort'])
        expect(context.preparedDelivery).toEqual({ objectId: 'scheduler-existing-bind-object', text: 'scheduler existing bind text' })
        expect(context.runDeliveryMeaningPort).toBe(observed.ports[0])
        expect(Object.keys(context.runDeliveryMeaningPort).sort()).toEqual([
          'acceptDurableReceipt', 'bindPreparedDelivery', 'commitBusinessFinalization',
        ])
        expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
        expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
        bindResults.push(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-existing-business',
          businessPeriodId: 'scheduler-existing-period',
        }))
      },
      settleRecoveredDelivery: async (_receipt, port) => {
        expect(port).toEqual(expect.any(Object))
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive' }), deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await waitFor(() => bindContexts.length === 1)
      await waitFor(() => sends === 1)
      expect(bindResults).toEqual([{ status: 'accepted' }])
      expect(sends).toBe(1)
      const primary = readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-object')
      expect(primary).toHaveLength(1)
      expect(primary[0]).toMatchObject({
        claim: {
          jobId: claim.jobId,
          runId: claim.runId,
          sessionId: claim.sessionId,
          scheduledFor: claim.scheduledFor,
          claimedAt: claim.claimedAt,
          trigger: claim.trigger,
        },
        objectId: 'scheduler-existing-bind-object',
        businessRunId: 'scheduler-existing-business',
        businessPeriodId: 'scheduler-existing-period',
      })
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds claim-only ready recovery when the provider bind hook is a no-op', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-recovery-bind-noop-')
    const job = futureMarkedJob('scheduler-recovery-bind-noop', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-recovery-bind-noop-run',
      sessionId: 'scheduler-recovery-bind-noop-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    let bindCalls = 0
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => ({
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: 'scheduler-recovery-bind-noop-object', text: 'scheduler recovery bind noop text' },
      }),
      bindPreparedDelivery: async context => {
        bindCalls++
        expect(Object.keys(context.runDeliveryMeaningPort!).sort()).toEqual([
          'acceptDurableReceipt', 'bindPreparedDelivery', 'commitBusinessFinalization',
        ])
        // This callback deliberately returns no accepted result and never calls
        // the real port. Scheduler must not infer B from callback completion.
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await waitFor(() => readRecords(storeDir).filter(record => record.event === 'prepared-delivery').length === 1)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(bindCalls).toBe(1)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-object')).toHaveLength(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: 'recovery-bind-noop-second' })
      expect(second.ok).toBe(false)
      expect(readRecords(storeDir).filter(record => record.event === 'claim')).toHaveLength(1)
      if (observed.ports.length === 1) await waitFor(() => observed.disposeCounts[0] === 1)
      expect(observed.disposeCounts).toEqual([1])
    } finally {
      await runtime.dispose()
    }
  })

  it('holds existing-prepared recovery when the real port rejects invalid business refs', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-existing-bind-rejected-')
    const job = futureMarkedJob('scheduler-existing-bind-rejected', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-existing-bind-rejected-run',
      sessionId: 'scheduler-existing-bind-rejected-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-existing-bind-rejected-object',
      text: 'scheduler existing bind rejected text',
    })
    let bindCalls = 0
    let settleCalls = 0
    let sends = 0
    let drives = 0
    const bindResults: unknown[] = []
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        bindCalls++
        expect(Object.keys(context.runDeliveryMeaningPort!).sort()).toEqual([
          'acceptDurableReceipt', 'bindPreparedDelivery', 'commitBusinessFinalization',
        ])
        bindResults.push(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: '',
          businessPeriodId: 'scheduler-existing-rejected-period',
        }))
        // A provider callback cannot turn the real rejected port result into
        // a durable B fact by returning a forged accepted value.
        return { status: 'accepted' }
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(bindCalls).toBe(1)
      expect(bindResults).toHaveLength(1)
      expect(bindResults[0]).toMatchObject({ status: 'rejected' })
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-object')).toHaveLength(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: 'existing-bind-rejected-second' })
      expect(second.ok).toBe(false)
      expect(readRecords(storeDir).filter(record => record.event === 'claim')).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
      expect(observed.disposeCounts).toEqual([1])
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    ['missing bind hook', 'missing'],
    ['bind hook throws', 'throws'],
    ['bind hook is a no-op', 'noop'],
    ['bind hook reports rejected from the real port', 'rejected'],
    ['bind hook returns a forged accepted result without calling the port', 'fake-accepted'],
  ] as const)('holds a live prepared run when provider B binding is %s', async (_name, mode) => {
    const storeDir = temporaryDirectory(`todo05-scheduler-bind-negative-${mode}-`)
    const job = futureMarkedJob(`scheduler-bind-negative-${mode}`, 'telegram')
    seedJob(storeDir, job)
    let bindCalls = 0
    let sends = 0
    let drives = 0
    const bindPreparedDelivery = mode === 'missing' ? undefined : async (context: {
      readonly preparedDelivery: PreparedDeliveryObject
      readonly runDeliveryMeaningPort: CronAgentEnvironmentPrepareContext['runDeliveryMeaningPort']
    }) => {
      bindCalls++
      if (mode === 'throws') throw new Error('provider bind failed')
      if (mode === 'noop') return
      if (mode === 'fake-accepted') return
      await context.runDeliveryMeaningPort!.bindPreparedDelivery({ businessRunId: '', businessPeriodId: 'rejected' })
    }
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => preparedLease(
        { objectId: `scheduler-bind-negative-${mode}-object`, text: `negative ${mode}` },
        async () => ({ status: 'accepted' }),
      ),
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
      ...(bindPreparedDelivery === undefined ? {} : { bindPreparedDelivery }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive' } }, deliverText: async () => { sends++ } },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: `negative-${mode}` })).resolves.toMatchObject({ ok: true })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(bindCalls).toBe(mode === 'missing' ? 0 : 1)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(0)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(0)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(records.filter(record => record.status === 'interrupted')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-object')).toHaveLength(0)
      runtime.requestDrive()
      const second = await runtime.runNow({ jobId: job.id, requestKey: `negative-${mode}-second` })
      expect(second.ok).toBe(false)
      expect(readRecords(storeDir).filter(record => record.event === 'claim')).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects a forged extra recovery context key before provider callback', async () => {
    let recoveryCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: 'scheduler-bridge/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => legacyLease(),
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
      recoverPreparedDelivery: async context => {
        recoveryCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const context: CronPreparedDeliveryRecoveryContext = {
      jobId: 'forged-job',
      runId: 'forged-run',
      sessionId: 'forged-session',
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
    }
    const result = await registry.recoverPreparedDelivery('scheduler-bridge/v1', {
      ...context,
      callerSelectedRunId: 'forged-run',
    } as CronPreparedDeliveryRecoveryContext & { readonly callerSelectedRunId: string })
    expect(result).toMatchObject({ ok: false })
    expect(recoveryCalls).toBe(0)
  })

  it('requires live pre-finish to commit C2 before technical acknowledgement and finish', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-live-positive-')
    const job = futureMarkedJob('scheduler-c2-live-positive', 'telegram')
    seedJob(storeDir, job)
    let hookCalls = 0
    let commitResult: unknown
    let c2RowsAtHook: Array<Record<string, unknown>> = []
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async context => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c2-live-object', text: 'scheduler c2 live text' },
        settleDeliveryBeforeFinish: async () => {
          hookCalls++
          commitResult = await context.runDeliveryMeaningPort.commitBusinessFinalization()
          c2RowsAtHook = readOwnerRecords(storeDir)
            .filter(record => record.event === 'primary-run-content-business-finalization')
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-live-business',
          businessPeriodId: 'scheduler-c2-live-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'scheduler c2 live output' }),
        deliverText: async () => ({ state: 'delivered', deliveredAt: new Date().toISOString() }),
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c2-live-positive' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => hookCalls === 1)
      expect(commitResult).toEqual({ status: 'accepted' })
      expect(c2RowsAtHook).toHaveLength(1)
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'finish'))
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a live run when pre-finish forges accepted without committing C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-live-forged-')
    const job = futureMarkedJob('scheduler-c2-live-forged', 'telegram')
    seedJob(storeDir, job)
    let hookCalls = 0
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c2-live-forged-object', text: 'scheduler c2 live forged text' },
        settleDeliveryBeforeFinish: async () => {
          hookCalls++
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-live-forged-business',
          businessPeriodId: 'scheduler-c2-live-forged-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => { drives++; return { text: 'must not drive' } },
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c2-live-forged' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => hookCalls === 1)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      expect(drives).toBe(0)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-live-forged-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a live run when C2 commit fails after the real B owner is corrupted', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-live-corrupt-')
    const job = futureMarkedJob('scheduler-c2-live-corrupt', 'telegram')
    seedJob(storeDir, job)
    let commitResult: unknown
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async context => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c2-live-corrupt-object', text: 'scheduler c2 live corrupt text' },
        settleDeliveryBeforeFinish: async () => {
          const ownerPath = join(storeDir, 'run-delivery-meaning.jsonl')
          const lines = readFileSync(ownerPath, 'utf8').trim().split('\n')
          const index = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event === 'primary-run-content-object')
          const row = JSON.parse(lines[index!]!) as Record<string, unknown>
          lines[index!] = JSON.stringify({ ...row, objectId: 'foreign-corrupt-object' })
          writeFileSync(ownerPath, `${lines.join('\n')}\n`, 'utf8')
          commitResult = await context.runDeliveryMeaningPort.commitBusinessFinalization()
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-live-corrupt-business',
          businessPeriodId: 'scheduler-c2-live-corrupt-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c2-live-corrupt' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => commitResult !== undefined)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(commitResult).toEqual({ status: 'failed', input: undefined })
      expect(sends).toBe(1)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-live-corrupt-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('rechecks the real C2 owner after the hook and holds when that owner is corrupted', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-live-post-corrupt-')
    const job = futureMarkedJob('scheduler-c2-live-post-corrupt', 'telegram')
    seedJob(storeDir, job)
    let commitResult: unknown
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async context => ({
        ...legacyLease(),
        preparedDelivery: { objectId: 'scheduler-c2-live-post-corrupt-object', text: 'scheduler c2 live post corrupt text' },
        settleDeliveryBeforeFinish: async () => {
          commitResult = await context.runDeliveryMeaningPort.commitBusinessFinalization()
          const ownerPath = join(storeDir, 'run-delivery-meaning.jsonl')
          const lines = readFileSync(ownerPath, 'utf8').trim().split('\n')
          const index = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event === 'primary-run-content-business-finalization')
          const row = JSON.parse(lines[index!]!) as Record<string, unknown>
          lines[index!] = JSON.stringify({ ...row, objectId: 'foreign-post-c2-object' })
          writeFileSync(ownerPath, `${lines.join('\n')}\n`, 'utf8')
          return { status: 'accepted' }
        },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-live-post-corrupt-business',
          businessPeriodId: 'scheduler-c2-live-post-corrupt-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' }),
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await expect(runtime.runNow({ jobId: job.id, requestKey: 'c2-live-post-corrupt' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => commitResult !== undefined)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(commitResult).toEqual({ status: 'accepted' })
      expect(sends).toBe(1)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-live-post-corrupt-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds claim-only recovery when settlement forges accepted without committing C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-recovery-forged-')
    const job = futureMarkedJob('scheduler-c2-recovery-forged', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-recovery-forged-run',
      sessionId: 'scheduler-c2-recovery-forged-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => ({
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: 'scheduler-c2-recovery-forged-object', text: 'scheduler c2 recovery forged text' },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-recovery-forged-business',
          businessPeriodId: 'scheduler-c2-recovery-forged-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-recovery-forged-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds existing-prepared recovery when settlement forges accepted without committing C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-existing-forged-')
    const job = futureMarkedJob('scheduler-c2-existing-forged', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-existing-forged-run',
      sessionId: 'scheduler-c2-existing-forged-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-existing-forged-object',
      text: 'scheduler c2 existing forged text',
    })
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-existing-forged-business',
          businessPeriodId: 'scheduler-c2-existing-forged-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-existing-forged-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(1)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('allows claim-only recovery to finish after the provider commits real C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-recovery-positive-')
    const job = futureMarkedJob('scheduler-c2-recovery-positive', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-recovery-positive-run',
      sessionId: 'scheduler-c2-recovery-positive-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    new RunLedger(storeDir).claim(claim)
    let settleCalls = 0
    let commitResult: unknown
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('claim-only recovery must not prepare') },
      recoverPreparedDelivery: async context => ({
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: 'scheduler-c2-recovery-positive-object', text: 'scheduler c2 recovery positive text' },
      }),
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: 'scheduler-c2-recovery-positive-business',
          businessPeriodId: 'scheduler-c2-recovery-positive-period',
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async (_receipt, port) => {
        settleCalls++
        commitResult = await port!.commitBusinessFinalization()
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'scheduler c2 recovery positive output' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      expect(commitResult).toEqual({ status: 'accepted' })
      expect(sends).toBe(1)
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'finish'))
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('does not resend an existing receipt when recovery replays real C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-existing-positive-')
    const job = futureMarkedJob('scheduler-c2-existing-positive', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-existing-positive-run',
      sessionId: 'scheduler-c2-existing-positive-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-existing-positive-object',
      text: 'scheduler c2 existing positive text',
    })
    const receipt = await seedExistingReceipt(storeDir, claim, 'scheduler-c2-existing-positive-object', true)
    let settleCalls = 0
    let commitResult: unknown
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: `${claim.runId}-business`,
          businessPeriodId: `${claim.runId}-period`,
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async (replayedReceipt, port) => {
        settleCalls++
        expect(replayedReceipt).toEqual(receipt)
        commitResult = await port!.commitBusinessFinalization()
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      expect(commitResult).toEqual({ status: 'accepted' })
      expect(sends).toBe(0)
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'finish'))
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(1)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds an existing receipt recovery when C2 is missing instead of acking or resending', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-existing-missing-')
    const job = futureMarkedJob('scheduler-c2-existing-missing', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-existing-missing-run',
      sessionId: 'scheduler-c2-existing-missing-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-existing-missing-object',
      text: 'scheduler c2 existing missing text',
    })
    await seedExistingReceipt(storeDir, claim, 'scheduler-c2-existing-missing-object', false)
    expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: `${claim.runId}-business`,
          businessPeriodId: `${claim.runId}-period`,
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await waitFor(() => settleCalls === 1)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-existing-missing-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0)
      expect(records.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('fails closed when existing ack and finish precede missing C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-existing-ack-before-')
    const job = futureMarkedJob('scheduler-c2-existing-ack-before', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-existing-ack-before-run',
      sessionId: 'scheduler-c2-existing-ack-before-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-existing-ack-before-object',
      text: 'scheduler c2 existing ack before text',
    })
    const receipt = await seedExistingReceipt(storeDir, claim, 'scheduler-c2-existing-ack-before-object', false)
    const settledAt = new Date(Date.parse(receipt.deliveredAt!) + 1_000).toISOString()
    ledger.environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...receipt,
      settledAt,
    } satisfies RunEnvironmentPrefinishSettleRecord)
    ledger.finish({
      schemaVersion: 2,
      event: 'finish',
      trigger: claim.trigger,
      runId: claim.runId,
      jobId: claim.jobId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      startedAt: claim.claimedAt,
      finishedAt: new Date(Date.parse(settledAt) + 1_000).toISOString(),
      status: 'success',
      deliveryState: receipt.deliveryState,
      deliveredAt: receipt.deliveredAt,
    } satisfies RunFinishRecord)
    const before = directoryBytes(storeDir)
    let prepareCalls = 0
    let recoverCalls = 0
    let bindCalls = 0
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => {
        prepareCalls++
        throw new Error('terminal prepared recovery must not prepare')
      },
      bindPreparedDelivery: async context => {
        bindCalls++
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: `${claim.runId}-business`,
          businessPeriodId: `${claim.runId}-period`,
        })).toEqual({ status: 'accepted' })
      },
      recoverPreparedDelivery: async () => {
        recoverCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(claim as CronPreparedDeliveryRecoveryContext) }
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 180))
      expect(directoryBytes(storeDir)).toEqual(before)
      const retry = await runtime.runNow({ jobId: job.id, requestKey: 'c2-terminal-missing-retry' })
      expect(retry).toMatchObject({ ok: false, code: 'job_active' })
      await new Promise(resolve => setTimeout(resolve, 180))
      expect(prepareCalls).toBe(0)
      expect(recoverCalls).toBe(0)
      expect(bindCalls).toBe(0)
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      expect(readRecords(storeDir).filter(record => record.event === 'claim')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'finish')).toHaveLength(1)
      expect(directoryBytes(storeDir)).toEqual(before)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('does not apply the C2 terminal guard to a legacy finished run', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-legacy-finished-')
    const job = futureMarkedJob('scheduler-c2-legacy-finished', 'silent')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-legacy-finished-run',
      sessionId: 'scheduler-c2-legacy-finished-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.finish({
      schemaVersion: 2,
      event: 'finish',
      trigger: claim.trigger,
      runId: claim.runId,
      jobId: claim.jobId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      startedAt: claim.claimedAt,
      finishedAt: new Date(Date.parse(claim.claimedAt) + 1_000).toISOString(),
      status: 'success',
      deliveryState: 'silent',
    } satisfies RunFinishRecord)
    const before = directoryBytes(storeDir)
    let prepareCalls = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => {
        prepareCalls++
        return { kind: 'skip', outcome: { text: undefined, error: undefined } }
      },
      settleRecoveredRun: async () => undefined,
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, undefined),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
    )
    runtime.start()
    try {
      await waitFor(() => readRecords(storeDir).some(record => record.event === 'environment-settle'))
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(directoryBytes(storeDir)).not.toEqual(before)
      expect(prepareCalls).toBe(0)
      expect(readRecords(storeDir).filter(record => record.event === 'finish')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'environment-settle')).toHaveLength(1)
      expect(readOwnerRecords(storeDir)).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a prepared finish-only terminal run before a new manual claim', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-finish-only-')
    const job = futureMarkedJob('scheduler-c2-finish-only', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-finish-only-run',
      sessionId: 'scheduler-c2-finish-only-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: claim.jobId,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-finish-only-object',
      text: 'scheduler c2 finish-only text',
    })
    const receipt = await seedExistingReceipt(storeDir, claim, 'scheduler-c2-finish-only-object', false)
    const settledAt = new Date(Date.parse(receipt.deliveredAt!) + 1_000).toISOString()
    ledger.environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...receipt,
      settledAt,
    } satisfies RunEnvironmentPrefinishSettleRecord)
    ledger.finish({
      schemaVersion: 2,
      event: 'finish',
      trigger: claim.trigger,
      runId: claim.runId,
      jobId: claim.jobId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      startedAt: claim.claimedAt,
      finishedAt: new Date(Date.parse(settledAt) + 1_000).toISOString(),
      status: 'success',
      deliveryState: receipt.deliveryState,
      deliveredAt: receipt.deliveredAt,
    } satisfies RunFinishRecord)
    const runsPath = join(storeDir, 'runs.jsonl')
    const finishOnly = readFileSync(runsPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '' && !line.includes('"event":"environment-prefinish-settle"'))
    writeFileSync(runsPath, `${finishOnly.join('\n')}\n`, 'utf8')
    const beforeHeldBytes = directoryBytes(storeDir)
    let prepareCalls = 0
    let recoverCalls = 0
    let bindCalls = 0
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => {
        prepareCalls++
        throw new Error('finish-only terminal must not prepare')
      },
      recoverPreparedDelivery: async () => {
        recoverCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(claim as CronPreparedDeliveryRecoveryContext) }
      },
      bindPreparedDelivery: async () => { bindCalls++ },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, await realFactory(storeDir)),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 180))
      const retry = await runtime.runNow({ jobId: job.id, requestKey: 'c2-finish-only-retry' })
      expect(retry).toMatchObject({ ok: false, code: 'job_active' })
      expect(prepareCalls).toBe(0)
      expect(recoverCalls).toBe(0)
      expect(bindCalls).toBe(0)
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      const recordsAfter = readRecords(storeDir)
      expect(recordsAfter.filter(record => record.event === 'claim' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(1)
      expect(recordsAfter.filter(record => record.event === 'prepared-delivery' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(1)
      expect(recordsAfter.filter(record => record.event === 'delivery-attempt-claim' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(1)
      expect(recordsAfter.filter(record => record.event === 'delivery-receipt' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(1)
      expect(recordsAfter.filter(record => record.event === 'environment-prefinish-settle' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(0)
      expect(recordsAfter.filter(record => record.event === 'finish' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(1)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization' && record.jobId === claim.jobId && record.runId === claim.runId)).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(beforeHeldBytes)
    } finally {
      await runtime.dispose()
    }
  })

  it('does not append finish when existing receipt and ack precede missing C2', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-existing-ack-no-finish-')
    const job = futureMarkedJob('scheduler-c2-existing-ack-no-finish', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-existing-ack-no-finish-run',
      sessionId: 'scheduler-c2-existing-ack-no-finish-session',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    const ledger = new RunLedger(storeDir)
    ledger.claim(claim)
    ledger.prepareDelivery({
      schemaVersion: 2,
      event: 'prepared-delivery',
      jobId: job.id,
      runId: claim.runId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      preparedAt: new Date().toISOString(),
      objectId: 'scheduler-c2-existing-ack-no-finish-object',
      text: 'scheduler c2 existing ack no finish text',
    })
    const receipt = await seedExistingReceipt(storeDir, claim, 'scheduler-c2-existing-ack-no-finish-object', false)
    const settledAt = new Date(Date.parse(receipt.deliveredAt!) + 1_000).toISOString()
    ledger.environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...receipt,
      settledAt,
    } satisfies RunEnvironmentPrefinishSettleRecord)
    const before = directoryBytes(storeDir)
    let settleCalls = 0
    let sends = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      preparedDeliveryLifecycle: true,
      runDeliveryMeaningLifecycle: true,
      prepare: async () => { throw new Error('existing prepared recovery must not prepare') },
      bindPreparedDelivery: async context => {
        expect(await context.runDeliveryMeaningPort.bindPreparedDelivery({
          businessRunId: `${claim.runId}-business`,
          businessPeriodId: `${claim.runId}-period`,
        })).toEqual({ status: 'accepted' })
      },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const registry = createCronAgentEnvironmentRegistry([provider])
    const observed = observeFactory(await realFactory(storeDir) as CronRunDeliveryMeaningPortFactory)
    const runtime = new SchedulerRuntime(
      schedulerContext(registry, observed.factory),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive' }),
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 180))
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      expect(readRecords(storeDir).filter(record => record.event === 'finish')).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(before)
      runtime.requestDrive()
      await runtime.runNow({ jobId: job.id, requestKey: 'c2-existing-ack-no-finish-retry' })
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toBe(0)
      expect(readRecords(storeDir).filter(record => record.event === 'claim')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'delivery-attempt-claim')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'delivery-receipt')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(1)
      expect(readRecords(storeDir).filter(record => record.event === 'finish')).toHaveLength(0)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(before)
      await waitFor(() => observed.disposeCounts[0] === 1)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a manual downgrade when a finished prepared owner is no longer opted in', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-manual-downgrade-')
    const job = futureMarkedJob('scheduler-c2-manual-downgrade', 'telegram')
    seedJob(storeDir, job)
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-manual-downgrade-run',
      sessionId: 'scheduler-c2-manual-downgrade-session',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      claimedAt: new Date(Date.now() - 59_000).toISOString(),
      trigger: 'manual',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
    }
    await seedPreparedTerminalRun(
      storeDir,
      claim,
      'scheduler-c2-manual-downgrade-object',
      'scheduler c2 manual downgrade text',
    )
    const before = directoryBytes(storeDir)
    let prepareCalls = 0
    let recoverCalls = 0
    let bindCalls = 0
    let settleCalls = 0
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => {
        prepareCalls++
        return { kind: 'skip', outcome: { text: undefined, error: undefined } }
      },
      recoverPreparedDelivery: async () => {
        recoverCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(claim as CronPreparedDeliveryRecoveryContext) }
      },
      bindPreparedDelivery: async () => { bindCalls++ },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const runtime = new SchedulerRuntime(
      schedulerContext(createCronAgentEnvironmentRegistry([provider]), undefined),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => { drives++; return { text: 'must not drive' } },
        deliverText: async () => { sends++ },
      },
    )
    try {
      const retry = await runtime.runNow({ jobId: job.id, requestKey: 'c2-manual-downgrade-retry' })
      expect(retry).toMatchObject({ ok: false, code: 'job_active' })
      await new Promise(resolve => setTimeout(resolve, 180))
      expect(prepareCalls).toBe(0)
      expect(recoverCalls).toBe(0)
      expect(bindCalls).toBe(0)
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish' && record.jobId === job.id)).toHaveLength(1)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization' && record.jobId === job.id)).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(before)
    } finally {
      await runtime.dispose()
    }
  })

  it('holds a due scheduled prepared terminal owner before appending a new claim', async () => {
    const storeDir = temporaryDirectory('todo05-scheduler-c2-scheduled-due-')
    const now = Date.now()
    const job = {
      ...futureMarkedJob('scheduler-c2-scheduled-due', 'telegram'),
      schedule: { kind: 'interval' as const, minutes: 1 },
      createdAt: new Date(now - 180_000).toISOString(),
    }
    seedJob(storeDir, job)
    const nextRunAt = new Date(now - 1_000).toISOString()
    const claim: RunClaimRecord = {
      schemaVersion: 2,
      event: 'claim',
      jobId: job.id,
      runId: 'scheduler-c2-scheduled-due-run',
      sessionId: 'scheduler-c2-scheduled-due-session',
      scheduledFor: new Date(now - 120_000).toISOString(),
      claimedAt: new Date(now - 119_000).toISOString(),
      trigger: 'scheduled',
      agentEnvironment: job.agentEnvironment,
      deliveryLifecycle: 'prepared',
      nextRunAt,
    }
    await seedPreparedTerminalRun(
      storeDir,
      claim,
      'scheduler-c2-scheduled-due-object',
      'scheduler c2 scheduled due text',
    )
    const before = directoryBytes(storeDir)
    let prepareCalls = 0
    let recoverCalls = 0
    let bindCalls = 0
    let settleCalls = 0
    let sends = 0
    let drives = 0
    const provider: CronAgentEnvironmentProvider = {
      marker: job.agentEnvironment!,
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => {
        prepareCalls++
        throw new Error('scheduled opt-out terminal must not prepare')
      },
      recoverPreparedDelivery: async () => {
        recoverCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(claim as CronPreparedDeliveryRecoveryContext) }
      },
      bindPreparedDelivery: async () => { bindCalls++ },
      settleRecoveredDelivery: async () => {
        settleCalls++
        return { status: 'accepted' }
      },
    }
    const runtime = new SchedulerRuntime(
      schedulerContext(createCronAgentEnvironmentRegistry([provider]), await realFactory(storeDir)),
      schedulerConfig(storeDir),
      {} as never,
      0,
      new AbortController().signal,
      {
        driveTurn: async () => { drives++; return { text: 'must not drive' } },
        deliverText: async () => { sends++ },
      },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 350))
      expect(prepareCalls).toBe(0)
      expect(recoverCalls).toBe(0)
      expect(bindCalls).toBe(0)
      expect(settleCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      const records = readRecords(storeDir)
      expect(records.filter(record => record.event === 'claim' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'prepared-delivery' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-attempt-claim' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'delivery-receipt' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'environment-prefinish-settle' && record.jobId === job.id)).toHaveLength(1)
      expect(records.filter(record => record.event === 'finish' && record.jobId === job.id)).toHaveLength(1)
      expect(readOwnerRecords(storeDir).filter(record => record.event === 'primary-run-content-business-finalization' && record.jobId === job.id)).toHaveLength(0)
      expect(directoryBytes(storeDir)).toEqual(before)
    } finally {
      await runtime.dispose()
    }
  })
})
