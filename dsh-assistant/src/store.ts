/**
 * SQLite store for dsh-assistant responsibilities, closed audit rows, Web
 * observations, and the Telegram outbox. Two processes (web + telegram) each
 * open their own connection; WAL + `busy_timeout` + `BEGIN IMMEDIATE`
 * serialize short transactions.
 *
 * Ownership rules (landing guide §6.1):
 * - the DB carries `application_id = 0x44534841` and `user_version = 4`;
 * - an empty database may be initialized; a non-matching identity or an
 *   unversioned non-empty schema is rejected (never guessed or overwritten);
 * - parent directory 0700, database file 0600;
 * - every write transaction uses `BEGIN IMMEDIATE` and rolls back on failure;
 * - updates are revision-conditional so a stale tool result can never
 *   overwrite a newer lifecycle change.
 * @module @deepseek-ai/dsh-assistant
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  boundText,
  validateMonitorCheckpoint,
  validateMonitorDirection,
  validateMonitorEventKey,
  isOpenStatus,
  type CommitmentStatus,
  type OutboxKind,
  type OutboxState,
  type ResponsibilityKind,
  type MonitorDesiredState,
  type MonitorResumeState,
  type ReminderState,
  type SourceSurface,
  type WorkOwner,
  type WorkerControlState,
} from './domain.ts'
import { ASSISTANT_APPLICATION_ID, ASSISTANT_CRON_BINDINGS_SCHEMA_SQL, ASSISTANT_SCHEMA_VERSION } from './schema.ts'

export { ASSISTANT_APPLICATION_ID, ASSISTANT_SCHEMA_VERSION } from './schema.ts'

/** Default store path: `$DSH_HOME/storages/dsh-assistant/state.sqlite`. */
export function defaultStorePath(home = resolveDshHome()): string {
  return join(home, 'storages', 'dsh-assistant', 'state.sqlite')
}

/** Storage-level failure codes surfaced to tools as stable tool errors. */
export type StoreErrorCode =
  | 'current_commitment_exists'
  | 'revision_mismatch'
  | 'invalid_transition'
  | 'not_found'
  | 'terminal'
  | 'persistence_failed'

/** Result of one conditional store mutation. */
export type WriteResult<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string; readonly current?: T }

/** One commitments row (camelCase projection of the snake_case table). */
export interface CommitmentRow {
  readonly id: string
  readonly kind: ResponsibilityKind
  readonly title: string
  readonly workOwner: WorkOwner
  readonly status: CommitmentStatus
  readonly nextAction: string | null
  readonly acceptedAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly result: string | null
  readonly blockedReason: string | null
  readonly checkInMinutes: number | null
  readonly reminderDueAt: string | null
  readonly reminderState: ReminderState
  readonly lastDeliveryState: string | null
  readonly lastDeliveryError: string | null
  readonly workerSessionId: string | null
  readonly workerParentSessionId: string | null
  readonly workerRunId: string | null
  readonly workerControlState: WorkerControlState
  readonly progressSummary: string | null
  readonly progressAt: string | null
  readonly monitorDesiredState: MonitorDesiredState
  readonly monitorResumeState: MonitorResumeState
  readonly monitorResumeEpoch: number
  readonly monitorClaimToken: string | null
  readonly monitorClaimedAt: string | null
  readonly monitorDirection: string | null
  readonly monitorCheckpoint: string | null
  readonly sourceSurface: SourceSurface
  readonly sourceSessionId: string | null
  readonly revision: number
}

/** One outbox row. */
export interface OutboxRow {
  readonly id: string
  readonly commitmentId: string
  readonly kind: OutboxKind
  readonly text: string
  readonly state: OutboxState
  readonly createdAt: string
  readonly claimedAt: string | null
  readonly claimToken: string | null
  readonly deliveredAt: string | null
  readonly error: string | null
  readonly monitorEventKey: string | null
  readonly monitorProposedCheckpoint: string | null
}

export type WebObservationState = 'running' | 'ended' | 'abnormal' | 'interrupted'

export interface WebObservationRow {
  readonly sessionId: string
  readonly turn: number
  readonly state: WebObservationState
  readonly requestText: string | null
  readonly lastAssistantText: string | null
  readonly lastAssistantMessageId: string | null
  readonly turnReason: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly cwd: string | null
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt: string | null
  readonly writerInstanceId: string
  readonly writerStartedAt: string
}

export type CronBindingDesiredState = 'running' | 'paused' | 'cancelled'
export type CronRunStatus = 'success' | 'error' | 'expired' | 'interrupted'
export type CronDeliveryState = 'delivered' | 'silent' | 'not_requested' | 'failed' | 'uncertain'

/** Assistant-owned projection of one manager binding and its latest run fact. */
export interface CronBindingRow {
  readonly commitmentId: string
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd: string | null
  readonly desiredState: CronBindingDesiredState
  readonly boundJobId: string | null
  readonly lastRunId: string | null
  readonly lastRunJobId: string | null
  readonly scheduledFor: string | null
  readonly finishedAt: string | null
  readonly runStatus: CronRunStatus | null
  readonly lastRunSummary: string | null
  readonly runError: string | null
  readonly deliveryState: CronDeliveryState | null
  readonly deliveryError: string | null
  readonly controlError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Joined assistant intent used by the one bounded Cron startup pass. */
export interface CronReconciliationIntent {
  readonly commitmentId: string
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd: string | null
  readonly desiredState: CronBindingDesiredState
  readonly boundJobId: string | null
  readonly controlError: string | null
  readonly commitmentStatus: CommitmentStatus
  readonly monitorDirection: string | null
}

export interface CreateCronBindingInput {
  readonly commitmentId: string
  readonly externalRef: string
  readonly desiredScheduleJson: string
  readonly desiredCwd?: string | null
  readonly desiredState: CronBindingDesiredState
  readonly boundJobId?: string | null
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface CronRunObservationInput {
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

export type CronBindingWriteResult =
  | { readonly ok: true; readonly row: CronBindingRow; readonly duplicate?: boolean; readonly advanced?: boolean }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string }

/** Input for creating a user-owned commitment. */
export interface CreateUserCommitmentInput {
  readonly title: string
  readonly status: 'pending' | 'active'
  readonly nextAction?: string
  readonly checkInMinutes?: number
  readonly sourceSurface: SourceSurface
  readonly sourceSessionId?: string
  readonly now: string
}

/** Input for creating an agent-owned commitment (always pending first). */
export interface CreateAgentCommitmentInput {
  readonly title: string
  readonly kind?: 'delegated' | 'monitor'
  readonly nextAction?: string
  readonly monitorDirection?: string
  readonly monitorCheckpoint?: string
  readonly sourceSurface: SourceSurface
  readonly sourceSessionId?: string
  readonly now: string
}

/** A worker-end settlement durable payload. */
export interface WorkerEndSettlement {
  readonly status: 'completed' | 'blocked'
  readonly result: string
  readonly summary?: string
  readonly blockedReason?: string
  readonly nextAction?: string
  readonly completedAt: string
  readonly workerRunId?: string
  readonly outboxId: string
  readonly outboxText: string
}

/** Identity attached to one currently running monitor child. */
export interface MonitorWorkerIdentity {
  readonly workerSessionId: string
  readonly workerRunId: string
  readonly workerParentSessionId: string
}

/** Inputs for one monitor round's durable event settlement. */
export interface MonitorEventSettlement {
  readonly commitmentId: string
  readonly expectedRevision: number
  readonly workerSessionId: string
  readonly workerRunId: string
  readonly workerParentSessionId: string
  readonly monitorResumeEpoch: number
  readonly eventKey: string
  readonly checkpoint: string
  readonly summary: string
  readonly outboxText: string
  readonly now: string
}

export interface MonitorEventOutboxResult {
  readonly outbox: OutboxRow
  readonly duplicate: boolean
}

export type MonitorDirectionWriteResult =
  | { readonly ok: true; readonly row: CommitmentRow; readonly oldWorker: MonitorWorkerIdentity | null; readonly oldDirection: string | null }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string; readonly current?: CommitmentRow }

export type MonitorEventWriteResult =
  | ({ readonly ok: true } & MonitorEventOutboxResult & { readonly row: CommitmentRow })
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string; readonly current?: CommitmentRow }

const COMMITMENT_COLUMNS = [
  'id', 'kind', 'title', 'work_owner', 'status', 'next_action',
  'accepted_at', 'created_at', 'updated_at', 'started_at', 'completed_at',
  'result', 'blocked_reason', 'check_in_minutes', 'reminder_due_at',
  'reminder_state', 'last_delivery_state', 'last_delivery_error',
  'worker_session_id', 'worker_parent_session_id', 'worker_run_id',
  'worker_control_state', 'progress_summary', 'progress_at',
  'monitor_desired_state', 'monitor_resume_state', 'monitor_resume_epoch',
  'monitor_claim_token', 'monitor_claimed_at',
  'monitor_direction', 'monitor_checkpoint',
  'source_surface', 'source_session_id', 'revision',
].join(', ')

const OUTBOX_COLUMNS = [
  'id', 'commitment_id', 'kind', 'text', 'state', 'created_at',
  'claimed_at', 'claim_token', 'delivered_at', 'error',
  'monitor_event_key', 'monitor_proposed_checkpoint',
].join(', ')

const CRON_BINDING_COLUMNS = [
  'commitment_id', 'external_ref', 'desired_schedule_json', 'desired_cwd', 'desired_state',
  'bound_job_id', 'last_run_id', 'last_run_job_id', 'scheduled_for', 'finished_at', 'run_status',
  'last_run_summary', 'run_error', 'delivery_state', 'delivery_error', 'control_error', 'created_at', 'updated_at',
].join(', ')

type RawRow = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function mapCommitment(row: RawRow): CommitmentRow {
  return {
    id: str(row.id) ?? '',
    kind: (str(row.kind) ?? 'focus') as ResponsibilityKind,
    title: str(row.title) ?? '',
    workOwner: (str(row.work_owner) ?? 'user') as WorkOwner,
    status: (str(row.status) ?? 'pending') as CommitmentStatus,
    nextAction: str(row.next_action),
    acceptedAt: str(row.accepted_at) ?? '',
    createdAt: str(row.created_at) ?? '',
    updatedAt: str(row.updated_at) ?? '',
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    result: str(row.result),
    blockedReason: str(row.blocked_reason),
    checkInMinutes: num(row.check_in_minutes),
    reminderDueAt: str(row.reminder_due_at),
    reminderState: (str(row.reminder_state) ?? 'none') as ReminderState,
    lastDeliveryState: str(row.last_delivery_state),
    lastDeliveryError: str(row.last_delivery_error),
    workerSessionId: str(row.worker_session_id),
    workerParentSessionId: str(row.worker_parent_session_id),
    workerRunId: str(row.worker_run_id),
    workerControlState: (str(row.worker_control_state) ?? 'none') as WorkerControlState,
    progressSummary: str(row.progress_summary),
    progressAt: str(row.progress_at),
    monitorDesiredState: (str(row.monitor_desired_state) ?? 'none') as MonitorDesiredState,
    monitorResumeState: (str(row.monitor_resume_state) ?? 'none') as MonitorResumeState,
    monitorResumeEpoch: num(row.monitor_resume_epoch) ?? 0,
    monitorClaimToken: str(row.monitor_claim_token),
    monitorClaimedAt: str(row.monitor_claimed_at),
    monitorDirection: str(row.monitor_direction),
    monitorCheckpoint: str(row.monitor_checkpoint),
    sourceSurface: (str(row.source_surface) ?? 'web') as SourceSurface,
    sourceSessionId: str(row.source_session_id),
    revision: num(row.revision) ?? 0,
  }
}

function mapOutbox(row: RawRow): OutboxRow {
  return {
    id: str(row.id) ?? '',
    commitmentId: str(row.commitment_id) ?? '',
    kind: (str(row.kind) ?? 'check_in') as OutboxKind,
    text: str(row.text) ?? '',
    state: (str(row.state) ?? 'pending') as OutboxState,
    createdAt: str(row.created_at) ?? '',
    claimedAt: str(row.claimed_at),
    claimToken: str(row.claim_token),
    deliveredAt: str(row.delivered_at),
    error: str(row.error),
    monitorEventKey: str(row.monitor_event_key),
    monitorProposedCheckpoint: str(row.monitor_proposed_checkpoint),
  }
}

function mapWebObservation(row: RawRow): WebObservationRow {
  return {
    sessionId: str(row.session_id) ?? '',
    turn: num(row.turn) ?? 0,
    state: (str(row.state) ?? 'interrupted') as WebObservationState,
    requestText: str(row.request_text),
    lastAssistantText: str(row.last_assistant_text),
    lastAssistantMessageId: str(row.last_assistant_message_id),
    turnReason: str(row.turn_reason),
    errorCode: str(row.error_code),
    errorMessage: str(row.error_message),
    cwd: str(row.cwd),
    startedAt: str(row.started_at) ?? '',
    updatedAt: str(row.updated_at) ?? '',
    finishedAt: str(row.finished_at),
    writerInstanceId: str(row.writer_instance_id) ?? '',
    writerStartedAt: str(row.writer_started_at) ?? '',
  }
}

function mapCronBinding(row: RawRow): CronBindingRow {
  return {
    commitmentId: str(row.commitment_id) ?? '',
    externalRef: str(row.external_ref) ?? '',
    desiredScheduleJson: str(row.desired_schedule_json) ?? '{}',
    desiredCwd: str(row.desired_cwd),
    desiredState: (str(row.desired_state) ?? 'running') as CronBindingDesiredState,
    boundJobId: str(row.bound_job_id),
    lastRunId: str(row.last_run_id),
    lastRunJobId: str(row.last_run_job_id),
    scheduledFor: str(row.scheduled_for),
    finishedAt: str(row.finished_at),
    runStatus: str(row.run_status) as CronRunStatus | null,
    lastRunSummary: str(row.last_run_summary),
    runError: str(row.run_error),
    deliveryState: str(row.delivery_state) as CronDeliveryState | null,
    deliveryError: str(row.delivery_error),
    controlError: str(row.control_error),
    createdAt: str(row.created_at) ?? '',
    updatedAt: str(row.updated_at) ?? '',
  }
}

function mapCronReconciliationIntent(row: RawRow): CronReconciliationIntent {
  return {
    commitmentId: str(row.commitment_id) ?? '',
    externalRef: str(row.external_ref) ?? '',
    desiredScheduleJson: str(row.desired_schedule_json) ?? '{}',
    desiredCwd: str(row.desired_cwd),
    desiredState: (str(row.desired_state) ?? 'running') as CronBindingDesiredState,
    boundJobId: str(row.bound_job_id),
    controlError: str(row.control_error),
    commitmentStatus: (str(row.commitment_status) ?? 'blocked') as CommitmentStatus,
    monitorDirection: str(row.monitor_direction),
  }
}

const OPEN_SQL = "status IN ('pending','active','paused','blocked')"

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS hit FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/**
 * Open (creating when absent) the assistant SQLite database with strict
 * identity validation. Rejects foreign application ids, unknown schema
 * versions, and unversioned non-empty schemas.
 */
export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  chmodSync(dirname(path), 0o700)
  const db = new DatabaseSync(path)
  try {
    configureDatabase(db, path)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  let began = false
  try {
    db.exec('BEGIN IMMEDIATE')
    began = true
    const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count: userObjectCount } = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    ).get() as { count: number }
    if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
      throw new Error(`assistant database at "${path}" has an unversioned schema or application identity; refusing to guess`)
    }
    if (onDisk !== 0 && onDisk !== ASSISTANT_SCHEMA_VERSION) {
      throw new Error(
        `assistant database at "${path}" has schema version ${onDisk}; run the explicit offline migration before starting this build (target ${ASSISTANT_SCHEMA_VERSION})`,
      )
    }
    if (onDisk === ASSISTANT_SCHEMA_VERSION && applicationId !== ASSISTANT_APPLICATION_ID) {
      throw new Error(
        `assistant database at "${path}" has application id ${applicationId}, expected ${ASSISTANT_APPLICATION_ID}`,
      )
    }
    if (onDisk === 0) createV4Schema(db)
    assertV4Schema(db, path)
    if (onDisk === 0) {
      db.exec(`PRAGMA application_id = ${ASSISTANT_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${ASSISTANT_SCHEMA_VERSION}`)
    }
    db.exec('COMMIT')
    began = false
  } catch (error: unknown) {
    if (began) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original schema failure.
      }
    }
    throw error
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    chmodSync(path, 0o600)
  } catch {
    // Non-fatal on platforms without POSIX permissions.
  }
}

function assertV4Schema(db: DatabaseSync, path: string): void {
  const required = {
    commitments: ['monitor_direction', 'monitor_checkpoint'],
    outbox: ['monitor_event_key', 'monitor_proposed_checkpoint'],
  }
  for (const [table, columns] of Object.entries(required)) {
    if (!tableExists(db, table)) throw new Error(`assistant database at "${path}" is missing v3 table ${table}`)
    const actual = new Set((db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as RawRow[]).map(row => str(row.name)).filter((name): name is string => name !== null))
    for (const column of columns) if (!actual.has(column)) throw new Error(`assistant database at "${path}" is missing v3 column ${table}.${column}`)
  }
  const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'outbox_monitor_event_unique'").get() as { sql?: string } | undefined
  if (index?.sql === undefined || !/UNIQUE INDEX/i.test(index.sql) || !/kind\s*=\s*'monitor_event'/i.test(index.sql)) {
    throw new Error(`assistant database at "${path}" is missing the v3 monitor-event uniqueness index`)
  }
  if (!tableExists(db, 'assistant_cron_bindings')) throw new Error(`assistant database at "${path}" is missing v4 assistant_cron_bindings`)
  const bindingColumns = new Set((db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings')").all() as RawRow[])
    .map(row => str(row.name)).filter((name): name is string => name !== null))
  for (const column of ['commitment_id', 'external_ref', 'desired_schedule_json', 'desired_cwd', 'desired_state', 'bound_job_id', 'last_run_id', 'last_run_job_id', 'scheduled_for', 'finished_at', 'run_status', 'last_run_summary', 'run_error', 'delivery_state', 'delivery_error', 'control_error', 'created_at', 'updated_at']) {
    if (!bindingColumns.has(column)) throw new Error(`assistant database at "${path}" is missing v4 binding column ${column}`)
  }
}

function createV4Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('focus','delegated','monitor')),
      title TEXT NOT NULL,
      work_owner TEXT NOT NULL CHECK (work_owner IN ('user','agent')),
      status TEXT NOT NULL CHECK (status IN ('pending','active','paused','blocked','completed','cancelled')),
      next_action TEXT, accepted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, result TEXT, blocked_reason TEXT,
      check_in_minutes INTEGER, reminder_due_at TEXT, reminder_state TEXT NOT NULL,
      last_delivery_state TEXT, last_delivery_error TEXT,
      worker_session_id TEXT, worker_parent_session_id TEXT, worker_run_id TEXT,
      worker_control_state TEXT NOT NULL DEFAULT 'none'
        CHECK (worker_control_state IN ('none','pause_requested','resume_requested')),
      progress_summary TEXT, progress_at TEXT,
      monitor_desired_state TEXT NOT NULL DEFAULT 'none'
        CHECK (monitor_desired_state IN ('none','running','paused')),
      monitor_resume_state TEXT NOT NULL DEFAULT 'none'
        CHECK (monitor_resume_state IN ('none','needed','claimed')),
      monitor_resume_epoch INTEGER NOT NULL DEFAULT 0,
      monitor_claim_token TEXT, monitor_claimed_at TEXT,
      monitor_direction TEXT, monitor_checkpoint TEXT,
      source_surface TEXT NOT NULL CHECK (source_surface IN ('web','telegram')),
      source_session_id TEXT, revision INTEGER NOT NULL,
      CHECK ((kind = 'focus' AND work_owner = 'user') OR (kind IN ('delegated','monitor') AND work_owner = 'agent'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id),
      kind TEXT NOT NULL CHECK (kind IN ('check_in','completed','blocked','missed_check_in','progress','monitor_event')),
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','uncertain','cancelled')),
      created_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT, delivered_at TEXT, error TEXT,
      monitor_event_key TEXT, monitor_proposed_checkpoint TEXT,
      CHECK ((kind = 'monitor_event' AND monitor_event_key IS NOT NULL AND monitor_proposed_checkpoint IS NOT NULL)
        OR (kind <> 'monitor_event' AND monitor_event_key IS NULL AND monitor_proposed_checkpoint IS NULL))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS web_observations (
      session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, state TEXT NOT NULL
        CHECK (state IN ('running','ended','abnormal','interrupted')),
      request_text TEXT, last_assistant_text TEXT, last_assistant_message_id TEXT,
      turn_reason TEXT, error_code TEXT, error_message TEXT, cwd TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      writer_instance_id TEXT NOT NULL, writer_started_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS commitments_open_focus
      ON commitments(kind) WHERE kind = 'focus' AND ${OPEN_SQL};
    CREATE UNIQUE INDEX IF NOT EXISTS commitments_worker_session
      ON commitments(worker_session_id) WHERE worker_session_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_monitor_event_unique
      ON outbox(commitment_id, monitor_event_key)
      WHERE kind = 'monitor_event';
  `)
  db.exec(ASSISTANT_CRON_BINDINGS_SCHEMA_SQL)
}

/** One in-memory change intent shared by all conditional updates. */
interface ChangeIntent {
  readonly id: string
  readonly expectedRevision: number
  readonly sets: Record<string, string | number | null>
  readonly whereStatus?: CommitmentStatus[]
  readonly whereWorkOwner?: WorkOwner
  readonly whereWorkerSessionNull?: boolean
  readonly whereControlIn?: WorkerControlState[]
  readonly whereKind?: ResponsibilityKind
  readonly whereMonitorDesired?: MonitorDesiredState
  readonly whereMonitorResumeIn?: MonitorResumeState[]
  readonly whereMonitorDirectionNonNull?: boolean
  readonly whereNoNonTerminalMonitorEvent?: boolean
}

/**
 * SQLite store facade. All methods are synchronous (node:sqlite) and every
 * mutation runs inside its own `BEGIN IMMEDIATE` transaction.
 */
export class AssistantStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = openDatabase(path)
  }

  close(): void {
    this.db.close()
  }

  /** Run one mutation inside a transaction, mapping failures to WriteResult. */
  private mutate(intent: ChangeIntent): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, intent.id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== intent.expectedRevision) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'revision_mismatch',
          message: `The commitment changed since this view was read (revision ${intent.expectedRevision} → ${current.revision}); re-read and retry.`,
          current,
        }
      }
      if (intent.whereStatus !== undefined && !intent.whereStatus.includes(current.status)) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'invalid_transition',
          message: `The commitment is ${current.status}; this operation requires ${intent.whereStatus.join(' or ')}.`,
          current,
        }
      }
      if (intent.whereWorkerSessionNull === true && current.workerSessionId !== null) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'invalid_transition',
          message: 'The commitment already has a worker session.',
          current,
        }
      }
      if (intent.whereWorkOwner !== undefined && current.workOwner !== intent.whereWorkOwner) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'invalid_transition',
          message: `The commitment is owned by ${current.workOwner}; this operation requires ${intent.whereWorkOwner}.`,
          current,
        }
      }
      if (intent.whereControlIn !== undefined && !intent.whereControlIn.includes(current.workerControlState)) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'invalid_transition',
          message: `The commitment worker control state is ${current.workerControlState}.`,
          current,
        }
      }
      if (intent.whereKind !== undefined && current.kind !== intent.whereKind) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `The commitment kind is ${current.kind}.`, current }
      }
      if (intent.whereMonitorDesired !== undefined && current.monitorDesiredState !== intent.whereMonitorDesired) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `The monitor desired state is ${current.monitorDesiredState}.`, current }
      }
      if (intent.whereMonitorResumeIn !== undefined && !intent.whereMonitorResumeIn.includes(current.monitorResumeState)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `The monitor resume state is ${current.monitorResumeState}.`, current }
      }
      if (intent.whereMonitorDirectionNonNull === true && current.monitorDirection === null) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The monitor has no persisted direction.', current }
      }
      if (intent.whereNoNonTerminalMonitorEvent === true) {
        const pendingEvent = tx.prepare("SELECT 1 AS hit FROM outbox WHERE commitment_id = ? AND kind = 'monitor_event' AND state IN ('pending','claimed') LIMIT 1").get(current.id)
        if (pendingEvent !== undefined) {
          tx.exec('ROLLBACK')
          return { ok: false, code: 'invalid_transition', message: 'A monitor event is still awaiting delivery.', current }
        }
      }
      const { sql, params } = AssistantStore.updateSql(intent)
      tx.prepare(sql).run(...params)
      const updated = this.selectCurrentById(tx, intent.id)!
      tx.exec('COMMIT')
      return { ok: true, row: updated }
    } catch (error: unknown) {
      try {
        tx.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Build one UPDATE ... WHERE id + revision clause set. */
  private static updateSql(intent: ChangeIntent): { sql: string; params: Array<string | number | null> } {
    const sets = { ...intent.sets, updated_at: new Date().toISOString(), revision: intent.expectedRevision + 1 }
    const values = [...Object.values(sets)]
    return {
      sql: `UPDATE commitments SET ${Object.keys(sets).map(key => `${key} = ?`).join(', ')} WHERE id = ? AND revision = ?`,
      params: [...values, intent.id, intent.expectedRevision],
    }
  }

  private selectCurrentById(db: DatabaseSync, id: string): CommitmentRow | undefined {
    const raw = db.prepare(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE id = ?`).get(id) as RawRow | undefined
    return raw === undefined ? undefined : mapCommitment(raw)
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Compatibility helper for legacy tests/callers: only one open row is unambiguous. */
  getCurrent(): CommitmentRow | undefined {
    const rows = this.listOpen(2)
    return rows.length === 1 ? rows[0] : undefined
  }

  getById(id: string): CommitmentRow | undefined {
    return this.selectCurrentById(this.db, id)
  }

  /** The most recent closed (completed/cancelled) commitment, for lastClosed. */
  getLastClosed(): CommitmentRow | undefined {
    // Order by the row's last write (its closure write), not completed_at:
    // cancelled rows never set completed_at, and mixing simulated and real
    // clocks would misorder them. updated_at is bumped exactly once at closure
    // and never after (delivery bookkeeping does not touch it).
    const raw = this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments
       WHERE status IN ('completed', 'cancelled')
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    ).get() as RawRow | undefined
    return raw === undefined ? undefined : mapCommitment(raw)
  }

  /** The most recent terminal global focus; Web must never see Agent closures. */
  getLastClosedFocus(): CommitmentRow | undefined {
    const raw = this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments
       WHERE kind = 'focus' AND status IN ('completed', 'cancelled')
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    ).get() as RawRow | undefined
    return raw === undefined ? undefined : mapCommitment(raw)
  }

  /**
   * A strictly bounded Telegram-only view of recently terminal Agent work.
   * This gives the root causal state after outbox-only delivery without an
   * unbounded history scan in every automatic prompt.
   */
  listRecentTelegramAgentClosures(): CommitmentRow[] {
    return (this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments
       WHERE kind IN ('delegated','monitor') AND work_owner = 'agent'
         AND source_surface = 'telegram' AND status IN ('completed','cancelled')
       ORDER BY COALESCE(completed_at, updated_at) DESC, updated_at DESC, id DESC
       LIMIT 3`,
    ).all() as RawRow[]).map(mapCommitment)
  }

  getOpenFocus(): CommitmentRow | undefined {
    const raw = this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE kind = 'focus' AND ${OPEN_SQL} LIMIT 1`,
    ).get() as RawRow | undefined
    return raw === undefined ? undefined : mapCommitment(raw)
  }

  listTelegramAgentResponsibilities(limit = 101): CommitmentRow[] {
    return (this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments
       WHERE kind IN ('delegated','monitor') AND source_surface = 'telegram' AND ${OPEN_SQL}
       ORDER BY created_at, id LIMIT ?`,
    ).all(limit) as RawRow[]).map(mapCommitment)
  }

  countTelegramAgentResponsibilities(): number {
    return Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM commitments
       WHERE kind IN ('delegated','monitor') AND source_surface = 'telegram' AND ${OPEN_SQL}`,
    ).get() as { n: number }).n)
  }

  listMonitorsNeedingResume(limit = 100): CommitmentRow[] {
    return (this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments
       WHERE kind = 'monitor' AND status IN ('active','paused')
         AND monitor_desired_state = 'running' AND monitor_resume_state = 'needed'
       ORDER BY created_at, id LIMIT ?`,
    ).all(limit) as RawRow[]).map(mapCommitment)
  }

  getByWorkerSessionId(workerSessionId: string): CommitmentRow | undefined {
    const raw = this.db.prepare(
      `SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE worker_session_id = ? LIMIT 1`,
    ).get(workerSessionId) as RawRow | undefined
    return raw === undefined ? undefined : mapCommitment(raw)
  }

  listOpen(limit = 1000): CommitmentRow[] {
    return (this.db.prepare(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE ${OPEN_SQL} ORDER BY created_at, id LIMIT ?`).all(limit) as RawRow[])
      .map(mapCommitment)
  }

  listPendingOutbox(): OutboxRow[] {
    return (this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE state = 'pending' ORDER BY created_at`).all() as RawRow[])
      .map(mapOutbox)
  }

  listClaimedOutbox(): OutboxRow[] {
    return (this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE state = 'claimed' ORDER BY created_at`).all() as RawRow[])
      .map(mapOutbox)
  }

  getOutbox(id: string): OutboxRow | undefined {
    const raw = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`).get(id) as RawRow | undefined
    return raw === undefined ? undefined : mapOutbox(raw)
  }

  getOutboxByMonitorEventKey(commitmentId: string, eventKey: string): OutboxRow | undefined {
    const raw = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE commitment_id = ? AND monitor_event_key = ? LIMIT 1`).get(commitmentId, eventKey.trim()) as RawRow | undefined
    return raw === undefined ? undefined : mapOutbox(raw)
  }

  listMonitorEventOutbox(commitmentId: string, limit = 1000): OutboxRow[] {
    return (this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE commitment_id = ? AND kind = 'monitor_event' ORDER BY created_at, id LIMIT ?`).all(commitmentId, limit) as RawRow[]).map(mapOutbox)
  }

  /** Read the one latest monitor event without relying on a bounded list. */
  getLatestMonitorEvent(commitmentId: string): OutboxRow | undefined {
    const raw = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox
      WHERE commitment_id = ? AND kind = 'monitor_event'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(commitmentId) as RawRow | undefined
    return raw === undefined ? undefined : mapOutbox(raw)
  }

  listMonitorFailedOrUncertainEventKeys(commitmentId: string): string[] {
    return (this.db.prepare(`SELECT monitor_event_key FROM outbox WHERE commitment_id = ? AND kind = 'monitor_event' AND state IN ('failed','uncertain') AND monitor_event_key IS NOT NULL ORDER BY created_at, id`).all(commitmentId) as RawRow[])
      .map(row => str(row.monitor_event_key))
      .filter((key): key is string => key !== null)
  }

  getWebObservation(sessionId: string): WebObservationRow | undefined {
    const raw = this.db.prepare('SELECT * FROM web_observations WHERE session_id = ?').get(sessionId) as RawRow | undefined
    return raw === undefined ? undefined : mapWebObservation(raw)
  }

  listWebObservations(limit = 20): WebObservationRow[] {
    return (this.db.prepare(
      'SELECT * FROM web_observations ORDER BY updated_at DESC, session_id LIMIT ?',
    ).all(limit) as RawRow[]).map(mapWebObservation)
  }

  startWebObservation(input: {
    sessionId: string; turn: number; cwd?: string; now: string; writerInstanceId: string; writerStartedAt: string
  }): boolean {
    const result = this.db.prepare(`
      INSERT INTO web_observations (
        session_id, turn, state, request_text, last_assistant_text, last_assistant_message_id,
        turn_reason, error_code, error_message, cwd, started_at, updated_at, finished_at,
        writer_instance_id, writer_started_at
      ) VALUES (?, ?, 'running', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        turn = excluded.turn, state = 'running', request_text = NULL,
        last_assistant_text = NULL, last_assistant_message_id = NULL,
        turn_reason = NULL, error_code = NULL, error_message = NULL,
        cwd = excluded.cwd, started_at = excluded.started_at,
        updated_at = excluded.updated_at, finished_at = NULL,
        writer_instance_id = excluded.writer_instance_id,
        writer_started_at = excluded.writer_started_at
      WHERE web_observations.writer_instance_id = excluded.writer_instance_id
         OR excluded.writer_started_at > web_observations.writer_started_at
    `).run(
      input.sessionId, input.turn, input.cwd ?? null, input.now, input.now,
      input.writerInstanceId, input.writerStartedAt,
    )
    return result.changes > 0
  }

  updateWebObservation(
    sessionId: string,
    writerInstanceId: string,
    sets: {
      requestText?: string
      assistantText?: string
      assistantMessageId?: string
      state?: WebObservationState
      turnReason?: string
      errorCode?: string
      errorMessage?: string
      finishedAt?: string
    },
    now: string,
  ): boolean {
    const columns: Record<string, string | null> = { updated_at: now }
    if (sets.requestText !== undefined) columns.request_text = boundText(sets.requestText)
    if (sets.assistantText !== undefined) columns.last_assistant_text = boundText(sets.assistantText)
    if (sets.assistantMessageId !== undefined) columns.last_assistant_message_id = sets.assistantMessageId
    if (sets.state !== undefined) columns.state = sets.state
    if (sets.turnReason !== undefined) columns.turn_reason = sets.turnReason
    if (sets.errorCode !== undefined) columns.error_code = sets.errorCode
    if (sets.errorMessage !== undefined) columns.error_message = boundText(sets.errorMessage, 2000)
    if (sets.finishedAt !== undefined) columns.finished_at = sets.finishedAt
    const result = this.db.prepare(
      `UPDATE web_observations SET ${Object.keys(columns).map(key => `${key} = ?`).join(', ')}
       WHERE session_id = ? AND writer_instance_id = ?`,
    ).run(...Object.values(columns), sessionId, writerInstanceId)
    return result.changes > 0
  }

  interruptWebObservations(writerInstanceId: string, now: string): number {
    const result = this.db.prepare(`
      UPDATE web_observations
      SET state = 'interrupted', turn_reason = 'writer-disposed', updated_at = ?, finished_at = ?
      WHERE writer_instance_id = ? AND state = 'running'
    `).run(now, now, writerInstanceId)
    return Number(result.changes)
  }

  // ── assistant-owned dsh-cron binding projection ─────────────────────────

  /** Alias used by application ports; it never scans or guesses a target. */
  getCommitment(id: string): CommitmentRow | undefined {
    return this.getById(id)
  }

  /** Persist the sole Cron monitor prompt authority on the commitment row. */
  updateCronMonitorDirection(input: {
    readonly commitmentId: string
    readonly expectedRevision: number
    readonly direction: string
    readonly now: string
  }): WriteResult<CommitmentRow> {
    const directionError = validateMonitorDirection(input.direction)
    if (directionError !== undefined) return { ok: false, code: 'invalid_transition', message: directionError }
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, input.commitmentId)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.revision !== input.expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed before Cron direction replacement.', current }
      }
      if (current.kind !== 'monitor' || !isOpenStatus(current.status)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Only an open monitor direction can be replaced.', current }
      }
      if (this.getCronBindingFrom(tx, input.commitmentId) === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Cron direction replacement requires an existing binding.', current }
      }
      const updated = tx.prepare(`
        UPDATE commitments
        SET monitor_direction = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(input.direction.trim(), input.now, input.commitmentId, input.expectedRevision)
      if (updated.changes !== 1) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'persistence_failed', message: 'Cron monitor direction update did not affect one commitment.', current }
      }
      const row = this.selectCurrentById(tx, input.commitmentId)
      if (row === undefined) throw new Error('Cron monitor disappeared after direction update')
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  getCronBinding(commitmentId: string): CronBindingRow | undefined {
    const raw = this.db.prepare(`SELECT ${CRON_BINDING_COLUMNS} FROM assistant_cron_bindings WHERE commitment_id = ?`).get(commitmentId) as RawRow | undefined
    return raw === undefined ? undefined : mapCronBinding(raw)
  }

  getCronBindingByJobId(jobId: string): CronBindingRow | undefined {
    const raw = this.db.prepare(`SELECT ${CRON_BINDING_COLUMNS} FROM assistant_cron_bindings WHERE bound_job_id = ? LIMIT 1`).get(jobId) as RawRow | undefined
    return raw === undefined ? undefined : mapCronBinding(raw)
  }

  /** Lightweight lookup for the run-finished bridge. */
  findCronBindingByJobId(jobId: string): { readonly commitmentId: string; readonly externalRef: string } | undefined {
    const row = this.getCronBindingByJobId(jobId)
    return row === undefined ? undefined : { commitmentId: row.commitmentId, externalRef: row.externalRef }
  }

  listCronBindings(limit = 100): CronBindingRow[] {
    return (this.db.prepare(`SELECT ${CRON_BINDING_COLUMNS} FROM assistant_cron_bindings ORDER BY created_at, commitment_id LIMIT ?`).all(limit) as RawRow[]).map(mapCronBinding)
  }

  /** Read one bounded, joined desired-intent view for startup reconciliation. */
  listCronReconciliationIntents(limit = 100): CronReconciliationIntent[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 100) : 100
    return (this.db.prepare(`
      SELECT b.commitment_id, b.external_ref, b.desired_schedule_json, b.desired_cwd,
             b.desired_state, b.bound_job_id, b.control_error AS control_error,
             c.status AS commitment_status,
             c.monitor_direction
      FROM assistant_cron_bindings AS b
      INNER JOIN commitments AS c ON c.id = b.commitment_id
      ORDER BY b.created_at, b.commitment_id
      LIMIT ?
    `).all(boundedLimit) as RawRow[]).map(mapCronReconciliationIntent)
  }

  /** Compatibility view used by the observation runtime; it is still the ordinary assistant outbox. */
  listOutbox(commitmentId: string): OutboxRow[] {
    return (this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE commitment_id = ? ORDER BY created_at, id`).all(commitmentId) as RawRow[]).map(mapOutbox)
  }

  createCronBinding(input: CreateCronBindingInput): CronBindingWriteResult {
    const now = input.updatedAt ?? input.createdAt ?? new Date().toISOString()
    const createdAt = input.createdAt ?? now
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const commitment = this.selectCurrentById(tx, input.commitmentId)
      if (commitment === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (commitment.kind !== 'monitor') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Cron bindings require a monitor commitment.' }
      }
      tx.prepare(`INSERT INTO assistant_cron_bindings
        (commitment_id, external_ref, desired_schedule_json, desired_cwd, desired_state, bound_job_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.commitmentId, input.externalRef, input.desiredScheduleJson, input.desiredCwd ?? null, input.desiredState, input.boundJobId ?? null, createdAt, now)
      const row = this.getCronBindingFrom(tx, input.commitmentId)
      if (row === undefined) throw new Error('cron binding disappeared after insert')
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Upsert the durable desired binding without changing commitment lifecycle fields. */
  saveCronBinding(input: Record<string, unknown>): CronBindingWriteResult {
    const commitmentId = typeof input.commitmentId === 'string' ? input.commitmentId : ''
    const externalRef = typeof input.externalRef === 'string' ? input.externalRef : ''
    const desiredScheduleJson = typeof input.desiredScheduleJson === 'string'
      ? input.desiredScheduleJson
      : JSON.stringify(input.schedule ?? {})
    const desiredState = (input.desiredState === 'paused' || input.desiredState === 'cancelled') ? input.desiredState : 'running'
    const desiredCwd = typeof input.desiredCwd === 'string' ? input.desiredCwd : null
    const boundJobId = typeof input.boundJobId === 'string' ? input.boundJobId : null
    const now = typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
    const existing = this.getCronBinding(commitmentId)
    if (existing === undefined) {
      return this.createCronBinding({ commitmentId, externalRef, desiredScheduleJson, desiredCwd, desiredState, boundJobId, createdAt: typeof input.createdAt === 'string' ? input.createdAt : now, updatedAt: now })
    }
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      tx.prepare(`UPDATE assistant_cron_bindings
        SET external_ref = ?, desired_schedule_json = ?, desired_cwd = ?, desired_state = ?,
            bound_job_id = COALESCE(?, bound_job_id), control_error = NULL, updated_at = ?
        WHERE commitment_id = ?`).run(externalRef, desiredScheduleJson, desiredCwd, desiredState, boundJobId, now, commitmentId)
      const row = this.getCronBindingFrom(tx, commitmentId)
      if (row === undefined) throw new Error('cron binding disappeared after update')
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  updateCronBoundJobId(commitmentId: string, jobId: string): CronBindingRow | undefined {
    const result = this.db.prepare(`UPDATE assistant_cron_bindings SET bound_job_id = ?, control_error = NULL, updated_at = ? WHERE commitment_id = ?`).run(jobId, new Date().toISOString(), commitmentId)
    return result.changes === 0 ? undefined : this.getCronBinding(commitmentId)
  }

  /** Explicitly clear a stale manager job projection; null is not COALESCE'd. */
  clearCronBoundJobId(input: Record<string, unknown>): CronBindingRow | undefined {
    const commitmentId = typeof input.commitmentId === 'string' ? input.commitmentId : undefined
    if (commitmentId === undefined) return undefined
    const result = this.db.prepare(`UPDATE assistant_cron_bindings SET bound_job_id = NULL, control_error = NULL, updated_at = ? WHERE commitment_id = ?`).run(new Date().toISOString(), commitmentId)
    return result.changes === 0 ? undefined : this.getCronBinding(commitmentId)
  }

  setCronDesiredState(commitmentId: string, state: CronBindingDesiredState): CronBindingRow | undefined {
    const result = this.db.prepare(`UPDATE assistant_cron_bindings SET desired_state = ?, updated_at = ? WHERE commitment_id = ?`).run(state, new Date().toISOString(), commitmentId)
    return result.changes === 0 ? undefined : this.getCronBinding(commitmentId)
  }

  /** Project a successful manager snapshot back into the binding row. */
  updateCronBindingActual(input: Record<string, unknown>): CronBindingRow | undefined {
    const commitmentId = typeof input.commitmentId === 'string' ? input.commitmentId : undefined
    const externalRef = typeof input.externalRef === 'string' ? input.externalRef : undefined
    const boundJobId = typeof input.boundJobId === 'string' ? input.boundJobId : null
    const target = commitmentId ?? externalRef
    if (target === undefined) return undefined
    const where = commitmentId === undefined ? 'external_ref = ?' : 'commitment_id = ?'
    const result = this.db.prepare(`UPDATE assistant_cron_bindings SET bound_job_id = COALESCE(?, bound_job_id), control_error = NULL, updated_at = ? WHERE ${where}`).run(boundJobId, new Date().toISOString(), target)
    if (result.changes === 0) return undefined
    return commitmentId === undefined ? this.getCronBindingByExternalRef(externalRef!) : this.getCronBinding(commitmentId)
  }

  recordCronControlError(commitmentIdOrInput: string | Record<string, unknown>, errorText?: string): CronBindingRow | undefined {
    const commitmentId = typeof commitmentIdOrInput === 'string' ? commitmentIdOrInput : typeof commitmentIdOrInput.commitmentId === 'string' ? commitmentIdOrInput.commitmentId : undefined
    const externalRef = typeof commitmentIdOrInput === 'object' && typeof commitmentIdOrInput.externalRef === 'string' ? commitmentIdOrInput.externalRef : undefined
    const message = typeof commitmentIdOrInput === 'object' && typeof commitmentIdOrInput.error === 'string'
      ? commitmentIdOrInput.error
      : errorText ?? 'dsh-cron control operation failed'
    const target = commitmentId ?? externalRef
    if (target === undefined) return undefined
    const where = commitmentId === undefined ? 'external_ref = ?' : 'commitment_id = ?'
    const result = this.db.prepare(`UPDATE assistant_cron_bindings SET control_error = ?, updated_at = ? WHERE ${where}`).run(boundText(message, 2000), new Date().toISOString(), target)
    if (result.changes === 0) return undefined
    return commitmentId === undefined ? this.getCronBindingByExternalRef(externalRef!) : this.getCronBinding(commitmentId)
  }

  /** One atomic preparation step for explicit legacy monitor recovery. */
  prepareCronRebind(input: Record<string, unknown>): CronBindingRow | undefined {
    const commitmentId = typeof input.commitmentId === 'string' ? input.commitmentId : ''
    const externalRef = typeof input.externalRef === 'string' ? input.externalRef : ''
    const scheduleJson = typeof input.desiredScheduleJson === 'string' ? input.desiredScheduleJson : JSON.stringify(input.schedule ?? {})
    const desiredCwd = typeof input.desiredCwd === 'string' ? input.desiredCwd : null
    const now = typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      tx.prepare(`INSERT INTO assistant_cron_bindings
        (commitment_id, external_ref, desired_schedule_json, desired_cwd, desired_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT(commitment_id) DO UPDATE SET external_ref = excluded.external_ref,
          desired_schedule_json = excluded.desired_schedule_json, desired_cwd = excluded.desired_cwd,
          desired_state = 'running', control_error = NULL, updated_at = excluded.updated_at`)
        .run(commitmentId, externalRef, scheduleJson, desiredCwd, now, now)
      tx.prepare(`UPDATE commitments SET worker_session_id = NULL, worker_run_id = NULL,
          worker_parent_session_id = NULL, worker_control_state = 'none', monitor_resume_state = 'none',
          monitor_claim_token = NULL, monitor_claimed_at = NULL, updated_at = ?, revision = revision + 1
        WHERE id = ?`).run(now, commitmentId)
      const row = this.getCronBindingFrom(tx, commitmentId)
      tx.exec('COMMIT')
      return row
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return undefined
    }
  }

  setCommitmentStatus(commitmentId: string, status: CommitmentStatus): CommitmentRow | undefined {
    const result = this.db.prepare(`UPDATE commitments SET status = ?, blocked_reason = CASE WHEN ? = 'blocked' THEN blocked_reason ELSE NULL END, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(status, status, new Date().toISOString(), commitmentId)
    return result.changes === 0 ? undefined : this.getById(commitmentId)
  }

  closeCommitment(commitmentId: string): CommitmentRow | undefined {
    return this.setCommitmentStatus(commitmentId, 'cancelled')
  }

  observeCronRunFinished(input: CronRunObservationInput): CronBindingWriteResult {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getCronBindingFrom(tx, input.commitmentId)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The cron binding no longer exists.' }
      }
      if (current.externalRef !== input.externalRef) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The cron binding external reference does not match.' }
      }
      if (current.lastRunId === input.runId) {
        tx.exec('ROLLBACK')
        return { ok: true, row: current, duplicate: true, advanced: false }
      }
      const oldFinished = current.finishedAt ?? current.scheduledFor ?? ''
      if (current.lastRunId !== null && input.finishedAt < oldFinished) {
        tx.exec('ROLLBACK')
        return { ok: true, row: current, duplicate: false, advanced: false }
      }
      tx.prepare(`UPDATE assistant_cron_bindings SET
        bound_job_id = ?, last_run_id = ?, last_run_job_id = ?, scheduled_for = ?, finished_at = ?,
        run_status = ?, last_run_summary = ?, run_error = ?, delivery_state = ?, delivery_error = ?,
        control_error = NULL, updated_at = ? WHERE commitment_id = ?`)
        .run(
          input.jobId,
          input.runId,
          input.jobId,
          input.scheduledFor,
          input.finishedAt,
          input.runStatus,
          input.summary === undefined ? null : boundText(input.summary, 1000),
          input.error === undefined ? null : boundText(input.error, 2000),
          input.deliveryState,
          input.deliveryError === undefined ? null : boundText(input.deliveryError, 2000),
          input.now,
          input.commitmentId,
        )
      const row = this.getCronBindingFrom(tx, input.commitmentId)
      if (row === undefined) throw new Error('cron binding disappeared after observation')
      tx.exec('COMMIT')
      return { ok: true, row, duplicate: false, advanced: true }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private getCronBindingFrom(db: DatabaseSync, commitmentId: string): CronBindingRow | undefined {
    const raw = db.prepare(`SELECT ${CRON_BINDING_COLUMNS} FROM assistant_cron_bindings WHERE commitment_id = ?`).get(commitmentId) as RawRow | undefined
    return raw === undefined ? undefined : mapCronBinding(raw)
  }

  private getCronBindingByExternalRef(externalRef: string): CronBindingRow | undefined {
    const raw = this.db.prepare(`SELECT ${CRON_BINDING_COLUMNS} FROM assistant_cron_bindings WHERE external_ref = ?`).get(externalRef) as RawRow | undefined
    return raw === undefined ? undefined : mapCronBinding(raw)
  }

  // ── create ───────────────────────────────────────────────────────────────

  private createCommitment(
    input: {
      title: string
      kind: ResponsibilityKind
      status: CommitmentStatus
      workOwner: WorkOwner
      nextAction?: string
      checkInMinutes?: number
      monitorDirection?: string
      monitorCheckpoint?: string
      sourceSurface: SourceSurface
      sourceSessionId?: string
      now: string
    },
  ): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const existing = input.kind === 'focus'
        ? (tx.prepare(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE kind = 'focus' AND ${OPEN_SQL} LIMIT 1`).get() as RawRow | undefined)
        : undefined
      if (existing !== undefined) {
        const current = mapCommitment(existing)
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'current_commitment_exists',
          message: 'Pause, complete, or cancel the current focus before starting another.',
          current,
        }
      }
      const id = `assistant-${randomUUID().slice(0, 8)}`
      const acceptedAt = input.now
      const createdAt = input.now
      const updatedAt = input.now
      const active = input.status === 'active'
      const checkIn = input.checkInMinutes === undefined ? null : input.checkInMinutes
      const reminderDueAt = active && checkIn !== null
        ? new Date(Date.parse(input.now) + checkIn * 60_000).toISOString()
        : null
      const reminderState: ReminderState = reminderDueAt !== null ? 'scheduled' : 'none'
      if (input.kind === 'monitor' && input.monitorDirection === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Monitor commitments require a non-empty monitor direction.' }
      }
      if (input.kind !== 'monitor' && (input.monitorDirection !== undefined || input.monitorCheckpoint !== undefined)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Only monitor commitments may carry monitor direction or checkpoint.' }
      }
      if (input.monitorDirection !== undefined) {
        const error = validateMonitorDirection(input.monitorDirection)
        if (error !== undefined) {
          tx.exec('ROLLBACK')
          return { ok: false, code: 'invalid_transition', message: error }
        }
      }
      if (input.monitorCheckpoint !== undefined) {
        const error = validateMonitorCheckpoint(input.monitorCheckpoint)
        if (error !== undefined) {
          tx.exec('ROLLBACK')
          return { ok: false, code: 'invalid_transition', message: error }
        }
      }
      tx.prepare(`
        INSERT INTO commitments (
          id, kind, title, work_owner, status, next_action, accepted_at, created_at,
          updated_at, started_at, completed_at, result, blocked_reason, check_in_minutes,
          reminder_due_at, reminder_state, last_delivery_state, last_delivery_error,
          worker_session_id, worker_parent_session_id, worker_run_id, worker_control_state,
          progress_summary, progress_at, monitor_desired_state, monitor_resume_state,
          monitor_resume_epoch, monitor_claim_token, monitor_claimed_at, monitor_direction, monitor_checkpoint,
          source_surface, source_session_id, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'none',
          NULL, NULL, ?, 'none', 0, NULL, NULL, ?, ?, ?, ?, 1)
      `).run(
        id,
        input.kind,
        boundText(input.title),
        input.workOwner,
        input.status,
        input.nextAction === undefined ? null : boundText(input.nextAction),
        acceptedAt,
        createdAt,
        updatedAt,
        checkIn,
        reminderDueAt,
        reminderState,
        input.kind === 'monitor' ? 'running' : 'none',
        input.monitorDirection ?? null,
        input.monitorCheckpoint ?? null,
        input.sourceSurface,
        input.sourceSessionId ?? null,
      )
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try {
        tx.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  createUserCommitment(input: CreateUserCommitmentInput): WriteResult<CommitmentRow> {
    return this.createCommitment({
      title: input.title,
      kind: 'focus',
      status: input.status,
      workOwner: 'user',
      ...input.nextAction === undefined ? {} : { nextAction: input.nextAction },
      ...input.checkInMinutes === undefined ? {} : { checkInMinutes: input.checkInMinutes },
      sourceSurface: input.sourceSurface,
      ...input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId },
      now: input.now,
    })
  }

  createAgentCommitment(input: CreateAgentCommitmentInput): WriteResult<CommitmentRow> {
    return this.createCommitment({
      title: input.title,
      kind: input.kind ?? 'delegated',
      status: 'pending',
      workOwner: 'agent',
      ...input.nextAction === undefined ? {} : { nextAction: input.nextAction },
      ...input.monitorDirection === undefined ? {} : { monitorDirection: input.monitorDirection },
      ...input.monitorCheckpoint === undefined ? {} : { monitorCheckpoint: input.monitorCheckpoint },
      sourceSurface: input.sourceSurface,
      ...input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId },
      now: input.now,
    })
  }

  // ── worker identity and lifecycle ────────────────────────────────────────

  /** pending → active once the child id is confirmed (delegate step 5). */
  markAgentActive(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    return this.mutate(
      { id, expectedRevision, sets: { status: 'active' }, whereStatus: ['pending'] },
    )
  }

  /** Save child identity from `subagent/start` (delegate step 4). */
  saveWorkerIdentity(
    id: string,
    expectedRevision: number,
    identity: { workerSessionId: string; workerRunId: string; workerParentSessionId: string },
  ): WriteResult<CommitmentRow> {
    return this.mutate(
      {
        id,
        expectedRevision,
        sets: {
          worker_session_id: identity.workerSessionId,
          worker_run_id: identity.workerRunId,
          worker_parent_session_id: identity.workerParentSessionId,
        },
        whereStatus: ['pending'],
        whereWorkerSessionNull: true,
      },
    )
  }

  /**
   * Atomically take over the worker control after a resume's new residency
   * start (验收返工 §4.4): in one revision-guarded write, require the
   * commitment to be agent-owned and `active`, the control state to still be
   * `resume_requested`, and then persist the new run id while clearing the
   * control to `none`. No other operation may update a run id.
   */
  acceptResumedWorkerRun(id: string, expectedRevision: number, workerRunId: string): WriteResult<CommitmentRow> {
    const sets: Record<string, string | number | null> = {
      worker_run_id: workerRunId,
      worker_control_state: 'none',
      monitor_resume_state: 'none',
      monitor_claim_token: null,
      monitor_claimed_at: null,
    }
    return this.mutate(
      {
        id,
        expectedRevision,
        sets,
        whereStatus: ['active'],
        whereWorkOwner: 'agent',
        whereControlIn: ['resume_requested'],
      },
    )
  }

  /**
   * Atomically claim a fresh monitor round after a prior round's outbox has
   * reached a terminal state. The claim is revision/token guarded so two
   * controllers cannot start two children for one monitor.
   */
  claimFreshMonitor(
    id: string,
    expectedRevision: number,
    token: string,
    now: string,
  ): WriteResult<CommitmentRow> {
    if (token.trim() === '') return { ok: false, code: 'invalid_transition', message: 'monitor claim token must be non-empty' }
    return this.mutate({
      id,
      expectedRevision,
      sets: {
        worker_control_state: 'resume_requested',
        monitor_resume_state: 'claimed',
        monitor_claim_token: token,
        monitor_claimed_at: now,
      },
      whereStatus: ['active'],
      whereWorkOwner: 'agent',
      whereWorkerSessionNull: true,
      whereControlIn: ['none'],
      whereKind: 'monitor',
      whereMonitorDesired: 'running',
      whereMonitorResumeIn: ['needed'],
      whereMonitorDirectionNonNull: true,
      whereNoNonTerminalMonitorEvent: true,
    })
  }

  /** Persist the child identity for a fresh monitor claim exactly once. */
  saveMonitorWorkerIdentity(
    id: string,
    expectedRevision: number,
    claimToken: string,
    monitorResumeEpoch: number,
    identity: MonitorWorkerIdentity,
  ): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed during fresh claim.', current }
      }
      if (
        current.kind !== 'monitor'
        || current.status !== 'active'
        || current.monitorDesiredState !== 'running'
        || current.workerSessionId !== null
        || current.workerControlState !== 'resume_requested'
        || current.monitorResumeState !== 'claimed'
        || current.monitorClaimToken !== claimToken
        || current.monitorResumeEpoch !== monitorResumeEpoch
      ) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The fresh monitor claim is no longer current.', current }
      }
      const sql = AssistantStore.updateSql({
        id,
        expectedRevision,
        sets: {
          worker_session_id: identity.workerSessionId,
          worker_run_id: identity.workerRunId,
          worker_parent_session_id: identity.workerParentSessionId,
          worker_control_state: 'none',
          monitor_resume_state: 'none',
          monitor_claim_token: null,
          monitor_claimed_at: null,
        },
      })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Persist a new direction before the controller interrupts the old child.
   * The old identity remains visible until confirmMonitorStop, so a restart
   * or a late old end cannot create a second untracked worker.
   */
  replaceMonitorDirection(
    id: string,
    expectedRevision: number,
    direction: string,
    now: string,
  ): MonitorDirectionWriteResult {
    return this.writeMonitorDirection(id, expectedRevision, direction, now, false)
  }

  /**
   * Persist a direction and an explicit user-resume intent in one transaction.
   * This is deliberately separate from replaceMonitorDirection: changing what
   * a paused/blocked monitor watches must not silently resume it.
   */
  requestMonitorResume(
    id: string,
    expectedRevision: number,
    direction: string,
    now: string,
  ): MonitorDirectionWriteResult {
    return this.writeMonitorDirection(id, expectedRevision, direction, now, true)
  }

  private writeMonitorDirection(
    id: string,
    expectedRevision: number,
    direction: string,
    now: string,
    resumeIntent: boolean,
  ): MonitorDirectionWriteResult {
    void now
    const error = validateMonitorDirection(direction)
    if (error !== undefined) return { ok: false, code: 'invalid_transition', message: error }
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed before direction replacement.', current }
      }
      if (current.kind !== 'monitor' || !isOpenStatus(current.status)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'Only an open monitor direction can be replaced.', current }
      }
      const oldWorker = current.workerSessionId === null || current.workerRunId === null || current.workerParentSessionId === null
        ? null
        : {
          workerSessionId: current.workerSessionId,
          workerRunId: current.workerRunId,
          workerParentSessionId: current.workerParentSessionId,
        }
      const hasNonTerminalMonitorEvent = tx.prepare(
        `SELECT 1 AS hit FROM outbox WHERE commitment_id = ? AND kind = 'monitor_event' AND state IN ('pending','claimed') LIMIT 1`,
      ).get(id) !== undefined
      const activeWithoutWorker = current.status === 'active' && oldWorker === null
      const pausedOrBlocked = current.status === 'paused' || current.status === 'blocked'
      const canExposeFresh = !hasNonTerminalMonitorEvent && (
        activeWithoutWorker || (resumeIntent && oldWorker === null && pausedOrBlocked)
      )
      const shouldResume = resumeIntent && pausedOrBlocked
      const status = shouldResume ? 'active' : current.status
      const desired = shouldResume ? 'running' : current.monitorDesiredState
      const workerControl = oldWorker === null ? 'none' : 'pause_requested'
      const sql = AssistantStore.updateSql({
        id,
        expectedRevision,
        sets: {
          monitor_direction: direction.trim(),
          // A direction replacement invalidates the old run epoch. Keep its
          // identity until confirmMonitorStop so the controller can interrupt
          // precisely that child and late events remain harmless.
          monitor_resume_epoch: current.monitorResumeEpoch + 1,
          status,
          monitor_desired_state: desired,
          worker_control_state: workerControl,
          monitor_resume_state: canExposeFresh ? 'needed' : 'none',
          monitor_claim_token: null,
          monitor_claimed_at: null,
        },
      })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row, oldWorker, oldDirection: current.monitorDirection }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Direction replacement confirmation: active/running + pause_requested only. */
  confirmMonitorFreshStop(
    id: string,
    expectedRevision: number,
    identity: MonitorWorkerIdentity,
  ): WriteResult<CommitmentRow> {
    return this.confirmMonitorStopExact(id, expectedRevision, identity, 'fresh')
  }

  /** Pause confirmation: paused/paused + pause_requested, never resumes. */
  confirmMonitorPausedStop(
    id: string,
    expectedRevision: number,
    identity: MonitorWorkerIdentity,
  ): WriteResult<CommitmentRow> {
    return this.confirmMonitorStopExact(id, expectedRevision, identity, 'paused')
  }

  private confirmMonitorStopExact(
    id: string,
    expectedRevision: number,
    identity: MonitorWorkerIdentity,
    mode: 'fresh' | 'paused',
  ): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed before stop confirmation.', current }
      }
      const modeMatches = mode === 'fresh'
        ? current.status === 'active' && current.monitorDesiredState === 'running'
        : current.status === 'paused' && current.monitorDesiredState === 'paused'
      if (
        current.kind !== 'monitor'
        || !modeMatches
        || current.workerControlState !== 'pause_requested'
        || current.workerSessionId !== identity.workerSessionId
        || current.workerRunId !== identity.workerRunId
        || current.workerParentSessionId !== identity.workerParentSessionId
      ) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The stopped monitor worker identity or lifecycle is no longer current.', current }
      }
      const sql = AssistantStore.updateSql({
        id,
        expectedRevision,
        sets: {
          worker_session_id: null,
          worker_run_id: null,
          worker_parent_session_id: null,
          worker_control_state: 'none',
          monitor_resume_state: mode === 'fresh' ? 'needed' : 'none',
          monitor_claim_token: null,
          monitor_claimed_at: null,
        },
      })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Settle one monitor event and detach only the currently authenticated run. */
  settleMonitorEvent(input: MonitorEventSettlement): MonitorEventWriteResult {
    const eventKey = typeof input.eventKey === 'string' ? input.eventKey.trim() : input.eventKey
    const checkpoint = typeof input.checkpoint === 'string' ? input.checkpoint.trim() : input.checkpoint
    const keyError = validateMonitorEventKey(eventKey)
    const checkpointError = validateMonitorCheckpoint(checkpoint)
    if (keyError !== undefined) return { ok: false, code: 'invalid_transition', message: keyError }
    if (checkpointError !== undefined) return { ok: false, code: 'invalid_transition', message: checkpointError }
    if (typeof input.summary !== 'string' || input.summary.trim() === '') return { ok: false, code: 'invalid_transition', message: 'monitor event summary must be non-empty' }
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, input.commitmentId)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.status === 'completed' || current.status === 'cancelled') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'terminal', message: `The monitor is already ${current.status}; ignoring the late event.`, current }
      }
      if (current.revision !== input.expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed before event settlement.', current }
      }
      if (
        current.kind !== 'monitor'
        || current.status !== 'active'
        || current.monitorDesiredState !== 'running'
        || current.workerSessionId !== input.workerSessionId
        || current.workerRunId !== input.workerRunId
        || current.workerParentSessionId !== input.workerParentSessionId
        || current.monitorResumeEpoch !== input.monitorResumeEpoch
        || current.workerControlState !== 'none'
      ) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The monitor worker identity or epoch is no longer current.', current }
      }
      const existingRaw = tx.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE commitment_id = ? AND monitor_event_key = ? LIMIT 1`).get(current.id, eventKey) as RawRow | undefined
      const existing = existingRaw === undefined ? undefined : mapOutbox(existingRaw)
      let outbox: OutboxRow
      if (existing !== undefined) {
        outbox = existing
      } else {
        const outboxId = `monitor-event:${createHash('sha256').update(`${current.id}\u0000${eventKey}`).digest('hex')}`
        tx.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at, monitor_event_key, monitor_proposed_checkpoint) VALUES (?, ?, 'monitor_event', ?, 'pending', ?, ?, ?)`).run(
          outboxId, current.id, boundText(input.outboxText), input.now, eventKey, checkpoint,
        )
        outbox = this.getOutbox(outboxId)!
      }
      const resumeState: MonitorResumeState = existing !== undefined && ['delivered', 'failed', 'uncertain', 'cancelled'].includes(existing.state)
        ? (current.status === 'active' && current.monitorDesiredState === 'running' ? 'needed' : 'none')
        : 'none'
      const sql = AssistantStore.updateSql({
        id: current.id,
        expectedRevision: current.revision,
        sets: {
          worker_session_id: null,
          worker_run_id: null,
          worker_parent_session_id: null,
          worker_control_state: 'none',
          monitor_resume_state: resumeState,
          monitor_claim_token: null,
          monitor_claimed_at: null,
        },
      })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, current.id)!
      tx.exec('COMMIT')
      return { ok: true, row, outbox, duplicate: existing !== undefined }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Claim one parked monitor resume before calling followup. */
  claimMonitorResume(
    id: string,
    expectedRevision: number,
    token: string,
    now: string,
  ): WriteResult<CommitmentRow> {
    const current = this.getById(id)
    if (current === undefined) return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
    if (current.kind !== 'monitor' || current.monitorDesiredState !== 'running' || current.monitorResumeState !== 'needed') {
      return { ok: false, code: 'invalid_transition', message: 'The monitor is not awaiting cold resume.', current }
    }
    return this.mutate({
      id,
      expectedRevision,
      sets: {
        status: 'active',
        worker_control_state: 'resume_requested',
        monitor_resume_state: 'claimed',
        monitor_claim_token: token,
        monitor_claimed_at: now,
      },
      whereStatus: ['paused'],
      whereWorkOwner: 'agent',
      whereControlIn: ['none'],
    })
  }

  /** Persist one official child report and its outbox row exactly once. */
  recordWorkerProgress(
    workerSessionId: string,
    messageId: string,
    text: string,
    now: string,
  ): { readonly inserted: boolean } {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const raw = tx.prepare(
        `SELECT ${COMMITMENT_COLUMNS} FROM commitments
         WHERE worker_session_id = ? AND worker_run_id IS NOT NULL AND worker_parent_session_id IS NOT NULL
           AND worker_control_state = 'none' AND kind IN ('delegated','monitor') AND ${OPEN_SQL} LIMIT 1`,
      ).get(workerSessionId) as RawRow | undefined
      if (raw === undefined) {
        tx.exec('ROLLBACK')
        return { inserted: false }
      }
      const current = mapCommitment(raw)
      const outboxId = `progress:${workerSessionId}:${messageId}`
      const progressSummary = boundText(text)
      const deliveryText = boundText(`🔄 进展：${current.title}\n\n${progressSummary}`)
      const inserted = tx.prepare(`
        INSERT OR IGNORE INTO outbox (id, commitment_id, kind, text, state, created_at)
        VALUES (?, ?, 'progress', ?, 'pending', ?)
      `).run(outboxId, current.id, deliveryText, now)
      if (inserted.changes === 0) {
        tx.exec('ROLLBACK')
        return { inserted: false }
      }
      const sql = AssistantStore.updateSql({
        id: current.id,
        expectedRevision: current.revision,
        sets: { progress_summary: progressSummary, progress_at: now },
      })
      tx.prepare(sql.sql).run(...sql.params)
      tx.exec('COMMIT')
      return { inserted: true }
    } catch (error) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  /** Fail one claimed monitor resume and queue its one epoch-scoped notice. */
  failMonitorResume(
    id: string,
    expectedRevision: number,
    reason: string,
    now: string,
    outboxText: string,
  ): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The monitor no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The monitor changed during resume.', current }
      }
      if (current.kind !== 'monitor' || current.monitorResumeState !== 'claimed') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: 'The monitor resume is no longer claimed.', current }
      }
      const sets: Record<string, string | number | null> = {
        status: 'blocked',
        blocked_reason: boundText(reason),
        worker_session_id: null,
        worker_parent_session_id: null,
        worker_run_id: null,
        worker_control_state: 'none',
        monitor_resume_state: 'none',
        monitor_claim_token: null,
        monitor_claimed_at: null,
      }
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      tx.prepare(`
        INSERT OR IGNORE INTO outbox (id, commitment_id, kind, text, state, created_at)
        VALUES (?, ?, 'blocked', ?, 'pending', ?)
      `).run(`monitor-resume:${id}:${current.monitorResumeEpoch}`, id, boundText(outboxText), now)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Whether a durable worker session belongs to an agent-owned commitment of this parent (§4.3). */
  ownsWorkerSession(workerSessionId: string, parentSessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS hit FROM commitments
      WHERE worker_session_id = ? AND worker_parent_session_id = ? AND work_owner = 'agent'
      LIMIT 1
    `).get(workerSessionId, parentSessionId) as RawRow | undefined
    return row !== undefined
  }

  /** Mark an agent commitment failed (interrupt failure / startup uncertainty). */
  failWorker(
    id: string,
    expectedRevision: number,
    reason: string,
    nextAction?: string,
  ): WriteResult<CommitmentRow> {
    const current = this.getById(id)
    if (current?.kind === 'monitor' && (current.monitorResumeState === 'claimed' || current.workerControlState === 'resume_requested')) {
      return this.failFreshMonitorStart(id, expectedRevision, reason, nextAction)
    }
    const sets: Record<string, string | number | null> = {
      status: 'blocked',
      blocked_reason: boundText(reason),
      next_action: nextAction === undefined ? null : boundText(nextAction),
      worker_control_state: 'none',
    }
    return this.mutate(
      { id, expectedRevision, sets, whereStatus: ['pending', 'active', 'paused', 'blocked'] },
    )
  }

  /** pending → blocked after a failed child start (delegate step 6). */
  markStartFailed(id: string, expectedRevision: number, reason: string): WriteResult<CommitmentRow> {
    const sets: Record<string, string | number | null> = {
      status: 'blocked',
      blocked_reason: boundText(reason),
      next_action: '后台启动失败，等待用户决定是否重试',
      worker_control_state: 'none',
    }
    return this.mutate(
      { id, expectedRevision, sets, whereStatus: ['pending'] },
    )
  }

  /** Mark a fresh monitor claim failed without leaving a claimed ghost. */
  failFreshMonitorStart(
    id: string,
    expectedRevision: number,
    reason: string,
    nextAction?: string,
  ): WriteResult<CommitmentRow> {
    return this.mutate({
      id,
      expectedRevision,
      sets: {
        status: 'blocked',
        blocked_reason: boundText(reason),
        next_action: nextAction === undefined ? null : boundText(nextAction),
        worker_session_id: null,
        worker_parent_session_id: null,
        worker_run_id: null,
        worker_control_state: 'none',
        monitor_resume_state: 'none',
        monitor_claim_token: null,
        monitor_claimed_at: null,
      },
      whereStatus: ['active'],
      whereKind: 'monitor',
      whereMonitorResumeIn: ['claimed'],
      whereControlIn: ['resume_requested'],
    })
  }

  /**
   * Settle one worker end (result protocol) in a single transaction:
   * status + result + outbox insert. The outbox insert is idempotent, so a
   * duplicate end can never double-deliver.
   */
  settleWorkerEnd(id: string, expectedRevision: number, settlement: WorkerEndSettlement): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.status === 'completed' || current.status === 'cancelled') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'terminal', message: `The commitment is already ${current.status}; ignoring the late event.`, current }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return {
          ok: false,
          code: 'revision_mismatch',
          message: `The commitment changed since this view was read (revision ${expectedRevision} → ${current.revision}).`,
          current,
        }
      }
      const sets: Record<string, string | number | null> = {
        status: settlement.status,
        completed_at: settlement.completedAt,
        result: boundText(settlement.result),
        blocked_reason: settlement.blockedReason === undefined ? null : boundText(settlement.blockedReason),
        next_action: settlement.nextAction === undefined ? null : boundText(settlement.nextAction),
        last_delivery_state: null,
        last_delivery_error: null,
        worker_control_state: 'none',
      }
      // A blocked monitor round is a completed responsibility *round*, not a
      // live worker.  Clear every identity/claim in the same transaction so a
      // later resume can only claim a fresh child and a late old end has no
      // worker-session lookup to mutate.  Delegated commitments retain their
      // historical worker identity as before.
      if (current.kind === 'monitor' && settlement.status === 'blocked') {
        sets.worker_session_id = null
        sets.worker_parent_session_id = null
        sets.worker_run_id = null
        sets.monitor_resume_state = 'none'
        sets.monitor_claim_token = null
        sets.monitor_claimed_at = null
      } else if (settlement.workerRunId !== undefined) {
        sets.worker_run_id = settlement.workerRunId
      }
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      tx.prepare(`
        INSERT OR IGNORE INTO outbox (id, commitment_id, kind, text, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(
        settlement.outboxId,
        id,
        settlement.status === 'completed' ? 'completed' : 'blocked',
        boundText(settlement.outboxText),
        settlement.completedAt,
      )
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try {
        tx.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── user-commitment transitions (status + reminders in one tx) ──────────

  /** active → paused; cancel scheduled reminder and pending check-in outbox. */
  pauseUser(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (current.status !== 'active') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot pause a ${current.status} commitment.`, current }
      }
      this.cancelReminderState(tx, id)
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets: { status: 'paused' } })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** paused/blocked → active; reschedule the reminder with old or new interval. */
  resumeUser(id: string, expectedRevision: number, interval: number | undefined, now: string): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (current.status !== 'paused' && current.status !== 'blocked') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot resume a ${current.status} commitment.`, current }
      }
      const minutes = interval ?? current.checkInMinutes
      const dueAt = minutes !== null && minutes !== undefined
        ? new Date(Date.parse(now) + minutes * 60_000).toISOString()
        : null
      const sets: Record<string, string | number | null> = {
        status: 'active',
        reminder_due_at: dueAt,
        reminder_state: dueAt !== null ? 'scheduled' : 'none',
      }
      if (interval !== undefined) sets.check_in_minutes = interval
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** active → active (acknowledged); reschedule from now with old or new interval. */
  stillWorking(id: string, expectedRevision: number, interval: number | undefined, now: string): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (current.status !== 'active') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot mark a ${current.status} commitment as still working.`, current }
      }
      const minutes = interval ?? current.checkInMinutes
      const dueAt = minutes !== null && minutes !== undefined
        ? new Date(Date.parse(now) + minutes * 60_000).toISOString()
        : null
      const sets: Record<string, string | number | null> = {
        reminder_due_at: dueAt,
        reminder_state: dueAt !== null ? 'scheduled' : 'none',
      }
      if (interval !== undefined) sets.check_in_minutes = interval
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** pending/active → blocked; cancel reminders. */
  block(id: string, expectedRevision: number, reason: string, nextAction?: string): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (current.status !== 'pending' && current.status !== 'active') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot block a ${current.status} commitment.`, current }
      }
      this.cancelReminderState(tx, id)
      const sets: Record<string, string | number | null> = {
        status: 'blocked',
        blocked_reason: boundText(reason),
      }
      if (nextAction !== undefined) sets.next_action = boundText(nextAction)
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Any open user focus → completed; release the global focus. */
  completeUser(id: string, expectedRevision: number, result: string | undefined, now: string): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (!isOpenStatus(current.status)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot complete a ${current.status} commitment.`, current }
      }
      this.cancelReminderState(tx, id)
      const sets: Record<string, string | number | null> = {
        status: 'completed',
        completed_at: now,
      }
      if (result !== undefined && result.trim() !== '') sets.result = boundText(result)
      const sql = AssistantStore.updateSql({ id, expectedRevision, sets })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Any open responsibility → cancelled. */
  cancel(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const current = this.selectCurrentById(tx, id)
      if (current === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_found', message: 'The commitment no longer exists.' }
      }
      if (current.revision !== expectedRevision) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'revision_mismatch', message: 'The commitment changed since this view was read.', current }
      }
      if (!isOpenStatus(current.status)) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'invalid_transition', message: `Cannot cancel a ${current.status} commitment.`, current }
      }
      this.cancelReminderState(tx, id)
      if (current.kind === 'monitor') {
        tx.prepare("UPDATE outbox SET state = 'cancelled' WHERE commitment_id = ? AND kind = 'monitor_event' AND state = 'pending'").run(id)
      }
      const sql = AssistantStore.updateSql({
        id,
        expectedRevision,
        sets: {
          status: 'cancelled',
          ...(current.kind === 'monitor'
            ? {
              monitor_desired_state: 'none',
              monitor_resume_state: 'none',
              monitor_claim_token: null,
              monitor_claimed_at: null,
            }
            : {}),
        },
      })
      tx.prepare(sql.sql).run(...sql.params)
      const row = this.selectCurrentById(tx, id)!
      tx.exec('COMMIT')
      return { ok: true, row }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      return { ok: false, code: 'persistence_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── agent-commitment control ─────────────────────────────────────────────

  /** active → paused with pause_requested (persisted BEFORE interrupt). */
  pauseAgent(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    const current = this.getById(id)
    const sets: Record<string, string | number | null> = {
      status: 'paused',
      worker_control_state: current?.workerSessionId === null ? 'none' : 'pause_requested',
    }
    if (current?.kind === 'monitor') {
      sets.monitor_desired_state = 'paused'
      sets.monitor_resume_state = 'none'
      sets.monitor_claim_token = null
      sets.monitor_claimed_at = null
    }
    return this.mutate(
      { id, expectedRevision, sets, whereStatus: ['active'] },
    )
  }

  /** paused/blocked → active with resume_requested (persisted BEFORE followup). */
  resumeAgent(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    const sets: Record<string, string | number | null> = {
      status: 'active',
      worker_control_state: 'resume_requested',
    }
    return this.mutate(
      { id, expectedRevision, sets, whereStatus: ['paused', 'blocked'] },
    )
  }

  clearWorkerControl(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    return this.mutate(
      { id, expectedRevision, sets: { worker_control_state: 'none' } },
    )
  }

  /** Roll a failed resume back to paused (revision-guarded, §11.4). */
  rollbackResume(id: string, expectedRevision: number): WriteResult<CommitmentRow> {
    const sets: Record<string, string | number | null> = {
      status: 'paused',
      worker_control_state: 'none',
    }
    return this.mutate(
      { id, expectedRevision, sets, whereStatus: ['active'] },
    )
  }

  setNextAction(id: string, expectedRevision: number, nextAction: string): WriteResult<CommitmentRow> {
    return this.mutate(
      { id, expectedRevision, sets: { next_action: boundText(nextAction) } },
    )
  }

  /** Normalize a leftover agent commitment after a restart (§11.5). */
  normalizeAgentOnStartup(): void {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const rows = (tx.prepare(
        `SELECT ${COMMITMENT_COLUMNS} FROM commitments
         WHERE kind IN ('delegated','monitor') AND ${OPEN_SQL} ORDER BY created_at, id`,
      ).all() as RawRow[]).map(mapCommitment)
      if (rows.length === 0) {
        tx.exec('ROLLBACK')
        return
      }
      let changed = false
      for (const current of rows) {
        const sets: Record<string, string | number | null> = {}
        if (current.kind === 'monitor') {
          const identityComplete = current.workerSessionId !== null
            && current.workerRunId !== null
            && current.workerParentSessionId !== null
          const identityPresent = current.workerSessionId !== null
            || current.workerRunId !== null
            || current.workerParentSessionId !== null
          const hasDirection = current.monitorDirection !== null
          const hasNonTerminalMonitorEvent = tx.prepare(
            `SELECT 1 AS hit FROM outbox WHERE commitment_id = ? AND kind = 'monitor_event' AND state IN ('pending','claimed') LIMIT 1`,
          ).get(current.id) !== undefined
          const clearIdentity = (): void => {
            sets.worker_session_id = null
            sets.worker_run_id = null
            sets.worker_parent_session_id = null
            sets.worker_control_state = 'none'
            sets.monitor_claim_token = null
            sets.monitor_claimed_at = null
          }
          const exposeFresh = (): void => {
            if (hasDirection) {
              sets.status = 'active'
              sets.monitor_desired_state = 'running'
              sets.monitor_resume_state = hasNonTerminalMonitorEvent ? 'none' : 'needed'
            } else {
              sets.status = 'blocked'
              sets.monitor_resume_state = 'none'
              sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
            }
          }

          // A blocked monitor is an explicit failure boundary. Restart must
          // not turn it into a fresh round; only a later user resume (or the
          // exact offline recovery contract) may do that.
          if (current.status === 'blocked') {
            if (identityPresent || current.workerControlState !== 'none' || current.monitorResumeState !== 'none' || current.monitorClaimToken !== null || current.monitorClaimedAt !== null) {
              clearIdentity()
              sets.monitor_resume_state = 'none'
            }
          } else if (current.monitorDesiredState === 'paused') {
            // A pause_requested old child is not recoverable across restart.
            // Keep the user's paused intent and discard that uncertain binding.
            if (current.status !== 'paused') sets.status = 'paused'
            if (identityPresent || current.workerControlState !== 'none' || current.monitorResumeState !== 'none' || current.monitorClaimToken !== null || current.monitorClaimedAt !== null) {
              clearIdentity()
              sets.monitor_resume_state = 'none'
            }
          } else if (current.monitorDesiredState === 'running') {
            if (current.status === 'pending') {
              if (identityComplete && current.workerControlState === 'none' && current.monitorResumeState !== 'claimed') {
                // The child identity was durably saved before the restart;
                // park it for the same-child cold-resume handshake.
                if (hasDirection) {
                  sets.status = 'paused'
                  sets.monitor_resume_state = hasNonTerminalMonitorEvent ? 'none' : 'needed'
                  sets.monitor_resume_epoch = current.monitorResumeEpoch + 1
                  sets.monitor_claim_token = null
                  sets.monitor_claimed_at = null
                } else {
                  clearIdentity()
                  sets.status = 'blocked'
                  sets.monitor_resume_state = 'none'
                  sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
                }
              } else {
                // A pending row without a complete identity is uncertain;
                // never leave it pending or reuse a partial child.
                clearIdentity()
                sets.monitor_resume_epoch = current.monitorResumeEpoch + 1
                exposeFresh()
              }
            } else if (current.status === 'active' && !identityPresent) {
              // A settled event normally leaves active/needed. Preserve an
              // active/no-worker pending-event window and let its terminal
              // outbox transition expose the next fresh claim.
              if (current.monitorResumeState === 'needed') {
                sets.monitor_claim_token = null
                sets.monitor_claimed_at = null
                if (!hasDirection) {
                  sets.status = 'blocked'
                  sets.monitor_resume_state = 'none'
                  sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
                } else if (hasNonTerminalMonitorEvent) {
                  sets.monitor_resume_state = 'none'
                }
              } else if (current.monitorResumeState === 'none' && !hasNonTerminalMonitorEvent) {
                sets.monitor_resume_state = hasDirection ? 'needed' : 'none'
                if (!hasDirection) {
                  sets.status = 'blocked'
                  sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
                }
              } else if (current.monitorResumeState === 'claimed' || current.workerControlState !== 'none' || current.monitorClaimToken !== null || current.monitorClaimedAt !== null) {
                clearIdentity()
                sets.monitor_resume_epoch = current.monitorResumeEpoch + 1
                exposeFresh()
              }
            } else if (current.status === 'paused' && identityComplete && current.workerControlState === 'none' && current.monitorResumeState === 'needed') {
              // Already parked by an earlier normal restart; retain the same
              // child for recoverMonitors rather than repeatedly converting it
              // into a fresh claim.
              if (!hasDirection) {
                clearIdentity()
                sets.status = 'blocked'
                sets.monitor_resume_state = 'none'
                sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
              }
            } else if (current.status === 'active' && identityComplete && current.workerControlState === 'none' && current.monitorResumeState !== 'claimed' && !hasNonTerminalMonitorEvent) {
              // Only this normal-restart shape may keep the same child.
              if (hasDirection) {
                sets.status = 'paused'
                sets.monitor_resume_state = 'needed'
                sets.monitor_resume_epoch = current.monitorResumeEpoch + 1
                sets.monitor_claim_token = null
                sets.monitor_claimed_at = null
              } else {
                clearIdentity()
                sets.status = 'blocked'
                sets.monitor_resume_state = 'none'
                sets.blocked_reason = '服务重启时监控方向缺失，目前未监控'
              }
            } else {
              // Direction switch, fresh claim, resume claim, or a partial
              // identity is uncertain after process loss: clear it and expose
              // exactly one fresh-needed path.
              clearIdentity()
              sets.monitor_resume_epoch = current.monitorResumeEpoch + 1
              exposeFresh()
            }
          } else if (identityPresent || current.workerControlState !== 'none' || current.monitorResumeState !== 'none') {
            // Open monitor with no durable desired state is not runnable.
            clearIdentity()
            sets.monitor_resume_state = 'none'
          }
        } else if (current.status === 'pending' || current.status === 'active') {
          if (current.workerSessionId === null) {
            sets.status = 'blocked'
            sets.blocked_reason = '服务重启时后台启动结果不确定'
            sets.next_action = '等待用户决定是否重试'
          } else {
            sets.status = 'paused'
            sets.next_action = '服务重启后等待用户明确恢复'
          }
        }
        if (current.kind !== 'monitor' && current.workerControlState !== 'none') sets.worker_control_state = 'none'
        if (Object.keys(sets).length === 0) continue
        const sql = AssistantStore.updateSql({ id: current.id, expectedRevision: current.revision, sets })
        tx.prepare(sql.sql).run(...sql.params)
        changed = true
      }
      if (!changed) {
        tx.exec('ROLLBACK')
        return
      }
      tx.exec('COMMIT')
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  // ── reminders ────────────────────────────────────────────────────────────

  /**
   * Queue one deterministic reminder outbox row for a due active commitment,
   * atomically with clearing its dueAt. Duplicate scans are no-ops.
   */
  queueDueReminder(
    now: string,
    lateAfterMs: number,
    render: (kind: 'check_in' | 'missed_check_in', row: CommitmentRow) => string,
  ): { inserted: boolean; outboxId?: string; kind?: 'check_in' | 'missed_check_in' } {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const raw = tx.prepare(
        `SELECT ${COMMITMENT_COLUMNS} FROM commitments
         WHERE kind = 'focus' AND status = 'active' AND reminder_state = 'scheduled'
           AND reminder_due_at IS NOT NULL AND reminder_due_at <= ?
         ORDER BY reminder_due_at, id LIMIT 1`,
      ).get(now) as RawRow | undefined
      const current = raw === undefined ? undefined : mapCommitment(raw)
      if (
        current === undefined
        || current.workOwner !== 'user'
        || current.status !== 'active'
        || current.reminderState !== 'scheduled'
        || current.reminderDueAt === null
        || Date.parse(current.reminderDueAt) > Date.parse(now)
      ) {
        tx.exec('ROLLBACK')
        return { inserted: false }
      }
      const overdueMs = Date.parse(now) - Date.parse(current.reminderDueAt)
      const kind: 'check_in' | 'missed_check_in' = overdueMs > lateAfterMs ? 'missed_check_in' : 'check_in'
      const outboxId = `check-in:${current.id}:${current.reminderDueAt}`
      const text = render(kind, current)
      const result = tx.prepare(`
        INSERT OR IGNORE INTO outbox (id, commitment_id, kind, text, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(outboxId, current.id, kind, boundText(text), now)
      if (result.changes === 0) {
        // Already queued by another poller/process: no-op, do not double-queue.
        tx.exec('ROLLBACK')
        return { inserted: false }
      }
      const sql = AssistantStore.updateSql({
        id: current.id,
        expectedRevision: current.revision,
        sets: { reminder_due_at: null, reminder_state: 'queued' },
      })
      tx.prepare(sql.sql).run(...sql.params)
      tx.exec('COMMIT')
      return { inserted: true, outboxId, kind }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  /** Queue every due focus reminder in deterministic order, bounded per scan. */
  queueDueReminders(
    now: string,
    lateAfterMs: number,
    render: (kind: 'check_in' | 'missed_check_in', row: CommitmentRow) => string,
    limit = 100,
  ): number {
    let queued = 0
    while (queued < limit) {
      const result = this.queueDueReminder(now, lateAfterMs, render)
      if (!result.inserted) break
      queued++
    }
    return queued
  }

  // ── outbox ───────────────────────────────────────────────────────────────

  /** Insert one outbox row; duplicate ids are no-ops. */
  insertOutbox(row: {
    id: string
    commitmentId: string
    kind: OutboxKind
    text: string
    createdAt: string
  }): boolean {
    if (row.kind === 'monitor_event') throw new Error('monitor_event rows must be created by settleMonitorEvent')
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO outbox (id, commitment_id, kind, text, state, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(row.id, row.commitmentId, row.kind, boundText(row.text), row.createdAt)
    return result.changes > 0
  }

  /**
   * Claim one pending outbox row before any HTTP side effect. A check-in row
   * whose commitment is no longer active is cancelled instead of sent.
   */
  claimOutbox(
    id: string,
    now: string,
  ): { ok: true; outbox: OutboxRow } | { ok: false; code: 'missing' | 'not_pending' | 'cancelled' } {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const outbox = this.getOutbox(id)
      if (outbox === undefined) {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'missing' }
      }
      if (outbox.state !== 'pending') {
        tx.exec('ROLLBACK')
        return { ok: false, code: 'not_pending' }
      }
      if (outbox.kind === 'check_in' || outbox.kind === 'missed_check_in') {
        const commitment = this.selectCurrentById(tx, outbox.commitmentId)
        if (commitment === undefined || commitment.status !== 'active') {
          tx.prepare("UPDATE outbox SET state = 'cancelled' WHERE id = ?").run(id)
          tx.exec('COMMIT')
          return { ok: false, code: 'cancelled' }
        }
      } else if (outbox.kind === 'monitor_event') {
        const commitment = this.selectCurrentById(tx, outbox.commitmentId)
        if (commitment === undefined || commitment.status === 'cancelled' || commitment.monitorDesiredState === 'none') {
          tx.prepare("UPDATE outbox SET state = 'cancelled' WHERE id = ?").run(id)
          tx.exec('COMMIT')
          return { ok: false, code: 'cancelled' }
        }
      }
      const token = randomUUID()
      tx.prepare(`
        UPDATE outbox SET state = 'claimed', claim_token = ?, claimed_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(token, now, id)
      const claimed = this.getOutbox(id)!
      tx.exec('COMMIT')
      return { ok: true, outbox: claimed }
    } catch (error: unknown) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  /** Record an outbox terminal state after (or instead of) sending. */
  finishOutbox(
    id: string,
    state: 'delivered' | 'failed' | 'uncertain' | 'cancelled',
    extra: { deliveredAt?: string; error?: string } = {},
  ): void {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      this.finishOutboxInTransaction(tx, id, state, extra)
      tx.exec('COMMIT')
    } catch (error) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  /** Restart catch-up: stale claimed rows are uncertain, never replayed. */
  markStaleClaimed(): number {
    const tx = this.db
    tx.exec('BEGIN IMMEDIATE')
    try {
      const rows = tx.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE state = 'claimed' ORDER BY created_at, id`).all() as RawRow[]
      for (const raw of rows) {
        this.finishOutboxInTransaction(tx, str(raw.id) ?? '', 'uncertain', { error: 'claimed before restart; delivery result unknown' })
      }
      tx.exec('COMMIT')
      return rows.length
    } catch (error) {
      try { tx.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  private finishOutboxInTransaction(
    tx: DatabaseSync,
    id: string,
    state: 'delivered' | 'failed' | 'uncertain' | 'cancelled',
    extra: { deliveredAt?: string; error?: string },
  ): void {
    const raw = tx.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`).get(id) as RawRow | undefined
    if (raw === undefined) return
    const outbox = mapOutbox(raw)
    if (outbox.state === state || ['delivered', 'failed', 'uncertain', 'cancelled'].includes(outbox.state)) return
    tx.prepare(`UPDATE outbox SET state = ?, delivered_at = COALESCE(?, delivered_at), error = COALESCE(?, error) WHERE id = ?`).run(
      state,
      extra.deliveredAt ?? null,
      extra.error === undefined ? null : boundText(extra.error, 2000),
      id,
    )
    if (outbox.kind !== 'monitor_event') return
    const commitment = this.selectCurrentById(tx, outbox.commitmentId)
    if (commitment === undefined) return
    const sets: Record<string, string | number | null> = {}
    if (state === 'delivered' || state === 'failed' || state === 'uncertain') {
      sets.last_delivery_state = state
      sets.last_delivery_error = extra.error === undefined ? null : boundText(extra.error, 2000)
    }
    if (state === 'delivered' && outbox.monitorProposedCheckpoint !== null && commitment.monitorCheckpoint !== outbox.monitorProposedCheckpoint) {
      sets.monitor_checkpoint = outbox.monitorProposedCheckpoint
    }
    if (
      (state === 'delivered' || state === 'failed' || state === 'uncertain')
      && commitment.status === 'active'
      && commitment.monitorDesiredState === 'running'
    ) {
      sets.monitor_resume_state = 'needed'
      sets.monitor_claim_token = null
      sets.monitor_claimed_at = null
    }
    if (Object.keys(sets).length === 0) return
    const sql = AssistantStore.updateSql({ id: commitment.id, expectedRevision: commitment.revision, sets })
    tx.prepare(sql.sql).run(...sql.params)
  }

  /** Surface the latest delivery outcome on the commitment for status views. */
  touchLastDelivery(id: string, state: 'delivered' | 'failed' | 'uncertain', error?: string): void {
    this.db.prepare(`
      UPDATE commitments SET last_delivery_state = ?, last_delivery_error = ?
      WHERE id = ?
    `).run(state, error === undefined ? null : boundText(error, 2000), id)
  }

  /** Cancel pending reminder outbox rows in one transaction (caller holds tx). */
  private cancelReminderState(tx: DatabaseSync, commitmentId: string): void {
    tx.prepare(`
      UPDATE outbox SET state = 'cancelled'
      WHERE commitment_id = ? AND kind IN ('check_in', 'missed_check_in') AND state = 'pending'
    `).run(commitmentId)
    tx.prepare("UPDATE commitments SET reminder_state = 'cancelled', reminder_due_at = NULL WHERE id = ?").run(commitmentId)
  }
}
