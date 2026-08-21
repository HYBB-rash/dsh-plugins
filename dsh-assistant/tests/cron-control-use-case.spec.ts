/**
 * Lane C / C: red tests for the application control use case.
 *
 * The use case owns desired responsibility state and calls an injected local
 * AssistantCronControlPort.  It never writes jobs.jsonl and never guesses a
 * schedule from a monitor title/direction.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantStore } from '../src/store.ts'

type Schedule =
  | { readonly kind: 'cron'; readonly expr: string }
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'once'; readonly runAt: string }

type ControlResult =
  | { readonly ok: true; readonly snapshot: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string }

type LocalPort = {
  ensureBound(input: Record<string, unknown>): Promise<ControlResult>
  replaceBound(input: Record<string, unknown>): Promise<ControlResult>
  deleteBound(externalRef: string): Promise<ControlResult>
  getBound(externalRef: string): Promise<ControlResult>
  readiness(): Promise<{ readonly state: 'ready' | 'unavailable'; readonly reason?: string }>
}

type FakeStore = {
  getCommitment(id: string): Record<string, unknown> | undefined
  getCronBinding(id: string): Record<string, unknown> | undefined
  updateCronMonitorDirection(input: Record<string, unknown>): unknown
  saveCronBinding(input: Record<string, unknown>): unknown
  updateCronBoundJobId(id: string, jobId: string): unknown
  setCronDesiredState(id: string, state: 'running' | 'paused' | 'cancelled'): unknown
  setCommitmentStatus(id: string, status: string): unknown
  recordCronControlError(id: string, error: string): unknown
  closeCommitment(id: string): unknown
}

type CronControlUseCase = {
  bindMonitor(input: { readonly commitmentId: string; readonly schedule?: Schedule; readonly cwd?: string }): Promise<Record<string, unknown>>
  resumeMonitor(input: { readonly commitmentId: string; readonly schedule?: Schedule; readonly cwd?: string }): Promise<Record<string, unknown>>
  pauseMonitor(commitmentId: string): Promise<Record<string, unknown>>
  cancelMonitor(commitmentId: string): Promise<Record<string, unknown>>
  reviseMonitor(input: { readonly commitmentId: string; readonly direction: string }): Promise<Record<string, unknown>>
}

type ControlModule = {
  createCronControlUseCase(input: {
    readonly store: FakeStore
    readonly controlPort: LocalPort
    readonly now?: () => string
  }): CronControlUseCase
}

async function loadControlModule(): Promise<{ readonly module?: ControlModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-control.ts') as unknown as ControlModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

const MONITOR_ID = 'monitor-use-case-1'
const EXTERNAL_REF = `assistant:${MONITOR_ID}`
const SCHEDULE: Schedule = { kind: 'interval', minutes: 30 }
const NOW = '2026-08-18T08:00:00.000Z'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  let binding: Record<string, unknown> | undefined
  let commitment: Record<string, unknown> = {
    id: MONITOR_ID,
    kind: 'monitor',
    status: 'pending',
    title: '只观察指定目标',
    monitorDirection: '只观察指定目标',
    workerSessionId: null,
    revision: 1,
  }
  return {
    getCommitment: overrides.getCommitment ?? (() => commitment),
    getCronBinding: overrides.getCronBinding ?? (() => binding),
    updateCronMonitorDirection: input => {
      const expectedRevision = Number(input.expectedRevision)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== Number(commitment.revision)) {
        return { ok: false, code: 'revision_mismatch', message: 'fake monitor revision mismatch' }
      }
      commitment = {
        ...commitment,
        monitorDirection: typeof input.direction === 'string' ? input.direction : commitment.monitorDirection,
        revision: expectedRevision + 1,
      }
      overrides.updateCronMonitorDirection?.(input)
      return { ok: true, row: commitment }
    },
    saveCronBinding: input => {
      binding = { ...binding, ...input }
      overrides.saveCronBinding?.(input)
      return { ok: true, row: binding }
    },
    updateCronBoundJobId: (id, jobId) => {
      binding = { ...binding, commitmentId: id, boundJobId: jobId }
      overrides.updateCronBoundJobId?.(id, jobId)
      return binding
    },
    setCronDesiredState: (id, state) => {
      binding = { ...binding, commitmentId: id, desiredState: state }
      overrides.setCronDesiredState?.(id, state)
      return binding
    },
    setCommitmentStatus: (id, status) => {
      commitment = { ...commitment, id, status, revision: Number(commitment.revision ?? 0) + 1 }
      overrides.setCommitmentStatus?.(id, status)
      return commitment
    },
    recordCronControlError: (id, error) => {
      overrides.recordCronControlError?.(id, error)
      return binding ?? { commitmentId: id, controlError: error }
    },
    closeCommitment: id => {
      commitment = { ...commitment, id, status: 'cancelled', revision: Number(commitment.revision ?? 0) + 1 }
      overrides.closeCommitment?.(id)
      return commitment
    },
  }
}

function fakePort(options: {
  readonly ensure?: ControlResult
  readonly delete?: ControlResult
  readonly sequence?: string[]
} = {}): { readonly port: LocalPort; readonly ensureCalls: Record<string, unknown>[]; readonly deleteCalls: string[]; readonly sequence: string[] } {
  const ensureCalls: Record<string, unknown>[] = []
  const deleteCalls: string[] = []
  const sequence = options.sequence ?? []
  const success = (externalRef: string): ControlResult => ({
    ok: true,
    snapshot: {
      externalRef,
      activeJob: { id: 'job-actual-1', externalRef, schedule: SCHEDULE, prompt: 'monitor', deliver: 'telegram', sessionMode: 'per_run' },
      latestRun: null,
    },
  })
  const port: LocalPort = {
    ensureBound: async input => {
      sequence.push('ensureBound')
      ensureCalls.push(input)
      return options.ensure ?? success(String(input.externalRef))
    },
    replaceBound: async input => {
      sequence.push('replaceBound')
      ensureCalls.push(input)
      return options.ensure ?? success(String(input.externalRef))
    },
    deleteBound: async externalRef => {
      sequence.push('deleteBound')
      deleteCalls.push(externalRef)
      return options.delete ?? { ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }
    },
    getBound: async externalRef => ({ ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }),
    readiness: async () => ({ state: 'ready' }),
  }
  return { port, ensureCalls, deleteCalls, sequence }
}

describe('cron responsibility application control use case (first red)', () => {
  it('requires an explicit schedule for a new monitor and for the first legacy resume', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const calls: string[] = []
    const { port, ensureCalls } = fakePort({ sequence: calls })
    const store = fakeStore({
      saveCronBinding: () => calls.push('saveCronBinding'),
      setCronDesiredState: () => calls.push('set-desired-state'),
      setCommitmentStatus: () => calls.push('setCommitmentStatus'),
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port })

    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID })).resolves.toMatchObject({ code: 'schedule_required' })
    await expect(useCase.resumeMonitor({ commitmentId: MONITOR_ID })).resolves.toMatchObject({ code: 'schedule_required' })
    expect(ensureCalls).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses to bind or resume when the authoritative monitor direction is missing, without persistence or Cron RPC', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const calls: string[] = []
    const { port, ensureCalls } = fakePort({ sequence: calls })
    const store = fakeStore({
      getCommitment: () => ({
        id: MONITOR_ID,
        kind: 'monitor',
        status: 'pending',
        title: '不能替代方向的标题',
        monitorDirection: null,
        workerSessionId: null,
        revision: 1,
      }),
      saveCronBinding: () => {
        calls.push('saveCronBinding')
        return undefined
      },
      recordCronControlError: () => calls.push('recordCronControlError'),
      setCommitmentStatus: () => calls.push('setCommitmentStatus'),
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port, now: () => NOW })

    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({
      ok: false,
      code: 'persistence_failed',
    })
    await expect(useCase.resumeMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({
      ok: false,
      code: 'persistence_failed',
    })
    expect(calls).toEqual([])
    expect(ensureCalls).toEqual([])
  })

  it('runs lifecycle semantics through the port: ensure, delete-preserving-pause, ensure-resume, delete-and-close-cancel', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const storeCalls: Array<{ readonly name: string; readonly args: unknown[] }> = []
    const sequence: string[] = []
    const { port, ensureCalls, deleteCalls } = fakePort({ sequence })
    const store = fakeStore({
      saveCronBinding: input => {
        sequence.push('saveCronBinding')
        storeCalls.push({ name: 'saveCronBinding', args: [input] })
      },
      updateCronBoundJobId: (id, jobId) => {
        sequence.push('updateCronBoundJobId')
        storeCalls.push({ name: 'updateCronBoundJobId', args: [id, jobId] })
      },
      setCronDesiredState: (id, state) => {
        sequence.push(`setCronDesiredState:${state}`)
        storeCalls.push({ name: 'setCronDesiredState', args: [id, state] })
      },
      setCommitmentStatus: (id, status) => {
        sequence.push(`setCommitmentStatus:${status}`)
        storeCalls.push({ name: 'setCommitmentStatus', args: [id, status] })
      },
      closeCommitment: id => {
        sequence.push('closeCommitment')
        storeCalls.push({ name: 'closeCommitment', args: [id] })
      },
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port })

    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({ ok: true })
    expect(ensureCalls).toHaveLength(1)
    expect(ensureCalls[0]).toMatchObject({ externalRef: EXTERNAL_REF, schedule: SCHEDULE })
    expect(storeCalls[0]).toMatchObject({
      name: 'saveCronBinding',
      args: [expect.objectContaining({
        commitmentId: MONITOR_ID,
        externalRef: EXTERNAL_REF,
        desiredState: 'running',
      })],
    })
    expect(storeCalls).toContainEqual({ name: 'updateCronBoundJobId', args: [MONITOR_ID, 'job-actual-1'] })
    expect(sequence).toEqual([
      'saveCronBinding', 'ensureBound', 'updateCronBoundJobId', 'setCommitmentStatus:active',
    ])

    await expect(useCase.pauseMonitor(MONITOR_ID)).resolves.toMatchObject({ ok: true })
    expect(deleteCalls).toEqual([EXTERNAL_REF])
    expect(storeCalls.some(call => call.name === 'setCronDesiredState' && call.args[1] === 'paused')).toBe(true)
    expect(storeCalls.some(call => call.name === 'saveCronBinding')).toBe(true)
    expect(sequence.slice(4)).toEqual(['setCronDesiredState:paused', 'deleteBound', 'setCommitmentStatus:paused'])

    await expect(useCase.resumeMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({ ok: true })
    expect(ensureCalls).toHaveLength(2)
    expect(ensureCalls[1]).toMatchObject({ externalRef: EXTERNAL_REF, schedule: SCHEDULE })
    expect(storeCalls.filter(call => call.name === 'updateCronBoundJobId')).toHaveLength(2)
    expect(storeCalls.filter(call => call.name === 'updateCronBoundJobId')).toEqual([
      { name: 'updateCronBoundJobId', args: [MONITOR_ID, 'job-actual-1'] },
      { name: 'updateCronBoundJobId', args: [MONITOR_ID, 'job-actual-1'] },
    ])
    expect(sequence.slice(7)).toEqual(['saveCronBinding', 'ensureBound', 'updateCronBoundJobId', 'setCommitmentStatus:active'])

    await expect(useCase.cancelMonitor(MONITOR_ID)).resolves.toMatchObject({ ok: true })
    expect(deleteCalls).toEqual([EXTERNAL_REF, EXTERNAL_REF])
    expect(storeCalls.some(call => call.name === 'setCronDesiredState' && call.args[1] === 'cancelled')).toBe(true)
    expect(storeCalls.some(call => call.name === 'closeCommitment' && call.args[0] === MONITOR_ID)).toBe(true)
    expect(sequence.slice(11)).toEqual(['setCronDesiredState:cancelled', 'deleteBound', 'closeCommitment'])
  })

  it('keeps control failure visible and makes a retry idempotent at one externalRef', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const errors: Array<{ readonly id: string; readonly error: string }> = []
    const sequence: string[] = []
    const { port, ensureCalls } = fakePort({ ensure: { ok: false, code: 'control_unavailable', message: 'manager socket unavailable' }, sequence })
    const store = fakeStore({
      recordCronControlError: (id, error) => {
        sequence.push('recordCronControlError')
        errors.push({ id, error })
      },
      setCommitmentStatus: (id, status) => sequence.push(`setCommitmentStatus:${status}`),
      saveCronBinding: input => sequence.push(`saveCronBinding:${String(input.desiredState)}`),
      updateCronBoundJobId: (id, jobId) => sequence.push(`updateCronBoundJobId:${jobId}`),
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port })

    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({ ok: false, code: 'control_unavailable' })
    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({ ok: false, code: 'control_unavailable' })
    expect(ensureCalls).toHaveLength(2)
    expect(ensureCalls[0]?.externalRef).toBe(EXTERNAL_REF)
    expect(ensureCalls[1]?.externalRef).toBe(EXTERNAL_REF)
    expect(errors).toHaveLength(2)
    expect(sequence).toEqual([
      'saveCronBinding:running', 'ensureBound', 'recordCronControlError', 'setCommitmentStatus:blocked',
      'saveCronBinding:running', 'ensureBound', 'recordCronControlError', 'setCommitmentStatus:blocked',
    ])
  })

  it('does not claim pause/cancel succeeded when manager delete fails', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const sequence: string[] = []
    const { port } = fakePort({ delete: { ok: false, code: 'control_unavailable', message: 'manager socket unavailable' }, sequence })
    const storeCalls: string[] = []
    const store = fakeStore({
      getCronBinding: () => ({ commitmentId: MONITOR_ID, externalRef: EXTERNAL_REF, desiredState: 'running' }),
      setCronDesiredState: (_id, state) => {
        sequence.push(`setCronDesiredState:${state}`)
        storeCalls.push(`desired:${state}`)
      },
      setCommitmentStatus: (_id, status) => {
        sequence.push(`setCommitmentStatus:${status}`)
        storeCalls.push(`status:${status}`)
      },
      recordCronControlError: (_id, error) => {
        sequence.push('recordCronControlError')
        storeCalls.push(`error:${error}`)
      },
      closeCommitment: () => {
        sequence.push('closeCommitment')
        storeCalls.push('close')
      },
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port })

    await expect(useCase.pauseMonitor(MONITOR_ID)).resolves.toMatchObject({ ok: false, code: 'control_unavailable' })
    expect(sequence).toEqual(['setCronDesiredState:paused', 'deleteBound', 'recordCronControlError', 'setCommitmentStatus:blocked'])
    expect(storeCalls).toContain('status:blocked')

    sequence.splice(0)
    storeCalls.splice(0)
    await expect(useCase.cancelMonitor(MONITOR_ID)).resolves.toMatchObject({ ok: false, code: 'control_unavailable' })
    expect(sequence).toEqual(['setCronDesiredState:cancelled', 'deleteBound', 'recordCronControlError', 'setCommitmentStatus:blocked'])
    expect(storeCalls).toContain('status:blocked')
    expect(storeCalls).not.toContain('close')
  })

  it('uses the real AssistantStore row contract for binding and direction replacement', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-real-store-'))
    dirs.push(dir)
    const store = new AssistantStore(join(dir, 'assistant.sqlite'))
    const created = store.createAgentCommitment({
      title: '真实 Store monitor',
      kind: 'monitor',
      monitorDirection: '旧方向',
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const port = fakePort()
    const useCase = loaded.module.createCronControlUseCase({
      store: store as unknown as FakeStore,
      controlPort: port.port,
      now: () => NOW,
    })

    await expect(useCase.bindMonitor({ commitmentId: created.row.id, schedule: SCHEDULE, cwd: '/persisted/cron-cwd' })).resolves.toMatchObject({ ok: true })
    expect(port.ensureCalls[0]).toMatchObject({ prompt: '旧方向', cwd: '/persisted/cron-cwd' })
    expect(store.getCronBinding(created.row.id)).toMatchObject({
      commitmentId: created.row.id,
      desiredState: 'running',
      boundJobId: 'job-actual-1',
    })
    expect(store.getCronBinding(created.row.id)).not.toHaveProperty('desiredPrompt')
    expect(store.getById(created.row.id)).toMatchObject({ status: 'active', workerSessionId: null })

    await expect(useCase.reviseMonitor({ commitmentId: created.row.id, direction: '新方向' })).resolves.toMatchObject({ ok: true })
    expect(port.sequence).toContain('replaceBound')
    expect(port.ensureCalls[1]).toMatchObject({ prompt: '新方向', cwd: '/persisted/cron-cwd' })
    expect(store.getById(created.row.id)).toMatchObject({ monitorDirection: '新方向' })
    store.close()
  })

  it('derives resume prompt from the commitment direction even if an old binding row carries a stale prompt field', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const { port, ensureCalls } = fakePort()
    const store = fakeStore({
      getCommitment: () => ({
        id: MONITOR_ID,
        kind: 'monitor',
        status: 'paused',
        title: '不能成为 Cron prompt 的标题',
        monitorDirection: 'commitment 中的完整方向',
        workerSessionId: null,
        revision: 1,
      }),
      getCronBinding: () => ({
        commitmentId: MONITOR_ID,
        externalRef: EXTERNAL_REF,
        desiredScheduleJson: JSON.stringify(SCHEDULE),
        // This is an intentionally injected pre-v4 legacy field. It must not
        // become a second user-visible source of the monitor prompt.
        desiredPrompt: '过期 binding prompt',
        desiredCwd: '/persisted/legacy-cwd',
        desiredState: 'paused',
      }),
    })
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port, now: () => NOW })

    await expect(useCase.resumeMonitor({ commitmentId: MONITOR_ID })).resolves.toMatchObject({ ok: true })
    expect(ensureCalls[0]).toMatchObject({
      externalRef: EXTERNAL_REF,
      prompt: 'commitment 中的完整方向',
      cwd: '/persisted/legacy-cwd',
    })
  })

  it('does not fall back to writing a binding prompt when the required direction mutation API is absent', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const { port, ensureCalls, sequence } = fakePort()
    const store = fakeStore()
    const useCase = loaded.module.createCronControlUseCase({ store, controlPort: port, now: () => NOW })
    await expect(useCase.bindMonitor({ commitmentId: MONITOR_ID, schedule: SCHEDULE })).resolves.toMatchObject({ ok: true })
    ensureCalls.splice(0)
    sequence.splice(0)
    delete (store as unknown as { updateCronMonitorDirection?: unknown }).updateCronMonitorDirection

    await expect(useCase.reviseMonitor({ commitmentId: MONITOR_ID, direction: '不得落入 binding 的新方向' })).resolves.toMatchObject({
      ok: false,
      code: 'persistence_failed',
    })
    expect(ensureCalls).toEqual([])
    expect(sequence).toEqual([])
  })

  it('treats an undefined real-store desired-binding mutation as persistence_failed before Cron RPC', async () => {
    const loaded = await loadControlModule()
    expect(loaded.error, 'cron control use-case module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-undefined-store-'))
    dirs.push(dir)
    const store = new AssistantStore(join(dir, 'assistant.sqlite'))
    const created = store.createAgentCommitment({
      title: 'undefined mutation monitor',
      kind: 'monitor',
      monitorDirection: '只检查目标',
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const originalSave = store.saveCronBinding.bind(store)
    void originalSave
    ;(store as unknown as { saveCronBinding(input: Record<string, unknown>): undefined }).saveCronBinding = () => undefined
    const port = fakePort()
    const useCase = loaded.module.createCronControlUseCase({
      store: store as unknown as FakeStore,
      controlPort: port.port,
      now: () => NOW,
    })

    await expect(useCase.bindMonitor({ commitmentId: created.row.id, schedule: SCHEDULE })).resolves.toMatchObject({
      ok: false,
      code: 'persistence_failed',
    })
    expect(port.sequence).toEqual([])
    store.close()
  })
})
