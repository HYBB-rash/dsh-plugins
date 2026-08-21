/**
 * Explicit offline migration and reconciliation for the dsh-assistant store.
 *
 * This module intentionally has no dependency on AssistantStore. The running
 * store owns only the v3 schema it opens and its live lifecycle transactions;
 * this module owns the one-way v1/v2-to-v3 copy and the paired, existing-row
 * reconciliation contract.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  validateMonitorCheckpoint,
  validateMonitorDirection,
  validateMonitorEventKey,
  type CommitmentStatus,
  type MonitorDesiredState,
  type MonitorResumeState,
  type OutboxKind,
  type OutboxState,
  type ResponsibilityKind,
  type WorkOwner,
} from './domain.ts'
import {
  ASSISTANT_APPLICATION_ID,
  ASSISTANT_CRON_BINDINGS_SCHEMA_SQL,
  ASSISTANT_SCHEMA_VERSION,
  ASSISTANT_V3_SCHEMA_VERSION,
} from './schema.ts'

const OPEN_SQL = "status IN ('pending','active','paused','blocked')"

const COMMITMENT_COLUMNS = [
  'id', 'kind', 'work_owner', 'status',
  'worker_session_id', 'worker_parent_session_id', 'worker_run_id',
  'worker_control_state', 'monitor_desired_state', 'monitor_resume_state',
  'monitor_resume_epoch', 'monitor_claim_token', 'monitor_claimed_at',
  'monitor_direction', 'monitor_checkpoint', 'revision',
].join(', ')

const OUTBOX_COLUMNS = [
  'id', 'commitment_id', 'kind', 'text', 'state', 'delivered_at',
  'monitor_event_key', 'monitor_proposed_checkpoint',
].join(', ')

type RawRow = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

interface MigrationCommitmentRow {
  readonly id: string
  readonly kind: ResponsibilityKind
  readonly workOwner: WorkOwner
  readonly status: CommitmentStatus
  readonly workerSessionId: string | null
  readonly workerParentSessionId: string | null
  readonly workerRunId: string | null
  readonly workerControlState: string
  readonly monitorDesiredState: MonitorDesiredState
  readonly monitorResumeState: MonitorResumeState
  readonly monitorResumeEpoch: number
  readonly monitorClaimToken: string | null
  readonly monitorClaimedAt: string | null
  readonly monitorDirection: string | null
  readonly monitorCheckpoint: string | null
  readonly revision: number
}

interface MigrationOutboxRow {
  readonly id: string
  readonly commitmentId: string
  readonly kind: OutboxKind
  readonly text: string
  readonly state: OutboxState
  readonly deliveredAt: string | null
  readonly monitorEventKey: string | null
  readonly monitorProposedCheckpoint: string | null
}

function mapCommitment(row: RawRow): MigrationCommitmentRow {
  return {
    id: str(row.id) ?? '',
    kind: (str(row.kind) ?? 'focus') as ResponsibilityKind,
    workOwner: (str(row.work_owner) ?? 'user') as WorkOwner,
    status: (str(row.status) ?? 'pending') as CommitmentStatus,
    workerSessionId: str(row.worker_session_id),
    workerParentSessionId: str(row.worker_parent_session_id),
    workerRunId: str(row.worker_run_id),
    workerControlState: str(row.worker_control_state) ?? 'none',
    monitorDesiredState: (str(row.monitor_desired_state) ?? 'none') as MonitorDesiredState,
    monitorResumeState: (str(row.monitor_resume_state) ?? 'none') as MonitorResumeState,
    monitorResumeEpoch: num(row.monitor_resume_epoch) ?? 0,
    monitorClaimToken: str(row.monitor_claim_token),
    monitorClaimedAt: str(row.monitor_claimed_at),
    monitorDirection: str(row.monitor_direction),
    monitorCheckpoint: str(row.monitor_checkpoint),
    revision: num(row.revision) ?? 0,
  }
}

function mapOutbox(row: RawRow): MigrationOutboxRow {
  return {
    id: str(row.id) ?? '',
    commitmentId: str(row.commitment_id) ?? '',
    kind: (str(row.kind) ?? 'check_in') as OutboxKind,
    text: str(row.text) ?? '',
    state: (str(row.state) ?? 'pending') as OutboxState,
    deliveredAt: str(row.delivered_at),
    monitorEventKey: str(row.monitor_event_key),
    monitorProposedCheckpoint: str(row.monitor_proposed_checkpoint),
  }
}

export interface MigrationResult {
  readonly from: 1 | 2 | 3
  readonly to: 3
  readonly commitments: number
  readonly outbox: number
  readonly webObservations: number
  readonly alreadyAtTarget?: boolean
  readonly reconciledCommitments?: number
  readonly reconciledOutboxEvents?: number
}

export interface ReconciliationCommitmentAssert {
  readonly kind: 'monitor'
  readonly workOwner: 'agent'
  readonly status: 'blocked'
  readonly revision: number
  readonly workerSessionId: null
  readonly workerRunId: null
  readonly workerParentSessionId: null
  readonly workerControlState: 'none'
  readonly monitorDesiredState: 'running'
  readonly monitorResumeState: 'none'
  readonly monitorResumeEpoch: number
  readonly monitorClaimToken: null
  readonly monitorClaimedAt: null
  readonly monitorDirection: string | null
  readonly monitorCheckpoint: string | null
}

export interface ReconciliationOutboxAssert {
  readonly kind: OutboxKind
  readonly state: OutboxState
  readonly textSha256: string
  readonly deliveredAt: string | null
}

/** A paired, existing-row-only recovery; it never creates an outbox row. */
export interface ReconciliationRecovery {
  readonly commitmentId: string
  readonly commitmentAssert: ReconciliationCommitmentAssert
  readonly direction: string
  readonly checkpoint: string
  readonly outboxId: string
  readonly outboxAssert: ReconciliationOutboxAssert
  readonly event: Readonly<{ readonly eventKey: string; readonly checkpoint: string }>
}

export interface ReconciliationManifest {
  readonly version: 1
  readonly recoveries: readonly ReconciliationRecovery[]
}

export interface MigrationOptions {
  readonly monitorId?: string
  readonly manifest?: ReconciliationManifest
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS hit FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

/** Build isolated v3 tables while the old schema remains untouched. */
function createV3MigrationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE commitments_v3 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('focus','delegated','monitor')),
      title TEXT NOT NULL, work_owner TEXT NOT NULL CHECK (work_owner IN ('user','agent')),
      status TEXT NOT NULL CHECK (status IN ('pending','active','paused','blocked','completed','cancelled')),
      next_action TEXT, accepted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, result TEXT, blocked_reason TEXT,
      check_in_minutes INTEGER, reminder_due_at TEXT, reminder_state TEXT NOT NULL,
      last_delivery_state TEXT, last_delivery_error TEXT,
      worker_session_id TEXT, worker_parent_session_id TEXT, worker_run_id TEXT,
      worker_control_state TEXT NOT NULL DEFAULT 'none' CHECK (worker_control_state IN ('none','pause_requested','resume_requested')),
      progress_summary TEXT, progress_at TEXT,
      monitor_desired_state TEXT NOT NULL DEFAULT 'none' CHECK (monitor_desired_state IN ('none','running','paused')),
      monitor_resume_state TEXT NOT NULL DEFAULT 'none' CHECK (monitor_resume_state IN ('none','needed','claimed')),
      monitor_resume_epoch INTEGER NOT NULL DEFAULT 0,
      monitor_claim_token TEXT, monitor_claimed_at TEXT,
      monitor_direction TEXT, monitor_checkpoint TEXT,
      source_surface TEXT NOT NULL CHECK (source_surface IN ('web','telegram')),
      source_session_id TEXT, revision INTEGER NOT NULL,
      CHECK ((kind = 'focus' AND work_owner = 'user') OR (kind IN ('delegated','monitor') AND work_owner = 'agent'))
    ) STRICT;
    CREATE TABLE outbox_v3 (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments_v3(id),
      kind TEXT NOT NULL CHECK (kind IN ('check_in','completed','blocked','missed_check_in','progress','monitor_event')),
      text TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','uncertain','cancelled')),
      created_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT, delivered_at TEXT, error TEXT,
      monitor_event_key TEXT, monitor_proposed_checkpoint TEXT,
      CHECK ((kind = 'monitor_event' AND monitor_event_key IS NOT NULL AND monitor_proposed_checkpoint IS NOT NULL)
        OR (kind <> 'monitor_event' AND monitor_event_key IS NULL AND monitor_proposed_checkpoint IS NULL))
    ) STRICT;
    CREATE TABLE web_observations_v3 (
      session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('running','ended','abnormal','interrupted')),
      request_text TEXT, last_assistant_text TEXT, last_assistant_message_id TEXT,
      turn_reason TEXT, error_code TEXT, error_message TEXT, cwd TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      writer_instance_id TEXT NOT NULL, writer_started_at TEXT NOT NULL
    ) STRICT;
  `)
}

function createV3Indexes(db: DatabaseSync): void {
  db.exec(`
    CREATE UNIQUE INDEX commitments_open_focus ON commitments(kind)
      WHERE kind = 'focus' AND ${OPEN_SQL};
    CREATE UNIQUE INDEX commitments_worker_session ON commitments(worker_session_id)
      WHERE worker_session_id IS NOT NULL;
    CREATE UNIQUE INDEX outbox_monitor_event_unique
      ON outbox(commitment_id, monitor_event_key) WHERE kind = 'monitor_event';
  `)
}

function assertV3Schema(db: DatabaseSync, path: string): void {
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
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validateManifest(manifest: ReconciliationManifest | undefined): void {
  if (manifest === undefined) return
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1) throw new Error('reconciliation manifest version must be exactly 1')
  if (!Array.isArray(manifest.recoveries)) throw new Error('reconciliation manifest requires a recoveries array')
  const allowedManifestKeys = new Set(['version', 'recoveries'])
  for (const key of Object.keys(manifest as unknown as Record<string, unknown>)) {
    if (!allowedManifestKeys.has(key)) throw new Error(`unknown reconciliation manifest field "${key}"`)
  }
  const seenCommitments = new Set<string>()
  const seenOutbox = new Set<string>()
  const commitmentKeys = ['kind', 'workOwner', 'status', 'revision', 'workerSessionId', 'workerRunId', 'workerParentSessionId', 'workerControlState', 'monitorDesiredState', 'monitorResumeState', 'monitorResumeEpoch', 'monitorClaimToken', 'monitorClaimedAt', 'monitorDirection', 'monitorCheckpoint']
  const outboxKeys = ['kind', 'state', 'textSha256', 'deliveredAt']
  for (const item of manifest.recoveries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('reconciliation recovery must be an object')
    const recovery = item as unknown as Record<string, unknown>
    const requiredRecoveryKeys = ['commitmentId', 'commitmentAssert', 'direction', 'checkpoint', 'outboxId', 'outboxAssert', 'event']
    const allowedRecoveryKeys = new Set(requiredRecoveryKeys)
    for (const key of Object.keys(recovery)) if (!allowedRecoveryKeys.has(key)) throw new Error(`unknown reconciliation recovery field "${key}"`)
    for (const key of requiredRecoveryKeys) if (!(key in recovery)) throw new Error(`reconciliation recovery is missing "${key}"`)
    if (typeof item.commitmentId !== 'string' || item.commitmentId.trim() === '' || item.commitmentId !== item.commitmentId.trim()) throw new Error('reconciliation commitmentId must be a trimmed non-empty id')
    if (seenCommitments.has(item.commitmentId)) throw new Error(`reconciliation commitment "${item.commitmentId}" is repeated`)
    seenCommitments.add(item.commitmentId)
    if (typeof item.outboxId !== 'string' || item.outboxId.trim() === '' || item.outboxId !== item.outboxId.trim()) throw new Error('reconciliation outboxId must be a trimmed non-empty id')
    if (seenOutbox.has(item.outboxId)) throw new Error(`reconciliation outbox "${item.outboxId}" is repeated`)
    seenOutbox.add(item.outboxId)
    if (item.commitmentAssert === null || typeof item.commitmentAssert !== 'object' || Array.isArray(item.commitmentAssert)) throw new Error(`reconciliation commitment "${item.commitmentId}" requires exact assertions`)
    for (const key of Object.keys(item.commitmentAssert)) if (!commitmentKeys.includes(key)) throw new Error(`unknown reconciliation commitment assertion "${key}"`)
    for (const key of commitmentKeys) if (!(key in item.commitmentAssert)) throw new Error(`reconciliation commitment "${item.commitmentId}" is missing assertion "${key}"`)
    if (item.commitmentAssert.kind !== 'monitor') throw new Error(`reconciliation commitment "${item.commitmentId}" must be a monitor`)
    if (item.commitmentAssert.workOwner !== 'agent') throw new Error(`reconciliation commitment "${item.commitmentId}" must be Agent-owned`)
    if (item.commitmentAssert.status !== 'blocked') throw new Error(`reconciliation commitment "${item.commitmentId}" must assert blocked status`)
    if (!Number.isSafeInteger(item.commitmentAssert.revision) || item.commitmentAssert.revision < 0) throw new Error(`reconciliation commitment "${item.commitmentId}" revision must be a safe integer`)
    if (item.commitmentAssert.monitorDesiredState !== 'running') throw new Error(`reconciliation commitment "${item.commitmentId}" must assert running desired state`)
    if (item.commitmentAssert.monitorResumeState !== 'none') throw new Error(`reconciliation commitment "${item.commitmentId}" must assert no pending resume`)
    if (!Number.isSafeInteger(item.commitmentAssert.monitorResumeEpoch) || item.commitmentAssert.monitorResumeEpoch < 0) throw new Error(`reconciliation commitment "${item.commitmentId}" epoch must be a non-negative safe integer`)
    if (item.commitmentAssert.workerSessionId !== null || item.commitmentAssert.workerRunId !== null || item.commitmentAssert.workerParentSessionId !== null || item.commitmentAssert.workerControlState !== 'none' || item.commitmentAssert.monitorClaimToken !== null || item.commitmentAssert.monitorClaimedAt !== null) {
      throw new Error(`reconciliation commitment "${item.commitmentId}" must assert an unbound worker and empty claim`)
    }
    if (item.commitmentAssert.monitorDirection !== null) {
      const oldDirectionError = validateMonitorDirection(item.commitmentAssert.monitorDirection)
      if (oldDirectionError !== undefined) throw new Error(oldDirectionError)
    }
    if (item.commitmentAssert.monitorCheckpoint !== null) {
      const oldCheckpointError = validateMonitorCheckpoint(item.commitmentAssert.monitorCheckpoint)
      if (oldCheckpointError !== undefined) throw new Error(oldCheckpointError)
    }
    const directionError = validateMonitorDirection(item.direction)
    if (directionError !== undefined) throw new Error(directionError)
    const checkpointError = validateMonitorCheckpoint(item.checkpoint)
    if (checkpointError !== undefined) throw new Error(checkpointError)
    if (item.outboxAssert === null || typeof item.outboxAssert !== 'object' || Array.isArray(item.outboxAssert)) throw new Error(`reconciliation outbox "${item.outboxId}" requires exact assertions`)
    for (const key of Object.keys(item.outboxAssert)) if (!outboxKeys.includes(key)) throw new Error(`unknown reconciliation outbox assertion "${key}"`)
    for (const key of outboxKeys) if (!(key in item.outboxAssert)) throw new Error(`reconciliation outbox "${item.outboxId}" is missing assertion "${key}"`)
    if (!isSha256(item.outboxAssert.textSha256)) throw new Error(`reconciliation outbox "${item.outboxId}" textSha256 must be lowercase SHA-256`)
    if (!['check_in', 'completed', 'blocked', 'missed_check_in', 'progress'].includes(item.outboxAssert.kind)) throw new Error(`reconciliation outbox "${item.outboxId}" must be an existing non-monitor row`)
    // Reconciliation is intentionally limited to a historical delivered row;
    // it cannot invent or take ownership of an in-flight send.
    if (item.outboxAssert.state !== 'delivered') throw new Error(`reconciliation outbox "${item.outboxId}" must assert delivered state`)
    if (item.outboxAssert.deliveredAt !== null && typeof item.outboxAssert.deliveredAt !== 'string') throw new Error(`reconciliation outbox "${item.outboxId}" deliveredAt must be a string or null`)
    if (item.event === null || typeof item.event !== 'object' || Array.isArray(item.event)) throw new Error(`reconciliation outbox "${item.outboxId}" requires an event target`)
    const eventKeys = Object.keys(item.event)
    if (eventKeys.some(key => key !== 'eventKey' && key !== 'checkpoint') || eventKeys.length !== 2) throw new Error(`reconciliation outbox "${item.outboxId}" event must contain only eventKey and checkpoint`)
    const keyError = validateMonitorEventKey(item.event.eventKey)
    if (keyError !== undefined) throw new Error(keyError)
    const proposedError = validateMonitorCheckpoint(item.event.checkpoint)
    if (proposedError !== undefined) throw new Error(proposedError)
    if (item.checkpoint.trim() !== item.event.checkpoint.trim()) throw new Error(`reconciliation outbox "${item.outboxId}" event checkpoint must equal the confirmed checkpoint`)
  }
}

function assertManifestCommitmentPrecondition(current: MigrationCommitmentRow, expected: ReconciliationCommitmentAssert, id: string): void {
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    ['kind', current.kind, expected.kind],
    ['workOwner', current.workOwner, expected.workOwner],
    ['status', current.status, expected.status],
    ['revision', current.revision, expected.revision],
    ['workerSessionId', current.workerSessionId, expected.workerSessionId],
    ['workerRunId', current.workerRunId, expected.workerRunId],
    ['workerParentSessionId', current.workerParentSessionId, expected.workerParentSessionId],
    ['workerControlState', current.workerControlState, expected.workerControlState],
    ['monitorDesiredState', current.monitorDesiredState, expected.monitorDesiredState],
    ['monitorResumeState', current.monitorResumeState, expected.monitorResumeState],
    ['monitorResumeEpoch', current.monitorResumeEpoch, expected.monitorResumeEpoch],
    ['monitorClaimToken', current.monitorClaimToken, expected.monitorClaimToken],
    ['monitorClaimedAt', current.monitorClaimedAt, expected.monitorClaimedAt],
    ['monitorDirection', current.monitorDirection, expected.monitorDirection],
    ['monitorCheckpoint', current.monitorCheckpoint, expected.monitorCheckpoint],
  ]
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) throw new Error(`reconciliation assertion mismatch for commitment "${id}" field "${field}"`)
  }
}

function applyManifestCommitmentUpdate(db: DatabaseSync, current: MigrationCommitmentRow, item: ReconciliationRecovery): void {
  const result = db.prepare(`
    UPDATE commitments SET
      monitor_direction = ?, monitor_checkpoint = ?,
      status = 'active', monitor_desired_state = 'running', monitor_resume_state = 'needed',
      monitor_resume_epoch = ?, worker_control_state = 'none',
      monitor_claim_token = NULL, monitor_claimed_at = NULL,
      updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?
  `).run(
    item.direction.trim(), item.checkpoint.trim(), current.monitorResumeEpoch + 1,
    new Date().toISOString(), item.commitmentId, current.revision,
  )
  if (result.changes !== 1) throw new Error(`reconciliation commitment "${item.commitmentId}" changed during migration`)
}

function applyManifest(db: DatabaseSync, manifest: ReconciliationManifest | undefined): { commitments: number; outboxEvents: number } {
  validateManifest(manifest)
  if (manifest === undefined) return { commitments: 0, outboxEvents: 0 }
  type Plan = {
    readonly item: ReconciliationRecovery
    readonly current: MigrationCommitmentRow
    readonly outbox: MigrationOutboxRow
  }
  const plans: Plan[] = []
  let preCount = 0
  let postCount = 0
  for (const item of manifest.recoveries) {
    const raw = db.prepare(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE id = ?`).get(item.commitmentId) as RawRow | undefined
    if (raw === undefined) throw new Error(`reconciliation commitment "${item.commitmentId}" does not exist`)
    const current = mapCommitment(raw)
    const outboxRaw = db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`).get(item.outboxId) as RawRow | undefined
    if (outboxRaw === undefined) throw new Error(`reconciliation outbox "${item.outboxId}" does not exist`)
    const outbox = mapOutbox(outboxRaw)
    const targetKey = item.event.eventKey.trim()
    const targetCheckpoint = item.event.checkpoint.trim()
    const commitmentPost = current.revision === item.commitmentAssert.revision + 1
      && current.monitorDirection === item.direction.trim()
      && current.monitorCheckpoint === item.checkpoint.trim()
      && current.status === 'active'
      && current.monitorDesiredState === 'running'
      && current.monitorResumeState === 'needed'
      && current.workerSessionId === null
      && current.workerRunId === null
      && current.workerParentSessionId === null
      && current.workerControlState === 'none'
      && current.monitorResumeEpoch === item.commitmentAssert.monitorResumeEpoch + 1
      && current.monitorClaimToken === null
      && current.monitorClaimedAt === null
    const outboxPost = outbox.commitmentId === item.commitmentId
      && outbox.kind === 'monitor_event'
      && outbox.state === item.outboxAssert.state
      && outbox.deliveredAt === item.outboxAssert.deliveredAt
      && outbox.monitorEventKey === targetKey
      && outbox.monitorProposedCheckpoint === targetCheckpoint
      && createHash('sha256').update(outbox.text).digest('hex') === item.outboxAssert.textSha256
    if (commitmentPost && outboxPost) postCount++
    else {
      preCount++
      assertManifestCommitmentPrecondition(current, item.commitmentAssert, item.commitmentId)
      if (outbox.commitmentId !== item.commitmentId) throw new Error(`reconciliation outbox "${item.outboxId}" has the wrong commitment`)
      if (outbox.kind !== item.outboxAssert.kind || outbox.state !== item.outboxAssert.state || createHash('sha256').update(outbox.text).digest('hex') !== item.outboxAssert.textSha256 || outbox.deliveredAt !== item.outboxAssert.deliveredAt) {
        throw new Error(`reconciliation outbox assertion mismatch for "${item.outboxId}"`)
      }
    }
    plans.push({ item, current, outbox })
  }
  if (preCount !== 0 && postCount !== 0) throw new Error('reconciliation manifest mixes pre-state and post-state rows')
  if (postCount !== 0) return { commitments: 0, outboxEvents: 0 }
  for (const plan of plans) {
    const { item, current, outbox } = plan
    applyManifestCommitmentUpdate(db, current, item)
    db.prepare(`UPDATE outbox SET kind = 'monitor_event', monitor_event_key = ?, monitor_proposed_checkpoint = ? WHERE id = ?`).run(item.event.eventKey.trim(), item.event.checkpoint.trim(), outbox.id)
  }
  return { commitments: plans.length, outboxEvents: plans.length }
}

function migrateV1ToV3(db: DatabaseSync, options: MigrationOptions): void {
  createV3MigrationTables(db)
  const monitorId = options.monitorId?.trim()
  if (options.monitorId !== undefined && monitorId === '') throw new Error('monitor override commitment id must be non-empty')
  if (monitorId !== undefined) {
    const legacy = db.prepare('SELECT work_owner FROM commitments WHERE id = ?').get(monitorId) as { work_owner: string } | undefined
    if (legacy === undefined) throw new Error(`monitor override commitment "${monitorId}" does not exist in the v1 database`)
    if (legacy.work_owner !== 'agent') throw new Error(`monitor override commitment "${monitorId}" is not Agent-owned`)
  }
  db.exec(`
    INSERT INTO commitments_v3 (
      id, kind, title, work_owner, status, next_action, accepted_at, created_at, updated_at,
      started_at, completed_at, result, blocked_reason, check_in_minutes, reminder_due_at, reminder_state,
      last_delivery_state, last_delivery_error, worker_session_id, worker_parent_session_id, worker_run_id,
      worker_control_state, progress_summary, progress_at, monitor_desired_state, monitor_resume_state,
      monitor_resume_epoch, monitor_claim_token, monitor_claimed_at, monitor_direction, monitor_checkpoint,
      source_surface, source_session_id, revision
    ) SELECT
      id, CASE work_owner WHEN 'user' THEN 'focus' ELSE 'delegated' END,
      title, work_owner, status, next_action, accepted_at, created_at, updated_at,
      started_at, completed_at, result, blocked_reason, check_in_minutes, reminder_due_at, reminder_state,
      last_delivery_state, last_delivery_error, worker_session_id, worker_parent_session_id, worker_run_id,
      worker_control_state, NULL, NULL, 'none', 'none', 0, NULL, NULL, NULL, NULL,
      source_surface, source_session_id, revision
    FROM commitments;
    INSERT INTO outbox_v3 (id, commitment_id, kind, text, state, created_at, claimed_at, claim_token, delivered_at, error, monitor_event_key, monitor_proposed_checkpoint)
      SELECT id, commitment_id, kind, text, state, created_at, claimed_at, claim_token, delivered_at, error, NULL, NULL FROM outbox;
  `)
  if (tableExists(db, 'web_observations')) db.exec(`INSERT INTO web_observations_v3 SELECT * FROM web_observations`)
  if (monitorId !== undefined) {
    const result = db.prepare(`UPDATE commitments_v3 SET kind = 'monitor', monitor_desired_state = 'running', monitor_resume_state = 'needed' WHERE id = ? AND work_owner = 'agent'`).run(monitorId)
    if (result.changes !== 1) throw new Error(`monitor override commitment "${monitorId}" could not be reclassified`)
  }
}

function migrateV2ToV3(db: DatabaseSync): void {
  createV3MigrationTables(db)
  db.exec(`
    INSERT INTO commitments_v3 SELECT id, kind, title, work_owner, status, next_action, accepted_at, created_at, updated_at,
      started_at, completed_at, result, blocked_reason, check_in_minutes, reminder_due_at, reminder_state,
      last_delivery_state, last_delivery_error, worker_session_id, worker_parent_session_id, worker_run_id,
      worker_control_state, progress_summary, progress_at, monitor_desired_state, monitor_resume_state,
      monitor_resume_epoch, monitor_claim_token, monitor_claimed_at, NULL, NULL, source_surface, source_session_id, revision
      FROM commitments;
    INSERT INTO outbox_v3 SELECT id, commitment_id, kind, text, state, created_at, claimed_at, claim_token, delivered_at, error, NULL, NULL FROM outbox;
  `)
  if (tableExists(db, 'web_observations')) db.exec(`INSERT INTO web_observations_v3 SELECT * FROM web_observations`)
}

function finalizeV3Migration(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE outbox;
    DROP TABLE commitments;
    ALTER TABLE commitments_v3 RENAME TO commitments;
    ALTER TABLE outbox_v3 RENAME TO outbox;
    DROP TABLE IF EXISTS web_observations;
    ALTER TABLE web_observations_v3 RENAME TO web_observations;
    PRAGMA user_version = ${ASSISTANT_V3_SCHEMA_VERSION};
  `)
  createV3Indexes(db)
  const violations = db.prepare('PRAGMA foreign_key_check').all()
  if (violations.length !== 0) throw new Error('migration foreign-key verification failed')
}

/**
 * Run one narrow offline operation after bringing a v2 database to v3 in the
 * same immediate transaction, or after asserting an existing v3 database.
 * Callers own their operation-specific preconditions and writes.
 */
type OfflineCommitmentSet = string | number | null

export interface OfflineV2OrV3Transaction {
  readonly getCommitment: (id: string) => Readonly<Record<string, unknown>> | undefined
  readonly listOutboxColumns: () => readonly Readonly<Record<string, unknown>>[]
  readonly listCommitmentOutbox: (commitmentId: string) => readonly Readonly<Record<string, unknown>>[]
  readonly updateCommitmentAtRevision: (id: string, expectedRevision: number, sets: Readonly<Record<string, OfflineCommitmentSet>>) => boolean
}

const OFFLINE_COMMITMENT_SET_COLUMNS = new Set([
  'status', 'next_action', 'updated_at', 'completed_at', 'result', 'blocked_reason', 'last_delivery_state', 'last_delivery_error',
  'worker_session_id', 'worker_parent_session_id', 'worker_run_id', 'worker_control_state', 'progress_summary', 'progress_at',
  'monitor_desired_state', 'monitor_resume_state', 'monitor_resume_epoch', 'monitor_claim_token', 'monitor_claimed_at',
  'monitor_direction', 'monitor_checkpoint', 'revision',
])

function offlineTransactionFacade(db: DatabaseSync): OfflineV2OrV3Transaction {
  return {
    getCommitment: id => db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as Readonly<Record<string, unknown>> | undefined,
    listOutboxColumns: () => db.prepare("PRAGMA table_xinfo('outbox')").all() as readonly Readonly<Record<string, unknown>>[],
    listCommitmentOutbox: commitmentId => db.prepare(`SELECT id, commitment_id, kind, CAST(text AS BLOB) AS text_bytes, state, created_at, claimed_at, claim_token, delivered_at, error, monitor_event_key, monitor_proposed_checkpoint FROM outbox WHERE commitment_id = ? ORDER BY id`).all(commitmentId) as readonly Readonly<Record<string, unknown>>[],
    updateCommitmentAtRevision: (id, expectedRevision, sets) => {
      const fields = Object.keys(sets)
      if (fields.length === 0 || fields.some(field => !OFFLINE_COMMITMENT_SET_COLUMNS.has(field))) throw new Error('offline transaction received unsupported commitment fields')
      const result = db.prepare(`UPDATE commitments SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ? AND revision = ?`).run(...fields.map(field => sets[field]!), id, expectedRevision)
      return result.changes === 1
    },
  }
}

export function runOfflineV2OrV3Transaction<T>(
  path: string,
  operation: (transaction: OfflineV2OrV3Transaction, sourceVersion: 2 | 3) => T,
): { readonly sourceVersion: 2 | 3; readonly value: T } {
  const db = new DatabaseSync(path)
  let began = false
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: appId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (appId !== ASSISTANT_APPLICATION_ID) throw new Error(`expected dsh-assistant application id ${ASSISTANT_APPLICATION_ID}; found ${appId}`)
    if (version !== 2 && version !== ASSISTANT_V3_SCHEMA_VERSION) throw new Error(`offline operation requires schema v2 or v3 at "${path}"; found version ${version}`)
    if (version === 2) {
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec('BEGIN IMMEDIATE')
      began = true
      migrateV2ToV3(db)
      finalizeV3Migration(db)
    } else {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('BEGIN IMMEDIATE')
      began = true
      assertV3Schema(db, path)
    }
    const value = operation(offlineTransactionFacade(db), version as 2 | 3)
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrity.integrity_check !== 'ok') throw new Error(`offline operation integrity check failed: ${integrity.integrity_check}`)
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('offline operation foreign-key verification failed')
    db.exec('COMMIT')
    began = false
    return { sourceVersion: version as 2 | 3, value }
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    }
    throw error
  } finally {
    db.close()
  }
}

/** Migrate a v1 or v2 database to v3, optionally applying a precise manifest. */
export function migrateDatabaseToV3(path: string, options: MigrationOptions = {}): MigrationResult {
  const db = new DatabaseSync(path)
  let began = false
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: appId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (appId !== ASSISTANT_APPLICATION_ID) throw new Error(`expected dsh-assistant application id ${ASSISTANT_APPLICATION_ID}; found ${appId}`)
    if (version !== 1 && options.monitorId !== undefined) {
      throw new Error(`--monitor-id is only valid for v1 migration; schema v${version} requires an exact v3 direction/recovery manifest`)
    }
    if (version === ASSISTANT_V3_SCHEMA_VERSION) {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('BEGIN IMMEDIATE')
      began = true
      assertV3Schema(db, path)
      const before = {
        commitments: rowCount(db, 'commitments'),
        outbox: rowCount(db, 'outbox'),
        webObservations: tableExists(db, 'web_observations') ? rowCount(db, 'web_observations') : 0,
      }
      const reconciled = applyManifest(db, options.manifest)
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (integrity.integrity_check !== 'ok') throw new Error(`v3 integrity check failed: ${integrity.integrity_check}`)
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('v3 foreign-key verification failed')
      const after = {
        commitments: rowCount(db, 'commitments'),
        outbox: rowCount(db, 'outbox'),
        webObservations: tableExists(db, 'web_observations') ? rowCount(db, 'web_observations') : 0,
      }
      if (after.commitments !== before.commitments || after.outbox !== before.outbox || after.webObservations !== before.webObservations) throw new Error('reconciliation changed row counts')
      db.exec('COMMIT')
      began = false
      return {
        from: 3, to: 3, alreadyAtTarget: true,
        commitments: after.commitments, outbox: after.outbox, webObservations: after.webObservations,
        reconciledCommitments: reconciled.commitments, reconciledOutboxEvents: reconciled.outboxEvents,
      }
    }
    if (version !== 1 && version !== 2) throw new Error(`expected dsh-assistant schema v1 or v2 at "${path}"; found version ${version}`)
    const before = {
      commitments: rowCount(db, 'commitments'),
      outbox: rowCount(db, 'outbox'),
      webObservations: tableExists(db, 'web_observations') ? rowCount(db, 'web_observations') : 0,
    }
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    began = true
    if (version === 1) migrateV1ToV3(db, options)
    else migrateV2ToV3(db)
    finalizeV3Migration(db)
    const reconciled = applyManifest(db, options.manifest)
    const counts = {
      commitments: rowCount(db, 'commitments'), outbox: rowCount(db, 'outbox'),
      webObservations: tableExists(db, 'web_observations') ? rowCount(db, 'web_observations') : 0,
    }
    if (counts.commitments !== before.commitments || counts.outbox !== before.outbox || counts.webObservations !== before.webObservations) {
      throw new Error('migration row-count verification failed')
    }
    db.exec('COMMIT')
    began = false
    return { from: version, to: 3, ...counts, reconciledCommitments: reconciled.commitments, reconciledOutboxEvents: reconciled.outboxEvents }
  } catch (error) {
    if (began) {
      try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    }
    throw error
  } finally {
    db.close()
  }
}

export interface MigrationV4Result {
  readonly from: 3 | 4
  readonly to: 4
  readonly bindings: number
  readonly alreadyAtTarget?: boolean
}

function assertV4BindingTable(db: DatabaseSync, path: string): void {
  if (!tableExists(db, 'assistant_cron_bindings')) {
    throw new Error(`assistant database at "${path}" is missing assistant_cron_bindings`)
  }
  const required = new Set([
    'commitment_id', 'external_ref', 'desired_schedule_json', 'desired_cwd', 'desired_state',
    'bound_job_id', 'last_run_id', 'last_run_job_id', 'scheduled_for', 'finished_at', 'run_status',
    'last_run_summary', 'run_error', 'delivery_state', 'delivery_error', 'control_error', 'created_at', 'updated_at',
  ])
  const actual = new Set((db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings')").all() as RawRow[])
    .map(row => str(row.name)).filter((name): name is string => name !== null))
  for (const column of required) {
    if (!actual.has(column)) throw new Error(`assistant database at "${path}" is missing assistant_cron_bindings.${column}`)
  }
}

/**
 * Upgrade an explicitly stopped v3 database to the v4 Cron binding
 * projection.  This is intentionally offline-only: the online store rejects
 * v3 and this function never guesses or creates bindings from old monitors.
 */
export function migrateDatabaseToV4(path: string, options: { readonly now?: string } = {}): MigrationV4Result {
  void options
  const db = new DatabaseSync(path)
  let began = false
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: appId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (appId !== ASSISTANT_APPLICATION_ID) {
      throw new Error(`expected dsh-assistant application id ${ASSISTANT_APPLICATION_ID}; found ${appId}`)
    }
    if (version === ASSISTANT_SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE')
      began = true
      assertV4BindingTable(db, path)
      const bindings = rowCount(db, 'assistant_cron_bindings')
      db.exec('COMMIT')
      began = false
      return { from: 4, to: 4, bindings, alreadyAtTarget: true }
    }
    if (version !== ASSISTANT_V3_SCHEMA_VERSION) {
      throw new Error(`expected dsh-assistant schema v3 for offline v3 -> v4 migration at "${path}"; found version ${version}`)
    }
    db.exec('BEGIN IMMEDIATE')
    began = true
    assertV3Schema(db, path)
    db.exec(ASSISTANT_CRON_BINDINGS_SCHEMA_SQL)
    db.exec(`PRAGMA user_version = ${ASSISTANT_SCHEMA_VERSION}`)
    assertV4BindingTable(db, path)
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrity.integrity_check !== 'ok') throw new Error(`v4 integrity check failed: ${integrity.integrity_check}`)
    db.exec('COMMIT')
    began = false
    return { from: 3, to: 4, bindings: 0 }
  } catch (error: unknown) {
    if (began) {
      try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    }
    throw error
  } finally {
    db.close()
  }
}
