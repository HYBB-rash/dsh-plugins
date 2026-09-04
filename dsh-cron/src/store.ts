/**
 * Durable JSONL stores for dsh-cron.
 *
 * `jobs.jsonl` is append-only (create/delete tombstones), folded on read;
 * `runs.jsonl` is append-only audit history. All writes are atomic:
 * write-to-tmp + rename (same convention as the telegram offset store).
 * @module @deepseek-ai/dsh-cron
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isValidPreparedDeliveryObject, isValidPreparedObjectId } from './types.ts'
import type {
  CommandGate,
  CommandPayload,
  FailureAlertPolicy,
  FoldedJobs,
  InvalidJobLogEntry,
  Job,
  JobLogEntry,
  RunClaimRecord,
  RunDeliveryAttemptClaimRecord,
  RunDeliveryReceiptRecord,
  RunEnvironmentSettleRecord,
  RunEnvironmentPrefinishSettleRecord,
  RunPreparedDeliveryRecord,
  RunScheduleReanchorRecord,
  RunFailureAlertClaimRecord,
  RunFinishRecord,
  RunHistoryRecord,
  RunTrigger,
} from './types.ts'
import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_FAILURE_ALERT_AFTER,
  MAX_FAILURE_ALERT_COOLDOWN_MINUTES,
  isCanonicalAgentEnvironmentMarker,
} from './types.ts'

/** Parse one strict JSON line; invalid lines are treated as a corrupt log. */
function parseLine<T>(line: string): T {
  return JSON.parse(line) as T
}

type CreateJobEntry = Extract<JobLogEntry, { readonly op: 'create' }>

type ParsedCreateJob =
  | { readonly entry: CreateJobEntry }
  | { readonly invalid: Omit<InvalidJobLogEntry, 'line'> }

function isCommandPayload(value: unknown): value is CommandPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const command = value as Record<string, unknown>
  return Array.isArray(command.argv)
    && command.argv.length > 0
    && command.argv.every(arg => typeof arg === 'string' && arg.length > 0)
    && typeof command.timeoutSeconds === 'number'
    && Number.isSafeInteger(command.timeoutSeconds)
    && command.timeoutSeconds >= 1
    && command.timeoutSeconds <= MAX_COMMAND_TIMEOUT_SECONDS
    && typeof command.outputMaxBytes === 'number'
    && Number.isSafeInteger(command.outputMaxBytes)
    && command.outputMaxBytes >= 1
    && command.outputMaxBytes <= MAX_COMMAND_OUTPUT_BYTES
}

function isCommandGate(value: unknown): value is CommandGate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const gate = value as Record<string, unknown>
  return gate.kind === 'nonempty_stdout' && isCommandPayload(gate.command)
}

function isFailureAlertPolicy(value: unknown): value is FailureAlertPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  return typeof policy.after === 'number'
    && Number.isSafeInteger(policy.after)
    && policy.after >= 1
    && policy.after <= MAX_FAILURE_ALERT_AFTER
    && typeof policy.cooldownMinutes === 'number'
    && Number.isSafeInteger(policy.cooldownMinutes)
    && policy.cooldownMinutes >= 1
    && policy.cooldownMinutes <= MAX_FAILURE_ALERT_COOLDOWN_MINUTES
}

function invalidCreate(
  code: InvalidJobLogEntry['code'],
  message: string,
  id?: string,
): ParsedCreateJob {
  return {
    invalid: {
      ...(id === undefined ? {} : { id }),
      code,
      message,
    },
  }
}

/** Validate one raw create row, including legacy defaults and marker rules. */
function parseCreateJobWithFailure(raw: string): ParsedCreateJob | undefined {
  const line = raw.trim()
  if (line === '') return undefined
  let value: unknown
  try {
    value = parseLine<unknown>(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.op !== 'create') return undefined

  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id : undefined
  if (id === undefined) return invalidCreate('invalid_create', 'create row requires a non-empty id.')
  if (typeof record.schedule !== 'object' || record.schedule === null || Array.isArray(record.schedule)) {
    return invalidCreate('invalid_create', 'create row requires a schedule object.', id)
  }
  if (record.deliver !== 'telegram' && record.deliver !== 'silent') {
    return invalidCreate('invalid_create', 'create row has an invalid delivery channel.', id)
  }
  if (record.externalRef !== undefined && typeof record.externalRef !== 'string') {
    return invalidCreate('invalid_create', 'create row externalRef must be a string.', id)
  }
  if (record.failureAlert !== undefined && !isFailureAlertPolicy(record.failureAlert)) {
    return invalidCreate('invalid_create', 'create row failureAlert is invalid.', id)
  }
  if (record.failureAlert !== undefined && record.deliver !== 'telegram') {
    return invalidCreate('invalid_create', 'failureAlert requires Telegram delivery.', id)
  }

  if (record.kind === 'command') {
    if (record.agentEnvironment !== undefined) {
      return invalidCreate(
        'agent_environment_not_allowed_on_command',
        'agentEnvironment is only valid on Agent jobs.',
        id,
      )
    }
    if (!isCommandPayload(record.command)) {
      return invalidCreate('invalid_create', 'command job requires a bounded command payload.', id)
    }
    if (record.sessionMode !== undefined || record.gate !== undefined) {
      return invalidCreate('invalid_create', 'command jobs cannot carry Agent session or gate fields.', id)
    }
    return { entry: record as unknown as Extract<CreateJobEntry, { readonly kind: 'command' }> }
  }

  if (record.kind !== undefined) return invalidCreate('invalid_create', 'create row has an invalid job kind.', id)
  if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
    return invalidCreate('invalid_create', 'Agent job requires a non-empty prompt.', id)
  }
  if (record.sessionMode !== undefined && record.sessionMode !== 'persistent' && record.sessionMode !== 'per_run') {
    return invalidCreate('invalid_create', 'Agent job sessionMode is invalid.', id)
  }
  if (record.gate !== undefined && !isCommandGate(record.gate)) {
    return invalidCreate('invalid_create', 'Agent job gate is invalid.', id)
  }
  if (record.gate !== undefined && record.sessionMode !== 'per_run') {
    return invalidCreate('invalid_create', 'Agent command gates require an explicit per_run session.', id)
  }
  if (record.agentEnvironment !== undefined) {
    if (!isCanonicalAgentEnvironmentMarker(record.agentEnvironment)) {
      return invalidCreate(
        'invalid_agent_environment_marker',
        'agentEnvironment must be an exact canonical marker without surrounding whitespace.',
        id,
      )
    }
    if (record.sessionMode !== 'per_run') {
      return invalidCreate(
        'agent_environment_requires_per_run',
        'agentEnvironment requires an explicit per_run session.',
        id,
      )
    }
    if (record.gate !== undefined) {
      return invalidCreate(
        'agent_environment_forbids_gate',
        'agentEnvironment cannot be combined with a command gate.',
        id,
      )
    }
  }
  return { entry: record as unknown as Extract<CreateJobEntry, { readonly kind?: undefined }> }
}

/** Validate one raw create row, ignoring structured invalid-row evidence. */
function parseCreateJob(raw: string): CreateJobEntry | undefined {
  const parsed = parseCreateJobWithFailure(raw)
  return parsed !== undefined && 'entry' in parsed ? parsed.entry : undefined
}

/** Materialize a job view without dropping optional identity fields. */
function materializeJob(entry: CreateJobEntry): Job {
  if (entry.kind === 'command') {
    return {
      kind: 'command',
      id: entry.id,
      ...(entry.externalRef === undefined ? {} : { externalRef: entry.externalRef }),
      schedule: entry.schedule,
      command: entry.command,
      deliver: entry.deliver,
      ...(entry.failureAlert === undefined ? {} : { failureAlert: entry.failureAlert }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      createdAt: entry.createdAt,
    }
  }
  return {
    id: entry.id,
    ...(entry.externalRef === undefined ? {} : { externalRef: entry.externalRef }),
    schedule: entry.schedule,
    prompt: entry.prompt,
    deliver: entry.deliver,
    sessionMode: entry.sessionMode ?? 'persistent',
    ...(entry.agentEnvironment === undefined ? {} : { agentEnvironment: entry.agentEnvironment }),
    ...(entry.gate === undefined ? {} : { gate: entry.gate }),
    ...(entry.failureAlert === undefined ? {} : { failureAlert: entry.failureAlert }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    createdAt: entry.createdAt,
  }
}

/**
 * Fold the append-only job log into the current active set.
 * Invalid lines are skipped (tombstone can never be un-done by a corrupt
 * create, so skipping preserves the last-writer intent of surviving lines).
 */
export function foldJobLog(lines: readonly string[]): FoldedJobs {
  const active = new Map<string, CreateJobEntry>()
  const seenIds: string[] = []
  const invalid: InvalidJobLogEntry[] = []
  for (const [index, raw] of lines.entries()) {
    const parsedCreate = parseCreateJobWithFailure(raw)
    if (parsedCreate !== undefined && 'invalid' in parsedCreate) {
      invalid.push({ line: index + 1, ...parsedCreate.invalid })
      continue
    }
    const entry = parsedCreate?.entry
    if (entry !== undefined) {
      if (!seenIds.includes(entry.id)) seenIds.push(entry.id)
      active.set(entry.id, entry)
      continue
    }
    const line = raw.trim()
    if (line === '') continue
    let parsed: JobLogEntry
    try {
      parsed = parseLine<JobLogEntry>(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'string') continue
    if (parsed.op === 'delete') {
      if (!seenIds.includes(parsed.id)) seenIds.push(parsed.id)
      active.delete(parsed.id)
    }
  }
  return {
    active: [...active.values()].map(materializeJob),
    seenIds: seenIds,
    ...(invalid.length === 0 ? {} : { invalid }),
  }
}

/** One append-only JSONL store. */
export class JsonlStore {
  constructor(private readonly file: string) {}

  /** Ensure the parent directory exists. */
  ensureDir(): void {
    mkdirSync(dirname(this.file), { recursive: true })
  }

  /** Read every raw line (absent file = empty). */
  readLines(): string[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf8').split('\n')
  }

  /** Stable identity for one immutable-by-rename file snapshot. */
  revision(): string {
    try {
      const stat = statSync(this.file, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw error
    }
  }

  /** Atomically append one record: tmp file + rename preserves all history. */
  append(record: unknown): void {
    this.ensureDir()
    const next = [...this.readLines(), JSON.stringify(record)]
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${next.filter(line => line.trim() !== '').join('\n')}\n`, 'utf8')
    renameSync(tmp, this.file)
  }
}

/** Append-only jobs store (manager writes, scheduler reads). */
export class JobStore {
  private readonly store: JsonlStore

  constructor(storeDir: string) {
    this.store = new JsonlStore(join(storeDir, 'jobs.jsonl'))
  }

  /** Append one job log entry atomically. */
  append(entry: JobLogEntry): void {
    this.store.append(entry)
  }

  /** Fold the current active job set. */
  fold(): FoldedJobs {
    return foldJobLog(this.store.readLines())
  }

  /**
   * Return every historical job row for one external binding, including rows
   * whose ids were later tombstoned. This projection reads jobs.jsonl only;
   * run history belongs to RunStore.
   */
  externalRefHistory(externalRef: string): readonly Job[] {
    const history: Job[] = []
    for (const raw of this.store.readLines()) {
      const entry = parseCreateJob(raw)
      if (entry !== undefined && entry.externalRef === externalRef) history.push(materializeJob(entry))
    }
    return history
  }
}

/** Append-only run history store (scheduler writes). */
export class RunStore {
  private readonly store: JsonlStore

  constructor(storeDir: string) {
    this.store = new JsonlStore(join(storeDir, 'runs.jsonl'))
  }

  /** Append one supported history event atomically. */
  appendEvent(record: RunHistoryRecord): void {
    this.store.append(record)
  }

  /** Read every supported history event (absent file = empty). */
  readAll(): RunHistoryRecord[] {
    const records: RunHistoryRecord[] = []
    for (const raw of this.store.readLines()) {
      const line = raw.trim()
      if (line === '') continue
      const parsed = parseRunLine(line)
      if (
        parsed.kind === 'claim'
        || parsed.kind === 'failure-alert-claim'
        || parsed.kind === 'finish'
        || parsed.kind === 'schedule-reanchor'
        || parsed.kind === 'environment-settle'
        || parsed.kind === 'prepared-delivery'
        || parsed.kind === 'delivery-attempt-claim'
        || parsed.kind === 'delivery-receipt'
        || parsed.kind === 'environment-prefinish-settle'
      ) records.push(parsed.record)
    }
    return records
  }

  /** Read history for a bounded set of jobs without changing the writer split. */
  readForJobs(jobIds: ReadonlySet<string> | readonly string[]): RunHistoryRecord[] {
    const wanted = jobIds instanceof Set ? jobIds : new Set(jobIds)
    return this.readAll().filter(record => wanted.has(record.jobId))
  }
}

/** Resolve the default store directory under DSH_HOME. */
export function defaultStoreDir(dshHome: string): string {
  return join(dshHome, 'storages', 'dsh-cron')
}

/**
 * One parsed V2 ledger event or an ignorable line (blank, corrupt,
 * unversioned, or unknown version). Parsing requires the discriminating
 * fields so a malformed event never counts as a valid record.
 */
export type ParsedRunLine =
  | { readonly kind: 'claim'; readonly record: RunClaimRecord }
  | { readonly kind: 'failure-alert-claim'; readonly record: RunFailureAlertClaimRecord }
  | { readonly kind: 'finish'; readonly record: RunFinishRecord }
  | { readonly kind: 'schedule-reanchor'; readonly record: RunScheduleReanchorRecord }
  | { readonly kind: 'environment-settle'; readonly record: RunEnvironmentSettleRecord }
  | { readonly kind: 'prepared-delivery'; readonly record: RunPreparedDeliveryRecord }
  | { readonly kind: 'delivery-attempt-claim'; readonly record: RunDeliveryAttemptClaimRecord }
  | { readonly kind: 'delivery-receipt'; readonly record: RunDeliveryReceiptRecord }
  | { readonly kind: 'environment-prefinish-settle'; readonly record: RunEnvironmentPrefinishSettleRecord }
  | { readonly kind: 'skip'; readonly value?: unknown }

/** V2 finish statuses that are valid ledger events. */
const VALID_FINISH_STATUSES = new Set(['success', 'error', 'silent', 'expired', 'interrupted'])
const VALID_RUN_TRIGGERS = new Set<RunTrigger>(['scheduled', 'manual'])

/** Whether a value is a non-empty string that Date can parse. */
function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

/** Whether a value is a non-empty string (whitespace-only counts as empty). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isValidRunTrigger(value: unknown): value is RunTrigger {
  return value === undefined || (typeof value === 'string' && VALID_RUN_TRIGGERS.has(value as RunTrigger))
}

function isManualRun(record: RunClaimRecord | RunFinishRecord): boolean {
  return record.trigger === 'manual'
}

/** Parse one raw runs.jsonl line. */
export function parseRunLine(raw: string): ParsedRunLine {
  const line = raw.trim()
  if (line === '') return { kind: 'skip' }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'skip' }
  }
  if (typeof value !== 'object' || value === null) return { kind: 'skip', value }
  const record = value as Record<string, unknown>
  if (typeof record.jobId !== 'string') return { kind: 'skip', value }
  if (record.schemaVersion === 2) {
      // Strict V2 validation: an event with a bad status, an unparsable
      // required time, an invalid optional nextRunAt, or an empty identifier
      // is skipped as a whole — it must never enter the fold as a real event.
      if (
        record.event === 'claim'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isNonEmptyString(record.sessionId)
        && isValidTime(record.scheduledFor)
        && isValidTime(record.claimedAt)
        && isValidRunTrigger(record.trigger)
        && ((record.agentEnvironment === undefined) === (record.deliveryLifecycle === undefined))
        && (record.agentEnvironment === undefined || isNonEmptyString(record.agentEnvironment))
        && (record.deliveryLifecycle === undefined || record.deliveryLifecycle === 'prepared')
        && (record.trigger !== 'manual' || record.nextRunAt === undefined)
        && (record.nextRunAt === undefined || isValidTime(record.nextRunAt))
      ) {
        return { kind: 'claim', record: record as unknown as RunClaimRecord }
      }
      if (
        record.event === 'finish'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isNonEmptyString(record.sessionId)
        && isValidTime(record.scheduledFor)
        && isValidTime(record.startedAt)
        && isValidTime(record.finishedAt)
        && typeof record.status === 'string'
        && VALID_FINISH_STATUSES.has(record.status)
        && isValidRunTrigger(record.trigger)
        && (record.trigger !== 'manual' || record.nextRunAt === undefined)
        && (record.nextRunAt === undefined || isValidTime(record.nextRunAt))
      ) {
        return { kind: 'finish', record: record as unknown as RunFinishRecord }
      }
      if (
        record.event === 'schedule-reanchor'
        && record.migrationVersion === 1
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.migrationId)
        && record.fromTimeZone === 'Etc/UTC'
        && record.toTimeZone === 'Asia/Shanghai'
        && isValidTime(record.cutoverAt)
        && isValidTime(record.reanchoredAt)
        && typeof record.inputSha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(record.inputSha256)
        && typeof record.scheduleSha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(record.scheduleSha256)
        && isValidTime(record.nextRunAt)
      ) {
        return { kind: 'schedule-reanchor', record: record as unknown as RunScheduleReanchorRecord }
      }
      if (
        record.event === 'failure-alert-claim'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isValidTime(record.claimedAt)
      ) {
        return {
          kind: 'failure-alert-claim',
          record: record as unknown as RunFailureAlertClaimRecord,
        }
      }
      if (
        record.event === 'environment-settle'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isValidTime(record.settledAt)
      ) {
        return {
          kind: 'environment-settle',
          record: record as unknown as RunEnvironmentSettleRecord,
        }
      }
      if (
        record.event === 'prepared-delivery'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isNonEmptyString(record.sessionId)
        && isValidPreparedDeliveryObject({ objectId: record.objectId, text: record.text })
        && isValidTime(record.scheduledFor)
        && isValidTime(record.preparedAt)
      ) return { kind: 'prepared-delivery', record: record as unknown as RunPreparedDeliveryRecord }
      if (
        record.event === 'delivery-attempt-claim'
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isNonEmptyString(record.sessionId)
        && isValidPreparedObjectId(record.objectId)
        && isValidTime(record.scheduledFor)
        && isValidTime(record.claimedAt)
      ) return { kind: 'delivery-attempt-claim', record: record as unknown as RunDeliveryAttemptClaimRecord }
      if (
        (record.event === 'delivery-receipt' || record.event === 'environment-prefinish-settle')
        && isNonEmptyString(record.jobId)
        && isNonEmptyString(record.runId)
        && isNonEmptyString(record.sessionId)
        && isValidPreparedObjectId(record.objectId)
        && isValidTime(record.scheduledFor)
        && (record.deliveryState === 'delivered' || record.deliveryState === 'failed' || record.deliveryState === 'uncertain')
        && (record.deliveredAt === undefined || isValidTime(record.deliveredAt))
        && (record.deliveryError === undefined || typeof record.deliveryError === 'string')
        && (record.event === 'delivery-receipt' ? isValidTime(record.receiptAt) : isValidTime(record.settledAt))
      ) {
        return record.event === 'delivery-receipt'
          ? { kind: 'delivery-receipt', record: record as unknown as RunDeliveryReceiptRecord }
          : { kind: 'environment-prefinish-settle', record: record as unknown as RunEnvironmentPrefinishSettleRecord }
      }
  }
  return { kind: 'skip', value }
}

/** One job's folded run projection (restart view of the ledger). */
export interface FoldedJobRuns {
  /** Every runId that is claimed or finished — never re-dispatch these. */
  readonly settledRunIds: ReadonlySet<string>
  /** Whether natural scheduled evidence consumed the job (once-settled check). */
  readonly anyRecord: boolean
  /** Recovery nextRunAt (ISO) from the latest V2 claim/finish, if any. */
  readonly nextRunAt?: string
  /** Claims without a finish — interrupted audit, never re-executed. */
  readonly interrupted: readonly RunClaimRecord[]
  /** Every parsed claim, retaining the first exact fact for conflict checks. */
  readonly claims: ReadonlyMap<string, RunClaimRecord>
  /** Durable finishes whose business environment has not acknowledged settlement. */
  readonly unsettledFinishes: readonly RunFinishRecord[]
  /** Consecutive business-execution errors; delivery failures are separate. */
  readonly consecutiveExecutionErrors: number
  /** Run ids whose failure-alert side effect was durably claimed. */
  readonly failureAlertRunIds: ReadonlySet<string>
  /** Latest durable alert claim, used as the restart-stable cooldown anchor. */
  readonly lastFailureAlertClaimedAt?: string
  readonly preparedDeliveries: ReadonlyMap<string, RunPreparedDeliveryRecord>
  readonly deliveryAttemptClaims: ReadonlyMap<string, RunDeliveryAttemptClaimRecord>
  readonly deliveryReceipts: ReadonlyMap<string, RunDeliveryReceiptRecord>
  readonly prefinishSettledDeliveries: ReadonlyMap<string, RunEnvironmentPrefinishSettleRecord>
  readonly lifecycleConflicts: ReadonlySet<string>
  /** Claim identity conflicts; these are never eligible for recovery. */
  readonly claimConflicts: ReadonlySet<string>
  /** Exact migration event retained per migration id for idempotent CAS. */
  readonly scheduleReanchors: ReadonlyMap<string, RunScheduleReanchorRecord>
  /** Migration ids whose durable rows disagree. */
  readonly scheduleReanchorConflicts: ReadonlySet<string>
  /** Recognizable but malformed reanchor rows; maintenance must stop. */
  readonly invalidScheduleReanchorMigrationIds: ReadonlySet<string>
  readonly invalidLifecycleRunIds: ReadonlySet<string>
}

/**
 * Fold one job's run ledger. The recovery nextRunAt is the value of the last
 * supported event that carries one (append order = event order).
 */
function foldParsedRunLines(lines: readonly ParsedRunLine[], jobId: string): FoldedJobRuns {
  const settled = new Set<string>()
  const claims = new Map<string, RunClaimRecord>()
  const finishes = new Set<string>()
  const finishRecords = new Map<string, RunFinishRecord>()
  const environmentSettled = new Set<string>()
  const failureAlertRunIds = new Set<string>()
  const preparedDeliveries = new Map<string, RunPreparedDeliveryRecord>()
  const deliveryAttemptClaims = new Map<string, RunDeliveryAttemptClaimRecord>()
  const deliveryReceipts = new Map<string, RunDeliveryReceiptRecord>()
  const prefinishSettledDeliveries = new Map<string, RunEnvironmentPrefinishSettleRecord>()
  const lifecycleConflicts = new Set<string>()
  const claimConflicts = new Set<string>()
  const scheduleReanchors = new Map<string, RunScheduleReanchorRecord>()
  const scheduleReanchorConflicts = new Set<string>()
  const invalidScheduleReanchorMigrationIds = new Set<string>()
  const invalidLifecycleRunIds = new Set<string>()
  const retainExact = <T extends { readonly runId: string }>(map: Map<string, T>, record: T, equivalent: (a: T, b: T) => boolean) => {
    const previous = map.get(record.runId)
    if (previous === undefined) map.set(record.runId, record)
    else if (!equivalent(previous, record)) lifecycleConflicts.add(record.runId)
  }
  let anyRecord = false
  let nextRunAt: string | undefined
  let consecutiveExecutionErrors = 0
  let lastFailureAlertClaimedAt: string | undefined
  const foldExecutionStatus = (status: string) => {
    if (status === 'error') consecutiveExecutionErrors += 1
    else if (status === 'success' || status === 'silent') consecutiveExecutionErrors = 0
  }
  for (const parsed of lines) {
    if (parsed.kind === 'skip') {
      const value = parsed.value
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (record.jobId === jobId
          && record.event === 'schedule-reanchor'
          && isNonEmptyString(record.migrationId)) {
          invalidScheduleReanchorMigrationIds.add(record.migrationId)
        }
        const lifecycleEvent = record.event === 'claim'
          || record.event === 'prepared-delivery'
          || record.event === 'delivery-attempt-claim'
          || record.event === 'delivery-receipt'
          || record.event === 'environment-prefinish-settle'
        if (record.jobId === jobId && lifecycleEvent && isNonEmptyString(record.runId)) invalidLifecycleRunIds.add(record.runId)
      }
      continue
    }
    if (parsed.record.jobId !== jobId) continue
    if (parsed.kind === 'failure-alert-claim') {
      failureAlertRunIds.add(parsed.record.runId)
      if (
        lastFailureAlertClaimedAt === undefined
        || Date.parse(parsed.record.claimedAt) > Date.parse(lastFailureAlertClaimedAt)
      ) lastFailureAlertClaimedAt = parsed.record.claimedAt
      continue
    }
    if (parsed.kind === 'environment-settle') {
      environmentSettled.add(parsed.record.runId)
      continue
    }
    if (parsed.kind === 'prepared-delivery') {
      retainExact(preparedDeliveries, parsed.record, (a, b) => a.objectId === b.objectId && a.text === b.text && a.sessionId === b.sessionId && a.scheduledFor === b.scheduledFor)
      continue
    }
    if (parsed.kind === 'delivery-attempt-claim') {
      retainExact(deliveryAttemptClaims, parsed.record, (a, b) => a.objectId === b.objectId && a.claimedAt === b.claimedAt && a.sessionId === b.sessionId && a.scheduledFor === b.scheduledFor)
      continue
    }
    if (parsed.kind === 'delivery-receipt') {
      retainExact(deliveryReceipts, parsed.record, (a, b) => a.objectId === b.objectId && a.deliveryState === b.deliveryState && a.receiptAt === b.receiptAt && a.sessionId === b.sessionId && a.scheduledFor === b.scheduledFor && a.deliveredAt === b.deliveredAt && a.deliveryError === b.deliveryError)
      continue
    }
    if (parsed.kind === 'environment-prefinish-settle') {
      retainExact(prefinishSettledDeliveries, parsed.record, (a, b) => a.objectId === b.objectId && a.deliveryState === b.deliveryState && a.settledAt === b.settledAt && a.sessionId === b.sessionId && a.scheduledFor === b.scheduledFor && a.deliveredAt === b.deliveredAt && a.deliveryError === b.deliveryError)
      continue
    }
    if (parsed.kind === 'schedule-reanchor') {
      const previous = scheduleReanchors.get(parsed.record.migrationId)
      if (previous === undefined) scheduleReanchors.set(parsed.record.migrationId, parsed.record)
      else if (JSON.stringify(previous) !== JSON.stringify(parsed.record)) {
        scheduleReanchorConflicts.add(parsed.record.migrationId)
      }
      nextRunAt = parsed.record.nextRunAt
      continue
    }
    if (parsed.kind === 'claim') {
      const previous = claims.get(parsed.record.runId)
      const firstClaim = previous === undefined
      if (firstClaim) claims.set(parsed.record.runId, parsed.record)
      else if (
        previous.jobId !== parsed.record.jobId
        || previous.sessionId !== parsed.record.sessionId
        || previous.scheduledFor !== parsed.record.scheduledFor
        || previous.claimedAt !== parsed.record.claimedAt
        || previous.trigger !== parsed.record.trigger
        || previous.agentEnvironment !== parsed.record.agentEnvironment
        || previous.deliveryLifecycle !== parsed.record.deliveryLifecycle
        || previous.nextRunAt !== parsed.record.nextRunAt
      ) claimConflicts.add(parsed.record.runId)
      settled.add(parsed.record.runId)
      if (firstClaim && !isManualRun(parsed.record)) {
        anyRecord = true
        if (parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
      }
      continue
    }
    if (!isManualRun(parsed.record)) anyRecord = true
    if (!finishes.has(parsed.record.runId)) foldExecutionStatus(parsed.record.status)
    finishes.add(parsed.record.runId)
    finishRecords.set(parsed.record.runId, parsed.record)
    settled.add(parsed.record.runId)
    if (!isManualRun(parsed.record) && parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
  }
  const interrupted: RunClaimRecord[] = []
  for (const [runId, claimRecord] of claims) {
    if (!finishes.has(runId)) interrupted.push(claimRecord)
  }
  const unsettledFinishes = [...finishRecords.entries()]
    .filter(([runId]) => !environmentSettled.has(runId))
    .map(([, record]) => record)
  return {
    settledRunIds: settled,
    anyRecord,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    interrupted,
    claims,
    unsettledFinishes,
    consecutiveExecutionErrors,
    failureAlertRunIds,
    ...(lastFailureAlertClaimedAt === undefined ? {} : { lastFailureAlertClaimedAt }),
    preparedDeliveries,
    deliveryAttemptClaims,
    deliveryReceipts,
    prefinishSettledDeliveries,
    lifecycleConflicts,
    claimConflicts,
    scheduleReanchors,
    scheduleReanchorConflicts,
    invalidScheduleReanchorMigrationIds,
    invalidLifecycleRunIds,
  }
}

export function foldRunLines(lines: readonly string[], jobId: string): FoldedJobRuns {
  return foldParsedRunLines(lines.map(parseRunLine), jobId)
}

/**
 * V2 run ledger: the scheduler's single-writer event book over runs.jsonl.
 * Claim-before-side-effect is enforced by the caller; this class only makes
 * claim idempotent (same runId cannot be claimed twice) and foldable.
 */
export class RunLedger {
  private readonly store: JsonlStore
  private cachedRevision: string | undefined
  private cachedLines: readonly ParsedRunLine[] = []
  private readonly cachedFolds = new Map<string, FoldedJobRuns>()

  constructor(storeDir: string) {
    this.store = new JsonlStore(join(storeDir, 'runs.jsonl'))
  }

  /** Fold one job's projection from the current file contents. */
  foldJob(jobId: string): FoldedJobRuns {
    const revision = this.store.revision()
    if (revision !== this.cachedRevision) {
      const rawLines = this.store.readLines()
      const stableRevision = this.store.revision()
      if (stableRevision !== revision) {
        throw new Error('run ledger changed while reading one snapshot')
      }
      this.cachedLines = rawLines.map(parseRunLine)
      this.cachedRevision = revision
      this.cachedFolds.clear()
    }
    const cached = this.cachedFolds.get(jobId)
    if (cached !== undefined) return cached
    const folded = foldParsedRunLines(this.cachedLines, jobId)
    this.cachedFolds.set(jobId, folded)
    return folded
  }

  /**
   * Inspect every durable row for one migration id, including jobs that are
   * no longer active.  A recognizable malformed row is a hard conflict;
   * callers must not silently treat it as absent.
   */
  inspectScheduleReanchorMigration(migrationId: string): readonly RunScheduleReanchorRecord[] {
    const records: RunScheduleReanchorRecord[] = []
    for (const raw of this.store.readLines()) {
      let value: unknown
      try { value = JSON.parse(raw) } catch { continue }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const candidate = value as Record<string, unknown>
      if (candidate.event !== 'schedule-reanchor' || candidate.migrationId !== migrationId) continue
      const parsed = parseRunLine(raw)
      if (parsed.kind !== 'schedule-reanchor') {
        throw new Error(`malformed schedule reanchor for migration ${migrationId}`)
      }
      records.push(parsed.record)
    }
    return records
  }

  /**
   * Append one exact schedule anchor, or return an idempotent no-op.  The
   * same migration id may never identify different input or output bytes.
   */
  scheduleReanchor(record: RunScheduleReanchorRecord): 'reanchored' | 'already_applied' {
    const parsed = parseRunLine(JSON.stringify(record))
    if (parsed.kind !== 'schedule-reanchor') throw new Error('invalid schedule reanchor record')
    const folded = this.foldJob(record.jobId)
    if (folded.invalidScheduleReanchorMigrationIds.has(record.migrationId)
      || folded.scheduleReanchorConflicts.has(record.migrationId)) {
      throw new Error(`conflicting schedule reanchor for migration ${record.migrationId}`)
    }
    const current = folded.scheduleReanchors.get(record.migrationId)
    if (current !== undefined) {
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        throw new Error(`schedule reanchor input or result changed for migration ${record.migrationId}`)
      }
      return 'already_applied'
    }
    this.store.append(record)
    const post = this.foldJob(record.jobId).scheduleReanchors.get(record.migrationId)
    if (post === undefined || JSON.stringify(post) !== JSON.stringify(record)) {
      throw new Error(`schedule reanchor verification failed for migration ${record.migrationId}`)
    }
    return 'reanchored'
  }

  private requirePreparedClaim(
    folded: FoldedJobRuns,
    record: { readonly jobId: string; readonly runId: string; readonly sessionId: string; readonly scheduledFor: string },
  ): void {
    const claim = folded.claims.get(record.runId)
    if (claim === undefined
      || claim.jobId !== record.jobId
      || claim.sessionId !== record.sessionId
      || claim.scheduledFor !== record.scheduledFor
      || claim.agentEnvironment === undefined
      || claim.deliveryLifecycle !== 'prepared') {
      throw new Error(`prepared delivery requires the exact prepared claim for ${record.runId}`)
    }
  }

  /**
   * Idempotently claim one run. Returns `claimed` only when the append
   * landed; `already_claimed` when the runId is settled (claim or finish).
   * I/O failures throw — the caller must not execute any side effect.
   */
  claim(record: RunClaimRecord): 'claimed' | 'already_claimed' {
    const folded = this.foldJob(record.jobId)
    if (folded.claimConflicts.has(record.runId)) throw new Error(`conflicting claim for ${record.runId}`)
    const current = folded.claims.get(record.runId)
    if (current !== undefined) {
      if (
        current.jobId === record.jobId
        && current.sessionId === record.sessionId
        && current.scheduledFor === record.scheduledFor
        && current.claimedAt === record.claimedAt
        && current.trigger === record.trigger
        && current.agentEnvironment === record.agentEnvironment
        && current.deliveryLifecycle === record.deliveryLifecycle
        && current.nextRunAt === record.nextRunAt
      ) return 'already_claimed'
      throw new Error(`conflicting claim for ${record.runId}`)
    }
    if (folded.settledRunIds.has(record.runId)) return 'already_claimed'
    this.store.append(record)
    return 'claimed'
  }

  /**
   * Claim one failure-alert side effect before Telegram is touched. The same
   * run id is idempotent, and a failed append throws so the caller fails
   * closed without sending.
   */
  claimFailureAlert(record: RunFailureAlertClaimRecord): 'claimed' | 'already_claimed' {
    if (this.foldJob(record.jobId).failureAlertRunIds.has(record.runId)) return 'already_claimed'
    this.store.append(record)
    return 'claimed'
  }

  /** Append one V2 finish event, after closing any declared prepared lifecycle. */
  finish(record: RunFinishRecord): void {
    const folded = this.foldJob(record.jobId)
    const claim = folded.claims.get(record.runId)
    const prepared = folded.preparedDeliveries.get(record.runId)
    const receipt = folded.deliveryReceipts.get(record.runId)
    const acknowledgement = folded.prefinishSettledDeliveries.get(record.runId)
    const hasPreparedLifecycle = claim?.deliveryLifecycle === 'prepared'
      || prepared !== undefined
      || folded.deliveryAttemptClaims.has(record.runId)
      || receipt !== undefined
      || acknowledgement !== undefined
    if (hasPreparedLifecycle && (
      folded.claimConflicts.has(record.runId)
      || folded.lifecycleConflicts.has(record.runId)
      || folded.invalidLifecycleRunIds.has(record.runId)
      || claim === undefined
      || claim.deliveryLifecycle !== 'prepared'
      || claim.agentEnvironment === undefined
      || prepared === undefined
      || receipt === undefined
      || acknowledgement === undefined
      || claim.sessionId !== record.sessionId
      || claim.scheduledFor !== record.scheduledFor
      || prepared.sessionId !== claim.sessionId
      || prepared.scheduledFor !== claim.scheduledFor
      || acknowledgement.objectId !== prepared.objectId
      || acknowledgement.objectId !== receipt.objectId
      || acknowledgement.sessionId !== claim.sessionId
      || acknowledgement.scheduledFor !== claim.scheduledFor
      || acknowledgement.deliveryState !== receipt.deliveryState
      || acknowledgement.deliveredAt !== receipt.deliveredAt
      || acknowledgement.deliveryError !== receipt.deliveryError
    )) {
      throw new Error(`prepared finish requires an exact prefinish acknowledgement for ${record.runId}`)
    }
    this.store.append(record)
  }

  /** Acknowledge one idempotent environment settlement after it succeeds. */
  environmentSettled(record: RunEnvironmentSettleRecord): void {
    this.store.append(record)
  }

  /** Persist the exact provider-owned object before transport is touched. */
  prepareDelivery(record: RunPreparedDeliveryRecord): void {
    if (!isValidPreparedDeliveryObject(record)) throw new Error('invalid prepared delivery')
    const folded = this.foldJob(record.jobId)
    if (folded.invalidLifecycleRunIds.has(record.runId)) throw new Error(`invalid delivery lifecycle evidence for ${record.runId}`)
    if (folded.claimConflicts.has(record.runId)) throw new Error(`conflicting claim for ${record.runId}`)
    this.requirePreparedClaim(folded, record)
    const current = folded.preparedDeliveries.get(record.runId)
    if (current !== undefined) {
      if (current.objectId === record.objectId && current.text === record.text && current.sessionId === record.sessionId && current.scheduledFor === record.scheduledFor) return
      throw new Error(`conflicting prepared delivery for ${record.runId}`)
    }
    this.store.append(record)
  }

  /** Claim exactly one transport side effect for the prepared object. */
  claimDeliveryAttempt(record: RunDeliveryAttemptClaimRecord): void {
    if (!isValidPreparedObjectId(record.objectId)) throw new Error(`invalid delivery object identity for ${record.runId}`)
    const folded = this.foldJob(record.jobId)
    if (folded.invalidLifecycleRunIds.has(record.runId)) throw new Error(`invalid delivery lifecycle evidence for ${record.runId}`)
    if (folded.claimConflicts.has(record.runId)) throw new Error(`conflicting claim for ${record.runId}`)
    this.requirePreparedClaim(folded, record)
    const current = folded.deliveryAttemptClaims.get(record.runId)
    if (current !== undefined) {
      if (current.objectId === record.objectId && current.claimedAt === record.claimedAt && current.sessionId === record.sessionId && current.scheduledFor === record.scheduledFor) return
      throw new Error(`conflicting delivery attempt claim for ${record.runId}`)
    }
    const prepared = folded.preparedDeliveries.get(record.runId)
    if (prepared === undefined || prepared.objectId !== record.objectId || folded.lifecycleConflicts.has(record.runId)) {
      throw new Error(`delivery attempt requires the durable prepared object for ${record.runId}`)
    }
    this.store.append(record)
  }

  /** Persist one trusted object-level transport receipt. */
  recordDeliveryReceipt(record: RunDeliveryReceiptRecord): void {
    if (!isValidPreparedObjectId(record.objectId)) throw new Error(`invalid delivery object identity for ${record.runId}`)
    const folded = this.foldJob(record.jobId)
    if (folded.invalidLifecycleRunIds.has(record.runId)) throw new Error(`invalid delivery lifecycle evidence for ${record.runId}`)
    if (folded.claimConflicts.has(record.runId)) throw new Error(`conflicting claim for ${record.runId}`)
    this.requirePreparedClaim(folded, record)
    const current = folded.deliveryReceipts.get(record.runId)
    if (current !== undefined) {
      if (current.objectId === record.objectId && current.deliveryState === record.deliveryState && current.receiptAt === record.receiptAt && current.sessionId === record.sessionId && current.scheduledFor === record.scheduledFor && current.deliveredAt === record.deliveredAt && current.deliveryError === record.deliveryError) return
      throw new Error(`conflicting delivery receipt for ${record.runId}`)
    }
    const prepared = folded.preparedDeliveries.get(record.runId)
    const attempt = folded.deliveryAttemptClaims.get(record.runId)
    if (prepared === undefined || attempt === undefined
      || prepared.objectId !== record.objectId || prepared.sessionId !== record.sessionId || prepared.scheduledFor !== record.scheduledFor
      || attempt.objectId !== record.objectId || attempt.sessionId !== record.sessionId || attempt.scheduledFor !== record.scheduledFor
      || folded.lifecycleConflicts.has(record.runId)) {
      throw new Error(`delivery receipt requires the exact prepared object and attempt for ${record.runId}`)
    }
    this.store.append(record)
  }

  /** Persist the technical pre-finish acknowledgement after the hook returns. */
  environmentPrefinishSettled(record: RunEnvironmentPrefinishSettleRecord): void {
    if (!isValidPreparedObjectId(record.objectId)) throw new Error(`invalid delivery object identity for ${record.runId}`)
    const folded = this.foldJob(record.jobId)
    if (folded.invalidLifecycleRunIds.has(record.runId)) throw new Error(`invalid delivery lifecycle evidence for ${record.runId}`)
    if (folded.claimConflicts.has(record.runId)) throw new Error(`conflicting claim for ${record.runId}`)
    this.requirePreparedClaim(folded, record)
    const current = folded.prefinishSettledDeliveries.get(record.runId)
    if (current !== undefined) {
      if (current.objectId === record.objectId && current.deliveryState === record.deliveryState && current.settledAt === record.settledAt && current.sessionId === record.sessionId && current.scheduledFor === record.scheduledFor && current.deliveredAt === record.deliveredAt && current.deliveryError === record.deliveryError) return
      throw new Error(`conflicting prefinish acknowledgement for ${record.runId}`)
    }
    const prepared = folded.preparedDeliveries.get(record.runId)
    const receipt = folded.deliveryReceipts.get(record.runId)
    if (prepared === undefined || receipt === undefined || prepared.objectId !== record.objectId || receipt.objectId !== record.objectId
      || receipt.deliveryState !== record.deliveryState || receipt.sessionId !== record.sessionId || receipt.scheduledFor !== record.scheduledFor
      || receipt.deliveredAt !== record.deliveredAt || receipt.deliveryError !== record.deliveryError || folded.lifecycleConflicts.has(record.runId)) {
      throw new Error(`prefinish acknowledgement requires the durable prepared object for ${record.runId}`)
    }
    this.store.append(record)
  }
}
