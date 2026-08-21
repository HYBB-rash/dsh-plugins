import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASSISTANT_APPLICATION_ID,
  ASSISTANT_SCHEMA_VERSION,
  AssistantStore,
} from '../src/store.ts'
import { migrateDatabaseToV3, migrateDatabaseToV4 } from '../src/migration.ts'

const dirs: string[] = []
const NOW = '2026-08-16T02:00:00.000Z'

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-v2-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createV1(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA application_id = ${ASSISTANT_APPLICATION_ID};
    PRAGMA user_version = 1;
    CREATE TABLE commitments (
      id TEXT PRIMARY KEY, slot INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL,
      work_owner TEXT NOT NULL, status TEXT NOT NULL, next_action TEXT,
      accepted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, result TEXT, blocked_reason TEXT,
      check_in_minutes INTEGER, reminder_due_at TEXT, reminder_state TEXT NOT NULL,
      last_delivery_state TEXT, last_delivery_error TEXT, worker_session_id TEXT,
      worker_parent_session_id TEXT, worker_run_id TEXT, worker_control_state TEXT NOT NULL,
      source_surface TEXT NOT NULL, source_session_id TEXT, revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id),
      kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      claimed_at TEXT, claim_token TEXT, delivered_at TEXT, error TEXT
    ) STRICT;
  `)
  const insert = db.prepare(`INSERT INTO commitments VALUES
    (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  insert.run('u1', 'focus legacy', 'user', 'active', null, NOW, NOW, NOW, NOW, null, null, null, 15,
    '2026-08-16T02:15:00.000Z', 'scheduled', null, null, null, null, null, 'none', 'web', 'web-1', 1)
  insert.run('a1', 'agent legacy', 'agent', 'paused', null, NOW, NOW, NOW, NOW, null, null, null, null,
    null, 'none', null, null, 'child-1', 'session-telegram', 'run-1', 'none', 'telegram', null, 2)
  db.prepare(`INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'o1', 'a1', 'blocked', 'legacy outbox', 'failed', NOW, null, null, null, 'x',
  )
  db.close()
}

describe('current schema v4 and explicit legacy migration', () => {
  it('creates schema v4 with the Cron binding projection for an empty database', () => {
    const path = tempPath()
    const store = new AssistantStore(path)
    expect(ASSISTANT_SCHEMA_VERSION).toBe(4)
    expect(store.listOpen()).toEqual([])
    store.close()
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_cron_bindings'").get()).toMatchObject({ name: 'assistant_cron_bindings' })
    expect(db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings') WHERE name = 'desired_prompt'").all()).toHaveLength(0)
    db.close()
  })

  it('normal open rejects v1 without changing its bytes', () => {
    const path = tempPath()
    createV1(path)
    const before = sha(path)
    expect(() => new AssistantStore(path)).toThrow(/schema version 1.*offline migration/i)
    expect(sha(path)).toBe(before)
  })

  it('migrates v1 losslessly and maps owners without guessing monitor', () => {
    const path = tempPath()
    createV1(path)
    const result = migrateDatabaseToV3(path)
    expect(result).toMatchObject({ from: 1, to: 3, commitments: 2, outbox: 1 })
    const v4 = migrateDatabaseToV4(path)
    expect(v4).toMatchObject({ from: 3, to: 4, bindings: 0 })
    const store = new AssistantStore(path)
    expect(store.getById('u1')).toMatchObject({ kind: 'focus', workOwner: 'user', sourceSessionId: 'web-1' })
    expect(store.getById('a1')).toMatchObject({ kind: 'delegated', workOwner: 'agent', sourceSessionId: null })
    expect(store.getOutbox('o1')).toMatchObject({ text: 'legacy outbox', state: 'failed' })
    store.close()
  })

  it('reclassifies only one explicitly identified legacy Agent row as a desired-running monitor', () => {
    const path = tempPath()
    createV1(path)
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO commitments VALUES
      (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'a2', 'ordinary delegated work', 'agent', 'paused', null, NOW, NOW, NOW, NOW, null, null, null, null,
      null, 'none', null, null, 'child-2', 'session-telegram', 'run-2', 'none', 'telegram', null, 1,
    )
    db.close()
    expect(migrateDatabaseToV3(path, { monitorId: 'a1' })).toMatchObject({ from: 1, to: 3, commitments: 3, outbox: 1 })
    expect(migrateDatabaseToV4(path)).toMatchObject({ from: 3, to: 4, bindings: 0 })
    const store = new AssistantStore(path)
    expect(store.getById('a1')).toMatchObject({
      kind: 'monitor', workOwner: 'agent', monitorDesiredState: 'running', monitorResumeState: 'needed',
      workerSessionId: 'child-1', status: 'paused',
    })
    expect(store.getById('a2')).toMatchObject({
      kind: 'delegated', monitorDesiredState: 'none', monitorResumeState: 'none',
    })
    store.close()
  })

  for (const invalid of [
    { name: 'missing id', monitorId: 'missing', message: /does not exist/ },
    { name: 'user-owned id', monitorId: 'u1', message: /not Agent-owned/ },
  ]) {
    it(`rejects a ${invalid.name} monitor override and rolls the whole migration back`, () => {
      const path = tempPath()
      createV1(path)
      expect(() => migrateDatabaseToV3(path, { monitorId: invalid.monitorId })).toThrow(invalid.message)
      const after = new DatabaseSync(path)
      expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
      expect((after.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(2)
      expect((after.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('commitments') WHERE name='slot'").get() as { n: number }).n).toBe(1)
      expect((after.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('commitments_v2','outbox_v2','web_observations')").get() as { n: number }).n).toBe(0)
      after.close()
    })
  }

  it('rolls a failed migration fully back to the original v1 schema and rows', () => {
    const path = tempPath()
    createV1(path)
    const db = new DatabaseSync(path)
    db.prepare(`INSERT INTO commitments VALUES
      (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'a2', 'duplicate child', 'agent', 'active', null, NOW, NOW, NOW, NOW, null, null, null, null,
      null, 'none', null, null, 'child-1', 'session-telegram', 'run-2', 'none', 'telegram', null, 1,
    )
    db.close()
    expect(() => migrateDatabaseToV3(path)).toThrow(/UNIQUE constraint failed: commitments.worker_session_id/)
    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect((after.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(3)
    expect((after.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('commitments') WHERE name = 'slot'").get() as { n: number }).n).toBe(1)
    expect((after.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('commitments_v2','outbox_v2','web_observations')").get() as { n: number }).n).toBe(0)
    after.close()
  })
})

describe('multiple responsibilities', () => {
  it('allows one focus plus concurrent delegated and monitor responsibilities', () => {
    const store = new AssistantStore(tempPath())
    expect(store.createUserCommitment({ title: 'focus', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(true)
    expect(store.createAgentCommitment({ title: 'delegated one', kind: 'delegated', sourceSurface: 'telegram', now: NOW }).ok).toBe(true)
    expect(store.createAgentCommitment({ title: 'delegated two', kind: 'delegated', sourceSurface: 'telegram', now: NOW }).ok).toBe(true)
    expect(store.createAgentCommitment({ title: 'monitor', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW }).ok).toBe(true)
    expect(store.listOpen()).toHaveLength(4)
    expect(store.getOpenFocus()?.title).toBe('focus')
    expect(store.listTelegramAgentResponsibilities(10)).toHaveLength(3)
    const second = store.createUserCommitment({ title: 'second focus', status: 'active', sourceSurface: 'telegram', now: NOW })
    expect(second).toMatchObject({ ok: false, code: 'current_commitment_exists' })
    expect(store.listOpen()).toHaveLength(4)
    store.close()
  })

  it('records progress atomically by worker and message identity', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'work', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-progress', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('identity failed')
    expect(store.recordWorkerProgress('child-progress', 'message-1', '完成第一阶段', NOW)).toEqual({ inserted: true })
    const revision = store.getById(created.row.id)!.revision
    expect(store.recordWorkerProgress('child-progress', 'message-1', '重复', NOW)).toEqual({ inserted: false })
    expect(store.getById(created.row.id)).toMatchObject({ progressSummary: '完成第一阶段', progressAt: NOW, revision })
    expect(store.getOutbox('progress:child-progress:message-1')).toMatchObject({
      kind: 'progress', text: '🔄 进展：work\n\n完成第一阶段',
    })
    expect(store.recordWorkerProgress('child-progress', 'message-2', '完成第一阶段', NOW)).toEqual({ inserted: true })
    expect(store.listPendingOutbox()).toHaveLength(2)
    store.close()
  })

  it('labels out-of-order progress from concurrent children with its own responsibility title', () => {
    const store = new AssistantStore(tempPath())
    const first = store.createAgentCommitment({ title: '检查数据源', sourceSurface: 'telegram', now: NOW })
    const second = store.createAgentCommitment({ title: '修复发布脚本', sourceSurface: 'telegram', now: NOW })
    if (!first.ok || !second.ok) throw new Error('seed failed')
    const firstSaved = store.saveWorkerIdentity(first.row.id, first.row.revision, {
      workerSessionId: 'child-a', workerRunId: 'run-a', workerParentSessionId: 'session-telegram',
    })
    const secondSaved = store.saveWorkerIdentity(second.row.id, second.row.revision, {
      workerSessionId: 'child-b', workerRunId: 'run-b', workerParentSessionId: 'session-telegram',
    })
    if (!firstSaved.ok || !secondSaved.ok) throw new Error('identity failed')

    expect(store.recordWorkerProgress('child-b', 'report-1', '已进入集成测试', NOW)).toEqual({ inserted: true })
    expect(store.recordWorkerProgress('child-a', 'report-1', '已确认接口返回', NOW)).toEqual({ inserted: true })
    expect(store.recordWorkerProgress('child-b', 'report-1', '重放不应覆盖', NOW)).toEqual({ inserted: false })

    expect(store.listPendingOutbox().map(item => item.text)).toEqual([
      '🔄 进展：修复发布脚本\n\n已进入集成测试',
      '🔄 进展：检查数据源\n\n已确认接口返回',
    ])
    expect(store.getByWorkerSessionId('child-b')?.progressSummary).toBe('已进入集成测试')
    expect(store.getByWorkerSessionId('child-a')?.progressSummary).toBe('已确认接口返回')
    store.close()
  })

  it('parks and claims desired-running monitors for one cold resume epoch', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch repo', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-monitor', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    store.normalizeAgentOnStartup()
    let row = store.getById(created.row.id)!
    expect(row).toMatchObject({
      kind: 'monitor', status: 'paused', monitorDesiredState: 'running',
      monitorResumeState: 'needed', monitorResumeEpoch: 1,
    })
    const claim = store.claimMonitorResume(row.id, row.revision, 'claim-1', NOW)
    expect(claim.ok).toBe(true)
    if (!claim.ok) throw new Error('claim failed')
    expect(claim.row).toMatchObject({ status: 'active', workerControlState: 'resume_requested', monitorResumeState: 'claimed' })
    expect(store.claimMonitorResume(row.id, row.revision, 'claim-2', NOW).ok).toBe(false)
    const accepted = store.acceptResumedWorkerRun(claim.row.id, claim.row.revision, 'run-2')
    expect(accepted.ok).toBe(true)
    row = store.getById(row.id)!
    expect(row).toMatchObject({ workerRunId: 'run-2', workerControlState: 'none', monitorResumeState: 'none' })
    expect(row.monitorClaimToken).toBeNull()
    store.close()
  })
})
