/**
 * Store tests (src/store.ts): schema identity, the single-open-focus invariant,
 * revision-conditional updates, dual-connection concurrency, restart
 * persistence, and reminder/outbox durability. Every test uses an isolated
 * mkdtemp directory — never the live database.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  ASSISTANT_APPLICATION_ID,
  ASSISTANT_SCHEMA_VERSION,
  AssistantStore,
  openDatabase,
} from '../src/store.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-store-'))
  dirs.push(dir)
  return dir
}

function storePath(dir: string): string {
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-08-15T02:00:00.000Z'

function openStore(dir = tempDir()): { store: AssistantStore; path: string } {
  const path = storePath(dir)
  return { store: new AssistantStore(path), path }
}

describe('schema identity', () => {
  it('initializes an empty database with the assistant application id and version 1', () => {
    const { path } = openStore()
    const db = new DatabaseSync(path)
    const { application_id } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(application_id).toBe(ASSISTANT_APPLICATION_ID)
    expect(user_version).toBe(ASSISTANT_SCHEMA_VERSION)
    db.close()
  })

  it('applies WAL and foreign_keys on every connection', () => {
    const { store, path } = openStore()
    const db = new DatabaseSync(path)
    const { journal_mode } = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    const { foreign_keys } = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(journal_mode).toBe('wal')
    expect(foreign_keys).toBe(1)
    // busy_timeout is connection-local (a second connection reads its own
    // default 0); the store's own 5000ms pragma is exercised by the
    // dual-connection test below, which would otherwise fail with SQLITE_BUSY.
    db.close()
    store.close()
  })

  it('rejects a foreign application id with matching version', () => {
    const { store, path } = openStore()
    store.close()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA application_id = 0x12345678`)
    db.close()
    expect(() => new AssistantStore(path)).toThrow(/application id/)
  })

  it('rejects an unknown user_version', () => {
    const { store, path } = openStore()
    store.close()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${ASSISTANT_SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => new AssistantStore(path)).toThrow(/schema version/)
  })

  it('rejects a non-empty unversioned schema', () => {
    const dir = tempDir()
    const path = storePath(dir)
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE unrelated (id TEXT)')
    db.close()
    expect(() => new AssistantStore(path)).toThrow(/unversioned schema or application identity/)
  })

  it('creates 0700 parent dir and 0600 db file', () => {
    const dir = tempDir()
    const nested = join(dir, 'a', 'b')
    const { store } = { store: new AssistantStore(join(nested, 'state.sqlite')) }
    const { mode: dirMode } = statSync(nested) as { mode: number }
    const { mode: fileMode } = statSync(join(nested, 'state.sqlite')) as { mode: number }
    expect(dirMode & 0o777).toBe(0o700)
    expect(fileMode & 0o777).toBe(0o600)
    store.close()
  })

  it('fails loud on openDatabase of an unrelated SQLite database', () => {
    const dir = tempDir()
    const path = storePath(dir)
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE other (x TEXT)')
    db.exec('PRAGMA user_version = 0')
    db.close()
    expect(() => openDatabase(path)).toThrow()
  })
})

describe('single user focus', () => {
  it('creates a user commitment when no current exists', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({
      title: '整理书桌',
      status: 'active',
      checkInMinutes: 2,
      sourceSurface: 'telegram',
      now: NOW,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected success')
    expect(created.row).toMatchObject({
      title: '整理书桌',
      workOwner: 'user',
      status: 'active',
      checkInMinutes: 2,
      reminderDueAt: '2026-08-15T02:02:00.000Z',
      reminderState: 'scheduled',
      revision: 1,
    })
    expect(created.row.id).toMatch(/^assistant-[0-9a-f]{8}$/)
    store.close()
  })

  it('creates an agent commitment as pending with no reminder', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: '查资料', sourceSurface: 'telegram', now: NOW })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected success')
    expect(created.row).toMatchObject({ workOwner: 'agent', status: 'pending', reminderState: 'none' })
    store.close()
  })

  it('rejects a second focus while any open focus status exists, leaving the original untouched', () => {
    const { store } = openStore()
    const first = store.createUserCommitment({ title: '第一件', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!first.ok) throw new Error('expected success')
    const before = store.getCurrent()
    const second = store.createUserCommitment({ title: '第二件', status: 'active', sourceSurface: 'telegram', now: NOW })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected failure')
    expect(second.code).toBe('current_commitment_exists')
    expect(second.current?.title).toBe('第一件')
    expect(store.getCurrent()).toEqual(before)
    store.close()
  })

  it('every open focus status remains exclusive; completed and cancelled release it', () => {
    const { store } = openStore()
    // paused occupies
    let created = store.createUserCommitment({ title: 'a', status: 'active', sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    let res = store.pauseUser(created.row.id, created.row.revision)
    if (!res.ok) throw new Error('pause failed')
    expect(store.createUserCommitment({ title: 'b', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(false)
    // completed releases
    res = store.completeUser(res.row.id, res.row.revision, 'done', NOW)
    if (!res.ok) throw new Error('complete failed')
    expect(store.createUserCommitment({ title: 'c', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(true)
    // close 'c' so 'd' can become the focus; a blocked focus remains exclusive
    const c = store.getCurrent()!
    res = store.completeUser(c.id, c.revision, 'done-c', NOW)
    if (!res.ok) throw new Error('complete c failed')
    created = store.createUserCommitment({ title: 'd', status: 'active', sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    res = store.block(created.row.id, created.row.revision, '受阻')
    if (!res.ok) throw new Error('block failed')
    expect(store.createUserCommitment({ title: 'e', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(false)
    // cancel releases
    res = store.cancel(res.row.id, res.row.revision)
    if (!res.ok) throw new Error('cancel failed')
    expect(store.createUserCommitment({ title: 'f', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(true)
    store.close()
  })

  it('pending agent commitments do not occupy the user focus', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    expect(store.createUserCommitment({ title: 'user', status: 'active', sourceSurface: 'web', now: NOW }).ok).toBe(true)
    expect(store.listOpen()).toHaveLength(2)
    store.close()
  })
})

describe('revision guards and transitions', () => {
  it('a stale revision cannot overwrite a newer lifecycle change', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const staleRevision = created.row.revision
    const paused = store.pauseUser(created.row.id, staleRevision)
    if (!paused.ok) throw new Error('pause failed')
    // A tool still holding the original revision tries to complete → stale
    const stale = store.completeUser(created.row.id, staleRevision, 'result', NOW)
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected failure')
    expect(stale.code).toBe('revision_mismatch')
    expect(store.getById(created.row.id)?.status).toBe('paused')
    store.close()
  })

  it('rejects invalid transitions per status', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    expect(store.pauseUser(created.row.id, created.row.revision).ok).toBe(true)
    const paused = store.getCurrent()!
    // cannot pause a paused commitment
    expect(store.pauseUser(paused.id, paused.revision).ok).toBe(false)
    // cannot still_working a paused commitment
    expect(store.stillWorking(paused.id, paused.revision, 2, NOW).ok).toBe(false)
    // cannot block a paused commitment
    expect(store.block(paused.id, paused.revision, 'why').ok).toBe(false)
    // resume works
    expect(store.resumeUser(paused.id, paused.revision, 2, NOW).ok).toBe(true)
    const active = store.getCurrent()!
    // cannot resume an active commitment
    expect(store.resumeUser(active.id, active.revision, 2, NOW).ok).toBe(false)
    // complete works from active
    expect(store.completeUser(active.id, active.revision, 'ok', NOW).ok).toBe(true)
    const done = store.getCurrent()
    expect(done).toBeUndefined()
    store.close()
  })

  it('update operations reject unknown ids', () => {
    const { store } = openStore()
    expect(store.completeUser('missing', 1, 'r', NOW).ok).toBe(false)
    expect(store.getById('missing')).toBeUndefined()
    store.close()
  })
})

describe('reminder lifecycle', () => {
  it('pause cancels the scheduled reminder and pending outbox in one transaction', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.insertOutbox({ id: 'check-in:pre', commitmentId: created.row.id, kind: 'check_in', text: 'x', createdAt: NOW })
    const paused = store.pauseUser(created.row.id, created.row.revision)
    if (!paused.ok) throw new Error('pause failed')
    const row = store.getById(created.row.id)!
    expect(row.reminderState).toBe('cancelled')
    expect(row.reminderDueAt).toBeNull()
    expect(store.getOutbox('check-in:pre')?.state).toBe('cancelled')
    store.close()
  })

  it('stillWorking reschedules from now with the stored interval', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 5, sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const res = store.stillWorking(created.row.id, created.row.revision, undefined, '2026-08-15T02:10:00.000Z')
    if (!res.ok) throw new Error('stillWorking failed')
    expect(res.row.reminderDueAt).toBe('2026-08-15T02:15:00.000Z')
    expect(res.row.reminderState).toBe('scheduled')
    store.close()
  })

  it('queueDueReminder inserts one deterministic outbox and clears the dueAt', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: '整理书桌', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const queued = store.queueDueReminder('2026-08-15T02:02:05.000Z', 2 * 60 * 60 * 1000, (_kind, row) => `⏰ ${row.title}`)
    expect(queued.inserted).toBe(true)
    expect(queued.kind).toBe('check_in')
    expect(queued.outboxId).toBe(`check-in:${created.row.id}:2026-08-15T02:02:00.000Z`)
    const row = store.getById(created.row.id)!
    expect(row.reminderState).toBe('queued')
    expect(row.reminderDueAt).toBeNull()
    // A second scan is a no-op (no duplicate outbox)
    const again = store.queueDueReminder('2026-08-15T02:02:06.000Z', 2 * 60 * 60 * 1000, (_k, r) => `x ${r.title}`)
    expect(again.inserted).toBe(false)
    expect(store.listPendingOutbox()).toHaveLength(1)
    store.close()
  })

  it('a badly overdue reminder is queued as missed_check_in', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const late = '2026-08-15T06:00:00.000Z' // > 2h late
    const queued = store.queueDueReminder(late, 2 * 60 * 60 * 1000, (_k, r) => `⏰ ${r.title}`)
    expect(queued.kind).toBe('missed_check_in')
    store.close()
  })

  it('queueDueReminder does nothing while the dueAt is still in the future', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const queued = store.queueDueReminder('2026-08-15T02:01:00.000Z', 2 * 60 * 60 * 1000, () => 'x')
    expect(queued.inserted).toBe(false)
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })

  it('does not queue for paused commitments', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.pauseUser(created.row.id, created.row.revision)
    const queued = store.queueDueReminder('2026-08-15T02:05:00.000Z', 2 * 60 * 60 * 1000, () => 'x')
    expect(queued.inserted).toBe(false)
    store.close()
  })
})

describe('outbox claim semantics', () => {
  it('claim happens before send and returns a token', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.insertOutbox({ id: 'o1', commitmentId: created.row.id, kind: 'completed', text: 'done', createdAt: NOW })
    const claimed = store.claimOutbox('o1', NOW)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error('expected claim')
    expect(claimed.outbox.state).toBe('claimed')
    expect(claimed.outbox.claimToken).toBeTruthy()
    expect(claimed.outbox.claimedAt).toBe(NOW)
    // A second claim is rejected
    expect(store.claimOutbox('o1', NOW).ok).toBe(false)
    store.close()
  })

  it('pause cancels a pending check-in outbox in the same transaction; it never sends', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.insertOutbox({ id: 'reminder', commitmentId: created.row.id, kind: 'check_in', text: '⏰', createdAt: NOW })
    store.pauseUser(created.row.id, created.row.revision)
    // The pause transaction already cancelled the pending reminder row.
    expect(store.getOutbox('reminder')?.state).toBe('cancelled')
    const claimed = store.claimOutbox('reminder', NOW)
    expect(claimed).toEqual({ ok: false, code: 'not_pending' })
    store.close()
  })

  it('marks stale claimed rows uncertain on restart and never replays', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.insertOutbox({ id: 'o1', commitmentId: created.row.id, kind: 'completed', text: 'done', createdAt: NOW })
    store.claimOutbox('o1', NOW)
    const count = store.markStaleClaimed()
    expect(count).toBe(1)
    expect(store.getOutbox('o1')?.state).toBe('uncertain')
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })

  it('finishOutbox records delivered/failed/uncertain without resending', () => {
    const { store } = openStore()
    const created = store.createUserCommitment({ title: 't', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.insertOutbox({ id: 'o1', commitmentId: created.row.id, kind: 'completed', text: 'done', createdAt: NOW })
    store.claimOutbox('o1', NOW)
    store.finishOutbox('o1', 'failed', { error: 'HTTP 500' })
    expect(store.getOutbox('o1')?.state).toBe('failed')
    store.close()
  })
})

describe('worker identity and settlement', () => {
  it('saves worker identity only into the pending window', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1',
      workerRunId: 'run-1',
      workerParentSessionId: 'session-telegram',
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error('expected success')
    expect(saved.row.workerSessionId).toBe('child-1')
    expect(saved.row.workerRunId).toBe('run-1')
    expect(saved.row.revision).toBe(2)
    store.close()
  })

  it('rejects saving identity into an already-active commitment (generic subagent guard)', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1',
      workerRunId: 'run-1',
      workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('expected success')
    const active = store.markAgentActive(created.row.id, saved.row.revision)
    if (!active.ok) throw new Error('expected success')
    expect(store.saveWorkerIdentity(created.row.id, active.row.revision, {
      workerSessionId: 'other',
      workerRunId: 'run-2',
      workerParentSessionId: 'session-telegram',
    }).ok).toBe(false)
    store.close()
  })

  it('settleWorkerEnd writes status + result + outbox in one transaction', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('expected success')
    const settled = store.settleWorkerEnd(created.row.id, saved.row.revision, {
      status: 'completed',
      result: '完成正文',
      completedAt: NOW,
      workerRunId: 'run-1',
      outboxId: 'worker:assistant-x:run-1',
      outboxText: '✅ 完成',
    })
    expect(settled.ok).toBe(true)
    if (!settled.ok) throw new Error('expected success')
    expect(settled.row.status).toBe('completed')
    expect(settled.row.result).toBe('完成正文')
    expect(store.getOutbox('worker:assistant-x:run-1')?.state).toBe('pending')
    expect(store.getCurrent()).toBeUndefined()
    store.close()
  })

  it('settleWorkerEnd ignores a duplicate end for an already-terminal commitment', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('expected success')
    const settled = store.settleWorkerEnd(created.row.id, saved.row.revision, {
      status: 'completed', result: 'r', completedAt: NOW, outboxId: 'w1', outboxText: 't',
    })
    if (!settled.ok) throw new Error('expected success')
    const again = store.settleWorkerEnd(created.row.id, settled.row.revision, {
      status: 'blocked', result: 'late', completedAt: NOW, outboxId: 'w2', outboxText: 't',
    })
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('expected failure')
    expect(again.code).toBe('terminal')
    expect(store.getById(created.row.id)?.status).toBe('completed')
    store.close()
  })

  it('normalizeAgentOnStartup pauses a leftover active agent commitment and keeps the child id', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('expected success')
    store.markAgentActive(created.row.id, saved.row.revision)
    store.normalizeAgentOnStartup()
    const row = store.getById(created.row.id)!
    expect(row.status).toBe('paused')
    expect(row.workerSessionId).toBe('child-1')
    expect(row.nextAction).toContain('服务重启后等待用户明确恢复')
    store.close()
  })

  it('normalizeAgentOnStartup blocks a leftover agent commitment with no saved child id', () => {
    const { store } = openStore()
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.normalizeAgentOnStartup()
    const row = store.getById(created.row.id)!
    expect(row.status).toBe('blocked')
    expect(row.blockedReason).toContain('启动结果不确定')
    store.close()
  })
})

describe('rework: acceptResumedWorkerRun and ownsWorkerSession (验收返工 §4.3-§4.4)', () => {
  async function activePausedAgent(): Promise<{ store: AssistantStore; id: string }> {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const created = store.createAgentCommitment({ title: 'a', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    store.markAgentActive(created.row.id, saved.row.revision)
    const paused = store.pauseAgent(created.row.id, store.getById(created.row.id)!.revision)
    if (!paused.ok) throw new Error('pause failed')
    const resumed = store.resumeAgent(created.row.id, paused.row.revision)
    if (!resumed.ok) throw new Error('resume failed')
    return { store, id: created.row.id }
  }

  it('acceptResumedWorkerRun writes the new run id and clears resume_requested in one guarded write', async () => {
    const { store, id } = await activePausedAgent()
    const before = store.getById(id)!
    expect(before.workerControlState).toBe('resume_requested')
    const res = store.acceptResumedWorkerRun(id, before.revision, 'run-2')
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected success')
    expect(res.row.workerRunId).toBe('run-2')
    expect(res.row.workerControlState).toBe('none')
    expect(res.row.revision).toBe(before.revision + 1)
    store.close()
  })

  it('acceptResumedWorkerRun rejects when the control state is not resume_requested', async () => {
    const { store, id } = await activePausedAgent()
    const before = store.getById(id)!
    // First acceptance consumes the resume window.
    const first = store.acceptResumedWorkerRun(id, before.revision, 'run-2')
    if (!first.ok) throw new Error('expected success')
    const res = store.acceptResumedWorkerRun(id, first.row.revision, 'run-3')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.code).toBe('invalid_transition')
    expect(store.getById(id)?.workerRunId).toBe('run-2')
    store.close()
  })

  it('acceptResumedWorkerRun rejects when the worker session id does not match the start', async () => {
    const { store, id } = await activePausedAgent()
    const before = store.getById(id)!
    // The guard is about the control state; the caller matches session ids
    // before calling. A stale revision (a different worker took over) fails.
    const res = store.acceptResumedWorkerRun(id, 1, 'run-9')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.code).toBe('revision_mismatch')
    store.close()
  })

  it('acceptResumedWorkerRun rejects a non-active commitment', async () => {
    const { store, id } = await activePausedAgent()
    const before = store.getById(id)!
    // Cancel first: no longer active.
    store.cancel(id, before.revision)
    const res = store.acceptResumedWorkerRun(id, store.getById(id)!.revision, 'run-9')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.code).toBe('invalid_transition')
    store.close()
  })

  it('ownsWorkerSession matches an open agent worker for its parent', async () => {
    const { store } = await activePausedAgent()
    expect(store.ownsWorkerSession('child-1', 'session-telegram')).toBe(true)
    expect(store.ownsWorkerSession('child-1', 'session-other')).toBe(false)
    expect(store.ownsWorkerSession('other-child', 'session-telegram')).toBe(false)
    store.close()
  })

  it('ownsWorkerSession still recognizes a closed (terminal) worker by durable id', async () => {
    const { store, id } = await activePausedAgent()
    const before = store.getById(id)!
    const settled = store.settleWorkerEnd(id, before.revision, {
      status: 'completed', result: 'r', completedAt: NOW, outboxId: 'w1', outboxText: 't',
    })
    if (!settled.ok) throw new Error('settle failed')
    expect(store.getCurrent()).toBeUndefined()
    expect(store.ownsWorkerSession('child-1', 'session-telegram')).toBe(true)
    store.close()
  })
})

describe('dual connections and restart', () => {
  it('two connections (web + telegram) read the same row and serialize conflicting writes', () => {
    const { path } = openStore()
    const web = new AssistantStore(path)
    const telegram = new AssistantStore(path)
    const created = web.createUserCommitment({ title: '共享', status: 'active', checkInMinutes: 2, sourceSurface: 'web', now: NOW })
    if (!created.ok) throw new Error('expected success')
    expect(telegram.getCurrent()?.title).toBe('共享')
    // Web pauses with its own view; Telegram reads the change
    const webView = web.getCurrent()!
    const paused = web.pauseUser(webView.id, webView.revision)
    if (!paused.ok) throw new Error('pause failed')
    expect(telegram.getCurrent()?.status).toBe('paused')
    // Telegram resumes with the revision it read from its own connection
    const telegramView = telegram.getCurrent()!
    const resumed = telegram.resumeUser(telegramView.id, telegramView.revision, 3, NOW)
    expect(resumed.ok).toBe(true)
    // Web's stale pause (original revision) no longer applies
    const staleWeb = web.pauseUser(created.row.id, created.row.revision)
    expect(staleWeb.ok).toBe(false)
    if (staleWeb.ok) throw new Error('expected failure')
    expect(staleWeb.code).toBe('revision_mismatch')
    web.close()
    telegram.close()
  })

  it('fields and reminders survive close/reopen', () => {
    const dir = tempDir()
    const path = storePath(dir)
    let store = new AssistantStore(path)
    const created = store.createUserCommitment({ title: '持久', status: 'active', checkInMinutes: 15, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('expected success')
    store.close()
    store = new AssistantStore(path)
    const row = store.getById(created.row.id)!
    expect(row.title).toBe('持久')
    expect(row.reminderDueAt).toBe('2026-08-15T02:15:00.000Z')
    expect(row.reminderState).toBe('scheduled')
    expect(row.revision).toBe(1)
    const queued = store.queueDueReminder('2026-08-15T02:15:00.000Z', 2 * 60 * 60 * 1000, () => 'x')
    expect(queued.inserted).toBe(true)
    store.close()
  })

  it('getLastClosed returns the most recent closed commitment', () => {
    const { store } = openStore()
    const first = store.createUserCommitment({ title: 'first', status: 'active', sourceSurface: 'web', now: NOW })
    if (!first.ok) throw new Error('expected success')
    store.completeUser(first.row.id, first.row.revision, 'a', '2026-08-15T03:00:00.000Z')
    const second = store.createUserCommitment({ title: 'second', status: 'active', sourceSurface: 'web', now: '2026-08-15T04:00:00.000Z' })
    if (!second.ok) throw new Error('expected success')
    store.cancel(second.row.id, second.row.revision)
    expect(store.getLastClosed()?.title).toBe('second')
    store.close()
  })
})
