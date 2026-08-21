/**
 * Application control use cases for an assistant-owned Cron binding.
 *
 * This module depends only on local DTOs and a narrow store port. It never
 * opens a Cron database, writes jobs.jsonl, or creates a worker/queue. The
 * store is the only source of assistant state; there is no process-local
 * binding cache.
 */

import type {
  AssistantCronBindingSpec,
  AssistantCronControlPort,
  AssistantCronControlResult,
  AssistantCronSchedule,
} from './cron-control-port.ts'

type CommitmentSnapshot = {
  readonly monitorDirection: string | null
  readonly revision: number
  readonly status: string
}

type CronBindingSnapshot = {
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd: string | null
  readonly boundJobId: string | null
  readonly createdAt: string
}

type Store = {
  getCommitment(id: string): CommitmentSnapshot | undefined
  getCronBinding(id: string): CronBindingSnapshot | undefined
  saveCronBinding(input: Record<string, unknown>): unknown
  updateCronMonitorDirection(input: { readonly commitmentId: string; readonly expectedRevision: number; readonly direction: string; readonly now: string }): unknown
  updateCronBoundJobId(id: string, jobId: string): unknown
  setCronDesiredState(id: string, state: 'running' | 'paused' | 'cancelled'): unknown
  setCommitmentStatus(id: string, status: string): unknown
  recordCronControlError(id: string, error: string): unknown
  closeCommitment(id: string): unknown
}

type Schedule = AssistantCronSchedule

export type CronControlResult = AssistantCronControlResult | { readonly ok: false; readonly code: string; readonly message: string }

export interface CronControlUseCase {
  bindMonitor(input: { readonly commitmentId: string; readonly schedule?: Schedule; readonly cwd?: string }): Promise<CronControlResult>
  resumeMonitor(input: { readonly commitmentId: string; readonly schedule?: Schedule; readonly cwd?: string }): Promise<CronControlResult>
  pauseMonitor(commitmentId: string): Promise<CronControlResult>
  cancelMonitor(commitmentId: string): Promise<CronControlResult>
  reviseMonitor(input: { readonly commitmentId: string; readonly direction: string }): Promise<CronControlResult>
}

function failure(code: string, message: string): { readonly ok: false; readonly code: string; readonly message: string } {
  return { ok: false, code, message }
}

function externalRefOf(commitmentId: string): string {
  return `assistant:${commitmentId}`
}

function scheduleFromBinding(binding: CronBindingSnapshot | undefined): Schedule | undefined {
  if (binding === undefined) return undefined
  const raw = binding.desiredScheduleJson
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as Record<string, unknown>
    if (candidate.kind === 'cron' && typeof candidate.expr === 'string') return { kind: 'cron', expr: candidate.expr }
    if (candidate.kind === 'interval' && typeof candidate.minutes === 'number') return { kind: 'interval', minutes: candidate.minutes }
    if (candidate.kind === 'once' && typeof candidate.runAt === 'string') return { kind: 'once', runAt: candidate.runAt }
  } catch {
    // A malformed persisted schedule is treated exactly like an absent one;
    // guessing from a monitor title would be an unsafe recovery.
  }
  return undefined
}

function actualJobId(result: AssistantCronControlResult): string | undefined {
  if (!result.ok) return undefined
  const id = result.snapshot.activeJob?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function persistedFailure(value: unknown, operation = 'Assistant Cron binding persistence'): { readonly code: string; readonly message: string } | undefined {
  if (value === undefined || value === null) {
    return { code: 'persistence_failed', message: `${operation} returned no row.` }
  }
  if (typeof value !== 'object') return { code: 'persistence_failed', message: `${operation} returned an invalid result.` }
  const candidate = value as { ok?: unknown; code?: unknown; message?: unknown }
  if (candidate.ok !== false) return undefined
  return {
    code: typeof candidate.code === 'string' ? candidate.code : 'persistence_failed',
    message: typeof candidate.message === 'string' ? candidate.message : 'Assistant Cron binding persistence failed',
  }
}

export function createCronControlUseCase(input: {
  readonly store: Store
  readonly controlPort: AssistantCronControlPort
  readonly now?: () => string
}): CronControlUseCase {
  const now = input.now ?? (() => new Date().toISOString())

  const bindingFor = (commitmentId: string): CronBindingSnapshot | undefined => input.store.getCronBinding(commitmentId)

  const promptFor = (commitmentId: string): string | undefined => {
    const commitment = input.store.getCommitment(commitmentId)
    const direction = commitment?.monitorDirection
    if (typeof direction === 'string' && direction.trim() !== '') return direction.trim()
    return undefined
  }

  const controlSpec = (commitmentId: string, schedule: Schedule, cwd: string | undefined, prompt: string): AssistantCronBindingSpec => ({
    externalRef: externalRefOf(commitmentId),
    schedule,
    prompt,
    ...(cwd === undefined ? {} : { cwd }),
  })

  const desiredBinding = (
    commitmentId: string,
    schedule: Schedule,
    cwd: string | undefined,
    state: 'running' | 'paused' | 'cancelled',
    existing?: CronBindingSnapshot,
  ): Record<string, unknown> => ({
    commitmentId,
    externalRef: externalRefOf(commitmentId),
    desiredScheduleJson: JSON.stringify(schedule),
    desiredCwd: cwd ?? (typeof existing?.desiredCwd === 'string' ? existing.desiredCwd : null),
    desiredState: state,
    ...(typeof existing?.boundJobId === 'string' ? { boundJobId: existing.boundJobId } : {}),
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now(),
    updatedAt: now(),
  })

  const persistDesired = (commitmentId: string, desired: Record<string, unknown>): CronControlResult | undefined => {
    const persisted = input.store.saveCronBinding(desired)
    const error = persistedFailure(persisted, 'Assistant Cron desired binding persistence')
    if (error === undefined) return undefined
    input.store.recordCronControlError(commitmentId, error.message)
    input.store.setCommitmentStatus(commitmentId, 'blocked')
    return failure(error.code, error.message)
  }

  const markControlFailure = (commitmentId: string, result: { readonly code: string; readonly message: string }): CronControlResult => {
    input.store.recordCronControlError(commitmentId, result.message)
    input.store.setCommitmentStatus(commitmentId, 'blocked')
    return failure(result.code, result.message)
  }

  const ensureAndActivate = async (commitmentId: string, schedule: Schedule, cwd: string | undefined, prompt: string): Promise<CronControlResult> => {
    let result: AssistantCronControlResult
    try {
      result = await input.controlPort.ensureBound(controlSpec(commitmentId, schedule, cwd, prompt))
    } catch (error: unknown) {
      return markControlFailure(commitmentId, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
    }
    if (!result.ok) return markControlFailure(commitmentId, result)
    const jobId = actualJobId(result)
    if (jobId === undefined) return markControlFailure(commitmentId, { code: 'protocol_error', message: 'Cron ensure response has no active job id' })
    const bound = input.store.updateCronBoundJobId(commitmentId, jobId)
    const boundError = persistedFailure(bound, 'Assistant Cron actual job projection')
    if (boundError !== undefined) return markControlFailure(commitmentId, boundError)
    const status = input.store.setCommitmentStatus(commitmentId, 'active')
    const statusError = persistedFailure(status, 'Assistant monitor activation')
    if (statusError !== undefined) return markControlFailure(commitmentId, statusError)
    return result
  }

  const deleteAndSettle = async (commitmentId: string, state: 'paused' | 'cancelled'): Promise<CronControlResult> => {
    const binding = bindingFor(commitmentId)
    const externalRef = typeof binding?.externalRef === 'string' ? binding.externalRef : externalRefOf(commitmentId)
    let result: AssistantCronControlResult
    try {
      result = await input.controlPort.deleteBound(externalRef)
    } catch (error: unknown) {
      return markControlFailure(commitmentId, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
    }
    if (!result.ok) return markControlFailure(commitmentId, result)
    const settled = state === 'cancelled'
      ? input.store.closeCommitment(commitmentId)
      : input.store.setCommitmentStatus(commitmentId, 'paused')
    const settledError = persistedFailure(settled, `Assistant monitor ${state} transition`)
    if (settledError !== undefined) return markControlFailure(commitmentId, settledError)
    return result
  }

  return {
    async bindMonitor({ commitmentId, schedule, cwd }) {
      if (schedule === undefined) return failure('schedule_required', 'A new Cron monitor requires an explicit schedule.')
      const prompt = promptFor(commitmentId)
      if (prompt === undefined) return failure('persistence_failed', 'The monitor has no persisted monitor direction.')
      const persisted = persistDesired(commitmentId, desiredBinding(commitmentId, schedule, cwd, 'running'))
      if (persisted !== undefined) return persisted
      return ensureAndActivate(commitmentId, schedule, cwd, prompt)
    },

    async resumeMonitor({ commitmentId, schedule, cwd }) {
      const existing = bindingFor(commitmentId)
      const effectiveSchedule = schedule ?? scheduleFromBinding(existing)
      if (effectiveSchedule === undefined) return failure('schedule_required', 'The first legacy Cron resume requires an explicit schedule.')
      const prompt = promptFor(commitmentId)
      if (prompt === undefined) return failure('persistence_failed', 'The monitor has no persisted monitor direction.')
      const effectiveCwd = cwd ?? (typeof existing?.desiredCwd === 'string' ? existing.desiredCwd : undefined)
      const persisted = persistDesired(commitmentId, desiredBinding(commitmentId, effectiveSchedule, effectiveCwd, 'running', existing))
      if (persisted !== undefined) return persisted
      return ensureAndActivate(commitmentId, effectiveSchedule, effectiveCwd, prompt)
    },

    async pauseMonitor(commitmentId) {
      const desired = input.store.setCronDesiredState(commitmentId, 'paused')
      const desiredError = persistedFailure(desired, 'Assistant Cron pause intent persistence')
      if (desiredError !== undefined) return markControlFailure(commitmentId, desiredError)
      return deleteAndSettle(commitmentId, 'paused')
    },

    async cancelMonitor(commitmentId) {
      const desired = input.store.setCronDesiredState(commitmentId, 'cancelled')
      const desiredError = persistedFailure(desired, 'Assistant Cron cancel intent persistence')
      if (desiredError !== undefined) return markControlFailure(commitmentId, desiredError)
      return deleteAndSettle(commitmentId, 'cancelled')
    },

    async reviseMonitor({ commitmentId, direction }) {
      const nextDirection = direction.trim()
      if (nextDirection === '') return failure('invalid_transition', 'Monitor direction must be non-empty.')
      const binding = bindingFor(commitmentId)
      if (binding === undefined) return failure('schedule_required', 'An unbound legacy monitor needs an explicit schedule before direction revision.')
      const schedule = scheduleFromBinding(binding)
      if (schedule === undefined) return failure('schedule_required', 'The persisted Cron schedule is missing or invalid.')
      const commitment = input.store.getCommitment(commitmentId)
      const revision = commitment?.revision
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) {
        return failure('persistence_failed', 'The monitor revision is unavailable; direction was not changed.')
      }
      const paused = commitment?.status === 'paused'
      if (typeof input.store.updateCronMonitorDirection !== 'function') {
        return failure('persistence_failed', 'The monitor direction store API is unavailable; direction was not changed.')
      }
      const persisted = input.store.updateCronMonitorDirection({
        commitmentId,
        expectedRevision: revision,
        direction: nextDirection,
        now: now(),
      })
      const persistedError = persistedFailure(persisted, 'Assistant monitor direction persistence')
      if (persistedError !== undefined) return markControlFailure(commitmentId, persistedError)
      const updatedCommitment = input.store.getCommitment(commitmentId)
      const prompt = typeof updatedCommitment?.monitorDirection === 'string' && updatedCommitment.monitorDirection.trim() !== ''
        ? updatedCommitment.monitorDirection.trim()
        : undefined
      if (prompt === undefined) return failure('persistence_failed', 'The monitor has no persisted monitor direction.')
      if (paused) {
        return {
          ok: true,
          snapshot: {
            externalRef: typeof binding.externalRef === 'string' ? binding.externalRef : externalRefOf(commitmentId),
            activeJob: null,
            latestRun: null,
          },
        }
      }
      let result: AssistantCronControlResult
      try {
        const effectiveCwd = typeof binding.desiredCwd === 'string' ? binding.desiredCwd : undefined
        result = await input.controlPort.replaceBound(controlSpec(commitmentId, schedule, effectiveCwd, prompt))
      } catch (error: unknown) {
        return markControlFailure(commitmentId, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
      }
      if (!result.ok) return markControlFailure(commitmentId, result)
      const jobId = actualJobId(result)
      if (jobId === undefined) return markControlFailure(commitmentId, { code: 'protocol_error', message: 'Cron replace response has no active job id' })
      const projected = input.store.updateCronBoundJobId(commitmentId, jobId)
      const projectedError = persistedFailure(projected, 'Assistant Cron revised job projection')
      if (projectedError !== undefined) return markControlFailure(commitmentId, projectedError)
      return result
    },
  }
}
