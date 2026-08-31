import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ASSISTANT_APPLICATION_ID,
  ASSISTANT_SCHEMA_VERSION,
  AssistantStore,
} from '../src/store.ts'

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

describe('current schema v4', () => {
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

  it('rejects an old schema without mutating it', () => {
    const path = tempPath()
    const old = new DatabaseSync(path)
    old.exec(`
      PRAGMA application_id = ${ASSISTANT_APPLICATION_ID};
      PRAGMA user_version = 3;
      CREATE TABLE legacy_marker (value TEXT PRIMARY KEY) STRICT;
      INSERT INTO legacy_marker VALUES ('unchanged');
    `)
    old.close()

    expect(() => new AssistantStore(path)).toThrow(/unsupported schema version 3.*accepts only schema 4/i)

    const after = new DatabaseSync(path, { readOnly: true })
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect((after.prepare('PRAGMA application_id').get() as { application_id: number }).application_id).toBe(ASSISTANT_APPLICATION_ID)
    expect(after.prepare('SELECT value FROM legacy_marker').get()).toMatchObject({ value: 'unchanged' })
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
