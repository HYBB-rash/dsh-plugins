/**
 * Lane C / F: red tests for a cron-bound monitor runtime.
 *
 * dsh-cron already owns the clock, run, and Telegram result delivery.  A
 * bound monitor therefore observes manager facts and updates its assistant
 * binding; it must not spawn/follow up a continuable child or create a second
 * monitor-event/result outbox.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type CronSnapshot = {
  readonly externalRef: string
  readonly activeJob: Record<string, unknown> | null
  readonly latestRun: Record<string, unknown> | null
}

type CronPort = {
  getBound(externalRef: string): Promise<{ readonly ok: true; readonly snapshot: CronSnapshot } | { readonly ok: false; readonly code: string; readonly message: string }>
}

type MonitorStore = {
  findCronBindingByJobId(jobId: string): { readonly commitmentId: string; readonly externalRef: string } | undefined
  observeCronRunFinished(input: Record<string, unknown>): unknown
  listOutbox(commitmentId: string): readonly Record<string, unknown>[]
  recordCronControlError(input: Record<string, unknown>): unknown
  setCommitmentStatus(commitmentId: string, status: string): unknown
}

type CronBoundRuntime = {
  bind(input: Record<string, unknown>): Promise<Record<string, unknown>>
  handleRunFinished(event: Record<string, unknown>): Promise<Record<string, unknown>>
}

type MonitorModule = {
  createCronBoundMonitorRuntime(input: {
    readonly store: MonitorStore
    readonly controlPort: CronPort
    readonly now?: () => string
  }): CronBoundRuntime
}

async function loadMonitorModule(): Promise<{ readonly module?: MonitorModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-bound-monitor.ts') as unknown as MonitorModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

const COMMITMENT_ID = 'cron-bound-monitor-1'
const EXTERNAL_REF = `assistant:${COMMITMENT_ID}`

describe('cron-bound monitor does not create an assistant worker (first red)', () => {
  it('binds without startContinuable/followup and creates no monitor_event or result outbox', async () => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const outbox: Record<string, unknown>[] = []
    const store: MonitorStore = {
      findCronBindingByJobId: () => undefined,
      observeCronRunFinished: () => {},
      listOutbox: () => outbox,
      recordCronControlError: () => ({ ok: true }),
      setCommitmentStatus: () => ({ ok: true }),
    }
    const source = readFileSync(new URL('../src/cron-bound-monitor.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/startContinuable|followup|subagents|WorkerController/)
    expect(source).not.toMatch(/(?:from|require\()\s*["'][^"']*worker/)
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store,
      controlPort: {
        getBound: async externalRef => ({ ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }),
      },
    })
    await expect(runtime.bind({ commitmentId: COMMITMENT_ID, externalRef: EXTERNAL_REF })).resolves.toMatchObject({ ok: true })
    expect(outbox).toEqual([])
  })

  it('uses getBound latestRun as the observation truth, not event正文, and still creates no assistant result outbox', async () => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const observations: Record<string, unknown>[] = []
    const outbox: Record<string, unknown>[] = []
    const bindingLookups: string[] = []
    const store: MonitorStore = {
      findCronBindingByJobId: jobId => {
        bindingLookups.push(jobId)
        return jobId === 'job-actual-1' ? { commitmentId: COMMITMENT_ID, externalRef: EXTERNAL_REF } : undefined
      },
      observeCronRunFinished: input => {
        observations.push(input)
        return { ok: true, row: input }
      },
      listOutbox: () => outbox,
      recordCronControlError: () => ({ ok: true }),
      setCommitmentStatus: () => ({ ok: true }),
    }
    const getBoundCalls: string[] = []
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store,
      controlPort: {
        getBound: async externalRef => {
          getBoundCalls.push(externalRef)
          return {
            ok: true,
            snapshot: {
              externalRef,
              activeJob: { id: 'job-actual-1' },
              latestRun: {
                runId: 'run-actual-1', jobId: 'job-actual-1',
                scheduledFor: '2026-08-18T03:00:00.000Z', finishedAt: '2026-08-18T03:00:02.000Z',
                runStatus: 'success', summary: 'manager latest bounded fact', deliveryState: 'silent',
              },
            },
          }
        },
      },
    })
    await expect(runtime.handleRunFinished({
      jobId: 'job-actual-1',
      runId: 'run-actual-1',
    })).resolves.toMatchObject({ ok: true })
    expect(bindingLookups).toEqual(['job-actual-1'])
    expect(getBoundCalls).toEqual([EXTERNAL_REF])
    expect(observations).toEqual([expect.objectContaining({
      commitmentId: COMMITMENT_ID,
      externalRef: EXTERNAL_REF,
      runId: 'run-actual-1',
      jobId: 'job-actual-1',
      runStatus: 'success',
      deliveryState: 'silent',
      summary: 'manager latest bounded fact',
    })])
    expect(outbox).toEqual([])
  })

  it.each([
    ['success+silent without summary', {
      runId: 'manager-success',
      jobId: 'job-manager-fact',
      scheduledFor: '2026-08-18T04:00:00.000Z',
      finishedAt: '2026-08-18T04:00:02.000Z',
      runStatus: 'success',
      deliveryState: 'silent',
    }, {
      runStatus: 'success',
      deliveryState: 'silent',
    }],
    ['error+failed with independent run and delivery errors', {
      runId: 'manager-error',
      jobId: 'job-manager-fact',
      scheduledFor: '2026-08-18T05:00:00.000Z',
      finishedAt: '2026-08-18T05:00:03.000Z',
      runStatus: 'error',
      error: 'manager run failed',
      deliveryState: 'failed',
      deliveryError: 'manager delivery failed',
    }, {
      runStatus: 'error',
      error: 'manager run failed',
      deliveryState: 'failed',
      deliveryError: 'manager delivery failed',
    }],
  ])('persists the manager latestRun fact for %s without a worker or second outbox', async (_label, latestRun, expected) => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const observations: Record<string, unknown>[] = []
    const outbox: Record<string, unknown>[] = []
    const controlErrors: Record<string, unknown>[] = []
    const statusChanges: Array<{ readonly id: string; readonly status: string }> = []
    const store: MonitorStore = {
      findCronBindingByJobId: jobId => jobId === 'job-manager-fact' ? { commitmentId: COMMITMENT_ID, externalRef: EXTERNAL_REF } : undefined,
      observeCronRunFinished: input => {
        observations.push(input)
        return { ok: true, row: input }
      },
      listOutbox: () => outbox,
      recordCronControlError: input => {
        controlErrors.push(input)
        return { ok: true }
      },
      setCommitmentStatus: (id, status) => {
        statusChanges.push({ id, status })
        return { ok: true }
      },
    }
    const fixedNow = '2026-08-18T06:00:00.000Z'
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store,
      now: () => fixedNow,
      controlPort: {
        getBound: async externalRef => ({
          ok: true,
          snapshot: {
            externalRef,
            activeJob: { id: 'job-manager-fact' },
            latestRun,
          },
        }),
      },
    })

    await expect(runtime.handleRunFinished({
      jobId: 'job-manager-fact',
      runId: 'event-run-is-only-a-trigger',
      summary: 'forged event正文 must not win',
      error: 'forged event error must not win',
    })).resolves.toMatchObject({ ok: true })
    expect(observations).toEqual([expect.objectContaining({
      commitmentId: COMMITMENT_ID,
      externalRef: EXTERNAL_REF,
      runId: latestRun.runId,
      jobId: latestRun.jobId,
      scheduledFor: latestRun.scheduledFor,
      finishedAt: latestRun.finishedAt,
      ...expected,
      now: fixedNow,
    })])
    if (expected.runStatus === 'success') {
      expect(observations[0]).not.toHaveProperty('summary')
      expect(observations[0]).not.toHaveProperty('error')
      expect(observations[0]).not.toHaveProperty('deliveryError')
    }
    expect(outbox).toEqual([])
    expect(controlErrors).toEqual([])
    expect(statusChanges).toEqual([])
  })

  it.each([
    ['throw', async (_externalRef: string) => { throw new Error('manager socket unavailable') }, 'control_unavailable'],
    ['error response', async (_externalRef: string) => ({ ok: false as const, code: 'manager_unavailable', message: 'manager refused getBound' }), 'manager_unavailable'],
  ])('records a getBound %s without changing the active monitor lifecycle', async (_label, getBound, expectedCode) => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const controlErrors: Record<string, unknown>[] = []
    const statusChanges: Array<{ readonly id: string; readonly status: string }> = []
    const observations: Record<string, unknown>[] = []
    const store: MonitorStore = {
      findCronBindingByJobId: () => ({ commitmentId: COMMITMENT_ID, externalRef: EXTERNAL_REF }),
      observeCronRunFinished: input => {
        observations.push(input)
        return { ok: true, row: input }
      },
      listOutbox: () => [],
      recordCronControlError: input => {
        controlErrors.push(input)
        return { ok: true, row: input }
      },
      setCommitmentStatus: (id, status) => {
        statusChanges.push({ id, status })
        return { ok: true, row: { id, status } }
      },
    }
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store,
      now: () => '2026-08-18T06:00:00.000Z',
      controlPort: { getBound },
    })

    await expect(runtime.handleRunFinished({ jobId: 'job-actual-1', runId: 'trigger-run' })).resolves.toMatchObject({
      ok: false,
      code: expectedCode,
    })
    expect(controlErrors).toEqual([expect.objectContaining({
      commitmentId: COMMITMENT_ID,
      externalRef: EXTERNAL_REF,
    })])
    expect(statusChanges).toEqual([])
    expect(observations).toEqual([])
  })

  it.each([
    ['undefined', () => undefined],
    ['error result', () => ({ ok: false, code: 'persistence_failed', message: 'binding write failed' })],
  ])('returns persistence_failed when Store observation returns %s and creates no outbox', async (_label, persist) => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const outbox: Record<string, unknown>[] = []
    const controlErrors: Record<string, unknown>[] = []
    const statusChanges: Array<{ readonly id: string; readonly status: string }> = []
    const store: MonitorStore = {
      findCronBindingByJobId: () => ({ commitmentId: COMMITMENT_ID, externalRef: EXTERNAL_REF }),
      observeCronRunFinished: () => persist(),
      listOutbox: () => outbox,
      recordCronControlError: input => {
        controlErrors.push(input)
        return { ok: true }
      },
      setCommitmentStatus: (id, status) => {
        statusChanges.push({ id, status })
        return { ok: true }
      },
    }
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store,
      now: () => '2026-08-18T06:00:00.000Z',
      controlPort: {
        getBound: async externalRef => ({
          ok: true,
          snapshot: {
            externalRef,
            activeJob: { id: 'job-actual-1' },
            latestRun: {
              runId: 'manager-error',
              jobId: 'job-actual-1',
              scheduledFor: '2026-08-18T05:00:00.000Z',
              finishedAt: '2026-08-18T05:00:03.000Z',
              runStatus: 'error',
              error: 'manager run failed',
              deliveryState: 'failed',
              deliveryError: 'manager delivery failed',
            },
          },
        }),
      },
    })

    await expect(runtime.handleRunFinished({ jobId: 'job-actual-1', runId: 'trigger-run' })).resolves.toMatchObject({
      ok: false,
      code: 'persistence_failed',
    })
    expect(outbox).toEqual([])
    expect(statusChanges).toEqual([])
    expect(controlErrors).toEqual([])
  })

  it('ignores a non-assistant/X job before getBound and keeps delegated/focus/reminder paths separate', async () => {
    const loaded = await loadMonitorModule()
    expect(loaded.error, 'cron-bound monitor runtime module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const bindingLookups: string[] = []
    const getBoundCalls: string[] = []
    const observations: Record<string, unknown>[] = []
    const runtime = loaded.module.createCronBoundMonitorRuntime({
      store: {
        findCronBindingByJobId: jobId => {
          bindingLookups.push(jobId)
          return undefined
        },
        observeCronRunFinished: input => {
          observations.push(input)
          return { ok: true, row: input }
        },
        listOutbox: () => [],
        recordCronControlError: () => ({ ok: true }),
        setCommitmentStatus: () => ({ ok: true }),
      },
      controlPort: {
        getBound: async externalRef => {
          getBoundCalls.push(externalRef)
          return { ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }
        },
      },
    })
    await expect(runtime.handleRunFinished({ jobId: 'business-job', runId: 'run-business' })).resolves.toMatchObject({ ok: true, ignored: true })
    expect(bindingLookups).toEqual(['business-job'])
    expect(getBoundCalls).toEqual([])
    expect(observations).toEqual([])

    const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    const reminderSource = readFileSync(new URL('../src/reminders.ts', import.meta.url), 'utf8')
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(workerSource).toMatch(/startContinuable/)
    expect(workerSource).toMatch(/followup/)
    expect(reminderSource).toMatch(/queueDueReminders|pumpOnce/)
    expect(indexSource).not.toMatch(/monitorTick:\s*async[\s\S]*continueMonitors/)
    expect(indexSource).toMatch(/cron-bound|Cron-bound/)
    expect(indexSource).not.toMatch(/由现有 reminder tick 自动启动完整快照的新一轮/)
  })
})
