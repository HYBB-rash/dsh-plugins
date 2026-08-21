/** Exact offline recovery for one historical monitor; never a runtime API. */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { validateMonitorCheckpoint, validateMonitorDirection } from './domain.ts'
import { runOfflineV2OrV3Transaction, type OfflineV2OrV3Transaction } from './migration.ts'

type RawRow = Record<string, unknown>

export interface HistoricalMonitorRecoveryPlanV1 {
  readonly version: 1
  readonly commitmentOutboxSet: HistoricalCommitmentOutboxSetV1
  readonly commitment: HistoricalCommitmentSnapshotV1
  readonly deliveredOutboxOne: HistoricalDeliveredOutboxSnapshotV1
  readonly deliveredOutboxTwo: HistoricalDeliveredOutboxSnapshotV1
  readonly direction: string
  readonly checkpoint: string
  readonly updatedAt: string
}

export interface HistoricalCommitmentOutboxSetV1 {
  readonly count: number
  readonly canonicalSha256: string
  readonly rawTextBundleSha256: string
}

export interface HistoricalCommitmentSnapshotV1 {
  readonly id: string; readonly kind: 'monitor'; readonly title: string; readonly workOwner: 'agent'; readonly status: 'blocked'; readonly nextAction: string | null
  readonly acceptedAt: string; readonly createdAt: string; readonly updatedAt: string; readonly startedAt: string | null; readonly completedAt: string | null
  readonly result: string | null; readonly blockedReason: string | null; readonly checkInMinutes: number | null; readonly reminderDueAt: string | null; readonly reminderState: string
  readonly lastDeliveryState: string | null; readonly lastDeliveryError: string | null; readonly workerSessionId: string; readonly workerParentSessionId: string; readonly workerRunId: string
  readonly workerControlState: 'none'; readonly progressSummary: string | null; readonly progressAt: string | null; readonly monitorDesiredState: 'running'; readonly monitorResumeState: 'none'
  readonly monitorResumeEpoch: number; readonly monitorClaimToken: null; readonly monitorClaimedAt: null; readonly monitorDirection: null; readonly monitorCheckpoint: null
  readonly sourceSurface: 'web' | 'telegram'; readonly sourceSessionId: string | null; readonly revision: number
}

export interface HistoricalDeliveredOutboxSnapshotV1 {
  readonly id: string; readonly commitmentId: string; readonly kind: 'check_in' | 'completed' | 'blocked' | 'missed_check_in' | 'progress'
  readonly textByteLength: number; readonly textSha256: string; readonly state: 'delivered'; readonly createdAt: string; readonly claimedAt: string | null; readonly claimToken: string | null
  readonly deliveredAt: string; readonly error: string | null; readonly monitorEventKey: null; readonly monitorProposedCheckpoint: null
}

export interface HistoricalMonitorRecoveryResult { readonly sourceVersion: 2 | 3; readonly applied: boolean; readonly noop: boolean }

interface CommitmentRow {
  readonly id: string; readonly kind: string; readonly title: string; readonly workOwner: string; readonly status: string; readonly nextAction: string | null
  readonly acceptedAt: string; readonly createdAt: string; readonly updatedAt: string; readonly startedAt: string | null; readonly completedAt: string | null
  readonly result: string | null; readonly blockedReason: string | null; readonly checkInMinutes: number | null; readonly reminderDueAt: string | null; readonly reminderState: string
  readonly lastDeliveryState: string | null; readonly lastDeliveryError: string | null; readonly workerSessionId: string | null; readonly workerParentSessionId: string | null; readonly workerRunId: string | null
  readonly workerControlState: string; readonly progressSummary: string | null; readonly progressAt: string | null; readonly monitorDesiredState: string; readonly monitorResumeState: string
  readonly monitorResumeEpoch: number; readonly monitorClaimToken: string | null; readonly monitorClaimedAt: string | null; readonly monitorDirection: string | null; readonly monitorCheckpoint: string | null
  readonly sourceSurface: string; readonly sourceSessionId: string | null; readonly revision: number
}

interface OutboxRow {
  readonly id: string; readonly commitmentId: string; readonly kind: string; readonly textBytes: Uint8Array; readonly state: string; readonly createdAt: string
  readonly claimedAt: string | null; readonly claimToken: string | null; readonly deliveredAt: string | null; readonly error: string | null
  readonly monitorEventKey: string | null; readonly monitorProposedCheckpoint: string | null
}

const COMMITMENT_KEYS = ['id', 'kind', 'title', 'workOwner', 'status', 'nextAction', 'acceptedAt', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'result', 'blockedReason', 'checkInMinutes', 'reminderDueAt', 'reminderState', 'lastDeliveryState', 'lastDeliveryError', 'workerSessionId', 'workerParentSessionId', 'workerRunId', 'workerControlState', 'progressSummary', 'progressAt', 'monitorDesiredState', 'monitorResumeState', 'monitorResumeEpoch', 'monitorClaimToken', 'monitorClaimedAt', 'monitorDirection', 'monitorCheckpoint', 'sourceSurface', 'sourceSessionId', 'revision'] as const
type CommitmentExpectation = { readonly [Key in (typeof COMMITMENT_KEYS)[number]]: CommitmentRow[Key] }
const OUTBOX_KEYS = ['id', 'commitmentId', 'kind', 'textByteLength', 'textSha256', 'state', 'createdAt', 'claimedAt', 'claimToken', 'deliveredAt', 'error', 'monitorEventKey', 'monitorProposedCheckpoint'] as const
const OUTBOX_SET_KEYS = ['count', 'canonicalSha256', 'rawTextBundleSha256'] as const
const OUTBOX_ROW_PROJECTION_KEYS = ['id', 'commitment_id', 'kind', 'text_bytes', 'state', 'created_at', 'claimed_at', 'claim_token', 'delivered_at', 'error', 'monitor_event_key', 'monitor_proposed_checkpoint'] as const
const OUTBOX_SCHEMA_KEYS = ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'hidden'] as const
const EXPECTED_OUTBOX_SCHEMA = [
  [0, 'id', 'TEXT', 1, null, 1, 0],
  [1, 'commitment_id', 'TEXT', 1, null, 0, 0],
  [2, 'kind', 'TEXT', 1, null, 0, 0],
  [3, 'text', 'TEXT', 1, null, 0, 0],
  [4, 'state', 'TEXT', 1, null, 0, 0],
  [5, 'created_at', 'TEXT', 1, null, 0, 0],
  [6, 'claimed_at', 'TEXT', 0, null, 0, 0],
  [7, 'claim_token', 'TEXT', 0, null, 0, 0],
  [8, 'delivered_at', 'TEXT', 0, null, 0, 0],
  [9, 'error', 'TEXT', 0, null, 0, 0],
  [10, 'monitor_event_key', 'TEXT', 0, null, 0, 0],
  [11, 'monitor_proposed_checkpoint', 'TEXT', 0, null, 0, 0],
] as const

function str(value: unknown): string | null { return typeof value === 'string' ? value : null }
function num(value: unknown): number | null { return typeof value === 'number' ? value : null }
function rawBytes(value: unknown): Uint8Array { if (value instanceof Uint8Array) return value; throw new Error('historical outbox raw TEXT bytes were not returned by SQLite') }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }

function mapCommitment(row: RawRow): CommitmentRow {
  return { id: str(row.id) ?? '', kind: str(row.kind) ?? '', title: str(row.title) ?? '', workOwner: str(row.work_owner) ?? '', status: str(row.status) ?? '', nextAction: str(row.next_action), acceptedAt: str(row.accepted_at) ?? '', createdAt: str(row.created_at) ?? '', updatedAt: str(row.updated_at) ?? '', startedAt: str(row.started_at), completedAt: str(row.completed_at), result: str(row.result), blockedReason: str(row.blocked_reason), checkInMinutes: num(row.check_in_minutes), reminderDueAt: str(row.reminder_due_at), reminderState: str(row.reminder_state) ?? '', lastDeliveryState: str(row.last_delivery_state), lastDeliveryError: str(row.last_delivery_error), workerSessionId: str(row.worker_session_id), workerParentSessionId: str(row.worker_parent_session_id), workerRunId: str(row.worker_run_id), workerControlState: str(row.worker_control_state) ?? '', progressSummary: str(row.progress_summary), progressAt: str(row.progress_at), monitorDesiredState: str(row.monitor_desired_state) ?? '', monitorResumeState: str(row.monitor_resume_state) ?? '', monitorResumeEpoch: num(row.monitor_resume_epoch) ?? -1, monitorClaimToken: str(row.monitor_claim_token), monitorClaimedAt: str(row.monitor_claimed_at), monitorDirection: str(row.monitor_direction), monitorCheckpoint: str(row.monitor_checkpoint), sourceSurface: str(row.source_surface) ?? '', sourceSessionId: str(row.source_session_id), revision: num(row.revision) ?? -1 }
}
function mapOutbox(row: RawRow): OutboxRow {
  return { id: str(row.id) ?? '', commitmentId: str(row.commitment_id) ?? '', kind: str(row.kind) ?? '', textBytes: rawBytes(row.text_bytes), state: str(row.state) ?? '', createdAt: str(row.created_at) ?? '', claimedAt: str(row.claimed_at), claimToken: str(row.claim_token), deliveredAt: str(row.delivered_at), error: str(row.error), monitorEventKey: str(row.monitor_event_key), monitorProposedCheckpoint: str(row.monitor_proposed_checkpoint) }
}
function exactObject(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); const actual = Object.keys(value); if (actual.length !== keys.length || actual.some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error(`${label} must contain exactly its v1 fields`) }
function canonical(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || value.includes('\u0000')) throw new Error(`${label} must be a non-empty canonical string`) }

function tagged(value: unknown): readonly unknown[] {
  if (value === null) return ['null']
  if (typeof value === 'string') return ['text', Buffer.byteLength(value, 'utf8'), value]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return ['integer', String(value)]
  throw new Error('historical outbox contains a value outside its exact typed schema')
}

function frameLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('historical outbox contains an invalid byte length')
  const frame = Buffer.alloc(8)
  frame.writeBigUInt64BE(BigInt(length))
  return frame
}

function assertOutboxSchema(transaction: OfflineV2OrV3Transaction): void {
  const columns = transaction.listOutboxColumns()
  if (columns.length !== EXPECTED_OUTBOX_SCHEMA.length) throw new Error('historical outbox schema column count mismatch')
  for (let index = 0; index < EXPECTED_OUTBOX_SCHEMA.length; index += 1) {
    const column = columns[index]
    if (column === undefined) throw new Error('historical outbox schema column order mismatch')
    exactObject(column, OUTBOX_SCHEMA_KEYS, 'historical outbox schema column')
    const expected = EXPECTED_OUTBOX_SCHEMA[index]!
    for (let field = 0; field < OUTBOX_SCHEMA_KEYS.length; field += 1) {
      if (column[OUTBOX_SCHEMA_KEYS[field]!] !== expected[field]) throw new Error(`historical outbox schema mismatch at column ${index}`)
    }
  }
}

function assertOutboxRowTypes(row: RawRow): void {
  exactObject(row, OUTBOX_ROW_PROJECTION_KEYS, 'historical outbox row projection')
  for (const key of ['id', 'commitment_id', 'kind', 'state', 'created_at'] as const) {
    if (typeof row[key] !== 'string') throw new Error(`historical outbox column ${key} has an invalid type`)
  }
  for (const key of ['claimed_at', 'claim_token', 'delivered_at', 'error', 'monitor_event_key', 'monitor_proposed_checkpoint'] as const) {
    if (row[key] !== null && typeof row[key] !== 'string') throw new Error(`historical outbox column ${key} has an invalid type`)
  }
  rawBytes(row.text_bytes)
}

function summarizeOutboxSet(transaction: OfflineV2OrV3Transaction, commitmentId: string): { readonly expectation: HistoricalCommitmentOutboxSetV1; readonly rows: readonly OutboxRow[] } {
  assertOutboxSchema(transaction)
  const rawRows = [...transaction.listCommitmentOutbox(commitmentId)] as RawRow[]
  for (const row of rawRows) assertOutboxRowTypes(row)
  rawRows.sort((left, right) => Buffer.compare(Buffer.from(left.id as string, 'utf8'), Buffer.from(right.id as string, 'utf8')))
  for (let index = 1; index < rawRows.length; index += 1) {
    if (rawRows[index - 1]!.id === rawRows[index]!.id) throw new Error('historical outbox collection contains a duplicate id')
  }
  const canonicalSchema = EXPECTED_OUTBOX_SCHEMA.map(column => column.map(tagged))
  const canonicalRows = rawRows.map(row => {
    const textBytes = rawBytes(row.text_bytes)
    return [
      tagged(row.id), tagged(row.commitment_id), tagged(row.kind), ['blob', textBytes.byteLength, sha256(textBytes)],
      tagged(row.state), tagged(row.created_at), tagged(row.claimed_at), tagged(row.claim_token), tagged(row.delivered_at),
      tagged(row.error), tagged(row.monitor_event_key), tagged(row.monitor_proposed_checkpoint),
    ]
  })
  const rawDigest = createHash('sha256')
  rawDigest.update('dsh-historical-outbox-raw-v1\0')
  rawDigest.update(frameLength(rawRows.length))
  for (const row of rawRows) {
    const id = Buffer.from(row.id as string, 'utf8')
    const textBytes = rawBytes(row.text_bytes)
    rawDigest.update(frameLength(id.byteLength)); rawDigest.update(id)
    rawDigest.update(frameLength(textBytes.byteLength)); rawDigest.update(textBytes)
  }
  return {
    expectation: {
      count: rawRows.length,
      canonicalSha256: sha256(Buffer.from(JSON.stringify([1, canonicalSchema, canonicalRows]), 'utf8')),
      rawTextBundleSha256: rawDigest.digest('hex'),
    },
    rows: rawRows.map(mapOutbox),
  }
}

function equalOutboxSet(actual: HistoricalCommitmentOutboxSetV1, expected: HistoricalCommitmentOutboxSetV1, phase: string): void {
  for (const key of OUTBOX_SET_KEYS) if (actual[key] !== expected[key]) throw new Error(`historical outbox collection ${phase} mismatch for field "${key}"`)
}

function assertDesignatedOutbox(rows: readonly OutboxRow[], plan: HistoricalMonitorRecoveryPlanV1, phase: string): void {
  const byId = new Map(rows.map(row => [row.id, row] as const))
  const first = byId.get(plan.deliveredOutboxOne.id); const second = byId.get(plan.deliveredOutboxTwo.id)
  if (first === undefined || second === undefined) throw new Error('historical recovery delivered outbox rows do not match the exact plan')
  equalOutbox(first, plan.deliveredOutboxOne, phase); equalOutbox(second, plan.deliveredOutboxTwo, phase)
}

function validate(plan: HistoricalMonitorRecoveryPlanV1): void {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1) throw new Error('historical recovery plan version must be exactly 1')
  exactObject(plan, ['version', 'commitmentOutboxSet', 'commitment', 'deliveredOutboxOne', 'deliveredOutboxTwo', 'direction', 'checkpoint', 'updatedAt'], 'historical recovery plan'); exactObject(plan.commitmentOutboxSet, OUTBOX_SET_KEYS, 'historical recovery commitmentOutboxSet'); exactObject(plan.commitment, COMMITMENT_KEYS, 'historical recovery commitment')
  for (const [name, outbox] of [['deliveredOutboxOne', plan.deliveredOutboxOne], ['deliveredOutboxTwo', plan.deliveredOutboxTwo]] as const) exactObject(outbox, OUTBOX_KEYS, `historical recovery ${name}`)
  if (!Number.isSafeInteger(plan.commitmentOutboxSet.count) || plan.commitmentOutboxSet.count < 2 || !isSha256(plan.commitmentOutboxSet.canonicalSha256) || !isSha256(plan.commitmentOutboxSet.rawTextBundleSha256)) throw new Error('historical recovery commitmentOutboxSet has invalid count or digests')
  canonical(plan.commitment.id, 'historical recovery commitment id')
  if (plan.commitment.kind !== 'monitor' || plan.commitment.workOwner !== 'agent' || plan.commitment.status !== 'blocked') throw new Error('historical recovery commitment must be a blocked Agent monitor')
  if (plan.commitment.workerSessionId.trim() === '' || plan.commitment.workerParentSessionId.trim() === '' || plan.commitment.workerRunId.trim() === '') throw new Error('historical recovery commitment must bind all three historical worker identities')
  if (plan.commitment.workerControlState !== 'none' || plan.commitment.monitorDesiredState !== 'running' || plan.commitment.monitorResumeState !== 'none' || plan.commitment.monitorClaimToken !== null || plan.commitment.monitorClaimedAt !== null || plan.commitment.monitorDirection !== null || plan.commitment.monitorCheckpoint !== null) throw new Error('historical recovery commitment has an invalid exact PRE state')
  if (!Number.isSafeInteger(plan.commitment.monitorResumeEpoch) || plan.commitment.monitorResumeEpoch < 0 || !Number.isSafeInteger(plan.commitment.revision) || plan.commitment.revision < 0) throw new Error('historical recovery commitment epoch and revision must be non-negative safe integers')
  if (plan.commitment.monitorResumeEpoch >= Number.MAX_SAFE_INTEGER || plan.commitment.revision >= Number.MAX_SAFE_INTEGER) throw new Error('historical recovery commitment epoch and revision cannot be incremented safely')
  canonical(plan.direction, 'historical recovery direction'); canonical(plan.checkpoint, 'historical recovery checkpoint'); canonical(plan.updatedAt, 'historical recovery updatedAt')
  const directionError = validateMonitorDirection(plan.direction); if (directionError !== undefined) throw new Error(directionError)
  const checkpointError = validateMonitorCheckpoint(plan.checkpoint); if (checkpointError !== undefined) throw new Error(checkpointError)
  const seen = new Set<string>()
  for (const [name, outbox] of [['deliveredOutboxOne', plan.deliveredOutboxOne], ['deliveredOutboxTwo', plan.deliveredOutboxTwo]] as const) {
    if (outbox.commitmentId !== plan.commitment.id || outbox.id.trim() === '' || outbox.id !== outbox.id.trim() || seen.has(outbox.id)) throw new Error(`historical recovery ${name} must be a distinct row for the commitment`)
    seen.add(outbox.id)
    if (!['check_in', 'completed', 'blocked', 'missed_check_in', 'progress'].includes(outbox.kind) || outbox.state !== 'delivered' || outbox.monitorEventKey !== null || outbox.monitorProposedCheckpoint !== null || !Number.isSafeInteger(outbox.textByteLength) || outbox.textByteLength < 0 || !isSha256(outbox.textSha256)) throw new Error(`historical recovery ${name} has an invalid delivered evidence summary`)
    canonical(outbox.deliveredAt, `${name}.deliveredAt`)
  }
}
function equalCommitment(current: CommitmentRow, expected: CommitmentExpectation, phase: string): void { for (const key of COMMITMENT_KEYS) if (current[key] !== expected[key]) throw new Error(`historical recovery commitment ${phase} mismatch for field "${key}"`) }
function equalOutbox(current: OutboxRow, expected: HistoricalDeliveredOutboxSnapshotV1, phase: string): void { const actual = { id: current.id, commitmentId: current.commitmentId, kind: current.kind, textByteLength: current.textBytes.byteLength, textSha256: sha256(current.textBytes), state: current.state, createdAt: current.createdAt, claimedAt: current.claimedAt, claimToken: current.claimToken, deliveredAt: current.deliveredAt, error: current.error, monitorEventKey: current.monitorEventKey, monitorProposedCheckpoint: current.monitorProposedCheckpoint }; for (const key of OUTBOX_KEYS) if (actual[key] !== expected[key]) throw new Error(`historical outbox ${phase} mismatch for field "${key}"`) }
function post(plan: HistoricalMonitorRecoveryPlanV1): CommitmentExpectation { return { ...plan.commitment, status: 'active', nextAction: null, updatedAt: plan.updatedAt, completedAt: null, result: null, blockedReason: null, lastDeliveryState: null, lastDeliveryError: null, workerSessionId: null, workerParentSessionId: null, workerRunId: null, progressSummary: null, progressAt: null, monitorResumeState: 'needed', monitorResumeEpoch: plan.commitment.monitorResumeEpoch + 1, monitorDirection: plan.direction, monitorCheckpoint: plan.checkpoint, revision: plan.commitment.revision + 1 } }

function apply(transaction: OfflineV2OrV3Transaction, plan: HistoricalMonitorRecoveryPlanV1): boolean {
  const commitmentRaw = transaction.getCommitment(plan.commitment.id) as RawRow | undefined
  if (commitmentRaw === undefined) throw new Error(`historical recovery commitment "${plan.commitment.id}" does not exist`)
  const before = summarizeOutboxSet(transaction, plan.commitment.id)
  equalOutboxSet(before.expectation, plan.commitmentOutboxSet, 'PRE')
  assertDesignatedOutbox(before.rows, plan, 'PRE')
  const current = mapCommitment(commitmentRaw); const expectedPost = post(plan)
  try { equalCommitment(current, expectedPost, 'POST_BEFORE_START'); return false } catch (postError) {
    try { equalCommitment(current, plan.commitment, 'PRE') } catch { throw new Error(`historical recovery commitment is neither exact PRE nor exact POST_BEFORE_START: ${postError instanceof Error ? postError.message : String(postError)}`) }
  }
  const updated = transaction.updateCommitmentAtRevision(plan.commitment.id, plan.commitment.revision, {
    status: 'active', next_action: null, updated_at: plan.updatedAt, completed_at: null, result: null, blocked_reason: null,
    last_delivery_state: null, last_delivery_error: null, worker_session_id: null, worker_parent_session_id: null, worker_run_id: null,
    worker_control_state: 'none', progress_summary: null, progress_at: null, monitor_desired_state: 'running', monitor_resume_state: 'needed',
    monitor_resume_epoch: plan.commitment.monitorResumeEpoch + 1, monitor_claim_token: null, monitor_claimed_at: null,
    monitor_direction: plan.direction, monitor_checkpoint: plan.checkpoint, revision: plan.commitment.revision + 1,
  })
  if (!updated) throw new Error(`historical recovery commitment "${plan.commitment.id}" changed during recovery`)
  const after = summarizeOutboxSet(transaction, plan.commitment.id)
  equalOutboxSet(after.expectation, plan.commitmentOutboxSet, 'POST')
  assertDesignatedOutbox(after.rows, plan, 'POST')
  return true
}

export function applyHistoricalMonitorRecovery(path: string, plan: HistoricalMonitorRecoveryPlanV1): HistoricalMonitorRecoveryResult {
  validate(plan)
  const result = runOfflineV2OrV3Transaction(path, transaction => apply(transaction, plan))
  return { sourceVersion: result.sourceVersion, applied: result.value, noop: !result.value }
}
