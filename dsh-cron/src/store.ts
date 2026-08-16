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
  FoldedJobs,
  JobLogEntry,
  RunClaimRecord,
  RunFinishRecord,
  RunRecord,
} from './types.ts'

/** Parse one strict JSON line; invalid lines are treated as a corrupt log. */
function parseLine<T>(line: string): T {
  return JSON.parse(line) as T
}

/**
 * Fold the append-only job log into the current active set.
 * Invalid lines are skipped (tombstone can never be un-done by a corrupt
 * create, so skipping preserves the last-writer intent of surviving lines).
 */
export function foldJobLog(lines: readonly string[]): FoldedJobs {
  const active = new Map<string, JobLogEntry & { readonly op: 'create' }>()
  const seenIds: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    let entry: JobLogEntry
    try {
      entry = parseLine<JobLogEntry>(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') continue
    if (!seenIds.includes(entry.id)) seenIds.push(entry.id)
    if (entry.op === 'create') {
      if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') continue
      if (typeof entry.schedule !== 'object' || entry.schedule === null) continue
      if (entry.deliver !== 'telegram' && entry.deliver !== 'silent') continue
      active.set(entry.id, entry)
    } else if (entry.op === 'delete') {
      active.delete(entry.id)
    }
  }
  return {
    active: [...active.values()].map(({ op: _op, ...job }) => ({
      id: job.id,
      schedule: job.schedule,
      prompt: job.prompt,
      deliver: job.deliver,
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
      createdAt: job.createdAt,
    })),
    seenIds: seenIds,
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

  /** Read every recorded run (absent file = empty). */
  readAll(): RunRecord[] {
    const records: RunRecord[] = []
    for (const raw of this.store.readLines()) {
      const line = raw.trim()
      if (line === '') continue
      try {
        const record = parseLine<RunRecord>(line)
        if (typeof record === 'object' && record !== null && typeof record.jobId === 'string') {
          records.push(record)
        }
      } catch {
        // Corrupt run history lines are skipped; the audit trail is best-effort.
      }
    }
    return records
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
  | { readonly kind: 'finish'; readonly record: RunFinishRecord }
  | { readonly kind: 'skip' }

/** V2 finish statuses that are valid ledger events. */
const VALID_FINISH_STATUSES = new Set(['success', 'error', 'silent', 'expired', 'interrupted'])

/** Whether a value is a non-empty string that Date can parse. */
function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

/** Whether a value is a non-empty string (whitespace-only counts as empty). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
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
        && (record.nextRunAt === undefined || isValidTime(record.nextRunAt))
      ) {
        return { kind: 'finish', record: record as unknown as RunFinishRecord }
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
  /** Whether any V1 or V2 record exists for the job (once-settled check). */
  readonly anyRecord: boolean
  /** Recovery nextRunAt (ISO) from the latest V2 claim/finish, if any. */
  readonly nextRunAt?: string
  /** Claims without a finish — interrupted audit, never re-executed. */
  readonly interrupted: readonly RunClaimRecord[]
  /** Latest non-expired V1 terminal record's finishedAt (legacy anchor). */
  readonly legacyFinishedAt?: string
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
  let anyRecord = false
  let nextRunAt: string | undefined
  let legacyFinishedAt: string | undefined
  for (const raw of lines) {
    const parsed = parseRunLine(raw)
    if (parsed.kind === 'skip') continue
    if (parsed.record.jobId !== jobId) continue
    anyRecord = true
    if (parsed.kind === 'v1') {
      if (parsed.record.status !== 'expired') {
        const finished = parsed.record.finishedAt
        if (legacyFinishedAt === undefined || finished > legacyFinishedAt) legacyFinishedAt = finished
      }
      continue
    }
    if (parsed.kind === 'claim') {
      claims.set(parsed.record.runId, parsed.record)
      settled.add(parsed.record.runId)
      if (parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
      continue
    }
    finishes.add(parsed.record.runId)
    settled.add(parsed.record.runId)
    if (parsed.record.nextRunAt !== undefined) nextRunAt = parsed.record.nextRunAt
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

  /** Append one V2 finish event. I/O failures throw. */
  finish(record: RunFinishRecord): void {
    this.store.append(record)
  }
}
