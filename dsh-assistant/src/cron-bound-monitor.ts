/** Observe manager-owned Cron runs without creating an assistant worker. */

import type { AssistantCronBindingSnapshot, AssistantCronControlPort } from './cron-control-port.ts'

type CronRunStatus = 'success' | 'error' | 'expired' | 'interrupted'
type CronDeliveryState = 'delivered' | 'silent' | 'not_requested' | 'failed' | 'uncertain'

type CronRunObservation = {
  readonly commitmentId: string
  readonly externalRef: string
  readonly runId: string
  readonly jobId: string
  readonly scheduledFor: string
  readonly finishedAt: string
  readonly runStatus: CronRunStatus
  readonly summary?: string
  readonly error?: string
  readonly deliveryState: CronDeliveryState
  readonly deliveredAt?: string
  readonly deliveryError?: string
  readonly now: string
}

type MonitorStore = {
  findCronBindingByJobId(jobId: string): { readonly commitmentId: string; readonly externalRef: string } | undefined
  observeCronRunFinished(input: CronRunObservation): unknown
  recordCronControlError(input: Record<string, unknown>): unknown
}

type RuntimeResult = Record<string, unknown>

function persistenceSucceeded(value: unknown): boolean {
  if (value === undefined || value === null || typeof value !== 'object') return false
  return (value as { readonly ok?: unknown }).ok !== false
}

function persistenceFailure(): RuntimeResult {
  return { ok: false, code: 'persistence_failed', message: 'Cron observation state did not persist.' }
}

export interface CronBoundMonitorRuntime {
  bind(input: Record<string, unknown>): Promise<RuntimeResult>
  handleRunFinished(event: Record<string, unknown>): Promise<RuntimeResult>
}

export function createCronBoundMonitorRuntime(input: {
  readonly store: MonitorStore
  readonly controlPort: AssistantCronControlPort
  readonly now?: () => string
}): CronBoundMonitorRuntime {
  const now = input.now ?? (() => new Date().toISOString())

  const reportControlFailure = (binding: { readonly commitmentId: string; readonly externalRef: string }, failure: { readonly code: string; readonly message: string }): RuntimeResult => {
    let persisted: unknown
    try {
      persisted = input.store.recordCronControlError({
        commitmentId: binding.commitmentId,
        externalRef: binding.externalRef,
        code: failure.code,
        error: failure.message,
      })
    } catch {
      return persistenceFailure()
    }
    return persistenceSucceeded(persisted)
      ? { ok: false, code: failure.code, message: failure.message }
      : persistenceFailure()
  }

  const bind = async (binding: Record<string, unknown>): Promise<RuntimeResult> => {
    const externalRef = typeof binding.externalRef === 'string' ? binding.externalRef : ''
    if (externalRef === '') return { ok: false, code: 'invalid_request', message: 'externalRef is required' }
    return { ok: true, externalRef }
  }

  const handleRunFinished = async (event: Record<string, unknown>): Promise<RuntimeResult> => {
    const jobId = typeof event.jobId === 'string' ? event.jobId : ''
    if (jobId === '') return { ok: false, code: 'invalid_request', message: 'jobId is required' }
    const binding = input.store.findCronBindingByJobId(jobId)
    if (binding === undefined) return { ok: true, ignored: true }
    let result: Awaited<ReturnType<AssistantCronControlPort['getBound']>>
    try {
      result = await input.controlPort.getBound(binding.externalRef)
    } catch (error: unknown) {
      return reportControlFailure(binding, {
        code: 'control_unavailable',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (!result.ok) return reportControlFailure(binding, { code: result.code, message: result.message })
    const snapshot: AssistantCronBindingSnapshot = result.snapshot
    const latestRun = snapshot.latestRun
    if (latestRun === null) return { ok: true, ignored: true }
    let observed: unknown
    try {
      observed = input.store.observeCronRunFinished({
        commitmentId: binding.commitmentId,
        externalRef: binding.externalRef,
        runId: latestRun.runId,
        jobId: latestRun.jobId,
        scheduledFor: latestRun.scheduledFor,
        finishedAt: latestRun.finishedAt,
        runStatus: latestRun.runStatus,
        ...(latestRun.summary === undefined ? {} : { summary: latestRun.summary }),
        ...(latestRun.error === undefined ? {} : { error: latestRun.error }),
        deliveryState: latestRun.deliveryState,
        ...(latestRun.deliveredAt === undefined ? {} : { deliveredAt: latestRun.deliveredAt }),
        ...(latestRun.deliveryError === undefined ? {} : { deliveryError: latestRun.deliveryError }),
        now: now(),
      })
    } catch {
      return persistenceFailure()
    }
    if (!persistenceSucceeded(observed)) return persistenceFailure()
    return { ok: true, observation: observed }
  }

  return { bind, handleRunFinished }
}
