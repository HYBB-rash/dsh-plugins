/**
 * TODO05 RED contract for durable Formal Feed delivery.
 *
 * This file intentionally exercises dsh-cron's real SchedulerRuntime,
 * RunLedger, provider registry, and default chunking delivery seam. It does
 * not implement a second reducer. Its lifecycle records and pre-finish hook
 * are observed from dsh-cron's durable production seam; no test-local ledger
 * or recovery reducer is used.
 *
 * This suite proves only dsh-cron's technical prepared/attempt/receipt/
 * prefinish/finish lifecycle through public scheduler/provider seams. C20's
 * receiver/carrier is dsh-cron's RunOpportunityLifecycle; C21/C23 remain the
 * later Personal Feed-to-run collaboration mapping and are deliberately not
 * claimed here.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TelegramApiError } from '@deepseek-ai/dsh-telegram-gateway'
import {
  CRON_AGENT_ENVIRONMENT_REGISTRY,
  createCronAgentEnvironmentRegistry,
  type CronDeliveryReceipt,
  toCronPreparedDeliveryClaimBinding,
  type CronAgentEnvironmentProvider,
} from '../src/index.ts'
import type { CronAgentEnvironmentLease } from '../src/run-environment.ts'
import { CLAIM_RETRY_DELAY_MS, SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { JobStore, RunLedger } from '../src/store.ts'
import {
  DELIVERY_ATTEMPT_CLAIM_EVENT,
  DELIVERY_RECEIPT_EVENT,
  ENVIRONMENT_PREFINISH_SETTLE_EVENT,
  PREPARED_DELIVERY_EVENT,
} from '../src/types.ts'
import type {
  Job,
  RunClaimRecord,
  RunHistoryRecord,
} from '../src/types.ts'

const directories: string[] = []


function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cron-todo05-prefinish-'))
  directories.push(directory)
  return directory
}

function records(directory: string): Array<Record<string, unknown>> {
  const file = join(directory, 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function seedJob(directory: string, job: Job): void {
  new JobStore(directory).append({ op: 'create', ...job })
}

function seedRecords(directory: string, values: readonly RunHistoryRecord[]): void {
  writeFileSync(join(directory, 'runs.jsonl'), `${values.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}

function validDeliveryRecord(
  event: string,
  jobId: string,
  runId: string,
  state: CronDeliveryReceipt['deliveryState'] | undefined,
  extra: Record<string, unknown> = {},
): RunHistoryRecord {
  return {
    schemaVersion: 2,
    event,
    jobId,
    runId,
    sessionId: `session-cron-run-${jobId}`,
    scheduledFor: '2026-08-24T00:00:00.000Z',
    objectId: `formal:${jobId}`,
    ...(state === undefined ? {} : { deliveryState: state }),
    ...(event === PREPARED_DELIVERY_EVENT ? { preparedAt: '2026-08-24T00:00:02.000Z' } : {}),
    ...(event === DELIVERY_RECEIPT_EVENT ? { receiptAt: '2026-08-24T00:00:02.000Z' } : {}),
    ...(event === ENVIRONMENT_PREFINISH_SETTLE_EVENT ? { settledAt: '2026-08-24T00:00:03.000Z' } : {}),
    ...extra,
  }
}

function baseConfig(directory: string): SchedulerConfig {
  return {
    storeDir: directory,
    apiBaseUrl: 'https://api.telegram.org',
    tokenRef: 'TELEGRAM_BOT_TOKEN',
    chatIdRef: 'TELEGRAM_ALLOWED_CHAT_ID',
    pollIntervalMs: 60_000,
    maxConcurrent: 1,
    deliverOnError: true,
  }
}

function dueOnceJob(id: string, overrides: Partial<Extract<Job, { readonly kind?: undefined }>> = {}): Job {
  return {
    id,
    schedule: { kind: 'once', runAt: new Date(Date.now() - 60_000).toISOString() },
    prompt: 'TODO05 formal feed body',
    deliver: 'telegram',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function markedJob(id: string, overrides: Partial<Extract<Job, { readonly kind?: undefined }>> = {}): Job {
  return {
    ...dueOnceJob(id),
    sessionMode: 'per_run',
    agentEnvironment: 'todo05-prefinish/v1',
    ...overrides,
  }
}

function contextFor(
  events: Array<{ readonly name: string; readonly payload: unknown }>,
  registry?: ReturnType<typeof createCronAgentEnvironmentRegistry>,
  warnings?: string[],
) {
  const agent = {
    session: { seq: 0, events: [] },
    status: 'idle' as const,
    followup: () => undefined,
    whenIdle: async () => undefined,
  }
  const agents = {
    get: () => undefined,
    create: async (options: Record<string, unknown>) => {
      await (options.setup as ((value: unknown) => unknown) | undefined)?.({ on: () => () => undefined })
      return { agent, dispose: async () => undefined }
    },
    resume: async () => ({ agent, dispose: async () => undefined }),
  }
  return {
    get: (name: string) => {
      if (name === CRON_AGENT_ENVIRONMENT_REGISTRY) return registry
      if (name === 'agents') return agents
      if (name === 'sessions') return { flush: async () => undefined }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) }
      if (name === 'sessionPersistence') return { list: async () => [] }
      return undefined
    },
    logger: {
      info: () => undefined,
      warn: (...args: unknown[]) => {
        if (warnings !== undefined) warnings.push(args.map(value => String(value)).join(' '))
      },
      error: () => undefined,
    },
    parallel: async (name: string, payload: unknown) => {
      events.push({ name, payload })
    },
  } as never
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('TODO05 test waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function providerWithLease(
  prepareLease: () => CronAgentEnvironmentLease & Record<string, unknown>,
  overrides: Partial<CronAgentEnvironmentProvider> = {},
): CronAgentEnvironmentProvider {
  return {
    marker: 'todo05-prefinish/v1',
    preparedDeliveryLifecycle: true,
    requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
    prepare: async () => prepareLease() as never,
    ...overrides,
  }
}

function claimRecord(jobId: string, runId = `${jobId}@seed`): RunClaimRecord {
  return {
    schemaVersion: 2,
    event: 'claim',
    runId,
    jobId,
    sessionId: `session-cron-run-${jobId}`,
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    agentEnvironment: 'todo05-prefinish/v1',
    deliveryLifecycle: 'prepared',
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('TODO05 technical durable pre-finish lifecycle', () => {
  it('RunLedger allows exact claim replay but rejects conflicting identity and preserves the first claim', () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-claim-conflict'
    const runId = `${jobId}@seed`
    const original = claimRecord(jobId, runId)
    const ledger = new RunLedger(directory)

    expect(ledger.claim(original)).toBe('claimed')
    expect(ledger.claim({ ...original })).toBe('already_claimed')
    expect(() => ledger.claim({ ...original, sessionId: 'session-conflict' })).toThrow(/conflicting claim/u)
    expect(ledger.foldJob(jobId).interrupted).toEqual([original])

    const duplicateDirectory = temporaryDirectory()
    const firstProjection = {
      ...original,
      trigger: 'scheduled' as const,
      nextRunAt: '2026-08-24T00:02:00.000Z',
    }
    const conflictingProjection = {
      ...firstProjection,
      trigger: 'manual' as const,
      nextRunAt: undefined,
      agentEnvironment: 'other-prefinish/v2',
    }
    seedRecords(duplicateDirectory, [firstProjection, conflictingProjection])
    const folded = new RunLedger(duplicateDirectory).foldJob(jobId)
    expect(folded.interrupted).toEqual([firstProjection])
    expect(folded.claimConflicts.has(runId)).toBe(true)
    expect(folded.claims.get(runId)).toMatchObject({
      trigger: 'scheduled',
      nextRunAt: firstProjection.nextRunAt,
      agentEnvironment: firstProjection.agentEnvironment,
      deliveryLifecycle: firstProjection.deliveryLifecycle,
    })
    expect(folded.nextRunAt).toBe(firstProjection.nextRunAt)
  })

  it('prepared finish requires an exact prefinish acknowledgement while legacy finish stays compatible', () => {
    const preparedDirectory = temporaryDirectory()
    const jobId = 'todo05-finish-ack-guard'
    const runId = `${jobId}@seed`
    const claim = {
      ...claimRecord(jobId, runId),
      nextRunAt: '2026-08-24T00:02:00.000Z',
    }
    seedRecords(preparedDirectory, [claim])
    const finish = {
      schemaVersion: 2 as const,
      event: 'finish' as const,
      runId,
      jobId,
      sessionId: claim.sessionId,
      scheduledFor: claim.scheduledFor,
      startedAt: claim.claimedAt,
      finishedAt: '2026-08-24T00:00:04.000Z',
      status: 'success' as const,
      nextRunAt: claim.nextRunAt,
    }
    expect(() => new RunLedger(preparedDirectory).finish(finish)).toThrow(/prefinish/u)

    const legacyDirectory = temporaryDirectory()
    const legacyClaim: RunClaimRecord = {
      ...claim,
      agentEnvironment: undefined,
      deliveryLifecycle: undefined,
    }
    seedRecords(legacyDirectory, [legacyClaim])
    expect(() => new RunLedger(legacyDirectory).finish({ ...finish, sessionId: legacyClaim.sessionId })).not.toThrow()
    expect(new RunLedger(legacyDirectory).foldJob(jobId).unsettledFinishes).toHaveLength(1)
  })

  it('malformed prepared claim evidence is invalid and cannot create a replacement claim', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-malformed-prepared-claim'
    const runId = `${jobId}@seed`
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [{
      ...claimRecord(jobId, runId),
      deliveryLifecycle: undefined,
    }])
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:malformed-claim', text: 'must stay held' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 5_300))
      const state = records(directory)
      const projection = new RunLedger(directory).foldJob(jobId)
      expect(projection.invalidLifecycleRunIds.has(runId)).toBe(true)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  it('opt-in provider persists attempt claim and trusted receipt before business hook, then finishes only after hook', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('todo05-order'))
    const order: string[] = []
    const prepared = { objectId: 'formal:todo05-order', text: 'prepared exact formal Feed body' }
    const observed = {
      preparedBeforeTransport: false,
      attemptClaimBeforeTransport: false,
      receiptBeforeHook: false,
      prefinishAckBeforeHook: false,
      finishBeforeHook: false,
    }
    const events: Array<{ readonly name: string; readonly payload: unknown }> = []
    let hookCalls = 0
    let driveCalls = 0
    let providerSawDurablePreparedClaim = false
    let disposeCalls = 0
    const deliveredBodies: string[] = []
    const leaseFactory = () => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async receipt => {
        hookCalls++
        order.push('prefinish-settle')
        const current = records(directory)
        observed.receiptBeforeHook = current.some(record => record.event === DELIVERY_RECEIPT_EVENT)
        observed.prefinishAckBeforeHook = current.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)
        observed.finishBeforeHook = current.some(record => record.event === 'finish')
        expect(disposeCalls).toBe(0)
        expect(receipt).toMatchObject({
          jobId: 'todo05-order',
          runId: expect.any(String),
          sessionId: expect.any(String),
          scheduledFor: expect.any(String),
          deliveryState: expect.stringMatching(/^(delivered|failed|uncertain)$/u),
        })
        return { status: 'accepted' as const }
      },
      dispose: async () => { disposeCalls++ },
    })
    const provider = providerWithLease(leaseFactory, {
      prepare: async context => {
        const claim = records(directory).find(record => record.event === 'claim' && record.runId === context.runId)
        providerSawDurablePreparedClaim = claim?.agentEnvironment === 'todo05-prefinish/v1'
          && claim?.deliveryLifecycle === 'prepared'
          && typeof claim?.sessionId === 'string'
          && claim.sessionId.startsWith('session-cron-run-')
          && claim?.scheduledFor === context.scheduledFor
        return leaseFactory() as never
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const registry = createCronAgentEnvironmentRegistry([provider])
    const runtime = new SchedulerRuntime(
      contextFor(events, registry),
      baseConfig(directory),
      {
        sendMessage: async (_chatId: number, body: string) => {
          order.push('transport')
          deliveredBodies.push(body)
          observed.preparedBeforeTransport = records(directory).some(
            record => record.event === 'prepared-delivery'
              && record.objectId === prepared.objectId
              && record.text === prepared.text,
          )
          observed.attemptClaimBeforeTransport = records(directory).some(
            record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT,
          )
          return { messageId: 1 }
        },
      } as never,
      1,
      new AbortController().signal,
      {
        driveTurn: async () => {
          driveCalls++
          return { text: 'forbidden legacy outcome must not be delivered', error: undefined }
        },
      },
    )

    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish') && disposeCalls === 1)
      expect(driveCalls).toBe(0)
      expect(deliveredBodies).toEqual([prepared.text])
      expect(observed.preparedBeforeTransport).toBe(true)
      expect(observed.attemptClaimBeforeTransport).toBe(true)
      expect(observed.receiptBeforeHook).toBe(true)
      expect(observed.prefinishAckBeforeHook).toBe(false)
      expect(observed.finishBeforeHook).toBe(false)
      expect(providerSawDurablePreparedClaim).toBe(true)
      expect(hookCalls).toBe(1)
      expect(disposeCalls).toBe(1)
      expect(order.indexOf('transport')).toBeLessThan(order.indexOf('prefinish-settle'))
      const state = records(directory)
      expect(state.filter(record => record.event === 'prepared-delivery')).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(records(directory).filter(record => record.event === 'finish')).toHaveLength(1)
      expect(state.some(record => record.event === 'environment-settle')).toBe(false)
      const appendOrder = state.map(record => record.event)
      expect(new Set(state
        .filter(record => [PREPARED_DELIVERY_EVENT, DELIVERY_ATTEMPT_CLAIM_EVENT, DELIVERY_RECEIPT_EVENT, ENVIRONMENT_PREFINISH_SETTLE_EVENT].includes(String(record.event)))
        .map(record => record.objectId))).toEqual(new Set([prepared.objectId]))
      expect(appendOrder.indexOf('prepared-delivery')).toBeLessThan(appendOrder.indexOf(DELIVERY_ATTEMPT_CLAIM_EVENT))
      expect(appendOrder.indexOf(DELIVERY_ATTEMPT_CLAIM_EVENT)).toBeLessThan(appendOrder.indexOf(DELIVERY_RECEIPT_EVENT))
      expect(appendOrder.indexOf(DELIVERY_RECEIPT_EVENT)).toBeLessThan(appendOrder.indexOf(ENVIRONMENT_PREFINISH_SETTLE_EVENT))
      expect(appendOrder.indexOf(ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBeLessThan(appendOrder.indexOf('finish'))
      const receipt = state.find(record => record.event === DELIVERY_RECEIPT_EVENT)
      const prefinishAck = state.find(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)
      const finish = state.find(record => record.event === 'finish')
      expect(Date.parse(String(receipt?.receiptAt))).toBeLessThanOrEqual(Date.parse(String(prefinishAck?.settledAt)))
      expect(Date.parse(String(prefinishAck?.settledAt))).toBeLessThanOrEqual(Date.parse(String(finish?.finishedAt)))
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    ['prepared object without prefinish hook', () => ({
      preparedDelivery: { objectId: 'formal:partial-hook', text: 'must not send' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      dispose: async () => undefined,
    })],
    ['prefinish hook without prepared object', () => ({
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    })],
  ])('%s fails closed before any side effect', async (_name, leaseFactory) => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob(`todo05-partial-${String(_name).replaceAll(' ', '-')}`))
    let sends = 0
    let drives = 0
    const provider = providerWithLease(leaseFactory)
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'legacy must not run', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('invalid prepared pair disposes the returned lease exactly once before holding', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-invalid-pair-dispose'
    seedJob(directory, markedJob(jobId))
    let disposeCalls = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:invalid-pair-dispose', text: 'must remain held' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      dispose: async () => { disposeCalls++ },
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(disposeCalls).toBe(1)
      expect(records(directory).some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it.each(['rejected', 'throws'] as const)('prefinish %s writes no technical ack or generic finish and disposes once', async mode => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('todo05-prefinish-rejected'))
    let disposeCalls = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:rejected', text: 'receipt exists but hook rejects' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => {
        if (mode === 'throws') throw new Error('controlled prefinish failure')
        return { status: 'rejected' as const }
      },
      dispose: async () => { disposeCalls++ },
    }), {
      settleRecoveredDelivery: async () => ({ status: 'rejected' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === DELIVERY_RECEIPT_EVENT))
      await new Promise(resolve => setTimeout(resolve, 80))
      const state = records(directory)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(disposeCalls).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('prepared opt-in cannot combine technical prefinish and legacy post-finish hooks', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('todo05-double-settle'))
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:double-settle', text: 'must fail closed' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      settleRun: async () => undefined,
      dispose: async () => undefined,
    }))
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('prepared provider prepare failure is held without error delivery or generic finish', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-prepared-prepare-failure'
    seedJob(directory, markedJob(jobId))
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:prepare-failure', text: 'never send' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      prepare: async () => { throw new Error('provider preparation failed') },
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('prepared provider returning a legacy lease fails closed before Agent or error delivery', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-prepared-legacy-lease'
    seedJob(directory, markedJob(jobId))
    const provider = providerWithLease(() => ({
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('unmarked provider returning a prepared pair fails closed before lifecycle or Agent side effects', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-unmarked-prepared-pair'
    seedJob(directory, markedJob(jobId))
    const provider = {
      marker: 'todo05-prefinish/v1',
      preparedDeliveryLifecycle: false,
      requirements: { jobKind: 'agent' as const, sessionMode: 'per_run' as const, gate: 'forbidden' as const },
      prepare: async () => ({
        preparedDelivery: { objectId: 'formal:unmarked', text: 'never send' },
        setupAgent: async () => undefined,
        verifySurface: async () => undefined,
        settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
        dispose: async () => undefined,
      }),
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    } satisfies CronAgentEnvironmentProvider
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('prepared opt-in cannot use typed skip as a generic finish shortcut', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-prepared-skip'
    seedJob(directory, markedJob(jobId))
    const provider = providerWithLease(() => ({
      kind: 'skip',
      outcome: { text: undefined, error: undefined },
    }) as never, {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('prepared opt-in without a recovery counterpart fails before any side effect', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('todo05-missing-recovery-counterpart'))
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:missing-recovery', text: 'must never send' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }))
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('partial interval opt-in remains held across runtime reconstruction', async () => {
    const directory = temporaryDirectory()
    const job = markedJob('todo05-partial-restart', {
      schedule: { kind: 'interval', minutes: 1 },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    })
    seedJob(directory, job)
    const runId = `${job.id}@seed`
    seedRecords(directory, [{
      ...claimRecord(job.id, runId),
      agentEnvironment: 'todo05-prefinish/v1',
      deliveryLifecycle: 'prepared',
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    }])
    let disposeCalls = 0
    const partialProvider = providerWithLease(() => ({
      preparedDelivery: { objectId: 'formal:partial-restart', text: 'must remain held' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      // Deliberately omit the live pre-finish hook: this is the sole invalidity.
      dispose: async () => { disposeCalls++ },
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([partialProvider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      // Recovery backoff is 5 seconds. The seeded claim is already due, so
      // waiting beyond it proves a restart cannot create a second scheduled
      // claim while the prepared lifecycle is unresolved.
      await new Promise(resolve => setTimeout(resolve, 5_300))
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(disposeCalls).toBe(0)
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  async function runRecoveryCase(
    jobId: string,
    seed: readonly RunHistoryRecord[],
    options: { readonly hookStatus?: 'accepted' | 'rejected'; readonly waitForFinish?: boolean; readonly assertObjectIdentity?: boolean; readonly jobOverrides?: Partial<Extract<Job, { readonly kind?: undefined }>> } = {},
  ): Promise<{ readonly directory: string; readonly sends: number; readonly drives: number; readonly hooks: number }> {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob(jobId, options.jobOverrides ?? {}))
    seedRecords(directory, seed)
    const events: Array<{ readonly name: string; readonly payload: unknown }> = []
    const prepared = { objectId: `formal:${jobId}`, text: 'prepared formal Feed body' }
    let sends = 0
    let drives = 0
    let hooks = 0
    const completePrefinish = async (receipt: CronDeliveryReceipt): Promise<{ readonly status: 'accepted' | 'rejected' }> => {
      hooks++
      const state = records(directory)
      expect(state).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: DELIVERY_RECEIPT_EVENT, deliveryState: receipt.deliveryState }),
      ]))
      return { status: options.hookStatus ?? 'accepted' }
    }
    const provider = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: completePrefinish,
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: completePrefinish,
    })
    const runtime = new SchedulerRuntime(
      contextFor(events, createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: prepared.text, error: undefined } } },
    )
    runtime.start()
    if (options.waitForFinish !== false) {
      await waitFor(() => records(directory).some(record => record.event === 'finish'))
    } else {
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    const lifecycleObjectIds = records(directory)
      .filter(record => [PREPARED_DELIVERY_EVENT, DELIVERY_ATTEMPT_CLAIM_EVENT, DELIVERY_RECEIPT_EVENT, ENVIRONMENT_PREFINISH_SETTLE_EVENT].includes(String(record.event)))
      .map(record => record.objectId)
    expect(records(directory).some(record => record.event === 'environment-settle')).toBe(false)
    if (options.assertObjectIdentity !== false) {
      expect(new Set(lifecycleObjectIds)).toEqual(new Set([prepared.objectId]))
    }
    await runtime.dispose()
    return { directory, sends, drives, hooks }
  }

  it('a. persisted formal object without attempt claim delivers once, settles, then finishes', async () => {
    const jobId = 'todo05-recover-a'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord('prepared-delivery', jobId, runId, undefined, {
        objectId: `formal:${jobId}`,
        text: 'prepared formal Feed body',
      }),
    ])
    const state = records(result.directory)
    expect(result.drives).toBe(0)
    expect(result.sends).toBe(1)
    expect(result.hooks).toBe(1)
    expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
    expect(state.findIndex(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT))
      .toBeLessThan(state.findIndex(record => record.event === 'finish'))
    expect(state.filter(record => record.event === 'finish').at(-1)).toMatchObject({ event: 'finish', status: 'success' })
  })

  it('b. attempt claim without receipt synthesizes Uncertain, settles once, then finishes', async () => {
    const jobId = 'todo05-recover-b'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord('prepared-delivery', jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'prepared formal Feed body' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
    ])
    const state = records(result.directory)
    expect(result.drives).toBe(0)
    expect(result.sends).toBe(0)
    expect(result.hooks).toBe(1)
    expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
    expect(state.find(record => record.event === DELIVERY_RECEIPT_EVENT)).toMatchObject({ deliveryState: 'uncertain' })
    expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish').at(-1)).toMatchObject({ event: 'finish', status: 'success' })
  })

  it('c. receipt without prefinish ack replays only settlement, then appends finish', async () => {
    const jobId = 'todo05-recover-c'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord('prepared-delivery', jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'prepared formal Feed body' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered', { messageId: 7 }),
    ])
    const state = records(result.directory)
    expect(result.drives).toBe(0)
    expect(result.sends).toBe(0)
    expect(result.hooks).toBe(1)
    expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish').at(-1)).toMatchObject({ event: 'finish', status: 'success' })
  })

  it('d. prefinish ack without finish performs no delivery or hook and only appends finish', async () => {
    const jobId = 'todo05-recover-d'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord('prepared-delivery', jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'prepared formal Feed body' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'uncertain'),
      validDeliveryRecord(ENVIRONMENT_PREFINISH_SETTLE_EVENT, jobId, runId, 'uncertain', { settledAt: '2026-08-24T00:00:03.000Z' }),
    ])
    const state = records(result.directory)
    expect(result.drives).toBe(0)
    expect(result.sends).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
    expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
    expect(state.findIndex(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT))
      .toBeLessThan(state.findIndex(record => record.event === 'finish'))
    expect(state.filter(record => record.event === 'finish').at(-1)).toMatchObject({ event: 'finish', status: 'success' })
  })

  it('acknowledged recovery retries a failed finish append without re-sending or re-running the hook', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-recover-finish-append-failure'
    const runId = `${jobId}@seed`
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'finish retry body' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
      validDeliveryRecord(ENVIRONMENT_PREFINISH_SETTLE_EVENT, jobId, runId, 'delivered'),
    ])
    let sends = 0
    let drives = 0
    let hooks = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: `formal:${jobId}`, text: 'finish retry body' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => { hooks++; return { status: 'accepted' as const } },
    })
    const finishSpy = vi.spyOn(RunLedger.prototype, 'finish')
      .mockImplementationOnce(() => { throw new Error('controlled finish append failure') })
    const makeRuntime = () => new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    const first = makeRuntime()
    try {
      first.start()
      await new Promise(resolve => setTimeout(resolve, 300))
      const held = records(directory)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(hooks).toBe(0)
      expect(held.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(held.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(held.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(held.filter(record => record.event === 'finish')).toHaveLength(0)
      await first.dispose()

      await new Promise(resolve => setTimeout(resolve, 5_300))
      const second = makeRuntime()
      try {
        second.start()
        await waitFor(() => records(directory).some(record => record.event === 'finish'), 3_000)
        const completed = records(directory)
        expect(sends).toBe(0)
        expect(drives).toBe(0)
        expect(hooks).toBe(0)
        expect(completed.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === 'finish')).toHaveLength(1)
        expect(finishSpy).toHaveBeenCalledTimes(2)
      } finally {
        await second.dispose()
      }
    } finally {
      finishSpy.mockRestore()
      await first.dispose()
    }
  }, 12_000)

  it('recovery rejected hook leaves the old receipt unfinished and never marks interrupted', async () => {
    const jobId = 'todo05-recover-rejected'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'recovery hook rejects' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
    ], { hookStatus: 'rejected', waitForFinish: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(1)
    expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('unfinished prepared recovery blocks a new scheduled claim for the same job', async () => {
    const jobId = 'todo05-recover-block-new-claim'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'old receipt needs settlement' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
    ], {
      hookStatus: 'rejected',
      waitForFinish: false,
      jobOverrides: {
        schedule: { kind: 'interval', minutes: 1 },
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      },
    })
    const state = records(result.directory)
    expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('mixed prepared recovery requires a prepared row for every declared run', async () => {
    const jobId = 'todo05-recover-mixed-missing-prepared'
    const firstRunId = `${jobId}@first`
    const secondRunId = `${jobId}@second`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, firstRunId),
      claimRecord(jobId, secondRunId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, firstRunId, undefined, {
        objectId: `formal:${jobId}`,
        text: 'only the first run has a prepared object',
      }),
    ], { waitForFinish: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.filter(record => record.event === 'claim')).toHaveLength(2)
    expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
    expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
    expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('prepared rows attached to an orphan or legacy claim fail closed', async () => {
    const jobId = 'todo05-recover-orphan-prepared'
    const runId = `${jobId}@legacy`
    const legacyClaim: RunClaimRecord = {
      ...claimRecord(jobId, runId),
      agentEnvironment: undefined,
      deliveryLifecycle: undefined,
    }
    const result = await runRecoveryCase(jobId, [
      legacyClaim,
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, {
        objectId: `formal:${jobId}`,
        text: 'must not attach to a legacy claim',
      }),
    ], { waitForFinish: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
    expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('recovery lifecycle conflict fails closed without send, hook, ack, finish, or interrupted marker', async () => {
    const jobId = 'todo05-recover-conflict'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'first object' }),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}-conflict`, text: 'second object' }),
    ], { waitForFinish: false, assertObjectIdentity: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
    expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
    expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('receipt without the matching attempt claim is not recoverable', async () => {
    const jobId = 'todo05-recover-missing-attempt'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'missing attempt' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
    ], { waitForFinish: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it('acknowledgement with a different receipt state is not recoverable', async () => {
    const jobId = 'todo05-recover-ack-conflict'
    const runId = `${jobId}@seed`
    const result = await runRecoveryCase(jobId, [
      claimRecord(jobId, runId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, { objectId: `formal:${jobId}`, text: 'ack conflict' }),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
      validDeliveryRecord(ENVIRONMENT_PREFINISH_SETTLE_EVENT, jobId, runId, 'uncertain'),
    ], { waitForFinish: false, assertObjectIdentity: false })
    const state = records(result.directory)
    expect(result.sends).toBe(0)
    expect(result.drives).toBe(0)
    expect(result.hooks).toBe(0)
    expect(state.some(record => record.event === 'finish')).toBe(false)
    expect(state.some(record => record.status === 'interrupted')).toBe(false)
  })

  it.each([
    ['blank text', { objectId: 'formal:blank-text', text: '   ' }],
    ['oversized text', { objectId: 'formal:oversized-text', text: 'x'.repeat(65_537) }],
    ['padded object id', { objectId: ' formal:padded ', text: 'valid text' }],
    ['oversized object id', { objectId: 'x'.repeat(1_025), text: 'valid text' }],
  ] as const)('%s is rejected before prepared lifecycle or transport', async (_name, prepared) => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob(`todo05-invalid-${String(_name).replaceAll(' ', '-')}`))
    let sends = 0
    let disposeCalls = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => { disposeCalls++ },
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      const state = records(directory)
      expect(sends).toBe(0)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(disposeCalls).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('TODO05 prepared early-return lease guard', () => {
  it.each(['silent', 'aborted'] as const)('prepared %s early return holds without generic finish and disposes once', async mode => {
    const directory = temporaryDirectory()
    const jobId = `todo05-prepared-${mode}-early-return`
    const abort = new AbortController()
    const prepared = { objectId: `formal:${jobId}`, text: 'prepared early-return body' }
    seedJob(directory, markedJob(jobId, mode === 'silent' ? { deliver: 'silent' } : {}))
    let prepareCalls = 0
    let disposeCalls = 0
    let sends = 0
    let drives = 0
    const leaseFactory = () => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => { disposeCalls++ },
    })
    const provider = providerWithLease(leaseFactory, {
      prepare: async () => {
        prepareCalls++
        if (mode === 'aborted') abort.abort()
        return leaseFactory() as never
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      abort.signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await waitFor(() => prepareCalls >= 1 && disposeCalls === 1)
      const state = records(directory)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('TODO05 object-level chunk receipts through dsh-cron delivery seam', () => {
  async function runChunkCase(
    name: string,
    sendMessage: (call: number) => Promise<{ readonly messageId?: number }>,
  ): Promise<{ readonly directory: string; readonly records: Array<Record<string, unknown>>; readonly finish: Record<string, unknown>; readonly sends: number; readonly objectId: string }> {
    const directory = temporaryDirectory()
    const prepared = { objectId: `formal:${name}`, text: 'x'.repeat(4_990) }
    seedJob(directory, markedJob(name, { prompt: prepared.text }))
    const events: Array<{ readonly name: string; readonly payload: unknown }> = []
    let sends = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const runtime = new SchedulerRuntime(
      contextFor(events, createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => sendMessage(sends++) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'legacy must not run', error: undefined }) },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish'))
      const finish = records(directory).find(record => record.event === 'finish')
      if (finish === undefined) throw new Error(`missing finish for ${name}`)
      return { directory, records: records(directory), finish, sends, objectId: prepared.objectId }
    } finally {
      await runtime.dispose()
    }
  }

  it('all chunks accepted is Delivered and persists one object receipt', async () => {
    const result = await runChunkCase('todo05-chunks-delivered', async call => ({ messageId: call + 1 }))
    expect(result.sends).toBe(2)
    expect(result.finish.deliveryState).toBe('delivered')
    expect(result.finish.event).toBe('finish')
    expect(result.records.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
    expect(result.records.find(record => record.event === DELIVERY_RECEIPT_EVENT)?.objectId)
      .toBe(result.objectId)
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: DELIVERY_RECEIPT_EVENT, deliveryState: 'delivered' }),
    ]))
  })

  it('zero accepted chunks with explicit fatal failure is Failed', async () => {
    const result = await runChunkCase('todo05-chunks-failed', async () => {
      throw new TelegramApiError('fatal', 'bot revoked')
    })
    expect(result.sends).toBe(1)
    expect(result.finish.deliveryState).toBe('failed')
  })

  it.each([
    ['fatal', new TelegramApiError('fatal', 'second chunk rejected')],
    ['retry/429', new TelegramApiError('retry', 'rate limited')],
    ['ambiguous network error', new Error('network connection reset')],
  ] as const)('any accepted chunk followed by %s is Uncertain and never Failed', async (name, error) => {
    const result = await runChunkCase(`todo05-chunks-partial-${name}`, async call => {
      if (call === 0) return { messageId: 1 }
      throw error
    })
    expect(result.sends).toBe(2)
    expect(result.finish.deliveryState).toBe('uncertain')
  })

  it.each([
    ['TelegramApiError retry/429', async () => { throw new TelegramApiError('retry', 'rate limited') }],
    ['ordinary 5xx/network error', async () => { throw new Error('HTTP 503 or connection reset') }],
    ['timeout', async () => { throw new DOMException('request timed out', 'TimeoutError') }],
    ['missing trusted message id', async () => ({})],
  ] as const)('zero accepted chunks with %s is Uncertain', async (_name, sendMessage) => {
    const result = await runChunkCase(`todo05-chunks-${_name}`, sendMessage)
    expect(result.finish.deliveryState).toBe('uncertain')
  })
})

describe('TODO05 claim-to-prepared crash-gap recovery RED seam', () => {
  function claimOnly(jobId: string): RunClaimRecord {
    return {
      ...claimRecord(jobId, `${jobId}@seed`),
      trigger: 'scheduled',
    }
  }

  it('claim-only recovery receives the exact durable claim and prepares before transport', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-ready'
    const claim = claimOnly(jobId)
    const prepared = { objectId: `formal:${jobId}`, text: 'provider-owned exact recovery body' }
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    let seenContext: Record<string, unknown> | undefined
    const baseProvider = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...baseProvider,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      seenContext = context
      return {
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: prepared,
      }
      },
    }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => {
        const beforeTransport = records(directory)
        expect(beforeTransport).toEqual(expect.arrayContaining([
          expect.objectContaining({
            event: PREPARED_DELIVERY_EVENT,
            objectId: prepared.objectId,
            text: prepared.text,
            jobId: claim.jobId,
            runId: claim.runId,
            sessionId: claim.sessionId,
            scheduledFor: claim.scheduledFor,
          }),
          expect.objectContaining({
            event: DELIVERY_ATTEMPT_CLAIM_EVENT,
            objectId: prepared.objectId,
            jobId: claim.jobId,
            runId: claim.runId,
            sessionId: claim.sessionId,
            scheduledFor: claim.scheduledFor,
          }),
        ]))
        expect(beforeTransport.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
        expect(beforeTransport.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
        expect(beforeTransport.some(record => record.event === 'finish')).toBe(false)
        sends++
        return { messageId: 1 }
      } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish'), 3_000)
      const state = records(directory)
      expect(recoveryCalls).toBe(1)
      expect(seenContext).toMatchObject({
        jobId: claim.jobId,
        runId: claim.runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        claimedAt: claim.claimedAt,
        trigger: claim.trigger,
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
      })
      expect(drives).toBe(0)
      expect(sends).toBe(1)
      expect(state.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(state.find(record => record.event === PREPARED_DELIVERY_EVENT)).toMatchObject(prepared)
    } finally {
      await runtime.dispose()
    }
  })

  it('retries a failed prepared finish from the scheduled backoff timer after a near-boundary drive', async () => {
    const T0 = Date.parse('2026-08-25T00:00:00.000Z')
    const SETTLEMENT_BACKOFF_MS = CLAIM_RETRY_DELAY_MS
    const BEFORE_BACKOFF_BOUNDARY_MS = 1
    const AFTER_BACKOFF_BOUNDARY_MS = 1
    const jobId = 'todo05-prefinish-finish-retry-boundary'
    const directory = temporaryDirectory()
    const prepared = { objectId: `formal:${jobId}`, text: 'prepared boundary recovery body' }
    const events: Array<{ readonly name: string; readonly payload: unknown }> = []
    let sends = 0
    let drives = 0
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    seedJob(directory, markedJob(jobId))

    const provider = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const finishSpy = vi.spyOn(RunLedger.prototype, 'finish')
      .mockImplementationOnce(() => { throw new Error('controlled finish append failure') })
    let restoreFoldSpy: (() => void) | undefined
    const runtime = new SchedulerRuntime(
      contextFor(events, createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )

    const flushScheduler = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()
    }

    try {
      runtime.start()
      await flushScheduler()
      const started = records(directory)
      expect(started.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(started.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(started.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(started.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(started.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(started.filter(record => record.event === 'finish')).toHaveLength(0)
      expect(finishSpy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(SETTLEMENT_BACKOFF_MS - BEFORE_BACKOFF_BOUNDARY_MS)
      expect(Date.now()).toBe(T0 + SETTLEMENT_BACKOFF_MS - BEFORE_BACKOFF_BOUNDARY_MS)
      expect(records(directory).filter(record => record.event === 'finish')).toHaveLength(0)
      expect(finishSpy).toHaveBeenCalledTimes(1)

      const foldTimes: number[] = []
      const originalFoldJob = RunLedger.prototype.foldJob
      const foldSpy = vi.spyOn(RunLedger.prototype, 'foldJob').mockImplementation(function (jobId: string) {
        const callNumber = foldTimes.length + 1
        if (callNumber === 2) {
          // The second fold is the orphan projection after reload deferred settlement at T0+4999.
          vi.setSystemTime(T0 + SETTLEMENT_BACKOFF_MS + AFTER_BACKOFF_BOUNDARY_MS)
        }
        foldTimes.push(Date.now())
        return originalFoldJob.call(this, jobId)
      })
      restoreFoldSpy = () => foldSpy.mockRestore()
      runtime.requestDrive()
      await flushScheduler()
      await vi.advanceTimersByTimeAsync(AFTER_BACKOFF_BOUNDARY_MS)
      await flushScheduler()

      const completed = records(directory)
      expect(foldTimes.slice(0, 2)).toEqual([
        T0 + SETTLEMENT_BACKOFF_MS - BEFORE_BACKOFF_BOUNDARY_MS,
        T0 + SETTLEMENT_BACKOFF_MS + AFTER_BACKOFF_BOUNDARY_MS,
      ])
      expect(completed.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(completed.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(sends).toBe(1)
      expect(drives).toBe(0)
      expect(finishSpy).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
      restoreFoldSpy?.()
      finishSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('not-ready recovery holds the same claim, then a later ready provider completes it without a new run', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-not-ready'
    const claim = claimOnly(jobId)
    const prepared = { objectId: `formal:${jobId}`, text: 'same provider-owned body after retry' }
    seedJob(directory, markedJob(jobId, {
      schedule: { kind: 'interval', minutes: 1 },
      createdAt: new Date().toISOString(),
    }))
    seedRecords(directory, [claim])
    let mode: 'not-ready' | 'ready' = 'not-ready'
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      if (mode === 'not-ready') return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
      return {
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: prepared,
      }
      },
    }
    const makeRuntime = () => new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    const first = makeRuntime()
    first.start()
    await waitFor(() => recoveryCalls >= 1)
    for (let attempt = 0; attempt < 5; attempt++) first.requestDrive()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(recoveryCalls).toBe(1)
    await waitFor(() => recoveryCalls >= 2, 8_000)
    const held = records(directory)
    expect(held.filter(record => record.event === 'claim')).toHaveLength(1)
    expect(held.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
    expect(held.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
    expect(held.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
    expect(held.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
    expect(held.some(record => record.event === 'finish')).toBe(false)
    expect(held.some(record => record.status === 'interrupted')).toBe(false)
    expect(sends).toBe(0)
    expect(drives).toBe(0)
    await first.dispose()

    mode = 'ready'
    const second = makeRuntime()
    second.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish'), 3_000)
      const completed = records(directory)
      expect(recoveryCalls).toBeGreaterThanOrEqual(3)
      expect(completed.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(completed.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(completed.some(record => record.status === 'interrupted')).toBe(false)
    } finally {
      await second.dispose()
    }
  }, 12_000)

  it.each([
    ['jobId', (binding: Record<string, unknown>) => ({ ...binding, jobId: 'other-job' })],
    ['runId', (binding: Record<string, unknown>) => ({ ...binding, runId: `${String(binding.runId)}-conflict` })],
    ['sessionId', (binding: Record<string, unknown>) => ({ ...binding, sessionId: 'session-conflict' })],
    ['scheduledFor', (binding: Record<string, unknown>) => ({ ...binding, scheduledFor: '2026-08-24T00:01:00.000Z' })],
    ['claimedAt', (binding: Record<string, unknown>) => ({ ...binding, claimedAt: '2026-08-24T00:00:09.000Z' })],
    ['trigger', (binding: Record<string, unknown>) => ({ ...binding, trigger: 'manual' })],
  ] as const)('mismatched recovered claim %s fails closed without replacing the durable claim', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const jobId = `todo05-gap-mismatch-${_name}`
    const claim = claimOnly(jobId)
    const prepared = { objectId: `formal:${jobId}`, text: 'must not send on binding conflict' }
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return {
        status: 'ready',
        claim: mutate(toCronPreparedDeliveryClaimBinding(context)),
        preparedDelivery: prepared,
      }
      },
    }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      const state = records(directory)
      expect(recoveryCalls).toBe(1)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it.each(['recovery throws', 'recovery port missing'] as const)('%s keeps a claim-only run held without legacy orphan finish', async mode => {
    const directory = temporaryDirectory()
    const jobId = `todo05-gap-${mode.replaceAll(' ', '-')}`
    const claim = claimOnly(jobId)
    const dueClaim = { ...claim, nextRunAt: new Date(Date.now() - 1_000).toISOString() }
    const prepared = { objectId: `formal:${jobId}`, text: 'held until recovery is trustworthy' }
    seedJob(directory, markedJob(jobId, {
      schedule: { kind: 'interval', minutes: 1 },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    }))
    seedRecords(directory, [dueClaim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = mode === 'recovery throws'
      ? {
        ...providerBase,
        recoverPreparedDelivery: async () => {
        recoveryCalls++
        throw new Error('recovery not ready')
        },
      }
      : providerBase
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 5_300))
      const state = records(directory)
      if (mode === 'recovery throws') expect(recoveryCalls).toBeGreaterThanOrEqual(2)
      else expect(recoveryCalls).toBe(0)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  it('bounds a claim-only provider recovery failure warning without leaking provider details', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-claim-only-recovery-warning'
    const claim = claimOnly(jobId)
    const sensitive = 'proposal=secret-proposal model=secret/model candidate=secret candidate body'
    seedJob(directory, markedJob(jobId))
    new RunLedger(directory).claim(claim)
    const warnings: string[] = []
    let recoveryCalls = 0
    let sends = 0
    let finishes = 0
    const provider = providerWithLease(() => ({
      preparedDelivery: { objectId: `formal:${jobId}`, text: 'must not prepare' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
      recoverPreparedDelivery: async () => {
        recoveryCalls++
        throw new Error(`provider recovery failed: ${sensitive}`)
      },
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider]), warnings),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      {
        driveTurn: async () => ({ text: 'must not drive', error: undefined }),
      },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(recoveryCalls).toBe(1)
      finishes = records(directory).filter(record => record.event === 'finish').length
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toBe(
        `dsh-cron: claim-only recovery failed category=claim_only_recovery stage=provider_recover code=recovery_failed jobId=${jobId} runId=${claim.runId} sessionId=${claim.sessionId}`,
      )
      expect(warnings[0]).not.toContain(sensitive)
      expect(warnings[0]).not.toContain('secret-proposal')
      expect(warnings[0]).not.toContain('secret/model')
      expect(warnings[0]).not.toContain('secret candidate body')
      expect(recoveryCalls).toBe(1)
      const state = records(directory)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(sends).toBe(0)
      expect(finishes).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('invalid recovered object is rejected before prepared persistence or transport', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-invalid-object'
    const claim = claimOnly(jobId)
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: { objectId: `formal:${jobId}`, text: 'must not send' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return {
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: { objectId: ' ', text: '   ' },
      }
      },
    }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      const state = records(directory)
      expect(recoveryCalls).toBe(1)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('repeated recovery object conflict stays held and never chooses a replacement object', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-object-conflict'
    const claim = {
      ...claimOnly(jobId),
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    }
    const firstObject = { objectId: `formal:${jobId}`, text: 'first candidate' }
    seedJob(directory, markedJob(jobId, {
      schedule: { kind: 'interval', minutes: 1 },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    }))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: firstObject,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return recoveryCalls === 1
        ? { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
        : { status: 'conflict', claim: toCronPreparedDeliveryClaimBinding(context) }
      },
    }
    const makeRuntime = () => new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    const runtime = makeRuntime()
    runtime.start()
    try {
      await waitFor(() => recoveryCalls >= 2, 6_000)
      const state = records(directory)
      expect(recoveryCalls).toBeGreaterThanOrEqual(2)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
    } finally {
      await runtime.dispose()
    }
  }, 8_000)

  it('live prepared persistence failure does not enter deliverOnError or generic finish', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-live-prepared-persist-failure'
    const prepared = { objectId: `formal:${jobId}`, text: 'live persistence failure' }
    seedJob(directory, markedJob(jobId, { schedule: { kind: 'interval', minutes: 10 } }))
    let prepareStarted = false
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve })
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    let disposeCalls = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      prepare: async () => {
        prepareStarted = true
        await prepareGate
        return {
          preparedDelivery: prepared,
          setupAgent: async () => undefined,
          verifySurface: async () => undefined,
          settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
          dispose: async () => { disposeCalls++ },
        }
      },
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
      },
    }
    const prepareSpy = vi.spyOn(RunLedger.prototype, 'prepareDelivery')
      .mockImplementation(() => { throw new Error('controlled live prepared append failure') })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      await expect(runtime.runNow({ jobId, requestKey: 'todo05-live-inflight' })).resolves.toMatchObject({ ok: true })
      await waitFor(() => prepareStarted)
      for (let attempt = 0; attempt < 5; attempt++) runtime.requestDrive()
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(recoveryCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(records(directory).filter(record => record.event === 'claim')).toHaveLength(1)
      releasePrepare()
      await new Promise(resolve => setTimeout(resolve, 300))
      const state = records(directory)
      expect(prepareSpy).toHaveBeenCalledTimes(1)
      expect(disposeCalls).toBe(1)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
    } finally {
      releasePrepare()
      await runtime.dispose()
      prepareSpy.mockRestore()
    }
  })

  it.each(['attempt', 'receipt', 'ack', 'finish'] as const)('live %s append failure retries the same prepared run after backoff', async stage => {
    const directory = temporaryDirectory()
    const jobId = `todo05-live-${stage}-append-failure`
    const prepared = { objectId: `formal:${jobId}`, text: `live ${stage} append failure` }
    seedJob(directory, markedJob(jobId))
    let prepareCalls = 0
    let sends = 0
    let drives = 0
    let liveHooks = 0
    let recoveryHooks = 0
    let disposeCalls = 0
    const leaseFactory = () => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => { liveHooks++; return { status: 'accepted' as const } },
      dispose: async () => { disposeCalls++ },
    })
    const provider = providerWithLease(leaseFactory, {
      prepare: async () => { prepareCalls++; return leaseFactory() as never },
      settleRecoveredDelivery: async () => { recoveryHooks++; return { status: 'accepted' as const } },
    })
    const failure = new Error(`controlled ${stage} append failure`)
    const failureSpy = stage === 'attempt'
      ? vi.spyOn(RunLedger.prototype, 'claimDeliveryAttempt').mockImplementationOnce(() => { throw failure })
      : stage === 'receipt'
        ? vi.spyOn(RunLedger.prototype, 'recordDeliveryReceipt').mockImplementationOnce(() => { throw failure })
        : stage === 'ack'
          ? vi.spyOn(RunLedger.prototype, 'environmentPrefinishSettled').mockImplementationOnce(() => { throw failure })
          : vi.spyOn(RunLedger.prototype, 'finish').mockImplementationOnce(() => { throw failure })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await waitFor(() => prepareCalls >= 1)
      await new Promise(resolve => setTimeout(resolve, 300))
      for (let attempt = 0; attempt < 5; attempt++) runtime.requestDrive()
      await new Promise(resolve => setTimeout(resolve, 300))
      const held = records(directory)
      expect(held.some(record => record.event === 'finish')).toBe(false)
      expect(drives).toBe(0)
      if (stage === 'attempt') expect(sends).toBe(0)
      else expect(sends).toBe(1)
      await waitFor(() => records(directory).some(record => record.event === 'finish'), 10_000)
      const completed = records(directory)
      expect(sends).toBe(1)
      expect(drives).toBe(0)
      expect(completed.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(completed.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(completed.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(failureSpy).toHaveBeenCalledTimes(2)
      expect(liveHooks + recoveryHooks).toBe(stage === 'ack' ? 2 : 1)
      expect(disposeCalls).toBe(1)
    } finally {
      await runtime.dispose()
      failureSpy.mockRestore()
    }
  }, 12_000)

  it('prepared persistence failure recovers the same claim and object after runtime reconstruction', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-prepared-persist-failure'
    const claim = claimOnly(jobId)
    const prepared = { objectId: `formal:${jobId}`, text: 'persistence must fail closed' }
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return { status: 'ready', claim: toCronPreparedDeliveryClaimBinding(context), preparedDelivery: prepared }
      },
    }
    const prepareSpy = vi.spyOn(RunLedger.prototype, 'prepareDelivery')
      .mockImplementationOnce(() => { throw new Error('controlled prepared append failure') })
    const makeRuntime = () => new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    const first = makeRuntime()
    let firstDisposed = false
    try {
      first.start()
      await waitFor(() => prepareSpy.mock.calls.length >= 1, 3_000)
      const held = records(directory)
      expect(recoveryCalls).toBe(1)
      expect(prepareSpy).toHaveBeenCalledTimes(1)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(held.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(held.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(held.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(held.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(held.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(held.some(record => record.event === 'finish')).toBe(false)
      expect(held.some(record => record.status === 'interrupted')).toBe(false)
      await first.dispose()
      firstDisposed = true

      await new Promise(resolve => setTimeout(resolve, 5_300))
      const second = makeRuntime()
      second.start()
      try {
        await waitFor(() => records(directory).some(record => record.event === 'finish'), 3_000)
        const completed = records(directory)
        expect(recoveryCalls).toBeGreaterThanOrEqual(2)
        expect(prepareSpy).toHaveBeenCalledTimes(2)
        expect(sends).toBe(1)
        expect(drives).toBe(0)
        expect(completed.filter(record => record.event === 'claim')).toHaveLength(1)
        expect(completed.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
        expect(completed.filter(record => record.event === 'finish')).toHaveLength(1)
        expect(completed.some(record => record.status === 'interrupted')).toBe(false)
        expect(completed.find(record => record.event === PREPARED_DELIVERY_EVENT)).toMatchObject(prepared)
        expect(completed.filter(record => record.event !== 'claim').every(record => record.runId === claim.runId)).toBe(true)
      } finally {
        await second.dispose()
      }
    } finally {
      if (!firstDisposed) await first.dispose()
      prepareSpy.mockRestore()
    }
  }, 15_000)

  it('manual claim-only recovery keeps manual trigger identity and does not rewrite a natural schedule anchor', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-manual-ready'
    const claim = { ...claimOnly(jobId), trigger: 'manual' as const }
    const prepared = { objectId: `formal:${jobId}`, text: 'manual provider-owned body' }
    seedJob(directory, markedJob(jobId, {
      schedule: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
    }))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async context => {
      recoveryCalls++
      return {
        status: 'ready',
        claim: toCronPreparedDeliveryClaimBinding(context),
        preparedDelivery: prepared,
      }
      },
    }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish'), 3_000)
      await new Promise(resolve => setTimeout(resolve, 100))
      const state = records(directory)
      const finish = state.find(record => record.event === 'finish')
      expect(recoveryCalls).toBe(1)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.filter(record => record.event === PREPARED_DELIVERY_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === DELIVERY_RECEIPT_EVENT)).toHaveLength(1)
      expect(state.filter(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toHaveLength(1)
      expect(finish).toMatchObject({ event: 'finish', trigger: 'manual' })
      expect(finish?.nextRunAt).toBeUndefined()
      expect(state.filter(record => record.event !== 'claim').every(record => record.runId === claim.runId)).toBe(true)
      expect(sends).toBe(1)
      expect(drives).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('existing prepared recovery does not invoke the new claim-only recovery port', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-existing-prepared'
    const runId = `${jobId}@seed`
    const prepared = { objectId: `formal:${jobId}`, text: 'already durable object' }
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [
      claimOnly(jobId),
      validDeliveryRecord(PREPARED_DELIVERY_EVENT, jobId, runId, undefined, prepared),
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
    ])
    let newRecoveryCalls = 0
    let oldRecoveryCalls = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: prepared,
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => { oldRecoveryCalls++; return { status: 'accepted' as const } },
    })
    const provider: CronAgentEnvironmentProvider = {
      ...providerBase,
      recoverPreparedDelivery: async () => {
      newRecoveryCalls++
      throw new Error('claim-only recovery port must not run for existing prepared row')
      },
    }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'must not drive', error: undefined }) },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'finish'))
      expect(newRecoveryCalls).toBe(0)
      expect(oldRecoveryCalls).toBe(1)
      expect(records(directory).filter(record => record.event === 'finish')).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    ['requirements mismatch', { requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'present' as const } }],
    ['prepared lifecycle opt-in missing', { preparedDeliveryLifecycle: false }],
  ] as const)('claim-only recovery %s is rejected before provider recovery or side effects', async (_name, guard) => {
    const directory = temporaryDirectory()
    const jobId = `todo05-gap-registry-${_name.replaceAll(' ', '-')}`
    const claim = claimOnly(jobId)
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [claim])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: { objectId: `formal:${jobId}`, text: 'must remain held' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
      recoverPreparedDelivery: async context => {
        recoveryCalls++
        return { status: 'not-ready', claim: toCronPreparedDeliveryClaimBinding(context) }
      },
    })
    const provider: CronAgentEnvironmentProvider = { ...providerBase, ...guard }
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([provider])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      const state = records(directory)
      expect(recoveryCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
      expect(state.some(record => record.event === DELIVERY_RECEIPT_EVENT)).toBe(false)
      expect(state.some(record => record.event === ENVIRONMENT_PREFINISH_SETTLE_EVENT)).toBe(false)
      expect(state.some(record => record.event === 'finish')).toBe(false)
      expect(state.some(record => record.status === 'interrupted')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('terminal prepared claim with finish but no prepared row never invokes claim-only recovery', async () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-gap-terminal-no-prepared'
    const runId = `${jobId}@seed`
    const claim = claimOnly(jobId)
    seedJob(directory, markedJob(jobId))
    seedRecords(directory, [
      claim,
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered'),
      validDeliveryRecord(ENVIRONMENT_PREFINISH_SETTLE_EVENT, jobId, runId, 'delivered'),
      {
        schemaVersion: 2,
        event: 'finish',
        jobId,
        runId,
        sessionId: claim.sessionId,
        scheduledFor: claim.scheduledFor,
        startedAt: claim.claimedAt,
        finishedAt: '2026-08-24T00:00:04.000Z',
        status: 'success',
        trigger: 'scheduled',
        deliveryState: 'delivered',
      },
    ])
    let recoveryCalls = 0
    let sends = 0
    let drives = 0
    const providerBase = providerWithLease(() => ({
      preparedDelivery: { objectId: `formal:${jobId}`, text: 'must not recover terminal claim' },
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      settleDeliveryBeforeFinish: async () => ({ status: 'accepted' as const }),
      dispose: async () => undefined,
    }), {
      settleRecoveredDelivery: async () => ({ status: 'accepted' as const }),
      recoverPreparedDelivery: async context => {
        recoveryCalls++
        return { status: 'ready', claim: toCronPreparedDeliveryClaimBinding(context), preparedDelivery: { objectId: `formal:${jobId}`, text: 'must not recover terminal claim' } }
      },
    })
    const runtime = new SchedulerRuntime(
      contextFor([], createCronAgentEnvironmentRegistry([providerBase])),
      baseConfig(directory),
      { sendMessage: async () => { sends++; return { messageId: 1 } } } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => { drives++; return { text: 'must not drive', error: undefined } } },
    )
    runtime.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      const state = records(directory)
      expect(recoveryCalls).toBe(0)
      expect(sends).toBe(0)
      expect(drives).toBe(0)
      expect(state.filter(record => record.event === 'claim')).toHaveLength(1)
      expect(state.filter(record => record.event === 'finish')).toHaveLength(1)
      expect(state.some(record => record.event === PREPARED_DELIVERY_EVENT)).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('TODO05 legacy compatibility guard', () => {
  it('legacy provider keeps post-finish settle and does not inherit pre-finish semantics', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('todo05-legacy', { agentEnvironment: 'legacy/v1' }))
    const events: Array<{ readonly name: string; readonly payload: unknown }> = []
    let sawFinishInLegacySettle = false
    const legacyProvider: CronAgentEnvironmentProvider = {
      marker: 'legacy/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => ({
        setupAgent: async () => undefined,
        verifySurface: async () => undefined,
        settleRun: async () => {
          sawFinishInLegacySettle = records(directory).some(record => record.event === 'finish')
        },
        dispose: async () => undefined,
      }),
    }
    const runtime = new SchedulerRuntime(
      contextFor(events, createCronAgentEnvironmentRegistry([legacyProvider])),
      baseConfig(directory),
      { sendMessage: async () => ({ messageId: 1 }) } as never,
      1,
      new AbortController().signal,
      { driveTurn: async () => ({ text: 'legacy body', error: undefined }) },
    )
    runtime.start()
    try {
      await waitFor(() => records(directory).some(record => record.event === 'environment-settle'))
      expect(sawFinishInLegacySettle).toBe(true)
      expect(records(directory).some(record => record.event === DELIVERY_ATTEMPT_CLAIM_EVENT)).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('RunLedger keeps claim/finish settled, interrupted, and unsettled projections with new delivery events present', () => {
    const directory = temporaryDirectory()
    const jobId = 'todo05-ledger-boundary'
    const runId = `${jobId}@seed`
    seedRecords(directory, [
      claimRecord(jobId, runId),
      {
        schemaVersion: 2,
        event: 'finish',
        runId,
        jobId,
        sessionId: `session-cron-run-${jobId}`,
        scheduledFor: '2026-08-24T00:00:00.000Z',
        startedAt: '2026-08-24T00:00:01.000Z',
        finishedAt: '2026-08-24T00:00:04.000Z',
        status: 'success',
        deliveryState: 'delivered',
      },
      validDeliveryRecord(DELIVERY_ATTEMPT_CLAIM_EVENT, jobId, runId, undefined, { claimedAt: '2026-08-24T00:00:02.000Z' }),
      validDeliveryRecord(DELIVERY_RECEIPT_EVENT, jobId, runId, 'delivered', { messageId: 9 }),
      validDeliveryRecord(ENVIRONMENT_PREFINISH_SETTLE_EVENT, jobId, runId, 'delivered', { settledAt: '2026-08-24T00:00:03.000Z' }),
    ])
    const ledger = new RunLedger(directory)
    const folded = ledger.foldJob(jobId)
    expect(folded.settledRunIds.has(runId)).toBe(true)
    expect(folded.interrupted).toHaveLength(0)
    expect(folded.unsettledFinishes).toHaveLength(1)
    expect(folded.unsettledFinishes[0]).toMatchObject({ runId, status: 'success' })
  })
})
