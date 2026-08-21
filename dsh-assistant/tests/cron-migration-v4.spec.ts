/**
 * Lane C / A: red tests for the assistant schema migration that introduces
 * the independent assistant_cron_bindings table.
 *
 * The fixture is an isolated temporary v3 database.  No live DSH home,
 * deployment database, jobs.jsonl, or dsh-cron process is involved.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
const NOW = '2026-08-18T00:00:00.000Z'

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-v4-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function loadMigration(): Promise<Record<string, unknown>> {
  return await import('../src/migration.ts') as unknown as Record<string, unknown>
}

async function loadStore(): Promise<Record<string, unknown>> {
  return await import('../src/store.ts') as unknown as Record<string, unknown>
}

function seedV3(path: string): void {
  // Keep this fixture independent of the current AssistantStore.  Once the
  // product moves its online schema to v4, calling AssistantStore here would
  // accidentally produce v4 and make the migration test green for the wrong
  // reason.
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = 0x44534841;
    PRAGMA user_version = 3;
    CREATE TABLE commitments (
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
      worker_control_state TEXT NOT NULL CHECK (worker_control_state IN ('none','pause_requested','resume_requested')),
      progress_summary TEXT, progress_at TEXT,
      monitor_desired_state TEXT NOT NULL CHECK (monitor_desired_state IN ('none','running','paused')),
      monitor_resume_state TEXT NOT NULL CHECK (monitor_resume_state IN ('none','needed','claimed')),
      monitor_resume_epoch INTEGER NOT NULL, monitor_claim_token TEXT, monitor_claimed_at TEXT,
      monitor_direction TEXT, monitor_checkpoint TEXT,
      source_surface TEXT NOT NULL CHECK (source_surface IN ('web','telegram')),
      source_session_id TEXT, revision INTEGER NOT NULL,
      CHECK ((kind = 'focus' AND work_owner = 'user') OR (kind IN ('delegated','monitor') AND work_owner = 'agent'))
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id),
      kind TEXT NOT NULL CHECK (kind IN ('check_in','completed','blocked','missed_check_in','progress','monitor_event')),
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','uncertain','cancelled')),
      created_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT, delivered_at TEXT, error TEXT,
      monitor_event_key TEXT, monitor_proposed_checkpoint TEXT,
      CHECK ((kind = 'monitor_event' AND monitor_event_key IS NOT NULL AND monitor_proposed_checkpoint IS NOT NULL)
        OR (kind <> 'monitor_event' AND monitor_event_key IS NULL AND monitor_proposed_checkpoint IS NULL))
    ) STRICT;
    CREATE TABLE web_observations (
      session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running','ended','abnormal','interrupted')),
      request_text TEXT, last_assistant_text TEXT, last_assistant_message_id TEXT,
      turn_reason TEXT, error_code TEXT, error_message TEXT, cwd TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      writer_instance_id TEXT NOT NULL, writer_started_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX commitments_open_focus
      ON commitments(kind) WHERE kind = 'focus' AND status IN ('pending','active','paused','blocked');
    CREATE UNIQUE INDEX commitments_worker_session
      ON commitments(worker_session_id) WHERE worker_session_id IS NOT NULL;
    CREATE UNIQUE INDEX outbox_monitor_event_unique
      ON outbox(commitment_id, monitor_event_key) WHERE kind = 'monitor_event';
  `)
  db.prepare(`INSERT INTO commitments
    (id, kind, title, work_owner, status, accepted_at, created_at, updated_at, reminder_state,
     worker_control_state, monitor_desired_state, monitor_resume_state, monitor_resume_epoch,
     monitor_direction, source_surface, revision)
    VALUES (?, 'focus', ?, 'user', 'active', ?, ?, ?, 'scheduled', 'none', 'none', 'none', 0, NULL, 'telegram', 1)`)
    .run('focus-v3', '历史焦点', NOW, NOW, NOW)
  db.prepare(`INSERT INTO commitments
    (id, kind, title, work_owner, status, accepted_at, created_at, updated_at, reminder_state,
     worker_control_state, monitor_desired_state, monitor_resume_state, monitor_resume_epoch,
     monitor_direction, source_surface, revision)
    VALUES (?, 'monitor', ?, 'agent', 'active', ?, ?, ?, 'none', 'none', 'running', 'none', 0, ?, 'telegram', 2)`)
    .run('monitor-v3', '历史监控', NOW, NOW, NOW, '只看这个临时工作区')

  const historicalKinds = ['check_in', 'completed', 'blocked', 'missed_check_in', 'progress'] as const
  for (const [index, kind] of historicalKinds.entries()) {
    db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`old-${kind}`, index % 2 === 0 ? 'focus-v3' : 'monitor-v3', kind, `历史 ${kind} 正文 ${index}`, index === 0 ? 'pending' : 'claimed', NOW)
  }
  db.prepare(`INSERT INTO outbox
    (id, commitment_id, kind, text, state, created_at, monitor_event_key, monitor_proposed_checkpoint)
    VALUES (?, 'monitor-v3', 'monitor_event', ?, 'uncertain', ?, ?, ?)`)
    .run('old-monitor-event', '历史监控事件', NOW, 'legacy-event-1', 'legacy-cursor-1')
  db.prepare("UPDATE outbox SET state = 'delivered', delivered_at = ? WHERE id = 'old-completed'").run(NOW)
  db.prepare("UPDATE outbox SET state = 'failed', error = 'legacy delivery error' WHERE id = 'old-blocked'").run()
  db.prepare(`INSERT INTO web_observations
    (session_id, turn, state, request_text, last_assistant_text, started_at, updated_at, writer_instance_id, writer_started_at)
    VALUES ('web-v3', 1, 'ended', '历史请求', '历史回答', ?, ?, 'writer-v3', ?)`)
    .run(NOW, NOW, NOW)
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
  db.close()
}

function rowsHash(db: DatabaseSync, table: 'commitments' | 'outbox' | 'web_observations'): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function bindingColumns(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings') ORDER BY cid").all() as Array<{ name: string }>)
    .map(row => row.name)
}

describe('assistant schema v3 -> v4 cron binding migration (first red)', () => {
  it('adds independent bindings, preserves commitments and every historical outbox row, and is idempotent', async () => {
    const migration = await loadMigration()
    const migrateDatabaseToV4 = migration.migrateDatabaseToV4 as undefined | ((path: string, options?: { readonly now?: string }) => unknown)
    expect(typeof migrateDatabaseToV4, 'offline v3 -> v4 migration method is missing').toBe('function')
    if (migrateDatabaseToV4 === undefined) return

    const path = tempPath()
    await seedV3(path)
    const beforeDb = new DatabaseSync(path)
    const beforeCommitments = rowsHash(beforeDb, 'commitments')
    const beforeOutbox = rowsHash(beforeDb, 'outbox')
    const beforeWebObservations = rowsHash(beforeDb, 'web_observations')
    beforeDb.close()

    await migrateDatabaseToV4(path, { now: NOW })
    const firstDb = new DatabaseSync(path)
    expect((firstDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(bindingColumns(firstDb)).toEqual(expect.arrayContaining([
      'commitment_id', 'external_ref', 'desired_schedule_json', 'desired_cwd', 'desired_state',
      'bound_job_id', 'last_run_id', 'last_run_job_id', 'scheduled_for', 'finished_at', 'run_status', 'last_run_summary',
      'run_error', 'delivery_state', 'delivery_error', 'control_error', 'created_at', 'updated_at',
    ]))
    expect(bindingColumns(firstDb)).not.toContain('desired_prompt')
    expect(rowsHash(firstDb, 'commitments')).toBe(beforeCommitments)
    expect(rowsHash(firstDb, 'outbox')).toBe(beforeOutbox)
    expect(rowsHash(firstDb, 'web_observations')).toBe(beforeWebObservations)
    const tableSql = firstDb.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_cron_bindings'").get() as { sql: string } | undefined
    expect(tableSql?.sql).not.toMatch(/desired_prompt/i)
    expect(tableSql?.sql).toMatch(/desired_state[^,]*CHECK[^)]*running/i)
    expect(tableSql?.sql).toMatch(/desired_state[^,]*CHECK[^)]*paused/i)
    expect(tableSql?.sql).toMatch(/desired_state[^,]*CHECK[^)]*cancelled/i)
    firstDb.exec('PRAGMA foreign_keys = ON')
    expect(() => firstDb.prepare(`INSERT INTO assistant_cron_bindings
      (commitment_id, external_ref, desired_schedule_json, desired_state, created_at, updated_at)
      VALUES ('missing-commitment', 'external:missing', '{}', 'running', ?, ?)`)
      .run(NOW, NOW)).toThrow()
    firstDb.prepare(`INSERT INTO assistant_cron_bindings
      (commitment_id, external_ref, desired_schedule_json, desired_state, created_at, updated_at)
      VALUES ('monitor-v3', 'external:new', '{}', 'running', ?, ?)`)
      .run(NOW, NOW)
    expect(() => firstDb.prepare(`INSERT INTO assistant_cron_bindings
      (commitment_id, external_ref, desired_schedule_json, desired_state, created_at, updated_at)
      VALUES ('monitor-v3', 'external:other', '{}', 'running', ?, ?)`)
      .run(NOW, NOW)).toThrow()
    expect(() => firstDb.prepare(`INSERT INTO assistant_cron_bindings
      (commitment_id, external_ref, desired_schedule_json, desired_state, created_at, updated_at)
      VALUES ('focus-v3', 'external:new', '{}', 'running', ?, ?)`)
      .run(NOW, NOW)).toThrow()
    firstDb.close()

    await migrateDatabaseToV4(path, { now: NOW })
    const secondDb = new DatabaseSync(path)
    expect(rowsHash(secondDb, 'commitments')).toBe(beforeCommitments)
    expect(rowsHash(secondDb, 'outbox')).toBe(beforeOutbox)
    expect(rowsHash(secondDb, 'web_observations')).toBe(beforeWebObservations)
    expect((secondDb.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'assistant_cron_bindings'").get() as { count: number }).count).toBe(1)
    secondDb.close()
  })

  it('uses v4 for a new empty assistant database instead of silently accepting v3', async () => {
    const storeModule = await loadStore()
    const schemaVersion = storeModule.ASSISTANT_SCHEMA_VERSION
    expect(schemaVersion, 'new assistant schema must be v4').toBe(4)
    if (schemaVersion !== 4) return
    const AssistantStore = storeModule.AssistantStore as new (path: string) => { close(): void }
    const path = tempPath()
    const store = new AssistantStore(path)
    store.close()
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(bindingColumns(db)).toEqual(expect.arrayContaining(['commitment_id', 'external_ref', 'desired_state', 'bound_job_id']))
    expect(bindingColumns(db)).not.toContain('desired_prompt')
    db.close()
  })

  it('keeps migration offline-only: the online store rejects an untouched v3 database', async () => {
    const path = tempPath()
    await seedV3(path)
    const storeModule = await loadStore()
    const schemaVersion = storeModule.ASSISTANT_SCHEMA_VERSION
    expect(schemaVersion, 'online store must be the v4 build under test').toBe(4)
    if (schemaVersion !== 4) return
    const AssistantStore = storeModule.AssistantStore as new (path: string) => { close(): void }
    expect(() => new AssistantStore(path)).toThrow(/offline migration|explicit.*migration|schema version/i)
  })
})
