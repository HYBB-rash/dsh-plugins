import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASSISTANT_APPLICATION_ID,
  ASSISTANT_SCHEMA_VERSION,
  AssistantStore,
} from '../src/store.ts'
import { migrateDatabaseToV3, type ReconciliationManifest } from '../src/migration.ts'

const dirs: string[] = []
const NOW = '2026-08-18T02:00:00.000Z'

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-v3-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function eventKey(seed = 'event-1'): string {
  return `stable-event:${seed}`
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
    CREATE TABLE web_observations (
      session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('running','ended','abnormal','interrupted')),
      request_text TEXT, last_assistant_text TEXT, last_assistant_message_id TEXT,
      turn_reason TEXT, error_code TEXT, error_message TEXT, cwd TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      writer_instance_id TEXT NOT NULL, writer_started_at TEXT NOT NULL
    ) STRICT;
  `)
  db.prepare(`INSERT INTO commitments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'm1', 'monitor', 'watch', 'agent', 'active', null, NOW, NOW, NOW, null, null, null, null, null, null, 'none',
    null, null, 'child-1', 'root-1', 'run-1', 'none', 's', NOW, 'running', 'needed', 4, null, null, 'telegram', 'root-1', 4,
  )
  db.prepare(`INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)`).run('o1', 'm1', 'progress', 'progress', 'failed', NOW, null, null, null, 'old')
  db.prepare(`INSERT INTO web_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'web-1', 1, 'ended', 'request', 'answer', 'message', 'completed', null, null, '/tmp', NOW, NOW, NOW, 'writer', NOW,
  )
  db.close()
}

function prepareRecoveryFixture(path: string): { readonly textSha256: string; readonly revision: number; readonly epoch: number } {
  const db = new DatabaseSync(path)
  db.prepare(`UPDATE commitments SET status = 'blocked', worker_session_id = NULL, worker_parent_session_id = NULL,
    worker_run_id = NULL, worker_control_state = 'none', monitor_desired_state = 'running',
    monitor_resume_state = 'none', monitor_claim_token = NULL, monitor_claimed_at = NULL, revision = 7 WHERE id = 'm1'`).run()
  db.prepare(`UPDATE outbox SET kind = 'completed', state = 'delivered', delivered_at = ?, error = NULL WHERE id = 'o1'`).run(NOW)
  const row = db.prepare('SELECT text FROM outbox WHERE id = ?').get('o1') as { text: string }
  db.close()
  return { textSha256: createHash('sha256').update(row.text).digest('hex'), revision: 7, epoch: 4 }
}

function recoveryManifest(textSha256: string, revision = 7, epoch = 4): ReconciliationManifest {
  return {
    version: 1,
    recoveries: [{
      commitmentId: 'm1',
      commitmentAssert: {
        kind: 'monitor', workOwner: 'agent', status: 'blocked', revision,
        workerSessionId: null, workerRunId: null, workerParentSessionId: null,
        workerControlState: 'none', monitorDesiredState: 'running', monitorResumeState: 'none',
        monitorResumeEpoch: epoch, monitorClaimToken: null, monitorClaimedAt: null,
        monitorDirection: null, monitorCheckpoint: null,
      },
      direction: 'watch-current-v2',
      checkpoint: 'cursor-1',
      outboxId: 'o1',
      outboxAssert: { kind: 'completed', state: 'delivered', textSha256, deliveredAt: NOW },
      event: { eventKey: 'legacy-event-1', checkpoint: 'cursor-1' },
    }],
  }
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('schema v3 monitor storage', () => {
  it('creates current schema v4 with the four monitor event columns and Cron binding projection', () => {
    const path = tempPath()
    const store = new AssistantStore(path)
    store.close()
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_cron_bindings'").get()).toMatchObject({ name: 'assistant_cron_bindings' })
    expect(db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings') WHERE name = 'desired_prompt'").all()).toHaveLength(0)
    expect(db.prepare("SELECT name FROM pragma_table_info('commitments') WHERE name IN ('monitor_direction','monitor_checkpoint') ORDER BY name").all()).toHaveLength(2)
    expect(db.prepare("SELECT name FROM pragma_table_info('outbox') WHERE name IN ('monitor_event_key','monitor_proposed_checkpoint') ORDER BY name").all()).toHaveLength(2)
    const index = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='outbox_monitor_event_unique'").get() as { sql: string } | undefined
    expect(index?.sql).toMatch(/UNIQUE INDEX/i)
    expect(index?.sql).toMatch(/commitment_id\s*,\s*monitor_event_key/i)
    expect(index?.sql).toMatch(/kind\s*=\s*'monitor_event'/i)
    db.close()
  })

  it('enforces monitor-only direction and event-only outbox metadata', () => {
    const path = tempPath()
    const store = new AssistantStore(path)
    expect(store.createAgentCommitment({ title: 'missing direction', kind: 'monitor', sourceSurface: 'telegram', now: NOW })).toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(store.createAgentCommitment({ title: 'delegated metadata', kind: 'delegated', monitorDirection: 'not allowed', sourceSurface: 'telegram', now: NOW })).toMatchObject({ ok: false, code: 'invalid_transition' })
    const delegated = store.createAgentCommitment({ title: 'delegated', kind: 'delegated', sourceSurface: 'telegram', now: NOW })
    if (!delegated.ok) throw new Error('seed failed')
    expect(() => store.insertOutbox({ id: 'illegal-event', commitmentId: delegated.row.id, kind: 'monitor_event', text: 'x', createdAt: NOW })).toThrow(/settleMonitorEvent/)
    store.close()
    const db = new DatabaseSync(path)
    expect(() => db.prepare(`INSERT INTO outbox (id, commitment_id, kind, text, state, created_at, monitor_event_key, monitor_proposed_checkpoint)
      VALUES ('bad-event', ?, 'monitor_event', 'x', 'pending', ?, NULL, NULL)`).run(delegated.row.id, NOW)).toThrow(/CHECK constraint/i)
    db.close()
  })

  it('settles a monitor event once, keeps monitor running, and unbinds the worker', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const settled = store.settleMonitorEvent({
      commitmentId: created.row.id,
      expectedRevision: active.row.revision,
      workerSessionId: 'child-1', workerParentSessionId: 'root-1', workerRunId: 'run-1',
      monitorResumeEpoch: active.row.monitorResumeEpoch,
      eventKey: eventKey(), checkpoint: '{"cursor":1}', summary: '看到新事件',
      outboxText: '监控更新：看到新事件', now: NOW,
    })
    expect(settled.ok).toBe(true)
    if (!settled.ok) throw new Error('settlement failed')
    expect(settled.row).toMatchObject({
      kind: 'monitor', status: 'active', monitorDesiredState: 'running',
      workerSessionId: null, workerRunId: null, monitorCheckpoint: null,
    })
    expect(settled.outbox).toMatchObject({ kind: 'monitor_event', state: 'pending', monitorProposedCheckpoint: '{"cursor":1}' })
    expect(store.listMonitorEventOutbox(created.row.id)).toHaveLength(1)
    expect(store.listPendingOutbox()).toHaveLength(1)
    store.close()
  })

  it('same monitor event key across runs does not create or send another outbox', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const first = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!first.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, first.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const key = eventKey('same')
    const one = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: active.row.revision,
      workerSessionId: 'child-1', workerParentSessionId: 'root-1', workerRunId: 'run-1',
      monitorResumeEpoch: active.row.monitorResumeEpoch, eventKey: key,
      checkpoint: 'one', summary: 'first', outboxText: 'first', now: NOW,
    })
    if (!one.ok) throw new Error('first event failed')
    store.finishOutbox(one.outbox.id, 'failed', { error: 'already observed' })
    const resumed = store.claimFreshMonitor(created.row.id, store.getById(created.row.id)!.revision, 'claim-1', NOW)
    if (!resumed.ok) throw new Error('fresh claim failed')
    const second = store.saveMonitorWorkerIdentity(created.row.id, resumed.row.revision, 'claim-1', resumed.row.monitorResumeEpoch, {
      workerSessionId: 'child-2', workerRunId: 'run-2', workerParentSessionId: 'root-1',
    })
    if (!second.ok) throw new Error('second identity failed')
    const duplicate = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: second.row.revision,
      workerSessionId: 'child-2', workerParentSessionId: 'root-1', workerRunId: 'run-2',
      monitorResumeEpoch: second.row.monitorResumeEpoch, eventKey: key,
      checkpoint: 'different', summary: 'duplicate', outboxText: 'duplicate', now: NOW,
    })
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error('duplicate failed')
    expect(duplicate.duplicate).toBe(true)
    expect(store.listPendingOutbox()).toHaveLength(0)
    expect(store.getOutboxByMonitorEventKey(created.row.id, key)?.monitorProposedCheckpoint).toBe('one')
    store.close()
  })

  it('delivered advances checkpoint and requests the next monitor round', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const settled = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: active.row.revision,
      workerSessionId: 'child-1', workerParentSessionId: 'root-1', workerRunId: 'run-1',
      monitorResumeEpoch: active.row.monitorResumeEpoch, eventKey: eventKey(),
      checkpoint: 'confirmed', summary: 's', outboxText: 's', now: NOW,
    })
    if (!settled.ok) throw new Error('settlement failed')
    store.finishOutbox(settled.outbox.id, 'delivered', { deliveredAt: NOW })
    expect(store.getById(created.row.id)).toMatchObject({
      monitorCheckpoint: 'confirmed', monitorResumeState: 'needed', status: 'active', monitorDesiredState: 'running',
    })
    store.close()
  })

  it('failed, uncertain, and stale claimed monitor events do not advance checkpoint but request resume', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const settled = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: active.row.revision,
      workerSessionId: 'child-1', workerParentSessionId: 'root-1', workerRunId: 'run-1',
      monitorResumeEpoch: active.row.monitorResumeEpoch, eventKey: eventKey(),
      checkpoint: 'must-not-confirm', summary: 's', outboxText: 's', now: NOW,
    })
    if (!settled.ok) throw new Error('settlement failed')
    store.finishOutbox(settled.outbox.id, 'failed', { error: 'no send' })
    expect(store.getById(created.row.id)).toMatchObject({ monitorCheckpoint: null, monitorResumeState: 'needed' })
    const claim = store.claimFreshMonitor(created.row.id, store.getById(created.row.id)!.revision, 'claim-2', NOW)
    if (!claim.ok) throw new Error('claim failed')
    const identity = store.saveMonitorWorkerIdentity(created.row.id, claim.row.revision, 'claim-2', claim.row.monitorResumeEpoch, {
      workerSessionId: 'child-2', workerRunId: 'run-2', workerParentSessionId: 'root-1',
    })
    if (!identity.ok) throw new Error('identity failed')
    const second = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: identity.row.revision,
      workerSessionId: 'child-2', workerParentSessionId: 'root-1', workerRunId: 'run-2',
      monitorResumeEpoch: identity.row.monitorResumeEpoch, eventKey: eventKey('uncertain'),
      checkpoint: 'also-not-confirmed', summary: 's', outboxText: 's', now: NOW,
    })
    if (!second.ok) throw new Error('second settlement failed')
    const claimed = store.claimOutbox(second.outbox.id, NOW)
    expect(claimed.ok).toBe(true)
    store.markStaleClaimed()
    expect(store.getById(created.row.id)).toMatchObject({ monitorCheckpoint: null, monitorResumeState: 'needed' })
    expect(store.getOutbox(second.outbox.id)?.state).toBe('uncertain')
    store.close()
  })

  it('rejects stale worker identity and leaves every row unchanged', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const before = store.getById(created.row.id)!
    const stale = store.settleMonitorEvent({
      commitmentId: created.row.id, expectedRevision: before.revision,
      workerSessionId: 'child-1', workerParentSessionId: 'root-1', workerRunId: 'old-run',
      monitorResumeEpoch: before.monitorResumeEpoch, eventKey: eventKey(),
      checkpoint: 'x', summary: 'stale', outboxText: 'stale', now: NOW,
    })
    expect(stale.ok).toBe(false)
    expect(store.getById(created.row.id)).toEqual(before)
    expect(store.listPendingOutbox()).toEqual([])
    store.close()
  })

  it('direction replacement persists before returning the old worker identity', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const replaced = store.replaceMonitorDirection(created.row.id, active.row.revision, '{"scope":"new"}', NOW)
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) throw new Error('replacement failed')
    expect(replaced.oldWorker).toEqual({ workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1' })
    expect(store.getById(created.row.id)).toMatchObject({ monitorDirection: '{"scope":"new"}', workerSessionId: 'child-1', workerRunId: 'run-1', workerControlState: 'pause_requested', status: 'active' })
    expect(store.recordWorkerProgress('child-1', 'late-direction-report', 'must not persist', NOW)).toEqual({ inserted: false })
    expect(store.listPendingOutbox()).toEqual([])
    store.close()
  })

  it('does not persist reports after a monitor pause request', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const paused = store.pauseAgent(created.row.id, active.row.revision)
    if (!paused.ok) throw new Error('pause failed')
    expect(paused.row.workerControlState).toBe('pause_requested')
    expect(store.recordWorkerProgress('child-1', 'late-pause-report', 'must not persist', NOW)).toEqual({ inserted: false })
    expect(store.listPendingOutbox()).toEqual([])
    expect(store.getById(created.row.id)).toMatchObject({ progressSummary: null, progressAt: null })
    store.close()
  })

  it('keeps direction-only edits paused, while explicit monitor resume wins a pause race', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'old', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const paused = store.pauseAgent(created.row.id, active.row.revision)
    if (!paused.ok) throw new Error('pause failed')
    const resumed = store.requestMonitorResume(created.row.id, paused.row.revision, 'new', NOW)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw new Error('resume request failed')
    expect(resumed.row).toMatchObject({ status: 'active', monitorDesiredState: 'running', monitorResumeState: 'none', workerControlState: 'pause_requested', workerSessionId: 'child-1', monitorDirection: 'new' })
    const stopped = store.confirmMonitorFreshStop(created.row.id, resumed.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    expect(stopped.ok).toBe(true)
    expect(store.getById(created.row.id)).toMatchObject({ status: 'active', monitorDesiredState: 'running', monitorResumeState: 'needed', workerSessionId: null })

    const pausedNoWorker = store.pauseAgent(created.row.id, store.getById(created.row.id)!.revision)
    expect(pausedNoWorker.ok).toBe(true)
    if (!pausedNoWorker.ok) throw new Error('second pause failed')
    const editedOnly = store.replaceMonitorDirection(created.row.id, pausedNoWorker.row.revision, 'direction-only', NOW)
    expect(editedOnly.ok).toBe(true)
    if (!editedOnly.ok) throw new Error('direction-only edit failed')
    expect(editedOnly.row).toMatchObject({ status: 'paused', monitorDesiredState: 'paused', monitorResumeState: 'none', workerSessionId: null, monitorDirection: 'direction-only' })
    store.close()
  })

  it('clears a blocked monitor worker identity in the worker-end transaction', () => {
    const store = new AssistantStore(tempPath())
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'root-1',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const blocked = store.settleWorkerEnd(created.row.id, active.row.revision, {
      status: 'blocked', result: 'invalid worker result', blockedReason: 'protocol error',
      completedAt: NOW, workerRunId: 'run-1', outboxId: 'worker:m1:run-1', outboxText: 'blocked',
    })
    expect(blocked.ok).toBe(true)
    expect(store.getById(created.row.id)).toMatchObject({ status: 'blocked', monitorResumeState: 'none', workerSessionId: null, workerRunId: null, workerParentSessionId: null, workerControlState: 'none', monitorClaimToken: null })
    store.close()
  })

  it('normal open rejects v2 and explicit migration is idempotent', () => {
    const path = tempPath()
    createV2(path)
    expect(() => new AssistantStore(path)).toThrow(/schema version 2.*offline migration/i)
    const first = migrateDatabaseToV3(path)
    expect(first).toMatchObject({ from: 2, to: 3, commitments: 1, outbox: 1, webObservations: 1 })
    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect((after.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(1)
    expect((after.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(1)
    expect((after.prepare('SELECT COUNT(*) AS n FROM web_observations').get() as { n: number }).n).toBe(1)
    after.close()
    const second = migrateDatabaseToV3(path)
    expect(second).toMatchObject({ from: 3, to: 3, alreadyAtTarget: true })
  })

  it('reclassifies one existing delivered v2 outbox row with a paired manifest and is post-state idempotent', () => {
    const path = tempPath()
    createV2(path)
    const fixture = prepareRecoveryFixture(path)
    const manifest = recoveryManifest(fixture.textSha256, fixture.revision, fixture.epoch)
    const first = migrateDatabaseToV3(path, { manifest })
    expect(first).toMatchObject({ from: 2, to: 3, commitments: 1, outbox: 1, webObservations: 1, reconciledCommitments: 1, reconciledOutboxEvents: 1 })
    const db = new DatabaseSync(path)
    const commitmentAfter = db.prepare('SELECT status, monitor_direction, monitor_checkpoint, monitor_resume_state, monitor_resume_epoch, revision FROM commitments WHERE id = ?').get('m1') as Record<string, unknown>
    const outboxAfter = db.prepare('SELECT commitment_id, kind, state, monitor_event_key, monitor_proposed_checkpoint, text, delivered_at FROM outbox WHERE id = ?').get('o1') as Record<string, unknown>
    expect(commitmentAfter).toMatchObject({ status: 'active', monitor_direction: 'watch-current-v2', monitor_checkpoint: 'cursor-1', monitor_resume_state: 'needed', monitor_resume_epoch: 5, revision: 8 })
    expect(outboxAfter).toMatchObject({ commitment_id: 'm1', kind: 'monitor_event', state: 'delivered', monitor_event_key: 'legacy-event-1', monitor_proposed_checkpoint: 'cursor-1', delivered_at: NOW })
    const counts = {
      commitments: (db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n,
      outbox: (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n,
      web: (db.prepare('SELECT COUNT(*) AS n FROM web_observations').get() as { n: number }).n,
    }
    db.close()

    const second = migrateDatabaseToV3(path, { manifest })
    expect(second).toMatchObject({ from: 3, to: 3, alreadyAtTarget: true, reconciledCommitments: 0, reconciledOutboxEvents: 0 })
    const afterSecond = new DatabaseSync(path)
    expect(afterSecond.prepare('SELECT status, monitor_direction, monitor_checkpoint, monitor_resume_state, monitor_resume_epoch, revision FROM commitments WHERE id = ?').get('m1')).toEqual(commitmentAfter)
    expect(afterSecond.prepare('SELECT commitment_id, kind, state, monitor_event_key, monitor_proposed_checkpoint, text, delivered_at FROM outbox WHERE id = ?').get('o1')).toEqual(outboxAfter)
    expect((afterSecond.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(counts.commitments)
    expect((afterSecond.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(counts.outbox)
    expect((afterSecond.prepare('SELECT COUNT(*) AS n FROM web_observations').get() as { n: number }).n).toBe(counts.web)
    afterSecond.close()
  })

  it('canonicalizes bounded manifest whitespace and remains idempotent', () => {
    const path = tempPath()
    createV2(path)
    const fixture = prepareRecoveryFixture(path)
    const manifest = recoveryManifest(fixture.textSha256, fixture.revision, fixture.epoch) as unknown as {
      recoveries: Array<{ direction: string; checkpoint: string; event: { eventKey: string; checkpoint: string } }>
    }
    manifest.recoveries[0]!.direction = ' watch-current-v2 '
    manifest.recoveries[0]!.checkpoint = ' cursor-1 '
    manifest.recoveries[0]!.event.eventKey = ' legacy-event-1 '
    manifest.recoveries[0]!.event.checkpoint = ' cursor-1 '
    const first = migrateDatabaseToV3(path, { manifest: manifest as unknown as ReconciliationManifest })
    expect(first).toMatchObject({ reconciledCommitments: 1, reconciledOutboxEvents: 1 })
    const second = migrateDatabaseToV3(path, { manifest: manifest as unknown as ReconciliationManifest })
    expect(second).toMatchObject({ reconciledCommitments: 0, reconciledOutboxEvents: 0 })
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT monitor_direction, monitor_checkpoint FROM commitments WHERE id = ?').get('m1')).toEqual({ monitor_direction: 'watch-current-v2', monitor_checkpoint: 'cursor-1' })
    expect(db.prepare('SELECT monitor_event_key, monitor_proposed_checkpoint FROM outbox WHERE id = ?').get('o1')).toEqual({ monitor_event_key: 'legacy-event-1', monitor_proposed_checkpoint: 'cursor-1' })
    db.close()
  })

  it('rejects a delivered manifest assertion mismatch and leaves the real v2 database untouched', () => {
    const path = tempPath()
    createV2(path)
    const fixture = prepareRecoveryFixture(path)
    const manifest = recoveryManifest('0'.repeat(64), fixture.revision, fixture.epoch)
    expect(() => migrateDatabaseToV3(path, { manifest })).toThrow(/outbox assertion mismatch|textSha256/i)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('commitments_v3','outbox_v3','web_observations_v3')").all()).toHaveLength(0)
    expect(db.prepare('SELECT * FROM commitments WHERE id = ?').get('m1')).toMatchObject({ status: 'blocked', revision: fixture.revision, worker_session_id: null })
    expect(db.prepare('SELECT * FROM outbox WHERE id = ?').get('o1')).toMatchObject({ kind: 'completed', state: 'delivered' })
    db.close()
  })

  it('rejects non-delivered reclassification and malformed paired rows before any write', () => {
    const path = tempPath()
    createV2(path)
    const fixture = prepareRecoveryFixture(path)
    const pendingManifest = recoveryManifest(fixture.textSha256, fixture.revision, fixture.epoch)
    ;(pendingManifest.recoveries[0]!.outboxAssert as { state: 'delivered' }).state = 'pending'
    expect(() => migrateDatabaseToV3(path, { manifest: pendingManifest })).toThrow(/must assert delivered/i)
    const missingPair = { version: 1, recoveries: [{ commitmentId: 'm1' }] } as unknown as ReconciliationManifest
    expect(() => migrateDatabaseToV3(path, { manifest: missingPair })).toThrow(/missing/i)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v3'").all()).toHaveLength(0)
    db.close()
  })

  it('requires delivered checkpoint and event checkpoint to match, with exact blocked pre-state', () => {
    const path = tempPath()
    createV2(path)
    const fixture = prepareRecoveryFixture(path)
    const mismatchedCheckpoint = recoveryManifest(fixture.textSha256, fixture.revision, fixture.epoch) as unknown as {
      version: 1
      recoveries: Array<{ checkpoint: string; commitmentAssert: { status: string; monitorDirection: string | null; monitorCheckpoint: string | null }; event: { checkpoint: string } }>
    }
    mismatchedCheckpoint.recoveries[0]!.checkpoint = 'different-cursor'
    expect(() => migrateDatabaseToV3(path, { manifest: mismatchedCheckpoint as unknown as ReconciliationManifest })).toThrow(/event checkpoint must equal/i)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v3'").all()).toHaveLength(0)
    db.close()

    const oldDirectionPath = tempPath()
    createV2(oldDirectionPath)
    const oldDirectionFixture = prepareRecoveryFixture(oldDirectionPath)
    const oldDirection = recoveryManifest(oldDirectionFixture.textSha256, oldDirectionFixture.revision, oldDirectionFixture.epoch) as unknown as {
      recoveries: Array<{ commitmentAssert: { status: string; monitorDirection: string | null; monitorCheckpoint: string | null } }>
    }
    oldDirection.recoveries[0]!.commitmentAssert.monitorDirection = 'unexpected-old-direction'
    expect(() => migrateDatabaseToV3(oldDirectionPath, { manifest: oldDirection as unknown as ReconciliationManifest })).toThrow(/commitment.*monitorDirection/i)
    const oldDirectionDb = new DatabaseSync(oldDirectionPath)
    expect((oldDirectionDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    oldDirectionDb.close()

    const cancelledPath = tempPath()
    createV2(cancelledPath)
    const cancelledFixture = prepareRecoveryFixture(cancelledPath)
    const cancelled = recoveryManifest(cancelledFixture.textSha256, cancelledFixture.revision, cancelledFixture.epoch) as unknown as {
      recoveries: Array<{ commitmentAssert: { status: string; monitorDirection: string | null; monitorCheckpoint: string | null } }>
    }
    cancelled.recoveries[0]!.commitmentAssert.status = 'cancelled'
    expect(() => migrateDatabaseToV3(cancelledPath, { manifest: cancelled as unknown as ReconciliationManifest })).toThrow(/must assert blocked/i)
    const cancelledDb = new DatabaseSync(cancelledPath)
    expect((cancelledDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    cancelledDb.close()
  })

  it('requires a manifest version and rejects unknown top-level fields without writing v3', () => {
    const path = tempPath()
    createV2(path)
    expect(migrateDatabaseToV3(path), 'create a real v3 fixture from v2').toMatchObject({ from: 2, to: 3 })
    const before = sha(path)
    const missingVersion = { recoveries: [] } as unknown as ReconciliationManifest
    expect(() => migrateDatabaseToV3(path, { manifest: missingVersion })).toThrow(/version must be exactly 1/i)
    const unknownField = { version: 1, recoveries: [], extra: true } as unknown as ReconciliationManifest
    expect(() => migrateDatabaseToV3(path, { manifest: unknownField })).toThrow(/unknown reconciliation manifest field/i)
    expect(sha(path)).toBe(before)
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect((db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM web_observations').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('rejects the legacy monitor-id override on v2 and v3 instead of silently ignoring it', () => {
    const v2Path = tempPath()
    createV2(v2Path)
    expect(() => migrateDatabaseToV3(v2Path, { monitorId: 'm1' })).toThrow(/only valid for v1/i)
    const v2 = new DatabaseSync(v2Path)
    expect((v2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    v2.close()

    const v3Path = tempPath()
    createV2(v3Path)
    expect(migrateDatabaseToV3(v3Path), 'create a real v3 fixture from v2').toMatchObject({ from: 2, to: 3 })
    const beforeV3 = sha(v3Path)
    expect(() => migrateDatabaseToV3(v3Path, { monitorId: 'm1' })).toThrow(/only valid for v1/i)
    const v3 = new DatabaseSync(v3Path)
    expect((v3.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    v3.close()
    expect(sha(v3Path)).toBe(beforeV3)
  })

  it('exposes the latest monitor event directly and returns every failed or uncertain key', () => {
    const path = tempPath()
    const store = new AssistantStore(path)
    const created = store.createAgentCommitment({ title: 'watch', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.insertOutbox({ id: 'failed-1', commitmentId: created.row.id, kind: 'completed', text: 'one', createdAt: NOW })
    store.insertOutbox({ id: 'failed-2', commitmentId: created.row.id, kind: 'completed', text: 'two', createdAt: NOW })
    // These rows are ordinary test fixtures; monitor_event rows themselves
    // are only creatable by settleMonitorEvent.
    const db = new DatabaseSync(path)
    db.prepare("UPDATE outbox SET kind='monitor_event', monitor_event_key=?, monitor_proposed_checkpoint=?, state='failed' WHERE id=?").run('old-1', 'cp-1', 'failed-1')
    db.prepare("UPDATE outbox SET kind='monitor_event', monitor_event_key=?, monitor_proposed_checkpoint=?, state='uncertain' WHERE id=?").run('old-2', 'cp-2', 'failed-2')
    db.close()
    expect(store.listMonitorFailedOrUncertainEventKeys(created.row.id)).toEqual(['old-1', 'old-2'])
    expect(store.getLatestMonitorEvent(created.row.id)).toMatchObject({ monitorEventKey: 'old-2', monitorProposedCheckpoint: 'cp-2', state: 'uncertain' })
    store.close()
  })

  it('serializes fresh claims across two independent SQLite connections', () => {
    const path = tempPath()
    const first = new AssistantStore(path)
    const created = first.createAgentCommitment({ title: 'race', kind: 'monitor', monitorDirection: 'watch-current', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const active = first.markAgentActive(created.row.id, created.row.revision)
    if (!active.ok) throw new Error('activate failed')
    const needed = first.replaceMonitorDirection(created.row.id, active.row.revision, 'watch-current', NOW)
    if (!needed.ok) throw new Error('needed transition failed')
    const second = new AssistantStore(path)
    const oneView = first.getById(created.row.id)!
    const twoView = second.getById(created.row.id)!
    expect(twoView.revision).toBe(oneView.revision)
    const one = first.claimFreshMonitor(created.row.id, oneView.revision, 'claim-one', NOW)
    const two = second.claimFreshMonitor(created.row.id, twoView.revision, 'claim-two', NOW)
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1)
    expect(first.getById(created.row.id)).toMatchObject({ monitorResumeState: 'claimed', monitorClaimToken: one.ok ? 'claim-one' : 'claim-two' })
    first.close()
    second.close()
  })

  it('normalizes monitor restart states without unblocking failures or crossing an event-delivery gate', () => {
    const store = new AssistantStore(tempPath())
    const blocked = store.createAgentCommitment({ title: 'blocked', kind: 'monitor', monitorDirection: 'blocked-direction', sourceSurface: 'telegram', now: NOW })
    if (!blocked.ok) throw new Error('blocked seed failed')
    const blockedIdentity = store.saveWorkerIdentity(blocked.row.id, blocked.row.revision, { workerSessionId: 'blocked-child', workerRunId: 'blocked-run', workerParentSessionId: 'root' })
    if (!blockedIdentity.ok) throw new Error('blocked identity failed')
    const blockedActive = store.markAgentActive(blocked.row.id, blockedIdentity.row.revision)
    if (!blockedActive.ok) throw new Error('blocked activate failed')
    const blockedEnd = store.settleWorkerEnd(blocked.row.id, blockedActive.row.revision, { status: 'blocked', result: 'bad', blockedReason: 'bad', completedAt: NOW, workerRunId: 'blocked-run', outboxId: 'blocked-end', outboxText: 'blocked' })
    if (!blockedEnd.ok) throw new Error('blocked end failed')

    const parked = store.createAgentCommitment({ title: 'parked', kind: 'monitor', monitorDirection: 'parked-direction', sourceSurface: 'telegram', now: NOW })
    if (!parked.ok) throw new Error('parked seed failed')
    const parkedIdentity = store.saveWorkerIdentity(parked.row.id, parked.row.revision, { workerSessionId: 'parked-child', workerRunId: 'parked-run', workerParentSessionId: 'root' })
    if (!parkedIdentity.ok) throw new Error('parked identity failed')

    const fresh = store.createAgentCommitment({ title: 'fresh', kind: 'monitor', monitorDirection: 'fresh-direction', sourceSurface: 'telegram', now: NOW })
    if (!fresh.ok) throw new Error('fresh seed failed')

    const pendingEvent = store.createAgentCommitment({ title: 'event gate', kind: 'monitor', monitorDirection: 'event-direction', sourceSurface: 'telegram', now: NOW })
    if (!pendingEvent.ok) throw new Error('event seed failed')
    const eventIdentity = store.saveWorkerIdentity(pendingEvent.row.id, pendingEvent.row.revision, { workerSessionId: 'event-child', workerRunId: 'event-run', workerParentSessionId: 'root' })
    if (!eventIdentity.ok) throw new Error('event identity failed')
    const eventActive = store.markAgentActive(pendingEvent.row.id, eventIdentity.row.revision)
    if (!eventActive.ok) throw new Error('event activate failed')
    const event = store.settleMonitorEvent({ commitmentId: pendingEvent.row.id, expectedRevision: eventActive.row.revision, workerSessionId: 'event-child', workerRunId: 'event-run', workerParentSessionId: 'root', monitorResumeEpoch: eventActive.row.monitorResumeEpoch, eventKey: 'event-gate', checkpoint: 'cp', summary: 'event', outboxText: 'event', now: NOW })
    if (!event.ok) throw new Error('event settle failed')

    const pausing = store.createAgentCommitment({ title: 'pause restart', kind: 'monitor', monitorDirection: 'pause-direction', sourceSurface: 'telegram', now: NOW })
    if (!pausing.ok) throw new Error('pause seed failed')
    const pauseIdentity = store.saveWorkerIdentity(pausing.row.id, pausing.row.revision, { workerSessionId: 'pause-child', workerRunId: 'pause-run', workerParentSessionId: 'root' })
    if (!pauseIdentity.ok) throw new Error('pause identity failed')
    const pauseActive = store.markAgentActive(pausing.row.id, pauseIdentity.row.revision)
    if (!pauseActive.ok) throw new Error('pause activate failed')
    const pause = store.pauseAgent(pausing.row.id, pauseActive.row.revision)
    if (!pause.ok) throw new Error('pause failed')

    store.normalizeAgentOnStartup()
    expect(store.getById(blocked.row.id)).toMatchObject({ status: 'blocked', monitorResumeState: 'none', monitorDesiredState: 'running', workerSessionId: null })
    expect(store.getById(parked.row.id)).toMatchObject({ status: 'paused', monitorDesiredState: 'running', monitorResumeState: 'needed', workerSessionId: 'parked-child' })
    expect(store.getById(fresh.row.id)).toMatchObject({ status: 'active', monitorDesiredState: 'running', monitorResumeState: 'needed', workerSessionId: null })
    expect(store.getById(pendingEvent.row.id)).toMatchObject({ status: 'active', monitorDesiredState: 'running', monitorResumeState: 'none', workerSessionId: null })
    expect(store.getById(pausing.row.id)).toMatchObject({ status: 'paused', monitorDesiredState: 'paused', monitorResumeState: 'none', workerSessionId: null, workerControlState: 'none' })
    store.close()
  })
})
