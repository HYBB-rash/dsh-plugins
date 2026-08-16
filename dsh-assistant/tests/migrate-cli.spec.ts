import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_APPLICATION_ID } from '../src/store.ts'
import { runMigrationCli } from '../src/migrate-cli.ts'

const dirs: string[] = []

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

  it('migrates the explicit v1 path and emits a machine-readable result', () => {
    const path = emptyV1()
    const write = vi.fn()
    expect(runMigrationCli([path], write)).toEqual({ commitments: 0, outbox: 0 })
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ path, from: 1, to: 2, commitments: 0, outbox: 0 })}\n`)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    db.close()
  })
})
