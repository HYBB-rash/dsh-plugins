import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSISTANT_APPLICATION_ID } from '../src/schema.ts'
import {
  applyHistoricalMonitorRecovery,
  type HistoricalMonitorRecoveryPlanV1,
} from '../src/historical-recovery.ts'
import { migrateDatabaseToV3 } from '../src/migration.ts'

const dirs: string[] = []
const PRE_UPDATED_AT = '2026-08-18T01:02:03.000Z'
const RECOVERED_AT = '2026-08-18T04:05:06.000Z'

const V3_OUTBOX_SCHEMA = [
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

interface TestOutboxSetExpectation {
  readonly count: number
  readonly canonicalSha256: string
  readonly rawTextBundleSha256: string
}

type TestRecoveryPlan = HistoricalMonitorRecoveryPlanV1 & {
  readonly commitmentOutboxSet: TestOutboxSetExpectation
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-historical-recovery-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function digest(text: string | Uint8Array): string {
  return createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex')
}

function bytes(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tagged(value: unknown): readonly unknown[] {
  if (value === null) return ['null']
  if (typeof value === 'string') return ['text', Buffer.byteLength(value, 'utf8'), value]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return ['integer', String(value)]
  throw new Error(`unsupported canonical test value: ${String(value)}`)
}

function frameLength(length: number): Buffer {
  const frame = Buffer.alloc(8)
  frame.writeBigUInt64BE(BigInt(length))
  return frame
}

function commitmentOutboxSet(path: string): TestOutboxSetExpectation {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const names = new Set((db.prepare("PRAGMA table_xinfo('outbox')").all() as Array<{ name: string }>).map(column => column.name))
    const eventKey = names.has('monitor_event_key') ? 'monitor_event_key' : 'NULL AS monitor_event_key'
    const proposedCheckpoint = names.has('monitor_proposed_checkpoint') ? 'monitor_proposed_checkpoint' : 'NULL AS monitor_proposed_checkpoint'
    const rows = db.prepare(`SELECT id, commitment_id, kind, CAST(text AS BLOB) AS text_bytes, state, created_at,
      claimed_at, claim_token, delivered_at, error, ${eventKey}, ${proposedCheckpoint}
      FROM outbox WHERE commitment_id = ? ORDER BY id`).all('monitor-1') as Array<Record<string, unknown>>
    rows.sort((left, right) => Buffer.compare(Buffer.from(String(left.id), 'utf8'), Buffer.from(String(right.id), 'utf8')))
    const canonicalRows = rows.map(row => {
      const textBytes = Buffer.from(row.text_bytes as Uint8Array)
      return [
        tagged(row.id), tagged(row.commitment_id), tagged(row.kind),
        ['blob', textBytes.byteLength, digest(textBytes)],
        tagged(row.state), tagged(row.created_at), tagged(row.claimed_at), tagged(row.claim_token),
        tagged(row.delivered_at), tagged(row.error), tagged(row.monitor_event_key), tagged(row.monitor_proposed_checkpoint),
      ]
    })
    const canonicalSchema = V3_OUTBOX_SCHEMA.map(column => column.map(tagged))
    const canonicalSha256 = digest(JSON.stringify([1, canonicalSchema, canonicalRows]))
    const raw = createHash('sha256')
    raw.update('dsh-historical-outbox-raw-v1\0')
    raw.update(frameLength(rows.length))
    for (const row of rows) {
      const id = Buffer.from(String(row.id), 'utf8')
      const textBytes = Buffer.from(row.text_bytes as Uint8Array)
      raw.update(frameLength(id.byteLength)); raw.update(id)
      raw.update(frameLength(textBytes.byteLength)); raw.update(textBytes)
    }
    return { count: rows.length, canonicalSha256, rawTextBundleSha256: raw.digest('hex') }
  } finally {
    db.close()
  }
}

function createV2(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = ${ASSISTANT_APPLICATION_ID};
    PRAGMA user_version = 2;
    CREATE TABLE commitments (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('focus','delegated','monitor')),
      title TEXT NOT NULL, work_owner TEXT NOT NULL CHECK (work_owner IN ('user','agent')),
      status TEXT NOT NULL CHECK (status IN ('pending','active','paused','blocked','completed','cancelled')),
      next_action TEXT, accepted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, result TEXT, blocked_reason TEXT,
      check_in_minutes INTEGER, reminder_due_at TEXT, reminder_state TEXT NOT NULL,
      last_delivery_state TEXT, last_delivery_error TEXT,
      worker_session_id TEXT, worker_parent_session_id TEXT, worker_run_id TEXT,
      worker_control_state TEXT NOT NULL CHECK (worker_control_state IN ('none','pause_requested','resume_requested')),
      progress_summary TEXT, progress_at TEXT,
      monitor_desired_state TEXT NOT NULL CHECK (monitor_desired_state IN ('none','running','paused')),
      monitor_resume_state TEXT NOT NULL CHECK (monitor_resume_state IN ('none','needed','claimed')),
      monitor_resume_epoch INTEGER NOT NULL, monitor_claim_token TEXT, monitor_claimed_at TEXT,
      source_surface TEXT NOT NULL CHECK (source_surface IN ('web','telegram')),
      source_session_id TEXT, revision INTEGER NOT NULL,
      CHECK ((kind = 'focus' AND work_owner = 'user') OR (kind IN ('delegated','monitor') AND work_owner = 'agent'))
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id),
      kind TEXT NOT NULL CHECK (kind IN ('check_in','completed','blocked','missed_check_in','progress')),
      text TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','uncertain','cancelled')),
      created_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT, delivered_at TEXT, error TEXT
    ) STRICT;
  `)
  const commitment = db.prepare(`INSERT INTO commitments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  commitment.run(
    'monitor-1', 'monitor', 'Historical monitor', 'agent', 'blocked', 'old next',
    '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', PRE_UPDATED_AT,
    '2026-08-17T00:01:00.000Z', '2026-08-18T00:01:00.000Z', 'old result', 'old block',
    30, '2026-08-18T00:30:00.000Z', 'scheduled', 'delivered', 'old error',
    'historical-child', 'historical-root', 'historical-run', 'none', 'old progress', '2026-08-18T00:00:00.000Z',
    'running', 'none', 9, null, null, 'telegram', 'source-root', 12,
  )
  commitment.run(
    'other-1', 'delegated', 'Other responsibility', 'agent', 'active', 'unrelated',
    '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', PRE_UPDATED_AT,
    null, null, null, null, null, null, 'none', null, null,
    null, null, null, 'none', null, null, 'none', 'none', 0, null, null, 'telegram', 'source-root', 2,
  )
  const outbox = db.prepare(`INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)`)
  outbox.run('archive-c', 'monitor-1', 'progress', 'Earlier neutral delivery', 'delivered', '2026-08-17T23:58:00.000Z', '2026-08-17T23:58:30.000Z', 'neutral-claim', '2026-08-17T23:59:00.000Z', null)
  outbox.run('delivered-a', 'monitor-1', 'completed', 'First historical delivery \ud83c\udf0a', 'delivered', '2026-08-18T00:01:00.000Z', null, null, '2026-08-18T00:02:00.000Z', null)
  outbox.run('delivered-b', 'monitor-1', 'blocked', 'Second historical delivery', 'delivered', '2026-08-18T00:03:00.000Z', null, null, '2026-08-18T00:04:00.000Z', null)
  outbox.run('other-outbox', 'other-1', 'progress', 'Other delivery', 'delivered', '2026-08-18T00:05:00.000Z', null, null, '2026-08-18T00:06:00.000Z', null)
  db.close()
}

function commitmentSnapshot(db: DatabaseSync, id: string): Record<string, unknown> {
  const base = db.prepare(`SELECT id, kind, title, work_owner, status, next_action, accepted_at, created_at, updated_at,
    started_at, completed_at, result, blocked_reason, check_in_minutes, reminder_due_at, reminder_state,
    last_delivery_state, last_delivery_error, worker_session_id, worker_parent_session_id, worker_run_id,
    worker_control_state, progress_summary, progress_at, monitor_desired_state, monitor_resume_state,
    monitor_resume_epoch, monitor_claim_token, monitor_claimed_at, source_surface, source_session_id, revision
    FROM commitments WHERE id = ?`).get(id) as Record<string, unknown>
  const columns = db.prepare("SELECT name FROM pragma_table_info('commitments') WHERE name IN ('monitor_direction', 'monitor_checkpoint')").all() as Array<{ name: string }>
  if (columns.length === 0) return base
  return db.prepare(`SELECT id, kind, title, work_owner, status, next_action, accepted_at, created_at, updated_at,
    started_at, completed_at, result, blocked_reason, check_in_minutes, reminder_due_at, reminder_state,
    last_delivery_state, last_delivery_error, worker_session_id, worker_parent_session_id, worker_run_id,
    worker_control_state, progress_summary, progress_at, monitor_desired_state, monitor_resume_state,
    monitor_resume_epoch, monitor_claim_token, monitor_claimed_at, monitor_direction, monitor_checkpoint,
    source_surface, source_session_id, revision FROM commitments WHERE id = ?`).get(id) as Record<string, unknown>
}

function outboxSnapshot(db: DatabaseSync, id: string): Record<string, unknown> {
  const base = db.prepare(`SELECT id, commitment_id, kind, text, state, created_at, claimed_at, claim_token, delivered_at, error
    FROM outbox WHERE id = ?`).get(id) as Record<string, unknown>
  const columns = db.prepare("SELECT name FROM pragma_table_info('outbox') WHERE name IN ('monitor_event_key', 'monitor_proposed_checkpoint')").all() as Array<{ name: string }>
  if (columns.length === 0) return base
  return db.prepare(`SELECT id, commitment_id, kind, text, state, created_at, claimed_at, claim_token, delivered_at, error,
    monitor_event_key, monitor_proposed_checkpoint FROM outbox WHERE id = ?`).get(id) as Record<string, unknown>
}

function targetOutboxSnapshots(db: DatabaseSync): Record<string, unknown>[] {
  const ids = db.prepare("SELECT id FROM outbox WHERE commitment_id = 'monitor-1' ORDER BY id").all() as Array<{ id: string }>
  return ids.map(({ id }) => outboxSnapshot(db, id))
}

function plan(path: string): TestRecoveryPlan {
  return {
    version: 1,
    commitmentOutboxSet: commitmentOutboxSet(path),
    commitment: {
      id: 'monitor-1', kind: 'monitor', title: 'Historical monitor', workOwner: 'agent', status: 'blocked', nextAction: 'old next',
      acceptedAt: '2026-08-17T00:00:00.000Z', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: PRE_UPDATED_AT,
      startedAt: '2026-08-17T00:01:00.000Z', completedAt: '2026-08-18T00:01:00.000Z', result: 'old result', blockedReason: 'old block',
      checkInMinutes: 30, reminderDueAt: '2026-08-18T00:30:00.000Z', reminderState: 'scheduled',
      lastDeliveryState: 'delivered', lastDeliveryError: 'old error',
      workerSessionId: 'historical-child', workerParentSessionId: 'historical-root', workerRunId: 'historical-run', workerControlState: 'none',
      progressSummary: 'old progress', progressAt: '2026-08-18T00:00:00.000Z',
      monitorDesiredState: 'running', monitorResumeState: 'none', monitorResumeEpoch: 9,
      monitorClaimToken: null, monitorClaimedAt: null, monitorDirection: null, monitorCheckpoint: null,
      sourceSurface: 'telegram', sourceSessionId: 'source-root', revision: 12,
    },
    deliveredOutboxOne: {
      id: 'delivered-a', commitmentId: 'monitor-1', kind: 'completed', textByteLength: Buffer.byteLength('First historical delivery \ud83c\udf0a', 'utf8'),
      textSha256: digest('First historical delivery \ud83c\udf0a'), state: 'delivered', createdAt: '2026-08-18T00:01:00.000Z',
      claimedAt: null, claimToken: null, deliveredAt: '2026-08-18T00:02:00.000Z', error: null,
      monitorEventKey: null, monitorProposedCheckpoint: null,
    },
    deliveredOutboxTwo: {
      id: 'delivered-b', commitmentId: 'monitor-1', kind: 'blocked', textByteLength: Buffer.byteLength('Second historical delivery', 'utf8'),
      textSha256: digest('Second historical delivery'), state: 'delivered', createdAt: '2026-08-18T00:03:00.000Z',
      claimedAt: null, claimToken: null, deliveredAt: '2026-08-18T00:04:00.000Z', error: null,
      monitorEventKey: null, monitorProposedCheckpoint: null,
    },
    direction: 'watch-current', checkpoint: '{"cursor":42}', updatedAt: RECOVERED_AT,
  } as TestRecoveryPlan
}

describe('historical monitor recovery', () => {
  it('migrates exact v2 PRE and recovers one monitor without touching its complete three-row outbox set or other commitments', () => {
    const path = tempPath()
    createV2(path)
    const before = new DatabaseSync(path)
    const targetOutboxBefore = targetOutboxSnapshots(before)
    const otherBefore = commitmentSnapshot(before, 'other-1')
    before.close()

    expect(applyHistoricalMonitorRecovery(path, plan(path))).toEqual({ sourceVersion: 2, applied: true, noop: false })

    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect(commitmentSnapshot(after, 'monitor-1')).toEqual({
      id: 'monitor-1', kind: 'monitor', title: 'Historical monitor', work_owner: 'agent', status: 'active', next_action: null,
      accepted_at: '2026-08-17T00:00:00.000Z', created_at: '2026-08-17T00:00:00.000Z', updated_at: RECOVERED_AT,
      started_at: '2026-08-17T00:01:00.000Z', completed_at: null, result: null, blocked_reason: null,
      check_in_minutes: 30, reminder_due_at: '2026-08-18T00:30:00.000Z', reminder_state: 'scheduled',
      last_delivery_state: null, last_delivery_error: null,
      worker_session_id: null, worker_parent_session_id: null, worker_run_id: null, worker_control_state: 'none',
      progress_summary: null, progress_at: null, monitor_desired_state: 'running', monitor_resume_state: 'needed',
      monitor_resume_epoch: 10, monitor_claim_token: null, monitor_claimed_at: null,
      monitor_direction: 'watch-current', monitor_checkpoint: '{"cursor":42}', source_surface: 'telegram', source_session_id: 'source-root', revision: 13,
    })
    expect(targetOutboxSnapshots(after)).toEqual(targetOutboxBefore.map(row => ({ ...row, monitor_event_key: null, monitor_proposed_checkpoint: null })))
    expect(commitmentSnapshot(after, 'other-1')).toEqual({ ...otherBefore, monitor_direction: null, monitor_checkpoint: null })
    expect((after.prepare("SELECT COUNT(*) AS n FROM outbox WHERE commitment_id = 'monitor-1'").get() as { n: number }).n).toBe(3)
    after.close()
  })

  it('rejects a fourth target outbox row before migration and leaves source v2 unchanged', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'late-fourth', 'monitor-1', 'progress', 'Unexpected neutral delivery', 'delivered',
      '2026-08-18T00:07:00.000Z', null, null, '2026-08-18T00:08:00.000Z', null,
    )
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection/i)
    expect(bytes(path)).toBe(beforeReject)
    const after = new DatabaseSync(path, { readOnly: true })
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    after.close()
  })

  it('rejects deleting one row and replacing it with a new id even when count stays constant', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO outbox SELECT 'archive-replacement', commitment_id, kind, text, state, created_at,
      claimed_at, claim_token, delivered_at, error FROM outbox WHERE id = 'archive-c'`).run()
    db.prepare("DELETE FROM outbox WHERE id = 'archive-c'").run()
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE commitment_id = 'monitor-1'").get() as { n: number }).n).toBe(3)
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('rejects every non-text column mutation on an undesignated historical row without writes', () => {
    const mutations: ReadonlyArray<readonly [string, (db: DatabaseSync) => void]> = [
      ['id', db => { db.prepare("UPDATE outbox SET id = 'archive-renamed' WHERE id = 'archive-c'").run() }],
      ['commitment_id', db => { db.prepare("UPDATE outbox SET commitment_id = 'other-1' WHERE id = 'archive-c'").run() }],
      ['kind', db => { db.prepare("UPDATE outbox SET kind = 'completed' WHERE id = 'archive-c'").run() }],
      ['state', db => { db.prepare("UPDATE outbox SET state = 'failed' WHERE id = 'archive-c'").run() }],
      ['created_at', db => { db.prepare("UPDATE outbox SET created_at = '2026-08-17T23:57:00.000Z' WHERE id = 'archive-c'").run() }],
      ['claimed_at', db => { db.prepare("UPDATE outbox SET claimed_at = NULL WHERE id = 'archive-c'").run() }],
      ['claim_token', db => { db.prepare("UPDATE outbox SET claim_token = 'different-neutral-claim' WHERE id = 'archive-c'").run() }],
      ['delivered_at', db => { db.prepare("UPDATE outbox SET delivered_at = '2026-08-17T23:59:30.000Z' WHERE id = 'archive-c'").run() }],
      ['error', db => { db.prepare("UPDATE outbox SET error = 'neutral historical error' WHERE id = 'archive-c'").run() }],
      ['monitor_event_key', db => {
        db.exec('PRAGMA ignore_check_constraints = ON')
        db.prepare("UPDATE outbox SET monitor_event_key = 'neutral-event' WHERE id = 'archive-c'").run()
      }],
      ['monitor_proposed_checkpoint', db => {
        db.exec('PRAGMA ignore_check_constraints = ON')
        db.prepare("UPDATE outbox SET monitor_proposed_checkpoint = 'neutral-checkpoint' WHERE id = 'archive-c'").run()
      }],
    ]
    expect(mutations.map(([column]) => column)).toEqual(V3_OUTBOX_SCHEMA.map(column => column[1]).filter(column => column !== 'text'))
    for (const [, mutate] of mutations) {
      const path = tempPath()
      createV2(path)
      const recovery = plan(path)
      expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ applied: true })
      const db = new DatabaseSync(path)
      mutate(db)
      db.close()
      const beforeReject = bytes(path)
      expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection/i)
      expect(bytes(path)).toBe(beforeReject)
    }
  })

  it('rejects raw SQLite TEXT byte mutation on an undesignated row', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ applied: true })
    const db = new DatabaseSync(path)
    db.prepare("UPDATE outbox SET text = CAST(x'80' AS TEXT) WHERE id = 'archive-c'").run()
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('rejects an exact POST_BEFORE_START no-op after the frozen outbox set changes', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ applied: true })
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at) VALUES
      ('post-extra', 'monitor-1', 'progress', 'Late post delivery', 'delivered', '2026-08-18T00:09:00.000Z')`).run()
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('rejects replay after a fresh worker writes a monitor_event row', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ applied: true })
    const db = new DatabaseSync(path)
    db.prepare(`UPDATE commitments SET worker_session_id='fresh-child', worker_parent_session_id='historical-root',
      worker_run_id='fresh-run', monitor_resume_state='none', revision=revision+2 WHERE id='monitor-1'`).run()
    db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at, monitor_event_key, monitor_proposed_checkpoint)
      VALUES ('fresh-event', 'monitor-1', 'monitor_event', 'Fresh neutral event', 'pending',
      '2026-08-18T00:10:00.000Z', 'neutral-event-key', '{"cursor":43}')`).run()
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox collection|exact PRE.*POST_BEFORE_START/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('rejects any outbox schema column drift instead of silently omitting it from the digest', () => {
    const path = tempPath()
    createV2(path)
    const recovery = plan(path)
    expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ applied: true })
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE outbox ADD COLUMN attempt INTEGER')
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical outbox schema/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('only accepts the exact post-before-start state as a no-op and rejects takeover/mixed states without writes', () => {
    const path = tempPath()
    createV2(path)
    expect(applyHistoricalMonitorRecovery(path, plan(path))).toMatchObject({ applied: true })
    const afterFirst = bytes(path)
    expect(applyHistoricalMonitorRecovery(path, plan(path))).toEqual({ sourceVersion: 3, applied: false, noop: true })
    expect(bytes(path)).toBe(afterFirst)

    const db = new DatabaseSync(path)
    db.prepare("UPDATE commitments SET worker_session_id = 'fresh-child', worker_parent_session_id = 'fresh-root', worker_run_id = 'fresh-run', monitor_resume_state = 'claimed', monitor_claim_token = 'claim', monitor_claimed_at = ?, revision = revision + 1 WHERE id = 'monitor-1'").run(RECOVERED_AT)
    db.close()
    const beforeReject = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, plan(path))).toThrow(/historical recovery.*exact PRE.*POST_BEFORE_START/i)
    expect(bytes(path)).toBe(beforeReject)
  })

  it('rejects every post-before-start lookalike without writes', () => {
    const mutations: ReadonlyArray<readonly [string, (db: DatabaseSync) => void]> = [
      ['fresh identity', db => {
        db.prepare("UPDATE commitments SET worker_session_id = 'fresh-child', worker_parent_session_id = 'fresh-root', worker_run_id = 'fresh-run' WHERE id = 'monitor-1'").run()
      }],
      ['claim without identity', db => {
        db.prepare("UPDATE commitments SET worker_control_state = 'resume_requested', monitor_resume_state = 'claimed', monitor_claim_token = 'claim', monitor_claimed_at = ? WHERE id = 'monitor-1'").run(RECOVERED_AT)
      }],
      ['new outbox', db => {
        db.prepare("INSERT INTO outbox (id, commitment_id, kind, text, state, created_at) VALUES ('new-outbox', 'monitor-1', 'progress', 'new', 'delivered', ?)").run(RECOVERED_AT)
      }],
      ['advanced checkpoint', db => {
        db.prepare("UPDATE commitments SET monitor_checkpoint = '{\"cursor\":43}' WHERE id = 'monitor-1'").run()
      }],
      ['higher revision', db => {
        db.prepare("UPDATE commitments SET revision = revision + 1 WHERE id = 'monitor-1'").run()
      }],
      ['higher epoch', db => {
        db.prepare('UPDATE commitments SET monitor_resume_epoch = monitor_resume_epoch + 1 WHERE id = \'monitor-1\'').run()
      }],
      ['mixed terminal fields', db => {
        db.prepare("UPDATE commitments SET status = 'blocked', blocked_reason = 'mixed' WHERE id = 'monitor-1'").run()
      }],
    ]
    for (const [, mutate] of mutations) {
      const path = tempPath()
      createV2(path)
      const recovery = plan(path)
      expect(applyHistoricalMonitorRecovery(path, recovery)).toMatchObject({ sourceVersion: 2, applied: true })
      const db = new DatabaseSync(path)
      mutate(db)
      db.close()
      const beforeReject = bytes(path)
      expect(() => applyHistoricalMonitorRecovery(path, recovery)).toThrow(/historical recovery commitment|historical recovery delivered|historical outbox collection/i)
      expect(bytes(path)).toBe(beforeReject)
    }
  })

  it('fails closed on an outbox byte/hash mismatch and keeps source v2 bytes and rows unchanged', () => {
    const path = tempPath()
    createV2(path)
    const db = new DatabaseSync(path)
    db.prepare("UPDATE outbox SET text = 'altered' WHERE id = 'delivered-a'").run()
    db.close()
    const before = bytes(path)
    expect(() => applyHistoricalMonitorRecovery(path, plan(path))).toThrow(/historical outbox.*mismatch/i)
    expect(bytes(path)).toBe(before)
    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v3'").all()).toEqual([])
    after.close()
  })

  it('uses SQLite TEXT raw bytes, not a replacement-character UTF-8 re-encoding', () => {
    const path = tempPath()
    createV2(path)
    const rawText = new Uint8Array([0x80])
    const db = new DatabaseSync(path)
    db.prepare("UPDATE outbox SET text = CAST(x'80' AS TEXT) WHERE id = 'delivered-a'").run()
    const beforeHex = (db.prepare("SELECT hex(CAST(text AS BLOB)) AS hex FROM outbox WHERE id = 'delivered-a'").get() as { hex: string }).hex
    db.close()
    const rawPlan = plan(path) as unknown as TestRecoveryPlan & { deliveredOutboxOne: { textByteLength: number; textSha256: string } }
    rawPlan.deliveredOutboxOne.textByteLength = rawText.byteLength
    rawPlan.deliveredOutboxOne.textSha256 = digest(rawText)
    expect(beforeHex).toBe('80')
    expect(applyHistoricalMonitorRecovery(path, rawPlan)).toEqual({ sourceVersion: 2, applied: true, noop: false })
    const after = new DatabaseSync(path)
    expect((after.prepare("SELECT hex(CAST(text AS BLOB)) AS hex FROM outbox WHERE id = 'delivered-a'").get() as { hex: string }).hex).toBe('80')
    after.close()
  })

  it('rejects null delivered evidence time and non-incrementable epoch/revision before opening a write transaction', () => {
    const path = tempPath()
    createV2(path)
    const nullDeliveredAt = plan(path) as unknown as HistoricalMonitorRecoveryPlanV1 & { deliveredOutboxOne: { deliveredAt: null } }
    nullDeliveredAt.deliveredOutboxOne.deliveredAt = null
    expect(() => applyHistoricalMonitorRecovery(path, nullDeliveredAt)).toThrow(/deliveredAt must be a non-empty canonical string/)
    const maxEpoch = plan(path) as unknown as HistoricalMonitorRecoveryPlanV1 & { commitment: { monitorResumeEpoch: number } }
    maxEpoch.commitment.monitorResumeEpoch = Number.MAX_SAFE_INTEGER
    expect(() => applyHistoricalMonitorRecovery(path, maxEpoch)).toThrow(/cannot be incremented safely/)
    const maxRevision = plan(path) as unknown as HistoricalMonitorRecoveryPlanV1 & { commitment: { revision: number } }
    maxRevision.commitment.revision = Number.MAX_SAFE_INTEGER
    expect(() => applyHistoricalMonitorRecovery(path, maxRevision)).toThrow(/cannot be incremented safely/)
    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    after.close()
  })

  it('also applies the exact PRE state from an already-v3 offline database', () => {
    const path = tempPath()
    createV2(path)
    expect(migrateDatabaseToV3(path)).toMatchObject({ from: 2, to: 3 })
    expect(applyHistoricalMonitorRecovery(path, plan(path))).toEqual({ sourceVersion: 3, applied: true, noop: false })
  })

  it('keeps the offline recovery unreachable from the runtime root and ordinary migration CLI', () => {
    for (const file of ['index.ts', 'store.ts', 'worker.ts', 'tools.ts', 'migrate-cli.ts']) {
      expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).not.toMatch(/historical-recovery|HistoricalMonitorRecovery|applyHistoricalMonitorRecovery/)
    }
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> }
    expect(packageJson.exports['./historical-recovery']).toEqual({ types: './lib/types/historical-recovery.d.ts', default: './lib/historical-recovery.js' })
    expect(packageJson.exports['./src/*']).toBeUndefined()
    expect(readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')).toContain("'lib/types/historical-recovery.js'")
    const historicalSource = readFileSync(new URL('../src/historical-recovery.ts', import.meta.url), 'utf8')
    expect(historicalSource).not.toMatch(/DatabaseSync|\.exec\(|\.prepare\(/)
    const migrationSource = readFileSync(new URL('../src/migration.ts', import.meta.url), 'utf8')
    expect(migrationSource).not.toMatch(/HistoricalMonitorRecovery|applyHistoricalMonitorRecovery|historical recovery/i)
    const reachableSource = new Set<string>()
    const readSource = (absolute: string): void => {
      if (reachableSource.has(absolute)) return
      reachableSource.add(absolute)
      const text = readFileSync(absolute, 'utf8')
      const imports = text.matchAll(/from\s+["'](\.\/[^"']+)["']/g)
      for (const match of imports) readSource(resolve(dirname(absolute), match[1]!))
    }
    readSource(new URL('../src/migrate-cli.ts', import.meta.url).pathname)
    readSource(new URL('../src/index.ts', import.meta.url).pathname)
    expect([...reachableSource].map(file => readFileSync(file, 'utf8')).join('\n')).not.toMatch(/applyHistoricalMonitorRecovery|HistoricalMonitorRecovery|historical recovery/i)
  })
})
