/**
 * Durable JSONL stores for dsh-cron.
 *
 * `jobs.jsonl` is append-only (create/delete tombstones), folded on read;
 * `runs.jsonl` is append-only audit history. All writes are atomic:
 * write-to-tmp + rename (same convention as the telegram offset store and
 * the plugin guardian audit log).
 * @module @deepseek-ai/dsh-cron
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CommandGate,
  CommandPayload,
  FailureAlertPolicy,
  FoldedJobs,
  InvalidJobLogEntry,
  Job,
  JobLogEntry,
  RunClaimRecord,
  RunFailureAlertClaimRecord,
  RunFinishRecord,
  RunHistoryRecord,
  RunRecord,
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

  /** Append one run record atomically. */
  append(record: RunRecord): void {
    this.store.append(record)
  }

  /** Append a V1 or V2 history line when the caller already has its shape. */
  appendEvent(record: RunHistoryRecord): void {
    this.store.append(record)
  }

  /** Read every recorded V1/V2 line (absent file = empty). */
  readAll(): RunHistoryRecord[] {
    const records: RunHistoryRecord[] = []
    for (const raw of this.store.readLines()) {
      const line = raw.trim()
      if (line === '') continue
      const parsed = parseRunLine(line)
      if (
        parsed.kind === 'v1'
        || parsed.kind === 'claim'
        || parsed.kind === 'failure-alert-claim'
        || parsed.kind === 'finish'
      ) records.push(parsed.record)
    }
    return records
  }

  /** Read history for a bounded set of jobs without changing the writer split. */
  readForJobs(jobIds: ReadonlySet<string> | readonly string[]): RunHistoryRecord[] {
    const wanted = jobIds instanceof Set ? jobIds : new Set(jobIds)
    return this.readAll().filter(record => wanted.has(record.jobId))
  }

  /** Return the latest terminal run for one job, including legacy V1 rows. */
  latestForJob(jobId: string): RunRecord | RunFinishRecord | undefined {
    let latest: RunRecord | RunFinishRecord | undefined
    for (const record of this.readAll()) {
      if (record.jobId !== jobId || !('finishedAt' in record) || typeof record.finishedAt !== 'string') continue
      if (latest === undefined || record.finishedAt >= latest.finishedAt) {
        latest = record as RunRecord | RunFinishRecord
      }
    }
    return latest
  }
}

/** Resolve the default store directory under DSH_HOME. */
export function defaultStoreDir(dshHome: string): string {
  return join(dshHome, 'storages', 'dsh-cron')
}

/**
 * One parsed ledger line: a V1 terminal record (no schemaVersion), a V2
 * claim/finish event, or an ignorable line (blank / corrupt / unknown
 * version). V2 parsing requires the discriminating fields so a malformed
 * event never counts as a valid record.
 */
export type ParsedRunLine =
  | { readonly kind: 'v1'; readonly record: RunRecord }
  | { readonly kind: 'claim'; readonly record: RunClaimRecord }
  | { readonly kind: 'failure-alert-claim'; readonly record: RunFailureAlertClaimRecord }
  | { readonly kind: 'finish'; readonly record: RunFinishRecord }
  | { readonly kind: 'skip' }

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
  if (typeof value !== 'object' || value === null) return { kind: 'skip' }
  const record = value as Record<string, unknown>
  if (typeof record.jobId !== 'string') return { kind: 'skip' }
  if (record.schemaVersion !== undefined) {
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
    }
    // An explicit but unknown/unsupported version must not fall back to V1.
    return { kind: 'skip' }
  }
  return { kind: 'v1', record: record as unknown as RunRecord }
}

/** One job's folded run projection (restart view of the ledger). */
export interface FoldedJobRuns {
  /** Every runId that is claimed or finished — never re-dispatch these. */
  readonly settledRunIds: ReadonlySet<string>
  /** Whether natural scheduled/legacy evidence consumed the job (once-settled check). */
  readonly anyRecord: boolean
  /** Recovery nextRunAt (ISO) from the latest V2 claim/finish, if any. */
  readonly nextRunAt?: string
  /** Claims without a finish — interrupted audit, never re-executed. */
  readonly interrupted: readonly RunClaimRecord[]
  /** Latest non-expired V1 terminal record's finishedAt (legacy anchor). */
  readonly legacyFinishedAt?: string
  /** Consecutive business-execution errors; delivery failures are separate. */
  readonly consecutiveExecutionErrors: number
  /** Run ids whose failure-alert side effect was durably claimed. */
  readonly failureAlertRunIds: ReadonlySet<string>
  /** Latest durable alert claim, used as the restart-stable cooldown anchor. */
  readonly lastFailureAlertClaimedAt?: string
}

/**
 * Fold one job's run ledger. V2 claims/finishes take precedence over the V1
 * legacy anchor; the recovery nextRunAt is the value of the last V2 line
 * that carries one (append order = event order).
 */
export function foldRunLines(lines: readonly string[], jobId: string): FoldedJobRuns {
  const settled = new Set<string>()
  const claims = new Map<string, RunClaimRecord>()
  const finishes = new Set<string>()
  const failureAlertRunIds = new Set<string>()
  let anyRecord = false
  let nextRunAt: string | undefined
  let legacyFinishedAt: string | undefined
  let consecutiveExecutionErrors = 0
  let lastFailureAlertClaimedAt: string | undefined
  const foldExecutionStatus = (status: string) => {
    if (status === 'error') consecutiveExecutionErrors += 1
    else if (status === 'success' || status === 'silent') consecutiveExecutionErrors = 0
  }
  for (const raw of lines) {
    const parsed = parseRunLine(raw)
    if (parsed.kind === 'skip') continue
    if (parsed.record.jobId !== jobId) continue
    if (parsed.kind === 'v1') {
      anyRecord = true
      foldExecutionStatus(parsed.record.status)
      if (parsed.record.status !== 'expired') {
        const finished = parsed.record.finishedAt
        if (legacyFinishedAt === undefined || finished > legacyFinishedAt) legacyFinishedAt = finished
      }
      continue
    }
    if (parsed.kind === 'failure-alert-claim') {
      failureAlertRunIds.add(parsed.record.runId)
      if (
        lastFailureAlertClaimedAt === undefined
        || Date.parse(parsed.record.claimedAt) > Date.parse(lastFailureAlertClaimedAt)
      ) lastFailureAlertClaimedAt = parsed.record.claimedAt
      continue
    }
    if (parsed.kind === 'claim') {
      claims.set(parsed.record.runId, parsed.record)
      settled.add(parsed.record.runId)
      if (!isManualRun(parsed.record)) {
        anyRecord = true
        if (parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
      }
      continue
    }
    if (!isManualRun(parsed.record)) anyRecord = true
    if (!finishes.has(parsed.record.runId)) foldExecutionStatus(parsed.record.status)
    finishes.add(parsed.record.runId)
    settled.add(parsed.record.runId)
    if (!isManualRun(parsed.record) && parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
  }
  const interrupted: RunClaimRecord[] = []
  for (const [runId, claimRecord] of claims) {
    if (!finishes.has(runId)) interrupted.push(claimRecord)
  }
  return {
    settledRunIds: settled,
    anyRecord,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    interrupted,
    ...(legacyFinishedAt === undefined ? {} : { legacyFinishedAt }),
    consecutiveExecutionErrors,
    failureAlertRunIds,
    ...(lastFailureAlertClaimedAt === undefined ? {} : { lastFailureAlertClaimedAt }),
  }
}

/**
 * V2 run ledger: the scheduler's single-writer event book over runs.jsonl.
 * Claim-before-side-effect is enforced by the caller; this class only makes
 * claim idempotent (same runId cannot be claimed twice) and foldable.
 */
export class RunLedger {
  private readonly store: JsonlStore

  constructor(storeDir: string) {
    this.store = new JsonlStore(join(storeDir, 'runs.jsonl'))
  }

  /** Fold one job's projection from the current file contents. */
  foldJob(jobId: string): FoldedJobRuns {
    return foldRunLines(this.store.readLines(), jobId)
  }

  /**
   * Idempotently claim one run. Returns `claimed` only when the append
   * landed; `already_claimed` when the runId is settled (claim or finish).
   * I/O failures throw — the caller must not execute any side effect.
   */
  claim(record: RunClaimRecord): 'claimed' | 'already_claimed' {
    if (this.foldJob(record.jobId).settledRunIds.has(record.runId)) return 'already_claimed'
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

  /** Append one V2 finish event. I/O failures throw. */
  finish(record: RunFinishRecord): void {
    this.store.append(record)
  }
}
