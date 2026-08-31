/**
 * Manager-owned bound-cron use cases over the existing jobs/runs ledgers.
 *
 * This module is deliberately transport-free. It is the only place that
 * combines the jobs.jsonl job projection with the runs.jsonl run projection;
 * neither ledger becomes a second fact source for the other.
 */

import { createHash, randomUUID } from 'node:crypto'
import { nextRunAfter, parseCron } from './cron.ts'
import { JobStore, RunLedger, RunStore } from './store.ts'
import type {
  BoundCronCommandJobView,
  BoundCronCommandSnapshot,
  BoundCronCommandSpec,
  BoundCronJobView,
  BoundCronSnapshot,
  BoundCronSpec,
  ControlErrorResponse,
  ControlResponse,
  ControlSuccessResponse,
  ControlRpcOperation,
  CronRunDeliveryState,
  CronRunExecutionStatus,
  CronRunSnapshot,
  DshCronControlClientError,
  DshCronControlClient,
  FailureAlertControlSuccessResponse,
  AgentBinding,
  ActiveCronJobInspection,
  AgentBindingInspection,
  DshCronMaintenanceControl,
  MaintenanceControlError,
  TransitionAgentBindingRequest,
  TransitionAgentBindingResult,
  ReanchorCronSchedulesRequest,
  ReanchorCronSchedulesResult,
  InspectScheduleReanchorMigrationRequest,
  InspectScheduleReanchorMigrationResult,
} from './control-contract.ts'
import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_FAILURE_ALERT_AFTER,
  MAX_FAILURE_ALERT_COOLDOWN_MINUTES,
  isCanonicalAgentEnvironmentMarker,
} from './types.ts'
import type {
  AgentEnvironmentMarker,
  AgentJob,
  CommandGate,
  CommandJob,
  FailureAlertPolicy,
  Job,
  JobLogEntry,
  JobSessionMode,
  RunFinishRecord,
  RunScheduleReanchorRecord,
} from './types.ts'

const SUMMARY_LIMIT = 400

export interface ControlServiceConfig {
  readonly storeDir: string
}

export interface MaintenanceControlConfig {
  readonly storeDir: string
}

/**
 * Inspect every active definition through the dsh-cron store abstraction.
 * This is intentionally read-only; production mutations still cross the
 * manager-owned Unix-socket control service.
 */
export function inspectActiveJobs(config: ControlServiceConfig): readonly ActiveCronJobInspection[] {
  return new JobStore(config.storeDir).fold().active.map((job): ActiveCronJobInspection => {
    if (job.kind === 'command') {
      return {
        kind: 'command',
        id: job.id,
        createdAt: job.createdAt,
        ...(job.externalRef === undefined ? {} : { externalRef: job.externalRef }),
        schedule: job.schedule,
        command: job.command,
        deliver: job.deliver,
        ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
        ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
      }
    }
    return {
      kind: 'agent',
      id: job.id,
      createdAt: job.createdAt,
      ...(job.externalRef === undefined ? {} : { externalRef: job.externalRef }),
      schedule: job.schedule,
      prompt: job.prompt,
      deliver: job.deliver,
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
      sessionMode: job.sessionMode,
      ...(job.agentEnvironment === undefined ? {} : { agentEnvironment: job.agentEnvironment }),
      ...(job.gate === undefined ? {} : { gate: job.gate }),
      ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
    }
  })
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

/**
 * Serialize the immutable Agent definition. Binding fields are deliberately
 * omitted; the resulting bytes are stable across object key order and are
 * hashed for the maintenance CAS contract.
 */
function serializeAgentImmutable(job: AgentJob): string {
  const value = {
    kind: 'agent',
    id: job.id,
    schedule: job.schedule,
    prompt: job.prompt,
    deliver: job.deliver,
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    ...(job.gate === undefined ? {} : { gate: job.gate }),
    ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
    createdAt: job.createdAt,
  }
  return canonicalize(value)
}

function agentImmutableSha256(job: AgentJob): string {
  return createHash('sha256').update(serializeAgentImmutable(job), 'utf8').digest('hex')
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}

function isCanonicalIso(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

function agentBinding(job: AgentJob): AgentBinding {
  return {
    sessionMode: job.sessionMode,
    ...(job.agentEnvironment === undefined ? {} : { agentEnvironment: job.agentEnvironment }),
    ...(job.externalRef === undefined ? {} : { externalRef: job.externalRef }),
  }
}

function sameBinding(left: AgentBinding, right: AgentBinding): boolean {
  return left.sessionMode === right.sessionMode
    && left.agentEnvironment === right.agentEnvironment
    && left.externalRef === right.externalRef
    && Object.keys(left).sort().join(',') === Object.keys(right).sort().join(',')
}

function validBinding(value: unknown): value is AgentBinding {
  if (!isObject(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.some(key => !['agentEnvironment', 'externalRef', 'sessionMode'].includes(key))) return false
  if (value.sessionMode !== 'persistent' && value.sessionMode !== 'per_run') return false
  if (value.externalRef !== undefined && (typeof value.externalRef !== 'string' || value.externalRef.trim() === '')) return false
  if (value.agentEnvironment !== undefined && !isCanonicalAgentEnvironmentMarker(value.agentEnvironment)) return false
  return true
}

function maintenanceError(
  errorCode: MaintenanceControlError['errorCode'],
  message: string,
): MaintenanceControlError {
  return { ok: false, errorCode, message }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidCommandPayload(value: unknown): boolean {
  if (!isObject(value)) return false
  return Array.isArray(value.argv)
    && value.argv.length > 0
    && value.argv.every(arg => typeof arg === 'string' && arg.length > 0)
    && typeof value.timeoutSeconds === 'number'
    && Number.isSafeInteger(value.timeoutSeconds)
    && value.timeoutSeconds >= 1
    && value.timeoutSeconds <= MAX_COMMAND_TIMEOUT_SECONDS
    && typeof value.outputMaxBytes === 'number'
    && Number.isSafeInteger(value.outputMaxBytes)
    && value.outputMaxBytes >= 1
    && value.outputMaxBytes <= MAX_COMMAND_OUTPUT_BYTES
}

function isValidCommandGate(value: unknown): value is CommandGate {
  return isObject(value) && value.kind === 'nonempty_stdout' && isValidCommandPayload(value.command)
}

function isValidFailureAlertPolicy(value: unknown): value is FailureAlertPolicy {
  return isObject(value)
    && typeof value.after === 'number'
    && Number.isSafeInteger(value.after)
    && value.after >= 1
    && value.after <= MAX_FAILURE_ALERT_AFTER
    && typeof value.cooldownMinutes === 'number'
    && Number.isSafeInteger(value.cooldownMinutes)
    && value.cooldownMinutes >= 1
    && value.cooldownMinutes <= MAX_FAILURE_ALERT_COOLDOWN_MINUTES
}

/** Validate the explicit set-or-clear value used by the policy-only RPC. */
export function isValidFailureAlertPolicyUpdate(value: unknown): value is FailureAlertPolicy | null {
  return value === null || isValidFailureAlertPolicy(value)
}

/** Validate the complete bound spec before any control operation can write. */
export function isValidBoundCronSpec(value: unknown): value is BoundCronSpec {
  if (!isObject(value)) return false
  if (typeof value.externalRef !== 'string' || value.externalRef.trim() === '') return false
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') return false
  if (value.deliver !== 'telegram' || value.sessionMode !== 'per_run') return false
  if (value.kind !== undefined || value.command !== undefined) return false
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false
  if (value.agentEnvironment !== undefined && !isCanonicalAgentEnvironmentMarker(value.agentEnvironment)) return false
  if (value.gate !== undefined && !isValidCommandGate(value.gate)) return false
  if (value.agentEnvironment !== undefined && value.gate !== undefined) return false
  if (value.failureAlert !== undefined && !isValidFailureAlertPolicy(value.failureAlert)) return false
  if (!isObject(value.schedule) || typeof value.schedule.kind !== 'string') return false
  if (value.schedule.kind === 'cron') {
    if (typeof value.schedule.expr !== 'string' || value.schedule.expr.trim() === '') return false
    try {
      parseCron(value.schedule.expr)
    } catch {
      return false
    }
    return true
  }
  if (value.schedule.kind === 'interval') {
    return typeof value.schedule.minutes === 'number'
      && Number.isSafeInteger(value.schedule.minutes)
      && value.schedule.minutes >= 1
  }
  if (value.schedule.kind === 'once') {
    return typeof value.schedule.runAt === 'string' && Number.isFinite(Date.parse(value.schedule.runAt))
  }
  return false
}

/** Validate an exact, bounded shell-free command binding before it can write. */
export function isValidBoundCronCommandSpec(value: unknown): value is BoundCronCommandSpec {
  if (!isObject(value)) return false
  if (typeof value.externalRef !== 'string' || value.externalRef.trim() === '') return false
  if (value.agentEnvironment !== undefined) return false
  if (value.deliver !== 'telegram' && value.deliver !== 'silent') return false
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false
  if (!isValidCommandPayload(value.command)) return false
  if (value.failureAlert !== undefined && !isValidFailureAlertPolicy(value.failureAlert)) return false
  if (value.failureAlert !== undefined && value.deliver !== 'telegram') return false
  if (!isObject(value.schedule) || typeof value.schedule.kind !== 'string') return false
  if (value.schedule.kind === 'cron') {
    if (typeof value.schedule.expr !== 'string' || value.schedule.expr.trim() === '') return false
    try { parseCron(value.schedule.expr) } catch { return false }
    return true
  }
  if (value.schedule.kind === 'interval') {
    return typeof value.schedule.minutes === 'number'
      && Number.isSafeInteger(value.schedule.minutes)
      && value.schedule.minutes >= 1
  }
  return value.schedule.kind === 'once'
    && typeof value.schedule.runAt === 'string'
    && Number.isFinite(Date.parse(value.schedule.runAt))
}

function errorResponse(
  errorCode: ControlErrorResponse['errorCode'],
  message: string,
  operation?: ControlRpcOperation,
): ControlErrorResponse {
  return {
    protocolVersion: 1,
    ok: false,
    ...(operation === undefined ? {} : { operation }),
    errorCode,
    message,
  }
}

function successResponse(operation: 'ensure-bound' | 'replace-bound' | 'delete-bound' | 'get-bound', snapshot: BoundCronSnapshot): ControlSuccessResponse {
  return { protocolVersion: 1, ok: true, operation, snapshot }
}

function commandSuccessResponse(
  operation: 'ensure-bound-command' | 'replace-bound-command' | 'get-bound-command',
  snapshot: BoundCronCommandSnapshot,
): ControlResponse {
  return { protocolVersion: 1, ok: true, operation, snapshot }
}

function failureAlertSuccessResponse(
  snapshot: BoundCronSnapshot | BoundCronCommandSnapshot,
): FailureAlertControlSuccessResponse {
  return { protocolVersion: 1, ok: true, operation: 'update-bound-failure-alert', snapshot }
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return left === right
}

function sameFailureAlert(
  left: FailureAlertPolicy | undefined,
  right: FailureAlertPolicy | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.after === right.after && left.cooldownMinutes === right.cooldownMinutes
}

function sameSpec(job: BoundCronJobView, spec: BoundCronSpec): boolean {
  return (
    job.externalRef === spec.externalRef
    && JSON.stringify(job.schedule) === JSON.stringify(spec.schedule)
    && job.prompt === spec.prompt
    && job.deliver === spec.deliver
    && sameOptionalString(job.cwd, spec.cwd)
    && job.sessionMode === spec.sessionMode
    && sameOptionalString(job.agentEnvironment, spec.agentEnvironment)
    && JSON.stringify(job.gate) === JSON.stringify(spec.gate)
    && sameFailureAlert(job.failureAlert, spec.failureAlert)
  )
}

function sameCommandSpec(job: BoundCronCommandJobView, spec: BoundCronCommandSpec): boolean {
  return job.externalRef === spec.externalRef
    && JSON.stringify(job.schedule) === JSON.stringify(spec.schedule)
    && JSON.stringify(job.command) === JSON.stringify(spec.command)
    && job.deliver === spec.deliver
    && sameFailureAlert(job.failureAlert, spec.failureAlert)
    && sameOptionalString(job.cwd, spec.cwd)
}

function asBoundJob(job: Job | undefined): BoundCronJobView | undefined {
  if (job === undefined || job.kind === 'command' || job.externalRef === undefined) return undefined
  if (job.deliver !== 'telegram' || job.sessionMode !== 'per_run') return undefined
  return {
    id: job.id,
    externalRef: job.externalRef,
    schedule: job.schedule,
    prompt: job.prompt,
    deliver: 'telegram',
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    sessionMode: 'per_run',
    ...(job.agentEnvironment === undefined ? {} : { agentEnvironment: job.agentEnvironment }),
    ...(job.gate === undefined ? {} : { gate: job.gate }),
    ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
    createdAt: job.createdAt,
  }
}

function asBoundCommandJob(job: Job | undefined): BoundCronCommandJobView | undefined {
  if (job === undefined || job.kind !== 'command' || job.externalRef === undefined) return undefined
  return {
    id: job.id,
    externalRef: job.externalRef,
    schedule: job.schedule,
    command: job.command,
    deliver: job.deliver,
    ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    createdAt: job.createdAt,
  }
}

function publicRunStatus(status: string): CronRunExecutionStatus {
  if (status === 'silent') return 'success'
  if (status === 'success' || status === 'error' || status === 'expired' || status === 'interrupted') return status
  return 'error'
}

function publicDeliveryState(record: RunFinishRecord): CronRunDeliveryState {
  if (record.deliveryState !== undefined) return record.deliveryState
  if (record.status === 'silent') return 'silent'
  if (record.status === 'expired') return 'not_requested'
  if (record.status === 'interrupted') return 'uncertain'
  if (record.deliveredAt !== undefined) return 'delivered'
  if (record.status === 'error') return 'not_requested'
  return 'silent'
}

function publicRun(record: RunFinishRecord): CronRunSnapshot {
  const outputPreview = typeof record.outputPreview === 'string'
    ? record.outputPreview.slice(0, SUMMARY_LIMIT)
    : undefined
  const runStatus = publicRunStatus(record.status)
  const deliveryState = publicDeliveryState(record)
  return {
    runId: record.runId,
    jobId: record.jobId,
    scheduledFor: record.scheduledFor,
    finishedAt: record.finishedAt,
    runStatus,
    ...(outputPreview === undefined ? {} : { summary: outputPreview }),
    ...(record.error === undefined ? {} : { error: record.error }),
    deliveryState,
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.deliveryError === undefined ? {} : { deliveryError: record.deliveryError }),
  }
}

function latestRunForJobs(runStore: RunStore, jobs: readonly Job[]): CronRunSnapshot | null {
  const jobIds = new Set(jobs.map(job => job.id))
  let latest: RunFinishRecord | undefined
  for (const record of runStore.readForJobs(jobIds)) {
    if (record.event !== 'finish') continue
    if (latest === undefined || record.finishedAt >= latest.finishedAt) latest = record
  }
  return latest === undefined ? null : publicRun(latest)
}

function normalizeCreateSpec(spec: BoundCronSpec): {
  readonly op: 'create'
  readonly id: string
  readonly externalRef: string
  readonly sessionMode: JobSessionMode
  readonly schedule: BoundCronSpec['schedule']
  readonly prompt: string
  readonly deliver: 'telegram'
  readonly cwd?: string
  readonly gate?: CommandGate
  readonly agentEnvironment?: AgentEnvironmentMarker
  readonly failureAlert?: FailureAlertPolicy
  readonly createdAt: string
} {
  const id = `cron-${randomUUID().slice(0, 8)}`
  return {
    op: 'create',
    id,
    externalRef: spec.externalRef,
    sessionMode: spec.sessionMode,
    schedule: spec.schedule,
    prompt: spec.prompt,
    deliver: 'telegram',
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.agentEnvironment === undefined ? {} : { agentEnvironment: spec.agentEnvironment }),
    ...(spec.gate === undefined ? {} : { gate: spec.gate }),
    ...(spec.failureAlert === undefined ? {} : { failureAlert: spec.failureAlert }),
    createdAt: new Date().toISOString(),
  }
}

function normalizeCreateCommandSpec(spec: BoundCronCommandSpec): {
  readonly op: 'create'
  readonly kind: 'command'
  readonly id: string
  readonly externalRef: string
  readonly schedule: BoundCronCommandSpec['schedule']
  readonly command: BoundCronCommandSpec['command']
  readonly deliver: BoundCronCommandSpec['deliver']
  readonly failureAlert?: FailureAlertPolicy
  readonly cwd?: string
  readonly createdAt: string
} {
  return {
    op: 'create',
    kind: 'command',
    id: `cron-${randomUUID().slice(0, 8)}`,
    externalRef: spec.externalRef,
    schedule: spec.schedule,
    command: spec.command,
    deliver: spec.deliver,
    ...(spec.failureAlert === undefined ? {} : { failureAlert: spec.failureAlert }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    createdAt: new Date().toISOString(),
  }
}

export function createControlService(config: ControlServiceConfig): DshCronControlClient {
  const jobs = new JobStore(config.storeDir)
  const runs = new RunStore(config.storeDir)

  function snapshot(externalRef: string): BoundCronSnapshot {
    const folded = jobs.fold()
    const activeRaw = folded.active.find(job => job.externalRef === externalRef)
    const activeJob = asBoundJob(activeRaw)
    const history = jobs.externalRefHistory(externalRef)
    return {
      externalRef,
      activeJob: activeJob ?? null,
      latestRun: latestRunForJobs(runs, history),
    }
  }

  function commandSnapshot(externalRef: string): BoundCronCommandSnapshot {
    const folded = jobs.fold()
    const activeRaw = folded.active.find(job => job.externalRef === externalRef)
    const activeJob = asBoundCommandJob(activeRaw)
    const history = jobs.externalRefHistory(externalRef).filter((job): job is CommandJob => job.kind === 'command')
    return {
      externalRef,
      activeJob: activeJob ?? null,
      latestRun: latestRunForJobs(runs, history),
    }
  }

  function activeRaw(externalRef: string): Job | undefined {
    return jobs.fold().active.find(job => job.externalRef === externalRef)
  }

  function activeRaws(externalRef: string): readonly Job[] {
    return jobs.fold().active.filter(job => job.externalRef === externalRef)
  }

  /**
   * Re-emit one complete active definition with only failureAlert changed.
   * Keeping the same id and createdAt makes the existing scheduler/run ledger
   * identity authoritative; append atomicity leaves the prior row authoritative
   * if the write cannot be committed.
   */
  function failureAlertUpdateEntry(
    job: Job,
    failureAlert: FailureAlertPolicy | null,
  ): Extract<JobLogEntry, { readonly op: 'create' }> {
    if (job.kind === 'command') {
      return {
        op: 'create',
        kind: 'command',
        id: job.id,
        ...(job.externalRef === undefined ? {} : { externalRef: job.externalRef }),
        schedule: job.schedule,
        command: job.command,
        deliver: job.deliver,
        ...(failureAlert === null ? {} : { failureAlert }),
        ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
        createdAt: job.createdAt,
      }
    }
    return {
      op: 'create',
      id: job.id,
      ...(job.externalRef === undefined ? {} : { externalRef: job.externalRef }),
      sessionMode: job.sessionMode,
      schedule: job.schedule,
      prompt: job.prompt,
      deliver: job.deliver,
      ...(job.agentEnvironment === undefined ? {} : { agentEnvironment: job.agentEnvironment }),
      ...(job.gate === undefined ? {} : { gate: job.gate }),
      ...(failureAlert === null ? {} : { failureAlert }),
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
      createdAt: job.createdAt,
    }
  }

  function appendCreate(spec: BoundCronSpec): BoundCronJobView {
    const entry = normalizeCreateSpec(spec)
    jobs.append(entry)
    return {
      id: entry.id,
      externalRef: entry.externalRef,
      schedule: entry.schedule,
      prompt: entry.prompt,
      deliver: 'telegram',
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      sessionMode: 'per_run',
      ...(entry.agentEnvironment === undefined ? {} : { agentEnvironment: entry.agentEnvironment }),
      ...(entry.gate === undefined ? {} : { gate: entry.gate }),
      ...(entry.failureAlert === undefined ? {} : { failureAlert: entry.failureAlert }),
      createdAt: entry.createdAt,
    }
  }

  function appendCreateCommand(spec: BoundCronCommandSpec): BoundCronCommandJobView {
    const entry = normalizeCreateCommandSpec(spec)
    jobs.append(entry)
    return {
      id: entry.id,
      externalRef: entry.externalRef,
      schedule: entry.schedule,
      command: entry.command,
      deliver: entry.deliver,
      ...(entry.failureAlert === undefined ? {} : { failureAlert: entry.failureAlert }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      createdAt: entry.createdAt,
    }
  }

  async function ensureBound(spec: BoundCronSpec): Promise<ControlResponse> {
    if (!isValidBoundCronSpec(spec)) return errorResponse('invalid_request', 'The bound cron spec is invalid.', 'ensure-bound')
    const raw = activeRaw(spec.externalRef)
    const current = asBoundJob(raw)
    if (raw !== undefined && current === undefined) {
      return errorResponse('binding_conflict', 'The externalRef is already bound to a command spec.', 'ensure-bound')
    }
    if (current !== undefined) {
      return sameSpec(current, spec)
        ? successResponse('ensure-bound', snapshot(spec.externalRef))
        : errorResponse('binding_conflict', 'The externalRef is already bound to a different spec.', 'ensure-bound')
    }
    appendCreate(spec)
    return successResponse('ensure-bound', snapshot(spec.externalRef))
  }

  async function replaceBound(spec: BoundCronSpec): Promise<ControlResponse> {
    if (!isValidBoundCronSpec(spec)) return errorResponse('invalid_request', 'The bound cron spec is invalid.', 'replace-bound')
    const current = activeRaw(spec.externalRef)
    if (current !== undefined) jobs.append({ op: 'delete', id: current.id, deletedAt: new Date().toISOString() })
    appendCreate(spec)
    return successResponse('replace-bound', snapshot(spec.externalRef))
  }

  async function deleteBound(externalRef: string): Promise<ControlResponse> {
    const current = activeRaw(externalRef)
    if (current !== undefined) jobs.append({ op: 'delete', id: current.id, deletedAt: new Date().toISOString() })
    return successResponse('delete-bound', snapshot(externalRef))
  }

  async function getBound(externalRef: string): Promise<ControlResponse> {
    return successResponse('get-bound', snapshot(externalRef))
  }

  async function ensureBoundCommand(spec: BoundCronCommandSpec): Promise<ControlResponse> {
    if (!isValidBoundCronCommandSpec(spec)) {
      return errorResponse('invalid_request', 'The bound command cron spec is invalid.', 'ensure-bound-command')
    }
    const raw = activeRaw(spec.externalRef)
    const current = asBoundCommandJob(raw)
    if (raw !== undefined && current === undefined) {
      return errorResponse('binding_conflict', 'The externalRef is already bound to an agent spec.', 'ensure-bound-command')
    }
    if (current !== undefined) {
      return sameCommandSpec(current, spec)
        ? commandSuccessResponse('ensure-bound-command', commandSnapshot(spec.externalRef))
        : errorResponse('binding_conflict', 'The externalRef is already bound to a different command spec.', 'ensure-bound-command')
    }
    appendCreateCommand(spec)
    return commandSuccessResponse('ensure-bound-command', commandSnapshot(spec.externalRef))
  }

  async function replaceBoundCommand(spec: BoundCronCommandSpec): Promise<ControlResponse> {
    if (!isValidBoundCronCommandSpec(spec)) {
      return errorResponse('invalid_request', 'The bound command cron spec is invalid.', 'replace-bound-command')
    }
    const current = activeRaw(spec.externalRef)
    if (current !== undefined) jobs.append({ op: 'delete', id: current.id, deletedAt: new Date().toISOString() })
    appendCreateCommand(spec)
    return commandSuccessResponse('replace-bound-command', commandSnapshot(spec.externalRef))
  }

  async function getBoundCommand(externalRef: string): Promise<ControlResponse> {
    return commandSuccessResponse('get-bound-command', commandSnapshot(externalRef))
  }

  async function updateBoundFailureAlert(
    externalRef: string,
    failureAlert: FailureAlertPolicy | null,
  ): Promise<ControlResponse> {
    const operation = 'update-bound-failure-alert' as const
    if (typeof externalRef !== 'string' || externalRef.trim() === '' || !isValidFailureAlertPolicyUpdate(failureAlert)) {
      return errorResponse('invalid_request', 'The failure-alert update is invalid.', operation)
    }
    const matches = activeRaws(externalRef)
    if (matches.length !== 1) {
      return errorResponse(
        'binding_conflict',
        matches.length === 0
          ? 'The externalRef has no active binding.'
          : 'The externalRef is bound to more than one active job.',
        operation,
      )
    }
    const current = matches[0]!
    if (failureAlert !== null && current.deliver !== 'telegram') {
      return errorResponse('invalid_request', 'Failure alerts require Telegram delivery.', operation)
    }
    const requested = failureAlert === null ? undefined : failureAlert
    const currentSnapshot = current.kind === 'command' ? commandSnapshot(externalRef) : snapshot(externalRef)
    if (sameFailureAlert(current.failureAlert, requested)) return failureAlertSuccessResponse(currentSnapshot)
    try {
      jobs.append(failureAlertUpdateEntry(current, failureAlert))
    } catch {
      return errorResponse(
        'persistence_uncertain',
        'The failure-alert update was not committed; the prior definition remains authoritative.',
        operation,
      )
    }
    return failureAlertSuccessResponse(current.kind === 'command' ? commandSnapshot(externalRef) : snapshot(externalRef))
  }

  async function readiness(): Promise<{ readonly protocolVersion: 1; readonly writer: 'manager'; readonly ready: true }> {
    return { protocolVersion: 1, writer: 'manager', ready: true }
  }

  return {
    ensureBound,
    replaceBound,
    deleteBound,
    getBound,
    ensureBoundCommand,
    replaceBoundCommand,
    getBoundCommand,
    updateBoundFailureAlert,
    readiness,
  }
}

/**
 * Create the offline maintenance port used by a staged deployment. This is
 * intentionally synchronous and process-local: callers must arrange the
 * writer stop/backup gates themselves, while this port provides the final
 * same-id CAS and atomic append boundary.
 */
export function createMaintenanceControl(config: MaintenanceControlConfig): DshCronMaintenanceControl {
  const jobs = new JobStore(config.storeDir)
  const runs = new RunLedger(config.storeDir)

  function inspectAgentBindingById(jobId: string): AgentBindingInspection | null {
    if (typeof jobId !== 'string' || jobId.trim() === '') return null
    const active = jobs.fold().active.find(job => job.id === jobId)
    if (active === undefined || active.kind === 'command') return null
    return {
      jobId: active.id,
      kind: 'agent',
      immutableSha256: agentImmutableSha256(active),
      binding: agentBinding(active),
    }
  }

  function transitionAgentBindingById(
    request: TransitionAgentBindingRequest,
  ): TransitionAgentBindingResult {
    if (!isObject(request)
      || typeof request.jobId !== 'string'
      || request.jobId.trim() === ''
      || typeof request.expectedImmutableSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.expectedImmutableSha256)
      || !validBinding(request.expectedBinding)
      || !validBinding(request.desiredBinding)) {
      return maintenanceError('invalid_request', 'The Agent binding transition request is invalid.')
    }

    const active = jobs.fold().active.find(job => job.id === request.jobId)
    if (active === undefined) return maintenanceError('job_not_found', `Active job ${request.jobId} was not found.`)
    if (active.kind === 'command') return maintenanceError('wrong_kind', `Job ${request.jobId} is not an Agent job.`)

    const currentFingerprint = agentImmutableSha256(active)
    if (currentFingerprint !== request.expectedImmutableSha256) {
      return maintenanceError('immutable_mismatch', 'The immutable Agent fingerprint no longer matches.')
    }

    const currentBinding = agentBinding(active)
    if (!sameBinding(currentBinding, request.expectedBinding)) {
      return maintenanceError('binding_mismatch', 'The expected Agent binding no longer matches.')
    }

    // A provider marker and a command gate are mutually exclusive. The
    // persisted immutable definition may already contain a gate, so check the
    // desired binding before even looking for externalRef collisions.
    if (request.desiredBinding.agentEnvironment !== undefined && active.gate !== undefined) {
      return maintenanceError('marker_gate_conflict', 'An Agent environment marker cannot be combined with a command gate.')
    }
    if (active.gate !== undefined && request.desiredBinding.sessionMode !== 'per_run') {
      return maintenanceError('marker_gate_conflict', 'A command gate requires per_run session mode.')
    }
    if (request.desiredBinding.agentEnvironment !== undefined && request.desiredBinding.sessionMode !== 'per_run') {
      return maintenanceError('marker_gate_conflict', 'An Agent environment marker requires per_run session mode.')
    }

    const desiredExternalRef = request.desiredBinding.externalRef
    if (desiredExternalRef !== undefined) {
      const collision = jobs.fold().active.some(job => job.id !== active.id && job.externalRef === desiredExternalRef)
      if (collision) return maintenanceError('external_ref_conflict', `External reference ${desiredExternalRef} is already active on another job.`)
    }

    if (sameBinding(currentBinding, request.desiredBinding)) {
      return {
        ok: true,
        jobId: active.id,
        kind: 'agent',
        immutableSha256: currentFingerprint,
        binding: currentBinding,
        changed: false,
      }
    }

    const entry: Extract<JobLogEntry, { readonly op: 'create' }> = {
      op: 'create',
      id: active.id,
      schedule: active.schedule,
      prompt: active.prompt,
      deliver: active.deliver,
      ...(desiredExternalRef === undefined ? {} : { externalRef: desiredExternalRef }),
      sessionMode: request.desiredBinding.sessionMode,
      ...(request.desiredBinding.agentEnvironment === undefined ? {} : { agentEnvironment: request.desiredBinding.agentEnvironment }),
      ...(active.gate === undefined ? {} : { gate: active.gate }),
      ...(active.failureAlert === undefined ? {} : { failureAlert: active.failureAlert }),
      ...(active.cwd === undefined ? {} : { cwd: active.cwd }),
      createdAt: active.createdAt,
    }

    try {
      // JobStore delegates to JsonlStore's write-temp+rename operation. If it
      // throws, the old row remains authoritative and no success is exposed.
      jobs.append(entry)
    } catch {
      return maintenanceError(
        'persistence_uncertain',
        'The Agent binding update was not committed; the prior row remains authoritative.',
      )
    }

    const folded = jobs.fold()
    const post = folded.active.find(job => job.id === active.id)
    if (post === undefined || post.kind === 'command') {
      return maintenanceError('verification_failed', 'The appended Agent row did not refold as the same active Agent job.')
    }
    const postBinding = agentBinding(post)
    const postFingerprint = agentImmutableSha256(post)
    const postCollision = post.externalRef !== undefined
      && folded.active.some(job => job.id !== post.id && job.externalRef === post.externalRef)
    if (postFingerprint !== request.expectedImmutableSha256
      || !sameBinding(postBinding, request.desiredBinding)
      || postCollision) {
      return maintenanceError(
        postCollision ? 'external_ref_conflict' : 'verification_failed',
        postCollision
          ? 'Another active job claimed the desired external reference during the transition.'
          : 'The appended Agent row failed the post-write CAS verification.',
      )
    }
    return {
      ok: true,
      jobId: post.id,
      kind: 'agent',
      immutableSha256: postFingerprint,
      binding: postBinding,
      changed: true,
    }
  }

  function reanchorCronSchedules(
    request: ReanchorCronSchedulesRequest,
  ): ReanchorCronSchedulesResult {
    if (!isObject(request)
      || request.migrationVersion !== 1
      || typeof request.migrationId !== 'string'
      || !/^[a-z0-9][a-z0-9:._-]{2,127}$/u.test(request.migrationId)
      || request.fromTimeZone !== 'Etc/UTC'
      || request.toTimeZone !== 'Asia/Shanghai'
      || !isCanonicalIso(request.cutoverAt)
      || !isCanonicalIso(request.reanchoredAt)) {
      return maintenanceError('invalid_request', 'The schedule reanchor request is invalid.')
    }
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== request.toTimeZone) {
      return maintenanceError(
        'timezone_mismatch',
        `Schedule reanchor requires runtime timezone ${request.toTimeZone}.`,
      )
    }

    const foldedJobs = jobs.fold()
    if ((foldedJobs.invalid?.length ?? 0) > 0) {
      return maintenanceError('invalid_job_log', 'The active job log contains invalid create rows.')
    }
    const cronJobs = foldedJobs.active
      .filter(job => job.schedule.kind === 'cron')
      .sort((left, right) => left.id.localeCompare(right.id))
    if (cronJobs.length === 0) {
      return maintenanceError('invalid_request', 'Schedule reanchor requires at least one active cron job.')
    }
    const input = {
      migrationVersion: request.migrationVersion,
      migrationId: request.migrationId,
      fromTimeZone: request.fromTimeZone,
      toTimeZone: request.toTimeZone,
      cutoverAt: request.cutoverAt,
      reanchoredAt: request.reanchoredAt,
      jobs: cronJobs.map(job => ({ jobId: job.id, expr: job.schedule.kind === 'cron' ? job.schedule.expr : '' })),
    }
    const inputSha256 = canonicalSha256(input)
    const expected = cronJobs.map((job): RunScheduleReanchorRecord => {
      if (job.schedule.kind !== 'cron') throw new Error('unreachable non-cron schedule')
      return {
        schemaVersion: 2,
        event: 'schedule-reanchor',
        migrationVersion: 1,
        jobId: job.id,
        migrationId: request.migrationId,
        fromTimeZone: request.fromTimeZone,
        toTimeZone: request.toTimeZone,
        cutoverAt: request.cutoverAt,
        reanchoredAt: request.reanchoredAt,
        inputSha256,
        scheduleSha256: canonicalSha256({ jobId: job.id, schedule: job.schedule }),
        nextRunAt: new Date(nextRunAfter(job.schedule, Date.parse(request.cutoverAt))).toISOString(),
      }
    })

    let existing: readonly RunScheduleReanchorRecord[]
    try {
      existing = runs.inspectScheduleReanchorMigration(request.migrationId)
    } catch {
      return maintenanceError('migration_conflict', 'The schedule reanchor ledger contains a malformed migration row.')
    }
    const expectedByJob = new Map(expected.map(record => [record.jobId, record]))
    for (const record of existing) {
      const wanted = expectedByJob.get(record.jobId)
      if (wanted === undefined || JSON.stringify(record) !== JSON.stringify(wanted)) {
        return maintenanceError('migration_conflict', 'The migration id is already bound to different input or output.')
      }
    }

    let appendedCount = 0
    const results: Array<{ jobId: string; scheduleSha256: string; nextRunAt: string; changed: boolean }> = []
    for (const record of expected) {
      try {
        const result = runs.scheduleReanchor(record)
        const changed = result === 'reanchored'
        if (changed) appendedCount += 1
        results.push({
          jobId: record.jobId,
          scheduleSha256: record.scheduleSha256,
          nextRunAt: record.nextRunAt,
          changed,
        })
      } catch {
        return maintenanceError(
          'persistence_uncertain',
          'The schedule reanchor did not finish; retry only the exact same migration request.',
        )
      }
    }

    let verified: readonly RunScheduleReanchorRecord[]
    try {
      verified = runs.inspectScheduleReanchorMigration(request.migrationId)
    } catch {
      return maintenanceError('verification_failed', 'The schedule reanchor ledger failed post-write validation.')
    }
    const verifiedJobs = new Set(verified.map(record => record.jobId))
    if (verified.some(record => record.inputSha256 !== inputSha256)
      || expected.some(record => !verifiedJobs.has(record.jobId))) {
      return maintenanceError('verification_failed', 'The schedule reanchor ledger is incomplete or inconsistent.')
    }
    return {
      ok: true,
      changed: appendedCount > 0,
      migrationVersion: 1,
      migrationId: request.migrationId,
      inputSha256,
      cronJobCount: expected.length,
      appendedCount,
      jobs: results,
    }
  }

  function inspectScheduleReanchorMigration(
    request: InspectScheduleReanchorMigrationRequest,
  ): InspectScheduleReanchorMigrationResult {
    const requestKeys = [
      'cronJobCount',
      'cutoverAt',
      'fromTimeZone',
      'inputSha256',
      'jobs',
      'migrationId',
      'migrationVersion',
      'reanchoredAt',
      'toTimeZone',
    ]
    if (!isObject(request)
      || Object.keys(request).sort().join('\0') !== requestKeys.sort().join('\0')
      || request.migrationVersion !== 1
      || typeof request.migrationId !== 'string'
      || !/^[a-z0-9][a-z0-9:._-]{2,127}$/u.test(request.migrationId)
      || request.fromTimeZone !== 'Etc/UTC'
      || request.toTimeZone !== 'Asia/Shanghai'
      || !isCanonicalIso(request.cutoverAt)
      || !isCanonicalIso(request.reanchoredAt)
      || typeof request.inputSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(request.inputSha256)
      || !Number.isSafeInteger(request.cronJobCount)
      || request.cronJobCount < 1
      || !Array.isArray(request.jobs)
      || request.jobs.length !== request.cronJobCount) {
      return maintenanceError('invalid_request', 'The schedule reanchor inspection evidence is invalid.')
    }

    const jobKeys = ['jobId', 'nextRunAt', 'scheduleSha256']
    const jobIds = new Set<string>()
    for (const job of request.jobs) {
      if (!isObject(job)
        || Object.keys(job).sort().join('\0') !== jobKeys.join('\0')
        || typeof job.jobId !== 'string'
        || job.jobId.trim() === ''
        || jobIds.has(job.jobId)
        || typeof job.scheduleSha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(job.scheduleSha256)
        || !isCanonicalIso(job.nextRunAt)) {
        return maintenanceError('invalid_request', 'The schedule reanchor inspection job evidence is invalid.')
      }
      jobIds.add(job.jobId)
    }

    let records: readonly RunScheduleReanchorRecord[]
    try {
      records = runs.inspectScheduleReanchorMigration(request.migrationId)
    } catch {
      return maintenanceError('migration_conflict', 'The schedule reanchor ledger contains malformed evidence.')
    }
    if (records.length === 0) {
      return maintenanceError('migration_not_found', 'The accepted schedule reanchor migration is absent from the ledger.')
    }
    if (records.length !== request.cronJobCount) {
      return maintenanceError('migration_conflict', 'The schedule reanchor ledger row set differs from the accepted evidence.')
    }

    const expected = new Map<string, RunScheduleReanchorRecord>()
    for (const job of request.jobs) {
      expected.set(job.jobId, {
        schemaVersion: 2,
        event: 'schedule-reanchor',
        migrationVersion: request.migrationVersion,
        jobId: job.jobId,
        migrationId: request.migrationId,
        fromTimeZone: request.fromTimeZone,
        toTimeZone: request.toTimeZone,
        cutoverAt: request.cutoverAt,
        reanchoredAt: request.reanchoredAt,
        inputSha256: request.inputSha256,
        scheduleSha256: job.scheduleSha256,
        nextRunAt: job.nextRunAt,
      })
    }
    const seen = new Set<string>()
    for (const record of records) {
      const accepted = expected.get(record.jobId)
      if (accepted === undefined
        || seen.has(record.jobId)
        || JSON.stringify(record) !== JSON.stringify(accepted)) {
        return maintenanceError('migration_conflict', 'The schedule reanchor ledger differs from the accepted evidence.')
      }
      seen.add(record.jobId)
    }
    if (seen.size !== expected.size) {
      return maintenanceError('migration_conflict', 'The schedule reanchor ledger is missing accepted job evidence.')
    }

    return {
      ok: true,
      migrationVersion: request.migrationVersion,
      migrationId: request.migrationId,
      fromTimeZone: request.fromTimeZone,
      toTimeZone: request.toTimeZone,
      cutoverAt: request.cutoverAt,
      reanchoredAt: request.reanchoredAt,
      inputSha256: request.inputSha256,
      cronJobCount: request.cronJobCount,
      jobs: [...request.jobs]
        .map(job => ({ ...job }))
        .sort((left, right) => left.jobId.localeCompare(right.jobId)),
      ledgerRecordCount: records.length,
    }
  }

  return {
    inspectAgentBindingById,
    transitionAgentBindingById,
    reanchorCronSchedules,
    inspectScheduleReanchorMigration,
  }
}

/** Keep a named type available to callers that need to classify local errors. */
export type ControlServiceClientError = DshCronControlClientError
