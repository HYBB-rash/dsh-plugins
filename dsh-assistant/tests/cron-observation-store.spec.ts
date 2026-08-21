/**
 * Lane C / B: red tests for independent cron-run observations.
 *
 * A cron run is a fact about the manager-owned binding.  It must not be
 * smuggled through commitment progress, the ordinary delivery columns, or an
 * assistant result outbox row.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
const NOW = '2026-08-18T01:00:00.000Z'

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-observation-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function loadStore(): Promise<Record<string, unknown>> {
  return await import('../src/store.ts') as unknown as Record<string, unknown>
}

type StoreWithCron = {
  createAgentCommitment(input: Record<string, unknown>): { readonly ok: boolean; readonly row?: { readonly id: string; readonly revision: number } }
  createCronBinding(input: Record<string, unknown>): { readonly ok: boolean; readonly row?: Record<string, unknown> }
  updateCronMonitorDirection(input: Record<string, unknown>): { readonly ok: boolean; readonly row?: Record<string, unknown> }
  listCronReconciliationIntents(limit?: number): readonly Record<string, unknown>[]
  observeCronRunFinished(input: Record<string, unknown>): { readonly ok: boolean; readonly row?: Record<string, unknown>; readonly duplicate?: boolean; readonly advanced?: boolean }
  getCronBinding(commitmentId: string): Record<string, unknown> | undefined
  getCronBindingByJobId(jobId: string): Record<string, unknown> | undefined
  getById(id: string): Record<string, unknown> | undefined
  close(): void
}

const BINDING_INPUT = {
  commitmentId: 'commitment-placeholder',
  externalRef: 'assistant:monitor-observation',
  desiredScheduleJson: '{"kind":"interval","minutes":5}',
  desiredCwd: '/tmp/cron-observation',
  desiredState: 'running',
  boundJobId: 'job-1',
  createdAt: NOW,
  updatedAt: NOW,
}

function longSummary(): string {
  return `new event ${'x'.repeat(2_000)}`
}

function outboxRows(path: string, commitmentId: string): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(path)
  const rows = db.prepare('SELECT * FROM outbox WHERE commitment_id = ? ORDER BY id').all(commitmentId) as Record<string, unknown>[]
  db.close()
  return rows
}

describe('assistant cron run observation store (first red)', () => {
  it('exposes an assistant-owned binding and run-finished transaction instead of reusing progress/outbox fields', async () => {
    const storeModule = await loadStore()
    const AssistantStore = storeModule.AssistantStore as new (path: string) => StoreWithCron
    expect(typeof (AssistantStore.prototype as unknown as Record<string, unknown>).createCronBinding, 'cron binding store method is missing').toBe('function')
    expect(typeof (AssistantStore.prototype as unknown as Record<string, unknown>).observeCronRunFinished, 'run-finished observation store method is missing').toBe('function')
    expect(typeof (AssistantStore.prototype as unknown as Record<string, unknown>).getCronBinding, 'cron binding query method is missing').toBe('function')
    expect(typeof (AssistantStore.prototype as unknown as Record<string, unknown>).getCronBindingByJobId, 'jobId -> binding lookup method is missing').toBe('function')
    expect(typeof (AssistantStore.prototype as unknown as Record<string, unknown>).updateCronMonitorDirection, 'authoritative monitor direction store method is missing').toBe('function')
  })

  it('keeps success+silent orthogonal, deduplicates a run, ignores older observations, and bounds its summary', async () => {
    const storeModule = await loadStore()
    const AssistantStore = storeModule.AssistantStore as new (path: string) => StoreWithCron
    const prototype = AssistantStore.prototype as unknown as Record<string, unknown>
    expect(typeof prototype.createCronBinding, 'cron binding store method is missing').toBe('function')
    expect(typeof prototype.observeCronRunFinished, 'run-finished observation store method is missing').toBe('function')
    expect(typeof prototype.getCronBindingByJobId, 'jobId -> binding lookup method is missing').toBe('function')
    if (typeof prototype.createCronBinding !== 'function' || typeof prototype.observeCronRunFinished !== 'function' || typeof prototype.getCronBindingByJobId !== 'function') return

    const path = tempPath()
    const store = new AssistantStore(path)
    const monitor = store.createAgentCommitment({
      title: 'cron-bound observation', kind: 'monitor', monitorDirection: '只观察变化',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok || monitor.row === undefined) throw new Error('monitor fixture seed failed')
    const binding = { ...BINDING_INPUT, commitmentId: monitor.row.id }
    const create = store.createCronBinding(binding)
    expect(create.ok).toBe(true)
    expect(store.getCronBinding(monitor.row.id)).not.toHaveProperty('desiredPrompt')
    expect(store.getCronBindingByJobId('job-1')).toMatchObject({ commitmentId: monitor.row.id, boundJobId: 'job-1' })
    const beforeCommitment = JSON.stringify(store.getById(monitor.row.id))
    const beforeOutbox = JSON.stringify(outboxRows(path, monitor.row.id))

    const first = store.observeCronRunFinished({
      commitmentId: monitor.row.id,
      externalRef: binding.externalRef,
      runId: 'run-1', jobId: 'job-1', scheduledFor: '2026-08-18T00:55:00.000Z',
      finishedAt: '2026-08-18T00:55:02.000Z', runStatus: 'success',
      summary: longSummary(), deliveryState: 'silent', now: NOW,
    })
    expect(first.ok).toBe(true)
    const afterFirst = store.getCronBinding(monitor.row.id)
    expect(afterFirst).toMatchObject({ runStatus: 'success', deliveryState: 'silent' })
    expect(String(afterFirst?.lastRunSummary ?? '').length).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(store.getById(monitor.row.id))).toBe(beforeCommitment)
    expect(JSON.stringify(outboxRows(path, monitor.row.id))).toBe(beforeOutbox)

    const duplicate = store.observeCronRunFinished({
      commitmentId: monitor.row.id, externalRef: binding.externalRef,
      runId: 'run-1', jobId: 'job-1', scheduledFor: '2026-08-18T00:55:00.000Z',
      finishedAt: '2026-08-18T00:55:02.000Z', runStatus: 'success',
      summary: 'duplicate must not overwrite', deliveryState: 'silent', now: NOW,
    })
    expect(duplicate.ok).toBe(true)
    expect(duplicate.duplicate).toBe(true)
    expect(store.getCronBinding(monitor.row.id)).toEqual(afterFirst)

    const older = store.observeCronRunFinished({
      commitmentId: monitor.row.id, externalRef: binding.externalRef,
      runId: 'run-older', jobId: 'job-1', scheduledFor: '2026-08-18T00:45:00.000Z',
      finishedAt: '2026-08-18T00:45:01.000Z', runStatus: 'error',
      summary: 'older observation must not regress', error: 'old', deliveryState: 'failed', now: NOW,
    })
    expect(older.ok).toBe(true)
    expect(older.advanced).toBe(false)
    expect(store.getCronBinding(monitor.row.id)).toEqual(afterFirst)
    expect(JSON.stringify(store.getById(monitor.row.id))).toBe(beforeCommitment)
    expect(JSON.stringify(outboxRows(path, monitor.row.id))).toBe(beforeOutbox)
    store.close()
  })

  it('keeps monitor direction authoritative on the commitment and does not write a binding prompt snapshot', async () => {
    const storeModule = await loadStore()
    const AssistantStore = storeModule.AssistantStore as new (path: string) => StoreWithCron
    const path = tempPath()
    const store = new AssistantStore(path)
    const monitor = store.createAgentCommitment({
      title: 'authoritative direction', kind: 'monitor', monitorDirection: '初始完整方向',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok || monitor.row === undefined) throw new Error('monitor fixture seed failed')
    expect(store.createCronBinding({ ...BINDING_INPUT, commitmentId: monitor.row.id }).ok).toBe(true)

    const changed = store.updateCronMonitorDirection({
      commitmentId: monitor.row.id,
      expectedRevision: monitor.row.revision,
      direction: '更新后的完整方向',
      now: NOW,
    })
    expect(changed).toMatchObject({ ok: true })
    expect(store.getById(monitor.row.id)).toMatchObject({ monitorDirection: '更新后的完整方向' })
    expect(store.getCronBinding(monitor.row.id)).not.toHaveProperty('desiredPrompt')

    const db = new DatabaseSync(path)
    const columns = (db.prepare("SELECT name FROM pragma_table_info('assistant_cron_bindings') ORDER BY cid").all() as Array<{ name: string }>)
      .map(row => row.name)
    expect(columns).not.toContain('desired_prompt')
    db.close()
    store.close()
  })

  it('reads a joined reconciliation intent with the updated commitment direction and no prompt snapshot', async () => {
    const storeModule = await loadStore()
    const AssistantStore = storeModule.AssistantStore as new (path: string) => StoreWithCron
    const prototype = AssistantStore.prototype as unknown as Record<string, unknown>
    expect(typeof prototype.listCronReconciliationIntents, 'joined Cron reconciliation intent query is missing').toBe('function')
    if (typeof prototype.listCronReconciliationIntents !== 'function') return

    const path = tempPath()
    const store = new AssistantStore(path)
    const monitor = store.createAgentCommitment({
      title: 'joined reconciliation intent', kind: 'monitor', monitorDirection: '初始 monitor direction',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok || monitor.row === undefined) throw new Error('monitor fixture seed failed')
    expect(store.createCronBinding({ ...BINDING_INPUT, commitmentId: monitor.row.id }).ok).toBe(true)

    const changed = store.updateCronMonitorDirection({
      commitmentId: monitor.row.id,
      expectedRevision: monitor.row.revision,
      direction: '更新后的 monitor direction',
      now: NOW,
    })
    expect(changed).toMatchObject({ ok: true })
    const rows = store.listCronReconciliationIntents(100)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      commitmentId: monitor.row.id,
      externalRef: BINDING_INPUT.externalRef,
      desiredScheduleJson: BINDING_INPUT.desiredScheduleJson,
      desiredCwd: BINDING_INPUT.desiredCwd,
      desiredState: BINDING_INPUT.desiredState,
      boundJobId: BINDING_INPUT.boundJobId,
      controlError: null,
      commitmentStatus: 'pending',
      monitorDirection: '更新后的 monitor direction',
    })
    expect(rows[0]).not.toHaveProperty('prompt')
    expect(rows[0]).not.toHaveProperty('desiredPrompt')
    store.close()
  })
})
