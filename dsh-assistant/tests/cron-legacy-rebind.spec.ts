/**
 * Lane C / D: red tests for explicit, recovery-safe legacy monitor rebind.
 *
 * Every unsafe branch must be a zero-side-effect refusal.  In particular,
 * historical outbox rows are audit data and cannot be cancelled, reclassified,
 * or rewritten as part of a cron binding recovery.
 */

import { describe, expect, it } from 'vitest'

type RecoveryStore = {
  findCommitmentById(id: string): Record<string, unknown> | undefined
  listOutbox(commitmentId: string): readonly Record<string, unknown>[]
  prepareCronRebind(input: Record<string, unknown>): unknown
  updateCronBoundJobId(commitmentId: string, jobId: string): void
  setCommitmentStatus(id: string, status: string): void
  recordCronControlError(id: string, error: string): void
}

type RecoveryPort = {
  ensureBound(input: Record<string, unknown>): Promise<Record<string, unknown>>
  deleteBound(externalRef: string): Promise<Record<string, unknown>>
}

type RebindModule = {
  rebindLegacyMonitor(input: {
    readonly store: RecoveryStore
    readonly controlPort: RecoveryPort
    readonly commitmentId: string
    readonly externalRef: string
    readonly schedule: Record<string, unknown>
    readonly now: string
  }): Promise<Record<string, unknown>>
}

async function loadRecoveryModule(): Promise<{ readonly module?: RebindModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-recovery.ts') as unknown as RebindModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

const TARGET_ID = 'legacy-monitor-exact-id'
const BASE_COMMITMENT = {
  id: TARGET_ID,
  kind: 'monitor',
  workOwner: 'agent',
  status: 'blocked',
  workerSessionId: null,
  workerRunId: null,
  workerParentSessionId: null,
  workerControlState: 'none',
  monitorResumeState: 'none',
  monitorClaimToken: null,
  monitorClaimedAt: null,
  monitorDirection: '完整 legacy monitor direction',
}
const BASE_OUTBOX = [{
  id: 'old-delivered', commitmentId: TARGET_ID, kind: 'completed', state: 'delivered', text: '历史终态正文',
  deliveredAt: '2026-08-17T00:00:00.000Z', error: null,
}]

function fakeWorld(commitment: Record<string, unknown>, outbox = BASE_OUTBOX, options: { readonly prepareResult?: unknown } = {}): {
  readonly store: RecoveryStore
  readonly port: RecoveryPort
  readonly writes: unknown[]
  readonly sequence: string[]
  readonly portCalls: unknown[]
  readonly before: string
} {
  const writes: unknown[] = []
  const sequence: string[] = []
  const portCalls: unknown[] = []
  const store: RecoveryStore = {
    findCommitmentById: id => id === commitment.id ? commitment : undefined,
    listOutbox: () => outbox,
    prepareCronRebind: input => {
      sequence.push('prepareCronRebind')
      writes.push({ name: 'prepareCronRebind', input })
      return Object.prototype.hasOwnProperty.call(options, 'prepareResult')
        ? options.prepareResult
        : { ok: true, row: { commitmentId: commitment.id, desiredState: 'running' } }
    },
    updateCronBoundJobId: (commitmentId, jobId) => {
      sequence.push('updateCronBoundJobId')
      writes.push({ name: 'updateCronBoundJobId', commitmentId, jobId })
    },
    setCommitmentStatus: (id, status) => {
      sequence.push(`setCommitmentStatus:${status}`)
      writes.push({ name: 'setCommitmentStatus', id, status })
    },
    recordCronControlError: (id, error) => {
      sequence.push('recordCronControlError')
      writes.push({ name: 'recordCronControlError', id, error })
    },
  }
  const port: RecoveryPort = {
    ensureBound: async input => {
      sequence.push('ensureBound')
      portCalls.push({ name: 'ensureBound', input })
      return { ok: true, snapshot: { externalRef: input.externalRef, activeJob: { id: 'job-rebound' }, latestRun: null } }
    },
    deleteBound: async externalRef => {
      sequence.push('deleteBound')
      portCalls.push({ name: 'deleteBound', externalRef })
      return { ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }
    },
  }
  return { store, port, writes, sequence, portCalls, before: JSON.stringify({ commitment, outbox }) }
}

async function assertUnsafe(
  loaded: RebindModule,
  commitment: Record<string, unknown>,
  outbox = BASE_OUTBOX,
): Promise<void> {
  const world = fakeWorld(commitment, outbox)
  const result = await loaded.rebindLegacyMonitor({
    store: world.store,
    controlPort: world.port,
    commitmentId: TARGET_ID,
    externalRef: `assistant:${TARGET_ID}`,
    schedule: { kind: 'interval', minutes: 15 },
    now: '2026-08-18T02:00:00.000Z',
  })
  expect(result).toMatchObject({ ok: false, code: 'recovery_not_safe' })
  expect(world.portCalls).toEqual([])
  expect(world.writes).toEqual([])
  expect(world.sequence).toEqual([])
  expect(JSON.stringify({ commitment, outbox })).toBe(world.before)
}

describe('blocked legacy monitor cron rebind safety (first red)', () => {
  it('requires an exact target and refuses ambiguous/missing legacy targets without any side effect', async () => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const world = fakeWorld({ ...BASE_COMMITMENT, id: 'different-target' })
    const result = await loaded.module.rebindLegacyMonitor({
      store: world.store,
      controlPort: world.port,
      commitmentId: TARGET_ID,
      externalRef: `assistant:${TARGET_ID}`,
      schedule: { kind: 'interval', minutes: 15 },
      now: '2026-08-18T02:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'recovery_not_safe' })
    expect(world.portCalls).toEqual([])
    expect(world.writes).toEqual([])
  })

  it.each([
    ['worker session', { workerSessionId: 'child-1' }],
    ['worker run', { workerRunId: 'run-1' }],
    ['worker parent session', { workerParentSessionId: 'root-1' }],
    ['control claim', { workerControlState: 'pause_requested' }],
    ['control resume claim', { workerControlState: 'resume_requested' }],
    ['resume claimed', { monitorResumeState: 'claimed' }],
    ['resume needed', { monitorResumeState: 'needed' }],
    ['monitor claim token', { monitorClaimToken: 'claim-token' }],
    ['monitor claimed at', { monitorClaimedAt: '2026-08-18T01:00:00.000Z' }],
  ])('refuses rebind with %s and leaves every row untouched', async (_label, changes) => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    await assertUnsafe(loaded.module, { ...BASE_COMMITMENT, ...changes })
  })

  it.each(['pending', 'claimed'] as const)('refuses rebind with a %s outbox and never rewrites historical outbox', async state => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    await assertUnsafe(loaded.module, BASE_COMMITMENT, [{ ...BASE_OUTBOX[0]!, state }])
  })

  it('allows only the safe exact target, then performs one ensure and creates one binding without changing old outbox', async () => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    const world = fakeWorld(BASE_COMMITMENT)
    const beforeOutbox = JSON.stringify(BASE_OUTBOX)
    const result = await loaded.module.rebindLegacyMonitor({
      store: world.store,
      controlPort: world.port,
      commitmentId: TARGET_ID,
      externalRef: `assistant:${TARGET_ID}`,
      schedule: { kind: 'interval', minutes: 15 },
      now: '2026-08-18T02:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: true })
    expect(world.sequence).toEqual([
      'prepareCronRebind', 'ensureBound', 'updateCronBoundJobId', 'setCommitmentStatus:active',
    ])
    expect(world.portCalls).toHaveLength(1)
    expect(world.portCalls[0]).toMatchObject({
      name: 'ensureBound',
      input: {
        externalRef: `assistant:${TARGET_ID}`,
        prompt: '完整 legacy monitor direction',
      },
    })
    expect(world.writes).toEqual([
      {
        name: 'prepareCronRebind',
        input: expect.objectContaining({
          commitmentId: TARGET_ID,
          desiredState: 'running',
          clearWorkerSessionId: true,
          clearWorkerRunId: true,
          clearWorkerParentSessionId: true,
          clearWorkerControlState: true,
          clearMonitorResumeState: true,
          clearMonitorClaim: true,
        }),
      },
      { name: 'updateCronBoundJobId', commitmentId: TARGET_ID, jobId: 'job-rebound' },
      { name: 'setCommitmentStatus', id: TARGET_ID, status: 'active' },
    ])
    expect(JSON.stringify(BASE_OUTBOX)).toBe(beforeOutbox)
  })

  it('refuses a legacy rebind without the authoritative monitor direction before persistence or Cron RPC', async () => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    const world = fakeWorld({ ...BASE_COMMITMENT, monitorDirection: null })
    const result = await loaded.module.rebindLegacyMonitor({
      store: world.store,
      controlPort: world.port,
      commitmentId: TARGET_ID,
      externalRef: `assistant:${TARGET_ID}`,
      schedule: { kind: 'interval', minutes: 15 },
      now: '2026-08-18T02:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'recovery_not_safe' })
    expect(world.portCalls).toEqual([])
    expect(world.writes).toEqual([])
    expect(world.sequence).toEqual([])
  })

  it.each([
    ['undefined', undefined],
    ['failed', { ok: false, code: 'persistence_failed', message: 'binding transaction failed' }],
  ])('does not call Cron when prepareCronRebind returns %s', async (_label, prepareResult) => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    const world = fakeWorld(BASE_COMMITMENT, BASE_OUTBOX, { prepareResult })
    const before = world.before
    const result = await loaded.module.rebindLegacyMonitor({
      store: world.store,
      controlPort: world.port,
      commitmentId: TARGET_ID,
      externalRef: `assistant:${TARGET_ID}`,
      schedule: { kind: 'interval', minutes: 15 },
      now: '2026-08-18T02:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'persistence_failed' })
    expect(world.sequence).toEqual(['prepareCronRebind'])
    expect(world.portCalls).toEqual([])
    expect(world.writes).toHaveLength(1)
    expect(JSON.stringify({
      commitment: world.store.findCommitmentById(TARGET_ID),
      outbox: world.store.listOutbox(TARGET_ID),
    })).toBe(before)
  })

  it('marks a safe rebind blocked with control_error when ensure fails, without touching historical outbox', async () => {
    const loaded = await loadRecoveryModule()
    expect(loaded.error, 'cron recovery module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    const world = fakeWorld(BASE_COMMITMENT)
    const beforeOutbox = JSON.stringify(BASE_OUTBOX)
    world.port.ensureBound = async input => {
      world.sequence.push('ensureBound')
      world.portCalls.push({ name: 'ensureBound', input })
      return { ok: false, code: 'control_unavailable', message: 'manager unavailable' }
    }
    const result = await loaded.module.rebindLegacyMonitor({
      store: world.store,
      controlPort: world.port,
      commitmentId: TARGET_ID,
      externalRef: `assistant:${TARGET_ID}`,
      schedule: { kind: 'interval', minutes: 15 },
      now: '2026-08-18T02:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'control_unavailable' })
    expect(world.sequence).toEqual(['prepareCronRebind', 'ensureBound', 'recordCronControlError', 'setCommitmentStatus:blocked'])
    expect(world.writes).toEqual([
      { name: 'prepareCronRebind', input: expect.objectContaining({ desiredState: 'running' }) },
      { name: 'recordCronControlError', id: TARGET_ID, error: 'manager unavailable' },
      { name: 'setCommitmentStatus', id: TARGET_ID, status: 'blocked' },
    ])
    expect(JSON.stringify(BASE_OUTBOX)).toBe(beforeOutbox)
  })
})
