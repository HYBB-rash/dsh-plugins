/** One bounded startup repair pass for already-bound Cron responsibilities. */

import type {
  AssistantCronActiveJob,
  AssistantCronControlPort,
  AssistantCronControlResult,
  AssistantCronSchedule,
} from './cron-control-port.ts'

type DesiredState = 'running' | 'paused' | 'cancelled'
type CommitmentStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled'

type ReconciliationIntent = {
  readonly commitmentId: string
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd: string | null
  readonly desiredState: DesiredState
  readonly boundJobId: string | null
  readonly controlError: string | null
  readonly commitmentStatus: CommitmentStatus
  readonly monitorDirection: string | null
}

type ReconcileStore = {
  listCronReconciliationIntents(limit?: number): readonly ReconciliationIntent[]
  updateCronBindingActual(input: Record<string, unknown>): unknown
  clearCronBoundJobId(input: Record<string, unknown>): unknown
  setCommitmentStatus(id: string, status: CommitmentStatus): unknown
  closeCommitment(id: string): unknown
  recordCronControlError(input: Record<string, unknown>): unknown
}

type ReconcileResult = {
  readonly state: 'completed' | 'unavailable' | 'budget_exhausted'
  readonly processed: number
  /** Number of Cron writes: ensure, replace, or delete. Reads are excluded. */
  readonly mutations: number
  /** Compatibility alias; it has the same write-only meaning as mutations. */
  readonly operations: number
  readonly reason?: string
}

type Failure = { readonly code: string; readonly message: string }

function unavailable(reason: string): ReconcileResult {
  return { state: 'unavailable', processed: 0, mutations: 0, operations: 0, reason }
}

function persistenceSucceeded(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'object') return false
  return (value as { readonly ok?: unknown }).ok !== false
}

function controlFailure(value: unknown): Failure | undefined {
  if (typeof value !== 'object' || value === null) return { code: 'protocol_error', message: 'Cron control returned an invalid response' }
  const candidate = value as { readonly ok?: unknown; readonly code?: unknown; readonly errorCode?: unknown; readonly message?: unknown }
  if (candidate.ok === true) return undefined
  return {
    code: typeof candidate.code === 'string' ? candidate.code : typeof candidate.errorCode === 'string' ? candidate.errorCode : 'control_unavailable',
    message: typeof candidate.message === 'string' ? candidate.message : 'Cron control operation failed',
  }
}

function activeJob(value: unknown): { readonly job: AssistantCronActiveJob | null; readonly failure?: Failure } {
  const failed = controlFailure(value)
  if (failed !== undefined) return { job: null, failure: failed }
  const snapshot = (value as { readonly snapshot?: unknown }).snapshot
  if (typeof snapshot !== 'object' || snapshot === null) {
    return { job: null, failure: { code: 'protocol_error', message: 'Cron control response has no snapshot' } }
  }
  const job = (snapshot as { readonly activeJob?: unknown }).activeJob
  if (job === null) return { job: null }
  if (typeof job !== 'object' || job === null) {
    return { job: null, failure: { code: 'protocol_error', message: 'Cron control snapshot has an invalid active job' } }
  }
  const id = (job as { readonly id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    return { job: null, failure: { code: 'protocol_error', message: 'Cron control snapshot active job has no id' } }
  }
  return { job: job as AssistantCronActiveJob }
}

function parseSchedule(raw: string): { readonly schedule?: AssistantCronSchedule; readonly failure?: Failure } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { failure: { code: 'persistence_failed', message: 'The persisted Cron schedule is not valid JSON.' } }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { failure: { code: 'persistence_failed', message: 'The persisted Cron schedule is not an object.' } }
  }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'cron' && typeof candidate.expr === 'string' && candidate.expr.trim() !== '') {
    return { schedule: { kind: 'cron', expr: candidate.expr } }
  }
  if (candidate.kind === 'interval' && typeof candidate.minutes === 'number' && Number.isSafeInteger(candidate.minutes) && candidate.minutes > 0) {
    return { schedule: { kind: 'interval', minutes: candidate.minutes } }
  }
  if (candidate.kind === 'once' && typeof candidate.runAt === 'string' && Number.isFinite(Date.parse(candidate.runAt))) {
    return { schedule: { kind: 'once', runAt: candidate.runAt } }
  }
  return { failure: { code: 'persistence_failed', message: 'The persisted Cron schedule is invalid.' } }
}

function desiredSpec(row: ReconciliationIntent, schedule: AssistantCronSchedule): { readonly spec?: { readonly externalRef: string; readonly schedule: AssistantCronSchedule; readonly prompt: string; readonly cwd?: string }; readonly failure?: Failure } {
  const direction = typeof row.monitorDirection === 'string' ? row.monitorDirection.trim() : ''
  if (direction === '') return { failure: { code: 'persistence_failed', message: 'The monitor has no persisted monitor direction.' } }
  return {
    spec: {
      externalRef: row.externalRef,
      schedule,
      prompt: direction,
      ...(row.desiredCwd === null ? {} : { cwd: row.desiredCwd }),
    },
  }
}

function scheduleEqual(left: AssistantCronSchedule, right: AssistantCronSchedule): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function specMatches(job: AssistantCronActiveJob, spec: { readonly schedule: AssistantCronSchedule; readonly prompt: string; readonly cwd?: string }): boolean {
  const jobCwd = typeof job.cwd === 'string' ? job.cwd : undefined
  return scheduleEqual(job.schedule, spec.schedule) && job.prompt === spec.prompt && jobCwd === spec.cwd
}

function recordControlError(store: ReconcileStore, row: ReconciliationIntent, error: Failure): void {
  store.recordCronControlError({
    commitmentId: row.commitmentId,
    externalRef: row.externalRef,
    code: error.code,
    error: error.message,
  })
}

function block(store: ReconcileStore, row: ReconciliationIntent, error: Failure): void {
  recordControlError(store, row, error)
  store.setCommitmentStatus(row.commitmentId, 'blocked')
}

function projectJob(store: ReconcileStore, row: ReconciliationIntent, jobId: string): Failure | undefined {
  const result = store.updateCronBindingActual({ commitmentId: row.commitmentId, externalRef: row.externalRef, boundJobId: jobId })
  return persistenceSucceeded(result) ? undefined : { code: 'persistence_failed', message: 'Cron job projection did not persist.' }
}

function clearStaleJob(store: ReconcileStore, row: ReconciliationIntent): Failure | undefined {
  if (row.boundJobId === null && row.controlError === null) return undefined
  const result = store.clearCronBoundJobId({ commitmentId: row.commitmentId, externalRef: row.externalRef })
  return persistenceSucceeded(result) ? undefined : { code: 'persistence_failed', message: 'Cron job projection clear did not persist.' }
}

function settle(store: ReconcileStore, row: ReconciliationIntent, status: 'active' | 'paused' | 'cancelled'): Failure | undefined {
  if (status === 'cancelled') {
    if (row.commitmentStatus === 'cancelled') return undefined
    const result = store.closeCommitment(row.commitmentId)
    return persistenceSucceeded(result) ? undefined : { code: 'persistence_failed', message: 'Cancelled responsibility state did not persist.' }
  }
  if (row.commitmentStatus === status) return undefined
  const result = store.setCommitmentStatus(row.commitmentId, status)
  return persistenceSucceeded(result) ? undefined : { code: 'persistence_failed', message: `Responsibility ${status} state did not persist.` }
}

async function readBound(input: { readonly controlPort: AssistantCronControlPort; readonly externalRef: string }): Promise<{ readonly job: AssistantCronActiveJob | null; readonly failure?: Failure }> {
  try {
    return activeJob(await input.controlPort.getBound(input.externalRef))
  } catch (error: unknown) {
    return { job: null, failure: { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) } }
  }
}

export async function reconcileCronBindings(input: {
  readonly store: ReconcileStore
  readonly controlPort: AssistantCronControlPort
  readonly now?: () => number
  readonly maxBindings?: number
  readonly budgetMs?: number
}): Promise<ReconcileResult> {
  const now = input.now ?? Date.now
  const maxBindings = Math.min(Math.max(0, input.maxBindings ?? 100), 100)
  const budgetMs = Math.max(0, input.budgetMs ?? 30_000)
  let readiness: { readonly state: 'ready' | 'unavailable'; readonly reason?: string }
  try {
    readiness = await input.controlPort.readiness()
  } catch (error: unknown) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
  if (readiness.state !== 'ready') return unavailable(readiness.reason ?? 'dsh-cron control plane is unavailable')

  const startedAt = now()
  // Keep the pass bounded even if an adapter ignores the port's limit.
  const intents = input.store.listCronReconciliationIntents(maxBindings).slice(0, maxBindings)
  const seenRefs = new Set<string>()
  let processed = 0
  let mutations = 0
  let budgetExhausted = false

  for (const row of intents) {
    if (now() - startedAt >= budgetMs) {
      budgetExhausted = true
      break
    }
    if (seenRefs.has(row.externalRef)) continue
    seenRefs.add(row.externalRef)
    processed++

    const bound = await readBound({ controlPort: input.controlPort, externalRef: row.externalRef })
    if (bound.failure !== undefined) {
      // A getBound failure only means that this observation pass cannot
      // confirm the manager snapshot.  The scheduler may still be healthy,
      // so keep the durable responsibility lifecycle unchanged.
      recordControlError(input.store, row, bound.failure)
      continue
    }
    // A parked responsibility no longer needs a valid desired prompt or
    // schedule.  First make sure the manager has no active job, then clear
    // any stale local projection and settle the local lifecycle state.
    if (row.desiredState !== 'running') {
      if (bound.job !== null) {
        mutations++
        let result: AssistantCronControlResult
        try {
          result = await input.controlPort.deleteBound(row.externalRef)
        } catch (error: unknown) {
          block(input.store, row, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
          continue
        }
        const controlError = controlFailure(result)
        if (controlError !== undefined) {
          block(input.store, row, controlError)
          continue
        }
        const deleted = activeJob(result)
        if (deleted.failure !== undefined || deleted.job !== null) {
          block(input.store, row, deleted.failure ?? { code: 'protocol_error', message: 'Cron delete returned an active job.' })
          continue
        }
      }
      const clearFailure = clearStaleJob(input.store, row)
      if (clearFailure !== undefined) {
        block(input.store, row, clearFailure)
        continue
      }
      const statusFailure = settle(input.store, row, row.desiredState === 'paused' ? 'paused' : 'cancelled')
      if (statusFailure !== undefined) block(input.store, row, statusFailure)
      continue
    }

    const parsed = parseSchedule(row.desiredScheduleJson)
    if (parsed.schedule === undefined) {
      block(input.store, row, parsed.failure ?? { code: 'persistence_failed', message: 'Cron reconciliation intent is invalid.' })
      continue
    }
    const specResult = desiredSpec(row, parsed.schedule)
    if (specResult.failure !== undefined) {
      block(input.store, row, specResult.failure)
      continue
    }
    if (specResult.spec === undefined) {
      block(input.store, row, { code: 'persistence_failed', message: 'Cron reconciliation intent is invalid.' })
      continue
    }
    const spec = specResult.spec

    {
      let result: AssistantCronControlResult
      if (bound.job === null) {
        mutations++
        try {
          result = await input.controlPort.ensureBound(spec)
        } catch (error: unknown) {
          block(input.store, row, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
          continue
        }
      } else if (specMatches(bound.job, spec)) {
        const needsProjection = row.boundJobId !== bound.job.id || row.controlError !== null
        if (needsProjection) {
          const projectionFailure = projectJob(input.store, row, bound.job.id)
          if (projectionFailure !== undefined) {
            block(input.store, row, projectionFailure)
            continue
          }
        }
        if (row.commitmentStatus !== 'active') {
          const statusFailure = settle(input.store, row, 'active')
          if (statusFailure !== undefined) block(input.store, row, statusFailure)
        }
        continue
      } else {
        mutations++
        try {
          result = await input.controlPort.replaceBound(spec)
        } catch (error: unknown) {
          block(input.store, row, { code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) })
          continue
        }
      }
      const controlError = controlFailure(result)
      if (controlError !== undefined) {
        block(input.store, row, controlError)
        continue
      }
      const ensured = activeJob(result)
      if (ensured.failure !== undefined || ensured.job === null) {
        block(input.store, row, ensured.failure ?? { code: 'protocol_error', message: 'Cron mutation returned no active job.' })
        continue
      }
      const projectionFailure = projectJob(input.store, row, ensured.job.id)
      if (projectionFailure !== undefined) {
        block(input.store, row, projectionFailure)
        continue
      }
      const statusFailure = settle(input.store, row, 'active')
      if (statusFailure !== undefined) block(input.store, row, statusFailure)
      continue
    }
  }

  return {
    state: budgetExhausted ? 'budget_exhausted' : 'completed',
    processed,
    mutations,
    operations: mutations,
  }
}
