import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantStore } from '../src/store.ts'

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

describe('current monitor storage', () => {
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
