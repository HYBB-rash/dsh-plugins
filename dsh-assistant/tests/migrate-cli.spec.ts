import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_APPLICATION_ID, AssistantStore } from '../src/store.ts'
import { runMigrationCli } from '../src/migrate-cli.ts'

const dirs: string[] = []
const NOW = '2026-08-18T02:00:00.000Z'

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function emptyV1(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-migrate-cli-'))
  dirs.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = ${ASSISTANT_APPLICATION_ID}; PRAGMA user_version = 1;
    CREATE TABLE commitments (
      id TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, work_owner TEXT NOT NULL,
      status TEXT NOT NULL, next_action TEXT, accepted_at TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, result TEXT, blocked_reason TEXT,
      check_in_minutes INTEGER, reminder_due_at TEXT, reminder_state TEXT NOT NULL, last_delivery_state TEXT,
      last_delivery_error TEXT, worker_session_id TEXT, worker_parent_session_id TEXT, worker_run_id TEXT,
      worker_control_state TEXT NOT NULL, source_surface TEXT NOT NULL, source_session_id TEXT, revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id), kind TEXT NOT NULL,
      text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT,
      delivered_at TEXT, error TEXT
    ) STRICT;
  `)
  db.close()
  return path
}

function tempPath(prefix = 'dsh-assistant-migrate-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

function createV2(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = ${ASSISTANT_APPLICATION_ID}; PRAGMA user_version = 2;
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
    CREATE TABLE web_observations (
      session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running','ended','abnormal','interrupted')),
      request_text TEXT, last_assistant_text TEXT, last_assistant_message_id TEXT,
      turn_reason TEXT, error_code TEXT, error_message TEXT, cwd TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      writer_instance_id TEXT NOT NULL, writer_started_at TEXT NOT NULL
    ) STRICT;
  `)
  db.prepare(`INSERT INTO commitments
    (id, kind, title, work_owner, status, accepted_at, created_at, updated_at, reminder_state,
     worker_control_state, monitor_desired_state, monitor_resume_state, monitor_resume_epoch,
     source_surface, revision)
    VALUES ('m1', 'monitor', '历史监控', 'agent', 'active', ?, ?, ?, 'none', 'none', 'running', 'none', 4, 'telegram', 4)`)
    .run(NOW, NOW, NOW)
  db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at)
    VALUES ('o1', 'm1', 'progress', '历史进度', 'failed', ?)`)
    .run(NOW)
  db.prepare(`INSERT INTO web_observations
    (session_id, turn, state, request_text, last_assistant_text, started_at, updated_at, writer_instance_id, writer_started_at)
    VALUES ('web-1', 1, 'ended', '历史请求', '历史回答', ?, ?, 'writer', ?)`)
    .run(NOW, NOW, NOW)
  db.close()
}

function createV3(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = ${ASSISTANT_APPLICATION_ID}; PRAGMA user_version = 3;
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
      monitor_direction TEXT, monitor_checkpoint TEXT,
      source_surface TEXT NOT NULL CHECK (source_surface IN ('web','telegram')),
      source_session_id TEXT, revision INTEGER NOT NULL,
      CHECK ((kind = 'focus' AND work_owner = 'user') OR (kind IN ('delegated','monitor') AND work_owner = 'agent'))
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id),
      kind TEXT NOT NULL CHECK (kind IN ('check_in','completed','blocked','missed_check_in','progress','monitor_event')),
      text TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed','uncertain','cancelled')),
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
    CREATE UNIQUE INDEX commitments_open_focus ON commitments(kind) WHERE kind = 'focus' AND status IN ('pending','active','paused','blocked');
    CREATE UNIQUE INDEX commitments_worker_session ON commitments(worker_session_id) WHERE worker_session_id IS NOT NULL;
    CREATE UNIQUE INDEX outbox_monitor_event_unique ON outbox(commitment_id, monitor_event_key) WHERE kind = 'monitor_event';
  `)
  db.prepare(`INSERT INTO commitments
    (id, kind, title, work_owner, status, accepted_at, created_at, updated_at, reminder_state,
     worker_control_state, monitor_desired_state, monitor_resume_state, monitor_resume_epoch,
     monitor_direction, source_surface, revision)
    VALUES ('m1', 'monitor', '历史监控', 'agent', 'active', ?, ?, ?, 'none', 'none', 'running', 'none', 4, '原方向', 'telegram', 4)`)
    .run(NOW, NOW, NOW)
  db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at)
    VALUES ('o1', 'm1', 'progress', '历史进度', 'failed', ?)`)
    .run(NOW)
  db.prepare(`INSERT INTO web_observations
    (session_id, turn, state, request_text, last_assistant_text, started_at, updated_at, writer_instance_id, writer_started_at)
    VALUES ('web-1', 1, 'ended', '历史请求', '历史回答', ?, ?, 'writer', ?)`)
    .run(NOW, NOW, NOW)
  db.close()
}

function prepareManifestFixture(path: string): void {
  const db = new DatabaseSync(path)
  db.prepare(`UPDATE commitments SET status = 'blocked', worker_session_id = NULL, worker_parent_session_id = NULL,
    worker_run_id = NULL, worker_control_state = 'none', monitor_desired_state = 'running',
    monitor_resume_state = 'none', monitor_claim_token = NULL, monitor_claimed_at = NULL, revision = 7
    WHERE id = 'm1'`).run()
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version === 3) {
    db.prepare(`UPDATE commitments SET monitor_direction = NULL, monitor_checkpoint = NULL WHERE id = 'm1'`).run()
  }
  db.prepare(`UPDATE outbox SET kind = 'completed', state = 'delivered', delivered_at = ?, error = NULL WHERE id = 'o1'`).run(NOW)
  db.close()
}

function recoveryManifest(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path)
  const row = db.prepare('SELECT text FROM outbox WHERE id = ?').get('o1') as { text: string }
  db.close()
  return {
    version: 1,
    recoveries: [{
      commitmentId: 'm1',
      commitmentAssert: {
        kind: 'monitor', workOwner: 'agent', status: 'blocked', revision: 7,
        workerSessionId: null, workerRunId: null, workerParentSessionId: null,
        workerControlState: 'none', monitorDesiredState: 'running', monitorResumeState: 'none',
        monitorResumeEpoch: 4, monitorClaimToken: null, monitorClaimedAt: null,
        monitorDirection: null, monitorCheckpoint: null,
      },
      direction: '新方向', checkpoint: 'cursor-1', outboxId: 'o1',
      outboxAssert: {
        kind: 'completed', state: 'delivered',
        textSha256: createHash('sha256').update(row.text).digest('hex'), deliveredAt: NOW,
      },
      event: { eventKey: 'legacy-event-1', checkpoint: 'cursor-1' },
    }],
  }
}

function manifestPath(value: unknown): string {
  const path = tempPath('dsh-assistant-migrate-cli-manifest-').replace(/state\.sqlite$/, 'manifest.json')
  writeFileSync(path, `${JSON.stringify(value)}\n`)
  return path
}

function semanticSnapshot(path: string): { version: number; commitments: unknown[]; outbox: unknown[]; web: unknown[] } {
  const db = new DatabaseSync(path)
  const snapshot = {
    version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    commitments: db.prepare('SELECT * FROM commitments ORDER BY id').all(),
    outbox: db.prepare('SELECT * FROM outbox ORDER BY id').all(),
    web: db.prepare('SELECT * FROM web_observations ORDER BY session_id').all(),
  }
  db.close()
  return snapshot
}

describe('offline migration CLI', () => {
  it('requires exactly one explicit database path', () => {
    expect(() => runMigrationCli([], vi.fn())).toThrow(/database path/)
    expect(() => runMigrationCli(['a', 'b'], vi.fn())).toThrow(/database path/)
  })

  it('rejects a repeated monitor override before touching the v1 database', () => {
    const path = emptyV1()
    expect(() => runMigrationCli([path, '--monitor-id', 'a1', '--monitor-id', 'a1'], vi.fn())).toThrow(/only once/)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    db.close()
  })

  it('rejects a historical recovery option before touching the v1 database', () => {
    const path = emptyV1()
    expect(() => runMigrationCli([path, '--historical-recovery', 'plan.json'], vi.fn())).toThrow(/unknown migration option: --historical-recovery/)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    db.close()
  })

  it('migrates the explicit v1 path and emits a machine-readable result', () => {
    const path = emptyV1()
    const write = vi.fn()
    expect(runMigrationCli([path], write)).toMatchObject({ from: 1, to: 4, commitments: 0, outbox: 0, webObservations: 0 })
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ path, from: 1, to: 4, commitments: 0, outbox: 0, webObservations: 0, reconciledCommitments: 0, reconciledOutboxEvents: 0 })}\n`)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    db.close()
  })

  it('accepts a legal v4 database as an exact no-op and still emits to=4', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-assistant-migrate-cli-v4-')), 'state.sqlite')
    dirs.push(path.slice(0, path.lastIndexOf('/')))
    const store = new AssistantStore(path)
    store.close()
    const write = vi.fn()
    expect(runMigrationCli([path], write)).toMatchObject({ from: 4, to: 4, alreadyAtTarget: true })
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"to":4'))
  })

  it('migrates v2 all the way to v4 and preserves useful counts in machine output', () => {
    const path = tempPath()
    createV2(path)
    const write = vi.fn()
    const result = runMigrationCli([path], write)
    expect(result).toMatchObject({ from: 2, to: 4, commitments: 1, outbox: 1, webObservations: 1 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      from: 2, to: 4, commitments: 1, outbox: 1, webObservations: 1,
      reconciledCommitments: 0, reconciledOutboxEvents: 0,
    })
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_cron_bindings'").get()).toMatchObject({ name: 'assistant_cron_bindings' })
    db.close()
  })

  it('migrates a true v3 database to v4 without guessing any old monitor binding', () => {
    const path = tempPath()
    createV3(path)
    const write = vi.fn()
    const result = runMigrationCli([path], write)
    expect(result).toMatchObject({ from: 3, to: 4, commitments: 1, outbox: 1, webObservations: 1 })
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ from: 3, to: 4, commitments: 1, outbox: 1, webObservations: 1 })
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_cron_bindings').get() as { n: number }).n).toBe(0)
    expect(db.prepare('SELECT monitor_direction, monitor_checkpoint FROM commitments WHERE id = ?').get('m1')).toMatchObject({ monitor_direction: '原方向', monitor_checkpoint: null })
    db.close()
  })

  it.each([
    ['v2', createV2],
    ['v3', createV3],
  ] as const)('applies a legal generic manifest during %s migration before reaching v4', (_label, seed) => {
    const path = tempPath()
    seed(path)
    prepareManifestFixture(path)
    const manifest = manifestPath(recoveryManifest(path))
    const write = vi.fn()
    const result = runMigrationCli([path, '--manifest', manifest], write)
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT status, monitor_direction, monitor_checkpoint, monitor_resume_state, monitor_resume_epoch, revision FROM commitments WHERE id = ?').get('m1')).toMatchObject({
      status: 'active', monitor_direction: '新方向', monitor_checkpoint: 'cursor-1', monitor_resume_state: 'needed', monitor_resume_epoch: 5, revision: 8,
    })
    expect(db.prepare('SELECT kind, state, monitor_event_key, monitor_proposed_checkpoint FROM outbox WHERE id = ?').get('o1')).toMatchObject({
      kind: 'monitor_event', state: 'delivered', monitor_event_key: 'legacy-event-1', monitor_proposed_checkpoint: 'cursor-1',
    })
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_cron_bindings'").get()).toMatchObject({ name: 'assistant_cron_bindings' })
    db.close()
    expect(result).toMatchObject({ from: _label === 'v2' ? 2 : 3, to: 4, reconciledCommitments: 1, reconciledOutboxEvents: 1 })
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ to: 4, reconciledCommitments: 1, reconciledOutboxEvents: 1 })
  })

  it.each([
    ['v2', createV2],
    ['v3', createV3],
  ] as const)('rejects an invalid manifest on %s without changing source version or business rows', (_label, seed) => {
    const path = tempPath()
    seed(path)
    const before = semanticSnapshot(path)
    const manifest = manifestPath({ version: 0, recoveries: [] })
    expect(() => runMigrationCli([path, '--manifest', manifest], vi.fn())).toThrow(/manifest version must be exactly 1/i)
    expect(semanticSnapshot(path)).toEqual(before)
  })

  it.each([
    ['--monitor-id', 'legacy-monitor'],
    ['--manifest', 'create-at-test-time'],
  ] as const)('explicitly rejects %s on v4 before any write', (option, value) => {
    const path = tempPath('dsh-assistant-migrate-cli-v4-')
    const store = new AssistantStore(path)
    store.close()
    const before = semanticSnapshot(path)
    const actualValue = option === '--manifest' ? manifestPath({ version: 1, recoveries: [] }) : value
    expect(() => runMigrationCli([path, option, actualValue], vi.fn())).toThrow(/v4|not valid|unsupported|only.*valid/i)
    expect(semanticSnapshot(path)).toEqual(before)
  })
})
