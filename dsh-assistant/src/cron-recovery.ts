/** Explicit, zero-guess recovery for a blocked legacy monitor. */

import type { AssistantCronBindingSnapshot, AssistantCronControlPort, AssistantCronControlResult, AssistantCronSchedule } from './cron-control-port.ts'

type RecoveryStore = {
  findCommitmentById(id: string): Record<string, unknown> | undefined
  listOutbox(commitmentId: string): readonly Record<string, unknown>[]
  prepareCronRebind(input: Record<string, unknown>): unknown
  updateCronBoundJobId(commitmentId: string, jobId: string): unknown
  setCommitmentStatus(id: string, status: string): unknown
  recordCronControlError(id: string, error: string): unknown
}

type RebindResult =
  | { readonly ok: true; readonly snapshot: AssistantCronBindingSnapshot }
  | { readonly ok: false; readonly code: string; readonly message: string }

function unsafe(message: string): { readonly ok: false; readonly code: 'recovery_not_safe'; readonly message: string } {
  return { ok: false, code: 'recovery_not_safe', message }
}

function nonEmpty(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
}

function persistenceFailure(message: string): { readonly ok: false; readonly code: 'persistence_failed'; readonly message: string } {
  return { ok: false, code: 'persistence_failed', message }
}

export async function rebindLegacyMonitor(input: {
  readonly store: RecoveryStore
  readonly controlPort: AssistantCronControlPort
  readonly commitmentId: string
  readonly externalRef: string
  readonly schedule: Record<string, unknown>
  readonly now: string
}): Promise<RebindResult> {
  const commitment = input.store.findCommitmentById(input.commitmentId)
  if (commitment === undefined || commitment.id !== input.commitmentId) return unsafe('The legacy monitor target is missing or not exact.')
  if (commitment.kind !== 'monitor' || commitment.workOwner !== 'agent' || commitment.status !== 'blocked') {
    return unsafe('Only a blocked Agent-owned monitor may be explicitly rebound.')
  }
  const direction = typeof commitment.monitorDirection === 'string' ? commitment.monitorDirection.trim() : ''
  if (direction === '') return unsafe('The blocked legacy monitor has no persisted monitor direction.')
  const unsafeWorkerOrClaim = [
    ['workerSessionId', commitment.workerSessionId],
    ['workerRunId', commitment.workerRunId],
    ['workerParentSessionId', commitment.workerParentSessionId],
    ['workerControlState', commitment.workerControlState === undefined || commitment.workerControlState === 'none' ? null : commitment.workerControlState],
    ['monitorResumeState', commitment.monitorResumeState === undefined || commitment.monitorResumeState === 'none' ? null : commitment.monitorResumeState],
    ['monitorClaimToken', commitment.monitorClaimToken],
    ['monitorClaimedAt', commitment.monitorClaimedAt],
  ] as const
  const residual = unsafeWorkerOrClaim.find(([, value]) => nonEmpty(value))
  if (residual !== undefined) return unsafe(`Legacy monitor recovery is unsafe while ${residual[0]} remains.`)
  const outbox = input.store.listOutbox(input.commitmentId)
  if (outbox.some(row => row.state === 'pending' || row.state === 'claimed')) {
    return unsafe('Legacy monitor recovery is unsafe while a pending or claimed outbox row exists.')
  }

  const prepared = input.store.prepareCronRebind({
    commitmentId: input.commitmentId,
    externalRef: input.externalRef,
    desiredScheduleJson: JSON.stringify(input.schedule),
    desiredState: 'running',
    now: input.now,
    clearWorkerSessionId: true,
    clearWorkerRunId: true,
    clearWorkerParentSessionId: true,
    clearWorkerControlState: true,
    clearMonitorResumeState: true,
    clearMonitorClaim: true,
  })
  if (prepared === undefined || prepared === null || typeof prepared !== 'object' || (prepared as { readonly ok?: unknown }).ok === false) {
    return persistenceFailure('Assistant Cron legacy rebind preparation did not persist a binding row.')
  }

  let result: AssistantCronControlResult
  try {
    result = await input.controlPort.ensureBound({
      externalRef: input.externalRef,
      schedule: input.schedule as AssistantCronSchedule,
      prompt: direction,
    })
  } catch (error: unknown) {
    result = { ok: false, code: 'control_unavailable', message: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) {
    input.store.recordCronControlError(input.commitmentId, result.message)
    input.store.setCommitmentStatus(input.commitmentId, 'blocked')
    return result
  }
  const jobId = result.snapshot.activeJob?.id
  if (typeof jobId !== 'string' || jobId === '') {
    const protocol = { ok: false as const, code: 'protocol_error', message: 'Cron ensure response has no active job id' }
    input.store.recordCronControlError(input.commitmentId, protocol.message)
    input.store.setCommitmentStatus(input.commitmentId, 'blocked')
    return protocol
  }
  input.store.updateCronBoundJobId(input.commitmentId, jobId)
  input.store.setCommitmentStatus(input.commitmentId, 'active')
  return { ok: true, snapshot: result.snapshot }
}
