/**
 * Lane C / E: red tests for one bounded startup reconciliation pass.
 *
 * The startup pass reads existing assistant Cron responsibility intents. It
 * does not discover legacy monitors and it is not a scheduler or a reminder
 * loop.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type DesiredState = 'running' | 'paused' | 'cancelled'
type CommitmentStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'cancelled'

type Intent = {
  readonly commitmentId: string
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd: string | null
  readonly desiredState: DesiredState
  readonly boundJobId: string | null
  readonly commitmentStatus: CommitmentStatus
  readonly monitorDirection: string | null
  readonly controlError: string | null
}

type Job = {
  readonly id: string
  readonly schedule: Record<string, unknown>
  readonly prompt: string
  readonly cwd?: string
}

type CronResult = {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly snapshot?: { readonly activeJob?: Job | null; readonly latestRun?: unknown }
}

type Store = {
  listCronReconciliationIntents(limit?: number): readonly Intent[]
  updateCronBindingActual(input: Record<string, unknown>): unknown
  clearCronBoundJobId(input: Record<string, unknown>): unknown
  setCommitmentStatus(id: string, status: CommitmentStatus): unknown
  closeCommitment(id: string): unknown
  recordCronControlError(input: Record<string, unknown>): unknown
}

type Port = {
  readiness(): Promise<{ readonly state: 'ready' | 'unavailable'; readonly reason?: string }>
  getBound(externalRef: string): Promise<CronResult>
  ensureBound(input: Record<string, unknown>): Promise<CronResult>
  replaceBound(input: Record<string, unknown>): Promise<CronResult>
  deleteBound(externalRef: string): Promise<CronResult>
}

type ReconcileResult = {
  readonly state: 'completed' | 'unavailable' | 'budget_exhausted'
  readonly processed: number
  readonly mutations: number
  readonly operations?: number
  readonly reason?: string
}

type Module = {
  reconcileCronBindings(input: {
    readonly store: Store
    readonly controlPort: Port
    readonly now?: () => number
    readonly maxBindings?: number
    readonly budgetMs?: number
  }): Promise<ReconcileResult>
}

async function loadModule(): Promise<{ readonly module?: Module; readonly error?: unknown }> {
  try {
    return { module: await import('../src/cron-reconciliation.ts') as unknown as Module }
  } catch (error: unknown) {
    return { error }
  }
}

function intent(id: string, desiredState: DesiredState = 'running', overrides: Partial<Intent> = {}): Intent {
  return {
    commitmentId: id,
    externalRef: `assistant:${id}`,
    desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 15 }),
    desiredCwd: '/tmp/reconcile',
    desiredState,
    boundJobId: null,
    commitmentStatus: desiredState === 'paused' ? 'paused' : desiredState === 'cancelled' ? 'active' : 'blocked',
    monitorDirection: `完整方向 ${id}`,
    controlError: null,
    ...overrides,
  }
}

function desiredSchedule(row: Intent): Record<string, unknown> {
  try {
    return JSON.parse(row.desiredScheduleJson) as Record<string, unknown>
  } catch {
    return { kind: 'interval', minutes: 15 }
  }
}

function matchingJob(row: Intent, id = `job-${row.commitmentId}`): Job {
  return {
    id,
    schedule: desiredSchedule(row),
    prompt: row.monitorDirection!,
    ...(row.desiredCwd === null ? {} : { cwd: row.desiredCwd }),
  }
}

function ok(activeJob: Job | null): CronResult {
  return { ok: true, snapshot: { activeJob, latestRun: null } }
}

function world(options: {
  readonly rows: readonly Intent[]
  readonly activeJobs?: Readonly<Record<string, Job | null>>
  readonly getResult?: CronResult
  readonly mutationResult?: CronResult
}): {
  readonly store: Store & { listCronBindings(): readonly Intent[] }
  readonly port: Port
  readonly calls: string[]
  readonly mutations: Array<{ readonly name: string; readonly input?: Record<string, unknown>; readonly externalRef?: string }>
  readonly updates: Record<string, unknown>[]
  readonly statuses: Array<{ readonly id: string; readonly status: CommitmentStatus }>
  readonly closed: string[]
  readonly errors: Record<string, unknown>[]
} {
  const calls: string[] = []
  const mutations: Array<{ readonly name: string; readonly input?: Record<string, unknown>; readonly externalRef?: string }> = []
  const updates: Record<string, unknown>[] = []
  const statuses: Array<{ readonly id: string; readonly status: CommitmentStatus }> = []
  const closed: string[] = []
  const errors: Record<string, unknown>[] = []
  const store = {
    listCronReconciliationIntents: () => options.rows,
    // Keep the old method only as a runtime seam. The implementation must
    // stop reading it and use the joined reconciliation-intent port above.
    listCronBindings: () => options.rows,
    updateCronBindingActual: (input: Record<string, unknown>) => {
      updates.push(input)
      return { ok: true, row: input }
    },
    clearCronBoundJobId: (input: Record<string, unknown>) => {
      updates.push({ ...input, boundJobId: null })
      return { ok: true, row: { ...input, boundJobId: null } }
    },
    setCommitmentStatus: (id: string, status: CommitmentStatus) => {
      statuses.push({ id, status })
      return { ok: true, row: { id, status } }
    },
    closeCommitment: (id: string) => {
      closed.push(id)
      return { ok: true, row: { id, status: 'cancelled' } }
    },
    recordCronControlError: (input: Record<string, unknown>) => {
      errors.push(input)
      return { ok: true, row: input }
    },
  }
  const port: Port = {
    readiness: async () => ({ state: 'ready' }),
    getBound: async externalRef => {
      calls.push(`get:${externalRef}`)
      return options.getResult ?? ok(options.activeJobs?.[externalRef] ?? null)
    },
    ensureBound: async input => {
      calls.push(`ensure:${String(input.externalRef)}`)
      mutations.push({ name: 'ensure', input })
      return options.mutationResult ?? ok({
        id: `job-ensured-${String(input.externalRef)}`,
        schedule: input.schedule as Record<string, unknown>,
        prompt: String(input.prompt),
        ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
      })
    },
    replaceBound: async input => {
      calls.push(`replace:${String(input.externalRef)}`)
      mutations.push({ name: 'replace', input })
      return options.mutationResult ?? ok({
        id: `job-replaced-${String(input.externalRef)}`,
        schedule: input.schedule as Record<string, unknown>,
        prompt: String(input.prompt),
        ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
      })
    },
    deleteBound: async externalRef => {
      calls.push(`delete:${externalRef}`)
      mutations.push({ name: 'delete', externalRef })
      return options.mutationResult ?? ok(null)
    },
  }
  return { store, port, calls, mutations, updates, statuses, closed, errors }
}

describe('assistant cron startup reconciliation (first red)', () => {
  it.each([
    ['schedule', { schedule: { kind: 'interval', minutes: 30 } }],
    ['direction', { prompt: '另一个方向' }],
    ['cwd', { cwd: '/tmp/other-cwd' }],
  ])('gets each running ref first, ensures an absent job, and replaces when %s differs', async (_label, difference) => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const absent = intent('running-absent')
    const same = intent('running-same')
    const mismatch = intent('running-mismatch')
    const duplicate = { ...same, commitmentId: 'duplicate-row' }
    const mismatchJob = { ...matchingJob(mismatch, 'job-existing'), ...difference } as Job
    const currentJobs = {
      [same.externalRef]: matchingJob(same, 'job-same'),
      [mismatch.externalRef]: mismatchJob,
    }
    const fixture = world({ rows: [absent, same, duplicate, mismatch], activeJobs: currentJobs })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })

    expect(result.state).toBe('completed')
    expect(result.mutations).toBe(2)
    expect(fixture.calls).toEqual([
      `get:${absent.externalRef}`, `ensure:${absent.externalRef}`,
      `get:${same.externalRef}`,
      `get:${mismatch.externalRef}`, `replace:${mismatch.externalRef}`,
    ])
    expect(new Set(fixture.calls.filter(call => call.startsWith('get:'))).size).toBe(3)
    expect(fixture.mutations.map(mutation => mutation.name)).toEqual(['ensure', 'replace'])
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ commitmentId: absent.commitmentId, boundJobId: `job-ensured-${absent.externalRef}` }),
      expect.objectContaining({ commitmentId: same.commitmentId, boundJobId: 'job-same' }),
      expect.objectContaining({ commitmentId: mismatch.commitmentId, boundJobId: `job-replaced-${mismatch.externalRef}` }),
    ]))
    expect(fixture.statuses).toEqual(expect.arrayContaining([
      { id: absent.commitmentId, status: 'active' },
      { id: same.commitmentId, status: 'active' },
      { id: mismatch.commitmentId, status: 'active' },
    ]))
  })

  it('does not churn an already exact active job, but allows one projection to clear a stale control error', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const exact = intent('idempotent-exact', 'running', {
      commitmentStatus: 'active',
      boundJobId: 'job-idempotent-exact',
      controlError: null,
    })
    const fixture = world({
      rows: [exact],
      activeJobs: { [exact.externalRef]: matchingJob(exact, 'job-idempotent-exact') },
    })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })
    expect(result.mutations).toBe(0)
    expect(fixture.calls).toEqual([`get:${exact.externalRef}`])
    expect(fixture.updates).toEqual([])
    expect(fixture.statuses).toEqual([])
    expect(fixture.errors).toEqual([])
    expect(fixture.closed).toEqual([])

    const stale = intent('idempotent-clear-error', 'running', {
      commitmentStatus: 'active',
      boundJobId: 'job-idempotent-clear-error',
      controlError: 'old manager error',
    })
    const staleFixture = world({
      rows: [stale],
      activeJobs: { [stale.externalRef]: matchingJob(stale, 'job-idempotent-clear-error') },
    })
    const staleResult = await loaded.module.reconcileCronBindings({ store: staleFixture.store, controlPort: staleFixture.port })
    expect(staleResult.mutations).toBe(0)
    expect(staleFixture.calls).toEqual([`get:${stale.externalRef}`])
    expect(staleFixture.updates).toEqual([expect.objectContaining({
      commitmentId: stale.commitmentId,
      boundJobId: 'job-idempotent-clear-error',
    })])
    expect(staleFixture.statuses).toEqual([])
    expect(staleFixture.errors).toEqual([])
  })

  it('deletes only active paused/cancelled jobs, clears actual ids, and settles their local responsibility state', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const pausedActive = intent('paused-active', 'paused', { commitmentStatus: 'blocked', boundJobId: 'stale-paused-active' })
    const pausedAbsent = intent('paused-absent', 'paused', { commitmentStatus: 'blocked', boundJobId: 'stale-paused-absent' })
    const cancelledActive = intent('cancelled-active', 'cancelled', { boundJobId: 'stale-cancelled-active' })
    const cancelledAbsent = intent('cancelled-absent', 'cancelled', { boundJobId: 'stale-cancelled-absent' })
    const fixture = world({
      rows: [pausedActive, pausedAbsent, cancelledActive, cancelledAbsent],
      activeJobs: {
        [pausedActive.externalRef]: matchingJob(pausedActive),
        [cancelledActive.externalRef]: matchingJob(cancelledActive),
      },
    })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })

    expect(result.state).toBe('completed')
    expect(result.mutations).toBe(2)
    expect(fixture.calls).toEqual([
      `get:${pausedActive.externalRef}`, `delete:${pausedActive.externalRef}`,
      `get:${pausedAbsent.externalRef}`,
      `get:${cancelledActive.externalRef}`, `delete:${cancelledActive.externalRef}`,
      `get:${cancelledAbsent.externalRef}`,
    ])
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ commitmentId: pausedActive.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: pausedAbsent.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: cancelledActive.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: cancelledAbsent.commitmentId, boundJobId: null }),
    ]))
    expect(fixture.statuses).toEqual(expect.arrayContaining([{ id: pausedActive.commitmentId, status: 'paused' }, { id: pausedAbsent.commitmentId, status: 'paused' }]))
    expect(fixture.closed).toEqual(expect.arrayContaining([cancelledActive.commitmentId, cancelledAbsent.commitmentId]))
  })

  it('does not require obsolete running prompt configuration before parking paused/cancelled responsibilities', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const pausedActive = intent('paused-bad-active', 'paused', {
      commitmentStatus: 'blocked', boundJobId: 'stale-paused-bad-active', desiredScheduleJson: '{broken-json', monitorDirection: null,
    })
    const pausedAbsent = intent('paused-bad-absent', 'paused', {
      commitmentStatus: 'blocked', boundJobId: 'stale-paused-bad-absent', desiredScheduleJson: '{broken-json', monitorDirection: null,
    })
    const cancelledActive = intent('cancelled-bad-active', 'cancelled', {
      boundJobId: 'stale-cancelled-bad-active', desiredScheduleJson: '{broken-json', monitorDirection: null,
    })
    const cancelledAbsent = intent('cancelled-bad-absent', 'cancelled', {
      boundJobId: 'stale-cancelled-bad-absent', desiredScheduleJson: '{broken-json', monitorDirection: null,
    })
    const fixture = world({
      rows: [pausedActive, pausedAbsent, cancelledActive, cancelledAbsent],
      activeJobs: {
        [pausedActive.externalRef]: matchingJob(pausedActive),
        [cancelledActive.externalRef]: matchingJob(cancelledActive),
      },
    })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })
    expect(result.state).toBe('completed')
    expect(result.mutations).toBe(2)
    expect(fixture.calls).toEqual([
      `get:${pausedActive.externalRef}`, `delete:${pausedActive.externalRef}`,
      `get:${pausedAbsent.externalRef}`,
      `get:${cancelledActive.externalRef}`, `delete:${cancelledActive.externalRef}`,
      `get:${cancelledAbsent.externalRef}`,
    ])
    expect(fixture.errors).toEqual([])
    expect(fixture.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ commitmentId: pausedActive.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: pausedAbsent.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: cancelledActive.commitmentId, boundJobId: null }),
      expect.objectContaining({ commitmentId: cancelledAbsent.commitmentId, boundJobId: null }),
    ]))
    expect(fixture.statuses).toEqual(expect.arrayContaining([
      { id: pausedActive.commitmentId, status: 'paused' },
      { id: pausedAbsent.commitmentId, status: 'paused' },
    ]))
    expect(fixture.closed).toEqual(expect.arrayContaining([cancelledActive.commitmentId, cancelledAbsent.commitmentId]))
  })

  it('treats a successful delete that still reports an active job as protocol failure without clearing or settling', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const row = intent('delete-protocol-active', 'paused', { commitmentStatus: 'blocked', boundJobId: 'stale-delete-protocol' })
    const fixture = world({ rows: [row], activeJobs: { [row.externalRef]: matchingJob(row) } })
    fixture.port.deleteBound = async externalRef => {
      fixture.calls.push(`delete:${externalRef}`)
      fixture.mutations.push({ name: 'delete', externalRef })
      return ok(matchingJob(row, 'job-still-active'))
    }
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })
    expect(result.state).toBe('completed')
    expect(result.mutations).toBe(1)
    expect(fixture.errors).toEqual([expect.objectContaining({ commitmentId: row.commitmentId, code: 'protocol_error' })])
    expect(fixture.updates).toEqual([])
    expect(fixture.statuses).toEqual([{ id: row.commitmentId, status: 'blocked' }])
    expect(fixture.closed).toEqual([])
  })

  it.each([
    ['mutation', { mutationResult: { ok: false, code: 'control_unavailable', message: 'manager unavailable' } }],
    ['protocol', { mutationResult: { ok: true, snapshot: { activeJob: null } } }],
  ])('records %s failure, blocks the responsibility, and does not project success', async (_label, options) => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const row = intent(`failure-${_label}`)
    const fixture = world({ rows: [row], ...options })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })

    expect(result.state).toBe('completed')
    expect(fixture.errors).toEqual([expect.objectContaining({ commitmentId: row.commitmentId, code: expect.any(String) })])
    expect(fixture.statuses).toEqual([{ id: row.commitmentId, status: 'blocked' }])
    expect(fixture.updates).toEqual([])
    expect(fixture.closed).toEqual([])
  })

  it.each([
    ['ok:false', { getResult: { ok: false, code: 'control_unavailable', message: 'manager unavailable' } }],
    ['throw', undefined],
  ])('records getBound %s without blocking or changing an active responsibility', async (_label, options) => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const row = intent(`get-failure-${_label}`, 'running', { commitmentStatus: 'active', boundJobId: 'manager-job-still-running' })
    const fixture = world({ rows: [row], ...(options ?? {}) })
    if (_label === 'throw') {
      fixture.port.getBound = async externalRef => {
        fixture.calls.push(`get:${externalRef}`)
        throw new Error('manager socket unavailable')
      }
    }
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })

    expect(result.state).toBe('completed')
    expect(result.processed).toBe(1)
    expect(result.mutations).toBe(0)
    expect(fixture.calls).toEqual([`get:${row.externalRef}`])
    expect(fixture.mutations).toEqual([])
    expect(fixture.errors).toEqual([expect.objectContaining({
      commitmentId: row.commitmentId,
      code: 'control_unavailable',
    })])
    expect(fixture.statuses).toEqual([])
    expect(fixture.updates).toEqual([])
    expect(fixture.closed).toEqual([])
    expect(row.desiredState).toBe('running')
    expect(row.commitmentStatus).toBe('active')
  })

  it.each([
    ['invalid JSON', { desiredScheduleJson: '{broken-json' }],
    ['zero interval', { desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 0 }) }],
    ['empty direction', { monitorDirection: '' }],
  ])('blocks running %s after getBound without ensure or replace', async (_label, overrides) => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const row = intent(`bad-running-${_label}`, 'running', overrides)
    const fixture = world({ rows: [row] })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })
    expect(result.state).toBe('completed')
    expect(result.mutations).toBe(0)
    expect(fixture.calls).toEqual([`get:${row.externalRef}`])
    expect(fixture.mutations).toEqual([])
    expect(fixture.updates).toEqual([])
    expect(fixture.errors).toEqual([expect.objectContaining({ commitmentId: row.commitmentId, code: 'persistence_failed' })])
    expect(fixture.statuses).toEqual([{ id: row.commitmentId, status: 'blocked' }])
  })

  it.each(['unavailable', 'throws'])('calls readiness once and does no read/write when readiness is %s', async mode => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const row = intent(`readiness-${mode}`)
    const fixture = world({ rows: [row] })
    let readinessCalls = 0
    fixture.port.readiness = async () => {
      readinessCalls++
      if (mode === 'throws') throw new Error('manager socket unavailable')
      return { state: 'unavailable', reason: 'manager socket unavailable' }
    }
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port })
    expect(result.state).toBe('unavailable')
    expect(result.processed).toBe(0)
    expect(result.mutations).toBe(0)
    expect(readinessCalls).toBe(1)
    expect(fixture.calls).toEqual([])
    expect(fixture.updates).toEqual([])
    expect(fixture.errors).toEqual([])
    expect(fixture.statuses).toEqual([])
    expect(fixture.closed).toEqual([])
  })

  it('processes at most 100 unique refs from a 150-intent read', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const rows = Array.from({ length: 150 }, (_, index) => intent(`bounded-${index}`))
    const fixture = world({ rows })
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port, maxBindings: 100, now: () => 0 })
    const readRefs = fixture.calls.filter(call => call.startsWith('get:'))
    expect(result.state).toBe('completed')
    expect(result.processed).toBe(100)
    expect(result.mutations).toBe(100)
    expect(readRefs).toHaveLength(100)
    expect(new Set(readRefs).size).toBe(100)
    expect(fixture.calls.some(call => call.includes('bounded-100'))).toBe(false)
  })

  it('stops before starting another ref when the 30 second wall budget is reached', async () => {
    const loaded = await loadModule()
    expect(loaded.error, 'cron reconciliation module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const rows = Array.from({ length: 5 }, (_, index) => intent(`budget-${index}`))
    const fixture = world({ rows })
    let clock = 0
    const originalGet = fixture.port.getBound
    fixture.port.getBound = async externalRef => {
      const result = await originalGet(externalRef)
      clock += 20_000
      return result
    }
    const originalEnsure = fixture.port.ensureBound
    fixture.port.ensureBound = async input => {
      const result = await originalEnsure(input)
      clock += 20_000
      return result
    }
    const result = await loaded.module.reconcileCronBindings({ store: fixture.store, controlPort: fixture.port, now: () => clock, budgetMs: 30_000 })
    expect(result.state).toBe('budget_exhausted')
    expect(result.processed).toBe(1)
    expect(result.mutations).toBe(1)
    expect(fixture.calls).toEqual([`get:${rows[0]!.externalRef}`, `ensure:${rows[0]!.externalRef}`])
    expect(fixture.calls.some(call => call.includes('budget-1'))).toBe(false)
  })

  it('keeps startup reconciliation out of ReminderRuntime and its periodic tick', () => {
    const source = readFileSync(new URL('../src/reminders.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/reconcileCronBindings|cron-reconciliation|startup reconciliation/i)
  })
})
